/**
 * 计件工资条 / 车间公示表 · 取证
 * 用法：node scripts/shot-payslip.js [runId]
 *
 * 除了看屏幕版，还要用 `Emulation.setEmulatedMedia({media:'print'})` 模拟打印媒体 ——
 * 打印样式（A4 分页、虚线裁切）只有真的切到 print 媒体才看得出来。
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/payslip');
const PORT = 9841;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

  // 默认取最新一份已确认核算单
  const runs = await (await fetch(BASE + '/api/piece-wage/runs?status=confirmed', {
    headers: { Authorization: 'Bearer ' + lg.data.token }
  })).json();
  const runId = process.argv[2] || ((runs.data && runs.data[0] && runs.data[0].id) || '');
  if (!runId) { console.log('没有已确认的核算单，先确认一份再来'); process.exit(1); }
  console.log('核算单 id =', runId);

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
  const vp = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
  const shot = async (name, w = 1240) => {
    const h = await ev(`Math.ceil(document.querySelector('.ps-sheet')?document.querySelector('.ps-sheet').getBoundingClientRect().height+80:document.body.scrollHeight)`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 4000);
    await vp(w, height);
    await sleep(600);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    await vp(1240, 1100);
    await sleep(200);
  };
  const dump = async (label) => {
    console.log(`\n--- ${label} ---`);
    console.log('标题:', await ev(`document.querySelector('.ps-head h1')?.innerText`));
    console.log('副标题:', await ev(`document.querySelector('.ps-sub')?.innerText.replace(/\\n/g,' ')`));
    console.log('表头:', await ev(`JSON.stringify([...document.querySelectorAll('.ps-table thead th')].map(th=>th.innerText.trim()))`));
    console.log('首行:', await ev(`(()=>{const tr=document.querySelector('.ps-table tbody tr');return tr?[...tr.children].map(td=>td.innerText.trim()).join(' | '):'（无表格）'})()`));
    console.log('合计行:', await ev(`(()=>{const tr=document.querySelector('.ps-table tfoot tr');return tr?[...tr.children].map(td=>td.innerText.trim()).join(' | '):'（无）'})()`));
    console.log('工资条块数:', await ev(`document.querySelectorAll('.ps-card').length`));
    console.log('首条内容:', await ev(`(()=>{const c=document.querySelector('.ps-card');return c?c.innerText.replace(/\\n/g,' / ').slice(0,220):'（无卡片）'})()`));
    console.log('口径说明:', await ev(`document.querySelector('.ps-terms')?.innerText.replace(/\\n/g,' ').slice(0,300)`));
    console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  };

  await vp(1240, 1100);
  await send('Page.navigate', { url: BASE + '/payslip/' + runId + '?mode=public' });
  await sleep(5000);
  await dump('车间公示表');
  await shot('01-车间公示表');

  // 个人工资条
  await ev(`(()=>{const b=[...document.querySelectorAll('.ps-tabs button')].find(x=>x.textContent.includes('个人工资条'));if(b){b.click();return true}return false})()`);
  await sleep(2200);
  await dump('个人工资条');
  await shot('02-个人工资条');

  // 打印媒体（模拟 A4）
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(600);
  console.log('\n--- 打印媒体 ---');
  console.log('工具栏是否隐藏(no-print):', await ev(`(()=>{const b=document.querySelector('.ps-bar');return b?getComputedStyle(b).display:'（无）'})()`));
  const s2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(pathMod.join(OUT, '03-打印媒体-个人条.png'), Buffer.from(s2.data, 'base64'));
  console.log('shot 03-打印媒体-个人条');
  await send('Emulation.setEmulatedMedia', { media: '' });

  // 移动端
  await send('Page.navigate', { url: BASE + '/payslip/' + runId + '?mode=public' });
  await sleep(4500);
  await vp(414, 900);
  await sleep(500);
  console.log('\n移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  const s3 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(pathMod.join(OUT, '04-移动端公示表.png'), Buffer.from(s3.data, 'base64'));
  console.log('shot 04-移动端公示表');

  proc.kill();
  process.exit(0);
})();
