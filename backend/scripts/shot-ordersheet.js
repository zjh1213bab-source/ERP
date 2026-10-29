/**
 * 订单信息收集看板 + 打印字段勾选 · 截图与文本取证
 * 用法：node scripts/shot-ordersheet.js
 *
 * 截五张：
 *   01 看板（上方四张卡，超期可点）
 *   02 点「超期订单」→ 列表只剩超期单
 *   03 点订单号 → 信息看板（下单 + 打版合并）
 *   04 打印字段勾选
 *   05 打印页（A4，按勾选字段出纸）
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { db } = require('../src/db');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/ordersheet');
const PORT = 9976;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 挑一张打版信息填得最全、且在产的单来演示「信息看板」
  const rich = db.prepare(`
    SELECT o.id, o.order_no, o.status,
           LENGTH(IFNULL(tp.fabric_info,'')) + LENGTH(IFNULL(tp.accessory_info,''))
           + LENGTH(IFNULL(tp.craft_info,'')) + LENGTH(IFNULL(tp.customer_req,'')) AS score
      FROM orders o JOIN tech_packs tp ON tp.order_id = o.id
     WHERE o.status IN ('assigned','production','instock')
       AND IFNULL(tp.fabric_info,'') <> ''
     ORDER BY score DESC LIMIT 1`).get();
  const fallback = db.prepare("SELECT id, order_no FROM orders WHERE status IN ('assigned','production','instock') ORDER BY id LIMIT 1").get();
  const pick = rich || fallback;
  console.log('演示订单:', pick ? `${pick.order_no}（#${pick.id}）` : '无');

  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS })
  })).json();
  if (!lg.data || !lg.data.token) { console.log('登录失败'); process.exit(1); }

  const profile = pathMod.join(os.tmpdir(), 'erp-shot-' + PORT);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1600,1200'], { stdio: 'ignore' });

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
      console.log('⚠ 弹窗:', m.params.message.slice(0, 160));
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
  const shot = async (name, w = 1600, h = 900) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const nav = async (url, wait = 5000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  // ---------- 01 看板：四张卡 ----------
  await nav('/order-tracking');
  console.log('\n卡片:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(x=>x.innerText.replace(/\\n/g,' | ')))`));
  console.log('列表行数:', await ev("document.querySelectorAll('.trk-table tbody tr').length"));
  await shot('01-看板统计卡', 1600, 760);

  // ---------- 02 点超期卡 ----------
  const clicked = await ev(`(()=>{const c=[...document.querySelectorAll('.stat-card')].find(x=>x.innerText.includes('超期订单'));if(!c)return 'no-card';c.click();return true})()`);
  console.log('\n点超期卡:', clicked);
  await sleep(2500);
  console.log('筛选后行数:', await ev("document.querySelectorAll('.trk-table tbody tr').length"));
  console.log('卡片选中态:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(x=>x.classList.contains('on')?'ON':'-'))`));
  console.log('行内容:', await ev(`JSON.stringify([...document.querySelectorAll('.trk-table tbody tr .trk-fixed')].map(x=>x.innerText.replace(/\\n/g,' / ').slice(0,70)))`));
  await shot('02-超期联动筛选', 1600, 700);

  // ---------- 03 信息看板 ----------
  await nav('/order-tracking');
  await sleep(1500);
  const opened = await ev(`(()=>{const rows=[...document.querySelectorAll('.trk-table tbody tr')];
    const row=rows.find(r=>r.innerText.includes('${pick.order_no}')); if(!row) return 'no-row';
    const a=row.querySelector('.trk-order a'); if(!a) return 'no-a'; a.click(); return true})()`);
  console.log('\n点开订单:', opened);
  await sleep(2600);
  console.log('弹窗标题:', await ev("document.querySelector('.pk-modal .modal-head h3')?.innerText?.replace(/\\n/g,' ')"));
  console.log('分组:', await ev(`JSON.stringify([...document.querySelectorAll('.pk-sec')].map(x=>x.innerText.replace(/\\n/g,' ').slice(0,42)))`));
  console.log('字段格数:', await ev("document.querySelectorAll('.pk-cell').length"));
  console.log('有值格数:', await ev("document.querySelectorAll('.pk-cell:not(.blank)').length"));
  console.log('明细表:', await ev("document.querySelectorAll('.pk-tbl').length"));
  await shot('03-信息收集看板', 1600, 980);

  // ---------- 04 打印勾选 ----------
  const popen = await ev(`(()=>{const b=[...document.querySelectorAll('.modal-foot button')].find(x=>x.textContent.includes('打印纸质订单'));if(!b)return 'no-btn';b.click();return true})()`);
  console.log('\n打开打印勾选:', popen);
  await sleep(900);
  console.log('勾选组数:', await ev("document.querySelectorAll('.pr-grp').length"));
  console.log('可选字段数:', await ev("document.querySelectorAll('.pr-field').length"));
  console.log('默认已勾:', await ev("document.querySelectorAll('.pr-field input:checked').length"));
  // 去掉一个组，验证勾选生效
  await ev(`(()=>{const g=[...document.querySelectorAll('.pr-grp')].find(x=>x.textContent.includes('工序进度'));
    if(!g)return 'no-grp';const cb=g.querySelector('.pr-grp-head input');if(cb&&cb.checked)cb.click();return true})()`);
  await sleep(500);
  console.log('去掉工序后已勾:', await ev("document.querySelectorAll('.pr-field input:checked').length"));
  console.log('按钮文案:', await ev(`(()=>{const b=[...document.querySelectorAll('.modal-foot button')].find(x=>x.textContent.includes('打印'));return b?b.textContent.trim():'?'})()`));
  await shot('04-打印字段勾选', 1600, 860);

  // ---------- 05 打印页 ----------
  const fields = await ev(`JSON.stringify([...document.querySelectorAll('.pr-field input:checked')].map(x=>x.value))`);
  await ev("document.querySelectorAll('.modal .x')[1]?.click()");
  await sleep(400);
  const fq = encodeURIComponent(JSON.parse(fields).join(','));
  await nav(`/print/order-sheet/${pick.id}?fields=${fq}`, 4000);
  console.log('\n打印页标题:', await ev("document.querySelector('.osp-head h1')?.textContent"));
  console.log('打印节数:', await ev("document.querySelectorAll('.osp-sec').length"));
  console.log('打印小节:', await ev(`JSON.stringify([...document.querySelectorAll('.osp-sec h2')].map(x=>x.textContent))`));
  console.log('字段行数:', await ev("document.querySelectorAll('.osp-kv tr').length"));
  console.log('有没有「—」:', await ev("document.body.innerText.includes('—')"));
  await shot('05-打印页', 900, 1100);

  console.log('\n前端异常:', errors.length ? errors.join(' | ') : '无');
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
