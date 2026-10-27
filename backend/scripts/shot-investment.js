/**
 * 现货经营与备货截图（M19）
 * 用法：先 node scripts/seed-spotops-demo.js --reset，启动后端（含前端 dist），再运行
 *   node scripts/shot-spotops.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/investment';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  // 截图过程会改单据状态（开始盘点 / 取消盘点），先重置演示数据保证可重复跑
  try {
    require('child_process').execSync('node seed-investment-demo.js --reset', { cwd: __dirname, stdio: 'ignore' });
    console.log('演示数据已重置');
  } catch (e) {
    console.log('演示数据重置失败', e.message);
  }
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9761;
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
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: '演示用说明文字' } }));
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
  const scrollTo = async (y) => {
    await ev(`(()=>{const el=document.querySelector('.erp-content');if(el){el.scrollTop=${y};return el.scrollTop}return -1})()`);
    await sleep(450);
  };

  await send('Page.navigate', { url: BASE + '/investment' });
  await sleep(5200);
  console.log('统计卡', await ev('document.querySelectorAll(".stat").length'),
    '投资行', await ev('document.querySelectorAll("table.data tbody tr").length'));
  await shot('01-长期投资列表');

  // 全资子公司（成本法）
  let ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('USA'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('明细'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  console.log('美国子公司', ok);
  await shot('02-全资子公司-成本法');
  await clickText('.modal-ops .btn', '关闭', 700);

  // 非全资子公司（权益法）
  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('越南'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('明细'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  console.log('越南子公司', ok);
  await shot('03-非全资子公司-权益法');
  await clickText('.modal-ops .btn', '关闭', 700);

  // 抵消预览：演示数据在 2026-09
  await clickText('.tabs button', '抵消预览', 1600);
  await ev(`(()=>{const i=document.querySelector('.toolbar input');if(!i)return false;i.value='2026-09';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(2200);
  await shot('04-抵消预览');
  await ev(`(()=>{const el=document.querySelector('.erp-content');if(el){el.scrollTop=760;return el.scrollTop}return -1})()`);
  await sleep(900);
  await shot('05-抵消分录与平衡自检');

  // 新建投资弹窗
  await ev(`(()=>{const el=document.querySelector('.erp-content');if(el){el.scrollTop=0}})()`);
  await clickText('.tabs button', '长期股权投资', 1200);
  await clickText('.page-head .btn', '新建投资', 1200);
  await shot('06-新建投资');
  await clickText('.modal-ops .btn', '取消', 700);

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await clickText('.tabs button', '长期股权投资', 1500);
  await shot('07-移动端');
  const overflow = await ev('(()=>{const d=document.documentElement;return {scrollW:d.scrollWidth, clientW:d.clientWidth}})()');
  console.log('移动端横向溢出检查', JSON.stringify(overflow));

  proc.kill();
  process.exit(0);
})();