/**
 * 客户进度发布 · 截图与文本取证
 * 用法：node scripts/shot-custprogress.js
 *
 * 取两个视角：
 *   1. 内部（admin）：订单列表 + 内部真实进度 vs 客户预览 + 版本历史
 *   2. 客户（abc001）：商城订单里的进度条与阶段（只看得到已发布的）
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/custprogress');
const PORT = 9901;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const MALL_USER = process.env.MALL_USER || 'abc001';
const MALL_PASS = process.env.MALL_PASS || 'abc123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS })
  })).json();
  const ml = await (await fetch(BASE + '/api/mall/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MALL_USER, password: MALL_PASS })
  })).json();
  if (!ml.ok) console.log('客户登录失败:', ml.message);

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
      console.log('⚠ 弹窗:', m.params.message.slice(0, 160));
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
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *, .ml-shell > *')].map(e=>e.getBoundingClientRect().bottom))) + 40`);
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

  /* ---------- 内部 ---------- */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  await go('/customer-progress');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('订单行数:', await ev("document.querySelectorAll('.list .row').length"));
  console.log('首行:', await ev(`(()=>{const r=document.querySelector('.list .row');return r?r.innerText.replace(/\\n/g,' | '):'（空）'})()`));
  await shot('01-内部-订单与发布状态');

  // 点裁片外发那张（找含「裁片外发」的行）
  await ev(`(()=>{const r=[...document.querySelectorAll('.list .row')].find(x=>x.innerText.includes('裁片外发'));if(r){r.click();return true}return false})()`);
  await sleep(1800);
  console.log('详情标题:', await ev("document.querySelector('.detail .panel-head b')?.textContent"));
  console.log('内部阶段:', await ev(`JSON.stringify([...document.querySelectorAll('.stage')].map(s=>s.innerText.replace(/\\n/g,' ').trim()))`));
  console.log('阻塞项:', await ev(`JSON.stringify([...document.querySelectorAll('.blk li')].map(x=>x.innerText))`));
  console.log('客户预览:', await ev(`JSON.stringify([...document.querySelectorAll('.pv-step')].map(s=>s.innerText.replace(/\\n/g,' ').trim()))`));
  console.log('完工标签:', await ev("document.querySelector('.pv-head .tag.green')?.textContent || '（不显示）'"));
  console.log('隐藏说明:', await ev("document.querySelector('.hide-box')?.innerText?.replace(/\\n/g,' / ')"));
  console.log('版本行数:', await ev("document.querySelectorAll('.detail table.data tbody tr').length"));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('02-内部-裁片外发未回货不说完工');

  // 找一张可完工的
  await ev(`(()=>{const r=[...document.querySelectorAll('.list .row')].find(x=>x.innerText.includes('可完工'));if(r){r.click();return true}return false})()`);
  await sleep(1800);
  console.log('\n可完工页的完工标签:', await ev("document.querySelector('.pv-head .tag.green')?.textContent || '（不显示）'"));
  await shot('03-内部-可完工');

  // 整单外发（只改路线未发布）：看客户预览是否只有三个阶段
  await ev(`(()=>{const r=[...document.querySelectorAll('.list .row')].find(x=>x.innerText.includes('整单外发'));if(r){r.click();return true}return false})()`);
  await sleep(1800);
  console.log('整单外发预览阶段:', await ev(`JSON.stringify([...document.querySelectorAll('.pv-step')].map(s=>s.innerText.replace(/\\n/g,' ').trim()))`));
  console.log('整单外发发布状态:', await ev("document.querySelector('.pv-head .tag.gray')?.textContent || '—'"));
  await shot('03b-内部-整单外发只三阶段');

  /* ---------- 客户 ---------- */
  if (ml.ok) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'localStorage.setItem("mall_token","' + ml.data.token + '");localStorage.setItem("mall_user",' + JSON.stringify(JSON.stringify(ml.data.user || ml.data.account || {})) + ');'
    });
    await go('/mall');
    await sleep(2500);
    // 切到订单页
    // 标签文案是「我的订单」，不是「订单」（按精确等值找会找不到）
    await ev(`(()=>{const b=[...document.querySelectorAll('.ml-tabs button')].find(x=>x.textContent.includes('订单'));if(b){b.click();return true}return false})()`);
    await sleep(2000);
    console.log('\n客户订单行数:', await ev("document.querySelectorAll('.ml-row').length"));
    console.log('带进度的行:', await ev(`JSON.stringify([...document.querySelectorAll('.ml-row')].filter(r=>r.querySelector('.ml-mini')).map(r=>r.innerText.replace(/\\n/g,' | ')))`));
    await shot('04-客户-订单列表带进度');

    // 打开带进度的那一单
    await ev(`(()=>{const r=[...document.querySelectorAll('.ml-row')].find(x=>x.querySelector('.ml-mini'));if(r){r.click();return true}return false})()`);
    await sleep(2200);
    console.log('客户弹窗标题:', await ev("document.querySelector('.ml-modal h3')?.textContent"));
    console.log('客户看到阶段:', await ev(`JSON.stringify([...document.querySelectorAll('.ml-step')].map(s=>s.innerText.replace(/\\n/g,' ').trim()))`));
    console.log('客户看到完工标签:', await ev("document.querySelector('.ml-done-lg')?.textContent || '（不显示）'"));
    console.log('客户看到页内是否含工厂/成本:', await ev("/factory|加工费|返工|成本/i.test(document.querySelector('.ml-modal')?.innerText||'') ? '❌ 有' : '✅ 没有'"));
    await shot('05-客户-订单进度');

    await shot('06-客户-移动端', 414);
  }

  proc.kill();
  process.exit(0);
})();
