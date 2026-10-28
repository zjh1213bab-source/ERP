/**
 * 数据导出与订阅（/api/exports）
 * ========================================================================
 * 这一组接口是**数据出系统的唯一出口**（白名单内）。页面 `/export-center` 用它，
 * 其它业务端点如果自己拼 CSV，也要调 `S.logExternal()` 补一条记录（做不到就说明原因）。
 *
 * 权限四层：
 *   export.read       看数据集清单与自己能看的导出记录（全角色）
 *   export.run        真正执行导出（下载 CSV）
 *   export.subscribe  建/停周期订阅（数据定期外发，属高危）
 *   export.audit      看所有人的导出记录、水印反查、领取他人产出
 *
 * 注意：数据集自己还有一层业务权限（如工资要 paycheck.read）。
 * 两层都要过 —— 只有 export.run 就「能导所有东西」是这套设计最容易漏的地方。
 */

const express = require('express');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { reqCtx } = require('../utils/reqCtx');
const S = require('../services/exportGuard');

const router = express.Router();

const READ = ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];
const RUN = ['admin', 'boss', 'sales', 'tech', 'production', 'warehouse', 'finance', 'hr'];
const SUB = ['admin', 'sales', 'finance', 'hr'];
const AUDIT = ['admin', 'hr', 'finance'];

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const actor = (req) => req.user || {};

// ============================================================
// 字典与数据集
// ============================================================
router.get('/meta', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const d = S.dict();
  return ok(res, {
    ...d,
    defs: S.listDefs(actor(req)),
    can_run: RUN.includes(actor(req).role),
    can_subscribe: SUB.includes(actor(req).role),
    can_audit: AUDIT.includes(actor(req).role)
  });
}));

/** 预览：按当前条件看前 5 行（脱敏后的样子），确认范围再导 */
router.get('/preview/:defKey', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const params = {
    as_of: req.query.as_of, status: req.query.status, period: req.query.period,
    from: req.query.from, to: req.query.to, level: req.query.level,
    department_id: req.query.department_id, warehouse: req.query.warehouse, kind: req.query.kind
  };
  return ok(res, S.previewSample(req.params.defKey, params, actor(req), reqCtx(req, { action: 'export' })));
}));

// ============================================================
// 导出
// ============================================================
// 路径用 /download 而不是 /run：GUARDED 是前缀匹配，/run 会连带 /run-due（订阅执行），
// 那样「导出权被收回」的人连订阅都跑不了
router.post('/download/:defKey', authRequired, requireRole(...RUN), wrap(async (req, res) => {
  const b = req.body || {};
  const r = S.runExport({
    def_key: req.params.defKey,
    params: b.params || {},
    reason: b.reason,
    trigger: 'manual',
    user: actor(req),
    ctx: reqCtx(req, { action: 'export' })
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(r.fileName)}"; filename*=UTF-8''${encodeURIComponent(r.fileName)}`);
  // 前端要能读到单号与水印（同源 fetch 允许读自定义头）
  res.setHeader('X-Export-Job', r.job.job_no);
  res.setHeader('X-Export-Watermark', r.job.watermark);
  res.setHeader('X-Export-Rows', String(r.rowsCount));
  res.setHeader('X-Export-Masked-Fields', encodeURIComponent(r.maskedFields.join(',')));
  res.setHeader('Access-Control-Expose-Headers', 'X-Export-Job,X-Export-Watermark,X-Export-Rows,X-Export-Masked-Fields');
  return res.send(r.csv);
}));

router.get('/jobs', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const me = actor(req);
  const q = { ...req.query };
  // 没有审计权限只能看自己导的（导出记录本身就是「谁在找什么数据」的情报）
  const isAudit = AUDIT.includes(me.role);
  if (!isAudit) q.requester = me.username;
  return ok(res, { rows: S.listJobs(q), scope: isAudit ? 'all' : 'self' });
}));

router.get('/jobs/:id', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const d = S.jobById(req.params.id);
  if (!d) return fail(res, 404, '导出记录不存在');
  const me = actor(req);
  if (!AUDIT.includes(me.role) && d.requester !== me.username) {
    return fail(res, 403, '这条导出记录不是你的，查看需要审计权限');
  }
  return ok(res, d);
}));

/** 水印反查：把文件里的水印贴进来，说清是谁导的 */
router.get('/trace', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const r = S.traceWatermark(req.query.token);
  const me = actor(req);
  if (!AUDIT.includes(me.role) && r.requester !== me.username) {
    // 能反查到「有这么一次导出」，但对方是谁不告诉无权限的人
    return ok(res, {
      job_no: r.job_no, def_name: r.def_name, created_at: r.created_at,
      requester_name: '（需要审计权限查看）', def_key: r.def_key, row_count: r.row_count,
      partial: true
    });
  }
  return ok(res, r);
}));

router.get('/stats', authRequired, requireRole(...READ), wrap(async (req, res) => ok(res, S.stats())));

// ============================================================
// 订阅
// ============================================================
router.get('/subs', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const me = actor(req);
  const isAudit = AUDIT.includes(me.role);
  const rows = S.listSubscriptions({ status: req.query.status, mine: isAudit ? null : me.username, user: me.username });
  return ok(res, { rows, scope: isAudit ? 'all' : 'self' });
}));

router.post('/subs', authRequired, requireRole(...SUB), wrap(async (req, res) =>
  ok(res, S.saveSubscription(req.body || {}, actor(req)))));

['pause', 'resume', 'cancel'].forEach((action) => {
  router.post(`/subs/${action}/:id`, authRequired, requireRole(...SUB), wrap(async (req, res) =>
    ok(res, S.setSubStatus(req.params.id, action))));
});

/**
 * 执行到期订阅
 *
 * 本部署没有后台调度器（项目一直没引入隐式定时任务，避免和备份/巡检抢库）。
 * 所以到期执行有两个入口：页面按钮，或运维 crontab 每天调一次这个接口。
 * 幂等：执行完 next_run_at 一定推到下一期，重复调用不会重复产出。
 */
router.post('/run-due', authRequired, requireRole(...SUB), wrap(async (req, res) =>
  ok(res, S.runDue((req.body || {}).as_of))));

router.get('/deliveries', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const me = actor(req);
  const isAudit = AUDIT.includes(me.role);
  const rows = S.listDeliveries({
    mine: !isAudit || req.query.mine === '1',
    user: me.username,
    status: req.query.status,
    subscription_id: req.query.subscription_id
  });
  return ok(res, { rows, scope: isAudit && req.query.mine !== '1' ? 'all' : 'self' });
}));

/** 领取订阅产出（下载）：只有收件人或审计权限能下 */
router.post('/deliveries/:id/take', authRequired, requireRole(...READ), wrap(async (req, res) => {
  const r = S.takeDelivery(req.params.id, actor(req));
  if (!r.csv) return fail(res, 409, r.note || '这个产出无法重新生成');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(r.fileName)}"; filename*=UTF-8''${encodeURIComponent(r.fileName)}`);
  res.setHeader('X-Export-Changed', r.content_changed ? '1' : '0');
  res.setHeader('Access-Control-Expose-Headers', 'X-Export-Changed');
  return res.send(r.csv);
}));

module.exports = router;
