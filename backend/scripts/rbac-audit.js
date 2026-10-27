/**
 * 权限矩阵审计（静态解析，不写库、不产生数据）
 *
 * 做三件事：
 *   1. 扫描 backend/src/routes/*.js，解析每个写接口的角色要求 → 生成后端矩阵
 *   2. 读取 backend/src/access/permissions.js 的权限点表（单一来源）
 *   3. 对照「页面按钮权限」与「后端接口权限」，报告不一致（点得到但会被拒 / 该看不到却能看到）
 *
 * 用法：node scripts/rbac-audit.js [--md ../docs/RBAC.md]
 */
const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.resolve(__dirname, '../src/routes');

// 权限矩阵单一来源在后端（一人多岗 / 用户级收回都靠它算），不再读前端文件。
// 前端 store/perm-table.js 由 scripts/sync-frontend-perms.js 生成，只作首屏兜底。
const { PERMS, ROLES, ROLE_LABELS, GUARDED, SOD_RULES } = require('../src/access/permissions');
const ROLE_LABEL = ROLE_LABELS;
const VERB_LABEL = { POST: '新增/操作', PUT: '修改', PATCH: '修改', DELETE: '删除', GET: '读取' };

/** 解析源文件里的 const X = [...] 常量 */
function parseConsts(src) {
  const out = {};
  const re = /const\s+([A-Z_]+)\s*=\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(src))) {
    out[m[1]] = m[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return out;
}

/** 解析 router.xxx('path', authRequired, requireRole(...)) */
function parseRoutes(file) {
  const src = fs.readFileSync(file, 'utf8');
  const consts = parseConsts(src);
  const list = [];
  const re = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'([\s\S]*?)\);/g;
  let m;
  while ((m = re.exec(src))) {
    const [full, method, routePath, rest] = m;
    // 支持 requireRole([...]) / requireRole(CONST) / requireRole(...CONST) 三种写法
    const rm = rest.match(/requireRole\(\s*(?:\.\.\.)?\s*(\[[^\]]*\]|[A-Z_]+)\s*\)/);
    if (!rm) continue;
    let roles;
    if (rm[1].startsWith('[')) {
      roles = rm[1].slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      roles = consts[rm[1]] || ['<未解析:' + rm[1] + '>'];
    }
    list.push({
      file: path.basename(file),
      method: method.toUpperCase(),
      path: routePath,
      roles
    });
  }
  return list;
}

/** 解析前端权限表 */
function parsePerms() {
  if (!fs.existsSync(PERMS_FILE)) return {};
  const src = fs.readFileSync(PERMS_FILE, 'utf8');
  const out = {};
  const re = /'([\w.]+)':\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(src))) {
    out[m[1]] = m[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return out;
}

/**
 * 页面按钮权限 ↔ 后端接口权限 的对照表（人工维护，改了接口要同步）
 * 左侧：前端 can('xxx') 的权限名；右侧：该动作实际打到的后端接口
 */
const PAIRS = [
  { perm: 'customer.write', api: 'customers', actions: 'POST/PUT/DELETE', page: '客户管理' },
  { perm: 'product.write', api: 'products', actions: 'POST/PUT/DELETE', page: '产品管理' },
  { perm: 'order.create', api: 'orders', actions: 'POST', page: '销售订单' },
  { perm: 'development.write', api: 'techpacks', actions: 'POST/PUT', page: '开发管理' },
  { perm: 'cost.write', api: 'costs', actions: 'POST', page: '财务成本单' },
  { perm: 'cost.review', api: 'costs', actions: 'POST /review', page: '财务审核' },
  { perm: 'craft.write', api: 'crafts', actions: 'POST/DELETE', page: '工艺明细' },
  { perm: 'material.write', api: 'order-materials', actions: 'POST/DELETE', page: '面辅料用量' },
  { perm: 'node.write', api: 'order-nodes', actions: 'PATCH/init', page: '生产工序' },
  { perm: 'report.write', api: 'reports', actions: 'POST/DELETE', page: '生产报工' },
  { perm: 'factory.write', api: 'factories', actions: 'POST/PUT/DELETE', page: '工厂/外协' },
  { perm: 'stock.write', api: 'stock', actions: 'POST', page: '库存管理' },
  { perm: 'purchase.write', api: 'purchases', actions: 'POST', page: '采购管理' },
  { perm: 'employee.write', api: 'employees', actions: 'POST/PUT/DELETE', page: '员工档案' },
  { perm: 'leave.write', api: 'leaves', actions: 'POST', page: '请假管理' },
  { perm: 'payroll.write', api: 'payrolls', actions: 'POST/PUT', page: '薪酬核算' },
  { perm: 'asset.write', api: 'assets', actions: 'POST/PUT/DELETE', page: '固定资产' },
  { perm: 'expense.write', api: 'admin-expenses', actions: 'POST/PUT/DELETE', page: '行政费用' },
  { perm: 'quote.write', api: 'quotations', actions: 'POST/PUT/status', page: '报价单' },
  { perm: 'settings.write', api: 'settings', actions: 'PUT', page: '系统设置' },
  { perm: 'user.manage', api: 'users', actions: 'POST/PUT', page: '用户与角色' },
  { perm: 'approvalflow.manage', api: 'approval-flows', actions: 'POST/PUT/DELETE', page: '审批流配置' },
  { perm: 'audit.read', api: 'audit', actions: 'GET', page: '操作日志' }
];

// ---------------- 运行 ----------------
const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
const all = [];
files.forEach((f) => all.push(...parseRoutes(path.join(ROUTES_DIR, f))));
all.sort((a, b) => (a.file + a.path).localeCompare(b.file + b.path));

const perms = PERMS;

// 后端写接口矩阵
const byApi = {};
all.forEach((r) => {
  if (!byApi[r.file]) byApi[r.file] = [];
  byApi[r.file].push(r);
});

// 一致性检查
const issues = [];
PAIRS.forEach((p) => {
  const front = perms[p.perm];
  if (!front) {
    issues.push({ level: 'warn', text: `前端权限表缺少 ${p.perm}（${p.page}），can('${p.perm}') 会恒为 false` });
    return;
  }
  const ep = all.filter((r) => r.file === p.api.replace(/-/g, '') + '.js' || r.file === p.api.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + '.js');
  if (!ep.length) {
    issues.push({ level: 'warn', text: `未找到接口文件对应 ${p.api}（${p.page}），请检查对照表` });
    return;
  }
  // 并集：该模块任意一个写接口允许的角色（判断「前端给了按钮但一次都点不动」）
  const union = new Set();
  ep.forEach((r) => r.roles.forEach((x) => union.add(x)));
  // 交集：该模块所有写接口都允许的角色（判断「后端全能做、前端却完全没入口」）
  let inter = null;
  ep.forEach((r) => {
    const set = new Set(r.roles.concat('admin'));
    inter = inter === null ? set : new Set([...inter].filter((x) => set.has(x)));
  });
  const frontSet = new Set(front.concat('admin'));
  const onlyFront = [...frontSet].filter((r) => !union.has(r));
  const onlyBack = [...(inter || [])].filter((r) => !frontSet.has(r) && r !== 'admin');
  if (onlyFront.length) {
    issues.push({
      level: 'error',
      text: `${p.page}：前端对「${onlyFront.map((r) => ROLE_LABEL[r] || r).join('、')}」显示了按钮，但后端不允许（点了会 403）`
    });
  }
  if (onlyBack.length) {
    issues.push({
      level: 'info',
      text: `${p.page}：后端允许「${onlyBack.map((r) => ROLE_LABEL[r] || r).join('、')}」，但前端不显示按钮（功能被藏起来）`
    });
  }
});

// ---------------- 输出 ----------------
const lines = [];
lines.push('# 权限矩阵（RBAC）\n');
lines.push('> 本文件由 `backend/scripts/rbac-audit.js` 生成，接口有变动请重跑脚本，不要手工改。\n');
lines.push('> 权限矩阵的单一来源是 `backend/src/access/permissions.js`；前端 `store/perm-table.js` 由脚本生成，仅作首屏兜底。\n');
lines.push('角色：' + ROLES.map((r) => `**${ROLE_LABEL[r]}**（${r}）`).join(' · '));
lines.push('\n`admin` 对所有接口放行（后端 `requireRole` 内直接通过）。\n');

lines.push('## 一、写接口 × 角色\n');
lines.push('| 接口模块 | 方法 | 路径 | ' + ROLES.map((r) => ROLE_LABEL[r]).join(' | ') + ' |');
lines.push('|---|---|---|' + ROLES.map(() => '---').join('|') + '|');
all.forEach((r) => {
  const cells = ROLES.map((role) => (role === 'admin' || r.roles.includes(role) ? '✅' : '—'));
  lines.push(`| ${r.file.replace('.js', '')} | ${r.method} | \`${r.path || '/'}\` | ${cells.join(' | ')} |`);
});

lines.push('\n## 二、前端按钮权限表（permissions.js）\n');
lines.push('| 权限名 | 允许角色 |');
lines.push('|---|---|');
Object.entries(perms).forEach(([k, v]) => {
  lines.push(`| \`${k}\` | ${v.map((r) => ROLE_LABEL[r] || r).join('、')} |`);
});

lines.push('\n## 三、一致性检查\n');
if (!issues.length) {
  lines.push('✅ 前后端权限口径一致，未发现矛盾。');
} else {
  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  issues.forEach((i) => {
    const icon = i.level === 'error' ? '❌' : i.level === 'warn' ? '⚠️' : 'ℹ️';
    lines.push(`- ${icon} ${i.text}`);
  });
}

const md = lines.join('\n') + '\n';
const outIdx = process.argv.indexOf('--md');
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
if (outFile) {
  fs.writeFileSync(path.resolve(outFile), md, 'utf8');
  console.log('已写入', outFile);
} else {
  console.log(md);
}

// 统计口径：all 是「带了 requireRole 的接口」——写接口全在内，另有少量限岗的读接口（如工资表）
console.log(`\n统计：带角色要求的接口 ${all.length} 个，权限点 ${Object.keys(perms).length} 项，问题 ${issues.length} 条`);
const errors = issues.filter((i) => i.level === 'error').length;
process.exit(errors ? 1 : 0);
