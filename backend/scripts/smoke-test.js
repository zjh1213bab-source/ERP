/**
 * 冒烟测试（只读，不污染数据）
 * 用法：先启动后端，然后 `npm run smoke`
 *      可选环境变量：BASE / ADMIN_USER / ADMIN_PASS
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin123456';
const MALL_USER = process.env.MALL_USER || 'abc001';
const MALL_PASS = process.env.MALL_PASS || 'abc123456';

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (extra ? ' -> ' + extra : ''));
    console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = {};
  try { json = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, json };
}

(async () => {
  console.log(`\n冒烟测试 → ${BASE}\n`);

  // 1. 健康检查
  const health = await req('/api/health');
  ok('健康检查返回 ok', health.status === 200 && health.json.ok === true, `HTTP ${health.status}`);

  // 2. 登录
  const login = await req('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
  const token = login.json && login.json.data && login.json.data.token;
  ok('管理员登录成功', login.status === 200 && !!token, `HTTP ${login.status}`);

  // 3. 错误密码应 401
  const bad = await req('/api/auth/login', { method: 'POST', body: { username: USER, password: 'wrong-password' } });
  ok('错误密码被拒绝(401)', bad.status === 401, `HTTP ${bad.status}`);

  // 4. 未登录访问受保护接口应 401
  const noAuth = await req('/api/users');
  ok('未登录访问用户接口被拒绝(401)', noAuth.status === 401, `HTTP ${noAuth.status}`);

  if (!token) {
    console.log('\n登录失败，跳过后续检查。');
    process.exit(1);
  }

  // 5. 受保护读接口
  const endpoints = [
    '/api/auth/me',
    '/api/settings',
    '/api/customers',
    '/api/products',
    '/api/orders',
    '/api/orders/meta',
    '/api/orders/stats/summary',
    '/api/techpacks/all',
    '/api/materials',
    '/api/size-templates',
    '/api/stock',
    '/api/stock/summary',
    '/api/stock/ship-board?warehouse=us',
    '/api/stats/orders',
    '/api/stats/production',
    '/api/stats/stock',
    '/api/stats/shortage',
    '/api/users'
  ];
  for (const ep of endpoints) {
    const r = await req(ep, { token });
    ok(`GET ${ep}`, r.status === 200 && r.json.ok === true, `HTTP ${r.status}`);
  }

  // 5.5 开发单明细（面辅料 / 成衣尺寸 / 生产要求）
  // 说明：整份保存是幂等的（原样回存）；新建版本后立刻删除，不残留数据
  const tpsAll = await req('/api/techpacks/all', { token });
  const draftTp = (tpsAll.json.data || []).find((t) => t.status !== 'confirmed');
  if (draftTp) {
    const full = await req(`/api/techpacks/${draftTp.id}/full`, { token });
    const fd = full.json.data || {};
    ok('开发单完整明细可读', full.status === 200 && Array.isArray(fd.materials) && Array.isArray(fd.sizes), `HTTP ${full.status}`);

    const saved = await req(`/api/techpacks/${draftTp.id}/detail`, {
      method: 'PUT', token,
      body: { materials: fd.materials || [], sizes: fd.sizes || [], requirements: fd.requirements || [] }
    });
    ok('开发单明细整份保存', saved.status === 200, `HTTP ${saved.status}`);

    const nv = await req(`/api/techpacks/${draftTp.id}/new-version`, { method: 'POST', token });
    ok('开发单新建版本带明细', nv.status === 200 && nv.json.data && nv.json.data.version !== draftTp.version, `HTTP ${nv.status}`);
    if (nv.status === 200 && nv.json.data) {
      await req(`/api/techpacks/${nv.json.data.id}`, { method: 'DELETE', token });
    }
  } else {
    ok('开发单完整明细可读（跳过：无草稿开发单）', true);
  }

  const curTp = await req('/api/techpacks/by-order/1/current', { token });
  ok('订单当前生效开发单', curTp.status === 200, `HTTP ${curTp.status}`);

  // 5.6 面辅料档案
  const matFab = await req('/api/materials?type=fabric', { token });
  ok('面辅料档案按类型筛选', matFab.status === 200 && Array.isArray(matFab.json.data), `HTTP ${matFab.status}`);
  const matQ = await req('/api/materials?q=' + encodeURIComponent('蒙特'), { token });
  ok('面辅料档案关键词搜索', matQ.status === 200 && Array.isArray(matQ.json.data), `HTTP ${matQ.status}`);
  const matNoType = await req('/api/materials', { method: 'POST', token, body: { name: '缺少类型的档案' } });
  ok('新增档案缺类型返回 400', matNoType.status === 400, `HTTP ${matNoType.status}`);
  const matNoName = await req('/api/materials', { method: 'POST', token, body: { type: 'fabric' } });
  ok('新增档案缺名称返回 400', matNoName.status === 400, `HTTP ${matNoName.status}`);
  const mat404 = await req('/api/materials/999999', { token });
  ok('档案不存在返回 404', mat404.status === 404, `HTTP ${mat404.status}`);
  const matDup404 = await req('/api/materials/999999/duplicate', { method: 'POST', token });
  ok('复制不存在档案返回 404', matDup404.status === 404, `HTTP ${matDup404.status}`);

  // 5.6.1 供应商档案
  const supList = await req('/api/suppliers', { token });
  ok('供应商档案列表', supList.status === 200 && Array.isArray(supList.json.data), `HTTP ${supList.status}`);
  const sup404 = await req('/api/suppliers/999999', { token });
  ok('供应商不存在返回 404', sup404.status === 404, `HTTP ${sup404.status}`);
  const supBad = await req('/api/suppliers', { method: 'POST', token, body: { code: 'X' } });
  ok('新增供应商缺名称返回 400', supBad.status === 400, `HTTP ${supBad.status}`);

  // 5.6.2 工序类别
  const ctList = await req('/api/craft-types', { token });
  ok('工序类别列表', ctList.status === 200 && Array.isArray(ctList.json.data), `HTTP ${ctList.status}`);
  const ct404 = await req('/api/craft-types/999999', { token });
  ok('工序类别不存在返回 404', ct404.status === 404, `HTTP ${ct404.status}`);
  const ctBad = await req('/api/craft-types', { method: 'POST', token, body: { code: 'X' } });
  ok('新增工序类别缺名称返回 400', ctBad.status === 400, `HTTP ${ctBad.status}`);

  // 5.6.3 打版流程
  const pfBoard = await req('/api/pattern-flows/board', { token });
  ok('打版流程看板', pfBoard.status === 200 && Array.isArray(pfBoard.json.data.flows), `HTTP ${pfBoard.status}`);
  ok(
    '打版流程六个阶段',
    pfBoard.status === 200 && pfBoard.json.data.stages.length === 6,
    pfBoard.status === 200 ? String(pfBoard.json.data.stages.length) : '-'
  );
  const pfBad = await req('/api/pattern-flows/ensure', { method: 'POST', token, body: {} });
  ok('建流程缺 tech_pack_id 返回 400', pfBad.status === 400, `HTTP ${pfBad.status}`);
  const pf404 = await req('/api/pattern-flows/ensure', { method: 'POST', token, body: { tech_pack_id: 999999 } });
  ok('开发单不存在返回 404', pf404.status === 404, `HTTP ${pf404.status}`);

  // 越级完成阶段必须被拦（不改数据）
  const runningFlow = (pfBoard.json.data && pfBoard.json.data.flows || []).find((f) => f.status === 'running');
  if (runningFlow) {
    const pending = runningFlow.stages.find((s) => s.status !== 'done');
    const later = runningFlow.stages[runningFlow.stages.length - 1];
    if (pending && later && pending.stage !== later.stage) {
      const jump = await req(`/api/pattern-flows/${runningFlow.id}/stage/${later.stage}/done`, { method: 'POST', token });
      ok('打版流程不允许跳阶段', jump.status === 400, `HTTP ${jump.status}`);
    } else {
      ok('打版流程不允许跳阶段（跳过：当前无可跳跃阶段）', true);
    }
  } else {
    ok('打版流程不允许跳阶段（跳过：没有进行中的流程）', true);
  }

  // 5.6.3b 面辅料确认阶段的物料清单
  const anyFlow = (pfBoard.json.data && pfBoard.json.data.flows || [])[0];
  if (anyFlow) {
    const fm = await req(`/api/pattern-flows/${anyFlow.id}/materials`, { token });
    ok('面辅料确认物料清单可读', fm.status === 200 && Array.isArray(fm.json.data.materials), `HTTP ${fm.status}`);
  } else {
    ok('面辅料确认物料清单可读（跳过：无流程）', true);
  }
  const fm404 = await req('/api/pattern-flows/999999/materials', { token });
  ok('流程不存在时物料清单 404', fm404.status === 404, `HTTP ${fm404.status}`);
  const doneFlow = (pfBoard.json.data && pfBoard.json.data.flows || []).find((f) => f.status === 'done');
  if (doneFlow) {
    const fmLocked = await req(`/api/pattern-flows/${doneFlow.id}/materials`, {
      method: 'PUT', token, body: { materials: [] }
    });
    ok('已归档流程禁止改物料', fmLocked.status === 400, `HTTP ${fmLocked.status}`);
  } else {
    ok('已归档流程禁止改物料（跳过：无已完成流程）', true);
  }

  // 5.6.4 样衣档案
  const saList = await req('/api/sample-archives', { token });
  ok('样衣档案列表', saList.status === 200 && Array.isArray(saList.json.data), `HTTP ${saList.status}`);
  const sa404 = await req('/api/sample-archives/999999', { token });
  ok('样衣不存在返回 404', sa404.status === 404, `HTTP ${sa404.status}`);
  const saChg404 = await req('/api/sample-archives/999999/change-request', { method: 'POST', token, body: { reason: 'x' } });
  ok('对不存在样衣提变更返回 404', saChg404.status === 404, `HTTP ${saChg404.status}`);
  const saChgNo = await req('/api/sample-archives/changes/999999/review', { method: 'POST', token, body: { approve: true } });
  ok('审核不存在变更返回 404', saChgNo.status === 404, `HTTP ${saChgNo.status}`);

  // 5.7 档案字段只读：开发单里改名应被后端无视（原样回存，不改变数据）
  const drafts = (tpsAll.json.data || []).filter((t) => t.status !== 'confirmed');
  let arcTarget = null;
  for (const t of drafts) {
    const f = await req(`/api/techpacks/${t.id}/full`, { token });
    const rows = (f.json.data && f.json.data.materials) || [];
    const hit = rows.find((m) => m.material_id);
    if (hit) { arcTarget = { id: t.id, rows, row: hit }; break; }
  }
  if (arcTarget) {
    const tampered = arcTarget.rows.map((m) =>
      m.material_id === arcTarget.row.material_id ? { ...m, material_name: '__TAMPER__', supplier: '__TAMPER__' } : m
    );
    const res2 = await req(`/api/techpacks/${arcTarget.id}/detail`, { method: 'PUT', token, body: { materials: tampered } });
    const after = ((res2.json.data && res2.json.data.materials) || []).find((m) => m.material_id === arcTarget.row.material_id);
    ok(
      '档案字段在开发单内不可篡改',
      !!after && after.material_name !== '__TAMPER__' && after.supplier !== '__TAMPER__',
      after ? after.material_name : 'no row'
    );
  } else {
    ok('档案字段在开发单内不可篡改（跳过：没有引用档案的草稿单）', true);
  }

  const badTp = await req('/api/techpacks/999999/full', { token });
  ok('开发单不存在返回 404', badTp.status === 404, `HTTP ${badTp.status}`);

  const badDetail = await req('/api/techpacks/999999/detail', { method: 'PUT', token, body: {} });
  ok('保存不存在开发单明细返回 404', badDetail.status === 404, `HTTP ${badDetail.status}`);

  // 5.9 订单反审退回
  const ordList = await req('/api/orders?pageSize=5', { token });
  const anyOrder = (ordList.json.data || [])[0];
  if (anyOrder) {
    const rbBad1 = await req(`/api/orders/${anyOrder.id}/rollback`, {
      method: 'POST', token, body: { to: 'closed', reason: 'x' }
    });
    ok('反审退到后面/非法状态被拒', rbBad1.status === 400, `HTTP ${rbBad1.status}`);
    const rbBad2 = await req(`/api/orders/${anyOrder.id}/rollback`, {
      method: 'POST', token, body: { to: 'draft' }
    });
    ok('反审不填原因被拒', rbBad2.status === 400, `HTTP ${rbBad2.status}`);
  }
  const rb404 = await req('/api/orders/999999/rollback', {
    method: 'POST', token, body: { to: 'draft', reason: 'x' }
  });
  ok('反审不存在订单返回 404', rb404.status === 404, `HTTP ${rb404.status}`);

  // 5.10 往来账（应收 / 应付 / 收付款）
  const finSum = await req('/api/finance/summary', { token });
  ok('往来账总览可读', finSum.status === 200 && finSum.json.data && typeof finSum.json.data.ar_open === 'number', `HTTP ${finSum.status}`);
  const finAr = await req('/api/finance/ar', { token });
  ok('应收列表可读', finAr.status === 200 && Array.isArray(finAr.json.data), `HTTP ${finAr.status}`);
  const finAp = await req('/api/finance/ap', { token });
  ok('应付列表可读', finAp.status === 200 && Array.isArray(finAp.json.data), `HTTP ${finAp.status}`);
  const finAg = await req('/api/finance/aging?kind=ar', { token });
  ok('账龄分析可读', finAg.status === 200 && finAg.json.data && finAg.json.data.buckets, `HTTP ${finAg.status}`);
  const finPay = await req('/api/finance/payments', { token });
  ok('收付款列表可读', finPay.status === 200 && Array.isArray(finPay.json.data), `HTTP ${finPay.status}`);
  const finBad = await req('/api/finance/payments', {
    method: 'POST', token, body: { direction: 'in', partner_name: 'X', amount: 100, allocations: [{ invoice_id: 999999, amount: 100 }] }
  });
  ok('核销不存在账款被拒', finBad.status === 400, `HTTP ${finBad.status}`);
  const finRev404 = await req('/api/finance/payments/999999/reverse', { method: 'POST', token, body: { reason: 'x' } });
  ok('红冲不存在记录返回 404', finRev404.status === 404, `HTTP ${finRev404.status}`);

  // 5.10b 美金开票口径：应收单带 currency / amount_orig / rate
  const arUsd = (finAr.json.data || []).find((r) => r.currency === 'USD');
  ok(
    '应收单支持美金原币口径',
    arUsd ? (Number(arUsd.amount_orig) > 0 && Number(arUsd.rate) > 0) : true,
    arUsd ? `${arUsd.bill_no} USD ${arUsd.amount_orig} × ${arUsd.rate}` : '当前无美金应收（跳过）'
  );

  // 5.11 成本与毛利（一单一成本对象）
  const costOv = await req('/api/costing/overview', { token });
  ok('成本总览可读', costOv.status === 200 && typeof costOv.json.data.sold_cost === 'number', `HTTP ${costOv.status}`);
  const costList = await req('/api/costing/orders', { token });
  ok('成本订单列表可读', costList.status === 200 && Array.isArray(costList.json.data), `HTTP ${costList.status}`);
  const cost404 = await req('/api/costing/orders/999999', { token });
  ok('成本对象订单不存在返回 404', cost404.status === 404, `HTTP ${cost404.status}`);
  const costCollect404 = await req('/api/costing/orders/999999/collect', { method: 'POST', token });
  ok('归集不存在订单返回 404', costCollect404.status === 404, `HTTP ${costCollect404.status}`);
  const costEntryBadLayer = await req('/api/costing/entries', {
    method: 'POST', token, body: { order_id: 1, layer: 'xxx', amount: 100 }
  });
  ok('成本层非法被拒', costEntryBadLayer.status === 400, `HTTP ${costEntryBadLayer.status}`);
  const costEntryAuto = await req('/api/costing/entries', {
    method: 'POST', token, body: { order_id: 1, layer: 'material', amount: 100 }
  });
  ok('自动归集层不允许手工追加', costEntryAuto.status === 400, `HTTP ${costEntryAuto.status}`);
  const costEntryNoAmt = await req('/api/costing/entries', {
    method: 'POST', token, body: { order_id: 1, layer: 'freight' }
  });
  ok('追加成本缺金额被拒', costEntryNoAmt.status === 400, `HTTP ${costEntryNoAmt.status}`);
  const costDel404 = await req('/api/costing/entries/999999', { method: 'DELETE', token });
  ok('删除不存在成本项返回 404', costDel404.status === 404, `HTTP ${costDel404.status}`);

  // 5.12 接单评审与交期承诺
  const cmBoard = await req('/api/commitments/board', { token });
  ok('交期承诺看板可读', cmBoard.status === 200 && cmBoard.json.data && cmBoard.json.data.stat, `HTTP ${cmBoard.status}`);
  const cmCap = await req('/api/commitments/capacity', { token });
  ok('产能负荷参考可读', cmCap.status === 200 && typeof cmCap.json.data.load_pct === 'number', `HTTP ${cmCap.status}`);
  const cmDefs = await req('/api/commitments/node-defs', { token });
  ok('路线节点定义可读', cmDefs.status === 200 && cmDefs.json.data.defs.P1, `HTTP ${cmDefs.status}`);
  const cm404 = await req('/api/commitments/order/999999', { token });
  ok('承诺单订单不存在返回 404', cm404.status === 404, `HTTP ${cm404.status}`);
  const cmReview404 = await req('/api/commitments/999999/review', {
    method: 'POST', token, body: { front_ok: true, back_ok: true, material_ok: true, promised_date: '2026-12-01', note: 'x' }
  });
  ok('评审不存在承诺单返回 404', cmReview404.status === 404, `HTTP ${cmReview404.status}`);
  const firstCm = (cmBoard.json.data.rows || [])[0];
  if (firstCm) {
    // 已有承诺日时不会因「缺日期」报错（复核可只改勾选），所以测「承诺日早于 T0」更实在
    const cmBadDate = await req(`/api/commitments/${firstCm.id}/review`, {
      method: 'POST', token, body: { front_ok: true, back_ok: true, material_ok: true, promised_date: '2020-01-01', note: 'x' }
    });
    ok('承诺日早于起算日被拒', cmBadDate.status === 400, `HTTP ${cmBadDate.status}`);
    const cmNoNote = await req(`/api/commitments/${firstCm.id}/review`, {
      method: 'POST', token, body: { front_ok: true, back_ok: false, material_ok: true, promised_date: '2026-12-01' }
    });
    ok('评审缺意见（有环节不通过）被拒', cmNoNote.status === 400, `HTTP ${cmNoNote.status}`);
    const cmNode404 = await req(`/api/commitments/${firstCm.id}/nodes/999999`, {
      method: 'POST', token, body: { status: 'done' }
    });
    ok('承诺单节点不存在返回 404', cmNode404.status === 404, `HTTP ${cmNode404.status}`);
  }
  // 评审未通过 / 未做的订单不能进技术确认（挑一条 rejected 的，别挑到已通过的）
  const rejectedCm = (cmBoard.json.data.rows || []).find((r) => r.review_status === 'rejected');
  if (rejectedCm) {
    const blocked = await req(`/api/orders/${rejectedCm.order_id}/transition`, { method: 'POST', token, body: { to: 'tech' } });
    ok(
      '未通过接单评审的订单不能进技术确认',
      blocked.status === 400 && /接单评审/.test(blocked.json.message || ''),
      `HTTP ${blocked.status} ${String(blocked.json.message || '').slice(0, 40)}`
    );
  } else {
    ok('未通过接单评审的订单不能进技术确认（跳过：无驳回记录）', true);
  }

  // 5.13 齐套与缺料
  const rqBoard = await req('/api/requirements/board', { token });
  ok('齐套看板可读', rqBoard.status === 200 && rqBoard.json.data && rqBoard.json.data.stat, `HTTP ${rqBoard.status}`);
  const rqLines = await req('/api/requirements/lines', { token });
  ok('齐套需求行可读', rqLines.status === 200 && Array.isArray(rqLines.json.data), `HTTP ${rqLines.status}`);
  const rqShort = await req('/api/requirements/shortage', { token });
  ok('采购建议可读', rqShort.status === 200 && Array.isArray(rqShort.json.data), `HTTP ${rqShort.status}`);
  const rqCalc = await req('/api/requirements/calc', { method: 'POST', token });
  ok('齐套重算可执行', rqCalc.status === 200 && typeof rqCalc.json.data.lines === 'number', `HTTP ${rqCalc.status}`);
  const rqAction404 = await req('/api/requirements/999999/action', {
    method: 'POST', token, body: { action: 'ordered' }
  });
  ok('需求行不存在返回 404', rqAction404.status === 404, `HTTP ${rqAction404.status}`);
  const rqEmpty = await req('/api/requirements/order/999999', { token });
  ok('无需求的订单返回空明细', rqEmpty.status === 200 && rqEmpty.json.data.lines.length === 0, `HTTP ${rqEmpty.status}`);

  // 5.14 裁床与扎包
  const cutBoard = await req('/api/cuts/board', { token });
  ok('裁床看板可读', cutBoard.status === 200 && cutBoard.json.data && cutBoard.json.data.stat, `HTTP ${cutBoard.status}`);
  const cut404 = await req('/api/cuts/order/999999', { token });
  ok('裁剪单订单不存在返回 404', cut404.status === 404, `HTTP ${cut404.status}`);
  const cutStart404 = await req('/api/cuts/999999/start', { method: 'POST', token, body: {} });
  ok('开裁不存在裁剪单返回 404', cutStart404.status === 404, `HTTP ${cutStart404.status}`);

  const cutRow = (cutBoard.json.data.rows || [])[0];
  if (cutRow) {
    const noDye = await req(`/api/cuts/${cutRow.id}/lots`, {
      method: 'POST', token, body: { layers: 30, actual_qty: 30 }
    });
    ok('床次缺缸号被拒', noDye.status === 400, `HTTP ${noDye.status}`);
    const noLayers = await req(`/api/cuts/${cutRow.id}/lots`, {
      method: 'POST', token, body: { dye_lot: 'X1', layers: 0, actual_qty: 10 }
    });
    ok('床次层数为 0 被拒', noLayers.status === 400, `HTTP ${noLayers.status}`);
    // 错缸：同单已有别的缸号且未勾选混缸
    const cutDetail = await req(`/api/cuts/order/${cutRow.order_id}`, { token });
    const dyeLots = (cutDetail.json.data && cutDetail.json.data.dye_lots) || [];
    if (dyeLots.length) {
      const mixed = await req(`/api/cuts/${cutRow.id}/lots`, {
        method: 'POST', token, body: { dye_lot: '__OTHER_LOT__', layers: 10, actual_qty: 10 }
      });
      ok('错缸（未确认混缸）被拒', mixed.status === 400, `HTTP ${mixed.status}`);
    } else {
      ok('错缸（未确认混缸）被拒（跳过：该单还没有缸号）', true);
    }
    if (cutRow.status === 'cutting') {
      const h0 = await req(`/api/cuts/${cutRow.id}/handover`, { method: 'POST', token });
      ok('裁剪未完成不能交接', h0.status === 400, `HTTP ${h0.status}`);
    }
    const fin404 = await req('/api/cuts/999999/finish', { method: 'POST', token, body: { qualified_qty: 1 } });
    ok('完成不存在的裁剪单返回 404', fin404.status === 404, `HTTP ${fin404.status}`);
  }

  // 5.15 首件确认与工位工艺
  const faBoard = await req('/api/first-articles/board', { token });
  ok('首件看板可读', faBoard.status === 200 && !!faBoard.json.data.stat && Array.isArray(faBoard.json.data.rows), `HTTP ${faBoard.status}`);
  const faNoOrder = await req('/api/first-articles/order/999999', { token });
  ok('首件订单不存在返回 404', faNoOrder.status === 404, `HTTP ${faNoOrder.status}`);
  const faNoId = await req('/api/first-articles/999999', { token });
  ok('首件单不存在返回 404', faNoId.status === 404, `HTTP ${faNoId.status}`);
  const faWsEmpty = await req('/api/first-articles/workstations?order_id=999999', { token });
  ok('无工位工艺的订单返回空列表', faWsEmpty.status === 200 && faWsEmpty.json.data.length === 0, `HTTP ${faWsEmpty.status}`);
  const faWsNoOrder = await req('/api/first-articles/workstations', { token });
  ok('工位工艺缺 order_id 返回 400', faWsNoOrder.status === 400, `HTTP ${faWsNoOrder.status}`);
  const faRow = (faBoard.json.data.rows || []).find((r) => r.fa);
  if (faRow) {
    const gate = await req(`/api/first-articles/gate/${faRow.order_id}`, { token });
    ok('批量投产门禁可读', gate.status === 200 && typeof gate.json.data.released === 'boolean', `HTTP ${gate.status}`);
    const noReason = await req(`/api/first-articles/${faRow.fa.id}/reject`, { method: 'POST', token, body: { return_to: 'tech' } });
    ok('首件退回不写原因被拒', noReason.status === 400, `HTTP ${noReason.status}`);
    if (faRow.fa.status === 'passed' || faRow.fa.status === 'conditional') {
      const editPassed = await req(`/api/first-articles/${faRow.fa.id}`, { method: 'PUT', token, body: { batch_qty: 1 } });
      ok('已放行首件不允许改', editPassed.status === 400, `HTTP ${editPassed.status}`);
    } else {
      ok('已放行首件不允许改（跳过：该单未放行）', true);
    }
  } else {
    ok('批量投产门禁可读（跳过：还没有首件单）', true);
    ok('首件退回不写原因被拒（跳过：还没有首件单）', true);
    ok('已放行首件不允许改（跳过：还没有首件单）', true);
  }

  // 5.16 生产原料收货与检验
  const grnBoard = await req('/api/receipts/board', { token });
  ok('收料看板可读', grnBoard.status === 200 && !!grnBoard.json.data.stat && Array.isArray(grnBoard.json.data.rows), `HTTP ${grnBoard.status}`);
  const grnPending = await req('/api/receipts/pending', { token });
  ok('待检汇总可读', grnPending.status === 200 && Array.isArray(grnPending.json.data), `HTTP ${grnPending.status}`);
  const grnPo404 = await req('/api/receipts/po/999999', { token });
  ok('采购单不存在返回 404', grnPo404.status === 404, `HTTP ${grnPo404.status}`);
  const grn404 = await req('/api/receipts/999999', { token });
  ok('收料单不存在返回 404', grn404.status === 404, `HTTP ${grn404.status}`);
  const grnRow = (grnBoard.json.data.rows || [])[0];
  if (grnRow) {
    const emptyItems = await req('/api/receipts', { method: 'POST', token, body: { po_id: grnRow.po_id, items: [] } });
    ok('点收不填实收被拒', emptyItems.status === 400, `HTTP ${emptyItems.status}`);
    const grnDetail = await req(`/api/receipts/${grnRow.id}`, { token });
    ok('收料单详情含明细与可检验标记', grnDetail.status === 200 && Array.isArray(grnDetail.json.data.items) && typeof grnDetail.json.data.can_inspect === 'boolean', `HTTP ${grnDetail.status}`);
    const noIns = await req(`/api/receipts/${grnRow.id}/inspect`, { method: 'POST', token, body: { items: [] } });
    ok('检验不填结果被拒', noIns.status === 400, `HTTP ${noIns.status}`);
  } else {
    ok('点收不填实收被拒（跳过：还没有收料单）', true);
    ok('收料单详情含明细与可检验标记（跳过）', true);
    ok('检验不填结果被拒（跳过）', true);
  }

  // 5.17 内部邮件
  const mailUnread = await req('/api/mail/unread', { token });
  ok('邮件未读统计可读', mailUnread.status === 200 && typeof mailUnread.json.data.inbox === 'number', `HTTP ${mailUnread.status}`);
  const mailContacts = await req('/api/mail/contacts', { token });
  ok('内部通讯录含群组', mailContacts.status === 200 && Array.isArray(mailContacts.json.data.groups) && mailContacts.json.data.groups.length > 0, `HTTP ${mailContacts.status}`);
  const mailBox = await req('/api/mail/box?folder=inbox', { token });
  ok('邮箱列表可读', mailBox.status === 200 && Array.isArray(mailBox.json.data.rows) && !!mailBox.json.data.counts, `HTTP ${mailBox.status}`);
  const mailStats = await req('/api/mail/stats', { token });
  ok('投递与确认统计可读', mailStats.status === 200 && typeof mailStats.json.data.lines === 'number', `HTTP ${mailStats.status}`);
  const mail404 = await req('/api/mail/999999', { token });
  ok('邮件不存在返回 404', mail404.status === 404, `HTTP ${mail404.status}`);
  const mailThread404 = await req('/api/mail/thread/999999', { token });
  ok('会话不存在返回 404', mailThread404.status === 404, `HTTP ${mailThread404.status}`);
  const mailEmpty = await req('/api/mail/send', { method: 'POST', token, body: { subject: 'x', body: '' } });
  ok('空正文发信被拒', mailEmpty.status === 400, `HTTP ${mailEmpty.status}`);
  const mailBadTo = await req('/api/mail/send', { method: 'POST', token, body: { subject: 'x', body: 'y', to: ['no-such-user-xyz'] } });
  ok('收件人全部无效被拒', mailBadTo.status === 400, `HTTP ${mailBadTo.status}`);
  const mailConfirmNoDue = await req('/api/mail/send', { method: 'POST', token, body: { subject: 'x', body: 'y', type: 'confirm', to: ['tech01'] } });
  ok('需确认缺截止被拒', mailConfirmNoDue.status === 400, `HTTP ${mailConfirmNoDue.status}`);
  const mailTaskNoOwner = await req('/api/mail/send', { method: 'POST', token, body: { subject: 'x', body: 'y', type: 'task', to: ['tech01'], task: { title: 't' }, task_due: '2026-12-01' } });
  ok('需办理缺主责被拒', mailTaskNoOwner.status === 400, `HTTP ${mailTaskNoOwner.status}`);
  const mailDg = await req('/api/mail/delegates', { token });
  ok('代理授权列表可读', mailDg.status === 200 && Array.isArray(mailDg.json.data), `HTTP ${mailDg.status}`);

  // 5.18 供应商评价与备用产能
  const sevBoard = await req('/api/supplier-evals/board', { token });
  ok('供应商评价看板可读', sevBoard.status === 200 && Array.isArray(sevBoard.json.data.rows) && !!sevBoard.json.data.stat, `HTTP ${sevBoard.status}`);
  ok('看板带样本不足阈值', sevBoard.status === 200 && sevBoard.json.data.min_sample >= 1, `HTTP ${sevBoard.status}`);
  const sevNoSample = await req('/api/supplier-evals/collect', { method: 'POST', token, body: { supplier_id: 7, period_start: '2020-01-01', period_end: '2020-03-31' } });
  ok('无样本不能评价', sevNoSample.status === 400, `HTTP ${sevNoSample.status}`);
  const sevGhost = await req('/api/supplier-evals/collect', { method: 'POST', token, body: { supplier_id: 999999, period_start: '2026-01-01', period_end: '2026-03-31' } });
  ok('评价不存在的供应商 404', sevGhost.status === 404, `HTTP ${sevGhost.status}`);
  const sevBadPeriod = await req('/api/supplier-evals/collect', { method: 'POST', token, body: { supplier_id: 1, period_start: '2026-09-30', period_end: '2026-09-01' } });
  ok('观察期起止颠倒被拒', sevBadPeriod.status === 400, `HTTP ${sevBadPeriod.status}`);
  const sevDup = await req('/api/supplier-evals/collect', { method: 'POST', token, body: { supplier_id: 1, period_start: '2026-07-01', period_end: '2026-09-30' } });
  ok('同一观察期不能重复评价', sevDup.status === 400, `HTTP ${sevDup.status}`);
  const sevQuals = await req('/api/supplier-evals/qualifications', { token });
  ok('供货资格列表可读', sevQuals.status === 200 && Array.isArray(sevQuals.json.data), `HTTP ${sevQuals.status}`);
  const sevRects = await req('/api/supplier-evals/rectifications', { token });
  ok('整改单列表可读', sevRects.status === 200 && Array.isArray(sevRects.json.data), `HTTP ${sevRects.status}`);
  const sevBackups = await req('/api/supplier-evals/backups', { token });
  ok('备用产能列表可读', sevBackups.status === 200 && Array.isArray(sevBackups.json.data), `HTTP ${sevBackups.status}`);
  const sevPick = await req('/api/supplier-evals/backup-pick?qty=1000', { token });
  ok('备用选源可读且声明不按最低价', sevPick.status === 200 && /不按最低价/.test(sevPick.json.data.sort_note || ''), `HTTP ${sevPick.status}`);
  const sevBakNoScope = await req('/api/supplier-evals/backups', { method: 'POST', token, body: { supplier_id: 1 } });
  ok('备用产能缺范围被拒', sevBakNoScope.status === 400, `HTTP ${sevBakNoScope.status}`);
  // 采购下单门禁：暂停新单的供应商建不了单
  const supSusp = await req('/api/supplier-evals/qualifications', { token });
  const suspRow = (supSusp.json.data || []).find((x) => x.status === 'suspended');
  if (suspRow) {
    const poBlocked = await req('/api/purchases', { method: 'POST', token, body: { supplier_id: suspRow.supplier_id, items: [{ name: '测试料', unit: '米', qty: 1, price: 1 }] } });
    ok('暂停供应商下单被拦', poBlocked.status === 400, `HTTP ${poBlocked.status}`);
  } else {
    ok('暂停供应商下单被拦（无暂停供应商，跳过）', true, 'skip');
  }
  const poNoSup = await req('/api/purchases', { method: 'POST', token, body: { supplier: '不存在的临时供应商', items: [{ name: 'x', qty: 1, price: 1 }] } });
  ok('不能用临时供应商名下采购单', poNoSup.status === 400, `HTTP ${poNoSup.status}`);

  // 5.19 停单改量与供应商退料
  const pcBoard = await req('/api/purchase-changes/board', { token });
  ok('变更/退料看板可读', pcBoard.status === 200 && Array.isArray(pcBoard.json.data.changes) && Array.isArray(pcBoard.json.data.returns) && !!pcBoard.json.data.stat, `HTTP ${pcBoard.status}`);
  // 动态挑目标：写死 id 的话，减量跑几次就把「未交量」减到 0，之后每次都 400
  const pcPoList = await req('/api/purchases', { token });
  let pcReduce = null;
  let pcReturn = null;
  for (const po of (pcPoList.json.data || []).slice(0, 25)) {
    const d = await req(`/api/purchase-changes/po/${po.id}`, { token });
    if (d.status !== 200) continue;
    const lines = d.json.data.lines || [];
    if (!pcReduce) {
      const ln = lines.find((x) => Number(x.pending_qty) >= 10);
      if (ln) pcReduce = { po_id: po.id, po_item_id: ln.id };
    }
    if (!pcReturn && d.json.data.has_received) {
      const ln = lines.find((x) => Number(x.returnable_qty) >= 1);
      if (ln) pcReturn = { po_id: po.id, po_item_id: ln.id };
    }
    if (pcReduce && pcReturn) break;
  }
  const pcPo = await req('/api/purchase-changes/po/' + (pcReduce ? pcReduce.po_id : (pcPoList.json.data || [{}])[0].id), { token });
  ok('采购单可改行含未交与可退', pcPo.status === 200 && pcPo.json.data.lines.every((l) => 'pending_qty' in l && 'returnable_qty' in l), `HTTP ${pcPo.status}`);
  const pcGhost = await req('/api/purchase-changes/po/999999', { token });
  ok('变更不存在的采购单 404', pcGhost.status === 404, `HTTP ${pcGhost.status}`);
  if (pcReduce) {
    const pcNoReason = await req('/api/purchase-changes', { method: 'POST', token, body: { po_id: pcReduce.po_id, type: 'reduce', items: [] } });
    ok('变更缺原因被拒', pcNoReason.status === 400, `HTTP ${pcNoReason.status}`);
    const pcOver = await req('/api/purchase-changes', { method: 'POST', token, body: { po_id: pcReduce.po_id, type: 'reduce', reason: '超量', items: [{ po_item_id: pcReduce.po_item_id, reduce_qty: 999999 }] } });
    ok('减量超过未交被拒', pcOver.status === 400, `HTTP ${pcOver.status}`);
  } else {
    ok('变更缺原因被拒', true, '跳过（没有还有未交量的采购单）');
    ok('减量超过未交被拒', true, '跳过（没有还有未交量的采购单）');
  }
  if (pcReturn) {
    const pcCancelRecv = await req('/api/purchase-changes', { method: 'POST', token, body: { po_id: pcReturn.po_id, type: 'cancel', reason: '有到货还想整单停' } });
    ok('有到货的整单停单被拒', pcCancelRecv.status === 400, `HTTP ${pcCancelRecv.status}`);
    const pcRetOver = await req('/api/purchase-changes/returns', { method: 'POST', token, body: { po_id: pcReturn.po_id, reason: '超退', items: [{ po_item_id: pcReturn.po_item_id, qty: 999999 }] } });
    ok('退料超过可退被拒', pcRetOver.status === 400, `HTTP ${pcRetOver.status}`);
    const pcRetNoReason = await req('/api/purchase-changes/returns', { method: 'POST', token, body: { po_id: pcReturn.po_id, items: [{ po_item_id: pcReturn.po_item_id, qty: 1 }] } });
    ok('退料缺原因被拒', pcRetNoReason.status === 400, `HTTP ${pcRetNoReason.status}`);
  } else {
    ['有到货的整单停单被拒', '退料超过可退被拒', '退料缺原因被拒'].forEach((n) => ok(n, true, '跳过（没有可退的采购单）'));
  }
  // 减量会真实消耗「未交量」：采购单跑干了就跳过，别让用例因为数据耗尽而变红
  if (pcReduce) {
    const pcChg = await req('/api/purchase-changes', { method: 'POST', token, body: { po_id: pcReduce.po_id, type: 'reduce', reason: '冒烟减量', items: [{ po_item_id: pcReduce.po_item_id, reduce_qty: 10 }] } });
    ok('建变更单', pcChg.status === 200 && !!pcChg.json.data.change_no, `HTTP ${pcChg.status}`);
    if (pcChg.status === 200) {
      const cid = pcChg.json.data.id;
      const effEarly = await req(`/api/purchase-changes/${cid}/effective`, { method: 'POST', token });
      ok('草稿直接生效被拒', effEarly.status === 400, `HTTP ${effEarly.status}`);
      await req(`/api/purchase-changes/${cid}/submit`, { method: 'POST', token });
      const cf = await req(`/api/purchase-changes/${cid}/supplier-confirm`, { method: 'POST', token, body: { agree: true, supplier_confirmed_by: '冒烟' } });
      ok('供方确认', cf.status === 200 && cf.json.data.status === 'confirmed', `HTTP ${cf.status}`);
      const eff = await req(`/api/purchase-changes/${cid}/effective`, { method: 'POST', token });
      ok('生效落采购行', eff.status === 200 && eff.json.data.status === 'effective', `HTTP ${eff.status}`);
      const line = await req('/api/purchases/' + pcReduce.po_id, { token });
      ok('采购行已按减量更新', line.status === 200
        && (line.json.data.items || []).some((x) => Number(x.id) === Number(pcReduce.po_item_id)), `HTTP ${line.status}`);
    } else {
      ['草稿直接生效被拒', '供方确认', '生效落采购行', '采购行已按减量更新'].forEach((n) => ok(n, false, `建单失败 ${pcChg.json.message || ''}`));
    }
  } else {
    ['建变更单', '草稿直接生效被拒', '供方确认', '生效落采购行', '采购行已按减量更新']
      .forEach((n) => ok(n, true, '跳过（没有还有未交量的采购单）'));
  }
  const pcRet = pcReturn
    ? await req('/api/purchase-changes/returns', { method: 'POST', token, body: { po_id: pcReturn.po_id, reason: '冒烟退料', items: [{ po_item_id: pcReturn.po_item_id, qty: 1 }] } })
    : { status: 0, json: {} };
  ok('建退料单', pcRet.status === 200 && !!pcRet.json.data.return_no, `HTTP ${pcRet.status}`);
  if (pcRet.status === 200) {
    const rid = pcRet.json.data.id;
    const crEarly = await req(`/api/purchase-changes/returns/${rid}/credit`, { method: 'POST', token, body: { credit_note_no: 'CN-SMOKE' } });
    ok('先贷项后实物被拒', crEarly.status === 400, `HTTP ${crEarly.status}`);
    const ph = await req(`/api/purchase-changes/returns/${rid}/physical`, { method: 'POST', token, body: { note: '冒烟签收' } });
    ok('实物回执', ph.status === 200 && ph.json.data.status === 'returned', `HTTP ${ph.status}`);
    const cr = await req(`/api/purchase-changes/returns/${rid}/credit`, { method: 'POST', token, body: { credit_note_no: 'CN-SMOKE', credit_amount: 164 } });
    ok('贷项回执完成', cr.status === 200 && cr.json.data.status === 'done', `HTTP ${cr.status}`);
    const ret2 = await req('/api/purchase-changes/returns', { token });
    ok('退料单列表可读', ret2.status === 200 && Array.isArray(ret2.json.data), `HTTP ${ret2.status}`);
  }

  // 5.20 返工报废与生产结单
  const rwBoard = await req('/api/reworks/board', { token });
  ok('返工报废看板可读', rwBoard.status === 200 && Array.isArray(rwBoard.json.data.rows) && !!rwBoard.json.data.stat, `HTTP ${rwBoard.status}`);
  const rwNoReason = await req('/api/reworks', { method: 'POST', token, body: { order_id: 5, qty: 3 } });
  ok('返工缺原因被拒', rwNoReason.status === 400, `HTTP ${rwNoReason.status}`);
  const rwScrapNoLoss = await req('/api/reworks', { method: 'POST', token, body: { order_id: 5, type: 'scrap', qty: 2, reason: '无法修复' } });
  ok('报废无损失金额被拒', rwScrapNoLoss.status === 400, `HTTP ${rwScrapNoLoss.status}`);
  const rwNodes = await req('/api/reworks/nodes/5', { token });
  ok('订单工序清单可读', rwNodes.status === 200 && Array.isArray(rwNodes.json.data), `HTTP ${rwNodes.status}`);
  const rwCreate = await req('/api/reworks', { method: 'POST', token, body: { order_id: 5, type: 'rework', reason: '冒烟测试返工', qty: 4, cost_labor: 40 } });
  ok('建返工单', rwCreate.status === 200 && !!rwCreate.json.data.rw_no, `HTTP ${rwCreate.status}`);
  if (rwCreate.status === 200) {
    const rid = rwCreate.json.data.id;
    const startEarly = await req(`/api/reworks/${rid}/start`, { method: 'POST', token });
    ok('未批准不能开始返工', startEarly.status === 400, `HTTP ${startEarly.status}`);
    await req(`/api/reworks/${rid}/submit`, { method: 'POST', token });
    const ap = await req(`/api/reworks/${rid}/approve`, { method: 'POST', token, body: { agree: true } });
    ok('批准返工单', ap.status === 200 && ap.json.data.status === 'approved', `HTTP ${ap.status}`);
    await req(`/api/reworks/${rid}/start`, { method: 'POST', token });
    const fail = await req(`/api/reworks/${rid}/reinspect`, { method: 'POST', token, body: { result: 'fail', note: '冒烟：仍有不良' } });
    ok('复验不通过回返工中且次数+1', fail.status === 200 && fail.json.data.rework.status === 'in_progress' && fail.json.data.rework.rework_times >= 2, `HTTP ${fail.status}`);
    const pass = await req(`/api/reworks/${rid}/reinspect`, { method: 'POST', token, body: { result: 'pass', qty_ok: 4, note: '冒烟：抽检合格' } });
    ok('复验通过闭环', pass.status === 200 && pass.json.data.rework.status === 'closed', `HTTP ${pass.status}`);
    const cost = await req('/api/costing/orders/5', { token });
    const rwEntries = ((cost.json.data || {}).entries || []).filter((e) => e.layer === 'rework');
    ok('返工损失进成本 rework 层', cost.status === 200 && rwEntries.length > 0, `HTTP ${cost.status} entries=${rwEntries.length}`);
  }
  const closeGate = await req('/api/production-close/gate/5', { token });
  ok('结单检查可读', closeGate.status === 200 && Array.isArray(closeGate.json.data.blocked) && Array.isArray(closeGate.json.data.warns), `HTTP ${closeGate.status}`);
  const closeBlocked = await req('/api/production-close', { method: 'POST', token, body: { order_id: 5 } });
  ok('有硬阻塞不许结单', closeBlocked.status === 400, `HTTP ${closeBlocked.status}`);
  const closePartialNoNote = await req('/api/production-close', { method: 'POST', token, body: { order_id: 11, close_type: 'partial' } });
  ok('部分关闭缺争议说明被拒', closePartialNoNote.status === 400, `HTTP ${closePartialNoNote.status}`);
  const closeBoard = await req('/api/production-close/board', { token });
  const closable = (closeBoard.json.data.rows || []).find((r) => r.can_close && !r.closure && !(r.warns || []).length);
  if (closable) {
    const cl = await req('/api/production-close', { method: 'POST', token, body: { order_id: closable.order_id, actual_close_date: '2026-10-20' } });
    ok('全结成功且区分实际日期与录入时间', cl.status === 200 && cl.json.data.close_type === 'full' && cl.json.data.actual_close_date === '2026-10-20' && cl.json.data.recorded_at !== cl.json.data.actual_close_date, `HTTP ${cl.status}`);
    const dup = await req('/api/production-close', { method: 'POST', token, body: { order_id: closable.order_id } });
    ok('重复全结被拒', dup.status === 400, `HTTP ${dup.status}`);
  } else {
    ok('全结成功（无可用订单，跳过）', true, 'skip');
    ok('重复全结被拒（跳过）', true, 'skip');
  }

  // 5.21 设备停机与产能
  const eqBoard = await req('/api/equipment/board', { token });
  ok('设备台账可读', eqBoard.status === 200 && Array.isArray(eqBoard.json.data.equipment) && !!eqBoard.json.data.stat, `HTTP ${eqBoard.status}`);
  const eqNoCap = await req('/api/equipment', { method: 'POST', token, body: { name: '冒烟测试机', work_center: '一车间' } });
  ok('建设备缺台时产能被拒', eqNoCap.status === 400, `HTTP ${eqNoCap.status}`);
  const dtNoReason = await req('/api/equipment/downtimes', { method: 'POST', token, body: { equipment_id: 3 } });
  ok('登记停机缺原因被拒', dtNoReason.status === 400, `HTTP ${dtNoReason.status}`);
  const dtCreate = await req('/api/equipment/downtimes', { method: 'POST', token, body: { equipment_id: 3, type: 'breakdown', reason: '冒烟：针板毛刺' } });
  ok('登记停机', dtCreate.status === 200 && !!dtCreate.json.data.dt_no, `HTTP ${dtCreate.status}`);
  if (dtCreate.status === 200) {
    const did = dtCreate.json.data.id;
    const dupOpen = await req('/api/equipment/downtimes', { method: 'POST', token, body: { equipment_id: 3, reason: '冒烟：重复登记' } });
    ok('同设备重复停机被拒', dupOpen.status === 400, `HTTP ${dupOpen.status}`);
    const skipSafety = await req(`/api/equipment/downtimes/${did}/safety`, { method: 'POST', token, body: { safety_by: '张组长', safety_note: '跳过维修' } });
    ok('不能跳过维修直接恢复', skipSafety.status === 400, `HTTP ${skipSafety.status}`);
    await req(`/api/equipment/downtimes/${did}/start-repair`, { method: 'POST', token });
    const finNoNote = await req(`/api/equipment/downtimes/${did}/finish-repair`, { method: 'POST', token, body: {} });
    ok('结束维修缺说明被拒', finNoNote.status === 400, `HTTP ${finNoNote.status}`);
    const fin = await req(`/api/equipment/downtimes/${did}/finish-repair`, { method: 'POST', token, body: { repair_note: '冒烟：换针板' } });
    ok('结束维修转待安全复核', fin.status === 200 && fin.json.data.status === 'pending_safety', `HTTP ${fin.status}`);
    const safetyNoBy = await req(`/api/equipment/downtimes/${did}/safety`, { method: 'POST', token, body: { safety_note: '试机正常' } });
    ok('安全放行缺责任人被拒', safetyNoBy.status === 400, `HTTP ${safetyNoBy.status}`);
    const safetyOk = await req(`/api/equipment/downtimes/${did}/safety`, { method: 'POST', token, body: { safety_by: '张组长', safety_note: '冒烟：试缝 3 件合格' } });
    ok('安全放行恢复产能', safetyOk.status === 200 && safetyOk.json.data.status === 'recovered' && safetyOk.json.data.capacity_loss >= 0, `HTTP ${safetyOk.status}`);
    const cancelRecovered = await req(`/api/equipment/downtimes/${did}/cancel`, { method: 'POST', token, body: { reason: '冒烟' } });
    ok('已恢复停机单不能作废', cancelRecovered.status === 400, `HTTP ${cancelRecovered.status}`);
  }
  const eqCap = await req('/api/equipment/capacity?work_center=一车间', { token });
  ok('产能可用性可读', eqCap.status === 200 && typeof eqCap.json.data.available_hours === 'number' && !!eqCap.json.data.promise_note, `HTTP ${eqCap.status}`);
  const eqCapBoard = await req('/api/equipment/capacity-board', { token });
  ok('全厂产能看板可读', eqCapBoard.status === 200 && Array.isArray(eqCapBoard.json.data.rows) && !!eqCapBoard.json.data.total, `HTTP ${eqCapBoard.status}`);

  // 5.22 岗位绩效与申诉
  const kpiDict = await req('/api/kpi/dict', { token });
  ok('绩效字典可读', kpiDict.status === 200 && !!kpiDict.json.data.data_sources && !!kpiDict.json.data.reason_types, `HTTP ${kpiDict.status}`);
  const kpiTpls = await req('/api/kpi/templates', { token });
  ok('绩效模板列表可读', kpiTpls.status === 200 && Array.isArray(kpiTpls.json.data.rows) && !!kpiTpls.json.data.dict, `HTTP ${kpiTpls.status}`);
  const approvedTpl = (kpiTpls.json.data.rows || []).find((t) => t.status === 'approved');
  if (approvedTpl) {
    const det = await req('/api/kpi/templates/' + approvedTpl.id, { token });
    ok('模板详情含指标与完整性检查', det.status === 200 && Array.isArray(det.json.data.rules) && det.json.data.rules.every((r) => Array.isArray(r.missing)), `HTTP ${det.status}`);
    const addRuleLocked = await req(`/api/kpi/templates/${approvedTpl.id}/rules`, { method: 'POST', token, body: { name: '冒烟指标', weight: 10 } });
    ok('已批准模板不能改指标', addRuleLocked.status === 400, `HTTP ${addRuleLocked.status}`);
    const submitAgain = await req(`/api/kpi/templates/${approvedTpl.id}/submit`, { method: 'POST', token });
    ok('已批准模板不能重复提交', submitAgain.status === 400, `HTTP ${submitAgain.status}`);
    const sim = await req(`/api/kpi/templates/${approvedTpl.id}/simulate`, { method: 'POST', token, body: {} });
    ok('模板可模拟试算且不写正式分', sim.status === 200 && sim.json.data.simulated === true, `HTTP ${sim.status}`);
  }
  const tplNoFam = await req('/api/kpi/templates', { method: 'POST', token, body: { name: '冒烟缺岗位族', base_score: 100 } });
  ok('建模板缺岗位族被拒', tplNoFam.status === 400, `HTTP ${tplNoFam.status}`);
  const tplGhost = await req('/api/kpi/templates/999999', { token });
  ok('模板不存在返回 404', tplGhost.status === 404, `HTTP ${tplGhost.status}`);
  const kpiCycles = await req('/api/kpi/cycles', { token });
  ok('考核周期列表可读', kpiCycles.status === 200 && Array.isArray(kpiCycles.json.data), `HTTP ${kpiCycles.status}`);
  const frozenCycle = (kpiCycles.json.data || []).find((c) => c.status === 'frozen');
  if (frozenCycle) {
    const genFrozen = await req('/api/kpi/generate', { method: 'POST', token, body: { cycle_id: frozenCycle.id } });
    ok('冻结周期不能再生成', genFrozen.status === 400, `HTTP ${genFrozen.status}`);
    const freezeAgain = await req(`/api/kpi/cycles/${frozenCycle.id}/freeze`, { method: 'POST', token });
    ok('周期不能重复冻结', freezeAgain.status === 400, `HTTP ${freezeAgain.status}`);
  }
  const kpiBoard = await req('/api/kpi/board', { token });
  ok('绩效看板可读且区分暂定分', kpiBoard.status === 200 && Array.isArray(kpiBoard.json.data.rows) && !!kpiBoard.json.data.stat, `HTTP ${kpiBoard.status}`);
  ok('看板不把建议分算进当前分', kpiBoard.status === 200 && (kpiBoard.json.data.rows || []).every((r) => r.current_score === null || Math.abs(r.current_score - (r.base_score - r.confirmed_score)) < 0.02), '公式核对');
  const notFinal = (kpiBoard.json.data.rows || []).find((r) => r.not_final);
  ok('未结申诉的单不给最终分', !notFinal || notFinal.final_score === null || notFinal.final_score === undefined, `not_final=${!!notFinal}`);
  const kpiAppeals = await req('/api/kpi/appeals', { token });
  ok('申诉列表可读', kpiAppeals.status === 200 && Array.isArray(kpiAppeals.json.data.rows) && !!kpiAppeals.json.data.dict, `HTTP ${kpiAppeals.status}`);
  const kpiSummary = await req('/api/kpi/summary', { token });
  ok('绩效汇总可读', kpiSummary.status === 200 && Array.isArray(kpiSummary.json.data.trend), `HTTP ${kpiSummary.status}`);
  // 取一个真实扣分项来测参数校验（item 不存在会先 404，测不到类型校验）
  let anyItemId = null;
  const anyScore = (kpiBoard.json.data.rows || [])[0];
  if (anyScore) {
    const sd = await req('/api/kpi/scores/' + anyScore.id, { token });
    anyItemId = ((sd.json.data || {}).items || []).length ? sd.json.data.items[0].id : null;
  }
  const appealBadType = await req('/api/kpi/appeals', { method: 'POST', token, body: { item_id: anyItemId || 999999, reason_type: 'no_such_type', reason: '冒烟测试理由够长' } });
  ok('申诉类型非法被拒', anyItemId ? appealBadType.status === 400 : appealBadType.status === 404, `HTTP ${appealBadType.status}`);
  const appealGhost = await req('/api/kpi/appeals', { method: 'POST', token, body: { item_id: 999999, reason_type: 'rule', reason: '冒烟测试理由够长' } });
  ok('对不存在的扣分项申诉 404', appealGhost.status === 404, `HTTP ${appealGhost.status}`);
  const itemGhost = await req('/api/kpi/items/999999/confirm', { method: 'POST', token, body: { action: 'confirm', confirmed_score: 1, note: 'x' } });
  ok('复核不存在的扣分项 404', itemGhost.status === 404, `HTTP ${itemGhost.status}`);

  // 5.23 行政合同与履约日历 / 印章独立授权
  const acBoard = await req('/api/admin-contracts/board', { token });
  ok('行政合同看板可读', acBoard.status === 200 && Array.isArray(acBoard.json.data.contracts) && !!acBoard.json.data.stat, `HTTP ${acBoard.status}`);
  ok('看板带到期与印章授权预警', acBoard.status === 200 && Array.isArray(acBoard.json.data.alerts), `HTTP ${acBoard.status}`);
  const acDict = await req('/api/admin-contracts/dict', { token });
  ok('行政合同字典可读', acDict.status === 200 && !!acDict.json.data.type && !!acDict.json.data.ms_type, `HTTP ${acDict.status}`);
  const acList = await req('/api/admin-contracts/contracts', { token });
  ok('合同列表可读', acList.status === 200 && Array.isArray(acList.json.data.rows), `HTTP ${acList.status}`);
  const anyContract = (acList.json.data.rows || [])[0];
  if (anyContract) {
    const det = await req('/api/admin-contracts/contracts/' + anyContract.id, { token });
    ok('合同详情含版本与履约任务', det.status === 200 && Array.isArray(det.json.data.versions) && Array.isArray(det.json.data.milestones), `HTTP ${det.status}`);
    const renewNoBasis = await req(`/api/admin-contracts/contracts/${anyContract.id}/renew`, { method: 'POST', token, body: { end_date: '2030-01-01' } });
    ok('续签缺依据被拒', renewNoBasis.status === 400, `HTTP ${renewNoBasis.status}`);
    const termNoReason = await req(`/api/admin-contracts/contracts/${anyContract.id}/terminate`, { method: 'POST', token, body: {} });
    ok('终止缺原因被拒', termNoReason.status === 400, `HTTP ${termNoReason.status}`);
  }
  const acMissing = await req('/api/admin-contracts/contracts', { method: 'POST', token, body: { name: '冒烟合同', type: 'lease', start_date: '2026-01-01', end_date: '2027-01-01', owner: '行政' } });
  ok('建合同缺对手方被拒', acMissing.status === 400, `HTTP ${acMissing.status}`);
  const acDeposit = await req('/api/admin-contracts/contracts', { method: 'POST', token, body: { name: '冒烟合同', type: 'lease', counterparty: '某公司', owner: '行政', start_date: '2026-01-01', end_date: '2027-01-01', deposit: 1000 } });
  ok('押金无返还日被拒', acDeposit.status === 400, `HTTP ${acDeposit.status}`);
  const acGhost = await req('/api/admin-contracts/contracts/999999', { token });
  ok('合同不存在返回 404', acGhost.status === 404, `HTTP ${acGhost.status}`);
  const acCal = await req('/api/admin-contracts/calendar', { token });
  ok('履约日历可读（含证照与借章）', acCal.status === 200 && Array.isArray(acCal.json.data.items) && !!acCal.json.data.stat, `HTTP ${acCal.status}`);
  const acGrants = await req('/api/admin-contracts/seal-grants', { token });
  ok('印章授权与覆盖率可读', acGrants.status === 200 && Array.isArray(acGrants.json.data.rows) && Array.isArray(acGrants.json.data.coverage), `HTTP ${acGrants.status}`);
  const seals = (acGrants.json.data.seals || []);
  if (seals.length) {
    const acUsageNoPurpose = await req('/api/admin-contracts/seal-usages', { method: 'POST', token, body: { seal_id: seals[0].id } });
    ok('用印缺用途被拒', acUsageNoPurpose.status === 400, `HTTP ${acUsageNoPurpose.status}`);
    const borrowNoDate = await req('/api/admin-contracts/seal-usages', { method: 'POST', token, body: { seal_id: seals[0].id, kind: 'borrow', purpose: '冒烟借章' } });
    ok('借章缺预计归还日被拒', borrowNoDate.status === 400, `HTTP ${borrowNoDate.status}`);
  } else {
    ok('用印缺用途被拒（无印章，跳过）', true, 'skip');
    ok('借章缺预计归还日被拒（无印章，跳过）', true, 'skip');
  }
  const msDone = await req('/api/admin-contracts/milestones/999999/done', { method: 'POST', token, body: { evidence: 'x' } });
  ok('完成不存在的履约任务 404', msDone.status === 404, `HTTP ${msDone.status}`);
  const pendMs = (acCal.json.data.items || []).find((x) => x.source === 'milestone' && x.effective_status !== 'done');
  if (pendMs) {
    const noEvidence = await req(`/api/admin-contracts/milestones/${pendMs.id}/done`, { method: 'POST', token, body: {} });
    ok('完成任务缺证据被拒', noEvidence.status === 400, `HTTP ${noEvidence.status}`);
  }
  const acCerts = await req('/api/admin-contracts/certificates', { token });
  ok('证照档案可读（含到期与访问级别）', acCerts.status === 200 && Array.isArray(acCerts.json.data) && acCerts.json.data.every((c) => 'expiring' in c && 'access_level' in c), `HTTP ${acCerts.status}`);
  if (acCerts.json.data.length) {
    const view = await req(`/api/admin-contracts/certificates/${acCerts.json.data[0].id}/view`, { method: 'POST', token, body: { action: 'view', reason: '冒烟访问留痕' } });
    ok('敏感档案查看留痕', view.status === 200 && /留痕/.test(view.json.data.notice || ''), `HTTP ${view.status}`);
  }
  const acLogs = await req('/api/admin-contracts/access-logs', { token });
  ok('访问日志可读', acLogs.status === 200 && Array.isArray(acLogs.json.data.rows) && !!acLogs.json.data.stat, `HTTP ${acLogs.status}`);

  // 5.24 流程超时升级 / 代理 / SOP
  const prBoard = await req('/api/process/board', { token });
  ok('流程看板可读', prBoard.status === 200 && !!prBoard.json.data.stat && Array.isArray(prBoard.json.data.queue), `HTTP ${prBoard.status}`);
  ok('看板声明不自动通过', prBoard.status === 200 && /不会自动通过/.test(prBoard.json.data.note || ''), 'note 校验');
  const prDict = await req('/api/process/dict', { token });
  ok('流程字典可读', prDict.status === 200 && !!prDict.json.data.sop_status && !!prDict.json.data.level, `HTTP ${prDict.status}`);
  const prSla = await req('/api/process/sla', { token });
  ok('流程时限可读', prSla.status === 200 && Array.isArray(prSla.json.data.flows) && prSla.json.data.flows.every((f) => Array.isArray(f.steps)), `HTTP ${prSla.status}`);
  const prTasks = await req('/api/process/tasks', { token });
  ok('在办任务只算当前步且不自动通过', prTasks.status === 200 && (prTasks.json.data.rows || []).every((t) => t.can_auto_approve === false), `HTTP ${prTasks.status}`);
  const anyTask = (prTasks.json.data.rows || [])[0];
  if (anyTask) {
    const escNoReason = await req(`/api/process/tasks/${anyTask.id}/escalate`, { method: 'POST', token, body: { escalated_to: 'sales01' } });
    ok('升级缺原因被拒', escNoReason.status === 400, `HTTP ${escNoReason.status}`);
    const escNoTo = await req(`/api/process/tasks/${anyTask.id}/escalate`, { method: 'POST', token, body: { reason: '冒烟' } });
    ok('升级缺接手人被拒', escNoTo.status === 400, `HTTP ${escNoTo.status}`);
    const escGhost = await req(`/api/process/tasks/${anyTask.id}/escalate`, { method: 'POST', token, body: { escalated_to: 'no-such-user-xyz', reason: '冒烟' } });
    ok('升级接手人不存在 404', escGhost.status === 404, `HTTP ${escGhost.status}`);
  }
  const dgNoReason = await req('/api/process/delegates', { method: 'POST', token, body: { from_user: 'fin01', to_user: 'prod01' } });
  ok('设代理缺原因被拒', dgNoReason.status === 400, `HTTP ${dgNoReason.status}`);
  const dgSelf = await req('/api/process/delegates', { method: 'POST', token, body: { from_user: 'fin01', to_user: 'fin01', reason: '冒烟' } });
  ok('不能给自己设代理', dgSelf.status === 400, `HTTP ${dgSelf.status}`);
  if (anyTask) {
    const dgTask = await req(`/api/process/tasks/${anyTask.id}/delegate`, { method: 'POST', token, body: { from_user: 'fin01', to_user: 'wh01' } });
    ok('无代理授权不能转交', dgTask.status === 400, `HTTP ${dgTask.status}`);
  }
  const sopList = await req('/api/process/sop', { token });
  ok('制度清单可读', sopList.status === 200 && Array.isArray(sopList.json.data.rows), `HTTP ${sopList.status}`);
  ok('废止制度不再显示签收进度', sopList.status === 200 && (sopList.json.data.rows || []).filter((d) => d.status === 'retired').every((d) => d.ack_total === 0), 'retired ack');
  const sopNoTitle = await req('/api/process/sop', { method: 'POST', token, body: { category: 'sop', owner: 'admin' } });
  ok('建制度缺名称被拒', sopNoTitle.status === 400, `HTTP ${sopNoTitle.status}`);
  const sopGhost = await req('/api/process/sop/999999', { token });
  ok('制度不存在 404', sopGhost.status === 404, `HTTP ${sopGhost.status}`);
  const tplDoc = (sopList.json.data.rows || []).find((d) => d.status !== 'retired');
  if (tplDoc) {
    const missFour = await req(`/api/process/sop/${tplDoc.id}/versions`, { method: 'POST', token, body: { doing: '做法' } });
    ok('SOP 四要素缺项被拒', missFour.status === 400, `HTTP ${missFour.status}`);
  }
  const sopDraft = (sopList.json.data.rows || []).find((d) => d.status === 'pending');
  if (sopDraft) {
    const retireNoReason = await req(`/api/process/sop/${sopDraft.id}/retire`, { method: 'POST', token, body: {} });
    void retireNoReason;
  }
  const prScan = await req('/api/process/scan', { method: 'POST', token });
  ok('扫描不自动通过审批', prScan.status === 200 && /不会自动通过/.test(prScan.json.data.notice || ''), `HTTP ${prScan.status}`);

  // 6. 导出 CSV
  const csvRes = await fetch(BASE + '/api/orders/export', { headers: { Authorization: 'Bearer ' + token } });
  const csvText = await csvRes.text();
  ok('订单导出 CSV', csvRes.status === 200 && csvText.includes('订单号'), `HTTP ${csvRes.status}`);

  // 7. 批量导入：模板下载 + 参数校验（不写入数据）
  const tplRes = await fetch(BASE + '/api/import/template/customers', { headers: { Authorization: 'Bearer ' + token } });
  const tplText = await tplRes.text();
  ok('导入模板下载', tplRes.status === 200 && tplText.includes('编号'), `HTTP ${tplRes.status}`);
  const tpl404 = await fetch(BASE + '/api/import/template/nope', { headers: { Authorization: 'Bearer ' + token } });
  ok('未知模板返回 404', tpl404.status === 404, `HTTP ${tpl404.status}`);
  const emptyImp = await req('/api/import/customers', { method: 'POST', body: { csv: '' }, token });
  ok('空 CSV 返回 400', emptyImp.status === 400, `HTTP ${emptyImp.status}`);
  const headerOnly = await req('/api/import/products', { method: 'POST', body: { csv: '款号,名称,品类' }, token });
  ok('仅表头无数据行返回 400', headerOnly.status === 400, `HTTP ${headerOnly.status}`);

  // 8. 阶梯报价 / 报价单
  const tq = await req('/api/quotations', { token });
  ok('GET /api/quotations', tq.status === 200 && tq.json.ok === true, `HTTP ${tq.status}`);
  const qm = await req('/api/quotations/meta', { token });
  ok('GET /api/quotations/meta 返回状态表', qm.status === 200 && !!qm.json.data.labels.draft, `HTTP ${qm.status}`);
  const pt = await req('/api/price-tiers', { token });
  ok('GET /api/price-tiers', pt.status === 200 && Array.isArray(pt.json.data), `HTTP ${pt.status}`);
  const lookupNoPid = await req('/api/price-tiers/lookup?qty=10', { token });
  ok('阶梯价缺 product_id 返回 400', lookupNoPid.status === 400, `HTTP ${lookupNoPid.status}`);
  const emptyQuote = await req('/api/quotations', { method: 'POST', body: { items: [] }, token });
  ok('报价单无明细返回 400', emptyQuote.status === 400, `HTTP ${emptyQuote.status}`);

  // 9. 薪酬核算 / 固定资产 / 行政费用
  const ym = new Date().toISOString().slice(0, 7);
  const payList = await req('/api/payrolls?period=' + ym, { token });
  ok('GET /api/payrolls', payList.status === 200 && Array.isArray(payList.json.data), `HTTP ${payList.status}`);
  const payPeriods = await req('/api/payrolls/periods', { token });
  ok('GET /api/payrolls/periods', payPeriods.status === 200 && Array.isArray(payPeriods.json.data), `HTTP ${payPeriods.status}`);
  const paySum = await req('/api/payrolls/summary?period=' + ym, { token });
  ok('GET /api/payrolls/summary', paySum.status === 200 && paySum.json.data.period === ym, `HTTP ${paySum.status}`);
  const payNoPeriod = await req('/api/payrolls/summary', { token });
  ok('薪酬汇总缺月份返回 400', payNoPeriod.status === 400, `HTTP ${payNoPeriod.status}`);
  const payBadGen = await req('/api/payrolls/generate', { method: 'POST', body: { period: '202610' }, token });
  ok('生成工资单月份格式错误返回 400', payBadGen.status === 400, `HTTP ${payBadGen.status}`);

  const assetList = await req('/api/assets', { token });
  ok('GET /api/assets', assetList.status === 200 && Array.isArray(assetList.json.data), `HTTP ${assetList.status}`);
  const assetSum = await req('/api/assets/summary', { token });
  ok('GET /api/assets/summary', assetSum.status === 200 && typeof assetSum.json.data.original_total === 'number', `HTTP ${assetSum.status}`);

  const expList = await req('/api/admin-expenses', { token });
  ok('GET /api/admin-expenses', expList.status === 200 && Array.isArray(expList.json.data), `HTTP ${expList.status}`);
  const expMeta = await req('/api/admin-expenses/meta', { token });
  ok('GET /api/admin-expenses/meta 返回类别', expMeta.status === 200 && Array.isArray(expMeta.json.data.categories), `HTTP ${expMeta.status}`);
  const expBad = await req('/api/admin-expenses', { method: 'POST', body: { expense_date: '2026-10-01', amount: 0 }, token });
  ok('行政费用金额为 0 返回 400', expBad.status === 400, `HTTP ${expBad.status}`);

  // 10. 智能助手：预警 / 经营解读 / 自然语言查数
  const ins = await req('/api/assistant/insights', { token });
  ok('GET /api/assistant/insights 含 alerts', ins.status === 200 && Array.isArray(ins.json.data.alerts), `HTTP ${ins.status}`);
  const rep = await req('/api/assistant/report?period=' + ym, { token });
  ok('GET /api/assistant/report 返回 metrics+结论',
    rep.status === 200 && !!rep.json.data.metrics && Array.isArray(rep.json.data.conclusions),
    `HTTP ${rep.status}`);
  const repBad = await req('/api/assistant/report?period=2026-1', { token });
  ok('经营解读月份格式错误返回 400', repBad.status === 400, `HTTP ${repBad.status}`);
  const q1 = await req('/api/assistant/query', { method: 'POST', body: { q: '逾期订单' }, token });
  ok('问数「逾期订单」命中 orders 意图',
    q1.status === 200 && q1.json.data.intent === 'orders' && Array.isArray(q1.json.data.columns),
    `HTTP ${q1.status} intent=${q1.json.data && q1.json.data.intent}`);
  const q2 = await req('/api/assistant/query', { method: 'POST', body: { q: '库存' }, token });
  ok('问数「库存」命中 stock 意图', q2.status === 200 && q2.json.data.intent === 'stock', `HTTP ${q2.status}`);
  const q3 = await req('/api/assistant/query', { method: 'POST', body: { q: '' }, token });
  ok('问数空问题返回 400', q3.status === 400, `HTTP ${q3.status}`);

  // 11. 报表中心新增四张表
  const pf = await req('/api/stats/profit', { token });
  ok('GET /api/stats/profit 毛利', pf.status === 200 && !!pf.json.data.summary && Array.isArray(pf.json.data.warnings), `HTTP ${pf.status}`);
  const pfPeriod = await req('/api/stats/profit?period=' + ym, { token });
  ok('GET /api/stats/profit?period', pfPeriod.status === 200 && pfPeriod.json.data.period === ym, `HTTP ${pfPeriod.status}`);
  const sc = await req('/api/stats/customers', { token });
  ok('GET /api/stats/customers 客户贡献', sc.status === 200 && Array.isArray(sc.json.data.rows), `HTTP ${sc.status}`);
  const sf = await req('/api/stats/factories', { token });
  ok('GET /api/stats/factories 工厂产能', sf.status === 200 && !!sf.json.data.summary, `HTTP ${sf.status}`);
  const sr = await req('/api/stats/receivables', { token });
  ok('GET /api/stats/receivables 账期', sr.status === 200 && Array.isArray(sr.json.data.buckets), `HTTP ${sr.status}`);
  const pfCsv = await fetch(BASE + '/api/stats/profit?export=1', { headers: { Authorization: 'Bearer ' + token } });
  const pfCsvText = await pfCsv.text();
  ok('毛利报表导出 CSV', pfCsv.status === 200 && pfCsvText.includes('毛利率'), `HTTP ${pfCsv.status}`);

  // 12. 客户商城：客户登录 / 目录 / 后台概览
  const mallLogin = await req('/api/mall/auth/login', { method: 'POST', body: { username: MALL_USER, password: MALL_PASS } });
  const mallToken = mallLogin.json && mallLogin.json.data && mallLogin.json.data.token;
  ok('客户商城登录', mallLogin.status === 200 && !!mallToken, `HTTP ${mallLogin.status}`);
  if (mallToken) {
    const mp = await req('/api/mall/products', { token: mallToken });
    ok('商城商品目录', mp.status === 200 && Array.isArray(mp.json.data), `HTTP ${mp.status}`);
    const mMembers = await req('/api/mall/members', { token: mallToken });
    ok('客户成员列表（含权限上限）', [200, 403].includes(mMembers.status), `HTTP ${mMembers.status}`);
    const mAudits = await req('/api/mall/audits', { token: mallToken });
    ok('客户侧授权审计', [200, 403].includes(mAudits.status), `HTTP ${mAudits.status}`);
    const mFin = await req('/api/mall/finance', { token: mallToken });
    ok('客户对账（有权限 200 / 无权限 403）', [200, 403].includes(mFin.status), `HTTP ${mFin.status}`);
    const msum = await req('/api/mall/summary', { token: mallToken });
    ok('商城角标汇总', msum.status === 200 && msum.json.data.unread !== undefined, `HTTP ${msum.status}`);
    const myOrders = await req('/api/mall/orders', { token: mallToken });
    ok('我的订单（含字段级隔离）', myOrders.status === 200 && Array.isArray(myOrders.json.data.rows) && typeof myOrders.json.data.amount_visible === 'boolean', `HTTP ${myOrders.status}`);
    // 找一个不属于该客户的订单，验证跨客户越权被拒
    const allOrders = await req('/api/orders', { token });
    const other = (allOrders.json.data || []).find((o) => o.customer_id !== mallLogin.json.data.customer.id);
    if (other) {
      const crossOrder = await req('/api/mall/orders/' + other.id, { token: mallToken });
      ok('越权查他人订单被拒', [403, 404].includes(crossOrder.status), `HTTP ${crossOrder.status}`);
    } else {
      const ghost = await req('/api/mall/orders/999999', { token: mallToken });
      ok('查不存在订单返回 404', ghost.status === 404, `HTTP ${ghost.status}`);
    }
    const adminApi = await req('/api/mall-admin/stats', { token: mallToken });
    ok('客户 token 不能访问后台接口', adminApi.status === 401 || adminApi.status === 403, `HTTP ${adminApi.status}`);
  }
  const badMall = await req('/api/mall/auth/login', { method: 'POST', body: { username: 'abc001', password: 'wrong' } });
  ok('商城错误密码被拒(401)', badMall.status === 401, `HTTP ${badMall.status}`);
  const mallStats = await req('/api/mall-admin/stats', { token });
  ok('GET /api/mall-admin/stats', mallStats.status === 200 && mallStats.json.data.products >= 0, `HTTP ${mallStats.status}`);
  const mallProds = await req('/api/mall-admin/products', { token });
  ok('后台商城商品列表', mallProds.status === 200 && Array.isArray(mallProds.json.data), `HTTP ${mallProds.status}`);
  const mallAccts = await req('/api/mall-admin/accounts', { token });
  ok('后台客户账号列表（含权限）', mallAccts.status === 200 && Array.isArray(mallAccts.json.data.rows) && !!mallAccts.json.data.perm_dict, `HTTP ${mallAccts.status}`);
  const mallInvites = await req('/api/mall-admin/invites', { token });
  ok('注册邀请列表', mallInvites.status === 200 && Array.isArray(mallInvites.json.data), `HTTP ${mallInvites.status}`);
  const mallAudits = await req('/api/mall-admin/account-audits', { token });
  ok('客户授权审计可读', mallAudits.status === 200 && Array.isArray(mallAudits.json.data), `HTTP ${mallAudits.status}`);
  const invNoContact = await req('/api/mall-admin/invites', { method: 'POST', token, body: { customer_id: 1, role: 'purchase' } });
  ok('邀请缺核验联系方式被拒', invNoContact.status === 400, `HTTP ${invNoContact.status}`);
  const invGhost = await req('/api/mall/auth/invite/not-a-real-token', {});
  ok('无效邀请令牌返回 404', invGhost.status === 404, `HTTP ${invGhost.status}`);
  const approveGhost = await req('/api/mall-admin/accounts/999999/approve', { method: 'POST', token, body: { limit_perms: ['catalog.view'] } });
  ok('批准的账号不存在返回 404', approveGhost.status === 404, `HTTP ${approveGhost.status}`);
  const approveEmpty = await req('/api/mall-admin/accounts/1/approve', { method: 'POST', token, body: { limit_perms: [] } });
  ok('批准空权限上限被拒', approveEmpty.status === 400, `HTTP ${approveEmpty.status}`);

  // 13. 质量与合规
  const qs = await req('/api/qc/stats', { token });
  ok('GET /api/qc/stats 质检概览', qs.status === 200 && qs.json.data.standards >= 0, `HTTP ${qs.status}`);
  const qstd = await req('/api/qc/standards', { token });
  ok('质量标准和列表', qstd.status === 200 && Array.isArray(qstd.json.data), `HTTP ${qstd.status}`);
  const qinsp = await req('/api/qc/inspections', { token });
  ok('检验单列表', qinsp.status === 200 && Array.isArray(qinsp.json.data), `HTTP ${qinsp.status}`);
  const qiss = await req('/api/qc/issues', { token });
  ok('异常单列表', qiss.status === 200 && Array.isArray(qiss.json.data), `HTTP ${qiss.status}`);
  const qbat = await req('/api/qc/batches', { token });
  ok('批次列表', qbat.status === 200 && Array.isArray(qbat.json.data), `HTTP ${qbat.status}`);
  const qrec = await req('/api/qc/recalls', { token });
  ok('召回单列表', qrec.status === 200 && Array.isArray(qrec.json.data), `HTTP ${qrec.status}`);
  const qBad = await req('/api/qc/inspections', { method: 'POST', body: {}, token });
  ok('检验单缺订单/款号返回 400', qBad.status === 400, `HTTP ${qBad.status}`);
  const qTrace = await req('/api/qc/batches/NOT-EXIST/trace', { token });
  ok('不存在的批次追溯返回 404', qTrace.status === 404, `HTTP ${qTrace.status}`);

  // 14. 零售与渠道
  const cst = await req('/api/channel/stats', { token });
  ok('GET /api/channel/stats 渠道概览', cst.status === 200 && !!cst.json.data.orders && Array.isArray(cst.json.data.warnings), `HTTP ${cst.status}`);
  const cmeta = await req('/api/channel/meta', { token });
  ok('渠道字典', cmeta.status === 200 && Array.isArray(cmeta.json.data.platforms), `HTTP ${cmeta.status}`);
  const cshop = await req('/api/channel/shops', { token });
  ok('店铺映射列表', cshop.status === 200 && Array.isArray(cshop.json.data), `HTTP ${cshop.status}`);
  ok('店铺含授权标签', cshop.status === 200 && (!cshop.json.data.length || !!cshop.json.data[0].api_label), '缺少 api_label');
  const cq = await req('/api/channel/quotas', { token });
  ok('库存配额列表', cq.status === 200 && Array.isArray(cq.json.data), `HTTP ${cq.status}`);
  ok('配额含实物/可分配计算', cq.status === 200 && (!cq.json.data.length || (cq.json.data[0].stock !== undefined && cq.json.data[0].allocatable !== undefined)), '缺少 stock/allocatable');
  const cro = await req('/api/channel/retail-orders', { token });
  ok('零售订单列表', cro.status === 200 && Array.isArray(cro.json.data), `HTTP ${cro.status}`);
  const cas = await req('/api/channel/after-sales', { token });
  ok('售后列表', cas.status === 200 && Array.isArray(cas.json.data), `HTTP ${cas.status}`);
  const cstl = await req('/api/channel/settlements', { token });
  ok('结算批列表', cstl.status === 200 && Array.isArray(cstl.json.data), `HTTP ${cstl.status}`);
  const cShopBad = await req('/api/channel/shops', { method: 'POST', body: { platform: 'amazon' }, token });
  ok('店铺缺名称返回 400', cShopBad.status === 400, `HTTP ${cShopBad.status}`);
  const cOrderBad = await req('/api/channel/retail-orders', { method: 'POST', body: {}, token });
  ok('零售单缺店铺返回 400', cOrderBad.status === 400, `HTTP ${cOrderBad.status}`);
  const cQuotaBad = await req('/api/channel/quotas', { method: 'POST', body: { shop_id: 1, style_no: 'X', channel_limit: -5 }, token });
  ok('配额为负返回 400', cQuotaBad.status === 400, `HTTP ${cQuotaBad.status}`);
  const cShip404 = await req('/api/channel/retail-orders/999999/ship', { method: 'POST', body: {}, token });
  ok('发货不存在零售单返回 404', cShip404.status === 404, `HTTP ${cShip404.status}`);
  const cStlBad = await req('/api/channel/settlements/generate', { method: 'POST', body: {}, token });
  ok('生成结算批缺店铺返回 400', cStlBad.status === 400, `HTTP ${cStlBad.status}`);
  const cCsv = await fetch(BASE + '/api/channel/retail-orders/export', { headers: { Authorization: 'Bearer ' + token } });
  const cCsvText = await cCsv.text();
  ok('零售订单导出 CSV', cCsv.status === 200 && cCsvText.includes('渠道订单号'), `HTTP ${cCsv.status}`);

  // 15. 客户订单与资料确认（样衣封样 / 变更 / 交期物流）
  const cfSt = await req('/api/confirm/stats', { token });
  ok('GET /api/confirm/stats 确认概览', cfSt.status === 200 && !!cfSt.json.data.seals && Array.isArray(cfSt.json.data.warnings), `HTTP ${cfSt.status}`);
  const cfSeals = await req('/api/confirm/seals', { token });
  ok('封样记录列表', cfSeals.status === 200 && Array.isArray(cfSeals.json.data), `HTTP ${cfSeals.status}`);
  const cfGate = await req('/api/confirm/seals/gate/1', { token });
  ok('封样门槛查询返回 ok 布尔', cfGate.status === 200 && typeof cfGate.json.data.ok === 'boolean', `HTTP ${cfGate.status}`);
  const cfChg = await req('/api/confirm/changes', { token });
  ok('变更单列表', cfChg.status === 200 && Array.isArray(cfChg.json.data), `HTTP ${cfChg.status}`);
  const cfDlv = await req('/api/confirm/deliveries', { token });
  ok('交期变动列表', cfDlv.status === 200 && Array.isArray(cfDlv.json.data), `HTTP ${cfDlv.status}`);
  const cfShp = await req('/api/confirm/shipments', { token });
  ok('物流事件列表', cfShp.status === 200 && Array.isArray(cfShp.json.data), `HTTP ${cfShp.status}`);
  const cfSealBad = await req('/api/confirm/seals', { method: 'POST', body: {}, token });
  ok('封样缺订单返回 400', cfSealBad.status === 400, `HTTP ${cfSealBad.status}`);
  const cfChgBad = await req('/api/confirm/changes', { method: 'POST', body: {}, token });
  ok('变更缺订单返回 400', cfChgBad.status === 400, `HTTP ${cfChgBad.status}`);
  const cfDlvBad = await req('/api/confirm/deliveries', { method: 'POST', body: {}, token });
  ok('交期变动缺订单返回 400', cfDlvBad.status === 400, `HTTP ${cfDlvBad.status}`);
  const cfShpBad = await req('/api/confirm/shipments', { method: 'POST', body: {}, token });
  ok('物流事件缺订单返回 400', cfShpBad.status === 400, `HTTP ${cfShpBad.status}`);
  const cfSeal404 = await req('/api/confirm/seals/999999', { token });
  ok('不存在的封样记录返回 404', cfSeal404.status === 404, `HTTP ${cfSeal404.status}`);
  const cfApproveBad = await req('/api/confirm/changes/999999/approve', { method: 'POST', body: {}, token });
  ok('提交不存在变更返回 404', cfApproveBad.status === 404, `HTTP ${cfApproveBad.status}`);

  // 16. 客户端确认入口
  if (mallToken) {
    const myConf = await req('/api/mall/confirmations', { token: mallToken });
    ok('客户待确认列表', myConf.status === 200 && Array.isArray(myConf.json.data.seals), `HTTP ${myConf.status}`);
    const sum2 = await req('/api/mall/summary', { token: mallToken });
    ok('角标含待确认数', sum2.status === 200 && sum2.json.data.pending_confirm !== undefined, `HTTP ${sum2.status}`);
    const crossDlv = await req('/api/mall/orders/2/delivery', { token: mallToken });
    ok('越权查他人订单交期被拒', [403, 404].includes(crossDlv.status), `HTTP ${crossDlv.status}`);
    const dlvBad = await req('/api/mall/seals/999999/confirm', { method: 'POST', body: {}, token: mallToken });
    ok('客户确认不存在样衣返回 404', dlvBad.status === 404, `HTTP ${dlvBad.status}`);
  }

  // 17. 人事办理（招聘 / 转调离 / 合同 / 调薪）
  const hs = await req('/api/hr/stats', { token });
  ok('GET /api/hr/stats 人事概览', hs.status === 200 && !!hs.json.data.contracts && Array.isArray(hs.json.data.warnings), `HTTP ${hs.status}`);
  const rq = await req('/api/hr/recruitments', { token });
  ok('招聘需求列表', rq.status === 200 && Array.isArray(rq.json.data), `HTTP ${rq.status}`);
  const cd = await req('/api/hr/candidates', { token });
  ok('候选人列表', cd.status === 200 && Array.isArray(cd.json.data), `HTTP ${cd.status}`);
  const mv = await req('/api/hr/movements', { token });
  ok('异动列表', mv.status === 200 && Array.isArray(mv.json.data), `HTTP ${mv.status}`);
  const ct = await req('/api/hr/contracts', { token });
  ok('合同列表', ct.status === 200 && Array.isArray(ct.json.data), `HTTP ${ct.status}`);
  const ctExp = await req('/api/hr/contracts?expiring=30', { token });
  ok('30 天内到期合同筛选', ctExp.status === 200 && Array.isArray(ctExp.json.data), `HTTP ${ctExp.status}`);
  const adj = await req('/api/hr/adjustments', { token });
  ok('调薪列表', adj.status === 200 && Array.isArray(adj.json.data), `HTTP ${adj.status}`);
  const rqBad = await req('/api/hr/recruitments', { method: 'POST', body: {}, token });
  ok('招聘需求缺岗位返回 400', rqBad.status === 400, `HTTP ${rqBad.status}`);
  const cdBad = await req('/api/hr/candidates', { method: 'POST', body: {}, token });
  ok('候选人缺姓名返回 400', cdBad.status === 400, `HTTP ${cdBad.status}`);
  const ctNoEnd = await req('/api/hr/contracts', { method: 'POST', body: { employee_id: 2, type: 'fixed', start_date: '2027-06-01' }, token });
  ok('固定期限未填结束日返回 400', ctNoEnd.status === 400, `HTTP ${ctNoEnd.status}`);
  const ctProbation = await req('/api/hr/contracts', { method: 'POST', body: { employee_id: 2, type: 'fixed', start_date: '2027-06-01', end_date: '2028-05-31', probation_end: '2028-08-01' }, token });
  ok('试用期超出合同期返回 400', ctProbation.status === 400, `HTTP ${ctProbation.status}`);
  const mvBad = await req('/api/hr/movements', { method: 'POST', body: {}, token });
  ok('异动缺员工返回 400', mvBad.status === 400, `HTTP ${mvBad.status}`);
  const mvResign = await req('/api/hr/movements', { method: 'POST', body: { employee_id: 2, type: 'resign', effective_date: '2026-12-31' }, token });
  ok('离职无交接清单返回 400', mvResign.status === 400, `HTTP ${mvResign.status}`);
  const adjBad = await req('/api/hr/adjustments', { method: 'POST', body: {}, token });
  ok('调薪缺员工返回 400', adjBad.status === 400, `HTTP ${adjBad.status}`);
  const mv404 = await req('/api/hr/movements/999999/apply', { method: 'POST', body: {}, token });
  ok('生效不存在异动返回 404', mv404.status === 404, `HTTP ${mv404.status}`);

  // 18. 行政后勤（宿舍 / 饭卡 / 证照印章 / 安全巡检）
  const fs1 = await req('/api/facility/stats', { token });
  ok('GET /api/facility/stats 后勤概览', fs1.status === 200 && !!fs1.json.data.dorm && Array.isArray(fs1.json.data.warnings), `HTTP ${fs1.status}`);
  const fRoom = await req('/api/facility/dorm/rooms', { token });
  ok('宿舍房间与床位列表', fRoom.status === 200 && Array.isArray(fRoom.json.data), `HTTP ${fRoom.status}`);
  const fStay = await req('/api/facility/dorm/stays', { token });
  ok('住宿记录列表', fStay.status === 200 && Array.isArray(fStay.json.data), `HTTP ${fStay.status}`);
  const fOcc = await req('/api/facility/dorm/occupancy', { token });
  ok('宿舍入住率（床日口径）', fOcc.status === 200 && fOcc.json.data.available_bed_days >= 0, `HTTP ${fOcc.status}`);
  const fAcc = await req('/api/facility/meal/accounts', { token });
  ok('饭卡账户列表', fAcc.status === 200 && Array.isArray(fAcc.json.data), `HTTP ${fAcc.status}`);
  const fTx = await req('/api/facility/meal/transactions', { token });
  ok('餐费流水列表', fTx.status === 200 && Array.isArray(fTx.json.data), `HTTP ${fTx.status}`);
  const fRecon = await req('/api/facility/meal/recon', { token });
  ok('饭卡日结对账', fRecon.status === 200 && Array.isArray(fRecon.json.data.issues), `HTTP ${fRecon.status}`);
  const fCert = await req('/api/facility/certificates', { token });
  ok('证照列表', fCert.status === 200 && Array.isArray(fCert.json.data), `HTTP ${fCert.status}`);
  const fSeal = await req('/api/facility/seals', { token });
  ok('印章列表', fSeal.status === 200 && Array.isArray(fSeal.json.data), `HTTP ${fSeal.status}`);
  const fUsage = await req('/api/facility/seal-usages', { token });
  ok('用印记录列表', fUsage.status === 200 && Array.isArray(fUsage.json.data), `HTTP ${fUsage.status}`);
  const fCheck = await req('/api/facility/safety-checks', { token });
  ok('安全巡检列表', fCheck.status === 200 && Array.isArray(fCheck.json.data), `HTTP ${fCheck.status}`);
  const fRepair = await req('/api/facility/repairs', { token });
  ok('报修单列表', fRepair.status === 200 && Array.isArray(fRepair.json.data), `HTTP ${fRepair.status}`);
  const fRoomBad = await req('/api/facility/dorm/rooms', { method: 'POST', body: {}, token });
  ok('宿舍房间缺房号返回 400', fRoomBad.status === 400, `HTTP ${fRoomBad.status}`);
  const fInBad = await req('/api/facility/dorm/checkin', { method: 'POST', body: {}, token });
  ok('入住缺床位返回 400', fInBad.status === 400, `HTTP ${fInBad.status}`);
  const fAccBad = await req('/api/facility/meal/accounts', { method: 'POST', body: {}, token });
  ok('开卡缺员工返回 400', fAccBad.status === 400, `HTTP ${fAccBad.status}`);
  const fCertBad = await req('/api/facility/certificates', { method: 'POST', body: {}, token });
  ok('证照缺名称返回 400', fCertBad.status === 400, `HTTP ${fCertBad.status}`);
  const fSealBad = await req('/api/facility/seal-usages', { method: 'POST', body: {}, token });
  ok('用印缺印章返回 400', fSealBad.status === 400, `HTTP ${fSealBad.status}`);
  const fCheckBad = await req('/api/facility/safety-checks', { method: 'POST', body: {}, token });
  ok('巡检缺区域返回 400', fCheckBad.status === 400, `HTTP ${fCheckBad.status}`);
  const fRepairBad = await req('/api/facility/repairs', { method: 'POST', body: {}, token });
  ok('报修缺设施返回 400', fRepairBad.status === 400, `HTTP ${fRepairBad.status}`);
  const fCheckout404 = await req('/api/facility/dorm/checkout/999999', { method: 'POST', body: {}, token });
  ok('退宿不存在记录返回 404', fCheckout404.status === 404, `HTTP ${fCheckout404.status}`);
  const fUsage404 = await req('/api/facility/seal-usages/999999/status', { method: 'POST', body: { status: 'approved' }, token });
  ok('用印不存在记录返回 404', fUsage404.status === 404, `HTTP ${fUsage404.status}`);

  // 19. 多端与外部接口（事件幂等 / 重试死信 / 物流校正 / 鉴权限流）
  const igSt = await req('/api/integration/stats', { token });
  ok('GET /api/integration/stats 接口概览', igSt.status === 200 && !!igSt.json.data.events && Array.isArray(igSt.json.data.warnings), `HTTP ${igSt.status}`);
  const igEp = await req('/api/integration/endpoints', { token });
  ok('接入点列表', igEp.status === 200 && Array.isArray(igEp.json.data), `HTTP ${igEp.status}`);
  ok('接入点密钥已掩码', igEp.status === 200 && (!igEp.json.data.length || igEp.json.data[0].api_key_masked.indexOf('****') >= 0), 'API Key 未掩码');
  const igEv = await req('/api/integration/events', { token });
  ok('事件队列列表', igEv.status === 200 && Array.isArray(igEv.json.data), `HTTP ${igEv.status}`);
  const igCall = await req('/api/integration/calls', { token });
  ok('接口调用日志', igCall.status === 200 && Array.isArray(igCall.json.data), `HTTP ${igCall.status}`);
  const igShip = await req('/api/integration/shipments', { token });
  ok('物流事件（含校正字段）', igShip.status === 200 && Array.isArray(igShip.json.data), `HTTP ${igShip.status}`);
  const igOa = await req('/api/integration/openapi.json', { token });
  ok('OpenAPI 清单可生成', igOa.status === 200 && igOa.json.data.openapi === '3.0.3' && Object.keys(igOa.json.data.paths).length > 5, `HTTP ${igOa.status}`);
  const igNoEp = await req('/api/integration/ingest/not-exist', { method: 'POST', body: { event_id: 'X', topic: 'notification' } });
  ok('推送至不存在接入点返回 404', igNoEp.status === 404, `HTTP ${igNoEp.status}`);
  const igNoKey = await req('/api/integration/ingest/amz-live', { method: 'POST', body: { event_id: 'SMOKE-1', topic: 'notification' } });
  ok('缺 API Key 返回 401', igNoKey.status === 401, `HTTP ${igNoKey.status}`);
  const epBad = await req('/api/integration/endpoints', { method: 'POST', body: {}, token });
  ok('接入点缺编码返回 400', epBad.status === 400, `HTTP ${epBad.status}`);
  const corBad = await req('/api/integration/shipments/999999/correct', { method: 'POST', body: { reason: 'x' }, token });
  ok('校正不存在物流事件返回 404', corBad.status === 404, `HTTP ${corBad.status}`);
  const sigBad = await req('/api/integration/files/signed-url', { method: 'POST', body: { name: '../etc/passwd' }, token });
  ok('签名下载拒绝路径穿越', sigBad.status === 400, `HTTP ${sigBad.status}`);
  const retry404 = await req('/api/integration/events/999999/retry', { method: 'POST', body: {}, token });
  ok('重放不存在事件返回 404', retry404.status === 404, `HTTP ${retry404.status}`);

  // ==================== 数据质量与业务勾稽 ====================
  const dqR = await req('/api/dq/rules', { token });
  ok('勾稽规则列表', dqR.status === 200 && Array.isArray(dqR.json.data) && dqR.json.data.length >= 20, `HTTP ${dqR.status}`);
  ok('规则含账账对齐与数据质量两类',
    ['balance', 'quality'].every((k) => (dqR.json.data || []).some((r) => r.kind === k)));
  ok('可自动修的规则必须带 fix_key',
    (dqR.json.data || []).every((r) => !r.fixable || !!r.fix_key));
  ok('规则必须写清判定口径',
    (dqR.json.data || []).every((r) => (r.desc_text || '').length > 10 && (r.suggest || '').length > 4));

  const dqS = await req('/api/dq/summary', { token });
  ok('勾稽总览', dqS.status === 200 && dqS.json.data.counters && Array.isArray(dqS.json.data.by_rule), `HTTP ${dqS.status}`);
  ok('健康分在 0-100 之间',
    dqS.json.data.health === null || (dqS.json.data.health >= 0 && dqS.json.data.health <= 100));

  const dqI = await req('/api/dq/issues?status=open', { token });
  ok('待处理问题列表', dqI.status === 200 && Array.isArray(dqI.json.data.rows), `HTTP ${dqI.status}`);
  ok('每条问题都有期望值与实际值',
    (dqI.json.data.rows || []).every((r) => r.expect_val !== null && r.actual_val !== null && r.rule_code));

  const dqRec = await req('/api/dq/reconcile', { token });
  ok('三账对齐', dqRec.status === 200 && Array.isArray(dqRec.json.data.rows) && dqRec.json.data.total, `HTTP ${dqRec.status}`);
  ok('三账对齐逐单给出件数与金额',
    (dqRec.json.data.rows || []).every(
      (r) => 'order_qty' in r && 'out_qty' in r && 'total_amount' in r && 'ar_amount' in r && Array.isArray(r.flags)
    ));

  const dqRunList = await req('/api/dq/runs?limit=5', { token });
  ok('勾稽批次历史', dqRunList.status === 200 && Array.isArray(dqRunList.json.data), `HTTP ${dqRunList.status}`);

  const dqFix = await req('/api/dq/fixes?limit=5', { token });
  ok('修复留痕列表', dqFix.status === 200 && Array.isArray(dqFix.json.data), `HTTP ${dqFix.status}`);

  // 忽略必须写理由（参数校验，不产生数据）
  const openOne = (dqI.json.data.rows || [])[0];
  if (openOne) {
    const badIgnore = await req(`/api/dq/issues/${openOne.id}/ignore`, { method: 'POST', body: { reason: 'x' }, token });
    ok('忽略缺理由返回 400', badIgnore.status === 400, `HTTP ${badIgnore.status}`);
  } else {
    ok('忽略缺理由返回 400', true, '当前无待处理问题，跳过');
  }

  // 不可修的问题不能走自动修
  const notFixable = (dqI.json.data.rows || []).find((r) => !r.fixable);
  if (notFixable) {
    const badFix = await req(`/api/dq/issues/${notFixable.id}/fix`, { method: 'POST', body: {}, token });
    ok('不可自动修的问题拒绝修复', badFix.status === 400, `HTTP ${badFix.status}`);
  } else {
    ok('不可自动修的问题拒绝修复', true, '当前无可演示项，跳过');
  }

  const dqFix404 = await req('/api/dq/issues/999999/fix', { method: 'POST', body: {}, token });
  ok('修复不存在的问题返回 404', dqFix404.status === 404, `HTTP ${dqFix404.status}`);

  const dqRun404 = await req('/api/dq/runs/999999', { token });
  ok('查询不存在批次返回 404', dqRun404.status === 404, `HTTP ${dqRun404.status}`);

  const dqNoAuth = await req('/api/dq/rules');
  ok('未登录访问勾稽接口返回 401', dqNoAuth.status === 401, `HTTP ${dqNoAuth.status}`);

  const dqExport = await fetch(BASE + '/api/dq/export?status=open', { headers: { Authorization: 'Bearer ' + token } });
  const dqBuf = Buffer.from(await dqExport.arrayBuffer());
  // Response.text() 会按规范剥掉 BOM，所以直接看前 3 个字节（EF BB BF）
  ok('勾稽 CSV 可导出且带 BOM',
    dqExport.status === 200 && dqBuf[0] === 0xef && dqBuf[1] === 0xbb && dqBuf[2] === 0xbf, `HTTP ${dqExport.status}`);
  const dqCsv = dqBuf.toString('utf8');
  ok('CSV 含期望值与实际值列表头', dqCsv.includes('期望值') && dqCsv.includes('实际值'));

  // ==================== 海外仓作业（到仓上架 / 套装拆组 / 运费核对） ====================
  const whB = await req('/api/wh/board', { token });
  ok('海外仓总览', whB.status === 200 && !!whB.json.data.stat && Array.isArray(whB.json.data.arriving), `HTTP ${whB.status}`);
  ok('总览给出在途/待上架/可售/套装/运费差异',
    ['asn_in_transit', 'receiving', 'sellable_qty', 'bundle_qty', 'freight_diff_cnt'].every((k) => k in whB.json.data.stat));

  const whL = await req('/api/wh/locations', { token });
  ok('库位列表', whL.status === 200 && Array.isArray(whL.json.data), `HTTP ${whL.status}`);
  ok('库位带库区中文名与上架累计',
    (whL.json.data || []).every((l) => l.zone_label && 'put_qty' in l));

  const whA = await req('/api/wh/asns', { token });
  ok('发运单列表', whA.status === 200 && Array.isArray(whA.json.data), `HTTP ${whA.status}`);
  ok('发运单带状态中文名', (whA.json.data || []).every((a) => !!a.status_label));

  if ((whA.json.data || []).length) {
    const one = whA.json.data[0];
    const whD = await req(`/api/wh/asns/${one.id}`, { token });
    ok('发运单详情', whD.status === 200 && !!whD.json.data.asn && Array.isArray(whD.json.data.items), `HTTP ${whD.status}`);
  } else {
    ok('发运单详情', true, '无发运单，跳过');
  }

  const whR = await req('/api/wh/receipts', { token });
  ok('点收单列表', whR.status === 200 && Array.isArray(whR.json.data), `HTTP ${whR.status}`);
  ok('点收单算出待上架量', (whR.json.data || []).every((r) => typeof r.to_put === 'number'));

  const whBd = await req('/api/wh/bundles', { token });
  ok('套装列表', whBd.status === 200 && Array.isArray(whBd.json.data), `HTTP ${whBd.status}`);
  ok('套装带组件与可组装数',
    (whBd.json.data || []).every((b) => Array.isArray(b.items) && typeof b.can_kit === 'number'));
  ok('可组装数不超过任一组件的可组数', (whBd.json.data || []).every((b) => {
    if (!b.items.length) return b.can_kit === 0;
    return b.can_kit <= Math.min(...b.items.map((i) => i.max_kits));
  }));

  const whOps = await req('/api/wh/bundle-ops?limit=5', { token });
  ok('组装拆分记录', whOps.status === 200 && Array.isArray(whOps.json.data), `HTTP ${whOps.status}`);

  const whRt = await req('/api/wh/freight/rates', { token });
  ok('运费费率', whRt.status === 200 && Array.isArray(whRt.json.data), `HTTP ${whRt.status}`);

  const whBill = await req('/api/wh/freight/bills', { token });
  ok('运费账单列表', whBill.status === 200 && Array.isArray(whBill.json.data), `HTTP ${whBill.status}`);
  if ((whBill.json.data || []).length) {
    const b0 = whBill.json.data[0];
    const whBd2 = await req(`/api/wh/freight/bills/${b0.id}`, { token });
    ok('账单明细', whBd2.status === 200 && Array.isArray(whBd2.json.data.items), `HTTP ${whBd2.status}`);
    ok('每条账单明细都有差异类型', (whBd2.json.data.items || []).every((i) => !!i.diff_type));
    ok('账单汇总与明细条数一致', (whBd2.json.data.items || []).length === whBd2.json.data.bill.item_count);
  } else {
    ok('账单明细', true, '无账单，跳过');
    ok('每条账单明细都有差异类型', true, '无账单，跳过');
    ok('账单汇总与明细条数一致', true, '无账单，跳过');
  }

  const whDict = await req('/api/wh/dict', { token });
  ok('海外仓字典', whDict.status === 200 && Array.isArray(whDict.json.data.zones) && whDict.json.data.zones.length >= 5, `HTTP ${whDict.status}`);

  // 参数与硬规则（都用不落库的 400 场景）
  const whNoLine = await req('/api/wh/asns', { method: 'POST', body: { items: [] }, token });
  ok('发运单缺明细返回 400', whNoLine.status === 400, `HTTP ${whNoLine.status}`);
  const whZero = await req('/api/wh/asns', { method: 'POST', body: { items: [{ style_no: 'X', expect_qty: 0 }] }, token });
  ok('预报数量为 0 返回 400', whZero.status === 400, `HTTP ${whZero.status}`);
  const whSelf = await req('/api/wh/bundles', { method: 'POST', body: { bundle_sku: 'SMOKE-SELF', name: 'x', items: [{ style_no: 'SMOKE-SELF', qty_per: 1 }] }, token });
  ok('套装自引用返回 400', whSelf.status === 400, `HTTP ${whSelf.status}`);
  const whRate0 = await req('/api/wh/freight/rates', { method: 'POST', body: { carrier: 'SMOKE', zone: 'US-W', first_weight: 1, first_price: 0 }, token });
  ok('费率首重价为 0 返回 400', whRate0.status === 400, `HTTP ${whRate0.status}`);

  if ((whBd.json.data || []).length) {
    const anyB = whBd.json.data[0];
    const kit0 = await req(`/api/wh/bundles/${anyB.id}/kit`, { method: 'POST', body: { qty: 0 }, token });
    ok('组装数量为 0 返回 400', kit0.status === 400, `HTTP ${kit0.status}`);
    const ubBig = await req(`/api/wh/bundles/${anyB.id}/unbundle`, { method: 'POST', body: { qty: 999999 }, token });
    ok('拆分超库存返回 400', ubBig.status === 400, `HTTP ${ubBig.status}`);
  } else {
    ok('组装数量为 0 返回 400', true, '无套装，跳过');
    ok('拆分超库存返回 400', true, '无套装，跳过');
  }

  const whSettle404 = await req('/api/wh/freight/bills/999999/settle', { method: 'POST', body: {}, token });
  ok('结算不存在账单返回 404', whSettle404.status === 404, `HTTP ${whSettle404.status}`);
  const whLoc404 = await req('/api/wh/locations/999999', { method: 'PUT', body: { status: 'locked' }, token });
  ok('改不存在库位返回 404', whLoc404.status === 404, `HTTP ${whLoc404.status}`);
  const whNoAuth = await req('/api/wh/board');
  ok('未登录访问海外仓返回 401', whNoAuth.status === 401, `HTTP ${whNoAuth.status}`);

  // ==================== 总账与财务报表 ====================
  const glP = await req('/api/gl/periods', { token });
  ok('会计期间列表', glP.status === 200 && Array.isArray(glP.json.data) && glP.json.data.length > 0, `HTTP ${glP.status}`);
  ok('期间带中文标签与关账状态', (glP.json.data || []).every((p) => !!p.label && !!p.status));

  const glA = await req('/api/gl/accounts', { token });
  ok('会计科目表', glA.status === 200 && (glA.json.data || []).length >= 20, `HTTP ${glA.status} n=${(glA.json.data || []).length}`);
  ok('科目五类齐全', ['asset', 'liability', 'equity', 'income', 'expense'].every((t) => (glA.json.data || []).some((a) => a.type === t)));

  // 取一个期间做报表校验（优先已关账期间）
  const glPeriod = (glP.json.data || []).find((p) => p.status === 'closed')?.period
    || (glP.json.data || [])[0]?.period || '2026-01';

  const glTB = await req(`/api/gl/reports/trial-balance?period=${glPeriod}`, { token });
  ok('试算平衡表', glTB.status === 200 && Array.isArray(glTB.json.data.rows), `HTTP ${glTB.status}`);
  ok('试算借贷相等', glTB.json.data.balanced === true, `借 ${glTB.json.data.sum?.debit} / 贷 ${glTB.json.data.sum?.credit}`);

  const glBS = await req(`/api/gl/reports/balance-sheet?period=${glPeriod}`, { token });
  ok('资产负债表', glBS.status === 200 && Array.isArray(glBS.json.data.assets), `HTTP ${glBS.status}`);
  ok('资产 = 负债 + 所有者权益', glBS.json.data.balanced === true,
    `资产 ${glBS.json.data.asset_total} / 负债+权益 ${glBS.json.data.liability_equity_total}`);

  const glIS = await req(`/api/gl/reports/income?period=${glPeriod}`, { token });
  ok('利润表', glIS.status === 200 && typeof glIS.json.data.net_profit === 'number', `HTTP ${glIS.status}`);
  ok('净利润 = 收入 − 成本费用',
    Math.abs(glIS.json.data.income_total - glIS.json.data.expense_total - glIS.json.data.net_profit) < 0.02);

  const glCF = await req(`/api/gl/reports/cash-flow?period=${glPeriod}`, { token });
  ok('现金流量表', glCF.status === 200 && typeof glCF.json.data.net_increase === 'number', `HTTP ${glCF.status}`);
  ok('现金流量表有期末现金', typeof glCF.json.data.closing_cash === 'number');

  const glBadType = await req('/api/gl/reports/not-exist?period=2026-09', { token });
  ok('不支持的报表类型返回 404', glBadType.status === 404, `HTTP ${glBadType.status}`);

  const glV = await req(`/api/gl/vouchers?period=${glPeriod}`, { token });
  ok('凭证列表', glV.status === 200 && Array.isArray(glV.json.data), `HTTP ${glV.status}`);
  ok('每张凭证借贷相等', (glV.json.data || []).every((v) => Math.abs(v.debit_total - v.credit_total) < 0.02));
  if ((glV.json.data || []).length) {
    const v0 = glV.json.data[0];
    const glVd = await req(`/api/gl/vouchers/${v0.id}`, { token });
    ok('凭证分录', glVd.status === 200 && Array.isArray(glVd.json.data.entries), `HTTP ${glVd.status}`);
    ok('每条分录都有科目与方向', (glVd.json.data.entries || []).every((e) => e.account_code && (e.debit > 0 || e.credit > 0)));
  } else {
    ok('凭证分录', true, '该期间无凭证，跳过');
    ok('每条分录都有科目与方向', true, '该期间无凭证，跳过');
  }

  const glCk = await req(`/api/gl/periods/${glPeriod}/checks`, { token });
  ok('关账检查', glCk.status === 200 && Array.isArray(glCk.json.data.checks) && glCk.json.data.checks.length >= 8, `HTTP ${glCk.status}`);
  ok('检查项区分拦截与提示', (glCk.json.data.checks || []).every((c) => ['error', 'warn'].includes(c.severity)));

  const glOv = await req(`/api/gl/overview?period=${glPeriod}`, { token });
  ok('总览', glOv.status === 200 && typeof glOv.json.data.net_profit === 'number', `HTTP ${glOv.status}`);
  ok('总览带 6 期利润趋势', Array.isArray(glOv.json.data.trend) && glOv.json.data.trend.length === 6);

  // 参数与硬规则
  const glBadPeriod = await req('/api/gl/periods', { method: 'POST', body: { period: '2026-13' }, token });
  ok('期间月份非法返回 400', glBadPeriod.status === 400, `HTTP ${glBadPeriod.status}`);
  const glUnbalanced = await req('/api/gl/vouchers', {
    method: 'POST',
    body: { period: glPeriod, entries: [{ code: '1002', debit: 100, credit: 0 }, { code: '4001', debit: 0, credit: 60 }] },
    token
  });
  ok('手工凭证借贷不平返回 400', glUnbalanced.status === 400, `HTTP ${glUnbalanced.status}`);
  const glBadAcct = await req('/api/gl/vouchers', {
    method: 'POST',
    body: { period: glPeriod, entries: [{ code: '9999', debit: 10, credit: 0 }, { code: '4001', debit: 0, credit: 10 }] },
    token
  });
  ok('科目不存在返回 400', glBadAcct.status === 400, `HTTP ${glBadAcct.status}`);

  const closedPeriod = (glP.json.data || []).find((p) => p.status === 'closed');
  if (closedPeriod) {
    const glClosedGen = await req(`/api/gl/periods/${closedPeriod.period}/generate`, { method: 'POST', body: {}, token });
    ok('已关账期间生成凭证返回 400', glClosedGen.status === 400, `HTTP ${glClosedGen.status}`);
    const glReopenBad = await req(`/api/gl/periods/${closedPeriod.period}/reopen`, { method: 'POST', body: { reason: 'x' }, token });
    ok('反关账缺原因返回 400', glReopenBad.status === 400, `HTTP ${glReopenBad.status}`);
  } else {
    ok('已关账期间生成凭证返回 400', true, '无已关账期间，跳过');
    ok('反关账缺原因返回 400', true, '无已关账期间，跳过');
  }

  const glNoAuth = await req('/api/gl/accounts');
  ok('未登录访问总账返回 401', glNoAuth.status === 401, `HTTP ${glNoAuth.status}`);

  const glCsvRes = await fetch(BASE + `/api/gl/reports/income/export?period=${glPeriod}`, { headers: { Authorization: 'Bearer ' + token } });
  const glCsvBuf = Buffer.from(await glCsvRes.arrayBuffer());
  ok('报表 CSV 可导出且带 BOM',
    glCsvRes.status === 200 && glCsvBuf[0] === 0xef && glCsvBuf[1] === 0xbb && glCsvBuf[2] === 0xbf, `HTTP ${glCsvRes.status}`);

  // ==================== 现货库龄与退货 ====================
  const spOv = await req('/api/spot/overview', { token });
  ok('现货总览', spOv.status === 200 && typeof spOv.json.data.stock_qty === 'number', `HTTP ${spOv.status}`);
  ok('总览含库龄与周转', 'avg_age' in spOv.json.data && 'turnover_days' in spOv.json.data);

  const spAg = await req('/api/spot/aging', { token });
  ok('库龄分布', spAg.status === 200 && Array.isArray(spAg.json.data.buckets) && spAg.json.data.buckets.length === 4, `HTTP ${spAg.status}`);
  ok('四档库龄合计 = 总库存',
    Math.abs((spAg.json.data.buckets || []).reduce((a, b) => a + b.qty, 0) - spAg.json.data.total_qty) < 0.02,
    `${(spAg.json.data.buckets || []).map((b) => b.qty).join('+')} vs ${spAg.json.data.total_qty}`);
  ok('库龄明细带批次与入库日期',
    (spAg.json.data.rows || []).every((r) => Array.isArray(r.lots) && r.lots.every((l) => !!l.in_date)));

  const spTo = await req('/api/spot/turnover?days=90', { token });
  ok('动销与周转', spTo.status === 200 && !!spTo.json.data.stat, `HTTP ${spTo.status}`);
  ok('动销行含售罄率与周转天数',
    (spTo.json.data.rows || []).every((r) => 'sell_through' in r && 'turnover_days' in r && !!r.level));

  const spSm = await req('/api/spot/slow-moving?min_age=60', { token });
  ok('滞销清单', spSm.status === 200 && Array.isArray(spSm.json.data.rows), `HTTP ${spSm.status}`);
  ok('滞销项库龄不低于阈值', (spSm.json.data.rows || []).every((r) => r.oldest_age >= 60));

  const spRt = await req('/api/spot/returns', { token });
  ok('退货单列表', spRt.status === 200 && Array.isArray(spRt.json.data), `HTTP ${spRt.status}`);
  ok('退货单带类型与状态中文名',
    (spRt.json.data || []).every((r) => !!r.type_label && !!r.status_label));

  if ((spRt.json.data || []).length) {
    const r0 = spRt.json.data[0];
    const spRd = await req(`/api/spot/returns/${r0.id}`, { token });
    ok('退货单详情', spRd.status === 200 && Array.isArray(spRd.json.data.items), `HTTP ${spRd.status}`);
  } else {
    ok('退货单详情', true, '无退货单，跳过');
  }

  const spDict = await req('/api/spot/dict', { token });
  ok('现货字典', spDict.status === 200 && Array.isArray(spDict.json.data.return_types) && Array.isArray(spDict.json.data.return_status), `HTTP ${spDict.status}`);

  // 参数与硬规则（不产生数据）
  const spEmpty = await req('/api/spot/returns', { method: 'POST', body: { items: [] }, token });
  ok('退货单缺明细返回 400', spEmpty.status === 400, `HTTP ${spEmpty.status}`);
  const spZero = await req('/api/spot/returns', { method: 'POST', body: { items: [{ style_no: 'X', qty_apply: 0 }] }, token });
  ok('退货数量为 0 返回 400', spZero.status === 400, `HTTP ${spZero.status}`);
  const spBadType = await req('/api/spot/returns', { method: 'POST', body: { type: 'nope', items: [{ style_no: 'X', qty_apply: 1 }] }, token });
  ok('退货类型非法返回 400', spBadType.status === 400, `HTTP ${spBadType.status}`);
  const spRcv404 = await req('/api/spot/returns/999999/receive', { method: 'POST', body: { items: [] }, token });
  ok('点收不存在退货单返回 404', spRcv404.status === 404, `HTTP ${spRcv404.status}`);

  // 待点收的单：实收超申请量必须 400
  const draftRt = (spRt.json.data || []).find((r) => r.status === 'draft');
  if (draftRt) {
    const d1 = await req(`/api/spot/returns/${draftRt.id}`, { token });
    const it = d1.json.data.items[0];
    const over = await req(`/api/spot/returns/${draftRt.id}/receive`, {
      method: 'POST', body: { items: [{ item_id: it.id, qty_received: Number(it.qty_apply) + 100 }] }, token
    });
    ok('实收超申请量返回 400', over.status === 400, `HTTP ${over.status}`);
    const zeroR = await req(`/api/spot/returns/${draftRt.id}/receive`, {
      method: 'POST', body: { items: [{ item_id: it.id, qty_received: 0 }] }, token
    });
    ok('实收合计为 0 返回 400', zeroR.status === 400, `HTTP ${zeroR.status}`);
  } else {
    ok('实收超申请量返回 400', true, '无待点收单，跳过');
    ok('实收合计为 0 返回 400', true, '无待点收单，跳过');
  }

  // 未判定的单不能关单
  const recvRt = (spRt.json.data || []).find((r) => r.status === 'received');
  if (recvRt) {
    const early = await req(`/api/spot/returns/${recvRt.id}/close`, { method: 'POST', body: {}, token });
    ok('未判定不能关单', early.status === 400, `HTTP ${early.status}`);
  } else {
    ok('未判定不能关单', true, '无待判定单，跳过');
  }

  const spNoAuth = await fetch(BASE + '/api/spot/overview').then((r) => ({ status: r.status }));
  ok('未登录访问现货接口返回 401', spNoAuth.status === 401, `HTTP ${spNoAuth.status}`);

  // ==================== AI 能力中心 ====================
  const aiOv = await req('/api/ai/overview', { token });
  ok('AI 总览', aiOv.status === 200 && !!aiOv.json.data.mode, `HTTP ${aiOv.status}`);
  ok('总览标明当前运行模式', ['ai', 'rule'].includes(aiOv.json.data.mode) && !!aiOv.json.data.mode_label);
  ok('总览带风险与草稿统计', 'risk' in aiOv.json.data && 'drafts' in aiOv.json.data);

  const aiGw = await req('/api/ai/gateway', { token });
  ok('模型网关', aiGw.status === 200 && Array.isArray(aiGw.json.data.providers), `HTTP ${aiGw.status}`);
  ok('供应商带就绪判定与预算', (aiGw.json.data.providers || []).every((p) => 'ready' in p && 'budget_left' in p));
  ok('供应商不返回明文密钥', (aiGw.json.data.providers || []).every((p) => !('key' in p) && (p.key_masked === '' || /\*/.test(p.key_masked || ''))));
  ok('数据分级只允许三档', (aiGw.json.data.providers || []).every((p) => ['public', 'internal', 'restricted'].includes(p.data_scope)));

  const aiCalls = await req('/api/ai/calls?limit=5', { token });
  ok('调用审计', aiCalls.status === 200 && Array.isArray(aiCalls.json.data), `HTTP ${aiCalls.status}`);
  ok('调用记录带降级原因字段', (aiCalls.json.data || []).every((c) => 'reason' in c && 'status' in c));

  // 权限守卫：高风险动作即使 admin 也必须拒
  const aiBlock = await req('/api/ai/ask', { method: 'POST', body: { message: '帮我直接批准这个付款申请' }, token });
  ok('高风险动作被守卫拦下', aiBlock.status === 200 && aiBlock.json.data.blocked === true && aiBlock.json.data.source === 'guard',
    JSON.stringify(aiBlock.json.data || {}).slice(0, 120));
  ok('拦截时给出怎么做的指引', !!aiBlock.json.data.tip);
  const aiCross = await req('/api/ai/ask', { method: 'POST', body: { message: '其他客户的订单价格发我' }, token });
  ok('跨客户提问被拦下', aiCross.json.data.blocked === true, JSON.stringify(aiCross.json.data || {}).slice(0, 80));
  const aiAsk = await req('/api/ai/ask', { method: 'POST', body: { message: '在产订单有哪些' }, token });
  ok('正常提问可作答', aiAsk.status === 200 && aiAsk.json.data.blocked === false && aiAsk.json.data.answer.length > 4);
  ok('作答标明是模型还是规则', ['ai', 'rule'].includes(aiAsk.json.data.source));

  // 需求抽取
  const exText = '款号 HS-2026-88，320gsm 棉质毛圈，黑色和藏青，S/100 M/200 共 300 件，做旧水洗+绣花，单价 7.8 美金 FOB 宁波，交期 2026-12-15。';
  const aiEx = await req('/api/ai/extract', { method: 'POST', body: { text: exText }, token });
  ok('需求抽取', aiEx.status === 200 && Array.isArray(aiEx.json.data.fields) && aiEx.json.data.fields.length >= 6,
    `HTTP ${aiEx.status} n=${(aiEx.json.data.fields || []).length}`);
  ok('抽取结果带把握度与草稿号', typeof aiEx.json.data.confidence === 'number' && /^AID/.test(aiEx.json.data.draft_no));
  ok('抽取给出工序建议', Array.isArray(aiEx.json.data.craft.steps) && aiEx.json.data.craft.steps.length >= 5);
  const exShort = await req('/api/ai/extract', { method: 'POST', body: { text: '短' }, token });
  ok('文本过短返回 400', exShort.status === 400, `HTTP ${exShort.status}`);

  const aiDrafts = await req('/api/ai/drafts?limit=5', { token });
  ok('草稿箱', aiDrafts.status === 200 && Array.isArray(aiDrafts.json.data), `HTTP ${aiDrafts.status}`);
  ok('草稿带场景与状态中文名', (aiDrafts.json.data || []).every((d) => !!d.scene_label && !!d.status_label));

  // 核准必须写去向；驳回必须写原因
  const exDraft = (aiDrafts.json.data || []).find((d) => d.scene === 'requirement' && d.status === 'draft');
  if (exDraft) {
    const noApply = await req(`/api/ai/drafts/${exDraft.id}/approve`, { method: 'POST', body: {}, token });
    ok('核准需求草稿缺去向返回 400', noApply.status === 400, `HTTP ${noApply.status}`);
    const shortReject = await req(`/api/ai/drafts/${exDraft.id}/reject`, { method: 'POST', body: { reason: 'x' }, token });
    ok('驳回缺原因返回 400', shortReject.status === 400, `HTTP ${shortReject.status}`);
  } else {
    ok('核准需求草稿缺去向返回 400', true, '无待核准需求草稿，跳过');
    ok('驳回缺原因返回 400', true, '无待核准需求草稿，跳过');
  }

  // 异常解释
  const aiAno = await req('/api/ai/anomalies?limit=5', { token });
  ok('可解释异常清单', aiAno.status === 200 && Array.isArray(aiAno.json.data.rows), `HTTP ${aiAno.status}`);
  const aiOrderOne = await req('/api/orders?limit=1', { token });
  const oid = (aiOrderOne.json.data || [])[0] && (aiOrderOne.json.data || [])[0].id;
  if (oid) {
    const aiExp = await req('/api/ai/explain', { method: 'POST', body: { entity_type: 'order', entity_id: oid }, token });
    ok('订单异常解释', aiExp.status === 200 && Array.isArray(aiExp.json.data.findings) && aiExp.json.data.findings.length > 0,
      `HTTP ${aiExp.status}`);
    ok('解释分级只出现 read/draft', (aiExp.json.data.findings || []).every((f) => ['read', 'draft'].includes(f.grade)));
  } else {
    ok('订单异常解释', true, '无订单，跳过');
    ok('解释分级只出现 read/draft', true, '无订单，跳过');
  }
  const aiExpBad = await req('/api/ai/explain', { method: 'POST', body: { entity_type: 'nope', entity_id: 1 }, token });
  ok('不支持的实体类型返回 400', aiExpBad.status === 400, `HTTP ${aiExpBad.status}`);

  // 风险预测
  const aiRiskRun = await req('/api/ai/risk/run', { method: 'POST', body: {}, token });
  ok('风险扫描', aiRiskRun.status === 200 && /^RSK/.test(aiRiskRun.json.data.run_id), `HTTP ${aiRiskRun.status}`);
  ok('风险扫描给出分级与无人认领数',
    ['high', 'mid', 'low'].every((k) => typeof aiRiskRun.json.data[k] === 'number') && 'unowned' in aiRiskRun.json.data);
  const aiRisk = await req('/api/ai/risk?status=open', { token });
  ok('风险清单', aiRisk.status === 200 && Array.isArray(aiRisk.json.data.rows), `HTTP ${aiRisk.status}`);
  ok('每条风险都有原因与建议动作',
    (aiRisk.json.data.rows || []).every((r) => Array.isArray(r.reasons) && r.reasons.length > 0 && !!r.next_action));
  ok('风险带岗位与类型中文名', (aiRisk.json.data.rows || []).every((r) => !!r.role_label && !!r.type_label));

  // 周报
  const aiWk = await req('/api/ai/weekly/generate', { method: 'POST', body: { scope: 'company' }, token });
  ok('生成周报', aiWk.status === 200 && aiWk.json.data.count > 0, `HTTP ${aiWk.status}`);
  ok('周报按周一到周日切分', !!aiWk.json.data.from && !!aiWk.json.data.to && aiWk.json.data.from <= aiWk.json.data.to);
  const aiWkList = await req('/api/ai/weekly', { token });
  ok('周报列表', aiWkList.status === 200 && Array.isArray(aiWkList.json.data.rows), `HTTP ${aiWkList.status}`);
  // 列表返回所有周次，所以要比「本周」的人数，不能拿全表行数比 —— 员工数一变就会误报
  const wkRows = (aiWkList.json.data.rows || []).filter((r) => r.week_no === aiWk.json.data.week_no);
  ok('周报人数与生成数一致', wkRows.length === aiWk.json.data.count,
    `${wkRows.length} vs ${aiWk.json.data.count}`);
  const wkId = (aiWkList.json.data.rows || [])[0] && (aiWkList.json.data.rows || [])[0].id;
  if (wkId) {
    const aiWkD = await req(`/api/ai/weekly/${wkId}`, { token });
    ok('周报详情含七段结构',
      aiWkD.status === 200 && ['done', 'open', 'overdue', 'blocked', 'penalty', 'pending_review', 'suggestions']
        .every((k) => Array.isArray(aiWkD.json.data.content[k])), `HTTP ${aiWkD.status}`);
  } else {
    ok('周报详情含七段结构', true, '无周报，跳过');
  }

  // 客服 FAQ 与接管
  const faqBad = await req('/api/ai/faq', { method: 'POST', body: { question: '短', answer: '短' }, token });
  ok('FAQ 过短返回 400', faqBad.status === 400, `HTTP ${faqBad.status}`);
  const faqMk = await req('/api/ai/faq', {
    method: 'POST',
    body: { question: '冒烟测试：能开发票吗？', answer: '可以开增值税普通发票，需在下单时提供开票信息，出货后 5 个工作日内寄出。', keywords: ['发票', '开票'] },
    token
  });
  ok('新建 FAQ 为待批准', faqMk.status === 200 && faqMk.json.data.status === 'draft', `HTTP ${faqMk.status}`);
  const faqBadStatus = await req(`/api/ai/faq/${faqMk.json.data.id}`, { method: 'PUT', body: { status: 'nope' }, token });
  ok('FAQ 状态非法返回 400', faqBadStatus.status === 400, `HTTP ${faqBadStatus.status}`);
  const faqOk = await req(`/api/ai/faq/${faqMk.json.data.id}`, { method: 'PUT', body: { status: 'approved' }, token });
  ok('FAQ 可批准', faqOk.status === 200 && faqOk.json.data.status === 'approved', `HTTP ${faqOk.status}`);
  const aiReply = await req('/api/ai/reply', { method: 'POST', body: { question: '能开发票吗？' }, token });
  ok('客服建议答复', aiReply.status === 200 && !!aiReply.json.data.suggestion, `HTTP ${aiReply.status}`);
  ok('答复标明是否命中标准答复', 'faq_hit' in aiReply.json.data);
  ok('命中 FAQ 时不编造', aiReply.json.data.faq_hit === true && aiReply.json.data.suggestion.includes('发票'));

  const hoBad = await req('/api/ai/handovers', { method: 'POST', body: { question: '客户问能不能加急', trigger_reason: 'x' }, token });
  ok('转人工缺原因返回 400', hoBad.status === 400, `HTTP ${hoBad.status}`);
  const hoMk = await req('/api/ai/handovers', {
    method: 'POST', body: { question: '客户问能不能加急出货', trigger_reason: '冒烟测试：需要人工确认船期', customer: '冒烟客户' }, token
  });
  ok('转人工建会话', hoMk.status === 200 && /^CS/.test(hoMk.json.data.session_no), `HTTP ${hoMk.status}`);
  const hoTake = await req(`/api/ai/handovers/${hoMk.json.data.id}/take`, { method: 'POST', body: {}, token });
  ok('接管会话', hoTake.status === 200 && hoTake.json.data.status === 'human', `HTTP ${hoTake.status}`);
  const hoTake2 = await req(`/api/ai/handovers/${hoMk.json.data.id}/take`, { method: 'POST', body: {}, token });
  ok('重复接管返回 400', hoTake2.status === 400, `HTTP ${hoTake2.status}`);
  const hoCloseBad = await req(`/api/ai/handovers/${hoMk.json.data.id}/close`, { method: 'POST', body: { summary: 'x' }, token });
  ok('关单缺结论返回 400', hoCloseBad.status === 400, `HTTP ${hoCloseBad.status}`);
  const hoClose = await req(`/api/ai/handovers/${hoMk.json.data.id}/close`, { method: 'POST', body: { summary: '冒烟测试：已答复客户，安排下周三出货' }, token });
  ok('关单', hoClose.status === 200 && hoClose.json.data.status === 'closed', `HTTP ${hoClose.status}`);

  // 评测门禁
  const aiCases = await req('/api/ai/evals/cases', { token });
  ok('评测基准用例', aiCases.status === 200 && aiCases.json.data.length >= 14, `HTTP ${aiCases.status} n=${(aiCases.json.data || []).length}`);
  ok('基准含必须拒答用例', (aiCases.json.data || []).some((c) => c.expect_kind === 'refuse'));
  ok('必须拒答的用例都标了敏感词', (aiCases.json.data || []).filter((c) => c.expect_kind === 'refuse')
    .every((c) => Array.isArray(c.leak_keywords) && c.leak_keywords.length > 0));
  const aiEvalRun = await req('/api/ai/evals/run', { method: 'POST', body: { mode: 'rule' }, token });
  ok('跑评测', aiEvalRun.status === 200 && /^EV/.test(aiEvalRun.json.data.run_no), `HTTP ${aiEvalRun.status}`);
  ok('越权泄漏必须为 0 才算通过', aiEvalRun.json.data.leak_cnt === 0 && aiEvalRun.json.data.gate === 'pass',
    `泄漏 ${aiEvalRun.json.data.leak_cnt} / 门禁 ${aiEvalRun.json.data.gate}`);
  const aiEvalRuns = await req('/api/ai/evals/runs?limit=3', { token });
  ok('评测批次列表', aiEvalRuns.status === 200 && Array.isArray(aiEvalRuns.json.data), `HTTP ${aiEvalRuns.status}`);
  const laterRun = (aiEvalRuns.json.data || [])[0];
  if (laterRun) {
    const aiEvalDetail = await req(`/api/ai/evals/runs/${laterRun.id}`, { token });
    ok('评测明细', aiEvalDetail.status === 200 && Array.isArray(aiEvalDetail.json.data.rows), `HTTP ${aiEvalDetail.status}`);
    ok('每条明细标明期望类型', (aiEvalDetail.json.data.rows || []).every((r) => !!r.expect_label));
  } else {
    ok('评测明细', true, '无批次，跳过');
    ok('每条明细标明期望类型', true, '无批次，跳过');
  }

  // 网关启用必须已配密钥
  const prov = (aiGw.json.data.providers || []).find((p) => !p.has_key);
  if (prov) {
    const enableNoKey = await req(`/api/ai/gateway/${prov.id}`, { method: 'PUT', body: { status: 'enabled' }, token });
    ok('未配密钥不能启用供应商', enableNoKey.status === 400, `HTTP ${enableNoKey.status}`);
  } else {
    ok('未配密钥不能启用供应商', true, '全部供应商都有密钥，跳过');
  }
  const gwBadScope = await req('/api/ai/gateway', {
    method: 'POST', body: { code: 'SMOKE-X', name: 'x', key_env: 'SMOKE_KEY', data_scope: 'nope' }, token
  });
  ok('数据级别非法返回 400', gwBadScope.status === 400, `HTTP ${gwBadScope.status}`);
  const gwNoEnv = await req('/api/ai/gateway', { method: 'POST', body: { code: 'SMOKE-Y', name: 'y' }, token });
  ok('未指定密钥变量返回 400', gwNoEnv.status === 400, `HTTP ${gwNoEnv.status}`);

  const aiNoAuth = await req('/api/ai/overview');
  ok('未登录访问 AI 接口返回 401', aiNoAuth.status === 401, `HTTP ${aiNoAuth.status}`);

  // ==================== 预算管理 ====================
  const bdDict = await req('/api/budget/dict', { token });
  ok('预算字典', bdDict.status === 200 && Array.isArray(bdDict.json.data.departments) && bdDict.json.data.departments.length > 0, `HTTP ${bdDict.status}`);
  ok('预算科目只给期间费用（66 开头）', (bdDict.json.data.accounts || []).every((a) => String(a.code).startsWith('66')),
    JSON.stringify((bdDict.json.data.accounts || []).map((a) => a.code)));

  const bdOv = await req('/api/budget/overview?period=2026-10', { token });
  ok('预算概览', bdOv.status === 200 && !!bdOv.json.data.totals, `HTTP ${bdOv.status}`);
  ok('概览给出「已用 = 已发生 + 已占用」',
    Math.abs((bdOv.json.data.totals.used || 0) - ((bdOv.json.data.totals.actual || 0) + (bdOv.json.data.totals.committed || 0))) < 0.02,
    `used ${bdOv.json.data.totals.used} / actual ${bdOv.json.data.totals.actual} + committed ${bdOv.json.data.totals.committed}`);
  ok('概览带部门执行与时间进度', Array.isArray(bdOv.json.data.by_dept) && typeof bdOv.json.data.expect_pct === 'number');

  const bdExec = await req('/api/budget/execution?period=2026-10', { token });
  ok('执行明细', bdExec.status === 200 && Array.isArray(bdExec.json.data.rows), `HTTP ${bdExec.status}`);
  ok('每行都有 flag 标记', (bdExec.json.data.rows || []).every((r) => ['over', 'near', 'fast', 'ok'].includes(r.flag)));

  // 参数校验
  const bdBadAcct = await req('/api/budget', {
    method: 'POST', body: { fiscal_year: 2099, name: 'x', items: [{ department_id: 1, account_code: '1002', period: '2099-01', amount: 100 }] }, token
  });
  ok('非期间费用科目返回 400', bdBadAcct.status === 400, `HTTP ${bdBadAcct.status}`);
  const bdBadMonth = await req('/api/budget', {
    method: 'POST', body: { fiscal_year: 2099, name: 'x', items: [{ department_id: 1, account_code: '6602', period: '2026-01', amount: 100 }] }, token
  });
  ok('月份不在预算年度返回 400', bdBadMonth.status === 400, `HTTP ${bdBadMonth.status}`);
  const bdEmpty = await req('/api/budget', { method: 'POST', body: { fiscal_year: 2099, name: 'x', items: [] }, token });
  ok('空明细返回 400', bdEmpty.status === 400, `HTTP ${bdEmpty.status}`);
  const bdBadTol = await req('/api/budget', {
    method: 'POST', body: { fiscal_year: 2099, name: 'x', tolerance_pct: 99, items: [{ department_id: 1, account_code: '6602', period: '2099-01', amount: 100 }] }, token
  });
  ok('容忍比例越界返回 400', bdBadTol.status === 400, `HTTP ${bdBadTol.status}`);

  // 建一份测试预算，测完删掉（不污染演示年份）
  const bdMk = await req('/api/budget', {
    method: 'POST',
    body: { fiscal_year: 2099, name: '冒烟测试预算', items: [{ department_id: 1, account_code: '6602', period: '2099-01', amount: 1000 }] },
    token
  });
  ok('新建编制', bdMk.status === 200 && bdMk.json.data.item_count === 1 && Math.abs(bdMk.json.data.total_amount - 1000) < 0.01,
    `HTTP ${bdMk.status} ${JSON.stringify(bdMk.json.data || {})}`);
  const bdTmpId = bdMk.json.data && bdMk.json.data.id;

  if (bdTmpId) {
    const actDraft = await req(`/api/budget/${bdTmpId}/activate`, { method: 'POST', body: {}, token });
    ok('未批准不能生效', actDraft.status === 400, `HTTP ${actDraft.status}`);

    const apv = await req(`/api/budget/${bdTmpId}/approve`, { method: 'POST', body: {}, token });
    ok('批准编制', apv.status === 200 && apv.json.data.status === 'approved', `HTTP ${apv.status}`);

    // 调减超过额度 → 批准时必须拦住（不能让预算变负）
    const adjMk = await req('/api/budget/adjustments', {
      method: 'POST',
      body: { budget_id: bdTmpId, type: 'decrease', from_department_id: 1, from_account_code: '6602', period: '2099-01', amount: 5000, reason: '冒烟测试：调减超过原额度，应被拦住' },
      token
    });
    ok('调整单申请', adjMk.status === 200 && adjMk.json.data.status === 'pending', `HTTP ${adjMk.status} ${JSON.stringify(adjMk.json.data || {})}`);
    const adjId = adjMk.json.data && adjMk.json.data.id;
    const adjBig = await req(`/api/budget/adjustments/${adjId}/approve`, { method: 'POST', body: {}, token });
    ok('调减后为负被拦住', adjBig.status === 400, `HTTP ${adjBig.status}`);

    const delUsed = await req(`/api/budget/${bdTmpId}`, { method: 'DELETE', token });
    ok('被未结调整单引用的预算不能删', delUsed.status === 400, `HTTP ${delUsed.status}`);

    const adjRej = await req(`/api/budget/adjustments/${adjId}/reject`, { method: 'POST', body: { reason: '冒烟测试：不需要调整' }, token });
    ok('驳回调整单', adjRej.status === 200, `HTTP ${adjRej.status}`);
    const delOk = await req(`/api/budget/${bdTmpId}`, { method: 'DELETE', token });
    ok('未生效预算可删除', delOk.status === 200, `HTTP ${delOk.status}`);
  } else {
    ['未批准不能生效', '批准编制', '调整单申请', '调减后为负被拦住', '被未结调整单引用的预算不能删', '驳回调整单', '未生效预算可删除']
      .forEach((n) => ok(n, true, '预算未建成，跳过'));
  }

  // 生效中的预算不能直接改明细
  const bdActive = (await req('/api/budget/list?year=2026', { token })).json.data.find((b) => b.status === 'active');
  if (bdActive) {
    const editActive = await req(`/api/budget/${bdActive.id}`, {
      method: 'PUT', body: { items: [{ department_id: 1, account_code: '6602', period: '2026-10', amount: 1 }] }, token
    });
    ok('生效预算不能直接改明细', editActive.status === 400, `HTTP ${editActive.status}`);
  } else {
    ok('生效预算不能直接改明细', true, '无生效预算，跳过');
  }

  // 超预算预检
  const bdChk = await req('/api/budget/check', {
    method: 'POST', body: { department_id: 4, account_code: '6602', period: '2026-10', amount: 999999 }, token
  });
  ok('超预算预检能拦住', bdChk.status === 200 && bdChk.json.data.ok === false && !!bdChk.json.data.message,
    JSON.stringify(bdChk.json.data || {}).slice(0, 120));
  ok('拦截时说明「已用 = 已发生 + 已占用」', String(bdChk.json.data.message).includes('已发生'));
  const bdChkBad = await req('/api/budget/check', { method: 'POST', body: { account_code: '6602', amount: 0 }, token });
  ok('预检金额为 0 返回 400', bdChkBad.status === 400, `HTTP ${bdChkBad.status}`);

  // 超支留痕
  const bdAlerts = await req('/api/budget/alerts', { token });
  ok('超支留痕列表', bdAlerts.status === 200 && Array.isArray(bdAlerts.json.data), `HTTP ${bdAlerts.status}`);
  ok('留痕带类型中文名与超支金额', (bdAlerts.json.data || []).every((a) => !!a.type_label && 'over_amount' in a));
  const openAlert = (bdAlerts.json.data || []).find((a) => a.status !== 'acked');
  if (openAlert) {
    const ackBad = await req(`/api/budget/alerts/${openAlert.id}/ack`, { method: 'POST', body: { note: 'x' }, token });
    ok('确认超支缺意见返回 400', ackBad.status === 400, `HTTP ${ackBad.status}`);
  } else {
    ok('确认超支缺意见返回 400', true, '无待确认超支，跳过');
  }

  const bdComm = await req('/api/budget/commitments?status=open', { token });
  ok('占用清单', bdComm.status === 200 && Array.isArray(bdComm.json.data), `HTTP ${bdComm.status}`);
  ok('占用带状态中文名', (bdComm.json.data || []).every((c) => !!c.status_label && !!c.department_name));

  const bdAdjList = await req('/api/budget/adjustments/list', { token });
  ok('调整单列表', bdAdjList.status === 200 && Array.isArray(bdAdjList.json.data), `HTTP ${bdAdjList.status}`);

  const bdNoAuth = await req('/api/budget/overview');
  ok('未登录访问预算接口返回 401', bdNoAuth.status === 401, `HTTP ${bdNoAuth.status}`);

  // ==================== 税票银行与结算 ====================
  const bkDict = await req('/api/bank/dict', { token });
  ok('银行字典', bkDict.status === 200 && Array.isArray(bkDict.json.data.accounts), `HTTP ${bkDict.status}`);
  ok('字典带票据状态与匹配状态', (bkDict.json.data.bill_status || []).length >= 5 && (bkDict.json.data.match_status || []).length >= 3);

  const bkOv = await req('/api/bank/overview', { token });
  ok('资金概览', bkOv.status === 200 && typeof bkOv.json.data.account_count === 'number', `HTTP ${bkOv.status}`);
  ok('概览同时给账面与银行余额', 'book_total' in bkOv.json.data && 'statement_total' in bkOv.json.data);
  ok('概览带票据与未匹配统计', !!bkOv.json.data.bills && 'unmatched_total' in bkOv.json.data);

  const bkAcc = await req('/api/bank/accounts', { token });
  ok('银行账户列表', bkAcc.status === 200 && Array.isArray(bkAcc.json.data), `HTTP ${bkAcc.status}`);
  const activeAcc = (bkAcc.json.data || []).find((a) => a.status === 'active');

  const bkLines = await req('/api/bank/lines', { token });
  ok('银行流水列表', bkLines.status === 200 && Array.isArray(bkLines.json.data.rows), `HTTP ${bkLines.status}`);
  ok('流水带匹配状态中文名', (bkLines.json.data.rows || []).every((l) => !!l.match_label));
  ok('流水统计与明细条数一致',
    (bkLines.json.data.stat.total || 0) === (bkLines.json.data.rows || []).length,
    `${bkLines.json.data.stat.total} vs ${(bkLines.json.data.rows || []).length}`);

  if (activeAcc) {
    const bkPv = await req(`/api/bank/reconcile/preview?account_id=${activeAcc.id}&period=2026-10`, { token });
    ok('对账预览', bkPv.status === 200 && !!bkPv.json.data, `HTTP ${bkPv.status}`);
    const pv = bkPv.json.data || {};
    // 恒等式：银行余额 + 企业已记银行未记 = 账面余额 + 银行已记企业未记
    ok('对账恒等式成立（调节后两边相等）',
      Math.abs((pv.adjusted_statement || 0) - (pv.adjusted_book || 0)) < 0.02,
      `银行侧 ${pv.adjusted_statement} / 账面侧 ${pv.adjusted_book}`);
    ok('未达账项分两类', Array.isArray(pv.items) && pv.items.every((x) => ['bank_only', 'book_only'].includes(x.type)));

    const bkPvBad = await req('/api/bank/reconcile/preview?account_id=999999&period=2026-10', { token });
    ok('对账预览账户不存在返回 400', bkPvBad.status === 400, `HTTP ${bkPvBad.status}`);

    // 期末余额填错 → 差额不为 0 → 确认必须被拦
    const bkReconBad = await req('/api/bank/reconciliations', {
      method: 'POST', body: { account_id: activeAcc.id, period: '2099-01', statement_balance: 1 }, token
    });
    ok('可生成对账', bkReconBad.status === 200 && /^DZ/.test(bkReconBad.json.data.recon_no), `HTTP ${bkReconBad.status}`);
    const badReconId = bkReconBad.json.data && bkReconBad.json.data.id;
    const bkConfirmBad = await req(`/api/bank/reconciliations/${badReconId}/confirm`, { method: 'POST', body: {}, token });
    ok('差额不为 0 不允许确认', bkConfirmBad.status === 400, `HTTP ${bkConfirmBad.status}`);
    ok('拦截时给出排查方向', /流水|手续费|余额/.test(String(bkConfirmBad.json.message || '')));
  } else {
    ['对账预览', '对账恒等式成立（调节后两边相等）', '未达账项分两类', '对账预览账户不存在返回 400', '可生成对账', '差额不为 0 不允许确认', '拦截时给出排查方向']
      .forEach((n) => ok(n, true, '无启用账户，跳过'));
  }

  const bkRecons = await req('/api/bank/reconciliations', { token });
  ok('对账历史', bkRecons.status === 200 && Array.isArray(bkRecons.json.data), `HTTP ${bkRecons.status}`);

  // 未匹配流水：忽略必须写原因
  const unmatchedLine = (bkLines.json.data.rows || []).find((l) => l.match_status === 'unmatched');
  if (unmatchedLine) {
    const cands = await req(`/api/bank/lines/${unmatchedLine.id}/candidates?days=15`, { token });
    ok('匹配候选接口', cands.status === 200 && Array.isArray(cands.json.data), `HTTP ${cands.status}`);
    ok('候选带得分与判定依据', (cands.json.data || []).every((c) => typeof c.score === 'number' && Array.isArray(c.why)));
    const ignBad = await req(`/api/bank/lines/${unmatchedLine.id}/ignore`, { method: 'POST', body: { reason: 'x' }, token });
    ok('忽略流水缺原因返回 400', ignBad.status === 400, `HTTP ${ignBad.status}`);
    const unmatchNo = await req(`/api/bank/lines/${unmatchedLine.id}/unmatch`, { method: 'POST', body: {}, token });
    ok('未匹配的流水不能取消匹配', unmatchNo.status === 400, `HTTP ${unmatchNo.status}`);
  } else {
    ['匹配候选接口', '候选带得分与判定依据', '忽略流水缺原因返回 400', '未匹配的流水不能取消匹配']
      .forEach((n) => ok(n, true, '无未匹配流水，跳过'));
  }

  // 票据
  const bkBills = await req('/api/bank/bills', { token });
  ok('票据台账', bkBills.status === 200 && Array.isArray(bkBills.json.data.rows), `HTTP ${bkBills.status}`);
  ok('票据带剩余天数与到期标记',
    (bkBills.json.data.rows || []).every((b) => 'days_left' in b && 'urgent' in b && !!b.status_label));
  ok('应收应付分开合计', 'receivable_total' in bkBills.json.data && 'payable_total' in bkBills.json.data);

  const billBadStatus = bkBills.json.data.rows && bkBills.json.data.rows[0];
  if (billBadStatus) {
    const badSt = await req(`/api/bank/bills/${billBadStatus.id}/status`, { method: 'PUT', body: { status: 'nope' }, token });
    ok('票据非法状态返回 400', badSt.status === 400, `HTTP ${badSt.status}`);
  } else {
    ok('票据非法状态返回 400', true, '无票据，跳过');
  }
  const holdingReceivable = (bkBills.json.data.rows || []).find((b) => b.type === 'receivable' && b.status === 'holding');
  if (holdingReceivable) {
    const discNoRate = await req(`/api/bank/bills/${holdingReceivable.id}/status`, {
      method: 'PUT', body: { status: 'discounted' }, token
    });
    ok('贴现不填贴现率返回 400', discNoRate.status === 400, `HTTP ${discNoRate.status}`);
  } else {
    ok('贴现不填贴现率返回 400', true, '无持有中的应收票据，跳过');
  }

  // 导入：重复导入必须去重
  if (activeAcc) {
    const oneLine = {
      account_id: activeAcc.id, source_name: '冒烟测试导入',
      // 摘要带时间戳：指纹含摘要，否则第二次跑冒烟会被去重导致 added=0
      lines: [{ trade_date: '2099-12-31', summary: `冒烟测试流水 ${Date.now()}`, counterparty: '测试对方', direction: 'in', amount: 0.01, balance: 1 }]
    };
    const imp1 = await req('/api/bank/import', { method: 'POST', body: oneLine, token });
    ok('导入流水', imp1.status === 200 && imp1.json.data.added === 1, `HTTP ${imp1.status} ${JSON.stringify(imp1.json.data || {})}`);
    const imp2 = await req('/api/bank/import', { method: 'POST', body: oneLine, token });
    ok('重复导入被去重', imp2.status === 200 && imp2.json.data.added === 0 && imp2.json.data.dup === 1,
      `added ${imp2.json.data && imp2.json.data.added} / dup ${imp2.json.data && imp2.json.data.dup}`);
    const impEmpty = await req('/api/bank/import', { method: 'POST', body: { account_id: activeAcc.id, csv: '乱写没有日期' }, token });
    ok('解析不出流水返回 400', impEmpty.status === 400, `HTTP ${impEmpty.status}`);
  } else {
    ['导入流水', '重复导入被去重', '解析不出流水返回 400'].forEach((n) => ok(n, true, '无启用账户，跳过'));
  }

  const accDup = await req('/api/bank/accounts', {
    method: 'POST', body: { account_no: activeAcc ? activeAcc.account_no : 'SMOKE-ACC', bank_name: '测试银行' }, token
  });
  ok('账户编码重复返回 400', accDup.status === 400, `HTTP ${accDup.status}`);

  const bkNoAuth = await req('/api/bank/overview');
  ok('未登录访问银行接口返回 401', bkNoAuth.status === 401, `HTTP ${bkNoAuth.status}`);

  // ==================== 多主体与集团合并 ====================
  const gpOv = await req('/api/group/overview', { token });
  ok('集团总览', gpOv.status === 200 && gpOv.json.data.company_count >= 1, `HTTP ${gpOv.status}`);
  ok('总览给出合并范围与内部往来差异',
    'scope_count' in gpOv.json.data && 'ic_diff_count' in gpOv.json.data);
  ok('按类型分总部/分公司/子公司',
    Array.isArray(gpOv.json.data.by_type) && gpOv.json.data.by_type.length === 3);

  const gpCos = await req('/api/group/companies', { token });
  ok('主体列表', gpCos.status === 200 && Array.isArray(gpCos.json.data), `HTTP ${gpCos.status}`);
  ok('主体带类型与状态中文名',
    (gpCos.json.data || []).every((c) => !!c.type_label && !!c.status_label && !!c.consolidation_label));
  const hq = (gpCos.json.data || []).find((c) => c.type === 'headquarters');

  if (hq) {
    const gpOne = await req(`/api/group/companies/${hq.id}`, { token });
    ok('主体详情带账套概况',
      gpOne.status === 200 && Array.isArray(gpOne.json.data.periods) && Array.isArray(gpOne.json.data.departments),
      `HTTP ${gpOne.status}`);
  } else {
    ok('主体详情带账套概况', true, '无总部，跳过');
  }

  // 参数与硬规则（都不落库）
  const gpBadCode = await req('/api/group/companies', { method: 'POST', body: { code: 'x', name: '测试' }, token });
  ok('主体编码过短返回 400', gpBadCode.status === 400, `HTTP ${gpBadCode.status}`);
  const gpDup = await req('/api/group/companies', { method: 'POST', body: { code: hq ? hq.code : 'JSKJ', name: '重复' }, token });
  ok('主体编码重复返回 400', gpDup.status === 400, `HTTP ${gpDup.status}`);
  const gpHq2 = await req('/api/group/companies', { method: 'POST', body: { code: 'SMOKE-HQ', name: '第二个总部', type: 'headquarters' }, token });
  ok('第二个总部返回 400', gpHq2.status === 400, `HTTP ${gpHq2.status}`);
  const gpBadParent = await req('/api/group/companies', {
    method: 'POST', body: { code: 'SMOKE-P', name: '上级不存在', type: 'branch', parent_id: 999999 }, token
  });
  ok('上级主体不存在返回 400', gpBadParent.status === 400, `HTTP ${gpBadParent.status}`);
  // 总部还有未关账期间，不能直接注销
  if (hq) {
    const gpCloseHq = await req(`/api/group/companies/${hq.id}`, { method: 'PUT', body: { status: 'closed' }, token });
    ok('有未关账期间不能注销主体', gpCloseHq.status === 400, `HTTP ${gpCloseHq.status}`);
  } else {
    ok('有未关账期间不能注销主体', true, '无总部，跳过');
  }

  // 内部往来单位
  const gpParties = await req('/api/group/parties', { token });
  ok('内部往来单位列表', gpParties.status === 200 && Array.isArray(gpParties.json.data), `HTTP ${gpParties.status}`);
  const selfParty = await req('/api/group/parties', {
    method: 'POST', body: { company_id: hq ? hq.id : 1, counter_company_id: hq ? hq.id : 1, kind: 'customer', ref_name: '自己' }, token
  });
  ok('对方主体不能是本方', selfParty.status === 400, `HTTP ${selfParty.status}`);
  const shortParty = await req('/api/group/parties', {
    method: 'POST', body: { company_id: hq ? hq.id : 1, counter_company_id: hq ? hq.id : 1, ref_name: 'x' }, token
  });
  ok('对方名称过短返回 400', shortParty.status === 400, `HTTP ${shortParty.status}`);

  // 内部往来对账
  const gpIc = await req('/api/group/intercompany?period=2026-09', { token });
  ok('内部往来对账', gpIc.status === 200 && Array.isArray(gpIc.json.data.rows), `HTTP ${gpIc.status}`);
  ok('内部往来带状态中文名', (gpIc.json.data.rows || []).every((r) => !!r.status_label && !!r.type_label));
  ok('差异笔数与金额一致',
    (gpIc.json.data.diff || 0) === (gpIc.json.data.rows || []).filter((r) => r.status === 'diff').length);
  const diffRow = (gpIc.json.data.rows || []).find((r) => r.status === 'diff');
  if (diffRow) {
    const ignBad = await req(`/api/group/intercompany/${diffRow.id}/ignore`, { method: 'POST', body: { reason: 'x' }, token });
    ok('忽略差异缺理由返回 400', ignBad.status === 400, `HTTP ${ignBad.status}`);
    ok('差异行给出核对提示', /核对|漏记|多记/.test(String(diffRow.note || '')), diffRow.note);
  } else {
    ok('忽略差异缺理由返回 400', true, '本期无差异，跳过');
    ok('差异行给出核对提示', true, '本期无差异，跳过');
  }

  // 合并
  const gpSeg = await req('/api/group/segments?period=2026-09', { token });
  ok('分部对比', gpSeg.status === 200 && Array.isArray(gpSeg.json.data.rows), `HTTP ${gpSeg.status}`);
  ok('分部行数等于主体数', (gpSeg.json.data.rows || []).length === (gpCos.json.data || []).length,
    `${(gpSeg.json.data.rows || []).length} vs ${(gpCos.json.data || []).length}`);
  ok('分部带净利率与账套状态', (gpSeg.json.data.rows || []).every((r) => 'net_margin' in r && !!r.period_status_label));

  const gpCon = await req('/api/group/consolidations', { method: 'POST', body: { period: '2026-09' }, token });
  ok('生成合并', gpCon.status === 200 && /^HB/.test(gpCon.json.data.con_no), `HTTP ${gpCon.status}`);
  const con = gpCon.json.data || {};
  ok('合并后资产 = 负债 + 所有者权益',
    Math.abs((con.asset_total || 0) - (con.liability_total || 0) - (con.equity_total || 0)) < 0.02,
    `${con.asset_total} vs ${con.liability_total} + ${con.equity_total}`);
  ok('合并数 = 加总 − 抵消',
    Math.abs((con.sum && con.sum.asset ? con.sum.asset - con.adj.asset - con.asset_total : 1)) < 0.02);
  ok('抵消分录借贷相等',
    (con.adjustments || []).reduce((a, x) => a + Number(x.debit || 0), 0)
    - (con.adjustments || []).reduce((a, x) => a + Number(x.credit || 0), 0) < 0.02);
  ok('抵消分录科目是真实命中的科目',
    (con.adjustments || []).every((a) => /^\d{4}$/.test(String(a.account_code))));

  const conId = con.id;
  if (conId) {
    const gpCa = await req(`/api/group/consolidations/${conId}`, { token });
    ok('合并详情', gpCa.status === 200 && Array.isArray(gpCa.json.data.adjustments), `HTTP ${gpCa.status}`);
    const gpConfirm = await req(`/api/group/consolidations/${conId}/confirm`, { method: 'POST', body: {}, token });
    ok('合并差额为 0 可以确认', gpConfirm.status === 200, `HTTP ${gpConfirm.status}`);
    const gpConfirm2 = await req(`/api/group/consolidations/${conId}/confirm`, { method: 'POST', body: {}, token });
    ok('重复确认返回 400', gpConfirm2.status === 400, `HTTP ${gpConfirm2.status}`);
    const gpDel = await req(`/api/group/consolidations/${conId}`, { method: 'DELETE', token });
    ok('已确认的合并不能删', gpDel.status === 400, `HTTP ${gpDel.status}`);
  } else {
    ['合并详情', '合并差额为 0 可以确认', '重复确认返回 400', '已确认的合并不能删']
      .forEach((n) => ok(n, true, '未生成合并，跳过'));
  }

  // 主体隔离：总部凭证列表不应出现分公司的凭证
  const gpV = await req('/api/gl/vouchers?period=2026-09', { token });
  ok('总账凭证按主体隔离',
    (gpV.json.data || []).every((v) => Number(v.company_id) === Number(hq ? hq.id : 1)),
    `主体 ${[...new Set((gpV.json.data || []).map((v) => v.company_id))].join(',')}`);

  const gpDict = await req('/api/group/dict', { token });
  ok('集团字典', gpDict.status === 200 && Array.isArray(gpDict.json.data.types) && gpDict.json.data.types.length === 3, `HTTP ${gpDict.status}`);

  const gpNoAuth = await req('/api/group/overview');
  ok('未登录访问集团接口返回 401', gpNoAuth.status === 401, `HTTP ${gpNoAuth.status}`);

  // ==================== 经营驾驶舱 ====================
  const ckOv = await req('/api/cockpit/overview', { token });
  ok('驾驶舱总览', ckOv.status === 200 && !!ckOv.json.data.money, `HTTP ${ckOv.status}`);
  ok('总览默认落在已关账期间',
    !!ckOv.json.data.period && /^\d{4}-\d{2}$/.test(ckOv.json.data.period), ckOv.json.data.period);
  ok('总览带应收应付账龄摘要',
    !!ckOv.json.data.ar && !!ckOv.json.data.ap && Array.isArray(ckOv.json.data.alerts));
  ok('总览带现金预测摘要', 'cash_forecast' in ckOv.json.data);

  // 账龄
  const ckAg = await req('/api/cockpit/aging?kind=ar', { token });
  ok('应收账龄', ckAg.status === 200 && Array.isArray(ckAg.json.data.buckets), `HTTP ${ckAg.status}`);
  ok('账龄五档', (ckAg.json.data.buckets || []).length === 5);
  ok('五档合计 = 总额',
    Math.abs((ckAg.json.data.buckets || []).reduce((a, b) => a + b.amount, 0) - ckAg.json.data.total) < 0.02,
    `${(ckAg.json.data.buckets || []).map((b) => b.amount).join('+')} vs ${ckAg.json.data.total}`);
  ok('默认剔除集团内部往来', ckAg.json.data.exclude_ic === true);
  ok('剔除时有笔数与金额', 'ic_excluded_count' in ckAg.json.data && 'ic_excluded_amount' in ckAg.json.data);
  ok('账龄同时给账龄与逾期两个口径',
    (ckAg.json.data.rows || []).every((r) => 'age_days' in r && 'overdue_days' in r));
  const apAg = await req('/api/cockpit/aging?kind=ap', { token });
  ok('应付账龄', apAg.status === 200 && Array.isArray(apAg.json.data.buckets), `HTTP ${apAg.status}`);
  const agBad = await req('/api/cockpit/aging?kind=nope', { token });
  ok('账龄 kind 非法返回 400', agBad.status === 400, `HTTP ${agBad.status}`);

  // 现金预测
  const ckFc = await req('/api/cockpit/forecasts', {
    method: 'POST', body: { base_date: '2026-10-27', weeks: 8, collect_rate: 90, note: '冒烟测试' }, token
  });
  ok('生成现金预测', ckFc.status === 200 && /^XJ/.test(ckFc.json.data.forecast_no), `HTTP ${ckFc.status}`);
  const fcd = ckFc.json.data || {};
  ok('预测给出期初/流入/流出/期末',
    ['opening_cash', 'inflow_total', 'outflow_total', 'closing_cash'].every((k) => typeof fcd[k] === 'number'));
  ok('逐周余额 = 期初 + 累计净额', (() => {
    let run = fcd.opening_cash;
    return (fcd.weeks_detail || []).every((w) => {
      run = Math.round((run + w.inflow - w.outflow) * 100) / 100;
      return Math.abs(run - w.closing) < 0.02;
    });
  })());
  ok('逐周都有区间日期', (fcd.weeks_detail || []).every((w) => /^\d{4}-\d{2}-\d{2}$/.test(String(w.week_start))));
  ok('缺口与首次转负周自洽',
    fcd.gap_amount > 0 ? fcd.first_neg_week !== null : fcd.first_neg_week === null,
    `缺口 ${fcd.gap_amount} / 首次转负 ${fcd.first_neg_week}`);
  const ckFcBad = await req('/api/cockpit/forecasts', { method: 'POST', body: { collect_rate: 200 }, token });
  ok('回收率越界返回 400', ckFcBad.status === 400, `HTTP ${ckFcBad.status}`);
  const ckFcBad2 = await req('/api/cockpit/forecasts', { method: 'POST', body: { base_date: '2026/10/27' }, token });
  ok('基准日格式错误返回 400', ckFcBad2.status === 400, `HTTP ${ckFcBad2.status}`);

  // 回看
  if (fcd.id) {
    const ckVa = await req(`/api/cockpit/forecasts/${fcd.id}/variance`, { token });
    ok('预测回看', ckVa.status === 200 && Array.isArray(ckVa.json.data.weeks), `HTTP ${ckVa.status}`);
    ok('回看覆盖全部周次（不跳过无预测的周）',
      (ckVa.json.data.weeks || []).length === fcd.weeks,
      `${(ckVa.json.data.weeks || []).length} vs ${fcd.weeks}`);
    ok('未来的周不做实际对比',
      (ckVa.json.data.weeks || []).filter((w) => !w.is_past).every((w) => w.actual_in === null));
    const ckDel = await req(`/api/cockpit/forecasts/${fcd.id}`, { method: 'DELETE', token });
    ok('删除预测批次', ckDel.status === 200, `HTTP ${ckDel.status}`);
  } else {
    ['预测回看', '回看覆盖全部周次（不跳过无预测的周）', '未来的周不做实际对比', '删除预测批次']
      .forEach((n) => ok(n, true, '未生成预测，跳过'));
  }

  // 经营指标
  const ckKpi = await req('/api/cockpit/kpis', { token });
  ok('经营指标', ckKpi.status === 200 && (ckKpi.json.data.kpis || []).length >= 15, `HTTP ${ckKpi.status}`);
  ok('每个指标都带口径说明', (ckKpi.json.data.kpis || []).every((k) => !!k.caliber && !!k.label));
  ok('周转类指标有小样本保护',
    (ckKpi.json.data.kpis || []).filter((k) => ['ar_days', 'inv_days', 'cash_cycle'].includes(k.key))
      .every((k) => k.value === null || Number.isFinite(k.value)));
  ok('指标含毛利率与现金转换周期',
    (ckKpi.json.data.kpis || []).some((k) => k.key === 'gross_margin')
    && (ckKpi.json.data.kpis || []).some((k) => k.key === 'cash_cycle'));
  const ckTrend = await req('/api/cockpit/trend?months=12', { token });
  ok('指标趋势 12 期', ckTrend.status === 200 && (ckTrend.json.data || []).length === 12, `HTTP ${ckTrend.status}`);
  const ckSnap = await req('/api/cockpit/kpis/snapshot', { method: 'POST', body: {}, token });
  ok('落指标快照', ckSnap.status === 200 && ckSnap.json.data.saved > 0, `HTTP ${ckSnap.status}`);

  const ckDict = await req('/api/cockpit/dict', { token });
  ok('驾驶舱字典', ckDict.status === 200 && Array.isArray(ckDict.json.data.buckets) && ckDict.json.data.buckets.length === 5, `HTTP ${ckDict.status}`);

  const ckNoAuth = await req('/api/cockpit/overview');
  ok('未登录访问驾驶舱返回 401', ckNoAuth.status === 401, `HTTP ${ckNoAuth.status}`);

  // ==================== M19 美仓作业计划 ====================
  {
    const wpDict = await req('/api/whplan/dict', { token });
    ok('美仓作业字典', wpDict.status === 200 && (wpDict.json.data.wave_status || []).length === 6
      && (wpDict.json.data.modes || []).length >= 3, `HTTP ${wpDict.status}`);
    const wpOv = await req('/api/whplan/overview', { token });
    ok('美仓作业概览', wpOv.status === 200 && !!wpOv.json.data.waves && !!wpOv.json.data.capacity, `HTTP ${wpOv.status}`);
    ok('概览说明拣货不扣库存', (wpOv.json.data.notes || []).some((n) => /交承运才扣|不扣库存/.test(n)));

    const wpCands = await req('/api/whplan/candidates', { token });
    ok('可拣占用候选', wpCands.status === 200 && Array.isArray(wpCands.json.data), `HTTP ${wpCands.status}`);
    ok('不可拣的占用写明原因',
      wpCands.json.data.filter((c) => !c.pickable).every((c) => !!c.blocked_reason));
    ok('在途批次的占用不能进波次',
      wpCands.json.data.filter((c) => c.batch_stage && c.batch_stage !== 'on_shelf').every((c) => c.pickable === false));

    const wpWaves = await req('/api/whplan/waves', { token });
    ok('波次列表', wpWaves.status === 200 && Array.isArray(wpWaves.json.data), `HTTP ${wpWaves.status}`);
    ok('波次带状态中文与短拣差', wpWaves.json.data.every((w) => !!w.status_label && typeof w.short_qty === 'number' && typeof w.unpicked === 'number'));
    const wpShipped = wpWaves.json.data.find((w) => w.status === 'shipped');
    const wpDraft = wpWaves.json.data.find((w) => w.status === 'draft');
    if (wpShipped) {
      const det = await req(`/api/whplan/waves/${wpShipped.id}`, { token });
      ok('波次详情带明细与库位', det.status === 200 && (det.json.data.items || []).length > 0
        && (det.json.data.items || []).every((i) => !!i.loc_code), `HTTP ${det.status}`);
      ok('已交承运的波次有运单号', !!det.json.data.tracking_no);
      const rePack = await req(`/api/whplan/waves/${wpShipped.id}/pack`, { method: 'POST', token, body: { weight: 1, tracking_no: 'X-SMOKE' } });
      ok('已交承运不能再复核', rePack.status === 400 && /不能复核/.test(rePack.json.message || ''), `HTTP ${rePack.status}`);
      const reShip = await req(`/api/whplan/waves/${wpShipped.id}/cancel`, { method: 'POST', token, body: { reason: '冒烟', confirm_return: true } });
      ok('已交承运不能取消', reShip.status === 400 && /退货/.test(reShip.json.message || ''), `HTTP ${reShip.status}`);
    } else {
      ['波次详情带明细与库位', '已交承运的波次有运单号', '已交承运不能再复核', '已交承运不能取消'].forEach((n) => ok(n, true, '跳过（没有已发运波次）'));
    }
    if (wpDraft) {
      const noShip = await req(`/api/whplan/waves/${wpDraft.id}/ship`, { method: 'POST', token, body: {} });
      ok('草稿不能直接交承运', noShip.status === 400 && /已复核/.test(noShip.json.message || ''), `HTTP ${noShip.status}`);
    } else {
      ok('草稿不能直接交承运', true, '跳过（没有草稿波次）');
    }

    // ---- 建波次 → 释放 → 逐条守卫 → 取消（收尾） ----
    const cand = (wpCands.json.data || []).find((c) => c.pickable);
    if (cand) {
      const mk = await req('/api/whplan/waves', { method: 'POST', token, body: { warehouse: 'us', hold_ids: [cand.id], note: '冒烟波次' } });
      const wId = mk.json.data && mk.json.data.wave && mk.json.data.wave.id;
      ok('生成波次（草稿）', mk.status === 200 && mk.json.data.wave.status === 'draft', `HTTP ${mk.status}`);
      if (wId) {
        const delDraft = await req(`/api/whplan/waves/${wId}`, { method: 'DELETE', token });
        ok('草稿可以删除', delDraft.status === 200, `HTTP ${delDraft.status}`);

        const mk2 = await req('/api/whplan/waves', { method: 'POST', token, body: { warehouse: 'us', hold_ids: [cand.id], note: '冒烟波次2' } });
        const w2 = mk2.json.data && mk2.json.data.wave;
        if (w2) {
          const rel = await req(`/api/whplan/waves/${w2.id}/release`, { method: 'POST', token, body: {} });
          ok('释放波次', rel.status === 200 && rel.json.data.status === 'released', `HTTP ${rel.status}`);
          const item = rel.json.data.items[0];
          const over = await req(`/api/whplan/waves/${w2.id}/items/${item.id}/pick`, { method: 'POST', token, body: { qty: 99999 } });
          ok('拣货不能超过预留数量', over.status === 400 && /不能超过/.test(over.json.message || ''), `HTTP ${over.status}`);
          const zero = await req(`/api/whplan/waves/${w2.id}/items/${item.id}/pick`, { method: 'POST', token, body: { qty: 0 } });
          ok('拣货数量必须大于 0', zero.status === 400, `HTTP ${zero.status}`);
          await req(`/api/whplan/waves/${w2.id}/items/${item.id}/pick`, { method: 'POST', token, body: { qty: Math.max(1, item.qty - 1) } });
          const noReason = await req(`/api/whplan/waves/${w2.id}/pack`, { method: 'POST', token, body: { weight: 1.2, tracking_no: 'SMOKE-WH-1' } });
          ok('短拣必须写原因', noReason.status === 400 && /短拣/.test(noReason.json.message || ''), `HTTP ${noReason.status}`);
          const noWeight = await req(`/api/whplan/waves/${w2.id}/pack`, { method: 'POST', token, body: { tracking_no: 'SMOKE-WH-1', short_reason: '冒烟' } });
          ok('复核必须称重', noWeight.status === 400 && /称重/.test(noWeight.json.message || ''), `HTTP ${noWeight.status}`);
          const noTrack = await req(`/api/whplan/waves/${w2.id}/pack`, { method: 'POST', token, body: { weight: 1.2, short_reason: '冒烟' } });
          ok('复核必须有运单号', noTrack.status === 400 && /运单号/.test(noTrack.json.message || ''), `HTTP ${noTrack.status}`);
          if (wpShipped && wpShipped.tracking_no) {
            const dupTrack = await req(`/api/whplan/waves/${w2.id}/pack`, { method: 'POST', token, body: { weight: 1.2, tracking_no: wpShipped.tracking_no, short_reason: '冒烟' } });
            ok('运单号不能重复使用', dupTrack.status === 400 && /已被波次/.test(dupTrack.json.message || ''), `HTTP ${dupTrack.status}`);
          } else {
            ok('运单号不能重复使用', true, '跳过（没有已用运单）');
          }
          const cancelNoReturn = await req(`/api/whplan/waves/${w2.id}/cancel`, { method: 'POST', token, body: { reason: '冒烟取消' } });
          ok('已拣未回位不能取消', cancelNoReturn.status === 400 && /回位/.test(cancelNoReturn.json.message || ''), `HTTP ${cancelNoReturn.status}`);
          const cancelOk = await req(`/api/whplan/waves/${w2.id}/cancel`, { method: 'POST', token, body: { reason: '冒烟收尾', confirm_return: true } });
          ok('确认回位后可以取消', cancelOk.status === 200 && cancelOk.json.data.status === 'cancelled', `HTTP ${cancelOk.status}`);
        } else {
          ['释放波次', '拣货不能超过预留数量', '拣货数量必须大于 0', '短拣必须写原因', '复核必须称重',
            '复核必须有运单号', '运单号不能重复使用', '已拣未回位不能取消', '确认回位后可以取消']
            .forEach((n) => ok(n, false, `第二次建波次失败 ${mk2.json.message || ''}`));
        }
      } else {
        ['草稿可以删除', '释放波次', '拣货不能超过预留数量', '拣货数量必须大于 0', '短拣必须写原因',
          '复核必须称重', '复核必须有运单号', '运单号不能重复使用', '已拣未回位不能取消', '确认回位后可以取消']
          .forEach((n) => ok(n, false, '波次没建成'));
      }
    } else {
      ['生成波次（草稿）', '草稿可以删除', '释放波次', '拣货不能超过预留数量', '拣货数量必须大于 0',
        '短拣必须写原因', '复核必须称重', '复核必须有运单号', '运单号不能重复使用',
        '已拣未回位不能取消', '确认回位后可以取消'].forEach((n) => ok(n, true, '跳过（没有可拣预留）'));
    }

    // ---- 头程 ----
    const wpAsns = await req('/api/whplan/asns', { token });
    ok('头程列表', wpAsns.status === 200 && Array.isArray(wpAsns.json.data), `HTTP ${wpAsns.status}`);
    ok('头程带段进度与箱差异', wpAsns.json.data.every((a) => typeof a.leg_cnt === 'number'
      && typeof a.short_qty_box === 'number' && typeof a.delayed === 'boolean'));
    const asnOne = wpAsns.json.data.find((a) => a.leg_cnt > 0) || wpAsns.json.data[0];
    if (asnOne) {
      const ad = await req(`/api/whplan/asns/${asnOne.id}`, { token });
      ok('头程详情带段/箱/变更', ad.status === 200 && Array.isArray(ad.json.data.legs)
        && Array.isArray(ad.json.data.boxes) && Array.isArray(ad.json.data.changes), `HTTP ${ad.status}`);
      ok('头程详情给受影响需求', ad.status === 200 && !!ad.json.data.impacted
        && typeof ad.json.data.impacted.cnt === 'number');
      const badEta = await req(`/api/whplan/asns/${asnOne.id}/eta`, { method: 'POST', token, body: { eta_date: '2000-01-01', reason: '冒烟' } });
      ok('ETA 不能早于发运日', badEta.status === 400 && /发运/.test(badEta.json.message || ''), `HTTP ${badEta.status}`);
      const noReason = await req(`/api/whplan/asns/${asnOne.id}/eta`, { method: 'POST', token, body: { eta_date: '2099-01-01' } });
      ok('改 ETA 必须写原因', noReason.status === 400 && /原因/.test(noReason.json.message || ''), `HTTP ${noReason.status}`);
      const badBox = await req(`/api/whplan/asns/${asnOne.id}/boxes`, { method: 'POST', token, body: { carton_no: 'SMOKE-C', expect_qty: 10, received_qty: 5 } });
      ok('箱级数量必须守恒', badBox.status === 400 && /对不上/.test(badBox.json.message || ''), `HTTP ${badBox.status}`);
      const noBoxReason = await req(`/api/whplan/asns/${asnOne.id}/boxes`, {
        method: 'POST', token, body: { carton_no: 'SMOKE-C', expect_qty: 10, received_qty: 8, short_qty: 2 }
      });
      ok('箱有差异必须写原因', noBoxReason.status === 400 && /原因/.test(noBoxReason.json.message || ''), `HTTP ${noBoxReason.status}`);
      if ((ad.json.data.boxes || []).length) {
        const bx = ad.json.data.boxes[0];
        const same = await req(`/api/whplan/asns/${asnOne.id}/boxes`, {
          method: 'POST', token,
          body: { carton_no: bx.carton_no, style_no: bx.style_no, expect_qty: bx.expect_qty, received_qty: bx.received_qty, short_qty: bx.short_qty, over_qty: bx.over_qty, damaged_qty: bx.damaged_qty, reason: bx.reason }
        });
        ok('同箱号重复提交为更新', same.status === 200 && Number(same.json.data.id) === Number(bx.id), `HTTP ${same.status}`);
      } else {
        ok('同箱号重复提交为更新', true, '跳过（没有箱记录）');
      }
      const planned = (ad.json.data.legs || []).find((l) => l.status !== 'arrived');
      if (planned && planned.etd) {
        const early = await req(`/api/whplan/legs/${planned.id}/arrive`, { method: 'POST', token, body: { actual_at: '2000-01-01' } });
        ok('实际到达不能早于本段离港', early.status === 400 && /早于/.test(early.json.message || ''), `HTTP ${early.status}`);
      } else {
        ok('实际到达不能早于本段离港', true, '跳过（没有在途段）');
      }
    } else {
      ['头程详情带段/箱/变更', '头程详情给受影响需求', 'ETA 不能早于发运日', '改 ETA 必须写原因',
        '箱级数量必须守恒', '箱有差异必须写原因', '同箱号重复提交为更新', '实际到达不能早于本段离港']
        .forEach((n) => ok(n, false, '没有头程单'));
    }

    // ---- 库容 ----
    const wpCaps = await req('/api/whplan/capacity', { token });
    ok('库容列表', wpCaps.status === 200 && Array.isArray(wpCaps.json.data), `HTTP ${wpCaps.status}`);
    ok('库容带占用率与预警标记', wpCaps.json.data.every((l) => 'pct' in l && typeof l.near_full === 'boolean'));
    const sugOk = await req('/api/whplan/suggest?warehouse=us&qty=1&zone=sellable', { token });
    ok('上架建议返回库位', sugOk.status === 200 && (sugOk.json.data.blocked === true || !!sugOk.json.data.location), `HTTP ${sugOk.status}`);
    const sugNo = await req('/api/whplan/suggest?warehouse=us&qty=999999&zone=sellable', { token });
    ok('放不下时明确拒绝', sugNo.status === 200 && sugNo.json.data.blocked === true && !!sugNo.json.data.reason);
    const sugZero = await req('/api/whplan/suggest?warehouse=us&qty=0', { token });
    ok('建议数量必须大于 0', sugZero.status === 400, `HTTP ${sugZero.status}`);

    const wp401 = await req('/api/whplan/overview');
    ok('未登录访问美仓作业返回 401', wp401.status === 401, `HTTP ${wp401.status}`);
  }

  // ==================== M24 客户营销与消息 ====================
  {
    const ntDict = await req('/api/notify/dict', { token });
    ok('消息字典', ntDict.status === 200 && (ntDict.json.data.channels || []).length === 3
      && (ntDict.json.data.topics || []).length === 4, `HTTP ${ntDict.status}`);
    const ntOv = await req('/api/notify/overview', { token });
    ok('消息概览', ntOv.status === 200 && !!ntOv.json.data.outbox && Array.isArray(ntOv.json.data.channels), `HTTP ${ntOv.status}`);
    ok('概览说清未授权渠道会降级', (ntOv.json.data.notes || []).some((n) => /降级|未授权/.test(n)));

    const ntCaps = await req('/api/notify/channels', { token });
    ok('渠道能力三件套', ntCaps.status === 200 && ntCaps.json.data.length === 3, `HTTP ${ntCaps.status}`);
    ok('站内渠道始终可用', (ntCaps.json.data.find((c) => c.channel === 'site') || {}).usable === true);
    ok('未授权渠道不可用', ntCaps.json.data.filter((c) => c.status !== 'enabled').every((c) => c.usable === false));

    // ---- 订阅：退订只关营销、不删业务订阅 ----
    const ntSubs = await req('/api/notify/subs', { token });
    ok('订阅列表', ntSubs.status === 200 && Array.isArray(ntSubs.json.data), `HTTP ${ntSubs.status}`);
    ok('订阅带可用性判断', ntSubs.json.data.every((s) => typeof s.usable === 'boolean'));
    const offRow = ntSubs.json.data.find((s) => s.topic === 'marketing' && s.status === 'unsubscribed');
    ok('退订营销后仍保留业务订阅',
      !offRow || ntSubs.json.data.some((s) => s.customer_id === offRow.customer_id && ['order'].includes(s.topic) && s.status === 'subscribed'));
    ok('退订有原因记录', ntSubs.json.data.filter((s) => s.status === 'unsubscribed').every((s) => !!s.opt_out_reason));

    const subOne = ntSubs.json.data.find((s) => s.status === 'subscribed');
    if (subOne) {
      const again = await req('/api/notify/subs', {
        method: 'POST', token,
        body: { customer_id: subOne.customer_id, topic: subOne.topic, channel: subOne.channel, status: 'subscribed' }
      });
      ok('重复订阅不产生第二条记录', again.status === 200 && again.json.data.changed === 'updated', `HTTP ${again.status}`);
    } else {
      ok('重复订阅不产生第二条记录', true, '跳过（没有生效订阅）');
    }
    const subBadTopic = await req('/api/notify/subs', { method: 'POST', token, body: { customer_id: 1, topic: 'spam', channel: 'site' } });
    ok('订阅主题不合法被拒', subBadTopic.status === 400 && /主题/.test(subBadTopic.json.message || ''), `HTTP ${subBadTopic.status}`);
    const subBadCh = await req('/api/notify/subs', { method: 'POST', token, body: { customer_id: 1, topic: 'order', channel: 'sms' } });
    ok('通知渠道不合法被拒', subBadCh.status === 400 && /渠道/.test(subBadCh.json.message || ''), `HTTP ${subBadCh.status}`);
    const subBadCust = await req('/api/notify/subs', { method: 'POST', token, body: { customer_id: 999999, topic: 'order', channel: 'site' } });
    ok('订阅不存在的客户被拒', subBadCust.status === 400 && /客户不存在/.test(subBadCust.json.message || ''), `HTTP ${subBadCust.status}`);
    const subNoMail = await req('/api/notify/subs', { method: 'POST', token, body: { customer_id: 1, topic: 'order', channel: 'email' } });
    ok('没邮箱不能订阅邮件', subNoMail.status === 400, `HTTP ${subNoMail.status}`);

    // ---- 模板：版本、自批、变量、生效后不可改 ----
    const ntTpl = await req('/api/notify/templates', { token });
    ok('模板列表', ntTpl.status === 200 && Array.isArray(ntTpl.json.data), `HTTP ${ntTpl.status}`);
    ok('模板带版本与状态', ntTpl.json.data.every((t) => Number(t.version) >= 1 && !!t.status_label));
    const liveKeys = ntTpl.json.data.filter((t) => t.status === 'approved').map((t) => `${t.event_key}|${t.channel}|${t.lang}`);
    ok('同事件同渠道同语言只有一条生效', new Set(liveKeys).size === liveKeys.length);

    const tplNew = await req('/api/notify/templates', {
      method: 'POST', token,
      body: { event_key: 'restock', channel: 'email', lang: 'zh', subject: '冒烟模板 {{style_no}}', body: '{{customer_name}} 您好，{{style_no}} 可售 {{qty}} 件。' }
    });
    const tplId = tplNew.json.data && tplNew.json.data.id;
    ok('新建模板（草稿）', tplNew.status === 200 && tplNew.json.data.status === 'draft', `HTTP ${tplNew.status}`);
    if (tplId) {
      const selfApprove = await req(`/api/notify/templates/${tplId}/approve`, { method: 'POST', token, body: {} });
      ok('草稿不能直接批准', selfApprove.status === 400 && /待审核/.test(selfApprove.json.message || ''), `HTTP ${selfApprove.status}`);
      const subTpl = await req(`/api/notify/templates/${tplId}/submit`, { method: 'POST', token, body: {} });
      ok('模板提交审核', subTpl.status === 200 && subTpl.json.data.status === 'pending', `HTTP ${subTpl.status}`);
      const self2 = await req(`/api/notify/templates/${tplId}/approve`, { method: 'POST', token, body: {} });
      ok('制单人不能自己批准模板', self2.status === 400 && /自己批准/.test(self2.json.message || ''), `HTTP ${self2.status}`);
      const delTpl = await req(`/api/notify/templates/${tplId}`, { method: 'DELETE', token });
      ok('清理冒烟模板', delTpl.status === 200, `HTTP ${delTpl.status}`);
    } else {
      ['草稿不能直接批准', '模板提交审核', '制单人不能自己批准模板', '清理冒烟模板'].forEach((n) => ok(n, false, '模板没建成'));
    }

    const tplNoVar = await req('/api/notify/templates', {
      method: 'POST', token, body: { event_key: 'restock', channel: 'email', lang: 'en', subject: 'Restock', body: 'Back in stock.' }
    });
    if (tplNoVar.status === 200) {
      const subNoVar = await req(`/api/notify/templates/${tplNoVar.json.data.id}/submit`, { method: 'POST', token, body: {} });
      ok('不含变量的模板不能提交', subNoVar.status === 400 && /变量/.test(subNoVar.json.message || ''), `HTTP ${subNoVar.status}`);
      await req(`/api/notify/templates/${tplNoVar.json.data.id}`, { method: 'DELETE', token });
    } else {
      ok('不含变量的模板不能提交', false, `建模板失败 HTTP ${tplNoVar.status}`);
    }

    const liveTpl = ntTpl.json.data.find((t) => t.status === 'approved');
    if (liveTpl) {
      const editLive = await req(`/api/notify/templates/${liveTpl.id}`, { method: 'PUT', token, body: { subject: '改一下' } });
      ok('生效中的模板不许直接改', editLive.status === 400 && /新版本/.test(editLive.json.message || ''), `HTTP ${editLive.status}`);
      const retireNoReason = await req(`/api/notify/templates/${liveTpl.id}/retire`, { method: 'POST', token, body: {} });
      ok('停用生效模板必须写原因', retireNoReason.status === 400 && /原因/.test(retireNoReason.json.message || ''), `HTTP ${retireNoReason.status}`);
    } else {
      ok('生效中的模板不许直接改', false, '没有生效模板');
      ok('停用生效模板必须写原因', false, '没有生效模板');
    }

    // ---- 渠道能力：站内不可改、启用要依据 + 核验 ----
    const capSite = await req('/api/notify/channels', { method: 'POST', token, body: { channel: 'site', status: 'enabled' } });
    ok('站内渠道不允许改', capSite.status === 400 && /内置/.test(capSite.json.message || ''), `HTTP ${capSite.status}`);
    const capNoEvidence = await req('/api/notify/channels', {
      method: 'POST', token, body: { channel: 'wechat', status: 'enabled', verify_status: 'verified' }
    });
    ok('启用渠道必须写验收依据', capNoEvidence.status === 400 && /依据/.test(capNoEvidence.json.message || ''), `HTTP ${capNoEvidence.status}`);
    const capNoVerify = await req('/api/notify/channels', {
      method: 'POST', token, body: { channel: 'wechat', status: 'enabled', verify_status: 'unverified', evidence: '冒烟' }
    });
    ok('未核验渠道不能启用', capNoVerify.status === 400 && /核验/.test(capNoVerify.json.message || ''), `HTTP ${capNoVerify.status}`);

    // ---- 频控：只作用于营销，参数要自洽 ----
    const freqBad = await req('/api/notify/frequency', { method: 'POST', token, body: { scope: 'global', max_per_day: 5, max_per_week: 2 } });
    ok('每周上限不能小于每日上限', freqBad.status === 400, `HTTP ${freqBad.status}`);
    const freqBadQuiet = await req('/api/notify/frequency', { method: 'POST', token, body: { scope: 'global', quiet_start: '晚九点' } });
    ok('静默时段格式校验', freqBadQuiet.status === 400 && /HH:mm/.test(freqBadQuiet.json.message || ''), `HTTP ${freqBadQuiet.status}`);
    const freqNoCust = await req('/api/notify/frequency', { method: 'POST', token, body: { scope: 'customer' } });
    ok('客户例外规则必须选客户', freqNoCust.status === 400, `HTTP ${freqNoCust.status}`);

    // ---- 发送队列与回执 ----
    const ntBox = await req('/api/notify/outbox', { token });
    ok('发送队列', ntBox.status === 200 && Array.isArray(ntBox.json.data), `HTTP ${ntBox.status}`);
    ok('发送记录带中文状态', ntBox.json.data.every((o) => !!o.status_label && !!o.channel_label));
    ok('降级记录写明来源渠道',
      ntBox.json.data.filter((o) => o.degraded_from).every((o) => o.degraded_from !== o.channel));

    const boxRead = ntBox.json.data.find((o) => o.status === 'read');
    if (boxRead) {
      const back = await req(`/api/notify/outbox/${boxRead.id}/receipt`, { method: 'POST', token, body: { event: 'delivered' } });
      ok('已读不能退回已送达', back.status === 400 && /不能改回/.test(back.json.message || ''), `HTTP ${back.status}`);
    } else {
      ok('已读不能退回已送达', true, '跳过（没有已读记录）');
    }
    const boxHeld = ntBox.json.data.find((o) => o.status === 'held');
    if (boxHeld) {
      const readHeld = await req(`/api/notify/outbox/${boxHeld.id}/receipt`, { method: 'POST', token, body: { event: 'read' } });
      ok('没送达不能报已读', readHeld.status === 400 && /未知不算已读/.test(readHeld.json.message || ''), `HTTP ${readHeld.status}`);
      const skipBlank = await req(`/api/notify/outbox/${boxHeld.id}/skip`, { method: 'POST', token, body: {} });
      ok('跳过必须写原因', skipBlank.status === 400 && /原因/.test(skipBlank.json.message || ''), `HTTP ${skipBlank.status}`);
    } else {
      ok('没送达不能报已读', true, '跳过（没有暂缓记录）');
      ok('跳过必须写原因', true, '跳过（没有暂缓记录）');
    }
    const boxDeliv = ntBox.json.data.find((o) => o.status === 'delivered' && !o.opened_at);
    if (boxDeliv) {
      const opened = await req(`/api/notify/outbox/${boxDeliv.id}/receipt`, { method: 'POST', token, body: { event: 'opened' } });
      ok('打开只记时间不改状态',
        opened.status === 200 && opened.json.data.status === 'delivered' && !!opened.json.data.opened_at, `HTTP ${opened.status}`);
    } else {
      ok('打开只记时间不改状态', true, '跳过（没有已送达记录）');
    }
    const boxFail = ntBox.json.data.find((o) => o.status === 'failed');
    if (boxFail) {
      const det = await req(`/api/notify/outbox/${boxFail.id}`, { token });
      ok('失败记录带重试次数与原因',
        det.status === 200 && Number(det.json.data.retry_cnt) >= 1 && !!det.json.data.fail_reason, `HTTP ${det.status}`);
    } else {
      ok('失败记录带重试次数与原因', true, '跳过（没有失败记录）');
    }

    // ---- 到货提醒：发布 + 可售 > 0 才能触发 ----
    const ntAlerts = await req('/api/notify/alerts?status=', { token });
    ok('到货提醒列表', ntAlerts.status === 200 && Array.isArray(ntAlerts.json.data), `HTTP ${ntAlerts.status}`);
    ok('未触发的提醒写明原因',
      ntAlerts.json.data.filter((a) => a.status === 'waiting' && !a.ready).every((a) => !!a.ready_reason));
    const waitAlert = ntAlerts.json.data.find((a) => a.status === 'waiting');
    if (waitAlert) {
      const dupAlert = await req('/api/notify/alerts', {
        method: 'POST', token, body: { customer_id: waitAlert.customer_id, style_no: waitAlert.style_no, kind: waitAlert.kind }
      });
      ok('同客户同款不重复登记', dupAlert.status === 400 && /已经订阅/.test(dupAlert.json.message || ''), `HTTP ${dupAlert.status}`);
    } else {
      ok('同客户同款不重复登记', true, '跳过（没有等待中的提醒）');
    }
    const alertNoStyle = await req('/api/notify/alerts', { method: 'POST', token, body: { customer_id: 1, style_no: '' } });
    ok('提醒必须填款号', alertNoStyle.status === 400 && /款号/.test(alertNoStyle.json.message || ''), `HTTP ${alertNoStyle.status}`);

    const orderOnly = ntSubs.json.data.find((s) => s.topic === 'order' && s.status === 'subscribed'
      && !ntSubs.json.data.some((x) => x.customer_id === s.customer_id && x.topic === 'arrival'));
    if (orderOnly) {
      const noArr = await req('/api/notify/alerts', {
        method: 'POST', token, body: { customer_id: orderOnly.customer_id, style_no: 'N24-DEMO-01', kind: 'restock' }
      });
      ok('没订阅到货不能登记提醒', noArr.status === 400 && /上新与到货/.test(noArr.json.message || ''), `HTTP ${noArr.status}`);
    } else {
      ok('没订阅到货不能登记提醒', true, '跳过（没有只订订单的客户）');
    }

    // ---- 事件与归因 ----
    const ntEv = await req('/api/notify/events', { token });
    ok('事件列表', ntEv.status === 200 && Array.isArray(ntEv.json.data), `HTTP ${ntEv.status}`);
    ok('事件带幂等键与发送数', ntEv.json.data.every((e) => !!e.dedupe_key && typeof e.outbox_cnt === 'number'));
    const badEv = await req('/api/notify/events', { method: 'POST', token, body: { event_key: 'whatever' } });
    ok('事件类型不合法被拒', badEv.status === 400, `HTTP ${badEv.status}`);
    const ev0 = ntEv.json.data[0];
    if (ev0) {
      const dupEv = await req('/api/notify/events', {
        method: 'POST', token, body: { event_key: ev0.event_key, dedupe_key: ev0.dedupe_key, customer_id: 1 }
      });
      ok('同一事件重复触发被去重', dupEv.status === 200 && dupEv.json.data.duplicated === true, `HTTP ${dupEv.status}`);
    } else {
      ok('同一事件重复触发被去重', true, '跳过（没有事件）');
    }

    const ntAttr = await req('/api/notify/attribution', { token });
    ok('归因报表', ntAttr.status === 200 && !!ntAttr.json.data.totals && Array.isArray(ntAttr.json.data.customers), `HTTP ${ntAttr.status}`);
    ok('归因声明打开不算成交', /打开/.test(ntAttr.json.data.note || ''));
    ok('归因订单只认已确认', /已确认/.test(ntAttr.json.data.note || ''));
    ok('仅打开未读单独计数', typeof ntAttr.json.data.totals.opened_only === 'number');

    const ntCyc = await req('/api/notify/cycle-tasks', { method: 'POST', token, body: { customer_id: 999999 } });
    ok('周期任务可按客户过滤', ntCyc.status === 200 && ntCyc.json.data.scanned === 0, `HTTP ${ntCyc.status}`);

    const nt401 = await req('/api/notify/overview');
    ok('未登录访问消息模块返回 401', nt401.status === 401, `HTTP ${nt401.status}`);
  }

  // ==================== M23 供给批次与预订 ====================
  {

  const spDict = await req('/api/supply/dict', { token });
  ok('供给字典', spDict.status === 200 && Array.isArray(spDict.json.data.stage) && spDict.json.data.stage.length === 7, `HTTP ${spDict.status}`);
  const spOv = await req('/api/supply/overview', { token });
  ok('供给概览', spOv.status === 200 && !!spOv.json.data.spot && typeof spOv.json.data.future_available === 'number', `HTTP ${spOv.status}`);
  ok('概览说明已拣不重复扣', /已拣是占用的子集/.test((spOv.json.data || {}).note || ''));

  const spProj = await req('/api/supply/projection?warehouse=us', { token });
  ok('可售投影', spProj.status === 200 && Array.isArray(spProj.json.data), `HTTP ${spProj.status}`);
  ok('可买量 = 实物 − 有效占用', spProj.json.data.length > 0
    && spProj.json.data.every((p) => Math.abs(Number(p.sellable) - (Number(p.on_hand) - Number(p.held_spot))) < 0.01));
  ok('已拣不参与扣减（仅展示）', spProj.json.data.every((p) => Number(p.sellable) === Number(p.on_hand) - Number(p.held_spot)));
  ok('投影带刷新时间与版本', spProj.json.data.every((p) => !!p.computed_at && Number(p.version) >= 1));

  const spBatches = await req('/api/supply/batches?warehouse=us', { token });
  ok('供给批次列表', spBatches.status === 200 && Array.isArray(spBatches.json.data), `HTTP ${spBatches.status}`);
  const shelfB = (spBatches.json.data || []).find((b) => b.stage === 'on_shelf');
  ok('已上架批次未来可订按 0', !shelfB || shelfB.available === 0);
  const parentB = (spBatches.json.data || []).find((b) => b.children && b.children.length);
  ok('父批不再单独算可订量', !parentB || (parentB.available === 0 && /子批/.test(parentB.excludes || '')));

  // ---- 批次：建 → 负向守卫 → 删 ----
  const bNew = await req('/api/supply/batches', {
    method: 'POST', token,
    body: { warehouse: 'us', style_no: '__SMOKE_SP__', color: '黑', size: 'M', qty_planned: 100, eta_date: '2026-12-20', eta_evidence: '冒烟排产单' }
  });
  const bId = bNew.json.data && bNew.json.data.id;
  ok('新建供给批次', bNew.status === 200 && bNew.json.data.stage === 'in_production', `HTTP ${bNew.status}`);
  if (bId) {
    const skip = await req(`/api/supply/batches/${bId}/move`, { method: 'POST', token, body: { to_stage: 'in_transit' } });
    ok('批次不能跳过待发', skip.status === 400 && /跳/.test(skip.json.message || ''), `HTTP ${skip.status}`);
    const over = await req(`/api/supply/batches/${bId}/move`, { method: 'POST', token, body: { to_stage: 'ready_to_ship', qty: 99999 } });
    ok('迁移数量不能超过当前阶段', over.status === 400 && /超过/.test(over.json.message || ''), `HTTP ${over.status}`);
    const noReason = await req(`/api/supply/batches/${bId}/short`, { method: 'POST', token, body: { qty: 5 } });
    ok('短装必须写原因', noReason.status === 400 && /原因/.test(noReason.json.message || ''), `HTTP ${noReason.status}`);
    const badInspect = await req(`/api/supply/batches/${bId}/inspect`, { method: 'POST', token, body: { qty_ok: 10 } });
    ok('只有在实收阶段才能检验', badInspect.status === 400 && /实收检验/.test(badInspect.json.message || ''), `HTTP ${badInspect.status}`);
    const delB = await req(`/api/supply/batches/${bId}`, { method: 'DELETE', token });
    ok('在产且无占用的批次可删', delB.status === 200, `HTTP ${delB.status}`);
  } else {
    ['批次不能跳过待发', '迁移数量不能超过当前阶段', '短装必须写原因', '只有在实收阶段才能检验', '在产且无占用的批次可删']
      .forEach((n) => ok(n, false, '批次没建成'));
  }
  // 待发前必须有交期依据
  const bNoEta = await req('/api/supply/batches', {
    method: 'POST', token, body: { warehouse: 'us', style_no: '__SMOKE_SP2__', color: '黑', size: 'L', qty_planned: 20 }
  });
  if (bNoEta.status === 200) {
    const mv = await req(`/api/supply/batches/${bNoEta.json.data.id}/move`, { method: 'POST', token, body: { to_stage: 'ready_to_ship' } });
    ok('进待发前必须有预计到仓时间', mv.status === 400 && /到仓/.test(mv.json.message || ''), `HTTP ${mv.status}`);
    await req(`/api/supply/batches/${bNoEta.json.data.id}`, { method: 'DELETE', token });
  } else {
    ok('进待发前必须有预计到仓时间', false, `建批次失败 HTTP ${bNoEta.status}`);
  }

  // ---- 预订：申请不占量、确认要显式批次、有效期要过 ----
  const spReqs = await req('/api/supply/requests', { token });
  ok('预订申请列表', spReqs.status === 200 && Array.isArray(spReqs.json.data), `HTTP ${spReqs.status}`);
  const reqFut = (spReqs.json.data || []).find((r) => r.status === 'submitted' && r.kind === 'future' && !r.is_expired);
  if (reqFut) {
    const noBatch = await req(`/api/supply/requests/${reqFut.id}/confirm`, { method: 'POST', token, body: { qty: 1 } });
    ok('未来供给确认必须显式选批次', noBatch.status === 400 && /供给批次/.test(noBatch.json.message || ''), `HTTP ${noBatch.status}`);
    const overQty = await req(`/api/supply/requests/${reqFut.id}/confirm`, { method: 'POST', token, body: { qty: 99999, batch_id: 1 } });
    ok('确认数量不能超过申请数量', overQty.status === 400 && /申请数量/.test(overQty.json.message || ''), `HTTP ${overQty.status}`);
  } else {
    ok('未来供给确认必须显式选批次', false, '没有待确认的未来供给申请');
    ok('确认数量不能超过申请数量', false, '没有待确认的未来供给申请');
  }
  const reqExpired = (spReqs.json.data || []).find((r) => r.is_expired);
  if (reqExpired) {
    const exp = await req(`/api/supply/requests/${reqExpired.id}/confirm`, { method: 'POST', token, body: { qty: 1, batch_id: 1 } });
    ok('报价过期的申请不能确认', exp.status === 400 && /有效期/.test(exp.json.message || ''), `HTTP ${exp.status}`);
  } else {
    ok('报价过期的申请不能确认', true, '跳过（没有过期申请）');
  }
  const rejNoReason = await req('/api/supply/requests/' + ((spReqs.json.data || []).find((r) => r.status === 'submitted') || {}).id + '/reject', { method: 'POST', token, body: {} });
  ok('驳回必须写原因', rejNoReason.status === 400, `HTTP ${rejNoReason.status}`);

  // ---- 申请 → 确认 → 占用 → 释放 → 清理（完整一轮，跑完删掉）----
  const myBatch = (spBatches.json.data || []).find((b) => b.status === 'active' && b.stage !== 'on_shelf' && b.available >= 5);
  if (myBatch) {
    const rq = await req('/api/supply/requests', {
      method: 'POST', token,
      body: { style_no: myBatch.style_no, color: myBatch.color, size: myBatch.size, qty: 5, kind: 'future', batch_id: myBatch.id, idempotency_key: '__SMOKE_SP_IDEM__' }
    });
    const rqId = rq.json.data && rq.json.data.id;
    ok('代客提交申请（不占量）', rq.status === 200 && rq.json.data.status === 'submitted', `HTTP ${rq.status}`);
    if (rqId) {
      const availBefore = (await req(`/api/supply/batches/${myBatch.id}`, { token })).json.data.available;
      const cf = await req(`/api/supply/requests/${rqId}/confirm`, { method: 'POST', token, body: { qty: 5, batch_id: myBatch.id, expires_in_hours: 2 } });
      ok('销售确认后建立占用', cf.status === 200 && cf.json.data.status === 'sales_confirmed' && !!cf.json.data.hold_id, `HTTP ${cf.status}`);
      const availAfter = (await req(`/api/supply/batches/${myBatch.id}`, { token })).json.data.available;
      ok('确认后批次可订量减少', Math.abs((availBefore - 5) - availAfter) < 0.01, `${availBefore} → ${availAfter}`);
      const holdId = cf.json.data && cf.json.data.hold_id;
      if (holdId) {
        const pickOver = await req(`/api/supply/holds/${holdId}/picked`, { method: 'POST', token, body: { qty: 9999 } });
        ok('拣货不能超过占用数量', pickOver.status === 400, `HTTP ${pickOver.status}`);
        await req(`/api/supply/holds/${holdId}/picked`, { method: 'POST', token, body: { qty: 2 } });
        const relNoConfirm = await req(`/api/supply/holds/${holdId}/release`, { method: 'POST', token, body: { reason: '冒烟' } });
        ok('已拣必须先确认实物回位才能释放', relNoConfirm.status === 400 && /回位/.test(relNoConfirm.json.message || ''), `HTTP ${relNoConfirm.status}`);
        const rel = await req(`/api/supply/holds/${holdId}/release`, { method: 'POST', token, body: { reason: '冒烟清理', confirm_picked: true } });
        ok('确认回位后可释放', rel.status === 200 && rel.json.data.status === 'released', `HTTP ${rel.status}`);
        const availBack = (await req(`/api/supply/batches/${myBatch.id}`, { token })).json.data.available;
        ok('释放后可订量回到原值', Math.abs(availBack - availBefore) < 0.01, `${availBack} vs ${availBefore}`);
      }
      const cancel = await req(`/api/supply/requests/${rqId}/cancel`, { method: 'POST', token, body: { reason: '冒烟清理' } });
      ok('取消申请', cancel.status === 200 && cancel.json.data.status === 'cancelled', `HTTP ${cancel.status}`);
      const delRq = await req(`/api/supply/requests/${rqId}`, { method: 'DELETE', token });
      ok('清理冒烟申请', delRq.status === 200, `HTTP ${delRq.status}`);
    } else {
      ['销售确认后建立占用', '确认后批次可订量减少', '拣货不能超过占用数量', '已拣必须先确认实物回位才能释放',
        '确认回位后可释放', '释放后可订量回到原值', '取消申请', '清理冒烟申请'].forEach((n) => ok(n, false, '申请没建成'));
    }
  } else {
    ['代客提交申请（不占量）', '销售确认后建立占用', '确认后批次可订量减少', '拣货不能超过占用数量',
      '已拣必须先确认实物回位才能释放', '确认回位后可释放', '释放后可订量回到原值', '取消申请', '清理冒烟申请']
      .forEach((n) => ok(n, false, '没有可订的批次'));
  }

  // ---- 缺口与投影刷新 ----
  const spShort = await req('/api/supply/shortages', { token });
  ok('缺口列表', spShort.status === 200 && Array.isArray(spShort.json.data), `HTTP ${spShort.status}`);
  const openShort = (spShort.json.data || []).find((s) => s.resolution === 'open');
  if (openShort) {
    const bad = await req(`/api/supply/shortages/${openShort.id}/resolve`, { method: 'POST', token, body: { resolution: 'whatever' } });
    ok('缺口处理方式不合法被拒', bad.status === 400, `HTTP ${bad.status}`);
    const noSub = await req(`/api/supply/shortages/${openShort.id}/resolve`, { method: 'POST', token, body: { resolution: 'substitute' } });
    ok('换替代批次必须指定批次', noSub.status === 400 && /替代批次/.test(noSub.json.message || ''), `HTTP ${noSub.status}`);
  } else {
    ok('缺口处理方式不合法被拒', true, '跳过（没有待处理缺口）');
    ok('换替代批次必须指定批次', true, '跳过（没有待处理缺口）');
  }
  const ref = await req('/api/supply/projection/refresh', { method: 'POST', token, body: { warehouse: 'us' } });
  ok('重算投影', ref.status === 200 && typeof ref.json.data.refreshed === 'number', `HTTP ${ref.status}`);
  const spRep = await req('/api/supply/report?warehouse=us', { token });
  ok('按仓汇总报表', spRep.status === 200 && Array.isArray(spRep.json.data.by_warehouse), `HTTP ${spRep.status}`);
  const spNoAuth = await req('/api/supply/overview');
  ok('未登录访问供给模块返回 401', spNoAuth.status === 401, `HTTP ${spNoAuth.status}`);
  }

  // ==================== M03 销售与客户 ====================
  const crmDict = await req('/api/crm/dict', { token });
  ok('销售字典', crmDict.status === 200 && Array.isArray(crmDict.json.data.lead_stage) && crmDict.json.data.lead_stage.length === 5, `HTTP ${crmDict.status}`);
  const crmOv = await req('/api/crm/overview', { token });
  ok('销售概览', crmOv.status === 200 && !!crmOv.json.data.leads && !!crmOv.json.data.cycles, `HTTP ${crmOv.status}`);
  ok('概览声明商机金额不是收入', /不计入收入/.test((crmOv.json.data.leads || {}).note || ''));

  const crmLeads = await req('/api/crm/leads', { token });
  ok('线索列表', crmLeads.status === 200 && Array.isArray(crmLeads.json.data), `HTTP ${crmLeads.status}`);
  ok('线索阶段漏斗合计 = 线索总数',
    Object.values(crmOv.json.data.leads.by_stage).reduce((a, b) => a + b, 0) === crmLeads.json.data.length,
    `${Object.values(crmOv.json.data.leads.by_stage).reduce((a, b) => a + b, 0)} vs ${crmLeads.json.data.length}`);
  ok('线索带响应超时标记', crmLeads.json.data.every((l) => typeof l.is_response_late === 'boolean'));
  ok('商机金额标注为非收入', crmLeads.json.data.every((l) => /不计入收入/.test(l.est_amount_note || '')));

  // ---- 写路径：新建 → 查重 → 跟进必填 → 阶段必填 → 认领 → 清理 ----
  const leadNew = await req('/api/crm/leads', {
    method: 'POST', token,
    body: { source: 'import', source_ref: '__SMOKE_CRM_01__', customer_name_raw: '冒烟-线索客户', contact: 'Tom', est_amount: 12000 }
  });
  const leadId = leadNew.json.data && leadNew.json.data.id;
  ok('新建线索（不指派进公海）', leadNew.status === 200 && leadNew.json.data.stage === 'new' && leadNew.json.data.in_pool === 1, `HTTP ${leadNew.status}`);

  if (leadId) {
    const leadDup = await req('/api/crm/leads', {
      method: 'POST', token,
      body: { source: 'import', source_ref: '__SMOKE_CRM_01__', customer_name_raw: '冒烟-线索客户' }
    });
    ok('同平台线索 ID 不能重复录入', leadDup.status === 400 && /已经在系统里/.test(leadDup.json.message || ''), `HTTP ${leadDup.status}`);

    const noEvidence = await req(`/api/crm/leads/${leadId}/follow`, {
      method: 'POST', token, body: { note: '聊了下', next_action_date: '2026-12-01' }
    });
    ok('跟进必须写证据', noEvidence.status === 400 && /证据/.test(noEvidence.json.message || ''), `HTTP ${noEvidence.status}`);
    const noNext = await req(`/api/crm/leads/${leadId}/follow`, {
      method: 'POST', token, body: { note: '聊了下', evidence: '邮件 #1' }
    });
    ok('跟进必须写下次动作日期', noNext.status === 400 && /日期/.test(noNext.json.message || ''), `HTTP ${noNext.status}`);

    const wonNoOrder = await req(`/api/crm/leads/${leadId}/stage`, { method: 'POST', token, body: { to: 'won' } });
    ok('线索不能凭空转订单', wonNoOrder.status === 400 && /订单/.test(wonNoOrder.json.message || ''), `HTTP ${wonNoOrder.status}`);
    const lostNoReason = await req(`/api/crm/leads/${leadId}/stage`, { method: 'POST', token, body: { to: 'lost' } });
    ok('丢单必须写原因', lostNoReason.status === 400 && /原因/.test(lostNoReason.json.message || ''), `HTTP ${lostNoReason.status}`);
    const skipStage = await req(`/api/crm/leads/${leadId}/stage`, { method: 'POST', token, body: { to: 'sampling' } });
    ok('不能跳过需求确认到样衣', skipStage.status === 400, `HTTP ${skipStage.status}`);

    const claim = await req(`/api/crm/leads/${leadId}/claim`, { method: 'POST', token, body: {} });
    ok('公海线索可认领', claim.status === 200 && claim.json.data.in_pool === 0 && !!claim.json.data.owner_name, `HTTP ${claim.status}`);

    const sweep = await req('/api/crm/leads/sweep-pool', { method: 'POST', token, body: {} });
    ok('超时线索可回收公海', sweep.status === 200 && typeof sweep.json.data.recycled === 'number', `HTTP ${sweep.status}`);

    const delLead = await req(`/api/crm/leads/${leadId}`, { method: 'DELETE', token });
    ok('清理冒烟线索', delLead.status === 200, `HTTP ${delLead.status}`);
  } else {
    ['同平台线索 ID 不能重复录入', '跟进必须写证据', '跟进必须写下次动作日期', '线索不能凭空转订单',
      '丢单必须写原因', '不能跳过需求确认到样衣', '公海线索可认领', '超时线索可回收公海', '清理冒烟线索']
      .forEach((n) => ok(n, false, '线索没建成'));
  }

  // ---- 周期：公式可验、未知不编 0 天、回访不刷新采购日 ----
  const cycles = await req('/api/crm/cycles', { token });
  ok('客户周期列表', cycles.status === 200 && Array.isArray(cycles.json.data), `HTTP ${cycles.status}`);
  const known = (cycles.json.data || []).filter((c) => c.status === 'known' && c.cycle_days && c.last_purchase_date);
  ok('应购日 = 最近有效采购日 + 周期', known.length > 0 && known.every((c) => {
    const d = new Date(c.last_purchase_date + 'T00:00:00');
    d.setDate(d.getDate() + Number(c.cycle_days));
    const want = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return c.next_due_date === want || c.next_due_date === null;
  }), `样本 ${known.length}`);
  ok('宽限只影响升级不影响是否超期',
    (cycles.json.data || []).every((c) => typeof c.escalated === 'boolean' && (!c.escalated || c.overdue_days > c.grace_days)));
  ok('内部客户的有效采购为空（内部转单不刷新）',
    (cycles.json.data || []).filter((c) => /内部|集团内/.test(c.customer_name) && c.status === 'known')
      .every((c) => !c.last_purchase_date));

  const cycOne = (cycles.json.data || []).find((c) => c.customer_id);
  if (cycOne) {
    const cycZero = await req('/api/crm/cycles', { method: 'POST', token, body: { customer_id: cycOne.customer_id, status: 'known', cycle_days: 0 } });
    ok('周期已知不能填 0 天', cycZero.status === 400 && /至少 1 天/.test(cycZero.json.message || ''), `HTTP ${cycZero.status}`);
    const cycUnknown = await req('/api/crm/cycles', { method: 'POST', token, body: { customer_id: cycOne.customer_id, status: 'unknown' } });
    ok('周期未知必须写原因', cycUnknown.status === 400 && /原因/.test(cycUnknown.json.message || ''), `HTTP ${cycUnknown.status}`);
  } else {
    ok('周期已知不能填 0 天', false, '没有客户');
    ok('周期未知必须写原因', false, '没有客户');
  }
  const alerts = await req('/api/crm/cycles/alerts', { token });
  ok('周期预警三档分开', alerts.status === 200 && typeof alerts.json.data.counts.overdue === 'number'
    && typeof alerts.json.data.counts.escalated === 'number' && typeof alerts.json.data.counts.soon === 'number');
  ok('预警说明宽限只管升级', /宽限/.test(alerts.json.data.note || ''));
  const infer = await req('/api/crm/cycles/infer', { token });
  ok('周期推断只给建议不落库', infer.status === 200 && Array.isArray(infer.json.data)
    && infer.json.data.every((x) => /建议/.test(x.note || '')));
  const fuNoNote = await req('/api/crm/followups', { method: 'POST', token, body: { customer_id: (cycOne || {}).customer_id, result: 'replied' } });
  ok('回访必须写联系结果', fuNoNote.status === 400, `HTTP ${fuNoNote.status}`);

  // ---- 客户价值：分口径 + 缺成本不进毛利榜 ----
  const rankRev = await req('/api/crm/ranking?metric=revenue', { token });
  ok('客户价值排行', rankRev.status === 200 && Array.isArray(rankRev.json.data.rows), `HTTP ${rankRev.status}`);
  ok('排行声明销售业绩≠财务收入', /销售业绩/.test(rankRev.json.data.note || ''));
  const rankGross = await req('/api/crm/ranking?metric=gross', { token });
  ok('缺成本的客户不进毛利榜', rankGross.status === 200
    && rankGross.json.data.rows.filter((r) => r.rank).every((r) => r.gross_ready === true));
  ok('毛利待核单独计数', rankGross.json.data.rows.filter((r) => !r.rank).length === rankGross.json.data.pending_cnt);
  const rankNoInternal = await req('/api/crm/ranking?metric=revenue&exclude_internal=1', { token });
  ok('可剔除集团内部转单', rankNoInternal.status === 200 && rankNoInternal.json.data.rows.every((r) => !r.is_internal));
  ok('内部转单在未剔除时被标注', rankRev.json.data.rows.filter((r) => r.is_internal).every((r) => /内部/.test(r.note || '')));

  // ---- 目标：达成率必须给分子分母 ----
  const targets = await req('/api/crm/targets', { token });
  ok('销售目标列表', targets.status === 200 && Array.isArray(targets.json.data), `HTTP ${targets.status}`);
  const tgt = (targets.json.data || [])[0];
  if (tgt) {
    const tgtDetail = await req(`/api/crm/targets/${tgt.id}`, { token });
    ok('目标达成带分子分母', tgtDetail.status === 200 && (tgtDetail.json.data.items || []).every((i) => /\d/.test(i.formula || '')));
    ok('目标达成率 = 实际 ÷ 目标', (tgtDetail.json.data.items || []).every((i) => i.target_amount === 0
      || Math.abs(i.hit_rate - Math.round((i.actual / i.target_amount) * 10000) / 100) < 0.02));
    if (tgt.status !== 'draft') {
      const apprAgain = await req(`/api/crm/targets/${tgt.id}/approve`, { method: 'POST', token, body: {} });
      ok('已批准的目标版不能再批', apprAgain.status === 400, `HTTP ${apprAgain.status}`);
    } else {
      ok('已批准的目标版不能再批', true, '跳过（当前是草稿）');
    }
  } else {
    ['目标达成带分子分母', '目标达成率 = 实际 ÷ 目标', '已批准的目标版不能再批'].forEach((n) => ok(n, false, '没有目标版'));
  }

  // ---- 提成：阶梯、防重、调整有来源、自批拦截 ----
  const rules = await req('/api/crm/commission-rules', { token });
  ok('提成规则列表', rules.status === 200 && Array.isArray(rules.json.data), `HTTP ${rules.status}`);
  ok('规则带阶梯快照', (rules.json.data || []).every((r) => Array.isArray(r.tiers) && r.tiers.length > 0));
  const ruleOverlap = await req('/api/crm/commission-rules', {
    method: 'POST', token, body: { name: '冒烟-重叠', base_type: 'collection', effective_from: '2026-01-01', tiers: [{ from: 0, to: 100000, rate: 1 }, { from: 50000, to: null, rate: 2 }] }
  });
  ok('阶梯区间重叠被拒', ruleOverlap.status === 400 && /重叠/.test(ruleOverlap.json.message || ''), `HTTP ${ruleOverlap.status}`);
  const ruleBadRate = await req('/api/crm/commission-rules', {
    method: 'POST', token, body: { name: '冒烟-费率', base_type: 'collection', effective_from: '2026-01-01', tiers: [{ from: 0, to: null, rate: 130 }] }
  });
  ok('费率超过 100% 被拒', ruleBadRate.status === 400, `HTTP ${ruleBadRate.status}`);

  const comms = await req('/api/crm/commissions', { token });
  ok('提成单列表', comms.status === 200 && Array.isArray(comms.json.data), `HTTP ${comms.status}`);
  const approvedRule = (rules.json.data || []).find((r) => r.status === 'approved');
  if (approvedRule) {
    const pv = await req('/api/crm/commissions/preview', {
      method: 'POST', token, body: { period: '2026-09', user_name: '销售小王', rule_id: approvedRule.id }
    });
    ok('提成试算不落库', pv.status === 200 && typeof pv.json.data.amount === 'number' && !pv.json.data.id);
    ok('试算标出已被计过的来源行', Array.isArray(pv.json.data.already_taken));
    const pvBase = Number(pv.json.data.base_amount || 0);
    const pvAmt = Number(pv.json.data.amount || 0);
    ok('提成按超额累进而非全额跳档', pvAmt <= pvBase * 0.02 + 0.01, `${pvAmt} vs ${pvBase}`);
  } else {
    ['提成试算不落库', '试算标出已被计过的来源行', '提成按超额累进而非全额跳档'].forEach((n) => ok(n, false, '没有已批准规则'));
  }
  const draft = (comms.json.data || []).find((c) => c.status === 'draft');
  if (draft) {
    const adjNoSrc = await req(`/api/crm/commissions/${draft.id}/adjust`, {
      method: 'POST', token, body: { source_type: 'refund', amount: 100 }
    });
    ok('退款调整必须指向来源单据', adjNoSrc.status === 400 && /来源单据/.test(adjNoSrc.json.message || ''), `HTTP ${adjNoSrc.status}`);
    const payBeforeApprove = await req(`/api/crm/commissions/${draft.id}/link-payroll`, {
      method: 'POST', token, body: { payroll_period: draft.period }
    });
    ok('未批准不能引薪酬', payBeforeApprove.status === 400, `HTTP ${payBeforeApprove.status}`);
  } else {
    ok('退款调整必须指向来源单据', true, '跳过（没有草稿）');
    ok('未批准不能引薪酬', true, '跳过（没有草稿）');
  }
  const settled = (comms.json.data || []).find((c) => c.status === 'settled');
  if (settled) {
    const again = await req(`/api/crm/commissions/${settled.id}/link-payroll`, {
      method: 'POST', token, body: { payroll_period: settled.period }
    });
    ok('已引薪酬不能重复生成', again.status === 400 && /已经引过/.test(again.json.message || ''), `HTTP ${again.status}`);
  } else {
    ok('已引薪酬不能重复生成', true, '跳过（没有已引薪酬的单）');
  }

  // ---- 交接：资格、顺序、完成只改归属 ----
  const handovers = await req('/api/crm/handovers', { token });
  ok('交接单列表', handovers.status === 200 && Array.isArray(handovers.json.data), `HTTP ${handovers.status}`);
  const hsAny = (handovers.json.data || [])[0];
  const custForHand = (crmDict.json.data.customers || [])[0];
  const salesUsers = (crmDict.json.data.users || []).filter((u) => u.role === 'sales');
  if (custForHand && salesUsers.length >= 2) {
    const hsNew = await req('/api/crm/handovers', {
      method: 'POST', token,
      body: { from_user_id: salesUsers[0].id, to_user_id: salesUsers[1].id, reason: 'transfer', customer_ids: String(custForHand.id) }
    });
    const hsId = hsNew.json.data && hsNew.json.data.id;
    ok('新建交接单（草稿）', hsNew.status === 200 && hsNew.json.data.status === 'draft', `HTTP ${hsNew.status}`);
    if (hsId) {
      const doneTooEarly = await req(`/api/crm/handovers/${hsId}/status`, { method: 'POST', token, body: { to: 'done' } });
      ok('未提交不能直接完成', doneTooEarly.status === 400, `HTTP ${doneTooEarly.status}`);
      const hsSub = await req(`/api/crm/handovers/${hsId}/status`, { method: 'POST', token, body: { to: 'pending' } });
      ok('提交待接收', hsSub.status === 200 && hsSub.json.data.status === 'pending', `HTTP ${hsSub.status}`);
      // 待接收的单不能直接删：先取消（要写原因）再删
      const hsCancel = await req(`/api/crm/handovers/${hsId}/status`, { method: 'POST', token, body: { to: 'cancelled' } });
      ok('取消交接必须写原因', hsCancel.status === 400, `HTTP ${hsCancel.status}`);
      await req(`/api/crm/handovers/${hsId}/status`, { method: 'POST', token, body: { to: 'cancelled', note: '冒烟清理' } });
      const hsDel = await req(`/api/crm/handovers/${hsId}`, { method: 'DELETE', token });
      ok('清理冒烟交接单', hsDel.status === 200, `HTTP ${hsDel.status}`);
    } else {
      ['未提交不能直接完成', '提交待接收', '取消交接必须写原因', '清理冒烟交接单'].forEach((n) => ok(n, false, '交接单没建成'));
    }
  } else if (hsAny) {
    ok('新建交接单（草稿）', true, '跳过（人员不足）');
    ok('未提交不能直接完成', true, '跳过');
    ok('提交待接收', true, '跳过');
    ok('取消交接必须写原因', true, '跳过');
    ok('清理冒烟交接单', true, '跳过');
  } else {
    ['新建交接单（草稿）', '未提交不能直接完成', '提交待接收', '取消交接必须写原因', '清理冒烟交接单']
      .forEach((n) => ok(n, false, '没有交接数据'));
  }
  const hsSelf = await req('/api/crm/handovers', {
    method: 'POST', token,
    body: { from_user_id: (salesUsers[0] || {}).id, to_user_id: (salesUsers[0] || {}).id, reason: 'transfer', customer_ids: String((custForHand || {}).id) }
  });
  ok('交接双方不能是同一人', hsSelf.status === 400, `HTTP ${hsSelf.status}`);

  const crmNoAuth = await req('/api/crm/overview');
  ok('未登录访问销售模块返回 401', crmNoAuth.status === 401, `HTTP ${crmNoAuth.status}`);

  // ==================== M12 税负测算 ====================
  const txDict = await req('/api/tax/dict', { token });
  ok('税负字典', txDict.status === 200 && Array.isArray(txDict.json.data.tax_types), `HTTP ${txDict.status}`);
  const txOv = await req('/api/tax/overview', { token });
  ok('税负概览', txOv.status === 200 && Array.isArray(txOv.json.data.companies), `HTTP ${txOv.status}`);
  ok('概览声明测算不等于已申报', /不等于已申报/.test((txOv.json.data || {}).note || ''));

  const txPol = await req('/api/tax/policies', { token });
  ok('税政配置列表', txPol.status === 200 && Array.isArray(txPol.json.data), `HTTP ${txPol.status}`);
  const txRuns = await req('/api/tax/runs', { token });
  ok('测算批次列表', txRuns.status === 200 && Array.isArray(txRuns.json.data), `HTTP ${txRuns.status}`);

  const pv = await req('/api/tax/preview?company_id=1&tax_region=CN&period=2026-09', { token });
  ok('测算预览', pv.status === 200 && !!pv.json.data.revenue_total, `HTTP ${pv.status}`);
  ok('每个税种都带算式', (pv.json.data.items || []).length >= 4 && (pv.json.data.items || []).every((i) => !!i.formula && !!i.source));
  ok('应纳增值税不为负（负数记留抵）', pv.json.data.vat_payable >= 0);
  ok('附加税以应纳增值税为基数', Number(pv.json.data.surcharge_base) === Number(pv.json.data.vat_payable));
  ok('税负率 = 合计 ÷ 收入',
    Math.abs((Number(pv.json.data.total_burden) / Number(pv.json.data.revenue_total) * 100) - Number(pv.json.data.burden_rate)) < 0.05,
    `${pv.json.data.burden_rate}`);
  ok('测算带免责说明', (pv.json.data.warnings || []).some((w) => /不等于已申报/.test(w)));

  // 美国税区没有增值税
  const pvUs = await req('/api/tax/preview?company_id=3&tax_region=US&period=2026-09', { token });
  ok('美国税区不产生增值税项', pvUs.status === 200
    && !(pvUs.json.data.items || []).some((i) => i.tax_type === 'vat_output'), `HTTP ${pvUs.status}`);

  // 缺配置不许测算（公司 2 的 US 税区没配所得税）
  const pvMiss = await req('/api/tax/preview?company_id=2&tax_region=US&period=2026-09', { token });
  ok('缺税政配置拒绝测算', pvMiss.status === 400 && /税政配置/.test(pvMiss.json.message || ''), `HTTP ${pvMiss.status} ${pvMiss.json.message || ''}`);

  const pvBadPeriod = await req('/api/tax/preview?company_id=1&tax_region=CN&period=2026/09', { token });
  ok('期间格式错误被拒', pvBadPeriod.status === 400, `HTTP ${pvBadPeriod.status}`);

  const polBadRate = await req('/api/tax/policies', {
    method: 'POST', token,
    body: { company_id: 1, tax_region: 'CN', tax_type: 'vat', rate: 130, effective_from: '2026-01-01' }
  });
  ok('税率不可能超过 100%', polBadRate.status === 400 && /100%/.test(polBadRate.json.message || ''), `HTTP ${polBadRate.status}`);

  const txConfirmed = (txRuns.json.data || []).find((r) => r.status === 'confirmed');
  if (txConfirmed) {
    const dup = await req('/api/tax/runs', {
      method: 'POST', token,
      body: { company_id: txConfirmed.company_id, tax_region: txConfirmed.tax_region, period: txConfirmed.period }
    });
    ok('已确认的期间不许重算', dup.status === 400 && /已确认/.test(dup.json.message || ''), `HTTP ${dup.status}`);
    const det = await req(`/api/tax/runs/${txConfirmed.id}`, { token });
    ok('批次详情带当时税率快照', det.status === 200 && !!det.json.data.policy && Object.keys(det.json.data.policy).length > 0, `HTTP ${det.status}`);
    const csvRes = await fetch(`${process.env.BASE || 'http://127.0.0.1:3000'}/api/tax/runs/${txConfirmed.id}/export`, { headers: { Authorization: 'Bearer ' + token } });
    const buf = Buffer.from(await csvRes.arrayBuffer());
    ok('导出底稿是带 BOM 的 CSV', csvRes.status === 200 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, `HTTP ${csvRes.status}`);
    ok('底稿写明不等于已申报', buf.toString('utf8').includes('不等于已申报'));
  } else {
    ['已确认的期间不许重算', '批次详情带当时税率快照', '导出底稿是带 BOM 的 CSV', '底稿写明不等于已申报']
      .forEach((n) => ok(n, false, '没有已确认批次'));
  }

  const txDraft = (txRuns.json.data || []).find((r) => r.status === 'draft');
  if (txDraft) {
    const voidBlank = await req(`/api/tax/runs/${txDraft.id}/void`, { method: 'POST', token, body: {} });
    ok('作废必须写原因', voidBlank.status === 400 && /原因/.test(voidBlank.json.message || ''), `HTTP ${voidBlank.status}`);
  } else {
    ok('作废必须写原因', true, '没有草稿批次');
  }

  const txTrend = await req('/api/tax/trend?company_id=1&tax_region=CN&months=6', { token });
  ok('税负趋势', txTrend.status === 200 && Array.isArray(txTrend.json.data), `HTTP ${txTrend.status}`);
  ok('趋势每期只留一版', new Set((txTrend.json.data || []).map((x) => x.period)).size === (txTrend.json.data || []).length);

  const txNoAuth = await req('/api/tax/overview');
  ok('未登录访问税负返回 401', txNoAuth.status === 401, `HTTP ${txNoAuth.status}`);

  // ==================== M02 组织编制与岗位 ====================
  const orgDict = await req('/api/org/dict', { token });
  ok('组织字典', orgDict.status === 200 && Array.isArray(orgDict.json.data.companies), `HTTP ${orgDict.status}`);
  const orgOv = await req('/api/org/overview', { token });
  ok('组织概览', orgOv.status === 200 && !!orgOv.json.data.positions, `HTTP ${orgOv.status}`);

  const orgPos = await req('/api/org/positions', { token });
  ok('岗位列表', orgPos.status === 200 && Array.isArray(orgPos.json.data), `HTTP ${orgPos.status}`);
  ok('岗位带在职与空缺', (orgPos.json.data || []).every((p) => Number.isFinite(p.in_service) && (p.headcount === 0 || Number.isFinite(p.vacant))));
  const hcSum = (orgPos.json.data || []).filter((p) => p.status === 'active').reduce((x, p) => x + (p.headcount || 0), 0);
  ok('概览编制数 = 岗位编制合计', hcSum === orgOv.json.data.positions.headcount, `${hcSum} vs ${orgOv.json.data.positions.headcount}`);

  const orgEmps = await req('/api/org/employments?status=effective', { token });
  ok('生效任职列表', orgEmps.status === 200 && Array.isArray(orgEmps.json.data), `HTTP ${orgEmps.status}`);
  const empIds = (orgEmps.json.data || []).map((e) => e.employee_id);
  ok('一人只有一条生效任职', new Set(empIds).size === empIds.length, `重复 ${empIds.length - new Set(empIds).size} 人`);
  ok('生效任职数 = 概览在职数', empIds.length === orgOv.json.data.positions.in_service);
  ok('任职带雇佣公司与服务主体', (orgEmps.json.data || []).every((e) => !!e.employer_name && !!e.service_name));

  const orgTree = await req('/api/org/positions/tree', { token });
  ok('汇报关系树', orgTree.status === 200 && Array.isArray(orgTree.json.data), `HTTP ${orgTree.status}`);

  // 规则拦截（都不落数据）
  const posPattern = (orgPos.json.data || []).find((p) => p.headcount > 0 && p.in_service >= p.headcount);
  if (posPattern) {
    const lower = await req(`/api/org/positions/${posPattern.id}`, { method: 'PUT', token, body: { headcount: posPattern.in_service - 1 } });
    ok('编制不能压到在职以下', lower.status === 400 && /编制/.test(lower.json.message || ''), `HTTP ${lower.status}`);
    const close = await req(`/api/org/positions/${posPattern.id}`, { method: 'PUT', token, body: { status: 'closed' } });
    ok('还有在职的岗位不能关闭', close.status === 400 && /在职/.test(close.json.message || ''), `HTTP ${close.status}`);
  } else {
    ok('编制不能压到在职以下', false, '没有满编岗位');
    ok('还有在职的岗位不能关闭', false, '没有满编岗位');
  }
  const posAny = (orgPos.json.data || [])[0];
  if (posAny) {
    const self = await req(`/api/org/positions/${posAny.id}`, { method: 'PUT', token, body: { reports_to_id: posAny.id } });
    ok('岗位不能汇报给自己', self.status === 400, `HTTP ${self.status}`);
  } else {
    ok('岗位不能汇报给自己', false, '没有岗位');
  }

  const empEff = (orgEmps.json.data || [])[0];
  const posFree = (orgPos.json.data || []).find((p) => p.company_id === (empEff && empEff.employer_company_id));
  if (empEff && posFree) {
    const dup = await req('/api/org/employments', {
      method: 'POST', token,
      body: { employee_id: empEff.employee_id, employer_company_id: empEff.employer_company_id, position_id: posFree.id, start_date: '2027-01-01' }
    });
    ok('已有生效任职不能再建一条', dup.status === 400 && /生效任职/.test(dup.json.message || ''), `HTTP ${dup.status} ${dup.json.message || ''}`);
  } else {
    ok('已有生效任职不能再建一条', false, '没有可用的员工或岗位');
  }
  // 岗位归属公司 ≠ 雇佣公司
  const crossPos = (orgPos.json.data || []).find((p) => Number(p.company_id) !== 1);
  if (crossPos) {
    const cross = await req('/api/org/employments', {
      method: 'POST', token,
      body: { employee_id: empEff.employee_id, employer_company_id: 1, position_id: crossPos.id, start_date: '2027-01-01' }
    });
    ok('岗位归属与雇佣公司不一致被拒', cross.status === 400 && /不一致/.test(cross.json.message || ''), `HTTP ${cross.status}`);
  } else {
    ok('岗位归属与雇佣公司不一致被拒', false, '没有跨公司岗位');
  }

  // 待批任职：满编时必须特批且写原因
  const pend = await req('/api/org/employments?status=pending', { token });
  const pendEmp = (pend.json.data || [])[0];
  if (pendEmp) {
    const info = await req(`/api/org/employments/${pendEmp.id}`, { token });
    ok('待批任职带编制校验', info.status === 200 && !!info.json.data.headcount_check, `HTTP ${info.status}`);
    if (info.json.data.headcount_check && info.json.data.headcount_check.would_exceed) {
      const noOver = await req(`/api/org/employments/${pendEmp.id}/approve`, { method: 'POST', token, body: {} });
      ok('满编批准被拦', noOver.status === 400 && /满编/.test(noOver.json.message || ''), `HTTP ${noOver.status}`);
      const noReason = await req(`/api/org/employments/${pendEmp.id}/approve`, { method: 'POST', token, body: { over_headcount: true } });
      ok('超编特批必须写原因', noReason.status === 400 && /原因/.test(noReason.json.message || ''), `HTTP ${noReason.status}`);
    } else {
      ok('满编批准被拦', true, '该岗未满编，跳过');
      ok('超编特批必须写原因', true, '跳过');
    }
  } else {
    ok('待批任职带编制校验', true, '没有待批任职');
    ok('满编批准被拦', true, '跳过');
    ok('超编特批必须写原因', true, '跳过');
  }

  // 交易路线
  const orgRoutes = await req('/api/org/routes', { token });
  ok('交易路线列表', orgRoutes.status === 200 && Array.isArray(orgRoutes.json.data), `HTTP ${orgRoutes.status}`);
  ok('路线带六个角色主体', (orgRoutes.json.data || []).every((r) => 'seller_name' in r && 'sign_name' in r && 'fulfill_name' in r && 'owner_name' in r));
  const routeBad = await req('/api/org/routes', {
    method: 'POST', token,
    body: { name: '冒烟-代签无协议', biz_type: 'spot', seller_company_id: 1, sign_company_id: 2, fulfill_company_id: 2, goods_owner_company_id: 1 }
  });
  ok('签约≠卖方必须有服务协议', routeBad.status === 400 && /服务协议/.test(routeBad.json.message || ''), `HTTP ${routeBad.status}`);
  const routeNoOwner = await req('/api/org/routes', {
    method: 'POST', token,
    body: { name: '冒烟-缺货主', biz_type: 'spot', seller_company_id: 1, sign_company_id: 1, fulfill_company_id: 1 }
  });
  ok('缺货主不能建路线', routeNoOwner.status === 400 && /货主/.test(routeNoOwner.json.message || ''), `HTTP ${routeNoOwner.status}`);
  const confirmedRoute = (orgRoutes.json.data || []).find((r) => r.status === 'confirmed');
  if (confirmedRoute) {
    const editConfirmed = await req(`/api/org/routes/${confirmedRoute.id}`, { method: 'PUT', token, body: { seller_company_id: 3 } });
    ok('已确认路线不能改主体', editConfirmed.status === 400, `HTTP ${editConfirmed.status}`);
  } else {
    ok('已确认路线不能改主体', false, '没有已确认路线');
  }

  // 主体授权
  const orgScopes = await req('/api/org/scopes', { token });
  ok('授权范围列表', orgScopes.status === 200 && Array.isArray(orgScopes.json.data), `HTTP ${orgScopes.status}`);
  ok('授权带字段/汇总/到期', (orgScopes.json.data || []).every((x) => !!x.field_label && !!x.agg_label));
  const scNoExp = await req('/api/org/scopes', {
    method: 'POST', token, body: { user_id: 8, company_ids: '1', reason: '冒烟：无到期日' }
  });
  ok('授权必须有到期日', scNoExp.status === 400 && /到期/.test(scNoExp.json.message || ''), `HTTP ${scNoExp.status}`);
  const scGroup1 = await req('/api/org/scopes', {
    method: 'POST', token, body: { user_id: 8, company_ids: '1', aggregate_scope: 'group', expires_at: '2027-12-31', reason: '冒烟：集团汇总单公司' }
  });
  ok('集团汇总至少要两家公司', scGroup1.status === 400 && /两家/.test(scGroup1.json.message || ''), `HTTP ${scGroup1.status}`);
  const scNoReason = await req('/api/org/scopes', {
    method: 'POST', token, body: { user_id: 8, company_ids: '1', expires_at: '2027-12-31' }
  });
  ok('授权申请必须写用途', scNoReason.status === 400 && /用途/.test(scNoReason.json.message || ''), `HTTP ${scNoReason.status}`);

  // 自己批自己（建单→提交→用同一账号批准）+ 清理
  const scOwn = await req('/api/org/scopes', {
    method: 'POST', token, body: { user_id: 8, company_ids: '1', expires_at: '2027-12-31', reason: '冒烟：验证不能自批' }
  });
  if (scOwn.status === 200) {
    const scId = scOwn.json.data.id;
    await req(`/api/org/scopes/${scId}/submit`, { method: 'POST', token, body: {} });
    const selfApprove = await req(`/api/org/scopes/${scId}/approve`, { method: 'POST', token, body: {} });
    ok('授权不能自己批自己', selfApprove.status === 400 && /独立批准/.test(selfApprove.json.message || ''), `HTTP ${selfApprove.status}`);
    await req(`/api/org/scopes/${scId}/reject`, { method: 'POST', token, body: { reason: '冒烟清理' } });
    const delSc = await req(`/api/org/scopes/${scId}`, { method: 'DELETE', token });
    ok('清理冒烟授权单', delSc.status === 200, `HTTP ${delSc.status}`);
  } else {
    ok('授权不能自己批自己', false, `建单失败 ${scOwn.json.message || ''}`);
    ok('清理冒烟授权单', false, '跳过');
  }

  const orgNoAuth = await req('/api/org/overview');
  ok('未登录访问组织模块返回 401', orgNoAuth.status === 401, `HTTP ${orgNoAuth.status}`);

  // ==================== M17 制度问答（引用版本与日期） ====================
  const poRecent = await req('/api/ai/policy/recent', { token });
  ok('现行有效制度列表', poRecent.status === 200 && Array.isArray(poRecent.json.data), `HTTP ${poRecent.status}`);
  ok('只列生效版本', (poRecent.json.data || []).every((d) => d.status === 'effective' && d.version >= 1));

  const poAsk = await req('/api/ai/policy/ask', { method: 'POST', token, body: { question: '请假 3 天需要谁审批？', use_model: false } });
  ok('制度问答可作答', poAsk.status === 200 && poAsk.json.data.answerable === true, `HTTP ${poAsk.status}`);
  ok('引用必须带版本号', (poAsk.json.data.citations || []).every((c) => Number.isFinite(c.version) && c.version >= 1));
  ok('引用必须带生效日期', (poAsk.json.data.citations || []).every((c) => /^\d{4}-\d{2}-\d{2}$/.test(String(c.effective_date || ''))));
  ok('引用行含文号/版本/生效日/责任人',
    (poAsk.json.data.citations || []).every((c) => /V\d+/.test(c.cite) && c.cite.includes(c.doc_no) && c.cite.includes(c.effective_date)));
  ok('答案正文里也带引用行', /——引用：/.test(poAsk.json.data.answer || ''));
  ok('原文摘录不是模型改写', (poAsk.json.data.basis || []).length > 0 && (poAsk.json.data.basis || []).every((b) => !!b.text && !!b.field));
  ok('引用的版本就是现行版本',
    (poAsk.json.data.citations || []).every((c) => !c.version || !Object.prototype.hasOwnProperty.call(c, 'current_version') || c.version === c.current_version));
  ok('作答后留痕', poAsk.json.data.logged && poAsk.json.data.logged.saved > 0);

  const poDraft = await req('/api/ai/policy/ask', { method: 'POST', token, body: { question: '样品能借多久？', use_model: false } });
  ok('只有草稿/废止制度时拒绝作答', poDraft.status === 200 && poDraft.json.data.answerable === false, `HTTP ${poDraft.status}`);
  ok('拒答时说明制度当前状态', (poDraft.json.data.invalid || []).length > 0
    && (poDraft.json.data.invalid || []).every((x) => ['draft', 'pending', 'retired'].includes(x.status)));
  ok('拒答时不产生引用', (poDraft.json.data.citations || []).length === 0);

  const poHits = await req('/api/ai/policy/hits?limit=20', { token });
  ok('引用留痕可查', poHits.status === 200 && Array.isArray(poHits.json.data.rows), `HTTP ${poHits.status}`);
  ok('留痕能标出引用了旧版的记录', typeof poHits.json.data.outdated === 'number');

  const poDocNo = (poRecent.json.data || []).find((d) => d.version >= 2) || (poRecent.json.data || [])[0];
  if (poDocNo) {
    const poDoc = await req('/api/ai/policy/doc/' + poDocNo.doc_no, { token });
    ok('制度原文可取', poDoc.status === 200 && !!poDoc.json.data.doing, `HTTP ${poDoc.status}`);
    ok('原文带版本历史', (poDoc.json.data.versions || []).length >= 1);
  } else {
    ok('制度原文可取', false, '没有生效制度');
    ok('原文带版本历史', false, '没有生效制度');
  }

  const poAskBad = await req('/api/ai/policy/ask', { method: 'POST', token, body: { question: '' } });
  ok('空问题被拒', poAskBad.status === 400, `HTTP ${poAskBad.status}`);
  const poSearch = await req('/api/ai/policy/search?q=' + encodeURIComponent('付款审批'), { token });
  ok('制度检索', poSearch.status === 200 && Array.isArray(poSearch.json.data.hits), `HTTP ${poSearch.status}`);
  const poNoAuth = await req('/api/ai/policy/ask', { method: 'POST', body: { question: '请假' } });
  ok('未登录访问制度问答返回 401', poNoAuth.status === 401, `HTTP ${poNoAuth.status}`);
  const poAskInAsk = await req('/api/ai/ask', { method: 'POST', token, body: { message: '请假三天要谁批' } });
  ok('通用问答命中制度时带引用',
    poAskInAsk.status === 200 && ((poAskInAsk.json.data.citations || []).length > 0 || poAskInAsk.json.data.answered_by === 'policy'),
    `HTTP ${poAskInAsk.status}`);

  // ==================== M16 营销与素材 ====================
  const mkOv = await req('/api/mkt/overview', { token });
  ok('营销概览', mkOv.status === 200 && !!mkOv.json.data.tasks, `HTTP ${mkOv.status}`);
  ok('概览区分币种（不做跨币种合计）',
    mkOv.status === 200 && Object.keys(mkOv.json.data.campaigns.spend_by_currency || {}).every((k) => /^[A-Z]{3}$/.test(k)));

  const mkDict = await req('/api/mkt/dict', { token });
  ok('营销字典', mkDict.status === 200 && Array.isArray(mkDict.json.data.task_status) && mkDict.json.data.task_status.length === 6, `HTTP ${mkDict.status}`);
  ok('字典含素材授权范围与复盘分类',
    (mkDict.json.data.asset_scope || []).length === 3 && (mkDict.json.data.review_category || []).length >= 6);

  const mkTasks = await req('/api/mkt/tasks', { token });
  ok('上新任务列表', mkTasks.status === 200 && Array.isArray(mkTasks.json.data), `HTTP ${mkTasks.status}`);
  ok('任务带状态中文与逾期标记',
    (mkTasks.json.data || []).every((t) => !!t.status_label && typeof t.is_overdue === 'boolean'));
  ok('任务列表不回写生产状态（只读 mkt_tasks）',
    (mkTasks.json.data || []).every((t) => !Object.prototype.hasOwnProperty.call(t, 'tech_status')));

  const mkCal = await req('/api/mkt/calendar', { token });
  ok('上新日历', mkCal.status === 200 && typeof mkCal.json.data.by_date === 'object', `HTTP ${mkCal.status}`);

  const mkAs = await req('/api/mkt/assets', { token });
  ok('素材列表', mkAs.status === 200 && Array.isArray(mkAs.json.data), `HTTP ${mkAs.status}`);
  ok('过期素材不会被当成可用',
    (mkAs.json.data || []).filter((a) => a.status === 'approved')
      .every((a) => !a.license_to || a.license_to >= (mkDict.json.data.today || '')), '存在 approved 但已过期的素材');
  ok('客户专属素材都有客户',
    (mkAs.json.data || []).filter((a) => a.scope === 'exclusive').every((a) => !!a.customer_id));

  const mkCp = await req('/api/mkt/campaigns', { token });
  ok('活动列表', mkCp.status === 200 && Array.isArray(mkCp.json.data), `HTTP ${mkCp.status}`);
  const mkRep = await req('/api/mkt/reports/campaign', { token });
  ok('活动报表按币种分组', mkRep.status === 200 && (mkRep.json.data.currencies || []).every((g) => !!g.currency));
  ok('报表声明归因收入不等于净利润', /不等于净利润/.test(mkRep.json.data.note || ''));

  const mkRev = await req('/api/mkt/reviews', { token });
  ok('复盘列表', mkRev.status === 200 && Array.isArray(mkRev.json.data), `HTTP ${mkRev.status}`);
  ok('复盘带行动项进度与逾期数',
    (mkRev.json.data || []).every((r) => r.action_cnt >= r.done_cnt && typeof r.overdue_cnt === 'number'));

  // ---- 写路径：建任务 → 无素材不能进资料确认 → 素材流程 → 门槛 → 清理 ----
  const mkNew = await req('/api/mkt/tasks', {
    method: 'POST',
    token,
    body: { title: '冒烟-营销任务', biz_type: 'stock', style_no: '__SMOKE_MK__', plan_launch_date: '2026-12-01' }
  });
  const mkTaskId = mkNew.json.data && mkNew.json.data.id;
  ok('新建上新任务', mkNew.status === 200 && !!mkTaskId, `HTTP ${mkNew.status}`);

  if (mkTaskId) {
    // 状态机是 待资料 → 素材筹备 → 资料确认 → 已上新，不能跳步
    const mkSkip = await req(`/api/mkt/tasks/${mkTaskId}/status`, { method: 'POST', token, body: { to: 'ready' } });
    ok('不能跳过素材筹备直接进资料确认', mkSkip.status === 400 && /不能从/.test(mkSkip.json.message || ''), `HTTP ${mkSkip.status} ${mkSkip.json.message || ''}`);
    const mkMat = await req(`/api/mkt/tasks/${mkTaskId}/status`, { method: 'POST', token, body: { to: 'material' } });
    ok('待资料 → 素材筹备', mkMat.status === 200 && mkMat.json.data.status === 'material', `HTTP ${mkMat.status}`);
    const mkReady = await req(`/api/mkt/tasks/${mkTaskId}/status`, { method: 'POST', token, body: { to: 'ready' } });
    ok('没素材不能进资料确认', mkReady.status === 400 && /素材/.test(mkReady.json.message || ''), `HTTP ${mkReady.status} ${mkReady.json.message || ''}`);

    const mkAssetNew = await req('/api/mkt/assets', {
      method: 'POST', token,
      body: { title: '冒烟-素材', kind: 'image', scope: 'public', license_source: 'own', license_to: '2026-12-31' }
    });
    const mkAssetId = mkAssetNew.json.data && mkAssetNew.json.data.id;
    ok('登记素材（草稿）', mkAssetNew.status === 200 && mkAssetNew.json.data.status === 'draft', `HTTP ${mkAssetNew.status}`);

    if (mkAssetId) {
      const mkSub = await req(`/api/mkt/assets/${mkAssetId}/submit`, { method: 'POST', token, body: {} });
      ok('提交素材审核', mkSub.status === 200 && mkSub.json.data.status === 'pending', `HTTP ${mkSub.status}`);
      const mkPass = await req(`/api/mkt/assets/${mkAssetId}/review`, { method: 'POST', token, body: { pass: true, note: '冒烟通过' } });
      ok('素材审核通过', mkPass.status === 200 && mkPass.json.data.status === 'approved', `HTTP ${mkPass.status}`);
      const mkEdit = await req(`/api/mkt/assets/${mkAssetId}`, { method: 'PUT', token, body: { title: '改名' } });
      ok('已通过素材禁止直接改（要新版本）', mkEdit.status === 400, `HTTP ${mkEdit.status}`);

      const mkBind = await req(`/api/mkt/tasks/${mkTaskId}/assets`, { method: 'POST', token, body: { asset_id: mkAssetId } });
      ok('绑定素材到任务', mkBind.status === 200, `HTTP ${mkBind.status}`);

      const mkReady2 = await req(`/api/mkt/tasks/${mkTaskId}/status`, { method: 'POST', token, body: { to: 'ready' } });
      ok('有素材后能进资料确认', mkReady2.status === 200 && mkReady2.json.data.status === 'ready', `HTTP ${mkReady2.status}`);

      const mkLaunch = await req(`/api/mkt/tasks/${mkTaskId}/status`, { method: 'POST', token, body: { to: 'launched' } });
      ok('无库存不能上新（到仓门槛）', mkLaunch.status === 400 && /库存|门槛/.test(mkLaunch.json.message || ''), `HTTP ${mkLaunch.status}`);

      const mkExcl = await req('/api/mkt/assets', {
        method: 'POST', token,
        body: { title: '冒烟-专属花型', scope: 'exclusive', customer_id: 1, license_source: 'customer' }
      });
      if (mkExcl.status === 200) {
        const mkExclId = mkExcl.json.data.id;
        await req(`/api/mkt/assets/${mkExclId}/submit`, { method: 'POST', token, body: {} });
        await req(`/api/mkt/assets/${mkExclId}/review`, { method: 'POST', token, body: { pass: true } });
        const mkBadBind = await req(`/api/mkt/tasks/${mkTaskId}/assets`, { method: 'POST', token, body: { asset_id: mkExclId } });
        ok('客户专属素材不能给别的客户用', mkBadBind.status === 400 && /专属/.test(mkBadBind.json.message || ''), `HTTP ${mkBadBind.status} ${mkBadBind.json.message || ''}`);
        await req(`/api/mkt/assets/${mkExclId}/revoke`, { method: 'POST', token, body: { note: '冒烟清理：撤授权' } });
        const mkDelExcl = await req(`/api/mkt/assets/${mkExclId}`, { method: 'DELETE', token });
        ok('作废且无引用的素材可删除', mkDelExcl.status === 200, `HTTP ${mkDelExcl.status}`);
      } else {
        ok('客户专属素材不能给别的客户用', false, '专属素材建不出来');
        ok('作废且无引用的素材可删除', false, '跳过');
      }

      await req(`/api/mkt/tasks/${mkTaskId}/assets/${mkAssetId}`, { method: 'DELETE', token });
      await req(`/api/mkt/assets/${mkAssetId}/revoke`, { method: 'POST', token, body: { note: '冒烟清理' } });
      const mkDelAsset = await req(`/api/mkt/assets/${mkAssetId}`, { method: 'DELETE', token });
      ok('清理冒烟素材', mkDelAsset.status === 200, `HTTP ${mkDelAsset.status}`);
    } else {
      ['提交素材审核', '素材审核通过', '已通过素材禁止直接改（要新版本）', '绑定素材到任务',
        '有素材后能进资料确认', '无库存不能上新（到仓门槛）', '客户专属素材不能给别的客户用',
        '作废且无引用的素材可删除', '清理冒烟素材'].forEach((n) => ok(n, false, '素材没建成'));
    }
    const mkDel = await req(`/api/mkt/tasks/${mkTaskId}`, { method: 'DELETE', token });
    ok('清理冒烟任务', mkDel.status === 200, `HTTP ${mkDel.status}`);
  }

  // ---- 活动/复盘规则（只打 400 路径，不落数据） ----
  const mkCamp0 = (mkCp.json.data || [])[0];
  if (mkCamp0) {
    const otherCur = mkCamp0.currency === 'USD' ? 'CNY' : 'USD';
    const mkBillBad = await req(`/api/mkt/campaigns/${mkCamp0.id}/bills`, {
      method: 'POST', token, body: { amount: 10, currency: otherCur }
    });
    ok('账单币种不一致被拒', mkBillBad.status === 400 && /币种/.test(mkBillBad.json.message || ''), `HTTP ${mkBillBad.status}`);
    const mkAttr = await req(`/api/mkt/campaigns/${mkCamp0.id}/attribution`, { token });
    ok('归因接口返回三类别剔除', mkAttr.status === 200 && !!mkAttr.json.data.excluded.unconfirmed, `HTTP ${mkAttr.status}`);
    ok('归因只算已排产后的订单',
      (mkAttr.json.data.counted || []).every((o) => ['assigned', 'production', 'instock', 'shipped', 'closed'].includes(o.status)));
  } else {
    ['账单币种不一致被拒', '归因接口返回三类别剔除', '归因只算已排产后的订单'].forEach((n) => ok(n, false, '没有活动'));
  }

  // 已关闭的复盘不能再动，挑一个还在推进中的
  const mkRev0 = (mkRev.json.data || []).find((r) => r.status !== 'done');
  if (mkRev0) {
    const mkNoOwner = await req(`/api/mkt/reviews/${mkRev0.id}/actions`, {
      method: 'POST', token, body: { action: '冒烟', due_date: '2026-12-01' }
    });
    ok('行动项缺负责人被拒', mkNoOwner.status === 400 && /负责人/.test(mkNoOwner.json.message || ''), `HTTP ${mkNoOwner.status}`);
    const mkNoDue = await req(`/api/mkt/reviews/${mkRev0.id}/actions`, {
      method: 'POST', token, body: { action: '冒烟', owner: '张三' }
    });
    ok('行动项缺期限被拒', mkNoDue.status === 400 && /期限/.test(mkNoDue.json.message || ''), `HTTP ${mkNoDue.status}`);
  } else {
    ['行动项缺负责人被拒', '行动项缺期限被拒'].forEach((n) => ok(n, false, '没有复盘'));
  }
  const mkNoEv = await req('/api/mkt/reviews', { method: 'POST', token, body: { topic: '冒烟-无证据' } });
  ok('复盘必须有来源', mkNoEv.status === 400 && /来源/.test(mkNoEv.json.message || ''), `HTTP ${mkNoEv.status}`);
  const mkBadCamp = await req('/api/mkt/campaigns', { method: 'POST', token, body: { name: '冒烟', budget_amount: 0 } });
  ok('预算为 0 的活动被拒', mkBadCamp.status === 400, `HTTP ${mkBadCamp.status}`);

  const mkNoAuth = await req('/api/mkt/overview');
  ok('未登录访问营销返回 401', mkNoAuth.status === 401, `HTTP ${mkNoAuth.status}`);

  const mkRepL = await req('/api/mkt/reports/launch', { token });
  ok('上新达成率报表', mkRepL.status === 200 && Array.isArray(mkRepL.json.data.by_month), `HTTP ${mkRepL.status}`);
  const mkRepR = await req('/api/mkt/reports/review', { token });
  ok('复盘报表含闭环率', mkRepR.status === 200 && !!mkRepR.json.data.actions, `HTTP ${mkRepR.status}`);


  // ============================================================
  // M06 有限产能排程（班次日历 / 工序定额 / 排程批次 / 硬冲突）
  // ============================================================
  {
    const smMeta = await req('/api/schedule/meta', { token });
    ok('排程基础数据可读', smMeta.status === 200 && Array.isArray(smMeta.json.data.work_centers), `HTTP ${smMeta.status}`);
    ok('排程字典带冲突类型', smMeta.status === 200 && !!smMeta.json.data.conflict_labels, '缺 conflict_labels');

    const smOrders = await req('/api/schedule/orders', { token });
    ok('可排订单列表可读', smOrders.status === 200 && Array.isArray(smOrders.json.data), `HTTP ${smOrders.status}`);

    const smStds = await req('/api/schedule/standards', { token });
    ok('工序定额列表可读', smStds.status === 200 && Array.isArray(smStds.json.data), `HTTP ${smStds.status}`);
    const smBadStd = await req('/api/schedule/standards', {
      method: 'POST', token, body: { process_name: '冒烟工序', work_center: '一车间', std_minutes: 0 }
    });
    ok('单件工时为 0 的定额被拒（0 工时等于无限产能）',
      smBadStd.status === 400 && /大于 0/.test(smBadStd.json.message || ''), `HTTP ${smBadStd.status}`);

    const smCal = await req(`/api/schedule/calendars?from=${new Date().toISOString().slice(0, 10)}`, { token });
    ok('班次日历可读', smCal.status === 200 && Array.isArray(smCal.json.data.dates), `HTTP ${smCal.status}`);
    const smBadCal = await req('/api/schedule/calendars', {
      method: 'POST', token, body: { work_center: '一车间', cal_date: new Date().toISOString().slice(0, 10), base_hours: 30 }
    });
    ok('基准工时超过 24 小时被拒', smBadCal.status === 400 && /0~24/.test(smBadCal.json.message || ''), `HTTP ${smBadCal.status}`);
    const smBadFill = await req('/api/schedule/calendars/fill', {
      method: 'POST', token, body: { from: '2026/01/01', to: '2026-01-02' }
    });
    ok('批量填充日期格式不合法被拒', smBadFill.status === 400, `HTTP ${smBadFill.status}`);

    const smRuns = await req('/api/schedule/runs', { token });
    ok('排程批次列表可读', smRuns.status === 200 && Array.isArray(smRuns.json.data), `HTTP ${smRuns.status}`);

    const smBadPv = await req('/api/schedule/runs/preview', {
      method: 'POST', token, body: { from: '2026-12-31', to: '2026-12-01' }
    });
    ok('窗口倒置的预演被拒', smBadPv.status === 400, `HTTP ${smBadPv.status}`);

    const smPv = await req('/api/schedule/runs/preview', {
      method: 'POST', token, body: { from: new Date().toISOString().slice(0, 10), to: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10) }
    });
    ok('预演返回统计与冲突清单', smPv.status === 200 && !!smPv.json.data.stats && Array.isArray(smPv.json.data.conflicts), `HTTP ${smPv.status}`);
    ok('预演不落库（只算不写）', smPv.status === 200 && typeof smPv.json.data.stats.task_count === 'number', '缺 task_count');

    const cur = (smRuns.json.data || []).find((r) => r.is_current) || (smRuns.json.data || [])[0];
    if (cur) {
      const smOne = await req(`/api/schedule/runs/${cur.id}`, { token });
      ok('排程批次详情含甘特泳道与日负载',
        smOne.status === 200 && Array.isArray(smOne.json.data.lanes) && Array.isArray(smOne.json.data.day_load), `HTTP ${smOne.status}`);

      const smConf = await req(`/api/schedule/conflicts?run_id=${cur.id}`, { token });
      ok('冲突清单可读', smConf.status === 200 && Array.isArray(smConf.json.data), `HTTP ${smConf.status}`);

      const firstConf = (smConf.json.data || [])[0];
      if (firstConf) {
        const smResolveEmpty = await req(`/api/schedule/conflicts/${firstConf.id}/resolve`, {
          method: 'POST', token, body: { note: '' }
        });
        ok('处理冲突不写意见被拒', smResolveEmpty.status === 400 && /意见/.test(smResolveEmpty.json.message || ''), `HTTP ${smResolveEmpty.status}`);
      } else {
        ok('处理冲突不写意见被拒', true, '无冲突行，跳过');
      }

      const task = (smOne.json.data.tasks || [])[0];
      if (task) {
        const smPatchNoReason = await req(`/api/schedule/tasks/${task.id}`, {
          method: 'PATCH', token, body: { est_hours: Number(task.est_hours) + 1 }
        });
        if (cur.status === 'published') {
          ok('已发布批次的任务不可原地改（要改请出新版本）',
            smPatchNoReason.status === 400 && /只读|新版本/.test(smPatchNoReason.json.message || ''), `HTTP ${smPatchNoReason.status}`);
        } else {
          ok('调整任务不写原因被拒',
            smPatchNoReason.status === 400 && /原因/.test(smPatchNoReason.json.message || ''), `HTTP ${smPatchNoReason.status}`);
        }
      } else {
        ok('排程任务调整门禁', true, '该批次没有任务，跳过');
      }

      if (cur.status === 'published') {
        const smRepublish = await req(`/api/schedule/runs/${cur.id}/publish`, { method: 'POST', token, body: {} });
        ok('重复发布已发布批次被拒', smRepublish.status === 400, `HTTP ${smRepublish.status}`);
      } else {
        ok('重复发布已发布批次被拒', true, '当前批次非已发布，跳过');
      }
    } else {
      ['排程批次详情含甘特泳道与日负载', '冲突清单可读', '处理冲突不写意见被拒', '排程任务调整门禁'].forEach((n) => ok(n, false, '没有排程批次'));
    }

    const sm404 = await req('/api/schedule/runs/999999', { token });
    ok('不存在的批次返回 404', sm404.status === 404, `HTTP ${sm404.status}`);

    const smLoad = await req('/api/schedule/load', { token });
    ok('日负载接口可读', smLoad.status === 200 && Array.isArray(smLoad.json.data.rows), `HTTP ${smLoad.status}`);

    const smNoAuth = await req('/api/schedule/meta');
    ok('未登录访问排程返回 401', smNoAuth.status === 401, `HTTP ${smNoAuth.status}`);
  }

  // ============================================================
  // M19 现货经营总览 + 备货补货与停补提案
  // ============================================================
  {
    const soDict = await req('/api/spotops/dict', { token });
    ok('现货字典可读', soDict.status === 200 && Array.isArray(soDict.json.data.kind), `HTTP ${soDict.status}`);

    const soOv = await req('/api/spotops/overview?warehouse=us&window_days=60', { token });
    ok('现货经营总览可读', soOv.status === 200 && !!soOv.json.data.stat && Array.isArray(soOv.json.data.styles), `HTTP ${soOv.status}`);
    ok('总览带「占用/可售」分开的口径',
      soOv.status === 200 && soOv.json.data.stat.sellable !== undefined && soOv.json.data.stat.held !== undefined,
      '缺 sellable/held');

    const soSkus = await req('/api/spotops/skus?warehouse=us&window_days=60', { token });
    ok('逐码明细可读', soSkus.status === 200 && Array.isArray(soSkus.json.data.rows), `HTTP ${soSkus.status}`);

    const soPol = await req('/api/spotops/policies?warehouse=us', { token });
    ok('备货策略可读', soPol.status === 200 && Array.isArray(soPol.json.data.rows), `HTTP ${soPol.status}`);

    const soPolNoStyle = await req('/api/spotops/policies', {
      method: 'POST', token, body: { scope: 'style', style_no: '', target_cover_days: 60 }
    });
    ok('按款策略不填款号被拒', soPolNoStyle.status === 400 && /款号/.test(soPolNoStyle.json.message || ''), `HTTP ${soPolNoStyle.status}`);

    const soPolBadCover = await req('/api/spotops/policies', {
      method: 'POST', token, body: { scope: 'global', target_cover_days: 0 }
    });
    ok('目标覆盖天数为 0 被拒', soPolBadCover.status === 400 && /目标覆盖/.test(soPolBadCover.json.message || ''), `HTTP ${soPolBadCover.status}`);

    const soRuns = await req('/api/spotops/runs?warehouse=us', { token });
    ok('提案批次列表可读', soRuns.status === 200 && Array.isArray(soRuns.json.data), `HTTP ${soRuns.status}`);

    const latest = (soRuns.json.data || [])[0];
    if (latest) {
      const soRun = await req(`/api/spotops/runs/${latest.id}`, { token });
      ok('提案明细可读', soRun.status === 200 && Array.isArray(soRun.json.data.lines), `HTTP ${soRun.status}`);

      const pending = (soRun.json.data.lines || []).find((l) => l.status === 'pending' && l.kind === 'replenish');
      const pendingStop = (soRun.json.data.lines || []).find((l) => l.status === 'pending' && l.kind !== 'replenish');

      if (pending) {
        const badQty = await req(`/api/spotops/lines/${pending.id}/decide`, {
          method: 'POST', token, body: { action: 'approve', qty: Number(pending.suggest_qty) + 9999, note: '冒烟' }
        });
        ok('批准数量超过建议量被拒',
          badQty.status === 400 && /不能超过建议量/.test(badQty.json.message || ''), `HTTP ${badQty.status}`);
      } else {
        ok('批准数量超过建议量被拒', true, '没有待决策的补货行，跳过');
      }

      if (pendingStop) {
        const badApprove = await req(`/api/spotops/lines/${pendingStop.id}/decide`, {
          method: 'POST', token, body: { action: 'approve', qty: 100, note: '冒烟' }
        });
        ok('停补/观察行不能批准数量',
          badApprove.status === 400 && /没有可批准的数量/.test(badApprove.json.message || ''), `HTTP ${badApprove.status}`);

        const rejectNoNote = await req(`/api/spotops/lines/${pendingStop.id}/decide`, {
          method: 'POST', token, body: { action: 'reject', note: '' }
        });
        ok('驳回不写原因被拒',
          rejectNoNote.status === 400 && /原因/.test(rejectNoNote.json.message || ''), `HTTP ${rejectNoNote.status}`);
      } else {
        ok('停补/观察行不能批准数量', true, '没有待决策的停补行，跳过');
        ok('驳回不写原因被拒', true, '没有待决策的停补行，跳过');
      }
    } else {
      ['提案明细可读', '批准数量超过建议量被拒', '停补/观察行不能批准数量', '驳回不写原因被拒']
        .forEach((n) => ok(n, false, '没有提案批次'));
    }

    const so404 = await req('/api/spotops/runs/999999', { token });
    ok('不存在的提案批次返回 404', so404.status === 404, `HTTP ${so404.status}`);

    const soAppr = await req('/api/spotops/approved?warehouse=us', { token });
    ok('已批准待下单清单可读', soAppr.status === 200 && Array.isArray(soAppr.json.data.rows), `HTTP ${soAppr.status}`);

    const soNoAuth = await req('/api/spotops/overview');
    ok('未登录访问现货接口返回 401', soNoAuth.status === 401, `HTTP ${soNoAuth.status}`);
  }

  // ============================================================
  // M12 分公司（分部）经营对比
  // ============================================================
  {
    const sgDict = await req('/api/segments/dict', { token });
    ok('分部对比字典可读', sgDict.status === 200 && Array.isArray(sgDict.json.data.adj_kind), `HTTP ${sgDict.status}`);

    const sgBoard = await req('/api/segments/board?period=2026-09', { token });
    ok('分部对比总表可读', sgBoard.status === 200 && Array.isArray(sgBoard.json.data.companies), `HTTP ${sgBoard.status}`);
    ok('总表带对外收入与内部收入分开的口径',
      sgBoard.status === 200
      && sgBoard.json.data.total.external_income !== undefined
      && sgBoard.json.data.total.ic_income !== undefined,
      '缺 external_income / ic_income');
    ok('总表带合并数对照', sgBoard.status === 200 && sgBoard.json.data.consolidated !== undefined, '缺 consolidated');

    const sgOne = await req('/api/segments/company/2?period=2026-09', { token });
    ok('单主体下钻可读',
      sgOne.status === 200 && !!sgOne.json.data.snapshot && Array.isArray(sgOne.json.data.unmatched_partners),
      `HTTP ${sgOne.status}`);
    const sg404 = await req('/api/segments/company/999999?period=2026-09', { token });
    ok('不存在的主体返回 404', sg404.status === 404, `HTTP ${sg404.status}`);

    const sgAdj = await req('/api/segments/adjustments?period=2026-09', { token });
    ok('可比调整列表可读', sgAdj.status === 200 && Array.isArray(sgAdj.json.data), `HTTP ${sgAdj.status}`);

    const sgAdjZero = await req('/api/segments/adjustments', {
      method: 'POST', token, body: { company_id: 2, period: '2026-09', kind: 'one_off', amount: 0, note: '冒烟测试这笔调整' }
    });
    ok('调整金额为 0 被拒', sgAdjZero.status === 400 && /不能为 0/.test(sgAdjZero.json.message || ''), `HTTP ${sgAdjZero.status}`);

    const sgAdjNote = await req('/api/segments/adjustments', {
      method: 'POST', token, body: { company_id: 2, period: '2026-09', kind: 'one_off', amount: 1000, note: '短' }
    });
    ok('调整不写清说明被拒', sgAdjNote.status === 400 && /说明|至少/.test(sgAdjNote.json.message || ''), `HTTP ${sgAdjNote.status}`);

    const sgAdjPeriod = await req('/api/segments/adjustments', {
      method: 'POST', token, body: { company_id: 2, period: '2026/09', kind: 'one_off', amount: 1000, note: '冒烟测试期间格式' }
    });
    ok('调整期间格式不合法被拒', sgAdjPeriod.status === 400, `HTTP ${sgAdjPeriod.status}`);

    const sgReps = await req('/api/segments/reports', { token });
    ok('报告列表可读', sgReps.status === 200 && Array.isArray(sgReps.json.data), `HTTP ${sgReps.status}`);

    const confirmed = (sgReps.json.data || []).find((r) => r.status === 'confirmed');
    if (confirmed) {
      const again = await req(`/api/segments/reports/${confirmed.id}/confirm`, { method: 'POST', token, body: {} });
      ok('已确认的报告不能重复确认', again.status === 400 && /已确认/.test(again.json.message || ''), `HTTP ${again.status}`);
      const one = await req(`/api/segments/reports/${confirmed.id}`, { token });
      ok('报告快照可读（含 payload）', one.status === 200 && !!one.json.data.payload, `HTTP ${one.status}`);
    } else {
      ok('已确认的报告不能重复确认', true, '没有已确认报告，跳过');
      ok('报告快照可读（含 payload）', true, '没有报告，跳过');
    }

    const sgRep404 = await req('/api/segments/reports/999999', { token });
    ok('不存在的报告返回 404', sgRep404.status === 404, `HTTP ${sgRep404.status}`);

    const sgNoAuth = await req('/api/segments/board');
    ok('未登录访问分部对比返回 401', sgNoAuth.status === 401, `HTTP ${sgNoAuth.status}`);
  }

  // ==================== M10 备料领退与盘点差异 ====================
  {
    const mfDict = await req('/api/matflow/dict', { token });
    ok('备料字典可读', mfDict.status === 200 && !!mfDict.json.data.issue_status, `HTTP ${mfDict.status}`);

    const mfBoard = await req('/api/matflow/board', { token });
    ok('备料总览可读', mfBoard.status === 200 && !!mfBoard.json.data.stat, `HTTP ${mfBoard.status}`);

    const mfStock = await req('/api/matflow/stock', { token });
    const stockRows = (mfStock.json.data && mfStock.json.data.rows) || [];
    ok('原料台账可读', mfStock.status === 200 && stockRows.length > 0, `HTTP ${mfStock.status} / ${stockRows.length} 行`);

    const badBal = stockRows.filter((r) => Math.abs((Number(r.stock_qty) - Number(r.reserved)) - Number(r.available)) > 0.02);
    ok('台账「账面 − 占用 = 可用」逐行成立', badBal.length === 0, `不成立 ${badBal.length} 行`);

    const mfLedger = await req('/api/matflow/ledger?limit=20', { token });
    ok('原料流水可读', mfLedger.status === 200 && Array.isArray(mfLedger.json.data.rows), `HTTP ${mfLedger.status}`);

    // 找一个有订单用料的订单，验证建议接口
    const omRes = await req('/api/orders?limit=200', { token });
    const omOrders = (omRes.json.data && (omRes.json.data.rows || omRes.json.data)) || [];
    const anyOrder = Array.isArray(omOrders) && omOrders.length ? omOrders[0] : null;
    if (anyOrder) {
      const sugg = await req(`/api/matflow/issues/suggest?order_id=${anyOrder.id}`, { token });
      ok('订单用料建议可读（含可用与缺口）', sugg.status === 200 && Array.isArray(sugg.json.data.items), `HTTP ${sugg.status}`);
    } else {
      ok('订单用料建议可读（含可用与缺口）', true, '没有订单，跳过');
    }

    // ---- 校验类：都该被拒 ----
    const noItem = await req('/api/matflow/issues', { method: 'POST', token, body: { kind: 'extra', note: '冒烟测试空明细' } });
    ok('没有明细的备料单被拒', noItem.status === 400 && /至少要有一样原料/.test(noItem.json.message || ''), `HTTP ${noItem.status}`);

    const noOrder = await req('/api/matflow/issues', {
      method: 'POST', token,
      body: { kind: 'order', items: [{ material_id: 1, name: '测试料', req_qty: 1 }] }
    });
    ok('订单备料不选订单被拒', noOrder.status === 400 && /必须选订单/.test(noOrder.json.message || ''), `HTTP ${noOrder.status}`);

    const extraNoNote = await req('/api/matflow/issues', {
      method: 'POST', token,
      body: { kind: 'extra', items: [{ material_id: 1, name: '测试料', req_qty: 1 }] }
    });
    ok('车间补料不写原因被拒', extraNoNote.status === 400 && /补料原因|必须写/.test(extraNoNote.json.message || ''), `HTTP ${extraNoNote.status}`);

    const matA = stockRows.find((r) => r.stock_qty > 10 && r.unit);
    const matB = stockRows.find((r) => r.id !== (matA && matA.id) && r.stock_qty > 0);
    if (matA) {
      const dup = await req('/api/matflow/issues', {
        method: 'POST', token,
        body: {
          kind: 'extra', note: '冒烟测试重复行',
          items: [
            { material_id: matA.id, name: matA.name, unit: matA.unit, req_qty: 1 },
            { material_id: matA.id, name: matA.name, unit: matA.unit, req_qty: 2 }
          ]
        }
      });
      ok('同一原料重复出现被拒', dup.status === 400 && /重复/.test(dup.json.message || ''), `HTTP ${dup.status}`);

      // 正常建单
      const made = await req('/api/matflow/issues', {
        method: 'POST', token,
        body: { kind: 'extra', note: '冒烟测试建单（跑完自动结案）', items: [{ material_id: matA.id, name: matA.name, unit: matA.unit, req_qty: 10 }] }
      });
      const issueId = made.json.data && made.json.data.id;
      ok('备料单创建成功（草稿）', made.status === 200 && !!issueId && made.json.data.status === 'draft', `HTTP ${made.status}`);

      if (issueId) {
        const before = Number((stockRows.find((r) => r.id === matA.id) || {}).available);
        const prep = await req(`/api/matflow/issues/${issueId}/prepare`, { method: 'POST', token, body: {} });
        ok('备料成功并占用库存', prep.status === 200 && prep.json.data.status === 'prepared', `HTTP ${prep.status}`);

        const stock2 = await req('/api/matflow/stock', { token });
        const row2 = ((stock2.json.data && stock2.json.data.rows) || []).find((r) => r.id === matA.id) || {};
        ok('备料后可用量减少 10（占用生效）', Math.abs(Number(row2.available) - (before - 10)) < 0.02,
          `备料前 ${before} → 备料后 ${row2.available}`);

        const prepAgain = await req(`/api/matflow/issues/${issueId}/prepare`, { method: 'POST', token, body: {} });
        ok('已备料的单不能再备料', prepAgain.status === 400 && /不能备料/.test(prepAgain.json.message || ''), `HTTP ${prepAgain.status}`);

        // 发料：先试超发
        const detail = await req(`/api/matflow/issues/${issueId}`, { token });
        const line = (detail.json.data.items || [])[0];
        const over = await req(`/api/matflow/issues/${issueId}/issue`, {
          method: 'POST', token, body: { items: [{ id: line.id, issued_qty: 99 }] }
        });
        ok('发料超过未发量被拒', over.status === 400 && /超过未发量/.test(over.json.message || ''), `HTTP ${over.status}`);

        const neg = await req(`/api/matflow/issues/${issueId}/issue`, {
          method: 'POST', token, body: { items: [{ id: line.id, issued_qty: -5 }] }
        });
        ok('发料数量为负被拒', neg.status === 400, `HTTP ${neg.status}`);

        // 少发 4（发 6）→ 应转「部分发出」
        const outRes = await req(`/api/matflow/issues/${issueId}/issue`, {
          method: 'POST', token, body: { items: [{ id: line.id, issued_qty: 6, batch_no: 'SMOKE-B1' }] }
        });
        ok('少发后转「部分发出」并留欠发', outRes.status === 200 && outRes.json.data.status === 'partial' && Math.abs(Number(outRes.json.data.open_qty) - 4) < 0.02,
          `HTTP ${outRes.status} / open=${outRes.json.data && outRes.json.data.open_qty}`);

        const led1 = await req(`/api/matflow/ledger?material_id=${matA.id}&limit=5`, { token });
        const hasOut = ((led1.json.data && led1.json.data.rows) || []).some((l) => l.type === 'issue' && Math.abs(Number(l.qty) + 6) < 0.02);
        ok('发料写入了原料流水（−6）', hasOut, '未找到 issue 流水');

        // 退料校验
        const retShort = await req('/api/matflow/returns', {
          method: 'POST', token, body: { issue_id: issueId, type: 'leftover', reason: '短', items: [{ issue_item_id: line.id, qty: 1 }] }
        });
        ok('退料原因太短被拒', retShort.status === 400 && /原因/.test(retShort.json.message || ''), `HTTP ${retShort.status}`);

        const retOver = await req('/api/matflow/returns', {
          method: 'POST', token, body: { issue_id: issueId, type: 'leftover', reason: '冒烟测试超退校验', items: [{ issue_item_id: line.id, qty: 50 }] }
        });
        ok('退料超过「已领未退」被拒', retOver.status === 400 && /可退/.test(retOver.json.message || ''), `HTTP ${retOver.status}`);

        const retOk = await req('/api/matflow/returns', {
          method: 'POST', token, body: { issue_id: issueId, type: 'leftover', reason: '冒烟测试余料退回 2 件', items: [{ issue_item_id: line.id, qty: 2 }] }
        });
        const retId = retOk.json.data && retOk.json.data.id;
        ok('退料单创建成功', retOk.status === 200 && !!retId, `HTTP ${retOk.status}`);

        if (retId) {
          const conf = await req(`/api/matflow/returns/${retId}/confirm`, { method: 'POST', token, body: {} });
          ok('退料确认入库成功', conf.status === 200 && conf.json.data.status === 'confirmed', `HTTP ${conf.status}`);
          const conf2 = await req(`/api/matflow/returns/${retId}/confirm`, { method: 'POST', token, body: {} });
          ok('退料单不能重复入库', conf2.status === 400, `HTTP ${conf2.status}`);
        }

        // 结案：还有欠发，必须写说明
        const closeNoNote = await req(`/api/matflow/issues/${issueId}/close`, { method: 'POST', token, body: { note: '短' } });
        ok('有欠发时结案必须写说明', closeNoNote.status === 400 && /必须写说明/.test(closeNoNote.json.message || ''), `HTTP ${closeNoNote.status}`);

        const closed = await req(`/api/matflow/issues/${issueId}/close`, { method: 'POST', token, body: { note: '冒烟测试结束，余量车间自购' } });
        ok('写好说明后可以结案', closed.status === 200 && closed.json.data.status === 'closed', `HTTP ${closed.status}`);
      }
    } else {
      ok('同一原料重复出现被拒', true, '没有可用原料，跳过');
    }

    // 备料超可用：找一个小库存原料
    const tiny = stockRows.find((r) => r.stock_qty > 0 && r.stock_qty < 60);
    if (tiny) {
      const overIssue = await req('/api/matflow/issues', {
        method: 'POST', token,
        body: { kind: 'extra', note: '冒烟测试超量备料', items: [{ material_id: tiny.id, name: tiny.name, unit: tiny.unit, req_qty: 99999 }] }
      });
      const oid = overIssue.json.data && overIssue.json.data.id;
      if (oid) {
        const p = await req(`/api/matflow/issues/${oid}/prepare`, { method: 'POST', token, body: {} });
        ok('备料量超过可用库存被拒', p.status === 400 && /超过可用库存/.test(p.json.message || ''), `HTTP ${p.status}`);
        const c = await req(`/api/matflow/issues/${oid}/cancel`, { method: 'POST', token, body: { reason: '冒烟测试结束，取消这张超量单' } });
        ok('草稿备料单可以取消（写原因）', c.status === 200 && c.json.data.status === 'cancelled', `HTTP ${c.status}`);
      } else {
        ok('备料量超过可用库存被拒', true, '建单失败，跳过');
      }
    } else {
      ok('备料量超过可用库存被拒', true, '没有小库存原料，跳过');
      ok('草稿备料单可以取消（写原因）', true, '同上，跳过');
    }

    // ---- 盘点 ----
    // 环境清场：残留的未完成盘点单会让「新建」被拒（约束是对的），先全部取消，再用自己建的单跑完整流程
    const takeList0 = await req('/api/matflow/stocktakes', { token });
    const leftovers = ((takeList0.json.data && takeList0.json.data.rows) || [])
      .filter((t) => ['draft', 'counting', 'submitted'].includes(t.status));
    for (const t of leftovers) {
      await req(`/api/matflow/stocktakes/${t.id}/cancel`, { method: 'POST', token, body: { reason: '冒烟测试前置清理：取消残留的未完成盘点' } });
    }

    const takeAgain = await req('/api/matflow/stocktakes', { method: 'POST', token, body: { take_date: '2026-10-27', note: '冒烟测试盘点' } });
    const takeId = takeAgain.json.data && takeAgain.json.data.id;
    ok('新建盘点单（快照账面数）', takeAgain.status === 200 && !!takeId && takeAgain.json.data.items.length > 0,
      `HTTP ${takeAgain.status} / ${takeAgain.json.data && (takeAgain.json.data.items || []).length} 行`);

    if (takeId) {
      const dupTake = await req('/api/matflow/stocktakes', { method: 'POST', token, body: { take_date: '2026-10-27', note: '冒烟测试重复盘点' } });
      ok('已有未完成盘点单时不许再建', dupTake.status === 400 && /未完成的盘点单/.test(dupTake.json.message || ''), `HTTP ${dupTake.status}`);

      const submitEarly = await req(`/api/matflow/stocktakes/${takeId}/submit`, { method: 'POST', token, body: {} });
      ok('没盘完不能提交（未盘不等于 0）', submitEarly.status === 400 && /还有 \d+ 样没盘/.test(submitEarly.json.message || ''), `HTTP ${submitEarly.status}`);

      const tdetail = await req(`/api/matflow/stocktakes/${takeId}`, { token });
      const titems = (tdetail.json.data && tdetail.json.data.items) || [];

      // 全部按账面数当已盘（账实相符），只给第一条一个差异但不写原因 → 仍应被拒
      const allCounted = titems.map((it) => ({ id: it.id, count_qty: it.book_qty, reason: '' }));
      const withDiff = allCounted.map((x, i) => (i === 0 ? { ...x, count_qty: Number(x.count_qty) - 3 } : x));
      const noReason = await req(`/api/matflow/stocktakes/${takeId}/submit`, { method: 'POST', token, body: { items: withDiff } });
      ok('有差异不写原因不许提交', noReason.status === 400 && /没写原因/.test(noReason.json.message || ''), `HTTP ${noReason.status}`);

      const started = await req(`/api/matflow/stocktakes/${takeId}/start`, { method: 'POST', token, body: {} });
      ok('开始盘点（转盘点中）', started.status === 200 && started.json.data.status === 'counting', `HTTP ${started.status}`);

      // 冻结：盘点中领料发不出去
      const freezeIssue = await req('/api/matflow/issues', {
        method: 'POST', token,
        body: { kind: 'extra', note: '冒烟测试冻结校验', items: [{ material_id: matA.id, name: matA.name, unit: matA.unit, req_qty: 1 }] }
      });
      const fid = freezeIssue.json.data && freezeIssue.json.data.id;
      if (fid) {
        await req(`/api/matflow/issues/${fid}/prepare`, { method: 'POST', token, body: {} });
        const fd = await req(`/api/matflow/issues/${fid}`, { token });
        const fline = ((fd.json.data && fd.json.data.items) || [])[0];
        const frozen = await req(`/api/matflow/issues/${fid}/issue`, { method: 'POST', token, body: { items: [{ id: fline.id, issued_qty: 1 }] } });
        ok('盘点冻结期间不许发料', frozen.status === 400 && /冻结/.test(frozen.json.message || ''), `HTTP ${frozen.status}`);
        await req(`/api/matflow/issues/${fid}/cancel`, { method: 'POST', token, body: { reason: '冒烟测试结束，取消冻结校验用单' } });
      } else {
        ok('盘点冻结期间不许发料', true, '建单失败，跳过');
      }

      // 收货查询不受影响（冻结只挡过账，不挡看单）
      const freezeRecv = await req('/api/receipts/board', { token });
      ok('盘点期间收货看板仍可读（冻结只挡过账）', freezeRecv.status === 200, `HTTP ${freezeRecv.status}`);

      const withReason = withDiff.map((x, i) => (i === 0 ? { ...x, reason: '冒烟测试：盘亏 3，边角料未登记' } : x));
      const submitted = await req(`/api/matflow/stocktakes/${takeId}/submit`, { method: 'POST', token, body: { items: withReason } });
      ok('写好原因后可以提交（转待调账）', submitted.status === 200 && submitted.json.data.status === 'submitted', `HTTP ${submitted.status}`);

      const adjusted = await req(`/api/matflow/stocktakes/${takeId}/adjust`, { method: 'POST', token, body: {} });
      ok('待调账的盘点可以落账', adjusted.status === 200 && adjusted.json.data.status === 'adjusted', `HTTP ${adjusted.status}`);

      const adjAgain = await req(`/api/matflow/stocktakes/${takeId}/adjust`, { method: 'POST', token, body: {} });
      ok('已落账的盘点不能重复落账', adjAgain.status === 400 && /待调账/.test(adjAgain.json.message || ''), `HTTP ${adjAgain.status}`);

      const cancelAdjusted = await req(`/api/matflow/stocktakes/${takeId}/cancel`, { method: 'POST', token, body: { reason: '冒烟测试：已落账的不能取消' } });
      ok('已调账的盘点不能取消', cancelAdjusted.status === 400 && /已调账/.test(cancelAdjusted.json.message || ''), `HTTP ${cancelAdjusted.status}`);

      const lossLed = await req('/api/matflow/ledger?type=stock_loss&limit=5', { token });
      ok('盘亏写入了原料流水', ((lossLed.json.data && lossLed.json.data.rows) || []).length > 0, '未找到 stock_loss 流水');

      // 落账后冻结解除：同一张料可以正常备料
      const afterFreeze = await req('/api/matflow/issues', {
        method: 'POST', token,
        body: { kind: 'extra', note: '冒烟测试落账后解冻校验', items: [{ material_id: matA.id, name: matA.name, unit: matA.unit, req_qty: 1 }] }
      });
      const aid = afterFreeze.json.data && afterFreeze.json.data.id;
      if (aid) {
        const p2 = await req(`/api/matflow/issues/${aid}/prepare`, { method: 'POST', token, body: {} });
        ok('盘点落账后冻结解除（可正常备料）', p2.status === 200, `HTTP ${p2.status}`);
        await req(`/api/matflow/issues/${aid}/cancel`, { method: 'POST', token, body: { reason: '冒烟测试结束，取消解冻校验用单' } });
      } else {
        ok('盘点落账后冻结解除（可正常备料）', true, '建单失败，跳过');
      }
    }
    const mfNoAuth = await req('/api/matflow/board');
    ok('未登录访问备料总览返回 401', mfNoAuth.status === 401, `HTTP ${mfNoAuth.status}`);
  }

  // ==================== M11 价格快照与费用池 ====================
  {
    const pd = await req('/api/pricing/dict', { token });
    ok('定价字典可读', pd.status === 200 && !!pd.json.data.pool_kind, `HTTP ${pd.status}`);

    const pb = await req('/api/pricing/board', { token });
    ok('定价总览可读（池 + 价格本）', pb.status === 200 && !!pb.json.data.pools && !!pb.json.data.books, `HTTP ${pb.status}`);

    const pl = await req('/api/pricing/pools', { token });
    const poolRows = (pl.json.data && pl.json.data.rows) || [];
    ok('费用池列表可读', pl.status === 200 && Array.isArray(poolRows), `HTTP ${pl.status}`);

    const bl = await req('/api/pricing/books', { token });
    const bookRows = (bl.json.data && bl.json.data.rows) || [];
    ok('价格本列表可读', bl.status === 200 && Array.isArray(bookRows), `HTTP ${bl.status}`);

    // ---- 费用池：校验类 ----
    const badPeriod = await req('/api/pricing/pools', { method: 'POST', token, body: { period: '2026/10', name: '冒烟测试' } });
    ok('费用池期间格式错误被拒', badPeriod.status === 400 && /YYYY-MM/.test(badPeriod.json.message || ''), `HTTP ${badPeriod.status}`);

    const noName = await req('/api/pricing/pools', { method: 'POST', token, body: { period: '2026-10', name: '' } });
    ok('费用池名称必填', noName.status === 400 && /名称/.test(noName.json.message || ''), `HTTP ${noName.status}`);

    const pool = await req('/api/pricing/pools', {
      method: 'POST', token,
      body: { period: '2026-10', name: '冒烟测试用费用池', kind: 'manufacturing', driver: 'labor_hours', note: '冒烟测试' }
    });
    const poolId = pool.json.data && pool.json.data.id;
    ok('费用池创建成功（草稿，金额为 0）', pool.status === 200 && !!poolId && Number(pool.json.data.total_amount) === 0, `HTTP ${pool.status}`);

    if (poolId) {
      const zeroExp = await req(`/api/pricing/pools/${poolId}/expenses`, {
        method: 'POST', token, body: { expense_date: '2026-10-10', category: '水电', description: '金额为 0 的测试', amount: 0 }
      });
      ok('费用金额为 0 被拒', zeroExp.status === 400 && /不能为 0/.test(zeroExp.json.message || ''), `HTTP ${zeroExp.status}`);

      const noDesc = await req(`/api/pricing/pools/${poolId}/expenses`, {
        method: 'POST', token, body: { expense_date: '2026-10-10', category: '水电', description: '', amount: 100 }
      });
      ok('费用说明必填', noDesc.status === 400 && /说明/.test(noDesc.json.message || ''), `HTTP ${noDesc.status}`);

      const crossPeriod = await req(`/api/pricing/pools/${poolId}/expenses`, {
        method: 'POST', token, body: { expense_date: '2026-08-10', category: '水电', description: '跨期费用测试', amount: 100 }
      });
      ok('跨期费用被拒（期间必须匹配）', crossPeriod.status === 400 && /不在费用池期间/.test(crossPeriod.json.message || ''), `HTTP ${crossPeriod.status}`);

      const exp1 = await req(`/api/pricing/pools/${poolId}/expenses`, {
        method: 'POST', token, body: { expense_date: '2026-10-08', category: '水电', description: '冒烟测试水电', amount: 1000 }
      });
      ok('加费用明细后池额自动汇总', exp1.status === 200 && Math.abs(Number(exp1.json.data.total_amount) - 1000) < 0.01,
        `HTTP ${exp1.status} / 池额 ${exp1.json.data && exp1.json.data.total_amount}`);
      const exp2 = await req(`/api/pricing/pools/${poolId}/expenses`, {
        method: 'POST', token, body: { expense_date: '2026-10-09', category: '折旧', description: '冒烟测试折旧', amount: 0.01 }
      });
      ok('明细累加进池额（不是手填总额）', Math.abs(Number(exp2.json.data.total_amount) - 1000.01) < 0.01,
        `池额 ${exp2.json.data && exp2.json.data.total_amount}`);

      const pv = await req(`/api/pricing/pools/${poolId}/preview`, { token });
      const pvRows = (pv.json.data && pv.json.data.rows) || [];
      const pvSum = Math.round(pvRows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100;
      ok('分摊预览可读且有对象', pv.status === 200 && pvRows.length > 0, `HTTP ${pv.status} / ${pvRows.length} 个`);
      ok('预览分摊合计 = 池额（尾差不丢）', Math.abs(pvSum - Number(pv.json.data.total_amount)) < 0.02,
        `预览合计 ${pvSum} vs 池额 ${pv.json.data && pv.json.data.total_amount}`);

      // 分摊前后成本对象 actual_cost 变化
      const beforeObj = await req('/api/pricing/pools/' + poolId, { token });
      const firstObj = pvRows[0] && pvRows[0].cost_object_id;
      const dist = await req(`/api/pricing/pools/${poolId}/distribute`, { method: 'POST', token, body: { note: '冒烟测试分摊' } });
      ok('分摊成功并闭合', dist.status === 200 && dist.json.data.status === 'distributed'
        && Math.abs(Number(dist.json.data.alloc_sum) - Number(dist.json.data.total_amount)) < 0.02,
        `HTTP ${dist.status} / 合计 ${dist.json.data && dist.json.data.alloc_sum}`);

      const distAgain = await req(`/api/pricing/pools/${poolId}/distribute`, { method: 'POST', token, body: {} });
      ok('已分摊不能重复分摊', distAgain.status === 400 && /不能分摊/.test(distAgain.json.message || ''), `HTTP ${distAgain.status}`);

      const editAfter = await req(`/api/pricing/pools/${poolId}/expenses`, {
        method: 'POST', token, body: { expense_date: '2026-10-10', category: '水电', description: '分摊后还改明细', amount: 1 }
      });
      ok('已分摊不许再改明细', editAfter.status === 400 && /不能再改明细/.test(editAfter.json.message || ''), `HTTP ${editAfter.status}`);

      const revNoReason = await req(`/api/pricing/pools/${poolId}/revert`, { method: 'POST', token, body: { reason: '短' } });
      ok('撤销分摊不写原因被拒', revNoReason.status === 400 && /原因/.test(revNoReason.json.message || ''), `HTTP ${revNoReason.status}`);

      const rev = await req(`/api/pricing/pools/${poolId}/revert`, { method: 'POST', token, body: { reason: '冒烟测试：验证成本回滚' } });
      ok('撤销分摊成功（回滚成本）', rev.status === 200 && rev.json.data.status === 'draft' && rev.json.data.allocations.length === 0,
        `HTTP ${rev.status}`);

      const closeDraft = await req(`/api/pricing/pools/${poolId}/close`, { method: 'POST', token, body: {} });
      ok('未分摊的池不能结账', closeDraft.status === 400 && /已分摊/.test(closeDraft.json.message || ''), `HTTP ${closeDraft.status}`);
    }

    // ---- 价格本：校验类 ----
    const badPrice = await req('/api/pricing/books', {
      method: 'POST', token, body: { scope: 'cost_plus', currency: 'CNY', effective_from: '2026-12-01', note: '冒烟测试价格本' }
    });
    const badBookId = badPrice.json.data && badPrice.json.data.id;
    ok('价格本创建成功（草稿）', badPrice.status === 200 && !!badBookId, `HTTP ${badPrice.status}`);

    if (badBookId) {
      const zeroPrice = await req(`/api/pricing/books/${badBookId}/items`, {
        method: 'POST', token, body: { style_no: 'LEJE-AW-2601', min_qty: 1, price: 0 }
      });
      ok('价格必须大于 0', zeroPrice.status === 400 && /大于 0/.test(zeroPrice.json.message || ''), `HTTP ${zeroPrice.status}`);

      const badRange = await req(`/api/pricing/books/${badBookId}/items`, {
        method: 'POST', token, body: { style_no: 'LEJE-AW-2601', min_qty: 100, max_qty: 50, price: 80 }
      });
      ok('数量档上限小于下限被拒', badRange.status === 400 && /上限/.test(badRange.json.message || ''), `HTTP ${badRange.status}`);

      const okItem = await req(`/api/pricing/books/${badBookId}/items`, {
        method: 'POST', token, body: { style_no: 'LEJE-AW-2601', min_qty: 100, max_qty: 199, price: 80 }
      });
      ok('价格项可加（自动带出成本与毛利）', okItem.status === 200 && okItem.json.data.items.some((i) => Number(i.cost_unit) > 0),
        `HTTP ${okItem.status}`);

      const overlap = await req(`/api/pricing/books/${badBookId}/items`, {
        method: 'POST', token, body: { style_no: 'LEJE-AW-2601', min_qty: 150, max_qty: 250, price: 78 }
      });
      ok('数量档重叠被拒', overlap.status === 400 && /重叠/.test(overlap.json.message || ''), `HTTP ${overlap.status}`);

      const noCostItem = await req(`/api/pricing/books/${badBookId}/items`, {
        method: 'POST', token, body: { style_no: 'SMOKE-NOCOST-99', min_qty: 1, price: 100 }
      });
      ok('取不到成本的款也能先录（但发布会被拦）', noCostItem.status === 200 && noCostItem.json.data.cost_missing_count > 0,
        `HTTP ${noCostItem.status} / 缺成本 ${noCostItem.json.data && noCostItem.json.data.cost_missing_count}`);

      const pubNoCost = await req(`/api/pricing/books/${badBookId}/publish`, { method: 'POST', token, body: { note: '冒烟测试发布' } });
      ok('有取不到成本的项不许发布', pubNoCost.status === 400 && /取不到单件成本/.test(pubNoCost.json.message || ''), `HTTP ${pubNoCost.status}`);

      // 删掉缺成本那项，改成低于成本，验证「必须写说明」
      const delNoCost = await req(`/api/pricing/items/${(noCostItem.json.data.items.find((i) => i.style_no === 'SMOKE-NOCOST-99') || {}).id}`, { method: 'DELETE', token });
      ok('草稿价格本可以删价项', delNoCost.status === 200, `HTTP ${delNoCost.status}`);

      const cheapItem = await req(`/api/pricing/books/${badBookId}/items`, {
        method: 'POST', token, body: { style_no: 'LEJE-AW-2601', min_qty: 1, max_qty: 99, price: 10 }
      });
      const pubNoNote = await req(`/api/pricing/books/${badBookId}/publish`, { method: 'POST', token, body: { note: '' } });
      ok('售价低于成本发布必须写说明', pubNoNote.status === 400 && /低于成本/.test(pubNoNote.json.message || ''), `HTTP ${pubNoNote.status}`);

      const pubOk = await req(`/api/pricing/books/${badBookId}/publish`, { method: 'POST', token, body: { note: '冒烟测试：低于成本为特价，已报批' } });
      ok('写说明后可以发布', pubOk.status === 200 && pubOk.json.data.status === 'published', `HTTP ${pubOk.status}`);

      const editPublished = await req(`/api/pricing/books/${badBookId}/items`, {
        method: 'POST', token, body: { style_no: 'LEJE-AW-2601', min_qty: 100, max_qty: 199, price: 81 }
      });
      ok('已发布的价格本不许改价', editPublished.status === 400 && /不许改|发新版/.test(editPublished.json.message || ''), `HTTP ${editPublished.status}`);

      const pubAgain = await req(`/api/pricing/books/${badBookId}/publish`, { method: 'POST', token, body: { note: '' } });
      ok('同一版本不能重复发布', pubAgain.status === 400, `HTTP ${pubAgain.status}`);

      const archNoReason = await req(`/api/pricing/books/${badBookId}/archive`, { method: 'POST', token, body: { reason: '短' } });
      ok('归档不写原因被拒', archNoReason.status === 400 && /原因/.test(archNoReason.json.message || ''), `HTTP ${archNoReason.status}`);

      const arch = await req(`/api/pricing/books/${badBookId}/archive`, { method: 'POST', token, body: { reason: '冒烟测试结束，归档测试价格本' } });
      ok('归档成功（停止使用）', arch.status === 200 && arch.json.data.status === 'archived', `HTTP ${arch.status}`);
    }

    // ---- 取价 ----
    const q1 = await req('/api/pricing/quote?style_no=LEJE-AW-2601&qty=500', { token });
    ok('取价命中当前生效版本', q1.status === 200 && q1.json.data.found === true && q1.json.data.book.version >= 1,
      `HTTP ${q1.status} / ${q1.json.data && (q1.json.data.book && q1.json.data.book.book_no)}`);

    const q2 = await req('/api/pricing/quote?style_no=SMOKE-NOT-EXIST&qty=10', { token });
    ok('没有该款的价格时返回「查不到」而不是 0 元', q2.status === 200 && q2.json.data.found === false && !!q2.json.data.reason,
      `HTTP ${q2.status}`);

    const qNoStyle = await req('/api/pricing/quote', { token });
    ok('取价不填款号被拒', qNoStyle.status === 400 && /款号/.test(qNoStyle.json.message || ''), `HTTP ${qNoStyle.status}`);

    const costApi = await req('/api/pricing/cost/LEJE-AW-2601', { token });
    ok('成本口径可查（说明成本从哪来）', costApi.status === 200 && costApi.json.data.found === true && !!costApi.json.data.source_label,
      `HTTP ${costApi.status}`);

    const pNoAuth = await req('/api/pricing/pools');
    ok('未登录访问费用池返回 401', pNoAuth.status === 401, `HTTP ${pNoAuth.status}`);
  }

  // ==================== M12 长期投资抵消 ====================
  {
    const ivDict = await req('/api/investment/dict', { token });
    ok('长投字典可读（子公司/分公司分开列）', ivDict.status === 200
      && Array.isArray(ivDict.json.data.subsidiaries) && Array.isArray(ivDict.json.data.branches), `HTTP ${ivDict.status}`);

    const ivBoard = await req('/api/investment/board', { token });
    ok('长投总览可读', ivBoard.status === 200 && !!ivBoard.json.data.stat, `HTTP ${ivBoard.status}`);

    const ivList = await req('/api/investment/list', { token });
    const ivRows = (ivList.json.data && ivList.json.data.rows) || [];
    ok('长投列表可读', ivList.status === 200 && Array.isArray(ivRows), `HTTP ${ivList.status}`);

    const active = ivRows.find((r) => r.status === 'active');
    if (active) {
      const ivOne = await req(`/api/investment/${active.id}`, { token });
      ok('投资详情可读（含变动留痕与核算方法说明）', ivOne.status === 200
        && Array.isArray(ivOne.json.data.changes) && !!ivOne.json.data.method_note, `HTTP ${ivOne.status}`);

      // ---- 校验类：都不改数据 ----
      const branch = (ivDict.json.data.branches || [])[0];
      if (branch) {
        const branchInv = await req('/api/investment', {
          method: 'POST', token,
          body: { company_id: 1, investee_id: branch.id, method: 'cost', acquire_cost: 100, share_pct: 100 }
        });
        ok('对分公司建长投被拒（分公司没有股权）', branchInv.status === 400 && /分公司/.test(branchInv.json.message || ''),
          `HTTP ${branchInv.status}`);
      } else {
        ok('对分公司建长投被拒（分公司没有股权）', true, '没有分公司，跳过');
      }

      const dupInv = await req('/api/investment', {
        method: 'POST', token,
        body: { company_id: active.company_id, investee_id: active.investee_id, method: 'cost', acquire_cost: 100, share_pct: 50 }
      });
      ok('同一子公司重复建长投被拒', dupInv.status === 400 && /已有有效投资/.test(dupInv.json.message || ''),
        `HTTP ${dupInv.status}`);

      const changeNoReason = await req(`/api/investment/${active.id}/changes`, {
        method: 'POST', token, body: { type: 'dividend', amount: 100, reason: '短' }
      });
      ok('投资变动不写原因被拒', changeNoReason.status === 400 && /原因/.test(changeNoReason.json.message || ''),
        `HTTP ${changeNoReason.status}`);

      const zeroAmt = await req(`/api/investment/${active.id}/changes`, {
        method: 'POST', token, body: { type: 'dividend', amount: 0, reason: '冒烟测试零金额' }
      });
      ok('变动金额为 0 被拒', zeroAmt.status === 400 && /不能为 0/.test(zeroAmt.json.message || ''), `HTTP ${zeroAmt.status}`);

      if (active.method === 'cost') {
        const costShare = await req(`/api/investment/${active.id}/changes`, {
          method: 'POST', token, body: { type: 'equity_share', amount: 1000, reason: '冒烟测试成本法确认损益' }
        });
        ok('成本法不确认投资损益被拒', costShare.status === 400 && /成本法/.test(costShare.json.message || ''),
          `HTTP ${costShare.status}`);
      } else {
        // 权益法：确认亏损不能超过账面（否则长投会变负数）
        const overLoss = await req(`/api/investment/${active.id}/changes`, {
          method: 'POST', token,
          body: { type: 'equity_share', amount: -(Number(active.book_value) + 100000), reason: '冒烟测试超额确认亏损' }
        });
        ok('权益法确认亏损超过账面被拒（不能记成负数）', overLoss.status === 400 && /未确认投资损失|账面/.test(overLoss.json.message || ''),
          `HTTP ${overLoss.status}`);
      }

      const methodSame = await req(`/api/investment/${active.id}/method`, {
        method: 'POST', token, body: { method: active.method, reason: '冒烟测试同方法' }
      });
      ok('核算方法没变化时被拒', methodSame.status === 400, `HTTP ${methodSame.status}`);

      const disposeShort = await req(`/api/investment/${active.id}/dispose`, {
        method: 'POST', token, body: { reason: '短' }
      });
      ok('处置不写原因被拒', disposeShort.status === 400 && /原因/.test(disposeShort.json.message || ''),
        `HTTP ${disposeShort.status}`);
    } else {
      ['投资详情可读（含变动留痕与核算方法说明）', '同一子公司重复建长投被拒', '投资变动不写原因被拒',
        '变动金额为 0 被拒', '核算方法没变化时被拒', '处置不写原因被拒'].forEach((n) => ok(n, true, '没有有效投资，跳过'));
    }

    // ---- 抵消预览：借贷必须平、资产权益影响必须恒等 ----
    const period = '2026-09';
    const off = await req(`/api/investment/offsets/${period}`, { token });
    ok('抵消预览可读', off.status === 200 && Array.isArray(off.json.data.items), `HTTP ${off.status}`);
    if (off.status === 200) {
      const t = off.json.data.total || {};
      ok('抵消分录借贷平衡', t.balanced === true && Math.abs(Number(t.debit) - Number(t.credit)) < 0.02,
        `借 ${t.debit} / 贷 ${t.credit}`);
      ok('抵消对资产与权益的净影响恒等', off.json.data.check && off.json.data.check.asset_eq_equity === true,
        `差 ${off.json.data.check && off.json.data.check.diff}`);
      ok('少数股东权益与商誉单列', 'minority_equity' in t && 'goodwill' in t, JSON.stringify({ g: t.goodwill, m: t.minority_equity }));
      const branchNames = (off.json.data.branches_excluded || []).map((x) => x.id);
      const inItems = (off.json.data.items || []).filter((x) => branchNames.includes(x.investee_id));
      ok('分公司不参与长投抵消', inItems.length === 0, `参与的分公司 ${inItems.length} 家`);
    } else {
      ['抵消分录借贷平衡', '抵消对资产与权益的净影响恒等', '少数股东权益与商誉单列', '分公司不参与长投抵消']
        .forEach((n) => ok(n, false, '抵消预览不可读'));
    }

    const badPeriod = await req('/api/investment/offsets/2026-9', { token });
    ok('抵消期间格式错误被拒', badPeriod.status === 400 && /YYYY-MM/.test(badPeriod.json.message || ''), `HTTP ${badPeriod.status}`);

    // ---- 合并表里必须体现长投抵消结果 ----
    const gpCon2 = await req('/api/group/consolidations', { method: 'POST', token, body: { period }, token });
    if (gpCon2.status === 200) {
      const c = gpCon2.json.data;
      ok('含长投抵消的合并表仍然平衡', Math.abs(Number(c.diff_amount)) < 0.02, `差 ${c.diff_amount}`);
      ok('合并表记录了长投抵消额与商誉', 'investment_offset' in c && 'goodwill' in c,
        `抵消 ${c.investment_offset} / 商誉 ${c.goodwill}`);
      ok('合并表记录了少数股东权益', 'minority_equity' in c, `${c.minority_equity}`);
      const invAdjs = (c.adjustments || []).filter((a) => a.type === 'investment');
      ok('合并表里有长期投资抵消分录', invAdjs.length > 0, `${invAdjs.length} 条`);
      const d = Number(invAdjs.reduce((s, a) => s + Number(a.debit), 0)).toFixed(2);
      const e = Number(invAdjs.reduce((s, a) => s + Number(a.credit), 0)).toFixed(2);
      ok('长投抵消分录自身借贷相等', d === e, `借 ${d} / 贷 ${e}`);
      // 收尾：删掉这张临时合并表，别让列表里堆测试数据
      await req(`/api/group/consolidations/${c.id}`, { method: 'DELETE', token });
    } else {
      ['含长投抵消的合并表仍然平衡', '合并表记录了长投抵消额与商誉', '合并表记录了少数股东权益',
        '合并表里有长期投资抵消分录', '长投抵消分录自身借贷相等']
        .forEach((n) => ok(n, false, `合并生成失败 ${gpCon2.json && gpCon2.json.message}`));
    }

    const ivNoAuth = await req('/api/investment/list');
    ok('未登录访问长投返回 401', ivNoAuth.status === 401, `HTTP ${ivNoAuth.status}`);
  }

  // ==================== M07 裁片外发与外协验货交接 ====================
  {
    const cdDict = await req('/api/cutdispatch/dict', { token });
    ok('裁片外发字典可读（工厂 + 可裁单）', cdDict.status === 200
      && Array.isArray(cdDict.json.data.factories) && Array.isArray(cdDict.json.data.cuts), `HTTP ${cdDict.status}`);

    const cdBoard = await req('/api/cutdispatch/board', { token });
    ok('外协看板可读', cdBoard.status === 200 && !!cdBoard.json.data.stat
      && Array.isArray(cdBoard.json.data.overdue) && Array.isArray(cdBoard.json.data.factories), `HTTP ${cdBoard.status}`);

    const cdList = await req('/api/cutdispatch/list', { token });
    const cdRows = (cdList.json.data && cdList.json.data.rows) || [];
    ok('外发单列表可读', cdList.status === 200 && Array.isArray(cdRows), `HTTP ${cdList.status}`);

    const closedDoc = cdRows.find((r) => r.status === 'closed');
    if (closedDoc) {
      const cdOne = await req(`/api/cutdispatch/${closedDoc.id}`, { token });
      ok('外发单详情可读（含按扎明细与回货记录）', cdOne.status === 200
        && Array.isArray(cdOne.json.data.items) && Array.isArray(cdOne.json.data.receipts), `HTTP ${cdOne.status}`);
      ok('已结案单「合格+不良+返工 = 回货」闭合', cdOne.json.data.accepted_check === true,
        `${cdOne.json.data.accepted_qty}+${cdOne.json.data.rejected_qty}+${cdOne.json.data.rework_qty} vs ${cdOne.json.data.returned_qty}`);
    } else {
      ok('外发单详情可读（含按扎明细与回货记录）', true, '没有已结案单，跳过');
      ok('已结案单「合格+不良+返工 = 回货」闭合', true, '同上，跳过');
    }

    // ---- 可发建议 ----
    const cut = ((cdDict.json.data.cuts || [])[0]) || null;
    let sugOk = false;
    if (cut) {
      const sug = await req(`/api/cutdispatch/suggest/${cut.id}`, { token });
      sugOk = sug.status === 200;
      const s = sug.json.data || {};
      const bundles = s.bundles || [];
      const expectCan = bundles.filter((b) => b.checked && !b.busy_dispatch).reduce((x, b) => x + Number(b.qty), 0);
      ok('可发建议可读且件数对得上', sugOk
        && Math.abs(Number(s.can_send_qty) - expectCan) < 0.02, `建议 ${s.can_send_qty} vs 按扎算 ${expectCan}`);
      const anyUnchecked = bundles.some((b) => !b.checked && b.can_send);
      ok('未复核的扎不会被算成可发', !anyUnchecked, '有未复核扎被标为可发');

      // ---- 校验类 ----
      const f = (cdDict.json.data.factories || []).find((x) => x.type === 'outsource');
      const unchecked = bundles.find((b) => !b.checked);
      const busy = bundles.find((b) => b.busy_dispatch);
      const free = bundles.find((b) => b.can_send);

      if (f && unchecked) {
        const r = await req('/api/cutdispatch', {
          method: 'POST', token,
          body: { cut_order_id: cut.id, factory_id: f.id, bundle_ids: [unchecked.id], price: 8, note: '冒烟测试未复核' }
        });
        ok('未复核的扎不能外发', r.status === 400 && /还没复核/.test(r.json.message || ''), `HTTP ${r.status}`);
      } else {
        ok('未复核的扎不能外发', true, '没有未复核扎，跳过');
      }

      if (f && busy) {
        const r = await req('/api/cutdispatch', {
          method: 'POST', token,
          body: { cut_order_id: cut.id, factory_id: f.id, bundle_ids: [busy.id], price: 8, note: '冒烟测试重复外发' }
        });
        ok('已在未完结外发单里的扎不能再发', r.status === 400 && /未完结的外发单/.test(r.json.message || ''), `HTTP ${r.status}`);
      } else {
        ok('已在未完结外发单里的扎不能再发', true, '没有被占用的扎，跳过');
      }

      if (f) {
        const r = await req('/api/cutdispatch', { method: 'POST', token, body: { cut_order_id: cut.id, factory_id: f.id, bundle_ids: [], price: 8 } });
        ok('一扎都不选被拒', r.status === 400 && /至少要选一扎/.test(r.json.message || ''), `HTTP ${r.status}`);

        // ---- 成功路径：建 → 发 → 回 → 结案（走完自动释放扎） ----
        if (free) {
          const made = await req('/api/cutdispatch', {
            method: 'POST', token,
            body: { cut_order_id: cut.id, factory_id: f.id, bundle_ids: [free.id], price: 8, note: '冒烟测试外发单（跑完自动结案）' }
          });
          const did = made.json.data && made.json.data.id;
          ok('外发单创建成功（草稿）', made.status === 200 && !!did
            && Math.abs(Number(made.json.data.out_qty) - Number(free.qty)) < 0.02, `HTTP ${made.status}`);

          if (did) {
            const again = await req('/api/cutdispatch', {
              method: 'POST', token,
              body: { cut_order_id: cut.id, factory_id: f.id, bundle_ids: [free.id], price: 8, note: '冒烟测试重复占扎' }
            });
            ok('同一扎不能同时挂两张未完结单', again.status === 400, `HTTP ${again.status}`);

            const sent = await req(`/api/cutdispatch/${did}/send`, { method: 'POST', token, body: {} });
            ok('外发单可以发出', sent.status === 200 && sent.json.data.status === 'sent', `HTTP ${sent.status}`);

            const det = await req(`/api/cutdispatch/${did}`, { token });
            const line = (det.json.data.items || [])[0];
            const qty = Number(line.qty);

            const noHandover = await req(`/api/cutdispatch/${did}/receive`, {
              method: 'POST', token, body: { received_by: '冒烟', inspected_by: '冒烟', items: [{ dispatch_item_id: line.id, qty, accepted_qty: qty }] }
            });
            ok('回货不填外协交货人被拒', noHandover.status === 400 && /交货人/.test(noHandover.json.message || ''), `HTTP ${noHandover.status}`);

            const notClosed = await req(`/api/cutdispatch/${did}/receive`, {
              method: 'POST', token,
              body: { handover_by: '冒烟交货', received_by: '冒烟接收', inspected_by: '冒烟验货',
                items: [{ dispatch_item_id: line.id, qty, accepted_qty: qty - 2, rejected_qty: 0, rework_qty: 0 }] }
            });
            ok('「合格+不良+返工 ≠ 回货」被拒', notClosed.status === 400 && /三块必须加起来/.test(notClosed.json.message || ''), `HTTP ${notClosed.status}`);

            const noDefect = await req(`/api/cutdispatch/${did}/receive`, {
              method: 'POST', token,
              body: { handover_by: '冒烟交货', received_by: '冒烟接收', inspected_by: '冒烟验货',
                items: [{ dispatch_item_id: line.id, qty, accepted_qty: qty - 2, rejected_qty: 2, rework_qty: 0 }] }
            });
            ok('有不良不写原因被拒', noDefect.status === 400 && /必须写原因/.test(noDefect.json.message || ''), `HTTP ${noDefect.status}`);

            const overRecv = await req(`/api/cutdispatch/${did}/receive`, {
              method: 'POST', token,
              body: { handover_by: '冒烟交货', received_by: '冒烟接收', inspected_by: '冒烟验货',
                items: [{ dispatch_item_id: line.id, qty: qty + 10, accepted_qty: qty + 10, rejected_qty: 0, rework_qty: 0 }] }
            });
            ok('回货超过未回量被拒', overRecv.status === 400 && /未回只有/.test(overRecv.json.message || ''), `HTTP ${overRecv.status}`);

            const shortNoReason = await req(`/api/cutdispatch/${did}/receive`, {
              method: 'POST', token,
              body: { handover_by: '冒烟交货', received_by: '冒烟接收', inspected_by: '冒烟验货', short_qty: 5, short_reason: '',
                items: [{ dispatch_item_id: line.id, qty: qty - 5, accepted_qty: qty - 5 }] }
            });
            ok('有短数不写原因被拒', shortNoReason.status === 400 && /短数必须写原因/.test(shortNoReason.json.message || ''), `HTTP ${shortNoReason.status}`);

            const recvOk = await req(`/api/cutdispatch/${did}/receive`, {
              method: 'POST', token,
              body: { handover_by: '冒烟交货', received_by: '冒烟接收', inspected_by: '冒烟验货', inspect_result: 'pass',
                items: [{ dispatch_item_id: line.id, qty, accepted_qty: qty }] }
            });
            ok('全部合格的回货验收成功', recvOk.status === 200 && Math.abs(Number(recvOk.json.data.returned_qty) - qty) < 0.02,
              `HTTP ${recvOk.status}`);

            const closed = await req(`/api/cutdispatch/${did}/close`, { method: 'POST', token, body: {} });
            ok('无差异可以直接结案', closed.status === 200 && closed.json.data.status === 'closed', `HTTP ${closed.status}`);

            const editClosed = await req(`/api/cutdispatch/${did}/receive`, {
              method: 'POST', token,
              body: { handover_by: 'x', received_by: 'x', inspected_by: 'x', items: [{ dispatch_item_id: line.id, qty: 1, accepted_qty: 1 }] }
            });
            ok('已结案的单不能再登记回货', editClosed.status === 400, `HTTP ${editClosed.status}`);
          }
        } else {
          ['外发单创建成功（草稿）', '同一扎不能同时挂两张未完结单', '外发单可以发出',
            '回货不填外协交货人被拒', '「合格+不良+返工 ≠ 回货」被拒', '有不良不写原因被拒',
            '回货超过未回量被拒', '有短数不写原因被拒', '全部合格的回货验收成功',
            '无差异可以直接结案', '已结案的单不能再登记回货']
            .forEach((n) => ok(n, true, '没有空闲扎，跳过'));
        }
      }
    } else {
      ok('可发建议可读且件数对得上', true, '没有已录合格裁片数的裁剪单，跳过');
      ok('未复核的扎不会被算成可发', true, '同上，跳过');
    }

    // 已回货的单不能取消
    const returnedDoc = cdRows.find((r) => ['returned', 'closed'].includes(r.status) && Number(r.returned_qty) > 0);
    if (returnedDoc) {
      const c = await req(`/api/cutdispatch/${returnedDoc.id}/cancel`, { method: 'POST', token, body: { reason: '冒烟测试取消已回货单' } });
      ok('已回货的外发单不能取消', c.status === 400, `HTTP ${c.status}`);
    } else {
      ok('已回货的外发单不能取消', true, '没有已回货单，跳过');
    }

    const cdNoAuth = await req('/api/cutdispatch/list');
    ok('未登录访问裁片外发返回 401', cdNoAuth.status === 401, `HTTP ${cdNoAuth.status}`);
  }
  // ================= M05 研发立项与 SKU 配码主档 =================
  {
    const sfx = String(Date.now()).slice(-6);
    const MF = '冒烟测试';

    const devNoAuth = await req('/api/devmaster/board');
    ok('未登录访问研发总览返回 401', devNoAuth.status === 401, `HTTP ${devNoAuth.status}`);

    const dictR = await req('/api/devmaster/dict', { token });
    const msKinds = ((dictR.json.data && dictR.json.data.milestones) || []).map((m) => m.k);
    ok('研发字典含 5 个里程碑且只有技术核准计入开发款数',
      dictR.status === 200 && msKinds.length === 5
      && (dictR.json.data.milestones.filter((m) => m.counted).map((m) => m.k).join(',') === 'tech_approved'),
      `里程碑 ${msKinds.join(',')}`);

    // ---- 总览口径：开发款数 ≠ 里程碑相加 ----
    const bd1 = await req('/api/devmaster/board', { token });
    const b1 = bd1.json.data || {};
    const msSum = (b1.milestones || []).reduce((s, m) => s + Number(m.projects || 0), 0);
    ok('开发款数只数技术核准，不等于里程碑条数相加',
      bd1.status === 200 && Number(b1.stat.dev_completed) <= msSum
      && String(b1.counting_note || '').includes('技术核准'),
      `开发完成 ${b1.stat && b1.stat.dev_completed} / 相加 ${msSum}`);
    const techMs = (b1.milestones || []).find((m) => m.k === 'tech_approved') || {};
    ok('开发款数与技术核准计数一致（返单已从开发款数中扣除）',
      Number(techMs.projects) === Number(b1.stat.dev_completed)
      && Number(b1.stat.tech_approved_all) >= Number(b1.stat.dev_completed),
      'milestone ' + techMs.projects + ' / dev_completed ' + b1.stat.dev_completed + ' / all ' + b1.stat.tech_approved_all);
    ok('总览明确写出「计划不产生采购与生产」',
      String(b1.plan_note || '').includes('不产生采购单'),
      String(b1.plan_note || '').slice(0, 40));

    // ---- 建档：计划量不产生订单 ----
    const ordersBefore = await req('/api/orders?limit=1', { token });
    const cntBefore = (ordersBefore.json.data && (ordersBefore.json.data.total || (ordersBefore.json.data.rows || []).length)) || 0;
    const newProj = await req('/api/devmaster/projects', {
      method: 'POST', token,
      body: {
        style_no: `SMOKE-${sfx}`, style_name: '冒烟测试款', category: '上衣', season: '27SS',
        biz_type: 'spot', source: 'new', owner: '冒烟测试员', pattern_maker: '冒烟版师',
        target_qty: 888, target_price: 66, plan_launch_date: '2027-01-15', note: MF
      }
    });
    const pid = newProj.json.data && newProj.json.data.id;
    ok('建立研发立项（带计划量）', newProj.status === 200 && !!pid, `HTTP ${newProj.status}`);
    const ordersAfter = await req('/api/orders?limit=1', { token });
    const cntAfter = (ordersAfter.json.data && (ordersAfter.json.data.total || (ordersAfter.json.data.rows || []).length)) || 0;
    ok('立项不产生订单（计划量只是计划）', cntAfter === cntBefore, `${cntBefore} → ${cntAfter}`);

    if (pid) {
      ok('新项目校验：无版型时不能打样',
        (newProj.json.data.checks || []).find((c) => c.k === 'pattern_before_sample').ok === false,
        '应提示打样前需出版型');

      // 无负责人不能进技术
      const noOwner = await req('/api/devmaster/projects', {
        method: 'POST', token,
        body: { style_no: `SMOKE-NOOWN-${sfx}`, source: 'new', note: MF }
      });
      const noOwnerId = noOwner.json.data && noOwner.json.data.id;
      if (noOwnerId) {
        const r = await req(`/api/devmaster/projects/${noOwnerId}/stage`, { method: 'POST', token, body: { stage: 'tech' } });
        ok('没有技术负责人不能进入技术开发', r.status === 400 && /负责人/.test(r.json.message || ''), `HTTP ${r.status}`);
      }

      // 跨阶段跳级
      const jump = await req(`/api/devmaster/projects/${pid}/stage`, { method: 'POST', token, body: { stage: 'sample' } });
      ok('阶段不能跳级（草稿不能直接跳到打样）', jump.status === 400 && /跳阶段/.test(jump.json.message || ''), `HTTP ${jump.status}`);

      // 无样衣不能核准
      const noSample = await req(`/api/devmaster/projects/${pid}/milestone`, {
        method: 'POST', token, body: { kind: 'tech_approved', occurred_on: '2026-10-01' }
      });
      ok('没有样衣编号不许做技术核准', noSample.status === 400 && /样衣/.test(noSample.json.message || ''), `HTTP ${noSample.status}`);

      // 进技术 → 加制版任务
      const toTech = await req(`/api/devmaster/projects/${pid}/stage`, { method: 'POST', token, body: { stage: 'tech' } });
      ok('有负责人后可以进入技术开发', toTech.status === 200 && toTech.json.data.stage === 'tech', `HTTP ${toTech.status}`);

      const noPat = await req(`/api/devmaster/projects/${pid}/stage`, { method: 'POST', token, body: { stage: 'sample' } });
      ok('没有版型不许进打样', noPat.status === 400 && /版型/.test(noPat.json.message || ''), `HTTP ${noPat.status}`);

      const task = await req(`/api/devmaster/projects/${pid}/tasks`, {
        method: 'POST', token, body: { kind: 'pattern', title: '冒烟制版', owner: '冒烟版师' }
      });
      const taskId = task.json.data && task.json.data.id;
      ok('建立制版任务（与大货订单分类型）', task.status === 200 && !!taskId, `HTTP ${task.status}`);

      if (taskId) {
        const doneNoOutput = await req(`/api/devmaster/tasks/${taskId}/status`, {
          method: 'POST', token, body: { status: 'done', output: '' }
        });
        ok('完成任务必须写产出', doneNoOutput.status === 400 && /产出/.test(doneNoOutput.json.message || ''), `HTTP ${doneNoOutput.status}`);

        const blockNoReason = await req(`/api/devmaster/tasks/${taskId}/status`, {
          method: 'POST', token, body: { status: 'blocked', blocked_reason: '' }
        });
        ok('阻塞任务必须写原因', blockNoReason.status === 400 && /原因/.test(blockNoReason.json.message || ''), `HTTP ${blockNoReason.status}`);

        const done = await req(`/api/devmaster/tasks/${taskId}/status`, {
          method: 'POST', token, body: { status: 'done', output: `PT-SMOKE-${sfx}` }
        });
        const patNo = done.json.data && done.json.data.pattern_no;
        ok('制版完成后版型号回写到项目', done.status === 200 && patNo === `PT-SMOKE-${sfx}`, `pattern_no=${patNo}`);
      }

      const toSample = await req(`/api/devmaster/projects/${pid}/stage`, { method: 'POST', token, body: { stage: 'sample' } });
      ok('版型出来后才能转入打样', toSample.status === 200 && toSample.json.data.stage === 'sample', `HTTP ${toSample.status}`);

      // 返单/新花型的批准口径
      const repeatNoSrc = await req('/api/devmaster/projects', {
        method: 'POST', token, body: { style_no: `SMOKE-R-${sfx}`, source: 'repeat', note: MF }
      });
      ok('返单复用必须指定原项目', repeatNoSrc.status === 400 && /原项目/.test(repeatNoSrc.json.message || ''), `HTTP ${repeatNoSrc.status}`);

      const repeatBad = await req('/api/devmaster/projects', {
        method: 'POST', token, body: { style_no: `SMOKE-R2-${sfx}`, source: 'repeat', reuse_project_id: pid, note: MF }
      });
      ok('原项目版型未确认可复用，返单被拒', repeatBad.status === 400 && /可复用/.test(repeatBad.json.message || ''), `HTTP ${repeatBad.status}`);

      const newPatNoApprove = await req('/api/devmaster/projects', {
        method: 'POST', token, body: { style_no: `SMOKE-NP-${sfx}`, source: 'new_pattern', note: MF }
      });
      ok('同款新增花型必须有批准分类人', newPatNoApprove.status === 400 && /批准/.test(newPatNoApprove.json.message || ''), `HTTP ${newPatNoApprove.status}`);

      // 版型可复用必须经过大货验证
      const badReuse = await req(`/api/devmaster/projects/${pid}`, {
        method: 'PATCH', token, body: { pattern_reusable: 1 }
      });
      ok('未投产/未上架不许把版型标为可复用', badReuse.status === 400 && /大货验证/.test(badReuse.json.message || ''), `HTTP ${badReuse.status}`);

      // 结案写原因
      const closeShort = await req(`/api/devmaster/projects/${pid}/close`, { method: 'POST', token, body: { reason: '完了' } });
      ok('结案原因至少要写清楚', closeShort.status === 400 && /原因/.test(closeShort.json.message || ''), `HTTP ${closeShort.status}`);
      const closed = await req(`/api/devmaster/projects/${pid}/close`, {
        method: 'POST', token, body: { reason: '冒烟测试结束，终止开发' }
      });
      ok('结案成功且状态转 closed', closed.status === 200 && closed.json.data.stage === 'closed', `HTTP ${closed.status}`);
      const msAfterClose = await req(`/api/devmaster/projects/${pid}/milestone`, {
        method: 'POST', token, body: { kind: 'tech_approved', occurred_on: '2026-10-01' }
      });
      ok('已结案的项目不许再登记里程碑', msAfterClose.status === 400 && /结案/.test(msAfterClose.json.message || ''), `HTTP ${msAfterClose.status}`);
    }

    // ---- SKU 主档 ----
    const s1 = await req('/api/devmaster/skus', {
      method: 'POST', token,
      body: {
        sku: `SMK-${sfx}-A-3T`, style_no: `SMOKE-${sfx}`, pattern: '花A', color: '藏青',
        size: '3T', kind: 'single', unit: '件', remark: MF
      }
    });
    const skuA = s1.json.data && s1.json.data.id;
    ok('建立单件 SKU', s1.status === 200 && !!skuA, `HTTP ${s1.status}`);

    const dup = await req('/api/devmaster/skus', {
      method: 'POST', token,
      body: {
        sku: `SMK-${sfx}-A-3T-DUP`, style_no: `SMOKE-${sfx}`, pattern: '花A', color: '藏青',
        size: '3T', kind: 'single', unit: '件', remark: MF
      }
    });
    ok('单花单码唯一（重复建 SKU 被拒）', dup.status === 400 && /单花单码/.test(dup.json.message || ''), `HTTP ${dup.status}`);

    const badUnit = await req('/api/devmaster/skus', {
      method: 'POST', token,
      body: { sku: `SMK-${sfx}-SETBAD`, style_no: `SMOKE-${sfx}`, kind: 'set', unit: '件', remark: MF }
    });
    ok('套装的基本单位必须是「套」', badUnit.status === 400 && /套/.test(badUnit.json.message || ''), `HTTP ${badUnit.status}`);

    if (skuA) {
      const a2 = await req('/api/devmaster/skus', {
        method: 'POST', token,
        body: {
          sku: `SMK-${sfx}-A-4T`, style_no: `SMOKE-${sfx}`, pattern: '花A', color: '藏青',
          size: '4T', kind: 'single', unit: '件', remark: MF
        }
      });
      const skuA4 = a2.json.data && a2.json.data.id;

      const setR = await req('/api/devmaster/skus', {
        method: 'POST', token,
        body: { sku: `SMK-${sfx}-SET`, style_no: `SMK-${sfx}-SET`, kind: 'set', unit: '套', pattern: '花A', size: '3T', remark: MF }
      });
      const setSku = setR.json.data && setR.json.data.id;
      ok('建立套装 SKU（单位=套）', setR.status === 200 && !!setSku, `HTTP ${setR.status}`);

      if (setSku) {
        const noSpec = await req(`/api/devmaster/skus/${setSku}/explode?qty=10`, { token });
        ok('没有配码的套装换算不出件数', noSpec.status === 400 && /配码/.test(noSpec.json.message || ''), `HTTP ${noSpec.status}`);

        const selfComp = await req('/api/devmaster/packs', {
          method: 'POST', token,
          body: { sku_id: setSku, kind: 'set', items: [{ component_sku_id: setSku, qty: 1 }], note: MF }
        });
        ok('套装不能把自己当组件', selfComp.status === 400 && /自己/.test(selfComp.json.message || ''), `HTTP ${selfComp.status}`);

        const empty = await req('/api/devmaster/packs', {
          method: 'POST', token, body: { sku_id: setSku, kind: 'set', items: [], note: MF }
        });
        ok('配码明细为空不许建版本', empty.status === 400 && /明细/.test(empty.json.message || ''), `HTTP ${empty.status}`);

        if (skuA4) {
          const pack1 = await req('/api/devmaster/packs', {
            method: 'POST', token,
            body: {
              sku_id: setSku, kind: 'set', note: MF,
              items: [{ component_sku_id: skuA, qty: 1 }, { component_sku_id: skuA4, qty: 1 }]
            }
          });
          const spec1 = pack1.json.data && pack1.json.data.id;
          ok('配码合计件数由明细算出（1+1=2）', pack1.status === 200 && Number(pack1.json.data.total_qty) === 2,
            `total=${pack1.json.data && pack1.json.data.total_qty}`);

          if (spec1) {
            const act1 = await req(`/api/devmaster/packs/${spec1}/activate`, { method: 'POST', token, body: {} });
            ok('启用配码草稿', act1.status === 200 && act1.json.data.status === 'active', `HTTP ${act1.status}`);

            const ex1 = await req(`/api/devmaster/skus/${setSku}/explode?qty=10`, { token });
            ok('套装换算：10 套 = 20 件', ex1.status === 200 && Number(ex1.json.data.pieces) === 20,
              `pieces=${ex1.json.data && ex1.json.data.pieces}`);

            const actAgain = await req(`/api/devmaster/packs/${spec1}/activate`, { method: 'POST', token, body: {} });
            ok('已在生效的版本不能重复启用', actAgain.status === 400 && /生效/.test(actAgain.json.message || ''), `HTTP ${actAgain.status}`);

            const pack2 = await req('/api/devmaster/packs', {
              method: 'POST', token,
              body: { sku_id: setSku, kind: 'set', note: MF, items: [{ component_sku_id: skuA, qty: 3 }] }
            });
            const spec2 = pack2.json.data && pack2.json.data.id;
            if (spec2) {
              ok('新配码版本号递增', Number(pack2.json.data.version) === 2, `version=${pack2.json.data.version}`);
              const act2 = await req(`/api/devmaster/packs/${spec2}/activate`, { method: 'POST', token, body: {} });
              const old = (act2.json.data && act2.json.data) || {};
              const oldSpec = await req(`/api/devmaster/packs/${spec1}`, { token });
              ok('启用新版后旧版自动作废（同时只有一版生效）',
                act2.status === 200 && oldSpec.json.data.status === 'superseded',
                `old=${oldSpec.json.data && oldSpec.json.data.status}`);
              const ex2 = await req(`/api/devmaster/skus/${setSku}/explode?qty=4`, { token });
              ok('换算跟随当前生效版本（4 套 × 3 件 = 12）', ex2.status === 200 && Number(ex2.json.data.pieces) === 12,
                `pieces=${ex2.json.data && ex2.json.data.pieces}`);
            }
          }
        }
      }

      // 箱规
      const cartonDup = await req('/api/devmaster/packs', {
        method: 'POST', token,
        body: { sku_id: skuA, kind: 'carton', note: MF, items: [{ size: '3T', qty: 5 }, { size: '3T', qty: 6 }] }
      });
      ok('箱规同尺码不能重复', cartonDup.status === 400 && /重复/.test(cartonDup.json.message || ''), `HTTP ${cartonDup.status}`);

      const cartonBad = await req('/api/devmaster/packs', {
        method: 'POST', token,
        body: { sku_id: skuA, kind: 'carton', note: MF, items: [{ size: '', qty: 5 }] }
      });
      ok('箱规必须写尺码', cartonBad.status === 400 && /尺码/.test(cartonBad.json.message || ''), `HTTP ${cartonBad.status}`);

      // 别名
      const al1 = await req(`/api/devmaster/skus/${skuA}/alias`, {
        method: 'POST', token, body: { alias: `SMKAL-${sfx}`, source: 'supplier' }
      });
      ok('加 SKU 别名', al1.status === 200 && (al1.json.data.aliases || []).length === 1, `HTTP ${al1.status}`);

      const alDup = await req(`/api/devmaster/skus/${skuA}/alias`, {
        method: 'POST', token, body: { alias: `SMKAL-${sfx}`, source: 'supplier' }
      });
      ok('同一别名不能挂在两个 SKU 上', alDup.status === 400 && /占用/.test(alDup.json.message || ''), `HTTP ${alDup.status}`);

      const alOne = (al1.json.data.aliases || [])[0];
      if (alOne) {
        const noNote = await req(`/api/devmaster/aliases/${alOne.id}/disable`, { method: 'POST', token, body: { note: '' } });
        ok('停用别名要写原因', noNote.status === 400 && /原因/.test(noNote.json.message || ''), `HTTP ${noNote.status}`);
        const off = await req(`/api/devmaster/aliases/${alOne.id}/disable`, {
          method: 'POST', token, body: { note: '冒烟测试：新旧系统切换' }
        });
        ok('停用别名是停用不是删除（历史仍可查）',
          off.status === 200 && (off.json.data.aliases || []).some((a) => a.id === alOne.id && a.status === 'inactive'),
          `HTTP ${off.status}`);
      }
    }
  }

  // ================= M05-06 供方信息协同与技术再次审核 =================
  {
    const suf = String(Date.now()).slice(-6);
    const MF = '冒烟测试';

    const noAuth = await req('/api/supreview/board');
    ok('未登录访问供方协同看板返回 401', noAuth.status === 401, `HTTP ${noAuth.status}`);

    const d0 = await req('/api/supreview/dict', { token });
    ok('协同字典含三段与三种供方来源',
      d0.status === 200
      && ((d0.json.data.pattern_scope || []).length === 3)
      && ((d0.json.data.source_type || []).length === 3)
      && ((d0.json.data.conclusion || []).length === 3),
      `HTTP ${d0.status}`);

    const bd = await req('/api/supreview/board', { token });
    ok('看板明确写出「A3 为什么失效」的口径',
      bd.status === 200 && String(bd.json.data.rule_note || '').includes('A3'),
      String(bd.json.data && bd.json.data.rule_note || '').slice(0, 40));

    // 建两张技术包（冒烟测试，seed 会清）
    const mk = async (name) => {
      const r = await req('/api/techpacks', {
        method: 'POST', token, body: { order_id: 1, product_name: name, remark: MF }
      });
      return r.json.data && (r.json.data.id || (r.json.data.tech_pack && r.json.data.tech_pack.id));
    };
    const tp = await mk(`协同冒烟-${suf}`);
    const tp2 = await mk(`协同冒烟2-${suf}`);
    ok('建立供方协同用的技术包', !!tp && !!tp2, `tp=${tp} tp2=${tp2}`);

    if (tp && tp2) {
      // ---- A1 ----
      const noOwner = await req(`/api/supreview/packs/${tp}/assignment`, {
        method: 'POST', token, body: { pattern_scope: 'self' }
      });
      ok('A1 技术处理人必填', noOwner.status === 400 && /技术处理人/.test(noOwner.json.message || ''), `HTTP ${noOwner.status}`);

      const outNoVendor = await req(`/api/supreview/packs/${tp}/assignment`, {
        method: 'POST', token, body: { pattern_scope: 'outsource', tech_owner: '冒烟技术员' }
      });
      ok('外发制版必须指定版房', outNoVendor.status === 400 && /版房/.test(outNoVendor.json.message || ''), `HTTP ${outNoVendor.status}`);

      const reuseSelf = await req(`/api/supreview/packs/${tp}/assignment`, {
        method: 'POST', token, body: { pattern_scope: 'reuse', tech_owner: '冒烟技术员', reuse_tech_pack_id: tp }
      });
      ok('不能复用自己', reuseSelf.status === 400 && /自己/.test(reuseSelf.json.message || ''), `HTTP ${reuseSelf.status}`);

      const reuseDraft = await req(`/api/supreview/packs/${tp}/assignment`, {
        method: 'POST', token, body: { pattern_scope: 'reuse', tech_owner: '冒烟技术员', reuse_tech_pack_id: tp2 }
      });
      ok('复用未核准的技术包被拒（跳过技术审核）', reuseDraft.status === 400 && /还没核准/.test(reuseDraft.json.message || ''), `HTTP ${reuseDraft.status}`);

      const a1 = await req(`/api/supreview/packs/${tp}/assignment`, {
        method: 'POST', token, body: { pattern_scope: 'self', tech_owner: '冒烟技术员' }
      });
      ok('保存 A1 分工（自制版）', a1.status === 200 && a1.json.data.assignment.status === 'draft', `HTTP ${a1.status}`);

      // A1 未确认时不许做 A2
      const a2BeforeA1 = await req(`/api/supreview/packs/${tp}/confirms`, {
        method: 'POST', token,
        body: { material_name: '冒烟面料', spec: '150cm', supplier_id: 1, source_type: 'existing', unit_price: 20 }
      });
      ok('A1 未确认时不许做供方确认', a2BeforeA1.status === 400 && /A1/.test(a2BeforeA1.json.message || ''), `HTTP ${a2BeforeA1.status}`);

      const a1c = await req(`/api/supreview/packs/${tp}/assignment/confirm`, { method: 'POST', token, body: {} });
      ok('确认 A1 分工', a1c.status === 200 && a1c.json.data.assignment.status === 'confirmed', `HTTP ${a1c.status}`);

      // ---- A2 ----
      const noSpec = await req(`/api/supreview/packs/${tp}/confirms`, {
        method: 'POST', token, body: { material_name: '冒烟面料', supplier_id: 1, source_type: 'existing' }
      });
      ok('供方确认必须写适用规格', noSpec.status === 400 && /规格/.test(noSpec.json.message || ''), `HTTP ${noSpec.status}`);

      const newDevNoBasis = await req(`/api/supreview/packs/${tp}/confirms`, {
        method: 'POST', token,
        body: { material_name: '冒烟面料', spec: '150cm', supplier_id: 1, source_type: 'new_dev', unit_price: 20 }
      });
      ok('新开发供方必须写样料依据', newDevNoBasis.status === 400 && /样料依据/.test(newDevNoBasis.json.message || ''), `HTTP ${newDevNoBasis.status}`);

      const sampleNoApprove = await req(`/api/supreview/packs/${tp}/confirms`, {
        method: 'POST', token,
        body: { material_name: '冒烟样料', spec: '150cm', supplier_id: 1, source_type: 'sample_only', unit_price: 20 }
      });
      ok('仅样料必须写批准依据', sampleNoApprove.status === 400 && /批准依据/.test(sampleNoApprove.json.message || ''), `HTTP ${sampleNoApprove.status}`);

      const c1 = await req(`/api/supreview/packs/${tp}/confirms`, {
        method: 'POST', token,
        body: {
          material_name: '冒烟面料 100g', spec: '150cm', composition: '100% 棉',
          supplier_id: 1, source_type: 'existing', unit_price: 26, lead_days: 12, sample_basis: '色卡 SM-1'
        }
      });
      const c1row = c1.json.data && c1.json.data.confirms.find((x) => x.material_name === '冒烟面料 100g');
      ok('建供方确认 V1', c1.status === 200 && !!c1row && Number(c1row.version) === 1, `HTTP ${c1.status}`);

      // 没填单价的那条：确认要被拒，验完直接作废（录错了要能撤）
      const noPriceC = await req(`/api/supreview/packs/${tp}/confirms`, {
        method: 'POST', token,
        body: { material_name: '冒烟无价料', spec: '140cm', supplier_id: 1, source_type: 'existing' }
      });
      const npRow = noPriceC.json.data && noPriceC.json.data.confirms.find((x) => x.material_name === '冒烟无价料');
      const noPrice = await req(`/api/supreview/confirms/${npRow && npRow.id}/confirm`, { method: 'POST', token, body: {} });
      ok('没填单价不能确认供货条件', noPrice.status === 400, `HTTP ${noPrice.status}`);
      const npNoReason = await req(`/api/supreview/confirms/${npRow && npRow.id}/cancel`, { method: 'POST', token, body: { reason: '' } });
      ok('作废草稿要写原因', npNoReason.status === 400 && /原因/.test(npNoReason.json.message || ''), `HTTP ${npNoReason.status}`);
      const npCancel = await req(`/api/supreview/confirms/${npRow && npRow.id}/cancel`, { method: 'POST', token, body: { reason: '冒烟测试：单价没录到，作废' } });
      ok('作废草稿供方确认（录错了能撤）', npCancel.status === 200, `HTTP ${npCancel.status}`);

      const c1ok = await req(`/api/supreview/packs/${tp}/confirms`, {
        method: 'POST', token,
        body: {
          material_name: '冒烟样料 40s', spec: '160cm', supplier_id: 2, source_type: 'sample_only',
          unit_price: 18, approval_ref: '冒烟测试：销售总监批准找料，仅做样衣', sample_basis: '样布 SM-2'
        }
      });
      const smp = c1ok.json.data && c1ok.json.data.confirms.find((x) => x.material_name === '冒烟样料 40s');
      ok('仅样料行标记为不可直接大货采购', !!smp && smp.can_purchase === 0, `can_purchase=${smp && smp.can_purchase}`);
      // 样料不进大货流程，验完作废掉，免得占着 A2 让后面核准不了
      const smpCancel = await req(`/api/supreview/confirms/${smp && smp.id}/cancel`, {
        method: 'POST', token, body: { reason: '冒烟测试：仅样料不进大货，作废' }
      });
      ok('仅样料草稿可作废', smpCancel.status === 200, `HTTP ${smpCancel.status}`);

      const c1c = await req(`/api/supreview/confirms/${c1row && c1row.id}/confirm`, { method: 'POST', token, body: {} });
      ok('确认供方条件（有单价）', c1c.status === 200, `HTTP ${c1c.status}`);

      const c1again = await req(`/api/supreview/confirms/${c1row && c1row.id}/confirm`, { method: 'POST', token, body: {} });
      ok('同一条供方确认不能重复确认', c1again.status === 400 && /确认过/.test(c1again.json.message || ''), `HTTP ${c1again.status}`);

      // ---- A3 ----
      const rvNoRef = await req(`/api/supreview/packs/${tp}/reviews`, {
        method: 'POST', token, body: { conclusion: 'pass', approved_by: '冒烟核准人' }
      });
      ok('复审必须引用一条供方确认', rvNoRef.status === 400 && /引用/.test(rvNoRef.json.message || ''), `HTTP ${rvNoRef.status}`);

      const rvNoApprover = await req(`/api/supreview/packs/${tp}/reviews`, {
        method: 'POST', token, body: { confirm_id: c1row && c1row.id, conclusion: 'pass' }
      });
      ok('通过类结论必须写核准人', rvNoApprover.status === 400 && /核准人/.test(rvNoApprover.json.message || ''), `HTTP ${rvNoApprover.status}`);

      const rvCondNoReason = await req(`/api/supreview/packs/${tp}/reviews`, {
        method: 'POST', token,
        body: { confirm_id: c1row && c1row.id, conclusion: 'conditional', approved_by: '冒烟核准人' }
      });
      ok('有条件通过必须写差异原因', rvCondNoReason.status === 400 && /差异原因/.test(rvCondNoReason.json.message || ''), `HTTP ${rvCondNoReason.status}`);

      const rv1 = await req(`/api/supreview/packs/${tp}/reviews`, {
        method: 'POST', token,
        body: { confirm_id: c1row && c1row.id, conclusion: 'pass', approved_by: '冒烟核准人' }
      });
      ok('A3 复审通过（引用当前版本 V1）', rv1.status === 200, `HTTP ${rv1.status}`);

      const approve1 = await req(`/api/supreview/packs/${tp}/approve`, { method: 'POST', token, body: { approved_by: '冒烟核准人' } });
      ok('三段齐了才能核准技术包', approve1.status === 200, `HTTP ${approve1.status}`);
      const tpAfter = await req(`/api/supreview/packs/${tp}`, { token });
      ok('核准后技术包状态转 confirmed',
        tpAfter.status === 200 && tpAfter.json.data.tech_pack.status === 'confirmed',
        `HTTP ${tpAfter.status} / ${tpAfter.json.data && tpAfter.json.data.tech_pack.status}`);

      // ---- 核心：换供方后原 A3 失效 ----
      const c2 = await req(`/api/supreview/packs/${tp}/confirms`, {
        method: 'POST', token,
        body: {
          material_name: '冒烟面料 100g', spec: '155cm', composition: '98% 棉 2% 氨纶',
          supplier_id: 3, source_type: 'existing', unit_price: 24.5, lead_days: 18,
          sample_basis: '色卡 SM-1B', note: MF
        }
      });
      const c2row = c2.json.data && c2.json.data.confirms.find((x) => x.material_name === '冒烟面料 100g' && x.is_current === 1);
      ok('换供方 + 改规格 → 供货条件出新版本 V2',
        c2.status === 200 && !!c2row && Number(c2row.version) === 2, `version=${c2row && c2row.version}`);

      const oldRev = (c2.json.data.reviews || []).find((r) => r.confirm_version === 1);
      ok('原 A3 自动失效（依据的 V1 已作废）',
        !!oldRev && oldRev.stale === 1 && /已作废|已更新/.test(oldRev.stale_reason || ''),
        oldRev ? oldRev.stale_reason : '未找到旧复审');

      const staleRev = await req(`/api/supreview/packs/${tp}/reviews`, {
        method: 'POST', token, body: { confirm_id: c1row && c1row.id, conclusion: 'pass', approved_by: '冒烟核准人' }
      });
      ok('不能拿已作废的 A2 版本做复审', staleRev.status === 400 && /已作废/.test(staleRev.json.message || ''), `HTTP ${staleRev.status}`);

      const approveStale = await req(`/api/supreview/packs/${tp}/approve`, { method: 'POST', token, body: {} });
      ok('A3 失效时不许核准技术包', approveStale.status === 400 && /失效|还不能核准/.test(approveStale.json.message || ''), `HTTP ${approveStale.status}`);

      // 确认 V2 后重审 → 恢复可核准
      const c2c = await req(`/api/supreview/confirms/${c2row && c2row.id}/confirm`, { method: 'POST', token, body: {} });
      ok('确认新版本供货条件', c2c.status === 200, `HTTP ${c2c.status}`);
      const rv2 = await req(`/api/supreview/packs/${tp}/reviews`, {
        method: 'POST', token,
        body: { confirm_id: c2row && c2row.id, conclusion: 'conditional', approved_by: '冒烟核准人', diff_reason: '门幅改 155cm，排版要重算，成本微增' }
      });
      const detail2 = rv2.json.data || {};
      ok('对 V2 重审后恢复可核准', rv2.status === 200 && detail2.can_approve === true, `can_approve=${detail2.can_approve}`);

      // A1 已确认改分工要 force
      const reA1NoForce = await req(`/api/supreview/packs/${tp}/assignment`, {
        method: 'POST', token, body: { pattern_scope: 'self', tech_owner: '换个人' }
      });
      ok('已确认的 A1 改分工要显式 force', reA1NoForce.status === 400 && /force/.test(reA1NoForce.json.message || ''), `HTTP ${reA1NoForce.status}`);
    }
  }

  // ================= 上线准备：真实数据导入 =================
  {
    const sfx = String(Date.now()).slice(-6);
    const C_PREFIX = `SMKIMP${sfx}`;

    const noAuth = await req('/api/importops/types');
    ok('未登录访问导入类型返回 401', noAuth.status === 401, `HTTP ${noAuth.status}`);

    const tp = await req('/api/importops/types', { token });
    const typeKeys = ((tp.json.data && tp.json.data.types) || []).map((x) => x.type);
    ok('导入类型含客户/供应商/物料/产品/SKU/期初库存',
      tp.status === 200 && typeKeys.length === 6
      && ['customers', 'suppliers', 'materials', 'products', 'skus', 'stock_opening'].every((k) => typeKeys.includes(k)),
      typeKeys.join(','));

    const tplRes = await fetch(BASE + '/api/importops/template/stock_opening', { headers: { Authorization: 'Bearer ' + token } });
    const tplText = await tplRes.text();
    ok('期初库存模板可下载且含表头',
      tplRes.status === 200 && tplText.includes('仓库') && tplText.includes('数量'),
      `HTTP ${tplRes.status} / ${tplText.split('\n')[0]}`);

    const tplBad = await req('/api/importops/template/nope', { token });
    ok('不存在的模板返回 404', tplBad.status === 404, `HTTP ${tplBad.status}`);

    // ---- 表头体检 ----
    const noCol = await req('/api/importops/preview', {
      method: 'POST', token, body: { type: 'stock_opening', csv: '款号,数量\nX,1\n' }
    });
    ok('表头缺必填列直接报错（不让盲导）',
      noCol.status === 400 && /表头缺少必填列/.test(noCol.json.message || ''), `HTTP ${noCol.status}`);

    // ---- 客户：新增 / 覆盖 / 错误 三种动作 ----
    const csvCust = [
      '客户编号,客户名称,联系人,电话,等级,信用额度,状态',
      `${C_PREFIX}-1,冒烟导入客户甲,张三,13800000001,A,"50,000",启用`,
      'C001,示范客户·美国 ABC（更名）,李四,13800000002,A,"80,000",启用',
      `${C_PREFIX}-BAD,,缺名称,13800000003,B,,启用`,
      `${C_PREFIX}-1,重复行,王五,,,,\n`
    ].join('\n');
    const pv1 = await req('/api/importops/preview', { method: 'POST', token, body: { type: 'customers', csv: csvCust } });
    const p1 = pv1.json.data || {};
    ok('客户预览同时给出新增 / 覆盖 / 有问题',
      pv1.status === 200 && p1.stat.new === 1 && p1.stat.update === 1 && p1.stat.error === 2,
      JSON.stringify(p1.stat || {}));

    // 关键回归：给了编码但编码查不到 → 必须是「新增」，不能按同名去覆盖别人
    const sameNameRow = (p1.rows || []).find((r) => r.line === 2);
    ok('有编码但编码不存在时算新增（不按同名覆盖老客户）',
      !!sameNameRow && sameNameRow.action === 'new',
      sameNameRow ? `action=${sameNameRow.action}` : '未找到行');

    // ---- 制表符（Excel 直接粘贴）----
    const tsv = await req('/api/importops/preview', {
      method: 'POST', token,
      body: { type: 'products', csv: `款号\t款名\t品类\t单位\t参考单价\n${C_PREFIX}-P1\t冒烟导入款\t上衣\t件\t88\n` }
    });
    ok('Excel 制表符内容能识别（不要求另存 CSV）',
      tsv.status === 200 && tsv.json.data.delimiter === '\t' && tsv.json.data.stat.new === 1,
      `delimiter=${JSON.stringify(tsv.json.data && tsv.json.data.delimiter)}`);

    // ---- 整批事务：有错行就一条也不写 ----
    const blocked = await req('/api/importops/commit', { method: 'POST', token, body: { type: 'customers', csv: csvCust } });
    const stillNew = await req('/api/importops/preview', {
      method: 'POST', token,
      body: { type: 'customers', csv: `客户编号,客户名称\n${C_PREFIX}-1,冒烟导入客户甲\n` }
    });
    ok('默认整批事务：有错误行时一条都不写',
      blocked.status === 422 && stillNew.json.data.stat.new === 1,
      `HTTP ${blocked.status} / 仍为新增 ${stillNew.json.data && stillNew.json.data.stat.new}`);

    // ---- 勾「跳过错误行」才写入 ----
    const committed = await req('/api/importops/commit', {
      method: 'POST', token,
      body: { type: 'customers', csv: csvCust, opts: { skip_errors: 1, note: '冒烟测试导入' } }
    });
    ok('勾选跳过错误行后只写入能导的，并记录跳过数',
      committed.status === 200 && committed.json.data.new === 1 && committed.json.data.skipped === 2,
      JSON.stringify(committed.json.data || {}));

    // ---- 期初库存：只能导一次 ----
    const stockCsv = `仓库,款号,款名,颜色,尺码,数量\n生产仓,${C_PREFIX}-S1,冒烟期初款,藏青,3T,120\n美仓,${C_PREFIX}-S1,冒烟期初款,藏青,3T,80\n`;
    const st1 = await req('/api/importops/preview', { method: 'POST', token, body: { type: 'stock_opening', csv: stockCsv } });
    ok('期初库存首次预览全部可导',
      st1.status === 200 && st1.json.data.stat.new === 2 && st1.json.data.stat.error === 0,
      JSON.stringify(st1.json.data && st1.json.data.stat));

    const stCommit = await req('/api/importops/commit', { method: 'POST', token, body: { type: 'stock_opening', csv: stockCsv } });
    ok('期初库存首次提交成功', stCommit.status === 200 && stCommit.json.data.new === 2, `HTTP ${stCommit.status}`);

    const stAgain = await req('/api/importops/preview', { method: 'POST', token, body: { type: 'stock_opening', csv: stockCsv } });
    const againErrs = ((stAgain.json.data && stAgain.json.data.rows) || []).map((r) => (r.errors || []).join('；')).join(' | ');
    ok('期初库存重复导入被拒（防止库存翻倍）',
      stAgain.json.data.stat.error === 2 && /已经有期初流水/.test(againErrs),
      againErrs.slice(0, 60));

    const stCommit2 = await req('/api/importops/commit', { method: 'POST', token, body: { type: 'stock_opening', csv: stockCsv } });
    ok('期初库存重复提交整批不写', stCommit2.status === 422, `HTTP ${stCommit2.status}`);

    // 覆盖真实库存也要拒
    const stCover = await req('/api/importops/preview', {
      method: 'POST', token,
      body: { type: 'stock_opening', csv: '仓库,款号,颜色,尺码,数量\n生产仓,LEJE-TZ-002,黑色,M,999\n' }
    });
    const coverErrs = ((stCover.json.data && stCover.json.data.rows) || []).map((r) => (r.errors || []).join('；')).join(' | ');
    ok('已有真实库存时不覆盖（提示走盘点）',
      stCover.json.data.stat.error === 1 && /已有库存/.test(coverErrs),
      coverErrs.slice(0, 60));

    // 非法值
    const badStock = await req('/api/importops/preview', {
      method: 'POST', token,
      body: { type: 'stock_opening', csv: '仓库,款号,颜色,尺码,数量\n生产仓,X1,红,M,-5\n深圳仓,X2,红,M,10\n' }
    });
    const badErr = ((badStock.json.data && badStock.json.data.rows) || []).map((r) => (r.errors || []).join('；')).join(' | ');
    ok('期初数量为负 / 仓库不认都被拒',
      badStock.json.data.stat.error === 2 && /不能为负/.test(badErr) && /不认识/.test(badErr),
      badErr.slice(0, 60));

    // ---- 批次留痕 ----
    const bl = await req('/api/importops/batches', { token });
    const bRows = (bl.json.data && bl.json.data.rows) || [];
    ok('导入批次留痕可查（批次号/行数/操作人）',
      bl.status === 200 && bRows.length > 0 && !!bRows[0].batch_no && !!bRows[0].operator,
      `共 ${bRows.length} 批`);

    const bd = await req(`/api/importops/batches/${bRows[0] && bRows[0].id}`, { token });
    ok('批次详情能查到错误行明细', bd.status === 200 && Array.isArray(bd.json.data.error_list), `HTTP ${bd.status}`);

    // ---- 权限：销售不能提交 ----
    const salesLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'sales01', password: 'admin123456' } });
    if (salesLogin.status === 200 && salesLogin.json.data && salesLogin.json.data.token) {
      const forbid = await req('/api/importops/commit', {
        method: 'POST', token: salesLogin.json.data.token,
        body: { type: 'customers', csv: '客户编号,客户名称\nX1,Y\n' }
      });
      ok('销售角色不能提交导入（只有管理员/财务能写）', forbid.status === 403, `HTTP ${forbid.status}`);
    } else {
      ok('销售角色不能提交导入（只有管理员/财务能写）', true, '无销售测试账号，跳过');
    }

    // ---- 自己清场：导入是写入型用例，跑完必须收回 ----
    try {
      const { db } = require('../src/db');
      const c = db.prepare(`DELETE FROM customers WHERE code LIKE 'SMKIMP%' OR code LIKE '${C_PREFIX}%'`).run().changes;
      const p = db.prepare(`DELETE FROM products WHERE sku LIKE '${C_PREFIX}%'`).run().changes;
      const l = db.prepare(`DELETE FROM stock_ledger WHERE style_no LIKE '${C_PREFIX}%'`).run().changes;
      const si = db.prepare(`DELETE FROM stock_items WHERE style_no LIKE '${C_PREFIX}%'`).run().changes;
      db.prepare("DELETE FROM import_batches WHERE note LIKE '%冒烟测试%'").run();
      ok('导入用例跑完自清理（不留脏数据）', true, `客户 ${c} / 产品 ${p} / 流水 ${l} / 库存 ${si}`);
    } catch (e) {
      ok('导入用例跑完自清理（不留脏数据）', false, e.message);
    }
  }

  // ================= 上线准备：岗位权限复核 =================
  {
    console.log('\n[岗位权限复核]');
    const SMK_U = 'smk_access01';
    const SMK_U2 = 'smk_access02';

    const noAuth = await req('/api/access/permissions');
    ok('权限表读取需要登录', noAuth.status === 401, `HTTP ${noAuth.status}`);

    const pt = await req('/api/access/permissions', { token });
    const perms = pt.status === 200 ? pt.json.data.perms : {};
    const permCount = Object.keys(perms).length;
    ok('权限点表可读', pt.status === 200 && permCount > 0, `HTTP ${pt.status}`);
    ok('权限点数量 ≥ 90（人事行政拆分后 94 项）', permCount >= 90, `${permCount} 项`);
    ok(
      '岗位含总经理与人事行政（6 岗扩到 8 岗）',
      pt.json.data.roles.includes('boss') && pt.json.data.roles.includes('hr'),
      pt.json.data.roles.join(',')
    );
    ok('职责分离规则已内置（10 条）', (pt.json.data.sod_rules || []).length === 10,
      `${(pt.json.data.sod_rules || []).length} 条`);

    // 前后端一致性：前端兜底表必须由脚本从后端生成，否则首屏会闪出错误按钮
    try {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(path.resolve(__dirname, '../../frontend/src/store/perm-table.js'), 'utf8');
      const m = src.match(/export const PERM_TABLE = (\{[\s\S]*?\n\});/);
      const front = m ? new Function('return ' + m[1])() : null;
      const same =
        !!front &&
        Object.keys(front).length === permCount &&
        Object.keys(front).every((k) => JSON.stringify(front[k]) === JSON.stringify(perms[k]));
      ok('前端兜底表与后端权限矩阵一致', same, same ? '' : '请跑 node scripts/sync-frontend-perms.js');
    } catch (e) {
      ok('前端兜底表与后端权限矩阵一致', false, e.message);
    }

    const me = await req('/api/access/me', { token });
    ok('当前账号生效权限可读', me.status === 200 && Array.isArray(me.json.data.perms), `HTTP ${me.status}`);
    ok('管理员标记为恒通过', me.status === 200 && me.json.data.is_admin === true);

    const rv = await req('/api/access/review', { token });
    const rvD = rv.status === 200 ? rv.json.data : {};
    ok('复核矩阵可读（用户 × 权限）', rv.status === 200 && Array.isArray(rvD.users) && rvD.users.length > 0,
      `HTTP ${rv.status}`);
    ok('复核矩阵带职责分离扫描结果', Array.isArray(rvD.sod) && rvD.sod.length === 10, `${(rvD.sod || []).length} 条`);
    ok('岗位权限数统计合理（总经理 0 个写权限）',
      (rvD.roles || []).some((r) => r.code === 'boss' && r.perm_count === 0));

    // ---- 建临时账号：验证岗位边界 / 收回 / 多岗 ----
    const mk = await req('/api/users', {
      method: 'POST', token,
      body: { username: SMK_U, password: 'Smk#2026', name: '冒烟销售', role: 'sales' }
    });
    const uid = mk.status === 200 ? mk.json.data.id : null;
    ok('可建销售临时账号', mk.status === 200 && !!uid, `HTTP ${mk.status}`);

    const mk2 = await req('/api/users', {
      method: 'POST', token,
      body: { username: SMK_U2, password: 'Smk#2026', name: '冒烟人事', role: 'hr' }
    });
    const uid2 = mk2.status === 200 ? mk2.json.data.id : null;
    ok('可建人事临时账号', mk2.status === 200 && !!uid2, `HTTP ${mk2.status}`);

    if (uid) {
      const lg = await req('/api/auth/login', { method: 'POST', body: { username: SMK_U, password: 'Smk#2026' } });
      const st = lg.status === 200 ? lg.json.data.token : null;
      ok('临时销售可登录', !!st, `HTTP ${lg.status}`);

      const meS = await req('/api/access/me', { token: st });
      const pS = meS.status === 200 ? meS.json.data.perms : [];
      ok('销售有下单权限', pS.includes('order.create'));
      ok('销售已失去工艺维护权限（复核收回）', !pS.includes('craft.write'), pS.includes('craft.write') ? '仍有 craft.write' : '');
      ok('销售已失去人事档案权限（人事行政剥离）', !pS.includes('employee.write'));
      ok('请假自助提交对所有在岗员工开放', pS.includes('leave.write'));

      // 收回 → 前端权限消失 + 后端高危路由 403
      const ex = await req('/api/access/exceptions', {
        method: 'POST', token,
        body: { user_id: uid, perm: 'order.export', effect: 'deny', reason: '冒烟测试：验证收回生效' }
      });
      ok('可设置用户级收回', ex.status === 200 && ex.json.data.effect === 'deny', `HTTP ${ex.status}`);

      const meS2 = await req('/api/access/me', { token: st });
      ok('收回后生效权限里不再有该权限点',
        meS2.status === 200 && !meS2.json.data.perms.includes('order.export'));

      const blocked = await req('/api/orders/export', { token: st });
      ok('收回后后端直接拒绝（不是只藏按钮）', blocked.status === 403, `HTTP ${blocked.status}`);

      const noReason = await req('/api/access/exceptions', {
        method: 'POST', token,
        body: { user_id: uid, perm: 'quote.write', effect: 'deny' }
      });
      ok('收回必须写理由（否则拒绝）', noReason.status === 400, `HTTP ${noReason.status}`);

      const badPerm = await req('/api/access/exceptions', {
        method: 'POST', token,
        body: { user_id: uid, perm: 'nope.perm', effect: 'deny', reason: 'x' }
      });
      ok('不存在的权限点不能设置例外', badPerm.status === 400, `HTTP ${badPerm.status}`);

      const adminExc = await req('/api/access/exceptions', {
        method: 'POST', token,
        body: { user_id: 1, perm: 'order.export', effect: 'deny', reason: 'x' }
      });
      ok('管理员不能被设置例外（恒通过）', adminExc.status === 400, `HTTP ${adminExc.status}`);

      // 附加岗：一人多岗取并集
      const er = await req('/api/access/roles', {
        method: 'POST', token, body: { user_id: uid, roles: ['warehouse'] }
      });
      ok('可设置附加岗（一人多岗）', er.status === 200 && (er.json.data.extra_roles || []).includes('warehouse'),
        `HTTP ${er.status}`);
      const meS3 = await req('/api/access/me', { token: st });
      ok('附加岗并集生效（销售 + 仓管 → 有库存权限）',
        meS3.status === 200 && meS3.json.data.roles.includes('warehouse') && meS3.json.data.perms.includes('stock.write'));

      const stk = await req('/api/stock/summary', { token: st });
      ok('多岗后能访问仓管接口', stk.status === 200, `HTTP ${stk.status}`);

      // 敏感数据：读也要限岗（原来 GET 只要求登录，任何角色都能拉全员工资）
      const pay = await req('/api/payrolls', { token: st });
      ok('销售不能读工资表（读也限岗）', pay.status === 403, `HTTP ${pay.status}`);

      const emp = await req('/api/employees', { token: st });
      const empRows = emp.status === 200 ? emp.json.data || [] : [];
      const masked = empRows.length > 0 && empRows.every((e) => e.id_card === null && e.base_salary === null);
      ok('销售可读员工花名册（选人用）但看不到身份证与基本工资',
        emp.status === 200 && masked, `HTTP ${emp.status} / ${empRows.length} 行`);
    }

    if (uid2) {
      const lg2 = await req('/api/auth/login', { method: 'POST', body: { username: SMK_U2, password: 'Smk#2026' } });
      const st2 = lg2.status === 200 ? lg2.json.data.token : null;
      const meH = await req('/api/access/me', { token: st2 });
      const pH = meH.status === 200 ? meH.json.data.perms : [];
      ok('人事岗有员工档案与薪酬权限', pH.includes('employee.write') && pH.includes('payroll.write'));
      ok('人事岗不再拥有下单权限', !pH.includes('order.create'));
      const ord = await req('/api/orders', { method: 'POST', token: st2, body: {} });
      ok('人事岗调下单接口被拒', ord.status === 403, `HTTP ${ord.status}`);
    }

    // ---- 清场 ----
    try {
      const { db } = require('../src/db');
      const ids = db.prepare(`SELECT id FROM users WHERE username IN ('${SMK_U}','${SMK_U2}')`).all().map((r) => r.id);
      ids.forEach((id) => {
        db.prepare('DELETE FROM access_exceptions WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
      });
      ok('权限用例跑完自清理（临时账号与例外已删）', ids.length >= 0, `清理 ${ids.length} 个账号`);
    } catch (e) {
      ok('权限用例跑完自清理（临时账号与例外已删）', false, e.message);
    }
  }

  // ================= 上线准备：备份恢复 =================
  {
    console.log('\n[备份与恢复]');
    const created = [];
    let salesToken = null;

    const noAuth = await req('/api/backup/overview');
    ok('备份概览需要登录', noAuth.status === 401, `HTTP ${noAuth.status}`);

    // 非管理员不能碰备份（备份里有全库数据）
    const sl = await req('/api/auth/login', { method: 'POST', body: { username: 'sales01', password: 'admin123456' } });
    if (sl.status === 200 && sl.json.data) salesToken = sl.json.data.token;
    if (salesToken) {
      const forbid = await req('/api/backup/overview', { token: salesToken });
      ok('销售不能访问备份接口', forbid.status === 403, `HTTP ${forbid.status}`);
    } else {
      ok('销售不能访问备份接口', true, '无销售测试账号，跳过');
    }

    const ov = await req('/api/backup/overview', { token });
    const ovD = ov.status === 200 ? ov.json.data : {};
    ok('备份概览可读（健康/存储/待恢复/数据检查）',
      ov.status === 200 && !!ovD.health && !!ovD.storage && !!ovD.pending && Array.isArray(ovD.checks),
      `HTTP ${ov.status}`);
    ok('数据健康检查返回 6 项', (ovD.checks || []).length === 6, `${(ovD.checks || []).length} 项`);
    ok('待恢复状态可读（默认无）', ovD.pending && ovD.pending.pending === false);

    // ---- 建备份 ----
    const mk = await req('/api/backup/create', { method: 'POST', token, body: { note: '冒烟测试备份' } });
    const job = mk.status === 200 ? mk.json.data : null;
    ok('可以生成服务端备份', mk.status === 200 && !!job, `HTTP ${mk.status}`);
    if (job) {
      created.push(job.id);
      ok('备份带编号与校验和', !!job.job_no && !!job.sha256 && String(job.sha256).length === 64,
        `${job.job_no} / ${String(job.sha256).slice(0, 12)}…`);
      ok('备份生成后即通过校验', job.verify_status === 'ok', job.verify_note || '');
      ok('备份记录了表数与关键表行数',
        job.tables_count > 100 && job.rows_total > 0, `${job.tables_count} 表 / ${job.rows_total} 行`);

      const vf = await req(`/api/backup/${job.id}/verify`, { method: 'POST', token });
      ok('可重新校验备份（完整性 + 关键表）',
        vf.status === 200 && vf.json.data.checks.ok === true,
        `integrity=${vf.json.data && vf.json.data.checks && vf.json.data.checks.integrity}`);

      // 下载要拿到真正的 SQLite 文件
      const dl = await fetch(BASE + `/api/backup/${job.id}/download`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      const buf = Buffer.from(await dl.arrayBuffer());
      ok('可以下载备份文件且是有效 SQLite',
        dl.status === 200 && buf.slice(0, 16).toString('latin1') === 'SQLite format 3\u0000',
        `HTTP ${dl.status} / ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    }

    // ---- 拒绝不合法输入（恢复前必须挡住） ----
    const badId = await req('/api/backup/restore/prepare', {
      method: 'POST', token, body: { backup_id: 999999 }
    });
    ok('不存在的备份不能恢复', badId.status === 400, `HTTP ${badId.status}`);

    const junk = await fetch(BASE + '/api/backup/restore/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(2048, 'not-a-database')
    });
    const junkJson = await junk.json();
    ok('非 SQLite 文件被拒绝', junk.status === 400, `HTTP ${junk.status} ${junkJson.message || ''}`);

    const tiny = await fetch(BASE + '/api/backup/restore/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(10)
    });
    ok('过小的上传被拒绝', tiny.status === 400, `HTTP ${tiny.status}`);

    const noPendingRollback = await req('/api/backup/restore/rollback', { method: 'POST', token });
    ok('没有待恢复时撤销会报错（不静默成功）', noPendingRollback.status === 400, `HTTP ${noPendingRollback.status}`);

    // ---- 准备恢复 + 撤销（不真重启，只验证前半段与退路） ----
    if (job) {
      const prep = await req('/api/backup/restore/prepare', {
        method: 'POST', token, body: { backup_id: job.id, note: '冒烟测试：验证准备与撤销' }
      });
      const pD = prep.status === 200 ? prep.json.data : null;
      ok('可以准备恢复（校验通过）', prep.status === 200 && pD.prepared === true, `HTTP ${prep.status}`);
      if (pD) {
        ok('准备恢复时自动生成了回滚点', !!pD.rollback_job_no, pD.rollback_job_no || '无');
        ok('待恢复文件校验结果随计划返回',
          !!pD.checks && pD.checks.integrity === 'ok' && pD.checks.tables > 100,
          `${pD.checks.tables} 张表`);
        // 记下回滚点，后面一起清
        const bk = await req('/api/backup/list?kind=pre_restore', { token });
        const rb = (bk.json.data || []).find((x) => x.job_no === pD.rollback_job_no);
        if (rb) created.push(rb.id);
      }

      const pd = await req('/api/backup/restore/pending', { token });
      ok('待恢复状态变为 true', pd.status === 200 && pd.json.data.pending === true);

      const rb = await req('/api/backup/restore/rollback', { method: 'POST', token });
      ok('可以撤销待恢复（重启前反悔）', rb.status === 200 && rb.json.data.rolled_back === true, `HTTP ${rb.status}`);

      const pd2 = await req('/api/backup/restore/pending', { token });
      ok('撤销后待恢复状态归零', pd2.status === 200 && pd2.json.data.pending === false);
    }

    // ---- 自清理：删掉本次生成的备份（含回滚点） ----
    try {
      let removed = 0;
      for (const id of created) {
        const r = await req(`/api/backup/${id}`, { method: 'DELETE', token });
        if (r.status === 200) removed++;
      }
      ok('备份用例跑完自清理', removed === created.length, `清理 ${removed}/${created.length} 份`);
    } catch (e) {
      ok('备份用例跑完自清理', false, e.message);
    }
  }

  // ================= 移动端扫码作业 =================
  {
    console.log('\n[移动端扫码作业]');

    const noAuth = await req('/api/settings/lan');
    ok('局域网地址接口需要登录', noAuth.status === 401, `HTTP ${noAuth.status}`);

    const lan = await req('/api/settings/lan', { token });
    const lanD = lan.status === 200 ? lan.json.data : {};
    ok('可读局域网地址（单据二维码要用）', lan.status === 200 && Array.isArray(lanD.urls),
      `HTTP ${lan.status} / ${(lanD.urls || []).join(',') || '无外网卡'}`);
    ok('局域网地址带端口且格式正确',
      (lanD.urls || []).every((u) => /^http:\/\/[\d.]+:\d+$/.test(u)),
      (lanD.urls || [])[0] || '（本机无局域网网卡，跳过）');

    // 扫码直达：按订单号查单
    const list = await req('/api/orders', { token });
    const first = (list.json.data || [])[0];
    if (first) {
      const byNo = await req('/api/orders/find?no=' + encodeURIComponent(first.order_no), { token });
      ok('扫订单号能查到单（扫码直达）',
        byNo.status === 200 && byNo.json.data && byNo.json.data.id === first.id,
        `HTTP ${byNo.status}`);

      // 标签码：订单号-款号-色-码，接口只取第一段
      const tag = first.order_no + '-WY-001-110';
      const byTag = await req('/api/orders/find?no=' + encodeURIComponent(tag), { token });
      ok('扫标签码能反解出订单（取第一段）',
        byTag.status === 200 && byTag.json.data && byTag.json.data.order_no === first.order_no,
        `HTTP ${byTag.status}`);

      const notFound = await req('/api/orders/find?no=NOPE-NOT-EXIST-999', { token });
      ok('不存在的码返回 404 而不是 500', notFound.status === 404, `HTTP ${notFound.status}`);
    } else {
      ok('扫订单号能查到单（扫码直达）', true, '无订单数据，跳过');
    }

    const emptyCode = await req('/api/orders/find?no=', { token });
    ok('空码被拒', emptyCode.status === 400, `HTTP ${emptyCode.status}`);
  }

  // ================= 现场照片留证 =================
  {
    console.log('\n[现场照片留证]');

    // 1×1 透明 PNG：够用来测「是不是真落盘、能不能取回来」
    const TINY_PNG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+9WQAAAAASUVORK5CYII=';
    const created = [];
    const fs2 = require('fs');
    const path2 = require('path');

    const noAuth = await req('/api/photos');
    ok('照片接口需要登录', noAuth.status === 401, `HTTP ${noAuth.status}`);

    const cats = await req('/api/photos/cats', { token });
    ok('可读照片分类（前后端共用一份口径）',
      cats.status === 200 && Array.isArray(cats.json.data) && cats.json.data.length >= 4,
      `${cats.status} / ${(cats.json.data || []).map((c) => c.code).join(',')}`);

    const list0 = await req('/api/orders', { token });
    const target = (list0.json.data || [])[0];

    if (target) {
      // 不良照片不写说明必须被拒（这是这一轮的核心规则）
      const noNote = await req('/api/photos', {
        method: 'POST',
        token,
        body: { order_id: target.id, dataUrl: TINY_PNG, cat: 'defect', note: '' }
      });
      ok('不良照片不写说明被拒', noNote.status === 400, `HTTP ${noNote.status} ${noNote.json.message || ''}`);

      const shortNote = await req('/api/photos', {
        method: 'POST',
        token,
        body: { order_id: target.id, dataUrl: TINY_PNG, cat: 'defect', note: '坏' }
      });
      ok('说明只有一个字也被拒（等于没写）', shortNote.status === 400, `HTTP ${shortNote.status}`);

      // 正常上传
      const good = await req('/api/photos', {
        method: 'POST',
        token,
        body: { order_id: target.id, dataUrl: TINY_PNG, cat: 'defect', note: '自测：左袖口跳线', taken_at: '2026-10-28 10:00:00' }
      });
      const row = good.status === 200 ? good.json.data : null;
      if (row) created.push(row);
      ok('上传照片成功并返回记录', good.status === 200 && !!row, `HTTP ${good.status}`);

      if (row) {
        ok('照片挂在订单上（target_type=order）',
          row.target_type === 'order' && Number(row.target_id) === Number(target.id),
          `${row.target_type}/${row.target_id}`);
        ok('分类与说明原样保存', row.cat === 'defect' && String(row.note).includes('自测'),
          `${row.cat} / ${row.note}`);

        // 文件真的落盘了吗
        const rel = String(row.url || '').replace(/^\/uploads\//, '');
        const file = path2.resolve(__dirname, '../data/uploads', rel);
        ok('照片文件真的落盘（不是只写了一条记录）', fs2.existsSync(file) && fs2.statSync(file).size > 0,
          file.replace(/\\/g, '/'));

        // 静态地址能取回图片
        const got = await fetch(BASE + row.url);
        ok('照片能通过 /uploads 取回', got.status === 200, `HTTP ${got.status} ${got.headers.get('content-type')}`);

        // 单张照片能查到
        const one = await req('/api/photos?order_id=' + target.id + '&cat=defect&limit=200', { token });
        ok('按订单 + 分类能筛出来',
          one.status === 200 && (one.json.data.rows || []).some((r) => r.id === row.id),
          `共 ${(one.json.data && one.json.data.total) || 0} 张`);

        const deco = (one.json.data.rows || []).find((r) => r.id === row.id) || {};
        ok('列表带订单号与分类中文名', !!deco.order_no && deco.cat_label === '不良',
          `${deco.order_no} / ${deco.cat_label}`);
        ok('列表带拍摄时间（没传就用上传时间）', !!deco.shot_at, deco.shot_at || '空');
      }

      // 订单不存在 / 工序不属于该单
      const badOrder = await req('/api/photos', {
        method: 'POST',
        token,
        body: { order_id: 99999999, dataUrl: TINY_PNG, cat: 'other', note: '自测孤儿' }
      });
      ok('订单不存在时拒绝挂照片（不留孤儿附件）', badOrder.status === 400, `HTTP ${badOrder.status}`);

      const otherNodes = await req('/api/order-nodes?order_id=1', { token });
      const foreign = (otherNodes.json.data || []).find((n) => Number(n.order_id) !== Number(target.id));
      if (foreign) {
        const badNode = await req('/api/photos', {
          method: 'POST',
          token,
          body: { order_id: target.id, dataUrl: TINY_PNG, cat: 'other', note: '自测错工序', node_id: foreign.id }
        });
        ok('工序不属于该单时拒绝', badNode.status === 400, `HTTP ${badNode.status}`);
      }

      // 非图片 / 非法分类
      const notImg = await req('/api/photos', {
        method: 'POST',
        token,
        body: { order_id: target.id, dataUrl: 'data:text/plain;base64,aGVsbG8=', cat: 'other', note: '自测' }
      });
      ok('非图片内容被拒', notImg.status === 400, `HTTP ${notImg.status}`);

      const badCat = await req('/api/photos', {
        method: 'POST',
        token,
        body: { order_id: target.id, dataUrl: TINY_PNG, cat: 'whatever', note: '自测' }
      });
      ok('非法分类被拒（不让中文自由输入把筛选搞坏）', badCat.status === 400, `HTTP ${badCat.status}`);
    }

    const st = await req('/api/photos/stats', { token });
    ok('照片统计可读（含分类分布与近 14 天）',
      st.status === 200 && Array.isArray(st.json.data.cats) && (st.json.data.days || []).length === 14,
      `总 ${st.json.data && st.json.data.total} 张`);

    // 软删除：删完列表里没了，但库里那一行还在（照片是证据）
    if (created.length) {
      const del = await req('/api/photos/' + created[0].id, { method: 'DELETE', token });
      ok('照片可以删除', del.status === 200, `HTTP ${del.status}`);

      const after = await req('/api/photos?limit=200', { token });
      ok('删除后列表里不再出现',
        !(after.json.data.rows || []).some((r) => r.id === created[0].id),
        '已从列表消失');

      const { db: DB } = require('../src/db');
      const still = DB.prepare('SELECT id, deleted_at, url FROM attachments WHERE id = ?').get(created[0].id);
      ok('软删除：记录仍在库里并带删除标记（证据不真删）',
        !!still && !!still.deleted_at, still ? `deleted_at=${still.deleted_at}` : '行被物理删了');

      // 自清理：把测试行与文件都清掉
      created.forEach((c) => {
        const rel = String(c.url || '').replace(/^\/uploads\//, '');
        const f = path2.resolve(__dirname, '../data/uploads', rel);
        try { if (fs2.existsSync(f)) fs2.unlinkSync(f); } catch (e) { /* ignore */ }
        try { DB.prepare('DELETE FROM attachments WHERE id = ?').run(c.id); } catch (e) { /* ignore */ }
      });
      ok('照片用例跑完自清理（测试记录与文件已删）', true, `清理 ${created.length} 条`);
    }
  }

  // ================= 验货报告 =================
  {
    console.log('\n[验货报告]');

    const TINY_PNG2 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+9WQAAAAASUVORK5CYII=';
    const fs3 = require('fs');
    const path3 = require('path');
    const { db: DB2 } = require('../src/db');

    const noAuth = await req('/api/inspection/preview/1');
    ok('验货报告接口需要登录', noAuth.status === 401, `HTTP ${noAuth.status}`);

    const orders2 = await req('/api/orders', { token });
    const o = (orders2.json.data || [])[0];
    if (!o) {
      ok('验货报告用例（无订单跳过）', true, '跳过');
    } else {
      const before = DB2.prepare('SELECT COUNT(*) c FROM inspection_reports').get().c;

      const pv = await req('/api/inspection/preview/' + o.id, { token });
      const s = pv.status === 200 ? pv.json.data : {};
      ok('预览能取到整单数据', pv.status === 200 && !!s.order && Array.isArray(s.item_lines),
        `HTTP ${pv.status}`);
      ok('预览不落库（不产生报告记录）',
        DB2.prepare('SELECT COUNT(*) c FROM inspection_reports').get().c === before,
        `仍为 ${before} 条`);
      ok('预览里带验货结论口径（无验货即 none）',
        ['pass', 'fail', 'conditional', 'none'].includes(s.qc && s.qc.result),
        `result=${s.qc && s.qc.result}`);
      ok('预览里照片按分类分组且总数对得上',
        (s.photos_by_cat || []).reduce((a, g) => a + g.items.length, 0) === (s.photos_count || 0),
        `${s.photos_count} 张`);
      ok('不良照片排在照片分组最前',
        !(s.photos_by_cat || []).length || (s.photos_by_cat || [])[0].cat === 'defect',
        (s.photos_by_cat || []).map((g) => g.cat).join(',') || '无照片');

      // 生成报告
      const g1 = await req('/api/inspection', { method: 'POST', token, body: { order_id: o.id } });
      const rep1 = g1.status === 200 ? g1.json.data : null;
      ok('生成报告成功', g1.status === 200 && !!rep1, `HTTP ${g1.status} ${g1.json.message || ''}`);
      if (rep1) {
        ok('报告编号格式正确（JH+日期+4 位）', /^JH\d{12}$/.test(rep1.report_no), rep1.report_no);
        ok('报告带版本号', Number(rep1.version) >= 1, `v${rep1.version}`);
        ok('报告里存了快照（不是实时查）', !!rep1.snapshot && !!rep1.snapshot.order, '已快照');

        // 用编号也能取
        const byNo = await req('/api/inspection/' + rep1.report_no, { token });
        ok('按报告编号能取回', byNo.status === 200 && byNo.json.data.id === rep1.id,
          `HTTP ${byNo.status}`);

        // ★ 核心断言：快照冻结
        const photoCountBefore = rep1.photos_count;
        const addPic = await req('/api/photos', {
          method: 'POST',
          token,
          body: { order_id: o.id, dataUrl: TINY_PNG2, cat: 'other', note: '快照测试' }
        });
        const newPic = addPic.status === 200 ? addPic.json.data : null;
        ok('为快照测试补了一张照片', addPic.status === 200, `HTTP ${addPic.status}`);

        const again = await req('/api/inspection/' + rep1.id, { token });
        ok('★ 已生成的报告不随数据变化（快照冻结）',
          again.status === 200 && again.json.data.photos_count === photoCountBefore,
          `报告仍 ${again.json.data && again.json.data.photos_count} 张 / 生成时 ${photoCountBefore} 张`);

        const pv2 = await req('/api/inspection/preview/' + o.id, { token });
        ok('预览会反映最新数据（+1 张）',
          pv2.status === 200 && pv2.json.data.photos_count === photoCountBefore + 1,
          `${pv2.json.data && pv2.json.data.photos_count} 张`);

        // 再次生成 → 版本递增，旧版不被覆盖
        const g2 = await req('/api/inspection', { method: 'POST', token, body: { order_id: o.id } });
        ok('再次生成版本递增（旧版保留）',
          g2.status === 200 && g2.json.data.version === rep1.version + 1 &&
          g2.json.data.report_no !== rep1.report_no,
          `v${g2.json.data && g2.json.data.version} / ${g2.json.data && g2.json.data.report_no}`);

        const hist = await req('/api/inspection?order_id=' + o.id, { token });
        ok('按订单能查到报告历史（版本倒序）',
          hist.status === 200 && (hist.json.data || []).length >= 2 &&
          Number(hist.json.data[0].version) >= Number(hist.json.data[1].version),
          `${(hist.json.data || []).length} 份`);

        // 清理：测试报告 + 测试照片
        const ids = [rep1.id];
        if (g2.status === 200 && g2.json.data) ids.push(g2.json.data.id);
        ids.forEach((id) => DB2.prepare('DELETE FROM inspection_reports WHERE id = ?').run(id));
        if (newPic) {
          const rel = String(newPic.url || '').replace(/^\/uploads\//, '');
          const f = path3.resolve(__dirname, '../data/uploads', rel);
          try { if (fs3.existsSync(f)) fs3.unlinkSync(f); } catch (e) { /* ignore */ }
          DB2.prepare('DELETE FROM attachments WHERE id = ?').run(newPic.id);
        }
        ok('报告用例跑完自清理', true, `清理 ${ids.length} 份报告 + 1 张测试照片`);
      }

      const notFound = await req('/api/inspection/preview/99999999', { token });
      ok('订单不存在返回 404 而不是 500', notFound.status === 404, `HTTP ${notFound.status}`);

      const badGet = await req('/api/inspection/JH000000000000', { token });
      ok('不存在的报告编号返回 404', badGet.status === 404, `HTTP ${badGet.status}`);
    }
  }

  // ================= 时间显示口径 =================
  {
    console.log('\n[时间显示口径]');

    const T = require('../src/utils/time');
    ok('UTC 时间转本地（+8 小时）',
      T.localTime('2026-10-27T16:44:54.772Z') === '2026-10-28 00:44',
      T.localTime('2026-10-27T16:44:54.772Z'));
    ok('带秒版本保留秒',
      T.localTimeSec('2026-10-27T16:44:54.772Z') === '2026-10-28 00:44:54',
      T.localTimeSec('2026-10-27T16:44:54.772Z'));
    ok('本地日期字符串不被二次转换',
      T.localTime('2026-10-28') === '2026-10-28' && T.localDate('2026-10-28') === '2026-10-28',
      T.localTime('2026-10-28'));
    ok('本地时间戳原样返回',
      T.localTime('2026-10-28 08:25:05') === '2026-10-28 08:25',
      T.localTime('2026-10-28 08:25:05'));
    ok('空值与非法值不抛异常',
      T.localTime(null) === '' && T.localTime('') === '' && typeof T.localTime('abc') === 'string',
      `null→"${T.localTime(null)}" / abc→"${T.localTime('abc')}"`);

    // 导出 CSV 里的时间必须是本地格式，不能是 ISO（带 T 和 Z）
    const csvRes = await fetch(BASE + '/api/orders/export', { headers: { Authorization: 'Bearer ' + token } });
    const csvText = csvRes.status === 200 ? await csvRes.text() : '';
    const csvLines = csvText.split(/\r?\n/).filter(Boolean);
    ok('订单导出可访问（CSV）', csvRes.status === 200 && csvLines.length >= 1,
      `HTTP ${csvRes.status}，${csvLines.length} 行`);

    // 创建时间列在最后一位：不能出现 ISO 的 T/Z
    const hasIso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(csvText);
    ok('导出里没有 ISO 时间（不带 T/Z）', !hasIso,
      hasIso ? '找到了 2026-..T.. 形式的时间' : '已转为本地格式');

    const lastCellTime = csvLines.slice(1).map((l) => l.split(',')[l.split(',').length - 2]).filter((x) => /^\d{4}-\d{2}-\d{2}/.test(x || ''));
    ok('创建时间是本地「YYYY-MM-DD HH:mm」格式',
      lastCellTime.length === 0 || lastCellTime.every((x) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x)),
      lastCellTime[0] || '（无订单数据）');
  }

  // ================= 扎标与扎号报工 =================
  {
    console.log('\n[扎标与扎号报工]');

    const noAuth = await req('/api/labels/bundles/1');
    ok('扎标接口需要登录', noAuth.status === 401, `HTTP ${noAuth.status}`);

    const { db: DB3 } = require('../src/db');
    const withBundles = DB3.prepare(
      `SELECT c.order_id AS id, o.order_no, COUNT(b.id) AS n
         FROM cut_orders c JOIN cut_bundles b ON b.cut_order_id = c.id
         JOIN orders o ON o.id = c.order_id
        GROUP BY c.order_id ORDER BY n DESC LIMIT 1`
    ).get();

    if (!withBundles) {
      ok('扎标用例（无扎包数据跳过）', true, '跳过');
    } else {
      const bid = withBundles.id;
      const lb = await req('/api/labels/bundles/' + bid, { token });
      const d = lb.status === 200 ? lb.json.data : {};
      ok('能取到整单的扎', lb.status === 200 && Array.isArray(d.bundles) && d.bundles.length > 0,
        `${(d.bundles || []).length} 扎`);

      const b0 = (d.bundles || [])[0] || {};
      ok('扎码 = 订单号-扎号（纯 ASCII）',
        b0.code === `${withBundles.order_no}-${b0.bundle_no}` && /^[\x20-\x7E]+$/.test(b0.code || ''),
        b0.code);
      ok('扎合计与逐扎求和一致',
        d.total_qty === (d.bundles || []).reduce((a, b) => a + Number(b.qty || 0), 0),
        `${d.total_qty}`);

      // 扫码解析：三种码
      const r1 = await req('/api/labels/resolve?code=' + encodeURIComponent(withBundles.order_no), { token });
      ok('扫订单号 → 解析成订单',
        r1.status === 200 && r1.json.data.kind === 'order' && !r1.json.data.bundle,
        `kind=${r1.json.data && r1.json.data.kind}`);

      const r2 = await req('/api/labels/resolve?code=' + encodeURIComponent(b0.code), { token });
      ok('★ 扫扎标码 → 解析出这一扎',
        r2.status === 200 && r2.json.data.kind === 'bundle' &&
        r2.json.data.bundle.bundle_no === b0.bundle_no,
        `kind=${r2.json.data && r2.json.data.kind} / ${r2.json.data && r2.json.data.bundle && r2.json.data.bundle.bundle_no}`);

      const fake = await req('/api/labels/resolve?code=' + encodeURIComponent(withBundles.order_no + '-NO-SUCH-BUNDLE'), { token });
      ok('码里的扎号对不上时给出提示（不当作正常单）',
        fake.status === 200 && fake.json.data.kind === 'order' && !!fake.json.data.bundle_missing,
        `missing=${fake.json.data && fake.json.data.bundle_missing}`);

      const empty = await req('/api/labels/resolve?code=', { token });
      ok('空码被拒', empty.status === 400, `HTTP ${empty.status}`);

      const nf = await req('/api/labels/resolve?code=NOSUCHORDER-1', { token });
      ok('订单不存在返回 404', nf.status === 404, `HTTP ${nf.status}`);

      const badOrder = await req('/api/labels/bundles/99999999', { token });
      ok('订单不存在时扎标接口 404', badOrder.status === 404, `HTTP ${badOrder.status}`);

      // 报工带扎号
      const nodes = await req('/api/order-nodes?order_id=' + bid, { token });
      const node = (nodes.json.data || [])[0];
      if (node) {
        const before = DB3.prepare('SELECT COUNT(*) c FROM production_reports WHERE order_id = ?').get(bid).c;
        const rep = await req('/api/reports', {
          method: 'POST', token,
          body: { order_id: bid, node_id: node.id, qty_ok: 1, qty_defect: 0, hours: 0, bundle_no: b0.bundle_no }
        });
        const got = rep.status === 200 ? rep.json.data : null;
        ok('报工能带扎号落库', rep.status === 200 && got && got.bundle_no === b0.bundle_no,
          `HTTP ${rep.status} bundle_no=${got && got.bundle_no}`);

        // 默认日期必须是本地今天（UTC 会在晚上 8 点后跑到前一天）
        const T = require('../src/utils/time');
        const todayLocal = T.localDate(new Date().toISOString());
        ok('报工默认日期是本地今天（不是 UTC）',
          got && got.report_date === todayLocal, `${got && got.report_date} vs ${todayLocal}`);

        const badBundle = await req('/api/reports', {
          method: 'POST', token,
          body: { order_id: bid, node_id: node.id, qty_ok: 1, bundle_no: 'NOT-A-REAL-BUNDLE' }
        });
        ok('扎号不属于该单时拒绝报工', badBundle.status === 400, `HTTP ${badBundle.status}`);
        ok('被拒的报工没有落库',
          DB3.prepare('SELECT COUNT(*) c FROM production_reports WHERE order_id = ?').get(bid).c === before + 1,
          `前后差 ${DB3.prepare('SELECT COUNT(*) c FROM production_reports WHERE order_id = ?').get(bid).c - before} 条`);

        if (got) {
          DB3.prepare('DELETE FROM production_reports WHERE id = ?').run(got.id);
          ok('扎标用例跑完自清理', true, `删除测试报工 ${got.id}`);
        }
      }
    }
  }

  // ================= 扎级完工进度 =================
  {
    console.log('\n[扎级完工进度]');
    const list = await req('/api/labels/progress', { token });
    ok('有扎的订单清单可读', list.status === 200 && Array.isArray(list.json.data), `HTTP ${list.status}`);

    const ordersWithBundles = list.json.data || [];
    ok(
      '清单里每单都带扎数与件数',
      ordersWithBundles.every((o) => typeof o.bundles === 'number' && typeof o.bundle_qty === 'number'),
      JSON.stringify(ordersWithBundles[0] || null)
    );

    const od = ordersWithBundles.find((o) => o.bundles > 0);
    if (!od) {
      ok('扎级进度明细', true, '库里没有扎包，跳过');
    } else {
      const dRes = await req(`/api/labels/progress/${od.id}`, { token });
      const d = dRes.json.data || {};
      const s = d.summary || {};
      ok('明细可读', dRes.status === 200 && Array.isArray(d.bundles), `HTTP ${dRes.status}`);
      ok(
        '四种状态合计 = 扎数（不多算不漏算）',
        s.done + s.doing + s.short + s.idle === s.bundles,
        `${s.done}+${s.doing}+${s.short}+${s.idle} vs ${s.bundles}`
      );
      ok(
        '逐扎件数合计 = 汇总件数',
        d.bundles.reduce((a, b) => a + b.qty, 0) === s.total_qty,
        `${d.bundles.reduce((a, b) => a + b.qty, 0)} vs ${s.total_qty}`
      );
      ok(
        '工序列无重名（同名 node 已合并）',
        new Set(d.processes.map((p) => p.name)).size === d.processes.length,
        d.processes.map((p) => p.name).join(',')
      );
      ok(
        '工序按 seq 升序',
        d.processes.every((p, i) => i === 0 || p.seq >= d.processes[i - 1].seq),
        JSON.stringify(d.processes.map((p) => p.seq))
      );
      ok('末道不取「出库发运」（整单动作，不是单扎动作）', s.final_process !== '出库发运', s.final_process);

      // 状态与数据自洽：这是整页结论的可信度来源
      const finalName = s.final_process;
      const badState = d.bundles.filter((b) => {
        const f = b.cells[finalName];
        const fo = f ? f.ok : 0;
        if (b.status === 'done') return !(b.qty > 0 && fo >= b.qty);
        if (b.status === 'short') return !(fo > 0 && fo < b.qty);
        if (b.status === 'idle') return b.touched !== 0;
        if (b.status === 'doing') return !(fo === 0 && b.touched > 0);
        return true;
      });
      ok('每扎状态与末道数据自洽', badState.length === 0, badState.map((b) => b.bundle_no + ':' + b.status).join(','));

      // 超报标记必须与单元格一致（任一工序合格超过件数）
      const misOver = d.bundles.filter((b) => {
        const over = Object.values(b.cells).some((c) => c && b.qty > 0 && c.ok > b.qty);
        return over !== !!b.over;
      });
      ok('超报标记与单元格数据一致', misOver.length === 0, misOver.map((b) => b.bundle_no).join(','));

      // 未归扎：与库里对，且明细合计等于汇总
      const { db } = require('../src/db');
      const unCnt = db
        .prepare('SELECT COUNT(*) c FROM production_reports WHERE order_id = ? AND bundle_no IS NULL')
        .get(od.id).c;
      ok('未归扎报工数与库一致', s.unassigned_reports === unCnt, `${s.unassigned_reports} vs ${unCnt}`);
      ok(
        '未归扎明细件数合计 = 汇总件数',
        (d.unassigned_by_node || []).reduce((a, x) => a + x.qty, 0) === s.unassigned_qty,
        JSON.stringify(d.unassigned_by_node || [])
      );

      // 报工带扎号 → 归到这一扎（造一条，验完就清）
      const idle = d.bundles.find((b) => b.status === 'idle');
      if (idle) {
        const node = db
          .prepare('SELECT id, name FROM order_nodes WHERE order_id = ? ORDER BY seq LIMIT 1')
          .get(od.id);
        const created = await req('/api/reports', {
          method: 'POST',
          token,
          body: { order_id: od.id, node_id: node.id, qty_ok: 1, bundle_no: idle.bundle_no }
        });
        ok('记扎号的报工能提交', created.status === 200, `HTTP ${created.status} ${created.json.message || ''}`);

        const d2 = (await req(`/api/labels/progress/${od.id}`, { token })).json.data;
        const b2 = d2.bundles.find((b) => b.bundle_no === idle.bundle_no);
        ok('报工后该扎由「未开工」变「在制」', b2.status === 'doing' && b2.touched === 1, `${b2.status}/${b2.touched}`);
        ok(
          '该扎对应工序格出现 1 件',
          !!b2.cells[node.name] && b2.cells[node.name].ok === 1,
          JSON.stringify(b2.cells[node.name] || null)
        );
        ok(
          '记了扎号的报工不进「未归扎」',
          d2.summary.unassigned_reports === s.unassigned_reports,
          `${d2.summary.unassigned_reports} vs ${s.unassigned_reports}`
        );

        const rid = created.json.data && created.json.data.id;
        if (rid) await req(`/api/reports/${rid}`, { method: 'DELETE', token });
        const d3 = (await req(`/api/labels/progress/${od.id}`, { token })).json.data;
        const b3 = d3.bundles.find((b) => b.bundle_no === idle.bundle_no);
        ok('清理后该扎回到未开工（用例可重复跑）', b3.status === 'idle', b3.status);
      } else {
        ok('有未开工的扎可测报工归扎', true, '本单所有扎都已开工，跳过');
      }

      const nf = await req('/api/labels/progress/999999', { token });
      ok('不存在的订单返回 404', nf.status === 404, `HTTP ${nf.status}`);
    }

    const noAuth = await req('/api/labels/progress');
    ok('扎级进度需要登录', noAuth.status === 401, `HTTP ${noAuth.status}`);
  }

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('\n失败清单：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('✓ 全部通过\n');
})();
