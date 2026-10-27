/**
 * 客户账号权限点（原型 TS-N21-03 / 04）
 * ------------------------------------------------------------------
 * 三条硬规则：
 *   1) 服务端只信登录身份（token → account_id → DB 现读），**从不信任客户端传来的 customer_id**
 *   2) 子账号权限必须落在「销售已批准的上限」内，超出即拒（主账号也不能越权）
 *   3) 财务权限与采购权限分开：财务子账号能看对账，但默认不能发起询价
 */
const { db } = require('../db');

/** 权限点字典 */
const PERMS = {
  'catalog.view': '看商品与专属价',
  'inquiry.create': '发起询价',
  'order.view': '看订单与进度',
  'order.confirm': '确认样衣 / 变更 / 交期',
  'finance.view': '看对账与账单',
  'member.manage': '管理本组织子账号'
};

/** 角色预设（开账号时的默认权限；主账号恒为全量） */
const ROLE_PRESETS = {
  owner: ['catalog.view', 'inquiry.create', 'order.view', 'order.confirm', 'finance.view', 'member.manage'],
  purchase: ['catalog.view', 'inquiry.create'],
  orders: ['catalog.view', 'order.view', 'order.confirm'],
  finance: ['finance.view', 'order.view'],
  member: ['catalog.view', 'inquiry.create']
};

const ROLE_LABEL = {
  owner: '主账号',
  purchase: '采购子账号',
  orders: '订单子账号',
  finance: '财务子账号',
  member: '子账号'
};

const ALL_PERMS = Object.keys(PERMS);

function splitPerms(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter((x) => x && PERMS[x]);
}

/**
 * 某账号的生效权限
 * - owner：受销售批准的权限上限约束（上限为空时视为全量）——销售没批财务，主账号也看不到账
 * - 子账号：以 perms 为准，空则回落到角色预设
 */
function resolvePerms(account) {
  if (!account) return [];
  if (account.role === 'owner') {
    const lim = splitPerms(account.limit_perms);
    return lim.length ? lim : ALL_PERMS.slice();
  }
  const own = splitPerms(account.perms);
  if (own.length) return own;
  return (ROLE_PRESETS[account.role] || ROLE_PRESETS.member).slice();
}

/** 销售批准的权限上限：空 = 按角色预设 */
function resolveLimit(account) {
  const lim = splitPerms(account && account.limit_perms);
  return lim.length ? lim : (ROLE_PRESETS[account && account.role] || ROLE_PRESETS.member).slice();
}

function hasPerm(account, perm) {
  return resolvePerms(account).includes(perm);
}

/** 权限点是否属于某上限之内（子集判断） */
function withinLimit(perms, limit) {
  const lim = new Set(limit || []);
  return (perms || []).every((p) => lim.has(p));
}

/** 路由中间件：要求某个权限点 */
function permRequired(perm) {
  return (req, res, next) => {
    if (!req.customer) return res.status(401).json({ ok: false, message: '请先登录商城账号' });
    const acc = db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(req.customer.sub);
    if (!acc || acc.status !== 'active') return res.status(401).json({ ok: false, message: '账号已停用，请联系你的主账号或业务员' });
    if (!hasPerm(acc, perm)) {
      const label = PERMS[perm] || perm;
      return res.status(403).json({ ok: false, message: `当前账号没有「${label}」权限，请让主账号在成员管理里开通` });
    }
    req.account = acc;
    return next();
  };
}

/** 写审计（开通 / 改权限 / 停用 / 重置 / 邀请 / 批准） */
function audit(accountId, customerId, action, before, after, operator, scope, note) {
  db.prepare(
    `INSERT INTO customer_account_audits (account_id, customer_id, action, before_json, after_json, operator, operator_scope, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    accountId || null, customerId || null, action,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    operator || null, scope || 'staff', note || null, new Date().toISOString()
  );
}

module.exports = {
  PERMS, ROLE_PRESETS, ROLE_LABEL, ALL_PERMS,
  splitPerms, resolvePerms, resolveLimit, hasPerm, withinLimit, permRequired, audit
};
