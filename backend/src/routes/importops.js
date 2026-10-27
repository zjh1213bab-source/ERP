/**
 * 上线准备：真实数据导入 —— 路由
 * ============================================================
 * 权限：读（看模板与历史）所有业务角色；预览 admin/finance/sales/tech/warehouse；
 *       提交（会写库）admin / finance
 * 说明：期初库存会动库存与流水，所以提交只放 admin 与财务，业务角色只能预览。
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/importOps');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const PREVIEW = ['admin', 'finance', 'sales', 'tech', 'warehouse'];
const COMMIT = ['admin', 'finance'];

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

router.get('/types', authRequired, guard(() => ({ types: S.typeList() })));

router.get('/template/:type', authRequired, (req, res) => {
  try {
    const csv = S.template(req.params.type);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-${req.params.type}.csv"`);
    return res.send(csv);
  } catch (e) {
    return fail(res, 404, e.message);
  }
});

router.post('/preview', authRequired, requireRole(...PREVIEW),
  guard((req) => S.preview(req.body && req.body.type, req.body && req.body.csv)));

router.post('/commit', authRequired, requireRole(...COMMIT),
  guard((req) => {
    const b = req.body || {};
    return S.commit(b.type, b.csv, b.opts || b, opName(req));
  }));

router.get('/batches', authRequired, guard((req) => ({ rows: S.batches(req.query || {}) })));

router.get('/batches/:id', authRequired, guard((req) => S.batchDetail(req.params.id)));

module.exports = router;
module.exports.READ = READ;
