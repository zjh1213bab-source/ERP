/**
 * 打样 / 制版记录（sample_requests）—— P2
 * GET  /api/samples?order_id=
 * POST /api/samples
 * POST /api/samples/:id/status  { status: pending|developing|confirmed|rejected }
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'tech', 'sales'];
const VALID = ['pending', 'developing', 'confirmed', 'rejected'];

router.get(
  '/',
  authRequired,
  wrap(async (req, res) => {
    const { order_id } = req.query;
    if (!order_id) return fail(res, 400, '缺少 order_id');
    return ok(res, db.prepare('SELECT * FROM sample_requests WHERE order_id = ? ORDER BY id DESC').all(order_id));
  })
);

router.post(
  '/',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.order_id) return fail(res, 400, '缺少 order_id');
    if (!db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(b.order_id)) {
      return fail(res, 404, '订单不存在');
    }
    const t = now();
    const info = db
      .prepare(
        `INSERT INTO sample_requests (order_id, style_no, type, status, developer, due_date, remark, created_by, created_at, updated_at)
         VALUES (?,?,?,'pending',?,?,?,?,?,?)`
      )
      .run(
        b.order_id,
        b.style_no || null,
        b.type === 'sample' ? 'sample' : 'pattern',
        b.developer || null,
        b.due_date || null,
        b.remark || null,
        req.user.sub,
        t,
        t
      );
    return ok(res, db.prepare('SELECT * FROM sample_requests WHERE id = ?').get(Number(info.lastInsertRowid)));
  })
);

router.post(
  '/:id/status',
  authRequired,
  requireRole(WRITE),
  wrap(async (req, res) => {
    const { status } = req.body || {};
    if (!VALID.includes(status)) return fail(res, 400, '非法状态');
    const row = db.prepare('SELECT 1 AS x FROM sample_requests WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, '记录不存在');
    db.prepare('UPDATE sample_requests SET status=?, updated_at=? WHERE id=?').run(status, now(), req.params.id);
    return ok(res, db.prepare('SELECT * FROM sample_requests WHERE id = ?').get(req.params.id));
  })
);

module.exports = router;
