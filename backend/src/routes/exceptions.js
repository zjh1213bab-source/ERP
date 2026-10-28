/**
 * 异常协同与日清
 * ----------------------------------------------------------------------------
 * GET    /api/exceptions/meta                 字典（六类归口 / 状态 / 规则 / 人员）
 * GET    /api/exceptions/daily?day=           日清清单（必办 / 处理中 / 覆盖率）
 * GET    /api/exceptions/report?day=          日报初稿（已完成/处理中/等待/超时/自动消除）
 * GET    /api/exceptions/stats                顶部统计
 * POST   /api/exceptions/scan                 扫描（幂等，重复扫不重复派单）
 * GET    /api/exceptions/rules                规则与阈值
 * PUT    /api/exceptions/rules/:code          改阈值 / 启停 / 说明
 * GET    /api/exceptions                      列表（按状态/类别/责任人/关键词）
 * GET    /api/exceptions/:id                  详情 + 动作流水
 * POST   /api/exceptions/:id/claim            认领
 * POST   /api/exceptions/:id/assign           指派 / 转派（必须写原因）
 * POST   /api/exceptions/:id/close            关闭（原因 + 结果都必填）
 * POST   /api/exceptions/:id/review           复核（复核人 ≠ 处理人）
 * POST   /api/exceptions/:id/note             加备注
 * POST   /api/exceptions/:id/reopen           重开（只允许自动消除的）
 *
 * ⚠️ 字面量路由（meta/daily/report/stats/scan/rules）必须写在 `/:id` 之前。
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const E = require('../services/exceptions');

const router = express.Router();

// 所有在岗角色都能看自己归口的异常；boss 只读也看得到
const READ = ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];
// 认领/处理/关闭：具体干活的人。boss 不参与（老板不该去关异常单）
const WRITE = ['admin', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];
// 复核：主管与老板（复核人不能是处理人，服务层另有校验）
const REVIEW = ['admin', 'boss'];
// 改规则阈值：只给管理员（改错了会让全公司少提醒或多提醒）
const RULE = ['admin'];

router.get('/meta', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, {
  ...E.dict(),
  stats: E.stats(req.query.company_id)
})));

router.get('/daily', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, E.daily(req.query))));

router.get('/report', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, E.dailyReport(req.query))));

router.get('/stats', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, E.stats(req.query.company_id))));

router.post('/scan', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, E.scan({
  ...req.body,
  operator: req.user?.name || req.user?.username
}))));

router.get('/rules', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, E.rules())));

router.put('/rules/:code', authRequired, requireRole(RULE), wrap(async (req, res) => ok(res, E.saveRule(req.params.code, req.body))));

router.get('/', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, E.list(req.query))));

router.get('/:id', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, E.get(Number(req.params.id)))));

const actor = (req) => req.user?.name || req.user?.username;

router.post('/:id/claim', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, E.claim(Number(req.params.id), {
  username: req.user?.username,
  name: req.user?.name
}))));

router.post('/:id/assign', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, E.assign(Number(req.params.id), {
  ...req.body,
  operator: actor(req)
}))));

router.post('/:id/close', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, E.close(Number(req.params.id), {
  ...req.body,
  operator: actor(req)
}))));

router.post('/:id/review', authRequired, requireRole(REVIEW), wrap(async (req, res) => ok(res, E.review(Number(req.params.id), {
  ...req.body,
  operator: actor(req)
}))));

router.post('/:id/note', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, E.note(Number(req.params.id), {
  ...req.body,
  operator: actor(req)
}))));

router.post('/:id/reopen', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, E.reopen(Number(req.params.id), {
  ...req.body,
  operator: actor(req)
}))));

// 标为数据遗留（不再提醒）：日清要能清零，但必须留理由与到期日
router.post('/:id/ignore', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, E.ignore(Number(req.params.id), {
  ...req.body,
  operator: actor(req)
}))));

module.exports = router;
