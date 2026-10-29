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
function createSchema() {
  SCHEMA.forEach((sql) => {
    try {
      db.exec(sql);
    } catch (e) {
      console.warn('[db] 建表跳过：', String(sql).slice(0, 60), '→', e.message);
    }
  });
}

/**
 * 补列迁移：旧库文件升级用。新库由 schema.js 一次建全，这里全部空转。
 */
function migrate() {
  const add = (table, col, ddl) => {
    const c = cols(table);
    if (c.length && !c.includes(col)) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); } catch (e) { /* ignore */ }
    }
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
    try {
      db.exec('DROP INDEX IF EXISTS uq_issue_item');
      db.exec('CREATE UNIQUE INDEX uq_issue_item ON material_issue_items(issue_id, material_id, name, item_id, colorway)');
    } catch (e) { /* 老库有重复行时建不上：留给 apply-issuecolor-ddl.js 处理 */ }
  }

  // 往来账原币字段（历史数据按 CNY 处理）
  ['ar_invoices', 'ap_invoices'].forEach((tb) => {
    const c = cols(tb);
    if (!c.length) return;
    if (!c.includes('currency')) db.exec(`ALTER TABLE ${tb} ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY'`);
    if (!c.includes('amount_orig')) {
      db.exec(`ALTER TABLE ${tb} ADD COLUMN amount_orig REAL NOT NULL DEFAULT 0`);
      db.exec(`UPDATE ${tb} SET amount_orig = amount WHERE amount_orig = 0`);
    }
    if (!c.includes('rate')) db.exec(`ALTER TABLE ${tb} ADD COLUMN rate REAL NOT NULL DEFAULT 1`);
  });
  const pc = cols('payments');
  if (pc.length) {
    if (!pc.includes('currency')) db.exec("ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY'");
    if (!pc.includes('amount_orig')) {
      db.exec('ALTER TABLE payments ADD COLUMN amount_orig REAL NOT NULL DEFAULT 0');
      db.exec('UPDATE payments SET amount_orig = amount WHERE amount_orig = 0');
    }
    if (!pc.includes('rate')) db.exec('ALTER TABLE payments ADD COLUMN rate REAL NOT NULL DEFAULT 1');
  }
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

createSchema();
migrate();
seed();

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

module.exports = { db, driver, now, cols, getMindmap, saveMindmap, getSettings, saveSettings };
