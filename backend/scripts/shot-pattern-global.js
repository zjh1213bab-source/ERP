/**
 * 打版流程「全局资料」验收截图
 * 用法：node scripts/shot-pattern-global.js
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

  const port = 9471;
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

  await send('Page.navigate', { url: BASE + '/pattern-board' });
  await sleep(3400);

  // 打开「工艺/工序明细」阶段的卡片
  const open = await evalJs(`(async () => {
    const cols = [...document.querySelectorAll('.pcol')];
    const col = cols.find(c => c.querySelector('.pcol-head') && c.querySelector('.pcol-head').textContent.includes('工艺/工序明细'));
    const card = col && col.querySelector('.pcard');
    if (!card) return 'no-card';
    card.click();
    await new Promise(r => setTimeout(r, 1800));
    const gp = document.querySelector('.gp');
    const matRows = document.querySelectorAll('.gp-tbl tbody tr').length;
    const stageCards = [...document.querySelectorAll('.gp-stage')].map(c => c.querySelector('strong').textContent.trim() + '(' + c.querySelectorAll('.gp-kv').length + '项)');
    return (gp ? '有全局资料' : '没有') + ' | 面辅料 ' + matRows + ' 行 | 阶段卡 ' + stageCards.join(' ');
  })()`);
  console.log('打开阶段:', open);

  await shot('15-全局资料-工艺阶段');
  ws.close(); proc.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
