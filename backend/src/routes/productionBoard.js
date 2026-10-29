/**
 * 生产看板：汇总已分单/生产中/已入库 订单的工序进度
 * GET /api/production/board?status=
 */
const express = require('express');
const { db } = require('../db');
const { ok, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');
const scope = require('../access/companyScope');

const router = express.Router();

router.get('/board', authRequired, wrap(async (req, res) => {
  const { status = '' } = req.query;
  const where = ["o.status IN ('assigned','production','instock')"];
  const params = [];
  // 主体条件放最前：后面的参数位置跟着它走。
  // **单公司模式下 cid 恒为 null，下面这段不生效** —— 判据在 access/companyScope.js 的 of()。
  const cid = scope.filterCompanyId(req.user);
  if (cid) { where.push('o.company_id = ?'); params.push(cid); }
  if (status) { where.push('o.status = ?'); params.push(status); }

  const sql = `
    SELECT o.id, o.order_no, o.style_name, o.status, o.delivery_date, o.total_amount, o.total_usd,
           c.name AS customer_name,
           (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
           (SELECT COUNT(*) FROM order_nodes n WHERE n.order_id = o.id) AS node_total,
           (SELECT COUNT(*) FROM order_nodes n WHERE n.order_id = o.id AND n.status = 'done') AS node_done,
           (SELECT n.name FROM order_nodes n WHERE n.order_id = o.id AND n.status != 'done' ORDER BY n.seq, n.id LIMIT 1) AS current_node
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY (o.delivery_date IS NULL), o.delivery_date ASC, o.id DESC
  `;
  return ok(res, db.prepare(sql).all(...params));
}));

module.exports = router;
