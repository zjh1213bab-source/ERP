/**
 * 海外仓（美仓）作业 · 演示数据
 *   node scripts/seed-warehouse-demo.js           幂等补充
 *   node scripts/seed-warehouse-demo.js --reset   先清干净再建
 *
 * 造的是「美仓真实的一天」：
 *   1 柜在途 / 1 柜到仓待点收 / 1 柜点收完待上架（有短少破损）/ 1 柜已上架完成
 *   套装：一个有库存可拆可组，一个组件不齐（演示 why 不能组装）
 *   运费：一张待核账单含 4 类差异（金额虚高 / 计费重虚高 / 无此单 / 漏计费），一张已结算
 */
const { db } = require('../src/db');
const { applyStock, addLedger, round2 } = require('../src/services/stockOps');
const { localNow, localDate } = require('../src/services/sla');

const TAG = 'WH-DEMO';
const t0 = () => localNow();
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000 - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};
const daysLater = (n) => {
  const d = new Date(Date.now() + n * 86400000 - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
};

const LOCS = [
  ['US-A-01', 'sellable', 'A 区快出', 800],
  ['US-A-02', 'sellable', 'A 区快出', 800],
  ['US-B-01', 'sellable', 'B 区整箱', 1500],
  ['US-I-01', 'inspect', '待检隔离', 300],
  ['US-D-01', 'damaged', '破损待处理', 200],
  ['US-R-01', 'return', '客退待判定', 300]
];

function reset() {
  // 上架产生的库存流水要一起回收，否则 BAL-STOCK 会对不上
  const asnIds = db.prepare("SELECT id FROM wh_asns WHERE asn_no LIKE 'ASN-DEMO%'").all().map((x) => x.id);
  if (asnIds.length) {
    const rcvIds = db.prepare(
      `SELECT id FROM wh_receipts WHERE asn_id IN (${asnIds.map(() => '?').join(',')})`
    ).all(...asnIds).map((x) => x.id);
    if (rcvIds.length) {
      db.prepare(
        `DELETE FROM stock_ledger WHERE ref_type='wh_receipt' AND ref_id IN (${rcvIds.map(() => '?').join(',')})`
      ).run(...rcvIds);
    }
  }
  db.prepare("DELETE FROM wh_putaways WHERE put_no LIKE 'PUT-DEMO%'").run();
  db.prepare("DELETE FROM wh_receipt_items WHERE rcv_id IN (SELECT id FROM wh_receipts WHERE rcv_no LIKE 'RCV-DEMO%')").run();
  db.prepare("DELETE FROM wh_receipts WHERE rcv_no LIKE 'RCV-DEMO%'").run();
  db.prepare("DELETE FROM wh_asn_items WHERE asn_id IN (SELECT id FROM wh_asns WHERE asn_no LIKE 'ASN-DEMO%')").run();
  db.prepare("DELETE FROM wh_asns WHERE asn_no LIKE 'ASN-DEMO%'").run();

  db.prepare("DELETE FROM wh_bundle_ops WHERE op_no LIKE 'KT%' OR op_no LIKE 'UB%'").run();
  db.prepare("DELETE FROM wh_bundle_stock WHERE bundle_id IN (SELECT id FROM wh_bundles WHERE bundle_sku LIKE 'SET-DEMO%')").run();
  db.prepare("DELETE FROM wh_bundle_items WHERE bundle_id IN (SELECT id FROM wh_bundles WHERE bundle_sku LIKE 'SET-DEMO%')").run();
  db.prepare("DELETE FROM wh_bundles WHERE bundle_sku LIKE 'SET-DEMO%'").run();

  db.prepare("DELETE FROM wh_freight_items WHERE bill_id IN (SELECT id FROM wh_freight_bills WHERE bill_no LIKE 'YF-DEMO%')").run();
  db.prepare("DELETE FROM wh_freight_bills WHERE bill_no LIKE 'YF-DEMO%'").run();
  db.prepare("DELETE FROM wh_freight_rates WHERE carrier IN ('USPS','FedEx')").run();
  db.prepare("DELETE FROM wh_locations WHERE remark=?").run(TAG);
  db.prepare("DELETE FROM shipment_events WHERE remark=?").run(TAG);

  // 演示用组件库存回收（只回收本脚本加过的量，靠流水反算不现实，直接归零再重建）
  ['LEJE-TZ-002|黑色|M', 'LEJE-SY-001|藏青|M', 'LEJE-SY-001|藏青|S'].forEach((k) => {
    const [style, color, size] = k.split('|');
    const row = db.prepare('SELECT * FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?')
      .get('us', style, color, size);
    if (row) {
      const net = db.prepare(
        `SELECT COALESCE(SUM(qty),0) q FROM stock_ledger
         WHERE IFNULL(warehouse,'')=? AND IFNULL(style_no,'')=? AND IFNULL(color,'')=? AND IFNULL(size,'')=?`
      ).get('us', style, color, size).q;
      db.prepare('UPDATE stock_items SET qty=? WHERE id=?').run(round2(net), row.id);
    }
  });
}

function seed() {
  const t = t0();
  const out = [];

  // ---------- 1. 库位 ----------
  db.prepare("DELETE FROM wh_locations WHERE warehouse='us' AND remark=?").run(TAG);
  const locIns = db.prepare(
    'INSERT INTO wh_locations (warehouse,code,zone,aisle,capacity,status,remark,created_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  const locId = {};
  LOCS.forEach(([code, zone, aisle, cap]) => {
    locIns.run('us', code, zone, aisle, cap, 'active', TAG, t);
    locId[code] = db.prepare('SELECT id FROM wh_locations WHERE warehouse=? AND code=?').get('us', code).id;
  });
  out.push(`库位 ${LOCS.length} 个（可售 3 / 待检 1 / 破损 1 / 退货 1）`);

  // ---------- 2. 运费费率 ----------
  const rateIns = db.prepare(
    `INSERT INTO wh_freight_rates (carrier,zone,currency,first_weight,first_price,add_weight,add_price,fuel_pct,effective_from,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  rateIns.run('USPS', 'US-W', 'USD', 1, 8.5, 0.5, 1.2, 12, '2026-10-01', 'active', t);
  rateIns.run('USPS', 'US-E', 'USD', 1, 9.2, 0.5, 1.3, 12, '2026-10-01', 'active', t);
  rateIns.run('FedEx', 'US-W', 'USD', 1, 11, 0.5, 1.6, 15, '2026-10-01', 'active', t);
  out.push('运费费率 3 条（USPS 西/东、FedEx 西，含燃油附加）');

  // ---------- 3. ASN ----------
  const asnIns = db.prepare(
    `INSERT INTO wh_asns (asn_no,warehouse,from_warehouse,carrier,container_no,ship_date,eta_date,arrive_date,
       carton_plan,carton_actual,expect_qty,received_qty,damaged_qty,short_qty,over_qty,status,remark,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const itemIns = db.prepare(
    'INSERT INTO wh_asn_items (asn_id,style_no,product_name,color,size,expect_qty,carton_no,remark) VALUES (?,?,?,?,?,?,?,?)'
  );

  const mkAsn = (no, o) => {
    const r = asnIns.run(no, 'us', 'cn', o.carrier, o.container, o.ship_date, o.eta_date, o.arrive_date || null,
      o.carton_plan, o.carton_actual || 0, o.expect, o.received || 0, o.damaged || 0, o.short || 0, o.over || 0,
      o.status, o.remark || TAG, 'seed', t, t);
    const id = r.lastInsertRowid;
    o.items.forEach((x) => itemIns.run(id, x.style, x.name, x.color, x.size, x.qty, x.carton, null));
    return id;
  };

  const asn1 = mkAsn('ASN-DEMO-001', {
    carrier: 'Matson', container: 'MATU7701234', ship_date: daysAgo(6).slice(0, 10),
    eta_date: daysLater(5), carton_plan: 12, expect: 400, status: 'in_transit',
    items: [
      { style: 'LEJE-SY-001', name: '女式针织开衫 A 款', color: '藏青', size: 'S', qty: 200, carton: 'C01-C06' },
      { style: 'LEJE-SY-001', name: '女式针织开衫 A 款', color: '藏青', size: 'M', qty: 200, carton: 'C07-C12' }
    ]
  });
  const asn2 = mkAsn('ASN-DEMO-002', {
    carrier: 'Matson', container: 'MATU7702234', ship_date: daysAgo(18).slice(0, 10),
    eta_date: daysAgo(2).slice(0, 10), arrive_date: daysAgo(2).slice(0, 10),
    carton_plan: 10, expect: 300, status: 'arrived',
    items: [
      { style: 'LEJE-TZ-002', name: '男士休闲长裤 B 款', color: '黑色', size: 'M', qty: 150, carton: 'C01-C05' },
      { style: 'LEJE-TZ-002', name: '男士休闲长裤 B 款', color: '黑色', size: 'L', qty: 150, carton: 'C06-C10' }
    ]
  });
  const asn3 = mkAsn('ASN-DEMO-003', {
    carrier: 'OOCL', container: 'OOCU9911234', ship_date: daysAgo(25).slice(0, 10),
    eta_date: daysAgo(4).slice(0, 10), arrive_date: daysAgo(4).slice(0, 10), carton_plan: 16, carton_actual: 15,
    expect: 400, received: 388, damaged: 6, short: 6, status: 'receiving',
    items: [
      { style: 'LEJE-SY-001', name: '女式针织开衫 A 款', color: '藏青', size: 'S', qty: 150, carton: 'C01-C05' },
      { style: 'LEJE-SY-001', name: '女式针织开衫 A 款', color: '藏青', size: 'M', qty: 150, carton: 'C06-C10' },
      { style: 'LEJE-TZ-002', name: '男士休闲长裤 B 款', color: '黑色', size: 'M', qty: 100, carton: 'C11-C16' }
    ]
  });
  const asn4 = mkAsn('ASN-DEMO-004', {
    carrier: 'Matson', container: 'MATU7703234', ship_date: daysAgo(40).slice(0, 10),
    eta_date: daysAgo(20).slice(0, 10), arrive_date: daysAgo(20).slice(0, 10),
    carton_plan: 8, carton_actual: 8, expect: 260, received: 260, status: 'done',
    items: [
      { style: 'LEJE-TZ-002', name: '男士休闲长裤 B 款', color: '黑色', size: 'M', qty: 160, carton: 'C01-C05' },
      { style: 'LEJE-SY-001', name: '女式针织开衫 A 款', color: '藏青', size: 'M', qty: 100, carton: 'C06-C08' }
    ]
  });
  out.push('发运单 4 张：在途 1 / 到仓待点收 1 / 点收完待上架 1 / 已上架完成 1');

  // ---------- 4. 点收单（ASN-003 有差异，ASN-004 已完成） ----------
  const rcvIns = db.prepare(
    `INSERT INTO wh_receipts (rcv_no,asn_id,arrive_date,carton_actual,expect_qty,received_qty,damaged_qty,
       short_qty,over_qty,status,note,receive_by,received_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const rcvItemIns = db.prepare(
    `INSERT INTO wh_receipt_items (rcv_id,asn_item_id,style_no,product_name,color,size,expect_qty,
       received_qty,damaged_qty,short_qty,over_qty,put_qty,diff_reason,remark)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  // ASN-003：预报 400，实收 388 + 破损 6 + 短少 6
  const r3 = rcvIns.run('RCV-DEMO-001', asn3, daysAgo(4).slice(0, 10), 15, 400, 388, 6, 6, 0, 'done',
    '少一个外箱，箱内 6 件破损', 'wh01', t, t, t).lastInsertRowid;
  const a3items = db.prepare('SELECT * FROM wh_asn_items WHERE asn_id=? ORDER BY id').all(asn3);
  rcvItemIns.run(r3, a3items[0].id, 'LEJE-SY-001', '女式针织开衫 A 款', '藏青', 'S', 150, 144, 6, 0, 0, 0,
    '第 3 箱整箱受潮，6 件破损隔离', null);
  rcvItemIns.run(r3, a3items[1].id, 'LEJE-SY-001', '女式针织开衫 A 款', '藏青', 'M', 150, 150, 0, 0, 0, 0, null, null);
  rcvItemIns.run(r3, a3items[2].id, 'LEJE-TZ-002', '男士休闲长裤 B 款', '黑色', 'M', 100, 94, 0, 6, 0, 0,
    'C16 箱未到，短少 6 件，已向货代索赔', null);

  // ASN-004：已全部上架（写库位 + 库存 + 流水）
  const r4 = rcvIns.run('RCV-DEMO-002', asn4, daysAgo(20).slice(0, 10), 8, 260, 260, 0, 0, 0, 'done',
    null, 'wh01', daysAgo(20), t, t).lastInsertRowid;
  const a4items = db.prepare('SELECT * FROM wh_asn_items WHERE asn_id=? ORDER BY id').all(asn4);
  const putIns = db.prepare(
    'INSERT INTO wh_putaways (put_no,rcv_item_id,location_id,qty,operator,put_at,remark) VALUES (?,?,?,?,?,?,?)'
  );
  a4items.forEach((a, idx) => {
    const ri = rcvItemIns.run(r4, a.id, a.style_no, a.product_name, a.color, a.size, a.expect_qty,
      a.expect_qty, 0, 0, 0, a.expect_qty, null, null).lastInsertRowid;
    const code = idx === 0 ? 'US-A-01' : 'US-A-02';
    putIns.run('PUT-DEMO-001', ri, locId[code], a.expect_qty, 'wh01', daysAgo(20), TAG);
    applyStock({
      warehouse: 'us', style_no: a.style_no, product_name: a.product_name,
      color: a.color, size: a.size, delta: a.expect_qty
    });
    addLedger({
      warehouse: 'us', style_no: a.style_no, product_name: a.product_name,
      color: a.color, size: a.size, type: 'in', qty: a.expect_qty,
      ref_type: 'wh_receipt', ref_id: r4, remark: `海外仓上架 PUT-DEMO-001 · ${code}`, operator: 'seed'
    });
  });
  out.push('点收单 2 张：ASN-003 短少 6 + 破损 6（已写原因）/ ASN-004 260 件已全部上架到 A 区');

  // ---------- 5. 套装 ----------
  const bdIns = db.prepare(
    'INSERT INTO wh_bundles (bundle_sku,name,warehouse,sale_price,status,remark,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  const biIns = db.prepare(
    'INSERT INTO wh_bundle_items (bundle_id,style_no,product_name,color,size,qty_per) VALUES (?,?,?,?,?,?)'
  );
  const b1 = bdIns.run('SET-DEMO-01', '基础长裤双件套（2 条装）', 'us', 89, 'active', TAG, t, t).lastInsertRowid;
  biIns.run(b1, 'LEJE-TZ-002', '男士休闲长裤 B 款', '黑色', 'M', 2);
  const b2 = bdIns.run('SET-DEMO-02', '开衫+长裤两件套', 'us', 119, 'active', TAG, t, t).lastInsertRowid;
  biIns.run(b2, 'LEJE-TZ-002', '男士休闲长裤 B 款', '黑色', 'M', 1);
  // 用 S 码开衫：它还在 ASN-DEMO-003 里没上架，所以现在组不出来（上架后就能组）
  biIns.run(b2, 'LEJE-SY-001', '女式针织开衫 A 款', '藏青', 'S', 1);

  // 先有库存再组装（演示单据才完整）
  const bsIns = db.prepare('INSERT INTO wh_bundle_stock (bundle_id,warehouse,qty,updated_at) VALUES (?,?,?,?)');
  bsIns.run(b1, 'us', 0, t);
  bsIns.run(b2, 'us', 0, t);
  const opIns = db.prepare(
    `INSERT INTO wh_bundle_ops (op_no,bundle_id,type,warehouse,qty,before_qty,after_qty,status,remark,operator,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  opIns.run('KT-DEMO-001', b1, 'kit', 'us', 20, 0, 20, 'done', '上周批量组装备货', 'wh01', daysAgo(3));
  db.prepare('UPDATE wh_bundle_stock SET qty=20 WHERE bundle_id=?').run(b1);
  out.push('套装 2 个：SET-DEMO-01 已组装 20 套（可拆可续组）/ SET-DEMO-02 组件不齐（S 码开衫还在 ASN-003 待上架，上架后即可组装）');

  // ---------- 6. 发货物流记录（运费核对的系统侧依据） ----------
  const evIns = db.prepare(
    `INSERT INTO shipment_events (order_id,carrier,tracking_no,event_time,status_text,location,source,verified,visible,remark,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  evIns.run(1, 'USPS', 'TRK-DEMO-1001', '2026-10-05 10:12:00', 'Delivered', 'Los Angeles, CA', 'manual', 1, 1, TAG, 'seed', t);
  evIns.run(2, 'USPS', 'TRK-DEMO-1002', '2026-10-08 14:30:00', 'Delivered', 'New York, NY', 'manual', 1, 1, TAG, 'seed', t);
  evIns.run(3, 'USPS', 'TRK-DEMO-1003', '2026-10-12 09:05:00', 'Delivered', 'Chicago, IL', 'manual', 1, 1, TAG, 'seed', t);
  evIns.run(5, 'USPS', 'TRK-DEMO-1004', '2026-10-15 16:40:00', 'Delivered', 'Houston, TX', 'manual', 1, 1, TAG, 'seed', t);
  out.push('物流记录 4 条（10-05 ~ 10-15），账单里只列了 3 条 → 第 4 条会被识别为「漏计费」');

  // ---------- 7. 运费账单 ----------
  const billIns = db.prepare(
    `INSERT INTO wh_freight_bills (bill_no,carrier,period_from,period_to,currency,total_amount,sys_amount,
       diff_amount,item_count,diff_count,missing_count,extra_count,status,supplier_id,remark,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const fiIns = db.prepare(
    `INSERT INTO wh_freight_items (bill_id,tracking_no,order_id,ship_date,dest_zip,zone,weight,act_weight,
       bill_amount,sys_amount,diff,diff_type,status,note,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const { __calcFreight } = require('../src/routes/warehouse');
  const calc = (zone, w) => {
    const c = __calcFreight('USPS', zone, w);
    return c ? c.amount : 0;
  };

  // 待核账单：4 类差异
  const bill1 = billIns.run('YF-DEMO-01', 'USPS', '2026-10-01', '2026-10-20', 'USD', 0, 0, 0, 0, 0, 0, 0, 'pending', null,
    '10 月上半月 USPS 账单', 'seed', t, t).lastInsertRowid;
  // 1) 正常
  fiIns.run(bill1, 'TRK-DEMO-1001', 1, '2026-10-05', '90001', 'US-W', 1.0, 1.0, calc('US-W', 1.0), calc('US-W', 1.0), 0, 'ok', 'ok', null, t);
  // 2) 金额虚高（账单 15.50，系统算 13.55）
  fiIns.run(bill1, 'TRK-DEMO-1002', 2, '2026-10-08', '10001', 'US-E', 2.5, 2.5, 22.5, calc('US-E', 2.5),
    round2(22.5 - calc('US-E', 2.5)), 'amount', 'diff', '账单多收一笔住宅派送附加费 $7.83，我方未认可', t);
  // 3) 计费重虚高（账单 3kg，实际 1.2kg）
  fiIns.run(bill1, 'TRK-DEMO-1003', 3, '2026-10-12', '60601', 'US-W', 3.0, 1.2, calc('US-W', 3.0), calc('US-W', 1.2),
    round2(calc('US-W', 3.0) - calc('US-W', 1.2)), 'weight', 'diff', '账单计费重 3kg，我方称重 1.2kg（差 150%）', t);
  // 4) 账单有系统无
  fiIns.run(bill1, 'TRK-UNKNOWN-9999', null, '2026-10-10', '94103', 'US-W', 1.5, 0, 12.8, 0, 0, 'missing', 'diff',
    '系统查不到这个运单，可能是别家的单混进来', t);

  // 已结算账单：全部正常
  const bill2 = billIns.run('YF-DEMO-02', 'FedEx', '2026-10-01', '2026-10-10', 'USD', 0, 0, 0, 0, 0, 0, 0, 'settled', null,
    '10 月上旬 FedEx 账单（已对平并结算）', 'seed', t, t).lastInsertRowid;
  const fedexCalc = (w) => {
    const c = __calcFreight('FedEx', 'US-W', w);
    return c ? c.amount : 0;
  };
  fiIns.run(bill2, 'TRK-DEMO-1001', 1, '2026-10-05', '90001', 'US-W', 1.0, 1.0, fedexCalc(1.0), fedexCalc(1.0), 0, 'ok', 'ok', null, t);

  // 用路由里的同一套口径重算汇总 + 补出「漏计费」
  const { __refreshBill } = require('../src/routes/warehouse');
  __refreshBill(bill1, true);
  __refreshBill(bill2, false);
  const fb1 = db.prepare('SELECT * FROM wh_freight_bills WHERE id=?').get(bill1);
  out.push(`账单 2 张：YF-DEMO-01 待核（${fb1.item_count} 行：1 金额差 / 1 重量差 / 1 无此单 / ${fb1.extra_count} 漏计费，差 $${round2(fb1.diff_amount)}）/ YF-DEMO-02 已结算`);

  console.log('[wh-demo] 已生成演示数据：');
  out.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log(`\n提示：ASN-DEMO-002 可直接在页面上点收；ASN-DEMO-003 已在点收单里等上架（有短少与破损）。`);
}

const argv = process.argv.slice(2);
if (argv.includes('--reset')) reset();
seed();
