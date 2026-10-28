/**
 * 资金计划（13 周现金流）· 截图与文本取证
 * 用法：node scripts/shot-cashflow.js
 *
 * 取证一律 dump textContent，不靠肉眼看图（宽度不够时表格会被压窄，肉眼读不出数字对不对）。
 */
const fs = require('fs');
const { db } = require('../src/db');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/cashflow');
const PORT = 9853;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

  const profile = pathMod.join(require('os').tmpdir(), 'erp-shot-' + PORT);
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1440,1100', 'about:blank'], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 80 && !t; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) { t = await r.json(); break; }
    } catch (e) { /* ignore */ }
  }
  if (!t) { console.log('连不上调试端口'); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      console.log('⚠ 弹窗:', m.params.message.slice(0, 120));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.id && pend.has(m.id)) {
      if (m.error) console.log('CDP 错误:', JSON.stringify(m.error));
      pend.get(m.id)(m.result || {});
      pend.delete(m.id);
    }
  };
  const send = (mm, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 160);
    return r.result ? r.result.value : null;
  };
  const shot = async (name, w = 1440) => {
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *')].map(e=>e.getBoundingClientRect().bottom))) + 40`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 4000);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(700);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };

  const go = async (url, wait = 6000) => {
    await send('Page.navigate', { url: BASE + url });
    await sleep(wait);
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await go('/cashflow');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('侧栏:', await ev("!!document.querySelector('.erp-sidebar')"));
  console.log('指标卡:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('黄条:', await ev(`(()=>{const b=document.querySelector('.banner');return b?b.innerText.replace(/\\n/g,' / ').slice(0,200):'（无）'})()`));
  console.log('三档表头:', await ev(`JSON.stringify([...document.querySelectorAll('.panel-card table.data thead th')].slice(0,7).map(th=>th.innerText.trim()))`));
  console.log('三档行:', await ev(`JSON.stringify([...document.querySelectorAll('.panel-card table.data tbody tr')].slice(0,3).map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  console.log('周表行数:', await ev('document.querySelectorAll(".panel-card table.data tbody tr").length'));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-资金计划');

  // 点开某一周看明细
  const wk = await ev(`(()=>{
    const rows=[...document.querySelectorAll('tbody tr')].filter(tr=>tr.innerText.includes('→'));
    const hit=rows.find(tr=>tr.innerText.includes('10-29')) || rows[0];
    if(!hit) return 'no-row';
    hit.click(); return 'clicked:' + hit.innerText.replace(/\\n/g,' ').slice(0,40);
  })()`);
  console.log('展开:', wk);
  await sleep(900);
  console.log('明细区块:', await ev('document.querySelectorAll(".detail-grid").length'));
  console.log('流入明细行:', await ev(`(()=>{const d=document.querySelector('.detail-grid');return d?d.querySelectorAll('table.data tbody tr').length:0})()`));
  console.log('流出明细行:', await ev(`(()=>{const gs=document.querySelectorAll('.detail-grid');return gs[1]?gs[1].querySelectorAll('table.data tbody tr').length:0})()`));
  await shot('02-展开某周');

  // 切保守档
  await ev(`(()=>{const s=document.querySelector('.head-ops select');s.value='conservative';s.dispatchEvent(new Event('change'));return s.value})()`);
  await sleep(2500);
  console.log('保守档指标:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')).slice(1,4))`));
  console.log('保守档三档行:', await ev(`JSON.stringify([...document.querySelectorAll('.panel-card table.data tbody tr')].slice(0,3).map(tr=>[...tr.children].map(td=>td.innerText.trim()).join(' | ')))`));
  await shot('03-保守情景');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await go('/cashflow');
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('04-移动端', 414);

  proc.kill();
  process.exit(0);
})();
