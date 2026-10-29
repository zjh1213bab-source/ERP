/**
 * 仅扫码工序（检验 / 包装）· 截图与文本取证
 * 用法：node scripts/shot-scansteps.js
 *
 * 截三张：
 *   01 订单跟踪看板 —— 列里没有检验/包装（13 列正好放下）
 *   02 工序流程配置 —— 这两步标「仅扫码」，可一键切回显示
 *   03 订单信息看板 —— 工序明细里它们标着「·扫码」，解释了为什么进度不是 100%
 *
 * 判定读 textContent，不看截图猜。
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/scansteps');
const PORT = 9966;
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
    '--hide-scrollbars', '--window-size=1920,1000'], { stdio: 'ignore' });

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
  let id = 0; const pend = new Map(); const errors = [];
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

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 200);
    return r.result ? r.result.value : null;
  };
  const shot = async (name, w = 1920, h = 1000) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(650);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const go = async (url, wait = 5200) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");'
  });

  // ---------- 1. 看板：13 列，不含检验 / 包装 ----------
  await go('/order-tracking');
  const names = await ev(`JSON.stringify([...document.querySelectorAll('.po-fnode-title')].map(x=>x.textContent.trim()))`);
  const uniq = Array.from(new Set(JSON.parse(names || '[]')));
  console.log('\n工序列（' + uniq.length + '）:', uniq.join(' / '));
  console.log('含检验:', uniq.includes('检验'), '| 含包装:', uniq.includes('包装'));
  console.log('订单行数:', await ev("document.querySelectorAll('.po-item').length"));
  const overflow = await ev("(()=>{const w=document.querySelector('.po-flow-scroll');return w?w.scrollWidth+' / 可视 '+w.clientWidth:'无'})()");
  console.log('工序区宽度:', overflow);
  await shot('01-看板不含检验包装', 1920, 1000);

  // ---------- 2. 配置页：仅扫码标记 ----------
  await go('/node-flow');
  console.log('\n配置页节点行数:', await ev("document.querySelectorAll('.nf-main table.data tbody tr').length"));
  console.log('仅扫码按钮:', await ev(`JSON.stringify([...document.querySelectorAll('.nf-req-tgl.scan')].map(b=>b.closest('tr').querySelectorAll('td')[1]?.innerText.trim()+'='+b.textContent.trim()))`));
  console.log('表头:', await ev(`JSON.stringify([...document.querySelectorAll('.nf-main table.data thead th')].map(x=>x.textContent.trim()))`));
  await shot('02-配置页仅扫码标记', 1920, 1000);

  // ---------- 3. 订单信息看板：工序明细标「·扫码」 ----------
  await go('/order-tracking');
  const clicked = await ev(`(()=>{const a=document.querySelector('.po-item .po-row.clickable');if(a){a.click();return true}return false})()`);
  console.log('\n点开订单:', clicked);
  await sleep(2600);
  const detail = await ev(`(()=>{
    const rows=[...document.querySelectorAll('.pk-f, .pk-field, .pk-kv tr, .modal-body tr')];
    return JSON.stringify(rows.map(r=>r.innerText.replace(/\\n/g,':')).filter(x=>x.includes('工序')).slice(0,3));
  })()`);
  console.log('工序相关字段:', detail);
  console.log('含「扫码」字样:', await ev("document.body.innerText.includes('·扫码')"));

  // 工序进度在弹窗偏下，滚到底才看得见 —— 不滚就只截到「下单信息」
  await ev("(()=>{const b=document.querySelector('.modal .modal-body');if(b)b.scrollTop=b.scrollHeight;return b?b.scrollTop:null})()");
  await sleep(600);
  console.log('工序进度字段:', await ev(`(()=>{
    const tds=[...document.querySelectorAll('.modal .modal-body *')].filter(x=>x.children.length===0&&/工序|当前环节/.test(x.textContent||''));
    return JSON.stringify(tds.map(x=>x.textContent.trim()).slice(0,4));
  })()`));
  console.log('明细里的扫码标记:', await ev(`(()=>{
    const m=document.body.innerText.match(/(检验|包装)\([^)]*扫码[^)]*\)/g);
    return JSON.stringify(m||[]);
  })()`));
  await shot('03-详情工序明细标扫码', 1920, 1000);

  console.log('\n前端异常:', errors.length ? errors.join(' | ') : '无');
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
