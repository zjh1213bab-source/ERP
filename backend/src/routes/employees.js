/**
 * 员工档案（人事行政）
 * GET    /api/employees?q=&status=
 * POST   /api/employees
 * PUT    /api/employees/:id
 * DELETE /api/employees/:id   标记离职
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const privacy = require('../services/privacy');
const { reqCtx } = require('../utils/reqCtx');

const router = express.Router();
const WRITE = ['admin', 'hr'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { q = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (q) { where.push('(e.name LIKE ? OR e.code LIKE ? OR e.position LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('e.status = ?'); params.push(status); }
  const sql = `SELECT e.*, d.name AS department_name FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY e.id DESC';
  const rows = db.prepare(sql).all(...params);
  // 员工档案要全公司可选用（请假/考勤下拉），但身份证/手机/紧急联系人/基本工资
  // 只该人事与财务看到。这里不再手写角色白名单，统一走 privacy：
  // 手写版把 admin 也算进「能看工资」，正好违反「管理员技术权限不默认可读工资」；
  // 而且只处理了 id_card 与 base_salary，手机号与紧急联系人一直是明文。
  return ok(res, privacy.maskRows('employees', rows, reqCtx(req, { action: 'list' })));
}));

router.get('/departments', authRequired, wrap(async (req, res) => {
  return ok(res, db.prepare('SELECT id, name FROM departments ORDER BY id').all());
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '姓名必填');
  const info = db.prepare(
    'INSERT INTO employees (code, name, department_id, position, phone, hire_date, status, base_salary, remark, image_url, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(b.code || null, b.name, b.department_id || null, b.position || null, b.phone || null, b.hire_date || null, b.status || 'active', Number(b.base_salary) || 0, b.remark || null, b.image_url || null, now());
  return ok(res, db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '员工不存在');
  const b = req.body || {};
  db.prepare('UPDATE employees SET code=?, name=?, department_id=?, position=?, phone=?, hire_date=?, status=?, base_salary=?, remark=?, image_url=? WHERE id=?').run(
    b.code ?? row.code, b.name || row.name, b.department_id ?? row.department_id, b.position ?? row.position,
    b.phone ?? row.phone, b.hire_date ?? row.hire_date, b.status || row.status,
    b.base_salary !== undefined ? Number(b.base_salary) || 0 : row.base_salary, b.remark ?? row.remark,
    b.image_url ?? row.image_url, req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM employees WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '员工不存在');
  db.prepare("UPDATE employees SET status='left' WHERE id=?").run(req.params.id);
  return ok(res, { id: Number(req.params.id), status: 'left' });
}));

module.exports = router;
