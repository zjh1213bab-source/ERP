/**
 * 生产工序节点（order_nodes）—— 对齐衣创 node_list
 * GET   /api/order-nodes?order_id=
 * POST  /api/order-nodes/init { order_id }     初始化默认 13 道工序
 * GET   /api/order-nodes/:id/panel            点开这个节点的弹窗内容（按 panel 类型分化）
 * PATCH /api/order-nodes/:id { status, plan_date, actual_date, operator, remark }
 * DELETE /api/order-nodes/:id
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { ensureNodes } = require('../services/production');
const nodeFlow = require('../services/nodeFlow');
const nodePanel = require('../services/nodePanel');
const assignSvc = require('../services/orderAssign');
const scope = require('../access/companyScope');

/**
 * 工序节点没有自己的 `company_id` —— 它挂在订单上，归属一律按订单判。
 * 别家的节点一律当作不存在（404 而非 403：403 会泄露"这个 id 是真的"）。
 */
function nodeOr404(req, id) {
  const n = db.prepare('SELECT * FROM order_nodes WHERE id = ?').get(Number(id));
  if (!n) { const e = new Error('工序不存在'); e.status = 404; throw e; }
  if (!scope.assertOrder(req.user, n.order_id).ok) {
    const e = new Error('工序不存在'); e.status = 404; throw e;
  }
  return n;
}

/** 订单级守卫：看不到的订单当成不存在 */
function orderOr404(req, orderId) {
  const r = scope.assertOrder(req.user, orderId);
  if (!r.ok) { const e = new Error(r.reason); e.status = r.status; throw e; }
  return r.row;
}

const router = express.Router();
const WRITE = ['admin', 'production'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return fail(res, 400, '缺少 order_id');
  orderOr404(req, order_id);
  return ok(res, db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(order_id));
}));

/**
 * 点开一个格子看到什么
 *
 * 内容按节点的 `panel` 属性区分：采购类摊开物料需求明细，其余给备注、
 * 现场凭证与时间线。**样式和字段都在这一份数据里定**，前端只负责画，
 * 避免「看板一个样、手机端一个样」。
 */
router.get('/:id/panel', authRequired, wrap(async (req, res) => {
  const n = nodeOr404(req, req.params.id);
  return ok(res, nodePanel.panel(n.id));
}));

/**
 * 从看板上执行分配（本厂 / 整单外发 / 裁片外发）
 *
 * 分配在这套系统里的事实只有一个：`dispatch_orders`（分单表）。
 * 这里不新造字段，只把「点按钮」翻译成一条分单，然后把节点标完成。
 * 校验（财务审核、超量、必须选厂、覆盖整单才推进）全在 services/orderAssign，
 * 与分单页共用同一份实现。
 */
router.post('/:id/assign', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const n = nodeOr404(req, req.params.id);
  return ok(res, assignSvc.assign(n.id, req.body || {}, (req.user && req.user.username) || 'system'));
}));

router.post('/init', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const { order_id } = req.body || {};
  if (!order_id) return fail(res, 400, '缺少 order_id');
  orderOr404(req, order_id);   // 别家的订单不能初始化工序
  ensureNodes(order_id);
  return ok(res, db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(order_id));
}));

/**
 * 推进 / 编辑一个工序节点
 *
 * 逻辑放在 `services/nodeFlow.setNode`，这里只做转发 —— 因为「哪些状态能走、
 * 必经节点能不能标不适用」这类判断如果在这里再写一份，必然出现
 * 「看板能标、订单详情不能标」这种两套行为。
 *
 * 顺带修掉一个真问题：原来这里的状态白名单是 `['pending','doing','done']`，
 * 没有 `skipped`，于是「这单不做水洗」只能被标成「已完成」—— 等于教人作假。
 */
router.patch('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  /**
   * `actor` 是**谁在操作**，与 `operator`（这一工序的责任人）不是一回事：
   * 跟单把节点标成已完成时，责任人仍然是车间的张师傅。
   * 时间线要记的是前者，否则「已完成」会显示成「张师傅标的」，查不到真凶。
   */
  const n = nodeOr404(req, req.params.id);
  const body = Object.assign({}, req.body || {}, { actor: (req.user && req.user.username) || null });
  return ok(res, nodeFlow.setNode(n.id, body));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const n = nodeOr404(req, req.params.id);
  db.prepare('DELETE FROM order_nodes WHERE id = ?').run(n.id);
  return ok(res, { id: n.id });
}));

module.exports = router;
