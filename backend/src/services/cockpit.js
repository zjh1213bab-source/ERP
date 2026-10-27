/**
 * 经营驾驶舱服务：账龄 / 现金预测 / 经营指标 / 预测回看
 * ------------------------------------------------------------
 * 三条口径原则（这个模块最容易做假，所以先说清楚）：
 *
 * 1. **账龄双口径**：
 *    - 账龄天数 = 基准日 − 开票日 → 「这笔钱在外面多久了」
 *    - 逾期天数 = 基准日 − 到期日 → 「该收没收多久了」
 *    老板关心的是后者，所以分档按**逾期**分；同时给平均账龄。
 *    只按开票日分档会把「账期 90 天的正常单」也标成 60 天老账，纯属误导。
 *
 * 2. **现金预测只算有依据的钱**：
 *    - 应收：已有发票的未收部分，按到期日归周；**逾期按分档打折**（不是全额等到）
 *    - 应付：已有发票的未付部分，按到期日归周；逾期的不打折（欠钱一定要还）
 *    - 工资、固定费用：按历史月均刚性支出
 *    - **不预测还没签的订单** —— 那是画饼，不是现金流
 *
 * 3. **预测必须能回看**：每次跑留快照，`forecastVariance()` 对比「当时预测这周收多少 vs 实际收多少」。
 *    不留快照就永远不知道预测准不准，也就没法校正回款假设。
 */
const { db } = require('../db');
const { localNow, localDate, addHours } = require('./sla');
const G = require('./gl');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const AGING_BUCKETS = [
  { key: 'current', label: '未到期', min: -99999, max: -1 },
  { key: 'd1_30', label: '逾期 1-30 天', min: 0, max: 30 },
  { key: 'd31_60', label: '逾期 31-60 天', min: 31, max: 60 },
  { key: 'd61_90', label: '逾期 61-90 天', min: 61, max: 90 },
  { key: 'd90p', label: '逾期 90 天以上', min: 91, max: 999999 }
];

/** 逾期默认回收率：逾得越久越难收，这是行业经验值，可按客户调 */
const DEFAULT_OVERDUE_RATES = { current: 95, d1_30: 85, d31_60: 65, d61_90: 45, d90p: 25 };

/** ==================== 日期工具 ==================== */
function toDate(s) {
  const str = String(s || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr, n) {
  const d = toDate(dateStr) || new Date();
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
function daysBetween(from, to) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return 0;
  return Math.round((b - a) / 86400000);
}

function bucketOf(overdueDays) {
  const d = Number(overdueDays);
  return AGING_BUCKETS.find((b) => d >= b.min && d <= b.max) || AGING_BUCKETS[0];
}

/** ==================== 账龄 ==================== */

/**
 * 账龄分析
 * @param {string} kind 'ar' | 'ap'
 * @param {object} opt { asOf, company_id }
 */
function aging(kind, opt = {}) {
  const asOf = String(opt.asOf || localDate()).slice(0, 10);
  const isAr = kind === 'ar';
  const table = isAr ? 'ar_invoices' : 'ap_invoices';
  const partyField = isAr ? 'customer_name' : 'supplier_name';
  const partyIdField = isAr ? 'customer_id' : 'supplier_id';

  const wh = ["status<>'void'", 'amount - COALESCE(paid_amount,0) > 0.005'];
  const args = [];
  if (opt.company_id) { wh.push('company_id=?'); args.push(Number(opt.company_id)); }

  /**
   * 默认剔除集团内部往来。
   * 义乌「应收美国子公司 80 万」在合并层面根本不算外部应收，把它算进对外账龄，
   * 逾期占比会被内部往来抬高（演示数据里一度到 83.7%），对外催款时完全误导。
   */
  const excludeIc = opt.exclude_ic !== false;
  let icNames = [];
  if (excludeIc) {
    const icWh = ["status='active'"];
    const icArgs = [];
    if (opt.company_id) { icWh.push('company_id=?'); icArgs.push(Number(opt.company_id)); }
    icNames = db.prepare(`SELECT ref_name, match_key FROM intercompany_parties WHERE ${icWh.join(' AND ')}`)
      .all(...icArgs)
      .flatMap((p) => [String(p.ref_name || ''), String(p.match_key || '')])
      .filter(Boolean);
  }

  const rawRows = db.prepare(
    `SELECT id, bill_no, company_id, ${partyField} AS party_name, ${partyIdField} AS party_id,
       amount, COALESCE(paid_amount,0) AS paid_amount,
       (amount - COALESCE(paid_amount,0)) AS open_amount,
       created_at, due_date, currency
     FROM ${table} WHERE ${wh.join(' AND ')} ORDER BY due_date, id`
  ).all(...args);

  const icRows = [];
  const rows = rawRows.filter((r) => {
    const hit = icNames.length && icNames.some((n) => String(r.party_name || '').includes(n));
    if (hit) { icRows.push(r); return false; }
    return true;
  }).map((r) => {
    const billDate = String(r.created_at || '').slice(0, 10);
    const dueDate = String(r.due_date || billDate).slice(0, 10);
    const overdueDays = daysBetween(dueDate, asOf);
    const ageDays = daysBetween(billDate, asOf);
    const b = bucketOf(overdueDays);
    return {
      ...r,
      bill_date: billDate,
      due_date: dueDate,
      overdue_days: overdueDays,
      age_days: ageDays,
      bucket: b.key,
      bucket_label: b.label,
      is_overdue: overdueDays > 0
    };
  });

  const total = r2(rows.reduce((a, r) => a + num(r.open_amount), 0));
  const buckets = AGING_BUCKETS.map((b) => {
    const list = rows.filter((r) => r.bucket === b.key);
    const amt = r2(list.reduce((a, r) => a + num(r.open_amount), 0));
    return {
      key: b.key, label: b.label,
      count: list.length, amount: amt,
      pct: total > 0 ? Math.round((amt / total) * 1000) / 10 : 0
    };
  });

  // 按客户/供应商汇总（找大户催款用）
  const byParty = {};
  rows.forEach((r) => {
    const k = r.party_name || '(未填对方)';
    if (!byParty[k]) byParty[k] = { name: k, party_id: r.party_id, amount: 0, count: 0, max_overdue: 0, oldest_due: r.due_date };
    byParty[k].amount = r2(byParty[k].amount + num(r.open_amount));
    byParty[k].count += 1;
    byParty[k].max_overdue = Math.max(byParty[k].max_overdue, r.overdue_days);
    if (String(r.due_date) < String(byParty[k].oldest_due)) byParty[k].oldest_due = r.due_date;
  });
  const parties = Object.values(byParty).sort((a, b) => b.amount - a.amount).map((p) => ({
    ...p,
    pct: total > 0 ? Math.round((p.amount / total) * 1000) / 10 : 0
  }));

  const overdueAmount = r2(rows.filter((r) => r.is_overdue).reduce((a, r) => a + num(r.open_amount), 0));
  const weightedAge = total > 0
    ? Math.round(rows.reduce((a, r) => a + num(r.age_days) * num(r.open_amount), 0) / total)
    : 0;
  const weightedOverdue = total > 0
    ? Math.round(rows.reduce((a, r) => a + num(r.overdue_days) * num(r.open_amount), 0) / total)
    : 0;

  const icTotal = r2(icRows.reduce((a, r) => a + num(r.amount - num(r.paid_amount)), 0));

  return {
    kind, as_of: asOf, company_id: opt.company_id ? Number(opt.company_id) : null,
    exclude_ic: excludeIc,
    ic_excluded_count: icRows.length,
    ic_excluded_amount: icTotal,
    total, count: rows.length,
    overdue_amount: overdueAmount,
    overdue_pct: total > 0 ? Math.round((overdueAmount / total) * 1000) / 10 : 0,
    avg_age_days: weightedAge,
    avg_overdue_days: weightedOverdue,
    buckets, parties, rows
  };
}

/** ==================== 现金预测 ==================== */

/**
 * 13 周现金预测
 * @param {object} opt { base_date, weeks, company_id, collect_rate, overdue_rates }
 */
function buildForecast(opt = {}, operator) {
  const baseDate = String(opt.base_date || localDate()).slice(0, 10);
  const weeks = Math.min(52, Math.max(4, Number(opt.weeks) || 13));
  const cid = opt.company_id ? Number(opt.company_id) : null;
  const collectRate = Number.isFinite(Number(opt.collect_rate)) ? Number(opt.collect_rate) : 90;
  const rates = Object.assign({}, DEFAULT_OVERDUE_RATES, opt.overdue_rates || {});
  rates.current = collectRate;

  // 期初现金：总账 1002 余额（截至基准日）
  const cashRow = db.prepare(
    `SELECT COALESCE(SUM(e.debit-e.credit),0) s FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
     WHERE v.status='posted' AND e.account_code='1002' AND v.biz_date<=? ${cid ? 'AND e.company_id=?' : ''}`
  ).get(...(cid ? [baseDate, cid] : [baseDate]));
  const openingCash = r2(num(cashRow.s));

  // 周区间
  const weekList = [];
  for (let i = 1; i <= weeks; i++) {
    const start = addDays(baseDate, (i - 1) * 7 + 1);
    const end = addDays(baseDate, i * 7);
    weekList.push({ week_no: i, week_start: start, week_end: end, inflows: [], outflows: [] });
  }
  /**
   * 逾期档位 → 预计第几周到账
   * 为什么不能全塞第 1 周：逾期 90 天的钱下周就回来的概率很低，
   * 全压第一周会让预测看起来「下周钱就全到了」，反而误导排款决策。
   */
  const BUCKET_WEEK = { d1_30: 1, d31_60: 3, d61_90: 5, d90p: 8 };
  const weekOf = (dateStr, bucketKey) => {
    const diff = daysBetween(baseDate, dateStr);
    // 逾期：按档位往后摊
    if (diff <= 0 && bucketKey && BUCKET_WEEK[bucketKey]) {
      return weekList[Math.min(BUCKET_WEEK[bucketKey], weekList.length) - 1];
    }
    if (diff <= 0) return weekList[0];
    const idx = Math.floor((diff - 1) / 7);
    return weekList[Math.min(idx, weekList.length - 1)];
  };

  // ---- 流入：应收 ----
  const arWh = ["status<>'void'", 'amount - COALESCE(paid_amount,0) > 0.005'];
  const arArgs = [];
  if (cid) { arWh.push('company_id=?'); arArgs.push(cid); }
  const arRows = db.prepare(
    `SELECT id, bill_no, customer_name, amount - COALESCE(paid_amount,0) AS open_amount, due_date, created_at
     FROM ar_invoices WHERE ${arWh.join(' AND ')}`
  ).all(...arArgs);

  let arOpen = 0;
  const arByBucket = {};
  arRows.forEach((r) => {
    const due = String(r.due_date || r.created_at || baseDate).slice(0, 10);
    const overdue = daysBetween(due, baseDate);
    const b = bucketOf(overdue);
    const rate = num(rates[b.key]) / 100;
    const expect = r2(num(r.open_amount) * rate);
    arOpen = r2(arOpen + num(r.open_amount));
    arByBucket[b.key] = arByBucket[b.key] || { rate, expect: 0, count: 0, full: 0 };
    arByBucket[b.key].expect = r2(arByBucket[b.key].expect + expect);
    arByBucket[b.key].full = r2(arByBucket[b.key].full + num(r.open_amount));
    arByBucket[b.key].count += 1;
    if (expect <= 0.01) return;
    weekOf(due, b.key).inflows.push({
      category: 'ar_collect', amount: expect,
      basis: `${r.bill_no} 未收 ${r2(r.open_amount)}，${b.label}按 ${Math.round(rate * 100)}% 计 ${expect}`,
      ref_count: 1
    });
  });

  // ---- 流出：应付（不打折，欠钱一定要还）----
  const apWh = ["status<>'void'", 'amount - COALESCE(paid_amount,0) > 0.005'];
  const apArgs = [];
  if (cid) { apWh.push('company_id=?'); apArgs.push(cid); }
  const apRows = db.prepare(
    `SELECT id, bill_no, supplier_name, amount - COALESCE(paid_amount,0) AS open_amount, due_date, created_at
     FROM ap_invoices WHERE ${apWh.join(' AND ')}`
  ).all(...apArgs);

  let apOpen = 0;
  apRows.forEach((r) => {
    const due = String(r.due_date || r.created_at || baseDate).slice(0, 10);
    const amt = r2(num(r.open_amount));
    if (amt <= 0.01) return;
    apOpen = r2(apOpen + amt);
    const overdueAp = daysBetween(due, baseDate);
    // 逾期应付：分两档（30 天内下周付、超过的一个月内付），不假设「一直拖着」
    const apWeek = overdueAp <= 0 ? null : (overdueAp <= 30 ? 1 : 3);
    const w = apWeek ? weekList[Math.min(apWeek, weekList.length) - 1] : weekOf(due, null);
    w.outflows.push({
      category: 'ap_pay', amount: amt,
      basis: `${r.bill_no} 未付 ${amt}（到期 ${due}）`, ref_count: 1
    });
  });

  // ---- 流出：工资（按历史月均，每月 10 日发）----
  const payWh = ["status<>'cancelled'"];
  const payArgs = [];
  if (cid) { payWh.push('company_id=?'); payArgs.push(cid); }
  const payAvg = db.prepare(
    `SELECT COALESCE(AVG(gross_pay),0) a FROM (
       SELECT period, SUM(gross_pay) gross_pay FROM payrolls
       WHERE ${payWh.join(' AND ')} GROUP BY period ORDER BY period DESC LIMIT 3)`
  ).get(...payArgs).a;
  const payrollMonthly = r2(num(payAvg));
  if (payrollMonthly > 0) {
    // 落在预测区间内的每个「10 日」都排一笔
    let cursor = baseDate;
    for (let i = 0; i < 6; i++) {
      const d = toDate(cursor);
      d.setMonth(d.getMonth() + 1, 10);
      const payDay = fmtDate(d);
      if (daysBetween(baseDate, payDay) > weeks * 7) break;
      weekOf(payDay).outflows.push({
        category: 'payroll', amount: payrollMonthly,
        basis: `近 3 个月工资月均 ${payrollMonthly}，按每月 10 日发放`, ref_count: 1
      });
      cursor = payDay;
    }
  }

  // ---- 流出：固定费用（按预算里期间费用的月均）----
  const budWh = ["b.status='active'", "i.account_code LIKE '66%'"];
  const budArgs = [];
  if (cid) { budWh.push('b.company_id=?'); budArgs.push(cid); }
  const budRow = db.prepare(
    `SELECT COALESCE(SUM(i.amount),0) s, COUNT(DISTINCT i.period) m FROM budget_items i
     JOIN budgets b ON b.id=i.budget_id WHERE ${budWh.join(' AND ')}`
  ).get(...budArgs);
  const fixedMonthly = num(budRow.m) > 0 ? r2(num(budRow.s) / num(budRow.m)) : 0;
  if (fixedMonthly > 0) {
    let cursor = baseDate;
    for (let i = 0; i < 6; i++) {
      const d = toDate(cursor);
      d.setMonth(d.getMonth() + 1, 15);
      const payDay = fmtDate(d);
      if (daysBetween(baseDate, payDay) > weeks * 7) break;
      weekOf(payDay).outflows.push({
        category: 'fixed_cost', amount: fixedMonthly,
        basis: `预算期间费用月均 ${fixedMonthly}（房租水电办公等），按月中支付`, ref_count: 1
      });
      cursor = payDay;
    }
  }

  // ---- 汇总 ----
  let running = openingCash;
  let minCash = openingCash;
  let minWeek = null;   // null = 期初就是最低点
  let firstNegWeek = null;   // 首次余额转负的周（老板真正关心的「哪周断」）
  let touchedLow = false;
  const outWeeks = weekList.map((w) => {
    const inflow = r2(w.inflows.reduce((a, x) => a + num(x.amount), 0));
    const outflow = r2(w.outflows.reduce((a, x) => a + num(x.amount), 0));
    running = r2(running + inflow - outflow);
    if (running < minCash - 0.01) { minCash = running; minWeek = w.week_no; touchedLow = true; }
    if (firstNegWeek === null && running < -0.01) firstNegWeek = w.week_no;
    return {
      week_no: w.week_no, week_start: w.week_start, week_end: w.week_end,
      inflow, outflow, net: r2(inflow - outflow), closing: running,
      inflow_items: w.inflows, outflow_items: w.outflows
    };
  });

  const inflowTotal = r2(outWeeks.reduce((a, w) => a + w.inflow, 0));
  const outflowTotal = r2(outWeeks.reduce((a, w) => a + w.outflow, 0));
  const gap = minCash < 0 ? r2(-minCash) : 0;

  const t = localNow();
  const ymd = baseDate.replace(/-/g, '');
  let seq = 1;
  let no = '';
  do {
    no = `XJ${ymd}${String(seq).padStart(3, '0')}`;
    seq += 1;
  } while (db.prepare('SELECT id FROM cash_forecasts WHERE forecast_no=?').get(no));

  db.exec('BEGIN');
  let fid;
  try {
    fid = db.prepare(
      `INSERT INTO cash_forecasts (forecast_no,company_id,base_date,weeks,opening_cash,inflow_total,outflow_total,
         closing_cash,min_cash,min_week,first_neg_week,gap_amount,ar_open,ap_open,collect_rate,overdue_rates,note,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(no, cid, baseDate, weeks, openingCash, inflowTotal, outflowTotal, running, minCash, minWeek, firstNegWeek, gap,
      arOpen, apOpen, collectRate, JSON.stringify(rates),
      opt.note || null, operator || 'system', t).lastInsertRowid;

    const ins = db.prepare(
      `INSERT INTO cash_forecast_items (forecast_id,week_no,week_start,week_end,direction,category,amount,basis,ref_count)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    outWeeks.forEach((w) => {
      // 同类合并，避免一周几十条明细刷屏
      const merge = (list, dir) => {
        const m = {};
        list.forEach((x) => {
          const k = x.category;
          if (!m[k]) m[k] = { category: k, amount: 0, basis: [], ref_count: 0 };
          m[k].amount = r2(m[k].amount + num(x.amount));
          m[k].ref_count += x.ref_count || 1;
          if (m[k].basis.length < 3) m[k].basis.push(x.basis);
        });
        Object.values(m).forEach((x) => {
          ins.run(fid, w.week_no, w.week_start, w.week_end, dir, x.category, x.amount,
            x.basis.join('；') + (x.ref_count > x.basis.length ? `；等 ${x.ref_count} 笔` : ''), x.ref_count);
        });
      };
      merge(w.inflow_items, 'in');
      merge(w.outflow_items, 'out');
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    id: fid, forecast_no: no, base_date: baseDate, weeks, company_id: cid,
    opening_cash: openingCash, inflow_total: inflowTotal, outflow_total: outflowTotal,
    closing_cash: r2(running), min_cash: minCash, min_week: minWeek,
    first_neg_week: firstNegWeek, gap_amount: gap,
    ar_open: arOpen, ap_open: apOpen,
    collect_rate: collectRate, overdue_rates: rates,
    ar_by_bucket: arByBucket,
    first_neg_week: firstNegWeek,
    weeks_detail: outWeeks.map((w) => ({
      week_no: w.week_no, week_start: w.week_start, week_end: w.week_end,
      inflow: w.inflow, outflow: w.outflow, net: w.net, closing: w.closing,
      is_negative: w.closing < -0.01,
      inflow_items: w.inflow_items.map((x) => ({ category: x.category, amount: x.amount, basis: x.basis })),
      outflow_items: w.outflow_items.map((x) => ({ category: x.category, amount: x.amount, basis: x.basis }))
    })),
    has_payroll: payrollMonthly > 0, payroll_monthly: payrollMonthly,
    fixed_monthly: fixedMonthly
  };
}

/** 预测详情 */
function getForecast(id) {
  const f = db.prepare('SELECT * FROM cash_forecasts WHERE id=?').get(Number(id));
  if (!f) return null;
  const items = db.prepare('SELECT * FROM cash_forecast_items WHERE forecast_id=? ORDER BY week_no, direction').all(f.id);
  const weeks = [];
  // 逐周余额要在这里重算：明细表只存流入流出，不存余额（余额是推导值，存了反而可能和明细对不上）
  let running = num(f.opening_cash);
  for (let i = 1; i <= f.weeks; i++) {
    const wi = items.filter((x) => x.week_no === i);
    const inflow = r2(wi.filter((x) => x.direction === 'in').reduce((a, x) => a + num(x.amount), 0));
    const outflow = r2(wi.filter((x) => x.direction === 'out').reduce((a, x) => a + num(x.amount), 0));
    running = r2(running + inflow - outflow);
    // 周区间从 base_date 推算：某周没有任何现金流时明细表里没有记录，
    // 靠 first.week_start 会得到 null，表格上就会空出一段看着像数据缺失
    weeks.push({
      week_no: i,
      week_start: addDays(f.base_date, (i - 1) * 7 + 1),
      week_end: addDays(f.base_date, i * 7),
      inflow, outflow, net: r2(inflow - outflow),
      closing: running,
      is_negative: running < -0.01,
      inflow_items: wi.filter((x) => x.direction === 'in'),
      outflow_items: wi.filter((x) => x.direction === 'out')
    });
  }
  return {
    ...f,
    overdue_rates: f.overdue_rates ? JSON.parse(f.overdue_rates) : {},
    has_gap: num(f.gap_amount) > 0.01,
    weeks_detail: weeks
  };
}

function listForecasts(limit = 20) {
  // 按「基准日」倒序，不是按 id：补跑一份历史基准日的预测时，它的 id 更大但基准日更早，
  // 按 id 排会让页面默认打开那份旧基准日的预测，看到的不是「当前该看的」
  return db.prepare(
    `SELECT f.*, c.name AS company_name FROM cash_forecasts f
     LEFT JOIN companies c ON c.id=f.company_id
     ORDER BY f.base_date DESC, f.id DESC LIMIT ?`
  ).all(Number(limit) || 20).map((f) => ({
    ...f,
    has_gap: num(f.gap_amount) > 0.01
  }));
}

/**
 * 预测回看：把某一批预测的「第 N 周预计收多少」和实际收多少对上
 * 只统计已经过去的周 —— 未来的周没有「实际」可言
 */
function forecastVariance(id) {
  const f = db.prepare('SELECT * FROM cash_forecasts WHERE id=?').get(Number(id));
  if (!f) return null;
  const today = localDate();
  const items = db.prepare('SELECT * FROM cash_forecast_items WHERE forecast_id=? ORDER BY week_no').all(f.id);

  const weeks = [];
  for (let i = 1; i <= f.weeks; i++) {
    const wi = items.filter((x) => x.week_no === i);
    // 不能跳过「没有预测明细」的周：那一周照样可能有实际收付款发生，
    // 跳过就会让实际数为 0，达成率被系统性低估（预测说没钱进来，实际却收到了）
    const start = addDays(f.base_date, (i - 1) * 7 + 1);
    const end = addDays(f.base_date, i * 7);
    const past = end < today;
    const planIn = r2(wi.filter((x) => x.direction === 'in').reduce((a, x) => a + num(x.amount), 0));
    const planOut = r2(wi.filter((x) => x.direction === 'out').reduce((a, x) => a + num(x.amount), 0));

    let actIn = null;
    let actOut = null;
    if (past) {
      const payWh = ["status<>'cancelled'", 'reversed_at IS NULL', "substr(COALESCE(pay_date,created_at),1,10) BETWEEN ? AND ?"];
      const payArgs = [start, end];
      if (f.company_id) { payWh.push('company_id=?'); payArgs.push(f.company_id); }
      const p = db.prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) inn,
           COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) outt
         FROM payments WHERE ${payWh.join(' AND ')}`
      ).get(...payArgs);
      actIn = r2(num(p.inn));
      actOut = r2(num(p.outt));
    }

    weeks.push({
      week_no: i, week_start: start, week_end: end, is_past: past,
      plan_in: planIn, plan_out: planOut,
      actual_in: actIn, actual_out: actOut,
      in_diff: past ? r2(actIn - planIn) : null,
      out_diff: past ? r2(actOut - planOut) : null
    });
  }

  const pastWeeks = weeks.filter((w) => w.is_past);
  const planInSum = r2(pastWeeks.reduce((a, w) => a + w.plan_in, 0));
  const actInSum = r2(pastWeeks.reduce((a, w) => a + num(w.actual_in), 0));
  // 实际数全为 0 时要提示「可能是没登记」，而不是让人以为预测完全失败
  const noActual = pastWeeks.length > 0 && actInSum < 0.01
    && pastWeeks.every((w) => num(w.actual_out) < 0.01);
  return {
    forecast: f,
    weeks,
    past_weeks: pastWeeks.length,
    plan_in_total: planInSum,
    actual_in_total: actInSum,
    no_actual_data: noActual,
    accuracy: planInSum > 0 ? Math.round((actInSum / planInSum) * 1000) / 10 : null
  };
}

/** ==================== 经营指标 ==================== */

/**
 * 经营指标（按月）
 * 每个指标都带口径说明 —— 数字没有口径就是耍流氓
 */
function kpis(period, companyId) {
  const co = companyId ? Number(companyId) : null;
  const is = G.incomeStatement(period, co || undefined);
  const bs = G.balanceSheet(period, co || undefined);
  const { start, end } = G.periodRange(period);
  const days = Math.max(28, daysBetween(start, end) + 1);

  const arBal = bs.assets.find((a) => a.code === '1122')?.amount || 0;
  const apBal = bs.liabilities.find((a) => a.code === '2202')?.amount || 0;
  const invBal = r2(
    (bs.assets.find((a) => a.code === '1405')?.amount || 0)
    + (bs.assets.find((a) => a.code === '1403')?.amount || 0)
  );
  const cash = bs.assets.find((a) => a.code === '1002')?.amount || 0;
  const cost = is.expense.find((e) => e.code === '6401')?.amount || 0;
  const opex = r2(is.expense.filter((e) => e.code !== '6401').reduce((a, e) => a + e.amount, 0));

  /**
   * 小样本保护：分母太小时周转天数会算出 6000 多天这种数字，
   * 那是「这个月几乎没开票」的结果，不是经营真实状况 —— 宁可显示「—」也不要给假数字。
   * 阈值取日均口径：收入日均 < 500 元 / 成本日均 < 500 元，都算样本不足。
   */
  const MIN_DAILY = 500;
  const dailyIncome = is.income_total / days;
  const dailyCost = cost / days;
  const incomeEnough = dailyIncome >= MIN_DAILY;
  const costEnough = dailyCost >= MIN_DAILY;

  const grossMargin = incomeEnough ? r2(((is.income_total - cost) / is.income_total) * 100) : null;
  const netMargin = incomeEnough ? r2((is.net_profit / is.income_total) * 100) : null;
  const arDays = incomeEnough ? Math.round(arBal / dailyIncome) : null;
  const apDays = costEnough ? Math.round(apBal / ((cost + opex) / days)) : null;
  const invDays = costEnough ? Math.round(invBal / dailyCost) : null;
  const cashCycle = (arDays !== null && invDays !== null && apDays !== null)
    ? arDays + invDays - apDays : null;
  const sampleNote = !incomeEnough || !costEnough
    ? `本期日均收入 ${r2(dailyIncome)} 元${incomeEnough ? '' : '（过低）'}、日均成本 ${r2(dailyCost)} 元${costEnough ? '' : '（过低）'}，周转类指标样本不足，显示为 —`
    : null;

  // 客户集中度：本期开票额按客户
  const arArgs = co ? [co, start, end] : [start, end];
  const byCust = db.prepare(
    `SELECT customer_name, SUM(amount) s FROM ar_invoices
     WHERE status<>'void' AND ${co ? 'company_id=?' : '1=1'} AND substr(created_at,1,10) BETWEEN ? AND ?
     GROUP BY customer_name ORDER BY s DESC`
  ).all(...arArgs);
  const custTotal = r2(byCust.reduce((a, r) => a + num(r.s), 0));
  const topCustomer = byCust[0] ? { name: byCust[0].customer_name || '—', amount: r2(num(byCust[0].s)), pct: custTotal > 0 ? r2((num(byCust[0].s) / custTotal) * 100) : 0 } : null;
  const top3Pct = custTotal > 0 ? r2((byCust.slice(0, 3).reduce((a, r) => a + num(r.s), 0) / custTotal) * 100) : null;

  // 人效
  const headWh = ["COALESCE(active,1)=1"];
  const headArgs = [];
  if (co) { headWh.push('company_id=?'); headArgs.push(co); }
  const headcount = db.prepare(`SELECT COUNT(*) c FROM users WHERE ${headWh.join(' AND ')}`).get(...headArgs).c;
  const revPerHead = headcount > 0 && is.income_total > 0 ? r2(is.income_total / headcount) : null;

  const list = [
    { key: 'income', label: '营业收入', value: is.income_total, unit: '元', caliber: '本期利润表收入合计（不含损益结转）' },
    { key: 'gross_profit', label: '毛利', value: r2(is.income_total - cost), unit: '元', caliber: '营业收入 − 主营业务成本 6401' },
    { key: 'gross_margin', label: '毛利率', value: grossMargin, unit: '%', caliber: '（收入 − 成本）÷ 收入；日均收入 < 500 元时样本不足，显示 —' },
    { key: 'net_profit', label: '净利润', value: is.net_profit, unit: '元', caliber: '收入 − 全部成本费用' },
    { key: 'net_margin', label: '净利率', value: netMargin, unit: '%', caliber: '净利润 ÷ 收入' },
    { key: 'cash', label: '期末现金', value: cash, unit: '元', caliber: '1002 银行存款期末余额' },
    { key: 'ar_balance', label: '应收余额', value: arBal, unit: '元', caliber: '1122 应收账款期末余额' },
    { key: 'ap_balance', label: '应付余额', value: apBal, unit: '元', caliber: '2202 应付账款期末余额' },
    { key: 'inventory', label: '存货余额', value: invBal, unit: '元', caliber: '1403 原材料 + 1405 库存商品' },
    { key: 'ar_days', label: '应收周转天数', value: arDays, unit: '天', caliber: '期末应收 ÷ 日均收入；日均收入 < 500 元时为 —' },
    { key: 'ap_days', label: '应付周转天数', value: apDays, unit: '天', caliber: '期末应付 ÷ 日均成本费用；日均成本 < 500 元时为 —' },
    { key: 'inv_days', label: '存货周转天数', value: invDays, unit: '天', caliber: '期末存货 ÷ 日均成本；日均成本 < 500 元时为 —' },
    { key: 'cash_cycle', label: '现金转换周期', value: cashCycle, unit: '天', caliber: '应收天数 + 存货天数 − 应付天数；越短越好' },
    { key: 'top_customer_pct', label: '最大客户占比', value: topCustomer ? topCustomer.pct : null, unit: '%', caliber: '本期开票额第一名客户的占比' },
    { key: 'top3_pct', label: '前三大客户占比', value: top3Pct, unit: '%', caliber: '前三名客户合计占本期开票额；超过 60% 说明依赖度高' },
    { key: 'headcount', label: '在职账号数', value: headcount, unit: '人', caliber: '启用状态的用户数（非员工档案数）' },
    { key: 'rev_per_head', label: '人均收入', value: revPerHead, unit: '元', caliber: '本期营业收入 ÷ 在职账号数' }
  ];

  return { period, company_id: co, days, sample_note: sampleNote, top_customer: topCustomer, kpis: list };
}

/** 落指标快照 */
function snapshotKpis(period, companyId, operator) {
  const r = kpis(period, companyId);
  const t = localNow();
  const ins = db.prepare(
    `INSERT INTO kpi_snapshots (period,company_id,kpi_key,kpi_label,value,unit,caliber,created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(period, company_id, kpi_key) DO UPDATE SET value=excluded.value, unit=excluded.unit,
       caliber=excluded.caliber, created_at=excluded.created_at`
  );
  let n = 0;
  r.kpis.forEach((k) => {
    ins.run(period, r.company_id, k.key, k.label, k.value, k.unit, k.caliber, t);
    n += 1;
  });
  return { period, company_id: r.company_id, saved: n };
}

/** 指标趋势（近 N 个月，实时算不读快照） */
function kpiTrend(months, companyId) {
  const n = Math.min(24, Math.max(3, Number(months) || 12));
  const cur = localDate().slice(0, 7);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = G.shiftPeriod(cur, -i);
    const is = G.incomeStatement(p, companyId || undefined);
    const bs = G.balanceSheet(p, companyId || undefined);
    out.push({
      period: p,
      income: is.income_total,
      expense: is.expense_total,
      net: is.net_profit,
      cash: bs.assets.find((a) => a.code === '1002')?.amount || 0,
      ar: bs.assets.find((a) => a.code === '1122')?.amount || 0,
      ap: bs.liabilities.find((a) => a.code === '2202')?.amount || 0
    });
  }
  return out;
}

/** ==================== 驾驶舱总览 ==================== */

function overview(opt = {}) {
  // 默认看「最近一个已关账期间」：当期往往还没开票，一进来全是 0 和负毛利，看着像系统坏了
  const cur = localDate().slice(0, 7);
  const lastClosed = db.prepare(
    "SELECT period FROM gl_periods WHERE status='closed' ORDER BY period DESC LIMIT 1"
  ).get();
  const period = String(opt.period || (lastClosed ? lastClosed.period : cur));
  const cid = opt.company_id ? Number(opt.company_id) : null;
  const k = kpis(period, cid);
  const ar = aging('ar', { company_id: cid });
  const ap = aging('ap', { company_id: cid });
  // 取「基准日最新」的那批，不是 id 最大：补跑历史基准日的批次 id 更大，
  // 按 id 取会让概览显示一份两周前的预测，和「现在钱够不够」没关系
  const lastFc = db.prepare(
    `SELECT * FROM cash_forecasts ${cid ? 'WHERE company_id=?' : ''} ORDER BY base_date DESC, id DESC LIMIT 1`
  ).get(...(cid ? [cid] : []));

  // 风险提示：都是「要人去做点什么」的，不是纯展示
  const alerts = [];
  if (ar.overdue_pct >= 30) {
    alerts.push({
      level: 'high',
      title: `逾期应收占 ${ar.overdue_pct}%`,
      detail: `未收 ¥${ar.total}，其中逾期 ¥${ar.overdue_amount}。逾期占比过半时，利润是账面数字，不是现金。`,
      action: '按账龄清单催收，90 天以上的考虑计提坏账'
    });
  } else if (ar.overdue_pct >= 15) {
    alerts.push({
      level: 'mid', title: `逾期应收占 ${ar.overdue_pct}%`,
      detail: `逾期 ¥${ar.overdue_amount}`, action: '按客户清单跟进'
    });
  }
  if (lastFc && num(lastFc.gap_amount) > 0.01) {
    alerts.push({
      level: 'high',
      title: `现金缺口 ¥${r2(lastFc.gap_amount)}`,
      detail: lastFc.first_neg_week
        ? `按最近一次预测，第 ${lastFc.first_neg_week} 周现金转负，最深缺口 ¥${r2(lastFc.gap_amount)}（第 ${lastFc.min_week} 周）。`
        : `按最近一次预测，最低现金 ¥${r2(lastFc.min_cash)}，最大缺口 ¥${r2(lastFc.gap_amount)}。`,
      action: '排收款优先级，或把非必要支出往后挪'
    });
  }
  if (k.kpis.find((x) => x.key === 'ap_days')?.value !== null
      && num(ar.avg_overdue_days) > num(k.kpis.find((x) => x.key === 'ap_days')?.value)) {
    alerts.push({
      level: 'mid',
      title: '收款比付款慢',
      detail: `平均逾期 ${ar.avg_overdue_days} 天，应付周转 ${k.kpis.find((x) => x.key === 'ap_days').value} 天`,
      action: '垫资压力来自账期错配，考虑对客户要求订金'
    });
  }
  const top3 = k.kpis.find((x) => x.key === 'top3_pct')?.value;
  if (top3 !== null && top3 >= 60) {
    alerts.push({
      level: 'mid',
      title: `前三大客户占 ${top3}%`,
      detail: '客户集中度过高，一家流失营收就塌一块。',
      action: '新客户开发需要排进日程'
    });
  }
  const cycle = k.kpis.find((x) => x.key === 'cash_cycle')?.value;
  if (cycle !== null && cycle !== undefined && cycle > 120) {
    alerts.push({
      level: 'mid', title: `现金转换周期 ${cycle} 天`,
      detail: '从付钱买料到收回货款要四个多月。', action: '压缩存货或在途，或谈更长账期'
    });
  }

  return {
    period, company_id: cid,
    money: {
      income: k.kpis.find((x) => x.key === 'income')?.value || 0,
      gross_margin: k.kpis.find((x) => x.key === 'gross_margin')?.value,
      net_profit: k.kpis.find((x) => x.key === 'net_profit')?.value || 0,
      net_margin: k.kpis.find((x) => x.key === 'net_margin')?.value,
      cash: k.kpis.find((x) => x.key === 'cash')?.value || 0,
      ar: k.kpis.find((x) => x.key === 'ar_balance')?.value || 0,
      ap: k.kpis.find((x) => x.key === 'ap_balance')?.value || 0
    },
    ar: { total: ar.total, overdue: ar.overdue_amount, overdue_pct: ar.overdue_pct, avg_age: ar.avg_age_days, count: ar.count, buckets: ar.buckets },
    ap: { total: ap.total, overdue: ap.overdue_amount, overdue_pct: ap.overdue_pct, avg_age: ap.avg_age_days, count: ap.count, buckets: ap.buckets },
    cash_forecast: lastFc ? {
      id: lastFc.id, forecast_no: lastFc.forecast_no, base_date: lastFc.base_date,
      opening_cash: lastFc.opening_cash, min_cash: lastFc.min_cash, min_week: lastFc.min_week,
      first_neg_week: lastFc.first_neg_week,
      gap_amount: lastFc.gap_amount, closing_cash: lastFc.closing_cash, weeks: lastFc.weeks
    } : null,
    alerts,
    top_customer: k.top_customer
  };
}

module.exports = {
  AGING_BUCKETS, DEFAULT_OVERDUE_RATES,
  aging, buildForecast, getForecast, listForecasts, forecastVariance,
  kpis, snapshotKpis, kpiTrend, overview
};
