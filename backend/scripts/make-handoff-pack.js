/**
 * 生成「交接包」——给另一个 AI 接手用的高密度上下文
 * ============================================================
 * 为什么需要它：
 *   这个仓库后端 8.5 万行、前端 7.4 万行，任何模型的上下文都装不下整个代码库。
 *   直接把代码丢过去，对方只能瞎翻 —— 于是编造接口名、改错文件、重复实现已有的校验。
 *   真正有用的是**地图**：哪个模块在哪个文件、有哪些接口、有哪些表。
 *
 * 产物（handoff/，文件名全 ASCII，避免跨平台乱码）：
 *   00-AGENTS.md          给 AI 的项目入口（复制根目录那份）
 *   01-code-map.md        模块 → 路由文件 → 端点数 → 前端页面
 *   02-endpoints.md       全量接口清单（按模块分组，供检索定位，防编造）
 *   03-status.md          现状快照（版本 / 表数 / 冒烟 / 已完成模块）
 *   04-recent-changes.md  最近三个版本
 *   05-schema-summary.md  369 张表 + 列名
 *   06-verify.md          怎么跑验证、怎么判断真生效
 *
 * 用法：
 *   node scripts/make-handoff-pack.js
 *   node scripts/make-handoff-pack.js --module orders,stock   # 额外导出该模块源码
 *   node scripts/make-handoff-pack.js --zip                   # 再打个 zip
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const ROOT = path.resolve(BACKEND, '..');
const OUT = path.join(ROOT, 'handoff');

const argv = process.argv.slice(2);
const argVal = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const MODULES = (argVal('module') || '').split(',').map((s) => s.trim()).filter(Boolean);
const WANT_ZIP = argv.includes('--zip');

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const lines = (n) => '\n'.repeat(n);

/* ---------------- 1. 解析后端：路由文件 ↔ 挂载路径 ---------------- */
function parseBackend() {
  const server = read(path.join(BACKEND, 'src/server.js'));
  // const orderRoutes = require('./routes/orders');
  const requireMap = {};
  for (const m of server.matchAll(/const\s+(\w+)\s*=\s*require\(\s*'\.\/routes\/([\w.-]+)'\s*\)/g)) {
    requireMap[m[1]] = m[2];
  }
  // app.use('/api/orders', orderRoutes);
  const mounts = [];
  for (const m of server.matchAll(/app\.use\(\s*'(\/api[^']*)'\s*,\s*(\w+)\s*\)/g)) {
    const file = requireMap[m[2]];
    if (file) mounts.push({ prefix: m[1], file, varName: m[2] });
  }
  // 注释掉的挂载（暂停的模块）单列，避免 AI 以为它还在跑
  const disabled = [];
  for (const m of server.matchAll(/\/\/\s*【暂停】.*app\.use\(\s*'(\/api[^']*)'/g)) {
    disabled.push(m[1]);
  }

  const endpoints = mounts.map((mt) => {
    const src = read(path.join(BACKEND, 'src/routes', mt.file + '.js'));
    const eps = [];
    for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*\n?\s*'([^']*)'/g)) {
      eps.push({ method: m[1].toUpperCase(), path: m[2] });
    }
    return { ...mt, eps, loc: src.split('\n').length };
  });
  return { mounts, endpoints, disabled, total: endpoints.reduce((s, e) => s + e.eps.length, 0) };
}

/* ---------------- 2. 解析前端：路由 ↔ 页面 ---------------- */
function parseFrontend() {
  const router = read(path.join(ROOT, 'frontend/src/router.js'));
  const rows = [];
  for (const m of router.matchAll(/path:\s*'([^']*)'\s*,\s*component:\s*(\w+)/g)) {
    rows.push({ path: m[1], component: m[2] });
  }
  // 页面标题（meta.title）跟在后面，取同行段
  const titles = {};
  for (const m of router.matchAll(/path:\s*'([^']*)'\s*,\s*component:\s*(\w+)[^\n]*?title:\s*'([^']*)'/g)) {
    titles[m[1]] = m[3];
  }
  const viewsDir = path.join(ROOT, 'frontend/src/views');
  const views = fs.existsSync(viewsDir)
    ? fs.readdirSync(viewsDir).filter((f) => f.endsWith('.vue'))
    : [];
  return { routes: rows, titles, views };
}

/* ---------------- 3. 解析表结构 ---------------- */
function parseSchema() {
  const src = read(path.join(BACKEND, 'src/schema.js'));
  const tables = [];
  // 表名可能带双引号（CREATE TABLE IF NOT EXISTS "gl_periods"）—— 历史上正因为正则漏了引号，
  // 把这 4 张总账表误报成「schema 快照缺失」。这里必须容错 "? 。
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS[\s\\"]+(\w+)[\s\\"]*\(([\s\S]*?)\);/g)) {
    const body = m[2];
    const cols = [];
    body.split('\n').forEach((ln) => {
      const t = ln.trim().replace(/,$/, '');
      if (!t) return;
      if (/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(t)) return;
      const col = t.split(/\s+/)[0];
      if (col && /^[a-z_][a-z0-9_]*$/i.test(col)) cols.push(col);
    });
    tables.push({ name: m[1], cols });
  }
  const idx = (src.match(/CREATE\s+(UNIQUE\s+)?INDEX/gi) || []).length;
  return { tables, idx };
}

/* ---------------- 4. 组装 ---------------- */
const be = parseBackend();
const fe = parseFrontend();
const sc = parseSchema();

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const pkg = JSON.parse(read(path.join(BACKEND, 'package.json')) || '{}');
const version = (read(path.join(ROOT, 'CHANGELOG.md')).match(/^## (v[\d.]+)/m) || [, '?'])[1];

// 00
const agents = read(path.join(ROOT, 'AGENTS.md'));
fs.writeFileSync(path.join(OUT, '00-AGENTS.md'),
  agents || '# 缺少根目录 AGENTS.md —— 请先补上再交接\n');

// 01 代码地图
const map = [];
map.push('# 代码地图（自动生成，勿手改）');
map.push('');
map.push(`生成时间：${new Date().toISOString()}　版本 ${version}`);
map.push('');
map.push('## 一、后端：API 前缀 → 路由文件');
map.push('');
map.push('| API 前缀 | 路由文件 | 端点数 | 文件行数 |');
map.push('|---|---|---|---|');
be.endpoints
  .slice()
  .sort((a, b) => b.eps.length - a.eps.length)
  .forEach((e) => {
    const file = `backend/src/routes/${e.file}.js`;
    map.push(`| \`${e.prefix}\` | \`${file}\` | ${e.eps.length} | ${e.loc} |`);
  });
map.push('');
map.push(`合计 **${be.total}** 个接口（带角色校验的约 1125 个）。`);
if (be.disabled.length) {
  map.push('');
  map.push('**已暂停（代码里挂载被注释，勿当成可用）**：' + be.disabled.map((d) => '`' + d + '`').join('、'));
}
map.push('');
map.push('## 二、业务逻辑在哪（services）');
map.push('');
map.push('| 主题 | 文件 |');
map.push('|---|---|');
[
  ['订单状态机（唯一实现，所有流转都走它）', 'src/services/orderFlow.js'],
  ['工序节点 / 流程模板 / 内置 code', 'src/services/nodeFlow.js'],
  ['分单与产能分配', 'src/services/orderAssign.js'],
  ['库存三轨（原料唯一写入口 applyStock）', 'src/services/matflow.js'],
  ['客户信用与发货闸门', 'src/services/credit.js'],
  ['客户进度快照发布', 'src/services/customerProgress.js'],
  ['客户商城与订单状态通知', 'src/services/mall.js'],
  ['客户买过什么 / 订单可见性', 'src/services/crm.js'],
  ['检验与异常', 'src/services/inspection.js'],
  ['成本对象与归集', 'src/routes/costObjects.js'],
  ['权限单一来源', 'src/access/permissions.js'],
  ['主体（公司）范围', 'src/access/companyScope.js'],
].forEach(([k, v]) => map.push(`| ${k} | \`backend/${v}\` |`));
map.push('');
map.push('## 三、前端：路由 → 页面');
map.push('');
map.push('| 路由 | 页面文件 | 标题 |');
map.push('|---|---|---|');
fe.routes.forEach((r) => {
  const comp = fe.views.includes(r.component + '.vue') ? r.component + '.vue' : r.component + '（未见同名 .vue）';
  map.push(`| \`/${r.path}\` | \`frontend/src/views/${comp}\` | ${fe.titles[r.path] || ''} |`);
});
map.push('');
map.push(`全部页面组件 ${fe.views.length} 个（\`frontend/src/views/\`）。`);
map.push('');
map.push('## 四、其它关键位置');
map.push('');
map.push('| 位置 | 作用 |');
map.push('|---|---|');
map.push('| `backend/src/schema.js` | 表结构唯一来源 |');
map.push('| `backend/src/db.js` | 连接 + 启动补列（migrate 段） |');
map.push('| `backend/src/server.js` | 启动 + 全部 app.use 挂载 |');
map.push('| `frontend/src/api/index.js` | 所有请求（自动带 token、401 跳登录） |');
map.push('| `frontend/src/store/permissions.js` | 按钮级权限 `can()` |');
map.push('| `backend/scripts/smoke-test.js` | 冒烟（2309 项，改完必跑） |');
map.push('| `backend/scripts/rbac-audit.js` | 权限审计（1125 接口 / 167 权限点） |');
map.push('| `backend/scripts/sweep-pages.js` | 页面渲染巡检 |');
map.push('| `deploy/win/reload-erp.cmd` | 换代码后重载正式服务（唯一正确方式） |');
fs.writeFileSync(path.join(OUT, '01-code-map.md'), map.join('\n') + '\n');

// 02 全量接口
const ep = [];
ep.push('# 全量接口清单（自动生成）');
ep.push('');
ep.push('用途：**检索定位**。要改某个功能时先在这里搜路径，再去对应路由文件读实现。');
ep.push('本清单里没有的接口就是不存在 —— 不要凭空调用。');
ep.push('');
be.endpoints.forEach((e) => {
  ep.push(`## \`${e.prefix}\` — \`backend/src/routes/${e.file}.js\`（${e.eps.length} 个）`);
  ep.push('');
  e.eps.forEach((x) => ep.push(`- \`${x.method} ${e.prefix}${x.path === '/' ? '' : x.path}\``));
  ep.push('');
});
fs.writeFileSync(path.join(OUT, '02-endpoints.md'), ep.join('\n'));

// 03 现状
const st = [];
st.push('# 项目现状快照');
st.push('');
st.push(`- 版本：**${version}**`);
st.push(`- 表：**${sc.tables.length}** 张 / 索引约 ${sc.idx} 个（SQLite 单文件 \`backend/data/erp-mindmap.db\`）`);
st.push(`- 接口：**${be.total}** 个（其中约 1125 个带角色校验）`);
st.push(`- 前端页面：**${fe.views.length}** 个 vue`);
st.push('- 冒烟：单公司 **2309 / 0**，多主体（`SINGLE_COMPANY=0`）**2420 / 0**');
st.push('- 权限审计：1125 接口 / 167 权限点 / **0 问题**');
st.push('');
st.push('## 已闭环的业务链路');
st.push('');
st.push('```');
st.push('下单（款→颜色→尺码，美金）');
st.push('  → 开发单 → 技术确认（必填校验 + 至少 1 道车缝工序 + 打版完成）');
st.push('  → 成本单 + 财务审核 → 分单（覆盖整单）');
st.push('  → 投产（自动初始化 13 道工序）→ 首件放行 → 逐工序报工');
st.push('  → 尾期验货（AQL 放行）→ 成品入库 → 发货出库（信用闸门）');
st.push('  → 自动开应收 → 收款核销 → 结案（应收清零）');
st.push('```');
st.push('');
st.push('## 已知状态 / 未完成');
st.push('');
st.push('- **财务模块暂缓**：坏账接口已下线，凭证 1231 / 6702 仍有余额在账。');
st.push('- 新装或重置数据后，必须确认 `node_templates` 里有默认工序流程；');
st.push('  没有就跑 `node scripts/apply-nodeflow-ddl.js`（幂等），否则订单投不了产。');
st.push('- 详见 `docs/STATUS-ARCHIVE.md`（335 行，逐模块状态）。');
fs.writeFileSync(path.join(OUT, '03-status.md'), st.join('\n') + '\n');

// 04 最近变更（取前 3 个版本段）
const changelog = read(path.join(ROOT, 'CHANGELOG.md'));
const parts = changelog.split(/^## /m).slice(1, 4);
fs.writeFileSync(path.join(OUT, '04-recent-changes.md'),
  '# 最近三个版本（接手前先看，这些是最近踩过的坑）\n\n## ' + parts.join('\n## '));

// 05 表结构
const sch = [];
sch.push(`# 表结构摘要（${sc.tables.length} 张表，自动生成）`);
sch.push('');
sch.push('完整定义见 `backend/src/schema.js`（唯一来源）。这里只有表名与列名，用于快速判断「改这个功能要碰哪张表」。');
sch.push('');
sc.tables.forEach((t) => {
  sch.push(`## \`${t.name}\``);
  sch.push(t.cols.join(', '));
  sch.push('');
});
fs.writeFileSync(path.join(OUT, '05-schema-summary.md'), sch.join('\n'));

// 06 验证
fs.writeFileSync(path.join(OUT, '06-verify.md'), `# 怎么验证（改完必须做）

## 起一个不污染环境的实例

\`\`\`bash
cd backend
node -e "new (require('better-sqlite3'))('data/erp-mindmap.db',{readonly:true}).backup('data/tmp-x.db')"
PORT=3100 DB_PATH=./data/tmp-x.db ERP_SCHEDULER=0 node src/server.js
\`\`\`

**3000 端口与正式库不要碰**（那是正在服务业务的实例）。

## 三件套

\`\`\`bash
cd backend
npm run smoke                                   # 期望：通过 2309，失败 0
SINGLE_COMPANY=0 ... npm run smoke              # 多主体：2420 / 0（要换实例启动参数）
npm run rbac                                    # 期望：1125 接口 / 167 权限点 / 0 问题
node scripts/sweep-pages.js /orders,/products    # 期望：正常 = 页数，有问题 0
npm run verify:data                             # 期望：无孤儿 / 干净
\`\`\`

## 前端改了
\`\`\`bash
cd frontend && npm run build      # 产物 dist/ 由后端托管
\`\`\`

## 上到正式服务
\`\`\`cmd
deploy\\win\\reload-erp.cmd
\`\`\`
然后核对是否真的生效：

\`\`\`bash
curl -s http://127.0.0.1:3000/api/health
\`\`\`

\`code_stamp.newest_at\` 必须**不早于**你改的那个文件的 mtime。
不核对这一步，会出现「health 200 所以我改好了」的假象 —— node 是独立进程，
停计划任务并不会杀它，端口还被占着。
`);

// 追加模块源码（可选）
let extra = 0;
if (MODULES.length) {
  const dir = path.join(OUT, '07-modules');
  fs.mkdirSync(dir, { recursive: true });
  MODULES.forEach((mod) => {
    const hits = [];
    ['src/routes', 'src/services', 'src/access'].forEach((sub) => {
      const d = path.join(BACKEND, sub);
      if (!fs.existsSync(d)) return;
      fs.readdirSync(d)
        .filter((f) => f.toLowerCase().includes(mod.toLowerCase()) && f.endsWith('.js'))
        .forEach((f) => hits.push(path.join(d, f)));
    });
    const vdir = path.join(ROOT, 'frontend/src/views');
    if (fs.existsSync(vdir)) {
      fs.readdirSync(vdir)
        .filter((f) => f.toLowerCase().includes(mod.toLowerCase()) && f.endsWith('.vue'))
        .forEach((f) => hits.push(path.join(vdir, f)));
    }
    hits.forEach((p) => {
      const name = path.basename(p);
      const tag = p.includes('frontend') ? 'vue-' : '';
      fs.copyFileSync(p, path.join(dir, tag + name));
      extra += 1;
    });
  });
}

/* ---------------- 5. 报告 ---------------- */
const size = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
console.log('交接包已生成：' + OUT);
fs.readdirSync(OUT).filter((f) => f.endsWith('.md')).forEach((f) => {
  console.log(`  ${f.padEnd(22)} ${String(size(f)).padStart(5)} KB`);
});
if (extra) console.log(`  07-modules/            ${extra} 个模块源码文件`);
console.log('');
console.log(`信息量：${be.total} 个接口 / ${sc.tables.length} 张表 / ${fe.views.length} 个页面`);

if (WANT_ZIP) {
  const zip = path.join(ROOT, 'handoff-' + version + '.zip');
  fs.rmSync(zip, { force: true });
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'ignore' });
    console.log('已打包：' + zip + '（' + Math.round(fs.statSync(zip).size / 1024) + ' KB）');
  } catch (e) {
    console.log('打包失败（不影响 handoff/ 目录）：' + e.message);
  }
}
