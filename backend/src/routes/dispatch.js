/**
 * 订单分单（本厂 / 外协）
 * GET    /api/dispatch?order_id=
 * POST   /api/dispatch  { order_id, factory_id, type, qty, price, remark }
 * DELETE /api/dispatch/:id
 *
 * 规则：财务审核通过(成本单 approved)后才能分单；
 *       分单可分次录入，只有有效分配数量覆盖整张订单后才从 finance 推进到 assigned。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const assignSvc = require('../services/orderAssign');

const router = express.Router();
const WRITE = ['admin', 'sales', 'production'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { order_id, factory_id, status } = req.query;
  const where = [];
  const params = [];
  if (order_id) { where.push('d.order_id = ?'); params.push(order_id); }
  if (factory_id) { where.push('d.factory_id = ?'); params.push(factory_id); }
  if (status) { where.push('d.status = ?'); params.push(status); }
  const sql = `SELECT d.*, o.order_no, o.style_name FROM dispatch_orders d
    LEFT JOIN orders o ON o.id = d.order_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY d.id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

// 外协对账汇总（按外协厂）
router.get('/recon', authRequired, wrap(async (req, res) => {
  const rows = db.prepare(
    `SELECT factory_id, factory_name, COUNT(*) cnt,
       COALESCE(SUM(qty),0) qty,
       COALESCE(SUM(qty * price),0) amount,
       COALESCE(SUM(CASE WHEN status != 'settled' THEN qty * price ELSE 0 END),0) unsettled
     FROM dispatch_orders WHERE type = 'outsource'
     GROUP BY factory_id, factory_name ORDER BY amount DESC`
  ).all();
  return ok(res, rows);
}));

// 结算
router.post('/:id/settle', authRequired, requireRole(['admin', 'finance']), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM dispatch_orders WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '分单记录不存在');
  const status = (req.body && req.body.settled === false) ? 'dispatched' : 'settled';
  db.prepare('UPDATE dispatch_orders SET status = ? WHERE id = ?').run(status, req.params.id);
  return ok(res, db.prepare('SELECT * FROM dispatch_orders WHERE id = ?').get(req.params.id));
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  // 校验与写入都在 services/orderAssign.addDispatch()：看板「待分配订单」里点
  // 「分配本厂 / 整单外发」走的是同一个函数。各写一遍的失败方式很具体 ——
  // 面板能分超量、分单页拦住；面板不看财务审核，于是没审核的单已经在车间做了。
  const out = assignSvc.addDispatch({
    orderId: b.order_id,
    factory_id: b.factory_id || null,
    factory_name: b.factory_name || '',
    type: b.type || '',
    qty: b.qty,
    price: b.price,
    remark: b.remark || ''
  }, (req.user && req.user.username) || 'system');
  return ok(res, { id: out.id, dispatches: out.dispatches });
}));


router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM dispatch_orders WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '分单记录不存在');
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(row.order_id);
  if (!order || !['finance', 'assigned'].includes(order.status)) return fail(res, 400, '订单已进入生产或后续环节，不能删除分单记录');
  db.prepare('DELETE FROM dispatch_orders WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
