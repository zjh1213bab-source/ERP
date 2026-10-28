/**
 * 售后与对账资料（内部）
 * ========================================================================
 * - `/api/after-sales`      售后单：客户提的（也支持内部代提）、受理、退款、追偿、结案
 * - `/api/statement-files`  对账文件：生成草稿 → 授权发布 → 撤销
 *
 * 权限分两层：
 * - 受理与结案（会改客户可见状态、会生成退货单）→ `aftersale.write`
 * - 登记退款（动钱）→ `aftersale.refund`，只给财务与管理员
 * - 对账文件授权发布（对外承认某个数）→ `statementfile.publish`，只给财务与管理员
 */
const express = require('express');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const AS = require('../services/afterSale');

const router = express.Router();

const READ = ['admin', 'boss', 'sales', 'quality', 'production', 'warehouse', 'finance'];
const WRITE = ['admin', 'sales', 'quality', 'production', 'warehouse'];
const MONEY = ['admin', 'finance'];
const actor = (req) => (req.user && (req.user.name || req.user.username)) || 'system';

/* -------------------------------------------------------------------- *
 * 售后单
 * -------------------------------------------------------------------- */
router.get('/meta', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, AS.dict())));

router.get('/stats', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, AS.stats())));

router.get('/', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, AS.list(req.query || {}))));

/** 内部代提（客户打电话来投诉，业务替客户开单） */
router.post('/', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const r = AS.submit({
    customerId: null,
    customerName: b.customer_name,
    source: 'internal',
    body: { ...b, demo_tag: b.demo_tag },
    operator: actor(req)
  });
  ok(res, r);
}));

router.get('/:id', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, AS.detail(req.params.id))));

router.post('/:id/accept', authRequired, requireRole(...WRITE), wrap(async (req, res) =>
  ok(res, AS.accept(req.params.id, req.body || {}, actor(req)))));

router.post('/:id/reject', authRequired, requireRole(...WRITE), wrap(async (req, res) =>
  ok(res, AS.reject(req.params.id, req.body || {}, actor(req)))));

// 动钱：只给财务与管理员。
// 路径单独一段 `/refund/:id` 而不是 `/:id/refund` —— GUARDED 是前缀匹配，
// 独立段才能精确挂锁，不会把受理/结案一起锁成「只有财务能点」。
router.post('/refund/:id', authRequired, requireRole(...MONEY), wrap(async (req, res) =>
  ok(res, AS.refund(req.params.id, req.body || {}, actor(req)))));

router.post('/:id/recovery', authRequired, requireRole(...WRITE), wrap(async (req, res) =>
  ok(res, AS.recovery(req.params.id, req.body || {}, actor(req)))));

router.post('/:id/settle', authRequired, requireRole(...WRITE), wrap(async (req, res) =>
  ok(res, AS.settle(req.params.id, req.body || {}, actor(req)))));

router.post('/:id/cancel', authRequired, requireRole(...WRITE), wrap(async (req, res) =>
  ok(res, AS.cancel(req.params.id, req.body || {}, actor(req)))));

router.post('/:id/note', authRequired, requireRole(...WRITE), wrap(async (req, res) =>
  ok(res, AS.note(req.params.id, req.body || {}, actor(req)))));

/* 对账文件走独立前缀 `/api/statement-files`（见 routes/statementFiles.js）——
 * 挂在售后单下面会让 URL 变成 `/api/after-sales/statements/1`，
 * 语义上对账跟售后是两件事，只是同一个交付节点。 */

module.exports = router;

