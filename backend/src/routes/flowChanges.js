/**
 * 流程变更发布与审计（TS-N15-05）
 * ----------------------------------------------------------------------------
 * GET  /api/flow-changes/meta                     字典（角色 / 关键角色 / 状态 / 迁移模式）
 * GET  /api/flow-changes/flows                    流程清单（当前生效版本 / 版本数 / 在途单）
 * GET  /api/flow-changes/flows/versions?flow_key= 该流程的版本历史
 * GET  /api/flow-changes/changes                  变更单列表
 * GET  /api/flow-changes/changes/:id              详情（含试运行证据 / 影响分析 / 审计流水）
 * POST /api/flow-changes/changes                  创建变更（草稿）
 * POST /api/flow-changes/changes/:id/trial        试运行（拿历史单对比路径，出证据）
 * POST /api/flow-changes/changes/:id/publish      发布（必须有试运行证据；生效日不能倒签）
 * POST /api/flow-changes/changes/:id/rollback     回滚（只能回滚最近一次发布）
 * POST /api/flow-changes/changes/:id/reject       作废未发布的草稿
 * GET  /api/flow-changes/audits                   审计流水
 *
 * ⚠️ 字面量路由（meta/flows/changes/audits）写在参数路由之前。
 * ⚠️ flow_key 里带 `::`（如 `cost::成本审批`），所以走 query 不走路径参数。
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const F = require('../services/flowChange');

const router = express.Router();

// 流程是制度，改了会影响全公司的审批：看的人给老板（只读），改的人只给管理员
const READ = ['admin', 'boss'];
const WRITE = ['admin'];

const actor = (req) => req.user?.name || req.user?.username;

router.get('/meta', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, F.dict())));

router.get('/flows', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, F.listFlows())));

router.get('/flows/versions', authRequired, requireRole(READ), wrap(async (req, res) => {
  const key = String(req.query.flow_key || '');
  if (!key) return ok(res, []);
  return ok(res, F.versions(key));
}));

router.get('/changes', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, F.listChanges(req.query))));

router.get('/changes/:id', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, F.detail(Number(req.params.id)))));

router.post('/changes', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, F.createChange({
  ...req.body,
  created_by: actor(req)
}))));

router.post('/changes/:id/trial', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, F.trial(Number(req.params.id), {
  ...req.body,
  operator: actor(req)
}))));

router.post('/changes/:id/publish', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, F.publish(Number(req.params.id), {
  ...req.body,
  operator: actor(req)
}))));

router.post('/changes/:id/rollback', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, F.rollback(Number(req.params.id), {
  ...req.body,
  operator: actor(req)
}))));

router.post('/changes/:id/reject', authRequired, requireRole(WRITE), wrap(async (req, res) => ok(res, F.reject(Number(req.params.id), {
  ...req.body,
  operator: actor(req)
}))));

router.get('/audits', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, F.audits(req.query))));

module.exports = router;
