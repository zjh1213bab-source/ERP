/**
 * 信用闸门演练：拦截 → 放行 → 发货 → 放行单作废（走真实 HTTP，跑完自清理）
 *
 * 为什么必须真跑一遍发货：
 *   1. 拦截是不是真拦在了发货动作上，只有真发货才知道
 *   2. 放行单「只能用一次」如果没测，就等于给了张永久万能钥匙
 *   3. 发货会改订单状态、扣库存。如果只在库里看代码判断，永远发现不了
 *      「拦住了但库存已经扣了」「状态改了但流水没写」这类半截动作
 *
 * 跑完把订单状态、库存、流水、放行单全部还原 —— 演示数据要保持「已入库待发货」，
 * 否则页面上就演不出拦截效果了。
 *
 * 用法（后端要先起来）：cd backend && node scripts/drill-credit-gate.js
 */
const { db } = require('../src/db');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail || ''}`); }
}

async function req(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json, text };
}

async function login() {
  const r = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123456' }
  });
  if (!r.json || !r.json.ok) throw new Error('登录失败：' + r.text.slice(0, 120));
  return r.json.data.token;
}

(async () => {
  const health = await req('/api/health');
  if (health.status !== 200) {
    console.error('后端没起来，先 npm start');
    process.exit(1);
  }
  const token = await login();

  // ---------- 找演示单：CREDITDEMO 客户名下的 instock 单 ----------
  const order = db
    .prepare(
      `SELECT o.* FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE c.code LIKE 'CREDITDEMO%' AND o.status = 'instock'
        ORDER BY o.id LIMIT 1`
    )
    .get();
  if (!order) {
    console.error('没有可用的演示单，先跑 node scripts/seed-credit-demo.js --reset');
    process.exit(1);
  }
  console.log(`演练单：${order.order_no}（id=${order.id}，客户 ${order.customer_id}）\n`);

  // ---------- 备份现场（跑完要一模一样地还原） ----------
  // 库存快照按**这张单的款号**取，不按命名前缀 ——
  // 前缀一改（CREDITDEMO → CDEMOST），快照就变成空数组，
  // 还原时什么都没写回，等于把演示库存永久扣掉了
  const styles = db
    .prepare('SELECT DISTINCT style_no FROM order_items WHERE order_id = ? AND style_no IS NOT NULL')
    .all(order.id)
    .map((r) => r.style_no);
  const stockOfStyles = () =>
    styles.length
      ? db.prepare(`SELECT id, qty FROM stock_items WHERE style_no IN (${styles.map(() => '?').join(',')})`).all(...styles)
      : [];
  const before = {
    status: order.status,
    stock: stockOfStyles(),
    ledgerMax: db.prepare('SELECT COALESCE(MAX(id),0) m FROM stock_ledger').get().m,
    logMax: db.prepare('SELECT COALESCE(MAX(id),0) m FROM order_logs').get().m,
    ovMax: db.prepare('SELECT COALESCE(MAX(id),0) m FROM credit_overrides').get().m
  };

  let overrideId = null;
  try {
    // ===== 1. 预检 =====
    console.log('【1】发货预检');
    const chk = await req(`/api/credit/check/${order.id}`, { token });
    const cj = chk.json && chk.json.data;
    ok('预检返回 blocked', chk.status === 200 && cj && cj.blocked === true, JSON.stringify(cj && cj.level));
    ok('拦住的原因里有「超额度」', cj && (cj.reasons || []).some((r) => r.includes('超额度')), JSON.stringify(cj && cj.reasons));
    ok('拦住的原因里有「逾期」', cj && (cj.reasons || []).some((r) => r.includes('逾期')), JSON.stringify(cj && cj.reasons));
    // 注意别写成「未开票」：服务层原话是「货已发出但还没开票」，断言文本要对得上，
    // 否则测的是我的措辞而不是产品行为
    ok('货已发未开票只作提示（不参与 blocked 判定）',
      cj && (cj.tips || []).some((t) => t.includes('还没开票')));

    // ===== 2. 直接发货必须被拦 =====
    console.log('【2】直接发货');
    const ship1 = await req('/api/stock/ship', { method: 'POST', token, body: { order_id: order.id, warehouse: 'cn' } });
    ok('被拦下（400 + CREDIT_BLOCK）', ship1.status === 400 && ship1.json && ship1.json.code === 'CREDIT_BLOCK',
      `HTTP ${ship1.status} ${ship1.text.slice(0, 100)}`);
    const after1 = db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status;
    ok('订单状态没变（拦在动作之前）', after1 === 'instock', after1);
    const stock1 = stockOfStyles().reduce((n, r) => n + (Number(r.qty) || 0), 0);
    const stock0 = before.stock.reduce((n, r) => n + (Number(r.qty) || 0), 0);
    ok('库存没被扣（半截动作没发生）', Number(stock1) === Number(stock0), `${stock0} → ${stock1}`);

    // ===== 3. 放行单的边界 =====
    console.log('【3】放行单');
    const short = await req('/api/credit/overrides', {
      method: 'POST', token, body: { order_id: order.id, reason: '客户急' }
    });
    ok('理由太短被拒', short.status === 400, `HTTP ${short.status}`);

    const mk = await req('/api/credit/overrides', {
      method: 'POST', token,
      body: { order_id: order.id, reason: '客户已付 30% 定金，财务总监口头同意先发货，余款月底结' }
    });
    overrideId = mk.json && mk.json.data && mk.json.data.id;
    ok('开出一张放行单', mk.status === 200 && overrideId, mk.text.slice(0, 120));
    ok('放行单记下了当时的额度与敞口',
      mk.json && mk.json.data && mk.json.data.limit_snapshot !== null && mk.json.data.exposure_snapshot !== null);

    const dup = await req('/api/credit/overrides', {
      method: 'POST', token, body: { order_id: order.id, reason: '再来一张备用的，怕一张不够用' }
    });
    ok('同一单不许开第二张（还没用掉）', dup.status === 400, `HTTP ${dup.status}`);

    // ===== 4. 带放行单发货 =====
    console.log('【4】放行后发货');
    const ship2 = await req('/api/stock/ship', {
      method: 'POST', token, body: { order_id: order.id, warehouse: 'cn', credit_override_id: overrideId }
    });
    ok('发货成功', ship2.status === 200 && ship2.json && ship2.json.ok, ship2.text.slice(0, 160));
    ok('返回里标出了用的是哪张放行单',
      ship2.json && ship2.json.data && ship2.json.data.credit && ship2.json.data.credit.override_id === overrideId);
    const st2 = db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status;
    ok('订单变成已发货', st2 === 'shipped', st2);
    const ov2 = db.prepare('SELECT used_at, used_by FROM credit_overrides WHERE id = ?').get(overrideId);
    ok('放行单被核销（记了时间与人）', !!ov2.used_at && !!ov2.used_by, JSON.stringify(ov2));
    const stock2 = stockOfStyles().reduce((n, r) => n + (Number(r.qty) || 0), 0);
    ok('库存真的扣了', Number(stock2) < Number(stock0), `${stock0} → ${stock2}`);
    const logRow = db
      .prepare('SELECT note FROM order_logs WHERE order_id = ? ORDER BY id DESC LIMIT 1')
      .get(order.id);
    const logNote = logRow ? logRow.note : '';
    ok('流转日志里留了放行单号', String(logNote).includes(`#${overrideId}`), logNote);

    // ===== 5. 一张只能用一次 =====
    console.log('【5】放行单不许复用');
    // 把订单状态拨回 instock 再试（否则会先被状态校验挡住，测不到「重复使用」这条）
    db.prepare("UPDATE orders SET status = 'instock' WHERE id = ?").run(order.id);
    const reuse = await req('/api/stock/ship', {
      method: 'POST', token, body: { order_id: order.id, warehouse: 'cn', credit_override_id: overrideId }
    });
    ok('重复使用被拒', reuse.status === 400 && /用过/.test(reuse.text), reuse.text.slice(0, 140));

    // ===== 6. 冻结 =====
    console.log('【6】冻结客户');
    const frozen = db
      .prepare(
        `SELECT o.id, o.order_no, o.customer_id FROM orders o JOIN customers c ON c.id = o.customer_id
          WHERE c.code = 'CREDITDEMO03' AND o.status = 'instock' LIMIT 1`
      )
      .get();
    if (frozen) {
      const jf = await req(`/api/credit/check/${frozen.id}`, { token });
      ok('冻结客户额度充足也被拦', jf.json && jf.json.data && jf.json.data.blocked === true);
      ok('原因写明是冻结', jf.json && (jf.json.data.reasons || []).some((r) => r.includes('冻结')));
      const sf = await req('/api/stock/ship', { method: 'POST', token, body: { order_id: frozen.id, warehouse: 'cn' } });
      ok('冻结客户的发货被拦下', sf.status === 400 && sf.json && sf.json.code === 'CREDIT_BLOCK', `HTTP ${sf.status}`);
    } else {
      ok('冻结演示单存在', false, '没找到 CREDITDEMO03 的 instock 单');
    }
  } catch (e) {
    fail++;
    console.log('  ✗ 演练异常：' + e.message);
  } finally {
    // ---------- 还原现场 ----------
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(before.status, order.id);
    before.stock.forEach((s) => {
      db.prepare('UPDATE stock_items SET qty = ? WHERE id = ?').run(s.qty, s.id);
    });
    db.prepare('DELETE FROM stock_ledger WHERE id > ?').run(before.ledgerMax);
    db.prepare('DELETE FROM order_logs WHERE id > ?').run(before.logMax);
    db.prepare('DELETE FROM credit_overrides WHERE id > ?').run(before.ovMax);
    const st = db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status;
    const qty = stockOfStyles().reduce((n, r) => n + (Number(r.qty) || 0), 0);
    console.log(`\n现场已还原：订单 ${order.order_no} = ${st}，库存合计 ${qty}`);
  }

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})();
