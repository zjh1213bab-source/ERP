/**
 * 资金计划（13 周现金流）
 *
 * GET /api/cashflow/plan?weeks=13&base_date=&scenario=base   单档预测（含逐周明细）
 * GET /api/cashflow/compare?weeks=13&base_date=              三档情景并排
 *
 * 与「经营驾驶舱」的区别写在 services/cashflow.js 文件头：
 * 驾驶舱给结论（钱够不够），这里给调度（这周付谁）。
 *
 * ## 主体从哪来
 *
 * 原来直接把 `req.query.company_id` 丢给服务层，而服务层把"没有主体"当成
 * **不过滤** —— 于是 finance 不传参时算的是整个集团合并数，传 `3` 时读的是别家的钱。
 * 现在一律过 `companyScope.resolveCompany()`：普通角色只能用自己那个主体，
 * 显式指定别家返回 404；只有 admin / boss 能选别的主体。
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const CS = require('../access/companyScope');
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
        company_id: CS.resolveCompany(req.user, req.query.company_id, { action: '查看资金计划' }),
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
        company_id: CS.resolveCompany(req.user, req.query.company_id, { action: '查看情景对比' })
      })
    )
  )
);

module.exports = router;
