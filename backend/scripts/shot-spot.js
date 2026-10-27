const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/spot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9561;
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
      dialogs.push(m.params.message.slice(0, 60));
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
    await ev(`(()=>{const b=[...document.querySelectorAll('.modal-ops button')].find(x=>/取消|关闭/.test(x.textContent));if(b){b.click();return true}return false})()`);
    await sleep(400);
  };
  const clickTab = async (text) => {
    await closeModal();
    await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('${text}'));if(b)b.click();return !!b})()`);
    await sleep(1400);
  };

  await send('Page.navigate', { url: BASE + '/spot-analysis' });
  await sleep(4500);
  console.log('平均库龄', await ev('document.querySelectorAll(".stat strong")[1]?.textContent'));
  console.log('库龄行数', await ev('document.querySelectorAll(".age-tbl tbody tr").length'));
  await shot('01-库龄分布');

  // 展开老货明细
  const exp = await ev(`(()=>{const tr=[...document.querySelectorAll('.age-tbl tbody tr')].find(x=>x.textContent.includes('SPOT-A'));
    if(!tr) return false; const b=[...tr.querySelectorAll('button')].find(x=>x.textContent.includes('明细'));
    if(!b) return false; b.click(); return true})()`);
  console.log('展开老货', exp);
  await sleep(900);
  await shot('02-库龄批次明细');

  await clickTab('动销与周转');
  console.log('动销行数', await ev('document.querySelectorAll(".turn-tbl tbody tr").length'));
  await shot('03-动销与周转');

  await clickTab('滞销清单');
  console.log('滞销行数', await ev('document.querySelectorAll(".slow-tbl tbody tr").length'));
  await shot('04-滞销清单');

  await clickTab('退货处理');
  console.log('退货行数', await ev('document.querySelectorAll(".rt-tbl tbody tr").length'));
  await shot('05-退货列表');

  // 打开判定弹窗（RT-002 待判定）
  const opened = await ev(`(()=>{const tr=[...document.querySelectorAll('.rt-tbl tbody tr')].find(x=>x.textContent.includes('RT-DEMO-002'));
    if(!tr) return 'no-row'; const b=[...tr.querySelectorAll('button')].find(x=>x.textContent.trim()==='判定');
    if(!b) return 'no-btn'; b.click(); return 'ok'})()`);
  console.log('打开判定弹窗', opened);
  await sleep(1300);
  await shot('06-判定弹窗');
  await closeModal();

  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE + '/spot-analysis' });
  await sleep(4000);
  await shot('07-移动端');

  console.log('弹窗提示', JSON.stringify(dialogs));
  try { proc.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
})();
