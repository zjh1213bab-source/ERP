/**
 * 订单跟踪左侧款图 + 订单速览（打版信息）· 截图与文本取证
 * 用法：node scripts/shot-orderpeek.js
 *
 * 截三张：
 *   01 看板（左侧带款图缩略图，无图的显示款式首字占位）
 *   02 点订单号 → 速览弹窗（款图 + 基本信息 + 工序进度 + 打版信息）
 *   03 同样弹窗，但在打版信息填得最全的那张单上
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { db } = require('../src/db');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/orderpeek');
const PORT = 9966;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 挑打版信息填得最全的一张单（面料+辅料+工艺+客户要求都有的）
  // 四项都要有内容才算「填得全」：只按总长度排会挑到「工艺+要求很长但面料空」的那种，
  // 截出来四格里三格是「—」，证明不了什么
  const rich = db.prepare(`
    SELECT o.order_no, o.status, tp.id AS tp_id,
           LENGTH(IFNULL(tp.fabric_info,'')) + LENGTH(IFNULL(tp.accessory_info,''))
           + LENGTH(IFNULL(tp.craft_info,'')) + LENGTH(IFNULL(tp.customer_req,'')) AS score
      FROM tech_packs tp JOIN orders o ON o.id = tp.order_id
     WHERE IFNULL(tp.fabric_info,'') <> '' AND IFNULL(tp.accessory_info,'') <> ''
       AND IFNULL(tp.craft_info,'') <> '' AND IFNULL(tp.customer_req,'') <> ''
     ORDER BY score DESC LIMIT 1`).get();
  console.log('打版信息最全的单:', rich ? `${rich.order_no}（${rich.status}）` : '无');

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
    await sleep(650);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  await send('Page.navigate', { url: BASE + '/order-tracking' });
  await sleep(5000);

  console.log('\n缩略图数量:', await ev("document.querySelectorAll('.trk-thumb').length"));
  console.log('有真图的:', await ev("document.querySelectorAll('.trk-thumb img').length"));
  console.log('首字占位:', await ev(`JSON.stringify([...document.querySelectorAll('.trk-ph')].slice(0,4).map(x=>x.textContent.trim()))`));
  console.log('真图 src:', await ev(`JSON.stringify([...document.querySelectorAll('.trk-thumb img')].map(x=>x.getAttribute('src')))`));
  await shot('01-看板带款图', 1600, 820);

  // ---------- 点第一行订单号 ----------
  const first = await ev(`(()=>{const a=document.querySelector('.trk-table tbody tr .trk-order a');if(!a)return 'no-a';const no=a.textContent.trim();a.click();return no})()`);
  console.log('\n点开订单:', first);
  await sleep(2500);
  console.log('弹窗标题:', await ev("document.querySelector('.pk-modal .modal-head h3')?.textContent"));
  console.log('款图区:', await ev("document.querySelector('.pk-pic')?.className"));
  console.log('基本信息:', await ev(`(()=>{const g=document.querySelector('.pk-kv');return g?g.innerText.replace(/\\n/g,' | '):'无'})()`));
  console.log('打版区标题:', await ev(`(()=>{const s=[...document.querySelectorAll('.pk-sec')].find(x=>x.textContent.includes('打版'));return s?s.innerText.replace(/\\n/g,' '):'无'})()`));
  console.log('打版内容:', await ev(`(()=>{const g=document.querySelectorAll('.pk-kv')[1];return g?g.innerText.replace(/\\n/g,' | ').slice(0,220):'（没有打版信息）'})()`));
  await shot('02-订单速览', 1600, 900);
  await ev("document.querySelector('.pk-modal .x')?.click()");
  await sleep(600);

  // ---------- 换到打版信息最全的那张单 ----------
  if (rich) {
    // 看板默认只看在产；切到该单所在状态
    const changed = await ev(`(()=>{const s=[...document.querySelectorAll('.toolbar select')][1];if(!s)return 'no-select';
      const want='${rich.status}';if(![...s.options].some(o=>o.value===want))return 'no-option';
      s.value=want;s.dispatchEvent(new Event('change'));return want})()`);
    console.log('\n切换状态筛选:', changed);
    await sleep(2500);
    const opened = await ev(`(()=>{const rows=[...document.querySelectorAll('.trk-table tbody tr')];
      const row=rows.find(r=>r.innerText.includes('${rich.order_no}'));if(!row)return 'no-row';
      const a=row.querySelector('.trk-order a');if(!a)return 'no-a';a.click();return true})()`);
    console.log('点开目标单:', opened);
    await sleep(2800);
    console.log('标题:', await ev("document.querySelector('.pk-modal .modal-head h3')?.textContent"));
    console.log('打版内容:', await ev(`(()=>{const g=document.querySelectorAll('.pk-kv')[1];return g?g.innerText.replace(/\\n/g,' | ').slice(0,300):'（没有打版信息）'})()`));
    console.log('面辅料表行数:', await ev("document.querySelectorAll('.pk-tbl')[0]?.querySelectorAll('tbody tr').length || 0"));
    console.log('尺码表行数:', await ev("document.querySelectorAll('.pk-tbl')[1]?.querySelectorAll('tbody tr').length || 0"));
    console.log('文本块:', await ev(`JSON.stringify([...document.querySelectorAll('.pk-txt-grid > div')].map(x=>x.innerText.replace(/\\n/g,':').slice(0,40)))`));
    await shot('03-速览含打版信息', 1600, 980);
  }

  console.log('\n前端异常:', errors.length ? errors.join(' | ') : '无');
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
