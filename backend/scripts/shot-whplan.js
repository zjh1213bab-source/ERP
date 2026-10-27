/**
 * 美仓作业计划截图（M19）
 * 用法：先启动后端（含前端 dist），再 node scripts/shot-whplan.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/whplan';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9689;
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
  const clickText = async (sel, text, wait = 1200) => {
    const done = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return done;
  };

  await send('Page.navigate', { url: BASE + '/wh-plan' });
  await sleep(5400);
  console.log('波次行', await ev('document.querySelectorAll("table.data tbody tr").length'),
    '统计卡', await ev('document.querySelectorAll(".stat").length'));
  await shot('01-拣货波次');

  // 生成波次弹窗（候选与不可选原因）
  await clickText('.btn', '生成波次', 1600);
  await shot('02-生成波次与候选占用');
  await clickText('.modal-foot .btn', '取消', 700);

  // 波次详情：挑「已复核待发」那条，能看到短拣与称重
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('已复核待发'));if(!tr)return false;const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('详情'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  await shot('03-波次详情与短拣');
  await clickText('.modal-foot .btn', '关闭', 700);

  // 头程
  await clickText('.tabs button', '跨境头程', 1600);
  await shot('04-头程在途');

  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('WHP-ASN-001'));if(!tr)return false;const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('详情'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  await shot('05-头程段与箱差异');
  await ev(`(()=>{const b=document.querySelector('.modal-body');if(b){b.scrollTop=420;return b.scrollTop}return 0})()`);
  await sleep(500);
  await shot('06-头程变更与受影响需求');
  await clickText('.modal-foot .btn', '关闭', 700);

  // 库容
  await clickText('.tabs button', '库容规划', 1600);
  // 先算一次「放得下」的建议，再演示「放不下」
  await ev(`(()=>{const b=[...document.querySelectorAll('.sug-row .btn')].find(x=>x.textContent.includes('算一下'));if(b){b.click();return true}return false})()`);
  await sleep(1200);
  await shot('07-库容与上架建议');

  // 放不下：把数量改成 999999 再算一次
  await ev(`(()=>{const i=document.querySelector('.sug-row input[type=number]');if(!i)return false;i.value='999999';i.dispatchEvent(new Event('input',{bubbles:true}));const b=[...document.querySelectorAll('.sug-row .btn')].find(x=>x.textContent.includes('算一下'));if(b){b.click();return true}return false})()`);
  await sleep(1200);
  await shot('08-上架建议的拒绝');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await clickText('.tabs button', '拣货波次', 1400);
  await shot('09-移动端');
  const overflow = await ev(`(()=>{const d=document.documentElement;return {scrollW:d.scrollWidth,clientW:d.clientWidth}})()`);
  console.log('移动端横向溢出检查', JSON.stringify(overflow));

  proc.kill();
  process.exit(0);
})();
