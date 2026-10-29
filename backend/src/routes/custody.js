/**
 * 资产工衣与领归（TS-N14-03）
 * ========================================================================
 * - `/api/custody/items`        实物档案（一物一码 / 按量消耗）
 * - `/api/custody/records`      领用台账（草稿 → 发放 → 归还 / 转交）
 * - `/api/custody/clearances`   离职清退单
 * - `/api/custody/claims`       损坏责任复核（金额需财务确认）
 *
 * 权限四层：
 * - 看：全角色（每个人都要能看自己身上挂着什么）
 * - 发放/回收：行政、人事、仓库（东西在行政仓，发料是他们点）
 * - 档案与处置：行政、人事（改档案会改全厂口径；处置等于东西消失）
 * - 定责：行政/人事/财务；**财务确认金额单独一层**，只有财务与管理员能点
 *
 * 高危动作路径单独成段（`GUARDED` 是前缀匹配）：
 *   `/api/custody/items`、`/scrap`、`/review`、`/finance` 各自独立，
 *   不写成 `/api/custody` 一整个前缀，否则「看台账」也会被锁成只有行政能进。
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/custody');
const scope = require('../access/companyScope');

/**
 * 当前用户能看的主体（null = 集团角色，全集团）
 *
 * 这一域**不需要加列**：`custody_items` 自带 `company_id`，领用/定责按实物父表判、
 * 清退按员工父表判。三级口径见 services/custody.js 顶部说明。
 */
const cidOf = (req) => scope.filterCompanyId(req.user);

const router = express.Router();

const READ = ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];
const ISSUE = ['admin', 'hr', 'warehouse'];
const MANAGE = ['admin', 'hr'];
const CLAIM = ['admin', 'hr', 'finance'];
const FINANCE = ['admin', 'finance'];

const actor = (req) => (req.user && (req.user.name || req.user.username || req.user.sub)) || 'system';

/* ---------------- 字典 / 看板 ---------------- */
router.get('/meta', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.dict(cidOf(req)))));

router.get('/board', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.board(cidOf(req)))));

/* ---------------- 实物档案 ---------------- */
router.get('/items', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.listItems({ ...(req.query || {}), companyId: cidOf(req) }))));

router.get('/items/:id/timeline', authRequired, requireRole(READ), wrap(async (req, res) =>
  ok(res, S.itemTimeline(req.params.id, cidOf(req)))));

router.post('/items', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.saveItem(req.body || {}, actor(req), req.user))));

// 处置：单独路径段，便于精确挂锁，也避免误伤「看档案」的 GET
router.post('/scrap/:id', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.scrapItem(req.params.id, req.body || {}, actor(req), cidOf(req)))));

// 损坏件修好后恢复可用（「归还了」不等于「还能用」，必须人点一下）
router.post('/restore/:id', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.restoreItem(req.params.id, req.body || {}, actor(req), cidOf(req)))));

/* ---------------- 领用台账 ---------------- */
router.get('/records', authRequired, requireRole(READ), wrap(async (req, res) =>
  ok(res, S.listRecords({ ...(req.query || {}), companyId: cidOf(req) }))));

router.get('/records/:id', authRequired, requireRole(READ), wrap(async (req, res) => {
  const d = S.detailRecord(req.params.id, cidOf(req));
  if (!d) {
    const e = new Error('领用记录不存在');
    e.status = 404;
    throw e;
  }
  return ok(res, d);
}));

// 登记领用（body.draft=true 时只存草稿，不占实物）
router.post('/records', authRequired, requireRole(...ISSUE), wrap(async (req, res) =>
  ok(res, S.createRecord(req.body || {}, actor(req), cidOf(req)))));

// 草稿发放：这一刻才真正占实物
router.post('/records/:id/publish', authRequired, requireRole(...ISSUE), wrap(async (req, res) =>
  ok(res, S.publishRecord(req.params.id, actor(req), cidOf(req)))));

router.post('/records/:id/return', authRequired, requireRole(...ISSUE), wrap(async (req, res) =>
  ok(res, S.returnRecord(req.params.id, req.body || {}, actor(req), cidOf(req)))));

router.post('/records/:id/transfer', authRequired, requireRole(...ISSUE), wrap(async (req, res) =>
  ok(res, S.transferRecord(req.params.id, req.body || {}, actor(req), cidOf(req)))));

/* ---------------- 谁身上有什么 ---------------- */
router.get('/person/:employeeId', authRequired, requireRole(READ), wrap(async (req, res) =>
  ok(res, S.personView(req.params.employeeId, cidOf(req)))));

router.get('/overdue', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, S.overdueList(cidOf(req)))));

/* ---------------- 离职清退 ---------------- */
router.get('/clearances', authRequired, requireRole(READ), wrap(async (req, res) =>
  ok(res, S.listClearances({ ...(req.query || {}), companyId: cidOf(req) }))));

router.post('/clearances', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.buildClearance(req.body || {}, actor(req), cidOf(req)))));

router.post('/clearances/:id/close', authRequired, requireRole(...MANAGE), wrap(async (req, res) =>
  ok(res, S.closeClearance(req.params.id, req.body || {}, actor(req), cidOf(req)))));

/* ---------------- 损坏责任复核 ---------------- */
router.get('/claims', authRequired, requireRole(READ), wrap(async (req, res) =>
  ok(res, S.listClaims({ ...(req.query || {}), companyId: cidOf(req) }))));

router.post('/claims', authRequired, requireRole(...CLAIM), wrap(async (req, res) =>
  ok(res, S.createClaim(req.body || {}, actor(req), cidOf(req)))));

// 复核结论：只写责任比例，不动钱（路径独立，便于挂锁）
router.post('/review/:id', authRequired, requireRole(...CLAIM), wrap(async (req, res) =>
  ok(res, S.reviewClaim(req.params.id, req.body || {}, actor(req), cidOf(req)))));

// 财务确认：必须有回执号；只有财务与管理员
router.post('/finance/:id', authRequired, requireRole(...FINANCE), wrap(async (req, res) =>
  ok(res, S.confirmFinance(req.params.id, req.body || {}, actor(req), req.user.roles || [req.user.role], cidOf(req)))));

module.exports = router;
