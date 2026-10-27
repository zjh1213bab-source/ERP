const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/dataquality';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9531;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1320', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* retry */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const dialogs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message.slice(0, 80));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1320, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + login.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('JS异常', String(r.exceptionDetails.text).slice(0, 160));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const clickTab = async (text) => {
    // 切页签前先关掉可能还开着的弹窗
    await ev(`(()=>{const b=[...document.querySelectorAll('.modal-ops button')].find(x=>x.textContent.trim()==='取消');if(b){b.click();return true}return false})()`);
    await sleep(400);
    await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('${text}'));if(b)b.click();return !!b})()`);
    await sleep(1200);
  };

  await send('Page.navigate', { url: BASE + '/data-quality' });
  await sleep(4200);

  console.log('健康分', await ev('document.querySelector(".stat-health strong")?.textContent'));
  console.log('规则行数', await ev('document.querySelectorAll(".ov-tbl tbody tr").length'));
  await shot('01-勾稽总览');

  await clickTab('问题明细');
  console.log('问题行数', await ev('document.querySelectorAll(".issue-tbl tbody tr").length'));
  await shot('02-问题明细');

  // 打开忽略弹窗（不提交）
  await ev(`(()=>{const b=[...document.querySelectorAll('.issue-tbl tbody tr button')].find(x=>x.textContent.trim()==='忽略');if(b)b.click();return !!b})()`);
  await sleep(700);
  await shot('03-忽略必须写理由');

  await clickTab('三账对齐');
  console.log('对齐行数', await ev('document.querySelectorAll(".rec-tbl tbody tr").length'));
  await shot('04-三账对齐');

  await clickTab('执行历史');
  console.log('历史批次数', await ev('document.querySelectorAll(".run-tbl tbody tr").length'));
  console.log('修复留痕', await ev('document.querySelectorAll(".fix-tbl tbody tr").length'));
  await shot('05-执行历史与修复留痕');

  await clickTab('规则说明');
  console.log('规则条数', await ev('document.querySelectorAll(".rule-tbl tbody tr").length'));
  await shot('06-规则说明');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE + '/data-quality' });
  await sleep(3500);
  await shot('07-移动端');

  console.log('弹窗提示', JSON.stringify(dialogs));
  try { proc.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
})();
