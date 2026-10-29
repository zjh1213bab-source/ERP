/**
 * 经营驾驶舱：账龄 / 现金预测 / 经营指标 / 预测回看
 * 原型 M12「账龄现金与经营分析」
 *
 * 权限：读全部登录用户（老板与大区都要看）；跑预测与落快照限 finance / admin。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { localDate } = require('../services/sla');
const CS = require('../access/companyScope');
const C = require('../services/cockpit');

const router = express.Router();
const READ = ['admin', 'boss', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'finance'];

const operatorOf = (req) => req.user?.name || req.user?.username || 'system';

/**
 * 本次请求看哪个主体 —— 一律服务端判定
 *
 * 这里原来有 8 处 `req.query.company_id ? Number(...) : null`，而服务层把 null 当成
 * 「不过滤」：不传参 = 看整个集团合并数，传别家的 id = 看别家的账。
 * 驾驶舱是财务数据（账龄、现金缺口、毛利），这个口子必须堵在路由上，
 * 因为服务层不知道自己被谁调用。
 */
const coOf = (req) => CS.resolveCompany(req.user, req.query.company_id, { action: '查看经营驾驶舱' });

/** 期间格式校验 */
function badPeriod(p) {
  return !/^\d{4}-\d{2}$/.test(String(p || ''));
}

/** ==================== 总览 ==================== */
router.get('/overview', authRequired, requireRole(...READ), (req, res) => {
  // 不传期间时交给服务层决定（它会挑「最近已关账期间」）。
  // 路由这里如果先兜一个「当月」，就把那层逻辑盖掉了 —— 当期的毛利率与周转天数全是 —。
  const period = req.query.period || null;
  if (period && badPeriod(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  ok(res, C.overview({
    period: period || undefined,
    company_id: coOf(req)
  }));
});

/** ==================== 账龄 ==================== */
router.get('/aging', authRequired, requireRole(...READ), (req, res) => {
  const kind = String(req.query.kind || 'ar');
  if (!['ar', 'ap'].includes(kind)) return fail(res, 400, 'kind 只能是 ar / ap');
  const asOf = req.query.as_of || localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return fail(res, 400, '基准日格式必须是 YYYY-MM-DD');
  ok(res, C.aging(kind, {
    asOf,
    company_id: coOf(req)
  }));
});

/** ==================== 现金预测 ==================== */
/**
 * 批次列表 / 详情 / 回看：按批次自己的 `company_id` 判归属
 *
 * 这三条原来**完全不筛主体** —— 列表把所有主体的预测批次都列出来（含期末现金、
 * 缺口金额），点进去还能看逐周明细。批次上的 `company_id` 为空的（早期合并口径跑的）
 * 一律只给集团角色看：那些数本来就不属于任何单一主体。
 */
router.get('/forecasts', authRequired, requireRole(...READ), (req, res) => {
  const rows = C.listForecasts(req.query.limit || 20)
    .filter((f) => CS.canSee(req.user, { company_id: f.company_id }));
  ok(res, rows);
});

router.get('/forecasts/:id', authRequired, requireRole(...READ), (req, res) => {
  const f = C.getForecast(req.params.id);
  if (!f) return fail(res, 404, '预测批次不存在');
  // 归属不符同样回 404：403 等于告诉对方"这批存在、只是你没权限"
  if (!CS.canSee(req.user, { company_id: f.company_id })) return fail(res, 404, '预测批次不存在');
  ok(res, f);
});

router.post('/forecasts', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const baseDate = b.base_date || localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) return fail(res, 400, '基准日格式必须是 YYYY-MM-DD');
  if (b.collect_rate !== undefined) {
    const r = Number(b.collect_rate);
    if (!Number.isFinite(r) || r < 0 || r > 100) return fail(res, 400, '按期回收率必须在 0-100 之间');
  }
  try {
    const f = C.buildForecast({
      base_date: baseDate,
      weeks: b.weeks,
      company_id: CS.resolveCompany(req.user, b.company_id, { action: '跑现金预测' }),
      collect_rate: b.collect_rate,
      overdue_rates: b.overdue_rates,
      note: b.note
    }, operatorOf(req));
    ok(res, {
      id: f.id, forecast_no: f.forecast_no, base_date: f.base_date, weeks: f.weeks,
      opening_cash: f.opening_cash, inflow_total: f.inflow_total, outflow_total: f.outflow_total,
      closing_cash: f.closing_cash, min_cash: f.min_cash, min_week: f.min_week,
      first_neg_week: f.first_neg_week, gap_amount: f.gap_amount,
      ar_open: f.ar_open, ap_open: f.ap_open,
      collect_rate: f.collect_rate, overdue_rates: f.overdue_rates,
      ar_by_bucket: f.ar_by_bucket,
      weeks_detail: f.weeks_detail
    });
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

/** 删预测批次（跑错了要能删；只允许 admin） */
router.delete('/forecasts/:id', authRequired, requireRole('admin'), (req, res) => {
  const f = db.prepare('SELECT * FROM cash_forecasts WHERE id=?').get(Number(req.params.id));
  if (!f) return fail(res, 404, '预测批次不存在');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM cash_forecast_items WHERE forecast_id=?').run(f.id);
    db.prepare('DELETE FROM cash_forecasts WHERE id=?').run(f.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  ok(res, { deleted: 1, forecast_no: f.forecast_no });
});

/** 预测回看：预计收多少 vs 实际收多少 */
router.get('/forecasts/:id/variance', authRequired, requireRole(...READ), (req, res) => {
  const v = C.forecastVariance(req.params.id);
  if (!v) return fail(res, 404, '预测批次不存在');
  // 回看里带「哪几笔实际收了」—— 同样是别家的账，归属要在这一层挡住
  // 注意字段位置：forecastVariance 返回的是 { forecast, weeks, ... }，主体在 v.forecast 里
  if (!CS.canSee(req.user, { company_id: v.forecast && v.forecast.company_id })) {
    return fail(res, 404, '预测批次不存在');
  }
  ok(res, v);
});

/** ==================== 经营指标 ==================== */
router.get('/kpis', authRequired, requireRole(...READ), (req, res) => {
  const period = req.query.period || localDate().slice(0, 7);
  if (badPeriod(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  ok(res, C.kpis(period, coOf(req)));
});

router.post('/kpis/snapshot', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const period = req.body?.period || localDate().slice(0, 7);
  if (badPeriod(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  ok(res, C.snapshotKpis(period, CS.resolveCompany(req.user, req.body?.company_id, { action: '落经营指标快照' }), operatorOf(req)));
}));

router.get('/trend', authRequired, requireRole(...READ), (req, res) => {
  ok(res, C.kpiTrend(req.query.months || 12, CS.resolveCompany(req.user, req.query.company_id, { action: '查看指标趋势' })));
});

/** ==================== 字典 ==================== */
router.get('/dict', authRequired, requireRole(...READ), (req, res) => {
  ok(res, {
    buckets: C.AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
    overdue_rates: C.DEFAULT_OVERDUE_RATES,
    // 单公司模式下只返回抬头一条（下拉只有一个选项，避免"4 家分公司"的错觉）
    companies: require('../access/companyScope').listForPicker(),
    today: localDate(),
    categories: [
      { key: 'ar_collect', label: '应收回款', direction: 'in' },
      { key: 'ap_pay', label: '应付付款', direction: 'out' },
      { key: 'payroll', label: '工资', direction: 'out' },
      { key: 'fixed_cost', label: '固定费用', direction: 'out' }
    ]
  });
});

module.exports = router;
