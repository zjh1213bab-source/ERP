/**
 * 面辅料档案 / 选择器 / 开发单引用 截图（验收用）
 * 用法：node scripts/shot-materials.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/materials');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('未找到 Chrome'); process.exit(1); }

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const token = login.data.token;

  const port = 9700 + Math.floor(Math.random() * 200);
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--window-size=1600,1200', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) { /* wait */ }
  }
  if (!target) { proc.kill(); console.error('Chrome 未就绪'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
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
    if (r && r.exceptionDetails) console.error('  JS 异常:', r.exceptionDetails.text);
    return r && r.result ? r.result.value : null;
  };
  const nav = async (url, wait = 2600) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };

  // 1. 面辅料档案列表
  await nav('/materials');
  await shot('01-面辅料档案列表');

  // 2. 编辑弹窗（点第一行的编辑）
  const openEdit = `(async () => {
    const b = [...document.querySelectorAll('.mat-table .link-btn')].find(x => x.textContent.trim() === '编辑');
    if (!b) return 'no-btn';
    b.click();
    await new Promise(r => setTimeout(r, 700));
    return 'ok';
  })()`;
  console.log('打开编辑:', await evalJs(openEdit));
  await shot('02-面辅料档案编辑');

  // 3. 开发详情 → 面辅料页签（档案引用 + 锁标）
  await nav('/development');
  const openCard = `(async () => {
    const cards = [...document.querySelectorAll('.dev-card')];
    const c = cards.find(x => x.textContent.includes('SO202610260001') && x.textContent.includes('男士休闲长裤'));
    if (!c) return 'no-card';
    [...c.querySelectorAll('.link-btn')].find(b => b.textContent.trim() === '详情').click();
    await new Promise(r => setTimeout(r, 1600));
    const tab = [...document.querySelectorAll('.tp-tabs button')].find(x => x.textContent.includes('面辅料'));
    if (tab) tab.click();
    await new Promise(r => setTimeout(r, 700));
    return 'ok';
  })()`;
  console.log('打开开发单面辅料:', await evalJs(openCard));
  await shot('03-开发单-面辅料引用档案');

  // 4. 选择器
  const openPicker = `(async () => {
    const b = [...document.querySelectorAll('.tp-bar .btn')].find(x => x.textContent.includes('从档案选择'));
    if (!b) return 'no-btn';
    b.click();
    await new Promise(r => setTimeout(r, 1200));
    return 'ok';
  })()`;
  console.log('打开选择器:', await evalJs(openPicker));
  await shot('04-面辅料选择器');

  // 5. 工艺单（验证档案数据进打印）
  await nav('/print/techpack/2', 2800);
  await shot('05-工艺单-面辅料来自档案');

  ws.close();
  proc.kill();
  console.log('完成 →', OUT);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
