/**
 * 员工自助与薪资申诉（TS-N13-10）
 * ----------------------------------------------------------------------------
 * —— 员工端（所有登录角色都能用，只看自己）——
 * GET    /api/self/meta                     字典（申请类型 / 状态 / 可更正字段）+ 统计
 * GET    /api/self/overview                 我的：档案 / 本月考勤 / 已休假期 / 工资单 / 技能 / 申请
 * GET    /api/self/payslips                 我的工资条（只含已确认/已发放）
 * GET    /api/self/payslips/:id             工资条明细（只能看自己的，留痕）
 * GET    /api/self/requests                 我的申请
 * POST   /api/self/requests                 提交申请（补卡 / 请假 / 资料更正 / 薪资申诉）
 * POST   /api/self/requests/:id/withdraw    撤回（未处理的）
 * GET    /api/self/team                     主管看的团队摘要（无金额、无病假类型）
 *
 * —— 人事 / 财务端 ——
 * GET    /api/self/bindings                 账号绑定清单
 * GET    /api/self/employees-for-bind       可绑定的员工
 * POST   /api/self/bind                     绑定账号 ↔ 员工
 * POST   /api/self/unbind/:userId           解绑
 * GET    /api/self/all-requests             待办与全部申请
 * POST   /api/self/requests/:id/review      受理结论（驳回也要写结论；薪资申诉批准生成调整单）
 * GET    /api/self/adjustments              工资调整单
 *
 * ⚠️ 字面量路由必须写在 `/:id` 之前。
 */
const express = require('express');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/selfService');

const router = express.Router();

const ALL = ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];
const MANAGE = ['admin', 'hr', 'finance'];
const BIND = ['admin', 'hr'];

// 自助：任何登录角色都能看自己的；范围由服务层按「绑定关系」卡死
router.get('/meta', authRequired, requireRole(ALL), wrap(async (req, res) => ok(res, S.dict())));

router.get('/overview', authRequired, requireRole(ALL), wrap(async (req, res) => ok(res, S.overview(req.user))));

router.get('/payslips', authRequired, requireRole(ALL), wrap(async (req, res) => {
  const me = S.resolve(req.user);
  if (!me.bound) return ok(res, { bound: false, rows: [], hint: '当前账号未绑定员工档案' });
  return ok(res, { bound: true, rows: S.payslipsOf(me.employee.id) });
}));

router.get('/requests', authRequired, requireRole(ALL), wrap(async (req, res) => ok(res, S.myRequests(req.user, req.query))));

router.post('/requests', authRequired, requireRole(ALL), wrap(async (req, res) => ok(res, S.submit(req.user, req.body || {}))));

router.get('/team', authRequired, requireRole(ALL), wrap(async (req, res) => ok(res, S.teamSummary(req.user))));

// —— 人事/财务 ——
router.get('/bindings', authRequired, requireRole(BIND), wrap(async (req, res) => ok(res, S.bindings(req.query))));

router.get('/employees-for-bind', authRequired, requireRole(BIND), wrap(async (req, res) => ok(res, S.employeesForBind(req.query))));

router.post('/bind', authRequired, requireRole(BIND), wrap(async (req, res) =>
  ok(res, S.bind(req.body || {}, req.user.name || req.user.username))));

router.post('/unbind/:userId', authRequired, requireRole(BIND), wrap(async (req, res) =>
  ok(res, S.unbind(req.params.userId, req.user.name || req.user.username))));

router.get('/all-requests', authRequired, requireRole(MANAGE), wrap(async (req, res) => ok(res, S.requestsForStaff(req.query))));

router.get('/adjustments', authRequired, requireRole(MANAGE), wrap(async (req, res) => ok(res, S.adjustments(req.query))));

router.post('/review/:id', authRequired, requireRole(MANAGE), wrap(async (req, res) => {
  const row = S.review(req.user, req.params.id, req.body || {});
  return ok(res, row);
}));

// 带 :id 的放最后
router.get('/payslips/:id', authRequired, requireRole(ALL), wrap(async (req, res) => {
  const role = req.user.role || '';
  return ok(res, S.payslipDetail(req.user, req.params.id, role));
}));

router.post('/requests/:id/withdraw', authRequired, requireRole(ALL), wrap(async (req, res) =>
  ok(res, S.withdraw(req.user, req.params.id))));

module.exports = router;
