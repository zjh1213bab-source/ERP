/**
 * 历史订单再次购买（TS-N20-08）· 截图与文本取证
 * 用法：node scripts/shot-reorder.js
 *
 * 客户商城是外部身份，token 存在 localStorage 的 mall_token（与 ERP 的 erp_token 分开）。
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/reorder');
const PORT = 9913;
const MALL_USER = process.env.MALL_USER || 'abc001';
const MALL_PASS = process.env.MALL_PASS || 'abc123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const lg = await (await fetch(BASE + '/api/mall/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MALL_USER, password: MALL_PASS })
  })).json();
  if (!lg.data || !lg.data.token) { console.log('商城登录失败', JSON.stringify(lg).slice(0, 200)); process.exit(1); }

  const profile = pathMod.join(os.tmpdir(), 'erp-shot-' + PORT);
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1440,1100', 'about:blank'], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 80 && !t; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) { t = await r.json(); break; }
    } catch (e) { /* ignore */ }
  }
  if (!t) { console.log('连不上调试端口'); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const errors = [];
  let alertText = '';
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      alertText = m.params.message || '';
      console.log('⚠ 弹窗:', alertText.slice(0, 160).replace(/\n/g, ' / '));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.text).slice(0, 160));
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (mm, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');

  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 200);
    return r.result ? r.result.value : null;
  };
  const shot = async (name, w = 1440) => {
    if (w < 500) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1200, deviceScaleFactor: 2, mobile: true });
      await sleep(700);
    }
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.ml-shell > *')].map(e=>e.getBoundingClientRect().bottom), document.body.scrollHeight)) + 40`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 4200);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(800);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };
  const go = async (url, wait = 5000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };
  const clickText = async (sel, text) => ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("mall_token","' + lg.data.token + '");localStorage.setItem("mall_user",' + JSON.stringify(JSON.stringify(lg.data.account)) + ');'
  });

  await go('/mall', 6000);
  console.log('页面:', await ev("document.querySelector('.ml-co')?.textContent"));
  console.log('登录态:', await ev("document.querySelector('.ml-user')?.innerText?.replace(/\\n/g,' / ')"));

  // 我的订单
  await clickText('.ml-tabs button', '我的订单');
  await sleep(2200);
  console.log('订单行数:', await ev("document.querySelectorAll('.ml-row').length"));
  console.log('首行:', await ev(`(()=>{const r=document.querySelector('.ml-row');return r?r.innerText.replace(/\\n/g,' | '):'（空）'})()`));
  await shot('01-我的订单');

  // 打开演示订单
  const opened = await ev(`(()=>{const r=[...document.querySelectorAll('.ml-row')].find(x=>x.innerText.includes('SO202609010001'));if(r){r.click();return true}return false})()`);
  await sleep(2000);
  console.log('打开演示单:', opened, await ev("document.querySelector('.ml-modal h3')?.innerText?.replace(/\\n/g,' ')"));
  console.log('再来一单入口:', await ev("document.querySelector('.ml-reorder-bar')?.innerText?.replace(/\\n/g,' ')"));
  await shot('02-订单详情与再来一单');

  // 点「再来一单」
  await clickText('.ml-reorder-bar button', '再来一单');
  await sleep(2200);
  console.log('\n弹窗标题:', await ev("document.querySelector('.ml-modal.wide h3')?.innerText?.replace(/\\n/g,' ')"));
  console.log('汇总:', await ev("document.querySelector('.ro-sum')?.innerText?.replace(/\\n/g,' | ')"));
  console.log('差异行:', await ev(`JSON.stringify([...document.querySelectorAll('.ro-table tbody tr')].map(r=>r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / ')))`));
  console.log('当前价合计:', await ev(`(()=>{const i=[...document.querySelectorAll('.ro-qty')];return i.map(x=>x.value).join(',')})()`));
  await shot('03-再来一单差异');

  // 提交
  await clickText('.ro-foot button', '提交询价');
  await sleep(2600);
  console.log('\n提交后提示:', alertText.replace(/\n/g, ' / ').slice(0, 160));
  // 提交后订单详情弹窗还盖在上面，先关掉再截「我的询价」，否则截到的是详情而不是列表
  await ev("document.querySelector('.ml-modal .ml-x')?.click()");
  await sleep(900);
  console.log('当前 tab:', await ev("document.querySelector('.ml-tabs button.on')?.textContent"));
  console.log('询价行数:', await ev("document.querySelectorAll('.ml-row').length"));
  console.log('首行:', await ev(`(()=>{const r=document.querySelector('.ml-row');return r?r.innerText.replace(/\\n/g,' | '):'（空）'})()`));
  await shot('04-生成询价单');

  // 移动端：订单详情
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 1200, deviceScaleFactor: 2, mobile: true });
  await sleep(900);
  await clickText('.ml-tabs button', '我的订单');
  await sleep(1800);
  await ev(`(()=>{const r=[...document.querySelectorAll('.ml-row')].find(x=>x.innerText.includes('SO202609010001'));if(r){r.click();return true}return false})()`);
  await sleep(1600);
  await clickText('.ml-reorder-bar button', '再来一单');
  await sleep(2000);
  await shot('05-移动端差异', 414);
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));

  console.log('\n前端异常:', errors.length ? JSON.stringify(errors) : '无');
  proc.kill();
  process.exit(0);
})();
