/**
 * M19 美仓作业计划 —— 建表（幂等）
 * ============================================================
 * 三块作业能力：
 *   N19-04 拣货波次：把有效预留合成波次，按库位拣货 → 复核称重 → 交承运出库
 *   N19-02 跨境头程：运输段（ETD/ETA/实际）+ 箱级短多错损 + ETA 变更影响面
 *   库容规划：库位容量、占用率（上架 − 波次拣出）、上架建议
 *
 * 为什么不新建「库位库存表」：
 *   库位结存 = wh_putaways 的上架量 − 已交承运波次的拣出量，
 *   两个都是既有账源，再加一张表就要同步三处，迟早对不上。
 *   盘点差异走既有盘点/调整流程，不在本模块另开一套。
 *
 * 用法：node scripts/apply-whplan-ddl.js
 */
const { db } = require('../src/db');

db.exec(`
-- 1) 拣货波次
CREATE TABLE IF NOT EXISTS pick_waves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL DEFAULT 1,
  warehouse TEXT NOT NULL DEFAULT 'us',
  strategy TEXT NOT NULL DEFAULT 'zone',      -- zone / order / manual
  carrier TEXT,
  tracking_no TEXT,
  package_weight REAL,
  item_cnt INTEGER NOT NULL DEFAULT 0,
  qty_total REAL NOT NULL DEFAULT 0,
  qty_picked REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',       -- draft / released / picking / packed / shipped / cancelled
  short_reason TEXT,
  cancel_reason TEXT,
  note TEXT,
  created_by TEXT,
  released_at TEXT,
  packed_at TEXT,
  shipped_at TEXT,
  cancelled_at TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
-- 运单号全局唯一：同一个面单号不能贴两个包裹
CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_wave_tracking ON pick_waves(tracking_no) WHERE tracking_no IS NOT NULL AND tracking_no<>'';

-- 2) 波次明细（一笔预留只能进一个未取消的波次）
CREATE TABLE IF NOT EXISTS pick_wave_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_id INTEGER NOT NULL,
  hold_id INTEGER,
  order_id INTEGER,
  customer_id INTEGER,
  customer_name TEXT,
  location_id INTEGER,
  loc_code TEXT,
  loc_source TEXT,                            -- sku_stock（按该 SKU 库位结存分配） / capacity（按剩余容量兜底）
  style_no TEXT,
  color TEXT,
  size TEXT,
  sku TEXT,
  qty REAL NOT NULL DEFAULT 0,
  qty_picked REAL NOT NULL DEFAULT 0,
  qty_short REAL NOT NULL DEFAULT 0,
  short_reason TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending / picked / short / cancelled
  picked_by TEXT,
  picked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pick_item_wave ON pick_wave_items(wave_id);
-- 同一笔预留不能同时出现在两个未取消波次里（否则会被拣两次）
CREATE UNIQUE INDEX IF NOT EXISTS uq_pick_item_hold ON pick_wave_items(hold_id) WHERE hold_id IS NOT NULL AND status<>'cancelled';

-- 3) 头程运输段
CREATE TABLE IF NOT EXISTS wh_asn_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asn_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ocean',         -- ocean / air / rail / truck
  carrier TEXT,
  etd TEXT,
  eta TEXT,
  actual_at TEXT,
  status TEXT NOT NULL DEFAULT 'planned',     -- planned / in_transit / arrived
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wh_leg_asn ON wh_asn_legs(asn_id);

-- 4) 箱级短多错损
CREATE TABLE IF NOT EXISTS wh_asn_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asn_id INTEGER NOT NULL,
  carton_no TEXT NOT NULL,
  style_no TEXT,
  expect_qty REAL NOT NULL DEFAULT 0,
  received_qty REAL NOT NULL DEFAULT 0,
  short_qty REAL NOT NULL DEFAULT 0,
  over_qty REAL NOT NULL DEFAULT 0,
  damaged_qty REAL NOT NULL DEFAULT 0,
  reason TEXT,
  checked_by TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_box ON wh_asn_boxes(asn_id, carton_no);

-- 5) 头程变更留痕（ETA 一变，受影响的需求要能被点出来）
CREATE TABLE IF NOT EXISTS wh_asn_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asn_id INTEGER NOT NULL,
  field TEXT NOT NULL,                        -- eta_date / ship_date
  from_value TEXT,
  to_value TEXT,
  impacted_cnt INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  operator TEXT,
  created_at TEXT NOT NULL
);
`);

/* ---------- 轻量迁移 ---------- */
function hasCol(table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch (e) { return false; }
}

// 上架记录不带 SKU，就没法按「该 SKU 在哪个库位」分配拣货 → 补三列
['style_no', 'color', 'size'].forEach((c) => {
  if (!hasCol('wh_putaways', c)) {
    db.exec(`ALTER TABLE wh_putaways ADD COLUMN ${c} TEXT`);
    console.log(`[whplan-ddl] wh_putaways + ${c}`);
  }
});

console.log('[whplan-ddl] done');
