/**
 * 应收催收 · 截图与文本取证
 * 用法：node scripts/shot-collections.js
 *
 * 取证一律 dump textContent，不靠肉眼看图（宽度不够时表格会被压窄，肉眼读不出数字对不对）。
 */
const fs = require('fs');
const { db } = require('../src/db');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/collections');
const PORT = 9871;
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
  const shotFixed = async (name, w = 1440, h = 940) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '固定', w + 'x' + h);
  };

  // ================= 1. 任务列表 =================
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await go('/collections');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('侧栏:', await ev("!!document.querySelector('.erp-sidebar')"));
  console.log('指标卡:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('表头:', await ev(`JSON.stringify([...document.querySelectorAll('table.data thead th')].map(th=>th.innerText.trim()))`));
  console.log('行数:', await ev('document.querySelectorAll("table.data tbody tr").length'));
  console.log('各行:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-催收任务列表');

  // ================= 2. 逾期台账 =================
  await ev(`(()=>{const b=[...document.querySelectorAll('.head-ops .btn')].find(x=>x.textContent.includes('逾期台账'));if(b){b.click();return true}return false})()`);
  await sleep(1800);
  console.log('台账标题:', await ev("document.querySelector('.modal-head h3')?.textContent"));
  console.log('台账蓝条:', await ev(`(()=>{const b=document.querySelector('.modal .banner');return b?b.innerText.replace(/\\n/g,' ').slice(0,120):'（无）'})()`));
  console.log('台账行数:', await ev('document.querySelectorAll(".modal table.data tbody tr").length'));
  console.log('台账各行:', await ev(`JSON.stringify([...document.querySelectorAll('.modal table.data tbody tr')].slice(0,4).map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  await shotFixed('02-逾期台账', 1440, 900);
  await ev(`(()=>{const b=document.querySelector('.modal-head .x');if(b)b.click();return true})()`);
  await sleep(700);

  // ================= 3. 详情（跳票那张，信息最全） =================
  const opened = await ev(`(()=>{
    const tr=[...document.querySelectorAll('table.data tbody tr')].find(r=>r.innerText.includes('承诺跳票'));
    if(!tr) return 'no-escalated';
    const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('跟进'));
    if(!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  console.log('打开跳票详情:', opened);
  await sleep(1800);
  console.log('详情标题:', await ev("document.querySelector('.modal-head h3')?.innerText"));
  console.log('详情数字:', await ev(`JSON.stringify([...document.querySelectorAll('.modal .dgrid > div')].map(d=>d.innerText.replace(/\\n/g,':')))`));
  console.log('跟进记录条数:', await ev('document.querySelectorAll(".tl-item").length'));
  console.log('跟进记录内容:', await ev(`JSON.stringify([...document.querySelectorAll('.tl-item')].map(x=>x.innerText.replace(/\\n/g,' / ')))`));
  console.log('发票明细行:', await ev('document.querySelectorAll(".modal .sec table.data tbody tr").length'));
  await shotFixed('03-详情与跟进记录', 1440, 1120);
  await ev(`(()=>{const b=document.querySelector('.modal-head .x');if(b)b.click();return true})()`);
  await sleep(700);

  // ================= 4. 结案弹窗 =================
  const closed = await ev(`(()=>{
    const tr=[...document.querySelectorAll('table.data tbody tr')].find(r=>r.innerText.includes('已联系'));
    if(!tr) return 'no-following';
    const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('结案'));
    if(!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  console.log('打开结案:', closed);
  await sleep(1200);
  console.log('结案标题:', await ev("document.querySelector('.modal-head h3')?.textContent"));
  console.log('结案提示:', await ev(`(()=>{const b=document.querySelector('.modal .banner');return b?b.innerText.replace(/\\n/g,' ').slice(0,110):'（无）'})()`));
  await shotFixed('04-结案', 1440, 700);
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.includes('取消'));if(b)b.click();return true})()`);
  await sleep(600);

  // ================= 5. 移动端 =================
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await go('/collections');
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  console.log('移动端卡片数:', await ev('document.querySelectorAll(".stat-card").length'));
  await shot('05-移动端', 414);

  proc.kill();
  process.exit(0);
})();
