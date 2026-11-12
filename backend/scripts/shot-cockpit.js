const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/cockpit');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9631;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1320', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const dialogs = [];
  ws.onmessage = (evt) => {
    const m = JSON.parse(evt.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message.slice(0, 100));
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
    if (r.exceptionDetails) console.log('JS异常', String(r.exceptionDetails.text).slice(0, 180));
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
  const clickTab = async (text, wait = 1700) => {
    await closeModal();
    const ok = await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return ok;
  };

  await send('Page.navigate', { url: BASE + '/cockpit' });
  await sleep(5000);
  console.log('预警条数', await ev('document.querySelectorAll(".warn-row").length'));
  console.log('周数', await ev('document.querySelectorAll(".fc-tbl tbody tr").length'));
  console.log('缺口标签', await ev('document.querySelector(".cell-bad b")?.textContent?.trim()'));
  await shot('01-现金预测');

  await clickTab('账龄分析');
  console.log('分档数', await ev('document.querySelectorAll(".bucket").length'), '明细行', await ev('document.querySelectorAll(".doc-tbl tbody tr").length'));
  await shot('02-应收账龄');
  await ev(`(()=>{const b=[...document.querySelectorAll('.mini-tabs button')].find(x=>x.textContent.includes('应付'));if(b)b.click();return true})()`);
  await sleep(1500);
  await shot('03-应付账龄');

  await clickTab('经营指标', 2200);
  console.log('指标卡', await ev('document.querySelectorAll(".kpi-card").length'), '趋势列', await ev('document.querySelectorAll(".tr-col").length'));
  await shot('04-经营指标');
  await ev('window.scrollTo(0, 620)');
  await sleep(600);
  await shot('05-指标趋势');

  await clickTab('预测回看', 1800);
  console.log('回看周数', await ev('document.querySelectorAll(".va-tbl tbody tr").length'), '达成率', await ev('document.querySelector(".va-cell b")?.textContent?.trim()'));
  await shot('06-预测回看');

  await clickTab('现金预测');
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('历史预测'));if(b)b.click();return true})()`);
  await sleep(1200);
  await shot('07-历史预测');
  await closeModal();

  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/cockpit' });
  await sleep(4600);
  await shot('08-移动端');
  console.log('横向溢出', await ev('document.documentElement.scrollWidth + "/" + document.documentElement.clientWidth'));

  if (dialogs.length) console.log('弹窗:', dialogs.join(' | '));
  proc.kill();
  process.exit(0);
})();
