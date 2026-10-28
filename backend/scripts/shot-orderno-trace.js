/**
 * 订单号反查 · 截图与文本取证
 * 用法：node scripts/shot-orderno-trace.js
 *
 * 截四张：
 *   01 订单页点「号反查」→ 查到号 + 链上单据清单
 *   02 敲错一位 → 相近号提示
 *   03 采购页新建 → 「查这个号」
 *   04 移动端反查弹窗
 *
 * 判定一律读 textContent / 样式，不看截图猜（截图只作证据）。
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { db } = require('../src/db');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/orderno-trace');
const PORT = 9926;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 挑一张下游单据最多的订单：反查的价值要「看得出挂着什么」才显出来
  const pick = db.prepare(`SELECT o.id, o.order_no,
      (SELECT COUNT(*) FROM purchase_orders WHERE order_id = o.id)
      + (SELECT COUNT(*) FROM schedule_tasks WHERE order_id = o.id)
      + (SELECT COUNT(*) FROM material_issues WHERE order_id = o.id)
      + (SELECT COUNT(*) FROM cut_orders WHERE order_id = o.id) AS n
    FROM orders o ORDER BY n DESC LIMIT 1`).get();
  console.log('演示订单:', pick ? `${pick.order_no}（#${pick.id}，下游 ${pick.n} 条）` : '没找到');
  if (!pick) process.exit(1);
  // 敲错一位：把尾字符替换成另一个数字/字母，保证系统里没有这个号
  const tail = pick.order_no.slice(-1);
  const alt = /[0-9]/.test(tail) ? String((Number(tail) + 1) % 10) : 'Z';
  let typo = pick.order_no.slice(0, -1) + alt;
  if (db.prepare('SELECT 1 FROM orders WHERE order_no = ?').get(typo)) typo = pick.order_no + 'X';
  console.log('敲错一位的号:', typo);

  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS })
  })).json();
  if (!lg.data || !lg.data.token) { console.log('登录失败:', JSON.stringify(lg).slice(0, 200)); process.exit(1); }

  // Chrome profile 必须每次清：不清会命中旧 dist 的缓存，截到的是上一版界面
  const profile = pathMod.join(os.tmpdir(), 'erp-shot-' + PORT);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1440,1200'], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 80 && !t; i += 1) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) { t = await r.json(); break; }
    } catch (e) { /* ignore */ }
  }
  if (!t) { console.log('连不上调试端口'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      console.log('⚠ 弹窗:', m.params.message.slice(0, 160).replace(/\n/g, ' / '));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.text).slice(0, 200));
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
  const shot = async (name, w = 1440, h = 900) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(650);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name);
    if (w < 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await sleep(250); }
  };
  const go = async (url, wait = 5000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };
  const clickText = (sel, text) => ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.trim().includes('${text}'));if(b){b.click();return true}return false})()`);

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // ---------- 1. 订单页 → 号反查 ----------
  await go('/orders');
  console.log('\n工具栏按钮:', await ev(`JSON.stringify([...document.querySelectorAll('.toolbar button')].map(x=>x.textContent.trim()))`));
  console.log('点号反查:', await clickText('.toolbar button', '号反查'));
  await sleep(900);
  // 搜索框留空时**不预填**（不替用户挑单），所以这里敲一个真实号再看结果
  await ev(`(()=>{const i=document.querySelector('.trc-bar input');if(!i)return 'no-input';i.value='${pick.order_no}';i.dispatchEvent(new Event('input'));return true})()`);
  await sleep(1600);
  console.log('输入框里的号:', await ev("document.querySelector('.trc-bar input')?.value"));
  console.log('弹窗标题:', await ev("document.querySelector('.trc-modal .modal-head h3')?.textContent"));
  console.log('预填号:', await ev("document.querySelector('.trc-bar input')?.value"));
  console.log('命中提示:', await ev("document.querySelector('.trc-flag')?.innerText?.replace(/\\n/g,' | ')"));
  console.log('摘要:', await ev(`(()=>{const g=document.querySelector('.trc-grid');return g?[...g.querySelectorAll('div')].map(d=>d.innerText.replace(/\\n/g,':')).join(' | '):'无'})()`));
  console.log('链上清单:', await ev(`JSON.stringify([...document.querySelectorAll('.trc-tbl tbody tr')].map(r=>r.innerText.replace(/\\t/g,' / ')))`));
  await shot('01-反查命中', 1440, 820);

  // ---------- 2. 敲错一位 → 相近号 ----------
  await ev(`(()=>{const i=document.querySelector('.trc-bar input');i.value='${typo}';i.dispatchEvent(new Event('input'));return true})()`);
  await sleep(1400);
  console.log('\n错号提示:', await ev("document.querySelector('.trc-flag.miss')?.innerText?.replace(/\\n/g,' | ')"));
  console.log('相近号:', await ev(`JSON.stringify([...document.querySelectorAll('.trc-sim-item')].map(x=>x.innerText.replace(/\\n/g,' / ')))`));
  await shot('02-敲错一位给相近号', 1440, 820);

  // ---------- 3. 采购页「查这个号」 ----------
  await go('/purchases');
  console.log('\n采购工具栏:', await ev(`JSON.stringify([...document.querySelectorAll('.toolbar button')].map(x=>x.textContent.trim()))`));
  await clickText('.page-head button, .toolbar button', '新增采购单');
  await sleep(1500);
  console.log('表单里的查号按钮:', await ev(`(()=>{const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.includes('查这个号'));return b?(b.disabled?'存在-禁用':'存在-可点'):'没有'})()`));
  // 填一个真实订单号再点查
  await ev(`(()=>{const i=[...document.querySelectorAll('.modal .input')].find(x=>x.placeholder&&x.placeholder.includes('备货采购可不填'));if(!i)return 'no-input';i.value='${pick.order_no}';i.dispatchEvent(new Event('input'));return true})()`);
  await sleep(400);
  await clickText('.modal button', '查这个号');
  await sleep(1800);
  console.log('采购页反查结果:', await ev("document.querySelector('.trc-flag')?.innerText?.replace(/\\n/g,' | ')"));
  await shot('03-采购填号前先查', 1440, 900);

  // ---------- 4. 移动端 ----------
  await go('/orders');
  await clickText('.toolbar button', '号反查');
  await sleep(1200);
  await ev(`(()=>{const i=document.querySelector('.trc-bar input');if(!i)return 'no-input';i.value='${pick.order_no}';i.dispatchEvent(new Event('input'));return true})()`);
  await sleep(1700);
  console.log('\n移动端命中:', await ev("document.querySelector('.trc-flag')?.innerText?.replace(/\\n/g,' | ')"));
  console.log('移动端链上条数:', await ev("document.querySelectorAll('.trc-tbl tbody tr').length"));
  console.log('移动端横向溢出:', await ev("document.documentElement.scrollWidth > document.documentElement.clientWidth + 2"));
  await shot('04-移动端反查', 414, 860);

  console.log('\n前端异常:', errors.length ? errors.join(' | ') : '无');
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
