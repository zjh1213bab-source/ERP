/**
 * 开发详情 / 工艺单 / 生产总单 截图（验收用）
 * 用法：node scripts/shot-techpack.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/techpack');
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

  const port = 9600 + Math.floor(Math.random() * 300);
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

  // 1. 开发管理列表
  await nav('/development');
  await shot('01-开发管理列表');

  // 2~5. 打开「男士休闲长裤」开发单，逐个页签截图
  const openCard = `(async () => {
    const cards = [...document.querySelectorAll('.dev-card')];
    const c = cards.find(x => x.textContent.includes('SO202610260001') && x.textContent.includes('男士休闲长裤'));
    if (!c) return 'no-card';
    const btn = [...c.querySelectorAll('.link-btn')].find(b => b.textContent.trim() === '详情');
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise(r => setTimeout(r, 1800));
    return 'opened';
  })()`;
  console.log('打开详情:', await evalJs(openCard));
  await sleep(600);
  await shot('02-开发详情-概览与客户要求');

  const clickTab = (label) => `(async () => {
    const b = [...document.querySelectorAll('.tp-tabs button')].find(x => x.textContent.includes('${label}'));
    if (!b) return 'no-tab';
    b.click();
    await new Promise(r => setTimeout(r, 700));
    return 'ok';
  })()`;

  console.log('面辅料:', await evalJs(clickTab('面辅料')));
  await shot('03-开发详情-面辅料明细');

  console.log('成衣尺寸:', await evalJs(clickTab('成衣尺寸')));
  await shot('04-开发详情-成衣尺寸');

  console.log('生产要求:', await evalJs(clickTab('生产要求')));
  await shot('05-开发详情-生产要求');

  // 6. 工艺单打印页
  await nav('/print/techpack/16', 2800);
  await shot('06-打印-工艺单');

  // 7. 生产总单（订单 1，会自动带上开发单的客户要求/面辅料/尺寸/要求）
  await nav('/print/production/1', 2800);
  await shot('07-打印-生产总单');

  ws.close();
  proc.kill();
  console.log('完成 →', OUT);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
