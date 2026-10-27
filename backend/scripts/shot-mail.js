/**
 * 截图：内部邮件
 *   node scripts/shot-mail.js
 * 只读截图，不改演示数据。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.resolve(__dirname, '../../shots/mail');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const token = login.data.token;

  const port = 9595;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1680,1150', 'about:blank'], { stdio: 'ignore' });
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
  const dialogs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message.slice(0, 80));
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: false } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1150, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('  JS异常', String(r.exceptionDetails.text).slice(0, 200));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT, name + '.png');
    if (s && s.data) fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    console.log('  截图 →', path.basename(file));
  };

  await send('Page.navigate', { url: BASE + '/mail' });
  await sleep(4000);
  console.log('列表行数:', await evalJs('document.querySelectorAll(".mrow").length'));
  console.log('顶栏红点:', await evalJs('(document.querySelector(".mb-badge")||{}).textContent || "无"'));
  await shot('01-邮箱收件箱');

  // 需确认那封（发件人视角）：看逐人回执明细
  const opened = await evalJs(`(async () => {
    const f = [...document.querySelectorAll('.folder')].find(x => x.textContent.includes('已发送'));
    f.click(); await new Promise(t => setTimeout(t, 1600));
    const r = [...document.querySelectorAll('.mrow')].find(x => x.textContent.includes('面料改用 A2312'));
    if (!r) return 'no-row';
    r.click(); await new Promise(t => setTimeout(t, 2200));
    return document.querySelector('.rc-tbl') ? 'opened' : 'no-detail';
  })()`);
  console.log('需确认详情:', opened);
  await shot('02-需确认-逐人回执');

  // 普通沟通：看会话上下文
  const opened2 = await evalJs(`(async () => {
    const f = [...document.querySelectorAll('.folder')].find(x => x.textContent.includes('收件箱'));
    f.click(); await new Promise(t => setTimeout(t, 1500));
    const r = [...document.querySelectorAll('.mrow')].find(x => x.textContent.includes('领口罗纹'));
    if (!r) return 'no-row';
    r.click(); await new Promise(t => setTimeout(t, 2000));
    return document.querySelector('.thread') ? 'thread-ok' : 'no-thread';
  })()`);
  console.log('会话上下文:', opened2);
  await shot('03-普通沟通与同一会话');

  // 需我办理
  const tasks = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.folder')].find(x => x.textContent.includes('需我办理'));
    if (!b) return 'no-folder';
    b.click(); await new Promise(t => setTimeout(t, 1800));
    return document.querySelectorAll('.task-card').length;
  })()`);
  console.log('协同任务条数:', tasks);
  await shot('04-需我办理协同任务');

  // 写信：需办理 + 关联业务
  const composed = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.write-btn')][0];
    b.click(); await new Promise(t => setTimeout(t, 1500));
    const sel = document.querySelector('.compose-modal select');
    if (sel) { sel.value = 'task'; sel.dispatchEvent(new Event('change')); }
    await new Promise(t => setTimeout(t, 900));
    // 选一个关联业务 + 收件人，让截图看得出完整配置
    const src = [...document.querySelectorAll('.compose-modal select')].find(x => x.options[0] && x.options[0].textContent.includes('不关联'));
    const fa = [...(src ? src.options : [])].find(o => o.textContent.includes('首件'));
    if (src && fa) { src.value = fa.value; src.dispatchEvent(new Event('change')); }
    const pick = document.querySelectorAll('.pick-row select')[0];
    if (pick) {
      const opt = [...pick.options].find(o => o.textContent.includes('生产部'));
      if (opt) { pick.value = opt.value; pick.dispatchEvent(new Event('change')); }
      await new Promise(t => setTimeout(t, 300));
      const add = document.querySelectorAll('.pick-row .btn')[0];
      if (add) add.click();
    }
    const subj = document.querySelector('.compose-modal input.input');
    if (subj) { subj.value = 'FA202610270001 首件复核结果请回传'; subj.dispatchEvent(new Event('input')); }
    await new Promise(t => setTimeout(t, 700));
    return document.querySelector('.compose-modal') ? 'opened' : 'no-modal';
  })()`);
  console.log('写信弹窗:', composed, dialogs);
  await shot('05-写信-需办理关联原单');

  // 统计
  await evalJs('document.querySelector(".compose-modal .x").click()');
  await sleep(500);
  const st = await evalJs(`(async () => {
    const b = [...document.querySelectorAll('.rail-foot .link-btn')].find(x => x.textContent.includes('统计'));
    if (!b) return 'no-btn';
    b.click(); await new Promise(t => setTimeout(t, 1500));
    return document.querySelector('.stat-grid') ? 'opened' : 'no-modal';
  })()`);
  console.log('统计弹窗:', st);
  await shot('06-投递与确认统计');

  ws.close();
  proc.kill();
  console.log('完成');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
