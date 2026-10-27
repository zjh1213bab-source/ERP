/**
 * 现场照片截图
 * 用法：node scripts/shot-photos.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/photos';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  if (!lg.ok) { console.log('登录失败', lg.message); process.exit(1); }
  const H = { Authorization: 'Bearer ' + lg.data.token };

  const pics = (await (await fetch(BASE + '/api/photos?limit=5', { headers: H })).json()).data;
  const target = pics.rows[0];
  console.log('首张照片', target && target.order_no, target && target.cat_label);

  const port = 9790;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1440,1100', 'about:blank'], { stdio: 'ignore' });
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
  const viewport = async (w, h, mobile = false) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const go = async (path, wait = 4200) => {
    await send('Page.navigate', { url: BASE + path });
    await sleep(wait);
  };

  // 1. 桌面照片墙
  await viewport(1440, 1100);
  await go('/photos');
  console.log('格子数', await ev('document.querySelectorAll(".cell").length'));
  console.log('指标', await ev('(()=>[...document.querySelectorAll(".stat-card")].map(c=>c.textContent.replace(/\\s+/g," ").trim()).join(" | "))()'));
  console.log('溢出', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-照片墙');

  // 2. 只看不良
  await ev(`(()=>{const b=[...document.querySelectorAll('.chip')].find(x=>x.textContent.includes('不良'));if(b){b.click();return true}return false})()`);
  await sleep(2600);
  console.log('不良筛选后格子', await ev('document.querySelectorAll(".cell").length'));
  await shot('02-只看不良');

  // 3. 大图
  await ev(`(()=>{const c=document.querySelector('.cell');if(c){c.click();return true}return false})()`);
  await sleep(1200);
  console.log('大图打开', await ev('!!document.querySelector(".viewer")'));
  await shot('03-照片大图');
  await ev(`(()=>{const b=document.querySelector('.viewer-close');if(b){b.click();return true}return false})()`);
  await sleep(500);

  // 4. 订单详情附件缩略图
  if (target && target.target_id) {
    await go('/orders?order=' + target.target_id, 6000);
    console.log('附件缩略图', await ev('document.querySelectorAll(".att-cell").length'));
    await ev(`(()=>{const g=document.querySelector('.att-grid');if(g){g.scrollIntoView({block:'center'});return true}return false})()`);
    await sleep(1200);
    await shot('04-订单附件缩略图');
  }

  // 5. 手机拍照页
  await viewport(414, 896, true);
  await go('/m/photo?order=' + (target ? target.target_id : ''), 4200);
  console.log('分类按钮', await ev('document.querySelectorAll(".mp-cat").length'));
  console.log('已上传缩略图', await ev('document.querySelectorAll(".mp-thumb").length'));
  console.log('横向溢出', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('05-手机拍照页');

  // 6. 手机拍照页：选不良（说明必填提示）
  await ev(`(()=>{const b=[...document.querySelectorAll('.mp-cat')].find(x=>x.textContent.includes('不良'));if(b){b.click();return true}return false})()`);
  await sleep(600);
  await shot('06-手机不良必填提示');

  // 7. 移动工作台（多了一个入口）
  await go('/m', 3600);
  console.log('工作台按钮', await ev('document.querySelectorAll(".mh-card").length'));
  await shot('07-移动工作台');

  // 8. 手机报工抽屉里带一张照片（把已有演示照片注入 file input，走真实压缩逻辑）
  if (target && target.order_no) {
    const path = require('path');
    const { db } = require('../src/db');
    const row = db.prepare("SELECT url FROM attachments WHERE cat = 'defect' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get();
    if (row) {
      const file = path.resolve(__dirname, '../data', String(row.url).replace(/^\/uploads\//, 'uploads/'));
      await go('/m/report?no=' + target.order_no, 5200);
      await ev(`(()=>{const b=document.querySelector('.mr-node');if(b){b.click();return true}return false})()`);
      await sleep(900);
      const doc = await send('DOM.getDocument', { depth: -1 });
      const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.mr-file' });
      if (q.nodeId && fs.existsSync(file)) {
        await send('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId });
        await sleep(2600);
        await ev(`(()=>{const n=document.querySelectorAll('.mr-num');if(n[0]){n[0].value=3;n[0].dispatchEvent(new Event('input',{bubbles:true}))}if(n[1]){n[1].value=2;n[1].dispatchEvent(new Event('input',{bubbles:true}))}return true})()`);
        await ev(`(()=>{const i=document.querySelector('.mr-input[placeholder*="备注"]');if(i){i.value='左袖口跳线 3 处';i.dispatchEvent(new Event('input',{bubbles:true}))}return true})()`);
        await sleep(600);
        console.log('报工抽屉缩略图', await ev('document.querySelectorAll(".mr-thumb").length'));
        await shot('08-手机报工带照片');
      }
    }
  }

  proc.kill();
  process.exit(0);
})();
