/**
 * 税负测算（原型 M12 / N12-06）
 * ============================================================
 * 税政配置 + 测算批次 + 明细 + 导出底稿。
 * 权限：读开放给财务与管理员；写与确认限 finance / admin。
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const T = require('../services/tax');

const router = express.Router();
const READ = ['admin', 'finance'];
const WRITE = ['admin', 'finance'];

const operatorOf = (req) => (req.user && (req.user.name || req.user.username)) || 'system';
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      fail(res, 400, e.message);
    }
  };
}

router.get('/dict', authRequired, requireRole(...READ), (req, res) => ok(res, T.dict()));
router.get('/overview', authRequired, requireRole(...READ), (req, res) => ok(res, T.overview()));

/** ==================== 税政配置 ==================== */
router.get('/policies', authRequired, requireRole(...READ), (req, res) => {
  ok(res, T.listPolicies({
    company_id: num(req.query.company_id),
    tax_region: req.query.tax_region,
    status: req.query.status
  }));
});
router.post('/policies', authRequired, requireRole(...WRITE), guard((req) => T.createPolicy(req.body || {}, operatorOf(req))));

/** ==================== 测算 ==================== */
/** 预览（不落库）：先看数再决定存不存 */
router.get('/preview', authRequired, requireRole(...READ), guard((req) => {
  const companyId = num(req.query.company_id);
  const period = String(req.query.period || '');
  const region = String(req.query.tax_region || 'CN');
  if (!companyId) throw new Error('请选择主体');
  return T.compute(companyId, period, region);
}));

router.post('/runs', authRequired, requireRole(...WRITE), guard((req) => {
  const b = req.body || {};
  if (!b.company_id) throw new Error('请选择主体');
  return T.saveRun(num(b.company_id), String(b.period || ''), String(b.tax_region || 'CN'), b, operatorOf(req));
}));

router.get('/runs', authRequired, requireRole(...READ), (req, res) => {
  ok(res, T.listRuns({
    company_id: num(req.query.company_id),
    tax_region: req.query.tax_region,
    period: req.query.period,
    status: req.query.status
  }));
});
router.get('/runs/:id', authRequired, requireRole(...READ), (req, res) => {
  const r = T.getRun(req.params.id);
  if (!r) return fail(res, 404, '测算批次不存在');
  ok(res, r);
});
router.post('/runs/:id/confirm', authRequired, requireRole(...WRITE), guard((req) => T.confirmRun(req.params.id, req.body || {}, operatorOf(req))));
router.post('/runs/:id/void', authRequired, requireRole(...WRITE), guard((req) => T.voidRun(req.params.id, req.body || {})));

router.get('/runs/:id/export', authRequired, requireRole(...READ), (req, res) => {
  const r = T.getRun(req.params.id);
  if (!r) return fail(res, 404, '测算批次不存在');
  const csv = T.exportCsv(r.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tax-${r.run_no}.csv"`);
  res.send(csv);
});

router.get('/trend', authRequired, requireRole(...READ), (req, res) => {
  ok(res, T.trend(num(req.query.company_id) || 1, req.query.tax_region || 'CN', req.query.months || 6));
});

module.exports = router;
