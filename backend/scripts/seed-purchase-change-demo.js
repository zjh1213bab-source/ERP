/**
 * 停单改量与供应商退料演示（原型 TS-N07-06）
 *   node scripts/seed-purchase-change-demo.js           # 增量
 *   node scripts/seed-purchase-change-demo.js --reset   # 先恢复基线再重建
 *
 * 需要服务已在 3000 端口运行。演示四态：
 *   PC 减量 200（已生效）＋ PC 减量 150（待供方确认，留给用户点确认）
 *   RT 退料 80（完成，实物+贷项双回执）＋ RT 退料 60（待实物回执，留给用户点）
 *
 * 基线（--reset 恢复）：PO4 蒙特 2099# 采 800 未交 800；PO2 蒙特 600 拉架 收 500；物料 14 库存 1260。
 */
const { db } = require('../src/db');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const req = async (tk, m, p, b) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
    body: b ? JSON.stringify(b) : undefined
  });
  return { s: r.status, j: await r.json() };
};

(async () => {
  if (process.argv.includes('--reset')) {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM purchase_return_items').run();
      db.prepare('DELETE FROM purchase_returns').run();
      db.prepare('DELETE FROM purchase_change_items').run();
      db.prepare('DELETE FROM purchase_changes').run();
      db.prepare("UPDATE purchase_items SET qty=800, amount=14800, received_qty=0, issued_qty=0, returned_qty=0 WHERE id=4").run();
      db.prepare("UPDATE purchase_orders SET total_amount=14800, status='ordered' WHERE id=4").run();
      db.prepare('UPDATE purchase_items SET issued_qty=0, returned_qty=0 WHERE id=2').run();
      db.prepare('UPDATE materials SET stock_qty=1260 WHERE id=14').run();
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log('已恢复基线');
  }

  const login = await req(null, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123456' });
  if (!login.j.ok) { console.error('服务未启动'); process.exit(1); }
  const TK = login.j.data.token;

  // 1. PC 减量 200 → 提交 → 供方确认 → 生效
  let existing = (await req(TK, 'GET', '/api/purchase-changes/board')).j.data.changes;
  if (!existing.some((c) => c.po_id === 4 && c.reduce_qty === 200 && c.status === 'effective')) {
    let r = await req(TK, 'POST', '/api/purchase-changes', { po_id: 4, type: 'reduce', reason: '客户 2099# 减量 200 米', items: [{ po_item_id: 4, reduce_qty: 200 }] });
    if (r.j.ok) {
      const cid = r.j.data.id;
      await req(TK, 'POST', `/api/purchase-changes/${cid}/submit`, {});
      await req(TK, 'POST', `/api/purchase-changes/${cid}/supplier-confirm`, { agree: true, supplier_confirmed_by: '黄小姐' });
      await req(TK, 'POST', `/api/purchase-changes/${cid}/effective`, {});
      console.log(`  PC 减量 200 → 已生效（${r.j.data.change_no}）`);
    }
  }

  // 2. PC 减量 150 → 提交 → 停在「待供方确认」
  if (!existing.some((c) => c.po_id === 4 && c.reduce_qty === 150 && ['pending_supplier', 'confirmed'].includes(c.status))) {
    const r = await req(TK, 'POST', '/api/purchase-changes', { po_id: 4, type: 'reduce', reason: '客户再减 150 米，未交部分协商取消', items: [{ po_item_id: 4, reduce_qty: 150 }] });
    if (r.j.ok) {
      await req(TK, 'POST', `/api/purchase-changes/${r.j.data.id}/submit`, {});
      console.log(`  PC 减量 150 → 待供方确认（${r.j.data.change_no}）`);
    }
  }

  // 3. RT 退料 80 → 实物 + 贷项双回执 → 完成（已领 120 后）
  db.prepare('UPDATE purchase_items SET issued_qty=120 WHERE id=2').run();
  let rets = (await req(TK, 'GET', '/api/purchase-changes/returns')).j.data;
  if (!rets.some((r) => r.po_id === 2 && r.return_qty === 80)) {
    const r = await req(TK, 'POST', '/api/purchase-changes/returns', { po_id: 2, reason: '客户取消 600 色号，退回未用 80 米', items: [{ po_item_id: 2, qty: 80 }] });
    if (r.j.ok) {
      await req(TK, 'POST', `/api/purchase-changes/returns/${r.j.data.id}/physical`, { note: '顺丰 SF1234567890 已签收' });
      await req(TK, 'POST', `/api/purchase-changes/returns/${r.j.data.id}/credit`, { credit_note_no: 'CN-2026-088', credit_amount: 2624 });
      console.log(`  RT 退料 80 → 完成（${r.j.data.return_no}，实物+贷项双回执）`);
    }
  }

  // 4. RT 退料 60 → 停在「待实物回执」
  if (!rets.some((r) => r.po_id === 2 && r.return_qty === 60)) {
    const r = await req(TK, 'POST', '/api/purchase-changes/returns', { po_id: 2, reason: '再退回未用 60 米，待物流上门取件', items: [{ po_item_id: 2, qty: 60 }] });
    if (r.j.ok) console.log(`  RT 退料 60 → 待实物回执（${r.j.data.return_no}）`);
  }

  const b = (await req(TK, 'GET', '/api/purchase-changes/board')).j.data;
  console.log('\n== 终态 ==');
  console.log('变更单:', b.changes.map((c) => `${c.change_no} ${c.type === 'cancel' ? '停单' : '减' + c.reduce_qty} ${c.status_label}`).join(' | '));
  console.log('退料单:', b.returns.map((r) => `${r.return_no} 退${r.return_qty} ${r.status_label}`).join(' | '));
  console.log('指标', JSON.stringify(b.stat));
})().catch((e) => { console.error(e); process.exit(1); });
