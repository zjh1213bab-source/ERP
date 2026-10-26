/**
 * 销售订单（定制/现货）
 * 结构：订单 → 款(order_items) → 颜色(order_item_sizes.color) → 尺码(数量/美金单价)
 * 美金计价，汇率取后台设置（默认6.5），自动折人民币
 */
const express = require('express');
const { db, now, getSettings } = require('../db');
const { ensureNodes } = require('../services/production');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

const STATUS_LABELS = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};
const FLOW = {
  draft: ['tech'], tech: ['finance'], finance: ['assigned'], assigned: ['production'],
  production: ['instock'], instock: ['shipped'], shipped: ['closed']
};
const TRANSITION_ROLES = {
  tech: ['admin', 'sales', 'tech'], finance: ['admin', 'sales', 'tech'], assigned: ['admin', 'finance'],
  production: ['admin', 'sales', 'production'], instock: ['admin', 'production', 'warehouse'],
  shipped: ['admin', 'warehouse'], closed: ['admin', 'sales'], cancelled: ['admin', 'sales']
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 把尺码行按颜色分组 */
function groupByColor(sizes) {
  const map = new Map();
  for (const s of sizes) {
    const c = s.color || '';
    if (!map.has(c)) map.set(c, { color: c, qty: 0, amount_usd: 0, amount_cny: 0, sizes: [] });
    const g = map.get(c);
    g.qty += Number(s.qty) || 0;
    g.amount_usd += Number(s.amount_usd) || 0;
    g.amount_cny += Number(s.amount_cny) || 0;
    g.sizes.push(s);
  }
  return [...map.values()].map((g) => ({
    ...g,
    amount_usd: round2(g.amount_usd),
    amount_cny: round2(g.amount_cny)
  }));
}

function getOrderFull(id) {
  const order = db.prepare(
    `SELECT o.*, c.name AS customer_name FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).get(id);
  if (!order) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  const sizeStmt = db.prepare('SELECT * FROM order_item_sizes WHERE item_id = ? ORDER BY id');
  order.items = items.map((it) => {
    const sizes = sizeStmt.all(it.id);
    return { ...it, sizes, colors: groupByColor(sizes) };
  });
  order.logs = db.prepare('SELECT * FROM order_logs WHERE order_id = ? ORDER BY id').all(id);
  order.crafts = db.prepare('SELECT * FROM order_crafts WHERE order_id = ? ORDER BY id').all(id);
  return order;
}

// ---------- 列表 ----------
router.get('/', authRequired, wrap(async (req, res) => {
  const { q = '', status = '', type = '' } = req.query;
  const where = [];
  const params = [];
  if (q) { where.push('(o.order_no LIKE ? OR c.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (type) { where.push('o.type = ?'); params.push(type); }
  const sql = `SELECT o.*, c.name AS customer_name FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY o.id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

// ---------- 状态机元数据 ----------
router.get('/meta', authRequired, wrap(async (req, res) => {
  return ok(res, { labels: STATUS_LABELS, flow: FLOW, roles: TRANSITION_ROLES, rate: getSettings().exchangeRate });
}));

// ---------- 工作台统计 ----------
router.get('/stats/summary', authRequired, wrap(async (req, res) => {
  const customers = Number(db.prepare('SELECT COUNT(*) AS c FROM customers').get().c);
  const products = Number(db.prepare('SELECT COUNT(*) AS c FROM products').get().c);
  const orders = Number(db.prepare('SELECT COUNT(*) AS c FROM orders').get().c);
  const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM orders GROUP BY status').all();
  const amount = db.prepare('SELECT COALESCE(SUM(total_amount),0) AS s FROM orders').get().s;
  const usd = db.prepare('SELECT COALESCE(SUM(total_usd),0) AS s FROM orders').get().s;
  return ok(res, { customers, products, orders, byStatus, totalAmount: Number(amount), totalUsd: Number(usd) });
}));

// ---------- 详情 ----------
router.get('/:id', authRequired, wrap(async (req, res) => {
  const order = getOrderFull(req.params.id);
  if (!order) return fail(res, 404, '订单不存在');
  return ok(res, order);
}));

// ---------- 新建 ----------
router.post('/', authRequired, requireRole(['admin', 'sales']), wrap(async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return fail(res, 400, '至少需要一条订单明细');

  const rate = Number(b.rate) > 0 ? Number(b.rate) : getSettings().exchangeRate;
  const type = b.type === 'stock' ? 'stock' : 'custom';

  let orderUsd = 0;
  const prepared = [];
  for (const it of items) {
    // 新结构 colors[]；兼容旧结构 sizes[]
    const colors = Array.isArray(it.colors) ? it.colors : [{ color: it.color || '', sizes: it.sizes || [] }];
    let itemQty = 0, itemUsd = 0;
    const sizeRows = [];
    for (const c of colors) {
      const colorName = c.color || '';
      const sizes = Array.isArray(c.sizes) ? c.sizes.filter((s) => Number(s.qty) > 0) : [];
      for (const s of sizes) {
        const qty = Number(s.qty) || 0;
        const usd = Number(s.usd_price) || 0;
        const amtUsd = round2(qty * usd);
        itemQty += qty;
        itemUsd += amtUsd;
        sizeRows.push({
          color: colorName,
          size: String(s.size || '均码'),
          qty,
          usd_price: usd,
          cny_price: round2(usd * rate),
          amount_usd: amtUsd,
          amount_cny: round2(qty * usd * rate)
        });
      }
    }
    if (!sizeRows.length) return fail(res, 400, `款「${it.product_name || '未命名'}」没有填写任何一个尺码的数量`);
    itemUsd = round2(itemUsd);
    orderUsd = round2(orderUsd + itemUsd);
    prepared.push({
      product_id: it.product_id || null,
      product_name: it.product_name || '未命名产品',
      style_no: it.style_no || null,
      sku: it.sku || null,
      remark: it.remark || null,
      qty: itemQty,
      amount_usd: itemUsd,
      amount_cny: round2(itemUsd * rate),
      sizeRows
    });
  }
  const orderCny = round2(orderUsd * rate);

  let seq = Number(db.prepare('SELECT COUNT(*) AS c FROM orders').get().c) + 1;
  let orderNo = genNo(type === 'stock' ? 'XS' : 'SO', seq);
  while (db.prepare('SELECT 1 AS x FROM orders WHERE order_no = ?').get(orderNo)) {
    orderNo = genNo(type === 'stock' ? 'XS' : 'SO', ++seq);
  }

  let orderId;
  db.exec('BEGIN');
  try {
    const t = now();
    const info = db.prepare(
      `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency, style_name, cus_order_no, manager, order_date, delivery_method, packaging, trade_terms, shop_name, shop_order_no, delivery_days, freight, delivery_date, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(orderNo, type, b.customer_id || null, 'draft', rate, orderUsd, orderCny, 'USD',
      b.style_name || null, b.cus_order_no || null, b.manager || null,
      b.order_date || null, b.delivery_method || null, b.packaging || null, b.trade_terms || null,
      b.shop_name || null, b.shop_order_no || null, Number(b.delivery_days) || 0, Number(b.freight) || 0,
      b.delivery_date || null, b.remark || null, req.user.sub, t, t);
    orderId = Number(info.lastInsertRowid);

    const insItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, product_name, style_no, sku, remark, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const insSize = db.prepare(
      'INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?)'
    );
    prepared.forEach((p) => {
      const r = insItem.run(orderId, p.product_id, p.product_name, p.style_no, p.sku, p.remark, p.qty, p.amount_usd, p.amount_cny);
      const itemId = Number(r.lastInsertRowid);
      p.sizeRows.forEach((s) =>
        insSize.run(itemId, s.color, s.size, s.qty, s.usd_price, s.cny_price, s.amount_usd, s.amount_cny)
      );
    });

    db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(orderId, null, 'draft', req.user.username, '创建订单', t);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return ok(res, getOrderFull(orderId));
}));

// ---------- 状态流转 ----------
router.post('/:id/transition', authRequired, wrap(async (req, res) => {
  const id = req.params.id;
  const { to, note } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return fail(res, 404, '订单不存在');

  const cur = order.status;
  const allowedRoles = TRANSITION_ROLES[to];
  if (!allowedRoles) return fail(res, 400, '非法的目标状态');

  const isCancel = to === 'cancelled';
  const normalOk = (FLOW[cur] || []).includes(to);
  const cancelOk = isCancel && cur !== 'closed' && cur !== 'cancelled';
  if (!normalOk && !cancelOk) {
    return fail(res, 400, `订单当前为「${STATUS_LABELS[cur] || cur}」，不能流转到「${STATUS_LABELS[to] || to}」`);
  }
  if (!(req.user.role === 'admin' || allowedRoles.includes(req.user.role))) {
    return fail(res, 403, '你的角色无权执行该状态变更');
  }

  // P2 硬门槛
  if (to === 'tech') {
    const tp = db.prepare("SELECT 1 AS x FROM tech_packs WHERE order_id = ? AND status = 'confirmed' LIMIT 1").get(id);
    if (!tp) return fail(res, 400, '开发单尚未确认，无法通过「技术确认」；请先补全并确认开发单');
  }
  if (to === 'assigned') {
    const cs = db.prepare("SELECT 1 AS x FROM cost_sheets WHERE order_id = ? AND status = 'approved' LIMIT 1").get(id);
    if (!cs) return fail(res, 400, '财务尚未审核通过，无法「分单」；请先录入成本并完成财务审核');
  }

  const t = now();
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(to, t, id);
  // 进入生产：自动初始化 13 道工序
  if (to === 'production') ensureNodes(id);
  db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, cur, to, req.user.username, note || null, t);
  return ok(res, getOrderFull(id));
}));

module.exports = router;
