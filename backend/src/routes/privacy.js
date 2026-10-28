/**
 * 字段级脱敏与访问审计（TS-N18-03 / TS-N18-09）
 * ----------------------------------------------------------------------------
 * GET  /api/privacy/meta            字典（表 / 分类 / 掩码方式 / 权限点）+ 统计
 * GET  /api/privacy/rules           脱敏规则（按表分组）
 * PUT  /api/privacy/rules/:id       改规则（脱敏方式 / 保留位数 / 所需权限点）
 * POST /api/privacy/reveal          一次性查看明文 {table_name, field_name, target_id, reason}
 * GET  /api/privacy/logs            访问日志（谁在什么时候看了谁的什么字段）
 * GET  /api/privacy/stats           统计（规则数 / 日志数 / 一次性查看数 / 今日访问）
 * GET  /api/privacy/check?table=    当前用户在这张表上能看明文哪些字段（前端提示用）
 *
 * ⚠️ 这个模块只返回「元数据」与「按权限判定的明文」，不返回批量明文。
 *    批量明文只能通过各业务接口拿，而那些接口已经挂了 maskRows。
 */
const express = require('express');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const P = require('../services/privacy');

const router = express.Router();

// 规则与日志是治理数据：管理员与老板可看；老板不再往下的写权限
const READ = ['admin', 'boss'];
const ADMIN = ['admin'];

const ctx = (req) => ({
  user: req.user,
  ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
  ua: String(req.headers['user-agent'] || '').slice(0, 200)
});

router.get('/meta', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, {
  ...P.dict(),
  stats: P.stats()
})));

router.get('/rules', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, P.listRules())));

router.put('/rules/:id', authRequired, requireRole(ADMIN), wrap(async (req, res) => ok(res, P.saveRule(Number(req.params.id), req.body))));

router.get('/stats', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, P.stats())));

/**
 * 一次性查看明文
 *
 * 有权限的人也可以走这里（会记 granted=1），但业务接口已经返回明文，
 * token 在这里的用途主要是「无权限者排障」：必须写理由、每次留痕。
 */
router.post('/reveal', authRequired, wrap(async (req, res) => ok(res, P.reveal({
  ...req.body,
  ...ctx(req)
}))));

router.get('/logs', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, P.logs(req.query))));

/** 我在某张表上能看明文的字段（前端显示「已脱敏」提示用） */
router.get('/check', authRequired, wrap(async (req, res) => {
  const table = String(req.query.table || '');
  const list = P.rules(table).filter((r) => r.enabled).map((r) => ({
    field_name: r.field_name,
    label: r.label,
    required_perm: r.required_perm,
    can_see: P.canSee(req.user, r)
  }));
  return ok(res, { table_name: table, fields: list });
}));

module.exports = router;
