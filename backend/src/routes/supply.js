/**
 * 供给批次与预订（原型 M23，6 个节点）
 * ============================================================
 * 可售口径 / 供给批次 / 预订申请 / 占用 / 缺口。
 *
 * 权限：
 *   读 —— 全部业务角色（商城、销售、仓库、财务都要看同一份可售数）
 *   写 —— admin / sales / warehouse（建批次、迁批次、检验、登记拣货）
 *   确认 —— admin / sales（**只有授权销售能把申请变成占用**）
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/supply');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'sales', 'warehouse'];
const CONFIRM = ['admin', 'sales'];

/** 服务层业务校验异常统一转 400 */
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
router.get('/dict', authRequired, requireRole(...READ), (req, res) => ok(res, S.dict()));
router.get('/overview', authRequired, requireRole(...READ), (req, res) => ok(res, S.overview()));
router.get('/report', authRequired, requireRole(...READ), (req, res) => ok(res, S.report(req.query)));

/** ==================== 可售投影（N23-01 / N23-06） ==================== */
router.get('/projection', authRequired, requireRole(...READ), (req, res) => ok(res, S.listProjection(req.query)));
router.post('/projection/refresh', authRequired, requireRole(...WRITE), guard((req) => S.refreshProjection(req.user, (req.body || {}).warehouse)));

/** ==================== 供给批次（N23-02 / N23-05） ==================== */
router.get('/batches', authRequired, requireRole(...READ), (req, res) => ok(res, S.listBatches(req.query)));
router.get('/batches/:id', authRequired, requireRole(...READ), guard((req) => S.getBatch(req.params.id)));
router.post('/batches', authRequired, requireRole(...WRITE), guard((req) => S.createBatch(req.body || {}, req.user)));
router.post('/batches/:id/move', authRequired, requireRole(...WRITE), guard((req) => S.moveBatch(req.params.id, req.body || {}, req.user)));
router.post('/batches/:id/split', authRequired, requireRole(...WRITE), guard((req) => S.splitBatch(req.params.id, req.body || {}, req.user)));
router.post('/batches/:id/short', authRequired, requireRole(...WRITE), guard((req) => S.recordShort(req.params.id, req.body || {}, req.user)));
router.post('/batches/:id/inspect', authRequired, requireRole(...WRITE, 'production'), guard((req) => S.inspectBatch(req.params.id, req.body || {}, req.user)));
router.delete('/batches/:id', authRequired, requireRole('admin'), guard((req) => S.deleteBatch(req.params.id, req.user)));

/** ==================== 预订申请（N23-03） ==================== */
router.get('/requests', authRequired, requireRole(...READ), (req, res) => ok(res, S.listRequests(req.query)));
router.get('/requests/:id', authRequired, requireRole(...READ), guard((req) => S.getRequest(req.params.id)));
router.post('/requests', authRequired, requireRole(...WRITE), guard((req) => S.createRequest(req.body || {}, req.user)));
router.post('/requests/expire', authRequired, requireRole(...WRITE), guard((req) => S.expireRequests(req.user)));
router.post('/requests/:id/confirm', authRequired, requireRole(...CONFIRM), guard((req) => S.confirmRequest(req.params.id, req.body || {}, req.user)));
router.post('/requests/:id/reject', authRequired, requireRole(...CONFIRM), guard((req) => S.rejectRequest(req.params.id, req.body || {}, req.user)));
router.post('/requests/:id/cancel', authRequired, requireRole(...WRITE), guard((req) => S.cancelRequest(req.params.id, req.body || {}, req.user)));
router.delete('/requests/:id', authRequired, requireRole('admin'), guard((req) => S.deleteRequest(req.params.id, req.user)));

/** ==================== 占用（N23-04） ==================== */
router.get('/holds', authRequired, requireRole(...READ), (req, res) => ok(res, S.listHolds(req.query)));
router.get('/holds/:id', authRequired, requireRole(...READ), guard((req) => S.getHold(req.params.id)));
router.post('/holds/expire', authRequired, requireRole(...WRITE), guard((req) => S.expireHolds(req.user)));
router.post('/holds/:id/release', authRequired, requireRole(...WRITE), guard((req) => S.releaseHold(req.params.id, req.body || {}, req.user)));
router.post('/holds/:id/picked', authRequired, requireRole(...WRITE), guard((req) => S.markPicked(req.params.id, req.body || {}, req.user)));
router.post('/holds/:id/convert', authRequired, requireRole(...WRITE), guard((req) => S.convertHold(req.params.id, req.body || {}, req.user)));

/** ==================== 缺口（N23-05） ==================== */
router.get('/shortages', authRequired, requireRole(...READ), (req, res) => ok(res, S.listShortages(req.query)));
router.post('/shortages/:id/resolve', authRequired, requireRole(...WRITE), guard((req) => S.resolveShortage(req.params.id, req.body || {}, req.user)));

module.exports = router;
