/**
 * 供给批次与预订服务 DDL（原型 M23，6 个节点）
 * ------------------------------------------------------------
 *   supply_batches       供给批次（一个批次走 在产→待发→在途→实收→上架，数量分阶段守恒）
 *   supply_batch_moves   批次迁移留痕（迁移时占用关系随批次走，不新增占用）
 *   booking_requests     预订申请（申请不占量；销售确认后才按批次占量）
 *   stock_holds          现货/未来占用（临时占用有有效期与版本）
 *   booking_shortages    短装缺口（保留承诺 + 人工评估替代，不超售）
 *   sellable_projection  可售投影（商城与 ERP 读同一份，带版本与刷新时间）
 *   projection_events    投影事件（幂等键去重，重试不会重复加减）
 *
 * 为什么可售量要单独一张投影表：
 *   商城、小程序、销售确认三处都要读「现在还能卖多少」。如果三处各自现算，
 *   算出来的数会因为时间差和口径差异互相打架（客户看到能买、销售一确认说没货）。
 *   所以统一落一份投影，谁读都读这份；刷新靠 ERP 库存事件驱动，事件带幂等键。
 *
 * 为什么批次要分阶段记数量：
 *   同一批货从在产到上架，数量可以因为短装、报废、分拆而变化，但**不能凭空多出来**。
 *   分阶段存（计划/产出/待发/在途/实收/合格/上架）才能校验「数量守恒」，
 *   也才能在部分到货时拆子批、在短装时保留承诺并形成缺口。
 */
const { db } = require('../src/db');

function hasCol(t, c) {
  try {
    return db.prepare(`pragma table_info(${t})`).all().some((x) => x.name === c);
  } catch (e) {
    return false;
  }
}

/** 供给批次 */
db.exec(`CREATE TABLE IF NOT EXISTS supply_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT UNIQUE NOT NULL,             -- SB+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  owner_company_id INTEGER,                  -- 货主（与销售主体可能不同）
  warehouse TEXT NOT NULL DEFAULT 'us',      -- cn / us（现货与未来供给都落仓）
  style_no TEXT NOT NULL,
  product_name TEXT,
  color TEXT,
  size TEXT,
  sku TEXT,                                  -- 款-色-码 组合键
  source_type TEXT NOT NULL DEFAULT 'production', -- production 生产 / purchase 采购 / transfer 调拨
  source_id INTEGER,
  source_no TEXT,
  order_id INTEGER,                          -- 生产订单（若有）
  customer_id INTEGER,                       -- 专门为某客户生产的批次
  qc_grade TEXT NOT NULL DEFAULT 'A',        -- A 合格 / B 次品 / S 样衣
  intended_use TEXT NOT NULL DEFAULT 'sellable', -- sellable 可售 / sample 样衣 / defect 次品
  stage TEXT NOT NULL DEFAULT 'in_production',   -- in_production/ready_to_ship/in_transit/received_checked/on_shelf/short/closed
  qty_planned REAL NOT NULL DEFAULT 0,
  qty_produced REAL NOT NULL DEFAULT 0,
  qty_ready REAL NOT NULL DEFAULT 0,         -- 待发
  qty_in_transit REAL NOT NULL DEFAULT 0,
  qty_received REAL NOT NULL DEFAULT 0,      -- 实收（未检）
  qty_checked_ok REAL NOT NULL DEFAULT 0,    -- 实收检验合格
  qty_on_shelf REAL NOT NULL DEFAULT 0,      -- 已上架可售
  qty_short REAL NOT NULL DEFAULT 0,         -- 短装/报废
  risk_buffer REAL NOT NULL DEFAULT 0,       -- 风险缓冲（不可承诺）
  frozen_qty REAL NOT NULL DEFAULT 0,        -- 冻结（质检/争议）
  eta_date TEXT,
  eta_evidence TEXT,                         -- 预计时间的依据（排产单号 / 船期 / 提单号）
  eta_covered INTEGER NOT NULL DEFAULT 0,    -- 1 = 预计时间与数量都有证据覆盖
  parent_batch_id INTEGER,                   -- 部分到货拆出的子批指向父批
  split_qty REAL,                            -- 本子批从父批拆走的数量
  status TEXT NOT NULL DEFAULT 'active',     -- active / closed / cancelled
  note TEXT,
  created_by TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`);

/** 批次迁移留痕 */
db.exec(`CREATE TABLE IF NOT EXISTS supply_batch_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,               -- 本次迁移数量
  qty_before REAL NOT NULL DEFAULT 0,
  qty_after REAL NOT NULL DEFAULT 0,
  holds_carried INTEGER NOT NULL DEFAULT 0,  -- 随批次带走的占用条数
  operator TEXT,
  note TEXT,
  created_at TEXT NOT NULL
)`);

/** 预订申请：提交时**不占量** */
db.exec(`CREATE TABLE IF NOT EXISTS booking_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT UNIQUE NOT NULL,           -- BK+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  customer_id INTEGER,
  customer_name TEXT,
  channel TEXT NOT NULL DEFAULT 'erp',       -- erp 销售代客 / mall 客户商城 / mini 小程序
  style_no TEXT NOT NULL,
  color TEXT,
  size TEXT,
  sku TEXT,
  qty REAL NOT NULL DEFAULT 0,
  expect_date TEXT,                          -- 客户期望交期
  quote_price REAL,                          -- 报价快照（确认后不随价目表变动）
  currency TEXT DEFAULT 'CNY',
  kind TEXT NOT NULL DEFAULT 'future',       -- future 未来供给 / spot 现货
  batch_id INTEGER,                          -- 确认时锁定的供给批次
  hold_id INTEGER,                           -- 确认后生成的占用
  status TEXT NOT NULL DEFAULT 'submitted',  -- submitted / sales_confirmed / rejected / cancelled / expired / converted
  valid_until TEXT,                          -- 申请的报价有效期
  idempotency_key TEXT,                      -- 幂等键（重复提交返回同一张）
  version INTEGER NOT NULL DEFAULT 1,
  sales_user_id INTEGER,
  sales_confirmed_at TEXT,
  reject_reason TEXT,
  note TEXT,
  demo_tag TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`);

/** 占用（现货 + 未来供给都走这张表） */
db.exec(`CREATE TABLE IF NOT EXISTS stock_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_no TEXT UNIQUE NOT NULL,              -- HD+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'future',       -- spot 现货 / future 未来供给
  batch_id INTEGER,                          -- 未来供给占用必须挂批次；现货占用为空
  warehouse TEXT NOT NULL DEFAULT 'us',
  style_no TEXT NOT NULL,
  color TEXT,
  size TEXT,
  sku TEXT,
  qty REAL NOT NULL DEFAULT 0,
  qty_picked REAL NOT NULL DEFAULT 0,        -- 已拣：属于占用的子集，不再额外扣可售
  customer_id INTEGER,
  customer_name TEXT,
  request_id INTEGER,                        -- 来源预订申请
  order_id INTEGER,                          -- 转正式订单后指向订单
  status TEXT NOT NULL DEFAULT 'active',     -- active / expired / released / converted
  temporary INTEGER NOT NULL DEFAULT 1,      -- 1 = 临时占用（有有效期）
  expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  release_reason TEXT,
  released_by TEXT,
  released_at TEXT,
  converted_at TEXT,
  demo_tag TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`);

/** 短装缺口 */
db.exec(`CREATE TABLE IF NOT EXISTS booking_shortages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shortage_no TEXT UNIQUE NOT NULL,          -- SH+YYYYMMDD+序号
  batch_id INTEGER NOT NULL,
  hold_id INTEGER,
  request_id INTEGER,
  customer_id INTEGER,
  customer_name TEXT,
  sku TEXT,
  qty_short REAL NOT NULL DEFAULT 0,
  qty_committed REAL NOT NULL DEFAULT 0,     -- 原承诺数量（保留，不隐瞒）
  resolution TEXT NOT NULL DEFAULT 'open',   -- open / substitute 替代批次 / delay 延期 / cancel 取消 / written_off 客户同意短装
  substitute_batch_id INTEGER,
  decided_by TEXT,
  decided_at TEXT,
  note TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL
)`);

/** 可售投影（商城 / 销售确认 / ERP 读同一份） */
db.exec(`CREATE TABLE IF NOT EXISTS sellable_projection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse TEXT NOT NULL DEFAULT 'us',
  style_no TEXT NOT NULL,
  color TEXT,
  size TEXT,
  sku TEXT,
  on_hand REAL NOT NULL DEFAULT 0,           -- 合格已上架实物
  held_spot REAL NOT NULL DEFAULT 0,         -- 有效现货占用（含已拣）
  qty_picked REAL NOT NULL DEFAULT 0,        -- 其中已拣（仅展示，不重复扣）
  sellable REAL NOT NULL DEFAULT 0,          -- 可买量 = on_hand − held_spot
  future_available REAL NOT NULL DEFAULT 0,  -- 未来可订量（叶子批次合计）
  version INTEGER NOT NULL DEFAULT 1,
  computed_at TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  anomaly TEXT                               -- 负量等异常说明
)`);

/** 投影事件（幂等键去重） */
db.exec(`CREATE TABLE IF NOT EXISTS projection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT UNIQUE NOT NULL,            -- 幂等键：ref_type:ref_id:action
  scope_key TEXT NOT NULL,                   -- warehouse|style|color|size
  delta_on_hand REAL NOT NULL DEFAULT 0,
  delta_hold REAL NOT NULL DEFAULT 0,
  reason TEXT,
  operator TEXT,
  created_at TEXT NOT NULL
)`);

// 同一仓库同一 SKU 只有一行投影
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_proj_sku ON sellable_projection(warehouse, style_no, COALESCE(color,\'\'), COALESCE(size,\'\'))');
db.exec('CREATE INDEX IF NOT EXISTS idx_batch_stage ON supply_batches(stage, warehouse)');
db.exec('CREATE INDEX IF NOT EXISTS idx_batch_sku ON supply_batches(style_no, color, size)');
db.exec('CREATE INDEX IF NOT EXISTS idx_hold_active ON stock_holds(status, kind, expires_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_hold_sku ON stock_holds(warehouse, style_no, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_bk_status ON booking_requests(status, created_at DESC)');
// 幂等键唯一：同一个申请/同一次确认重试，不会再生成第二张单
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_bk_idem ON booking_requests(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key<>''");

console.log('[supply-ddl] done');
