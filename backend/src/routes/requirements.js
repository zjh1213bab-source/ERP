/**
 * 齐套与缺料看板（对应原型 TS-N06-02）
 * ------------------------------------------------------------
 * 数据流：需求 → 库存分配 → 可靠供应（在途） → 净缺口 → 工序齐套
 *
 * 分配规则（按原型）：
 *   1) 先算每单每料的需求：单件用量 ×(1+损耗%) × 订单件数
 *   2) 同一物料多单争抢：按对客承诺日早的优先分配（没有承诺日按订单 id）
 *   3) 先分库存，再分在途（已订未到），都分完剩下的才是真缺口
 *   4) 缺口按物料汇总 → 直接给采购建议
 *
 * 工序齐套：面料齐才能裁剪（P5），辅料齐才能缝制（B1）；
 * 允许部分齐套，但要能看出「料到了哪一步」。
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'production', 'warehouse', 'sales'];
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 需要备料的订单状态（已成交、还没发完货） */
const ACTIVE_STATUS = ['tech', 'finance', 'assigned', 'production', 'instock'];
const EPS = 0.005;

function orderQty(orderId) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(s.qty),0) AS q FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?'
  ).get(orderId);
  return Number(r.q) || 0;
}

/** 该订单用于备料的开发单：优先有面辅料明细的版本 */
function techPackWithMaterials(orderId) {
  const list = db.prepare(
    "SELECT * FROM tech_packs WHERE order_id = ? ORDER BY (status = 'confirmed') DESC, id DESC"
  ).all(orderId);
  for (const tp of list) {
    const c = db.prepare('SELECT COUNT(*) AS c FROM tech_pack_materials WHERE tech_pack_id = ?').get(tp.id).c;
    if (c > 0) return tp;
  }
  return null;
}

/** 参与齐套的订单（含已评审的草稿单） */
function activeOrders() {
  return db.prepare(
    `SELECT o.id, o.order_no, o.status, o.customer_id, o.delivery_date, o.style_name,
            c.promised_date, c.review_status
     FROM orders o
     LEFT JOIN commitments c ON c.order_id = o.id
     WHERE o.status IN (${ACTIVE_STATUS.map(() => '?').join(',')})
        OR (o.status = 'draft' AND c.review_status = 'approved')
     ORDER BY COALESCE(c.promised_date, o.delivery_date, '9999-12-31'), o.id`
  ).all(...ACTIVE_STATUS);
}

/** 某物料当前可用库存（档案 stock_qty） */
function stockOf(materialId, materialName) {
  if (materialId) {
    const r = db.prepare('SELECT stock_qty FROM materials WHERE id = ?').get(materialId);
    if (r) return Number(r.stock_qty) || 0;
  }
  const r2row = db.prepare("SELECT COALESCE(SUM(stock_qty),0) AS q FROM materials WHERE name = ? AND status = 'active'").get(materialName);
  return Number(r2row.q) || 0;
}

/** 在途采购：未收完的采购明细，按物料名汇总 */
function onorderPool() {
  const rows = db.prepare(
    `SELECT pi.material_id, pi.name, SUM(pi.qty - pi.received_qty) AS qty
     FROM purchase_items pi
     JOIN purchase_orders po ON po.id = pi.po_id
     WHERE pi.qty > pi.received_qty AND po.status NOT IN ('cancelled', 'closed')
     GROUP BY pi.material_id, pi.name`
  ).all();
  const map = new Map();
  rows.forEach((r) => {
    const qty = Number(r.qty) || 0;
    // 同一条在途同时按 id 和名称建索引，档案 id 缺失的老数据也能匹配上
    if (r.material_id) map.set('id:' + r.material_id, (map.get('id:' + r.material_id) || 0) + qty);
    if (r.name) map.set('nm:' + r.name, (map.get('nm:' + r.name) || 0) + qty);
  });
  return map;
}

/**
 * 重算齐套（全量）
 * 先按订单收集需求 → 按物料做分配 → 落库
 */
function calcAll() {
  const orders = activeOrders();
  const poPool = onorderPool();

  // 1. 收集需求行（保持订单优先级顺序）
  const lines = [];
  orders.forEach((o) => {
    const tp = techPackWithMaterials(o.id);
    if (!tp) return;
    const qty = orderQty(o.id);
    if (!qty) return;
    const mats = db.prepare('SELECT * FROM tech_pack_materials WHERE tech_pack_id = ? ORDER BY sort, id').all(tp.id);
    mats.forEach((m) => {
      const oneUse = Number(m.one_use) || 0;
      if (oneUse <= 0) return; // 用量没填的不参与齐套（属于开发单数据缺失）
      const need = r2(oneUse * (1 + (Number(m.loss_rate) || 0) / 100) * qty);
      if (need <= 0) return;
      lines.push({
        order_id: o.id,
        order_no: o.order_no,
        tech_pack_id: tp.id,
        material_id: m.material_id || null,
        material_name: m.material_name || '未命名物料',
        mat_type: m.mat_type === 'accessory' ? 'accessory' : 'fabric',
        colorway: m.colorway || null,
        color_no: m.color_no || null,
        spec_info: m.spec_info || null,
        unit: m.unit || '',
        need,
        unit_price: Number(m.unit_price) || 0,
        promised: o.promised_date || o.delivery_date || null
      });
    });
  });

  // 2. 按物料建池：库存 + 在途
  const pools = new Map();
  lines.forEach((l) => {
    const key = l.material_id ? 'id:' + l.material_id : 'nm:' + l.material_name;
    if (!pools.has(key)) {
      pools.set(key, {
        stock: stockOf(l.material_id, l.material_name),
        po: poPool.get(key) || poPool.get('nm:' + l.material_name) || 0
      });
    }
    l._key = key;
  });

  // 3. 顺序分配：先库存，再在途
  lines.forEach((l) => {
    const p = pools.get(l._key);
    let need = l.need;
    const fromStock = Math.min(need, Math.max(0, p.stock));
    p.stock = r2(p.stock - fromStock);
    need = r2(need - fromStock);
    const fromPo = Math.min(need, Math.max(0, p.po));
    p.po = r2(p.po - fromPo);
    need = r2(need - fromPo);
    l.alloc_stock = r2(fromStock);
    l.alloc_po = r2(fromPo);
    l.gap = r2(Math.max(0, need));
  });

  // 4. 落库（先删后插；保留人工维护的 owner / action / note）
  const keep = new Map();
  db.prepare('SELECT order_id, material_name, owner, action, note FROM material_requirements').all()
    .forEach((r) => keep.set(`${r.order_id}|${r.material_name}`, r));

  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM material_requirements').run();
    const ins = db.prepare(
      `INSERT INTO material_requirements
       (order_id, order_no, tech_pack_id, material_id, material_name, mat_type, colorway, color_no, spec_info, unit,
        need_qty, unit_price, alloc_stock, alloc_po, gap_qty, gap_amount, impact_node, status, owner, action, note, calc_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    lines.forEach((l) => {
      const old = keep.get(`${l.order_id}|${l.material_name}`) || {};
      const status = l.gap <= EPS
        ? (old.action === 'ordered' ? 'ordered' : 'ok')
        : (l.alloc_stock + l.alloc_po) > EPS ? 'partial' : 'short';
      ins.run(
        l.order_id, l.order_no, l.tech_pack_id, l.material_id, l.material_name, l.mat_type,
        l.colorway, l.color_no, l.spec_info, l.unit,
        l.need, l.unit_price, l.alloc_stock, l.alloc_po, l.gap, r2(l.gap * l.unit_price),
        l.mat_type === 'fabric' ? 'P5 裁剪' : 'B1 缝制',
        status, old.owner || null, old.action || 'pending', old.note || null, t, t
      );
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { orders: orders.length, lines: lines.length };
}

/** 订单级齐套判定 */
function orderJudge(orderId) {
  const rows = db.prepare('SELECT * FROM material_requirements WHERE order_id = ?').all(orderId);
  if (!rows.length) return { state: 'no_data', label: '无物料明细', fabShort: 0, accShort: 0 };
  const fabShort = rows.filter((r) => r.mat_type === 'fabric' && r.gap_qty > EPS).length;
  const accShort = rows.filter((r) => r.mat_type === 'accessory' && r.gap_qty > EPS).length;
  if (!fabShort && !accShort) return { state: 'ready', label: '齐套', fabShort, accShort };
  if (fabShort) return { state: 'short', label: '面料缺料，不能裁剪', fabShort, accShort };
  return { state: 'partial', label: '面料齐，辅料缺，可裁不可缝', fabShort, accShort };
}

/* ---------------- 接口 ---------------- */

/** 看板：指标 + 按订单汇总 */
router.get('/board', authRequired, wrap(async (req, res) => {
  const { q, state } = req.query;
  const orders = activeOrders();
  const rows = orders.map((o) => {
    const judge = orderJudge(o.id);
    const lines = db.prepare('SELECT * FROM material_requirements WHERE order_id = ? ORDER BY mat_type, id').all(o.id);
    const gapAmount = r2(lines.reduce((s, l) => s + (Number(l.gap_amount) || 0), 0));
    return {
      order_id: o.id,
      order_no: o.order_no,
      order_status: o.status,
      customer_name: (db.prepare('SELECT name FROM customers WHERE id = ?').get(o.customer_id) || {}).name || null,
      style_name: o.style_name,
      promised_date: o.promised_date || o.delivery_date,
      qty: orderQty(o.id),
      ...judge,
      line_count: lines.length,
      gap_lines: lines.filter((l) => l.gap_qty > EPS).length,
      gap_amount: gapAmount
    };
  });

  let list = rows;
  if (state) list = list.filter((r) => r.state === state);
  if (q) {
    const kw = String(q).toLowerCase();
    list = list.filter((r) =>
      [r.order_no, r.customer_name, r.style_name].some((v) => (v || '').toLowerCase().includes(kw)));
  }

  const stat = {
    orders: rows.length,
    ready: rows.filter((r) => r.state === 'ready').length,
    partial: rows.filter((r) => r.state === 'partial').length,
    short: rows.filter((r) => r.state === 'short').length,
    no_data: rows.filter((r) => r.state === 'no_data').length,
    gap_amount: r2(rows.reduce((s, r) => s + r.gap_amount, 0))
  };
  const lastCalc = db.prepare('SELECT MAX(calc_at) AS t FROM material_requirements').get().t;
  return ok(res, { stat, rows: list, calc_at: lastCalc });
}));

/** 明细行 */
router.get('/lines', authRequired, wrap(async (req, res) => {
  const { order_id, status, mat_type } = req.query;
  const where = [];
  const args = [];
  if (order_id) { where.push('order_id = ?'); args.push(order_id); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (mat_type) { where.push('mat_type = ?'); args.push(mat_type); }
  const rows = db.prepare(
    `SELECT * FROM material_requirements ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY gap_qty > 0 DESC, order_id, mat_type, id LIMIT 800`
  ).all(...args);
  return ok(res, rows);
}));

/** 重算 */
router.post('/calc', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = calcAll();
  return ok(res, { ...r, calc_at: now() });
}));

/** 采购建议：按物料汇总净缺口 */
router.get('/shortage', authRequired, wrap(async (req, res) => {
  const rows = db.prepare(
    `SELECT material_id, material_name, mat_type, unit, MAX(spec_info) AS spec_info,
            SUM(gap_qty) AS gap_qty, MAX(unit_price) AS unit_price,
            COUNT(DISTINCT order_id) AS order_count,
            GROUP_CONCAT(DISTINCT order_no) AS order_nos
     FROM material_requirements WHERE gap_qty > 0.005
     GROUP BY material_name ORDER BY gap_qty DESC`
  ).all().map((r) => ({
    ...r,
    gap_qty: r2(r.gap_qty),
    gap_amount: r2(r.gap_qty * (Number(r.unit_price) || 0)),
    supplier: r.material_id
      ? (db.prepare('SELECT supplier, supplier_info FROM materials WHERE id = ?').get(r.material_id) || {}).supplier
      : null,
    on_order: r.material_id
      ? r2(db.prepare(
        `SELECT COALESCE(SUM(pi.qty - pi.received_qty),0) AS q FROM purchase_items pi
         JOIN purchase_orders po ON po.id = pi.po_id
         WHERE pi.material_id = ? AND pi.qty > pi.received_qty AND po.status NOT IN ('cancelled','closed')`
      ).get(r.material_id).q)
      : 0
  }));
  return ok(res, rows);
}));

/** 标记处理动作 / 负责人 */
router.post('/:id/action', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM material_requirements WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '需求行不存在');
  const b = req.body || {};
  const action = ['pending', 'ordered', 'substituted', 'received'].includes(b.action) ? b.action : row.action;
  const owner = b.owner !== undefined ? b.owner : row.owner;
  const note = b.note !== undefined ? b.note : row.note;
  // 已下采购 / 已到货 时，行状态跟着走（缺口仍在就还是缺）
  let status = row.status;
  if (action === 'received' && row.gap_qty <= EPS) status = 'ok';
  else if (action === 'ordered' && row.gap_qty > EPS) status = 'ordered';
  else if (action === 'pending') status = row.gap_qty <= EPS ? 'ok' : (row.alloc_stock + row.alloc_po) > EPS ? 'partial' : 'short';

  db.prepare('UPDATE material_requirements SET action = ?, owner = ?, note = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(action, owner, note, status, now(), row.id);
  return ok(res, db.prepare('SELECT * FROM material_requirements WHERE id = ?').get(row.id));
}));

/** 一单的齐套详情（含工序可做到哪一步） */
router.get('/order/:orderId', authRequired, wrap(async (req, res) => {
  const orderId = req.params.orderId;
  const lines = db.prepare('SELECT * FROM material_requirements WHERE order_id = ? ORDER BY mat_type, id').all(orderId);
  const judge = orderJudge(orderId);
  const canCut = lines.filter((l) => l.mat_type === 'fabric' && l.gap_qty > EPS).length === 0 && lines.length > 0;
  const canSew = canCut && lines.filter((l) => l.mat_type === 'accessory' && l.gap_qty > EPS).length === 0;
  return ok(res, {
    order_id: Number(orderId),
    ...judge,
    can_cut: canCut,
    can_sew: canSew,
    lines,
    gap_amount: r2(lines.reduce((s, l) => s + (Number(l.gap_amount) || 0), 0))
  });
}));

module.exports = router;
module.exports.calcAll = calcAll;
