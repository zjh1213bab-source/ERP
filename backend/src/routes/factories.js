/**
 * 工厂 / 外协厂主数据
 * GET    /api/factories?type=&status=
 * POST   /api/factories
 * PUT    /api/factories/:id
 * DELETE /api/factories/:id   停用
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'production', 'sales'];
const TYPES = ['own', 'outsource'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { type = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = 'SELECT * FROM factories ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY type, id';
  return ok(res, db.prepare(sql).all(...params));
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '名称必填');
  const type = TYPES.includes(b.type) ? b.type : 'outsource';
  const info = db.prepare('INSERT INTO factories (code, name, type, contact, phone, address, image_url, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(b.code || null, b.name, type, b.contact || null, b.phone || null, b.address || null, b.image_url || null, b.status || 'active', now());
  return ok(res, db.prepare('SELECT * FROM factories WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM factories WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工厂不存在');
  const b = req.body || {};
  db.prepare('UPDATE factories SET code=?, name=?, type=?, contact=?, phone=?, address=?, image_url=?, status=? WHERE id=?').run(
    b.code ?? row.code, b.name || row.name, TYPES.includes(b.type) ? b.type : row.type,
    b.contact ?? row.contact, b.phone ?? row.phone, b.address ?? row.address,
    b.image_url ?? row.image_url, b.status || row.status, req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM factories WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM factories WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工厂不存在');
  db.prepare("UPDATE factories SET status='disabled' WHERE id=?").run(req.params.id);
  return ok(res, { id: Number(req.params.id), status: 'disabled' });
}));

module.exports = router;
