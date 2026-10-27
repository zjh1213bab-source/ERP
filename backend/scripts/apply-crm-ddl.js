/**
 * 销售与客户 DDL（原型 M03 剩余 5 个节点：N03-03 周期预警 / N03-04 价值排行 /
 * N03-06 客户交接 / N03-07 线索商机 / N03-09 目标提成）
 * ------------------------------------------------------------
 * 十条主表 + 一条周期变更留痕：
 *   crm_leads             线索与商机（来源、阶段、责任人、响应期限、下一次动作）
 *   crm_lead_logs         线索流转留痕（每次跟进必须写下次日期 + 证据）
 *   crm_customer_cycles   客户采购周期（最近有效采购日 / 批准周期 / 宽限）
 *   crm_cycle_logs        周期变更留痕（改周期必须留理由，不能悄悄改）
 *   crm_followups         回访记录（回访不刷新采购日）
 *   crm_handovers         客户与未结业务交接（旧主责 → 新主责 → 接收）
 *   sales_targets         销售目标版（编制 → 批准 → 生效）
 *   sales_target_items    目标明细（业务员 × 指标口径）
 *   commission_rules      提成规则（版本化，基数/阶梯由公司批准）
 *   commissions           提成单（一期一人一张，已批准只生成一笔薪酬源）
 *   commission_sources    提成来源行（防重：同一来源行只能被提成一次）
 *
 * 为什么不把「预计商机金额」放进取数口径里：
 *   原型明确「不将预计商机金额当收入」。商机金额只是一个参考值，用于排优先级；
 *   一旦让它进收入/目标/提成口径，销售就会去堆商机而不是成交。
 *   所以 est_amount 只出现在线索列表与商机漏斗里，任何汇总金额都从订单/发票/收付款取数。
 *
 * 为什么周期要单独一张表而不是加在 customers 上：
 *   一个客户可能「周期未知」「季节性」「一次性」，这三种状态和 cycle_days 的取值规则不同
 *   （未知必须留空 + 写原因 + 指定复核日，绝不能编 0 天）。塞进 customers 后，
 *   每次读客户都要判断这堆状态，且改周期没有留痕的地方。
 */
const { db } = require('../src/db');

function hasCol(t, c) {
  try {
    return db.prepare(`pragma table_info(${t})`).all().some((x) => x.name === c);
  } catch (e) {
    return false;
  }
}

/** 线索与商机 */
db.exec(`CREATE TABLE IF NOT EXISTS crm_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_no TEXT UNIQUE NOT NULL,              -- LD+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',     -- platform 平台 / referral 转介绍 / exhibition 展会 / website 官网 / import 受控导入 / manual 手工
  source_ref TEXT,                           -- 平台侧线索 ID（查重键）
  customer_id INTEGER,                       -- 匹配到的老客户（空 = 新客户）
  customer_name_raw TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  country TEXT,
  est_amount REAL,                           -- 预计商机金额：**只作参考，不进任何收入统计**
  est_currency TEXT DEFAULT 'USD',
  stage TEXT NOT NULL DEFAULT 'new',         -- new 新线索 / qualifying 需求确认 / sampling 样衣中 / won 已转订单 / lost 已丢单
  owner_user_id INTEGER,
  owner_name TEXT,
  response_due TEXT,                         -- 首次响应期限（超过即超时，可回收公海）
  first_response_at TEXT,
  next_action_date TEXT,                     -- 下一次动作日期
  next_action TEXT,
  sample_id INTEGER,                         -- 关联打样单 sample_requests.id
  order_id INTEGER,                          -- 转成的订单
  lost_reason TEXT,                          -- price/spec/delivery/sample/credit/no_budget/competitor/other
  lost_note TEXT,
  in_pool INTEGER NOT NULL DEFAULT 0,        -- 1 = 在公海（可被认领）
  pool_since TEXT,
  duplicate_of INTEGER,                      -- 疑似重复线索（只建议合并，不自动并客户）
  created_by TEXT,
  demo_tag TEXT,                             -- 演示标记单独一列（note 会被业务动作覆盖，这个坑踩过三次）
  created_at TEXT NOT NULL,
  updated_at TEXT
)`);

/** 线索流转留痕 */
db.exec(`CREATE TABLE IF NOT EXISTS crm_lead_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  action TEXT NOT NULL,                      -- create/assign/claim/follow/recycle/merge/stage/lost/win
  from_stage TEXT,
  to_stage TEXT,
  note TEXT,
  evidence TEXT,                             -- 证据（聊天记录、邮件、会议纪要、平台截图编号）
  next_date TEXT,                            -- 下一次动作日期
  operator TEXT,
  created_at TEXT NOT NULL
)`);

/** 客户采购周期 */
db.exec(`CREATE TABLE IF NOT EXISTS crm_customer_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER UNIQUE NOT NULL,       -- 一个客户一条周期
  company_id INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',    -- unknown 未知 / known 已知 / seasonal 季节客户 / oneoff 一次性
  cycle_days INTEGER,                        -- 未知时必须为 NULL，不允许填 0
  basis TEXT,                                -- manual 人工确认 / inferred 系统推断（仅建议）/ contract 合同约定
  reason TEXT,                               -- 未知/季节性时必填的原因
  owner_user_id INTEGER,
  owner_name TEXT,
  review_date TEXT,                          -- 未知/季节性的复核日
  last_purchase_date TEXT,                   -- 最近「有效采购」日（内部交易/样衣/补发不刷新）
  last_order_id INTEGER,
  next_due_date TEXT,                        -- 应购日 = 最近有效采购日 + 周期
  grace_days INTEGER NOT NULL DEFAULT 0,     -- 宽限期：**只影响是否升级，不影响是否超期**
  last_followup_at TEXT,
  updated_by TEXT,
  updated_at TEXT,
  demo_tag TEXT
)`);

/** 周期变更留痕：改周期必须有理由（原型：主管改规则留理由/版本） */
db.exec(`CREATE TABLE IF NOT EXISTS crm_cycle_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT,
  from_cycle INTEGER,
  to_cycle INTEGER,
  from_due TEXT,
  to_due TEXT,
  reason TEXT,
  operator TEXT,
  created_at TEXT NOT NULL
)`);

/** 回访记录 */
db.exec(`CREATE TABLE IF NOT EXISTS crm_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  cycle_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'cycle_due',    -- cycle_due 周期到期 / manual 主动 / winback 挽回
  due_date TEXT,
  contact_note TEXT,
  result TEXT,                               -- no_answer 未接通 / replied 已回复 / ordered 已下单 / lost_contact 失联
  next_date TEXT,
  evidence TEXT,
  order_id INTEGER,
  operator TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL
)`);

/** 客户与未结业务交接 */
db.exec(`CREATE TABLE IF NOT EXISTS crm_handovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handover_no TEXT UNIQUE NOT NULL,          -- HO+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  from_user_id INTEGER NOT NULL,
  from_name TEXT,
  to_user_id INTEGER NOT NULL,
  to_name TEXT,
  reason TEXT NOT NULL,                       -- resign 离职 / transfer 调岗 / leave 长期休假
  customer_ids TEXT,                          -- 逗号分隔的客户 id（范围）
  customer_cnt INTEGER NOT NULL DEFAULT 0,
  open_order_cnt INTEGER NOT NULL DEFAULT 0,  -- 交接时的未结订单数（快照，不随后变化）
  open_task_cnt INTEGER NOT NULL DEFAULT 0,   -- 未结跟进任务数
  status TEXT NOT NULL DEFAULT 'draft',       -- draft / pending 待接收 / received 已接收 / done 已完成 / cancelled
  accepted_by TEXT,
  accepted_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  note TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`);

/** 销售目标版 */
db.exec(`CREATE TABLE IF NOT EXISTS sales_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_no TEXT UNIQUE NOT NULL,             -- TGT+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  team TEXT,
  period TEXT NOT NULL,                       -- YYYY-MM
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',       -- draft / approved 已批准 / effective 生效 / closed
  currency TEXT NOT NULL DEFAULT 'CNY',
  approved_by TEXT,
  approved_at TEXT,
  note TEXT,
  created_by TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`);

db.exec(`CREATE TABLE IF NOT EXISTS sales_target_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL,
  user_id INTEGER,
  user_name TEXT NOT NULL,
  metric TEXT NOT NULL,                       -- amount 订单额 / revenue 确认收入 / collection 回款 / gross 毛利
  target_amount REAL NOT NULL DEFAULT 0,
  note TEXT
)`);

/** 提成规则（版本化） */
db.exec(`CREATE TABLE IF NOT EXISTS commission_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_no TEXT UNIQUE NOT NULL,               -- CR+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  base_type TEXT NOT NULL DEFAULT 'collection', -- collection 已批准回款 / revenue 确认收入 / gross 毛利
  tiers_json TEXT NOT NULL,                   -- [{"from":0,"to":100000,"rate":1.5}, ...] 百分比
  deduct_refund INTEGER NOT NULL DEFAULT 1,   -- 退款是否扣减（扣减须有来源行）
  effective_from TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',       -- draft / approved / superseded
  approved_by TEXT,
  approved_at TEXT,
  note TEXT,
  created_by TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL
)`);

/** 提成单 */
db.exec(`CREATE TABLE IF NOT EXISTS commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commission_no TEXT UNIQUE NOT NULL,         -- CM+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  period TEXT NOT NULL,                       -- YYYY-MM
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  dept_snapshot TEXT,                         -- 归属快照：员工调动不改历史归属
  manager_snapshot TEXT,
  rule_id INTEGER,
  rule_no TEXT,
  rule_snapshot TEXT,                         -- 当时用的阶梯快照（JSON）
  base_type TEXT NOT NULL DEFAULT 'collection',
  base_amount REAL NOT NULL DEFAULT 0,        -- 提成基数
  amount REAL NOT NULL DEFAULT 0,             -- 提成金额
  refund_adj REAL NOT NULL DEFAULT 0,         -- 退款调整（负数）
  bad_debt_adj REAL NOT NULL DEFAULT 0,       -- 坏账调整（负数）
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'draft',       -- draft / reviewing / rejected / approved / settled
  approved_by TEXT,
  approved_at TEXT,
  payroll_period TEXT,                        -- 引用的薪酬期间
  payroll_ref TEXT,                           -- 薪酬来源单号（只生成一笔）
  payroll_linked_at TEXT,
  note TEXT,
  created_by TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`);

/** 提成来源行（防重） */
db.exec(`CREATE TABLE IF NOT EXISTS commission_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commission_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'base',          -- base 计提前提 / adjust 调整（退款、坏账）
  source_type TEXT NOT NULL,                  -- order / ar_invoice / payment / refund / bad_debt
  source_id INTEGER NOT NULL,
  source_no TEXT,
  source_date TEXT,
  base_amount REAL NOT NULL DEFAULT 0,
  rate REAL,
  amount REAL NOT NULL DEFAULT 0,
  adjust_of INTEGER,                          -- 调整行指向被调整的来源行
  note TEXT
)`);

// 同一平台同一条线索 ID 只能进一次（查重键），网络重试/重复导入不会产生两条
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_srcref ON crm_leads(company_id, source, source_ref) WHERE source_ref IS NOT NULL AND source_ref<>''");
db.exec('CREATE INDEX IF NOT EXISTS idx_lead_stage ON crm_leads(stage, owner_user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_lead_pool ON crm_leads(in_pool, pool_since)');
db.exec('CREATE INDEX IF NOT EXISTS idx_leadlog ON crm_lead_logs(lead_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_cycle_due ON crm_customer_cycles(next_due_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_follow ON crm_followups(customer_id, created_at DESC)');

// 提成来源行防重：同一条订单/发票/收款，全公司范围内只能被计一次提成
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_source ON commission_sources(source_type, source_id) WHERE kind='base'");
// 一期一人一张「已批准/已结算」提成单，避免同一期间重复计提
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_period ON commissions(user_id, period, company_id) WHERE status IN ('approved','settled')");

// 客户归属：N03-01 要求「客户归属单独维护 + 变更日志」，这里补两列（交接时改）
if (!hasCol('customers', 'owner_user_id')) {
  db.exec('ALTER TABLE customers ADD COLUMN owner_user_id INTEGER');
  console.log('[crm-ddl] customers + owner_user_id');
}
if (!hasCol('customers', 'owner_name')) {
  db.exec('ALTER TABLE customers ADD COLUMN owner_name TEXT');
  console.log('[crm-ddl] customers + owner_name');
}

// created_by 是后补的（提成单要能判断「自己不能批自己」）
if (!hasCol('commissions', 'created_by')) {
  db.exec('ALTER TABLE commissions ADD COLUMN created_by TEXT');
  console.log('[crm-ddl] commissions + created_by');
}

console.log('[crm-ddl] done');
