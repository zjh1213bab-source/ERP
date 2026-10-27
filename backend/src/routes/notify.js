/**
 * 客户营销与消息（原型 M24，6 个节点）
 * ============================================================
 * 上新与到货提醒 / 采购周期与回访任务 / 站内与邮件通知 /
 * 微信通知与渠道降级 / 发送频控与审计 / 营销效果与销售归因
 *
 * 权限：
 *   读 —— 全部业务角色（运营、销售、客服都要看发送与回执）
 *   写 —— admin / sales（订阅、提醒、事件、发送、回执）
 *   审核 —— admin / finance（模板批准、频控规则、渠道能力）
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const N = require('../services/notify');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'sales'];
const APPROVE = ['admin', 'finance'];

function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      fail(res, 400, e.message);
    }
  };
}

/** ==================== 字典与汇总 ==================== */
router.get('/dict', authRequired, requireRole(...READ), (req, res) => ok(res, N.dict()));
router.get('/overview', authRequired, requireRole(...READ), (req, res) => ok(res, N.overview()));
router.get('/channels', authRequired, requireRole(...READ), (req, res) => ok(res, N.listCaps(Number(req.query.company_id) || 1)));
router.post('/channels', authRequired, requireRole(...APPROVE), guard((req) => N.setCap(req.body || {}, req.user)));

/** ==================== 订阅（N24-03 / N24-05） ==================== */
router.get('/subs', authRequired, requireRole(...READ), (req, res) => ok(res, N.listSubs(req.query)));
router.post('/subs', authRequired, requireRole(...WRITE), guard((req) => N.upsertSub(req.body || {}, req.user)));
router.post('/subs/:customerId/unsubscribe-marketing', authRequired, requireRole(...WRITE),
  guard((req) => N.unsubscribeMarketing(req.params.customerId, req.body || {}, req.user)));
router.post('/subs/:customerId/verify-email', authRequired, requireRole(...WRITE),
  guard((req) => N.requestEmailVerify(req.params.customerId, req.user)));
router.post('/subs/:customerId/confirm-email', authRequired, requireRole(...WRITE),
  guard((req) => N.confirmEmailVerify(req.params.customerId, req.body || {}, req.user)));

/** ==================== 模板（N24-03 / N24-05） ==================== */
router.get('/templates', authRequired, requireRole(...READ), (req, res) => ok(res, N.listTemplates(req.query)));
router.get('/templates/:id', authRequired, requireRole(...READ), guard((req) => N.getTemplate(req.params.id)));
router.post('/templates', authRequired, requireRole(...WRITE), guard((req) => N.createTemplate(req.body || {}, req.user)));
router.put('/templates/:id', authRequired, requireRole(...WRITE), guard((req) => N.updateTemplate(req.params.id, req.body || {}, req.user)));
router.post('/templates/:id/submit', authRequired, requireRole(...WRITE), guard((req) => N.submitTemplate(req.params.id, req.user)));
router.post('/templates/:id/approve', authRequired, requireRole(...APPROVE), guard((req) => N.approveTemplate(req.params.id, req.body || {}, req.user)));
router.post('/templates/:id/retire', authRequired, requireRole(...APPROVE), guard((req) => N.retireTemplate(req.params.id, req.body || {}, req.user)));
router.delete('/templates/:id', authRequired, requireRole('admin'), guard((req) => N.deleteTemplate(req.params.id, req.user)));

/** ==================== 微信绑定与渠道降级（N24-04） ==================== */
router.get('/wechat', authRequired, requireRole(...READ), (req, res) => ok(res, N.listBindings(req.query)));
router.post('/wechat', authRequired, requireRole(...WRITE), guard((req) => N.bindWechat(req.body || {}, req.user)));
router.post('/wechat/sync', authRequired, requireRole(...WRITE), guard((req) => N.syncWechat(req.body || {}, req.user)));

/** ==================== 频控（N24-05） ==================== */
router.get('/frequency', authRequired, requireRole(...READ), (req, res) => ok(res, N.listRules()));
router.post('/frequency', authRequired, requireRole(...APPROVE), guard((req) => N.saveRule(req.body || {}, req.user)));

/** ==================== 事件（N24-01 / N24-02 / N24-03） ==================== */
router.get('/events', authRequired, requireRole(...READ), (req, res) => ok(res, N.listEvents(req.query)));
router.post('/events', authRequired, requireRole(...WRITE),
  guard((req) => N.emitEvent((req.body || {}).event_key, req.body || {}, req.user)));

/** ==================== 发送队列与回执（N24-03 / N24-05） ==================== */
router.get('/outbox', authRequired, requireRole(...READ), (req, res) => ok(res, N.listOutbox(req.query)));
router.get('/outbox/:id', authRequired, requireRole(...READ), guard((req) => N.getOutbox(req.params.id)));
router.post('/outbox/dispatch', authRequired, requireRole(...WRITE), guard((req) => N.dispatchPending(req.body || {}, req.user)));
router.post('/outbox/:id/send', authRequired, requireRole(...WRITE), guard((req) => N.sendOutbox(req.params.id, req.user)));
router.post('/outbox/:id/receipt', authRequired, requireRole(...WRITE),
  guard((req) => N.receipt(req.params.id, req.body || {}, req.user)));
router.post('/outbox/:id/retry', authRequired, requireRole(...WRITE), guard((req) => N.retryOutbox(req.params.id, req.user)));
router.post('/outbox/:id/skip', authRequired, requireRole(...WRITE),
  guard((req) => N.skipOutbox(req.params.id, req.body || {}, req.user)));

/** ==================== 到货/上新提醒（N24-01） ==================== */
router.get('/alerts', authRequired, requireRole(...READ), (req, res) => ok(res, N.listAlerts(req.query)));
router.post('/alerts', authRequired, requireRole(...WRITE), guard((req) => N.createAlert(req.body || {}, req.user)));
router.post('/alerts/sweep', authRequired, requireRole(...WRITE), guard((req) => N.sweepAlerts(req.user)));
router.post('/alerts/:id/cancel', authRequired, requireRole(...WRITE),
  guard((req) => N.cancelAlert(req.params.id, req.body || {}, req.user)));

/** ==================== 周期回访任务（N24-02） ==================== */
router.post('/cycle-tasks', authRequired, requireRole(...WRITE), guard((req) => N.cycleTasks(req.body || {}, req.user)));

/** ==================== 效果归因（N24-06） ==================== */
router.get('/attribution', authRequired, requireRole(...READ), (req, res) => ok(res, N.attributionReport(req.query)));
router.post('/attribution/refresh', authRequired, requireRole(...WRITE),
  guard((req) => N.refreshAttribution(req.body || {}, req.user)));

module.exports = router;
