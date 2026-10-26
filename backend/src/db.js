/**
 * SQLite 数据层（ERP 版）
 * ------------------------------------------------------------
 * - 双驱动兜底：better-sqlite3 优先，失败回退 Node 内置 node:sqlite
 * - 首次启动自动建表 + 播种（公司/部门/管理员/演示主数据）
 * - 蓝图（原思维导图）配置存 app_config(key='mindmap')
 */
const fs = require('fs');
const path = require('path');

const config = require('./config');
const defaultMindmap = require('./data/defaultMindmap');
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

// ---------------- 建表 ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  company_id INTEGER,
  department_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  level TEXT DEFAULT 'B',
  credit_limit REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  remark TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT DEFAULT '件',
  price REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  remark TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL DEFAULT 'custom',      -- custom 定制 / stock 现货
  customer_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',     -- 见 orderFlow
  rate REAL NOT NULL DEFAULT 6.5,           -- 美元->人民币 固定汇率
  total_usd REAL NOT NULL DEFAULT 0,        -- 合计（美元）
  total_amount REAL NOT NULL DEFAULT 0,     -- 合计（人民币 = total_usd × rate）
  currency TEXT DEFAULT 'USD',
  style_name TEXT,                          -- 款名
  cus_order_no TEXT,                        -- 客户订单号
  manager TEXT,                             -- 跟单员
  order_date TEXT,                          -- 下单日期
  delivery_method TEXT,                     -- 交货方式（快递/空运/海运）
  packaging TEXT,                           -- 包装要求
  trade_terms TEXT,                         -- 贸易条款（FOB/CIF/EXW）
  shop_name TEXT,                           -- 店铺名称
  shop_order_no TEXT,                       -- 店铺订单编号
  delivery_days INTEGER DEFAULT 0,          -- 交货天数
  freight REAL DEFAULT 0,                   -- 运费
  delivery_date TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER,
  product_name TEXT NOT NULL,
  style_no TEXT,                            -- 款号
  sku TEXT,                                 -- SKU
  color TEXT,
  remark TEXT,
  qty REAL NOT NULL DEFAULT 0,              -- 该款合计件数
  amount_usd REAL NOT NULL DEFAULT 0,       -- 该款合计金额（美元）
  amount_cny REAL NOT NULL DEFAULT 0        -- 该款合计金额（人民币）
);

CREATE TABLE IF NOT EXISTS order_item_sizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  color TEXT,                               -- 颜色（一款多色）
  size TEXT NOT NULL,                       -- S/M/L/XL/XXL/均码...
  qty REAL NOT NULL DEFAULT 0,
  usd_price REAL NOT NULL DEFAULT 0,        -- 该尺码单价（美元）
  cny_price REAL NOT NULL DEFAULT 0,        -- 该尺码单价（人民币）
  amount_usd REAL NOT NULL DEFAULT 0,
  amount_cny REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT,
  operator TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_sizes_item ON order_item_sizes(item_id);
CREATE INDEX IF NOT EXISTS idx_logs_order ON order_logs(order_id);
`);

// ---------------- P2：技术 / 财务 ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS sample_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  style_no TEXT,
  type TEXT DEFAULT 'pattern',               -- pattern 制版 / sample 打样
  status TEXT NOT NULL DEFAULT 'pending',    -- pending / developing / confirmed / rejected
  developer TEXT,
  due_date TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tech_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_name TEXT,
  version TEXT DEFAULT 'V1',
  fabric_info TEXT,                           -- 面料信息
  accessory_info TEXT,                        -- 辅料信息
  craft_info TEXT,                            -- 工艺 / 工序
  customer_req TEXT,                          -- 客户要求
  fabric_ids TEXT,                            -- 选中的面料 id（逗号分隔）
  accessory_ids TEXT,                         -- 选中的辅料 id（逗号分隔）
  size_spec TEXT,                             -- 尺码规格说明
  stage TEXT NOT NULL DEFAULT 'draft',        -- 打版流程：draft/material/pattern/craft/sample/biz/confirmed
  status TEXT NOT NULL DEFAULT 'draft',       -- draft / confirmed / rejected
  confirmed_by TEXT,
  confirmed_at TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_sheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE,
  material_cost REAL DEFAULT 0,
  accessory_cost REAL DEFAULT 0,
  labor_cost REAL DEFAULT 0,
  overhead_cost REAL DEFAULT 0,
  other_cost REAL DEFAULT 0,
  total_cost REAL DEFAULT 0,
  profit_rate REAL DEFAULT 0,                 -- 加成比例 %
  factory_price REAL DEFAULT 0,               -- 出厂价 = 成本 × (1 + 利润率)
  status TEXT NOT NULL DEFAULT 'draft',       -- draft / pending / approved / rejected
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_opinion TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_crafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  name TEXT NOT NULL,                         -- 工艺名称
  qty REAL DEFAULT 0,                         -- 数量
  price REAL DEFAULT 0,                       -- 单价
  rate REAL DEFAULT 0,                        -- 倍率
  fob_price REAL DEFAULT 0,                   -- FOB 价
  is_out INTEGER DEFAULT 0,                   -- 是否外发
  is_wash INTEGER DEFAULT 0,                  -- 是否洗水
  is_cut INTEGER DEFAULT 0,                   -- 是否裁剪
  instruction TEXT,                           -- 工艺说明
  remark TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crafts_order ON order_crafts(order_id);

CREATE TABLE IF NOT EXISTS order_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  material_id INTEGER,                        -- 关联 materials 主数据（可空）
  type TEXT NOT NULL DEFAULT 'fabric',        -- fabric 面料 / accessory 辅料
  name TEXT NOT NULL,
  unit TEXT DEFAULT '',
  one_use REAL NOT NULL DEFAULT 0,            -- 单件用量
  loss REAL NOT NULL DEFAULT 0,               -- 损耗率 %
  total_use REAL NOT NULL DEFAULT 0,          -- 总用量 = 单件用量 × 总件数 × (1+损耗)
  price REAL NOT NULL DEFAULT 0,              -- 单价
  amount REAL NOT NULL DEFAULT 0,             -- 金额 = 总用量 × 单价
  spec TEXT,
  ingredient TEXT,                            -- 成分
  supplier TEXT,
  mat_color TEXT,
  remark TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ordermat_order ON order_materials(order_id);

CREATE TABLE IF NOT EXISTS order_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  name TEXT NOT NULL,                         -- 工序名称
  seq INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending 待开始 / doing 进行中 / done 已完成
  plan_date TEXT,                             -- 计划完成
  actual_date TEXT,                           -- 实际完成
  operator TEXT,                              -- 责任人
  remark TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_order ON order_nodes(order_id);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                         -- fabric 面料 / accessory 辅料
  code TEXT,
  name TEXT NOT NULL,
  spec TEXT,
  supplier TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_samples_order ON sample_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_materials_type ON materials(type);

CREATE TABLE IF NOT EXISTS size_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sizes TEXT NOT NULL,                        -- 逗号分隔，如 S,M,L,XL
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_techpacks_order ON tech_packs(order_id);
CREATE INDEX IF NOT EXISTS idx_cost_order ON cost_sheets(order_id);
`);

// ---------------- 播种 ----------------
(function seed() {
  const hasCompany = db.prepare('SELECT 1 AS x FROM companies LIMIT 1').get();
  if (!hasCompany) {
    db.prepare('INSERT INTO companies (code, name, created_at) VALUES (?, ?, ?)').run(
      'JSKJ',
      '跳色科技有限公司',
      now()
    );
  }
  const company = db.prepare('SELECT id FROM companies ORDER BY id LIMIT 1').get();

  const deptCount = db.prepare('SELECT COUNT(*) AS c FROM departments').get().c;
  if (Number(deptCount) === 0) {
    const names = ['销售部', '技术部', '财务部', '生产部', '仓储物流部', '人事行政部'];
    const stmt = db.prepare('INSERT INTO departments (company_id, name, created_at) VALUES (?, ?, ?)');
    names.forEach((n) => stmt.run(company.id, n, now()));
  }

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (Number(userCount) === 0) {
    db.prepare(
      'INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).run(config.adminUsername, hashPassword(config.adminPassword), '系统管理员', 'admin', company.id, now());
    console.log(`[db] 初始化管理员账号: ${config.adminUsername}`);
  }

  const custCount = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
  if (Number(custCount) === 0) {
    const stmt = db.prepare(
      'INSERT INTO customers (code, name, contact, phone, level, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    );
    const t = now();
    stmt.run('C001', '示范客户·美国 ABC', 'Tom', '', 'A', 'active', t, t);
    stmt.run('C002', '示范客户·欧洲 DEF', 'Jean', '', 'B', 'active', t, t);
    stmt.run('C003', '示范客户·国内 GHI', '王经理', '', 'B', 'active', t, t);
  }

  const prodCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (Number(prodCount) === 0) {
    const stmt = db.prepare(
      'INSERT INTO products (sku, name, category, unit, price, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    );
    const t = now();
    stmt.run('SKU-001', '女式针织开衫 A 款', '针织', '件', 68, 'active', t, t);
    stmt.run('SKU-002', '男士休闲长裤 B 款', '梭织', '件', 85, 'active', t, t);
    stmt.run('SKU-003', '儿童卫衣 C 款', '卫衣', '件', 45, 'active', t, t);
  }

  const bp = db.prepare('SELECT 1 AS x FROM app_config WHERE key = ?').get('mindmap');
  if (!bp) {
    db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run(
      'mindmap',
      JSON.stringify(defaultMindmap),
      now()
    );
  }

  // 系统设置（汇率）
  const st = db.prepare("SELECT 1 AS x FROM app_config WHERE key = 'settings'").get();
  if (!st) {
    db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('settings', ?, ?)").run(
      JSON.stringify({ exchangeRate: config.exchangeRate }),
      now()
    );
  }

  // 面辅料主数据
  const mCount = db.prepare('SELECT COUNT(*) AS c FROM materials').get().c;
  if (Number(mCount) === 0) {
    const ins = db.prepare('INSERT INTO materials (type, code, name, spec, supplier, status, created_at) VALUES (?,?,?,?,?,?,?)');
    const t = now();
    ins.run('fabric', 'F001', '羊毛混纺针织布', '320g / 幅宽1.6m', '示范面料厂A', 'active', t);
    ins.run('fabric', 'F002', '精梳棉梭织布', '180g / 幅宽1.5m', '示范面料厂B', 'active', t);
    ins.run('fabric', 'F003', '涤纶摇粒绒', '260g / 幅宽1.7m', '示范面料厂C', 'active', t);
    ins.run('accessory', 'A001', '树脂纽扣', '18L 四眼', '示范辅料厂A', 'active', t);
    ins.run('accessory', 'A002', 'YKK 拉链', '3# 尼龙', 'YKK', 'active', t);
    ins.run('accessory', 'A003', '涤纶里布', '210T', '示范辅料厂B', 'active', t);
    ins.run('accessory', 'A004', '织唛主标', '40x20mm', '示范辅料厂C', 'active', t);
  }

  // 尺码模板
  const stCount = db.prepare('SELECT COUNT(*) AS c FROM size_templates').get().c;
  if (Number(stCount) === 0) {
    const ins = db.prepare('INSERT INTO size_templates (name, sizes, created_at) VALUES (?,?,?)');
    const t = now();
    ins.run('婴童(59-80)', '59,66,73,80', t);
    ins.run('童装(90-130)', '90,100,110,120,130', t);
    ins.run('成人常规', 'S,M,L,XL,XXL', t);
    ins.run('成人女装', 'XS,S,M,L,XL', t);
    ins.run('均码', '均码', t);
  }
})();

// ---------------- 蓝图（原脑图） ----------------
function getMindmap() {
  const row = db.prepare('SELECT value, updated_at FROM app_config WHERE key = ?').get('mindmap');
  if (!row) return null;
  return { data: JSON.parse(row.value), updatedAt: row.updated_at };
}

function saveMindmap(data) {
  const t = now();
  const exists = db.prepare('SELECT 1 AS x FROM app_config WHERE key = ?').get('mindmap');
  if (exists) {
    db.prepare('UPDATE app_config SET value = ?, updated_at = ? WHERE key = ?').run(
      JSON.stringify(data),
      t,
      'mindmap'
    );
  } else {
    db.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run(
      'mindmap',
      JSON.stringify(data),
      t
    );
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

module.exports = { db, driver, now, getMindmap, saveMindmap, getSettings, saveSettings };
