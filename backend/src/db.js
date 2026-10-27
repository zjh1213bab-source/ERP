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
  DatabaseCtor = require('better-sqlite3');
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
    db.prepare(
      'INSERT INTO users (username, password, name, role, company_id, status, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(config.adminUsername, hashPassword(config.adminPassword), '系统管理员', 'admin', companyId, 'active', t);
  }
}

createSchema();
migrate();
seed();

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
