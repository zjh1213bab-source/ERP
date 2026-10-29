/**
 * 物料 → 款 × 颜色 · 截图与文本取证
 * 用法：node scripts/shot-matcolor.js
 *
 * 截四张：
 *   01 订单详情的面辅料表（多了「款」「适用颜色」两列 + 配颜色入口）
 *   02 新增面辅料的表单（选款 → 勾颜色）
 *   03 配色弹窗：按颜色分别指定（色号 / 该色单件用量）
 *   04 配色弹窗：该款所有颜色通用
 *
 * 判定读 textContent，不看截图猜。
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/matcolor');
const PORT = 9986;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS })
  })).json();
  if (!lg.data || !lg.data.token) { console.log('登录失败'); process.exit(1); }
  const token = lg.data.token;

  /* 挑一张有「款 × 颜色」物料的单：直接查库，避免在看板上翻页找 */
  const { db } = require('../src/db');
  const pick = db.prepare(`
    SELECT DISTINCT o.id, o.order_no
      FROM order_materials m JOIN orders o ON o.id = m.order_id
     WHERE m.item_id IS NOT NULL
     ORDER BY m.id DESC LIMIT 1`).get();
  if (!pick) { console.log('库里没有挂到款上的物料，先跑一次接口造数据'); process.exit(1); }
  console.log('选单:', pick.order_no, '(id ' + pick.id + ')');

  const profile = pathMod.join(os.tmpdir(), 'erp-shot-' + PORT);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1680,1000'], { stdio: 'ignore' });

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
      console.log('⚠ 弹窗:', m.params.message.slice(0, 120).replace(/\n/g, ' / '));
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
  const shot = async (name, h = 1000) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(650);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + token + '");'
      + 'localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  await send('Page.navigate', { url: BASE + '/orders?order=' + pick.id });
  await sleep(6000);

  // ---------- 1. 面辅料表 ----------
  console.log('\n弹窗标题:', await ev("document.querySelector('.modal-head h3')?.innerText?.replace(/\\n/g,' ')"));
  console.log('物料表头:', await ev(`(()=>{
    const hs=[...document.querySelectorAll('.modal .data thead th')];
    const t=hs.find(h=>h.textContent.includes('适用颜色'))?.closest('table');
    return t?JSON.stringify([...t.querySelectorAll('thead th')].map(x=>x.textContent.trim())):'未找到';
  })()`));
  console.log('物料行:', await ev(`(()=>{
    const hs=[...document.querySelectorAll('.modal .data thead th')];
    const t=hs.find(h=>h.textContent.includes('适用颜色'))?.closest('table');
    if(!t) return '未找到';
    return JSON.stringify([...t.querySelectorAll('tbody tr')].map(r=>[...r.children].map(c=>c.innerText.trim().replace(/\\n/g,' '))));
  })()`));
  await ev(`(()=>{const h=[...document.querySelectorAll('.modal h3')].find(x=>x.textContent.includes('面辅料用量'));if(h)h.scrollIntoView({block:'center'});return true})()`);
  await sleep(600);
  await shot('01-面辅料表-款与颜色');

  // ---------- 2. 新增表单：选款 + 勾颜色 ----------
  const opened = await ev(`(()=>{const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.includes('添加面辅料'));if(!b)return 'no-btn';b.click();return true})()`);
  console.log('\n点添加面辅料:', opened);
  await sleep(900);
  console.log('款下拉选项:', await ev(`(()=>{
    const sels=[...document.querySelectorAll('.modal select')];
    const s=sels.find(x=>[...x.options].some(o=>o.textContent.includes('订单通用')));
    return s?JSON.stringify([...s.options].map(o=>o.textContent.trim())):'未找到款下拉';
  })()`));
  // 选第一款，看颜色勾选项是否出现
  console.log('选款:', await ev(`(()=>{
    const sels=[...document.querySelectorAll('.modal select')];
    const s=sels.find(x=>[...x.options].some(o=>o.textContent.includes('订单通用')));
    if(!s) return 'no-select';
    const opt=[...s.options].find(o=>!o.textContent.includes('订单通用'));
    if(!opt) return 'no-item';
    s.value=opt.value; s.dispatchEvent(new Event('change'));
    return opt.textContent.trim();
  })()`));
  await sleep(700);
  console.log('颜色勾选项:', await ev(`(()=>{
    const lbls=[...document.querySelectorAll('.modal label')].filter(l=>/（\\d+ 件）/.test(l.textContent));
    return JSON.stringify(lbls.map(l=>l.textContent.trim()));
  })()`));
  await shot('02-新增表单-选款勾颜色', 1100);

  // ---------- 3/4. 配色弹窗 ----------
  await ev(`(()=>{const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='取消');if(b)b.click();return true})()`);
  await sleep(600);
  const cfg = await ev(`(()=>{const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='配颜色');if(!b)return 'no-btn';b.click();return true})()`);
  console.log('\n点配颜色:', cfg);
  await sleep(1400);
  console.log('弹窗标题:', await ev("document.querySelectorAll('.modal')[1]?.querySelector('h3')?.innerText?.replace(/\\n/g,' ')"));
  console.log('颜色行:', await ev(`(()=>{
    const ms=[...document.querySelectorAll('.modal')];
    const m=ms[ms.length-1];
    const rows=[...m.querySelectorAll('tbody tr')];
    return JSON.stringify(rows.map(r=>[...r.children].map(c=>c.innerText.trim()||c.querySelector('input')?.value||'').join(' | ')));
  })()`));
  await shot('03-配色弹窗-按色指定', 1000);

  console.log('切到全部颜色:', await ev(`(()=>{
    const ms=[...document.querySelectorAll('.modal')];
    const m=ms[ms.length-1];
    const r=[...m.querySelectorAll('input[type=radio]')][0];
    if(!r) return 'no-radio';
    r.click(); return true;
  })()`));
  await sleep(700);
  console.log('全色提示:', await ev(`(()=>{
    const ms=[...document.querySelectorAll('.modal')];
    const m=ms[ms.length-1];
    return m.querySelector('.ok-box')?.innerText?.trim() || '无提示';
  })()`));
  await shot('04-配色弹窗-全部颜色', 900);

  console.log('\n前端异常:', errors.length ? errors.join(' | ') : '无');
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
