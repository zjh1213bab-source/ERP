/**
 * M07 裁片外发与外协验货交接 —— 建表（幂等）
 * ============================================================
 * 缺口来源：GAP-ANALYSIS M07「裁片外发」「外协验货交接」。
 *
 * 已有基础：
 *   `cut_orders` / `cut_lots` / `cut_bundles`（裁床 → 床次 → 扎包，扎包已到「复核」这一环）
 *   `factories`（own/outsource）、`dispatch_orders`（整单分厂，按件数不按扎）
 *
 * 为什么不能复用 `dispatch_orders`：
 *   分单是「整单交给哪家做、多少件、什么价」，粒度到订单；
 *   裁片外发是「**具体哪几扎**裁片发给哪家、回来几件、合格几件、短了为什么」，粒度到扎。
 *   扎是唯一能追到缸号/色差/裁片批次的单位，混进分单会把追溯链打断。
 *
 * 用法：node scripts/apply-cutdispatch-ddl.js
 */
const { db } = require('../src/db');

db.exec(`
-- 1) 裁片外发单（一次把若干扎发给一家外协）
CREATE TABLE IF NOT EXISTS cut_dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_no TEXT NOT NULL UNIQUE,            -- WF+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  cut_order_id INTEGER NOT NULL,
  cut_no TEXT,
  order_id INTEGER,
  order_no TEXT,
  style_no TEXT,
  factory_id INTEGER NOT NULL,
  factory_name TEXT,
  out_date TEXT NOT NULL,                      -- 发出日期
  expect_return_date TEXT,                     -- 约定回货日
  bundle_count INTEGER NOT NULL DEFAULT 0,     -- 发出扎数
  out_qty REAL NOT NULL DEFAULT 0,             -- 发出件数（= 扎包件数合计，不能手改）
  returned_qty REAL NOT NULL DEFAULT 0,        -- 已回货件数
  accepted_qty REAL NOT NULL DEFAULT 0,        -- 验收合格
  rejected_qty REAL NOT NULL DEFAULT 0,        -- 不良（退回/报废）
  rework_qty REAL NOT NULL DEFAULT 0,          -- 返工（返厂重修）
  loss_qty REAL NOT NULL DEFAULT 0,            -- 差异 = 发出 − 已回（要写原因）
  price REAL NOT NULL DEFAULT 0,               -- 加工单价（件）
  amount REAL NOT NULL DEFAULT 0,              -- 加工费 = 合格件 × 单价
  status TEXT NOT NULL DEFAULT 'draft',        -- draft 草稿 / sent 已发出 / partial 部分回货
                                               -- returned 已回齐 / closed 已结案 / cancelled 已取消
  out_by TEXT, out_at TEXT,
  closed_by TEXT, closed_at TEXT,
  loss_reason TEXT,                            -- 差异原因（有差异必填才能结案）
  note TEXT,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_cutdisp_status ON cut_dispatches(status, id);
CREATE INDEX IF NOT EXISTS idx_cutdisp_cut ON cut_dispatches(cut_order_id);
CREATE INDEX IF NOT EXISTS idx_cutdisp_factory ON cut_dispatches(factory_id);

-- 2) 外发明细：按扎登记
CREATE TABLE IF NOT EXISTS cut_dispatch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id INTEGER NOT NULL,
  bundle_id INTEGER NOT NULL,
  bundle_no TEXT NOT NULL,
  lot_no TEXT,                                 -- 床号
  dye_lot TEXT,                                -- 缸号（色差追溯）
  color TEXT,
  size TEXT,
  qty REAL NOT NULL DEFAULT 0,                 -- 发出件数（= 扎包件数）
  returned_qty REAL NOT NULL DEFAULT 0,
  accepted_qty REAL NOT NULL DEFAULT 0,
  rejected_qty REAL NOT NULL DEFAULT 0,
  rework_qty REAL NOT NULL DEFAULT 0,
  short_qty REAL NOT NULL DEFAULT 0,           -- 这扎声明不再补的短数（要从扎的「未回」里扣掉）
  -- 1 = 这张单还没结案。外发单结案/取消时置 0，扎才能再次外发。
  -- 索引不能跨表判断「外发单是否完结」，所以用这个标记列兜底，防止同一扎被两张单同时算。
  open_flag INTEGER NOT NULL DEFAULT 1,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cutdisp_bundle_open
  ON cut_dispatch_items(bundle_id) WHERE open_flag = 1;
CREATE INDEX IF NOT EXISTS idx_cutdispi_disp ON cut_dispatch_items(dispatch_id);

-- 3) 回货验收单（一批一行；外协可能分几次送回来）
CREATE TABLE IF NOT EXISTS cut_dispatch_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no TEXT NOT NULL UNIQUE,             -- HH+YYYYMMDD+序号
  dispatch_id INTEGER NOT NULL,
  receive_date TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,                 -- 本次回货件数
  accepted_qty REAL NOT NULL DEFAULT 0,        -- 合格
  rejected_qty REAL NOT NULL DEFAULT 0,        -- 不良
  rework_qty REAL NOT NULL DEFAULT 0,          -- 返工
  short_qty REAL NOT NULL DEFAULT 0,           -- 本次短数（发出但这次没送回，且声明不再补）
  handover_by TEXT,                            -- 外协交货人
  received_by TEXT,                            -- 本厂接收人
  inspected_by TEXT,                           -- 验货人
  inspect_result TEXT,                         -- pass 合格放行 / conditional 让步接收 / reject 退回
  short_reason TEXT,                           -- 短数原因（有短数必填）
  remark TEXT,
  created_by TEXT, created_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_cutrecv_disp ON cut_dispatch_receipts(dispatch_id);

-- 4) 回货明细：按扎回几件、合格几件
CREATE TABLE IF NOT EXISTS cut_dispatch_receipt_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL,
  dispatch_item_id INTEGER NOT NULL,
  bundle_no TEXT,
  qty REAL NOT NULL DEFAULT 0,
  accepted_qty REAL NOT NULL DEFAULT 0,
  rejected_qty REAL NOT NULL DEFAULT 0,
  rework_qty REAL NOT NULL DEFAULT 0,
  defect_reason TEXT,                          -- 不良原因（有不良必填）
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_cutrecvi_recv ON cut_dispatch_receipt_items(receipt_id);
`);

const hasShort = db.prepare('PRAGMA table_info(cut_dispatch_items)').all().some((c) => c.name === 'short_qty');
if (!hasShort) {
  db.exec("ALTER TABLE cut_dispatch_items ADD COLUMN short_qty REAL NOT NULL DEFAULT 0");
  console.log('  + cut_dispatch_items.short_qty');
}

console.log('[apply-cutdispatch-ddl] 4 张表就绪：cut_dispatches / cut_dispatch_items / cut_dispatch_receipts / cut_dispatch_receipt_items');
