/**
 * 数据质量与业务勾稽（订单账 / 库存账 / 财务账 三账对齐）
 * 对应原型 TS-N16-02（数据质量与业务勾稽）
 *
 * 核心口径：
 * 1. **勾稽不是报表，是判定**：每条规则必须能给出「期望值 vs 实际值 vs 差额」，
 *    给不出差额的检查叫提醒，不叫勾稽，一律不进 error 级别。
 * 2. **账账相对，不认单边**：任何一方单独变动都算不平，必须双边都能查到凭证
 *    （订单-流水、发票-核销、成本对象-成本明细、采购-收料）。
 * 3. **自动修复只修「重算类」**：余额/汇总/状态位可由明细推导的才允许一键修；
 *    涉及单据归属、数量认定的差异只出问题单，禁止系统替人拍板。
 * 4. **修复必须留痕**：修前修后都落 dq_fixes，可回看谁在什么时候把哪个数改成了什么。
 * 5. **同一问题不重复计数**：fingerprint 唯一，跨次执行只更新 seen_cnt / last_seen_at，
 *    本次消失且原为 open 的自动转 fixed，再出现则记 recur（复发）。
 * 6. **忽略要有理由和期限**：忽略进白名单，必须写原因，可设到期日，到期自动重新生效。
 */
const { db } = require('../src/db');

const DDL = [
  // 1. 规则定义（内置规则由 services/dqRules.js 注册，这里存开关与说明）
  `CREATE TABLE IF NOT EXISTS dq_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,                    -- balance 账账对齐 / quality 数据质量
    kind TEXT NOT NULL DEFAULT 'balance',
    severity TEXT NOT NULL DEFAULT 'warn',     -- error / warn / info
    desc_text TEXT,
    suggest TEXT,                              -- 修复建议（人看的）
    fixable INTEGER NOT NULL DEFAULT 0,
    fix_key TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_no INTEGER NOT NULL DEFAULT 0,
    last_hit INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 2. 执行批次
  `CREATE TABLE IF NOT EXISTS dq_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_no TEXT UNIQUE NOT NULL,
    scope TEXT NOT NULL DEFAULT 'all',         -- all / balance / quality / 指定 code 逗号串
    trigger_by TEXT NOT NULL DEFAULT 'manual', -- manual / api / schedule
    operator TEXT,
    rule_count INTEGER NOT NULL DEFAULT 0,
    issue_count INTEGER NOT NULL DEFAULT 0,
    error_cnt INTEGER NOT NULL DEFAULT 0,
    warn_cnt INTEGER NOT NULL DEFAULT 0,
    info_cnt INTEGER NOT NULL DEFAULT 0,
    fixable_cnt INTEGER NOT NULL DEFAULT 0,
    new_cnt INTEGER NOT NULL DEFAULT 0,        -- 本次新增（上次没有）
    fixed_cnt INTEGER NOT NULL DEFAULT 0,      -- 上次有本次消失
    recur_cnt INTEGER NOT NULL DEFAULT 0,      -- 曾修复又出现
    health REAL NOT NULL DEFAULT 100,          -- 健康分 0-100
    duration_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'done',       -- running / done / failed
    note TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dqrun_time ON dq_runs(created_at)`,

  // 3. 问题明细（fingerprint 唯一，跨批次复用同一条记录）
  `CREATE TABLE IF NOT EXISTS dq_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER,
    rule_code TEXT NOT NULL,
    rule_name TEXT,
    category TEXT,
    kind TEXT,
    severity TEXT NOT NULL DEFAULT 'warn',
    entity_type TEXT,                          -- order / stock_item / ar_invoice / cost_object ...
    entity_id INTEGER,
    entity_no TEXT,
    field TEXT,
    expect_val TEXT,
    actual_val TEXT,
    diff_val REAL,
    message TEXT,
    fixable INTEGER NOT NULL DEFAULT 0,
    fix_key TEXT,
    fix_action TEXT,
    status TEXT NOT NULL DEFAULT 'open',       -- open / fixed / ignored / false_positive
    fingerprint TEXT UNIQUE NOT NULL,
    first_seen_at TEXT,
    last_seen_at TEXT,
    seen_cnt INTEGER NOT NULL DEFAULT 1,
    fixed_at TEXT,
    fixed_by TEXT,
    ignore_reason TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dqissue_run ON dq_issues(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dqissue_status ON dq_issues(status, severity)`,
  `CREATE INDEX IF NOT EXISTS idx_dqissue_rule ON dq_issues(rule_code)`,

  // 4. 修复留痕
  `CREATE TABLE IF NOT EXISTS dq_fixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER,
    issue_id INTEGER,
    fingerprint TEXT,
    fix_key TEXT,
    target TEXT,
    before_json TEXT,
    after_json TEXT,
    result TEXT NOT NULL DEFAULT 'ok',         -- ok / skip / fail
    message TEXT,
    operator TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dqfix_time ON dq_fixes(created_at)`,

  // 5. 忽略白名单（必须写理由，可设到期）
  `CREATE TABLE IF NOT EXISTS dq_ignores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT UNIQUE NOT NULL,
    rule_code TEXT,
    entity_no TEXT,
    reason TEXT NOT NULL,
    created_by TEXT,
    expire_at TEXT,
    created_at TEXT NOT NULL
  )`
];

function run() {
  DDL.forEach((s) => db.exec(s));
  const t = db
    .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE 'dq_%'")
    .get().c;
  console.log(`[dataquality] 已建 ${t} 张表`);
}

if (require.main === module) run();
module.exports = { DDL };
