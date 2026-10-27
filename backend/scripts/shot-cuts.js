/**
 * 截图：裁床与扎包
 *   node scripts/shot-cuts.js
 * 会先把订单 5 的裁剪单重置为「裁剪中 + 两床 + 扎包已生成」，便于截到完整界面。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db } = require('../src/db');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/cuts');
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

  // ---- 重置订单 5 的裁剪单 ----
  const old = db.prepare('SELECT id FROM cut_orders WHERE order_id = 5').get();
  if (old) {
    db.prepare('DELETE FROM cut_bundles WHERE cut_order_id = ?').run(old.id);
    db.prepare('DELETE FROM cut_lots WHERE cut_order_id = ?').run(old.id);
    db.prepare('DELETE FROM cut_orders WHERE id = ?').run(old.id);
  }
  const fresh = (await call('GET', '/api/cuts/order/5')).data;
  await call('POST', `/api/cuts/${fresh.id}/start`, {});
  await call('POST', `/api/cuts/${fresh.id}/lots`, {
    dye_lot: 'A2310', fabric_roll: 'RL-20261026-01', width: '160cm', layers: 32,
    marker_no: 'MK-600-A', marker_len: 8.6, plan_qty: 300, actual_qty: 300, leftover_m: 1.2, note: '首床先裁 S 码'
  });
  await call('POST', `/api/cuts/${fresh.id}/lots`, {
    dye_lot: 'A2310', fabric_roll: 'RL-20261026-02', width: '160cm', layers: 32,
    marker_no: 'MK-600-B', marker_len: 8.6, plan_qty: 300, actual_qty: 298, leftover_m: 0.8, note: '幅宽略窄，少排 2 件'
  });
  const gen = await call('POST', `/api/cuts/${fresh.id}/bundles/generate`, { per_bundle: 20, replace: true });
  // 前 6 扎先复核
  const bundles = gen.data.bundles || [];
  for (const b of bundles.slice(0, 6)) await call('POST', `/api/cuts/${fresh.id}/bundles`, { id: b.id, status: 'checked' });
  console.log('已重置演示裁剪单：', gen.data.cut_no, gen.data.lot_count + ' 床', gen.data.bundle_count + ' 扎');

  // ---- 截图 ----
  const port = 9570;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1600,1250', 'about:blank'], { stdio: 'ignore' });
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1250, deviceScaleFactor: 1, mobile: false });
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

  await send('Page.navigate', { url: BASE + '/cuts' });
  await sleep(3600);
  console.log('列表行数:', await evalJs('document.querySelectorAll("tbody tr").length'));
  await shot('01-裁床看板');

  const opened = await evalJs(`(async () => {
    const tr = [...document.querySelectorAll('tbody tr')].find(x => x.textContent.includes('SO202610260005'));
    if (!tr) return 'no-row';
    const btn = [...tr.querySelectorAll('.link-btn')].find(b => b.textContent.includes('裁剪'));
    if (!btn) return 'no-btn';
    btn.click();
    await new Promise(r => setTimeout(r, 1800));
    return document.querySelector('.cut-modal') ? 'opened' : 'no-modal';
  })()`);
  console.log('详情弹窗:', opened);
  await shot('02-裁剪详情-床次与扎包');

  ws.close();
  proc.kill();
  console.log('完成');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
