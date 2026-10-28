/**
 * 办公耗材与服务采购（TS-N14-07）
 * ========================================================================
 * 现状的两个缺口
 *
 * 1. **办公耗材根本没有台账**。系统里只有 5 条 `admin_expenses`（房租/水电/办公各几笔），
 *    纯记账、没有明细、没有库存、没有申领。谁领了几支笔、打印纸还剩多少、
 *    上个月是不是刚买过 ——— 全靠行政记在脑子里或一张 Excel 上。
 * 2. **服务采购完全没有记录**（保洁、维修、快递）。这些钱每个月都在花，
 *    但系统里只有一笔「办公 2140」的汇总，说不清付给谁、验收了没有。
 *
 * ## 这一版做的四件事
 *
 * - `office_items` 办公物品档案（耗材 / 低值 / 耐用品 / 服务）
 * - `office_stock` + `office_ledger` **独立的办公仓**（不和生产材料仓、成品仓混）
 * - `office_requests` 申领单（带部门月度限额与重复领用拦截）
 * - `office_purchases` 采购单（物品 + 服务两类），验收时**一次做完三件事**：
 *   入库 / 耐用品转资产 / 生成费用
 *
 * ## 七条口径（每条都对应一种做错的方式）
 *
 * 1. **办公领用不碰生产仓**（原型原话「材料生产仓不会被办公领用误扣」）。
 *    办公耗材走自己的 `office_stock` 与 `office_ledger`，与 `stock_items`、
 *    `material_ledger` 毫无关系。共用一张库存表，早晚有人从面料库存里扣出一箱 A4 纸。
 * 2. **最低库存只提示，不自动下单**（原型原话）。低于 `min_qty` 只进缺口清单并给建议量，
 *    生成采购单必须由人点。自动补货在没人核价的项目上等于自动花钱。
 * 3. **耐用品转资产就不再当耗材费用化**（原型原话）。验收时把明细按 `durable` 分开：
 *    耐用品逐件建资产卡片，金额**不进费用**；耗材才进费用。
 *    两边都记的后果是同一台打印机在费用表和资产表里各算一次。
 * 4. **验收与费用入账同源**（原型原话）。验收单批准时自动生成一条行政支出并占用预算，
 *    不让行政再去「费用」页手工录一遍 —— 手工录必然漏，漏了月报永远对不上。
 * 5. **需求合并可控**：多张已批准的申领可以合并成一张采购单，来源单号记在
 *    `office_purchase_sources` 里；同一张申领在采购单未撤销前不许再被合并一次。
 * 6. **申领三道闸**：数量超可用库存 → 拦；同一人同一物品已有未结申领 → 拦（重复领用）；
 *    超部门月度限额 → 要写例外说明（≥6 字）才放行，并留痕。
 * 7. **服务采购按验收计费**：服务没有库存，验收通过才生成费用；没验收就不该有这笔钱。
 */
const { db, now } = require('../src/db');

const t = now();

/* ---------------- 1. 办公物品档案 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS office_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_no TEXT NOT NULL,
  company_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  spec TEXT,
  category TEXT NOT NULL DEFAULT 'stationery',   -- stationery 文具 / printing 打印耗材 / cleaning 清洁 / ppe 劳保 / electronic 电子 / furniture 家具 / service 服务
  unit TEXT NOT NULL DEFAULT '个',
  min_qty REAL NOT NULL DEFAULT 0,               -- 最低库存（只提示，不自动采购）
  durable INTEGER NOT NULL DEFAULT 0,            -- 1 = 耐用品，验收后转资产、不费用化
  asset_category TEXT,                           -- 耐用品转资产时的资产分类
  useful_years REAL,                             -- 耐用品折旧年限（建资产卡时带过去）
  monthly_limit REAL NOT NULL DEFAULT 0,         -- 每部门每月限领数量，0 = 不限
  default_supplier TEXT,
  status TEXT NOT NULL DEFAULT 'active',         -- active / inactive
  note TEXT,
  demo_tag TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_office_item_no ON office_items(item_no);
CREATE INDEX IF NOT EXISTS idx_office_item_cat ON office_items(category);
`);

/* ---------------- 2. 办公仓库存 + 收发流水 ---------------- */
// 独立于 stock_items（成品）与 material_ledger（面辅料），这是本模块最硬的一条边界
db.exec(`
CREATE TABLE IF NOT EXISTS office_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  avg_price REAL NOT NULL DEFAULT 0,             -- 移动加权，只用于估算金额，不做成本核算
  location TEXT,                                 -- 存放地点（如「行政库房 A2 层」）
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_office_stock_item ON office_stock(item_id);

CREATE TABLE IF NOT EXISTS office_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  type TEXT NOT NULL,                            -- in 采购入库 / out 领用出库 / back 退回入库 / adjust 盘点调整
  qty REAL NOT NULL,                             -- 入库为正、出库为负（统一用它算余额，省得每种类型再判断一次）
  ref_type TEXT,                                 -- purchase / request / manual
  ref_id INTEGER,
  ref_no TEXT,
  dept_id INTEGER,
  operator TEXT,
  note TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_office_ledger_item ON office_ledger(item_id);
CREATE INDEX IF NOT EXISTS idx_office_ledger_ref ON office_ledger(ref_type, ref_id);
`);

/* ---------------- 3. 申领单 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS office_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  req_no TEXT NOT NULL,
  company_id INTEGER NOT NULL DEFAULT 1,
  dept_id INTEGER,
  dept_name TEXT,
  requester TEXT NOT NULL,
  requester_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft/submitted/approved/rejected/issued/returned/closed
  purpose TEXT,
  need_date TEXT,
  exception_reason TEXT,                         -- 超部门月限额时的例外说明
  approved_by TEXT,
  approved_at TEXT,
  issued_by TEXT,
  issued_at TEXT,
  reject_reason TEXT,
  note TEXT,
  demo_tag TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_office_req_no ON office_requests(req_no);
CREATE INDEX IF NOT EXISTS idx_office_req_status ON office_requests(status);
CREATE INDEX IF NOT EXISTS idx_office_req_dept ON office_requests(dept_id);

CREATE TABLE IF NOT EXISTS office_request_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT,
  unit TEXT,
  qty_apply REAL NOT NULL DEFAULT 0,
  qty_approved REAL NOT NULL DEFAULT 0,
  qty_issued REAL NOT NULL DEFAULT 0,
  qty_returned REAL NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_office_req_item ON office_request_items(request_id);
`);

/* ---------------- 4. 采购单（物品 + 服务） ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS office_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no TEXT NOT NULL,
  company_id INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'item',             -- item 物品 / service 服务
  dept_id INTEGER,                               -- 归属部门（费用与预算占用都挂它；为空时预算执行表看不到这笔）
  supplier TEXT,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft/submitted/approved/ordered/received/closed/cancelled
  total_amount REAL NOT NULL DEFAULT 0,
  expense_amount REAL NOT NULL DEFAULT 0,        -- 验收时计入费用的金额（不含耐用品）
  asset_amount REAL NOT NULL DEFAULT 0,          -- 验收时转资产的金额
  expense_id INTEGER,                            -- 生成的那条 admin_expenses
  expected_date TEXT,
  received_by TEXT,
  received_at TEXT,
  note TEXT,
  created_by TEXT,
  demo_tag TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_office_po_no ON office_purchases(po_no);
CREATE INDEX IF NOT EXISTS idx_office_po_status ON office_purchases(status);

CREATE TABLE IF NOT EXISTS office_purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  line_type TEXT NOT NULL DEFAULT 'item',        -- item / service
  item_id INTEGER,                               -- 服务行为空
  item_name TEXT NOT NULL,
  spec TEXT,
  unit TEXT,
  qty REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  durable INTEGER NOT NULL DEFAULT 0,            -- 从档案带过来，验收时据此决定「入资产」还是「入费用」
  asset_id INTEGER,                              -- 转成的资产卡片
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_office_po_items ON office_purchase_items(purchase_id);

-- 需求合并的来源：一张采购单能合并多张申领，一张申领同时只能被一张在途采购单占用
CREATE TABLE IF NOT EXISTS office_purchase_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL,
  req_no TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_office_po_src ON office_purchase_sources(request_id, purchase_id);
CREATE INDEX IF NOT EXISTS idx_office_po_src_po ON office_purchase_sources(purchase_id);
`);

// 老库补列（本表已存在时 CREATE 不会生效）
const icols = db.prepare('PRAGMA table_info(office_items)').all().map((c) => c.name);
if (!icols.includes('demo_tag')) db.exec('ALTER TABLE office_items ADD COLUMN demo_tag TEXT');

const pcols = db.prepare('PRAGMA table_info(office_purchases)').all().map((c) => c.name);
if (!pcols.includes('dept_id')) db.exec('ALTER TABLE office_purchases ADD COLUMN dept_id INTEGER');

const n = (tb) => db.prepare(`SELECT COUNT(*) c FROM ${tb}`).get().c;
console.log(`office_items: ${n('office_items')} · office_stock: ${n('office_stock')} · office_ledger: ${n('office_ledger')}`);
console.log(`office_requests: ${n('office_requests')} · office_purchases: ${n('office_purchases')}`);
console.log('办公耗材与服务采购 表结构就绪');
