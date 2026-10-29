/**
 * 鉴权中间件
 * - authRequired：校验 JWT + 装配生效岗位/权限 + 高危动作收回拦截
 * - requireRole：角色校验（admin 视为超级管理员，一人多岗取并集）
 * 兼容旧用法：module.exports 默认即 authRequired
 *
 * 为什么 authRequired 里要多做两件事：
 *   1. 装 roles：一人多岗后，主岗 users.role 不足以判断，必须把附加岗并进来
 *   2. 拦收回：岗位复核会把某些权限从某人身上收掉（access_exceptions.deny）。
 *      前端藏按钮只是体验，直接调接口还能过就没意义，所以在这里按高危路由表拦。
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { fail } = require('../utils/http');
const access = require('../services/access');

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return fail(res, 401, '未登录，请先登录');
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    // 客户商城 token 与员工 token 用同一密钥签发，必须按 scope 隔离，
    // 否则客户账号能拿到 ERP 接口（例如商城后台的客户名单/询价单）。
    if (payload.scope === 'customer') {
      return fail(res, 401, '该账号为商城客户账号，不能访问 ERP 接口');
    }
    req.user = payload;
    // 附加岗 + 生效权限（带 20s 缓存，避免每个请求都读库）
    const eff = access.effective(payload.sub, payload.role);
    req.user.roles = eff.roles;
    req.user.permDeny = eff.deny;
    /**
     * 主体归属：从库里取（20s 缓存），不信 token ——
     * token 里没有 company_id，而就算加进去，人换了主体也要等 12 小时才生效。
     * 各路由用它做数据范围过滤（见 access/companyScope）。
     */
    req.user.company_id = access.companyOf(payload.sub);

    // 高危动作被收回 → 直接拒绝（只覆盖改钱/改库存/改人事/改权限）
    const hit = access.matchDeny(req);
    if (hit) {
      return fail(res, 403, `「${hit.perm}」已按岗位复核结果收回：${hit.reason}`);
    }
    return next();
  } catch (e) {
    return fail(res, 401, '登录已过期或无效，请重新登录');
  }
}

/**
 * 角色校验。
 * 兼容三种调用方式（历史上都出现过，混用很容易悄悄变成「只有 admin 能进」）：
 *   requireRole(ROLES)              —— 传数组
 *   requireRole('admin','sales')    —— 传多个参数
 *   requireRole(...ROLES)           —— 展开数组
 * 所以这里必须收 rest 参数并摊平，不能只取第一个参数。
 *
 * 一人多岗：主岗或任一附加岗命中即放行。
 */
function requireRole(...roles) {
  const list = roles.flat(Infinity).filter((r) => typeof r === 'string');
  return (req, res, next) => {
    if (!req.user) return fail(res, 401, '未登录');
    if (req.user.role === 'admin') return next();
    const mine = req.user.roles && req.user.roles.length ? req.user.roles : [req.user.role];
    if (mine.some((r) => list.includes(r))) return next();
    // 总经理（boss）只读：GET 放行，写动作仍按岗位判断
    if (mine.includes('boss') && (req.method === 'GET' || req.method === 'HEAD')) return next();
    return fail(res, 403, '无权限执行该操作');
  };
}

module.exports = authRequired;
module.exports.authRequired = authRequired;
module.exports.requireRole = requireRole;
