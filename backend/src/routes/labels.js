/**
 * 扎标与扫码解析
 *
 * GET /api/labels/bundles/:orderId   某订单的全部扎（打印扎标用）
 * GET /api/labels/resolve?code=      把扫到的码还原成订单 / 订单+扎
 *
 * 读接口对全体业务岗开放：车间、仓库、销售都要扫码，卡权限没意义。
 */
const express = require('express');
const L = require('../services/labels');
const BP = require('../services/bundleProgress');
const { ok, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// 扎级完工进度（读接口，车间/生产/销售都要看，不卡权限）
router.get(
  '/progress',
  authRequired,
  wrap(async (req, res) => ok(res, BP.ordersWithBundles(req.query.limit)))
);

router.get(
  '/progress/:orderId',
  authRequired,
  wrap(async (req, res) => ok(res, BP.progressOf(req.params.orderId)))
);

router.get(
  '/bundles/:orderId',
  authRequired,
  wrap(async (req, res) => ok(res, L.bundlesOfOrder(req.params.orderId)))
);

router.get(
  '/resolve',
  authRequired,
  wrap(async (req, res) => ok(res, L.resolve(req.query.code)))
);

module.exports = router;
