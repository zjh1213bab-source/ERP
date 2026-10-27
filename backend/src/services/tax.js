/**
 * 税负测算（原型 M12 / N12-06）
 * ============================================================
 * 一句话：**按主体 × 税区 × 期间，把税算出来、把算式留下来、把历史留住**。
 *
 * 六条口径（每条都是真会算错的地方）：
 *
 * ① **税率不写死在代码里**
 *    13% 是内销货物常见税率，不是所有主体所有业务都适用：美国公司没有增值税，
 *    出口货物适用免抵退，小规模纳税人另有征收率。原型明确「主体税种税率不可照抄样例」。
 *    所以税率按「主体 × 税区 × 税种 × 生效期间」配置；**没有配置就不许测算**，绝不默认 13%。
 *
 * ② **改税率不覆盖历史**
 *    新增税率时把旧记录置 `superseded`，旧测算批次引用的是当时那条。
 *    直接在原记录上改，上个月的测算会跟着变，历史就没法解释了。
 *
 * ③ **销项与进项的换算方向不一样**
 *    - 销项：利润表里的收入是**不含税**收入 → 销项 = 收入 × 税率
 *    - 进项：采购发票金额通常是**价税合计** → 进项 = 采购额 ÷ (1+税率) × 税率
 *    两个方向搞反，税额能差出一倍。
 *
 * ④ **应纳增值税为负是留抵，不是退税**
 *    `vat_payable = max(0, 销项−进项)`，差额记 `credit_carry`。
 *    把负数当"退税"是新手最容易犯的错。
 *
 * ⑤ **附加税以「应纳增值税」为基数，不是以销项**
 *    城建 + 教育 + 地方教育 = 12%（按地区不同）。基数用销项会多算好几倍。
 *
 * ⑥ **出口退税（免抵退）取小**
 *    退税 = min(出口销售额 × 退税率, 可用于退税的进项)；退不完的部分是免抵额，不产生现金。
 *    本系统没有认证/申报数据，所以只做**估算**，页面与导出都标注「估算，不等于已申报」。
 *
 * 另外：测算 ≠ 申报。确认只是「内部确认这一版数字」，不代表已经报税。
 */
const { db } = require('../db');
const { localNow, localDate } = require('./sla');
const GL = require('./gl');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const REGIONS = { CN: '中国', US: '美国', OTHER: '其他税区' };
const TAX_TYPES = {
  vat: { label: '增值税', kind: 'vat' },
  surcharge: { label: '附加税（城建+教育+地方教育）', kind: 'surcharge' },
  cit: { label: '企业所得税', kind: 'cit' },
  export_rebate: { label: '出口退税（免抵退）', kind: 'rebate' },
  stamp: { label: '印花税', kind: 'stamp' }
};
const RUN_STATUS = { draft: '草稿', confirmed: '已确认', void: '已作废' };

const isPeriod = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function nextNo(prefix, table, col) {
  const d = localDate().replace(/-/g, '');
  const head = `${prefix}${d}`;
  const row = db.prepare(`SELECT ${col} AS v FROM ${table} WHERE ${col} LIKE ? ORDER BY ${col} DESC LIMIT 1`).get(head + '%');
  const seq = row && row.v ? Number(String(row.v).slice(head.length)) + 1 : 1;
  return head + String(seq).padStart(4, '0');
}

const companyName = (id) => (id ? (db.prepare('SELECT name FROM companies WHERE id=?').get(id) || {}).name : null);
const periodEnd = (p) => `${p}-31`;
const periodStart = (p) => `${p}-01`;

/** ==================== 税政配置 ==================== */

function listPolicies(q = {}) {
  const wh = [];
  const args = [];
  if (q.company_id) { wh.push('company_id=?'); args.push(Number(q.company_id)); }
  if (q.tax_region) { wh.push('tax_region=?'); args.push(q.tax_region); }
  if (q.status) { wh.push('status=?'); args.push(q.status); }
  return db.prepare(
    `SELECT * FROM tax_policies ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY company_id, tax_region, tax_type, status='active' DESC, effective_from DESC`
  ).all(...args).map((p) => ({
    ...p,
    company_name: companyName(p.company_id),
    region_label: REGIONS[p.tax_region] || p.tax_region,
    type_label: (TAX_TYPES[p.tax_type] || {}).label || p.tax_type,
    status_label: p.status === 'active' ? '生效' : '已被替代',
    price_includes_tax_label: p.price_includes_tax ? '含税价' : '不含税价'
  }));
}

function createPolicy(b = {}, operator) {
  const companyId = Number(b.company_id);
  if (!db.prepare("SELECT id FROM companies WHERE id=? AND status='active'").get(companyId)) {
    throw new Error('主体不存在或已停用');
  }
  const region = String(b.tax_region || 'CN').toUpperCase();
  if (!REGIONS[region]) throw new Error('税区只能是 CN / US / OTHER');
  const type = String(b.tax_type || '');
  if (!TAX_TYPES[type]) throw new Error('税种不合法');
  const rate = Number(b.rate);
  if (!Number.isFinite(rate) || rate < 0) throw new Error('税率必须是 ≥0 的数字');
  if (rate > 100) throw new Error('税率不能超过 100%（填百分数，如 13 表示 13%）');
  if (!isDate(b.effective_from)) throw new Error('生效日期格式必须是 YYYY-MM-DD');
  if (b.effective_to && !isDate(b.effective_to)) throw new Error('截止日期格式必须是 YYYY-MM-DD');
  if (b.effective_to && b.effective_to < b.effective_from) throw new Error('截止日期不能早于生效日期');

  const old = db.prepare("SELECT * FROM tax_policies WHERE company_id=? AND tax_region=? AND tax_type=? AND status='active'")
    .get(companyId, region, type);

  const now = localNow();
  let id;
  db.exec('BEGIN');
  try {
    if (old) {
      // 旧政策不是删掉，是标为「已被替代」——否则历史批次的税率就无从解释
      db.prepare("UPDATE tax_policies SET status='superseded', effective_to=COALESCE(effective_to,?) WHERE id=?")
        .run(b.effective_to || b.effective_from, old.id);
    }
    id = db.prepare(
      `INSERT INTO tax_policies (company_id,tax_region,tax_type,name,rate,price_includes_tax,
         effective_from,effective_to,status,policy_no,remark,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      companyId, region, type, b.name || TAX_TYPES[type].label, rate,
      b.price_includes_tax ? 1 : 0, b.effective_from, b.effective_to || null,
      'active', b.policy_no || null, b.remark || null, operator || 'system', now
    ).lastInsertRowid;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    if (String(e.message || '').includes('UNIQUE')) throw new Error('该主体该税区该税种已有一条生效政策');
    throw e;
  }
  return listPolicies({ company_id: companyId }).find((p) => p.id === id);
}

/** 某期间生效的税率表：每类取生效日最晚的一条 */
function activeRates(companyId, region, period) {
  const start = periodStart(period);
  const end = periodEnd(period);
  const rows = db.prepare(
    `SELECT * FROM tax_policies
     WHERE company_id=? AND tax_region=? AND status='active'
       AND effective_from<=? AND (effective_to IS NULL OR effective_to='' OR effective_to>=?)
     ORDER BY tax_type, effective_from DESC`
  ).all(companyId, region, end, start);
  const out = {};
  rows.forEach((r) => { if (!out[r.tax_type]) out[r.tax_type] = r; });
  return out;
}

/** ==================== 取数 ==================== */

function monthSum(table, companyId, period, extra = '') {
  // created_at 存在两种写法（ISO 带 T 和本地空格），统一后再截月份
  return r2(db.prepare(
    `SELECT COALESCE(SUM(amount),0) s FROM ${table}
     WHERE company_id=? AND substr(REPLACE(created_at,'T',' '),1,7)=? AND COALESCE(status,'')<>'void' ${extra}`
  ).get(companyId, period).s);
}

/** ==================== 测算（不落库，给预览与保存共用） ==================== */

function compute(companyId, period, region) {
  const co = Number(companyId);
  if (!db.prepare('SELECT id FROM companies WHERE id=?').get(co)) throw new Error('主体不存在');
  if (!isPeriod(period)) throw new Error('期间格式必须是 YYYY-MM');
  const reg = String(region || 'CN').toUpperCase();
  if (!REGIONS[reg]) throw new Error('税区只能是 CN / US / OTHER');

  const rates = activeRates(co, reg, period);
  const missing = [];
  // 美国税区没有增值税，不强制要求 vat；中国税区必须有
  if (reg === 'CN' && !rates.vat) missing.push('增值税');
  if (!rates.cit) missing.push('企业所得税');
  if (reg === 'CN' && !rates.surcharge) missing.push('附加税');
  if (missing.length) {
    throw new Error(`缺少税政配置：${missing.join('、')} —— 请先在「税政配置」里按主体配税率，不会用默认税率代算`);
  }

  const pnl = GL.incomeStatement(period, co);
  const revenueTotal = r2(pnl.income_total);
  const profitTotal = r2(pnl.net_profit);
  const exportRaw = monthSum('ar_invoices', co, period, "AND currency<>'CNY'");
  // 发票与账面可能不同期：外币应收 44 万而账面收入才 21 万时，
  // 若直接减，内销收入会变负数、销项算不出来。出口收入按「收入合计」封顶。
  const exportRevenue = r2(Math.min(exportRaw, Math.max(0, revenueTotal)));
  const exportCapped = exportRaw > revenueTotal + 0.01;
  const domestic = r2(Math.max(0, revenueTotal - exportRevenue));
  const purchase = monthSum('ap_invoices', co, period);

  const vatRate = rates.vat ? Number(rates.vat.rate) : 0;
  const items = [];

  // ---- 销项：收入是不含税口径，直接乘税率 ----
  const outputTax = r2(domestic * vatRate / 100);
  if (rates.vat) {
    items.push({
      tax_type: 'vat_output', label: '销项税额',
      base_amount: domestic, rate: vatRate, amount: outputTax,
      formula: `内销收入 ${domestic.toLocaleString('zh-CN')} × ${vatRate}%`,
      source: '利润表收入合计 − 外币应收（出口）收入',
      note: exportRevenue > 0 ? `出口收入 ${exportRevenue.toLocaleString('zh-CN')} 已单独按免抵退处理，不计销项` : null
    });
  }

  // ---- 进项：采购发票金额通常是价税合计，要换算 ----
  const inputTax = r2(purchase / (1 + vatRate / 100) * vatRate / 100);
  if (rates.vat) {
    items.push({
      tax_type: 'vat_input', label: '进项税额',
      base_amount: purchase, rate: vatRate, amount: inputTax,
      formula: `采购收票 ${purchase.toLocaleString('zh-CN')} ÷ (1+${vatRate}%) × ${vatRate}%`,
      source: '本月应付发票合计（价税合计）',
      note: '按已收票估算，实际抵扣以认证结果为准'
    });
  }

  const vatPayable = r2(Math.max(0, outputTax - inputTax));
  const creditCarry = r2(Math.max(0, inputTax - outputTax));
  items.push({
    tax_type: 'vat', label: '应纳增值税',
    base_amount: r2(outputTax - inputTax), rate: null, amount: vatPayable,
    formula: `销项 ${outputTax.toLocaleString('zh-CN')} − 进项 ${inputTax.toLocaleString('zh-CN')}`,
    source: '销项 − 进项',
    note: creditCarry > 0 ? `本期留抵 ${creditCarry.toLocaleString('zh-CN')}，结转下期，不是退税` : null
  });

  // ---- 附加税：基数 = 应纳增值税 ----
  const surRate = rates.surcharge ? Number(rates.surcharge.rate) : 0;
  const surcharge = r2(vatPayable * surRate / 100);
  if (rates.surcharge) {
    items.push({
      tax_type: 'surcharge', label: '附加税',
      base_amount: vatPayable, rate: surRate, amount: surcharge,
      formula: `应纳增值税 ${vatPayable.toLocaleString('zh-CN')} × ${surRate}%`,
      source: '以应纳增值税为基数（不是销项）',
      note: '含城建税、教育费附加、地方教育附加'
    });
  }

  // ---- 企业所得税：亏损则为 0 ----
  const citRate = Number(rates.cit.rate);
  const citBase = r2(Math.max(0, profitTotal));
  const cit = r2(citBase * citRate / 100);
  items.push({
    tax_type: 'cit', label: '企业所得税',
    base_amount: citBase, rate: citRate, amount: cit,
    formula: `利润总额 ${profitTotal.toLocaleString('zh-CN')} × ${citRate}%`,
    source: '利润表：收入合计 − 费用合计',
    note: profitTotal <= 0 ? '本期亏损，应纳税额为 0，亏损可结转以后年度弥补' : null
  });

  // ---- 出口退税（免抵退）取小 ----
  const rebateRate = rates.export_rebate ? Number(rates.export_rebate.rate) : 0;
  let rebate = 0, exemptOffset = 0;
  if (rebateRate > 0 && exportRevenue > 0) {
    const theoretical = r2(exportRevenue * rebateRate / 100);
    rebate = r2(Math.min(theoretical, inputTax));
    exemptOffset = r2(theoretical - rebate);
    items.push({
      tax_type: 'export_rebate', label: '出口退税（估算）',
      base_amount: exportRevenue, rate: rebateRate, amount: rebate,
      formula: `出口收入 ${exportRevenue.toLocaleString('zh-CN')} × ${rebateRate}% = ${theoretical.toLocaleString('zh-CN')}，与进项 ${inputTax.toLocaleString('zh-CN')} 取小`,
      source: '外币应收发票（本期）',
      note: exemptOffset > 0 ? `免抵额 ${exemptOffset.toLocaleString('zh-CN')}（进项不足，退不完的部分不产生现金）` : '退税额受进项限制'
    });
  } else if (exportRevenue > 0 && rebateRate === 0) {
    items.push({
      tax_type: 'export_rebate', label: '出口退税（未配置）',
      base_amount: exportRevenue, rate: 0, amount: 0,
      formula: '本期有出口收入但未配置退税率',
      source: '外币应收发票（本期）',
      note: '请在税政配置里补出口退税率，否则这部分税负会被高估'
    });
  }

  const totalBurden = r2(vatPayable + surcharge + cit - rebate);
  const burdenRate = revenueTotal > 0 ? r2((totalBurden / revenueTotal) * 100) : 0;

  return {
    company_id: co,
    company_name: companyName(co),
    tax_region: reg,
    region_label: REGIONS[reg],
    period,
    revenue_total: revenueTotal,
    domestic_revenue: domestic,
    export_revenue: exportRevenue,
    purchase_total: purchase,
    output_tax: outputTax,
    input_tax: inputTax,
    vat_payable: vatPayable,
    credit_carry: creditCarry,
    surcharge_base: vatPayable,
    surcharge_amount: surcharge,
    profit_total: profitTotal,
    cit_amount: cit,
    rebate_amount: rebate,
    exempt_offset: exemptOffset,
    total_burden: totalBurden,
    burden_rate: burdenRate,
    items,
    rates_snapshot: Object.keys(rates).reduce((o, k) => {
      o[k] = { rate: rates[k].rate, policy_no: rates[k].policy_no, effective_from: rates[k].effective_from, id: rates[k].id };
      return o;
    }, {}),
    // 明确边界：测算不等于申报
    export_capped: exportCapped,
    warnings: [
      '本结果由系统按已入账数据与配置税率估算，不等于已申报，申报以税务机关核定为准',
      '进项按已收票估算，实际抵扣以发票认证结果为准',
      exportRevenue > 0 && rebateRate > 0 ? '出口退税为免抵退简化估算，实际以退税申报系统结果为准' : null,
      exportCapped ? `外币应收 ${exportRaw.toLocaleString('zh-CN')} 大于账面收入 ${revenueTotal.toLocaleString('zh-CN')}，出口收入已按收入合计封顶，请核对应收与收入是否同期入账` : null,
      profitTotal <= 0 ? '本期利润为负，企业所得税按 0 计，亏损可结转以后年度弥补' : null,
      totalBurden < 0 ? '本期出口退税大于应纳税额，合计税负为负，属正常（退税是现金流入，不是收入）' : null,
      // 税负率明显偏高，十有八九是进项票没收齐或成本没入账 —— 这正是测算要找出来的问题
      burdenRate > 15 ? `税负率 ${burdenRate}% 明显偏高，常见原因是进项发票未收齐或成本费用尚未入账，请先核这两项再对外解释` : null
    ].filter(Boolean)
  };
}

/** 保存测算批次：同一主体/税区/期间的草稿只留一份，旧草稿置作废 */
function saveRun(companyId, period, region, b = {}, operator) {
  const calc = compute(companyId, period, region);
  const co = calc.company_id;
  const reg = calc.tax_region;

  const confirmed = db.prepare("SELECT * FROM tax_runs WHERE company_id=? AND tax_region=? AND period=? AND status='confirmed'")
    .get(co, reg, period);
  if (confirmed) {
    throw new Error(`该期间已确认过测算（${confirmed.run_no}），要重算请先作废那一版`);
  }

  const now = localNow();
  let id;
  db.exec('BEGIN');
  try {
    const drafts = db.prepare("SELECT id FROM tax_runs WHERE company_id=? AND tax_region=? AND period=? AND status='draft'").all(co, reg, period);
    drafts.forEach((d) => db.prepare("UPDATE tax_runs SET status='void', note=COALESCE(note,'')||' 重算作废' WHERE id=?").run(d.id));

    id = db.prepare(
      `INSERT INTO tax_runs (run_no,company_id,tax_region,period,revenue_total,domestic_revenue,export_revenue,
         output_tax,input_tax,vat_payable,credit_carry,surcharge_base,surcharge_amount,profit_total,cit_amount,
         rebate_amount,exempt_offset,total_burden,burden_rate,status,policy_json,note,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      nextNo('TAX', 'tax_runs', 'run_no'), co, reg, period, calc.revenue_total, calc.domestic_revenue, calc.export_revenue,
      calc.output_tax, calc.input_tax, calc.vat_payable, calc.credit_carry, calc.surcharge_base, calc.surcharge_amount,
      calc.profit_total, calc.cit_amount, calc.rebate_amount, calc.exempt_offset, calc.total_burden, calc.burden_rate,
      'draft', JSON.stringify(calc.rates_snapshot), b.note || null, operator || 'system', now
    ).lastInsertRowid;

    const ins = db.prepare(
      'INSERT INTO tax_run_items (run_id,seq,tax_type,label,base_amount,rate,amount,formula,source,note) VALUES (?,?,?,?,?,?,?,?,?,?)'
    );
    calc.items.forEach((it, i) => {
      ins.run(id, i + 1, it.tax_type, it.label, it.base_amount, it.rate, it.amount, it.formula, it.source, it.note || null);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getRun(id);
}

function shapeRun(r) {
  return {
    ...r,
    company_name: companyName(r.company_id),
    region_label: REGIONS[r.tax_region] || r.tax_region,
    status_label: RUN_STATUS[r.status] || r.status
  };
}

function listRuns(q = {}) {
  const wh = [];
  const args = [];
  if (q.company_id) { wh.push('company_id=?'); args.push(Number(q.company_id)); }
  if (q.tax_region) { wh.push('tax_region=?'); args.push(q.tax_region); }
  if (q.period) { wh.push('period=?'); args.push(q.period); }
  if (q.status) { wh.push('status=?'); args.push(q.status); }
  return db.prepare(
    `SELECT * FROM tax_runs ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY period DESC, company_id, id DESC LIMIT 200`
  ).all(...args).map(shapeRun);
}

function getRun(id) {
  const r = db.prepare('SELECT * FROM tax_runs WHERE id=?').get(Number(id));
  if (!r) return null;
  let policy = null;
  try { policy = r.policy_json ? JSON.parse(r.policy_json) : null; } catch (e) { policy = null; }
  return {
    ...shapeRun(r),
    items: db.prepare('SELECT * FROM tax_run_items WHERE run_id=? ORDER BY seq').all(r.id),
    policy
  };
}

function confirmRun(id, b = {}, operator) {
  const r = db.prepare('SELECT * FROM tax_runs WHERE id=?').get(Number(id));
  if (!r) throw new Error('测算批次不存在');
  if (r.status !== 'draft') throw new Error('只有草稿可以确认');
  const note = String(b.note || '').trim();
  db.prepare("UPDATE tax_runs SET status='confirmed', confirmed_by=?, confirmed_at=?, note=COALESCE(?,note) WHERE id=?")
    .run(operator || 'system', localNow(), note || null, r.id);
  return getRun(r.id);
}

function voidRun(id, b = {}) {
  const r = db.prepare('SELECT * FROM tax_runs WHERE id=?').get(Number(id));
  if (!r) throw new Error('测算批次不存在');
  if (r.status === 'void') throw new Error('已经是作废状态');
  const reason = String(b.reason || '').trim();
  if (!reason) throw new Error('作废必须写原因');
  db.prepare("UPDATE tax_runs SET status='void', note=COALESCE(note,'')||? WHERE id=?")
    .run(` 作废：${reason}`, r.id);
  return getRun(r.id);
}

/** 趋势：近 N 期同主体同税区，只算已确认优先、否则草稿 */
function trend(companyId, region, months = 6) {
  const co = Number(companyId);
  const reg = String(region || 'CN').toUpperCase();
  const rows = db.prepare(
    `SELECT * FROM tax_runs WHERE company_id=? AND tax_region=? AND status<>'void'
     ORDER BY period DESC, (CASE status WHEN 'confirmed' THEN 0 ELSE 1 END), id DESC`
  ).all(co, reg);
  const seen = new Set();
  const picked = [];
  rows.forEach((r) => {
    if (seen.has(r.period)) return;
    seen.add(r.period);
    picked.push(shapeRun(r));
  });
  return picked.slice(0, Math.min(24, Number(months) || 6)).reverse();
}

function overview() {
  const today = localDate();
  const period = today.slice(0, 7);
  const companies = db.prepare("SELECT id, name, type FROM companies WHERE status='active' ORDER BY id").all();
  const rows = companies.map((c) => {
    const policies = db.prepare("SELECT COUNT(*) n FROM tax_policies WHERE company_id=? AND status='active'").get(c.id).n;
    const regions = db.prepare("SELECT DISTINCT tax_region r FROM tax_policies WHERE company_id=? AND status='active'").all(c.id).map((x) => x.r);
    const last = db.prepare(
      "SELECT * FROM tax_runs WHERE company_id=? AND status<>'void' ORDER BY period DESC, id DESC LIMIT 1"
    ).get(c.id);
    const cur = db.prepare("SELECT * FROM tax_runs WHERE company_id=? AND period=? AND status<>'void' ORDER BY id DESC LIMIT 1").get(c.id, period);
    return {
      company_id: c.id, company_name: c.name, type: c.type,
      policy_cnt: policies,
      regions: regions.map((r) => REGIONS[r] || r),
      configured: policies > 0,
      period,
      current: cur ? shapeRun(cur) : null,
      last: last ? shapeRun(last) : null
    };
  });
  const pending = db.prepare("SELECT COUNT(*) n FROM tax_runs WHERE status='draft'").get().n;
  const confirmed = db.prepare("SELECT COUNT(*) n FROM tax_runs WHERE status='confirmed'").get().n;
  const noPolicy = rows.filter((r) => !r.configured).length;
  return {
    period,
    companies: rows,
    pending,
    confirmed,
    no_policy: noPolicy,
    total_burden_this_period: r2(rows.reduce((s, r) => s + (r.current ? r.current.total_burden : 0), 0)),
    note: '测算结果用于内部判断税负水平，不等于已申报；申报以税务机关核定为准'
  };
}

function dict() {
  return {
    companies: db.prepare("SELECT id, code, name, type FROM companies WHERE status='active' ORDER BY id").all(),
    regions: Object.entries(REGIONS).map(([k, v]) => ({ key: k, label: v })),
    tax_types: Object.entries(TAX_TYPES).map(([k, v]) => ({ key: k, label: v.label })),
    run_status: Object.entries(RUN_STATUS).map(([k, v]) => ({ key: k, label: v })),
    today: localDate()
  };
}

/** 申报底稿 CSV（给人拿去核对，不是给税局直报） */
function exportCsv(id) {
  const r = getRun(id);
  if (!r) throw new Error('测算批次不存在');
  const lines = [];
  lines.push(`税负测算底稿,${r.run_no}`);
  lines.push(`主体,${r.company_name}`);
  lines.push(`税区,${r.region_label}`);
  lines.push(`期间,${r.period}`);
  lines.push(`状态,${r.status_label}`);
  lines.push('');
  lines.push('税种,计税依据,税率%,税额,算式,取数来源,备注');
  r.items.forEach((it) => {
    lines.push([it.label, it.base_amount, it.rate === null ? '' : it.rate, it.amount, it.formula, it.source, it.note || '']
      .map((x) => `"${String(x === null || x === undefined ? '' : x).replace(/"/g, '""')}"`).join(','));
  });
  lines.push('');
  lines.push(`收入合计,${r.revenue_total}`);
  lines.push(`其中出口,${r.export_revenue}`);
  lines.push(`合计税负,${r.total_burden}`);
  lines.push(`税负率%,${r.burden_rate}`);
  lines.push('');
  lines.push('说明,本底稿由系统按已入账数据与配置税率估算，不等于已申报；申报以税务机关核定为准');
  return '\ufeff' + lines.join('\n');
}

module.exports = {
  listPolicies, createPolicy, activeRates,
  compute, saveRun, listRuns, getRun, confirmRun, voidRun, trend,
  overview, dict, exportCsv,
  REGIONS, TAX_TYPES, RUN_STATUS
};
