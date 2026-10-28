/**
 * 客户对账单（`/api/statements`）
 *
 * GET /api/statements/customers            有往来的客户 + 当前结欠（选客户用）
 * GET /api/statements/:customerId?from=&to= 对账单数据（期初 / 本期流水 / 期末 + 交叉校验告警）
 *
 * 权限：财务、销售（业务员要拿去催款）、老板只读、管理员。**人事/技术/仓储看不到** ——
 * 对账单是全公司的客户欠款明细，扩散出去等于把客户名单和价格体系一起送人。
 */
const express = require('express');
const ST = require('../services/statement');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const READ = ['admin', 'boss', 'finance', 'sales'];

router.get('/customers', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, ST.listCustomers())));

router.get(
  '/:customerId',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, ST.build(req.params.customerId, req.query)))
);

module.exports = router;
