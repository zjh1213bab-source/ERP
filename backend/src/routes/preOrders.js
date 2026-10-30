const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const scope = require('../access/companyScope');
const { nextNo } = require('../services/noSeries');

const router = express.Router();
const READ = ['admin', 'boss', 'sales', 'tech', 'warehouse'];
const WRITE = ['admin', 'sales'];

router.get('/', authRequired, requireRole(READ), wrap(async (req, res) => {
  const where = [], args = [];
  const scoped = scope.clause(req.user, 'p.company_id');
  if (scoped.sql) { where.push(scoped.sql.replace(/^\s*AND\s+/, '')); args.push(...scoped.params); }
  if (req.query.status) { where.push('p.status=?'); args.push(String(req.query.status)); }
  const q = String(req.query.q || '').trim();
  if (q) { where.push('(p.pre_order_no LIKE ? OR p.customer_name LIKE ? OR p.style_name LIKE ?)'); args.push(...[1, 2, 3].map(() => `%${q}%`)); }
  const rows = db.prepare(`SELECT p.* FROM pre_orders p ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.created_at DESC,p.id DESC`).all(...args);
  return ok(res, rows);
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const customerName = String(b.customer_name || '').trim();
  if (!customerName) return fail(res, 400, '客户名称必填');
  const user = req.user;
  const ts = now();
  // 单号取「当日最大号 +1」（不是 COUNT(*)+1：删过一条就会撞号 → UNIQUE 报 500，已实测复现）
  const no = nextNo('pre_orders', 'pre_order_no', 'PD');
  const info = db.prepare(`INSERT INTO pre_orders(pre_order_no,company_id,customer_name,style_name,expected_qty,target_date,requirements,status,created_by,created_by_name,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'open',?,?,?,?)`).run(no, scope.writeCompanyOf(user), customerName, String(b.style_name || '').trim(), Math.max(0, Number(b.expected_qty) || 0), b.target_date || null, String(b.requirements || '').trim(), Number(user.sub || user.id) || null, user.name || user.username || '', ts, ts);
  return ok(res, db.prepare('SELECT * FROM pre_orders WHERE id=?').get(info.lastInsertRowid));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const scoped = scope.assertRow(req.user, 'pre_orders', req.params.id, '预下单');
  if (!scoped.ok) return fail(res, scoped.status, scoped.reason);
  const b = req.body || {};
  const customerName = String(b.customer_name || '').trim();
  if (!customerName) return fail(res, 400, '客户名称必填');
  db.prepare(`UPDATE pre_orders SET customer_name=?,style_name=?,expected_qty=?,target_date=?,requirements=?,updated_at=? WHERE id=?`).run(
    customerName, String(b.style_name || '').trim(), Math.max(0, Number(b.expected_qty) || 0), b.target_date || null, String(b.requirements || '').trim(), now(), Number(req.params.id)
  );
  return ok(res, db.prepare('SELECT * FROM pre_orders WHERE id=?').get(Number(req.params.id)));
}));

module.exports = router;
