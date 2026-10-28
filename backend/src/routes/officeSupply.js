/**
 * 办公耗材与服务采购（内部）
 * ========================================================================
 * - `/api/office-supply/items`      物品档案与办公仓库存
 * - `/api/office-supply/requests`   申领单（三道闸：库存不足 / 重复领用 / 超月限额）
 * - `/api/office-supply/purchases`  采购单（物品 + 服务），验收时一次做完「入库 / 转资产 / 入费用」
 *
 * 权限三层：
 * - 看（全角色，申领是每个人的事）
 * - 申领与领用（除老板外都行；老板只读）
 * - 采购与档案（行政 / 财务 / 管理员）
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/officeSupply');

const router = express.Router();

const READ = ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];
// 申领是全员动作；老板只读（审批由行政/财务做）
const APPLY = ['admin', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];
// 采购会花钱、档案会影响全厂口径
const MANAGE = ['admin', 'hr', 'finance'];

const actor = (req) => (req.user && (req.user.name || req.user.username)) || 'system';

/* ---------------- 字典与看板 ---------------- */
router.get('/meta', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.dict())));

router.get('/board', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.board(req.query || {}))));

router.get('/low-stock', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.lowStock())));

router.get('/ledger', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.ledger(req.query || {}))));

/* ---------------- 物品档案 ---------------- */
router.post('/items', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.saveItem(req.body || {}, actor(req)))));

/* ---------------- 申领单 ---------------- */
router.get('/requests', authRequired, requireRole(READ), wrap(async (req, res) =>
  ok(res, S.listRequests(req.query || {}))));

router.get('/requests/:id', authRequired, requireRole(READ), wrap(async (req, res) =>
  ok(res, S.requestDetail(req.params.id))));

router.post('/requests', authRequired, requireRole(...APPLY), wrap(async (req, res) =>
  ok(res, S.saveRequest(req.body || {}, actor(req)))));

router.post('/requests/:id/submit', authRequired, requireRole(...APPLY), wrap(async (req, res) =>
  ok(res, S.submitRequest(req.params.id, actor(req)))));

router.post('/requests/:id/approve', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.approveRequest(req.params.id, req.body || {}, actor(req)))));

router.post('/requests/:id/reject', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.rejectRequest(req.params.id, req.body || {}, actor(req)))));

// 出库会真的扣库存 —— 仓库与行政都能发，但必须是已批准的单
router.post('/requests/:id/issue', authRequired, requireRole(...APPLY), wrap(async (req, res) =>
  ok(res, S.issueRequest(req.params.id, req.body || {}, actor(req)))));

router.post('/requests/:id/return', authRequired, requireRole(...APPLY), wrap(async (req, res) =>
  ok(res, S.returnRequest(req.params.id, req.body || {}, actor(req)))));

/* ---------------- 采购单 ---------------- */
router.get('/purchases', authRequired, requireRole(READ), wrap(async (req, res) =>
  ok(res, S.listPurchases(req.query || {}))));

router.get('/purchases/:id', authRequired, requireRole(READ), wrap(async (req, res) =>
  ok(res, S.purchaseDetail(req.params.id))));

router.post('/purchases', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.createPurchase(req.body || {}, actor(req)))));

router.put('/purchases/:id/prices', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.setPrices(req.params.id, req.body || {}, actor(req)))));

router.post('/purchases/:id/approve', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.approvePurchase(req.params.id, req.body || {}, actor(req)))));

router.post('/purchases/:id/order', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.orderPurchase(req.params.id, req.body || {}, actor(req)))));

// 验收：入库存 + 耐用品转资产 + 生成费用，一次做完
router.post('/purchases/:id/receive', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.receivePurchase(req.params.id, req.body || {}, actor(req)))));

router.post('/purchases/:id/cancel', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.cancelPurchase(req.params.id, req.body || {}, actor(req)))));

module.exports = router;
