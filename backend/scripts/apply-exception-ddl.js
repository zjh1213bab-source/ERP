/**
 * 异常协同与日清（对应原型 TS-N01-03）
 * ========================================================================
 * 系统里已经有 20 多个模块，每个模块自己都有「异常提醒」，但老板每天真正想问的是
 * 一句话：**今天有哪些事没清掉、卡在谁手里、会不会影响交货或收钱。**
 * 日清就是把散在各模块的异常汇总成一张「今日必办」，并且每条都能点回原单。
 *
 * ## 七条口径（每一条都是踩过的坑）
 *
 * 1. **日清不是「所有待办重新列一遍」**
 *    原型原话：日清只处理升级事项，不是所有任务重新审批。
 *    所以必办列表只收三类：已升级（超 SLA 没人认领）、今日新增、已过预计解决日。
 *    在 SLA 内、已有人认领在办的，进「处理中」不进必办。
 *    否则每天刷出 200 条，第三次就没人打开了。
 *
 * 2. **异常是「扫」出来的，不是「提」出来的**
 *    每条规则直接读业务表判定事实（订单超交期、缺料、设备停机…），
 *    不做人工上报 —— 人工上报靠自觉，漏报的永远是真正要命的那些。
 *
 * 3. **幂等：同一事实只占一条**
 *    唯一键 (主体, 规则, 来源类型, 来源ID, 区分键) 且只对「未关闭」生效。
 *    同一天扫 10 次也还是一条，只刷新 last_seen_at / seen_count。
 *    重跑同周期不重复派单（原型明确要求）。
 *
 * 4. **「事实消失」和「人处理完了」必须分开记**
 *    订单发货了，超期异常自然不该存在 —— 这时标 `auto_resolved`，
 *    动作流水写「由系统按事实消除」。它**不算人处理过**，
 *    所以日清统计里不并入「今日完成」，否则月底看「异常处理率」会虚高到 100%。
 *
 * 5. **数据缺失要写进覆盖率，不能当 0**
 *    有 12 张订单没填交期，不能说「超期 0 单」，要说「12 张订单无交期，未参与判定」。
 *    缺数据说明覆盖率（原型要求）。同理：某类异常暂时没有检测规则，要明说
 *    「人事类暂无自动检测规则」，不能显示 0 个异常让人误以为没问题。
 *
 * 6. **归口要落到部门，人落不到就标「待指派」**
 *    技术/缺料/质量/产能/人事/资金六类各有归口（原型要求分别归口）。
 *    责任人三级解析：条目自带（跟单员/采购员/客户负责人）→ 已指派 → 都没有就「待指派」。
 *    宁可标待指派，也不按角色随便抓一个人顶上（催收模块同一教训）。
 *
 * 7. **预警升级 ≠ 自动处罚**
 *    原型要求：缺链/超额提示要列具体原单、当前责任人、补齐路径和预计影响；
 *    采购超额、系统风险、待核费用**不自动认定员工失职，不直接扣绩效或工资**。
 *    所以本模块只写清单，不改任何业务单据状态、不碰绩效、不碰工资。
 */
const { db, now } = require('../src/db');

const t = now();

/* ---------------- 1. 规则表 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS exception_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,                    -- order_overdue / material_short ...
  name TEXT NOT NULL,
  category TEXT NOT NULL,                       -- tech / material / quality / capacity / hr / cash
  owner_dept TEXT,                              -- 归口部门（页面上显示「找谁」）
  owner_role TEXT,                              -- 归口角色（用于筛人，不用于自动指派）
  sla_hours INTEGER NOT NULL DEFAULT 24,        -- 超过多久没人认领就升级
  threshold REAL,                               -- 阈值（逾期天数 / 停留天数 / 小时）
  threshold_unit TEXT,                          -- day / hour
  severity TEXT NOT NULL DEFAULT 'warn',        -- warn / serious（serious 在必办列表置顶）
  rule_note TEXT,                               -- 判定口径（页面上要能看懂，不能只在代码里）
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
`);

/**
 * 六类归口（原型：技术、缺料、质量、产能、人事和资金分别归口）
 * category → 中文名 + 默认归口部门
 */
const CATS = [
  ['tech', '技术', '技术部'],
  ['material', '缺料', '供应链'],
  ['quality', '质量', '品控部'],
  ['capacity', '产能与交付', '生产部'],
  ['hr', '人事', '人事行政'],
  ['cash', '资金', '财务部'],
  // 审批超时不是业务异常而是流程异常，单列一类（塞进六类会误导归口判断）
  ['governance', '流程与审批', '总经办']
];

const RULES = [
  {
    code: 'order_overdue',
    name: '订单已过交期未发货',
    category: 'capacity',
    owner_dept: '生产部',
    owner_role: 'production',
    sla_hours: 24,
    threshold: 0,
    threshold_unit: 'day',
    severity: 'serious',
    rule_note: '在产订单（已分单/生产中/已入库）的交期早于今天仍未发货。没填交期的订单不参与判定，计入覆盖率。'
  },
  {
    code: 'order_stuck',
    name: '订单卡在同一状态超时',
    category: 'capacity',
    owner_dept: '总经办',
    owner_role: 'sales',
    sla_hours: 24,
    threshold: 3,
    threshold_unit: 'day',
    severity: 'warn',
    rule_note: '订单在当前状态停留超过阈值天数（默认 3 天）仍无流转。按最后一条流转记录的时间算，没有流转记录的按订单创建时间算。'
  },
  {
    code: 'tech_pack_missing',
    name: '定制单无已确认技术包就往下走',
    category: 'tech',
    owner_dept: '技术部',
    owner_role: 'tech',
    sla_hours: 12,
    threshold: 0,
    threshold_unit: 'day',
    severity: 'serious',
    rule_note: '定制单（type=custom）已进入财务审核及之后的状态，却没有任何已确认（status=confirmed）的技术包。没确认技术包就分单，等于按图纸生产 —— 版型、面料、工艺都还没定。现货单不参与判定。'
  },
  {
    code: 'material_short',
    name: '缺料影响开工',
    category: 'material',
    owner_dept: '供应链',
    owner_role: 'purchase',
    sla_hours: 24,
    threshold: 0,
    threshold_unit: 'day',
    severity: 'serious',
    rule_note: '齐套算料后净缺口大于 0 的需求行。已在途（未收货采购量）不抵扣缺口 —— 到不了货的在途不是供给。'
  },
  {
    code: 'purchase_late',
    name: '采购超承诺到货日',
    category: 'material',
    owner_dept: '供应链',
    owner_role: 'purchase',
    sla_hours: 24,
    threshold: 0,
    threshold_unit: 'day',
    severity: 'warn',
    rule_note: '采购单承诺到货日早于今天仍有未到货数量，且单据未关闭/未取消。'
  },
  {
    code: 'fa_not_released',
    name: '首件未放行但已投产',
    category: 'quality',
    owner_dept: '品控部',
    owner_role: 'tech',
    sla_hours: 12,
    threshold: 0,
    threshold_unit: 'day',
    severity: 'serious',
    rule_note: '首件确认单尚未放行（status 非 released），但该订单已有生产报工。先做后验是质量事故的源头。'
  },
  {
    code: 'qc_fail_open',
    name: '验货不合格未处置',
    category: 'quality',
    owner_dept: '品控部',
    owner_role: 'tech',
    sla_hours: 24,
    threshold: 0,
    threshold_unit: 'day',
    severity: 'serious',
    rule_note: '质检单 AQL 判定为 fail 且单据状态仍未关闭。'
  },
  {
    code: 'equipment_down',
    name: '设备停机超时未恢复',
    category: 'capacity',
    owner_dept: '生产部',
    owner_role: 'production',
    sla_hours: 24,
    threshold: 24,
    threshold_unit: 'hour',
    severity: 'warn',
    rule_note: '停机单状态不是「已恢复/已取消」，且停机开始到现在超过阈值小时（默认 24）。'
  },
  {
    code: 'ar_overdue',
    name: '应收逾期未收',
    category: 'cash',
    owner_dept: '财务部',
    owner_role: 'finance',
    sla_hours: 48,
    threshold: 1,
    threshold_unit: 'day',
    severity: 'warn',
    rule_note: '应收发票未核销金额大于 0 且逾期超过阈值天数（默认 1 天，当天到期不算逾期）。集团内部往来照样列出来，但标注为内部。'
  },
  {
    code: 'ap_overdue',
    name: '应付已过账期未付',
    category: 'cash',
    owner_dept: '财务部',
    owner_role: 'finance',
    sla_hours: 48,
    threshold: 0,
    threshold_unit: 'day',
    severity: 'warn',
    rule_note: '应付发票未付金额大于 0 且已过账期。'
  },
  {
    code: 'approval_timeout',
    name: '审批超时未处理',
    category: 'governance',
    owner_dept: '总经办',
    owner_role: 'admin',
    sla_hours: 12,
    threshold: 0,
    threshold_unit: 'hour',
    severity: 'warn',
    rule_note: '审批任务待处理且已过应处理时限。只提醒，不自动通过（超时自动通过等于没人审）。'
  }
];

const insRule = db.prepare(
  `INSERT INTO exception_rules
     (code, name, category, owner_dept, owner_role, sla_hours, threshold, threshold_unit, severity, rule_note, enabled, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)
   ON CONFLICT(code) DO NOTHING`
);
RULES.forEach((r) => {
  insRule.run(r.code, r.name, r.category, r.owner_dept, r.owner_role, r.sla_hours,
    r.threshold, r.threshold_unit, r.severity, r.rule_note, t, t);
});

// 已存在的规则不会因 DO NOTHING 更新 —— 口径调整（如审批超时从「技术」改为「流程与审批」）
// 必须显式同步，否则库里还是旧分类，页面显示和代码判断就会不一致。
db.prepare("UPDATE exception_rules SET category='governance', updated_at=? WHERE code='approval_timeout' AND category<>'governance'").run(t);
db.prepare("UPDATE exception_items SET category='governance' WHERE rule_code='approval_timeout' AND category<>'governance'").run();

/* ---------------- 2. 异常条目 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS exception_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_no TEXT UNIQUE,                          -- EX202610280001
  company_id INTEGER NOT NULL DEFAULT 1,
  rule_code TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',

  first_day TEXT NOT NULL,                      -- 首次发现日
  last_seen_at TEXT,                            -- 最后一次扫描仍存在
  seen_count INTEGER NOT NULL DEFAULT 1,

  source_type TEXT NOT NULL,                    -- order / purchase_order / ar_invoice ...
  source_id INTEGER NOT NULL,
  source_no TEXT,                               -- 原单号，列表直接显示
  biz_key TEXT NOT NULL DEFAULT '',             -- 同一原单多条异常时的区分键（如缺料用物料名）

  title TEXT NOT NULL,
  detail TEXT,
  impact_qty REAL,
  impact_amount REAL,
  impact_note TEXT,                             -- 金额口径说明；算不出就写原因，不填 0
  overdue_days INTEGER,

  owner_user_id INTEGER,
  owner_username TEXT,
  owner_name TEXT,
  owner_source TEXT,                            -- order / assign / none
  owner_dept TEXT,

  status TEXT NOT NULL DEFAULT 'open',          -- open / claimed / handling / waiting / closed / auto_resolved
  cause TEXT,                                   -- 原因（人工填）
  expect_date TEXT,                             -- 预计解决日
  result TEXT,                                  -- 处理结果
  closed_by TEXT,
  closed_at TEXT,

  auto_resolved_at TEXT,
  auto_resolve_note TEXT,

  escalated INTEGER NOT NULL DEFAULT 0,
  escalated_at TEXT,
  escalate_reason TEXT,

  review_status TEXT,                           -- null / pending / passed / rejected
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,

  note TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exc_status ON exception_items(status);
CREATE INDEX IF NOT EXISTS idx_exc_day ON exception_items(first_day);
CREATE INDEX IF NOT EXISTS idx_exc_rule ON exception_items(rule_code);
CREATE INDEX IF NOT EXISTS idx_exc_owner ON exception_items(owner_username);
CREATE INDEX IF NOT EXISTS idx_exc_source ON exception_items(source_type, source_id);
`);

// 「标为数据遗留」：历史夹具单/已确认不适用的事实，必须能一键不再提醒，
// 但要留理由与到期日（到期后又会被重新检出）—— 否则日清会堆一堆清不掉的条目，
// 最后整张表没人看。这是「可清零」的前提，不是可有可无的便利功能。
const cols = db.prepare('PRAGMA table_info(exception_items)').all().map((c) => c.name);
if (!cols.includes('ignore_until')) {
  db.exec('ALTER TABLE exception_items ADD COLUMN ignore_until TEXT');
  console.log('已加列 ignore_until（忽略到期日，空=永久）');
}
if (!cols.includes('ignore_reason')) {
  db.exec('ALTER TABLE exception_items ADD COLUMN ignore_reason TEXT');
  console.log('已加列 ignore_reason');
}

db.exec(`
-- 幂等核心：同一事实（同规则+同原单+同区分键）在「未关闭」期间只能有一条。
-- 关掉之后又复发，会生成新条目 —— 那是新的事实，不该覆盖上一次的处理记录。
-- ignored 也必须排除在外，否则「标为遗留」之后反而插不进新条目。
DROP INDEX IF EXISTS uq_exc_open;
CREATE UNIQUE INDEX IF NOT EXISTS uq_exc_open
  ON exception_items(company_id, rule_code, source_type, source_id, biz_key)
  WHERE status NOT IN ('closed','auto_resolved','ignored');
`);

/* ---------------- 3. 动作流水 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS exception_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  action TEXT NOT NULL,                         -- detect/claim/assign/note/close/reopen/review/auto_resolve/escalate
  from_status TEXT,
  to_status TEXT,
  operator TEXT,
  target TEXT,                                  -- 指派给谁
  reason TEXT,
  payload TEXT,                                 -- JSON 快照（关闭时的原因/结果/预计日）
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_excact_item ON exception_actions(item_id);
`);

/* ---------------- 4. 日清批次 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS daily_clear_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT UNIQUE,                         -- DC20261028
  company_id INTEGER NOT NULL DEFAULT 1,
  day TEXT NOT NULL,
  data_until TEXT,                              -- 数据截止时间（页面上必须显示，否则不知道数据新不新）
  scanned_rules INTEGER DEFAULT 0,
  opened INTEGER DEFAULT 0,                     -- 本次新开
  refreshed INTEGER DEFAULT 0,                  -- 仍然存在（刷新）
  auto_resolved INTEGER DEFAULT 0,              -- 由系统按事实消除
  escalated INTEGER DEFAULT 0,
  must_do INTEGER DEFAULT 0,                    -- 今日必办条数
  coverage TEXT,                                -- JSON：每条规则的扫描量/跳过量/跳过原因
  summary TEXT,                                 -- JSON：六类归口计数
  generated_by TEXT,
  generated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily ON daily_clear_batches(company_id, day);
`);

const cnt = (tb) => db.prepare(`SELECT COUNT(*) c FROM ${tb}`).get().c;
console.log(`exception_rules: ${cnt('exception_rules')} 条规则（六类归口：${CATS.length}）`);
console.log(`exception_items: ${cnt('exception_items')} 行`);
console.log(`exception_actions: ${cnt('exception_actions')} 行`);
console.log(`daily_clear_batches: ${cnt('daily_clear_batches')} 行`);
console.log('异常协同与日清 表结构就绪');
