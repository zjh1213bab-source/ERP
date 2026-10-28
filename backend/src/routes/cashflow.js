/**
 * 资金计划（13 周现金流）
 *
 * GET /api/cashflow/plan?weeks=13&base_date=&scenario=base   单档预测（含逐周明细）
 * GET /api/cashflow/compare?weeks=13&base_date=              三档情景并排
 *
 * 与「经营驾驶舱」的区别写在 services/cashflow.js 文件头：
 * 驾驶舱给结论（钱够不够），这里给调度（这周付谁）。
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const cashflow = require('../services/cashflow');

const router = express.Router();
const READ = ['admin', 'boss', 'finance'];

router.get(
  '/plan',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) =>
    ok(
      res,
      cashflow.plan({
        weeks: req.query.weeks,
        baseDate: req.query.base_date,
        company_id: req.query.company_id,
        scenario: req.query.scenario,
        collectRate: req.query.collect_rate
      })
    )
  )
);

router.get(
  '/compare',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) =>
    ok(
      res,
      cashflow.compare({
        weeks: req.query.weeks,
        baseDate: req.query.base_date,
        company_id: req.query.company_id
      })
    )
  )
);

module.exports = router;
