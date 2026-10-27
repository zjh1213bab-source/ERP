/**
 * 供应商评价演示编排（评价 → 落资格 → 备用验证 → 整改闭环）
 *   node scripts/seed-supplier-eval.js --reset   # 先造历史交付样本
 *   node scripts/eval-supplier-demo.js           # 再跑本脚本（走真实 API）
 *
 * 需要服务已在 3000 端口运行。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const P = { period_start: '2026-07-01', period_end: '2026-09-30' };
const PRICE = { 1: 85, 2: 70, 3: 78, 4: 82, 5: 88, 6: 65 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (tk, m, p, b) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
    body: b ? JSON.stringify(b) : undefined
  });
  return { s: r.status, j: await r.json() };
};

(async () => {
  const login = await req(null, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123456' });
  if (!login.j.ok) { console.error('登录失败，服务没起？'); process.exit(1); }
  const TK = login.j.data.token;

  // 1. 六家评价（晟彩只有 2 单 → 样本不足）
  const evIds = {};
  for (const sid of [1, 2, 4, 3, 6, 5]) {
    const r = await req(TK, 'POST', '/api/supplier-evals/collect', { supplier_id: sid, ...P, price_score: PRICE[sid] });
    if (r.s === 400 && /已经有评价/.test(r.j.message)) {
      const d = (await req(TK, 'GET', '/api/supplier-evals/board/' + sid)).j.data;
      evIds[sid] = d.evaluations[0].id;
      console.log(`  跳过（已存在）：${d.evaluations[0].ev_no} ${d.supplier.name}`);
      continue;
    }
    if (!r.j.ok) { console.log('  评价失败', sid, r.j.message); continue; }
    const e = r.j.data.evaluation;
    evIds[sid] = e.id;
    console.log(`  ${e.ev_no} ${e.supplier_name} 准交 ${e.on_time_count}/${e.sample_total} 不良 ${e.defect_rate}% 综合 ${e.score} ${e.grade_label}`);
  }

  // 2. 落资格：A/B 维持，C 整改，D 暂停，样本不足转备用验证
  const plan = [
    [1, { action: 'keep' }],
    [4, { action: 'keep' }],
    [3, { action: 'keep' }],
    [2, {
      action: 'rectify',
      issue: '准交率 60%，5 单里 2 单迟到（3 天、5 天）；320G 卫衣布两批有退回',
      action_req: '排产提前 3 天，任何延迟须提前 3 天书面通知；退回批次全检后再发',
      due_date: '2026-10-31'
    }],
    [6, {
      action: 'suspend',
      issue: '准交率 40%（5 单 3 单迟到，最长 7 天）；不良率 7.33%（退回 170 件）',
      action_req: '暂停新单。30 天内提交产线整改方案，连续两批全检合格后按新版评价恢复',
      due_date: '2026-11-30'
    }],
    [5, { action: 'verify_backup' }]
  ];
  const qualsNow = (await req(TK, 'GET', '/api/supplier-evals/qualifications')).j.data;
  const target = { keep: 'qualified', rectify: 'conditional', suspend: 'suspended', verify_backup: 'observing' };
  for (const [sid, body] of plan) {
    if (!evIds[sid]) continue;
    const cur = qualsNow.find((q) => q.supplier_id === sid);
    if (cur && cur.status === target[body.action]) {
      console.log(`  已落过（${cur.status_label}）：跳过 ${sid}`);
      continue;
    }
    const r = await req(TK, 'POST', `/api/supplier-evals/${evIds[sid]}/decide`, body);
    const tag = body.action === 'suspend' ? '暂停新单' : body.action === 'rectify' ? '整改' : body.action === 'keep' ? '维持合格' : '转备用';
    console.log(`  ${tag}:`, r.j.ok ? (r.j.data.qualification ? r.j.data.qualification.status_label : r.j.data.rect_no) : r.j.message);
  }

  // 3. 备用产能：晟彩登记并完成三项验证；恒泰留一条待验证
  let baks = (await req(TK, 'GET', '/api/supplier-evals/backups')).j.data;
  if (!baks.find((b) => b.supplier_id === 5)) {
    const r = await req(TK, 'POST', '/api/supplier-evals/backups', {
      supplier_id: 5, scope: '印花', item_desc: '数码印花 A3/A4 前后片',
      capacity_qty: 12000, price_ref: 4.2, lead_days: 6, evidence: '封样单 YP2026-0811'
    });
    console.log('  登记备用（晟彩）:', r.j.ok ? '#' + r.j.data.id : r.j.message);
  }
  if (!baks.find((b) => b.supplier_id === 6)) {
    const r = await req(TK, 'POST', '/api/supplier-evals/backups', {
      supplier_id: 6, scope: '成衣加工', item_desc: '针织卫衣 320G', capacity_qty: 6000, price_ref: 26, lead_days: 25
    });
    console.log('  登记备用（恒泰，留待验证）:', r.j.ok ? '#' + r.j.data.id : r.j.message);
  }
  baks = (await req(TK, 'GET', '/api/supplier-evals/backups')).j.data;
  const sc = baks.find((b) => b.supplier_id === 5 && b.status !== 'verified');
  if (sc) {
    const r = await req(TK, 'POST', `/api/supplier-evals/backups/${sc.id}/verify`, {
      tech_ok: true, sample_ok: true, compliance_ok: true,
      verify_note: '技术可做、封样对色通过、环保资质在有效期内',
      evidence: '封样单 YP2026-0811 / 排污许可 2027-05'
    });
    console.log('  三项验证（晟彩）:', r.j.ok ? r.j.data.status_label : r.j.message);
  }

  // 4. 正邦整改走完「提交 → 验证通过」，资格仍为有条件（评价还是 C）
  const rects = (await req(TK, 'GET', '/api/supplier-evals/rectifications')).j.data;
  const rb = rects.find((x) => x.supplier_name === '正邦布业');
  if (rb && rb.status === 'open') {
    await req(TK, 'POST', `/api/supplier-evals/rectifications/${rb.id}/submit`, { submit_note: '已把排产提前 3 天，退回批次改全检后发' });
    const r = await req(TK, 'POST', `/api/supplier-evals/rectifications/${rb.id}/verify`, { pass: true, note: '10 月两批均准交，抽检 200 件无退回' });
    console.log('  正邦整改:', r.j.ok ? `${r.j.data.rectification.status_label} → 资格 ${r.j.data.qualification.status_label}` : r.j.message);
  }

  // 5. 终态
  const b = (await req(TK, 'GET', '/api/supplier-evals/board')).j.data;
  console.log('\n== 终态 ==');
  b.rows.forEach((x) => console.log(`  #${x.rank || '-'} ${x.name} ${x.ev ? x.ev.grade_label : '未评价'} | 资格 ${x.qualification ? x.qualification.status_label : '未定'} | 整改 ${x.open_rects}`));
  console.log('  指标', JSON.stringify(b.stat));
  const g = await req(TK, 'POST', '/api/purchases', { supplier_id: 6, items: [{ name: '门禁自检', qty: 1, price: 1 }] });
  console.log('  向暂停供应商下单:', g.s, g.j.message || '（意外放行）');
})().catch((e) => { console.error(e); process.exit(1); });
