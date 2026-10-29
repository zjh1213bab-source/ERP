/**
 * 多主体核算与集团合并
 * 原型 M02「多公司主体」+ M12「分公司总账与关账」
 *
 * ## 权限口径（v1.68 收窄，之前是错的）
 *
 * 原来 `READ = admin / sales / tech / finance / production / warehouse`，
 * 也就是**所有业务角色都能读集团合并报表和"某主体的利润期间 + 部门 + 在职人员名单"**。
 * 这与 `access/companyScope.js` 的规则（普通用户默认只能看自己主体）直接矛盾：
 * 业务员在订单页看不到别家的单，却能在集团页看到别家每个月的利润和花名册。
 *
 * 现在的口径：
 *   读 → `admin / boss / finance`（集团职能：老板看全局、财务做合并）
 *   写 → `admin / finance`
 *   删 → `admin`
 *
 * 另外即使是这三个角色，**主体明细**（`/companies/:id` 的利润期间、部门、在职人员）
 * 还要过一遍公司范围校验：finance 在自己主体做账，没有理由读别家的花名册。
 * 集团层面的汇总走 `/overview` 与 `/consolidations`，那两个本来就是合并口径。
 *
 * 单公司模式下这些入口在前端是隐藏的（`ErpLayout` 按 `single_company` 过滤），
 * 但接口按上面的口径保留 —— 直接调接口的人和点页面的人应该看到同一套规则。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { localDate } = require('../services/sla');
const CS = require('../access/companyScope');
const GR = require('../services/group');
const G = require('../services/gl');

const router = express.Router();
/** 集团级只读：老板 / 管理员 / 财务。销售、技术、生产、仓库不再在列 */
const READ = ['admin', 'boss', 'finance'];
const WRITE = ['admin', 'finance'];
const ADMIN = ['admin'];

const operatorOf = (req) => req.user?.name || req.user?.username || 'system';

/** ==================== 总览与主体 ==================== */
router.get('/overview', authRequired, requireRole(...READ), (req, res) => {
  ok(res, GR.overview());
});

router.get('/companies', authRequired, requireRole(...READ), (req, res) => {
  /**
   * 列表也要按范围过滤（不只是详情）
   *
   * 只挡详情不挡列表是常见的半截做法：列表会告诉你"集团里还有哪几家、叫什么、
   * 什么状态"，而这三条信息本身就是别家的经营信息。
   * 集团角色（admin/boss）范围是 cross，看得到全部；finance 只看到自己主体。
   */
  const rows = GR.listCompanies({ status: req.query.status || 'all' });
  ok(res, rows.filter((c) => CS.canSee(req.user, { company_id: c.id })));
});

router.get('/companies/:id', authRequired, requireRole(...READ), (req, res) => {
  const c = GR.getCompany(req.params.id);
  if (!c) return fail(res, 404, '主体不存在');
  /**
   * 归属不符 → 404（不是 403）
   *
   * 与订单域同一条铁律：403 等于承认"这个主体存在、只是你没权限"，
   * 逐个 id 试就能数出集团有几家、都是谁。
   */
  if (!CS.canSee(req.user, { company_id: c.id })) return fail(res, 404, '主体不存在');
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
