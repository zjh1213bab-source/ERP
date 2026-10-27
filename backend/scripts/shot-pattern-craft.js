/**
 * 打版流程：图片 + 工序表 验收截图
 * 用法：node scripts/shot-pattern-craft.js
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

  const port = 9481;
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--remote-debugging-port=' + port, '--window-size=1600,1350', '--force-device-scale-factor=1', 'about:blank'],
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
  let id = 0; const pend = new Map(); const dialogs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.type + ': ' + m.params.message.replace(/\s+/g, ' ').slice(0, 100)); send('Page.handleJavaScriptDialog', { accept: true }); }
  };
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1350, deviceScaleFactor: 1, mobile: false });
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

  const opened = await evalJs(`(async () => {
    const cols = [...document.querySelectorAll('.pcol')];
    const col = cols.find(c => c.querySelector('.pcol-head') && c.querySelector('.pcol-head').textContent.includes('工艺/工序明细'));
    const card = col && col.querySelector('.pcard');
    if (!card) return 'no-card';
    card.click();
    await new Promise(r => setTimeout(r, 1800));
    const order = [...document.querySelectorAll('.modal-body > *')].map(e => e.className.split(' ')[0] || e.tagName).filter(Boolean);
    return '弹窗区块顺序: ' + order.join(' → ');
  })()`);
  console.log('打开:', opened);

  // 常用工序标签数量
  const tags = await evalJs(`(() => {
    const g = document.querySelectorAll('.op')[0];
    if (!g) return 'no-op';
    return '常用工序 ' + g.querySelectorAll('.op-tag').length + ' 个；表格行 ' + g.querySelectorAll('.op-tbl tbody tr').length;
  })()`);
  console.log('工序表:', tags);

  const rowsInfo = await evalJs(`(() => {
    const gs = [...document.querySelectorAll('.op')];
    return gs.map(g => {
      const rows = [...g.querySelectorAll('.op-tbl tbody tr')].filter(r => r.querySelectorAll('td').length > 1);
      return g.querySelector('.op-head strong').textContent.trim() + ' ' + rows.length + ' 行';
    }).join(' | ');
  })()`);
  console.log('工序表内容:', rowsInfo);

  await shot('16-工序表与图片');

  // 展开全局资料再截一张
  await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.gp-head .link-btn')].find(x => x.textContent.includes('展开'));
    if (b) b.click();
    await new Promise(r => setTimeout(r, 500));
    return 'ok';
  })()`);
  await shot('17-全局资料展开');

  ws.close(); proc.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
