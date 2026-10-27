/**
 * 成本与财务审核（cost_sheets）—— P2
 * GET  /api/costs/:orderId              取该订单成本单
 * POST /api/costs/:orderId              新建/更新成本单（自动算出厂价）
 * POST /api/costs/:orderId/review       财务审核 { approve, opinion }
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { ensureCostInstance, actTask } = require('../services/approvals');

const router = express.Router();
const WRITE = ['admin', 'finance', 'sales'];
const REVIEW = ['admin', 'finance'];

function num(v) {
  return Number(v) || 0;
}
function round2(v) {
  return Math.round(num(v) * 100) / 100;
}

router.get(
  '/:orderId',
  authRequired,
  wrap(async (req, res) => {
    const row = db.prepare('SELECT * FROM cost_sheets WHERE order_id = ?').get(req.params.orderId);
    return ok(res, row || null);
  })
);

router.post(
  '/:orderId',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const orderId = req.params.orderId;
    const order = db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(orderId);
    if (!order) return fail(res, 404, '订单不存在');

    const b = req.body || {};
    const total =
      num(b.material_cost) + num(b.accessory_cost) + num(b.labor_cost) + num(b.overhead_cost) + num(b.other_cost);
    const rate = num(b.profit_rate);
    const factoryPrice = round2(total * (1 + rate / 100));
    const t = now();

    const existing = db.prepare('SELECT id, status FROM cost_sheets WHERE order_id = ?').get(orderId);
    if (existing && existing.status === 'approved') {
      return fail(res, 400, '已通过审核的成本单不可修改');
    }

    if (existing) {
      db.prepare(
        `UPDATE cost_sheets SET material_cost=?, accessory_cost=?, labor_cost=?, overhead_cost=?, other_cost=?,
         total_cost=?, profit_rate=?, factory_price=?, status='pending', reviewed_by=NULL, reviewed_at=NULL, review_opinion=NULL, updated_at=?
         WHERE order_id=?`
      ).run(
        num(b.material_cost), num(b.accessory_cost), num(b.labor_cost), num(b.overhead_cost), num(b.other_cost),
        round2(total), rate, factoryPrice, t, orderId
      );
    } else {
      db.prepare(
        `INSERT INTO cost_sheets (order_id, material_cost, accessory_cost, labor_cost, overhead_cost, other_cost, total_cost, profit_rate, factory_price, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`
      ).run(
        orderId, num(b.material_cost), num(b.accessory_cost), num(b.labor_cost), num(b.overhead_cost), num(b.other_cost),
        round2(total), rate, factoryPrice, t, t
      );
    }
    ensureCostInstance(orderId, round2(total));
    return ok(res, db.prepare('SELECT * FROM cost_sheets WHERE order_id = ?').get(orderId));
  })
);

router.post(
  '/:orderId/review',
  authRequired,
  requireRole(REVIEW),
  wrap(async (req, res) => {
    const orderId = req.params.orderId;
    const row = db.prepare('SELECT * FROM cost_sheets WHERE order_id = ?').get(orderId);
    if (!row) return fail(res, 404, '成本单不存在，请先录入成本');
    const b = req.body || {};

    // 多级审批：若存在未完成实例，按当前级处理
    const inst = db.prepare(
      "SELECT * FROM approval_instances WHERE target_type='cost' AND target_id=? AND status='pending' ORDER BY id DESC LIMIT 1"
    ).get(orderId);
    if (inst) {
      const task = db.prepare('SELECT * FROM approval_tasks WHERE instance_id=? AND step_no=?').get(inst.id, inst.current_step);
      if (!task) return fail(res, 400, '审批任务异常');
      try {
        actTask(task.id, !!b.approve, b.opinion, req.user);
      } catch (e) {
        return fail(res, 400, e.message);
      }
      return ok(res, db.prepare('SELECT * FROM cost_sheets WHERE order_id = ?').get(orderId));
    }

    // 兼容旧数据：无审批实例时按单级处理
    const status = b.approve ? 'approved' : 'rejected';
    const t = now();
    db.prepare(
      'UPDATE cost_sheets SET status=?, reviewed_by=?, reviewed_at=?, review_opinion=?, updated_at=? WHERE order_id=?'
    ).run(status, req.user.username, t, b.opinion || null, t, orderId);
    return ok(res, db.prepare('SELECT * FROM cost_sheets WHERE order_id = ?').get(orderId));
  })
);

module.exports = router;
