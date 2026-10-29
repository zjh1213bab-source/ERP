/**
 * 应收催收任务
 *
 * GET    /api/collections/meta                 枚举（状态/等级/渠道/结果/结案原因）+ 统计
 * GET    /api/collections/board                逾期台账（谁欠、多久、有没有人在催）
 * GET    /api/collections/stats                汇总（与 meta.stats 同源）
 * POST   /api/collections/generate             批量生成任务 {all|customer_ids, min_overdue_days}
 * GET    /api/collections                      任务列表
 * GET    /api/collections/:id                  详情（含发票与跟进记录）
 * POST   /api/collections/:id/log              记一次跟进 {channel, result, promise_date, promise_amount, note}
 * POST   /api/collections/:id/assign           指派负责人 {username|owner_name}
 * POST   /api/collections/:id/close            结案 {reason, note}
 * POST   /api/collections/:id/reopen           重新打开 {reason}
 * GET    /api/collections/export               导出 CSV
 *
 * ⚠️ 字面量路由（meta/board/generate/export）必须写在 `/:id` 之前。
 */
const express = require('express');
const { db } = require('../db');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const C = require('../services/collection');
const scope = require('../access/companyScope');

/** 当前用户能看的主体（null = 集团角色，全集团） */
// 主体过滤值：**单公司模式下恒为 null（不过滤）**，判据在 access/companyScope.js 的 of()
const cidOf = (req) => scope.filterCompanyId(req.user);

/** 任务级守卫：不属于本主体的任务当作不存在（与订单域同口径） */
function taskOr404(req) {
  const id = Number(req.params.id);
  if (!C.taskInCompany(id, cidOf(req))) {
    const e = new Error('催收任务不存在');
    e.status = 404;
    throw e;
  }
  return id;
}
const { toCsv } = require('../utils/csv');

const router = express.Router();

// 业务员要看自己名下的催收单；财务/老板看全部
const READ = ['admin', 'boss', 'finance', 'sales'];
const WRITE = ['admin', 'finance', 'sales'];
// 结案（尤其核销坏账）会影响应收质量口径，只给财务
const CLOSE = ['admin', 'finance'];

router.get(
  '/meta',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const users = db
      .prepare("SELECT username, name FROM users WHERE active = 1 AND role IN ('sales','finance','admin') ORDER BY id")
      .all();
    return ok(res, {
      statuses: Object.entries(C.STATUS_LABEL).map(([code, label]) => ({ code, label })),
      levels: Object.entries(C.LEVEL_LABEL).map(([code, label]) => ({ code, label })),
      channels: Object.entries(C.CHANNEL_LABEL).map(([code, label]) => ({ code, label })),
      results: Object.entries(C.RESULT_LABEL).map(([code, label]) => ({ code, label })),
      close_reasons: Object.entries(C.CLOSE_REASON_LABEL).map(([code, label]) => ({ code, label })),
      owners: users,
      stats: C.stats(cidOf(req))
    });
  })
);

router.get(
  '/board',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, C.board({ ...req.query, companyId: cidOf(req) })))
);

router.get(
  '/stats',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, C.stats(cidOf(req))))
);

router.post(
  '/generate',
  authRequired,
  requireRole(CLOSE),
  wrap(async (req, res) => ok(res, C.generate({ ...(req.body || {}), companyId: cidOf(req) }, req.user)))
);

router.get(
  '/export',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const l = C.list({ ...req.query, companyId: cidOf(req) });
    const head = [
      '任务号', '客户', '负责人', '归属', '等级', '状态', '逾期金额', '剩余未收', '已收回',
      '回收率%', '发票数', '最长逾期天数', '承诺日期', '承诺金额', '承诺次数', '跳票次数',
      '跟进次数', '结案原因', '结案说明'
    ];
    const rows = l.rows.map((t) => [
      t.task_no,
      t.customer_name || '',
      t.owner_name || '（待指派）',
      { profile: '客户档案', order: '订单跟单员', manual: '人工指派', none: '待指派' }[t.owner_source] || '',
      t.level_label,
      t.status_label,
      t.overdue_amount,
      t.remaining,
      t.recovered,
      t.recover_rate,
      t.invoice_count,
      t.max_overdue_days,
      t.promise_date || '',
      t.promise_amount || '',
      t.promise_count,
      t.promise_broken,
      t.follow_count,
      t.closed_reason || '',
      t.closed_note || ''
    ]);

    // 接入统一导出出口：补一条导出记录（谁、什么时候、多少行、理由），文件头带水印。
    // 这些端点是历史实现（自己拼 CSV），不在白名单数据集里 —— 所以 def_key 记 'legacy'，
    // 页面上单列一栏「既有端点」，宁可显得不全，也不假装已经收编。
    const ex = require('../services/exportGuard').logExternal({
      def_key: null,
      params: { ...req.query },
      user: req.user,
      ctx: require('../utils/reqCtx').reqCtx(req, { action: 'export' }),
      note: '应收催收台账（既有端点）',
      row_count: rows.length
    });
    const csv = toCsv([head, ...rows]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="collections-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('X-Export-Job', ex.job_no);
    res.setHeader('X-Export-Watermark', ex.watermark);
    return res.send(ex.watermark_line + '\r\n' + csv);
  })
);

router.get(
  '/',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    // 销售只看自己名下的（普通业务员不该看到别人客户的欠款明细）
    const q = { ...req.query };
    if (req.user.role === 'sales') {
      const u = db.prepare('SELECT name FROM users WHERE username = ?').get(req.user.username);
      q.owner = req.user.username;
      // 兼容「只有名字没账号」的单子
      if (u && u.name) q.owner_name = u.name;
    }
    return ok(res, C.list({ ...q, companyId: cidOf(req) }));
  })
);

router.get(
  '/:id',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, C.detail(Number(req.params.id), { companyId: cidOf(req) })))
);

router.post(
  '/:id/log',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => ok(res, C.log(taskOr404(req), req.body || {}, req.user)))
);

router.post(
  '/:id/assign',
  authRequired,
  requireRole(CLOSE),
  wrap(async (req, res) => ok(res, C.assign(taskOr404(req), req.body || {}, req.user)))
);

router.post(
  '/:id/close',
  authRequired,
  requireRole(CLOSE),
  wrap(async (req, res) => ok(res, C.close(taskOr404(req), req.body || {}, req.user)))
);

router.post(
  '/:id/reopen',
  authRequired,
  requireRole(CLOSE),
  wrap(async (req, res) => ok(res, C.reopen(taskOr404(req), req.body || {}, req.user)))
);

module.exports = router;
