/**
 * 销售与客户（原型 M03 剩余 5 个节点）
 * ============================================================
 * 线索商机 / 客户采购周期 / 客户价值排行 / 目标与提成 / 客户交接
 *
 * 权限：
 *   读 —— 全部业务角色（客户与线索本来就是销售、财务、生产都要看的）
 *   写 —— sales（业务员挂在 sales 角色下）、admin
 *   批 —— admin / finance（目标版、提成规则、提成单都过财务这道关）
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const C = require('../services/crm');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'sales'];
const APPROVE = ['admin', 'finance'];

/** 服务层的业务校验异常统一转 400 */
function guard(fn) {
  return (req, res) => {
    try {
      const r = fn(req);
      ok(res, r);
    } catch (e) {
      fail(res, 400, e.message);
    }
  };
}

/** ==================== 字典与汇总 ==================== */
router.get('/dict', authRequired, requireRole(...READ), (req, res) => ok(res, C.dict()));
router.get('/overview', authRequired, requireRole(...READ), (req, res) => ok(res, C.overview()));

/** ==================== 一、线索与商机（N03-07） ==================== */
router.get('/leads', authRequired, requireRole(...READ), (req, res) => ok(res, C.listLeads(req.query)));
router.get('/leads/:id', authRequired, requireRole(...READ), guard((req) => C.getLead(req.params.id)));
router.post('/leads', authRequired, requireRole(...WRITE), guard((req) => C.createLead(req.body || {}, req.user)));
router.put('/leads/:id', authRequired, requireRole(...WRITE), guard((req) => C.updateLead(req.params.id, req.body || {}, req.user)));
router.post('/leads/:id/assign', authRequired, requireRole(...WRITE), guard((req) => C.assignLead(req.params.id, req.body || {}, req.user)));
router.post('/leads/:id/claim', authRequired, requireRole(...WRITE), guard((req) => C.claimLead(req.params.id, req.user)));
router.post('/leads/:id/recycle', authRequired, requireRole(...WRITE), guard((req) => C.recycleLead(req.params.id, req.body || {}, req.user)));
router.post('/leads/sweep-pool', authRequired, requireRole(...WRITE), guard((req) => C.sweepPool(req.user)));
router.post('/leads/:id/follow', authRequired, requireRole(...WRITE), guard((req) => C.followLead(req.params.id, req.body || {}, req.user)));
router.post('/leads/:id/stage', authRequired, requireRole(...WRITE), guard((req) => C.setLeadStage(req.params.id, req.body || {}, req.user)));
router.post('/leads/:id/merge', authRequired, requireRole(...WRITE), guard((req) => C.mergeLead(req.params.id, req.body || {}, req.user)));
router.post('/leads/import', authRequired, requireRole(...WRITE), guard((req) => C.importLeads((req.body || {}).rows, req.user)));
router.delete('/leads/:id', authRequired, requireRole('admin'), guard((req) => C.deleteLead(req.params.id, req.user)));

/** ==================== 二、客户采购周期与回访（N03-03） ==================== */
router.get('/cycles', authRequired, requireRole(...READ), (req, res) => ok(res, C.listCycles(req.query)));
router.get('/cycles/alerts', authRequired, requireRole(...READ), (req, res) => ok(res, C.cycleAlerts(req.query)));
router.get('/cycles/infer', authRequired, requireRole(...READ), (req, res) => ok(res, C.inferCycles()));
router.post('/cycles', authRequired, requireRole(...WRITE), guard((req) => C.upsertCycle(req.body || {}, req.user)));
router.post('/cycles/accept-inference', authRequired, requireRole(...WRITE),
  guard((req) => C.acceptInference((req.body || {}).customer_id, (req.body || {}).days, req.user)));
router.post('/cycles/refresh', authRequired, requireRole(...WRITE), guard((req) => C.refreshCycles(req.user)));

router.get('/followups', authRequired, requireRole(...READ), (req, res) => ok(res, C.listFollowups(req.query)));
router.post('/followups', authRequired, requireRole(...WRITE), guard((req) => C.addFollowup(req.body || {}, req.user)));

/** ==================== 三、客户价值排行（N03-04） ==================== */
router.get('/ranking', authRequired, requireRole(...READ), (req, res) => ok(res, C.ranking(req.query)));

/** ==================== 四、客户与未结业务交接（N03-06） ==================== */
router.get('/handovers', authRequired, requireRole(...READ), (req, res) => ok(res, C.listHandovers(req.query)));
router.get('/handovers/:id', authRequired, requireRole(...READ), guard((req) => C.getHandover(req.params.id)));
router.post('/handovers', authRequired, requireRole(...WRITE), guard((req) => C.createHandover(req.body || {}, req.user)));
router.post('/handovers/:id/status', authRequired, requireRole(...WRITE, 'finance'),
  guard((req) => C.setHandoverStatus(req.params.id, req.body || {}, req.user)));
router.delete('/handovers/:id', authRequired, requireRole('admin'), guard((req) => C.deleteHandover(req.params.id, req.user)));

/** ==================== 五、销售目标（N03-09） ==================== */
router.get('/targets', authRequired, requireRole(...READ), (req, res) => ok(res, C.listTargets(req.query)));
router.get('/targets/:id', authRequired, requireRole(...READ), guard((req) => C.getTarget(req.params.id)));
router.post('/targets', authRequired, requireRole(...WRITE), guard((req) => C.createTarget(req.body || {}, req.user)));
router.post('/targets/:id/approve', authRequired, requireRole(...APPROVE), guard((req) => C.approveTarget(req.params.id, req.user)));

/** ==================== 六、提成规则与提成单（N03-09） ==================== */
router.get('/commission-rules', authRequired, requireRole(...READ), (req, res) => ok(res, C.listRules(req.query)));
router.post('/commission-rules', authRequired, requireRole(...WRITE), guard((req) => C.createRule(req.body || {}, req.user)));
router.post('/commission-rules/:id/approve', authRequired, requireRole(...APPROVE), guard((req) => C.approveRule(req.params.id, req.user)));

router.get('/commissions', authRequired, requireRole(...READ), (req, res) => ok(res, C.listCommissions(req.query)));
router.get('/commissions/:id', authRequired, requireRole(...READ), guard((req) => C.getCommission(req.params.id)));
router.post('/commissions/preview', authRequired, requireRole(...WRITE), guard((req) => C.previewCommission(req.body || {})));
router.post('/commissions', authRequired, requireRole(...WRITE), guard((req) => C.createCommission(req.body || {}, req.user)));
router.post('/commissions/:id/adjust', authRequired, requireRole(...WRITE), guard((req) => C.addAdjustment(req.params.id, req.body || {}, req.user)));
router.post('/commissions/:id/status', authRequired, requireRole(...APPROVE, 'sales'),
  guard((req) => C.setCommissionStatus(req.params.id, req.body || {}, req.user)));
router.post('/commissions/:id/link-payroll', authRequired, requireRole(...APPROVE),
  guard((req) => C.linkPayroll(req.params.id, req.body || {}, req.user)));
router.delete('/commissions/:id', authRequired, requireRole('admin'), guard((req) => C.deleteCommission(req.params.id, req.user)));

/** ==================== 报表 ==================== */
router.get('/reports/cycle', authRequired, requireRole(...READ), (req, res) => ok(res, C.reportCycle(req.query)));
router.get('/reports/commission', authRequired, requireRole(...READ), (req, res) => ok(res, C.reportCommission(req.query)));

module.exports = router;
