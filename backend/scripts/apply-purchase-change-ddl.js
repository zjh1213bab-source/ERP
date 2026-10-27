/**
 * 停单改量与供应商退料 DDL（P1 / 原型 TS-N07-06）
 *   node scripts/apply-purchase-change-ddl.js && node scripts/rebuild-schema.js
 *
 * 1) purchase_items 补 issued_qty(已领) / returned_qty(已退)：可退量 = 已收 − 已领 − 已退
 * 2) purchase_changes：采购变更单（减量 / 停单），供方确认后才可生效
 * 3) purchase_change_items：逐行改量（未交部分才能减；已收只能退不能停）
 * 4) purchase_returns：退料单（实物回执 + 贷项回执 两道分别留痕）
 * 5) purchase_return_items：退料明细
 */
const { db } = require('../src/db');

function cols(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch (e) { return []; }
}

function add(table, col, ddl) {
  const c = cols(table);
  if (c.length && !c.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    console.log(`  + ${table}.${col}`);
  }
}

console.log('purchase_items 扩列：');
add('purchase_items', 'issued_qty', 'REAL NOT NULL DEFAULT 0');   // 已领/已发到生产
add('purchase_items', 'returned_qty', 'REAL NOT NULL DEFAULT 0'); // 已退供应商累计

const DDL = [
  // 采购变更单（减量 / 停单）
  `CREATE TABLE IF NOT EXISTS purchase_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_no TEXT UNIQUE NOT NULL,              -- PC+日期+序号
  po_id INTEGER NOT NULL,
  po_no TEXT,
  supplier_id INTEGER,
  supplier_name TEXT,
  type TEXT NOT NULL DEFAULT 'reduce',          -- reduce 减量 / cancel 停单
  reason TEXT,                                 -- 变更原因（客户改单 / 停产 / 换料…）
  note TEXT,
  reduce_qty REAL NOT NULL DEFAULT 0,          -- 本次减掉的总量（未交部分）
  returnable_qty REAL NOT NULL DEFAULT 0,      -- 已收可退总量提示（收到已交未用才退）
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft / pending_supplier / confirmed / rejected / effective / voided
  supplier_confirmed_by TEXT,
  supplier_confirmed_at TEXT,
  supplier_comment TEXT,
  credit_note_no TEXT,                          -- 差异结算贷项凭证号
  credit_amount REAL NOT NULL DEFAULT 0,
  effective_by TEXT,
  effective_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pchg_po ON purchase_changes(po_id, status)`,

  `CREATE TABLE IF NOT EXISTS purchase_change_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  material_id INTEGER,
  material_name TEXT,
  spec TEXT,
  unit TEXT,
  qty REAL NOT NULL DEFAULT 0,                 -- 原采购量
  received_qty REAL NOT NULL DEFAULT 0,        -- 已收
  issued_qty REAL NOT NULL DEFAULT 0,          -- 已领
  returned_qty REAL NOT NULL DEFAULT 0,        -- 已退
  pending_qty REAL NOT NULL DEFAULT 0,         -- 未交 = qty - received
  new_qty REAL NOT NULL DEFAULT 0,             -- 减量后采购量
  reduce_qty REAL NOT NULL DEFAULT 0,          -- 本次减量（只作用于未交）
  returnable_qty REAL NOT NULL DEFAULT 0,      -- 已收可退 = received - issued - returned
  return_flag INTEGER NOT NULL DEFAULT 0       -- 减量同时发起退料
  )`,

  // 退料单（已收未用退回供应商）
  `CREATE TABLE IF NOT EXISTS purchase_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no TEXT UNIQUE NOT NULL,              -- RT+日期+序号
  po_id INTEGER NOT NULL,
  po_no TEXT,
  change_id INTEGER,
  supplier_id INTEGER,
  supplier_name TEXT,
  reason TEXT,
  note TEXT,
  return_qty REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_receipt', -- pending_receipt 待实物回执 / returned 实物已退 / credited 贷项已收 / done 完成 / voided 作废
  physical_receipt_note TEXT,                  -- 实物回执（物流单号 / 签收）
  physical_by TEXT,
  physical_at TEXT,
  credit_note_no TEXT,                         -- 贷项凭证号（供应商冲减应收）
  credit_amount REAL NOT NULL DEFAULT 0,
  credit_by TEXT,
  credit_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pret_po ON purchase_returns(po_id, status)`,

  `CREATE TABLE IF NOT EXISTS purchase_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL,
  po_item_id INTEGER NOT NULL,
  material_id INTEGER,
  material_name TEXT,
  spec TEXT,
  unit TEXT,
  qty REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0
  )`
];

DDL.forEach((sql) => db.exec(sql));
console.log('新增 4 张表 / 2 个索引');
console.log('完成。记得执行 scripts/rebuild-schema.js');
