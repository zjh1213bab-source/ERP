/**
 * 销售与客户截图（M03：线索商机 / 周期预警 / 客户价值 / 目标提成 / 客户交接）
 * 用法：先启动后端（含前端 dist），再 node scripts/shot-sales.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/sales';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9675;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,2100', 'about:blank'], { stdio: 'ignore' });
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
      dialogs.push(String(m.params.message).slice(0, 140));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 2100, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + login.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('JS异常', String(r.exceptionDetails.text).slice(0, 160));
    return r.result ? r.result.value : null;
  };
  const shot = async (name, viewportOnly = true) => {
    const s = await send('Page.captureScreenshot', viewportOnly ? { format: 'png' } : { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const clickText = async (sel, text, wait = 1200) => {
    const ok = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return ok;
  };

  await send('Page.navigate', { url: BASE + '/sales' });
  await sleep(5600);
  console.log('线索行', await ev('document.querySelectorAll("table.data tbody tr").length'),
    '统计卡', await ev('document.querySelectorAll(".stat").length'),
    '漏斗', await ev('document.querySelectorAll(".fn-item").length'));
  await shot('01-线索与商机');

  // 打开跟进逾期的老客户线索详情
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('Westline')&&x.textContent.includes('需求确认'));if(!tr)return false;const b=tr.querySelector('.lnk');if(b){b.click();return true}return false})()`);
  await sleep(1500);
  await shot('02-线索详情与跟进留痕');
  await clickText('.modal-foot .btn', '关闭', 900);

  // 周期预警
  await clickText('.tabs button', '周期预警', 1600);
  await shot('03-周期预警与宽限');
  // 推断建议
  await clickText('.toolbar .btn', '推断周期', 1400);
  await shot('04-周期推断只给建议');
  // 维护周期弹窗（未知那个）
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('Dubai'));if(!tr)return false;const b=tr.querySelector('.link-btn');if(b){b.click();return true}return false})()`);
  await sleep(1300);
  await shot('05-周期未知不编0天');
  await clickText('.modal-foot .btn', '取消', 800);

  // 客户价值
  await clickText('.tabs button', '客户价值', 1800);
  await shot('06-客户价值排行');
  // 切毛利看「待核」
  await ev(`(()=>{const s=[...document.querySelectorAll('.toolbar select')].pop();if(!s)return false;s.value='gross';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(1500);
  await shot('07-毛利待核不进榜');

  // 目标与提成
  await clickText('.tabs button', '目标与提成', 2000);
  await shot('08-目标与提成规则');
  await clickText('.tgt .link-btn', '看达成', 1400);
  await shot('09-目标达成分子分母');
  await clickText('.modal-foot .btn', '关闭', 800);
  // 提成单：先清掉期间过滤，否则只看当月，看不见 9 月那张带退款调整的草稿
  await ev(`(()=>{const list=[...document.querySelectorAll('.toolbar input[type=month]')];const i=list[list.length-1];if(!i)return false;i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(1400);
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('CM')&&x.textContent.includes('草稿'));if(!tr)return false;const b=tr.querySelector('.lnk');if(b){b.click();return true}return false})()`);
  await sleep(1500);
  await shot('10-提成来源行与调整');
  await clickText('.modal-foot .btn', '关闭', 800);
  // 试算
  await clickText('.toolbar .btn', '试算', 1300);
  await ev(`(()=>{const c=document.querySelector('.fgrid .chk input');if(c){c.click();return true}return false})()`);
  await sleep(1600);
  await shot('11-提成防重（来源行已被计过）');
  // 换成还有未计提来源的业务员，看正常试算
  await ev(`(()=>{const sel=document.querySelectorAll('.modal-body .fgrid select')[0];if(!sel)return false;sel.value='朱佳豪';sel.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(600);
  await ev(`(()=>{const c=document.querySelector('.fgrid .chk input');if(c){c.click();return true}return false})()`);
  await sleep(1700);
  await shot('12-提成试算（超额累进）');
  await clickText('.modal-foot .btn', '关闭', 800);

  // 客户交接
  await clickText('.tabs button', '客户交接', 1600);
  await shot('13-客户交接');
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.data tbody tr')].find(x=>x.textContent.includes('HO'));if(!tr)return false;const b=tr.querySelector('.lnk');if(b){b.click();return true}return false})()`);
  await sleep(1400);
  await shot('14-交接详情与未结业务');
  await clickText('.modal-foot .btn', '关闭', 900);

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE + '/sales' });
  await sleep(5200);
  await shot('15-移动端');
  console.log('移动端横向溢出', await ev('document.documentElement.scrollWidth > window.innerWidth + 2'));
  if (dialogs.length) console.log('弹窗提示', dialogs);

  proc.kill();
  process.exit(0);
})().catch((e) => { console.error('失败', e.message); process.exit(1); });
