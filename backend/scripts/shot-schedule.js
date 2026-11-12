/**
 * 有限产能排程截图（M06）
 * 用法：先 node scripts/seed-schedule-demo.js --reset，启动后端（含前端 dist），再运行
 *   node scripts/shot-schedule.js
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/schedule');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9711;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1700', 'about:blank'], { stdio: 'ignore' });
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
  ws.onmessage = (evt) => {
    const m = JSON.parse(evt.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1700, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + login.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('JS异常', String(r.exceptionDetails.text).slice(0, 160));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const clickText = async (sel, text, wait = 1000) => {
    const done = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return done;
  };
  const scrollTo = async (y) => { await ev(`(()=>{const el=document.querySelector('.erp-content');if(el){el.scrollTop=${y};return el.scrollTop}window.scrollTo(0,${y});return -1})()`); await sleep(500); };

  await send('Page.navigate', { url: BASE + '/schedule' });
  await sleep(5200);
  console.log('统计卡', await ev('document.querySelectorAll(".stat").length'),
    '泳道', await ev('document.querySelectorAll(".g-label").length'),
    '任务行', await ev('document.querySelectorAll("table.data tbody tr").length'));
  await shot('01-排程看板甘特');

  await scrollTo(760);
  await shot('02-冲突与风险');

  await scrollTo(1500);
  await shot('03-排程任务清单');

  // 处理硬冲突：切到草稿批次（硬冲突还没处理）
  await scrollTo(0);
  await ev(`(()=>{const sel=document.querySelector('.toolbar select');if(!sel)return false;const opt=[...sel.options].find(o=>o.textContent.includes('草稿'));if(!opt)return false;sel.value=opt.value;sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(1800);
  await scrollTo(760);
  const opened = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>{const b=[...x.querySelectorAll('.btn')].find(y=>y.textContent.trim()==='处理');return !!b});if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.trim()==='处理');b.click();return true})()`);
  await sleep(1200);
  console.log('打开处理弹窗', opened);
  await ev(`(()=>{const t=document.querySelector('.modal-body textarea');if(!t)return false;t.value='已决定把 1500 件拆到外协厂，剩余留本厂排，交期跟客户确认顺延一周';t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(400);
  await shot('04-处理硬冲突');
  await clickText('.modal-foot .btn', '取消', 600);

  // 调整任务
  await scrollTo(1500);
  const adj = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.querySelector('.btn')&&x.textContent.includes('车缝'));if(!tr)return false;const b=tr.querySelector('.btn');if(b&&b.textContent.includes('调整')){b.click();return true}return false})()`);
  await sleep(1200);
  console.log('打开调整弹窗', adj);
  await ev(`(()=>{const t=document.querySelector('.modal-body textarea');if(!t)return false;t.value='等首件确认放行后再整烫，整体推后一天';t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(300);
  await shot('05-调整任务与原因');
  await clickText('.modal-foot .btn', '取消', 600);

  // 批次
  await scrollTo(0);
  await clickText('.tabs button', '排程批次', 1400);
  await shot('06-排程批次版本');

  // 生成排程 + 预演
  await clickText('.page-head .btn', '生成排程', 1600);
  await clickText('.modal-foot .btn', '先预演', 2200);
  await ev(`(()=>{const b=document.querySelector('.modal-body');if(b){b.scrollTop=b.scrollHeight;return b.scrollTop}return 0})()`);
  await sleep(500);
  await shot('07-生成排程与预演');
  await clickText('.modal-foot .btn', '取消', 700);

  // 工序定额
  await clickText('.tabs button', '工序定额', 1400);
  await shot('08-工序定额');

  // 班次日历
  await clickText('.tabs button', '班次日历', 1800);
  await shot('09-班次日历');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1000);
  await clickText('.tabs button', '排程看板', 1600);
  await shot('10-移动端');
  const overflow = await ev('(()=>{const d=document.documentElement;return {scrollW:d.scrollWidth, clientW:d.clientWidth}})()');
  console.log('移动端横向溢出检查', JSON.stringify(overflow));

  proc.kill();
  process.exit(0);
})();
