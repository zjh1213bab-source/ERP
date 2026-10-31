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
 *   应发   = 基本工资 + 加班费 + 奖金 + 补贴 + **计件工资** − 其他扣款 − 缺勤扣款
 *   计件   = 由「计件工资」模块的已确认核算单带进来，**不允许在本页手填**
 *            （手填的计件没有扎级报工依据，对不上账）
 *   个税   = (应发 − 个人社保 − 5000) 按月度税率表（3%~45%，含速算扣除数）
 *   实发   = 应发 − 个人社保 − 个税
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const privacy = require('../services/privacy');
const { reqCtx } = require('../utils/reqCtx');
const scope = require('../access/companyScope');

/**
 * 工资单的主体
 *
 * `payrolls` 一直有 `company_id`，但**从来没有写过、也没有筛过** ——
 * 一直是默认 1：分部人事生成工资单，全记到总部；而分部打开列表看到的是总部的工资。
 * 这轮补上写入与过滤。员工档案 v1.64 才有 `company_id`，所以"生成"这一步
 * 只取本主体的在职员工 —— 否则给分部生成工资单会把总部的人也带进去。
 */
// 主体过滤值：**单公司模式下恒为 null（不过滤）**，判据在 access/companyScope.js 的 of()
const cidOf = (req) => scope.filterCompanyId(req.user);

/** 取一张工资单并校验归属；跨主体按不存在处理 */
function payOr404(req, id) {
  const r = scope.assertRow(req.user, 'payrolls', id, '工资单');
  if (!r.ok) {
    const e = new Error(r.reason);
    e.status = r.status;
    throw e;
  }
  return r.row;
}

const router = express.Router();
const WRITE = ['admin', 'hr', 'finance'];
// 工资是全公司最敏感的数据：读也要限岗（原来 GET 只要求登录，任何角色都能拉全员工资）
const READ = ['admin', 'boss', 'hr', 'finance'];
// 公式抽到 services/payrollCalc.js：工资核对要拿同一份公式独立验算，
// 复制一份在核对里「看起来一致」但毫无意义
const {
  round2, STATUS_LABELS, SOCIAL_RATE, calcTax, workDaysInMonth, periodRange, recalc, withComputed
} = require('../services/payrollCalc');

function listByPeriod(period, status, companyId) {
  const where = [];
  const params = [];
  if (companyId) { where.push('company_id = ?'); params.push(Number(companyId)); }
  if (period) { where.push('period = ?'); params.push(period); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = 'SELECT * FROM payrolls ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY department, employee_id';
  return db.prepare(sql).all(...params).map(withComputed);
}

// ---------- 列表 ----------
router.get('/', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { period = '', status = '' } = req.query;
  // 工资金额一律走字段级脱敏：admin 技术权限不默认可读工资（原型的硬要求）
  return ok(res, privacy.maskRows('payrolls', listByPeriod(period, status, cidOf(req)), reqCtx(req, { action: 'list' })));
}));

// ---------- 有数据的月份 ----------
router.get('/periods', authRequired, requireRole(READ), wrap(async (req, res) => {
  // 「有工资单的月份」也要分主体：分部不该看到总部发过哪几个月、发了多少
  const cid = cidOf(req);
  const rows = db.prepare(
    'SELECT period, COUNT(*) AS cnt, SUM(net_pay) AS total FROM payrolls' +
    (cid ? ' WHERE company_id = ' + Number(cid) : '') +
    ' GROUP BY period ORDER BY period DESC'
  ).all();
  return ok(res, rows);
}));

// ---------- 汇总 ----------
router.get('/summary', authRequired, requireRole(READ), wrap(async (req, res) => {
  const period = String(req.query.period || '').trim();
  if (!period) return fail(res, 400, '缺少 period（YYYY-MM）');
  const rows = listByPeriod(period, '', cidOf(req));
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
    piece_wage: sum('piece_wage'),
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
  // 导出是最大的泄漏口：无权限的人导出来必须是掩码，并且每次导出都留痕
  const rawRows = listByPeriod(period, '', cidOf(req));
  const rows = privacy.maskRows('payrolls', rawRows, reqCtx(req, { action: 'export' }));
  privacy.markExport('payrolls', ['base_salary', 'gross_pay', 'net_pay', 'tax', 'social_insurance', 'piece_wage'],
    reqCtx(req, { note: `导出工资单 CSV ${period}`, row_count: rawRows.length }));
  const header = ['月份', '部门', '姓名', '基本工资', '应出勤', '实出勤', '请假', '缺勤',
    '加班小时', '加班费', '奖金', '补贴', '计件工资', '其他扣款', '个人社保', '个税', '应发', '实发', '状态', '备注'];
  const lines = [header.map(csvCell).join(',')];
  rows.forEach((r) => {
    lines.push([
      r.period, r.department || '', r.employee_name, r.base_salary, r.work_days, r.actual_days,
      r.leave_days, r.absent_days, r.overtime_hours, r.overtime_pay, r.bonus, r.allowance,
      r.piece_wage || 0, r.deduction, r.social_insurance, r.tax, r.gross_pay, r.net_pay,
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

  const cid = cidOf(req);
  /*
   * 只给本主体的在职员工生成 —— 否则分部生成工资单会把总部的人一起算进去。
   *
   * 另外排除「外包」（employment_type='outsource'）：外包按供应商结算，不上工资表。
   * 这一条是为了钉钉通讯录里的**共享/值守类账号**（如「消防巡查」）——
   * 它们在通讯录里是正常成员、也会打卡，但不该占一张 0 元工资单，
   * 否则每个月工资表都多出几条查不出缘由的记录。
   */
  const emps = db.prepare(
    `SELECT e.*, d.name AS dept_name FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'active'` +
    ` AND IFNULL(e.employment_type,'') <> 'outsource'` +
    (cid ? ' AND e.company_id = ' + Number(cid) : '') + ' ORDER BY e.id'
  ).all();
  if (!emps.length) return fail(res, 400, '没有在职员工，请先在「员工档案」录入');

  const workDays = workDaysInMonth(period);
  const { from, to } = periodRange(period);
  const t = now();

  // 计件工资：只认该月「已确认」的核算单。没有就一律 0 ——
  // 不做「按报工现算」，否则同一份工资单两次生成可能得到不同金额。
  const piece = require('../services/pieceWage').confirmedByEmployee(period);
  const pieceOf = (empId) => {
    const hit = piece.map.get(Number(empId));
    return hit ? round2(hit.amount) : 0;
  };

  let created = 0, refreshed = 0, skipped = 0;
  const warnings = [];   // 计件算出来了但没进单的人（已确认/已发放/未覆盖）
  const ins = db.prepare(
    `INSERT INTO payrolls (period, employee_id, employee_name, department, base_salary, work_days, actual_days,
      leave_days, absent_days, overtime_hours, overtime_pay, bonus, allowance, piece_wage, deduction,
      social_insurance, tax, gross_pay, net_pay, status, remark, created_at, updated_at, company_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  db.exec('BEGIN');
  try {
    for (const e of emps) {
      const exist = db.prepare('SELECT * FROM payrolls WHERE period = ? AND employee_id = ?').get(period, e.id);
      if (exist && !overwrite) {
        skipped++;
        const pw = pieceOf(e.id);
        if (pw > 0) {
          warnings.push({
            employee_id: e.id, employee_name: e.name, reason: '工资单已存在（未选覆盖）',
            piece_wage: pw
          });
        }
        continue;
      }
      if (exist && exist.status !== 'draft') {
        skipped++;
        // 已确认/已发放的工资单不能被覆盖（这是对的），但这人的计件就进不了单了 ——
        // 不报出来，钱就静默消失了
        const pw = pieceOf(e.id);
        if (pw > 0) {
          warnings.push({
            employee_id: e.id, employee_name: e.name,
            reason: `工资单已「${STATUS_LABELS[exist.status]}」`,
            piece_wage: pw
          });
        }
        continue;
      }

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
      // 已存在的草稿：保留人工调过的奖金/补贴/扣款/加班，只刷新出勤与计件；
      // 新单：全部从 0 起算
      const row = {
        base_salary: baseSalary,
        work_days: workDays,
        actual_days: round2(Math.max(0, workDays - leaveDays - absentDays)),
        leave_days: leaveDays,
        absent_days: absentDays,
        overtime_hours: exist ? Number(exist.overtime_hours) || 0 : 0,
        bonus: exist ? Number(exist.bonus) || 0 : 0,
        allowance: exist ? Number(exist.allowance) || 0 : 0,
        piece_wage: pieceOf(e.id),
        deduction: exist ? Number(exist.deduction) || 0 : 0,
        social_insurance: 0
      };
      // 先按 0 社保算应发，再按比例取社保，最后算个税
      const pre = recalc(row);
      row.social_insurance = round2(pre.gross * SOCIAL_RATE);
      const c = recalc(row);

      if (exist) {
        db.prepare(
          `UPDATE payrolls SET employee_name=?, department=?, base_salary=?, work_days=?, actual_days=?,
            leave_days=?, absent_days=?, overtime_hours=?, overtime_pay=?, bonus=?, allowance=?,
            piece_wage=?, deduction=?, social_insurance=?, tax=?,
            gross_pay=?, net_pay=?, updated_at=? WHERE id=?`
        ).run(e.name, e.dept_name || null, baseSalary, workDays, row.actual_days, leaveDays, absentDays,
          row.overtime_hours, c.overtimePay, row.bonus, row.allowance,
          row.piece_wage, row.deduction, row.social_insurance, c.tax, c.gross, c.net, t, exist.id);
        refreshed++;
      } else {
        ins.run(period, e.id, e.name, e.dept_name || null, baseSalary, workDays, row.actual_days,
          leaveDays, absentDays, row.overtime_hours, c.overtimePay, row.bonus, row.allowance,
          row.piece_wage, row.deduction, row.social_insurance, c.tax,
          c.gross, c.net, 'draft', null, t, t,
          // 主体跟着**员工**走：给哪家的人在算工资，这张单就属于哪家
          Number(e.company_id) || 1);
        created++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return ok(res, {
    period,
    work_days: workDays,
    created,
    refreshed,
    skipped,
    piece_wage_run: piece.run ? { run_no: piece.run.run_no, total_amount: round2(piece.run.total_amount) } : null,
    piece_wage_employees: piece.map.size,
    piece_wage_total: round2([...piece.map.values()].reduce((a, x) => a + x.amount, 0)),
    warnings
  });
}));

// ---------- 调整 ----------
router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = payOr404(req, req.params.id);
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
    social_insurance: num('social_insurance'),
    // 计件金额只认核算单，这里原样带过去（不允许在本页改）
    piece_wage: Number(row.piece_wage) || 0
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
  const row = payOr404(req, req.params.id);
  if (!row) return fail(res, 404, '工资单不存在');
  if (row.status !== 'draft') return fail(res, 400, '只有草稿可以确认');
  db.prepare("UPDATE payrolls SET status='confirmed', updated_at=? WHERE id=?").run(now(), row.id);
  return ok(res, withComputed(db.prepare('SELECT * FROM payrolls WHERE id = ?').get(row.id)));
}));

router.post('/:id/pay', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = payOr404(req, req.params.id);
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

  /**
   * 批量里混进别家的工资单 → 整批拒绝。
   * 只改一半比直接拒绝更难查：人以为都发了，实际漏了一批，而漏的那批没有任何提示。
   */
  for (const id of ids) {
    if (!scope.assertRow(req.user, 'payrolls', id, '工资单').ok) {
      return fail(res, 404, '工资单不存在');
    }
  }

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
  const row = payOr404(req, req.params.id);
  if (!row) return fail(res, 404, '工资单不存在');
  if (row.status !== 'draft') return fail(res, 400, '只有草稿可以删除');
  db.prepare('DELETE FROM payrolls WHERE id = ?').run(row.id);
  return ok(res, { deleted: 1 });
}));

module.exports = router;
