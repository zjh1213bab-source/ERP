/**
 * 面辅料主数据
 * GET    /api/materials?type=fabric|accessory
 * POST   /api/materials
 * PUT    /api/materials/:id
 * DELETE /api/materials/:id   停用
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'tech', 'sales'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { type = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = 'SELECT * FROM materials ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY type, id';
  return ok(res, db.prepare(sql).all(...params));
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.type || !['fabric', 'accessory'].includes(b.type)) return fail(res, 400, 'type 必须为 fabric 或 accessory');
  if (!b.name) return fail(res, 400, '名称必填');
  const info = db.prepare(
    'INSERT INTO materials (type, code, name, spec, supplier, status, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(b.type, b.code || null, b.name, b.spec || null, b.supplier || null, b.status || 'active', now());
  return ok(res, db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  const b = req.body || {};
  db.prepare('UPDATE materials SET code=?, name=?, spec=?, supplier=?, status=? WHERE id=?').run(
    b.code ?? row.code, b.name || row.name, b.spec ?? row.spec, b.supplier ?? row.supplier, b.status || row.status, req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  db.prepare("UPDATE materials SET status='disabled' WHERE id=?").run(req.params.id);
  return ok(res, { id: Number(req.params.id), status: 'disabled' });
}));

module.exports = router;
