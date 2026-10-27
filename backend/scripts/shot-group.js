const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/group';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9611;
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
  const clickTab = async (text, wait = 1600) => {
    await closeModal();
    const ok = await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return ok;
  };
  const setPeriod = async (val) => {
    await ev(`(()=>{const s=document.querySelector('.seg-period select, .ic-period select');if(!s)return false;s.value='${val}';s.dispatchEvent(new Event('change'));return true})()`);
    await sleep(1400);
  };

  await send('Page.navigate', { url: BASE + '/group-books' });
  await sleep(4600);

  console.log('主体卡片数', await ev('document.querySelectorAll(".co-card").length'));
  await shot('01-主体与账套');

  await clickTab('分部对比');
  await setPeriod('2026-09');
  console.log('分部行数', await ev('document.querySelectorAll(".seg-tbl tbody tr").length'));
  await shot('02-分部对比');

  await clickTab('内部往来');
  await setPeriod('2026-09');
  console.log('IC行数', await ev('document.querySelectorAll(".ic-tbl tbody tr").length'), '差异行', await ev('document.querySelectorAll(".ic-tbl tbody tr.row-error").length'));
  await shot('03-内部往来');

  // 登记内部单位弹窗
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('登记内部单位'));if(b)b.click();return true})()`);
  await sleep(900);
  await shot('04-登记内部往来单位');
  await closeModal();

  await clickTab('合并报表', 2200);
  console.log('合并横幅', await ev('document.querySelector(".cn-banner-l b")?.textContent?.trim()'));
  await shot('05-合并报表');
  await ev('window.scrollTo(0, document.body.scrollHeight * 0.45)');
  await sleep(600);
  await shot('06-合并抵消分录');
  await ev('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(600);
  await shot('07-合并历史');

  // 主体编辑弹窗
  await clickTab('主体与账套');
  await ev(`(()=>{const b=[...document.querySelectorAll('.co-card button')].find(x=>x.textContent.includes('编辑'));if(b)b.click();return true})()`);
  await sleep(900);
  await shot('08-主体编辑');
  await closeModal();

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/group-books' });
  await sleep(4200);
  await shot('09-移动端');
  await clickTab('合并报表', 2200);
  await shot('10-移动端-合并');
  console.log('横向溢出', await ev('document.documentElement.scrollWidth + "/" + document.documentElement.clientWidth'));

  if (dialogs.length) console.log('弹窗提示:', dialogs.join(' | '));
  proc.kill();
  process.exit(0);
})();
