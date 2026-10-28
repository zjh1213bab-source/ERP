/**
 * 员工自助与薪资申诉（TS-N13-10）
 * ========================================================================
 * 现状的问题：**员工什么都看不到**。
 *
 *   - 工资条只有 HR 能打（`Payslip.vue` 是 HR 视角），员工想知道这个月发多少得去问
 *   - 考勤、请假余额要 HR 查了告诉你
 *   - 有异议只能微信里说一句，谁受理、什么时候回、改不改都没记录
 *
 * 更根本的一层：**`users` 表根本没有 employee_id**。
 * 10 个登录账号（系统管理员 / 销售小王 / 李工 / 赵主管…）没有一个能对上员工档案。
 * 没有这层绑定，「员工看自己的」就无从谈起 —— 靠名字猜必然错（重名、花名、离职重入职）。
 *
 * ## 这一版做的四件事
 *
 * 1. **账号 ↔ 员工绑定**：`users.employee_id`，人事在页面上绑，未绑定明确拒绝而不猜。
 * 2. **我的汇总**：档案 / 本月考勤 / 已休假期 / 最近工资单 / 我的技能与到期 / 我的申请。
 * 3. **自助申请**：补卡、请假、资料更正 —— 走一张单，有主责、有期限、有结论。
 * 4. **薪资申诉 → 调整单**：批准**不改已付历史**，生成下一期生效的调整单。
 *
 * ## 六条口径（每条都对应一种做错的方式）
 *
 * 1. **未绑定就不给看，不按名字猜**。猜错一次就是把别人的工资发给另一个人。
 * 2. **只有 confirmed / paid 的工资单给员工看**。draft 还在核算，给员工看等于制造申诉。
 * 3. **申诉有窗口**：工资期间末起 30 天内。超窗口不是不能提，是要走线下说明 ——
 *    系统明说「已超申诉期，请联系人事」，而不是假装没这回事。
 * 4. **批准不改历史**：`payroll_adjustments` 记「下一期生效」，已发放的工资单不动。
 *    改历史会让对上个月的报表、个税、银行流水全部对不上。
 * 5. **主管只看摘要**：出勤天数、请假天数（**不含类型**，病假属敏感）、在岗状态。
 *    **不给金额、不给病假诊断** —— 原型原话。
 * 6. **本人看自己的要留痕**：自助接口直接返回明文（自己的工资自己有权看），
 *    但仍写一条 `sensitive_access_logs`（granted=1，理由「本人查看」），
 *    这样「谁在什么时候看了谁的工资」是完整的。
 */
const { db, now } = require('../src/db');

const t = now();

/* ---------------- 1. 账号绑定员工 ---------------- */

const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('employee_id')) {
  db.exec('ALTER TABLE users ADD COLUMN employee_id INTEGER');
  console.log('已加列 users.employee_id（账号 ↔ 员工档案，自助的唯一凭据）');
  // 注意：不自动按姓名匹配。库里 10 个账号没有一个能对上员工档案，
  // 自动猜只会把「销售小王」绑到「王芳」身上 —— 那是把别人的工资发错人。
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_emp ON users(employee_id)');
}

/* ---------------- 2. 自助申请（补卡 / 请假 / 资料更正 / 薪资申诉） ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS self_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT UNIQUE,                       -- SR202610280001
  employee_id INTEGER NOT NULL,
  employee_name TEXT,
  type TEXT NOT NULL,                          -- makeup 补卡 / leave 请假 / profile 资料更正 / payroll 薪资申诉
  title TEXT NOT NULL,
  reason TEXT NOT NULL,                        -- 员工自述（必填，≥5 字）
  payload TEXT,                                -- JSON：日期、时长、要改的字段、申诉的工资单 id 等
  status TEXT NOT NULL DEFAULT 'submitted',    -- submitted / reviewing / approved / rejected / withdrawn
  owner_role TEXT,                             -- 主责：hr / finance
  due_date TEXT,                               -- 处理期限（提交即定，逾期要在列表上红）
  conclusion TEXT,                             -- 人事/财务的结论（驳回也必须写）
  decided_by TEXT,
  decided_at TEXT,
  adjust_id INTEGER,                           -- 薪资申诉批准后生成的调整单
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_selfreq_emp ON self_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_selfreq_status ON self_requests(status);
`);

/* ---------------- 3. 工资调整单（批准后下一期生效，不改历史） ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adj_no TEXT UNIQUE,                          -- PA2026100001
  request_id INTEGER,
  employee_id INTEGER NOT NULL,
  employee_name TEXT,
  period TEXT NOT NULL,                        -- 生效期 YYYY-MM（下一期，不是被申诉那一期）
  item TEXT NOT NULL DEFAULT 'other',          -- base / overtime / bonus / deduction / piece_wage / other
  amount REAL NOT NULL DEFAULT 0,              -- 正=补发，负=扣回
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending 待带入 / applied 已带入工资单 / void 作废
  source_period TEXT,                          -- 原始出问题的期数（仅追溯用）
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payadj_emp ON payroll_adjustments(employee_id, period);
`);

const n = (tb) => db.prepare(`SELECT COUNT(*) c FROM ${tb}`).get().c;
const unbound = db.prepare('SELECT COUNT(*) c FROM users WHERE active = 1 AND (employee_id IS NULL OR employee_id = 0)').get().c;
console.log(`self_requests: ${n('self_requests')} 行 · payroll_adjustments: ${n('payroll_adjustments')} 行`);
console.log(`未绑定员工档案的账号：${unbound} 个 —— 这些人打开自助页会看到「请联系人事绑定」，而不是别人的数据`);
console.log('员工自助与薪资申诉 表结构就绪');
