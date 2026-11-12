/**
 * 扎标 / 扫码 / 扎号报工 截图与链路验证
 * 用法：node scripts/shot-labels.js [orderId]
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/labels');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { db } = require('../src/db');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const H = { Authorization: 'Bearer ' + lg.data.token };

  // 挑扎最多的订单
  const best = db.prepare(
    `SELECT c.order_id AS id, COUNT(b.id) n FROM cut_orders c JOIN cut_bundles b ON b.cut_order_id = c.id
      GROUP BY c.order_id ORDER BY n DESC LIMIT 1`
  ).get();
  const orderId = Number(process.argv[2]) || (best && best.id);
  const order = (await (await fetch(`${BASE}/api/orders/${orderId}`, { headers: H })).json()).data;
  const lb = (await (await fetch(`${BASE}/api/labels/bundles/${orderId}`, { headers: H })).json()).data;
  const one = lb.bundles[0];
  console.log('订单', order.order_no, '| 扎', lb.bundles.length, '| 首扎', one.bundle_no, one.code);

  const port = 9774;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1100,1400', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 80 && !t; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* ignore */ }
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (mm, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 140);
    return r.result ? r.result.value : null;
  };
  const vp = async (w, h, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const go = async (p, wait = 5200) => { await send('Page.navigate', { url: BASE + p }); await sleep(wait); };

  // 1. 扎标（中档）
  await vp(1100, 1400);
  await go('/labels/' + orderId);
  console.log('扎标张数', await ev('document.querySelectorAll(".lb-bundle").length'),
    '| QR 图', await ev('document.querySelectorAll(".lb-b-qr").length'),
    '| 分页', await ev('document.querySelectorAll(".lb-sheet").length'));
  console.log('QR 前缀', await ev('(()=>{const i=document.querySelector(".lb-b-qr");return i?i.src.slice(0,22):""})()'));
  await shot('01-扎标-中档');

  // 2. 大档
  await ev(`(()=>{const s=document.querySelector('.lb-sel');s.value='big';s.dispatchEvent(new Event('change'));return true})()`);
  await sleep(1500);
  console.log('大档张数', await ev('document.querySelectorAll(".lb-bundle").length'), '| 分页', await ev('document.querySelectorAll(".lb-sheet").length'));
  await shot('02-扎标-大档');

  // 3. 款色码标
  await ev(`(()=>{const b=[...document.querySelectorAll('.lb-seg button')].find(x=>x.textContent.includes('款色码'));if(b){b.click();return true}return false})()`);
  await sleep(1800);
  console.log('款色码张数', await ev('document.querySelectorAll(".lb-sku").length'),
    '| 条码 SVG 数', await ev('document.querySelectorAll(".lb-barcode rect").length'));
  await shot('03-款色码标');

  // 4. 扫码页（扫扎标）
  await vp(414, 896, true);
  await go('/s/' + one.code, 4200);
  console.log('扫码页扎号', await ev('(()=>{const e=document.querySelector(".sg-bundle-no");return e?e.textContent.trim():""})()'));
  console.log('扫码页订单', await ev('(()=>{const e=document.querySelector(".sg-no");return e?e.textContent.trim():""})()'));
  console.log('横向溢出', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('04-扫码看到扎');

  // 5. 扎号对不上的提示
  await go('/s/' + order.order_no + '-B999', 3800);
  console.log('错扎提示', await ev('(()=>{const e=document.querySelector(".sg-missing");return e?e.textContent.trim().slice(0,40):"（无）"})()'));
  await shot('05-扎号对不上');

  // 6. 手机报工带扎号（真提交再清场）
  const before = db.prepare('SELECT COUNT(*) c FROM production_reports WHERE order_id = ?').get(orderId).c;
  await go(`/m/report?no=${order.order_no}&bundle=${one.bundle_no}`, 5200);
  console.log('报工页扎号 chip', await ev('(()=>{const e=document.querySelector(".mr-bundle-chip");return e?e.textContent.trim():""})()'));
  await shot('06-报工带扎号');
  await ev(`(()=>{const b=document.querySelector('.mr-node');if(b){b.click();return true}return false})()`);
  await sleep(900);
  await ev(`(()=>{const n=document.querySelectorAll('.mr-num');if(n[0]){n[0].value=2;n[0].dispatchEvent(new Event('input',{bubbles:true}))}return true})()`);
  await ev(`(()=>{const b=[...document.querySelectorAll('.mr-submit')].find(x=>x.textContent.includes('提交'));if(b){b.click();return true}return false})()`);
  await sleep(3600);
  const after = db.prepare('SELECT id, node_name, qty_ok, bundle_no FROM production_reports WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId);
  console.log('报工', before, '->', db.prepare('SELECT COUNT(*) c FROM production_reports WHERE order_id = ?').get(orderId).c, JSON.stringify(after));
  if (after && after.bundle_no === one.bundle_no) {
    db.prepare('DELETE FROM production_reports WHERE id = ?').run(after.id);
    console.log('清场：删除测试报工', after.id);
  } else {
    console.log('⚠ 扎号没写进报工记录');
  }

  proc.kill();
  process.exit(0);
})();
