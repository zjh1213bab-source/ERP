/**
 * 预算管理服务（M12）
 *
 * 核心口径（三个数决定能不能花）：
 *   预算  budget_items.amount
 *   已发生 gl_entries（该部门 · 该科目 · 该月份）借方 − 贷方
 *   已承诺 budget_commitments(status='open')：单据已提交但还没入账，先把额度按住
 *   可用 = 预算 − 已发生 − 已承诺
 *
 * 为什么要有「已承诺」：费用单提交了、凭证还没生成的那几天，
 * 如果只看已入账，会出现「账面还有额度 → 大家都去花 → 月底一起超」。
 *
 * 硬规则：
 *   1. 只有 approved/active 的预算参与控制，draft 不生效
 *   2. 生效预算不能直接改金额，只能走调整单（审批后才落）
 *   3. 审批人 ≠ 编制人（admin 例外，单人店铺需要）
 *   4. 预算生效后，某部门某科目某月没编预算 = 额度 0 → 硬拦；
 *      例外必须显式传 allow_over + 超预算说明（≥8 字），并留 alert
 *   5. 只控费用类科目（expense），资产/负债不参与
 *   6. 已关账期间不能提交新占用
 */
const { db } = require('../db');
const { localNow, localDate } = require('./sla');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;
const periodOf = (d) => String(d || localDate()).slice(0, 7);

/** 科目类型（拿不到就当不是费用类，不参与控制） */
function acctOf(code) {
  return db.prepare('SELECT * FROM gl_accounts WHERE code=?').get(String(code || ''));
}
function isExpense(code) {
  const a = acctOf(code);
  return a && a.type === 'expense';
}

/**
 * 能不能编预算：只允许「期间费用」科目（66 开头）。
 * 6401 主营业务成本虽然是损益类，但它是随销量结转的成本，不是可以按部门预先分配的费用，
 * 把它放进预算只会让编制页多一列永远填不上的 0。
 */
function isBudgetable(code) {
  const c = String(code || '');
  if (!c.startsWith('66')) return false;
  return isExpense(c);
}

/** 某期间的生效预算 */
function budgetOf(period) {
  const year = Number(String(period || '').slice(0, 4));
  return db.prepare(
    "SELECT * FROM budgets WHERE fiscal_year=? AND status='active' ORDER BY id DESC LIMIT 1"
  ).get(year) || null;
}

/** 预算明细（含部门为空的「未分配」项） */
function itemOf(budgetId, deptId, code, period) {
  if (!budgetId) return null;
  const d = deptId === null || deptId === undefined || deptId === '' ? null : Number(deptId);
  if (d === null) {
    return db.prepare(
      'SELECT * FROM budget_items WHERE budget_id=? AND department_id IS NULL AND account_code=? AND period=?'
    ).get(budgetId, code, period) || null;
  }
  return db.prepare(
    'SELECT * FROM budget_items WHERE budget_id=? AND department_id=? AND account_code=? AND period=?'
  ).get(budgetId, d, code, period) || null;
}

/** 已入账：该部门该科目该期间的净发生额（借方 − 贷方） */
function actualOf(deptId, code, period) {
  const d = deptId === null || deptId === undefined || deptId === '' ? null : Number(deptId);
  const row = d === null
    ? db.prepare(
      `SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM gl_entries
       WHERE period=? AND account_code=? AND department_id IS NULL`
    ).get(period, code)
    : db.prepare(
      `SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM gl_entries
       WHERE period=? AND account_code=? AND department_id=?`
    ).get(period, code, d);
  return r2(num(row.d) - num(row.c));
}

/** 已承诺：尚未入账的占用合计 */
function committedOf(deptId, code, period) {
  const d = deptId === null || deptId === undefined || deptId === '' ? null : Number(deptId);
  const row = d === null
    ? db.prepare(
      `SELECT COALESCE(SUM(amount),0) s FROM budget_commitments
       WHERE status='open' AND period=? AND account_code=? AND department_id IS NULL`
    ).get(period, code)
    : db.prepare(
      `SELECT COALESCE(SUM(amount),0) s FROM budget_commitments
       WHERE status='open' AND period=? AND account_code=? AND department_id=?`
    ).get(period, code, d);
  return r2(row.s);
}

/** 一个格子的完整口径 */
function usage(deptId, code, period) {
  const b = budgetOf(period);
  const item = b ? itemOf(b.id, deptId, code, period) : null;
  const budget = item ? r2(item.amount) : 0;
  const actual = actualOf(deptId, code, period);
  const committed = committedOf(deptId, code, period);
  const used = r2(actual + committed);
  const available = r2(budget - used);
  return {
    budget_id: b ? b.id : null,
    has_budget: !!b,
    has_item: !!item,
    department_id: deptId === null || deptId === undefined || deptId === '' ? null : Number(deptId),
    account_code: code,
    account_name: (acctOf(code) || {}).name || '',
    period,
    budget, actual, committed, used, available,
    used_pct: budget > 0 ? Math.round((used / budget) * 1000) / 10 : (used > 0 ? 100 : 0),
    expect_pct: expectPct(period)
  };
}

/** 时间进度：用来判断「花得快不快」，月内按日推进 */
function expectPct(period) {
  const today = localDate();
  const cur = periodOf(today);
  if (period > cur) return 0;
  if (period < cur) return 100;
  const day = Number(today.slice(8, 10));
  return Math.round((day / 30) * 1000) / 10;
}

/** 记一条超预算留痕 */
function alert({ budget_id, department_id, account_code, period, type, budget, used, over, source_type, source_id, source_no, reason, operator }) {
  const a = acctOf(account_code);
  const d = department_id ? db.prepare('SELECT name FROM departments WHERE id=?').get(department_id) : null;
  db.prepare(
    `INSERT INTO budget_alerts (budget_id,department_id,department_name,account_code,account_name,period,type,
       budget_amount,used_amount,over_amount,source_type,source_id,source_no,reason,operator,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?)`
  ).run(budget_id || null, department_id || null, d ? d.name : null, account_code || null,
    a ? a.name : null, period, type, r2(budget), r2(used), r2(over),
    source_type || null, source_id || null, source_no || null, reason || null, operator || null, localNow());
}

/**
 * 花钱前的检查
 * @returns {{ok:boolean, skipped?:string, code?:string, message?:string, ...usage}}
 */
function check({ department_id, account_code, period, amount, source_type, source_id, source_no, operator, allow_over, over_reason }) {
  const p = periodOf(period);
  if (!account_code) return { ok: true, skipped: 'no_account' };
  if (!isBudgetable(account_code)) return { ok: true, skipped: 'not_expense' };
  // 没填部门的老流程不控（渐进上线），但前端应提示补部门
  if (department_id === null || department_id === undefined || department_id === '') {
    return { ok: true, skipped: 'no_department' };
  }

  const b = budgetOf(p);
  if (!b) return { ok: true, skipped: 'no_budget' };

  // 已关账期间不能再新增占用
  const per = db.prepare('SELECT status FROM gl_periods WHERE period=?').get(p);
  if (per && per.status === 'closed') {
    return { ok: false, code: 'period_closed', message: `${p} 已关账，不能再占用预算（需先反关账）` };
  }

  const u = usage(department_id, account_code, p);
  const amt = r2(amount);
  const after = r2(u.used + amt);
  const over = r2(after - u.budget);
  const tolPct = num(b.tolerance_pct);
  const message0 = `${u.account_name || account_code}：预算 ${u.budget}，已用 ${u.used}（已发生 ${u.actual} + 已占用 ${u.committed}），本次 ${amt}`;
  const base = { ...u, amount: amt, after, over, code: 'ok', message: message0 };

  if (!u.has_item && u.budget === 0) {
    // 预算生效了但这一格没编 → 额度 0 → 硬拦（例外要写说明）
    if (allow_over && String(over_reason || '').trim().length >= 8) {
      alert({ budget_id: b.id, department_id, account_code, period: p, type: 'within_tolerance',
        budget: 0, used: after, over, source_type, source_id, source_no, reason: over_reason, operator });
      return { ...base, ok: true, code: 'overridden',
        message: `${message0}；该科目本月未编预算，按特批放行（已留痕）` };
    }
    return { ...base, ok: false, code: 'no_budget_item',
      message: `${message0}；但${u.account_name || account_code}本月没有编预算，额度按 0 计，需要先补预算或走特批（写超预算说明）` };
  }

  if (over <= 0.01) {
    const near = u.budget > 0 && after / u.budget >= 0.9;
    return { ...base, ok: true, code: near ? 'near_limit' : 'ok',
      message: message0 + (near ? `；已用到 ${Math.round((after / u.budget) * 100)}%，注意节奏` : '') };
  }

  // 超了：容忍比例内放行但记留痕
  const allow = u.budget > 0 ? u.budget * (1 + tolPct / 100) : 0;
  if (after <= allow + 0.01) {
    alert({ budget_id: b.id, department_id, account_code, period: p, type: 'within_tolerance',
      budget: u.budget, used: after, over, source_type, source_id, source_no,
      reason: `容忍范围 ${tolPct}% 内超支`, operator });
    return { ...base, ok: true, code: 'within_tolerance',
      message: `${message0}；超预算 ${over}，但在容忍范围（${tolPct}%）内，已留痕` };
  }

  if (allow_over && String(over_reason || '').trim().length >= 8) {
    alert({ budget_id: b.id, department_id, account_code, period: p, type: 'over_budget',
      budget: u.budget, used: after, over, source_type, source_id, source_no, reason: over_reason, operator });
    return { ...base, ok: true, code: 'overridden',
      message: `${message0}；超预算 ${over}，按特批放行（已留痕）` };
  }

  return { ...base, ok: false, code: 'over_budget',
    message: `${message0}；超预算 ${over}（可用 ${u.available}）。请先补预算/走调整单，或填超预算说明申请特批` };
}

/** 占用：单据提交时先把额度按住 */
function commit({ department_id, account_code, period, amount, source_type, source_id, source_no, remark, operator }) {
  const p = periodOf(period);
  if (!department_id || !account_code || num(amount) <= 0) return null;
  const b = budgetOf(p);
  const r = db.prepare(
    `INSERT INTO budget_commitments (budget_id,department_id,account_code,period,source_type,source_id,source_no,
       amount,status,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,'open',?,?,?)`
  ).run(b ? b.id : null, Number(department_id), account_code, p, source_type, source_id || null,
    source_no || null, r2(amount), remark || null, operator || null, localNow());
  return r.lastInsertRowid;
}

/** 入账后：把占用转成「已消费」，避免和已发生重复计 */
function consume(source_type, source_id) {
  return db.prepare(
    "UPDATE budget_commitments SET status='consumed', settled_at=? WHERE source_type=? AND source_id=? AND status='open'"
  ).run(localNow(), source_type, source_id).changes;
}

/** 撤回：单据作废/删除时把额度放回去 */
function release(source_type, source_id, reason) {
  return db.prepare(
    "UPDATE budget_commitments SET status='released', settled_at=?, release_reason=? WHERE source_type=? AND source_id=? AND status='open'"
  ).run(localNow(), reason || null, source_type, source_id).changes;
}

/** 执行明细：某期间全部预算项 + 实际 + 可用 */
function execution(period, { department_id, only_diff } = {}) {
  const b = budgetOf(period);
  if (!b) return { budget: null, rows: [], totals: {} };
  const where = ['budget_id=?'];
  const params = [b.id, period];
  let sql = `SELECT * FROM budget_items WHERE budget_id=? AND period=?`;
  if (department_id) { sql += ' AND department_id=?'; params.push(Number(department_id)); }
  const items = db.prepare(sql + ' ORDER BY department_id, account_code').all(...params);

  const rows = items.map((it) => {
    const u = usage(it.department_id, it.account_code, period);
    return {
      ...u,
      item_id: it.id,
      department_name: it.department_name || deptName(it.department_id),
      variance: r2(u.budget - u.used),
      variance_pct: u.budget > 0 ? Math.round(((u.budget - u.used) / u.budget) * 1000) / 10 : null,
      flag: u.used > u.budget + 0.01 ? 'over' : (u.used_pct >= 90 ? 'near' : (u.used_pct > u.expect_pct + 20 ? 'fast' : 'ok'))
    };
  });

  const filtered = only_diff ? rows.filter((r) => r.flag !== 'ok') : rows;
  const t = filtered.reduce((a, r) => ({
    budget: a.budget + r.budget, actual: a.actual + r.actual,
    committed: a.committed + r.committed, used: a.used + r.used
  }), { budget: 0, actual: 0, committed: 0, used: 0 });

  return {
    budget: { id: b.id, budget_no: b.budget_no, name: b.name, status: b.status, tolerance_pct: b.tolerance_pct },
    rows: filtered,
    totals: {
      budget: r2(t.budget), actual: r2(t.actual), committed: r2(t.committed), used: r2(t.used),
      available: r2(t.budget - t.used),
      used_pct: t.budget > 0 ? Math.round((t.used / t.budget) * 1000) / 10 : 0,
      over_cnt: filtered.filter((r) => r.flag === 'over').length
    }
  };
}

function deptName(id) {
  if (!id) return '未分配部门';
  const d = db.prepare('SELECT name FROM departments WHERE id=?').get(id);
  return d ? d.name : `部门#${id}`;
}

/** 部门汇总（老板看的一屏） */
function byDept(period) {
  const b = budgetOf(period);
  if (!b) return [];
  const items = db.prepare('SELECT DISTINCT department_id FROM budget_items WHERE budget_id=? AND period=?').all(b.id, period);
  return items.map((x) => {
    const rows = execution(period, { department_id: x.department_id }).rows;
    const sum = rows.reduce((a, r) => ({
      budget: a.budget + r.budget, actual: a.actual + r.actual,
      committed: a.committed + r.committed, used: a.used + r.used,
      over: a.over + (r.flag === 'over' ? 1 : 0)
    }), { budget: 0, actual: 0, committed: 0, used: 0, over: 0 });
    return {
      department_id: x.department_id,
      department_name: deptName(x.department_id),
      budget: r2(sum.budget), actual: r2(sum.actual), committed: r2(sum.committed), used: r2(sum.used),
      available: r2(sum.budget - sum.used),
      used_pct: sum.budget > 0 ? Math.round((sum.used / sum.budget) * 1000) / 10 : 0,
      over_cnt: sum.over
    };
  }).sort((a, b2) => b2.used_pct - a.used_pct);
}

/** 概览：给页面顶部指标 */
function overview(period) {
  const p = periodOf(period);
  const b = budgetOf(p);
  const ex = execution(p);
  const alerts = db.prepare("SELECT * FROM budget_alerts WHERE status='open'").all();
  const pendAdj = db.prepare("SELECT COUNT(*) c FROM budget_adjustments WHERE status='pending'").get().c;
  const unassigned = r2(db.prepare(
    `SELECT COALESCE(SUM(debit)-SUM(credit),0) s FROM gl_entries
     WHERE period=? AND department_id IS NULL AND account_code IN (SELECT code FROM gl_accounts WHERE type='expense')`
  ).get(p).s);
  return {
    period: p,
    budget: b ? {
      id: b.id, budget_no: b.budget_no, name: b.name, status: b.status,
      status_label: { draft: '编制中', approved: '已批准', active: '生效中', closed: '已关闭', rejected: '已驳回' }[b.status] || b.status,
      total_amount: r2(b.total_amount), item_count: b.item_count, tolerance_pct: r2(b.tolerance_pct),
      created_by: b.created_by, approved_by: b.approved_by, created_at: b.created_at
    } : null,
    totals: ex.totals || {},
    by_dept: byDept(p),
    alert_open: alerts.length,
    alert_over: alerts.filter((a) => a.type === 'over_budget').length,
    pending_adj: pendAdj,
    unassigned_expense: unassigned,
    expect_pct: expectPct(p)
  };
}

/** 重算表头合计与条数 */
function refreshBudget(budgetId) {
  const s = db.prepare(
    'SELECT COALESCE(SUM(amount),0) total, COUNT(*) c FROM budget_items WHERE budget_id=?'
  ).get(budgetId);
  db.prepare('UPDATE budgets SET total_amount=?, item_count=?, updated_at=? WHERE id=?')
    .run(r2(s.total), s.c, localNow(), budgetId);
  return { total: r2(s.total), count: s.c };
}

module.exports = {
  periodOf, acctOf, isExpense, isBudgetable, budgetOf, itemOf, actualOf, committedOf, usage, expectPct,
  check, commit, consume, release, alert, execution, byDept, overview, refreshBudget, deptName, r2, num
};
