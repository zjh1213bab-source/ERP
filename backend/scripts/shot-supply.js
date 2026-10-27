/**
 * 供给批次与预订截图（M23）
 * 用法：先启动后端（含前端 dist），再 node scripts/shot-supply.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/supply';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9677;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1900', 'about:blank'], { stdio: 'ignore' });
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
      dialogs.push(String(m.params.message).slice(0, 140));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1900, deviceScaleFactor: 1, mobile: false });
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
  const clickText = async (sel, text, wait = 1200) => {
    const ok = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return ok;
  };

  await send('Page.navigate', { url: BASE + '/supply' });
  await sleep(5400);
  console.log('投影行', await ev('document.querySelectorAll("table.data tbody tr").length'),
    '统计卡', await ev('document.querySelectorAll(".stat").length'));
  await shot('01-可售口径');

  // 批次
  await clickText('.tabs button', '供给批次', 1700);
  await shot('02-供给批次');

  // 批次详情
  // 选一条「在途且已有预订」的批次，详情里才看得出占用与迁移记录
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('在途')&&x.textContent.includes('藏青 · M'));if(!tr)return false;const b=tr.querySelector('.lnk');if(b){b.click();return true}return false})()`);
  await sleep(1400);
  await shot('03-批次详情与迁移记录');
  await clickText('.modal-foot .btn', '关闭', 800);

  // 推进阶段
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('待发'));if(!tr)return false;const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('推进'));if(b){b.click();return true}return false})()`);
  await sleep(1200);
  await shot('04-推进阶段');
  await clickText('.modal-foot .btn', '取消', 700);

  // 检验
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('实收检验'));if(!tr)return false;const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('检验'));if(b){b.click();return true}return false})()`);
  await sleep(1200);
  await shot('05-实收检验');
  await clickText('.modal-foot .btn', '取消', 700);

  // 预订与占用
  await clickText('.tabs button', '预订与占用', 1800);
  await shot('06-预订申请');
  // 确认弹窗
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('待销售确认'));if(!tr)return false;const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('确认'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  await shot('07-确认预订');
  await clickText('.modal-foot .btn', '取消', 700);
  // 占用区
  await ev(`(()=>{const c=document.querySelector('.erp-content');if(c)c.scrollTop=760;return c?c.scrollTop:0})()`);
  await sleep(700);
  await shot('08-占用与到期');

  // 缺口
  await clickText('.tabs button', '缺口处理', 1600);
  await ev(`(()=>{const c=document.querySelector('.erp-content');if(c)c.scrollTop=0;return 0})()`);
  await sleep(500);
  await shot('09-缺口清单');
  await ev(`(()=>{const b=[...document.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('处理'));if(b){b.click();return true}return false})()`);
  await sleep(1300);
  await shot('10-缺口处理');
  await clickText('.modal-foot .btn', '取消', 700);

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE + '/supply' });
  await sleep(5200);
  await shot('11-移动端');
  console.log('移动端横向溢出', await ev('document.documentElement.scrollWidth > window.innerWidth + 2'));
  if (dialogs.length) console.log('弹窗提示', dialogs);

  proc.kill();
  process.exit(0);
})().catch((e) => { console.error('失败', e.message); process.exit(1); });
