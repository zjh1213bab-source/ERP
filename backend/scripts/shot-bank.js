const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/bank';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9601;
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
  const closeModal = async () => {
    await ev(`(()=>{const b=[...document.querySelectorAll('.modal .x, .modal-foot button')].find(x=>/×|取消|关闭/.test(x.textContent));if(b){b.click();return true}return false})()`);
    await sleep(400);
  };
  const clickTab = async (text) => {
    await closeModal();
    await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('${text}'));if(b)b.click();return !!b})()`);
    await sleep(1600);
  };

  await send('Page.navigate', { url: BASE + '/bank' });
  await sleep(4500);
  console.log('流水行数', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  console.log('概览未匹配', await ev('document.querySelector(".head-ops .pill")?.textContent.trim()'));
  await shot('01-银行流水');

  // 匹配弹窗（第一条未匹配）
  const opened = await ev(`(()=>{const tr=[...document.querySelectorAll('.tb-tbl tbody tr')].find(x=>x.textContent.includes('未匹配'));
    if(!tr) return 'no-row'; const b=[...tr.querySelectorAll('button')].find(x=>x.textContent.trim()==='匹配'); if(!b) return 'no-btn'; b.click(); return true})()`);
  console.log('打开匹配弹窗', opened);
  await sleep(1400);
  console.log('候选数', await ev('document.querySelectorAll(".modal .tb-tbl tbody tr").length'));
  await shot('02-匹配弹窗');
  await closeModal();

  await clickTab('银行对账');
  console.log('未达账项', await ev('document.querySelectorAll(".recon-box .tb-tbl tbody tr").length'));
  console.log('调节状态', await ev('document.querySelectorAll(".rb-head .pill")[1]?.textContent.trim()'));
  await shot('03-银行对账');

  await clickTab('票据台账');
  console.log('票据行数', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  await shot('04-票据台账');

  await clickTab('账户与导入');
  console.log('账户行数', await ev('document.querySelectorAll(".tb-tbl")[0]?.querySelectorAll("tbody tr").length'));
  console.log('导入记录', await ev('document.querySelectorAll(".tb-tbl")[2]?.querySelectorAll("tbody tr").length'));
  await shot('05-账户与导入');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/bank' });
  await sleep(4200);
  await shot('06-移动端');
  console.log('对话框', JSON.stringify(dialogs.slice(-3)));

  proc.kill();
  process.exit(0);
})();
