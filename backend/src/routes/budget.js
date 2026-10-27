/**
 * 预算管理（M12）
 *   /api/budget/overview          概览（当年预算、执行合计、按部门、超预算数）
 *   /api/budget/list              预算版本列表
 *   /api/budget/:id               版本详情（含明细矩阵）
 *   /api/budget                   新建编制
 *   /api/budget/:id               改编制（仅 draft）
 *   /api/budget/:id/approve       批准（编制人不能批，admin 例外）
 *   /api/budget/:id/reject        驳回（写原因）
 *   /api/budget/:id/activate      生效（同年度旧的生效预算自动关闭）
 *   /api/budget/:id/close         关闭
 *   /api/budget/execution         执行与差异
 *   /api/budget/adjustments       调整单：列表 / 申请 / 审批 / 驳回
 *   /api/budget/commitments       占用清单
 *   /api/budget/alerts            超预算留痕：列表 / 确认
 *   /api/budget/check             花钱前预检（前端试算用）
 *
 * 一条底线：预算只管「能不能花钱」，不动业务单据本身。
 * 超预算时拦在单据提交前，而不是事后算出来告诉老板超了。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { localNow, localDate } = require('../services/sla');
const B = require('../services/budget');

const router = express.Router();

const WRITE = ['admin', 'finance', 'sales'];
const ADMIN = ['admin'];

const seqNo = (prefix, table, col) => {
  const d = localDate().replace(/-/g, '');
  const n = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${col} LIKE ?`).get(`${prefix}${d}%`).c;
  return genNo(prefix, n + 1);
};

const STATUS_CN = { draft: '编制中', approved: '已批准', active: '生效中', closed: '已关闭', rejected: '已驳回' };

function budgetFull(id) {
  const b = db.prepare('SELECT * FROM budgets WHERE id=?').get(id);
  if (!b) return null;
  const items = db.prepare(
    'SELECT * FROM budget_items WHERE budget_id=? ORDER BY period, department_id, account_code'
  ).all(id);
  return { ...b, status_label: STATUS_CN[b.status] || b.status, items };
}

// ============================================================
// 字典
// ============================================================
router.get('/dict', authRequired, wrap(async (req, res) => {
  const depts = db.prepare('SELECT id,name FROM departments ORDER BY id').all();
  // 只给期间费用科目（66xx）：成本科目不该按部门编预算
  const accounts = db.prepare(
    "SELECT code,name FROM gl_accounts WHERE type='expense' AND code LIKE '66%' AND status<>'disabled' ORDER BY code"
  ).all();
  const years = db.prepare('SELECT DISTINCT fiscal_year y FROM budgets ORDER BY y DESC').all().map((x) => x.y);
  if (!years.length) years.push(Number(localDate().slice(0, 4)));
  return ok(res, {
    departments: depts,
    accounts,
    years,
    statuses: Object.entries(STATUS_CN).map(([k, v]) => ({ code: k, label: v })),
    adj_types: [
      { code: 'increase', label: '追加' },
      { code: 'decrease', label: '调减' },
      { code: 'transfer', label: '部门/科目间调剂' }
    ]
  });
}));

// ============================================================
// 概览与查询
// ============================================================
router.get('/overview', authRequired, wrap(async (req, res) => {
  const p = B.periodOf(req.query.period);
  return ok(res, B.overview(p));
}));

router.get('/list', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.year) { where.push('fiscal_year=?'); params.push(Number(req.query.year)); }
  if (req.query.status) { where.push('status=?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT * FROM budgets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY fiscal_year DESC, version DESC`
  ).all(...params).map((b) => ({ ...b, status_label: STATUS_CN[b.status] || b.status }));
  return ok(res, rows);
}));

router.get('/execution', authRequired, wrap(async (req, res) => {
  const p = B.periodOf(req.query.period);
  const r = B.execution(p, {
    department_id: req.query.department_id,
    only_diff: req.query.only_diff === '1' || req.query.only_diff === 'true'
  });
  return ok(res, { ...r, period: p, by_dept: B.byDept(p), expect_pct: B.expectPct(p) });
}));

router.get('/commitments', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('status=?'); params.push(req.query.status); }
  if (req.query.period) { where.push('period=?'); params.push(req.query.period); }
  const rows = db.prepare(
    `SELECT * FROM budget_commitments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC LIMIT 200`
  ).all(...params).map((r) => ({
    ...r,
    department_name: B.deptName(r.department_id),
    status_label: { open: '占用中', consumed: '已入账', released: '已释放' }[r.status] || r.status
  }));
  return ok(res, rows);
}));

router.get('/alerts', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('status=?'); params.push(req.query.status); }
  if (req.query.period) { where.push('period=?'); params.push(req.query.period); }
  const rows = db.prepare(
    `SELECT * FROM budget_alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`
  ).all(...params).map((r) => ({
    ...r,
    type_label: { over_budget: '超预算放行', within_tolerance: '容忍内超支', near_limit: '接近上限' }[r.type] || r.type,
    status_label: r.status === 'acked' ? '已确认' : '待确认'
  }));
  return ok(res, rows);
}));

router.post('/alerts/:id/ack', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM budget_alerts WHERE id=?').get(req.params.id);
  if (!a) return fail(res, 404, '记录不存在');
  if (a.status === 'acked') return fail(res, 400, '已经确认过了');
  const note = String((req.body || {}).note || '').trim();
  if (note.length < 4) return fail(res, 400, '确认超预算必须写处理意见（至少 4 个字）');
  db.prepare("UPDATE budget_alerts SET status='acked', acked_by=?, acked_at=?, reason=COALESCE(reason||' | ','')||? WHERE id=?")
    .run(req.user.username, localNow(), note, a.id);
  return ok(res, { id: a.id, status: 'acked' });
}));

router.get('/:id', authRequired, wrap(async (req, res) => {
  const b = budgetFull(req.params.id);
  if (!b) return fail(res, 404, '预算不存在');
  // 顺便把每项的当前执行带出来，编制页也能看到实际
  b.items = b.items.map((it) => {
    const u = B.usage(it.department_id, it.account_code, it.period);
    return { ...it, actual: u.actual, committed: u.committed, used: u.used };
  });
  return ok(res, b);
}));

// ============================================================
// 编制
// ============================================================
function validateItems(items, year) {
  const errs = [];
  const clean = [];
  (items || []).forEach((it, i) => {
    const period = String(it.period || '');
    if (!/^\d{4}-\d{2}$/.test(period)) { errs.push(`第 ${i + 1} 行月份格式应为 YYYY-MM`); return; }
    if (Number(period.slice(0, 4)) !== Number(year)) { errs.push(`第 ${i + 1} 行月份 ${period} 不属于 ${year} 年`); return; }
    if (!it.account_code) { errs.push(`第 ${i + 1} 行缺科目`); return; }
    if (!B.isBudgetable(it.account_code)) { errs.push(`科目 ${it.account_code} 不能编预算（只允许 66 开头的期间费用科目）`); return; }
    const amt = Number(it.amount);
    if (!(amt >= 0)) { errs.push(`第 ${i + 1} 行金额不能为负`); return; }
    const dept = it.department_id === null || it.department_id === undefined || it.department_id === ''
      ? null : Number(it.department_id);
    if (dept !== null && !db.prepare('SELECT id FROM departments WHERE id=?').get(dept)) {
      errs.push(`第 ${i + 1} 行部门 ${dept} 不存在`); return;
    }
    const a = B.acctOf(it.account_code);
    clean.push({
      department_id: dept,
      department_name: dept ? B.deptName(dept) : '未分配部门',
      account_code: it.account_code,
      account_name: a ? a.name : null,
      period,
      amount: B.r2(amt),
      note: it.note || null
    });
  });
  return { errs, clean };
}

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const year = Number(b.fiscal_year);
  if (!year || year < 2020 || year > 2100) return fail(res, 400, '预算年度不正确（2020–2100）');
  if (!String(b.name || '').trim()) return fail(res, 400, '预算名称必填');
  const tol = b.tolerance_pct === undefined ? 0 : Number(b.tolerance_pct);
  if (!(tol >= 0 && tol <= 50)) return fail(res, 400, '容忍比例应在 0–50 之间（0 表示硬控）');

  const { errs, clean } = validateItems(b.items, year);
  if (errs.length) return fail(res, 400, errs[0] + (errs.length > 1 ? `（另有 ${errs.length - 1} 处问题）` : ''));
  if (!clean.length) return fail(res, 400, '至少要有一条预算明细，空预算等于没有预算');

  const ver = (db.prepare('SELECT COALESCE(MAX(version),0) v FROM budgets WHERE fiscal_year=?').get(year).v) + 1;
  const no = `YS${year}` + (ver > 1 ? `-V${ver}` : '');
  if (db.prepare('SELECT id FROM budgets WHERE budget_no=?').get(no)) {
    return fail(res, 400, `预算号 ${no} 已存在，请调整版本号`);
  }

  const t = localNow();
  db.exec('BEGIN');
  try {
    const id = db.prepare(
      `INSERT INTO budgets (budget_no,fiscal_year,company_id,name,version,status,total_amount,item_count,
         tolerance_pct,is_current,note,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,'draft',0,0,?,0,?,?,?,?)`
    ).run(no, year, b.company_id || 1, String(b.name).trim(), ver, tol, b.note || null,
      req.user.username, t, t).lastInsertRowid;

    const ins = db.prepare(
      `INSERT INTO budget_items (budget_id,department_id,department_name,account_code,account_name,period,amount,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(budget_id,department_id,account_code,period) DO UPDATE SET
         amount=excluded.amount, note=excluded.note, updated_at=excluded.updated_at`
    );
    clean.forEach((it) => ins.run(id, it.department_id, it.department_name, it.account_code,
      it.account_name, it.period, it.amount, it.note, t, t));

    const stat = B.refreshBudget(id);
    db.exec('COMMIT');
    return ok(res, { id, budget_no: no, version: ver, total_amount: stat.total, item_count: stat.count });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!b) return fail(res, 404, '预算不存在');

  const bd = req.body || {};
  const wantAmount = Array.isArray(bd.items);

  // 生效/已批准/已关闭的预算不能直接改数，只能走调整单
  if (b.status !== 'draft' && wantAmount) {
    return fail(res, 400, `${STATUS_CN[b.status]}的预算不能直接改明细，请走「调整单」并审批，否则历史执行对比会失真`);
  }

  let clean = null;
  if (wantAmount) {
    const { errs, clean: c } = validateItems(bd.items, b.fiscal_year);
    if (errs.length) return fail(res, 400, errs[0] + (errs.length > 1 ? `（另有 ${errs.length - 1} 处问题）` : ''));
    if (!c.length) return fail(res, 400, '预算明细不能清空');
    clean = c;
  }

  const tol = bd.tolerance_pct === undefined ? b.tolerance_pct : Number(bd.tolerance_pct);
  if (bd.tolerance_pct !== undefined && !(tol >= 0 && tol <= 50)) {
    return fail(res, 400, '容忍比例应在 0–50 之间');
  }

  const t = localNow();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE budgets SET name=?, tolerance_pct=?, note=?, updated_at=? WHERE id=?')
      .run(bd.name ? String(bd.name).trim() : b.name, tol,
        bd.note === undefined ? b.note : bd.note, t, b.id);
    if (clean) {
      db.prepare('DELETE FROM budget_items WHERE budget_id=?').run(b.id);
      const ins = db.prepare(
        `INSERT INTO budget_items (budget_id,department_id,department_name,account_code,account_name,period,amount,note,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      clean.forEach((it) => ins.run(b.id, it.department_id, it.department_name, it.account_code,
        it.account_name, it.period, it.amount, it.note, t, t));
      B.refreshBudget(b.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, budgetFull(b.id));
}));

/** 删除编制：只有「编制中/已驳回」且没有任何占用引用时才能删，避免把在用的预算删掉 */
router.delete('/:id', authRequired, requireRole(ADMIN), wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!b) return fail(res, 404, '预算不存在');
  // 只要还没生效（draft / rejected / approved）就能删；生效或已关闭的不能删，只能关闭
  if (!['draft', 'rejected', 'approved'].includes(b.status)) {
    return fail(res, 400, `「${STATUS_CN[b.status]}」的预算不能删除，只能关闭`);
  }
  // 只拦「还在生效引用」的：已释放的占用、已驳回的调整单不算
  const used = db.prepare("SELECT COUNT(*) c FROM budget_commitments WHERE budget_id=? AND status='open'").get(b.id).c;
  if (used) return fail(res, 400, `还有 ${used} 条占用引用这份预算，不能删除`);
  const adj = db.prepare("SELECT COUNT(*) c FROM budget_adjustments WHERE budget_id=? AND status<>'rejected'").get(b.id).c;
  if (adj) return fail(res, 400, `还有 ${adj} 张调整单引用这份预算，不能删除`);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM budget_items WHERE budget_id=?').run(b.id);
    db.prepare('DELETE FROM budgets WHERE id=?').run(b.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, { deleted: 1, budget_no: b.budget_no });
}));

// ============================================================
// 审批与生效
// ============================================================
router.post('/:id/approve', authRequired, requireRole(ADMIN.concat(['finance'])), wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!b) return fail(res, 404, '预算不存在');
  if (b.status !== 'draft') return fail(res, 400, `当前状态是「${STATUS_CN[b.status]}」，只有编制中可以批准`);
  if (b.created_by === req.user.username && req.user.role !== 'admin') {
    return fail(res, 400, '自己编的预算不能自己批，请让财务负责人或管理员批准');
  }
  const stat = B.refreshBudget(b.id);
  if (!stat.count) return fail(res, 400, '预算没有明细，不能批准');
  db.prepare("UPDATE budgets SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?")
    .run(req.user.username, localNow(), localNow(), b.id);
  return ok(res, { id: b.id, status: 'approved', total_amount: stat.total, item_count: stat.count });
}));

router.post('/:id/reject', authRequired, requireRole(ADMIN.concat(['finance'])), wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!b) return fail(res, 404, '预算不存在');
  if (b.status !== 'draft') return fail(res, 400, '只有编制中的预算可以驳回');
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 4) return fail(res, 400, '驳回必须写原因（至少 4 个字）');
  db.prepare("UPDATE budgets SET status='rejected', reject_reason=?, updated_at=? WHERE id=?")
    .run(reason, localNow(), b.id);
  return ok(res, { id: b.id, status: 'rejected' });
}));

router.post('/:id/activate', authRequired, requireRole(ADMIN), wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!b) return fail(res, 404, '预算不存在');
  if (b.status !== 'approved') return fail(res, 400, `只有已批准的预算可以生效，当前是「${STATUS_CN[b.status]}」`);

  const t = localNow();
  db.exec('BEGIN');
  try {
    // 同年度只允许一份生效：旧的自动关闭，避免两套预算同时控制
    const old = db.prepare("SELECT * FROM budgets WHERE fiscal_year=? AND status='active' AND id<>?").all(b.fiscal_year, b.id);
    old.forEach((o) => {
      db.prepare("UPDATE budgets SET status='closed', is_current=0, closed_by=?, closed_at=?, updated_at=? WHERE id=?")
        .run(req.user.username, t, t, o.id);
    });
    db.prepare("UPDATE budgets SET status='active', is_current=1, updated_at=? WHERE id=?").run(t, b.id);
    db.exec('COMMIT');
    return ok(res, { id: b.id, status: 'active', closed_previous: old.map((o) => o.budget_no) });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

router.post('/:id/close', authRequired, requireRole(ADMIN), wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!b) return fail(res, 404, '预算不存在');
  if (b.status !== 'active') return fail(res, 400, '只有生效中的预算可以关闭');
  db.prepare("UPDATE budgets SET status='closed', is_current=0, closed_by=?, closed_at=?, updated_at=? WHERE id=?")
    .run(req.user.username, localNow(), localNow(), b.id);
  return ok(res, { id: b.id, status: 'closed' });
}));

// ============================================================
// 调整单
// ============================================================
router.get('/adjustments/list', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('status=?'); params.push(req.query.status); }
  if (req.query.budget_id) { where.push('budget_id=?'); params.push(Number(req.query.budget_id)); }
  const rows = db.prepare(
    `SELECT * FROM budget_adjustments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`
  ).all(...params).map((a) => ({
    ...a,
    type_label: { increase: '追加', decrease: '调减', transfer: '调剂' }[a.type] || a.type,
    status_label: { pending: '待审批', approved: '已批准', rejected: '已驳回' }[a.status] || a.status,
    from_department_name: a.from_department_id ? B.deptName(a.from_department_id) : null,
    to_department_name: a.to_department_id ? B.deptName(a.to_department_id) : null
  }));
  return ok(res, rows);
}));

router.post('/adjustments', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const budget = db.prepare('SELECT * FROM budgets WHERE id=?').get(Number(b.budget_id));
  if (!budget) return fail(res, 400, '预算不存在');
  if (!['approved', 'active'].includes(budget.status)) {
    return fail(res, 400, `「${STATUS_CN[budget.status]}」的预算不需要调整单，直接改编制即可`);
  }
  const type = b.type;
  if (!['increase', 'decrease', 'transfer'].includes(type)) return fail(res, 400, '调整类型只能是 increase / decrease / transfer');
  const period = String(b.period || '');
  if (!/^\d{4}-\d{2}$/.test(period)) return fail(res, 400, '调整月份格式应为 YYYY-MM');
  if (Number(period.slice(0, 4)) !== Number(budget.fiscal_year)) return fail(res, 400, '调整月份不在该预算年度内');
  const amount = Number(b.amount);
  if (!(amount > 0)) return fail(res, 400, '调整金额必须大于 0');
  const reason = String(b.reason || '').trim();
  if (reason.length < 8) return fail(res, 400, '调整原因至少 8 个字（预算变动要能讲清楚为什么）');

  const per = db.prepare('SELECT status FROM gl_periods WHERE period=?').get(period);
  if (per && per.status === 'closed') return fail(res, 400, `${period} 已关账，不能再调整预算`);

  const needFrom = type !== 'increase';
  const needTo = type !== 'decrease';
  if (needFrom && !b.from_account_code) return fail(res, 400, '请指定调出科目');
  if (needTo && !b.to_account_code) return fail(res, 400, '请指定调入科目');
  for (const c of [b.from_account_code, b.to_account_code].filter(Boolean)) {
    if (!B.isBudgetable(c)) return fail(res, 400, `科目 ${c} 不能编预算（只允许 66 开头的期间费用科目）`);
  }

  const no = seqNo('TZ', 'budget_adjustments', 'adj_no');
  const t = localNow();
  const id = db.prepare(
    `INSERT INTO budget_adjustments (adj_no,budget_id,type,from_department_id,from_account_code,to_department_id,
       to_account_code,period,amount,reason,status,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
  ).run(no, budget.id, type,
    b.from_department_id || null, b.from_account_code || null,
    b.to_department_id || null, b.to_account_code || null,
    period, B.r2(amount), reason, req.user.username, t).lastInsertRowid;

  return ok(res, { id, adj_no: no, status: 'pending' });
}));

router.post('/adjustments/:id/approve', authRequired, requireRole(ADMIN.concat(['finance'])), wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM budget_adjustments WHERE id=?').get(req.params.id);
  if (!a) return fail(res, 404, '调整单不存在');
  if (a.status !== 'pending') return fail(res, 400, `该调整单已是「${a.status === 'approved' ? '已批准' : '已驳回'}」状态`);
  if (a.created_by === req.user.username && req.user.role !== 'admin') {
    return fail(res, 400, '自己提的调整单不能自己批');
  }

  const budget = db.prepare('SELECT * FROM budgets WHERE id=?').get(a.budget_id);
  if (!budget) return fail(res, 404, '预算不存在');

  const getItem = (dept, code) => db.prepare(
    'SELECT * FROM budget_items WHERE budget_id=? AND account_code=? AND period=? AND ' +
    (dept ? 'department_id=?' : 'department_id IS NULL')
  ).get(...(dept ? [budget.id, code, a.period, dept] : [budget.id, code, a.period]));

  const t = localNow();
  db.exec('BEGIN');
  try {
    const apply = (dept, code, delta) => {
      const it = getItem(dept, code);
      if (!it) {
        if (delta < 0) throw new Error(`科目 ${code} 在 ${a.period} 没有预算，无法调减`);
        db.prepare(
          `INSERT INTO budget_items (budget_id,department_id,department_name,account_code,account_name,period,amount,note,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(budget.id, dept || null, dept ? B.deptName(dept) : '未分配部门', code,
          (B.acctOf(code) || {}).name || null, a.period, B.r2(delta), `调整单 ${a.adj_no}`, t, t);
        return;
      }
      const nextAmount = B.r2(Number(it.amount) + delta);
      if (nextAmount < 0) throw new Error(`科目 ${code} 调整后预算为负（原 ${it.amount}，调整 ${delta}）`);
      db.prepare('UPDATE budget_items SET amount=?, updated_at=? WHERE id=?').run(nextAmount, t, it.id);
    };

    if (a.type === 'increase') {
      apply(a.to_department_id, a.to_account_code, a.amount);
    } else if (a.type === 'decrease') {
      apply(a.from_department_id, a.from_account_code, -a.amount);
    } else {
      // 调剂：先扣后加，任何一步失败整体回滚
      apply(a.from_department_id, a.from_account_code, -a.amount);
      apply(a.to_department_id, a.to_account_code, a.amount);
    }

    db.prepare("UPDATE budget_adjustments SET status='approved', approved_by=?, approved_at=? WHERE id=?")
      .run(req.user.username, t, a.id);
    B.refreshBudget(budget.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, { id: a.id, status: 'approved' });
}));

router.post('/adjustments/:id/reject', authRequired, requireRole(ADMIN.concat(['finance'])), wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM budget_adjustments WHERE id=?').get(req.params.id);
  if (!a) return fail(res, 404, '调整单不存在');
  if (a.status !== 'pending') return fail(res, 400, '只有待审批的调整单可以驳回');
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 4) return fail(res, 400, '驳回必须写原因');
  db.prepare("UPDATE budget_adjustments SET status='rejected', reject_reason=?, approved_by=?, approved_at=? WHERE id=?")
    .run(reason, req.user.username, localNow(), a.id);
  return ok(res, { id: a.id, status: 'rejected' });
}));

// ============================================================
// 预检
// ============================================================
router.post('/check', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.account_code) return fail(res, 400, '请指定科目');
  if (!(Number(b.amount) > 0)) return fail(res, 400, '金额必须大于 0');
  const r = B.check({
    department_id: b.department_id, account_code: b.account_code,
    period: b.period, amount: b.amount, operator: req.user.username,
    source_type: 'preview', source_no: '预检'
  });
  return ok(res, r);
}));

module.exports = router;
