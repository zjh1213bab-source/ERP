/**
 * 审批中心：聚合待办
 * GET /api/approvals/pending -> { techpacks, costs, orders }
 *   techpacks: 待技术确认（status=draft）
 *   costs:     待财务审核（status=pending）
 *   orders:    待分单（status=finance，且成本已通过）
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');
const { myTasks, actTask } = require('../services/approvals');

const router = express.Router();

router.get('/pending', authRequired, wrap(async (req, res) => {
  const techpacks = db.prepare(
    `SELECT tp.id, tp.order_id, tp.product_name, tp.version, tp.stage, tp.status, tp.updated_at,
            o.order_no, o.style_name, c.name AS customer_name
     FROM tech_packs tp
     LEFT JOIN orders o ON o.id = tp.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE tp.status = 'draft'
     ORDER BY tp.id DESC`
  ).all();

  const costs = db.prepare(
    `SELECT cs.order_id, cs.total_cost, cs.factory_price, cs.profit_rate, cs.updated_at,
            o.order_no, o.style_name, c.name AS customer_name
     FROM cost_sheets cs
     LEFT JOIN orders o ON o.id = cs.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE cs.status = 'pending'
     ORDER BY cs.order_id DESC`
  ).all();

  const orders = db.prepare(
    `SELECT o.id, o.order_no, o.style_name, o.delivery_date, o.total_usd, o.total_amount,
            c.name AS customer_name
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'finance'
       AND EXISTS (SELECT 1 FROM cost_sheets cs WHERE cs.order_id = o.id AND cs.status = 'approved')
     ORDER BY o.id DESC`
  ).all();

  return ok(res, { techpacks, costs, orders });
}));

// 待我审批（多级审批任务）
router.get('/my-tasks', authRequired, wrap(async (req, res) => {
  return ok(res, myTasks(req.user));
}));

router.post('/tasks/:id/act', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  try {
    const r = actTask(req.params.id, !!b.approve, b.remark, req.user);
    return ok(res, r);
  } catch (e) {
    // 一律 400 会把「不是你的单，不许自己批」这类权限拒绝也报成 400，
    // 前端和审计都分不清「参数错」和「没权限」
    return fail(res, e.status || 400, e.message);
  }
}));

module.exports = router;
