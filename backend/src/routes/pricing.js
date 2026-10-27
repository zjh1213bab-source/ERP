/**
 * M11 价格快照与费用池 —— 路由
 * ============================================================
 * 权限：
 *   读 —— 全部业务角色（销售要查价，生产要看成本）
 *   费用池维护与分摊 —— admin / finance（钱怎么摊是财务把口）
 *   价格本维护与发布 —— admin / finance / sales（定价是销售 + 财务共同决定，发布即冻结）
 *   **费用池撤销** —— 只给 admin / finance（撤销会回滚成本对象）
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const P = require('../services/pricing');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'finance'];
const PRICE = ['admin', 'finance', 'sales'];

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

/* ==================== 字典与总览 ==================== */

router.get('/dict', authRequired, guard(() => P.dict()));

router.get('/board', authRequired, guard((req) => ({
  pools: P.poolBoard(req.query || {}),
  books: P.bookBoard()
})));

/* ==================== 费用池 ==================== */

router.get('/pools', authRequired, guard((req) => ({ rows: P.poolList(req.query || {}) })));

router.get('/pools/:id', authRequired, guard((req) => {
  const d = P.poolDetail(req.params.id);
  if (!d) throw new Error('费用池不存在');
  return d;
}));

/** 分摊预览：只算不落库 */
router.get('/pools/:id/preview', authRequired, guard((req) => P.previewPool(req.params.id)));

router.post('/pools', authRequired, requireRole(...WRITE), guard((req) => P.createPool(req.body || {}, opName(req))));

router.post('/pools/:id/expenses', authRequired, requireRole(...WRITE), guard((req) =>
  P.addExpense(req.params.id, req.body || {}, opName(req))));

router.delete('/expenses/:id', authRequired, requireRole(...WRITE), guard((req) => P.removeExpense(req.params.id, opName(req))));

router.post('/pools/:id/distribute', authRequired, requireRole(...WRITE), guard((req) =>
  P.distributePool(req.params.id, req.body || {}, opName(req))));

router.post('/pools/:id/revert', authRequired, requireRole(...WRITE), guard((req) =>
  P.revertPool(req.params.id, (req.body || {}).reason, opName(req))));

router.post('/pools/:id/close', authRequired, requireRole(...WRITE), guard((req) => P.closePool(req.params.id, opName(req))));

/* ==================== 价格本 ==================== */

router.get('/books', authRequired, guard((req) => ({ rows: P.bookList(req.query || {}) })));

router.get('/books/:id', authRequired, guard((req) => {
  const d = P.bookDetail(req.params.id);
  if (!d) throw new Error('价格本不存在');
  return d;
}));

router.post('/books', authRequired, requireRole(...PRICE), guard((req) => P.createBook(req.body || {}, opName(req))));

router.post('/books/:id/items', authRequired, requireRole(...PRICE), guard((req) =>
  P.upsertItem(req.params.id, req.body || {}, opName(req))));

router.delete('/items/:id', authRequired, requireRole(...PRICE), guard((req) => P.removeItem(req.params.id)));

router.post('/books/:id/publish', authRequired, requireRole(...PRICE), guard((req) =>
  P.publishBook(req.params.id, req.body || {}, opName(req))));

router.post('/books/:id/archive', authRequired, requireRole(...PRICE), guard((req) =>
  P.archiveBook(req.params.id, (req.body || {}).reason, opName(req))));

/* ==================== 取价 ==================== */

router.get('/quote', authRequired, guard((req) => P.quote(req.query || {})));

/** 某款的成本口径：定价前先看成本从哪来 */
router.get('/cost/:styleNo', authRequired, guard((req) => {
  const c = P.styleCost(req.params.styleNo);
  return { style_no: req.params.styleNo, cost_unit: c.cost, source: c.source,
    source_label: c.source === 'cost_object' ? '成本对象（实际成本/件）' : (c.source === 'cost_sheet' ? '核价成本单' : '取不到成本'),
    found: c.cost !== null };
}));

module.exports = router;
