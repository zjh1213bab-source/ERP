/**
 * 生产交付效率与质量报表 · 截图与文本取证
 * 用法：node scripts/shot-prodreport.js
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/prodreport');
const PORT = 9891;
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
      console.log('⚠ 弹窗:', m.params.message.slice(0, 140));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (mm, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 200);
    return r.result ? r.result.value : null;
  };
  const shot = async (name, w = 1440) => {
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *')].map(e=>e.getBoundingClientRect().bottom))) + 40`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 5000);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(700);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };
  const go = async (url, wait = 6000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await go('/prod-report');

  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('侧栏:', await ev("!!document.querySelector('.erp-sidebar')"));
  console.log('菜单选中:', await ev("document.querySelector('.erp-nav .sub.router-link-active')?.textContent?.trim()"));
  console.log('口径条数:', await ev("document.querySelectorAll('.caliber li').length"));
  console.log('KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('覆盖率行数:', await ev("document.querySelectorAll('.cov-table tbody tr').length"));
  console.log('覆盖率内容:', await ev(`JSON.stringify([...document.querySelectorAll('.cov-table tbody tr')].map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  console.log('tabs:', await ev(`JSON.stringify([...document.querySelectorAll('.tabs button')].map(b=>b.innerText.trim()))`));
  console.log('准交双口径:', await ev(`JSON.stringify([...document.querySelectorAll('.mini')].map(m=>m.innerText.replace(/\\n/g,' / ').slice(0,90)))`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-准交与延期');

  // 工厂段
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('工厂段'));if(b){b.click();return true}return false})()`);
  await sleep(900);
  console.log('工厂段提示:', await ev(`(()=>{const e=document.querySelector('.warn-box');return e?e.innerText.replace(/\\n/g,' ').slice(0,160):'（无）'})()`));
  console.log('等待表行数:', await ev("document.querySelectorAll('.panel-card table.data tbody tr').length"));
  await shot('02-工厂段与等待');

  // 工序效率
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('工序效率'));if(b)b.click()})()`);
  await sleep(900);
  console.log('效率表头:', await ev(`JSON.stringify([...document.querySelectorAll('.panel-card table.data thead th')].map(x=>x.innerText.trim()))`));
  console.log('效率首行:', await ev(`(()=>{const tr=document.querySelector('.panel-card table.data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  await shot('03-工序效率');

  // 质量
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('质量'));if(b)b.click()})()`);
  await sleep(900);
  console.log('质量首行:', await ev(`(()=>{const tr=document.querySelector('.panel-card table.data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  await shot('04-质量');

  // 在制与计划
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('在制'));if(b)b.click()})()`);
  await sleep(900);
  console.log('在制分档:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c4 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('计划偏差提示:', await ev(`(()=>{const b=[...document.querySelectorAll('.warn-box')];const e=b[b.length-1];return e?e.innerText.slice(0,120):'（无）'})()`));
  await shot('05-在制与计划');

  // 材料与下钻
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('材料'));if(b)b.click()})()`);
  await sleep(900);
  console.log('下钻表:', await ev(`JSON.stringify([...document.querySelectorAll('.panel-card table.data')].slice(-1)[0]?.innerText.split('\\n').slice(0,8) || [])`));
  await shot('06-材料与下钻');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await go('/prod-report');
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  console.log('移动端 KPI 卡:', await ev('document.querySelectorAll(".cards.c6 .stat-card").length'));
  await shot('07-移动端', 414);

  proc.kill();
  process.exit(0);
})();
