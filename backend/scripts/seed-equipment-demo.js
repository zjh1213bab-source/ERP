/**
 * 设备停机与产能演示（原型 TS-N08-08）
 *   node scripts/seed-equipment-demo.js           # 增量
 *   node scripts/seed-equipment-demo.js --reset   # 先清空再重建
 *
 * 需要服务已在 3000 端口运行。演示五态：
 *   EQ001 缝纫平车 A 组  故障 3h → 已恢复（安全放行，损失 36 件）
 *   EQ002 缝纫平车 B 组  故障 → 维修完成，停在「待安全复核」（留给用户点放行）
 *   EQ004 自动裁剪机     故障 → 停在「维修中」（留给用户点结束维修）
 *   EQ006 蒸汽整烫台     故障 → 停在「待维修」（留给用户点开始维修）
 *   EQ010 检针机         计划保养（3 天后）
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
const local = (offsetMin) => {
  const d = new Date(Date.now() + offsetMin * 60000 - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
};

(async () => {
  if (process.argv.includes('--reset')) {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM equipment_downtimes').run();
      db.prepare("UPDATE equipment SET status='running', last_maintain_at=NULL").run();
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    console.log('已清空停机单并复位设备状态');
  }

  const login = await req(null, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123456' });
  if (!login.j.ok) { console.error('服务未启动'); process.exit(1); }
  const TK = login.j.data.token;

  const existing = (await req(TK, 'GET', '/api/equipment/downtimes')).j.data.rows;
  if (existing.length) {
    console.log(`  已有 ${existing.length} 张停机单，跳过创建（要重来加 --reset）`);
  } else {
    // ① EQ001 故障 3h → 已恢复
    let r = await req(TK, 'POST', '/api/equipment/downtimes', {
      equipment_id: 1, type: 'breakdown', start_at: local(-300), reason: '主轴异响，针距不稳',
      repair_task: '更换主轴轴承、重新校针距',
      affected_orders: [{ order_id: 5, note: '车缝产值受影响，可能延误 1 天' }]
    });
    if (r.j.ok) {
      const id = r.j.data.id;
      await req(TK, 'POST', `/api/equipment/downtimes/${id}/start-repair`, {});
      await req(TK, 'POST', `/api/equipment/downtimes/${id}/finish-repair`, { repair_note: '更换主轴轴承，重新校针距', repair_by: '机修-老李' });
      await req(TK, 'POST', `/api/equipment/downtimes/${id}/safety`, {
        safety_by: '张组长', safety_note: '试机正常，防护罩复位，试缝 3 件合格', end_at: local(-120)
      });
      console.log(`  EQ001 故障 → 已恢复（${r.j.data.dt_no}）`);
    }

    // ② EQ002 维修完成 → 待安全复核
    r = await req(TK, 'POST', '/api/equipment/downtimes', {
      equipment_id: 2, type: 'breakdown', start_at: local(-180), reason: '断线频繁，梭床磨损',
      repair_task: '更换梭床、调整勾线时间'
    });
    if (r.j.ok) {
      const id = r.j.data.id;
      await req(TK, 'POST', `/api/equipment/downtimes/${id}/start-repair`, {});
      await req(TK, 'POST', `/api/equipment/downtimes/${id}/finish-repair`, { repair_note: '更换梭床并重新对勾线时间', repair_by: '机修-小王' });
      console.log(`  EQ002 维修完成 → 待安全复核（${r.j.data.dt_no}）`);
    }

    // ③ EQ004 维修中
    r = await req(TK, 'POST', '/api/equipment/downtimes', {
      equipment_id: 4, type: 'breakdown', start_at: local(-120), reason: '裁刀裁片毛边，气压不足',
      repair_task: '换裁刀、检查气路'
    });
    if (r.j.ok) {
      await req(TK, 'POST', `/api/equipment/downtimes/${r.j.data.id}/start-repair`, {});
      console.log(`  EQ004 → 维修中（${r.j.data.dt_no}）`);
    }

    // ④ EQ006 待维修
    r = await req(TK, 'POST', '/api/equipment/downtimes', {
      equipment_id: 6, type: 'breakdown', start_at: local(-45), reason: '蒸汽压力不足，熨烫不挺',
      repair_task: '检查疏水阀与蒸汽管路'
    });
    if (r.j.ok) console.log(`  EQ006 → 待维修（${r.j.data.dt_no}）`);

    // ⑤ EQ010 计划保养（3 天后）
    r = await req(TK, 'POST', '/api/equipment/downtimes', {
      equipment_id: 10, type: 'maintenance', start_at: local(3 * 24 * 60), reason: '季度保养：检针精度校准 + 皮带张紧'
    });
    if (r.j.ok) console.log(`  EQ010 → 计划保养（${r.j.data.dt_no}）`);
  }

  const b = (await req(TK, 'GET', '/api/equipment/downtimes')).j.data;
  const g = (await req(TK, 'GET', '/api/equipment/board')).j.data;
  const cb = (await req(TK, 'GET', '/api/equipment/capacity-board')).j.data;
  console.log('\n== 终态 ==');
  console.log('停机单：', b.rows.map((r) => `${r.dt_no} ${r.eq_name} ${r.status_label}`).join(' | '));
  console.log('停机单指标', JSON.stringify(b.stat));
  console.log('台账指标', JSON.stringify(g.stat));
  console.log('全厂产能', JSON.stringify(cb.total));
})().catch((e) => { console.error(e); process.exit(1); });
