/**
 * 营销与素材（原型 M16）
 * ============================================================
 * 四个页签：上新日历 / 素材库 / 活动投放 / 运营复盘。
 *
 * 权限：
 *   读 —— 全部业务角色（销售要看上新计划，生产要看资料卡在哪）
 *   写 —— sales（运营）、tech（设计/素材）
 *   批 —— 活动预算批准与素材审核放给 finance / tech，admin 恒通过
 */
const express = require('express');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const M = require('../services/mkt');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'sales', 'tech'];
const REVIEW_ROLE = ['admin', 'finance'];
const REVOKE = ['admin', 'sales', 'tech', 'finance'];
const ADMIN = ['admin'];

const operatorOf = (req) => (req.user && (req.user.name || req.user.username)) || 'system';
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/** 统一把服务层异常转成 400 —— 业务校验都写在服务层，路由不重复判断 */
function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      fail(res, 400, e.message);
    }
  };
}

/** ==================== 字典 / 汇总 ==================== */
router.get('/dict', authRequired, requireRole(...READ), (req, res) => ok(res, M.dict()));
router.get('/overview', authRequired, requireRole(...READ), (req, res) => ok(res, M.overview()));

/** ==================== 上新任务 ==================== */
router.get('/tasks', authRequired, requireRole(...READ), (req, res) => {
  ok(res, M.listTasks({
    status: req.query.status,
    channel: req.query.channel,
    owner: req.query.owner,
    month: req.query.month,
    q: req.query.q,
    overdue: req.query.overdue,
    company_id: num(req.query.company_id)
  }));
});

router.get('/calendar', authRequired, requireRole(...READ), (req, res) => {
  ok(res, M.calendar(req.query.month));
});

router.get('/tasks/:id', authRequired, requireRole(...READ), (req, res) => {
  const t = M.getTask(req.params.id);
  if (!t) return fail(res, 404, '任务不存在');
  ok(res, t);
});

router.post('/tasks', authRequired, requireRole(...WRITE), guard((req) => M.createTask(req.body || {}, operatorOf(req))));

router.put('/tasks/:id', authRequired, requireRole(...WRITE), guard((req) => M.updateTask(req.params.id, req.body || {}, operatorOf(req))));

router.post('/tasks/:id/status', authRequired, requireRole(...WRITE), guard((req) => {
  const to = String((req.body || {}).to || '');
  return M.advanceTask(req.params.id, to, req.body || {}, operatorOf(req));
}));

router.delete('/tasks/:id', authRequired, requireRole(...ADMIN), guard((req) => M.deleteTask(req.params.id, operatorOf(req))));

router.post('/tasks/:id/steps', authRequired, requireRole(...WRITE), guard((req) => M.addStep(req.params.id, req.body || {})));
router.post('/tasks/:id/steps/:sid', authRequired, requireRole(...WRITE), guard((req) => M.setStep(req.params.id, req.params.sid, req.body || {})));

/** 绑素材：授权不符直接 400（客户专属/渠道范围/过期） */
router.post('/tasks/:id/assets', authRequired, requireRole(...WRITE), guard((req) => {
  const b = req.body || {};
  if (!b.asset_id) throw new Error('请选择素材');
  return M.bindAsset(req.params.id, b, operatorOf(req));
}));
router.delete('/tasks/:id/assets/:aid', authRequired, requireRole(...WRITE), guard((req) => M.unbindAsset(req.params.id, req.params.aid)));

/** ==================== 素材 ==================== */
router.get('/assets', authRequired, requireRole(...READ), (req, res) => {
  ok(res, M.listAssets({
    status: req.query.status,
    kind: req.query.kind,
    scope: req.query.scope,
    style_no: req.query.style_no,
    customer_id: num(req.query.customer_id),
    q: req.query.q,
    expiring: req.query.expiring,
    days: req.query.days
  }));
});

router.get('/assets/:id', authRequired, requireRole(...READ), (req, res) => {
  const a = M.getAsset(req.params.id);
  if (!a) return fail(res, 404, '素材不存在');
  ok(res, a);
});

router.post('/assets', authRequired, requireRole(...WRITE), guard((req) => M.createAsset(req.body || {}, operatorOf(req))));
router.put('/assets/:id', authRequired, requireRole(...WRITE), guard((req) => M.updateAsset(req.params.id, req.body || {}, operatorOf(req))));
router.post('/assets/:id/submit', authRequired, requireRole(...WRITE), guard((req) => M.submitAsset(req.params.id, operatorOf(req))));
router.post('/assets/:id/review', authRequired, requireRole(...WRITE), guard((req) => M.reviewAsset(req.params.id, req.body || {}, operatorOf(req))));
router.post('/assets/:id/revoke', authRequired, requireRole(...REVOKE), guard((req) => M.revokeAsset(req.params.id, req.body || {}, operatorOf(req))));
router.delete('/assets/:id', authRequired, requireRole(...ADMIN), guard((req) => M.deleteAsset(req.params.id, operatorOf(req))));
/** 把已到期仍标「可用」的素材落库成过期（定时或手工触发） */
router.post('/assets/sweep-expired', authRequired, requireRole(...REVIEW_ROLE), guard((req) => M.sweepExpired(operatorOf(req))));

/** ==================== 活动 ==================== */
router.get('/campaigns', authRequired, requireRole(...READ), (req, res) => {
  ok(res, M.listCampaigns({
    status: req.query.status,
    currency: req.query.currency,
    channel: req.query.channel,
    company_id: num(req.query.company_id)
  }));
});

router.get('/campaigns/:id', authRequired, requireRole(...READ), (req, res) => {
  const c = M.getCampaign(req.params.id);
  if (!c) return fail(res, 404, '活动不存在');
  ok(res, c);
});

router.post('/campaigns', authRequired, requireRole(...WRITE), guard((req) => M.createCampaign(req.body || {}, operatorOf(req))));
router.put('/campaigns/:id', authRequired, requireRole(...WRITE), guard((req) => M.updateCampaign(req.params.id, req.body || {})));
router.post('/campaigns/:id/approve', authRequired, requireRole(...REVIEW_ROLE), guard((req) => M.approveCampaign(req.params.id, req.body || {}, operatorOf(req))));
router.post('/campaigns/:id/status', authRequired, requireRole(...WRITE), guard((req) => {
  const to = String((req.body || {}).to || '');
  return M.advanceCampaign(req.params.id, to, req.body || {}, operatorOf(req));
}));
router.post('/campaigns/:id/bills', authRequired, requireRole(...WRITE), guard((req) => M.addBill(req.params.id, req.body || {}, operatorOf(req))));
router.get('/campaigns/:id/attribution', authRequired, requireRole(...READ), (req, res) => {
  const c = M.getCampaign(req.params.id);
  if (!c) return fail(res, 404, '活动不存在');
  ok(res, M.attributionOf(c));
});

/** ==================== 复盘 ==================== */
router.get('/reviews', authRequired, requireRole(...READ), (req, res) => {
  ok(res, M.listReviews({
    status: req.query.status,
    period: req.query.period,
    category: req.query.category,
    owner: req.query.owner
  }));
});

router.get('/reviews/:id', authRequired, requireRole(...READ), (req, res) => {
  const r = M.getReview(req.params.id);
  if (!r) return fail(res, 404, '复盘不存在');
  ok(res, r);
});

router.post('/reviews', authRequired, requireRole(...WRITE), guard((req) => M.createReview(req.body || {}, operatorOf(req))));
router.post('/reviews/:id/actions', authRequired, requireRole(...WRITE), guard((req) => M.addReviewAction(req.params.id, req.body || {}, operatorOf(req))));
router.post('/reviews/:id/actions/:aid', authRequired, requireRole(...WRITE), guard((req) => M.setReviewAction(req.params.id, req.params.aid, req.body || {})));
router.post('/reviews/:id/status', authRequired, requireRole(...WRITE), guard((req) => {
  const to = String((req.body || {}).to || '');
  return M.advanceReview(req.params.id, to, req.body || {}, operatorOf(req));
}));

/** ==================== 报表 ==================== */
router.get('/reports/launch', authRequired, requireRole(...READ), (req, res) => ok(res, M.reportLaunch({ month: req.query.month })));
router.get('/reports/campaign', authRequired, requireRole(...READ), (req, res) => ok(res, M.reportCampaign()));
router.get('/reports/review', authRequired, requireRole(...READ), (req, res) => ok(res, M.reportReview()));

module.exports = router;
