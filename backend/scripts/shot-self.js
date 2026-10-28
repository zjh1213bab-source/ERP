/**
 * 员工自助 · 截图与文本取证
 * 用法：node scripts/shot-self.js
 *
 * 取证重点是「视角不同看到的东西不同」：
 *   1. 员工（wangfang）—— 自己的考勤/工资条/申请，工资条能点明细
 *   2. 员工（wuxiaoling）—— 不同的人，数据不同
 *   3. 未绑定账号（sales01）—— 只看到「请联系人事绑定」，看不到任何数据
 *   4. 人事（hr01）—— 受理台 + 账号绑定（员工看不到这两块）
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/self');
const PORT = 9899;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const login = async (u) => {
    const r = await (await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: PASS })
    })).json();
    return r.ok ? r.data : null;
  };

  const profile = pathMod.join(require('os').tmpdir(), 'erp-shot-' + PORT);
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
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      console.log('⚠ 弹窗:', m.params.message.slice(0, 160));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
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
  const shot = async (name, w = 1440) => {
    if (w < 500) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1200, deviceScaleFactor: 2, mobile: true });
      await sleep(700);
    }
    const h = await ev(`Math.ceil(Math.max(...[...document.querySelectorAll('.page > *')].map(e=>e.getBoundingClientRect().bottom))) + 40`);
    const height = Math.min(Math.max(Number(h) || 1100, 900), 5000);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(800);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '高度', height);
    if (w > 500) { await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
  };
  const go = async (url, wait = 5500) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };
  const clickTab = async (label) => {
    const r = await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.trim()==='${label}');if(b){b.click();return true}return false})()`);
    await sleep(1300);
    return r;
  };
  const asUser = async (u) => {
    const lg = await login(u);
    if (!lg) { console.log('登录失败', u); return false; }
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'localStorage.setItem("erp_token","' + lg.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.user)) + ');'
    });
    return true;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

  /* ---------- 员工：王芳 ---------- */
  await asUser('wangfang');
  await go('/self');
  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('侧栏:', await ev("!!document.querySelector('.erp-sidebar')"));
  console.log('菜单选中:', await ev("document.querySelector('.erp-nav .router-link-active')?.textContent?.trim()"));
  console.log('顶部标记:', await ev("document.querySelector('.head-ops .tag')?.textContent"));
  console.log('KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('可见标签:', await ev(`JSON.stringify([...document.querySelectorAll('.tabs button')].map(b=>b.textContent.trim()))`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-员工-我的概览');

  await clickTab('我的工资条');
  console.log('工资条行数:', await ev("document.querySelectorAll('.panel .data tbody tr').length"));
  console.log('工资条首行:', await ev(`(()=>{const tr=document.querySelector('.panel .data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  await shot('02-员工-我的工资条');

  // 点明细
  await ev(`(()=>{const b=[...document.querySelectorAll('.panel .data tbody tr .btn')].find(x=>x.textContent.includes('看明细'));if(b){b.click();return true}return false})()`);
  await sleep(1500);
  console.log('明细标题:', await ev("document.querySelector('.detail-h b')?.textContent"));
  console.log('明细视角:', await ev("document.querySelector('.detail-h .tag')?.textContent"));
  console.log('明细内容:', (await ev("document.querySelector('.detail')?.innerText?.replace(/\\n/g,' / ')") || '').slice(0, 220));
  await shot('03-员工-工资明细');

  await clickTab('我的申请');
  console.log('我的申请行数:', await ev("document.querySelectorAll('.panel .data tbody tr').length"));
  console.log('申请表行:', await ev(`(()=>{const tr=document.querySelector('.panel .data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  // 打开补卡表单
  await ev(`(()=>{const b=[...document.querySelectorAll('.head-ops .btn, .panel-head .btn')].find(x=>x.textContent.trim()==='补卡');if(b){b.click();return true}return false})()`);
  await sleep(900);
  console.log('补卡表单:', (await ev("document.querySelector('.form-box')?.innerText?.replace(/\\n/g,' / ')") || '').slice(0, 160));
  await shot('04-员工-提交申请');

  /* ---------- 员工：吴小玲（换个人，数据不同） ---------- */
  await asUser('wuxiaoling');
  await go('/self');
  console.log('\n吴小玲 KPI:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));

  /* ---------- 未绑定账号 ---------- */
  await asUser('sales01');
  await go('/self');
  console.log('\n未绑定提示:', (await ev("document.querySelector('.notice')?.innerText?.replace(/\\n/g,' / ')") || '').slice(0, 160));
  console.log('未绑定时 KPI 卡数量:', await ev("document.querySelectorAll('.cards.c6 .stat-card').length"));
  await shot('05-未绑定账号');

  /* ---------- 人事：受理台 + 账号绑定 ---------- */
  await asUser('hr01');
  await go('/self');
  console.log('\n人事可见标签:', await ev(`JSON.stringify([...document.querySelectorAll('.tabs button')].map(b=>b.textContent.trim()))`));
  await clickTab('受理台');
  console.log('受理台行数:', await ev("document.querySelectorAll('.panel .data tbody tr').length"));
  console.log('受理台首行:', await ev(`(()=>{const tr=document.querySelector('.panel .data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  console.log('调整单块:', (await ev("document.querySelector('.box .box-h')?.textContent") || '无'));
  await shot('06-人事-受理台');

  await clickTab('账号绑定');
  console.log('绑定行数:', await ev("document.querySelectorAll('.panel .data tbody tr').length"));
  console.log('绑定摘要:', await ev("document.querySelector('.panel-head .mut')?.textContent"));
  await shot('07-人事-账号绑定');

  // 移动端（员工视角）
  await asUser('wangfang');
  await go('/self');
  await shot('08-移动端', 414);

  proc.kill();
  process.exit(0);
})();
