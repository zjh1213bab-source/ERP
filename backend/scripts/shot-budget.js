const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/budget';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9591;
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
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
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
    await sleep(1500);
  };

  await send('Page.navigate', { url: BASE + '/budget' });
  await sleep(4500);
  console.log('部门卡片', await ev('document.querySelectorAll(".dept-card").length'));
  console.log('明细行', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  console.log('预算号', await ev('document.querySelector(".page-head .pill")?.textContent.trim()'));
  await shot('01-执行与差异');

  await clickTab('预算编制');
  console.log('版本行', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  console.log('矩阵输入框', await ev('document.querySelectorAll(".cell-input").length'));
  await shot('02-预算编制');

  await clickTab('调整单');
  console.log('调整单', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  await shot('03-调整单');
  await ev(`(()=>{const b=[...document.querySelectorAll('.tb-tbl tbody tr button')].find(x=>x.textContent.trim()==='批准');if(b)b.click();return !!b})()`);
  await sleep(1400);
  console.log('批准后提示', dialogs[dialogs.length - 1] || '(无)');
  await shot('04-调整单批准后');

  await clickTab('超支留痕');
  console.log('超支行', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  await shot('05-超支留痕');
  await ev(`(()=>{const b=[...document.querySelectorAll('.tb-tbl tbody tr button')].find(x=>x.textContent.includes('确认'));if(b)b.click();return !!b})()`);
  await sleep(900);
  await shot('06-超支确认弹窗');
  await closeModal();

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/budget' });
  await sleep(4200);
  await shot('07-移动端');
  console.log('对话框', JSON.stringify(dialogs.slice(-3)));

  proc.kill();
  process.exit(0);
})();
