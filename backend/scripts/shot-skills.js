/**
 * 技能矩阵与岗位资格 · 截图与文本取证
 * 用法：node scripts/shot-skills.js
 *
 * 取证重点不是「页面能打开」，而是四件事在页面上真的成立：
 *   1. 矩阵里同一个人不同工序的状态不同（绿/黄/灰/红同时存在）
 *   2. 覆盖缺口列出「谁没人」和「哪些工序没门槛」
 *   3. 到期清单里既有快到期也有已过期
 *   4. 受限工序的格子点开能进评定/破格
 */
const fs = require('fs');
const pathMod = require('path');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/skills');
const PORT = 9897;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();

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
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR:' + String(r.exceptionDetails.text).slice(0, 200);
    return r.result ? r.result.value : null;
  };
  const shot = async (name, w = 1440) => {
    // 先切宽度再量高度：桌面量完再切 414，内容会重新排版变高，量出来的高度就不够（踩过，截图被裁）
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
  const shotFixed = async (name, w = 1440, h = 940) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name, '固定', w + 'x' + h);
  };
  const go = async (url, wait = 6000) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };
  const clickTab = async (label) => {
    const r = await ev(`(()=>{const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.trim()==='${label}');if(b){b.click();return true}return false})()`);
    await sleep(1400);
    return r;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await go('/skills');

  console.log('标题:', await ev("document.querySelector('.page-head h2')?.textContent"));
  console.log('侧栏:', await ev("!!document.querySelector('.erp-sidebar')"));
  console.log('菜单选中:', await ev("document.querySelector('.erp-nav .sub.router-link-active')?.textContent?.trim()"));
  console.log('统计卡:', await ev(`JSON.stringify([...document.querySelectorAll('.cards.c6 .stat-card')].map(c=>c.innerText.replace(/\\n/g,'/')))`));
  console.log('矩阵行数:', await ev("document.querySelectorAll('table.matrix tbody tr').length"));
  console.log('矩阵列数:', await ev("document.querySelectorAll('table.matrix thead th').length"));
  console.log('格子状态分布:', await ev(`JSON.stringify({
    ok: document.querySelectorAll('table.matrix .lv.ok').length,
    short: document.querySelectorAll('table.matrix .lv.short').length,
    evidence: document.querySelectorAll('table.matrix .lv.evidence').length,
    expired: document.querySelectorAll('table.matrix .lv.expired').length,
    override: document.querySelectorAll('table.matrix .ov').length
  })`));
  console.log('表头工序:', await ev(`JSON.stringify([...document.querySelectorAll('table.matrix thead th')].slice(2).map(x=>x.innerText.replace(/\\n/g,'/').trim()))`));
  console.log('李四这一行:', await ev(`(()=>{const tr=[...document.querySelectorAll('table.matrix tbody tr')].find(r=>r.innerText.includes('李四'));return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'未找到'})()`));
  console.log('横向溢出:', await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth'));
  await shot('01-技能矩阵');

  // 覆盖缺口
  await clickTab('覆盖缺口');
  console.log('覆盖行数:', await ev("document.querySelectorAll('.panel .data tbody tr').length"));
  console.log('覆盖前3行:', await ev(`JSON.stringify([...document.querySelectorAll('.panel > div .data tbody tr')].slice(0,3).map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  console.log('未建门槛工序:', await ev(`JSON.stringify([...document.querySelectorAll('.box')][0]?.innerText.replace(/\\n/g,' / ').slice(0,220))`));
  await shot('02-覆盖缺口');

  // 到期
  await clickTab('到期提醒');
  console.log('到期行数:', await ev("document.querySelectorAll('.panel .data tbody tr').length"));
  console.log('到期前3行:', await ev(`JSON.stringify([...document.querySelectorAll('.panel .data tbody tr')].slice(0,3).map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  await shot('03-到期提醒');

  // 证书
  await clickTab('资格证书');
  console.log('证书行数:', await ev("document.querySelectorAll('.panel .data tbody tr').length"));
  console.log('证书首行:', await ev(`(()=>{const tr=document.querySelector('.panel .data tbody tr');return tr?[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | '):'（空）'})()`));
  await shot('04-资格证书');

  // 培训
  await clickTab('培训记录');
  console.log('培训行数:', await ev("document.querySelectorAll('.panel .data tbody tr').length"));
  console.log('待完成条数:', await ev("document.querySelectorAll('.panel .data tbody tr').length && [...document.querySelectorAll('.panel .data tbody tr')].filter(tr=>tr.innerText.includes('待完成')).length"));
  await shot('05-培训记录');

  // 工序门槛
  await clickTab('工序门槛');
  console.log('门槛行数:', await ev("document.querySelectorAll('.panel .data tbody tr').length"));
  console.log('受限行数:', await ev("[...document.querySelectorAll('.panel .data tbody tr')].filter(tr=>tr.innerText.includes('受限')).length"));
  console.log('门槛前3行:', await ev(`JSON.stringify([...document.querySelectorAll('.panel .data tbody tr')].slice(0,3).map(tr=>[...tr.children].map(td=>td.innerText.replace(/\\n/g,' ').trim()).join(' | ')))`));
  await shot('06-工序门槛');

  // 回到矩阵，点一个格子看评定面板
  await clickTab('技能矩阵');
  await ev(`(()=>{const tr=[...document.querySelectorAll('table.matrix tbody tr')].find(r=>r.innerText.includes('李四'));if(!tr)return false;const tds=[...tr.children];const i=tds.findIndex(td=>td.innerText.includes('裁剪'));const cell=tds[3]||tds[2];cell.click();return true})()`);
  await sleep(900);
  console.log('弹窗标题:', await ev("document.querySelector('.modal-h b')?.textContent"));
  console.log('弹窗内容:', (await ev("document.querySelector('.modal-b')?.innerText?.replace(/\\n/g,' / ')") || '').slice(0, 200));
  await shotFixed('07-评定弹窗', 1440, 900);

  // 移动端
  await ev("document.querySelector('.modal-mask') && document.querySelector('.modal-h .btn')?.click()");
  await sleep(600);
  await shot('08-移动端', 414);

  proc.kill();
  process.exit(0);
})();
