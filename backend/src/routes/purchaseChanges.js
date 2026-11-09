/**
 * 停单改量与供应商退料（原型 TS-N07-06）
 * 流程：原需求变更 → 未交协商 → 实物处置（退料） → 贷项/差异结算
 *
 * GET  /api/purchase-changes/board                    变更+退料看板（指标 + 列表）
 * GET  /api/purchase-changes/po/:poId                 采购单可改行：未交/已收/已领/已退/可退
 * POST /api/purchase-changes                          建变更单（reduce 减量 / cancel 停单）
 * POST /api/purchase-changes/:id/submit               提交供方确认（draft → pending_supplier）
 * POST /api/purchase-changes/:id/supplier-confirm     供方确认（→ confirmed / rejected）
 * POST /api/purchase-changes/:id/effective            生效（减量落采购行 / 停单落 cancelled）
 * POST /api/purchase-changes/:id/void                 作废（未生效前）
 * GET  /api/purchase-changes/returns                  退料单列表
 * POST /api/purchase-changes/returns                  建退料单
 * POST /api/purchase-changes/returns/:id/physical     实物回执（扣库存）
 * POST /api/purchase-changes/returns/:id/credit       贷项回执（差异结算）
 * POST /api/purchase-changes/returns/:id/void         作废（实物未退前）
 *
 * 硬规则：
 * 1. 取消/减量不自动抹掉在途、已领材料或供应商债务 —— 减量只动「未交」；已收只能退不能停
 * 2. 减量 delta ≤ qty − received_qty（未交）；超了 400
 * 3. 整单停单：有已收的先退料，否则 400
 * 4. 退料量 ≤ 已收 − 已领 − 已退（可退）；不超退
 * 5. 退料要两道回执：实物回执（物流/签收）+ 贷项回执（供应商贷项凭证），缺一道不算完成
 * 6. 减量/停单生效后，齐套的在途 = qty − received 自动下降（停单 status=cancelled 被排除）
 * 7. 已开工量、已完成量、应付款保留；差异走贷项凭证冲减，不直接删财务
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { nextNo } = require('../utils/docNo');

const router = express.Router();
const WRITE = ['admin', 'sales', 'warehouse', 'production'];
const READ = ['admin', 'sales', 'warehouse', 'production', 'tech', 'finance'];

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const EPS = 0.005;

const CHG_LABEL = {
  draft: '草稿', pending_supplier: '待供方确认', confirmed: '供方已确认',
  rejected: '供方拒绝', effective: '已生效', voided: '已作废'
};
const RET_LABEL = {
  pending_receipt: '待实物回执', returned: '实物已退', credited: '贷项已收', done: '完成', voided: '已作废'
};

function poLines(poId) {
  const rows = db.prepare(
    `SELECT id, material_id, name, spec, unit, qty, received_qty, issued_qty, returned_qty, price, amount
     FROM purchase_items WHERE po_id = ? ORDER BY id`
  ).all(poId).map((r) => {
    const qty = Number(r.qty) || 0;
    const recv = Number(r.received_qty) || 0;
    const issued = Number(r.issued_qty) || 0;
    const ret = Number(r.returned_qty) || 0;
    return {
      ...r,
      pending_qty: round2(qty - recv),
      returnable_qty: round2(recv - issued - ret),
      qty: qty, received_qty: recv, issued_qty: issued, returned_qty: ret
    };
  });
  return rows;
}

function changeView(id) {
  const c = db.prepare('SELECT * FROM purchase_changes WHERE id = ?').get(id);
  if (!c) return null;
  c.items = db.prepare('SELECT * FROM purchase_change_items WHERE change_id = ? ORDER BY id').all(id);
  c.status_label = CHG_LABEL[c.status] || c.status;
  return c;
}

function returnView(id) {
  const r = db.prepare('SELECT * FROM purchase_returns WHERE id = ?').get(id);
  if (!r) return null;
  r.items = db.prepare('SELECT * FROM purchase_return_items WHERE return_id = ? ORDER BY id').all(id);
  r.status_label = RET_LABEL[r.status] || r.status;
  return r;
}

// ---------------- 看板 ----------------
router.get('/board', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { status = '', q = '' } = req.query;
  const w = [];
  const p = [];
  if (status) { w.push('status = ?'); p.push(status); }
  if (q) { w.push('(change_no LIKE ? OR po_no LIKE ? OR supplier_name LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const changes = db.prepare('SELECT * FROM purchase_changes ' + (w.length ? 'WHERE ' + w.join(' AND ') + ' ' : '') + 'ORDER BY id DESC').all(...p)
    .map((c) => ({ ...c, status_label: CHG_LABEL[c.status] || c.status }));

  const w2 = [];
  const p2 = [];
  if (status) { w2.push('status = ?'); p2.push(status); }
  if (q) { w2.push('(return_no LIKE ? OR po_no LIKE ? OR supplier_name LIKE ?)'); p2.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const returns = db.prepare('SELECT * FROM purchase_returns ' + (w2.length ? 'WHERE ' + w2.join(' AND ') + ' ' : '') + 'ORDER BY id DESC').all(...p2)
    .map((r) => ({ ...r, status_label: RET_LABEL[r.status] || r.status }));

  const stat = {
    changes: changes.length,
    pending_supplier: changes.filter((c) => c.status === 'pending_supplier').length,
    returns: returns.length,
    pending_receipt: returns.filter((r) => r.status === 'pending_receipt').length,
    returned: returns.filter((r) => r.status === 'returned').length,
    pending_credit: returns.filter((r) => ['returned', 'credited'].includes(r.status)).length
  };
  return ok(res, { changes, returns, stat });
}));

// ---------------- 采购单可改行 ----------------
router.get('/po/:poId', authRequired, requireRole(READ), wrap(async (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.poId);
  if (!po) return fail(res, 404, '采购单不存在');
  const lines = poLines(po.id);
  const totalRecv = lines.reduce((a, l) => a + l.received_qty, 0);
  return ok(res, {
    po,
    lines,
    has_received: totalRecv > EPS,
    summary: {
      total_qty: round2(lines.reduce((a, l) => a + l.qty, 0)),
      total_received: round2(totalRecv),
      total_pending: round2(lines.reduce((a, l) => a + l.pending_qty, 0)),
      total_returnable: round2(lines.reduce((a, l) => a + l.returnable_qty, 0))
    }
  });
}));

// ---------------- 建变更单 ----------------
router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(Number(b.po_id));
  if (!po) return fail(res, 404, '采购单不存在');
  if (['draft', 'cancelled'].includes(po.status)) return fail(res, 400, '草稿或已取消的采购单不用走变更');
  const type = b.type === 'cancel' ? 'cancel' : 'reduce';
  const reason = String(b.reason || '').trim();
  if (!reason) return fail(res, 400, '请写明变更原因（客户改单 / 停产 / 换料 / 交期取消…）');

  const lines = poLines(po.id);
  let list = [];
  if (type === 'cancel') {
    const totalRecv = lines.reduce((a, l) => a + l.received_qty, 0);
    if (totalRecv > EPS) return fail(res, 400, '这张单已经有到货，不能整单停单。请对「未交」部分做减量，已收未用的走「退料」');
    list = lines.map((l) => ({ po_item_id: l.id, reduce_qty: l.qty }));
  } else {
    list = Array.isArray(b.items) ? b.items.filter((x) => Number(x.reduce_qty) > 0) : [];
    if (!list.length) return fail(res, 400, '请至少填一行减量数量');
  }

  const items = [];
  let totalReduce = 0;
  let totalReturnable = 0;
  for (const it of list) {
    const line = lines.find((l) => l.id === Number(it.po_item_id));
    if (!line) continue;
    const reduce = round2(it.reduce_qty);
    if (reduce <= 0) continue;
    if (reduce > line.pending_qty + EPS) {
      return fail(res, 400, `「${line.name}」减量 ${reduce} 超过未交量 ${line.pending_qty}。已收的料不能停，只能退`);
    }
    totalReduce += reduce;
    totalReturnable += line.returnable_qty;
    items.push({
      po_item_id: line.id,
      material_id: line.material_id,
      material_name: line.name,
      spec: line.spec, unit: line.unit,
      qty: line.qty, received_qty: line.received_qty, issued_qty: line.issued_qty, returned_qty: line.returned_qty,
      pending_qty: line.pending_qty,
      new_qty: round2(line.qty - reduce),
      reduce_qty: reduce,
      returnable_qty: line.returnable_qty,
      return_flag: it.return_flag ? 1 : 0
    });
  }
  if (!items.length) return fail(res, 400, '没有可变更的行');

  const changeNo = nextNo('PC', 'purchase_changes', 'change_no');
  const t = now();
  let id;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO purchase_changes (change_no, po_id, po_no, supplier_id, supplier_name, type, reason, note,
        reduce_qty, returnable_qty, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?)`
    ).run(changeNo, po.id, po.po_no, po.supplier_id, po.supplier, type, reason, b.note || null,
      round2(totalReduce), round2(totalReturnable), req.user.username, t, t);
    id = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO purchase_change_items (change_id, po_item_id, material_id, material_name, spec, unit,
        qty, received_qty, issued_qty, returned_qty, pending_qty, new_qty, reduce_qty, returnable_qty, return_flag)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    items.forEach((x) => ins.run(id, x.po_item_id, x.material_id, x.material_name, x.spec, x.unit,
      x.qty, x.received_qty, x.issued_qty, x.returned_qty, x.pending_qty, x.new_qty, x.reduce_qty, x.returnable_qty, x.return_flag));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, changeView(id));
}));

router.post('/:id/submit', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM purchase_changes WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '变更单不存在');
  if (c.status !== 'draft') return fail(res, 400, '只有草稿能提交供方确认');
  db.prepare("UPDATE purchase_changes SET status='pending_supplier', updated_at=? WHERE id=?").run(now(), c.id);
  return ok(res, changeView(c.id));
}));

router.post('/:id/supplier-confirm', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM purchase_changes WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '变更单不存在');
  if (c.status !== 'pending_supplier') return fail(res, 400, '只有待供方确认的能确认');
  const b = req.body || {};
  const agree = b.agree === true || b.agree === 1 || b.agree === '1';
  const t = now();
  if (agree) {
    db.prepare("UPDATE purchase_changes SET status='confirmed', supplier_confirmed_by=?, supplier_confirmed_at=?, supplier_comment=?, updated_at=? WHERE id=?")
      .run(b.supplier_confirmed_by || '供应商', t, b.supplier_comment || null, t, c.id);
  } else {
    const comment = String(b.supplier_comment || '').trim();
    if (!comment) return fail(res, 400, '供方拒绝必须写明理由');
    db.prepare("UPDATE purchase_changes SET status='rejected', supplier_confirmed_by=?, supplier_confirmed_at=?, supplier_comment=?, updated_at=? WHERE id=?")
      .run(b.supplier_confirmed_by || '供应商', t, comment, t, c.id);
  }
  return ok(res, changeView(c.id));
}));

/** 生效：减量落采购行（只动未交），停单落 cancelled */
router.post('/:id/effective', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM purchase_changes WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '变更单不存在');
  if (c.status !== 'confirmed') return fail(res, 400, '只有供方已确认的变更才能生效');
  const items = db.prepare('SELECT * FROM purchase_change_items WHERE change_id = ?').all(c.id);
  const t = now();

  db.exec('BEGIN');
  try {
    if (c.type === 'cancel') {
      db.prepare("UPDATE purchase_orders SET status='cancelled', updated_at=? WHERE id=?").run(t, c.po_id);
    } else {
      for (const it of items) {
        // 重新校验未交量（防止提交后又收货）
        const line = db.prepare('SELECT * FROM purchase_items WHERE id = ?').get(it.po_item_id);
        if (!line) continue;
        const pending = round2((Number(line.qty) || 0) - (Number(line.received_qty) || 0));
        if (it.reduce_qty > pending + EPS) {
          db.exec('ROLLBACK');
          return fail(res, 400, `「${it.material_name}」当前未交 ${pending}，已不足以减 ${it.reduce_qty}（可能刚又到货）。请刷新后重算`);
        }
        const newQty = round2((Number(line.qty) || 0) - it.reduce_qty);
        db.prepare('UPDATE purchase_items SET qty = ?, amount = ? WHERE id = ?')
          .run(newQty, round2(newQty * (Number(line.price) || 0)), line.id);
      }
      // 采购单总额重算
      const amt = db.prepare('SELECT COALESCE(SUM(amount),0) a FROM purchase_items WHERE po_id = ?').get(c.po_id).a;
      db.prepare('UPDATE purchase_orders SET total_amount = ?, updated_at = ? WHERE id = ?').run(round2(amt), t, c.po_id);
    }
    db.prepare("UPDATE purchase_changes SET status='effective', effective_by=?, effective_at=?, updated_at=? WHERE id=?")
      .run(req.user.username, t, t, c.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, changeView(c.id));
}));

router.post('/:id/void', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM purchase_changes WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '变更单不存在');
  if (c.status === 'effective') return fail(res, 400, '已生效的变更不能作废，请另开变更单调回');
  db.prepare("UPDATE purchase_changes SET status='voided', updated_at=? WHERE id=?").run(now(), c.id);
  return ok(res, changeView(c.id));
}));

// ---------------- 退料 ----------------
router.get('/returns', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { status = '' } = req.query;
  const w = [];
  const p = [];
  if (status) { w.push('status = ?'); p.push(status); }
  const rows = db.prepare('SELECT * FROM purchase_returns ' + (w.length ? 'WHERE ' + w.join(' AND ') + ' ' : '') + 'ORDER BY id DESC').all(...p);
  return ok(res, rows.map((r) => ({ ...r, status_label: RET_LABEL[r.status] || r.status })));
}));

router.post('/returns', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(Number(b.po_id));
  if (!po) return fail(res, 404, '采购单不存在');
  const reason = String(b.reason || '').trim();
  if (!reason) return fail(res, 400, '请写明退料原因（客户取消 / 换料 / 质量 / 超购…）');
  const list = Array.isArray(b.items) ? b.items.filter((x) => Number(x.qty) > 0) : [];
  if (!list.length) return fail(res, 400, '请至少填一行退料数量');

  const lines = poLines(po.id);
  const items = [];
  let total = 0;
  let totalAmt = 0;
  for (const it of list) {
    const line = lines.find((l) => l.id === Number(it.po_item_id));
    if (!line) continue;
    const qty = round2(it.qty);
    if (qty <= 0) continue;
    if (qty > line.returnable_qty + EPS) {
      return fail(res, 400, `「${line.name}」退料 ${qty} 超过可退量 ${line.returnable_qty}（已收 ${line.received_qty} − 已领 ${line.issued_qty} − 已退 ${line.returned_qty}）。不超退`);
    }
    total += qty;
    totalAmt += round2(qty * (Number(line.price) || 0));
    items.push({
      po_item_id: line.id, material_id: line.material_id, material_name: line.name, spec: line.spec, unit: line.unit,
      qty, unit_price: round2(line.price), amount: round2(qty * (Number(line.price) || 0))
    });
  }
  if (!items.length) return fail(res, 400, '没有可退的行');

  const returnNo = nextNo('RT', 'purchase_returns', 'return_no');
  const t = now();
  let id;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO purchase_returns (return_no, po_id, po_no, change_id, supplier_id, supplier_name, reason, note,
        return_qty, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'pending_receipt', ?, ?, ?)`
    ).run(returnNo, po.id, po.po_no, b.change_id || null, po.supplier_id, po.supplier, reason, b.note || null,
      round2(total), req.user.username, t, t);
    id = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO purchase_return_items (return_id, po_item_id, material_id, material_name, spec, unit, qty, unit_price, amount)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    items.forEach((x) => ins.run(id, x.po_item_id, x.material_id, x.material_name, x.spec, x.unit, x.qty, x.unit_price, x.amount));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, returnView(id));
}));

/** 实物回执：退回实物，扣可用库存 + 记已退 */
router.post('/returns/:id/physical', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM purchase_returns WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '退料单不存在');
  if (r.status !== 'pending_receipt') return fail(res, 400, '只有待实物回执的能登记回执');
  const note = String((req.body || {}).note || '').trim();
  if (!note) return fail(res, 400, '请填实物回执依据（物流单号 / 供应商签收）');
  const items = db.prepare('SELECT * FROM purchase_return_items WHERE return_id = ?').all(r.id);
  const t = now();
  db.exec('BEGIN');
  try {
    for (const it of items) {
      // 扣本厂可用库存（退回给供应商）—— 统一走 M10 的 applyStock，保证有流水可追
      if (it.material_id) {
        require('../services/matflow').applyStock({
          materialId: it.material_id,
          type: 'po_return',
          qty: -it.qty,
          refType: 'purchase_return',
          refId: r.id,
          refNo: r.return_no,
          remark: `退回供应商 · ${r.supplier_name || ''}`.trim(),
          operator: req.user.username
        }, t);
      }
      db.prepare('UPDATE purchase_items SET returned_qty = COALESCE(returned_qty,0) + ? WHERE id = ?').run(it.qty, it.po_item_id);
    }
    db.prepare("UPDATE purchase_returns SET status='returned', physical_receipt_note=?, physical_by=?, physical_at=?, updated_at=? WHERE id=?")
      .run(note, req.user.username, t, t, r.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, returnView(r.id));
}));

/** 贷项回执：供应商出贷项凭证冲减应付，差异结算 */
router.post('/returns/:id/credit', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM purchase_returns WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '退料单不存在');
  if (r.status !== 'returned') return fail(res, 400, '先拿到实物回执，再收贷项凭证');
  const b = req.body || {};
  const creditNo = String(b.credit_note_no || '').trim();
  if (!creditNo) return fail(res, 400, '请填供应商贷项凭证号');
  const creditAmt = round2(b.credit_amount);
  const t = now();
  db.prepare("UPDATE purchase_returns SET status='done', credit_note_no=?, credit_amount=?, credit_by=?, credit_at=?, updated_at=? WHERE id=?")
    .run(creditNo, creditAmt, req.user.username, t, t, r.id);
  return ok(res, returnView(r.id));
}));

router.post('/returns/:id/void', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM purchase_returns WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '退料单不存在');
  if (r.status === 'returned' || r.status === 'done') return fail(res, 400, '实物已退的退料单不能作废，要退回来另走流程');
  db.prepare("UPDATE purchase_returns SET status='voided', updated_at=? WHERE id=?").run(now(), r.id);
  return ok(res, returnView(r.id));
}));

module.exports = router;
