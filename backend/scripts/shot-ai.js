const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/ai');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9571;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1320', 'about:blank'], { stdio: 'ignore' });
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1320, deviceScaleFactor: 1, mobile: false });
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
  const closeModal = async () => {
    await ev(`(()=>{const b=[...document.querySelectorAll('.modal .x, .modal-foot button')].find(x=>/×|取消|关闭/.test(x.textContent));if(b){b.click();return true}return false})()`);
    await sleep(400);
  };
  const clickTab = async (text) => {
    await closeModal();
    await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.includes('${text}'));if(b)b.click();return !!b})()`);
    await sleep(1500);
  };

  await send('Page.navigate', { url: BASE + '/ai-center' });
  await sleep(4800);
  console.log('模式', await ev('document.querySelector(".mode-pill")?.textContent.trim()'));
  console.log('供应商卡片', await ev('document.querySelectorAll(".prov-card").length'));
  console.log('调用行数', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  await shot('01-模型网关与调用审计');

  // ---- 需求抽取 ----
  await clickTab('需求抽取');
  await ev(`(()=>{const ta=document.querySelector('.split-l textarea');
    if(!ta) return false;
    ta.value='客户追加：款号 HS-2026-09，320gsm 棉质毛圈，灰色和藏青，M/200 L/200 共 400 件，做旧水洗+绣花，单价 7.9 美金 FOB 宁波，交期 2026-12-20。';
    ta.dispatchEvent(new Event('input',{bubbles:true})); return true})()`);
  await sleep(500);
  await ev(`(()=>{const b=[...document.querySelectorAll('.split-l button')].find(x=>x.textContent.includes('抽取'));if(b)b.click();return !!b})()`);
  await sleep(1800);
  console.log('抽取字段', await ev('document.querySelectorAll(".ex-tbl tbody tr").length'));
  console.log('草稿行数', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  await shot('02-需求抽取');

  // 核准弹窗
  await ev(`(()=>{const b=[...document.querySelectorAll('.tb-tbl tbody tr button')].find(x=>x.textContent.trim()==='核准');if(b)b.click();return !!b})()`);
  await sleep(900);
  await shot('03-核准弹窗');
  await closeModal();

  // ---- 异常解释 ----
  await clickTab('异常解释');
  console.log('异常条数', await ev('document.querySelectorAll(".anom").length'));
  await ev(`(()=>{const a=document.querySelector('.anom');if(a)a.click();return !!a})()`);
  await sleep(1600);
  console.log('解释条目', await ev('document.querySelectorAll(".finding").length'));
  await shot('04-异常解释');

  // ---- 风险预测 ----
  await clickTab('风险预测');
  console.log('风险行数', await ev('document.querySelectorAll(".risk-tbl tbody tr").length'));
  await shot('05-风险预测');

  // ---- 周报 ----
  await clickTab('周报与绩效解释');
  console.log('周报行数', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  await shot('06-周报列表');
  await ev(`(()=>{const tr=[...document.querySelectorAll('.tb-tbl tbody tr')].find(x=>x.textContent.includes('刘海燕'));
    if(!tr){const b=document.querySelector('.tb-tbl tbody tr button');if(b)b.click();return 'fallback'}
    const b=[...tr.querySelectorAll('button')].find(x=>x.textContent.includes('查看'));if(b)b.click();return true})()`);
  await sleep(1400);
  console.log('周报段落', await ev('document.querySelectorAll(".wk-sec").length'));
  await shot('07-周报详情');
  await closeModal();

  // ---- 客服 ----
  await clickTab('客服辅助与接管');
  console.log('FAQ 条数', await ev('document.querySelectorAll(".faq").length'));
  await ev(`(()=>{const ta=document.querySelector('.split-l textarea');
    if(!ta) return false;
    ta.value='我这单什么时候能发货？';
    ta.dispatchEvent(new Event('input',{bubbles:true})); return true})()`);
  await sleep(400);
  await ev(`(()=>{const b=[...document.querySelectorAll('.split-l button')].find(x=>x.textContent.includes('生成建议'));if(b)b.click();return !!b})()`);
  await sleep(1500);
  await shot('08-客服辅助');
  console.log('接管行数', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));

  // ---- 评测 ----
  await clickTab('评测审计');
  console.log('评测批次', await ev('document.querySelectorAll(".tb-tbl tbody tr").length'));
  console.log('用例数', await ev('document.querySelectorAll(".tb-tbl")[1]?.querySelectorAll("tbody tr").length'));
  await shot('09-评测审计');
  await ev(`(()=>{const b=[...document.querySelectorAll('.tb-tbl tbody tr button')].find(x=>x.textContent.includes('明细'));if(b)b.click();return !!b})()`);
  await sleep(1200);
  await shot('10-评测明细');
  await closeModal();

  // ---- 移动端 ----
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: BASE + '/ai-center' });
  await sleep(4200);
  await shot('11-移动端');
  console.log('对话框', JSON.stringify(dialogs.slice(0, 4)));

  proc.kill();
  process.exit(0);
})();
