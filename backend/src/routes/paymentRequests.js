/**
 * 付款申请单
 *
 * GET    /api/payment-requests/meta                     可选枚举（状态、账户、供应商）
 * GET    /api/payment-requests/candidates?supplier_id=&q= 可申请的应付发票（含占用情况）
 * GET    /api/payment-requests                           列表
 * GET    /api/payment-requests/stats                     汇总
 * POST   /api/payment-requests                           新建草稿（金额由明细决定）
 * GET    /api/payment-requests/:id                       详情（含审批进度、付款记录）
 * PUT    /api/payment-requests/:id                       改草稿
 * DELETE /api/payment-requests/:id                       删草稿
 * POST   /api/payment-requests/:id/submit                提交审批
 * POST   /api/payment-requests/:id/cancel                取消 {reason}
 * POST   /api/payment-requests/:id/pay                   执行付款 {bank_account_id, pay_date, method}
 * GET    /api/payment-requests/export                    导出 CSV
 *
 * ⚠️ 字面量路由（meta/candidates/stats/export）必须写在 `/:id` 之前，
 * 否则 Express 会把 "stats" 当成单据 id → 永远 404。
 */
const express = require('express');
const { db } = require('../db');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const PR = require('../services/paymentRequest');
const { toCsv } = require('../utils/csv');

const router = express.Router();

// 看：老板、财务、出纳（仓库角色里有出纳岗）；销售不该看「欠谁钱、什么时候付」
const READ = ['admin', 'boss', 'finance', 'warehouse'];
// 提交申请：采购和财务都可能提单
const CREATE = ['admin', 'finance', 'warehouse'];
// 审批走审批中心（按角色），这里只管「谁能执行付款」——真正动钱的手
const PAY = ['admin', 'finance', 'warehouse'];

router.get(
  '/meta',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const suppliers = db
      .prepare(
        `SELECT DISTINCT s.id, s.name, s.payment_terms, s.term_days
           FROM ap_invoices i JOIN suppliers s ON s.id = i.supplier_id
          WHERE i.status <> 'void' AND i.amount - COALESCE(i.paid_amount,0) > 0.005
          ORDER BY s.name`
      )
      .all();
    const accounts = db
      .prepare("SELECT id, bank_name, account_masked, currency FROM bank_accounts WHERE status = 'active' ORDER BY id")
      .all();
    return ok(res, {
      statuses: Object.entries(PR.STATUS_LABEL).map(([code, label]) => ({ code, label })),
      suppliers,
      accounts,
      methods: ['银行转账', '电汇', '承兑汇票', '现金', '信用证'],
      stats: PR.stats()
    });
  })
);

router.get(
  '/candidates',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, PR.candidates(req.query)))
);

router.get(
  '/stats',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, PR.stats()))
);

router.get(
  '/export',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const l = PR.list(req.query);
    const head = [
      '申请单号', '状态', '供应商', '金额', '币种', '计划付款日', '付款方式',
      '明细张数', '申请人', '提交时间', '审批时间', '付款单号', '付款时间'
    ];
    const rows = l.rows.map((r) => [
      r.req_no,
      r.status_label,
      r.supplier_name || '',
      r.amount,
      r.currency || 'CNY',
      r.plan_pay_date || '',
      r.method || '',
      r.item_count,
      r.created_by || '',
      r.submitted_at || '',
      r.decided_at || '',
      r.pay_no || '',
      r.paid_at || ''
    ]);
    const csv = toCsv(head, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payment-requests-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  })
);

router.get(
  '/',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) =>
    ok(res, PR.list({ ...req.query, username: req.user.username }))
  )
);

router.post(
  '/',
  authRequired,
  requireRole(CREATE),
  wrap(async (req, res) => ok(res, PR.create(req.body || {}, req.user)))
);

router.get(
  '/:id',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, PR.detail(Number(req.params.id))))
);

router.put(
  '/:id',
  authRequired,
  requireRole(CREATE),
  wrap(async (req, res) => ok(res, PR.update(Number(req.params.id), req.body || {}, req.user)))
);

router.delete(
  '/:id',
  authRequired,
  requireRole(CREATE),
  wrap(async (req, res) => ok(res, PR.remove(Number(req.params.id), req.user)))
);

router.post(
  '/:id/submit',
  authRequired,
  requireRole(CREATE),
  wrap(async (req, res) => ok(res, PR.submit(Number(req.params.id), req.user)))
);

router.post(
  '/:id/cancel',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) =>
    ok(res, PR.cancel(Number(req.params.id), (req.body || {}).reason, req.user))
  )
);

router.post(
  '/:id/pay',
  authRequired,
  requireRole(PAY),
  wrap(async (req, res) => ok(res, PR.pay(Number(req.params.id), req.body || {}, req.user)))
);

module.exports = router;
