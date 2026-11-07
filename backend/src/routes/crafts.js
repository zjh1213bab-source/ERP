/**
 * 订单工艺明细（order_crafts）—— 对齐衣创 craft_data
 * GET    /api/crafts?order_id=
 * POST   /api/crafts
 * PUT    /api/crafts/:id
 * DELETE /api/crafts/:id
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'tech'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return fail(res, 400, '缺少 order_id');
  return ok(res, db.prepare('SELECT * FROM order_crafts WHERE order_id = ? ORDER BY id').all(order_id));
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.order_id) return fail(res, 400, '缺少 order_id');
  if (!b.name) return fail(res, 400, '工艺名称必填');
  if (!db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(b.order_id)) return fail(res, 404, '订单不存在');
  const info = db.prepare(
    `INSERT INTO order_crafts (order_id, name, qty, price, rate, fob_price, is_out, is_wash, is_cut, instruction, remark, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.order_id, b.name, Number(b.qty) || 0, Number(b.price) || 0, Number(b.rate) || 0,
    Number(b.fob_price) || 0, 0, b.is_wash ? 1 : 0, b.is_cut ? 1 : 0,
    b.instruction || null, b.remark || null, now()
  );
  return ok(res, db.prepare('SELECT * FROM order_crafts WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM order_crafts WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工艺不存在');
  const b = req.body || {};
  db.prepare(
    'UPDATE order_crafts SET name=?, qty=?, price=?, rate=?, fob_price=?, is_out=?, is_wash=?, is_cut=?, instruction=?, remark=? WHERE id=?'
  ).run(
    b.name || row.name, b.qty ?? row.qty, b.price ?? row.price, b.rate ?? row.rate, b.fob_price ?? row.fob_price,
    row.is_out,
    b.is_wash === undefined ? row.is_wash : b.is_wash ? 1 : 0,
    b.is_cut === undefined ? row.is_cut : b.is_cut ? 1 : 0,
    b.instruction ?? row.instruction, b.remark ?? row.remark, req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM order_crafts WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM order_crafts WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工艺不存在');
  db.prepare('DELETE FROM order_crafts WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
