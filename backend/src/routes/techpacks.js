/**
 * 技术资料 / 开发单（tech_packs）—— P2
 * 字段：面料、辅料、工艺工序、客户要求、尺码规格
 * 定制订单「技术确认」前，必须填写 面料/辅料/工艺工序/客户要求
 * GET  /api/techpacks?order_id=
 * POST /api/techpacks
 * PUT  /api/techpacks/:id
 * POST /api/techpacks/:id/confirm
 * POST /api/techpacks/:id/reject
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'tech', 'sales'];
const REVIEW = ['admin', 'tech'];

function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// 开发管理：全量列表（关联订单/客户）
router.get('/all', authRequired, wrap(async (req, res) => {
  const { status = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('tp.status = ?'); params.push(status); }
  if (q) {
    where.push('(tp.product_name LIKE ? OR o.order_no LIKE ? OR o.style_name LIKE ? OR c.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sql = `SELECT tp.*, o.order_no, o.style_name, o.type AS order_type, o.status AS order_status, c.name AS customer_name
    FROM tech_packs tp
    LEFT JOIN orders o ON o.id = tp.order_id
    LEFT JOIN customers c ON c.id = o.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY tp.id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/', authRequired, wrap(async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return fail(res, 400, '缺少 order_id');
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE order_id = ? ORDER BY id DESC').all(order_id));
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.order_id) return fail(res, 400, '缺少 order_id');
  if (!db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(b.order_id)) {
    return fail(res, 404, '订单不存在');
  }
  if (!b.product_name) return fail(res, 400, '请填写产品/款号');
  const t = now();
  const info = db.prepare(
    `INSERT INTO tech_packs (order_id, product_name, version, fabric_info, accessory_info, craft_info, customer_req, fabric_ids, accessory_ids, size_spec, status, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`
  ).run(
    b.order_id, b.product_name, b.version || 'V1',
    b.fabric_info || null, b.accessory_info || null, b.craft_info || null,
    b.customer_req || null, b.fabric_ids || null, b.accessory_ids || null, b.size_spec || null,
    b.remark || null, req.user.sub, t, t
  );
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');
  if (row.status === 'confirmed') return fail(res, 400, '已确认的开发单不可修改，请新建版本');
  const b = req.body || {};
  db.prepare(
    `UPDATE tech_packs SET product_name=?, version=?, fabric_info=?, accessory_info=?, craft_info=?, customer_req=?, fabric_ids=?, accessory_ids=?, size_spec=?, remark=?, updated_at=? WHERE id=?`
  ).run(
    b.product_name || row.product_name,
    b.version || row.version,
    b.fabric_info ?? row.fabric_info,
    b.accessory_info ?? row.accessory_info,
    b.craft_info ?? row.craft_info,
    b.customer_req ?? row.customer_req,
    b.fabric_ids ?? row.fabric_ids,
    b.accessory_ids ?? row.accessory_ids,
    b.size_spec ?? row.size_spec,
    b.remark ?? row.remark,
    now(), req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id));
}));

router.post('/:id/confirm', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');

  // 定制订单开发流程校验：面辅料 / 工艺 / 客户要求 必填
  const order = db.prepare('SELECT type FROM orders WHERE id = ?').get(row.order_id);
  if (order && order.type === 'custom') {
    const missing = [];
    if (!hasText(row.fabric_info) && !hasText(row.fabric_ids)) missing.push('面料');
    if (!hasText(row.accessory_info) && !hasText(row.accessory_ids)) missing.push('辅料');
    if (!hasText(row.craft_info)) missing.push('工艺工序');
    if (!hasText(row.customer_req)) missing.push('客户要求');
    if (missing.length) {
      return fail(res, 400, '定制订单的开发单必填项缺失：' + missing.join('、') + '，请补充后再确认');
    }
  }

  const t = now();
  db.prepare("UPDATE tech_packs SET status='confirmed', confirmed_by=?, confirmed_at=?, updated_at=? WHERE id=?")
    .run(req.user.username, t, t, req.params.id);
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id));
}));

router.post('/:id/reject', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');
  db.prepare("UPDATE tech_packs SET status='rejected', updated_at=? WHERE id=?").run(now(), req.params.id);
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id));
}));

// 打版流程推进：draft→material→pattern→craft→sample→biz→confirmed
const STAGES = ['draft', 'material', 'pattern', 'craft', 'sample', 'biz', 'confirmed'];

router.post('/:id/stage', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const { stage } = req.body || {};
  if (!STAGES.includes(stage)) return fail(res, 400, '非法的流程阶段');
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');

  if (stage === 'confirmed') {
    const order = db.prepare('SELECT type FROM orders WHERE id = ?').get(row.order_id);
    if (order && order.type === 'custom') {
      const missing = [];
      if (!hasText(row.fabric_info) && !hasText(row.fabric_ids)) missing.push('面料');
      if (!hasText(row.accessory_info) && !hasText(row.accessory_ids)) missing.push('辅料');
      if (!hasText(row.craft_info)) missing.push('工艺工序');
      if (!hasText(row.customer_req)) missing.push('客户要求');
      if (missing.length) {
        return fail(res, 400, '定制订单的开发单必填项缺失：' + missing.join('、') + '，请补充后再确认');
      }
    }
    const t = now();
    db.prepare("UPDATE tech_packs SET stage='confirmed', status='confirmed', confirmed_by=?, confirmed_at=?, updated_at=? WHERE id=?")
      .run(req.user.username, t, t, req.params.id);
  } else {
    db.prepare("UPDATE tech_packs SET stage=?, status=CASE WHEN status='confirmed' THEN 'draft' ELSE status END, updated_at=? WHERE id=?")
      .run(stage, now(), req.params.id);
  }
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id));
}));

router.delete('/:id', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');
  if (row.status === 'confirmed') return fail(res, 400, '已确认的开发单不可删除');
  db.prepare('DELETE FROM tech_packs WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
