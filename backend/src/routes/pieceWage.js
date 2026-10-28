/**
 * 计件工资（`/api/piece-wage`）
 *
 * GET    /api/piece-wage/meta                工序清单 / 款号清单（配单价用）
 * GET    /api/piece-wage/rates               单价列表
 * POST   /api/piece-wage/rates               新增单价（按生效日版本化，不改历史）
 * PUT    /api/piece-wage/rates/:id           改单价（已被核算用过的只许改备注/停用）
 * GET    /api/piece-wage/preview?period=     试算（不落库）+ 诊断
 * GET    /api/piece-wage/runs                核算单列表
 * POST   /api/piece-wage/runs                生成草案 { period, note }
 * GET    /api/piece-wage/runs/:id            核算单详情（含明细与诊断）
 * POST   /api/piece-wage/runs/:id/confirm    确认（缺单价直接拒）
 * POST   /api/piece-wage/runs/:id/void       作废 { reason }
 * GET    /api/piece-wage/export?run_id=      导出明细 CSV
 *
 * 权限：工钱是全公司最敏感的数据之一，读写都限岗。
 * 制单（hr / finance）与确认（finance / admin）分开 —— 自己算的钱自己确认等于没审。
 */
const express = require('express');
const PW = require('../services/pieceWage');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { db, now } = require('../db');
const { toCsv } = require('../utils/csv');   // toCsv 自带 BOM，Excel 打开不乱码

const router = express.Router();

const READ = ['admin', 'boss', 'hr', 'finance'];
const WRITE = ['admin', 'hr', 'finance'];
const APPROVE = ['admin', 'finance'];

const operatorOf = (req) => (req.user && (req.user.name || req.user.username)) || 'system';

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
  wrap(async (req, res) => ok(res, PW.preview(req.query.period)))
);

router.get(
  '/runs',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, PW.listRuns(req.query)))
);

router.post(
  '/runs',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const b = req.body || {};
    return ok(res, PW.createRun(b.period, operatorOf(req), b.note));
  })
);

router.get(
  '/runs/:id',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => ok(res, PW.getRun(req.params.id)))
);

router.post(
  '/runs/:id/confirm',
  authRequired,
  requireRole(APPROVE),
  wrap(async (req, res) =>
    ok(res, PW.confirmRun(req.params.id, operatorOf(req), (req.body || {}).note))
  )
);

router.post(
  '/runs/:id/void',
  authRequired,
  requireRole(APPROVE),
  wrap(async (req, res) =>
    ok(res, PW.voidRun(req.params.id, (req.body || {}).reason, operatorOf(req)))
  )
);

router.get(
  '/export',
  authRequired,
  requireRole(READ),
  wrap(async (req, res) => {
    const run = PW.getRun(req.query.run_id);
    const head = [
      '员工编号', '姓名', '部门', '订单号', '扎号', '工序', '款号',
      '报工合格数', '计件数量', '是否封顶', '单价', '金额', '取价来源', '归人方式'
    ];
    const rows = run.items.map((it) => [
      it.employee_code || '',
      it.employee_name || '',
      it.department || '',
      it.order_no || '',
      it.bundle_no || '',
      it.process_name || '',
      it.style_no || '',
      it.raw_qty,
      it.qty,
      it.capped ? '是' : '',
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
