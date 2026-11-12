const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/finance-books');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9551;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1400', 'about:blank'], { stdio: 'ignore' });
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1400, deviceScaleFactor: 1, mobile: false });
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
  const clickText = async (sel, text, wait = 1200) => {
    const r = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return r;
  };
  const setPeriod = async (p) => {
    await ev(`(()=>{const s=document.querySelector('.head-ops select');if(!s)return false;
      s.value='${p}';s.dispatchEvent(new Event('change'));return true})()`);
    await sleep(1500);
  };

  await send('Page.navigate', { url: BASE + '/finance-books' });
  await sleep(4500);
  console.log('期间', await ev('document.querySelector(".head-ops select")?.value'));
  console.log('净利', await ev('document.querySelectorAll(".stat strong")[2]?.textContent'));
  await shot('01-资产负债表');

  await clickText('.mini-tabs button', '利润表');
  await shot('02-利润表');

  await clickText('.mini-tabs button', '现金流量表');
  await shot('03-现金流量表');

  await clickText('.mini-tabs button', '试算平衡表');
  console.log('试算行数', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  await shot('04-试算平衡表');

  await clickText('.tabs button', '会计凭证');
  console.log('凭证数', await ev('document.querySelectorAll(".vch-tbl tbody tr").length'));
  await shot('05-会计凭证');
  const opened = await ev(`(()=>{const b=document.querySelector('.vch-tbl tbody tr button');if(b){b.click();return true}return false})()`);
  await sleep(1100);
  await shot('06-凭证分录');
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal-ops button')].find(x=>x.textContent.includes('关闭'));if(b)b.click()})()`);
  await sleep(600);

  await clickText('.tabs button', '关账检查', 1600);
  console.log('检查项', await ev('document.querySelectorAll(".check-item").length'));
  console.log('已关账月失败项', await ev('document.querySelectorAll(".check-item.fail,.check-item.warnc").length'));
  await shot('07-关账检查-已关账');

  // 切到当期（未关账）
  await setPeriod('2026-10');
  await clickText('.tabs button', '关账检查', 1800);
  console.log('当期状态', await ev('document.querySelector(".close-head .pill")?.textContent.trim()'));
  console.log('当期失败项', await ev('document.querySelectorAll(".check-item.fail,.check-item.warnc").length'));
  await shot('08-关账检查-未关账');

  await clickText('.tabs button', '科目表');
  await shot('09-科目表');

  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE + '/finance-books' });
  await sleep(4000);
  await shot('10-移动端');

  console.log('弹窗提示', JSON.stringify(dialogs));
  try { proc.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
})();
