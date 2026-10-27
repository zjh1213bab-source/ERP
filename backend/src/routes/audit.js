/**
 * 操作日志查询（管理员）
 * GET /api/audit?limit=200&method=&q=
 */
const express = require('express');
const { db } = require('../db');
const { ok, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, requireRole(['admin']), wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const { method = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (method) { where.push('method = ?'); params.push(method); }
  if (q) { where.push('(username LIKE ? OR path LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const sql = 'SELECT * FROM audit_logs ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY id DESC LIMIT ' + limit;
  return ok(res, db.prepare(sql).all(...params));
}));

module.exports = router;
