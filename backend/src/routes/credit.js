/**
 * 客户信用与账期管控
 *
 * GET    /api/credit/board?q=&risk=&only_managed=   信用台账（所有客户一行）
 * GET    /api/credit/config                          全局参数（宽限期/预警线/默认账期）
 * PUT    /api/credit/config                          改参数
 * GET    /api/credit/check/:orderId                  发货前预检（前端发货弹窗先调这个）
 * POST   /api/credit/overrides                       开一张放行单 { order_id, reason }
 * GET    /api/credit/overrides?order_id=             放行单查询
 * GET    /api/credit/export?risk=                    台账 CSV
 * GET    /api/credit/:customerId                     单客户画像 + 事件流
 * PUT    /api/credit/:customerId                     改额度/账期 { credit_limit, credit_days, reason }
 * POST   /api/credit/:customerId/hold                冻结/解冻 { action: hold|release, reason }
 *
 * ⚠️ 路由顺序有讲究：`/check/:orderId`、`/overrides`、`/config` 这类**字面量**必须写在
 * `/:customerId` 前面。Express 按注册顺序匹配，`/:customerId` 会把 `check` 当成客户 id，
 * 于是 GET /api/credit/check/123 变成「查 id=check 的客户」→ 永远 404。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const credit = require('../services/credit');
const { toCsv } = require('../utils/csv');

const router = express.Router();
// 看：销售要能看自己客户的额度（不然报不出价、也不知道该不该催）
const READ = ['admin', 'boss', 'finance', 'sales'];
// 改：授信是钱的事，销售不能自己给自己批额度
const WRITE = ['admin', 'finance'];

// ---------- 台账 ----------
router.get(
  '/board',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const b = credit.board({
      q: req.query.q,
      risk: req.query.risk,
      only_managed: req.query.only_managed === '1',
      limit: req.query.limit
    });
    return ok(res, b);
  })
);

// ---------- 全局参数 ----------
router.get(
  '/config',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, credit.config()))
);

router.put(
  '/config',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => ok(res, credit.saveConfig(req.body || {}, req.user.username)))
);

// ---------- 发货前预检 ----------
// 名字叫 check 而不是 judge：前端拿到的是「能不能发、为什么不能」，不是判决书
router.get(
  '/check/:orderId',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, credit.judge(req.params.orderId)))
);

// ---------- 放行单 ----------
router.post(
  '/overrides',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const { order_id, reason } = req.body || {};
    return ok(res, credit.createOverride({ orderId: order_id, reason }, req.user.username));
  })
);

router.get(
  '/overrides',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const where = [];
    const args = [];
    if (req.query.order_id) {
      where.push('order_id = ?');
      args.push(Number(req.query.order_id));
    }
    if (req.query.open === '1') where.push('used_at IS NULL');
    const rows = db
      .prepare(
        `SELECT * FROM credit_overrides ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY id DESC LIMIT 200`
      )
      .all(...args);
    return ok(res, rows);
  })
);

// ---------- 台账导出 ----------
router.get(
  '/export',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const b = credit.board({ q: req.query.q, risk: req.query.risk, only_managed: req.query.only_managed === '1' });
    const head = [
      '客户编号', '客户名称', '业务员', '信用额度', '账期(天)', '信用状态',
      '已开票未收', '未开票订单', '其中货已发未开票', '敞口合计', '可用额度', '占用率%',
      '逾期金额', '最长逾期(天)', '风险等级'
    ];
    const body = b.rows.map((r) => [
      r.customer.code || '',
      r.customer.name || '',
      r.customer.owner_name || '',
      r.figures.limit,
      r.customer.credit_days,
      r.customer.credit_status === 'hold' ? '冻结' : '正常',
      r.figures.billed_open,
      r.figures.unbilled,
      r.figures.shipped_unbilled,
      r.figures.exposure,
      r.figures.available === null ? '' : r.figures.available,
      r.figures.usage_pct === null ? '' : r.figures.usage_pct,
      r.figures.overdue,
      r.figures.max_overdue_days,
      r.risk_label
    ]);
    // 口径写在文件里：这张表要能拿去开会，不能只有数字没有解释
    const note = [
      ['说明', '额度 0 = 未设额度（不管理），不是零额度', ''],
      ['说明', '敞口 = 已开票未收 + 未开票订单余额（含货已发出未开票）', ''],
      ['说明', '统计口径以导出时间点为准', b.as_of],
      ['', '', '']
    ];
    const csv = toCsv([...note, head, ...body]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="credit-board-${b.as_of}.csv"`);
    // utils/csv 的 toCsv 自己带 BOM（Excel 打开中文不乱码），这里不要再加一次
    return res.send(csv);
  })
);

// ---------- 单客户 ----------
router.get(
  '/:customerId',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const p = credit.exposureOf(req.params.customerId);
    if (!p) return fail(res, 404, '客户不存在');
    return ok(res, { ...p, events: credit.events(req.params.customerId, 60) });
  })
);

router.put(
  '/:customerId',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const { credit_limit, credit_days, reason } = req.body || {};
    const p = credit.setLimit(req.params.customerId, { credit_limit, credit_days, reason }, req.user.username);
    return ok(res, p);
  })
);

router.post(
  '/:customerId/hold',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const { action, reason } = req.body || {};
    const p = credit.setHold(req.params.customerId, { action, reason }, req.user.username);
    return ok(res, p);
  })
);

module.exports = router;
