const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9527;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1300', 'about:blank'], { stdio: 'ignore' });
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
      dialogs.push(m.params.message.slice(0, 60));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1300, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + login.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('JS异常', String(r.exceptionDetails.text).slice(0, 160));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };

  await send('Page.navigate', { url: BASE + '/process' });
  await sleep(4200);
  console.log('队列行数', await ev('document.querySelectorAll("tbody tr").length'));
  await shot('01-超时与升级队列');

  // 打开一个升级任务的提醒确认（取消，不改数据）
  console.log('点提醒', await ev(`(async()=>{
    const tr=[...document.querySelectorAll('tbody tr')].find(x=>x.textContent.includes('超时'));
    if(!tr) return 'no-row';
    const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.trim()==='提醒');
    if(!b) return 'no-btn';
    b.click(); await new Promise(r=>setTimeout(r,1600)); return 'clicked';
  })()`));
  await sleep(700);
  console.log('提示', JSON.stringify(dialogs));

  await ev(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.includes('代理')).click()`);
  await sleep(2200);
  await shot('02-代理授权与流程时限');

  await ev(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.includes('制度')).click()`);
  await sleep(2200);
  await shot('03-制度清单-生效待批准已废止');

  console.log('打开 SOP 详情', await ev(`(async()=>{
    const tr=[...document.querySelectorAll('tbody tr')].find(x=>x.textContent.includes('车缝工序首件确认'));
    if(!tr) return 'no-row';
    tr.querySelector('.link-btn').click();
    await new Promise(r=>setTimeout(r,2000));
    return !!document.querySelector('.four-grid');
  })()`));
  await shot('04-SOP四要素与签收');

  console.log('滚到签收', await ev(`(async()=>{
    const h=[...document.querySelectorAll('.sec-title')].find(x=>x.textContent.includes('岗位签收'));
    if(h) h.scrollIntoView({block:'start'});
    await new Promise(r=>setTimeout(r,700));
    return !!h;
  })()`));
  await shot('05-岗位签收待补签');
  await ev(`document.querySelector('.modal-mask .x').click()`);
  await sleep(600);

  // 待批准制度详情（演示未批准不生效）
  console.log('打开待批准制度', await ev(`(async()=>{
    const tr=[...document.querySelectorAll('tbody tr')].find(x=>x.textContent.includes('客户投诉处理制度'));
    if(!tr) return 'no-row';
    tr.querySelector('.link-btn').click();
    await new Promise(r=>setTimeout(r,1800));
    return document.querySelector('.modal-mask') ? 'opened' : 'no';
  })()`));
  await shot('06-待批准制度-未发布不生效');

  console.log('弹窗汇总', JSON.stringify(dialogs));
  ws.close(); proc.kill();
  process.exit(0);
})();
