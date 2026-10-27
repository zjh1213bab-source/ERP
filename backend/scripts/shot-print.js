/**
 * 打印单据截图（生产工单 / 装箱单 / 发货单 / 批量）
 * 用法：node scripts/shot-print.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/print';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  if (!lg.ok) { console.log('登录失败', lg.message); process.exit(1); }

  // 挑一张有工序 + 扎包的单
  const orders = (await (await fetch(BASE + '/api/orders', {
    headers: { Authorization: 'Bearer ' + lg.data.token }
  })).json()).data || [];
  // 优先挑「有裁床扎包」的单：扎包是这次新加工单的内容，没有数据的单看不出效果
  const probe = async (id) => {
    const r = await (await fetch(BASE + `/api/cuts/order/${id}`, { headers: { Authorization: 'Bearer ' + lg.data.token } })).json();
    return ((r.data && r.data.bundles) || []).length;
  };
  let target = orders.find((o) => o.status === 'production') || orders[0];
  for (const o of orders) {
    if ((await probe(o.id)) > 0) { target = o; break; }
  }
  console.log('目标订单', target && target.order_no, target && target.id);

  const port = 9788;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1100,1600', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* ignore */ }
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (mm, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 120);
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };

  const go = async (path, h) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: h, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + path });
    await sleep(4200);
  };

  // 生产工单（长页）
  await go(`/print/production/${target.id}`, 3000);
  console.log('条码节点', await ev('document.querySelectorAll(".pr-barcode rect").length'));
  console.log('扎包行', await ev('document.querySelectorAll(".pr-table").length'));
  await shot('01-生产工单');

  // 装箱单
  await go(`/print/packing/${target.id}`, 1200);
  await shot('02-装箱单');

  // 发货单
  await go(`/print/shipping/${target.id}`, 1400);
  await shot('03-发货单');

  // 批量
  const ids = orders.slice(0, 3).map((o) => o.id).join(',');
  await go(`/print/batch?type=production&ids=${ids}`, 2000);
  console.log('批量张数', await ev('document.querySelectorAll(".pb-sheet").length'));
  await shot('04-批量打印');

  proc.kill();
  process.exit(0);
})();
