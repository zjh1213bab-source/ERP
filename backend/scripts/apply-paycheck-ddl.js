/**
 * 薪酬计件与工资核对（TS-N13-05）
 * ========================================================================
 * 现状：计件工资已经从「已确认的核算单」带进了工资单（`payrolls.piece_wage`），
 * 但**带进去之后没人再核对过**。实际会出四种事，每一种都直接是钱：
 *
 *   1. 工资单生成后，计件核算被作废重算 → 工资单里还是旧金额（依据变了，钱没变）
 *   2. 有人手工改了 `piece_wage` 或 `base_salary`，应发/个税没跟着重算
 *   3. 调整单（补发/扣回）做了但没带进这一期 → 工人少拿或多拿
 *   4. 境外主体（USD）套了国内 5000 免征额与月度税率表 → 一张错单
 *
 * ## 两张表
 * - `payroll_check_runs`   核对批次（期间 + 公司），存汇总与口径快照
 * - `payroll_check_items`  每员工一行：计件应计 / 工资单计件 / 差额 / 勾稽结果 / 登记过的差异单
 *
 * ## 六条口径（每条都对应一种把核对做成走过场的方式）
 *
 * 1. **计件只认「已确认」的核算单**。草稿是试算、作废的是不要的，都算进去等于自己给自己加钱。
 *    同期间如果出现两个 confirmed 批次（历史数据/并发），**整批标红**，不允许挑一个先用。
 *
 * 2. **核对必须独立重算**。应发、个税、实发用 `services/payrollCalc.js` 重算一遍，
 *    和库里存的 `gross_pay / tax / net_pay` 比。若核对直接读库里的应发，
 *    那手工改过的单子永远「没问题」—— 核对就成了打印件。
 *
 * 3. **差额不自动改工资单**。核对只出结论；要动钱必须走 `payroll_adjustments`（下一期生效），
 *    且必须写原因。直接 UPDATE 工资单会让「已确认」的单子静默变形，事后没人认。
 *
 * 4. **境外主体不套国内口径**。公司本位币不是 CNY 时，状态直接标「政策待配」，
 *    只做金额展示与计件来源核对，不判断个税社保对不对 —— 默认按国内税率算就是错的。
 *
 * 5. **调整单要看「有没有带进来」**。本期生效、状态 `applied` 的 `piece_wage` 调整单
 *    必须已经体现在工资单的 piece_wage 里；`pending` 的要在核对里点名（下一期才带）。
 *    报销、借款这类钱不是工资，混在调整单里单独点名。
 *
 * 6. **离职补薪是事实，不是错误**。已离职员工本期仍发薪只做提示（可能是补发），
 *    但要在结论里写清楚原因，否则第二年审计会问「这个人怎么还在发工资」。
 *
 * ## 与成本的关系（本轮不合并）
 * `cost_sheets.labor_cost` 是报价用的**估算**人工，手工录入，不引用计件金额。
 * 所以「工资与生产成本重复」目前不成立，但两边口径不同，核对里会写一条提示：
 * 若成本单已经按实际计件填过，报工源就被用了两次，报价会虚高。不做自动合并。
 */
const { db } = require('../src/db');

db.exec(`
CREATE TABLE IF NOT EXISTS payroll_check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_no TEXT NOT NULL,                          -- HD+YYYYMMDD+序号
  period TEXT NOT NULL,                            -- 工资所属期 YYYY-MM
  company_id INTEGER,
  company_name TEXT,
  currency TEXT,                                   -- 主体本位币；非 CNY 标「政策待配」
  status TEXT NOT NULL DEFAULT 'open',             -- open 待核对 / reviewed 已核对
  items_count INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  diff_count INTEGER NOT NULL DEFAULT 0,
  policy_count INTEGER NOT NULL DEFAULT 0,
  missing_count INTEGER NOT NULL DEFAULT 0,        -- 有计件但没工资单
  piece_expected REAL NOT NULL DEFAULT 0,          -- 确认批次合计
  piece_in_payroll REAL NOT NULL DEFAULT 0,        -- 工资单计件合计
  piece_diff REAL NOT NULL DEFAULT 0,
  gross_diff_total REAL NOT NULL DEFAULT 0,
  net_diff_total REAL NOT NULL DEFAULT 0,
  payload TEXT,                                    -- 核对项快照（JSON）
  basis TEXT,                                      -- 口径与未覆盖说明
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  demo_tag TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_paycheck_no ON payroll_check_runs(check_no);
CREATE INDEX IF NOT EXISTS idx_paycheck_period ON payroll_check_runs(period, company_id);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS payroll_check_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  employee_id INTEGER,
  employee_name TEXT,
  department TEXT,
  company_id INTEGER,
  currency TEXT,
  piece_qty REAL NOT NULL DEFAULT 0,               -- 计件件数（确认批次）
  piece_expected REAL NOT NULL DEFAULT 0,          -- 计件应计（确认批次）
  piece_in_payroll REAL NOT NULL DEFAULT 0,        -- 工资单里的计件
  piece_diff REAL NOT NULL DEFAULT 0,
  base_salary REAL NOT NULL DEFAULT 0,
  overtime_pay REAL NOT NULL DEFAULT 0,
  bonus REAL NOT NULL DEFAULT 0,
  allowance REAL NOT NULL DEFAULT 0,
  deduction REAL NOT NULL DEFAULT 0,
  social_insurance REAL NOT NULL DEFAULT 0,
  tax_stored REAL NOT NULL DEFAULT 0,
  gross_stored REAL NOT NULL DEFAULT 0,
  gross_recalc REAL NOT NULL DEFAULT 0,
  net_stored REAL NOT NULL DEFAULT 0,
  net_recalc REAL NOT NULL DEFAULT 0,
  adj_piece REAL NOT NULL DEFAULT 0,               -- 本期已带入的计件调整单合计
  status TEXT NOT NULL DEFAULT 'pending',          -- pending/ok/diff/policy/missing
  issues TEXT,                                     -- JSON [{kind, msg}]
  adj_no TEXT,                                     -- 登记差异时生成的调整单号
  adj_amount REAL,                                 -- 登记的调整金额（正补发/负扣回）
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_paycheck_item_run ON payroll_check_items(run_id, status);
CREATE INDEX IF NOT EXISTS idx_paycheck_item_emp ON payroll_check_items(employee_id);
`);

console.log('薪酬计件与工资核对：2 张表 + 索引已就绪');
console.log('  payroll_check_runs 核对批次 / payroll_check_items 逐人核对');
