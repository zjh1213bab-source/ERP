/**
 * 异常协同与日清 · 截图与文本取证
 * 用法：node scripts/shot-exceptions.js
 *
 * 取证一律 dump textContent，不靠肉眼看图。
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/exceptions');
const PORT = 9881;
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
  const shotFixed = async (name, w = 1440, h = 940) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '固定', w + 'x' + h);
  };
  const go = async (url, wait = 6000) => {
    await send('Page.navigate', { url: BASE + url });
    await sleep(wait);
  };

  // ================= 1. 日清主页 =================
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await go('/exceptions');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('侧栏:', await ev("!!document.querySelector('.erp-sidebar')"));
  console.log('当前菜单选中:', await ev("document.querySelector('.erp-nav .nav-item.router-link-active')?.textContent?.trim()"));
  console.log('数据截止:', await ev("document.querySelector('.stamp')?.textContent?.trim()"));
  console.log('归口卡:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.cat .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('覆盖率条数:', await ev("document.querySelectorAll('.cov ul li').length"));
  console.log('覆盖率内容:', await ev(`JSON.stringify([...document.querySelectorAll('.cov ul li')].map(x=>x.innerText.slice(0,90)))`));
  console.log('tabs:', await ev(`JSON.stringify([...document.querySelectorAll('.tabs button')].map(b=>b.innerText.replace(/\\n/g,'')))`));
  console.log('表头:', await ev(`JSON.stringify([...document.querySelectorAll('table.data thead th')].map(th=>th.innerText.trim()))`));
  console.log('行数:', await ev('document.querySelectorAll("table.data tbody tr").length'));
  console.log('各行:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].slice(0,6).map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-今日必办');

  // ================= 2. 处理中 =================
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('处理中'));if(b){b.click();return true}return false})()`);
  await sleep(900);
  console.log('处理中行数:', await ev('document.querySelectorAll("table.data tbody tr").length'));
  console.log('处理中首行:', await ev(`(()=>{const tr=document.querySelector('table.data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  await shot('02-处理中');

  // ================= 3. 详情（必办里第一条） =================
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('今日必办'));if(b)b.click()})()`);
  await sleep(800);
  const opened = await ev(`(()=>{
    const tr=document.querySelector('table.data tbody tr');
    if(!tr) return 'no-row';
    const b=[...tr.querySelectorAll('.btn')].find(x=>x.textContent.includes('处理'));
    if(!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);
  console.log('打开详情:', opened);
  await sleep(1600);
  console.log('详情标题:', await ev("document.querySelector('.m-head h3')?.textContent"));
  console.log('详情元信息:', await ev(`(()=>{const e=document.querySelector('.m-head .mut');return e?e.innerText.replace(/\\n/g,' '):'（无）'})()`));
  console.log('详情 KV:', await ev(`JSON.stringify([...document.querySelectorAll('.modal .kv > div')].map(d=>d.innerText.replace(/\\n/g,':')))`));
  console.log('升级提示:', await ev(`(()=>{const b=document.querySelector('.warn-box');return b?b.innerText.replace(/\\n/g,' / ').slice(0,140):'（无）'})()`));
  console.log('动作按钮:', await ev(`JSON.stringify([...document.querySelectorAll('.act-bar .btn')].map(b=>b.innerText.trim()))`));
  console.log('流水条数:', await ev("document.querySelectorAll('.act-row').length"));
  await shotFixed('03-详情与流水', 1440, 940);

  // ================= 4. 关闭面板 =================
  await ev(`(()=>{const b=[...document.querySelectorAll('.act-bar .btn')].find(x=>x.textContent.trim()==='关闭');if(b){b.click();return true}return false})()`);
  await sleep(700);
  console.log('关闭面板字段:', await ev(`JSON.stringify([...document.querySelectorAll('.form-box .lbl')].map(x=>x.innerText.trim()))`));
  console.log('关闭按钮:', await ev(`JSON.stringify([...document.querySelectorAll('.form-box .btn')].map(b=>b.innerText.trim()))`));
  await shotFixed('04-关闭面板', 1440, 1050);

  // 空结果直接点确认，看后端校验有没有拦
  const warn = await ev(`(()=>{const b=[...document.querySelectorAll('.form-box .btn')].find(x=>x.textContent.includes('确认关闭'));if(!b)return 'no-btn';b.click();return 'clicked'})()`);
  console.log('空表单提交:', warn);
  await sleep(1500);

  // 关掉弹窗
  await ev(`(()=>{const b=document.querySelector('.m-head .link-btn');if(b)b.click();return true})()`);
  await sleep(600);

  // ================= 5. 日报初稿 =================
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('日报初稿'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  console.log('日报说明:', await ev(`(()=>{const e=document.querySelector('.rep-note');return e?e.innerText.slice(0,120):'（无）'})()`));
  console.log('日报分区:', await ev(`JSON.stringify([...document.querySelectorAll('.rep-h')].map(x=>x.innerText.replace(/\\n/g,' ')))`));
  console.log('日报行数:', await ev("document.querySelectorAll('.rep-row').length"));
  console.log('责任人分布:', await ev(`JSON.stringify([...document.querySelectorAll('.rep-owner .tag')].map(x=>x.innerText.trim()).slice(0,8))`));
  await shot('05-日报初稿');

  // ================= 6. 规则与阈值 =================
  await ev(`(()=>{const b=[...document.querySelectorAll('.head-ops .btn')].find(x=>x.textContent.includes('规则'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  console.log('规则弹窗标题:', await ev("document.querySelector('.m-head h3')?.textContent"));
  console.log('规则行数:', await ev('document.querySelectorAll(".modal table.data tbody tr").length'));
  console.log('规则首行:', await ev(`(()=>{const tr=document.querySelector('.modal table.data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim().slice(0,60)).join(' | '):'（空）'})()`));
  await shotFixed('06-规则与阈值', 1440, 940);
  await ev(`(()=>{const b=document.querySelector('.m-head .link-btn');if(b)b.click();return true})()`);
  await sleep(600);

  // ================= 7. 移动端 =================
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await go('/exceptions');
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  console.log('移动端归口卡:', await ev('document.querySelectorAll(".cards.cat .stat-card").length'));
  await shot('07-移动端', 414);

  proc.kill();
  process.exit(0);
})();
