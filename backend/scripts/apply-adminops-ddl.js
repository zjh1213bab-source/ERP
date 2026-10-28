/**
 * 行政运营报表（TS-N14-09）
 * ========================================================================
 * 原型要的是**固定报表**，八项指标不许自己发明口径：
 *   宿舍入住率 / 空床与维修床 / 费用及押金 / 饭卡资金对账 /
 *   资产领归与盘点 / 耗材收发结存 / 行政预算差异 / 服务超时与复验率
 *
 * 这一版只加两张表：其它数据全在既有的
 * `dorm_*`、`meal_*`、`admin_expenses`、`office_*`、`custody_*`、`assets`、`budget_*`、`repairs` 里。
 *
 * ## 为什么要快照（`admin_report_runs.snapshot`）
 * 报表最常被问的一句话是「上个月看的时候不是 68% 吗，怎么现在变了」。
 * 原因通常不是算错，而是**数据补录**（退宿单晚录两天、维修单事后补登记）。
 * 没有快照，这种问题永远说不清。所以「定版」时把八项指标与口径一起存成 JSON，
 * 之后谁看都是同一份；要看最新就再跑一次，两次并排放着对比。
 *
 * ## 为什么要差异清单（`admin_report_findings`）
 * 报表只给人看数字，没人会去核对 300 行明细。所以跑表时**同时生成差异清单**：
 *   余额与流水对不上、库存与流水对不上、维修没复验就关单、预算超了、押金该退不退……
 * 每条差异可以分派到人、写明原因、关闭或标记忽略（忽略必须写理由）。
 * 原型 flow 的「异常分派 → 复核关闭」就是这张表。
 *
 * ## 口径（八条，每条都对应一种常见错法）
 *
 * 1. **入住率 = 住用床日 / 可用床日**（原型原话），**不拿当前人数除年末床数**。
 *    那样算在「月中有人退宿 + 新装了几张床」时必然失真：分子是某个时点的人数，
 *    分母却是另一套口径的床数，两个数不同源，除出来的百分比没有意义。
 * 2. **维修床不计入可用**：床位 `status='maintenance'` 与整间维修
 *    （`dorm_rooms.status='maintenance'`）的床都扣除。只扣床位、不扣整间维修的房间，
 *    可用床日会虚高，入住率被系统性低估。
 * 3. **期内临时维修不扣床日**：床位状态没有历史区间，无法知道「3 号床 5 月 10 日至 15 日坏过」。
 *    所以可用床日按**期末状态**整期计算，并在覆盖率里列出「有维修单但没记床位号的条数」——
 *    算不准就说算不准，不偷偷补一个估计值。
 * 4. **费用只认已入账事实**（`admin_expenses`），不含预算占用。占用是承诺，不是花掉的钱；
 *    把占用额算进「实际支出」，月底永远比财务账大。
 * 5. **押金只在住统计，退住押金不自行冲抵**：押金退还必须有财务回执（`facility` 的规则），
 *    报表只把「已退住但押金未退」的笔数单列，不去改余额。
 * 6. **饭卡对账是恒等式**：个人余额合计必须等于流水 `personal_delta` 合计，
 *    补贴余额合计必须等于 `subsidy_delta` 合计。不等即有人绕过流水改了余额 ——
 *    这种情况不允许「调平」，只能走 `adjust` 并留痕。
 * 7. **耗材结存是恒等式**：`office_stock.qty` 必须等于 `office_ledger.qty` 的合计。
 *    这条在办公耗材模块里已经用流水保证，报表这里是**独立复核**，不复用模块内的余额函数，
 *    否则模块自己算错时报表也跟着错。
 * 8. **服务超时与复验率分开算**：超时看 `due_date`（未完成的用今天比），
 *    复验率看「已提交之后有没有人复验」。**提交后直接关闭**（没有 `verified_at`）
 *    是要点名的违规 —— 维修提交与复验放行必须两个人。
 *
 * ## 不做跨公司分摊
 * 费用按记录上的 `company_id` 归属，不做事后分摊。共用费用（同一笔水电两个公司受益）
 * 请在录入时按受益公司拆成两笔 —— 本报表不发明一套分摊比例，
 * 那类比例一旦进了系统就没人敢改。
 */
const { db } = require('../src/db');

db.exec(`
CREATE TABLE IF NOT EXISTS admin_report_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_no TEXT NOT NULL,
  period TEXT NOT NULL,                            -- YYYY-MM
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  days INTEGER NOT NULL,
  company_id INTEGER,                              -- 空 = 全公司
  company_name TEXT,
  snapshot TEXT NOT NULL,                          -- 八项指标 JSON（定版时冻结）
  basis TEXT,                                      -- 口径与覆盖率说明（同期一起冻结）
  finding_count INTEGER NOT NULL DEFAULT 0,
  open_count INTEGER NOT NULL DEFAULT 0,
  high_count INTEGER NOT NULL DEFAULT 0,
  generated_by TEXT,
  generated_at TEXT NOT NULL,
  note TEXT,
  demo_tag TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_run_no ON admin_report_runs(run_no);
CREATE INDEX IF NOT EXISTS idx_admin_run_period ON admin_report_runs(period, company_id);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS admin_report_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  metric TEXT NOT NULL,                            -- dorm / meal / office / asset / budget / repair / expense
  severity TEXT NOT NULL DEFAULT 'mid',            -- high / mid / low
  subject TEXT NOT NULL,                           -- 对象：房间 301 / 饭卡账户 李四 / 办公仓 打印纸
  subject_kind TEXT,                               -- room / account / item / dept / repair / stay
  expected TEXT,                                   -- 应该是什么
  actual TEXT,                                     -- 实际是什么
  diff REAL,                                       -- 差额（数字可比时给，不可比留空）
  unit TEXT,
  hint TEXT,                                       -- 系统给的推断（不是结论）
  assignee TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',             -- open / assigned / fixed / closed / ignored
  review_note TEXT,                                -- 复核结论（关闭必填）
  closed_by TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_finding_run ON admin_report_findings(run_id, status);
CREATE INDEX IF NOT EXISTS idx_admin_finding_metric ON admin_report_findings(metric, severity);
`);

console.log('行政运营报表：2 张表 + 索引已就绪');
console.log('  admin_report_runs 定版快照 / admin_report_findings 差异清单');
