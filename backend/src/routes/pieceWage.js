/**
 * 计件工资（`/api/piece-wage`）
 *
 * GET    /api/piece-wage/meta                工序清单 / 款号清单（配单价用）
 * GET    /api/piece-wage/config               考勤联动配置（日上限 / 策略 / 月度封顶）
 * PUT    /api/piece-wage/config               改配置
 * GET    /api/piece-wage/attendance-board     考勤 × 计件对照看板（每人的月上限与余额）
 * GET    /api/piece-wage/rates               单价列表
 * POST   /api/piece-wage/rates               新增单价（按生效日版本化，不改历史）
 * PUT    /api/piece-wage/rates/:id           改单价（已被核算用过的只许改备注/停用）
 * GET    /api/piece-wage/preview?period=     试算（不落库）+ 诊断
 * GET    /api/piece-wage/runs                核算单列表
 * POST   /api/piece-wage/runs                生成草案 { period, note }
 * GET    /api/piece-wage/runs/:id            核算单详情（含明细与诊断）
 * GET    /api/piece-wage/runs/:id/payslips   工资条 / 车间公示表（?mode=person|public；只认已确认）
 * POST   /api/piece-wage/runs/:id/confirm    确认（缺单价直接拒）
 * POST   /api/piece-wage/runs/:id/void       作废 { reason }
 * GET    /api/piece-wage/export?run_id=      导出明细 CSV
 *
 * 权限：工钱是全公司最敏感的数据之一，读写都限岗。
 * 制单（hr / finance）与确认（finance / admin）分开 —— 自己算的钱自己确认等于没审。
 */
const express = require('express');
const PW = require('../services/pieceWage');
const ATT = require('../services/pieceAttendance');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const scope = require('../access/companyScope');
const { db, now } = require('../db');
const { toCsv } = require('../utils/csv');   // toCsv 自带 BOM，Excel 打开不乱码

const router = express.Router();

const READ = ['admin', 'boss', 'hr', 'finance'];
const WRITE = ['admin', 'hr', 'finance'];
const APPROVE = ['admin', 'finance'];

const operatorOf = (req) => (req.user && (req.user.name || req.user.username)) || 'system';

/**
 * 当前用户能看的主体（null = 集团角色，全集团口径）
 *
 * 单公司模式（默认）下下面三条**都不生效** —— cidOf 恒为 null，判据在 access/companyScope.js 的 of()。
 *
 * 多主体模式下的分法：
 * - **核算单（piece_wage_runs）按主体** —— 那是发钱的实体，v1.65 才加的这一列；
 * - **试算按员工主体** —— 钱发给谁就记谁的账（见 services/pieceWage.preview）；
 * - **工价与计件策略是全集团主数据**（piece_rates / piece_wage_config 没有 company_id）：
 *   同一个款同一个工序在一个集团里只有一个工价，否则同一批货两个分部算出两个工钱。
 *   这一条写进 docs/DB-SCHEMA.md，不要以为漏了。
 */
// 主体过滤值：**单公司模式下恒为 null（不过滤）**，判据在 access/companyScope.js 的 of()
const cidOf = (req) => scope.filterCompanyId(req.user);

router.get(
  '/meta',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const processes = db
      .prepare(
        `SELECT name, MIN(seq) AS seq, COUNT(*) AS used FROM order_nodes
          GROUP BY name ORDER BY seq, name`
      )
      .all();
    // 报工里出现过但工序表没有的（历史数据），也要能配单价
    const extra = db
      .prepare(
        `SELECT node_name AS name, 999 AS seq, COUNT(*) AS used FROM production_reports
          WHERE node_name IS NOT NULL AND node_name <> ''
          GROUP BY node_name`
      )
      .all();
    const seen = new Set(processes.map((p) => p.name));
    extra.forEach((e) => {
      if (!seen.has(e.name)) processes.push(e);
    });
    const styles = db
      .prepare(
        `SELECT DISTINCT TRIM(style_no) AS style_no FROM order_items
          WHERE style_no IS NOT NULL AND TRIM(style_no) <> '' ORDER BY style_no`
      )
      .all()
      .map((r) => r.style_no);
    const periods = db
      .prepare(
        `SELECT DISTINCT substr(report_date, 1, 7) AS period FROM production_reports
          WHERE report_date IS NOT NULL AND length(report_date) >= 7
          ORDER BY period DESC LIMIT 24`
      )
      .all()
      .map((r) => r.period);
    return ok(res, { processes, styles, periods });
  })
);

router.get(
  '/config',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, ATT.getConfig()))
);

router.put(
  '/config',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => ok(res, ATT.saveConfig(req.body || {}, operatorOf(req))))
);

// 考勤 × 计件对照：每人出勤天数 / 月上限 / 已用 / 余额。
// 复用同一份试算，保证页面上三处数字（试算、看板、明细）口径一致。
router.get(
  '/attendance-board',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const period = req.query.period;
    const p = PW.preview(period, cidOf(req));
    return ok(res, ATT.board(p, p.config || ATT.getConfig()));
  })
);

router.get(
  '/rates',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, PW.listRates(req.query)))
);

router.post(
  '/rates',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => ok(res, PW.saveRate(req.body || {}, operatorOf(req))))
);

router.put(
  '/rates/:id',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => ok(res, PW.updateRate(req.params.id, req.body || {}, operatorOf(req))))
);

router.get(
  '/preview',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, PW.preview(req.query.period, cidOf(req))))
);

router.get(
  '/runs',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, PW.listRuns({ ...(req.query || {}), companyId: cidOf(req) })))
);

router.post(
  '/runs',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const b = req.body || {};
    return ok(res, PW.createRun(b.period, operatorOf(req), b.note, cidOf(req)));
  })
);

router.get(
  '/runs/:id',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, PW.getRun(req.params.id, cidOf(req))))
);

// 工资条 / 车间公示表：只认已确认的核算单（草案数字会变，发出去是吵架）
router.get(
  '/runs/:id/payslips',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) =>
    ok(res, PW.payslips(req.params.id, req.query.mode === 'public' ? 'public' : 'person', cidOf(req)))
  )
);

router.post(
  '/runs/:id/confirm',
  authRequired,
  requireRole(APPROVE),
  wrap(async (req, res) =>
    ok(res, PW.confirmRun(req.params.id, operatorOf(req), (req.body || {}).note, cidOf(req)))
  )
);

router.post(
  '/runs/:id/void',
  authRequired,
  requireRole(APPROVE),
  wrap(async (req, res) =>
    ok(res, PW.voidRun(req.params.id, (req.body || {}).reason, operatorOf(req), cidOf(req)))
  )
);

router.get(
  '/export',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    // 导出与页面必须同一口径 —— 导出是数据出系统的最后一米
    const run = PW.getRun(req.query.run_id, cidOf(req));
    const head = [
      '员工编号', '姓名', '部门', '订单号', '扎号', '工序', '报工日期', '当天考勤', '款号',
      '报工合格数', '计件数量', '是否封顶', '单价', '金额', '取价来源', '归人方式'
    ];
    const ATT_LABEL = { normal: '正常', late: '迟到', leave: '请假', absent: '旷工', none: '无记录' };
    const CAP_LABEL = { bundle: '扎件数', daily: '单日上限', month: '缺勤封顶' };
    const rows = run.items.map((it) => [
      it.employee_code || '',
      it.employee_name || '',
      it.department || '',
      it.order_no || '',
      it.bundle_no || '',
      it.process_name || '',
      it.report_date || '',
      ATT_LABEL[it.att_status] || '',
      it.style_no || '',
      it.raw_qty,
      it.qty,
      it.capped ? (CAP_LABEL[it.cap_kind] || '是') : '',
      it.unit_price,
      it.amount,
      it.rate_source === 'style' ? '款专属' : '通用',
      it.matched_by === 'id' ? '员工编号' : '姓名匹配'
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="piece-wage-${run.period}-${run.run_no}.csv"`
    );
    return res.send(Buffer.from(toCsv([head, ...rows]), 'utf8'));
  })
);

module.exports = router;
