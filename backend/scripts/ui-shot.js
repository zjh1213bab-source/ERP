/**
 * 界面截图工具（无头 Chrome + CDP，dev 用）
 *
 * 用途：改完样式后快速核对桌面端/移动端渲染，不依赖 Playwright。
 * 原理：先写一个种子页把登录态注入 localStorage，再跳到目标路由截图；
 *       可选通过 --action 执行一段 JS（点按钮、填表单）后再截。
 *
 * 用法：
 *   node scripts/ui-shot.js --route orders --out shot.png
 *   node scripts/ui-shot.js --route production --device mobile --out m.png
 *   node scripts/ui-shot.js --route assistant --action "document.querySelector('.chip').click()" --out a.png
 *   （--route 不要带前导斜杠：Git Bash 会把 /orders 改写成 C:/Program Files/Git/orders）
 *
 * 参数：
 *   --route   业务路由（如 /orders）
 *   --out     输出图片路径（默认 ./shot.png）
 *   --device  desktop | mobile（默认 desktop）
 *   --width / --height  自定义视口
 *   --action  截图前执行的 JS 表达式
 *   --base    后端地址（默认 http://127.0.0.1:3000）
 *   --wait    首屏等待毫秒（默认 3200）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const BASE = arg('base', 'http://127.0.0.1:3000');
/**
 * 注意：Git Bash(MSYS) 会把以 / 开头的参数当成路径改写（/orders → C:/Program Files/Git/orders），
 * 所以这里统一容错：允许 --route orders / --route /orders / 被改写后的绝对路径。
 */
const rawRoute = arg('route', 'dashboard');
const ROUTE = '/' + String(rawRoute)
  .replace(/^.*?[\\/]Git[\\/]/, '')   // 去掉 MSYS 改写前缀
  .replace(/^[A-Za-z]:[\\/].*[\\/]Git[\\/]/, '')
  .replace(/^[\\/]+/, '');
const OUT = arg('out', 'shot.png');
const DEVICE = arg('device', 'desktop');
const ACTION = arg('action', '');
const WAIT = Number(arg('wait', 3200));
const W = Number(arg('width', DEVICE === 'mobile' ? 390 : 1600));
const H = Number(arg('height', DEVICE === 'mobile' ? 844 : 900));

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('未找到 Chrome，请先安装或修改 CHROME_CANDIDATES');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin123456';
const MALL = argv.includes('--mall'); // 客户商城：用客户账号登录
const MALL_USER = process.env.MALL_USER || 'abc001';
const MALL_PASS = process.env.MALL_PASS || 'abc123456';

(async () => {
  const loginPath = MALL ? '/api/mall/auth/login' : '/api/auth/login';
  const login = await (await fetch(BASE + loginPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: MALL ? MALL_USER : USER, password: MALL ? MALL_PASS : PASS })
  })).json();
  if (!login.ok) {
    console.error('登录失败：', login.message || JSON.stringify(login));
    process.exit(1);
  }

  const port = 9300 + Math.floor(Math.random() * 400);
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    `--window-size=${W},${H}`,
    '--force-device-scale-factor=1'
  ];
  if (DEVICE === 'mobile') {
    args.push('--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  }
  args.push('about:blank');

  const proc = spawn(CHROME, args, { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) { /* 等 Chrome 起来 */ }
  }
  if (!target) { proc.kill(); console.error('无法连接 Chrome 调试端口'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      if (m.error) console.error('CDP 错误:', m.method || '', JSON.stringify(m.error));
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');

  // 关键：在每次新文档创建前注入登录态，避免「先跳登录页再跳回来」
  const inject = MALL
    ? 'localStorage.setItem("mall_token","' + login.data.token + '");' +
      'localStorage.setItem("mall_user",' + JSON.stringify(JSON.stringify(login.data.account || {})) + ');'
    : 'localStorage.setItem("erp_token","' + login.data.token + '");' +
      'localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(login.data.user || {})) + ');';
  await send('Page.addScriptToEvaluateOnNewDocument', { source: inject });

  if (DEVICE === 'mobile') {
    await send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 2, mobile: true
    });
    await sleep(200);
  } else {
    // 桌面端也强制视口：headless 的 --window-size 在部分 Windows 缩放下不生效，
    // 不设会导致按 1080 宽渲染、宽表被挤窄
    await send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: 1, mobile: false
    });
    await sleep(200);
  }
  await send('Page.navigate', { url: BASE + ROUTE });
  await sleep(WAIT);

  if (ACTION) {
    const r = await send('Runtime.evaluate', { expression: ACTION, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) console.error('JS 异常:', r.exceptionDetails.text);
    else if (r && r.result) console.log('动作结果:', JSON.stringify(r.result.value));
    await sleep(1600);
  }

  // 记录横向溢出（移动端最常见的布局问题）
  const where = await send('Runtime.evaluate', { expression: 'location.pathname', returnByValue: true });
  if (where && where.result) console.log('当前路由:', where.result.value);

  const overflow = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, bodyW: document.body.scrollWidth})',
    returnByValue: true
  });
  if (overflow && overflow.result) console.log('视口检查:', overflow.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('已保存', OUT);
  ws.close();
  proc.kill();
  process.exit(0);
})();
