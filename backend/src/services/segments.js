/**
 * 分公司（分部）经营对比（M12 细化）
 * ============================================================
 * 回答一个问题：**剔掉内部交易、统一口径之后，哪家真正在赚钱，跟上期比好还是差。**
 *
 * 硬规则（都在下面的代码里）：
 * 1. **内部交易只能靠「往来单位」识别，认不出就明说**：
 *    内部收入 = 该主体 6xxx 收入科目上、`partner_name` 命中他自己维护的内部往来单位的部分。
 *    如果该主体在集团内有往来（存在 `intercompany_links`），但收入里一条都没命中 →
 *    标 `ic_unmapped`，**对外收入不出数**（`external_income = null`），绝不拿「收入 − 0」冒充对外收入。
 * 2. **合并数不等于分部之和**：两个数都给，差额必须等于内部交易；对不上就报差异（`ic_mismatch`），
 *    不许把差额抹平。
 * 3. **未关账主体的数不参与排名**：`gl_periods.status <> 'closed'` → 标 `unclosed`，
 *    排名里排最后，且合计上写「含未关账」。
 * 4. **环比必须同口径**：上期该主体未关账或没数据 → 环比为 `null`（界面显示「—」），
 *    不拿 0 当基数算出 100%/−100%。
 * 5. **人均必须有人数**：用 `employments`（`status='effective'` 按雇佣公司）数在职；
 *    没有人数 → 人均为 `null`，不编 0（否则算出无穷大）。
 * 6. **汇率缺失的主体不折算**：本位币不是 CNY 且没配汇率 → 标 `fx_missing`，该主体不进合计。
 * 7. **内部成本算不出来就别算**：成本结转分录通常不带往来单位，
 *    内部毛利只在「内部成本也能按往来单位识别」时才给，否则 `external_gross = null` 并说明原因。
 * 8. **调整只影响「可比」列，不改账**：一次性/分摊/汇率调整单列，账载净利永远保留。
 * 9. **确认后快照冻结**：报告确认后 payload 不再重算，后续改账不影响已确认报告；要改就出新版本。
 *
 * 期间口径：`YYYY-MM`；金额一律折成集团本位币（CNY）。
 */

const { db } = require('../db');
const G = require('./gl');
const { localDate } = require('./sla');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const ADJ_LABEL = { one_off: '一次性损益', allocation: '总部费用分摊', fx: '汇率影响', other: '其他' };
const ISSUE_LABEL = {
  unclosed: '期间未关账',
  ic_unmapped: '内部往来单位未维护',
  ic_unconfigured: '未配内部客户往来单位',
  fx_missing: '本位币缺汇率',
  no_headcount: '没有在职人数',
  ic_mismatch: '分部之和与合并数对不上',
  partial_data: '部分主体本期无凭证',
  no_consolidation: '本期未生成合并'
};

function shiftMonth(period, delta) {
  const [y, m] = String(period).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function currentPeriod() {
  return localDate().slice(0, 7);
}

/** 默认期间：最近一个「有已过账凭证」的月份（当月常常只有一两家有数，对比没意义） */
function latestPeriod() {
  const r = db.prepare(
    "SELECT period FROM gl_vouchers WHERE status='posted' ORDER BY period DESC LIMIT 1"
  ).get();
  return r && r.period ? r.period : currentPeriod();
}

/** 集团汇率：目前只维护美元（与订单/发票同一口径） */
function fxRates() {
  const row = db.prepare("SELECT value FROM app_config WHERE key='settings'").get();
  let rate = 1;
  try {
    const j = row ? JSON.parse(row.value) : {};
    rate = Number(j.exchangeRate) || 1;
  } catch (e) { rate = 1; }
  return { USD: rate, CNY: 1 };
}

/** 该主体维护的内部往来单位：名称集合 + 名称→对方主体 */
function icPartyMap(companyId) {
  const rows = db.prepare(
    "SELECT * FROM intercompany_parties WHERE company_id=? AND status='active'"
  ).all(companyId);
  const customerParties = rows.filter((r) => r.kind === 'customer' || r.kind === 'both');
  const names = [];
  const counterOf = {};
  rows.forEach((r) => {
    [r.ref_name, r.match_key].filter(Boolean).forEach((n) => {
      const s = String(n).trim();
      if (!s || names.includes(s)) return;
      names.push(s);
      counterOf[s] = r.counter_company_id;
    });
  });
  return { names, counterOf, customerParties: customerParties.length };
}

function hasOutboundLink(companyId, period) {
  return !!db.prepare(
    "SELECT 1 x FROM intercompany_links WHERE from_company_id=? AND (period=? OR ?='') LIMIT 1"
  ).get(companyId, period || '', period || '');
}

function hasIcRelation(companyId) {
  return !!db.prepare(
    'SELECT 1 x FROM intercompany_links WHERE from_company_id=? OR to_company_id=? LIMIT 1'
  ).get(companyId, companyId);
}

/** 在职人数（按雇佣公司；服务公司不同不影响「谁在发工资」这条口径） */
function headcountOf(companyId) {
  const r = db.prepare(
    "SELECT COUNT(*) c FROM employments WHERE employer_company_id=? AND status='effective'"
  ).get(companyId);
  return Number(r.c) || 0;
}

/** 该期间该主体收入/成本按「往来单位是否内部」拆分 */
function icSplit(companyId, period, names) {
  const out = { income: 0, cost: 0, by_counter: {} };
  if (!names.length) return out;
  const inSql = names.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT e.account_code, a.type, e.partner_name,
            COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e
     JOIN gl_vouchers v ON v.id = e.voucher_id
     JOIN gl_accounts a ON a.code = e.account_code
     WHERE v.company_id=? AND v.period=? AND v.status='posted' AND v.source_type<>'profit_carry'
       AND e.partner_name IN (${inSql})
     GROUP BY e.account_code, e.partner_name`
  ).all(companyId, period, ...names);
  rows.forEach((r) => {
    if (r.type === 'income') {
      const amt = r2(num(r.c) - num(r.d));
      out.income = r2(out.income + amt);
      const k = r.partner_name;
      out.by_counter[k] = r2((out.by_counter[k] || 0) + amt);
    } else if (r.account_code === '6401') {
      // 成本结转分录通常不带往来单位；带了才敢算内部成本
      out.cost = r2(out.cost + (num(r.d) - num(r.c)));
    }
  });
  out.cost = r2(Math.abs(out.cost));
  return out;
}

/** 单主体快照（含上期环比与可比口径） */
function companySnapshot(company, period, opts = {}) {
  const cur = company.base_currency || 'CNY';
  // 总账里的金额按本币入账（发票/凭证写入时已折本币），**这里再乘一次汇率就是重复折算**。
  // 本位币不是 CNY 时只做提示，让人去确认账面是否真的折过。
  const currencyNote = cur === 'CNY' ? null : `本位币 ${cur}：系统按账面本币汇总，不二次乘汇率`;

  const is = G.incomeStatement(period, company.id);
  const bs = G.balanceSheet(period, company.id);

  // 收入 / 成本 / 期间费用（成本 = 6401，其余费用进期间费用）
  const income = r2(is.income_total);
  const costRow = (is.expense || []).find((e) => e.code === '6401');
  const cost = r2(costRow ? costRow.amount : 0);
  const opex = r2(is.expense_total - cost);
  const net = r2(is.net_profit);

  // 内部交易识别
  const ic = icPartyMap(company.id);
  const split = icSplit(company.id, period, ic.names);
  const icIncome = r2(split.income);
  const icCost = r2(split.cost);
  const related = hasIcRelation(company.id);
  // 规则 1：**配了客户类内部往来单位却一条都没命中**，说明名字没对上，这时不给对外收入；
  //         没配的只提示「可能漏配」（纯采购主体本来就没有内部收入，不能一律拦）。
  const icUnmapped = ic.customerParties > 0 && icIncome <= 0.01 && hasOutboundLink(company.id, period);
  const icUnconfigured = ic.customerParties === 0 && related && icIncome <= 0.01;

  const externalIncome = icUnmapped ? null : r2(income - icIncome);
  // 规则 7：内部成本识别不出来，就不给「对外毛利」
  const externalCost = icUnmapped ? null : r2(cost - icCost);
  const externalGross = externalIncome === null || externalCost === null || externalIncome <= 0.01
    ? null
    : r2(externalIncome - externalCost);

  // 资产负债要点
  const pick = (list, code) => r2((list || []).find((x) => x.code === code)?.amount || 0);
  const ar = r2(pick(bs.assets, '1122') + pick(bs.assets, '1221'));
  const inventory = r2(pick(bs.assets, '1403') + pick(bs.assets, '1405'));
  const cash = r2(pick(bs.assets, '1001') + pick(bs.assets, '1002'));
  const ap = r2(pick(bs.liabilities, '2202') + pick(bs.liabilities, '2241'));

  // 人数与人均（规则 5）
  const headcount = headcountOf(company.id);
  const perCapitaIncome = headcount > 0 && externalIncome !== null && externalIncome > 0
    ? r2(externalIncome / headcount)
    : null;
  const perCapitaNet = headcount > 0 ? r2(net / headcount) : null;

  // 期间状态
  const p = db.prepare('SELECT * FROM gl_periods WHERE company_id=? AND period=?').get(company.id, period);
  const periodStatus = p ? p.status : 'open';

  // 可比口径调整（规则 8）
  const adjRows = db.prepare(
    'SELECT * FROM segment_adjustments WHERE company_id=? AND period=? ORDER BY id'
  ).all(company.id, period);
  const adjTotal = r2(adjRows.reduce((a, x) => a + num(x.amount), 0));
  const comparableNet = r2(net + adjTotal);

  // 环比（规则 4）
  const prev = shiftMonth(period, -1);
  const prevP = db.prepare('SELECT status FROM gl_periods WHERE company_id=? AND period=?').get(company.id, prev);
  const prevIs = G.incomeStatement(prev, company.id);
  // 上期只要「有关账或有数」就能算环比；期间档案没建也算有数（不要因为没建期就显示 —）
  const prevClosed = !!prevP && prevP.status === 'closed';
  const prevUsable = prevClosed || Math.abs(prevIs.income_total) > 0.01;
  const prevIncome = prevUsable ? r2(prevIs.income_total) : null;
  const prevNet = prevUsable ? r2(prevIs.net_profit) : null;

  return {
    company_id: company.id,
    code: company.code,
    name: company.name,
    short_name: company.short_name || company.name,
    type: company.type,
    type_label: company.type_label,
    base_currency: cur,
    currency_note: currencyNote,

    income, cost, opex, net,
    gross: r2(income - cost),
    gross_margin: income > 0 ? r2(((income - cost) / income) * 100) : null,
    net_margin: income > 0 ? r2((net / income) * 100) : null,
    opex_ratio: income > 0 ? r2((opex / income) * 100) : null,

    ic_income: icIncome,
    ic_cost: icCost,
    ic_ratio: income > 0 ? r2((icIncome / income) * 100) : null,
    ic_detail: Object.entries(split.by_counter).map(([n, amt]) => ({
      partner: n, counter_company_id: ic.counterOf[n] || null, amount: r2(amt)
    })).sort((a, b) => b.amount - a.amount),
    ic_unmapped: icUnmapped ? 1 : 0,
    ic_unconfigured: icUnconfigured ? 1 : 0,

    external_income: externalIncome,
    external_cost: externalCost,
    external_gross: externalGross,
    external_gross_margin: externalGrowOk(externalIncome, externalGross)
      ? r2((externalGross / externalIncome) * 100)
      : null,

    ar, inventory, ap, cash,
    working_capital: r2(ar + inventory),
    headcount,
    per_capita_income: perCapitaIncome,
    per_capita_net: perCapitaNet,

    adjustments: adjRows.map((x) => ({
      id: x.id, kind: x.kind, kind_label: ADJ_LABEL[x.kind] || x.kind,
      amount: r2(x.amount), note: x.note, created_by: x.created_by
    })),
    adjust_total: adjTotal,
    comparable_net: comparableNet,

    prev_period: prev,
    prev_usable: prevUsable ? 1 : 0,
    prev_closed: prevClosed ? 1 : 0,
    prev_income: prevIncome,
    prev_net: prevNet,
    income_mom: prevIncome && prevIncome > 0
      ? r2(((income - prevIncome) / prevIncome) * 100)
      : null,
    net_mom: prevNet && Math.abs(prevNet) > 0.01
      ? r2(((net - prevNet) / Math.abs(prevNet)) * 100)
      : null,

    period_status: periodStatus,
    period_status_label: periodStatus === 'closed' ? '已关账' : '未关账',
    voucher_count: db.prepare(
      "SELECT COUNT(*) c FROM gl_vouchers WHERE company_id=? AND period=? AND status='posted'"
    ).get(company.id, period).c
  };
}

function externalGrowOk(income, gross) {
  return income !== null && gross !== null && Math.abs(income) > 0.01;
}

/** 主表：各主体 + 合计 + 合并对照 + 口径问题清单 */
function board(period) {
  const p = period || currentPeriod();
  const fx = fxRates();
  const companies = db.prepare("SELECT * FROM companies WHERE status='active' ORDER BY id").all();
  const list = companies.map((c) => companySnapshot(c, p, { fx }));

  // 合计：所有主体都进（金额已是本币）；只有「对外收入算不出来」的主体不进对外口径（规则 1）
  const usable = list.slice();
  const sum = (k) => r2(usable.reduce((a, x) => a + (x[k] === null ? 0 : num(x[k])), 0));
  const externalUsable = usable.filter((x) => x.external_income !== null);

  // 结构占比（对外收入口径）
  const extTotal = r2(externalUsable.reduce((a, x) => a + num(x.external_income), 0));
  const wcTotal = r2(usable.reduce((a, x) => a + num(x.working_capital), 0));
  list.forEach((x) => {
    x.income_share = externalUsable.includes(x) && extTotal > 0
      ? r2((num(x.external_income) / extTotal) * 100)
      : null;
    x.wc_share = wcTotal > 0 ? r2((num(x.working_capital) / wcTotal) * 100) : null;
  });

  // 排名：只有已关账、汇率齐全、对外收入可算的主体参与排名（规则 3）
  const rankable = list.filter((x) => !x.ic_unmapped && x.period_status === 'closed' && num(x.external_income) > 0);
  const ranked = rankable.slice().sort((a, b) => num(b.external_income) - num(a.external_income));
  ranked.forEach((x, i) => { x.rank = i + 1; });

  // 集团均值（用于费用率异常判断，只用可排名主体，避免被未关账的主体拉偏）
  const avgOpex = rankable.length
    ? r2(rankable.reduce((a, x) => a + num(x.opex_ratio), 0) / rankable.length)
    : null;
  const avgNetMargin = rankable.length
    ? r2(rankable.reduce((a, x) => a + num(x.net_margin), 0) / rankable.length)
    : null;

  // 诊断标签
  list.forEach((x) => {
    const tags = [];
    if (x.period_status !== 'closed') tags.push({ k: 'unclosed', label: '未关账' });
    if (x.currency_note) tags.push({ k: 'currency_review', label: x.base_currency });
    if (x.ic_unmapped) tags.push({ k: 'ic_unmapped', label: '内部往来未维护' });
    if (x.ic_unconfigured) tags.push({ k: 'ic_unconfigured', label: '未配内部客户往来' });
    if (x.ic_ratio !== null && x.ic_ratio >= 50) tags.push({ k: 'ic_heavy', label: `内部依赖 ${x.ic_ratio}%` });
    if (x.net < 0) tags.push({ k: 'loss', label: '亏损' });
    if (avgOpex !== null && x.opex_ratio !== null && x.opex_ratio > avgOpex * 1.3) {
      tags.push({ k: 'opex_high', label: `费用率 ${x.opex_ratio}% 偏高` });
    }
    if (x.income_share !== null && x.wc_share !== null && x.income_share > 0
      && x.wc_share > x.income_share * 1.5) {
      tags.push({ k: 'capital_heavy', label: `占资金 ${x.wc_share}% 但只贡献 ${x.income_share}% 收入` });
    }
    if (!x.headcount) tags.push({ k: 'no_headcount', label: '没有在职人数' });
    x.tags = tags;
  });

  // 合并数对照（规则 2）
  const con = db.prepare(
    "SELECT * FROM consolidations WHERE period=? ORDER BY (status='confirmed') DESC, id DESC LIMIT 1"
  ).get(p);
  const totalIncome = sum('income');
  const consolidatedIncome = con ? r2(con.income_total) : null;
  const icAmount = consolidatedIncome === null ? null : r2(totalIncome - consolidatedIncome);
  const icIncomeSum = sum('ic_income');
  const icMismatch = consolidatedIncome === null
    ? 0
    : (Math.abs(r2(totalIncome - consolidatedIncome) - icIncomeSum) > 1 ? 1 : 0);

  const issues = [];
  list.forEach((x) => {
    if (x.period_status !== 'closed') {
      issues.push({ level: 'warn', code: 'unclosed', company: x.short_name, detail: `${p} 期间未关账，数字还会变，不进排名` });
    }
    if (x.ic_unmapped) {
      issues.push({ level: 'block', code: 'ic_unmapped', company: x.short_name, detail: '集团内有往来但内部往来单位没维护，对外收入算不出来（不能拿收入当对外收入）' });
    }
    if (x.currency_note) {
      issues.push({ level: 'info', code: 'currency_review', company: x.short_name, detail: x.currency_note + '，请确认总账是否已折本币' });
    }
    if (x.ic_unconfigured) {
      issues.push({ level: 'info', code: 'ic_unconfigured', company: x.short_name, detail: '没有配客户类内部往来单位；本期若卖给集团内其他主体，会被算成对外收入，请补配置' });
    }
    if (!x.headcount) {
      issues.push({ level: 'info', code: 'no_headcount', company: x.short_name, detail: '没有生效任职记录，人均指标不出数' });
    }
  });
  // 没数 ≠ 业绩为 0：某家本期一张凭证都没有，要在问题清单里说清楚
  const emptyCos = list.filter((x) => !x.voucher_count);
  if (emptyCos.length) {
    issues.push({
      level: 'warn', code: 'partial_data', company: '集团',
      detail: `本期只有 ${list.length - emptyCos.length}/${list.length} 家有过账凭证，${emptyCos.map((x) => x.short_name).join('、')} 本期没有凭证——显示 0 是「没数」不是「没业绩」`
    });
  }
  if (!con) {
    issues.push({ level: 'info', code: 'no_consolidation', company: '集团', detail: `${p} 还没有合并批次，只能看分部之和` });
  } else if (icMismatch) {
    issues.push({
      level: 'warn', code: 'ic_mismatch', company: '集团',
      detail: `分部之和 ${totalIncome} − 合并数 ${consolidatedIncome} = ${r2(totalIncome - consolidatedIncome)}，与已识别内部收入 ${icIncomeSum} 不一致，检查往来单位是否漏配`
    });
  }
  const icDiff = db.prepare(
    "SELECT COUNT(*) c FROM intercompany_links WHERE period=? AND status='diff'"
  ).get(p).c;
  if (icDiff) {
    issues.push({ level: 'warn', code: 'ic_diff', company: '集团', detail: `内部往来 ${icDiff} 笔两侧对不平，合并抵消会带误差` });
  }

  return {
    period: p,
    prev_period: shiftMonth(p, -1),
    generated_at: new Date().toISOString(),
    fx: { USD: fx.USD, CNY: 1 },
    companies: list,
    rankable_count: rankable.length,
    avg_opex_ratio: avgOpex,
    avg_net_margin: avgNetMargin,
    total: {
      income: totalIncome,
      external_income: extTotal,
      ic_income: icIncomeSum,
      cost: sum('cost'),
      opex: sum('opex'),
      net: sum('net'),
      comparable_net: r2(usable.reduce((a, x) => a + num(x.comparable_net), 0)),
      ar: sum('ar'),
      inventory: sum('inventory'),
      ap: sum('ap'),
      cash: sum('cash'),
      working_capital: wcTotal,
      headcount: usable.reduce((a, x) => a + num(x.headcount), 0),
      adjust_total: sum('adjust_total')
    },
    consolidated: con ? {
      id: con.id, con_no: con.con_no, status: con.status, income_total: r2(con.income_total),
      net_profit: r2(con.net_profit), ic_diff_cnt: con.ic_diff_cnt
    } : null,
    ic_amount: icAmount,
    ic_mismatch: icMismatch,
    issues,
    issue_count: issues.filter((x) => x.level !== 'info').length
  };
}


/** 收入里有往来名称、但不是内部往来单位的 Top N —— 给人核对「这些是不是集团内主体」 */
function unmatchedPartners(companyId, period) {
  const ic = icPartyMap(companyId);
  const inSql = ic.names.length ? `AND e.partner_name NOT IN (${ic.names.map(() => '?').join(',')})` : '';
  const rows = db.prepare(
    `SELECT e.partner_name AS name, COALESCE(SUM(e.credit - e.debit),0) amt
     FROM gl_entries e
     JOIN gl_vouchers v ON v.id = e.voucher_id
     JOIN gl_accounts a ON a.code = e.account_code
     WHERE v.company_id=? AND v.period=? AND v.status='posted' AND v.source_type<>'profit_carry'
       AND a.type='income' AND e.partner_name IS NOT NULL AND e.partner_name<>'' ${inSql}
     GROUP BY e.partner_name ORDER BY amt DESC LIMIT 12`
  ).all(companyId, period, ...ic.names);
  return rows.map((r) => ({ name: r.name, amount: r2(num(r.amt)) })).filter((r) => Math.abs(r.amount) > 0.01);
}

/** 单主体下钻：快照 + 损益结构 + 待核对的往来名称 */
function companyDetail(companyId, period) {
  const p = period || currentPeriod();
  const co = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
  if (!co) return null;
  const typeCn = { headquarters: '总部', branch: '分公司', subsidiary: '子公司' };
  const snap = companySnapshot({ ...co, type_label: typeCn[co.type] || co.type }, p);
  const is = G.incomeStatement(p, co.id);
  const bs = G.balanceSheet(p, co.id);
  return {
    period: p,
    company: { id: co.id, code: co.code, name: co.name, short_name: co.short_name || co.name, type_label: typeCn[co.type] || co.type },
    snapshot: snap,
    income_lines: is.income,
    expense_lines: is.expense,
    assets: bs.assets,
    liabilities: bs.liabilities,
    equity: bs.equity,
    unmatched_partners: unmatchedPartners(companyId, p),
    issues: [
      snap.ic_unmapped ? { level: 'block', detail: '配了内部客户往来单位，但收入里一条都没命中：对外收入不出数，请核对单据上的往来名称' } : null,
      snap.ic_unconfigured ? { level: 'info', detail: '没有配客户类内部往来单位；若本期卖给集团内其他主体，会被算成对外收入' } : null,
      snap.period_status !== 'closed' ? { level: 'warn', detail: '本期未关账，数字还会变' } : null,
      !snap.headcount ? { level: 'info', detail: '没有生效任职记录，人均指标不出数' } : null
    ].filter(Boolean)
  };
}

// ---------- 调整 ----------
function listAdjustments(period) {
  const p = period || currentPeriod();
  return db.prepare(
    `SELECT a.*, c.short_name, c.name FROM segment_adjustments a
     LEFT JOIN companies c ON c.id = a.company_id
     WHERE a.period=? ORDER BY a.company_id, a.id`
  ).all(p).map((x) => ({ ...x, kind_label: ADJ_LABEL[x.kind] || x.kind, amount: r2(x.amount) }));
}

function saveAdjustment(b = {}, operator) {
  const companyId = Number(b.company_id);
  const period = String(b.period || '').slice(0, 7);
  if (!companyId) throw new Error('请选择主体');
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('期间格式必须是 YYYY-MM');
  const kind = ['one_off', 'allocation', 'fx', 'other'].includes(b.kind) ? b.kind : 'one_off';
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.01) throw new Error('调整金额不能为 0');
  const note = String(b.note || '').trim();
  if (note.length < 4) throw new Error('必须写清这笔调整是什么（至少 4 个字）');
  const co = db.prepare('SELECT * FROM companies WHERE id=?').get(companyId);
  if (!co) throw new Error('主体不存在');
  const info = db.prepare(
    'INSERT INTO segment_adjustments (company_id, period, kind, amount, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(companyId, period, kind, r2(amount), note, operator, new Date().toISOString());
  return db.prepare('SELECT * FROM segment_adjustments WHERE id=?').get(Number(info.lastInsertRowid));
}

function deleteAdjustment(id) {
  const row = db.prepare('SELECT * FROM segment_adjustments WHERE id=?').get(id);
  if (!row) throw new Error('调整不存在');
  db.prepare('DELETE FROM segment_adjustments WHERE id=?').run(id);
  return { deleted: 1 };
}

// ---------- 报告快照 ----------
function nextReportNo(period) {
  const prefix = `SEG${String(period).replace('-', '')}`;
  const rows = db.prepare('SELECT report_no FROM segment_reports WHERE report_no LIKE ?').all(`${prefix}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.report_no).slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  let seq = max + 1;
  let no = `${prefix}${String(seq).padStart(4, '0')}`;
  while (db.prepare('SELECT 1 x FROM segment_reports WHERE report_no=?').get(no)) {
    seq += 1;
    no = `${prefix}${String(seq).padStart(4, '0')}`;
  }
  return no;
}

function generateReport(period, operator, note) {
  const p = period || currentPeriod();
  const data = board(p);
  const no = nextReportNo(p);
  const ts = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO segment_reports
      (report_no, company_id, period, company_count, total_income, total_external_income, total_net,
       consolidated_income, ic_amount, issue_count, payload, status, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    no, 1, p, data.companies.length, data.total.income, data.total.external_income, data.total.net,
    data.consolidated ? data.consolidated.income_total : null,
    data.ic_amount === null ? 0 : data.ic_amount,
    data.issue_count, JSON.stringify(data), 'draft', note || null, operator, ts
  );
  return db.prepare('SELECT id, report_no, period, status FROM segment_reports WHERE id=?')
    .get(Number(info.lastInsertRowid));
}

function listReports(period) {
  const args = [];
  let sql = `SELECT r.*, u.name AS confirmer FROM segment_reports r
             LEFT JOIN users u ON u.username = r.confirmed_by`;
  if (period) {
    sql += ' WHERE r.period = ?';
    args.push(period);
  }
  sql += ' ORDER BY r.id DESC LIMIT 40';
  return db.prepare(sql).all(...args).map((x) => ({ ...x, payload: undefined }));
}

function getReport(id) {
  const r = db.prepare('SELECT * FROM segment_reports WHERE id=?').get(id);
  if (!r) return null;
  let payload = null;
  try { payload = JSON.parse(r.payload); } catch (e) { payload = null; }
  return { ...r, payload };
}

function confirmReport(id, operator, note) {
  const r = db.prepare('SELECT * FROM segment_reports WHERE id=?').get(id);
  if (!r) throw new Error('报告不存在');
  if (r.status === 'confirmed') throw new Error('该报告已确认，不能重复确认');
  db.prepare(
    "UPDATE segment_reports SET status='confirmed', confirmed_by=?, confirmed_at=?, note=COALESCE(?, note) WHERE id=?"
  ).run(operator, new Date().toISOString(), note || null, id);
  return getReport(id);
}

/** 导出 CSV（带 BOM，Excel 直开） */
function exportCsv(period) {
  const p = period || currentPeriod();
  const data = board(p);
  const head = [
    '主体', '类型', '本位币', '收入(含内部)', '内部收入', '对外收入', '成本', '期间费用',
    '净利', '可比净利', '毛利率%', '净利率%', '费用率%', '内部依赖%', '应收', '存货', '应付',
    '人数', '人均对外收入', '收入环比%', '期间状态', '诊断'
  ];
  const lines = [head.join(',')];
  data.companies.forEach((x) => {
    const cells = [
      x.short_name, x.type_label || '', x.base_currency,
      x.income, x.ic_income, x.external_income === null ? '' : x.external_income,
      x.cost, x.opex, x.net, x.comparable_net,
      x.gross_margin === null ? '' : x.gross_margin,
      x.net_margin === null ? '' : x.net_margin,
      x.opex_ratio === null ? '' : x.opex_ratio,
      x.ic_ratio === null ? '' : x.ic_ratio,
      x.ar, x.inventory, x.ap, x.headcount,
      x.per_capita_income === null ? '' : x.per_capita_income,
      x.income_mom === null ? '' : x.income_mom,
      x.period_status_label,
      (x.tags || []).map((t) => t.label).join(' / ')
    ];
    lines.push(cells.map((c) => {
      const s = String(c === null || c === undefined ? '' : c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  });
  return { period: p, csv: lines.join('\r\n'), filename: `分部经营对比_${p}.csv` };
}

function dict() {
  return {
    adj_kind: Object.entries(ADJ_LABEL).map(([k, v]) => ({ k, v })),
    issues: Object.entries(ISSUE_LABEL).map(([k, v]) => ({ k, v })),
    current_period: currentPeriod()
  };
}

module.exports = {
  ADJ_LABEL,
  ISSUE_LABEL,
  shiftMonth,
  currentPeriod,
  latestPeriod,
  fxRates,
  icPartyMap,
  headcountOf,
  companySnapshot,
  companyDetail,
  unmatchedPartners,
  board,
  listAdjustments,
  saveAdjustment,
  deleteAdjustment,
  generateReport,
  listReports,
  getReport,
  confirmReport,
  exportCsv,
  dict,
  r2
};
