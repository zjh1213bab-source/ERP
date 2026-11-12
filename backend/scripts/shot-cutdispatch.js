/**
 * 现货经营与备货截图（M19）
 * 用法：先 node scripts/seed-spotops-demo.js --reset，启动后端（含前端 dist），再运行
 *   node scripts/shot-spotops.js
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/cutdispatch');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  // 截图过程会改单据状态（开始盘点 / 取消盘点），先重置演示数据保证可重复跑
  try {
    require('child_process').execSync('node seed-cutdispatch-demo.js --reset', { cwd: __dirname, stdio: 'ignore' });
    console.log('演示数据已重置');
  } catch (e) {
    console.log('演示数据重置失败', e.message);
  }
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9771;
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

  await send('Page.navigate', { url: BASE + '/cut-dispatch' });
  await sleep(5200);
  console.log('统计卡', await ev('document.querySelectorAll(".stat").length'),
    '外发行', await ev('document.querySelectorAll("table.data tbody tr").length'));
  await shot('01-外发单列表');

  // 已结案那张：看完整链条
  let ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('已结案'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('明细'));if(b){b.click();return true}return false})()`);
  await sleep(1700);
  console.log('已结案详情', ok);
  await shot('02-已结案-发出与回货明细');
  await ev(`(()=>{const el=document.querySelector('.modal .table-wrap');if(el){el.scrollTop=0}const m=[...document.querySelectorAll('.modal .table-wrap')];if(m[1]){m[1].scrollTop=0}return true})()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 2000, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await shot('03-回货验收记录');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1700, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  await clickText('.modal-ops .btn', '关闭', 700);

  // 逾期那张：回货验收弹窗
  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('已发出'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('明细'));if(b){b.click();return true}return false})()`);
  await sleep(1700);
  console.log('已发出详情', ok);
  const recvOpened = await clickText('.modal-ops .btn', '登记回货验收', 1400);
  console.log('回货弹窗', recvOpened);
  await shot('04-回货验收录入');
  // 一次点掉所有弹窗的「取消/关闭」——叠了两层时单点一次关不干净（04 之后 06 会被盖住）
  const closeAll = async () => {
    await ev(`(()=>{document.querySelectorAll('.modal-ops .btn').forEach((b)=>{const t=b.textContent.trim();if(t==='取消'||t==='关闭')b.click()});return true})()`);
    await sleep(800);
  };
  await closeAll();
  await closeAll();
  console.log('残留弹窗', await ev('document.querySelectorAll(".modal-mask").length'));
  await clickText('.modal-ops .btn', '取消', 700);
  await clickText('.modal-ops .btn', '关闭', 700);

  // 看板
  await clickText('.tabs button', '外协看板', 1600);
  await shot('05-外协看板');

  // 新建外发：选裁剪单后看可发扎
  await clickText('.tabs button', '外发单', 1200);
  await clickText('.page-head .btn', '新建外发单', 1200);
  const picked = await ev(`(()=>{const sel=document.querySelector('.modal select');if(!sel)return false;const opt=[...sel.options].find(o=>o.value);if(!opt)return false;sel.value=opt.value;sel.dispatchEvent(new Event('change',{bubbles:true}));return opt.textContent.trim()})()`);
  await sleep(2000);
  console.log('选中裁剪单', picked);
  await ev(`(()=>{const boxes=[...document.querySelectorAll('.modal tbody input[type=checkbox]')].filter(b=>!b.disabled);if(boxes[0])boxes[0].click();if(boxes[1])boxes[1].click();return boxes.length})()`);
  await sleep(700);
  await shot('06-新建外发-按扎勾选');
  await clickText('.modal-ops .btn', '取消', 700);

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await clickText('.tabs button', '外发单', 1500);
  await shot('07-移动端');
  const overflow = await ev('(()=>{const d=document.documentElement;return {scrollW:d.scrollWidth, clientW:d.clientWidth}})()');
  console.log('移动端横向溢出检查', JSON.stringify(overflow));

  proc.kill();
  process.exit(0);
})();