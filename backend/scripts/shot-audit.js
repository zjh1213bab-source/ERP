/**
 * 操作日志（审计）· 截图与文本取证
 * 用法：node scripts/shot-audit.js
 *
 * 取证一律 dump textContent，不靠肉眼看图（低分辨率会把「链完整」读成「链断裂」）。
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/audit');
const PORT = 9821;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

  const profile = pathMod.join(require('os').tmpdir(), 'erp-shot-' + PORT);
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
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      console.log('⚠ 弹窗:', m.params.message.slice(0, 120));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.id && pend.has(m.id)) {
      if (m.error) console.log('CDP 错误:', JSON.stringify(m.error));
      pend.get(m.id)(m.result || {});
      pend.delete(m.id);
    }
  };
  const send = (mm, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 160);
    return r.result ? r.result.value : null;
  };
  const shot = async (name, w = 1440) => {
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *')].map(e=>e.getBoundingClientRect().bottom))) + 40`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 4000);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(700);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/audit' });
  await sleep(6500);

  console.log('页面标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('指标卡:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('表头:', await ev(`JSON.stringify([...document.querySelectorAll('table.data thead th')].map(th=>th.innerText.trim()))`));
  console.log('首行:', await ev(`(()=>{const tr=document.querySelector('table.data tbody tr');return tr?[...tr.children].map(td=>td.innerText.trim()).join(' | '):'（空）'})()`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-日志列表');

  // 校验链
  await ev(`(()=>{const b=[...document.querySelectorAll('.head-ops .btn')].find(x=>x.textContent.includes('校验链'));if(b){b.click();return true}return false})()`);
  await sleep(2500);
  console.log('校验横幅:', await ev(`(()=>{const el=document.querySelector('.banner');return el?el.innerText.replace(/\\n/g,' / ').slice(0,240):'（无）'})()`));
  await shot('02-链校验通过');

  // 只看失败
  await ev(`(()=>{const sels=[...document.querySelectorAll('.flt select')];const s=sels[sels.length-1];if(s){s.value='fail';s.dispatchEvent(new Event('change'))}const b=[...document.querySelectorAll('.flt .btn')].find(x=>x.textContent.includes('查询'));if(b)b.click();return true})()`);
  await sleep(1800);
  console.log('失败筛选后行数:', await ev('document.querySelectorAll("table.data tbody tr").length'));
  console.log('失败筛选后结果列:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].slice(0,5).map(tr=>tr.children[8]?.innerText.trim()))`));
  await shot('03-只看失败');

  // 移动端
  await send('Page.navigate', { url: BASE + '/audit' });
  await sleep(5500);
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('04-移动端', 414);

  proc.kill();
  process.exit(0);
})();
