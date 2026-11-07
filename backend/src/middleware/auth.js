/**
 * 鉴权中间件
 * - authRequired：校验 JWT + **每次核对库里的账号状态/角色/会话版本** + 装配生效岗位/权限
 *   + 未绑定公司主体的账号拒绝 + 高危动作收回拦截
 * - requireRole：角色校验（admin 视为超级管理员，一人多岗取并集）
 * 兼容旧用法：module.exports 默认即 authRequired
 *
 * 为什么 authRequired 里要多做这几件事：
 *   1. 装 roles：一人多岗后，主岗 users.role 不足以判断，必须把附加岗并进来
 *   2. 核会话：JWT 只证明「这个令牌是我们签的」，不证明「这个人现在还能用」。
 *      停用、降权、改密码之后旧令牌还能用满 12 小时 —— 离职人员照样能操作、
 *      被降权的人照样能改钱。所以每个请求都拿 `users.token_version` 与令牌里的 `tv` 比一次。
 *   3. 拦收回：岗位复核会把某些权限从某人身上收掉（access_exceptions.deny）。
 *      前端藏按钮只是体验，直接调接口还能过就没意义，所以在这里按高危路由表拦。
 *   4. 拦未绑定主体：没有 `company_id` 的普通账号，数据范围无解（要么全看不到、
 *      要么全看得到），一律拒绝并给出可执行的提示，而不是让它悄悄看全公司。
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { fail } = require('../utils/http');
const access = require('../services/access');
const companyScope = require('../access/companyScope');

/**
 * 未绑定主体时仍然放行的路径
 *
 * 只放登录态自检与健康检查：用户需要先能读到「我是谁」，前端才能弹出
 * 「请联系管理员绑定公司」的提示；把 /api/auth/me 也拦掉，页面会表现成
 * 「登录成功但白屏」，比直接告诉他原因难查得多。
 */
const UNBOUND_ALLOW = /^\/api\/(auth\/|health$)/;

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

    /**
     * 会话核对（20 秒缓存，跨进程最多延迟 20 秒）
     *
     * 老令牌没有 `tv`：按 0 比，老账号的 `token_version` 默认也是 0，升级不踢人。
     * 角色一律以库里的为准 —— 令牌里的 role 是签发那一刻的快照，
     * 拿它做判断等于「降权之前签的令牌永远有老权限」。
     */
    const sess = access.sessionOf(payload.sub);
    if (!sess) return fail(res, 401, '账号不存在，请重新登录');
    if (!Number(sess.active)) return fail(res, 401, '账号已停用，请联系管理员');
    if ((Number(payload.tv) || 0) !== (Number(sess.token_version) || 0)) {
      return fail(res, 401, '登录状态已失效（账号权限或密码已变更），请重新登录');
    }

    req.user = { ...payload, username: sess.username, role: sess.role, name: sess.name || payload.name };
    // 附加岗 + 生效权限（带 20s 缓存，避免每个请求都读库）
    const eff = access.effective(payload.sub, sess.role);
    req.user.roles = eff.roles;
    req.user.permDeny = eff.deny;
    const position = require('../services/positionAccess').assigned(payload.sub);
    req.user.positionDirect=!!position?.direct;
    if (position && sess.role !== 'admin') req.user.role = position.roles[0];
    const positionError = require('../services/positionAccess').check(req);
    if (positionError) return fail(res, 403, positionError);
    /**
     * 主体归属：从库里取（20s 缓存），不信 token ——
     * token 里没有 company_id，而就算加进去，人换了主体也要等 12 小时才生效。
     * 各路由用它做数据范围过滤（见 access/companyScope）。
     */
    req.user.company_id = access.companyOf(payload.sub);

    /**
     * 未绑定公司主体 → 直接拒绝（多主体模式下才可能发生；单公司模式恒 cross）
     *
     * 放在权限判断之前：这类账号连"能看到哪些数据"都确定不了，
     * 谈权限没有意义。提示里给了明确的下一步动作（找管理员指定公司）。
     */
    const scopeErr = companyScope.scopeProblem(req.user);
    if (scopeErr && !UNBOUND_ALLOW.test(String(req.originalUrl || req.url || '').split('?')[0])) {
      return fail(res, 403, scopeErr);
    }

    // 普通员工只能访问本人自助接口；附加业务岗位经管理员授权后按正常权限处理。
    if (!req.user.positionDirect && req.user.roles.every(role => role === 'employee')) {
      const pathname = String(req.originalUrl || req.url || '').split('?')[0];
      const allowed = /^\/api\/auth\/(me|logout)$|^\/api\/access\/me$|^\/api\/self\/(meta|overview|payslips|requests|work-find|work-order|work-quote|work-report)(\/|$)/;
      if (!allowed.test(pathname) && !require('../access/permissions').employeePortalRequest(req) && !(req.method==='GET' && pathname==='/api/settings/appearance')) return fail(res, 403, '普通员工账号仅可使用本人自助功能');
    }

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
    // 岗位模块与动作已经在 authRequired 校验，旧角色不再形成第二道授权。
    // 管理员专属接口仍不向普通岗位开放。
    if(req.user.positionDirect && list.some(r=>!['admin','boss'].includes(r)))return next();
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
