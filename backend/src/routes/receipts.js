/**
 * 生产原料收货与检验（对应原型 TS-N10-08）
 * ------------------------------------------------------------------
 * 流程：P3 到料 → 仓库点收（收料单）→ 来料检查 → 只有合格量才进可用库存 → P4 配出合格量
 *
 * 硬规则（写在代码里）：
 *   1) **收货不自动可用**：点收后全部进「待检」，`materials.stock_qty` 一分不加；
 *      检验判定合格的那部分才加库存，齐套/裁床才看得到。
 *   2) 超收（实收 > 应收）必须写原因，主表单独记 `over_qty` 供调查；短收记 `short_qty` 待补。
 *   3) 卷缸可追：每条收料行必须能挂卷号 / 缸号 / 原料库位（面料至少要缸号）。
 *   4) 检验分流必须对得上：`合格 + 冻结 + 退回 = 本次检验量`，不允许凭空进出。
 *   5) 冻结与退回必须写原因；冻结量可复核放行转合格，或转退回。
 *   6) 退回 → 采购行 `received_qty` 回退，采购单不会被误标「已收货」，等供应商补发。
 *   7) 只有没检验过的收料单能作废，作废同时回退采购行已收数量。
 */
const express = require('express');

const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const scope = require('../access/companyScope');

/**
 * 收料单的主体
 *
 * goods_receipts 没有 company_id，它通过 po_id 挂在采购单上 —— 采购单这一层
 * v1.63 才有主体列。所以收料单一律按「父表」判归属：
 *   `po_id IN (SELECT id FROM purchase_orders WHERE company_id = N)`
 * 收货是库存与应付的起点，这一层不收窄，分部进来能看到别家到货了什么料、多少钱。
 */
const cidOf = (req) => scope.filterCompanyId(req.user);
const poScope = (cid, col = 'po_id') => scope.parentClauseSql(cid, 'purchase_orders', col).sql;

/** 采购单归属校验（收料动作的前置） */
function assertPo(req, poId) {
  const r = scope.assertRow(req.user, 'purchase_orders', poId, '采购单');
  if (!r.ok) {
    const e = new Error(r.reason);
    e.status = r.status;
    throw e;
  }
  return r.row;
}

/** 收料单归属校验：顺着 po_id 判（跨主体按不存在处理） */
function grnOr404(req, id) {
  const g = db.prepare('SELECT * FROM goods_receipts WHERE id = ?').get(Number(id));
  if (!g) { const e = new Error('收料单不存在'); e.status = 404; throw e; }
  if (g.po_id && !scope.assertRow(req.user, 'purchase_orders', g.po_id, '采购单').ok) {
    const e = new Error('收料单不存在'); e.status = 404; throw e;
  }
  return g;
}

const router = express.Router();
const WRITE = ['admin', 'warehouse', 'production'];   // 仓库点收 / 来料检查
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const int0 = (v) => (Number(v) || 0);
const EPS = 0.005;

const STATUS = {
  pending: '待检',
  inspecting: '检验中',
  partial: '部分合格',
  passed: '全部合格',
  rejected: '全退',
  cancelled: '已作废'
};
const LINE_STATUS = {
  pending: '待检',
  passed: '合格',
  partial: '部分合格',
  frozen: '冻结',
  rejected: '退回'
};
const DIFF = { none: '', over: '超收', short: '短收' };

/* ---------------- 基础工具 ---------------- */

function nextGrnNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const row = db.prepare('SELECT grn_no FROM goods_receipts WHERE grn_no LIKE ? ORDER BY id DESC LIMIT 1').get(`GRN${ymd}%`);
  const seq = row ? Number(String(row.grn_no).slice(-4)) + 1 : 1;
  return genNo('GRN', seq);
}

/** 采购行剩余应收 */
function remainOf(poItem) {
  return round2(Math.max(0, int0(poItem.qty) - int0(poItem.received_qty)));
}

/** 采购行已收数量回退（退回 / 作废时用），不会低于 0 */
function rollbackReceived(poItemId, qty) {
  const row = db.prepare('SELECT * FROM purchase_items WHERE id = ?').get(poItemId);
  if (!row) return;
  const next = round2(Math.max(0, int0(row.received_qty) - Math.abs(int0(qty))));
  db.prepare('UPDATE purchase_items SET received_qty = ? WHERE id = ?').run(next, row.id);
}

/** 采购单状态重算：全收齐才 received，否则回 ordered */
function refreshPoStatus(poId) {
  if (!poId) return;
  const items = db.prepare('SELECT qty, received_qty FROM purchase_items WHERE po_id = ?').all(poId);
  if (!items.length) return;
  const allDone = items.every((x) => int0(x.received_qty) + EPS >= int0(x.qty));
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  if (!po || po.status === 'draft' || po.status === 'cancelled') return;
  const next = allDone ? 'received' : 'ordered';
  if (po.status !== next) db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?').run(next, now(), poId);
}

/**
 * 只有合格量进可用库存（原料库存 = materials.stock_qty）
 * 走 M10 的 `applyStock` 统一入口：**改余额必须同时写流水**，
 * 否则盘点差异永远归因不到「收错了」还是「领多了」。
 */
function addMaterialStock(materialId, qty, ctx) {
  if (!materialId || Math.abs(qty) < EPS) return;
  const M = require('../services/matflow');
  M.applyStock({
    materialId,
    type: 'receipt',
    qty: round2(qty),
    refType: 'goods_receipt',
    refId: ctx && ctx.grnId ? ctx.grnId : null,
    refNo: ctx && ctx.grnNo ? ctx.grnNo : null,
    remark: (ctx && ctx.remark) || '来料检验合格入库',
    operator: (ctx && ctx.operator) || 'system'
  }, now());
}

/** 汇总收料单 */
function summarize(grnId) {
  const rows = db.prepare('SELECT * FROM goods_receipt_items WHERE grn_id = ?').all(grnId);
  const g = db.prepare('SELECT * FROM goods_receipts WHERE id = ?').get(grnId);
  const sum = (f) => round2(rows.reduce((s, r) => s + int0(r[f]), 0));

  const pending = sum('pending_qty');
  const pass = sum('pass_qty');
  const freeze = sum('freeze_qty');
  const reject = sum('reject_qty');

  let status = g.status;
  if (status !== 'cancelled') {
    const touched = rows.some((r) => int0(r.pass_qty) + int0(r.freeze_qty) + int0(r.reject_qty) > EPS);
    if (pending > EPS && !touched) status = 'pending';
    else if (pending > EPS) status = 'inspecting';
    else if (pass > EPS && freeze < EPS && reject < EPS) status = 'passed';
    else if (pass > EPS) status = 'partial';
    else status = 'rejected';
  }

  db.prepare(
    `UPDATE goods_receipts SET line_count = ?, expect_qty = ?, receive_qty = ?, pending_qty = ?,
      pass_qty = ?, freeze_qty = ?, reject_qty = ?, over_qty = ?, short_qty = ?, status = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    rows.length, sum('expect_qty'), sum('receive_qty'), pending, pass, freeze, reject,
    round2(rows.filter((r) => r.diff_type === 'over').reduce((s, r) => s + int0(r.diff_qty), 0)),
    round2(Math.abs(rows.filter((r) => r.diff_type === 'short').reduce((s, r) => s + int0(r.diff_qty), 0))),
    status, now(), grnId
  );
  return db.prepare('SELECT * FROM goods_receipts WHERE id = ?').get(grnId);
}

/** 行状态 */
function lineStatus(it) {
  const p = int0(it.pending_qty);
  const pass = int0(it.pass_qty);
  const freeze = int0(it.freeze_qty);
  const reject = int0(it.reject_qty);
  if (p > EPS) return pass + freeze + reject > EPS ? 'partial' : 'pending';
  if (freeze > EPS && pass < EPS) return 'frozen';
  if (reject > EPS && pass < EPS && freeze < EPS) return 'rejected';
  if (freeze > EPS) return 'partial';
  if (reject > EPS) return 'partial';
  return 'passed';
}

function itemView(it) {
  return {
    ...it,
    expect_qty: round2(it.expect_qty),
    receive_qty: round2(it.receive_qty),
    diff_qty: round2(it.diff_qty),
    diff_label: DIFF[it.diff_type] || '',
    pending_qty: round2(it.pending_qty),
    pass_qty: round2(it.pass_qty),
    freeze_qty: round2(it.freeze_qty),
    reject_qty: round2(it.reject_qty),
    status_label: LINE_STATUS[it.status] || it.status,
    inspected: int0(it.pass_qty) + int0(it.freeze_qty) + int0(it.reject_qty) > EPS
  };
}

function full(id) {
  const g = db.prepare('SELECT * FROM goods_receipts WHERE id = ?').get(id);
  if (!g) return null;
  const items = db.prepare('SELECT * FROM goods_receipt_items WHERE grn_id = ? ORDER BY id').all(id).map(itemView);
  const actions = db.prepare('SELECT * FROM goods_receipt_actions WHERE grn_id = ? ORDER BY id DESC').all(id);
  const po = g.po_id ? db.prepare('SELECT id, po_no, supplier, status FROM purchase_orders WHERE id = ?').get(g.po_id) : null;
  return {
    ...g,
    status_label: STATUS[g.status] || g.status,
    items,
    actions,
    po,
    can_inspect: g.status !== 'cancelled' && g.status !== 'passed' && int0(g.pending_qty) > EPS,
    can_cancel: g.status !== 'cancelled' && items.every((r) => !r.inspected)
  };
}

/* ---------------- 接口 ---------------- */

/** 收料看板 */
router.get('/board', authRequired, wrap(async (req, res) => {
  const { q, status } = req.query;
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const where = [];
  const args = [];
  // 主体条件放最前，参数顺序跟着它走
  const poWh = poScope(cidOf(req));
  if (poWh) where.push(poWh.replace(/^ AND /, ''));
  if (status) { where.push('status = ?'); args.push(status); }
  if (q) { where.push('(grn_no LIKE ? OR po_no LIKE ? OR supplier LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT * FROM goods_receipts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`
  ).all(...args).map((g) => ({
    ...g,
    status_label: STATUS[g.status] || g.status,
    inspect_rate: int0(g.receive_qty) > 0 ? Math.round(((int0(g.pass_qty) + int0(g.freeze_qty) + int0(g.reject_qty)) / int0(g.receive_qty)) * 100) : 0
  }));

  // 统计也必须同口径：列表收窄了、卡片还是全集团，两个数字对不上比不显示更糟
  const m = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(receive_qty),0) recv, COALESCE(SUM(pass_qty),0) pass,
            COALESCE(SUM(freeze_qty),0) freeze, COALESCE(SUM(reject_qty),0) reject
     FROM goods_receipts WHERE substr(receive_date,1,7) = ? AND status != 'cancelled'${poWh}`
  ).get(month);
  const pendingRows = db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(pending_qty),0) q FROM goods_receipts WHERE status IN ('pending','inspecting','partial')" + poWh
  ).get();
  const diffRows = db.prepare(
    "SELECT COUNT(*) c FROM goods_receipts WHERE status != 'cancelled' AND (over_qty > 0 OR short_qty > 0)" + poWh
  ).get();

  const stat = {
    total: rows.length,
    pending_orders: int0(pendingRows.c),
    pending_qty: round2(pendingRows.q),
    month_recv: round2(m.recv),
    month_pass: round2(m.pass),
    pass_rate: int0(m.recv) > 0 ? round2((int0(m.pass) / int0(m.recv)) * 100) : null,
    freeze_qty: round2(m.freeze),
    reject_qty: round2(m.reject),
    diff_orders: int0(diffRows.c),
    waiting: rows.filter((r) => r.status === 'pending' || r.status === 'inspecting').length
  };
  return ok(res, { stat, month, rows });
}));

/** 待检汇总（按物料），供齐套页提示「有料在待检」 */
router.get('/pending', authRequired, wrap(async (req, res) => {
  const rows = db.prepare(
    `SELECT i.material_id, i.material_name, i.unit, COALESCE(SUM(i.pending_qty),0) AS pending_qty
     FROM goods_receipt_items i JOIN goods_receipts g ON g.id = i.grn_id
     WHERE g.status != 'cancelled' AND i.pending_qty > 0${poScope(cidOf(req), 'g.po_id')}
     GROUP BY i.material_id, i.material_name, i.unit
     ORDER BY pending_qty DESC`
  ).all().map((r) => ({ ...r, pending_qty: round2(r.pending_qty) }));
  return ok(res, rows);
}));

/** 采购单可收货行（开收料单时的默认值） */
router.get('/po/:poId', authRequired, wrap(async (req, res) => {
  const po = assertPo(req, req.params.poId);
  if (!po) return fail(res, 404, '采购单不存在');
  const items = db.prepare('SELECT * FROM purchase_items WHERE po_id = ? ORDER BY id').all(po.id).map((it) => ({
    po_item_id: it.id,
    material_id: it.material_id,
    material_name: it.name,
    spec: it.spec,
    unit: it.unit,
    qty: round2(it.qty),
    received_qty: round2(it.received_qty),
    expect_qty: remainOf(it)
  }));
  return ok(res, { po: { id: po.id, po_no: po.po_no, supplier: po.supplier, status: po.status }, items });
}));

router.get('/:id', authRequired, wrap(async (req, res) => {
  grnOr404(req, req.params.id);
  const d = full(req.params.id);
  if (!d) return fail(res, 404, '收料单不存在');
  return ok(res, d);
}));

/**
 * 点收：建收料单（全部进待检，不加可用库存）
 * body: { po_id, receive_date, warehouse, remark,
 *         items: [{ po_item_id, receive_qty, roll_no, dye_lot, location, expect_qty, diff_reason }] }
 */
router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const poId = Number(b.po_id);
  const po = assertPo(req, poId);   // 别家的采购单不能点收
  if (!po) return fail(res, 404, '采购单不存在');
  if (!['ordered', 'received'].includes(po.status)) {
    return fail(res, 400, `采购单是「${po.status === 'draft' ? '草稿' : po.status}」，只有已下单的采购单才能点收`);
  }
  const list = Array.isArray(b.items) ? b.items : [];
  const valid = list.filter((x) => int0(x.receive_qty) > 0);
  if (!valid.length) return fail(res, 400, '请填写实收数量（至少一行大于 0）');

  // 先校验，再落库
  const prepared = [];
  for (const it of valid) {
    const row = db.prepare('SELECT * FROM purchase_items WHERE id = ? AND po_id = ?').get(it.po_item_id, po.id);
    if (!row) return fail(res, 400, `采购明细 ${it.po_item_id} 不属于这张采购单`);
    const recv = round2(it.receive_qty);
    const expect = it.expect_qty !== undefined && it.expect_qty !== null && it.expect_qty !== ''
      ? round2(it.expect_qty) : remainOf(row);
    const diff = round2(recv - expect);
    const reason = String(it.diff_reason || '').trim();
    if (diff > EPS && !reason) {
      return fail(res, 400, `「${row.name}」实收 ${recv} 超过应收 ${expect}，超收必须写原因（多送 / 磅差 / 单位换算）后再点收`);
    }
    prepared.push({
      poItem: row, recv, expect, diff,
      diffType: diff > EPS ? 'over' : diff < -EPS ? 'short' : 'none',
      diffReason: reason || null,
      rollNo: String(it.roll_no || '').trim() || null,
      dyeLot: String(it.dye_lot || '').trim() || null,
      location: String(it.location || '').trim() || null
    });
  }

  const t = now();
  const receiveDate = b.receive_date || t.slice(0, 10);
  let grnId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO goods_receipts (grn_no, po_id, po_no, supplier, supplier_id, receive_date, warehouse, status,
        receive_by, receive_at, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'pending', ?,?,?,?,?,?)`
    ).run(
      nextGrnNo(), po.id, po.po_no, po.supplier || null, po.supplier_id || null, receiveDate,
      String(b.warehouse || '原料库').trim(), req.user.username, t,
      b.remark || null, req.user.username, t, t
    );
    grnId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO goods_receipt_items (grn_id, po_item_id, material_id, material_name, spec, unit,
        roll_no, dye_lot, location, expect_qty, receive_qty, diff_qty, diff_type, diff_reason,
        pending_qty, pass_qty, freeze_qty, reject_qty, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,'pending',?,?)`
    );
    for (const p of prepared) {
      ins.run(
        grnId, p.poItem.id, p.poItem.material_id || null, p.poItem.name, p.poItem.spec || null, p.poItem.unit || null,
        p.rollNo, p.dyeLot, p.location, p.expect, p.recv, p.diff, p.diffType, p.diffReason,
        p.recv, t, t
      );
      // 收货事实记账到采购行，但库存一分不加（待检）
      db.prepare('UPDATE purchase_items SET received_qty = ? WHERE id = ?')
        .run(round2(int0(p.poItem.received_qty) + p.recv), p.poItem.id);
    }
    summarize(grnId);
    refreshPoStatus(po.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `点收失败：${e.message}`);
  }

  const d = full(grnId);
  const warnings = [];
  if (!prepared.some((p) => p.dyeLot)) warnings.push('面料行建议填缸号，错缸是裁床最常见的事故来源');
  if (d.short_qty > 0) warnings.push(`本单短收 ${d.short_qty}，按原单等供应商补发`);
  return ok(res, { ...d, warnings });
}));

/** 补录卷号 / 缸号 / 库位（检验前可改） */
router.put('/:id/items/:itemId', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const g = grnOr404(req, req.params.id);
  if (g.status === 'cancelled') return fail(res, 400, '已作废的收料单不能改');
  const it = db.prepare('SELECT * FROM goods_receipt_items WHERE id = ? AND grn_id = ?').get(req.params.itemId, g.id);
  if (!it) return fail(res, 404, '收料明细不存在');
  const b = req.body || {};
  db.prepare('UPDATE goods_receipt_items SET roll_no = ?, dye_lot = ?, location = ?, updated_at = ? WHERE id = ?')
    .run(
      b.roll_no !== undefined ? (String(b.roll_no).trim() || null) : it.roll_no,
      b.dye_lot !== undefined ? (String(b.dye_lot).trim() || null) : it.dye_lot,
      b.location !== undefined ? (String(b.location).trim() || null) : it.location,
      now(), it.id
    );
  return ok(res, full(g.id));
}));

/**
 * 来料检查：逐行把待检量分流成 合格 / 冻结 / 退回
 * body: { items:[{ id, pass_qty, freeze_qty, reject_qty, note }] }
 * 允许部分检验（本次 < 待检，剩余继续待检）
 */
router.post('/:id/inspect', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const g = grnOr404(req, req.params.id);
  if (!g) return fail(res, 404, '收料单不存在');
  if (g.status === 'cancelled') return fail(res, 400, '已作废的收料单不能检验');
  const list = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  const valid = list.filter((x) => int0(x.pass_qty) + int0(x.freeze_qty) + int0(x.reject_qty) > EPS);
  if (!valid.length) return fail(res, 400, '至少填写一行的检验结果');

  const plan = [];
  for (const it of valid) {
    const row = db.prepare('SELECT * FROM goods_receipt_items WHERE id = ? AND grn_id = ?').get(it.id, g.id);
    if (!row) return fail(res, 400, `收料明细 ${it.id} 不属于这张收料单`);
    const pass = round2(it.pass_qty);
    const freeze = round2(it.freeze_qty);
    const reject = round2(it.reject_qty);
    if (pass < 0 || freeze < 0 || reject < 0) return fail(res, 400, '检验数量不能为负');
    const total = round2(pass + freeze + reject);
    if (total > round2(int0(row.pending_qty)) + EPS) {
      return fail(res, 400, `「${row.material_name}」本次检验 ${total} 超过待检 ${round2(row.pending_qty)}，不能凭空多检`);
    }
    const note = String(it.note || '').trim();
    if ((freeze > EPS || reject > EPS) && !note) {
      return fail(res, 400, `「${row.material_name}」有冻结 ${freeze} / 退回 ${reject}，必须写明原因（色差 / 克重不足 / 破损 / 规格不符）`);
    }
    plan.push({ row, pass, freeze, reject, note });
  }

  // 原料盘点进行中不许过账：中途入账会让账面数与实盘数错位，盘点差异全部作废
  try {
    require('../services/matflow').assertNotFrozen('material');
  } catch (e) {
    return fail(res, 400, e.message);
  }

  const t = now();
  db.exec('BEGIN');
  try {
    for (const p of plan) {
      const nextPass = round2(int0(p.row.pass_qty) + p.pass);
      const nextFreeze = round2(int0(p.row.freeze_qty) + p.freeze);
      const nextReject = round2(int0(p.row.reject_qty) + p.reject);
      const nextPending = round2(int0(p.row.pending_qty) - (p.pass + p.freeze + p.reject));
      const nextStatus = lineStatus({ pending_qty: nextPending, pass_qty: nextPass, freeze_qty: nextFreeze, reject_qty: nextReject });
      db.prepare(
        `UPDATE goods_receipt_items SET pass_qty = ?, freeze_qty = ?, reject_qty = ?, pending_qty = ?, status = ?,
          inspect_by = ?, inspect_at = ?, inspect_note = COALESCE(?, inspect_note), updated_at = ? WHERE id = ?`
      ).run(nextPass, nextFreeze, nextReject, nextPending, nextStatus, req.user.username, t, p.note || null, t, p.row.id);

      // 只有合格量进可用库存
      addMaterialStock(p.row.material_id, p.pass, {
        grnId: g.id, grnNo: g.grn_no, operator: req.user.username, remark: '来料检验合格入库'
      });
      // 退回 → 采购行已收数量回退，等供应商补发
      if (p.reject > EPS && p.row.po_item_id) rollbackReceived(p.row.po_item_id, p.reject);
      if (p.pass > EPS || p.freeze > EPS || p.reject > EPS) {
        db.prepare('INSERT INTO goods_receipt_actions (item_id, grn_id, action, qty, reason, operator, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(p.row.id, g.id, 'inspect', p.pass + p.freeze + p.reject, p.note || null, req.user.username, t);
      }
    }
    summarize(g.id);
    db.prepare('UPDATE goods_receipts SET inspect_by = ?, inspect_at = ? WHERE id = ?').run(req.user.username, t, g.id);
    refreshPoStatus(g.po_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `检验失败：${e.message}`);
  }
  return ok(res, full(g.id));
}));

/**
 * 冻结量处置：release 复核放行转合格 / reject 转退回
 * body: { action, qty, reason }
 */
router.post('/:id/items/:itemId/dispose', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const g = grnOr404(req, req.params.id);
  if (!g) return fail(res, 404, '收料单不存在');
  if (g.status === 'cancelled') return fail(res, 400, '已作废的收料单不能处置');
  const row = db.prepare('SELECT * FROM goods_receipt_items WHERE id = ? AND grn_id = ?').get(req.params.itemId, g.id);
  if (!row) return fail(res, 404, '收料明细不存在');
  if (int0(row.freeze_qty) <= EPS) return fail(res, 400, '这条明细没有冻结量，无需处置');

  const b = req.body || {};
  const action = b.action === 'reject' ? 'reject' : 'release';
  const qty = b.qty !== undefined ? round2(b.qty) : round2(row.freeze_qty);
  if (qty <= 0) return fail(res, 400, '处置数量必须大于 0');
  if (qty > round2(row.freeze_qty) + EPS) return fail(res, 400, `处置数量 ${qty} 超过冻结量 ${round2(row.freeze_qty)}`);
  const reason = String(b.reason || '').trim();
  if (!reason) return fail(res, 400, '处置必须写原因（让步接收 / 客户同意 / 退货）');
  if (action === 'release') {
    try {
      require('../services/matflow').assertNotFrozen('material');
    } catch (e) {
      return fail(res, 400, e.message);
    }
  }

  const t = now();
  db.exec('BEGIN');
  try {
    const nextPass = action === 'release' ? round2(int0(row.pass_qty) + qty) : round2(row.pass_qty);
    const nextReject = action === 'reject' ? round2(int0(row.reject_qty) + qty) : round2(row.reject_qty);
    const nextFreeze = round2(int0(row.freeze_qty) - qty);
    const nextStatus = lineStatus({ pending_qty: row.pending_qty, pass_qty: nextPass, freeze_qty: nextFreeze, reject_qty: nextReject });
    db.prepare('UPDATE goods_receipt_items SET pass_qty = ?, freeze_qty = ?, reject_qty = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(nextPass, nextFreeze, nextReject, nextStatus, t, row.id);

    if (action === 'release') {
      addMaterialStock(row.material_id, qty, {   // 放行才进可用库存
        grnId: g.id, grnNo: g.grn_no, operator: req.user.username, remark: `冻结量放行入库（${reason || '复核合格'}）`
      });
    } else if (row.po_item_id) {
      rollbackReceived(row.po_item_id, qty);    // 退货 → 采购行回退，等补发
    }
    db.prepare('INSERT INTO goods_receipt_actions (item_id, grn_id, action, qty, reason, operator, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(row.id, g.id, action, qty, reason, req.user.username, t);
    summarize(g.id);
    refreshPoStatus(g.po_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `处置失败：${e.message}`);
  }
  return ok(res, full(g.id));
}));

/** 作废（只有没检验过的单能作废，同时回退采购行已收数量） */
router.post('/:id/cancel', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const g = grnOr404(req, req.params.id);
  if (!g) return fail(res, 404, '收料单不存在');
  if (g.status === 'cancelled') return fail(res, 400, '已经作废过');
  const rows = db.prepare('SELECT * FROM goods_receipt_items WHERE grn_id = ?').all(g.id);
  const touched = rows.filter((r) => int0(r.pass_qty) + int0(r.freeze_qty) + int0(r.reject_qty) > EPS);
  if (touched.length) {
    return fail(res, 400, `已有 ${touched.length} 行做过检验（可能已进可用库存），不能作废；请走冻结/退回处置`);
  }
  const t = now();
  db.exec('BEGIN');
  try {
    rows.forEach((r) => { if (r.po_item_id) rollbackReceived(r.po_item_id, r.receive_qty); });
    db.prepare("UPDATE goods_receipts SET status = 'cancelled', remark = COALESCE(remark,'') || ?, updated_at = ? WHERE id = ?")
      .run(` [作废：${String((req.body || {}).reason || '未填原因')}]`, t, g.id);
    db.prepare('UPDATE goods_receipt_items SET pending_qty = 0, status = ?, updated_at = ? WHERE grn_id = ?').run('pending', t, g.id);
    refreshPoStatus(g.po_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `作废失败：${e.message}`);
  }
  return ok(res, full(g.id));
}));

module.exports = router;
