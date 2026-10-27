const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/admin-contracts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9541;
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
      dialogs.push(m.params.message.slice(0, 70));
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

  await send('Page.navigate', { url: BASE + '/admin-contracts' });
  await sleep(4200);
  console.log('合同行数', await ev('document.querySelectorAll("tbody tr").length'));
  await shot('01-合同台账-到期与下一任务');

  console.log('打开详情', await ev(`(async()=>{
    const tr=[...document.querySelectorAll('tbody tr')].find(x=>x.textContent.includes('城北仓库租赁合同'));
    if(!tr) return 'no-row';
    tr.querySelector('.link-btn').click();
    await new Promise(r=>setTimeout(r,2200));
    return !!document.querySelector('.modal-mask .ct-meta');
  })()`));
  await shot('02-合同详情-版本与履约任务');
  await ev(`document.querySelector('.modal-mask .x').click()`);
  await sleep(700);

  await ev(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.includes('履约日历')).click()`);
  await sleep(2200);
  await shot('03-履约日历-逾期与临期');

  await ev(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.includes('印章')).click()`);
  await sleep(2400);
  await shot('04-印章覆盖-未授权告警');

  console.log('滚到用印列表', await ev(`(async()=>{
    const h=[...document.querySelectorAll('.sec-title')].find(x=>x.textContent.includes('用印与借章'));
    if(h) h.scrollIntoView({block:'start'});
    await new Promise(r=>setTimeout(r,700));
    return !!h;
  })()`));
  await shot('05-用印与借章-重核与逾期');

  await ev(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.includes('证照')).click()`);
  await sleep(2200);
  await shot('06-证照档案与访问留痕');

  // 打开新建合同表单看字段
  await ev(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.includes('合同台账')).click()`);
  await sleep(1500);
  await ev(`[...document.querySelectorAll('.btn-primary')].find(b=>b.textContent.includes('新建合同')).click()`);
  await sleep(1600);
  await shot('07-新建合同-付款计划与验收');
  await ev(`document.querySelector('.modal-mask .x').click()`);
  await sleep(500);

  console.log('弹窗汇总', JSON.stringify(dialogs));
  ws.close(); proc.kill();
  process.exit(0);
})();
