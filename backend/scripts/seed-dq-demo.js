/**
 * 数据质量与业务勾稽 · 演示数据
 *   node scripts/seed-dq-demo.js           只补不改（幂等）
 *   node scripts/seed-dq-demo.js --reset   先清理演示痕迹再重建
 *
 * 造的是「真实业务里最常出现的六类不平」：
 *   1. 手动改过余额/金额（可由明细重算 → 可一键修）
 *   2. 有到货没凭证 / 有凭证没到货（不可修，要人认账）
 *   3. 超发、超开票（方向性错误，必须人工查单据）
 *   4. 单据字段缺失（缺交期、缺客户、缺尺码）
 *   5. 悬空明细（主单被删，明细残留）
 *   6. 长期挂待检（流程卡住）
 */
const { db } = require('../src/db');

const TAG = 'DQ-DEMO';
const t = () => {
  const d = new Date();
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 19).replace('T', ' ');
};
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000 - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

function reset() {
  db.prepare("DELETE FROM orders WHERE order_no LIKE 'DQDEMO%'").run();
  db.prepare("DELETE FROM order_materials WHERE remark=?").run(TAG);
  db.prepare("DELETE FROM production_reports WHERE remark=?").run(TAG);
  db.prepare("DELETE FROM rework_orders WHERE rw_no LIKE 'DQDEMO%'").run();
  db.prepare("DELETE FROM goods_receipts WHERE grn_no LIKE 'DQDEMO%'").run();
  db.prepare("DELETE FROM ap_invoices WHERE bill_no LIKE 'DQDEMO%'").run();
  db.prepare("DELETE FROM cut_orders WHERE cut_no LIKE 'DQDEMO%'").run();
  db.prepare('DELETE FROM order_item_sizes WHERE item_id=99999').run();

  // 应收演示票 + 收款 + 核销整条链一起清
  db.prepare(
    "DELETE FROM payment_allocations WHERE invoice_kind='ar' AND invoice_id IN (SELECT id FROM ar_invoices WHERE bill_no LIKE 'DQDEMO%')"
  ).run();
  db.prepare("DELETE FROM ar_invoices WHERE bill_no LIKE 'DQDEMO%'").run();
  db.prepare(
    "DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE pay_no LIKE 'DQDEMO%')"
  ).run();
  db.prepare("DELETE FROM payments WHERE pay_no LIKE 'DQDEMO%'").run();
  // 采购到货演示值还原
  db.prepare('UPDATE purchase_items SET received_qty=510 WHERE id=2').run();
  // 采购表头金额还原成明细汇总
  db.exec(
    `UPDATE purchase_orders SET total_amount =
       (SELECT COALESCE(SUM(amount),0) FROM purchase_items WHERE po_id=purchase_orders.id)
     WHERE id IN (2,3)`
  );

  // 把被改过的余额/金额按明细还原，保证可重复演示
  const fixStock = db.prepare('SELECT * FROM stock_items WHERE id=?').get(5);
  if (fixStock) {
    const net = db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) q FROM stock_ledger
         WHERE IFNULL(warehouse,'')=IFNULL(?,'') AND IFNULL(style_no,'')=IFNULL(?,'')
           AND IFNULL(color,'')=IFNULL(?,'') AND IFNULL(size,'')=IFNULL(?,'')`
      )
      .get(fixStock.warehouse, fixStock.style_no, fixStock.color, fixStock.size).q;
    db.prepare('UPDATE stock_items SET qty=? WHERE id=?').run(Number(net) || 0, 5);
  }
  [4].forEach((id) => {
    const c = db.prepare('SELECT id FROM cost_objects WHERE id=?').get(id);
    if (c) {
      const s = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM cost_entries WHERE cost_object_id=?').get(id).s;
      db.prepare('UPDATE cost_objects SET actual_cost=? WHERE id=?').run(Number(s) || 0, id);
    }
  });
  const o5 = db.prepare('SELECT * FROM orders WHERE id=5').get();
  if (o5) {
    const r = db
      .prepare(
        `SELECT COALESCE(SUM(s.amount_usd),0) u, COALESCE(SUM(s.amount_cny),0) c
         FROM order_item_sizes s JOIN order_items i ON i.id=s.item_id WHERE i.order_id=5`
      )
      .get();
    db.prepare('UPDATE orders SET total_usd=?, total_amount=? WHERE id=5').run(
      Math.round(Number(r.u) * 100) / 100, Math.round(Number(r.c) * 100) / 100
    );
  }
  db.prepare('DELETE FROM dq_fixes').run();
  db.prepare('DELETE FROM dq_issues').run();
  db.prepare('DELETE FROM dq_runs').run();
  db.prepare('DELETE FROM dq_ignores').run();
}

function run() {
  const argv = process.argv.slice(2);
  if (argv.includes('--reset')) reset();

  const t0 = t();
  const note = TAG;
  const out = [];

  // 1. 手动改过库存余额（可自动修）
  const si = db.prepare('SELECT * FROM stock_items WHERE id=5').get();
  if (si) {
    db.prepare('UPDATE stock_items SET qty=?, updated_at=? WHERE id=5').run(Number(si.qty) + 37, t0);
    out.push(`库存行 #5 结存 +37（应为 ${si.qty}）`);
  }

  // 2. 手动改过成本对象实际成本（可自动修）
  const co = db.prepare('SELECT * FROM cost_objects WHERE id=4').get();
  if (co) {
    db.prepare('UPDATE cost_objects SET actual_cost=?, updated_at=? WHERE id=4').run(Number(co.actual_cost) + 9000, t0);
    out.push(`成本对象 #4 实际成本 +9000（应为 ${co.actual_cost}）`);
  }

  // 3. 手动改过订单金额（可自动修）
  const o5 = db.prepare('SELECT * FROM orders WHERE id=5').get();
  if (o5) {
    db.prepare('UPDATE orders SET total_usd=?, updated_at=? WHERE id=5').run(Number(o5.total_usd) + 100, t0);
    out.push(`订单 #5 合计 +$100（应为 $${o5.total_usd}）`);
  }

  // 4. 应收已收与核销不一致（可自动修）：造一张核销过但已收写成 0 的发票
  const arExists = db.prepare("SELECT id FROM ar_invoices WHERE bill_no='DQDEMO-YS-001'").get();
  if (!arExists) {
    const o2 = db.prepare('SELECT * FROM orders WHERE id=1').get();
    const ar = db
      .prepare(
        `INSERT INTO ar_invoices (bill_no,order_id,customer_id,customer_name,amount,paid_amount,due_date,status,source,remark,created_by,created_at,updated_at,currency,amount_orig,rate)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run('DQDEMO-YS-001', 1, o2?.customer_id || null, '示范客户·美国 ABC', 3000, 0, '2026-12-31', 'open', 'manual', note, 'seed', t0, t0, 'CNY', 3000, 1);
    const arId = ar.lastInsertRowid;
    // 付一笔 400 并核销到这张票，但 paid_amount 故意不动
    const pay = db
      .prepare(
        `INSERT INTO payments (pay_no,direction,partner_type,partner_id,partner_name,amount,method,pay_date,status,remark,operator,created_at,currency,amount_orig,rate)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run('DQDEMO-SK-001', 'in', 'customer', o2?.customer_id || null, '示范客户·美国 ABC', 400, 'bank', '2026-10-27', 'confirmed', note, 'seed', t0, 'CNY', 400, 1);
    db.prepare('INSERT INTO payment_allocations (payment_id,invoice_kind,invoice_id,amount,created_at) VALUES (?,?,?,?,?)')
      .run(pay.lastInsertRowid, 'ar', arId, 400, t0);
    out.push('应收发票 DQDEMO-YS-001 已收记 0，实际核销 400（可重算）');
  }

  // 5. 应付票超开 + 应付已付与核销不一致（可自动修）
  if (!db.prepare("SELECT id FROM ap_invoices WHERE bill_no='DQDEMO-YF-001'").get()) {
    db.prepare(
      `INSERT INTO ap_invoices (bill_no,purchase_id,supplier_id,supplier_name,amount,paid_amount,due_date,status,source,remark,created_by,created_at,updated_at,currency,amount_orig,rate)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('DQDEMO-YF-001', 3, 5, '晟彩数码科技', 99999, 0, '2026-12-31', 'open', 'manual', note, 'seed', t0, t0, 'CNY', 99999, 1);
    out.push('应付发票 DQDEMO-YF-001 超开 ¥99999（采购单 #3 金额 ¥0）');
  }
  if (!db.prepare("SELECT id FROM ap_invoices WHERE bill_no='DQDEMO-YF-002'").get()) {
    db.prepare(
      `INSERT INTO ap_invoices (bill_no,purchase_id,supplier_id,supplier_name,amount,paid_amount,due_date,status,source,remark,created_by,created_at,updated_at,currency,amount_orig,rate)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('DQDEMO-YF-002', 2, 3, '蒙特布料', 5000, 3000, '2026-12-31', 'partial', 'manual', note, 'seed', t0, t0, 'CNY', 5000, 1);
    out.push('应付发票 DQDEMO-YF-002 已付记 ¥3000，无任何核销（可重算为 0）');
  }

  // 6. 裁床合格数与扎包不符（不可自动修）
  if (!db.prepare("SELECT id FROM cut_orders WHERE cut_no='DQDEMO-CY-001'").get()) {
    const cut = db
      .prepare(
        `INSERT INTO cut_orders (cut_no,order_id,order_no,style_no,plan_qty,status,fabric_ready,lot_count,total_layers,total_cut_qty,qualified_qty,reject_qty,leftover_m,diff_qty,bundle_count,bundle_qty,bundle_rule,cut_by,cut_at,checked_by,checked_at,note,created_at,updated_at,mixed_dye_lot)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run('DQDEMO-CY-001', 1, 'SO202610260001', 'DQDEMO-STY', 100, 'checked', 1, 1, 50, 100, 100, 0, 0, 0, 2, 88, 20, 'seed', daysAgo(3), 'qc01', daysAgo(2), note, t0, t0, 0);
    const cutId = cut.lastInsertRowid;
    const ib = db.prepare(
      `INSERT INTO cut_bundles (cut_order_id,lot_id,bundle_no,color,size,qty,status,checked_by,checked_at,note,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    ib.run(cutId, null, 'DQDEMO-B1', '藏青', 'M', 44, 'ok', 'qc01', daysAgo(2), note, t0);
    ib.run(cutId, null, 'DQDEMO-B2', '藏青', 'L', 44, 'ok', 'qc01', daysAgo(2), note, t0);
    out.push('裁床单 DQDEMO-CY-001 合格 100，扎包合计 88（差 12 件无下落）');
  }

  // 7. 返工损失未入成本（不可自动修）
  if (!db.prepare("SELECT id FROM rework_orders WHERE rw_no='DQDEMO-RW-001'").get()) {
    db.prepare(
      `INSERT INTO rework_orders (rw_no,order_id,order_no,node_id,node_name,type,source,responsibility,reason,qty,rework_times,qty_ok,qty_scrap,cost_labor,cost_material,cost_total,cost_entry_id,status,approved_by,approved_at,approve_note,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('DQDEMO-RW-001', 5, 'SO202610260005', 4, '车缝', 'rework', 'qc', 'factory', '车缝线迹跳针，整批返修', 12, 1, 10, 2, 800, 400, 1200, null,
      'approved', 'finance01', daysAgo(1), '同意，损失计入该单成本', 'seed', daysAgo(2), t0);
    out.push('返工单 DQDEMO-RW-001 损失 ¥1200 已批准但未挂成本明细');
  }

  // 8. 订单关键字段缺失 + 款无尺码（不可修）
  let badOrder = db.prepare("SELECT * FROM orders WHERE order_no='DQDEMO-001'").get();
  if (!badOrder) {
    const r = db
      .prepare(
        `INSERT INTO orders (order_no,type,customer_id,status,rate,total_usd,total_amount,currency,style_name,cus_order_no,manager,order_date,delivery_method,packaging,trade_terms,shop_name,shop_order_no,delivery_days,freight,delivery_date,remark,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run('DQDEMO-001', 'custom', null, 'production', 0, 0, 0, 'USD', null, null, null, '2026-10-20', null, null, null, null, null, null, 0, null, note, 1, t0, t0);
    badOrder = { id: r.lastInsertRowid };
    db.prepare(
      `INSERT INTO order_items (order_id,product_id,product_name,style_no,sku,color,qty,amount_usd,amount_cny,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(badOrder.id, null, 'DQ 演示款（无尺码）', 'DQDEMO-STY', 'DQDEMO-SKU', '藏青', 100, 0, 0, note);
    out.push('订单 DQDEMO-001：缺客户/缺交期/汇率 0/缺款名，且含一款无尺码明细');
  }

  // 9. 报工未挂员工（不可修）
  if (!db.prepare('SELECT id FROM production_reports WHERE remark=?').get(note)) {
    db.prepare(
      `INSERT INTO production_reports (order_id,node_id,node_name,report_date,qty_ok,qty_defect,hours,operator,remark,created_at,employee_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(5, 4, '车缝', daysAgo(1).slice(0, 10), 10, 0, 8, '临时工张三', note, t0, null);
    out.push('报工记录操作人「临时工张三」未挂员工档案');
  }

  // 10. 悬空明细（不可修）
  if (!db.prepare('SELECT id FROM order_item_sizes WHERE item_id=99999').get()) {
    db.prepare(
      `INSERT INTO order_item_sizes (item_id,color,size,qty,usd_price,cny_price,amount_usd,amount_cny)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(99999, '藏青', 'M', 6, 10, 65, 60, 390);
    out.push('尺码明细 item_id=99999 悬空（对应款已被删除）');
  }

  // 11. 面辅料用量为 0（不可修）
  if (!db.prepare('SELECT id FROM order_materials WHERE remark=? AND name LIKE ?').get(note, 'DQ-DEMO%')) {
    db.prepare(
      `INSERT INTO order_materials (order_id,material_id,type,name,unit,one_use,loss,total_use,price,amount,spec,ingredient,supplier,mat_color,remark,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(5, null, 'fabric', 'DQ-DEMO 试样布', '米', 0, 5, 0, 20, 0, null, null, '示范面料厂A', '藏青', note, t0);
    out.push('订单 #5 面辅料「DQ-DEMO 试样布」单件用量为 0');
  }

  // 12. 收料长期挂待检（不可修）
  if (!db.prepare("SELECT id FROM goods_receipts WHERE grn_no='DQDEMO-GRN-001'").get()) {
    db.prepare(
      `INSERT INTO goods_receipts (grn_no,po_id,po_no,supplier,receive_date,warehouse,status,line_count,expect_qty,receive_qty,pending_qty,pass_qty,freeze_qty,reject_qty,over_qty,short_qty,receive_by,receive_at,remark,created_by,created_at,updated_at,supplier_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('DQDEMO-GRN-001', 2, 'CG202610270001', '蒙特布料', daysAgo(9).slice(0, 10), 'cn', 'pending', 1, 120, 120, 120, 0, 0, 0, 0, 0,
      'seed', daysAgo(9), note, 'seed', t0, t0, 3);
    out.push('收料单 DQDEMO-GRN-001 待检 120 已挂 9 天');
  }

  // 13. 采购到货有凭证但数量不平（可自动修）
  const pi2 = db.prepare('SELECT * FROM purchase_items WHERE id=2').get();
  if (pi2 && Math.abs(Number(pi2.received_qty) - 510) < 0.01) {
    db.prepare('UPDATE purchase_items SET received_qty=500 WHERE id=2').run();
    out.push('采购明细 #2 到货 500，收料单实收 510（可重算）');
  }

  // 14. 采购表头金额未随明细更新（可自动修）
  const p2 = db.prepare('SELECT * FROM purchase_orders WHERE id=2').get();
  if (p2 && Number(p2.total_amount) > 0) {
    db.prepare('UPDATE purchase_orders SET total_amount=0 WHERE id=2').run();
    out.push(`采购单 #2 表头金额记 0，明细合计 ¥${p2.total_amount}（可重算）`);
  }

  console.log('[dq-demo] 已生成演示数据：');
  out.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log(`共 ${out.length} 处（其中 6 处可自动修复，其余需人工核对）`);
}

run();
module.exports = { reset };
