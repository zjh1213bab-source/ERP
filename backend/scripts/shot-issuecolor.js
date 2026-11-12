/**
 * 领料按「款 × 颜色」发料 —— 截图取证
 * 用法：先 node scripts/seed-issuecolor-demo.js --reset，启动后端（含前端 dist），再运行
 *   node scripts/shot-issuecolor.js
 *
 * 只看截图不算验证：每步都把关键文字 dump 出来（textContent），
 * 免得「图上看着有那一列」而实际是空的。
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/issuecolor');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  try {
    require('child_process').execSync('node seed-issuecolor-demo.js --reset', { cwd: __dirname, stdio: 'ignore' });
    console.log('演示数据已重建');
  } catch (e) {
    console.log('演示数据重建失败：', e.message);
  }
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9743;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1500', 'about:blank'], { stdio: 'ignore' });
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1500, deviceScaleFactor: 1, mobile: false });
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
  /** 量真实几何，别靠眼睛看截图 */
  const box = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top),bottom:Math.round(r.bottom)}})()`);

  await send('Page.navigate', { url: BASE + '/material-flow' });
  await sleep(5200);

  // ---------- ① 领料单列表 ----------
  const rowTxt = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('MCOL-DEMO-1'));return tr?tr.textContent.replace(/\\s+/g,' ').trim():null})()`);
  console.log('目标单行：', rowTxt);
  await shot('01-领料单列表');

  // ---------- ② 明细：款/颜色列 + 按颜色汇总 ----------
  const opened = await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('MCOL-DEMO-1'));if(!tr)return false;const b=[...tr.querySelectorAll('.btn')].find(y=>y.textContent.trim()==='明细');if(b){b.click();return true}return false})()`);
  await sleep(1400);
  console.log('打开明细：', opened);
  const heads = await ev(`(()=>{const t=[...document.querySelectorAll('.modal table.data')][0];if(!t)return null;return [...t.querySelectorAll('thead th')].map(x=>x.textContent.trim()).join('|')})()`);
  console.log('明细表头：', heads);
  const lines = await ev(`(()=>{const t=[...document.querySelectorAll('.modal table.data')][0];if(!t)return null;return [...t.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.replace(/\\s+/g,'').trim()).join('/')).join('\\n')})()`);
  console.log('明细行：\n' + lines);
  const colorBox = await ev(`(()=>{const h=[...document.querySelectorAll('.modal h4')].find(x=>x.textContent.includes('按颜色汇总'));if(!h)return null;const t=h.parentElement.querySelector('table.data tbody');return t?[...t.querySelectorAll('tr')].map(r=>[...r.children].map(td=>td.textContent.replace(/\\s+/g,'').trim()).join('/')).join('\\n'):null})()`);
  console.log('按颜色汇总：\n' + colorBox);
  const modalGeom = await box('.modal.xxwide');
  console.log('明细弹窗几何：', JSON.stringify(modalGeom));
  await shot('02-领料单明细-分色');

  // ---------- ③ 退料弹窗：可退量按颜色算 ----------
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal-ops .btn')].find(x=>x.textContent.trim()==='退料');if(b)b.click()})()`);
  await sleep(1200);
  const retRows = await ev(`(()=>{const ts=[...document.querySelectorAll('.modal table.data')];const t=ts[ts.length-1];if(!t)return null;return [...t.querySelectorAll('thead th')].map(x=>x.textContent.trim()).join('|')+' :: '+[...t.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.replace(/\\s+/g,'').trim()).join('/')).join(' ; ')})()`);
  console.log('退料弹窗：', retRows);
  await shot('03-退料弹窗按色');
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal-ops .btn')].find(x=>x.textContent.trim()==='取消');if(b)b.click()})()`);
  await sleep(500);

  // ---------- ④ 发料弹窗：每行带颜色 ----------
  const outOpen = await ev(`(()=>{const b=[...document.querySelectorAll('.modal-ops .btn')].find(x=>x.textContent.trim()==='发料');if(b){b.click();return true}return false})()`);
  await sleep(900);
  const outHeads = await ev(`(()=>{const t=[...document.querySelectorAll('.modal table.data')].pop();if(!t)return null;return [...t.querySelectorAll('thead th')].map(x=>x.textContent.trim()).join('|')})()`);
  const outRows = await ev(`(()=>{const t=[...document.querySelectorAll('.modal table.data')].pop();if(!t)return null;return [...t.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.replace(/\\s+/g,'').trim()).join('/')).join('\\n')})()`);
  console.log('发料弹窗：', outOpen, '\n表头', outHeads, '\n' + outRows);
  await shot('04-发料弹窗按色');
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal-ops .btn')].find(x=>x.textContent.trim()==='取消');if(b)b.click()})()`);
  await sleep(500);
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal-ops .btn')].find(x=>x.textContent.trim()==='关闭');if(b)b.click()})()`);
  await sleep(500);

  // ---------- ④ 新建备料单：建议表按色展开 ----------
  const newOpen = await ev(`(()=>{const b=[...document.querySelectorAll('.btn')].find(x=>x.textContent.includes('新建备料单'));if(b){b.click();return true}return false})()`);
  await sleep(900);
  const picked = await ev(`(()=>{const s=[...document.querySelectorAll('.modal select')].find(x=>[...x.options].some(o=>o.textContent.includes('MCOL-DEMO-1')));if(!s)return false;const o=[...s.options].find(o=>o.textContent.includes('MCOL-DEMO-1'));s.value=o.value;s.dispatchEvent(new Event('change'));return o.textContent})()`);
  await sleep(1800);
  console.log('选订单：', newOpen, picked);
  const sugHeads = await ev(`(()=>{const t=document.querySelector('.modal table.data');if(!t)return null;return [...t.querySelectorAll('thead th')].map(x=>x.textContent.trim()).join('|')})()`);
  const sugRows = await ev(`(()=>{const t=document.querySelector('.modal table.data');if(!t)return null;return [...t.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.replace(/\\s+/g,'').trim()).join('/')).join('\\n')})()`);
  console.log('建议表头：', sugHeads);
  console.log('建议行：\n' + sugRows);
  const sugGeom = await box('.modal table.data');
  console.log('建议表几何：', JSON.stringify(sugGeom));
  await shot('05-新建备料单按色建议');

  console.log('完成。');
  try { proc.kill(); } catch (e) { /* ignore */ }
  process.exit(0);
})();
