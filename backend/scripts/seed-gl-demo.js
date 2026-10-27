/**
 * 总账与财务报表 · 演示数据
 *   node scripts/seed-gl-demo.js           幂等补充
 *   node scripts/seed-gl-demo.js --reset   清空总账并重建
 *
 * 造的是「一个真实月份的账」：
 *   2026-09：期初建账 → 开票/收款/应付/付款/费用/工资/折旧/成本结转 → 生成凭证 → 损益结转 → 关账
 *   2026-10：只生成凭证，不结转不关账（演示「关账检查会卡住」）
 *
 * 注意：本脚本会清掉勾稽演示里那几张人为造坏的单据（DQDEMO-*），
 *       否则总账里会出现 $99999 的应付票，利润表就没法看了。
 *       想看勾稽演示请再跑 `seed-dq-demo.js --reset`（两个演示互斥）。
 */
const { db } = require('../src/db');
const G = require('../src/services/gl');

const TAG = 'GL-DEMO';
const P0 = '2026-09';   // 已关账期间
const P1 = '2026-10';   // 当期未关账

function reset() {
  db.prepare('DELETE FROM gl_entries').run();
  db.prepare('DELETE FROM gl_vouchers').run();
  db.prepare('DELETE FROM gl_close_checks').run();
  db.prepare('DELETE FROM gl_balances').run();
  db.prepare('DELETE FROM gl_periods').run();

  // 清掉本脚本造的单据
  db.prepare("DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE remark=?)").run(TAG);
  db.prepare('DELETE FROM payments WHERE remark=?').run(TAG);
  db.prepare("DELETE FROM ar_invoices WHERE remark=?").run(TAG);
  db.prepare("DELETE FROM ap_invoices WHERE remark=?").run(TAG);
  db.prepare('DELETE FROM admin_expenses WHERE remark=?').run(TAG);
  db.prepare("DELETE FROM payrolls WHERE remark=?").run(TAG);
  db.prepare("DELETE FROM cost_snapshots WHERE note LIKE '%GL-DEMO%'").run();

  // 清掉勾稽演示的人为坏单据，避免 $99999 应付票进总账
  db.prepare("DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE pay_no LIKE 'DQDEMO%')").run();
  db.prepare("DELETE FROM payments WHERE pay_no LIKE 'DQDEMO%'").run();
  db.prepare("DELETE FROM ar_invoices WHERE bill_no LIKE 'DQDEMO%'").run();
  db.prepare("DELETE FROM ap_invoices WHERE bill_no LIKE 'DQDEMO%'").run();
}

function seed() {
  const t = new Date().toISOString();
  const out = [];

  // ---------- 1. 期初建账（2026-08-31） ----------
  G.ensurePeriod('2026-08');
  G.ensurePeriod(P0);
  const openEntries = [
    { code: '1002', debit: 520000, credit: 0, summary: '期初银行存款' },
    { code: '1403', debit: 86000, credit: 0, summary: '期初原材料' },
    { code: '1405', debit: 154000, credit: 0, summary: '期初库存商品' },
    { code: '1601', debit: 286999, credit: 0, summary: '期初固定资产' },
    { code: '1602', debit: 0, credit: 62500, summary: '期初累计折旧' },
    { code: '4001', debit: 0, credit: 984499, summary: '期初实收资本' }
  ];
  const ovid = G.writeVoucher({
    period: '2026-08', biz_date: '2026-08-31', summary: '期初余额建账',
    source_type: 'manual', source_id: null, entries: openEntries, operator: 'seed'
  });
  out.push(`期初建账凭证 #${ovid}（资产 104.7 万 / 权益 98.4 万）`);

  // ---------- 2. 2026-09 业务单据 ----------
  const o8 = db.prepare('SELECT * FROM orders WHERE id=8').get();
  const o9 = db.prepare('SELECT * FROM orders WHERE id=9').get();
  const o10 = db.prepare('SELECT * FROM orders WHERE id=10').get();

  // 2.0 给 8/9/10 三单各建一个成本对象（一颗料一颗成本，800 件成本 51056）
  const mkCost = db.prepare(
    `INSERT INTO cost_objects (cost_no,order_id,order_no,customer_name,style_no,qty,currency,rate,revenue_orig,revenue_cny,
       budget_cost,actual_cost,sold_qty,sold_cost,sold_revenue,status,remark,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const mkEntry = db.prepare(
    `INSERT INTO cost_entries (cost_object_id,layer,source,ref_type,ref_id,name,qty,unit,unit_price,amount,occurred_at,remark,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  [
    [o8, 'CB202609008', 'COST-800-S'],
    [o9, 'CB202609009', 'COST-800-S'],
    [o10, 'CB202609010', 'COST-800-S']
  ].forEach(([o, cno, sty]) => {
    if (db.prepare('SELECT id FROM cost_objects WHERE order_id=?').get(o.id)) return;
    const coid = mkCost.run(cno, o.id, o.order_no, '示范客户·美国 ABC', sty, 800, 'USD', o.rate,
      o.total_usd, o.total_amount, 48000, 51056, 800, 51056, o.total_amount, 'closed', TAG,
      '2026-09-28 10:00:00', t).lastInsertRowid;
    mkEntry.run(coid, 'material', 'order_material', 'order', o.id, '面料辅料合计（800 件）', 800, '件', 63.82,
      51056, '2026-09-10', TAG, 'seed', '2026-09-28 10:00:00');
  });

  // 2.1 应收开票（订单 8/9/10 三单各全额开票，正好等于订单额不超开）
  const mkAr = db.prepare(
    `INSERT INTO ar_invoices (bill_no,order_id,customer_id,customer_name,amount,paid_amount,due_date,status,source,remark,created_by,created_at,updated_at,currency,amount_orig,rate)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const ar1 = mkAr.run('YS202609200001', 8, o8.customer_id, '示范客户·美国 ABC', o8.total_amount, 50000, '2026-10-20', 'partial',
    'order', TAG, 'seed', '2026-09-20 10:00:00', t, 'CNY', o8.total_amount, 1).lastInsertRowid;
  const ar2 = mkAr.run('YS202609200002', 9, o9.customer_id, '示范客户·美国 ABC', o9.total_amount, 30000, '2026-10-15', 'partial',
    'order', TAG, 'seed', '2026-09-22 14:00:00', t, 'CNY', o9.total_amount, 1).lastInsertRowid;
  mkAr.run('YS202609200003', 10, o10.customer_id, '示范客户·美国 ABC', o10.total_amount, 0, '2026-10-25', 'open',
    'order', TAG, 'seed', '2026-09-26 09:00:00', t, 'CNY', o10.total_amount, 1);

  // 2.2 收款 + 核销
  const mkPay = db.prepare(
    `INSERT INTO payments (pay_no,direction,partner_type,partner_id,partner_name,amount,method,pay_date,status,remark,operator,created_at,currency,amount_orig,rate)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const alloc = db.prepare('INSERT INTO payment_allocations (payment_id,invoice_kind,invoice_id,amount,created_at) VALUES (?,?,?,?,?)');
  const p1 = mkPay.run('SK202609250001', 'in', 'customer', o8.customer_id, '示范客户·美国 ABC', 50000, 'bank',
    '2026-09-25', 'confirmed', TAG, 'seed', '2026-09-25 09:30:00', 'CNY', 50000, 1).lastInsertRowid;
  alloc.run(p1, 'ar', ar1, 50000, '2026-09-25 09:30:00');
  const p2 = mkPay.run('SK202609280001', 'in', 'customer', o9.customer_id, '示范客户·美国 ABC', 30000, 'bank',
    '2026-09-28', 'confirmed', TAG, 'seed', '2026-09-28 16:20:00', 'CNY', 30000, 1).lastInsertRowid;
  alloc.run(p2, 'ar', ar2, 30000, '2026-09-28 16:20:00');

  // 2.3 应付（面辅料采购，走原材料）
  const ap1 = db.prepare(
    `INSERT INTO ap_invoices (bill_no,purchase_id,supplier_id,supplier_name,amount,paid_amount,due_date,status,source,remark,created_by,created_at,updated_at,currency,amount_orig,rate)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run('YF202609180001', 2, 3, '蒙特布料', 16400, 16400, '2026-09-30', 'paid', 'purchase', TAG, 'seed',
    '2026-09-18 11:00:00', t, 'CNY', 16400, 1).lastInsertRowid;
  const p3 = mkPay.run('FK202609260001', 'out', 'supplier', 3, '蒙特布料', 16400, 'bank',
    '2026-09-26', 'confirmed', TAG, 'seed', '2026-09-26 15:00:00', 'CNY', 16400, 1).lastInsertRowid;
  alloc.run(p3, 'ap', ap1, 16400, '2026-09-26 15:00:00');

  // 2.4 行政费用（3 笔）
  const mkExp = db.prepare(
    'INSERT INTO admin_expenses (expense_date,category,amount,payee,handler,payment_method,remark,created_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  mkExp.run('2026-09-12', '水电', 4650.8, '国家电网', 'admin', '转账', TAG, '2026-09-12 10:00:00');
  mkExp.run('2026-09-20', '办公', 1280, '得力文具', 'admin', '微信', TAG, '2026-09-20 10:00:00');

  // 2.5 工资（3 人）
  const mkPayroll = db.prepare(
    `INSERT INTO payrolls (period,employee_id,employee_name,department,base_salary,work_days,actual_days,leave_days,absent_days,
       overtime_hours,overtime_pay,bonus,allowance,deduction,social_insurance,tax,gross_pay,net_pay,status,remark,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  [
    [2, '李四', 12000, 14000],
    [5, '王芳', 9500, 10800],
    [6, '陈国强', 8800, 9600]
  ].forEach(([eid, name, base, gross]) => {
    mkPayroll.run(P0, eid, name, '生产部', base, 22, 22, 0, 0, 0, 0, gross - base, 0, 0,
      Math.round(gross * 0.105), 0, gross, Math.round(gross * 0.895), 'confirmed', TAG,
      '2026-09-30 18:00:00', '2026-09-30 18:00:00');
  });

  // 2.6 成本结转（09 月三单各 800 件，成本各 51056）
  const mkSnap = db.prepare(
    `INSERT INTO cost_snapshots (cost_object_id,seq,qty,total_qty,unit_cost,sold_cost,sold_revenue,gross_profit,note,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  db.prepare("SELECT id FROM cost_objects WHERE remark=? AND order_id IN (8,9,10)").all(TAG).forEach((co, i) => {
    mkSnap.run(co.id, 90, 800, 800, 63.82, 51056, 72176, 21120, '按发货 800/800 件结转（GL-DEMO）', 'seed', `2026-09-30 20:0${i}:00`);
  });

  out.push('09 月业务：应收 3 张(共 21.65 万) + 收款 2 笔 + 应付 1 张(1.64万) + 付款 1 笔 + 费用 2 笔 + 工资 3 人 + 成本结转 3 单(各 5.1 万)');

  // ---------- 3. 生成 09 月凭证 → 结转 → 关账 ----------
  const g0 = G.generateVouchers(P0, { operator: 'seed' });
  const c0 = G.carryProfit(P0, 'seed');
  out.push(`09 月生成凭证 ${g0.created} 张${g0.failed.length ? '（失败：' + g0.failed.join('; ') + '）' : ''}，损益结转：${c0.skipped ? c0.message : '利润 ¥' + c0.profit}`);

  let closed = null;
  try {
    closed = G.closePeriod(P0, 'seed');
    out.push(`09 月已关账：${closed.voucher_count} 张凭证、借方合计 ¥${closed.debit_total}、本期利润 ¥${closed.profit}`);
  } catch (e) {
    out.push(`09 月关账失败（${e.message}）—— 检查项未通过`);
  }

  // ---------- 4. 10 月：只生成凭证 ----------
  G.ensurePeriod(P1);
  const g1 = G.generateVouchers(P1, { operator: 'seed' });
  out.push(`10 月生成凭证 ${g1.created} 张（未结转、未关账，用来演示关账检查）`);

  console.log('[gl-demo] 已生成演示数据：');
  out.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log('\n提示：想看勾稽演示请再跑 seed-dq-demo.js --reset（财务演示与勾稽演示互斥）。');
}

const argv = process.argv.slice(2);
if (argv.includes('--reset')) reset();
seed();
