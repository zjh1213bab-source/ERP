/**
 * 培训手册配图生成器
 * ============================================================
 * 为什么用脚本截图，不手工截：
 *   1. 手册里的图必须和真实界面一致。界面一改，手截的图就过期了，
 *      而没人会去手工重截 40 张 —— 但会有人重跑一条命令。
 *   2. 用「各岗位自己的账号」登录截图，图里就是该岗位真实看到的菜单，
 *      不是管理员视角的全功能界面（这点对培训最要紧：新人看到什么就是什么）。
 *
 * 用法：
 *   node scripts/gen-manual-shots.js            # 全部岗位
 *   node scripts/gen-manual-shots.js --role=sales
 *   node scripts/gen-manual-shots.js --width=1440 --height=900
 *
 * 输出：docs/manual/img/<role>/<序号>-<页面>.png
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find((p) => fs.existsSync(p));

const OUT_ROOT = path.resolve(__dirname, '../../docs/manual/img');
const PWD = process.env.MANUAL_PASS || 'admin123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : def;
}
const W = Number(arg('width', 1440));
const H = Number(arg('height', 900));
const ONLY = arg('role', '');

/**
 * 每个岗位的手册章节：图名 + 路径 + 一句话说明（说明会写进 md，方便对图）
 * 顺序 = 手册里的顺序 = 这个人一天的工作顺序
 */
const PLAN = {
  sales: {
    user: 'sales01',
    title: '销售跟单',
    pages: [
      ['01-工作台', '/dashboard', '每天先看这里：待办、逾期交期、待确认事项'],
      ['02-销售订单', '/orders', '接单与跟单的主战场，状态流转都在这一页'],
      ['03-报价单', '/quotations', '先报价再转订单，报价单里有成本与外发标记'],
      ['04-开发管理', '/development', '定制单要发的开发单，卡片或打版看板两种视图'],
      ['05-现货经营', '/spot-ops', '现货款的补货与停补提案，批准不等于自动下单'],
      ['06-客户管理', '/customers', '客户档案与信用额度，改这里会影响下单校验']
    ]
  },
  tech: {
    user: 'tech01',
    title: '技术打版',
    pages: [
      ['01-研发立项', '/dev-master', '款从哪来、到哪一步、里程碑各算各的'],
      ['02-开发管理', '/development', '技术包：面辅料、工艺、客户要求、尺码规格'],
      ['03-供方协同与复审', '/sup-review', 'A1 分工 → A2 供方确认 → A3 技术复审，顺序不能反'],
      ['04-面辅料档案', '/materials', '材料主数据与库存，技术包从这里勾选'],
      ['05-打版流程看板', '/pattern-board', '各阶段的推进与停留时长']
    ]
  },
  production: {
    user: 'prod01',
    title: '生产车间',
    pages: [
      ['01-有限产能排程', '/schedule', '把订单排到工作中心×日期，硬冲突处理完才能发布'],
      ['02-生产管理', '/production', '工序进度与报工，报工数会进成本与产能'],
      ['03-首件确认', '/first-article', '首件没放行，批量报工过不去'],
      ['04-裁片外发', '/cut-dispatch', '按扎发、按扎回，短数要落到具体扎'],
      ['05-返工报废与结单', '/production-close', '返工必复验、报废必填损失、结单要过五项检查'],
      ['06-设备与产能', '/equipment', '停机先扣产能再排产，扣到 0 不出负值']
    ]
  },
  warehouse: {
    user: 'wh01',
    title: '仓库采购',
    pages: [
      ['01-采购管理', '/purchases', '草稿 → 下单 → 收货，收货不自动变可用'],
      ['02-原料收货检验', '/receipts', '检验合格才进可用库存，这是最容易被跳的一步'],
      ['03-备料领退与盘点', '/material-flow', '备料即占用、发料才扣减；盘点未盘≠0'],
      ['04-库存管理', '/inventory', '生产仓与美仓分开看，调整必须写原因'],
      ['05-美仓发货', '/us-ship', '按美仓库存核对齐套，缺货会拦'],
      ['06-供应商评价', '/supplier-eval', '样本不足不排名，资格门禁进采购']
    ]
  },
  finance: {
    user: 'fin01',
    title: '财务会计',
    pages: [
      ['01-成本与毛利', '/costing', '成本单七层，费用池分摊后要看成本漂移'],
      ['02-往来账', '/finance', '应收应付、开票核销，外币按开票时汇率'],
      ['03-财务报表与关账', '/finance-books', '业务单据反推凭证 → 试算 → 报表 → 八项关账检查'],
      ['04-价格快照与费用池', '/pricing', '池额=明细合计，分摊合计必须等于池额'],
      ['05-税票银行与结算', '/bank', '流水导入、匹配、对账、票据登记'],
      ['06-预算管理', '/budget', '三档超支：容忍内 / 写说明特批 / 硬拦'],
      ['07-多主体与集团合并', '/group-books', '长投抵消只对子公司，借贷不等不出合并表']
    ]
  },
  hr: {
    user: 'hr01',
    title: '人事行政',
    pages: [
      ['01-员工档案', '/employees', '身份证与基本工资只有人事和财务看得到'],
      ['02-考勤打卡', '/attendance', '打卡是本人动作，>09:00 记迟到'],
      ['03-请假管理', '/leaves', '本人提交、人事或部门负责人审批'],
      ['04-薪酬核算', '/payrolls', '生成 → 确认 → 发放，读也限岗'],
      ['05-岗位绩效', '/kpi', '模板版本化，建议分与确认分分开'],
      ['06-行政合同与证照', '/admin-contracts', '合同版本重核、印章按公司独立授权'],
      ['07-组织编制与岗位', '/organization', '岗位、编制、任职占编']
    ]
  },
  admin: {
    user: 'admin',
    title: '系统管理员',
    pages: [
      ['01-用户与角色', '/users', '建号、主岗、附加岗（一人多岗）'],
      ['02-权限复核', '/access-review', '按真实岗位核一遍，收回要写理由'],
      ['03-备份与恢复', '/backup', '备份要有留档，恢复要能反悔'],
      ['04-真实数据导入', '/import-data', '先预览再提交，期初库存只能导一次'],
      ['05-操作日志', '/audit', '所有写操作留痕，谁改的都能查到'],
      ['06-系统设置', '/settings', '汇率、面料库、辅料库、尺码模板']
    ]
  }
};

async function login(user) {
  const r = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: PWD })
  })).json();
  if (!r.ok) throw new Error(`${user} 登录失败：${r.message || ''}`);
  return r.data;
}

/** 起一个 headless Chrome，返回操作句柄 */
async function openBrowser(port) {
  const proc = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + port, '--hide-scrollbars',
    `--window-size=${W},${H}`, 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    } catch (e) { /* 还没起来 */ }
  }
  if (!target) throw new Error('Chrome 启动失败');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (evt) => {
    const m = JSON.parse(evt.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      // 页面里的 alert/confirm 会卡住截图，统一确认掉
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || {}); pending.delete(m.id); }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  return {
    send,
    async shot(file) {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    },
    async evalJs(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      return r.result ? r.result.value : null;
    },
    kill() { try { proc.kill(); } catch (e) { /* ignore */ } }
  };
}

(async () => {
  if (!CHROME) {
    console.error('找不到 Chrome，无法生成截图');
    process.exit(1);
  }
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const roles = Object.keys(PLAN).filter((r) => !ONLY || r === ONLY || PLAN[r].user === ONLY);
  if (!roles.length) {
    console.error('没有匹配的岗位：' + ONLY);
    process.exit(1);
  }

  let port = 9780;
  let total = 0;

  for (const role of roles) {
    const cfg = PLAN[role];
    const dir = path.join(OUT_ROOT, role);
    fs.mkdirSync(dir, { recursive: true });
    process.stdout.write(`\n[${role}] ${cfg.title}（${cfg.user}）\n`);

    let auth;
    try {
      auth = await login(cfg.user);
    } catch (e) {
      console.log(`  ✗ ${e.message}（跳过该岗位）`);
      continue;
    }

    const br = await openBrowser(port++);
    try {
      await br.send('Page.addScriptToEvaluateOnNewDocument', {
        source:
          'localStorage.setItem("erp_token",' + JSON.stringify(auth.token) + ');' +
          'localStorage.setItem("erp_user",' + JSON.stringify(JSON.stringify(auth.user)) + ');' +
          // headless 下字体回退会缺字（"羽绒服" 渲染成 "羽战服"），强制用微软雅黑
          'document.addEventListener("DOMContentLoaded",function(){' +
          'var s=document.createElement("style");' +
          's.textContent=\'*{font-family:"Microsoft YaHei","Microsoft YaHei UI","Segoe UI",sans-serif !important}\';' +
          'document.head.appendChild(s);});'
      });

      for (const [name, route, note] of cfg.pages) {
        const file = path.join(dir, name + '.png');
        await br.send('Page.navigate', { url: BASE + route });
        await sleep(3600);

        // 顺手校验：页面里不该出现明显报错文案
        // 只看真正的失败文案（不要匹配数字，页面里的 500 可能是金额）
        const bad = await br.evalJs(
          '(()=>{const t=document.body.innerText||"";return ["请求失败","加载失败","Cannot read properties of undefined","无权限执行","该操作已被收回"].some(x=>t.includes(x))})()'
        );
        await br.shot(file);
        total++;
        console.log(`  ✓ ${name}.png  ${note}${bad ? '  ⚠ 页面可能有报错' : ''}`);
      }
    } finally {
      br.kill();
    }
  }

  console.log(`\n共生成 ${total} 张 → ${path.relative(process.cwd(), OUT_ROOT)}`);
  process.exit(0);
})();
