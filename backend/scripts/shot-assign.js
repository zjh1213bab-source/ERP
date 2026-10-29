/**
 * 生产分配（待分配订单 → 本厂 / 整单外发）—— 截图取证
 * 用法：先 node scripts/seed-assign-demo.js --reset，启动后端（含前端 dist），再运行
 *   node scripts/shot-assign.js
 *
 * 关键是第 3→4 步：**真的把按钮按下去**，然后看节点是否变绿、工厂列是否变。
 * 只看按钮长什么样"不算验证过"——按钮能点、点完数据变了，才算关联上了。
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/assign';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  try {
    require('child_process').execSync('node seed-assign-demo.js --reset', { cwd: __dirname, stdio: 'ignore' });
    console.log('演示数据已重建');
  } catch (e) {
    console.log('演示数据重建失败：', e.message);
  }
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9745;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1500', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* ignore */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  /** confirm() 由这里决定：默认拒绝（免误点），要按下去的步骤先设成 true */
  let dialogAccept = false;
  const dialogLog = [];
  ws.onmessage = (evt) => {
    const m = JSON.parse(evt.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogLog.push(m.params.message);
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: dialogAccept } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1500, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + login.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('JS异常', String(r.exceptionDetails.text).slice(0, 200));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const clickText = async (sel, text, wait = 900) => {
    const done = await ev(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return done;
  };
  const tabCounts = () => ev(`(()=>[...document.querySelectorAll('.po-tab')].map(t=>t.textContent.replace(/\\s+/g,'')).join(' | '))()`);
  const rowInfo = (no) => ev(`(()=>{const r=[...document.querySelectorAll('.po-item')].find(x=>x.textContent.includes(${JSON.stringify(no)}));if(!r)return null;const rows=[...r.querySelectorAll('.po-row')].map(x=>x.textContent.replace(/\\s+/g,'').trim());const tags=[...r.querySelectorAll('.po-tag')].map(x=>x.textContent.trim());const cells=[...r.querySelectorAll('.po-fnode')].slice(0,2).map(c=>c.textContent.replace(/\\s+/g,'').slice(0,14));return {rows,tags,cells}})()`);

  await send('Page.navigate', { url: BASE + '/order-tracking' });
  await sleep(6000);
  console.log('页签：', await tabCounts());
  console.log('ASG-DEMO-1：', JSON.stringify(await rowInfo('ASG-DEMO-1')));
  console.log('ASG-DEMO-3：', JSON.stringify(await rowInfo('ASG-DEMO-3')));
  await shot('01-看板-工厂列与页签');

  // ---------- ② 待分配订单页签 ----------
  await clickText('.po-tab', '待分配订单', 1200);
  console.log('待分配页签后条数：', await ev('document.querySelectorAll(".po-item").length'));
  await shot('02-待分配订单页签');

  // ---------- ③ 点开 ASG-DEMO-1 的「待分配订单」格子 ----------
  const opened = await ev(`(()=>{const r=[...document.querySelectorAll('.po-item')].find(x=>x.textContent.includes('ASG-DEMO-1'));if(!r)return false;const c=r.querySelector('.po-fnode-in');if(!c)return false;c.click();return true})()`);
  await sleep(1600);
  const head = await ev(`(()=>{const h=document.querySelector('.np-modal .modal-head');return h?h.textContent.replace(/\\s+/g,' ').trim():null})()`);
  const strip = await ev(`(()=>{const s=document.querySelector('.np-astrip');return s?s.textContent.replace(/\\s+/g,' ').trim():null})()`);
  const btns = await ev(`(()=>[...document.querySelectorAll('.np-actions .btn')].map(b=>b.textContent.trim()).join(' / '))()`);
  console.log('弹窗：', opened, '|', head);
  console.log('分配条：', strip);
  console.log('按钮：', btns);
  await shot('03-点开待分配订单-分配按钮');

  // ---------- ④ 真的按下去：分配本厂 ----------
  dialogAccept = true;
  await clickText('.np-actions .btn', '分配本厂生产', 2600);
  dialogAccept = false;
  console.log('确认框内容：', JSON.stringify(dialogLog));
  const strip2 = await ev(`(()=>{const s=document.querySelector('.np-astrip');return s?s.textContent.replace(/\\s+/g,' ').trim():null})()`);
  const dlist = await ev(`(()=>[...document.querySelectorAll('.np-drow')].map(d=>d.textContent.replace(/\\s+/g,' ').trim()).join(' | '))()`);
  const warn = await ev(`(()=>{const w=document.querySelector('.np-warn');return w?w.textContent.replace(/\\s+/g,' ').trim():null})()`);
  console.log('分配后：', strip2);
  console.log('分单行：', dlist);
  console.log('提示：', warn);
  await shot('04-分配本厂后-节点已完成');

  // 关弹窗，切到「本厂生产」页签 —— 分配完这张单应该自己跑到那边去
  await ev(`(()=>{const b=document.querySelector('.np-foot .btn');if(b)b.click()})()`);
  await sleep(1200);
  await clickText('.po-tab', '本厂生产', 1400);
  console.log('本厂生产页签条数：', await ev('document.querySelectorAll(".po-item").length'));
  console.log('ASG-DEMO-1 分配后：', JSON.stringify(await rowInfo('ASG-DEMO-1')));
  await shot('05-看板-已分配本厂');

  // ---------- ⑤ 整单外发页签 + 成本未审的单 ----------
  await clickText('.po-tab', '整单外发', 1400);
  console.log('整单外发页签后：', await ev('document.querySelectorAll(".po-item").length'), JSON.stringify(await rowInfo('ASG-DEMO-3')));
  await shot('06-整单外发页签');

  await clickText('.po-tab', '待分配订单', 1200);
  const opened2 = await ev(`(()=>{const r=[...document.querySelectorAll('.po-item')].find(x=>x.textContent.includes('ASG-DEMO-2'));if(!r)return false;const c=r.querySelector('.po-fnode-in');if(c){c.click();return true}return false})()`);
  await sleep(1500);
  const warn2 = await ev(`(()=>{const w=document.querySelector('.np-warn');return w?w.textContent.replace(/\\s+/g,' ').trim():null})()`);
  const hasBtns = await ev(`document.querySelectorAll('.np-actions .btn').length`);
  console.log('成本未审单：', opened2, '| 提示：', warn2, '| 按钮数：', hasBtns);
  await shot('07-成本未审-按钮不给点');

  console.log('完成。');
  try { proc.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
})();
