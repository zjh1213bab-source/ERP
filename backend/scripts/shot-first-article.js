/**
 * 截图：首件确认与工位工艺
 *   node scripts/shot-first-article.js
 * 截「待复核 → 复核放行 → 可投产」三态，截完把演示数据复原成「待复核」。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db } = require('../src/db');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/first-article');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const token = login.data.token;
  const call = async (m, p, b) => {
    const r = await fetch(BASE + p, {
      method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: b ? JSON.stringify(b) : undefined
    });
    return r.json();
  };

  const fa = (await call('GET', '/api/first-articles/order/5')).data.fa;
  console.log('演示首件单：', fa ? `${fa.fa_no}（${fa.status_label}，${fa.checks.length} 项）` : '无');

  const port = 9580;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1600,1400', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* retry */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1400, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('  JS异常', String(r.exceptionDetails.text).slice(0, 160));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT, name + '.png');
    if (s && s.data) fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    console.log('  截图 →', path.basename(file));
  };

  await send('Page.navigate', { url: BASE + '/first-article' });
  await sleep(3800);
  console.log('看板行数:', await evalJs('document.querySelectorAll("tbody tr").length'));
  await shot('01-首件看板-投产拦截');

  const opened = await evalJs(`(async () => {
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('SO202610260005'));
    if (!tr) return 'no-row';
    const btn = [...tr.querySelectorAll('.link-btn')][0];
    btn.click();
    await new Promise(r => setTimeout(r, 2200));
    return document.querySelector('.fa-modal') ? 'opened' : 'no-modal';
  })()`);
  console.log('详情弹窗:', opened);
  await shot('02-首件详情-待复核');

  // 滚到检查项
  const scrolled = await evalJs(`(async () => {
    const b = document.querySelector('.fa-modal .modal-body');
    if (!b) return 'no-body';
    b.scrollTop = b.scrollHeight * 0.42;
    await new Promise(r => setTimeout(r, 700));
    return b.scrollTop;
  })()`);
  console.log('滚动位置:', scrolled);
  await shot('03-工位工艺与检查项');

  // 放行（用接口，避免 alert 阻塞截图）
  const rel = await call('POST', `/api/first-articles/${fa.id}/release`, {
    result: 'passed', release_qty: fa.order_qty || fa.batch_qty, conclusion: '首件合格，全批放行'
  });
  console.log('放行:', rel.ok ? `成功 ${rel.data.release_qty} 件` : rel.message);

  await send('Page.navigate', { url: BASE + '/first-article' });
  await sleep(3200);
  await shot('04-放行后-可批量投产');

  // ---- 复原演示状态：回到「待复核」，让用户自己点放行 ----
  db.prepare("UPDATE first_articles SET status='submitted', release_qty=0, conclusion=NULL, released_by=NULL, released_at=NULL WHERE id=?").run(fa.id);
  if (fa.fa_no) {
    db.prepare("UPDATE order_nodes SET remark = REPLACE(COALESCE(remark,''), ?, '') WHERE order_id = 5")
      .run(` [首件 ${fa.fa_no} 合格放行 ${rel.data ? rel.data.release_qty : ''} 件，按 V1 版]`);
  }
  console.log('已复原为「待复核」');

  ws.close();
  proc.kill();
  console.log('完成');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
