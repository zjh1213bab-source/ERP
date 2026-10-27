/**
 * 生产原料收货与检验 DDL（P0-7 / 原型 TS-N10-08）
 *   node scripts/apply-receipt-ddl.js && node scripts/rebuild-schema.js
 */
const { db } = require('../src/db');

const DDL = [
  // 收料单（GRN）：一张单对一张采购单的一次到货
  `CREATE TABLE IF NOT EXISTS goods_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_no TEXT UNIQUE NOT NULL,                -- GRN+日期+序号
  po_id INTEGER,
  po_no TEXT,
  supplier TEXT,
  receive_date TEXT,
  warehouse TEXT NOT NULL DEFAULT '原料库',    -- 原料库
  status TEXT NOT NULL DEFAULT 'pending',     -- pending 待检 / inspecting 检验中 / partial 部分合格 / passed 全部合格 / rejected 全退 / cancelled 作废

  -- 汇总（由明细汇总）
  line_count INTEGER NOT NULL DEFAULT 0,
  expect_qty REAL NOT NULL DEFAULT 0,         -- 应收（本次）
  receive_qty REAL NOT NULL DEFAULT 0,        -- 实收
  pending_qty REAL NOT NULL DEFAULT 0,        -- 待检
  pass_qty REAL NOT NULL DEFAULT 0,           -- 合格（只这部分进可用库存）
  freeze_qty REAL NOT NULL DEFAULT 0,         -- 冻结
  reject_qty REAL NOT NULL DEFAULT 0,         -- 退回
  over_qty REAL NOT NULL DEFAULT 0,           -- 超收量（需调查）
  short_qty REAL NOT NULL DEFAULT 0,          -- 短收量（待补）

  receive_by TEXT,
  receive_at TEXT,
  inspect_by TEXT,
  inspect_at TEXT,
  remark TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_grn_status ON goods_receipts(status)`,
  `CREATE INDEX IF NOT EXISTS idx_grn_po ON goods_receipts(po_id)`,

  // 收料明细：一条 = 一个卷号 / 缸号
  `CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_id INTEGER NOT NULL,
  po_item_id INTEGER,
  material_id INTEGER,
  material_name TEXT,
  spec TEXT,
  unit TEXT,

  -- 卷缸追溯
  roll_no TEXT,                               -- 卷号
  dye_lot TEXT,                               -- 缸号
  location TEXT,                              -- 原料库位

  -- 数量与差异
  expect_qty REAL NOT NULL DEFAULT 0,          -- 应收
  receive_qty REAL NOT NULL DEFAULT 0,         -- 实收
  diff_qty REAL NOT NULL DEFAULT 0,            -- 差异 = 实收 - 应收
  diff_type TEXT NOT NULL DEFAULT 'none',      -- none / over 超收 / short 短收
  diff_reason TEXT,                            -- 超收必须写原因

  -- 检验分流：实收 = 待检 + 合格 + 冻结 + 退回
  pending_qty REAL NOT NULL DEFAULT 0,
  pass_qty REAL NOT NULL DEFAULT 0,
  freeze_qty REAL NOT NULL DEFAULT 0,
  reject_qty REAL NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'pending',      -- pending 待检 / passed 合格 / partial 部分合格 / frozen 冻结 / rejected 退回
  inspect_by TEXT,
  inspect_at TEXT,
  inspect_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_grni_grn ON goods_receipt_items(grn_id)`,
  `CREATE INDEX IF NOT EXISTS idx_grni_material ON goods_receipt_items(material_id)`,

  // 冻结/退回的处置留痕（复核放行、让步接收、退货）
  `CREATE TABLE IF NOT EXISTS goods_receipt_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  grn_id INTEGER NOT NULL,
  action TEXT NOT NULL,                        -- release 冻结转合格 / reject 转退回 / note 备注
  qty REAL NOT NULL DEFAULT 0,
  reason TEXT,
  operator TEXT,
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_gra_item ON goods_receipt_actions(item_id)`
];

let n = 0;
for (const sql of DDL) {
  db.exec(sql);
  n++;
}
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'goods_receipt%'")
  .all()
  .map((r) => r.name);
console.log(`已执行 ${n} 条 DDL；新表：${tables.join(', ')}`);
