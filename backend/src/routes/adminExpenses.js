/**
 * 行政费用
 * GET    /api/admin-expenses?from=&to=&category=&q=
 * GET    /api/admin-expenses/summary?from=&to=     合计 / 按类别 / 按月 / 按付款方式
 * GET    /api/admin-expenses/export?from=&to=      导出 CSV
 * POST   /api/admin-expenses
 * PUT    /api/admin-expenses/:id
 * DELETE /api/admin-expenses/:id
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const B = require('../services/budget');

const router = express.Router();
const WRITE = ['admin', 'hr', 'finance'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const CATEGORIES = ['房租', '水电', '办公', '差旅', '招待', '快递', '薪酬福利', '其他'];

function filters(q) {
  const where = [];
  const params = [];
  if (q.from) { where.push('expense_date >= ?'); params.push(q.from); }
  if (q.to) { where.push('expense_date <= ?'); params.push(q.to); }
  if (q.category) { where.push('category = ?'); params.push(q.category); }
  if (q.q) { where.push('(payee LIKE ? OR handler LIKE ? OR remark LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  return { where, params };
}

router.get('/', authRequired, wrap(async (req, res) => {
  const { where, params } = filters(req.query);
  const sql = 'SELECT * FROM admin_expenses ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY expense_date DESC, id DESC LIMIT 1000';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/meta', authRequired, wrap(async (req, res) => {
  return ok(res, { categories: CATEGORIES });
}));

router.get('/summary', authRequired, wrap(async (req, res) => {
  const { where, params } = filters(req.query);
  const w = where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '';
  const rows = db.prepare('SELECT * FROM admin_expenses ' + w).all(...params);
  const total = round2(rows.reduce((s, r) => s + Number(r.amount || 0), 0));

  const byCategory = {};
  rows.forEach((r) => {
    const k = r.category || '其他';
    byCategory[k] = round2((byCategory[k] || 0) + Number(r.amount || 0));
  });
  const byMonth = {};
  rows.forEach((r) => {
    const k = String(r.expense_date || '').slice(0, 7);
    if (!k) return;
    byMonth[k] = round2((byMonth[k] || 0) + Number(r.amount || 0));
  });
  const byMethod = {};
  rows.forEach((r) => {
    const k = r.payment_method || '未填';
    byMethod[k] = round2((byMethod[k] || 0) + Number(r.amount || 0));
  });

  return ok(res, {
    count: rows.length,
    total,
    byCategory: Object.entries(byCategory).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
    byMonth: Object.entries(byMonth).map(([month, amount]) => ({ month, amount })).sort((a, b) => a.month.localeCompare(b.month)),
    byMethod: Object.entries(byMethod).map(([method, amount]) => ({ method, amount })).sort((a, b) => b.amount - a.amount)
  });
}));

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/export', authRequired, wrap(async (req, res) => {
  const { where, params } = filters(req.query);
  const sql = 'SELECT * FROM admin_expenses ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY expense_date DESC, id DESC';
  const rows = db.prepare(sql).all(...params);
  const header = ['日期', '类别', '金额', '收款方', '经办人', '付款方式', '备注'];
  const lines = [header.map(csvCell).join(',')];
  rows.forEach((r) => {
    lines.push([r.expense_date, r.category, r.amount, r.payee || '', r.handler || '', r.payment_method || '', r.remark || '']
      .map(csvCell).join(','));
  });
  // 接入统一导出出口：补导出记录 + 文件头水印（费用明细含收款方与经办人，属敏感数据）
  const ex = require('../services/exportGuard').logExternal({
    def_key: null,
    params: { ...req.query },
    user: req.user,
    ctx: require('../utils/reqCtx').reqCtx(req, { action: 'export' }),
    note: '行政费用明细（既有端点）',
    row_count: rows.length
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="admin-expenses.csv"');
  res.setHeader('X-Export-Job', ex.job_no);
  res.setHeader('X-Export-Watermark', ex.watermark);
  return res.send('\uFEFF' + ex.watermark_line + '\r\n' + lines.join('\r\n'));
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.expense_date) return fail(res, 400, '费用日期必填');
  if (!(Number(b.amount) > 0)) return fail(res, 400, '金额必须大于 0');

  const deptId = b.department_id === undefined || b.department_id === '' ? null : Number(b.department_id);
  if (deptId !== null && !db.prepare('SELECT id FROM departments WHERE id=?').get(deptId)) {
    return fail(res, 400, '部门不存在');
  }

  // 预算校验：只对带部门的费用做（老流程不带部门不拦，但也不会进预算执行）
  if (deptId) {
    const chk = B.check({
      department_id: deptId,
      account_code: b.account_code || '6602',
      period: B.periodOf(b.expense_date),
      amount: b.amount,
      source_type: 'expense',
      source_no: b.category || '行政费用',
      operator: req.user.username,
      allow_over: !!b.allow_over,
      over_reason: b.over_reason
    });
    if (!chk.ok) return fail(res, 400, chk.message || '超出预算');
    if (chk.code === 'overridden' || chk.code === 'within_tolerance') {
      // 放行但把说明也存下来，事后能解释为什么超了
      b.budget_reason = b.over_reason || chk.message;
    }
  }

  const info = db.prepare(
    'INSERT INTO admin_expenses (expense_date, category, amount, payee, handler, payment_method, remark, department_id, budget_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(b.expense_date, b.category || '其他', round2(b.amount), b.payee || null,
    b.handler || (req.user && req.user.username) || null, b.payment_method || null, b.remark || null,
    deptId, b.budget_reason || null, now());

  // 先按住额度：凭证还没生成之前，这笔钱在预算上算「已占用」
  if (deptId) {
    B.commit({
      department_id: deptId,
      account_code: b.account_code || '6602',
      period: B.periodOf(b.expense_date),
      amount: b.amount,
      source_type: 'expense',
      source_id: Number(info.lastInsertRowid),
      source_no: `${b.category || '费用'} ${b.payee || ''}`.trim(),
      remark: b.budget_reason || null,
      operator: req.user.username
    });
  }

  return ok(res, db.prepare('SELECT * FROM admin_expenses WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM admin_expenses WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '费用记录不存在');
  const b = req.body || {};

  const nextDept = b.department_id === undefined ? row.department_id
    : (b.department_id === '' || b.department_id === null ? null : Number(b.department_id));
  const nextAmount = b.amount !== undefined ? round2(b.amount) : row.amount;
  const nextDate = b.expense_date || row.expense_date;

  // 金额或部门变了，占用要重算：先把旧的释放，再按新值检查 + 占住
  const changed = Number(nextAmount) !== Number(row.amount) || Number(nextDept || 0) !== Number(row.department_id || 0);
  if (changed && nextDept) {
    B.release('expense', row.id, '费用修改，释放原占用');
    const chk = B.check({
      department_id: nextDept, account_code: '6602', period: B.periodOf(nextDate),
      amount: nextAmount, source_type: 'expense', operator: req.user.username,
      allow_over: !!b.allow_over, over_reason: b.over_reason
    });
    if (!chk.ok) return fail(res, 400, chk.message || '超出预算');
    B.commit({
      department_id: nextDept, account_code: '6602', period: B.periodOf(nextDate),
      amount: nextAmount, source_type: 'expense', source_id: row.id,
      source_no: `${b.category || row.category || '费用'} ${b.payee || row.payee || ''}`.trim(),
      operator: req.user.username
    });
  }

  db.prepare(
    'UPDATE admin_expenses SET expense_date=?, category=?, amount=?, payee=?, handler=?, payment_method=?, remark=?, department_id=? WHERE id=?'
  ).run(
    b.expense_date || row.expense_date,
    b.category || row.category,
    b.amount !== undefined ? round2(b.amount) : row.amount,
    b.payee !== undefined ? b.payee || null : row.payee,
    b.handler !== undefined ? b.handler || null : row.handler,
    b.payment_method !== undefined ? b.payment_method || null : row.payment_method,
    b.remark !== undefined ? b.remark || null : row.remark,
    nextDept,
    row.id
  );
  return ok(res, db.prepare('SELECT * FROM admin_expenses WHERE id = ?').get(row.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM admin_expenses WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '费用记录不存在');
  db.prepare('DELETE FROM admin_expenses WHERE id = ?').run(req.params.id);
  // 删掉费用就把预算额度放回来，否则额度被一条不存在的单据永久占着
  if (row.department_id) B.release('expense', row.id, '费用删除，释放占用');
  return ok(res, { deleted: 1 });
}));

module.exports = router;
