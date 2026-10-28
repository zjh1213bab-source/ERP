/**
 * 应付台账与付款计划
 *
 * GET  /api/payable/board?q=&only_overdue=   供应商应付台账
 * GET  /api/payable/schedule?weeks=8         付款计划（按周分组 + 待开票）
 * GET  /api/payable/export                  台账 CSV
 * GET  /api/payable/:supplierId              单供应商明细
 * PUT  /api/payable/:supplierId              维护账期 {payment_terms, term_days}
 *
 * ⚠️ 字面量路由（board/schedule/export）必须写在 `/:supplierId` 之前，
 * 否则 Express 会把 `board` 当成供应商 id → 永远 404。
 */
const express = require('express');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const payable = require('../services/payable');
const { toCsv } = require('../utils/csv');

const router = express.Router();
const READ = ['admin', 'boss', 'finance'];
// 改账期会影响到期日、进而影响逾期判定，只给财务
const WRITE = ['admin', 'finance'];

router.get(
  '/board',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) =>
    ok(
      res,
      payable.board({
        q: req.query.q,
        only_overdue: req.query.only_overdue === '1'
      })
    )
  )
);

router.get(
  '/schedule',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, payable.schedule({ weeks: req.query.weeks })))
);

router.get(
  '/export',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const b = payable.board({ q: req.query.q, only_overdue: req.query.only_overdue === '1' });
    const head = [
      '供应商编号', '供应商', '账期', '未付发票', '已收货未开票', '应付合计',
      '逾期金额', '最长逾期(天)', '7天内到期', '30天内到期', '最近到期日', '预计到期(未开票)'
    ];
    const body = b.rows.map((r) => [
      r.supplier.code || '',
      r.supplier.name || '',
      r.supplier.term_label,
      r.figures.open_amount,
      r.figures.unbilled_amount,
      r.figures.payable_total,
      r.figures.overdue,
      r.figures.max_overdue_days,
      r.figures.due_7,
      r.figures.due_30,
      r.figures.next_due || '',
      r.figures.unbilled_est_due || ''
    ]);
    const note = [
      ['说明', '应付 = 已开票未付 + 已收货未开票（货到了票没到，也是要付的钱）', ''],
      ['说明', '「未开票」的到期日是按收货日 + 供应商账期算的预计值，不算作逾期', ''],
      ['说明', '统计口径以导出时间点为准', b.as_of],
      ['', '', '']
    ];
    const csv = toCsv([...note, head, ...body]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payable-${b.as_of}.csv"`);
    return res.send(csv);
  })
);

router.get(
  '/:supplierId',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const d = payable.detail(req.params.supplierId);
    if (!d) return fail(res, 404, '供应商不存在');
    return ok(res, d);
  })
);

router.put(
  '/:supplierId',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const { payment_terms, term_days } = req.body || {};
    return ok(res, payable.setTerm(req.params.supplierId, { payment_terms, term_days }, req.user.username));
  })
);

module.exports = router;
