/**
 * 美仓作业计划（原型 M19：拣货波次 / 跨境头程 / 库容规划）
 * ============================================================
 * 权限：
 *   读 —— 全部业务角色
 *   写 —— admin / warehouse / sales（建波次、拣货、复核、登记段与箱）
 *   交承运 / 取消 —— admin / warehouse（**发货与回滚由仓库把口**）
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const W = require('../services/whplan');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'warehouse', 'sales'];
const SHIP = ['admin', 'warehouse'];

function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      fail(res, 400, e.message);
    }
  };
}

/** ==================== 字典与概览 ==================== */
router.get('/dict', authRequired, requireRole(...READ), (req, res) => ok(res, W.dict()));
router.get('/overview', authRequired, requireRole(...READ), (req, res) => ok(res, W.overview()));

/** ==================== 拣货波次（N19-04） ==================== */
router.get('/waves', authRequired, requireRole(...READ), (req, res) => ok(res, W.listWaves(req.query)));
router.get('/candidates', authRequired, requireRole(...READ), (req, res) => ok(res, W.listCandidates(req.query)));
router.get('/waves/:id', authRequired, requireRole(...READ), guard((req) => W.getWave(req.params.id)));
router.post('/waves', authRequired, requireRole(...WRITE), guard((req) => W.createWave(req.body || {}, req.user)));
router.post('/waves/:id/release', authRequired, requireRole(...WRITE), guard((req) => W.releaseWave(req.params.id, req.user)));
router.post('/waves/:id/items/:itemId/pick', authRequired, requireRole(...WRITE),
  guard((req) => W.pickItem(req.params.id, req.params.itemId, req.body || {}, req.user)));
router.post('/waves/:id/pack', authRequired, requireRole(...WRITE),
  guard((req) => W.packWave(req.params.id, req.body || {}, req.user)));
router.post('/waves/:id/ship', authRequired, requireRole(...SHIP), guard((req) => W.shipWave(req.params.id, req.user)));
router.post('/waves/:id/cancel', authRequired, requireRole(...SHIP),
  guard((req) => W.cancelWave(req.params.id, req.body || {}, req.user)));
router.delete('/waves/:id', authRequired, requireRole('admin'), guard((req) => W.deleteWave(req.params.id, req.user)));

/** ==================== 跨境头程（N19-02） ==================== */
router.get('/asns', authRequired, requireRole(...READ), (req, res) => ok(res, W.listAsns(req.query)));
router.get('/asns/:id', authRequired, requireRole(...READ), guard((req) => W.getAsn(req.params.id)));
router.post('/asns/:id/legs', authRequired, requireRole(...WRITE), guard((req) => W.addLeg(req.params.id, req.body || {}, req.user)));
router.post('/legs/:legId/arrive', authRequired, requireRole(...WRITE),
  guard((req) => W.arriveLeg(req.params.legId, req.body || {}, req.user)));
router.post('/asns/:id/boxes', authRequired, requireRole(...WRITE), guard((req) => W.addBox(req.params.id, req.body || {}, req.user)));
router.post('/asns/:id/eta', authRequired, requireRole(...WRITE), guard((req) => W.changeEta(req.params.id, req.body || {}, req.user)));

/** ==================== 库容规划 ==================== */
router.get('/capacity', authRequired, requireRole(...READ), (req, res) => ok(res, W.listCapacity(req.query)));
router.get('/suggest', authRequired, requireRole(...READ), guard((req) => W.suggestCapacity(req.query)));

module.exports = router;
