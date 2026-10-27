/**
 * 面辅料用量明细（order_materials）—— 对齐衣创 material_data
 * 按订单总件数自动计算：总用量 = 单件用量 × 总件数 × (1 + 损耗%)；金额 = 总用量 × 单价
 * GET    /api/order-materials?order_id=
 * POST   /api/order-materials
 * PUT    /api/order-materials/:id
 * DELETE /api/order-materials/:id
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'tech', 'finance'];

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function orderQty(orderId) {
  return Number(db.prepare('SELECT COALESCE(SUM(qty),0) AS s FROM order_items WHERE order_id = ?').get(orderId).s) || 0;
}
function calc(qty, oneUse, loss, price) {
  const totalUse = round2((Number(oneUse) || 0) * qty * (1 + (Number(loss) || 0) / 100));
  const amount = round2(totalUse * (Number(price) || 0));
  return { totalUse, amount };
}

router.get('/', authRequired, wrap(async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return fail(res, 400, '缺少 order_id');
  return ok(res, db.prepare('SELECT * FROM order_materials WHERE order_id = ? ORDER BY type, id').all(order_id));
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.order_id) return fail(res, 400, '缺少 order_id');
  if (!b.name) return fail(res, 400, '料名必填');
  if (!db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(b.order_id)) return fail(res, 404, '订单不存在');

  const type = b.type === 'accessory' ? 'accessory' : 'fabric';
  const qty = orderQty(b.order_id);
  const { totalUse, amount } = calc(qty, b.one_use, b.loss, b.price);

  const info = db.prepare(
    `INSERT INTO order_materials (order_id, material_id, type, name, unit, one_use, loss, total_use, price, amount, spec, ingredient, supplier, mat_color, remark, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.order_id, b.material_id || null, type, b.name, b.unit || '', Number(b.one_use) || 0, Number(b.loss) || 0,
    totalUse, Number(b.price) || 0, amount, b.spec || null, b.ingredient || null, b.supplier || null,
    b.mat_color || null, b.remark || null, now()
  );
  return ok(res, db.prepare('SELECT * FROM order_materials WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM order_materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  const b = req.body || {};
  const type = (b.type || row.type) === 'accessory' ? 'accessory' : 'fabric';
  const oneUse = b.one_use !== undefined ? b.one_use : row.one_use;
  const loss = b.loss !== undefined ? b.loss : row.loss;
  const price = b.price !== undefined ? b.price : row.price;
  const { totalUse, amount } = calc(orderQty(row.order_id), oneUse, loss, price);

  db.prepare(
    `UPDATE order_materials SET material_id=?, type=?, name=?, unit=?, one_use=?, loss=?, total_use=?, price=?, amount=?, spec=?, ingredient=?, supplier=?, mat_color=?, remark=? WHERE id=?`
  ).run(
    b.material_id ?? row.material_id, type, b.name || row.name, b.unit ?? row.unit, oneUse, loss, totalUse, price, amount,
    b.spec ?? row.spec, b.ingredient ?? row.ingredient, b.supplier ?? row.supplier, b.mat_color ?? row.mat_color, b.remark ?? row.remark,
    req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM order_materials WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM order_materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  db.prepare('DELETE FROM order_materials WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
