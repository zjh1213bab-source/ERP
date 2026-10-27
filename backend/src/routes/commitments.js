/**
 * 接单评审与交期承诺（对应原型 TS-N06-01 接单评审 / TS-N06-04 延期预警 / TS-N06-08 三时钟）
 * ----------------------------------------------------------------------------
 * 三个时钟各自独立保留，不合并：
 *   对客承诺日 promised_date   —— 答应客户哪天交
 *   内部计划日 planned_date    —— 按路线节点排出来的计划哪天完
 *   最新预测   forecast_date   —— 按已完成实绩 + 剩余标准工时重算的预测
 *   实际出厂   actual_ship_date —— E1 实际发运，事后不改承诺与计划
 *
 * T0 = max(客户订单确认实际时点, 约定启动款项实际满足时点)
 *   - 付款前的客户沟通不计入
 *   - 付款后技术、供方、交单、财审、等待生产全部计入
 *   - 事后补核款不重置 T0
 *
 * 评审三项分别确认（不默认无限承接）：前端裁床算料 / 后端缝制后道 / 物料齐套。
 *
 * 节点时长未配置时标 null（待配置），不按 0 天算；
 * 督办点是跟踪日（T0 后第 N 天检查该节点），不是必定完工日。
 */
const express = require('express');
const { db, now, getSettings, saveSettings } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'production', 'sales'];

/* ---------------- 路线定义 ---------------- */

const NODE_DEF = {
  P1: { name: '裁床用量·算料', plan: 2, sup: null },
  P2: { name: '仓库开采购单', plan: 2, sup: null },
  P3: { name: '采购周期', plan: 7, sup: 5 },
  P4: { name: '仓库配料', plan: 2, sup: 7 },
  P5: { name: '实际裁剪', plan: 3, sup: 9 },
  P6: { name: '配辅料', plan: 2, sup: 11 },
  B1: { name: '车间缝制', plan: 3, sup: 12 },
  H1: { name: '本厂后道', plan: 3, sup: 14 },
  H2: { name: '终检·包装', plan: 2, sup: null },
  E1: { name: '出厂发运', plan: 1, sup: null },
  C1: { name: '交外厂（裁片运输）', plan: 2, sup: null },
  C2: { name: '外厂缝制', plan: 5, sup: null },
  C3: { name: '回厂点收·缝制检验', plan: 2, sup: null }
};

/** 本厂路线 / 裁片外发路线（外发不套 B1） */
const ROUTE = {
  inhouse: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'B1', 'H1', 'H2', 'E1'],
  outsource: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'C1', 'C2', 'C3', 'H1', 'H2', 'E1']
};

const STATUS_TEXT = { pending: '待开始', running: '进行中', done: '已完成', skipped: '已跳过' };

/* ---------------- 时间工具 ---------------- */

const toDate = (v) => {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const addDays = (dateStr, n) => {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + Math.round(Number(n) || 0));
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);
const dayDiff = (a, b) => {
  if (!a || !b) return 0;
  return Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
};
const maxDate = (...ds) => ds.filter(Boolean).sort().pop() || null;

/** 订单件数 */
function orderQty(orderId) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(s.qty),0) AS q FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?'
  ).get(orderId);
  return Number(r.q) || 0;
}

/**
 * T0：订单确认时点 与 启动款到账时点 取较晚者。
 * 订单确认取「流转到 tech（技术确认）」的最早记录，没有则用下单时间。
 */
function calcT0(order) {
  const confirmLog = db.prepare(
    "SELECT created_at FROM order_logs WHERE order_id = ? AND to_status = 'tech' ORDER BY created_at LIMIT 1"
  ).get(order.id);
  const confirmAt = confirmLog ? confirmLog.created_at : order.created_at;

  // 启动款：该订单应收单上最早的一笔有效收款
  const payRow = db.prepare(
    `SELECT MIN(p.pay_date) AS d FROM payment_allocations a
     JOIN payments p ON p.id = a.payment_id AND p.status = 'valid'
     JOIN ar_invoices inv ON inv.id = a.invoice_id AND a.invoice_kind = 'ar'
     WHERE inv.order_id = ?`
  ).get(order.id);
  const payAt = payRow ? payRow.d : null;

  const c = toDate(confirmAt);
  const p = toDate(payAt);
  let t0 = null;
  let source = 'confirm';
  if (c && p) {
    t0 = c >= p ? c : p;
    source = c === p ? 'both' : (c > p ? 'confirm' : 'payment');
  } else {
    t0 = c || p;
    source = c ? 'confirm' : 'payment';
  }
  return { t0, source, confirmAt: c, payAt: p };
}

/* ---------------- 节点与预测 ---------------- */

function loadNodes(commitmentId) {
  return db.prepare('SELECT * FROM commitment_nodes WHERE commitment_id = ? ORDER BY seq, id').all(commitmentId);
}

/** 按路线生成节点（幂等：已存在则跳过） */
function buildNodes(commitment, t0) {
  const exist = loadNodes(commitment.id);
  if (exist.length) return exist;
  const route = ROUTE[commitment.route_type] || ROUTE.inhouse;
  const ins = db.prepare(
    `INSERT INTO commitment_nodes (commitment_id, code, name, seq, plan_days, supervise_day, status)
     VALUES (?,?,?,?,?,?, 'pending')`
  );
  let cursor = t0;
  route.forEach((code, i) => {
    const def = NODE_DEF[code] || { name: code, plan: null, sup: null };
    const plan = def.plan === null || def.plan === undefined ? null : def.plan;
    const start = cursor;
    const end = plan === null ? null : addDays(start, plan);
    ins.run(commitment.id, code, def.name, i + 1, plan, def.sup);
    // 计划走日期：时长待配置时不推进游标，只记录「待配置」
    if (end) cursor = end;
  });
  return loadNodes(commitment.id);
}

/** 把节点计划日期回写到表上（生成/改路线后调用） */
function rebuildSchedule(commitmentId, t0) {
  const nodes = loadNodes(commitmentId);
  let cursor = t0 || today();
  const upd = db.prepare('UPDATE commitment_nodes SET start_date = ?, end_date = ? WHERE id = ?');
  nodes.forEach((n) => {
    const plan = n.plan_days === null || n.plan_days === undefined ? null : Number(n.plan_days);
    if (plan === null) {
      upd.run(null, null, n.id);
      return;
    }
    const start = cursor;
    const end = addDays(start, plan);
    upd.run(start, end, n.id);
    cursor = end;
  });
  return { planned: cursor, nodes: loadNodes(commitmentId) };
}

/**
 * 重算预测与风险
 *   forecast = max(T0, 已完成节点的实际完工日) + 剩余节点标准时长合计
 *   延期天数 = forecast - promised（>0 即超期）
 */
function reforecast(commitmentId) {
  const c = db.prepare('SELECT * FROM commitments WHERE id = ?').get(commitmentId);
  if (!c) return null;
  const nodes = loadNodes(commitmentId);

  // 已完工：用实际完工日；未完工：累加标准时长
  let base = c.t0_at ? toDate(c.t0_at) : null;
  let remainDays = 0;
  let pendingConfig = 0;
  nodes.forEach((n) => {
    if (n.status === 'done' || n.status === 'skipped') {
      const end = toDate(n.actual_end) || toDate(n.end_date);
      if (end) base = maxDate(base, end);
      return;
    }
    if (n.plan_days === null || n.plan_days === undefined) { pendingConfig++; return; }
    remainDays += Number(n.plan_days) || 0;
  });

  const allDone = nodes.length > 0 && nodes.every((n) => n.status === 'done' || n.status === 'skipped');
  const forecast = allDone
    ? (c.actual_ship_date || base)
    : addDays(maxDate(base, today()) === base ? base : base, remainDays);
  // 预测不会早于今天（已经拖到的天数无法退回）
  const forecastFinal = allDone ? forecast : maxDate(forecast, today());

  const delay = c.promised_date ? dayDiff(forecastFinal, c.promised_date) : 0;
  let risk = 'none';
  if (allDone) risk = 'done';
  else if (!c.promised_date) risk = 'none';
  else if (delay > 0) risk = 'red';
  else if (delay > -3) risk = 'yellow'; // 缓冲不足 3 天

  // 督办点逾期：跟踪日已过但节点未完成
  let supOverdue = 0;
  if (!allDone) {
    nodes.forEach((n) => {
      if (!n.supervise_day || n.status === 'done' || n.status === 'skipped') return;
      const supDate = c.t0_at ? addDays(toDate(c.t0_at), n.supervise_day) : null;
      if (supDate && supDate < today()) supOverdue++;
    });
    if (supOverdue > 0 && risk === 'none') risk = 'yellow';
  }

  db.prepare('UPDATE commitments SET forecast_date = ?, risk_level = ?, delay_days = ?, updated_at = ? WHERE id = ?')
    .run(forecastFinal, risk, delay, now(), commitmentId);

  return { forecast: forecastFinal, risk, delay, allDone, pendingConfig, supOverdue };
}

/** 创建或取回承诺单 */
function ensureCommitment(orderId, routeType, userId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  let c = db.prepare('SELECT * FROM commitments WHERE order_id = ?').get(orderId);
  const cust = order.customer_id
    ? db.prepare('SELECT name FROM customers WHERE id = ?').get(order.customer_id)
    : null;
  const qty = orderQty(orderId);
  const t = now();
  const t0info = calcT0(order);

  if (!c) {
    const info = db.prepare(
      `INSERT INTO commitments (order_id, order_no, customer_name, style_no, qty, route_type,
        t0_at, t0_source, promised_date, planned_date, review_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`
    ).run(
      orderId, order.order_no, cust ? cust.name : null, order.style_name || null, qty,
      routeType || 'inhouse', t0info.t0, t0info.source,
      order.delivery_date || null, null, t, t
    );
    c = db.prepare('SELECT * FROM commitments WHERE id = ?').get(Number(info.lastInsertRowid));
    buildNodes(c, t0info.t0 || today());
  } else {
    // 件数 / 客户 / 起算时钟每次进来同步（T0 一旦定下就不再因事后补款变化）
    db.prepare('UPDATE commitments SET qty = ?, customer_name = ?, style_no = ?, updated_at = ? WHERE id = ?')
      .run(qty, cust ? cust.name : null, order.style_name || null, t, c.id);
    if (!c.t0_at && t0info.t0) {
      db.prepare('UPDATE commitments SET t0_at = ?, t0_source = ? WHERE id = ?').run(t0info.t0, t0info.source, c.id);
      c = db.prepare('SELECT * FROM commitments WHERE id = ?').get(c.id);
    }
    buildNodes(c, c.t0_at || today());
  }

  // 计划日：已评审过且没手工改过就一直按节点算
  const sch = rebuildSchedule(c.id, c.t0_at || today());
  if (!c.planned_date) {
    db.prepare('UPDATE commitments SET planned_date = ? WHERE id = ?').run(sch.planned, c.id);
  }
  reforecast(c.id);
  return db.prepare('SELECT * FROM commitments WHERE id = ?').get(c.id);
}

/* ---------------- 产能负荷参考 ---------------- */

/** 在制件数：已分单 / 生产中 / 已入库 未发货的订单件数 */
function wipQty(excludeOrderId) {
  const rows = db.prepare(
    `SELECT o.id, COALESCE(SUM(s.qty),0) AS q
     FROM orders o
     LEFT JOIN order_items i ON i.order_id = o.id
     LEFT JOIN order_item_sizes s ON s.item_id = i.id
     WHERE o.status IN ('assigned','production','instock')${excludeOrderId ? ' AND o.id != ?' : ''}
     GROUP BY o.id`
  ).all(...(excludeOrderId ? [excludeOrderId] : []));
  return rows.reduce((a, r) => a + (Number(r.q) || 0), 0);
}

function capacityInfo(orderId) {
  const settings = getSettings();
  const monthCap = Number(settings.capacityPerMonth) || 5000;
  const wip = wipQty(orderId);
  const qty = orderId ? orderQty(orderId) : 0;
  const load = monthCap > 0 ? Math.round(((wip + qty) / monthCap) * 100) : 0;
  let advice = '可承接';
  if (load > 100) advice = '超负荷，建议协商延期或外发';
  else if (load > 80) advice = '偏紧，注意排产顺序';
  return { capacity_per_month: monthCap, wip_qty: wip, order_qty: qty, load_pct: load, advice };
}

/* ---------------- 视图 ---------------- */

function viewCommitment(c) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(c.order_id);
  const nodes = loadNodes(c.id).map((n) => ({
    ...n,
    status_text: STATUS_TEXT[n.status] || n.status,
    supervise_date: n.supervise_day && c.t0_at ? addDays(toDate(c.t0_at), n.supervise_day) : null,
    overdue: !!(n.supervise_day && c.t0_at && n.status !== 'done' && n.status !== 'skipped'
      && addDays(toDate(c.t0_at), n.supervise_day) < today())
  }));
  const doneCount = nodes.filter((n) => n.status === 'done' || n.status === 'skipped').length;
  return {
    ...c,
    front_ok: !!c.front_ok,
    back_ok: !!c.back_ok,
    material_ok: !!c.material_ok,
    order_status: order ? order.status : null,
    order_type: order ? order.type : null,
    delivery_date: order ? order.delivery_date : null,
    promise_gap: c.promised_date && c.forecast_date ? dayDiff(c.forecast_date, c.promised_date) : 0,
    nodes,
    progress: nodes.length ? Math.round((doneCount / nodes.length) * 100) : 0,
    done_nodes: doneCount,
    total_nodes: nodes.length
  };
}

/* ---------------- 接口 ---------------- */

/** 看板：指标 + 列表 */
router.get('/board', authRequired, wrap(async (req, res) => {
  const { q, risk, review } = req.query;
  const where = [];
  const args = [];
  if (risk) { where.push('risk_level = ?'); args.push(risk); }
  if (review) { where.push('review_status = ?'); args.push(review); }
  if (q) {
    where.push('(order_no LIKE ? OR customer_name LIKE ? OR style_no LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = db.prepare(
    `SELECT * FROM commitments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`
  ).all(...args);
  // 列表不带节点明细，只看汇总；预测/风险实时重算一遍保证不过期
  rows.forEach((r) => reforecast(r.id));
  const fresh = db.prepare(
    `SELECT * FROM commitments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`
  ).all(...args);

  const all = db.prepare('SELECT * FROM commitments').all();
  const stat = {
    total: all.length,
    pending: all.filter((x) => x.review_status === 'pending').length,
    approved: all.filter((x) => x.review_status === 'approved').length,
    rejected: all.filter((x) => x.review_status === 'rejected').length,
    risk_red: all.filter((x) => x.risk_level === 'red').length,
    risk_yellow: all.filter((x) => x.risk_level === 'yellow').length,
    done: all.filter((x) => x.risk_level === 'done').length
  };
  return ok(res, {
    stat,
    rows: fresh.map((c) => {
      const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(c.order_id);
      const nodes = loadNodes(c.id);
      const doneCnt = nodes.filter((n) => n.status === 'done' || n.status === 'skipped').length;
      return {
        ...c,
        order_status: order ? order.status : null,
        progress: nodes.length ? Math.round((doneCnt / nodes.length) * 100) : 0,
        promise_gap: c.promised_date && c.forecast_date ? dayDiff(c.forecast_date, c.promised_date) : 0
      };
    })
  });
}));

/** 产能负荷参考 */
router.get('/capacity', authRequired, wrap(async (req, res) =>
  ok(res, capacityInfo(req.query.order_id ? Number(req.query.order_id) : null))));

/** 设置月产能 */
router.post('/capacity', authRequired, requireRole(['admin']), wrap(async (req, res) => {
  const v = Number((req.body || {}).capacity_per_month);
  if (!(v > 0)) return fail(res, 400, '月产能必须大于 0');
  saveSettings({ capacityPerMonth: v });
  return ok(res, capacityInfo());
}));

/** 按订单取承诺单（不存在就建） */
router.get('/order/:orderId', authRequired, wrap(async (req, res) => {
  const c = ensureCommitment(req.params.orderId, req.query.route_type, req.user.username);
  if (!c) return fail(res, 404, '订单不存在');
  return ok(res, { ...viewCommitment(c), capacity: capacityInfo(c.order_id) });
}));

/** 手动生成/重建路线 */
router.post('/order/:orderId/ensure', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = ensureCommitment(req.params.orderId, (req.body || {}).route_type, req.user.username);
  if (!c) return fail(res, 404, '订单不存在');
  return ok(res, viewCommitment(c));
}));

/** 评审：三项确认 + 承诺日 */
router.post('/:id/review', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '承诺单不存在');
  const b = req.body || {};

  const frontOk = b.front_ok ? 1 : 0;
  const backOk = b.back_ok ? 1 : 0;
  const materialOk = b.material_ok ? 1 : 0;
  const promised = toDate(b.promised_date) || c.promised_date;
  const note = (b.note || '').trim();

  if (!promised) return fail(res, 400, '请填写对客承诺交期');
  // 承诺日不能早于 T0：日期已经过去的承诺没有意义，属于填错
  const t0 = toDate(c.t0_at);
  if (t0 && promised < t0) return fail(res, 400, `承诺交期 ${promised} 早于起算日 T0（${t0}），请重新确认`);
  if (!note) return fail(res, 400, '请填写评审意见（承接依据 / 不接受的原因）');

  const allOk = frontOk && backOk && materialOk;
  const status = allOk ? 'approved' : 'rejected';
  if (!allOk && !note) return fail(res, 400, '有环节不能承接时必须写明原因');

  const t = now();
  db.prepare(
    `UPDATE commitments SET front_ok = ?, back_ok = ?, material_ok = ?, promised_date = ?,
      review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(frontOk, backOk, materialOk, promised, status, note, req.user.username, t, t, c.id);

  // 承诺日定了，计划日按节点重排一次
  const sch = rebuildSchedule(c.id, c.t0_at || today());
  db.prepare('UPDATE commitments SET planned_date = ? WHERE id = ?').run(sch.planned, c.id);
  reforecast(c.id);

  const fresh = db.prepare('SELECT * FROM commitments WHERE id = ?').get(c.id);
  return ok(res, viewCommitment(fresh), { sch });
}));

/** 更新节点实绩 */
router.post('/:id/nodes/:nodeId', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '承诺单不存在');
  const n = db.prepare('SELECT * FROM commitment_nodes WHERE id = ? AND commitment_id = ?').get(req.params.nodeId, c.id);
  if (!n) return fail(res, 404, '节点不存在');
  const b = req.body || {};
  const status = ['pending', 'running', 'done', 'skipped'].includes(b.status) ? b.status : n.status;

  const actualStart = b.actual_start !== undefined ? (toDate(b.actual_start) || null) : n.actual_start;
  let actualEnd = b.actual_end !== undefined ? (toDate(b.actual_end) || null) : n.actual_end;
  if (status === 'done' && !actualEnd) actualEnd = today();
  if (status !== 'done' && status !== 'skipped') actualEnd = b.actual_end === '' ? null : actualEnd;

  // 节点延期天数：实际完工 vs 计划完工
  const delay = actualEnd && n.end_date ? Math.max(0, dayDiff(actualEnd, n.end_date)) : (n.delay_days || 0);

  db.prepare(
    `UPDATE commitment_nodes SET status = ?, actual_start = ?, actual_end = ?, delay_days = ?, owner = ?, note = ?
     WHERE id = ?`
  ).run(status, actualStart, actualEnd, delay, b.owner !== undefined ? b.owner : n.owner,
    b.note !== undefined ? b.note : n.note, n.id);

  // E1 完成 = 实际出厂，写回主表
  if (n.code === 'E1' && status === 'done') {
    db.prepare('UPDATE commitments SET actual_ship_date = ? WHERE id = ?').run(actualEnd || today(), c.id);
  }
  reforecast(c.id);
  return ok(res, viewCommitment(db.prepare('SELECT * FROM commitments WHERE id = ?').get(c.id)));
}));

/** 只重算预测 */
router.post('/:id/reforecast', authRequired, wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '承诺单不存在');
  const r = reforecast(c.id);
  return ok(res, { ...r, commitment: viewCommitment(db.prepare('SELECT * FROM commitments WHERE id = ?').get(c.id)) });
}));

/** 节点定义（前端展示口径用） */
router.get('/node-defs', authRequired, wrap(async (req, res) =>
  ok(res, { defs: NODE_DEF, routes: ROUTE })));

module.exports = router;
module.exports.ensureCommitment = ensureCommitment;
module.exports.reforecast = reforecast;
module.exports.viewCommitment = viewCommitment;
