/**
 * 库存台账 + 成品入库 / 发货出库
 * GET  /api/stock?warehouse=&q=
 * GET  /api/stock/summary
 * GET  /api/stock/ledger?warehouse=&style_no=
 * POST /api/stock/adjust    { warehouse, style_no, product_name, color, size, qty(增量,可负), remark }
 * POST /api/stock/transfer  { from, to, style_no, color, size, qty, remark }
 * POST /api/stock/instock   { order_id, warehouse }   按订单明细入库
 * POST /api/stock/ship      { order_id, warehouse, credit_override_id }  按订单明细出库发货
 *                           —— 信用受限时返回 400 + code=CREDIT_BLOCK，办过放行单才能发
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

/** 单据备注随实物流水留档；缺省沿用订单说明，避免订单有说明而库存流水丢失。 */
function movementRemark(body,order){
  const remark=body?.remark??order.remark??'';
  if(typeof remark!=='string'||remark.length>2000)throw Object.assign(new Error('出入库说明须为不超过2000字的文本'),{status:400});
  return remark.trim();
}
const WRITE = ['admin', 'warehouse', 'production', 'sales'];
// 库存原子操作统一走 services/stockOps，避免与零售/渠道履约出现两套口径
const { getStock, applyStock, addLedger, round2 } = require('../services/stockOps');
// 客户信用闸门：货出门这一刻才判（下单时只提示，钱/货出门才拦）
const credit = require('../services/credit');
const orderFlow = require('../services/orderFlow');
const { markDoneByCode } = require('../services/nodeFlow');

function orderSizeRows(orderId) {
  return db
    .prepare(
      `SELECT i.style_no, i.product_name, s.color, s.size, s.qty
       FROM order_items i JOIN order_item_sizes s ON s.item_id = i.id
       WHERE i.order_id = ? ORDER BY i.id, s.id`
    )
    .all(orderId);
}

// ---------- 缺货一键补货：按订单缺口从生产仓调拨到美仓 ----------
router.post('/auto-transfer', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const { order_id, from = 'cn', to = 'us' } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
  if (!order) return fail(res, 404, '订单不存在');

  const rows = orderSizeRows(order_id);
  const results = [];
  let moved = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const demand = Number(r.qty) || 0;
      if (!demand) continue;
      const us = getStock(to, r.style_no, r.color, r.size);
      const usQty = us ? Number(us.qty) : 0;
      const lack = Math.max(0, demand - usQty);
      if (!lack) continue;

      const src = getStock(from, r.style_no, r.color, r.size);
      const srcQty = src ? Number(src.qty) : 0;
      const move = Math.min(lack, srcQty);
      if (move <= 0) {
        results.push({ ...r, lack, moved: 0, note: '生产仓也无库存' });
        continue;
      }
      applyStock({ warehouse: from, style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size, delta: -move });
      applyStock({ warehouse: to, style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size, delta: move });
      addLedger({ warehouse: from, style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size, type: 'transfer_out', qty: -move, ref_type: 'order', ref_id: Number(order_id), remark: '缺货自动补货', operator: req.user.username });
      addLedger({ warehouse: to, style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size, type: 'transfer_in', qty: move, ref_type: 'order', ref_id: Number(order_id), remark: '缺货自动补货', operator: req.user.username });
      moved += move;
      results.push({ ...r, lack, moved: move, note: move < lack ? '生产仓不足，部分补货' : '已补足' });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, { moved, results });
}));

// ---------- 发货看板：按指定仓库核对已入库订单需求 ----------
router.get('/ship-board', authRequired, wrap(async (req, res) => {
  const warehouse = req.query.warehouse || 'us';
  const orders = db.prepare(
    `SELECT o.*, c.name AS customer_name FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'instock'
     ORDER BY (o.delivery_date IS NULL), o.delivery_date ASC, o.id DESC`
  ).all();
  const sizeStmt = db.prepare(
    `SELECT i.style_no, i.product_name, s.color, s.size, s.qty
     FROM order_items i JOIN order_item_sizes s ON s.item_id = i.id
     WHERE i.order_id = ? ORDER BY i.id, s.id`
  );
  const stStmt = db.prepare('SELECT qty FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?');

  const out = orders.map((o) => {
    const rows = sizeStmt.all(o.id);
    let shortage = 0;
    const lines = rows.map((r) => {
      const st = stStmt.get(warehouse, r.style_no || '', r.color || '', r.size || '');
      const available = st ? Number(st.qty) : 0;
      const demand = Number(r.qty) || 0;
      const ok = available >= demand;
      if (!ok) shortage += Math.max(0, demand - available);
      return { style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size, demand, available, ok };
    });
    return {
      id: o.id, order_no: o.order_no, style_name: o.style_name, customer_name: o.customer_name,
      delivery_date: o.delivery_date, status: o.status, lines, shortage,
      canShip: lines.length > 0 && lines.every((l) => l.ok)
    };
  });
  return ok(res, out);
}));

// ---------- 查询 ----------
router.get('/', authRequired, wrap(async (req, res) => {
  const { warehouse = '', q = '' } = req.query;
  const where = ['qty != 0'];
  const params = [];
  if (warehouse) { where.push('warehouse = ?'); params.push(warehouse); }
  if (q) {
    where.push('(style_no LIKE ? OR product_name LIKE ? OR color LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sql = `SELECT * FROM stock_items WHERE ${where.join(' AND ')} ORDER BY warehouse, style_no, color, size`;
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/summary', authRequired, wrap(async (req, res) => {
  const rows = db.prepare("SELECT warehouse, COALESCE(SUM(qty),0) AS qty, COUNT(*) AS skus FROM stock_items WHERE qty != 0 GROUP BY warehouse").all();
  const cn = rows.find((r) => r.warehouse === 'cn') || { qty: 0, skus: 0 };
  const us = rows.find((r) => r.warehouse === 'us') || { qty: 0, skus: 0 };
  return ok(res, { cn: { qty: Number(cn.qty), skus: Number(cn.skus) }, us: { qty: Number(us.qty), skus: Number(us.skus) } });
}));

router.get('/ledger', authRequired, wrap(async (req, res) => {
  const { warehouse = '', style_no = '' } = req.query;
  const where = [];
  const params = [];
  if (warehouse) { where.push('warehouse = ?'); params.push(warehouse); }
  if (style_no) { where.push('style_no = ?'); params.push(style_no); }
  const sql = 'SELECT * FROM stock_ledger ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY id DESC LIMIT 200';
  return ok(res, db.prepare(sql).all(...params));
}));

// ---------- 手工调整 ----------
router.post('/adjust', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.warehouse) return fail(res, 400, '缺少仓库');
  const delta = round2(b.qty);
  if (!delta) return fail(res, 400, '调整数量不能为 0');
  try {
    db.exec('BEGIN');
    const after = applyStock({ warehouse: b.warehouse, style_no: b.style_no, product_name: b.product_name, color: b.color, size: b.size, delta });
    addLedger({ ...b, type: 'adjust', qty: delta, ref_type: 'manual', operator: req.user.username });
    db.exec('COMMIT');
    return ok(res, { after });
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
}));

// ---------- 调拨 ----------
router.post('/transfer', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const qty = round2(b.qty);
  if (!b.from || !b.to || b.from === b.to) return fail(res, 400, '调拨仓库不合法');
  if (qty <= 0) return fail(res, 400, '调拨数量必须大于 0');
  try {
    db.exec('BEGIN');
    applyStock({ warehouse: b.from, style_no: b.style_no, product_name: b.product_name, color: b.color, size: b.size, delta: -qty });
    applyStock({ warehouse: b.to, style_no: b.style_no, product_name: b.product_name, color: b.color, size: b.size, delta: qty });
    addLedger({ ...b, warehouse: b.from, type: 'transfer_out', qty: -qty, ref_type: 'manual', operator: req.user.username });
    addLedger({ ...b, warehouse: b.to, type: 'transfer_in', qty, ref_type: 'manual', operator: req.user.username });
    db.exec('COMMIT');
    return ok(res, { from: b.from, to: b.to, qty });
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
}));

// ---------- 成品入库（按订单） ----------
router.post('/instock', authRequired, requireRole(['admin', 'warehouse', 'production']), wrap(async (req, res) => {
  const { order_id, warehouse = 'cn' } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
  if (!order) return fail(res, 404, '订单不存在');
  if (order.status !== 'production') return fail(res, 400, `订单当前为「${order.status}」，只有生产中的订单可入库`);
  const movementNote=movementRemark(req.body,order);
  orderFlow.check(order_id, { to: 'instock', user: req.user, source: 'stock' });
  const rows = orderSizeRows(order_id);
  if (!rows.length) return fail(res, 400, '订单没有明细');
  const matrixQty = rows.reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
  const orderedQty = Number(db.prepare('SELECT COALESCE(SUM(qty),0) AS qty FROM order_items WHERE order_id = ?').get(order_id).qty) || 0;
  if (!(matrixQty > 0) || Math.abs(matrixQty - orderedQty) > 0.0001) return fail(res, 400, '颜色尺码明细数量与订单总量不一致，不能按整单入库');
  try {
    db.exec('BEGIN');
    rows.forEach((r) => {
      if (!Number(r.qty)) return;
      applyStock({ warehouse, style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size, delta: Number(r.qty) });
      addLedger({ warehouse, style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size, type: 'in', qty: Number(r.qty), ref_type: 'order', ref_id: Number(order_id), remark: ['成品入库',movementNote].filter(Boolean).join('；'), operator: req.user.username });
    });
    const t = now();
    db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run('instock', t, order_id);
    /**
     * 按 code 标记，**不按名字**。
     *
     * 这里原先是 `WHERE name='成品入库'`。它在业务把节点改名成「入库」的那一刻
     * 就静默失效了 —— 库存流水照写、订单状态照转，只有节点停在「待开始」。
     * 而且失效是**按订单分批**发生的：老单节点还叫「成品入库」照样能标记，
     * 新单不行。同一个动作一半生效一半不生效，最难查的那种。
     */
    markDoneByCode(order_id, 'instock', { date: t.slice(0, 10), operator: req.user.username });
    db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(order_id, order.status, 'instock', req.user.username, [`成品入库(${warehouse})`,movementNote].filter(Boolean).join('；'), t);
    db.exec('COMMIT');
    orderFlow.afterTransition(order, { to: 'instock', note: `成品入库(${warehouse})`, user: req.user });
    return ok(res, { order_id: Number(order_id), warehouse, status: 'instock' });
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
}));

// ---------- 发货出库（按订单） ----------
router.post('/ship', authRequired, requireRole(['admin', 'warehouse', 'finance']), wrap(async (req, res) => {
  const { order_id, warehouse = 'cn', credit_override_id } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
  if (!order) return fail(res, 404, '订单不存在');
  if (order.status !== 'instock') return fail(res, 400, `订单当前为「${order.status}」，只有已入库可发货`);
  const movementNote=movementRemark(req.body,order);
  orderFlow.check(order_id, { to: 'shipped', user: req.user, source: 'stock' });
  const rows = orderSizeRows(order_id);
  // 入库那边有「订单没有明细」的校验，发货这边原来漏了：
  // 没有明细的空单会一路走完流程被标成「已发货」，货一件没出库，
  // 而 shipped 只能往 closed 走 —— 状态错了就改不回来，只能手工修库
  if (!rows.length) return fail(res, 400, '订单没有明细（颜色/尺码），无法出库发货');
  const totalQty = rows.reduce((n, r) => n + (Number(r.qty) || 0), 0);
  if (totalQty <= 0) return fail(res, 400, '订单明细件数全是 0，没有可发的货');

  // ---------- 信用闸门 ----------
  // 只在这里读、不在事务里判：事务内 return 不会回滚（这个坑踩过），
  // 而且判断本身要查十几张表，塞进事务会拉长锁时间。
  const creditCheck = credit.judge(order_id);
  if (creditCheck.blocked && !credit_override_id) {
    return res.status(400).json({
      ok: false,
      code: 'CREDIT_BLOCK',
      message: `信用受限，不能发货 —— ${creditCheck.reasons.join('；')}`,
      data: creditCheck        // 前端要拿 reasons / profile 展示，并引导去办放行
    });
  }

  try {
    db.exec('BEGIN');
    // 放行单在事务内核销：库存不足回滚时，这张放行单也跟着回滚，
    // 不会出现「货没发出去，放行单却被用掉了」
    let consumed = null;
    if (credit_override_id) {
      consumed = credit.consumeOverride(credit_override_id, order_id, req.user.username);
    }
    // 先校验库存充足
    for (const r of rows) {
      if (!Number(r.qty)) continue;
      const st = getStock(warehouse, r.style_no, r.color, r.size);
      if (!st || Number(st.qty) < Number(r.qty)) {
        throw new Error(`库存不足：${r.product_name} / ${r.color} / ${r.size}，需 ${r.qty}，现有 ${st ? st.qty : 0}`);
      }
    }
    rows.forEach((r) => {
      if (!Number(r.qty)) return;
      applyStock({ warehouse, style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size, delta: -Number(r.qty) });
      addLedger({ warehouse, style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size, type: 'out', qty: -Number(r.qty), ref_type: 'order', ref_id: Number(order_id), remark: ['发货出库',movementNote].filter(Boolean).join('；'), operator: req.user.username });
    });
    const t = now();
    db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run('shipped', t, order_id);
    // 同上：按 code（ship）标记，改名不影响
    markDoneByCode(order_id, 'ship', { date: t.slice(0, 10), operator: req.user.username });
    const shipNoteBase = consumed
      ? `发货出库(${warehouse})·信用放行单#${consumed.id}`
      : `发货出库(${warehouse})`;
    const shipNote=[shipNoteBase,movementNote].filter(Boolean).join('；');
    db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(order_id, order.status, 'shipped', req.user.username, shipNote, t);
    db.exec('COMMIT');
    orderFlow.afterTransition(order, { to: 'shipped', note: shipNote, user: req.user });
    return ok(res, {
      order_id: Number(order_id),
      warehouse,
      status: 'shipped',
      credit: {
        level: creditCheck.level,
        risk: creditCheck.profile ? creditCheck.profile.risk : null,
        notes: creditCheck.notes,
        override_id: consumed ? consumed.id : null
      }
    });
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
}));

module.exports = router;
