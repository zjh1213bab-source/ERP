/**
 * 生产交付效率与质量报表（TS-N08-09）
 * ----------------------------------------------------------------------------
 * GET /api/prod-report/overview?period=YYYY-MM   八项指标 + 覆盖率 + 口径
 * GET /api/prod-report/on-time                   准交率（按原批准承诺）
 * GET /api/prod-report/segments                  工厂段达成 + 节点等待时长（与客户准交并列，不相减）
 * GET /api/prod-report/efficiency                工序效率（只取有工时的报工）
 * GET /api/prod-report/quality                   一次合格率 / 返工 / 报废
 * GET /api/prod-report/wip                       在制龄
 * GET /api/prod-report/plan-vs-actual            计划 vs 实际（缺计划日就报 0% 覆盖）
 * GET /api/prod-report/material                  裁片合格率与余料（材料利用率不算）
 * GET /api/prod-report/lead-time                 交期分解下钻（技术制版/资料接收/在制变更）
 * GET /api/prod-report/export?kind=&period=      CSV 导出（带 BOM）
 *
 * 全部只读。这份报表不改任何业务数据，也不产生排名或扣薪依据。
 */
const express = require('express');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { toCsv } = require('../utils/csv');
const R = require('../services/prodReport');
const scope = require('../access/companyScope');

/**
 * 当前用户能看的主体（null = 集团角色，全集团口径）
 *
 * 生产报表全是"捞原始行再算比率"，所以主体必须传进服务层、加在取行的那条查询上。
 * 在路由上算完再过滤是不行的：分母已经变成全集团了。
 */
// 主体过滤值：**单公司模式下恒为 null（不过滤）**，判据在 access/companyScope.js 的 of()
const cidOf = (req) => scope.filterCompanyId(req.user);
const Q = (req) => ({ ...(req.query || {}), companyId: cidOf(req) });

const router = express.Router();

// 生产主管 / PMC / 成本会计 / 技术（关心制版时长）/ 销售（关心准交）/ 老板
const READ = ['admin', 'boss', 'production', 'finance', 'tech', 'sales'];

router.get('/overview', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, R.overview(Q(req)))));
router.get('/on-time', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, R.onTime(Q(req)))));
router.get('/segments', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, R.routeSegments(Q(req)))));
router.get('/efficiency', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, R.efficiency(Q(req)))));
router.get('/quality', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, R.quality(Q(req)))));
router.get('/wip', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, R.wipAge(Q(req)))));
router.get('/plan-vs-actual', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, R.planVsActual(Q(req)))));
router.get('/material', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, R.material(Q(req)))));
router.get('/lead-time', authRequired, requireRole(READ), wrap(async (req, res) => ok(res, R.leadTimeBreakdown(Q(req)))));

/**
 * CSV 导出
 *
 * 导出的每一张表都带「分母/覆盖率」列 —— 单看一个 71% 没有意义，
 * 得知道它是 5/7 还是 500/700。
 */
router.get('/export', authRequired, requireRole(READ), wrap(async (req, res) => {
  const kind = String(req.query.kind || 'on_time');
  const period = req.query.period;
  // 导出与页面必须是同一个口径 —— 导出是数据出系统的最后一米
  const cid = cidOf(req);
  let head;
  let rows;
  let name;

  if (kind === 'on_time') {
    const d = R.onTime({ period, companyId: cid });
    name = `准交率-${d.period}`;
    head = ['订单号', '客户', '款号', '件数', '订单类型', '原承诺日', '实际发运日', '状态', '延期天数', '延期原因'];
    rows = d.rows.map((r) => [r.order_no, r.customer_name, r.style_no, r.qty, r.order_type,
      r.promised_date, r.actual_ship_date || '（未发运）', r.status, r.late_days, r.delay_reason || '（未填）']);
    rows.push([]);
    rows.push(['合计', `${d.on_time_count}/${d.sample} 准时`, '', '', '', '', '', d.rate === null ? '样本不足不计算' : `${d.rate}%`, '', '']);
  } else if (kind === 'efficiency') {
    const d = R.efficiency({ period, companyId: cid });
    name = `工序效率-${d.period}`;
    head = ['工序', '报工条数', '其中填工时', '合格件', '不良件', '工序合格率%', '标准单件分钟', '标准工时', '实际工时', '效率%', '说明'];
    rows = d.rows.map((r) => [r.process, r.reports, r.reports_with_hours, r.qty_ok, r.qty_defect,
      r.pass_rate ?? '', r.std_minutes ?? '（无标准）', r.std_hours ?? '', r.actual_hours,
      r.efficiency ?? '—', r.efficiency_note || '']);
    rows.push([]);
    rows.push(['工时覆盖率%', d.hour_coverage ?? '', '', '', '', '', '', '', '', '', d.calc_basis]);
  } else if (kind === 'quality') {
    const d = R.quality({ period, companyId: cid });
    name = `质量-${d.period}`;
    head = ['返工单号', '订单号', '工序', '类型', '责任', '原因', '数量', '复验合格', '报废', '状态', '复验结论', '创建时间'];
    rows = d.rows.map((r) => [r.rw_no, r.order_no, r.node_name, r.type, r.responsibility || '（未填）',
      r.reason, r.qty, r.qty_ok, r.qty_scrap, r.status, r.reinspect_result || '', r.created_at]);
    rows.push([]);
    rows.push(['一次合格率%', d.fpy ?? '不可算', '返工率%', d.rework_rate ?? '不可算', '报废率%', d.scrap_rate ?? '不可算', '', '', '', '', d.fpy_note || '']);
  } else if (kind === 'wip') {
    const d = R.wipAge();
    name = `在制龄-${d.as_of}`;
    head = ['订单号', '款名', '类型', '状态', '起算日', '起算依据', '在制天数', '交期', '逾期天数'];
    rows = d.rows.map((r) => [r.order_no, r.style_name, r.type, r.status,
      r.base_date || '（无源事件）', r.base_source, r.age_days ?? '—', r.delivery_date || '', r.overdue_days ?? '']);
    rows.push([]);
    rows.push(['合计', `${d.total} 单在制`, '', '', '', '', `平均 ${d.avg_age ?? '—'} 天`, '', '']);
  } else if (kind === 'plan') {
    const d = R.planVsActual({ period, companyId: cid });
    name = `计划与实际-${d.period}`;
    head = ['工序', '完成条数', '有计划日', '平均偏差天数', '延期数', '提前数'];
    rows = d.rows.map((r) => [r.process, r.done, r.with_plan, r.avg_dev ?? '—', r.late, r.early]);
    rows.push([]);
    rows.push(['覆盖率%', d.coverage ?? '—', '', '', '', d.note || '']);
  } else {
    return fail(res, 400, 'kind 只支持 on_time / efficiency / quality / wip / plan');
  }

  const csv = toCsv([head, ...rows]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}.csv"`);
  return res.send(csv);
}));

module.exports = router;
