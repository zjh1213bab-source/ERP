/**
 * 客户商城鉴权（与 ERP 员工账号分离）
 * - customerRequired：校验 JWT 且 scope === 'customer'，并**每次从库现读账号**（TS-N21-04 / 05）
 *   · 只信 token 里的 account_id，cid 每次按库里账号重新取，绝不信任客户端传的 customer_id
 *   · 账号被停用 / 删除 / 客户被改绑 → 立刻 401，不用等 token 过期
 *   · 权限点挂到 req.customer.perms，供 permRequired 与字段级隔离使用
 * token 载荷：{ sub: account_id, cid, scope:'customer', username, role }
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db');
const { fail } = require('../utils/http');
const { resolvePerms } = require('../services/customerPerms');

function signCustomerToken(account) {
  return jwt.sign(
    {
      sub: account.id,
      cid: account.customer_id,
      scope: 'customer',
      username: account.username,
      name: account.name,
      role: account.role
    },
    config.jwtSecret,
    { expiresIn: config.mallTokenExpiresIn || '7d' }
  );
}

function customerRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return fail(res, 401, '请先登录商城账号');
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (e) {
    return fail(res, 401, '登录已过期，请重新登录');
  }
  if (payload.scope !== 'customer') return fail(res, 401, '该账号不能访问商城');

  // 现读账号：停用 / 删除 / 改绑立即生效，权限调整也立即生效
  const acc = db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(payload.sub);
  if (!acc) return fail(res, 401, '账号不存在，请联系业务员');
  if (acc.status !== 'active') return fail(res, 401, '账号已停用，请联系你的主账号或业务员');
  const customer = db.prepare('SELECT id, name, code FROM customers WHERE id = ?').get(acc.customer_id);
  if (!customer) return fail(res, 401, '账号未绑定客户，请联系业务员');

  req.account = acc;
  req.customer = {
    sub: acc.id,
    cid: acc.customer_id,          // 只来自库，不来自 token 以外的任何输入
    username: acc.username,
    name: acc.name,
    role: acc.role,
    perms: resolvePerms(acc)
  };
  return next();
}

module.exports = { signCustomerToken, customerRequired };
