/**
 * 面辅料档案（主数据）
 * 开发单的「面辅料明细」从这里选择调用，档案字段在开发单里只读，只有色号/图片/用量/单价可在本单补充。
 *
 * GET    /api/materials?type=&status=&q=     列表（q 搜 名称/编号/简称/供应商/色号）
 * GET    /api/materials/:id                  单条
 * POST   /api/materials                      新增
 * PUT    /api/materials/:id                  修改（档案维护用）
 * POST   /api/materials/:id/duplicate        复制成新档案
 * DELETE /api/materials/:id                  停用（不物理删除，保留历史引用）
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'tech', 'sales'];

const FIELDS = [
  'type', 'code', 'name', 'short_name', 'spec', 'supplier', 'supplier_info',
  'color', 'color_no', 'image_url', 'width', 'weight', 'air_gap', 'composition',
  'unit', 'stock_qty', 'stock_detail', 'remark', 'status'
];

router.get('/', authRequired, wrap(async (req, res) => {
  const { type = '', status = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (q) {
    where.push('(name LIKE ? OR code LIKE ? OR short_name LIKE ? OR supplier LIKE ? OR color_no LIKE ?)');
    const kw = `%${q}%`;
    params.push(kw, kw, kw, kw, kw);
  }
  const sql = 'SELECT * FROM materials ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY type, supplier, id';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/:id', authRequired, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '档案不存在');
  return ok(res, row);
}));

function pick(b, row) {
  const out = {};
  FIELDS.forEach((f) => {
    if (b[f] !== undefined) out[f] = b[f] === '' ? null : b[f];
    else out[f] = row ? row[f] : null;
  });
  return out;
}

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.type || !['fabric', 'accessory'].includes(b.type)) return fail(res, 400, 'type 必须为 fabric 或 accessory');
  if (!b.name) return fail(res, 400, '物料名称必填');
  const v = pick(b, null);
  const info = db.prepare(
    `INSERT INTO materials
     (type, code, name, short_name, spec, supplier, supplier_info, color, color_no, image_url,
      width, weight, air_gap, composition, unit, stock_qty, stock_detail, remark, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.type, v.code, b.name, v.short_name, v.spec, v.supplier, v.supplier_info,
    v.color, v.color_no, v.image_url, v.width, v.weight, v.air_gap, v.composition,
    v.unit, Number(v.stock_qty) || 0, v.stock_detail, v.remark,
    v.status || 'active', now(), now()
  );
  return ok(res, db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  const b = req.body || {};
  const v = pick(b, row);
  db.prepare(
    `UPDATE materials SET code=?, name=?, short_name=?, spec=?, supplier=?, supplier_info=?, color=?, color_no=?,
      image_url=?, width=?, weight=?, air_gap=?, composition=?, unit=?, stock_qty=?, stock_detail=?,
      remark=?, status=?, updated_at=? WHERE id=?`
  ).run(
    v.code, b.name || row.name, v.short_name, v.spec, v.supplier, v.supplier_info,
    v.color, v.color_no, v.image_url, v.width, v.weight, v.air_gap, v.composition,
    v.unit, Number(v.stock_qty) || 0, v.stock_detail, v.remark,
    v.status || row.status, now(), req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id));
}));

/** 复制档案：同名同规格的换色号场景很常见，复制后改色号即可 */
router.post('/:id/duplicate', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  const info = db.prepare(
    `INSERT INTO materials
     (type, code, name, short_name, spec, supplier, supplier_info, color, color_no, image_url,
      width, weight, air_gap, composition, unit, stock_qty, stock_detail, remark, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.type, row.code, row.name, row.short_name, row.spec, row.supplier, row.supplier_info,
    row.color, row.color_no, row.image_url, row.width, row.weight, row.air_gap, row.composition,
    row.unit, 0, row.stock_detail, row.remark, 'active', now(), now()
  );
  return ok(res, db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  db.prepare("UPDATE materials SET status='disabled', updated_at=? WHERE id=?").run(now(), req.params.id);
  return ok(res, { id: Number(req.params.id), status: 'disabled' });
}));

module.exports = router;
