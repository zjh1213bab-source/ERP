/**
 * 现货经营与备货截图（M19）
 * 用法：先 node scripts/seed-spotops-demo.js --reset，启动后端（含前端 dist），再运行
 *   node scripts/shot-spotops.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/matflow';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  // 截图过程会改单据状态（开始盘点 / 取消盘点），先重置演示数据保证可重复跑
  try {
    require('child_process').execSync('node seed-matflow-demo.js --reset', { cwd: __dirname, stdio: 'ignore' });
    console.log('演示数据已重置');
  } catch (e) {
    console.log('演示数据重置失败', e.message);
  }
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9741;
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
  const scrollTo = async (y) => {
    await ev(`(()=>{const el=document.querySelector('.erp-content');if(el){el.scrollTop=${y};return el.scrollTop}return -1})()`);
    await sleep(450);
  };

  await send('Page.navigate', { url: BASE + '/material-flow' });
  await sleep(5200);
  console.log('统计卡', await ev('document.querySelectorAll(".stat").length'),
    '领料行', await ev('document.querySelectorAll("table.data tbody tr").length'));
  await shot('01-领料单列表');

  // 已备料（占用中）的单：看明细
  let ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('已备料'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.trim()==='明细');if(b){b.click();return true}return false})()`);
  await sleep(1500);
  console.log('已备料详情', ok);
  await shot('02-领料单详情-占用中');
  await clickText('.modal-ops .btn', '关闭', 700);

  // 部分发出的单：发料弹窗
  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('部分发出'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.trim()==='明细');if(b){b.click();return true}return false})()`);
  await sleep(1500);
  await shot('03-部分发出-欠发可见');
  const outOpened = await clickText('.modal-ops .btn', '发料', 1200);
  console.log('发料弹窗', outOpened);
  await shot('04-发料出库');
  await clickText('.modal-ops .btn', '取消', 700);
  await clickText('.modal-ops .btn', '关闭', 700);

  // 退料
  await clickText('.tabs button', '退料', 1600);
  await shot('05-退料列表');

  // 盘点
  await clickText('.tabs button', '盘点差异', 1600);
  await shot('06-盘点列表');
  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('已调账'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('盘点表'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  console.log('已调账盘点', ok);
  await shot('07-盘点差异明细');
  await clickText('.modal-ops .btn', '关闭', 700);

  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('草稿'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('盘点表'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  await shot('08-盘点未开始');

  // 开始盘点 → 冻结生效 + 可录数
  const started = await clickText('.modal-ops .btn', '开始盘点', 1800);
  console.log('开始盘点', started);
  await shot('09-盘点进行中-录数');

  // 收尾：把这张演示盘点单取消掉，别让库存一直冻着
  const cancelled = await ev(`(async()=>{const t=localStorage.getItem('erp_token');const r=await fetch('/api/matflow/stocktakes?status=counting',{headers:{Authorization:'Bearer '+t}}).then(x=>x.json());const row=(r.data&&r.data.rows||[])[0];if(!row)return 'no-row';const c=await fetch('/api/matflow/stocktakes/'+row.id+'/cancel',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({reason:'演示截图结束，取消本次盘点（库存恢复可收发）'})}).then(x=>x.json());return c.ok?'cancelled':'fail:'+c.message})()`);
  console.log('演示盘点收尾', cancelled);
  await sleep(600);
  await clickText('.modal-ops .btn', '关闭', 700);
  // 收尾后刷新一次，别让页面还挂着「盘点中」的旧状态
  await clickText('.page-head .btn', '刷新', 1500);

  // 原料台账
  await clickText('.tabs button', '原料台账', 1700);
  await shot('10-原料台账');
  const ledOpened = await ev(`(()=>{const b=[...document.querySelectorAll('table.data tbody tr .btn')].find(x=>x.textContent.trim()==='流水');if(b){b.click();return true}return false})()`);
  await sleep(1400);
  console.log('流水弹窗', ledOpened);
  await shot('11-原料流水');
  await clickText('.modal-ops .btn', '关闭', 700);

  // 新建备料单（选订单带出用料）
  await clickText('.tabs button', '备料与领料', 1500);
  await clickText('.page-head .btn', '新建备料单', 1200);
  const picked = await ev(`(()=>{const sel=[...document.querySelectorAll('.modal select')][1];if(!sel)return false;const opt=[...sel.options].find(o=>o.textContent.includes('SCHDEMO003'))||[...sel.options].find(o=>o.value);if(!opt)return false;sel.value=opt.value;sel.dispatchEvent(new Event('change',{bubbles:true}));return opt.textContent.trim()})()`);
  await sleep(2200);
  console.log('选中订单', picked);
  await shot('12-新建备料单-带出用料');
  await clickText('.modal-ops .btn', '取消', 700);

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await clickText('.tabs button', '原料台账', 1600);
  await shot('13-移动端');
  const overflow = await ev('(()=>{const d=document.documentElement;return {scrollW:d.scrollWidth, clientW:d.clientWidth}})()');
  console.log('移动端横向溢出检查', JSON.stringify(overflow));

  proc.kill();
  process.exit(0);
})();