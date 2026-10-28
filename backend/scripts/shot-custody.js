/**
 * 资产工衣与领归 · 截图与文本取证
 * 用法：node scripts/shot-custody.js
 *
 * 取证原则：文字与颜色一律读 DOM（textContent / getComputedStyle），不靠肉眼看截图。
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/custody');
const PORT = 9905;
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
  await send('Log.enable');
  const consoleErrors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(String(m.params.exceptionDetails.text).slice(0, 160));
  });

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
  const go = async (url, wait = 6000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };
  const clickText = async (sel, text) => ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  await go('/custody');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('台账行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('首行:', await ev(`(()=>{const r=document.querySelector('table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  console.log('工衣提示:', await ev("document.querySelector('.notice')?.innerText?.replace(/\\n/g,' / ')"));
  console.log('逾期标签数:', await ev("[...document.querySelectorAll('.tag.red')].filter(x=>x.textContent.includes('逾期')).length"));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-领用台账');

  // 归还弹窗：选「损坏」看提示是否出现
  await ev(`(()=>{const r=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.innerText.includes('使用中')||x.innerText.includes('待归还'));if(r){const b=[...r.querySelectorAll('button')].find(x=>x.textContent.includes('归还'));if(b){b.click();return true}}return false})()`);
  await sleep(1400);
  console.log('\n归还弹窗:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('状态未选损坏时的警告:', await ev("document.querySelector('.modal .notice-warn')? '有' : '无'"));
  await ev(`(()=>{const s=document.querySelector('.modal select');if(s){s.value='damaged';s.dispatchEvent(new Event('change'))}return true})()`);
  await sleep(800);
  console.log('选损坏后的警告:', await ev("document.querySelector('.modal .notice-warn')?.innerText?.replace(/\\n/g,' ')"));
  await shot('02-归还登记损坏');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(600);

  // 详情时间线
  await ev(`(()=>{const b=[...document.querySelectorAll('table.data tbody tr button')].find(x=>x.textContent.includes('详情'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  console.log('\n详情标题:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('时间线:', await ev(`JSON.stringify([...document.querySelectorAll('.tl-row')].map(r=>r.innerText.replace(/\\n/g,' ').replace(/\\t/g,' / ')))`));
  await shot('03-领用详情与时间线');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(600);

  // 实物档案
  await clickText('.tabs button', '实物档案');
  await sleep(1800);
  console.log('\n档案行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('归还要求标签:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].map(r=>{const t=[...r.querySelectorAll('.tag')].map(x=>x.textContent);return t.join('/')}))`));
  console.log('关联资产净值:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].map(r=>r.innerText.match(/净值 ¥[\\d,\\.]+/)?.[0]).filter(Boolean))`));
  await shot('04-实物档案');

  // 超期与清退
  await clickText('.tabs button', '超期与清退');
  await sleep(1800);
  console.log('\n超期行数:', await ev("document.querySelectorAll('table.data')[0]?.querySelectorAll('tbody tr').length"));
  console.log('清退行数:', await ev("document.querySelectorAll('table.data')[1]?.querySelectorAll('tbody tr').length"));
  console.log('清退首行:', await ev(`(()=>{const t=document.querySelectorAll('table.data')[1];const r=t&&t.querySelector('tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  await shot('05-超期与清退');

  // 查某人身上挂着什么
  // 选一个身上真有东西的人，否则截出来是「0 条」，看不出这个视图在干什么
  await ev(`(()=>{const s=[...document.querySelectorAll('select')].find(x=>x.textContent.includes('选择员工'));if(s){const o=[...s.options].find(x=>x.textContent.includes('李四'))||s.options[1];s.value=o.value;s.dispatchEvent(new Event('change'));return true}return false})()`);
  await sleep(400);
  await clickText('button', '查询');
  await sleep(1500);
  console.log('\n人员视图:', await ev("document.querySelector('.pb-head')?.innerText?.replace(/\\n/g,' ')"));
  console.log('在手行数:', await ev("document.querySelectorAll('.person-box table.data tbody tr').length"));
  await shot('06-某人身上挂着什么');

  // 损坏复核
  await clickText('.tabs button', '损坏复核');
  await sleep(1500);
  console.log('\n复核行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('复核行:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].map(r=>r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / ')))`));
  console.log('口径提示:', await ev("document.querySelector('.notice')?.innerText?.replace(/\\n/g,' ')"));
  await shot('07-损坏复核');

  // 复核弹窗
  await clickText('table.data button', '复核');
  await sleep(1200);
  console.log('\n复核弹窗:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('建议金额:', await ev("document.querySelector('.modal .notice-warn')?.innerText?.replace(/\\n/g,' ')"));
  await shot('08-责任复核');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(500);

  // 移动端
  await clickText('.tabs button', '领用台账');
  await sleep(1200);
  await shot('09-移动端', 414);
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));

  console.log('\n前端异常:', consoleErrors.length ? JSON.stringify(consoleErrors) : '无');
  proc.kill();
  process.exit(0);
})();
