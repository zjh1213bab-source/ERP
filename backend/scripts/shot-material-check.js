/**
 * 面辅料平铺勾选 验收截图
 * 用法：node scripts/shot-material-check.js
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

  const port = 9432;
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--remote-debugging-port=' + port, '--window-size=1600,1250', '--force-device-scale-factor=1', 'about:blank'],
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1250, deviceScaleFactor: 1, mobile: false });
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

  // 1. 打版流程 · 面辅料确认
  await send('Page.navigate', { url: BASE + '/pattern-board' });
  await sleep(3400);
  const o1 = await evalJs(`(async () => {
    const cols = [...document.querySelectorAll('.pcol')];
    const col = cols.find(c => c.querySelector('.pcol-head') && c.querySelector('.pcol-head').textContent.includes('面辅料确认'));
    const card = col && col.querySelector('.pcard');
    if (!card) return 'no-card';
    card.click();
    await new Promise(r => setTimeout(r, 1800));
    return 'ok';
  })()`);
  console.log('打版流程 material:', o1);
  await shot('06-打版流程-面辅料确认');

  // 2. 点「＋ 添加面料」打开档案选择器
  const pick = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.mat-head .btn')].find(x => x.textContent.includes('添加面料'));
    if (!b) return 'no-btn';
    b.click();
    await new Promise(r => setTimeout(r, 1600));
    return 'opened';
  })()`);
  console.log('打开选择器:', pick);
  await shot('07-物料清单-添加面辅料');
  await evalJs(`(async () => { const x = document.querySelector('.picker .x'); if (x) x.click(); await new Promise(r=>setTimeout(r,500)); return 'x'; })()`);
  await evalJs(`(async () => { const b = document.querySelector('.modal-foot .btn-ghost'); if (b) b.click(); await new Promise(r=>setTimeout(r,500)); return 'x'; })()`);

  // 3. 开发单详情 · 面辅料页签
  await send('Page.navigate', { url: BASE + '/development' });
  await sleep(3200);
  const o2 = await evalJs(`(async () => {
    const cards = [...document.querySelectorAll('.dev-card, .kcard')];
    const c = cards[0];
    if (!c) return 'no-card';
    const btn = [...c.querySelectorAll('.link-btn')].find(b => b.textContent.includes('详情'));
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise(r => setTimeout(r, 1800));
    const tabs = [...document.querySelectorAll('.tp-tabs button, .tp-tab')];
    const mat = tabs.find(t => t.textContent.includes('面辅料'));
    if (mat) mat.click();
    await new Promise(r => setTimeout(r, 1200));
    return 'tabs:' + tabs.map(t=>t.textContent.trim()).join('/');
  })()`);
  console.log('开发单:', o2);
  await shot('08-开发单-面辅料页签');

  ws.close(); proc.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
