/**
 * 生产工序节点（order_nodes）—— 对齐衣创 node_list
 * GET   /api/order-nodes?order_id=
 * POST  /api/order-nodes/init { order_id }     初始化默认 13 道工序
 * PATCH /api/order-nodes/:id { status, plan_date, actual_date, operator, remark }
 * DELETE /api/order-nodes/:id
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { ensureNodes } = require('../services/production');

const router = express.Router();
const WRITE = ['admin', 'production', 'sales'];
const STATUS = ['pending', 'doing', 'done'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return fail(res, 400, '缺少 order_id');
  return ok(res, db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(order_id));
}));

router.post('/init', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const { order_id } = req.body || {};
  if (!order_id) return fail(res, 400, '缺少 order_id');
  if (!db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(order_id)) return fail(res, 404, '订单不存在');
  ensureNodes(order_id);
  return ok(res, db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(order_id));
}));

router.patch('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM order_nodes WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工序不存在');
  const b = req.body || {};
  const status = b.status !== undefined ? b.status : row.status;
  if (!STATUS.includes(status)) return fail(res, 400, '非法状态');

  let actual = b.actual_date !== undefined ? b.actual_date : row.actual_date;
  if (status === 'done' && !actual) actual = new Date().toISOString().slice(0, 10);

  db.prepare(
    'UPDATE order_nodes SET status=?, plan_date=?, actual_date=?, operator=?, remark=? WHERE id=?'
  ).run(
    status,
    b.plan_date ?? row.plan_date,
    actual,
    b.operator ?? row.operator,
    b.remark ?? row.remark,
    req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM order_nodes WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM order_nodes WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工序不存在');
  db.prepare('DELETE FROM order_nodes WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
