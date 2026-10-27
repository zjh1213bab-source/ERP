/**
 * 流程超时升级与任务替岗 / 岗位 SOP 与制度知识
 * 对应原型 TS-N15-04（超时升级与任务替岗）+ TS-N15-02（岗位SOP与制度知识）
 *
 * 核心口径：
 * 1. **待办可分配但不可失主**：任务永远有当前主责（原审批人 → 有效代理 → 升级接收人）
 * 2. **财务与工艺关键审批不得因超时自动通过**：超时只升级到人，绝不自动 approve
 * 3. **代理只按有效授权转交**：无有效代理 → 进升级队列，不是静默转给谁
 * 4. **提醒去重**：同一任务同一级别只提醒一次，按风险汇总，不无节制轰炸
 * 5. **保留原责任与历史**：代理/升级都记原审批人，不清空
 * 6. **SOP 旧版本可追但不默认用于当前**：只有 effective 版本算当前，retired 只读
 * 7. **每版 SOP 必须写全** 做法 / 输入 / 完成标准 / 升级路径，缺一项不许发布
 */
const { db } = require('../src/db');

const DDL = [
  // 1. 提醒去重（同一任务同一级别只发一次）
  `CREATE TABLE IF NOT EXISTS approval_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    instance_id INTEGER,
    level TEXT NOT NULL DEFAULT 'soon',        -- soon 临近 / overdue 超时 / escalate 已升级
    dedupe_key TEXT NOT NULL,
    to_role TEXT,
    to_user TEXT,
    message TEXT,
    sent_at TEXT NOT NULL,
    UNIQUE (dedupe_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_arem_task ON approval_reminders(task_id)`,

  // 2. 审批代理授权（休假/调动时按有效授权转交）
  `CREATE TABLE IF NOT EXISTS approval_delegates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,                   -- 原审批人
    to_user TEXT NOT NULL,                     -- 代理人
    target_types TEXT,                         -- cost,order,techpack,... 空=全部
    valid_from TEXT,
    valid_to TEXT,
    status TEXT NOT NULL DEFAULT 'active',     -- active / revoked / expired
    reason TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    revoke_reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_adele_from ON approval_delegates(from_user, status)`,

  // 3. 岗位 SOP / 制度文档
  `CREATE TABLE IF NOT EXISTS sop_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no TEXT UNIQUE,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'sop',      -- sop 岗位SOP / policy 制度 / rule 规定
    company TEXT,
    position TEXT,                             -- 适用岗位（空=全岗位）
    owner TEXT,                                -- 制度责任人
    status TEXT NOT NULL DEFAULT 'draft',      -- draft / pending / effective / retired
    current_version INTEGER NOT NULL DEFAULT 0,
    effective_date TEXT,
    approved_by TEXT,
    approved_at TEXT,
    retired_at TEXT,
    retire_reason TEXT,
    remark TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sop_status ON sop_documents(status, position)`,

  // 4. SOP 版本（四要素：做法/输入/完成标准/升级路径）
  `CREATE TABLE IF NOT EXISTS sop_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    doing TEXT,                                -- 做法
    inputs TEXT,                               -- 输入
    done_criteria TEXT,                        -- 完成标准
    escalate_path TEXT,                        -- 升级路径
    change_note TEXT,
    status TEXT NOT NULL DEFAULT 'draft',      -- draft / effective / retired
    created_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (doc_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sopv_doc ON sop_versions(doc_id)`,

  // 5. 岗位签收
  `CREATE TABLE IF NOT EXISTS sop_acks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    employee_id INTEGER,
    employee_name TEXT,
    position TEXT,
    acked_at TEXT,
    note TEXT,
    UNIQUE (doc_id, version, employee_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sopack_doc ON sop_acks(doc_id, version)`
];

function run() {
  DDL.forEach((s) => db.exec(s));

  // approval_tasks 扩列：时限 / 提醒 / 升级 / 代理
  const cols = db.prepare('PRAGMA table_info(approval_tasks)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE approval_tasks ADD COLUMN ${ddl}`);
  };
  const added = [];
  [
    ['due_at', 'due_at TEXT'],
    ['sla_hours', 'sla_hours REAL'],
    ['remind_count', 'remind_count INTEGER NOT NULL DEFAULT 0'],
    ['last_remind_at', 'last_remind_at TEXT'],
    ['escalate_level', 'escalate_level TEXT'],
    ['escalated_to', 'escalated_to TEXT'],
    ['escalated_at', 'escalated_at TEXT'],
    ['escalate_reason', 'escalate_reason TEXT'],
    ['original_approver', 'original_approver TEXT'],
    ['delegate_by', 'delegate_by TEXT'],
    ['received_at', 'received_at TEXT'],
    ['received_by', 'received_by TEXT']
  ].forEach(([n, d]) => { if (!cols.includes(n)) { db.exec(`ALTER TABLE approval_tasks ADD COLUMN ${d}`); added.push(n); } });

  // approval_flows 扩列：默认 SLA 小时
  const fcols = db.prepare('PRAGMA table_info(approval_flows)').all().map((c) => c.name);
  if (!fcols.includes('sla_hours')) db.exec('ALTER TABLE approval_flows ADD COLUMN sla_hours REAL DEFAULT 24');
  if (!fcols.includes('escalate_role')) db.exec('ALTER TABLE approval_flows ADD COLUMN escalate_role TEXT');

  const t = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND (name LIKE 'sop_%' OR name IN ('approval_reminders','approval_delegates'))").get().c;
  console.log(`[process] 已建 ${t} 张表；approval_tasks 扩列 ${added.length ? added.join(',') : '无'}`);
}

run();
module.exports = { DDL };
