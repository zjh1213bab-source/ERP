/**
 * 采购管理（面辅料）
 * GET  /api/purchases?status=&q=
 * GET  /api/purchases/:id
 * POST /api/purchases            { supplier, order_date, expect_date, remark, items:[{material_id,name,spec,unit,qty,price}] }
 * POST /api/purchases/:id/order  草稿 → 已下单
 * POST /api/purchases/:id/receive { items:[{id, qty}] }  到货点收 → 生成收料单（待检，不进可用库存）
 * DELETE /api/purchases/:id      草稿可删
 *
 * 硬规则：**收货不自动可用**。这里只记「到货事实」并生成收料单（GRN），
 *        面辅料库存要等「原料收货检验」判定合格后才增加（原型 TS-N10-08）。
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { qualificationGate } = require('./supplierEvals');

const router = express.Router();
const WRITE = ['admin', 'warehouse'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 供方识别：优先 supplier_id，其次按档案名/简称回退（历史数据只有名字） */
function resolveSupplier(b) {
  if (b.supplier_id) {
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(b.supplier_id));
    if (s) return s;
  }
  const name = String(b.supplier || '').trim();
  if (!name) return null;
  return db.prepare('SELECT * FROM suppliers WHERE name = ? OR short_name = ? LIMIT 1').get(name, name) || null;
}

function full(id) {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
  if (!po) return null;
  po.items = db.prepare('SELECT * FROM purchase_items WHERE po_id = ? ORDER BY id').all(id);
  po.receipts = db.prepare('SELECT id, grn_no, receive_date, status, receive_qty, pass_qty, pending_qty FROM goods_receipts WHERE po_id = ? ORDER BY id DESC').all(id);
  return po;
}

router.get('/', authRequired, wrap(async (req, res) => {
  const { status = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (q) { where.push('(po_no LIKE ? OR supplier LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const sql = 'SELECT * FROM purchase_orders ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/:id', authRequired, wrap(async (req, res) => {
  const po = full(req.params.id);
  if (!po) return fail(res, 404, '采购单不存在');
  return ok(res, po);
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return fail(res, 400, '至少需要一条采购明细');
  const total = items.reduce((s, it) => s + round2((Number(it.qty) || 0) * (Number(it.price) || 0)), 0);

  // 供货资格门禁（TS-N07-05）：暂停的供应商不能建新采购单
  const sup = resolveSupplier(b);
  if (!sup) return fail(res, 400, '请选择供应商档案里的供方（不能用临时名字下单，评价挂不上）');
  const gate = qualificationGate(sup.id);
  if (!gate.ok) return fail(res, 400, `${sup.name} ${gate.reason}。请先处理整改，或改用其他合格供方`);

  let seq = db.prepare('SELECT COUNT(*) AS c FROM purchase_orders').get().c + 1;
  let poNo = genNo('CG', seq);
  while (db.prepare('SELECT 1 AS x FROM purchase_orders WHERE po_no = ?').get(poNo)) {
    poNo = genNo('CG', ++seq);
  }

  let id;
  db.exec('BEGIN');
  try {
    const t = now();
    const info = db.prepare(
      'INSERT INTO purchase_orders (po_no, supplier, supplier_id, status, order_date, expect_date, remark, total_amount, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(poNo, sup.name, sup.id, 'draft', b.order_date || null, b.expect_date || null, b.remark || null, round2(total), req.user.sub, t, t);
    id = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO purchase_items (po_id, material_id, name, spec, unit, qty, price, amount) VALUES (?,?,?,?,?,?,?,?)');
    items.forEach((it) => {
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      ins.run(id, it.material_id || null, it.name || '未命名物料', it.spec || null, it.unit || null, qty, price, round2(qty * price));
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const out = full(id);
  out.qualification_warning = gate.reason || null;
  return ok(res, out);
}));

router.post('/:id/order', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return fail(res, 404, '采购单不存在');
  if (po.status !== 'draft') return fail(res, 400, '只有草稿可下单');
  db.prepare("UPDATE purchase_orders SET status='ordered', updated_at=? WHERE id=?").run(now(), req.params.id);
  return ok(res, full(req.params.id));
}));

/**
 * 到货点收 → 生成收料单（GRN），全部进「待检」，**面辅料可用库存不增加**
 * 检验合格的部分才由「原料收货检验」加库存。
 */
router.post('/:id/receive', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return fail(res, 404, '采购单不存在');
  if (!['ordered', 'received'].includes(po.status)) return fail(res, 400, '只有已下单的采购单可收货');
  const list = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!list.length) return fail(res, 400, '请填写到货数量');

  const t = now();
  const ymd = t.slice(0, 10).replace(/-/g, '');
  let grnId = null;
  let grnNo = null;
  db.exec('BEGIN');
  try {
    // 收料单头
    const seq = Number(db.prepare('SELECT COUNT(*) AS c FROM goods_receipts WHERE grn_no LIKE ?').get(`GRN${ymd}%`).c) + 1;
    grnNo = genNo('GRN', seq);
    const gh = db.prepare(
      `INSERT INTO goods_receipts (grn_no, po_id, po_no, supplier, supplier_id, receive_date, warehouse, status,
        receive_by, receive_at, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?, '原料库', 'pending', ?,?,?,?,?,?)`
    ).run(grnNo, po.id, po.po_no, po.supplier || null, po.supplier_id || null, t.slice(0, 10),
      req.user.username, t, '采购页点收自动生成，待来料检查', req.user.username, t, t);
    grnId = Number(gh.lastInsertRowid);

    const insItem = db.prepare(
      `INSERT INTO goods_receipt_items (grn_id, po_item_id, material_id, material_name, spec, unit,
        expect_qty, receive_qty, diff_qty, diff_type, pending_qty, pass_qty, freeze_qty, reject_qty, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,'pending',?,?)`
    );

    for (const it of list) {
      const row = db.prepare('SELECT * FROM purchase_items WHERE id = ? AND po_id = ?').get(it.id, po.id);
      if (!row) continue;
      const add = round2(it.qty);
      if (add <= 0) continue;
      const expect = round2(Math.max(0, Number(row.qty) - Number(row.received_qty)));
      const diff = round2(add - expect);
      insItem.run(
        grnId, row.id, row.material_id || null, row.name, row.spec || null, row.unit || null,
        expect, add, diff, diff > 0.005 ? 'over' : diff < -0.005 ? 'short' : 'none',
        add, t, t
      );
      db.prepare('UPDATE purchase_items SET received_qty = ? WHERE id = ?')
        .run(round2(Number(row.received_qty) + add), row.id);
    }

    // 汇总
    const rows = db.prepare('SELECT * FROM goods_receipt_items WHERE grn_id = ?').all(grnId);
    const sum = (f) => round2(rows.reduce((s, r) => s + (Number(r[f]) || 0), 0));
    db.prepare(
      `UPDATE goods_receipts SET line_count = ?, expect_qty = ?, receive_qty = ?, pending_qty = ?,
        over_qty = ?, short_qty = ?, updated_at = ? WHERE id = ?`
    ).run(
      rows.length, sum('expect_qty'), sum('receive_qty'), sum('pending_qty'),
      round2(rows.filter((r) => r.diff_type === 'over').reduce((s, r) => s + Number(r.diff_qty), 0)),
      round2(Math.abs(rows.filter((r) => r.diff_type === 'short').reduce((s, r) => s + Number(r.diff_qty), 0))),
      t, grnId
    );

    const items = db.prepare('SELECT qty, received_qty FROM purchase_items WHERE po_id = ?').all(po.id);
    const allDone = items.length > 0 && items.every((x) => Number(x.received_qty) + 0.005 >= Number(x.qty));
    db.prepare('UPDATE purchase_orders SET status=?, updated_at=? WHERE id=?').run(allDone ? 'received' : 'ordered', t, po.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `点收失败：${e.message}`);
  }

  const po2 = full(po.id);
  return ok(res, {
    ...po2,
    grn_id: grnId,
    grn_no: grnNo,
    notice: `已生成收料单 ${grnNo}，全部进入「待检」；来料检查合格后才会进可用库存`
  });
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return fail(res, 404, '采购单不存在');
  if (po.status !== 'draft') return fail(res, 400, '只能删除草稿');
  db.prepare('DELETE FROM purchase_items WHERE po_id = ?').run(req.params.id);
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(req.params.id);
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
