/**
 * 档案中心 + 图片粘贴 验收截图
 * 用法：node scripts/shot-archive.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/archive');
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

  const port = 9800 + Math.floor(Math.random() * 150);
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

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
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
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
    if (r && r.exceptionDetails) console.error('  JS 异常:', JSON.stringify(r.exceptionDetails.text).slice(0, 200));
    return r && r.result ? r.result.value : null;
  };
  const nav = async (url, wait = 3600) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };

  // 1. 供应商档案
  await nav('/suppliers');
  await shot('01-供应商档案');

  // 2. 工序类别
  await nav('/craft-types');
  await shot('02-工序类别');

  // 3. 档案菜单展开
  await nav('/customers');
  const openMenu = `(async () => {
    const heads = [...document.querySelectorAll('.nav-group-head, .group-head, .nav-item')];
    const h = heads.find(x => x.textContent.includes('档案'));
    if (h) { h.click(); await new Promise(r => setTimeout(r, 500)); return 'clicked'; }
    return 'no-menu';
  })()`;
  console.log('展开档案菜单:', await evalJs(openMenu));
  await shot('03-档案菜单');

  // 4. 客户档案编辑（图片位）
  const openEdit = `(async () => {
    const b = [...document.querySelectorAll('.link-btn')].find(x => x.textContent.trim() === '编辑');
    if (!b) return 'no-btn';
    b.click();
    await new Promise(r => setTimeout(r, 900));
    return 'ok';
  })()`;
  console.log('打开客户编辑:', await evalJs(openEdit));
  await shot('04-客户档案-图片位');

  // 5. 模拟 Ctrl+V 粘贴一张图片（构造 ClipboardEvent）
  const pasteJs = `(async () => {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = '#2b6de5'; g.fillRect(0, 0, 160, 160);
    g.fillStyle = '#fff'; g.font = 'bold 22px sans-serif';
    g.fillText('PASTE', 26, 76);
    g.font = '14px sans-serif';
    g.fillText('Ctrl+V OK', 30, 106);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'paste-test.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    await new Promise(r => setTimeout(r, 2600));
    const img = document.querySelector('.modal .img-up img');
    return img ? ('已粘贴：' + img.src.slice(0, 60)) : '未命中粘贴目标';
  })()`;
  console.log('模拟粘贴:', await evalJs(pasteJs));
  await shot('05-粘贴后-图片已填入');

  ws.close();
  proc.kill();
  console.log('完成 →', OUT);
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
