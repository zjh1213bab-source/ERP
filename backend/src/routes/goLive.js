/**
 * 上线检查清单路由（/api/go-live）
 *
 * 路径设计上的两个注意点：
 *
 * 1. **写操作都放在独立路径段**（`/sign/:id`、`/manual/:id`）。`GUARDED` 是**前缀匹配**，
 *    写成 `/sign` 与 `/signoff` 同前缀会互相连坐；更常见的是 `/manual` 把 `/manual-list` 锁死。
 *    这个坑在本项目已经踩过两次（售后退款、员工自助受理）。
 *
 * 2. **签署与勾选分开挂权限**。勾人工项是「推进上线的人」的活（人事/管理员），
 *    签署是「决定上线的人」的活（老板/管理员）。合成一个权限，等于谁都能自己勾完自己签。
 */
const express = require('express');
const { authRequired, requireRole } = require('../middleware/auth');
const { ok, wrap } = require('../utils/http');
const S = require('../services/goLive');

const router = express.Router();

const READ = ['admin', 'boss', 'hr', 'finance'];
const RUN = ['admin', 'hr'];
const SIGN = ['admin', 'boss'];

const actor = (req) => (req.user && (req.user.username || req.user.name)) || 'system';

// ---------------- 读 ----------------
router.get('/meta', authRequired, requireRole(...READ), wrap(async (req, res) => ok(res, S.dict())));

router.get('/stats', authRequired, requireRole(...READ), wrap(async (req, res) => ok(res, S.stats())));

router.get('/rounds', authRequired, requireRole(...READ), wrap(async (req, res) =>
  ok(res, S.listRounds({ status: req.query.status, scope: req.query.scope }))));

router.get('/rounds/:id', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const d = S.detail(req.params.id);
  if (!d) return res.status(404).json({ ok: false, message: '评估轮次不存在' });
  return ok(res, d);
}));

// ---------------- 生成 / 刷新 ----------------
router.post('/rounds', authRequired, requireRole(...RUN), wrap(async (req, res) =>
  ok(res, S.buildRound(req.body || {}, actor(req)))));

/** 重跑自动项。人工项保留 —— 人已经验过的不能被一次刷新抹掉 */
router.post('/refresh/:id', authRequired, requireRole(...RUN), wrap(async (req, res) =>
  ok(res, S.refresh(req.params.id, actor(req)))));

// ---------------- 人工项 ----------------
/** 人工判定。自动项调用这里会被拒绝（见服务层 setManual 的说明） */
router.post('/manual/:id', authRequired, requireRole(...RUN), wrap(async (req, res) =>
  ok(res, S.setManual(req.params.id, req.body || {}, actor(req)))));

/** 认领责任人（不改状态） */
router.post('/assign/:id', authRequired, requireRole(...RUN), wrap(async (req, res) =>
  ok(res, S.assign(req.params.id, req.body || {}))));

// ---------------- 签署 / 撤回 ----------------
/** 签署：阻塞项没过只能签「暂不上线」 */
router.post('/sign/:id', authRequired, requireRole(...SIGN), wrap(async (req, res) =>
  ok(res, S.sign(req.params.id, req.body || {}, actor(req)))));

/** 撤回：签完发现要改，必须先撤回并写理由（签署结论不能悄悄改） */
router.post('/withdraw/:id', authRequired, requireRole(...SIGN), wrap(async (req, res) =>
  ok(res, S.withdraw(req.params.id, req.body || {}, actor(req)))));

module.exports = router;
