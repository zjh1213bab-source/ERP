/**
 * 返工报废与生产结单（原型 TS-N08-06）
 * 流程：异常 → 返工/报废批准 → 复验 → 余料/费用清理 → 结单
 *
 * 返工报废（挂 /api/reworks）
 * GET  /board?order_id=&status=&q=        看板 + 指标
 * GET  /:id                               详情
 * POST /                                  建单 { order_id, node_id, type, source, responsibility, reason, qty, cost_labor, cost_material, evidence }
 * POST /:id/submit                        草稿 → 待批准
 * POST /:id/approve                       批准 / 驳回（批准人 ≠ 制单人）
 * POST /:id/start                         已批准 → 返工中
 * POST /:id/reinspect                     复验 { result: pass|fail, note }：pass 闭环进成本；fail 回返工中并累计次数
 * POST /:id/scrap                         报废 { qty_scrap, cost_total, note }（type=scrap 用，直接闭环）
 *
 * 生产结单（挂 /api/production-close）
 * GET  /gate/:orderId                     结单检查（五项）
 * GET  /board                             可结单 / 受限清单
 * POST /                                  结单 { order_id, actual_close_date, close_type?, dispute_note?, balance_source?, follow_up_owner? }
 * GET  /order/:orderId                    该订单的结单记录
 *
 * 硬规则：
 * 1. 建单必填不良数量与原因；报废必须有损失金额
 * 2. 批准人不能是制单本人（admin 例外）——自己开单自己批，等于没把关
 * 3. 只有复验通过才闭环；复验不通过回「返工中」并把返工次数 +1
 * 4. 闭环时损失自动进成本对象 rework 层（幂等：同单只写一次），毛利被真实扣减
 * 5. 结单硬阻塞：未闭环返工报废、质量未决（QC open）、工序未全部完成
 * 6. 结单软提示：未交/未出库、余料未清、成本未归集 —— 只允许「部分关闭 + 争议挂账」，必须写争议说明与余额来源
 * 7. 实际结单日期与录入时间分开存（补录也留真实录入时间）
 * 8. 已完成/已交付不删除：结单只加记录，不改动订单、报工、库存数据
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { ensureCostObject, recalc, syncSold } = require('./costObjects');

const rw = express.Router();
const closeR = express.Router();

const WRITE = ['admin', 'production', 'tech', 'warehouse'];
const READ = ['admin', 'production', 'tech', 'warehouse', 'sales', 'finance'];
const EPS = 0.005;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const RW_LABEL = {
  draft: '草稿',
  pending_approve: '待批准',
  approved: '已批准',
  in_progress: '返工中',
  closed: '已闭环',
  rejected: '已驳回'
};
const CLOSE_LABEL = { full: '全结', partial: '部分关闭' };

function nextNo(prefix, table, seqField) {
  const t = now();
  const ymd = t.slice(0, 10).replace(/-/g, '');
  const seq = Number(db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${seqField} LIKE ?`).get(`${prefix}${ymd}%`).c) + 1;
  let n = `${prefix}${ymd}${String(seq).padStart(4, '0')}`;
  while (db.prepare(`SELECT 1 x FROM ${table} WHERE ${seqField} = ?`).get(n)) {
    n = `${prefix}${ymd}${String(++seq).padStart(4, '0')}`;
  }
  return n;
}

function rwView(id) {
  const r = db.prepare('SELECT * FROM rework_orders WHERE id = ?').get(id);
  if (!r) return null;
  return {
    ...r,
    type_label: r.type === 'scrap' ? '报废' : '返工',
    status_label: RW_LABEL[r.status] || r.status,
    source_label: { inhouse: '本厂', outsource: '外协', supplier: '供方', customer: '客户端' }[r.source] || r.source
  };
}

/** 订单总件数 */
function orderQty(orderId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(s.qty), 0) AS q FROM order_items i JOIN order_item_sizes s ON s.item_id = i.id WHERE i.order_id = ?`
  ).get(orderId);
  return Number(row.q || 0);
}

/** 五项结单检查 */
function inspectOrder(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;

  const reworks = db.prepare(
    "SELECT id, rw_no, type, qty, status FROM rework_orders WHERE order_id = ? AND status NOT IN ('closed','rejected')"
  ).all(orderId);
  const reworkQty = round2(reworks.reduce((a, r) => a + Number(r.qty || 0), 0));

  const qcOpen = db.prepare("SELECT id, issue_no, type, qty FROM qc_issues WHERE order_id = ? AND status != 'closed'").all(orderId);

  const nodes = db.prepare("SELECT COUNT(*) c, SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) w FROM order_nodes WHERE order_id = ?").get(orderId);
  const totalNodes = Number(nodes.c || 0);
  const wipNodes = Number(nodes.w || 0);

  const qty = orderQty(orderId);
  const shipped = ['shipped', 'closed'].includes(order.status) ? qty : 0;
  const unshipped = round2(qty - shipped);

  const cut = db.prepare('SELECT leftover_m FROM cut_orders WHERE order_id = ?').get(orderId);
  const leftover = cut ? round2(cut.leftover_m) : 0;

  const cost = db.prepare('SELECT status, actual_cost FROM cost_objects WHERE order_id = ?').get(orderId);
  const costOpen = !cost || Number(cost.actual_cost || 0) <= EPS ? 1 : 0;

  const blocked = [];
  if (reworks.length) {
    blocked.push({ key: 'rework', label: `未闭环返工/报废 ${reworks.length} 张（${reworkQty} 件）`, detail: reworks.map((r) => r.rw_no).join('、') });
  }
  if (qcOpen.length) {
    blocked.push({ key: 'qc', label: `质量未决 ${qcOpen.length} 项`, detail: qcOpen.map((q) => q.issue_no).join('、') });
  }
  if (wipNodes > 0) {
    blocked.push({ key: 'wip', label: `还有 ${wipNodes} 道工序未完成（共 ${totalNodes} 道）`, detail: null });
  }

  // 影响全结的软提示：还有货没交、余料没清 —— 只能部分关闭 + 争议挂账
  const warns = [];
  if (unshipped > EPS) {
    warns.push({ key: 'unshipped', label: `未交 ${unshipped} 件未出库`, detail: `订单状态 ${order.status}` });
  }
  if (leftover > EPS) {
    warns.push({ key: 'leftover', label: `余料 ${leftover} 米未清理`, detail: '回仓或结转后清理' });
  }
  // 仅提示、不拦全结：成本可以事后补归集
  const notes = [];
  if (costOpen) {
    notes.push({ key: 'cost', label: '成本还没归集', detail: '返工/费用未入成本对象，可结单后补' });
  }

  return {
    order: { id: order.id, order_no: order.order_no, status: order.status, style_name: order.style_name, customer_id: order.customer_id },
    qty,
    shipped,
    unshipped,
    open_rework_cnt: reworks.length,
    open_rework_qty: reworkQty,
    open_qc_cnt: qcOpen.length,
    wip_nodes: wipNodes,
    total_nodes: totalNodes,
    leftover_m: leftover,
    cost_open: costOpen,
    blocked,
    warns,
    notes,
    can_close: blocked.length === 0,
    only_partial: blocked.length === 0 && warns.length > 0
  };
}

// ==================== 返工报废 ====================
rw.get('/board', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { order_id = '', status = '', q = '' } = req.query;
  const w = [];
  const p = [];
  if (order_id) { w.push('r.order_id = ?'); p.push(order_id); }
  if (status) { w.push('r.status = ?'); p.push(status); }
  if (q) { w.push('(r.rw_no LIKE ? OR r.order_no LIKE ? OR r.reason LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT r.*, o.style_name FROM rework_orders r LEFT JOIN orders o ON o.id = r.order_id ` +
    (w.length ? 'WHERE ' + w.join(' AND ') + ' ' : '') + 'ORDER BY r.id DESC LIMIT 200'
  ).all(...p).map((r) => ({
    ...r,
    type_label: r.type === 'scrap' ? '报废' : '返工',
    status_label: RW_LABEL[r.status] || r.status,
    source_label: { inhouse: '本厂', outsource: '外协', supplier: '供方', customer: '客户端' }[r.source] || r.source
  }));

  const stat = {
    total: rows.length,
    pending_approve: rows.filter((r) => r.status === 'pending_approve').length,
    in_progress: rows.filter((r) => r.status === 'in_progress').length,
    open: rows.filter((r) => !['closed', 'rejected'].includes(r.status)).length,
    closed: rows.filter((r) => r.status === 'closed').length,
    qty_scrap: round2(rows.reduce((a, r) => a + Number(r.qty_scrap || 0), 0)),
    loss: round2(rows.reduce((a, r) => a + Number(r.cost_total || 0), 0))
  };
  return ok(res, { rows, stat });
}));

rw.get('/gate/:orderId', authRequired, requireRole(READ), wrap(async (req, res) => {
  const g = inspectOrder(Number(req.params.orderId));
  if (!g) return fail(res, 404, '订单不存在');
  return ok(res, g);
}));

/** 该订单的工序清单（开返工单时选原工序用） */
rw.get('/nodes/:orderId', authRequired, requireRole(READ), wrap(async (req, res) => {
  const rows = db.prepare('SELECT id, name, seq, status FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(req.params.orderId);
  return ok(res, rows);
}));

rw.get('/:id', authRequired, requireRole(READ), wrap(async (req, res) => {
  const v = rwView(req.params.id);
  if (!v) return fail(res, 404, '返工单不存在');
  const order = db.prepare('SELECT id, order_no, style_name, status FROM orders WHERE id = ?').get(v.order_id);
  return ok(res, { rework: v, order });
}));

rw.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(b.order_id));
  if (!order) return fail(res, 404, '订单不存在');
  const qty = round2(b.qty);
  if (!(qty > 0)) return fail(res, 400, '不良数量必须大于 0');
  const reason = String(b.reason || '').trim();
  if (!reason) return fail(res, 400, '请写明不良原因（尺寸超差 / 色差 / 车线不良 …）');
  const type = b.type === 'scrap' ? 'scrap' : 'rework';
  const labor = round2(b.cost_labor);
  const material = round2(b.cost_material);
  const total = round2(labor + material);
  if (type === 'scrap' && !(total > 0)) {
    return fail(res, 400, '报废必须填损失金额（人工 + 材料），否则成本里会漏掉这笔损失');
  }

  let node = null;
  if (b.node_id) {
    node = db.prepare('SELECT * FROM order_nodes WHERE id = ? AND order_id = ?').get(Number(b.node_id), order.id);
    if (!node) return fail(res, 400, '原工序不属于该订单');
  }
  // 同一订单同一工序已有未闭环返工单时，视为第 N 次返工
  const prev = db.prepare(
    "SELECT MAX(rework_times) t FROM rework_orders WHERE order_id = ? AND COALESCE(node_id,0) = COALESCE(?,0) AND status != 'rejected'"
  ).get(order.id, node ? node.id : null);
  const times = Number(prev && prev.t ? prev.t : 0) + 1;

  const rwNo = nextNo('RW', 'rework_orders', 'rw_no');
  const t = now();
  const info = db.prepare(
    `INSERT INTO rework_orders (rw_no, order_id, order_no, node_id, node_name, type, source, responsibility, reason,
      qty, rework_times, cost_labor, cost_material, cost_total, status, evidence, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?, 'draft', ?,?,?,?,?)`
  ).run(rwNo, order.id, order.order_no, node ? node.id : null, node ? node.name : (b.node_name || null),
    type, ['inhouse', 'outsource', 'supplier', 'customer'].includes(b.source) ? b.source : 'inhouse',
    b.responsibility || null, reason, qty, times, labor, material, total,
    b.evidence || null, b.remark || null, req.user.username, t, t);

  return ok(res, rwView(Number(info.lastInsertRowid)));
}));

rw.post('/:id/submit', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM rework_orders WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '返工单不存在');
  if (r.status !== 'draft') return fail(res, 400, '只有草稿能提交批准');
  db.prepare("UPDATE rework_orders SET status='pending_approve', updated_at=? WHERE id=?").run(now(), r.id);
  return ok(res, rwView(r.id));
}));

rw.post('/:id/approve', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM rework_orders WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '返工单不存在');
  if (r.status !== 'pending_approve') return fail(res, 400, '只有待批准的单能批准');
  const b = req.body || {};
  const agree = b.agree === true || b.agree === 1 || b.agree === '1';
  const t = now();
  if (!agree) {
    const note = String(b.note || '').trim();
    if (!note) return fail(res, 400, '驳回必须写理由');
    db.prepare("UPDATE rework_orders SET status='rejected', approved_by=?, approved_at=?, approve_note=?, updated_at=? WHERE id=?")
      .run(req.user.username, t, note, t, r.id);
    return ok(res, rwView(r.id));
  }
  if (r.created_by === req.user.username && req.user.role !== 'admin') {
    return fail(res, 400, '自己开单不能自己批准（admin 除外）——换生产主管或质量负责人批');
  }
  db.prepare("UPDATE rework_orders SET status='approved', approved_by=?, approved_at=?, approve_note=?, updated_at=? WHERE id=?")
    .run(req.user.username, t, b.note || null, t, r.id);
  return ok(res, rwView(r.id));
}));

rw.post('/:id/start', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM rework_orders WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '返工单不存在');
  if (r.status !== 'approved') return fail(res, 400, '只有已批准的单能开始返工');
  db.prepare("UPDATE rework_orders SET status='in_progress', updated_at=? WHERE id=?").run(now(), r.id);
  return ok(res, rwView(r.id));
}));

/** 复验：通过则闭环（损失进成本），不通过回返工中并累计次数 */
rw.post('/:id/reinspect', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM rework_orders WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '返工单不存在');
  if (r.status !== 'in_progress') return fail(res, 400, '只有返工中的单能复验');
  const b = req.body || {};
  const pass = b.result === 'pass';
  const note = String(b.note || '').trim();
  if (!note) return fail(res, 400, '复验必须写依据（抽检几件、结果如何）');
  const t = now();

  if (!pass) {
    db.prepare("UPDATE rework_orders SET status='in_progress', rework_times = rework_times + 1, reinspect_result='fail', reinspect_by=?, reinspect_at=?, reinspect_note=?, updated_at=? WHERE id=?")
      .run(req.user.username, t, note, t, r.id);
    const v = rwView(r.id);
    return ok(res, { rework: v, notice: `复验未通过，已回到返工中（第 ${v.rework_times} 次）` });
  }

  const qtyOk = round2(b.qty_ok === undefined || b.qty_ok === '' ? r.qty : b.qty_ok);
  if (qtyOk < 0 || qtyOk > r.qty + EPS) {
    return fail(res, 400, `返工后合格量不能超过不良数量（${r.qty}）`);
  }

  db.exec('BEGIN');
  try {
    db.prepare("UPDATE rework_orders SET status='closed', qty_ok=?, reinspect_result='pass', reinspect_by=?, reinspect_at=?, reinspect_note=?, updated_at=? WHERE id=?")
      .run(qtyOk, req.user.username, t, note, t, r.id);
    writeCostEntry(r, `复验通过`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, { rework: rwView(r.id), notice: '已闭环，损失已计入成本 rework 层' });
}));

/** 报废闭环（type=scrap）：批准后直接核销 */
rw.post('/:id/scrap', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM rework_orders WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '返工单不存在');
  if (r.type !== 'scrap') return fail(res, 400, '这张单是返工单，请走「开始返工 → 复验」');
  if (r.status !== 'approved') return fail(res, 400, '报废单要先批准才能核销');
  const b = req.body || {};
  const qtyScrap = round2(b.qty_scrap === undefined || b.qty_scrap === '' ? r.qty : b.qty_scrap);
  if (!(qtyScrap > 0) || qtyScrap > r.qty + EPS) {
    return fail(res, 400, `报废数量必须在 0 ~ ${r.qty} 之间`);
  }
  const note = String(b.note || '').trim();
  if (!note) return fail(res, 400, '报废核销必须写处置依据（谁核销、怎么处理）');
  const t = now();

  db.exec('BEGIN');
  try {
    db.prepare("UPDATE rework_orders SET status='closed', qty_scrap=?, reinspect_result='pass', reinspect_by=?, reinspect_at=?, reinspect_note=?, updated_at=? WHERE id=?")
      .run(qtyScrap, req.user.username, t, note, t, r.id);
    writeCostEntry(r, '报废核销');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, { rework: rwView(r.id), notice: '已核销，损失已计入成本 rework 层' });
}));

/** 返工/报废损失进成本 rework 层（幂等：同单只写一次） */
function writeCostEntry(r, note) {
  const fresh = db.prepare('SELECT * FROM rework_orders WHERE id = ?').get(r.id);
  if (Number(fresh.cost_entry_id)) return fresh.cost_entry_id;
  if (!(Number(fresh.cost_total) > EPS)) return null;
  const obj = ensureCostObject(fresh.order_id);
  if (!obj) return null;
  const t = now();
  const info = db.prepare(
    `INSERT INTO cost_entries (cost_object_id, layer, source, ref_type, ref_id, name, qty, unit, unit_price, amount, occurred_at, remark, created_by, created_at)
     VALUES (?, 'rework', 'manual', 'rework_order', ?, ?, ?, '件', ?, ?, ?, ?, ?, ?)`
  ).run(obj.id, fresh.id,
    `${fresh.type === 'scrap' ? '报废' : '返工'} ${fresh.rw_no}${fresh.node_name ? ' · ' + fresh.node_name : ''}`,
    Number(fresh.qty) || 0, round2(Number(fresh.cost_total) / Math.max(1, Number(fresh.qty) || 1)),
    round2(fresh.cost_total), t.slice(0, 10), `${note}：${fresh.reason}`.slice(0, 200),
    'system', t);
  const entryId = Number(info.lastInsertRowid);
  db.prepare('UPDATE rework_orders SET cost_entry_id = ? WHERE id = ?').run(entryId, fresh.id);
  recalc(obj.id);
  syncSold(obj.id, 'system');
  return entryId;
}

// ==================== 生产结单 ====================
closeR.get('/board', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { q = '' } = req.query;
  const w = ["o.status NOT IN ('draft','cancelled')"];
  const p = [];
  if (q) { w.push('(o.order_no LIKE ? OR o.style_name LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  const orders = db.prepare(
    `SELECT o.id, o.order_no, o.style_name, o.status FROM orders o WHERE ${w.join(' AND ')} ORDER BY o.id DESC LIMIT 100`
  ).all(...p);

  const rows = orders.map((o) => {
    const g = inspectOrder(o.id);
    const closed = db.prepare('SELECT * FROM production_closures WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(o.id);
    return {
      order_id: o.id,
      order_no: o.order_no,
      style_name: o.style_name,
      order_status: o.status,
      can_close: g && g.can_close,
      blocked: g ? g.blocked : [],
      warns: g ? g.warns : [],
      wip_nodes: g ? g.wip_nodes : 0,
      total_nodes: g ? g.total_nodes : 0,
      unshipped: g ? g.unshipped : 0,
      open_rework_cnt: g ? g.open_rework_cnt : 0,
      open_qc_cnt: g ? g.open_qc_cnt : 0,
      closure: closed ? { ...closed, close_type_label: CLOSE_LABEL[closed.close_type] } : null
    };
  });

  const stat = {
    orders: rows.length,
    closable: rows.filter((r) => r.can_close).length,
    blocked: rows.filter((r) => !r.can_close).length,
    closed: rows.filter((r) => r.closure).length,
    partial: rows.filter((r) => r.closure && r.closure.close_type === 'partial').length,
    wip_orders: rows.filter((r) => r.wip_nodes > 0).length
  };
  return ok(res, { rows, stat });
}));

closeR.get('/gate/:orderId', authRequired, requireRole(READ), wrap(async (req, res) => {
  const g = inspectOrder(Number(req.params.orderId));
  if (!g) return fail(res, 404, '订单不存在');
  const done = db.prepare('SELECT * FROM production_closures WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(g.order.id);
  return ok(res, { ...g, closure: done ? { ...done, close_type_label: CLOSE_LABEL[done.close_type] } : null });
}));

closeR.get('/order/:orderId', authRequired, requireRole(READ), wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM production_closures WHERE order_id = ? ORDER BY id DESC').all(req.params.orderId);
  return ok(res, rows.map((r) => ({ ...r, close_type_label: CLOSE_LABEL[r.close_type] })));
}));

closeR.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const g = inspectOrder(Number(b.order_id));
  if (!g) return fail(res, 404, '订单不存在');
  if (g.blocked.length) {
    return fail(res, 400, `结单受限：${g.blocked.map((x) => x.label).join('；')}。先把这些处理完再来结单`);
  }
  if (b.close_type === 'full' && g.warns.length) {
    return fail(res, 400, `还有未清项（${g.warns.map((x) => x.label).join('、')}），不能全结。要么先清掉，要么改成「部分关闭」并写争议挂账`);
  }
  const closeType = b.close_type === 'partial' ? 'partial' : (g.warns.length ? 'partial' : 'full');
  if (closeType === 'partial') {
    const dispute = String(b.dispute_note || '').trim();
    const balance = String(b.balance_source || '').trim();
    if (!dispute) return fail(res, 400, '部分关闭必须写争议挂账说明（未决的是什么、谁跟）');
    if (!balance) return fail(res, 400, '部分关闭必须写余额来源（未交 / 在制 / 质量 / 余料）');
  }
  const actual = String(b.actual_close_date || '').slice(0, 10) || now().slice(0, 10);
  const t = now();

  const dup = db.prepare("SELECT close_no FROM production_closures WHERE order_id = ? AND close_type = 'full'").get(g.order.id);
  if (dup && closeType === 'full') return fail(res, 400, `这单已经全结过了（${dup.close_no}），不要重复结单`);

  const closeNo = nextNo('CL', 'production_closures', 'close_no');
  const info = db.prepare(
    `INSERT INTO production_closures (close_no, order_id, order_no, close_type, status,
      open_rework_cnt, open_rework_qty, open_qc_cnt, wip_nodes, total_nodes, unshipped_qty, leftover_m, cost_open,
      blocked_json, warn_json, dispute_note, balance_source, follow_up_owner, actual_close_date, recorded_at, closed_by, remark, created_at)
     VALUES (?,?,?,?, 'closed', ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?)`
  ).run(closeNo, g.order.id, g.order.order_no, closeType,
    g.open_rework_cnt, g.open_rework_qty, g.open_qc_cnt, g.wip_nodes, g.total_nodes, g.unshipped, g.leftover_m, g.cost_open,
    null, (g.warns.length || g.notes.length) ? JSON.stringify([...g.warns, ...g.notes]) : null,
    b.dispute_note || null, b.balance_source || null, b.follow_up_owner || null,
    actual, t, req.user.username, b.remark || null, t);

  return ok(res, {
    id: Number(info.lastInsertRowid),
    close_no: closeNo,
    close_type: closeType,
    close_type_label: CLOSE_LABEL[closeType],
    actual_close_date: actual,
    recorded_at: t,
    warns: g.warns,
    notes: g.notes,
    notice: closeType === 'partial'
      ? `已部分关闭（${closeNo}）。未决项挂在争议挂账，跟进人 ${b.follow_up_owner || '未指定'}`
      : `已全结（${closeNo}）`
  });
}));

module.exports = { reworks: rw, close: closeR };
module.exports.inspectOrder = inspectOrder;
