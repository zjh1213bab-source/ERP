/**
 * 往来账页面验收截图
 * 用法：node scripts/shot-finance.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/finance');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const token = login.data.token;

  const port = 9491;
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
  let id = 0; const pend = new Map(); const errs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); return; }
    if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
    if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails.text).slice(0, 140));
  };
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
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

  await send('Page.navigate', { url: BASE + '/finance' });
  await sleep(3400);

  const stats = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.stat')];
    return cards.map(c => c.querySelector('span').textContent.trim() + '=' + c.querySelector('strong').textContent.trim()).join(' | ')
      + ' || 应收行数 ' + document.querySelectorAll('tbody tr').length;
  })()`);
  console.log('指标:', stats);
  await shot('01-应收列表');

  await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.seg button')].find(x => x.textContent.trim() === '应付');
    if (b) b.click();
    await new Promise(r => setTimeout(r, 900));
    return 'ok';
  })()`);
  await shot('02-应付列表');

  await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.seg button')].find(x => x.textContent.trim() === '收付款');
    if (b) b.click();
    await new Promise(r => setTimeout(r, 900));
    return 'ok';
  })()`);
  await shot('03-收付款与核销明细');

  await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.seg button')].find(x => x.textContent.trim() === '账龄');
    if (b) b.click();
    await new Promise(r => setTimeout(r, 900));
    return 'ok';
  })()`);
  await shot('04-账龄分析');

  // 登记收款弹窗
  await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.page-head .btn')].find(x => x.textContent.includes('登记收款'));
    if (b) b.click();
    await new Promise(r => setTimeout(r, 1200));
    const sel = document.querySelector('.modal select');
    if (sel) {
      const opt = [...sel.options].find(o => o.value && o.value !== 'null');
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    await new Promise(r => setTimeout(r, 1200));
    return 'ok';
  })()`);
  await shot('05-登记收款-核销');

  console.log('JS 错误:', errs.length ? errs.join(' | ') : '无');
  ws.close(); proc.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
