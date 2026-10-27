/**
 * 请假记录
 * GET    /api/leaves?status=&employee_id=
 * POST   /api/leaves  { employee_id, type, start_date, end_date, days, reason }
 * POST   /api/leaves/:id/review  { approve: true|false }
 * DELETE /api/leaves/:id
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'hr'];
// 请假单是本人提交，所有在岗员工都能开；审批另用 REVIEW
const ALL_STAFF = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse', 'hr'];
const REVIEW = ['admin', 'hr', 'sales', 'production'];   // 人事 + 部门负责人

router.get('/', authRequired, wrap(async (req, res) => {
  const { status = '', employee_id = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (employee_id) { where.push('employee_id = ?'); params.push(employee_id); }
  const sql = 'SELECT * FROM leave_requests ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

router.post('/', authRequired, requireRole(ALL_STAFF), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.employee_id && !b.employee_name) return fail(res, 400, '请选择员工');
  let name = b.employee_name;
  if (b.employee_id && !name) {
    const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(b.employee_id);
    name = emp ? emp.name : null;
  }
  const info = db.prepare(
    'INSERT INTO leave_requests (employee_id, employee_name, type, start_date, end_date, days, reason, status, created_at) VALUES (?,?,?,?,?,?,?,\'pending\',?)'
  ).run(b.employee_id || null, name || '', b.type || 'annual', b.start_date || null, b.end_date || null, Number(b.days) || 0, b.reason || null, now());
  return ok(res, db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.post('/:id/review', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  const status = (req.body && req.body.approve === false) ? 'rejected' : 'approved';
  db.prepare('UPDATE leave_requests SET status = ?, reviewed_by = ? WHERE id = ?').run(status, req.user.username, req.params.id);
  return ok(res, db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM leave_requests WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  db.prepare('DELETE FROM leave_requests WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
