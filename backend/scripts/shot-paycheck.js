/**
 * 薪酬计件与工资核对 · 截图与文本取证
 * 用法：node scripts/shot-paycheck.js
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/paycheck');
const PORT = 9907;
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

  await go('/payroll-check');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('明细行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('差异行:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].filter(r=>/有差异|缺工资单|政策待配/.test(r.innerText)).map(r=>r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / ')))`));
  console.log('批次信息:', await ev("document.querySelector('.panel-head .head-ops span')?.textContent?.trim()"));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-核对明细');

  // 计件来源
  await ev(`(()=>{const r=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.innerText.includes('有差异'));const b=r&&[...r.querySelectorAll('button')].find(x=>x.textContent.includes('计件来源'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  console.log('\n来源弹窗:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('来源行数:', await ev("document.querySelectorAll('.modal table.data tbody tr').length"));
  console.log('来源首行:', await ev(`(()=>{const r=document.querySelector('.modal table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  console.log('来源合计:', await ev(`(()=>{const kv=[...document.querySelectorAll('.modal .kv')];return kv.map(x=>x.innerText.replace(/\\n/g,' ')).join(' / ')})()`));
  await shot('02-计件来源');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(600);

  // 登记差异弹窗
  await ev(`(()=>{const r=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.innerText.includes('有差异'));const b=r&&[...r.querySelectorAll('button')].find(x=>x.textContent.includes('登记差异'));if(b){b.click();return true}return false})()`);
  await sleep(1300);
  console.log('\n登记弹窗:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('默认金额:', await ev("document.querySelector('.modal input')?.value"));
  console.log('提示:', await ev("document.querySelector('.modal .notice')?.innerText?.replace(/\\n/g,' ')"));
  await shot('03-登记差异');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(500);

  // 口径
  await clickText('.tabs button', '口径与未覆盖');
  await sleep(1200);
  console.log('\n口径:', await ev("document.querySelector('.basis-txt')?.innerText?.slice(0,240)"));
  console.log('未覆盖条数:', await ev("document.querySelectorAll('.cov-item').length"));
  console.log('规则行数:', await ev("document.querySelectorAll('table.rules tbody tr').length"));
  await shot('04-口径与规则');

  // 历史
  await clickText('.tabs button', '历史批次');
  await sleep(1500);
  console.log('\n历史行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('历史首行:', await ev(`(()=>{const r=document.querySelector('table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  await shot('05-历史批次');

  // 移动端
  await clickText('.tabs button', '核对明细');
  await sleep(1200);
  await shot('06-移动端', 414);
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));

  console.log('\n前端异常:', errors.length ? JSON.stringify(errors) : '无');
  proc.kill();
  process.exit(0);
})();
