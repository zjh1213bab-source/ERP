/**
 * 现货经营与备货截图（M19）
 * 用法：先 node scripts/seed-spotops-demo.js --reset，启动后端（含前端 dist），再运行
 *   node scripts/shot-spotops.js
 */
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://127.0.0.1:3000';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const OUT = 'D:/wk/2026-10-26-09-45-32/erp-mindmap/shots/importops';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  // 清掉上一轮的截图测试客户，让「新增」每次都能演示出来
  try {
    const { db } = require('../src/db');
    db.prepare("DELETE FROM customers WHERE code LIKE 'SHOT-%'").run();
    // 清掉历史导入批次，截图只显示本次
    db.prepare('DELETE FROM import_batches').run();
  } catch (e) { console.log('清理测试客户失败', e.message); }

  // 截图过程会改单据状态（开始盘点 / 取消盘点），先重置演示数据保证可重复跑

  const login = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123456' })
  })).json();
  const port = 9797;
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars', '--window-size=1760,1700', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* ignore */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (evt) => {
    const m = JSON.parse(evt.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: '演示用说明文字' } }));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || {}); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1760, height: 1700, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("erp_token","' + login.data.token + '");localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user)) + ');'
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('JS异常', String(r.exceptionDetails.text).slice(0, 160));
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('shot', name);
  };
  const clickText = async (sel, text, wait = 1000) => {
    const done = await ev(`(()=>{const b=[...document.querySelectorAll('${sel}')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
    await sleep(wait);
    return done;
  };
  const scrollTo = async (y) => {
    await ev(`(()=>{const el=document.querySelector('.erp-content');if(el){el.scrollTop=${y};return el.scrollTop}return -1})()`);
    await sleep(450);
  };

  await send('Page.navigate', { url: BASE + '/import-data' });
  await sleep(5400);
  console.log('类型卡', await ev('document.querySelectorAll(".type-card").length'),
    '字段提示', await ev('document.querySelectorAll(".fh").length'));
  await shot('01-选择导入类型');

  // 选中「期初库存」：演示「只能导一次」的拦截
  const ok1 = await ev(`(()=>{const c=[...document.querySelectorAll('.type-card')].find(x=>x.textContent.includes('期初库存'));if(!c)return false;c.click();return true})()`);
  await sleep(900);
  console.log('选中期初库存', ok1);
  await shot('02-期初库存字段与模板');

  const csv1 = '仓库,款号,款名,颜色,尺码,数量\n生产仓,LEJE-1001,女式针织开衫,藏青,3T,120\n美仓,LEJE-1001,女式针织开衫,藏青,3T,80\n生产仓,LEJE-TZ-002,男士休闲长裤,黑色,M,50\n生产仓,LEJE-1002,新品外套,黑色,L,300\n';
  const filled = await ev(`(()=>{const t=document.querySelector('.ta');if(!t)return false;t.value=${JSON.stringify(csv1)};t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(600);
  console.log('填入 CSV', filled);
  await clickText('.btn-primary', '预览', 2200);
  await shot('03-期初预览-拦截已有库存');

  // 切到客户：演示 新增/覆盖/错误 三种动作
  await ev(`(()=>{const c=[...document.querySelectorAll('.type-card')].find(x=>x.textContent.includes('客户档案'));if(c){c.click();return true}return false})()`);
  await sleep(900);
  const sfx = String(Date.now()).slice(-6);
  const csv2 = [
    '客户编号,客户名称,联系人,电话,等级,信用额度,状态',
    `SHOT-${sfx}-1,新客户甲,张三,13800000001,A,"50,000",启用`,
    'C001,示范客户·美国 ABC（更名）,李四,13800000002,A,"80,000",启用',
    `SHOT-${sfx}-BAD,,缺名称,13800000003,B,,启用`,
    `SHOT-${sfx}-2,新客户丙,王五,13800000004,C,20000,停用`
  ].join('\n') + '\n';
  await ev(`(()=>{const t=document.querySelector('.ta');if(!t)return false;t.value=${JSON.stringify(csv2)};t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(600);
  await clickText('.btn-primary', '预览', 2200);
  await shot('04-客户预览-新增覆盖错误');

  // 提交（跳过错误行）→ 结果
  await ev(`(()=>{const c=document.querySelector('.chk input');if(c&&!c.checked){c.click();return true}return false})()`);
  await sleep(500);
  await clickText('.commit-box .btn-primary', '确认导入', 2600);
  await shot('05-导入完成');

  // 记录
  await clickText('.tabs button', '导入记录', 1800);
  await shot('06-导入记录');

  // 移动端
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });
  await sleep(1200);
  await clickText('.tabs button', '导入', 1400);
  await shot('07-移动端');
  const overflow = await ev('(()=>{const d=document.documentElement;return {scrollW:d.scrollWidth, clientW:d.clientWidth}})()');
  console.log('移动端横向溢出检查', JSON.stringify(overflow));

  proc.kill();
  process.exit(0);
})();