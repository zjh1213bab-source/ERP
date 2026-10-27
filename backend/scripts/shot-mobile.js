/**
 * 移动端扫码作业截图 + 报工链路验证
 * 用法：node scripts/shot-mobile.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/mobile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  if (!lg.ok) { console.log('登录失败', lg.message); process.exit(1); }
  const H = { Authorization: 'Bearer ' + lg.data.token };

  const orders = (await (await fetch(BASE + '/api/orders', { headers: H })).json()).data || [];
  const target = orders.find((o) => o.status === 'production') || orders[0];
  console.log('目标订单', target.order_no, target.id);

  const port = 9786;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=414,896', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
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
  const send = (mm, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 120);
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const go = async (path, wait = 3600) => {
    await send('Page.navigate', { url: BASE + path });
    await sleep(wait);
  };

  // 1. 移动工作台
  await go('/m');
  console.log('最近订单条数', await ev('document.querySelectorAll(".mh-row").length'));
  await shot('01-移动工作台');

  // 2. 扫码直达
  await go('/s/' + target.order_no);
  console.log('扫码结果单号', await ev('document.querySelector(".sg-no") && document.querySelector(".sg-no").textContent'));
  await shot('02-扫码直达');

  // 3. 扫码报工
  await go('/m/report?no=' + target.order_no);
  console.log('工序数', await ev('document.querySelectorAll(".mr-node").length'));
  await shot('03-扫码报工');

  // 4. 点第一道非「成品入库/出库」工序，填数提交
  const picked = await ev(`(()=>{
    const bs=[...document.querySelectorAll('.mr-node')];
    const b=bs.find(x=>x.textContent.includes('裁剪'))||bs[0];
    if(!b)return false;b.click();return true})()`);
  await sleep(900);
  await shot('04-报工填数');
  await ev(`(()=>{const els=document.querySelectorAll('.mr-num');if(els[0]){els[0].value=5;els[0].dispatchEvent(new Event('input',{bubbles:true}))}if(els[2]){els[2].value=1;els[2].dispatchEvent(new Event('input',{bubbles:true}))}return true})()`);
  await sleep(400);
  const submitted = await ev(`(()=>{const b=[...document.querySelectorAll('.mr-submit')].find(x=>x.textContent.includes('提交'));if(b){b.click();return true}return false})()`);
  await sleep(2600);
  const toast = await ev('document.querySelector(".mr-toast") && document.querySelector(".mr-toast").textContent');
  const errText = await ev('document.querySelector(".mr-sheet .mr-err") && document.querySelector(".mr-sheet .mr-err").textContent');
  console.log('点提交:', submitted, '| toast:', toast, '| 错误:', errText);
  await shot('05-报工成功');

  // 5. 工单二维码（桌面视口截局部）
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false });
  await go(`/print/production/${target.id}`, 4500);
  console.log('二维码:', await ev('!!document.querySelector(".pr-qr") && document.querySelector(".pr-qr").src.slice(0,22)'));
  const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1100, height: 340, scale: 1 } });
  fs.writeFileSync(`${OUT}/06-工单条码与二维码.png`, Buffer.from(s.data, 'base64'));
  console.log('shot 06-工单条码与二维码');

  // 清场：删掉刚报的记录
  const reps = await (await fetch(BASE + `/api/reports?order_id=${target.id}`, { headers: H })).json();
  // 按「今天 + 合格 5 + 工时 1」匹配本次测试造的数据（脚本里 els[2] 是工时，不是不良）
  const mine = (reps.data || []).filter((r) => r.qty_ok === 5 && r.hours === 1);
  for (const r of mine) {
    await fetch(BASE + '/api/reports/' + r.id, { method: 'DELETE', headers: H });
  }
  console.log('清场：删除测试报工', mine.length, '条');

  proc.kill();
  process.exit(0);
})();
