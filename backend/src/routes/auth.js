/**
 * 登录 / 当前用户
 * POST /api/auth/login  { username, password } -> { token, user }
 * GET  /api/auth/me     -> 当前用户信息
 */
const express = require('express');
const jwt = require('jsonwebtoken');

const config = require('../config');
const { db } = require('../db');
const { verifyPassword } = require('../auth/password');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

router.post(
  '/login',
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return fail(res, 400, '请输入账号和密码');

    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!u || !u.active) return fail(res, 401, '账号不存在或已停用');
    if (!verifyPassword(password, u.password_hash)) return fail(res, 401, '账号或密码错误');

    const token = jwt.sign(
      { sub: u.id, username: u.username, role: u.role, name: u.name },
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
    return ok(res, u);
  })
);

module.exports = router;
