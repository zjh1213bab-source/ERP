/**
 * 售后与对账资料 · 截图与文本取证
 * 用法：node scripts/shot-aftersale.js
 *
 * 取两个视角：
 *   1. 内部（admin）：售后清单 → 五条轨道 → 对账文件三态
 *   2. 客户（abc001）：商城「售后」tab + 对账文件下载
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/aftersale');
const PORT = 9902;
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
  await go('/after-sales');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('侧栏选中:', await ev("document.querySelector('.nav-item.on, .menu-item.on')?.textContent?.trim() || '（未识别）'"));
  console.log('KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('售后行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('首行:', await ev(`(()=>{const r=document.querySelector('table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-内部-售后清单');

  // 待受理那张（带照片）
  await ev(`(()=>{const r=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.innerText.includes('待受理'));if(r){r.querySelector('button').click();return true}return false})()`);
  await sleep(1600);
  console.log('\n详情标题:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('轨道:', await ev(`JSON.stringify([...document.querySelectorAll('.track')].map(x=>x.innerText.replace(/\\n/g,' / ').trim()))`));
  console.log('照片数:', await ev("document.querySelectorAll('.photos img').length"));
  console.log('动作区:', await ev("document.querySelector('.actions .col-h')?.textContent || '（无）'"));
  await shot('02-内部-详情五轨道待受理');

  // 处理中且逾期的（已实收未判定）
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(600);
  await ev(`(()=>{const r=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.innerText.includes('逾期'));if(r){r.querySelector('button').click();return true}return false})()`);
  await sleep(1600);
  console.log('\n逾期单标题:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('逾期单轨道:', await ev(`JSON.stringify([...document.querySelectorAll('.track')].map(x=>x.innerText.replace(/\\n/g,' / ').trim()))`));
  console.log('未结案原因:', await ev(`JSON.stringify([...document.querySelectorAll('.blockers li')].map(x=>x.innerText))`));
  await shot('03-内部-详情货到仓未判定');

  // 已结案那条
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(600);
  await ev(`(()=>{const sel=document.querySelector('select');if(sel){sel.value='';sel.dispatchEvent(new Event('change'));return true}return false})()`);
  await sleep(1500);
  await ev(`(()=>{const r=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.innerText.includes('已结案'));if(r){r.querySelector('button').click();return true}return false})()`);
  await sleep(1600);
  console.log('\n结案单轨道:', await ev(`JSON.stringify([...document.querySelectorAll('.track')].map(x=>x.innerText.replace(/\\n/g,' / ').trim()))`));
  console.log('结案结论:', await ev("document.querySelector('.done-box p')?.textContent"));
  await shot('04-内部-详情已结案含追偿');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(600);

  // 对账资料 tab
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('对账资料'));if(b){b.click();return true}return false})()`);
  await sleep(1800);
  console.log('\n对账文件行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('对账文件行:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].map(r=>r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / ')))`));
  await shot('05-内部-对账资料三态');

  /* ---------- 客户 ---------- */
  if (ml.ok) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'localStorage.setItem("mall_token","' + ml.data.token + '");localStorage.setItem("mall_user",' + JSON.stringify(JSON.stringify(ml.data.user || ml.data.account || {})) + ');'
    });
    await go('/mall');
    await sleep(2500);
    // 切到「售后」
    await ev(`(()=>{const b=[...document.querySelectorAll('.ml-tabs button')].find(x=>x.textContent.trim()==='售后');if(b){b.click();return true}return false})()`);
    await sleep(2000);
    console.log('\n客户售后行数:', await ev("document.querySelectorAll('.ml-after-row').length"));
    console.log('客户看到的售后:', await ev(`JSON.stringify([...document.querySelectorAll('.ml-after-row')].map(r=>r.innerText.replace(/\\n/g,' | ')))`));
    console.log('客户页是否含追偿/内部字段:', await ev("/追偿|内部|成本/i.test(document.body.innerText) ? '❌ 有' : '✅ 没有'"));
    await shot('06-客户-我的售后');

    // 打开提交表单
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('提新售后'));if(b){b.click();return true}return false})()`);
    await sleep(1500);
    console.log('表单可见:', await ev("!!document.querySelector('.ml-after-form')"));
    console.log('原因选项:', await ev(`JSON.stringify([...document.querySelectorAll('.ml-after-form select')].map(s=>[...s.options].length))`));
    await shot('07-客户-提售后表单');

    // 切到对账
    await ev(`(()=>{const b=[...document.querySelectorAll('.ml-tabs button')].find(x=>x.textContent.trim()==='对账');if(b){b.click();return true}return false})()`);
    await sleep(2200);
    console.log('\n客户对账文件行:', await ev(`JSON.stringify([...document.querySelectorAll('.ml-table')].map(t=>[...t.querySelectorAll('tbody tr')].map(r=>r.innerText.replace(/\\n/g,' | '))))`));
    await shot('08-客户-对账与下载');

    await shot('09-客户-移动端', 414);
  }

  proc.kill();
  process.exit(0);
})();
