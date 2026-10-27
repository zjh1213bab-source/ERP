/**
 * 截图：客户子账号与授权（P1 / TS-N21-03 / 04 / 08）
 *   node scripts/shot-customer-authz.js
 * 只读截图，不改演示数据。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/customer-authz');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const staff = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

  const port = 9601;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1680,1200', 'about:blank'], { stdio: 'ignore' });
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1200, deviceScaleFactor: 1, mobile: false });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('  JS异常', String(r.exceptionDetails.text).slice(0, 200));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT, name + '.png');
    if (s && s.data) fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    console.log('  截图 →', path.basename(file));
  };

  /* ---------- ERP 侧：客户账号与授权 ---------- */
  const erpScript = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + staff.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(staff.data.user)) + ');'
  });
  await send('Page.navigate', { url: BASE + '/mall-admin' });
  await sleep(3600);
  const toAccounts = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('客户账号'));
    if (!b) return 'no-tab';
    b.click(); await new Promise(t => setTimeout(t, 2000));
    return document.querySelectorAll('tbody tr').length;
  })()`);
  console.log('账号行数:', toAccounts);
  await shot('01-ERP客户账号-权限与上限');

  const approve = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.link-btn')].find(x => x.textContent.includes('批准上限'));
    if (!b) return 'no-btn';
    b.click(); await new Promise(t => setTimeout(t, 1600));
    return document.querySelector('.perm-grid') ? 'opened' : 'no-modal';
  })()`);
  console.log('批准上限弹窗:', approve, dialogs);
  await shot('02-批准权限上限');
  await evalJs('document.querySelector(".modal .x").click()');
  await sleep(600);

  const audit = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('授权审计'));
    if (!b) return 'no-btn';
    b.click(); await new Promise(t => setTimeout(t, 1800));
    return document.querySelectorAll('.modal tbody tr').length;
  })()`);
  console.log('审计条数:', audit);
  await shot('03-授权审计只读留痕');

  // 移除注入脚本，否则每次导航都会把 mall_token 重置回主账号
  if (erpScript && erpScript.identifier) {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: erpScript.identifier });
  }

  /* ---------- 客户侧：成员管理 ---------- */
  const custLogin = async (u, p) => (await (await fetch(BASE + '/api/mall/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p })
  })).json());

  const owner = await custLogin('abc001', 'abc123456');
  await send('Page.navigate', { url: BASE + '/mall/login' });
  await sleep(1200);
  await evalJs(`localStorage.setItem("mall_token","${owner.data.token}");localStorage.setItem("mall_user",${JSON.stringify(JSON.stringify(owner.data.account))});`);
  await send('Page.navigate', { url: BASE + '/mall?as=owner' });
  await sleep(3800);
  const toMembers = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.ml-tabs button')].find(x => x.textContent.includes('成员'));
    if (!b) return 'no-tab:' + [...document.querySelectorAll('.ml-tabs button')].map(x => x.textContent.trim()).join('/');
    b.click(); await new Promise(t => setTimeout(t, 2200));
    return document.querySelectorAll('.ml-table tbody tr').length;
  })()`);
  console.log('成员页:', toMembers);
  await shot('04-客户主账号-成员与权限');

  /* ---------- 客户侧：财务子账号看对账 ---------- */
  const fin = await custLogin('abcfin01', 'fin123456');
  await evalJs(`localStorage.setItem("mall_token","${fin.data.token}");localStorage.setItem("mall_user",${JSON.stringify(JSON.stringify(fin.data.account))});`);
  await send('Page.navigate', { url: BASE + '/mall?as=fin' });
  await sleep(3800);
  const toFin = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.ml-tabs button')].find(x => x.textContent.includes('对账'));
    if (!b) return 'no-tab:' + [...document.querySelectorAll('.ml-tabs button')].map(x => x.textContent.trim()).join('/');
    b.click(); await new Promise(t => setTimeout(t, 2000));
    return document.querySelectorAll('.ml-table tbody tr').length;
  })()`);
  console.log('财务子号对账:', toFin);
  await shot('05-财务子账号-对账');

  /* ---------- 客户侧：订单子账号看订单（金额不可见） ---------- */
  const ord = await custLogin('def_orders', 'def123456');
  await evalJs(`localStorage.setItem("mall_token","${ord.data.token}");localStorage.setItem("mall_user",${JSON.stringify(JSON.stringify(ord.data.account))});`);
  await send('Page.navigate', { url: BASE + '/mall?as=ord' });
  await sleep(3800);
  const toOrd = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.ml-tabs button')].find(x => x.textContent.includes('我的订单'));
    if (!b) return 'no-tab';
    b.click(); await new Promise(t => setTimeout(t, 2000));
    return document.querySelectorAll('.ml-list .ml-row').length;
  })()`);
  console.log('订单子号订单:', toOrd, '| 标签:', await evalJs('[...document.querySelectorAll(".ml-tabs button")].map(x=>x.textContent.trim()).join("/")'));
  await shot('06-订单子账号-金额不可见');

  ws.close();
  proc.kill();
  console.log('完成');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
