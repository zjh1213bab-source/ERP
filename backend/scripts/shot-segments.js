/**
 * 分公司经营对比截图（M12）
 * 用法：先 node scripts/seed-segment-demo.js --reset，启动后端（含前端 dist），再运行
 *   node scripts/shot-segments.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/segments';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9743;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1700', 'about:blank'], { stdio: 'ignore' });
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
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1700, deviceScaleFactor: 1, mobile: false });
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
  const clickText = async (sel, text, wait = 1000) => {
    const done = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return done;
  };

  await send('Page.navigate', { url: BASE + '/segments' });
  await sleep(5200);
  // 切到 2026-09（有完整对比数据）
  await ev(`(()=>{const i=document.querySelector('.page-head input[type=month]');if(!i)return false;i.value='2026-09';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(2500);
  console.log('统计卡', await ev('document.querySelectorAll(".stat").length'),
    '主体行', await ev('document.querySelectorAll("table.data tbody tr").length'));
  await shot('01-分部对比总表');

  // 拉高视口看完整表 + 口径问题
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 2100, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  await shot('02-口径问题清单');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1700, deviceScaleFactor: 1, mobile: false });
  await sleep(600);

  // 下钻义乌（内部依赖 100%）
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('义乌'));if(!tr)return false;const a=tr.querySelector('.lnk');if(a){a.click();return true}return false})()`);
  await sleep(2200);
  await shot('03-单主体下钻');
  await clickText('.modal-foot .btn', '关闭', 700);

  // 可比调整
  await clickText('.tabs button', '可比口径调整', 1500);
  await shot('04-可比口径调整');
  await clickText('.page-head .btn', '', 200);
  const adjOpened = await ev(`(()=>{const b=[...document.querySelectorAll('.btn')].find(x=>x.textContent.includes('登记调整'));if(b){b.click();return true}return false})()`);
  await sleep(1200);
  console.log('调整弹窗', adjOpened);
  await shot('05-登记调整');
  await clickText('.modal-foot .btn', '取消', 700);

  // 报告快照
  await clickText('.tabs button', '报告快照', 1500);
  await shot('06-报告快照列表');
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('已确认'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(x=>x.textContent.includes('查看'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  await shot('07-已确认报告冻结');
  await clickText('.modal-foot .btn', '关闭', 700);

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(900);
  await clickText('.tabs button', '对比总表', 1600);
  await shot('08-移动端');
  const overflow = await ev('(()=>{const d=document.documentElement;return {scrollW:d.scrollWidth, clientW:d.clientWidth}})()');
  console.log('移动端横向溢出检查', JSON.stringify(overflow));

  proc.kill();
  process.exit(0);
})();
