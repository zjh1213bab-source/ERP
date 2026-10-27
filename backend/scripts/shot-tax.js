/**
 * 税负测算截图（M12）
 * 用法：先启动后端 + 前端 dist，再 node scripts/shot-tax.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/tax';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9671;
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

  await send('Page.navigate', { url: BASE + '/tax' });
  await sleep(5200);
  console.log('批次行', await ev('document.querySelectorAll("table.data tbody tr").length'),
    '趋势列', await ev('document.querySelectorAll(".tr-col").length'));
  await shot('01-税负测算入口');

  // 选 9 月并测算
  await ev(`(()=>{const i=document.querySelector('.toolbar input[type=month]');if(!i)return false;i.value='2026-09';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(500);
  await clickText('.toolbar .btn', '测算', 2400);
  console.log('指标块', await ev('document.querySelectorAll(".cg-item").length'),
    '警示', await ev('document.querySelectorAll(".warn-row").length'),
    '算式行', await ev('document.querySelectorAll(".calc-card table.data tbody tr").length'));
  await shot('02-测算结果与算式');

  // 整页很高，先把视口拉高再截（内层容器自己滚，截视口会截不到下半页）
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 2100, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  await shot('03-整页（算式与批次趋势）');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1320, deviceScaleFactor: 1, mobile: false });
  await sleep(600);

  // 打开 10 月草稿（进货月留抵）
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('2026-10'));if(!tr)return false;const b=tr.querySelector('.link-btn');if(b){b.click();return true}return false})()`);
  await sleep(1400);
  console.log('明细行', await ev('document.querySelectorAll(".modal table.data tbody tr").length'),
    '税率快照', await ev('document.querySelectorAll(".modal .kv > div").length'));
  await shot('05-批次明细与当时税率');

  // 作废弹窗
  await clickText('.modal-foot .btn', '作废', 1200);
  await shot('06-作废须写原因');
  await ev(`(()=>{const b=document.querySelector('.modal .x');if(b){b.click();return true}return false})()`);
  await sleep(500);

  // 税政配置
  await clickText('.tabs button', '税政配置', 1500);
  console.log('政策行', await ev('document.querySelectorAll("table.data tbody tr").length'));
  await shot('07-税政配置');
  await clickText('.toolbar .btn', '新增税率', 1200);
  await shot('08-新增税率');
  await ev(`(()=>{const b=document.querySelector('.modal .x');if(b){b.click();return true}return false})()`);
  await sleep(500);

  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/tax' });
  await sleep(4600);
  await shot('09-移动端');
  console.log('横向溢出', await ev('document.documentElement.scrollWidth + "/" + document.documentElement.clientWidth'));

  if (dialogs.length) console.log('弹窗:', dialogs.join(' | '));
  proc.kill();
  process.exit(0);
})();
