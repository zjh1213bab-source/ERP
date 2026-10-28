/**
 * 上线检查清单 · 截图与文本取证
 * 用法：node scripts/shot-golive.js
 *
 * 截五张：当前评估（有阻塞）、人工判定弹窗、签署弹窗、已签署轮次的冻结快照、移动端。
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/golive');
const PORT = 9914;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASS })
  })).json();

  const profile = pathMod.join(os.tmpdir(), 'erp-shot-' + PORT);
  // 每次清掉 profile：Chrome 会缓存上一版 dist 的 JS，
  // 改了页面不重建 / 重建了不清缓存，截出来还是旧界面（这个坑踩过一次）
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1440,1200', 'about:blank'], { stdio: 'ignore' });

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
      console.log('⚠ 弹窗:', m.params.message.slice(0, 240).replace(/\n/g, ' / '));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.text).slice(0, 160));
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (mm, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.setDownloadBehavior', { behavior: 'deny' });

  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 200);
    return r.result ? r.result.value : null;
  };
  /**
   * 截图
   *
   * `full=false` 按固定视口截：弹窗是 fixed 定位，视口一旦拉到整页高度，
   * 弹窗会缩在顶部一小块、下面全是变空的长页面 —— 看起来不像弹窗。
   * 移动端也只在视口内看排版，不需要把 7000px 的长页全截下来。
   */
  const shot = async (name, w = 1440, full = true) => {
    if (w < 500) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1400, deviceScaleFactor: 2, mobile: true });
      await sleep(700);
    }
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *')].map(e=>e.getBoundingClientRect().bottom))) + 40`);
    const height = full ? Math.min(Math.max(Number(h) || 1200, 900), 7000) : 1100;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(800);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };
  const go = async (url, wait = 7000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };
  const clickText = async (sel, text) => ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes('${text}'));if(b){b.click();return true}return false})()`);

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  await go('/go-live');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('轮次下拉:', await ev(`JSON.stringify([...document.querySelectorAll('.head-ops select option')].map(o=>o.textContent.trim()))`));
  console.log('结论条:', await ev("document.querySelector('.verdict')?.innerText?.replace(/\\n/g,' | ')"));
  console.log('KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('阻塞清单:', await ev(`JSON.stringify([...document.querySelectorAll('.bb-row')].map(r=>r.innerText.replace(/\\n/g,' | ')))`));
  console.log('分区:', await ev(`JSON.stringify([...document.querySelectorAll('.sec-head h3')].map(h=>h.innerText.replace(/\\n/g,' ')))`));
  console.log('项目数:', await ev("document.querySelectorAll('.item').length"));
  console.log('自动项结果样例:', await ev(`(()=>{const r=[...document.querySelectorAll('.item')].find(x=>x.innerText.includes('总账借贷平衡'));return r?r.innerText.replace(/\\n/g,' | '):'（空）'})()`));
  console.log('人工项样例:', await ev(`(()=>{const r=[...document.querySelectorAll('.item')].find(x=>x.innerText.includes('岗位权限矩阵'));return r?r.innerText.replace(/\\n/g,' | '):'（空）'})()`));
  await shot('01-当前评估与阻塞');

  // 滚到人工项弹窗：点「判定」
  const opened = await ev(`(()=>{const r=[...document.querySelectorAll('.item')].find(x=>x.innerText.includes('关键岗位完成实操培训'));if(!r)return 'no-row';const b=[...r.querySelectorAll('button')].find(x=>x.textContent.includes('判定'));if(!b)return 'no-btn';b.click();return true})()`);
  console.log('\n打开判定弹窗:', opened);
  await sleep(1200);
  console.log('弹窗标题:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('弹窗说明:', await ev("document.querySelector('.modal-body .notice')?.innerText?.slice(0,120)"));
  await shot('02-人工判定弹窗', 1440, false);
  await ev("document.querySelector('.modal .modal-foot .btn-ghost')?.click()");
  await sleep(600);

  // 签署弹窗（阻塞态：只能签暂不上线）
  await clickText('.v-right button', '签署');
  await sleep(1200);
  console.log('\n签署弹窗:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('阻塞提示:', await ev("document.querySelector('.sign-block')?.innerText?.replace(/\\n/g,' | ')"));
  console.log('结论可选项:', await ev(`JSON.stringify([...document.querySelectorAll('.modal select option')].map(o=>o.textContent+(o.disabled?'(禁用)':'')))`));
  await shot('03-签署弹窗', 1440, false);
  await ev("document.querySelector('.modal .modal-foot .btn-ghost')?.click()");
  await sleep(600);

  // 切到已签署的第一轮，看冻结快照
  const opts = await ev(`JSON.stringify([...document.querySelectorAll('.head-ops select option')].map(o=>({v:o.value,t:o.textContent.trim()})))`);
  const list = JSON.parse(opts || '[]');
  const signed = list.find((x) => x.t.includes('已签署'));
  if (signed) {
    await ev(`(()=>{const s=document.querySelector('.head-ops select');s.value='${signed.v}';s.dispatchEvent(new Event('change'));return true})()`);
    await sleep(2500);
    console.log('\n切到已签署轮次:', await ev("document.querySelector('.verdict')?.innerText?.replace(/\\n/g,' | ')"));
    console.log('快照统计:', await ev(`JSON.stringify([...document.querySelectorAll('.snap-grid > div')].map(d=>d.innerText.replace(/\\n/g,' ')))`));
    console.log('签署后按钮:', await ev(`JSON.stringify([...document.querySelectorAll('.v-right button')].map(b=>b.textContent.trim()))`));
    await shot('04-已签署与冻结快照');
  } else {
    console.log('没有已签署轮次');
  }

  // 新建评估弹窗
  await ev(`(()=>{const s=document.querySelector('.head-ops select');s.value='${list.find(x=>x.t.includes('正式上线')) ? list.find(x=>x.t.includes('正式上线')).v : (list[0]||{}).v}';s.dispatchEvent(new Event('change'));return true})()`);
  await sleep(1800);
  await clickText('.head-ops button', '新建一轮评估');
  await sleep(1200);
  console.log('\n新建弹窗:', await ev("document.querySelector('.modal-head b')?.textContent"));
  console.log('口径选项:', await ev(`JSON.stringify([...document.querySelectorAll('.modal select option')].map(o=>o.textContent))`));
  await shot('05-新建评估弹窗', 1440, false);
  await ev("document.querySelector('.modal .modal-foot .btn-ghost')?.click()");
  await sleep(500);

  // 移动端
  await go('/go-live', 6000);
  await shot('06-移动端', 414, false);
  console.log('移动端横向溢出:', await ev("document.documentElement.scrollWidth > document.documentElement.clientWidth + 2"));

  console.log('\n前端异常:', errors.length ? errors.join(' | ') : '无');
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
