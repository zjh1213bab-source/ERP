/**
 * 流程变更与发布审计 · 截图与文本取证
 * 用法：node scripts/shot-flowchange.js
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/flowchange');
const PORT = 9893;
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
      console.log('⚠ 弹窗:', m.params.message.slice(0, 160).replace(/\n/g, ' / '));
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
  await go('/flow-changes');

  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('侧栏:', await ev("!!document.querySelector('.erp-sidebar')"));
  console.log('菜单选中:', await ev("document.querySelector('.erp-nav .sub.router-link-active')?.textContent?.trim()"));
  console.log('三条门槛:', await ev(`JSON.stringify([...document.querySelectorAll('.gate')].map(g=>g.innerText.split('\\n')[0]))`));
  console.log('流程卡:', await ev(`JSON.stringify([...document.querySelectorAll('.flow-card')].map(c=>c.innerText.replace(/\\n/g,' / ')))`));
  console.log('变更单行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('变更单各行:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-流程清单与变更单');

  // 版本历史：点成本审批
  await ev(`(()=>{const c=[...document.querySelectorAll('.flow-card')].find(x=>x.textContent.includes('成本审批'));if(c){c.click();return true}return false})()`);
  await sleep(1200);
  console.log('版本历史行数:', await ev("document.querySelectorAll('.ver-box table.data tbody tr').length"));
  console.log('版本历史:', await ev(`JSON.stringify([...document.querySelectorAll('.ver-box table.data tbody tr')].map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  await shot('02-版本历史');

  // 详情：已发布那条
  const opened = await ev(`(()=>{
    const tr=[...document.querySelectorAll('table.data tbody tr')].find(r=>r.innerText.includes('已发布'));
    if(!tr) return 'no-published';
    const b=[...tr.querySelectorAll('.btn')].find(x=>x.textContent.includes('查看'));
    if(!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  console.log('打开已发布详情:', opened);
  await sleep(1800);
  console.log('详情标题:', await ev("document.querySelector('.m-head h3')?.textContent"));
  console.log('试运行统计:', await ev(`JSON.stringify([...document.querySelectorAll('.tb-stats > div')].map(d=>d.innerText.replace(/\\n/g,':')))`));
  console.log('试运行结论:', await ev("document.querySelector('.tb-verdict')?.textContent"));
  console.log('动作按钮:', await ev(`JSON.stringify([...document.querySelectorAll('.act-bar .btn')].map(b=>b.innerText.trim()))`));
  console.log('审计条数:', await ev("document.querySelectorAll('.act-row').length"));
  await shotFixed('03-已发布详情与试运行证据', 1440, 1050);

  // 待发布那条：看发布面板
  await ev(`(()=>{const b=document.querySelector('.m-head .link-btn');if(b)b.click();return true})()`);
  await sleep(600);
  const opened2 = await ev(`(()=>{
    const tr=[...document.querySelectorAll('table.data tbody tr')].find(r=>r.innerText.includes('待发布'));
    if(!tr) return 'no-trialed';
    const b=[...tr.querySelectorAll('.btn')].find(x=>x.textContent.includes('查看'));
    if(!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  console.log('打开待发布详情:', opened2);
  await sleep(1600);
  console.log('待发布标题:', await ev("document.querySelector('.m-head h3')?.textContent"));
  console.log('关键角色告警:', await ev(`(()=>{const t=document.querySelector('.trial-box');return t?t.innerText.replace(/\\n/g,' ').slice(-120):'（无）'})()`));
  await shotFixed('04-待发布详情', 1440, 940);
  await ev(`(()=>{const b=document.querySelector('.m-head .link-btn');if(b)b.click();return true})()`);
  await sleep(600);

  // 审计流水
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('审计'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  console.log('审计行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('审计前3行:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].slice(0,3).map(tr=>[...tr.children].map(td=>td.innerText.trim()).join(' | ')))`));
  await shot('05-审计流水');

  // 新建变更弹窗
  await ev(`(()=>{const b=[...document.querySelectorAll('.head-ops .btn')].find(x=>x.textContent.includes('发起变更'));if(b){b.click();return true}return false})()`);
  await sleep(1200);
  console.log('新建弹窗标题:', await ev("document.querySelector('.m-head h3')?.textContent"));
  console.log('步骤编辑器行数:', await ev("document.querySelectorAll('.step-row').length"));
  await shotFixed('06-发起变更', 1440, 940);

  proc.kill();
  process.exit(0);
})();
