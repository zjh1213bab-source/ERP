/**
 * 扎级完工进度 · 截图与口径校验
 * 用法：node scripts/shot-bundleprogress.js [orderId]
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/bundle-progress';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const H = { Authorization: 'Bearer ' + lg.data.token };

  const list = (await (await fetch(BASE + '/api/labels/progress', { headers: H })).json()).data || [];
  const target = Number(process.argv[2]) || (list[0] && list[0].id);
  const p = (await (await fetch(`${BASE}/api/labels/progress/${target}`, { headers: H })).json()).data;
  console.log('订单', p.order.order_no, '| 扎', p.summary.bundles, '| 完工', p.summary.done, '| 短数', p.summary.short);

  const port = 9771;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1440,1500', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 80 && !t; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* ignore */ }
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (mm, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 140);
    return r.result ? r.result.value : null;
  };
  const vp = async (w, h, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const shot = async (name, full = false) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };

  await vp(1440, 1500);
  await send('Page.navigate', { url: BASE + '/bundle-progress' });
  await sleep(6000);

  console.log('指标卡:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(c=>c.innerText.replace(/\\n/g,'/') ))`));
  console.log('表头列:', await ev(`JSON.stringify([...document.querySelectorAll('.bp-table thead th')].map(th=>th.innerText.replace(/\\n/g,' ')))`));
  console.log('行数', await ev('document.querySelectorAll(".bp-table tbody tr").length'));
  console.log('提示条数', await ev('document.querySelectorAll(".nt").length'));
  console.log('横向溢出', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  console.log('前 12 行单元格:', await ev(`JSON.stringify([...document.querySelectorAll('.bp-table tbody tr')].slice(0,12).map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\s+/g,' ').trim())))`));
  // 截图时展开表格高度（页面里是内部滚动的，不展开只能拍到前 15 行）
  await ev(`(()=>{const st=document.createElement('style');st.textContent='.bp-wrap{max-height:none!important;overflow:visible!important}';document.head.appendChild(st);return true})()`);
  await sleep(600);
  // 展开后页面变高，按内容高度重设视口再拍（captureBeyondViewport 对重新布局不生效）
  // 页面本身不滚动（.app-main 内部滚动），documentElement.scrollHeight 恒等于视口高度，
  // 得按「内容里最靠下的元素」算
  const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page, .page *')].map(e=>e.getBoundingClientRect().bottom))) + 30`);
  console.log('内容高度', h, '| 表格高度', await ev(`Math.round(document.querySelector('.bp-table').getBoundingClientRect().height)`));
  await vp(1440, Math.min(Number(h) || 1500, 3200));
  await sleep(900);
  await shot('01-扎级进度总览');

  // 短数筛选
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('短数'));if(b){b.click();return true}return false})()`);
  await sleep(900);
  console.log('短数行数', await ev('document.querySelectorAll(".bp-table tbody tr").length'));
  await shot('02-只看短数');

  // 全部工序
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('全部'));if(b){b.click();return true}return false})()`);
  await sleep(600);
  await ev(`(()=>{const c=document.querySelector('.switch input');if(c){c.click();return true}return false})()`);
  await sleep(900);
  console.log('全工序列数', await ev('document.querySelectorAll(".bp-table thead th").length'));
  await shot('03-显示全部工序');

  // 单扎明细（点一个放量最多的扎：完工的 B001）
  await ev(`(()=>{const a=document.querySelector('.bp-table tbody .bno');if(a){a.click();return true}return false})()`);
  await sleep(1000);
  console.log('弹窗标题', await ev(`(()=>{const e=document.querySelector('.dlg-h b');return e?e.textContent.trim():''})()`));
  await shot('04-单扎明细');

  // 移动端
  await ev(`(()=>{const b=[...document.querySelectorAll('.dlg-h .btn')].find(x=>x.textContent.includes('关闭'));if(b){b.click();return true}return false})()`);
  await sleep(500);
  await vp(414, 896, true);
  await send('Page.navigate', { url: BASE + '/bundle-progress' });
  await sleep(5200);
  console.log('移动端横向溢出', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await ev(`document.querySelector('.bp-wrap').scrollIntoView({block:'center'})`);
  await sleep(700);
  await shot('05-移动端');
  // 横向滚到工序列，确认窄屏也能看到工序
  await ev(`(()=>{const w=document.querySelector('.bp-wrap');w.scrollLeft=260;return w.scrollLeft})()`);
  await sleep(600);
  await shot('07-移动端横滚到工序');

  proc.kill();
  process.exit(0);
})();
