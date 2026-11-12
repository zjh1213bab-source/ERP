/**
 * 验货报告截图
 * 用法：node scripts/shot-inspection.js [orderId]
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/inspection');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  if (!lg.ok) { console.log('登录失败', lg.message); process.exit(1); }
  const H = { Authorization: 'Bearer ' + lg.data.token };

  // 找一份已生成的报告（有验货结论 + 照片最多的那张单）
  const recent = (await (await fetch(BASE + '/api/inspection/recent?limit=30', { headers: H })).json()).data || [];
  const pick = recent.sort((a, b) => (b.photos_count || 0) - (a.photos_count || 0))[0];
  if (!pick) { console.log('没有报告，先跑 node scripts/seed-inspection-demo.js'); process.exit(1); }
  const orderId = Number(process.argv[2]) || pick.order_id;
  const full = (await (await fetch(BASE + '/api/inspection/' + pick.id, { headers: H })).json()).data;
  console.log('报告', full.report_no, '订单', full.snapshot.order.order_no, '照片', full.photos_count,
    '结论', full.snapshot.qc.result_label);

  const port = 9785;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1440,1200', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 80 && !t; i++) {
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
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 140);
    return r.result ? r.result.value : null;
  };
  const viewport = async (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const shot = async (name, fullPage = false) => {
    let opts = { format: 'png' };
    if (fullPage) {
      const m = await send('Page.getLayoutMetrics');
      const h = Math.ceil(m.cssContentSize.height);
      opts = { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: Math.min(h, 6000), scale: 1 } };
    }
    const s = await send('Page.captureScreenshot', opts);
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const go = async (path, wait = 4500) => {
    await send('Page.navigate', { url: BASE + path });
    await sleep(wait);
  };

  // 1. 预览（未生成）
  await viewport(1440, 1200);
  await go('/inspection/' + orderId);
  console.log('模式', await ev(`(()=>{const b=document.querySelector('.ir-bar .btn:not(.btn-ghost)');return b?b.textContent.trim():''})()`));
  console.log('结论', await ev('(()=>{const v=document.querySelector(".verdict-val");return v?v.textContent.trim():""})()'));
  console.log('照片数', await ev('document.querySelectorAll(".photos figure").length'));
  console.log('溢出', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-报告预览');

  // 2. 正式报告（带编号）
  await go('/inspection/' + orderId + '?report=' + pick.id, 5000);
  console.log('编号', await ev('(()=>{const e=document.querySelector(".head-meta b");return e?e.textContent.trim():""})()'));
  await shot('02-正式报告');

  // 3. 检验项 + 异常段（滚到第三节）
  await ev(`(()=>{const hs=[...document.querySelectorAll('h2')];const h=hs.find(x=>x.textContent.includes('三、'));if(h){h.scrollIntoView({block:'start'});return true}return false})()`);
  await sleep(900);
  await shot('03-验货结果与检验项');

  // 4. 照片段
  await ev(`(()=>{const hs=[...document.querySelectorAll('h2')];const h=hs.find(x=>x.textContent.includes('六、'));if(h){h.scrollIntoView({block:'start'});return true}return false})()`);
  await sleep(900);
  await shot('04-现场照片');

  // 5. 打印宽度（A4 内容宽 ≈ 794px）
  await viewport(820, 1160);
  await go('/inspection/' + orderId + '?report=' + pick.id, 4500);
  console.log('打印宽度溢出', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('05-打印宽度');

  proc.kill();
  process.exit(0);
})();
