/**
 * 产品（款号）管理
 * GET    /api/products?q=&status=
 * POST   /api/products        新增（admin/sales/tech）
 * PUT    /api/products/:id    修改
 * DELETE /api/products/:id    停用
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'sales', 'tech'];

router.get(
  '/',
  authRequired,
  wrap(async (req, res) => {
    const { q = '', status = '' } = req.query;
    const where = [];
    const params = [];
    if (q) {
      where.push('(name LIKE ? OR sku LIKE ? OR category LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const sql =
      'SELECT * FROM products ' +
      (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
      'ORDER BY id DESC';
    return ok(res, db.prepare(sql).all(...params));
  })
);

router.post(
  '/',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name) return fail(res, 400, '产品名称必填');
    if (b.sku) {
      const dup = db.prepare('SELECT 1 AS x FROM products WHERE sku = ?').get(b.sku);
      if (dup) return fail(res, 400, '款号(SKU)已存在');
    }
    const t = now();
    const info = db
      .prepare(
        `INSERT INTO products (sku, name, category, unit, price, status, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        b.sku || null,
        b.name,
        b.category || null,
        b.unit || '件',
        Number(b.price) || 0,
        b.status || 'active',
        b.remark || null,
        t,
        t
      );
    return ok(res, db.prepare('SELECT * FROM products WHERE id = ?').get(Number(info.lastInsertRowid)));
  })
);

router.put(
  '/:id',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const id = req.params.id;
    const exists = db.prepare('SELECT 1 AS x FROM products WHERE id = ?').get(id);
    if (!exists) return fail(res, 404, '产品不存在');
    const b = req.body || {};
    if (!b.name) return fail(res, 400, '产品名称必填');
    db.prepare(
      `UPDATE products SET sku=?, name=?, category=?, unit=?, price=?, status=?, remark=?, updated_at=? WHERE id=?`
    ).run(
      b.sku || null,
      b.name,
      b.category || null,
      b.unit || '件',
      Number(b.price) || 0,
      b.status || 'active',
      b.remark || null,
      now(),
      id
    );
    return ok(res, db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  })
);

router.delete(
  '/:id',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const exists = db.prepare('SELECT 1 AS x FROM products WHERE id = ?').get(req.params.id);
    if (!exists) return fail(res, 404, '产品不存在');
    db.prepare("UPDATE products SET status='disabled', updated_at=? WHERE id=?").run(
      now(),
      req.params.id
    );
    return ok(res, { id: Number(req.params.id), status: 'disabled' });
  })
);

module.exports = router;
