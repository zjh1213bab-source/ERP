/**
 * 资金计划（13 周现金流）
 *
 * ## 与「经营驾驶舱」的预测有什么区别
 * 驾驶舱是**经营视角**：钱大概够不够、趋势如何，用来开会看一眼。
 * 这里是**调度视角**：这一周具体要付哪几笔、回款按几成算、最坏情况撑不撑得住，
 * 用来决定"这周先付谁"。
 *
 * 所以两边的口径必须能对上 —— 都从同一批数据算，且都走
 * `services/invoiceStatus.js` 的 `OPEN_SQL`。冒烟里有一条断言：
 * **资金计划的应付总额 = 应付台账的已开票未付**，两边不一致就炸。
 *
 * ## 四条口径
 *
 * ### 1. 情景只改收入侧，不改支出侧
 * 「乐观」不能意味着「少还钱」。欠供应商的钱不会因为我们心情好就不用还，
 * 所以三档情景里应付、工资、固定费用**完全一样**，只有应收的回收率不同。
 * 否则"乐观情景"就变成了自欺欺人。
 *
 * ### 2. 逾期应付全部排在第 1 周
 * 驾驶舱原来的做法是「逾期 30 天内下周付、超过的一个月后付」，这是在假设
 * 供应商愿意让你继续欠着。做资金计划不能这么假设：**已经逾期就随时可能被催**，
 * 必须把钱留出来。宁可计划里早付，也不能计划里假装还能拖。
 *
 * ### 3. 「已收货未开票」要算进流出
 * 这笔钱还没发票，但货已经收了，是确定要付的。按「收货日 + 供应商账期」估算到期周，
 * 明细里标「预计」。驾驶舱原来完全没算这 29 万。
 *
 * ### 4. 回款按逾期档打折，且按档摊到不同周
 * 逾期 90 天的钱下周就回来的概率很低，全压第一周会让预测看起来「下周钱就全到了」，
 * 反而误导排款。所以按档位往后摊（1/3/5/8 周）。
 */
const { db } = require('../db');
const S = require('./invoiceStatus');
const T = require('./paymentTerms');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n) || 0;

/** 应收回收率（百分比），按逾期档 */
const BASE_RATES = { current: 95, d1_30: 85, d31_60: 65, d61_90: 45, d90p: 25 };

/**
 * 三档情景
 *
 * 保守：各档打七折 —— 客户拖起来比想的更狠
 * 乐观：到期内的按 100%，逾期档也放宽（但不是 100%，逾期 90 天还能全收回来的没见过）
 */
const SCENARIOS = {
  conservative: { key: 'conservative', label: '保守', rates: { current: 65, d1_30: 55, d31_60: 40, d61_90: 25, d90p: 10 } },
  base: { key: 'base', label: '基准', rates: BASE_RATES },
  optimistic: { key: 'optimistic', label: '乐观', rates: { current: 100, d1_30: 100, d31_60: 95, d61_90: 85, d90p: 70 } }
};

const BUCKETS = [
  { key: 'current', label: '未到期', min: -100000, max: 0 },
  { key: 'd1_30', label: '逾期 1-30 天', min: 1, max: 30 },
  { key: 'd31_60', label: '逾期 31-60 天', min: 31, max: 60 },
  { key: 'd61_90', label: '逾期 61-90 天', min: 61, max: 90 },
  { key: 'd90p', label: '逾期 90 天以上', min: 91, max: 999999 }
];

function bucketOf(days) {
  return BUCKETS.find((b) => days >= b.min && days <= b.max) || BUCKETS[0];
}

function dayDiff(a, b) {
  const t1 = Date.parse(String(a || '').slice(0, 10) + 'T00:00:00');
  const t2 = Date.parse(String(b || '').slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0;
  return Math.round((t2 - t1) / 86400000);
}

function addDays(dateStr, n) {
  return T.addDays(dateStr, n);
}

/** 期初现金：总账 1002（库存现金 + 银行存款）借方净额 */
function openingCash(baseDate, companyId) {
  const sql = `SELECT COALESCE(SUM(e.debit - e.credit), 0) AS s
                 FROM gl_entries e JOIN gl_vouchers v ON v.id = e.voucher_id
                WHERE v.status = 'posted' AND e.account_code = '1002' AND v.biz_date <= ?
                ${companyId ? 'AND e.company_id = ?' : ''}`;
  const args = companyId ? [baseDate, companyId] : [baseDate];
  return r2(db.prepare(sql).get(...args).s);
}

/**
 * 单次预测
 * @param {object} opt { weeks, baseDate, company_id, scenario, collectRate }
 */
function plan(opt = {}) {
  const baseDate = String(opt.baseDate || T.todayStr()).slice(0, 10);
  const weeks = Math.min(52, Math.max(4, Number(opt.weeks) || 13));
  const cid = opt.company_id ? Number(opt.company_id) : null;
  const sc = SCENARIOS[opt.scenario] || SCENARIOS.base;
  const rates = { ...sc.rates };
  // 单点覆盖：有人只想把「未到期」的回收率调低看看
  if (Number.isFinite(Number(opt.collectRate)) && Number(opt.collectRate) > 0) {
    rates.current = Math.min(100, Number(opt.collectRate));
  }

  const opening = openingCash(baseDate, cid);

  // 周：第 1 周 = 基准日次日 ~ +7 天（基准日当天已经过去，不能算进未来）
  const weekList = [];
  for (let i = 1; i <= weeks; i++) {
    weekList.push({
      week_no: i,
      week_start: addDays(baseDate, (i - 1) * 7 + 1),
      week_end: addDays(baseDate, i * 7),
      inflows: [],
      outflows: []
    });
  }
  /** 日期 → 周下标；早于基准日的落第 1 周（已经该收/该付了） */
  const weekIndex = (dateStr) => {
    const diff = dayDiff(baseDate, dateStr);
    if (diff <= 0) return 0;
    return Math.min(Math.floor((diff - 1) / 7), weekList.length - 1);
  };
  /** 逾期应收按档往后摊：逾期越久，越不指望它早回来 */
  const SPREAD_WEEK = { d1_30: 1, d31_60: 3, d61_90: 5, d90p: 8 };

  // ---------- 流入：应收 ----------
  const arRows = db
    .prepare(
      `SELECT id, bill_no, customer_id, customer_name,
              amount - COALESCE(paid_amount,0) AS open_amount, due_date, created_at
         FROM ar_invoices
        WHERE ${S.OPEN_SQL} ${cid ? 'AND company_id = ?' : ''}`
    )
    .all(...(cid ? [cid] : []));

  let arOpen = 0;
  let arExpect = 0;
  const bucketStat = {};
  arRows.forEach((r) => {
    const open = r2(r.open_amount);
    if (open <= 0.005) return;
    arOpen = r2(arOpen + open);

    const due = String(r.due_date || r.created_at || baseDate).slice(0, 10);
    const overdueDays = dayDiff(due, baseDate);
    const b = bucketOf(overdueDays);
    const rate = num(rates[b.key]) / 100;
    const expect = r2(open * rate);
    arExpect = r2(arExpect + expect);

    bucketStat[b.key] = bucketStat[b.key] || { key: b.key, label: b.label, full: 0, expect: 0, count: 0, rate: Math.round(rate * 100) };
    bucketStat[b.key].full = r2(bucketStat[b.key].full + open);
    bucketStat[b.key].expect = r2(bucketStat[b.key].expect + expect);
    bucketStat[b.key].count += 1;

    if (expect <= 0.01) return;
    const idx = overdueDays > 0
      ? Math.min((SPREAD_WEEK[b.key] || 1), weekList.length) - 1
      : weekIndex(due);
    weekList[idx].inflows.push({
      category: 'ar_collect',
      label: '应收账款',
      name: r.customer_name,
      doc_no: r.bill_no,
      amount: expect,
      full_amount: open,
      rate: Math.round(rate * 100),
      basis: `${b.label}，${open} × ${Math.round(rate * 100)}% = ${expect}`,
      ref_count: 1
    });
  });

  // ---------- 流出：已开票应付（真实到期日） ----------
  const apRows = db
    .prepare(
      `SELECT id, bill_no, supplier_id, supplier_name,
              amount - COALESCE(paid_amount,0) AS open_amount, due_date, created_at
         FROM ap_invoices
        WHERE ${S.OPEN_SQL} ${cid ? 'AND company_id = ?' : ''}`
    )
    .all(...(cid ? [cid] : []));

  let apOpen = 0;
  apRows.forEach((r) => {
    const open = r2(r.open_amount);
    if (open <= 0.005) return;
    apOpen = r2(apOpen + open);
    const due = String(r.due_date || r.created_at || baseDate).slice(0, 10);
    const overdueDays = dayDiff(due, baseDate);
    // 逾期的全部排第 1 周（见文件头第 2 条：不假设还能拖）
    const idx = overdueDays > 0 ? 0 : weekIndex(due);
    weekList[idx].outflows.push({
      category: 'ap_pay',
      label: '应付账款',
      name: r.supplier_name,
      doc_no: r.bill_no,
      amount: open,
      overdue_days: overdueDays > 0 ? overdueDays : 0,
      basis: overdueDays > 0 ? `未付 ${open}，已逾期 ${overdueDays} 天` : `未付 ${open}，到期 ${due}`,
      ref_count: 1
    });
  });

  // ---------- 流出：已收货未开票（按预计到期日） ----------
  const pendingPos = db
    .prepare(
      `SELECT po.id, po.po_no, po.supplier_id, po.supplier, po.total_amount, po.order_date, po.expect_date,
              (SELECT MAX(receive_date) FROM goods_receipts g WHERE g.po_id = po.id) AS received_date
         FROM purchase_orders po
        WHERE po.status = 'received'
          AND NOT EXISTS (SELECT 1 FROM ap_invoices a WHERE a.purchase_id = po.id AND a.status <> 'void')
        ORDER BY po.id`
    )
    .all();

  let unbilled = 0;
  let unbilledNoDue = 0;
  pendingPos.forEach((p) => {
    const amt = r2(p.total_amount);
    if (amt <= 0.005) return;
    unbilled = r2(unbilled + amt);
    const sup = p.supplier_id ? db.prepare('SELECT term_days, payment_terms FROM suppliers WHERE id = ?').get(p.supplier_id) : null;
    const term = sup
      ? (sup.term_days !== null && sup.term_days !== undefined ? Number(sup.term_days) : (T.parseTerms(sup.payment_terms) || {}).days)
      : undefined;
    const base = String(p.received_date || p.expect_date || p.order_date || baseDate).slice(0, 10);
    if (term === undefined || term === null) {
      // 账期读不出 → 不知道什么时候付，但钱一定在。放第 1 周，宁可早留
      unbilledNoDue = r2(unbilledNoDue + amt);
      weekList[0].outflows.push({
        category: 'ap_pending',
        label: '待开票（未设账期）',
        name: p.supplier,
        doc_no: p.po_no,
        amount: amt,
        estimated: true,
        basis: `货已收 ${base}，供应商未设账期，按第 1 周预留`,
        ref_count: 1
      });
      return;
    }
    const estDue = addDays(base, term);
    const idx = weekIndex(estDue);
    weekList[idx].outflows.push({
      category: 'ap_pending',
      label: '待开票',
      name: p.supplier,
      doc_no: p.po_no,
      amount: amt,
      estimated: true,
      est_due: estDue,
      basis: `货已收 ${base} + 账期 ${term} 天 → 预计 ${estDue} 到期（票未到）`,
      ref_count: 1
    });
  });

  // ---------- 流出：工资（近 3 期月均，每月 10 日） ----------
  const payAvg = db
    .prepare(
      `SELECT COALESCE(AVG(gross_pay),0) a FROM (
         SELECT period, SUM(gross_pay) gross_pay FROM payrolls
          WHERE status <> 'cancelled' ${cid ? 'AND company_id = ?' : ''}
          GROUP BY period ORDER BY period DESC LIMIT 3)`
    )
    .get(...(cid ? [cid] : [])).a;
  const payrollMonthly = r2(payAvg);
  if (payrollMonthly > 0) {
    const horizon = addDays(baseDate, weeks * 7);
    let cursor = baseDate;
    for (let i = 0; i < 18; i++) {
      const d = new Date(String(cursor).slice(0, 10) + 'T00:00:00');
      if (Number.isNaN(d.getTime())) break;
      d.setMonth(d.getMonth() + 1, 10);
      const p2 = (x) => String(x).padStart(2, '0');
      const payDay = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      if (payDay > horizon) break;
      weekList[weekIndex(payDay)].outflows.push({
        category: 'payroll',
        label: '工资',
        name: '全员',
        doc_no: '',
        amount: payrollMonthly,
        basis: `近 3 期月均 ${payrollMonthly}，按每月 10 日发放`,
        ref_count: 1
      });
      cursor = payDay;
    }
  }

  // ---------- 流出：固定费用（预算 66xx 月均，每月 15 日） ----------
  const bud = db
    .prepare(
      `SELECT COALESCE(SUM(i.amount),0) s, COUNT(DISTINCT i.period) m
         FROM budget_items i JOIN budgets b ON b.id = i.budget_id
        WHERE b.status = 'active' AND i.account_code LIKE '66%' ${cid ? 'AND b.company_id = ?' : ''}`
    )
    .get(...(cid ? [cid] : []));
  const fixedMonthly = num(bud.m) > 0 ? r2(num(bud.s) / num(bud.m)) : 0;
  if (fixedMonthly > 0) {
    const horizon = addDays(baseDate, weeks * 7);
    let cursor = baseDate;
    for (let i = 0; i < 18; i++) {
      const d = new Date(String(cursor).slice(0, 10) + 'T00:00:00');
      if (Number.isNaN(d.getTime())) break;
      d.setMonth(d.getMonth() + 1, 15);
      const p2 = (x) => String(x).padStart(2, '0');
      const payDay = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      if (payDay > horizon) break;
      weekList[weekIndex(payDay)].outflows.push({
        category: 'fixed_cost',
        label: '固定费用',
        name: '房租/水电/办公',
        doc_no: '',
        amount: fixedMonthly,
        basis: `预算期间费用月均 ${fixedMonthly}，按月中支付`,
        ref_count: 1
      });
      cursor = payDay;
    }
  }

  // ---------- 逐周滚动 ----------
  let running = opening;
  let minCash = opening;
  let minWeek = null;          // null = 期初就是最低点
  let firstNeg = null;         // 第一次转负的周
  const out = weekList.map((w) => {
    const inflow = r2(w.inflows.reduce((a, x) => a + num(x.amount), 0));
    const outflow = r2(w.outflows.reduce((a, x) => a + num(x.amount), 0));
    const net = r2(inflow - outflow);
    const start = r2(running);
    const end = r2(start + net);
    running = end;
    if (end < minCash) { minCash = end; minWeek = w.week_no; }
    if (end < 0 && firstNeg === null) firstNeg = w.week_no;
    return {
      week_no: w.week_no,
      week_start: w.week_start,
      week_end: w.week_end,
      opening: start,
      inflow,
      outflow,
      net,
      closing: end,
      inflow_items: w.inflows,
      outflow_items: w.outflows
    };
  });

  const totalIn = r2(out.reduce((a, w) => a + w.inflow, 0));
  const totalOut = r2(out.reduce((a, w) => a + w.outflow, 0));

  return {
    base_date: baseDate,
    weeks,
    scenario: sc.key,
    scenario_label: sc.label,
    rates,
    opening_cash: opening,
    summary: {
      opening_cash: opening,
      total_inflow: totalIn,
      total_outflow: totalOut,
      net: r2(totalIn - totalOut),
      closing_cash: r2(opening + totalIn - totalOut),
      min_cash: minCash,
      min_week: minWeek,
      first_neg_week: firstNeg,
      // 最低点缺口：负数才需要补
      gap: minCash < 0 ? r2(-minCash) : 0,
      ar_open: arOpen,
      ar_expect: arExpect,
      ap_open: apOpen,
      ap_pending: unbilled,
      ap_pending_no_due: unbilledNoDue,
      payroll_monthly: payrollMonthly,
      fixed_monthly: fixedMonthly,
      // 应收里「按当前回收率收不回来」的部分 —— 这才是真正的风险敞口
      ar_at_risk: r2(arOpen - arExpect)
    },
    buckets: Object.values(bucketStat).sort((a, b) => BUCKETS.findIndex((x) => x.key === a.key) - BUCKETS.findIndex((x) => x.key === b.key)),
    weeks_detail: out
  };
}

/** 三档情景并排比较（老板看的是「最坏情况撑不撑得住」） */
function compare(opt = {}) {
  const rows = Object.keys(SCENARIOS).map((k) => {
    const p = plan({ ...opt, scenario: k });
    return {
      scenario: k,
      label: p.scenario_label,
      opening_cash: p.opening_cash,
      total_inflow: p.summary.total_inflow,
      total_outflow: p.summary.total_outflow,
      min_cash: p.summary.min_cash,
      min_week: p.summary.min_week,
      first_neg_week: p.summary.first_neg_week,
      gap: p.summary.gap,
      closing_cash: p.summary.closing_cash
    };
  });
  // 支出侧三档应该完全一致 —— 不一致说明有人给"乐观"偷偷减了支出
  const outs = new Set(rows.map((r) => r.total_outflow));
  return {
    base_date: opt.baseDate || T.todayStr(),
    weeks: Math.min(52, Math.max(4, Number(opt.weeks) || 13)),
    rows,
    outflow_consistent: outs.size === 1,
    note: '三档情景只改收入侧（应收回收率），支出侧完全一致 —— 「乐观」不能意味着「少还钱」'
  };
}

module.exports = { plan, compare, SCENARIOS, BASE_RATES, BUCKETS, openingCash };
