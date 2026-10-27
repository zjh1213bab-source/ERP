const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/warehouse';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9541;
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
    await sleep(1300);
  };

  await send('Page.navigate', { url: BASE + '/overseas-warehouse' });
  await sleep(4500);

  console.log('发运单行数', await ev('document.querySelectorAll(".asn-tbl tbody tr").length'));
  console.log('点收单行数', await ev('document.querySelectorAll(".rcv-tbl tbody tr").length'));
  await shot('01-到仓与上架');

  // 点收弹窗（ASN-DEMO-002）
  const opened = await ev(`(()=>{
    const rows=[...document.querySelectorAll('.asn-tbl tbody tr')];
    const tr=rows.find(x=>x.textContent.includes('ASN-DEMO-002'));
    if(!tr) return 'no-row';
    const b=[...tr.querySelectorAll('button')].find(x=>x.textContent.trim()==='点收');
    if(!b) return 'no-btn';
    b.click(); return 'ok';
  })()`);
  console.log('打开点收弹窗', opened);
  await sleep(1200);
  await shot('02-点收弹窗');
  await closeModal();

  // 上架弹窗
  const opened2 = await ev(`(()=>{
    const rows=[...document.querySelectorAll('.rcv-tbl tbody tr')];
    const tr=rows.find(x=>x.textContent.includes('RCV-DEMO-001'));
    if(!tr) return 'no-row';
    const b=[...tr.querySelectorAll('button')].find(x=>x.textContent.trim()==='上架');
    if(!b) return 'no-btn';
    b.click(); return 'ok';
  })()`);
  console.log('打开上架弹窗', opened2);
  await sleep(1200);
  await shot('03-上架选库位');
  await closeModal();

  await clickTab('库位与库存');
  console.log('库位卡片', await ev('document.querySelectorAll(".loc-card").length'));
  console.log('库存行', await ev('document.querySelectorAll(".stock-tbl tbody tr").length'));
  await shot('04-库位与库存');

  await clickTab('套装拆组');
  console.log('套装卡片', await ev('document.querySelectorAll(".bundle-card").length'));
  await shot('05-套装拆组');

  // 组装弹窗
  const opened3 = await ev(`(()=>{
    const card=[...document.querySelectorAll('.bundle-card')].find(x=>x.textContent.includes('SET-DEMO-01'));
    if(!card) return 'no-card';
    const b=[...card.querySelectorAll('button')].find(x=>x.textContent.trim()==='组装');
    if(!b) return 'no-btn';
    b.click(); return 'ok';
  })()`);
  console.log('打开组装弹窗', opened3);
  await sleep(900);
  await shot('06-组装弹窗');
  await closeModal();

  await clickTab('运费核对');
  console.log('账单行', await ev('document.querySelectorAll(".bill-tbl tbody tr").length'));
  await shot('07-运费账单列表');

  const opened4 = await ev(`(()=>{
    const tr=[...document.querySelectorAll('.bill-tbl tbody tr')].find(x=>x.textContent.includes('YF-DEMO-01'));
    if(!tr) return 'no-row';
    const b=[...tr.querySelectorAll('button')].find(x=>x.textContent.includes('看明细'));
    if(!b) return 'no-btn';
    b.click(); return 'ok';
  })()`);
  console.log('打开账单明细', opened4);
  await sleep(1400);
  await shot('08-账单明细与差异');
  await closeModal();

  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE + '/overseas-warehouse' });
  await sleep(4000);
  await shot('09-移动端');

  console.log('弹窗提示', JSON.stringify(dialogs));
  try { proc.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
})();
