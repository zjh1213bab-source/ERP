/**
 * 制度问答截图（M17 N17-02）
 * 用法：先启动后端 + 前端 dist，再 node scripts/shot-policy.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/policy';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9651;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1320', 'about:blank'], { stdio: 'ignore' });
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
      dialogs.push(m.params.message.slice(0, 120));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1320, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + login.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('JS异常', String(r.exceptionDetails.text).slice(0, 180));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  // 只截当前视口：内容区（.erp-content）自己有 overflow，
  // captureBeyondViewport 会把内层滚动重置回顶部，截出来永远是第一屏
  const shotView = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const clickText = async (sel, text, wait = 1200) => {
    const ok = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return ok;
  };

  await send('Page.navigate', { url: BASE + '/ai-center' });
  await sleep(5000);
  // 切到制度问答
  await clickText('.tabs button', '制度问答', 1800);
  console.log('现行制度行', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  await shot('01-制度问答入口');

  // 问一条：请假 3 天
  await clickText('.chip', '请假 3 天', 2200);
  console.log('引用卡', await ev('document.querySelectorAll(".cite").length'),
    '摘录', await ev('document.querySelectorAll(".basis-row").length'),
    '答案首行', await ev('document.querySelector(".pw-answer")?.textContent?.split("\\n")[0]'));
  await shot('02-答案带版本与生效日期');

  // 往回滚一点看引用卡
  await ev(`(()=>{const c=document.querySelector('.erp-content')||document.scrollingElement;c.scrollTop=420;return c.scrollTop})()`);
  await sleep(600);
  await shotView('03-引用卡与原文摘录');

  // 问一条：付款 30 万（金额题最容易编）
  await ev('window.scrollTo(0, 0)');
  await sleep(300);
  await clickText('.chip', '付款 30 万', 2200);
  await shot('04-金额类问题照贴原文');

  // 问一条没有生效制度的
  await ev('window.scrollTo(0, 0)');
  await sleep(300);
  await ev(`(()=>{const i=document.querySelector('.pq-bar .input');i.value='样品能借多久？';i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(400);
  await clickText('.pq-bar .btn', '问一下', 2200);
  console.log('不可引用提示', await ev('document.querySelectorAll(".inv-row").length'));
  await shot('05-查不到就直说查不到');

  // 原文弹窗：挑有多个版本的那条（考勤与请假 V2），才看得出「版本历史」
  await ev(`(()=>{const tr=[...document.querySelectorAll('.tb-tbl tbody tr')].find(x=>x.textContent.includes('考勤与请假'));if(!tr)return false;const b=tr.querySelector('.btn');if(b){b.click();return true}return false})()`);
  await sleep(1300);
  console.log('版本行', await ev('document.querySelectorAll(".modal .tb-tbl tbody tr").length'));
  await shot('06-制度原文与版本历史');
  await ev(`(()=>{const b=document.querySelector('.modal-foot .btn');if(b){b.click();return true}return false})()`);
  await sleep(600);

  // 引用留痕：滚动的是 .erp-content，不是 window（内容区自己带 overflow）
  await ev(`(()=>{const c=document.querySelector('.erp-content')||document.scrollingElement;c.scrollTop=c.scrollHeight;return c.scrollTop})()`);
  await sleep(700);
  // 只看引用了旧版的：这几条要回访更正
  await ev(`(()=>{const b=[...document.querySelectorAll('.chk input')].pop();if(b){b.click();return true}return false})()`);
  await sleep(800);
  console.log('留痕行', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'),
    '过期标记', await ev('document.querySelectorAll(".pill.p-red").length'));
  await shotView('07-引用留痕与旧版标记');

  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/ai-center' });
  await sleep(4600);
  await clickText('.tabs button', '制度问答', 1600);
  await clickText('.chip', '请假 3 天', 2000);
  await shot('08-移动端');
  console.log('横向溢出', await ev('document.documentElement.scrollWidth + "/" + document.documentElement.clientWidth'));

  if (dialogs.length) console.log('弹窗:', dialogs.join(' | '));
  proc.kill();
  process.exit(0);
})();
