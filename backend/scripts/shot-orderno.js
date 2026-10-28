/**
 * 订单号手填 · 截图与文本取证
 * 用法：node scripts/shot-orderno.js
 *
 * 截三张：下单表单（订单号必填）、改号弹窗（影响面）、移动端下单表单。
 * 只点「检查影响」，**绝不点「确认改号」** —— 否则会把演示数据改掉。
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { db } = require('../src/db');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/orderno');
const PORT = 9916;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 挑一张「有下游单据、且状态允许改号」的订单来演示影响面
  const pick = db.prepare(`SELECT o.id, o.order_no, o.status,
      (SELECT COUNT(*) FROM schedule_tasks WHERE order_id = o.id) st,
      (SELECT COUNT(*) FROM material_issues WHERE order_id = o.id) mi
    FROM orders o
    WHERE o.status IN ('draft','tech','finance','assigned')
      AND ((SELECT COUNT(*) FROM schedule_tasks WHERE order_id = o.id) > 0
        OR (SELECT COUNT(*) FROM material_issues WHERE order_id = o.id) > 0)
    ORDER BY o.id DESC LIMIT 1`).get();
  console.log('演示订单:', pick ? `${pick.order_no}（#${pick.id}，排产 ${pick.st} / 领料 ${pick.mi}）` : '没找到');

  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS })
  })).json();

  const profile = pathMod.join(os.tmpdir(), 'erp-shot-' + PORT);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1440,1200', 'about:blank'], { stdio: 'ignore' });

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
  const shot = async (name, w = 1440, height = null) => {
    if (w < 500) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1200, deviceScaleFactor: 2, mobile: true });
      await sleep(700);
    }
    const h = height || 1050;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(700);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };
  const go = async (url, wait = 6000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };
  const clickText = async (sel, text) => ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  // ---------- 1. 下单表单：订单号必填 ----------
  await go('/orders');
  await clickText('.head-ops button, .page-head button', '新建订单');
  await sleep(1500);
  console.log('\n下单弹窗标题:', await ev("document.querySelector('.modal-head h3, .modal-head b')?.textContent"));
  console.log('订单号字段:', await ev(`(()=>{const f=[...document.querySelectorAll('.fitem')].find(x=>x.innerText.includes('订单号'));return f?f.innerText.replace(/\\n/g,' | '):'（没找到）'})()`));
  console.log('必填标记:', await ev("document.querySelector('.fitem .req')?.textContent"));
  await shot('01-下单必填订单号', 1440, 1000);

  // 不填直接提交 → 前端拦
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.includes('保存')||x.textContent.includes('创建')||x.textContent.includes('提交'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  await ev("document.querySelector('.modal .x')?.click()");
  await sleep(600);

  // ---------- 2. 改号弹窗：影响面 ----------
  if (pick) {
    await go(`/orders?q=${encodeURIComponent(pick.order_no)}`);
    await sleep(1200);
    const opened = await ev(`(()=>{const r=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.innerText.includes('${pick.order_no}'));if(!r)return 'no-row';const b=[...r.querySelectorAll('button')].find(x=>x.textContent.includes('查看'));if(!b)return 'no-btn';b.click();return true})()`);
    console.log('\n打开订单详情:', opened);
    await sleep(1800);
    const hasBtn = await ev(`(()=>{const b=[...document.querySelectorAll('.modal-head button')].find(x=>x.textContent.includes('改订单号'));if(b){b.click();return true}return false})()`);
    console.log('点改订单号:', hasBtn);
    await sleep(1200);
    // 输入一个新号并检查影响
    await ev(`(()=>{const i=[...document.querySelectorAll('.modal .input')].find(x=>x.placeholder&&x.placeholder.includes('新的订单号'));if(i){i.value='PO-CLIENT-2026-1028';i.dispatchEvent(new Event('input'));return true}return false})()`);
    await sleep(300);
    await clickText('.modal button', '检查影响');
    await sleep(2000);
    console.log('影响面:', await ev("document.querySelector('.ren-arrow')?.innerText?.replace(/\\n/g,' ')"));
    console.log('连带明细:', await ev(`JSON.stringify([...document.querySelectorAll('.ren-imp span')].map(x=>x.textContent.trim()))`));
    console.log('确认按钮状态:', await ev(`(()=>{const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.includes('确认改号'));return b?(b.disabled?'禁用':'可点'):'没有'})()`));
    await shot('02-改号影响面', 1440, 900);
  }

  // ---------- 3. 移动端下单表单 ----------
  await go('/orders');
  await clickText('.head-ops button, .page-head button', '新建订单');
  await sleep(1600);
  await shot('03-移动端下单', 414, 1200);
  console.log('移动端横向溢出:', await ev("document.documentElement.scrollWidth > document.documentElement.clientWidth + 2"));

  console.log('\n前端异常:', errors.length ? errors.join(' | ') : '无');
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
