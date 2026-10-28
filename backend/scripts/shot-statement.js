/**
 * 客户对账单 · 取证
 * 用法：node scripts/shot-statement.js [customerId] [from] [to]
 *
 * 除了屏幕版，还要切 print 媒体 —— 对账函是 A4 盖章件，打印样式不对等于废纸。
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/statement');
const PORT = 9851;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const token = lg.data.token;

  const list = await (await fetch(BASE + '/api/statements/customers', { headers: { Authorization: 'Bearer ' + token } })).json();
  const rows = list.data || [];
  const pick = rows.find((r) => r.invoice_count > 1) || rows[0] || { id: 0 };
  const cid = process.argv[2] || pick.id;
  const from = process.argv[3] || '2026-09-01';
  const to = process.argv[4] || '2026-10-31';
  console.log('客户', cid, '期间', from, '~', to, '| 有往来客户数', rows.length);

  const profile = pathMod.join(require('os').tmpdir(), 'erp-shot-' + PORT);
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1240,1100', 'about:blank'], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) { target = await r.json(); break; }
    } catch (e) { /* ignore */ }
  }
  if (!target) { console.log('连不上调试端口'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 200);
    return r.result ? r.result.value : null;
  };
  const vp = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
  const fit = async (name, w) => {
    const h = await ev(`Math.ceil(document.querySelector('.st-sheet')?document.querySelector('.st-sheet').getBoundingClientRect().height+80:document.body.scrollHeight)`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 4000);
    await vp(w || 1240, height);
    await sleep(600);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    await vp(1240, 1100);
    await sleep(200);
  };
  const dump = async () => {
    console.log('\n--- 页面内容 ---');
    console.log('标题:', await ev(`document.querySelector('.st-title h1')?.innerText`));
    console.log('致:', await ev(`document.querySelector('.st-to')?.innerText.replace(/\\n/g,' / ')`));
    console.log('期间:', await ev(`document.querySelector('.st-period')?.innerText.replace(/\\n/g,' / ')`));
    console.log('汇总卡:', await ev(`JSON.stringify([...document.querySelectorAll('.st-sum td')].map(td=>td.innerText.replace(/\\n/g,'=')))`));
    console.log('未核销提示:', await ev(`document.querySelector('.st-unalloc')?.innerText || '（无）'`));
    console.log('表头:', await ev(`JSON.stringify([...document.querySelectorAll('.st-table thead th')].map(th=>th.innerText.trim()))`));
    console.log('期初行:', await ev(`(()=>{const tr=document.querySelector('.st-table tbody tr.opening');return tr?[...tr.children].map(td=>td.innerText.trim()).join(' | '):'（无）'})()`));
    console.log('流水行数:', await ev(`document.querySelectorAll('.st-table tbody tr').length`));
    console.log('流水前两行:', await ev(`JSON.stringify([...document.querySelectorAll('.st-table tbody tr')].slice(1,3).map(tr=>[...tr.children].map(td=>td.innerText.trim()).join(' | ')))`));
    console.log('合计行:', await ev(`(()=>{const tr=document.querySelector('.st-table tfoot tr');return tr?[...tr.children].map(td=>td.innerText.trim()).join(' | '):'（无）'})()`));
    console.log('内部告警(no-print):', await ev(`JSON.stringify([...document.querySelectorAll('.st-warn')].map(x=>x.innerText.slice(0,120)))`));
    console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  };

  await vp(1240, 1100);
  await send('Page.navigate', { url: `${BASE}/statement/${cid}?from=${from}&to=${to}` });
  await sleep(5200);
  await dump();
  await fit('01-对账单');

  // print 媒体：工具栏要消失、盖章栏要完整
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(700);
  console.log('\n--- 打印媒体 ---');
  console.log('工具栏 display:', await ev(`(()=>{const b=document.querySelector('.st-bar');return b?getComputedStyle(b).display:'（无）'})()`));
  console.log('盖章栏存在:', await ev(`!!document.querySelector('.st-seal')`));
  const s2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(pathMod.join(OUT, '02-打印媒体.png'), Buffer.from(s2.data, 'base64'));
  console.log('shot 02-打印媒体');
  await send('Emulation.setEmulatedMedia', { media: '' });

  // 换一个有未核销收款的客户（提示条只在内部显示）
  const withUnalloc = rows.find((r) => r.unallocated > 0);
  if (withUnalloc && String(withUnalloc.id) !== String(cid)) {
    await send('Page.navigate', { url: `${BASE}/statement/${withUnalloc.id}?from=${from}&to=${to}` });
    await sleep(4200);
    console.log('\n--- 未核销客户', withUnalloc.id, '---');
    console.log('未核销提示:', await ev(`document.querySelector('.st-unalloc')?.innerText || '（无）'`));
    console.log('内部提示条:', await ev(`JSON.stringify([...document.querySelectorAll('.st-note')].map(x=>x.innerText.replace(/\\n/g,' ').slice(0,140)))`));
    await fit('03-含未核销收款');
  }

  // 移动端
  await vp(414, 900);
  await sleep(600);
  console.log('\n移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  const s3 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(pathMod.join(OUT, '04-移动端.png'), Buffer.from(s3.data, 'base64'));
  console.log('shot 04-移动端');

  proc.kill();
  process.exit(0);
})();
