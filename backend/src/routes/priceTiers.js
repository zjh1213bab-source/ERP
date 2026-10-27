/**
 * 阶梯报价（按数量区间定价）
 * GET    /api/price-tiers?product_id=1      某款的全部阶梯（不传 product_id 返回全部）
 * GET    /api/price-tiers/lookup?product_id=1&qty=500   按数量匹配单价
 * POST   /api/price-tiers                    { product_id, tiers:[{min_qty,max_qty,price_usd}] } 全量覆盖
 * DELETE /api/price-tiers/:id                删除单条阶梯
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'sales', 'tech'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 按数量匹配阶梯价：min_qty <= qty 且 (max_qty IS NULL 或 qty <= max_qty)，取 min_qty 最大者 */
function lookupTier(productId, qty) {
  const n = Number(qty) || 0;
  const tier = db.prepare(
    `SELECT * FROM price_tiers WHERE product_id = ? AND min_qty <= ? AND (max_qty IS NULL OR max_qty = 0 OR ? <= max_qty)
     ORDER BY min_qty DESC LIMIT 1`
  ).get(productId, n, n);
  return tier || null;
}

router.get('/', authRequired, wrap(async (req, res) => {
  const pid = Number(req.query.product_id) || 0;
  if (pid) {
    return ok(res, db.prepare('SELECT * FROM price_tiers WHERE product_id = ? ORDER BY min_qty').all(pid));
  }
  return ok(res, db.prepare(
    `SELECT t.*, p.name AS product_name, p.sku FROM price_tiers t
     LEFT JOIN products p ON p.id = t.product_id ORDER BY t.product_id, t.min_qty`
  ).all());
}));

router.get('/lookup', authRequired, wrap(async (req, res) => {
  const pid = Number(req.query.product_id) || 0;
  const qty = Number(req.query.qty) || 0;
  if (!pid) return fail(res, 400, '缺少 product_id');
  const tier = lookupTier(pid, qty);
  const product = db.prepare('SELECT id, sku, name, price FROM products WHERE id = ?').get(pid);
  if (!product) return fail(res, 404, '产品不存在');
  return ok(res, {
    product_id: pid,
    qty,
    price_usd: tier ? Number(tier.price_usd) : Number(product.price || 0),
    tier_id: tier ? tier.id : null,
    matched: !!tier,
    source: tier ? 'tier' : 'product'
  });
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const pid = Number(b.product_id) || 0;
  if (!pid) return fail(res, 400, '缺少 product_id');
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(pid);
  if (!product) return fail(res, 404, '产品不存在');

  const tiers = Array.isArray(b.tiers) ? b.tiers : [];
  for (const t of tiers) {
    if (!(Number(t.min_qty) >= 1)) return fail(res, 400, '阶梯起始数量必须 ≥ 1');
    if (Number(t.price_usd) < 0) return fail(res, 400, '单价不能为负');
    if (t.max_qty && Number(t.max_qty) < Number(t.min_qty)) {
      return fail(res, 400, `区间结束数量（${t.max_qty}）不能小于起始数量（${t.min_qty}）`);
    }
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM price_tiers WHERE product_id = ?').run(pid);
    const ins = db.prepare('INSERT INTO price_tiers (product_id, min_qty, max_qty, price_usd, created_at) VALUES (?,?,?,?,?)');
    const t0 = now();
    tiers
      .slice()
      .sort((a, b2) => Number(a.min_qty) - Number(b2.min_qty))
      .forEach((t) => {
        const maxQty = Number(t.max_qty) > 0 ? Number(t.max_qty) : null;
        ins.run(pid, Number(t.min_qty) || 1, maxQty, round2(t.price_usd), t0);
      });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, db.prepare('SELECT * FROM price_tiers WHERE product_id = ? ORDER BY min_qty').all(pid));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const info = db.prepare('DELETE FROM price_tiers WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, '阶梯不存在');
  return ok(res, { deleted: info.changes });
}));

module.exports = router;
module.exports.lookupTier = lookupTier;
