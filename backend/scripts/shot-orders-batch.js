/**
 * 订单批量流转 · 截图与文本取证
 * 用法：node scripts/shot-orders-batch.js
 *
 * 只跑到「预检」为止，**不点执行** —— 执行会真的改演示订单状态。
 * 执行路径由冒烟覆盖（16 项，含整批/逐单/批次号/日志落库）。
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/batch');
const PORT = 9831;
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
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 200);
    return r.result ? r.result.value : null;
  };
  const waitFor = async (expr, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(expr)) return true;
      await sleep(300);
    }
    return false;
  };
  const vp = (h) => send('Emulation.setDeviceMetricsOverride', { width: 1440, height: h, deviceScaleFactor: 1, mobile: false });
  const shot = async (name) => {
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *')].map(e=>e.getBoundingClientRect().bottom))) + 40`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 3000);
    await vp(height);
    await sleep(600);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    await vp(1100);
    await sleep(200);
  };

  await vp(1100);
  await send('Page.navigate', { url: BASE + '/orders' });
  await sleep(6000);

  // 勾选 3 张「草稿」订单
  const picked = await ev(`(()=>{
    const rows=[...document.querySelectorAll('table.data tbody tr')];
    const picks=rows.filter(tr=>tr.innerText.includes('草稿')).slice(0,3);
    picks.forEach(tr=>{const cb=tr.querySelector('input[type=checkbox]'); if(cb) cb.click();});
    return picks.map(tr=>tr.children[1].innerText.trim());
  })()`);
  console.log('勾选草稿订单:', JSON.stringify(picked));
  await sleep(500);
  console.log('批量条:', await ev(`(()=>{const b=document.querySelector('.batch-bar');return b?b.innerText.replace(/\\n/g,' / '):'（没出现）'})()`));
  await shot('01-勾选后出现批量条');

  // 目标状态 = 已取消 → 预检
  // 两步：先设下拉，等 Vue 把按钮的 disabled 去掉，再点 ——
  // 同一步里"设值+点击"会点在 disabled 的按钮上（Vue 还没重新渲染）
  await ev(`(()=>{const s=document.querySelector('.batch-bar select');s.value='cancelled';s.dispatchEvent(new Event('change'));return s.value})()`);
  await sleep(500);
  console.log('按钮是否可点:', await ev(`(()=>{const b=[...document.querySelectorAll('.batch-bar .btn')].find(x=>x.textContent.includes('批量流转'));return b?!b.disabled:'no-btn'})()`));
  await ev(`(()=>{const b=[...document.querySelectorAll('.batch-bar .btn')].find(x=>x.textContent.includes('批量流转'));if(b) b.click();return true})()`);
  await waitFor("!!document.querySelector('.modal-head h3')");
  console.log('弹窗标题:', await ev(`document.querySelector('.modal-head h3')?.innerText`));
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.includes('开始预检'));if(b){b.click();return true}return false})()`);
  await waitFor("!!document.querySelector('.pre-sum')");
  await sleep(600);
  console.log('预检结果:', await ev(`document.querySelector('.pre-sum')?.innerText.replace(/\\n/g,' / ')`));
  console.log('可执行按钮:', await ev(`(()=>{const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.includes('确认执行'));return b?b.innerText.trim():'（无）'})()`));
  await shot('02-预检-可流转');

  // 换成「技术确认」→ 预检（会全部被拦，展示门槛原因）
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.includes('重新预检'));if(b) b.click();return true})()`);
  await sleep(600);
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal .x')][0];if(b) b.click();return true})()`);
  await sleep(900);
  // 关弹窗会清空选择（closeBatch 里 selected=[]），所以要重新勾
  await ev(`(()=>{
    const rows=[...document.querySelectorAll('table.data tbody tr')];
    const picks=rows.filter(tr=>tr.innerText.includes('草稿')).slice(0,3);
    picks.forEach(tr=>{const cb=tr.querySelector('input[type=checkbox]'); if(cb&&!cb.checked) cb.click();});
    return picks.length;
  })()`);
  await sleep(600);
  await ev(`(()=>{const s=document.querySelector('.batch-bar select');s.value='tech';s.dispatchEvent(new Event('change'));return s.value})()`);
  await sleep(500);
  await ev(`(()=>{const b=[...document.querySelectorAll('.batch-bar .btn')].find(x=>x.textContent.includes('批量流转'));if(b) b.click();return true})()`);
  await waitFor("!!document.querySelector('.modal-head h3')");
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.includes('开始预检'));if(b){b.click();return true}return false})()`);
  await waitFor("!!document.querySelector('.pre-sum')");
  await sleep(600);
  console.log('预检(科技确认):', await ev(`document.querySelector('.pre-sum')?.innerText.replace(/\\n/g,' / ')`));
  console.log('被拦原因首条:', await ev(`(()=>{const tr=document.querySelector('.modal table.data tbody tr');return tr?[...tr.children].map(td=>td.innerText.trim()).join(' | '):'（无）'})()`));
  console.log('执行按钮是否禁用:', await ev(`(()=>{const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.includes('确认执行'));return b?b.disabled:'（无按钮）'})()`));
  await shot('03-预检-被门槛拦');

  // 移动端
  await send('Page.navigate', { url: BASE + '/orders' });
  await sleep(5500);
  await ev(`(()=>{
    const rows=[...document.querySelectorAll('table.data tbody tr')];
    const picks=rows.filter(tr=>tr.innerText.includes('草稿')).slice(0,2);
    picks.forEach(tr=>{const cb=tr.querySelector('input[type=checkbox]'); if(cb) cb.click();});
    return picks.length;
  })()`);
  await sleep(400);
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 900, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  const s2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(pathMod.join(OUT, '04-移动端批量条.png'), Buffer.from(s2.data, 'base64'));
  console.log('shot 04-移动端批量条');

  proc.kill();
  process.exit(0);
})();
