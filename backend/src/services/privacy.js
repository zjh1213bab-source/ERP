/**
 * 字段级脱敏与访问审计（TS-N18-03 / TS-N18-09）
 * ========================================================================
 * 这个模块只做一件事：**让服务端返回的数据本身就是掩码的**。
 *
 * 前端打码不算数 —— 打开开发者工具照样能看到，导出更是直接带走。
 * 所以掩码必须发生在「响应还没离开服务端」的时候。
 *
 * ## 判定用的是「角色基础权限」，不是 `hasPerm`
 *
 * 这是全篇最容易做错的一处：
 *
 *   `access.hasPerm()` 里写着 `if (eff.isAdmin) return true;` —— admin 恒通过。
 *   如果脱敏层直接调它，**管理员就默认可读全公司工资**，等于白做。
 *
 * 原型明确要求「管理员技术权限不默认可读工资」。所以这里用 `eff.base`
 * （角色本身配置的权限点）判定：admin 的 base 里没有 `payroll.sensitive`，
 * 就是看不到。
 *
 * admin 想看怎么办？走 `reveal()`：一次一条、必须写理由、每次都留痕。
 * 这条通路不是漏洞 —— 运维排障确实需要，但需要留下痕迹。
 *
 * ## 四种出口
 *
 *   接口返回（maskRows）· 导出（markExport）· 缓存（只缓存掩码后的值）· AI（只喂掩码后的值）
 *
 * 本期落地前两个；后两个靠「脱敏后的值才进缓存/提示词」这条约束保证。
 */
const { db } = require('../db');
const access = require('./access');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/** 表 → 用来标识「看的是谁」的字段 */
const LABEL_FIELD = {
  employees: 'name',
  customers: 'name',
  suppliers: 'name',
  payrolls: 'employee_name',
  bank_accounts: 'bank_name',
  admin_contracts: 'name'
};

/* ==================================================================== *
 * 一、规则
 * ==================================================================== */

let cache = null;

function rules(table) {
  if (!cache) {
    cache = db.prepare('SELECT * FROM field_guards ORDER BY table_name, id').all();
  }
  const list = table ? cache.filter((r) => r.table_name === table) : cache;
  return list;
}

function reload() {
  cache = null;
  return rules();
}

function ruleOf(table, field) {
  return rules(table).find((r) => r.field_name === field) || null;
}

function listRules() {
  const rows = rules();
  const byTable = {};
  rows.forEach((r) => {
    byTable[r.table_name] = byTable[r.table_name] || { table_name: r.table_name, fields: [] };
    byTable[r.table_name].fields.push({
      id: r.id,
      field_name: r.field_name,
      label: r.label,
      mask_type: r.mask_type,
      keep_prefix: r.keep_prefix,
      keep_suffix: r.keep_suffix,
      required_perm: r.required_perm,
      log_access: !!r.log_access,
      require_reason: !!r.require_reason,
      category: r.category,
      enabled: !!r.enabled,
      note: r.note
    });
  });
  return Object.values(byTable);
}

/** 改规则：脱敏方式与所需权限点可调，但「高敏字段必须留痕」不让关 */
function saveRule(id, opt = {}) {
  const r = db.prepare('SELECT * FROM field_guards WHERE id = ?').get(id);
  if (!r) throw bad('规则不存在', 404);
  const maskType = ['partial', 'hide'].includes(opt.mask_type) ? opt.mask_type : r.mask_type;
  const pre = opt.keep_prefix === undefined ? r.keep_prefix : Math.max(0, Math.min(20, Number(opt.keep_prefix) || 0));
  const suf = opt.keep_suffix === undefined ? r.keep_suffix : Math.max(0, Math.min(20, Number(opt.keep_suffix) || 0));
  const perm = String(opt.required_perm || r.required_perm).trim();
  if (!perm) throw bad('必须指定「看明文需要的权限点」');
  // 高敏分类（工资/银行/合同）不允许关留痕 —— 关掉等于给「悄悄看」开后门
  let logAccess = opt.log_access === undefined ? r.log_access : (opt.log_access ? 1 : 0);
  if (['payroll', 'bank', 'contract'].includes(r.category)) logAccess = 1;
  const enabled = opt.enabled === undefined ? r.enabled : (opt.enabled ? 1 : 0);
  db.prepare(
    `UPDATE field_guards SET mask_type=?, keep_prefix=?, keep_suffix=?, required_perm=?, log_access=?,
       require_reason=IFNULL(?, require_reason), enabled=?, note=IFNULL(?, note), updated_at=? WHERE id=?`
  ).run(maskType, pre, suf, perm, logAccess,
    opt.require_reason === undefined ? null : (opt.require_reason ? 1 : 0),
    enabled, opt.note || null, new Date().toISOString(), id);
  reload();
  return listRules();
}

/* ==================================================================== *
 * 二、判定与掩码
 * ==================================================================== */

/**
 * 能否看到明文
 *
 * **不看 hasPerm**（admin 恒通过），看角色基础权限。
 * 这条是「管理员技术权限不默认可读工资」的唯一实现点。
 */
function canSee(user, rule) {
  if (!user) return false;
  const uid = user.sub != null ? user.sub : user.id;
  let eff;
  try {
    eff = access.effective(uid, user.role);
  } catch (e) {
    return false;   // 权限算不出来就按「看不到」处理，宁可少给
  }
  const perm = rule.required_perm;
  if (eff.isAdmin) {
    // 关键：admin 只认自己岗位配置里真实存在的权限点
    return (eff.base || []).includes(perm);
  }
  return (eff.perms || []).includes(perm);
}

/** 掩码一个值 */
function maskValue(v, rule) {
  if (v === null || v === undefined || v === '') return v;
  const s = String(v);
  if (rule.mask_type === 'hide') return '***';

  // 邮箱单独处理：保留域名（能判断是哪个服务商），本地部分留前几位
  if (s.includes('@')) {
    const [u, d] = s.split('@');
    const pre = rule.keep_prefix || 2;
    return `${u.slice(0, Math.min(pre, u.length))}***${d ? '@' + d : ''}`;
  }

  const pre = Math.max(0, Number(rule.keep_prefix) || 0);
  const suf = Math.max(0, Number(rule.keep_suffix) || 0);
  if (s.length <= pre + suf) return '***';
  const midLen = Math.min(8, s.length - pre - suf);
  const mid = '*'.repeat(midLen);
  return s.slice(0, pre) + mid + (suf ? s.slice(-suf) : '');
}

/* ==================================================================== *
 * 三、留痕
 * ==================================================================== */

function log(opt = {}) {
  db.prepare(
    `INSERT INTO sensitive_access_logs
       (username, user_name, role, table_name, field_name, target_id, target_label, action, granted, reason, row_count, ip, ua, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    opt.username || null, opt.user_name || null, opt.role || null,
    opt.table_name, opt.field_name || null, opt.target_id || null, opt.target_label || null,
    opt.action || 'list', opt.granted ? 1 : 0, opt.reason || null,
    opt.row_count || 1, opt.ip || null, opt.ua || null,
    new Date().toISOString()
  );
}

/* ==================================================================== *
 * 四、脱敏入口（路由里调这个）
 * ==================================================================== */

/**
 * 脱敏一批行
 *
 * @param {string} table    表名（与 field_guards.table_name 对齐）
 * @param {array}  rows     原始行
 * @param {object} ctx      { user, ip, ua, action }
 * @returns {array} 掩码后的行（原对象不改，返回浅拷贝）
 *
 * 留痕口径：**一次请求一条**，记「谁在什么时候看了几张表的哪几个字段」，
 * 不逐行写 —— 25 个员工逐行写就是 50 条日志，日志本身会变成噪音。
 */
function maskRows(table, rows, ctx = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  const guard = rules(table).filter((r) => r.enabled);
  if (!guard.length || !list.length) return rows;

  const user = ctx.user;
  const allowed = [];
  const denied = [];
  guard.forEach((r) => {
    if (canSee(user, r)) allowed.push(r);
    else denied.push(r);
  });

  const out = list.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const copy = { ...row };
    denied.forEach((r) => {
      if (r.field_name in copy) copy[r.field_name] = maskValue(copy[r.field_name], r);
    });
    return copy;
  });

  // 有权限看到明文的，记一条汇总日志（高敏字段才记）
  const toLog = allowed.filter((r) => r.log_access);
  if (toLog.length && user) {
    try {
      log({
        username: user.username, user_name: user.name, role: user.role,
        table_name: table,
        field_name: toLog.map((r) => r.field_name).join(','),
        action: ctx.action || 'list',
        granted: 1,
        row_count: list.length,
        ip: ctx.ip, ua: ctx.ua
      });
    } catch (e) { /* 留痕失败不能把查询打挂 */ }
  }

  return out;
}

/** 单行版本（详情接口用） */
function maskRow(table, row, ctx = {}) {
  if (!row) return row;
  const arr = maskRows(table, [row], ctx);
  return Array.isArray(arr) ? arr[0] : row;
}

/** 只脱敏指定字段（比如 join 出来的别名列） */
function maskFields(table, row, fields, ctx = {}) {
  if (!row) return row;
  const copy = { ...row };
  const user = ctx.user;
  fields.forEach((f) => {
    const r = ruleOf(table, f);
    if (r && r.enabled && !canSee(user, r) && f in copy) copy[f] = maskValue(copy[f], r);
  });
  return copy;
}

/**
 * 一次性查看明文（admin 或无权限者排障用）
 *
 * 三条硬约束：
 *   - 必须写理由（≥6 字）
 *   - 一次只查一条记录的字段，不做批量
 *   - **每次都留痕**，且 granted=0 与「有权限直接看」区分开
 */
function reveal(opt = {}) {
  const table = String(opt.table_name || opt.table || '').trim();
  const field = String(opt.field_name || opt.field || '').trim();
  const id = Number(opt.target_id);
  if (!table || !field || !id) throw bad('需要 table_name / field_name / target_id');

  const rule = ruleOf(table, field);
  if (!rule) throw bad(`字段 ${table}.${field} 没有脱敏规则（不需要脱敏的字段请直接查原接口）`, 404);
  if (!rule.enabled) throw bad('该字段当前未启用脱敏保护');

  const user = opt.user || {};
  const yes = canSee(user, rule);

  const colAllowed = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field);
  if (!colAllowed) throw bad('字段名不合法');
  const labelCol = LABEL_FIELD[table];
  const row = db
    .prepare(`SELECT ${field} AS v${labelCol ? ', ' + labelCol + ' AS l' : ''} FROM ${table} WHERE id = ?`)
    .get(id);
  if (!row) throw bad('记录不存在', 404);

  const reason = String(opt.reason || '').trim();
  if (!yes && rule.require_reason && reason.length < 6) {
    throw bad('查看敏感字段必须写理由（至少 6 个字）：这条会进审计日志');
  }

  log({
    username: user.username, user_name: user.name, role: user.role,
    table_name: table, field_name: field, target_id: id,
    target_label: row.l || null,
    action: 'reveal', granted: yes ? 1 : 0, reason: reason || null,
    ip: opt.ip, ua: opt.ua
  });

  return {
    table_name: table,
    field_name: field,
    label: rule.label,
    target_id: id,
    target_label: row.l || null,
    value: row.v,
    granted_by: yes ? 'perm' : 'reason',
    note: yes
      ? '你有该字段的查看权限，本次查看已记入审计日志'
      : '本次为「一次性查看」，已记入审计日志'
  };
}

/** 导出留痕（CSV 等） */
function markExport(table, fields, ctx = {}) {
  const user = ctx.user || {};
  const rulesOfTable = rules(table).filter((r) => r.enabled && fields.includes(r.field_name));
  if (!rulesOfTable.length) return;
  const toLog = rulesOfTable.filter((r) => r.log_access);
  if (!toLog.length) return;
  log({
    username: user.username, user_name: user.name, role: user.role,
    table_name: table,
    field_name: toLog.map((r) => r.field_name).join(','),
    action: 'export',
    granted: toLog.some((r) => canSee(user, r)) ? 1 : 0,
    row_count: ctx.row_count || 1,
    ip: ctx.ip, ua: ctx.ua,
    reason: ctx.note || null
  });
}

/* ==================================================================== *
 * 五、查询与统计
 * ==================================================================== */

function logs(q = {}) {
  const where = [];
  const args = [];
  if (q.table_name) { where.push('table_name = ?'); args.push(q.table_name); }
  if (q.username) { where.push('username = ?'); args.push(q.username); }
  if (q.action) { where.push('action = ?'); args.push(q.action); }
  if (q.from) { where.push('substr(created_at,1,10) >= ?'); args.push(q.from); }
  if (q.to) { where.push('substr(created_at,1,10) <= ?'); args.push(q.to); }
  return db
    .prepare(
      `SELECT * FROM sensitive_access_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC LIMIT 500`
    )
    .all(...args)
    .map((x) => ({
      ...x,
      action_label: { list: '列表查看', view: '明细查看', export: '导出', reveal: '一次性查看' }[x.action] || x.action,
      granted_label: x.granted ? '有权限' : '申请查看'
    }));
}

function stats() {
  const g = (sql, ...a) => db.prepare(sql).get(...a).c;
  return {
    rules: g('SELECT COUNT(*) c FROM field_guards WHERE enabled = 1'),
    tables: g('SELECT COUNT(DISTINCT table_name) c FROM field_guards WHERE enabled = 1'),
    logs: g('SELECT COUNT(*) c FROM sensitive_access_logs'),
    reveals: g("SELECT COUNT(*) c FROM sensitive_access_logs WHERE action = 'reveal'"),
    exports: g("SELECT COUNT(*) c FROM sensitive_access_logs WHERE action = 'export'"),
    today: g("SELECT COUNT(*) c FROM sensitive_access_logs WHERE substr(created_at,1,10) = date('now','localtime')"),
    top_users: db
      .prepare(
        `SELECT username, user_name, COUNT(*) c FROM sensitive_access_logs
          GROUP BY username ORDER BY c DESC LIMIT 5`
      )
      .all()
  };
}

/** 字典：可挂载的表与字段（给规则配置页用） */
function dict() {
  return {
    tables: Object.entries(LABEL_FIELD).map(([code, label]) => ({ code, label })),
    categories: [
      { code: 'pii', label: '个人信息' },
      { code: 'payroll', label: '工资' },
      { code: 'bank', label: '银行账户' },
      { code: 'contract', label: '合同金额' }
    ],
    mask_types: [
      { code: 'partial', label: '部分保留（如 138****5678）' },
      { code: 'hide', label: '完全隐藏（***）' }
    ],
    perms: ['pii.read', 'payroll.sensitive', 'bankaccount.sensitive', 'contract.sensitive']
  };
}

module.exports = {
  rules,
  ruleOf,
  listRules,
  saveRule,
  reload,
  canSee,
  maskValue,
  maskRows,
  maskRow,
  maskFields,
  reveal,
  markExport,
  logs,
  stats,
  dict,
  log
};
