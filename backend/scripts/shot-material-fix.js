/**
 * 成份可编辑 + 图片位粘贴选中态 验收截图
 * 用法：node scripts/shot-material-fix.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/pattern');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

  const port = 9421;
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--remote-debugging-port=' + port, '--window-size=1600,1150', '--force-device-scale-factor=1', 'about:blank'],
    { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) {}
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); } };
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1150, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + login.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });

  const shot = async (name, clip) => {
    const p = { format: 'png', captureBeyondViewport: !clip };
    if (clip) p.clip = clip;
    const s = await send('Page.captureScreenshot', p);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('  截图', name);
  };
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) console.error('  JS 异常:', String(r.exceptionDetails.text).slice(0, 160));
    return r && r.result ? r.result.value : null;
  };

  // 1. 打版流程 → 面辅料确认
  await send('Page.navigate', { url: BASE + '/pattern-board' });
  await sleep(3400);
  console.log('打开弹窗:', await evalJs(`(async () => {
    const col = [...document.querySelectorAll('.pcol')].find(c => c.textContent.includes('面辅料确认'));
    const card = col && col.querySelector('.pcard');
    if (!card) return 'no-card';
    card.click();
    await new Promise(r => setTimeout(r, 1600));
    return 'ok';
  })()`));
  await shot('06-成份列可编辑');

  // 1.1 点击第二行色卡图 → 应进入选中态（不弹文件框）
  console.log('点击色卡图:', await evalJs(`(async () => {
    const rows = [...document.querySelectorAll('.mat-tbl tbody tr')];
    const ups = [...rows[1].querySelectorAll('.img-up')];
    ups[1].click();
    await new Promise(r => setTimeout(r, 500));
    return ups[1].className;
  })()`));

  // 局部放大：截取物料表区域，看清楚成份列与选中态
  const box = JSON.parse(await evalJs(`(() => {
    const tb = document.querySelector('.mat-tbl');
    const b = tb.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(b.x) - 4, y: Math.round(b.y) - 4, w: Math.min(1420, Math.round(b.width) + 8), h: 230 });
  })()`));
  await shot('07-成份与图片选中态-放大', { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1.5 });

  // 滚到表格最右，看物料图 / 色卡图的选中态
  await evalJs(`(() => { const s = document.querySelector('.mat-scroll'); if (s) s.scrollLeft = s.scrollWidth; return 'ok'; })()`);
  await sleep(500);
  const box2 = JSON.parse(await evalJs(`(() => {
    const s = document.querySelector('.mat-scroll');
    const b = s.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(b.x), y: Math.round(b.y) - 4, w: Math.round(b.width), h: 230 });
  })()`));
  await shot('09-图片位选中态', { x: box2.x, y: box2.y, width: box2.w, height: box2.h, scale: 1.6 });

  // 2. 开发详情里的面辅料页签
  await send('Page.navigate', { url: BASE + '/development' });
  await sleep(3200);
  console.log('打开开发详情:', await evalJs(`(async () => {
    const cards = [...document.querySelectorAll('.dev-card')];
    const c = cards.find(x => x.textContent.includes('SO202610260001') && x.textContent.includes('男士休闲长裤'));
    if (!c) return 'no-card';
    [...c.querySelectorAll('.link-btn')].find(b => b.textContent.trim() === '详情').click();
    await new Promise(r => setTimeout(r, 1600));
    const tab = [...document.querySelectorAll('.tp-tabs button')].find(x => x.textContent.includes('面辅料'));
    if (tab) tab.click();
    await new Promise(r => setTimeout(r, 800));
    return 'ok';
  })()`));
  await shot('08-开发单-成份列可编辑');

  ws.close(); proc.kill();
  console.log('完成 →', OUT);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
