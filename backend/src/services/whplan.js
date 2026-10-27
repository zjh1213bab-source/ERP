/**
 * 美仓作业计划（原型 M19：拣货波次 / 跨境头程 / 库容规划）
 * ============================================================
 * 三条不能松的口径：
 *
 * 1. **一笔预留只能进一个未取消的波次**（数据库部分唯一索引兜底）
 *    否则同一笔预留会被拣两次，库存扣两次，客户收到「已发货」却没有货。
 *
 * 2. **只有交承运才算出库**
 *    拣货、复核、打包都只是把货挪到打包台，库存仍算在库里；
 *    交承运那一刻才扣 stock_items 并写 ledger（out）。取消未拣直接释放；
 *    已拣的要先确认实物回位，否则放量会超卖。
 *
 * 3. **库位结存 = 上架量 − 已交承运波次的拣出量**
 *    不新建「库位库存表」：上架与拣出都是既有账源，再加一张表要同步三处，迟早对不上。
 *    没有库位结存记录的 SKU（历史数据常见）按剩余容量兜底分配，并标注来源，
 *    拣货时以实物为准。
 *
 * 头程：段按顺序推进，实际到达必须逐段；箱级短多错损要数量守恒；
 *      ETA 变更必须写原因，并算出受影响的有效占用与待确认申请（不自动改承诺）。
 *
 * 时间口径：本地墙钟字符串（services/sla.js）。
 */
const { db } = require('../db');
const { localNow, localDate } = require('./sla');
const { applyStock, addLedger, round2 } = require('./stockOps');

const WAVE_STATUS = { draft: '草稿', released: '待拣货', picking: '拣货中', packed: '已复核待发', shipped: '已交承运', cancelled: '已取消' };
const ITEM_STATUS = { pending: '待拣', picked: '已拣', short: '短拣', cancelled: '已取消' };
const LEG_STATUS = { planned: '计划中', in_transit: '在途', arrived: '已到达' };
const MODE_LABEL = { ocean: '海运', air: '空运', rail: '铁运', truck: '卡车' };

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const p2 = (n) => String(n).padStart(2, '0');
const now = () => localNow();
const today = () => localDate();
const me = (op) => (op && (op.name || op.username)) || 'system';

function addDays(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + Number(n || 0));
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function daysBetween(a, b) {
  const ta = new Date(`${String(a).slice(0, 10)}T00:00:00`).getTime();
  const tb = new Date(`${String(b).slice(0, 10)}T00:00:00`).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

/** 单号取「已有最大号 + 1」（COUNT+1 删过一条就撞号） */
function nextNo(prefix, table, col) {
  const d = today().replace(/-/g, '');
  const head = `${prefix}${d}`;
  const rows = db.prepare(`SELECT ${col} n FROM ${table} WHERE ${col} LIKE ?`).all(`${head}%`);
  let max = 0;
  rows.forEach((x) => {
    const v = Number(String(x.n).slice(head.length));
    if (Number.isFinite(v) && v > max) max = v;
  });
  return `${head}${String(max + 1).padStart(4, '0')}`;
}

const skuKey = (style, color, size) => `${style}|${color || ''}|${size || ''}`;

/** ==================== 库存 / 库位 ==================== */

function onHand(warehouse, styleNo, color, size) {
  const r = db.prepare(`SELECT COALESCE(SUM(qty),0) q FROM stock_items
    WHERE warehouse=? AND style_no=? AND COALESCE(color,'')=COALESCE(?,'') AND COALESCE(size,'')=COALESCE(?,'')`)
    .get(warehouse, styleNo || '', color || '', size || '');
  return r2(r.q);
}

/** 各库位已用量 = 上架量 − 已交承运波次的拣出量 */
function locUsed() {
  const map = new Map();
  db.prepare('SELECT location_id, COALESCE(SUM(qty),0) q FROM wh_putaways GROUP BY location_id').all()
    .forEach((x) => map.set(Number(x.location_id), r2(x.q)));
  db.prepare(`SELECT i.location_id, COALESCE(SUM(i.qty_picked),0) q
    FROM pick_wave_items i JOIN pick_waves w ON w.id=i.wave_id
    WHERE w.status='shipped' GROUP BY i.location_id`).all()
    .forEach((x) => map.set(Number(x.location_id), r2((map.get(Number(x.location_id)) || 0) - Number(x.q))));
  return map;
}

/** 某 SKU 在各库位的结存（上架带 SKU 才算得出来） */
function skuLocStock(styleNo, color, size) {
  const put = db.prepare(`SELECT location_id, COALESCE(SUM(qty),0) q FROM wh_putaways
    WHERE style_no=? AND COALESCE(color,'')=COALESCE(?,'') AND COALESCE(size,'')=COALESCE(?,'')
    GROUP BY location_id`).all(styleNo || '', color || '', size || '');
  const pick = db.prepare(`SELECT i.location_id, COALESCE(SUM(i.qty_picked),0) q
    FROM pick_wave_items i JOIN pick_waves w ON w.id=i.wave_id
    WHERE w.status='shipped' AND i.style_no=? AND COALESCE(i.color,'')=COALESCE(?,'') AND COALESCE(i.size,'')=COALESCE(?,'')
    GROUP BY i.location_id`).all(styleNo || '', color || '', size || '');
  const map = new Map();
  put.forEach((x) => map.set(Number(x.location_id), r2(x.q)));
  pick.forEach((x) => map.set(Number(x.location_id), r2((map.get(Number(x.location_id)) || 0) - Number(x.q))));
  return map;
}

/**
 * 分配库位：优先「该 SKU 在此库位有结存」，其次按剩余容量兜底。
 * 返回 { location, source } 或 { blocked: '原因' }。
 */
function allocateLocation(warehouse, styleNo, color, size, qty) {
  const used = locUsed();
  const locs = db.prepare("SELECT * FROM wh_locations WHERE warehouse=? AND status='active'").all(warehouse);
  const byId = new Map(locs.map((l) => [Number(l.id), l]));
  const skuStock = skuLocStock(styleNo, color, size);

  let best = null;
  skuStock.forEach((left, locId) => {
    const loc = byId.get(locId);
    if (!loc || loc.zone !== 'sellable' || left + 0.001 < qty) return;
    if (!best || left > best.left) best = { loc, left };
  });
  if (best) return { location: best.loc, source: 'sku_stock' };

  const candidates = locs
    .filter((l) => l.zone === 'sellable')
    .map((l) => ({ loc: l, free: r2(Number(l.capacity || 0) - (used.get(Number(l.id)) || 0)) }))
    .filter((x) => Number(x.loc.capacity || 0) > 0 && x.free + 0.001 >= qty)
    .sort((a, b2) => a.free - b2.free);
  if (candidates.length) return { location: candidates[0].loc, source: 'capacity' };
  return { blocked: `没有能放下 ${qty} 件的可售库位（可售区剩余容量不足）` };
}

/** ==================== 字典与概览 ==================== */

function dict() {
  return {
    wave_status: Object.entries(WAVE_STATUS).map(([k, v]) => ({ k, v })),
    item_status: Object.entries(ITEM_STATUS).map(([k, v]) => ({ k, v })),
    leg_status: Object.entries(LEG_STATUS).map(([k, v]) => ({ k, v })),
    modes: Object.entries(MODE_LABEL).map(([k, v]) => ({ k, v })),
    strategies: [{ k: 'zone', v: '按库区顺序' }, { k: 'order', v: '按订单顺序' }, { k: 'manual', v: '手工选预留' }],
    zones: db.prepare('SELECT DISTINCT zone FROM wh_locations ORDER BY zone').all().map((x) => x.zone),
    warehouses: db.prepare("SELECT DISTINCT warehouse FROM wh_locations").all().map((x) => x.warehouse),
    today: today()
  };
}

function overview() {
  const cnt = (sql, ...args) => Number(db.prepare(sql).get(...args).c);
  const asns = db.prepare("SELECT * FROM wh_asns WHERE status IN ('created','in_transit','arrived')").all();
  const delayed = asns.filter((a) => a.status === 'in_transit' && a.eta_date && a.eta_date < today());
  const used = locUsed();
  const locs = db.prepare('SELECT * FROM wh_locations').all();
  const anomalies = locs.filter((l) => Number(l.capacity || 0) > 0
    && (used.get(Number(l.id)) || 0) > Number(l.capacity) + 0.001);
  const warnings = locs.filter((l) => {
    const cap = Number(l.capacity || 0);
    if (!cap) return false;
    const u = used.get(Number(l.id)) || 0;
    return u / cap >= 0.9;
  });
  return {
    waves: {
      draft: cnt("SELECT COUNT(*) c FROM pick_waves WHERE status='draft'"),
      released: cnt("SELECT COUNT(*) c FROM pick_waves WHERE status='released'"),
      picking: cnt("SELECT COUNT(*) c FROM pick_waves WHERE status='picking'"),
      packed: cnt("SELECT COUNT(*) c FROM pick_waves WHERE status='packed'"),
      shipped: cnt("SELECT COUNT(*) c FROM pick_waves WHERE status='shipped'"),
      cancelled: cnt("SELECT COUNT(*) c FROM pick_waves WHERE status='cancelled'"),
      pending_items: cnt("SELECT COUNT(*) c FROM pick_wave_items i JOIN pick_waves w ON w.id=i.wave_id WHERE i.status='pending' AND w.status IN ('released','picking')"),
      short_qty_month: r2(db.prepare(`SELECT COALESCE(SUM(qty_short),0) q FROM pick_wave_items
        WHERE substr(created_at,1,7)=?`).get(today().slice(0, 7)).q)
    },
    inbound: {
      in_transit: asns.filter((a) => a.status === 'in_transit').length,
      delayed: delayed.length,
      next_eta: asns.filter((a) => a.status === 'in_transit' && a.eta_date).sort((a, b2) => (a.eta_date < b2.eta_date ? -1 : 1))[0] || null,
      units_in_transit: r2(asns.filter((a) => a.status === 'in_transit').reduce((x, a) => x + Number(a.expect_qty || 0), 0))
    },
    capacity: {
      locations: locs.length,
      near_full: warnings.length,
      anomalies: anomalies.length,
      used: r2(Array.from(used.values()).reduce((x, v) => x + v, 0)),
      capacity: r2(locs.reduce((x, l) => x + Number(l.capacity || 0), 0))
    },
    notes: [
      '一笔预留只能进一个未取消波次；拣货与复核都不扣库存，交承运才扣',
      '库位结存 = 上架量 − 已交承运波次的拣出量；没有库位结存的 SKU 按剩余容量兜底',
      '头程 ETA 变更只提示受影响需求，不自动改客户承诺'
    ]
  };
}

/** ==================== 拣货波次 ==================== */

function listWaves(q = {}) {
  let rows = db.prepare('SELECT * FROM pick_waves ORDER BY id DESC').all();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.warehouse) rows = rows.filter((r) => r.warehouse === q.warehouse);
  if (q.q) rows = rows.filter((r) => String(r.wave_no).includes(q.q) || String(r.tracking_no || '').includes(q.q));
  return rows.map((r) => {
    // 「短拣」只认复核时确认过的 qty_short；未拣完的数量是「未拣」，不是短拣
    const agg = db.prepare('SELECT COALESCE(SUM(qty_short),0) s, COALESCE(SUM(qty),0) t FROM pick_wave_items WHERE wave_id=?').get(r.id);
    return {
      ...r,
      status_label: WAVE_STATUS[r.status] || r.status,
      short_qty: r2(agg.s),
      unpicked: r2(agg.t - Number(r.qty_picked)),
      is_open: ['draft', 'released', 'picking', 'packed'].includes(r.status)
    };
  });
}

function getWave(id) {
  const w = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(Number(id));
  if (!w) throw new Error('波次不存在');
  const items = db.prepare('SELECT * FROM pick_wave_items WHERE wave_id=? ORDER BY seq, id').all(w.id)
    .map((i) => ({ ...i, status_label: ITEM_STATUS[i.status] || i.status }));
  return {
    ...w,
    status_label: WAVE_STATUS[w.status] || w.status,
    short_qty: r2(items.reduce((x, i) => x + Number(i.qty_short || 0), 0)),
    shortfall: r2(items.reduce((x, i) => x + (Number(i.qty) - Number(i.qty_picked)), 0)),
    items,
    next: {
      draft: ['released', 'cancelled'],
      released: ['picking', 'packed', 'cancelled'],
      picking: ['packed', 'cancelled'],
      packed: ['shipped', 'cancelled'],
      shipped: [],
      cancelled: []
    }[w.status] || []
  };
}

/**
 * 可拣占用：给「生成波次」弹窗用的候选列表。
 * 不能进波次的原因要写清楚，否则仓库只会看到「没有可拣的」。
 */
function listCandidates(q = {}) {
  const warehouse = q.warehouse || 'us';
  const taken = new Set(db.prepare("SELECT hold_id FROM pick_wave_items WHERE hold_id IS NOT NULL AND status<>'cancelled'")
    .all().map((x) => Number(x.hold_id)));
  const holds = db.prepare(`SELECT * FROM stock_holds WHERE warehouse=? AND status='active' AND qty > COALESCE(qty_picked,0)
    ORDER BY id`).all(warehouse);
  return holds.map((h) => {
    const need = r2(Number(h.qty) - Number(h.qty_picked || 0));
    const have = onHand(warehouse, h.style_no, h.color, h.size);
    const batch = h.batch_id ? db.prepare('SELECT stage,batch_no FROM supply_batches WHERE id=?').get(h.batch_id) : null;
    let reason = null;
    if (taken.has(Number(h.id))) reason = '已在别的波次里';
    else if (h.kind !== 'spot' && (!batch || batch.stage !== 'on_shelf')) reason = '对应批次还没上架（在途/在产不能拣）';
    else if (have + 0.001 < need) reason = `现货不足：占用 ${need}，实物 ${have}`;
    return {
      ...h,
      need,
      on_hand: have,
      batch_no: batch ? batch.batch_no : null,
      batch_stage: batch ? batch.stage : null,
      pickable: !reason,
      blocked_reason: reason
    };
  }).sort((a, b) => Number(b.pickable) - Number(a.pickable) || a.id - b.id);
}

/**
 * 生成波次：从「有效现货占用（或已上架批次的占用）」里挑可拣的。
 * 分配不到库位、现货不足、已在别的波次里的都会被跳过并给出原因。
 */
function createWave(b, op) {
  const warehouse = b.warehouse || 'us';
  const holdIds = Array.isArray(b.hold_ids) && b.hold_ids.length ? b.hold_ids.map(Number) : null;

  let holds = db.prepare(`SELECT * FROM stock_holds WHERE warehouse=? AND status='active' AND qty > COALESCE(qty_picked,0)`)
    .all(warehouse);
  holds = holds.filter((h) => {
    if (h.kind === 'spot') return true;
    if (!h.batch_id) return false;
    const bt = db.prepare('SELECT stage FROM supply_batches WHERE id=?').get(h.batch_id);
    return !!bt && bt.stage === 'on_shelf';    // 只有在架实物能拣
  });
  if (holdIds) holds = holds.filter((h) => holdIds.includes(Number(h.id)));
  if (!holds.length) throw new Error('没有可拣的占用：现货占用或「已上架批次」的占用才能进波次');

  const taken = new Set(db.prepare("SELECT hold_id FROM pick_wave_items WHERE hold_id IS NOT NULL AND status<>'cancelled'")
    .all().map((x) => Number(x.hold_id)));

  const picked = [];
  const skipped = [];
  const alloc = new Map();   // location_id -> 本次已分配数量（按容量兜底时要连续扣减）
  const used = locUsed();

  holds.forEach((h) => {
    if (taken.has(Number(h.id))) {
      skipped.push({ hold_no: h.hold_no, reason: '这笔预留已经在别的波次里（同一笔预留不能重复拣）' });
      return;
    }
    const need = r2(Number(h.qty) - Number(h.qty_picked || 0));
    if (need <= 0) return;
    const have = onHand(warehouse, h.style_no, h.color, h.size);
    if (have + 0.001 < need) {
      skipped.push({ hold_no: h.hold_no, reason: `现货不足：占用 ${need}，实物只有 ${have}` });
      return;
    }
    // 容量兜底时要把同批次已分配的算进去
    const usedNow = new Map(used);
    alloc.forEach((q, locId) => usedNow.set(locId, r2((usedNow.get(locId) || 0) + q)));
    const loc = (() => {
      const skuStock = skuLocStock(h.style_no, h.color, h.size);
      const locs = db.prepare("SELECT * FROM wh_locations WHERE warehouse=? AND status='active' AND zone='sellable'").all(warehouse);
      let best = null;
      skuStock.forEach((left, locId) => {
        const l = locs.find((x) => Number(x.id) === locId);
        if (!l) return;
        const avail = r2(left - (alloc.get(locId) || 0));
        if (avail + 0.001 < need) return;
        if (!best || avail > best.left) best = { loc: l, left: avail };
      });
      if (best) return { location: best.loc, source: 'sku_stock' };
      const cands = locs
        .map((l) => ({ loc: l, free: r2(Number(l.capacity || 0) - (usedNow.get(Number(l.id)) || 0)) }))
        .filter((x) => Number(x.loc.capacity || 0) > 0 && x.free + 0.001 >= need)
        .sort((x, y) => x.free - y.free);
      return cands.length ? { location: cands[0].loc, source: 'capacity' } : { blocked: `可售库位剩余容量不足 ${need} 件` };
    })();
    if (loc.blocked) {
      skipped.push({ hold_no: h.hold_no, reason: loc.blocked });
      return;
    }
    alloc.set(Number(loc.location.id), r2((alloc.get(Number(loc.location.id)) || 0) + need));
    picked.push({ hold: h, need, loc: loc.location, source: loc.source });
  });

  if (!picked.length) {
    const why = skipped.map((s) => `${s.hold_no}：${s.reason}`).join('；');
    throw new Error(`没有可进波次的占用。${why}`);
  }

  const t = now();
  const no = nextNo('PW', 'pick_waves', 'wave_no');
  const qtyTotal = r2(picked.reduce((x, p) => x + p.need, 0));
  const info = db.prepare(`INSERT INTO pick_waves
    (wave_no,company_id,warehouse,strategy,item_cnt,qty_total,qty_picked,status,note,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,0,'draft',?,?,?,?)`).run(
    no, Number(b.company_id) || 1, warehouse, b.strategy || 'zone', picked.length, qtyTotal,
    b.note || null, me(op), t, t
  );
  const waveId = Number(info.lastInsertRowid);
  picked
    .sort((a, c) => String(a.loc.code).localeCompare(String(c.loc.code)))
    .forEach((p, idx) => {
      db.prepare(`INSERT INTO pick_wave_items
        (wave_id,hold_id,order_id,customer_id,customer_name,location_id,loc_code,loc_source,
         style_no,color,size,sku,qty,seq,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(
        waveId, p.hold.id, p.hold.order_id || null, p.hold.customer_id || null, p.hold.customer_name || null,
        p.loc.id, p.loc.code, p.source, p.hold.style_no, p.hold.color || null, p.hold.size || null,
        p.hold.sku || skuKey(p.hold.style_no, p.hold.color, p.hold.size), p.need, idx + 1, t
      );
    });
  return { wave: getWave(waveId), skipped };
}

function releaseWave(id, op) {
  const w = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(Number(id));
  if (!w) throw new Error('波次不存在');
  if (w.status !== 'draft') throw new Error(`当前是「${WAVE_STATUS[w.status]}」，只有草稿能释放`);
  if (!w.item_cnt) throw new Error('空波次不能释放');
  db.prepare("UPDATE pick_waves SET status='released', released_at=?, updated_at=? WHERE id=?").run(now(), now(), w.id);
  return getWave(w.id);
}

function pickItem(waveId, itemId, b, op) {
  const w = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(Number(waveId));
  if (!w) throw new Error('波次不存在');
  if (!['released', 'picking'].includes(w.status)) throw new Error(`波次当前是「${WAVE_STATUS[w.status]}」，不能拣货`);
  const it = db.prepare('SELECT * FROM pick_wave_items WHERE id=? AND wave_id=?').get(Number(itemId), w.id);
  if (!it) throw new Error('波次明细不存在');
  if (it.status !== 'pending') throw new Error(`这一行是「${ITEM_STATUS[it.status]}」，不能再拣`);
  const qty = Number(b.qty === undefined ? it.qty : b.qty);
  if (!(qty > 0)) throw new Error('拣货数量必须大于 0');
  if (qty > Number(it.qty) + 0.001) throw new Error(`拣货数量不能超过预留 ${it.qty}`);
  if (b.location_code) {
    const loc = db.prepare('SELECT * FROM wh_locations WHERE warehouse=? AND code=?').get(w.warehouse, String(b.location_code));
    if (!loc) throw new Error(`库位 ${b.location_code} 不存在`);
    if (loc.status !== 'active') throw new Error(`库位 ${loc.code} 已锁定，不能拣货`);
    if (loc.zone !== 'sellable') throw new Error(`库位 ${loc.code} 不是可售区，不能拣货`);
    db.prepare('UPDATE pick_wave_items SET location_id=?, loc_code=?, loc_source=? WHERE id=?')
      .run(loc.id, loc.code, 'manual', it.id);
  }
  const t = now();
  db.prepare("UPDATE pick_wave_items SET qty_picked=?, status='picked', picked_by=?, picked_at=? WHERE id=?")
    .run(r2(qty), me(op), t, it.id);
  const sum = db.prepare('SELECT COALESCE(SUM(qty_picked),0) q FROM pick_wave_items WHERE wave_id=?').get(w.id).q;
  db.prepare("UPDATE pick_waves SET status='picking', qty_picked=?, updated_at=? WHERE id=?")
    .run(r2(sum), t, w.id);
  return getWave(w.id);
}

/**
 * 复核：必须称重、必须有唯一运单号；有短拣必须写原因。
 * 短拣只记差异，不改预留数量 —— 预留怎么收口由交承运时处理。
 */
function packWave(id, b, op) {
  const w = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(Number(id));
  if (!w) throw new Error('波次不存在');
  if (!['released', 'picking'].includes(w.status)) throw new Error(`波次当前是「${WAVE_STATUS[w.status]}」，不能复核`);
  const items = db.prepare('SELECT * FROM pick_wave_items WHERE wave_id=?').all(w.id);
  if (!items.some((i) => Number(i.qty_picked) > 0)) throw new Error('还没拣任何货，不能复核');
  const shortfall = r2(items.reduce((x, i) => x + (Number(i.qty) - Number(i.qty_picked)), 0));
  if (shortfall > 0 && !String(b.short_reason || '').trim()) {
    throw new Error(`有 ${shortfall} 件短拣，必须写原因（短拣不能悄悄过）`);
  }
  const weight = Number(b.weight);
  if (!(weight > 0)) throw new Error('复核必须称重（重量需大于 0）');
  const tracking = String(b.tracking_no || '').trim();
  if (!tracking) throw new Error('复核必须填运单号（打印面单不等于交承运，但包裹要有唯一运单）');
  const dup = db.prepare('SELECT * FROM pick_waves WHERE tracking_no=? AND id<>?').get(tracking, w.id);
  if (dup) throw new Error(`运单号 ${tracking} 已被波次 ${dup.wave_no} 使用（一单只能贴一个包裹）`);

  const t = now();
  db.exec('BEGIN');
  try {
    items.forEach((i) => {
      const short = r2(Number(i.qty) - Number(i.qty_picked));
      db.prepare('UPDATE pick_wave_items SET qty_short=?, short_reason=?, status=? WHERE id=?')
        .run(short, short > 0 ? (b.short_reason || null) : null, Number(i.qty_picked) > 0 ? 'picked' : 'short', i.id);
    });
    db.prepare(`UPDATE pick_waves SET status='packed', carrier=?, tracking_no=?, package_weight=?,
      short_reason=?, packed_at=?, updated_at=? WHERE id=?`).run(
      b.carrier || w.carrier || null, tracking, r2(weight), shortfall > 0 ? b.short_reason : null, t, t, w.id
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getWave(w.id);
}

/** 交承运：这一刻才扣库存、写流水、收口占用 */
function shipWave(id, op) {
  const w = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(Number(id));
  if (!w) throw new Error('波次不存在');
  if (w.status !== 'packed') throw new Error(`波次当前是「${WAVE_STATUS[w.status]}」，只有已复核的才能交承运`);
  const items = db.prepare('SELECT * FROM pick_wave_items WHERE wave_id=?').all(w.id)
    .filter((i) => Number(i.qty_picked) > 0);
  if (!items.length) throw new Error('这个波次没有可发的实物');

  // 先校验实物够（校验放在事务前：事务里 return 不会回滚，这个坑踩过）
  const need = new Map();
  items.forEach((i) => {
    const k = skuKey(i.style_no, i.color, i.size);
    need.set(k, r2((need.get(k) || 0) + Number(i.qty_picked)));
  });
  need.forEach((q, k) => {
    const [sn, c, s] = k.split('|');
    const have = onHand(w.warehouse, sn, c, s);
    if (have + 0.001 < q) throw new Error(`现货不足：${sn} ${c}/${s} 需要 ${q}，实物 ${have}`);
  });

  const t = now();
  db.exec('BEGIN');
  try {
    items.forEach((i) => {
      applyStock({ warehouse: w.warehouse, style_no: i.style_no, product_name: null, color: i.color, size: i.size, delta: -Number(i.qty_picked) });
      addLedger({
        warehouse: w.warehouse, style_no: i.style_no, product_name: null, color: i.color, size: i.size,
        type: 'out', qty: Number(i.qty_picked), ref_type: 'pick_wave', ref_id: w.id,
        remark: `波次发运 ${w.wave_no}${w.tracking_no ? ' · ' + w.tracking_no : ''}`, operator: me(op)
      });
      if (i.hold_id) {
        const h = db.prepare('SELECT * FROM stock_holds WHERE id=?').get(i.hold_id);
        if (h && h.status === 'active') {
          db.prepare(`UPDATE stock_holds SET status='released', release_reason=?, released_by=?, released_at=?,
            qty_picked=COALESCE(qty_picked,0)+?, updated_at=? WHERE id=?`).run(
            `已随波次 ${w.wave_no} 发运${Number(i.qty_short) > 0 ? `（短拣 ${i.qty_short}）` : ''}`,
            me(op), t, Number(i.qty_picked), t, h.id
          );
        }
      }
    });
    db.prepare("UPDATE pick_waves SET status='shipped', shipped_at=?, updated_at=? WHERE id=?").run(t, t, w.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getWave(w.id);
}

function cancelWave(id, b, op) {
  const w = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(Number(id));
  if (!w) throw new Error('波次不存在');
  if (w.status === 'shipped') throw new Error('已交承运的波次不能取消，只能走退货');
  if (w.status === 'cancelled') throw new Error('波次已经取消过了');
  if (!String(b.reason || '').trim()) throw new Error('取消波次必须写原因');
  const items = db.prepare('SELECT * FROM pick_wave_items WHERE wave_id=?').all(w.id);
  const pickedQty = r2(items.reduce((x, i) => x + Number(i.qty_picked || 0), 0));
  if (pickedQty > 0 && !b.confirm_return) {
    throw new Error(`已经拣了 ${pickedQty} 件，取消前必须确认实物回位（否则放量会超卖）`);
  }
  const t = now();
  db.exec('BEGIN');
  try {
    items.forEach((i) => {
      db.prepare("UPDATE pick_wave_items SET status='cancelled' WHERE id=?").run(i.id);
      if (!i.hold_id) return;
      const h = db.prepare('SELECT * FROM stock_holds WHERE id=?').get(i.hold_id);
      if (h && h.status === 'active') {
        db.prepare(`UPDATE stock_holds SET status='released', release_reason=?, released_by=?, released_at=?, updated_at=? WHERE id=?`)
          .run(`波次 ${w.wave_no} 取消：${b.reason}`, me(op), t, t, h.id);
      }
    });
    db.prepare("UPDATE pick_waves SET status='cancelled', cancel_reason=?, cancelled_at=?, updated_at=? WHERE id=?")
      .run(b.reason, t, t, w.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getWave(w.id);
}

function deleteWave(id, op) {
  const w = db.prepare('SELECT * FROM pick_waves WHERE id=?').get(Number(id));
  if (!w) throw new Error('波次不存在');
  if (w.status !== 'draft') throw new Error('只有草稿波次能删；已释放的请走取消（要留痕）');
  db.prepare('DELETE FROM pick_wave_items WHERE wave_id=?').run(w.id);
  db.prepare('DELETE FROM pick_waves WHERE id=?').run(w.id);
  return { deleted: 1, wave_no: w.wave_no, by: me(op) };
}

/** ==================== 头程在途 ==================== */

function impactedDemand(asn) {
  const styles = db.prepare('SELECT DISTINCT style_no FROM wh_asn_items WHERE asn_id=?').all(asn.id)
    .map((x) => x.style_no).filter(Boolean);
  if (!styles.length) return { holds: [], requests: [], cnt: 0 };
  const ph = styles.map(() => '?').join(',');
  const holds = db.prepare(`SELECT h.hold_no,h.qty,h.customer_name,h.style_no,h.color,h.size
    FROM stock_holds h WHERE h.status='active' AND h.warehouse=? AND h.style_no IN (${ph})`)
    .all(asn.warehouse, ...styles);
  const requests = db.prepare(`SELECT r.request_no,r.qty,r.customer_name,r.style_no,r.status
    FROM booking_requests r WHERE r.status IN ('submitted','sales_confirmed') AND r.style_no IN (${ph})`)
    .all(...styles);
  return { holds, requests, cnt: holds.length + requests.length };
}

function listAsns(q = {}) {
  let rows = db.prepare('SELECT * FROM wh_asns ORDER BY id DESC').all();
  if (q.warehouse) rows = rows.filter((r) => r.warehouse === q.warehouse);
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.q) rows = rows.filter((r) => String(r.asn_no).includes(q.q) || String(r.container_no || '').includes(q.q));
  return rows.map((r) => {
    const legs = db.prepare('SELECT * FROM wh_asn_legs WHERE asn_id=? ORDER BY seq').all(r.id);
    const arrived = legs.filter((l) => l.status === 'arrived').length;
    const eta = legs.length ? legs[legs.length - 1].eta : r.eta_date;
    const boxes = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(short_qty),0) s, COALESCE(SUM(over_qty),0) o, COALESCE(SUM(damaged_qty),0) d FROM wh_asn_boxes WHERE asn_id=?').get(r.id);
    const left = eta ? daysBetween(today(), eta) : null;
    return {
      ...r,
      leg_cnt: legs.length,
      leg_arrived: arrived,
      eta_effective: eta || null,
      days_left: left,
      delayed: r.status === 'in_transit' && left !== null && left < 0,
      due_soon: r.status === 'in_transit' && left !== null && left >= 0 && left <= 3,
      box_cnt: Number(boxes.c || 0),
      short_qty_box: r2(boxes.s), over_qty_box: r2(boxes.o), damaged_qty_box: r2(boxes.d)
    };
  });
}

function getAsn(id) {
  const a = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(Number(id));
  if (!a) throw new Error('头程单不存在');
  const legs = db.prepare('SELECT * FROM wh_asn_legs WHERE asn_id=? ORDER BY seq').all(a.id)
    .map((l) => ({ ...l, status_label: LEG_STATUS[l.status] || l.status, mode_label: MODE_LABEL[l.mode] || l.mode }));
  const boxes = db.prepare('SELECT * FROM wh_asn_boxes WHERE asn_id=? ORDER BY carton_no').all(a.id);
  const changes = db.prepare('SELECT * FROM wh_asn_changes WHERE asn_id=? ORDER BY id DESC').all(a.id);
  const items = db.prepare('SELECT * FROM wh_asn_items WHERE asn_id=?').all(a.id);
  return {
    ...a,
    items, legs, boxes, changes,
    impacted: impactedDemand(a),
    note: '段与箱只登记运输事实，不改库存；收货上架走「海外仓作业」'
  };
}

function addLeg(asnId, b, op) {
  const a = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(Number(asnId));
  if (!a) throw new Error('头程单不存在');
  const etd = String(b.etd || '').slice(0, 10);
  const eta = String(b.eta || '').slice(0, 10);
  if (!etd || !eta) throw new Error('运输段必须填预计离港与预计到港');
  if (eta < etd) throw new Error('预计到港不能早于预计离港');
  const seq = Number(db.prepare('SELECT COALESCE(MAX(seq),0) m FROM wh_asn_legs WHERE asn_id=?').get(a.id).m) + 1;
  if (seq > 1) {
    const prev = db.prepare('SELECT * FROM wh_asn_legs WHERE asn_id=? ORDER BY seq DESC LIMIT 1').get(a.id);
    if (prev && prev.eta && etd < prev.eta) throw new Error(`第 ${seq} 段离港 ${etd} 早于上一段到港 ${prev.eta}`);
  }
  const info = db.prepare(`INSERT INTO wh_asn_legs (asn_id,seq,mode,carrier,etd,eta,status,note,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    a.id, seq, b.mode || 'ocean', b.carrier || a.carrier || null, etd, eta, 'planned', b.note || null, now()
  );
  // ASN 的 ETA 跟着最后一段走（口径统一：对外只认最终段）
  db.prepare('UPDATE wh_asns SET eta_date=?, updated_at=? WHERE id=?').run(eta, now(), a.id);
  return getAsn(a.id).legs.find((l) => Number(l.id) === Number(info.lastInsertRowid));
}

function arriveLeg(legId, b, op) {
  const leg = db.prepare('SELECT * FROM wh_asn_legs WHERE id=?').get(Number(legId));
  if (!leg) throw new Error('运输段不存在');
  if (leg.status === 'arrived') return { ...leg, status_label: LEG_STATUS.arrived };
  const prev = db.prepare('SELECT * FROM wh_asn_legs WHERE asn_id=? AND seq<? ORDER BY seq').all(leg.asn_id, leg.seq);
  const notArrived = prev.filter((p) => p.status !== 'arrived');
  if (notArrived.length) throw new Error(`上一段（第 ${notArrived[0].seq} 段）还没到，不能跳段`);
  const at = String(b.actual_at || today()).slice(0, 10);
  if (leg.etd && at < leg.etd) throw new Error(`实际到达 ${at} 早于本段离港 ${leg.etd}`);
  db.prepare("UPDATE wh_asn_legs SET status='arrived', actual_at=? WHERE id=?").run(at, leg.id);
  return db.prepare('SELECT * FROM wh_asn_legs WHERE id=?').get(leg.id);
}

function addBox(asnId, b, op) {
  const a = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(Number(asnId));
  if (!a) throw new Error('头程单不存在');
  const carton = String(b.carton_no || '').trim();
  if (!carton) throw new Error('必须填箱号');
  const expect = Number(b.expect_qty || 0);
  const received = Number(b.received_qty || 0);
  const short = Number(b.short_qty || 0);
  const over = Number(b.over_qty || 0);
  const damaged = Number(b.damaged_qty || 0);
  if (expect < 0 || received < 0 || short < 0 || over < 0 || damaged < 0) throw new Error('数量不能为负');
  // 数量守恒：实收 = 应到 − 短少 + 多到 − 破损
  const calc = r2(expect - short + over - damaged);
  if (Math.abs(calc - received) > 0.001) {
    throw new Error(`数量对不上：应到 ${expect} − 短少 ${short} + 多到 ${over} − 破损 ${damaged} = ${calc}，与实收 ${received} 不一致`);
  }
  if ((short > 0 || over > 0 || damaged > 0) && !String(b.reason || '').trim()) {
    throw new Error('有短少/多到/破损必须写原因');
  }
  const t = now();
  const cur = db.prepare('SELECT * FROM wh_asn_boxes WHERE asn_id=? AND carton_no=?').get(a.id, carton);
  if (cur) {
    db.prepare(`UPDATE wh_asn_boxes SET style_no=?,expect_qty=?,received_qty=?,short_qty=?,over_qty=?,damaged_qty=?,
      reason=?,checked_by=?,checked_at=? WHERE id=?`).run(
      b.style_no || cur.style_no, expect, received, short, over, damaged, b.reason || null, me(op), t, cur.id
    );
    return db.prepare('SELECT * FROM wh_asn_boxes WHERE id=?').get(cur.id);
  }
  const info = db.prepare(`INSERT INTO wh_asn_boxes
    (asn_id,carton_no,style_no,expect_qty,received_qty,short_qty,over_qty,damaged_qty,reason,checked_by,checked_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    a.id, carton, b.style_no || null, expect, received, short, over, damaged, b.reason || null, me(op), t, t
  );
  return db.prepare('SELECT * FROM wh_asn_boxes WHERE id=?').get(info.lastInsertRowid);
}

/** 改 ETA：必须写原因；算出受影响需求（只提示，不自动改承诺） */
function changeEta(asnId, b, op) {
  const a = db.prepare('SELECT * FROM wh_asns WHERE id=?').get(Number(asnId));
  if (!a) throw new Error('头程单不存在');
  const eta = String(b.eta_date || '').slice(0, 10);
  if (!eta) throw new Error('必须填新的预计到仓日');
  if (a.ship_date && eta < a.ship_date) throw new Error('预计到仓不能早于发运日');
  if (!String(b.reason || '').trim()) throw new Error('改预计到仓必须写原因');
  if (eta === a.eta_date) throw new Error('新旧日期一样，不用改');
  const imp = impactedDemand(a);
  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE wh_asns SET eta_date=?, updated_at=? WHERE id=?').run(eta, t, a.id);
    // 最后一段的 ETA 同步，否则列表与段两处口径不一致
    const last = db.prepare('SELECT * FROM wh_asn_legs WHERE asn_id=? ORDER BY seq DESC LIMIT 1').get(a.id);
    if (last) db.prepare('UPDATE wh_asn_legs SET eta=? WHERE id=?').run(eta, last.id);
    db.prepare(`INSERT INTO wh_asn_changes (asn_id,field,from_value,to_value,impacted_cnt,reason,operator,created_at)
      VALUES (?,'eta_date',?,?,?,?,?,?)`).run(a.id, a.eta_date, eta, imp.cnt, b.reason, me(op), t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { asn: getAsn(a.id), impacted_cnt: imp.cnt };
}

/** ==================== 库容规划 ==================== */

function listCapacity(q = {}) {
  let locs = db.prepare('SELECT * FROM wh_locations ORDER BY warehouse, code').all();
  if (q.warehouse) locs = locs.filter((l) => l.warehouse === q.warehouse);
  if (q.zone) locs = locs.filter((l) => l.zone === q.zone);
  const used = locUsed();
  const rows = locs.map((l) => {
    const cap = Number(l.capacity || 0);
    const u = r2(used.get(Number(l.id)) || 0);
    return {
      ...l,
      used: u,
      free: r2(cap - u),
      pct: cap > 0 ? Math.round((u / cap) * 1000) / 10 : null,
      anomaly: cap > 0 && u > cap + 0.001,
      near_full: cap > 0 && u / cap >= 0.9 && u <= cap + 0.001,
      sku_cnt: db.prepare(`SELECT COUNT(DISTINCT COALESCE(style_no,'')||'/'||COALESCE(color,'')||'/'||COALESCE(size,''))
        FROM wh_putaways WHERE location_id=?`).get(l.id).c
    };
  });
  if (q.near_full) return rows.filter((r) => r.near_full || r.anomaly);
  return rows.sort((a, b) => (b.pct || 0) - (a.pct || 0));
}

/** 上架建议：优先能放下的最小空间（省大库位），放不下就明确拒绝 */
function suggestCapacity(b) {
  const warehouse = b.warehouse || 'us';
  const qty = Number(b.qty || 0);
  if (!(qty > 0)) throw new Error('必须填要上架的数量');
  const zone = b.zone || 'sellable';
  const used = locUsed();
  const cands = db.prepare("SELECT * FROM wh_locations WHERE warehouse=? AND status='active' AND zone=?")
    .all(warehouse, zone)
    .map((l) => {
      const cap = Number(l.capacity || 0);
      const u = used.get(Number(l.id)) || 0;
      return { loc: l, cap, used: r2(u), free: r2(cap - u) };
    })
    .filter((x) => x.cap > 0 && x.free + 0.001 >= qty)
    .sort((a, c) => a.free - c.free);
  if (!cands.length) {
    const totalFree = r2(db.prepare("SELECT * FROM wh_locations WHERE warehouse=? AND status='active' AND zone=?")
      .all(warehouse, zone).reduce((x, l) => x + Math.max(0, Number(l.capacity || 0) - (used.get(Number(l.id)) || 0)), 0));
    return { blocked: true, reason: `${zone} 区没有单个库位放得下 ${qty} 件（全区剩余 ${totalFree} 件，但分散在各库位）`, total_free: totalFree };
  }
  return { blocked: false, location: cands[0].loc, free: cands[0].free, candidates: cands.slice(0, 5) };
}

module.exports = {
  WAVE_STATUS, ITEM_STATUS,
  dict, overview,
  listWaves, getWave, listCandidates, createWave, releaseWave, pickItem, packWave, shipWave, cancelWave, deleteWave,
  listAsns, getAsn, addLeg, arriveLeg, addBox, changeEta, impactedDemand,
  listCapacity, suggestCapacity, allocLoc: allocateLocation, locUsed
};
