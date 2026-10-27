/**
 * 打版流程 / 样衣管理 验收截图
 * 用法：node scripts/shot-pattern.js
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

  const port = 9400;
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--remote-debugging-port=' + port, '--window-size=1600,1150', '--force-device-scale-factor=1', 'about:blank'],
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
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); } };
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });

  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1150, deviceScaleFactor: 1, mobile: false });
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
  const nav = async (url, wait = 3200) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };

  // 1. 打版流程看板
  await nav('/pattern-board');
  await shot('01-打版流程看板');

  // 2. 打开某一阶段的填写弹窗（制版列的第一张卡）
  const openCard = `(async () => {
    const cols = [...document.querySelectorAll('.pcol')];
    const col = cols.find(c => c.textContent.includes('面辅料确认'));
    if (!col) return 'no-col';
    const card = col.querySelector('.pcard');
    if (!card) return 'no-card';
    card.click();
    await new Promise(r => setTimeout(r, 900));
    return 'ok';
  })()`;
  console.log('打开阶段弹窗:', await evalJs(openCard));
  await shot('02-面辅料确认-物料清单');

  // 2.1 打开面辅料选择器
  const openPicker = `(async () => {
    const b = [...document.querySelectorAll('.mat-head .btn')].find(x => x.textContent.includes('选择面料'));
    if (!b) return 'no-btn';
    b.click();
    await new Promise(r => setTimeout(r, 1200));
    return 'ok';
  })()`;
  console.log('打开选择器:', await evalJs(openPicker));
  await shot('02b-面辅料选择器');

  // 3. 样衣管理列表
  await nav('/sample-archive');
  await shot('03-样衣管理列表');

  // 4. 样衣详情（快照）
  const openDetail = `(async () => {
    const b = [...document.querySelectorAll('.link-btn')].find(x => x.textContent.trim() === '查看');
    if (!b) return 'no-btn';
    b.click();
    await new Promise(r => setTimeout(r, 1400));
    return 'ok';
  })()`;
  console.log('打开样衣详情:', await evalJs(openDetail));
  await shot('04-样衣详情-锁定快照');

  // 5. 变更审核页签
  await nav('/sample-archive');
  const openChanges = `(async () => {
    const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.includes('变更审核'));
    if (!b) return 'no-btn';
    b.click();
    await new Promise(r => setTimeout(r, 1200));
    return 'ok';
  })()`;
  console.log('切换到变更审核:', await evalJs(openChanges));
  await shot('05-变更审核');

  ws.close(); proc.kill();
  console.log('完成 →', OUT);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
