/**
 * 操作日志 / 审计（`/api/audit`）
 *
 * GET  /api/audit                  列表（分页 + 时间/人/模块/动作/结果/关键字）
 * GET  /api/audit/facets           筛选下拉（只给库里真出现过的值）
 * GET  /api/audit/stats?days=14    统计（模块/动作/人/趋势/失败率）
 * GET  /api/audit/verify?from&to   哈希链校验（断在哪一条、为什么）
 * GET  /api/audit/export?...       导出 CSV（带范围声明与链校验结论）
 * POST /api/audit/archive          归档（把保留期前的日志落文件并移出主表）
 * GET  /api/audit/archives         归档记录
 *
 * 权限：老板只读（要给外部看的，首先得给老板看），归档只有管理员能做。
 * **没有删除接口** —— 日志只追加；要减量只能归档，且必须留下文件和哈希。
 */
const express = require('express');
const audit = require('../services/auditLog');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const READ = ['admin', 'boss'];
const ADMIN = ['admin'];

const operatorOf = (req) => (req.user && (req.user.name || req.user.username)) || 'system';

router.get('/', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, audit.list(req.query))));

router.get('/facets', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, audit.facets())));

router.get('/stats', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, audit.stats(req.query))));

router.get(
  '/verify',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    // 校验结果是「结论」不是「错误」，所以照样 200，让页面自己决定怎么显示
    return ok(res, audit.verify({ from: req.query.from, to: req.query.to }));
  })
);

router.get(
  '/export',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const { buffer, meta } = audit.exportCsv(req.query, operatorOf(req));
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const name = `audit-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    // 把「这份文件是什么、能不能验」放进响应头，收件人可以拿它复核
    res.setHeader('X-Audit-Rows', String(meta.rows));
    res.setHeader('X-Audit-Seq-Range', `${meta.from_seq}-${meta.to_seq}`);
    res.setHeader('X-Audit-Verified', meta.verified ? 'ok' : 'broken');
    res.setHeader('X-Audit-File-SHA256', meta.file_sha256);
    return res.send(buffer);
  })
);

router.get('/archives', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, audit.listArchives())));

router.post(
  '/archive',
  authRequired,
  requireRole(ADMIN),
  wrap(async (req, res) => {
    const b = req.body || {};
    const days = Number(b.before_days);
    if (!(days >= 1)) return fail(res, 400, '保留天数要填数字（至少 1 天）');
    if (days < 30) return fail(res, 400, '保留期少于 30 天的归档等于删日志，请把保留天数设在 30 天以上');
    return ok(res, audit.archive({ beforeDays: days, operator: operatorOf(req), note: b.note }));
  })
);

module.exports = router;
