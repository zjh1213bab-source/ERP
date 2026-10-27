/**
 * 多主体核算与集团合并
 * 原型 M02「多公司主体」+ M12「分公司总账与关账」
 *
 * 权限：登录可读；建/改主体、内部往来、合并限 admin / finance；删除与注销仅 admin。
 * 口径见 services/group.js 文件头。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { localDate } = require('../services/sla');
const GR = require('../services/group');
const G = require('../services/gl');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'finance'];
const ADMIN = ['admin'];

const operatorOf = (req) => req.user?.name || req.user?.username || 'system';

/** ==================== 总览与主体 ==================== */
router.get('/overview', authRequired, requireRole(...READ), (req, res) => {
  ok(res, GR.overview());
});

router.get('/companies', authRequired, requireRole(...READ), (req, res) => {
  ok(res, GR.listCompanies({ status: req.query.status || 'all' }));
});

router.get('/companies/:id', authRequired, requireRole(...READ), (req, res) => {
  const c = GR.getCompany(req.params.id);
  if (!c) return fail(res, 404, '主体不存在');
  // 顺带给出该主体的账套概况，省一次请求
  const periods = db.prepare(
    'SELECT period, status, voucher_count, profit FROM gl_periods WHERE company_id=? ORDER BY period DESC LIMIT 12'
  ).all(c.id);
  const depts = db.prepare('SELECT id, name FROM departments WHERE company_id=? ORDER BY id').all(c.id);
  const users = db.prepare('SELECT id, username, name, role FROM users WHERE company_id=? AND COALESCE(active,1)=1').all(c.id);
  ok(res, { company: c, periods, departments: depts, users });
});

router.post('/companies', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  try {
    ok(res, GR.createCompany(req.body || {}, operatorOf(req)));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

router.put('/companies/:id', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  try {
    ok(res, GR.updateCompany(req.params.id, req.body || {}));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

/** ==================== 内部往来单位 ==================== */
router.get('/parties', authRequired, requireRole(...READ), (req, res) => {
  ok(res, GR.listParties(req.query.company_id));
});

router.post('/parties', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  try {
    ok(res, GR.createParty(req.body || {}));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

router.put('/parties/:id', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  try {
    ok(res, GR.updateParty(req.params.id, req.body || {}));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

/** ==================== 内部往来对账 ==================== */
router.get('/intercompany', authRequired, requireRole(...READ), (req, res) => {
  const period = req.query.period || localDate().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  const rows = GR.listLinks(period, { status: req.query.status || 'all' });
  ok(res, {
    period,
    rows,
    matched: rows.filter((r) => r.status === 'matched').length,
    diff: rows.filter((r) => r.status === 'diff').length,
    diff_amount: Math.round(rows.filter((r) => r.status === 'diff')
      .reduce((a, r) => a + Math.abs(Number(r.diff_amount) || 0), 0) * 100) / 100,
    ignored: rows.filter((r) => r.status === 'ignored').length
  });
});

router.post('/intercompany/scan', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const period = String(req.body?.period || localDate().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  if (!db.prepare("SELECT id FROM intercompany_parties WHERE status='active'").get()) {
    return fail(res, 400, '还没有登记内部往来单位，先在「内部往来单位」里把「本公司的哪个客户其实是集团内哪家公司」对上');
  }
  ok(res, GR.scanIntercompany(period, operatorOf(req)));
}));

router.post('/intercompany/:id/ignore', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  try {
    ok(res, GR.ignoreLink(req.params.id, req.body?.reason, operatorOf(req)));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

/** ==================== 合并 ==================== */
router.get('/consolidations', authRequired, requireRole(...READ), (req, res) => {
  ok(res, GR.listConsolidations(req.query.limit || 20));
});

router.get('/consolidations/:id', authRequired, requireRole(...READ), (req, res) => {
  const c = GR.getConsolidation(req.params.id);
  if (!c) return fail(res, 404, '合并批次不存在');
  ok(res, c);
});

router.post('/consolidations', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const period = String(req.body?.period || localDate().slice(0, 7));
  try {
    ok(res, GR.buildConsolidation(period, operatorOf(req)));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

router.post('/consolidations/:id/confirm', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  try {
    ok(res, GR.confirmConsolidation(req.params.id, operatorOf(req)));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

router.delete('/consolidations/:id', authRequired, requireRole(...ADMIN), wrap(async (req, res) => {
  try {
    ok(res, GR.deleteConsolidation(req.params.id));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

/** ==================== 分部对比 ==================== */
router.get('/segments', authRequired, requireRole(...READ), (req, res) => {
  const period = req.query.period || localDate().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  ok(res, GR.segmentCompare(period));
});

/** 合并报表导出 */
router.get('/consolidations/:id/export', authRequired, requireRole(...READ), (req, res) => {
  const c = GR.getConsolidation(req.params.id);
  if (!c) return fail(res, 404, '合并批次不存在');
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [];
  const row = (arr) => lines.push(arr.map(esc).join(','));
  row([`合并批次：${c.con_no}`, `期间：${c.period}`, `纳入合并：${c.company_count} 家`]);
  row([]);
  row(['一、各主体加总']);
  row(['项目', '金额']);
  row(['资产', c.sum_asset]);
  row(['负债', c.sum_liability]);
  row(['所有者权益', c.sum_equity]);
  row(['收入', c.sum_income]);
  row(['成本费用', c.sum_expense]);
  row([]);
  row(['二、内部抵消']);
  row(['项目', '科目', '金额', '说明']);
  c.adjustments.forEach((a) => row([
    a.type_label, a.account_code, a.debit > 0 ? a.debit : -a.credit, a.summary
  ]));
  row([]);
  row(['三、合并后']);
  row(['项目', '金额']);
  row(['资产合计', c.asset_total]);
  row(['负债合计', c.liability_total]);
  row(['所有者权益合计', c.equity_total]);
  row(['收入合计', c.income_total]);
  row(['成本费用合计', c.expense_total]);
  row(['净利润', c.net_profit]);
  row(['合并差异', c.diff_amount]);

  const csv = '\uFEFF' + lines.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="consolidation-${c.con_no}.csv"`);
  res.send(csv);
});

/** ==================== 字典 ==================== */
router.get('/dict', authRequired, requireRole(...READ), (req, res) => {
  ok(res, {
    types: Object.entries(GR.TYPE_CN).map(([k, v]) => ({ value: k, label: v })),
    status: Object.entries(GR.CO_STATUS).map(([k, v]) => ({ value: k, label: v })),
    companies: db.prepare("SELECT id, code, name, type FROM companies WHERE status='active' ORDER BY id").all(),
    accounts: db.prepare("SELECT code, name FROM gl_accounts WHERE code IN ('1122','1221','2202','2241','6001','6401','1601','4001') ORDER BY code").all()
  });
});

module.exports = router;
