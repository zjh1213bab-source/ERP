/**
 * M11 价格快照与费用池 —— 服务层
 * ============================================================
 * 两块东西，共用一条底线：**数字要能追、口径要能说清**。
 *
 * 一、费用池分摊
 *   车间水电、设备折旧、车间管理工资这类「不归某一单」的钱，不能靠拍脑袋加一个数。
 *   硬规则：
 *     1) 池额 = 明细合计（**不能手填总额**，手填就没人对得上明细）
 *     2) 分摊前必须算基数；**基数合计为 0 不许分摊**（分母为 0）
 *     3) 分摊额合计 **必须正好等于池额**，尾差归基数最大的对象（不许多一分也不许少一分）
 *     4) **只摊给本期有活动的成本对象**（本期有报工或本期有成本发生），不给死单摊
 *     5) **制造费用才进产品成本**；管理/销售费用**不摊进存货成本**（否则库存虚高、毛利虚低），
 *        只做经营分析口径，`in_cost=0`
 *     6) 已分摊不能重复分摊；撤销只能撤销最新一次，删掉写入的成本分录并回滚 actual_cost
 *     7) 一个成本对象在同一个池里只摊一次（唯一约束兜底靠代码校验）
 *
 * 二、价格本（价格快照发布）
 *     1) 价格本按「范围 + 客户」版本化；**同一范围同一客户同时只有一版 published**
 *     2) **发布即冻结**：已发布不许改，要改就基于它发新版，旧版自动 superseded
 *     3) 发布前每一项**必须能取到单件成本**，取不到不许发布（不拿猜的成本定价）
 *     4) 售价低于成本的项**可以发布但必须写说明**，并计入 `below_cost_count` 长期标红
 *     5) 价格必须 > 0；同一款同一码的数量档不能重叠
 *     6) 取价按「客户专价 → 通用价」优先，命中数量档取该档价，返回**价格本版本**做凭据
 */
const { db } = require('../db');

const EPS = 0.005;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const int0 = (v) => Math.round(num(v));
const pad = (n) => String(n).padStart(2, '0');

function now() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function monthOf(str) {
  return String(str || '').slice(0, 7);
}
function monthRange(period) {
  const p = monthOf(period);
  if (!/^\d{4}-\d{2}$/.test(p)) throw new Error('期间格式应为 YYYY-MM');
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(5, 7));
  if (m < 1 || m > 12) throw new Error('期间月份不合法');
  const last = new Date(y, m, 0).getDate();
  return { from: `${p}-01`, to: `${p}-${pad(last)}` };
}

/** 单号：前缀 + 当日最大号 +1（不用 COUNT(*)+1，删过行会撞号） */
function nextNo(table, col, prefix) {
  const d = new Date();
  const p = `${prefix}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rows = db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ?`).all(`${p}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.no).slice(p.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  let seq = max + 1;
  let no = `${p}${String(seq).padStart(4, '0')}`;
  while (db.prepare(`SELECT 1 x FROM ${table} WHERE ${col} = ?`).get(no)) {
    seq += 1;
    no = `${p}${String(seq).padStart(4, '0')}`;
  }
  return no;
}

const POOL_KIND = { manufacturing: '制造费用', admin: '管理费用', selling: '销售费用' };
const POOL_DRIVER = {
  labor_hours: '按工时', qty: '按件数', material_amount: '按材料额', revenue: '按收入'
};
const POOL_STATUS = { draft: '草稿', distributed: '已分摊', reverted: '已撤销', closed: '已结账' };
const BOOK_STATUS = { draft: '草稿', published: '生效中', superseded: '已被新版取代', archived: '已归档' };
const SCOPE = { factory: '出厂价', cost_plus: '成本加成价' };

// ============================================================
// 一、费用池
// ============================================================

function poolList(q) {
  const where = [];
  const args = [];
  if (q.period) { where.push('p.period = ?'); args.push(monthOf(q.period)); }
  if (q.status) { where.push('p.status = ?'); args.push(q.status); }
  if (q.kind) { where.push('p.kind = ?'); args.push(q.kind); }
  const rows = db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM cost_pool_expenses e WHERE e.pool_id = p.id) AS expense_count
     FROM cost_pools p ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.period DESC, p.id DESC LIMIT 200`
  ).all(...args);
  return rows.map((r) => ({
    ...r,
    kind_label: POOL_KIND[r.kind] || r.kind,
    driver_label: POOL_DRIVER[r.driver] || r.driver,
    status_label: POOL_STATUS[r.status] || r.status,
    total_amount: r2(r.total_amount),
    allocated_amount: r2(r.allocated_amount),
    diff: r2(num(r.total_amount) - num(r.allocated_amount))
  }));
}

function poolDetail(id) {
  const p = db.prepare('SELECT * FROM cost_pools WHERE id = ?').get(id);
  if (!p) return null;
  const expenses = db.prepare('SELECT * FROM cost_pool_expenses WHERE pool_id = ? ORDER BY expense_date, id').all(id)
    .map((e) => ({ ...e, amount: r2(e.amount) }));
  const allocs = db.prepare('SELECT * FROM cost_pool_allocations WHERE pool_id = ? ORDER BY amount DESC, id').all(id)
    .map((a) => ({ ...a, amount: r2(a.amount), share_ratio: r4(a.share_ratio), driver_base: r2(a.driver_base) }));
  const sumExp = r2(expenses.reduce((s, e) => s + num(e.amount), 0));
  const sumAlloc = r2(allocs.reduce((s, a) => s + num(a.amount), 0));
  return {
    ...p,
    kind_label: POOL_KIND[p.kind] || p.kind,
    driver_label: POOL_DRIVER[p.driver] || p.driver,
    status_label: POOL_STATUS[p.status] || p.status,
    expenses,
    allocations: allocs,
    expense_sum: sumExp,
    alloc_sum: sumAlloc,
    // 池额与明细合计不一致 = 有人绕过明细改了总额（正常流程不会发生，出现就是数据被改过）
    amount_mismatch: Math.abs(sumExp - num(p.total_amount)) > 0.01,
    can: {
      add_expense: p.status === 'draft',
      remove_expense: p.status === 'draft',
      distribute: p.status === 'draft' && sumExp > EPS,
      revert: p.status === 'distributed',
      close: p.status === 'distributed'
    }
  };
}

function createPool(b, operator) {
  const period = monthOf(b.period);
  monthRange(period);
  const name = String(b.name || '').trim();
  if (!name) throw new Error('费用池名称必填（例如「2026-10 车间制造费用」）');
  const kind = POOL_KIND[b.kind] ? b.kind : 'manufacturing';
  const driver = POOL_DRIVER[b.driver] ? b.driver : 'labor_hours';
  const ts = now();
  const no = nextNo('cost_pools', 'pool_no', 'FY');
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO cost_pools
        (pool_no, company_id, period, name, kind, driver, total_amount, allocated_amount, base_total,
         object_count, status, in_cost, note, created_by, created_at, updated_at, demo_tag)
       VALUES (?,1,?,?,?,?, 0,0,0,0, 'draft', ?,?,?,?,?,?)`
    ).run(no, period, name, kind, driver, kind === 'manufacturing' ? 1 : 0, b.note || null, operator, ts, ts, b.demo_tag || null);
    db.exec('COMMIT');
    return poolDetail(info.lastInsertRowid);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function addExpense(poolId, b, operator) {
  const p = db.prepare('SELECT * FROM cost_pools WHERE id = ?').get(poolId);
  if (!p) throw new Error('费用池不存在');
  if (p.status !== 'draft') throw new Error(`当前状态「${POOL_STATUS[p.status] || p.status}」不能再改明细（已分摊要先撤销）`);
  const desc = String(b.description || '').trim();
  if (!desc) throw new Error('费用说明必填（写清是什么钱）');
  const amount = r2(b.amount);
  if (Math.abs(amount) < EPS) throw new Error('金额不能为 0');
  if (amount < 0 && String(b.note || '').trim().length < 4) throw new Error('负数金额（红冲）必须写说明');
  const date = b.expense_date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('发生日期格式应为 YYYY-MM-DD');
  const { from, to } = monthRange(p.period);
  if (date < from || date > to) throw new Error(`发生日期 ${date} 不在费用池期间 ${p.period} 内：跨期费用请放到对应期间的池里`);

  const ts = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO cost_pool_expenses (pool_id, expense_date, category, description, amount, source, ref_id, note, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(poolId, date, b.category || '其他', desc, amount, b.source === 'admin_expense' ? 'admin_expense' : 'manual',
      b.ref_id ? int0(b.ref_id) : null, b.note || null, operator, ts);
    refreshPoolTotal(poolId, ts);
    db.exec('COMMIT');
    return poolDetail(poolId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function refreshPoolTotal(poolId, ts) {
  const s = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM cost_pool_expenses WHERE pool_id = ?').get(poolId);
  db.prepare('UPDATE cost_pools SET total_amount = ?, updated_at = ? WHERE id = ?').run(r2(s.v), ts || now(), poolId);
}

function removeExpense(id, operator) {
  const e = db.prepare('SELECT * FROM cost_pool_expenses WHERE id = ?').get(id);
  if (!e) throw new Error('费用明细不存在');
  const p = db.prepare('SELECT * FROM cost_pools WHERE id = ?').get(e.pool_id);
  if (!p) throw new Error('费用池不存在');
  if (p.status !== 'draft') throw new Error('已分摊的费用池不能删明细（先撤销分摊）');
  const ts = now();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM cost_pool_expenses WHERE id = ?').run(id);
    refreshPoolTotal(e.pool_id, ts);
    db.exec('COMMIT');
    return poolDetail(e.pool_id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 计算动因基数：只含**本期有活动**的成本对象
 * 「有活动」= 本期有报工 或 本期有成本发生（不让三个月前的死单来分摊本月的电费）
 */
function driverBases(pool) {
  const { from, to } = monthRange(pool.period);
  const objs = db.prepare(
    `SELECT co.id, co.cost_no, co.order_id, co.order_no, co.style_no, co.qty, co.revenue_cny
     FROM cost_objects co WHERE co.qty > 0`
  ).all();

  const reportHours = new Map();
  db.prepare(
    `SELECT order_id, COALESCE(SUM(hours),0) h FROM production_reports
     WHERE date(report_date) BETWEEN ? AND ? GROUP BY order_id`
  ).all(from, to).forEach((r) => reportHours.set(r.order_id, num(r.h)));

  const matAmount = new Map();
  db.prepare(
    `SELECT cost_object_id, COALESCE(SUM(amount),0) amt FROM cost_entries
     WHERE layer IN ('material','accessory') AND (occurred_at IS NULL OR date(occurred_at) BETWEEN ? AND ?)
     GROUP BY cost_object_id`
  ).all(from, to).forEach((r) => matAmount.set(r.cost_object_id, num(r.amt)));

  const anyEntry = new Set();
  db.prepare(
    `SELECT DISTINCT cost_object_id FROM cost_entries
     WHERE occurred_at IS NOT NULL AND date(occurred_at) BETWEEN ? AND ?`
  ).all(from, to).forEach((r) => anyEntry.add(r.cost_object_id));

  const rows = [];
  objs.forEach((o) => {
    const hours = reportHours.get(o.order_id) || 0;
    const active = hours > EPS || anyEntry.has(o.id);
    if (!active) return;
    let base = 0;
    if (pool.driver === 'labor_hours') base = hours;
    else if (pool.driver === 'qty') base = num(o.qty);
    else if (pool.driver === 'material_amount') base = matAmount.get(o.id) || 0;
    else if (pool.driver === 'revenue') base = num(o.revenue_cny);
    if (base <= EPS) return;   // 动因是 0 的对象不参与（不按 0 摊）
    rows.push({
      cost_object_id: o.id, cost_no: o.cost_no, order_id: o.order_id, order_no: o.order_no,
      style_no: o.style_no, qty: int0(o.qty), hours: r2(hours),
      material_amount: r2(matAmount.get(o.id) || 0), revenue: r2(num(o.revenue_cny)),
      base: r2(base)
    });
  });
  rows.sort((a, b) => b.base - a.base || a.cost_object_id - b.cost_object_id);
  const baseTotal = r2(rows.reduce((s, r) => s + r.base, 0));
  return { rows, baseTotal, from, to };
}

/** 预览分摊（不落库） */
function previewPool(id) {
  const p = db.prepare('SELECT * FROM cost_pools WHERE id = ?').get(id);
  if (!p) throw new Error('费用池不存在');
  const { rows, baseTotal, from, to } = driverBases(p);
  const total = r2(p.total_amount);
  if (baseTotal <= EPS) {
    return {
      pool: { ...p, kind_label: POOL_KIND[p.kind], driver_label: POOL_DRIVER[p.driver] },
      from, to, base_total: 0, total_amount: total, rows: [],
      blockers: [`本期没有任何可用的动因基数（${POOL_DRIVER[p.driver]} 全为 0）：先把报工或成本录进去，或改用别的动因`]
    };
  }
  // 尾差归到基数最大的对象（rows 已按基数降序）
  let acc = 0;
  const planned = rows.map((r, i) => {
    const amount = i === rows.length - 1
      ? r2(total - acc)
      : r2((total * r.base) / baseTotal);
    acc = r2(acc + amount);
    return { ...r, share_ratio: r4((r.base / baseTotal) * 100), amount };
  });
  const blockers = [];
  if (total <= EPS) blockers.push('费用池金额为 0：先录明细再分摊');
  return {
    pool: { ...p, kind_label: POOL_KIND[p.kind], driver_label: POOL_DRIVER[p.driver] },
    from, to,
    base_total: baseTotal,
    total_amount: total,
    object_count: planned.length,
    in_cost: !!p.in_cost,
    rows: planned,
    blockers
  };
}

/** 正式分摊：写 allocations，制造费用同时写 cost_entries（进 actual_cost） */
function distributePool(id, b, operator) {
  const p = db.prepare('SELECT * FROM cost_pools WHERE id = ?').get(id);
  if (!p) throw new Error('费用池不存在');
  if (p.status !== 'draft') throw new Error(`当前状态「${POOL_STATUS[p.status] || p.status}」不能分摊（已分摊要先撤销）`);
  const pv = previewPool(id);
  if (pv.blockers.length) throw new Error(`不能分摊：${pv.blockers.join('；')}`);
  const total = r2(p.total_amount);
  const note = String((b && b.note) || '').trim();

  const ts = now();
  db.exec('BEGIN');
  try {
    // 清掉可能的历史残留（理论上不会，撤销会删干净）
    db.prepare('DELETE FROM cost_pool_allocations WHERE pool_id = ?').run(id);
    const insA = db.prepare(
      `INSERT INTO cost_pool_allocations
        (pool_id, cost_object_id, order_id, order_no, style_no, driver_base, base_total, share_ratio, amount, in_cost, cost_entry_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insE = db.prepare(
      `INSERT INTO cost_entries
        (cost_object_id, layer, source, ref_type, ref_id, name, qty, unit, unit_price, amount, occurred_at, remark, created_by, created_at)
       VALUES (?,?, 'auto', 'cost_pool', ?,?, ?, '件', ?, ?, ?, ?, ?, ?)`
    );

    let sum = 0;
    pv.rows.forEach((r) => {
      let entryId = null;
      if (p.in_cost && Math.abs(r.amount) > EPS) {
        const co = db.prepare('SELECT qty FROM cost_objects WHERE id = ?').get(r.cost_object_id) || { qty: 0 };
        const qty = int0(co.qty) || 1;
        const info = insE.run(
          r.cost_object_id, 'overhead', id,
          `${POOL_KIND[p.kind] || p.kind}分摊 · ${p.name}`,
          qty, r2(r.amount / qty), r2(r.amount),
          `${p.period}-01`, `${POOL_DRIVER[p.driver]} ${r.base}，占比 ${r4(r.share_ratio)}%`, operator, ts
        );
        entryId = Number(info.lastInsertRowid);
        db.prepare(
          `UPDATE cost_objects
             SET actual_cost = ROUND(COALESCE(actual_cost,0) + ?, 2), updated_at = ?
           WHERE id = ?`
        ).run(r2(r.amount), ts, r.cost_object_id);
      }
      insA.run(id, r.cost_object_id, r.order_id, r.order_no, r.style_no, r.base, pv.base_total,
        r.share_ratio, r.amount, p.in_cost ? 1 : 0, entryId, ts);
      sum = r2(sum + r.amount);
    });

    db.prepare(
      `UPDATE cost_pools
         SET status='distributed', allocated_amount=?, base_total=?, object_count=?,
             distributed_by=?, distributed_at=?, updated_at=?, note=COALESCE(?, note)
       WHERE id=?`
    ).run(sum, pv.base_total, pv.rows.length, operator, ts, ts, note || null, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return poolDetail(id);
}

/** 撤销分摊：只允许撤销最新一次，删掉写入的成本分录并回滚 actual_cost */
function revertPool(id, reason, operator) {
  const p = db.prepare('SELECT * FROM cost_pools WHERE id = ?').get(id);
  if (!p) throw new Error('费用池不存在');
  if (p.status !== 'distributed') throw new Error(`当前状态「${POOL_STATUS[p.status] || p.status}」不能撤销（只有已分摊能撤销）`);
  const rs = String(reason || '').trim();
  if (rs.length < 4) throw new Error('撤销分摊必须写原因（≥4 字）');

  const allocs = db.prepare('SELECT * FROM cost_pool_allocations WHERE pool_id = ?').all(id);
  const ts = now();
  db.exec('BEGIN');
  try {
    allocs.forEach((a) => {
      if (a.cost_entry_id) {
        db.prepare('DELETE FROM cost_entries WHERE id = ?').run(a.cost_entry_id);
        db.prepare(
          'UPDATE cost_objects SET actual_cost = ROUND(MAX(0, COALESCE(actual_cost,0) - ?), 2), updated_at = ? WHERE id = ?'
        ).run(r2(a.amount), ts, a.cost_object_id);
      }
    });
    db.prepare('DELETE FROM cost_pool_allocations WHERE pool_id = ?').run(id);
    db.prepare(
      `UPDATE cost_pools
         SET status='reverted', allocated_amount=0, base_total=0, object_count=0,
             reverted_by=?, reverted_at=?, revert_reason=?, updated_at=?
       WHERE id=?`
    ).run(operator, ts, rs, ts, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // 撤销后回到草稿，可以重新分摊
  db.prepare("UPDATE cost_pools SET status='draft', reverted_by=?, reverted_at=?, revert_reason=? WHERE id=?")
    .run(operator, ts, rs, id);
  return poolDetail(id);
}

function closePool(id, operator) {
  const p = db.prepare('SELECT * FROM cost_pools WHERE id = ?').get(id);
  if (!p) throw new Error('费用池不存在');
  if (p.status !== 'distributed') throw new Error('只有已分摊的费用池能结账');
  if (Math.abs(num(p.total_amount) - num(p.allocated_amount)) > 0.01) {
    throw new Error(`分摊合计 ${r2(p.allocated_amount)} 与池额 ${r2(p.total_amount)} 不一致，不能结账`);
  }
  const ts = now();
  db.prepare("UPDATE cost_pools SET status='closed', updated_at=? WHERE id=?").run(ts, id);
  return poolDetail(id);
}

function poolBoard(q) {
  const period = monthOf(q.period) || today().slice(0, 7);
  const rows = poolList({ period });
  const byKind = {};
  rows.forEach((r) => {
    byKind[r.kind] = byKind[r.kind] || { kind: r.kind, kind_label: r.kind_label, count: 0, total: 0, allocated: 0 };
    byKind[r.kind].count += 1;
    byKind[r.kind].total = r2(byKind[r.kind].total + r.total_amount);
    byKind[r.kind].allocated = r2(byKind[r.kind].allocated + r.allocated_amount);
  });
  return {
    period,
    pools: rows,
    by_kind: Object.values(byKind),
    stat: {
      count: rows.length,
      total: r2(rows.reduce((s, r) => s + r.total_amount, 0)),
      allocated: r2(rows.reduce((s, r) => s + (r.status === 'distributed' || r.status === 'closed' ? r.allocated_amount : 0), 0)),
      draft: rows.filter((r) => r.status === 'draft').length,
      unallocated: r2(rows.filter((r) => r.status === 'draft').reduce((s, r) => s + r.total_amount, 0))
    }
  };
}

// ============================================================
// 二、价格本（价格快照）
// ============================================================

function bookList(q) {
  const where = [];
  const args = [];
  if (q.status) { where.push('b.status = ?'); args.push(q.status); }
  if (q.scope) { where.push('b.scope = ?'); args.push(q.scope); }
  const rows = db.prepare(
    `SELECT b.*, c.name AS customer_name,
            (SELECT COUNT(*) FROM price_book_items i WHERE i.book_id = b.id) AS item_count_now
     FROM price_books b LEFT JOIN customers c ON c.id = b.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY b.id DESC LIMIT 100`
  ).all(...args);
  return rows.map((r) => ({
    ...r,
    status_label: BOOK_STATUS[r.status] || r.status,
    scope_label: SCOPE[r.scope] || r.scope,
    item_count: int0(r.item_count_now || r.item_count),
    customer_label: r.customer_id ? r.customer_name : '通用价'
  }));
}

/** 取某款的单件成本：优先成本对象（实际成本/件），退而求其次用核价成本单 */
function styleCost(styleNo) {
  if (!styleNo) return { cost: null, source: null };
  const co = db.prepare(
    `SELECT co.actual_cost, co.budget_cost, co.qty
     FROM cost_objects co JOIN orders o ON o.id = co.order_id
     JOIN order_items i ON i.order_id = o.id
     WHERE i.style_no = ? AND co.qty > 0
     ORDER BY (CASE WHEN co.actual_cost > 0 THEN 0 ELSE 1 END), co.id DESC LIMIT 1`
  ).get(styleNo);
  if (co && num(co.qty) > 0) {
    const c = num(co.actual_cost) > 0 ? num(co.actual_cost) / num(co.qty) : num(co.budget_cost) / num(co.qty);
    if (c > 0) return { cost: r2(c), source: 'cost_object' };
  }
  const cs = db.prepare(
    `SELECT cs.total_cost, co.qty FROM cost_sheets cs
     JOIN cost_objects co ON co.order_id = cs.order_id
     JOIN order_items i ON i.order_id = cs.order_id
     WHERE i.style_no = ? AND co.qty > 0 AND cs.total_cost > 0 ORDER BY cs.id DESC LIMIT 1`
  ).get(styleNo);
  if (cs && num(cs.qty) > 0 && num(cs.total_cost) > 0) {
    return { cost: r2(num(cs.total_cost) / num(cs.qty)), source: 'cost_sheet' };
  }
  return { cost: null, source: null };
}

function bookDetail(id) {
  const b = db.prepare('SELECT * FROM price_books WHERE id = ?').get(id);
  if (!b) return null;
  const cust = b.customer_id ? db.prepare('SELECT name FROM customers WHERE id = ?').get(b.customer_id) : null;
  const items = db.prepare('SELECT * FROM price_book_items WHERE book_id = ? ORDER BY style_no, min_qty, size').all(id)
    .map((i) => {
      // 发布后成本可能又变了（比如刚做完费用池分摊）：拿当前成本和快照比，
      // 差得多就提示发新版——不提示的话会一直用过期成本算毛利，定价就失真了
      const cur = styleCost(i.style_no).cost;
      const snap = i.cost_unit === null ? null : num(i.cost_unit);
      const drift = cur !== null && snap !== null && snap > EPS ? r4(((cur - snap) / snap) * 100) : null;
      return {
        ...i,
        price: r2(i.price),
        cost_unit: i.cost_unit === null ? null : r2(i.cost_unit),
        cost_now: cur,
        cost_drift: drift,
        cost_drift_alert: drift !== null && Math.abs(drift) >= 5,
        gross_margin: i.gross_margin === null ? null : r2(i.gross_margin),
        below_cost: !!i.below_cost
      };
    });
  const belowCost = items.filter((i) => i.below_cost).length;
  const noCost = items.filter((i) => i.cost_unit === null).length;
  const driftCount = items.filter((i) => i.cost_drift_alert).length;
  return {
    ...b,
    status_label: BOOK_STATUS[b.status] || b.status,
    scope_label: SCOPE[b.scope] || b.scope,
    customer_label: b.customer_id ? (cust && cust.name) || `#${b.customer_id}` : '通用价',
    items,
    item_count: items.length,
    below_cost_count: belowCost,
    cost_missing_count: noCost,
    cost_drift_count: driftCount,
    amount_stat: {
      min_price: items.length ? r2(Math.min(...items.map((i) => i.price))) : 0,
      max_price: items.length ? r2(Math.max(...items.map((i) => i.price))) : 0,
      avg_margin: items.filter((i) => i.gross_margin !== null).length
        ? r2(items.reduce((s, i) => s + num(i.gross_margin), 0) / items.filter((i) => i.gross_margin !== null).length)
        : null
    },
    can: {
      edit: b.status === 'draft',
      publish: b.status === 'draft' && items.length > 0,
      archive: b.status === 'published'
    }
  };
}

function createBook(b, operator) {
  const scope = SCOPE[b.scope] ? b.scope : 'factory';
  const from = b.effective_from || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('生效日期格式应为 YYYY-MM-DD');
  const cur = db.prepare(
    "SELECT * FROM price_books WHERE company_id=1 AND scope=? AND IFNULL(customer_id,0)=IFNULL(?,0) AND status='published'"
  ).get(scope, b.customer_id ? int0(b.customer_id) : null);
  if (cur && from <= cur.effective_from) {
    throw new Error(`已有一版生效中（V${cur.version}，${cur.effective_from} 起），新生效日期必须晚于它`);
  }
  const version = (db.prepare(
    'SELECT COALESCE(MAX(version),0) v FROM price_books WHERE company_id=1 AND scope=? AND IFNULL(customer_id,0)=IFNULL(?,0)'
  ).get(scope, b.customer_id ? int0(b.customer_id) : null).v) + 1;

  const ts = now();
  const no = nextNo('price_books', 'book_no', 'PB');
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO price_books
        (book_no, company_id, version, scope, customer_id, currency, rate, effective_from, effective_to,
         item_count, below_cost_count, status, based_on_id, note, created_by, created_at, updated_at, demo_tag)
       VALUES (?,1,?,?,?,?,?,?,?, 0,0, 'draft', ?,?,?,?,?,?)`
    ).run(no, version, scope, b.customer_id ? int0(b.customer_id) : null,
      b.currency || 'CNY', num(b.rate) || 1, from, b.effective_to || null,
      b.based_on_id ? int0(b.based_on_id) : (cur ? cur.id : null), b.note || null, operator, ts, ts, b.demo_tag || null);
    const bookId = Number(info.lastInsertRowid);

    // 基于上一版复制明细（改价最常见的就是「上一版基础上调」）
    if (b.copy_from || cur) {
      const srcId = b.copy_from ? int0(b.copy_from) : cur.id;
      const src = db.prepare('SELECT * FROM price_book_items WHERE book_id = ?').all(srcId);
      const stmt = db.prepare(
        `INSERT INTO price_book_items (book_id, style_no, style_name, size, min_qty, max_qty, price, cost_unit, cost_source, gross_margin, below_cost, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      src.forEach((i) => stmt.run(bookId, i.style_no, i.style_name, i.size, i.min_qty, i.max_qty,
        i.price, i.cost_unit, i.cost_source, i.gross_margin, i.below_cost, i.note));
      refreshBookCounts(bookId, ts);
    }
    db.exec('COMMIT');
    return bookDetail(bookId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function refreshBookCounts(bookId, ts) {
  const items = db.prepare('SELECT * FROM price_book_items WHERE book_id = ?').all(bookId);
  const below = items.filter((i) => i.below_cost).length;
  db.prepare('UPDATE price_books SET item_count = ?, below_cost_count = ?, updated_at = ? WHERE id = ?')
    .run(items.length, below, ts || now(), bookId);
}

function upsertItem(bookId, b, operator) {
  const bk = db.prepare('SELECT * FROM price_books WHERE id = ?').get(bookId);
  if (!bk) throw new Error('价格本不存在');
  if (bk.status !== 'draft') throw new Error('只有草稿状态的价格本能改价：**已发布的价格本不许改**，要改请基于它发新版');
  const styleNo = String(b.style_no || '').trim();
  if (!styleNo) throw new Error('款号必填');
  const price = r2(b.price);
  if (price <= EPS) throw new Error('价格必须大于 0');
  const minQty = Math.max(1, int0(b.min_qty) || 1);
  const maxQty = b.max_qty === null || b.max_qty === undefined || b.max_qty === '' ? null : int0(b.max_qty);
  if (maxQty !== null && maxQty < minQty) throw new Error('数量档上限不能小于下限');
  const size = String(b.size || '').trim();

  // 同款同码的数量档不许重叠
  const others = db.prepare(
    'SELECT * FROM price_book_items WHERE book_id = ? AND style_no = ? AND size = ? AND id <> ?'
  ).all(bookId, styleNo, size, b.id ? int0(b.id) : 0);
  for (const o of others) {
    const oMax = o.max_qty === null ? Infinity : num(o.max_qty);
    const nMax = maxQty === null ? Infinity : maxQty;
    if (minQty <= oMax && num(o.min_qty) <= nMax) {
      throw new Error(`与已有档位 ${o.min_qty}${o.max_qty === null ? '+' : '-' + o.max_qty} 重叠：同一款同一码的数量档不能交叉`);
    }
  }

  const c = styleCost(styleNo);
  const costUnit = c.cost;
  const margin = costUnit !== null && price > EPS ? r4(((price - costUnit) / price) * 100) : null;
  const below = costUnit !== null && price < costUnit - EPS ? 1 : 0;
  const styleName = b.style_name || (db.prepare('SELECT o.style_name FROM orders o JOIN order_items i ON i.order_id=o.id WHERE i.style_no=? LIMIT 1').get(styleNo) || {}).style_name || null;

  const ts = now();
  db.exec('BEGIN');
  try {
    if (b.id) {
      db.prepare(
        `UPDATE price_book_items SET style_no=?, style_name=?, size=?, min_qty=?, max_qty=?, price=?,
           cost_unit=?, cost_source=?, gross_margin=?, below_cost=?, note=? WHERE id=? AND book_id=?`
      ).run(styleNo, styleName, size, minQty, maxQty, price, costUnit, c.source, margin, below, b.note || null, int0(b.id), bookId);
    } else {
      db.prepare(
        `INSERT INTO price_book_items (book_id, style_no, style_name, size, min_qty, max_qty, price, cost_unit, cost_source, gross_margin, below_cost, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(bookId, styleNo, styleName, size, minQty, maxQty, price, costUnit, c.source, margin, below, b.note || null);
    }
    refreshBookCounts(bookId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return bookDetail(bookId);
}

function removeItem(itemId) {
  const it = db.prepare('SELECT * FROM price_book_items WHERE id = ?').get(itemId);
  if (!it) throw new Error('价格项不存在');
  const bk = db.prepare('SELECT * FROM price_books WHERE id = ?').get(it.book_id);
  if (bk.status !== 'draft') throw new Error('已发布的价格本不能删价：要改请发新版');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM price_book_items WHERE id = ?').run(itemId);
    refreshBookCounts(it.book_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return bookDetail(it.book_id);
}

/** 发布：刷新成本快照 → 校验 → 冻结 */
function publishBook(bookId, b, operator) {
  const bk = db.prepare('SELECT * FROM price_books WHERE id = ?').get(bookId);
  if (!bk) throw new Error('价格本不存在');
  if (bk.status !== 'draft') throw new Error(`当前状态「${BOOK_STATUS[bk.status] || bk.status}」不能再发布`);
  const items = db.prepare('SELECT * FROM price_book_items WHERE book_id = ?').all(bookId);
  if (!items.length) throw new Error('价格本是空的：至少要有一项才能发布');

  // 发布时重算一次成本快照（成本在草稿期间可能已经变了）
  const refreshed = items.map((i) => {
    const c = styleCost(i.style_no);
    const costUnit = c.cost !== null ? c.cost : (i.cost_unit === null ? null : r2(i.cost_unit));
    const margin = costUnit !== null && num(i.price) > EPS ? r4(((num(i.price) - costUnit) / num(i.price)) * 100) : null;
    const below = costUnit !== null && num(i.price) < costUnit - EPS ? 1 : 0;
    return { ...i, cost_unit: costUnit, cost_source: c.source || i.cost_source, gross_margin: margin, below_cost: below };
  });
  const missing = refreshed.filter((i) => i.cost_unit === null);
  if (missing.length) {
    throw new Error(
      `有 ${missing.length} 项取不到单件成本（${missing.slice(0, 3).map((i) => i.style_no).join('、')}${missing.length > 3 ? ' 等' : ''}）：` +
      '成本没算清就不能定价，请先跑该款的成本核算'
    );
  }
  const below = refreshed.filter((i) => i.below_cost);
  const note = String((b && b.note) || '').trim();
  if (below.length && note.length < 4) {
    throw new Error(
      `有 ${below.length} 项售价低于成本（${below.slice(0, 3).map((i) => `${i.style_no} ¥${r2(i.price)} < ¥${r2(i.cost_unit)}`).join('；')}${below.length > 3 ? ' 等' : ''}）：` +
      '可以发布，但必须写清原因（清库存 / 战略客户 / 亏本接单）'
    );
  }

  const ts = now();
  db.exec('BEGIN');
  try {
    const upd = db.prepare(
      'UPDATE price_book_items SET cost_unit=?, cost_source=?, gross_margin=?, below_cost=? WHERE id=?'
    );
    refreshed.forEach((i) => upd.run(i.cost_unit, i.cost_source, i.gross_margin, i.below_cost, i.id));

    // 同范围同客户的旧版转 superseded（历史订单仍按旧版快照，不动）
    db.prepare(
      `UPDATE price_books SET status='superseded', effective_to = ?, updated_at = ?
       WHERE company_id=1 AND scope=? AND IFNULL(customer_id,0)=IFNULL(?,0) AND status='published' AND id<>?`
    ).run(bk.effective_from, ts, bk.scope, bk.customer_id, bookId);

    db.prepare(
      `UPDATE price_books
         SET status='published', item_count=?, below_cost_count=?, published_by=?, published_at=?,
             publish_note=?, updated_at=?
       WHERE id=?`
    ).run(refreshed.length, below.length, operator, ts, note || null, ts, bookId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return bookDetail(bookId);
}

function archiveBook(bookId, reason, operator) {
  const bk = db.prepare('SELECT * FROM price_books WHERE id = ?').get(bookId);
  if (!bk) throw new Error('价格本不存在');
  if (bk.status !== 'published') throw new Error('只有在生效中的价格本能归档（归档后该范围将没有生效价）');
  const rs = String(reason || '').trim();
  if (rs.length < 4) throw new Error('归档必须写原因（≥4 字）');
  const ts = now();
  db.prepare("UPDATE price_books SET status='archived', effective_to=?, publish_note=COALESCE(publish_note,'')||?, updated_at=? WHERE id=?")
    .run(today(), ` [归档] ${rs}`, ts, bookId);
  return bookDetail(bookId);
}

/** 取价：客户专价优先 → 通用价；命中数量档 */
function quote(q) {
  const styleNo = String(q.style_no || '').trim();
  if (!styleNo) throw new Error('款号必填');
  const qty = Math.max(1, int0(q.qty) || 1);
  const size = String(q.size || '').trim();
  const custId = q.customer_id ? int0(q.customer_id) : null;
  const day = q.date || today();

  const pick = () => {
    const scopes = custId ? [custId, null] : [null];
    for (const cid of scopes) {
      const bk = db.prepare(
        `SELECT * FROM price_books
         WHERE company_id=1 AND status='published' AND IFNULL(customer_id,0)=IFNULL(?,0)
           AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC LIMIT 1`
      ).get(cid, day, day);
      if (!bk) continue;
      const items = db.prepare('SELECT * FROM price_book_items WHERE book_id = ? AND style_no = ?').all(bk.id, styleNo);
      if (!items.length) continue;
      // 优先精确码，其次不分码
      const pool = items.filter((i) => i.size === size);
      const use = pool.length ? pool : items.filter((i) => !i.size);
      if (!use.length) continue;
      const hit = use.find((i) => qty >= num(i.min_qty) && (i.max_qty === null || qty <= num(i.max_qty)));
      if (!hit) continue;
      return { book: bk, item: hit, by: cid ? 'customer' : 'general' };
    }
    return null;
  };

  const found = pick();
  if (!found) {
    return {
      style_no: styleNo, qty, size, date: day, customer_id: custId,
      found: false,
      reason: `当前没有命中 ${styleNo} 的价格：检查是否已发布价格本、款号是否一致、数量档是否覆盖 ${qty} 件`
    };
  }
  const { book, item, by } = found;
  return {
    style_no: styleNo, qty, size, date: day, customer_id: custId,
    found: true,
    by,
    by_label: by === 'customer' ? '客户专价' : '通用价',
    book: {
      id: book.id, book_no: book.book_no, version: book.version, scope: book.scope,
      scope_label: SCOPE[book.scope] || book.scope, currency: book.currency,
      effective_from: book.effective_from, effective_to: book.effective_to,
      published_at: book.published_at, published_by: book.published_by
    },
    item: {
      id: item.id, style_name: item.style_name, size: item.size,
      min_qty: item.min_qty, max_qty: item.max_qty,
      price: r2(item.price), cost_unit: item.cost_unit === null ? null : r2(item.cost_unit),
      gross_margin: item.gross_margin === null ? null : r2(item.gross_margin),
      below_cost: !!item.below_cost
    },
    amount: r2(item.price * qty),
    cost_amount: item.cost_unit === null ? null : r2(item.cost_unit * qty),
    gross_amount: item.cost_unit === null ? null : r2((item.price - item.cost_unit) * qty)
  };
}

/** 价格本总览 */
function bookBoard() {
  const books = bookList({});
  const pub = books.filter((b) => b.status === 'published');
  const draft = books.filter((b) => b.status === 'draft');
  const belowTotal = pub.reduce((s, b) => s + int0(b.below_cost_count), 0);
  return {
    books,
    published: pub,
    stat: {
      total: books.length,
      published: pub.length,
      draft: draft.length,
      superseded: books.filter((b) => b.status === 'superseded').length,
      below_cost: belowTotal
    }
  };
}

function dict() {
  return {
    pool_kind: POOL_KIND, pool_driver: POOL_DRIVER, pool_status: POOL_STATUS,
    book_status: BOOK_STATUS, scope: SCOPE,
    today: today(), current_period: today().slice(0, 7)
  };
}

module.exports = {
  EPS, r2, r4, num, today, monthOf, monthRange,
  poolList, poolDetail, createPool, addExpense, removeExpense,
  driverBases, previewPool, distributePool, revertPool, closePool, poolBoard,
  bookList, bookDetail, createBook, upsertItem, removeItem, publishBook, archiveBook,
  styleCost, quote, bookBoard, dict
};
