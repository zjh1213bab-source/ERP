/**
 * 订单分单（本厂 / 外协）
 * GET    /api/dispatch?order_id=
 * POST   /api/dispatch  { order_id, factory_id, type, qty, price, remark }
 * DELETE /api/dispatch/:id
 *
 * 规则：财务审核通过(成本单 approved)后才能分单；
 *       首次分单会把订单从 finance 推进到 assigned，之后可继续拆分（多次分单）。
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'sales', 'production'];

function totalQty(orderId) {
  return Number(db.prepare('SELECT COALESCE(SUM(qty),0) AS s FROM order_items WHERE order_id = ?').get(orderId).s) || 0;
}

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
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(b.order_id);
  if (!order) return fail(res, 404, '订单不存在');
  if (!['finance', 'assigned'].includes(order.status)) {
    return fail(res, 400, `订单当前为「${order.status}」，只有财务审核/已分单状态可分单`);
  }
  const cost = db.prepare("SELECT 1 AS x FROM cost_sheets WHERE order_id = ? AND status = 'approved' LIMIT 1").get(b.order_id);
  if (!cost) return fail(res, 400, '财务尚未审核通过，不能分单');

  const factory = b.factory_id ? db.prepare('SELECT * FROM factories WHERE id = ?').get(b.factory_id) : null;
  if (b.factory_id && !factory) return fail(res, 400, '工厂不存在');
  const type = b.type === 'outsource' || (factory && factory.type === 'outsource') ? 'outsource' : 'own';
  const qty = b.qty !== undefined && b.qty !== null && b.qty !== '' ? Number(b.qty) : totalQty(b.order_id);
  if (!(qty > 0)) return fail(res, 400, '分单数量必须大于 0');

  const t = now();
  let dispatchId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      'INSERT INTO dispatch_orders (order_id, factory_id, factory_name, type, qty, price, status, remark, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(b.order_id, b.factory_id || null, factory ? factory.name : (b.factory_name || '未指定'), type, qty, Number(b.price) || 0, 'dispatched', b.remark || null, t);
    dispatchId = Number(info.lastInsertRowid);

    if (order.status === 'finance') {
      db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run('assigned', t, b.order_id);
      db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
        .run(b.order_id, 'finance', 'assigned', req.user.username, `分单：${factory ? factory.name : '未指定'}（${type === 'own' ? '本厂' : '外协'}）× ${qty}`, t);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, {
    id: dispatchId,
    dispatches: db.prepare('SELECT * FROM dispatch_orders WHERE order_id = ? ORDER BY id').all(b.order_id)
  });
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM dispatch_orders WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '分单记录不存在');
  db.prepare('DELETE FROM dispatch_orders WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
