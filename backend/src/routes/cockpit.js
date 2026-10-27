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
const C = require('../services/cockpit');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'finance'];

const operatorOf = (req) => req.user?.name || req.user?.username || 'system';

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
    company_id: req.query.company_id ? Number(req.query.company_id) : null
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
    company_id: req.query.company_id ? Number(req.query.company_id) : null
  }));
});

/** ==================== 现金预测 ==================== */
router.get('/forecasts', authRequired, requireRole(...READ), (req, res) => {
  ok(res, C.listForecasts(req.query.limit || 20));
});

router.get('/forecasts/:id', authRequired, requireRole(...READ), (req, res) => {
  const f = C.getForecast(req.params.id);
  if (!f) return fail(res, 404, '预测批次不存在');
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
      company_id: b.company_id ? Number(b.company_id) : null,
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
  ok(res, v);
});

/** ==================== 经营指标 ==================== */
router.get('/kpis', authRequired, requireRole(...READ), (req, res) => {
  const period = req.query.period || localDate().slice(0, 7);
  if (badPeriod(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  ok(res, C.kpis(period, req.query.company_id ? Number(req.query.company_id) : null));
});

router.post('/kpis/snapshot', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const period = req.body?.period || localDate().slice(0, 7);
  if (badPeriod(period)) return fail(res, 400, '期间格式必须是 YYYY-MM');
  ok(res, C.snapshotKpis(period, req.body?.company_id ? Number(req.body.company_id) : null, operatorOf(req)));
}));

router.get('/trend', authRequired, requireRole(...READ), (req, res) => {
  ok(res, C.kpiTrend(req.query.months || 12, req.query.company_id ? Number(req.query.company_id) : null));
});

/** ==================== 字典 ==================== */
router.get('/dict', authRequired, requireRole(...READ), (req, res) => {
  ok(res, {
    buckets: C.AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
    overdue_rates: C.DEFAULT_OVERDUE_RATES,
    companies: db.prepare("SELECT id, code, name, type FROM companies WHERE status='active' ORDER BY id").all(),
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
