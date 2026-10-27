/**
 * 组织编制与岗位管理（原型 M02）
 * ============================================================
 * 四块：岗位与编制 / 任职关系 / 交易路线 / 主体视图授权。
 *
 * 权限：
 *   读 —— 全部业务角色（组织架构本来就该人人可见）
 *   写 —— sales（人事挂在 sales 角色下）、admin
 *   批 —— admin / finance（总经办、财务把「不能自批」这道关）
 */
const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const O = require('../services/org');

const router = express.Router();
const READ = ['admin', 'boss', 'sales', 'tech', 'finance', 'production', 'warehouse', 'hr'];
const WRITE = ['admin', 'hr'];
const APPROVE = ['admin', 'finance'];

const operatorOf = (req) => (req.user && (req.user.name || req.user.username)) || 'system';
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/** 服务层的业务校验异常统一转 400 */
function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      fail(res, 400, e.message);
    }
  };
}

/** ==================== 字典与汇总 ==================== */
router.get('/dict', authRequired, requireRole(...READ), (req, res) => ok(res, O.dict()));
router.get('/overview', authRequired, requireRole(...READ), (req, res) => ok(res, O.overview()));

/** 当前账号自己的数据范围（前端用来决定显示哪些公司/字段） */
router.get('/my-scope', authRequired, (req, res) => ok(res, O.scopeOf(req.user)));

/** ==================== 岗位与编制 ==================== */
router.get('/positions', authRequired, requireRole(...READ), (req, res) => {
  ok(res, O.listPositions({
    company_id: num(req.query.company_id),
    department_id: num(req.query.department_id),
    status: req.query.status,
    sequence: req.query.sequence,
    q: req.query.q
  }));
});
router.get('/positions/tree', authRequired, requireRole(...READ), (req, res) => {
  ok(res, O.positionTree(num(req.query.company_id) || undefined));
});
router.get('/positions/:id', authRequired, requireRole(...READ), (req, res) => {
  const p = O.getPosition(req.params.id);
  if (!p) return fail(res, 404, '岗位不存在');
  ok(res, p);
});
router.post('/positions', authRequired, requireRole(...WRITE), guard((req) => O.createPosition(req.body || {}, operatorOf(req))));
router.put('/positions/:id', authRequired, requireRole(...WRITE), guard((req) => O.updatePosition(req.params.id, req.body || {}, operatorOf(req))));

/** ==================== 任职关系 ==================== */
router.get('/employments', authRequired, requireRole(...READ), (req, res) => {
  ok(res, O.listEmployments({
    status: req.query.status,
    company_id: num(req.query.company_id),
    employee_id: num(req.query.employee_id),
    position_id: num(req.query.position_id),
    q: req.query.q
  }));
});
router.get('/employments/:id', authRequired, requireRole(...READ), (req, res) => {
  const e = O.getEmployment(req.params.id);
  if (!e) return fail(res, 404, '任职不存在');
  ok(res, e);
});
/** 新任职（含新入职、外派） */
router.post('/employments', authRequired, requireRole(...WRITE), guard((req) => O.draftEmployment(req.body || {}, operatorOf(req))));
/** 调岗：旧任职在新任职批准时自动结束，避免「旧的关了新的没批」的空窗 */
router.post('/employees/:id/transfer', authRequired, requireRole(...WRITE), guard((req) => O.draftTransfer(req.params.id, req.body || {}, operatorOf(req))));
router.post('/employments/:id/submit', authRequired, requireRole(...WRITE), guard((req) => O.submitEmployment(req.params.id)));
router.post('/employments/:id/approve', authRequired, requireRole(...APPROVE), guard((req) => O.approveEmployment(req.params.id, req.body || {}, operatorOf(req))));
router.post('/employments/:id/reject', authRequired, requireRole(...APPROVE), guard((req) => O.rejectEmployment(req.params.id, req.body || {}, operatorOf(req))));
router.post('/employments/:id/end', authRequired, requireRole(...WRITE, ...APPROVE), guard((req) => O.endEmployment(req.params.id, req.body || {}, operatorOf(req))));

/** ==================== 交易路线 ==================== */
router.get('/routes', authRequired, requireRole(...READ), (req, res) => {
  ok(res, O.listRoutes({ status: req.query.status, biz_type: req.query.biz_type }));
});
router.get('/routes/:id', authRequired, requireRole(...READ), (req, res) => {
  const r = O.getRoute(req.params.id);
  if (!r) return fail(res, 404, '路线不存在');
  ok(res, r);
});
router.post('/routes', authRequired, requireRole(...WRITE, 'finance'), guard((req) => O.createRoute(req.body || {}, operatorOf(req))));
router.put('/routes/:id', authRequired, requireRole(...WRITE, 'finance'), guard((req) => O.updateRoute(req.params.id, req.body || {})));
router.post('/routes/:id/confirm', authRequired, requireRole(...APPROVE), guard((req) => O.confirmRoute(req.params.id, req.body || {})));
router.post('/routes/:id/status', authRequired, requireRole(...APPROVE), guard((req) => O.setRouteStatus(req.params.id, req.body || {})));

/** ==================== 主体视图与授权范围 ==================== */
router.get('/scopes', authRequired, requireRole(...READ), (req, res) => {
  ok(res, O.listScopes({ status: req.query.status, user_id: num(req.query.user_id) }));
});
router.get('/scopes/:id', authRequired, requireRole(...READ), (req, res) => {
  const s = O.getScope(req.params.id);
  if (!s) return fail(res, 404, '授权单不存在');
  ok(res, s);
});
router.post('/scopes', authRequired, requireRole(...WRITE, ...APPROVE), guard((req) => O.createScope(req.body || {}, operatorOf(req))));
router.post('/scopes/:id/submit', authRequired, requireRole(...WRITE, ...APPROVE), guard((req) => O.submitScope(req.params.id)));
router.post('/scopes/:id/approve', authRequired, requireRole(...APPROVE), guard((req) => O.approveScope(req.params.id, req.body || {}, operatorOf(req))));
router.post('/scopes/:id/reject', authRequired, requireRole(...APPROVE), guard((req) => O.rejectScope(req.params.id, req.body || {}, operatorOf(req))));
router.post('/scopes/:id/renew', authRequired, requireRole(...WRITE, ...APPROVE), guard((req) => O.renewScope(req.params.id, req.body || {}, operatorOf(req))));
router.delete('/scopes/:id', authRequired, requireRole('admin'), guard((req) => O.deleteScope(req.params.id, operatorOf(req))));
router.post('/scopes/sweep', authRequired, requireRole(...APPROVE), guard((req) => O.sweepScopes(operatorOf(req))));

module.exports = router;
