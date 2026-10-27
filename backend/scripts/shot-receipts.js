/**
 * 截图：原料收货检验
 *   node scripts/shot-receipts.js
 * 只读截图，不改演示数据。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/receipts');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const token = login.data.token;

  const port = 9585;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1600,1250', 'about:blank'], { stdio: 'ignore' });
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
  const dialogs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message.slice(0, 80));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1250, deviceScaleFactor: 1, mobile: false });
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

  await send('Page.navigate', { url: BASE + '/receipts' });
  await sleep(3800);
  console.log('看板行数:', await evalJs('document.querySelectorAll("tbody tr").length'));
  await shot('01-收料看板-待检与冻结');

  // 部分合格那张：合格 + 冻结 + 退回 + 短收 同时可见
  const opened = await evalJs(`(async () => {
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('GRN202610270001'));
    if (!tr) return 'no-row';
    tr.querySelector('.link-btn').click();
    await new Promise(r => setTimeout(r, 2200));
    return document.querySelector('.grn-modal') ? 'opened' : 'no-modal';
  })()`);
  console.log('详情弹窗:', opened);
  await shot('02-收料详情-合格冻结退回与短收');

  // 待检那张：可以现场检验
  await evalJs('document.querySelector(".grn-modal .x").click()');
  await sleep(700);
  const opened2 = await evalJs(`(async () => {
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('GRN202610270003'));
    if (!tr) return 'no-row';
    tr.querySelector('.link-btn').click();
    await new Promise(r => setTimeout(r, 2000));
    const body = document.querySelector('.grn-modal .modal-body');
    if (body) body.scrollTop = body.scrollHeight;
    await new Promise(r => setTimeout(r, 600));
    return document.querySelector('.grn-modal') ? 'opened' : 'no-modal';
  })()`);
  console.log('待检详情:', opened2);
  await shot('03-待检单-来料检查');

  // 开收料单
  await evalJs('document.querySelector(".grn-modal .x").click()');
  await sleep(600);
  const opened3 = await evalJs(`(async () => {
    const btn = [...document.querySelectorAll('.head-ops button')].find(b => b.textContent.includes('开收料单'));
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise(r => setTimeout(r, 1600));
    const sel = document.querySelector('.new-modal select');
    if (sel && sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change')); }
    await new Promise(r => setTimeout(r, 1600));
    return document.querySelector('.new-modal') ? 'opened' : 'no-modal';
  })()`);
  console.log('开单弹窗:', opened3, dialogs);
  await shot('04-开收料单-点收录卷缸');

  ws.close();
  proc.kill();
  console.log('完成');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
