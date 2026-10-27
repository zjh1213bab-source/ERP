/**
 * 考勤打卡
 * GET  /api/attendance?month=YYYY-MM&employee_id=
 * POST /api/attendance/clock  { employee_id, type: 'in' | 'out' }
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'hr'];
// 打卡是本人动作，所有在岗员工都能打
const ALL_STAFF = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse', 'hr'];

function pad(n) { return String(n).padStart(2, '0'); }
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

router.get('/', authRequired, wrap(async (req, res) => {
  const { month = '', employee_id = '' } = req.query;
  const where = [];
  const params = [];
  if (month) { where.push("substr(date,1,7) = ?"); params.push(month); }
  if (employee_id) { where.push('employee_id = ?'); params.push(employee_id); }
  const sql = 'SELECT * FROM attendance ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY date DESC, id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

router.post('/clock', authRequired, requireRole(ALL_STAFF), wrap(async (req, res) => {
  const { employee_id, type } = req.body || {};
  if (!employee_id) return fail(res, 400, '请选择员工');
  if (!['in', 'out'].includes(type)) return fail(res, 400, '打卡类型不合法');
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id);
  if (!emp) return fail(res, 404, '员工不存在');

  const date = localDate();
  const time = localTime();
  const row = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employee_id, date);

  if (!row) {
    const status = type === 'in' && time > '09:00' ? 'late' : 'normal';
    db.prepare(
      'INSERT INTO attendance (employee_id, employee_name, date, check_in, check_out, status, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(employee_id, emp.name, date, type === 'in' ? time : null, type === 'out' ? time : null, status, now());
  } else {
    const status = row.status === 'late' ? 'late' : (type === 'in' && time > '09:00' ? 'late' : row.status);
    db.prepare('UPDATE attendance SET check_in = ?, check_out = ?, status = ? WHERE id = ?').run(
      type === 'in' ? time : row.check_in,
      type === 'out' ? time : row.check_out,
      status,
      row.id
    );
  }
  return ok(res, db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(employee_id, date));
}));

module.exports = router;
