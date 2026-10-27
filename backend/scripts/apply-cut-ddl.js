/**
 * 裁床排料与扎包 DDL（P0-5 / 原型 TS-N08-02）
 *   node scripts/apply-cut-ddl.js && node scripts/rebuild-schema.js
 */
const { db } = require('../src/db');

const DDL = [
  // 裁剪单：一单一任务，引用技术版与已核用量
  `CREATE TABLE IF NOT EXISTS cut_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cut_no TEXT UNIQUE NOT NULL,                 -- CY+日期+序号
  order_id INTEGER UNIQUE NOT NULL,
  order_no TEXT,
  style_no TEXT,
  tech_pack_id INTEGER,                        -- 引用的技术版（必须是已确认）
  plan_qty INTEGER NOT NULL DEFAULT 0,         -- 订单计划件数
  status TEXT NOT NULL DEFAULT 'draft',        -- draft / cutting / cut_done / handed

  -- P4 配料接收
  fabric_ready INTEGER NOT NULL DEFAULT 0,     -- 面料是否已在裁剪现场验收入库
  fabric_note TEXT,

  -- 裁剪汇总（由床次汇总）
  lot_count INTEGER NOT NULL DEFAULT 0,        -- 床次数
  total_layers INTEGER NOT NULL DEFAULT 0,     -- 累计层数
  total_cut_qty INTEGER NOT NULL DEFAULT 0,    -- 实裁件数（床次 actual 合计）
  qualified_qty INTEGER NOT NULL DEFAULT 0,    -- 合格裁片
  reject_qty INTEGER NOT NULL DEFAULT 0,       -- 疵片 / 次品
  leftover_m REAL NOT NULL DEFAULT 0,          -- 余料（米）
  diff_qty INTEGER NOT NULL DEFAULT 0,         -- 裁差 = 实裁 - 计划
  diff_reason TEXT,                            -- 裁差说明（有差异必填）
  mixed_dye_lot INTEGER NOT NULL DEFAULT 0,    -- 是否混缸（错缸需说明）

  -- 扎包
  bundle_count INTEGER NOT NULL DEFAULT 0,
  bundle_qty INTEGER NOT NULL DEFAULT 0,
  bundle_rule INTEGER NOT NULL DEFAULT 20,     -- 每扎件数

  cut_by TEXT,
  cut_at TEXT,
  checked_by TEXT,                             -- 复核人
  checked_at TEXT,
  handover_at TEXT,                            -- P6 辅料交接
  note TEXT,
  created_at TEXT,
  updated_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_cut_status ON cut_orders(status)`,

  // 床次：每床一个布卷 / 缸号 / 层数 / 排料图
  `CREATE TABLE IF NOT EXISTS cut_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cut_order_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,              -- 床号
  bed_no TEXT,                                 -- 床次编号，如 1 床 / A 床
  fabric_roll TEXT,                            -- 布卷号
  dye_lot TEXT,                                -- 缸号 / 缸批（错缸判定的依据）
  width TEXT,                                  -- 幅宽
  layers INTEGER NOT NULL DEFAULT 0,           -- 拉布层数
  marker_no TEXT,                              -- 排料图号
  marker_len REAL NOT NULL DEFAULT 0,          -- 排料长度（米）
  plan_qty INTEGER NOT NULL DEFAULT 0,         -- 本床计划件数
  actual_qty INTEGER NOT NULL DEFAULT 0,       -- 本床实裁件数
  leftover_m REAL NOT NULL DEFAULT 0,          -- 本床余料（米）
  status TEXT NOT NULL DEFAULT 'pending',      -- pending / cutting / done
  operator TEXT,
  note TEXT,
  created_at TEXT,
  updated_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_cutlot_order ON cut_lots(cut_order_id)`,

  // 扎包：裁片按扎交付，扎号是后续缝制与检验的追溯单位
  `CREATE TABLE IF NOT EXISTS cut_bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cut_order_id INTEGER NOT NULL,
  lot_id INTEGER,
  bundle_no TEXT NOT NULL,                     -- 扎号
  color TEXT,
  size TEXT,
  qty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'created',      -- created / checked / handed
  checked_by TEXT,
  checked_at TEXT,
  note TEXT,
  created_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_cutbundle_order ON cut_bundles(cut_order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cutbundle_lot ON cut_bundles(lot_id)`
];

let n = 0;
DDL.forEach((sql) => {
  try { db.exec(sql); n++; } catch (e) { console.error('失败：', sql.slice(0, 50), e.message); }
});
console.log(`已执行 ${n}/${DDL.length} 条 DDL`);
const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cut_%'").all();
console.log('裁床表：', t.map((x) => x.name).join(', '));
