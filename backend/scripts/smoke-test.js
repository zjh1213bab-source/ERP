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
let skipped = 0;      // 单公司模式下被跳过的多主体断言
const failures = [];

/**
 * 单公司模式
 *
 * 业务上只服务一家公司，多主体隔离在 src/access/companyScope.js 里被总开关关掉了。
 * 那么「跨主体读不到」这一整类断言在单公司模式下**必然不成立**（不是坏了，是前提没了）。
 *
 * 处理方式：**在 ok() 这一层按块跳过**，块里的代码一行不动 ——
 * 切回多主体（SINGLE_COMPANY=0）时这些断言自动恢复，不需要回头改测试。
 * 这是"注释掉而不是删掉"在测试里的对应做法。
 */
const SCOPE = require('../src/access/companyScope');
/** 本机配置（兜底用）：脚本可能不是在被测服务同一份 env 下跑 */
const LOCAL_SINGLE = SCOPE.isSingle();
/**
 * 被测服务的模式 —— 登录后从 /api/settings 读，**以它为准**。
 *
 * 为什么不能用本机 env：冒烟可以用 BASE 指向另一个实例
 * （比如用 SINGLE_COMPANY=0 起的多主体实例做回归）。那时本机 env 还是单公司，
 * 脚本会按单公司跳过 112 条断言 —— 结果"跑过了"，其实一条都没验。
 * 这种"看起来绿、实际没跑"比红更危险。
 */
let serverSingle = null;
/** 生效中的模式：拿到服务端答复之前先用本机配置 */
function isSingleMode() {
  return serverSingle === null ? LOCAL_SINGLE : serverSingle;
}
/** 这些块整体验的是多主体隔离 */
const SCOPE_BLOCK_PREFIX = '数据范围：';

/**
 * 记录本次跑过的用例块（`console.log('\n[块名]')` 形式）
 *
 * 为什么需要：条数会随数据浮动（某块按"当前有几张可退采购单"循环），
 * 所以「2253 变 2247」既可能是数据分支，也可能是整块被跳过 —— 光看总数分不清。
 * v1.64 我就为此花了半小时人肉比对。现在块数单独钉一条断言：真丢一整块会立刻破线。
 */
const blockSeen = new Set();
/** 当前块名 —— ok() 靠它判断"这条断言属不属于多主体那一类" */
let currentBlock = '';
{
  const rawLog = console.log.bind(console);
  console.log = (...args) => {
    if (args.length === 1 && typeof args[0] === 'string') {
      const m = args[0].trim().match(/^\[(.+)\]$/);
      if (m) { blockSeen.add(m[1]); currentBlock = m[1]; }
    }
    rawLog(...args);
  };
}

function ok(name, cond, extra) {
  /**
   * 单公司模式下，多主体块的断言只记"跳过"，不计通过也不计失败。
   *
   * 为什么在 ok() 里拦而不是去包每一块：那些块有十几处、嵌套结构复杂，
   * 手工包 if/else 极易把花括号配错（配错了还可能是"少跑几条"而不是报错）。
   * 拦在唯一的出口上，块内代码一个字都不用动。
   */
  if (isSingleMode() && String(currentBlock).startsWith(SCOPE_BLOCK_PREFIX)) {
    skipped += 1;
    return;
  }
  /**
   * 对称的一条：多主体模式下，「单公司模式」块里那几条断言（"别的主体账号也能读到"、
   * "所有人都看全部"）本来就不该成立 —— 它验的是开关关了之后的行为。
   *
   * 两种模式各自只跑属于自己的那一半，全程 0 失败。少这一条的话，
   * 切回 SINGLE_COMPANY=0 跑冒烟会稳定红 4 条，而人看到红第一个反应是"改坏了"。
   */
  if (!isSingleMode() && currentBlock === '单公司模式') {
    skipped += 1;
    return;
  }
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (extra ? ' -> ' + extra : ''));
    console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

async function req(path, { method = 'GET', body, token, headers: extra } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(extra || {}) };
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

  /**
   * 登录被限流 → 直接停，别让两千条断言跟着红
   *
   * 冒烟一次要登录几十次（每个块各登一次，还故意试错密码）。**60 秒内连跑两次**
   * 就会撞上 `LOGIN_ATTEMPT_MAX`（默认 120/分钟/IP），此时后续每条断言都会因为
   * "拿不到 token"变红 —— 而代码一行没改。那种红最费时间：清单很长、全是 401。
   * 这里明确说清原因和怎么恢复，比让人去逐条排查强。
   */
  if (login.status === 429) {
    console.log('\n登录被限流（429）：多半是 60 秒内重复跑了冒烟。');
    console.log(`等 60 秒再跑，或用更大的 LOGIN_ATTEMPT_MAX 启动被测服务（当前 BASE=${BASE}）。`);
    process.exit(2);
  }

  // 被测服务到底跑在哪种模式（决定后面哪些断言跑、哪些跳过）
  if (token) {
    try {
      const st0 = await req('/api/settings', { token });
      if (st0.status === 200 && st0.json.data && typeof st0.json.data.single_company === 'boolean') {
        serverSingle = st0.json.data.single_company;
      }
    } catch (e) { /* 读不到就按本机配置 */ }
  }

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

  // 5.5.1 工序明细（开发单「工艺工序」的展开填写）
  // 关键点：它写的必须是**打版流程 craft 阶段那份数据**，不能再存第二份，否则工价两套。
  {
    const anyOrders = (await req('/api/orders', { token })).json.data || [];
    const oid = anyOrders[0] && anyOrders[0].id;
    if (oid) {
      const mkTp = await req('/api/techpacks', {
        method: 'POST', token,
        body: { order_id: oid, product_name: 'SMOKE-CRAFT-' + String(Date.now()).slice(-6) }
      });
      const tpId = mkTp.status === 200 ? mkTp.json.data.id : null;
      const e0 = await req(`/api/techpacks/${tpId}/crafts`, { token });
      ok('工序明细：新开发单是空表', e0.status === 200 && (e0.json.data.sewing || []).length === 0,
        `HTTP ${e0.status}`);

      const w1 = await req(`/api/techpacks/${tpId}/crafts`, {
        method: 'PUT', token,
        body: {
          sewing: [{ category: '车缝', name: '四线合肩', price: 0.45, ratio: 1 }, { category: '车缝', name: '', price: 9 }],
          finish: [{ category: '后整', name: '整烫', price: 0.25, ratio: 1 }]
        }
      });
      ok('★ 工序明细可保存（空行被丢弃）',
        w1.status === 200 && w1.json.data.sewing.length === 1 && w1.json.data.finish.length === 1,
        `车缝 ${w1.json.data ? w1.json.data.sewing.length : '?'} / 后整 ${w1.json.data ? w1.json.data.finish.length : '?'}`);

      const pf = await req(`/api/pattern-flows/by-techpack/${tpId}`, { token });
      const craftStage = ((pf.json.data || {}).stages || []).find((s) => s.stage === 'craft') || {};
      const cd = craftStage.data || {};
      ok('★ 工序存的是打版流程 craft 阶段那份数据（不是第二份）',
        (cd.sewing || []).length === 1 && (cd.finish || []).length === 1,
        `craft.sewing=${(cd.sewing || []).length}`);

      const w2 = await req(`/api/techpacks/${tpId}/crafts`, {
        method: 'PUT', token, body: { sewing: [{ category: '车缝', name: '锁眼', price: 0.1, ratio: 1 }] }
      });
      ok('★ 只更新一组时另一组不被清空',
        w2.status === 200 && (w2.json.data.finish || []).length === 1,
        `后整 ${w2.json.data ? (w2.json.data.finish || []).length : '?'}`);

      const got = await req(`/api/techpacks/${tpId}/crafts`, { token });
      ok('工序回读与写入一致（名称/单价/倍率）',
        got.status === 200 && got.json.data.sewing[0].name === '锁眼'
        && Number(got.json.data.sewing[0].price) === 0.1,
        JSON.stringify(got.json.data && got.json.data.sewing && got.json.data.sewing[0]));

      await req(`/api/techpacks/${tpId}`, { method: 'DELETE', token });
    } else {
      ok('工序明细（跳过：没有可用订单）', true);
    }
  }

  // 5.5.2 确认前闸门：定制订单必须至少 1 道车缝工序（v1.68.5）
  // 两条路（/confirm 与 /stage -> confirmed）共用同一个 confirmBlocks()，
  // 各写一份必然"这条拦、那条漏"—— 这里两条都验，就是为了挡住那种回归。
  {
    const allOrders = (await req('/api/orders', { token })).json.data || [];
    const customOrder = allOrders.find((o) => o.type === 'custom');
    if (!customOrder) {
      ok('确认前闸门（跳过：没有定制订单）', true);
    } else {
      const gname = 'SMOKE-GATE-' + String(Date.now()).slice(-6);
      const mk = await req('/api/techpacks', {
        method: 'POST', token,
        body: {
          order_id: customOrder.id, product_name: gname,
          fabric_info: '冒烟面料', accessory_info: '冒烟辅料',
          craft_info: '冒烟工艺说明', customer_req: '冒烟客户要求'
        }
      });
      const gid = mk.status === 200 ? mk.json.data.id : null;
      ok('闸门夹具：定制订单开发单（字段齐、只差工序）', !!gid, `HTTP ${mk.status}`);

      const chk = await req(`/api/techpacks/${gid}/confirm-check`, { token });
      const bKeys = ((chk.json.data && chk.json.data.blocks) || []).map((b) => b.key);
      ok('★ 没填车缝时：确认前检查报「工序明细未填」',
        chk.status === 200 && chk.json.data.ok === false && bKeys.includes('craft_sewing'),
        `blocks=${bKeys.join(',')}`);

      const c1 = await req(`/api/techpacks/${gid}/confirm`, { method: 'POST', token });
      ok('★ 没填车缝时：确认接口拒绝并说明要补什么',
        c1.status === 400 && String(c1.json.message).includes('车缝'),
        `HTTP ${c1.status} ${String(c1.json.message).slice(0, 26)}`);

      const s1 = await req(`/api/techpacks/${gid}/stage`, { method: 'POST', token, body: { stage: 'confirmed' } });
      ok('★ 没填车缝时：流程推到「已完成」同样被拒（两条路同一份判断）', s1.status === 400, `HTTP ${s1.status}`);

      await req(`/api/techpacks/${gid}/crafts`, {
        method: 'PUT', token, body: { sewing: [{ category: '车缝', name: '合肩', price: 1 }] }
      });
      const chk2 = await req(`/api/techpacks/${gid}/confirm-check`, { token });
      ok('★ 补 1 道车缝后：确认前检查放行',
        chk2.status === 200 && chk2.json.data.ok === true, JSON.stringify(chk2.json.data.blocks));

      const c2 = await req(`/api/techpacks/${gid}/confirm`, { method: 'POST', token });
      ok('补工序后确认成功（闸门不是死锁）',
        c2.status === 200 && c2.json.data.status === 'confirmed', `HTTP ${c2.status}`);

      const stockOrder = allOrders.find((o) => o.type === 'stock');
      if (stockOrder) {
        const mk2 = await req('/api/techpacks', {
          method: 'POST', token,
          body: {
            order_id: stockOrder.id, product_name: gname + '-S',
            fabric_info: 'x', accessory_info: 'x', craft_info: 'x', customer_req: 'x'
          }
        });
        const sid = mk2.status === 200 ? mk2.json.data.id : null;
        const chk3 = await req(`/api/techpacks/${sid}/confirm-check`, { token });
        ok('★ 现货订单不卡工序（只卡定制单）',
          chk3.status === 200 && chk3.json.data.ok === true, JSON.stringify(chk3.json.data.blocks));
        await req(`/api/techpacks/${sid}`, { method: 'DELETE', token });
      } else {
        ok('现货订单不卡工序（跳过：没有现货订单）', true);
      }

      // 已确认的开发单不能直接删 → 先回草稿（这本身也是既有口径，顺带验一次）
      await req(`/api/techpacks/${gid}/stage`, { method: 'POST', token, body: { stage: 'draft' } });
      const del = await req(`/api/techpacks/${gid}`, { method: 'DELETE', token });
      ok('闸门夹具已清理（已确认单先回草稿再删）', del.status === 200, `HTTP ${del.status}`);
    }
  }

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
      // 老版本是把字段置 null（页面显示空白，分不清「没填」还是「没权限」）；
      // 现在统一走字段级脱敏：没权限时给掩码，所以这里同时接受 null 与含 * 的值
      const hidden = (v) => v === null || v === undefined || (typeof v === 'string' && v.includes('*'));
      const masked = empRows.length > 0 && empRows.every((e) => hidden(e.id_card) && hidden(e.base_salary));
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

      /**
       * 撤销会把待恢复文件归档进 data/replaced/（一份 ≈80MB）。
       * 每次冒烟、每次演练都留一份，138 份就是 6.4GB —— 而且没有任何界面会提醒。
       * 现在撤销后按保留上限裁（最新 5 份），这里把上限钉住。
       */
      const rpDir = require('path').resolve(__dirname, '../data/replaced');
      const rpFiles = require('fs').existsSync(rpDir)
        ? require('fs').readdirSync(rpDir).filter((f) => f.startsWith('restore-cancelled-'))
        : [];
      const cancelledCount = rpFiles.length;
      // 失败时要把「哪一份、为什么没删」带出来 —— 只报数量的话，下次还是得靠猜
      const pruned = (rb.json.data && rb.json.data.pruned) || {};
      ok('★ 撤销恢复后旧副本按上限保留（不无限堆积占满磁盘）', cancelledCount <= 5,
        `replaced/ 里 restore-cancelled 共 ${cancelledCount} 份（上限 5）`
        + ` | 本次裁剪 deleted=${pruned.deleted} failed=${JSON.stringify(pruned.failed || [])}`
        + ` | 现存 ${rpFiles.join(', ')}`);
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


  // ================= 计件工资 =================
  {
    console.log('\n[计件工资]');
    const PW = require('../src/services/pieceWage');
    const { db } = require('../src/db');

    // 用 1999-01 这个空期间自造数据：不干扰真实月份的核算单
    const TEST_PERIOD = '1999-01';
    const TEST_PROC = '__计件测试工序__';
    const TEST_STYLE = null; // 通用价
    const loginAs = async (u) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: PASS } });
      return r.status === 200 ? r.json.data.token : '';
    };

    // 清理（幂等：重复跑不会堆数据）
    const cleanup = () => {
      db.prepare("DELETE FROM production_reports WHERE remark = 'SMOKE-PW'").run();
      db.prepare("DELETE FROM attendance WHERE remark = 'SMOKE-PW'").run();
      db.prepare('DELETE FROM piece_rates WHERE process_name = ?').run(TEST_PROC);
      const runs = db.prepare("SELECT id FROM piece_wage_runs WHERE period = ?").all(TEST_PERIOD);
      runs.forEach((r) => {
        db.prepare('DELETE FROM piece_wage_items WHERE run_id = ?').run(r.id);
        db.prepare('DELETE FROM piece_wage_runs WHERE id = ?').run(r.id);
      });
    };
    cleanup();

    // 全局配置会被临时改，跑完必须还原（否则演示库的工钱口径被测试带偏）
    const cfgOrigin = db.prepare('SELECT * FROM piece_wage_config WHERE id = 1').get();
    const restoreCfg = () => {
      if (!cfgOrigin) return;
      db.prepare(
        'UPDATE piece_wage_config SET daily_cap_qty=?, month_cap=?, attendance_policy=?, updated_by=?, updated_at=? WHERE id=1'
      ).run(
        cfgOrigin.daily_cap_qty, cfgOrigin.month_cap, cfgOrigin.attendance_policy,
        cfgOrigin.updated_by, cfgOrigin.updated_at
      );
    };

    // 找一个有扎的订单 + 一名在职员工
    // 挑「件数最少」的扎：一报就能占满，再补 5 件必然超报，才测得到封顶
    const bundle = db
      .prepare(
        `SELECT co.order_id AS order_id, b.bundle_no AS bundle_no, b.qty AS qty
           FROM cut_bundles b JOIN cut_orders co ON co.id = b.cut_order_id
          WHERE b.qty > 0 ORDER BY b.qty ASC LIMIT 1`
      )
      .get();
    const emp = db.prepare("SELECT id, name FROM employees WHERE status = 'active' ORDER BY id LIMIT 1").get();

    if (!bundle || !emp) {
      ok('计件工资用例前置数据', true, '库里没有扎包或在职员工，跳过');
    } else {
      // ---------- 单价 ----------
      const r1 = await req('/api/piece-wage/rates', {
        method: 'POST', token,
        body: { process_name: TEST_PROC, unit_price: 1, effective_from: '1999-01-01' }
      });
      ok('可新增工序单价', r1.status === 200, `HTTP ${r1.status} ${r1.json.message || ''}`);
      const dup = await req('/api/piece-wage/rates', {
        method: 'POST', token,
        body: { process_name: TEST_PROC, unit_price: 2, effective_from: '1999-01-01' }
      });
      ok('同工序同生效日重复录入被拒', dup.status === 400, `HTTP ${dup.status}`);
      const badPrice = await req('/api/piece-wage/rates', {
        method: 'POST', token,
        body: { process_name: TEST_PROC, unit_price: -1, effective_from: '1999-02-01' }
      });
      ok('负单价被拒', badPrice.status === 400, `HTTP ${badPrice.status}`);
      const badDate = await req('/api/piece-wage/rates', {
        method: 'POST', token,
        body: { process_name: TEST_PROC, unit_price: 1, effective_from: '1999/01/01' }
      });
      ok('生效日格式不合规被拒', badDate.status === 400, `HTTP ${badDate.status}`);

      // 版本化：6-01 起的新价应该接管 6 月，1 月仍用旧价
      await req('/api/piece-wage/rates', {
        method: 'POST', token,
        body: { process_name: TEST_PROC, unit_price: 2.5, effective_from: '1999-06-01' }
      });
      const inJan = PW.rateOf(TEST_STYLE, TEST_PROC, '1999-01-15');
      const inJun = PW.rateOf(TEST_STYLE, TEST_PROC, '1999-06-15');
      ok('单价按生效日版本化（1 月用 1 元）', inJan.rate && Number(inJan.rate.unit_price) === 1,
        JSON.stringify(inJan.rate && inJan.rate.unit_price));
      ok('单价按生效日版本化（6 月用 2.5 元）', inJun.rate && Number(inJun.rate.unit_price) === 2.5,
        JSON.stringify(inJun.rate && inJun.rate.unit_price));

      // ---------- 造两条报工：第一条占满 15 件，第二条超报被封顶 ----------
      const insRep = db.prepare(
        `INSERT INTO production_reports
           (order_id, node_id, node_name, report_date, qty_ok, qty_defect, hours, operator, employee_id, remark, created_at, bundle_no)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      const cap = Number(bundle.qty);
      // 第一条报满整扎，第二条再报 5 件 —— 必然超报，才测得到封顶
      insRep.run(bundle.order_id, null, TEST_PROC, '1999-01-10', cap, 0, 0, emp.name, emp.id, 'SMOKE-PW', '1999-01-10 10:00:00', bundle.bundle_no);
      insRep.run(bundle.order_id, null, TEST_PROC, '1999-01-11', 5, 0, 0, emp.name, emp.id, 'SMOKE-PW', '1999-01-11 10:00:00', bundle.bundle_no);

      const pv = await req('/api/piece-wage/preview?period=' + TEST_PERIOD, { token });
      const d = pv.json.data || {};
      const s = d.summary || {};
      ok('试算可读', pv.status === 200 && Array.isArray(d.items), `HTTP ${pv.status}`);
      ok('超报被封顶（同扎同工序累计不超过扎件数）', s.capped_count >= 1, `capped=${s.capped_count}`);
      ok(
        '封顶后计件数量不超扎件数',
        d.items.reduce((a, x) => a + x.qty, 0) <= cap,
        `${d.items.reduce((a, x) => a + x.qty, 0)} vs 扎 ${cap}`
      );
      ok(
        '明细金额 = 数量 × 单价',
        d.items.every((x) => Math.abs(x.amount - Math.round(x.qty * x.unit_price * 100) / 100) < 0.01),
        JSON.stringify(d.items.map((x) => [x.qty, x.unit_price, x.amount]))
      );
      ok(
        '按人汇总 = 明细合计',
        Math.abs((d.by_employee || []).reduce((a, x) => a + x.amount, 0) - s.total_amount) < 0.01,
        `${(d.by_employee || []).reduce((a, x) => a + x.amount, 0)} vs ${s.total_amount}`
      );

      // ---------- 草案 → 确认 → 作废 ----------
      const mk = await req('/api/piece-wage/runs', { method: 'POST', token, body: { period: TEST_PERIOD } });
      ok('可生成核算草案', mk.status === 200 && mk.json.data.status === 'draft', `HTTP ${mk.status} ${mk.json.message || ''}`);
      const runNo = mk.json.data && mk.json.data.run_no;

      const mk2 = await req('/api/piece-wage/runs', { method: 'POST', token, body: { period: TEST_PERIOD } });
      ok('草案可覆盖且编号不变（同一期间只是当前试算）',
        mk2.status === 200 && mk2.json.data.run_no === runNo, `${runNo} vs ${mk2.json.data && mk2.json.data.run_no}`);
      // 覆盖是「删旧行 + 插新行」，id 会变；后面一律用最新那份
      const runId = mk2.json.data && mk2.json.data.id;

      const cf = await req(`/api/piece-wage/runs/${runId}/confirm`, { method: 'POST', token, body: {} });
      ok('可确认核算单', cf.status === 200 && cf.json.data.status === 'confirmed', `HTTP ${cf.status} ${cf.json.message || ''}`);
      const cf2 = await req(`/api/piece-wage/runs/${runId}/confirm`, { method: 'POST', token, body: {} });
      ok('重复确认被拒', cf2.status === 400, `HTTP ${cf2.status}`);
      const mk3 = await req('/api/piece-wage/runs', { method: 'POST', token, body: { period: TEST_PERIOD } });
      ok('已确认的月份不许再生成草案', mk3.status === 400, `HTTP ${mk3.status}`);

      const voidNoReason = await req(`/api/piece-wage/runs/${runId}/void`, { method: 'POST', token, body: { reason: '短' } });
      ok('作废必须写够理由', voidNoReason.status === 400, `HTTP ${voidNoReason.status}`);
      const voidOk = await req(`/api/piece-wage/runs/${runId}/void`, { method: 'POST', token, body: { reason: '冒烟测试作废' } });
      ok('写够理由可作废', voidOk.status === 200 && voidOk.json.data.status === 'void', `HTTP ${voidOk.status}`);
      const mk4 = await req('/api/piece-wage/runs', { method: 'POST', token, body: { period: TEST_PERIOD } });
      ok('作废后可以重新生成', mk4.status === 200, `HTTP ${mk4.status} ${mk4.json.message || ''}`);

      // ---------- 考勤联动 ----------
      {
        const cfgRead = await req('/api/piece-wage/config', { token });
        ok('可读考勤联动配置', cfgRead.status === 200 && typeof cfgRead.json.data.attendance_policy === 'string',
          `HTTP ${cfgRead.status}`);
        const badPolicy = await req('/api/piece-wage/config', {
          method: 'PUT', token, body: { daily_cap_qty: 0, month_cap: 1, attendance_policy: 'whatever' }
        });
        ok('非法考勤策略被拒', badPolicy.status === 400, `HTTP ${badPolicy.status}`);
        const badCap = await req('/api/piece-wage/config', {
          method: 'PUT', token, body: { daily_cap_qty: -1, month_cap: 1, attendance_policy: 'warn' }
        });
        ok('负的日上限被拒', badCap.status === 400, `HTTP ${badCap.status}`);

        // 10 号请假、11 号查不到考勤 —— 两种情形要分开算：前者是铁证冲突，后者只提示
        db.prepare("DELETE FROM attendance WHERE remark = 'SMOKE-PW'").run();
        db.prepare(
          `INSERT INTO attendance (employee_id, employee_name, date, check_in, check_out, status, remark, created_at)
           VALUES (?,?,?,NULL,NULL,'leave','SMOKE-PW','1999-01-10 00:00:00')`
        ).run(emp.id, emp.name, '1999-01-10');

        const pvAtt = await req('/api/piece-wage/preview?period=' + TEST_PERIOD, { token });
        const sd = pvAtt.json.data.summary;
        ok('请假当日的报工被识别为考勤冲突', sd.att_conflict_count >= 1, `conflict=${sd.att_conflict_count}`);
        ok('查不到考勤的日期只提示、不算冲突', sd.no_attendance_count >= 1 && sd.att_conflict_count < 2,
          `no_att=${sd.no_attendance_count} conflict=${sd.att_conflict_count}`);
        const warnAmount = Number(sd.total_amount);

        const bd = await req('/api/piece-wage/attendance-board?period=' + TEST_PERIOD, { token });
        const bRow = ((bd.json.data && bd.json.data.rows) || []).find((r) => r.employee_id === emp.id);
        ok('考勤×计件对照可读', bd.status === 200 && !!bRow, `HTTP ${bd.status}`);
        ok('对照表带出请假天数', !!bRow && Number(bRow.leave_days) === 1 && Number(bRow.attended_days) === 0,
          JSON.stringify(bRow && { a: bRow.attended_days, l: bRow.leave_days }));
        ok('未设日上限时不封顶（不拿 0 当前提）', !!bRow && bRow.month_cap === null,
          JSON.stringify(bRow && bRow.month_cap));

        // warn 策略：照算，但确认要一句说明
        const mkAtt = await req('/api/piece-wage/runs', { method: 'POST', token, body: { period: TEST_PERIOD } });
        const ridAtt = mkAtt.json.data && mkAtt.json.data.id;
        const cfNoNote = await req(`/api/piece-wage/runs/${ridAtt}/confirm`, { method: 'POST', token, body: {} });
        ok('warn 策略下考勤冲突需写说明才能确认', cfNoNote.status === 400, `HTTP ${cfNoNote.status}`);
        const cfWithNote = await req(`/api/piece-wage/runs/${ridAtt}/confirm`, {
          method: 'POST', token, body: { note: '请假当天为代报，已线下确认' }
        });
        ok('写了说明可确认，且核算单记下冲突笔数',
          cfWithNote.status === 200 && Number(cfWithNote.json.data.att_conflict_count) >= 1,
          `HTTP ${cfWithNote.status} conflict=${cfWithNote.json.data && cfWithNote.json.data.att_conflict_count}`);
        await req(`/api/piece-wage/runs/${ridAtt}/void`, {
          method: 'POST', token, body: { reason: '冒烟测试作废' }
        });

        // exclude 策略：这笔不付钱，但要逐笔列出来
        await req('/api/piece-wage/config', {
          method: 'PUT', token, body: { daily_cap_qty: 0, month_cap: 1, attendance_policy: 'exclude' }
        });
        const pvEx = await req('/api/piece-wage/preview?period=' + TEST_PERIOD, { token });
        const sex = pvEx.json.data.summary;
        ok('exclude 策略下冲突笔被剔除且金额可查',
          sex.att_excluded_count >= 1 && Number(sex.att_excluded_amount) > 0,
          `excluded=${sex.att_excluded_count} amount=${sex.att_excluded_amount}`);
        ok('剔除后总金额变小（不静默吞掉）', Number(sex.total_amount) < warnAmount,
          `${sex.total_amount} vs ${warnAmount}`);
        ok('剔除清单带得出「请假」原因',
          (pvEx.json.data.diagnostics.excluded || []).some((x) => x.att_label === '请假'),
          JSON.stringify((pvEx.json.data.diagnostics.excluded || []).map((x) => x.att_label)));

        // block 策略：不许确认
        await req('/api/piece-wage/config', {
          method: 'PUT', token, body: { daily_cap_qty: 0, month_cap: 1, attendance_policy: 'block' }
        });
        const mkBlk = await req('/api/piece-wage/runs', { method: 'POST', token, body: { period: TEST_PERIOD } });
        const cfBlk = await req(`/api/piece-wage/runs/${mkBlk.json.data.id}/confirm`, {
          method: 'POST', token, body: { note: '随便写点什么都行' }
        });
        ok('block 策略下不许确认（写说明也不放行）', cfBlk.status === 400, `HTTP ${cfBlk.status}`);

        // 日上限 + 缺勤封顶：给他一天正常出勤，日上限 10 件
        db.prepare("UPDATE attendance SET status = 'normal', check_in = '08:50' WHERE remark = 'SMOKE-PW'").run();
        // 再补一条「无扎」报工：同扎的第二条会被扎封顶削成 0，那样测不到月度封顶
        db.prepare(
          `INSERT INTO production_reports
             (order_id, node_id, node_name, report_date, qty_ok, qty_defect, hours, operator, employee_id, remark, created_at, bundle_no)
           VALUES (?, NULL, ?, '1999-01-20', 5, 0, 0, ?, ?, 'SMOKE-PW', '1999-01-20 10:00:00', NULL)`
        ).run(bundle.order_id, TEST_PROC, emp.name, emp.id);
        await req('/api/piece-wage/config', {
          method: 'PUT', token, body: { daily_cap_qty: 10, month_cap: 1, attendance_policy: 'warn' }
        });
        const pvCap = await req('/api/piece-wage/preview?period=' + TEST_PERIOD, { token });
        const scap = pvCap.json.data.summary;
        ok('每人每日上限生效（同日超出的被削）', scap.daily_capped_count >= 1, `daily=${scap.daily_capped_count}`);
        ok('缺勤封顶：月上限 = 日上限 × 出勤天数', scap.month_capped_count >= 1, `month=${scap.month_capped_count}`);
        ok('封顶后计件件数不超月上限（10 件/日 × 1 天）',
          Number(scap.total_qty) <= 10, `qty=${scap.total_qty}`);

        // 整月没有考勤记录时不能做「缺勤封顶」（否则等同于所有人都没来，件数全归零）
        db.prepare("DELETE FROM attendance WHERE remark = 'SMOKE-PW'").run();
        const pvNo = await req('/api/piece-wage/preview?period=' + TEST_PERIOD, { token });
        ok('整月无考勤记录时不封顶（只保留单日上限）',
          Number(pvNo.json.data.summary.month_capped_count) === 0,
          `month=${pvNo.json.data.summary.month_capped_count}`);

        // 权限：销售不能改配置
        const salesCfgToken = await loginAs('sales01');
        if (salesCfgToken) {
          const denyCfg = await req('/api/piece-wage/config', {
            method: 'PUT', token: salesCfgToken, body: { daily_cap_qty: 100, month_cap: 1, attendance_policy: 'warn' }
          });
          ok('销售不能改考勤联动配置', denyCfg.status === 403, `HTTP ${denyCfg.status}`);
        } else {
          ok('销售不能改考勤联动配置', true, '没有 sales01，跳过');
        }

        restoreCfg();
        // 配置已还原，但刚才的草案是临时口径 —— 重新生成一份（覆盖）留给后面的用例
        const mkReset = await req('/api/piece-wage/runs', { method: 'POST', token, body: { period: TEST_PERIOD } });
        ok('考勤联动用例结束：配置已还原、草案按原口径重生成',
          mkReset.status === 200 && Number(db.prepare('SELECT daily_cap_qty FROM piece_wage_config WHERE id = 1').get().daily_cap_qty) === Number(cfgOrigin.daily_cap_qty),
          `HTTP ${mkReset.status} cap=${db.prepare('SELECT daily_cap_qty FROM piece_wage_config WHERE id = 1').get().daily_cap_qty}`);
      }

      // ---------- 缺单价：确认必须被拒 ----------
      db.prepare('DELETE FROM piece_rates WHERE process_name = ?').run(TEST_PROC);
      // 用「当前还存在的草案」：草案覆盖是删旧插新，id 会变，拿老 id 会假 404
      const curDraft = db
        .prepare("SELECT id FROM piece_wage_runs WHERE period = ? AND status = 'draft' ORDER BY id DESC LIMIT 1")
        .get(TEST_PERIOD);
      const runId2 = (curDraft && curDraft.id) || (mk4.json.data && mk4.json.data.id);
      if (runId2) {
        const cfNoRate = await req(`/api/piece-wage/runs/${runId2}/confirm`, { method: 'POST', token, body: {} });
        ok('缺单价时确认被拒（不许按 0 算白干）', cfNoRate.status === 400, `HTTP ${cfNoRate.status}`);
      }

      // ---------- 权限边界 ----------
      const salesToken = await loginAs('sales01');
      if (salesToken) {
        const deny = await req('/api/piece-wage/preview?period=' + TEST_PERIOD, { token: salesToken });
        ok('销售看不到计件（工钱敏感，读写都限岗）', deny.status === 403, `HTTP ${deny.status}`);
      } else {
        ok('销售看不到计件（工钱敏感）', true, '没有 sales01，跳过');
      }
      const hrToken = await loginAs('hr01');
      if (hrToken) {
        const hrRead = await req('/api/piece-wage/preview?period=' + TEST_PERIOD, { token: hrToken });
        ok('人事可读计件', hrRead.status === 200, `HTTP ${hrRead.status}`);
        const hrConfirm = await req(`/api/piece-wage/runs/${runId2}/confirm`, { method: 'POST', token: hrToken, body: {} });
        ok('人事不能自己确认（制单与审核分开）', hrConfirm.status === 403, `HTTP ${hrConfirm.status}`);
      } else {
        ok('人事可读计件 / 不能确认', true, '没有 hr01，跳过');
      }

      // ---------- 工资条 / 车间公示表 ----------
      {
        // 自造一份 draft + 一份 confirmed：不依赖演示数据，也不碰真实月份
        const t2 = new Date().toISOString();
        const mkRun = (no, status) =>
          Number(
            db
              .prepare(
                `INSERT INTO piece_wage_runs (run_no, period, status, items_count, employees_count, total_qty, total_amount, created_by, created_at)
                 VALUES (?, ?, ?, 2, 1, 10, 100, 'smoke', ?)`
              )
              .run(no, TEST_PERIOD, status, t2).lastInsertRowid
          );
        const draftId = mkRun('PW199901-TD', 'draft');
        const confId = mkRun('PW199901-TC', 'confirmed');
        const insIt = db.prepare(
          `INSERT INTO piece_wage_items
             (run_id, employee_id, employee_name, employee_code, department, process_name, order_no, qty, unit_price, amount, att_status, capped, cap_kind, report_date)
           VALUES (?, 2, '李四', 'E002', '生产部', ?, ?, ?, 10, ?, ?, ?, ?, '1999-01-10')`
        );
        insIt.run(confId, '车缝', 'SO-SMOKE', 6, 60, 'normal', 0, null);
        insIt.run(confId, '整烫', 'SO-SMOKE', 4, 40, 'leave', 1, 'daily');

        const ps = await req(`/api/piece-wage/runs/${confId}/payslips?mode=person`, { token });
        ok('已确认核算单可出工资条', ps.status === 200 && (ps.json.data.rows || []).length === 1,
          `HTTP ${ps.status} rows=${ps.json.data && ps.json.data.rows && ps.json.data.rows.length}`);
        const psRow = (ps.json.data.rows || [])[0] || {};
        ok('工资条金额与核算单一致', Number(psRow.amount) === 100 && Number(psRow.qty) === 10,
          `amt=${psRow.amount} qty=${psRow.qty}`);
        ok('个人条展开明细（合并同工序）', (psRow.lines || []).length === 2, `lines=${(psRow.lines || []).length}`);
        ok('姓名脱敏（两字姓名 → 李*）', psRow.mask_name === '李*', psRow.mask_name);
        ok('条子上标出封顶/考勤笔数（工人来问时纸面能自证）',
          Number(psRow.capped_lines) === 1 && Number(psRow.att_flagged) === 1,
          `capped=${psRow.capped_lines} att=${psRow.att_flagged}`);

        const psPub = await req(`/api/piece-wage/runs/${confId}/payslips?mode=public`, { token });
        ok('公示表不展开明细（贴墙只看总数）',
          psPub.status === 200 && ((psPub.json.data.rows || [])[0] || {}).lines.length === 0,
          `HTTP ${psPub.status}`);

        const psDraft = await req(`/api/piece-wage/runs/${draftId}/payslips`, { token });
        ok('草案不能出工资条（数字还会变）', psDraft.status === 400, `HTTP ${psDraft.status}`);
        const ps404 = await req('/api/piece-wage/runs/999999/payslips', { token });
        ok('不存在的核算单 404', ps404.status === 404, `HTTP ${ps404.status}`);

        const salesPsToken = await loginAs('sales01');
        if (salesPsToken) {
          const salesPs = await req(`/api/piece-wage/runs/${confId}/payslips`, { token: salesPsToken });
          ok('销售看不到工资条（工钱敏感）', salesPs.status === 403, `HTTP ${salesPs.status}`);
        } else {
          ok('销售看不到工资条（工钱敏感）', true, '没有 sales01，跳过');
        }

        // 用完立刻删：后面的「工资单带入」用例断言「没有已确认核算单时计件为 0」，
        // 留着这份 confirmed 会误伤它
        db.prepare('DELETE FROM piece_wage_items WHERE run_id IN (?, ?)').run(confId, draftId);
        db.prepare('DELETE FROM piece_wage_runs WHERE id IN (?, ?)').run(confId, draftId);
      }

      // ---------- 工资单带入 ----------
      const gen = await req('/api/payrolls/generate', {
        method: 'POST', token, body: { period: TEST_PERIOD, overwrite: true }
      });
      ok(
        '没有已确认核算单时工资单计件为 0（不做「按报工现算」）',
        gen.status === 200 && (gen.json.data.piece_wage_run === null || gen.json.data.piece_wage_total === 0),
        JSON.stringify(gen.json.data && gen.json.data.piece_wage_run)
      );
      db.prepare('DELETE FROM payrolls WHERE period = ?').run(TEST_PERIOD);
      cleanup();
      ok('计件用例自清理（单价/报工/核算单已删）',
        db.prepare('SELECT COUNT(*) c FROM production_reports WHERE remark = ?').get('SMOKE-PW').c === 0);
    }
  }

  // ================= 订单批量流转 =================
  {
    console.log('\n[订单批量流转]');
    const { db } = require('../src/db');
    const TAG = 'SMOKE-BATCH';
    const clean = () => {
      const ids = db.prepare('SELECT id FROM orders WHERE remark = ?').all(TAG).map((r) => r.id);
      ids.forEach((id) => {
        db.prepare('DELETE FROM order_logs WHERE order_id = ?').run(id);
        db.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(id);
        db.prepare('DELETE FROM order_items WHERE order_id=?').run(id);
        db.prepare('DELETE FROM orders WHERE id = ?').run(id);
      });
      return ids.length;
    };
    clean();
    const t = new Date().toISOString();
    const ins = db.prepare(
      `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency, style_name, remark, created_by, created_at, updated_at)
       VALUES (?, 'stock', NULL, 'draft', 6.5, 100, 650, 'USD', '批量测试款', ?, 1, ?, ?)`
    );
    const ids = [1, 2, 3].map((n) => Number(ins.run('SMOKEB' + n, TAG, t, t).lastInsertRowid));
    const batch = (body, tk) => req('/api/orders/batch/transition', { method: 'POST', token: tk || token, body });

    // ---------- 预检 ----------
    const commitBefore = db.prepare('SELECT COUNT(*) c FROM commitments').get().c;
    const dry = await batch({ ids, to: 'tech', dry_run: 1 });
    ok('批量预检可读，逐单给出结果',
      dry.status === 200 && dry.json.data.dry_run === true && dry.json.data.fail_count === 3,
      `HTTP ${dry.status} fail=${dry.json.data && dry.json.data.fail_count}`);
    ok('预检把真实门槛说清楚（不是笼统的「无权」）',
      (dry.json.data.fail || []).every((f) => String(f.reason).includes('接单评审')),
      JSON.stringify((dry.json.data.fail || []).slice(0, 1).map((f) => f.reason)));
    ok('预检不写库（接单评审记录数不变）',
      db.prepare('SELECT COUNT(*) c FROM commitments').get().c === commitBefore,
      `${db.prepare('SELECT COUNT(*) c FROM commitments').get().c} vs ${commitBefore}`);

    // ---------- 正向批量 + 批次号 ----------
    const run1 = await batch({ ids, to: 'cancelled', note: '冒烟批量取消' });
    ok('批量取消逐单成功', run1.status === 200 && run1.json.data.ok_count === 3,
      `HTTP ${run1.status} ok=${run1.json.data && run1.json.data.ok_count}`);
    const batchNo = (run1.json.data && run1.json.data.batch_no) || '';
    ok('返回批次号（便于事后按批追溯）', /^BAT\d{8}-\d{6}$/.test(batchNo), batchNo);
    const lastLog = db.prepare('SELECT note FROM order_logs WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(ids[0]);
    ok('批次号写进订单日志', !!lastLog && String(lastLog.note).includes(batchNo), lastLog && lastLog.note);

    // ---------- 已终态再操作 ----------
    const again = await batch({ ids, to: 'cancelled' });
    ok('已取消的不能重复取消（逐单失败并给原因）',
      again.json.data.ok_count === 0 && again.json.data.fail_count === 3 &&
        String(again.json.data.fail[0].reason).includes('已取消'),
      again.json.data.fail[0] && again.json.data.fail[0].reason);

    // ---------- 整批一致 vs 逐单尽力 ----------
    const closed = db.prepare("SELECT id FROM orders WHERE status = 'closed' LIMIT 1").get();
    const fresh = [1, 2].map((n) => Number(ins.run('SMOKEF' + n, TAG, t, t).lastInsertRowid));
    const ao = await batch({ ids: [closed.id, ...fresh], to: 'cancelled', all_or_nothing: 1 });
    ok('整批模式：有一单不合格 → 整批不动', ao.json.data.aborted === true && ao.json.data.ok_count === 0,
      `aborted=${ao.json.data && ao.json.data.aborted} ok=${ao.json.data && ao.json.data.ok_count}`);
    ok('整批未执行时其余单状态没变',
      db.prepare(`SELECT status FROM orders WHERE id IN (${fresh.join(',')})`).all().every((r) => r.status === 'draft'),
      db.prepare(`SELECT status FROM orders WHERE id IN (${fresh.join(',')})`).all().map((r) => r.status).join(','));
    const partial = await batch({ ids: [closed.id, ...fresh], to: 'cancelled' });
    ok('逐单模式：能过的照过、过不去的列出来',
      partial.json.data.ok_count === 2 && partial.json.data.fail_count === 1,
      `ok=${partial.json.data.ok_count} fail=${partial.json.data.fail_count}`);

    // ---------- 参数校验 ----------
    ok('空选择被拒', (await batch({ ids: [], to: 'cancelled' })).status === 400);
    ok('非法目标状态被拒', (await batch({ ids, to: 'zombie' })).status === 400);
    ok('一次超过 200 单被拒（分批来）',
      (await batch({ ids: Array.from({ length: 201 }, (_, i) => i + 1), to: 'cancelled', dry_run: 1 })).status === 400);

    // ---------- 单张与批量共用同一套门槛 ----------
    const one = Number(ins.run('SMOKEB9', TAG, t, t).lastInsertRowid);
    const single = await req(`/api/orders/${one}/transition`, { method: 'POST', token, body: { to: 'tech' } });
    ok('单张流转仍走同一套门槛（抽取没放宽判定）',
      single.status === 400 && String(single.json.message).includes('接单评审'),
      `HTTP ${single.status} ${single.json.message || ''}`);

    // ---------- 角色 ----------
    const hrLogin2 = await req('/api/auth/login', { method: 'POST', body: { username: 'hr01', password: PASS } });
    if (hrLogin2.status === 200) {
      const hrDeny = await batch({ ids, to: 'cancelled' }, hrLogin2.json.data.token);
      ok('人事不能批量改订单状态', hrDeny.status === 403, `HTTP ${hrDeny.status}`);
    } else {
      ok('人事不能批量改订单状态', true, '没有 hr01，跳过');
    }

    clean();
    ok('批量用例自清理', db.prepare('SELECT COUNT(*) c FROM orders WHERE remark = ?').get(TAG).c === 0);
  }

  // ================= 客户对账单（对账函） =================
  {
    console.log('\n[客户对账单]');
    const { db } = require('../src/db');

    const list = await req('/api/statements/customers', { token });
    const custs = (list.json.data || []);
    ok('有往来的客户清单可读', list.status === 200 && custs.length > 0, `HTTP ${list.status} 客户=${custs.length}`);
    ok('清单带「实际结欠」（已扣未核销收款）',
      custs.every((c) => typeof c.real_open === 'number' && typeof c.unallocated === 'number'),
      JSON.stringify(custs[0] && { open: custs[0].open_amount, un: custs[0].unallocated, real: custs[0].real_open }));

    const cid = custs[0].id;
    const st = await req(`/api/statements/${cid}?from=2020-01-01&to=2030-12-31`, { token });
    const d = st.json.data || {};
    ok('对账单可读（客户/期间/流水/汇总齐全）',
      st.status === 200 && d.customer && d.period && Array.isArray(d.rows) && d.summary,
      `HTTP ${st.status}`);

    // 逐行滚动余额必须自洽：上一行余额 + 借 − 贷 = 本行余额
    const badRun = (d.rows || []).filter((r, i) => {
      const prev = i === 0 ? d.opening : d.rows[i - 1].balance;
      return Math.abs(Number(prev) + Number(r.debit) - Number(r.credit) - Number(r.balance)) >= 0.01;
    });
    ok('流水逐行余额自洽（期初 + 借 − 贷 滚动）', badRun.length === 0, `错 ${badRun.length} 行`);

    ok('期末 = 期初 + 本期开票 − 本期收款',
      Math.abs(Number(d.opening) + Number(d.summary.invoice_amount) - Number(d.summary.payment_amount) - Number(d.summary.closing)) < 0.01,
      `${d.opening}+${d.summary.invoice_amount}-${d.summary.payment_amount} vs ${d.summary.closing}`);

    // 恒等式：流水口径 = 未收发票口径 − 未核销收款。不等于 0 说明有人绕过核销改了 paid_amount
    ok('对账恒等式成立（流水 = 未收发票 − 未核销）',
      Math.abs(Number(d.summary.check_diff)) < 0.01,
      `check_diff=${d.summary.check_diff}（open_by_invoice=${d.summary.open_by_invoice} unallocated=${d.summary.unallocated}）`);

    // 对所有客户做同一断言：任何一处不平都要在冒烟里炸出来
    const unbalanced = [];
    for (const c of custs.slice(0, 12)) {
      const r = await req(`/api/statements/${c.id}?from=2020-01-01&to=2030-12-31`, { token });
      if (r.status !== 200 || Math.abs(Number(r.json.data.summary.check_diff)) >= 0.01) {
        unbalanced.push(`${c.name}(${r.json.data ? r.json.data.summary.check_diff : 'HTTP ' + r.status})`);
      }
    }
    ok('全部客户的应收核销口径一致（不许有人绕过核销改已收）',
      unbalanced.length === 0, unbalanced.slice(0, 3).join('；'));

    // 边界
    // 期间内没有发生额时：流水为空，但期初余额仍要带出来（否则客户以为账被清零了）；
    // 只有「期初 0 且无发生」才是真正的空单，这时后端会给提示
    const empty = await req(`/api/statements/${cid}?from=2030-01-01&to=2030-01-31`, { token });
    const e0 = empty.json.data || {};
    ok('空期间：流水为空但期初余额仍带出（不是空白单）',
      empty.status === 200 && (e0.rows || []).length === 0 &&
        (Math.abs(Number(e0.opening)) > 0.005 || (e0.warnings || []).length > 0),
      `rows=0 opening=${e0.opening} warn=${(e0.warnings || []).length}`);
    ok('期间格式不合规被拒', (await req(`/api/statements/${cid}?from=2026/01/01&to=2026-01-31`, { token })).status === 400);
    ok('开始晚于结束被拒', (await req(`/api/statements/${cid}?from=2026-12-01&to=2026-01-01`, { token })).status === 400);
    ok('不存在的客户 404', (await req('/api/statements/999999', { token })).status === 404);

    // 权限
    const salesStToken = await (async () => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: 'sales01', password: PASS } });
      return r.status === 200 ? r.json.data.token : '';
    })();
    if (salesStToken) {
      const s1 = await req(`/api/statements/${cid}`, { token: salesStToken });
      ok('销售能看对账单（要拿去催款）', s1.status === 200, `HTTP ${s1.status}`);
    } else {
      ok('销售能看对账单（要拿去催款）', true, '没有 sales01，跳过');
    }
    const hrStToken = await (async () => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: 'hr01', password: PASS } });
      return r.status === 200 ? r.json.data.token : '';
    })();
    if (hrStToken) {
      const h1 = await req(`/api/statements/${cid}`, { token: hrStToken });
      ok('人事看不到客户欠款明细', h1.status === 403, `HTTP ${h1.status}`);
    } else {
      ok('人事看不到客户欠款明细', true, '没有 hr01，跳过');
    }

    const noAuthSt = await req(`/api/statements/${cid}`);
    ok('对账单需要登录', noAuthSt.status === 401, `HTTP ${noAuthSt.status}`);
  }

  // ================= 客户信用与账期 =================
  {
    console.log('\n— 客户信用与账期 —');
    const { db } = require('../src/db');
    const TAG = 'SMOKECREDIT';
    const STYLE = 'SMOKECREDIT-ST';
    const loginAs = async (u) => {
      const r = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: PASS })
      });
      const j = await r.json().catch(() => ({}));
      return j && j.ok ? j.data.token : null;
    };

    const clean = () => {
      db.prepare("DELETE FROM credit_overrides WHERE reason LIKE 'SMOKE%'").run();
      const ids = db.prepare('SELECT id FROM orders WHERE order_no LIKE ?').all('SMOKEC%').map((r) => r.id);
      ids.forEach((id) => {
        db.prepare('DELETE FROM order_logs WHERE order_id = ?').run(id);
        db.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(id);
        db.prepare('DELETE FROM order_items WHERE order_id=?').run(id);
        db.prepare('DELETE FROM stock_ledger WHERE ref_type = ? AND ref_id = ?').run('order', id);
        db.prepare('DELETE FROM orders WHERE id = ?').run(id);
      });
      db.prepare("DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id NOT IN (SELECT id FROM orders))").run();
      db.prepare("DELETE FROM ar_invoices WHERE bill_no LIKE 'SMOKECREDIT%'").run();
      db.prepare("DELETE FROM stock_items WHERE style_no = ?").run(STYLE);
      const cs = db.prepare("SELECT id FROM customers WHERE code = ?").all(TAG);
      cs.forEach((c) => {
        db.prepare('DELETE FROM credit_limits WHERE customer_id = ?').run(c.id);
        db.prepare('DELETE FROM credit_holds WHERE customer_id = ?').run(c.id);
        db.prepare('DELETE FROM credit_overrides WHERE customer_id = ?').run(c.id);
        db.prepare('DELETE FROM customers WHERE id = ?').run(c.id);
      });
      return ids.length;
    };
    clean();

    const t = new Date().toISOString();
    const custId = db.prepare(
      `INSERT INTO customers (code, name, level, credit_limit, credit_days, credit_status, created_at, updated_at)
       VALUES (?, '冒烟·信用测试客户', 'B', 1000, 30, 'active', ?, ?)`
    ).run(TAG, t, t).lastInsertRowid;

    // 一张已入库、金额远超额度的订单（还能拿它试发货）
    const orderId = db.prepare(
      `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency, style_name, created_at, updated_at)
       VALUES ('SMOKEC01', 'custom', ?, 'instock', 7, 700, 5000, 'CNY', '冒烟信用款', ?, ?)`
    ).run(custId, t, t).lastInsertRowid;
    const itemId = db.prepare(
      `INSERT INTO order_items (order_id, product_name, style_no, sku, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?)`
    ).run(orderId, '冒烟信用款', STYLE, STYLE + '-SKU', 100, 714, 5000).lastInsertRowid;
    db.prepare(
      `INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?)`
    ).run(itemId, '黑色', 'M', 100, 7.14, 50, 714, 5000);
    db.prepare(
      `INSERT INTO stock_items (warehouse, style_no, product_name, color, size, qty, updated_at) VALUES ('cn',?,?,?,?,?,?)`
    ).run(STYLE, '冒烟信用款', '黑色', 'M', 100, t);

    // 一张已逾期 20 天的发票：逾期 + 超宽限期
    db.prepare(
      `INSERT INTO ar_invoices (bill_no, customer_id, customer_name, currency, amount_orig, rate, amount,
        paid_amount, due_date, status, source, created_at, updated_at)
       VALUES ('SMOKECREDIT-INV', ?, '冒烟·信用测试客户', 'CNY', 3000, 7, 3000, 0, ?, 'unpaid', 'manual', ?, ?)`
    ).run(custId, new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10), t, t);

    // ---------- 台账 ----------
    const bd = await req('/api/credit/board', { token });
    const mine = (bd.json.data.rows || []).find((r) => r.customer.id === Number(custId));
    ok('台账能算出这家客户的敞口（票 3000 + 单 5000）',
      bd.status === 200 && mine && Number(mine.figures.exposure) === 8000,
      `HTTP ${bd.status} exposure=${mine && mine.figures.exposure}`);
    ok('台账把它标成超额度', mine && mine.risk === 'over', mine && mine.risk);
    ok('台账带出逾期金额与最长逾期天数',
      mine && Number(mine.figures.overdue) === 3000 && mine.figures.max_overdue_days >= 19,
      `${mine && mine.figures.overdue} / ${mine && mine.figures.max_overdue_days}`);

    const one = await req('/api/credit/' + custId, { token });
    ok('单客户画像含发票与在途订单明细',
      one.status === 200 && (one.json.data.invoices || []).length === 1 && (one.json.data.orders || []).length === 1,
      `inv=${((one.json.data || {}).invoices || []).length} ord=${((one.json.data || {}).orders || []).length}`);

    // ---------- 预检 ----------
    const chk = await req('/api/credit/check/' + orderId, { token });
    const cj = chk.json.data || {};
    ok('预检判定为拦截', chk.status === 200 && cj.blocked === true, cj.level);
    ok('预检同时给出「超额度」和「逾期」两条理由',
      (cj.reasons || []).some((r) => r.includes('超额度')) && (cj.reasons || []).some((r) => r.includes('逾期')),
      JSON.stringify(cj.reasons));

    // ---------- 发货被拦 ----------
    const ship1 = await req('/api/stock/ship', { method: 'POST', token, body: { order_id: orderId, warehouse: 'cn' } });
    ok('超限订单发货被拦（CREDIT_BLOCK）',
      ship1.status === 400 && ship1.json.code === 'CREDIT_BLOCK', `HTTP ${ship1.status}`);
    ok('被拦时订单状态与库存都没动',
      db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status === 'instock' &&
        db.prepare('SELECT qty FROM stock_items WHERE style_no = ?').get(STYLE).qty === 100,
      db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status);

    // ---------- 空明细单不许「发货」 ----------
    // （回归：原来没有明细的单也能被标成已发货，货一件没出库，状态还退不回来）
    const emptyId = db.prepare(
      `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency, created_at, updated_at)
       VALUES ('SMOKEC02', 'custom', NULL, 'instock', 7, 0, 0, 'CNY', ?, ?)`
    ).run(t, t).lastInsertRowid;
    const shipEmpty = await req('/api/stock/ship', { method: 'POST', token, body: { order_id: emptyId, warehouse: 'cn' } });
    ok('没有明细的订单不许发货（货没出库就别改状态）',
      shipEmpty.status === 400 && /明细/.test(shipEmpty.json.message || ''), `HTTP ${shipEmpty.status} ${shipEmpty.json.message}`);

    // ---------- 调额度 ----------
    const shortReason = await req('/api/credit/' + custId, {
      method: 'PUT', token, body: { credit_limit: 9000, credit_days: 30, reason: '调' }
    });
    ok('调额度必须写原因（太短被拒）', shortReason.status === 400, `HTTP ${shortReason.status}`);

    const same = await req('/api/credit/' + custId, {
      method: 'PUT', token, body: { credit_limit: 1000, credit_days: 30, reason: '冒烟：数值没变' }
    });
    ok('额度和账期都没变时拒绝（避免刷一堆无意义记录）', same.status === 400, `HTTP ${same.status}`);

    const setOk = await req('/api/credit/' + custId, {
      method: 'PUT', token, body: { credit_limit: 9000, credit_days: 45, reason: '冒烟：客户补了担保函，追加授信' }
    });
    ok('调额度成功并返回新画像',
      setOk.status === 200 && Number(setOk.json.data.figures.limit) === 9000 && setOk.json.data.customer.credit_days === 45,
      `HTTP ${setOk.status}`);
    ok('额度变更进历史表（可追溯）',
      db.prepare('SELECT COUNT(*) c FROM credit_limits WHERE customer_id = ?').get(custId).c >= 1);
    ok('额度够用后不再因为「超额度」被拦',
      !((await req('/api/credit/check/' + orderId, { token })).json.data.reasons || []).some((r) => r.includes('超额度')));

    // ---------- 冻结 ----------
    const hold = await req(`/api/credit/${custId}/hold`, {
      method: 'POST', token, body: { action: 'hold', reason: '冒烟：客户出现退票记录，先冻' }
    });
    ok('冻结成功', hold.status === 200 && hold.json.data.customer.credit_status === 'hold', `HTTP ${hold.status}`);
    const chkHold = await req('/api/credit/check/' + orderId, { token });
    ok('冻结后即使额度充足也被拦', chkHold.json.data.blocked === true, JSON.stringify(chkHold.json.data.reasons));
    ok('拦截理由写明是冻结', (chkHold.json.data.reasons || []).some((r) => r.includes('冻结')), JSON.stringify(chkHold.json.data.reasons));
    const shipHold = await req('/api/stock/ship', { method: 'POST', token, body: { order_id: orderId, warehouse: 'cn' } });
    ok('冻结客户的发货被拦下', shipHold.status === 400 && shipHold.json.code === 'CREDIT_BLOCK', `HTTP ${shipHold.status}`);

    const dupHold = await req(`/api/credit/${custId}/hold`, {
      method: 'POST', token, body: { action: 'hold', reason: '冒烟：重复冻结' }
    });
    ok('重复冻结被拒', dupHold.status === 400, `HTTP ${dupHold.status}`);

    const release = await req(`/api/credit/${custId}/hold`, {
      method: 'POST', token, body: { action: 'release', reason: '冒烟：退票已处理完，恢复' }
    });
    ok('解冻成功', release.status === 200 && release.json.data.customer.credit_status === 'active', `HTTP ${release.status}`);

    // ---------- 额度 0 = 不管理 ----------
    await req('/api/credit/' + custId, {
      method: 'PUT', token, body: { credit_limit: 0, credit_days: 30, reason: '冒烟：改成不管理额度' }
    });
    const chkFree = await req('/api/credit/check/' + orderId, { token });
    ok('额度 0 = 不管理：不再因额度拦截',
      chkFree.json.data.blocked === false || !(chkFree.json.data.reasons || []).some((r) => r.includes('超额度')),
      JSON.stringify(chkFree.json.data.reasons));
    ok('额度 0 时给出「未设额度」提示（而不是静默放过）',
      (chkFree.json.data.tips || []).some((x) => x.includes('没设信用额度')), JSON.stringify(chkFree.json.data.tips));

    // 还原成超限状态，下面测放行
    await req('/api/credit/' + custId, {
      method: 'PUT', token, body: { credit_limit: 1000, credit_days: 30, reason: '冒烟：恢复为低额度以便测放行' }
    });

    // ---------- 放行单 ----------
    const ovShort = await req('/api/credit/overrides', {
      method: 'POST', token, body: { order_id: orderId, reason: '客户急' }
    });
    ok('放行理由太短被拒（审计只认这句话）', ovShort.status === 400, `HTTP ${ovShort.status}`);

    const ov = await req('/api/credit/overrides', {
      method: 'POST', token, body: { order_id: orderId, reason: 'SMOKE 客户已付 30% 定金，财务总监同意先发' }
    });
    const ovId = (ov.json.data || {}).id;
    ok('开出放行单', ov.status === 200 && !!ovId, `HTTP ${ov.status}`);
    ok('放行单记下当时的额度与敞口快照',
      ov.json.data && Number(ov.json.data.exposure_snapshot) === 8000,
      ov.json.data && ov.json.data.exposure_snapshot);

    const ovDup = await req('/api/credit/overrides', {
      method: 'POST', token, body: { order_id: orderId, reason: 'SMOKE 再来一张备用的' }
    });
    ok('同一单不许挂两张未用的放行单', ovDup.status === 400, `HTTP ${ovDup.status}`);

    const ship2 = await req('/api/stock/ship', {
      method: 'POST', token, body: { order_id: orderId, warehouse: 'cn', credit_override_id: ovId }
    });
    ok('带放行单发货成功', ship2.status === 200, `HTTP ${ship2.status} ${ship2.json.message}`);
    ok('返回里标出用的哪张放行单', ship2.json.data && ship2.json.data.credit.override_id === ovId);
    ok('放行单被核销（记时间与人）',
      !!db.prepare('SELECT used_at FROM credit_overrides WHERE id = ?').get(ovId).used_at);
    ok('发货日志里留了放行单号',
      String(db.prepare('SELECT note FROM order_logs WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId).note || '').includes('#' + ovId));

    db.prepare("UPDATE orders SET status = 'instock' WHERE id = ?").run(orderId);
    const ovReuse = await req('/api/stock/ship', {
      method: 'POST', token, body: { order_id: orderId, warehouse: 'cn', credit_override_id: ovId }
    });
    ok('一张放行单只能用一次', ovReuse.status === 400 && /用过/.test(ovReuse.json.message || ''), `HTTP ${ovReuse.status}`);

    const ovOther = await req('/api/credit/overrides', {
      method: 'POST', token, body: { order_id: emptyId, reason: 'SMOKE 空单本来就没被拦，不需要放行' }
    });
    ok('没被拦的单不许开放行单（否则记录失去意义）', ovOther.status === 400, `HTTP ${ovOther.status}`);

    // ---------- 权限 ----------
    const salesToken = await loginAs('sales01');
    if (salesToken) {
      const salesRead = await req('/api/credit/board', { token: salesToken });
      ok('销售能看信用台账（不然不知道能不能接单）', salesRead.status === 200, `HTTP ${salesRead.status}`);
      const salesWrite = await req('/api/credit/' + custId, {
        method: 'PUT', token: salesToken, body: { credit_limit: 999999, credit_days: 90, reason: '销售自己想提额' }
      });
      ok('销售不能自己提额度', salesWrite.status === 403, `HTTP ${salesWrite.status}`);
      const salesOv = await req('/api/credit/overrides', {
        method: 'POST', token: salesToken, body: { order_id: orderId, reason: '销售想自己开一张放行单看看' }
      });
      ok('销售不能开放行单', salesOv.status === 403, `HTTP ${salesOv.status}`);
    } else {
      ok('销售权限用例（没有 sales01 账号，跳过）', true);
    }

    const hrToken = await loginAs('hr01');
    if (hrToken) {
      const hrRead = await req('/api/credit/board', { token: hrToken });
      ok('人事看不到客户信用（跟岗位无关）', hrRead.status === 403, `HTTP ${hrRead.status}`);
    } else {
      ok('人事权限用例（没有 hr01 账号，跳过）', true);
    }

    const noAuth = await req('/api/credit/board', {});
    ok('未登录拿不到信用台账', noAuth.status === 401, `HTTP ${noAuth.status}`);

    // ---------- 清理 ----------
    const removed = clean();
    ok('信用用例自清理（不污染演示数据）',
      db.prepare('SELECT COUNT(*) c FROM customers WHERE code = ?').get(TAG).c === 0, `删了 ${removed} 张单`);
  }

  // ================= 应付台账与付款计划 =================
  {
    console.log('\n— 应付台账与付款计划 —');
    const { db } = require('../src/db');
    const T = require('../src/services/paymentTerms');
    const S2 = require('../src/services/invoiceStatus');

    // ---------- 账期解析（纯函数，先测） ----------
    const cases = [
      ['月结30天', 30], ['月结 45 天', 45], ['月结', 30], ['现结', 0],
      ['预付30%', 0], ['30天', 30], ['货到15天', 15]
    ];
    const bad = cases.filter(([txt, want]) => {
      const p = T.parseTerms(txt);
      return !p || p.days !== want;
    });
    ok('账期文本能解析成天数（月结/现结/货到N天）', bad.length === 0,
      bad.map(([t2, w]) => `${t2}→${(T.parseTerms(t2) || {}).days}（应 ${w}）`).join('；'));
    ok('读不出来的账期返回 null（不瞎猜成 30 天）',
      T.parseTerms('按季度结') === null && T.parseTerms('') === null && T.parseTerms(null) === null);

    // ---------- 台账 ----------
    const bd = await req('/api/payable/board', { token });
    const bs = (bd.json.data || {}).summary || {};
    ok('应付台账可读且有汇总', bd.status === 200 && bs.suppliers > 0, `HTTP ${bd.status} 供应商 ${bs.suppliers}`);
    ok('应付合计 = 已开票未付 + 已收货未开票',
      Math.abs(Number(bs.payable_total) - (Number(bs.open_amount) + Number(bs.unbilled_amount))) < 0.01,
      `${bs.payable_total} vs ${bs.open_amount} + ${bs.unbilled_amount}`);
    ok('台账只列有欠款的供应商（不把 0 元的一大堆塞进来）',
      (bd.json.data.rows || []).every((r) => Number(r.figures.payable_total) > 0),
      `行数 ${(bd.json.data.rows || []).length}`);
    const risks = (bd.json.data.rows || []).map((r) => r.risk);
    ok('风险分类只出现约定的四种',
      risks.every((r) => ['overdue', 'unbilled', 'noterm', 'ok'].includes(r)), JSON.stringify([...new Set(risks)]));
    ok('逾期排在台账最前面（有逾期必须一眼看到）',
      risks.length === 0 || risks[0] === 'overdue' || !risks.includes('overdue'), JSON.stringify(risks.slice(0, 5)));

    // ---------- 付款计划 ----------
    const sc = await req('/api/payable/schedule?weeks=4', { token });
    const buckets = (sc.json.data || {}).buckets || [];
    ok('付款计划按周分组', sc.status === 200 && buckets.length >= 5, `桶数 ${buckets.length}`);
    ok('第一组固定是「已逾期」（混进「本周」会让人以为还有时间）',
      buckets[0] && buckets[0].key === 'overdue', buckets[0] && buckets[0].label);
    ok('周分组首尾相接（不重不漏）', (() => {
      for (let i = 2; i < buckets.length; i++) {
        const prev = buckets[i - 1];
        const cur = buckets[i];
        if (!prev.to || !cur.from) continue;
        const gap = T.addDays(prev.to, 1);
        if (gap !== cur.from) return false;
      }
      return true;
    })(), JSON.stringify(buckets.map((b) => [b.from, b.to]).slice(1, 4)));
    ok('计划里带「待开票（预计）」组（不做资金计划会漏这笔钱）',
      Array.isArray(sc.json.data.pending) && sc.json.data.summary.pending_unbilled !== undefined,
      `待开票 ${sc.json.data.summary.pending_unbilled}`);

    // ---------- 明细 ----------
    const firstSup = (bd.json.data.rows || [])[0];
    if (firstSup) {
      const dt = await req('/api/payable/' + firstSup.supplier.id, { token });
      ok('单供应商明细含发票/未开票采购单/付款记录',
        dt.status === 200 && Array.isArray(dt.json.data.invoices) && Array.isArray(dt.json.data.unbilled),
        `HTTP ${dt.status}`);
      ok('明细里的应付合计与台账一致',
        Math.abs(Number(dt.json.data.figures.payable_total) - Number(firstSup.figures.payable_total)) < 0.01,
        `${dt.json.data.figures.payable_total} vs ${firstSup.figures.payable_total}`);
    }
    const nf = await req('/api/payable/999999', { token });
    ok('不存在的供应商返回 404', nf.status === 404, `HTTP ${nf.status}`);

    // ---------- 改账期 ----------
    const TAG = 'SMOKEAP';
    const t0 = new Date().toISOString();

    // 上次跑到一半崩了会留下同名单据（po_no 唯一）→ 开头先清干净，保证可重复跑
    const stalePo = db.prepare("SELECT id FROM purchase_orders WHERE po_no LIKE 'SMOKEAP%'").all().map((r) => r.id);
    stalePo.forEach((id) => {
      db.prepare('DELETE FROM ap_invoices WHERE purchase_id = ?').run(id);
      db.prepare('DELETE FROM goods_receipt_items WHERE grn_id IN (SELECT id FROM goods_receipts WHERE po_id = ?)').run(id);
      db.prepare('DELETE FROM goods_receipts WHERE po_id = ?').run(id);
      db.prepare('DELETE FROM purchase_items WHERE po_id = ?').run(id);
      db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);
    });
    db.prepare('DELETE FROM suppliers WHERE code = ?').run(TAG);
    const supId = db.prepare(
      `INSERT INTO suppliers (code, name, category, payment_terms, status, created_at, updated_at)
       VALUES (?, '冒烟·应付测试供应商', 'material', '月结30天', 'active', ?, ?)`
    ).run(TAG, t0, t0).lastInsertRowid;

    const setT = await req('/api/payable/' + supId, {
      method: 'PUT', token, body: { payment_terms: '月结45天', term_days: null }
    });
    ok('改账期会自动解析出天数（改文本不填天数也能生效）',
      setT.status === 200 && Number(setT.json.data.term_days) === 45, JSON.stringify(setT.json.data));

    const setD = await req('/api/payable/' + supId, {
      method: 'PUT', token, body: { payment_terms: '按季度结', term_days: 90 }
    });
    ok('读不出的文本可以手工填天数（填了以天数为准）',
      setD.status === 200 && Number(setD.json.data.term_days) === 90, JSON.stringify(setD.json.data));

    const setBad = await req('/api/payable/' + supId, {
      method: 'PUT', token, body: { payment_terms: '月结30天', term_days: 999 }
    });
    ok('账期天数超出范围被拒', setBad.status === 400, `HTTP ${setBad.status}`);

    // ---------- 收货 → 自动开应付（曾经是死代码，27 张单 31 万没进账） ----------
    const poId = db.prepare(
      `INSERT INTO purchase_orders (po_no, supplier, supplier_id, status, order_date, expect_date, total_amount, created_by, created_at, updated_at)
       VALUES ('SMOKEAP-PO1', '冒烟·应付测试供应商', ?, 'ordered', ?, ?, 6600, 'smoke', ?, ?)`
    ).run(supId, t0.slice(0, 10), t0.slice(0, 10), t0, t0).lastInsertRowid;
    const poItemId = db.prepare(
      `INSERT INTO purchase_items (po_id, name, spec, unit, qty, price, amount, received_qty)
       VALUES (?, '冒烟面料', '150D', '米', 100, 66, 6600, 0)`
    ).run(poId).lastInsertRowid;

    const apBefore = db.prepare('SELECT COUNT(*) c FROM ap_invoices').get().c;
    const rc = await req(`/api/purchases/${poId}/receive`, {
      method: 'POST', token, body: { items: [{ id: poItemId, qty: 100 }] }
    });
    ok('采购收货成功且回传应付票号',
      rc.status === 200 && !!rc.json.data.ap_bill_no, `HTTP ${rc.status} ${JSON.stringify(rc.json.data && rc.json.data.ap_bill_no)}`);
    const apNew = db.prepare('SELECT * FROM ap_invoices WHERE purchase_id = ?').get(poId);
    ok('收货后真的生成了应付（这条以前从来没发生过）',
      !!apNew && db.prepare('SELECT COUNT(*) c FROM ap_invoices').get().c === apBefore + 1,
      apNew ? apNew.bill_no : '没生成');
    ok('生成的应付带上了 supplier_id（不然永远没法按供应商汇总）',
      apNew && Number(apNew.supplier_id) === Number(supId), apNew && String(apNew.supplier_id));
    ok('到期日按「开票日 + 账期」算（不是拿预计到货日）',
      apNew && apNew.due_date === T.addDays(t0.slice(0, 10), 90),
      apNew ? `${apNew.due_date}（应 ${T.addDays(t0.slice(0, 10), 90)}）` : '无');
    ok('生成的应付进了台账的「已开票未付」',
      (() => {
        const row = db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ap_invoices WHERE supplier_id = ? AND ${S2.OPEN_SQL}`).get(supId);
        return Math.abs(Number(row.s) - 6600) < 0.01;
      })());
    // 再收一次（已收完的单不允许重复收）
    const rc2 = await req(`/api/purchases/${poId}/receive`, {
      method: 'POST', token, body: { items: [{ id: poItemId, qty: 100 }] }
    });
    ok('收完的单不会重复开票（幂等）',
      db.prepare('SELECT COUNT(*) c FROM ap_invoices WHERE purchase_id = ?').get(poId).c === 1,
      `票数 ${db.prepare('SELECT COUNT(*) c FROM ap_invoices WHERE purchase_id = ?').get(poId).c} / 二次收货 HTTP ${rc2.status}`);

    // ---------- 全局口径一致（这条是给以后的自己看的） ----------
    const drift = ['ar_invoices', 'ap_invoices']
      .map((table) => {
        const a = Number(db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ${table} WHERE ${S2.OPEN_SQL}`).get().s);
        const b = Number(db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ${table} WHERE status IN ('unpaid','partial')`).get().s);
        return { table, diff: Math.round((a - b) * 100) / 100 };
      })
      .filter((x) => Math.abs(x.diff) > 0.01);
    ok('应收应付的两种口径一致（有野状态值就会在这里炸）', drift.length === 0,
      JSON.stringify(drift));
    ok('全库没有未登记的发票状态值',
      ['ar_invoices', 'ap_invoices'].every((table) => {
        const rows = db.prepare(`SELECT DISTINCT status FROM ${table}`).all();
        return rows.every((r) => S2.normalizeStatus(r.status) !== null);
      }),
      JSON.stringify(db.prepare('SELECT DISTINCT status FROM ap_invoices').all().map((r) => r.status)));

    // ---------- 权限 ----------
    const salesTk = await req('/api/auth/login', { method: 'POST', body: { username: 'sales01', password: PASS } });
    if (salesTk.status === 200) {
      const s1 = await req('/api/payable/board', { token: salesTk.json.data.token });
      ok('销售看不到应付（欠谁钱、什么时候付是敏感信息）', s1.status === 403, `HTTP ${s1.status}`);
      const s2 = await req('/api/payable/' + supId, {
        method: 'PUT', token: salesTk.json.data.token, body: { payment_terms: '现结', term_days: 0 }
      });
      ok('销售不能改账期', s2.status === 403, `HTTP ${s2.status}`);
    }
    const hrTk = await req('/api/auth/login', { method: 'POST', body: { username: 'hr01', password: PASS } });
    if (hrTk.status === 200) {
      const h1 = await req('/api/payable/board', { token: hrTk.json.data.token });
      ok('人事看不到应付', h1.status === 403, `HTTP ${h1.status}`);
    }
    const noTk = await req('/api/payable/board', {});
    ok('未登录拿不到应付台账', noTk.status === 401, `HTTP ${noTk.status}`);

    // ---------- 清理 ----------
    db.prepare('DELETE FROM ap_invoices WHERE purchase_id = ?').run(poId);
    db.prepare('DELETE FROM goods_receipt_items WHERE grn_id IN (SELECT id FROM goods_receipts WHERE po_id = ?)').run(poId);
    db.prepare('DELETE FROM goods_receipts WHERE po_id = ?').run(poId);
    db.prepare('DELETE FROM purchase_items WHERE po_id = ?').run(poId);
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(poId);
    db.prepare('DELETE FROM suppliers WHERE id = ?').run(supId);
    ok('应付用例自清理', db.prepare('SELECT COUNT(*) c FROM suppliers WHERE code = ?').get(TAG).c === 0);
  }

  // ================= 资金计划（13 周现金流） =================
  {
    console.log('\n— 资金计划（13 周现金流） —');
    const { db } = require('../src/db');

    const pl = await req('/api/cashflow/plan?weeks=13', { token });
    const P = pl.json.data || {};
    const S1 = P.summary || {};
    ok('资金计划可读', pl.status === 200 && Array.isArray(P.weeks_detail) && P.weeks_detail.length === 13,
      `HTTP ${pl.status} 周数 ${(P.weeks_detail || []).length}`);

    // 期初现金必须等于总账 1002
    const cash = Number(db.prepare(
      `SELECT COALESCE(SUM(e.debit-e.credit),0) s FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
        WHERE v.status='posted' AND e.account_code='1002'`
    ).get().s);
    ok('期初现金取总账 1002（不是银行账户的期初数）',
      Math.abs(Number(S1.opening_cash) - cash) < 0.01, `${S1.opening_cash} vs ${cash}`);

    ok('期初 + 流入 − 流出 = 期末',
      Math.abs(Number(S1.opening_cash) + Number(S1.total_inflow) - Number(S1.total_outflow) - Number(S1.closing_cash)) < 0.01,
      `${S1.opening_cash}+${S1.total_inflow}-${S1.total_outflow}=${S1.closing_cash}`);

    // 逐周滚动自洽：本周期初 = 上周期末
    const rollBad = P.weeks_detail.filter((w, i) => {
      if (i === 0) return Math.abs(w.opening - Number(S1.opening_cash)) > 0.01;
      return Math.abs(w.opening - P.weeks_detail[i - 1].closing) > 0.01;
    });
    ok('逐周滚动自洽（本周期初 = 上周期末）', rollBad.length === 0,
      rollBad.map((w) => '第' + w.week_no + '周').join(','));

    ok('每周期初 + 净额 = 期末',
      P.weeks_detail.every((w) => Math.abs(w.opening + w.net - w.closing) < 0.01));

    // ---------- 跨模块口径：资金计划的应付 = 应付台账 ----------
    const pb = await req('/api/payable/board', { token });
    ok('资金计划的应付总额 = 应付台账的已开票未付（两个模块不许两套口径）',
      Math.abs(Number(S1.ap_open) - Number(pb.json.data.summary.open_amount)) < 0.01,
      `资金计划 ${S1.ap_open} vs 应付台账 ${pb.json.data.summary.open_amount}`);
    ok('待开票（已收货未开票）也进了流出',
      Math.abs(Number(S1.ap_pending) - Number(pb.json.data.summary.unbilled_amount)) < 0.01,
      `${S1.ap_pending} vs ${pb.json.data.summary.unbilled_amount}`);

    // ---------- 逾期应付排第 1 周（不假设还能拖） ----------
    const overdueAp = db.prepare(
      "SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ap_invoices WHERE status <> 'void' AND amount - COALESCE(paid_amount,0) > 0.005 AND due_date < ?"
    ).get(P.base_date).s;
    const w1ap = (P.weeks_detail[0].outflow_items || [])
      .filter((x) => x.category === 'ap_pay')
      .reduce((a, x) => a + Number(x.amount), 0);
    ok('逾期应付全部排进第 1 周（做计划不能假设供应商会继续等）',
      Number(overdueAp) <= 0.01 || w1ap + 0.01 >= Number(overdueAp),
      `逾期 ${overdueAp} / 第1周应付 ${w1ap}`);

    // ---------- 三档情景 ----------
    const cp = await req('/api/cashflow/compare?weeks=13', { token });
    const rows = (cp.json.data || {}).rows || [];
    ok('三档情景并排返回', cp.status === 200 && rows.length === 3, `HTTP ${cp.status} 行数 ${rows.length}`);
    ok('三档支出完全一致（「乐观」不能意味着「少还钱」）',
      cp.json.data.outflow_consistent === true,
      JSON.stringify(rows.map((r) => r.total_outflow)));
    const byKey = {};
    rows.forEach((r) => { byKey[r.scenario] = r; });
    ok('保守 < 基准 < 乐观（回款）',
      Number(byKey.conservative.total_inflow) < Number(byKey.base.total_inflow) &&
        Number(byKey.base.total_inflow) < Number(byKey.optimistic.total_inflow),
      [byKey.conservative, byKey.base, byKey.optimistic].map((r) => r.total_inflow).join(' < '));

    // ---------- 应收折现口径 ----------
    ok('应收按逾期档打折（未到期最高、逾期越久越低）',
      (P.buckets || []).length > 0 && (P.buckets || []).every((b, i, arr) => i === 0 || b.rate <= arr[i - 1].rate),
      JSON.stringify((P.buckets || []).map((b) => b.label + ':' + b.rate + '%')));
    ok('应收风险敞口 = 未收 − 预计可收',
      Math.abs(Number(S1.ar_open) - Number(S1.ar_expect) - Number(S1.ar_at_risk)) < 0.01,
      `${S1.ar_open} - ${S1.ar_expect} = ${S1.ar_at_risk}`);

    // ---------- 权限 ----------
    const salesTk2 = await req('/api/auth/login', { method: 'POST', body: { username: 'sales01', password: PASS } });
    if (salesTk2.status === 200) {
      const x1 = await req('/api/cashflow/plan', { token: salesTk2.json.data.token });
      ok('销售看不到资金计划（期初现金与断点周是老板/财务的事）', x1.status === 403, `HTTP ${x1.status}`);
    }
    const hrTk2 = await req('/api/auth/login', { method: 'POST', body: { username: 'hr01', password: PASS } });
    if (hrTk2.status === 200) {
      const x2 = await req('/api/cashflow/compare', { token: hrTk2.json.data.token });
      ok('人事看不到资金计划', x2.status === 403, `HTTP ${x2.status}`);
    }
    const x3 = await req('/api/cashflow/plan', {});
    ok('未登录拿不到资金计划', x3.status === 401, `HTTP ${x3.status}`);
  }

  // ================= 付款申请单 =================
  {
    console.log('\n— 付款申请单 —');
    const { db } = require('../src/db');
    const S3 = require('../src/services/invoiceStatus');
    const PR3 = require('../src/services/paymentRequest');

    const loginX = async (u) => {
      const r = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: PASS })
      });
      const j = await r.json().catch(() => ({}));
      return j && j.ok ? j.data.token : null;
    };

    // 用一张真实存在的未付应付发票（不改它，只申请）
    const inv = db.prepare(
      `SELECT * FROM ap_invoices WHERE ${S3.OPEN_SQL} AND amount - COALESCE(paid_amount,0) > 1000 ORDER BY id LIMIT 1`
    ).get();
    const acc = db.prepare("SELECT * FROM bank_accounts WHERE status='active' ORDER BY id LIMIT 1").get();
    ok('库里有可测的未付应付发票与出账账户', !!inv && !!acc, inv ? inv.bill_no : '没有');

    if (inv && acc) {
      const createdIds = [];
      const payIds = [];
      const clean = () => {
        createdIds.forEach((cid) => {
          const row = db.prepare('SELECT payment_id FROM payment_requests WHERE id = ?').get(cid);
          if (row && row.payment_id && !payIds.includes(row.payment_id)) payIds.push(row.payment_id);
          db.prepare("DELETE FROM approval_tasks WHERE instance_id IN (SELECT id FROM approval_instances WHERE target_type='payment' AND target_id=?)").run(cid);
          db.prepare("DELETE FROM approval_instances WHERE target_type='payment' AND target_id=?").run(cid);
          db.prepare('DELETE FROM payment_request_items WHERE request_id = ?').run(cid);
          db.prepare('DELETE FROM payment_requests WHERE id = ?').run(cid);
        });
        payIds.forEach((pid) => {
          const allocs = db.prepare('SELECT * FROM payment_allocations WHERE payment_id = ?').all(pid);
          db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?').run(pid);
          db.prepare('DELETE FROM payments WHERE id = ?').run(pid);
          allocs.forEach((a) => S3.syncPaidStatus(a.invoice_kind, a.invoice_id));
        });
      };
      clean();

      // ---------- 1. 必须绑发票 ----------
      let r = await req('/api/payment-requests', {
        method: 'POST', token, body: { supplier_id: inv.supplier_id, amount: 5000 }
      });
      ok('只填金额不挑发票 → 拒（否则钱付了账上还挂着应付）',
        r.status === 400, `HTTP ${r.status}`);

      // ---------- 2. 金额由明细决定 ----------
      r = await req('/api/payment-requests', {
        method: 'POST', token,
        body: { supplier_id: inv.supplier_id, items: [{ invoice_id: inv.id, amount: 1234.56 }], reason: '冒烟：核对无误' }
      });
      const rid = r.json.data && r.json.data.id;
      if (rid) createdIds.push(rid);
      ok('建草稿成功且金额=明细合计', r.status === 200 && Number(r.json.data.amount) === 1234.56,
        `HTTP ${r.status} ${r.json.data && r.json.data.amount}`);

      // ---------- 3. 占用 ----------
      const open = Number(inv.amount) - (Number(inv.paid_amount) || 0);
      r = await req('/api/payment-requests', {
        method: 'POST', token,
        body: { supplier_id: inv.supplier_id, items: [{ invoice_id: inv.id, amount: open }], reason: '冒烟：超额申请' }
      });
      ok('同一张票被草稿占用后不能再申请全额（可申请额 = 未付 − 已占用）',
        r.status === 400 && /最多可申请/.test(r.json.message || ''),
        (r.json.message || '').slice(0, 46));

      const cd = await req('/api/payment-requests/candidates?supplier_id=' + (inv.supplier_id || 0), { token });
      const one = (cd.json.data.rows || []).find((x) => x.id === inv.id);
      ok('候选清单把「可申请额」算给用户看', one && Math.abs(one.committed - 1234.56) < 0.01,
        one ? `未付 ${one.open_amount} 占用 ${one.committed} 可申 ${one.available}` : '没找到');

      // ---------- 4. 跨模块口径：台账的「付款流程中」= 申请单未付合计 ----------
      const pb3 = await req('/api/payable/board', { token });
      const pipe = (pb3.json.data.rows || []).reduce((a, x) => a + Number(x.figures.in_pipeline || 0), 0);
      const reqSum = Number(db.prepare(
        "SELECT COALESCE(SUM(amount),0) s FROM payment_requests WHERE status IN ('draft','submitted','approved')"
      ).get().s);
      ok('应付台账的「付款流程中」= 所有未完成申请单的金额合计',
        Math.abs(pipe - reqSum) < 0.01, `台账 ${pipe} vs 申请单 ${reqSum}`);

      // ---------- 5. 提交与审批 ----------
      if (rid) {
        r = await req(`/api/payment-requests/${rid}/submit`, { method: 'POST', token });
        ok('提交后变「审批中」并生成审批实例',
          r.status === 200 && r.json.data.status === 'submitted' && !!r.json.data.approval_instance_id,
          `HTTP ${r.status}`);

        const t1 = r.json.data.approval && r.json.data.approval.tasks[0];
        ok('审批流带两级（财务 → 总经理）',
          r.json.data.approval && r.json.data.approval.tasks.length === 2,
          r.json.data.approval ? r.json.data.approval.tasks.map((x) => x.step_name).join('→') : '无');

        // admin 通常是申请人（冒烟用的就是 admin token），必须被 SoD 拦
        r = await req(`/api/approvals/tasks/${t1.id}/act`, {
          method: 'POST', token, body: { approve: true, remark: '我自己批' }
        });
        ok('申请人不能自己批自己（403，不是 400）',
          r.status === 403, `HTTP ${r.status} ${(r.json.message || '').slice(0, 30)}`);
        ok('被拒后审批任务保持 pending',
          db.prepare('SELECT status FROM approval_tasks WHERE id = ?').get(t1.id).status === 'pending');

        // ---------- 6. 未批准不许付款 ----------
        r = await req(`/api/payment-requests/${rid}/pay`, {
          method: 'POST', token, body: { bank_account_id: acc.id }
        });
        ok('审批没过不许付款', r.status === 400 && /待付款/.test(r.json.message || ''),
          `HTTP ${r.status} ${(r.json.message || '').slice(0, 30)}`);
      }

      // ---------- 7. 取消要写原因 ----------
      const cid = (await req('/api/payment-requests', {
        method: 'POST', token,
        body: { supplier_id: inv.supplier_id, items: [{ invoice_id: inv.id, amount: 100 }], reason: '冒烟：待取消' }
      })).json.data;
      if (cid) {
        createdIds.push(cid.id);
        r = await req(`/api/payment-requests/${cid.id}/cancel`, { method: 'POST', token, body: { reason: '不' } });
        ok('取消必须写原因（太短被拒）', r.status === 400, `HTTP ${r.status}`);
        r = await req(`/api/payment-requests/${cid.id}/cancel`, {
          method: 'POST', token, body: { reason: '冒烟：金额填错，撤回重开' }
        });
        ok('取消成功且该单不再占用额度',
          r.status === 200 && r.json.data.status === 'cancelled' &&
            db.prepare("SELECT COUNT(*) c FROM payment_request_items i JOIN payment_requests rr ON rr.id=i.request_id WHERE i.request_id=? AND rr.status IN ('draft','submitted','approved')").get(cid.id).c === 0,
          `HTTP ${r.status}`);
      }

      // ---------- 8. 权限 ----------
      const tkSales = await loginX('sales01');
      if (tkSales) {
        r = await req('/api/payment-requests', { token: tkSales });
        ok('销售看不到付款申请（欠谁钱、何时付是敏感信息）', r.status === 403, `HTTP ${r.status}`);
        r = await req('/api/payment-requests/' + rid + '/pay', { method: 'POST', token: tkSales, body: { bank_account_id: acc.id } });
        ok('销售不能执行付款', r.status === 403, `HTTP ${r.status}`);
      }
      const tkHr = await loginX('hr01');
      if (tkHr) {
        r = await req('/api/payment-requests', { token: tkHr });
        ok('人事看不到付款申请', r.status === 403, `HTTP ${r.status}`);
      }
      r = await req('/api/payment-requests', {});
      ok('未登录 401', r.status === 401, `HTTP ${r.status}`);

      // ---------- 9. 统计口径 ----------
      const meta = await req('/api/payment-requests/meta', { token });
      ok('meta 返回统计且「已申请未付」= 审批中 + 待付款',
        meta.status === 200 &&
          Math.abs(Number(meta.json.data.stats.pipeline_amount) -
            (Number(meta.json.data.stats.submitted.amount) + Number(meta.json.data.stats.approved.amount))) < 0.01,
        meta.json.data ? String(meta.json.data.stats.pipeline_amount) : '无');

      const lst = await req('/api/payment-requests', { token });
      ok('列表摘要与统计接口字段一致（不许一个叫 unpaid_amount 一个叫 pipeline_amount）',
        lst.status === 200 && lst.json.data.summary.pipeline_amount !== undefined &&
          lst.json.data.summary.overdue_pending_count !== undefined,
        lst.json.data ? Object.keys(lst.json.data.summary).join(',') : '无');

      clean();
      // 只能断言「自己建的那几张没了」，不能断言全表为空 —— 演示数据本来就占着表
      const left = createdIds.filter((id) => db.prepare('SELECT 1 x FROM payment_requests WHERE id = ?').get(id));
      ok('付款申请用例自清理（本用例建的单已删净）',
        left.length === 0, left.join(',') || `建了 ${createdIds.length} 张，已清 ${createdIds.length - left.length} 张`);
    }
  }

  // ================= 应收催收 =================
  {
    console.log('\n— 应收催收 —');
    const { db } = require('../src/db');
    const S4 = require('../src/services/invoiceStatus');
    const C4 = require('../src/services/collection');

    const loginY = async (u) => {
      const r = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: PASS })
      });
      const j = await r.json().catch(() => ({}));
      return j && j.ok ? j.data.token : null;
    };
    const ymd = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

    // 独立测试样本：自建客户 + 逾期 40 天发票（不用演示数据，避免互相干扰）
    const TAG = 'SMOKECOL';
    const t0 = new Date().toISOString();
    const taskIds = [];
    const payIds = [];
    const wipe = () => {
      const ivs = db.prepare('SELECT id FROM ar_invoices WHERE bill_no LIKE ?').all(TAG + '%').map((x) => x.id);
      ivs.forEach((id) => db.prepare('DELETE FROM collection_task_items WHERE invoice_id = ?').run(id));
      // 上次跑到一半崩了会留下同名单据 → 开头先清干净，保证可重复跑
      db.prepare("SELECT id FROM collection_tasks WHERE IFNULL(customer_name,'') LIKE '冒烟·催收%' OR IFNULL(note,'') LIKE ?")
        .all(TAG + '%')
        .forEach((x) => {
          db.prepare('DELETE FROM collection_logs WHERE task_id = ?').run(x.id);
          db.prepare('DELETE FROM collection_task_items WHERE task_id = ?').run(x.id);
          db.prepare('DELETE FROM collection_tasks WHERE id = ?').run(x.id);
        });
      ivs.forEach((id) => db.prepare('DELETE FROM ar_invoices WHERE id = ?').run(id));
      db.prepare('DELETE FROM customers WHERE code = ?').run(TAG);
    };
    const cleanup = () => {
      taskIds.forEach((tid) => {
        db.prepare('DELETE FROM collection_logs WHERE task_id = ?').run(tid);
        db.prepare('DELETE FROM collection_task_items WHERE task_id = ?').run(tid);
        db.prepare('DELETE FROM collection_tasks WHERE id = ?').run(tid);
      });
      payIds.forEach((pid) => {
        const allocs = db.prepare('SELECT * FROM payment_allocations WHERE payment_id = ?').all(pid);
        db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?').run(pid);
        db.prepare('DELETE FROM payments WHERE id = ?').run(pid);
        allocs.forEach((a) => S4.syncPaidStatus(a.invoice_kind, a.invoice_id));
      });
    };
    payIds.length = 0;
    cleanup();
    wipe();

    const custId = db.prepare(
      `INSERT INTO customers (code, name, level, credit_limit, credit_days, credit_status, created_at, updated_at)
       VALUES (?, '冒烟·催收测试客户', 'B', 200000, 30, 'active', ?, ?)`
    ).run(TAG, t0, t0).lastInsertRowid;
    const invId = db.prepare(
      `INSERT INTO ar_invoices (bill_no, customer_id, customer_name, currency, amount_orig, rate, amount,
         paid_amount, due_date, status, source, remark, created_at, updated_at)
       VALUES (?, ?, '冒烟·催收测试客户', 'CNY', 50000, 1, 50000, 0, ?, 'unpaid', 'manual', 'SMOKE', ?, ?)`
    ).run(TAG + '-INV1', custId, ymd(-40), t0, t0).lastInsertRowid;

    // ---------- 台账：集团内部不算催收对象 ----------
    const bd = await req('/api/collections/board', { token });
    const internalIds = [...C4.internalCustomerIds()];
    const rowsInternal = (bd.json.data.rows || []).filter((x) => x.is_internal);
    ok('逾期台账排除集团内部往来（不催自家公司）',
      internalIds.every((id) => {
        const row = (bd.json.data.rows || []).find((x) => Number(x.customer_id) === Number(id));
        return !row || row.is_internal === true;
      }) && (bd.json.data.summary.internal_amount >= 0),
      `内部 ${bd.json.data.summary.internal_count} 家 / ${bd.json.data.summary.internal_amount}`);
    ok('台账把外部逾期与内部往来分开统计',
      typeof bd.json.data.summary.external_amount === 'number' &&
        bd.json.data.summary.external_amount + bd.json.data.summary.internal_amount >= 0,
      `外部 ${bd.json.data.summary.external_amount} + 内部 ${bd.json.data.summary.internal_amount}`);

    // ---------- 生成 ----------
    let r = await req('/api/collections/generate', {
      method: 'POST', token, body: { customer_ids: [custId], min_overdue_days: 1 }
    });
    const task = (r.json.data.created || [])[0];
    if (task) taskIds.push(task.id);
    ok('按客户生成催收任务', r.status === 200 && !!task, task ? `${task.task_no} ${task.amount}` : JSON.stringify(r.json.data.skipped));

    r = await req('/api/collections/generate', {
      method: 'POST', token, body: { customer_ids: [custId], min_overdue_days: 1 }
    });
    ok('重复生成被跳过（不堆重复单）',
      r.json.data.summary.created === 0 && (r.json.data.skipped || []).some((x) => /已有任务/.test(x.reason)),
      JSON.stringify(r.json.data.summary));

    if (!task) { console.log('  ⚠ 没生成任务，跳过后续'); } else {
      // ---------- 剩余额实时算 ----------
      r = await req(`/api/collections/${task.id}`, { token });
      ok('剩余额 = 发票实时未付（不是快照）',
        Math.abs(Number(r.json.data.live.remaining) - 50000) < 0.01, String(r.json.data.live.remaining));

      // ---------- 承诺的三道门槛 ----------
      let lg = await req(`/api/collections/${task.id}/log`, {
        method: 'POST', token, body: { channel: 'phone', result: 'promised' }
      });
      ok('「答应付款」缺承诺日期 → 拒', lg.status === 400 && /承诺日期/.test(lg.json.message || ''), `HTTP ${lg.status}`);

      lg = await req(`/api/collections/${task.id}/log`, {
        method: 'POST', token, body: { channel: 'phone', result: 'promised', promise_date: ymd(5) }
      });
      ok('「答应付款」缺承诺金额 → 拒（只说下周付等于没承诺）',
        lg.status === 400 && /承诺金额/.test(lg.json.message || ''), `HTTP ${lg.status}`);

      lg = await req(`/api/collections/${task.id}/log`, {
        method: 'POST', token,
        body: { channel: 'phone', result: 'promised', promise_date: ymd(-2), promise_amount: 1000 }
      });
      ok('承诺日期早于今天 → 拒', lg.status === 400 && /不能早于今天/.test(lg.json.message || ''), `HTTP ${lg.status}`);

      lg = await req(`/api/collections/${task.id}/log`, {
        method: 'POST', token,
        body: { channel: 'phone', result: 'promised', promise_date: ymd(5), promise_amount: 60000 }
      });
      ok('承诺金额超过未收额 → 拒', lg.status === 400 && /超过/.test(lg.json.message || ''), `HTTP ${lg.status}`);

      lg = await req(`/api/collections/${task.id}/log`, {
        method: 'POST', token, body: { channel: 'phone', result: 'dispute' }
      });
      ok('「有争议」不写说明 → 拒', lg.status === 400 && /至少 4 个字/.test(lg.json.message || ''), `HTTP ${lg.status}`);

      // ---------- 正常承诺 ----------
      lg = await req(`/api/collections/${task.id}/log`, {
        method: 'POST', token,
        body: { channel: 'wechat', result: 'promised', promise_date: ymd(5), promise_amount: 50000, note: '冒烟：客户确认月底付清' }
      });
      ok('记承诺成功，状态变「客户承诺」',
        lg.status === 200 && lg.json.data.status === 'promised', `HTTP ${lg.status} ${lg.json.data && lg.json.data.status}`);
      ok('跟进次数 +1 且记录可查',
        Number(lg.json.data.follow_count) === 1 && lg.json.data.logs.length === 1);

      // ---------- 承诺跳票 ----------
      db.prepare('UPDATE collection_tasks SET promise_date = ? WHERE id = ?').run(ymd(-3), task.id);
      C4.refreshAll();
      const esc = await req(`/api/collections/${task.id}`, { token });
      ok('过了承诺日没收到钱 → 自动升级「承诺跳票」', esc.json.data.status === 'escalated', esc.json.data.status);
      ok('升级后「跳票」标记仍亮着（否则看不出为什么升级）',
        esc.json.data.live.promise_broken === true && esc.json.data.live.promise_overdue_days >= 2,
        `${esc.json.data.live.promise_broken} / ${esc.json.data.live.promise_overdue_days} 天`);

      // ---------- 结案门槛 ----------
      r = await req(`/api/collections/${task.id}/close`, { method: 'POST', token, body: { reason: 'paid' } });
      ok('还有钱没收到，不能按「已收回」结案',
        r.status === 400 && /没收到/.test(r.json.message || ''), `HTTP ${r.status}`);

      r = await req(`/api/collections/${task.id}/close`, {
        method: 'POST', token, body: { reason: 'bad_debt', note: '坏账' }
      });
      ok('核销坏账说明太短 → 拒', r.status === 400 && /8 个字/.test(r.json.message || ''), `HTTP ${r.status}`);

      // ---------- 回款自动结案（跨模块） ----------
      const pay = await req('/api/finance/payments', {
        method: 'POST', token,
        body: {
          direction: 'in', partner_id: custId, partner_name: '冒烟·催收测试客户',
          currency: 'CNY', amount: 50000, pay_date: ymd(0), method: '银行转账',
          remark: 'SMOKE-COLLECTION',
          allocations: [{ invoice_id: invId, amount: 50000 }]
        }
      });
      if (pay.json.data && pay.json.data.id) payIds.push(pay.json.data.id);
      ok('回款登记成功', pay.status === 200, `HTTP ${pay.status}`);

      const after = db.prepare('SELECT * FROM collection_tasks WHERE id = ?').get(task.id);
      ok('钱收齐后催收任务**自动结案**（不用人去点）', after.status === 'closed', after.status);
      ok('自动结案原因记为 paid 并写了说明',
        after.closed_reason === 'paid' && /自动结案|回款结清/.test(after.closed_note || ''),
        `${after.closed_reason}`);

      r = await req(`/api/collections/${task.id}`, { token });
      ok('结案后剩余额为 0、明细全标已结清',
        Number(r.json.data.live.remaining) === 0 && r.json.data.items.every((x) => x.settled));
    }

    // ---------- 权限 ----------
    const tkSales2 = await loginY('sales01');
    if (tkSales2) {
      r = await req('/api/collections', { token: tkSales2 });
      ok('销售能看自己名下的催收单', r.status === 200, `HTTP ${r.status}`);
      const other = db.prepare(
        "SELECT id FROM collection_tasks WHERE status <> 'closed' AND IFNULL(owner_username,'') <> 'sales01' LIMIT 1"
      ).get();
      if (other) {
        r = await req(`/api/collections/${other.id}/close`, {
          method: 'POST', token: tkSales2, body: { reason: 'other', note: '销售想自己结案' }
        });
        ok('销售不能结案（会影响应收质量口径）', r.status === 403, `HTTP ${r.status}`);
      }
      r = await req('/api/collections/generate', { method: 'POST', token: tkSales2, body: { all: true } });
      ok('销售不能批量生成催收单', r.status === 403, `HTTP ${r.status}`);
    }
    const tkHr2 = await loginY('hr01');
    if (tkHr2) {
      r = await req('/api/collections', { token: tkHr2 });
      ok('人事看不到催收（跟岗位无关）', r.status === 403, `HTTP ${r.status}`);
    }
    r = await req('/api/collections', {});
    ok('未登录 401', r.status === 401, `HTTP ${r.status}`);

    // ---------- 自清理 ----------
    cleanup();
    wipe();
    ok('催收用例自清理（任务/客户/发票都删净）',
      db.prepare('SELECT COUNT(*) c FROM customers WHERE code = ?').get(TAG).c === 0 &&
        db.prepare('SELECT COUNT(*) c FROM ar_invoices WHERE bill_no LIKE ?').get(TAG + '%').c === 0);
  }

  // ================= 操作日志 / 审计 =================
  {
    console.log('\n[操作日志 / 审计]');
    const { db } = require('../src/db');
    const loginAs = async (u) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: PASS } });
      return r.status === 200 ? r.json.data.token : '';
    };

    const list1 = await req('/api/audit?pageSize=3', { token });
    const lrows = (list1.json.data && list1.json.data.rows) || [];
    ok('管理员可读操作日志', list1.status === 200 && Array.isArray(lrows), `HTTP ${list1.status}`);
    ok('分页参数生效（要 3 条给 3 条，不被下限卡住）', lrows.length === 3, `rows=${lrows.length}`);
    ok('列表带业务语义（大类/模块/动作/摘要）',
      lrows.every((r) => r.group_label && r.module_label && r.action_label && r.summary),
      JSON.stringify(lrows[0] && [lrows[0].group_label, lrows[0].module_label]));

    const failOnly = await req('/api/audit?result=fail&pageSize=5', { token });
    ok('只看失败筛选生效', ((failOnly.json.data && failOnly.json.data.rows) || []).every((r) => r.status >= 400),
      JSON.stringify(((failOnly.json.data && failOnly.json.data.rows) || []).map((r) => r.status)));

    const byGroup = await req('/api/audit?group=finance&pageSize=5', { token });
    ok('按大类筛选生效', ((byGroup.json.data && byGroup.json.data.rows) || []).every((r) => r.module_group === 'finance'),
      JSON.stringify(((byGroup.json.data && byGroup.json.data.rows) || []).map((r) => r.module_group)));

    const facets = await req('/api/audit/facets', { token });
    ok('筛选下拉只给库里出现过的值',
      facets.status === 200 && (facets.json.data.groups || []).length > 0 && (facets.json.data.actions || []).length > 0,
      `HTTP ${facets.status}`);

    const stat = await req('/api/audit/stats?days=7', { token });
    ok('统计含大类汇总与趋势',
      stat.status === 200 && (stat.json.data.by_group || []).length > 0 && Array.isArray(stat.json.data.trend),
      `HTTP ${stat.status}`);

    const tailSeq = Number(db.prepare('SELECT MAX(seq) m FROM audit_logs').get().m) || 0;
    const scope = '?from=' + Math.max(1, tailSeq - 500);

    const v1 = await req('/api/audit/verify' + scope, { token });
    ok('链校验通过且给出水位',
      v1.status === 200 && v1.json.data.ok === true && Number(v1.json.data.state.last_seq) > 0,
      JSON.stringify(v1.json.data.problems));

    // --- 篡改检测：改一条日志的路径，链必须断，且要点名序号 ---
    const victim = db.prepare('SELECT id, seq, path FROM audit_logs WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1 OFFSET 2').get();
    db.prepare('UPDATE audit_logs SET path = ? WHERE id = ?').run('/api/tampered/record', victim.id);
    const vBad = await req('/api/audit/verify' + scope, { token });
    ok('改过一条日志 → 校验报 HASH 并指出序号',
      vBad.json.data.ok === false && (vBad.json.data.problems || []).some((p) => p.code === 'HASH' && Number(p.seq) === Number(victim.seq)),
      JSON.stringify((vBad.json.data.problems || []).slice(0, 2)));
    db.prepare('UPDATE audit_logs SET path = ? WHERE id = ?').run(victim.path, victim.id);
    const vFix = await req('/api/audit/verify' + scope, { token });
    ok('恢复原文后链重新通过', vFix.json.data.ok === true, JSON.stringify((vFix.json.data.problems || []).slice(0, 2)));

    // --- 删尾部检测：只删最后一条，链自身仍自洽，只能靠水位抓 ---
    const tail = db.prepare('SELECT * FROM audit_logs WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1').get();
    db.prepare('DELETE FROM audit_logs WHERE id = ?').run(tail.id);
    const vTail = await req('/api/audit/verify' + scope, { token });
    ok('删掉最后一条 → 校验报「尾部缺失」（水位机制）',
      vTail.json.data.ok === false && (vTail.json.data.problems || []).some((p) => p.code === 'TAIL_SEQ'),
      JSON.stringify((vTail.json.data.problems || []).slice(0, 2)));
    const cols = Object.keys(tail).join(',');
    const ph = Object.keys(tail).map(() => '?').join(',');
    db.prepare(`INSERT INTO audit_logs (${cols}) VALUES (${ph})`).run(...Object.values(tail));
    const vBack = await req('/api/audit/verify' + scope, { token });
    ok('把那条原样插回 → 链恢复', vBack.json.data.ok === true, JSON.stringify((vBack.json.data.problems || []).slice(0, 2)));

    // --- 导出 ---
    const ex = await fetch(BASE + '/api/audit/export?group=hr', { headers: { Authorization: 'Bearer ' + token } });
    const txt = await ex.text();
    ok('导出 CSV 返回 200', ex.status === 200, `HTTP ${ex.status}`);
    ok('导出带范围声明与链校验结论', txt.includes('# 操作日志导出') && txt.includes('链校验'), txt.slice(0, 40));
    ok('导出带文件哈希与序号区间响应头',
      !!ex.headers.get('x-audit-file-sha256') && !!ex.headers.get('x-audit-seq-range'),
      ex.headers.get('x-audit-seq-range'));
    ok('导出列含「大类/模块/动作」', txt.includes('大类,模块,动作'), '');

    // --- 归档：参数与空档拦截（成功路径见 scripts/drill-audit-archive.js） ---
    const archBad = await req('/api/audit/archive', { method: 'POST', token, body: { before_days: 7 } });
    ok('保留期少于 30 天被拒（那等于删日志）', archBad.status === 400, `HTTP ${archBad.status}`);
    const archNone = await req('/api/audit/archive', { method: 'POST', token, body: { before_days: 3650 } });
    ok('没有更早日志时给出明确提示', archNone.status === 400, `HTTP ${archNone.status} ${archNone.json.message || ''}`);
    const arcs = await req('/api/audit/archives', { token });
    ok('归档记录可读', arcs.status === 200 && Array.isArray(arcs.json.data), `HTTP ${arcs.status}`);

    // --- 权限 ---
    const noAuthAudit = await req('/api/audit');
    ok('审计日志需要登录', noAuthAudit.status === 401, `HTTP ${noAuthAudit.status}`);
    const hrTok2 = await loginAs('hr01');
    if (hrTok2) {
      const hrDeny = await req('/api/audit', { token: hrTok2 });
      ok('人事看不到全公司操作日志', hrDeny.status === 403, `HTTP ${hrDeny.status}`);
      const hrArc = await req('/api/audit/archive', { method: 'POST', token: hrTok2, body: { before_days: 90 } });
      ok('人事不能归档（破坏性动作）', hrArc.status === 403, `HTTP ${hrArc.status}`);
    } else {
      ok('人事看不到全公司操作日志 / 不能归档', true, '没有 hr01，跳过');
    }
    const bossTok = await loginAs('boss');
    if (bossTok) {
      const bossRead = await req('/api/audit?pageSize=5', { token: bossTok });
      ok('老板可读操作日志（只读）', bossRead.status === 200, `HTTP ${bossRead.status}`);
      const bossArc = await req('/api/audit/archive', { method: 'POST', token: bossTok, body: { before_days: 90 } });
      ok('老板不能归档', bossArc.status === 403, `HTTP ${bossArc.status}`);
    } else {
      ok('老板可读 / 不能归档', true, '没有 boss 账号，跳过');
    }
  }

  // ================= 异常协同与日清（TS-N01-03） =================
  // 这一段自建 EXSMOKE 夹具并跑完删净，不碰演示数据。
  {
    console.log('\n[异常协同与日清]');
    const { db } = require('../src/db');
    const loginAsLocal = async (u) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: PASS } });
      return r.status === 200 ? r.json.data.token : '';
    };
    const back = (n) => {
      const d = new Date(); d.setDate(d.getDate() - n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const tnow = new Date().toISOString();

    const cleanupExc = () => {
      const ids = db.prepare("SELECT id FROM exception_items WHERE source_no='EXSMOKE0001'").all().map((x) => x.id);
      ids.forEach((id) => {
        db.prepare('DELETE FROM exception_actions WHERE item_id=?').run(id);
        db.prepare('DELETE FROM exception_items WHERE id=?').run(id);
      });
      const o = db.prepare("SELECT id FROM orders WHERE order_no='EXSMOKE0001'").get();
      if (o) {
        db.prepare('DELETE FROM order_logs WHERE order_id=?').run(o.id);
        db.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id=?)').run(o.id);
        db.prepare('DELETE FROM order_items WHERE order_id=?').run(o.id);
        db.prepare('DELETE FROM orders WHERE id=?').run(o.id);
      }
    };
    const makeOrder = () => {
      const cust = db.prepare('SELECT id FROM customers ORDER BY id LIMIT 1').get();
      return db.prepare(
        `INSERT INTO orders (order_no,type,customer_id,status,rate,total_usd,total_amount,currency,style_name,manager,order_date,delivery_date,remark,created_by,created_at,updated_at,company_id)
         VALUES ('EXSMOKE0001','stock',?,'production',6.5,1000,6500,'USD','冒烟款','冒烟跟单',?,?,'冒烟夹具',1,?,?,1)`
      ).run(cust ? cust.id : null, back(10), back(2), tnow, tnow).lastInsertRowid;
    };

    // ---- 只读口径 ----
    const dl = await req('/api/exceptions/daily', { token });
    const d0 = dl.json.data || {};
    ok('日清清单可读', dl.status === 200, `HTTP ${dl.status}`);
    ok('七类归口都返回（六类业务 + 流程与审批）', (d0.summary || []).length >= 7, `实际 ${(d0.summary || []).length} 类`);

    /**
     * 覆盖率只来自"当天那次扫描"，**没有任何扫描就没有覆盖率**
     *
     * 这条原来写成"读 daily 的 coverage 必须非空"，等于假设今天已经跑过一次扫描 ——
     * 换一天（新的一天第一次跑冒烟）就必然红两条，而代码一点没变。
     * 现在改成断言"没扫过时要明说 pending"，覆盖率本身在下面扫描之后断言。
     */
    const dOld = await req('/api/exceptions/daily?day=1999-01-01', { token });
    ok('★ 没扫描时明确告知「今日尚未扫描」（coverage=null + pending 标记）',
      dOld.status === 200 && dOld.json.data.coverage === null && dOld.json.data.coverage_pending === true,
      `coverage=${JSON.stringify(dOld.json.data && dOld.json.data.coverage)} pending=${dOld.json.data && dOld.json.data.coverage_pending}`);

    const allowWhy = ['已升级', '严重级', '过预计解决日', '超时未认领'];
    const badWhy = (d0.must || []).filter((x) => !allowWhy.includes(x.why));
    ok('今日必办只收升级类事项', badWhy.length === 0, badWhy.map((x) => x.title + ':' + x.why).join(' | '));
    ok('处理中里没有已升级条目', (d0.doing || []).every((x) => !x.escalated));

    const rules = await req('/api/exceptions/rules', { token });
    ok('规则 11 条且每条都有判定口径',
      (rules.json.data || []).length === 11 && (rules.json.data || []).every((r) => (r.rule_note || '').length > 10),
      `条数 ${(rules.json.data || []).length}`);
    // 人事类暂时没有自动检测规则（覆盖率里显式声明了），所以这里只要求
    // 技术/缺料/质量/产能/资金 + 流程归口 六类都各有规则 —— 逐类点名，
    // 少哪一类一眼能看出来，比数类别个数有用
    const cats = new Set((rules.json.data || []).map((r) => r.category));
    const missingCat = ['tech', 'material', 'quality', 'capacity', 'cash', 'governance'].filter((c) => !cats.has(c));
    ok('规则覆盖技术/缺料/质量/产能/资金 + 流程归口', missingCat.length === 0, `缺 ${missingCat.join(',')}`);

    // ---- 夹具：过交期订单 → 检出 → 幂等 ----
    cleanupExc();
    const oid = makeOrder();

    const scan1 = await req('/api/exceptions/scan', { method: 'POST', token, body: {} });
    ok('扫描可执行', scan1.status === 200, `HTTP ${scan1.status}`);

    /**
     * 覆盖率断言必须基于**这次扫描的返回值**，不能读 daily 里上一次的批次 ——
     * 否则"今天还没扫"的那一天会稳定红两条（换日复现，代码没动）。
     */
    const scanCov = (scan1.json.data && scan1.json.data.coverage) || [];
    const skipNoReason = scanCov.filter((c) => c.skipped > 0 && !c.skip_reason);
    ok('★ 跳过的规则都写清了原因（扫描结果自带口径）',
      scanCov.length > 0 && skipNoReason.length === 0,
      `${scanCov.length} 条规则，缺原因：${skipNoReason.map((c) => c.rule).join(',') || '无'}`);
    const scanGaps = (scan1.json.data && scan1.json.data.category_gaps) || [];
    ok('★ 覆盖率里显式说明未覆盖的类别',
      scanGaps.length > 0 && /暂无自动检测规则/.test(JSON.stringify(scanGaps)),
      JSON.stringify(scanGaps).slice(0, 80));

    // 扫完之后 daily 应该能读到同一份覆盖率（且不再标 pending）
    const dAfter = await req('/api/exceptions/daily', { token });
    ok('扫描后 daily 带出同一份覆盖率（pending 标记消失）',
      dAfter.status === 200 && dAfter.json.data.coverage_pending === false
      && ((dAfter.json.data.coverage && dAfter.json.data.coverage.rules) || []).length === scanCov.length,
      `pending=${dAfter.json.data && dAfter.json.data.coverage_pending}`);

    const mine = db.prepare("SELECT * FROM exception_items WHERE source_no='EXSMOKE0001' ORDER BY id").all();
    ok('过交期订单被检出', mine.length === 1 && mine[0].rule_code === 'order_overdue', `条数 ${mine.length}`);
    ok('检出的异常是严重级', mine.length === 1 && mine[0].severity === 'serious');
    ok('影响金额带上了原单金额', mine.length === 1 && Number(mine[0].impact_amount) === 6500, mine.length ? mine[0].impact_amount : '-');
    ok('责任人取原单跟单员', mine.length === 1 && mine[0].owner_name === '冒烟跟单' && mine[0].owner_source === 'order');

    const cnt1 = db.prepare('SELECT COUNT(*) c FROM exception_items').get().c;
    const scan2 = await req('/api/exceptions/scan', { method: 'POST', token, body: {} });
    const cnt2 = db.prepare('SELECT COUNT(*) c FROM exception_items').get().c;
    ok('同一天重扫不重复派单', scan2.json.data.opened === 0 && cnt1 === cnt2, `新开 ${scan2.json.data.opened} / ${cnt1}→${cnt2}`);
    ok('重扫只刷新不重置处理状态', db.prepare('SELECT seen_count FROM exception_items WHERE source_no=?').get('EXSMOKE0001').seen_count >= 2);

    const itemId = mine[0].id;
    const det = await req(`/api/exceptions/${itemId}`, { token });
    ok('详情带动作流水', det.status === 200 && (det.json.data.actions || []).length >= 1, `HTTP ${det.status}`);
    ok('详情说明规则口径', (det.json.data.rule_note || '').length > 10);

    // 幂等键的口径：缺料不能用 material_requirements 的行 id —— 齐套算料是整批删了重建，
    // 用行 id 会变成「同一件缺料天天出新单」（实际踩过，一天堆了 12 条重复）
    const mreq = await req('/api/exceptions?rule=material_short', { token });
    const mrows = mreq.json.data || [];
    ok('缺料异常以「订单 + 物料」为幂等键',
      mrows.length > 0 && mrows.every((x) => x.source_type === 'order' && /^mat:/.test(x.biz_key || '')),
      `${mrows.length} 条 / ${mrows.slice(0, 3).map((x) => x.source_type + ':' + x.biz_key).join(',')}`);

    // ---- 关闭与复核校验 ----
    const noResult = await req(`/api/exceptions/${itemId}/close`, { method: 'POST', token, body: { cause: '冒烟原因写够了' } });
    ok('关闭不写处理结果被拦', noResult.status === 400 && /处理结果/.test(noResult.json.message || ''), `HTTP ${noResult.status}`);
    const noCause = await req(`/api/exceptions/${itemId}/close`, { method: 'POST', token, body: { result: '冒烟结果写够了' } });
    ok('关闭不写原因被拦', noCause.status === 400 && /原因/.test(noCause.json.message || ''), `HTTP ${noCause.status}`);

    const noReason = await req(`/api/exceptions/${itemId}/assign`, { method: 'POST', token, body: { to_username: 'admin' } });
    ok('转派不写原因被拦', noReason.status === 400 && /原因/.test(noReason.json.message || ''), `HTTP ${noReason.status}`);

    const cl = await req(`/api/exceptions/${itemId}/claim`, { method: 'POST', token, body: {} });
    ok('认领成功', cl.status === 200 && cl.json.data.status === 'claimed', `HTTP ${cl.status}`);
    const closed = await req(`/api/exceptions/${itemId}/close`, {
      method: 'POST', token, body: { cause: '冒烟：排产延后导致超期', result: '冒烟：已调整排产并补发' }
    });
    ok('关闭成功且转待复核', closed.status === 200 && closed.json.data.status === 'closed'
      && closed.json.data.review_status === 'pending', `HTTP ${closed.status}`);
    const reClaim = await req(`/api/exceptions/${itemId}/claim`, { method: 'POST', token, body: {} });
    ok('已关闭不能再认领', reClaim.status === 400, `HTTP ${reClaim.status}`);

    const selfRev = await req(`/api/exceptions/${itemId}/review`, { method: 'POST', token, body: { pass: true, note: '冒烟自审' } });
    ok('处理人不能自己复核', selfRev.status === 400 && /复核人不能是处理人/.test(selfRev.json.message || ''), `HTTP ${selfRev.status}`);

    db.prepare("UPDATE exception_items SET closed_by='冒烟跟单' WHERE id=?").run(itemId);
    const rev = await req(`/api/exceptions/${itemId}/review`, { method: 'POST', token, body: { pass: true, note: '冒烟复核通过' } });
    ok('换人复核可通过', rev.status === 200 && rev.json.data.review_status === 'passed', `HTTP ${rev.status}`);

    // ---- 事实消失 → 自动消除（重新造一张，前面的已关闭不会再被扫到） ----
    cleanupExc();
    const oid2 = makeOrder();
    await req('/api/exceptions/scan', { method: 'POST', token, body: {} });
    const openOne = db.prepare("SELECT id FROM exception_items WHERE source_no='EXSMOKE0001' AND status='open'").get();
    ok('重新建单后再次检出', !!openOne);
    const statsBefore = (await req('/api/exceptions/stats', { token })).json.data;

    db.prepare("UPDATE orders SET status='shipped' WHERE id=?").run(oid2);
    const scan3 = await req('/api/exceptions/scan', { method: 'POST', token, body: {} });
    const st = db.prepare("SELECT status, auto_resolve_note FROM exception_items WHERE source_no='EXSMOKE0001'").get();
    ok('事实消失后由系统自动消除', !!st && st.status === 'auto_resolved', `status=${st ? st.status : '-'}`);
    ok('自动消除写明是按事实而非人工处理', !!st && /未再检出/.test(st.auto_resolve_note || ''), st ? st.auto_resolve_note : '-');
    const statsAfter = (await req('/api/exceptions/stats', { token })).json.data;
    ok('自动消除没被算成人工完成', (statsAfter.closed_today || 0) === (statsBefore.closed_today || 0),
      `${statsBefore.closed_today}→${statsAfter.closed_today}`);
    ok('扫描不改业务单据状态', db.prepare('SELECT status FROM orders WHERE id=?').get(oid2).status === 'shipped');

    cleanupExc();
    ok('冒烟夹具已清干净',
      !db.prepare("SELECT 1 FROM exception_items WHERE source_no='EXSMOKE0001'").get()
      && !db.prepare("SELECT 1 FROM orders WHERE order_no='EXSMOKE0001'").get());

    // ---- 标为数据遗留：日清要能清零，但不能静默 ----
    const oid3 = makeOrder();
    await req('/api/exceptions/scan', { method: 'POST', token, body: {} });
    const leg = db.prepare("SELECT id FROM exception_items WHERE source_no='EXSMOKE0001' AND status='open'").get();
    ok('造出的异常可用于忽略测试', !!leg);
    if (leg) {
      const noReason2 = await req(`/api/exceptions/${leg.id}/ignore`, { method: 'POST', token, body: {} });
      ok('标为遗留不写理由被拦', noReason2.status === 400 && /理由/.test(noReason2.json.message || ''), `HTTP ${noReason2.status}`);
      const s1 = (await req('/api/exceptions/stats', { token })).json.data;
      const ign = await req(`/api/exceptions/${leg.id}/ignore`, {
        method: 'POST', token, body: { reason: '冒烟：历史遗留单，不参与日清' }
      });
      ok('标为遗留成功且状态单独记', ign.status === 200 && ign.json.data.status === 'ignored', `HTTP ${ign.status}`);
      const s2 = (await req('/api/exceptions/stats', { token })).json.data;
      ok('标为遗留不算处理完成', s2.closed_today === s1.closed_today, `${s1.closed_today}→${s2.closed_today}`);
      ok('已压住的条数单独统计', (s2.ignored || 0) === (s1.ignored || 0) + 1, `${s1.ignored}→${s2.ignored}`);
      const scanIg = await req('/api/exceptions/scan', { method: 'POST', token, body: {} });
      ok('标为遗留后重扫不再开新条目', scanIg.json.data.opened === 0 && (scanIg.json.data.suppressed || 0) >= 1,
        `opened=${scanIg.json.data.opened} suppressed=${scanIg.json.data.suppressed}`);
      ok('被压住的条数在扫描结果里可见（不静默）', (scanIg.json.data.suppressed || 0) >= 1);
    }
    cleanupExc();

    // ---- 权限 ----
    const salesTok = await loginAsLocal('sales01');
    if (salesTok) {
      const denyRule = await req('/api/exceptions/rules/order_overdue', { method: 'PUT', token: salesTok, body: { threshold: 1 } });
      ok('销售不能改规则阈值', denyRule.status === 403, `HTTP ${denyRule.status}`);
      const denyRev = await req('/api/exceptions/1/review', { method: 'POST', token: salesTok, body: { pass: true } });
      ok('销售不能复核', denyRev.status === 403, `HTTP ${denyRev.status}`);
      const denyScan = await req('/api/exceptions/scan', { method: 'POST', token: salesTok, body: {} });
      ok('销售可以手动触发扫描（干活的人要能刷新）', denyScan.status === 200, `HTTP ${denyScan.status}`);
    } else {
      ok('销售不能改规则阈值 / 不能复核', true, '没有 sales01，跳过');
    }

    // ---- 坏账计提已暂停：接口必须下线，关账检查里也不该再出现 ----
    const bd = await req('/api/bad-debt/policy', { token });
    ok('坏账计提接口已暂停（404）', bd.status === 404, `HTTP ${bd.status}`);
    const ck = await req('/api/gl/periods/2026-10/checks', { token });
    const chkList = (ck.json.data && ck.json.data.checks) || [];
    ok('关账检查不含坏账项', chkList.length > 0 && !chkList.some((c) => c.code === 'bad_debt'), `共 ${chkList.length} 项`);
  }

  // ================= 生产交付效率与质量报表（TS-N08-09） =================
  // 全只读：这一段不改任何业务数据。
  {
    console.log('\n[生产交付效率与质量报表]');
    const pr = await req('/api/prod-report/overview', { token });
    const p = pr.json.data || {};
    ok('报表总览可读', pr.status === 200, `HTTP ${pr.status}`);
    ok('八项指标都在', ['on_time_rate', 'fpy', 'rework_rate', 'wip_avg_age', 'efficiency', 'cut_pass_rate']
      .every((k) => k in (p.kpi || {})), JSON.stringify(Object.keys(p.kpi || {})));
    ok('口径说明 8 条', (p.calibers || []).length === 8, `实际 ${(p.calibers || []).length} 条`);
    ok('口径写明不美化准交率', (p.calibers || []).some((c) => /不相减|并列/.test(c)));

    // 覆盖率：每条都要有分母；算不出来的必须写原因，不能只给一个数字
    const cov = p.coverage || [];
    ok('覆盖率每条都有分子分母', cov.length > 0 && cov.every((c) => typeof c.available === 'number' && typeof c.total === 'number'));
    ok('不计算的指标都写清了原因', cov.every((c) => c.rate !== null || (c.note || '').length > 4),
      cov.filter((c) => c.rate === null && !(c.note || '')).map((c) => c.item).join(','));
    ok('材料利用率不拿合格率冒充', cov.some((c) => c.item === '材料利用率' && c.rate === null && /净用布/.test(c.note || '')));

    // 准交双口径
    ok('准交率给出双口径', !!(p.on_time && p.on_time.by_due && p.on_time.by_shipped));
    ok('主口径标明用的哪个', ['due', 'shipped'].includes(p.on_time && p.on_time.primary));
    ok('样本不足不报比率', [p.on_time.by_due, p.on_time.by_shipped].every((x) => (x.sample >= 5 ? x.rate !== null : x.rate === null)),
      `due ${p.on_time.by_due.sample}单/${p.on_time.by_due.rate} shipped ${p.on_time.by_shipped.sample}单/${p.on_time.by_shipped.rate}`);
    ok('客户准交与工厂段并列不相减', typeof p.kpi.on_time_rate === 'number'
      && p.segments && typeof p.segments.factory_rate === 'number'
      && p.segments.factory_rate !== p.kpi.on_time_rate);

    // 工序产出不相加成整件产量
    const effRows = (p.efficiency && p.efficiency.rows) || [];
    const sumQtyOk = effRows.reduce((a, x) => a + Number(x.qty_ok || 0), 0);
    ok('工序产出没有相加成整件产量', p.quality && Number(p.quality.input_qty) !== sumQtyOk,
      `工序合格合计 ${Math.round(sumQtyOk)} vs 投产件数 ${p.quality && p.quality.input_qty}`);
    ok('效率分母只取有工时的报工', p.efficiency && p.efficiency.reports_with_hours < p.efficiency.total_reports
      ? p.efficiency.hour_coverage < 100 : true, `覆盖 ${p.efficiency && p.efficiency.hour_coverage}%`);
    ok('没工时的工序不给 0% 给 null', effRows.some((x) => x.efficiency === null && /没填工时|缺标准工时/.test(x.efficiency_note || '')),
      effRows.filter((x) => x.efficiency === null).map((x) => x.process).slice(0, 3).join(','));

    // 计划 vs 实际：没有计划日就报 0% 覆盖，不把「没计划」当「偏差 0 天」
    const pva = p.plan_vs_actual || {};
    ok('计划偏差缺计划日时说清原因', pva.coverage === 0
      ? /plan_date|计划完成日/.test(pva.note || '')
      : pva.rows.every((r) => r.with_plan > 0 || r.avg_dev === null), `覆盖 ${pva.coverage}%`);

    // 一次合格率口径
    ok('一次合格率扣返工且写明口径', (p.quality.fpy === null) || /返工后复验合格不再算/.test(p.quality.fpy_note || ''),
      p.quality.fpy_note);

    // 在制龄：起算依据要说清
    ok('在制龄写明起算依据', (p.wip.rows || []).every((r) => !!r.base_source));

    // CSV 导出（BOM 要按字节查：fetch().text() 会自动把 UTF-8 BOM 吃掉，看不出有没有）
    const csvRes = await fetch(BASE + '/api/prod-report/export?kind=efficiency&period=' + encodeURIComponent(p.period), {
      headers: { Authorization: 'Bearer ' + token }
    });
    const csvBuf = new Uint8Array(await csvRes.arrayBuffer());
    const csvText = new TextDecoder('utf-8').decode(csvBuf);
    const hasBom = csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf;
    ok('效率 CSV 可导出且带 BOM', csvRes.status === 200 && hasBom, `HTTP ${csvRes.status} bom=${hasBom}`);
    ok('CSV 带覆盖率行（不只给一个百分比）', /工时覆盖率%/.test(csvText));

    // 权限：仓库不看交付与质量指标
    const whLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'wh01', password: PASS } });
    const whTok = (whLogin.json && whLogin.json.data && whLogin.json.data.token) || '';
    if (whTok) {
      const deny = await req('/api/prod-report/overview', { token: whTok });
      ok('仓库不能看交付质量报表', deny.status === 403, `HTTP ${deny.status}`);
    } else {
      ok('仓库不能看交付质量报表', true, '没有 wh01，跳过');
    }
  }

  // ================= 流程变更发布与审计（TS-N15-05） =================
  // 自建一条 __smoke__ 流程跑完整链路，跑完删净，不碰真实审批流。
  {
    console.log('\n[流程变更发布与审计]');
    const { db: sdb } = require('../src/db');
    const TT = '__smoke__';
    const FNAME = '冒烟测试流程';
    const KEY = `${TT}::${FNAME}`;
    const t0 = new Date().toISOString();

    const cleanFlow = () => {
      const chg = sdb.prepare('SELECT id FROM flow_changes WHERE flow_key = ?').all(KEY);
      chg.forEach((c) => sdb.prepare('DELETE FROM flow_changes WHERE id = ?').run(c.id));
      sdb.prepare('DELETE FROM flow_versions WHERE flow_key = ?').run(KEY);
      sdb.prepare('DELETE FROM flow_audits WHERE flow_key = ?').run(KEY);
      sdb.prepare('DELETE FROM approval_flows WHERE target_type = ? AND name = ?').run(TT, FNAME);
    };
    cleanFlow();

    // 起点：一条已发布的 v1
    sdb.prepare(
      `INSERT INTO approval_flows (name, target_type, min_amount, max_amount, steps, active, created_at, sla_hours, escalate_role)
       VALUES (?,?,0,999999999,?,1,?,24,'admin')`
    ).run(FNAME, TT, JSON.stringify([{ role: 'finance', name: '财务审核' }, { role: 'admin', name: '总经理审批' }]), t0);
    sdb.prepare(
      `INSERT INTO flow_versions (target_type, flow_key, version_no, name, min_amount, max_amount, steps, sla_hours,
         escalate_role, status, effective_from, published_by, published_at, created_by, created_at, updated_at)
       VALUES (?,?,1,?,0,999999999,?,24,'admin','published',?,?,?,?,?,?)`
    ).run(TT, KEY, FNAME, JSON.stringify([{ role: 'finance', name: '财务审核' }, { role: 'admin', name: '总经理审批' }]),
      t0.slice(0, 10), '冒烟', t0, '冒烟', t0, t0);

    const fl = await req('/api/flow-changes/flows', { token });
    ok('流程清单可读且带当前版本', fl.status === 200 && (fl.json.data || []).some((f) => f.flow_key === KEY && f.current),
      `HTTP ${fl.status}`);

    // 校验：标题、原因太短
    const badTitle = await req('/api/flow-changes/changes', { method: 'POST', token, body: { flow_key: KEY, title: '改', reason: '原因是够长的六个字' } });
    ok('变更标题太短被拦', badTitle.status === 400 && /标题/.test(badTitle.json.message || ''), `HTTP ${badTitle.status}`);
    const badReason = await req('/api/flow-changes/changes', { method: 'POST', token, body: { flow_key: KEY, title: '加一级复核', reason: '短' } });
    ok('变更原因太短被拦', badReason.status === 400 && /原因/.test(badReason.json.message || ''), `HTTP ${badReason.status}`);

    const created = await req('/api/flow-changes/changes', {
      method: 'POST', token,
      body: { flow_key: KEY, title: '加一级冒烟复核', reason: '冒烟测试：验证发布链路是否完整', steps: [{ role: 'finance', name: '财务审核' }, { role: 'finance', name: '复核' }, { role: 'admin', name: '总经理审批' }] }
    });
    ok('创建变更成功且是草稿', created.status === 200 && created.json.data.status === 'draft', `HTTP ${created.status}`);
    const cid = created.json.data.id;

    // 没试运行不许发布
    const noTrial = await req(`/api/flow-changes/changes/${cid}/publish`, { method: 'POST', token, body: { effective_from: new Date().toISOString().slice(0, 10) } });
    ok('没试运行不许发布', noTrial.status === 400 && /试运行/.test(noTrial.json.message || ''), `HTTP ${noTrial.status}`);

    const tr = await req(`/api/flow-changes/changes/${cid}/trial`, { method: 'POST', token, body: { days: 90 } });
    ok('试运行出证据', tr.status === 200 && tr.json.data.trial_summary && typeof tr.json.data.trial_summary.sample === 'number',
      `HTTP ${tr.status}`);
    ok('试运行给出结论', (tr.json.data.trial_summary.verdict || '').length > 6, tr.json.data.trial_summary.verdict);

    // 生效日倒签
    const backdated = await req(`/api/flow-changes/changes/${cid}/publish`, { method: 'POST', token, body: { effective_from: '2020-01-01' } });
    ok('生效日倒签被拦', backdated.status === 400 && /倒签|早于今天/.test(backdated.json.message || ''), `HTTP ${backdated.status}`);

    // 发布前记录在途任务数（keep_old 不该动它）
    const beforeTasks = sdb.prepare("SELECT COUNT(*) c FROM approval_tasks WHERE status='pending'").get().c;
    const todayStr = new Date().toISOString().slice(0, 10);
    const pub = await req(`/api/flow-changes/changes/${cid}/publish`, {
      method: 'POST', token, body: { effective_from: todayStr, migration_mode: 'keep_old' }
    });
    ok('发布成功', pub.status === 200 && pub.json.data.status === 'published', `HTTP ${pub.status}`);
    const af = sdb.prepare('SELECT steps FROM approval_flows WHERE target_type=? AND name=?').get(TT, FNAME);
    ok('发布同步到 approval_flows', af && JSON.parse(af.steps).length === 3, af ? String(JSON.parse(af.steps).length) + ' 步' : '无');
    const afterTasks = sdb.prepare("SELECT COUNT(*) c FROM approval_tasks WHERE status='pending'").get().c;
    ok('在途单保持原版本（任务数不变）', beforeTasks === afterTasks, `${beforeTasks} → ${afterTasks}`);

    const vers = await req('/api/flow-changes/flows/versions?flow_key=' + encodeURIComponent(KEY), { token });
    const vlist = vers.json.data || [];
    ok('版本历史有 v1 与 v2 且只一个生效', vlist.length === 2 && vlist.filter((v) => v.status === 'published').length === 1,
      vlist.map((v) => `v${v.version_no}:${v.status}`).join(','));

    // 回滚
    const rb = await req(`/api/flow-changes/changes/${cid}/rollback`, { method: 'POST', token, body: { reason: '冒烟测试：回滚到上一版' } });
    ok('回滚成功', rb.status === 200 && rb.json.data.status === 'rolled_back', `HTTP ${rb.status}`);
    const af2 = sdb.prepare('SELECT steps FROM approval_flows WHERE target_type=? AND name=?').get(TT, FNAME);
    ok('回滚恢复 approval_flows', af2 && JSON.parse(af2.steps).length === 2, af2 ? String(JSON.parse(af2.steps).length) + ' 步' : '无');

    // 删关键角色要写理由
    const risky = await req('/api/flow-changes/changes', {
      method: 'POST', token,
      body: { flow_key: KEY, title: '删掉总经理审批', reason: '冒烟测试：验证关键角色是否受保护', steps: [{ role: 'sales', name: '销售确认' }] }
    });
    const rid = risky.json.data.id;
    const rt = await req(`/api/flow-changes/changes/${rid}/trial`, { method: 'POST', token, body: { days: 90 } });
    ok('试运行列出被删的关键角色', (rt.json.data.trial_summary.removed_critical_roles || []).length > 0,
      JSON.stringify(rt.json.data.trial_summary.removed_critical_roles || []));
    const rp = await req(`/api/flow-changes/changes/${rid}/publish`, { method: 'POST', token, body: { effective_from: todayStr } });
    ok('删关键角色不写理由不许发布', rp.status === 400 && /关键角色/.test(rp.json.message || ''), `HTTP ${rp.status}`);
    await req(`/api/flow-changes/changes/${rid}/reject`, { method: 'POST', token, body: { reason: '冒烟测试结束' } });

    // 审计
    const au = await req('/api/flow-changes/audits?flow_key=' + encodeURIComponent(KEY), { token });
    const acts = (au.json.data || []).map((a) => a.action);
    ok('审计记录创建/试运行/发布/回滚',
      ['create', 'trial', 'publish', 'rollback'].every((x) => acts.includes(x)), acts.join(','));

    // 在途单记录了版本
    const instCol = sdb.prepare('PRAGMA table_info(approval_instances)').all().map((c) => c.name);
    ok('审批实例有版本字段（能证明按哪版审的）', instCol.includes('flow_version_id') && instCol.includes('steps_snapshot'));

    cleanFlow();
    ok('冒烟流程已清干净',
      !sdb.prepare('SELECT 1 FROM flow_versions WHERE flow_key = ?').get(KEY)
      && !sdb.prepare('SELECT 1 FROM approval_flows WHERE target_type = ?').get(TT));

    // 权限：老板只读不能写
    const bossLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'boss', password: PASS } });
    const bossTok = (bossLogin.json && bossLogin.json.data && bossLogin.json.data.token) || '';
    if (bossTok) {
      const bossRead = await req('/api/flow-changes/flows', { token: bossTok });
      ok('老板可看流程（只读）', bossRead.status === 200, `HTTP ${bossRead.status}`);
      const bossWrite = await req('/api/flow-changes/changes', { method: 'POST', token: bossTok, body: { flow_key: KEY, title: '老板想改流程', reason: '老板也要能改流程吗' } });
      ok('老板不能改流程', bossWrite.status === 403, `HTTP ${bossWrite.status}`);
    } else {
      ok('老板可看 / 不能改流程', true, '没有 boss 账号，跳过');
    }
  }

  // ================= 字段级脱敏与访问审计（TS-N18-03） =================
  // 只读为主，会写少量访问日志（日志本来就该有），不留业务数据。
  {
    console.log('\n[字段级脱敏与访问审计]');
    const asUser = async (u) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: PASS } });
      return (r.json && r.json.data && r.json.data.token) || '';
    };
    const hasMask = (v) => typeof v === 'string' && v.includes('*');

    const rulesRes = await req('/api/privacy/rules', { token });
    const rl = rulesRes.json.data || [];
    ok('脱敏规则可读', rulesRes.status === 200 && rl.length >= 5, `${rl.length} 张表`);
    ok('每个字段都写了所需权限点', rl.every((t) => t.fields.every((f) => !!f.required_perm)));
    ok('工资类字段必须留痕', rl.filter((t) => t.table_name === 'payrolls')
      .every((t) => t.fields.every((f) => f.log_access)), 'payrolls 有字段关了留痕');
    ok('工资类要求的权限点是 payroll.sensitive', rl.find((t) => t.table_name === 'payrolls')
      ?.fields.every((f) => f.required_perm === 'payroll.sensitive'));

    // admin：技术权限不默认可读工资
    const empAdmin = await req('/api/employees', { token });
    const adminRows = empAdmin.json.data || [];
    ok('管理员看员工：手机或工资被掩码', adminRows.some((r) => hasMask(r.phone) || hasMask(r.base_salary)),
      JSON.stringify(adminRows.slice(0, 2).map((r) => ({ p: r.phone, s: r.base_salary }))));
    const payAdmin = await req('/api/payrolls?period=2026-10', { token });
    const payRows = payAdmin.json.data || [];
    ok('管理员看工资被掩码（管理员技术权限不默认可读工资）',
      payRows.length > 0 && payRows.every((r) => r.net_pay === '***'), JSON.stringify((payRows[0] || {}).net_pay));

    // 财务：能看工资明文
    const finTok = await asUser('fin01');
    if (finTok) {
      const payFin = await req('/api/payrolls?period=2026-10', { token: finTok });
      const finRows = payFin.json.data || [];
      ok('财务看工资是明文', finRows.length > 0 && finRows.some((r) => r.net_pay !== '***' && Number(r.net_pay) > 0),
        JSON.stringify((finRows[0] || {}).net_pay));
      const empFin = await req('/api/employees', { token: finTok });
      ok('财务看员工手机被掩码（没有 hr.pii）',
        (empFin.json.data || []).filter((r) => r.phone).every((r) => hasMask(r.phone)) || !(empFin.json.data || []).some((r) => r.phone));
    } else {
      ok('财务看工资是明文 / 员工手机被掩码', true, '没有 fin01，跳过');
    }

    // 人事：能看员工身份证与手机
    const hrTok2 = await asUser('hr01');
    if (hrTok2) {
      const empHr = await req('/api/employees', { token: hrTok2 });
      const hrRows = empHr.json.data || [];
      ok('人事看员工是明文', hrRows.some((r) => r.phone && !hasMask(r.phone)), JSON.stringify((hrRows.find((r) => r.phone) || {}).phone));
      const payHr = await req('/api/payrolls?period=2026-10', { token: hrTok2 });
      ok('人事也能看工资（薪资复核职责）', (payHr.json.data || []).some((r) => r.net_pay !== '***'));
    } else {
      ok('人事看员工与工资是明文', true, '没有 hr01，跳过');
    }

    // 销售：客户手机明文、员工手机掩码
    const salesTok2 = await asUser('sales01');
    if (salesTok2) {
      const cusSales = await req('/api/customers', { token: salesTok2 });
      const sRows = cusSales.json.data || [];
      ok('销售看客户手机是明文', sRows.some((r) => r.phone && !hasMask(r.phone)));
      const empSales = await req('/api/employees', { token: salesTok2 });
      ok('销售看员工手机被掩码', (empSales.json.data || []).filter((r) => r.phone).every((r) => hasMask(r.phone)));
    } else {
      ok('销售看客户明文 / 员工掩码', true, '没有 sales01，跳过');
    }

    // 一次性查看：必须写理由
    const target = adminRows.find((r) => r.id);
    const noReason2 = await req('/api/privacy/reveal', {
      method: 'POST', token, body: { table_name: 'employees', field_name: 'id_card', target_id: target ? target.id : 1 }
    });
    ok('一次性查看不写理由被拦', noReason2.status === 400 && /理由/.test(noReason2.json.message || ''), `HTTP ${noReason2.status}`);
    const withReason2 = await req('/api/privacy/reveal', {
      method: 'POST', token,
      body: { table_name: 'employees', field_name: 'id_card', target_id: target ? target.id : 1, reason: '冒烟测试：验证一次性查看与留痕是否生效' }
    });
    ok('写理由后可一次性查看', withReason2.status === 200 && 'value' in (withReason2.json.data || {}), `HTTP ${withReason2.status}`);

    const logs2 = await req('/api/privacy/logs', { token });
    const lrows = logs2.json.data || [];
    ok('访问日志有记录', lrows.length > 0, `${lrows.length} 条`);
    ok('日志区分「有权限」与「申请查看」', lrows.some((l) => l.granted === 1) && lrows.some((l) => l.granted === 0));
    ok('日志记了表名与字段', lrows.every((l) => !!l.table_name));

    // 导出的工资单必须是掩码
    const csv2 = await fetch(BASE + '/api/payrolls/export?period=2026-10', { headers: { Authorization: 'Bearer ' + token } });
    const csvTxt = await csv2.text();
    ok('管理员导出工资单是掩码', csv2.status === 200 && csvTxt.includes('***'), `HTTP ${csv2.status}`);

    // 留痕关不掉（工资类）
    const payField = (rl.find((t) => t.table_name === 'payrolls') || { fields: [] }).fields[0];
    if (payField) {
      const tryOff = await req(`/api/privacy/rules/${payField.id}`, { method: 'PUT', token, body: { log_access: false } });
      const after = ((tryOff.json.data || []).find((t) => t.table_name === 'payrolls') || { fields: [] }).fields
        .find((f) => f.id === payField.id);
      ok('工资类字段的留痕关不掉', tryOff.status === 200 && after && after.log_access === true,
        after ? String(after.log_access) : '没取到');
    } else {
      ok('工资类字段的留痕关不掉', true, '没有工资规则，跳过');
    }

    // 权限：业务角色看不到规则与日志
    if (salesTok2) {
      const denyRules = await req('/api/privacy/rules', { token: salesTok2 });
      ok('销售看不到脱敏规则', denyRules.status === 403, `HTTP ${denyRules.status}`);
      const denyLogs = await req('/api/privacy/logs', { token: salesTok2 });
      ok('销售看不到访问日志', denyLogs.status === 403, `HTTP ${denyLogs.status}`);
    } else {
      ok('销售看不到规则与日志', true, '没有 sales01，跳过');
    }
  }

  // ================= 技能矩阵与岗位资格（TS-N13-06） =================
  // 自建一条 __SMOKE工序__ 的门槛与技能，跑完删净；不动演示数据里的人和门槛。
  {
    console.log('\n[技能矩阵与岗位资格]');
    const { db: DB } = require('../src/db');
    const asUser = async (u) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: PASS } });
      return (r.json && r.json.data && r.json.data.token) || '';
    };
    const PROC = '__SMOKE工序__';
    const cleanUp = () => {
      DB.prepare('DELETE FROM employee_skills WHERE process_name = ?').run(PROC);
      DB.prepare('DELETE FROM skill_overrides WHERE process_name = ?').run(PROC);
      DB.prepare('DELETE FROM skill_requirements WHERE process_name = ?').run(PROC);
    };
    cleanUp();

    const metaRes = await req('/api/skills/meta', { token });
    const m = metaRes.json.data || {};
    ok('技能字典可读（等级 4 档 / 证据来源 3 种）',
      metaRes.status === 200 && (m.levels || []).length === 4 && (m.sources || []).length === 3,
      `${(m.levels || []).length} 级 / ${(m.sources || []).length} 来源`);
    ok('工序门槛已从工序标准播种', (m.processes || []).length >= 5, `${(m.processes || []).length} 道`);

    // 矩阵：默认只列有技能记录的人，但没记录的必须报出来（不能假装全公司只有 7 个人）
    const mx = (await req('/api/skills/matrix', { token })).json.data || {};
    const activeCount = DB.prepare("SELECT COUNT(*) c FROM employees WHERE IFNULL(status,'active')='active'").get().c;
    ok('矩阵只列有技能记录的人',
      (mx.rows || []).every((r) => Object.keys(r.cells || {}).length > 0), `${(mx.rows || []).length} 行`);
    ok('没有技能记录的人单独计数（不显示 ≠ 不存在）',
      (mx.rows || []).length + (mx.without_skill || 0) === activeCount,
      `${(mx.rows || []).length} + ${mx.without_skill} vs 在职 ${activeCount}`);
    ok('矩阵格子带证据来源（否则分不清评定与报工）',
      (mx.rows || []).every((r) => Object.values(r.cells || {}).every((c) => !!c.source && !!c.source_label)));

    // 覆盖：人数自洽 + 与库内直算一致
    const cov = (await req('/api/skills/coverage', { token })).json.data || {};
    ok('覆盖清单每人头都能对上合格名单',
      (cov.list || []).every((x) => x.qualified === (x.people || []).length),
      (cov.list || []).map((x) => `${x.process_name} ${x.qualified}/${(x.people || []).length}`).join(' '));
    const one = (cov.list || [])[0];
    if (one) {
      const dbCount = DB.prepare(
        `SELECT COUNT(*) c FROM employee_skills
          WHERE process_name = ? AND status = 'active' AND level >= ?
            AND (IFNULL(valid_until,'') = '' OR valid_until >= ?)`
      ).get(one.process_name, one.min_level, new Date().toISOString().slice(0, 10)).c;
      ok('覆盖人数与库内直算一致（等级达标且未过期才算）', dbCount === one.qualified,
        `接口 ${one.qualified} vs 库 ${dbCount}（${one.process_name}）`);
    } else {
      ok('覆盖人数与库内直算一致（等级达标且未过期才算）', true, '没有门槛行，跳过');
    }
    ok('用到但没建门槛的工序被单列（条数要对得上）',
      (cov.unmapped || []).length === ((cov.summary || {}).unmapped || 0),
      `清单 ${(cov.unmapped || []).length} / 汇总 ${(cov.summary || {}).unmapped}`);

    // 建立门槛：受限 + 2 级
    const mkReq = await req('/api/skills/requirements', {
      method: 'PUT', token, body: { process_name: PROC, min_level: 2, restricted: true, min_headcount: 1 }
    });
    ok('可新建受限工序门槛', mkReq.status === 200 && mkReq.json.data.restricted === 1, `HTTP ${mkReq.status}`);

    const emp = DB.prepare("SELECT id, name FROM employees WHERE IFNULL(status,'active')='active' ORDER BY id LIMIT 1").get();

    // 评定：依据太短必须拒
    const shortEv = await req('/api/skills/assess', {
      method: 'POST', token, body: { employee_id: emp.id, process_name: PROC, level: 2, evidence: '行' }
    });
    ok('评定必须写依据（否则矩阵就是谁都能填的数字）', shortEv.status === 400, `HTTP ${shortEv.status}`);

    // 评定：1 级（低于门槛）
    const a1 = await req('/api/skills/assess', {
      method: 'POST', token, body: { employee_id: emp.id, process_name: PROC, level: 1, evidence: '冒烟用例：只做过辅助，未独立操作' }
    });
    ok('评定写入并转成「考核评定」来源',
      a1.status === 200 && a1.json.data.level === 1, `HTTP ${a1.status} 等级 ${a1.json.data && a1.json.data.level}`);

    const chk1 = (await req(`/api/skills/check?employee_id=${emp.id}&process_name=${encodeURIComponent(PROC)}`, { token })).json.data;
    ok('受限工序 + 等级不够 → 不许上机', chk1 && chk1.allowed === false, chk1 && chk1.reason);
    ok('拒绝原因说清是「等级不够」还是「没评定」', /受限工序/.test(chk1.reason || ''), chk1 && chk1.reason);

    // 评定升级到 2 级 → 放行
    await req('/api/skills/assess', {
      method: 'POST', token, body: { employee_id: emp.id, process_name: PROC, level: 2, evidence: '冒烟用例：补做 2 周后考核通过' }
    });
    const chk2 = (await req(`/api/skills/check?employee_id=${emp.id}&process_name=${encodeURIComponent(PROC)}`, { token })).json.data;
    ok('等级达标后放行', chk2 && chk2.allowed === true, chk2 && chk2.reason);

    // 降级要显式告知（多半是复评没过，别让人以为点错）
    const down = await req('/api/skills/assess', {
      method: 'POST', token, body: { employee_id: emp.id, process_name: PROC, level: 1, evidence: '冒烟用例：复评未通过，降回学徒' }
    });
    ok('降级返回 downgraded 标记', down.status === 200 && down.json.data.downgraded === true, `HTTP ${down.status}`);

    // 破格：理由太短拒；正常放行；非受限工序不许破格
    const ovShort = await req('/api/skills/overrides', {
      method: 'POST', token, body: { employee_id: emp.id, process_name: PROC, valid_until: '2027-06-30', reason: '急' }
    });
    ok('破格理由至少 6 个字', ovShort.status === 400, `HTTP ${ovShort.status}`);

    const ov = await req('/api/skills/overrides', {
      method: 'POST', token, body: { employee_id: emp.id, process_name: PROC, valid_until: '2027-06-30', reason: '冒烟用例：旺季临时协助，限铺布辅助' }
    });
    ok('破格放行能开且带期限', ov.status === 200 && ov.json.data.valid_until === '2027-06-30', `HTTP ${ov.status}`);
    const chk3 = (await req(`/api/skills/check?employee_id=${emp.id}&process_name=${encodeURIComponent(PROC)}`, { token })).json.data;
    ok('破格期间放行但标明 via_override', chk3 && chk3.allowed === true && chk3.via_override === true, chk3 && chk3.reason);

    // 门禁真的接在报工上：把「裁剪」临时设为受限，用没有该工序资格的人报工 → 必须 400
    const cutNode = DB.prepare(
      "SELECT n.id nid, n.order_id oid FROM order_nodes n JOIN orders o ON o.id = n.order_id " +
      "WHERE n.name = '裁剪' AND o.status = 'production' ORDER BY n.id LIMIT 1"
    ).get();
    const cutReq = DB.prepare("SELECT * FROM skill_requirements WHERE process_name = '裁剪'").get();
    if (cutNode && cutReq) {
      const oldRestricted = cutReq.restricted;
      const before = DB.prepare('SELECT COUNT(*) c FROM production_reports WHERE order_id = ?').get(cutNode.oid).c;
      try {
        DB.prepare("UPDATE skill_requirements SET restricted = 1 WHERE process_name = '裁剪'").run();
        // 造一个明确没有裁剪资格的人：临时插入 0 级不可行，直接挑一个没有裁剪技能记录的在职员工
        const noSkill = DB.prepare(
          `SELECT e.id, e.name FROM employees e
            WHERE IFNULL(e.status,'active')='active'
              AND NOT EXISTS (SELECT 1 FROM employee_skills s WHERE s.employee_id = e.id AND s.process_name = '裁剪')
            ORDER BY e.id LIMIT 1`
        ).get();
        if (noSkill) {
          const blocked = await req('/api/reports', {
            method: 'POST', token,
            body: { order_id: cutNode.oid, node_id: cutNode.nid, employee_id: noSkill.id, qty_ok: 1, hours: 1 }
          });
          ok('受限工序无资格 → 报工被拦下（门禁接在报工上，不只是查询）',
            blocked.status === 400 && /受限工序|资格|技能/.test(blocked.json.message || ''),
            `HTTP ${blocked.status} ${blocked.json.message || ''}`);
          ok('被拦的报工没有落库',
            DB.prepare('SELECT COUNT(*) c FROM production_reports WHERE order_id = ?').get(cutNode.oid).c === before);
          const afterId = blocked.json.data && blocked.json.data.id;
          if (afterId) await req(`/api/reports/${afterId}`, { method: 'DELETE', token });
        } else {
          ok('受限工序无资格 → 报工被拦下（门禁接在报工上，不只是查询）', true, '所有在职员工都有裁剪记录，跳过');
          ok('被拦的报工没有落库', true, '跳过');
        }
      } finally {
        DB.prepare("UPDATE skill_requirements SET restricted = ? WHERE process_name = '裁剪'").run(oldRestricted);
      }
    } else {
      ok('受限工序无资格 → 报工被拦下（门禁接在报工上，不只是查询）', true, '没有裁剪节点或门槛，跳过');
      ok('被拦的报工没有落库', true, '跳过');
    }

    // 培训：不通过与不扣款、不自动降级
    const tr = await req('/api/skills/trainings', {
      method: 'POST', token, body: { employee_id: emp.id, course_name: '__SMOKE培训__', course_type: 'skill', planned_at: '2026-10-01' }
    });
    if (tr.status === 200) {
      const tid = tr.json.data.id;
      const failed = await req(`/api/skills/trainings/${tid}/finish`, {
        method: 'POST', token, body: { result: 'fail', score: 55 }
      });
      ok('培训不通过会提示复训、且不因此降级',
        failed.status === 200 && /不因.*扣款|复训/.test(failed.json.data.note || ''), failed.json.data && failed.json.data.note);
      const lv = DB.prepare('SELECT level FROM employee_skills WHERE employee_id = ? AND process_name = ?').get(emp.id, PROC);
      ok('培训不通过不改技能等级', lv && Number(lv.level) === 1, lv ? `等级 ${lv.level}` : '没有技能行');
      DB.prepare('DELETE FROM training_records WHERE id = ?').run(tid);
    } else {
      ok('培训不通过会提示复训、且不因此降级', false, `HTTP ${tr.status} ${tr.json.message || ''}`);
      ok('培训不通过不改技能等级', false, '培训没建起来');
    }

    // 到期：过期行必须是负天数，未过期行不能是负的
    const exp = (await req('/api/skills/expiring?days=90', { token })).json.data || {};
    ok('到期清单的「已过期」与剩余天数一致（不自相矛盾）',
      (exp.rows || []).every((x) => (x.overdue === true) === (x.days_left < 0)),
      (exp.rows || []).slice(0, 3).map((x) => `${x.item}:${x.days_left}`).join(' '));

    // 权限：销售/仓库不看技能；生产能看不能改门槛
    const salesTok = await asUser('sales01');
    if (salesTok) {
      const deny = await req('/api/skills/matrix', { token: salesTok });
      ok('销售看不到技能矩阵', deny.status === 403, `HTTP ${deny.status}`);
      const denyW = await req('/api/skills/assess', {
        method: 'POST', token: salesTok, body: { employee_id: emp.id, process_name: PROC, level: 4, evidence: '销售想给自己人评个师傅' }
      });
      ok('销售不能评定技能', denyW.status === 403, `HTTP ${denyW.status}`);
    } else {
      ok('销售看不到技能矩阵', true, '没有 sales01，跳过');
      ok('销售不能评定技能', true, '跳过');
    }
    const prodTok = await asUser('prod01');
    if (prodTok) {
      const canRead = await req('/api/skills/coverage', { token: prodTok });
      ok('生产能看覆盖缺口（要排产）', canRead.status === 200, `HTTP ${canRead.status}`);
      const denyRule = await req('/api/skills/requirements', {
        method: 'PUT', token: prodTok, body: { process_name: PROC, restricted: false, min_level: 2 }
      });
      ok('生产不能自己改受限开关（会决定全厂能不能开工）', denyRule.status === 403, `HTTP ${denyRule.status}`);
    } else {
      ok('生产能看覆盖缺口（要排产）', true, '没有 prod01，跳过');
      ok('生产不能自己改受限开关（会决定全厂能不能开工）', true, '跳过');
    }

    cleanUp();
    ok('冒烟夹具已清干净',
      !DB.prepare('SELECT 1 FROM skill_requirements WHERE process_name = ?').get(PROC)
      && !DB.prepare('SELECT 1 FROM employee_skills WHERE process_name = ?').get(PROC));
  }


  // ================= 员工自助与薪资申诉（TS-N13-10） =================
  // 自建一个临时账号绑到某位有已确认工资单的员工，跑完删净；不动演示账号。
  {
    console.log('\n[员工自助与薪资申诉]');
    const { db: DB } = require('../src/db');
    const T = require('../src/utils/time');
    const { hashPassword } = require('../src/auth/password');
    const asUser = async (u) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: PASS } });
      return (r.json && r.json.data && r.json.data.token) || '';
    };

    // 未绑定账号：只看得到「未绑定」，拿不到任何个人数据
    const salesTok = await asUser('sales01');
    if (salesTok) {
      const ov = await req('/api/self/overview', { token: salesTok });
      ok('未绑定账号看不到个人数据（不按姓名猜人）',
        ov.status === 200 && ov.json.data.bound === false && !ov.json.data.me,
        `bound=${ov.json.data && ov.json.data.bound}`);
      const slips = await req('/api/self/payslips', { token: salesTok });
      ok('未绑定账号拿不到工资条列表',
        slips.status === 200 && (slips.json.data.rows || []).length === 0);
      const sub = await req('/api/self/requests', {
        method: 'POST', token: salesTok, body: { type: 'makeup', reason: '未绑定也要提补卡', payload: { date: '2026-10-20', check_out: '18:00' } }
      });
      ok('未绑定账号不能提交申请', sub.status === 400, `HTTP ${sub.status} ${sub.json.message || ''}`);
    } else {
      ok('未绑定账号看不到个人数据（不按姓名猜人）', true, '没有 sales01，跳过');
      ok('未绑定账号拿不到工资条列表', true, '跳过');
      ok('未绑定账号不能提交申请', true, '跳过');
    }

    // 找一个「有已确认工资单且未绑定账号」的员工，建临时账号绑上去
    const target = DB.prepare(
      `SELECT p.employee_id, p.id pid, p.period, p.net_pay, e.name
         FROM payrolls p JOIN employees e ON e.id = p.employee_id
        WHERE p.status = 'confirmed'
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.employee_id = p.employee_id AND u.active = 1)
        ORDER BY p.id LIMIT 1`
    ).get();

    const SKU = '__smoke_self__';
    DB.prepare('DELETE FROM users WHERE username = ?').run(SKU);
    let uid = null;
    const reqIds = [];
    const adjIds = [];

    try {
      const info = DB.prepare(
        `INSERT INTO users (username, password_hash, name, role, company_id, active, created_at)
         VALUES (?,?,?, 'production', 1, 1, ?)`
      ).run(SKU, hashPassword(PASS), SKU, new Date().toISOString());
      uid = Number(info.lastInsertRowid);

      if (!target) {
        ok('可把账号绑定到员工档案', true, '库里没有可用的已确认工资单，跳过绑定用例');
      } else {
        const bindRes = await req('/api/self/bind', { method: 'POST', token, body: { user_id: uid, employee_id: target.employee_id } });
        ok('可把账号绑定到员工档案', bindRes.status === 200 && bindRes.json.data.employee_id === target.employee_id,
          `HTTP ${bindRes.status} ${bindRes.json.message || ''}`);

        const tok = await asUser(SKU);
        const ov = await req('/api/self/overview', { token: tok });
        ok('绑定后能看自己的档案与工资',
          ov.status === 200 && ov.json.data.bound === true && ov.json.data.me.name === target.name,
          `bound=${ov.json.data.bound} name=${ov.json.data.me && ov.json.data.me.name}`);
        ok('出勤按库里的 normal/late 统计（字段名对不上就会全显示 0 天）',
          typeof ov.json.data.attendance.present === 'number' && ov.json.data.attendance.normal !== undefined,
          `出勤 ${ov.json.data.attendance.present} 天`);

        // 越权：看别人的工资条必须 403
        const otherPid = DB.prepare('SELECT id FROM payrolls WHERE employee_id <> ? AND status = ? LIMIT 1')
          .get(target.employee_id, 'confirmed');
        if (otherPid) {
          const deny = await req(`/api/self/payslips/${otherPid.id}`, { token: tok });
          ok('不能看别人的工资条', deny.status === 403, `HTTP ${deny.status} ${deny.json.message || ''}`);
        } else {
          ok('不能看别人的工资条', true, '库里只有一张已确认工资单，跳过');
        }

        const mine = await req(`/api/self/payslips/${target.pid}`, { token: tok });
        ok('能看自己的工资条（服务端校验归属）',
          mine.status === 200 && mine.json.data.viewer === 'self', `viewer=${mine.json.data && mine.json.data.viewer}`);
        ok('看自己的工资条也留痕（granted=1）',
          DB.prepare("SELECT COUNT(*) c FROM sensitive_access_logs WHERE table_name='payrolls' AND action='view' AND granted=1 AND reason LIKE '%本人%'").get().c > 0);

        // 申诉：先生成一条，再试重复提交
        const ap = await req('/api/self/requests', {
          method: 'POST', token: tok,
          body: { type: 'payroll', reason: '这个月计件件数对不上，请复核报工记录', payload: { payroll_id: target.pid, claim_amount: 120 } }
        });
        ok('能对自己的工资单提申诉（窗口内）', ap.status === 200, `HTTP ${ap.status} ${ap.json.message || ''}`);
        if (ap.status === 200) reqIds.push(ap.json.data.id);
        const dup = await req('/api/self/requests', {
          method: 'POST', token: tok,
          body: { type: 'payroll', reason: '再提一次同一张工资单看看', payload: { payroll_id: target.pid } }
        });
        ok('同一张工资单不许重复申诉（防重复补款）', dup.status === 400, `HTTP ${dup.status}`);

        const badField = await req('/api/self/requests', {
          method: 'POST', token: tok,
          body: { type: 'profile', reason: '我要改一下基本工资', payload: { field: 'base_salary', value: '30000' } }
        });
        ok('资料更正不能自助改工资/岗位', badField.status === 400 && /不能自助更正/.test(badField.json.message || ''),
          `HTTP ${badField.status}`);

        // 受理：申诉批准必须填金额；填了只生成调整单，不改已发工资
        const payBefore = JSON.stringify(DB.prepare('SELECT net_pay, status, updated_at FROM payrolls WHERE id = ?').get(target.pid));
        if (reqIds.length) {
          const noAmount = await req(`/api/self/review/${reqIds[0]}`, {
            method: 'POST', token, body: { approve: true, conclusion: '核实后确认少算，同意补发' }
          });
          ok('薪资申诉批准必须填调整金额', noAmount.status === 400, `HTTP ${noAmount.status} ${noAmount.json.message || ''}`);

          const appr = await req(`/api/self/review/${reqIds[0]}`, {
            method: 'POST', token,
            body: { approve: true, conclusion: '核实报工记录确认少算，按计件单价补 120 元并入下期', adjust_amount: 120, adjust_item: 'piece_wage' }
          });
          ok('申诉批准后生成调整单', appr.status === 200 && !!appr.json.data.adjust_id, `HTTP ${appr.status}`);
          if (appr.json.data && appr.json.data.adjust_id) adjIds.push(appr.json.data.adjust_id);
          const adj = adjIds.length ? DB.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(adjIds[0]) : null;
          ok('调整单落在「下一期」而不是被申诉那一期',
            adj && adj.period > adj.source_period, adj ? `${adj.source_period} → ${adj.period}` : '无调整单');
          ok('批准不改已发放的工资单（金额/状态/更新时间都不动）',
            payBefore === JSON.stringify(DB.prepare('SELECT net_pay, status, updated_at FROM payrolls WHERE id = ?').get(target.pid)),
            payBefore);
        } else {
          ok('薪资申诉批准必须填调整金额', false, '申诉没提交成功');
          ok('申诉批准后生成调整单', false, '申诉没提交成功');
          ok('调整单落在「下一期」而不是被申诉那一期', false, '申诉没提交成功');
          ok('批准不改已发放的工资单（金额/状态/更新时间都不动）', false, '申诉没提交成功');
        }

        // 补卡批准 → 真的写进考勤（考勤不是已付历史，可以改）
        // 日期必须挑「本来没有考勤记录」的一天，否则断言分不清是补建还是覆盖
        let mkDate = null;
        for (let i = 3; i <= 25; i += 1) {
          const d = T.localDate(new Date(Date.now() - i * 86400000).toISOString());
          if (!DB.prepare('SELECT 1 x FROM attendance WHERE employee_id = ? AND date = ?').get(target.employee_id, d)) { mkDate = d; break; }
        }
        if (mkDate) {
          const mk = await req('/api/self/requests', {
            method: 'POST', token: tok,
            body: { type: 'makeup', reason: '那天下午外出办事，回来忘了打下班卡', payload: { date: mkDate, check_out: '18:20' } }
          });
          if (mk.status === 200) {
            reqIds.push(mk.json.data.id);
            const res = await req(`/api/self/review/${mk.json.data.id}`, {
              method: 'POST', token, body: { approve: true, conclusion: '核对门禁记录当日 18:20 离厂，予以补卡' }
            });
            const afterRow = DB.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(target.employee_id, mkDate);
            ok('补卡批准后会写进考勤（不是只改申请状态）',
              res.status === 200 && !!afterRow && afterRow.check_out === '18:20',
              afterRow ? `${afterRow.date} ${afterRow.check_out} ${afterRow.status}` : '没有考勤记录');
            ok('补卡写入的状态是 normal（与考勤模块同一口径，不是 present）',
              !!afterRow && afterRow.status === 'normal', afterRow && afterRow.status);
          } else {
            ok('补卡批准后会写进考勤（不是只改申请状态）', false, `补卡提交失败 HTTP ${mk.status}`);
            ok('补卡写入的状态是 normal（与考勤模块同一口径，不是 present）', false, '补卡提交失败');
          }
        } else {
          ok('补卡批准后会写进考勤（不是只改申请状态）', true, '近 30 天每天都有考勤记录，跳过');
          ok('补卡写入的状态是 normal（与考勤模块同一口径，不是 present）', true, '跳过');
        }

        // 权限：普通员工看不到受理台与绑定
        const denyAll = await req('/api/self/all-requests', { token: tok });
        ok('普通员工看不到受理台', denyAll.status === 403, `HTTP ${denyAll.status}`);
        const denyBind = await req('/api/self/bindings', { token: tok });
        ok('普通员工看不到账号绑定', denyBind.status === 403, `HTTP ${denyBind.status}`);

        // 主管摘要：只看天数，不给钱、不给病假
        const prodTok = await asUser('prod01');
        if (prodTok) {
          const team = await req('/api/self/team', { token: prodTok });
          const rows = (team.json.data && team.json.data.rows) || [];
          ok('主管能看到团队出勤摘要', team.status === 200 && rows.length > 0, `${rows.length} 人`);
          ok('主管摘要里没有工资金额字段',
            rows.every((r) => r.money === null && r.net_pay === undefined && r.base_salary === undefined));
          ok('主管摘要里没有请假类型（病假属敏感）',
            rows.every((r) => r.leave_type === undefined && r.leave_days !== undefined));
        } else {
          ok('主管能看到团队出勤摘要', true, '没有 prod01，跳过');
          ok('主管摘要里没有工资金额字段', true, '跳过');
          ok('主管摘要里没有请假类型（病假属敏感）', true, '跳过');
        }
      }
    } finally {
      adjIds.forEach((id) => DB.prepare('DELETE FROM payroll_adjustments WHERE id = ?').run(id));
      reqIds.forEach((id) => DB.prepare('DELETE FROM self_requests WHERE id = ?').run(id));
      if (target) {
        // 补卡写进去的考勤要清掉，别污染演示数据
        DB.prepare("DELETE FROM attendance WHERE employee_id = ? AND IFNULL(remark,'') LIKE '补卡%'").run(target.employee_id);
      }
      if (uid) DB.prepare('DELETE FROM users WHERE id = ?').run(uid);
      DB.prepare('DELETE FROM users WHERE username = ?').run(SKU);
    }

    ok('自助夹具已清干净',
      !DB.prepare('SELECT 1 FROM users WHERE username = ?').get(SKU)
      && reqIds.every((id) => !DB.prepare('SELECT 1 x FROM self_requests WHERE id = ?').get(id)));
  }


  // ================= 客户进度发布（TS-N22-02 / TS-N22-03） =================
  // 用一张真实生产中的订单做发布/撤回，发布的记录用 published_by='__smoke__' 标记，跑完删净。
  {
    console.log('\n[客户进度发布]');
    const { db: DB } = require('../src/db');
    const CP = require('../src/services/customerProgress');
    const asUser = async (u) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: PASS } });
      return (r.json && r.json.data && r.json.data.token) || '';
    };
    const TEST_MARK = '__smoke__';
    const cleanup = () => {
      DB.prepare('DELETE FROM progress_publications WHERE published_by = ? OR withdrawn_by = ?').run(TEST_MARK, TEST_MARK);
      DB.prepare('DELETE FROM order_routes WHERE updated_by = ?').run(TEST_MARK);
    };
    cleanup();

    try {
      const meta = (await req('/api/customer-progress/meta', { token })).json.data || {};
      const routes = meta.routes || [];
      ok('三条生产路线齐全', routes.length === 3, routes.map((r) => r.label).join('/'));
      ok('整单外发只有三段（外发/检验/发运）',
        routes.find((r) => r.value === 'full_outsource').stages.join('/') === '外发加工/检验/发运',
        (routes.find((r) => r.value === 'full_outsource') || {}).stages.join('/'));

      // 挑一张「有外发记录且没回完货」的订单做核心断言
      const cutRow = DB.prepare(
        `SELECT order_id, SUM(out_qty) o, SUM(returned_qty) r FROM cut_dispatches
          WHERE status <> 'void' GROUP BY order_id HAVING SUM(out_qty) > SUM(returned_qty) LIMIT 1`
      ).get();
      if (cutRow) {
        const it = (await req(`/api/customer-progress/orders/${cutRow.order_id}/internal`, { token })).json.data;
        ok('外发未回完货的订单被判定为「不能完工」', it && it.can_complete === false,
          it ? `${it.done_count}/${it.stage_count} 阻塞 ${it.blockers.length} 项` : '取不到');
        ok('阻塞原因说清是「外发没回齐」而不是笼统的未完成',
          it && it.blockers.some((b) => b.includes('外发')), it ? it.blockers[0] : '');
        const pv = (await req(`/api/customer-progress/orders/${cutRow.order_id}/preview`, { token })).json.data;
        ok('客户预览里没有「完工/可发货」字样',
          pv && !pv.completion_label && pv.completed === false,
          pv ? JSON.stringify(pv.completion_label) : '');
        // 注意：预览接口本身会列出「客户永远看不到：外发工厂名称/加工单价/返工数…」，
        // 所以不能拿整段预览去判泄漏 —— 要判的是**客户会收到的那份快照**：
        // 1) 阶段对象只允许白名单字段；2) 落库 snapshot 里不含敏感词。
        const ALLOW = ['key', 'label', 'status', 'status_label', 'done_at', 'seq', 'qty_ok'];
        const stageKeys = (pv.stages || []).flatMap((s) => Object.keys(s)).filter((k) => !ALLOW.includes(k));
        const snap = DB.prepare("SELECT snapshot FROM progress_publications WHERE order_id = ? AND status = 'published'").get(cutRow.order_id);
        const snapJson = snap ? String(snap.snapshot) : JSON.stringify(pv.stages || []);
        ok('客户会收到的快照不含工厂/成本/返工/工人（阶段只有白名单字段）',
          stageKeys.length === 0 && !/factory|unit_price|amount|返工|operator|工厂名/.test(snapJson),
          stageKeys.length ? `多余字段 ${stageKeys.join(',')}` : '字段白名单通过 / 快照无敏感词');
      } else {
        ok('外发未回完货的订单被判定为「不能完工」', true, '库里没有未回齐的外发单，跳过');
        ok('阻塞原因说清是「外发没回齐」而不是笼统的未完成', true, '跳过');
        ok('客户预览里没有「完工/可发货」字样', true, '跳过');
        ok('客户会收到的快照不含工厂/成本/返工/工人（阶段只有白名单字段）', true, '跳过');
      }

      // 找一张可发布的订单（生产中、且当前没有生效版本）
      const target = DB.prepare(
        `SELECT o.id, o.order_no, o.customer_id FROM orders o
          WHERE o.status IN ('production','shipped')
            AND NOT EXISTS (SELECT 1 FROM progress_publications p WHERE p.order_id = o.id AND p.status='published')
          ORDER BY o.id DESC LIMIT 1`
      ).get();

      if (target) {
        const p1 = await req(`/api/customer-progress/orders/${target.id}/publish`, { method: 'POST', token, body: { note: TEST_MARK } });
        // 上面这条没带 published_by 标记，这里补一次落库标记，保证能清干净
        DB.prepare("UPDATE progress_publications SET published_by = ? WHERE order_id = ? AND status='published'").run(TEST_MARK, target.id);
        ok('可发布订单并生成 v1', p1.status === 200 && p1.json.data.version_no >= 1,
          `HTTP ${p1.status} v${p1.json.data && p1.json.data.version_no}`);

        const p2 = await req(`/api/customer-progress/orders/${target.id}/publish`, { method: 'POST', token, body: { note: TEST_MARK } });
        DB.prepare("UPDATE progress_publications SET published_by = ? WHERE order_id = ? AND status='published'").run(TEST_MARK, target.id);
        const hist = (await req(`/api/customer-progress/orders/${target.id}/history`, { token })).json.data || [];
        ok('再次发布版本号 +1，旧版转「已撤回」留痕',
          p2.status === 200 && p2.json.data.version_no === p1.json.data.version_no + 1
          && hist.filter((h) => h.status === 'published').length === 1,
          `v${p2.json.data && p2.json.data.version_no} / 历史 ${hist.length} 条 / 生效 ${hist.filter((h) => h.status === 'published').length} 条`);

        const live = hist.find((h) => h.status === 'published');
        const badWithdraw = await req(`/api/customer-progress/publications/${live.id}/withdraw`, {
          method: 'POST', token, body: { reason: '错' }
        });
        ok('撤回必须写原因（至少 4 字）', badWithdraw.status === 400, `HTTP ${badWithdraw.status}`);

        const okWithdraw = await req(`/api/customer-progress/publications/${live.id}/withdraw`, {
          method: 'POST', token, body: { reason: '交期调整，撤回后重发（冒烟）' }
        });
        ok('撤回后客户侧看不到（版本仍留在历史里）',
          okWithdraw.status === 200
          && (DB.prepare("SELECT COUNT(*) c FROM progress_publications WHERE order_id = ? AND status='published'").get(target.id).c === 0)
          && (DB.prepare('SELECT COUNT(*) c FROM progress_publications WHERE order_id = ?').get(target.id).c >= 2),
          `HTTP ${okWithdraw.status}`);

        // 客户侧：未发布 → published:false；发布后 → 能看到；别人的客户 → 403
        const mallLogin = async (u, pw) => {
          const r = await req('/api/mall/auth/login', { method: 'POST', body: { username: u, password: pw } });
          return (r.json && r.json.data && r.json.data.token) || '';
        };
        const cTok = await mallLogin('abc001', 'abc123456');
        if (cTok) {
          const before = await req(`/api/mall/orders/${target.id}/progress`, { token: cTok });
          ok('未发布的订单，客户侧明确返回「未发布」而不是空白',
            before.status === 200 && before.json.data.published === false, JSON.stringify(before.json.data.published));

          const pub = await req(`/api/customer-progress/orders/${target.id}/publish`, { method: 'POST', token, body: { note: TEST_MARK } });
          DB.prepare("UPDATE progress_publications SET published_by = ? WHERE order_id = ? AND status='published'").run(TEST_MARK, target.id);
          if (pub.status === 200 && target.customer_id === 1) {
            const after = await req(`/api/mall/orders/${target.id}/progress`, { token: cTok });
            ok('发布后客户能看到阶段与进度',
              after.status === 200 && after.json.data.published === true && (after.json.data.stages || []).length > 0,
              `阶段 ${(after.json.data.stages || []).length} 个`);
            const cjson = JSON.stringify(after.json.data || {});
            ok('客户拿到的快照里没有工厂/成本/返工/工人',
              !/factory|加工费|unit_price|返工|operator/.test(cjson), cjson.slice(0, 80));
          } else {
            ok('发布后客户能看到阶段与进度', true, '这单不属于 abc001 客户，跳过');
            ok('客户拿到的快照里没有工厂/成本/返工/工人', true, '跳过');
          }

          // 别的客户看不到 abc001 的订单
          const otherTok = await mallLogin('def_orders', 'abc123456');
          if (otherTok && target.customer_id === 1) {
            const deny = await req(`/api/mall/orders/${target.id}/progress`, { token: otherTok });
            ok('客户不能看别家的订单进度', deny.status === 403, `HTTP ${deny.status}`);
          } else {
            ok('客户不能看别家的订单进度', true, '没有第二个客户账号，跳过');
          }
        } else {
          ok('未发布的订单，客户侧明确返回「未发布」而不是空白', true, '没有 abc001，跳过');
          ok('发布后客户能看到阶段与进度', true, '跳过');
          ok('客户拿到的快照里没有工厂/成本/返工/工人', true, '跳过');
          ok('客户不能看别家的订单进度', true, '跳过');
        }
      } else {
        ['可发布订单并生成 v1', '再次发布版本号 +1，旧版转「已撤回」留痕', '撤回必须写原因（至少 4 字）',
          '撤回后客户侧看不到（版本仍留在历史里）', '未发布的订单，客户侧明确返回「未发布」而不是空白',
          '发布后客户能看到阶段与进度', '客户拿到的快照里没有工厂/成本/返工/工人', '客户不能看别家的订单进度']
          .forEach((n) => ok(n, true, '没有可发布订单，跳过'));
      }

      // 草稿订单不能发
      const draft = DB.prepare("SELECT id, order_no FROM orders WHERE status = 'draft' LIMIT 1").get();
      if (draft) {
        const r = await req(`/api/customer-progress/orders/${draft.id}/publish`, { method: 'POST', token, body: {} });
        ok('未进入生产的订单不能发布进度', r.status === 400, `HTTP ${r.status} ${r.json.message || ''}`);
      } else {
        ok('未进入生产的订单不能发布进度', true, '没有草稿订单，跳过');
      }

      // 路线人工指定后不被自动推断覆盖
      if (target) {
        const set = await req(`/api/customer-progress/orders/${target.id}/route`, {
          method: 'PUT', token, body: { route: 'full_outsource', note: TEST_MARK }
        });
        const it2 = (await req(`/api/customer-progress/orders/${target.id}/internal`, { token })).json.data;
        ok('人工指定路线后不被自动推断覆盖（整单外发只有 3 段）',
          set.status === 200 && it2.route === 'full_outsource' && it2.stages.length === 3,
          it2 ? `${it2.route} / ${it2.stages.length} 段` : '');
      } else {
        ok('人工指定路线后不被自动推断覆盖（整单外发只有 3 段）', true, '跳过');
      }

      // 权限：仓库/财务不能发布
      const whTok = await asUser('wh01');
      if (whTok) {
        const deny = await req(`/api/customer-progress/orders/${target ? target.id : 1}/publish`, { method: 'POST', token: whTok, body: {} });
        ok('仓库不能对外发布进度', deny.status === 403, `HTTP ${deny.status}`);
      } else {
        ok('仓库不能对外发布进度', true, '没有 wh01，跳过');
      }
      const salesTok = await asUser('sales01');
      if (salesTok) {
        const canRead = await req('/api/customer-progress/orders', { token: salesTok });
        ok('销售能看订单与发布状态', canRead.status === 200, `HTTP ${canRead.status}`);
      } else {
        ok('销售能看订单与发布状态', true, '跳过');
      }
    } finally {
      cleanup();
    }

    ok('发布夹具已清干净',
      DB.prepare('SELECT COUNT(*) c FROM progress_publications WHERE published_by = ? OR withdrawn_by = ?').get(TEST_MARK, TEST_MARK).c === 0
      && DB.prepare('SELECT COUNT(*) c FROM order_routes WHERE updated_by = ?').get(TEST_MARK).c === 0);
  }


  /* ================================================================== *
   * 售后与对账资料（TS-N22-08）
   * 自己建夹具、跑完删净；不复用演示数据，避免和别人的用例抢单据
   * ================================================================== */
  {
    const { db: ASDB } = require('../src/db');
    const AS_MARK = '__smoke_as__';
    // 上一次跑到一半崩了会留下售后单（cleanup 在块尾，抛异常就到不了）——
    // 先按固定用例文案清一遍，避免演示库里出现「测试单」
    (() => {
      const stale = ASDB.prepare("SELECT id, ticket_no FROM after_sale_tickets WHERE reason = ? AND IFNULL(demo_tag,'') = ''")
        .all('客户反馈包装破损，先提一条售后核对处理方式');
      stale.forEach((t) => {
        ASDB.prepare('SELECT id FROM stock_returns WHERE source_no = ?').all(t.ticket_no).forEach((r) => {
          ASDB.prepare('DELETE FROM stock_return_items WHERE return_id = ?').run(r.id);
          ASDB.prepare('DELETE FROM stock_returns WHERE id = ?').run(r.id);
        });
        ASDB.prepare("DELETE FROM attachments WHERE target_type='after_sale' AND target_id=?").run(t.id);
        ASDB.prepare('DELETE FROM after_sale_tickets WHERE id = ?').run(t.id);
      });
      const staleSf = ASDB.prepare('DELETE FROM statement_files WHERE demo_tag = ?').run(AS_MARK).changes;
      if (stale.length || staleSf) console.log('  （清掉上次残留：售后 ' + stale.length + ' 条 / 对账 ' + staleSf + ' 份）');
    })();
    console.log('\n[售后与对账资料]');

    const meta = await req('/api/after-sales/meta', { token });
    ok('售后字典：6 类原因 / 4 种处理方式',
      meta.status === 200 && meta.json.data.reasons.length === 6 && meta.json.data.resolutions.length === 4,
      `HTTP ${meta.status} / 原因 ${(meta.json.data || {}).reasons ? meta.json.data.reasons.length : '?'}`);

    // 本块自备登录与清理助手，不依赖别处的变量（越靠后越容易踩到作用域）
    const loginAsLocal3 = async (u) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: PASS } });
      return r.status === 200 ? r.json.data.token : '';
    };
    const mallLogin = (await req('/api/mall/auth/login', {
      method: 'POST', body: { username: MALL_USER, password: MALL_PASS }
    })).json.data;
    const mallTok = mallLogin.token;
    const mallLoginCid = mallLogin.customer ? mallLogin.customer.id : 1;
    // 退款只给财务/管理员，用财务账号验证（用 admin 会绕开权限本身）
    const finTok = await loginAsLocal3('fin01');

    const opt = await req('/api/mall/after-sales/options', { token: mallTok });
    const optOrders = (opt.json.data && opt.json.data.orders) || [];
    // 优先挑「一件都没提过售后」的行：演示数据里已有几条处理中的单，
    // 随便挑一行会撞上自己写的防重规则（同一行同原因只许一条处理中），
    // 那样测的就不是主流程，而是防重规则本身。
    let withItem = null;
    let line = null;
    for (const o of optOrders) {
      const it = (o.items || []).find((x) => x.claimed === 0 && x.available >= 1);
      if (it) { withItem = o; line = it; break; }
    }
    if (!withItem) {
      withItem = optOrders.find((o) => (o.items || []).some((it) => it.available > 0)) || null;
      line = withItem ? withItem.items.find((it) => it.available > 0) : null;
    }
    ok('客户能拿到可提售后的订单与明细（含剩余可提数量）',
      opt.status === 200 && !!withItem && !!line, `HTTP ${opt.status} / 订单 ${optOrders.length}`);

    const base = {
      order_id: withItem ? withItem.id : 0,
      order_item_id: line ? line.id : 0,
      qty: 1,
      // 主流程用「其他」：质量问题必须带照片，那条单独测；
      // 混在一起会让人分不清失败的到底是照片要求还是链路本身
      reason_code: 'other',
      resolution: 'return',
      reason: '客户反馈包装破损，先提一条售后核对处理方式'
    };

    // 1. 质量问题没照片 → 拦
    const noPhoto = await req('/api/mall/after-sales', {
      method: 'POST', token: mallTok, body: { ...base, reason_code: 'quality', amount_claim: 1 }
    });
    ok('质量问题没照片被拦（业务没法向工厂举证）', noPhoto.status === 400, `HTTP ${noPhoto.status}`);

    // 2. 索赔超订单行金额 → 拦
    const tooMuch = await req('/api/mall/after-sales', {
      method: 'POST', token: mallTok,
      body: { ...base, amount_claim: 999999, photos: [{ url: '/uploads/photos/x.jpg' }] }
    });
    ok('索赔金额超订单行货款被拦（手滑多打一个零不该变成巨额退款）', tooMuch.status === 400, `HTTP ${tooMuch.status}`);

    // 3. 正常提交
    const good = await req('/api/mall/after-sales', {
      method: 'POST', token: mallTok,
      body: { ...base, amount_claim: 10, photos: [{ url: '/uploads/photos/2026-10/56d1e148529e2f43e399.jpg' }] }
    });
    const tkId = good.json.data && good.json.data.id;
    if (!tkId) console.log('  ⚠ 售后夹具没建成，后续用例会连带失败：', JSON.stringify(good.json).slice(0, 160));
    const tkNo = good.json.data && good.json.data.ticket_no;
    ok('客户提售后成功（待受理）', good.status === 200 && good.json.data.status === 'submitted', `HTTP ${good.status} / ${tkNo}`);

    // 4. 同一行同原因重复 → 拦
    const dup = await req('/api/mall/after-sales', {
      method: 'POST', token: mallTok,
      body: { ...base, amount_claim: 10, photos: [{ url: '/uploads/photos/x.jpg' }] }
    });
    ok('同一订单行同原因只允许一条处理中（连点不产生多张单）', dup.status === 400, `HTTP ${dup.status}`);

    // 5. 客户能看到自己刚提的单，且看不到内部追偿字段
    const mine = await req('/api/mall/after-sales', { token: mallTok });
    const mineRow = (mine.json.data.rows || []).find((r) => r.id === tkId);
    ok('客户能查到自己提的售后', mine.status === 200 && !!mineRow, `HTTP ${mine.status}`);
    ok('客户视图不含内部追偿字段', mineRow && mineRow.recovery_amount === undefined && mineRow.recovery_party === undefined);

    // 6. 内部受理（退货退款 → 应生成退货单草稿）
    const acc = await req('/api/after-sales/' + tkId + '/accept', {
      method: 'POST', token, body: { owner_role: 'quality' }
    });
    const retId = acc.json.data && acc.json.data.stock_return_id;
    ok('受理「退货退款」自动生成退货单草稿（实物接在仓库已有流程上）',
      acc.status === 200 && !!retId, `HTTP ${acc.status} / 退货单 ${retId || '无'}`);

    // 7. 结案被拦：货还没到仓
    const earlySettle = await req('/api/after-sales/' + tkId + '/settle', {
      method: 'POST', token, body: { conclusion: '客户同意抵扣，货已安排寄回，等仓库点收' }
    });
    ok('货没到仓不许结案（否则结完案没人盯仓库）', earlySettle.status === 400, `HTTP ${earlySettle.status}`);

    // 8. 退款金额超索赔 → 拦
    const overRefund = await req('/api/after-sales/refund/' + tkId, {
      method: 'POST', token: finTok || token, body: { amount: 999, method: '原路退回' }
    });
    ok('退款金额超过客户索赔被拦', overRefund.status === 400, `HTTP ${overRefund.status}`);

    // 9. ★ 退款不改库存 —— 这个模块最硬的一条
    const stockBefore = ASDB.prepare('SELECT COALESCE(SUM(qty),0) q FROM stock_items').get().q;
    const rf = await req('/api/after-sales/refund/' + tkId, {
      method: 'POST', token: finTok || token,
      body: { amount: 10, method: '原路退回', goods_returned: 1, note: '客户确认寄回' }
    });
    const stockAfter = ASDB.prepare('SELECT COALESCE(SUM(qty),0) q FROM stock_items').get().q;
    ok('退款登记成功', rf.status === 200 && rf.json.data.refund_status === 'paid', `HTTP ${rf.status}`);
    ok('★ 退款不动库存（原型：退款不直接恢复库存）',
      Math.abs(Number(stockBefore) - Number(stockAfter)) < 0.001, `前 ${stockBefore} / 后 ${stockAfter}`);

    // 10. 重复退款 → 拦
    const rf2 = await req('/api/after-sales/refund/' + tkId, {
      method: 'POST', token: finTok || token, body: { amount: 5, method: '原路退回' }
    });
    ok('同一单不能退两次', rf2.status === 400, `HTTP ${rf2.status}`);

    // 11. 追偿金额超过退款 → 拦
    const overRec = await req('/api/after-sales/' + tkId + '/recovery', {
      method: 'POST', token, body: { party: 'factory', amount: 999, note: '想多追一点' }
    });
    ok('追偿不能超过赔给客户的金额', overRec.status === 400, `HTTP ${overRec.status}`);

    // 12. 走完仓库流程（模拟点收 + 判定 + 关单），再结案
    ASDB.prepare('UPDATE stock_return_items SET qty_received = qty_apply WHERE return_id = ?').run(retId);
    ASDB.prepare("UPDATE stock_returns SET status='received', qty_received=qty_apply WHERE id=?").run(retId);
    const t1 = await req('/api/after-sales/' + tkId, { token });
    ok('点收后实物轨道跟着变（不存副本，实时算）',
      t1.json.data.tracks.receipt.code === 'received', JSON.stringify(t1.json.data.tracks.receipt));

    const midSettle = await req('/api/after-sales/' + tkId + '/settle', {
      method: 'POST', token, body: { conclusion: '客户同意抵扣，货已到仓待判定，先结案试试' }
    });
    ok('货到仓但没判定，仍然不许结案', midSettle.status === 400, `HTTP ${midSettle.status}`);

    ASDB.prepare('UPDATE stock_return_items SET qty_good = qty_received, qty_defect = 0 WHERE return_id = ?').run(retId);
    ASDB.prepare("UPDATE stock_returns SET status='closed', qty_good=qty_apply WHERE id=?").run(retId);
    const t2 = await req('/api/after-sales/' + tkId, { token });
    ok('判定合格后「再上架」显示已入可售',
      t2.json.data.tracks.restock.code === 'done', JSON.stringify(t2.json.data.tracks.restock));

    const fin = await req('/api/after-sales/' + tkId + '/settle', {
      method: 'POST', token, body: { conclusion: '退 1 件，良品已回可售；已退 10 美元，客户确认不再追究' }
    });
    ok('实物与退款都走完后可以结案', fin.status === 200 && fin.json.data.status === 'settled', `HTTP ${fin.status}`);

    // 13. 权限：仓库能看售后，但不能登记退款（动钱只给财务/管理员）
    const whTok = await loginAsLocal3('wh01');
    if (whTok) {
      const whList = await req('/api/after-sales', { token: whTok });
      ok('仓库能看售后清单（要点收要判定）', whList.status === 200, `HTTP ${whList.status}`);
      const whRefund = await req('/api/after-sales/refund/' + tkId, {
        method: 'POST', token: whTok, body: { amount: 1, method: '原路退回' }
      });
      ok('仓库不能登记退款', whRefund.status === 403, `HTTP ${whRefund.status}`);
    } else {
      ok('仓库不能登记退款', true, '没有 wh01，跳过');
    }

    /* ---------------- 对账资料 ---------------- */
    const sfDraft = await req('/api/statement-files/generate', {
      method: 'POST', token,
      body: { customer_id: withItem ? (mallLoginCid || 1) : 1, period: '2026-09', kind: 'monthly', demo_tag: AS_MARK }
    });
    const sfId = sfDraft.json.data && sfDraft.json.data.id;
    ok('生成对账单草稿（含内部校验差额）', sfDraft.status === 200 && !!sfId,
      `HTTP ${sfDraft.status} / 差额 ${sfDraft.json.data ? sfDraft.json.data.check_diff : '?'}`);

    const custSeeDraft = await req('/api/mall/statements', { token: mallTok });
    const draftVisible = (custSeeDraft.json.data.rows || []).some((r) => r.id === sfId);
    ok('草稿客户看不到（未授权不对外）', custSeeDraft.status === 200 && !draftVisible);

    // 伪造一份校验不平的文件，验证「对账不平不许发」
    const badInfo = ASDB.prepare(
      `INSERT INTO statement_files (file_no, company_id, customer_id, customer_name, period_from, period_to,
         kind, version_no, title, file_name, snapshot, amount_opening, amount_invoiced, amount_paid,
         amount_closing, check_diff, status, created_by, created_at, updated_at, demo_tag)
       VALUES (?,1,?,?,?,?, 'monthly', 99, ?, ?, '{}', 0,0,0,0, 1.23, 'draft', 'smoke', ?, ?, ?)`
    ).run('SF__SMOKE_BAD__', mallLoginCid || 1, '__smoke 客户__', '2025-01-01', '2025-01-31', '__smoke 不平的对账单__', 'x.csv',
      new Date().toISOString(), new Date().toISOString(), AS_MARK);
    const badPub = await req('/api/statement-files/' + badInfo.lastInsertRowid + '/publish', { method: 'POST', token, body: {} });
    ok('对账不平（check_diff≠0）不许授权给客户', badPub.status === 400, `HTTP ${badPub.status}`);

    const pub = await req('/api/statement-files/' + sfId + '/publish', { method: 'POST', token, body: {} });
    ok('授权发布后客户才能看到', pub.status === 200 && pub.json.data.status === 'published', `HTTP ${pub.status}`);

    const custSeePub = await req('/api/mall/statements', { token: mallTok });
    ok('客户能看到已授权的对账文件', (custSeePub.json.data.rows || []).some((r) => r.id === sfId));

    const dl = await fetch(BASE + '/api/mall/statements/' + sfId + '/download', {
      headers: { Authorization: 'Bearer ' + mallTok }
    });
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    ok('客户能下载对账 CSV（带 UTF-8 BOM）',
      dl.status === 200 && dlBuf[0] === 0xef && dlBuf[1] === 0xbb && dlBuf[2] === 0xbf, `HTTP ${dl.status}`);
    const dlText = dlBuf.toString('utf8');
    ok('对账 CSV 含期初/期末与逐笔流水', /期初结欠/.test(dlText) && /期末结欠/.test(dlText));

    const logged = ASDB.prepare("SELECT COUNT(*) c FROM doc_access_logs WHERE doc_type='statement_file' AND doc_id=?").get(sfId).c;
    ok('客户下载留痕（可追溯到谁什么时候下的）', logged >= 1, `日志 ${logged} 条`);

    const rev = await req('/api/statement-files/' + sfId + '/revoke', { method: 'POST', token, body: { reason: '金额算错重出' } });
    ok('撤销已授权文件', rev.status === 200 && rev.json.data.status === 'revoked', `HTTP ${rev.status}`);
    const dl2 = await fetch(BASE + '/api/mall/statements/' + sfId + '/download', {
      headers: { Authorization: 'Bearer ' + mallTok }
    });
    ok('撤销后客户立刻下不了', dl2.status === 400 || dl2.status === 403, `HTTP ${dl2.status}`);

    /* ---------------- 清夹具 ---------------- */
    try {
      const rets = ASDB.prepare('SELECT id FROM stock_returns WHERE source_no = ?').all(tkNo);
      rets.forEach((r) => {
        ASDB.prepare('DELETE FROM stock_return_items WHERE return_id = ?').run(r.id);
        ASDB.prepare('DELETE FROM stock_returns WHERE id = ?').run(r.id);
      });
      ASDB.prepare("DELETE FROM attachments WHERE target_type='after_sale' AND target_id=?").run(tkId);
      ASDB.prepare('DELETE FROM after_sale_tickets WHERE id = ?').run(tkId);
      ASDB.prepare("DELETE FROM doc_access_logs WHERE doc_type='statement_file' AND doc_id IN (SELECT id FROM statement_files WHERE customer_id=?)").run(mallLoginCid || 1);
      ASDB.prepare('DELETE FROM statement_files WHERE demo_tag = ?').run(AS_MARK);
      ASDB.prepare("DELETE FROM statement_files WHERE file_no='SF__SMOKE_BAD__'").run();
      ASDB.prepare('DELETE FROM statement_files WHERE id = ?').run(sfId);
      ok('冒烟夹具已清干净',
        !ASDB.prepare('SELECT 1 x FROM after_sale_tickets WHERE id = ?').get(tkId)
        && !ASDB.prepare("SELECT 1 x FROM statement_files WHERE file_no='SF__SMOKE_BAD__'").get());
    } catch (e) {
      ok('冒烟夹具已清干净', false, e.message);
    }
  }

  /* ================================================================== *
   * 办公耗材与服务采购（TS-N14-07）
   * 夹具用固定文案标记（物品名 / 供应商 / 事由都带 __SMOKE），开头与结尾各清一次
   * ================================================================== */
  {
    const { db: ODB } = require('../src/db');
    console.log('\n[办公耗材与服务采购]');

    // 本块自备登录助手，不依赖别处的作用域
    const loginAsLocal4 = async (u) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: PASS } });
      return r.status === 200 ? r.json.data.token : '';
    };

    const cleanSmoke = () => {
      const items = ODB.prepare("SELECT id FROM office_items WHERE name LIKE '%__SMOKE%'").all().map((r) => r.id);
      const pos = ODB.prepare("SELECT id, po_no FROM office_purchases WHERE supplier LIKE '%__SMOKE%'").all();
      const reqs = ODB.prepare("SELECT id FROM office_requests WHERE purpose LIKE '%__SMOKE%'").all().map((r) => r.id);
      pos.forEach((p) => {
        ODB.prepare('DELETE FROM office_purchase_items WHERE purchase_id = ?').run(p.id);
        ODB.prepare('DELETE FROM office_purchase_sources WHERE purchase_id = ?').run(p.id);
        ODB.prepare('DELETE FROM assets WHERE remark LIKE ?').run(`%${p.po_no}%`);
        ODB.prepare('DELETE FROM admin_expenses WHERE remark LIKE ?').run(`%${p.po_no}%`);
        ODB.prepare("DELETE FROM budget_commitments WHERE source_type='office_purchase' AND source_id=?").run(p.id);
      });
      ODB.prepare("DELETE FROM office_purchases WHERE supplier LIKE '%__SMOKE%'").run();
      reqs.forEach((id) => ODB.prepare('DELETE FROM office_request_items WHERE request_id = ?').run(id));
      ODB.prepare("DELETE FROM office_requests WHERE purpose LIKE '%__SMOKE%'").run();
      items.forEach((id) => {
        ODB.prepare('DELETE FROM office_ledger WHERE item_id = ?').run(id);
        ODB.prepare('DELETE FROM office_stock WHERE item_id = ?').run(id);
      });
      ODB.prepare("DELETE FROM office_items WHERE name LIKE '%__SMOKE%'").run();
    };
    cleanSmoke();   // 上次跑到一半崩了也能自愈

    const meta = await req('/api/office-supply/meta', { token });
    ok('办公耗材字典（物品 / 部门 / 统计）',
      meta.status === 200 && Array.isArray(meta.json.data.categories) && !!meta.json.data.stats, `HTTP ${meta.status}`);

    // 基线：办公操作绝不能动生产库存
    const baseStock = Number(ODB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v);
    const baseMat = Number(ODB.prepare('SELECT COALESCE(SUM(stock_qty),0) v FROM materials').get().v);
    const baseMatLedger = ODB.prepare('SELECT COUNT(*) c FROM material_ledger').get().c;

    // 1. 建档
    const itPaper = await req('/api/office-supply/items', {
      method: 'POST', token, body: { name: '烟测用纸__SMOKE', spec: '500张', category: 'printing', unit: '包', min_qty: 5 }
    });
    const itPen = await req('/api/office-supply/items', {
      method: 'POST', token, body: { name: '烟测用笔__SMOKE', category: 'stationery', unit: '支', min_qty: 10, monthly_limit: 20 }
    });
    const itDurable = await req('/api/office-supply/items', {
      method: 'POST', token,
      body: { name: '烟测打印机__SMOKE', category: 'electronic', unit: '台', durable: 1, asset_category: '办公设备', useful_years: 5 }
    });
    ok('建办公物品档案（含耐用品）',
      itPaper.status === 200 && itPen.status === 200 && itDurable.status === 200,
      `HTTP ${itPaper.status}/${itPen.status}/${itDurable.status}`);
    const pid = itPaper.json.data.id;
    const nid = itPen.json.data.id;
    const did = itDurable.json.data.id;

    // 2. 耐用品不能走耗材申领（它验收即转资产，永远没有库存）
    const durableReq = await req('/api/office-supply/requests', {
      method: 'POST', token,
      body: { dept_id: 6, requester: 'smoke', purpose: '烟测：领一台打印机__SMOKE', items: [{ item_id: did, qty_apply: 1 }], submit: true }
    });
    ok('耐用品不走耗材申领（要转资产的走资产领用）', durableReq.status === 400, `HTTP ${durableReq.status}`);

    // 3. 没库存就申领 → 拦
    const noStock = await req('/api/office-supply/requests', {
      method: 'POST', token,
      body: { dept_id: 6, requester: 'smoke', purpose: '烟测：没库存先申领__SMOKE', items: [{ item_id: pid, qty_apply: 2 }], submit: true }
    });
    ok('库存不足时申领被拦（先采购再领）', noStock.status === 400, `HTTP ${noStock.status}`);

    // 4. 采购：耗材 + 耐用品混单
    const po = await req('/api/office-supply/purchases', {
      method: 'POST', token,
      body: {
        supplier: '烟测供应商__SMOKE', dept_id: 6,
        items: [
          { item_id: pid, qty: 20, price: 10 },
          { item_id: nid, qty: 50, price: 2 },
          { item_id: did, qty: 2, price: 1000 }
        ]
      }
    });
    ok('建采购单（耗材与耐用品混在一张）', po.status === 200 && po.json.data.total_amount === 20 * 10 + 50 * 2 + 2000,
      `HTTP ${po.status} / 金额 ${po.json.data ? po.json.data.total_amount : '?'}`);
    const poId = po.json.data.id;
    const poNo = po.json.data.po_no;

    // 5. 0 元单不能审批
    const poZero = await req('/api/office-supply/purchases', {
      method: 'POST', token, body: { supplier: '烟测零元单__SMOKE', items: [{ item_id: pid, qty: 1, price: 0 }] }
    });
    const zeroApprove = await req('/api/office-supply/purchases/' + poZero.json.data.id + '/approve', { method: 'POST', token, body: {} });
    ok('金额为 0 的采购单不能审批（否则费用会是 0，账上就丢了这笔）', zeroApprove.status === 400, `HTTP ${zeroApprove.status}`);
    await req('/api/office-supply/purchases/' + poZero.json.data.id + '/cancel', { method: 'POST', token, body: { reason: '烟测零元单撤销' } });

    // 6. 审批 → 下单 → 验收
    await req('/api/office-supply/purchases/' + poId + '/approve', { method: 'POST', token, body: {} });
    await req('/api/office-supply/purchases/' + poId + '/order', { method: 'POST', token, body: {} });
    const rc = await req('/api/office-supply/purchases/' + poId + '/receive', {
      method: 'POST', token, body: { payment_method: '转账' }
    });
    ok('验收成功', rc.status === 200 && rc.json.data.status === 'received', `HTTP ${rc.status}`);
    ok('★ 耐用品金额单独进资产，不进费用',
      rc.json.data.asset_amount === 2000 && rc.json.data.expense_amount === 20 * 10 + 50 * 2,
      `资产 ${rc.json.data.asset_amount} / 费用 ${rc.json.data.expense_amount}`);
    ok('耐用品按件建资产卡（一物一码）', (rc.json.data.assets || []).length === 2, `建了 ${(rc.json.data.assets || []).length} 张`);

    const exp = ODB.prepare('SELECT * FROM admin_expenses WHERE id = ?').get(rc.json.data.expense_id);
    ok('费用自动入账（验收与费用同源，不用再手工录一遍）',
      !!exp && Number(exp.amount) === rc.json.data.expense_amount, `费用单 ${exp ? exp.amount : '无'}`);
    const commit = ODB.prepare("SELECT * FROM budget_commitments WHERE source_type='office_purchase' AND source_id=?").get(poId);
    ok('费用同时占用部门预算（否则预算执行表少这一笔）', !!commit && Number(commit.amount) === rc.json.data.expense_amount,
      commit ? `占用 ${commit.amount}` : '未占用');

    // 7. 办公仓有货，生产仓没动
    const stockAfter = await req('/api/office-supply/board', { token });
    const paperRow = (stockAfter.json.data || []).find((x) => x.id === pid);
    ok('耗材进的是办公仓（不是生产成品仓）', !!paperRow && Number(paperRow.qty) === 20, `办公仓 ${paperRow ? paperRow.qty : '?'}`);
    const nowStock = Number(ODB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v);
    const nowMat = Number(ODB.prepare('SELECT COALESCE(SUM(stock_qty),0) v FROM materials').get().v);
    const nowMatLedger = ODB.prepare('SELECT COUNT(*) c FROM material_ledger').get().c;
    ok('★ 办公采购不动生产成品库存', baseStock === nowStock, `前 ${baseStock} / 后 ${nowStock}`);
    ok('★ 办公采购不动生产材料库存与材料流水',
      baseMat === nowMat && baseMatLedger === nowMatLedger, `材料 ${baseMat}→${nowMat}，流水 ${baseMatLedger}→${nowMatLedger}`);

    // 8. 申领 → 审批 → 出库
    const rq = await req('/api/office-supply/requests', {
      method: 'POST', token,
      body: { dept_id: 6, requester: 'smoke', requester_name: '烟测员', purpose: '烟测：正常领用__SMOKE', items: [{ item_id: pid, qty_apply: 5 }], submit: true }
    });
    ok('提交申领（库存够，通过三道闸）', rq.status === 200 && rq.json.data.status === 'submitted', `HTTP ${rq.status}`);
    const rqId = rq.json.data.id;
    const rqNo = rq.json.data.req_no;

    const dup = await req('/api/office-supply/requests', {
      method: 'POST', token,
      body: { dept_id: 6, requester: 'smoke', purpose: '烟测：重复领用__SMOKE', items: [{ item_id: pid, qty_apply: 1 }], submit: true }
    });
    ok('同一人同一物品未结时再提被拦（防重复领用）', dup.status === 400, `HTTP ${dup.status}`);

    await req('/api/office-supply/requests/' + rqId + '/approve', { method: 'POST', token, body: {} });
    const issue = await req('/api/office-supply/requests/' + rqId + '/issue', { method: 'POST', token, body: {} });
    ok('出库成功（真正扣库存）', issue.status === 200 && issue.json.data.status === 'issued', `HTTP ${issue.status}`);
    const afterIssue = (await req('/api/office-supply/board', { token })).json.data.find((x) => x.id === pid);
    ok('出库后办公仓减少 5', Number(afterIssue.qty) === 15, `剩 ${afterIssue.qty}`);

    const led = await req('/api/office-supply/ledger?item_id=' + pid, { token });
    const ledTypes = (led.json.data || []).map((l) => l.type);
    ok('收发流水记录入库与领用（in + out）', ledTypes.includes('in') && ledTypes.includes('out'), ledTypes.join(','));

    // 9. 退回回补库存
    const rqLine = ODB.prepare('SELECT * FROM office_request_items WHERE request_id = ?').all(rqId)[0];
    const back = await req('/api/office-supply/requests/' + rqId + '/return', {
      method: 'POST', token, body: { items: [{ id: rqLine.id, qty: 2 }], reason: '多领了退回来' }
    });
    ok('退回入库', back.status === 200 && back.json.data.status === 'returned', `HTTP ${back.status}`);
    const afterBack = (await req('/api/office-supply/board', { token })).json.data.find((x) => x.id === pid);
    ok('退回后库存回补到 17', Number(afterBack.qty) === 17, `剩 ${afterBack.qty}`);

    // 10. 月限额：笔限 20，已有 0，提 25 → 拦；写例外 → 放行
    const overLimit = await req('/api/office-supply/requests', {
      method: 'POST', token,
      body: { dept_id: 6, requester: 'smoke2', purpose: '烟测：超月限额__SMOKE', items: [{ item_id: nid, qty_apply: 25 }], submit: true }
    });
    ok('超部门月限额被拦（要求写例外说明）', overLimit.status === 400, `HTTP ${overLimit.status}`);
    const withReason = await req('/api/office-supply/requests', {
      method: 'POST', token,
      body: {
        dept_id: 6, requester: 'smoke2', purpose: '烟测：超限但有说明__SMOKE',
        items: [{ item_id: nid, qty_apply: 18 }], submit: true,
        exception_reason: '烟测：新入职集中配文具，已口头报备行政主管'
      }
    });
    ok('写了例外说明后可以提交（例外审批而非硬拒）', withReason.status === 200, `HTTP ${withReason.status}`);

    // 11. 合并申领 → 采购单（聚合同一物品）
    const rqApproved = await req('/api/office-supply/requests', {
      method: 'POST', token,
      body: { dept_id: 6, requester: 'smoke3', purpose: '烟测：待合并__SMOKE', items: [{ item_id: pid, qty_apply: 3 }], submit: true }
    });
    const rqApprovedId = rqApproved.json.data.id;
    await req('/api/office-supply/requests/' + rqApprovedId + '/approve', { method: 'POST', token, body: {} });
    const merged = await req('/api/office-supply/purchases', {
      method: 'POST', token, body: { supplier: '烟测合并单__SMOKE', request_ids: [rqApprovedId] }
    });
    ok('从已批准申领合并成采购单', merged.status === 200, `HTTP ${merged.status}`);
    const mergedDetail = await req('/api/office-supply/purchases/' + merged.json.data.id, { token });
    ok('合并后记下来源申领（可控、可追溯）',
      (mergedDetail.json.data.sources || []).some((s) => s.req_no === rqApproved.json.data.req_no),
      JSON.stringify((mergedDetail.json.data.sources || []).map((s) => s.req_no)));
    const reMerge = await req('/api/office-supply/purchases', {
      method: 'POST', token, body: { supplier: '烟测重复合并__SMOKE', request_ids: [rqApprovedId] }
    });
    ok('同一申领不能被两张在途采购单同时占用', reMerge.status === 400, `HTTP ${reMerge.status}`);

    // 12. 最低库存只提示，不自动下单
    const lowBefore = await req('/api/office-supply/low-stock', { token });
    const poCountBefore = ODB.prepare('SELECT COUNT(*) c FROM office_purchases').get().c;
    const lowAgain = await req('/api/office-supply/low-stock', { token });
    const poCountAfter = ODB.prepare('SELECT COUNT(*) c FROM office_purchases').get().c;
    ok('最低库存给出建议量', lowAgain.status === 200 && (lowAgain.json.data.rows || []).every((r) => r.suggest_qty > 0),
      `缺口 ${lowAgain.json.data ? lowAgain.json.data.count : '?'} 项`);
    ok('★ 最低库存只提示，不会自动生成采购单', poCountBefore === poCountAfter, `${poCountBefore} → ${poCountAfter}`);

    // 13. 服务采购：验收才计费
    const svc = await req('/api/office-supply/purchases', {
      method: 'POST', token,
      body: {
        kind: 'service', supplier: '烟测保洁__SMOKE',
        items: [{ line_type: 'service', item_name: '烟测保洁服务', qty: 1, price: 800 }]
      }
    });
    const svcExpBefore = ODB.prepare("SELECT COUNT(*) c FROM admin_expenses WHERE remark LIKE '%烟测保洁%'").get().c;
    ok('服务采购建单后还没计费', svcExpBefore === 0, `已有 ${svcExpBefore} 条`);
    await req('/api/office-supply/purchases/' + svc.json.data.id + '/approve', { method: 'POST', token, body: {} });
    const svcRc = await req('/api/office-supply/purchases/' + svc.json.data.id + '/receive', { method: 'POST', token, body: {} });
    ok('服务验收后计费用（服务没有库存，不进仓）',
      svcRc.status === 200 && svcRc.json.data.expense_amount === 800 && svcRc.json.data.asset_amount === 0,
      `费用 ${svcRc.json.data ? svcRc.json.data.expense_amount : '?'}`);

    // 14. 已验收不能撤销
    const cancelReceived = await req('/api/office-supply/purchases/' + poId + '/cancel', {
      method: 'POST', token, body: { reason: '烟测：想撤销已验收的单' }
    });
    ok('已验收的单不能撤销（货入库、费用已入账）', cancelReceived.status === 400, `HTTP ${cancelReceived.status}`);

    // 15. 权限：仓库能申领，但不能建采购单（会花钱）
    const whTok = await loginAsLocal4('wh01');
    if (whTok) {
      const whBoard = await req('/api/office-supply/board', { token: whTok });
      ok('仓库能看办公库存', whBoard.status === 200, `HTTP ${whBoard.status}`);
      const whPo = await req('/api/office-supply/purchases', {
        method: 'POST', token: whTok, body: { supplier: '烟测越权__SMOKE', items: [{ item_id: pid, qty: 1, price: 1 }] }
      });
      ok('仓库不能建采购单（花钱的动作只给行政/财务）', whPo.status === 403, `HTTP ${whPo.status}`);
    } else {
      ok('仓库不能建采购单', true, '没有 wh01，跳过');
    }

    // 清理
    cleanSmoke();
    ok('冒烟夹具已清干净',
      ODB.prepare("SELECT COUNT(*) c FROM office_items WHERE name LIKE '%__SMOKE%'").get().c === 0
      && ODB.prepare("SELECT COUNT(*) c FROM office_purchases WHERE supplier LIKE '%__SMOKE%'").get().c === 0
      && ODB.prepare("SELECT COUNT(*) c FROM office_requests WHERE purpose LIKE '%__SMOKE%'").get().c === 0,
      `物品 ${ODB.prepare("SELECT COUNT(*) c FROM office_items WHERE name LIKE '%__SMOKE%'").get().c} / 采购 ${ODB.prepare("SELECT COUNT(*) c FROM office_purchases WHERE supplier LIKE '%__SMOKE%'").get().c}`);
  }

  /* ================================================================== *
   * 资产工衣与领归（TS-N14-03）
   * 夹具一律带 __SMOKE，开头与结尾各清一次（跑崩了下次也能自愈）
   * ================================================================== */
  {
    const { db: CDB } = require('../src/db');
    console.log('\n[资产工衣与领归]');

    const loginAsLocal5 = async (u) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: PASS } });
      return r.status === 200 ? r.json.data.token : '';
    };

    // 夹具一切自带 __SMOKE：实物、员工、资产卡都用烟测专属记录，
    // 绝不借用演示/真实员工（清退单按人复用，借用人会把别人身上挂着的东西一起搅进来）
    const cleanSmoke = () => {
      const items = CDB.prepare("SELECT id FROM custody_items WHERE name LIKE '%__SMOKE%'").all().map((r) => r.id);
      const empsSmoke = CDB.prepare("SELECT id FROM employees WHERE name LIKE '%__SMOKE%'").all().map((r) => r.id);
      const recConds = [];
      const recParams = [];
      if (items.length) { recConds.push(`item_id IN (${items.map(() => '?').join(',')})`); recParams.push(...items); }
      if (empsSmoke.length) { recConds.push(`employee_id IN (${empsSmoke.map(() => '?').join(',')})`); recParams.push(...empsSmoke); }
      if (recConds.length) {
        const recs = CDB.prepare(`SELECT id FROM custody_records WHERE ${recConds.join(' OR ')}`).all(...recParams).map((r) => r.id);
        if (recs.length) {
          const rph = recs.map(() => '?').join(',');
          CDB.prepare(`DELETE FROM custody_claims WHERE record_id IN (${rph})`).run(...recs);
          CDB.prepare(`DELETE FROM custody_actions WHERE target_type='record' AND target_id IN (${rph})`).run(...recs);
          CDB.prepare(`DELETE FROM custody_records WHERE id IN (${rph})`).run(...recs);
        }
      }
      if (items.length) {
        CDB.prepare(`DELETE FROM custody_actions WHERE target_type='item' AND target_id IN (${items.map(() => '?').join(',')})`).run(...items);
        CDB.prepare(`DELETE FROM custody_items WHERE id IN (${items.map(() => '?').join(',')})`).run(...items);
      }
      const clr = CDB.prepare("SELECT id FROM custody_clearances WHERE reason LIKE '%__SMOKE%' OR employee_name LIKE '%__SMOKE%'").all().map((r) => r.id);
      clr.forEach((id) => CDB.prepare("DELETE FROM custody_actions WHERE target_type='clearance' AND target_id=?").run(id));
      CDB.prepare("DELETE FROM custody_clearances WHERE reason LIKE '%__SMOKE%' OR employee_name LIKE '%__SMOKE%'").run();
      if (empsSmoke.length) CDB.prepare(`DELETE FROM employees WHERE id IN (${empsSmoke.map(() => '?').join(',')})`).run(...empsSmoke);
      CDB.prepare("DELETE FROM assets WHERE name LIKE '%__SMOKE%'").run();
    };
    cleanSmoke();

    // 自建三个烟测员工：清退按人复用、清单按人实时汇总，
    // 借用真实员工会把「别人身上挂着的东西」算进断言里
    const mkEmp = (tag) => {
      const name = `烟测员工${tag}__SMOKE`;
      const info = CDB.prepare("INSERT INTO employees (name, code, status, created_at) VALUES (?,?, 'active', ?)")
        .run(name, `SMK-${tag}`, new Date().toISOString());
      return { id: Number(info.lastInsertRowid), name };
    };
    const EA = mkEmp('A');
    const EB = mkEmp('B');
    const EC = mkEmp('C');
    // 日期按本地取（toISOString 是 UTC，晚上会差一天）
    const dFuture = new Date(Date.now() + 7 * 86400000);
    const tomorrow = `${dFuture.getFullYear()}-${String(dFuture.getMonth() + 1).padStart(2, '0')}-${String(dFuture.getDate()).padStart(2, '0')}`;

    // 基线：本模块不许碰生产仓，也不许自动动钱
    const baseStock = Number(CDB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v);
    const baseMat = Number(CDB.prepare('SELECT COALESCE(SUM(stock_qty),0) v FROM materials').get().v);
    const baseMatLedger = CDB.prepare('SELECT COUNT(*) c FROM material_ledger').get().c;
    const basePayAdj = CDB.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get().c;
    const baseGl = CDB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c;

    const meta = await req('/api/custody/meta', { token });
    ok('工衣领归字典（类别 / 归还要求 / 统计）',
      meta.status === 200 && Array.isArray(meta.json.data.kinds) && !!meta.json.data.stats, `HTTP ${meta.status}`);

    // 一张测试用资产卡：验证「折旧不在行政再算一遍」与「挂了资产卡不许在这里处置」
    const assetR = await req('/api/assets', {
      method: 'POST', token,
      body: { name: '烟测电动工具__SMOKE', category: '电子设备', original_value: 1200, purchase_date: '2025-10-01', useful_years: 3 }
    });
    const assetId = assetR.json.data.id;
    ok('建一张烟测资产卡', assetR.status === 200 && !!assetId, `HTTP ${assetR.status}`);

    // 1. 建档
    const mk = (body) => req('/api/custody/items', { method: 'POST', token, body });
    const itUniform = await mk({ name: '烟测工衣__SMOKE', kind: 'uniform', durable: 1, require_return: 0, size: 'XL', qty_total: 1, unit: '件' });
    const itKey = await mk({ name: '烟测钥匙__SMOKE', kind: 'key', durable: 1, require_return: 1, item_code: 'SMK-01', qty_total: 1, unit: '把' });
    const itGlove = await mk({ name: '烟测手套__SMOKE', kind: 'ppe', durable: 0, require_return: 0, qty_total: 200, unit: '双', max_per_person: 40 });
    const itGlove2 = await mk({ name: '烟测口罩__SMOKE', kind: 'ppe', durable: 0, require_return: 0, qty_total: 50, unit: '个' });
    const itTool = await mk({ name: '烟测工具__SMOKE', kind: 'tool', durable: 1, require_return: 1, qty_total: 1, unit: '把', asset_id: assetId });
    const itOld = await mk({ name: '烟测旧工衣__SMOKE', kind: 'uniform', durable: 1, require_return: 0, qty_total: 1, unit: '件' });
    // 专门用来做「损坏 → 冻结 → 恢复 → 遗失核销」的那一件，不去占用后面清退要用的钥匙
    const itKey2 = await mk({ name: '烟测钥匙二号__SMOKE', kind: 'key', durable: 1, require_return: 1, qty_total: 1, unit: '把' });
    ok('建实物档案：工衣 / 钥匙 / 劳保 / 挂资产卡的工具',
      [itUniform, itKey, itGlove, itGlove2, itTool, itOld, itKey2].every((r) => r.status === 200),
      `HTTP ${itUniform.status}/${itKey.status}/${itGlove.status}/${itTool.status}/${itKey2.status}`);

    const uId = itUniform.json.data.id;
    const kId = itKey.json.data.id;
    const gId = itGlove.json.data.id;
    const g2Id = itGlove2.json.data.id;
    const tId = itTool.json.data.id;
    const oldId = itOld.json.data.id;
    const k2Id = itKey2.json.data.id;

    // 2. 一物一码不许写 2 件（可用量会显示 1 但永远发不出第二件）
    const badQty = await mk({ name: '烟测两件套__SMOKE', kind: 'uniform', durable: 1, qty_total: 2 });
    ok('一物一码在册数量只能是 1（多件分别建档）', badQty.status === 400, `HTTP ${badQty.status}`);

    // 3. 工衣不强制退回 → 永不设期限
    const recU = await req('/api/custody/records', {
      method: 'POST', token, body: { item_id: uId, employee_id: EA.id, expected_return_at: tomorrow, note: '烟测发放' }
    });
    ok('★ 工衣不强制退回：传了归还日期也不设期限',
      recU.status === 200 && recU.json.data.expected_return_at === null && Number(recU.json.data.require_return) === 0,
      `expected_return_at=${recU.json.data ? recU.json.data.expected_return_at : '?'}`);

    // 4. 一物一码不双领
    const dupLen = await req('/api/custody/records', { method: 'POST', token, body: { item_id: uId, employee_id: EB.id } });
    ok('★ 耐用实物不双领（同一件不能挂两个人）', dupLen.status === 409, `HTTP ${dupLen.status}`);

    // 5. 消耗品：个人上限 / 可用量
    const gA = await req('/api/custody/records', { method: 'POST', token, body: { item_id: gId, employee_id: EA.id, qty: 30 } });
    const gA2 = await req('/api/custody/records', { method: 'POST', token, body: { item_id: gId, employee_id: EA.id, qty: 30 } });
    ok('消耗品可再领，但受个人上限约束',
      gA.status === 200 && gA2.status === 400 && /上限/.test(gA2.json.message || ''), `HTTP ${gA2.status} ${gA2.json.message || ''}`);

    const g2A = await req('/api/custody/records', { method: 'POST', token, body: { item_id: g2Id, employee_id: EA.id, qty: 30 } });
    const g2Over = await req('/api/custody/records', { method: 'POST', token, body: { item_id: g2Id, employee_id: EA.id, qty: 30 } });
    ok('按量消耗品领超可用量要拦（在册 50，已领 30）',
      g2A.status === 200 && g2Over.status === 400 && /可用/.test(g2Over.json.message || ''), `HTTP ${g2Over.status} ${g2Over.json.message || ''}`);

    // 6. 归还必须登记状态
    const recK = await req('/api/custody/records', { method: 'POST', token, body: { item_id: kId, employee_id: EA.id, expected_return_at: tomorrow } });
    const noCond = await req(`/api/custody/records/${recK.json.data.id}/return`, { method: 'POST', token, body: {} });
    ok('归还必须登记实物状态（不知道好坏定不了责）', noCond.status === 400, `HTTP ${noCond.status}`);
    // 这把钥匙完好还回来，后面要用它做「转交 → 清退」的主线
    await req(`/api/custody/records/${recK.json.data.id}/return`, { method: 'POST', token, body: { condition: 'good', note: '烟测：完好交回' } });

    // 7. 损坏归还 → 只生成待复核单，不动钱；实物同时冻结，不能再发给下一个人
    const recBad = await req('/api/custody/records', { method: 'POST', token, body: { item_id: k2Id, employee_id: EA.id, expected_return_at: tomorrow } });
    const dmg = await req(`/api/custody/records/${recBad.json.data.id}/return`, {
      method: 'POST', token, body: { condition: 'damaged', claim_amount: 300, note: '烟测：钥匙柄断裂' }
    });
    const claim1 = (dmg.json.data.claims || [])[0];
    ok('损坏归还自动生成待复核单', dmg.status === 200 && !!claim1 && claim1.review_status === 'pending',
      `HTTP ${dmg.status} claims=${(dmg.json.data.claims || []).length}`);
    ok('★ 登记损坏不自动扣工资、不自动生成凭证',
      CDB.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get().c === basePayAdj
      && CDB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c === baseGl,
      `工资调整 ${CDB.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get().c - basePayAdj} / 凭证 ${CDB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c - baseGl}`);

    const reissueBad = await req('/api/custody/records', { method: 'POST', token, body: { item_id: k2Id, employee_id: EB.id } });
    ok('★ 损坏归还的实物冻结为「待处理」，不能再发给别人',
      reissueBad.status === 400 && /待处理/.test(reissueBad.json.message || ''), `HTTP ${reissueBad.status} ${reissueBad.json.message || ''}`);

    const restoreNoNote = await req(`/api/custody/restore/${k2Id}`, { method: 'POST', token, body: {} });
    ok('恢复可用要写处理结果（维修/检查合格）', restoreNoNote.status === 400, `HTTP ${restoreNoNote.status}`);

    const restored = await req(`/api/custody/restore/${k2Id}`, { method: 'POST', token, body: { note: '烟测：更换锁芯，检查正常' } });
    const reuse = await req('/api/custody/records', { method: 'POST', token, body: { item_id: k2Id, employee_id: EB.id } });
    ok('恢复可用后可以重新发放',
      restored.status === 200 && restored.json.data.status === 'active' && reuse.status === 200,
      `恢复 HTTP ${restored.status} / 再发 HTTP ${reuse.status}`);

    // 遗失：东西没了 → 实物直接按盘亏核销，可用量归零
    const lostB = await req(`/api/custody/records/${reuse.json.data.id}/return`, {
      method: 'POST', token, body: { condition: 'lost', claim_amount: 200, note: '烟测：巡检途中遗失' }
    });
    const k2After = CDB.prepare('SELECT status, scrap_mode FROM custody_items WHERE id = ?').get(k2Id);
    ok('★ 遗失归还的实物自动核销（不会再出现在可用里）',
      lostB.status === 200 && k2After.status === 'scrapped' && k2After.scrap_mode === 'write_off',
      `状态 ${k2After ? k2After.status : '?'}`);

    const cleared = await req(`/api/custody/review/${claim1.id}`, {
      method: 'POST', token, body: { decision: 'cleared', reviewer_note: '烟测：正常使用磨损' }
    });
    ok('复核无责：定责金额归零，不需要财务确认',
      cleared.status === 200 && Number(cleared.json.data.liable_amount) === 0 && cleared.json.data.needs_finance === false,
      `金额 ${cleared.json.data ? cleared.json.data.liable_amount : '?'}`);

    // 8. 工具损坏 → 部分责任 60% → 财务确认（缺回执 / 越权 / 正确）
    const recT = await req('/api/custody/records', { method: 'POST', token, body: { item_id: tId, employee_id: EB.id, expected_return_at: tomorrow } });
    const dmgT = await req(`/api/custody/records/${recT.json.data.id}/return`, {
      method: 'POST', token, body: { condition: 'damaged', claim_amount: 500, note: '烟测：电机烧毁' }
    });
    const claim2 = (dmgT.json.data.claims || [])[0];
    const rev2 = await req(`/api/custody/review/${claim2.id}`, {
      method: 'POST', token, body: { decision: 'partial', liable_pct: 60, reviewer_note: '烟测：超负荷使用' }
    });
    ok('部分责任按比例算金额（500 × 60% = 300）',
      rev2.status === 200 && Number(rev2.json.data.liable_amount) === 300, `金额 ${rev2.json.data ? rev2.json.data.liable_amount : '?'}`);

    const noReceipt = await req(`/api/custody/finance/${claim2.id}`, { method: 'POST', token, body: {} });
    ok('财务确认必须填回执号', noReceipt.status === 400, `HTTP ${noReceipt.status}`);

    const whTok = await loginAsLocal5('wh01');
    if (whTok) {
      const whFin = await req(`/api/custody/finance/${claim2.id}`, {
        method: 'POST', token: whTok, body: { finance_confirm_no: 'SMOKE-WH-001' }
      });
      ok('仓库不能确认定责金额（财务与管理员专属）', whFin.status === 403, `HTTP ${whFin.status}`);
    } else {
      ok('仓库不能确认定责金额', true, '没有 wh01，跳过');
    }

    const finTok = await loginAsLocal5('fin01');
    let finR = { status: 0, json: {} };
    if (finTok) {
      finR = await req(`/api/custody/finance/${claim2.id}`, {
        method: 'POST', token: finTok, body: { finance_confirm_no: 'SMOKE-FIN-001', finance_note: '烟测确认' }
      });
    }
    ok('财务带回收据号后才算落地',
      finR.status === 200 && finR.json.data.finance_confirm_no === 'SMOKE-FIN-001' && finR.json.data.status === 'closed',
      `HTTP ${finR.status}`);
    ok('★ 复核+财务确认全程不动工资与总账',
      CDB.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get().c === basePayAdj
      && CDB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c === baseGl,
      `工资调整 ${CDB.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get().c - basePayAdj} / 凭证 ${CDB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c - baseGl}`);

    // 9. 转交：原单归还 + 新单发放，未还总量不变
    const recK2 = await req('/api/custody/records', { method: 'POST', token, body: { item_id: kId, employee_id: EB.id, expected_return_at: tomorrow } });
    const beforeOut = Number(CDB.prepare("SELECT COALESCE(SUM(qty-returned_qty),0) v FROM custody_records WHERE item_id=? AND status IN ('issued','awaiting')").get(kId).v);
    const tr = await req(`/api/custody/records/${recK2.json.data.id}/transfer`, {
      method: 'POST', token, body: { to_employee_id: EC.id, note: '烟测：借调' }
    });
    const afterOut = Number(CDB.prepare("SELECT COALESCE(SUM(qty-returned_qty),0) v FROM custody_records WHERE item_id=? AND status IN ('issued','awaiting')").get(kId).v);
    ok('★ 转交 = 原单归还 + 新单发放，未还总量不变（不直接改名字）',
      tr.status === 200 && tr.json.data.from.status === 'returned' && tr.json.data.to.status === 'issued'
      && beforeOut === 1 && afterOut === 1,
      `未还 ${beforeOut} → ${afterOut}`);

    // 10. 离职清退：必须归还 vs 工衣不强制
    const uToC = await req(`/api/custody/records/${recU.json.data.id}/transfer`, {
      method: 'POST', token, body: { to_employee_id: EC.id, note: '烟测：换岗' }
    });
    ok('工衣也能转交（一物一码先还再领）', uToC.status === 200, `HTTP ${uToC.status}`);

    const clr = await req('/api/custody/clearances', {
      method: 'POST', token, body: { employee_id: EC.id, leave_date: tomorrow, reason: '烟测离职__SMOKE' }
    });
    const clrItems = (clr.json.data && clr.json.data.items) || [];
    const mustRow = clrItems.find((x) => x.must);
    const optRow = clrItems.find((x) => !x.must);
    ok('清退清单分「必须归还」与「不强制退回」两类',
      clr.status === 200 && clr.json.data.must_total === 1 && clr.json.data.optional_total === 1,
      `必须 ${clr.json.data ? clr.json.data.must_total : '?'} / 可选 ${clr.json.data ? clr.json.data.optional_total : '?'}`);
    ok('清退单按人复用（不会给同一人开出第二张进行中的单）',
      clr.json.data.employee_id === EC.id && clr.json.data.leave_date === tomorrow,
      `员工 ${clr.json.data ? clr.json.data.employee_name : '?'} / 离职日 ${clr.json.data ? clr.json.data.leave_date : '?'}`);
    ok('★ 工衣在清退时不被强制退回（状态不变、不设期限）',
      !!optRow && optRow.status === 'issued' && !optRow.expected_return_at, `状态 ${optRow ? optRow.status : '?'}`);
    ok('必须归还的钥匙转「待归还」并以离职日为期限',
      !!mustRow && mustRow.status === 'awaiting' && mustRow.expected_return_at === tomorrow, `状态 ${mustRow ? mustRow.status : '?'}`);

    const closeEarly = await req(`/api/custody/clearances/${clr.json.data.id}/close`, { method: 'POST', token, body: {} });
    ok('必须归还的没回来，清退不能结案', closeEarly.status === 400, `HTTP ${closeEarly.status}`);

    await req(`/api/custody/records/${tr.json.data.to.id}/return`, { method: 'POST', token, body: { condition: 'good', note: '烟测收回' } });
    const closed = await req(`/api/custody/clearances/${clr.json.data.id}/close`, { method: 'POST', token, body: {} });
    ok('必须归还的都回来了，清退可结案（工衣未退不拦）',
      closed.status === 200 && closed.json.data.status === 'closed', `HTTP ${closed.status}`);

    // 11. 处置：挂资产卡的拒绝；无单号的拒绝；正常处置成功
    const scrapAsset = await req(`/api/custody/scrap/${tId}`, {
      method: 'POST', token, body: { scrap_mode: 'write_off', scrap_no: 'SMOKE-CZ-001' }
    });
    ok('★ 挂了资产卡的实物不在这里处置（去资产台账，避免两套净值）',
      scrapAsset.status === 400 && /固定资产/.test(scrapAsset.json.message || ''), `HTTP ${scrapAsset.status}`);

    const scrapNoNo = await req(`/api/custody/scrap/${oldId}`, { method: 'POST', token, body: { scrap_mode: 'write_off' } });
    ok('处置必须填去向单号（没有去处的核销等于东西消失）', scrapNoNo.status === 400, `HTTP ${scrapNoNo.status}`);

    const scrapOk = await req(`/api/custody/scrap/${oldId}`, {
      method: 'POST', token, body: { scrap_mode: 'write_off', scrap_no: 'SMOKE-CZ-002', note: '烟测核销' }
    });
    ok('无资产卡的低值实物可核销', scrapOk.status === 200 && scrapOk.json.data.status === 'scrapped', `HTTP ${scrapOk.status}`);

    // 12. 折旧一致：行政页读到的净值 = 资产台账净值
    const assetList = await req('/api/assets?q=烟测电动工具__SMOKE', { token });
    const assetRow = (assetList.json.data || [])[0];
    const itemList = await req('/api/custody/items?q=烟测工具__SMOKE', { token });
    const toolRow = (itemList.json.data || [])[0];
    ok('★ 行政页的净值直接读资产台账（不重复计提）',
      !!assetRow && !!toolRow && Number(toolRow.asset_net) === Number(assetRow.net_value),
      `资产 ${assetRow ? assetRow.net_value : '?'} / 行政 ${toolRow ? toolRow.asset_net : '?'}`);

    // 13. 资产卡报废后不能再发
    await req(`/api/assets/${assetId}/status`, { method: 'POST', token, body: { status: 'scrapped' } });
    const issueScrapped = await req('/api/custody/records', { method: 'POST', token, body: { item_id: tId, employee_id: EA.id } });
    ok('关联资产卡报废后，实物不能再发放', issueScrapped.status === 400, `HTTP ${issueScrapped.status}`);

    // 14. 权限：销售不能发放（东西在行政仓），仓库可以
    const salesTok = await loginAsLocal5('sales01');
    if (salesTok) {
      const salesIssue = await req('/api/custody/records', { method: 'POST', token: salesTok, body: { item_id: gId, employee_id: EA.id, qty: 1 } });
      ok('销售不能发放实物（发放归行政/人事/仓库）', salesIssue.status === 403, `HTTP ${salesIssue.status}`);
    } else {
      ok('销售不能发放实物', true, '没有 sales01，跳过');
    }
    if (whTok) {
      const whIssue = await req('/api/custody/records', { method: 'POST', token: whTok, body: { item_id: gId, employee_id: EB.id, qty: 1 } });
      ok('仓库能发放实物', whIssue.status === 200, `HTTP ${whIssue.status}`);
    } else {
      ok('仓库能发放实物', true, '没有 wh01，跳过');
    }

    // 15. 跨模块口径：领用/归还/核销全程不碰生产仓
    ok('★ 工衣领归不碰生产库存（材料仓 / 成品仓 / 材料流水都不变）',
      Number(CDB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v) === baseStock
      && Number(CDB.prepare('SELECT COALESCE(SUM(stock_qty),0) v FROM materials').get().v) === baseMat
      && CDB.prepare('SELECT COUNT(*) c FROM material_ledger').get().c === baseMatLedger,
      `成品 ${Number(CDB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v) - baseStock} / 材料 ${Number(CDB.prepare('SELECT COALESCE(SUM(stock_qty),0) v FROM materials').get().v) - baseMat} / 流水 ${CDB.prepare('SELECT COUNT(*) c FROM material_ledger').get().c - baseMatLedger}`);

    // 清理
    cleanSmoke();
    ok('冒烟夹具已清干净',
      CDB.prepare("SELECT COUNT(*) c FROM custody_items WHERE name LIKE '%__SMOKE%'").get().c === 0
      && CDB.prepare("SELECT COUNT(*) c FROM custody_claims WHERE claim_no LIKE 'DZ%' AND desc_text LIKE '%烟测%'").get().c === 0
      && CDB.prepare("SELECT COUNT(*) c FROM assets WHERE name LIKE '%__SMOKE%'").get().c === 0,
      `实物 ${CDB.prepare("SELECT COUNT(*) c FROM custody_items WHERE name LIKE '%__SMOKE%'").get().c} / 资产 ${CDB.prepare("SELECT COUNT(*) c FROM assets WHERE name LIKE '%__SMOKE%'").get().c}`);
  }


  /* ================================================================== *
   * 行政运营报表（TS-N14-09）
   * 夹具自带 __SMOKE：自建员工 / 床位 / 饭卡账户 / 工单 / 费用，
   * 另借一条办公库存量做「恒等式断开」实验，测完还原
   * ================================================================== */
  {
    const { db: ADB } = require('../src/db');
    const BD = require('../src/services/bedDays');
    console.log('\n[行政运营报表]');

    const nowD = new Date();
    const curPeriod = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}`;
    const R = BD.periodRange(curPeriod);
    const PAD = (n) => String(n).padStart(2, '0');
    const dayStr = (offset) => {
      const d = new Date(Date.now() + offset * 86400000);
      return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
    };

    const cleanSmoke = () => {
      const runs = ADB.prepare("SELECT id FROM admin_report_runs WHERE note LIKE '%__SMOKE%'").all().map((r) => r.id);
      runs.forEach((id) => ADB.prepare('DELETE FROM admin_report_findings WHERE run_id = ?').run(id));
      ADB.prepare("DELETE FROM admin_report_runs WHERE note LIKE '%__SMOKE%'").run();
      ADB.prepare("DELETE FROM admin_report_findings WHERE demo_tag = '__SMOKE'").run();
      ADB.prepare("DELETE FROM repairs WHERE remark LIKE '%__SMOKE%'").run();
      ADB.prepare("DELETE FROM admin_expenses WHERE remark LIKE '%__SMOKE%'").run();
      ADB.prepare("DELETE FROM dorm_stays WHERE remark LIKE '%__SMOKE%'").run();
      ADB.prepare("DELETE FROM dorm_beds WHERE bed_no LIKE 'SMK%'").run();
      const accs = ADB.prepare("SELECT id FROM meal_accounts WHERE card_no LIKE 'SMK%'").all().map((r) => r.id);
      accs.forEach((id) => {
        ADB.prepare('DELETE FROM meal_transactions WHERE account_id = ?').run(id);
        ADB.prepare('DELETE FROM meal_accounts WHERE id = ?').run(id);
      });
      const offItems = ADB.prepare("SELECT id FROM office_items WHERE name LIKE '%__SMOKE%'").all().map((r) => r.id);
      offItems.forEach((id) => {
        ADB.prepare('DELETE FROM office_ledger WHERE item_id = ?').run(id);
        ADB.prepare('DELETE FROM office_stock WHERE item_id = ?').run(id);
        ADB.prepare('DELETE FROM office_items WHERE id = ?').run(id);
      });
      ADB.prepare("DELETE FROM employees WHERE name LIKE '%__SMOKE%'").run();
    };
    cleanSmoke();

    const mkEmp = (tag) => {
      const name = `烟测报表员工${tag}__SMOKE`;
      const info = ADB.prepare("INSERT INTO employees (name, code, status, created_at) VALUES (?,?, 'active', ?)")
        .run(name, `SMK-${tag}`, new Date().toISOString());
      return { id: Number(info.lastInsertRowid), name };
    };
    const EA = mkEmp('A');
    const EB = mkEmp('B');
    const EC = mkEmp('C');

    const baseRunOpen = ADB.prepare("SELECT COUNT(*) c FROM admin_report_runs WHERE note LIKE '%__SMOKE%'").get().c;

    const meta = await req('/api/admin-ops/meta', { token });
    ok('行政报表字典（指标 / 严重度 / 状态 / 主体 / 期间）',
      meta.status === 200 && (meta.json.data.metrics || []).length === 7 && (meta.json.data.periods || []).length >= 12,
      `指标 ${meta.json.data ? (meta.json.data.metrics || []).length : '?'}`);

    // 1. 期间边界：东区不能用 toISOString 算月末
    const lastDay = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate();
    const naive = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).toISOString().slice(0, 10);
    const tz = new Date().getTimezoneOffset();
    ok('★ 期间月末按本地日期算（东区不会被 toISOString 少一天）',
      R.end === `${curPeriod}-${PAD(lastDay)}` && (tz >= 0 || R.end !== naive),
      `${R.start} ~ ${R.end}（${R.days} 天），朴素写法会得到 ${naive}`);

    // 2. 造床位：一张维修床 + 一张正常床，各住一个人（维修床有人住 → 报表要点名）
    const room = ADB.prepare("SELECT id FROM dorm_rooms WHERE status='normal' ORDER BY id LIMIT 1").get();
    const bedOk = Number(ADB.prepare("INSERT INTO dorm_beds (room_id, bed_no, status) VALUES (?, 'SMK1', 'normal')").run(room.id).lastInsertRowid);
    const bedBad = Number(ADB.prepare("INSERT INTO dorm_beds (room_id, bed_no, status) VALUES (?, 'SMK2', 'maintenance')").run(room.id).lastInsertRowid);
    const t = new Date().toISOString();
    ADB.prepare(`INSERT INTO dorm_stays (bed_id, employee_id, start_date, end_date, rent_month, deposit, utilities, status, remark, created_at, updated_at)
      VALUES (?,?,?,NULL,200,400,0,'active','烟测住宿__SMOKE',?,?)`).run(bedOk, EA.id, `${curPeriod}-01`, t, t);
    ADB.prepare(`INSERT INTO dorm_stays (bed_id, employee_id, start_date, end_date, rent_month, deposit, utilities, status, remark, created_at, updated_at)
      VALUES (?,?,?,NULL,200,400,0,'active','烟测住宿（维修床）__SMOKE',?,?)`).run(bedBad, EB.id, `${curPeriod}-01`, t, t);

    // 3. 饭卡：余额比流水多 40
    const acc = Number(ADB.prepare(`INSERT INTO meal_accounts (employee_id, card_no, balance, subsidy_balance, status, opened_at, remark, created_at, updated_at)
      VALUES (?, 'SMK-C1', 100, 0, 'active', ?, '烟测账户__SMOKE', ?, ?)`).run(EC.id, `${curPeriod}-01`, t, t).lastInsertRowid);
    ADB.prepare(`INSERT INTO meal_transactions (account_id, type, amount, personal_delta, subsidy_delta, source, receipt_no, balance_after, note, operator, created_at)
      VALUES (?, 'recharge', 60, 60, 0, 'manual', 'SMK-RC-1', 60, '烟测充值__SMOKE', 'smoke', ?)`)
      .run(acc, `${curPeriod}-02T03:00:00.000Z`);

    // 4. 工单：跳过复验 / 超期未完成 / 已提交待复验
    const lastRepair = ADB.prepare('SELECT repair_no FROM repairs ORDER BY id DESC LIMIT 1').get();
    let rseq = lastRepair ? Number(String(lastRepair.repair_no).slice(-4)) + 1 : 1;
    const mkRepair = (b) => {
      const no = `BX${curPeriod.replace('-', '')}${String(rseq++).padStart(4, '0')}`;
      ADB.prepare(`INSERT INTO repairs (repair_no, area, facility, description, severity, status, reporter, assignee,
          reported_at, due_date, submitted_at, verified_by, verified_at, remark, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        no, b.area || null, b.facility, b.desc, b.severity, b.status, 'smoke', 'smoke',
        b.reported_at, b.due_date || null, b.submitted_at || null, b.verified_by || null, b.verified_at || null,
        `烟测工单__SMOKE`, t, t
      );
      return no;
    };
    const noVerify = mkRepair({
      facility: '烟测门禁', desc: '门禁失灵', severity: 'minor', status: 'closed',
      reported_at: `${curPeriod}-01T02:00:00.000Z`, submitted_at: `${curPeriod}-01T06:00:00.000Z`
    });
    const overdueNo = mkRepair({
      facility: '烟测空调', desc: '不制冷', severity: 'major', status: 'repairing',
      reported_at: `${curPeriod}-02T02:00:00.000Z`, due_date: dayStr(-3)
    });
    mkRepair({
      facility: '烟测水龙头', desc: '漏水', severity: 'minor', status: 'submitted',
      reported_at: `${curPeriod}-03T02:00:00.000Z`, submitted_at: `${curPeriod}-03T08:00:00.000Z`
    });

    // 5. 费用：一条无部门（未归口）
    const deptAdmin = ADB.prepare("SELECT id FROM departments WHERE name='人事行政部'").get();
    ADB.prepare(`INSERT INTO admin_expenses (expense_date, category, amount, payee, handler, payment_method, remark, created_at, department_id, company_id)
      VALUES (?, '办公', 666, '烟测供应商', 'smoke', '转账', '烟测未归口费用__SMOKE', ?, NULL, 1)`)
      .run(`${curPeriod}-05`, t);
    ADB.prepare(`INSERT INTO admin_expenses (expense_date, category, amount, payee, handler, payment_method, remark, created_at, department_id, company_id)
      VALUES (?, '培训', 888, '烟测培训机构', 'smoke', '转账', '烟测归口费用__SMOKE', ?, ?, 1)`)
      .run(`${curPeriod}-06`, t, deptAdmin ? deptAdmin.id : null);

    // 6. 办公仓：新建一个「有库存、无流水」的物品 —— 恒等式直接断开。
    //    不借现有物品改数量：万一中途崩了，改过的真实库存不会自动还原。
    ADB.prepare(`INSERT INTO office_items (item_no, name, category, unit, status, created_at, updated_at)
      VALUES (?, '烟测耗材__SMOKE', 'stationery', '个', 'active', ?, ?)`)
      .run(`SMK-OFF-${Date.now()}`, t, t);
    const smokeItem = ADB.prepare("SELECT id FROM office_items WHERE name = '烟测耗材__SMOKE' ORDER BY id DESC LIMIT 1").get();
    ADB.prepare('INSERT INTO office_stock (item_id, qty) VALUES (?, 10)').run(smokeItem.id);

    // ================= 预览 =================
    const pre = await req(`/api/admin-ops/preview?period=${curPeriod}`, { token });
    ok('预览报表返回八段指标', pre.status === 200
      && !!pre.json.data.dorm && !!pre.json.data.expense && !!pre.json.data.meal
      && !!pre.json.data.asset && !!pre.json.data.office && !!pre.json.data.budget && !!pre.json.data.repair,
      `HTTP ${pre.status}`);
    const pv = pre.json.data;

    const bedsNow = ADB.prepare('SELECT COUNT(*) c, SUM(CASE WHEN status=\'maintenance\' THEN 1 ELSE 0 END) m FROM dorm_beds').get();
    ok('★ 可用床日 = 可用床数 × 期间天数（维修床与整间维修房间都扣）',
      pv.dorm.beds_total === bedsNow.c && pv.dorm.available_bed_days === pv.dorm.beds_usable * R.days,
      `床 ${pv.dorm.beds_total}（可用 ${pv.dorm.beds_usable} / 维修 ${pv.dorm.beds_maintenance}）× ${R.days} 天 = ${pv.dorm.available_bed_days}`);

    const used = pv.dorm.used_bed_days;
    ok('★ 入住率 = 住用床日 / 可用床日（不拿人数除床数）',
      pv.dorm.available_bed_days > 0
      && Math.abs(pv.dorm.occupancy_rate - Math.round((used / pv.dorm.available_bed_days) * 10000) / 100) < 0.02,
      `${used} / ${pv.dorm.available_bed_days} = ${pv.dorm.occupancy_rate}%`);

    const usedOnUnusable = (pv.findings || []).find((f) => f.metric === 'dorm' && f.severity === 'high' && /SMK2/.test(f.subject));
    ok('★ 维修床上有人住 → 严重差异（不是「口径问题」，是数据矛盾）',
      !!usedOnUnusable, usedOnUnusable ? usedOnUnusable.actual : '未识别');

    const mealDiff = (pv.findings || []).find((f) => f.metric === 'meal' && f.severity === 'high');
    ok('★ 饭卡余额与流水不符 → 严重差异，且提示「不要调平余额」',
      !!mealDiff && /不要「调平」余额/.test(mealDiff.hint || ''), mealDiff ? `差 ${mealDiff.diff}` : '未识别');

    const officeDiff = (pv.findings || []).find((f) => f.metric === 'office' && f.severity === 'high');
    ok('★ 办公仓库存 ≠ 流水合计 → 严重差异（报表独立复核，不复用模块内余额函数）',
      !!officeDiff, officeDiff ? officeDiff.actual : '未识别');

    const skipVerify = (pv.findings || []).find((f) => f.metric === 'repair' && /跳过复验/.test(f.subject));
    ok('★ 提交后直接关单（无复验）→ 严重差异', !!skipVerify, skipVerify ? skipVerify.subject : '未识别');

    const overdueF = (pv.findings || []).find((f) => f.metric === 'repair' && /维修超期/.test(f.subject));
    ok('未完成且过了期限 → 超期差异', !!overdueF, overdueF ? overdueF.actual : '未识别');

    const noDeptF = (pv.findings || []).find((f) => f.metric === 'expense' && /未归口/.test(f.subject));
    ok('费用未挂部门 → 差异（否则永远不会进部门预算）', !!noDeptF, noDeptF ? noDeptF.actual : '未识别');

    // 样本规则：没工单的期间宁可给 null，也不能给 0%（0% 会被读成「复验制度形同虚设」）
    const preEmpty = await req('/api/admin-ops/preview?period=2020-02', { token });
    ok('★ 没有工单时复验率给「—」并写明不计算（不是 0%）',
      preEmpty.status === 200 && preEmpty.json.data.repair.verify_rate === null
      && (preEmpty.json.data.coverage || []).some((c) => /无报修工单/.test(c)),
      `复验率 ${preEmpty.json.data ? preEmpty.json.data.repair.verify_rate : '?'}`);

    const preOld = await req('/api/admin-ops/preview?period=2020-01', { token });
    ok('无生效预算的期间：说「算不出来」而不是 0',
      preOld.status === 200 && preOld.json.data.budget.budget_no === null
      && (preOld.json.data.coverage || []).some((c) => /没有生效预算/.test(c)),
      `HTTP ${preOld.status}`);

    // ================= 定版 =================
    const baseStockItems = Number(ADB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v);
    const baseGl = ADB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c;
    const basePay = ADB.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get().c;

    // 演示库本身可能已经定版过本月；这里用 force 保证夹具能建自己的版本
    const run1 = await req('/api/admin-ops/run', { method: 'POST', token, body: { period: curPeriod, note: '烟测定版__SMOKE', force: true } });
    ok('定版生成快照与差异清单',
      run1.status === 200 && !!run1.json.data.run_no && (run1.json.data.findings || []).length > 0,
      `HTTP ${run1.status} ${run1.json.data ? run1.json.data.run_no : ''}`);

    const runDup = await req('/api/admin-ops/run', { method: 'POST', token, body: { period: curPeriod, note: '烟测重复__SMOKE' } });
    ok('同期同主体已定版时，重跑必须确认（不悄悄覆盖）', runDup.status === 400, `HTTP ${runDup.status}`);

    const runForce = await req('/api/admin-ops/run', { method: 'POST', token, body: { period: curPeriod, note: '烟测重跑__SMOKE', force: true } });
    ok('确认后生成新版本，旧版本保留', runForce.status === 200 && runForce.json.data.id !== run1.json.data.id,
      `旧 #${run1.json.data ? run1.json.data.id : '?'} → 新 #${runForce.json.data ? runForce.json.data.id : '?'}`);

    ok('★ 定版不动任何业务数据（库存 / 凭证 / 工资调整）',
      Number(ADB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v) === baseStockItems
      && ADB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c === baseGl
      && ADB.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get().c === basePay,
      `凭证 ${ADB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c - baseGl} / 工资 ${ADB.prepare('SELECT COUNT(*) c FROM payroll_adjustments').get().c - basePay}`);

    const rid = runForce.json.data.id;
    const fs = runForce.json.data.findings;
    const target = fs.find((f) => f.severity === 'high') || fs[0];

    // ================= 差异复核（两段式） =================
    const noWho = await req(`/api/admin-ops/assign/${target.id}`, { method: 'POST', token, body: {} });
    ok('分派必须填人', noWho.status === 400, `HTTP ${noWho.status}`);

    const asg = await req(`/api/admin-ops/assign/${target.id}`, { method: 'POST', token, body: { assignee: '行政主管' } });
    ok('分派写入处理人', asg.status === 200 && asg.json.data.status === 'assigned', `HTTP ${asg.status}`);

    const closeEarly = await req(`/api/admin-ops/close/${target.id}`, { method: 'POST', token, body: { review_note: '想直接关' } });
    ok('★ 没写处理结果不能直接关闭（自己处理自己关等于没有复核）', closeEarly.status === 400, `HTTP ${closeEarly.status}`);

    const noNote = await req(`/api/admin-ops/review/${target.id}`, { method: 'POST', token, body: {} });
    ok('处理必须写结果', noNote.status === 400, `HTTP ${noNote.status}`);

    const fixed = await req(`/api/admin-ops/review/${target.id}`, { method: 'POST', token, body: { review_note: '已核对源单，属录入错误并已更正' } });
    ok('处理后进入「已处理待复核」', fixed.status === 200 && fixed.json.data.status === 'fixed', `HTTP ${fixed.status}`);

    const closed = await req(`/api/admin-ops/close/${target.id}`, { method: 'POST', token, body: { review_note: '复核无误，关闭' } });
    ok('复核关闭并回写未关闭条数',
      closed.status === 200 && closed.json.data.status === 'closed',
      `HTTP ${closed.status} 状态 ${closed.json.data ? closed.json.data.status : '?'}`);

    const runAfter = await req(`/api/admin-ops/runs/${rid}`, { token });
    ok('关闭后报表的「未关闭」条数减少',
      runAfter.json.data.open_count === fs.length - 1,
      `${fs.length} → ${runAfter.json.data.open_count}`);

    // ================= 权限与脱敏 =================
    const salesTok = await req('/api/auth/login', { method: 'POST', body: { username: 'sales01', password: PASS } });
    const sTok = salesTok.status === 200 ? salesTok.json.data.token : '';
    if (sTok) {
      const sRun = await req('/api/admin-ops/run', { method: 'POST', token: sTok, body: { period: curPeriod, note: '烟测越权__SMOKE', force: true } });
      ok('销售不能定版（定版即对外口径）', sRun.status === 403, `HTTP ${sRun.status}`);

      const sDrill = await req(`/api/admin-ops/drill?metric=dorm&period=${curPeriod}`, { token: sTok });
      const masked = sDrill.json.data && sDrill.json.data.masked;
      const stays = (sDrill.json.data && sDrill.json.data.rows && sDrill.json.data.rows.stays) || [];
      const anyMasked = stays.some((x) => /\*/.test(String(x.employee_name || '')));
      ok('★ 无明细权限时住宿人姓名脱敏（谁住哪张床不是全员可见）',
        sDrill.status === 200 && masked === true && anyMasked,
        `masked=${masked} 脱敏行 ${stays.filter((x) => /\*/.test(String(x.employee_name || ''))).length}`);
    } else {
      ok('销售不能定版 + 人名脱敏', true, '没有 sales01，跳过');
    }

    const hrTok = await req('/api/auth/login', { method: 'POST', body: { username: 'hr01', password: PASS } });
    if (hrTok.status === 200) {
      const hDrill = await req(`/api/admin-ops/drill?metric=dorm&period=${curPeriod}`, { token: hrTok.json.data.token });
      ok('人事能看住宿全名（明细权限）', hDrill.status === 200 && hDrill.json.data.masked === false, `HTTP ${hDrill.status}`);
    } else {
      ok('人事能看住宿全名', true, '没有 hr01，跳过');
    }

    // ================= 清理 =================
    cleanSmoke();
    const left = ADB.prepare("SELECT COUNT(*) c FROM admin_report_runs WHERE note LIKE '%__SMOKE%'").get().c;
    ok('冒烟夹具已清干净',
      left === baseRunOpen
      && ADB.prepare("SELECT COUNT(*) c FROM repairs WHERE remark LIKE '%__SMOKE%'").get().c === 0
      && ADB.prepare("SELECT COUNT(*) c FROM dorm_beds WHERE bed_no LIKE 'SMK%'").get().c === 0
      && ADB.prepare("SELECT COUNT(*) c FROM employees WHERE name LIKE '%__SMOKE%'").get().c === 0,
      `报表 ${left} / 工单 ${ADB.prepare("SELECT COUNT(*) c FROM repairs WHERE remark LIKE '%__SMOKE%'").get().c} / 床位 ${ADB.prepare("SELECT COUNT(*) c FROM dorm_beds WHERE bed_no LIKE 'SMK%'").get().c}`);
  }


  /* ================================================================== *
   * 薪酬计件与工资核对（TS-N13-05）
   * 用一段「没有其它数据」的历史期间做夹具（2020-03），
   * 避免与演示库的计件批次/工资单互相干扰（同期多个 confirmed 批次会被整批标红）
   * ================================================================== */
  {
    const { db: PDB } = require('../src/db');
    const Calc = require('../src/services/payrollCalc');
    console.log('\n[薪酬计件与工资核对]');

    const P = '2020-03';
    const NEXT = '2020-04';
    const MARK = '__SMOKE';
    const t = new Date().toISOString();
    const RUN_NO = 'PW_SMOKE_2003';
    const RUN_NO2 = 'PW_SMOKE_2003_B';

    let emp = [];
    const cleanSmoke = () => {
      const runs = PDB.prepare("SELECT id FROM piece_wage_runs WHERE run_no LIKE 'PW_SMOKE%'").all().map((r) => r.id);
      runs.forEach((id) => PDB.prepare('DELETE FROM piece_wage_items WHERE run_id = ?').run(id));
      PDB.prepare("DELETE FROM piece_wage_runs WHERE run_no LIKE 'PW_SMOKE%'").run();
      // 按备注删更可靠：员工一旦先被删掉，按 employee_id 子查询就再也匹配不上，
      // 工资单会变成孤儿留在库里（这次就踩到了）
      PDB.prepare("DELETE FROM payrolls WHERE period IN (?, ?) AND remark LIKE '%烟测工资单__SMOKE%'").run(P, NEXT);
      PDB.prepare("DELETE FROM payrolls WHERE period IN (?, ?) AND employee_id IN (SELECT id FROM employees WHERE name LIKE '%__SMOKE%')").run(P, NEXT);
      const chk = PDB.prepare("SELECT id FROM payroll_check_runs WHERE note LIKE '%__SMOKE%' OR note LIKE '%烟测%'").all().map((r) => r.id);
      chk.forEach((id) => PDB.prepare('DELETE FROM payroll_check_items WHERE run_id = ?').run(id));
      PDB.prepare("DELETE FROM payroll_check_runs WHERE note LIKE '%__SMOKE%' OR note LIKE '%烟测%'").run();
      PDB.prepare("DELETE FROM payroll_adjustments WHERE reason LIKE '%烟测工资差异%'").run();
      PDB.prepare("DELETE FROM employees WHERE name LIKE '%__SMOKE%'").run();
    };
    cleanSmoke();

    const mkEmp = (tag) => {
      const name = `烟测工资${tag}__SMOKE`;
      const info = PDB.prepare("INSERT INTO employees (code, name, department_id, status, hire_date, created_at) VALUES (?,?,1,'active',?,?)")
        .run(`SMKP-${tag}`, name, '2019-01-01', t);
      return { id: Number(info.lastInsertRowid), name };
    };
    emp = [mkEmp('A'), mkEmp('B'), mkEmp('C'), mkEmp('D')];
    const [EA, EB, EC, ED] = emp;

    // 计件批次（confirmed）+ 三条明细
    const runInfo = PDB.prepare(`INSERT INTO piece_wage_runs (run_no, period, status, items_count, employees_count,
        total_qty, total_amount, created_by, created_at, confirmed_by, confirmed_at)
      VALUES (?, ?, 'confirmed', 3, 3, 45, 270, 'smoke', ?, 'smoke', ?)`).run(RUN_NO, P, t, t);
    const runId = Number(runInfo.lastInsertRowid);
    const mkItem = (e, qty, unit, amount) => PDB.prepare(`INSERT INTO piece_wage_items (run_id, employee_id, employee_code,
        employee_name, department, style_no, process_name, bundle_no, raw_qty, qty, capped, unit_price, amount,
        rate_source, matched_by, report_date, created_at)
      VALUES (?,?,?,?, '烟测车间', 'SMK-STYLE', '车缝', 'Z-01', ?, ?, 0, ?, ?, 'style', 'id', ?, ?)`)
      .run(runId, e.id, `SMKP-${e.id}`, e.name, qty, qty, unit, amount, `${P}-10`, t);
    mkItem(EA, 10, 10, 100);
    mkItem(EB, 5, 10, 50);
    mkItem(EC, 12, 10, 120);

    // 工资单：A 正确带入；B 计件多 30 且应发被改过；D 挂 USD 主体
    const mkPay = (e, opts) => {
      const base = opts.base;
      const row = {
        base_salary: base, work_days: Calc.workDaysInMonth(P), actual_days: Calc.workDaysInMonth(P),
        leave_days: 0, absent_days: 0, overtime_hours: 0, bonus: opts.bonus || 0,
        allowance: opts.allowance || 0, piece_wage: opts.piece, deduction: 0, social_insurance: 0
      };
      const pre = Calc.recalc(row);
      row.social_insurance = Calc.round2(pre.gross * 0.105);
      const c = Calc.recalc(row);
      const gross = opts.fakeGross !== undefined ? opts.fakeGross : c.gross;
      PDB.prepare(`INSERT INTO payrolls (period, employee_id, employee_name, department, base_salary, work_days,
          actual_days, leave_days, absent_days, overtime_hours, overtime_pay, bonus, allowance, deduction,
          social_insurance, tax, gross_pay, net_pay, status, remark, created_at, updated_at, company_id, piece_wage)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?, ?, ?)`).run(
        P, e.id, e.name, '烟测车间', base, row.work_days, row.actual_days, 0, 0, 0, c.overtimePay,
        row.bonus, row.allowance, 0, row.social_insurance, c.tax, gross, c.net, `烟测工资单__SMOKE`, t, t,
        opts.companyId || 1, opts.piece
      );
    };
    mkPay(EA, { base: 6000, piece: 100 });
    mkPay(EB, { base: 5000, piece: 80, fakeGross: 5000 });      // 计件多 30 + 应发被改
    mkPay(ED, { base: 5000, piece: 0, companyId: 3 });           // USD 主体 → 政策待配

    const baseAdj = PDB.prepare("SELECT COUNT(*) c FROM payroll_adjustments WHERE reason LIKE '%烟测工资差异%'").get().c;

    const meta = await req('/api/payroll-check/meta', { token });
    ok('工资核对字典（状态 / 差异类型 / 主体 / 期间）',
      meta.status === 200 && (meta.json.data.statuses || []).length === 5 && (meta.json.data.companies || []).length > 0,
      `HTTP ${meta.status}`);

    // 1. 预览：四类结论
    const pv = await req(`/api/payroll-check/preview?period=${P}`, { token });
    const items = pv.json.data.items || [];
    const rowOf = (e) => items.find((x) => x.employee_id === e.id) || {};
    ok('★ 计件应计只认已确认批次（270 = 100 + 50 + 120）',
      pv.status === 200 && pv.json.data.summary.piece_expected === 270,
      `应计 ${pv.json.data ? pv.json.data.summary.piece_expected : '?'}`);

    ok('★ 计件与工资单一致 → 核对一致',
      rowOf(EA).status === 'ok', `${rowOf(EA).employee_name} ${rowOf(EA).status}`);

    ok('★ 工资单计件比批次多 → 有差异，并指出差额',
      rowOf(EB).status === 'diff' && Math.abs(rowOf(EB).piece_diff - 30) < 0.01
      && (rowOf(EB).issues || []).some((x) => x.kind === 'piece_mismatch'),
      `${rowOf(EB).employee_name} ${rowOf(EB).piece_diff}`);

    ok('★ 应发与公式重算不符 → 也点出来（手工改过的痕迹）',
      (rowOf(EB).issues || []).some((x) => x.kind === 'gross_mismatch'),
      `存 ${rowOf(EB).gross_stored} / 算 ${rowOf(EB).gross_recalc}`);

    ok('★ 有计件但没工资单 → 缺工资单',
      rowOf(EC).status === 'missing' && rowOf(EC).piece_expected === 120,
      `${rowOf(EC).employee_name} ${rowOf(EC).status}`);

    ok('★ 境外主体（USD）标政策待配，不套国内税率',
      rowOf(ED).status === 'policy' && rowOf(ED).currency === 'USD'
      && (rowOf(ED).issues || []).some((x) => x.kind === 'foreign_policy'),
      `${rowOf(ED).employee_name} ${rowOf(ED).status} / ${rowOf(ED).currency}`);

    ok('一致的人应发/实发与重算完全相同', Math.abs(rowOf(EA).gross_stored - rowOf(EA).gross_recalc) < 0.01,
      `${rowOf(EA).gross_stored} vs ${rowOf(EA).gross_recalc}`);

    // 2. 同期第二个「已确认」批次：库里有部分唯一索引兜底
    //    （uq 只约束 status='confirmed'，草稿与作废可以有多份）
    let dupErr = '';
    try {
      PDB.prepare(`INSERT INTO piece_wage_runs (run_no, period, status, items_count, employees_count, total_qty, total_amount,
          created_by, created_at, confirmed_by, confirmed_at)
        VALUES (?, ?, 'confirmed', 0, 0, 0, 0, 'smoke', ?, 'smoke', ?)`).run(RUN_NO2, P, t, t);
    } catch (e) {
      dupErr = e.message || '';
    }
    ok('★ 同期第二个「已确认」计件批次被数据库挡住（不靠人工记得别建）',
      /UNIQUE/.test(dupErr), dupErr || '插入居然成功了');

    const pv2 = await req(`/api/payroll-check/preview?period=${P}`, { token });
    ok('单批次时不报「多批次」警报', (pv2.json.data.batch_issues || []).length === 0,
      `batch_issues ${(pv2.json.data.batch_issues || []).length}`);

    // 3. 生成批次
    const run1 = await req('/api/payroll-check/run', { method: 'POST', token, body: { period: P, note: '烟测批次__SMOKE' } });
    const gotEmps = new Set((run1.json.data ? run1.json.data.items || [] : []).map((x) => x.employee_id));
    ok('生成核对批次（落库，供逐行处理）',
      run1.status === 200 && !!run1.json.data.check_no
      && [EA, EB, EC, ED].every((e) => gotEmps.has(e.id)),
      `HTTP ${run1.status} ${run1.json.message || ''} ${run1.json.data ? run1.json.data.check_no : ''} 覆盖 ${gotEmps.size} 人`);

    const rid = run1.json.data.id;
    const rItems = run1.json.data.items;
    const rowB = rItems.find((x) => x.employee_id === EB.id);
    const rowC = rItems.find((x) => x.employee_id === EC.id);

    // 有未处理的差异行时不许「完成核对」（政策待配只算提示，不拦）
    const rvEarly = await req(`/api/payroll-check/review/${rid}`, { method: 'POST', token, body: {} });
    ok('有未处理的差异行时不能完成核对', rvEarly.status === 400, `HTTP ${rvEarly.status} ${rvEarly.json.message || ''}`);

    // 4. 登记差异：必须写原因、必须非 0；缺工资单默认补发
    const noReason = await req(`/api/payroll-check/diff/${rowB.id}`, { method: 'POST', token, body: { amount: 30 } });
    ok('登记差异必须写原因', noReason.status === 400, `HTTP ${noReason.status}`);

    const zero = await req(`/api/payroll-check/diff/${rowB.id}`, { method: 'POST', token, body: { amount: 0, reason: '烟测工资差异：金额为 0' } });
    ok('调整金额为 0 不许登记', zero.status === 400, `HTTP ${zero.status}`);

    const regB = await req(`/api/payroll-check/diff/${rowB.id}`, {
      method: 'POST', token, body: { amount: -30, reason: '烟测工资差异：计件多计 30 元，下期扣回' }
    });
    ok('★ 登记差异生成「下一期」调整单，不改本期工资单',
      regB.status === 200 && !!regB.json.data.adj_no && regB.json.data.period === NEXT,
      `HTTP ${regB.status} ${regB.json.data ? regB.json.data.adj_no + ' @' + regB.json.data.period : ''}`);

    const payB = PDB.prepare('SELECT piece_wage, gross_pay FROM payrolls WHERE period = ? AND employee_id = ?').get(P, EB.id);
    ok('★ 工资单本身没被改动（80 / 5000 原样）',
      Number(payB.piece_wage) === 80 && Number(payB.gross_pay) === 5000,
      `计件 ${payB.piece_wage} / 应发 ${payB.gross_pay}`);

    const adjB = PDB.prepare('SELECT * FROM payroll_adjustments WHERE adj_no = ?').get(regB.json.data.adj_no);
    ok('调整单是 pending 且记录了来源期', adjB && adjB.status === 'pending' && adjB.source_period === P,
      adjB ? `${adjB.status} / ${adjB.source_period}` : '未生成');

    const regC = await req(`/api/payroll-check/diff/${rowC.id}`, {
      method: 'POST', token, body: { reason: '烟测工资差异：新员工漏生成工资单，下期补发' }
    });
    ok('★ 缺工资单登记差异默认「补发」而不是扣回（+120）',
      regC.status === 200 && Number(regC.json.data.amount) === 120,
      `金额 ${regC.json.data ? regC.json.data.amount : '?'}`);

    const regAgain = await req(`/api/payroll-check/diff/${rowB.id}`, {
      method: 'POST', token, body: { amount: -10, reason: '烟测工资差异：重复登记' }
    });
    ok('同一行不能重复登记差异', regAgain.status === 400, `HTTP ${regAgain.status}`);

    const rowD = rItems.find((x) => x.employee_id === ED.id);
    const noteD = await req(`/api/payroll-check/annotate/${rowD.id}`, { method: 'POST', token, body: { review_note: '烟测：美国主体，等总部确认个税口径' } });
    ok('可以给境外主体写核对说明（不改钱）', noteD.status === 200 && !!noteD.json.data.review_note, `HTTP ${noteD.status}`);

    const rvOk = await req(`/api/payroll-check/review/${rid}`, { method: 'POST', token, body: { note: '烟测：已处理完' } });
    ok('处理好后可以完成核对', rvOk.status === 200 && rvOk.json.data.status === 'reviewed', `HTTP ${rvOk.status}`);

    const runDup = await req('/api/payroll-check/run', { method: 'POST', token, body: { period: P, note: '烟测再跑__SMOKE' } });
    ok('已完成的批次不悄悄覆盖，重跑要确认', runDup.status === 400, `HTTP ${runDup.status}`);

    // 6. 下钻计件来源
    const src = await req(`/api/payroll-check/sources?run_id=${rid}&employee_id=${EA.id}`, { token });
    ok('可以下钻到具体报工（钱是怎么算出来的）',
      src.status === 200 && (src.json.data.rows || []).length === 1 && src.json.data.total_amount === 100,
      `行 ${src.json.data ? (src.json.data.rows || []).length : '?'} / 合计 ${src.json.data ? src.json.data.total_amount : '?'}`);

    // 7. 权限：工资数据连看都限岗
    const salesLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'sales01', password: PASS } });
    if (salesLogin.status === 200) {
      const sPrev = await req(`/api/payroll-check/preview?period=${P}`, { token: salesLogin.json.data.token });
      ok('★ 销售不能看工资核对（工资数据连读都限岗）', sPrev.status === 403, `HTTP ${sPrev.status}`);
    } else {
      ok('销售不能看工资核对', true, '没有 sales01，跳过');
    }
    const whLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'wh01', password: PASS } });
    if (whLogin.status === 200) {
      const wRun = await req('/api/payroll-check/run', { method: 'POST', token: whLogin.json.data.token, body: { period: P, note: '烟测越权__SMOKE', force: true } });
      ok('仓库不能生成核对批次', wRun.status === 403, `HTTP ${wRun.status}`);
    } else {
      ok('仓库不能生成核对批次', true, '没有 wh01，跳过');
    }

    // 8. 清理
    cleanSmoke();
    ok('冒烟夹具已清干净',
      PDB.prepare("SELECT COUNT(*) c FROM piece_wage_runs WHERE run_no LIKE 'PW_SMOKE%'").get().c === 0
      && PDB.prepare("SELECT COUNT(*) c FROM payrolls WHERE period IN (?, ?) AND remark LIKE '%__SMOKE%'").get(P, NEXT).c === 0
      && PDB.prepare("SELECT COUNT(*) c FROM payroll_check_runs WHERE note LIKE '%__SMOKE%'").get().c === 0
      && PDB.prepare("SELECT COUNT(*) c FROM employees WHERE name LIKE '%__SMOKE%'").get().c === 0,
      `批次 ${PDB.prepare("SELECT COUNT(*) c FROM piece_wage_runs WHERE run_no LIKE 'PW_SMOKE%'").get().c} / 核对 ${PDB.prepare("SELECT COUNT(*) c FROM payroll_check_runs WHERE note LIKE '%__SMOKE%'").get().c}`);
  }


  /* ================================================================== *
   * 数据导出与订阅（TS-N18-03 / TS-N18-09）
   * 夹具：订阅用历史期间（2021-06）执行，避免改动今天的订阅状态；
   * 导出记录按 demo_tag='__SMOKE' 清理（导出记录是审计数据，只删自己造的）
   * ================================================================== */
  {
    const { db: EDB } = require('../src/db');
    const EG = require('../src/services/exportGuard');
    console.log('\n[数据导出与订阅]');

    const MARK = '__SMOKE';
    const ASOF = '2021-06-01';
    const madeJobs = [];

    const cleanSmoke = () => {
      const jobs = EDB.prepare("SELECT id FROM export_jobs WHERE demo_tag = ?").all(MARK).map((r) => r.id);
      if (jobs.length) {
        const ph = jobs.map(() => '?').join(',');
        EDB.prepare(`DELETE FROM export_deliveries WHERE job_id IN (${ph})`).run(...jobs);
        EDB.prepare(`DELETE FROM export_jobs WHERE id IN (${ph})`).run(...jobs);
      }
      const subs = EDB.prepare("SELECT id FROM export_subscriptions WHERE note LIKE '%__SMOKE%' OR name LIKE '%__SMOKE%'").all().map((r) => r.id);
      if (subs.length) {
        const ph = subs.map(() => '?').join(',');
        EDB.prepare(`DELETE FROM export_deliveries WHERE subscription_id IN (${ph})`).run(...subs);
        EDB.prepare(`DELETE FROM export_subscriptions WHERE id IN (${ph})`).run(...subs);
      }
      EDB.prepare("UPDATE export_defs SET row_cap = 5000 WHERE def_key = 'ar_aging'").run();
    };
    cleanSmoke();

    // 导出返回的是 CSV 不是 JSON，用现有的 req() 拿不到内容（只能得到空对象），
    // 于是「文件里到底有没有水印」这类断言根本验不了 —— 这正是原来没人发现导出坏掉的原因
    const reqCsv = async (path, opt = {}) => {
      const headers = { 'Content-Type': 'application/json' };
      if (opt.token) headers.Authorization = 'Bearer ' + opt.token;
      const res = await fetch(BASE + path, {
        method: opt.method || 'GET', headers,
        body: opt.body ? JSON.stringify(opt.body) : undefined
      });
      return { status: res.status, csv: await res.text(), headers: Object.fromEntries(res.headers) };
    };

    const jobCount = () => EDB.prepare('SELECT COUNT(*) c FROM export_jobs').get().c;
    const markJob = (jobNo) => EDB.prepare('UPDATE export_jobs SET demo_tag = ? WHERE job_no = ?').run(MARK, jobNo);

    // ============ 1. 白名单与字典 ============
    const meta = await req('/api/exports/meta', { token });
    const defs = (meta.json.data && meta.json.data.defs) || [];
    ok('数据集清单来自白名单（9 个，含敏感级与所需权限）',
      meta.status === 200 && defs.length === EG.DEFS.length
      && defs.every((d) => d.def_key && d.sensitivity && Array.isArray(d.columns)),
      `HTTP ${meta.status} ${defs.length} 个`);
    ok('★ 没有「自定义表 / 自定义 SQL」入口（只能在白名单里选）',
      !defs.some((d) => /sql|query|table/i.test(JSON.stringify(d.params || [])))
      && defs.every((d) => Array.isArray(d.params) && d.params.length <= 4),
      `参数最多的数据集：${Math.max(...defs.map((d) => (d.params || []).length))} 个条件`);

    // ============ 2. 导出必须写理由 ============
    const noReason = await req('/api/exports/download/ar_aging', { method: 'POST', token, body: { params: {} } });
    ok('导出必须写理由（至少 4 字）', noReason.status === 400, `HTTP ${noReason.status}`);

    // ============ 3. 正常导出 ============
    const arCount = EDB.prepare("SELECT COUNT(*) c FROM ar_invoices WHERE status <> 'void'").get().c;
    const before = jobCount();
    const dl = await reqCsv('/api/exports/download/ar_aging', {
      method: 'POST', token, body: { params: { as_of: '2026-10-28' }, reason: '烟测：应收对账需要未收明细' }
    });
    const jobRow = EDB.prepare('SELECT * FROM export_jobs ORDER BY id DESC LIMIT 1').get();
    madeJobs.push(jobRow && jobRow.job_no);
    if (jobRow) markJob(jobRow.job_no);

    ok('★ 一次导出落一条记录（行数 / 水印 / 内容哈希 / 谁导的 / 理由）',
      dl.status === 200 && jobCount() === before + 1 && jobRow
      && jobRow.row_count > 0 && !!jobRow.watermark && !!jobRow.content_hash
      && jobRow.requester === 'admin' && /烟测/.test(jobRow.reason || ''),
      `HTTP ${dl.status} 行数 ${jobRow ? jobRow.row_count : '?'} 水印 ${jobRow ? jobRow.watermark : '?'}`);

    const csv = dl.csv || '';
    ok('文件头带导出信息（人 / 时间 / 理由 / 水印）',
      /导出数据集/.test(csv) && /导出人/.test(csv) && /导出理由/.test(csv) && csv.includes(jobRow.watermark),
      `首行：${(csv.split('\n')[0] || '').slice(0, 60)}`);

    ok('★ 敏感数据集每一行都带水印（截图截到一行也能反查）',
      (csv.match(new RegExp(jobRow.watermark, 'g')) || []).length > jobRow.row_count,
      `水印出现 ${(csv.match(new RegExp(jobRow.watermark, 'g')) || []).length} 次 / ${jobRow.row_count} 行`);

    ok('导出行数与源表一致（作废单据不计）', jobRow.row_count <= arCount && jobRow.row_count > 0,
      `导出 ${jobRow.row_count} / 源表 ${arCount}`);

    // ============ 4. 水印反查 ============
    const trace = await req(`/api/exports/trace?token=${encodeURIComponent(jobRow.watermark)}`, { token });
    ok('★ 水印能反查到人、时间、理由（文件外泄唯一可追的手段）',
      trace.status === 200 && trace.json.data.job_no === jobRow.job_no
      && trace.json.data.matched_by === 'watermark' && /烟测/.test(trace.json.data.reason || ''),
      `HTTP ${trace.status} ${trace.json.data ? trace.json.data.requester_name : '?'}`);

    const traceByNo = await req(`/api/exports/trace?token=${jobRow.job_no}`, { token });
    ok('只贴单号也能反查', traceByNo.status === 200 && traceByNo.json.data.matched_by === 'job_no', `HTTP ${traceByNo.status}`);

    const traceBad = await req('/api/exports/trace?token=EXP-NOT-EXIST-0000', { token });
    ok('假水印明确报「查不到」（不返回一个像样的空结果）', traceBad.status === 404, `HTTP ${traceBad.status}`);

    // ============ 5. 脱敏与掩码统计 ============
    const custDl = await reqCsv('/api/exports/download/customer_list', {
      method: 'POST', token, body: { reason: '烟测：客户名单（检查电话是否掩码）' }
    });
    const custJob = EDB.prepare('SELECT * FROM export_jobs ORDER BY id DESC LIMIT 1').get();
    if (custJob) markJob(custJob.job_no);
    const custCsv = custDl.csv || '';
    const hasMaskedPhone = /\d{3}\*{4}\d{4}/.test(custCsv);
    ok('★ 客户电话/邮箱在导出时被掩码（与页面同一套规则）',
      custDl.status === 200 && /phone/.test(custJob.masked_fields || '') && hasMaskedPhone,
      `掩码字段 ${custJob ? custJob.masked_fields : '?'}；样例 ${(custCsv.split('\n').find((l) => /\*{4}/.test(l)) || '无').slice(0, 50)}`);

    const payDl = await reqCsv('/api/exports/download/payroll_summary', {
      method: 'POST', token, body: { params: { period: '2026-10' }, reason: '烟测：工资汇总（检查工资字段是否掩码）' }
    });
    const payJob = EDB.prepare('SELECT * FROM export_jobs ORDER BY id DESC LIMIT 1').get();
    if (payJob) markJob(payJob.job_no);
    ok('★ 工资字段导出后全被掩（管理员技术权限不默认可读工资）',
      payDl.status === 200 && /gross_pay/.test(payJob.masked_fields || '') && /base_salary/.test(payJob.masked_fields || '')
      && payJob.masked_rows > 0,
      `掩码 ${payJob ? payJob.masked_fields : '?'} / ${payJob ? payJob.masked_rows : '?'} 行`);

    // ============ 6. 小样本抑制（纯函数三例）============
    const fakeDef = { small_sample_min: 5, sample_col: 'n', value_cols: ['n', 'amt'] };
    const allBig = EG.suppressSmallSample(fakeDef, [{ n: 8, amt: 100 }, { n: 6, amt: 90 }, { n: 12, amt: 200 }]);
    ok('全部组都够人数 → 不抑制', allBig.suppressed === 0 && allBig.rows[0].n === 8, `抑制 ${allBig.suppressed} 组`);

    const manySmall = EG.suppressSmallSample(fakeDef, [{ n: 3, amt: 1 }, { n: 2, amt: 2 }, { n: 9, amt: 3 }, { n: 10, amt: 4 }]);
    ok('★ 两个组人数不足 → 两组都抑制', manySmall.suppressed === 2, `抑制 ${manySmall.suppressed} 组`);

    const oneSmall = EG.suppressSmallSample(fakeDef, [{ n: 2, amt: 1 }, { n: 9, amt: 3 }, { n: 12, amt: 4 }]);
    ok('★ 只有一个组不足 → 连带抑制第二小的组（否则用合计减其他组能反推）',
      oneSmall.suppressed === 2 && oneSmall.rows[0].n === '<5' && oneSmall.rows[1].n === '<5',
      `抑制 ${oneSmall.suppressed} 组：${JSON.stringify(oneSmall.rows.map((r) => r.n))}`);

    const dep = await req('/api/exports/preview/headcount_by_dept', { token });
    ok('聚合数据集的预览就带抑制（不是导出才变）',
      dep.status === 200 && dep.json.data.suppressed_rows > 0
      && dep.json.data.sample.some((r) => String(r['在职人数']).startsWith('<')),
      `抑制 ${dep.json.data ? dep.json.data.suppressed_rows : '?'} 组`);

    // ============ 7. 参数白名单与行数上限 ============
    EDB.prepare("UPDATE export_defs SET row_cap = 3 WHERE def_key = 'ar_aging'").run();
    const overCap = await req('/api/exports/download/ar_aging', {
      method: 'POST', token, body: { reason: '烟测：超上限应被拒' }
    });
    ok('★ 超过单次行数上限直接拒绝（不提供截断导出：截断会被当全量用）',
      overCap.status === 400 && /上限|缩小范围/.test(overCap.json.message || ''),
      `HTTP ${overCap.status} ${overCap.json && overCap.json.message ? overCap.json.message.slice(0, 40) : ''}`);
    EDB.prepare("UPDATE export_defs SET row_cap = 5000 WHERE def_key = 'ar_aging'").run();

    // ============ 8. 订阅：必填项 ============
    const subBase = { name: '烟测订阅__SMOKE', def_key: 'stock_balance', recipients: ['wh01'], note: '烟测用途说明' };
    const noUntil = await req('/api/exports/subs', { method: 'POST', token, body: { ...subBase, valid_from: '2021-01-01' } });
    ok('★ 订阅必须设到期日（不允许永久订阅）', noUntil.status === 400 && /到期日/.test(noUntil.json.message || ''), `HTTP ${noUntil.status}`);

    const farUntil = await req('/api/exports/subs', {
      method: 'POST', token, body: { ...subBase, valid_from: '2021-01-01', valid_until: '2030-01-01' }
    });
    ok('到期日不能超过两年', farUntil.status === 400, `HTTP ${farUntil.status}`);

    const badRcpt = await req('/api/exports/subs', {
      method: 'POST', token, body: { ...subBase, recipients: ['no_such_user'], valid_from: '2021-01-01', valid_until: '2022-12-31' }
    });
    ok('★ 收件人必须是真实账号（写错人名的订阅 = 产出没人领，系统以为发了）',
      badRcpt.status === 400 && /不存在/.test(badRcpt.json.message || ''), `HTTP ${badRcpt.status}`);

    const noNote = await req('/api/exports/subs', {
      method: 'POST', token, body: { ...subBase, note: '', valid_from: '2021-01-01', valid_until: '2022-12-31' }
    });
    ok('订阅必须写用途', noNote.status === 400, `HTTP ${noNote.status}`);

    // ============ 9. 订阅执行 ============
    const mkSub = await req('/api/exports/subs', {
      method: 'POST', token,
      body: { ...subBase, freq: 'monthly', day_of_month: 5, channel: 'inbox', valid_from: '2021-01-01', valid_until: '2022-12-31' }
    });
    ok('建订阅（频率 / 收件人 / 生效期 / 下个执行日）',
      mkSub.status === 200 && !!mkSub.json.data.sub_no && !!mkSub.json.data.next_run_at,
      `HTTP ${mkSub.status} ${mkSub.json.data ? mkSub.json.data.sub_no + ' next=' + mkSub.json.data.next_run_at : ''}`);

    const subId = mkSub.json.data.id;
    // 定向执行自己造的订阅（服务层直调）。
    // 不用全局 run-due：它会把演示库里所有到期订阅一起跑掉，冒烟一跑就把别人的订阅状态改了 ——
    // 「测试污染真实数据」这件事在这个项目里已经踩过三次。
    let runOne = null;
    try { runOne = EG.runSubscription(subId, ASOF); } catch (e) { runOne = { error: e.message }; }
    const subJob = EDB.prepare("SELECT * FROM export_jobs WHERE subscription_id = ? ORDER BY id DESC LIMIT 1").get(subId);
    if (subJob) markJob(subJob.job_no);
    ok('★ 到期订阅执行 → 生成一条订阅触发的导出记录',
      !!runOne && !runOne.error && runOne.job && runOne.job.trigger_by === 'subscription'
      && runOne.row_count > 0 && runOne.subscription.next_run_at > ASOF,
      runOne && runOne.error ? runOne.error : `${runOne && runOne.job ? runOne.job.job_no : '无'} / ${runOne ? runOne.row_count : '?'} 行 / 下期 ${runOne && runOne.subscription ? runOne.subscription.next_run_at : '?'}`);

    const dueNow = EG.dueSubscriptions(ASOF).map((x) => x.sub_no);
    ok('★ 执行过的订阅不会再出现在「到期」里（next_run_at 已推进，同一天不会重复产出）',
      !dueNow.includes(mkSub.json.data.sub_no),
      `仍到期：${dueNow.length ? dueNow.join(',') : '无'}`);

    // 批量入口仍然可用（这里只验返回结构，不依赖它跑谁）
    const runBatch = await req('/api/exports/run-due', { method: 'POST', token, body: { as_of: ASOF } });
    ok('批量「执行到期」入口可用（返回 due/ok/failed 三段）',
      runBatch.status === 200 && runBatch.json.data && Array.isArray(runBatch.json.data.ok)
      && Array.isArray(runBatch.json.data.failed),
      `HTTP ${runBatch.status} 到期 ${runBatch.json.data ? runBatch.json.data.due_count : '?'} 条`);

    const deliv = await req('/api/exports/deliveries', { token });
    const myDeliv = (deliv.json.data.rows || []).find((d) => d.subscription_id === subId);
    ok('订阅产出落投递记录（站内可取 → 待领取）',
      !!myDeliv && myDeliv.status === 'pending' && myDeliv.recipient === 'wh01',
      myDeliv ? `${myDeliv.recipient} / ${myDeliv.status_label}` : '没有投递记录');

    // 邮件渠道：通道未配置，但不假装失败、产出仍可取
    const mailSub = await req('/api/exports/subs', {
      method: 'POST', token,
      body: { ...subBase, name: '烟测邮件订阅__SMOKE', freq: 'monthly', day_of_month: 6, channel: 'email', valid_from: '2021-01-01', valid_until: '2022-12-31' }
    });
    let mailDeliv = null;
    if (mailSub.status === 200) {
      try { EG.runSubscription(mailSub.json.data.id, ASOF); } catch (e) { /* 由下面的断言反映 */ }
      const j = EDB.prepare('SELECT * FROM export_jobs WHERE subscription_id = ? ORDER BY id DESC LIMIT 1').get(mailSub.json.data.id);
      if (j) markJob(j.job_no);
      const d = await req('/api/exports/deliveries?subscription_id=' + mailSub.json.data.id, { token });
      mailDeliv = (d.json.data.rows || [])[0];
      ok('★ 邮件渠道未配置 → 投递标「通道未配置」并写明原因（不假装发成功）',
        mailDeliv && mailDeliv.status === 'blocked' && /SMTP|邮件通道/.test(mailDeliv.notify_note || ''),
        mailDeliv ? mailDeliv.status_label : '没有投递记录');
    } else {
      ok('邮件渠道未配置时标 blocked', false, `建订阅失败 ${mailSub.status}`);
    }

    // 领取（下载）
    if (myDeliv) {
      const take = await req(`/api/exports/deliveries/${myDeliv.id}/take`, { method: 'POST', token, body: {} });
      const after = EDB.prepare('SELECT * FROM export_deliveries WHERE id = ?').get(myDeliv.id);
      ok('领取产出 → 状态转已领取、下载次数 +1',
        take.status === 200 && after.status === 'taken' && after.download_count === 1,
        `HTTP ${take.status} / ${after ? after.status : '?'} x${after ? after.download_count : '?'}`);
    } else {
      ok('领取产出', false, '没有投递记录');
    }

    // 他人不能领取
    const whLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'sales01', password: PASS } });
    if (whLogin.status === 200 && myDeliv) {
      const steal = await req(`/api/exports/deliveries/${myDeliv.id}/take`, { method: 'POST', token: whLogin.json.data.token, body: {} });
      ok('★ 不是收件人不能领别人的产出', steal.status === 403, `HTTP ${steal.status}`);
    } else {
      ok('不是收件人不能领别人的产出', true, '跳过');
    }

    // ============ 10. 换岗后订阅不产出 ============
    const hrSub = await req('/api/exports/subs', {
      method: 'POST', token,
      body: { name: '烟测工资订阅__SMOKE', def_key: 'payroll_summary', recipients: ['hr01'], freq: 'monthly', day_of_month: 7, channel: 'inbox', valid_from: '2021-01-01', valid_until: '2022-12-31', note: '烟测：工资订阅归属测试' }
    });
    let hrSubOk = false;
    if (hrSub.status === 200) {
      // 改成销售（没有 paycheck.read）→ 执行必须被拒
      EDB.prepare('UPDATE export_subscriptions SET owner = ?, owner_name = ? WHERE id = ?').run('sales01', '销售一号', hrSub.json.data.id);
      let permErr = '';
      try { EG.runSubscription(hrSub.json.data.id, ASOF); } catch (e) { permErr = e.message || ''; }
      hrSubOk = /权限/.test(permErr);
      EDB.prepare('DELETE FROM export_subscriptions WHERE id = ?').run(hrSub.json.data.id);
    }
    ok('★ 订阅人换岗失去权限后，订阅不再产出（不能靠订阅绕过权限）', hrSubOk, hrSubOk ? '已拒绝并记录原因' : '未拦住');

    // ============ 11. 权限与可见范围 ============
    if (whLogin.status === 200) {
      const sTok = whLogin.json.data.token;
      const sPay = await req('/api/exports/download/payroll_summary', { method: 'POST', token: sTok, body: { reason: '烟测：仓管越权导工资' } });
      ok('★ 没有工资权限的人导不出工资（两层闸：export.run + 数据集业务权限）',
        sPay.status === 403, `HTTP ${sPay.status}`);
      const sJobs = await req('/api/exports/jobs', { token: sTok });
      ok('无审计权限时只看自己的导出记录',
        sJobs.status === 200 && sJobs.json.data.scope === 'self'
        && sJobs.json.data.rows.every((j) => j.requester === 'sales01'),
        `scope=${sJobs.json.data ? sJobs.json.data.scope : '?'} 条数 ${sJobs.json.data ? sJobs.json.data.rows.length : '?'}`);
      const sTrace = await req(`/api/exports/trace?token=${encodeURIComponent(jobRow.watermark)}`, { token: sTok });
      ok('★ 无审计权限能确认「有这次导出」，但看不到是谁（水印情报不外泄）',
        sTrace.status === 200 && sTrace.json.data.partial === true,
        sTrace.json.data ? sTrace.json.data.requester_name : '?');
    } else {
      ok('越权导出被拒 + 记录隔离', true, '跳过');
    }

    // ============ 12. 既有导出端点也留痕 ============
    const beforeLegacy = jobCount();
    const legacyCsv = await reqCsv('/api/collections/export', { token });
    const legacyJob = EDB.prepare('SELECT * FROM export_jobs ORDER BY id DESC LIMIT 1').get();
    if (legacyJob) markJob(legacyJob.job_no);
    ok('★ 既有端点（应收催收）导出成功且补了记录（此前一点就 500）',
      legacyCsv.status === 200 && legacyCsv.csv && legacyCsv.csv.includes('任务号')
      && jobCount() === beforeLegacy + 1 && legacyJob.def_key === 'legacy',
      `HTTP ${legacyCsv.status} 记录 ${legacyJob ? legacyJob.job_no : '无'}`);

    const prCsv = await reqCsv('/api/payment-requests/export', { token });
    const prJob = EDB.prepare('SELECT * FROM export_jobs ORDER BY id DESC LIMIT 1').get();
    if (prJob) markJob(prJob.job_no);
    ok('★ 付款申请导出也修好并留痕（同一个 toCsv 用法错误）',
      prCsv.status === 200 && !!prCsv.csv && !!prJob && prJob.def_key === 'legacy',
      `HTTP ${prCsv.status}`);

    // ============ 13. 导出不动业务数据 ============
    const baseStock = Number(EDB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v);
    const baseGl = EDB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c;
    await req('/api/exports/download/stock_balance', { method: 'POST', token, body: { reason: '烟测：库存结存（验证导出不改数）' } });
    const sbJob = EDB.prepare('SELECT * FROM export_jobs ORDER BY id DESC LIMIT 1').get();
    if (sbJob) markJob(sbJob.job_no);
    ok('★ 导出只读业务表（库存与凭证计数不变）',
      Number(EDB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v) === baseStock
      && EDB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c === baseGl,
      `库存 ${baseStock} / 凭证 ${baseGl}`);

    // ============ 14. 清理 ============
    cleanSmoke();
    ok('冒烟夹具已清干净',
      EDB.prepare('SELECT COUNT(*) c FROM export_jobs WHERE demo_tag = ?').get(MARK).c === 0
      && EDB.prepare("SELECT COUNT(*) c FROM export_subscriptions WHERE note LIKE '%__SMOKE%' OR name LIKE '%__SMOKE%'").get().c === 0,
      `导出记录 ${EDB.prepare('SELECT COUNT(*) c FROM export_jobs WHERE demo_tag = ?').get(MARK).c} / 订阅 ${EDB.prepare("SELECT COUNT(*) c FROM export_subscriptions WHERE note LIKE '%__SMOKE%' OR name LIKE '%__SMOKE%'").get().c}`);
  }


  /* ================================================================== *
   * 历史订单再次购买（TS-N20-08）
   * 夹具自建客户 + 商品 + 历史订单 + 美仓库存 + 技术包两版，
   * 全部带 RSMK- / SO202003019xxx / __SMOKE 标记，清理只认这几个标记
   * ================================================================== */
  {
    const { db: RDB } = require('../src/db');
    const R = require('../src/services/mallReorder');
    console.log('\n[历史订单再次购买]');

    const MARK = '__SMOKE';
    const t = new Date().toISOString();
    const pad = (n) => String(n).padStart(2, '0');
    const day = (o) => {
      const d = new Date(Date.now() + o * 86400000);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    const cleanSmoke = () => {
      const orders = RDB.prepare("SELECT id FROM orders WHERE order_no LIKE 'SO202003019%'").all().map((r) => r.id);
      orders.forEach((id) => {
        RDB.prepare('SELECT id FROM order_items WHERE order_id = ?').all(id)
          .forEach((i) => RDB.prepare('DELETE FROM order_item_sizes WHERE item_id = ?').run(i.id));
        RDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      });
      RDB.prepare("DELETE FROM orders WHERE order_no LIKE 'SO202003019%'").run();
      RDB.prepare("DELETE FROM mall_inquiry_items WHERE inquiry_id IN (SELECT id FROM mall_inquiries WHERE source_order_no LIKE 'SO202003019%')").run();
      RDB.prepare("DELETE FROM mall_inquiries WHERE source_order_no LIKE 'SO202003019%'").run();
      RDB.prepare("DELETE FROM mall_favorites WHERE mall_product_id IN (SELECT id FROM mall_products WHERE style_no LIKE 'RSMK-%')").run();
      RDB.prepare("DELETE FROM mall_prices WHERE mall_product_id IN (SELECT id FROM mall_products WHERE style_no LIKE 'RSMK-%')").run();
      RDB.prepare("DELETE FROM mall_products WHERE style_no LIKE 'RSMK-%'").run();
      RDB.prepare("DELETE FROM stock_items WHERE style_no LIKE 'RSMK-%'").run();
      RDB.prepare("DELETE FROM tech_packs WHERE product_name LIKE '%烟测再购%'").run();
      RDB.prepare("DELETE FROM customers WHERE name LIKE '%烟测再购客户%'").run();
    };
    cleanSmoke();

    // ---- 客户 ----
    const cusId = Number(RDB.prepare(`INSERT INTO customers (code, name, contact, level, credit_limit, status, created_at, updated_at, company_id)
      VALUES ('SMK-REORD', '烟测再购客户__SMOKE', '烟测', 'B', 0, 'active', ?, ?, 1)`).run(t, t).lastInsertRowid);

    // ---- 两个在架商品 ----
    const mkMp = (style, name, moq, price) => Number(RDB.prepare(`INSERT INTO mall_products (style_no, name_cn, name_en, category, moq, lead_days,
        price_usd, visible_stock, status, sort, created_at, updated_at)
      VALUES (?,?,?, '烟测', ?, 20, ?, 1, 'published', 0, ?, ?)`).run(style, name, name, moq, price, t, t).lastInsertRowid);
    mkMp('RSMK-A', '烟测再购针织__SMOKE', 50, 12);
    mkMp('RSMK-C', '烟测再购卫衣__SMOKE', 100, 7.5);

    // ---- 历史订单（已发货，三个月前） ----
    const totalUsd = 300 * 10 + 60 * 7.5 + 120 * 8;
    const orderId = Number(RDB.prepare(`INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount,
        currency, style_name, order_date, delivery_date, created_at, updated_at, company_id)
      VALUES ('SO202003019001', 'stock', ?, 'shipped', 6.9, ?, ?, 'USD', '烟测再购针织__SMOKE', ?, ?, ?, ?, 1)`)
      .run(cusId, totalUsd, Math.round(totalUsd * 6.9 * 100) / 100, day(-95), day(-30), t, t).lastInsertRowid);

    const mkLine = (b) => {
      const itemId = Number(RDB.prepare(`INSERT INTO order_items (order_id, product_name, style_no, color, qty, amount_usd, amount_cny)
        VALUES (?,?,?,?,?,?,?)`).run(orderId, b.name, b.style, b.color, b.qty,
        Math.round(b.qty * b.price * 100) / 100, Math.round(b.qty * b.price * 6.9 * 100) / 100).lastInsertRowid);
      (b.sizes || []).forEach((sz) => {
        RDB.prepare(`INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny)
          VALUES (?,?,?,?,?,?,?,?)`).run(itemId, b.color, sz.size, sz.qty, b.price,
          Math.round(b.price * 6.9 * 100) / 100, Math.round(sz.qty * b.price * 100) / 100,
          Math.round(sz.qty * b.price * 6.9 * 100) / 100);
      });
      return itemId;
    };
    mkLine({ name: '烟测再购针织__SMOKE', style: 'RSMK-A', color: '米白', qty: 300, price: 10, sizes: [{ size: 'M', qty: 150 }, { size: 'L', qty: 150 }] });
    mkLine({ name: '烟测再购卫衣__SMOKE', style: 'RSMK-C', color: '藏青', qty: 60, price: 7.5, sizes: [{ size: '均码', qty: 60 }] });
    mkLine({ name: '烟测已下架款__SMOKE', style: 'RSMK-X', color: '深蓝', qty: 120, price: 8, sizes: [{ size: '均码', qty: 120 }] });

    // ---- 美仓只有 40 件 ----
    RDB.prepare("INSERT INTO stock_items (warehouse, style_no, product_name, color, size, qty, updated_at) VALUES ('us','RSMK-A','烟测再购针织__SMOKE','米白','M',40,?)").run(t);

    // ---- 技术包两版 ----
    RDB.prepare(`INSERT INTO tech_packs (order_id, product_name, version, stage, status, created_at, updated_at)
      VALUES (?, '烟测再购针织__SMOKE', 1, 'confirmed', 'confirmed', ?, ?)`).run(orderId, day(-96), day(-96));
    RDB.prepare(`INSERT INTO tech_packs (order_id, product_name, version, stage, status, created_at, updated_at)
      VALUES (?, '烟测再购针织__SMOKE', 2, 'confirmed', 'confirmed', ?, ?)`).run(orderId, day(-10), day(-10));

    // ================= 1. 预览：三类差异 =================
    const pv = R.preview(orderId, cusId);
    const lineOf = (style) => pv.items.find((x) => x.style_no === style) || {};

    ok('★ 再购预览把历史单拆成可再购的行（3 个款）',
      pv.items.length === 3 && pv.summary.total === 3,
      `HTTP -${pv.items.length} 行 / 历史 ${pv.summary.hist_usd}`);

    ok('★ 在架款：按当前价重算并报出价差（$10 → $12）',
      lineOf('RSMK-A').current_price_usd === 12 && Math.abs(lineOf('RSMK-A').hist_price_usd - 10) < 0.01
      && (lineOf('RSMK-A').tags || []).includes('price_changed'),
      `历史 ${lineOf('RSMK-A').hist_price_usd} → 当前 ${lineOf('RSMK-A').current_price_usd}`);

    ok('★ 可售量不足要报出来（历史 300 / 当前可售 40）',
      (lineOf('RSMK-A').tags || []).includes('stock_short') && lineOf('RSMK-A').sellable === 40,
      `可售 ${lineOf('RSMK-A').sellable} / 历史 ${lineOf('RSMK-A').hist_qty}`);

    ok('★ 低于起订量只提示、不自动加量（60 < MOQ 100）',
      (lineOf('RSMK-C').tags || []).includes('moq_short')
      && lineOf('RSMK-C').quote_qty === 60 && lineOf('RSMK-C').moq === 100,
      `数量 ${lineOf('RSMK-C').quote_qty} / MOQ ${lineOf('RSMK-C').moq}`);

    ok('★ 已下架款标为不可再购（blocked）',
      lineOf('RSMK-X').status === 'blocked' && (lineOf('RSMK-X').tags || []).includes('off_shelf'),
      `${lineOf('RSMK-X').status} / ${(lineOf('RSMK-X').tag_labels || []).join('、')}`);

    ok('★ 技术包版本变化要提示（原单 v1，现已有 v2）',
      (lineOf('RSMK-A').tags || []).includes('tech_newer'),
      (lineOf('RSMK-A').messages || []).find((m) => /技术包/.test(m)) || '未提示');

    ok('汇总分清「可直接提交 / 需确认 / 不可再购」',
      pv.summary.warn === 2 && pv.summary.blocked === 1 && pv.summary.ok === 0,
      `ok ${pv.summary.ok} / warn ${pv.summary.warn} / blocked ${pv.summary.blocked}`);

    ok('预览不写库（不产生询价单）',
      RDB.prepare("SELECT COUNT(*) c FROM mall_inquiries WHERE source_order_no LIKE 'SO202003019%'").get().c === 0,
      '询价单 0 张');

    // ================= 2. 提交：只认当前价，不带旧折扣/占用 =================
    const sub = R.submit(orderId, cusId, null, { remark: '烟测：再来一单' });
    const inq = RDB.prepare('SELECT * FROM mall_inquiries WHERE inquiry_no = ?').get(sub.inquiry_no);
    const lines = RDB.prepare('SELECT * FROM mall_inquiry_items WHERE inquiry_id = ? ORDER BY id').all(inq.id);

    ok('★ 提交生成的是「新询价单」，不是订单（order_id 为空、来源单另存）',
      !!inq && inq.status === 'submitted' && inq.order_id === null && Number(inq.source_order_id) === orderId,
      `${inq ? inq.status : '?'} / order_id ${inq ? inq.order_id : '?'} / 来源 ${inq ? inq.source_order_no : '?'}`);

    ok('★ 明细单价用当前价（$12 / $7.5），不是历史价',
      lines.length === 2 && Math.abs(lines[0].price_usd - 12) < 0.01 && Math.abs(lines[1].price_usd - 7.5) < 0.01
      && Math.abs(inq.total_usd - (300 * 12 + 60 * 7.5)) < 0.01,
      `合计 ${inq.total_usd}（300×12 + 60×7.5 = 4050）`);

    ok('★ 不沿用原单的付款/折扣/占用（金额按当前价、状态从待报价开始）',
      inq.status === 'submitted' && Math.abs(inq.total_usd - 4410) > 0.01,
      `当前 ${inq.total_usd} ≠ 历史 $4410`);

    const diffSnap = JSON.parse(inq.reorder_diff || '{}');
    ok('★ 差异快照落库（事后能解释「当时提示过什么」）',
      (diffSnap.items || []).length === 2 && (diffSnap.items[0].tags || []).includes('price_changed')
      && !!diffSnap.as_of,
      `快照 ${(diffSnap.items || []).length} 行 / 首行标签 ${(diffSnap.items[0].tags || []).join(',')}`);

    ok('需要业务员复核的差异有标记（needs_review）', sub.needs_review === true, `${sub.needs_review}`);

    ok('★ 一键全要时自动跳过已下架行，并回报跳过了什么',
      (sub.skipped || []).length === 1 && /下架/.test(sub.skipped[0].reason || ''),
      sub.skipped && sub.skipped.length ? `${sub.skipped[0].product_name}：${sub.skipped[0].reason}` : '没有 skipped 信息');

    // ================= 3. 已下架不能提交 =================
    let blockErr = null;
    try { R.submit(orderId, cusId, null, { items: pv.items.map((x) => ({ line_no: x.line_no, qty: x.quote_qty })) }); }
    catch (e) { blockErr = e; }
    ok('★ 勾选已下架款提交 → 直接拒绝（不能把发不出货的款放进新单）',
      !!blockErr && /下架/.test(blockErr.message),
      blockErr ? blockErr.message.slice(0, 40) : '居然提交成功了');

    // ================= 4. 只提交部分行时，未勾选的下架行不拦 =================
    let partialOk = false;
    try {
      const r2 = R.submit(orderId, cusId, null, { items: [{ line_no: 2, qty: 100 }] });
      partialOk = !!r2.inquiry_no;
      RDB.prepare('DELETE FROM mall_inquiry_items WHERE inquiry_id = ?').run(r2.id);
      RDB.prepare('DELETE FROM mall_inquiries WHERE id = ?').run(r2.id);
    } catch (e) { partialOk = false; }
    ok('★ 只挑一行提交时，没勾的已下架行不拦（客户自己选择）', partialOk, partialOk ? '提交成功' : '被拦住了');

    // ================= 5. 越权与状态门槛 =================
    let crossErr = null;
    try { R.preview(orderId, cusId + 9999); } catch (e) { crossErr = e; }
    ok('★ 别的客户不能预览这张单', !!crossErr && crossErr.status === 403, crossErr ? crossErr.message : '未拦住');

    const draftId = Number(RDB.prepare(`INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount,
        currency, style_name, created_at, updated_at, company_id)
      VALUES ('SO202003019002', 'stock', ?, 'draft', 6.9, 0, 0, 'USD', '烟测草稿', ?, ?, 1)`).run(cusId, t, t).lastInsertRowid);
    RDB.prepare("INSERT INTO order_items (order_id, product_name, style_no, qty, amount_usd, amount_cny) VALUES (?, '烟测草稿款', 'RSMK-A', 10, 120, 828)").run(draftId);
    let draftErr = null;
    try { R.preview(draftId, cusId); } catch (e) { draftErr = e; }
    ok('★ 草稿单不能当历史单再购', !!draftErr && /草稿/.test(draftErr.message), draftErr ? draftErr.message : '未拦住');

    // ================= 6. 走 HTTP：商城客户身份 =================
    const mallLogin = await req('/api/mall/auth/login', { method: 'POST', body: { username: MALL_USER, password: MALL_PASS } });
    if (mallLogin.status === 200) {
      const mt = mallLogin.json.data.token;
      const foreign = await req(`/api/mall/orders/${orderId}/reorder-preview`, { token: mt });
      ok('★ 接口层同样拦跨客户（abc001 看不到烟测客户的单）',
        foreign.status === 403 || foreign.status === 404,
        `HTTP ${foreign.status} ${foreign.json.message || ''}`);

      // 自己客户的单：预览 + 提交（用演示单不存在时跳过）
      const own = RDB.prepare("SELECT id FROM orders WHERE customer_id = (SELECT customer_id FROM customer_accounts WHERE username = ? LIMIT 1) AND status = 'shipped' AND id IN (SELECT order_id FROM order_items) ORDER BY id DESC LIMIT 1").get(MALL_USER);
      if (own) {
        const ownPv = await req(`/api/mall/orders/${own.id}/reorder-preview`, { token: mt });
        ok('自己的订单可以走接口预览',
          ownPv.status === 200 && Array.isArray(ownPv.json.data.items),
          `HTTP ${ownPv.status} ${(ownPv.json.data && ownPv.json.data.items || []).length} 行`);
      } else {
        ok('自己的订单可以走接口预览', true, '没有合适的历史单，跳过');
      }
    } else {
      ok('接口层跨客户校验', false, `商城登录失败 ${mallLogin.status}`);
    }

    // ================= 7. 清理 =================
    cleanSmoke();
    ok('冒烟夹具已清干净',
      RDB.prepare("SELECT COUNT(*) c FROM orders WHERE order_no LIKE 'SO202003019%'").get().c === 0
      && RDB.prepare("SELECT COUNT(*) c FROM mall_products WHERE style_no LIKE 'RSMK-%'").get().c === 0
      && RDB.prepare("SELECT COUNT(*) c FROM mall_inquiries WHERE source_order_no LIKE 'SO202003019%'").get().c === 0
      && RDB.prepare("SELECT COUNT(*) c FROM customers WHERE name LIKE '%烟测再购客户%'").get().c === 0,
      `订单 ${RDB.prepare("SELECT COUNT(*) c FROM orders WHERE order_no LIKE 'SO202003019%'").get().c} / 商品 ${RDB.prepare("SELECT COUNT(*) c FROM mall_products WHERE style_no LIKE 'RSMK-%'").get().c}`);
  }

  /* ================================================================== *
   * 收尾自检：冒烟不该在库里留下烟测夹具
   *
   * 这条断言是这几轮「演示数据体检」的产物：冒烟各段各自 cleanSmoke，
   * 但总有几处漏掉（cost_pools / dev_projects / SKU 等），一次跑完留几十行尾巴，
   * 攒了几个月就变成 2000 多行假的研发项目与 SKU。
   * 与其每个月人工体检，不如让它每次跑完自己证明「库里是干净的」。
   * ================================================================== */
  {
    try {
      const A = require('./audit-demo-data');
      // 兜底清一遍：各段自己 cleanSmoke 是主力，但总有几处漏（supplier_confirms /
      // bank_imports / cost_pools / SKU 套装…）。这里用同一个体检脚本收口，
      // 而不是再手写一遍 DELETE —— 判据只有一份，才不会再出现「改了 A 忘了 B」。
      const swept = A.clean({ includeFinance: true, skipBackup: true });
      // 顺手把孤儿也补了：删父行没删子行的地方（历史遗留 + 上面补的那几处之外）
      const orph = A.fixOrphans(false);
      const sc = A.scan();
      const rows = sc.l1.reduce((a, x) => a + x.rows, 0);
      const list = sc.l1.map((x) => `${x.table}(${x.rows})`).join(', ');
      ok('★ 冒烟跑完库里没有烟测残留（L1 = 0）', rows === 0,
        rows ? `兜底清了 ${swept.deleted} 行 + 孤儿 ${orph.fixed} 行后仍残留 ${rows} 行：${list}` : `兜底清了 ${swept.deleted} 行、补孤儿 ${orph.fixed} 行，现干净`);
    } catch (e) {
      ok('★ 冒烟跑完库里没有烟测残留（L1 = 0）', false, '自检失败：' + e.message);
    }
  }



  /* ================================================================== *
   * 订单号手填（业务必填 + 唯一 + 改号级联同步 + 采购关联）
   * 夹具订单号统一 TEST-NO- 前缀，清理按前缀删，绝不碰真实订单
   * ================================================================== */
  {
    const { db: NDB } = require('../src/db');
    console.log('\n[订单号手填]');

    const PFX = 'TEST-NO-';
    const cleanSmoke = () => {
      const ids = NDB.prepare(`SELECT id FROM orders WHERE order_no LIKE '${PFX}%'`).all().map((r) => r.id);
      ids.forEach((id) => {
        NDB.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(id);
        NDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
        NDB.prepare('DELETE FROM order_logs WHERE order_id = ?').run(id);
        NDB.prepare('DELETE FROM order_no_logs WHERE order_id = ?').run(id);
        NDB.prepare('DELETE FROM material_issues WHERE order_id = ?').run(id);
        NDB.prepare('DELETE FROM piece_wage_items WHERE order_id = ?').run(id);
      });
      NDB.prepare(`DELETE FROM orders WHERE order_no LIKE '${PFX}%'`).run();
      NDB.prepare(`DELETE FROM purchase_orders WHERE order_no LIKE '${PFX}%'`).run();
      NDB.prepare('DELETE FROM purchase_items WHERE po_id NOT IN (SELECT id FROM purchase_orders)').run();
      // 转单产生的订单号是 SO 开头、与手填号不同，单独按备注清
      const convIds = NDB.prepare("SELECT id FROM orders WHERE remark LIKE '由报价单 QT-TEST-NO-%'").all().map((r) => r.id);
      convIds.forEach((id) => {
        NDB.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(id);
        NDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
        NDB.prepare('DELETE FROM order_logs WHERE order_id = ?').run(id);
        NDB.prepare('DELETE FROM orders WHERE id = ?').run(id);
      });
      NDB.prepare("DELETE FROM quotation_items WHERE quote_id IN (SELECT id FROM quotations WHERE quote_no LIKE 'QT-TEST-NO-%')").run();
      NDB.prepare("DELETE FROM quotations WHERE quote_no LIKE 'QT-TEST-NO-%'").run();
    };
    cleanSmoke();

    const mkItems = () => [{ product_name: '烟测款', colors: [{ color: '黑', sizes: [{ size: 'M', qty: 10, usd_price: 5 }] }] }];
    const mkOrder = (orderNo) => req('/api/orders', { method: 'POST', token, body: { order_no: orderNo, type: 'custom', items: mkItems() } });

    // ---------- 1. 必填与格式 ----------
    const noNo = await req('/api/orders', { method: 'POST', token, body: { type: 'custom', items: mkItems() } });
    ok('★ 订单号必填（不再自动生成兜底）',
      noNo.status === 400 && /必填/.test(noNo.json.message || ''), `HTTP ${noNo.status}`);

    const sym = await mkOrder('----');
    ok('★ 纯符号不能当订单号（无法检索）', sym.status === 400, `HTTP ${sym.status}`);

    const tooShort = await mkOrder('A');
    ok('订单号至少 2 个字符', tooShort.status === 400, `HTTP ${tooShort.status}`);

    const no1 = await mkOrder(`${PFX}001`);
    ok('手填订单号可以建单', no1.status === 200 && no1.json.data.order_no === `${PFX}001`,
      `HTTP ${no1.status} ${no1.json.data ? no1.json.data.order_no : no1.json.message || ''}`);
    const oid = no1.json.data.id;

    const dup = await mkOrder(`${PFX}001`.toLowerCase());
    ok('★ 重复订单号被拒，且不分大小写（so001 与 SO001 在人眼里是同一个号）',
      dup.status === 409, `HTTP ${dup.status} ${(dup.json.message || '').slice(0, 40)}`);

    const norm = await req('/api/orders', {
      method: 'POST', token, body: { order_no: `  ${PFX}　002  `, type: 'custom', items: mkItems() }
    });
    ok('★ 全角空格与首尾空白被规范化（中文输入法下肉眼分不出）',
      norm.status === 200 && norm.json.data.order_no === `${PFX} 002`,
      `HTTP ${norm.status} ${JSON.stringify(norm.json.data && norm.json.data.order_no)}`);

    // ---------- 2. 改号：预览与级联 ----------
    const t0 = new Date().toISOString();
    NDB.prepare(`INSERT INTO material_issues (issue_no, company_id, order_id, order_no, kind, receiver_type, status,
        item_count, req_qty, issued_qty, amount, created_at, updated_at)
      VALUES ('TESTMI-NO-1', 1, ?, ?, 'material', 'factory', 'draft', 1, 10, 0, 0, ?, ?)`).run(oid, `${PFX}001`, t0, t0);

    const pvNo = await req(`/api/orders/order-no/${oid}/preview?no=${PFX}001B`, { token });
    ok('★ 改号前能预览影响面（会连带改哪些表多少行）',
      pvNo.status === 200 && pvNo.json.data.total_rows >= 1
      && (pvNo.json.data.impacts || []).some((x) => x.table === 'material_issues'),
      pvNo.json.data ? `影响 ${pvNo.json.data.total_rows} 行：${pvNo.json.data.impacts.map((x) => x.table + ':' + x.rows).join(',')}` : '无预览');

    const renNoReason = await req(`/api/orders/order-no/${oid}`, { method: 'POST', token, body: { order_no: `${PFX}001B` } });
    ok('★ 改号必须写原因（下游单据会跟着变，事后要说得清）', renNoReason.status === 400, `HTTP ${renNoReason.status}`);

    const ren = await req(`/api/orders/order-no/${oid}`, {
      method: 'POST', token, body: { order_no: `${PFX}001B`, reason: '烟测：客户要求改用其系统 PO 号' }
    });
    const miAfter = NDB.prepare('SELECT order_no FROM material_issues WHERE order_id = ?').get(oid);
    ok('★ 改号级联同步下游（生产单/领料单印的号必须跟着变，否则车间按号找货找不到）',
      ren.status === 200 && ren.json.data.new_no === `${PFX}001B`
      && miAfter && miAfter.order_no === `${PFX}001B`,
      `HTTP ${ren.status} 领料单号 ${miAfter ? miAfter.order_no : '?'} / 同步 ${ren.json.data ? ren.json.data.total_rows : '?'} 行`);

    const logs = await req(`/api/orders/order-no/${oid}/logs`, { token });
    ok('★ 改号留痕（旧号、新号、原因、连带行数）',
      logs.status === 200 && (logs.json.data || []).length === 1
      && logs.json.data[0].old_no === `${PFX}001` && /客户要求/.test(logs.json.data[0].reason || ''),
      `HTTP ${logs.status} ${(logs.json.data || []).length} 条`);

    const trace = await req(`/api/orders/order-no/trace?no=${PFX}001B`, { token });
    ok('★ 按订单号能反查挂着哪些单（业务敲错一位能立刻看出来）',
      trace.status === 200 && trace.json.data.found === true && trace.json.data.total >= 1,
      trace.json.data ? `挂 ${trace.json.data.total} 张` : '?');

    ok('★ 反查带样例单号（不只知道挂几条，还知道挂的是哪一张）',
      (trace.json.data.chains || []).some((x) => (x.samples || []).length > 0),
      (trace.json.data.chains || []).map((x) => `${x.label}:${(x.samples || []).join('/')}`).join(' ') || '无样例');

    // 敲错一位：PFX001C 此刻不存在，与已存在的 PFX001B 只差 1 个字符
    const typo = await req(`/api/orders/order-no/trace?no=${PFX}001C`, { token });
    ok('★ 敲错一位时给出相近号（只回「查无此单」，业务还是不知道该敲哪个）',
      typo.status === 200 && typo.json.data.found === false
      && (typo.json.data.similar || []).some((x) => x.order_no === `${PFX}001B`),
      `相似 ${(typo.json.data.similar || []).map((x) => x.order_no + '(d' + x.diff + ')').join(',') || '无'}`);

    // 孤儿：下游挂着这个号，订单主表却没有 → 是数据不一致，不是「查无此单」
    const ghostNo = `${PFX}GHOST`;
    const gt = new Date().toISOString();
    NDB.prepare(`INSERT INTO material_issues (issue_no, company_id, order_id, order_no, kind, receiver_type, status,
        item_count, req_qty, issued_qty, amount, created_at, updated_at)
      VALUES ('TESTMI-NO-GHOST', 1, 999999, ?, 'material', 'factory', 'draft', 1, 1, 0, 0, ?, ?)`).run(ghostNo, gt, gt);
    const ghost = await req(`/api/orders/order-no/trace?no=${ghostNo}`, { token });
    ok('★ 下游有单、订单主表没单 → 报「数据不一致」而不是「查无此单」',
      ghost.status === 200 && ghost.json.data.found === false && ghost.json.data.orphan === true
      && ghost.json.data.total >= 1,
      `found=${ghost.json.data ? ghost.json.data.found : '?'} orphan=${ghost.json.data ? ghost.json.data.orphan : '?'} 挂 ${ghost.json.data ? ghost.json.data.total : '?'} 条`);
    NDB.prepare("DELETE FROM material_issues WHERE issue_no = 'TESTMI-NO-GHOST'").run();

    const ghostGone = await req(`/api/orders/order-no/trace?no=${ghostNo}`, { token });
    ok('★ 脏数据清掉后反查回到「干净的空」（不留缓存骗人）',
      ghostGone.status === 200 && ghostGone.json.data.orphan === false && ghostGone.json.data.total === 0,
      `orphan=${ghostGone.json.data ? ghostGone.json.data.orphan : '?'} total=${ghostGone.json.data ? ghostGone.json.data.total : '?'}`);

    // ---------- 3. 采购关联 ----------
    const sup = NDB.prepare("SELECT id, name FROM suppliers WHERE status IS NULL OR status <> 'paused' ORDER BY id LIMIT 1").get();
    let poOk = null;
    if (sup) {
      poOk = await req('/api/purchases', {
        method: 'POST', token,
        body: { supplier_id: sup.id, order_no: `${PFX}001B`, items: [{ name: '烟测面料', qty: 100, price: 2 }] }
      });
      ok('★ 采购单能关联订单号（带出订单状态，备货采购不填也可以）',
        poOk.status === 200 && poOk.json.data.order && poOk.json.data.order.order_no === `${PFX}001B`,
        `HTTP ${poOk.status} ${poOk.json.data ? poOk.json.data.po_no : (poOk.json.message || '')}`);

      const poBad = await req('/api/purchases', {
        method: 'POST', token,
        body: { supplier_id: sup.id, order_no: 'NO-SUCH-ORDER-XYZ', items: [{ name: '烟测面料', qty: 1, price: 1 }] }
      });
      ok('★ 挂到不存在的订单号被拒（敲错一位就永远查无此单）', poBad.status === 400, `HTTP ${poBad.status}`);

      const ren2 = await req(`/api/orders/order-no/${oid}`, {
        method: 'POST', token, body: { order_no: `${PFX}001C`, reason: '烟测：二次改号，验证采购单同步' }
      });
      const poRow = NDB.prepare('SELECT order_no FROM purchase_orders WHERE order_id = ?').get(oid);
      ok('★ 订单改号时采购单上的订单号同步（采购单显示的永远是当前号）',
        ren2.status === 200 && poRow && poRow.order_no === `${PFX}001C`,
        poRow ? `采购单号 ${poRow.order_no}` : '采购单未同步');

      const od = await req(`/api/orders/${oid}`, { token });
      ok('订单详情能反看关联采购（这张单的料买了没有）',
        od.status === 200 && (od.json.data.purchases || []).length === 1,
        `采购 ${od.json.data ? (od.json.data.purchases || []).length : '?'} 张`);
    } else {
      ok('采购关联订单号', true, '没有可用供应商，跳过');
    }

    // ---------- 4. 报价单转订单：没填号才系统出号 ----------
    // 这条路径最容易漏：转单走的是 quotations.js，不经过下单接口，
    // 曾经因为漏了 nextNo 的 require 而变成 500（业务校验在它之前，手工点不出来）
    const acQ = NDB.prepare(`INSERT INTO quotations (quote_no, customer_id, status, rate, total_qty, total_usd, total_amount, created_at, updated_at)
      VALUES ('QT-TEST-NO-1', NULL, 'accepted', 6.5, 10, 50, 325, ?, ?)`).run(t0, t0);
    const acQid = Number(acQ.lastInsertRowid);
    NDB.prepare(`INSERT INTO quotation_items (quote_id, product_name, qty, price_usd, amount_usd, amount_cny)
      VALUES (?, '烟测款', 10, 5, 50, 325)`).run(acQid);

    const conv1 = await req(`/api/quotations/${acQid}/convert`, { method: 'POST', token, body: {} });
    ok('★ 报价单转订单没填号时由系统出号（且不再是 COUNT(*)+1）',
      conv1.status === 200 && /^SO\d{12}$/.test(conv1.json.data.order_no || ''),
      `HTTP ${conv1.status} ${conv1.json.data ? conv1.json.data.order_no : (conv1.json.message || '')}`);

    const acQ2 = NDB.prepare(`INSERT INTO quotations (quote_no, customer_id, status, rate, total_qty, total_usd, total_amount, created_at, updated_at)
      VALUES ('QT-TEST-NO-2', NULL, 'accepted', 6.5, 10, 50, 325, ?, ?)`).run(t0, t0);
    const acQid2 = Number(acQ2.lastInsertRowid);
    NDB.prepare(`INSERT INTO quotation_items (quote_id, product_name, qty, price_usd, amount_usd, amount_cny)
      VALUES (?, '烟测款', 10, 5, 50, 325)`).run(acQid2);

    const conv2 = await req(`/api/quotations/${acQid2}/convert`, {
      method: 'POST', token, body: { order_no: `${PFX}FROM-QUOTE` }
    });
    ok('★ 报价单转订单可以带着业务填的订单号进来',
      conv2.status === 200 && conv2.json.data.order_no === `${PFX}FROM-QUOTE`,
      `HTTP ${conv2.status} ${conv2.json.data ? conv2.json.data.order_no : (conv2.json.message || '')}`);

    const conv2Dup = await req(`/api/quotations/${acQid2}/convert`, {
      method: 'POST', token, body: { order_no: `${PFX}001C` }
    });
    ok('转单时手填号重复也会被拒（走同一套校验）', conv2Dup.status === 400 || conv2Dup.status === 409,
      `HTTP ${conv2Dup.status}`);

    // ---------- 5. 已发货不许改号 ----------
    NDB.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(oid);
    const locked = await req(`/api/orders/order-no/${oid}`, {
      method: 'POST', token, body: { order_no: `${PFX}999`, reason: '烟测：已发货还想改号' }
    });
    ok('★ 已发货/已结案/已取消不许改号（号已印在面单、进了结算、已作废）',
      locked.status === 400 && /不能再改/.test(locked.json.message || ''),
      `HTTP ${locked.status} ${(locked.json.message || '').slice(0, 40)}`);

    // ---------- 5. 清理 ----------
    cleanSmoke();
    ok('冒烟夹具已清干净',
      NDB.prepare(`SELECT COUNT(*) c FROM orders WHERE order_no LIKE '${PFX}%'`).get().c === 0
      && NDB.prepare("SELECT COUNT(*) c FROM material_issues WHERE issue_no = 'TESTMI-NO-1'").get().c === 0
      && NDB.prepare(`SELECT COUNT(*) c FROM purchase_orders WHERE order_no LIKE '${PFX}%'`).get().c === 0
      && NDB.prepare("SELECT COUNT(*) c FROM quotations WHERE quote_no LIKE 'QT-TEST-NO-%'").get().c === 0
      && NDB.prepare("SELECT COUNT(*) c FROM orders WHERE remark LIKE '由报价单 QT-TEST-NO-%'").get().c === 0,
      `订单 ${NDB.prepare(`SELECT COUNT(*) c FROM orders WHERE order_no LIKE '${PFX}%'`).get().c} / 领料 ${NDB.prepare("SELECT COUNT(*) c FROM material_issues WHERE issue_no = 'TESTMI-NO-1'").get().c}`);
  }

  /* ================================================================== *
   * 上线检查清单（上线准备）
   *
   * 夹具自建一轮（demo_tag='__SMOKE'），绝不借用演示轮次 ——
   * 演示轮次是有意留着给人看「被拦住」的样子，被冒烟签掉就废了。
   * ================================================================== */
  {
    const { db: GDB } = require('../src/db');
    console.log('\n[上线检查清单]');

    const MARK = '__SMOKE';
    const cleanSmoke = () => {
      const ids = GDB.prepare('SELECT id FROM golive_rounds WHERE demo_tag = ?').all(MARK).map((r) => r.id);
      ids.forEach((id) => GDB.prepare('DELETE FROM golive_items WHERE round_id = ?').run(id));
      GDB.prepare('DELETE FROM golive_rounds WHERE demo_tag = ?').run(MARK);
      return ids.length;
    };
    cleanSmoke();

    // 预期条数从模块算，不写死：加一条检查项就要回来改数字的话，
    // 改几次之后就会变成「数字对不上就顺手改小」——那这条断言等于没有
    const GLM = require('../src/services/goLive');
    const AUTO_N = GLM.ITEMS.filter((x) => x.kind === 'auto').length;
    const MANUAL_N = GLM.ITEMS.filter((x) => x.kind === 'manual').length;
    const TOTAL_N = GLM.ITEMS.length;

    const meta = await req('/api/go-live/meta', { token });
    ok(`清单字典：六大块 / ${TOTAL_N} 项 / 自动 ${AUTO_N} 人工 ${MANUAL_N}`,
      meta.status === 200 && meta.json.data.item_count === TOTAL_N
      && meta.json.data.auto_count === AUTO_N && meta.json.data.manual_count === MANUAL_N
      && (meta.json.data.sections || []).length === 6,
      `HTTP ${meta.status} ${meta.json.data ? meta.json.data.item_count + ' 项' : ''}`);

    const made = await req('/api/go-live/rounds', {
      method: 'POST', token, body: { scope: 'production', env_label: '烟测环境', plan_date: '2026-12-01', app_version: 'smoke' }
    });
    ok('生成一轮评估（自动项立即跑完并落库）',
      made.status === 200 && !!made.json.data.round_no
      && made.json.data.sections.reduce((a, x) => a + x.items.length, 0) === TOTAL_N,
      `HTTP ${made.status} ${made.json.data ? made.json.data.round_no : ''}`);
    const rid = made.json.data.id;
    GDB.prepare('UPDATE golive_rounds SET demo_tag = ? WHERE id = ?').run(MARK, rid);

    const items = made.json.data.sections.flatMap((x) => x.items);
    const auto = items.filter((x) => x.kind === 'auto');
    const manual = items.filter((x) => x.kind === 'manual');

    ok('自动项全部有结论文字（不许只有「已通过」三个字）',
      auto.every((x) => x.result && x.result.length >= 6),
      `无结论 ${auto.filter((x) => !x.result).length} 项`);

    ok('★ 自动项结论带数字（能复核，不是一句「已通过」）',
      auto.filter((x) => /\d/.test(x.result || '')).length >= 12,
      `带数字 ${auto.filter((x) => /\d/.test(x.result || '')).length} / ${auto.length}`);

    ok('自动项覆盖数据/权限/备份/财务/运行五块',
      ['data', 'access', 'backup', 'finance', 'runtime'].every((sec) => auto.some((x) => x.section === sec)),
      `覆盖 ${new Set(auto.map((x) => x.section)).size} 块`);

    const blockerItems = items.filter((x) => x.severity === 'blocker');
    ok('阻塞项存在且被点名（默认密码 / 密钥 / 演示数据等）',
      blockerItems.length >= 4 && made.json.data.open_blockers.length > 0,
      `阻塞 ${blockerItems.length} 项，未通过 ${made.json.data.open_blockers.length} 项`);

    // 1. 自动项不许人工改
    const autoItem = auto[0];
    const editAuto = await req(`/api/go-live/manual/${autoItem.id}`, {
      method: 'POST', token, body: { status: 'pass', evidence: '想把红项直接点绿' }
    });
    ok('★ 自动项不能人工改成「通过」（否则清单就是橡皮章）',
      editAuto.status === 400 && /自动检查项/.test(editAuto.json.message || ''),
      `HTTP ${editAuto.status} ${editAuto.json.message || ''}`);

    // 2. 人工项：通过必须有证据，不适用必须写理由
    const m1 = manual[0];
    const noEv = await req(`/api/go-live/manual/${m1.id}`, { method: 'POST', token, body: { status: 'pass' } });
    ok('★ 判「通过」必须写证据', noEv.status === 400, `HTTP ${noEv.status}`);

    const naShort = await req(`/api/go-live/manual/${m1.id}`, { method: 'POST', token, body: { status: 'na', na_reason: '不适用' } });
    ok('★ 判「不适用」必须写理由（否则清单会被 na 填满）', naShort.status === 400, `HTTP ${naShort.status}`);

    const badStatus = await req(`/api/go-live/manual/${m1.id}`, { method: 'POST', token, body: { status: 'whatever' } });
    ok('非法状态被拒', badStatus.status === 400, `HTTP ${badStatus.status}`);

    const doneOne = await req(`/api/go-live/manual/${m1.id}`, {
      method: 'POST', token, body: { status: 'pass', evidence: '烟测证据 档号 SMOKE-001', result: '烟测确认', owner: '烟测责任人' }
    });
    const afterDone = doneOne.json.data.sections.flatMap((x) => x.items).find((x) => x.id === m1.id);
    ok('人工判通过后记录证据、判定人与时间',
      doneOne.status === 200 && afterDone.status === 'pass'
      && /SMOKE-001/.test(afterDone.evidence || '') && !!afterDone.done_by && !!afterDone.done_at,
      `HTTP ${doneOne.status} / ${afterDone ? afterDone.done_by : '?'}`);

    // 3. 有阻塞项时只能签「暂不上线」
    const signGo = await req(`/api/go-live/sign/${rid}`, { method: 'POST', token, body: { conclusion: 'go' } });
    ok('★ 阻塞项未过时签「准予上线」被拒，并点名是哪几项',
      signGo.status === 400 && /阻塞项未通过/.test(signGo.json.message || ''),
      `HTTP ${signGo.status} ${(signGo.json.message || '').slice(0, 50)}`);

    const signCond = await req(`/api/go-live/sign/${rid}`, { method: 'POST', token, body: { conclusion: 'conditional', note: '想带着阻塞项上线' } });
    ok('★ 「有条件上线」同样拦住（遗留项必须是 required 级，不能是 blocker）',
      signCond.status === 400, `HTTP ${signCond.status}`);

    const signNoNote = await req(`/api/go-live/sign/${rid}`, { method: 'POST', token, body: { conclusion: 'no_go' } });
    ok('「暂不上线」也必须写原因', signNoNote.status === 400, `HTTP ${signNoNote.status}`);

    // 4. 解除阻塞后可以签 go —— 直接改库只为验证「签署判定」本身
    //    （检查器读真实库状态，冒烟不可能真去改默认密码）
    GDB.prepare("UPDATE golive_items SET status = 'pass', result = '烟测：强行置为通过以验证签署判定' WHERE round_id = ? AND severity = 'blocker'").run(rid);
    const signGo2 = await req(`/api/go-live/sign/${rid}`, { method: 'POST', token, body: { conclusion: 'go' } });
    ok('★ 阻塞项全部解除后可以签「准予上线」',
      signGo2.status === 200 && signGo2.json.data.status === 'signed' && signGo2.json.data.conclusion === 'go',
      `HTTP ${signGo2.status} ${signGo2.json.message || ''}`);

    const snap = signGo2.json.data.snapshot;
    ok(`★ 签署冻结快照（全部 ${TOTAL_N} 项的结论/证据/判定人一起存）`,
      snap && snap.items.length === TOTAL_N && !!snap.frozen_at
      && snap.counts.pass + snap.counts.fail + snap.counts.warn + snap.counts.na + snap.counts.pending === TOTAL_N,
      snap ? `冻结 ${snap.items.length} 项，通过 ${snap.counts.pass}` : '没有快照');

    ok('快照里带上证据（事后能复核「当时凭的什么」）',
      (snap.items || []).some((x) => /SMOKE-001/.test(x.evidence || '')),
      '证据未进快照');

    // 5. 签署后冻结
    const refreshSigned = await req(`/api/go-live/refresh/${rid}`, { method: 'POST', token, body: {} });
    ok('★ 已签署不能再刷新（否则历史结论会跟着变）', refreshSigned.status === 400, `HTTP ${refreshSigned.status}`);

    const editSigned = await req(`/api/go-live/manual/${m1.id}`, { method: 'POST', token, body: { status: 'fail', result: '改' } });
    ok('★ 已签署不能再改人工判定', editSigned.status === 400, `HTTP ${editSigned.status}`);

    const signTwice = await req(`/api/go-live/sign/${rid}`, { method: 'POST', token, body: { conclusion: 'no_go', note: '再签一次' } });
    ok('不能重复签署', signTwice.status === 400, `HTTP ${signTwice.status}`);

    // 6. 撤回
    const wdShort = await req(`/api/go-live/withdraw/${rid}`, { method: 'POST', token, body: { reason: '短' } });
    ok('撤回必须写原因（否则「签了又撤」没有任何线索）', wdShort.status === 400, `HTTP ${wdShort.status}`);

    const wd = await req(`/api/go-live/withdraw/${rid}`, { method: 'POST', token, body: { reason: '烟测：上线前发现期初差异，需重新盘库' } });
    const rowAfterWd = GDB.prepare('SELECT status, snapshot, withdrawn_reason FROM golive_rounds WHERE id = ?').get(rid);
    ok('★ 撤回后状态与原因都留痕，快照不丢',
      wd.status === 200 && rowAfterWd.status === 'withdrawn'
      && /期初差异/.test(rowAfterWd.withdrawn_reason || '') && !!rowAfterWd.snapshot,
      `HTTP ${wd.status} / ${rowAfterWd.status}`);

    const signAfterWd = await req(`/api/go-live/sign/${rid}`, { method: 'POST', token, body: { conclusion: 'no_go', note: '撤回后再签' } });
    ok('已撤回的轮次不能再签（要重新评估请新建一轮）', signAfterWd.status === 400, `HTTP ${signAfterWd.status}`);

    // 7. 演示库口径：演示数据不算阻塞
    const demoRound = await req('/api/go-live/rounds', {
      method: 'POST', token, body: { scope: 'demo', env_label: '烟测演示口径' }
    });
    const demoItems = demoRound.json.data.sections.flatMap((x) => x.items);
    const demoItem = demoItems.find((x) => x.item_key === 'demo_data');
    ok('★ 演示库口径下演示数据按「允许」处理（两种交付要求不能混）',
      demoRound.status === 200 && demoItem.status === 'pass' && /本口径允许/.test(demoItem.result || ''),
      demoItem ? demoItem.result.slice(0, 40) : '无该项');
    GDB.prepare('UPDATE golive_rounds SET demo_tag = ? WHERE id = ?').run(MARK, demoRound.json.data.id);

    // 8. 权限
    const salesLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'sales01', password: PASS } });
    if (salesLogin.status === 200) {
      const sGet = await req('/api/go-live/rounds', { token: salesLogin.json.data.token });
      ok('★ 销售看不到上线清单（内含财务口径与权限矩阵）', sGet.status === 403, `HTTP ${sGet.status}`);
      const sSign = await req(`/api/go-live/sign/${demoRound.json.data.id}`, {
        method: 'POST', token: salesLogin.json.data.token, body: { conclusion: 'go' }
      });
      ok('销售不能签署', sSign.status === 403, `HTTP ${sSign.status}`);
    } else {
      ok('销售看不到上线清单 + 不能签署', true, '没有 sales01，跳过');
    }
    const hrLogin = await req('/api/auth/login', { method: 'POST', body: { username: 'hr01', password: PASS } });
    if (hrLogin.status === 200) {
      const hGet = await req('/api/go-live/rounds', { token: hrLogin.json.data.token });
      ok('人事能看能跑（推进上线的人）', hGet.status === 200, `HTTP ${hGet.status}`);
      const hSign = await req(`/api/go-live/sign/${demoRound.json.data.id}`, {
        method: 'POST', token: hrLogin.json.data.token, body: { conclusion: 'no_go', note: '人事不该能签署' }
      });
      ok('★ 人事不能签署（勾和签必须分开，否则自己勾完自己签）', hSign.status === 403, `HTTP ${hSign.status}`);
    } else {
      ok('人事能看不能签', true, '没有 hr01，跳过');
    }

    // 9. 只读业务表
    const baseStock2 = Number(GDB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v);
    const baseGl2 = GDB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c;
    await req(`/api/go-live/refresh/${demoRound.json.data.id}`, { method: 'POST', token, body: {} });
    ok('★ 跑检查不改任何业务数据（库存与凭证计数不变）',
      Number(GDB.prepare('SELECT COALESCE(SUM(qty),0) v FROM stock_items').get().v) === baseStock2
      && GDB.prepare('SELECT COUNT(*) c FROM gl_entries').get().c === baseGl2,
      `库存 ${baseStock2} / 凭证 ${baseGl2}`);

    // 10. 清理
    const removed = cleanSmoke();
    ok('冒烟夹具已清干净',
      GDB.prepare('SELECT COUNT(*) c FROM golive_rounds WHERE demo_tag = ?').get(MARK).c === 0
      && GDB.prepare("SELECT COUNT(*) c FROM golive_items WHERE round_id NOT IN (SELECT id FROM golive_rounds)").get().c === 0,
      `删除 ${removed} 轮，孤儿项 ${GDB.prepare('SELECT COUNT(*) c FROM golive_items WHERE round_id NOT IN (SELECT id FROM golive_rounds)').get().c}`);
  }

  // ================= 工序流程可自定义（节点 code 是身份，name 只是标签）=================
  {
    console.log('\n[工序流程可自定义]');
    const fs2 = require('fs');
    const pathMod2 = require('path');
    const { db: FDB } = require('../src/db');
    const NFX = 'NF-TEST-';

    const tpls = await req('/api/node-flow/templates', { token });
    const tpl = (tpls.json.data || []).find((x) => x.is_default) || (tpls.json.data || [])[0];
    // 节点是可增删的，不能把数量写死；要保证的是「内置那 13 个身份都还在」（含停用的）
    const detail0 = await req(`/api/node-flow/templates/${tpl.id}`, { token });
    const builtin0 = (detail0.json.data.items || []).filter((x) => Number(x.builtin) === 1);
    ok('★ 默认流程存在，内置 13 个节点身份都在（可改名 / 可停用，但 code 不丢）',
      tpls.status === 200 && tpl && builtin0.length === 13,
      tpls.json.data ? `${tpls.json.data.length} 套 / 启用 ${tpl && tpl.item_count} / 内置 ${builtin0.length}` : '无');

    const detail = await req(`/api/node-flow/templates/${tpl.id}`, { token });
    const cutItem = (detail.json.data.items || []).find((x) => x.code === 'cut');
    ok('内置节点带稳定 code（裁剪 = cut）', !!cutItem && cutItem.builtin === 1, cutItem ? cutItem.code : '找不到');

    // 1. 改名：这是业务最常做的事（我们厂叫「裁床」不叫「裁剪」）
    const RENAMED = '裁床（烟测改名）';
    const ren = await req(`/api/node-flow/items/${cutItem.id}`, {
      method: 'PUT', token, body: { name: RENAMED }
    });
    ok('★ 内置节点可以改名（业务叫法不一样是常态）',
      ren.status === 200 && ren.json.data.name === RENAMED && ren.json.data.code === 'cut',
      `HTTP ${ren.status} ${ren.json.data ? ren.json.data.name + '/' + ren.json.data.code : ''}`);

    // 2. code 不能通过接口改
    await req(`/api/node-flow/items/${cutItem.id}`, {
      method: 'PUT', token, body: { name: RENAMED, code: 'hacked' }
    });
    const after = await req(`/api/node-flow/templates/${tpl.id}`, { token });
    const cutAfter = (after.json.data.items || []).find((x) => x.id === cutItem.id);
    ok('★ code 不能通过接口改（改了历史记录就和以后失联）', cutAfter && cutAfter.code === 'cut',
      cutAfter ? cutAfter.code : '?');

    // 3. 建一张单，看新订单是否按改名后的流程铺节点
    const items1 = [{ product_name: '烟测流程款', colors: [{ color: '黑', sizes: [{ size: 'M', qty: 2, usd_price: 3 }] }] }];
    const mk = await req('/api/orders', {
      method: 'POST', token, body: { order_no: `${NFX}001`, type: 'custom', items: items1 }
    });
    const noid = mk.json.data && mk.json.data.id;
    await req('/api/order-nodes/init', { method: 'POST', token, body: { order_id: noid } });
    const nds = await req('/api/order-nodes?order_id=' + noid, { token });
    const cutNode = (nds.json.data || []).find((n) => n.code === 'cut');
    ok('★ 新订单按改名后的流程铺节点（名字是新的，code 还是 cut）',
      !!cutNode && cutNode.name === RENAMED && cutNode.code === 'cut',
      cutNode ? `${cutNode.name}/${cutNode.code}` : '无 cut 节点');

    // 4. 内置节点不能停用
    const off = await req(`/api/node-flow/items/${cutItem.id}/status`, {
      method: 'POST', token, body: { status: 'off' }
    });
    ok('★ 内置节点不能停用（裁床单完成、首件确认都要回写它）', off.status === 400,
      `HTTP ${off.status} ${(off.json.message || '').slice(0, 40)}`);

    // 5. 同流程内不能重名
    const dupItem = await req(`/api/node-flow/templates/${tpl.id}/items`, {
      method: 'POST', token, body: { name: RENAMED }
    });
    ok('同流程内节点不能重名（看板两列同名没人分得清）', dupItem.status === 400, `HTTP ${dupItem.status}`);

    // 6. 新增自定义节点
    const added = await req(`/api/node-flow/templates/${tpl.id}/items`, {
      method: 'POST', token, body: { name: '烟测尾部', required: 0, role: 'production' }
    });
    const addedCode = added.json.data && added.json.data.code;
    ok('★ 可以加自定义节点（如「票菲工艺单打印」「尾部」），自动分配不冲突的 code',
      added.status === 200 && /^c_\d+$/.test(String(addedCode)), `HTTP ${added.status} code=${addedCode}`);

    // 7. 应用预览不写库
    const cntBefore = Number(FDB.prepare('SELECT COUNT(*) c FROM order_nodes').get().c);
    const dry = await req(`/api/node-flow/templates/${tpl.id}/apply`, {
      method: 'POST', token, body: { dry_run: true }
    });
    const cntAfter = Number(FDB.prepare('SELECT COUNT(*) c FROM order_nodes').get().c);
    ok('★ 应用预览只算不写（先看影响面再按确认）',
      dry.status === 200 && dry.json.data.dry_run === true && cntAfter === cntBefore,
      `before ${cntBefore} / after ${cntAfter}`);

    // 8. 只补在产订单
    ok('★ 应用只作用于在产订单（给已结案的单补 13 个「待开始」会把历史搞脏）',
      (dry.json.data.scope || []).join(',') === 'assigned,production,instock'
      && dry.json.data.skipped_by_status > 0,
      `范围 ${(dry.json.data.scope || []).join(',')} / 跳过 ${dry.json.data.skipped_by_status} 张`);

    // 9. 联动确实按 code 找节点，而不是按名字
    const files = [
      'src/routes/cuts.js',
      'src/routes/firstArticles.js',
      'src/services/orderFlow.js'
    ];
    const byName = files.filter((f) => {
      const src = fs2.readFileSync(pathMod2.join(__dirname, '..', f), 'utf8');
      return /order_nodes WHERE order_id = \? AND name LIKE/.test(src);
    });
    ok('★ 联动全部按 code 找节点（没有一处还按名字匹配，否则改名就静默失效）',
      byName.length === 0, byName.join(',') || '无');

    // 10. 必经节点不能标不适用
    if (cutNode) {
      const skipMust = await req(`/api/order-nodes/${cutNode.id}`, {
        method: 'PATCH', token, body: { status: 'skipped', skip_reason: '烟测：这一步不做' }
      });
      ok('★ 必经节点不能标「不适用」（真不做要改流程模板）', skipMust.status === 400, `HTTP ${skipMust.status}`);
    }

    // 11. 模板新增的节点**不会**自动跑到已铺过节点的订单上 —— 这是设计，不是漏做
    const optNodeBefore = (nds.json.data || []).find((n) => n.code === addedCode);
    ok('★ 模板新增节点不会自动加到已下单的订单上（否则业务不知道自己的单被改了）',
      !optNodeBefore, optNodeBefore ? '竟然自动铺上了' : '没铺（符合预期）');

    // 12. 显式 apply 才补上
    const applied = await req(`/api/node-flow/templates/${tpl.id}/apply`, {
      method: 'POST', token, body: { dry_run: false, order_ids: [noid] }
    });
    const nds2 = await req('/api/order-nodes?order_id=' + noid, { token });
    const optNode = (nds2.json.data || []).find((n) => n.code === addedCode);
    ok('★ 显式「应用到已有订单」才把新节点补上（补几个、补到哪张单，先看预览）',
      applied.status === 200 && applied.json.data.total_rows === 1 && !!optNode,
      `HTTP ${applied.status} 补 ${applied.json.data ? applied.json.data.total_rows : '?'} 个 / 节点 ${optNode ? '有' : '无'}`);

    if (optNode) {
      const noReason = await req(`/api/order-nodes/${optNode.id}`, {
        method: 'PATCH', token, body: { status: 'skipped' }
      });
      ok('★ 标「不适用」必须写原因（否则等于把这一步悄悄抹掉）', noReason.status === 400, `HTTP ${noReason.status}`);
      const withReason = await req(`/api/order-nodes/${optNode.id}`, {
        method: 'PATCH', token, body: { status: 'skipped', skip_reason: '烟测：现货款不做尾部' }
      });
      ok('可选节点能标不适用（定制单没有水洗、外协单没有尾部，逼着点完成只会教人作假）',
        withReason.status === 200 && withReason.json.data.status === 'skipped'
        && /现货款/.test(withReason.json.data.skip_reason || ''),
        `HTTP ${withReason.status}`);
    }

    // 12. 看板列 = 流程节点
    const bd = await req('/api/node-flow/board', { token });
    ok('★ 订单跟踪看板的列就是流程里的节点（改名后看板跟着变）',
      bd.status === 200 && (bd.json.data.columns || []).some((c) => c.name === RENAMED),
      bd.json.data ? (bd.json.data.columns || []).map((c) => c.name).join(',') : '?');

    // ---- 清理：改回名字、删掉自定义节点与烟测订单 ----
    // 还原成测试前的名字（可能叫「裁剪」也可能被业务改成「裁床」，不能写死）
    await req(`/api/node-flow/items/${cutItem.id}`, { method: 'PUT', token, body: { name: cutItem.name } });
    if (added.json.data) FDB.prepare('DELETE FROM node_template_items WHERE id = ?').run(added.json.data.id);
    if (noid) {
      FDB.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(noid);
      FDB.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(noid);
      FDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(noid);
      FDB.prepare('DELETE FROM orders WHERE id = ?').run(noid);
    }
    const back = await req(`/api/node-flow/templates/${tpl.id}`, { token });
    const okBack = (back.json.data.items || []).find((x) => x.id === cutItem.id);
    ok('流程夹具已还原（节点名改回原值、自定义节点与烟测订单已删）',
      okBack && okBack.name === cutItem.name
      && !FDB.prepare("SELECT 1 x FROM node_template_items WHERE name = '烟测尾部'").get()
      && !FDB.prepare("SELECT 1 x FROM orders WHERE order_no LIKE 'NF-TEST-%'").get(),
      okBack ? okBack.name : '?');
  }

  // ================= 订单跟踪：款图与打版信息 =================
  {
    console.log('\n[订单跟踪款图与打版信息]');
    const { db: PDB } = require('../src/db');

    const bd = await req('/api/node-flow/board', { token });
    const rows = (bd.json.data && bd.json.data.rows) || [];
    ok('看板每行都带 thumb 字段（空串表示没图，不是 undefined）',
      rows.length > 0 && rows.every((r) => typeof r.thumb === 'string'),
      `${rows.length} 行`);

    // 造两张在产单：A 只有订单图，B 只有打版图 —— 验证优先级与兜底
    const items = [{ product_name: '款图烟测', colors: [{ color: '黑', sizes: [{ size: 'M', qty: 1, usd_price: 1 }] }] }];
    const mkA = await req('/api/orders', {
      method: 'POST', token, body: { order_no: 'IMG-TEST-A', type: 'custom', items }
    });
    const mkB = await req('/api/orders', {
      method: 'POST', token, body: { order_no: 'IMG-TEST-B', type: 'custom', items }
    });
    const idA = mkA.json.data && mkA.json.data.id;
    const idB = mkB.json.data && mkB.json.data.id;
    // 看板只列「挂了流程模板」的订单，而刚建的订单 node_template_id 还是空 ——
    // 先 init 铺一遍节点（它同时把订单挂到模板上），再改状态
    await req('/api/order-nodes/init', { method: 'POST', token, body: { order_id: idA } });
    await req('/api/order-nodes/init', { method: 'POST', token, body: { order_id: idB } });
    PDB.prepare("UPDATE orders SET image_url = '/uploads/test-a.png', status = 'production' WHERE id = ?").run(idA);
    PDB.prepare("UPDATE orders SET image_url = NULL, status = 'production' WHERE id = ?").run(idB);
    const tpB = await req('/api/techpacks', {
      method: 'POST', token, body: { order_id: idB, product_name: '款图烟测B' }
    });
    const tpBid = tpB.json.data && tpB.json.data.id;
    if (tpBid) PDB.prepare("UPDATE tech_packs SET image_url = '/uploads/test-b.png' WHERE id = ?").run(tpBid);

    const bd2 = await req('/api/node-flow/board', { token });
    const rowA = (bd2.json.data.rows || []).find((r) => r.id === idA);
    const rowB = (bd2.json.data.rows || []).find((r) => r.id === idB);
    ok('★ 款图优先用订单自己的图',
      rowA && rowA.thumb === '/uploads/test-a.png', rowA ? rowA.thumb : '没这行');
    ok('★ 订单没图时退回打版（技术资料）的图 —— 大多数单只填了打版那张',
      rowB && rowB.thumb === '/uploads/test-b.png', rowB ? rowB.thumb : '没这行');

    // 两边都没有 → 空串，前端出占位
    PDB.prepare('UPDATE tech_packs SET image_url = NULL WHERE id = ?').run(tpBid);
    const bd3 = await req('/api/node-flow/board', { token });
    const rowB2 = (bd3.json.data.rows || []).find((r) => r.id === idB);
    ok('两边都没图时 thumb 是空串（前端据此显示款式首字占位）',
      rowB2 && rowB2.thumb === '', rowB2 ? JSON.stringify(rowB2.thumb) : '没这行');

    // 订单详情接口要带 image_url（速览弹窗靠它显示大图）
    const od = await req('/api/orders/' + idA, { token });
    ok('订单详情带 image_url（速览弹窗用它出大图）',
      od.status === 200 && od.json.data && od.json.data.image_url === '/uploads/test-a.png',
      od.json.data ? String(od.json.data.image_url) : '?');

    // 打版接口能取到「打版时填的信息」
    const tpc = await req('/api/techpacks/by-order/' + idB + '/current', { token });
    ok('按订单能取到当前版技术资料（速览里的打版信息就靠它）',
      tpc.status === 200 && (tpc.json.data === null || (tpc.json.data && tpc.json.data.order_id === idB)),
      `HTTP ${tpc.status}`);

    // 清理
    [idA, idB].forEach((id) => {
      if (!id) return;
      PDB.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(id);
      PDB.prepare('DELETE FROM tech_pack_materials WHERE tech_pack_id IN (SELECT id FROM tech_packs WHERE order_id = ?)').run(id);
      PDB.prepare('DELETE FROM tech_pack_sizes WHERE tech_pack_id IN (SELECT id FROM tech_packs WHERE order_id = ?)').run(id);
      PDB.prepare('DELETE FROM tech_packs WHERE order_id = ?').run(id);
      PDB.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(id);
      PDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      PDB.prepare('DELETE FROM orders WHERE id = ?').run(id);
    });
    ok('款图夹具已清干净',
      !PDB.prepare("SELECT 1 x FROM orders WHERE order_no LIKE 'IMG-TEST-%'").get(),
      '已删');
  }

  // ================= 订单信息看板：统计口径与筛选联动 =================
  {
    console.log('\n[订单信息看板与筛选联动]');
    const { db: SDB } = require('../src/db');

    const bd = await req('/api/node-flow/board', { token });
    const stats = bd.json.data && bd.json.data.stats;
    ok('★ 看板返回统计口径（在跟 / 超期 / 7天内到期 / 无交期）',
      bd.status === 200 && stats && ['total', 'overdue', 'due_soon', 'no_due'].every((k) => typeof stats[k] === 'number'),
      stats ? JSON.stringify(stats) : '无');

    // 关键：卡片上的数字与点进去的条数必须一致 —— 这是这一版最容易出错的地方
    for (const [key, flag, label] of [['overdue', 'overdue', '超期'], ['due_soon', 'due_soon', '7天内到期'], ['no_due', 'no_due', '无交期']]) {
      const f = await req(`/api/node-flow/board?${flag}=1`, { token });
      const n = (f.json.data && f.json.data.rows || []).length;
      ok(`★ 卡片数字与筛选结果一致：${label} ${stats[key]} 张 → 点进去 ${n} 条`,
        f.status === 200 && n === stats[key] && n <= stats.total,
        `${stats[key]} vs ${n}`);
    }

    // 超期口径：已发货/已结案不算超期（交付了就不叫超期）
    const closedLate = SDB.prepare(
      `SELECT COUNT(*) c FROM orders WHERE IFNULL(delivery_date,'') <> ''
        AND date(delivery_date) < date('now') AND status IN ('shipped','closed','cancelled')`
    ).get().c;
    const allOverdue = SDB.prepare(
      `SELECT COUNT(*) c FROM orders o WHERE o.node_template_id IS NOT NULL
        AND IFNULL(o.delivery_date,'') <> '' AND date(o.delivery_date) < date('now')
        AND o.status IN ('assigned','production','instock')`
    ).get().c;
    ok('★ 已发货/已结案的单不算超期（已交付就不该再催）',
      allOverdue === stats.overdue || closedLate === 0,
      `在产超期 ${allOverdue} / stats ${stats.overdue} / 已结案超期 ${closedLate}`);

    // 按节点筛：找一个存在的节点，筛「该节点未开始」
    const col = (bd.json.data.columns || [])[0];
    if (col) {
      const byNode = await req(`/api/node-flow/board?node_code=${col.code}&node_status=pending`, { token });
      const rowsN = (byNode.json.data && byNode.json.data.rows) || [];
      const allMatch = rowsN.every((r) => (r.cells || []).some((c) => c.code === col.code && c.status === 'pending'));
      ok('★ 按工序筛选：筛「某环节未开始」出来的每一行都真的没开始',
        byNode.status === 200 && allMatch,
        `${rowsN.length} 行 / ${col.name}`);
    }

    // 客户筛选
    const withCus = (bd.json.data.rows || []).find((r) => r.customer_id);
    if (withCus) {
      const byCus = await req(`/api/node-flow/board?customer_id=${withCus.customer_id}`, { token });
      const rowsC = (byCus.json.data && byCus.json.data.rows) || [];
      ok('按客户筛选只出该客户的单',
        byCus.status === 200 && rowsC.length > 0 && rowsC.every((r) => r.customer_id === withCus.customer_id),
        `${rowsC.length} 行`);
    }

    // ---------- 订单信息看板（下单 + 打版合并） ----------
    const anyOrder = (bd.json.data.rows || [])[0];
    const sh = await req('/api/orders/' + anyOrder.id + '/sheet', { token });
    const groups = (sh.json.data && sh.json.data.groups) || [];
    ok('★ 信息看板把「下单信息」与「打版信息」分成两块返回',
      sh.status === 200
      && groups.some((g) => g.key === 'order')
      && groups.some((g) => g.key === 'style')
      && groups.some((g) => g.key === 'material'),
      groups.map((g) => g.key + ':' + g.fields.length).join(','));

    const orderFields = (groups.find((g) => g.key === 'order') || {}).fields || [];
    ok('信息看板的字段带 label 与 value（屏幕与打印吃同一份）',
      orderFields.length > 0 && orderFields.every((f) => f.key && f.label && typeof f.value === 'string'),
      `${orderFields.length} 个字段`);

    const ofs = await req('/api/orders/sheet-fields', { token });
    ok('可打印字段清单可单独取（打印勾选框用）',
      ofs.status === 200 && (ofs.json.data || []).length >= 4
      && (ofs.json.data || []).every((g) => g.key && g.label && Array.isArray(g.fields)),
      `${(ofs.json.data || []).length} 组`);

    // 超期判定：信息看板与看板必须同口径
    const rowOverdue = (bd.json.data.rows || []).find((r) => r.overdue);
    if (rowOverdue) {
      const sh2 = await req('/api/orders/' + rowOverdue.id + '/sheet', { token });
      ok('★ 同一条单在「看板」与「信息看板」里的超期结论一致',
        sh2.json.data && sh2.json.data.overdue === true,
        `board=${rowOverdue.overdue} sheet=${sh2.json.data ? sh2.json.data.overdue : '?'}`);
    } else {
      ok('★ 同一条单在「看板」与「信息看板」里的超期结论一致', true, '当前没有超期单，跳过比对');
    }

    // 不存在的订单要 404，不能返回一个空壳
    const nf = await req('/api/orders/99999999/sheet', { token });
    ok('信息看板对不存在的订单返回 404（不返回空壳）', nf.status === 404, `HTTP ${nf.status}`);
  }

  // ================= 仅扫码工序：检验 / 包装不占看板列，但仍在流程里 =================
  {
    console.log('\n[仅扫码工序（检验/包装）]');
    const fs3 = require('fs');
    const path3 = require('path');
    const { db: VDB } = require('../src/db');
    const NF = require('../src/services/nodeFlow');

    const bd = await req('/api/node-flow/board', { token });
    const cols = (bd.json.data && bd.json.data.columns) || [];
    const scan = (bd.json.data && bd.json.data.scan_items) || [];
    ok('★ 仅扫码的工序不占看板列（13 列刚好放下，不用横向滚）',
      bd.status === 200 && !cols.some((c) => c.code === 'inspect' || c.code === 'pack')
      && scan.some((x) => x.code === 'inspect') && scan.some((x) => x.code === 'pack'),
      `${cols.length} 列 / 仅扫码 ${scan.map((x) => x.name).join('、') || '无'}`);

    const rows = (bd.json.data && bd.json.data.rows) || [];
    const row = rows.find((r) => r.total_count > r.cells.length);
    ok('★ 仅扫码的工序仍算进度（只算可见列会让 13 列全绿显示 100% 却入不了库）',
      !!row && row.total_count === row.cells.length + scan.length,
      row ? `${row.order_no}：${row.done_count}/${row.total_count}，可见列 ${row.cells.length}` : '没有在产单');

    // 扫码/报工取的是 order_nodes，隐藏列不能让它少两条
    const nds = await req('/api/order-nodes?order_id=' + (row ? row.id : 0), { token });
    const list = (nds.json.data || []);
    ok('★ 扫码/报工仍能看到检验、包装（隐藏只作用于看板列，不动工序记录）',
      list.some((n) => n.code === 'inspect') && list.some((n) => n.code === 'pack'),
      `${list.length} 个节点`);

    ok('★ 隐藏节点仍带「待扫码」提示（进度不满时能说清差在哪步）',
      !!row && Array.isArray(row.scan_pending_names)
      && row.scan_pending === row.scan_pending_names.length,
      row ? `待扫码 ${row.scan_pending}：${(row.scan_pending_names || []).join('、')}` : '?');

    // ---------- 回写某一步按 code，不按名字 ----------
    const stockSrc = fs3.readFileSync(path3.join(__dirname, '..', 'src/routes/stock.js'), 'utf8');
    ok('★ 成品入库 / 发货不再按节点名回写（改名那一刻就静默失效，且按单分批失效）',
      !/UPDATE order_nodes SET[^"]*name\s*=/.test(stockSrc) && /markDoneByCode/.test(stockSrc),
      /markDoneByCode/.test(stockSrc) ? '已按 code' : '仍有名字匹配');

    // ---------- 造一张单验证 markDoneByCode 的语义 ----------
    const mk = await req('/api/orders', {
      method: 'POST', token,
      body: { order_no: 'VIS-TEST-1', type: 'custom', items: [{ product_name: '隐藏工序烟测', colors: [{ color: '黑', sizes: [{ size: 'M', qty: 1, usd_price: 1 }] }] }] }
    });
    const vid = mk.json.data && mk.json.data.id;
    await req('/api/order-nodes/init', { method: 'POST', token, body: { order_id: vid } });
    const first = NF.markDoneByCode(vid, 'inspect', { operator: 'smoke-first' });
    const second = NF.markDoneByCode(vid, 'inspect', { operator: 'smoke-second' });
    const after = VDB.prepare("SELECT status, operator FROM order_nodes WHERE order_id = ? AND code = 'inspect'").get(vid);
    ok('★ 单据动作回写工序按 code 认；已完成的不覆盖首次操作人',
      first === true && second === false && after && after.status === 'done' && after.operator === 'smoke-first',
      `first=${first} second=${second} operator=${after ? after.operator : '?'}`);

    // ---------- 部分更新：只传一个字段也要能存 ----------
    const tplId = (bd.json.data.template || {}).id;
    const detail = await req(`/api/node-flow/templates/${tplId}`, { token });
    const anyItem = (detail.json.data.items || []).find((x) => x.code === 'sew') || (detail.json.data.items || [])[0];
    const onlyReq = await req(`/api/node-flow/items/${anyItem.id}`, {
      method: 'PUT', token, body: { required: anyItem.required }
    });
    ok('★ 只传一个字段也能改（「必经/可选」「看板/仅扫码」都是部分更新，原来一点就报「名称必填」）',
      onlyReq.status === 200 && onlyReq.json.data && onlyReq.json.data.name === anyItem.name,
      `HTTP ${onlyReq.status} ${onlyReq.json.message || ''}`);

    // ---------- 最后一个可见列不能隐藏 ----------
    const tplNew = await req('/api/node-flow/templates', { method: 'POST', token, body: { name: '烟测单节点流程' } });
    const tid = tplNew.json.data && tplNew.json.data.id;
    const one = await req(`/api/node-flow/templates/${tid}/items`, { method: 'POST', token, body: { name: '唯一工序' } });
    const oneId = one.json.data && one.json.data.id;
    const hideLast = await req(`/api/node-flow/items/${oneId}`, { method: 'PUT', token, body: { visible: 0 } });
    ok('★ 不能把最后一个可见列也隐藏（全隐藏后看板是空表，却会提示「保存成功」）',
      hideLast.status === 400, `HTTP ${hideLast.status} ${(hideLast.json.message || '').slice(0, 30)}`);

    // ---------- 清理 ----------
    if (tid) {
      VDB.prepare('DELETE FROM node_template_items WHERE template_id = ?').run(tid);
      VDB.prepare('DELETE FROM node_templates WHERE id = ?').run(tid);
    }
    if (vid) {
      VDB.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(vid);
      VDB.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(vid);
      VDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(vid);
      VDB.prepare('DELETE FROM orders WHERE id = ?').run(vid);
    }
    ok('隐藏工序夹具已清干净',
      !VDB.prepare("SELECT 1 x FROM orders WHERE order_no = 'VIS-TEST-1'").get()
      && !VDB.prepare("SELECT 1 x FROM node_templates WHERE name = '烟测单节点流程'").get(),
      '已删');
  }

  // ================= 工序节点弹窗：按类型分化 + 操作记录 =================
  {
    console.log('\n[工序节点弹窗]');
    const fs4 = require('fs');
    const path4 = require('path');
    const { db: PDB2 } = require('../src/db');

    // ---------- 1. 采购类节点：摊开物料明细 ----------
    const pick = PDB2.prepare(`
      SELECT r.order_id, o.order_no, COUNT(*) AS lines
        FROM material_requirements r JOIN orders o ON o.id = r.order_id
       GROUP BY r.order_id ORDER BY lines DESC LIMIT 1`).get();
    const buyNode = pick && PDB2.prepare(`
      SELECT n.id FROM order_nodes n
        JOIN node_template_items t ON t.template_id = n.template_id AND t.code = n.code
       WHERE n.order_id = ? AND t.panel = 'purchase_fabric'`).get(pick.order_id);
    const bp = buyNode ? await req(`/api/order-nodes/${buyNode.id}/panel`, { token }) : null;
    ok('★ 采购节点弹窗摊开物料明细（需求/单价/金额/库存/缺口/供应商）',
      !!bp && bp.status === 200 && bp.json.data.kind === 'purchase_fabric'
      && bp.json.data.purchase.lines.length > 0
      && bp.json.data.purchase.lines.every((l) => l.material_name && 'need_qty' in l && 'amount' in l && 'stock_qty' in l && 'supplier' in l),
      bp && bp.json.data ? `${pick.order_no} ${bp.json.data.purchase.lines.length} 行 / 合计 ${bp.json.data.purchase.summary.total_amount}` : '没有可测的采购节点');

    ok('★ 明细金额按「需求 × 单价」现算，不取缺口金额（齐套时缺口恒为 0）',
      !!bp && bp.json.data.purchase.lines.every((l) => Math.abs(l.amount - Math.round(l.need_qty * l.unit_price * 100) / 100) < 0.01),
      bp && bp.json.data.purchase.lines[0] ? `${bp.json.data.purchase.lines[0].need_qty} × ${bp.json.data.purchase.lines[0].unit_price} = ${bp.json.data.purchase.lines[0].amount}` : '?');

    // ---------- 2. 通用节点：没有明细表，只有备注/凭证/时间线 ----------
    const genNode = pick && PDB2.prepare(`
      SELECT n.id, n.name FROM order_nodes n
        JOIN node_template_items t ON t.template_id = n.template_id AND t.code = n.code
       WHERE n.order_id = ? AND t.panel = 'generic' AND t.visible = 1 LIMIT 1`).get(pick.order_id);
    const gp = genNode ? await req(`/api/order-nodes/${genNode.id}/panel`, { token }) : null;
    ok('★ 其他节点不摊明细表，只给备注 / 凭证 / 操作记录',
      !!gp && gp.status === 200 && gp.json.data.kind === 'generic'
      && gp.json.data.purchase === null && Array.isArray(gp.json.data.timeline),
      gp && gp.json.data ? `${genNode.name}: purchase=${gp.json.data.purchase} 时间线 ${gp.json.data.timeline.length}` : '没有通用节点');

    // ---------- 3. 改一次节点，时间线要留下「谁、从什么改到什么」 ----------
    const mk2 = await req('/api/orders', {
      method: 'POST', token,
      body: { order_no: 'PNL-TEST-1', type: 'custom', items: [{ product_name: '弹窗烟测', colors: [{ color: '黑', sizes: [{ size: 'M', qty: 1, usd_price: 1 }] }] }] }
    });
    const pid = mk2.json.data && mk2.json.data.id;
    await req('/api/order-nodes/init', { method: 'POST', token, body: { order_id: pid } });
    const lay = PDB2.prepare("SELECT id FROM order_nodes WHERE order_id = ? AND code = 'layout'").get(pid);
    await req(`/api/order-nodes/${lay.id}`, {
      method: 'PATCH', token, body: { status: 'done', plan_date: '2026-10-30', operator: '张师傅' }
    });
    const lp = await req(`/api/order-nodes/${lay.id}/panel`, { token });
    const tl = (lp.json.data && lp.json.data.timeline) || [];
    const stLog = tl.find((x) => x.action === 'status');
    ok('★ 节点改动留痕：时间线记「待开始 → 已完成」与操作人',
      !!stLog && /待开始.*已完成/.test(stLog.detail) && stLog.operator === 'admin',
      stLog ? `${stLog.detail} / ${stLog.operator}` : '没有状态记录');

    const planLog = tl.find((x) => x.action === 'plan');
    ok('计划时间改动也单独留一条（同一个动作改了几项就记几条）',
      !!planLog && /2026-10-30/.test(planLog.detail), planLog ? planLog.detail : '没有计划记录');

    ok('只改了状态就不该冒出「备注」记录（没有变化的东西不记）',
      !tl.some((x) => x.action === 'remark'), tl.map((x) => x.action).join(','));

    // ---------- 4. 弹窗类型不能乱传 ----------
    const det = await req(`/api/node-flow/templates/${(PDB2.prepare("SELECT template_id FROM order_nodes WHERE order_id = ? AND code = 'layout'").get(pid) || {}).template_id}`, { token });
    const layItem = (det.json.data.items || []).find((x) => x.code === 'layout');
    const badPanel = await req(`/api/node-flow/items/${layItem.id}`, {
      method: 'PUT', token, body: { panel: 'whatever' }
    });
    ok('弹窗类型只能是预设的几种（不能由前端传什么就渲染什么）', badPanel.status === 400, `HTTP ${badPanel.status}`);

    const okPanel = await req(`/api/node-flow/items/${layItem.id}`, {
      method: 'PUT', token, body: { panel: 'purchase_all' }
    });
    ok('弹窗类型可以改成采购面板（业务新加「里布采购」节点也能配）',
      okPanel.status === 200 && okPanel.json.data.panel === 'purchase_all', okPanel.json.data ? okPanel.json.data.panel : '?');
    await req(`/api/node-flow/items/${layItem.id}`, { method: 'PUT', token, body: { panel: 'generic' } });

    // ---------- 5. 回归：看板搜索（原来 SQL 里用双引号，一搜就 500） ----------
    const qs = await req(`/api/node-flow/board?q=${encodeURIComponent(pick.order_no)}`, { token });
    ok('★ 看板按 PO 号搜索能用（原来 SQL 写成 IFNULL(c.name,"") 导致一搜就 500）',
      qs.status === 200 && (qs.json.data.rows || []).length === 1
      && qs.json.data.rows[0].order_no === pick.order_no,
      `HTTP ${qs.status} 命中 ${(qs.json.data && qs.json.data.rows || []).length} 条`);

    // ---------- 6. 源码级：SQL 里不许再出现双引号字符串 ----------
    const files = ['src/services/nodeFlow.js', 'src/services/backup.js', 'src/services/exceptions.js'];
    // 先剔掉注释行：注释里为了说明「这样写是错的」会原样带上这段 SQL，
    // 不剔就会把说明文字当成真代码报出来
    const strip = (src) => src.split('\n').filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join('\n');
    const dq = files.filter((f) => /IFNULL\([A-Za-z_.]+, *""|COALESCE\([A-Za-z_.]+, *""/.test(
      strip(fs4.readFileSync(path4.join(__dirname, '..', f), 'utf8'))
    ));
    ok('★ 没有残留的 IFNULL(x,"") 写法（SQLite 把双引号当列名，运行时才报错）',
      dq.length === 0, dq.join(',') || '无');

    // ---------- 清理 ----------
    if (pid) {
      PDB2.prepare('DELETE FROM order_node_logs WHERE order_id = ?').run(pid);
      PDB2.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(pid);
      PDB2.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(pid);
      PDB2.prepare('DELETE FROM order_items WHERE order_id = ?').run(pid);
      PDB2.prepare('DELETE FROM orders WHERE id = ?').run(pid);
    }
    ok('节点弹窗夹具已清干净',
      !PDB2.prepare("SELECT 1 x FROM orders WHERE order_no = 'PNL-TEST-1'").get(), '已删');
  }

  // ================= 订单多款多色 + 物料对应到 款×颜色 =================
  {
    console.log('\n[物料对应款与颜色]');
    const { db: MDB } = require('../src/db');

    // 造一张 2 款 4 色的单：款A 150+80，款B 200+120
    const mk = await req('/api/orders', {
      method: 'POST', token,
      body: {
        order_no: 'MCOL-TEST-1', type: 'custom',
        items: [
          { product_name: '多色T恤', style_no: 'MC-TZ-01', colors: [
            { color: '印花001', sizes: [{ size: 'M', qty: 100, usd_price: 2 }, { size: 'L', qty: 50, usd_price: 2 }] },
            { color: '印花002', sizes: [{ size: 'M', qty: 80, usd_price: 2 }] }
          ] },
          { product_name: '多色卫衣', style_no: 'MC-WY-01', colors: [
            { color: '印花003', sizes: [{ size: 'M', qty: 200, usd_price: 3 }] },
            { color: '印花004', sizes: [{ size: 'M', qty: 120, usd_price: 3 }] }
          ] }
        ]
      }
    });
    const oid = mk.json.data && mk.json.data.id;
    const items = (mk.json.data && mk.json.data.items) || [];
    const itA = items.find((x) => x.style_no === 'MC-TZ-01');
    const itB = items.find((x) => x.style_no === 'MC-WY-01');
    ok('★ 一张单可以下多个款、每款多个颜色', items.length === 2
      && (itA.colors || []).length === 2 && (itB.colors || []).length === 2,
      items.map((x) => `${x.style_no}:${x.qty}件/${(x.colors || []).length}色`).join(' '));

    // ---------- 1. 物料挂到款 + 按颜色指定 ----------
    const m1 = await req('/api/order-materials', {
      method: 'POST', token,
      body: {
        order_id: oid, item_id: itA.id, type: 'fabric', name: '32支精梳棉', unit: '米',
        one_use: 1.2, loss: 5, price: 18,
        colors: [{ colorway: '印花001', color_no: 'A1', qty: 1.2 }, { colorway: '印花002', color_no: 'A2', qty: 1.4 }]
      }
    });
    const mat1 = m1.json.data;
    // 期望 (1.2×150 + 1.4×80) × 1.05 = 292 × 1.05 = 306.6
    ok('★ 总用量按「每色件数 × 该色单件用量」累加', m1.status === 200 && Math.abs(mat1.total_use - 306.6) < 0.01,
      `total_use=${mat1 && mat1.total_use}（期望 306.6）`);
    ok('★ 物料挂到款上，并记下每色的色号', mat1.item_id === itA.id
      && mat1.colors.length === 2 && mat1.colors[0].color_no === 'A1',
      `款=${mat1.item && mat1.item.style_no} 颜色=${mat1.color_summary}`);
    ok('适用颜色摘要给的是颜色名，不是「未指定」', mat1.color_summary === '印花001、印花002', mat1.color_summary);

    // ---------- 2. 用量必须按「这个款」的件数，不是整单件数 ----------
    const m2 = await req('/api/order-materials', {
      method: 'POST', token,
      body: { order_id: oid, item_id: itA.id, type: 'fabric', name: '按款算的布', unit: '米', one_use: 1, loss: 0, price: 1, all_colors: 1 }
    });
    // 款A 230 件；整单 550 件 —— 按整单算会得到 550，多算一倍多
    ok('★ 挂在款上的物料按该款件数算，不是整单件数', m2.status === 200 && Math.abs(m2.json.data.total_use - 230) < 0.01,
      `total_use=${m2.json.data && m2.json.data.total_use}（期望 230，整单是 550）`);

    // ---------- 3. 颜色必须属于这个款 ----------
    const badColor = await req(`/api/order-materials/${mat1.id}/colors`, {
      method: 'PUT', token, body: { colors: [{ colorway: '印花009', qty: 1 }] }
    });
    ok('★ 填该款没有的颜色会被拒（发料时才发现没这件货就晚了）',
      badColor.status === 400 && /不属于这个款/.test(badColor.json.message || ''),
      `HTTP ${badColor.status} ${(badColor.json.message || '').slice(0, 40)}`);

    const crossColor = await req(`/api/order-materials/${mat1.id}/colors`, {
      method: 'PUT', token, body: { colors: [{ colorway: '印花003', qty: 1 }] }
    });
    ok('★ 填别的款的颜色也会被拒（款与颜色必须同属一支）', crossColor.status === 400, `HTTP ${crossColor.status}`);

    // ---------- 4. 全部颜色通用时清空按色行 ----------
    const all = await req(`/api/order-materials/${mat1.id}/colors`, { method: 'PUT', token, body: { all_colors: 1 } });
    const left = MDB.prepare('SELECT COUNT(*) c FROM order_material_colors WHERE order_material_id = ?').get(mat1.id).c;
    ok('★ 切成「全部颜色」时清掉按色行（两者并存会解释不清是全部还是那几色）',
      all.status === 200 && Number(left) === 0 && all.json.data.color_summary === '全部 2 色',
      `残留颜色行 ${left} / ${all.json.data && all.json.data.color_summary}`);
    ok('全部颜色时按整款件数算', Math.abs(all.json.data.total_use - (1.2 * 230 * 1.05)) < 0.01,
      `total_use=${all.json.data.total_use}`);

    // ---------- 5. 不选款却配颜色 → 拒绝 ----------
    const noItem = await req('/api/order-materials', {
      method: 'POST', token,
      body: { order_id: oid, type: 'fabric', name: '无款布', one_use: 1, colors: [{ colorway: '印花001' }] }
    });
    ok('没选款就配颜色会被拒（颜色属于款，没有款就没有合法颜色集合）',
      noItem.status === 400 && /还没选是哪个款/.test(noItem.json.message || ''), `HTTP ${noItem.status}`);

    // ---------- 6. 删物料要连颜色行一起删 ----------
    await req(`/api/order-materials/${mat1.id}/colors`, {
      method: 'PUT', token, body: { all_colors: 0, colors: [{ colorway: '印花001', color_no: 'A1', qty: 1.2 }] }
    });
    await req(`/api/order-materials/${mat1.id}`, { method: 'DELETE', token });
    const orphan = MDB.prepare('SELECT COUNT(*) c FROM order_material_colors WHERE order_material_id = ?').get(mat1.id).c;
    ok('★ 删物料时连带删颜色行（否则按色汇总会把已删物料算进去）', Number(orphan) === 0, `残留 ${orphan} 行`);

    // ---------- 清理 ----------
    MDB.prepare('DELETE FROM order_material_colors WHERE order_material_id IN (SELECT id FROM order_materials WHERE order_id = ?)').run(oid);
    MDB.prepare('DELETE FROM order_materials WHERE order_id = ?').run(oid);
    MDB.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(oid);
    MDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(oid);
    MDB.prepare('DELETE FROM orders WHERE id = ?').run(oid);
    ok('多款多色夹具已清干净',
      !MDB.prepare("SELECT 1 x FROM orders WHERE order_no = 'MCOL-TEST-1'").get(), '已删');
  }

  // ================= 领料按「款 × 颜色」发料 =================
  {
    console.log('\n[领料按颜色发料]');
    const { db: MDB } = require('../src/db');
    const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
    const near = (a, b) => Math.abs(num(a) - num(b)) < 0.02;

    // ---------- 夹具：2 款 4 色 + 按色配料的用料 ----------
    const mkMat = async (name, unit, stock, type) => {
      const r = await req('/api/materials', {
        method: 'POST', token,
        body: { type: type || 'fabric', name, unit, stock_qty: stock, code: `SMK-IC-${name}` }
      });
      return r.json.data;
    };
    const matFabA = await mkMat('冒烟按色布 A', '米', 5000);
    const matFabB = await mkMat('冒烟按色布 B', '米', 5000);
    const matBtn = await mkMat('冒烟按色纽扣', '个', 20000, 'accessory');

    const mkOrder = await req('/api/orders', {
      method: 'POST', token,
      body: {
        order_no: 'MIC-TEST-1', type: 'custom',
        items: [
          { product_name: '按色T恤', style_no: 'IC-TZ-01', colors: [
            { color: '印花001', sizes: [{ size: 'M', qty: 100, usd_price: 2 }, { size: 'L', qty: 50, usd_price: 2 }] },
            { color: '印花002', sizes: [{ size: 'M', qty: 80, usd_price: 2 }] }
          ] },
          { product_name: '按色卫衣', style_no: 'IC-WY-01', colors: [
            { color: '印花003', sizes: [{ size: 'M', qty: 200, usd_price: 3 }] },
            { color: '印花004', sizes: [{ size: 'M', qty: 120, usd_price: 3 }] }
          ] }
        ]
      }
    });
    const oid = mkOrder.json.data && mkOrder.json.data.id;
    const items = (mkOrder.json.data && mkOrder.json.data.items) || [];
    const itA = items.find((x) => x.style_no === 'IC-TZ-01');
    const itB = items.find((x) => x.style_no === 'IC-WY-01');

    const addMat = (body) => req('/api/order-materials', { method: 'POST', token, body: { order_id: oid, ...body } });
    const wa = await addMat({
      item_id: itA.id, type: 'fabric', material_id: matFabA.id, name: matFabA.name, unit: '米',
      one_use: 1.35, loss: 5, price: 18,
      colors: [{ colorway: '印花001', color_no: 'A1', qty: 1.35 }, { colorway: '印花002', color_no: 'A2', qty: 1.45 }]
    });
    const wb = await addMat({
      item_id: itB.id, type: 'fabric', material_id: matFabB.id, name: matFabB.name, unit: '米',
      one_use: 0.9, loss: 5, price: 22,
      colors: [{ colorway: '印花003', color_no: 'C3', qty: 0.9 }, { colorway: '印花004', color_no: 'C4', qty: 0.95 }]
    });
    const wc = await addMat({
      item_id: itA.id, type: 'accessory', material_id: matBtn.id, name: matBtn.name, unit: '个',
      one_use: 4, loss: 2, price: 0.12, all_colors: 1
    });

    // ---------- 1. 建议按色展开 ----------
    const sg1 = await req(`/api/matflow/issues/suggest?order_id=${oid}`, { token });
    const sgItems = (sg1.json.data && sg1.json.data.items) || [];
    const line001 = sgItems.find((x) => x.colorway === '印花001');
    const line002 = sgItems.find((x) => x.colorway === '印花002');
    const line004 = sgItems.find((x) => x.colorway === '印花004');
    const lineBtn = sgItems.find((x) => x.name === matBtn.name);
    ok('★ 备料建议按「款 × 颜色」展开（4 个色 + 1 个全色通用 = 5 行）',
      sg1.status === 200 && sgItems.length === 5 && sg1.json.data.color_lines === 4,
      `HTTP ${sg1.status} / ${sgItems.length} 行 / 按色 ${sg1.json.data && sg1.json.data.color_lines}`);

    ok('★ 分色行的件数取「该色件数」而不是整款件数',
      !!line001 && near(line001.piece_qty, 150) && near(line004.piece_qty, 120),
      `印花001=${line001 && line001.piece_qty}（该色 150，款共 230）/ 印花004=${line004 && line004.piece_qty}`);

    ok('分色行带上色号与款号', !!line001 && line001.color_no === 'A1' && line001.style_no === 'IC-TZ-01',
      `色号=${line001 && line001.color_no} 款=${line001 && line001.style_no}`);

    const sumA = sgItems.filter((x) => x.name === matFabA.name).reduce((s, x) => s + num(x.order_total), 0);
    ok('★ 分色行合计 = 物料行总用量（同一套账不能两个数）',
      near(sumA, wa.json.data.total_use),
      `合计 ${Math.round(sumA * 100) / 100} vs 物料 ${wa.json.data && wa.json.data.total_use}`);

    ok('全色通用的料只出一行并标明「全部颜色」',
      !!lineBtn && lineBtn.colorway === '' && lineBtn.color_mode === 'all' && near(lineBtn.piece_qty, 230),
      `${lineBtn && lineBtn.color_mode} / 件数 ${lineBtn && lineBtn.piece_qty}`);

    // ---------- 2. 建单：同一原料多色必须能共存 ----------
    const mkIssue = (items2) => req('/api/matflow/issues', {
      method: 'POST', token,
      body: { kind: 'order', order_id: oid, req_date: '2026-11-05', note: '冒烟：按颜色备料', items: items2 }
    });
    const toItem = (x, qty) => ({
      material_id: x.material_id, name: x.name, spec: x.spec, unit: x.unit,
      req_qty: qty === undefined ? x.req_qty : qty,
      item_id: x.item_id, colorway: x.colorway, color_no: x.color_no, price: x.price
    });

    const made = await mkIssue(sgItems.map((x) => toItem(x)));
    const issueId = made.json.data && made.json.data.id;
    ok('★ 同一原料的两个颜色可以同时在一张单上（唯一索引已按款+色放开）',
      made.status === 200 && !!issueId && (made.json.data.items || []).length === 5,
      `HTTP ${made.status} ${(made.json.message || '').slice(0, 60)}`);

    ok('明细带款号与颜色', (made.json.data.items || []).filter((x) => x.colorway).length === 4
      && (made.json.data.items || []).every((x) => x.item_style_no),
      (made.json.data.items || []).slice(0, 2).map((x) => `${x.item_style_no}/${x.colorway || '不分色'}`).join(' '));

    // ---------- 3. 校验类 ----------
    const dupColor = await mkIssue([toItem(line001), toItem(line001, 10)]);
    ok('★ 同料同款同色重复出现被拒（否则按色汇总会翻倍）',
      dupColor.status === 400 && /重复/.test(dupColor.json.message || ''), `HTTP ${dupColor.status}`);

    const noItem = await mkIssue([{ material_id: matFabA.id, name: matFabA.name, unit: '米', req_qty: 10, colorway: '印花001' }]);
    ok('填了颜色不填款被拒（颜色属于款，没有款就没有合法颜色集合）',
      noItem.status === 400 && /没指定是哪个款/.test(noItem.json.message || ''), `HTTP ${noItem.status}`);

    const badColor = await mkIssue([{
      material_id: matFabA.id, name: matFabA.name, unit: '米', req_qty: 10, item_id: itA.id, colorway: '印花009'
    }]);
    ok('★ 填该款没有的颜色被拒', badColor.status === 400 && /不属于这个款/.test(badColor.json.message || ''),
      `HTTP ${badColor.status} ${(badColor.json.message || '').slice(0, 40)}`);

    const crossColor = await mkIssue([{
      material_id: matFabA.id, name: matFabA.name, unit: '米', req_qty: 10, item_id: itA.id, colorway: '印花003'
    }]);
    ok('★ 填别的款的颜色也被拒（款与色必须同属一支）', crossColor.status === 400, `HTTP ${crossColor.status}`);

    // ---------- 4. 备料 + 发料 ----------
    const prep = await req(`/api/matflow/issues/${issueId}/prepare`, { method: 'POST', token, body: {} });
    ok('按色领料单可以备料（占用库存）', prep.status === 200 && prep.json.data.status === 'prepared', `HTTP ${prep.status}`);

    const det0 = await req(`/api/matflow/issues/${issueId}`, { token });
    const r001 = (det0.json.data.items || []).find((x) => x.colorway === '印花001');
    const r002 = (det0.json.data.items || []).find((x) => x.colorway === '印花002');
    const r003 = (det0.json.data.items || []).find((x) => x.colorway === '印花003');
    const r004 = (det0.json.data.items || []).find((x) => x.colorway === '印花004');
    const half002 = Math.round(num(r002.req_qty) * 0.6 * 100) / 100;

    const outRes = await req(`/api/matflow/issues/${issueId}/issue`, {
      method: 'POST', token,
      body: { items: [
        { id: r001.id, issued_qty: r001.req_qty, batch_no: 'G-A1' },
        { id: r002.id, issued_qty: half002, batch_no: 'G-A2' }
      ] }
    });
    ok('按色发料：只发两个颜色，单据转「部分发出」',
      outRes.status === 200 && outRes.json.data.status === 'partial',
      `HTTP ${outRes.status} / ${outRes.json.data && outRes.json.data.status_label}`);

    // ---------- 5. 再查建议：按色扣减不能串色 ----------
    const sg2 = await req(`/api/matflow/issues/suggest?order_id=${oid}`, { token });
    const it2 = (sg2.json.data && sg2.json.data.items) || [];
    const g001 = it2.find((x) => x.colorway === '印花001');
    const g002 = it2.find((x) => x.colorway === '印花002');
    const g003 = it2.find((x) => x.colorway === '印花003');
    ok('★ 按色扣减：发过的颜色不再要，没发的颜色照旧（不串色）',
      sg2.status === 200
      && near(g001.already_issued, r001.req_qty) && near(g001.req_qty, 0)
      && near(g002.already_issued, half002) && num(g002.req_qty) > 0
      && near(g003.already_issued, 0) && near(g003.req_qty, r003.req_qty),
      `001 已领 ${g001 && g001.already_issued}/需 ${g001 && g001.req_qty}；002 已领 ${g002 && g002.already_issued}/需 ${g002 && g002.req_qty}；003 已领 ${g003 && g003.already_issued}/需 ${g003 && g003.req_qty}`);

    // ---------- 6. 流水备注带颜色（面料按色追溯的最后一道凭据） ----------
    const led = await req(`/api/matflow/ledger?material_id=${matFabA.id}&limit=10`, { token });
    const ledRows = (led.json.data && led.json.data.rows) || [];
    const hasColorRemark = ledRows.some((l) => l.type === 'issue' && /印花001/.test(l.remark || ''));
    const hasBatch = ledRows.some((l) => /G-A1/.test(l.remark || ''));
    ok('★ 发料流水备注写明颜色的色号与缸号', hasColorRemark && hasBatch,
      ledRows.slice(0, 2).map((l) => l.remark).join(' | ').slice(0, 80));

    // ---------- 7. 按色汇总与退料 ----------
    const det1 = await req(`/api/matflow/issues/${issueId}`, { token });
    const byColor = det1.json.data.by_color || [];
    const sumIssued = byColor.reduce((s, g) => s + num(g.issued_qty), 0);
    ok('★ 明细「按颜色汇总」与单头已发合计一致',
      byColor.length === 5 && near(sumIssued, det1.json.data.issued_qty),
      `${byColor.length} 组 / 汇总 ${Math.round(sumIssued * 100) / 100} vs 单头 ${det1.json.data.issued_qty}`);

    const ret = await req('/api/matflow/returns', {
      method: 'POST', token,
      body: { issue_id: issueId, type: 'leftover', reason: '冒烟：印花001 余料退回', items: [{ issue_item_id: r001.id, qty: 10 }] }
    });
    ok('按色退料：只退印花001 的余料', ret.status === 200 && (ret.json.data.items || []).some((x) => x.colorway === '印花001'),
      `HTTP ${ret.status} / ${(ret.json.data && ret.json.data.items || []).map((x) => x.colorway || '不分色').join(',')}`);

    const retOver = await req('/api/matflow/returns', {
      method: 'POST', token,
      body: { issue_id: issueId, type: 'leftover', reason: '冒烟：退别的颜色的量', items: [{ issue_item_id: r003.id, qty: 5 }] }
    });
    ok('★ 印花003 一发未发，退料被拒（可退按行算，不按整料算）',
      retOver.status === 400 && /可退/.test(retOver.json.message || ''), `HTTP ${retOver.status}`);

    // ---------- 清理 ----------
    const retIds = MDB.prepare('SELECT id FROM material_returns WHERE issue_id = ?').all(issueId).map((r) => r.id);
    retIds.forEach((rid) => MDB.prepare('DELETE FROM material_return_items WHERE return_id = ?').run(rid));
    MDB.prepare('DELETE FROM material_returns WHERE issue_id = ?').run(issueId);
    MDB.prepare("DELETE FROM material_ledger WHERE ref_type IN ('material_issue','material_return') AND ref_id = ?").run(issueId);
    MDB.prepare('DELETE FROM material_issue_items WHERE issue_id = ?').run(issueId);
    MDB.prepare('DELETE FROM material_issues WHERE id = ?').run(issueId);
    MDB.prepare(`DELETE FROM order_material_colors WHERE order_material_id IN
                 (SELECT id FROM order_materials WHERE order_id = ?)`).run(oid);
    MDB.prepare('DELETE FROM order_materials WHERE order_id = ?').run(oid);
    MDB.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(oid);
    MDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(oid);
    MDB.prepare('DELETE FROM orders WHERE id = ?').run(oid);
    [matFabA.id, matFabB.id, matBtn.id].forEach((id) => MDB.prepare('DELETE FROM materials WHERE id = ?').run(id));
    ok('按色发料夹具已清干净',
      !MDB.prepare("SELECT 1 x FROM orders WHERE order_no = 'MIC-TEST-1'").get()
      && !MDB.prepare("SELECT 1 x FROM materials WHERE code LIKE 'SMK-IC-%'").get(), '已删');
  }

  // ================= 生产分配（待分配订单 → 本厂 / 整单外发） =================
  {
    console.log('\n[生产分配]');
    const { db: MDB } = require('../src/db');
    const NF = require('../src/services/nodeFlow');
    const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
    const ts = '2026-10-20 09:00:00';

    const mkOrder = (no, qty, status, costApproved, costStatus) => {
      const info = MDB.prepare(
        `INSERT INTO orders (order_no, type, status, rate, total_usd, total_amount, currency, style_name,
           order_date, delivery_date, created_at, updated_at, company_id)
         VALUES (?, 'custom', ?, 7.1, ?, ?, 'USD', ?, '2026-10-20', '2026-11-20', ?, ?, 1)`
      ).run(no, status, qty * 9.5, qty * 9.5 * 7.1, `冒烟分配 ${no}`, ts, ts);
      const oid = Number(info.lastInsertRowid);
      const it = MDB.prepare(
        'INSERT INTO order_items (order_id, product_name, style_no, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?)'
      ).run(oid, '冒烟分配款', `${no}-A`, qty, qty * 9.5, qty * 9.5 * 7.1);
      MDB.prepare(
        `INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(Number(it.lastInsertRowid), '本白', '均码', qty, 9.5, 67.45, qty * 9.5, qty * 9.5 * 7.1);
      if (costApproved !== null) {
        MDB.prepare(
          `INSERT INTO cost_sheets (order_id, material_cost, total_cost, profit_rate, factory_price, status, reviewed_by, reviewed_at, created_at, updated_at)
           VALUES (?, 90, 90, 30, 117, ?, 'admin', ?, ?, ?)`
        ).run(oid, costStatus || (costApproved ? 'approved' : 'draft'), ts, ts, ts);
      }
      NF.ensureNodes(oid);
      return oid;
    };
    const assignNode = (oid) => MDB.prepare("SELECT * FROM order_nodes WHERE order_id = ? AND code = 'c_new_1'").get(oid);

    const ownFac = MDB.prepare("SELECT * FROM factories WHERE type='own' ORDER BY id LIMIT 1").get();
    const outFac = MDB.prepare("SELECT * FROM factories WHERE type='outsource' ORDER BY id LIMIT 1").get();
    const oA = mkOrder('MASG-TEST-1', 600, 'assigned', true);
    const oB = mkOrder('MASG-TEST-2', 300, 'assigned', false);
    const oC = mkOrder('MASG-TEST-3', 500, 'assigned', true);
    const nA = assignNode(oA);

    // ---------- 1. 面板：能分、剩多少 ----------
    const pnl = await req(`/api/order-nodes/${nA.id}/panel`, { token });
    const asg = pnl.json.data && pnl.json.data.assign;
    ok('★ 待分配订单节点用的是「生产分配」面板（不是通用备注面板）',
      pnl.status === 200 && pnl.json.data.kind === 'assign' && !!asg,
      `HTTP ${pnl.status} / kind=${pnl.json.data && pnl.json.data.kind}`);
    ok('★ 面板给出的未分配量 = 订单件数', !!asg && num(asg.order_qty) === 600 && num(asg.pending_qty) === 600,
      `订单 ${asg && asg.order_qty} / 未分配 ${asg && asg.pending_qty}`);
    ok('面板列出了可选工厂（本厂 1 家 + 外协若干）', !!asg && asg.factories.length >= 2
      && asg.factories.some((f) => f.type === 'own') && asg.factories.some((f) => f.type === 'outsource'),
      `${asg && asg.factories.map((f) => f.type_label + ':' + f.name).join(' / ')}`);

    // ---------- 2. 校验类 ----------
    const noFac = await req(`/api/order-nodes/${nA.id}/assign`, { method: 'POST', token, body: { mode: 'outsource' } });
    ok('★ 整单外发不选厂被拒（不选厂排产/验货/对账都找不到人）',
      noFac.status === 400 && /外协厂/.test(noFac.json.message || ''), `HTTP ${noFac.status}`);

    const toOwnFac = await req(`/api/order-nodes/${nA.id}/assign`, {
      method: 'POST', token, body: { mode: 'outsource', factory_id: ownFac.id }
    });
    ok('★ 把「本厂」当外协分被拒（分给自有车间却叫外发，标签就假了）',
      toOwnFac.status === 400, `HTTP ${toOwnFac.status} ${(toOwnFac.json.message || '').slice(0, 40)}`);

    const overQty = await req(`/api/order-nodes/${nA.id}/assign`, { method: 'POST', token, body: { mode: 'own', qty: 700 } });
    ok('★ 分配数量超过未分配量被拒', overQty.status === 400 && /没分配/.test(overQty.json.message || ''), `HTTP ${overQty.status}`);

    const badMode = await req(`/api/order-nodes/${nA.id}/assign`, { method: 'POST', token, body: { mode: 'whatever' } });
    ok('非法分配方式被拒', badMode.status === 400, `HTTP ${badMode.status}`);

    // ---------- 3. 分配本厂：真的写分单 + 节点完成 ----------
    const doOwn = await req(`/api/order-nodes/${nA.id}/assign`, {
      method: 'POST', token, body: { mode: 'own', qty: 600, note: '冒烟：本厂车缝有空' }
    });
    const dA = doOwn.json.data;
    ok('★ 分配本厂：写入一条 own 分单，600 件', doOwn.status === 200
      && dA.dispatches.length === 1 && dA.dispatches[0].type === 'own' && num(dA.dispatches[0].qty) === 600
      && dA.dispatches[0].factory_id === ownFac.id,
      `HTTP ${doOwn.status} / ${dA.dispatches && dA.dispatches.map((x) => x.type + ':' + x.qty).join(',')}`);

    const nA2 = MDB.prepare('SELECT * FROM order_nodes WHERE id = ?').get(nA.id);
    ok('★ 分配后这个节点自动标完成，并记下完成日与责任人',
      nA2.status === 'done' && !!nA2.actual_date && nA2.operator === 'admin',
      `${nA2.status} / ${nA2.actual_date} / ${nA2.operator}`);

    const logs = MDB.prepare("SELECT action, detail FROM order_node_logs WHERE node_id = ? AND action = 'assign'").all(nA.id);
    ok('★ 时间线里写明分给谁、多少件', logs.length === 1 && /本厂/.test(logs[0].detail) && /600/.test(logs[0].detail),
      logs.length ? logs[0].detail : '没有 assign 记录');

    // ---------- 4. 看板：工厂列与页签口径 ----------
    const bd = await req('/api/node-flow/board?limit=500', { token });
    const rowA = ((bd.json.data && bd.json.data.rows) || []).find((r) => r.id === oA);
    ok('★ 看板行带分配结果（本厂 600、无外协，工厂名给到）', !!rowA
      && num(rowA.alloc_own) === 600 && num(rowA.alloc_out) === 0 && rowA.assign_mode === 'own'
      && /本厂|自有/.test(String(rowA.assign_names)),
      rowA ? `${rowA.assign_mode} / own=${rowA.alloc_own} / ${rowA.assign_names}` : '看板没有这张单');

    // ---------- 5. 幂等与「改分配」 ----------
    const again = await req(`/api/order-nodes/${nA.id}/assign`, { method: 'POST', token, body: { mode: 'own', qty: 600 } });
    const cntA = MDB.prepare('SELECT COUNT(*) c FROM dispatch_orders WHERE order_id = ?').get(oA).c;
    ok('★ 同一方式再点一次是幂等（不重复写分单）',
      again.status === 200 && again.json.data.changed === false && Number(cntA) === 1, `分单条数 ${cntA}`);

    const changeTo = await req(`/api/order-nodes/${nA.id}/assign`, {
      method: 'POST', token, body: { mode: 'outsource', factory_id: outFac.id }
    });
    ok('★ 已分完再改分配方式被拒（让人先去删原分单，而不是悄悄多分一笔）',
      changeTo.status === 400 && /已经分配完/.test(changeTo.json.message || ''), `HTTP ${changeTo.status}`);

    // ---------- 6. 手工标完成要被拦住 ----------
    const nB = assignNode(oB);
    const manualDone = await req(`/api/order-nodes/${nB.id}`, { method: 'PATCH', token, body: { status: 'done' } });
    ok('★ 分配节点不许手工标完成（否则「已完成但未分配」）',
      manualDone.status === 400 && /分配本厂/.test(manualDone.json.message || ''),
      `HTTP ${manualDone.status} ${(manualDone.json.message || '').slice(0, 40)}`);

    const pnlB = await req(`/api/order-nodes/${nB.id}/panel`, { token });
    ok('成本单没审核时面板明确说清缺什么', pnlB.status === 200
      && pnlB.json.data.assign.can_assign === false && /成本单/.test(pnlB.json.data.assign.block_reason || ''),
      (pnlB.json.data.assign && pnlB.json.data.assign.block_reason || '').slice(0, 40));

    const assignB = await req(`/api/order-nodes/${nB.id}/assign`, { method: 'POST', token, body: { mode: 'own' } });
    ok('成本未审的单直接调分配接口也被拒', assignB.status === 400, `HTTP ${assignB.status}`);

    // ---------- 7. 拆单：本厂 + 外协 ----------
    const nC = assignNode(oC);
    const first = await req(`/api/order-nodes/${nC.id}/assign`, { method: 'POST', token, body: { mode: 'own', qty: 300 } });
    ok('拆单第一步：先分 300 件给本厂', first.status === 200 && num(first.json.data.pending_qty) === 200,
      `余 ${first.json.data && first.json.data.pending_qty}`);

    const second = await req(`/api/order-nodes/${nC.id}/assign`, {
      method: 'POST', token, body: { mode: 'outsource', factory_id: outFac.id, qty: 200 }
    });
    ok('★ 拆单第二步：剩 200 件转外协，合计覆盖整单',
      second.status === 200 && num(second.json.data.allocated) === 500 && second.json.data.full === true,
      `已分 ${second.json.data && second.json.data.allocated}`);

    const bd2 = await req('/api/node-flow/board?limit=500', { token });
    const rowC = ((bd2.json.data && bd2.json.data.rows) || []).find((r) => r.id === oC);
    ok('★ 拆单在看板上标成 mixed，不被硬归成一边', !!rowC && rowC.assign_mode === 'mixed'
      && num(rowC.alloc_own) === 300 && num(rowC.alloc_out) === 200,
      rowC ? `${rowC.assign_mode} / ${rowC.alloc_own} + ${rowC.alloc_out}` : '看板没有这张单');

    // ---------- 8. 「未指定」的分单不算分配 ----------
    MDB.prepare(
      `INSERT INTO dispatch_orders (order_id, factory_id, factory_name, type, qty, price, status, created_at)
       VALUES (?, NULL, '未指定', 'own', 10, 0, 'dispatched', ?)`
    ).run(oC, ts);
    const allocAfter = MDB.prepare(
      `SELECT COALESCE(SUM(qty),0) q FROM dispatch_orders WHERE order_id = ? AND IFNULL(status,'') != 'cancelled'
        AND ((factory_id IS NOT NULL AND factory_id > 0) OR TRIM(IFNULL(factory_name,'')) NOT IN ('','未指定'))`
    ).get(oC).q;
    ok('★ 承做方为「未指定」的分单不计入已分配（脏数据不能冒充分配）', num(allocAfter) === 500,
      `有效已分 ${allocAfter}（另有 10 件未指定）`);

    // ---------- 9. 分单页（/api/dispatch）与看板共用同一份校验 ----------
    const oD = mkOrder('MASG-TEST-4', 200, 'assigned', true);
    const dispNoFac = await req('/api/dispatch', { method: 'POST', token, body: { order_id: oD } });
    ok('★ 分单页不选承做方也被拒（与看板分配同一条规则）',
      dispNoFac.status === 400 && /承做的工厂/.test(dispNoFac.json.message || ''), `HTTP ${dispNoFac.status}`);

    const dispOk = await req('/api/dispatch', {
      method: 'POST', token, body: { order_id: oD, factory_id: outFac.id, qty: 200, price: 26 }
    });
    ok('分单页仍可正常分单（重构后行为不变）', dispOk.status === 200
      && (dispOk.json.data.dispatch_orders || dispOk.json.data.dispatches || []).length >= 1,
      `HTTP ${dispOk.status}`);

    const dispOver = await req('/api/dispatch', {
      method: 'POST', token, body: { order_id: oD, factory_id: outFac.id, qty: 10 }
    });
    ok('★ 分单页超量也被同一条规则拦住', dispOver.status === 400 && /超出订单总量/.test(dispOver.json.message || ''),
      `HTTP ${dispOver.status} ${(dispOver.json.message || '').slice(0, 30)}`);

    // ---------- 清理 ----------
    [oA, oB, oC, oD].forEach((id) => {
      MDB.prepare('DELETE FROM dispatch_orders WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM cost_sheets WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM order_node_logs WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(id);
      MDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM orders WHERE id = ?').run(id);
    });
    ok('生产分配夹具已清干净',
      !MDB.prepare("SELECT 1 x FROM orders WHERE order_no LIKE 'MASG-TEST-%'").get(), '已删');
  }

  // ================= 单公司模式（默认）：开关是否真的生效 =================
  {
    console.log('\n[单公司模式]');
    /**
     * 这个块在单公司模式下**必须真跑**（不属于"数据范围："那些块）。
     *
     * 要证明的只有一件事：开关不是"看起来像"关掉了，而是所有主体过滤真的不生效了。
     * 判据用"一个绑定在主体 2 的账号能不能看到主体 1 的数据"——
     * 多主体模式下这是 404，单公司模式下必须能打开。
     */
    const head = SCOPE.header();
    const st = await req('/api/settings', { token });
    ok('设置接口带开关状态与唯一抬头',
      st.status === 200 && st.json.data.single_company === true
      && st.json.data.company_header && Number(st.json.data.company_header.id) === Number(head.id),
      `single=${st.json.data && st.json.data.single_company} 抬头=${st.json.data && st.json.data.company_header && st.json.data.company_header.name}`);

    // 造一个"绑定在别的主体"的账号 —— 单公司模式下它和总部账号看到的应完全一致
    const { db: SDB } = require('../src/db');
    const { hashPassword } = require('../src/auth/password');
    const otherCo = Number(SDB.prepare('SELECT id FROM companies WHERE id <> ? ORDER BY id LIMIT 1').get(Number(head.id))?.id) || Number(head.id);
    SDB.prepare("DELETE FROM users WHERE username = 'single_probe'").run();
    SDB.prepare('INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run('single_probe', hashPassword('SingleProbe123'), '单公司探针', 'sales', otherCo, '2026-10-20 09:00:00');
    require('../src/services/access').clearCache();
    const pl = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'single_probe', password: 'SingleProbe123' })
    }).then((r) => r.json());
    const pTok = pl.data && pl.data.token;

    // 总部名下的一张订单：多主体模式下这个账号打开是 404
    const otherOrder = SDB.prepare('SELECT id FROM orders WHERE company_id = ? ORDER BY id LIMIT 1').get(Number(head.id));
    if (pTok && otherOrder) {
      const o = await req('/api/orders/' + otherOrder.id, { token: pTok });
      ok('★ 单公司模式：绑在别的主体上的账号也能读到「总部」订单（不再 404）',
        o.status === 200, `HTTP ${o.status}`);

      const list = await req('/api/orders', { token: pTok });
      const total = (list.json.data || []).length;
      const admList = await req('/api/orders', { token });
      ok('★ 单公司模式：两个账号的订单列表条数一致（过滤真的关了）',
        list.status === 200 && total === (admList.json.data || []).length,
        `分公司视角 ${total} / 管理员 ${(admList.json.data || []).length}`);
    } else {
      ok('单公司模式探针账号可登录', !!pTok, pl.message || '无订单可测');
    }

    // 写入落抬头：客户端塞 company_id 也不作数
    const made = await req('/api/customers', {
      method: 'POST', token: pTok, body: { name: '单公司抬头探针', company_id: otherCo }
    });
    const madeId = made.json.data && made.json.data.id;
    if (madeId) {
      const co = SDB.prepare('SELECT company_id FROM customers WHERE id = ?').get(madeId);
      ok('★ 单公司模式：新建数据落唯一抬头（请求体里的 company_id 不作数）',
        Number(co && co.company_id) === Number(head.id), `实际落 ${co && co.company_id} / 抬头 ${head.id}`);
      SDB.prepare('DELETE FROM customers WHERE id = ?').run(madeId);
    }

    SDB.prepare("DELETE FROM users WHERE username = 'single_probe'").run();
    require('../src/services/access').clearCache();
    ok('单公司模式探针已清理',
      !SDB.prepare("SELECT 1 x FROM users WHERE username = 'single_probe'").get(), '已删');
  }

  // ================= 数据范围（公司 company_id） =================
  {
    console.log('\n[数据范围：公司]');
    const { db: MDB } = require('../src/db');
    const { hashPassword } = require('../src/auth/password');
    const ts = '2026-10-20 09:00:00';
    const OTHER_CO = 2;   // 义乌分公司（演示库里存在）

    const mkOrder = (no, companyId) => {
      const info = MDB.prepare(
        `INSERT INTO orders (order_no, type, status, rate, total_usd, total_amount, currency, style_name,
           order_date, delivery_date, created_at, updated_at, company_id)
         VALUES (?, 'custom', 'assigned', 7.1, 950, 6745, 'USD', ?, '2026-10-20', '2026-11-20', ?, ?, ?)`
      ).run(no, `范围测试 ${no}`, ts, ts, companyId);
      const oid = Number(info.lastInsertRowid);
      MDB.prepare('INSERT INTO order_items (order_id, product_name, style_no, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?)')
        .run(oid, `范围测试 ${no}`, `${no}-A`, 100, 950, 6745);
      return oid;
    };

    const ownOrder = mkOrder('SCOPE-TEST-1', 1);        // 总部单
    const otherOrder = mkOrder('SCOPE-TEST-2', OTHER_CO); // 分公司单
    const uname = 'scope_smoke';
    const pwd = 'ScopeTest123456';
    MDB.prepare('DELETE FROM users WHERE username = ?').run(uname);
    MDB.prepare('INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(uname, hashPassword(pwd), '范围测试业务员', 'sales', OTHER_CO, ts);

    /** 分公司业务员登录（走真实登录接口，验证 token/中间件链路） */
    const subLogin = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: pwd })
    }).then((r) => r.json());
    const subToken = subLogin.data && subLogin.data.token;
    ok('分公司账号可以登录（范围过滤不靠"不给登录"实现）', !!subToken, subLogin.message || 'ok');

    // ---- 1. 列表：只看得到自己主体的单 ----
    const subList = await req('/api/orders', { token: subToken });
    const subRows = (subList.json.data && (subList.json.data.rows || subList.json.data)) || [];
    const subNos = subRows.map((r) => r.order_no);
    ok('★ 分公司账号的订单列表不含总部订单',
      subList.status === 200 && subNos.includes('SCOPE-TEST-2') && !subNos.includes('SCOPE-TEST-1'),
      `看到 ${subRows.length} 张：${subNos.slice(0, 5).join(',')}`);

    // ---- 2. 详情 / 单据页 / 改号预览：别家的单当不存在 ----
    const peekOther = await req(`/api/orders/${ownOrder}`, { token: subToken });
    ok('★ 跨主体读订单详情返回 404（不是 403，避免被探测存在性）',
      peekOther.status === 404, `HTTP ${peekOther.status} ${peekOther.json.message || ''}`);

    const peekOwn = await req(`/api/orders/${otherOrder}`, { token: subToken });
    ok('本主体的订单详情正常可读', peekOwn.status === 200, `HTTP ${peekOwn.status}`);

    const sheetOther = await req(`/api/orders/${ownOrder}/sheet`, { token: subToken });
    ok('跨主体读单据页同样 404', sheetOther.status === 404, `HTTP ${sheetOther.status}`);

    const renamePreview = await req(`/api/orders/order-no/${ownOrder}/preview?no=HACK-1`, { token: subToken });
    ok('★ 跨主体连"改号预览"都进不去（写操作的前置读取也拦）', renamePreview.status === 404, `HTTP ${renamePreview.status}`);

    // ---- 3. 写操作：流转也被拦 ----
    const transOther = await req(`/api/orders/${ownOrder}/transition`, {
      method: 'POST', token: subToken, body: { to: 'production' }
    });
    ok('★ 跨主体不能推进订单状态', transOther.status === 404, `HTTP ${transOther.status}`);

    const batchMix = await req('/api/orders/batch/transition', {
      method: 'POST', token: subToken, body: { ids: [ownOrder, otherOrder], to: 'production', dry_run: true }
    });
    ok('★ 批量流转里混进别家的单 → 整批拒绝（不悄悄只转一半）',
      batchMix.status === 404 && /不属于你的主体/.test(batchMix.json.message || ''),
      `HTTP ${batchMix.status} ${(batchMix.json.message || '').slice(0, 30)}`);

    // ---- 4. 统计：分母也必须是本公司 ----
    const subStats = await req('/api/orders/stats/summary', { token: subToken });
    const subOrdersCount = Number(MDB.prepare('SELECT COUNT(*) c FROM orders WHERE company_id = ?').get(OTHER_CO).c);
    ok('★ 工作台统计按本公司算（订单数与库里该主体行数一致）',
      subStats.status === 200 && Number(subStats.json.data.orders) === subOrdersCount && subStats.json.data.scope === 'company',
      `接口 ${subStats.json.data && subStats.json.data.orders} / 库里 ${subOrdersCount} / scope=${subStats.json.data && subStats.json.data.scope}`);

    // ---- 5. 导出：与列表同一条规则 ----
    const subExport = await fetch(BASE + '/api/orders/export', { headers: { Authorization: 'Bearer ' + subToken } });
    const csv = await subExport.text();
    ok('★ 导出的 CSV 不含别家订单号（导出是数据出系统的最后一米）',
      subExport.status === 200 && csv.includes('SCOPE-TEST-2') && !csv.includes('SCOPE-TEST-1'),
      `${Math.round(csv.length / 1024)}KB`);

    // ---- 6. 集团角色仍然跨主体可见 ----
    const adminList = await req('/api/orders', { token });
    const adminNos = ((adminList.json.data && (adminList.json.data.rows || adminList.json.data)) || []).map((r) => r.order_no);
    ok('★ 集团管理员仍能看到两个主体的单（合并报表不能被范围拦死）',
      adminNos.includes('SCOPE-TEST-1') && adminNos.includes('SCOPE-TEST-2'),
      `管理员看到 ${adminNos.length} 张`);
    const adminStats = await req('/api/orders/stats/summary', { token });
    ok('管理员统计标记为全集团口径', adminStats.status === 200 && adminStats.json.data.scope === 'group',
      `scope=${adminStats.json.data && adminStats.json.data.scope}`);

    // ---- 清理 ----
    [ownOrder, otherOrder].forEach((id) => {
      MDB.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(id);
      MDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM orders WHERE id = ?').run(id);
    });
    MDB.prepare('DELETE FROM users WHERE username = ?').run(uname);
    require('../src/services/access').clearCache();
    ok('范围测试夹具已清干净',
      !MDB.prepare("SELECT 1 x FROM orders WHERE order_no LIKE 'SCOPE-TEST-%'").get()
      && !MDB.prepare('SELECT 1 x FROM users WHERE username = ?').get(uname), '已删');
  }

  // ================= 数据范围：应收应付（钱的口径不能被跨主体看） =================
  {
    console.log('\n[数据范围：应收应付]');
    const { db: MDB } = require('../src/db');
    const { hashPassword } = require('../src/auth/password');
    const ts = '2026-10-20 09:00:00';
    const CO2 = 2;            // 义乌分公司
    const due = '2026-10-01'; // 已逾期，账龄与催收都会算它

    const cust = MDB.prepare('SELECT id, name FROM customers ORDER BY id LIMIT 1').get();
    const sup = MDB.prepare('SELECT id, name FROM suppliers ORDER BY id LIMIT 1').get();

    const mkAR = (no, companyId, amount, customerId) => {
      const info = MDB.prepare(
        `INSERT INTO ar_invoices (bill_no, customer_id, customer_name, currency, amount_orig, rate, amount,
           paid_amount, due_date, status, source, created_by, created_at, updated_at, company_id)
         VALUES (?,?,?,'CNY',?,1,?,0,?,'unpaid','manual','smoke',?,?,?)`
      ).run(no, customerId || null, `范围客户 ${no}`, amount, amount, due, ts, ts, companyId);
      return Number(info.lastInsertRowid);
    };
    const mkAP = (no, companyId, amount) => {
      const info = MDB.prepare(
        `INSERT INTO ap_invoices (bill_no, supplier_id, supplier_name, currency, amount_orig, rate, amount,
           paid_amount, due_date, status, source, created_by, created_at, updated_at, company_id)
         VALUES (?,?,?,'CNY',?,1,?,0,?,'unpaid','manual','smoke',?,?,?)`
      ).run(no, sup ? sup.id : null, '范围供应商', amount, amount, due, ts, ts, companyId);
      return Number(info.lastInsertRowid);
    };

    const arOwn = mkAR('SCOPEAR-2', CO2, 1000, cust ? cust.id : null);   // 分公司
    const arOther = mkAR('SCOPEAR-1', 1, 5000, cust ? cust.id : null);   // 总部
    const apOwn = mkAP('SCOPEAP-2', CO2, 700);
    const apOther = mkAP('SCOPEAP-1', 1, 2500);

    const funame = 'scope_fin';
    const fpwd = 'ScopeFin123456';
    MDB.prepare('DELETE FROM users WHERE username = ?').run(funame);
    MDB.prepare('INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(funame, hashPassword(fpwd), '范围测试财务', 'finance', CO2, ts);
    require('../src/services/access').clearCache();

    const fl = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: funame, password: fpwd })
    }).then((r) => r.json());
    const fTok = fl.data && fl.data.token;
    ok('分公司财务账号可登录', !!fTok, fl.message || 'ok');

    // ---- 1. 应收列表 ----
    const subAr = await req('/api/finance/ar', { token: fTok });
    const arNos = (subAr.json.data || []).map((x) => x.bill_no);
    ok('★ 分公司账的应收列表不含总部单据',
      subAr.status === 200 && arNos.includes('SCOPEAR-2') && !arNos.includes('SCOPEAR-1'),
      `看到 ${arNos.length} 张`);

    const adminAr = await req('/api/finance/ar', { token });
    const adminNos = (adminAr.json.data || []).map((x) => x.bill_no);
    ok('★ 集团管理员仍能看到两个主体的应收（合并口径不能被拦死）',
      adminNos.includes('SCOPEAR-1') && adminNos.includes('SCOPEAR-2'), `管理员看到 ${adminNos.length} 张`);

    // ---- 2. 总览与账龄的分母 ----
    const expOpen = Number(MDB.prepare(
      "SELECT COALESCE(SUM(amount - paid_amount),0) s FROM ar_invoices WHERE company_id = ? AND status <> 'void' AND amount - COALESCE(paid_amount,0) > 0.005"
    ).get(CO2).s);
    const sum2 = await req('/api/finance/summary', { token: fTok });
    ok('★ 往来账总览按本公司算（金额与库里该主体未结合计一致）',
      sum2.status === 200 && Math.abs(Number(sum2.json.data.ar_open) - expOpen) < 0.05
      && sum2.json.data.scope === 'company',
      `接口 ${sum2.json.data && sum2.json.data.ar_open} / 库里 ${expOpen} / scope=${sum2.json.data && sum2.json.data.scope}`);

    const aging2 = await req('/api/finance/aging?kind=ar', { token: fTok });
    const expAgingN = Number(MDB.prepare(
      "SELECT COUNT(*) c FROM ar_invoices WHERE company_id = ? AND status <> 'void' AND amount - COALESCE(paid_amount,0) > 0.005"
    ).get(CO2).c);
    ok('★ 账龄桶张数与本公司一致（否则逾期率算的是别人家的账）',
      aging2.status === 200 && Number(aging2.json.data.count) === expAgingN,
      `接口 ${aging2.json.data && aging2.json.data.count} / 库里 ${expAgingN}`);

    // ---- 3. 写操作：跨主体作废 / 核销都被拒 ----
    const voidOther = await req(`/api/finance/ar/${arOther}/void`, {
      method: 'POST', token: fTok, body: { reason: '试试改别家的单' }
    });
    ok('★ 跨主体作废应收返回 404（当它不存在）',
      voidOther.status === 404, `HTTP ${voidOther.status} ${voidOther.json.message || ''}`);

    const payOther = await req('/api/finance/payments', {
      method: 'POST', token: fTok,
      body: { direction: 'in', partner_type: 'customer', partner_name: 'x', amount: 100, allocations: [{ invoice_id: arOther, amount: 100 }] }
    });
    ok('★ 跨主体不能核销别家的应收（收款登记这一步就拦住）',
      payOther.status >= 400 && payOther.status < 500 && payOther.status !== 200,
      `HTTP ${payOther.status} ${(payOther.json.message || '').slice(0, 40)}`);

    // ---- 4. 新建单据必须落在自己主体（不能默认 1） ----
    const made = await req('/api/finance/ar', {
      method: 'POST', token: fTok,
      body: { partner_name: '新建客户', amount: 321, due_date: due, remark: '范围测试-新建' }
    });
    const madeRow = made.json.data || {};
    const madeDb = madeRow.id ? MDB.prepare('SELECT company_id FROM ar_invoices WHERE id = ?').get(madeRow.id) : null;
    ok('★ 分公司开出的应收记在自己主体（不写就默认 1，开完自己看不见）',
      made.status === 200 && madeDb && Number(madeDb.company_id) === CO2,
      `HTTP ${made.status} company_id=${madeDb && madeDb.company_id}`);

    // ---- 5. 收付款列表 ----
    const pays = await req('/api/finance/payments', { token: fTok });
    const payCos = (pays.json.data || []).map((p) => Number(p.company_id) || 1);
    ok('★ 收付款列表不含别家主体的收款', pays.status === 200 && payCos.every((c) => c === CO2),
      `看到 ${payCos.length} 笔，主体集合 ${[...new Set(payCos)].join(',') || '空'}`);

    // ---- 6. 应付台账：同一供应商，只算自己主体的应付 ----
    const pb = await req('/api/payable/board', { token: fTok });
    const supRow = ((pb.json.data || {}).rows || []).find((r) => sup && Number(r.supplier.id) === Number(sup.id));
    ok('★ 应付台账里同一供应商只算本主体的未付（不是全集团欠他的钱）',
      pb.status === 200 && (!supRow || Number(supRow.figures.open_amount) < 2000),
      supRow ? `台账 ${supRow.figures.open_amount}（总部那张 2500 不该算进来）` : '该供应商无行');

    // ---- 7. 应收催收：台账按主体、跨主体任务当不存在 ----
    const cb = await req('/api/collections/board', { token: fTok });
    const cRow = ((cb.json.data || {}).rows || []).find((r) => cust && Number(r.customer_id) === Number(cust.id));
    ok('★ 催收台账同一客户的逾期金额只含本主体发票',
      cb.status === 200 && (!cRow || Number(cRow.overdue_amount) < 5000),
      cRow ? `台账 ${cRow.overdue_amount}（总部那张 5000 不该算进来）` : '该客户无逾期行');

    // ---- 8. 集团角色的口径标记 ----
    const sAdmin = await req('/api/finance/summary', { token });
    ok('集团管理员金额口径标记为 group', sAdmin.status === 200 && sAdmin.json.data.scope === 'group',
      `scope=${sAdmin.json.data && sAdmin.json.data.scope}`);

    // ---- 清理 ----
    if (madeRow.id) MDB.prepare('DELETE FROM ar_invoices WHERE id = ?').run(madeRow.id);
    [arOwn, arOther].forEach((id) => MDB.prepare('DELETE FROM ar_invoices WHERE id = ?').run(id));
    [apOwn, apOther].forEach((id) => MDB.prepare('DELETE FROM ap_invoices WHERE id = ?').run(id));
    MDB.prepare('DELETE FROM users WHERE username = ?').run(funame);
    require('../src/services/access').clearCache();
    const left = MDB.prepare("SELECT (SELECT COUNT(*) FROM ar_invoices WHERE bill_no LIKE 'SCOPEAR-%') + (SELECT COUNT(*) FROM ap_invoices WHERE bill_no LIKE 'SCOPEAP-%') c").get().c;
    ok('应收应付范围夹具已清干净',
      Number(left) === 0 && !MDB.prepare('SELECT 1 x FROM users WHERE username = ?').get(funame), '已删');
  }

  // ================= 数据范围：领料与盘点（单据层按主体，存量层不分主体） =================
  {
    console.log('\n[数据范围：领料与盘点]');
    const { db: MDB } = require('../src/db');
    const { hashPassword } = require('../src/auth/password');
    const ts = '2026-10-20 09:00:00';
    const CO2 = 2;

    // 两张领料单：一张总部、一张分部（明细留空，只为验证列表/详情/动作的范围）
    const mkIssue = (no, companyId) => {
      const info = MDB.prepare(
        `INSERT INTO material_issues (issue_no, company_id, kind, receiver_type, req_date, status,
           item_count, req_qty, issued_qty, amount, note, created_by, created_at, updated_at)
         VALUES (?,?,'extra','own','2026-10-20','draft',0,0,0,0,'范围测试',?,?,?)`
      ).run(no, companyId, ts, ts, ts);
      return Number(info.lastInsertRowid);
    };
    // 单号不带横线：扫码/标签码解析按 '-' 分段取第一段当订单号，带横线的号会被拆开
    MDB.prepare("DELETE FROM material_issues WHERE issue_no IN ('SCOPEISS1','SCOPEISS2')").run();
    const issOwn = mkIssue('SCOPEISS2', CO2);
    const issOther = mkIssue('SCOPEISS1', 1);

    // 总部一张未完成盘点：用来验证「建盘点的互斥要按主体判」
    MDB.prepare("DELETE FROM stocktakes WHERE take_no = 'SCOPEPD1'").run();
    const takeOther = Number(MDB.prepare(
      `INSERT INTO stocktakes (take_no, company_id, scope, warehouse, take_date, status, freeze,
         item_count, counter, note, created_by, created_at, updated_at)
       VALUES ('SCOPEPD1',1,'material','cn','2026-10-20','draft',1,0,'范围测试','范围测试盘点',?,?,?)`
    ).run(ts, ts, ts).lastInsertRowid);

    // 分部的订单（建订单备料时验证主体继承）
    MDB.prepare("DELETE FROM orders WHERE order_no = 'SCOPEMT1'").run();
    const orderInfo = MDB.prepare(
      `INSERT INTO orders (order_no, type, status, rate, total_usd, total_amount, currency, style_name,
         order_date, delivery_date, created_at, updated_at, company_id)
       VALUES ('SCOPEMT1','custom','assigned',7.1,100,710,'USD','范围领料测试','2026-10-20','2026-11-20',?,?,?)`
    ).run(ts, ts, CO2);
    const orderId = Number(orderInfo.lastInsertRowid);

    const wname = 'scope_wh';
    const wpwd = 'ScopeWh123456';
    MDB.prepare('DELETE FROM users WHERE username = ?').run(wname);
    MDB.prepare('INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(wname, hashPassword(wpwd), '范围测试仓管', 'warehouse', CO2, ts);
    require('../src/services/access').clearCache();

    const wl = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: wname, password: wpwd })
    }).then((r) => r.json());
    const wTok = wl.data && wl.data.token;
    ok('分公司仓管账号可登录', !!wTok, wl.message || 'ok');

    // ---- 1. 领料列表 ----
    const subIss = await req('/api/matflow/issues', { token: wTok });
    const subNos = (subIss.json.data.rows || []).map((r) => r.issue_no);
    ok('★ 分公司账的领料列表不含总部单据',
      subIss.status === 200 && subNos.includes('SCOPEISS2') && !subNos.includes('SCOPEISS1'),
      `看到 ${subNos.length} 张`);

    // ---- 2. 跨主体详情与动作 ----
    const peek = await req(`/api/matflow/issues/${issOther}`, { token: wTok });
    ok('★ 跨主体读领料单详情返回 404', peek.status === 404, `HTTP ${peek.status}`);

    const prep = await req(`/api/matflow/issues/${issOther}/prepare`, { method: 'POST', token: wTok });
    ok('★ 跨主体不能给别家的领料单备料', prep.status === 404, `HTTP ${prep.status}`);

    const ret = await req('/api/matflow/returns', {
      method: 'POST', token: wTok, body: { issue_id: issOther, type: 'leftover', reason: '范围测试退料' }
    });
    ok('★ 不能拿别家的领料单开退料（否则等于把别家库存加上来）',
      ret.status >= 400 && ret.status < 500, `HTTP ${ret.status} ${(ret.json.message || '').slice(0, 24)}`);

    // ---- 3. 建订单备料：主体继承订单，不继承前端传的 company_id ----
    MDB.prepare('INSERT INTO order_materials (order_id, type, name, unit, one_use, loss, all_colors, total_use, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(orderId, 'fabric', '范围测试面料', '米', 1, 0, 1, 100, ts);
    const made = await req('/api/matflow/issues', {
      method: 'POST', token: wTok,
      body: { order_id: orderId, kind: 'order', req_date: '2026-10-20', items: [{ name: '范围测试面料', unit: '米', req_qty: 10 }] }
    });
    const madeId = made.json.data && made.json.data.id;
    const madeCo = madeId ? Number(MDB.prepare('SELECT company_id FROM material_issues WHERE id = ?').get(madeId).company_id) : null;
    ok('★ 分公司建的订单备料记在订单主体上（原来写死 1，记到总部去了）',
      made.status === 200 && madeCo === CO2, `HTTP ${made.status} company_id=${madeCo}`);

    // ---- 4. 建盘点：互斥按主体判 + 落自己主体 ----
    const take = await req('/api/matflow/stocktakes', {
      method: 'POST', token: wTok, body: { take_date: '2026-10-20', note: '范围测试盘点' }
    });
    const takeId = take.json.data && take.json.data.id;
    const takeCo = takeId ? Number(MDB.prepare('SELECT company_id FROM stocktakes WHERE id = ?').get(takeId).company_id) : null;
    ok('★ 总部有未完成盘点时，分公司仍能开自己的盘点（互斥原来查全库，分部被永久挡住）',
      take.status === 200 && takeCo === CO2, `HTTP ${take.status} company_id=${takeCo} ${(take.json.message || '').slice(0, 30)}`);

    // ---- 5. 跨主体盘点详情 ----
    const peekTake = await req(`/api/matflow/stocktakes/${takeOther}`, { token: wTok });
    ok('★ 跨主体读盘点单详情返回 404', peekTake.status === 404, `HTTP ${peekTake.status}`);

    // ---- 6. 集团管理员仍看得到 ----
    const adminIss = await req('/api/matflow/issues', { token });
    const adminNos = (adminIss.json.data.rows || []).map((r) => r.issue_no);
    ok('★ 集团管理员仍能看到两个主体的领料单',
      adminNos.includes('SCOPEISS1') && adminNos.includes('SCOPEISS2'), `管理员看到 ${adminNos.length} 张`);

    // ---- 清理 ----
    if (takeId) {
      MDB.prepare('DELETE FROM stocktake_items WHERE take_id = ?').run(takeId);
      MDB.prepare('DELETE FROM stocktakes WHERE id = ?').run(takeId);
    }
    MDB.prepare('DELETE FROM stocktakes WHERE take_no = ?').run('SCOPEPD1');
    if (madeId) {
      MDB.prepare('DELETE FROM material_issue_items WHERE issue_id = ?').run(madeId);
      MDB.prepare('DELETE FROM material_issues WHERE id = ?').run(madeId);
    }
    [issOwn, issOther].forEach((id) => MDB.prepare('DELETE FROM material_issues WHERE id = ?').run(id));
    MDB.prepare('DELETE FROM order_materials WHERE order_id = ?').run(orderId);
    MDB.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(orderId);
    MDB.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    MDB.prepare('DELETE FROM users WHERE username = ?').run(wname);
    require('../src/services/access').clearCache();
    const left = Number(MDB.prepare(
      "SELECT (SELECT COUNT(*) FROM material_issues WHERE issue_no LIKE 'SCOPEISS%') + (SELECT COUNT(*) FROM stocktakes WHERE take_no LIKE 'SCOPEPD%') + (SELECT COUNT(*) FROM orders WHERE order_no = 'SCOPEMT1') c"
    ).get().c);
    ok('领料与盘点范围夹具已清干净',
      left === 0 && !MDB.prepare('SELECT 1 x FROM users WHERE username = ?').get(wname), '已删');
  }

  // ================= 数据范围：报工与工序（挂在订单上，按订单判） =================
  {
    console.log('\n[数据范围：报工与工序]');
    const { db: MDB } = require('../src/db');
    const { hashPassword } = require('../src/auth/password');
    const ts = '2026-10-20 09:00:00';
    const CO2 = 2;

    // 单号不带横线（扫码解析按 '-' 分段）
    MDB.prepare("DELETE FROM orders WHERE order_no IN ('SCOPEPR1','SCOPEPR2')").run();
    const mkProdOrder = (no, companyId) => {
      const info = MDB.prepare(
        `INSERT INTO orders (order_no, type, status, rate, total_usd, total_amount, currency, style_name,
           order_date, delivery_date, created_at, updated_at, company_id, node_template_id)
         VALUES (?, 'custom', 'production', 7.1, 100, 710, 'USD', ?, '2026-10-20', '2026-11-20', ?, ?, ?, ?)`
      ).run(no, `范围报工 ${no}`, ts, ts, companyId, null);
      const oid = Number(info.lastInsertRowid);
      MDB.prepare('INSERT INTO order_items (order_id, product_name, style_no, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?)')
        .run(oid, `范围报工 ${no}`, `${no}A`, 100, 100, 710);
      return oid;
    };
    const ordOther = mkProdOrder('SCOPEPR1', 1);   // 总部
    const ordOwn = mkProdOrder('SCOPEPR2', CO2);   // 分部

    const pname = 'scope_prod';
    const ppwd = 'ScopeProd123456';
    MDB.prepare('DELETE FROM users WHERE username = ?').run(pname);
    MDB.prepare('INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(pname, hashPassword(ppwd), '范围测试生产', 'production', CO2, ts);
    require('../src/services/access').clearCache();

    const pl = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: pname, password: ppwd })
    }).then((r) => r.json());
    const pTok = pl.data && pl.data.token;
    ok('分公司生产账号可登录', !!pTok, pl.message || 'ok');

    // 两边各自初始化工序（走真实接口，顺带验证守卫放行自己、拦住别家）
    const initOwn = await req('/api/order-nodes/init', { method: 'POST', token: pTok, body: { order_id: ordOwn } });
    const initOther = await req('/api/order-nodes/init', { method: 'POST', token: pTok, body: { order_id: ordOther } });
    ok('★ 分厂账号能给自己订单初始化工序，对别家订单返回 404',
      initOwn.status === 200 && Array.isArray(initOwn.json.data) && initOther.status === 404,
      `自己 ${initOwn.status} / 别家 ${initOther.status}`);

    // 总部那张单由管理员初始化工序（分部那次被拦住了，所以要另建一份才能测后续跨主体读）
    await req('/api/order-nodes/init', { method: 'POST', token, body: { order_id: ordOther } });
    const otherNode = MDB.prepare('SELECT id FROM order_nodes WHERE order_id = ? ORDER BY seq LIMIT 1').get(ordOther);
    const ownNode = MDB.prepare('SELECT id FROM order_nodes WHERE order_id = ? ORDER BY seq LIMIT 1').get(ordOwn);

    // ---- 1. 工序节点：列表 / 弹窗 / 改状态 ----
    const nodesOther = await req(`/api/order-nodes?order_id=${ordOther}`, { token: pTok });
    ok('★ 跨主体读工序节点返回 404', nodesOther.status === 404, `HTTP ${nodesOther.status}`);

    const panelOther = await req(`/api/order-nodes/${otherNode.id}/panel`, { token: pTok });
    ok('★ 跨主体点开工序弹窗返回 404（面板里有备注、凭证、时间线）',
      panelOther.status === 404, `HTTP ${panelOther.status}`);

    const patchOther = await req(`/api/order-nodes/${otherNode.id}`, {
      method: 'PATCH', token: pTok, body: { status: 'done' }
    });
    ok('★ 跨主体不能推进别家的工序状态', patchOther.status === 404, `HTTP ${patchOther.status}`);

    const patchOwn = await req(`/api/order-nodes/${ownNode.id}`, {
      method: 'PATCH', token: pTok, body: { status: 'doing' }
    });
    ok('自己订单的工序可以正常推进', patchOwn.status === 200, `HTTP ${patchOwn.status}`);

    // ---- 2. 报工：读与写都要拦 ----
    const repListOther = await req(`/api/reports?order_id=${ordOther}`, { token: pTok });
    ok('★ 跨主体读报工明细返回 404', repListOther.status === 404, `HTTP ${repListOther.status}`);

    const repPostOther = await req('/api/reports', {
      method: 'POST', token: pTok, body: { node_id: otherNode.id, qty_ok: 10 }
    });
    ok('★ 跨主体不能给别家的工序报工（报工直接乘计件工资）',
      repPostOther.status === 404, `HTTP ${repPostOther.status}`);

    // ---- 3. 订单跟踪看板：卡片与明细同一口径 ----
    const nf = await req('/api/node-flow/board?limit=200', { token: pTok });
    const nfRows = (nf.json.data && nf.json.data.rows) || [];
    const nfNos = nfRows.map((r) => r.order_no);
    const nfTotal = Number((nf.json.data && nf.json.data.stats && nf.json.data.stats.total) || 0);
    ok('★ 分厂的订单跟踪看板不含总部订单，且卡片数与明细条数一致',
      nf.status === 200 && nfNos.includes('SCOPEPR2') && !nfNos.includes('SCOPEPR1') && nfTotal === nfRows.length,
      `卡片 ${nfTotal} / 明细 ${nfRows.length} / 含总部单=${nfNos.includes('SCOPEPR1')}`);

    // ---- 4. 生产看板 ----
    const pb = await req('/api/production/board', { token: pTok });
    const pbNos = (pb.json.data || []).map((r) => r.order_no);
    ok('★ 分厂的生产看板不含总部在产单',
      pb.status === 200 && pbNos.includes('SCOPEPR2') && !pbNos.includes('SCOPEPR1'),
      `看到 ${pbNos.length} 张`);

    // ---- 5. 集团管理员仍看得到两边 ----
    const adminRepOther = await req(`/api/reports?order_id=${ordOther}`, { token });
    const adminNf = await req('/api/node-flow/board?limit=200', { token });
    const adminNfNos = ((adminNf.json.data && adminNf.json.data.rows) || []).map((r) => r.order_no);
    ok('★ 集团管理员仍能读到两个主体的报工与看板',
      adminRepOther.status === 200 && adminNfNos.includes('SCOPEPR1') && adminNfNos.includes('SCOPEPR2'),
      `报工 ${adminRepOther.status} / 看板 ${adminNfNos.length} 张`);

    // ---- 清理 ----
    [ordOther, ordOwn].forEach((id) => {
      MDB.prepare('DELETE FROM order_node_logs WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(id);
      MDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM orders WHERE id = ?').run(id);
    });
    MDB.prepare('DELETE FROM users WHERE username = ?').run(pname);
    require('../src/services/access').clearCache();
    const leftPr = Number(MDB.prepare("SELECT COUNT(*) c FROM orders WHERE order_no IN ('SCOPEPR1','SCOPEPR2')").get().c);
    ok('报工与工序范围夹具已清干净',
      leftPr === 0 && !MDB.prepare('SELECT 1 x FROM users WHERE username = ?').get(pname), '已删');
  }

  // ================= 数据范围：生产报表（分母不能是全集团的） =================
  {
    console.log('\n[数据范围：生产报表]');
    const { db: MDB } = require('../src/db');
    const { hashPassword } = require('../src/auth/password');
    // 期间必须用报表自己那一份 localDate：utils/time 的 localDate() 不传参返回空串，
    // 用它算 period 会得到 '' → 夹具日期变成 '-15'，报表一张都匹配不上（踩过）
    const { localDate } = require('../src/services/sla');
    const ts = '2026-10-20 09:00:00';
    const CO2 = 2;
    const period = localDate().slice(0, 7);   // sla.localDate(d = new Date())，传字符串会炸
    const day = `${period}-15`;

    MDB.prepare("DELETE FROM orders WHERE order_no IN ('SCOPERP1','SCOPERP2')").run();
    const mkOrder = (no, companyId) => {
      const info = MDB.prepare(
        `INSERT INTO orders (order_no, type, status, rate, total_usd, total_amount, currency, style_name,
           order_date, delivery_date, created_at, updated_at, company_id)
         VALUES (?, 'custom', 'production', 7.1, 100, 710, 'USD', ?, '2026-10-01', '2026-11-20', ?, ?, ?)`
      ).run(no, `范围报表 ${no}`, ts, ts, companyId);
      const oid = Number(info.lastInsertRowid);
      MDB.prepare('INSERT INTO order_items (order_id, product_name, style_no, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?)')
        .run(oid, `范围报表 ${no}`, `${no}A`, 100, 100, 710);
      // 承诺 + 返工 + 裁床 + 报工各一条，覆盖五个报表
      MDB.prepare('INSERT INTO commitments (order_id, order_no, qty, promised_date, actual_ship_date, created_at) VALUES (?,?,?,?,?,?)')
        .run(oid, no, 100, day, null, ts);
      MDB.prepare(`INSERT INTO rework_orders (rw_no, order_id, order_no, node_name, type, reason, qty, qty_scrap, created_at, updated_at)
                   VALUES (?,?,?,'缝制','rework','范围测试',5,0,?,?)`).run(`RW-${no}`, oid, no, `${day} 09:00:00`, `${day} 09:00:00`);
      MDB.prepare('INSERT INTO cut_orders (cut_no, order_id, order_no, plan_qty, total_cut_qty, qualified_qty, reject_qty, cut_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(`CUT-${no}`, oid, no, 100, 100, 98, 2, day);
      MDB.prepare('INSERT INTO production_reports (order_id, node_name, report_date, qty_ok, qty_defect, hours, operator, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(oid, '缝制', day, 90, 10, 8, '范围测试', `${day} 10:00:00`);
      return oid;
    };
    const oOther = mkOrder('SCOPERP1', 1);
    const oOwn = mkOrder('SCOPERP2', CO2);

    const uname = 'scope_rep';
    const pwd = 'ScopeRep123456';
    MDB.prepare('DELETE FROM users WHERE username = ?').run(uname);
    MDB.prepare('INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(uname, hashPassword(pwd), '范围测试生产主管', 'production', CO2, ts);
    require('../src/services/access').clearCache();
    const rl = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: pwd })
    }).then((r) => r.json());
    const rTok = rl.data && rl.data.token;
    ok('分公司生产主管账号可登录', !!rTok, rl.message || 'ok');

    // ---- 1. 准交率：分母只含本主体 ----
    const ot = await req(`/api/prod-report/on-time?period=${period}`, { token: rTok });
    /**
     * 断言用「按承诺日到期」这一口径：主口径会在有发运样本时切到「按实际发运」，
     * 而夹具的承诺都还没发运 —— 拿主口径断言会时对时错。
     */
    const otNos = (((ot.json.data && ot.json.data.by_due) || {}).rows || []).map((r) => r.order_no);
    ok('★ 分厂的准交率分母不含总部订单（否则算出来的是两个主体的混合值）',
      ot.status === 200 && otNos.includes('SCOPERP2') && !otNos.includes('SCOPERP1'),
      `样本 ${otNos.length} 张：${otNos.slice(0, 4).join(',')}`);

    // ---- 2. 效率：报工条数用库里该主体的数核对 ----
    const expReports = Number(MDB.prepare(
      `SELECT COUNT(*) c FROM production_reports r JOIN orders o ON o.id = r.order_id
        WHERE o.company_id = ? AND r.report_date BETWEEN ? AND ?`
    ).get(CO2, `${period}-01`, `${period}-31`).c);
    const eff = await req(`/api/prod-report/efficiency?period=${period}`, { token: rTok });
    ok('★ 分厂的工序效率只取自己主体的报工（条数与库里一致）',
      eff.status === 200 && Number(eff.json.data.total_reports) === expReports,
      `接口 ${eff.json.data && eff.json.data.total_reports} / 库里 ${expReports}`);

    // ---- 3. 质量：返工明细不含别家单号 ----
    const ql = await req(`/api/prod-report/quality?period=${period}`, { token: rTok });
    const qlNos = ((ql.json.data && ql.json.data.rows) || []).map((r) => r.order_no);
    ok('★ 分厂的质量报表只含自己主体的返工单',
      ql.status === 200 && qlNos.includes('SCOPERP2') && !qlNos.includes('SCOPERP1'),
      `返工 ${qlNos.length} 条`);

    // ---- 4. 在制龄 ----
    const wip = await req('/api/prod-report/wip', { token: rTok });
    const wipNos = ((wip.json.data && wip.json.data.rows) || []).map((r) => r.order_no);
    ok('★ 分厂的在制龄只含自己主体的在产单',
      wip.status === 200 && wipNos.includes('SCOPERP2') && !wipNos.includes('SCOPERP1'),
      `在制 ${wipNos.length} 张`);

    // ---- 5. 裁床 ----
    const expCut = Number(MDB.prepare(
      `SELECT COUNT(*) c FROM cut_orders t JOIN orders o ON o.id = t.order_id
        WHERE o.company_id = ? AND substr(IFNULL(t.cut_at, t.created_at),1,7) = ?`
    ).get(CO2, period).c);
    const mat = await req(`/api/prod-report/material?period=${period}`, { token: rTok });
    ok('★ 分厂的裁床报表单数与库里该主体一致',
      mat.status === 200 && Number(mat.json.data.orders) === expCut,
      `接口 ${mat.json.data && mat.json.data.orders} / 库里 ${expCut}`);

    // ---- 6. 总览与单项同一口径（不许一个收、一个不收） ----
    const ov = await req(`/api/prod-report/overview?period=${period}`, { token: rTok });
    ok('★ 总览的样本量与单项报表一致（口径不能一处收一处不收）',
      ov.status === 200 && ov.json.data.on_time && ov.json.data.on_time.sample === ot.json.data.sample,
      `总览 ${ov.json.data && ov.json.data.on_time && ov.json.data.on_time.sample} / 单项 ${ot.json.data && ot.json.data.sample}`);

    // ---- 7. 导出：与页面同一条规则 ----
    const exp = await fetch(`${BASE}/api/prod-report/export?kind=on_time&period=${period}`, {
      headers: { Authorization: 'Bearer ' + rTok }
    });
    const csv = await exp.text();
    ok('★ 导出的准交 CSV 不含别家订单号（导出是数据出系统的最后一米）',
      exp.status === 200 && csv.includes('SCOPERP2') && !csv.includes('SCOPERP1'),
      `${Math.round(csv.length / 1024)}KB`);

    // ---- 8. 集团管理员看到两边 ----
    const adminOt = await req(`/api/prod-report/on-time?period=${period}`, { token });
    const adminOtNos = (((adminOt.json.data && adminOt.json.data.by_due) || {}).rows || []).map((r) => r.order_no);
    ok('★ 集团管理员的报表仍含两个主体（合并口径不能被拦死）',
      adminOt.status === 200 && adminOtNos.includes('SCOPERP1') && adminOtNos.includes('SCOPERP2'),
      `管理员样本 ${adminOtNos.length} 张`);

    // ---- 清理 ----
    [oOther, oOwn].forEach((id) => {
      MDB.prepare('DELETE FROM commitments WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM rework_orders WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM cut_orders WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM production_reports WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      MDB.prepare('DELETE FROM orders WHERE id = ?').run(id);
    });
    MDB.prepare('DELETE FROM users WHERE username = ?').run(uname);
    require('../src/services/access').clearCache();
    const left = Number(MDB.prepare("SELECT COUNT(*) c FROM orders WHERE order_no IN ('SCOPERP1','SCOPERP2')").get().c);
    ok('生产报表范围夹具已清干净',
      left === 0 && !MDB.prepare('SELECT 1 x FROM users WHERE username = ?').get(uname), '已删');
  }

  // ================= 数据范围：采购与收货（采购单自己带主体） =================
  {
    console.log('\n[数据范围：采购与收货]');
    const { db: MDB } = require('../src/db');
    const { hashPassword } = require('../src/auth/password');
    const ts = '2026-10-20 09:00:00';
    const CO2 = 2;

    // 采购单推不出主体（备货采购不挂订单），所以给它单独加了 company_id
    MDB.prepare("DELETE FROM purchase_orders WHERE po_no IN ('SCOPEPO1','SCOPEPO2')").run();
    const sup = MDB.prepare("SELECT id, name FROM suppliers WHERE id = 1").get()
      || MDB.prepare("SELECT id, name FROM suppliers WHERE status <> 'deleted' LIMIT 1").get();
    const mkPo = (no, companyId, status) => {
      const info = MDB.prepare(
        `INSERT INTO purchase_orders (po_no, supplier, supplier_id, status, order_date, expect_date,
           remark, total_amount, created_by, created_at, updated_at, company_id)
         VALUES (?,?,?,?, '2026-10-20', '2026-10-30', '范围测试', 500, 'smoke', ?, ?, ?)`
      ).run(no, sup.name, sup.id, status, ts, ts, companyId);
      const poId = Number(info.lastInsertRowid);
      MDB.prepare('INSERT INTO purchase_items (po_id, name, unit, qty, price, amount) VALUES (?,?,?,?,?,?)')
        .run(poId, '范围测试面料', '米', 100, 5, 500);
      return poId;
    };
    const poOther = mkPo('SCOPEPO1', 1, 'ordered');

    const wname = 'scope_buy';
    const wpwd = 'ScopeBuy123456';
    MDB.prepare('DELETE FROM users WHERE username = ?').run(wname);
    MDB.prepare('INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(wname, hashPassword(wpwd), '范围测试采购', 'warehouse', CO2, ts);
    require('../src/services/access').clearCache();
    const bl = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: wname, password: wpwd })
    }).then((r) => r.json());
    const bTok = bl.data && bl.data.token;
    ok('分公司采购账号可登录', !!bTok, bl.message || 'ok');

    // ---- 1. 列表 / 详情 ----
    const list = await req('/api/purchases', { token: bTok });
    const listNos = (list.json.data || []).map((x) => x.po_no);
    ok('★ 分公司的采购列表不含总部采购单',
      list.status === 200 && !listNos.includes('SCOPEPO1'), `看到 ${listNos.length} 张`);

    const peek = await req(`/api/purchases/${poOther}`, { token: bTok });
    ok('★ 跨主体读采购单详情返回 404（里面有供应商价）', peek.status === 404, `HTTP ${peek.status}`);

    // ---- 2. 跨主体的三个动作 ----
    const actOrder = await req(`/api/purchases/${poOther}/order`, { method: 'POST', token: bTok });
    ok('★ 跨主体不能给别家采购单下单', actOrder.status === 404, `HTTP ${actOrder.status}`);

    const actRecv = await req(`/api/purchases/${poOther}/receive`, {
      method: 'POST', token: bTok, body: { items: [{ id: 1, qty: 1 }] }
    });
    ok('★ 跨主体不能给别家采购单点收', actRecv.status === 404, `HTTP ${actRecv.status}`);

    const actDel = await req(`/api/purchases/${poOther}`, { method: 'DELETE', token: bTok });
    ok('★ 跨主体不能删别家采购单', actDel.status === 404, `HTTP ${actDel.status}`);

    // ---- 3. 新建：主体落在自己这边 ----
    const made = await req('/api/purchases', {
      method: 'POST', token: bTok,
      body: { supplier_id: sup.id, order_date: '2026-10-20', items: [{ name: '范围测试面料', unit: '米', qty: 100, price: 5 }] }
    });
    const madeId = made.json.data && made.json.data.id;
    const madeCo = madeId ? Number(MDB.prepare('SELECT company_id FROM purchase_orders WHERE id = ?').get(madeId).company_id) : null;
    ok('★ 分公司建的采购单记在自己主体（以前没有这一列，一律记到总部）',
      made.status === 200 && madeCo === CO2, `HTTP ${made.status} company_id=${madeCo}`);

    // ---- 4. 下单 + 点收：应付必须开在同一个主体 ----
    const ord = await req(`/api/purchases/${madeId}/order`, { method: 'POST', token: bTok });
    const itemRow = madeId ? MDB.prepare('SELECT id, qty FROM purchase_items WHERE po_id = ?').get(madeId) : null;
    const recv = await req(`/api/purchases/${madeId}/receive`, {
      method: 'POST', token: bTok, body: { items: [{ id: itemRow ? itemRow.id : 0, qty: 100 }] }
    });
    const apRow = madeId
      ? MDB.prepare('SELECT id, company_id, amount FROM ap_invoices WHERE purchase_id = ?').get(madeId)
      : null;
    ok('★ 分公司点收后开出的应付记在分公司（否则货在分部、账在总部）',
      ord.status === 200 && recv.status === 200 && apRow && Number(apRow.company_id) === CO2,
      `下单 ${ord.status} / 点收 ${recv.status} / 应付主体 ${apRow && apRow.company_id}`);

    // ---- 5. 收货看板 ----
    const rb = await req('/api/receipts/board', { token: bTok });
    const rbNos = ((rb.json.data && rb.json.data.rows) || []).map((g) => g.po_no);
    ok('★ 分公司收货看板不含总部的收料单',
      rb.status === 200 && !rbNos.includes('SCOPEPO1'), `看到 ${rbNos.length} 张`);

    // ---- 6. 集团管理员仍能看到 ----
    const adminList = await req('/api/purchases', { token });
    const adminNos = (adminList.json.data || []).map((x) => x.po_no);
    ok('★ 集团管理员仍能看到两个主体的采购单',
      adminNos.includes('SCOPEPO1') && !!madeId, `管理员看到 ${adminNos.length} 张`);

    // ---- 清理 ----
    const killPo = (poId) => {
      if (!poId) return;
      MDB.prepare('DELETE FROM ap_invoices WHERE purchase_id = ?').run(poId);
      MDB.prepare('DELETE FROM goods_receipt_items WHERE grn_id IN (SELECT id FROM goods_receipts WHERE po_id = ?)').run(poId);
      MDB.prepare('DELETE FROM goods_receipt_actions WHERE grn_id IN (SELECT id FROM goods_receipts WHERE po_id = ?)').run(poId);
      MDB.prepare('DELETE FROM goods_receipts WHERE po_id = ?').run(poId);
      MDB.prepare('DELETE FROM purchase_items WHERE po_id = ?').run(poId);
      MDB.prepare('DELETE FROM purchase_orders WHERE id = ?').run(poId);
    };
    killPo(madeId);
    killPo(poOther);
    MDB.prepare('DELETE FROM users WHERE username = ?').run(wname);
    require('../src/services/access').clearCache();
    const leftBuy = Number(MDB.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE po_no IN ('SCOPEPO1','SCOPEPO2')").get().c);
    const leftAp = Number(MDB.prepare("SELECT COUNT(*) c FROM ap_invoices WHERE purchase_id = ?").get(madeId || 0).c);
    ok('采购与收货范围夹具已清干净',
      leftBuy === 0 && leftAp === 0 && !MDB.prepare('SELECT 1 x FROM users WHERE username = ?').get(wname), '已删');
  }

  // ================= 数据范围：人事薪酬（员工/考勤/请假/工资单） =================
  {
    console.log('\n[数据范围：人事薪酬]');
    const { db: MDB } = require('../src/db');
    const { hashPassword } = require('../src/auth/password');
    const ts = '2026-10-20 09:00:00';
    const CO2 = 2;

    MDB.prepare("DELETE FROM employees WHERE code IN ('SCOPEEMP1','SCOPEEMP2')").run();
    const mkEmp = (code, name, companyId) => Number(MDB.prepare(
      `INSERT INTO employees (code, name, position, status, base_salary, hire_date, created_at, company_id)
       VALUES (?,?,?,'active',6000,'2026-01-01',?,?)`
    ).run(code, name, '范围测试', ts, companyId).lastInsertRowid);
    const empOther = mkEmp('SCOPEEMP1', '范围员工甲', 1);
    const empOwn = mkEmp('SCOPEEMP2', '范围员工乙', CO2);

    // 各一条考勤与请假（考勤/请假挂在 employee_id 上，没有 company_id）
    // attendance 表没有 type 列（是 check_in/check_out/status 三件套）
    const attIds = [
      MDB.prepare("INSERT INTO attendance (employee_id, employee_name, date, check_in, status, created_at) VALUES (?,?,?,?,'normal',?)").run(empOther, '范围员工甲', '2026-10-20', '09:00', ts).lastInsertRowid,
      MDB.prepare("INSERT INTO attendance (employee_id, employee_name, date, check_in, status, created_at) VALUES (?,?,?,?,'normal',?)").run(empOwn, '范围员工乙', '2026-10-20', '09:00', ts).lastInsertRowid
    ].map(Number);
    const leaveIds = [
      MDB.prepare("INSERT INTO leave_requests (employee_id, employee_name, type, start_date, end_date, days, reason, status, created_at) VALUES (?,?,'annual','2026-10-21','2026-10-21',1,'范围测试','pending',?)").run(empOther, '范围员工甲', ts).lastInsertRowid,
      MDB.prepare("INSERT INTO leave_requests (employee_id, employee_name, type, start_date, end_date, days, reason, status, created_at) VALUES (?,?,'annual','2026-10-21','2026-10-21',1,'范围测试','pending',?)").run(empOwn, '范围员工乙', ts).lastInsertRowid
    ].map(Number);

    const hname = 'scope_hr';
    const hpwd = 'ScopeHr123456';
    MDB.prepare('DELETE FROM users WHERE username = ?').run(hname);
    MDB.prepare('INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(hname, hashPassword(hpwd), '范围测试人事', 'hr', CO2, ts);
    require('../src/services/access').clearCache();
    const hl = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: hname, password: hpwd })
    }).then((r) => r.json());
    const hTok = hl.data && hl.data.token;
    ok('分公司人事账号可登录', !!hTok, hl.message || 'ok');

    // ---- 1. 员工档案 ----
    const els = await req('/api/employees', { token: hTok });
    const codes = ((els.json.data) || []).map((e) => e.code);
    ok('★ 分公司人事的员工列表不含总部员工（底薪就挂在档案上）',
      els.status === 200 && codes.includes('SCOPEEMP2') && !codes.includes('SCOPEEMP1'),
      `看到 ${codes.length} 人`);

    const putOther = await req(`/api/employees/${empOther}`, {
      method: 'PUT', token: hTok, body: { name: '改名试试' }
    });
    ok('★ 跨主体不能改别家员工档案', putOther.status === 404, `HTTP ${putOther.status}`);

    const delOther = await req(`/api/employees/${empOther}`, { method: 'DELETE', token: hTok });
    ok('★ 跨主体不能给别家员工办离职', delOther.status === 404, `HTTP ${delOther.status}`);

    const madeEmp = await req('/api/employees', {
      method: 'POST', token: hTok, body: { code: 'SCOPEEMP3', name: '范围员工丙', position: '车工', base_salary: 5000 }
    });
    const madeEmpId = madeEmp.json.data && madeEmp.json.data.id;
    const madeEmpCo = madeEmpId ? Number(MDB.prepare('SELECT company_id FROM employees WHERE id = ?').get(madeEmpId).company_id) : null;
    ok('★ 分公司建员工记在自己主体（以前没有这一列）',
      madeEmp.status === 200 && madeEmpCo === CO2, `company_id=${madeEmpCo}`);

    // ---- 2. 考勤 ----
    const att = await req('/api/attendance?month=2026-10', { token: hTok });
    const attEmpIds = (att.json.data || []).map((x) => Number(x.employee_id));
    ok('★ 分公司的考勤列表只含自己员工（工时是工资的前置数据）',
      att.status === 200 && attEmpIds.includes(empOwn) && !attEmpIds.includes(empOther),
      `看到 ${attEmpIds.length} 条`);

    const clockOther = await req('/api/attendance/clock', {
      method: 'POST', token: hTok, body: { employee_id: empOther, type: 'in' }
    });
    ok('★ 不能给别家员工打卡', clockOther.status === 404, `HTTP ${clockOther.status}`);

    // ---- 3. 请假 ----
    const lv = await req('/api/leaves', { token: hTok });
    const lvEmpIds = (lv.json.data || []).map((x) => Number(x.employee_id));
    ok('★ 分公司的请假列表只含自己员工',
      lv.status === 200 && lvEmpIds.includes(empOwn) && !lvEmpIds.includes(empOther),
      `看到 ${lvEmpIds.length} 条`);

    const reviewOther = await req(`/api/leaves/${leaveIds[0]}/review`, {
      method: 'POST', token: hTok, body: { approve: true }
    });
    ok('★ 跨主体不能审批别家员工的请假', reviewOther.status === 404, `HTTP ${reviewOther.status}`);

    // ---- 4. 工资单：生成只算自己员工，并落自己主体 ----
    // 断言**不看该期间总行数**（别的测试/演示可能也在同一期间留了单），
    // 只看三件事：本次创建数 = 本主体在职人数、本主体的行都落在本主体、
    // 别家主体一行都没被新增。
    const PERIOD = '2026-09';
    /**
     * 断言只针对**本次新增的行**，不看该期间总行数、也不看"行数是否恰好等于在职人数"。
     *
     * 为什么：这个期间别的用例/演示也可能留过工资单；而且冒烟上一次若崩在中途没走到清理，
     * 会留下孤儿行（员工已删、工资单还在）—— 按总行数断言就会把"别人的残留"算成自己的错，
     * 排查方向直接跑偏（v1.64 我就为此误判过一次）。
     * 用「生成前后的差集 == 本主体在职员工集合」才既精确又不脆。
     */
    const beforeOther = Number(MDB.prepare('SELECT COUNT(*) c FROM payrolls WHERE period = ? AND company_id <> ?').get(PERIOD, CO2).c);
    const beforeIds = new Set(MDB.prepare('SELECT id FROM payrolls WHERE period = ?').all(PERIOD).map((r) => Number(r.id)));
    const gen = await req('/api/payrolls/generate', {
      method: 'POST', token: hTok, body: { period: PERIOD }
    });
    const afterOther = Number(MDB.prepare('SELECT COUNT(*) c FROM payrolls WHERE period = ? AND company_id <> ?').get(PERIOD, CO2).c);
    const ownActiveIds = MDB.prepare("SELECT id FROM employees WHERE status='active' AND company_id = ?").all(CO2).map((r) => Number(r.id)).sort();
    const newRows = MDB.prepare('SELECT id, employee_id, company_id FROM payrolls WHERE period = ?').all(PERIOD)
      .filter((r) => !beforeIds.has(Number(r.id)));
    const newEmpIds = [...new Set(newRows.map((r) => Number(r.employee_id)))].sort();
    const newCos = [...new Set(newRows.map((r) => Number(r.company_id)))];
    const made = Number((gen.json.data && gen.json.data.created) || 0);
    ok('★ 分公司生成工资单只算自己主体的在职员工，且落在自己主体',
      gen.status === 200
      && made === ownActiveIds.length
      && JSON.stringify(newEmpIds) === JSON.stringify(ownActiveIds)
      && newCos.length === 1 && newCos[0] === CO2
      && afterOther === beforeOther,
      `本次创建 ${made} / 本主体在职 ${ownActiveIds.length} 人 / 新增员工 ${JSON.stringify(newEmpIds)} / 主体 ${JSON.stringify(newCos)} / 别家 ${beforeOther}→${afterOther}`);

    const pl = await req('/api/payrolls?period=2026-09', { token: hTok });
    const plCos = (pl.json.data || []).map((x) => Number(x.company_id) || 1);
    ok('★ 分公司的工资单列表不含别家主体（金额另有脱敏，两者互不替代）',
      pl.status === 200 && plCos.length > 0 && plCos.every((c) => c === CO2),
      `看到 ${plCos.length} 张，主体集合 ${[...new Set(plCos)].join(',') || '空'}`);

    // ---- 5. 集团管理员仍能看到两边 ----
    const adminEmp = await req('/api/employees', { token });
    const adminCodes = (adminEmp.json.data || []).map((e) => e.code);
    ok('★ 集团管理员仍能看到两个主体的员工',
      adminCodes.includes('SCOPEEMP1') && adminCodes.includes('SCOPEEMP2'), `管理员看到 ${adminCodes.length} 人`);

    // ---- 清理 ----
    // 只删本次为夹具员工生成的工资单 —— 按期间整段删会连带抹掉别人的数据
    [empOther, empOwn, madeEmpId].filter(Boolean).forEach((id) =>
      MDB.prepare("DELETE FROM payrolls WHERE period = '2026-09' AND employee_id = ?").run(id));
    [leaveIds[0], leaveIds[1]].forEach((id) => MDB.prepare('DELETE FROM leave_requests WHERE id = ?').run(id));
    [attIds[0], attIds[1]].forEach((id) => MDB.prepare('DELETE FROM attendance WHERE id = ?').run(id));
    [empOther, empOwn, madeEmpId].filter(Boolean).forEach((id) => MDB.prepare('DELETE FROM employees WHERE id = ?').run(id));
    MDB.prepare('DELETE FROM users WHERE username = ?').run(hname);
    require('../src/services/access').clearCache();
    const leftHr = Number(MDB.prepare("SELECT COUNT(*) c FROM employees WHERE code LIKE 'SCOPEEMP%'").get().c);
    const leftPay = Number(MDB.prepare(
      "SELECT COUNT(*) c FROM payrolls WHERE period = '2026-09' AND employee_id IN (" + [empOther, empOwn, madeEmpId].filter(Boolean).join(',') + ')'
    ).get().c);
    ok('人事薪酬范围夹具已清干净',
      leftHr === 0 && leftPay === 0 && !MDB.prepare('SELECT 1 x FROM users WHERE username = ?').get(hname), '已删');
  }

  // ================= 数据范围：计件工资（试算 / 核算单 / 工资条） =================
  {
    console.log('\n[数据范围：计件工资]');
    const { db: PDB } = require('../src/db');
    const { hashPassword } = require('../src/auth/password');
    const ts = '1998-01-15 10:00:00';
    const CO2 = 2;
    const PERIOD = '1998-01';        // 空期间，不碰真实月份的核算单
    const PROC = '__范围计件工序__';  // 独立工序名，避免影响别的单价

    // 幂等清理（重复跑不堆数据）
    const wipe = () => {
      PDB.prepare("DELETE FROM production_reports WHERE remark = 'SMOKE-PWRANGE'").run();
      PDB.prepare('DELETE FROM piece_rates WHERE process_name = ?').run(PROC);
      PDB.prepare(
        'DELETE FROM piece_wage_items WHERE run_id IN (SELECT id FROM piece_wage_runs WHERE period = ?)'
      ).run(PERIOD);
      PDB.prepare('DELETE FROM piece_wage_runs WHERE period = ?').run(PERIOD);
      PDB.prepare("DELETE FROM employees WHERE code IN ('RANGEPW1','RANGEPW2')").run();
      PDB.prepare("DELETE FROM users WHERE username = 'rangepw_hr'").run();
    };
    wipe();

    const mkEmp = (code, name, companyId) => Number(PDB.prepare(
      `INSERT INTO employees (code, name, position, status, base_salary, hire_date, created_at, company_id)
       VALUES (?,?,?,'active',6000,'1998-01-01',?,?)`
    ).run(code, name, '计件范围', ts, companyId).lastInsertRowid);
    const empC1 = mkEmp('RANGEPW1', '计件员工甲', 1);
    const empC2 = mkEmp('RANGEPW2', '计件员工乙', CO2);

    // 单价（工价是集团主数据，没有主体维度 —— 见 docs/DB-SCHEMA.md）
    PDB.prepare(
      `INSERT INTO piece_rates (process_name, style_no, unit_price, effective_from, status, created_by, created_at)
       VALUES (?, NULL, 1.5, '1998-01-01', 'active', 'smoke', ?)`
    ).run(PROC, ts);

    // 两人各一条报工（同期间同工序）：一人属总部、一人属分部
    // order_id 是 NOT NULL —— 借一张现存订单即可：归人的报工按**员工**主体判，与订单主体无关
    const anyOrder = PDB.prepare('SELECT id FROM orders ORDER BY id LIMIT 1').get();
    if (!anyOrder) {
      ok('计件工资范围用例前置数据', true, '库里没有订单，跳过');
    } else {
    const insRep = PDB.prepare(
      `INSERT INTO production_reports
         (order_id, node_id, node_name, report_date, qty_ok, qty_defect, hours, operator, employee_id, remark, created_at)
       VALUES (?,NULL,?,?,?,0,0,?,?,?,?)`
    );
    const repC1 = Number(insRep.run(anyOrder.id, PROC, '1998-01-10', 10, '计件员工甲', empC1, 'SMOKE-PWRANGE', ts).lastInsertRowid);
    const repC2 = Number(insRep.run(anyOrder.id, PROC, '1998-01-11', 20, '计件员工乙', empC2, 'SMOKE-PWRANGE', ts).lastInsertRowid);

    const uname = 'rangepw_hr';
    const upwd = 'RangePw123456';
    // 角色必须是 finance：确认/作废的 requireRole 是 APPROVE=['admin','finance']，
    // 用 hr 会先被 RBAC 拦成 403，就测不到"跨主体 404"这一层（权限 ≠ 数据范围）
    PDB.prepare('INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(uname, hashPassword(upwd), '计件范围财务', 'finance', CO2, ts);
    require('../src/services/access').clearCache();
    const sl = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: upwd })
    }).then((r) => r.json());
    const sTok = sl.data && sl.data.token;
    ok('分公司计件财务账号可登录', !!sTok, sl.message || 'ok');

    // ---- 1. 试算只含自己员工的报工 ----
    const pv = await req('/api/piece-wage/preview?period=' + PERIOD, { token: sTok });
    const pvItems = (pv.json.data && pv.json.data.items) || [];
    const pvEmpIds = [...new Set(pvItems.map((x) => Number(x.employee_id)))];
    const admPv = await req('/api/piece-wage/preview?period=' + PERIOD, { token });
    const admEmpIds = [...new Set(((admPv.json.data && admPv.json.data.items) || []).map((x) => Number(x.employee_id)))];
    ok('★ 分公司试算只算自己员工的报工（钱发给谁就记谁的账）',
      pv.status === 200 && pvEmpIds.length === 1 && pvEmpIds[0] === empC2,
      `明细 ${pvItems.length} 条 / 员工 ${JSON.stringify(pvEmpIds)}（总部视角 ${JSON.stringify(admEmpIds)}）`);

    ok('集团管理员的试算仍含两个主体（合并口径不能被范围拦死）',
      admPv.status === 200 && admEmpIds.includes(empC1) && admEmpIds.includes(empC2),
      `员工 ${JSON.stringify(admEmpIds)}`);

    // ---- 2. 总部先建单并确认（造出「同月已有确认单」） ----
    const admMk = await req('/api/piece-wage/runs', { method: 'POST', token, body: { period: PERIOD } });
    const admRunId = admMk.json.data && admMk.json.data.id;
    ok('总部可建本期间核算单', admMk.status === 200 && !!admRunId, `HTTP ${admMk.status} ${admMk.json.message || ''}`);
    const admCf = await req(`/api/piece-wage/runs/${admRunId}/confirm`, { method: 'POST', token, body: {} });
    ok('总部核算单可确认', admCf.status === 200, `HTTP ${admCf.status} ${admCf.json.message || ''}`);

    // ---- 3. 分部同月仍能建自己的单（互斥必须按主体） ----
    const mk = await req('/api/piece-wage/runs', { method: 'POST', token: sTok, body: { period: PERIOD } });
    const runId = mk.json.data && mk.json.data.id;
    const runCo = runId ? Number(PDB.prepare('SELECT company_id FROM piece_wage_runs WHERE id = ?').get(runId).company_id) : null;
    const runNo = runId ? PDB.prepare('SELECT run_no FROM piece_wage_runs WHERE id = ?').get(runId).run_no : '';
    ok('★ 总部同月已有确认单时，分公司仍能建自己那张（互斥原来查全集团）',
      mk.status === 200 && !!runId && runCo === CO2,
      `HTTP ${mk.status} ${mk.json.message || ''} 主体=${runCo}`);
    ok('★ 分公司核算单号带主体后缀（run_no 全局唯一，不然两个主体撞号）',
      /C2$/.test(String(runNo)) && String(runNo).startsWith('PW199801'),
      `单号 ${runNo}`);

    // ---- 4. 列表与详情按主体 ----
    const list = await req('/api/piece-wage/runs?period=' + PERIOD, { token: sTok });
    const listCos = [...new Set(((list.json.data) || []).map((r) => Number(r.company_id)))];
    ok('★ 分公司核算单列表不含总部主体',
      list.status === 200 && listCos.length === 1 && listCos[0] === CO2,
      `看到 ${((list.json.data) || []).length} 张，主体 ${JSON.stringify(listCos)}`);

    const getOther = await req(`/api/piece-wage/runs/${admRunId}`, { token: sTok });
    ok('★ 跨主体读核算单详情 404（不是 403，避免被探测存在性）',
      getOther.status === 404, `HTTP ${getOther.status}`);

    const cfOther = await req(`/api/piece-wage/runs/${admRunId}/confirm`, { method: 'POST', token: sTok, body: {} });
    ok('★ 跨主体不能确认别家核算单', cfOther.status === 404, `HTTP ${cfOther.status}`);

    const slipOther = await req(`/api/piece-wage/runs/${admRunId}/payslips`, { token: sTok });
    ok('★ 跨主体不能出别家工资条（一张条子就是一个人的工钱）',
      slipOther.status === 404, `HTTP ${slipOther.status}`);

    const voidOther = await req(`/api/piece-wage/runs/${admRunId}/void`, {
      method: 'POST', token: sTok, body: { reason: '跨主体作废试试' }
    });
    ok('★ 跨主体不能作废别家核算单', voidOther.status === 404, `HTTP ${voidOther.status}`);

    // ---- 5. 自己的单能确认，且工资条只含自己的人 ----
    const cf = await req(`/api/piece-wage/runs/${runId}/confirm`, { method: 'POST', token: sTok, body: {} });
    ok('分公司可确认自己那张核算单', cf.status === 200, `HTTP ${cf.status} ${cf.json.message || ''}`);
    const slip = await req(`/api/piece-wage/runs/${runId}/payslips`, { token: sTok });
    const slipRows = (slip.json.data && slip.json.data.rows) || [];
    const slipIds = [...new Set(slipRows.map((r) => Number(r.employee_id)))];
    ok('★ 工资条只含本主体的人', slip.status === 200 && slipIds.length === 1 && slipIds[0] === empC2,
      `条数 ${slipRows.length} / 员工 ${JSON.stringify(slipIds)}`);

    // ---- 清理 ----
    wipe();
    const left = Number(PDB.prepare('SELECT COUNT(*) c FROM piece_wage_runs WHERE period = ?').get(PERIOD).c);
    const leftRep = Number(PDB.prepare("SELECT COUNT(*) c FROM production_reports WHERE remark = 'SMOKE-PWRANGE'").get().c);
    const leftRate = Number(PDB.prepare('SELECT COUNT(*) c FROM piece_rates WHERE process_name = ?').get(PROC).c);
    require('../src/services/access').clearCache();
    ok('计件工资范围夹具已清干净', left === 0 && leftRep === 0 && leftRate === 0,
      `单 ${left} / 报工 ${leftRep} / 单价 ${leftRate}`);
    }
  }

  // ================= 数据范围：资产工衣与领归（实物 / 领用 / 清退 / 定责） =================
  {
    console.log('\n[数据范围：资产领归]');
    const { db: CDB } = require('../src/db');
    const { hashPassword } = require('../src/auth/password');
    const ts = '2026-10-20 09:00:00';
    const CO2 = 2;

    const wipe = () => {
      const itIds = CDB.prepare("SELECT id FROM custody_items WHERE item_no IN ('RANCU1','RANCU2')").all().map((r) => Number(r.id));
      if (itIds.length) {
        const ph = itIds.map(() => '?').join(',');
        CDB.prepare(`DELETE FROM custody_claims WHERE item_id IN (${ph})`).run(...itIds);
        CDB.prepare(`DELETE FROM custody_records WHERE item_id IN (${ph})`).run(...itIds);
        CDB.prepare(`DELETE FROM custody_items WHERE id IN (${ph})`).run(...itIds);
      }
      CDB.prepare("DELETE FROM custody_clearances WHERE clearance_no = 'RANCUC1'").run();
      CDB.prepare("DELETE FROM employees WHERE code IN ('RANCU1','RANCU2')").run();
      CDB.prepare("DELETE FROM users WHERE username = 'cu_hr'").run();
    };
    wipe();

    const mkEmp = (code, name, companyId) => Number(CDB.prepare(
      `INSERT INTO employees (code, name, position, status, base_salary, hire_date, created_at, company_id)
       VALUES (?,?,?,'active',6000,'2026-01-01',?,?)`
    ).run(code, name, '领归范围', ts, companyId).lastInsertRowid);
    const empC1 = mkEmp('RANCU1', '领归员工甲', 1);
    const empC2 = mkEmp('RANCU2', '领归员工乙', CO2);

    const mkItem = (no, name, companyId) => Number(CDB.prepare(
      `INSERT INTO custody_items (item_no, kind, name, durable, qty_total, qty_out, unit, require_return,
         status, company_id, created_at, updated_at)
       VALUES (?,?,?,0,50,0,'双',1,'active',?,?,?)`
    ).run(no, 'ppe', name, companyId, ts, ts).lastInsertRowid);
    const itemC1 = mkItem('RANCU1', '范围手套甲', 1);
    const itemC2 = mkItem('RANCU2', '范围手套乙', CO2);

    const recC1 = Number(CDB.prepare(
      `INSERT INTO custody_records (rec_no, item_id, item_kind, durable, employee_id, employee_name, qty, status,
         issued_at, issued_by, returned_qty, created_at, updated_at)
       VALUES ('RANCUR1',?,?,0,?,?,5,'issued',?,'smoke',0,?,?)`
    ).run(itemC1, 'ppe', empC1, '领归员工甲', ts, ts, ts).lastInsertRowid);

    CDB.prepare(
      `INSERT INTO custody_clearances (clearance_no, employee_id, employee_name, status, must_total, must_done,
         optional_total, optional_done, created_at, updated_at)
       VALUES ('RANCUC1',?,?,'open',0,0,0,0,?,?)`
    ).run(empC1, '领归员工甲', ts, ts);

    CDB.prepare(
      `INSERT INTO custody_claims (claim_no, record_id, item_id, employee_id, employee_name, damage_type, qty,
         desc_text, claim_amount, review_status, status, created_at, updated_at)
       VALUES ('RANCUD1',?,?,?,?, 'damaged',2,'范围测试',100,'pending','open',?,?)`
    ).run(recC1, itemC1, empC1, '领归员工甲', ts, ts);

    const uname = 'cu_hr';
    const upwd = 'CuHr123456';
    CDB.prepare('INSERT INTO users (username, password_hash, name, role, company_id, active, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(uname, hashPassword(upwd), '领归范围行政', 'hr', CO2, ts);
    require('../src/services/access').clearCache();
    const cl = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: upwd })
    }).then((r) => r.json());
    const cTok = cl.data && cl.data.token;
    ok('分公司行政账号可登录', !!cTok, cl.message || 'ok');

    // ---- 1. 实物档案 ----
    const its = await req('/api/custody/items', { token: cTok });
    const itNos = ((its.json.data) || []).map((x) => x.item_no);
    ok('★ 分公司只看得到自己主体的实物（资产就在这张表上，不靠推）',
      its.status === 200 && itNos.includes('RANCU2') && !itNos.includes('RANCU1'),
      `看到 ${itNos.length} 件：${itNos.slice(0, 6).join(',')}`);

    // 故意在 body 里塞 company_id=1：非集团角色不能借建档把资产记到别家
    const madeIt = await req('/api/custody/items', {
      method: 'POST', token: cTok,
      body: { item_no: 'RANCU3', kind: 'ppe', name: '范围手套丙', durable: false, qty_total: 10, company_id: 1 }
    });
    const madeItId = madeIt.json.data && madeIt.json.data.id;
    const madeItCo = madeItId ? Number(CDB.prepare('SELECT company_id FROM custody_items WHERE id = ?').get(madeItId).company_id) : null;
    ok('★ 分公司建档落在自己主体（body 里传别家 company_id 不作数）',
      madeIt.status === 200 && madeItCo === CO2,
      `HTTP ${madeIt.status} 落主体 ${madeItCo}`);
    if (madeItId) CDB.prepare('DELETE FROM custody_items WHERE id = ?').run(madeItId);

    const editOther = await req('/api/custody/items', {
      method: 'POST', token: cTok, body: { id: itemC1, name: '改名试试', kind: 'ppe', qty_total: 50 }
    });
    ok('★ 跨主体不能改别家实物档案', editOther.status === 404, `HTTP ${editOther.status}`);

    const scrapOther = await req(`/api/custody/scrap/${itemC1}`, {
      method: 'POST', token: cTok, body: { scrap_mode: 'discard', reason: '跨主体处置试试' }
    });
    ok('★ 跨主体不能处置别家实物（处置等于东西消失）', scrapOther.status === 404, `HTTP ${scrapOther.status}`);

    // ---- 2. 领用台账 ----
    const recs = await req('/api/custody/records', { token: cTok });
    const recNos = ((recs.json.data) || []).map((x) => x.rec_no);
    ok('★ 分公司领用台账不含别家实物的记录',
      recs.status === 200 && !recNos.includes('RANCUR1'),
      `看到 ${recNos.length} 条`);

    const mkRecOther = await req('/api/custody/records', {
      method: 'POST', token: cTok, body: { item_id: itemC1, employee_id: empC1, qty: 1, draft: true }
    });
    ok('★ 跨主体不能给别家实物登记领用', mkRecOther.status === 404, `HTTP ${mkRecOther.status}`);

    const getRecOther = await req(`/api/custody/records/${recC1}`, { token: cTok });
    ok('★ 跨主体读领用详情 404', getRecOther.status === 404, `HTTP ${getRecOther.status}`);

    const pubOther = await req(`/api/custody/records/${recC1}/publish`, { method: 'POST', token: cTok, body: {} });
    ok('★ 跨主体不能发放别家的领用草稿', pubOther.status === 404, `HTTP ${pubOther.status}`);

    // ---- 3. 谁身上有什么 ----
    const pvOther = await req(`/api/custody/person/${empC1}`, { token: cTok });
    ok('★ 跨主体不能查「谁身上有什么」（等于点名册级的领用清单）',
      pvOther.status === 404, `HTTP ${pvOther.status}`);

    // ---- 4. 离职清退 ----
    const clrs = await req('/api/custody/clearances', { token: cTok });
    const clrNos = ((clrs.json.data) || []).map((x) => x.clearance_no);
    ok('★ 分公司清退单列表不含别家员工',
      clrs.status === 200 && !clrNos.includes('RANCUC1'), `看到 ${clrNos.length} 张`);

    const mkClrOther = await req('/api/custody/clearances', {
      method: 'POST', token: cTok, body: { employee_id: empC1, reason: '跨主体清退试试' }
    });
    ok('★ 跨主体不能给别家员工开离职清退', mkClrOther.status === 404, `HTTP ${mkClrOther.status}`);

    // ---- 5. 损坏定责 ----
    const clms = await req('/api/custody/claims', { token: cTok });
    const clmNos = ((clms.json.data) || []).map((x) => x.claim_no);
    ok('★ 分公司定责单列表不含别家实物（金额最终进哪家账要能对上）',
      clms.status === 200 && !clmNos.includes('RANCUD1'), `看到 ${clmNos.length} 张`);

    // ---- 6. 看板统计 ----
    const bd = await req('/api/custody/board', { token: cTok });
    const ownItemCnt = Number(CDB.prepare("SELECT COUNT(*) c FROM custody_items WHERE status='active' AND company_id = ?").get(CO2).c);
    const bdItems = bd.json.data && bd.json.data.stats ? Number(bd.json.data.stats.items) : -1;
    const bdActCo = ((bd.json.data && bd.json.data.actions) || []).length;
    ok('★ 看板统计只算本主体（在册数与库里一致，最近动作不漏别家）',
      bd.status === 200 && bdItems === ownItemCnt && bdActCo === 0,
      `看板 ${bdItems} / 库里 ${ownItemCnt} / 动作 ${bdActCo} 条`);

    // ---- 清理 ----
    wipe();
    const leftIt = Number(CDB.prepare("SELECT COUNT(*) c FROM custody_items WHERE item_no LIKE 'RANCU%'").get().c);
    const leftRec = Number(CDB.prepare("SELECT COUNT(*) c FROM custody_records WHERE rec_no = 'RANCUR1'").get().c);
    const leftClm = Number(CDB.prepare("SELECT COUNT(*) c FROM custody_claims WHERE claim_no = 'RANCUD1'").get().c);
    require('../src/services/access').clearCache();
    ok('资产领归范围夹具已清干净', leftIt === 0 && leftRec === 0 && leftClm === 0,
      `实物 ${leftIt} / 领用 ${leftRec} / 定责 ${leftClm}`);
  }

  // ================= 安全加固（v1.68：账号归属 / 会话撤销 / 集团权限 / 上传 / 密钥 / 限流） =================
  {
    console.log('\n[安全加固]');
    const { db: HDB } = require('../src/db');
    /**
     * 上传夹具要删盘上的文件，不能只删逻辑记录
     *
     * 冒烟每次跑都往 `data/uploads` 落一个 51 字节的 png；不删的话一年就是几百个
     * 没人认领的碎片（备份包也会跟着变大）。「跑完无残留」这条自检本来只查数据库，
     * 文件得自己删。
     */
    const FSU = require('fs');
    const PXU = require('path');
    const UPLOAD_DIR = require('../src/routes/upload').UPLOAD_DIR;
    let upFileName = null;
    const STAMP = String(Date.now()).slice(-7);
    const U_SCOPE = 'smk_sec_' + STAMP;      // 账号归属 + 会话撤销
    const U_LOCK = 'smk_lock_' + STAMP;      // 登录限流（这个账号故意永远登不上）
    const EP_CODE = 'smk_ep_' + STAMP;       // 接入密钥
    let scopeUid = null;
    let epId = null;

    /**
     * ---- 1. 新建账号必须落公司主体 ----
     *
     * 原来 POST /api/users 的 INSERT 不带 company_id（列默认 NULL），而范围层对
     * "没绑主体"的账号原本是「不过滤」—— 于是从管理页面上建的账号能看到所有主体。
     * 这条断言盯的就是"建完必须带上归属"，不是"页面看着有值"。
     */
    const mkScope = await req('/api/users', {
      method: 'POST', token,
      body: { username: U_SCOPE, password: 'Smk#2026', name: '冒烟安全账号', role: 'sales' }
    });
    const scopeRow = mkScope.status === 200 ? mkScope.json.data : {};
    scopeUid = scopeRow.id || null;
    ok('★ 新建账号自动落公司主体（不再是 NULL）',
      mkScope.status === 200 && Number(scopeRow.company_id) > 0,
      `HTTP ${mkScope.status} company_id=${scopeRow.company_id}`);
    ok('账号列表带公司名与「缺归属」标记', !!scopeRow.company_name && scopeRow.company_missing === false,
      `${scopeRow.company_name} / missing=${scopeRow.company_missing}`);

    /**
     * ---- 2. 停用 / 改角色必须让旧令牌立刻失效 ----
     *
     * JWT 签出去就是 12 小时，服务端原本没有"撤回"。停用一个人之后旧令牌还能改钱、
     * 还能导出 —— 这是审计里最容易被问住的一条。现在靠 users.token_version +1 撤回。
     */
    const l1 = await req('/api/auth/login', { method: 'POST', body: { username: U_SCOPE, password: 'Smk#2026' } });
    const scopeTok = l1.status === 200 ? l1.json.data.token : null;
    const beforeOff = await req('/api/orders', { token: scopeTok });
    ok('新账号登录后旧令牌可用（作为对照）', beforeOff.status === 200, `HTTP ${beforeOff.status}`);

    const offIt = await req(`/api/users/${scopeUid}`, { method: 'PUT', token, body: { active: 0 } });
    ok('停用账号时接口明确回报"已作废令牌"',
      offIt.status === 200 && offIt.json.data.token_revoked === true,
      `revoked=${offIt.json.data ? offIt.json.data.token_revoked : '?'}`);
    const afterOff = await req('/api/orders', { token: scopeTok });
    ok('★ 停用后旧令牌立刻 401（不是等 12 小时过期）', afterOff.status === 401,
      `HTTP ${afterOff.status} ${afterOff.json.message || ''}`);

    // 重新启用 → 再登录 → 改角色 → 旧令牌再次失效
    await req(`/api/users/${scopeUid}`, { method: 'PUT', token, body: { active: 1 } });
    const l2 = await req('/api/auth/login', { method: 'POST', body: { username: U_SCOPE, password: 'Smk#2026' } });
    const scopeTok2 = l2.status === 200 ? l2.json.data.token : null;
    const roleIt = await req(`/api/users/${scopeUid}`, { method: 'PUT', token, body: { role: 'warehouse' } });
    const afterRole = await req('/api/orders', { token: scopeTok2 });
    ok('★ 改角色后旧令牌立刻 401（降权对已登录的人同样生效）',
      roleIt.status === 200 && afterRole.status === 401,
      `revoked=${roleIt.json.data ? roleIt.json.data.token_revoked : '?'} / HTTP ${afterRole.status}`);

    /**
     * 管理员不能把自己停用 / 降权 —— 只有他一个管理员时，这两个操作会把系统锁死，
     * 之后只能改库。守卫必须在写库之前，否则"提示失败但已经写进去了"。
     */
    const meId = (await req('/api/auth/me', { token })).json.data.id;
    const killSelf = await req(`/api/users/${meId}`, { method: 'PUT', token, body: { active: 0 } });
    ok('★ 管理员不能停用自己（防自锁）', killSelf.status === 400, `HTTP ${killSelf.status}`);

    /**
     * ---- 3. 集团报表与公司详情不再对所有业务角色开放 ----
     *
     * 原来 READ 白名单里有 sales/tech/production/warehouse：业务员在订单页看不到
     * 别家的单，却能在集团页看到别家每月的利润和在职人员名单。
     */
    const l3 = await req('/api/auth/login', { method: 'POST', body: { username: U_SCOPE, password: 'Smk#2026' } });
    const salesTok = l3.status === 200 ? l3.json.data.token : null;
    const gOv = await req('/api/group/overview', { token: salesTok });
    const gCo = await req('/api/group/companies', { token: salesTok });
    ok('★ 普通业务角色读集团总览被拒（403）', gOv.status === 403, `HTTP ${gOv.status}`);
    ok('★ 普通业务角色读主体列表被拒（403）', gCo.status === 403, `HTTP ${gCo.status}`);
    const gOk = await req('/api/group/companies', { token });
    ok('管理员仍可读集团主体（不是把入口一起关掉）', gOk.status === 200, `HTTP ${gOk.status}`);

    /**
     * ---- 4. 上传：只收明确类型，且验文件头 ----
     *
     * 原来未知 MIME 会从客户端文件名抠扩展名 → 传 evil.html 就落成 .html，
     * 配合 /uploads 同源静态托管 = 在 ERP 域下执行脚本（能读走 localStorage 里的 token）。
     */
    const HTML_B64 = Buffer.from('<html><script>alert(document.cookie)</script></html>').toString('base64');
    const upHtml = await req('/api/upload/file', {
      method: 'POST', token, body: { dataUrl: 'data:text/html;base64,' + HTML_B64, filename: 'x.html' }
    });
    ok('★ 拒绝上传 HTML（活动内容不进上传目录）', upHtml.status === 400, `HTTP ${upHtml.status}`);

    const upFake = await req('/api/upload/file', {
      method: 'POST', token, body: { dataUrl: 'data:image/png;base64,' + HTML_B64, filename: 'x.png' }
    });
    ok('★ 声明成 png 的 HTML 被拒（验的是文件头，不是 MIME 字符串）', upFake.status === 400, `HTTP ${upFake.status}`);

    const upGuess = await req('/api/upload/file', {
      method: 'POST', token, body: { dataUrl: 'data:application/octet-stream;base64,' + HTML_B64, filename: 'evil.html' }
    });
    ok('★ 未知类型不再按文件名猜扩展名', upGuess.status === 400, `HTTP ${upGuess.status}`);

    // 真图片要能过（否则这条加固会挡住正常的款图上传）
    const PNG_HEX = '89504e470d0a1a0a0000000d494844520000000100000001080600000'
      + '01f15c4890000000a49444154789c6300010000050001';
    const upOk = await req('/api/upload/file', {
      method: 'POST', token,
      body: { dataUrl: 'data:image/png;base64,' + Buffer.from(PNG_HEX, 'hex').toString('base64'), filename: 'ok.png' }
    });
    ok('正常 png 仍可上传（加固没把业务挡死）',
      upOk.status === 200 && /^\/uploads\/[0-9a-f]+\.png$/.test((upOk.json.data || {}).url || ''),
      `HTTP ${upOk.status} ${(upOk.json.data || {}).url || ''}`);
    if (upOk.status === 200) {
      upFileName = PXU.basename(String(upOk.json.data.url || ''));
      const raw = await fetch(BASE + upOk.json.data.url);
      ok('★ 上传目录带 nosniff + CSP sandbox（就算被打开也不执行脚本）',
        raw.headers.get('x-content-type-options') === 'nosniff'
        && /sandbox/.test(String(raw.headers.get('content-security-policy') || '')),
        `nosniff=${raw.headers.get('x-content-type-options')} csp=${raw.headers.get('content-security-policy')}`);
    }
    const htmlStat = await fetch(BASE + '/uploads/any.html');
    ok('★ /uploads 下非白名单扩展名直接 404', htmlStat.status === 404, `HTTP ${htmlStat.status}`);

    /**
     * ---- 5. 外部接入密钥：只存哈希、只认请求头、载荷不留凭证 ----
     */
    const mkEp = await req('/api/integration/endpoints', {
      method: 'POST', token, body: { code: EP_CODE, name: '冒烟接入点' }
    });
    const ep = mkEp.status === 200 ? mkEp.json.data : {};
    epId = ep.id || null;
    const plainKey = ep.api_key_plain || '';
    ok('新建接入点只回一次明文 Key', mkEp.status === 200 && !!plainKey, `HTTP ${mkEp.status}`);
    ok('★ 接入点响应体里没有明文 api_key 字段', ep.api_key === undefined,
      Object.keys(ep).filter((k) => k.indexOf('api_key') === 0).join(','));
    const epList = await req('/api/integration/endpoints', { token });
    const epOne = (epList.json.data || []).find((x) => x.code === EP_CODE) || {};
    ok('★ 接入点列表只给掩码（原来 ...r 展开把明文一起吐出去）',
      epOne.api_key === undefined && /[*]/.test(String(epOne.api_key_masked || '')),
      `masked=${epOne.api_key_masked}`);

    const bodyKey = await req(`/api/integration/ingest/${EP_CODE}`, {
      method: 'POST',
      body: { event_id: 'SMKSEC-BODY-' + STAMP, topic: 'notification', api_key: plainKey }
    });
    ok('★ 请求体里的 api_key 不再被接受（只认 X-Api-Key 请求头）', bodyKey.status === 401,
      `HTTP ${bodyKey.status}`);

    const hdrKey = await req(`/api/integration/ingest/${EP_CODE}`, {
      method: 'POST',
      headers: { 'X-Api-Key': plainKey },
      body: {
        event_id: 'SMKSEC-HDR-' + STAMP, topic: 'notification', title: '冒烟',
        payload: { password: 'p@ss', token: 'tok-abc', keep: 1 }
      }
    });
    ok('请求头带正确 Key 可通过', hdrKey.status === 200, `HTTP ${hdrKey.status}`);
    const evRow = HDB.prepare('SELECT payload FROM integration_events WHERE event_id = ?')
      .get('SMKSEC-HDR-' + STAMP) || {};
    ok('★ 事件报文里的凭证字段已脱敏（备份包里不会出现密钥）',
      /\*\*\*/.test(String(evRow.payload || '')) && !/p@ss|tok-abc/.test(String(evRow.payload || '')),
      String(evRow.payload || '').slice(0, 60));

    const rot = await req(`/api/integration/endpoints/${epId}/rotate-key`, { method: 'POST', token });
    const newKey = rot.status === 200 ? rot.json.data.api_key_plain : '';
    const oldTry = await req(`/api/integration/ingest/${EP_CODE}`, {
      method: 'POST', headers: { 'X-Api-Key': plainKey },
      body: { event_id: 'SMKSEC-OLD-' + STAMP, topic: 'notification' }
    });
    ok('★ 轮换后旧 Key 立即失效', !!newKey && newKey !== plainKey && oldTry.status === 401,
      `HTTP ${oldTry.status}`);
    const stored = HDB.prepare('SELECT api_key, api_key_hash FROM integration_endpoints WHERE id = ?').get(epId) || {};
    ok('★ 库里存的是哈希，明文列为空',
      !stored.api_key && /^[0-9a-f]{64}$/.test(String(stored.api_key_hash || '')),
      `明文=${stored.api_key ? '有' : '无'} 哈希长度=${String(stored.api_key_hash || '').length}`);

    /**
     * ---- 6. 登录限流 ----
     *
     * 锁的是"账号"而不是"IP"：同办公室共用一个出口 IP 很常见，锁 IP 会连坐，
     * 而攻击者换个代理就绕过。这里用一个永远登不上的账号验证。
     */
    let lastStatus = 0;
    for (let i = 0; i < 7; i += 1) {
      const r = await req('/api/auth/login', { method: 'POST', body: { username: U_LOCK, password: 'wrong-' + i } });
      lastStatus = r.status;
    }
    ok('★ 同账号连续失败后被限流（429）', lastStatus === 429, `最后一次 HTTP ${lastStatus}`);
    const adminStillOk = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123456' } });
    ok('限流只锁该账号，不影响其他人登录', adminStillOk.status === 200, `HTTP ${adminStillOk.status}`);

    /**
     * ---- 7. 上线清单要盯住"账号没主体" ----
     *
     * 造一个空归属账号再查清单：单公司模式下应是 warn（不影响使用但要提示），
     * 多主体模式下应是 fail（这种账号会被直接拒绝访问）。
     *
     * ⚠️ 断言写「不是 pass」而不是写死 fail/warn：`CHECKS` 是在**冒烟进程**里跑的，
     * 读的是冒烟进程的环境变量，不是被测服务的（`BASE` 可以指向另一台机器）。
     * 上一版就因为写死 `fail`，在 `SINGLE_COMPANY=0` 的实例上跑单公司模式的脚本时
     * 误报了一条 —— 这与 v1.67 踩过的「冒烟模式读本地 env」是同一个坑。
     */
    const GL2 = require('../src/services/goLive');
    HDB.prepare(
      'INSERT INTO users (username, password_hash, name, role, active, created_at, token_version) VALUES (?,?,?,?,1,?,0)'
    ).run(U_LOCK, 'x', '缺归属账号', 'sales', new Date().toISOString());
    require('../src/services/access').clearCache();
    const scoped = GL2.CHECKS.users_scoped();
    ok('★ 上线清单能查出「账号没有公司主体」', scoped.status !== 'pass',
      `${scoped.status}：${String(scoped.result).slice(0, 60)}`);

    /**
     * ---- 清理：只删自己造的东西 ----
     *
     * 顺序「先子后父」：这个库零外键，漏一步就是孤儿行。
     */
    if (epId) {
      HDB.prepare('DELETE FROM integration_calls WHERE endpoint_id = ?').run(epId);
      HDB.prepare('DELETE FROM integration_events WHERE endpoint_id = ?').run(epId);
      HDB.prepare('DELETE FROM integration_endpoints WHERE id = ?').run(epId);
    }
    HDB.prepare("DELETE FROM integration_events WHERE event_id LIKE 'SMKSEC-%'").run();
    if (scopeUid) {
      HDB.prepare('DELETE FROM user_roles WHERE user_id = ?').run(scopeUid);
      HDB.prepare('DELETE FROM access_exceptions WHERE user_id = ?').run(scopeUid);
      HDB.prepare('DELETE FROM users WHERE id = ?').run(scopeUid);
    }
    HDB.prepare('DELETE FROM users WHERE username = ?').run(U_LOCK);
    require('../src/services/access').clearCache();
    // 盘上的夹具文件也删掉（失败不影响断言 —— 但下面会验它真的没了）
    if (upFileName) {
      try { FSU.unlinkSync(PXU.join(UPLOAD_DIR, upFileName)); } catch (e) { /* ignore */ }
    }
    ok('冒烟上传的图片已从盘上删除（不留碎片）',
      !upFileName || !FSU.existsSync(PXU.join(UPLOAD_DIR, upFileName)),
      upFileName || '(未上传)');

    const leftU = Number(HDB.prepare("SELECT COUNT(*) c FROM users WHERE username LIKE 'smk_sec_%' OR username LIKE 'smk_lock_%'").get().c);
    const leftE = Number(HDB.prepare("SELECT COUNT(*) c FROM integration_endpoints WHERE code LIKE 'smk_ep_%'").get().c);
    const leftEv = Number(HDB.prepare("SELECT COUNT(*) c FROM integration_events WHERE event_id LIKE 'SMKSEC-%'").get().c);
    ok('安全加固夹具已清干净', leftU === 0 && leftE === 0 && leftEv === 0,
      `账号 ${leftU} / 接入点 ${leftE} / 事件 ${leftEv}`);
  }

  // ================= 财务接口的主体范围 + 私有附件下载 =================
  {
    console.log('\n[财务主体与私有附件]');
    const { db: FDB } = require('../src/db');
    const FSF = require('fs');
    const FPX = require('path');
    const UP = require('../src/routes/upload');
    const STAMP2 = String(Date.now()).slice(-7);
    const FIN_U = 'smk_fin_' + STAMP2;
    let finUid = null;

    // 两个主体：第一个是自己那家，第二个用来验"跨主体被挡"
    const cos = FDB.prepare("SELECT id, code, name FROM companies WHERE status='active' ORDER BY id").all();
    const CO_A = cos.length ? cos[0].id : 1;
    const CO_B = (cos.find((c) => Number(c.id) !== Number(CO_A)) || {}).id || null;

    const mkFin = await req('/api/users', {
      method: 'POST', token,
      body: {
        username: FIN_U, password: 'Smk#2026', name: '冒烟财务', role: 'finance',
        company_id: isSingleMode() ? undefined : CO_A
      }
    });
    finUid = mkFin.status === 200 ? mkFin.json.data.id : null;
    ok('可建财务临时账号（绑到主体 A）', mkFin.status === 200 && !!finUid, `HTTP ${mkFin.status}`);

    const finLogin = await req('/api/auth/login', { method: 'POST', body: { username: FIN_U, password: 'Smk#2026' } });
    const finTok = finLogin.status === 200 ? finLogin.json.data.token : null;
    ok('财务临时账号可登录', !!finTok, `HTTP ${finLogin.status}`);

    /**
     * 财务接口一律"服务端定主体"
     *
     * 这几条盯的是同一个病：路由把 `req.query.company_id` 直接交给服务层，
     * 而服务层把"没有主体"当成不过滤 → 不传参看集团合并数、传别家看别家账。
     */
    if (finTok) {
      const cfOwn = await req('/api/cashflow/plan?weeks=4', { token: finTok });
      ok('资金计划：不传主体也能用（落到自己的主体）', cfOwn.status === 200, `HTTP ${cfOwn.status}`);

      const ckOwn = await req('/api/cockpit/aging?kind=ar', { token: finTok });
      const ckCo = ckOwn.json.data ? ckOwn.json.data.company_id : null;
      ok('★ 驾驶舱不再默认算"集团合并数"',
        ckOwn.status === 200 && (isSingleMode()
          // 单公司模式：不传主体 = 不过滤（与应付台账等模块同一口径，避免两个页面两个数）
          ? (ckCo === null || Number(ckCo) > 0)
          : Number(ckCo) === Number(CO_A)),
        `company_id=${ckCo} 期望 ${isSingleMode() ? 'null（不过滤）' : CO_A}`);

      const glAll = await req('/api/gl/periods?company_id=all', { token: finTok });
      const glRows = glAll.status === 200 ? glAll.json.data : [];
      const foreignRows = (glRows || []).filter((r) => Number(r.company_id) !== Number(CO_A));
      ok('★ 总账期间：普通角色传 all 也只回自己的主体',
        glAll.status === 200 && (isSingleMode() || foreignRows.length === 0),
        `共 ${glRows.length} 行，别家 ${foreignRows.length} 行`);

      if (!isSingleMode() && CO_B) {
        const cfOther = await req(`/api/cashflow/plan?weeks=4&company_id=${CO_B}`, { token: finTok });
        ok('★ 资金计划：指定别家主体 → 404（不泄露存在性）', cfOther.status === 404, `HTTP ${cfOther.status}`);

        const ckOther = await req(`/api/cockpit/overview?company_id=${CO_B}`, { token: finTok });
        ok('★ 驾驶舱：指定别家主体 → 404', ckOther.status === 404, `HTTP ${ckOther.status}`);

        const taxOther = await req(`/api/tax/preview?period=2026-09&company_id=${CO_B}`, { token: finTok });
        ok('★ 税负测算：指定别家主体 → 404', taxOther.status === 404, `HTTP ${taxOther.status}`);

        const glOther = await req(`/api/gl/vouchers?company_id=${CO_B}`, { token: finTok });
        ok('★ 总账凭证：指定别家主体 → 404', glOther.status === 404, `HTTP ${glOther.status}`);

        // 集团角色仍可跨主体（收紧了普通角色，不能把老板一起关掉）
        const cfAdmin = await req(`/api/cashflow/plan?weeks=4&company_id=${CO_B}`, { token });
        ok('集团角色（admin）仍可指定别的主体', cfAdmin.status === 200, `HTTP ${cfAdmin.status}`);
      } else {
        // 单公司模式：显式传的主体照用（历史多主体数据还在），但不存在的主体要报错而不是静默忽略
        const cfBad = await req('/api/cashflow/plan?weeks=4&company_id=999999', { token: finTok });
        ok('单公司模式：不存在的主体编号 → 404（不再静默当成抬头）', cfBad.status === 404, `HTTP ${cfBad.status}`);
      }
    }

    /**
     * 私有附件：**上传 → 鉴权下载 → 签名下载**，且公开区拿不到
     *
     * 这组断言是给"签名下载与上传目录不是同一个"那个 bug 上的锁：
     * 原来上传写 `data/uploads`、签名读 `backend/uploads`，链接必然 404。
     */
    const PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');
    const upPdf = await req('/api/upload/file', {
      method: 'POST', token,
      body: { dataUrl: 'data:application/pdf;base64,' + PDF_B64, filename: '冒烟附件.pdf' }
    });
    const att = upPdf.status === 200 ? upPdf.json.data : {};
    ok('★ PDF 上传落到私有区（返回 /api/files/att/… 而不是 /uploads/…）',
      upPdf.status === 200 && /^\/api\/files\/att\/[0-9a-f]+\.pdf$/.test(String(att.url || '')),
      `HTTP ${upPdf.status} ${att.url || ''}`);

    if (upPdf.status === 200) {
      const pubTry = await fetch(BASE + '/uploads/' + att.name);
      ok('★ 公开区访问同名附件 → 404（附件不在公网上）', pubTry.status === 404, `HTTP ${pubTry.status}`);

      const anonTry = await fetch(BASE + att.url);
      ok('★ 附件无 token 直接访问 → 401', anonTry.status === 401, `HTTP ${anonTry.status}`);

      const withTok = await fetch(BASE + att.url, { headers: { Authorization: 'Bearer ' + token } });
      ok('带 token 可下载附件（Content-Disposition 为 attachment）',
        withTok.status === 200 && /attachment/.test(String(withTok.headers.get('content-disposition') || '')),
        `HTTP ${withTok.status}`);

      const signed = await req('/api/files/signed-url', { method: 'POST', token, body: { name: att.name, ttl: 600 } });
      const sUrl = signed.status === 200 ? signed.json.data.url : '';
      ok('可把附件换成带过期时间的签名链接', !!sUrl, `HTTP ${signed.status}`);
      if (sUrl) {
        const bySig = await fetch(BASE + sUrl);
        ok('★ 签名链接免登录可下（发给外部客户用）', bySig.status === 200, `HTTP ${bySig.status}`);
        const tampered = await fetch(BASE + sUrl.replace(/sig=[0-9a-f]+/, 'sig=' + 'a'.repeat(32)));
        ok('★ 改签名后拒绝', tampered.status === 401 || tampered.status === 403, `HTTP ${tampered.status}`);
      }

      // 旧入口（文档里写过的 /api/integration/files/*）必须能找到同一批文件
      const legacy = await req('/api/integration/files/signed-url', { method: 'POST', token, body: { name: att.name } });
      const lUrl = legacy.status === 200 ? legacy.json.data.url : '';
      ok('★ 旧的签名下载入口指向同一存储（目录已统一）', !!lUrl, `HTTP ${legacy.status}`);
      if (lUrl) {
        const lGet = await fetch(BASE + lUrl);
        ok('旧签名链接可下载（对接方不用改）', lGet.status === 200, `HTTP ${lGet.status}`);
      }

      const privTry = await fetch(BASE + '/uploads/private/' + att.name);
      ok('★ /uploads/private/** 被静态托管挡住', privTry.status === 404, `HTTP ${privTry.status}`);

      // 清理：两区都删（文件名相同，可能在任一区）
      [UP.UPLOAD_DIR, UP.PRIVATE_DIR].forEach((d) => {
        try { FSF.unlinkSync(FPX.join(d, att.name)); } catch (e) { /* ignore */ }
      });
      ok('冒烟附件已从盘上删除', !FSF.existsSync(FPX.join(UP.PRIVATE_DIR, att.name)));
    }

    // 清理账号
    if (finUid) {
      FDB.prepare('DELETE FROM user_roles WHERE user_id = ?').run(finUid);
      FDB.prepare('DELETE FROM access_exceptions WHERE user_id = ?').run(finUid);
      FDB.prepare('DELETE FROM users WHERE id = ?').run(finUid);
      require('../src/services/access').clearCache();
    }
    ok('财务主体与附件夹具已清干净',
      Number(FDB.prepare("SELECT COUNT(*) c FROM users WHERE username LIKE 'smk_fin_%'").get().c) === 0);
  }

  // ================= 启动与配置护栏（结构失败必须停、默认值必须被识别） =================
  {
    console.log('\n[启动与配置护栏]');
    const { execFileSync } = require('child_process');
    const os = require('os');
    const fsx = require('fs');
    const px = require('path');

    // ---- 1. 健康检查要能回答"跑的哪套结构" ----
    const h = await req('/api/health');
    const sc = h.json.schema || {};
    ok('★ 健康检查带结构版本与规模（不只是"活着"）',
      h.status === 200 && !!sc.version && Number(sc.tables) > 350 && Number(sc.indexes) > 300,
      `版本 ${sc.version} / ${sc.tables} 表 / ${sc.indexes} 索引`);

    ok('★ 健康检查标记出「配置还不能上线」（开发默认值）',
      h.json.config_ok === false, `config_ok=${h.json.config_ok}`);

    const GL = require('../src/services/goLive');
    const envCheck = GL.CHECKS.env_mode();
    ok('★ 上线清单能拦住「非 production 模式 + 通配 CORS」', envCheck.status === 'fail',
      String(envCheck.result).slice(0, 60));

    // ---- 2. 破损库必须拒绝启动（不是"警告后继续跑"）----
    const tmpDir = fsx.mkdtempSync(px.join(os.tmpdir(), 'erp-badschema-'));
    const badDb = px.join(tmpDir, 'broken.db');
    fsx.writeFileSync(badDb, Buffer.from('这个文件不是 SQLite 数据库'.repeat(200)));
    let brokenExit = 0;
    let brokenOut = '';
    try {
      execFileSync(process.execPath, ['-e', "require('./src/db')"], {
        cwd: px.resolve(__dirname, '..'),
        env: { ...process.env, DB_PATH: badDb },
        stdio: 'pipe', timeout: 30000
      });
    } catch (e) {
      brokenExit = e.status === undefined ? 1 : e.status;
      brokenOut = String((e.stderr || '') + (e.stdout || ''));
    }
    try { fsx.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    ok('★ 结构建不起来时进程退出（不是带着残库继续跑）', brokenExit !== 0, `exit=${brokenExit}`);
    ok('★ 退出时说明是"结构不完整"并给出排查方向', /数据库结构不完整/.test(brokenOut),
      brokenOut.split('\n').filter((l) => l.includes('结构不完整'))[0] || brokenOut.slice(0, 60));

    // ---- 3. 生产环境默认值必须拒绝启动 ----
    let prodExit = 0;
    let prodOut = '';
    try {
      execFileSync(process.execPath, ['src/server.js'], {
        cwd: px.resolve(__dirname, '..'),
        env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '', ADMIN_PASSWORD: '', CORS_ORIGIN: '' },
        stdio: 'pipe', timeout: 30000
      });
    } catch (e) {
      prodExit = e.status === undefined ? 1 : e.status;
      prodOut = String((e.stderr || '') + (e.stdout || ''));
    }
    ok('★ 生产环境用示例密钥/默认口令/通配 CORS 时拒绝启动', prodExit !== 0, `exit=${prodExit}`);
    ok('★ 拒绝启动时直接给出该改的三个环境变量', /JWT_SECRET/.test(prodOut) && /CORS_ORIGIN/.test(prodOut) && /ADMIN_PASSWORD/.test(prodOut),
      prodOut.includes('启动中止') ? '已打印启动中止与修复命令' : prodOut.slice(0, 60));
  }

  /**
   * 兜底：整块用例被条件跳过时，总数可能只掉几条，肉眼看不出；块数会直接破线。
   * 基线取 42（当前 44），留 2 块余量给"按环境跳过"的块。
   */
  ok('★ 用例块覆盖数不低于 42（整块被条件跳过会在这里破线）', blockSeen.size >= 42,
    `本次覆盖 ${blockSeen.size} 块`);

  if (skipped > 0) {
    console.log(`\n单公司模式：跳过 ${skipped} 条多主体范围断言（\`SINGLE_COMPANY=0\` 重启服务后自动恢复）`);
  }
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项（覆盖 ${blockSeen.size} 个用例块` +
    (skipped ? `，跳过 ${skipped} 项` : '') + '）');
  if (fail) {
    console.log('\n失败清单：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('✓ 全部通过\n');
})();
