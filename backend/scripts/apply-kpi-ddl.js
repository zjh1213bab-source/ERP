/**
 * 岗位绩效指标与规则 / 个人周度绩效 / 绩效申诉 —— 建表
 * 对应原型 TS-N13-12 / TS-N13-13 / TS-N13-14
 *
 * 口径要点：
 * - 模板按「岗位族」配置，version 递增；已批准版本不改，改就出新版本
 * - 指标必须带 定义/计算口径/数据源/例外条件/扣分上限/复核人，缺一项不许提交审批
 * - 周期（周）可冻结；冻结后规则版本不再追溯影响该周期
 * - 个人绩效分 = 基准分 − 已确认扣分；建议分与待复核分不进最终分
 */
const { db } = require('../src/db');

const DDL = [
  // 1. 岗位绩效模板（按岗位族，带版本）
  `CREATE TABLE IF NOT EXISTS kpi_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_no TEXT,
    name TEXT NOT NULL,
    job_family TEXT,                          -- 岗位族：缝制/裁剪/检验/印花/仓储/业务/职能
    job_title TEXT,                           -- 具体岗位（可空，空表示整族通用）
    department_id INTEGER,
    base_score REAL NOT NULL DEFAULT 100,     -- 周期基准分
    cycle_type TEXT NOT NULL DEFAULT 'weekly',
    version INTEGER NOT NULL DEFAULT 1,
    parent_id INTEGER,                        -- 上一版本模板 id
    status TEXT NOT NULL DEFAULT 'draft',     -- draft / pending_review / approved / retired
    effective_from TEXT,
    submitted_by TEXT, submitted_at TEXT,
    approved_by TEXT, approved_at TEXT,
    review_note TEXT,
    remark TEXT,
    created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,

  // 2. 指标与规则（一项一条）
  `CREATE TABLE IF NOT EXISTS kpi_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL,
    code TEXT,
    name TEXT NOT NULL,
    category TEXT,                            -- delivery 交付 / quality 质量 / site 现场 / coop 协作 / safety 安全
    definition TEXT,                          -- 指标定义
    formula TEXT,                             -- 计算口径
    target_value REAL,                        -- 目标值
    unit TEXT,                                -- % / 次 / 件 / 单
    weight REAL NOT NULL DEFAULT 0,           -- 权重（%），合计须 100
    threshold_json TEXT,                      -- 计分阈值：{op,value,step,deduct,cap}
    data_source TEXT,                         -- production_defect / attendance_late / rework_duty / order_due / manual
    exception_note TEXT,                      -- 例外条件（批准休假/外部依赖/非本人责任…）
    cap_score REAL NOT NULL DEFAULT 0,        -- 单项扣分上限
    reviewer TEXT,                            -- 复核人（岗位/姓名）
    auto_suggest INTEGER NOT NULL DEFAULT 1,  -- 1=按数据源自动生成建议
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kr_tpl ON kpi_rules(template_id)`,

  // 3. 考核周期（周）
  `CREATE TABLE IF NOT EXISTS kpi_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_no TEXT NOT NULL UNIQUE,            -- 2026-W44
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',      -- open / frozen
    frozen_by TEXT, frozen_at TEXT,
    remark TEXT,
    created_at TEXT NOT NULL
  )`,

  // 4. 个人周度绩效
  `CREATE TABLE IF NOT EXISTS kpi_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    employee_name TEXT,
    department_id INTEGER,
    position TEXT,
    cycle_id INTEGER NOT NULL,
    cycle_no TEXT,
    template_id INTEGER,
    template_no TEXT,
    template_version INTEGER,
    base_score REAL NOT NULL DEFAULT 100,
    suggested_score REAL NOT NULL DEFAULT 0,  -- 建议扣分（不计入）
    pending_score REAL NOT NULL DEFAULT 0,    -- 待复核
    confirmed_score REAL NOT NULL DEFAULT 0,  -- 已确认扣分（计入）
    appeal_score REAL NOT NULL DEFAULT 0,     -- 申诉中（已确认但争议）
    current_score REAL,                       -- 基准 − 已确认
    provisional INTEGER NOT NULL DEFAULT 0,   -- 1=有未结申诉，分数不是最终
    item_count INTEGER NOT NULL DEFAULT 0,
    appeal_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',     -- draft / pending_review / confirmed / appealing / closed
    generated_by TEXT, generated_at TEXT,
    confirmed_by TEXT, confirmed_at TEXT,
    remark TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (employee_id, cycle_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ks_cycle ON kpi_scores(cycle_id)`,

  // 5. 扣分项（含建议分与确认分）
  `CREATE TABLE IF NOT EXISTS kpi_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    score_id INTEGER NOT NULL,
    employee_id INTEGER,
    cycle_id INTEGER,
    rule_id INTEGER,
    rule_code TEXT,
    rule_name TEXT,
    rule_snapshot TEXT,                       -- 生成时的规则快照（版本、阈值、上限）
    category TEXT,
    order_id INTEGER, order_no TEXT,
    node_id INTEGER, node_name TEXT,
    task_desc TEXT,
    target_value REAL, actual_value REAL,
    evidence TEXT, evidence_url TEXT,
    suggested_score REAL NOT NULL DEFAULT 0,  -- 系统建议扣分
    confirmed_score REAL NOT NULL DEFAULT 0,  -- 复核后生效扣分
    responsibility TEXT DEFAULT 'self',       -- self / pending / not_self
    dedupe_key TEXT,                          -- 同一事件只扣一次
    source TEXT NOT NULL DEFAULT 'auto',      -- auto / manual
    review_status TEXT NOT NULL DEFAULT 'pending', -- pending / confirmed / rejected / unconfigured
    reviewed_by TEXT, reviewed_at TEXT, review_note TEXT,
    appeal_status TEXT NOT NULL DEFAULT 'none',    -- none / appealing / upheld / adjusted / revoked
    created_at TEXT NOT NULL,
    UNIQUE (score_id, dedupe_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ki_score ON kpi_items(score_id)`,

  // 6. 申诉与独立复核
  `CREATE TABLE IF NOT EXISTS kpi_appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appeal_no TEXT,
    item_id INTEGER NOT NULL,
    score_id INTEGER,
    employee_id INTEGER, employee_name TEXT,
    cycle_id INTEGER, cycle_no TEXT,
    reason_type TEXT,                         -- task_own 任务归属 / data_error 数据错误 / external 外部依赖 / due_change 截止变更 / evidence 证据不足 / rule 规则适用
    reason TEXT,
    evidence TEXT,
    original_score REAL,
    decision TEXT NOT NULL DEFAULT 'pending', -- pending / uphold 维持 / reduce 调整 / revoke 撤销
    new_score REAL,
    reviewer TEXT, reviewer_role TEXT,
    decision_note TEXT,
    status TEXT NOT NULL DEFAULT 'submitted', -- submitted / accepted / decided / withdrawn
    submitted_at TEXT, accepted_at TEXT, decided_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ka_item ON kpi_appeals(item_id)`
];

function run() {
  DDL.forEach((s) => db.exec(s));

  // production_reports 补 employee_id（报工归属到人，绩效才能自动汇总）
  const cols = db.prepare('PRAGMA table_info(production_reports)').all().map((c) => c.name);
  if (!cols.includes('employee_id')) {
    db.exec('ALTER TABLE production_reports ADD COLUMN employee_id INTEGER');
  }

  const t = new Date().toISOString();
  const cnt = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE 'kpi_%'").get().c;
  console.log(`[kpi] 已建 ${cnt} 张表，production_reports.employee_id ${cols.includes('employee_id') ? '已存在' : '已补'}`);
  void t;
}

run();
module.exports = { DDL };
