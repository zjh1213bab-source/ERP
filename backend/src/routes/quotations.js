/**
 * 报价单（阶梯报价 → 报价单 → 一键转订单）
 * GET    /api/quotations?status=&q=&customer_id=
 * GET    /api/quotations/:id
 * POST   /api/quotations                     { customer_id, valid_until, trade_terms, delivery_days, remark, items:[{product_id,product_name,sku,qty,price_usd,remark}] }
 * PUT    /api/quotations/:id                 仅草稿可改
 * POST   /api/quotations/:id/status          { status } draft→sent→accepted/rejected
 * POST   /api/quotations/:id/convert         生成草稿销售订单，回填 order_id
 * POST   /api/quotations/:id/reprice         按当前阶梯价重算所有行
 * DELETE /api/quotations/:id                 仅草稿可删
 */
const express = require('express');
const { db, now, getSettings } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { lookupTier } = require('./priceTiers');

const router = express.Router();
const WRITE = ['admin', 'sales'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const STATUS_LABELS = {
  draft: '草稿', sent: '已发出', accepted: '已接受', rejected: '已拒绝', converted: '已转订单'
};
const STATUS_FLOW = {
  draft: ['sent'],
  sent: ['accepted', 'rejected'],
  accepted: ['converted'],
  rejected: ['draft']
};

function full(id) {
  const q = db.prepare(
    `SELECT q.*, c.name AS customer_name FROM quotations q
     LEFT JOIN customers c ON c.id = q.customer_id WHERE q.id = ?`
  ).get(id);
  if (!q) return null;
  q.items = db.prepare('SELECT * FROM quotation_items WHERE quote_id = ? ORDER BY id').all(id);
  q.status_label = STATUS_LABELS[q.status] || q.status;
  return q;
}

/** 规范化行：单价缺省时按阶梯价自动匹配 */
function prepareItems(items, rate) {
  const out = [];
  let totalQty = 0;
  let totalUsd = 0;
  for (const it of items) {
    const qty = Number(it.qty) || 0;
    if (qty <= 0) return { error: '每行数量必须大于 0' };
    const pid = Number(it.product_id) || 0;
    let priceUsd = Number(it.price_usd);
    let tierId = null;
    let productName = it.product_name || '';
    let sku = it.sku || null;
    if (pid) {
      const p = db.prepare('SELECT id, name, sku, price FROM products WHERE id = ?').get(pid);
      if (!p) return { error: `产品 ID ${pid} 不存在` };
      productName = productName || p.name;
      sku = sku || p.sku;
      if (!(priceUsd > 0)) {
        const tier = lookupTier(pid, qty);
        if (tier) {
          priceUsd = Number(tier.price_usd);
          tierId = tier.id;
        } else {
          priceUsd = Number(p.price || 0);
        }
      }
    }
    if (!productName) return { error: '存在没有产品名称的行' };
    const amountUsd = round2(qty * priceUsd);
    totalQty += qty;
    totalUsd = round2(totalUsd + amountUsd);
    out.push({
      product_id: pid || null,
      product_name: productName,
      sku,
      qty,
      price_usd: round2(priceUsd),
      amount_usd: amountUsd,
      amount_cny: round2(amountUsd * rate),
      tier_id: tierId,
      remark: it.remark || null
    });
  }
  return { rows: out, totalQty, totalUsd, totalCny: round2(totalUsd * rate) };
}

function nextQuoteNo() {
  let seq = Number(db.prepare('SELECT COUNT(*) AS c FROM quotations').get().c) + 1;
  let no = genNo('QT', seq);
  while (db.prepare('SELECT 1 AS x FROM quotations WHERE quote_no = ?').get(no)) {
    no = genNo('QT', ++seq);
  }
  return no;
}

// ---------- 列表 ----------
router.get('/', authRequired, wrap(async (req, res) => {
  const { status = '', q = '', customer_id = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('q.status = ?'); params.push(status); }
  if (customer_id) { where.push('q.customer_id = ?'); params.push(Number(customer_id)); }
  if (q) { where.push('(q.quote_no LIKE ? OR c.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const sql = `SELECT q.*, c.name AS customer_name FROM quotations q
    LEFT JOIN customers c ON c.id = q.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY q.id DESC';
  const rows = db.prepare(sql).all(...params);
  rows.forEach((r) => { r.status_label = STATUS_LABELS[r.status] || r.status; });
  return ok(res, rows);
}));

// ---------- 元数据 ----------
router.get('/meta', authRequired, wrap(async (req, res) => {
  return ok(res, { labels: STATUS_LABELS, flow: STATUS_FLOW, rate: getSettings().exchangeRate });
}));

// ---------- 详情 ----------
router.get('/:id', authRequired, wrap(async (req, res) => {
  const q = full(req.params.id);
  if (!q) return fail(res, 404, '报价单不存在');
  return ok(res, q);
}));

// ---------- 新建 ----------
router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return fail(res, 400, '至少需要一条报价明细');
  const rate = Number(b.rate) > 0 ? Number(b.rate) : getSettings().exchangeRate;
  const prep = prepareItems(items, rate);
  if (prep.error) return fail(res, 400, prep.error);

  const quoteNo = nextQuoteNo();
  let id;
  db.exec('BEGIN');
  try {
    const t = now();
    const info = db.prepare(
      `INSERT INTO quotations (quote_no, customer_id, status, rate, total_qty, total_usd, total_amount,
        valid_until, trade_terms, delivery_days, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(quoteNo, b.customer_id || null, 'draft', rate, prep.totalQty, prep.totalUsd, prep.totalCny,
      b.valid_until || null, b.trade_terms || null, Number(b.delivery_days) || 0,
      b.remark || null, req.user.sub, t, t);
    id = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO quotation_items (quote_id, product_id, product_name, sku, qty, price_usd, amount_usd, amount_cny, tier_id, remark)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    prep.rows.forEach((r) => ins.run(id, r.product_id, r.product_name, r.sku, r.qty, r.price_usd, r.amount_usd, r.amount_cny, r.tier_id, r.remark));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, full(id));
}));

// ---------- 修改（仅草稿） ----------
router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
  if (!q) return fail(res, 404, '报价单不存在');
  if (q.status !== 'draft') return fail(res, 400, `报价单当前为「${STATUS_LABELS[q.status]}」，只有草稿可修改`);

  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : null;
  const rate = Number(b.rate) > 0 ? Number(b.rate) : q.rate;

  let prep = null;
  if (items) {
    if (!items.length) return fail(res, 400, '至少需要一条报价明细');
    prep = prepareItems(items, rate);
    if (prep.error) return fail(res, 400, prep.error);
  }

  db.exec('BEGIN');
  try {
    const t = now();
    if (prep) {
      db.prepare(
        `UPDATE quotations SET customer_id=?, rate=?, total_qty=?, total_usd=?, total_amount=?,
          valid_until=?, trade_terms=?, delivery_days=?, remark=?, updated_at=? WHERE id=?`
      ).run(b.customer_id !== undefined ? b.customer_id || null : q.customer_id, rate,
        prep.totalQty, prep.totalUsd, prep.totalCny,
        b.valid_until !== undefined ? b.valid_until || null : q.valid_until,
        b.trade_terms !== undefined ? b.trade_terms || null : q.trade_terms,
        b.delivery_days !== undefined ? Number(b.delivery_days) || 0 : q.delivery_days,
        b.remark !== undefined ? b.remark || null : q.remark, t, q.id);
      db.prepare('DELETE FROM quotation_items WHERE quote_id = ?').run(q.id);
      const ins = db.prepare(
        `INSERT INTO quotation_items (quote_id, product_id, product_name, sku, qty, price_usd, amount_usd, amount_cny, tier_id, remark)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      prep.rows.forEach((r) => ins.run(q.id, r.product_id, r.product_name, r.sku, r.qty, r.price_usd, r.amount_usd, r.amount_cny, r.tier_id, r.remark));
    } else {
      db.prepare(
        `UPDATE quotations SET customer_id=?, valid_until=?, trade_terms=?, delivery_days=?, remark=?, updated_at=? WHERE id=?`
      ).run(b.customer_id !== undefined ? b.customer_id || null : q.customer_id,
        b.valid_until !== undefined ? b.valid_until || null : q.valid_until,
        b.trade_terms !== undefined ? b.trade_terms || null : q.trade_terms,
        b.delivery_days !== undefined ? Number(b.delivery_days) || 0 : q.delivery_days,
        b.remark !== undefined ? b.remark || null : q.remark, t, q.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, full(q.id));
}));

// ---------- 状态流转 ----------
router.post('/:id/status', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
  if (!q) return fail(res, 404, '报价单不存在');
  const to = String((req.body || {}).status || '');
  if (!STATUS_LABELS[to]) return fail(res, 400, '未知状态');
  const allowed = STATUS_FLOW[q.status] || [];
  if (!allowed.includes(to)) {
    return fail(res, 400, `「${STATUS_LABELS[q.status]}」不能直接变为「${STATUS_LABELS[to]}」`);
  }
  db.prepare('UPDATE quotations SET status = ?, updated_at = ? WHERE id = ?').run(to, now(), q.id);
  return ok(res, full(q.id));
}));

// ---------- 按当前阶梯价重算 ----------
router.post('/:id/reprice', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const q = full(req.params.id);
  if (!q) return fail(res, 404, '报价单不存在');
  if (q.status !== 'draft') return fail(res, 400, '只有草稿可以重新计价');
  const prep = prepareItems(q.items.map((it) => ({
    product_id: it.product_id, product_name: it.product_name, sku: it.sku,
    qty: it.qty, remark: it.remark   // 不传 price_usd，强制按阶梯价重算
  })), q.rate);
  if (prep.error) return fail(res, 400, prep.error);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM quotation_items WHERE quote_id = ?').run(q.id);
    const ins = db.prepare(
      `INSERT INTO quotation_items (quote_id, product_id, product_name, sku, qty, price_usd, amount_usd, amount_cny, tier_id, remark)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    prep.rows.forEach((r) => ins.run(q.id, r.product_id, r.product_name, r.sku, r.qty, r.price_usd, r.amount_usd, r.amount_cny, r.tier_id, r.remark));
    db.prepare('UPDATE quotations SET total_qty=?, total_usd=?, total_amount=?, updated_at=? WHERE id=?')
      .run(prep.totalQty, prep.totalUsd, prep.totalCny, now(), q.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, full(q.id));
}));

// ---------- 转销售订单 ----------
router.post('/:id/convert', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const q = full(req.params.id);
  if (!q) return fail(res, 404, '报价单不存在');
  if (q.status === 'converted') return fail(res, 400, '该报价单已转过订单');
  if (!q.items.length) return fail(res, 400, '报价单没有明细，无法转订单');

  const b = req.body || {};
  const rate = Number(q.rate) || getSettings().exchangeRate;

  let seq = Number(db.prepare('SELECT COUNT(*) AS c FROM orders').get().c) + 1;
  let orderNo = genNo('SO', seq);
  while (db.prepare('SELECT 1 AS x FROM orders WHERE order_no = ?').get(orderNo)) {
    orderNo = genNo('SO', ++seq);
  }

  let orderId;
  db.exec('BEGIN');
  try {
    const t = now();
    const info = db.prepare(
      `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency,
        style_name, cus_order_no, manager, order_date, delivery_method, trade_terms, delivery_days,
        delivery_date, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(orderNo, 'custom', q.customer_id, 'draft', rate, q.total_usd, q.total_amount, 'USD',
      b.style_name || (q.items[0] && q.items[0].product_name) || null,
      null, b.manager || req.user.username || null, t.slice(0, 10),
      b.delivery_method || null, q.trade_terms || null, Number(q.delivery_days) || 0,
      q.valid_until || null,
      `由报价单 ${q.quote_no} 转入`, req.user.sub, t, t);
    orderId = Number(info.lastInsertRowid);

    const insItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, product_name, sku, remark, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?)'
    );
    const insSize = db.prepare(
      'INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?)'
    );
    for (const it of q.items) {
      const r = insItem.run(orderId, it.product_id, it.product_name, it.sku, `报价单行 ${it.id}`, it.qty, it.amount_usd, it.amount_cny);
      const itemId = Number(r.lastInsertRowid);
      // 报价阶段只有总量与美金单价，"均码/待分色"占位，下单后可在订单里改成真实颜色尺码
      insSize.run(itemId, '待定', '均码', it.qty, it.price_usd, round2(it.price_usd * rate), it.amount_usd, it.amount_cny);
    }

    db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(orderId, null, 'draft', req.user.username, `由报价单 ${q.quote_no} 转入`, t);
    db.prepare("UPDATE quotations SET status='converted', order_id=?, updated_at=? WHERE id=?").run(orderId, t, q.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, { order_id: orderId, order_no: orderNo, quote: full(q.id) });
}));

// ---------- 删除（仅草稿） ----------
router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
  if (!q) return fail(res, 404, '报价单不存在');
  if (q.status !== 'draft') return fail(res, 400, '只有草稿可以删除');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM quotation_items WHERE quote_id = ?').run(q.id);
    db.prepare('DELETE FROM quotations WHERE id = ?').run(q.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, { deleted: 1 });
}));

module.exports = router;
