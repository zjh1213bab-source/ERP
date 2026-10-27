/**
 * 全链路实操演示：销售下单 → 技术确认 → 财务审核 → 分单 → 生产跟单 → 成品入库 → 发货
 *
 * 特点：真实调用接口落库（不是假数据），每个关键节点用无头 Chrome 截当前界面，
 *       截图按顺序落到 shots/demo/ 目录，可直接当操作手册看。
 *
 * 用法：
 *   node scripts/demo-order-flow.js            # 跑完整链路并截图
 *   node scripts/demo-order-flow.js --no-shot  # 只跑数据，不截图（快速验证）
 *
 * 说明：下单 / 报工都走真实的状态机与角色校验，admin 账号具备全部权限；
 *       若换成 sales/tech/finance/warehouse 账号，中途会被权限和门槛拦住（这是设计如此）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:3000';
const OUT_DIR = path.resolve(__dirname, '../../shots/demo');
const NO_SHOT = process.argv.includes('--no-shot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ---------------- 接口层 ---------------- */
let TOKEN = '';
async function login() {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  });
  const j = await r.json();
  if (!j.ok) throw new Error('登录失败：' + (j.message || r.status));
  TOKEN = j.data.token;
  return j.data.user;
}

async function call(method, api, body) {
  const r = await fetch(BASE + api, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({ ok: false, message: 'HTTP ' + r.status }));
  if (!j.ok) {
    const err = new Error(`${method} ${api} → ${j.message || r.status}`);
    err.payload = j;
    throw err;
  }
  return j.data;
}

/* ---------------- 截图层（CDP） ---------------- */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

async function openBrowser(user) {
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) return null;
  const port = 9400 + Math.floor(Math.random() * 400);
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--window-size=1600,900', '--force-device-scale-factor=1', 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) { /* 等 Chrome 起来 */ }
  }
  if (!target) { proc.kill(); return null; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || {}); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  // 固定视口，否则 headless 会用默认小窗口渲染，截图宽度和布局都不对
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + TOKEN + '");' +
      'localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(user || {})) + ');'
  });

  return {
    /**
     * 截当前界面
     * @param {string} route   业务路由
     * @param {string} name    输出文件名（不含扩展名）
     * @param {object} [opt]   { action: 截图前执行的 JS, scroll: 弹窗内部滚动位置（px 或 'bottom'） }
     */
    async shot(route, name, opt) {
      opt = opt || {};
      await send('Page.navigate', { url: BASE + route });
      await sleep(2600);
      if (opt.action) {
        await send('Runtime.evaluate', { expression: opt.action, awaitPromise: true });
        await sleep(1000);
      }
      if (opt.scroll !== undefined) {
        const expr = `(() => {
          const b = document.querySelector('.modal-body');
          if (!b) return 'no-modal';
          b.scrollTop = ${opt.scroll === 'bottom' ? 'b.scrollHeight' : Number(opt.scroll)};
          return 'scrolled:' + Math.round(b.scrollTop);
        })()`;
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
        if (r && r.result) log('   （弹窗滚动 ' + r.result.value + '）');
        await sleep(700);
      }
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const file = path.join(OUT_DIR, name + '.png');
      if (s && s.data) fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      log('   截图 →', path.relative(path.resolve(__dirname, '../..'), file));
    },
    close() { try { ws.close(); } catch (e) {} proc.kill(); }
  };
}

/* ---------------- 业务编排 ---------------- */
async function main() {
  log('\n=== 跳色科技 ERP · 全链路下单演示 ===\n' + '服务：' + BASE + '\n');
  const user = await login();
  log('① 登录成功：' + user.name + '（' + user.role + '）');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const br = NO_SHOT ? null : await openBrowser(user);
  if (!NO_SHOT && !br) log('   （未找到 Chrome，跳过截图）');

  const today = new Date().toISOString().slice(0, 10);
  const delivery = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  /* ---- 1. 销售下单 ---- */
  log('\n② 销售下单');
  const order = await call('POST', '/api/orders', {
    type: 'custom',
    customer_id: 1,
    style_name: '秋季女士针织开衫',
    cus_order_no: 'ABC-PO-20261026-01',
    manager: '李静',                 // 跟单员
    order_date: today,
    delivery_date: delivery,
    delivery_method: '海运',
    trade_terms: 'FOB 上海',
    packaging: '独立 OPP 袋 + 10 件/箱',
    shop_name: 'ABC Apparel',
    delivery_days: 30,
    freight: 1200,
    remark: '客户要求 11 月黑五前到仓，色卡按上一季同款',
    items: [{
      product_id: 1,
      product_name: '女式针织开衫 A 款',
      style_no: 'LEJE-AW-2601',
      sku: 'SKU-001',
      colors: [
        { color: '藏青', sizes: [{ size: 'S', qty: 120, usd_price: 13.8 }, { size: 'M', qty: 200, usd_price: 13.8 }, { size: 'L', qty: 80, usd_price: 14.2 }] },
        { color: '燕麦', sizes: [{ size: 'S', qty: 120, usd_price: 13.8 }, { size: 'M', qty: 200, usd_price: 13.8 }, { size: 'L', qty: 80, usd_price: 14.2 }] }
      ]
    }]
  });
  const orderId = order.id;
  log(`   订单 ${order.order_no} 已生成｜${order.type === 'custom' ? '定制' : '现货'}｜跟单员 ${order.manager}`);
  log(`   合计 $${order.total_usd} / ¥${order.total_amount}（汇率 ${order.rate}）｜交期 ${order.delivery_date}｜状态 ${order.status}`);
  const qty = order.items.reduce((s, i) => s + Number(i.qty), 0);
  log(`   明细：${order.items[0].product_name} · ${order.items[0].colors.map((c) => c.color + '(' + c.qty + ')').join(' / ')}｜共 ${qty} 件`);

  if (br) {
    await br.shot('/orders?order=' + orderId, '01-销售下单-订单详情');
    await br.shot('/orders?order=' + orderId, '02-订单详情-明细与尺码数量', { scroll: 560 });
    await br.shot('/orders', '03-订单列表-新订单');
  }

  /* ---- 2. 技术确认（开发单） ---- */
  log('\n③ 技术部出开发单并确认');
  const tp = await call('POST', '/api/techpacks', {
    order_id: orderId,
    product_name: '女式针织开衫 A 款 / LEJE-AW-2601',
    version: 'V1',
    fabric_info: '32S 精梳棉 100%，克重 220g/㎡，藏青 + 燕麦两色',
    accessory_info: '树脂四眼扣 18L、主唛、洗唛、吊牌、防潮剂',
    craft_info: '12 针横机 · 全成形 · 领口罗纹 2×2 · 门襟 5 扣 · 下摆收口',
    customer_req: '缩水率 ≤3%，色牢度 4 级以上，交付前做 AQL2.5 抽检',
    size_spec: 'S/M/L 三码，按客户提供尺寸表'
  });
  await call('POST', `/api/techpacks/${tp.id}/confirm`, {});
  await call('POST', `/api/orders/${orderId}/transition`, { to: 'tech', note: '开发单 V1 已确认，面料辅料工艺齐备，转技术确认完成' });
  log('   开发单 ' + tp.version + ' 已确认 → 订单状态「技术确认」');

  if (br) await br.shot('/development', '04-开发管理-开发单');

  /* ---- 3. 成本录入 + 财务审核 ---- */
  log('\n④ 财务核成本、审批');
  const totalQty = qty;
  await call('POST', `/api/costs/${orderId}`, {
    material_cost: Math.round(23800),      // 面料
    accessory_cost: Math.round(3600),      // 辅料
    labor_cost: Math.round(11200),         // 工缴
    overhead_cost: Math.round(4200),       // 制造费用
    other_cost: Math.round(1800),          // 其他
    profit_rate: 22
  });
  let cs = null;
  for (let i = 0; i < 5; i++) {
    cs = await call('GET', `/api/costs/${orderId}`);
    if (cs && cs.status === 'approved') break;
    await call('POST', `/api/costs/${orderId}/review`, { approve: true, opinion: '成本合理，利润率符合报价，同意' });
    log('   审批推进一级');
  }
  cs = await call('GET', `/api/costs/${orderId}`);
  if (cs.status !== 'approved') throw new Error('成本单未通过审核，当前：' + cs.status);
  log(`   成本单已通过：总成本 ¥${cs.total_cost}｜利润率 ${cs.profit_rate}%｜出厂价 ¥${cs.factory_price}`);

  await call('POST', `/api/orders/${orderId}/transition`, { to: 'finance', note: '成本录入完成' });
  await call('POST', `/api/orders/${orderId}/transition`, { to: 'assigned', note: '财务审核通过，分单到自有工厂' });
  log('   厂价 ¥' + cs.factory_price + ' / ' + totalQty + ' 件 = 单件 ¥' + (cs.factory_price / totalQty).toFixed(2) + ' → 订单状态「已分单」');

  /* ---- 4. 投产：自动生成 13 道工序 ---- */
  log('\n⑤ 投入生产（自动生成 13 道工序）');
  await call('POST', `/api/orders/${orderId}/transition`, { to: 'production', note: '正式投产，交期 ' + delivery });
  const nodes = await call('GET', `/api/order-nodes?order_id=${orderId}`);
  log('   工序：' + nodes.map((n) => n.seq + '.' + n.name).join(' → '));

  /* ---- 5. 生产跟单：逐道报工 ---- */
  log('\n⑥ 生产跟单：车间逐道报工（前 6 道）');
  const markDone = async (n, remark) => {
    await call('PATCH', `/api/order-nodes/${n.id}`, {
      status: 'done', actual_date: today, operator: '车间主管·王强', remark
    });
    log('   ✓ ' + n.name + (remark ? '（' + remark + '）' : ''));
  };
  for (let i = 0; i < 5; i++) await markDone(nodes[i], i === 0 ? '面料已到厂，验布合格' : '');
  await call('PATCH', `/api/order-nodes/${nodes[5].id}`, { status: 'doing', operator: '车间主管·王强', remark: '车缝进行中，日产 120 件' });
  log('   → ' + nodes[5].name + '（进行中，日产 120 件）');

  if (br) {
    await br.shot('/production', '05-生产看板-跟单进度');
    await br.shot('/orders?order=' + orderId, '06-订单详情-生产工序', { scroll: 'bottom' });
  }

  /* ---- 6. 完工 → 入库 ---- */
  log('\n⑦ 剩余工序完工 → 成品入库');
  for (let i = 5; i < nodes.length; i++) await markDone(nodes[i], i === nodes.length - 1 ? '装车发运' : '');

  const inRes = await call('POST', '/api/stock/instock', { order_id: orderId, warehouse: 'cn' });
  log('   入库完成：仓库 ' + inRes.warehouse + '｜订单状态 ' + inRes.status);
  const stockRows = await call('GET', '/api/stock?warehouse=cn&q=LEJE-AW-2601');
  const inQty = stockRows.reduce((s, r) => s + Number(r.qty), 0);
  log('   该款国内仓现有库存 ' + inQty + ' 件（6 个颜色尺码组合）');

  if (br) await br.shot('/inventory', '07-库存管理-成品入库');

  /* ---- 7. 发货出库 ---- */
  log('\n⑧ 按订单发货出库');
  const shipRes = await call('POST', '/api/stock/ship', { order_id: orderId, warehouse: 'cn' });
  log('   发货完成：仓库 ' + shipRes.warehouse + '｜订单状态 ' + shipRes.status);
  const after = await call('GET', '/api/stock?warehouse=cn&q=LEJE-AW-2601');
  log('   发货后该款库存 ' + after.reduce((s, r) => s + Number(r.qty), 0) + ' 件（已清零）');

  const detail = await call('GET', `/api/orders/${orderId}`);
  log('\n   订单日志：');
  detail.logs.forEach((l) => log('     ' + (l.created_at || '').slice(0, 19).replace('T', ' ') + '  ' + (l.from_status || '—') + ' → ' + l.to_status + '  ' + (l.note || '')));

  if (br) {
    await br.shot('/orders?order=' + orderId, '08-订单详情-已发货');
    await br.shot('/orders?order=' + orderId, '09-订单详情-流转日志', { scroll: 'bottom' });
    await br.shot('/us-ship', '10-美仓发货');
    await br.shot('/dashboard', '11-工作台总览');
  }

  await call('POST', `/api/orders/${orderId}/transition`, { to: 'closed', note: '货款已收，订单结案' });
  log('\n⑨ 订单结案 ✅');

  if (br) br.close();
  log('\n=== 完成：' + detail.order_no + ' 全链路走通，截图在 shots/demo/ ===\n');
}

main().catch((e) => {
  console.error('\n❌ 流程中断：' + e.message);
  if (e.payload) console.error(JSON.stringify(e.payload));
  process.exit(1);
});
