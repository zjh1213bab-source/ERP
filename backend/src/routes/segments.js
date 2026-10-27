/**
 * 分公司（分部）经营对比（M12）
 * ============================================================
 * 权限：
 *   读 —— admin / finance / sales（老板与财务看；销售看自己主体那段）
 *   写 —— admin / finance（登记可比口径调整、出报告、确认报告）
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/segments');

const router = express.Router();
const READ = ['admin', 'finance', 'sales'];
const WRITE = ['admin', 'finance'];

function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      const code = e.code && Number.isInteger(e.code) ? e.code : 400;
      return fail(res, code, e.message);
    }
  };
}
const opName = (req) => (req.user && (req.user.name || req.user.username)) || String((req.user && (req.user.id || req.user.sub)) || 'system');

router.get('/dict', authRequired, requireRole(...READ), (req, res) => ok(res, S.dict()));

/** 主表：各主体对外口径 + 合计 + 合并对照 + 口径问题 */
router.get('/board', authRequired, requireRole(...READ), (req, res) => {
  const period = String(req.query.period || '').slice(0, 7) || S.latestPeriod();
  return ok(res, S.board(period));
});

/** 单主体下钻 */
router.get('/company/:id', authRequired, requireRole(...READ), (req, res) => {
  const period = String(req.query.period || '').slice(0, 7) || S.latestPeriod();
  const d = S.companyDetail(req.params.id, period);
  if (!d) return fail(res, 404, '主体不存在');
  return ok(res, d);
});

/** ==================== 可比口径调整 ==================== */
router.get('/adjustments', authRequired, requireRole(...READ), (req, res) => {
  const period = String(req.query.period || '').slice(0, 7) || S.latestPeriod();
  return ok(res, S.listAdjustments(period));
});

router.post('/adjustments', authRequired, requireRole(...WRITE), guard((req) =>
  S.saveAdjustment(req.body || {}, opName(req))));

router.delete('/adjustments/:id', authRequired, requireRole(...WRITE), guard((req) =>
  S.deleteAdjustment(req.params.id)));

/** ==================== 报告快照 ==================== */
router.get('/reports', authRequired, requireRole(...READ), (req, res) => {
  const period = String(req.query.period || '').slice(0, 7);
  return ok(res, S.listReports(period || null));
});

router.post('/reports', authRequired, requireRole(...WRITE), guard((req) => {
  const b = req.body || {};
  const period = String(b.period || '').slice(0, 7) || S.currentPeriod();
  return S.generateReport(period, opName(req), b.note);
}));

router.get('/reports/:id', authRequired, requireRole(...READ), (req, res) => {
  const r = S.getReport(req.params.id);
  if (!r) return fail(res, 404, '报告不存在');
  return ok(res, r);
});

router.post('/reports/:id/confirm', authRequired, requireRole(...WRITE), guard((req) =>
  S.confirmReport(req.params.id, opName(req), (req.body || {}).note)));

/** 导出 CSV（带 BOM，Excel 直开） */
router.get('/export', authRequired, requireRole(...READ), (req, res) => {
  const period = String(req.query.period || '').slice(0, 7) || S.latestPeriod();
  const r = S.exportCsv(period);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(r.filename)}"`);
  return res.send('\ufeff' + r.csv);
});

module.exports = router;
