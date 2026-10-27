/**
 * 图片预览 + 色号列宽 验收截图
 * 用法：node scripts/shot-image-view.js
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

  const port = 9431;
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--remote-debugging-port=' + port, '--window-size=1600,1100', '--force-device-scale-factor=1', 'about:blank'],
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
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

  // 滚到表格右端看色号之后的列与图片
  await evalJs(`(() => { const s = document.querySelector('.mat-scroll'); if (s) s.scrollLeft = 260; return 'ok'; })()`);
  await sleep(400);
  await shot('10-色号列加宽');

  // 点第一行的物料图 → 预览
  console.log('点击物料图:', await evalJs(`(async () => {
    const rows = [...document.querySelectorAll('.mat-tbl tbody tr')];
    const ups = [...rows[0].querySelectorAll('.img-up')];
    const withImg = ups.find(u => u.querySelector('img'));
    if (!withImg) return 'no-img';
    withImg.click();
    await new Promise(r => setTimeout(r, 900));
    return 'opened';
  })()`));
  await shot('11-图片预览大图');

  // 关闭预览
  console.log('关闭预览:', await evalJs(`(async () => {
    const b = document.querySelector('.iv-btn.close');
    if (b) { b.click(); await new Promise(r => setTimeout(r, 400)); return 'closed'; }
    return 'no-close-btn';
  })()`));

  ws.close(); proc.kill();
  console.log('完成 →', OUT);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
