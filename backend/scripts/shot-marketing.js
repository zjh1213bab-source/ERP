/**
 * 营销与素材截图（M16）
 * 用法：先启动后端 + 前端 dist，再 node scripts/shot-marketing.js
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/marketing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9641;
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
  const clickTab = async (text, wait = 1600) => {
    const ok = await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return ok;
  };
  const closeModal = async () => {
    await ev(`(()=>{const b=[...document.querySelectorAll('.modal .x')].pop();if(b){b.click();return true}return false})()`);
    await sleep(500);
  };
  const clickText = async (sel, text, wait = 900) => {
    const ok = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return ok;
  };

  await send('Page.navigate', { url: BASE + '/marketing' });
  await sleep(5200);
  console.log('日历格子', await ev('document.querySelectorAll(".cal-cell").length'),
    '任务块', await ev('document.querySelectorAll(".cal-chip").length'),
    '逾期红块', await ev('document.querySelectorAll(".ch-red").length'));
  await shot('01-上新日历');

  // 列表视图
  await clickText('.seg button', '列表');
  await shot('02-上新任务列表');
  // 卡技术的那条任务计划日在下月，从列表点进去
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('MK-C001'));if(!tr)return false;const b=tr.querySelector('.link-btn');if(b){b.click();return true}return false})()`);
  await sleep(1300);
  console.log('门槛块', await ev('document.querySelectorAll(".gate").length'),
    '未过门槛', await ev('document.querySelectorAll(".gate-bad").length'),
    '步骤', await ev('document.querySelectorAll(".step").length'));
  await shot('03-任务详情与三项门槛');
  await ev('document.querySelector(".modal-body").scrollTop = 420');
  await sleep(500);
  await shot('04-任务步骤与已绑素材');
  await closeModal();

  await clickTab('品牌素材与授权', 1800);
  console.log('素材卡', await ev('document.querySelectorAll(".asset-card").length'),
    '过期卡', await ev('document.querySelectorAll(".asset-card.dead").length'));
  await shot('05-素材库与授权范围');

  await clickText('.asset-card .link-btn', '详情');
  await sleep(1000);
  await shot('06-素材详情与被引用');
  await closeModal();

  await clickTab('活动预算与效果', 1900);
  console.log('活动行', await ev('document.querySelectorAll("table.data tbody tr").length'),
    '超预算红字', await ev('document.querySelectorAll("td.red").length'));
  await shot('07-活动投放与超预算');

  await clickText('table.data tbody a.lnk', '天猫早秋');
  await sleep(1400);
  console.log('归因计入', await ev('document.querySelectorAll(".modal-body table.data tbody tr").length'),
    '剔除项', await ev('document.querySelectorAll(".ex-item").length'));
  await shot('08-活动归因与剔除假增长');
  await closeModal();
  await ev('window.scrollTo(0, 700)');
  await sleep(600);
  await shot('09-按币种汇总');

  await clickTab('运营复盘与协同', 1900);
  console.log('复盘卡', await ev('document.querySelectorAll(".rev-card").length'),
    '逾期卡', await ev('document.querySelectorAll(".rc-bad").length'));
  await shot('10-运营复盘');

  await clickText('.rev-card .link-btn', '处理');
  await sleep(1200);
  await shot('11-复盘行动项');
  await closeModal();

  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/marketing' });
  await sleep(4800);
  await shot('12-移动端');
  console.log('横向溢出', await ev('document.documentElement.scrollWidth + "/" + document.documentElement.clientWidth'));

  if (dialogs.length) console.log('弹窗:', dialogs.join(' | '));
  proc.kill();
  process.exit(0);
})();
