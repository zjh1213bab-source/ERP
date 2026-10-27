/**
 * 库存原子操作（多模块复用）
 * ------------------------------------------------------------
 * 原先是 routes/stock.js 里的私有函数，零售/渠道履约也要扣美仓现货，
 * 抽到这里避免复制粘贴出现两套口径（一处改了另一处忘改是最常见的事故源）。
 *
 * 约定：
 *  - style_no / color / size 统一用空串占位，不用 NULL，保证 UNIQUE 约束生效
 *  - applyStock 传入负数量时库存不足直接抛错，由上层决定回滚
 *  - 任何数量变动都必须同时写 stock_ledger，便于批次追溯
 */
const { db, now } = require('../db');

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 取某仓某款某色某码的库存行 */
function getStock(warehouse, styleNo, color, size) {
  return db
    .prepare('SELECT * FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?')
    .get(warehouse, styleNo || '', color || '', size || '');
}

/** 增减库存（delta 可负），返回变动后的数量；不足时抛错 */
function applyStock({ warehouse, style_no, product_name, color, size, delta }) {
  const sn = style_no || '';
  const c = color || '';
  const s = size || '';
  const row = getStock(warehouse, sn, c, s);
  const t = now();
  if (row) {
    const next = round2(Number(row.qty) + Number(delta));
    if (next < 0) throw new Error(`库存不足：${product_name || sn} / ${c} / ${s} 现有 ${row.qty}`);
    db.prepare('UPDATE stock_items SET qty=?, product_name=COALESCE(?, product_name), updated_at=? WHERE id=?')
      .run(next, product_name || null, t, row.id);
    return next;
  }
  if (Number(delta) < 0) throw new Error(`库存不足：${product_name || sn} / ${c} / ${s} 无库存`);
  db.prepare('INSERT INTO stock_items (warehouse, style_no, product_name, color, size, qty, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(warehouse, sn, product_name || '', c, s, round2(delta), t);
  return round2(delta);
}

/** 写库存流水 */
function addLedger({ warehouse, style_no, product_name, color, size, type, qty, ref_type, ref_id, remark, operator }) {
  db.prepare(
    `INSERT INTO stock_ledger (warehouse, style_no, product_name, color, size, type, qty, ref_type, ref_id, remark, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(warehouse, style_no || '', product_name || '', color || '', size || '', type, qty,
    ref_type || 'manual', ref_id || null, remark || null, operator || null, now());
}

/** 某仓某款的可售总量（跨颜色尺码汇总） */
function availableQty(warehouse, styleNo) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(qty),0) AS q FROM stock_items WHERE warehouse = ? AND style_no = ?'
  ).get(warehouse, styleNo || '');
  return round2(r.q) || 0;
}

module.exports = { round2, getStock, applyStock, addLedger, availableQty };
