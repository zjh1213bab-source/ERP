/**
 * 工序类别档案
 * GET    /api/craft-types?q=&category=&status=
 * GET    /api/craft-types/:id
 * POST   /api/craft-types
 * PUT    /api/craft-types/:id
 * DELETE /api/craft-types/:id   停用
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'tech', 'production', 'sales'];
const CATS = ['sewing', 'print', 'embroidery', 'wash', 'finish', 'pack', 'other'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { q = '', category = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (q) {
    where.push('(name LIKE ? OR code LIKE ?)');
    const kw = `%${q}%`;
    params.push(kw, kw);
  }
  const sql = 'SELECT * FROM craft_types ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY sort, category, id';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/:id', authRequired, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM craft_types WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工序类别不存在');
  return ok(res, row);
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '工序名称必填');
  const cat = CATS.includes(b.category) ? b.category : 'sewing';
  const t = now();
  const info = db.prepare(
    `INSERT INTO craft_types (code, name, category, unit, default_price, is_out, image_url, remark, status, sort, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.code || null, b.name, cat, b.unit || '件', Number(b.default_price) || 0,
    b.is_out ? 1 : 0, b.image_url || null, b.remark || null, b.status || 'active',
    Number(b.sort) || 0, t, t
  );
  return ok(res, db.prepare('SELECT * FROM craft_types WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM craft_types WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工序类别不存在');
  const b = req.body || {};
  const cat = CATS.includes(b.category) ? b.category : row.category;
  db.prepare(
    `UPDATE craft_types SET code=?, name=?, category=?, unit=?, default_price=?, is_out=?, image_url=?, remark=?, status=?, sort=?, updated_at=? WHERE id=?`
  ).run(
    b.code ?? row.code, b.name || row.name, cat, b.unit ?? row.unit,
    Number(b.default_price ?? row.default_price) || 0,
    b.is_out !== undefined ? (b.is_out ? 1 : 0) : row.is_out,
    b.image_url ?? row.image_url, b.remark ?? row.remark, b.status || row.status,
    Number(b.sort ?? row.sort) || 0, now(), req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM craft_types WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM craft_types WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工序类别不存在');
  db.prepare("UPDATE craft_types SET status='disabled', updated_at=? WHERE id=?").run(now(), req.params.id);
  return ok(res, { id: Number(req.params.id), status: 'disabled' });
}));

module.exports = router;
