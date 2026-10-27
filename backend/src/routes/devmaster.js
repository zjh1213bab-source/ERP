/**
 * M05 研发立项与款式生命周期 + 商品 SKU 与配码包装主档 —— 路由
 * ============================================================
 * 权限：
 *   读 —— 全部业务角色（销售要看开发进度、仓库要看配码）
 *   建/改/推阶段/结案 —— admin / tech（技术部把口）
 *   里程碑登记 —— admin / tech / sales（销售接收与下单是销售的事）
 *   SKU 主档与配码 —— admin / tech（主数据不能随便改，改了就错库存）
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/devmaster');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'tech'];
const MS_WRITE = ['admin', 'tech', 'sales'];
const SKU_WRITE = ['admin', 'tech'];

function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      const code = e.code && Number.isInteger(e.code) ? e.code : 400;
      if (e.payload) return res.status(code).json({ ok: false, message: e.message, data: e.payload });
      return fail(res, code, e.message);
    }
  };
}

const opName = (req) =>
  (req.user && (req.user.name || req.user.username)) || String((req.user && (req.user.id || req.user.sub)) || 'system');

// ---------------- 基础 ----------------
router.get('/dict', authRequired, guard(() => S.dict()));

router.get('/board', authRequired, guard((req) => S.board(req.query || {})));

// ---------------- 研发立项 ----------------
router.get('/projects', authRequired, guard((req) => ({ rows: S.listProjects(req.query || {}) })));

router.get('/projects/:id', authRequired, guard((req) => S.projectDetail(req.params.id)));

router.post('/projects', authRequired, requireRole(...WRITE), guard((req) => S.createProject(req.body || {}, opName(req))));

router.patch('/projects/:id', authRequired, requireRole(...WRITE), guard((req) => S.updateProject(req.params.id, req.body || {})));

router.post('/projects/:id/stage', authRequired, requireRole(...WRITE), guard((req) => S.advanceStage(req.params.id, req.body || {})));

router.post('/projects/:id/milestone', authRequired, requireRole(...MS_WRITE), guard((req) => S.addMilestone(req.params.id, req.body || {}, opName(req))));

router.post('/projects/:id/tasks', authRequired, requireRole(...WRITE), guard((req) => S.addTask(req.params.id, req.body || {}, opName(req))));

router.post('/tasks/:id/status', authRequired, requireRole(...WRITE), guard((req) => S.setTaskStatus(req.params.id, req.body || {})));

router.post('/projects/:id/close', authRequired, requireRole(...WRITE), guard((req) => S.closeProject(req.params.id, req.body || {})));

// ---------------- SKU 主档 ----------------
router.get('/skus', authRequired, guard((req) => ({ rows: S.listSkus(req.query || {}) })));

router.get('/skus/:id', authRequired, guard((req) => S.skuDetail(req.params.id)));

router.post('/skus', authRequired, requireRole(...SKU_WRITE), guard((req) => S.createSku(req.body || {}, opName(req))));

router.patch('/skus/:id', authRequired, requireRole(...SKU_WRITE), guard((req) => S.updateSku(req.params.id, req.body || {})));

router.post('/skus/:id/alias', authRequired, requireRole(...SKU_WRITE), guard((req) => S.addAlias(req.params.id, req.body || {})));

router.post('/aliases/:id/disable', authRequired, requireRole(...SKU_WRITE), guard((req) => S.disableAlias(req.params.id, req.body || {})));

/** 套件换算：套 → 件（库存单位是件，换算不出来就不许动库存） */
router.get('/skus/:id/explode', authRequired, guard((req) => S.explode(req.params.id, req.query.qty || 1)));

// ---------------- 配码 / 箱规 ----------------
router.get('/packs/:id', authRequired, guard((req) => S.packDetail(req.params.id)));

router.post('/packs', authRequired, requireRole(...SKU_WRITE), guard((req) => S.createPackSpec(req.body || {}, opName(req))));

router.post('/packs/:id/activate', authRequired, requireRole(...SKU_WRITE), guard((req) => S.activatePackSpec(req.params.id, req.body || {})));

module.exports = router;
module.exports.READ = READ;
