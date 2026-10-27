/**
 * 截图：返工报废与生产结单
 *   node scripts/shot-rework-close.js
 * 只读截图（点开弹窗但不提交），不改演示数据。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/rework-close');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

  const port = 9579;
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1250, deviceScaleFactor: 1, mobile: false });
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

  await send('Page.navigate', { url: BASE + '/production-close' });
  await sleep(4000);
  console.log('返工行数:', await evalJs('document.querySelectorAll("tbody tr").length'));
  await shot('01-返工报废单-四种状态');

  // 复验弹窗
  const rv = await evalJs(`(async () => {
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('RW202610270004'));
    if (!tr) return 'no-row';
    [...tr.querySelectorAll('.link-btn')].find(b => b.textContent.includes('复验')).click();
    await new Promise(r => setTimeout(r, 1500));
    return document.querySelector('.radio-list') ? 'opened' : 'no-modal';
  })()`);
  console.log('复验弹窗:', rv);
  await shot('02-复验-通过与不通过');

  await evalJs('document.querySelectorAll(".modal-mask .x").forEach(x => x.click())');
  await sleep(600);

  // 新建返工单
  await evalJs(`(async () => {
    [...document.querySelectorAll('.head-ops button')].find(b => b.textContent.includes('返工/报废单')).click();
    await new Promise(r => setTimeout(r, 1200));
    const sel = document.querySelector('.modal-mask select');
    if (sel) {
      const opt = [...sel.options].find(o => o.textContent.includes('SO202610260005'));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); }
    }
    await new Promise(r => setTimeout(r, 1200));
  })()`);
  await shot('03-新建返工单-工序与损失');

  await evalJs('document.querySelectorAll(".modal-mask .x").forEach(x => x.click())');
  await sleep(600);

  // 结单页签
  await evalJs(`[...document.querySelectorAll('.tabs button')].find(b => b.textContent.includes('生产结单')).click()`);
  await sleep(2000);
  await shot('04-生产结单列表-可结与受限');

  // 结单检查弹窗（受限的订单 5）
  const g = await evalJs(`(async () => {
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('SO202610260005'));
    if (!tr) return 'no-row';
    [...tr.querySelectorAll('.link-btn')].find(b => b.textContent.includes('检查')).click();
    await new Promise(r => setTimeout(r, 1800));
    return document.querySelector('.chk-grid') ? 'opened' : 'no-modal';
  })()`);
  console.log('结单检查:', g);
  await shot('05-结单检查-硬阻塞与软提示');

  ws.close();
  proc.kill();
  console.log('完成');
})();
