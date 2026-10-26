/**
 * 用户与角色（仅 admin）
 * GET  /api/users
 * POST /api/users            新建 { username, password, name, role, department_id }
 * PUT  /api/users/:id        修改 { name, role, active, password? }
 */
const express = require('express');
const { db, now } = require('../db');
const { hashPassword } = require('../auth/password');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

const ROLES = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse', 'viewer'];

router.get(
  '/',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => {
    const rows = db
      .prepare(
        'SELECT id, username, name, role, department_id, active, created_at FROM users ORDER BY id'
      )
      .all();
    return ok(res, rows);
  })
);

router.get(
  '/roles',
  authRequired,
  wrap(async (req, res) => ok(res, ROLES))
);

router.post(
  '/',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.username || !b.password) return fail(res, 400, '账号和密码必填');
    if (!ROLES.includes(b.role)) return fail(res, 400, '角色不合法');
    const dup = db.prepare('SELECT 1 AS x FROM users WHERE username = ?').get(b.username);
    if (dup) return fail(res, 400, '账号已存在');
    const info = db
      .prepare(
        'INSERT INTO users (username, password_hash, name, role, department_id, active, created_at) VALUES (?,?,?,?,?,1,?)'
      )
      .run(b.username, hashPassword(b.password), b.name || b.username, b.role, b.department_id || null, now());
    const row = db
      .prepare('SELECT id, username, name, role, department_id, active, created_at FROM users WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    return ok(res, row);
  })
);

router.put(
  '/:id',
  authRequired,
  requireRole(['admin']),
  wrap(async (req, res) => {
    const id = req.params.id;
    const exists = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!exists) return fail(res, 404, '用户不存在');
    const b = req.body || {};
    if (b.role && !ROLES.includes(b.role)) return fail(res, 400, '角色不合法');

    db.prepare('UPDATE users SET name=?, role=?, active=? WHERE id=?').run(
      b.name || exists.name,
      b.role || exists.role,
      b.active === undefined ? exists.active : b.active ? 1 : 0,
      id
    );
    if (b.password) {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(b.password), id);
    }
    const row = db
      .prepare('SELECT id, username, name, role, department_id, active, created_at FROM users WHERE id = ?')
      .get(id);
    return ok(res, row);
  })
);

module.exports = router;
