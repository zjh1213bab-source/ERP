/**
 * 海外仓（美仓）作业：到仓上架 / 套装拆组 / 运费核对
 * 原型 TS-M19 美仓
 *
 * 硬规则（写在代码里，不靠人记）：
 * 1. **有预告才收货**：ASN 未发运/未到仓不能点收；点收必须逐行对照 ASN 明细
 * 2. **数量守恒**：预收 = 实收 + 破损 + 短少（超收单独记），出现差额必须写原因（≥4 字）
 * 3. **上架才可售**：只有上架到 `sellable` 库位的量才进美仓可售库存；破损区/待检区不进
 * 4. **库位只记找货位置**：不做逐单扣减（小仓没有 WMS 拣货路径，做假精确更误导）
 * 5. **套装库存与单品库存分开**：套装存 `wh_bundle_stock`，不混进 `stock_items`；
 *    组装/拆分都要扣/加组件库存并写 `stock_ledger`
 * 6. **套装不能自引用**：bundle_sku 不得出现在自己的组件里
 * 7. **运费核对要有基准**：系统金额按费率表算；没有费率的标 `no_rate`，不拿 0 元当基准
 * 8. **对不上账不能结算**：存在未处理差异（amount / weight / missing）时禁止结算
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { applyStock, addLedger, getStock, round2 } = require('../services/stockOps');
const { localNow, localDate } = require('../services/sla');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'warehouse', 'sales'];
const ADMIN = ['admin'];

const ZONE_LABEL = { sellable: '可售区', inspect: '待检区', damaged: '破损区', return: '退货区', staging: '暂存区' };
const ASN_STATUS = {
  draft: '草稿', in_transit: '在途', arrived: '已到仓',
  receiving: '点收中', done: '已完成', cancelled: '已取消'
};

const seqOf = (table, prefix) => {
  const c = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c + 1;
  return genNo(prefix, c);
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** ==================== 库位 ==================== */
router.get('/locations', authRequired, requireRole(...READ), (req, res) => {
  const { warehouse = 'us', zone } = req.query;
  const args = [warehouse];
  let sql = 'SELECT * FROM wh_locations WHERE warehouse=?';
  if (zone) { sql += ' AND zone=?'; args.push(zone); }
  sql += ' ORDER BY zone, code';
  const rows = db.prepare(sql).all(...args);
  // 每个库位累计上架量（找货参考，不是实时库存）
  const put = db.prepare(
    `SELECT p.location_id, COALESCE(SUM(p.qty),0) q, COUNT(DISTINCT p.rcv_item_id) sku
     FROM wh_putaways p GROUP BY p.location_id`
  ).all();
  const map = {};
  put.forEach((x) => { map[x.location_id] = x; });
  ok(res, rows.map((r) => ({
    ...r, zone_label: ZONE_LABEL[r.zone] || r.zone,
    put_qty: round2(map[r.id]?.q || 0), sku_count: map[r.id]?.sku || 0
  })));
});

router.post('/locations', authRequired, requireRole(...WRITE), (req, res) => {
  const { warehouse = 'us', code, zone = 'sellable', aisle, capacity = 0, remark } = req.body || {};
  if (!code) return fail(res, 400, '库位编码必填');
  if (!ZONE_LABEL[zone]) return fail(res, 400, '库区类型不合法');
  const dup = db.prepare('SELECT id FROM wh_locations WHERE warehouse=? AND code=?').get(warehouse, code);
  if (dup) return fail(res, 400, `库位 ${code} 已存在`);
  const t = localNow();
  const r = db.prepare(
    'INSERT INTO wh_locations (warehouse,code,zone,aisle,capacity,status,remark,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(warehouse, code, zone, aisle || null, num(capacity), 'active', remark || null, t);
  ok(res, { id: r.lastInsertRowid, code, zone });
});

router.put('/locations/:id', authRequired, requireRole(...WRITE), (req, res) => {
  const loc = db.prepare('SELECT * FROM wh_locations WHERE id=?').get(Number(req.params.id));
  if (!loc) return fail(res, 404, '库位不存在');
  const { status, capacity, zone, remark } = req.body || {};
  if (status && !['active', 'locked'].includes(status)) return fail(res, 400, '状态只能是 active / locked');
  if (zone && !ZONE_LABEL[zone]) return fail(res, 400, '库区类型不合法');
  db.prepare('UPDATE wh_locations SET status=?, capacity=?, zone=?, remark=? WHERE id=?').run(
    status || loc.status,
    capacity === undefined ? loc.capacity : num(capacity),
    zone || loc.zone,
    remark === undefined ? loc.remark : remark,
    loc.id
  );
  ok(res, { id: loc.id, status: status || loc.status });
});

/** ==================== 到仓预告 ASN ==================== */
router.get('/asns', authRequired, requireRole(...READ), (req, res) => {
  const { status, q, warehouse = 'us' } = req.query;
  const args = [warehouse];
  let where = 'WHERE a.warehouse=?';
  if (status && status !== 'all') { where += ' AND a.status=?'; args.push(status); }
  if (q) { where += ' AND (a.asn_no LIKE ? OR a.container_no LIKE ? OR a.carrier LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT a.*, (SELECT COUNT(*) FROM wh_asn_items i WHERE i.asn_id=a.id) AS line_count,
       (SELECT COUNT(*) FROM wh_receipts r WHERE r.asn_id=a.id) AS rcv_count
     FROM wh_asns a ${where} ORDER BY a.id DESC`
  ).all(...args);
  ok(res, rows.map((r) => ({ ...r, status_label: ASN_STATUS[r.status] || r.status })));
});

router.get('/asns/:id', authRequired, requireRole(...READ), (req, res) => {
  const asn = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(Number(req.params.id));
  if (!asn) return fail(res, 404, '发运单不存在');
  const items = db.prepare('SELECT * FROM wh_asn_items WHERE asn_id=? ORDER BY id').all(asn.id);
  const receipts = db.prepare('SELECT * FROM wh_receipts WHERE asn_id=? ORDER BY id').all(asn.id);
  const rcvItems = receipts.length
    ? db.prepare(
        `SELECT i.*, r.rcv_no FROM wh_receipt_items i JOIN wh_receipts r ON r.id=i.rcv_id
         WHERE r.asn_id=? ORDER BY i.id`
      ).all(asn.id)
    : [];
  const puts = rcvItems.length
    ? db.prepare(
        `SELECT p.*, l.code AS location_code, l.zone FROM wh_putaways p
         JOIN wh_locations l ON l.id=p.location_id
         WHERE p.rcv_item_id IN (${rcvItems.map(() => '?').join(',')}) ORDER BY p.id`
      ).all(...rcvItems.map((x) => x.id))
    : [];
  ok(res, {
    asn: { ...asn, status_label: ASN_STATUS[asn.status] || asn.status },
    items, receipts,
    rcv_items: rcvItems,
    putaways: puts.map((p) => ({ ...p, zone_label: ZONE_LABEL[p.zone] || p.zone }))
  });
});

router.post('/asns', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return fail(res, 400, '发运单必须至少有一行明细');
  const warehouse = b.warehouse || 'us';
  const from = b.from_warehouse || 'cn';
  if (warehouse === from) return fail(res, 400, '发出仓与目的仓不能相同');
  for (const it of items) {
    if (!it.style_no) return fail(res, 400, '每行明细必须有款号');
    if (num(it.expect_qty) <= 0) return fail(res, 400, `款 ${it.style_no} 的预报数量必须大于 0`);
  }
  const t = localNow();
  const asnNo = seqOf('wh_asns', 'ASN');
  const total = round2(items.reduce((a, i) => a + num(i.expect_qty), 0));

  db.exec('BEGIN');
  try {
    const r = db.prepare(
      `INSERT INTO wh_asns (asn_no,warehouse,from_warehouse,carrier,container_no,ship_date,eta_date,carton_plan,
         carton_actual,expect_qty,received_qty,damaged_qty,short_qty,over_qty,status,remark,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(asnNo, warehouse, from, b.carrier || null, b.container_no || null, b.ship_date || null,
      b.eta_date || null, num(b.carton_plan), 0, total, 0, 0, 0, 0, 'draft', b.remark || null,
      req.user?.username || null, t, t);
    const asnId = r.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO wh_asn_items (asn_id,style_no,product_name,color,size,expect_qty,carton_no,remark) VALUES (?,?,?,?,?,?,?,?)'
    );
    items.forEach((it) => {
      ins.run(asnId, it.style_no || '', it.product_name || '', it.color || '', it.size || '',
        num(it.expect_qty), it.carton_no || null, it.remark || null);
    });
    db.exec('COMMIT');
    ok(res, { id: asnId, asn_no: asnNo, expect_qty: total, line_count: items.length });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

/** 发运：draft → in_transit（必须有发运日期） */
router.post('/asns/:id/ship', authRequired, requireRole(...WRITE), (req, res) => {
  const asn = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(Number(req.params.id));
  if (!asn) return fail(res, 404, '发运单不存在');
  if (asn.status !== 'draft') return fail(res, 400, `当前状态「${ASN_STATUS[asn.status]}」不能发运`);
  const shipDate = req.body?.ship_date || localDate();
  const t = localNow();
  db.prepare('UPDATE wh_asns SET status=?, ship_date=?, carrier=COALESCE(?,carrier), updated_at=? WHERE id=?').run(
    'in_transit', shipDate, req.body?.carrier || null, t, asn.id
  );
  ok(res, { id: asn.id, status: 'in_transit', ship_date: shipDate });
});

/** 到仓：in_transit → arrived（只有到仓才能点收） */
router.post('/asns/:id/arrive', authRequired, requireRole(...WRITE), (req, res) => {
  const asn = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(Number(req.params.id));
  if (!asn) return fail(res, 404, '发运单不存在');
  if (asn.status !== 'in_transit') return fail(res, 400, `当前状态「${ASN_STATUS[asn.status]}」不能标记到仓`);
  const d = req.body?.arrive_date || localDate();
  db.prepare('UPDATE wh_asns SET status=?, arrive_date=?, updated_at=? WHERE id=?').run('arrived', d, localNow(), asn.id);
  ok(res, { id: asn.id, status: 'arrived', arrive_date: d });
});

router.post('/asns/:id/cancel', authRequired, requireRole(...WRITE), (req, res) => {
  const asn = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(Number(req.params.id));
  if (!asn) return fail(res, 404, '发运单不存在');
  if (asn.status === 'done') return fail(res, 400, '已完成的上架单不能取消');
  if (asn.status === 'receiving') return fail(res, 400, '已开始点收，不能取消（请走差异处理）');
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 4) return fail(res, 400, '取消必须写原因（至少 4 个字）');
  db.prepare('UPDATE wh_asns SET status=?, remark=COALESCE(remark,\'\')||? , updated_at=? WHERE id=?')
    .run('cancelled', `\n[取消] ${reason}`, localNow(), asn.id);
  ok(res, { id: asn.id, status: 'cancelled' });
});

/** ==================== 到仓点收 ==================== */
/**
 * POST /asns/:id/receive
 * { arrive_date, carton_actual, items:[{asn_item_id, received_qty, damaged_qty, diff_reason}] }
 * 数量守恒：short = max(0, expect - received - damaged)；over = max(0, received + damaged - expect)
 * 有短少或超收必须写原因。
 */
router.post('/asns/:id/receive', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const asn = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(Number(req.params.id));
  if (!asn) return fail(res, 404, '发运单不存在');
  if (!['in_transit', 'arrived'].includes(asn.status)) {
    return fail(res, 400, `当前状态「${ASN_STATUS[asn.status]}」不能点收${asn.status === 'draft' ? '（还没发运）' : ''}`);
  }
  const exist = db.prepare('SELECT id FROM wh_receipts WHERE asn_id=?').get(asn.id);
  if (exist) return fail(res, 400, '这单已经点收过了，请在点收单里上架或处理差异');

  const lines = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!lines.length) return fail(res, 400, '点收必须逐行填写实收数量');
  const asnItems = db.prepare('SELECT * FROM wh_asn_items WHERE asn_id=?').all(asn.id);
  const byId = {};
  asnItems.forEach((x) => { byId[x.id] = x; });

  // 先把所有行校验完，再开事务 —— 事务内 return 不会回滚，会留下“半张单”
  const prepared = [];
  for (const ln of lines) {
    const src = byId[ln.asn_item_id];
    if (!src) return fail(res, 400, `明细 #${ln.asn_item_id} 不属于这张发运单`);
    const expect = num(src.expect_qty);
    const recv = num(ln.received_qty);
    const dmg = num(ln.damaged_qty);
    if (recv < 0 || dmg < 0) return fail(res, 400, '实收与破损不能为负数');
    const short = Math.max(0, round2(expect - recv - dmg));
    const over = Math.max(0, round2(recv + dmg - expect));
    const reason = String(ln.diff_reason || '').trim();
    if ((short > 0 || over > 0) && reason.length < 4) {
      return fail(res, 400, `款 ${src.style_no} 差 ${short || over} 件，必须写差异原因（至少 4 个字）`);
    }
    prepared.push({ src, expect, recv, dmg, short, over, reason, remark: ln.remark || null });
  }

  const t = localNow();
  const rcvNo = seqOf('wh_receipts', 'RCV');
  let sumR = 0; let sumD = 0; let sumS = 0; let sumO = 0;

  db.exec('BEGIN');
  try {
    const rc = db.prepare(
      `INSERT INTO wh_receipts (rcv_no,asn_id,arrive_date,carton_actual,expect_qty,received_qty,damaged_qty,
         short_qty,over_qty,status,note,receive_by,received_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(rcvNo, asn.id, req.body?.arrive_date || asn.arrive_date || localDate(), num(req.body?.carton_actual),
      asn.expect_qty, 0, 0, 0, 0, 'done', req.body?.note || null, req.user?.username || null, t, t, t);
    const rcvId = rc.lastInsertRowid;
    const ins = db.prepare(
      `INSERT INTO wh_receipt_items (rcv_id,asn_item_id,style_no,product_name,color,size,expect_qty,
         received_qty,damaged_qty,short_qty,over_qty,put_qty,diff_reason,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    for (const p of prepared) {
      ins.run(rcvId, p.src.id, p.src.style_no, p.src.product_name, p.src.color, p.src.size, p.expect,
        p.recv, p.dmg, p.short, p.over, 0, p.reason || null, p.remark);
      sumR += p.recv; sumD += p.dmg; sumS += p.short; sumO += p.over;
    }

    db.prepare(
      `UPDATE wh_receipts SET received_qty=?, damaged_qty=?, short_qty=?, over_qty=?, updated_at=? WHERE id=?`
    ).run(round2(sumR), round2(sumD), round2(sumS), round2(sumO), t, rcvId);
    db.prepare(
      `UPDATE wh_asns SET status='receiving', arrive_date=COALESCE(arrive_date,?), carton_actual=?,
         received_qty=?, damaged_qty=?, short_qty=?, over_qty=?, updated_at=? WHERE id=?`
    ).run(req.body?.arrive_date || asn.arrive_date || localDate(), num(req.body?.carton_actual),
      round2(sumR), round2(sumD), round2(sumS), round2(sumO), t, asn.id);
    db.exec('COMMIT');

    ok(res, {
      rcv_id: rcvId, rcv_no: rcvNo,
      received_qty: round2(sumR), damaged_qty: round2(sumD),
      short_qty: round2(sumS), over_qty: round2(sumO),
      putaway_pending: round2(sumR - sumD)
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

router.get('/receipts', authRequired, requireRole(...READ), (req, res) => {
  const { status } = req.query;
  const args = [];
  let where = '';
  if (status && status !== 'all') { where = 'WHERE r.status=?'; args.push(status); }
  const rows = db.prepare(
    `SELECT r.*, a.asn_no, a.warehouse, a.carrier,
       (SELECT COUNT(*) FROM wh_receipt_items i WHERE i.rcv_id=r.id) AS line_count,
       COALESCE((SELECT SUM(i.put_qty) FROM wh_receipt_items i WHERE i.rcv_id=r.id),0) AS put_qty
     FROM wh_receipts r JOIN wh_asns a ON a.id=r.asn_id ${where} ORDER BY r.id DESC`
  ).all(...args);
  ok(res, rows.map((r) => ({
    ...r,
    to_put: round2(num(r.received_qty) - num(r.damaged_qty) - num(r.put_qty)),
    put_done: num(r.put_qty) > 0 && round2(num(r.received_qty) - num(r.damaged_qty) - num(r.put_qty)) <= 0
  })));
});

router.get('/receipts/:id', authRequired, requireRole(...READ), (req, res) => {
  const rcv = db.prepare('SELECT * FROM wh_receipts WHERE id=?').get(Number(req.params.id));
  if (!rcv) return fail(res, 404, '点收单不存在');
  const asn = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(rcv.asn_id);
  const items = db.prepare('SELECT * FROM wh_receipt_items WHERE rcv_id=? ORDER BY id').all(rcv.id);
  const puts = items.length
    ? db.prepare(
        `SELECT p.*, l.code AS location_code, l.zone FROM wh_putaways p
         JOIN wh_locations l ON l.id=p.location_id
         WHERE p.rcv_item_id IN (${items.map(() => '?').join(',')}) ORDER BY p.id`
      ).all(...items.map((x) => x.id))
    : [];
  const locs = db.prepare("SELECT * FROM wh_locations WHERE warehouse=? AND status='active' ORDER BY zone, code")
    .all(asn?.warehouse || 'us');
  ok(res, {
    receipt: rcv, asn,
    items: items.map((i) => ({
      ...i,
      to_put: round2(num(i.received_qty) - num(i.damaged_qty) - num(i.put_qty))
    })),
    putaways: puts.map((p) => ({ ...p, zone_label: ZONE_LABEL[p.zone] || p.zone })),
    locations: locs.map((l) => ({ ...l, zone_label: ZONE_LABEL[l.zone] || l.zone }))
  });
});

/**
 * POST /receipts/:id/putaway
 * { items:[{rcv_item_id, location_code, qty}] }
 * 只有 sellable 区才加可售库存；破损区/待检区只记位置。
 */
router.post('/receipts/:id/putaway', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const rcv = db.prepare('SELECT * FROM wh_receipts WHERE id=?').get(Number(req.params.id));
  if (!rcv) return fail(res, 404, '点收单不存在');
  if (rcv.status !== 'done') return fail(res, 400, '点收还没完成，不能上架');
  const asn = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(rcv.asn_id);
  const lines = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!lines.length) return fail(res, 400, '请至少填写一行上架');

  // 同样先校验再开事务；另外同一行在同一次请求里可以分多笔，需要按行累计占用
  const planned = {};
  const prepared = [];
  for (const ln of lines) {
    const it = db.prepare('SELECT * FROM wh_receipt_items WHERE id=? AND rcv_id=?').get(num(ln.rcv_item_id), rcv.id);
    if (!it) return fail(res, 400, `点收明细 #${ln.rcv_item_id} 不属于这张单`);
    const qty = num(ln.qty);
    if (qty <= 0) return fail(res, 400, '上架数量必须大于 0');
    const used = planned[it.id] || 0;
    const left = round2(num(it.received_qty) - num(it.damaged_qty) - num(it.put_qty) - used);
    if (qty > left + 0.001) {
      return fail(res, 400, `款 ${it.style_no} 可上架只剩 ${left} 件，不能上架 ${qty}`);
    }
    const loc = db.prepare('SELECT * FROM wh_locations WHERE warehouse=? AND code=?').get(asn.warehouse, String(ln.location_code || ''));
    if (!loc) return fail(res, 400, `库位 ${ln.location_code || '(空)'} 不存在`);
    if (loc.status !== 'active') return fail(res, 400, `库位 ${loc.code} 已锁定，不能上架`);
    planned[it.id] = used + qty;
    prepared.push({ it, loc, qty, remark: ln.remark || null });
  }

  const t = localNow();
  const putNo = seqOf('wh_putaways', 'PUT');
  let addedSellable = 0;

  db.exec('BEGIN');
  try {
    for (const p of prepared) {
      const { it, loc, qty } = p;
      // 上架记录要带 SKU：拣货按「该 SKU 在哪个库位」分配，只记数量分不出来
      db.prepare('INSERT INTO wh_putaways (put_no,rcv_item_id,location_id,qty,operator,put_at,remark,style_no,color,size) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(putNo, it.id, loc.id, qty, req.user?.username || null, t, p.remark,
          it.style_no || null, it.color || null, it.size || null);
      db.prepare('UPDATE wh_receipt_items SET put_qty=put_qty+? WHERE id=?').run(qty, it.id);

      if (loc.zone === 'sellable') {
        applyStock({
          warehouse: asn.warehouse, style_no: it.style_no, product_name: it.product_name,
          color: it.color, size: it.size, delta: qty
        });
        addLedger({
          warehouse: asn.warehouse, style_no: it.style_no, product_name: it.product_name,
          color: it.color, size: it.size, type: 'in', qty,
          ref_type: 'wh_receipt', ref_id: rcv.id,
          remark: `海外仓上架 ${putNo} · ${loc.code}`, operator: req.user?.username
        });
        addedSellable += qty;
      }
    }

    // 整单上架完成 → ASN 置 done
    const leftAll = db.prepare(
      'SELECT COALESCE(SUM(received_qty - damaged_qty - put_qty),0) AS l FROM wh_receipt_items WHERE rcv_id=?'
    ).get(rcv.id).l;
    if (round2(leftAll) <= 0) {
      db.prepare("UPDATE wh_asns SET status='done', updated_at=? WHERE id=?").run(t, asn.id);
    }
    db.exec('COMMIT');
    ok(res, {
      put_no: putNo, added_sellable: round2(addedSellable),
      all_done: round2(leftAll) <= 0,
      left_qty: round2(leftAll)
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

/** ==================== 套装 ==================== */
function bundleDetail(b) {
  const items = db.prepare('SELECT * FROM wh_bundle_items WHERE bundle_id=? ORDER BY id').all(b.id);
  const st = db.prepare('SELECT * FROM wh_bundle_stock WHERE bundle_id=? AND warehouse=?').get(b.id, b.warehouse);
  // 可组装套数 = min(floor(组件库存 / 单套用量))
  let can = null;
  const comp = items.map((i) => {
    const s = getStock(b.warehouse, i.style_no, i.color, i.size);
    const have = s ? num(s.qty) : 0;
    const need = num(i.qty_per);
    const possible = need > 0 ? Math.floor(have / need) : 0;
    if (can === null || possible < can) can = possible;
    return { ...i, stock: round2(have), max_kits: possible };
  });
  return {
    ...b,
    items: comp,
    stock_qty: round2(st ? st.qty : 0),
    can_kit: can === null ? 0 : can
  };
}

router.get('/bundles', authRequired, requireRole(...READ), (req, res) => {
  const { warehouse = 'us', q } = req.query;
  const args = [warehouse];
  let where = 'WHERE b.warehouse=?';
  if (q) { where += ' AND (b.bundle_sku LIKE ? OR b.name LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT * FROM wh_bundles b ${where} ORDER BY b.id DESC`).all(...args);
  ok(res, rows.map(bundleDetail));
});

router.post('/bundles', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!b.bundle_sku) return fail(res, 400, '套装编码必填');
  if (!b.name) return fail(res, 400, '套装名称必填');
  if (!items.length) return fail(res, 400, '套装至少要有一个组件');
  for (const it of items) {
    if (!it.style_no) return fail(res, 400, '组件必须有款号');
    if (num(it.qty_per) <= 0) return fail(res, 400, `组件 ${it.style_no} 的单套用量必须大于 0`);
    if (it.style_no === b.bundle_sku) return fail(res, 400, '套装编码不能与组件款号相同（会自己包含自己）');
  }
  const dup = db.prepare('SELECT id FROM wh_bundles WHERE bundle_sku=?').get(b.bundle_sku);
  if (dup) return fail(res, 400, `套装编码 ${b.bundle_sku} 已存在`);
  const exists = db.prepare('SELECT id FROM stock_items WHERE style_no=? LIMIT 1').get(b.bundle_sku);
  if (exists) return fail(res, 400, `编码 ${b.bundle_sku} 已被单品占用，套装要用独立编码`);

  const t = localNow();
  db.exec('BEGIN');
  try {
    const r = db.prepare(
      'INSERT INTO wh_bundles (bundle_sku,name,warehouse,sale_price,status,remark,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(b.bundle_sku, b.name, b.warehouse || 'us', num(b.sale_price), 'active', b.remark || null, t, t);
    const id = r.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO wh_bundle_items (bundle_id,style_no,product_name,color,size,qty_per) VALUES (?,?,?,?,?,?)'
    );
    items.forEach((it) => ins.run(id, it.style_no, it.product_name || '', it.color || '', it.size || '', num(it.qty_per)));
    db.exec('COMMIT');
    ok(res, { id, bundle_sku: b.bundle_sku });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

router.put('/bundles/:id', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const bd = db.prepare('SELECT * FROM wh_bundles WHERE id=?').get(Number(req.params.id));
  if (!bd) return fail(res, 404, '套装不存在');
  const { name, sale_price, status, remark, items } = req.body || {};
  if (status && !['active', 'disabled'].includes(status)) return fail(res, 400, '状态只能是 active / disabled');

  // 有库存时改组件会让账对不上
  const st = db.prepare('SELECT * FROM wh_bundle_stock WHERE bundle_id=? AND warehouse=?').get(bd.id, bd.warehouse);
  if (Array.isArray(items) && num(st?.qty) > 0) {
    return fail(res, 400, `该套装还有 ${round2(st.qty)} 套库存，不能改组件（先全部拆回单品）`);
  }

  if (Array.isArray(items)) {
    if (!items.length) return fail(res, 400, '套装至少要有一个组件');
    for (const it of items) {
      if (!it.style_no) return fail(res, 400, '组件必须有款号');
      if (num(it.qty_per) <= 0) return fail(res, 400, `组件 ${it.style_no} 的单套用量必须大于 0`);
      if (it.style_no === bd.bundle_sku) return fail(res, 400, '套装编码不能与组件款号相同');
    }
  }

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE wh_bundles SET name=?, sale_price=?, status=?, remark=?, updated_at=? WHERE id=?').run(
      name || bd.name,
      sale_price === undefined ? bd.sale_price : num(sale_price),
      status || bd.status,
      remark === undefined ? bd.remark : remark,
      localNow(), bd.id
    );
    if (Array.isArray(items)) {
      db.prepare('DELETE FROM wh_bundle_items WHERE bundle_id=?').run(bd.id);
      const ins = db.prepare(
        'INSERT INTO wh_bundle_items (bundle_id,style_no,product_name,color,size,qty_per) VALUES (?,?,?,?,?,?)'
      );
      items.forEach((it) => ins.run(bd.id, it.style_no, it.product_name || '', it.color || '', it.size || '', num(it.qty_per)));
    }
    db.exec('COMMIT');
    ok(res, { id: bd.id });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

/** 组装：扣组件、加套装 */
router.post('/bundles/:id/kit', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const bd = db.prepare('SELECT * FROM wh_bundles WHERE id=?').get(Number(req.params.id));
  if (!bd) return fail(res, 404, '套装不存在');
  if (bd.status !== 'active') return fail(res, 400, '套装已停用，不能组装');
  const qty = num(req.body?.qty);
  if (qty <= 0 || !Number.isInteger(qty)) return fail(res, 400, '组装数量必须是大于 0 的整数');

  const items = db.prepare('SELECT * FROM wh_bundle_items WHERE bundle_id=?').all(bd.id);
  if (!items.length) return fail(res, 400, '套装没有组件，不能组装');

  // 先整体检查齐套，避免扣一半
  const lacks = [];
  items.forEach((it) => {
    const s = getStock(bd.warehouse, it.style_no, it.color, it.size);
    const have = s ? num(s.qty) : 0;
    const need = round2(num(it.qty_per) * qty);
    if (have < need) lacks.push(`${it.style_no}(${it.color || '-'}/${it.size || '-'}) 需 ${need} 有 ${round2(have)}`);
  });
  if (lacks.length) return fail(res, 400, '组件不齐套：' + lacks.join('；'));

  const t = localNow();
  const opNo = seqOf('wh_bundle_ops', 'KT');
  const st = db.prepare('SELECT * FROM wh_bundle_stock WHERE bundle_id=? AND warehouse=?').get(bd.id, bd.warehouse);
  const before = round2(st ? num(st.qty) : 0);

  db.exec('BEGIN');
  try {
    items.forEach((it) => {
      const need = round2(num(it.qty_per) * qty);
      applyStock({
        warehouse: bd.warehouse, style_no: it.style_no, product_name: it.product_name,
        color: it.color, size: it.size, delta: -need
      });
      addLedger({
        warehouse: bd.warehouse, style_no: it.style_no, product_name: it.product_name,
        color: it.color, size: it.size, type: 'kit_out', qty: -need,
        ref_type: 'bundle_op', ref_id: bd.id,
        remark: `组装套装 ${bd.bundle_sku} × ${qty}（${opNo}）`, operator: req.user?.username
      });
    });
    if (st) db.prepare('UPDATE wh_bundle_stock SET qty=?, updated_at=? WHERE id=?').run(round2(before + qty), t, st.id);
    else db.prepare('INSERT INTO wh_bundle_stock (bundle_id,warehouse,qty,updated_at) VALUES (?,?,?,?)').run(bd.id, bd.warehouse, round2(before + qty), t);

    db.prepare(
      `INSERT INTO wh_bundle_ops (op_no,bundle_id,type,warehouse,qty,before_qty,after_qty,status,remark,operator,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(opNo, bd.id, 'kit', bd.warehouse, qty, before, round2(before + qty), 'done', req.body?.remark || null, req.user?.username || null, t);
    db.exec('COMMIT');
    ok(res, { op_no: opNo, type: 'kit', qty, before_qty: before, after_qty: round2(before + qty) });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

/** 拆分：扣套装、回组件 */
router.post('/bundles/:id/unbundle', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const bd = db.prepare('SELECT * FROM wh_bundles WHERE id=?').get(Number(req.params.id));
  if (!bd) return fail(res, 404, '套装不存在');
  const qty = num(req.body?.qty);
  if (qty <= 0 || !Number.isInteger(qty)) return fail(res, 400, '拆分数量必须是大于 0 的整数');

  const st = db.prepare('SELECT * FROM wh_bundle_stock WHERE bundle_id=? AND warehouse=?').get(bd.id, bd.warehouse);
  const have = round2(st ? num(st.qty) : 0);
  if (have < qty) return fail(res, 400, `套装库存只有 ${have} 套，不能拆 ${qty} 套`);

  const items = db.prepare('SELECT * FROM wh_bundle_items WHERE bundle_id=?').all(bd.id);
  if (!items.length) return fail(res, 400, '套装没有组件');

  const t = localNow();
  const opNo = seqOf('wh_bundle_ops', 'UB');

  db.exec('BEGIN');
  try {
    items.forEach((it) => {
      const give = round2(num(it.qty_per) * qty);
      applyStock({
        warehouse: bd.warehouse, style_no: it.style_no, product_name: it.product_name,
        color: it.color, size: it.size, delta: give
      });
      addLedger({
        warehouse: bd.warehouse, style_no: it.style_no, product_name: it.product_name,
        color: it.color, size: it.size, type: 'kit_in', qty: give,
        ref_type: 'bundle_op', ref_id: bd.id,
        remark: `拆分套装 ${bd.bundle_sku} × ${qty}（${opNo}）`, operator: req.user?.username
      });
    });
    db.prepare('UPDATE wh_bundle_stock SET qty=?, updated_at=? WHERE id=?').run(round2(have - qty), t, st.id);
    db.prepare(
      `INSERT INTO wh_bundle_ops (op_no,bundle_id,type,warehouse,qty,before_qty,after_qty,status,remark,operator,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(opNo, bd.id, 'unbundle', bd.warehouse, qty, have, round2(have - qty), 'done', req.body?.remark || null, req.user?.username || null, t);
    db.exec('COMMIT');
    ok(res, { op_no: opNo, type: 'unbundle', qty, before_qty: have, after_qty: round2(have - qty) });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

router.get('/bundle-ops', authRequired, requireRole(...READ), (req, res) => {
  const { bundle_id, limit = 100 } = req.query;
  const args = [];
  let where = '';
  if (bundle_id) { where = 'WHERE o.bundle_id=?'; args.push(Number(bundle_id)); }
  args.push(Math.min(Number(limit) || 100, 300));
  const rows = db.prepare(
    `SELECT o.*, b.bundle_sku, b.name FROM wh_bundle_ops o
     JOIN wh_bundles b ON b.id=o.bundle_id ${where} ORDER BY o.id DESC LIMIT ?`
  ).all(...args);
  ok(res, rows.map((r) => ({ ...r, type_label: r.type === 'kit' ? '组装' : '拆分' })));
});

/** ==================== 运费核对 ==================== */
/** 按费率表算系统应付运费；没有费率返回 null（不拿 0 当基准） */
function calcFreight(carrier, zone, weightKg) {
  const rate = db.prepare(
    `SELECT * FROM wh_freight_rates WHERE carrier=? AND zone=? AND status='active'
     ORDER BY COALESCE(effective_from,'') DESC, id DESC LIMIT 1`
  ).get(carrier, zone);
  if (!rate) return null;
  const w = Math.max(0, num(weightKg));
  const firstW = num(rate.first_weight) || 1;
  let amt = num(rate.first_price);
  if (w > firstW) {
    const step = num(rate.add_weight) || 0.5;
    amt += Math.ceil((w - firstW) / step) * num(rate.add_price);
  }
  amt = amt * (1 + num(rate.fuel_pct) / 100);
  return { amount: round2(amt), rate };
}

router.get('/freight/rates', authRequired, requireRole(...READ), (req, res) => {
  ok(res, db.prepare('SELECT * FROM wh_freight_rates ORDER BY carrier, zone').all());
});

router.post('/freight/rates', authRequired, requireRole(...WRITE), (req, res) => {
  const b = req.body || {};
  if (!b.carrier) return fail(res, 400, '承运商必填');
  if (!b.zone) return fail(res, 400, '分区必填');
  if (num(b.first_price) <= 0) return fail(res, 400, '首重价格必须大于 0');
  if (num(b.first_weight) <= 0) return fail(res, 400, '首重必须大于 0');
  const t = localNow();
  try {
    const r = db.prepare(
      `INSERT INTO wh_freight_rates (carrier,zone,currency,first_weight,first_price,add_weight,add_price,fuel_pct,effective_from,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(b.carrier, b.zone, b.currency || 'USD', num(b.first_weight), num(b.first_price),
      num(b.add_weight) || 0.5, num(b.add_price), num(b.fuel_pct),
      b.effective_from || localDate(), 'active', t);
    ok(res, { id: r.lastInsertRowid });
  } catch (e) {
    return fail(res, 400, '同一承运商同一分区同一生效日已存在费率');
  }
});

router.get('/freight/bills', authRequired, requireRole(...READ), (req, res) => {
  const { status, carrier } = req.query;
  const args = [];
  const wh = [];
  if (status && status !== 'all') { wh.push('status=?'); args.push(status); }
  if (carrier) { wh.push('carrier=?'); args.push(carrier); }
  const rows = db.prepare(
    `SELECT * FROM wh_freight_bills ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY id DESC LIMIT 100`
  ).all(...args);
  ok(res, rows);
});

router.get('/freight/bills/:id', authRequired, requireRole(...READ), (req, res) => {
  const bill = db.prepare('SELECT * FROM wh_freight_bills WHERE id=?').get(Number(req.params.id));
  if (!bill) return fail(res, 404, '账单不存在');
  const items = db.prepare('SELECT * FROM wh_freight_items WHERE bill_id=? ORDER BY diff_type DESC, id').all(bill.id);
  ok(res, { bill, items });
});

/**
 * 新建账单并逐行核对
 * { bill_no, carrier, period_from, period_to, currency,
 *   items:[{tracking_no, ship_date, dest_zip, zone, weight, act_weight, bill_amount}] }
 * 核对口径：
 *  - tracking_no 在 shipment_events 找不到 → missing（账单有系统无）
 *  - 没有费率 → no_rate（不算差异金额，只提示）
 *  - |diff| > max(1, sys*2%) → amount
 *  - 计费重与实重差 > 5% → weight
 *  - 其余 ok
 */
router.post('/freight/bills', authRequired, requireRole(...WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const lines = Array.isArray(b.items) ? b.items : [];
  if (!b.carrier) return fail(res, 400, '承运商必填');
  if (!lines.length) return fail(res, 400, '账单至少要有一行明细');
  const billNo = b.bill_no || seqOf('wh_freight_bills', 'YF');
  const dup = db.prepare('SELECT id FROM wh_freight_bills WHERE bill_no=?').get(billNo);
  if (dup) return fail(res, 400, `账单号 ${billNo} 已存在`);

  const t = localNow();
  db.exec('BEGIN');
  try {
    const r = db.prepare(
      `INSERT INTO wh_freight_bills (bill_no,carrier,period_from,period_to,currency,total_amount,sys_amount,
         diff_amount,item_count,diff_count,missing_count,extra_count,status,supplier_id,remark,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(billNo, b.carrier, b.period_from || null, b.period_to || null, b.currency || 'USD',
      0, 0, 0, 0, 0, 0, 0, 'pending', b.supplier_id || null, b.remark || null, req.user?.username || null, t, t);
    const billId = r.lastInsertRowid;

    const ins = db.prepare(
      `INSERT INTO wh_freight_items (bill_id,tracking_no,order_id,ship_date,dest_zip,zone,weight,act_weight,
         bill_amount,sys_amount,diff,diff_type,status,note,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );

    for (const ln of lines) {
      const tracking = String(ln.tracking_no || '').trim();
      if (!tracking) return fail(res, 400, '每行都必须有运单号');
      const ev = db.prepare(
        "SELECT order_id FROM shipment_events WHERE tracking_no=? AND order_id IS NOT NULL ORDER BY id DESC LIMIT 1"
      ).get(tracking);
      const orderId = ev ? ev.order_id : null;
      const zone = ln.zone || 'US-W';
      const billAmt = num(ln.bill_amount);
      const weight = num(ln.weight);
      const actW = num(ln.act_weight);

      let sysAmt = 0;
      let diffType = 'ok';
      const basisW = actW > 0 ? actW : weight;
      const calc = calcFreight(b.carrier, zone, basisW);
      if (!orderId) {
        diffType = 'missing';
      } else if (!calc) {
        diffType = 'no_rate';
      } else {
        sysAmt = calc.amount;
        const d0 = round2(billAmt - sysAmt);
        const tol = Math.max(1, sysAmt * 0.02);
        // 计费重异常优先判 weight：重量虚高的根因不该被记成「金额差」
        if (actW > 0 && weight > 0 && Math.abs(weight - actW) / actW > 0.05) diffType = 'weight';
        else if (Math.abs(d0) > tol) diffType = 'amount';
      }
      const diff = round2(billAmt - sysAmt);
      ins.run(billId, tracking, orderId, ln.ship_date || null, ln.dest_zip || null, zone, weight, actW,
        billAmt, sysAmt, diffType === 'no_rate' || diffType === 'missing' ? 0 : diff,
        diffType, diffType === 'ok' ? 'ok' : 'diff', ln.note || null, t);
    }

    refreshBill(billId);
    db.exec('COMMIT');
    ok(res, { id: billId, bill_no: billNo, ...billSummary(billId) });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

function billSummary(id) {
  const b = db.prepare('SELECT * FROM wh_freight_bills WHERE id=?').get(id);
  return {
    bill_no: b?.bill_no, item_count: b?.item_count, diff_count: b?.diff_count,
    missing_count: b?.missing_count, extra_count: b?.extra_count,
    total_amount: round2(b?.total_amount), sys_amount: round2(b?.sys_amount),
    diff_amount: round2(b?.diff_amount), status: b?.status
  };
}

/** 重算账单汇总（也可能补出「系统有账单无」的漏计费行） */
function refreshBill(billId, addExtra = false) {
  const bill = db.prepare('SELECT * FROM wh_freight_bills WHERE id=?').get(billId);
  if (!bill) return;

  if (addExtra && bill.period_from && bill.period_to) {
    const known = db.prepare('SELECT tracking_no FROM wh_freight_items WHERE bill_id=? AND tracking_no IS NOT NULL')
      .all(billId).map((x) => x.tracking_no);
    const set = new Set(known);
    const evs = db.prepare(
      `SELECT tracking_no, order_id, MIN(event_time) AS t FROM shipment_events
       WHERE tracking_no IS NOT NULL AND tracking_no <> ''
         AND substr(event_time,1,10) BETWEEN ? AND ?
       GROUP BY tracking_no`
    ).all(bill.period_from, bill.period_to);
    const ins = db.prepare(
      `INSERT INTO wh_freight_items (bill_id,tracking_no,order_id,ship_date,dest_zip,zone,weight,act_weight,
         bill_amount,sys_amount,diff,diff_type,status,note,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const t = localNow();
    evs.forEach((e) => {
      if (set.has(e.tracking_no)) return;
      const calc = calcFreight(bill.carrier, 'US-W', 1);
      ins.run(billId, e.tracking_no, e.order_id, String(e.t || '').slice(0, 10), null, 'US-W',
        0, 0, 0, calc ? calc.amount : 0, 0, 'extra', 'diff', '系统有发货记录但账单里没有（漏计费，不影响付款）', t);
    });
  }

  const ag = db.prepare(
    `SELECT
       COUNT(*) AS c,
       COALESCE(SUM(bill_amount),0) AS total,
       COALESCE(SUM(CASE WHEN diff_type NOT IN ('no_rate','missing','extra') THEN sys_amount ELSE 0 END),0) AS sys,
       COALESCE(SUM(CASE WHEN diff_type IN ('amount','weight') THEN diff ELSE 0 END),0) AS diff,
       SUM(CASE WHEN diff_type IN ('amount','weight') THEN 1 ELSE 0 END) AS dc,
       SUM(CASE WHEN diff_type='missing' THEN 1 ELSE 0 END) AS mc,
       SUM(CASE WHEN diff_type='extra' THEN 1 ELSE 0 END) AS ec
     FROM wh_freight_items WHERE bill_id=?`
  ).get(billId);

  const open = db.prepare(
    "SELECT COUNT(*) c FROM wh_freight_items WHERE bill_id=? AND status IN ('diff','disputed') AND diff_type IN ('amount','weight','missing')"
  ).get(billId).c;

  const status = bill.status === 'settled' ? 'settled' : open > 0 ? 'disputed' : num(ag.dc) + num(ag.mc) > 0 ? 'pending' : 'matched';
  db.prepare(
    `UPDATE wh_freight_bills SET total_amount=?, sys_amount=?, diff_amount=?, item_count=?, diff_count=?,
       missing_count=?, extra_count=?, status=?, updated_at=? WHERE id=?`
  ).run(round2(ag.total), round2(ag.sys), round2(ag.diff), ag.c, num(ag.dc) + num(ag.mc),
    num(ag.mc), num(ag.ec), status, localNow(), billId);
}

router.post('/freight/bills/:id/match', authRequired, requireRole(...WRITE), (req, res) => {
  const bill = db.prepare('SELECT * FROM wh_freight_bills WHERE id=?').get(Number(req.params.id));
  if (!bill) return fail(res, 404, '账单不存在');
  if (bill.status === 'settled') return fail(res, 400, '已结算的账单不能再核对');
  refreshBill(bill.id, req.body?.add_extra !== false);
  ok(res, billSummary(bill.id));
});

/** 处理差异：accepted 认账 / disputed 挂争议 / ok 撤销处理 */
router.post('/freight/items/:id/resolve', authRequired, requireRole(...WRITE), (req, res) => {
  const it = db.prepare('SELECT * FROM wh_freight_items WHERE id=?').get(Number(req.params.id));
  if (!it) return fail(res, 404, '明细不存在');
  const status = req.body?.status || 'accepted';
  if (!['accepted', 'disputed', 'ok'].includes(status)) return fail(res, 400, '状态只能是 accepted / disputed / ok');
  const note = String(req.body?.note || '').trim();
  if (status !== 'ok' && note.length < 4) return fail(res, 400, '处理差异必须写说明（至少 4 个字）');
  db.prepare('UPDATE wh_freight_items SET status=?, note=COALESCE(?,note) WHERE id=?').run(status, note || null, it.id);
  refreshBill(it.bill_id);
  ok(res, { id: it.id, status });
});

/** 结算：有未处理差异不能结 */
router.post('/freight/bills/:id/settle', authRequired, requireRole(...WRITE), (req, res) => {
  const bill = db.prepare('SELECT * FROM wh_freight_bills WHERE id=?').get(Number(req.params.id));
  if (!bill) return fail(res, 404, '账单不存在');
  if (bill.status === 'settled') return fail(res, 400, '这单已经结算过了');
  const open = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(bill_amount),0) amt FROM wh_freight_items
     WHERE bill_id=? AND status IN ('diff','disputed')`
  ).get(bill.id);
  if (open.c > 0) {
    return fail(res, 400, `还有 ${open.c} 条差异没处理（合计 $${round2(open.amt)}），不能结算。请先「认账」或「挂争议」`);
  }
  db.prepare("UPDATE wh_freight_bills SET status='settled', updated_at=? WHERE id=?").run(localNow(), bill.id);
  ok(res, { id: bill.id, status: 'settled', total_amount: round2(bill.total_amount) });
});

/** ==================== 总览 ==================== */
router.get('/board', authRequired, requireRole(...READ), (req, res) => {
  const wh = req.query.warehouse || 'us';
  const k = (sql, ...a) => num(db.prepare(sql).get(...a).c);

  const arriving = db.prepare(
    `SELECT a.*, (SELECT COUNT(*) FROM wh_asn_items i WHERE i.asn_id=a.id) line_count
     FROM wh_asns a WHERE a.warehouse=? AND a.status IN ('in_transit','arrived') ORDER BY a.eta_date, a.id`
  ).all(wh);
  const receiving = db.prepare(
    `SELECT r.*, a.asn_no, a.warehouse, COALESCE((SELECT SUM(i.put_qty) FROM wh_receipt_items i WHERE i.rcv_id=r.id),0) put_qty
     FROM wh_receipts r JOIN wh_asns a ON a.id=r.asn_id
     WHERE a.warehouse=? ORDER BY r.id DESC LIMIT 20`
  ).all(wh);
  const locStat = db.prepare(
    'SELECT zone, COUNT(*) c FROM wh_locations WHERE warehouse=? GROUP BY zone'
  ).all(wh);
  const bundleStock = db.prepare(
    `SELECT b.id, b.bundle_sku, b.name, COALESCE(s.qty,0) qty
     FROM wh_bundles b LEFT JOIN wh_bundle_stock s ON s.bundle_id=b.id AND s.warehouse=?
     WHERE b.status='active' ORDER BY qty DESC LIMIT 20`
  ).all(wh);
  const freightOpen = db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(total_amount),0) amt FROM wh_freight_bills WHERE status IN ('pending','disputed')"
  ).get();
  const freightDiff = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(ABS(diff)),0) amt FROM wh_freight_items
     WHERE status IN ('diff','disputed') AND diff_type IN ('amount','weight')`
  ).get();

  ok(res, {
    stat: {
      asn_in_transit: arriving.length,
      asn_in_transit_qty: round2(arriving.reduce((a, x) => a + num(x.expect_qty), 0)),
      receiving: receiving.filter((r) => round2(num(r.received_qty) - num(r.damaged_qty) - num(r.put_qty)) > 0).length,
      sellable_qty: round2(num(db.prepare(
        "SELECT COALESCE(SUM(qty),0) c FROM stock_items WHERE warehouse=?"
      ).get(wh).c)),
      bundle_qty: round2(num(db.prepare(
        'SELECT COALESCE(SUM(qty),0) c FROM wh_bundle_stock WHERE warehouse=?'
      ).get(wh).c)),
      short_qty: round2(arriving.reduce((a, x) => a + 0, 0) + num(db.prepare(
        'SELECT COALESCE(SUM(short_qty),0) c FROM wh_receipts'
      ).get().c)),
      damaged_qty: round2(num(db.prepare('SELECT COALESCE(SUM(damaged_qty),0) c FROM wh_receipts').get().c)),
      freight_bills_open: freightOpen.c,
      freight_diff_cnt: freightDiff.c,
      freight_diff_amt: round2(freightDiff.amt),
      loc_total: locStat.reduce((a, x) => a + x.c, 0)
    },
    arriving,
    receiving: receiving.map((r) => ({
      ...r,
      to_put: round2(num(r.received_qty) - num(r.damaged_qty) - num(r.put_qty))
    })),
    loc_stat: locStat.map((x) => ({ ...x, zone_label: ZONE_LABEL[x.zone] || x.zone })),
    bundle_stock: bundleStock,
    recent_ops: db.prepare(
      `SELECT o.*, b.bundle_sku FROM wh_bundle_ops o JOIN wh_bundles b ON b.id=o.bundle_id
       ORDER BY o.id DESC LIMIT 10`
    ).all()
  });
});

router.get('/dict', authRequired, requireRole(...READ), (req, res) => {
  ok(res, {
    zones: Object.entries(ZONE_LABEL).map(([k, v]) => ({ value: k, label: v })),
    asn_status: Object.entries(ASN_STATUS).map(([k, v]) => ({ value: k, label: v })),
    carriers: db.prepare("SELECT DISTINCT carrier FROM wh_freight_rates WHERE status='active'").all().map((x) => x.carrier),
    warehouses: ['us', 'cn']
  });
});

module.exports = router;
module.exports.__refreshBill = refreshBill;
module.exports.__calcFreight = calcFreight;
