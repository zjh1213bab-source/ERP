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
const CS = require('../access/companyScope');

const router = express.Router();
const READ = ['admin', 'finance'];
const WRITE = ['admin', 'finance'];

const operatorOf = (req) => (req.user && (req.user.name || req.user.username)) || 'system';

/**
 * 本次请求算哪个主体 —— 一律服务端判定
 *
 * 原来 6 处直接把 `req.query.company_id` / `req.body.company_id` 交给服务层：
 * 税负测算读的是收入、进项、税负率，属于最敏感的几张表之一，
 * 却让 finance 可以随手传一个别家的主体编号。现在只有集团角色能指定别的主体。
 *
 * `allowAll` 只给"配置/批次列表"用（集团角色看全部），**不能给测算和落库用** ——
 * 那两处必须落到一个具体主体，`null` 会让服务层去算"全集团"。
 */
const coId = (req, raw, act, allowAll) =>
  CS.resolveCompany(req.user, raw, { action: act || '查看税负测算', allowAll: !!allowAll, concrete: true });

/**
 * 统一错误出口：**尊重业务层给的状态码**
 *
 * 原来这里写死 400，于是「跨主体访问」这类本该 404 的错误会被吐成 400 ——
 * 等于告诉对方「这个 id 的格式没问题、只是参数不对」，是另一种存在性泄露。
 */
function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      fail(res, e.status || 400, e.message);
    }
  };
}

router.get('/dict', authRequired, requireRole(...READ), (req, res) => ok(res, T.dict()));
router.get('/overview', authRequired, requireRole(...READ), (req, res) => ok(res, T.overview()));

/** ==================== 税政配置 ==================== */
router.get('/policies', authRequired, requireRole(...READ), (req, res) => {
  ok(res, T.listPolicies({
    // allowAll：集团角色不传参时看全部主体（政策是集团层面配的），普通角色恒为自己那个
    company_id: coId(req, req.query.company_id ?? 'all', '查看税政配置', true),
    tax_region: req.query.tax_region,
    status: req.query.status
  }));
});
/**
 * 新增税政配置
 *
 * 主体必须在路由层被改写：`T.createPolicy(b)` 自己会读 `b.company_id`，
 * 直接把 body 传进去等于把"配到哪家"的决定权交给了调用方。
 */
router.post('/policies', authRequired, requireRole(...WRITE), guard((req) => {
  const b = { ...(req.body || {}) };
  b.company_id = coId(req, b.company_id, '新增税政配置');
  return T.createPolicy(b, operatorOf(req));
}));

/** ==================== 测算 ==================== */
/** 预览（不落库）：先看数再决定存不存 */
router.get('/preview', authRequired, requireRole(...READ), guard((req) => {
  // 主体由服务端定：不传就是自己那家，传别家（非集团角色）直接 404
  const companyId = coId(req, req.query.company_id, '做税负测算');
  const period = String(req.query.period || '');
  const region = String(req.query.tax_region || 'CN');
  return T.compute(companyId, period, region);
}));

router.post('/runs', authRequired, requireRole(...WRITE), guard((req) => {
  const b = req.body || {};
  return T.saveRun(
    coId(req, b.company_id, '保存税负测算批次'),
    String(b.period || ''), String(b.tax_region || 'CN'), b, operatorOf(req)
  );
}));

router.get('/runs', authRequired, requireRole(...READ), (req, res) => {
  ok(res, T.listRuns({
    company_id: coId(req, req.query.company_id ?? 'all', '查看测算批次', true),
    tax_region: req.query.tax_region,
    period: req.query.period,
    status: req.query.status
  }));
});
router.get('/runs/:id', authRequired, requireRole(...READ), (req, res) => {
  const r = T.getRun(req.params.id);
  if (!r) return fail(res, 404, '测算批次不存在');
  // 批次自己带主体：不符回 404（不泄露"这批存在"）
  if (!CS.canSee(req.user, { company_id: r.company_id })) return fail(res, 404, '测算批次不存在');
  ok(res, r);
});
router.post('/runs/:id/confirm', authRequired, requireRole(...WRITE), guard((req) => {
  const r = T.getRun(req.params.id);
  if (!r) { const e = new Error('测算批次不存在'); e.status = 404; throw e; }
  if (!CS.canSee(req.user, { company_id: r.company_id })) {
    const e = new Error('测算批次不存在'); e.status = 404; throw e;
  }
  return T.confirmRun(req.params.id, req.body || {}, operatorOf(req));
}));
router.post('/runs/:id/void', authRequired, requireRole(...WRITE), guard((req) => {
  const r = T.getRun(req.params.id);
  if (!r) { const e = new Error('测算批次不存在'); e.status = 404; throw e; }
  if (!CS.canSee(req.user, { company_id: r.company_id })) {
    const e = new Error('测算批次不存在'); e.status = 404; throw e;
  }
  return T.voidRun(req.params.id, req.body || {});
}));

router.get('/runs/:id/export', authRequired, requireRole(...READ), (req, res) => {
  const r = T.getRun(req.params.id);
  if (!r || !CS.canSee(req.user, { company_id: r.company_id })) {
    return fail(res, 404, '测算批次不存在');
  }
  const csv = T.exportCsv(r.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tax-${r.run_no}.csv"`);
  res.send(csv);
});

router.get('/trend', authRequired, requireRole(...READ), (req, res) => {
  ok(res, T.trend(coId(req, req.query.company_id, '查看税负趋势'), req.query.tax_region || 'CN', req.query.months || 6));
});

module.exports = router;
