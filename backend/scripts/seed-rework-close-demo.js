/**
 * 返工报废与生产结单演示（原型 TS-N08-06）
 *   node scripts/seed-rework-close-demo.js           # 增量
 *   node scripts/seed-rework-close-demo.js --reset   # 先清空再重建
 *
 * 需要服务已在 3000 端口运行。演示状态：
 *   返工：RW 返工 20 件（已闭环，损失进成本 rework 层）
 *         RW 报废 2 件（已核销）
 *         RW 返工 12 件（待批准，留给用户点）
 *         RW 返工 8 件（返工中，留给用户点复验）
 *   结单：订单 11 部分关闭（未交 800 件待发货 + 争议挂账）
 *         订单 9 全结
 *         订单 5 结单受限（12 道工序未完成 + 未闭环返工）
 */
const { db, now } = require('../src/db');
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
      // 清掉返工写进成本的条目（source=manual 且 ref_type=rework_order）
      db.prepare("DELETE FROM cost_entries WHERE ref_type = 'rework_order'").run();
      db.prepare('DELETE FROM rework_orders').run();
      db.prepare('DELETE FROM production_closures').run();
      db.prepare("UPDATE orders SET status='closed' WHERE id=9").run();
      db.prepare("UPDATE orders SET status='instock' WHERE id=11").run();
      // 成本重算（去掉返工损失）
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    // 重算成本对象
    const { recalc } = require('../src/routes/costObjects');
    db.prepare("SELECT id FROM cost_objects WHERE order_id IN (5,9,11)").all().forEach((r) => recalc(r.id));
    console.log('已恢复基线');
  }

  const login = await req(null, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123456' });
  if (!login.j.ok) { console.error('服务未启动'); process.exit(1); }
  const TK = login.j.data.token;

  const nodes = (await req(TK, 'GET', '/api/reworks/nodes/5')).j.data || [];
  const nodeCar = nodes.find((n) => n.name.includes('车缝'));
  const nodeButton = nodes.find((n) => n.name.includes('锁眼')) || nodes[3];
  const nodeIron = nodes.find((n) => n.name.includes('整烫')) || nodes[5];

  const exist = (await req(TK, 'GET', '/api/reworks/board')).j.data.rows;
  if (!exist.length) {
    // ① 返工 20 件 → 闭环（损失进成本）
    let r = await req(TK, 'POST', '/api/reworks', {
      order_id: 5, node_id: nodeCar && nodeCar.id, type: 'rework', source: 'inhouse', responsibility: '一车间',
      reason: '领口罗纹车线跳针，需拆线重车', qty: 20, cost_labor: 260, cost_material: 40
    });
    if (r.j.ok) {
      const id = r.j.data.id;
      await req(TK, 'POST', `/api/reworks/${id}/submit`, {});
      await req(TK, 'POST', `/api/reworks/${id}/approve`, { agree: true, note: '同意返工，费用计入本单' });
      await req(TK, 'POST', `/api/reworks/${id}/start`, {});
      await req(TK, 'POST', `/api/reworks/${id}/reinspect`, { result: 'fail', note: '抽检 5 件仍有 2 件跳针' });
      await req(TK, 'POST', `/api/reworks/${id}/reinspect`, { result: 'pass', qty_ok: 18, note: '抽检 5 件无跳针，18 件可入库，2 件降级' });
      console.log(`  RW 返工 20 件 → 已闭环（第 2 次复验通过）${r.j.data.rw_no}`);
    }

    // ② 报废 2 件 → 核销
    r = await req(TK, 'POST', '/api/reworks', {
      order_id: 5, type: 'scrap', source: 'inhouse', responsibility: '裁剪组',
      reason: '裁片疵点无法修复', qty: 2, cost_labor: 30, cost_material: 60
    });
    if (r.j.ok) {
      const id = r.j.data.id;
      await req(TK, 'POST', `/api/reworks/${id}/submit`, {});
      await req(TK, 'POST', `/api/reworks/${id}/approve`, { agree: true });
      await req(TK, 'POST', `/api/reworks/${id}/scrap`, { qty_scrap: 2, note: '车间主管核销，废料已入废料箱' });
      console.log(`  RW 报废 2 件 → 已核销 ${r.j.data.rw_no}`);
    }

    // ③ 返工 12 件 → 停在待批准（给用户点）
    r = await req(TK, 'POST', '/api/reworks', {
      order_id: 5, node_id: nodeButton && nodeButton.id, type: 'rework', source: 'inhouse', responsibility: '二车间',
      reason: '五爪扣冲压偏位，扣面划伤', qty: 12, cost_labor: 96, cost_material: 0
    });
    if (r.j.ok) {
      await req(TK, 'POST', `/api/reworks/${r.j.data.id}/submit`, {});
      console.log(`  RW 返工 12 件 → 待批准 ${r.j.data.rw_no}`);
    }

    // ④ 返工 8 件 → 返工中（给用户点复验）
    r = await req(TK, 'POST', '/api/reworks', {
      order_id: 5, node_id: nodeIron && nodeIron.id, type: 'rework', source: 'inhouse', responsibility: '整烫组',
      reason: '下摆压痕过深，需重新整烫', qty: 8, cost_labor: 64, cost_material: 0
    });
    if (r.j.ok) {
      const id = r.j.data.id;
      await req(TK, 'POST', `/api/reworks/${id}/submit`, {});
      await req(TK, 'POST', `/api/reworks/${id}/approve`, { agree: true });
      await req(TK, 'POST', `/api/reworks/${id}/start`, {});
      console.log(`  RW 返工 8 件 → 返工中 ${r.j.data.rw_no}`);
    }
  } else {
    console.log(`  现有返工单 ${exist.length} 张，跳过创建`);
  }

  // 结单：订单 11 部分关闭、订单 9 全结
  const closures = (await req(TK, 'GET', '/api/production-close/board')).j.data.rows;
  const c11 = closures.find((c) => c.order_id === 11);
  if (c11 && !c11.closure) {
    const r = await req(TK, 'POST', '/api/production-close', {
      order_id: 11, close_type: 'partial', actual_close_date: '2026-10-25',
      dispute_note: '客户要求分两批出货，首批 500 件已验未发，余 300 件等客户指定船期，质量已复验无需返工',
      balance_source: '未交（待发货）', follow_up_owner: '赵主管'
    });
    console.log(`  订单 11 部分关闭：${r.j.ok ? r.j.data.close_no : r.j.message}`);
  }
  const c9 = closures.find((c) => c.order_id === 9);
  if (c9 && !c9.closure) {
    const r = await req(TK, 'POST', '/api/production-close', { order_id: 9 });
    console.log(`  订单 9 全结：${r.j.ok ? r.j.data.close_no : r.j.message}`);
  }

  const rb = (await req(TK, 'GET', '/api/reworks/board')).j.data;
  const cb = (await req(TK, 'GET', '/api/production-close/board')).j.data;
  console.log('\n== 终态 ==');
  console.log('返工单：', rb.rows.map((r) => `${r.rw_no} ${r.type_label}${r.qty} ${r.status_label}`).join(' | '));
  console.log('返工指标', JSON.stringify(rb.stat));
  console.log('结单：', cb.rows.filter((r) => r.closure).map((r) => `${r.order_no} ${r.closure.close_type_label}`).join(' | '));
  console.log('结单指标', JSON.stringify(cb.stat));
})().catch((e) => { console.error(e); process.exit(1); });
