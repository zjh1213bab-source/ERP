/**
 * 打印模板（生产工单）图片 · 截图与 PDF 取证
 * 用法：node scripts/shot-printimg.js
 *
 * 验证四件事：
 *   1. 款式图两张都真的加载出来了（naturalWidth > 0，不是坏图占位）
 *   2. 物料清单里的物料图/色卡列有图
 *   3. 屏显截图（看版式）
 *   4. 导出 A4 PDF（看真打出来几页、图有没有被切）
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/printimg');
const PORT = 9996;
const PASS = process.env.ADMIN_PASS || 'admin123456';
const ORDER_ID = process.env.ORDER_ID || 5;
/** 单据类型：production / techpack / packing / shipping —— 分支不同，列数也不同 */
const TYPE = process.env.TYPE || 'production';
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
    '--hide-scrollbars', '--window-size=1100,1400'], { stdio: 'ignore' });

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

  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1400, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + lg.data.token + '");'
      + 'localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  await send('Page.navigate', { url: BASE + '/print/' + TYPE + '/' + ORDER_ID });
  await sleep(6500);

  console.log('\n单据类型:', TYPE, '| 页标题:', await ev("document.querySelector('.pr-head h1')?.textContent?.trim()"));
  console.log('单号:', await ev("document.querySelector('.pr-meta span')?.textContent?.trim()"));

  // 款式图：两张都必须是真图（naturalWidth>0），不是坏图占位
  console.log('\n款式图区块数:', await ev("document.querySelectorAll('.pr-shot').length"));
  console.log('款式图:', await ev(`JSON.stringify([...document.querySelectorAll('.pr-shot')].map(f=>({
    cap: f.querySelector('figcaption')?.textContent?.trim(),
    hasImg: !!f.querySelector('img'),
    loaded: f.querySelector('img') ? (f.querySelector('img').complete && f.querySelector('img').naturalWidth > 0) : false,
    w: f.querySelector('img')?.naturalWidth || 0,
    h: f.querySelector('img')?.naturalHeight || 0
  })))`));
  console.log('占位块（未上传/坏图）:', await ev("document.querySelectorAll('.pr-shot-empty').length"));

  // 物料清单里的图
  console.log('\n物料行数:', await ev("document.querySelectorAll('.pr-table tbody tr').length"));
  console.log('物料图单元格:', await ev("document.querySelectorAll('.pr-cellimg').length"));
  console.log('物料图已加载:', await ev(`[...document.querySelectorAll('.pr-cellimg img')].map(i=>i.complete&&i.naturalWidth>0).join(',')`));
  console.log('表头:', await ev("JSON.stringify([...document.querySelectorAll('.pr-sec')].map(h=>h.textContent.trim()))"));

  console.log('明细表列数（表头/首行）:', await ev("(()=>{const t=document.querySelector('.pr-mat');if(!t)return '无表';return [...t.querySelectorAll('thead th')].length+' / '+[...(t.querySelector('tbody tr')?.children||[])].length})()"));
  console.log('列数是否一致:', await ev("(()=>{const t=document.querySelector('.pr-mat');if(!t)return '无表';const h=[...t.querySelectorAll('thead th')].length;const r=t.querySelector('tbody tr');if(!r)return '无行';return h===[...r.children].length})()"));

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1100, height: Math.max(1400, Number(await ev('document.body.scrollHeight')) || 1400), deviceScaleFactor: 1, mobile: false
  });
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(pathMod.join(OUT, '01-生产工单-图.png'), Buffer.from(shot.data, 'base64'));
  console.log('\nshot 01-生产工单-图');

  /**
   * 打印媒体形态再看一眼
   *
   * 屏显用的是 12.5px，纸上要更紧；而且 `@media print` 才会应用
   * 「图不许跨页切断」。这一步直接切到 print 媒体，验证那套规则生效。
   */
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(900);
  console.log('\n打印媒体下物料表字号:', await ev("getComputedStyle(document.querySelector('.pr-mat')).fontSize"));
  console.log('打印媒体下款式图最大高度:', await ev("getComputedStyle(document.querySelector('.pr-shot img')).maxHeight"));
  const shotPrint = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(pathMod.join(OUT, '02-打印媒体-A4.png'), Buffer.from(shotPrint.data, 'base64'));
  console.log('shot 02-打印媒体-A4');
  await send('Emulation.setEmulatedMedia', { media: '' });

  // A4 PDF：真打出来几页、图有没有被切
  // 打印导出偶尔不返回（大图 + 长页面时见过），加个兜底：超时就跳过，
  // 不能因为导出卡住把整轮取证拖死
  const pdf = await Promise.race([send('Page.printToPDF', {
    printBackground: true, paperWidth: 8.27, paperHeight: 11.69,
    marginTop: 0.47, marginBottom: 0.47, marginLeft: 0.47, marginRight: 0.47,
    preferCSSPageSize: true
  }), sleep(20000).then(() => ({ data: '' }))]);
  if (!pdf || !pdf.data) {
    console.log('PDF: 导出超时，跳过（屏显截图已存）');
    ws.close(); proc.kill(); process.exit(0);
  }
  const buf = Buffer.from(pdf.data, 'base64');
  fs.writeFileSync(pathMod.join(OUT, '生产工单.pdf'), buf);
  // 页数从 /Type /Pages 的 /Count 取：按 /Type /Page 数正则会被压缩对象流骗过去
  const m = buf.toString('latin1').match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/)
    || buf.toString('latin1').match(/\/Count\s+(\d+)/);
  const pages = m ? Number(m[1]) : 0;
  console.log('PDF:', (buf.length / 1024).toFixed(0) + 'KB', '页数≈', pages);

  console.log('\n前端异常:', errors.length ? errors.join(' | ') : '无');
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
