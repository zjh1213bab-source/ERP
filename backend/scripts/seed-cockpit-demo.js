/**
 * 经营驾驶舱演示数据：账龄分散 + 现金缺口
 * ------------------------------------------------------------
 * 造数据的关键是「让账龄真的分散」：
 *   应收按开票日拉开（6 月 / 7 月 / 8 月 / 9 月 / 10 月），到期日相应错开，
 *   于是账龄自然落到 未到期 / 1-30 / 31-60 / 61-90 / 90+ 五档。
 *
 * 第二步是「让总账对得上」：应收应付是历史导入的，没有对应凭证，
 * 如果不管，财务页面的「应收科目余额 = 未收发票余额」检查立刻报红。
 * 所以脚本最后会算差额，自动补一张「期初往来导入」凭证：
 *   应收导入：借 1122 应收账款 / 贷 4103 本年利润（以前年度赚的还没收的钱）
 *   应付导入：借 1403 原材料   / 贷 2202 应付账款（以前年度欠的钱对应着存货）
 * 这样资产负债表保持平衡（资产与负债/权益同增）。
 *
 * 用法：node scripts/seed-cockpit-demo.js --reset
 */
const { db } = require('../src/db');
const G = require('../src/services/gl');
const C = require('../src/services/cockpit');
const { localNow, localDate } = require('../src/services/sla');

const TAG = 'COCKPITDEMO';
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const RESET = process.argv.includes('--reset');

function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function reset() {
  const arIds = db.prepare("SELECT id FROM ar_invoices WHERE remark LIKE ?").all(`%${TAG}%`).map((x) => x.id);
  const apIds = db.prepare("SELECT id FROM ap_invoices WHERE remark LIKE ?").all(`%${TAG}%`).map((x) => x.id);
  // 先删凭证（期初导入凭证），再删发票，避免留下「凭证在、单据没了」
  db.prepare("DELETE FROM gl_entries WHERE voucher_id IN (SELECT id FROM gl_vouchers WHERE summary LIKE ?)").run(`%${TAG}%`);
  db.prepare("DELETE FROM gl_vouchers WHERE summary LIKE ?").run(`%${TAG}%`);
  db.prepare("DELETE FROM ar_invoices WHERE remark LIKE ?").run(`%${TAG}%`);
  db.prepare("DELETE FROM ap_invoices WHERE remark LIKE ?").run(`%${TAG}%`);
  db.prepare("DELETE FROM cash_forecasts WHERE note LIKE ?").run(`%${TAG}%`);
  db.prepare("DELETE FROM cash_forecast_items WHERE forecast_id NOT IN (SELECT id FROM cash_forecasts)").run();
  db.prepare("DELETE FROM kpi_snapshots WHERE caliber LIKE ?").run('%驾驶舱演示%');
  db.prepare("DELETE FROM customers WHERE code LIKE 'CPDEMO%'").run();
  db.prepare("DELETE FROM suppliers WHERE code LIKE 'CPDEMO%'").run();
  return { ar: arIds.length, ap: apIds.length };
}

function main() {
  const out = [];
  const t = localNow();
  const today = localDate();
  const HQ = db.prepare("SELECT id FROM companies WHERE type='headquarters' LIMIT 1").get()?.id || 1;

  // ---------- 客户档案（分散集中度）----------
  const ensureCustomer = (code, name, level) => {
    const old = db.prepare('SELECT id FROM customers WHERE code=?').get(code);
    if (old) return old.id;
    return db.prepare(
      'INSERT INTO customers (code,name,contact,phone,level,credit_limit,status,company_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(code, name, '—', '—', level, 3000000, 'active', HQ, t, t).lastInsertRowid;
  };
  const ensureSupplier = (code, name) => {
    const old = db.prepare('SELECT id FROM suppliers WHERE code=?').get(code);
    if (old) return old.id;
    const cols = db.prepare('pragma table_info(suppliers)').all().map((c) => c.name);
    const fields = ['code', 'name'];
    const vals = [code, name];
    if (cols.includes('status')) { fields.push('status'); vals.push('active'); }
    if (cols.includes('created_at')) { fields.push('created_at'); vals.push(t); }
    return db.prepare(`INSERT INTO suppliers (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
      .run(...vals).lastInsertRowid;
  };

  const cus1 = ensureCustomer('CPDEMO01', 'West Coast Apparel Inc.', 'A');
  const cus2 = ensureCustomer('CPDEMO02', 'Nordic Textile AB', 'A');
  const cus3 = ensureCustomer('CPDEMO03', 'Tokyo Mode Co., Ltd.', 'B');
  const cus4 = ensureCustomer('CPDEMO04', 'Dubai Fashion LLC', 'C');
  const sup1 = ensureSupplier('CPDEMO05', '绍兴恒信纺织有限公司');
  const sup2 = ensureSupplier('CPDEMO06', '宁波华美辅料有限公司');
  const sup3 = ensureSupplier('CPDEMO07', '义乌五金包装厂');
  out.push('客户 4 家 / 供应商 3 家（分散集中度，避免单一客户占比过高）');

  // ---------- 应收：按开票日拉开，落到五档 ----------
  // [客户, 名称, 开票距今天数, 账期天数, 金额, 已收]
  const arPlan = [
    [cus1, 'West Coast Apparel Inc.', 200, 60, 268000, 0],      // 逾期 ~140 天
    [cus2, 'Nordic Textile AB', 120, 45, 186000, 60000],        // 逾期 ~75 天
    [cus3, 'Tokyo Mode Co., Ltd.', 80, 30, 142000, 0],          // 逾期 ~50 天
    [cus4, 'Dubai Fashion LLC', 55, 30, 96500, 0],              // 逾期 ~25 天
    [cus1, 'West Coast Apparel Inc.', 28, 30, 132000, 40000],   // 逾期 ~0 天（刚到期）
    [cus2, 'Nordic Textile AB', 12, 45, 210000, 0],             // 未到期
    [cus3, 'Tokyo Mode Co., Ltd.', 5, 60, 158000, 0]            // 未到期
  ];

  const mkAr = db.prepare(
    `INSERT INTO ar_invoices (bill_no,order_id,customer_id,customer_name,amount,paid_amount,due_date,status,
       source,remark,created_by,created_at,updated_at,currency,amount_orig,rate,company_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let arTotal = 0;
  arPlan.forEach((p, i) => {
    const [cid, cname, agoDays, term, amount, paid] = p;
    const billDate = addDays(today, -agoDays);
    const dueDate = addDays(billDate, term);
    const billNo = `CP${billDate.replace(/-/g, '')}${String(i + 1).padStart(3, '0')}`;
    if (db.prepare('SELECT id FROM ar_invoices WHERE bill_no=?').get(billNo)) return;
    const status = paid >= amount ? 'paid' : paid > 0 ? 'partial' : 'open';
    mkAr.run(billNo, null, cid, cname, amount, paid, dueDate, status,
      'manual', `${TAG} 历史应收导入`, 'seed', `${billDate} 10:00:00`, t, 'CNY', amount, 1, HQ);
    arTotal = r2(arTotal + amount - paid);
  });
  out.push(`应收 7 张：账龄跨 未到期 / 1-30 / 31-60 / 61-90 / 90+ 五档，未收合计 ${arTotal}`);

  // ---------- 应付：与现金缺口配套 ----------
  // 到期日刻意排开：让现金缺口落在第 4-5 周（前 3 周有缓冲，看起来才可信）
  const apPlan = [
    [sup2, '宁波华美辅料有限公司', 45, 30, 268000],   // 逾期 15 天 → 第 1 周被催付
    [sup1, '绍兴恒信纺织有限公司', 90, 30, 120000],   // 逾期 60 天 → 第 3 周
    [sup1, '绍兴恒信纺织有限公司', 8, 30, 415000],    // 未到期 → 第 4 周（大额，制造缺口）
    [sup3, '义乌五金包装厂', 5, 45, 236000],          // 未到期 → 第 6 周
    [sup2, '宁波华美辅料有限公司', 5, 60, 312000]     // 未到期 → 第 8 周
  ];
  const cols = db.prepare('pragma table_info(ap_invoices)').all().map((c) => c.name);
  const mkAp = (o) => {
    const use = Object.keys(o).filter((k) => cols.includes(k));
    db.prepare(`INSERT INTO ap_invoices (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`)
      .run(...use.map((k) => o[k]));
  };
  let apTotal = 0;
  apPlan.forEach((p, i) => {
    const [sid, sname, agoDays, term, amount] = p;
    const billDate = addDays(today, -agoDays);
    const dueDate = addDays(billDate, term);
    const billNo = `CPAP${billDate.replace(/-/g, '')}${String(i + 1).padStart(3, '0')}`;
    if (db.prepare('SELECT id FROM ap_invoices WHERE bill_no=?').get(billNo)) return;
    mkAp({
      bill_no: billNo, purchase_id: null, supplier_id: sid, supplier_name: sname,
      amount, paid_amount: 0, due_date: dueDate, status: 'open', source: 'manual',
      remark: `${TAG} 历史应付导入`, created_by: 'seed',
      created_at: `${billDate} 10:00:00`, updated_at: t,
      currency: 'CNY', amount_orig: amount, rate: 1, company_id: HQ
    });
    apTotal = r2(apTotal + amount);
  });
  out.push(`应付 5 张：最大一笔 41.5 万在 10 天后到期，用来制造现金缺口；未付合计 ${apTotal}`);

  // ---------- 补齐总账：期初往来导入凭证 ----------
  const period = today.slice(0, 7);
  G.ensurePeriod(period, HQ);
  const acctBal = (code) => r2(
    num(db.prepare(
      `SELECT COALESCE(SUM(e.debit-e.credit),0) s FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
       WHERE v.status='posted' AND e.account_code=? AND e.company_id=? AND v.biz_date<=?`
    ).get(code, HQ, today).s)
  );
  const arInvOpen = r2(num(db.prepare(
    "SELECT COALESCE(SUM(amount-COALESCE(paid_amount,0)),0) s FROM ar_invoices WHERE status<>'void' AND company_id=? AND substr(created_at,1,10)<=?"
  ).get(HQ, today).s));
  const apInvOpen = r2(num(db.prepare(
    "SELECT COALESCE(SUM(amount-COALESCE(paid_amount,0)),0) s FROM ap_invoices WHERE status<>'void' AND company_id=? AND substr(created_at,1,10)<=?"
  ).get(HQ, today).s));

  const arDiff = r2(arInvOpen - acctBal('1122'));
  const apDiff = r2(apInvOpen - acctBal('2202'));
  const fixes = [];

  if (Math.abs(arDiff) > 0.01) {
    // 应收比账面多 → 补资产；少 → 冲回
    const entries = arDiff > 0
      ? [
          { code: '1122', debit: arDiff, credit: 0, summary: '期初应收导入' },
          { code: '4103', debit: 0, credit: arDiff, summary: '以前年度未收货款结转' }
        ]
      : [
          { code: '1122', debit: 0, credit: -arDiff, summary: '期初应收冲回' },
          { code: '4103', debit: -arDiff, credit: 0, summary: '以前年度未收货款冲回' }
        ];
    G.writeVoucher({
      period, biz_date: today, summary: `${TAG} 期初往来导入（应收）`,
      source_type: 'manual', source_id: null, entries, operator: 'seed', company_id: HQ
    });
    fixes.push(`应收差额 ${arDiff} 已补凭证（借 1122 / 贷 4103）`);
  }

  if (Math.abs(apDiff) > 0.01) {
    // 应付比账面多 → 补负债，同时补存货（不能凭空多负债，否则报表不平）
    const entries = apDiff > 0
      ? [
          { code: '1403', debit: apDiff, credit: 0, summary: '期初存货导入' },
          { code: '2202', debit: 0, credit: apDiff, summary: '期初应付导入' }
        ]
      : [
          { code: '1403', debit: 0, credit: -apDiff, summary: '期初存货冲回' },
          { code: '2202', debit: -apDiff, credit: 0, summary: '期初应付冲回' }
        ];
    G.writeVoucher({
      period, biz_date: today, summary: `${TAG} 期初往来导入（应付）`,
      source_type: 'manual', source_id: null, entries, operator: 'seed', company_id: HQ
    });
    fixes.push(`应付差额 ${apDiff} 已补凭证（借 1403 存货 / 贷 2202 应付，保持报表平衡）`);
  }
  out.push(fixes.length ? fixes.join('；') : '总账已与发票一致，无需补凭证');

  // ---------- 自检：账账相符 ----------
  const chkAr = r2(acctBal('1122') + (arDiff > 0 ? arDiff : 0) - (arDiff < 0 ? -arDiff : 0));
  const bs = G.balanceSheet(period, HQ);
  out.push(`自检：资产负债表 ${bs.balanced ? '平衡 ✓' : '不平 ' + bs.diff + ' ✗'}（资产 ${bs.asset_total} = 负债 ${bs.liability_total} + 权益 ${bs.equity_total}）`);

  // ---------- 账龄实况 ----------
  const ar = C.aging('ar', { company_id: HQ });
  const ap = C.aging('ap', { company_id: HQ });
  out.push(`应收账龄：未到期 ${ar.buckets[0].amount} / 1-30 ${ar.buckets[1].amount} / 31-60 ${ar.buckets[2].amount} / 61-90 ${ar.buckets[3].amount} / 90+ ${ar.buckets[4].amount}`);
  out.push(`逾期占比 ${ar.overdue_pct}%，平均账龄 ${ar.avg_age_days} 天，平均逾期 ${ar.avg_overdue_days} 天`);

  // ---------- 生成预测（应出现缺口）----------
  const fc = C.buildForecast({ base_date: today, weeks: 13, company_id: HQ, note: `${TAG} 演示预测` }, 'seed');
  out.push(`现金预测 ${fc.forecast_no}：期初 ${fc.opening_cash}，13 周流入 ${fc.inflow_total} / 流出 ${fc.outflow_total}`);
  out.push(fc.gap_amount > 0.01
    ? `⚠ 第 ${fc.first_neg_week} 周现金转负，最深缺口 ${fc.gap_amount}（第 ${fc.min_week} 周）—— 这是要演示的预警`
    : `最低现金 ${fc.min_cash}（未出现缺口）`);

  // ---------- 再跑一份「基准日在 8 周前」的预测，用于回看对比 ----------
  // 只跑今天的预测没有「已过去的周」，回看页会是空的 —— 必须有历史批次才能演示达成率
  const pastBase = addDays(today, -56);
  const fcPast = C.buildForecast({ base_date: pastBase, weeks: 8, company_id: HQ, note: `${TAG} 历史预测（用于回看）` }, 'seed');
  out.push(`历史预测 ${fcPast.forecast_no}（基准 ${pastBase}）：已过 8 周，可在「预测回看」看达成率`);
  out.push('注意：演示用的历史预测是按「当前应收数据」回推的（真实使用时是当时的数据快照），所以达成率偏低是正常的');

  // ---------- 指标快照 ----------
  const snap = C.snapshotKpis(period, HQ, 'seed');
  out.push(`经营指标快照 ${snap.saved} 项（毛利率 / 周转天数 / 现金转换周期 / 客户集中度 / 人效）`);

  console.log(`\n经营驾驶舱演示数据${RESET ? '（已重置）' : ''}：`);
  out.forEach((x) => console.log('  ·', x));
  console.log('');
}

if (RESET) {
  const r = reset();
  console.log(`清理旧数据：应收 ${r.ar} 张 / 应付 ${r.ap} 张`);
}
main();
