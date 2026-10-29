/**
 * 工序流程模板（节点可自定义）
 * ========================================================================
 * GET    /api/node-flow/templates                 流程列表
 * GET    /api/node-flow/templates/:id             流程详情（含节点）
 * POST   /api/node-flow/templates                 新建流程          node.flow
 * PUT    /api/node-flow/templates/:id             改流程            node.flow
 * POST   /api/node-flow/templates/:id/default     设为默认          node.flow
 * POST   /api/node-flow/templates/:id/items       新增节点          node.flow
 * PUT    /api/node-flow/items/:id                 改节点            node.flow
 * POST   /api/node-flow/items/:id/status          停用 / 恢复节点   node.flow
 * POST   /api/node-flow/templates/:id/reorder     调整节点顺序      node.flow
 * POST   /api/node-flow/templates/:id/apply       应用到已有订单    node.flow
 * GET    /api/node-flow/board                     订单跟踪看板      登录即可
 * GET    /api/node-flow/builtin                   内置节点 code 清单 登录即可
 *
 * ## 为什么不复用 /api/order-nodes
 *
 * `/api/order-nodes` 管的是**某一张订单的节点**（推进、改日期、填责任人），
 * 是日常操作，production 角色天天用。这里管的是**模板**（改一次影响所有新单），
 * 是配置级改动。两者权限不同、误操作代价不同，混在一个路由里迟早会
 * 「只想点一下进度，结果把模板改了」。
 *
 * 推进节点仍然走原来的 `PATCH /api/order-nodes/:id`，看板调用它。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const svc = require('../services/nodeFlow');

const router = express.Router();
const WRITE = ['admin', 'production'];

/* ---------------- 模板 ---------------- */
router.get('/templates', authRequired, wrap(async (req, res) => ok(res, svc.listTemplates())));

router.get('/templates/:id', authRequired, wrap(async (req, res) => ok(res, svc.getTemplate(req.params.id))));

router.post('/templates', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, svc.saveTemplate({ ...(req.body || {}), operator: req.user.username }))));

router.put('/templates/:id', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, svc.saveTemplate({ ...(req.body || {}), id: req.params.id }))));

router.post('/templates/:id/default', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, svc.setDefault(req.params.id))));

/* ---------------- 节点 ---------------- */
router.post('/templates/:id/items', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, svc.saveItem(req.params.id, req.body || {}))));

router.put('/items/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT template_id FROM node_template_items WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '节点不存在');
  return ok(res, svc.saveItem(row.template_id, { ...(req.body || {}), id: req.params.id }));
}));

router.post('/items/:id/status', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const body = req.body || {};
  if (!['active', 'off'].includes(String(body.status))) return fail(res, 400, 'status 只能是 active 或 off');
  return ok(res, svc.setItemStatus(req.params.id, String(body.status)));
}));

router.post('/templates/:id/reorder', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, svc.reorder(req.params.id, (req.body || {}).ids))));

/**
 * 应用到已有订单
 *
 * `dry_run` 默认 **true**：这个动作会给一批订单写节点，
 * 默认必须先看「会往哪些单补哪些节点」再按确认 —— 和后端其他批量动作一致。
 */
router.post('/templates/:id/apply', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const dryRun = b.dry_run === undefined ? true : !!b.dry_run;
  return ok(res, svc.applyToOrders(req.params.id, { orderIds: b.order_ids || null, dryRun }));
}));

/* ---------------- 看板 ---------------- */
router.get('/board', authRequired, wrap(async (req, res) => ok(res, svc.board({
    // 主体过滤值：单公司模式下恒为 null（不过滤）—— 见 access/companyScope.js 的 of()。
    // 多主体模式下才是"分部只列自己、集团角色看全集团"。
    companyId: require('../access/companyScope').filterCompanyId(req.user),
  templateId: req.query.template_id || null,
  status: req.query.status || '',
  q: req.query.q || '',
  limit: req.query.limit || 200,
  customerId: req.query.customer_id || null,
  manager: req.query.manager || '',
  orderFrom: req.query.order_from || '',
  orderTo: req.query.order_to || '',
  orderFrom: req.query.order_from || '',
  orderTo: req.query.order_to || '',
  dueFrom: req.query.due_from || '',
  dueTo: req.query.due_to || '',
  // 查询串里传 "1"/"0"：`!!'0'` 是 true，这里显式比字符串
  overdue: String(req.query.overdue || '') === '1',
  noDue: String(req.query.no_due || '') === '1',
  dueSoon: String(req.query.due_soon || '') === '1',
  nodeCode: req.query.node_code || '',
  nodeStatus: req.query.node_status || '',
  sort: req.query.sort || 'due'
}))));

router.get('/builtin', authRequired, wrap(async (req, res) => ok(res, {
  codes: svc.BUILTIN_CODES,
  order: svc.BUILTIN_ORDER
})));

module.exports = router;
