/**
 * 用户与角色（仅 admin）
 * GET  /api/users
 * POST /api/users            新建 { username, password, name, role, department_id, extra_roles? }
 * PUT  /api/users/:id        修改 { name, role, active, password?, extra_roles? }
 *
 * 角色清单以 src/access/permissions.js 为唯一来源，不在这里另抄一份。
 * 一人多岗：users.role 是主岗，user_roles 是附加岗，生效权限取并集。
 */
const express = require('express');
const { db, now } = require('../db');
const { hashPassword } = require('../auth/password');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { ROLES, ROLE_LABELS } = require('../access/permissions');
const A = require('../services/access');

const router = express.Router();

function decorate(row) {
  if (!row) return row;
  const extra = db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(row.id).map((r) => r.role);
  return {
    ...row,
    role_label: ROLE_LABELS[row.role] || row.role,
    extra_roles: extra,
    extra_role_labels: extra.map((r) => ROLE_LABELS[r] || r)
  };
}

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
    return ok(res, rows.map(decorate));
  })
);

router.get(
  '/roles',
  authRequired,
  wrap(async (req, res) =>
    ok(res, ROLES.map((code) => ({ code, label: ROLE_LABELS[code] || code })))
  )
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
    const id = Number(info.lastInsertRowid);
    if (Array.isArray(b.extra_roles) && b.extra_roles.length) {
      A.setExtraRoles({ userId: id, roles: b.extra_roles, operator: req.user.username || '' });
    }
    const row = db
      .prepare('SELECT id, username, name, role, department_id, active, created_at FROM users WHERE id = ?')
      .get(id);
    return ok(res, decorate(row));
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
    if (Array.isArray(b.extra_roles)) {
      A.setExtraRoles({ userId: Number(id), roles: b.extra_roles, operator: req.user.username || '' });
    }
    A.clearCache(Number(id));
    const row = db
      .prepare('SELECT id, username, name, role, department_id, active, created_at FROM users WHERE id = ?')
      .get(id);
    return ok(res, decorate(row));
  })
);

module.exports = router;
