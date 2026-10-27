/**
 * 成本对象层 DDL（P0-2 制造成本与已售毛利）
 * 用法：node scripts/apply-cost-ddl.js
 * 执行后跑 scripts/rebuild-schema.js 把新表并进 src/schema.js 快照。
 */

const DDL = [
  `CREATE TABLE IF NOT EXISTS cost_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cost_no TEXT UNIQUE NOT NULL,              -- CB+日期+序号
  order_id INTEGER UNIQUE,                   -- 一单一成本对象（COST-01）
  order_no TEXT,
  customer_name TEXT,
  style_no TEXT,
  qty INTEGER NOT NULL DEFAULT 0,            -- 订单总件数（从尺码明细汇总）
  currency TEXT NOT NULL DEFAULT 'CNY',      -- 收入币种
  rate REAL NOT NULL DEFAULT 1,
  revenue_orig REAL NOT NULL DEFAULT 0,      -- 收入原币（美金）
  revenue_cny REAL NOT NULL DEFAULT 0,       -- 收入本币
  budget_cost REAL NOT NULL DEFAULT 0,       -- 预算成本（核价成本单 total_cost）
  actual_cost REAL NOT NULL DEFAULT 0,       -- 已归集实际成本合计
  sold_qty INTEGER NOT NULL DEFAULT 0,       -- 已结转成本的数量
  sold_cost REAL NOT NULL DEFAULT 0,         -- 已售成本
  sold_revenue REAL NOT NULL DEFAULT 0,      -- 已售收入
  status TEXT NOT NULL DEFAULT 'open',       -- open / closed
  remark TEXT,
  created_at TEXT,
  updated_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_costobj_order ON cost_objects(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_costobj_status ON cost_objects(status)`,

  // 成本归集明细：一层一行，auto 由物料/工价/核价单自动算出，manual 手工补
  `CREATE TABLE IF NOT EXISTS cost_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cost_object_id INTEGER NOT NULL,
  layer TEXT NOT NULL,                       -- material 面料 / accessory 辅料 / labor 工缴 / overhead 制造费用 / other 其他 / freight 后补到仓费用 / rework 返工报废
  source TEXT NOT NULL DEFAULT 'auto',       -- auto / manual
  ref_type TEXT,                             -- tech_pack_material / craft / cost_sheet
  ref_id INTEGER,
  name TEXT,
  qty REAL NOT NULL DEFAULT 0,               -- 数量（用量 × 件数）
  unit TEXT,
  unit_price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  occurred_at TEXT,
  remark TEXT,
  created_by TEXT,
  created_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_costentry_obj ON cost_entries(cost_object_id)`,
  `CREATE INDEX IF NOT EXISTS idx_costentry_layer ON cost_entries(layer)`,

  // 已售成本快照：每次发货按数量比例把成本结转到「已售」，后补成本再补提差额
  `CREATE TABLE IF NOT EXISTS cost_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cost_object_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  qty INTEGER NOT NULL DEFAULT 0,            -- 累计已发货数量
  total_qty INTEGER NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,         -- 单件成本
  sold_cost REAL NOT NULL DEFAULT 0,         -- 累计已售成本
  sold_revenue REAL NOT NULL DEFAULT 0,      -- 累计已售收入
  gross_profit REAL NOT NULL DEFAULT 0,      -- 毛利 = 已售收入 - 已售成本
  note TEXT,
  created_by TEXT,
  created_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_costsnap_obj ON cost_snapshots(cost_object_id)`
];

module.exports = DDL;
