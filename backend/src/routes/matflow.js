/**
 * M10 备料领退与盘点差异 —— 路由
 * ============================================================
 * 权限：
 *   读 —— 全部业务角色（车间、销售、财务都要看欠料）
 *   备料/发料/退料/盘点 —— admin / warehouse / production
 *   盘点调账（会改库存）—— admin / warehouse（生产不能自己把账调平）
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/matflow');
const scope = require('../access/companyScope');

/**
 * 当前用户能看/能操作的主体（null = 集团角色，不过滤）
 *
 * 库存这域分两层：**实物存量不分主体**（一个仓里有多少，见 services/matflow 顶部说明），
 * **单据按主体**（领料单 / 退料单 / 盘点单都带 company_id）。
 */
const cidOf = (req) => scope.filterCompanyId(req.user);

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'warehouse', 'production'];
const ADJUST = ['admin', 'warehouse'];

/** 统一错误出口；业务错误一律 400，带 payload 的原样带出 */
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

/** 业务错误带 404：跨主体与不存在给同一个回答 */
const notFoundErr = (msg) => {
  const e = new Error(msg || '不存在');
  e.code = 404;
  return e;
};

const opName = (req) =>
  (req.user && (req.user.name || req.user.username)) || String((req.user && (req.user.id || req.user.sub)) || 'system');

/* ==================== 字典与总览 ==================== */

router.get('/dict', authRequired, guard(() => S.dict()));

router.get('/board', authRequired, guard((req) => S.board(req.query || {})));

router.get('/stock', authRequired, guard((req) => {
  const rows = S.stockList(req.query || {});
  return {
    rows,
    stat: {
      total: rows.length,
      zero: rows.filter((r) => r.stock_qty <= S.EPS).length,
      negative: rows.filter((r) => r.neg).length,
      reserved: S.r2(rows.reduce((s, r) => s + r.reserved, 0)),
      shortage: rows.filter((r) => r.available < -S.EPS).length
    }
  };
}));

router.get('/ledger', authRequired, guard((req) => ({ rows: S.ledger(req.query || {}) })));

/* ==================== 备料 / 领料 ==================== */

/** 订单用料建议（含可用量与缺口） */
router.get('/issues/suggest', authRequired, guard((req) => {
  const orderId = Number((req.query || {}).order_id);
  const ord = scope.assertOrder(req.user, orderId);
  if (!ord.ok) throw notFoundErr(ord.reason);
  return S.suggestFromOrder(orderId);
}));

router.get('/issues', authRequired, guard((req) => ({ rows: S.listIssues({ ...(req.query || {}), companyId: cidOf(req) }) })));

router.get('/issues/:id', authRequired, guard((req) => {
  const d = S.issueDetail(req.params.id, cidOf(req));
  if (!d) throw notFoundErr('备料单不存在');
  return d;
}));

router.post('/issues', authRequired, requireRole(...WRITE), guard((req) => S.createIssue(req.body || {}, opName(req), cidOf(req))));

router.post('/issues/:id/prepare', authRequired, requireRole(...WRITE), guard((req) => S.prepareIssue(req.params.id, opName(req), cidOf(req))));

router.post('/issues/:id/issue', authRequired, requireRole(...WRITE), guard((req) => S.issueOut(req.params.id, req.body || {}, opName(req), cidOf(req))));

router.post('/issues/:id/close', authRequired, requireRole(...WRITE), guard((req) => S.closeIssue(req.params.id, (req.body || {}).note, opName(req), cidOf(req))));

router.post('/issues/:id/cancel', authRequired, requireRole(...WRITE), guard((req) => S.cancelIssue(req.params.id, (req.body || {}).reason, opName(req), cidOf(req))));

/* ==================== 退料 ==================== */

router.get('/returns', authRequired, guard((req) => ({ rows: S.listReturns({ ...(req.query || {}), companyId: cidOf(req) }) })));

router.get('/returns/:id', authRequired, guard((req) => {
  const d = S.returnDetail(req.params.id, cidOf(req));
  if (!d) throw notFoundErr('退料单不存在');
  return d;
}));

router.post('/returns', authRequired, requireRole(...WRITE), guard((req) => S.createReturn(req.body || {}, opName(req), cidOf(req))));

router.post('/returns/:id/confirm', authRequired, requireRole(...WRITE), guard((req) => S.confirmReturn(req.params.id, opName(req), cidOf(req))));

/* ==================== 盘点 ==================== */

router.get('/stocktakes', authRequired, guard((req) => ({ rows: S.listStocktakes({ ...(req.query || {}), companyId: cidOf(req) }) })));

router.get('/stocktakes/:id', authRequired, guard((req) => {
  const d = S.stocktakeDetail(req.params.id, cidOf(req));
  if (!d) throw notFoundErr('盘点单不存在');
  return d;
}));

router.post('/stocktakes', authRequired, requireRole(...WRITE), guard((req) => S.createStocktake(req.body || {}, opName(req), cidOf(req))));

router.post('/stocktakes/:id/start', authRequired, requireRole(...WRITE), guard((req) => S.startCount(req.params.id, opName(req), cidOf(req))));

router.post('/stocktakes/:id/count', authRequired, requireRole(...WRITE), guard((req) => S.saveCount(req.params.id, req.body || {}, cidOf(req))));

router.post('/stocktakes/:id/submit', authRequired, requireRole(...WRITE), guard((req) => S.submitStocktake(req.params.id, req.body || {}, opName(req), cidOf(req))));

/** 落账会改库存：只给仓库/管理员 */
router.post('/stocktakes/:id/adjust', authRequired, requireRole(...ADJUST), guard((req) => S.adjustStocktake(req.params.id, opName(req), cidOf(req))));

router.post('/stocktakes/:id/cancel', authRequired, requireRole(...WRITE), guard((req) => S.cancelStocktake(req.params.id, (req.body || {}).reason, opName(req), cidOf(req))));

/* ==================== 订单侧联动 ==================== */

/** 某订单的领料进度（给订单详情/齐套页用） */

router.get('/order/:id', authRequired, guard((req) => {
  const orderId = Number(req.params.id);
  // 别家的订单在这里就是 404（与订单域同一口径）
  const ord = scope.assertOrder(req.user, orderId);
  if (!ord.ok) throw notFoundErr(ord.reason);
  const o = db.prepare('SELECT id, order_no, style_name, status FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new Error('订单不存在');
  const issues = db.prepare(
    `SELECT id, issue_no, kind, status, req_qty, issued_qty, amount, req_date, created_at
     FROM material_issues WHERE order_id = ? AND status <> 'cancelled' ORDER BY id DESC`
  ).all(orderId);
  const reqQty = S.r2(issues.reduce((s, x) => s + S.num(x.req_qty), 0));
  const issuedQty = S.r2(issues.reduce((s, x) => s + S.num(x.issued_qty), 0));
  return {
    order: o,
    issues,
    req_qty: reqQty,
    issued_qty: issuedQty,
    open_qty: S.r2(Math.max(0, reqQty - issuedQty)),
    suggest: (() => { try { return S.suggestFromOrder(orderId); } catch (e) { return null; } })()
  };
}));

module.exports = router;
