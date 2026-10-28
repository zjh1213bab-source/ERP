/**
 * 办公耗材与服务采购 · 截图与文本取证
 * 用法：node scripts/shot-officesupply.js
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/officesupply');
const PORT = 9904;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS })
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
      console.log('⚠ 弹窗:', m.params.message.slice(0, 200).replace(/\n/g, ' / '));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (mm, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');

  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 200);
    return r.result ? r.result.value : null;
  };
  const shot = async (name, w = 1440) => {
    if (w < 500) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1200, deviceScaleFactor: 2, mobile: true });
      await sleep(700);
    }
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *')].map(e=>e.getBoundingClientRect().bottom))) + 40`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 5000);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(800);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };
  const go = async (url, wait = 5500) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  await go('/office-supply');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('低库存提示:', await ev("document.querySelector('.notice-warn')?.innerText?.replace(/\\n/g,' / ')"));
  console.log('物品行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-耗材与库存');

  // 流水
  await ev(`(()=>{const b=[...document.querySelectorAll('table.data tbody tr button')].find(x=>x.textContent.includes('流水'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  console.log('\n流水标题:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('流水行数:', await ev("document.querySelectorAll('.modal table.data tbody tr').length"));
  await shot('02-收发流水');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(600);

  // 申领 tab
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('申领'));if(b){b.click();return true}return false})()`);
  await sleep(1800);
  console.log('\n申领行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('申领首行:', await ev(`(()=>{const r=document.querySelector('table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  await shot('03-申领清单');

  // 打开一张已批准的（能看出库存与月限额）
  await ev(`(()=>{const r=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.innerText.includes('已批准'));if(r){r.querySelector('button').click();return true}return false})()`);
  await sleep(1600);
  console.log('申领详情:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('明细行:', await ev(`JSON.stringify([...document.querySelectorAll('.modal table.data tbody tr')].map(r=>r.innerText.replace(/\\n/g,' ').replace(/\\t/g,' / ')))`));
  await shot('04-申领详情');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(600);

  // 采购 tab
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('采购与服务'));if(b){b.click();return true}return false})()`);
  await sleep(1800);
  console.log('\n采购行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('采购行:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].map(r=>r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / ')))`));
  await shot('05-采购与服务');

  // 已验收单的详情：看费用与资产怎么分
  await ev(`(()=>{const r=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.innerText.includes('已验收'));if(r){r.querySelector('button').click();return true}return false})()`);
  await sleep(1600);
  console.log('\n验收单:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('明细归属:', await ev(`JSON.stringify([...document.querySelectorAll('.modal table.data tbody tr')].map(r=>r.innerText.replace(/\\n/g,' ').replace(/\\t/g,' / ')))`));
  console.log('验收说明:', await ev("document.querySelector('.hint-box')?.innerText?.replace(/\\n/g,' ')"));
  await shot('06-验收单费用与资产分开');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(600);

  // 新建采购弹窗（含合并申领）
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('新建采购'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  console.log('\n合并区:', await ev("document.querySelector('.merge-box')?.innerText?.replace(/\\n/g,' / ')"));
  await shot('07-新建采购');
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal-head button')].find(x=>x.textContent.includes('取消'));if(b)b.click()})()`);
  await sleep(500);

  await shot('08-移动端', 414);

  proc.kill();
  process.exit(0);
})();
