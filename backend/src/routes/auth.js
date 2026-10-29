/**
 * 登录 / 当前用户 / 登出
 * POST /api/auth/login   { username, password } -> { token, user }
 * GET  /api/auth/me      -> 当前用户信息
 * POST /api/auth/logout  -> 撤销当前账号的全部已签发令牌（换设备/怀疑泄露时用）
 *
 * ## 令牌里为什么带 `tv`
 *
 * JWT 是无状态的：签出去之后 12 小时内一直有效，服务端没有"撤回"这个动作。
 * 于是停用账号、降权、改密码之后，**已经发出去的令牌还能用满 12 小时**。
 * `users.token_version` 就是解药：签发时把它写进 payload（`tv`），
 * 每次请求在 `middleware/auth.js` 里与库里的值比一次。
 * 任何"该让人重新登录"的动作（停用 / 改角色 / 改密码 / 换主体）都把库里的值 +1，
 * 旧令牌在下一个请求就失效 —— 见 `routes/users.js`。
 *
 * 老令牌没有 `tv`：按 0 处理，老账号的 `token_version` 默认也是 0，升级不会把所有人踢下线。
 */
const express = require('express');
const jwt = require('jsonwebtoken');

const config = require('../config');
const { db, now } = require('../db');
const { verifyPassword } = require('../auth/password');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');
const loginLimit = require('../middleware/loginLimit');
const A = require('../services/access');

const router = express.Router();

/**
 * 员工登录限流
 *
 * 参数在 `config.loginLimit`（默认 20 次/分钟/IP、同账号连续失败 5 次锁 5 分钟起）。
 * 与商城登录分成两个独立的桶：前台客户被人撞库，不该把后台员工一起锁掉。
 */
const limit = loginLimit.create({ name: 'staff' });

router.post(
  '/login',
  limit.middleware,
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return fail(res, 400, '请输入账号和密码');

    /**
     * 三种失败都记一次失败计数、都回同一句提示。
     *
     * 为什么不区分"账号不存在"和"密码错"：区分开就等于提供了一个账号枚举接口
     * （输对账号会得到不同的回复），撞库脚本可以先把有效账号挑出来再慢慢试密码。
     */
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) {
      limit.recordFail(req, username);
      return fail(res, 401, '账号或密码错误');
    }
    limit.recordSuccess(req, username);

    const token = jwt.sign(
      { sub: u.id, username: u.username, role: u.role, name: u.name, tv: Number(u.token_version) || 0 },
      config.jwtSecret,
      { expiresIn: config.tokenExpiresIn }
    );
    // 登录这一刻还没有 req.user（token 刚签发），中间件默认会记成 anonymous。
    // 这里把人和岗位挂到 req 上，审计里就能看到「谁在几点登录」而不是一堆匿名记录。
    req.auditUser = u.username;
    req.auditRole = u.role;
    return ok(res, {
      token,
      user: { id: u.id, username: u.username, name: u.name, role: u.role }
    });
  })
);

router.get(
  '/me',
  authRequired,
  wrap(async (req, res) => {
    const u = db
      .prepare('SELECT id, username, name, role, company_id, department_id FROM users WHERE id = ?')
      .get(req.user.sub);
    if (!u) return fail(res, 401, '用户不存在');
    /**
     * 顺带把主体名带上：没绑主体时前端才能明确提示「请联系管理员指定公司」，
     * 否则页面只会表现成「什么数据都没有」，用户以为是系统坏了。
     */
    const company = u.company_id
      ? db.prepare('SELECT id, name, short_name FROM companies WHERE id = ?').get(u.company_id)
      : null;
    return ok(res, { ...u, company_name: company ? (company.short_name || company.name) : null });
  })
);

/**
 * 登出：让这个账号**所有设备上**的已签发令牌立刻失效
 *
 * 为什么是"所有设备"而不是"只失效当前这一个"：JWT 没有会话 id，
 * 要精确撤销单个会话就得再存一张会话表。而登出的真实场景是
 * 「在别人电脑上登过 / 怀疑令牌泄露」—— 那种时候把全部设备踢掉才是想要的结果。
 * 日常换设备不需要点登出，直接登录即可。
 */
router.post(
  '/logout',
  authRequired,
  wrap(async (req, res) => {
    db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?')
      .run(Number(req.user.sub) || 0);
    A.clearCache(Number(req.user.sub) || 0);
    req.auditUser = req.user.username;
    req.auditRole = req.user.role;
    return ok(res, { revoked_at: now(), message: '已退出登录，该账号在其它设备上的登录状态也已失效' });
  })
);

module.exports = router;
