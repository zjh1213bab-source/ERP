/**
 * M05-06 供方信息协同与技术再次审核 —— 路由
 * ============================================================
 * 权限：
 *   读 —— 全部业务角色（销售要知道技术包卡在哪、采购要看供货条件）
 *   A1 分工 / A2 供方确认 —— admin / tech
 *   A3 技术复审 —— admin / tech
 *   核准技术包    —— admin / tech（技术部把口）
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/supreview');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'tech'];

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

router.get('/dict', authRequired, guard(() => S.dict()));

router.get('/board', authRequired, guard((req) => S.board(req.query || {})));

router.get('/options', authRequired, guard(() => S.options()));

router.get('/packs/:techPackId', authRequired, guard((req) => S.packDetail(req.params.techPackId)));

// A1 技术处理与制版分工
router.post('/packs/:techPackId/assignment', authRequired, requireRole(...WRITE),
  guard((req) => S.saveAssignment(req.params.techPackId, req.body || {}, opName(req))));
router.post('/packs/:techPackId/assignment/confirm', authRequired, requireRole(...WRITE),
  guard((req) => S.confirmAssignment(req.params.techPackId, opName(req))));

// A2 供方确认（有版本）
router.post('/packs/:techPackId/confirms', authRequired, requireRole(...WRITE),
  guard((req) => S.createConfirm(req.params.techPackId, req.body || {}, opName(req))));
router.post('/confirms/:id/cancel', authRequired, requireRole(...WRITE),
  guard((req) => S.cancelConfirm(req.params.id, req.body || {})));
router.post('/confirms/:id/confirm', authRequired, requireRole(...WRITE),
  guard((req) => S.confirmSupplierConfirm(req.params.id, opName(req))));

// A3 技术复审
router.post('/packs/:techPackId/reviews', authRequired, requireRole(...WRITE),
  guard((req) => S.createReview(req.params.techPackId, req.body || {}, opName(req))));

// 核准技术包
router.post('/packs/:techPackId/approve', authRequired, requireRole(...WRITE),
  guard((req) => S.approvePack(req.params.techPackId, req.body || {}, opName(req))));

module.exports = router;
module.exports.READ = READ;
