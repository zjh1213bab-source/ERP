/**
 * 制造成本与已售毛利（对应原型 TS-N12-03 / TS-N12-15）
 * ------------------------------------------------------------
 * 【COST-01 唯一成本对象】一单一成本对象（cost_objects.order_id 唯一），
 * 所有成本都挂在这个对象下，不按款式平均、不跨单混算。
 *
 * 成本层（cost_entries.layer）：
 *   material  面料   ← 开发单面辅料明细 单件用量 × 单价 × 件数
 *   accessory 辅料   ← 同上（mat_type=accessory）
 *   labor     工缴   ← 打版流程「工艺/工序明细」的 车缝+后整 倍率单价合计 × 件数
 *   overhead  制造费用 ← 核价成本单 overhead_cost
 *   other     其他    ← 核价成本单 other_cost
 *   freight   后补到仓费用（手工）
 *   rework    返工报废（手工）
 *
 * 数据流：
 *   订单核价通过 → 预算成本进 cost_objects.budget_cost
 *   发货 → 自动归集实际成本 + 按发货数量结转已售成本（cost_snapshots）
 *   后补费用 → 追加 manual 成本层 → 重算单件成本 → 补提已售成本差额
 *   毛利 = 已售收入 - 已售成本（核价利润 ≠ 已实现利润）
 *
 * 同一工资源只入成本一次：auto 层每次归集先删后建，且按 layer 分别重建。
 */
const express = require('express');
const { db, now, getSettings } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'finance'];
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const LAYERS = [
  { key: 'material', label: '面料', color: 'purple' },
  { key: 'accessory', label: '辅料', color: 'blue' },
  { key: 'labor', label: '工缴', color: 'orange' },
  { key: 'overhead', label: '制造费用', color: 'gray' },
  { key: 'other', label: '其他', color: 'gray' },
  { key: 'freight', label: '后补到仓费用', color: 'red' },
  { key: 'rework', label: '返工报废', color: 'red' }
];
const LAYER_LABEL = LAYERS.reduce((m, l) => ({ ...m, [l.key]: l.label }), {});

function nextCostNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const row = db.prepare('SELECT cost_no FROM cost_objects WHERE cost_no LIKE ? ORDER BY id DESC LIMIT 1').get(`CB${ymd}%`);
  const seq = row ? Number(String(row.cost_no).slice(-4)) + 1 : 1;
  return genNo('CB', seq);
}

/** 订单总件数：从尺码明细汇总，没明细时按 0 */
function orderQty(orderId) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(s.qty),0) AS q FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?'
  ).get(orderId);
  return Number(r.q) || 0;
}

/** 当前生效开发单：已确认优先，其次最新 */
function currentTechPack(orderId) {
  return db.prepare(
    "SELECT * FROM tech_packs WHERE order_id = ? ORDER BY (status = 'confirmed') DESC, id DESC LIMIT 1"
  ).get(orderId);
}

/**
 * 取有面辅料明细的开发单版本。
 * 实务里经常出现「确认版没填明细、明细在草稿版」的历史数据，
 * 直接按最新版归集会算出 0 成本，所以按版本顺序找第一份有物料的。
 */
function techPackWithMaterials(orderId) {
  const list = db.prepare(
    "SELECT * FROM tech_packs WHERE order_id = ? ORDER BY (status = 'confirmed') DESC, id DESC"
  ).all(orderId);
  for (const tp of list) {
    const c = db.prepare('SELECT COUNT(*) AS c FROM tech_pack_materials WHERE tech_pack_id = ?').get(tp.id).c;
    if (c > 0) return tp;
  }
  return list[0] || null;
}

/** 已发货数量（库存流水口径），没有流水但订单已发货/结案时按全量 */
function shippedQty(order) {
  const r = db.prepare(
    "SELECT COALESCE(SUM(ABS(qty)),0) AS q FROM stock_ledger WHERE ref_type = 'order' AND ref_id = ? AND type IN ('out','ship')"
  ).get(order.id);
  const q = Number(r.q) || 0;
  if (q > 0) return q;
  if (['shipped', 'closed'].includes(order.status)) return orderQty(order.id);
  return 0;
}

/** 创建或取回成本对象（幂等） */
function ensureCostObject(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  let obj = db.prepare('SELECT * FROM cost_objects WHERE order_id = ?').get(orderId);
  const qty = orderQty(orderId);
  const rate = Number(order.rate) || Number(getSettings().exchangeRate) || 1;
  const usd = r2(order.total_usd);
  const revenueCny = r2(usd > 0 ? usd * rate : order.total_amount);
  const cust = order.customer_id
    ? db.prepare('SELECT name FROM customers WHERE id = ?').get(order.customer_id)
    : null;
  const cost = db.prepare("SELECT * FROM cost_sheets WHERE order_id = ? ORDER BY (status='approved') DESC, id DESC LIMIT 1").get(orderId);
  const budget = cost ? r2(cost.total_cost) : 0;
  const t = now();

  if (!obj) {
    const info = db.prepare(
      `INSERT INTO cost_objects (cost_no, order_id, order_no, customer_name, style_no, qty, currency, rate,
        revenue_orig, revenue_cny, budget_cost, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`
    ).run(
      nextCostNo(), orderId, order.order_no, cust ? cust.name : null, order.style_name || null,
      qty, usd > 0 ? 'USD' : 'CNY', rate, usd > 0 ? usd : r2(order.total_amount), revenueCny, budget, t, t
    );
    obj = db.prepare('SELECT * FROM cost_objects WHERE id = ?').get(Number(info.lastInsertRowid));
  } else {
    // 订单数量 / 收入 / 预算可能后续变化，每次进来同步一次
    db.prepare(
      `UPDATE cost_objects SET qty = ?, rate = ?, revenue_orig = ?, revenue_cny = ?, budget_cost = ?,
        currency = ?, style_no = ?, customer_name = ?, updated_at = ? WHERE id = ?`
    ).run(qty, rate, usd > 0 ? usd : r2(order.total_amount), revenueCny, budget,
      usd > 0 ? 'USD' : 'CNY', order.style_name || null, cust ? cust.name : null, t, obj.id);
    obj = db.prepare('SELECT * FROM cost_objects WHERE id = ?').get(obj.id);
  }
  return obj;
}

/**
 * 自动归集：物料 + 工缴 + 核价单的制造费用/其他。
 * 先删 auto 层再重建，保证重复点不翻倍（同一工资源只入一次）。
 */
function collectAuto(obj) {
  const t = now();
  const qty = Number(obj.qty) || 0;
  db.prepare("DELETE FROM cost_entries WHERE cost_object_id = ? AND source = 'auto'").run(obj.id);
  const ins = db.prepare(
    `INSERT INTO cost_entries (cost_object_id, layer, source, ref_type, ref_id, name, qty, unit, unit_price, amount, occurred_at, remark, created_by, created_at)
     VALUES (?,?, 'auto', ?,?,?,?,?,?,?,?,?,?,?)`
  );
  let count = 0;

  // ---- 1. 面辅料：单件用量 × 单价 × 订单件数 ----
  const tp = techPackWithMaterials(obj.order_id);
  if (tp && qty > 0) {
    const mats = db.prepare('SELECT * FROM tech_pack_materials WHERE tech_pack_id = ? ORDER BY sort, id').all(tp.id);
    mats.forEach((m) => {
      const oneUse = Number(m.one_use) || 0;
      const price = Number(m.unit_price) || 0;
      if (oneUse <= 0 || price <= 0) return;
      const useQty = r2(oneUse * (1 + (Number(m.loss_rate) || 0) / 100) * qty); // 含损耗
      const amount = r2(useQty * price);
      ins.run(
        obj.id, m.mat_type === 'accessory' ? 'accessory' : 'material', 'tech_pack_material', m.id,
        m.material_name || '未命名物料', useQty, m.unit || '', price, amount, t,
        `${m.colorway || '-'} ${m.color_no || ''}`.trim() + (m.loss_rate ? ` · 损耗${m.loss_rate}%` : ''),
        'system', t
      );
      count++;
    });
  }

  // ---- 2. 工缴：打版流程「工艺/工序明细」的倍率单价合计 ----
  const flow = tp ? db.prepare('SELECT * FROM pattern_flows WHERE tech_pack_id = ?').get(tp.id) : null;
  if (flow && qty > 0) {
    const stage = db.prepare("SELECT * FROM pattern_stages WHERE flow_id = ? AND stage = 'craft'").get(flow.id);
    let data = {};
    try { data = stage && stage.data ? JSON.parse(stage.data) : {}; } catch (e) { data = {}; }
    const rows = [...(data.sewing || []), ...(data.finish || [])];
    const unitLabor = r2(rows.reduce((s, x) => s + (Number(x.price) || 0) * (Number(x.ratio) || 0), 0));
    if (unitLabor > 0) {
      ins.run(
        obj.id, 'labor', 'craft', stage ? stage.id : null,
        `工缴（${rows.length} 道工序）`, qty, '件', unitLabor, r2(unitLabor * qty), t,
        `单件 ¥${unitLabor} × ${qty} 件`, 'system', t
      );
      count++;
    }
  }

  // ---- 3. 核价成本单的制造费用与其他 ----
  const cs = db.prepare("SELECT * FROM cost_sheets WHERE order_id = ? ORDER BY (status='approved') DESC, id DESC LIMIT 1").get(obj.order_id);
  if (cs) {
    if (Number(cs.overhead_cost) > 0) {
      ins.run(obj.id, 'overhead', 'cost_sheet', cs.id, '制造费用分摊', 1, '批', r2(cs.overhead_cost), r2(cs.overhead_cost), t, '来自核价成本单', 'system', t);
      count++;
    }
    if (Number(cs.other_cost) > 0) {
      ins.run(obj.id, 'other', 'cost_sheet', cs.id, '其他费用', 1, '批', r2(cs.other_cost), r2(cs.other_cost), t, '来自核价成本单', 'system', t);
      count++;
    }
  }

  recalc(obj.id);
  return { count };
}

/** 汇总实际成本 */
function recalc(objId) {
  const sum = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM cost_entries WHERE cost_object_id = ?').get(objId).s;
  db.prepare('UPDATE cost_objects SET actual_cost = ?, updated_at = ? WHERE id = ?').run(r2(sum), now(), objId);
  return r2(sum);
}

/**
 * 已售结转：按已发货数量比例把实际成本与收入结转到「已售」。
 * 后补费用会让单件成本变化，再次调用即可补提差额（快照留历史）。
 */
function syncSold(objId, userId) {
  const obj = db.prepare('SELECT * FROM cost_objects WHERE id = ?').get(objId);
  if (!obj) return null;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(obj.order_id);
  const totalQty = Number(obj.qty) || 0;
  const shipped = order ? shippedQty(order) : 0;
  const doneQty = Math.min(totalQty || shipped, shipped);

  const unitCost = totalQty > 0 ? r2(obj.actual_cost / totalQty) : 0;
  const soldCost = totalQty > 0 ? r2(unitCost * doneQty) : 0;
  const soldRevenue = totalQty > 0 ? r2((obj.revenue_cny / totalQty) * doneQty) : 0;
  const gp = r2(soldRevenue - soldCost);

  const seqRow = db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM cost_snapshots WHERE cost_object_id = ?').get(objId);
  const seq = (Number(seqRow.s) || 0) + 1;
  db.prepare(
    `INSERT INTO cost_snapshots (cost_object_id, seq, qty, total_qty, unit_cost, sold_cost, sold_revenue, gross_profit, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(objId, seq, doneQty, totalQty, unitCost, soldCost, soldRevenue, gp,
    `按发货 ${doneQty}/${totalQty} 件结转`, userId || 'system', now());

  db.prepare('UPDATE cost_objects SET sold_qty = ?, sold_cost = ?, sold_revenue = ?, updated_at = ? WHERE id = ?')
    .run(doneQty, soldCost, soldRevenue, now(), objId);

  return { seq, doneQty, totalQty, unitCost, soldCost, soldRevenue, grossProfit: gp };
}

/** 成本对象 + 明细视图 */
function viewObject(obj) {
  const entries = db.prepare('SELECT * FROM cost_entries WHERE cost_object_id = ? ORDER BY layer, id').all(obj.id);
  const byLayer = LAYERS.map((l) => {
    const rows = entries.filter((e) => e.layer === l.key);
    return { ...l, amount: r2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)), count: rows.length };
  }).filter((l) => l.count > 0);

  const totalQty = Number(obj.qty) || 0;
  const unitCost = totalQty > 0 ? r2(obj.actual_cost / totalQty) : 0;
  const unsoldCost = r2(obj.actual_cost - obj.sold_cost);
  const grossProfit = r2(obj.sold_revenue - obj.sold_cost);
  const margin = obj.sold_revenue > 0 ? r2((grossProfit / obj.sold_revenue) * 100) : 0;
  const budgetGap = r2(obj.actual_cost - obj.budget_cost);
  const snapshots = db.prepare('SELECT * FROM cost_snapshots WHERE cost_object_id = ? ORDER BY seq DESC').all(obj.id);

  return {
    ...obj,
    unit_cost: unitCost,
    unsold_cost: unsoldCost,
    gross_profit: grossProfit,
    margin,
    budget_gap: budgetGap,
    entries,
    by_layer: byLayer,
    snapshots
  };
}

/* ---------------- 接口 ---------------- */

router.get('/layers', authRequired, wrap(async (req, res) => ok(res, LAYERS)));

/** 总览：全公司成本与毛利口径 */
router.get('/overview', authRequired, wrap(async (req, res) => {
  const objs = db.prepare('SELECT * FROM cost_objects').all();
  const sum = (k) => r2(objs.reduce((s, o) => s + (Number(o[k]) || 0), 0));
  const revenue = sum('revenue_cny');
  const actual = sum('actual_cost');
  const soldRevenue = sum('sold_revenue');
  const soldCost = sum('sold_cost');
  const gross = r2(soldRevenue - soldCost);
  return ok(res, {
    orders: objs.length,
    revenue,
    actual_cost: actual,
    budget_cost: sum('budget_cost'),
    sold_revenue: soldRevenue,
    sold_cost: soldCost,
    gross_profit: gross,
    margin: soldRevenue > 0 ? r2((gross / soldRevenue) * 100) : 0,
    unsold_cost: r2(actual - soldCost),
    budget_gap: r2(actual - sum('budget_cost')),
    loss_orders: objs.filter((o) => o.sold_revenue > 0 && o.sold_revenue - o.sold_cost < 0).length
  });
}));

/** 订单成本列表 */
router.get('/orders', authRequired, wrap(async (req, res) => {
  const { q, status } = req.query;
  const where = [];
  const args = [];
  if (q) { where.push('(order_no LIKE ? OR customer_name LIKE ? OR style_no LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status === 'loss') where.push('sold_revenue > 0 AND sold_revenue < sold_cost');
  const rows = db.prepare(
    `SELECT * FROM cost_objects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`
  ).all(...args).map((o) => {
    const totalQty = Number(o.qty) || 0;
    const gp = r2(o.sold_revenue - o.sold_cost);
    return {
      ...o,
      unit_cost: totalQty > 0 ? r2(o.actual_cost / totalQty) : 0,
      gross_profit: gp,
      margin: o.sold_revenue > 0 ? r2((gp / o.sold_revenue) * 100) : 0,
      unsold_cost: r2(o.actual_cost - o.sold_cost),
      budget_gap: r2(o.actual_cost - o.budget_cost)
    };
  });
  return ok(res, rows);
}));

/** 单订单成本详情（进来就确保对象存在） */
router.get('/orders/:orderId', authRequired, wrap(async (req, res) => {
  const obj = ensureCostObject(req.params.orderId);
  if (!obj) return fail(res, 404, '订单不存在');
  return ok(res, viewObject(obj));
}));

/** 手动触发归集 */
router.post('/orders/:orderId/collect', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const obj = ensureCostObject(req.params.orderId);
  if (!obj) return fail(res, 404, '订单不存在');
  const r = collectAuto(obj);
  const view = viewObject(db.prepare('SELECT * FROM cost_objects WHERE id = ?').get(obj.id));
  return ok(res, { ...view, collected: r.count });
}));

/** 手动触发已售结转 */
router.post('/orders/:orderId/snapshot', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const obj = ensureCostObject(req.params.orderId);
  if (!obj) return fail(res, 404, '订单不存在');
  const snap = syncSold(obj.id, req.user.username);
  return ok(res, { ...snap, object: viewObject(db.prepare('SELECT * FROM cost_objects WHERE id = ?').get(obj.id)) });
}));

/** 追加手工成本（后补运费、返工报废等） */
router.post('/entries', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const orderId = b.order_id || (b.cost_object_id
    ? (db.prepare('SELECT order_id FROM cost_objects WHERE id = ?').get(b.cost_object_id) || {}).order_id
    : null);
  if (!orderId) return fail(res, 400, '缺少 order_id');
  const obj = ensureCostObject(orderId);
  if (!obj) return fail(res, 404, '订单不存在');

  const layer = b.layer;
  if (!LAYER_LABEL[layer]) return fail(res, 400, '成本层不合法');
  if (layer === 'material' || layer === 'accessory' || layer === 'labor') {
    return fail(res, 400, '面料 / 辅料 / 工缴 由系统自动归集，如需调整请改开发单或工序后重新归集');
  }
  const amount = r2(b.amount);
  if (!(amount > 0)) return fail(res, 400, '金额必须大于 0');

  const t = now();
  const info = db.prepare(
    `INSERT INTO cost_entries (cost_object_id, layer, source, ref_type, ref_id, name, qty, unit, unit_price, amount, occurred_at, remark, created_by, created_at)
     VALUES (?,?,'manual','manual',NULL,?,?,?,?,?,?,?,?,?)`
  ).run(
    obj.id, layer, b.name || LAYER_LABEL[layer], Number(b.qty) || 0, b.unit || '',
    Number(b.unit_price) || amount, amount, b.occurred_at || t.slice(0, 10), b.remark || null,
    req.user.username, t
  );
  recalc(obj.id);
  // 已经发过货的单子，后补费用要同步补提已售成本
  syncSold(obj.id, req.user.username);
  const view = viewObject(db.prepare('SELECT * FROM cost_objects WHERE id = ?').get(obj.id));
  return ok(res, { ...view, entryId: Number(info.lastInsertRowid) });
}));

/** 删除手工成本项 */
router.delete('/entries/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const e = db.prepare('SELECT * FROM cost_entries WHERE id = ?').get(req.params.id);
  if (!e) return fail(res, 404, '成本项不存在');
  if (e.source !== 'manual') return fail(res, 400, '自动归集的成本项不能删，请调整来源数据后重新归集');
  db.prepare('DELETE FROM cost_entries WHERE id = ?').run(e.id);
  recalc(e.cost_object_id);
  syncSold(e.cost_object_id, req.user.username);
  return ok(res, viewObject(db.prepare('SELECT * FROM cost_objects WHERE id = ?').get(e.cost_object_id)));
}));

module.exports = router;
module.exports.ensureCostObject = ensureCostObject;
module.exports.recalc = recalc;
module.exports.collectAuto = collectAuto;
module.exports.syncSold = syncSold;
