/**
 * 组织编制与岗位截图（M02）
 * 用法：先启动后端 + 前端 dist，再 node scripts/shot-org.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/org';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9661;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1320', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* ignore */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const dialogs = [];
  ws.onmessage = (evt) => {
    const m = JSON.parse(evt.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message.slice(0, 120));
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
  const shot = async (name, viewportOnly = false) => {
    const s = await send('Page.captureScreenshot', viewportOnly ? { format: 'png' } : { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const clickText = async (sel, text, wait = 1200) => {
    const ok = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return ok;
  };
  const closeModal = async () => {
    await ev(`(()=>{const b=document.querySelector('.modal .x');if(b){b.click();return true}return false})()`);
    await sleep(500);
  };

  await send('Page.navigate', { url: BASE + '/organization' });
  await sleep(5200);
  console.log('部门卡', await ev('document.querySelectorAll(".dept-card").length'),
    '岗位行', await ev('document.querySelectorAll(".pos-row").length'),
    '超编行', await ev('document.querySelectorAll(".pr-bad").length'));
  await shot('01-岗位与编制');

  // 汇报关系
  await clickText('.seg button', '汇报关系', 1300);
  console.log('树行', await ev('document.querySelectorAll(".tree-row").length'));
  await shot('02-汇报关系');
  await clickText('.seg button', '按部门', 1200);

  // 岗位详情：点「版师」（满编）
  await ev(`(()=>{const r=[...document.querySelectorAll('.pos-row')].find(x=>x.textContent.includes('版师'));if(r){r.click();return true}return false})()`);
  await sleep(1300);
  console.log('门槛块', await ev('document.querySelectorAll(".gate").length'),
    '在岗行', await ev('document.querySelectorAll(".modal .data tbody tr").length'));
  await shot('03-岗位编制详情');

  // 汇报链折叠在同页，滚一下看链
  await closeModal();

  // 任职关系
  await clickText('.tabs button', '任职关系', 1500);
  console.log('任职行', await ev('document.querySelectorAll("table.data tbody tr").length'),
    '待批行', await ev('document.querySelectorAll(".row-pending").length'));
  await shot('04-任职关系');

  // 批准超编：找待批的那行点「批准」
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('待批'));if(!tr)return false;const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('批准'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  console.log('超编提示', await ev('document.querySelectorAll(".modal .pw-blocked").length'));
  await shot('05-满编拦截与超编特批');
  await closeModal();

  // 任职详情
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('生效中'));if(!tr)return false;const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('详情'));if(b){b.click();return true}return false})()`);
  await sleep(1300);
  await shot('06-任职详情');

  await closeModal();

  // 交易路线
  await clickText('.tabs button', '交易路线', 1500);
  console.log('路线卡', await ev('document.querySelectorAll(".route-card").length'),
    '缺协议', await ev('document.querySelectorAll(".route-card.rc-bad").length'));
  await shot('07-交易路线');

  await ev(`(()=>{const b=[...document.querySelectorAll('.route-card .link-btn')].find(x=>x.textContent.includes('详情'));if(b){b.click();return true}return false})()`);
  await sleep(1200);
  await shot('08-路线详情');
  await closeModal();

  // 主体视图
  await clickText('.tabs button', '主体视图', 1500);
  console.log('授权行', await ev('document.querySelectorAll("table.data tbody tr").length'));
  await shot('09-主体授权范围');

  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/organization' });
  await sleep(4600);
  await shot('10-移动端');
  console.log('横向溢出', await ev('document.documentElement.scrollWidth + "/" + document.documentElement.clientWidth'));

  if (dialogs.length) console.log('弹窗:', dialogs.join(' | '));
  proc.kill();
  process.exit(0);
})();
