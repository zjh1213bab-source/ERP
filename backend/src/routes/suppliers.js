/**
 * 供应商档案
 * GET    /api/suppliers?q=&status=
 * GET    /api/suppliers/:id
 * POST   /api/suppliers
 * PUT    /api/suppliers/:id
 * DELETE /api/suppliers/:id   停用
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'tech', 'sales', 'warehouse'];

router.get('/', authRequired, wrap(async (req, res) => {
  const { q = '', status = '', category = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (q) {
    where.push('(name LIKE ? OR code LIKE ? OR short_name LIKE ? OR contact LIKE ? OR phone LIKE ?)');
    const kw = `%${q}%`;
    params.push(kw, kw, kw, kw, kw);
  }
  const sql = 'SELECT * FROM suppliers ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY status, id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/:id', authRequired, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '供应商不存在');
  return ok(res, row);
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '供应商名称必填');
  const t = now();
  const info = db.prepare(
    `INSERT INTO suppliers (code, name, short_name, category, contact, phone, address, payment_terms, lead_days, image_url, remark, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.code || null, b.name, b.short_name || null, b.category || 'material',
    b.contact || null, b.phone || null, b.address || null, b.payment_terms || null,
    Number(b.lead_days) || 0, b.image_url || null, b.remark || null,
    b.status || 'active', t, t
  );
  return ok(res, db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '供应商不存在');
  const b = req.body || {};
  db.prepare(
    `UPDATE suppliers SET code=?, name=?, short_name=?, category=?, contact=?, phone=?, address=?,
      payment_terms=?, lead_days=?, image_url=?, remark=?, status=?, updated_at=? WHERE id=?`
  ).run(
    b.code ?? row.code, b.name || row.name, b.short_name ?? row.short_name, b.category || row.category,
    b.contact ?? row.contact, b.phone ?? row.phone, b.address ?? row.address,
    b.payment_terms ?? row.payment_terms, Number(b.lead_days ?? row.lead_days) || 0,
    b.image_url ?? row.image_url, b.remark ?? row.remark, b.status || row.status,
    now(), req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM suppliers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '供应商不存在');
  db.prepare("UPDATE suppliers SET status='disabled', updated_at=? WHERE id=?").run(now(), req.params.id);
  return ok(res, { id: Number(req.params.id), status: 'disabled' });
}));

module.exports = router;
