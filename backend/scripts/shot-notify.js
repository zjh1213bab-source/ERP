/**
 * 客户营销与消息截图（M24）
 * 用法：先启动后端（含前端 dist），再 node scripts/shot-notify.js
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/notify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9683;
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
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
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
  const clickText = async (sel, text, wait = 1200) => {
    const done = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return done;
  };

  await send('Page.navigate', { url: BASE + '/notify' });
  await sleep(5400);
  console.log('统计卡', await ev('document.querySelectorAll(".stat").length'),
    '渠道卡', await ev('document.querySelectorAll(".cap-card").length'));
  await shot('01-概览与渠道能力');

  // 订阅与频控
  await clickText('.tabs button', '订阅与频控', 1800);
  await shot('02-订阅明细与频控');

  // 模板
  await clickText('.tabs button', '消息模板', 1500);
  await shot('03-模板与审核状态');

  // 模板详情（挑已生效的那条，才看得出多版本）
  // 挑出过 V2 的那条（上新提醒 / 站内 / 中文），版本历史里才看得见 V1 已停用
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('上新提醒')&&x.textContent.includes('V2'));if(!tr)return false;const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('查看'));if(b){b.click();return true}return false})()`);
  await sleep(1300);
  await shot('04-模板详情与版本历史');
  await clickText('.modal-foot .btn', '关闭', 800);

  // 发送与回执
  await clickText('.tabs button', '发送与回执', 1800);
  await shot('05-发送队列（含暂缓与降级）');

  // 详情：挑降级的那条，能看到「由微信降级」
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('由微信降级'));if(!tr)return false;const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('详情'));if(b){b.click();return true}return false})()`);
  await sleep(1400);
  await shot('06-发送详情与渠道降级');
  await clickText('.modal-foot .btn', '关闭', 800);

  // 详情：失败待重试的那条
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('发送失败'));if(!tr)return false;const b=[...tr.querySelectorAll('.link-btn')].find(x=>x.textContent.includes('详情'));if(b){b.click();return true}return false})()`);
  await sleep(1400);
  await ev(`(()=>{const b=document.querySelector('.modal-body');if(b){b.scrollTop=b.scrollHeight;return b.scrollTop}return 0})()`);
  await sleep(500);
  await shot('07-失败回执与重试');
  await clickText('.modal-foot .btn', '关闭', 800);

  // 到货提醒
  await clickText('.tabs button', '到货提醒', 1800);
  await shot('08-到货提醒与未触发原因');

  // 周期回访任务
  await ev(`(()=>{const b=[...document.querySelectorAll('.btn')].find(x=>x.textContent.includes('生成回访任务'));if(b){b.click();return true}return false})()`);
  await sleep(2200);
  await ev(`(()=>{const c=document.querySelector('.erp-content')||document.scrollingElement;c.scrollTop=c.scrollHeight;return c.scrollTop})()`);
  await sleep(600);
  await shot('09-周期回访任务');

  // 效果归因
  await clickText('.tabs button', '效果归因', 2000);
  await ev(`(()=>{const c=document.querySelector('.erp-content')||document.scrollingElement;c.scrollTop=0;return c.scrollTop})()`);
  await sleep(500);
  await shot('10-效果归因');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await clickText('.tabs button', '发送与回执', 1500);
  await shot('11-移动端');
  const overflow = await ev(`(()=>{const d=document.documentElement;return {scrollW:d.scrollWidth,clientW:d.clientWidth}})()`);
  console.log('移动端横向溢出检查', JSON.stringify(overflow));

  proc.kill();
  process.exit(0);
})();
