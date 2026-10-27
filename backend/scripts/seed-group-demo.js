/**
 * 多主体与合并演示数据
 * ------------------------------------------------------------
 * 造两家分公司，各有自己的账：
 *   义乌分公司（C2）：卖 80 万给美国分公司 → 记应收 80 万、收入 80 万
 *   美国分公司（C3）：从义乌买 → 只记应付 75 万、成本 75 万（**故意少记 5 万**）
 *                    另外卖给外部客户 80 万
 *
 * 于是内部往来：义乌应收 80 万 vs 美国应付 75 万 → 差 5 万。
 * 合并时按「取小抵消」抵 75 万，剩下 5 万**不抹平**，作为差异留在报表里 —— 这正是要演示的：
 *   **合并报表会因为两边都虚增 5 万而仍然平衡，但金额是错的。**
 *   所以合并页要同时看「是否平衡」和「内部往来差异笔数」，单看平衡度是查不出这种问题的。
 *
 * 用法：node scripts/seed-group-demo.js --reset
 */
const { db } = require('../src/db');
const G = require('../src/services/gl');
const { localNow } = require('../src/services/sla');

const TAG = 'GROUPDEMO';
const P0 = '2026-09';   // 演示期间
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const RESET = process.argv.includes('--reset');

function reset() {
  const ids = db.prepare("SELECT id FROM companies WHERE code IN ('YW-BR','US-SUB')").all().map((x) => x.id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    // 先把凭证与分录清掉（含手工期初）
    db.prepare(`DELETE FROM gl_entries WHERE company_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM gl_vouchers WHERE company_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM gl_balances WHERE company_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM gl_close_checks WHERE company_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM gl_periods WHERE company_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM ar_invoices WHERE company_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM ap_invoices WHERE company_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM intercompany_parties WHERE company_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM departments WHERE company_id IN (${ph}) AND name LIKE '%演示%'`).run(...ids);
  }
  db.prepare("DELETE FROM intercompany_links WHERE created_by='auto' AND period=?").run(P0);
  // 合并批次全清：演示只保留本次生成的那一条，否则历史里会堆一串同样的批次
  db.prepare('DELETE FROM consolidation_adjustments WHERE con_id IN (SELECT id FROM consolidations)').run();
  db.prepare('DELETE FROM consolidations').run();
  db.prepare("DELETE FROM customers WHERE code LIKE 'GCDEMO%'").run();
  db.prepare("DELETE FROM suppliers WHERE code LIKE 'GCDEMO%'").run();
}

function main() {
  const out = [];
  const t = localNow();

  // ---------- 1. 两家分公司 ----------
  const ensureCompany = (code, name, type, opts = {}) => {
    const old = db.prepare('SELECT id FROM companies WHERE code=?').get(code);
    if (old) {
      db.prepare(
        `UPDATE companies SET name=?, short_name=?, type=?, tax_no=?, legal_person=?, base_currency=?,
           consolidation=?, parent_id=?, open_period=?, status='active', addr=?, phone=? WHERE id=?`
      ).run(name, opts.short || name, type, opts.tax_no || null, opts.legal || null, opts.currency || 'CNY',
        opts.consolidation === false ? 0 : 1, opts.parent_id || 1, opts.open_period || P0,
        opts.addr || null, opts.phone || null, old.id);
      return old.id;
    }
    return db.prepare(
      `INSERT INTO companies (code,name,short_name,type,tax_no,legal_person,base_currency,consolidation,
         parent_id,open_period,status,addr,phone,remark,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(code, name, opts.short || name, type, opts.tax_no || null, opts.legal || null, opts.currency || 'CNY',
      opts.consolidation === false ? 0 : 1, opts.parent_id || 1, opts.open_period || P0,
      'active', opts.addr || null, opts.phone || null, `${TAG} 演示主体`, t, t).lastInsertRowid;
  };

  const HQ = db.prepare("SELECT id FROM companies WHERE type='headquarters' LIMIT 1").get()?.id || 1;
  const C2 = ensureCompany('YW-BR', '跳色科技（义乌）分公司', 'branch', {
    short: '义乌分公司', tax_no: '91330782MA2GCDEMO1', legal: '陈明',
    addr: '浙江省义乌市北苑街道', phone: '0579-8555 0101', parent_id: HQ, open_period: P0
  });
  const C3 = ensureCompany('US-SUB', 'Tiaose USA LLC', 'subsidiary', {
    short: '美国子公司', tax_no: 'US-EIN-88-1234567', legal: 'Li Wei', currency: 'USD',
    addr: '1200 S San Pedro St, Los Angeles, CA', phone: '+1 213-555-0188',
    parent_id: HQ, open_period: P0
  });
  out.push(`主体：总部 #${HQ} / 义乌分公司 #${C2} / 美国子公司 #${C3}`);

  // 部门（让预算/人事能挂得上）
  [C2, C3].forEach((cid, i) => {
    const name = i === 0 ? '义乌生产演示部' : '美国运营演示部';
    if (!db.prepare('SELECT id FROM departments WHERE company_id=? AND name=?').get(cid, name)) {
      db.prepare('INSERT INTO departments (company_id,name,created_at) VALUES (?,?,?)').run(cid, name, t);
    }
  });

  // ---------- 2. 客户与供应商档案 ----------
  const ensureCustomer = (code, name, companyId) => {
    const old = db.prepare('SELECT id FROM customers WHERE code=?').get(code);
    if (old) {
      db.prepare('UPDATE customers SET name=?, company_id=? WHERE id=?').run(name, companyId, old.id);
      return old.id;
    }
    return db.prepare(
      'INSERT INTO customers (code,name,contact,phone,level,credit_limit,status,company_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(code, name, '—', '—', 'A', 5000000, 'active', companyId, t, t).lastInsertRowid;
  };
  const ensureSupplier = (code, name) => {
    const old = db.prepare('SELECT id FROM suppliers WHERE code=?').get(code);
    if (old) return old.id;
    const cols = db.prepare('pragma table_info(suppliers)').all().map((c) => c.name);
    const fields = ['code', 'name'];
    const vals = [code, name];
    if (cols.includes('status')) { fields.push('status'); vals.push('active'); }
    if (cols.includes('created_at')) { fields.push('created_at'); vals.push(t); }
    return db.prepare(
      `INSERT INTO suppliers (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`
    ).run(...vals).lastInsertRowid;
  };

  const cusUsInYw = ensureCustomer('GCDEMO01', 'Tiaose USA LLC（集团内）', C2);   // 义乌账上的客户 = 美国子公司
  const cusUsOut = ensureCustomer('GCDEMO02', 'West Coast Apparel Inc.', C3);      // 美国账上的外部客户
  const supYwInUs = ensureSupplier('GCDEMO03', '跳色科技（义乌）分公司');           // 美国账上的供应商 = 义乌
  out.push('档案：义乌账上客户=美国子公司；美国账上客户=外部买家、供应商=义乌分公司');

  // ---------- 3. 内部往来单位（双向登记） ----------
  const ensureParty = (companyId, counterId, kind, refName, refId) => {
    const old = db.prepare('SELECT id FROM intercompany_parties WHERE company_id=? AND ref_name=?').get(companyId, refName);
    if (old) return old.id;
    return db.prepare(
      `INSERT INTO intercompany_parties (company_id,counter_company_id,kind,ref_type,ref_id,ref_name,match_key,
         offset_account,status,note,created_at)
       VALUES (?,?,?,?,?,?,?,?,'active',?,?)`
    ).run(companyId, counterId, kind, 'customer', refId, refName, refName,
      kind === 'supplier' ? '2202' : '1122', `${TAG} 内部往来`, t).lastInsertRowid;
  };
  ensureParty(C2, C3, 'customer', 'Tiaose USA LLC（集团内）', cusUsInYw);
  ensureParty(C3, C2, 'supplier', '跳色科技（义乌）分公司', supYwInUs);
  out.push('内部往来单位：义乌→美国（客户）、美国→义乌（供应商），双向登记才能配对');

  // ---------- 4. 期初：实收资本 ----------
  const seedCapital = (companyId, amount, label) => {
    const has = db.prepare(
      "SELECT COUNT(*) c FROM gl_vouchers WHERE company_id=? AND period=? AND summary LIKE ?"
    ).get(companyId, P0, `%${label}%`).c;
    if (has) return;
    G.ensurePeriod(P0, companyId);
    G.writeVoucher({
      period: P0, biz_date: `${P0}-01`, summary: `${label}（${TAG}）`,
      source_type: 'manual', source_id: null,
      entries: [
        { code: '1002', debit: amount, credit: 0, summary: '股东投入' },
        { code: '4001', debit: 0, credit: amount, summary: '实收资本' }
      ],
      operator: 'seed', company_id: companyId
    });
  };
  seedCapital(C2, 500000, '义乌分公司期初实收资本');
  seedCapital(C3, 1000000, '美国子公司期初实收资本');
  out.push('期初：义乌实收 50 万 / 美国实收 100 万（各写一张手工凭证）');

  // ---------- 5. 内部销售 / 采购 / 对外销售（用发票驱动凭证） ----------
  const mkAr = (billNo, companyId, customerId, customerName, amount) => {
    if (db.prepare('SELECT id FROM ar_invoices WHERE bill_no=?').get(billNo)) return;
    db.prepare(
      `INSERT INTO ar_invoices (bill_no,order_id,customer_id,customer_name,amount,paid_amount,due_date,status,
         source,remark,created_by,created_at,updated_at,currency,amount_orig,rate,company_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(billNo, null, customerId, customerName, amount, 0, `${P0}-30`, 'open',
      'manual', `${TAG} 内部往来演示`, 'seed', `${P0}-15 10:00:00`, t, 'CNY', amount, 1, companyId);
  };
  // 义乌卖给美国子公司 80 万
  mkAr(`GCDEMO-AR-YW-${P0.replace('-', '')}`, C2, cusUsInYw, 'Tiaose USA LLC（集团内）', 800000);
  // 美国卖给外部客户 80 万
  mkAr(`GCDEMO-AR-US-${P0.replace('-', '')}`, C3, cusUsOut, 'West Coast Apparel Inc.', 800000);

  const mkAp = (billNo, companyId, supplierId, supplierName, amount) => {
    if (db.prepare('SELECT id FROM ap_invoices WHERE bill_no=?').get(billNo)) return;
    const cols = db.prepare('pragma table_info(ap_invoices)').all().map((c) => c.name);
    const want = {
      bill_no: billNo, purchase_id: null, supplier_id: supplierId, supplier_name: supplierName,
      amount, paid_amount: 0, due_date: `${P0}-30`, status: 'open', source: 'manual',
      remark: `${TAG} 内部采购演示（故意比义乌少记 5 万）`, created_by: 'seed',
      created_at: `${P0}-15 10:00:00`, updated_at: t, currency: 'CNY', amount_orig: amount, rate: 1,
      company_id: companyId
    };
    const use = Object.keys(want).filter((k) => cols.includes(k));
    db.prepare(
      `INSERT INTO ap_invoices (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`
    ).run(...use.map((k) => want[k]));
  };
  // 美国从义乌采购：义乌开 80 万，美国**只记 75 万** → 内部往来差 5 万
  mkAp(`GCDEMO-AP-US-${P0.replace('-', '')}`, C3, supYwInUs, '跳色科技（义乌）分公司', 750000);
  out.push('发票：义乌应收美国 80 万 / 美国应收外部 80 万 / 美国应付义乌 75 万（差 5 万）');

  // ---------- 6. 各主体生成凭证 ----------
  const gen = [];
  [C2, C3].forEach((cid) => {
    const r = G.generateVouchers(P0, { operator: 'seed', company_id: cid, types: ['ar_invoice', 'ap_invoice'] });
    gen.push(`${G.companyName(cid)}: 新建 ${r.created} 张${r.failed.length ? '（失败 ' + r.failed.join(';') + '）' : ''}`);
  });
  out.push('凭证生成 → ' + gen.join(' / '));

  // ---------- 7. 义乌关账（演示「一家关了一家没关」） ----------
  let closeMsg = '';
  try {
    // 关账前必须先结转损益，否则「损益类科目已结转」这项检查一定不过
    G.carryProfit(P0, 'seed', C2);
    const r = G.closePeriod(P0, 'seed', C2);
    closeMsg = `义乌 ${P0} 已关账（${r.voucher_count} 张凭证，利润 ${r2(r.profit)}）`;
  } catch (e) {
    closeMsg = `义乌关账未通过：${e.message}`;
  }
  out.push(closeMsg);

  // ---------- 8. 内部往来配对 ----------
  const GR = require('../src/services/group');
  const sc = GR.scanIntercompany(P0, 'seed');
  out.push(`内部往来扫描：${sc.pairs} 对，已平 ${sc.matched}，有差异 ${sc.diff}（合计差 ${sc.diff_amount}）`);

  // ---------- 9. 生成一份合并草稿 ----------
  try {
    const con = GR.buildConsolidation(P0, 'seed');
    out.push(
      `合并 ${con.con_no}：加总资产 ${con.sum.asset} → 抵内部往来 ${con.adj.asset} → 合并资产 ${con.asset_total}` +
      `（= 负债 ${con.liability_total} + 权益 ${con.equity_total}，差 ${con.diff_amount}）`
    );
    out.push(`合并净利 ${con.net_profit}；内部往来差异 ${con.ic_diff_cnt} 笔 —— 报表是平的，但金额虚增 ${sc.diff_amount}`);
  } catch (e) {
    out.push(`合并失败：${e.message}`);
  }

  console.log(`\n多主体演示数据${RESET ? '（已重置）' : ''}：`);
  out.forEach((x) => console.log('  ·', x));
  console.log('\n提示：义乌 2026-09 已关账、美国未关账，正好演示「一家关了一家没关」；');
  console.log('      内部往来有 1 笔差 5 万，到「内部往来」页可以看到并写理由忽略。\n');
}

if (RESET) reset();
main();
