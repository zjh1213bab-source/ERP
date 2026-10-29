/**
 * SQLite 数据层（ERP 版）
 * ------------------------------------------------------------
 * - 双驱动兜底：better-sqlite3 优先，失败回退 Node 内置 node:sqlite
 * - 表结构来自 src/schema.js（SQL 快照，由 scripts/rebuild-schema.js 从实际库导出）
 * - 启动时：建表（幂等） → 补列迁移 → 最小播种（汇率 / 管理员）
 *
 * 注意：migrate() 只覆盖「用旧库文件启动」的场景；
 * 全新库直接由 schema.js 建出完整结构，不需要逐条 ALTER。
 */
const fs = require('fs');
const path = require('path');

const config = require('./config');
const SCHEMA = require('./schema');
const { hashPassword } = require('./auth/password');

// ---------- 选择驱动 ----------
let DatabaseCtor;
let driver;
try {
  const BetterSqlite = require('better-sqlite3');
  // 可选原生模块可能存在但 ABI 与当前 Node 不兼容（例如在 Node 22 安装后用 Node 24 启动）。
  // 只 require 不会触发 ABI 检查，因此先用内存库验证构造成功，再选为实际驱动。
  const probe = new BetterSqlite(':memory:');
  probe.close();
  DatabaseCtor = BetterSqlite;
  driver = 'better-sqlite3';
} catch (e) {
  try {
    DatabaseCtor = require('node:sqlite').DatabaseSync;
    driver = 'node:sqlite';
  } catch (e2) {
    throw new Error('未找到可用 SQLite 驱动：请安装 better-sqlite3 或使用 Node 22.5+');
  }
}

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

/**
 * 待生效的恢复：必须在打开连接之前把文件换掉。
 * 顺序反了就会连到旧库上 —— 表现是「恢复提示成功，重启后数据没变」。
 * backup-restore 模块刻意不依赖本文件，就是为了能在这里先跑。
 */
let restoreApplied = null;
try {
  const BR = require('./services/backup-restore');
  const r = BR.applyPendingRestore({ dbPath: config.dbPath });
  if (r.applied) {
    restoreApplied = r;
    console.log(`[db] 已应用待恢复的备份：${r.checks.tables} 张表 / 关键表 ${r.checks.rows_total} 行`);
    console.log(`[db] 恢复前的旧库已留档：${r.replacedFile}`);
  } else if (r.error) {
    console.error('[db] 恢复未执行，继续使用当前库 —— ' + r.error);
  }
} catch (e) {
  console.error('[db] 处理待恢复文件时异常（继续使用当前库）：', e.message);
}

const db = new DatabaseCtor(config.dbPath);
try {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  /**
   * 写锁等待 5 秒，别一撞就报 database is locked
   *
   * 单进程时用不上；但 PM2 cluster / 多实例共用一个库文件时，
   * 两个进程同时 `BEGIN IMMEDIATE`（比如两个人同时报工），
   * 没这个设置就会立刻抛 SQLITE_BUSY —— 用户看到的是 500「服务器内部错误」。
   * WAL 下写者是串行的，让它排队等一下才是对的。
   */
  db.exec('PRAGMA busy_timeout = 5000;');
} catch (e) {
  /* ignore */
}
console.log(`[db] SQLite 驱动: ${driver}  文件: ${config.dbPath}`);

const now = () => new Date().toISOString();

/** 取某张表的列名，表不存在返回空数组 */
function cols(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch (e) {
    return [];
  }
}

// ---------- 建表 ----------
/**
 * 建表失败**必须让启动停下来**
 *
 * 原先是 `catch { console.warn('建表跳过', ...) }`。后果很隐蔽：
 * 服务照常起来、健康检查返回 200，只有真正点到那张表的功能时才 500 ——
 * 而那时候人已经在用了，日志里也只剩一句几十字截断的 warn。
 *
 * 这里改成：先把所有语句跑一遍（一条坏 DDL 不能掩盖后面的），
 * 收齐失败原因，最后统一报错并终止启动。
 *
 * 顺序也很关键：**表 → 补列 → 索引/视图**。
 * schema.js 里索引和表是混排的，而老库靠 `migrate()` 补的列如果还没补上，
 * 建索引就会报 "no such column"。先跑表再补列再建索引，老库升级才不会误判成结构损坏。
 */
const IS_TABLE = /^\s*CREATE\s+TABLE/i;
const SCHEMA_TABLES = SCHEMA.filter((sql) => IS_TABLE.test(String(sql)));
const SCHEMA_OTHER = SCHEMA.filter((sql) => !IS_TABLE.test(String(sql)));   // 索引 / 视图

const schemaFailures = [];
function runSchema(sqls, kind) {
  sqls.forEach((sql) => {
    try {
      db.exec(sql);
    } catch (e) {
      schemaFailures.push({ kind, sql: String(sql).replace(/\s+/g, ' ').slice(0, 100), msg: e.message });
    }
  });
}

function createTables() {
  runSchema(SCHEMA_TABLES, '建表');
}

function createIndexes() {
  runSchema(SCHEMA_OTHER, '索引/视图');
}

/** 结构问题汇总成一段人能看懂的话；没问题返回 null */
function schemaError() {
  if (!schemaFailures.length) return null;
  const detail = schemaFailures.slice(0, 8)
    .map((f) => `  · [${f.kind}] ${f.sql} … → ${f.msg}`)
    .join('\n');
  const more = schemaFailures.length > 8 ? `\n  …还有 ${schemaFailures.length - 8} 条` : '';
  return `数据库结构不完整（${schemaFailures.length} 条失败），拒绝启动：\n${detail}${more}\n`
    + '  排查方向：库文件是否损坏 / schema.js 与实际库是否脱节（`node scripts/rebuild-schema.js`）/ 老库是否需要先跑 apply-*.js';
}

/**
 * 补列迁移：旧库文件升级用。新库由 schema.js 一次建全，这里全部空转。
 */
function migrate() {
  let added = 0;
  /**
   * 补列：失败也要记下来。
   * 原来一律 `catch { /* ignore *\/ }`，于是「列没加上」和「列已经存在」长得一样，
   * 直到某个查询报 no such column 才发现 —— 而那可能是一周以后。
   */
  const add = (table, col, ddl) => {
    const c = cols(table);
    if (!c.length || c.includes(col)) return;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      added += 1;
    } catch (e) {
      if (/duplicate column/i.test(e.message)) return;
      schemaFailures.push({ kind: '补列', sql: `ALTER TABLE ${table} ADD COLUMN ${col}`, msg: e.message });
    }
  };
  const exec = (label, sql) => {
    try { db.exec(sql); } catch (e) { schemaFailures.push({ kind: '补数据', sql: label, msg: e.message }); }
  };

  // 订单
  add('orders', 'image_url', 'TEXT');
  add('orders', 'currency', "TEXT DEFAULT 'CNY'");
  add('orders', 'rate', 'REAL DEFAULT 6.5');
  add('orders', 'total_usd', 'REAL DEFAULT 0');

  // 档案图片
  ['customers', 'factories', 'employees'].forEach((tb) => add(tb, 'image_url', 'TEXT'));

  // 面辅料档案扩展
  ['short_name', 'color', 'color_no', 'image_url', 'width', 'weight', 'air_gap', 'composition', 'unit', 'supplier_info', 'stock_detail', 'remark']
    .forEach((col) => add('materials', col, 'TEXT'));
  add('materials', 'stock_qty', 'REAL DEFAULT 0');

  // 开发单
  [
    'customer_style_no', 'designer', 'pattern_maker', 'pattern_no', 'category', 'label_name',
    'series', 'wave', 'sales_owner', 'po_no', 'brand', 'colors', 'size_range', 'delivery_date'
  ].forEach((col) => add('tech_packs', col, 'TEXT'));
  add('tech_packs', 'image_url', 'TEXT');

  // 开发单明细
  add('tech_pack_materials', 'material_id', 'INTEGER');
  add('tech_pack_materials', 'use_part', 'TEXT');

  /**
   * 采购单挂主体。
   *
   * 别的域能"顺着订单推主体"，采购推不出来：面辅料采购是给这个厂备货的，
   * 这个库里 32 张采购单一单都没挂销售订单。没有这一列，采购单就没有主体维度 ——
   * 列表一按主体筛，分部采购员新开的单会记到总部、自己又看不见。
   */
  add('purchase_orders', 'company_id', 'INTEGER NOT NULL DEFAULT 1');
  /**
   * 员工档案挂主体。劳动合同签在哪家、社保在哪缴、工资由谁发，是按法人主体分开的；
   * 没有这一列时分部人事能看到总部所有人的底薪，而考勤/请假/计件挂在 employee_id 上
   * 也都推不出主体。
   */
  add('employees', 'company_id', 'INTEGER NOT NULL DEFAULT 1');

  // 领料明细挂到「款 × 颜色」（按色发料；老数据 item_id=0 / colorway='' 按总量核）
  add('material_issue_items', 'item_id', 'INTEGER NOT NULL DEFAULT 0');
  add('material_issue_items', 'colorway', "TEXT NOT NULL DEFAULT ''");
  add('material_issue_items', 'color_no', 'TEXT');
  /**
   * 唯一索引要带上款与颜色，否则「同一原料两个颜色」会被当成重复行拦掉。
   * 每次启动都检查一次索引定义，已经对了就不动（DROP+CREATE 在 4000 行表上没必要天天做）。
   */
  const issueIdx = (() => {
    try {
      return (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_issue_item'").get() || {}).sql || '';
    } catch (e) { return ''; }
  })();
  if (issueIdx && !(issueIdx.includes('item_id') && issueIdx.includes('colorway'))) {
    exec('重建索引 uq_issue_item', 'DROP INDEX IF EXISTS uq_issue_item');
    exec('重建索引 uq_issue_item', 'CREATE UNIQUE INDEX uq_issue_item ON material_issue_items(issue_id, material_id, name, item_id, colorway)');
  }

  // 往来账原币字段（历史数据按 CNY 处理）
  ['ar_invoices', 'ap_invoices'].forEach((tb) => {
    const c = cols(tb);
    if (!c.length) return;
    if (!c.includes('currency')) add(tb, 'currency', "TEXT NOT NULL DEFAULT 'CNY'");
    if (!c.includes('amount_orig')) {
      add(tb, 'amount_orig', 'REAL NOT NULL DEFAULT 0');
      exec(`${tb}.amount_orig 回填`, `UPDATE ${tb} SET amount_orig = amount WHERE amount_orig = 0`);
    }
    if (!c.includes('rate')) add(tb, 'rate', 'REAL NOT NULL DEFAULT 1');
  });
  const pc = cols('payments');
  if (pc.length) {
    if (!pc.includes('currency')) add('payments', 'currency', "TEXT NOT NULL DEFAULT 'CNY'");
    if (!pc.includes('amount_orig')) {
      add('payments', 'amount_orig', 'REAL NOT NULL DEFAULT 0');
      exec('payments.amount_orig 回填', 'UPDATE payments SET amount_orig = amount WHERE amount_orig = 0');
    }
    if (!pc.includes('rate')) add('payments', 'rate', 'REAL NOT NULL DEFAULT 1');
  }
  return added;
}

/** 最小播种：汇率设置 + 管理员账号（已有则跳过） */
function seed() {
  const t = now();
  const hasSettings = db.prepare("SELECT 1 AS x FROM app_config WHERE key = 'settings'").get();
  if (!hasSettings) {
    db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('settings', ?, ?)")
      .run(JSON.stringify({ exchangeRate: config.exchangeRate }), t);
  }
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (!userCount) {
    let companyId = null;
    const comp = db.prepare('SELECT id FROM companies ORDER BY id LIMIT 1').get();
    if (comp) companyId = comp.id;
    else {
      const info = db.prepare('INSERT INTO companies (code, name, created_at) VALUES (?,?,?)')
        .run('C001', '默认公司', t);
      companyId = Number(info.lastInsertRowid);
    }
    // 注意列名是 password_hash（早期写成 password，全新库初始化会直接报错、连管理员都建不出来）
    db.prepare(
      'INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(config.adminUsername, hashPassword(config.adminPassword), '系统管理员', 'admin', companyId, 1, t);
  }
}

/**
 * 启动序列：表 → 补列 → 索引/视图 → 校验 → 播种 → 记台账
 *
 * 校验放在最后、播种之前：结构不对就不要往里写数据。
 */
createTables();
const migratedCols = migrate();
createIndexes();

const bootError = schemaError();
if (bootError) {
  // 这里必须硬失败。服务带着残缺结构起来，比直接起不来危险得多：
  // 健康检查照常 200，人却要到点某个功能时才发现 500。
  console.error('\n[db] ' + bootError + '\n');
  process.exit(1);
}

seed();

/**
 * 结构台账：记下「这个库是用哪份 schema 快照打开的」
 *
 * 版本号取 schema.js 内容的指纹 —— 改表结构必然换指纹，不用人手工维护版本号
 * （手工版本号的下场是：谁忘了 +1，事后就永远说不清这个库是哪一版结构）。
 * 同指纹且没有补列时不重复写，避免每次重启都堆一行。
 */
function schemaStats() {
  const tables = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c;
  const indexes = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get().c;
  return { tables: Number(tables) || 0, indexes: Number(indexes) || 0 };
}

function schemaFingerprint() {
  return require('crypto').createHash('sha256').update(SCHEMA.join('\n')).digest('hex').slice(0, 12);
}

function markSchemaState() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,                  -- schema.js 内容指纹（改结构必变）
    tables INTEGER NOT NULL DEFAULT 0,
    indexes INTEGER NOT NULL DEFAULT 0,
    migrated_cols INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    applied_at TEXT NOT NULL
  )`);
  const st = schemaStats();
  const fp = schemaFingerprint();
  const last = db.prepare('SELECT version FROM schema_migrations ORDER BY id DESC LIMIT 1').get();
  const snapshotChanged = !last || last.version !== fp;
  if (snapshotChanged || migratedCols > 0) {
    db.prepare('INSERT INTO schema_migrations (version, tables, indexes, migrated_cols, note, applied_at) VALUES (?,?,?,?,?,?)')
      .run(fp, st.tables, st.indexes, migratedCols, snapshotChanged ? 'schema 快照变更' : '老库补列', now());
  }
  return { version: fp, ...st, migrated_cols: migratedCols };
}

const schemaState = markSchemaState();
console.log(`[db] 结构版本 ${schemaState.version}（表 ${schemaState.tables} / 索引 ${schemaState.indexes}`
  + `${schemaState.migrated_cols ? ` / 本次补列 ${schemaState.migrated_cols}` : ''}）`);

/** 给 /api/health 与上线自检用：一眼看出跑的是哪份结构 */
function schemaInfo() {
  const last = db.prepare('SELECT * FROM schema_migrations ORDER BY id DESC LIMIT 1').get() || {};
  return {
    version: schemaState.version,
    tables: schemaState.tables,
    indexes: schemaState.indexes,
    last_migration_at: last.applied_at || null,
    last_migration_note: last.note || null
  };
}

/** 把「本次启动应用了恢复」这件事记进 backup_jobs（表可能还不存在，忽略异常） */
function logRestoreApplied(r) {
  if (!r || !r.applied) return;
  try {
    const has = db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='backup_jobs'")
      .get();
    if (!has) return;
    const plan = r.plan || {};
    db.prepare(
      `INSERT INTO backup_jobs
       (job_no, kind, file_name, size_bytes, tables_count, rows_total, key_rows,
        verify_status, verify_at, verify_note, restore_status, restore_at, note, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'RS' + new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14),
      'restore',
      '（由 ' + (plan.source && plan.source.job_no ? plan.source.job_no : '上传文件') + ' 恢复）',
      0,
      (r.checks && r.checks.tables) || 0,
      (r.checks && r.checks.rows_total) || 0,
      JSON.stringify((r.checks && r.checks.key_rows) || {}),
      'ok',
      now(),
      '完整性校验通过，已替换数据库文件',
      'applied',
      now(),
      '重启时应用恢复；恢复前旧库留档：' + (r.replacedFile || ''),
      plan.operator || '',
      now()
    );
  } catch (e) {
    console.warn('[db] 恢复记录写入失败（不影响业务）：', e.message);
  }
}

logRestoreApplied(restoreApplied);

// ---------- 蓝图（原思维导图）配置 ----------
function getMindmap() {
  const row = db.prepare('SELECT value, updated_at FROM app_config WHERE key = ?').get('mindmap');
  if (!row) return null;
  return { data: JSON.parse(row.value), updatedAt: row.updated_at };
}

function saveMindmap(data) {
  const t = now();
  const exists = db.prepare('SELECT 1 AS x FROM app_config WHERE key = ?').get('mindmap');
  if (exists) {
    db.prepare('UPDATE app_config SET value = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(data), t, 'mindmap');
  } else {
    db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run('mindmap', JSON.stringify(data), t);
  }
  return t;
}

/** 系统设置（含汇率） */
function getSettings() {
  const def = { exchangeRate: config.exchangeRate };
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'settings'").get();
  if (!row) return def;
  try {
    return { ...def, ...JSON.parse(row.value) };
  } catch (e) {
    return def;
  }
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...(patch || {}) };
  const t = now();
  const ex = db.prepare("SELECT 1 AS x FROM app_config WHERE key = 'settings'").get();
  if (ex) {
    db.prepare("UPDATE app_config SET value = ?, updated_at = ? WHERE key = 'settings'").run(JSON.stringify(next), t);
  } else {
    db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('settings', ?, ?)").run(JSON.stringify(next), t);
  }
  return next;
}

module.exports = { db, driver, now, cols, getMindmap, saveMindmap, getSettings, saveSettings, schemaInfo };
