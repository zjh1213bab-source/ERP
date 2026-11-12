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
const OUT = pathMod.resolve(__dirname, '../../shots/pricing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  // 截图过程会改单据状态（开始盘点 / 取消盘点），先重置演示数据保证可重复跑
  try {
    require('child_process').execSync('node seed-pricing-demo.js --reset', { cwd: __dirname, stdio: 'ignore' });
    console.log('演示数据已重置');
  } catch (e) {
    console.log('演示数据重置失败', e.message);
  }
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9751;
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

  await send('Page.navigate', { url: BASE + '/pricing' });
  await sleep(5200);
  console.log('统计卡', await ev('document.querySelectorAll(".stat").length'),
    '费用池行', await ev('document.querySelectorAll("table.data tbody tr").length'));
  await shot('01-费用池列表');

  // 已分摊的制造费用池
  let ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('已分摊'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('明细'));if(b){b.click();return true}return false})()`);
  await sleep(1700);
  console.log('已分摊池', ok);
  await shot('02-已分摊明细');
  await clickText('.modal-ops .btn', '关闭', 700);

  // 管理费用池：分摊预览（按件数，不摊进产品）
  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('管理费用'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('明细'));if(b){b.click();return true}return false})()`);
  await sleep(1700);
  console.log('管理费池', ok);
  await shot('03-分摊预览');
  await clickText('.modal-ops .btn', '关闭', 700);

  // 无动因池：基数为 0，不能分摊
  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('无动因演示'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('明细'));if(b){b.click();return true}return false})()`);
  await sleep(1700);
  console.log('无动因池', ok);
  await shot('04-无动因不能分摊');
  await clickText('.modal-ops .btn', '关闭', 700);

  // 价格本
  await clickText('.tabs button', '价格本（出厂价）', 1800);
  await shot('05-价格本列表');

  ok = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('生效中')&&x.textContent.includes('通用价'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('价目表'));if(b){b.click();return true}return false})()`);
  await sleep(1700);
  console.log('生效价格本', ok);
  await shot('06-价目表含低于成本');
  await clickText('.modal-ops .btn', '关闭', 700);

  // V3 草稿：含取不到成本的款
  ok = await ev(`(()=>{const trs=[...document.querySelectorAll('table.data tbody tr')].filter(x=>x.textContent.includes('草稿'));const tr=trs[trs.length-1];if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.includes('价目表'));if(b){b.click();return true}return false})()`);
  await sleep(1700);
  console.log('草稿价格本', ok);
  await shot('07-草稿含取不到成本');
  await clickText('.modal-ops .btn', '关闭', 700);

  // 查价
  await clickText('.tabs button', '查价', 1500);
  await ev(`(()=>{const i=document.querySelector('.toolbar .inp');if(!i)return false;i.value='LEJE-AW-2601';i.dispatchEvent(new Event('input',{bubbles:true}));const q=document.querySelectorAll('.toolbar .inp');if(q[1]){q[1].value='500';q[1].dispatchEvent(new Event('input',{bubbles:true}))}return true})()`);
  await sleep(500);
  await clickText('.toolbar .btn', '查价', 1600);
  await shot('08-查价结果');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await clickText('.tabs button', '费用池', 1500);
  await shot('09-移动端');
  const overflow = await ev('(()=>{const d=document.documentElement;return {scrollW:d.scrollWidth, clientW:d.clientWidth}})()');
  console.log('移动端横向溢出检查', JSON.stringify(overflow));

  proc.kill();
  process.exit(0);
})();