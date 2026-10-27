/**
 * 面辅料档案「编辑跳页 + 新增选基础」验收截图
 * 用法：node scripts/shot-material-edit.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/materials');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const token = login.data.token;

  const port = 9442;
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
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('  截图', name);
  };
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) console.error('  JS 异常:', String(r.exceptionDetails.text).slice(0, 160));
    return r && r.result ? r.result.value : null;
  };

  // 1. 档案列表（新增按钮已改名）
  await send('Page.navigate', { url: BASE + '/materials' });
  await sleep(3200);
  await shot('09-档案列表-新增面辅料');

  // 2. 新增弹窗（从档案选基础）
  await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.page-head .btn')].find(x => x.textContent.includes('新增面辅料'));
    if (b) b.click();
    await new Promise(r => setTimeout(r, 1600));
    return 'ok';
  })()`);
  await shot('10-新增-从档案选基础');

  // 3. 选一条 → 新建页
  await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.picker-table tbody .ops .link-btn')].find(x => x.textContent.includes('用作基础'));
    if (b) b.click();
    await new Promise(r => setTimeout(r, 2200));
    return 'ok';
  })()`);
  await shot('11-新建页-带出档案资料');

  // 4. 编辑页
  await send('Page.navigate', { url: BASE + '/materials' });
  await sleep(3000);
  const edit = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('tbody .link-btn')].find(x => x.textContent.trim() === '编辑');
    if (!b) return 'no-btn';
    b.click();
    await new Promise(r => setTimeout(r, 2200));
    return location.pathname;
  })()`);
  console.log('编辑页:', edit);
  await shot('12-编辑页-独立页面');

  ws.close(); proc.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
