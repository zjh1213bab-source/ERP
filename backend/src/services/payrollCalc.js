/**
 * 工资计算口径（唯一实现）
 * ========================================================================
 * 公式本身很短，但**必须只有一份**：
 *   - `routes/payrolls.js` 用它算列表与生成工资单；
 *   - `services/payrollCheck.js`（薪酬计件与工资核对）用它重算，再和库里存的
 *     `gross_pay / tax / net_pay` 对比 —— 核对的全部意义就是「能不能算出同一个数」。
 * 两处各写一份的时候，核对永远显示「一致」，因为它用的是同一段复制代码，
 * 而不是真正的独立验算。
 *
 * 公式（与原型 TS-N13-05 一致，简化月度口径，非累计预扣）：
 *   日薪     = 基本工资 / 应出勤天数
 *   缺勤扣   = 日薪 × 缺勤天数
 *   加班费   = 日薪 / 8 × 加班小时 × 1.5
 *   应发     = 基本工资 + 加班费 + 奖金 + 补贴 + 计件工资 − 其他扣款 − 缺勤扣
 *   应纳税   = 应发 − 个人社保 − 5000
 *   个税     = 月度税率表（3%~45%，含速算扣除数）
 *   实发     = 应发 − 个人社保 − 个税
 *
 * 注意：**计件工资只从「已确认的计件核算单」带入**，本文件不负责去查计件，
 * 只负责「拿到 piece_wage 之后怎么算」。计件来源的核对在 `payrollCheck.js`。
 */
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const STATUS_LABELS = { draft: '草稿', confirmed: '已确认', paid: '已发放' };
const TAX_THRESHOLD = 5000;
const SOCIAL_RATE = 0.105; // 个人社保简化比例（可逐单覆盖）

const TAX_BRACKETS = [
  { cap: 3000, rate: 0.03, sub: 0 },
  { cap: 12000, rate: 0.10, sub: 210 },
  { cap: 25000, rate: 0.20, sub: 1410 },
  { cap: 35000, rate: 0.25, sub: 2660 },
  { cap: 55000, rate: 0.30, sub: 4410 },
  { cap: 80000, rate: 0.35, sub: 7160 },
  { cap: Infinity, rate: 0.45, sub: 15160 }
];

function calcTax(taxable) {
  if (!(taxable > 0)) return 0;
  const b = TAX_BRACKETS.find((x) => taxable <= x.cap);
  return round2(Math.max(0, taxable * b.rate - b.sub));
}

/** 当月工作日（周一至周五）天数 */
function workDaysInMonth(period) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) return 0;
  const days = new Date(y, m, 0).getDate();
  let n = 0;
  for (let d = 1; d <= days; d++) {
    const w = new Date(y, m - 1, d).getDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

function periodRange(period) {
  const [y, m] = String(period).split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { from, to };
}

/** 按已有字段重算：加班费 / 应发 / 个税 / 实发 */
function recalc(r) {
  const daily = r.work_days > 0 ? r.base_salary / r.work_days : 0;
  const absentCut = round2(daily * r.absent_days);
  const overtimePay = round2((daily / 8) * r.overtime_hours * 1.5);
  const pieceWage = round2(r.piece_wage);
  const gross = round2(
    r.base_salary + overtimePay + r.bonus + r.allowance + pieceWage - r.deduction - absentCut
  );
  const taxable = round2(gross - r.social_insurance - TAX_THRESHOLD);
  const tax = calcTax(taxable);
  const net = round2(gross - r.social_insurance - tax);
  return { daily: round2(daily), absentCut, overtimePay, gross, tax, net };
}

function withComputed(row) {
  const c = recalc(row);
  return {
    ...row,
    status_label: STATUS_LABELS[row.status] || row.status,
    daily_salary: c.daily,
    absent_cut: c.absentCut,
    tax: c.tax,
    net_pay: c.net,
    gross_pay: c.gross
  };
}

module.exports = {
  round2, STATUS_LABELS, TAX_THRESHOLD, SOCIAL_RATE, TAX_BRACKETS,
  calcTax, workDaysInMonth, periodRange, recalc, withComputed
};
