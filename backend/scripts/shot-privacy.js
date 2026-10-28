/**
 * 数据隐私与访问审计 · 截图与文本取证
 * 用法：node scripts/shot-privacy.js
 *
 * 除了 /privacy 本身，还截 /employees（admin 视角应为掩码），
 * 用来证明「掩码是服务端给的，不是前端藏的」。
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/privacy');
const PORT = 9895;
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
      console.log('⚠ 弹窗:', m.params.message.slice(0, 160));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
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
  const shot = async (name, w = 1440) => {
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *')].map(e=>e.getBoundingClientRect().bottom))) + 40`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 5000);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(700);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };
  const shotFixed = async (name, w = 1440, h = 940) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '固定', w + 'x' + h);
  };
  const go = async (url, wait = 6000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await go('/privacy');

  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('侧栏:', await ev("!!document.querySelector('.erp-sidebar')"));
  console.log('菜单选中:', await ev("document.querySelector('.erp-nav .sub.router-link-active')?.textContent?.trim()"));
  console.log('统计卡:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c4 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('规则分组:', await ev(`JSON.stringify([...document.querySelectorAll('.rb-title')].map(x=>x.innerText.replace(/\\n/g,' ')))`));
  console.log('规则行数:', await ev("document.querySelectorAll('.rule-block table.data tbody tr').length"));
  console.log('首行规则:', await ev(`(()=>{const tr=document.querySelector('.rule-block table.data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-脱敏规则');

  // 日志
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('访问日志'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  console.log('日志行数:', await ev("document.querySelectorAll('.panel-card table.data tbody tr').length"));
  console.log('日志前3行:', await ev(`JSON.stringify([...document.querySelectorAll('.panel-card table.data tbody tr')].slice(0,3).map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  await shot('02-访问日志');

  // 一次性查看
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('一次性查看'));if(b){b.click();return true}return false})()`);
  await sleep(1000);
  console.log('查看表单字段:', await ev(`JSON.stringify([...document.querySelectorAll('.rf-row label')].map(x=>x.innerText.trim()))`));
  // 填一条理由并查看
  await ev(`(()=>{
    const inputs=[...document.querySelectorAll('.rf-row input')];
    const idInput=inputs.find(x=>x.type==='number');
    const reasonInput=inputs.find(x=>x.type!=='number');
    return JSON.stringify({hasId:!!idInput, hasReason:!!reasonInput});
  })()`).then((x) => console.log('表单输入框:', x));
  await shotFixed('03-一次性查看', 1440, 760);

  // 员工列表：admin 视角应为掩码
  await go('/employees');
  console.log('员工页表头:', await ev(`JSON.stringify([...document.querySelectorAll('table.data thead th')].map(x=>x.innerText.trim()))`));
  console.log('员工页首行:', await ev(`(()=>{const tr=document.querySelector('table.data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  console.log('员工页含掩码:', await ev("document.body.innerText.includes('***')"));
  await shot('04-员工列表-admin视角');

  proc.kill();
  process.exit(0);
})();
