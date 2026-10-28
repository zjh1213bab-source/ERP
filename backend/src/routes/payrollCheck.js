/**
 * 薪酬计件与工资核对（TS-N13-05）
 * ========================================================================
 * - `/api/payroll-check/preview`   按期间现算核对结果（不落库）
 * - `/api/payroll-check/run`       生成核对批次（落库，供逐行处理）
 * - `/api/payroll-check/runs`      历史批次
 * - `/api/payroll-check/sources`   某员工的计件来源明细（钱是怎么算出来的）
 * - `/api/payroll-check/diff/:id`  登记差异 → 生成 `payroll_adjustments`（下一期生效）
 * - `/api/payroll-check/annotate/:id` 写核对说明（不改钱）
 * - `/api/payroll-check/review/:id`   完成核对（未处理差异会被拦）
 *
 * 权限：工资数据连读都限岗（与 `/api/payrolls` 同一口径），
 * 不是「全公司都能看」的行政报表。核对与登记差异只给人事/财务/管理员。
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/payrollCheck');

const router = express.Router();

const READ = ['admin', 'boss', 'hr', 'finance'];
const MANAGE = ['admin', 'hr', 'finance'];

const actor = (req) => (req.user && (req.user.name || req.user.username || req.user.sub)) || 'system';

router.get('/meta', authRequired, requireRole(...READ), wrap(async (req, res) => ok(res, S.meta())));

router.get('/preview', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const q = req.query || {};
  return ok(res, S.buildCheck(String(q.period || ''), { company_id: q.company_id ? Number(q.company_id) : null }));
}));

router.post('/run', authRequired, requireRole(...MANAGE), wrap(async (req, res) => {
  const b = req.body || {};
  return ok(res, S.runCheck(String(b.period || ''), {
    company_id: b.company_id ? Number(b.company_id) : null,
    force: !!b.force,
    note: b.note
  }, actor(req)));
}));

router.get('/runs', authRequired, requireRole(...READ), wrap(async (req, res) =>
  ok(res, S.listRuns(req.query || {}))));

router.get('/runs/:id', authRequired, requireRole(...READ), wrap(async (req, res) =>
  ok(res, S.runDetail(req.params.id))));

router.get('/sources', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const q = req.query || {};
  if (!q.run_id || !q.employee_id) {
    const e = new Error('需要 run_id 与 employee_id');
    e.status = 400;
    throw e;
  }
  return ok(res, S.sources(q.run_id, q.employee_id));
}));

// 登记差异 = 生成一张下一期生效的调整单；不改已确认的工资单
router.post('/diff/:itemId', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.registerDiff(req.params.itemId, req.body || {}, actor(req)))));

router.post('/annotate/:itemId', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.annotate(req.params.itemId, req.body || {}, actor(req)))));

router.post('/review/:id', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.review(req.params.id, req.body || {}, actor(req)))));

module.exports = router;
