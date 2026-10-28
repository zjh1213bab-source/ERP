/**
 * 技能矩阵与岗位资格（TS-N13-06）
 * ----------------------------------------------------------------------------
 * GET    /api/skills/meta                字典（等级/来源/部门/工序门槛）+ 统计
 * GET    /api/skills/matrix?dept=&q=     人 × 工序 矩阵
 * GET    /api/skills/coverage            覆盖缺口（每道工序几人能上 / 未建门槛的工序）
 * GET    /api/skills/expiring?days=60    到期清单（技能复评 / 证书 / 复训）
 * GET    /api/skills/stats               顶部统计
 * GET    /api/skills/check?employee_id=&process_name=   某人能不能上某工序（派工时用）
 * POST   /api/skills/assess              评定（唯一能改等级的地方）
 * POST   /api/skills/revoke              撤销技能（写原因）
 * PUT    /api/skills/requirements/:name  维护工序门槛（最低等级 / 是否受限 / 需要几人）
 * GET    /api/skills/certs?employee_id=  证书清单
 * POST   /api/skills/certs               登记证书
 * POST   /api/skills/certs/:id/revoke    作废证书
 * GET    /api/skills/trainings?employee_id=  培训记录
 * POST   /api/skills/trainings           安排培训
 * POST   /api/skills/trainings/:id/finish 登记培训结果
 * POST   /api/skills/overrides           破格放行（受限工序，必须写理由 + 有期限）
 * GET    /api/skills/mine?employee_id=   员工视角：我的技能与到期
 *
 * ⚠️ 字面量路由（meta/matrix/coverage/expiring/stats/check/mine）必须写在 /:id 之前。
 */
const express = require('express');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/skillMatrix');

const router = express.Router();

// 看矩阵：人事、生产、技术要排产，老板要盘家底。销售/仓库/财务不需要看谁能车缝
const READ = ['admin', 'boss', 'hr', 'production', 'tech'];
// 评定与维护：人事主责，生产主管能评自己线的人（车间里谁行谁不行，主管最清楚）
const WRITE = ['admin', 'hr', 'production'];
// 改门槛（受限开关）：影响全厂能不能开工，只给人事和管理员
const RULE = ['admin', 'hr'];

const actor = (req) => req.user?.name || req.user?.username || '';

router.get('/meta', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.meta())));

router.get('/matrix', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.matrix(req.query))));

router.get('/coverage', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.coverage())));

router.get('/expiring', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.expiring(req.query))));

router.get('/stats', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.stats())));

// 派工前先问一句「这人能不能上」，避免排了班才发现没人会
router.get('/check', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { employee_id, process_name } = req.query;
  if (!employee_id || !process_name) return fail(res, 400, '缺少 employee_id 或 process_name');
  return ok(res, S.canWork(Number(employee_id), String(process_name)));
}));

router.get('/mine', authRequired, wrap(async (req, res) => {
  // 员工只能看自己的；人事/管理员可代查
  const me = req.user || {};
  const roles = [].concat(me.roles || me.role || []);
  const canOthers = roles.some((r) => ['admin', 'hr', 'production'].includes(r));
  let id = me.employee_id || me.emp_id;
  if (req.query.employee_id && canOthers) id = Number(req.query.employee_id);
  if (!id) return fail(res, 400, '当前账号没有绑定员工档案，无法查看个人技能');
  return ok(res, S.mySkills(id));
}));

router.post('/assess', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, S.assess(req.body || {}, actor(req)))));

router.post('/revoke', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, S.revoke(req.body || {}, actor(req)))));

// 工序名里可能有斜杠/中文，用 query 传，避免路径解析出问题
router.put('/requirements', authRequired, requireRole(RULE), wrap(async (req, res) =>
  ok(res, S.saveRequirement(req.body || {}, actor(req)))));

router.get('/certs', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { employee_id } = req.query;
  const sql = employee_id
    ? 'SELECT * FROM skill_certs WHERE employee_id = ? ORDER BY expire_date'
    : 'SELECT * FROM skill_certs ORDER BY expire_date';
  const { db } = require('../db');
  return ok(res, employee_id ? db.prepare(sql).all(Number(employee_id)) : db.prepare(sql).all());
}));

router.post('/certs', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, S.addCert(req.body || {}, actor(req)))));

router.post('/certs/:id/revoke', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, S.revokeCert(req.params.id, (req.body || {}).reason, actor(req)))));

router.get('/trainings', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { employee_id } = req.query;
  const { db } = require('../db');
  const sql = employee_id
    ? 'SELECT * FROM training_records WHERE employee_id = ? ORDER BY IFNULL(planned_at, created_at) DESC'
    : 'SELECT * FROM training_records ORDER BY IFNULL(planned_at, created_at) DESC';
  return ok(res, employee_id ? db.prepare(sql).all(Number(employee_id)) : db.prepare(sql).all());
}));

router.post('/trainings', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, S.addTraining(req.body || {}, actor(req)))));

router.post('/trainings/:id/finish', authRequired, requireRole(WRITE), wrap(async (req, res) =>
  ok(res, S.finishTraining(req.params.id, req.body || {}, actor(req)))));

router.post('/overrides', authRequired, requireRole(RULE), wrap(async (req, res) =>
  ok(res, S.overrideSkill(req.body || {}, actor(req)))));

module.exports = router;
