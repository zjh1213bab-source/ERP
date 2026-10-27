/**
 * M11 价格快照与费用池 —— 建表（幂等）
 * ============================================================
 * 缺口来源：GAP-ANALYSIS M11「价格快照发布」「费用池分摊」。
 *
 * 已有基础：
 *   `cost_objects` / `cost_entries`（成本对象与 7 层成本归集）、`cost_sheets`（核价成本单）、
 *   `production_reports.hours`（工缴工时）、`admin_expenses`（期间费用）、`price_tiers`（产品阶梯价）。
 *
 * 两个缺口分别解决什么：
 *   1) **费用池分摊**：车间水电、设备折旧、车间管理工资这些**不归某一单**的钱，
 *      现在只能靠拍脑袋加个「制造费用」数字。要按动因（工时/件数/材料额/收入）摊到订单，
 *      且**合计必须正好等于池额**（尾差不许丢），摊了要能撤。
 *   2) **价格快照发布**：出厂价现在散在 `cost_sheets.factory_price`（一单一个价）和
 *      `price_tiers`（产品阶梯价）里，**没有版本、没有生效期**。改价改的是一行记录，
 *      历史订单的价格跟着变，谁也说不清「当时按什么价卖的」。要改成「价格本」：
 *      发布即冻结，改价发新版，订单/报价按当时那一版的快照。
 *
 * 用法：node scripts/apply-pricing-ddl.js
 */
const { db } = require('../src/db');

db.exec(`
-- 1) 费用池（一个期间、一类费用、一个动因）
CREATE TABLE IF NOT EXISTS cost_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL DEFAULT 1,
  period TEXT NOT NULL,                        -- YYYY-MM：只能摊给本期有活动的成本对象
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manufacturing',  -- manufacturing 制造费用（进产品成本）
                                               -- admin 管理费用 / selling 销售费用（**不摊进产品成本**，只做经营分析口径）
  driver TEXT NOT NULL DEFAULT 'labor_hours',  -- labor_hours 工时 / qty 件数 / material_amount 材料额 / revenue 收入
  total_amount REAL NOT NULL DEFAULT 0,        -- 池内费用合计（由明细汇总，不手填）
  allocated_amount REAL NOT NULL DEFAULT 0,    -- 已分摊合计（必须 = total_amount）
  base_total REAL NOT NULL DEFAULT 0,          -- 动因基数合计（0 不许分摊）
  object_count INTEGER NOT NULL DEFAULT 0,     -- 分摊对象数
  status TEXT NOT NULL DEFAULT 'draft',        -- draft 草稿 / distributed 已分摊 / reverted 已撤销 / closed 已结账
  in_cost INTEGER NOT NULL DEFAULT 1,          -- 1 = 摊入成本对象（actual_cost），0 = 只做分析口径
  distributed_by TEXT, distributed_at TEXT,
  reverted_by TEXT, reverted_at TEXT, revert_reason TEXT,
  note TEXT,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_pool_period ON cost_pools(period, status);

-- 2) 池内费用明细（一笔一行，可手工录，也可从行政费用引入）
CREATE TABLE IF NOT EXISTS cost_pool_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id INTEGER NOT NULL,
  expense_date TEXT NOT NULL,
  category TEXT,                               -- 水电 / 折旧 / 工资 / 房租 / 快递 / 其他
  description TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,              -- 正数；负数（红冲）要写说明
  source TEXT NOT NULL DEFAULT 'manual',       -- manual / admin_expense
  ref_id INTEGER,                              -- 引用 admin_expenses.id
  note TEXT,
  created_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poolexp_pool ON cost_pool_expenses(pool_id);

-- 3) 分摊结果（一次分摊一组行；撤销时整组删）
CREATE TABLE IF NOT EXISTS cost_pool_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id INTEGER NOT NULL,
  cost_object_id INTEGER NOT NULL,
  order_id INTEGER,
  order_no TEXT,
  style_no TEXT,
  driver_base REAL NOT NULL DEFAULT 0,         -- 本对象的动因基数
  base_total REAL NOT NULL DEFAULT 0,          -- 全池基数合计（快照）
  share_ratio REAL NOT NULL DEFAULT 0,         -- 占比 %（保留 4 位）
  amount REAL NOT NULL DEFAULT 0,              -- 分摊额（尾差归基数最大的对象）
  in_cost INTEGER NOT NULL DEFAULT 1,          -- 是否已写进 cost_entries
  cost_entry_id INTEGER,                       -- 写入的 cost_entries.id（撤销时按它删）
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poolalloc_pool ON cost_pool_allocations(pool_id);
CREATE INDEX IF NOT EXISTS idx_poolalloc_obj ON cost_pool_allocations(cost_object_id);

-- 4) 价格本（版本化；同一范围同时只有一版生效）
CREATE TABLE IF NOT EXISTS price_books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'factory',       -- factory 出厂价（对客户/贸易商） / cost_plus 成本加成价
  customer_id INTEGER,                         -- 空 = 通用价（所有客户）；有值 = 该客户专价
  currency TEXT NOT NULL DEFAULT 'CNY',
  rate REAL NOT NULL DEFAULT 1,                -- 本币汇率快照（币种≠CNY 时用）
  effective_from TEXT NOT NULL,                -- 生效日期
  effective_to TEXT,                           -- 失效日期（空 = 直到下一版生效）
  item_count INTEGER NOT NULL DEFAULT 0,
  below_cost_count INTEGER NOT NULL DEFAULT 0, -- 低于成本的项数（发布必须写说明）
  status TEXT NOT NULL DEFAULT 'draft',        -- draft / published / superseded / archived
  based_on_id INTEGER,                         -- 从哪一版改的
  published_by TEXT, published_at TEXT,
  publish_note TEXT,                           -- 低于成本或有特殊定价的说明
  note TEXT,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  demo_tag TEXT
);
-- 同一公司 + 同一范围 + 同一客户，同时只能有一版 published
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricebook_published
  ON price_books(company_id, scope, IFNULL(customer_id, 0)) WHERE status = 'published';

-- 5) 价格项（款 × 尺码 × 数量档；成本与毛利在发布时快照）
CREATE TABLE IF NOT EXISTS price_book_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  style_no TEXT NOT NULL,
  style_name TEXT,
  size TEXT NOT NULL DEFAULT '',               -- 空 = 不分码（整款同价）
  min_qty INTEGER NOT NULL DEFAULT 1,
  max_qty INTEGER,                             -- NULL = 无上限
  price REAL NOT NULL DEFAULT 0,
  cost_unit REAL,                              -- 单件成本快照（取不到为 NULL，不许发布）
  cost_source TEXT,                            -- cost_object / cost_sheet / manual
  gross_margin REAL,                           -- 毛利率 % = (price - cost) / price
  below_cost INTEGER NOT NULL DEFAULT 0,       -- 1 = 售价低于成本
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_priceitem ON price_book_items(book_id, style_no, size, min_qty);
`);

console.log('[apply-pricing-ddl] 5 张表就绪：cost_pools / cost_pool_expenses / cost_pool_allocations / price_books / price_book_items');
