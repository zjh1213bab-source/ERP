const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/kpi');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9561;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1680,1250', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* retry */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const dialogs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message.slice(0, 80));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1250, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + login.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('JS异常', String(r.exceptionDetails.text).slice(0, 200));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };

  await send('Page.navigate', { url: BASE + '/kpi' });
  await sleep(4000);
  console.log('行数', await ev('document.querySelectorAll("tbody tr").length'));
  await shot('01-本周绩效-当前分与建议分分开');

  // 打开一个人明细（陈国强：待复核，建议分不计）
  console.log('打开明细', await ev(`(async()=>{
    const tr=[...document.querySelectorAll('tbody tr')].find(x=>x.textContent.includes('陈国强'));
    if(!tr) return 'no-row';
    tr.querySelector('.link-btn').click();
    await new Promise(r=>setTimeout(r,2000));
    return !!document.querySelector('.modal-mask .score-head');
  })()`));
  await shot('02-个人明细-建议分与确认分');

  // 点一条确认扣分，走 alert 流程（取消掉不实际改）
  console.log('点确认扣分', await ev(`(async()=>{
    const b=[...document.querySelectorAll('.modal-mask .opbtn, .modal-mask .link-btn')].find(x=>x.textContent.trim()==='确认');
    if(!b) return 'no-btn';
    b.click(); await new Promise(r=>setTimeout(r,1200)); return 'clicked';
  })()`));
  await sleep(800);
  console.log('弹窗（已取消）', JSON.stringify(dialogs));
  await ev(`document.querySelector('.modal-mask .x') && document.querySelector('.modal-mask .x').click()`);
  await sleep(800);

  // 规则与模板
  await ev(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.includes('规则与模板')).click()`);
  await sleep(2500);
  await shot('03-规则与模板-权重与完整性');

  // 打开模板看指标
  console.log('打开模板', await ev(`(async()=>{
    const tr=[...document.querySelectorAll('tbody tr')].find(x=>x.textContent.includes('缝制岗位周度绩效'));
    if(!tr) return 'no-row';
    tr.querySelector('.link-btn').click();
    await new Promise(r=>setTimeout(r,2000));
    return !!document.querySelector('.rule-tbl');
  })()`));
  await shot('04-模板指标-定义口径数据源与例外');
  await ev(`document.querySelector('.modal-mask .x').click()`);
  await sleep(800);

  // V2 模拟试算
  console.log('模拟试算', await ev(`(async()=>{
    const tr=[...document.querySelectorAll('tbody tr')].find(x=>x.textContent.includes('V2') || (x.textContent.includes('缝制岗位周度绩效') && x.textContent.includes('待复核')));
    if(!tr) return 'no-row';
    const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('模拟试算'));
    if(!b) return 'no-sim-btn:'+[...tr.querySelectorAll('.link-btn')].map(x=>x.textContent).join('/');
    b.click(); await new Promise(r=>setTimeout(r,2400));
    return !!document.querySelector('.modal-mask');
  })()`));
  await shot('05-未批模板-只能模拟试算');
  await ev(`document.querySelector('.modal-mask .x').click()`);
  await sleep(600);

  // 申诉
  await ev(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.includes('申诉')).click()`);
  await sleep(2200);
  await shot('06-申诉与独立复核');
  await ev(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.includes('本周绩效')).click()`);
  await sleep(2000);
  await shot('07-待复核清单');

  console.log('弹窗汇总', JSON.stringify(dialogs));
  ws.close(); proc.kill();
  process.exit(0);
})();
