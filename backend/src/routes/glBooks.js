/**
 * 总账与财务报表
 * 原型 M12「财务报表与关账检查」
 *
 * 权限：读全部登录用户；生成凭证、结转、关账、作废限 finance / admin。
 * 口径见 services/gl.js 文件头。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { localNow, localDate } = require('../services/sla');
const G = require('../services/gl');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'finance'];
const ADMIN = ['admin'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 取本次请求的主体：query / body / 默认总部
 * 传 'all' 只在期间列表用（跨主体看），其他接口一律落到具体主体。
 */
function coOf(req) {
  const raw = req.query?.company_id ?? req.body?.company_id;
  return G.companyOf(raw);
}
function coName(id) {
  return G.companyName(id);
}

/** ==================== 期间 ==================== */
router.get('/periods', authRequired, requireRole(...READ), (req, res) => {
  const cur = localDate().slice(0, 7);
  const all = String(req.query.company_id || '') === 'all';

  if (all) {
    const rows = db.prepare('SELECT * FROM gl_periods ORDER BY period DESC, company_id').all();
    return ok(res, rows.map((r) => ({
      ...r,
      company_name: coName(r.company_id),
      label: `${r.period.slice(0, 4)} 年 ${G.MONTH_CN[r.period.slice(5, 7)]}`,
      is_current: r.period === cur
    })));
  }

  const co = coOf(req);
  let rows = db.prepare('SELECT * FROM gl_periods WHERE company_id=? ORDER BY period DESC').all(co);
  if (!rows.some((r) => r.period === cur)) {
    // 当前月自动补一条，前端第一次进来就能用
    G.ensurePeriod(cur, co);
    rows.unshift(db.prepare('SELECT * FROM gl_periods WHERE company_id=? AND period=?').get(co, cur));
  }
  ok(res, rows.map((r) => ({
    ...r,
    company_name: coName(r.company_id),
    label: `${r.period.slice(0, 4)} 年 ${G.MONTH_CN[r.period.slice(5, 7)]}`,
    is_current: r.period === cur
  })));
});

router.post('/periods', authRequired, requireRole(...WRITE), (req, res) => {
  const period = String(req.body?.period || '').trim();
  if (!/^\d{4}-\d{2}$/.test(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  const mm = Number(period.slice(5, 7));
  if (mm < 1 || mm > 12) return fail(res, 400, '月份不合法');
  const co = coOf(req);
  const p = G.ensurePeriod(period, co);
  ok(res, { ...p, company_name: coName(co) });
});

/** ==================== 科目 ==================== */
router.get('/accounts', authRequired, requireRole(...READ), (req, res) => {
  const rows = db.prepare('SELECT * FROM gl_accounts ORDER BY sort_no, code').all();
  ok(res, rows.map((r) => ({ ...r, type_label: G.TYPE_LABEL[r.type] })));
});

/** ==================== 凭证 ==================== */
router.get('/vouchers', authRequired, requireRole(...READ), (req, res) => {
  const { period, source_type, status = 'all', q } = req.query;
  const co = coOf(req);
  const wh = ['v.company_id=?'];
  const args = [co];
  if (period) { wh.push('v.period=?'); args.push(period); }
  if (source_type && source_type !== 'all') { wh.push('v.source_type=?'); args.push(source_type); }
  if (status && status !== 'all') { wh.push('v.status=?'); args.push(status); }
  if (q) { wh.push('(v.voucher_no LIKE ? OR v.summary LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT v.*, (SELECT COUNT(*) FROM gl_entries e WHERE e.voucher_id=v.id) AS line_count
     FROM gl_vouchers v ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY v.biz_date DESC, v.id DESC LIMIT 500`
  ).all(...args);
  ok(res, rows.map((r) => ({
    ...r,
    company_name: coName(r.company_id),
    source_label: SOURCE_LABEL[r.source_type] || r.source_type
  })));
});

const SOURCE_LABEL = {
  ar_invoice: '应收开票', ap_invoice: '应付开票', payment: '收付款',
  cost_sold: '成本结转', payroll: '工资计提', expense: '行政费用',
  depreciation: '折旧', profit_carry: '损益结转', manual: '手工凭证'
};
router.__sourceLabel = SOURCE_LABEL;

router.get('/vouchers/:id', authRequired, requireRole(...READ), (req, res) => {
  const v = db.prepare('SELECT * FROM gl_vouchers WHERE id=?').get(Number(req.params.id));
  if (!v) return fail(res, 404, '凭证不存在');
  const entries = db.prepare('SELECT * FROM gl_entries WHERE voucher_id=? ORDER BY line_no').all(v.id);
  ok(res, {
    voucher: { ...v, company_name: coName(v.company_id), source_label: SOURCE_LABEL[v.source_type] || v.source_type },
    entries
  });
});

/** 手工凭证（期初、调整用）：必须借贷平 */
router.post('/vouchers', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const period = String(b.period || '').trim();
  if (!/^\d{4}-\d{2}$/.test(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  const co = coOf(req);
  try { G.assertOpen(period, co); } catch (e) { return fail(res, 400, e.message); }

  const entries = Array.isArray(b.entries) ? b.entries : [];
  if (entries.length < 2) return fail(res, 400, '一张凭证至少两行分录');
  for (const e of entries) {
    if (!e.code) return fail(res, 400, '每行分录必须有科目编码');
    if (num(e.debit) < 0 || num(e.credit) < 0) return fail(res, 400, '金额不能为负');
    if (num(e.debit) > 0 && num(e.credit) > 0) return fail(res, 400, '同一行不能既有借方又有贷方');
    if (num(e.debit) <= 0 && num(e.credit) <= 0) return fail(res, 400, '每行必须有借或贷金额');
  }
  const d = Math.round(entries.reduce((a, e) => a + num(e.debit), 0) * 100) / 100;
  const c = Math.round(entries.reduce((a, e) => a + num(e.credit), 0) * 100) / 100;
  if (Math.abs(d - c) > 0.01) return fail(res, 400, `借贷不平：借 ${d} / 贷 ${c}`);

  try {
    const vid = G.writeVoucher({
      period,
      biz_date: b.biz_date || G.periodRange(period).end,
      summary: b.summary || '手工凭证',
      source_type: 'manual',
      source_id: null,
      entries,
      operator: req.user?.name || req.user?.username,
      company_id: co
    });
    ok(res, { id: vid, company_id: co });
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

router.post('/vouchers/:id/void', authRequired, requireRole(...WRITE), (req, res) => {
  const v = db.prepare('SELECT * FROM gl_vouchers WHERE id=?').get(Number(req.params.id));
  if (!v) return fail(res, 404, '凭证不存在');
  if (v.status === 'void') return fail(res, 400, '这张凭证已经作废了');
  try { G.assertOpen(v.period, v.company_id); } catch (e) { return fail(res, 400, e.message); }
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 4) return fail(res, 400, '作废必须写原因（至少 4 个字）');
  G.voidVoucher(v.id, reason);
  ok(res, { id: v.id, status: 'void' });
});

/** ==================== 生成 / 结转 ==================== */
router.post('/periods/:period/generate', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const period = req.params.period;
  const co = coOf(req);
  try { G.assertOpen(period, co); } catch (e) { return fail(res, 400, e.message); }
  G.ensurePeriod(period, co);
  const r = G.generateVouchers(period, {
    force: !!req.body?.force,
    types: req.body?.types,
    operator: req.user?.name || req.user?.username,
    company_id: co
  });
  ok(res, { period, company_id: co, company_name: coName(co), ...r });
}));

router.post('/periods/:period/carry', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const period = req.params.period;
  const co = coOf(req);
  try { G.assertOpen(period, co); } catch (e) { return fail(res, 400, e.message); }
  const r = G.carryProfit(period, req.user?.name || req.user?.username, co);
  ok(res, { period, company_id: co, company_name: coName(co), ...r });
}));

/** ==================== 关账 ==================== */
router.get('/periods/:period/checks', authRequired, requireRole(...READ), (req, res) => {
  const period = req.params.period;
  const co = coOf(req);
  const rows = G.runChecks(period, co);
  const p = G.ensurePeriod(period, co);
  ok(res, {
    period, company_id: co, company_name: coName(co), status: p.status,
    closed_by: p.closed_by, closed_at: p.closed_at,
    checks: rows,
    error_fail: rows.filter((r) => r.severity === 'error' && !r.passed).length,
    warn_fail: rows.filter((r) => r.severity === 'warn' && !r.passed).length
  });
});

router.post('/periods/:period/close', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  try {
    const r = G.closePeriod(req.params.period, req.user?.name || req.user?.username, coOf(req));
    ok(res, r);
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

router.post('/periods/:period/reopen', authRequired, requireRole(...ADMIN), wrap(async (req, res) => {
  try {
    const r = G.reopenPeriod(req.params.period, req.user?.name || req.user?.username, req.body?.reason, coOf(req));
    ok(res, r);
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

/** ==================== 报表 ==================== */
router.get('/reports/:type', authRequired, requireRole(...READ), (req, res) => {
  const type = req.params.type;
  const period = req.query.period || localDate().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  const co = coOf(req);
  const p = db.prepare('SELECT * FROM gl_periods WHERE company_id=? AND period=?').get(co, period);
  const meta = {
    period,
    company_id: co,
    company_name: coName(co),
    period_label: `${period.slice(0, 4)} 年 ${G.MONTH_CN[period.slice(5, 7)]}`,
    status: p?.status || 'open'
  };
  try {
    if (type === 'trial-balance') return ok(res, { ...meta, ...G.trialBalance(period, co) });
    if (type === 'balance-sheet') return ok(res, { ...meta, ...G.balanceSheet(period, co) });
    if (type === 'income') return ok(res, { ...meta, ...G.incomeStatement(period, co) });
    if (type === 'cash-flow') return ok(res, { ...meta, ...G.cashFlow(period, co) });
    return fail(res, 404, '报表类型不支持');
  } catch (e) {
    return fail(res, 400, e.message);
  }
});

/** 报表导出 CSV */
router.get('/reports/:type/export', authRequired, requireRole(...READ), (req, res) => {
  const type = req.params.type;
  const period = req.query.period || localDate().slice(0, 7);
  const co = coOf(req);
  const lines = [];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const row = (arr) => lines.push(arr.map(esc).join(','));
  row([`主体：${coName(co)}`, `期间：${period}`]);

  if (type === 'trial-balance') {
    const tb = G.trialBalance(period, co);
    row(['科目编码', '科目名称', '类型', '期初余额', '本期借方', '本期贷方', '期末余额']);
    tb.rows.forEach((r) => row([r.code, r.name, r.type_label, r.begin, r.period_debit, r.period_credit, r.end]));
    row(['合计', '', '', '', tb.sum.debit, tb.sum.credit, '']);
  } else if (type === 'balance-sheet') {
    const bs = G.balanceSheet(period, co);
    row(['项目', '科目', '期末余额']);
    row(['一、资产', '', '']);
    bs.assets.forEach((a) => row([a.name, a.code, a.amount]));
    row(['资产合计', '', bs.asset_total]);
    row(['二、负债', '', '']);
    bs.liabilities.forEach((a) => row([a.name, a.code, a.amount]));
    row(['负债合计', '', bs.liability_total]);
    row(['三、所有者权益', '', '']);
    bs.equity.forEach((a) => row([a.name, a.code, a.amount]));
    row(['权益合计（含未结转损益）', '', bs.equity_total]);
    row(['负债和权益合计', '', bs.liability_equity_total]);
  } else if (type === 'income') {
    const is = G.incomeStatement(period, co);
    row(['项目', '科目', '本期金额']);
    is.income.forEach((a) => row([a.name, a.code, a.amount]));
    row(['收入合计', '', is.income_total]);
    is.expense.forEach((a) => row([a.name, a.code, a.amount]));
    row(['成本费用合计', '', is.expense_total]);
    row(['净利润', '', is.net_profit]);
  } else if (type === 'cash-flow') {
    const cf = G.cashFlow(period, co);
    row(['项目', '金额']);
    cf.operating_in.forEach((x) => row(['流入·' + x.name, x.amount]));
    row(['经营活动流入合计', cf.operating_in_total]);
    cf.operating_out.forEach((x) => row(['流出·' + x.name, x.amount]));
    row(['经营活动流出合计', cf.operating_out_total]);
    row(['经营活动净额', cf.operating_net]);
    row(['投资活动净额', cf.investing_net]);
    row(['现金净增加', cf.net_increase]);
    row(['期末现金', cf.closing_cash]);
  } else {
    return fail(res, 404, '报表类型不支持');
  }

  const csv = '\uFEFF' + lines.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gl-${type}-${period}-c${co}.csv"`);
  res.send(csv);
});

/** ==================== 总览 ==================== */
router.get('/overview', authRequired, requireRole(...READ), (req, res) => {
  const period = req.query.period || localDate().slice(0, 7);
  const co = coOf(req);
  const p = db.prepare('SELECT * FROM gl_periods WHERE company_id=? AND period=?').get(co, period);
  const is = G.incomeStatement(period, co);
  const bs = G.balanceSheet(period, co);
  const cf = G.cashFlow(period, co);
  const vc = db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(debit_total),0) d FROM gl_vouchers WHERE company_id=? AND period=? AND status='posted'"
  ).get(co, period);
  const unposted = db.prepare(
    "SELECT COUNT(*) c FROM gl_vouchers WHERE company_id=? AND period=? AND status<>'posted'"
  ).get(co, period).c;

  // 最近 6 期利润趋势
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const per = G.shiftPeriod(period, -i);
    const r = G.incomeStatement(per, co);
    trend.push({ period: per, income: r.income_total, expense: r.expense_total, net: r.net_profit });
  }

  ok(res, {
    period,
    company_id: co,
    company_name: coName(co),
    period_label: `${period.slice(0, 4)} 年 ${G.MONTH_CN[period.slice(5, 7)]}`,
    status: p?.status || 'open',
    closed_at: p?.closed_at || null,
    voucher_count: vc.c,
    debit_total: Math.round(num(vc.d) * 100) / 100,
    unposted,
    income: is.income_total,
    expense: is.expense_total,
    net_profit: is.net_profit,
    asset_total: bs.asset_total,
    liability_total: bs.liability_total,
    equity_total: bs.equity_total,
    cash: cf.closing_cash,
    ar: bs.assets.find((a) => a.code === '1122')?.amount || 0,
    ap: bs.liabilities.find((a) => a.code === '2202')?.amount || 0,
    balanced: bs.balanced,
    trend
  });
});

module.exports = router;
