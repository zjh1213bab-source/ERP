/**
 * 客户进度发布（内部侧，TS-N22-02 / TS-N22-03）
 * ----------------------------------------------------------------------------
 * GET  /api/customer-progress/meta                  字典（路线 / 阶段 / 统计）
 * GET  /api/customer-progress/orders?q=             待发布订单列表（含内部进度与发布状态）
 * GET  /api/customer-progress/orders/:id/internal   内部真实进度（不外发）
 * GET  /api/customer-progress/orders/:id/preview    客户将会看到什么（含被隐藏的字段）
 * POST /api/customer-progress/orders/:id/publish    发布（自动撤回旧版，版本号 +1）
 * POST /api/customer-progress/publications/:id/withdraw  撤回（必须写原因）
 * GET  /api/customer-progress/orders/:id/history    版本历史
 * PUT  /api/customer-progress/orders/:id/route      指定生产路线（本厂 / 裁片外发 / 整单外发）
 *
 * 客户侧只读快照在 /api/mall/progress 与 /api/mall/orders/:id/progress。
 */
const express = require('express');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const P = require('../services/customerProgress');

const router = express.Router();

// 看：销售/技术/生产/老板都能看客户会看到什么
const READ = ['admin', 'boss', 'sales', 'tech', 'production'];
// 发布：对外说话的是业务，只给销售与管理员
const PUBLISH = ['admin', 'sales'];
// 改路线：跟单与生产最清楚这单到底在哪做
const ROUTE = ['admin', 'sales', 'production'];

const actor = (req) => req.user?.name || req.user?.username || '';

router.get('/meta', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, P.dict())));

router.get('/orders', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, P.listOrders(req.query))));

router.get('/orders/:id/internal', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, P.internal(req.params.id))));

router.get('/orders/:id/preview', authRequired, requireRole(READ), wrap(async (req, res) =>
  ok(res, P.preview(req.params.id, { show_qty: String(req.query.show_qty) === '1' }))));

router.get('/orders/:id/history', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, P.history(req.params.id))));

router.post('/orders/:id/publish', authRequired, requireRole(PUBLISH), wrap(async (req, res) =>
  ok(res, P.publish(req.params.id, req.body || {}, actor(req)))));

router.post('/publications/:id/withdraw', authRequired, requireRole(PUBLISH), wrap(async (req, res) => {
  const row = P.withdraw(req.params.id, req.body || {}, actor(req));
  return ok(res, row);
}));

router.put('/orders/:id/route', authRequired, requireRole(ROUTE), wrap(async (req, res) =>
  ok(res, P.setRoute(req.params.id, req.body || {}, actor(req)))));

module.exports = router;
