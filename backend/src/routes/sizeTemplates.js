/**
 * 尺码模板
 * GET    /api/size-templates
 * POST   /api/size-templates   { name, sizes: "S,M,L" 或 ["S","M","L"] }
 * DELETE /api/size-templates/:id
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'tech', 'sales'];

router.get('/', authRequired, wrap(async (req, res) => {
  return ok(res, db.prepare('SELECT * FROM size_templates ORDER BY id').all());
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '模板名称必填');
  const sizes = Array.isArray(b.sizes) ? b.sizes.join(',') : String(b.sizes || '');
  if (!sizes.trim()) return fail(res, 400, '尺码不能为空');
  const info = db.prepare('INSERT INTO size_templates (name, sizes, created_at) VALUES (?,?,?)').run(b.name, sizes, now());
  return ok(res, db.prepare('SELECT * FROM size_templates WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM size_templates WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '模板不存在');
  db.prepare('DELETE FROM size_templates WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
