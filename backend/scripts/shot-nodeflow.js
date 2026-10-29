/**
 * 工序流程节点可自定义 · 截图与文本取证
 * 用法：node scripts/shot-nodeflow.js
 *
 * 截三张：
 *   01 订单跟踪看板（横向节点列 = 模板节点）
 *   02 工序流程配置（节点清单，可改名/调序/停用/加自定义节点）
 *   03 应用到已有订单的影响面预览
 *
 * 判定一律读 textContent，不看截图猜。
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/nodeflow');
const PORT = 9946;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS })
  })).json();
  if (!lg.data || !lg.data.token) { console.log('登录失败'); process.exit(1); }

  const profile = pathMod.join(os.tmpdir(), 'erp-shot-' + PORT);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1600,1200'], { stdio: 'ignore' });

  let t = null;
  for (let i = 0; i < 80 && !t; i += 1) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) { t = await r.json(); break; }
    } catch (e) { /* ignore */ }
  }
  if (!t) { console.log('连不上调试端口'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      console.log('⚠ 弹窗:', m.params.message.slice(0, 160).replace(/\n/g, ' / '));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.text).slice(0, 200));
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (mm, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 200);
    return r.result ? r.result.value : null;
  };
  const shot = async (name, w = 1600, h = 900) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(650);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const go = async (url, wait = 5000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  // ---------- 1. 订单跟踪看板 ----------
  await go('/order-tracking');
  console.log('\n页头:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('副标题:', await ev("document.querySelector('.page-head .sub')?.innerText?.replace(/\\n/g,' ')"));
  console.log('汇总卡:', await ev(`JSON.stringify([...document.querySelectorAll('.stat-card')].map(x=>x.innerText.replace(/\\n/g,'=')))`));
  console.log('节点列:', await ev(`JSON.stringify([...document.querySelectorAll('.trk-col-name')].map(x=>x.textContent.trim()))`));
  console.log('订单行数:', await ev("document.querySelectorAll('.trk-table tbody tr').length"));
  console.log('首行单元状态:', await ev(`JSON.stringify([...document.querySelectorAll('.trk-table tbody tr:first-child .trk-cell')].slice(0,6).map(x=>x.innerText.replace(/\\n/g,'/')))`));
  console.log('首行左侧:', await ev("document.querySelector('.trk-table tbody tr:first-child .trk-fixed')?.innerText?.replace(/\\n/g,' | ')"));
  console.log('横向滚动:', await ev("(()=>{const w=document.querySelector('.trk-wrap');return w?w.scrollWidth+' / 可视 '+w.clientWidth:'无'})()"));
  await shot('01-订单跟踪看板', 1600, 820);

  // ---------- 2. 工序流程配置 ----------
  await go('/node-flow');
  console.log('\n配置页流程数:', await ev("document.querySelectorAll('.nf-tpl').length"));
  console.log('当前流程:', await ev("document.querySelector('.nf-head h3')?.textContent"));
  console.log('节点行数:', await ev("document.querySelectorAll('.nf-main table.data tbody tr').length"));
  console.log('节点清单:', await ev(`JSON.stringify([...document.querySelectorAll('.nf-main table.data tbody tr')].map(r=>{const c=r.querySelectorAll('td');return c[0]?.textContent+':'+c[1]?.innerText.trim()+'('+c[2]?.textContent+','+c[3]?.innerText.trim()+')'}))`));
  console.log('改名提示:', await ev("document.querySelector('.nf-tip')?.innerText?.replace(/\\n/g,' ').slice(0,120)"));
  await shot('02-工序流程配置', 1600, 900);

  // ---------- 3. 应用到已有订单：影响面 ----------
  const opened = await ev(`(()=>{const b=[...document.querySelectorAll('.nf-head button')].find(x=>x.textContent.includes('应用到已有订单'));if(b){b.click();return true}return false})()`);
  console.log('\n点应用:', opened);
  await sleep(2500);
  console.log('影响面:', await ev("document.querySelector('.modal-body .warn-box, .modal-body .ok-box')?.innerText?.replace(/\\n/g,' ')"));
  console.log('明细行:', await ev(`JSON.stringify([...document.querySelectorAll('.ap-row')].slice(0,4).map(x=>x.innerText.replace(/\\n/g,' ')))`));
  await shot('03-应用影响面', 1600, 820);
  await ev("document.querySelector('.modal .x')?.click()");
  await sleep(500);

  console.log('\n前端异常:', errors.length ? errors.join(' | ') : '无');
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
