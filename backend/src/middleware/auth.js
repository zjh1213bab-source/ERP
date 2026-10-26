/**
 * 鉴权中间件
 * - authRequired：校验 JWT
 * - requireRole：角色校验（admin 视为超级管理员）
 * 兼容旧用法：module.exports 默认即 authRequired
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { fail } = require('../utils/http');

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return fail(res, 401, '未登录，请先登录');
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch (e) {
    return fail(res, 401, '登录已过期或无效，请重新登录');
  }
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) return fail(res, 401, '未登录');
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    return fail(res, 403, '无权限执行该操作');
  };
}

module.exports = authRequired;
module.exports.authRequired = authRequired;
module.exports.requireRole = requireRole;
