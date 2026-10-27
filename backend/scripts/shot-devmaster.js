/**
 * 现货经营与备货截图（M19）
 * 用法：先 node scripts/seed-spotops-demo.js --reset，启动后端（含前端 dist），再运行
 *   node scripts/shot-spotops.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/devmaster';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  // 截图过程会改单据状态（开始盘点 / 取消盘点），先重置演示数据保证可重复跑
  try {
    require('child_process').execSync('node seed-devmaster-demo.js --reset', { cwd: __dirname, stdio: 'ignore' });
    console.log('演示数据已重置');
  } catch (e) {
    console.log('演示数据重置失败', e.message);
  }
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9781;
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

  await send('Page.navigate', { url: BASE + '/dev-master' });
  await sleep(5400);
  console.log('统计卡', await ev('document.querySelectorAll(".stat").length'),
    '里程碑行', await ev('document.querySelectorAll("table.data tbody tr").length'));
  await shot('01-研发总览');

  // 立项列表
  await clickText('.tabs button', '研发立项', 1700);
  await shot('02-研发立项列表');

  // 完整链路那个项目
  let ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('DV-T401'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.trim()==='明细');if(b){b.click();return true}return false})()`);
  await sleep(1800);
  console.log('逾期项目详情', ok);
  await shot('03-项目详情-里程碑与规则自检');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 2200, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await shot('04-任务与阻塞');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1700, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  await ev(`(()=>{document.querySelectorAll('.modal-ops .btn').forEach(b=>{if(b.textContent.trim()==='关闭')b.click()});return true})()`);
  await sleep(800);

  // 返单复用
  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('返单复用'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.trim()==='明细');if(b){b.click();return true}return false})()`);
  await sleep(1800);
  console.log('返单详情', ok);
  await shot('05-返单复用-沿用原版型');
  await ev(`(()=>{document.querySelectorAll('.modal-ops .btn').forEach(b=>{if(b.textContent.trim()==='关闭')b.click()});return true})()`);
  await sleep(800);

  // 新建立项弹窗
  await clickText('.page-head .btn', '新建立项', 1300);
  await shot('06-新建立项');
  await ev(`(()=>{document.querySelectorAll('.modal-ops .btn').forEach(b=>{if(b.textContent.trim()==='取消')b.click()});return true})()`);
  await sleep(700);

  // SKU 页
  await clickText('.tabs button', 'SKU 与配码', 1800);
  await shot('07-SKU列表');

  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('DV-SET001'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.trim()==='明细');if(b){b.click();return true}return false})()`);
  await sleep(1900);
  console.log('套装详情', ok);
  const expOk = await ev(`(()=>{const b=[...document.querySelectorAll('.modal .btn')].find(x=>x.textContent.trim()==='换算');if(b){b.click();return true}return false})()`);
  await sleep(1200);
  console.log('换算', expOk);
  await shot('08-套装换算与配码版本');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 2200, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await shot('09-别名与新建配码');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1700, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  await ev(`(()=>{document.querySelectorAll('.modal-ops .btn').forEach(b=>{if(b.textContent.trim()==='关闭')b.click()});return true})()`);
  await sleep(800);

  // 箱规那个单件
  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('箱规'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.trim()==='明细');if(b){b.click();return true}return false})()`);
  await sleep(1800);
  console.log('箱规详情', ok);
  await shot('10-箱规版本');
  await ev(`(()=>{document.querySelectorAll('.modal-ops .btn').forEach(b=>{if(b.textContent.trim()==='关闭')b.click()});return true})()`);
  await sleep(700);

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await clickText('.tabs button', '研发总览', 1600);
  await shot('11-移动端');
  const overflow = await ev('(()=>{const d=document.documentElement;return {scrollW:d.scrollWidth, clientW:d.clientWidth}})()');
  console.log('移动端横向溢出检查', JSON.stringify(overflow));

  proc.kill();
  process.exit(0);
})();