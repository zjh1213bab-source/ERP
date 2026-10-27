/**
 * M07 裁片外发与外协验货交接 —— 路由
 * ============================================================
 * 权限：
 *   读 —— 全部业务角色（跟单、采购、财务都要看外协进度）
 *   建单/发出/回货验收/结案 —— admin / production / warehouse
 *   取消 —— admin / production
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/cutdispatch');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'production', 'warehouse'];

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

/** 某裁剪单的可外发扎与上限 */
router.get('/suggest/:cutOrderId', authRequired, guard((req) => S.dispatchSuggest(req.params.cutOrderId)));

router.get('/list', authRequired, guard((req) => ({ rows: S.list(req.query || {}) })));

router.get('/:id', authRequired, guard((req) => {
  const d = S.detail(req.params.id);
  if (!d) throw new Error('外发单不存在');
  return d;
}));

router.post('/', authRequired, requireRole(...WRITE), guard((req) => S.create(req.body || {}, opName(req))));

router.post('/:id/send', authRequired, requireRole(...WRITE), guard((req) => S.send(req.params.id, opName(req))));

router.post('/:id/receive', authRequired, requireRole(...WRITE), guard((req) =>
  S.receive(req.params.id, req.body || {}, opName(req))));

router.post('/:id/close', authRequired, requireRole(...WRITE), guard((req) =>
  S.close(req.params.id, req.body || {}, opName(req))));

router.post('/:id/cancel', authRequired, requireRole(...WRITE), guard((req) =>
  S.cancel(req.params.id, (req.body || {}).reason, opName(req))));

module.exports = router;
