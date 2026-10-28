/**
 * 全站页面巡检（UI 冒烟）
 * ============================================================
 * 冒烟测试只覆盖接口，构建通过也不代表页面能渲染 —— 这轮之前就踩过
 * 「顶层路由少写一个 / 导致整页白屏，而构建完全成功」。
 *
 * 这个脚本逐页打开、等渲染完，只报三种问题：
 *   1. 控制台异常 / console.error
 *   2. 页面空白（正文长度 < 40）
 *   3. 正文里出现「请求失败 / 加载失败 / Cannot read properties of undefined」这类文案
 *
 * 用法：node scripts/sweep-pages.js            # 全量
 *      node scripts/sweep-pages.js /orders,/cuts  # 只查几页
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = [
  '/dashboard', '/exceptions', '/orders', '/quality', '/process', '/mail', '/audit', '/ai-center', '/backup',
  '/photos', '/inventory', '/purchases', '/receipts', '/hr', '/finance-books', '/integration',
  '/marketing', '/admin-contracts', '/facility', '/equipment', '/schedule', '/segments', '/spot-ops',
  '/mall-admin', '/suppliers', '/customers', '/reports', '/assess', '/users', '/notify', '/budget',
  '/bank', '/group-books', '/cockpit', '/credit', '/payable', '/cashflow', '/payment-requests', '/collections', '/approval-flows', '/access-review', '/import-data',
  '/development', '/sample-archive', '/pattern-board', '/cuts', '/bundle-progress', '/piece-wage', '/first-article',
  '/production', '/approvals', '/costing', '/leads', '/spot-analysis', '/labels/5', '/print/production/5'
];

/** 需要真实 id 的页面（工资条要取最新一份已确认核算单） */
function withDynamicPages(base) {
  const out = [...base];
  try {
    const { db } = require('../src/db');
    const r = db.prepare("SELECT id FROM piece_wage_runs WHERE status = 'confirmed' ORDER BY id DESC LIMIT 1").get();
    if (r) {
      out.push('/payslip/' + r.id);
      out.push('/payslip/' + r.id + '?mode=public');
    }
    // 对账单要真实客户 id：取第一个有发票的
    const c = db.prepare("SELECT customer_id AS id FROM ar_invoices WHERE status != 'void' AND customer_id IS NOT NULL LIMIT 1").get();
    if (c) out.push('/statement/' + c.id);
  } catch (e) { /* 库还没建好就跳过 */ }
  return out;
}

(async () => {
  const list = process.argv[2]
    ? process.argv[2].split(',').map((s) => s.trim()).filter(Boolean)
    : withDynamicPages(PAGES);
  const lg = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  if (!lg.ok) {
    console.log('登录失败：', lg.message);
    process.exit(1);
  }

  const port = 9775;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 80 && !t; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* ignore */ }
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); let errs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push(String((d.exception && d.exception.description) || d.text).slice(0, 140));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errs.push('[console] ' + (m.params.args || []).map((x) => x.value || x.description).join(' ').slice(0, 140));
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
    return r.result ? r.result.value : null;
  };

  let good = 0; const bad = [];
  for (const p of list) {
    errs = [];
    await send('Page.navigate', { url: BASE + p });
    await sleep(3600);
    const len = await ev('document.body.innerText.trim().length');
    const hits = await ev(
      `(()=>{const t=document.body.innerText;return ['请求失败','加载失败','Cannot read properties of undefined','无权限执行'].filter(x=>t.includes(x))})()`
    );
    const problems = [...errs, ...(hits || [])];
    // 底部被裁：.page 若还是「100vh + overflow:hidden」，超出部分既看不见也滚不到
    //（外层 .erp-content 的滚动高度只按 .page 的盒子算）。权限复核的职责分离页曾因此丢掉后半截。
    const clip = await ev([
      '(()=>{',
      "const pg=document.querySelector('.page');",
      'if(!pg) return null;',
      'const cs=getComputedStyle(pg);',
      "const oh=cs.overflowY==='hidden'||cs.overflow==='hidden';",
      'if(!oh) return null;',
      'const cut=pg.scrollHeight-pg.clientHeight;',
      'return cut>4?{h:pg.clientHeight,need:pg.scrollHeight,cut}:null;',
      '})()'
    ].join(''));
    if (clip) problems.push(`底部被裁(露出${clip.h}px/需要${clip.need}px,缺${clip.cut}px)`);
    if (!len || len < 40) problems.push('页面空白(len=' + len + ')');
    if (problems.length) bad.push(p + ' -> ' + problems.slice(0, 2).join(' / '));
    else good++;
  }
  console.log(`巡检 ${list.length} 页：正常 ${good}，有问题 ${bad.length}`);
  bad.forEach((b) => console.log('  ✗', b));
  proc.kill();
  process.exit(bad.length ? 1 : 0);
})();
