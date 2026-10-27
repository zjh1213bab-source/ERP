/**
 * 工作台数据看板
 * GET /api/dashboard
 */
const express = require('express');
const { db } = require('../db');
const { ok, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

function pad(n) { return String(n).padStart(2, '0'); }

router.get('/', authRequired, wrap(async (req, res) => {
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const month = today.slice(0, 7);

  // 核心指标
  const monthAgg = db.prepare(
    'SELECT COUNT(*) c, COALESCE(SUM(total_usd),0) usd, COALESCE(SUM(total_amount),0) cny FROM orders WHERE substr(created_at,1,7)=?'
  ).get(month);
  const customers = Number(db.prepare('SELECT COUNT(*) c FROM customers').get().c);
  const inProd = Number(db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('assigned','production')").get().c);
  const techPending = Number(db.prepare("SELECT COUNT(*) c FROM tech_packs WHERE status='draft'").get().c);
  const costPending = Number(db.prepare("SELECT COUNT(*) c FROM cost_sheets WHERE status='pending'").get().c);
  const toDispatch = Number(db.prepare(
    "SELECT COUNT(*) c FROM orders o WHERE o.status='finance' AND EXISTS (SELECT 1 FROM cost_sheets cs WHERE cs.order_id=o.id AND cs.status='approved')"
  ).get().c);
  const overdue = Number(db.prepare(
    "SELECT COUNT(*) c FROM orders WHERE delivery_date IS NOT NULL AND delivery_date<? AND status NOT IN ('shipped','closed','cancelled')"
  ).get(today).c);

  // 待发货缺货（美仓）
  const instock = db.prepare("SELECT id FROM orders WHERE status='instock'").all();
  const sizeStmt = db.prepare(
    'SELECT i.style_no, s.color, s.size, s.qty FROM order_items i JOIN order_item_sizes s ON s.item_id=i.id WHERE i.order_id=?'
  );
  const stStmt = db.prepare('SELECT qty FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?');
  let shortageOrders = 0;
  instock.forEach((o) => {
    let lack = 0;
    sizeStmt.all(o.id).forEach((s) => {
      const st = stStmt.get('us', s.style_no || '', s.color || '', s.size || '');
      const avail = st ? Number(st.qty) : 0;
      const demand = Number(s.qty) || 0;
      if (avail < demand) lack += demand - avail;
    });
    if (lack > 0) shortageOrders++;
  });

  // 状态分布
  const byStatus = db.prepare('SELECT status, COUNT(*) cnt FROM orders GROUP BY status').all();

  // 近 7 日趋势
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const sinceStr = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`;
  const rows = db.prepare(
    'SELECT substr(created_at,1,10) d, COUNT(*) c, COALESCE(SUM(total_amount),0) amt FROM orders WHERE substr(created_at,1,10)>=? GROUP BY d'
  ).all(sinceStr);
  const map = {};
  rows.forEach((r) => { map[r.d] = { c: Number(r.c), amt: Number(r.amt) }; });
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    trend.push({ date: key.slice(5), cnt: (map[key] && map[key].c) || 0, amount: (map[key] && map[key].amt) || 0 });
  }

  // 最近订单
  const recent = db.prepare(
    `SELECT o.id, o.order_no, o.style_name, o.status, o.total_amount, o.created_at, c.name AS customer_name
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     ORDER BY o.id DESC LIMIT 6`
  ).all();

  return ok(res, {
    month: { cnt: Number(monthAgg.c), usd: Number(monthAgg.usd), cny: Number(monthAgg.cny) },
    customers, inProd, techPending, costPending, toDispatch, overdue, shortageOrders,
    byStatus, trend, recent
  });
}));

module.exports = router;
