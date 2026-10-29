/**
 * 面辅料用量明细（order_materials）—— 对齐衣创 material_data
 *
 * 物料可以挂到「款」上，并为每个颜色单独指定色号与用量：
 *   item_id      哪个款（空 = 订单通用，老数据就是这样）
 *   all_colors   1 = 该款所有颜色通用
 *   colors[]     每色一行：{colorway, color_no, qty}
 *
 * 总用量口径、件数口径、颜色归属校验全在 `services/orderMaterialColors.js`，
 * 这里只做转发 —— 三个入口（新增 / 改物料 / 只改颜色）各写一遍，
 * 必然出现「改了颜色但总额没变」。
 *
 * GET    /api/order-materials?order_id=
 * GET    /api/order-materials/:id/colors          某物料配了哪些颜色
 * POST   /api/order-materials
 * PUT    /api/order-materials/:id
 * PUT    /api/order-materials/:id/colors          只改颜色（配色弹窗用）
 * DELETE /api/order-materials/:id
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const svc = require('../services/orderMaterialColors');

const router = express.Router();
const WRITE = ['admin', 'tech', 'finance'];

/** 校验并整理「款 + 颜色」入参；不合法一律 400，写库前先拦 */
function readTarget(body, orderId, current) {
  const itemId = body.item_id !== undefined
    ? (body.item_id === '' || body.item_id === null ? null : Number(body.item_id))
    : (current ? current.item_id : null);

  if (itemId) {
    const own = db.prepare('SELECT 1 AS x FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId);
    if (!own) throw bad('这个款不属于该订单');
  }

  const allColors = body.all_colors !== undefined
    ? (body.all_colors ? 1 : 0)
    : (current ? Number(current.all_colors) || 0 : 0);

  let colors = null; // null = 不改
  if (body.colors !== undefined) {
    colors = (Array.isArray(body.colors) ? body.colors : [])
      .map((c) => ({
        colorway: String(c.colorway || c.color || '').trim(),
        color_no: c.color_no || null,
        qty: c.qty === '' || c.qty === undefined || c.qty === null ? null : Number(c.qty),
        note: c.note || null
      }))
      .filter((c) => c.colorway);
  }

  // 配了颜色就必须先选款：颜色属于款，没有款就没有「合法颜色集合」可比对
  const willHaveColors = allColors === 0 && (
    colors !== null ? colors.length > 0 : (current ? svc.colorsOf(current.id).length > 0 : false)
  );
  if (willHaveColors && !itemId) {
    throw bad('还没选是哪个款，无法指定颜色。订单通用物料请用「全部颜色」或先选定款');
  }
  if (colors && colors.length) {
    svc.assertColorsBelong(itemId, colors.map((c) => c.colorway));
  }

  return { itemId, allColors, colors };
}

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

router.get('/', authRequired, wrap(async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return fail(res, 400, '缺少 order_id');
  return ok(res, svc.listByOrder(order_id));
}));

router.get('/:id/colors', authRequired, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM order_materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  return ok(res, {
    id: row.id,
    item_id: row.item_id,
    all_colors: Number(row.all_colors) || 0,
    colors: svc.colorsOf(row.id),
    /** 该款可选颜色（弹窗里勾选用）+ 每色件数 */
    item_colors: row.item_id ? svc.colorsOfItem(row.item_id) : []
  });
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.order_id) return fail(res, 400, '缺少 order_id');
  if (!b.name) return fail(res, 400, '料名必填');
  if (!db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(b.order_id)) return fail(res, 404, '订单不存在');

  const type = b.type === 'accessory' ? 'accessory' : 'fabric';
  const { itemId, allColors, colors } = readTarget(b, b.order_id, null);

  const t = now();
  const info = db.prepare(
    `INSERT INTO order_materials
      (order_id, item_id, all_colors, material_id, type, name, unit, one_use, loss, total_use, price, amount,
       spec, ingredient, supplier, mat_color, remark, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,?,0,?,?,?,?,?,?)`
  ).run(
    b.order_id, itemId, allColors, b.material_id || null, type, b.name, b.unit || '',
    Number(b.one_use) || 0, Number(b.loss) || 0, Number(b.price) || 0,
    b.spec || null, b.ingredient || null, b.supplier || null, b.mat_color || null, b.remark || null, t
  );

  const id = Number(info.lastInsertRowid);
  if (allColors === 0 && colors && colors.length) svc.replaceColors(id, colors);
  svc.recalc(id);
  return ok(res, svc.listByOrder(b.order_id).find((x) => x.id === id));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM order_materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  const b = req.body || {};
  const { itemId, allColors, colors } = readTarget(b, row.order_id, row);

  db.prepare(
    `UPDATE order_materials SET item_id=?, all_colors=?, material_id=?, type=?, name=?, unit=?, one_use=?,
        loss=?, price=?, spec=?, ingredient=?, supplier=?, mat_color=?, remark=? WHERE id=?`
  ).run(
    itemId, allColors,
    b.material_id ?? row.material_id,
    (b.type || row.type) === 'accessory' ? 'accessory' : 'fabric',
    b.name || row.name,
    b.unit ?? row.unit,
    b.one_use !== undefined ? Number(b.one_use) || 0 : row.one_use,
    b.loss !== undefined ? Number(b.loss) || 0 : row.loss,
    b.price !== undefined ? Number(b.price) || 0 : row.price,
    b.spec ?? row.spec, b.ingredient ?? row.ingredient, b.supplier ?? row.supplier,
    b.mat_color ?? row.mat_color, b.remark ?? row.remark,
    row.id
  );

  /**
   * 切成「全部颜色」时把子表清空。
   * 两者并存时无法判断是「全部」还是「只有那几色」，两种理解都说得通 ——
   * 于是谁都按自己想的理解，最后发料发错。
   */
  if (allColors === 1) svc.replaceColors(row.id, []);
  else if (colors !== null) svc.replaceColors(row.id, colors);

  svc.recalc(row.id);
  return ok(res, svc.listByOrder(row.order_id).find((x) => x.id === row.id));
}));

/** 只改颜色（配色弹窗保存用，不动物料主字段） */
router.put('/:id/colors', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM order_materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');

  const { itemId, allColors, colors } = readTarget(req.body || {}, row.order_id, row);
  db.prepare('UPDATE order_materials SET item_id = ?, all_colors = ? WHERE id = ?').run(itemId, allColors, row.id);
  svc.replaceColors(row.id, allColors === 1 ? [] : (colors || []));
  svc.recalc(row.id);
  return ok(res, svc.listByOrder(row.order_id).find((x) => x.id === row.id));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM order_materials WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '记录不存在');
  // 颜色行跟着走：留着就成了孤儿，按色汇总时会算进已删物料
  db.prepare('DELETE FROM order_material_colors WHERE order_material_id = ?').run(req.params.id);
  db.prepare('DELETE FROM order_materials WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
