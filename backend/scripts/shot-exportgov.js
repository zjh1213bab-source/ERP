/**
 * 数据导出与订阅 · 截图与文本取证
 * 用法：node scripts/shot-exportgov.js
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { db } = require('../src/db');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/exportgov');
const PORT = 9911;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 用一个真实的敏感级水印做反查演示
  const wmRow = db.prepare("SELECT watermark FROM export_jobs WHERE def_key='ar_aging' AND watermark IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  const WM = wmRow ? wmRow.watermark : 'EXP-CK202610280001-20261028-A7F3';

  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS })
  })).json();

  const profile = pathMod.join(os.tmpdir(), 'erp-shot-' + PORT);
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1440,1100', 'about:blank'], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 80 && !t; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) { t = await r.json(); break; }
    } catch (e) { /* ignore */ }
  }
  if (!t) { console.log('连不上调试端口'); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      console.log('⚠ 弹窗:', m.params.message.slice(0, 200).replace(/\n/g, ' / '));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.text).slice(0, 160));
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (mm, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  // 截图时不真落盘（导出会触发下载），否则每次截图都在下载目录里堆文件
  await send('Page.setDownloadBehavior', { behavior: 'deny' });

  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 200);
    return r.result ? r.result.value : null;
  };
  const shot = async (name, w = 1440) => {
    if (w < 500) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1200, deviceScaleFactor: 2, mobile: true });
      await sleep(700);
    }
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *')].map(e=>e.getBoundingClientRect().bottom))) + 40`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 5400);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(800);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };
  const go = async (url, wait = 6000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };
  const clickText = async (sel, text) => ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  await go('/export-center');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('数据集数:', await ev("document.querySelectorAll('.def-item').length"));
  console.log('分组:', await ev(`JSON.stringify([...document.querySelectorAll('.def-group-h')].map(e=>e.textContent))`));

  // 选「部门人数分布」——最能体现小样本抑制的数据集
  await ev(`(()=>{const a=[...document.querySelectorAll('.def-item')].find(x=>x.innerText.includes('部门人数分布'));if(a){a.click();return true}return false})()`);
  await sleep(900);
  console.log('当前数据集:', await ev("document.querySelector('.dm-head b')?.textContent"));
  console.log('参数框:', await ev(`JSON.stringify([...document.querySelectorAll('.pfield label')].map(e=>e.textContent))`));
  await ev(`(()=>{const b=[...document.querySelectorAll('.params button')].find(x=>x.textContent.includes('预览'));if(b){b.click();return true}return false})()`);
  await sleep(1800);
  console.log('预览信息:', await ev("document.querySelector('.pv-head .tiny')?.textContent?.replace(/\\s+/g,' ')"));
  console.log('预览首行:', await ev(`(()=>{const r=document.querySelector('.preview table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  console.log('抑制行:', await ev(`JSON.stringify([...document.querySelectorAll('.preview table.data tbody tr')].filter(r=>r.innerText.includes('<5')).map(r=>r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / ')))`));
  await shot('01-导出中心与预览');

  // 敏感数据集：客户档案（电话邮箱被掩）
  await ev(`(()=>{const a=[...document.querySelectorAll('.def-item')].find(x=>x.innerText.includes('客户档案'));if(a){a.click();return true}return false})()`);
  await sleep(800);
  await ev(`(()=>{const b=[...document.querySelectorAll('.params button')].find(x=>x.textContent.includes('预览'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  console.log('\n客户预览首行:', await ev(`(()=>{const r=document.querySelector('.preview table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));

  // 真导一次（下载被 deny，但页面会显示单号与水印）
  await ev(`(()=>{const i=[...document.querySelectorAll('.run-box input')][0];if(i){i.value='演示：月末对账需要客户联系方式';i.dispatchEvent(new Event('input'));return true}return false})()`);
  await sleep(300);
  await ev(`(()=>{const b=[...document.querySelectorAll('.run-box button')].find(x=>x.textContent.includes('导出'));if(b){b.click();return true}return false})()`);
  await sleep(2200);
  console.log('导出结果:', await ev("document.querySelector('.hint-box')?.innerText?.replace(/\\n/g,' ')"));
  await shot('02-导出结果与水印');

  // 周期订阅
  await clickText('.tabs button', '周期订阅');
  await sleep(1600);
  console.log('\n订阅行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('订阅首行:', await ev(`(()=>{const r=document.querySelector('table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  console.log('到期提示:', await ev("document.querySelector('.notice-warn')?.innerText?.slice(0,100)"));
  await shot('03-周期订阅');

  // 新建订阅弹窗
  await ev(`(()=>{const b=[...document.querySelectorAll('.toolbar button')].find(x=>x.textContent.includes('新建订阅'));if(b){b.click();return true}return false})()`);
  await sleep(1000);
  console.log('\n弹窗标题:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('弹窗字段:', await ev(`JSON.stringify([...document.querySelectorAll('.modal-body .row > label:first-child')].map(e=>e.textContent.trim()))`));
  console.log('渠道选项:', await ev(`JSON.stringify([...document.querySelectorAll('.modal select')].map(s=>[...s.options].map(o=>o.text)))`));
  await shot('04-新建订阅');
  await ev("document.querySelector('.modal-head button').click()");
  await sleep(500);

  // 导出记录
  await clickText('.tabs button', '导出记录');
  await sleep(1600);
  console.log('\n记录行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  console.log('记录首行:', await ev(`(()=>{const r=document.querySelector('table.data tbody tr');return r?r.innerText.replace(/\\n/g,' | ').replace(/\\t/g,' / '):'（空）'})()`));
  console.log('记录范围:', await ev("document.querySelector('.panel-head .head-ops')?.innerText"));
  await shot('05-导出记录');

  // 水印反查
  await clickText('.tabs button', '水印反查');
  await sleep(1500);
  await ev(`(()=>{const i=document.querySelector('.trace-box input');if(i){i.value='${WM}';i.dispatchEvent(new Event('input'));return true}return false})()`);
  await sleep(300);
  await ev(`(()=>{const b=[...document.querySelectorAll('.tb-row button')].find(x=>x.textContent.includes('反查'));if(b){b.click();return true}return false})()`);
  await sleep(1600);
  console.log('\n反查结果:', await ev(`JSON.stringify([...document.querySelectorAll('.trace-res .kv')].map(x=>x.innerText.replace(/\\n/g,' ')))`));
  console.log('产出行数:', await ev("document.querySelectorAll('table.data tbody tr').length"));
  await shot('06-水印反查与产出');

  // 移动端
  await clickText('.tabs button', '导出中心');
  await sleep(1500);
  await shot('07-移动端', 414);
  console.log('移动端横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

  console.log('\n内存横向溢出(桌面):', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  console.log('前端异常:', errors.length ? JSON.stringify(errors) : '无');
  proc.kill();
  process.exit(0);
})();
