/**
 * 客户信用与账期 · 截图与文本取证
 * 用法：node scripts/shot-credit.js
 *
 * 取证一律 dump textContent，不靠肉眼看图（宽度不够时表格会被压窄，肉眼读不出数字对不对）。
 */
const fs = require('fs');
const { db } = require('../src/db');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/credit');
const PORT = 9837;
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

  const go = async (url, wait = 6000) => {
    await send('Page.navigate', { url: BASE + url });
    await sleep(wait);
  };

  // ================= 1. 台账 =================
  // 弹窗用固定视口截：弹窗是 position:fixed，按整页高度截会把它压成顶部一小块 + 下面大片空白
  const shotFixed = async (name, w = 1440, h = 940) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, `固定 ${w}x${h}`);
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await go('/credit');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('指标卡:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('表头:', await ev(`JSON.stringify([...document.querySelectorAll('table.data thead th')].map(th=>th.innerText.trim()))`));
  console.log('行数:', await ev('document.querySelectorAll("table.data tbody tr").length'));
  console.log('首行:', await ev(`(()=>{const tr=document.querySelector('table.data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  console.log('风险标签:', await ev(`JSON.stringify([...document.querySelectorAll('table.data tbody tr')].slice(0,12).map(tr=>tr.children[6]?.innerText.trim()))`));
  console.log('占用条宽:', await ev(`JSON.stringify([...document.querySelectorAll('.usage .bar i')].slice(0,6).map(i=>i.style.width))`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-信用台账');

  // ================= 2. 客户明细 =================
  // 挑信息最全的那家（有逾期发票 + 有货已发未开票的单），别拿冻结客户当样板
  await ev(`(()=>{
    const tr=[...document.querySelectorAll('table.data tbody tr')].find(r=>r.innerText.includes('北欧服饰'));
    const b=tr?[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('明细')):null;
    if(b){b.click();return true}
    const any=[...document.querySelectorAll('table.data tbody tr .link-btn')].find(x=>x.textContent.includes('明细'));
    if(any){any.click();return 'fallback'}
    return false;
  })()`);
  await sleep(1800);
  console.log('明细标题:', await ev("document.querySelector('.modal-head h3')?.textContent"));
  console.log('明细数字:', await ev(`JSON.stringify([...document.querySelectorAll('.dgrid > div')].map(d=>d.innerText.replace(/\\n/g,':')))`));
  console.log('明细小节:', await ev(`JSON.stringify([...document.querySelectorAll('.sec')].map(h=>h.textContent.trim()))`));
  console.log('事件条数:', await ev('document.querySelectorAll(".ev").length'));
  await shotFixed('02-客户明细', 1440, 1000);
  await ev(`(()=>{const b=document.querySelector('.modal-head .x');if(b){b.click();return true}return false})()`);
  await sleep(700);

  // ================= 3. 调额弹窗（含预览） =================
  await ev(`(()=>{const b=[...document.querySelectorAll('table.data tbody tr .link-btn')].find(x=>x.textContent.includes('调额'));if(b){b.click();return true}return false})()`);
  await sleep(900);
  console.log('调额标题:', await ev("document.querySelector('.modal-head h3')?.textContent"));
  console.log('调额预览:', await ev(`(()=>{const p=document.querySelector('.preview');return p?p.innerText.replace(/\\n/g,' '):'（无）'})()`));
  await shotFixed('03-调额度', 1440, 820);
  await ev(`(()=>{const b=document.querySelector('.modal-head .x');if(b){b.click();return true}return false})()`);
  await sleep(600);

  // ================= 4. 冻结弹窗 =================
  await ev(`(()=>{const b=[...document.querySelectorAll('table.data tbody tr .link-btn')].find(x=>x.textContent.includes('解冻'));if(b){b.click();return true}return false})()`);
  await sleep(900);
  console.log('冻结弹窗标题:', await ev("document.querySelector('.modal-head h3')?.textContent"));
  console.log('冻结横幅:', await ev(`(()=>{const p=document.querySelector('.modal-body .banner');return p?p.innerText.replace(/\\n/g,' / '):'（无）'})()`));
  await shotFixed('04-解冻确认', 1440, 760);
  await ev(`(()=>{const b=document.querySelector('.modal-head .x');if(b){b.click();return true}return false})()`);
  await sleep(600);

  // ================= 5. 发货被拦（真点发货按钮） =================
  // 美仓发货页对库存不足的单不显示「发货」按钮，所以改到订单详情页点「发货出库（生产仓）」
  // 演示单 CREDITDEMO-O03 是 instock + 客户超限，正好会撞上闸门
  const demoOrder = db.prepare("SELECT id, order_no FROM orders WHERE order_no = 'CDEMO003'").get();
  if (!demoOrder) {
    console.log('⚠ 没有演示单，跳过拦截截图（先跑 seed-credit-demo.js --reset）');
  } else {
    await go('/orders?order=' + demoOrder.id, 6500);
    console.log('详情订单号:', await ev("document.querySelector('.modal-head h3, .page-head h2')?.textContent"));
    const clicked = await ev(`(()=>{
      const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('发货出库'));
      if(!b) return 'no-btn';
      b.click(); return 'clicked';
    })()`);
    console.log('点击结果:', clicked);
    await sleep(2800);   // confirm 由 Page.handleJavaScriptDialog 自动接受
    console.log('拦截弹窗标题:', await ev("document.querySelector('.modal-head h3')?.textContent"));
    console.log('拦截理由:', await ev(`JSON.stringify([...document.querySelectorAll('.reasons li')].map(li=>li.textContent.trim()))`));
    console.log('客户画像:', await ev(`JSON.stringify([...document.querySelectorAll('.figs > div')].map(d=>d.innerText.replace(/\\n/g,':')))`));
    console.log('提示条数:', await ev('document.querySelectorAll(".tip").length'));
    await shotFixed('05-发货被拦', 1440, 940);
  }

  // ================= 6. 移动端 =================
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await go('/credit');
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  console.log('移动端卡片数:', await ev('document.querySelectorAll(".stat-card").length'));
  await shot('06-移动端', 414);

  proc.kill();
  process.exit(0);
})();
