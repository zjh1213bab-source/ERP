/**
 * 岗位权限复核截图
 * 用法：node scripts/seed-access-demo.js && 启动后端（含前端 dist）→ node scripts/shot-access.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/access';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  if (!login.ok) { console.log('登录失败', login.message); process.exit(1); }

  const port = 9798;
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
  ws.onmessage = (evt) => {
    const m = JSON.parse(evt.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
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
    if (r.exceptionDetails) console.log('JS异常', String(r.exceptionDetails.text).slice(0, 160));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const clickText = async (sel, text, wait = 900) => {
    const done = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return done;
  };

  await send('Page.navigate', { url: BASE + '/access-review' });
  await sleep(5000);

  console.log('矩阵行数', await ev('document.querySelectorAll("table.matrix tbody tr").length'));
  console.log('角色列', await ev('(()=>[...document.querySelectorAll("table.matrix thead tr th")].map(x=>x.textContent.trim()).join("|"))()'));
  console.log('指标卡', await ev('(()=>[...document.querySelectorAll(".stat-card")].map(x=>x.textContent.replace(/\\s+/g," ").trim()).join(" ; "))()'));
  await shot('01-岗位矩阵');

  // 搜一个权限点
  await ev(`(()=>{const i=document.querySelector('input.input');i.value='payroll';i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(700);
  console.log('搜索 payroll 行数', await ev('document.querySelectorAll("table.matrix tbody tr").length'));
  await shot('02-矩阵搜索');

  // 账号复核：展开 sales01
  await clickText('.tabs button', '账号复核', 1400);
  console.log('账号卡片', await ev('document.querySelectorAll(".user-card").length'));
  await ev(`(()=>{const c=[...document.querySelectorAll('.user-card')].find(x=>x.textContent.includes('sales01'));if(!c)return false;c.querySelector('.uc-head').click();return true})()`);
  await sleep(1000);
  console.log('例外条数', await ev('document.querySelectorAll(".exc-row").length'));
  await shot('03-账号复核-展开例外');

  // 职责分离
  await clickText('.tabs button', '职责分离', 1400);
  console.log('SOD 卡片', await ev('document.querySelectorAll(".sod-card").length'),
    '有冲突', await ev('document.querySelectorAll(".sod-card.hit").length'));
  await shot('04-职责分离');

  // 复核记录
  await clickText('.tabs button', '复核记录', 1600);
  console.log('记录行', await ev('document.querySelectorAll(".table-wrap tbody tr").length'));
  await shot('05-复核记录');

  // 签字弹窗
  await clickText('.head-ops .btn', '复核签字', 900);
  console.log('弹窗', await ev('!!document.querySelector(".modal-box")'));
  await shot('06-签字弹窗');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal-ops .btn')].find(x=>x.textContent.includes('取消'));if(b)b.click();return true})()`);
  await sleep(600);
  await clickText('.tabs button', '账号复核', 1400);
  await ev(`(()=>{const c=[...document.querySelectorAll('.user-card')].find(x=>x.textContent.includes('sales01'));if(!c)return false;c.querySelector('.uc-head').click();return true})()`);
  await sleep(1000);
  await shot('07-移动端');
  console.log('移动端溢出', await ev('(()=>{const d=document.documentElement;return JSON.stringify({scrollW:d.scrollWidth,clientW:d.clientWidth})})()'));

  proc.kill();
  process.exit(0);
})();
