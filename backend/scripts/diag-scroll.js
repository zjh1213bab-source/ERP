/**
 * 滚动诊断：某页面能不能滚到底
 * ============================================================
 * 用法：node scripts/diag-scroll.js /access-review [--tab=职责分离]
 *
 * 输出关键量：
 *   window.innerHeight / .erp-content 的 client/scroll / .page 的 computed height+overflow
 *   最后一个可见块底部坐标（超出视口就是被裁）
 * 判据：.page 若 height=100vh 且 overflow=hidden，页面底部内容会被永久裁掉，
 *       因为外层 .erp-content 的 scrollHeight 只按 .page 的盒子算（100vh），看不到被裁的部分。
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argPath = process.argv[2] || '/access-review';
const VW = Number(process.env.W || 1440);
const VH = Number(process.env.H || 900);
const argTab = (process.argv[3] || '').replace(/^--tab=/, '');

(async () => {
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

  const port = 9811;
  // 必须用独立 user-data-dir：桌面上开着 Chrome 时，新进程会并进已有实例，
  // --remote-debugging-port 失效（连到用户的标签页），表现就是 Page.navigate 返回 {} 且停在 about:blank
  const profile = require('path').join(require('os').tmpdir(), 'erp-diag-' + port);
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 80 && !t; i++) {
    await sleep(250);
    try {
      // 显式新建一个 about:blank 目标再连 —— 直接取 /json 里第一个 page 有可能拿到
      // 被 detach 的空目标，表现是 Page.navigate 返回 {}、地址一直停在 about:blank
      const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) {
        t = await r.json();
        break;
      }
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
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
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: VW < 500 });
  await sleep(500);
  const navRes = await send('Page.navigate', { url: BASE + argPath });
  console.log('目标URL:', JSON.stringify(BASE + argPath), '| 导航结果:', JSON.stringify(navRes));
  await sleep(7000);
  console.log('当前地址:', await ev('location.href'));
  console.log('页面文本:', String(await ev('document.body.innerText.slice(0,160).replace(/\\n/g," / ")')));

  // 切页签（可选）
  if (argTab) {
    const okTab = await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes(${JSON.stringify(argTab)}));if(b){b.click();return true}return false})()`);
    console.log('切页签', argTab, '→', okTab);
    await sleep(1500);
  }

  console.log('\n--- 布局量测 ---');
  console.log(await ev(`(()=>{
    const q=(s)=>document.querySelector(s);
    const cs=(e)=>e?getComputedStyle(e):null;
    const ec=q('.erp-content'), pg=q('.page');
    const out={
      视口高: window.innerHeight,
      erpContent: ec?{clientH:ec.clientHeight, scrollH:ec.scrollHeight, overflowY:cs(ec).overflowY, 可滚动: ec.scrollHeight>ec.clientHeight+1}:null,
      page: pg?{clientH:pg.clientHeight, scrollH:pg.scrollHeight, height:cs(pg).height, overflow:cs(pg).overflow, flex:cs(pg).flex}:null,
    };
    const blocks=[...document.querySelectorAll('.page > *')];
    if(blocks.length){
      const last=blocks[blocks.length-1];
      out.最后一块={标签:last.className.toString().slice(0,40), bottom:Math.round(last.getBoundingClientRect().bottom)};
      out.块数=blocks.length;
    }
    return JSON.stringify(out,null,2);
  })()`));

  console.log('\n--- 能不能滚到底 ---');
  console.log(await ev(`(async()=>{
    const ec=document.querySelector('.erp-content');
    if(!ec) return '没有 .erp-content';
    const before=ec.scrollTop;
    ec.scrollTop=999999;
    await new Promise(r=>setTimeout(r,300));
    const after=ec.scrollTop;
    const max=ec.scrollHeight-ec.clientHeight;
    const lastBlock=[...document.querySelectorAll('.page > *')].pop();
    const bottomAfter=lastBlock?Math.round(lastBlock.getBoundingClientRect().bottom):null;
    return JSON.stringify({滚前:before, 滚后:after, 最大可滚:max, 滚到底后最后一块bottom:bottomAfter, 视口高:window.innerHeight, 底部是否可见: bottomAfter!==null && bottomAfter<=window.innerHeight+2});
  })()`));

  // 可选：--shot=文件名 → 整页截图（先按内容高度拉视口，再截）
  const shotArg = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice(7);
  if (shotArg) {
    const outDir = require('path').resolve(__dirname, '../../shots/fix');
    fs.mkdirSync(outDir, { recursive: true });
    const pgH = await ev(`(()=>{const p=document.querySelector('.page');return p?Math.ceil(p.getBoundingClientRect().height):0})()`);
    const ec = await ev(`(()=>{const e=document.querySelector('.erp-content');return e?Math.ceil(e.scrollHeight):0})()`);
    const h = Math.min(Math.max(Number(pgH) || 1200, Number(ec) || 900) + 40, 6000);
    await send('Emulation.setDeviceMetricsOverride', { width: VW, height: h, deviceScaleFactor: 1, mobile: VW < 500 });
    await sleep(900);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(require('path').join(outDir, shotArg + '.png'), Buffer.from(s.data, 'base64'));
    console.log('截图 →', require('path').join(outDir, shotArg + '.png'), '高度', h);
  }

  proc.kill();
  process.exit(0);
})();
