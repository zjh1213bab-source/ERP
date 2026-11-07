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
router.get('/review-notices',authRequired,wrap(async(req,res)=>ok(res,require('../services/reviewNotices').list(req.user))));

const ALL = ['employee', 'admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];
const MANAGE = ['admin', 'hr', 'finance'];
const BIND = ['admin', 'hr'];

/** 一线计件员工按账号绑定归人，客户端不能指定他人报工。 */
function workEmployee(req){const me=S.resolve(req.user);if(!me.bound||me.employee.status!=='active')throw Object.assign(new Error('当前账号未绑定在职员工，不能扫码报工'),{status:403});return me.employee;}
router.get('/work-find',authRequired,wrap(async(req,res)=>{workEmployee(req);req.workerReport=true;return require('./orders').findOrder(req,res);}));
router.get('/work-order/:id',authRequired,wrap(async(req,res)=>{
 workEmployee(req);const {db}=require('../db'),scope=require('../access/companyScope');const found=scope.assertOrder(req.user,Number(req.params.id));if(!found.ok)return fail(res,found.status,found.reason);
 const order=found.row;return ok(res,{order:{id:order.id,order_no:order.order_no,style_name:order.style_name,status:order.status,delivery_date:order.delivery_date},nodes:db.prepare('SELECT id,name,status,code FROM order_nodes WHERE order_id=? ORDER BY seq,id').all(order.id),reports:db.prepare('SELECT node_id,SUM(qty_ok) AS ok,SUM(qty_defect) AS defect FROM production_reports WHERE order_id=? GROUP BY node_id').all(order.id)});
}));
router.get('/work-quote',authRequired,wrap(async(req,res)=>{
 workEmployee(req);const {db}=require('../db');const node=db.prepare('SELECT * FROM order_nodes WHERE id=?').get(Number(req.query.node_id));if(!node)return fail(res,404,'生产工序不存在');const found=require('../access/companyScope').assertOrder(req.user,node.order_id);if(!found.ok)return fail(res,found.status,found.reason);return ok(res,require('../services/wageMultiplier').quote(node.order_id,node,req.query));
}));
router.post('/work-report',authRequired,wrap(async(req,res)=>{
 const employee=workEmployee(req);req.body={...req.body,employee_id:employee.id,operator:employee.name};return require('./reports').createReport(req,res);
}));

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
