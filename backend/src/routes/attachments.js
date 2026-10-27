/**
 * 附件
 * GET    /api/attachments?target_type=order&target_id=1
 * POST   /api/attachments  { target_type, target_id, filename, url, size, mime }
 * DELETE /api/attachments/:id
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

router.get('/', authRequired, wrap(async (req, res) => {
  const { target_type, target_id } = req.query;
  if (!target_type || !target_id) return fail(res, 400, '缺少 target_type / target_id');
  return ok(res, db.prepare('SELECT * FROM attachments WHERE target_type = ? AND target_id = ? ORDER BY id DESC').all(target_type, target_id));
}));

router.post('/', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.target_type || !b.target_id) return fail(res, 400, '缺少 target_type / target_id');
  if (!b.filename || !b.url) return fail(res, 400, '缺少文件名或地址');
  const info = db.prepare(
    'INSERT INTO attachments (target_type, target_id, filename, url, size, mime, uploader, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(b.target_type, b.target_id, b.filename, b.url, Number(b.size) || 0, b.mime || null, req.user.username, now());
  return ok(res, db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.delete('/:id', authRequired, wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '附件不存在');
  db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
