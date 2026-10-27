/**
 * M12 长期投资抵消 —— 路由
 * ============================================================
 * 权限：
 *   读 —— 财务 / 管理员 / 销售（销售看合并口径）
 *   维护投资、记变动、改核算方法、处置 —— admin / finance
 *   抵消预览 —— 全部业务角色（解释「为什么合并数不等于相加」）
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const IV = require('../services/investment');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'finance'];

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

router.get('/dict', authRequired, guard(() => IV.dict()));

router.get('/board', authRequired, guard(() => IV.board()));

router.get('/list', authRequired, guard((req) => ({ rows: IV.list(req.query || {}) })));

router.get('/:id', authRequired, guard((req) => {
  const d = IV.detail(req.params.id);
  if (!d) throw new Error('长期投资记录不存在');
  return d;
}));

router.post('/', authRequired, requireRole(...WRITE), guard((req) => IV.create(req.body || {}, opName(req))));

router.post('/:id/changes', authRequired, requireRole(...WRITE), guard((req) =>
  IV.addChange(req.params.id, req.body || {}, opName(req))));

router.post('/:id/method', authRequired, requireRole(...WRITE), guard((req) =>
  IV.updateMethod(req.params.id, (req.body || {}).method, (req.body || {}).reason, opName(req))));

router.post('/:id/dispose', authRequired, requireRole(...WRITE), guard((req) =>
  IV.dispose(req.params.id, (req.body || {}).reason, opName(req))));

/** 抵消预览：某期间每家长投怎么抵、商誉多少、少数股东权益多少（不落库） */
router.get('/offsets/:period', authRequired, guard((req) => IV.computeOffsets(req.params.period)));

/** 子公司权益明细（抵消的依据） */
router.get('/equity/:period/:companyId', authRequired, guard((req) =>
  IV.equityOf(req.params.period, Number(req.params.companyId))));

module.exports = router;
