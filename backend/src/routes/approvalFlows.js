/**
 * 审批流配置（管理员）
 * GET    /api/approval-flows
 * POST   /api/approval-flows   { name, target_type='cost', min_amount, max_amount, steps:[{role,name}] }
 * PUT    /api/approval-flows/:id
 * DELETE /api/approval-flows/:id   停用
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
// 审批步骤的角色取值以权限矩阵为唯一来源（新增 hr/boss 后不能漏配，否则人事类审批流配不出来）
const { ROLES } = require('../access/permissions');

function normalizeSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return null;
  const out = [];
  for (const s of steps) {
    if (!s || !ROLES.includes(s.role)) return null;
    out.push({ role: s.role, name: String(s.name || '').trim() || s.role });
  }
  return out;
}

router.get('/', authRequired, wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM approval_flows ORDER BY target_type, min_amount').all();
  return ok(res, rows.map((r) => ({ ...r, steps: JSON.parse(r.steps) })));
}));

router.post('/', authRequired, requireRole(['admin']), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '流程名称必填');
  const steps = normalizeSteps(b.steps);
  if (!steps) return fail(res, 400, '审批步骤不合法（需至少一步，角色需有效）');
  const min = Number(b.min_amount) || 0;
  const max = Number(b.max_amount) || 999999999;
  if (min >= max) return fail(res, 400, '金额区间不合法');
  const info = db.prepare(
    'INSERT INTO approval_flows (name, target_type, min_amount, max_amount, steps, active, created_at) VALUES (?,?,?,?,?,1,?)'
  ).run(b.name, b.target_type || 'cost', min, max, JSON.stringify(steps), now());
  return ok(res, db.prepare('SELECT * FROM approval_flows WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(['admin']), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM approval_flows WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '流程不存在');
  const b = req.body || {};
  const steps = b.steps !== undefined ? normalizeSteps(b.steps) : JSON.parse(row.steps);
  if (!steps) return fail(res, 400, '审批步骤不合法');
  const min = b.min_amount !== undefined ? Number(b.min_amount) || 0 : row.min_amount;
  const max = b.max_amount !== undefined ? Number(b.max_amount) || 999999999 : row.max_amount;
  if (min >= max) return fail(res, 400, '金额区间不合法');
  db.prepare('UPDATE approval_flows SET name=?, target_type=?, min_amount=?, max_amount=?, steps=?, active=? WHERE id=?').run(
    b.name || row.name, b.target_type || row.target_type, min, max, JSON.stringify(steps),
    b.active === undefined ? row.active : b.active ? 1 : 0, req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM approval_flows WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(['admin']), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM approval_flows WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '流程不存在');
  db.prepare('UPDATE approval_flows SET active = 0 WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id), active: 0 });
}));

module.exports = router;
