/**
 * 计件工资 · 截图
 * 用法：node scripts/shot-piecewage.js [period]
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/piece-wage');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

  const port = 9766;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1440,1200', 'about:blank'], { stdio: 'ignore' });
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
      // 页面不该在加载时弹窗；真弹了就记下来（说明有报错）
      console.log('⚠ 页面弹窗:', m.params.message.slice(0, 120));
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
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  /**
   * 整页截图：页面本身不滚动（内层容器滚），所以按「内容最靠下元素」裁，
   * 用 clip 而不是把视口拉高 —— 视口拉太高会在下面留一大片空白
   */
  const fitShot = async (name, maxH = 3000) => {
    // 只量顶层块（内部滚动的表格，子元素 bottom 会远超容器）
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *')].map(e=>e.getBoundingClientRect().bottom))) + 24`);
    const height = Math.min(Number(h) || 1200, maxH);
    console.log('  内容高度', height);
    // 必须先把视口拉到内容高度：captureBeyondViewport + clip 在超过视口的部分仍按视口裁，
    // 表现就是「图很高但下半截全白、表格只露表头」
    await vp(1440, height);
    await sleep(700);
    await shot(name);
    await vp(1440, 1200);
    await sleep(300);
  };

  await vp(1440, 1200);
  await send('Page.navigate', { url: BASE + '/piece-wage' });
  await sleep(6500);
  // .page 是 flex + overflow:hidden，高度受限时最后一个面板会被裁掉（DOM 在、看不见），
  // 截图前解除限制，才能量到真实内容高度
  await ev(`(()=>{const st=document.createElement('style');
    st.textContent='.page{height:auto!important;min-height:0!important;overflow:visible!important}.page>*{flex:none!important}';
    document.head.appendChild(st);return true})()`);
  await sleep(500);

  console.log('指标卡:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('诊断块:', await ev(`JSON.stringify([...document.querySelectorAll('.diag-h b')].map(b=>b.textContent.trim()))`));
  console.log('按人汇总行数:', await ev('document.querySelectorAll(".panel-card .data tbody tr").length'));
  console.log('明细考勤列:', await ev(`JSON.stringify([...document.querySelectorAll('.panel-card .data tbody tr')].slice(0,4).map(tr=>[...tr.children].map(td=>td.innerText.trim()).slice(0,8)))`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await fitShot('01-本月核算');

  // 考勤联动
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('考勤联动'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  console.log('考勤配置:', await ev(`JSON.stringify([...document.querySelectorAll('.fgrid label span')].map(s=>s.innerText.trim()))`));
  console.log('对照表首行:', await ev(`(()=>{const tr=document.querySelector('.panel-card .data tbody tr');return tr?[...tr.children].map(td=>td.innerText.trim()).join(' | '):'（空）'})()`));
  console.log('看板卡:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  await fitShot('02-考勤联动');

  // 单价维护
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('单价维护'));if(b){b.click();return true}return false})()`);
  await sleep(1200);
  console.log('单价条数:', await ev('document.querySelectorAll(".panel-card .data tbody tr").length'));
  await fitShot('03-单价维护');

  // 历史核算
  await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('历史核算'));if(b){b.click();return true}return false})()`);
  await sleep(1200);
  console.log('核算单行数:', await ev('document.querySelectorAll(".panel-card .data tbody tr").length'));
  console.log('核算单表头:', await ev(`JSON.stringify([...document.querySelectorAll('table.data thead th')].map(th=>th.innerText.trim()))`));
  await fitShot('04-历史核算');

  // 工资单页：计件列
  await send('Page.navigate', { url: BASE + '/payrolls' });
  await sleep(5200);
  await ev(`(()=>{const st=document.createElement('style');
    st.textContent='.page{height:auto!important;min-height:0!important;overflow:visible!important}.page>*{flex:none!important}';
    document.head.appendChild(st);return true})()`);
  await sleep(400);
  console.log('工资单表头:', await ev(`JSON.stringify([...document.querySelectorAll('table.data thead th')].map(th=>th.innerText.trim()))`));
  console.log('计件列合计行:', await ev(`(()=>{const m=document.body.innerText.match(/计件合计[^　\\n]*/);return m?m[0]:'（未找到）'})()`));
  await fitShot('05-工资单计件列');

  // 移动端
  await vp(414, 896, true);
  await send('Page.navigate', { url: BASE + '/piece-wage' });
  await sleep(5200);
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('06-移动端');

  proc.kill();
  process.exit(0);
})();
