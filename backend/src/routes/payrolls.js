/**
 * 薪酬核算（月度工资单）
 * GET    /api/payrolls?period=YYYY-MM&status=
 * GET    /api/payrolls/summary?period=        汇总
 * GET    /api/payrolls/periods                已有工资单的月份
 * GET    /api/payrolls/export?period=         导出 CSV
 * POST   /api/payrolls/generate               { period, overwrite } 按在职员工生成
 * PUT    /api/payrolls/:id                    调整奖金/补贴/扣款/社保/加班/缺勤（仅草稿）
 * POST   /api/payrolls/:id/confirm            草稿 → 已确认
 * POST   /api/payrolls/:id/pay                已确认 → 已发放
 * POST   /api/payrolls/batch                  { action:'confirm'|'pay', ids:[] }
 * DELETE /api/payrolls/:id                    删除（仅草稿）
 *
 * 计算口径：
 *   应出勤 = 当月周一至周五天数
 *   日薪   = 基本工资 / 应出勤
 *   缺勤扣款 = 日薪 × 缺勤天数
 *   加班费  = 日薪 / 8 × 加班小时 × 1.5
 *   应发   = 基本工资 + 加班费 + 奖金 + 补贴 − 其他扣款 − 缺勤扣款
 *   个税   = (应发 − 个人社保 − 5000) 按月度税率表（3%~45%，含速算扣除数）
 *   实发   = 应发 − 个人社保 − 个税
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'hr', 'finance'];
// 工资是全公司最敏感的数据：读也要限岗（原来 GET 只要求登录，任何角色都能拉全员工资）
const READ = ['admin', 'boss', 'hr', 'finance'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const STATUS_LABELS = { draft: '草稿', confirmed: '已确认', paid: '已发放' };
const TAX_THRESHOLD = 5000;
const SOCIAL_RATE = 0.105; // 个人社保简化比例（可逐单覆盖）

const TAX_BRACKETS = [
  { cap: 3000, rate: 0.03, sub: 0 },
  { cap: 12000, rate: 0.10, sub: 210 },
  { cap: 25000, rate: 0.20, sub: 1410 },
  { cap: 35000, rate: 0.25, sub: 2660 },
  { cap: 55000, rate: 0.30, sub: 4410 },
  { cap: 80000, rate: 0.35, sub: 7160 },
  { cap: Infinity, rate: 0.45, sub: 15160 }
];

function calcTax(taxable) {
  if (!(taxable > 0)) return 0;
  const b = TAX_BRACKETS.find((x) => taxable <= x.cap);
  return round2(Math.max(0, taxable * b.rate - b.sub));
}

/** 当月工作日（周一至周五）天数 */
function workDaysInMonth(period) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) return 0;
  const days = new Date(y, m, 0).getDate();
  let n = 0;
  for (let d = 1; d <= days; d++) {
    const w = new Date(y, m - 1, d).getDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

function periodRange(period) {
  const [y, m] = String(period).split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { from, to };
}

/** 按已有字段重算：加班费/应发/个税/实发 */
function recalc(r) {
  const daily = r.work_days > 0 ? r.base_salary / r.work_days : 0;
  const absentCut = round2(daily * r.absent_days);
  const overtimePay = round2((daily / 8) * r.overtime_hours * 1.5);
  const gross = round2(r.base_salary + overtimePay + r.bonus + r.allowance - r.deduction - absentCut);
  const taxable = round2(gross - r.social_insurance - TAX_THRESHOLD);
  const tax = calcTax(taxable);
  const net = round2(gross - r.social_insurance - tax);
  return { daily: round2(daily), absentCut, overtimePay, gross, tax, net };
}

function withComputed(row) {
  const c = recalc(row);
  return {
    ...row,
    status_label: STATUS_LABELS[row.status] || row.status,
    daily_salary: c.daily,
    absent_cut: c.absentCut,
    tax: c.tax,
    net_pay: c.net,
    gross_pay: c.gross
  };
}

function listByPeriod(period, status) {
  const where = [];
  const params = [];
  if (period) { where.push('period = ?'); params.push(period); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = 'SELECT * FROM payrolls ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY department, employee_id';
  return db.prepare(sql).all(...params).map(withComputed);
}

// ---------- 列表 ----------
router.get('/', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { period = '', status = '' } = req.query;
  return ok(res, listByPeriod(period, status));
}));

// ---------- 有数据的月份 ----------
router.get('/periods', authRequired, requireRole(READ), wrap(async (req, res) => {
  const rows = db.prepare('SELECT period, COUNT(*) AS cnt, SUM(net_pay) AS total FROM payrolls GROUP BY period ORDER BY period DESC').all();
  return ok(res, rows);
}));

// ---------- 汇总 ----------
router.get('/summary', authRequired, requireRole(READ), wrap(async (req, res) => {
  const period = String(req.query.period || '').trim();
  if (!period) return fail(res, 400, '缺少 period（YYYY-MM）');
  const rows = listByPeriod(period);
  const sum = (k) => round2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));
  const byStatus = {};
  rows.forEach((r) => {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  });
  const byDept = {};
  rows.forEach((r) => {
    const k = r.department || '未分配';
    if (!byDept[k]) byDept[k] = { dept: k, count: 0, net: 0 };
    byDept[k].count++;
    byDept[k].net = round2(byDept[k].net + (Number(r.net_pay) || 0));
  });
  return ok(res, {
    period,
    work_days: workDaysInMonth(period),
    count: rows.length,
    headcount: new Set(rows.map((r) => r.employee_id)).size,
    base_salary: sum('base_salary'),
    gross_pay: sum('gross_pay'),
    net_pay: sum('net_pay'),
    tax: sum('tax'),
    social_insurance: sum('social_insurance'),
    bonus: sum('bonus'),
    overtime_pay: sum('overtime_pay'),
    byStatus,
    byDept: Object.values(byDept).sort((a, b) => b.net - a.net)
  });
}));

// ---------- 导出 CSV ----------
function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/export', authRequired, requireRole(READ), wrap(async (req, res) => {
  const period = String(req.query.period || '').trim();
  if (!period) return fail(res, 400, '缺少 period（YYYY-MM）');
  const rows = listByPeriod(period);
  const header = ['月份', '部门', '姓名', '基本工资', '应出勤', '实出勤', '请假', '缺勤',
    '加班小时', '加班费', '奖金', '补贴', '其他扣款', '个人社保', '个税', '应发', '实发', '状态', '备注'];
  const lines = [header.map(csvCell).join(',')];
  rows.forEach((r) => {
    lines.push([
      r.period, r.department || '', r.employee_name, r.base_salary, r.work_days, r.actual_days,
      r.leave_days, r.absent_days, r.overtime_hours, r.overtime_pay, r.bonus, r.allowance,
      r.deduction, r.social_insurance, r.tax, r.gross_pay, r.net_pay,
      STATUS_LABELS[r.status] || r.status, r.remark || ''
    ].map(csvCell).join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${period}.csv"`);
  return res.send('\uFEFF' + lines.join('\r\n'));
}));

// ---------- 生成 ----------
router.post('/generate', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const period = String(b.period || '').trim();
  if (!/^\d{4}-\d{2}$/.test(period)) return fail(res, 400, '月份格式应为 YYYY-MM');
  const overwrite = !!b.overwrite;

  const emps = db.prepare(
    `SELECT e.*, d.name AS dept_name FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'active' ORDER BY e.id`
  ).all();
  if (!emps.length) return fail(res, 400, '没有在职员工，请先在「员工档案」录入');

  const workDays = workDaysInMonth(period);
  const { from, to } = periodRange(period);
  const t = now();

  let created = 0, refreshed = 0, skipped = 0;
  const ins = db.prepare(
    `INSERT INTO payrolls (period, employee_id, employee_name, department, base_salary, work_days, actual_days,
      leave_days, absent_days, overtime_hours, overtime_pay, bonus, allowance, deduction, social_insurance, tax,
      gross_pay, net_pay, status, remark, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  db.exec('BEGIN');
  try {
    for (const e of emps) {
      const exist = db.prepare('SELECT * FROM payrolls WHERE period = ? AND employee_id = ?').get(period, e.id);
      if (exist && !overwrite) { skipped++; continue; }
      if (exist && exist.status !== 'draft') { skipped++; continue; }

      const leaveDays = round2(
        db.prepare(
          "SELECT COALESCE(SUM(days),0) AS s FROM leave_requests WHERE employee_id = ? AND status = 'approved' AND start_date BETWEEN ? AND ?"
        ).get(e.id, from, to).s
      );
      const absentDays = Number(
        db.prepare("SELECT COUNT(*) AS c FROM attendance WHERE employee_id = ? AND date BETWEEN ? AND ? AND status = 'absent'")
          .get(e.id, from, to).c
      );
      const baseSalary = Number(e.base_salary) || 0;
      const row = {
        base_salary: baseSalary,
        work_days: workDays,
        actual_days: round2(Math.max(0, workDays - leaveDays - absentDays)),
        leave_days: leaveDays,
        absent_days: absentDays,
        overtime_hours: 0,
        bonus: 0,
        allowance: 0,
        deduction: 0,
        social_insurance: 0
      };
      // 先按 0 社保算应发，再按比例取社保，最后算个税
      const pre = recalc(row);
      row.social_insurance = round2(pre.gross * SOCIAL_RATE);
      const c = recalc(row);

      if (exist) {
        db.prepare(
          `UPDATE payrolls SET employee_name=?, department=?, base_salary=?, work_days=?, actual_days=?,
            leave_days=?, absent_days=?, overtime_hours=?, overtime_pay=?, social_insurance=?, tax=?,
            gross_pay=?, net_pay=?, updated_at=? WHERE id=?`
        ).run(e.name, e.dept_name || null, baseSalary, workDays, row.actual_days, leaveDays, absentDays,
          0, c.overtimePay, row.social_insurance, c.tax, c.gross, c.net, t, exist.id);
        refreshed++;
      } else {
        ins.run(period, e.id, e.name, e.dept_name || null, baseSalary, workDays, row.actual_days,
          leaveDays, absentDays, 0, c.overtimePay, 0, 0, 0, row.social_insurance, c.tax,
          c.gross, c.net, 'draft', null, t, t);
        created++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return ok(res, { period, work_days: workDays, created, refreshed, skipped });
}));

// ---------- 调整 ----------
router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工资单不存在');
  if (row.status !== 'draft') return fail(res, 400, `当前为「${STATUS_LABELS[row.status]}」，只有草稿可调整`);
  const b = req.body || {};
  const num = (k) => (b[k] !== undefined ? Number(b[k]) || 0 : row[k]);

  const next = {
    base_salary: row.base_salary,
    work_days: row.work_days,
    absent_days: num('absent_days'),
    leave_days: num('leave_days'),
    overtime_hours: num('overtime_hours'),
    bonus: num('bonus'),
    allowance: num('allowance'),
    deduction: num('deduction'),
    social_insurance: num('social_insurance')
  };
  if (next.absent_days < 0 || next.leave_days < 0) return fail(res, 400, '缺勤/请假天数不能为负');
  const c = recalc(next);

  db.prepare(
    `UPDATE payrolls SET leave_days=?, absent_days=?, actual_days=?, overtime_hours=?, overtime_pay=?,
      bonus=?, allowance=?, deduction=?, social_insurance=?, tax=?, gross_pay=?, net_pay=?,
      remark=?, updated_at=? WHERE id=?`
  ).run(next.leave_days, next.absent_days,
    round2(Math.max(0, row.work_days - next.leave_days - next.absent_days)),
    next.overtime_hours, c.overtimePay, next.bonus, next.allowance, next.deduction,
    next.social_insurance, c.tax, c.gross, c.net,
    b.remark !== undefined ? b.remark || null : row.remark, now(), row.id);

  return ok(res, withComputed(db.prepare('SELECT * FROM payrolls WHERE id = ?').get(row.id)));
}));

// ---------- 状态流转 ----------
router.post('/:id/confirm', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工资单不存在');
  if (row.status !== 'draft') return fail(res, 400, '只有草稿可以确认');
  db.prepare("UPDATE payrolls SET status='confirmed', updated_at=? WHERE id=?").run(now(), row.id);
  return ok(res, withComputed(db.prepare('SELECT * FROM payrolls WHERE id = ?').get(row.id)));
}));

router.post('/:id/pay', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工资单不存在');
  if (row.status !== 'confirmed') return fail(res, 400, '只有「已确认」的工资单可以发放');
  db.prepare("UPDATE payrolls SET status='paid', updated_at=? WHERE id=?").run(now(), row.id);
  return ok(res, withComputed(db.prepare('SELECT * FROM payrolls WHERE id = ?').get(row.id)));
}));

// ---------- 批量 ----------
router.post('/batch', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const action = String(b.action || '');
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return fail(res, 400, '请选择工资单');
  if (!['confirm', 'pay'].includes(action)) return fail(res, 400, 'action 只能是 confirm 或 pay');
  const from = action === 'confirm' ? 'draft' : 'confirmed';
  const to = action === 'confirm' ? 'confirmed' : 'paid';

  let changed = 0, skipped = 0;
  const t = now();
  db.exec('BEGIN');
  try {
    const upd = db.prepare('UPDATE payrolls SET status = ?, updated_at = ? WHERE id = ? AND status = ?');
    ids.forEach((id) => {
      const info = upd.run(to, t, id, from);
      if (info.changes) changed++; else skipped++;
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, { action, changed, skipped });
}));

// ---------- 删除 ----------
router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工资单不存在');
  if (row.status !== 'draft') return fail(res, 400, '只有草稿可以删除');
  db.prepare('DELETE FROM payrolls WHERE id = ?').run(row.id);
  return ok(res, { deleted: 1 });
}));

module.exports = router;
