/**
 * 行政运营报表 · 截图与文本取证
 * 用法：node scripts/shot-adminops.js
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/adminops');
const PORT = 9906;
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
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      console.log('⚠ 弹窗:', m.params.message.slice(0, 200).replace(/\n/g, ' / '));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.text).slice(0, 160));
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
    const height = Math.min(Math.max(Number(h) || 1100, 900), 5200);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(800);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };
  const go = async (url, wait = 6500) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };
  const clickText = async (sel, text) => ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  await go('/admin-ops');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('指标卡数:', await ev("document.querySelectorAll('.sec').length"));
  console.log('指标卡标题:', await ev(`JSON.stringify([...document.querySelectorAll('.sec-h b')].map(x=>x.textContent))`));
  console.log('口径文本:', await ev("document.querySelector('.sec.basis .tiny')?.innerText?.slice(0,260)"));
  console.log('未覆盖条数:', await ev("document.querySelectorAll('.cov-item').length"));
  console.log('当前查看:', await ev("document.querySelector('.panel-head .head-ops span')?.textContent?.trim()"));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-八项指标');

  // 差异清单
  await clickText('.tabs button', '差异清单');
  await sleep(1500);
  console.log('\n差异行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('首行:', await ev(`(()=>{const r=document.querySelector('table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  console.log('严重标签:', await ev("[...document.querySelectorAll('.tag.red')].filter(x=>x.textContent.includes('严重')).length"));
  await shot('02-差异清单');

  // 分派（弹窗）→ 处理
  await ev(`(()=>{const r=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.innerText.includes('待处理'));const b=r&&[...r.querySelectorAll('button')].find(x=>x.textContent.trim()==='分派');if(b){b.click();return true}return false})()`);
  await sleep(1200);
  await ev(`(()=>{const i=document.querySelector('.modal .row input');if(i){i.value='行政主管';i.dispatchEvent(new Event('input'));return true}return false})()`);
  await sleep(200);
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal-foot button')].find(x=>x.textContent.includes('确认分派'));if(b){b.click();return true}return false})()`);
  await sleep(1800);
  console.log('分派后首行状态:', await ev(`(()=>{const r=document.querySelector('table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | '):'（空）'})()`));
  await shot('03-差异分派');

  // 已处理弹窗
  await ev(`(()=>{const b=[...document.querySelectorAll('table.data button')].find(x=>x.textContent.trim()==='处理');if(b){b.click();return true}return false})()`);
  await sleep(1200);
  console.log('处理弹窗:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('处理弹窗提示:', await ev("document.querySelector('.modal .notice')?.innerText?.replace(/\\n/g,' ')"));
  await shot('04-已处理');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(600);

  // 下钻：宿舍
  await clickText('.tabs button', '八项指标');
  await sleep(1200);
  await ev(`(()=>{const s=[...document.querySelectorAll('.sec')].find(x=>x.innerText.includes('宿舍入住'));const b=s&&[...s.querySelectorAll('button')].find(x=>x.textContent.includes('住宿明细'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  console.log('\n下钻标题:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('下钻行数:', await ev("document.querySelectorAll('.modal table.data tbody tr').length"));
  console.log('下钻首行:', await ev(`(()=>{const r=document.querySelector('.modal table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  await shot('05-住宿明细下钻');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(500);

  // 历史版本
  await clickText('.tabs button', '历史版本');
  await sleep(1500);
  console.log('\n历史行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('历史首行:', await ev(`(()=>{const r=document.querySelector('table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  await shot('06-历史版本');

  // 移动端
  await clickText('.tabs button', '八项指标');
  await sleep(1200);
  await shot('07-移动端', 414);
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));

  console.log('\n前端异常:', errors.length ? JSON.stringify(errors) : '无');
  proc.kill();
  process.exit(0);
})();
