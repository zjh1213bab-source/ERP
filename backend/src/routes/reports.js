/**
 * 生产报工明细
 * GET    /api/reports?node_id= | ?order_id=
 * GET    /api/reports/summary?order_id=      按工序汇总
 * POST   /api/reports
 * DELETE /api/reports/:id
 *
 * 硬规则：缝制及之后工序报工前，必须有「有效且放行量>0」的首件单——
 *        首件没放行就报工，等于绕过首件确认直接批量投产（原型 TS-N08-03）。
 */
const express = require('express');
const { localDate } = require('../utils/time');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { faGate, PRE_NODES } = require('./firstArticles');

const router = express.Router();
const WRITE = ['admin', 'production'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { node_id, order_id } = req.query;
  const where = [];
  const params = [];
  if (node_id) { where.push('node_id = ?'); params.push(node_id); }
  if (order_id) { where.push('order_id = ?'); params.push(order_id); }
  if (!where.length) return fail(res, 400, '缺少 node_id 或 order_id');
  const sql = 'SELECT * FROM production_reports WHERE ' + where.join(' AND ') + ' ORDER BY id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/summary', authRequired, wrap(async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return fail(res, 400, '缺少 order_id');
  const rows = db.prepare(
    `SELECT node_id, SUM(qty_ok) AS ok, SUM(qty_defect) AS defect, SUM(hours) AS hours, COUNT(*) AS cnt
     FROM production_reports WHERE order_id = ? GROUP BY node_id`
  ).all(order_id);
  return ok(res, rows);
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.node_id && !b.order_id) return fail(res, 400, '缺少 node_id 或 order_id');
  let node = null;
  if (b.node_id) node = db.prepare('SELECT * FROM order_nodes WHERE id = ?').get(b.node_id);
  const orderId = b.order_id || (node && node.order_id);
  if (!orderId) return fail(res, 400, '无法确定订单');

  // 首件门禁：备料/排版算料/裁剪之外的工序（车缝及以后）必须先有放行首件
  const nodeName = (node && node.name) || b.node_name || '';
  if (nodeName && !PRE_NODES.includes(nodeName)) {
    const gate = faGate(orderId);
    if (!gate.ok) {
      return fail(res, 400, `「${nodeName}」报工被拦下：${gate.reason}`);
    }
  }

  // 报工归属到人：绩效按人汇总，不能只留一个自由文本的姓名
  const operatorName = String(b.operator || req.user.name || req.user.username || '').trim();
  let employeeId = b.employee_id ? Number(b.employee_id) : null;
  if (!employeeId && operatorName) {
    const emp = db.prepare("SELECT id FROM employees WHERE status = 'active' AND name = ? LIMIT 1").get(operatorName);
    if (emp) employeeId = emp.id;
  }

  // 扎号（可选）：扫扎标报工时带上，用于追溯「这一扎是谁做的」
  // 必须是这单真实存在的扎，否则追溯链就是假的
  let bundleNo = b.bundle_no ? String(b.bundle_no).trim() : null;
  if (bundleNo) {
    const hit = db
      .prepare(
        `SELECT b.bundle_no FROM cut_bundles b JOIN cut_orders c ON c.id = b.cut_order_id
          WHERE c.order_id = ? AND b.bundle_no = ?`
      )
      .get(orderId, bundleNo);
    if (!hit) return fail(res, 400, `扎号「${bundleNo}」不属于这张订单，报工未保存`);
    bundleNo = hit.bundle_no;
  }

  const info = db.prepare(
    `INSERT INTO production_reports (order_id, node_id, node_name, report_date, qty_ok, qty_defect, hours, operator, employee_id, remark, bundle_no, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    orderId, b.node_id || null, (node && node.name) || b.node_name || null,
    // 默认日期用本地时区：toISOString 是 UTC，晚上 8 点后报工会被记成前一天
    b.report_date || localDate(now()),
    Number(b.qty_ok) || 0, Number(b.qty_defect) || 0, Number(b.hours) || 0,
    operatorName, employeeId, b.remark || null, bundleNo, now()
  );
  return ok(res, db.prepare('SELECT * FROM production_reports WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM production_reports WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '报工记录不存在');
  db.prepare('DELETE FROM production_reports WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
