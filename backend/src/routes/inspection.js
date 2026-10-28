/**
 * 验货报告
 *
 * GET    /api/inspection/preview/:orderId   实时预览（不落库，页面首次打开用）
 * POST   /api/inspection                    生成报告快照 { order_id, note }
 * GET    /api/inspection/:idOrNo            读报告（id 或报告号）
 * GET    /api/inspection?order_id=          某订单的报告历史（不含快照）
 * GET    /api/inspection/recent             最近生成
 *
 * 为什么预览和生成分开：
 *   客户看的必须是「某一次生成的」文件。先预览是为了让人确认数据对不对
 *   （照片是不是全、验货结论是不是最新那张），确认后再生成带编号的快照。
 */
const express = require('express');
const I = require('../services/inspection');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

// 出报告是对外动作：销售（给客户）、生产/技术（验货过程）、财务（结算前确认）都要能用
const WRITE = ['admin', 'sales', 'production', 'tech', 'finance'];

router.get(
  '/preview/:orderId',
  authRequired,
  wrap(async (req, res) => ok(res, I.buildSnapshot(req.params.orderId)))
);

router.get(
  '/recent',
  authRequired,
  wrap(async (req, res) => ok(res, I.recent(req.query.limit)))
);

router.get(
  '/',
  authRequired,
  wrap(async (req, res) => {
    if (req.query.order_id) return ok(res, I.listByOrder(req.query.order_id));
    return ok(res, I.recent(req.query.limit));
  })
);

router.post(
  '/',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const b = req.body || {};
    return ok(res, I.create(b.order_id, req.user.username, b.note));
  })
);

router.get(
  '/:idOrNo',
  authRequired,
  wrap(async (req, res) => ok(res, I.get(req.params.idOrNo)))
);

module.exports = router;
