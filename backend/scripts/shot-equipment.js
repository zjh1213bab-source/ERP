/**
 * 截图：设备停机与产能
 *   node scripts/shot-equipment.js
 * 只读截图（点开弹窗但不提交），不改演示数据。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/equipment');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

  const port = 9577;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1600,1300', 'about:blank'], { stdio: 'ignore' });
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
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1300, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + login.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('  JS异常', String(r.exceptionDetails.text).slice(0, 160));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (s && s.data) fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('  截图 →', name);
  };

  await send('Page.navigate', { url: BASE + '/equipment' });
  await sleep(4000);
  console.log('台账行数:', await evalJs('document.querySelectorAll("tbody tr").length'));
  await shot('01-设备台账-停机状态');

  // 停机与维修
  await evalJs(`(async () => { [...document.querySelectorAll('.tabs button')].find(b => b.textContent.includes('停机与维修')).click(); await new Promise(r => setTimeout(r, 1800)); })()`);
  await shot('02-停机维修-五种状态');

  // 安全放行弹窗
  const sf = await evalJs(`(async () => {
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('DT202610270002'));
    if (!tr) return 'no-row';
    [...tr.querySelectorAll('.link-btn')].find(b => b.textContent.includes('安全放行')).click();
    await new Promise(r => setTimeout(r, 1400));
    const by = document.querySelector('.modal-mask input.input');
    if (by) { by.value = '张组长'; by.dispatchEvent(new Event('input')); }
    const note = document.querySelector('.modal-mask textarea');
    if (note) { note.value = '试机正常，防护罩复位，试缝 3 件合格'; note.dispatchEvent(new Event('input')); }
    await new Promise(r => setTimeout(r, 500));
    return document.querySelector('.radio-list') ? 'opened' : (document.querySelector('.modal-mask') ? 'opened2' : 'no-modal');
  })()`);
  console.log('安全放行弹窗:', sf);
  await shot('03-安全复核放行-人工确认');

  await evalJs('document.querySelectorAll(".modal-mask .x").forEach(x => x.click())');
  await sleep(600);

  // 产能日历
  await evalJs(`(async () => { [...document.querySelectorAll('.tabs button')].find(b => b.textContent.includes('产能日历')).click(); await new Promise(r => setTimeout(r, 2200)); })()`);
  await shot('04-产能日历-停机占用与影响订单');

  // 登记停机弹窗
  await evalJs(`(async () => {
    [...document.querySelectorAll('.head-ops button')].find(b => b.textContent.includes('登记停机')).click();
    await new Promise(r => setTimeout(r, 1300));
    const sel = document.querySelector('.modal-mask select');
    if (sel) {
      const opt = [...sel.options].find(o => o.textContent.includes('EQ003'));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); }
    }
    const reason = document.querySelector('.modal-mask input.input');
    if (reason) { reason.value = '断针频繁，针板有毛刺'; reason.dispatchEvent(new Event('input')); }
    await new Promise(r => setTimeout(r, 600));
  })()`);
  await shot('05-登记停机-受影响排程');

  ws.close();
  proc.kill();
  console.log('完成');
})();
