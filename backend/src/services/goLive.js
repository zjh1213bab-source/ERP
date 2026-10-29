/**
 * 上线检查清单（Go-live Checklist）
 * ========================================================================
 * 这一层回答一个问题：**今天能不能上线，凭据是什么。**
 *
 * 与 `deploy/GO-LIVE-CHECKLIST.md` 的分工（不重叠，也不互相替代）：
 *   - `deploy/` 那份是**装机手册**：装 Node、配 Nginx、开端口、证书。
 *     回答「服务器装对了没有」。
 *   - 这一份是**上线决策**：数据干不干净、权限收没收回、备份能不能恢复、
 *     财务口径符不符合、人培训了没有。回答「这个系统现在交给客户用，行不行」。
 *   装好了不等于能上线；能上线也不代表装对了。
 *
 * ## 为什么要做成系统里的一张清单，而不是又一个 markdown
 *
 * 1. **勾选要留人留时间**。一份 markdown 打勾，三天后没人知道是谁勾的、
 *    凭据是什么、勾的时候数字是几。这里每项落库，带 `done_by / done_at / evidence`。
 *
 * 2. **能自动验的就别让人勾**。冒烟残留、孤儿行、默认密码、备份文件是否真的在盘上、
 *    借贷是否平衡 —— 这些每轮都要看、人看又容易走神的东西交给代码。
 *    人只负责「培训签收」「并行运行计划」这类真的需要判断的事项。
 *
 * 3. **自动项不许人工改成「通过」**。这是这张清单和橡皮章之间唯一的分界线。
 *    自动项的 `status` 只能由检查器写；人工接口碰到 auto 项直接拒绝。
 *
 * 4. **签署要冻结**。签完再改库，历史结论就跟着变了 —— 那这份签署等于没签。
 *    所以 `signed` 之后不许刷新，要改先 `withdraw` 并写明理由。
 *
 * ## 五条判定口径
 *
 * 1. **阻塞项没通过就不能签「准予上线」**。可以签「暂不上线」（no_go）——
 *    决定不上线本身是个正当结论，不该被系统拦住。
 *
 * 2. **「不适用」必须写理由**。否则清单会被 `na` 填满，
 *    看起来全绿、实际一条都没验。
 *
 * 3. **演示库与正式库口径不同**。`scope='demo'` 时演示数据（`demo_tag`）算正常，
 *    `scope='production'` 时它是阻塞项 —— 客户拿到带着演示订单的库，第一件事是问
 *    「这些单是谁的」。
 *
 * 4. **自动检查给结论，不给「已通过」三个字**。每个检查器都要带数字
 *    （「残留 0 行」「借贷 15,375,583.02 = 15,375,583.02」），
 *    否则报告无法复核，签字的人只能选择相信。
 *
 * 5. **检查器失败不算通过**。检查器自己抛异常时写 `fail` 并带上异常信息，
 *    不许吞掉当 `pass` —— 一个跑不动的检查比一个没通过更危险。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { db, now } = require('../db');
const { nextNo } = require('../utils/docNo');
const { verifyPassword } = require('../auth/password');
const config = require('../config');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round(num(v) * 100) / 100;
const money = (v) => round2(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const shiftDays = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const SECTIONS = {
  data: { label: '数据', order: 1, note: '库里的东西是不是客户能直接看的' },
  access: { label: '权限与账号', order: 2, note: '谁能进、能做什么、责任落到人' },
  backup: { label: '备份与恢复', order: 3, note: '出事能不能回去' },
  finance: { label: '财务口径', order: 4, note: '账平不平、期间清不清' },
  runtime: { label: '运行与发布', order: 5, note: '装对了没有、能不能切' },
  org: { label: '组织与培训', order: 6, note: '人会不会用、出事找谁' }
};

const SEVERITY = {
  blocker: { label: '阻塞', note: '不通过不能上线' },
  required: { label: '必需', note: '不通过要写说明并由决策人确认' },
  nice: { label: '建议', note: '可延后到上线后第一周' }
};

const STATUS = {
  pass: { label: '通过', tone: 'ok' },
  fail: { label: '不通过', tone: 'bad' },
  warn: { label: '有提示', tone: 'warn' },
  na: { label: '不适用', tone: 'mute' },
  pending: { label: '待处理', tone: 'idle' }
};

const CONCLUSION = {
  go: '准予上线',
  conditional: '有条件上线（遗留项限期关闭）',
  no_go: '暂不上线'
};

// ============================================================
// 清单模板
// ============================================================
/**
 * 每一项的写法要求：
 *   - `detail` 写给签字的人看：**为什么这一项会影响上线**，不是复述标题
 *   - `how`    自动项写检查器口径（能复核），人工项写具体动作（能执行）
 */
const ITEMS = [
  // ---------------- 数据 ----------------
  {
    key: 'smoke_residue', section: 'data', kind: 'auto', check: 'smoke_residue', severity: 'blocker',
    title: '库里没有烟测残留',
    detail: '烟测夹具混在真数据里最难认：单号格式正常、金额正常，只有内容不对（「烟测员工A」「SMOKE-744441」）。客户第一次点开列表就会看到。',
    how: '按标识列前缀（SMOKE / SMK- / 烟测 / 冒烟）扫全库；备注里提到烟测不算，避免误删真实单据。'
  },
  {
    key: 'orphan_rows', section: 'data', kind: 'auto', check: 'orphan_rows', severity: 'required',
    title: '没有指向已删记录的明细行',
    detail: '这个库 350 多张表零外键：删掉一张订单不会报错，只会留下指向不存在记录的尺码行。等对账对不上时，已经过去三个月。',
    how: '按登记的父子对逐对检查（订单→明细→尺码、询价→明细、凭证→分录等）。'
  },
  {
    key: 'demo_data', section: 'data', kind: 'auto', check: 'demo_data', severity: 'blocker',
    title: '演示数据已清理（正式库要求）',
    detail: '演示数据带 demo_tag，客户拿到带着演示订单、演示客户的库，第一件事是问「这些单是谁的」。演示交付时这一项按「允许」处理。',
    how: '统计带 demo_tag 的行。`scope=production` 要求 0；`scope=demo` 只提示。'
  },
  {
    key: 'base_data', section: 'data', kind: 'auto', check: 'base_data', severity: 'required',
    title: '基础档案已录入且关键字段完整',
    detail: '部门、员工、客户、产品、物料是全部业务的前置。空着不会报错，只会在开第一张单时发现「选不到人」。',
    how: '检查五类档案非空，并统计关键归属字段缺失的行数（员工无部门、客户无编码等）。'
  },
  {
    key: 'schema_sync', section: 'data', kind: 'auto', check: 'schema_sync', severity: 'required',
    title: '表结构快照与运行库一致',
    detail: '交付包里的 schema.js 是建库依据。改了 DDL 忘了刷新快照，客户装出来的库会少几张表，而错误要等到点进某个页面才出现。',
    how: '把 schema.js 里的建表语句解析成表名集合，与实际库的表名集合比对差异。'
  },

  // ---------------- 权限与账号 ----------------
  {
    key: 'default_pwd', section: 'access', kind: 'auto', check: 'default_pwd', severity: 'blocker',
    title: '没有账号还在用默认密码',
    detail: '示例密码写在文档里、demo 里、每一篇教程里。上线后第一个被扫的就是它。',
    how: '用系统自己的校验函数逐一试已知弱密码（admin123456 / 123456），命中即不通过。'
  },
  {
    key: 'users_bound', section: 'access', kind: 'auto', check: 'users_bound', severity: 'required',
    title: '在用账号都绑定了员工',
    detail: '账号不绑员工，工资、考勤、领用、技能全部无法归人 —— 打卡记录落在「谁」身上就断了。',
    how: '检查 `active=1` 的账号 `employee_id` 是否为空；管理员账号可例外但需在备注说明。'
  },
  {
    key: 'users_scoped', section: 'access', kind: 'auto', check: 'users_scoped', severity: 'required',
    title: '在用账号都有公司主体归属',
    detail: '没绑主体的业务账号，数据范围无法判定。多主体模式下这类账号会被直接拒绝访问（见 v1.68），'
      + '单公司模式下虽然不报错，但一旦切回多主体就全部被挡在门外 —— 上线前一次补齐，比事后逐个找人说方便。',
    how: '查 `active=1` 且 `company_id` 为空/0 的账号（管理员也一起算，因为管理员同样要落主体）；'
      + '在「用户与角色」里编辑该账号并指定公司。'
  },
  {
    key: 'perm_orphan', section: 'access', kind: 'auto', check: 'perm_orphan', severity: 'nice',
    title: '权限点没有悬空引用',
    detail: '拦截规则里写了某个权限点、但权限表里没有它，结果是这条规则永远不生效 —— 看起来有保护，实际没有。',
    how: '扫描 `GUARDED` 拦截规则引用的权限点，与 `PERMS` 权限表比对。'
  },
  {
    key: 'matrix_signoff', section: 'access', kind: 'manual', severity: 'required',
    title: '岗位权限矩阵已终审签署',
    detail: '谁能看工资、谁能改价、谁能作废凭证 —— 这些授权一旦上线就默认成立。矩阵签过一次，后面每一次争议都有依据。',
    how: '在「权限复核」页导出矩阵 → 各部门负责人逐岗确认 → 签字件存档并在下方填写签署单号。'
  },

  // ---------------- 备份与恢复 ----------------
  {
    key: 'backup_recent', section: 'backup', kind: 'auto', check: 'backup_recent', severity: 'blocker',
    title: '近 7 天有成功备份',
    detail: '上线当天是最容易出事的时点，也是唯一没有「上一次备份」可退的时点。',
    how: '查备份任务里近 7 天、校验状态为通过的手工/定时备份。'
  },
  {
    key: 'backup_file_exists', section: 'backup', kind: 'auto', check: 'backup_file_exists', severity: 'blocker',
    title: '最近一次备份文件真实存在',
    detail: '「备份记录成功」和「文件还在盘上」是两件事。目录被清、磁盘满、路径改动，记录照样是成功。',
    how: '取最近一条备份记录的实际路径，检查文件存在且大小与记录一致。'
  },
  {
    key: 'restore_drill', section: 'backup', kind: 'auto', check: 'restore_drill', severity: 'required',
    title: '做过至少一次恢复演练',
    detail: '没恢复过的备份不算备份，只算「一份希望」。恢复演练要真做一次，才知道备份文件能不能替换运行库。',
    how: '查备份任务里是否有成功的恢复记录（`restore_status=applied`）。'
  },
  {
    key: 'rollback_plan', section: 'backup', kind: 'manual', severity: 'required',
    title: '回滚预案与上一版发布包已留底',
    detail: '上线失败时最需要的是「十分钟回到昨天」，而不是「先分析原因」。留底包含代码版本、前端构建产物、数据库备份三样。',
    how: '确认上一版发布包与数据库备份都已归档，并在下方填写归档路径。'
  },

  // ---------------- 财务口径 ----------------
  {
    key: 'gl_balance', section: 'finance', kind: 'auto', check: 'gl_balance', severity: 'blocker',
    title: '总账借贷平衡且分录无孤儿',
    detail: '借贷不平的库上线后，第一个月结账就会卡住，而原因往往在几个月前的一张凭证上。',
    how: '汇总已过账凭证的借贷合计并比较差额；同时检查分录是否指向不存在的凭证。'
  },
  {
    key: 'period_closed', section: 'finance', kind: 'auto', check: 'period_closed', severity: 'required',
    title: '上线前一期间已关账',
    detail: '上期不关账就上线，上线后的业务会与历史数据混在同一个期间里，第一个月对账没有干净的起点。',
    how: '检查上一自然月的财务期间状态（未建期间 / 未关账都给提示并写明影响）。'
  },
  {
    key: 'opening_confirmed', section: 'finance', kind: 'manual', severity: 'required',
    title: '期初库存、往来、总账三方签认',
    detail: '期初不是「导进去就行」：库存数量要与实物盘点一致、往来要与客户/供应商对账一致、总账试算要平。三方签认之后，差异才有归属。',
    how: '导出期初库存表、应收应付台账、试算平衡表 → 三方核对 → 签字件存档并填写单号。'
  },

  // ---------------- 运行与发布 ----------------
  {
    key: 'health', section: 'runtime', kind: 'auto', check: 'health', severity: 'required',
    title: '服务健康且数据库可读写',
    detail: '接口能返回不等于能写。只读挂载、磁盘满、WAL 锁死都会表现为「页面能开、保存没反应」。',
    how: '执行一次数据库读与一次数据目录可写探测，并记录进程已运行时长。'
  },
  {
    key: 'secret_changed', section: 'runtime', kind: 'auto', check: 'secret_changed', severity: 'blocker',
    title: 'JWT 密钥已改为随机长串',
    detail: '用默认密钥，任何人都能自己签发一个管理员 token。这一项没有中间态：要么改过，要么等于没有登录。',
    how: '检查配置里的 JWT 密钥是否仍是示例值或长度不足 32 位。'
  },
  {
    key: 'env_mode', section: 'runtime', kind: 'auto', check: 'env_mode', severity: 'blocker',
    title: '运行在 production 模式且 CORS 已限定来源',
    detail: 'NODE_ENV 不是 production 时，启动时的配置自检只会提示、不会拦住 —— 于是"带默认口令上线"这件事没人拦。'
      + 'CORS 还是 * 时，任何站点都能带着 token 调接口。',
    how: '检查 NODE_ENV=production 且 CORS_ORIGIN 已设为具体域名（不是 *）。'
  },
  {
    key: 'upload_writable', section: 'runtime', kind: 'auto', check: 'upload_writable', severity: 'required',
    title: '上传目录存在且可写',
    detail: '款图、面单、验货照片全落在这里。目录不可写时上传按钮会转圈，用户以为网络慢。',
    how: '检查上传目录存在、可写，并统计当前文件数（迁移时用来核对有没有漏拷）。'
  },
  {
    key: 'app_version', section: 'runtime', kind: 'manual', severity: 'nice',
    title: '发布版本号与交付包一致',
    detail: '出问题时第一句话一定是「你们现在跑的是哪个版本」。版本对不上，后面所有排查都建立在猜测上。',
    how: '确认页面底部版本号与交付包文件名一致，并填写包名。'
  },
  {
    key: 'switch_window', section: 'runtime', kind: 'manual', severity: 'required',
    title: '切换窗口与值守安排已确定',
    detail: '切换要选在业务低谷（不接单、不发货的时段），并安排上线后 72 小时的值守人。否则第一个问题出现在没人看手机的晚上。',
    how: '填写切换窗口、值守人、以及「切换期间是否停止下单」的决定。'
  },

  // ---------------- 组织与培训 ----------------
  {
    key: 'manual_signoff', section: 'org', kind: 'manual', severity: 'required',
    title: '操作手册已按分册签收',
    detail: '手册写完了不等于人看过了。按分册（销售/技术/生产/仓库/财务/人事/管理员）签收，才知道哪个岗位还需要补培训。',
    how: '按分册发放并回收签收记录，在下方填写已签收分册与未签收岗位。'
  },
  {
    key: 'key_training', section: 'org', kind: 'manual', severity: 'required',
    title: '关键岗位完成实操培训',
    detail: '关键岗位指「一个人不会、整条流程就断」的岗位：接单、开料、验货、收付款、发工资。这些岗位要按真实单据练过一遍。',
    how: '用测试单据走完整流程（下单→生产→入库→发货→收款），记录参加人与通过情况。'
  },
  {
    key: 'parallel_run', section: 'org', kind: 'manual', severity: 'required',
    title: '并行运行计划已确认（至少一个完整账期）',
    detail: '新旧两套并行跑一个账期，是唯一能在不影响业务的前提下发现差异的办法。不并行直接切，差异会在月底以「账对不上」的形式集中爆发。',
    how: '确认并行账期起止、并行期间以哪套为准、差异如何记录与归零。'
  },
  {
    key: 'account_issue', section: 'org', kind: 'manual', severity: 'required',
    title: '账号开通清单与初始密码下发方式已定',
    detail: '上线当天最耗时的事通常是「我的账号呢」。提前定好开给谁、初始密码怎么给（当面/企业微信/短信），当天就只是点几下。',
    how: '列出各岗位开通名单与发放方式；确认首次登录强制改密的要求已告知。'
  },
  {
    key: 'contact_list', section: 'org', kind: 'manual', severity: 'nice',
    title: '应急联系人与升级路径已明确',
    detail: '出事时最贵的成本是「找人」。系统卡住 -> 找谁 -> 多久没响应找谁，这条链路要提前写下来。',
    how: '填写一线支持、系统负责人、决策人三级联系人。'
  }
];

// ============================================================
// 自动检查器
// ============================================================
/**
 * 每个检查器返回 `{ status, result }`：
 *   - `result` 必须带数字（能复核），不许只写「已通过」
 *   - `status` 取 pass / fail / warn（检查器不返回 na —— 「不适用」是人的判断）
 */
const CHECKS = {};

/** 懒加载体检脚本：它扫全库约 650ms，不该在服务启动时跑 */
let _audit = null;
const auditMod = () => {
  if (!_audit) _audit = require('../../scripts/audit-demo-data');
  return _audit;
};

CHECKS.smoke_residue = () => {
  const sc = auditMod().scan();
  const rows = sc.l1.reduce((a, x) => a + x.rows, 0);
  // 名单只列前几个：几十张表名连成一串，塞在阻塞提示里既读不了也点不动。
  // 完整清单留给 `npm run audit:data`，那里是给人逐条看的。
  const brief = (arr, n) => arr.slice(0, n).join('、') + (arr.length > n ? ` 等 ${arr.length} 个` : '');
  const list = sc.l1.map((x) => `${x.table}(${x.rows})`);
  return rows === 0
    ? { status: 'pass', result: '全库扫描完成，烟测残留 0 行' }
    : { status: 'fail', result: `残留 ${rows} 行：${brief(list, 4)}。执行 npm run clean:data 清理` };
};

CHECKS.orphan_rows = () => {
  const pairs = auditMod().findOrphans();
  if (!pairs.length) return { status: 'pass', result: '已登记的父子对全部有对应父行，孤儿 0 行' };
  const rows = pairs.reduce((a, x) => a + x.rows, 0);
  return {
    status: 'fail',
    result: `${rows} 行指向已删父行：` + pairs.map((x) => `${x.child}.${x.col}(${x.rows})`).join('、') + '。执行 npm run verify:data 后按提示修复'
  };
};

CHECKS.demo_data = (round) => {
  const sc = auditMod().scan();
  const rows = sc.l2.reduce((a, x) => a + x.rows, 0);
  const tables = sc.l2.length;
  if (rows === 0) return { status: 'pass', result: '带 demo_tag 的演示数据 0 行' };
  if (round.scope === 'demo') {
    return { status: 'pass', result: `演示库：${tables} 张表共 ${rows} 行演示数据（本口径允许）` };
  }
  return {
    status: 'fail',
    result: `正式库仍有 ${tables} 张表共 ${rows} 行演示数据。清理：npm run clean:data -- --with-demo`
  };
};

CHECKS.base_data = () => {
  const cnt = (sql) => {
    try { return db.prepare(sql).get().c; } catch (e) { return -1; }
  };
  const dept = cnt("SELECT COUNT(*) c FROM departments");
  const emp = cnt("SELECT COUNT(*) c FROM employees WHERE status = 'active'");
  const cus = cnt("SELECT COUNT(*) c FROM customers");
  const prod = cnt("SELECT COUNT(*) c FROM products");
  const mat = cnt("SELECT COUNT(*) c FROM materials");
  const parts = [
    { k: '部门', v: dept }, { k: '在职员工', v: emp }, { k: '客户', v: cus },
    { k: '产品', v: prod }, { k: '物料', v: mat }
  ];
  const empty = parts.filter((x) => x.v === 0).map((x) => x.k);
  const summary = parts.map((x) => `${x.k} ${x.v}`).join(' / ');

  // 关键归属字段缺失（空着不报错，只会在开单时发现「选不到人」）
  const noDept = cnt("SELECT COUNT(*) c FROM employees WHERE status = 'active' AND (department_id IS NULL OR department_id = 0)");
  const noCode = cnt("SELECT COUNT(*) c FROM customers WHERE code IS NULL OR code = ''");
  const gaps = [];
  if (noDept > 0) gaps.push(`${noDept} 名员工无部门`);
  if (noCode > 0) gaps.push(`${noCode} 个客户无编码`);

  if (empty.length) {
    return { status: 'fail', result: `${summary}；以下档案为空：${empty.join('、')} —— 开单时会「选不到」` };
  }
  if (gaps.length) return { status: 'warn', result: `${summary}；${gaps.join('、')}` };
  return { status: 'pass', result: `${summary}，关键归属字段无缺失` };
};

CHECKS.schema_sync = () => {
  const f = path.resolve(__dirname, '../schema.js');
  const src = fs.readFileSync(f, 'utf8');
  const names = new Set();
  // schema.js 里的 SQL 是 JSON 字符串数组，带引号的表名会变成 \\"gl_periods\\"。
  // 正则必须容忍这个反斜杠 —— 漏掉它就会把 4 张总账表误判成「快照里没有」，
  // 而真相是反向的：快照里其实没有它们，交付包建库会缺表（第一次跑就撞上了）。
  const re = /CREATE TABLE IF NOT EXISTS\s*\\?"?([a-z_0-9]+)"?/gi;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  const actual = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)
  );
  const missing = [...names].filter((n) => !actual.has(n));
  const extra = [...actual].filter((n) => !names.has(n));
  if (!missing.length && !extra.length) {
    return { status: 'pass', result: `schema.js ${names.size} 张表与运行库完全一致` };
  }
  // 两边不一致都算不通过：交付包就是靠 schema.js 建库的。
  // 「库里有、快照没有」= 快照过期，客户装出来缺这几张表；
  // 「快照有、库里没有」= 迁移没跑，当前实例本身缺表。两种都会在某个页面点开时炸。
  const bits = [];
  if (missing.length) bits.push(`快照有、库里没有 ${missing.length} 张（${missing.slice(0, 6).join('、')}${missing.length > 6 ? '…' : ''}）—— 迁移没跑`);
  if (extra.length) bits.push(`库里有、快照没有 ${extra.length} 张（${extra.slice(0, 6).join('、')}${extra.length > 6 ? '…' : ''}）—— 快照过期，交付包会缺这些表`);
  return { status: 'fail', result: bits.join('；') + '。执行 node scripts/rebuild-schema.js 刷新快照' };
};

CHECKS.default_pwd = () => {
  const WEAK = ['admin123456', '123456'];
  const users = db.prepare('SELECT username, role, password_hash FROM users WHERE active = 1').all();
  const hit = [];
  users.forEach((u) => {
    if (!u.password_hash) return;
    // 用系统自己的校验函数，不另写一套哈希比对
    for (const w of WEAK) {
      let okPwd = false;
      try { okPwd = verifyPassword(w, u.password_hash); } catch (e) { okPwd = false; }
      if (okPwd) { hit.push(`${u.username}(${w})`); break; }
    }
  });
  if (hit.length) {
    const brief = hit.slice(0, 3).join('、') + (hit.length > 3 ? ` 等 ${hit.length} 个` : '');
    return { status: 'fail', result: `${hit.length} / ${users.length} 个在用账号仍是弱密码：${brief}。请逐个改密（系统设置 → 账号管理）` };
  }
  return { status: 'pass', result: `${users.length} 个在用账号逐一试过 ${WEAK.join(' / ')}，均不匹配` };
};

CHECKS.users_bound = () => {
  const rows = db.prepare("SELECT username, role FROM users WHERE active = 1 AND (employee_id IS NULL OR employee_id = 0)").all();
  const total = db.prepare('SELECT COUNT(*) c FROM users WHERE active = 1').get().c;
  const admin = rows.filter((r) => r.role === 'admin');
  const others = rows.filter((r) => r.role !== 'admin');
  if (!others.length && !admin.length) return { status: 'pass', result: `${total} 个在用账号全部绑定了员工` };
  if (!others.length) {
    return { status: 'warn', result: `仅管理员账号未绑员工（${admin.map((r) => r.username).join('、')}），业务岗位均已绑定` };
  }
  const names = others.map((r) => `${r.username}(${r.role})`);
  const brief = names.slice(0, 3).join('、') + (names.length > 3 ? ` 等 ${names.length} 个` : '');
  return { status: 'fail', result: `${others.length} / ${total} 个业务账号未绑员工：${brief}` };
};

/**
 * 在用账号的公司主体归属
 *
 * 与 `users_bound`（绑员工）分开查：这两件事坏在不同的地方 ——
 * 不绑员工导致"工资/考勤归不到人"，不绑主体导致"范围判不出来"（越权或全拒）。
 * 合成一条会互相掩盖（"都绑了员工"却全都没主体，一眼看不出）。
 *
 * 单公司模式下**降级为 warn**：这时范围隔离整个关闭，空主体不影响使用，
 * 只是一颗定时炸弹（切回多主体那天集体失效）。上线清单是为了"能上"，
 * 不能因为一个当前不生效的隐患把发布卡死 —— 但必须让它出现在清单里。
 */
CHECKS.users_scoped = () => {
  const total = db.prepare('SELECT COUNT(*) c FROM users WHERE COALESCE(active,1)=1').get().c;
  const rows = db.prepare(
    'SELECT username, role FROM users WHERE COALESCE(active,1)=1 AND (company_id IS NULL OR company_id = 0) ORDER BY id'
  ).all();
  const single = !!require('../config').singleCompany;
  if (!rows.length) return { status: 'pass', result: `${total} 个在用账号都有公司主体归属` };
  const names = rows.map((r) => `${r.username}(${r.role})`);
  const brief = names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 个` : '');
  if (single) {
    return {
      status: 'warn',
      result: `${rows.length} / ${total} 个在用账号没有公司主体：${brief}。当前是单公司模式（不影响使用），`
        + '但切回多主体（SINGLE_COMPANY=0）时这些账号会被直接拒绝访问，建议现在就补齐'
    };
  }
  return { status: 'fail', result: `${rows.length} / ${total} 个在用账号没有公司主体：${brief} —— 这类账号的数据范围无法判定，会被拒绝访问` };
};

CHECKS.perm_orphan = () => {
  const P = require('../access/permissions');
  const perms = P.PERMS || {};
  const guarded = P.GUARDED || [];
  const used = new Set(guarded.map((g) => g.perm).filter(Boolean));
  const unknown = [...used].filter((k) => !perms[k]);
  if (unknown.length) {
    return { status: 'fail', result: `拦截规则引用了 ${unknown.length} 个未定义的权限点：${unknown.join('、')} —— 这些规则永远不生效` };
  }
  return { status: 'pass', result: `拦截规则引用 ${used.size} 个权限点，全部在 ${Object.keys(perms).length} 项权限表内` };
};

CHECKS.backup_recent = () => {
  const since = shiftDays(-7);
  const r = db.prepare(`SELECT COUNT(*) c, MAX(created_at) last FROM backup_jobs
    WHERE kind <> 'restore' AND verify_status = 'ok' AND substr(created_at,1,10) >= ?`).get(since);
  if (r.c > 0) return { status: 'pass', result: `近 7 天 ${r.c} 次成功备份，最近一次 ${String(r.last || '').slice(0, 19).replace('T', ' ')}` };
  const any = db.prepare("SELECT COUNT(*) c, MAX(created_at) last FROM backup_jobs WHERE kind <> 'restore'").get();
  if (!any.c) return { status: 'fail', result: '从未做过备份 —— 上线前必须先备份一次并校验' };
  return { status: 'fail', result: `近 7 天没有成功备份；上一次备份是 ${String(any.last || '').slice(0, 10)}` };
};

CHECKS.backup_file_exists = () => {
  const r = db.prepare(`SELECT job_no, file_path, size_bytes, created_at FROM backup_jobs
    WHERE kind <> 'restore' AND file_path IS NOT NULL ORDER BY id DESC LIMIT 1`).get();
  if (!r) return { status: 'fail', result: '没有可核对文件路径的备份记录' };
  if (!fs.existsSync(r.file_path)) {
    return { status: 'fail', result: `${r.job_no} 记录成功，但文件已不存在：${r.file_path}（记录真实、文件不在，是最容易漏的一种）` };
  }
  const size = fs.statSync(r.file_path).size;
  if (r.size_bytes && Math.abs(size - r.size_bytes) > 1024) {
    return { status: 'warn', result: `${r.job_no} 文件大小与记录不符（记录 ${r.size_bytes} / 实际 ${size} 字节）` };
  }
  return { status: 'pass', result: `${r.job_no} 文件存在，${(size / 1048576).toFixed(1)} MB，与记录一致` };
};

CHECKS.restore_drill = () => {
  const r = db.prepare(`SELECT COUNT(*) c, MAX(created_at) last FROM backup_jobs WHERE kind = 'restore' OR restore_status = 'applied'`).get();
  if (!r.c) return { status: 'fail', result: '没有恢复演练记录 —— 没恢复过的备份只算「一份希望」' };
  return { status: 'pass', result: `${r.c} 次恢复记录，最近一次 ${String(r.last || '').slice(0, 10)}` };
};

CHECKS.gl_balance = () => {
  const orphan = db.prepare(`SELECT COUNT(*) c FROM gl_entries e
    WHERE NOT EXISTS (SELECT 1 FROM gl_vouchers v WHERE v.id = e.voucher_id)`).get().c;
  const r = db.prepare(`SELECT ROUND(SUM(e.debit),2) d, ROUND(SUM(e.credit),2) c, COUNT(*) n
    FROM gl_entries e JOIN gl_vouchers v ON v.id = e.voucher_id WHERE v.status = 'posted'`).get();
  const diff = round2(num(r.d) - num(r.c));
  if (!r.n) return { status: 'warn', result: '尚无已过账凭证 —— 上线后首月结账才是真正的检验' };
  if (orphan) return { status: 'fail', result: `${orphan} 条分录指向不存在的凭证；借贷差 ${money(diff)}` };
  if (Math.abs(diff) > 0.01) {
    return { status: 'fail', result: `借贷不平：借方 ${money(r.d)} / 贷方 ${money(r.c)}，差 ${money(diff)}（${r.n} 条分录）` };
  }
  return { status: 'pass', result: `借贷平衡：${money(r.d)} = ${money(r.c)}（${r.n} 条分录、已过账凭证）` };
};

CHECKS.period_closed = () => {
  const d = new Date();
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const period = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const rows = db.prepare('SELECT company_id, status FROM gl_periods WHERE period = ?').all(period);
  if (!rows.length) {
    return { status: 'warn', result: `上一期间 ${period} 未建财务期间 —— 上线后首月对账没有起点，建议先建期间并关账` };
  }
  const open = rows.filter((x) => x.status !== 'closed').length;
  if (open) {
    return { status: 'warn', result: `${period} 有 ${open} / ${rows.length} 个主体未关账 —— 上线后业务会与历史混在同一期间` };
  }
  return { status: 'pass', result: `${period} 全部 ${rows.length} 个主体已关账` };
};

CHECKS.health = () => {
  const t0 = Date.now();
  db.prepare('SELECT 1 AS x').get();
  const ms = Date.now() - t0;
  // 数据目录可写探测：只读挂载/磁盘满都会表现为「页面能开、保存没反应」
  const dataDir = path.resolve(__dirname, '../../data');
  const writable = probeWritable(dataDir);
  const up = Math.floor(process.uptime());
  const hh = Math.floor(up / 3600);
  const mm = Math.floor((up % 3600) / 60);
  if (!writable) {
    return { status: 'fail', result: `数据库读 ${ms}ms 正常，但数据目录不可写（${dataDir}）—— 保存会失败` };
  }
  return { status: 'pass', result: `数据库读 ${ms}ms、数据目录可写；进程已运行 ${hh} 小时 ${mm} 分` };
};

CHECKS.secret_changed = () => {
  const s = String(config.jwtSecret || '');
  const DEFAULT = 'dev_only_insecure_secret_change_me';
  if (!s || s === DEFAULT) {
    return { status: 'fail', result: 'JWT 密钥仍是示例值 —— 任何人都能自己签发管理员 token' };
  }
  if (s.length < 32) {
    return { status: 'fail', result: `JWT 密钥长度仅 ${s.length} 位，建议 32 位以上随机串（openssl rand -hex 32）` };
  }
  return { status: 'pass', result: `JWT 密钥非默认值，长度 ${s.length} 位` };
};

CHECKS.env_mode = () => {
  const issues = config.securityAudit();
  const fatal = issues.filter((i) => i.level === 'fatal');
  const notProd = !config.isProd;
  const cors = String(config.corsOrigin || '');
  const bits = [];
  if (notProd) bits.push('NODE_ENV 不是 production（启动自检只会提示，不会拦）');
  if (!cors || cors === '*') bits.push('CORS_ORIGIN 为 *（任何站点都能带 token 调接口）');
  fatal.forEach((i) => { if (i.key !== 'NODE_ENV' && i.key !== 'CORS_ORIGIN') bits.push(i.msg); });
  if (bits.length) return { status: 'fail', result: bits.join('；') };
  return { status: 'pass', result: `production 模式；CORS 限定 ${cors}；环境变量密钥与口令均已替换` };
};

CHECKS.upload_writable = () => {  let dir = null;
  try { dir = require('../routes/uploads').UPLOAD_DIR; } catch (e) { dir = path.resolve(__dirname, '../../data/uploads'); }
  if (!fs.existsSync(dir)) return { status: 'fail', result: `上传目录不存在：${dir}` };
  const writable = probeWritable(dir);
  if (!writable) return { status: 'fail', result: `上传目录不可写：${dir} —— 上传按钮会一直转圈` };
  const walk = (p) => {
    let n = 0;
    try {
      fs.readdirSync(p, { withFileTypes: true }).forEach((e) => {
        if (e.isDirectory()) n += walk(path.join(p, e.name));
        else n += 1;
      });
    } catch (err) { /* 忽略不可读子目录 */ }
    return n;
  };
  return { status: 'pass', result: `上传目录可写，现有 ${walk(dir)} 个文件（迁移时用来核对有没有漏拷）` };
};

// ============================================================
// 评估：生成 / 刷新
// ============================================================
const SECTION_ORDER = (s) => (SECTIONS[s] ? SECTIONS[s].order : 99);

/**
 * 目录可写探测（两处检查共用一份实现）
 *
 * 原来的写法两边各抄一遍：`writeFileSync` + `unlinkSync` 都放在同一个 try 里。
 * 于是 **删不掉也会被判成"不可写"**（Windows 上刚写的文件常被杀毒/索引短暂占用），
 * 检查报"数据目录不可写 —— 保存会失败"，而实际上目录好好的；
 * 同时每次探测留下一个 2 字节的 `.golive-probe-*`，跑几十次就是几十个垃圾文件。
 *
 * 现在：**写成功即证明可写**；删除失败只留垃圾，不改变结论；顺手清掉 1 小时前的旧探针。
 */
function probeWritable(dir) {
  const prefix = '.golive-probe-';
  try {
    // 先清历史残留（自己留下的，不是用户文件）
    fs.readdirSync(dir).forEach((f) => {
      if (!f.startsWith(prefix)) return;
      try {
        const st = fs.statSync(path.join(dir, f));
        if (Date.now() - st.mtimeMs > 3600 * 1000) fs.unlinkSync(path.join(dir, f));
      } catch (e) { /* 删不掉就下次再删 */ }
    });
  } catch (e) { /* 目录读不了，交给下面的写探测判 */ }

  const probe = path.join(dir, prefix + Date.now());
  try {
    fs.writeFileSync(probe, 'ok');
  } catch (e) {
    return false;      // 写不进去 = 真的不可写
  }
  try { fs.unlinkSync(probe); } catch (e) { /* 删不掉不影响"可写"这个结论 */ }
  return true;
}

function runAutoItems(round, items) {
  return items.map((it) => {
    if (it.kind !== 'auto') return it;
    const fn = CHECKS[it.auto_check];
    if (!fn) {
      // 检查器缺失不许当通过：一个跑不动的检查比没通过更危险
      return { ...it, status: 'fail', result: `检查器 ${it.auto_check} 不存在，无法验证` };
    }
    try {
      const r = fn(round) || {};
      return { ...it, status: r.status || 'fail', result: r.result || '（检查器未返回结论）' };
    } catch (e) {
      return { ...it, status: 'fail', result: `检查器异常：${e.message}` };
    }
  });
}

/** 汇总：阻塞项、自动/人工计数、轮次状态 */
function summarize(round, items) {
  const auto = items.filter((x) => x.kind === 'auto');
  const manual = items.filter((x) => x.kind === 'manual');
  const pass = auto.filter((x) => x.status === 'pass').length;
  const fail = auto.filter((x) => x.status === 'fail').length;
  const warn = auto.filter((x) => x.status === 'warn').length;
  const na = items.filter((x) => x.status === 'na').length;
  const done = manual.filter((x) => ['pass', 'fail', 'na'].includes(x.status)).length;

  // 阻塞项：auto 的 fail、manual 的 fail 或 pending（还没验就是没通过）
  const blockerOpen = items.filter(
    (x) => x.severity === 'blocker' && ['fail', 'pending', 'warn'].includes(x.status) && x.status !== 'na'
  ).length;

  let status = 'draft';
  if (round.status === 'signed' || round.status === 'withdrawn') status = round.status;
  else if (blockerOpen > 0) status = 'blocked';
  else if (done === manual.length) status = 'ready';

  return {
    auto_total: auto.length, auto_pass: pass, auto_fail: fail, auto_warn: warn,
    manual_total: manual.length, manual_done: done, na_total: na, blocker_open: blockerOpen,
    status
  };
}

function buildRound(b = {}, actor) {
  const scope = ['production', 'demo'].includes(b.scope) ? b.scope : 'production';
  const t = now();
  const roundNo = nextNo('GL', 'golive_rounds', 'round_no');
  const planDate = str(b.plan_date) || today();

  const round = {
    round_no: roundNo, scope, env_label: str(b.env_label) || '生产',
    plan_date: planDate, app_version: str(b.app_version) || null, status: 'draft'
  };

  // 先跑检查，再落库 —— 检查器要读 round.scope 决定演示数据算不算阻塞
  const evaluated = runAutoItems(round, ITEMS.map((x, i) => ({
    section: x.section, item_key: x.key, title: x.title, detail: x.detail, how: x.how,
    kind: x.kind, auto_check: x.check || null, severity: x.severity,
    status: x.kind === 'auto' ? 'pending' : 'pending', sort: i + 1
  })));
  const sum = summarize(round, evaluated);

  const info = db.prepare(`INSERT INTO golive_rounds (round_no, scope, env_label, plan_date, app_version, status,
      auto_total, auto_pass, auto_fail, auto_warn, manual_total, manual_done, na_total, blocker_open,
      created_by, created_at, updated_at, last_refresh_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    roundNo, scope, round.env_label, planDate, round.app_version, sum.status,
    sum.auto_total, sum.auto_pass, sum.auto_fail, sum.auto_warn,
    sum.manual_total, sum.manual_done, sum.na_total, sum.blocker_open,
    actor || 'system', t, t, t
  );
  const id = Number(info.lastInsertRowid);

  const ins = db.prepare(`INSERT INTO golive_items (round_id, section, item_key, title, detail, how,
      kind, auto_check, severity, status, result, sort, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  evaluated.forEach((x) => {
    ins.run(id, x.section, x.item_key, x.title, x.detail, x.how, x.kind, x.auto_check,
      x.severity, x.status, x.result || null, x.sort, t);
  });

  return detail(id);
}

function listRounds(q = {}) {
  const where = [];
  const args = [];
  if (q.status) { where.push('status = ?'); args.push(q.status); }
  if (q.scope) { where.push('scope = ?'); args.push(q.scope); }
  const rows = db.prepare(`SELECT * FROM golive_rounds ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT 50`).all(...args);
  return rows.map((r) => ({
    ...r,
    scope_label: r.scope === 'demo' ? '演示库交付' : '正式上线',
    status_label: { draft: '评估中', blocked: '有阻塞', ready: '可签署', signed: '已签署', withdrawn: '已撤回' }[r.status] || r.status,
    conclusion_label: r.conclusion ? CONCLUSION[r.conclusion] : null,
    auto_rate: r.auto_total ? Math.round(((r.auto_pass + r.auto_warn) / r.auto_total) * 100) : 0
  }));
}

function detail(id) {
  const r = db.prepare('SELECT * FROM golive_rounds WHERE id = ?').get(id);
  if (!r) return null;
  const items = db.prepare('SELECT * FROM golive_items WHERE round_id = ? ORDER BY sort').all(id);
  const sections = Object.keys(SECTIONS).sort((a, b) => SECTION_ORDER(a) - SECTION_ORDER(b)).map((k) => {
    const list = items.filter((x) => x.section === k);
    const blocked = list.filter((x) => x.severity === 'blocker' && ['fail', 'pending', 'warn'].includes(x.status)).length;
    const done = list.filter((x) => ['pass', 'fail', 'na'].includes(x.status)).length;
    return {
      key: k,
      label: SECTIONS[k].label,
      note: SECTIONS[k].note,
      total: list.length,
      done,
      blocked,
      items: list.map((x) => ({
        ...x,
        severity_label: SEVERITY[x.severity] ? SEVERITY[x.severity].label : x.severity,
        status_label: STATUS[x.status] ? STATUS[x.status].label : x.status,
        kind_label: x.kind === 'auto' ? '自动' : '人工',
        is_blocker_open: x.severity === 'blocker' && ['fail', 'pending', 'warn'].includes(x.status)
      }))
    };
  });
  const canSign = !['signed', 'withdrawn'].includes(r.status);
  return {
    ...r,
    scope_label: r.scope === 'demo' ? '演示库交付' : '正式上线',
    status_label: { draft: '评估中', blocked: '有阻塞', ready: '可签署', signed: '已签署', withdrawn: '已撤回' }[r.status] || r.status,
    conclusion_label: r.conclusion ? CONCLUSION[r.conclusion] : null,
    snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
    sections,
    can_sign: canSign,
    can_refresh: !['signed', 'withdrawn'].includes(r.status),
    open_blockers: items.filter((x) => x.severity === 'blocker' && ['fail', 'pending', 'warn'].includes(x.status))
      .map((x) => ({ item_key: x.item_key, title: x.title, status: x.status, result: x.result }))
  };
}

/** 重跑自动项。人工项一律保留 —— 人已经验过的不能被一次刷新抹掉 */
function refresh(id, actor) {
  const r = db.prepare('SELECT * FROM golive_rounds WHERE id = ?').get(id);
  if (!r) throw bad('评估轮次不存在', 404);
  if (r.status === 'signed') throw bad('已签署的评估不能再刷新（结论要冻结）。要重验请先撤回，并写明撤回理由', 400);
  if (r.status === 'withdrawn') throw bad('已撤回的评估不再刷新，请新建一轮', 400);

  const items = db.prepare('SELECT * FROM golive_items WHERE round_id = ? ORDER BY sort').all(id);
  const before = items.filter((x) => x.kind === 'auto').map((x) => ({ k: x.item_key, s: x.status }));
  const evaluated = runAutoItems(r, items);
  const changes = [];
  const t = now();
  const upd = db.prepare("UPDATE golive_items SET status = ?, result = ?, updated_at = ? WHERE id = ?");
  evaluated.forEach((x) => {
    if (x.kind !== 'auto') return;
    const old = before.find((y) => y.k === x.item_key);
    if (old && old.s !== x.status) changes.push({ item_key: x.item_key, from: old.s, to: x.status, result: x.result });
    upd.run(x.status, x.result || null, t, x.id);
  });

  const sum = summarize(r, evaluated);
  db.prepare(`UPDATE golive_rounds SET status = ?, auto_pass = ?, auto_fail = ?, auto_warn = ?,
      manual_done = ?, na_total = ?, blocker_open = ?, last_refresh_at = ?, updated_at = ? WHERE id = ?`).run(
    sum.status, sum.auto_pass, sum.auto_fail, sum.auto_warn, sum.manual_done, sum.na_total, sum.blocker_open, t, t, id
  );
  return { ...detail(id), refresh_changes: changes };
}

/**
 * 人工项判定
 *
 * 自动项**不许**用这个接口改 —— 否则清单就变成橡皮章：
 * 一个不通过的检查被点两下变成通过，签字的人看到的是绿色。
 */
function setManual(itemId, b, actor) {
  const it = db.prepare('SELECT * FROM golive_items WHERE id = ?').get(itemId);
  if (!it) throw bad('清单项不存在', 404);
  const r = db.prepare('SELECT * FROM golive_rounds WHERE id = ?').get(it.round_id);
  if (!r) throw bad('评估轮次不存在', 404);
  if (r.status === 'signed') throw bad('已签署的评估不能再改（结论要冻结）。要修改请先撤回', 400);
  if (it.kind === 'auto') {
    throw bad('这是自动检查项，不能人工改动 —— 自动项只能由检查器重跑得出（点「重跑自动检查」）', 400);
  }

  const status = str(b.status);
  if (!['pass', 'fail', 'na', 'pending'].includes(status)) throw bad('状态只能是 通过 / 不通过 / 不适用 / 待处理');
  const evidence = str(b.evidence);
  const naReason = str(b.na_reason);
  const result = str(b.result);

  if (status === 'pass' && !evidence) {
    throw bad('判「通过」必须写证据（签字单号 / 文件路径 / 会议纪要），否则这条通过无法复核');
  }
  if (status === 'na' && naReason.length < 6) {
    throw bad('判「不适用」必须写清理由（至少 6 字）—— 否则清单会被「不适用」填满，看起来全绿实际没验');
  }

  const t = now();
  const nextStatus = status === 'pending' ? 'pending' : status;
  db.prepare(`UPDATE golive_items SET status = ?, result = COALESCE(?, result), evidence = COALESCE(?, evidence),
      na_reason = ?, owner = COALESCE(?, owner), done_by = ?, done_at = ?, note = COALESCE(?, note), updated_at = ?
    WHERE id = ?`).run(
    nextStatus, result || null, evidence || null, naReason || null, str(b.owner) || null,
    actor || 'system', nextStatus === 'pending' ? null : t, str(b.note) || null, t, itemId
  );

  const items = db.prepare('SELECT * FROM golive_items WHERE round_id = ? ORDER BY sort').all(it.round_id);
  const sum = summarize(r, items);
  db.prepare('UPDATE golive_rounds SET status = ?, manual_done = ?, na_total = ?, blocker_open = ?, updated_at = ? WHERE id = ?')
    .run(sum.status, sum.manual_done, sum.na_total, sum.blocker_open, t, it.round_id);
  return detail(it.round_id);
}

/** 人工项批量确认「责任人与计划」—— 不改状态，只认领 */
function assign(itemId, b) {
  const it = db.prepare('SELECT * FROM golive_items WHERE id = ?').get(itemId);
  if (!it) throw bad('清单项不存在', 404);
  db.prepare('UPDATE golive_items SET owner = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?')
    .run(str(b.owner), str(b.note) || null, now(), itemId);
  return detail(it.round_id);
}

/**
 * 签署：冻结结论
 *
 * 阻塞项没过只能签「暂不上线」。允许签 no_go 是故意的 ——
 * 「决定不上线」本身是个正当结论，不该被系统拦住，否则人会绕过系统去微信里说。
 */
function sign(id, b, actor) {
  const r = db.prepare('SELECT * FROM golive_rounds WHERE id = ?').get(id);
  if (!r) throw bad('评估轮次不存在', 404);
  if (r.status === 'signed') throw bad('这一轮已经签署过', 400);
  if (r.status === 'withdrawn') throw bad('已撤回的评估不能再签署，请新建一轮', 400);

  const conclusion = str(b.conclusion);
  if (!Object.keys(CONCLUSION).includes(conclusion)) throw bad('结论只能是 go / conditional / no_go');
  const note = str(b.note);
  if (conclusion !== 'go' && note.length < 6) {
    throw bad('「有条件上线」与「暂不上线」必须写清遗留项或原因（至少 6 字）');
  }

  const items = db.prepare('SELECT * FROM golive_items WHERE round_id = ? ORDER BY sort').all(id);
  const openBlockers = items.filter((x) => x.severity === 'blocker' && ['fail', 'pending', 'warn'].includes(x.status));
  if (conclusion !== 'no_go' && openBlockers.length) {
    throw bad(`还有 ${openBlockers.length} 个阻塞项未通过：${openBlockers.map((x) => x.title).join('、')} —— 只能签「暂不上线」`, 400);
  }

  const t = now();
  // 冻结：把当前全部项与关键指标写进 snapshot，之后改库不影响这一轮结论
  const snapshot = {
    frozen_at: t,
    round: {
      round_no: r.round_no, scope: r.scope, env_label: r.env_label,
      plan_date: r.plan_date, app_version: r.app_version
    },
    conclusion,
    counts: {
      auto: items.filter((x) => x.kind === 'auto').length,
      pass: items.filter((x) => x.status === 'pass').length,
      fail: items.filter((x) => x.status === 'fail').length,
      warn: items.filter((x) => x.status === 'warn').length,
      na: items.filter((x) => x.status === 'na').length,
      pending: items.filter((x) => x.status === 'pending').length
    },
    items: items.map((x) => ({
      section: x.section, item_key: x.item_key, title: x.title, kind: x.kind,
      severity: x.severity, status: x.status, result: x.result,
      evidence: x.evidence, done_by: x.done_by, done_at: x.done_at, na_reason: x.na_reason
    }))
  };

  db.prepare(`UPDATE golive_rounds SET status = 'signed', conclusion = ?, sign_note = ?, signed_by = ?,
      signed_at = ?, snapshot = ?, updated_at = ? WHERE id = ?`).run(
    conclusion, note || null, actor || 'system', t, JSON.stringify(snapshot), t, id
  );
  return detail(id);
}

function withdraw(id, b, actor) {
  const r = db.prepare('SELECT * FROM golive_rounds WHERE id = ?').get(id);
  if (!r) throw bad('评估轮次不存在', 404);
  if (r.status !== 'signed') throw bad('只有已签署的评估才能撤回', 400);
  const reason = str(b.reason);
  if (reason.length < 6) throw bad('撤回必须写清原因（至少 6 字）—— 否则「签了又撤」没有任何线索');
  const t = now();
  db.prepare(`UPDATE golive_rounds SET status = 'withdrawn', withdrawn_reason = ?, updated_at = ? WHERE id = ?`)
    .run(reason, t, id);
  return detail(id);
}

function dict() {
  return {
    sections: Object.keys(SECTIONS).sort((a, b) => SECTION_ORDER(a) - SECTION_ORDER(b))
      .map((k) => ({ key: k, label: SECTIONS[k].label, note: SECTIONS[k].note, order: SECTIONS[k].order })),
    severities: Object.keys(SEVERITY).map((k) => ({ key: k, ...SEVERITY[k] })),
    statuses: Object.keys(STATUS).map((k) => ({ key: k, ...STATUS[k] })),
    conclusions: Object.keys(CONCLUSION).map((k) => ({ key: k, label: CONCLUSION[k] })),
    scopes: [{ key: 'production', label: '正式上线' }, { key: 'demo', label: '演示库交付' }],
    item_count: ITEMS.length,
    auto_count: ITEMS.filter((x) => x.kind === 'auto').length,
    manual_count: ITEMS.filter((x) => x.kind === 'manual').length,
    template: ITEMS.map((x, i) => ({
      item_key: x.key, section: x.section, title: x.title, kind: x.kind, severity: x.severity, sort: i + 1
    }))
  };
}

/** 概览：最近一轮的情况 + 历史上线节奏 */
function stats() {
  const last = db.prepare('SELECT * FROM golive_rounds ORDER BY id DESC LIMIT 1').get();
  const total = db.prepare('SELECT COUNT(*) c FROM golive_rounds').get().c;
  const signed = db.prepare("SELECT COUNT(*) c FROM golive_rounds WHERE status = 'signed'").get().c;
  const go = db.prepare("SELECT COUNT(*) c FROM golive_rounds WHERE conclusion = 'go'").get().c;
  const noGo = db.prepare("SELECT COUNT(*) c FROM golive_rounds WHERE conclusion = 'no_go'").get().c;
  return {
    total, signed, go, no_go: noGo,
    last: last ? {
      id: last.id, round_no: last.round_no, status: last.status, conclusion: last.conclusion,
      blocker_open: last.blocker_open, auto_pass: last.auto_pass, auto_total: last.auto_total,
      manual_done: last.manual_done, manual_total: last.manual_total,
      plan_date: last.plan_date, signed_at: last.signed_at, last_refresh_at: last.last_refresh_at
    } : null
  };
}

module.exports = {
  SECTIONS, SEVERITY, STATUS, CONCLUSION, ITEMS, CHECKS,
  dict, stats, buildRound, listRounds, detail, refresh, setManual, assign, sign, withdraw
};
