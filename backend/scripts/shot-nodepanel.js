/**
 * 工序节点弹窗（按节点类型分化）· 截图与文本取证
 * 用法：node scripts/shot-nodepanel.js
 *
 * 截四张：
 *   01 面料采购节点 → 采购明细表（物料/需求/单价/金额/库存/缺口/供应商）
 *   02 排版算料节点 → 备注 + 上传凭证 + 操作记录（没有明细表）
 *   03 工序流程配置 → 「点开的弹窗」列
 *   04 采购节点的齐套汇总条（缺料/合计金额）
 *
 * 判定读 textContent，不看截图猜。
 */
const fs = require('fs');
const pathMod = require('path');
const os = require('os');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = pathMod.resolve(__dirname, '../../shots/nodepanel');
const PORT = 9976;
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

  /**
   * 挑一张**真的有物料需求**的单来截。
   *
   * 大部分演示订单没建过技术资料，算料算不出行 —— 那种单点开采购节点是空表，
   * 截出来证明不了「采购明细能看」。所以直接查库挑一张有需求行的。
   */
  const { db } = require('../src/db');
  const pick = db.prepare(`
    SELECT r.order_id, o.order_no, COUNT(*) AS lines
      FROM material_requirements r JOIN orders o ON o.id = r.order_id
     WHERE o.status IN ('assigned','production','instock')
     GROUP BY r.order_id ORDER BY lines DESC LIMIT 1`).get();
  if (!pick) { console.log('库里没有物料需求行，先在「齐套与缺料」算一次料'); proc.kill(); process.exit(1); }
  console.log('选单：', pick.order_no, `（${pick.lines} 行需求）`);

  const layoutNode = db.prepare("SELECT id FROM order_nodes WHERE order_id = ? AND code = 'layout'").get(pick.order_id);
  /* 造两条操作记录，否则「操作记录」是空的，截出来证明不了什么 */
  if (layoutNode) {
    for (const body of [
      { plan_date: new Date().toISOString().slice(0, 10) },
      { operator: '张师傅' }
    ]) {
      await fetch(BASE + '/api/order-nodes/' + layoutNode.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body)
      });
    }
    console.log('已给「排版算料」写 2 条操作记录');
  }

  const profile = pathMod.join(os.tmpdir(), 'erp-shot-' + PORT);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
    '--hide-scrollbars', '--window-size=1920,1080'], { stdio: 'ignore' });

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
  const shot = async (name, h = 1080) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(650);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const go = async (url, wait = 5200) => { await send('Page.navigate', { url: BASE + url }); await sleep(wait); };
  /**
   * 点某一张单的某个节点。
   *
   * 必须带订单号：只看节点名会在第一张没有需求的单上点开空表，
   * 于是「采购明细」看上去像是坏的。
   */
  const clickNode = (name, orderNo) => ev(`(()=>{
    const items=[...document.querySelectorAll('.po-item')];
    const scope = ${JSON.stringify(orderNo)} ? items.find(it=>it.innerText.includes(${JSON.stringify(orderNo)})) : items[0];
    if(!scope) return 'no-order';
    const n=[...scope.querySelectorAll('.po-fnode')].find(x=>x.querySelector('.po-fnode-title')?.textContent.trim()===${JSON.stringify(name)});
    if(!n) return 'no-node';
    const b=n.querySelector('.po-fnode-in')||n; b.click(); return true;
  })()`);

  /**
   * 把看板筛到只剩这一张单。
   *
   * 看板一页 12 行，有物料需求的单往往排在后面 —— 不筛就得翻页，
   * 而截图的目的是「点开这个节点看到什么」，不是测分页。
   */
  const filterTo = async (orderNo) => {
    // 看板的搜索框有三处都绑 `q`，认 placeholder 最稳：这里是「搜索PO号」；
    // 触发方式是这个页面的「批量搜索」按钮（没有单独的「查询」）
    const set = await ev('(()=>{'
      + "const i=[...document.querySelectorAll('.po-finput')].find(x=>(x.placeholder||'').includes('PO号'));"
      + "if(!i) return 'no-input';"
      + `i.value=${JSON.stringify(orderNo)};`
      + "i.dispatchEvent(new Event('input'));"
      + "return i.value;"
      + '})()');
    await sleep(300);
    const hit = await ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='批量搜索');if(!b)return 'no-btn';b.click();return true})()");
    await sleep(2800);
    return { set, hit };
  };

  await send('Page.addScriptToEvaluateOnNewDocument', {
    // 必须同时写 erp_user：`can()` 第一行就是 `if (!auth.user) return false`，
    // 只塞 token 的话页面能看，但所有「写」按钮都是灰的 —— 截出来会误以为功能没做
    source: 'localStorage.setItem("erp_token","' + token + '");'
      + 'localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(lg.data.user)) + ');'
  });

  await go('/order-tracking');
  console.log('\n首行节点:', await ev("JSON.stringify([...document.querySelectorAll('.po-item:first-child .po-fnode-title')].map(x=>x.textContent.trim()))"));
  console.log('节点可点（有 clickable 类）:', await ev("document.querySelectorAll('.po-fnode-in.clickable').length"));

  // ---------- 1. 面料采购 ----------
  console.log('筛单:', JSON.stringify(await filterTo(pick.order_no)), '| 行数:', await ev("document.querySelectorAll('.po-item').length"));
  console.log('\n点面料采购:', await clickNode('面料采购', pick.order_no));
  await sleep(2200);
  console.log('弹窗标题:', await ev("document.querySelector('.np-title')?.innerText?.replace(/\\n/g,' ')"));
  console.log('面板类型:', await ev("document.querySelector('.np-kind')?.textContent"));
  console.log('汇总条:', await ev("document.querySelector('.np-sum')?.innerText?.replace(/\\n/g,' ')"));
  console.log('表头:', await ev("JSON.stringify([...document.querySelectorAll('.np-tbl thead th')].map(x=>x.textContent.trim()))"));
  console.log('明细行数:', await ev("document.querySelectorAll('.np-tbl tbody tr').length"));
  console.log('首行:', await ev("document.querySelector('.np-tbl tbody tr')?.innerText?.replace(/\\n/g,' | ')"));
  console.log('有操作记录区块:', await ev("!!document.querySelector('.np-time')"));
  await shot('01-面料采购明细');

  // ---------- 2. 排版算料（通用） ----------
  await ev("document.querySelector('.np-modal .x')?.click()");
  await sleep(600);
  console.log('\n点排版算料:', await clickNode('排版算料', pick.order_no));
  await sleep(2000);
  console.log('面板类型:', await ev("document.querySelector('.np-kind')?.textContent"));
  console.log('有明细表:', await ev("!!document.querySelector('.np-tbl')"));
  console.log('区块标题:', await ev("JSON.stringify([...document.querySelectorAll('.np-sec-h b')].map(x=>x.textContent.trim()))"));
  console.log('操作记录条数:', await ev("document.querySelectorAll('.np-ev').length"));
  console.log('首条记录:', await ev("document.querySelector('.np-ev')?.innerText?.replace(/\\n/g,' | ')"));
  console.log('上传按钮:', await ev("document.querySelector('.np-up')?.innerText?.trim()"));
  console.log('可编辑（状态胶囊）:', await ev("document.querySelectorAll('.np-chip').length"));
  await shot('02-排版算料通用面板');

  // ---------- 3. 配置页「点开的弹窗」列 ----------
  await ev("document.querySelector('.np-modal .x')?.click()");
  await sleep(500);
  await go('/node-flow');
  console.log('\n配置页表头:', await ev("JSON.stringify([...document.querySelectorAll('.nf-main table.data thead th')].map(x=>x.textContent.trim()))"));
  console.log('弹窗类型选择:', await ev(`JSON.stringify([...document.querySelectorAll('.nf-main table.data tbody tr')].map(r=>{const s=r.querySelector('.nf-panel');return s?r.querySelectorAll('td')[1]?.innerText.trim()+'='+s.value:null}).filter(Boolean))`));
  await shot('03-配置页弹窗类型');

  // ---------- 4. 辅料采购（另一套明细） ----------
  await go('/order-tracking');
  await filterTo(pick.order_no);
  console.log('\n点辅料采购:', await clickNode('辅料采购', pick.order_no));
  await sleep(2100);
  console.log('面板类型:', await ev("document.querySelector('.np-kind')?.textContent"));
  console.log('类型列:', await ev("JSON.stringify([...document.querySelectorAll('.np-tbl tbody .np-ty')].map(x=>x.textContent.trim()))"));
  console.log('明细行数:', await ev("document.querySelectorAll('.np-tbl tbody tr').length"));
  await shot('04-辅料采购明细');

  /* ---------- 5. 回归：「沟通」仍然是原来的留言弹窗，没被新面板抢走 ---------- */
  await ev("document.querySelector('.np-modal .x')?.click()");
  await sleep(500);
  await go('/order-tracking');
  await filterTo(pick.order_no);
  const chat = await ev(`(()=>{
    const it=[...document.querySelectorAll('.po-item')][0];
    const n=[...it.querySelectorAll('.po-fnode')].find(x=>x.querySelector('.po-fnode-title')?.textContent.trim()==='面料采购');
    if(!n) return 'no-node';
    const c=n.querySelector('.po-chat'); if(!c) return 'no-chat';
    c.click(); return true;
  })()`);
  await sleep(1200);
  console.log('\n点沟通:', chat);
  console.log('打开的是留言弹窗（有状态胶囊+留言框）:', await ev("!!document.querySelector('.po-dlg-row')"));
  console.log('新面板没被同时打开:', await ev("!document.querySelector('.np-modal')"));

  console.log('\n前端异常:', errors.length ? errors.join(' | ') : '无');
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
