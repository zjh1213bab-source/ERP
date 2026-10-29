/**
 * 考勤打卡
 * GET  /api/attendance?month=YYYY-MM&employee_id=
 * POST /api/attendance/clock  { employee_id, type: 'in' | 'out' }
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const scope = require('../access/companyScope');

/**
 * 考勤没有 company_id，挂在 `employee_id` 上 —— 员工档案 v1.64 才有主体，
 * 所以这里一律按「父表」判归属。工时是工资的前置数据，跨主体能看到就等于能看到别人的出勤。
 */
// 主体过滤值：**单公司模式下恒为 null（不过滤）**，判据在 access/companyScope.js 的 of()
const cidOf = (req) => scope.filterCompanyId(req.user);
const empScope = (cid, col = 'employee_id') => scope.parentClauseSql(cid, 'employees', col).sql;

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
  const empWh = empScope(cidOf(req));
  if (empWh) where.push(empWh.replace(/^ AND /, ''));
  if (month) { where.push("substr(date,1,7) = ?"); params.push(month); }
  if (employee_id) { where.push('employee_id = ?'); params.push(employee_id); }
  const sql = 'SELECT * FROM attendance ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY date DESC, id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

router.post('/clock', authRequired, requireRole(ALL_STAFF), wrap(async (req, res) => {
  const { employee_id, type } = req.body || {};
  if (!employee_id) return fail(res, 400, '请选择员工');
  if (!['in', 'out'].includes(type)) return fail(res, 400, '打卡类型不合法');
  // 只能给本主体的员工打卡（别家的员工 id 在这里当不存在）
  const empRow = scope.assertRow(req.user, 'employees', employee_id, '员工');
  if (!empRow.ok) return fail(res, 404, '员工不存在');
  const emp = empRow.row;

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
