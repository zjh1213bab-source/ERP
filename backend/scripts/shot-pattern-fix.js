/**
 * 打版流程交互修复验收截图
 * 用法：node scripts/shot-pattern-fix.js
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
  const token = login.data.token;

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
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  };
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1150, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });

  const shot = async (name, clip) => {
    const p = { format: 'png', captureBeyondViewport: true };
    if (clip) p.clip = { ...clip, scale: clip.scale || 1 };
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
  await shot('12-看板-流程条可点且已完成列有卡片');

  // 打开正在进行的一列
  const opened = await evalJs(`(async () => {
    const cols = [...document.querySelectorAll('.pcol')];
    const col = cols.find(c => c.querySelector('.pcol-head') && c.querySelector('.pcol-head').textContent.includes('车板做样衣') && c.querySelector('.pcard'));
    if (!col) return 'no-card';
    col.querySelector('.pcard').click();
    await new Promise(r => setTimeout(r, 1400));
    return 'ok';
  })()`);
  console.log('打开阶段弹窗:', opened);
  await shot('13-阶段弹窗-步骤条可切换');

  // 已完成卡片 → 只读记录
  await evalJs(`(async () => { const b = document.querySelector('.modal-foot .btn-ghost'); if (b) b.click(); return 'x'; })()`);
  await sleep(400);
  const doneOpen = await evalJs(`(async () => {
    const cols = [...document.querySelectorAll('.pcol')];
    const last = cols[cols.length - 1];
    const card = last.querySelector('.pcard.done');
    if (!card) return 'no-done';
    card.click();
    await new Promise(r => setTimeout(r, 1400));
    return document.querySelector('.modal-head h3').textContent.trim().replace(/\\s+/g, ' ');
  })()`);
  console.log('打开已归档:', doneOpen);
  await shot('14-已归档-只读查看');

  ws.close(); proc.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
