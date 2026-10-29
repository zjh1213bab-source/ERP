/**
 * 参考站取证（只读）
 * 用法：node scripts/peek-ref.js [urlPath] [输出名]
 *
 * 连本地 9222 调试端口的 Chrome（用户已登录 kr.yc198.com），把目标页面截图并 dump 结构。
 * **只读**：不点击任何提交类按钮、不改参考站的任何数据。
 */
const fs = require('fs');
const pathMod = require('path');
const BASE = 'https://kr.yc198.com';
const PORT = 9222;
const OUT = pathMod.resolve(__dirname, '../../shots/ref');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 用环境变量传路径：Git Bash 下把 `/#/...` 作命令行参数会被吃掉字符
  // （实测会变成 `d/#/...`，于是请求到 kr.yc198.comd）。
  /**
   * 目标路径写死在这里，**不从命令行或环境变量接**。
   *
   * 踩过的坑：Git Bash（MSYS）会把参数里的 `#/company/order/index` 当 POSIX 路径，
   * 自动替换成 Git 安装目录 —— 传进来变成 `#/D:/wk/.../PortableGit/company/order/index`，
   * 于是请求到 `kr.yc198.comd` 或路由不匹配跳回首页。写死最省事。
   */
  const target = process.env.REF_PATH_RAW || '/#/company/order/index';
  const name = process.env.REF_NAME_RAW || 'order-index';
  console.log('将访问:', BASE + target);
  fs.mkdirSync(OUT, { recursive: true });

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) { console.log('没有可用的页面'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
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

  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

  // 参考站是 SPA，直接 navigate 到带 # 的地址容易出岔子（devtools 协议里 hash 会被吃掉一段）。
  // 先确保同源，再改 hash —— 这样也不重新加载，登录态稳。
  const cur = await ev('location.href');
  if (!String(cur).startsWith(BASE)) {
    await send('Page.navigate', { url: BASE });
    await sleep(4000);
  }
  if (target.startsWith('/#')) {
    await ev(`location.hash = ${JSON.stringify(target.slice(1))}`);
  } else {
    await send('Page.navigate', { url: BASE + target });
  }
  await sleep(5500);

  console.log('标题:', await ev('document.title'));
  console.log('URL:', await ev('location.href'));
  console.log('可见文字:', await ev('document.body.innerText.replace(/\\n{2,}/g,"\\n").slice(0,1200)'));

  // 结构线索：表格列头、按钮、筛选控件
  console.log('\n--- 表头 ---');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('th')].map(x=>x.innerText.trim()).filter(Boolean))`));
  console.log('--- 主要按钮 ---');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('button')].map(x=>x.innerText.trim()||x.getAttribute('aria-label')||x.className.slice(0,20)).filter(Boolean).slice(0,40))`));
  console.log('--- 输入/下拉占位 ---');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('input,textarea')].map(x=>x.placeholder||x.getAttribute('aria-label')||'').filter(Boolean).slice(0,40))`));
  console.log('--- 表格数量 ---');
  console.log(await ev(`document.querySelectorAll('table').length + ' 张表 / 行数 ' + document.querySelectorAll('tbody tr').length`));

  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(pathMod.join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
  console.log('\nshot', name);

  ws.close();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
