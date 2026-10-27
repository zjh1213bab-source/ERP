/**
 * 截图：供应商评价与备用产能
 *   node scripts/shot-supplier-eval.js
 * 只读截图（会点开弹窗但不提交），不改演示数据。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/supplier-eval');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

  const port = 9583;
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

  await send('Page.navigate', { url: BASE + '/supplier-eval' });
  await sleep(4000);
  console.log('评价行数:', await evalJs('document.querySelectorAll("tbody tr").length'));
  await shot('01-评价与排名-样本不足不排名');

  // 明细（历史评价 + 样本来源）
  const opened = await evalJs(`(async () => {
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('恒泰制衣厂'));
    if (!tr) return 'no-row';
    [...tr.querySelectorAll('.link-btn')].find(b => b.textContent.includes('明细')).click();
    await new Promise(r => setTimeout(r, 2200));
    return document.querySelector('.modal-mask') ? 'opened' : 'no-modal';
  })()`);
  console.log('明细弹窗:', opened);
  await shot('02-评价明细-样本来源可追');

  // 落资格弹窗
  await evalJs('document.querySelector(".modal-mask .x").click()');
  await sleep(700);
  const dec = await evalJs(`(async () => {
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('正邦布业'));
    if (!tr) return 'no-row';
    [...tr.querySelectorAll('.link-btn')].find(b => b.textContent.includes('落资格')).click();
    await new Promise(r => setTimeout(r, 1600));
    return document.querySelector('.dec-sum') ? 'opened' : 'no-modal';
  })()`);
  console.log('落资格弹窗:', dec);
  await shot('03-落供货资格-四种处置');

  await evalJs('document.querySelector(".modal-mask .x").click()');
  await sleep(600);

  // 供货资格
  await evalJs(`(async () => {
    [...document.querySelectorAll('.tabs button')].find(b => b.textContent.includes('供货资格')).click();
    await new Promise(r => setTimeout(r, 1800));
  })()`);
  await shot('04-供货资格-下单门禁依据');

  // 整改
  await evalJs(`(async () => {
    [...document.querySelectorAll('.tabs button')].find(b => b.textContent.includes('整改')).click();
    await new Promise(r => setTimeout(r, 1800));
  })()`);
  await shot('05-整改单-验证不通过即暂停');

  // 备用产能 + 选源
  await evalJs(`(async () => {
    [...document.querySelectorAll('.tabs button')].find(b => b.textContent.includes('备用产能')).click();
    await new Promise(r => setTimeout(r, 1600));
    const q = document.querySelector('input[placeholder="需求量"]');
    if (q) { q.value = '5000'; q.dispatchEvent(new Event('input')); }
    const sc = document.querySelector('input[placeholder^="范围"]');
    if (sc) { sc.value = '印花'; sc.dispatchEvent(new Event('input')); }
    await new Promise(r => setTimeout(r, 400));
    [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('备用选源')).click();
    await new Promise(r => setTimeout(r, 1600));
  })()`);
  await shot('06-备用产能-三项验证与不按最低价');

  // 备用验证弹窗
  const bak = await evalJs(`(async () => {
    const btns = [...document.querySelectorAll('tbody tr .link-btn')].filter(b => b.textContent.includes('验证'));
    if (!btns.length) return 'no-btn';
    btns[btns.length - 1].click();
    await new Promise(r => setTimeout(r, 1400));
    return document.querySelector('.radio-list') ? 'opened' : 'no-modal';
  })()`);
  console.log('备用验证弹窗:', bak);
  await shot('07-备用三项验证弹窗');

  // 采购下单：选暂停供应商，看红字门禁提示
  await evalJs('document.querySelectorAll(".modal-mask .x").forEach(x => x.click())');
  await sleep(600);
  await send('Page.navigate', { url: BASE + '/purchases' });
  await sleep(3600);
  const blocked = await evalJs(`(async () => {
    const btn = [...document.querySelectorAll('.page-head button, .head-ops button')].find(b => b.textContent.includes('新增采购') || b.textContent.includes('采购单'));
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 1500));
    const sel = document.querySelector('.modal-mask select');
    if (!sel) return 'no-select';
    const opt = [...sel.options].find(o => o.textContent.includes('恒泰'));
    if (!opt) return 'no-opt';
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 900));
    return document.querySelector('.form-msg.err') ? document.querySelector('.form-msg.err').textContent.trim().slice(0, 80) : 'no-msg';
  })()`);
  console.log('采购下单门禁:', blocked);
  await shot('08-采购下单-暂停供应商被拦');

  ws.close();
  proc.kill();
  console.log('完成');
})();
