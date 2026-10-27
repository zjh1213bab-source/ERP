/**
 * 截图：接单评审与交期承诺
 *   node scripts/shot-commitments.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/commitments');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const token = login.data.token;

  const port = 9530;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1600,1200', 'about:blank'], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* retry */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('  JS异常', String(r.exceptionDetails.text).slice(0, 160));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT, name + '.png');
    if (s && s.data) fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    console.log('  截图 →', path.basename(file));
  };

  await send('Page.navigate', { url: BASE + '/commitments' });
  await sleep(3600);
  console.log('列表行数:', await evalJs('document.querySelectorAll("tbody tr").length'));
  await shot('01-接单评审看板');

  // 打开评审弹窗（找待评审的订单 004）
  const opened = await evalJs(`(async () => {
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('SO202610260004'));
    if (!tr) return 'no-row';
    const btn = [...tr.querySelectorAll('.link-btn')].find(b => b.textContent.includes('评审'));
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise(r => setTimeout(r, 1500));
    return document.querySelector('.cm-checks') ? 'opened' : 'no-modal';
  })()`);
  console.log('评审弹窗:', opened);
  await shot('02-评审弹窗-三项承接确认');

  // 关掉，打开时间轴（订单 005 有进度）
  const openedTl = await evalJs(`(async () => {
    const close = document.querySelector('.modal-head .x');
    if (close) close.click();
    await new Promise(r => setTimeout(r, 600));
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('SO202610260005'));
    if (!tr) return 'no-row';
    const btn = [...tr.querySelectorAll('.link-btn')].find(b => b.textContent.includes('时间轴'));
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise(r => setTimeout(r, 1500));
    return document.querySelector('.tl-tbl') ? 'opened' : 'no-modal';
  })()`);
  console.log('时间轴弹窗:', openedTl);
  await shot('03-交期时间轴-督办点');

  ws.close();
  proc.kill();
  console.log('完成');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
