/**
 * 备份与恢复页截图
 * 用法：启动后端（含前端 dist）→ node scripts/shot-backup.js
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/backup');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  if (!login.ok) { console.log('登录失败', login.message); process.exit(1); }

  const port = 9792;
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
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: '截图用说明' } }));
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

  await send('Page.navigate', { url: BASE + '/backup' });
  await sleep(5000);

  console.log('备份行数', await ev('document.querySelectorAll("tbody tr").length'));
  console.log('指标卡', await ev('(()=>[...document.querySelectorAll(".stat-card")].map(x=>x.textContent.replace(/\\s+/g," ").trim()).join(" ; "))()'));
  await shot('01-备份历史');

  // 数据健康
  await clickText('.tabs button', '数据健康', 1200);
  console.log('健康项', await ev('document.querySelectorAll(".check-row").length'),
    '/ 异常', await ev('document.querySelectorAll(".check-row.bad").length'));
  await shot('02-数据健康');

  // 恢复确认弹层
  await clickText('.tabs button', '备份历史', 1000);
  await clickText('td.ops .link-btn.strong', '恢复', 900);
  console.log('确认弹层', await ev('!!document.querySelector(".modal-box")'));
  await shot('03-恢复确认');
  await clickText('.modal-ops .btn-ghost', '取消', 700);

  // 恢复怎么做
  await clickText('.tabs button', '恢复怎么做', 900);
  await shot('04-恢复说明');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1000);
  await clickText('.tabs button', '备份历史', 1100);
  await shot('05-移动端');
  console.log('移动端溢出', await ev('(()=>{const d=document.documentElement;return JSON.stringify({scrollW:d.scrollWidth,clientW:d.clientWidth})})()'));

  proc.kill();
  process.exit(0);
})();
