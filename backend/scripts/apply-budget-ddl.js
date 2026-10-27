/**
 * 预算管理（M12）建表 + 补部门维度
 *
 * 为什么必须给分录补部门：预算按「部门 × 科目 × 月份」控制，
 * 但原来的 gl_entries 只有科目没有部门，执行数根本归不到部门头上，
 * 只能靠费用单去猜 —— 那不算预算控制。
 *
 * 5 张表：
 *   budgets            预算版本（年度，编制 → 批准 → 生效 → 关闭）
 *   budget_items       预算明细（部门 × 科目 × 月份）
 *   budget_adjustments 调整单（追加/调减/部门间调剂，审批后才生效）
 *   budget_commitments 预算占用（单据已提交但还没入账，先按住额度）
 *   budget_alerts      超预算留痕（谁在什么时候超了多少、理由是什么）
 *
 * 2 个补列：
 *   admin_expenses.department_id   费用归哪个部门
 *   gl_entries.department_id       分录归哪个部门（费用/工资类才有）
 */
const { db } = require('../src/db');

const hasCol = (t, c) => {
  try {
    return db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  } catch (e) {
    return false;
  }
};

const DDL = [
  `CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_no TEXT NOT NULL UNIQUE,               -- YS2026 / YS2026-V2
    fiscal_year INTEGER NOT NULL,
    company_id INTEGER,
    name TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',         -- draft / approved / active / closed / rejected
    total_amount REAL DEFAULT 0,
    item_count INTEGER DEFAULT 0,
    tolerance_pct REAL DEFAULT 0,                 -- 允许超出百分比（0 = 硬控）
    is_current INTEGER DEFAULT 0,                 -- 同一年只有一份生效预算
    note TEXT,
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT,
    approved_by TEXT,
    approved_at TEXT,
    reject_reason TEXT,
    closed_by TEXT,
    closed_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS budget_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_id INTEGER NOT NULL,
    department_id INTEGER,
    department_name TEXT,
    account_code TEXT NOT NULL,
    account_name TEXT,
    period TEXT NOT NULL,                          -- YYYY-MM
    amount REAL NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT,
    updated_at TEXT,
    UNIQUE(budget_id, department_id, account_code, period)
  )`,

  `CREATE TABLE IF NOT EXISTS budget_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    adj_no TEXT NOT NULL UNIQUE,                   -- TZ+日期+序号
    budget_id INTEGER NOT NULL,
    type TEXT NOT NULL,                            -- increase / decrease / transfer
    from_department_id INTEGER,
    from_account_code TEXT,
    to_department_id INTEGER,
    to_account_code TEXT,
    period TEXT NOT NULL,
    amount REAL NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',        -- pending / approved / rejected
    created_by TEXT,
    created_at TEXT,
    approved_by TEXT,
    approved_at TEXT,
    reject_reason TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS budget_commitments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_id INTEGER,
    department_id INTEGER,
    account_code TEXT,
    period TEXT,
    source_type TEXT NOT NULL,                     -- expense / payroll / purchase
    source_id INTEGER,
    source_no TEXT,
    amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',           -- open / consumed（已入账）/ released（撤回）
    note TEXT,
    created_by TEXT,
    created_at TEXT,
    settled_at TEXT,
    release_reason TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS budget_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_id INTEGER,
    department_id INTEGER,
    department_name TEXT,
    account_code TEXT,
    account_name TEXT,
    period TEXT,
    type TEXT NOT NULL,                            -- over_budget / within_tolerance / near_limit
    budget_amount REAL DEFAULT 0,
    used_amount REAL DEFAULT 0,
    over_amount REAL DEFAULT 0,
    source_type TEXT,
    source_id INTEGER,
    source_no TEXT,
    reason TEXT,
    operator TEXT,
    status TEXT DEFAULT 'open',                    -- open / acked
    acked_by TEXT,
    acked_at TEXT,
    created_at TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_buditems_lookup ON budget_items(budget_id, department_id, account_code, period)`,
  `CREATE INDEX IF NOT EXISTS idx_budcommit_open ON budget_commitments(status, period, department_id)`,
  `CREATE INDEX IF NOT EXISTS idx_budalerts_period ON budget_alerts(period, status)`
];

db.exec('BEGIN');
try {
  DDL.forEach((sql) => db.exec(sql));

  if (!hasCol('admin_expenses', 'department_id')) {
    db.exec('ALTER TABLE admin_expenses ADD COLUMN department_id INTEGER');
    console.log('[budget-ddl] admin_expenses + department_id');
  }
  if (!hasCol('admin_expenses', 'budget_reason')) {
    db.exec('ALTER TABLE admin_expenses ADD COLUMN budget_reason TEXT');
    console.log('[budget-ddl] admin_expenses + budget_reason（超预算说明）');
  }
  if (!hasCol('budgets', 'updated_at')) {
    db.exec('ALTER TABLE budgets ADD COLUMN updated_at TEXT');
    console.log('[budget-ddl] budgets + updated_at');
  }
  if (!hasCol('gl_entries', 'department_id')) {
    db.exec('ALTER TABLE gl_entries ADD COLUMN department_id INTEGER');
    console.log('[budget-ddl] gl_entries + department_id');
  }

  db.exec('COMMIT');
  const n = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE 'budget%'").get().c;
  console.log('[budget-ddl] ok, budget* 表', n, '张');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('[budget-ddl] failed:', e.message);
  process.exit(1);
}
