/**
 * M10 备料领退与盘点差异 —— 建表（幂等）
 * ============================================================
 * 缺口来源：GAP-ANALYSIS M10「备料领退与盘点差异」。
 *
 * 已有基础：
 *   `materials.stock_qty`（原料可用库存）、`order_materials`（订单用料＝需求侧）、
 *   `purchase_items`（采购价，用来给差异计价）、`receipts.js`（合格才加库存）、
 *   `purchaseChanges.js`（采购退料扣库存）。
 *
 * 为什么必须先建 `material_ledger`：
 *   `materials.stock_qty` 现在是个**没有任何流水支撑的裸字段**——收货 +、采购退料 −、
 *   以后领料还要 −。三处各改各的，账实一旦对不上，谁也说不清是哪一步错的，
 *   盘点差异也没有办法归因到「领多了/退少了/收错了」。
 *   所以先补流水表，再把所有增减都改成「写流水 + 改余额」同一个事务。
 *
 * 为什么不复用 `stock_ledger`：
 *   `stock_ledger` 是**成品**流水（按 warehouse/style_no/color/size，走 SKU 维度）；
 *   原料是按 `material_id` + 单位（米/个/卷），没有款色码概念，混进去会让两边口径都脏。
 *
 * 用法：node scripts/apply-materials-ddl.js
 */
const { db } = require('../src/db');

db.exec(`
-- 1) 原料流水（所有原料增减的唯一凭据）
CREATE TABLE IF NOT EXISTS material_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  material_id INTEGER NOT NULL,
  material_name TEXT,
  type TEXT NOT NULL,                          -- receipt 收货合格 / issue 领料发出 / issue_return 退料入库
                                               -- po_return 退回供应商 / stock_gain 盘盈 / stock_loss 盘亏 / scrap 报废
  qty REAL NOT NULL,                           -- 带符号：正=入，负=出
  unit TEXT,
  ref_type TEXT,                               -- goods_receipt / material_issue / material_return / stocktake
  ref_id INTEGER,
  ref_no TEXT,
  remark TEXT,
  operator TEXT,
  created_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_matled_mat ON material_ledger(material_id, id);
CREATE INDEX IF NOT EXISTS idx_matled_ref ON material_ledger(ref_type, ref_id);

-- 2) 备料/领料单（备料占用，发料才扣库存）
CREATE TABLE IF NOT EXISTS material_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL DEFAULT 1,
  order_id INTEGER,
  order_no TEXT,
  style_no TEXT,
  kind TEXT NOT NULL DEFAULT 'order',          -- order 订单备料 / extra 补料 / sample 打样
  receiver_type TEXT NOT NULL DEFAULT 'own',   -- own 本厂 / outsource 外协
  factory_id INTEGER,
  factory_name TEXT,
  req_date TEXT,                               -- 需求日（车间要用的日期）
  status TEXT NOT NULL DEFAULT 'draft',        -- draft 草稿 / prepared 已备料(占用) / issued 已发料(扣库存)
                                               -- partial 已发部分(仍有欠发) / closed 已结案 / cancelled 已取消
  item_count INTEGER NOT NULL DEFAULT 0,
  req_qty REAL NOT NULL DEFAULT 0,
  issued_qty REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,              -- 已发料金额（按发料单价）
  prepared_by TEXT, prepared_at TEXT,
  issued_by TEXT, issued_at TEXT,
  closed_by TEXT, closed_at TEXT,
  note TEXT,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_matissue_order ON material_issues(order_id);
CREATE INDEX IF NOT EXISTS idx_matissue_status ON material_issues(status, id);

CREATE TABLE IF NOT EXISTS material_issue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  material_id INTEGER,
  name TEXT NOT NULL,
  spec TEXT,
  unit TEXT,
  req_qty REAL NOT NULL DEFAULT 0,             -- 需求（订单用料 total_use，或手工填）
  issued_qty REAL NOT NULL DEFAULT 0,          -- 实发
  returned_qty REAL NOT NULL DEFAULT 0,        -- 已退（累加）
  price REAL,                                  -- 发料单价（快照；取不到为 NULL）
  amount REAL NOT NULL DEFAULT 0,              -- 实发金额
  batch_no TEXT,                               -- 缸号/批号（面料追溯用）
  short_qty REAL NOT NULL DEFAULT 0,           -- 欠发 = req - issued
  remark TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_item ON material_issue_items(issue_id, material_id, name);

-- 3) 退料单
CREATE TABLE IF NOT EXISTS material_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL DEFAULT 1,
  issue_id INTEGER,
  order_id INTEGER,
  order_no TEXT,
  type TEXT NOT NULL DEFAULT 'leftover',       -- leftover 余料退回 / wrong_spec 规格不符 / defect 质量 / order_cancel 订单取消
  status TEXT NOT NULL DEFAULT 'draft',        -- draft / confirmed / cancelled
  qty REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,                        -- 退料原因（必填，≥4 字）
  confirmed_by TEXT, confirmed_at TEXT,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  demo_tag TEXT
);

CREATE TABLE IF NOT EXISTS material_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL,
  issue_item_id INTEGER,
  material_id INTEGER,
  name TEXT NOT NULL,
  spec TEXT,
  unit TEXT,
  qty REAL NOT NULL DEFAULT 0,
  price REAL,
  amount REAL NOT NULL DEFAULT 0,
  batch_no TEXT,
  remark TEXT
);

-- 4) 盘点单（原料）
CREATE TABLE IF NOT EXISTS stocktakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  take_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'material',      -- material 原料（成品盘点走 /api/stock/adjust）
  warehouse TEXT NOT NULL DEFAULT 'cn',
  take_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',        -- draft 草稿 / counting 盘点中(冻结) / submitted 已提交待调账
                                               -- adjusted 已调账 / cancelled 已取消
  freeze INTEGER NOT NULL DEFAULT 1,           -- 1 = 期间禁止领退料与收货过账
  item_count INTEGER NOT NULL DEFAULT 0,
  diff_count INTEGER NOT NULL DEFAULT 0,
  gain_qty REAL NOT NULL DEFAULT 0,
  loss_qty REAL NOT NULL DEFAULT 0,
  gain_amount REAL NOT NULL DEFAULT 0,
  loss_amount REAL NOT NULL DEFAULT 0,
  uncosted_count INTEGER NOT NULL DEFAULT 0,   -- 没有采购价、算不出金额的差异条数
  counter TEXT, reviewer TEXT,
  submitted_by TEXT, submitted_at TEXT,
  adjusted_by TEXT, adjusted_at TEXT,
  note TEXT,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  demo_tag TEXT
);

CREATE TABLE IF NOT EXISTS stocktake_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  take_id INTEGER NOT NULL,
  material_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  spec TEXT,
  unit TEXT,
  book_qty REAL NOT NULL DEFAULT 0,            -- 账面（建单时快照）
  count_qty REAL,                               -- 实盘（未盘 = NULL，不等于 0）
  diff_qty REAL NOT NULL DEFAULT 0,            -- 实盘 − 账面
  price REAL,                                   -- 计价单价（最近采购价，取不到 NULL）
  diff_amount REAL,                             -- NULL = 未计价，不是 0
  reason TEXT,                                  -- 差异原因（有差异必填）
  adjusted INTEGER NOT NULL DEFAULT 0,
  remark TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_take_item ON stocktake_items(take_id, material_id);
`);

console.log('[apply-materials-ddl] 6 张表就绪：material_ledger / material_issues / material_issue_items / material_returns / material_return_items / stocktakes / stocktake_items');
