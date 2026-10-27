/**
 * 截图：财务往来账（美金口径）+ 成本与毛利
 *   node scripts/shot-costing.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/costing');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const token = login.data.token;

  const port = 9510;
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
  const nav = async (route, wait = 3400) => {
    await send('Page.navigate', { url: BASE + route });
    await sleep(wait);
  };
  const shot = async (name, clip) => {
    const params = { format: 'png', captureBeyondViewport: !clip };
    if (clip) params.clip = { ...clip, scale: clip.scale || 1 };
    const s = await send('Page.captureScreenshot', params);
    const file = path.join(OUT, name + '.png');
    if (s && s.data) fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    console.log('  截图 →', path.basename(file));
  };

  // 1. 往来账（美金口径）
  await nav('/finance');
  await shot('01-往来账-美金应收');

  // 2. 成本与毛利列表
  await nav('/costing');
  console.log('列表行数:', await evalJs('document.querySelectorAll("tbody tr").length'));
  await shot('02-成本与毛利-订单列表');

  // 3. 打开明细
  const opened = await evalJs(`(async () => {
    const btn = [...document.querySelectorAll('.ops .link-btn')].find(b => b.textContent.trim() === '明细');
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise(r => setTimeout(r, 1600));
    return document.querySelector('.cx-modal') ? 'opened' : 'no-modal';
  })()`);
  console.log('明细弹窗:', opened);
  await shot('03-成本明细-自动归集与已售结转');

  // 4. 追加后补运费后的弹窗（如果还没加过）
  const added = await evalJs(`(async () => {
    const has = [...document.querySelectorAll('.cx-tbl tbody tr')].some(tr => tr.textContent.includes('后补到仓'));
    return has ? 'already' : 'none';
  })()`);
  console.log('后补费用:', added);

  ws.close();
  proc.kill();
  console.log('完成');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
