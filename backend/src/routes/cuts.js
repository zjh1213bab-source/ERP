/**
 * 裁床排料与扎包（对应原型 TS-N08-02 P5 实际裁剪）
 * ------------------------------------------------------------
 * 流程：P4 配料接收 → 引用 P1 已核用量与技术版 → P5 实际裁剪（分床）→ 裁片检查扎包 → P6 辅料交接
 *
 * 硬规则（写在代码里）：
 *   1) 面料没齐套（缺料）不允许开裁 —— 引用齐套结论，不让人凭感觉开
 *   2) 技术版必须已确认 —— 没确认的版不能上裁床
 *   3) 面料未在裁剪现场接收（P4）不允许开裁
 *   4) 错缸不放行：同一裁剪单的床次缸号必须一致，混缸需显式确认并写明原因
 *   5) 完成裁剪时合格裁片数必须对得上计划件数，有裁差必须写原因
 *   6) 扎包数量合计必须等于合格裁片数，不能凭空多出或少掉
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { findByCode } = require('../services/nodeFlow');

const router = express.Router();
const WRITE = ['admin', 'production', 'warehouse'];

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const int = (v) => Math.round(Number(v) || 0);
const EPS = 0.005;

function nextCutNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const row = db.prepare('SELECT cut_no FROM cut_orders WHERE cut_no LIKE ? ORDER BY id DESC LIMIT 1').get(`CY${ymd}%`);
  const seq = row ? Number(String(row.cut_no).slice(-4)) + 1 : 1;
  return genNo('CY', seq);
}

function orderQty(orderId) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(s.qty),0) AS q FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?'
  ).get(orderId);
  return int(r.q);
}

/** 订单尺码明细（扎包按这个拆） */
function sizeRows(orderId) {
  return db.prepare(
    `SELECT s.color, s.size, SUM(s.qty) AS qty
     FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id
     WHERE i.order_id = ?
     GROUP BY s.color, s.size
     ORDER BY s.color, s.size`
  ).all(orderId);
}

/** 引用齐套结论：面料齐才能开裁 */
function fabricReady(orderId) {
  const rows = db.prepare("SELECT * FROM material_requirements WHERE order_id = ? AND mat_type = 'fabric'").all(orderId);
  if (!rows.length) return { ok: false, reason: '这单还没有面料需求记录（开发单缺面辅料明细），请先在「齐套与缺料」里重算' };
  const short = rows.filter((r) => r.gap_qty > EPS);
  if (short.length) {
    const names = short.map((r) => `${r.material_name} 缺 ${r.gap_qty}${r.unit || ''}`).join('、');
    return { ok: false, reason: `面料未齐套：${names}。请先采购到货或调整物料后再开裁` };
  }
  return { ok: true };
}

/** 汇总床次 / 扎包到裁剪单 */
function summarize(cutId) {
  const lots = db.prepare('SELECT * FROM cut_lots WHERE cut_order_id = ? ORDER BY seq, id').all(cutId);
  const bundles = db.prepare('SELECT * FROM cut_bundles WHERE cut_order_id = ?').all(cutId);
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(cutId);

  const totalLayers = lots.reduce((s, l) => s + int(l.layers), 0);
  const totalCut = lots.reduce((s, l) => s + int(l.actual_qty), 0);
  const leftover = r2(lots.reduce((s, l) => s + (Number(l.leftover_m) || 0), 0));
  const dyeLots = [...new Set(lots.map((l) => l.dye_lot).filter(Boolean))];
  const mixed = dyeLots.length > 1 ? 1 : 0;

  db.prepare(
    `UPDATE cut_orders SET lot_count = ?, total_layers = ?, total_cut_qty = ?, leftover_m = ?,
      mixed_dye_lot = ?, diff_qty = ?, bundle_count = ?, bundle_qty = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    lots.length, totalLayers, totalCut, leftover, mixed, totalCut - int(c.plan_qty),
    bundles.length, bundles.reduce((s, b) => s + int(b.qty), 0), now(), cutId
  );
  return db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(cutId);
}

/** 创建或取回裁剪单 */
function ensureCutOrder(orderId, userId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  let c = db.prepare('SELECT * FROM cut_orders WHERE order_id = ?').get(orderId);
  const tp = db.prepare(
    "SELECT * FROM tech_packs WHERE order_id = ? ORDER BY (status = 'confirmed') DESC, id DESC LIMIT 1"
  ).get(orderId);
  const qty = orderQty(orderId);
  const t = now();
  if (!c) {
    const info = db.prepare(
      `INSERT INTO cut_orders (cut_no, order_id, order_no, style_no, tech_pack_id, plan_qty, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'draft', ?, ?)`
    ).run(nextCutNo(), orderId, order.order_no, order.style_name || null, tp ? tp.id : null, qty, t, t);
    c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(Number(info.lastInsertRowid));
  } else {
    db.prepare('UPDATE cut_orders SET plan_qty = ?, style_no = ?, tech_pack_id = ?, updated_at = ? WHERE id = ?')
      .run(qty, order.style_name || null, tp ? tp.id : null, t, c.id);
    c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(c.id);
  }
  return c;
}

function view(c) {
  const lots = db.prepare('SELECT * FROM cut_lots WHERE cut_order_id = ? ORDER BY seq, id').all(c.id);
  const bundles = db.prepare('SELECT * FROM cut_bundles WHERE cut_order_id = ? ORDER BY id').all(c.id);
  const plan = int(c.plan_qty);
  const qualified = int(c.qualified_qty);
  const bundleQty = bundles.reduce((s, b) => s + int(b.qty), 0);
  const dyeLots = [...new Set(lots.map((l) => l.dye_lot).filter(Boolean))];
  return {
    ...c,
    lots,
    bundles,
    dye_lots: dyeLots,
    plan_qty: plan,
    bundle_qty: bundleQty,
    // 核对：实裁 vs 计划、扎包 vs 合格裁片
    cut_diff: int(c.total_cut_qty) - plan,
    bundle_diff: bundleQty - qualified,
    can_finish: lots.length > 0 && qualified > 0 && bundleQty === qualified && (int(c.total_cut_qty) - plan === 0 || !!c.diff_reason),
    fabric_gate: fabricReady(c.order_id),
    size_plan: sizeRows(c.order_id)
  };
}

/* ---------------- 接口 ---------------- */

/** 裁剪看板 */
router.get('/board', authRequired, wrap(async (req, res) => {
  const { q, status } = req.query;
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (q) { where.push('(order_no LIKE ? OR style_no LIKE ? OR cut_no LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  // 只管还在生产链路上的订单：已分单/生产中/已入库，以及已评审通过待生产的草稿单
  const orders = db.prepare(
    `SELECT o.id, o.order_no, o.style_name, o.status
     FROM orders o
     LEFT JOIN commitments c ON c.order_id = o.id
     WHERE o.status IN ('assigned','production','instock')
        OR (o.status = 'draft' AND c.review_status = 'approved')
     ORDER BY o.id DESC`
  ).all();
  orders.forEach((o) => ensureCutOrder(o.id, req.user.username));

  const activeIds = new Set(orders.map((o) => o.id));
  const rows = db.prepare(
    `SELECT * FROM cut_orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`
  ).all(...args).filter((c) => activeIds.has(c.order_id)).map((c) => {
    const gate = fabricReady(c.order_id);
    return {
      ...c,
      plan_qty: int(c.plan_qty),
      fabric_ok: gate.ok,
      fabric_reason: gate.ok ? null : gate.reason,
      progress: int(c.plan_qty) > 0 ? Math.min(100, Math.round((int(c.total_cut_qty) / int(c.plan_qty)) * 100)) : 0
    };
  });

  const stat = {
    total: rows.length,
    draft: rows.filter((r) => r.status === 'draft').length,
    cutting: rows.filter((r) => r.status === 'cutting').length,
    cut_done: rows.filter((r) => r.status === 'cut_done').length,
    handed: rows.filter((r) => r.status === 'handed').length,
    plan_qty: rows.reduce((s, r) => s + int(r.plan_qty), 0),
    cut_qty: rows.reduce((s, r) => s + int(r.total_cut_qty), 0),
    mixed: rows.filter((r) => r.mixed_dye_lot).length
  };
  return ok(res, { stat, rows });
}));

/** 单订单裁剪单（不存在则建） */
router.get('/order/:orderId', authRequired, wrap(async (req, res) => {
  const c = ensureCutOrder(req.params.orderId, req.user.username);
  if (!c) return fail(res, 404, '订单不存在');
  return ok(res, view(c));
}));

/** 开裁检查 + 置为裁剪中 */
router.post('/:id/start', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '裁剪单不存在');
  if (c.status === 'handed' || c.status === 'cut_done') return fail(res, 400, '这单裁剪已完成，不能重新开裁');

  const b = req.body || {};
  // 1. 技术版已确认
  const tp = c.tech_pack_id ? db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(c.tech_pack_id) : null;
  if (!tp || tp.status !== 'confirmed') {
    return fail(res, 400, '技术版未确认：上裁床前必须引用已确认的开发单（含面辅料明细与工艺要求）');
  }
  // 2. 面料齐套
  const gate = fabricReady(c.order_id);
  if (!gate.ok) return fail(res, 400, gate.reason);
  // 3. P4 面料已在裁剪现场接收
  const fabricReadyFlag = b.fabric_ready === false ? 0 : 1;
  if (!fabricReadyFlag) return fail(res, 400, '请先确认面料已配送到裁剪现场（P4 配料接收），再开裁');

  const t = now();
  db.prepare("UPDATE cut_orders SET status = 'cutting', fabric_ready = 1, cut_by = ?, cut_at = COALESCE(cut_at, ?), updated_at = ? WHERE id = ?")
    .run(req.user.username, t, t, c.id);
  return ok(res, view(db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(c.id)));
}));

/** 新增 / 更新床次 */
router.post('/:id/lots', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '裁剪单不存在');
  if (c.status === 'cut_done' || c.status === 'handed') return fail(res, 400, '裁剪已完成，不能再加床次');
  const b = req.body || {};
  if (!b.dye_lot || !String(b.dye_lot).trim()) return fail(res, 400, '请填写缸号：错缸是裁床最常见的质量事故，必须记录');
  const layers = int(b.layers);
  if (layers <= 0) return fail(res, 400, '拉布层数必须大于 0');
  const actual = int(b.actual_qty);
  if (actual < 0) return fail(res, 400, '实裁件数不能为负');

  // 错缸校验：同单床次缸号必须一致，混缸要显式确认
  const existLots = db.prepare('SELECT * FROM cut_lots WHERE cut_order_id = ?').all(c.id);
  const otherLots = existLots.filter((l) => l.id !== Number(b.id || 0));
  const otherDye = [...new Set(otherLots.map((l) => l.dye_lot).filter(Boolean))];
  if (otherDye.length && !otherDye.includes(String(b.dye_lot).trim())) {
    if (!b.allow_mixed) {
      return fail(res, 400, `错缸：这单已用缸号「${otherDye.join('、')}」，本次填的是「${b.dye_lot}」。` +
        '同单混缸会造成色差，如确需混缸请勾选「确认混缸」并写明原因');
    }
    if (!b.note || !String(b.note).trim()) return fail(res, 400, '混缸必须写明原因');
  }

  const t = now();
  const payload = [
    String(b.dye_lot).trim(), b.fabric_roll || null, b.width || null, layers,
    b.marker_no || null, r2(b.marker_len), int(b.plan_qty), actual, r2(b.leftover_m),
    b.status || (actual > 0 ? 'done' : 'cutting'), b.operator || req.user.username, b.note || null, t
  ];

  if (b.id) {
    const row = db.prepare('SELECT * FROM cut_lots WHERE id = ? AND cut_order_id = ?').get(b.id, c.id);
    if (!row) return fail(res, 404, '床次不存在');
    db.prepare(
      `UPDATE cut_lots SET dye_lot = ?, fabric_roll = ?, width = ?, layers = ?, marker_no = ?, marker_len = ?,
        plan_qty = ?, actual_qty = ?, leftover_m = ?, status = ?, operator = ?, note = ?, updated_at = ? WHERE id = ?`
    ).run(...payload, b.id);
  } else {
    const seq = existLots.length + 1;
    db.prepare(
      `INSERT INTO cut_lots (cut_order_id, seq, bed_no, dye_lot, fabric_roll, width, layers, marker_no, marker_len,
        plan_qty, actual_qty, leftover_m, status, operator, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(c.id, seq, b.bed_no || seq + ' 床', ...payload.slice(0, 12), t, t);
  }
  summarize(c.id);
  return ok(res, view(db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(c.id)));
}));

router.delete('/:id/lots/:lotId', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '裁剪单不存在');
  const row = db.prepare('SELECT * FROM cut_lots WHERE id = ? AND cut_order_id = ?').get(req.params.lotId, c.id);
  if (!row) return fail(res, 404, '床次不存在');
  db.prepare('DELETE FROM cut_lots WHERE id = ?').run(row.id);
  // 床次删了，挂在它下面的扎包也要清掉，否则扎包数对不上
  db.prepare('DELETE FROM cut_bundles WHERE lot_id = ?').run(row.id);
  // 床号重排
  db.prepare('SELECT id FROM cut_lots WHERE cut_order_id = ? ORDER BY seq, id').all(c.id)
    .forEach((l, i) => db.prepare('UPDATE cut_lots SET seq = ? WHERE id = ?').run(i + 1, l.id));
  summarize(c.id);
  return ok(res, view(db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(c.id)));
}));

/** 按订单尺码明细自动生成扎包（每扎 N 件） */
router.post('/:id/bundles/generate', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '裁剪单不存在');
  const per = int((req.body || {}).per_bundle) || int(c.bundle_rule) || 20;
  if (per <= 0) return fail(res, 400, '每扎件数必须大于 0');
  const replace = !!(req.body || {}).replace;

  const sizes = sizeRows(c.order_id);
  if (!sizes.length) return fail(res, 400, '这单没有尺码明细，无法生成扎包；请先在订单里填花色码数量');

  // 基数用已录入的实裁件数（还没裁就退回计划件数）；按尺码比例分摊，保证扎包合计对得上实裁
  const plannedTotal = sizes.reduce((s, x) => s + int(x.qty), 0);
  const base = int(c.total_cut_qty) > 0 ? int(c.total_cut_qty) : plannedTotal;
  const perColor = [];
  let assigned = 0;
  sizes.forEach((x, i) => {
    const last = i === sizes.length - 1;
    // 最后一个尺码吃差额，避免四舍五入后总数对不上
    const q = last ? base - assigned : Math.round((int(x.qty) / plannedTotal) * base);
    assigned += q;
    if (q > 0) perColor.push({ color: x.color, size: x.size, qty: q });
  });

  if (replace) db.prepare('DELETE FROM cut_bundles WHERE cut_order_id = ?').run(c.id);

  const t = now();
  let seq = db.prepare('SELECT COUNT(*) AS c FROM cut_bundles WHERE cut_order_id = ?').get(c.id).c;
  const ins = db.prepare(
    'INSERT INTO cut_bundles (cut_order_id, lot_id, bundle_no, color, size, qty, status, created_at) VALUES (?,?,?,?,?,?, \'created\', ?)'
  );
  let made = 0;
  perColor.forEach((s) => {
    let left = int(s.qty);
    while (left > 0) {
      const qty = Math.min(per, left);
      seq++;
      ins.run(c.id, null, 'B' + String(seq).padStart(3, '0'), s.color || null, s.size || null, qty, t);
      left -= qty;
      made++;
    }
  });
  db.prepare('UPDATE cut_orders SET bundle_rule = ?, updated_at = ? WHERE id = ?').run(per, t, c.id);
  summarize(c.id);
  return ok(res, { ...view(db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(c.id)), made });
}));

/** 单条扎包：新增 / 更新 / 复核 */
router.post('/:id/bundles', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '裁剪单不存在');
  const b = req.body || {};
  const t = now();

  if (b.id) {
    const row = db.prepare('SELECT * FROM cut_bundles WHERE id = ? AND cut_order_id = ?').get(b.id, c.id);
    if (!row) return fail(res, 404, '扎包不存在');
    if (b.status === 'checked' && row.status !== 'checked') {
      db.prepare("UPDATE cut_bundles SET status = 'checked', checked_by = ?, checked_at = ?, note = COALESCE(?, note) WHERE id = ?")
        .run(req.user.username, t, b.note || null, row.id);
    } else {
      db.prepare('UPDATE cut_bundles SET qty = COALESCE(?, qty), size = COALESCE(?, size), color = COALESCE(?, color), note = COALESCE(?, note) WHERE id = ?')
        .run(b.qty !== undefined ? int(b.qty) : null, b.size || null, b.color || null, b.note || null, row.id);
    }
  } else {
    if (!b.bundle_no) return fail(res, 400, '请填写扎号');
    const dup = db.prepare('SELECT 1 AS x FROM cut_bundles WHERE cut_order_id = ? AND bundle_no = ?').get(c.id, b.bundle_no);
    if (dup) return fail(res, 400, `扎号 ${b.bundle_no} 已存在`);
    db.prepare('INSERT INTO cut_bundles (cut_order_id, lot_id, bundle_no, color, size, qty, status, created_at) VALUES (?,?,?,?,?,?, \'created\', ?)')
      .run(c.id, b.lot_id || null, b.bundle_no, b.color || null, b.size || null, int(b.qty), t);
  }
  summarize(c.id);
  return ok(res, view(db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(c.id)));
}));

router.delete('/:id/bundles/:bundleId', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '裁剪单不存在');
  db.prepare('DELETE FROM cut_bundles WHERE id = ? AND cut_order_id = ?').run(req.params.bundleId, c.id);
  summarize(c.id);
  return ok(res, view(db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(c.id)));
}));

/**
 * 完成裁剪：核对数量 + 同步工序节点
 * body: { qualified_qty, reject_qty, diff_reason, checked_by }
 */
router.post('/:id/finish', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '裁剪单不存在');
  if (c.status === 'cut_done' || c.status === 'handed') return fail(res, 400, '已经完成过');

  const lots = db.prepare('SELECT * FROM cut_lots WHERE cut_order_id = ?').all(c.id);
  if (!lots.length) return fail(res, 400, '还没有床次记录，先录入实际裁剪的床次再完成');
  const totalCut = lots.reduce((s, l) => s + int(l.actual_qty), 0);
  const plan = int(c.plan_qty);

  const b = req.body || {};
  const qualified = b.qualified_qty !== undefined ? int(b.qualified_qty) : totalCut;
  if (qualified <= 0) return fail(res, 400, '合格裁片数必须大于 0');
  const reject = b.reject_qty !== undefined ? int(b.reject_qty) : Math.max(0, totalCut - qualified);

  // 数量不符不放行：裁差必须解释
  const diff = totalCut - plan;
  const reason = (b.diff_reason || c.diff_reason || '').trim();
  if (diff !== 0 && !reason) {
    return fail(res, 400, `实裁 ${totalCut} 件与计划 ${plan} 件相差 ${diff > 0 ? '+' : ''}${diff} 件，` +
      '请填写裁差原因（如：幅宽不足少排、疵片剔除、超裁备损）后再完成');
  }

  // 扎包必须与合格裁片对得上
  const bundleQty = db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM cut_bundles WHERE cut_order_id = ?').get(c.id).q;
  if (int(bundleQty) !== qualified) {
    return fail(res, 400, `扎包合计 ${int(bundleQty)} 件与合格裁片 ${qualified} 件不一致，` +
      '请先核对扎包（可点「按尺码自动生成」重排）后再完成');
  }

  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE cut_orders SET status = 'cut_done', qualified_qty = ?, reject_qty = ?, diff_qty = ?, diff_reason = ?,
        checked_by = ?, checked_at = ?, updated_at = ? WHERE id = ?`
    ).run(qualified, reject, diff, reason || null, b.checked_by || req.user.username, t, t, c.id);

    // 同步工序里的「裁剪」节点。
    // **按 code 找，不按名字**：业务把「裁剪」改成「裁床」「开裁」都常见，
    // 按名字 LIKE '%裁剪%' 会在改名那一刻静默失效 —— 裁床单做完了、节点还停在待开始。
    const node = findByCode(c.order_id, 'cut');
    if (node && node.status !== 'done') {
      db.prepare("UPDATE order_nodes SET status = 'done', actual_date = ?, operator = ?, remark = COALESCE(remark,'') || ? WHERE id = ?")
        .run(t.slice(0, 10), req.user.username, ` [裁床 ${c.cut_no} 完成，合格 ${qualified} 件]`, node.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `完成裁剪失败：${e.message}`);
  }
  return ok(res, view(db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(c.id)));
}));

/** P6 辅料交接：裁片与辅料一起交给缝制 */
router.post('/:id/handover', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '裁剪单不存在');
  if (c.status !== 'cut_done') return fail(res, 400, '裁剪还没完成，不能交接');
  const unchecked = db.prepare("SELECT COUNT(*) AS c FROM cut_bundles WHERE cut_order_id = ? AND status != 'checked'").get(c.id).c;
  if (unchecked > 0) return fail(res, 400, `还有 ${unchecked} 扎没有复核，复核完才能交接`);

  const t = now();
  db.prepare("UPDATE cut_orders SET status = 'handed', handover_at = ?, updated_at = ? WHERE id = ?").run(t, t, c.id);
  db.prepare("UPDATE cut_bundles SET status = 'handed' WHERE cut_order_id = ?").run(c.id);
  return ok(res, view(db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(c.id)));
}));

module.exports = router;
module.exports.ensureCutOrder = ensureCutOrder;
