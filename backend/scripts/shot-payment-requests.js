/**
 * 付款申请单 · 截图与文本取证
 * 用法：node scripts/shot-payment-requests.js
 *
 * 取证一律 dump textContent，不靠肉眼看图（宽度不够时表格会被压窄，肉眼读不出数字对不对）。
 */
const fs = require('fs');
const { db } = require('../src/db');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/payment-requests');
const PORT = 9857;
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
  const clickText = async (sel, txt) => ev(`(()=>{
    const el=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes('${txt}'));
    if(!el) return 'not-found';
    el.click(); return 'clicked';
  })()`);

  // ================= 1. 列表 =================
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await go('/payment-requests');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('侧栏:', await ev("!!document.querySelector('.erp-sidebar')"));
  console.log('指标卡:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('表头:', await ev(`JSON.stringify([...document.querySelectorAll('table.data thead th')].map(th=>th.innerText.trim()))`));
  console.log('行数:', await ev('document.querySelectorAll("table.data tbody tr").length'));
  console.log('各行:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-申请单列表');

  // ================= 2. 新建（挑发票） =================
  await clickText('.head-ops .btn', '新建付款申请');
  await sleep(1200);
  console.log('新建弹窗:', await ev("document.querySelector('.modal-head h3')?.textContent"));
  console.log('蓝条:', await ev(`(()=>{const b=document.querySelector('.modal .banner');return b?b.innerText.replace(/\\n/g,' ').slice(0,90):'（无）'})()`));
  // 选一个供应商
  const supPicked = await ev(`(()=>{
    const s=document.querySelector('.modal .frow select');
    if(!s) return 'no-select';
    const opt=[...s.options].find(o=>o.value);
    if(!opt) return 'no-option';
    s.value=opt.value; s.dispatchEvent(new Event('change'));
    return opt.textContent.trim();
  })()`);
  console.log('选供应商:', supPicked);
  await sleep(1800);
  console.log('候选表头:', await ev(`JSON.stringify([...document.querySelectorAll('.modal table.data thead th')].map(th=>th.innerText.trim()))`));
  console.log('候选行数:', await ev('document.querySelectorAll(".modal table.data tbody tr").length'));
  console.log('候选首行:', await ev(`(()=>{const tr=document.querySelector('.modal table.data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  // 勾前两张
  await ev(`(()=>{const cbs=[...document.querySelectorAll('.modal table.data tbody input[type=checkbox]')].filter(c=>!c.disabled).slice(0,2);cbs.forEach(c=>{if(!c.checked)c.click()});return cbs.length})()`);
  await sleep(600);
  console.log('合计条:', await ev(`(()=>{const s=document.querySelector('.sum-bar');return s?s.innerText.replace(/\\n/g,' '):'（无）'})()`));
  await shotFixed('02-新建挑发票', 1440, 1000);
  await ev(`(()=>{const b=document.querySelector('.modal-head .x');if(b)b.click();return true})()`);
  await sleep(700);

  // ================= 3. 详情（已付款那张，信息最全） =================
  const paidRow = await ev(`(()=>{
    const tr=[...document.querySelectorAll('table.data tbody tr')].find(r=>r.innerText.includes('已付款'));
    if(!tr) return 'no-paid';
    const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('明细'));
    if(!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  console.log('打开已付款详情:', paidRow);
  await sleep(1600);
  console.log('详情标题:', await ev("document.querySelector('.modal-head h3')?.innerText"));
  console.log('详情数字:', await ev(`JSON.stringify([...document.querySelectorAll('.modal .dgrid > div')].map(d=>d.innerText.replace(/\\n/g,':')))`));
  console.log('审批步骤:', await ev(`JSON.stringify([...document.querySelectorAll('.step')].map(s=>s.innerText.replace(/\\n/g,' / ')))`));
  console.log('明细表行数:', await ev('document.querySelectorAll(".modal .sec table.data tbody tr").length'));
  await shotFixed('03-详情与审批进度', 1440, 1060);
  await ev(`(()=>{const b=document.querySelector('.modal-head .x');if(b)b.click();return true})()`);
  await sleep(700);

  // ================= 4. 执行付款弹窗 =================
  const payClick = await ev(`(()=>{
    const tr=[...document.querySelectorAll('table.data tbody tr')].find(r=>r.innerText.includes('待付款'));
    if(!tr) return 'no-approved';
    const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('执行付款'));
    if(!b) return 'no-pay-btn';
    b.click(); return 'clicked';
  })()`);
  console.log('打开执行付款:', payClick);
  await sleep(1200);
  console.log('付款弹窗:', await ev("document.querySelector('.modal-head h3')?.textContent"));
  console.log('付款提示:', await ev(`(()=>{const b=document.querySelector('.modal .banner');return b?b.innerText.replace(/\\n/g,' ').slice(0,110):'（无）'})()`));
  console.log('未选账户时按钮:', await ev(`(()=>{const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.includes('确认付款'));return b?'disabled='+b.disabled:'（无）'})()`));
  // 选一个账户，看按钮恢复可点（验证「没账户不许付」的前端拦截 + 选了就能付）
  // 认准那个「第一个选项是空占位」的下拉（账户），不是付款方式
  await ev(`(()=>{
    const s=[...document.querySelectorAll('.modal .select')].find(x=>x.options[0] && x.options[0].value==='');
    if(!s) return 'no-account-select';
    const o=[...s.options].find(x=>x.value);
    s.value=o.value; s.dispatchEvent(new Event('change'));
    return o.textContent.trim();
  })()`);
  await sleep(700);
  console.log('选账户后按钮:', await ev(`(()=>{const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.includes('确认付款'));return b?b.textContent.trim()+' disabled='+b.disabled:'（无）'})()`));
  await shotFixed('04-执行付款', 1440, 820);
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.includes('再想想'));if(b)b.click();return true})()`);
  await sleep(600);

  // ================= 5. 应付台账的「付款流程中」列 =================
  await go('/payable');
  console.log('台账表头:', await ev(`JSON.stringify([...document.querySelectorAll('table.data thead th')].map(th=>th.innerText.trim()))`));
  console.log('台账首行各列:', await ev(`(()=>{const tr=document.querySelector('table.data tbody tr');return tr?JSON.stringify([...tr.children].map((td,i)=>i+':'+td.innerText.replace(/\\n/g,' '))):'（空）'})()`));
  await shot('05-应付台账流程中');

  // ================= 6. 移动端 =================
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await go('/payment-requests');
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  console.log('移动端卡片数:', await ev('document.querySelectorAll(".stat-card").length'));
  await shot('06-移动端', 414);

  proc.kill();
  process.exit(0);
})();
