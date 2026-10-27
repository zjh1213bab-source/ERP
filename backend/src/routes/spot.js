/**
 * 退货入库与库龄 / 现货动销分析
 * 原型 M19「美仓退货库龄 + 现货经营分析」
 *
 * 库龄算法（FIFO 反算，不改库存写入）：
 *   按时间顺序遍历该仓该 SKU 的流水，正数入批次，负数按先进先出冲最早批次，
 *   剩余的批次 = 当前在库 + 各自入库日期 → 库龄。
 *   出库多于入库时记 overflow（说明账不平，提示去跑勾稽）。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { applyStock, addLedger, round2 } = require('../services/stockOps');
const { localNow, localDate } = require('../services/sla');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'warehouse', 'sales'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const RETURN_TYPE = { customer: '客户退货', retail: '零售退货', quality: '质量退回', transfer_back: '调回' };
const RETURN_STATUS = { draft: '待点收', received: '待判定', inspected: '已判定待关单', closed: '已关单', cancelled: '已取消' };

const daysBetween = (d1, d2) => {
  if (!d1 || !d2) return 0;
  const a = new Date(String(d1).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(d2).slice(0, 10) + 'T00:00:00');
  return Math.max(0, Math.round((b - a) / 86400000));
};

/** FIFO 反算每仓每 SKU 的在库批次 */
function agingMap(warehouse) {
  const rows = db.prepare(
    `SELECT style_no, product_name, color, size, type, qty, created_at
     FROM stock_ledger WHERE warehouse=? ORDER BY created_at, id`
  ).all(warehouse);

  const map = {};
  rows.forEach((r) => {
    const key = `${r.style_no || ''}|${r.color || ''}|${r.size || ''}`;
    if (!map[key]) {
      map[key] = {
        style_no: r.style_no || '', product_name: r.product_name || '',
        color: r.color || '', size: r.size || '', batches: [], overflow: 0
      };
    }
    const m = map[key];
    if (!m.product_name && r.product_name) m.product_name = r.product_name;
    const qty = num(r.qty);
    if (qty > 0) {
      m.batches.push({ date: String(r.created_at || '').slice(0, 10), qty, remain: qty });
    } else if (qty < 0) {
      let need = -qty;
      for (const b of m.batches) {
        if (need <= 0.001) break;
        if (b.remain <= 0.001) continue;
        const take = Math.min(b.remain, need);
        b.remain = round2(b.remain - take);
        need = round2(need - take);
      }
      if (need > 0.001) m.overflow = round2(m.overflow + need);
    }
  });
  return map;
}

/** 库龄分档 */
const BUCKETS = [
  { key: 'd0_30', label: '0-30 天', min: 0, max: 30 },
  { key: 'd31_60', label: '31-60 天', min: 31, max: 60 },
  { key: 'd61_90', label: '61-90 天', min: 61, max: 90 },
  { key: 'd90p', label: '90 天以上', min: 91, max: 99999 }
];

/** ==================== 库龄 ==================== */
router.get('/aging', authRequired, requireRole(...READ), (req, res) => {
  const warehouse = req.query.warehouse || 'us';
  const today = localDate();
  const map = agingMap(warehouse);

  const rows = Object.values(map).map((m) => {
    const b = {};
    BUCKETS.forEach((x) => { b[x.key] = 0; });
    let total = 0;
    let ageSum = 0;
    let oldest = null;
    const lots = [];
    m.batches.forEach((bt) => {
      if (bt.remain <= 0.001) return;
      const age = daysBetween(bt.date, today);
      const bucket = BUCKETS.find((x) => age >= x.min && age <= x.max) || BUCKETS[BUCKETS.length - 1];
      b[bucket.key] = round2(b[bucket.key] + bt.remain);
      total = round2(total + bt.remain);
      ageSum += age * bt.remain;
      if (oldest === null || age > oldest) oldest = age;
      lots.push({ in_date: bt.date, qty: bt.remain, age });
    });
    return {
      style_no: m.style_no, product_name: m.product_name, color: m.color, size: m.size,
      qty: total,
      ...b,
      avg_age: total > 0 ? Math.round(ageSum / total) : 0,
      oldest_age: oldest === null ? 0 : oldest,
      lot_count: lots.length,
      lots: lots.sort((x, y) => y.age - x.age),
      overflow: m.overflow
    };
  }).filter((r) => r.qty > 0 || r.overflow > 0);

  // 按款汇总
  const byStyle = {};
  rows.forEach((r) => {
    const k = r.style_no || '(无款号)';
    if (!byStyle[k]) {
      byStyle[k] = {
        style_no: k, product_name: r.product_name, sku_count: 0, qty: 0,
        d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0, ageSum: 0, max_age: 0
      };
    }
    const s = byStyle[k];
    s.sku_count += 1;
    s.qty = round2(s.qty + r.qty);
    BUCKETS.forEach((x) => { s[x.key] = round2(s[x.key] + r[x.key]); });
    s.ageSum += r.avg_age * r.qty;
    s.max_age = Math.max(s.max_age, r.oldest_age);
  });
  const styles = Object.values(byStyle).map((s) => ({
    ...s,
    avg_age: s.qty > 0 ? Math.round(s.ageSum / s.qty) : 0,
    d90p_pct: s.qty > 0 ? Math.round((s.d90p / s.qty) * 1000) / 10 : 0
  })).sort((a, b) => b.avg_age - a.avg_age);

  const totalQty = round2(rows.reduce((a, r) => a + r.qty, 0));
  const bucketSum = {};
  BUCKETS.forEach((x) => { bucketSum[x.key] = round2(rows.reduce((a, r) => a + r[x.key], 0)); });
  const avgAge = totalQty > 0
    ? Math.round(rows.reduce((a, r) => a + r.avg_age * r.qty, 0) / totalQty) : 0;

  ok(res, {
    warehouse, today,
    buckets: BUCKETS.map((x) => ({ key: x.key, label: x.label, qty: bucketSum[x.key], pct: totalQty ? Math.round((bucketSum[x.key] / totalQty) * 1000) / 10 : 0 })),
    total_qty: totalQty,
    avg_age: avgAge,
    d90p_qty: bucketSum.d90p,
    overflow: round2(rows.reduce((a, r) => a + (r.overflow || 0), 0)),
    styles,
    rows: rows.sort((a, b) => b.oldest_age - a.oldest_age)
  });
});

/** ==================== 动销与周转 ==================== */
router.get('/turnover', authRequired, requireRole(...READ), (req, res) => {
  const warehouse = req.query.warehouse || 'us';
  const days = Math.min(num(req.query.days) || 90, 365);
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const map = agingMap(warehouse);

  // 近 N 天出库
  const outRows = db.prepare(
    `SELECT style_no, color, size, COALESCE(SUM(-qty),0) q
     FROM stock_ledger WHERE warehouse=? AND qty<0 AND substr(created_at,1,10) >= ?
     GROUP BY style_no, color, size`
  ).all(warehouse, from);
  const outMap = {};
  outRows.forEach((r) => { outMap[`${r.style_no}|${r.color}|${r.size}`] = num(r.q); });

  // 累计入库（用于售罄率）
  const inRows = db.prepare(
    `SELECT style_no, color, size, COALESCE(SUM(qty),0) q
     FROM stock_ledger WHERE warehouse=? AND qty>0 GROUP BY style_no, color, size`
  ).all(warehouse);
  const inMap = {};
  inRows.forEach((r) => { inMap[`${r.style_no}|${r.color}|${r.size}`] = num(r.q); });

  const rows = Object.entries(map).map(([key, m]) => {
    const stock = round2(m.batches.reduce((a, b) => a + Math.max(b.remain, 0), 0));
    const out = outMap[key] || 0;
    const totalIn = inMap[key] || 0;
    const sold = round2(totalIn - stock);
    const dailyOut = days > 0 ? out / days : 0;
    const turnoverDays = dailyOut > 0.0001 ? Math.round(stock / dailyOut) : null;
    const sellThru = totalIn > 0 ? Math.round((sold / totalIn) * 1000) / 10 : 0;

    let level = 'good';
    let level_label = '动销正常';
    if (stock <= 0) { level = 'out'; level_label = '已售罄'; }
    else if (out <= 0) { level = 'dead'; level_label = '近 ' + days + ' 天零出库'; }
    else if (turnoverDays !== null && turnoverDays > 180) { level = 'slow'; level_label = '周转偏慢'; }
    else if (turnoverDays !== null && turnoverDays > 90) { level = 'watch'; level_label = '需关注'; }

    return {
      key, style_no: m.style_no, product_name: m.product_name, color: m.color, size: m.size,
      stock, out_qty: round2(out), total_in: round2(totalIn), sold,
      sell_through: sellThru, turnover_days: turnoverDays, level, level_label,
      avg_age: stock > 0
        ? Math.round(m.batches.filter((b) => b.remain > 0)
          .reduce((a, b) => a + daysBetween(b.date, localDate()) * b.remain, 0) / stock)
        : 0
    };
  }).filter((r) => r.stock > 0 || r.out_qty > 0);

  const totalStock = round2(rows.reduce((a, r) => a + r.stock, 0));
  const totalOut = round2(rows.reduce((a, r) => a + r.out_qty, 0));
  const avgTurnover = totalOut > 0 ? Math.round(totalStock / (totalOut / days)) : null;

  ok(res, {
    warehouse, days, from,
    stat: {
      sku_count: rows.length,
      stock_qty: totalStock,
      out_qty: totalOut,
      daily_out: round2(totalOut / days),
      avg_turnover_days: avgTurnover,
      dead_sku: rows.filter((r) => r.level === 'dead').length,
      slow_sku: rows.filter((r) => r.level === 'slow' || r.level === 'watch').length,
      sold_out_sku: rows.filter((r) => r.level === 'out').length
    },
    rows: rows.sort((a, b) => (b.turnover_days === null ? 99999 : b.turnover_days) - (a.turnover_days === null ? 99999 : a.turnover_days))
  });
});

/** ==================== 滞销清单 ==================== */
router.get('/slow-moving', authRequired, requireRole(...READ), (req, res) => {
  const warehouse = req.query.warehouse || 'us';
  const minAge = num(req.query.min_age) || 60;
  const map = agingMap(warehouse);
  const outRows = db.prepare(
    `SELECT style_no, color, size, COALESCE(SUM(-qty),0) q
     FROM stock_ledger WHERE warehouse=? AND qty<0 AND substr(created_at,1,10) >= ?
     GROUP BY style_no, color, size`
  ).all(warehouse, new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10));
  const outMap = {};
  outRows.forEach((r) => { outMap[`${r.style_no}|${r.color}|${r.size}`] = num(r.q); });

  const rows = [];
  Object.entries(map).forEach(([key, m]) => {
    const lots = m.batches.filter((b) => b.remain > 0);
    if (!lots.length) return;
    const stock = round2(lots.reduce((a, b) => a + b.remain, 0));
    const oldest = Math.max(...lots.map((b) => daysBetween(b.date, localDate())));
    if (oldest < minAge) return;
    const oldQty = round2(lots.filter((b) => daysBetween(b.date, localDate()) >= minAge)
      .reduce((a, b) => a + b.remain, 0));
    const out90 = outMap[key] || 0;
    rows.push({
      style_no: m.style_no, product_name: m.product_name, color: m.color, size: m.size,
      stock, oldest_age: oldest, old_qty: oldQty,
      out_90d: round2(out90),
      suggest: out90 <= 0 ? '近 90 天零出库：考虑打包/调拨/清货' : oldQty >= 20 ? '老货占比高：优先促销或调回' : '偶有动销：观察即可'
    });
  });
  ok(res, {
    warehouse, min_age: minAge,
    total_qty: round2(rows.reduce((a, r) => a + r.stock, 0)),
    rows: rows.sort((a, b) => b.oldest_age - a.oldest_age)
  });
});

/** ==================== 退货单 ==================== */
function returnDetail(id) {
  const r = db.prepare('SELECT * FROM stock_returns WHERE id=?').get(id);
  if (!r) return null;
  const items = db.prepare('SELECT * FROM stock_return_items WHERE return_id=? ORDER BY id').all(id);
  const locs = db.prepare("SELECT * FROM wh_locations WHERE warehouse=? AND status='active' ORDER BY zone, code").all(r.warehouse);
  return {
    ...r,
    type_label: RETURN_TYPE[r.type] || r.type,
    status_label: RETURN_STATUS[r.status] || r.status,
    items,
    locations: locs
  };
}

router.get('/returns', authRequired, requireRole(...READ), (req, res) => {
  const { status, warehouse = 'us', q } = req.query;
  const wh = ['warehouse=?'];
  const args = [warehouse];
  if (status && status !== 'all') { wh.push('status=?'); args.push(status); }
  if (q) { wh.push('(return_no LIKE ? OR order_no LIKE ? OR partner_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM stock_return_items i WHERE i.return_id=r.id) AS line_count
     FROM stock_returns r WHERE ${wh.join(' AND ')} ORDER BY r.id DESC LIMIT 200`
  ).all(...args);
  ok(res, rows.map((r) => ({
    ...r, type_label: RETURN_TYPE[r.type] || r.type, status_label: RETURN_STATUS[r.status] || r.status
  })));
});

router.get('/returns/:id', authRequired, requireRole(...READ), (req, res) => {
  const d = returnDetail(Number(req.params.id));
  if (!d) return fail(res, 404, '退货单不存在');
  ok(res, d);
});

router.post('/returns', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return fail(res, 400, '退货单至少要有明细');
  for (const it of items) {
    if (!it.style_no) return fail(res, 400, '每行明细必须有款号');
    if (num(it.qty_apply) <= 0) return fail(res, 400, `款 ${it.style_no} 的退货数量必须大于 0`);
  }
  const type = b.type || 'customer';
  if (!RETURN_TYPE[type]) return fail(res, 400, '退货类型不合法');
  const t = localNow();
  const seq = db.prepare('SELECT COUNT(*) c FROM stock_returns').get().c + 1;
  const no = genNo('RT', seq);
  const total = round2(items.reduce((a, i) => a + num(i.qty_apply), 0));

  db.exec('BEGIN');
  try {
    const r = db.prepare(
      `INSERT INTO stock_returns (return_no,type,warehouse,order_id,order_no,partner_name,source_no,reason,status,
         qty_apply,qty_received,qty_good,qty_defect,qty_scrap,return_date,remark,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(no, type, b.warehouse || 'us', b.order_id || null, b.order_no || null, b.partner_name || null,
      b.source_no || null, b.reason || null, 'draft', total, 0, 0, 0, 0,
      b.return_date || localDate(), b.remark || null, req.user?.username || null, t, t);
    const id = r.lastInsertRowid;
    const ins = db.prepare(
      `INSERT INTO stock_return_items (return_id,style_no,product_name,color,size,qty_apply,qty_received,qty_good,qty_defect,qty_scrap,note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    items.forEach((it) => {
      ins.run(id, it.style_no || '', it.product_name || '', it.color || '', it.size || '',
        num(it.qty_apply), 0, 0, 0, 0, it.note || null);
    });
    db.exec('COMMIT');
    ok(res, { id, return_no: no, qty_apply: total });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

/** 点收：实收 ≤ 申请，且必须有实收 */
router.post('/returns/:id/receive', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM stock_returns WHERE id=?').get(Number(req.params.id));
  if (!r) return fail(res, 404, '退货单不存在');
  if (r.status !== 'draft') return fail(res, 400, `当前状态「${RETURN_STATUS[r.status]}」不能点收`);
  const lines = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!lines.length) return fail(res, 400, '请逐行填写实收数量');

  const items = db.prepare('SELECT * FROM stock_return_items WHERE return_id=?').all(r.id);
  const byId = {};
  items.forEach((x) => { byId[x.id] = x; });

  // 先校验再开事务
  const prepared = [];
  for (const ln of lines) {
    const src = byId[ln.item_id];
    if (!src) return fail(res, 400, `明细 #${ln.item_id} 不属于这张退货单`);
    const recv = num(ln.qty_received);
    if (recv < 0) return fail(res, 400, '实收数量不能为负');
    if (recv > num(src.qty_apply) + 0.001) {
      return fail(res, 400, `款 ${src.style_no} 申请退 ${num(src.qty_apply)} 件，实收不能超过这个数`);
    }
    prepared.push({ src, recv });
  }
  const sumR = round2(prepared.reduce((a, p) => a + p.recv, 0));
  if (sumR <= 0) return fail(res, 400, '实收合计必须大于 0，否则请取消这张退货单');

  const t = localNow();
  db.exec('BEGIN');
  try {
    prepared.forEach((p) => {
      db.prepare('UPDATE stock_return_items SET qty_received=? WHERE id=?').run(p.recv, p.src.id);
    });
    db.prepare("UPDATE stock_returns SET status='received', qty_received=?, updated_at=? WHERE id=?").run(sumR, t, r.id);
    db.exec('COMMIT');
    ok(res, { id: r.id, status: 'received', qty_received: sumR });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

/**
 * 判定：良品 + 次品 + 报废 = 实收（必须逐件判完）
 * 良品回可售库存并写流水；次品记破损区；报废不入库
 */
router.post('/returns/:id/inspect', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM stock_returns WHERE id=?').get(Number(req.params.id));
  if (!r) return fail(res, 404, '退货单不存在');
  if (!['received', 'inspected'].includes(r.status)) {
    return fail(res, 400, `当前状态「${RETURN_STATUS[r.status]}」不能判定${r.status === 'draft' ? '（还没点收）' : ''}`);
  }
  const lines = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!lines.length) return fail(res, 400, '请逐行填写判定结果');

  const items = db.prepare('SELECT * FROM stock_return_items WHERE return_id=?').all(r.id);
  const byId = {};
  items.forEach((x) => { byId[x.id] = x; });

  const prepared = [];
  for (const ln of lines) {
    const src = byId[ln.item_id];
    if (!src) return fail(res, 400, `明细 #${ln.item_id} 不属于这张退货单`);
    const good = num(ln.qty_good);
    const defect = num(ln.qty_defect);
    const scrap = num(ln.qty_scrap);
    if (good < 0 || defect < 0 || scrap < 0) return fail(res, 400, '判定数量不能为负');
    const sum = round2(good + defect + scrap);
    if (Math.abs(sum - num(src.qty_received)) > 0.001) {
      return fail(res, 400, `款 ${src.style_no} 实收 ${num(src.qty_received)} 件，良品+次品+报废 = ${sum}，必须相等（要逐件判完）`);
    }
    let loc = null;
    if (good > 0 && ln.good_location) {
      loc = db.prepare("SELECT * FROM wh_locations WHERE warehouse=? AND code=? AND status='active'")
        .get(r.warehouse, ln.good_location);
      if (!loc) return fail(res, 400, `良品库位 ${ln.good_location} 不存在或已锁定`);
      if (loc.zone !== 'sellable') return fail(res, 400, `良品必须回「可售区」库位，${loc.code} 是 ${loc.zone}`);
    } else if (good > 0 && !ln.good_location) {
      return fail(res, 400, `款 ${src.style_no} 有 ${good} 件良品，必须指定可售库位`);
    }
    prepared.push({ src, good, defect, scrap, loc });
  }

  const t = localNow();
  let addedGood = 0;
  db.exec('BEGIN');
  try {
    prepared.forEach((p) => {
      db.prepare(
        `UPDATE stock_return_items SET qty_good=?, qty_defect=?, qty_scrap=?, location_code=? WHERE id=?`
      ).run(p.good, p.defect, p.scrap, p.loc ? p.loc.code : null, p.src.id);

      if (p.good > 0) {
        applyStock({
          warehouse: r.warehouse, style_no: p.src.style_no, product_name: p.src.product_name,
          color: p.src.color, size: p.src.size, delta: p.good
        });
        addLedger({
          warehouse: r.warehouse, style_no: p.src.style_no, product_name: p.src.product_name,
          color: p.src.color, size: p.src.size, type: 'in', qty: p.good,
          ref_type: 'stock_return', ref_id: r.id,
          remark: `退货良品入库 ${r.return_no} · ${p.loc.code}`, operator: req.user?.username
        });
        addedGood += p.good;
      }
      // 次品与报废都不进库存、不写流水（库存只管可售量），只在退货明细里留数量与说明
      if (p.defect > 0 || p.scrap > 0) {
        const tag = [p.defect > 0 ? `次品 ${p.defect}` : '', p.scrap > 0 ? `报废 ${p.scrap}` : '']
          .filter(Boolean).join(' / ');
        db.prepare("UPDATE stock_return_items SET note=COALESCE(note||' · ','')||? WHERE id=?")
          .run(`判定：${tag}（不进可售）`, p.src.id);
      }
    });

    const agg = db.prepare(
      `SELECT COALESCE(SUM(qty_good),0) g, COALESCE(SUM(qty_defect),0) d, COALESCE(SUM(qty_scrap),0) s
       FROM stock_return_items WHERE return_id=?`
    ).get(r.id);
    db.prepare(
      "UPDATE stock_returns SET status='inspected', qty_good=?, qty_defect=?, qty_scrap=?, updated_at=? WHERE id=?"
    ).run(round2(agg.g), round2(agg.d), round2(agg.s), t, r.id);
    db.exec('COMMIT');
    ok(res, {
      id: r.id, status: 'inspected',
      qty_good: round2(agg.g), qty_defect: round2(agg.d), qty_scrap: round2(agg.s),
      added_to_sellable: round2(addedGood)
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

router.post('/returns/:id/close', authRequired, requireRole(...WRITE), (req, res) => {
  const r = db.prepare('SELECT * FROM stock_returns WHERE id=?').get(Number(req.params.id));
  if (!r) return fail(res, 404, '退货单不存在');
  if (r.status === 'closed') return fail(res, 400, '这单已经关过了');
  if (r.status !== 'inspected') return fail(res, 400, '还没判定完，不能关单（良品+次品+报废要等于实收）');
  db.prepare("UPDATE stock_returns SET status='closed', updated_at=? WHERE id=?").run(localNow(), r.id);
  ok(res, { id: r.id, status: 'closed' });
});

router.post('/returns/:id/cancel', authRequired, requireRole(...WRITE), (req, res) => {
  const r = db.prepare('SELECT * FROM stock_returns WHERE id=?').get(Number(req.params.id));
  if (!r) return fail(res, 404, '退货单不存在');
  if (['closed', 'cancelled'].includes(r.status)) return fail(res, 400, `当前状态「${RETURN_STATUS[r.status]}」不能取消`);
  if (r.status === 'inspected') return fail(res, 400, '已判定入库，不能取消（请走调拨或报废）');
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 4) return fail(res, 400, '取消必须写原因（至少 4 个字）');
  db.prepare("UPDATE stock_returns SET status='cancelled', remark=COALESCE(remark,'')||?, updated_at=? WHERE id=?")
    .run(`\n[取消] ${reason}`, localNow(), r.id);
  ok(res, { id: r.id, status: 'cancelled' });
});

/** ==================== 总览 ==================== */
router.get('/overview', authRequired, requireRole(...READ), (req, res) => {
  const warehouse = req.query.warehouse || 'us';
  const today = localDate();
  const map = agingMap(warehouse);
  let total = 0; let ageSum = 0; let old90 = 0;
  Object.values(map).forEach((m) => {
    m.batches.forEach((b) => {
      if (b.remain <= 0.001) return;
      const age = daysBetween(b.date, today);
      total = round2(total + b.remain);
      ageSum += age * b.remain;
      if (age >= 91) old90 = round2(old90 + b.remain);
    });
  });

  const out90 = num(db.prepare(
    `SELECT COALESCE(SUM(-qty),0) q FROM stock_ledger
     WHERE warehouse=? AND qty<0 AND substr(created_at,1,10) >= ?`
  ).get(warehouse, new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)).q);

  const rt = db.prepare(
    `SELECT status, COUNT(*) c, COALESCE(SUM(qty_apply),0) q FROM stock_returns WHERE warehouse=? GROUP BY status`
  ).all(warehouse);
  const rtMap = {};
  rt.forEach((x) => { rtMap[x.status] = x; });

  ok(res, {
    warehouse, today,
    stock_qty: total,
    avg_age: total > 0 ? Math.round(ageSum / total) : 0,
    d90p_qty: old90,
    d90p_pct: total > 0 ? Math.round((old90 / total) * 1000) / 10 : 0,
    out_90d: round2(out90),
    turnover_days: out90 > 0 ? Math.round(total / (out90 / 90)) : null,
    returns: {
      pending: (rtMap.draft?.c || 0) + (rtMap.received?.c || 0) + (rtMap.inspected?.c || 0),
      draft: rtMap.draft?.c || 0,
      received: rtMap.received?.c || 0,
      inspected: rtMap.inspected?.c || 0,
      closed: rtMap.closed?.c || 0,
      qty_pending: round2((rtMap.draft?.q || 0) + (rtMap.received?.q || 0))
    }
  });
});

router.get('/dict', authRequired, requireRole(...READ), (req, res) => {
  ok(res, {
    return_types: Object.entries(RETURN_TYPE).map(([value, label]) => ({ value, label })),
    return_status: Object.entries(RETURN_STATUS).map(([value, label]) => ({ value, label })),
    buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label }))
  });
});

module.exports = router;
