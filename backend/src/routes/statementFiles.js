/**
 * 对账资料（内部 → 授权下发）
 * ========================================================================
 * 生成草稿 → 授权发布 → 客户下载 / 撤销失效。
 *
 * 为什么「发布」要单独一个动作而不是生成即对外：
 * 发出去的是**我们自己承认的账**。核对金额、看 warnings、确认期间，
 * 这些步骤漏一步，客户就会拿着错账来质问，而且我们没法解释「那是草稿」。
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const SF = require('../services/statementFile');

const router = express.Router();

const READ = ['admin', 'boss', 'finance', 'sales'];
// 对外承认一个数：只给财务与管理员。销售能看能生成，但不能自己拍板发出去
const PUBLISH = ['admin', 'finance'];

const actor = (req) => (req.user && (req.user.name || req.user.username)) || 'system';

router.get('/meta', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, {
  status: Object.entries(SF.STATUS).map(([code, label]) => ({ code, label })),
  kinds: Object.entries(SF.KIND).map(([code, label]) => ({ code, label }))
})));

router.get('/', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, SF.list(req.query || {}))));

router.post('/generate', authRequired, requireRole(...PUBLISH), wrap(async (req, res) =>
  ok(res, SF.generate(req.body || {}, actor(req)))));

router.get('/:id', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, SF.detail(req.params.id))));

router.post('/:id/publish', authRequired, requireRole(...PUBLISH), wrap(async (req, res) =>
  ok(res, SF.publish(req.params.id, req.body || {}, actor(req)))));

router.post('/:id/revoke', authRequired, requireRole(...PUBLISH), wrap(async (req, res) =>
  ok(res, SF.revoke(req.params.id, req.body || {}, actor(req)))));

/** 内部预览：业务先看一眼客户会拿到什么（不计入客户下载次数） */
router.get('/:id/preview.csv', authRequired, requireRole(READ), wrap(async (req, res) => {
  const d = SF.detail(req.params.id);
  const csv = SF.toCsv(d.snapshot || {});
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="preview-${d.file_no}.csv"`);
  return res.send(csv);
}));

module.exports = router;
