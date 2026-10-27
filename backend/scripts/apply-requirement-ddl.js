/**
 * 齐套与缺料看板 DDL（P0-4 / 原型 TS-N06-02）
 *   node scripts/apply-requirement-ddl.js && node scripts/rebuild-schema.js
 */
const { db } = require('../src/db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS material_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  order_no TEXT,
  tech_pack_id INTEGER,
  material_id INTEGER,                          -- 来源档案（手工行可能为空）
  material_name TEXT,
  mat_type TEXT,                                -- fabric / accessory
  colorway TEXT,
  color_no TEXT,
  spec_info TEXT,
  unit TEXT,

  need_qty REAL NOT NULL DEFAULT 0,             -- 需求量 = 单件用量 ×(1+损耗) × 订单件数
  unit_price REAL NOT NULL DEFAULT 0,

  alloc_stock REAL NOT NULL DEFAULT 0,          -- 库存分配到本单的数量
  alloc_po REAL NOT NULL DEFAULT 0,             -- 在途（已订未到）分配到本单的数量
  gap_qty REAL NOT NULL DEFAULT 0,              -- 净缺口 = need - alloc_stock - alloc_po
  gap_amount REAL NOT NULL DEFAULT 0,           -- 缺口金额

  impact_node TEXT,                             -- 影响工序：P5 裁剪 / P6 配辅料 / B1 缝制
  status TEXT NOT NULL DEFAULT 'ok',            -- ok 齐套 / partial 部分 / short 缺料 / ordered 已下单
  owner TEXT,
  action TEXT NOT NULL DEFAULT 'pending',       -- pending / ordered / substituted / received
  note TEXT,

  calc_at TEXT,
  updated_at TEXT,
  UNIQUE(order_id, material_name)
)`,
  `CREATE INDEX IF NOT EXISTS idx_req_order ON material_requirements(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_req_status ON material_requirements(status)`,
  `CREATE INDEX IF NOT EXISTS idx_req_material ON material_requirements(material_id)`
];

let n = 0;
DDL.forEach((sql) => {
  try { db.exec(sql); n++; } catch (e) { console.error('失败：', sql.slice(0, 50), e.message); }
});
console.log(`已执行 ${n}/${DDL.length} 条 DDL`);
const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='material_requirements'").get();
console.log('齐套表：', t ? t.name : '未创建');
