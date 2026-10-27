/**
 * 供给批次与预订服务（原型 M23）
 * ============================================================
 * 六个节点：库存与在途统一口径 / 未来供给可预订量 / 预订申请与销售确认 /
 *           占用到期与取消释放 / 批次迁移与短装 / 数量对账与可售刷新
 *
 * 六条不能松的口径（每条都对应原型里一句明确规则）：
 *
 * 1. **可买量 = 合格已上架实物 − 有效现货占用**
 *    `已拣` 是占用的子集，只能在页面上标出来，不能再扣一次。
 *
 * 2. **现货与未来供给不得重复计数**
 *    已上架的批次，其未来可订量按 0 算 —— 那批货已经进了现货口径，
 *    再加一遍就是同一批货卖两次。
 *
 * 3. **申请不占量，销售确认才占**
 *    客户提交申请只是意向；只有授权销售确认后，才按 SKU × 供给批次建立占用。
 *    确认用「版本 + 幂等键 + 原子数量条件」执行：重试不会生成第二张，超量一定失败。
 *
 * 4. **占用迁移优先于释放**
 *    临时占用转正式订单时，把原占用标 `converted` 并挂订单，
 *    **不先释放再抢量** —— 否则中间那一刻会被别人抢走。
 *    到期释放必须先确认「它还是那条临时占用」（状态 + 版本），
 *    已拣的要先做实物回位确认，已发货的只能走退货。
 *
 * 5. **批次迁移数量守恒，占用随批次走**
 *    在产 → 待发 → 在途 → 实收 → 上架，每步迁移量不能超过上一步剩余量；
 *    迁移时批次上的有效占用不新增、不丢失，数量对得上。
 *    部分到货拆子批；短装保留承诺、形成缺口、人工评估替代，不隐瞒也不超售。
 *
 * 6. **ERP 库存事件是唯一账源**
 *    投影只存结果，事件带幂等键；重复事件不会重复加减。
 *    数据陈旧（超过 STALE_MIN 分钟）在页面上标出来，销售确认时强制重算。
 *
 * 时间口径：本地墙钟字符串（services/sla.js）。
 */
const { db } = require('../db');
const { localNow, localDate } = require('./sla');

/** ==================== 基础 ==================== */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const now = () => localNow();
const today = () => localDate();
/** 投影多久算陈旧（分钟）：超过就要在确认预订时强制重算 */
const STALE_MIN = 30;

function addHours(ts, h) {
  const d = new Date(String(ts).replace(' ', 'T'));
  d.setHours(d.getHours() + Number(h || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const t = new Date(y, m - 1, d);
  t.setDate(t.getDate() + Number(n || 0));
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function nextNo(prefix, table, col) {
  const d = localDate().replace(/-/g, '');
  const head = `${prefix}${d}`;
  const rows = db.prepare(`SELECT ${col} n FROM ${table} WHERE ${col} LIKE ?`).all(`${head}%`);
  let max = 0;
  rows.forEach((r) => {
    const v = Number(String(r.n).slice(head.length));
    if (Number.isFinite(v) && v > max) max = v;
  });
  return `${head}${String(max + 1).padStart(4, '0')}`;
}
const me = (op) => (op ? (typeof op === 'string' ? op : (op.name || op.username || 'system')) : 'system');
const skuOf = (o) => [o.style_no, o.color || '-', o.size || '-'].join('/');
const scopeKey = (w, s, c, z) => [w, s, c || '', z || ''].join('|');

/** ==================== 字典 ==================== */

const STAGE = ['in_production', 'ready_to_ship', 'in_transit', 'received_checked', 'on_shelf'];
const STAGE_LABEL = {
  in_production: '在产', ready_to_ship: '待发', in_transit: '在途',
  received_checked: '实收检验', on_shelf: '已上架', short: '短装', closed: '已关闭', cancelled: '已取消'
};
const NEXT_STAGE = {
  in_production: 'ready_to_ship', ready_to_ship: 'in_transit',
  in_transit: 'received_checked', received_checked: 'on_shelf'
};
const HOLD_KIND_LABEL = { spot: '现货占用', future: '未来供给占用' };
const HOLD_STATUS_LABEL = {
  active: '占用中', expired: '已到期', released: '已释放', converted: '已转订单'
};
const REQ_STATUS_LABEL = {
  submitted: '待销售确认', sales_confirmed: '已确认', rejected: '已驳回',
  cancelled: '已取消', expired: '已过期', converted: '已转订单'
};
const SHORT_RES_LABEL = {
  open: '待处理', substitute: '换替代批次', delay: '延期交付',
  cancel: '取消占用', written_off: '客户接受短装'
};

function dict() {
  return {
    warehouses: [{ k: 'us', v: '美国仓' }, { k: 'cn', v: '国内仓' }],
    stage: STAGE.concat(['short', 'closed']).map((k) => ({ k, v: STAGE_LABEL[k] })),
    hold_kind: Object.entries(HOLD_KIND_LABEL).map(([k, v]) => ({ k, v })),
    hold_status: Object.entries(HOLD_STATUS_LABEL).map(([k, v]) => ({ k, v })),
    req_status: Object.entries(REQ_STATUS_LABEL).map(([k, v]) => ({ k, v })),
    short_res: Object.entries(SHORT_RES_LABEL).map(([k, v]) => ({ k, v })),
    today: today(),
    stale_min: STALE_MIN
  };
}

/** ==================== 可售口径 ==================== */

/** 有效现货占用（未到期、未释放、未转订单） */
function activeSpotHeld(warehouse, style, color, size) {
  return r2(db.prepare(`SELECT COALESCE(SUM(qty),0) s, COALESCE(SUM(qty_picked),0) p FROM stock_holds
    WHERE status='active' AND kind='spot' AND warehouse=? AND style_no=?
      AND COALESCE(color,'')=COALESCE(?,'') AND COALESCE(size,'')=COALESCE(?,'')
      AND (expires_at IS NULL OR expires_at > ?)`).get(warehouse, style, color, size, now()).s
  + 0);
}
function activeSpotPicked(warehouse, style, color, size) {
  return r2(db.prepare(`SELECT COALESCE(SUM(qty_picked),0) p FROM stock_holds
    WHERE status='active' AND kind='spot' AND warehouse=? AND style_no=?
      AND COALESCE(color,'')=COALESCE(?,'') AND COALESCE(size,'')=COALESCE(?,'')
      AND (expires_at IS NULL OR expires_at > ?)`).get(warehouse, style, color, size, now()).p);
}

/** 某个 SKU 的现货可买量（现算，用于确认前校验） */
function spotSellable(warehouse, style, color, size) {
  const onHand = r2(db.prepare(`SELECT COALESCE(SUM(qty),0) q FROM stock_items
    WHERE warehouse=? AND style_no=? AND COALESCE(color,'')=COALESCE(?,'') AND COALESCE(size,'')=COALESCE(?,'')`)
    .get(warehouse, style, color, size).q);
  const held = activeSpotHeld(warehouse, style, color, size);
  return { on_hand: onHand, held_spot: held, sellable: r2(onHand - held) };
}

/**
 * 期货可订量：只有「叶子批次」参与（有子批的父批已被拆走，不能再算一遍）。
 * 已上架的批次未来可订 = 0 —— 那批货已经进了现货口径。
 */
function isLeaf(batchId) {
  return db.prepare("SELECT COUNT(*) c FROM supply_batches WHERE parent_batch_id=? AND status='active'").get(Number(batchId)).c === 0;
}

/** 阶段「手上数量」：迁移、拆分、短装的容量口径（实收阶段 = 未检 + 已检） */
function stageQty(b) {
  if (b.stage === 'in_production') return Number(b.qty_produced || b.qty_planned || 0);
  if (b.stage === 'ready_to_ship') return Number(b.qty_ready || 0);
  if (b.stage === 'in_transit') return Number(b.qty_in_transit || 0);
  if (b.stage === 'received_checked') return r2(Number(b.qty_received || 0) + Number(b.qty_checked_ok || 0));
  if (b.stage === 'on_shelf') return 0;   // 已上架 → 归现货，不再算未来供给
  return 0;
}

/** 可承诺的基础量：**未检的不能承诺**（实收阶段只算检验合格的部分） */
function committableBase(b) {
  if (b.stage === 'received_checked') return Number(b.qty_checked_ok || 0);
  return stageQty(b);
}

/** 批次可承诺净量 = 可承诺基础量 − 短装 − 风险缓冲 − 冻结 */
function batchCommittable(b) {
  return r2(Math.max(0, committableBase(b) - Number(b.qty_short || 0) - Number(b.risk_buffer || 0) - Number(b.frozen_qty || 0)));
}
/** 批次已被未来预订占用多少 */
function batchHeld(batchId) {
  return r2(db.prepare(`SELECT COALESCE(SUM(qty),0) s FROM stock_holds
    WHERE status='active' AND kind='future' AND batch_id=?
      AND (expires_at IS NULL OR expires_at > ?)`).get(Number(batchId), now()).s);
}
function batchAvailable(b) {
  if (!b || b.status !== 'active') return 0;
  if (!isLeaf(b.id)) return 0;
  return r2(Math.max(0, batchCommittable(b) - batchHeld(b.id)));
}

/** 某个 SKU 的未来可订量（叶子批次合计） */
function futureAvailableOf(warehouse, style, color, size) {
  const rows = db.prepare(`SELECT * FROM supply_batches
    WHERE status='active' AND warehouse=? AND style_no=?
      AND COALESCE(color,'')=COALESCE(?,'') AND COALESCE(size,'')=COALESCE(?,'')`)
    .all(warehouse, style, color, size);
  return r2(rows.reduce((s, b) => s + batchAvailable(b), 0));
}

/** ==================== 投影 ==================== */

function getProj(warehouse, style, color, size) {
  return db.prepare(`SELECT * FROM sellable_projection
    WHERE warehouse=? AND style_no=? AND COALESCE(color,'')=COALESCE(?,'') AND COALESCE(size,'')=COALESCE(?,'')`)
    .get(warehouse, style, color, size);
}

/** 重算单个 SKU 的投影（幂等：算几遍结果一样，版本递增只表示刷新过） */
function computeOne(warehouse, style, color, size) {
  const spot = spotSellable(warehouse, style, color, size);
  const picked = activeSpotPicked(warehouse, style, color, size);
  const future = futureAvailableOf(warehouse, style, color, size);
  const old = getProj(warehouse, style, color, size);
  const anomaly = spot.sellable < 0
    ? `可买量为负（${spot.sellable}）：占用 ${spot.held_spot} 超过实物 ${spot.on_hand}，禁止新增占用，请先核库存`
    : null;
  if (old) {
    db.prepare(`UPDATE sellable_projection SET on_hand=?, held_spot=?, qty_picked=?, sellable=?,
      future_available=?, version=version+1, computed_at=?, stale=0, anomaly=? WHERE id=?`).run(
      spot.on_hand, spot.held_spot, picked, spot.sellable, future, now(), anomaly, old.id
    );
  } else {
    db.prepare(`INSERT INTO sellable_projection
      (warehouse,style_no,color,size,sku,on_hand,held_spot,qty_picked,sellable,future_available,version,computed_at,stale,anomaly)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?,0,?)`).run(
      warehouse, style, color, size, skuOf({ style_no: style, color, size }),
      spot.on_hand, spot.held_spot, picked, spot.sellable, future, now(), anomaly
    );
  }
  return getProj(warehouse, style, color, size);
}

/** 全量/按仓重算投影 */
function refreshProjection(op, warehouse) {
  const keys = new Map();
  const push = (w, s, c, z) => keys.set(scopeKey(w, s, c, z), { w, s, c, z });
  db.prepare(`SELECT DISTINCT warehouse, style_no, COALESCE(color,'') color, COALESCE(size,'') size FROM stock_items`).all()
    .forEach((r) => push(r.warehouse, r.style_no, r.color, r.size));
  db.prepare(`SELECT DISTINCT warehouse, style_no, COALESCE(color,'') color, COALESCE(size,'') size FROM supply_batches WHERE status='active'`).all()
    .forEach((r) => push(r.warehouse, r.style_no, r.color, r.size));
  let n = 0;
  keys.forEach((k) => {
    if (warehouse && k.w !== warehouse) return;
    computeOne(k.w, k.s, k.c, k.z);
    n += 1;
  });
  return { refreshed: n, by: me(op), at: now() };
}

/** 标记某个 SKU 的投影陈旧（占用/批次变动时调用，等到重算再转 fresh） */
function markStale(warehouse, style, color, size) {
  db.prepare(`UPDATE sellable_projection SET stale=1
    WHERE warehouse=? AND style_no=? AND COALESCE(color,'')=COALESCE(?,'') AND COALESCE(size,'')=COALESCE(?,'')`)
    .run(warehouse, style, color, size);
}

/** 投影是否陈旧（超时或显式标记） */
function isStale(p) {
  if (!p) return true;
  if (p.stale) return true;
  const t = new Date(String(p.computed_at).replace(' ', 'T')).getTime();
  return Date.now() - t > STALE_MIN * 60 * 1000;
}

/** 记录投影事件（幂等键重复则跳过，返回 skipped） */
function logEvent(key, scope, deltaOnHand, deltaHold, reason, op) {
  try {
    db.prepare(`INSERT INTO projection_events (event_key,scope_key,delta_on_hand,delta_hold,reason,operator,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(key, scope, r2(deltaOnHand), r2(deltaHold), reason || null, me(op), now());
    return { saved: 1 };
  } catch (e) {
    // event_key 唯一：同一次变更重试不会重复记账
    return { saved: 0, skipped: true, event_key: key };
  }
}

function listProjection(q = {}) {
  let rows = db.prepare('SELECT * FROM sellable_projection ORDER BY warehouse, style_no, color, size').all();
  if (q.warehouse) rows = rows.filter((r) => r.warehouse === q.warehouse);
  if (q.q) rows = rows.filter((r) => String(r.style_no).includes(q.q) || String(r.sku).includes(q.q));
  if (String(q.anomaly) === '1') rows = rows.filter((r) => !!r.anomaly);
  return rows.map((r) => ({
    ...r,
    warehouse_label: r.warehouse === 'us' ? '美国仓' : '国内仓',
    stale: isStale(r) ? 1 : 0,
    // 已拣只是展示：它是占用的子集，不能再从可买量里扣一次
    note: r.qty_picked > 0 ? `其中已拣 ${r.qty_picked}（已含在占用里，不重复扣）` : null
  }));
}

/** ==================== 供给批次 ==================== */

function decorateBatch(b) {
  const committable = batchCommittable(b);
  const held = batchHeld(b.id);
  const children = db.prepare('SELECT id, batch_no, qty_planned, stage FROM supply_batches WHERE parent_batch_id=?').all(b.id);
  const holds = db.prepare(`SELECT * FROM stock_holds WHERE batch_id=? AND status='active'`).all(b.id);
  return {
    ...b,
    stage_label: STAGE_LABEL[b.stage] || b.stage,
    sku: b.sku || skuOf(b),
    stage_qty: stageQty(b),
    committable,
    held_future: held,
    available: batchAvailable(b),
    is_leaf: isLeaf(b.id),
    children,
    hold_cnt: holds.length,
    next_stage: NEXT_STAGE[b.stage] || null,
    // 叶子批次才算未来供给；已上架的归现货
    excludes: !isLeaf(b.id) ? '有子批次，父批不再单独算可订量'
      : (b.stage === 'on_shelf' ? '已上架，归现货口径，未来可订按 0 算' : null)
  };
}

function listBatches(q = {}) {
  const where = [];
  const args = [];
  if (q.warehouse) { where.push('warehouse=?'); args.push(q.warehouse); }
  if (q.stage) { where.push('stage=?'); args.push(q.stage); }
  if (String(q.available) === '1') where.push("status='active'");
  if (q.q) { where.push('(style_no LIKE ? OR batch_no LIKE ? OR sku LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const rows = db.prepare(`SELECT * FROM supply_batches
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE stage WHEN 'in_production' THEN 0 WHEN 'ready_to_ship' THEN 1 WHEN 'in_transit' THEN 2
      WHEN 'received_checked' THEN 3 WHEN 'on_shelf' THEN 4 ELSE 5 END, eta_date, id`).all(...args);
  let out = rows.map(decorateBatch);
  if (String(q.available) === '1') out = out.filter((b) => b.available > 0);
  return out;
}

function getBatch(id) {
  const b = db.prepare('SELECT * FROM supply_batches WHERE id=?').get(Number(id));
  if (!b) throw new Error('供给批次不存在');
  const out = decorateBatch(b);
  out.moves = db.prepare('SELECT * FROM supply_batch_moves WHERE batch_id=? ORDER BY id DESC').all(b.id);
  out.holds = db.prepare('SELECT * FROM stock_holds WHERE batch_id=? ORDER BY id DESC').all(b.id)
    .map((h) => ({ ...h, status_label: HOLD_STATUS_LABEL[h.status] || h.status }));
  out.shortages = db.prepare('SELECT * FROM booking_shortages WHERE batch_id=? ORDER BY id DESC').all(b.id)
    .map((s) => ({ ...s, resolution_label: SHORT_RES_LABEL[s.resolution] || s.resolution }));
  out.parent = b.parent_batch_id
    ? db.prepare('SELECT id, batch_no, qty_planned, stage FROM supply_batches WHERE id=?').get(b.parent_batch_id) : null;
  return out;
}

function createBatch(b, op) {
  const no = b.batch_no || nextNo('SB', 'supply_batches', 'batch_no');
  if (!b.style_no) throw new Error('款号必填');
  const planned = Number(b.qty_planned || 0);
  if (!(planned > 0)) throw new Error('计划数量必须大于 0');
  if (db.prepare('SELECT id FROM supply_batches WHERE batch_no=?').get(no)) throw new Error(`批次号 ${no} 已存在`);
  const info = db.prepare(`INSERT INTO supply_batches
    (batch_no,company_id,owner_company_id,warehouse,style_no,product_name,color,size,sku,source_type,source_id,source_no,
     order_id,customer_id,qc_grade,intended_use,stage,
     qty_planned,qty_produced,qty_ready,qty_in_transit,qty_received,qty_checked_ok,qty_on_shelf,qty_short,risk_buffer,frozen_qty,
     eta_date,eta_evidence,eta_covered,status,note,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
     ?,?,0,0,0,0,0,0,?,0,
     ?,?,?,'active',?,?,?,?)`).run(
    no, Number(b.company_id) || 1, b.owner_company_id || Number(b.company_id) || 1,
    b.warehouse || 'us', b.style_no, b.product_name || null, b.color || null, b.size || null,
    skuOf({ style_no: b.style_no, color: b.color, size: b.size }),
    b.source_type || 'production', b.source_id || null, b.source_no || null,
    b.order_id || null, b.customer_id || null, b.qc_grade || 'A', b.intended_use || 'sellable',
    'in_production', planned, Number(b.qty_produced || 0), Number(b.risk_buffer || 0),
    b.eta_date || null, b.eta_evidence || null, b.eta_date && b.eta_evidence ? 1 : 0,
    b.note || null, me(op), now(), now()
  );
  db.prepare(`INSERT INTO supply_batch_moves (batch_id,from_stage,to_stage,qty,qty_before,qty_after,holds_carried,operator,note,created_at)
    VALUES (?,NULL,'in_production',?,0,?,0,?,?,?)`).run(
    info.lastInsertRowid, planned, planned, me(op), '建批次', now()
  );
  return getBatch(info.lastInsertRowid);
}

/**
 * 批次迁移：只能往前，迁移量不能超过当前阶段剩余量。
 * 迁移时批次上的有效占用随批次走（holds_carried 记条数），不新增、不释放。
 */
function moveBatch(id, b, op) {
  const cur = db.prepare('SELECT * FROM supply_batches WHERE id=?').get(Number(id));
  if (!cur) throw new Error('供给批次不存在');
  if (cur.status !== 'active') throw new Error('批次已关闭或取消，不能再迁移');
  const to = String(b.to_stage || NEXT_STAGE[cur.stage] || '');
  if (!to) throw new Error('这个阶段没有下一步了');
  const order = STAGE.indexOf(cur.stage);
  const nextOrder = STAGE.indexOf(to);
  if (nextOrder !== order + 1) throw new Error(`不能从「${STAGE_LABEL[cur.stage]}」跳到「${STAGE_LABEL[to] || to}」`);
  const capacity = stageQty(cur);
  const qty = b.qty === undefined || b.qty === null || b.qty === '' ? capacity : Number(b.qty);
  if (!(qty > 0)) throw new Error('迁移数量必须大于 0');
  if (qty > capacity + 0.001) throw new Error(`迁移数量 ${qty} 超过当前阶段剩余 ${capacity}`);
  if (to === 'ready_to_ship' && !cur.eta_date) throw new Error('进待发前必须填预计到仓时间（不然客户预订没有交期依据）');
  if (to === 'in_transit' && !cur.eta_evidence) throw new Error('进在途前必须填在途依据（船期/提单号/物流单）');

  const patch = { ready_to_ship: 'qty_ready', in_transit: 'qty_in_transit', received_checked: 'qty_received', on_shelf: 'qty_on_shelf' }[to];
  // 在产阶段手上是计划量（qty_produced 可能还没填），扣减要落在真正有数的列上
  const deduct = {
    ready_to_ship: Number(cur.qty_produced || 0) > 0 ? 'qty_produced' : 'qty_planned',
    in_transit: 'qty_ready',
    received_checked: 'qty_in_transit',
    // 上架只能搬「检验合格」的部分：未检的不许直接上架
    on_shelf: 'qty_checked_ok'
  }[to];
  if (!patch || !deduct) throw new Error('迁移阶段不合法');
  if (to === 'on_shelf' && Number(cur.qty_checked_ok || 0) + 0.001 < qty) {
    throw new Error(`只有检验合格的数量能上架：当前合格 ${cur.qty_checked_ok || 0}，待上架 ${qty}`);
  }
  // 数量守恒：扣上游、加下游，一次事务内两边都动
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE supply_batches SET ${patch}=COALESCE(${patch},0)+?, ${deduct}=COALESCE(${deduct},0)-?, stage=?, updated_at=? WHERE id=?`)
      .run(qty, qty, to, now(), cur.id);
    if (to === 'on_shelf') applyStockIn({ ...cur, stage: to }, qty, op);
    const holdsCarried = db.prepare("SELECT COUNT(*) c FROM stock_holds WHERE batch_id=? AND status='active'").get(cur.id).c;
    db.prepare(`INSERT INTO supply_batch_moves (batch_id,from_stage,to_stage,qty,qty_before,qty_after,holds_carried,operator,note,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(cur.id, cur.stage, to, qty, capacity, stageQty({ ...cur, stage: to }), holdsCarried, me(op), b.note || null, now());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // 上架会写现货库存，投影必须立刻重算，否则商城看到的还是上架前的数
  if (to === 'on_shelf') computeOne(cur.warehouse, cur.style_no, cur.color, cur.size);
  else markStale(cur.warehouse, cur.style_no, cur.color, cur.size);
  return getBatch(cur.id);
}

/** 部分到货拆子批：父批数量减少，子批承接；占用关系留在父批（数量守恒，不新增占用） */
function splitBatch(id, b, op) {
  const cur = db.prepare('SELECT * FROM supply_batches WHERE id=?').get(Number(id));
  if (!cur) throw new Error('供给批次不存在');
  if (cur.status !== 'active') throw new Error('批次已关闭，不能拆分');
  const qty = Number(b.qty || 0);
  if (!(qty > 0)) throw new Error('拆分量必须大于 0');
  const capacity = stageQty(cur);
  if (qty > capacity + 0.001) throw new Error(`拆分量 ${qty} 超过当前阶段数量 ${capacity}`);
  const no = nextNo('SB', 'supply_batches', 'batch_no');
  db.exec('BEGIN');
  try {
    const info = db.prepare(`INSERT INTO supply_batches
      (batch_no,company_id,owner_company_id,warehouse,style_no,product_name,color,size,sku,source_type,source_id,source_no,
       order_id,customer_id,qc_grade,intended_use,stage,qty_planned,qty_produced,qty_ready,qty_in_transit,qty_received,
       qty_checked_ok,qty_on_shelf,qty_short,risk_buffer,frozen_qty,eta_date,eta_evidence,eta_covered,parent_batch_id,split_qty,
       status,note,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'split',?,?,?,?,?,?,?,0,0,0,0,0,?,?,0,0,0,?,?,?,?,?,'active',?,?,?,?)`).run(
      no, cur.company_id, cur.owner_company_id, cur.warehouse, cur.style_no, cur.product_name, cur.color, cur.size,
      cur.sku, cur.source_type, cur.id, cur.source_no, cur.order_id, cur.customer_id, cur.qc_grade, cur.intended_use,
      cur.stage, qty,
      // 阶段数量跟着拆：当前阶段放 qty，其余清零
      cur.stage === 'in_production' ? qty : 0,
      cur.stage === 'ready_to_ship' ? qty : 0,
      cur.stage === 'in_transit' ? qty : 0,
      cur.stage === 'received_checked' ? qty : 0,
      cur.stage === 'on_shelf' ? qty : 0,
      cur.eta_date, cur.eta_evidence, cur.eta_covered, cur.id, qty,
      b.note || '部分到货拆子批', me(op), now(), now()
    );
    const col = { in_production: 'qty_produced', ready_to_ship: 'qty_ready', in_transit: 'qty_in_transit', received_checked: 'qty_received', on_shelf: 'qty_on_shelf' }[cur.stage];
    db.prepare(`UPDATE supply_batches SET ${col}=COALESCE(${col},0)-?, updated_at=? WHERE id=?`).run(qty, now(), cur.id);
    db.prepare(`INSERT INTO supply_batch_moves (batch_id,from_stage,to_stage,qty,qty_before,qty_after,holds_carried,operator,note,created_at)
      VALUES (?,?,?,?,?,?,0,?,?,?)`).run(info.lastInsertRowid, null, cur.stage, qty, 0, qty, me(op), `从 ${cur.batch_no} 拆分`, now());
    db.exec('COMMIT');
    return { parent: getBatch(cur.id), child: getBatch(info.lastInsertRowid) };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 短装/报废：保留承诺，形成缺口，不隐瞒也不超售 */
function recordShort(id, b, op) {
  const cur = db.prepare('SELECT * FROM supply_batches WHERE id=?').get(Number(id));
  if (!cur) throw new Error('供给批次不存在');
  const qty = Number(b.qty || 0);
  if (!(qty > 0)) throw new Error('短装数量必须大于 0');
  if (!b.reason) throw new Error('短装必须写原因（来料不足 / 生产报废 / 运输破损）');
  const capacity = stageQty(cur);
  if (qty > capacity + 0.001) throw new Error(`短装数量 ${qty} 超过当前阶段数量 ${capacity}`);

  const col = { in_production: 'qty_produced', ready_to_ship: 'qty_ready', in_transit: 'qty_in_transit', received_checked: 'qty_checked_ok', on_shelf: 'qty_on_shelf' }[cur.stage];
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE supply_batches SET ${col}=COALESCE(${col},0)-?, qty_short=COALESCE(qty_short,0)+?, updated_at=? WHERE id=?`)
      .run(qty, qty, now(), cur.id);
    db.prepare(`INSERT INTO supply_batch_moves (batch_id,from_stage,to_stage,qty,qty_before,qty_after,holds_carried,operator,note,created_at)
      VALUES (?,?,?,?,?,?,0,?,?,?)`).run(cur.id, cur.stage, cur.stage, -qty, capacity, capacity - qty, me(op), `短装：${b.reason}`, now());
    db.exec('COMMIT');
    const created = createShortagesFor(cur.id, `短装：${b.reason}`);
    markStale(cur.warehouse, cur.style_no, cur.color, cur.size);
    computeOne(cur.warehouse, cur.style_no, cur.color, cur.size);
    return { batch: getBatch(cur.id), shortages: created };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 上架落库：批次合格品进现货库存（这是 ERP 库存事件，投影据此重算） */
function applyStockIn(batch, qty, op) {
  const row = db.prepare(`SELECT * FROM stock_items WHERE warehouse=? AND style_no=?
    AND COALESCE(color,'')=COALESCE(?,'') AND COALESCE(size,'')=COALESCE(?,'')`)
    .get(batch.warehouse, batch.style_no, batch.color, batch.size);
  if (row) {
    db.prepare('UPDATE stock_items SET qty=COALESCE(qty,0)+?, updated_at=? WHERE id=?').run(qty, now(), row.id);
  } else {
    db.prepare(`INSERT INTO stock_items (warehouse,style_no,product_name,color,size,qty,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(batch.warehouse, batch.style_no, batch.product_name || null, batch.color, batch.size, qty, now());
  }
  db.prepare(`INSERT INTO stock_ledger (warehouse,style_no,product_name,color,size,type,qty,ref_type,ref_id,remark,operator,created_at)
    VALUES (?,?,?,?,?,'in',?,'supply_batch',?,?,?,?)`).run(
    batch.warehouse, batch.style_no, batch.product_name || null, batch.color, batch.size, qty, batch.id,
    '批次上架', me(op), now()
  );
}

/** 短装后若有已承诺量超额，按占用先后形成缺口（占用保留，等人工决议） */
function createShortagesFor(batchId, reason) {
  const b = db.prepare('SELECT * FROM supply_batches WHERE id=?').get(Number(batchId));
  if (!b) return [];
  const holds = db.prepare("SELECT * FROM stock_holds WHERE batch_id=? AND status='active' ORDER BY id").all(b.id);
  const committed = r2(holds.reduce((x, h) => x + Number(h.qty || 0), 0));
  let deficit = r2(committed - batchCommittable(b));
  const created = [];
  if (deficit <= 0) return created;
  holds.forEach((h) => {
    if (deficit <= 0) return;
    const take = Math.min(deficit, Number(h.qty || 0));
    if (take <= 0) return;
    const no = nextNo('SH', 'booking_shortages', 'shortage_no');
    db.prepare(`INSERT INTO booking_shortages
      (shortage_no,batch_id,hold_id,request_id,customer_id,customer_name,sku,qty_short,qty_committed,resolution,note,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'open',?,?)`).run(
      no, b.id, h.id, h.request_id || null, h.customer_id || null, h.customer_name || null,
      b.sku || skuOf(b), take, Number(h.qty || 0), reason || null, now()
    );
    created.push({ shortage_no: no, hold_no: h.hold_no, qty: take });
    deficit = r2(deficit - take);
  });
  return created;
}

/** 实收检验：合格进可承诺，不合格进短装（不隐瞒） */
function inspectBatch(id, b, op) {
  const cur = db.prepare('SELECT * FROM supply_batches WHERE id=?').get(Number(id));
  if (!cur) throw new Error('供给批次不存在');
  if (cur.stage !== 'received_checked') throw new Error('只有「实收检验」阶段的批次能做检验');
  const ok = Number(b.qty_ok || 0);
  const defect = Number(b.qty_defect || 0);
  if (ok < 0 || defect < 0) throw new Error('检验数量不能为负');
  if (!(ok + defect > 0)) throw new Error('至少要填一个检验数量');
  const pending = Number(cur.qty_received || 0);
  if (ok + defect > pending + 0.001) throw new Error(`检验合计 ${ok + defect} 超过待检数量 ${pending}`);
  if (defect > 0 && !String(b.reason || '').trim()) throw new Error('有不合格品必须写原因');
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE supply_batches SET qty_received=COALESCE(qty_received,0)-?, qty_checked_ok=COALESCE(qty_checked_ok,0)+?,
      qty_short=COALESCE(qty_short,0)+?, updated_at=? WHERE id=?`).run(ok + defect, ok, defect, now(), cur.id);
    db.prepare(`INSERT INTO supply_batch_moves (batch_id,from_stage,to_stage,qty,qty_before,qty_after,holds_carried,operator,note,created_at)
      VALUES (?,?,?,?,?,?,0,?,?,?)`).run(
      cur.id, cur.stage, cur.stage, ok, pending, pending - (ok + defect), me(op),
      `检验：合格 ${ok}${defect ? ` / 不合格 ${defect}（${b.reason}）` : ''}`, now()
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const shortages = defect > 0 ? createShortagesFor(cur.id, b.reason) : [];
  markStale(cur.warehouse, cur.style_no, cur.color, cur.size);
  computeOne(cur.warehouse, cur.style_no, cur.color, cur.size);
  return { batch: getBatch(cur.id), shortages };
}

/** 撤销建错的批次：只有「还在在产、没有任何占用/子批/短装」的才能删 */
function deleteBatch(id, op) {
  const b = db.prepare('SELECT * FROM supply_batches WHERE id=?').get(Number(id));
  if (!b) throw new Error('供给批次不存在');
  if (b.status !== 'active') throw new Error('批次已关闭或取消，不能删除');
  if (b.stage !== 'in_production') throw new Error('只有还在「在产」的批次能删（已经发出去的要留痕）');
  if (Number(b.qty_short || 0) > 0) throw new Error('有短装记录的批次不能删');
  const holds = db.prepare("SELECT COUNT(*) c FROM stock_holds WHERE batch_id=? AND status='active'").get(b.id).c;
  if (holds) throw new Error(`批次上还有 ${holds} 条有效占用，先释放再删`);
  const kids = db.prepare('SELECT COUNT(*) c FROM supply_batches WHERE parent_batch_id=?').get(b.id).c;
  if (kids) throw new Error(`批次已拆出 ${kids} 个子批，不能删`);
  db.prepare('DELETE FROM supply_batch_moves WHERE batch_id=?').run(b.id);
  db.prepare('DELETE FROM supply_batches WHERE id=?').run(b.id);
  return { deleted: 1, batch_no: b.batch_no, by: me(op) };
}

/** ==================== 预订申请 ==================== */

function decorateRequest(r) {
  return {
    ...r,
    status_label: REQ_STATUS_LABEL[r.status] || r.status,
    kind_label: r.kind === 'spot' ? '现货' : '未来供给',
    sku: r.sku || skuOf(r),
    channel_label: { erp: '销售代客', mall: '客户商城', mini: '小程序' }[r.channel] || r.channel,
    // 申请阶段不占量，这里给出「确认后还能不能占到」的预判
    is_expired: !!r.valid_until && String(r.valid_until).slice(0, 10) < today() && r.status === 'submitted'
  };
}

function listRequests(q = {}) {
  const where = [];
  const args = [];
  if (q.status) { where.push('status=?'); args.push(q.status); }
  if (q.kind) { where.push('kind=?'); args.push(q.kind); }
  if (q.customer_id) { where.push('customer_id=?'); args.push(Number(q.customer_id)); }
  if (q.q) { where.push('(style_no LIKE ? OR request_no LIKE ? OR customer_name LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  return db.prepare(`SELECT * FROM booking_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE status WHEN 'submitted' THEN 0 WHEN 'sales_confirmed' THEN 1 ELSE 2 END, id DESC`).all(...args)
    .map(decorateRequest);
}

function getRequest(id) {
  const r = db.prepare('SELECT * FROM booking_requests WHERE id=?').get(Number(id));
  if (!r) throw new Error('预订申请不存在');
  const out = decorateRequest(r);
  out.hold = r.hold_id ? db.prepare('SELECT * FROM stock_holds WHERE id=?').get(r.hold_id) : null;
  out.batch = r.batch_id ? db.prepare('SELECT * FROM supply_batches WHERE id=?').get(r.batch_id) : null;
  out.shortages = r.hold_id
    ? db.prepare('SELECT * FROM booking_shortages WHERE hold_id=?').all(r.hold_id) : [];
  return out;
}

/** 提交申请：**不占量**，重复的幂等键直接返回原单 */
function createRequest(b, op) {
  const key = String(b.idempotency_key || '').trim();
  if (key) {
    const dup = db.prepare('SELECT * FROM booking_requests WHERE idempotency_key=?').get(key);
    if (dup) return { ...getRequest(dup.id), idempotent: true, note: '幂等键命中：返回原申请，未重复创建' };
  }
  if (!b.style_no) throw new Error('款号必填');
  const qty = Number(b.qty || 0);
  if (!(qty > 0)) throw new Error('数量必须大于 0');
  const kind = b.kind === 'spot' ? 'spot' : 'future';
  const no = nextNo('BK', 'booking_requests', 'request_no');
  const info = db.prepare(`INSERT INTO booking_requests
    (request_no,company_id,customer_id,customer_name,channel,style_no,color,size,sku,qty,expect_date,quote_price,currency,
     kind,batch_id,status,valid_until,idempotency_key,version,note,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'submitted',?,?,1,?,?,?,?)`).run(
    no, Number(b.company_id) || 1, b.customer_id || null, b.customer_name || null, b.channel || 'erp',
    b.style_no, b.color || null, b.size || null, skuOf({ style_no: b.style_no, color: b.color, size: b.size }),
    qty, b.expect_date || null, b.quote_price === undefined ? null : Number(b.quote_price), b.currency || 'CNY',
    kind, b.valid_until || addDays(today(), 7), key || null, b.note || null, me(op), now(), now()
  );
  return getRequest(info.lastInsertRowid);
}

/**
 * 销售确认：此时才占量。
 * 原子性靠「UPDATE ... WHERE status='submitted' AND version=?」+ changes 判断，
 * 两个人同时点确认，只有一个能成功。
 */
function confirmRequest(id, b, op) {
  const r = db.prepare('SELECT * FROM booking_requests WHERE id=?').get(Number(id));
  if (!r) throw new Error('预订申请不存在');
  if (r.status !== 'submitted') throw new Error(`申请当前是「${REQ_STATUS_LABEL[r.status]}」，不能再确认`);
  // 报价有效期过了就不能拿旧报价占量（客户看到的价格早已失效）
  if (r.valid_until && String(r.valid_until).slice(0, 10) < today()) {
    throw new Error(`这条申请的报价有效期到 ${r.valid_until}，已过期，请让客户重新确认或重新申请`);
  }
  const qty = Number(b.qty === undefined || b.qty === null || b.qty === '' ? r.qty : b.qty);
  if (!(qty > 0)) throw new Error('确认数量必须大于 0');
  if (qty > Number(r.qty) + 0.001) throw new Error(`确认数量 ${qty} 不能超过申请数量 ${r.qty}`);
  if (!['sales', 'admin'].includes(op && op.role)) throw new Error('只有授权销售能确认预订');

  const warehouse = b.warehouse || 'us';
  let batch = null;
  let available = 0;
  if (r.kind === 'future') {
    // 确认时必须显式选批次：申请上挂的只是意向，不能让系统默默沿用
    if (!b.batch_id) throw new Error('未来供给确认必须明确选一个供给批次（申请上的只是意向）');
    batch = db.prepare('SELECT * FROM supply_batches WHERE id=?').get(Number(b.batch_id));
    if (!batch) throw new Error('所选供给批次不存在');
    if (batch.status !== 'active') throw new Error('该批次已关闭');
    if (!isLeaf(batch.id)) throw new Error('该批次已有子批次（已拆分），请选叶子批次，否则会重复计数');
    if (batch.stage === 'on_shelf') throw new Error('该批次已上架，属于现货口径，请走现货预订');
    // 确认前重算：投影可能陈旧，不能拿旧数占量
    computeOne(batch.warehouse, batch.style_no, batch.color, batch.size);
    available = batchAvailable(db.prepare('SELECT * FROM supply_batches WHERE id=?').get(batch.id));
  } else {
    const spot = spotSellable(warehouse, r.style_no, r.color, r.size);
    if (spot.sellable < 0) throw new Error('可买量为负（异常），先核库存再确认');
    available = spot.sellable;
  }
  if (available < qty) throw new Error(`可承诺数量不足：可用 ${available}，申请 ${qty}`);

  db.exec('BEGIN');
  try {
    const upd = db.prepare(`UPDATE booking_requests SET status='sales_confirmed', batch_id=?, sales_user_id=?, sales_confirmed_at=?,
      version=version+1, updated_at=? WHERE id=? AND status='submitted' AND version=?`)
      .run(batch ? batch.id : null, (op && (op.sub || op.id)) || null, now(), now(), r.id, r.version);
    if (!upd.changes) throw new Error('这条申请已被别人处理过，请刷新后重试');

    const holdNo = nextNo('HD', 'stock_holds', 'hold_no');
    const hold = db.prepare(`INSERT INTO stock_holds
      (hold_no,company_id,kind,batch_id,warehouse,style_no,color,size,sku,qty,qty_picked,customer_id,customer_name,request_id,
       status,temporary,expires_at,version,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?, 'active',1,?,1,?,?,?)`).run(
      holdNo, r.company_id, r.kind, batch ? batch.id : null, warehouse, r.style_no, r.color, r.size,
      r.sku, qty, r.customer_id || null, r.customer_name || null, r.id,
      addHours(now(), Number(b.expires_in_hours || 72)), me(op), now(), now()
    );
    db.prepare('UPDATE booking_requests SET hold_id=?, updated_at=? WHERE id=?').run(hold.lastInsertRowid, now(), r.id);
    db.exec('COMMIT');
    logEvent(`hold:${hold.lastInsertRowid}:create`, scopeKey(warehouse, r.style_no, r.color, r.size), 0, qty, `预订确认 ${r.request_no}`, op);
    markStale(warehouse, r.style_no, r.color, r.size);
    computeOne(warehouse, r.style_no, r.color, r.size);
    return getRequest(r.id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function rejectRequest(id, b, op) {
  const r = db.prepare('SELECT * FROM booking_requests WHERE id=?').get(Number(id));
  if (!r) throw new Error('预订申请不存在');
  if (r.status !== 'submitted') throw new Error('只能驳回待确认的申请');
  if (!String(b.reason || '').trim()) throw new Error('驳回必须写原因');
  db.prepare("UPDATE booking_requests SET status='rejected', reject_reason=?, version=version+1, updated_at=? WHERE id=?")
    .run(b.reason, now(), r.id);
  return getRequest(r.id);
}

function cancelRequest(id, b, op) {
  const r = db.prepare('SELECT * FROM booking_requests WHERE id=?').get(Number(id));
  if (!r) throw new Error('预订申请不存在');
  if (!['submitted', 'sales_confirmed'].includes(r.status)) throw new Error('当前状态不能取消');
  if (r.hold_id) {
    const h = db.prepare('SELECT * FROM stock_holds WHERE id=?').get(r.hold_id);
    if (h && h.status === 'active') releaseHold(h.id, { reason: b.reason || '客户取消申请' }, op);
  }
  db.prepare("UPDATE booking_requests SET status='cancelled', version=version+1, updated_at=? WHERE id=?").run(now(), r.id);
  return getRequest(r.id);
}

/** 删申请：还没占用过的才能删（已确认/已转订单的是业务依据） */
function deleteRequest(id, op) {
  const r = db.prepare('SELECT * FROM booking_requests WHERE id=?').get(Number(id));
  if (!r) throw new Error('预订申请不存在');
  if (!['submitted', 'rejected', 'cancelled', 'expired'].includes(r.status)) {
    throw new Error('已确认或已转订单的申请不能删（占用与订单要能追来源）');
  }
  if (r.hold_id) {
    const h = db.prepare('SELECT * FROM stock_holds WHERE id=?').get(r.hold_id);
    if (h && !['released', 'expired'].includes(h.status)) {
      throw new Error('这条申请的占用还在生效（或已转订单），不能删');
    }
    // 占用已释放/已到期的，连痕迹一起清（本来就没生效过）
    if (h) db.prepare('DELETE FROM stock_holds WHERE id=?').run(h.id);
  }
  db.prepare('DELETE FROM booking_requests WHERE id=?').run(r.id);
  return { deleted: 1, request_no: r.request_no, by: me(op) };
}

/** 过期申请清理：只处理还停在「待销售确认」且过了有效期的 */
function expireRequests(op) {
  const rows = db.prepare(`SELECT * FROM booking_requests
    WHERE status='submitted' AND valid_until IS NOT NULL AND valid_until < ?`).all(today());
  rows.forEach((r) => {
    db.prepare("UPDATE booking_requests SET status='expired', version=version+1, updated_at=? WHERE id=? AND status='submitted'")
      .run(now(), r.id);
  });
  return { expired: rows.length, by: me(op) };
}

/** ==================== 占用 ==================== */

function listHolds(q = {}) {
  const where = [];
  const args = [];
  if (q.status) { where.push('status=?'); args.push(q.status); }
  if (q.kind) { where.push('kind=?'); args.push(q.kind); }
  if (q.batch_id) { where.push('batch_id=?'); args.push(Number(q.batch_id)); }
  if (String(q.due) === '1') where.push("status='active' AND temporary=1 AND expires_at IS NOT NULL");
  const rows = db.prepare(`SELECT * FROM stock_holds ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, COALESCE(expires_at,'9999'), id DESC`).all(...args);
  const t = now();
  return rows.map((h) => ({
    ...h,
    status_label: HOLD_STATUS_LABEL[h.status] || h.status,
    kind_label: HOLD_KIND_LABEL[h.kind] || h.kind,
    is_due: h.status === 'active' && h.expires_at && h.expires_at < t,
    hours_left: h.expires_at ? Math.round((new Date(h.expires_at.replace(' ', 'T')) - new Date(t.replace(' ', 'T'))) / 3600000) : null
  }));
}

function getHold(id) {
  const h = db.prepare('SELECT * FROM stock_holds WHERE id=?').get(Number(id));
  if (!h) throw new Error('占用不存在');
  return { ...h, status_label: HOLD_STATUS_LABEL[h.status] || h.status };
}

/**
 * 释放占用：必须还是「那条有效的临时占用」。
 * 已拣的要做实物回位确认；已发货的只能走退货，不能在这里放。
 */
function releaseHold(id, b, op) {
  const h = db.prepare('SELECT * FROM stock_holds WHERE id=?').get(Number(id));
  if (!h) throw new Error('占用不存在');
  if (h.status !== 'active') throw new Error(`占用当前是「${HOLD_STATUS_LABEL[h.status] || h.status}」，不能再释放`);
  if (b.expected_version && Number(b.expected_version) !== Number(h.version)) {
    throw new Error('占用版本已变化（可能已转订单或已释放），请刷新后重试');
  }
  if (h.order_id && h.status === 'converted') throw new Error('已转订单的占用不能直接释放');
  if (Number(h.qty_picked || 0) > 0 && b.confirm_picked !== true) {
    throw new Error(`已拣 ${h.qty_picked} 件：先确认实物回位，再释放占用`);
  }
  if (h.order_id) throw new Error('占用已挂正式订单，只能走退货流程，不能直接释放');
  db.prepare(`UPDATE stock_holds SET status='released', release_reason=?, released_by=?, released_at=?, version=version+1, updated_at=?
    WHERE id=? AND status='active' AND version=?`).run(
    b.reason || null, me(op), now(), now(), h.id, h.version
  );
  logEvent(`hold:${h.id}:release`, scopeKey(h.warehouse, h.style_no, h.color, h.size), 0, -Number(h.qty || 0), b.reason || '释放占用', op);
  markStale(h.warehouse, h.style_no, h.color, h.size);
  computeOne(h.warehouse, h.style_no, h.color, h.size);
  return getHold(h.id);
}

/** 到期清理：只放过期且仍是 active 的临时占用（正式占用不自动过期） */
function expireHolds(op) {
  const t = now();
  const rows = db.prepare(`SELECT * FROM stock_holds
    WHERE status='active' AND temporary=1 AND expires_at IS NOT NULL AND expires_at < ?`).all(t);
  const done = [];
  rows.forEach((h) => {
    // 再查一次状态：期间可能已经转订单了
    const cur = db.prepare('SELECT * FROM stock_holds WHERE id=?').get(h.id);
    if (!cur || cur.status !== 'active' || !cur.temporary) return;
    db.prepare("UPDATE stock_holds SET status='expired', released_at=?, release_reason='临时占用到期', updated_at=? WHERE id=? AND status='active'")
      .run(t, now(), h.id);
    logEvent(`hold:${h.id}:expire`, scopeKey(h.warehouse, h.style_no, h.color, h.size), 0, -Number(h.qty || 0), '临时占用到期', op);
    markStale(h.warehouse, h.style_no, h.color, h.size);
    computeOne(h.warehouse, h.style_no, h.color, h.size);
    done.push(cur.hold_no);
  });
  return { expired: done.length, holds: done, by: me(op) };
}

/** 已拣登记：只改 qty_picked，不改占用数量（已拣是占用的子集） */
function markPicked(id, b, op) {
  const h = db.prepare('SELECT * FROM stock_holds WHERE id=?').get(Number(id));
  if (!h) throw new Error('占用不存在');
  if (h.status !== 'active') throw new Error('只有占用中的才能登记拣货');
  const qty = Number(b.qty || 0);
  if (!(qty > 0)) throw new Error('拣货数量必须大于 0');
  if (Number(h.qty_picked || 0) + qty > Number(h.qty) + 0.001) throw new Error('拣货数量不能超过占用数量');
  db.prepare('UPDATE stock_holds SET qty_picked=COALESCE(qty_picked,0)+?, updated_at=? WHERE id=?').run(qty, now(), h.id);
  return getHold(h.id);
}

/** 占用转订单：不释放再抢量，直接挂订单 */
function convertHold(id, b, op) {
  const h = db.prepare('SELECT * FROM stock_holds WHERE id=?').get(Number(id));
  if (!h) throw new Error('占用不存在');
  if (h.status !== 'active') throw new Error('只有占用中的才能转订单');
  if (!b.order_id) throw new Error('转订单必须指定订单');
  const o = db.prepare('SELECT id, order_no FROM orders WHERE id=?').get(Number(b.order_id));
  if (!o) throw new Error('订单不存在');
  db.prepare(`UPDATE stock_holds SET status='converted', order_id=?, temporary=0, converted_at=?, version=version+1, updated_at=?
    WHERE id=? AND status='active'`).run(o.id, now(), now(), h.id);
  if (h.request_id) {
    db.prepare("UPDATE booking_requests SET status='converted', version=version+1, updated_at=? WHERE id=?").run(now(), h.request_id);
  }
  logEvent(`hold:${h.id}:convert`, scopeKey(h.warehouse, h.style_no, h.color, h.size), 0, 0, `转订单 ${o.order_no}（不释放再抢量）`, op);
  return { ...getHold(h.id), order_no: o.order_no, note: '占用直接挂到订单，数量没有回到可卖池（避免中间被抢）' };
}

/** ==================== 缺口 ==================== */

function listShortages(q = {}) {
  const where = [];
  const args = [];
  if (q.resolution) { where.push('resolution=?'); args.push(q.resolution); }
  if (q.batch_id) { where.push('batch_id=?'); args.push(Number(q.batch_id)); }
  return db.prepare(`SELECT * FROM booking_shortages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`)
    .all(...args)
    .map((s) => ({ ...s, resolution_label: SHORT_RES_LABEL[s.resolution] || s.resolution }));
}

function resolveShortage(id, b, op) {
  const s = db.prepare('SELECT * FROM booking_shortages WHERE id=?').get(Number(id));
  if (!s) throw new Error('缺口记录不存在');
  if (s.resolution !== 'open') throw new Error('这条缺口已经处理过了');
  const res = String(b.resolution || '');
  if (!SHORT_RES_LABEL[res] || res === 'open') throw new Error('请选择处理方式');
  const hold = s.hold_id ? db.prepare('SELECT * FROM stock_holds WHERE id=?').get(s.hold_id) : null;

  if (res === 'substitute') {
    if (!b.substitute_batch_id) throw new Error('换替代批次必须指定批次');
    const nb = db.prepare('SELECT * FROM supply_batches WHERE id=?').get(Number(b.substitute_batch_id));
    if (!nb) throw new Error('替代批次不存在');
    if (!isLeaf(nb.id)) throw new Error('替代批次不能是已拆分的父批');
    if (nb.stage === 'on_shelf') throw new Error('替代批次已上架，请走现货占用');
    const avail = batchAvailable(nb);
    if (avail < Number(s.qty_short)) throw new Error(`替代批次可用 ${avail}，不够补 ${s.qty_short}`);
    if (hold) db.prepare('UPDATE stock_holds SET batch_id=?, updated_at=? WHERE id=?').run(nb.id, now(), hold.id);
  } else if (res === 'cancel') {
    if (hold && hold.status === 'active') {
      db.prepare(`UPDATE stock_holds SET status='released', release_reason=?, released_by=?, released_at=?, version=version+1, updated_at=?
        WHERE id=?`).run(`缺口取消：${b.note || ''}`, me(op), now(), now(), hold.id);
      logEvent(`hold:${hold.id}:release`, scopeKey(hold.warehouse, hold.style_no, hold.color, hold.size), 0, -Number(hold.qty || 0), '缺口取消', op);
    }
  } else if (res === 'written_off') {
    // 客户接受短装：占用数量降到实际可承诺的部分
    if (hold && hold.status === 'active') {
      const next = r2(Math.max(0, Number(hold.qty) - Number(s.qty_short)));
      db.prepare('UPDATE stock_holds SET qty=?, updated_at=? WHERE id=?').run(next, now(), hold.id);
    }
  }
  db.prepare(`UPDATE booking_shortages SET resolution=?, substitute_batch_id=?, decided_by=?, decided_at=?, note=COALESCE(note,'')||?
    WHERE id=?`).run(res, b.substitute_batch_id || null, me(op), now(), `\n[处理] ${SHORT_RES_LABEL[res]} ${b.note || ''}`, s.id);
  if (hold) markStale(hold.warehouse, hold.style_no, hold.color, hold.size);
  return listShortages({}).find((x) => Number(x.id) === Number(s.id));
}

/** ==================== 汇总 ==================== */

function overview() {
  const t = now();
  const proj = db.prepare('SELECT * FROM sellable_projection').all();
  const onHand = r2(proj.reduce((s, p) => s + Number(p.on_hand || 0), 0));
  const heldSpot = r2(proj.reduce((s, p) => s + Number(p.held_spot || 0), 0));
  const sellable = r2(proj.reduce((s, p) => s + Number(p.sellable || 0), 0));
  const future = r2(proj.reduce((s, p) => s + Number(p.future_available || 0), 0));
  const staleCnt = proj.filter((p) => isStale(p)).length;
  const anomalyCnt = proj.filter((p) => !!p.anomaly).length;
  const submitted = db.prepare("SELECT COUNT(*) c FROM booking_requests WHERE status='submitted'").get().c;
  const holdsActive = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(qty),0) q FROM stock_holds WHERE status='active'").get();
  const dueSoon = db.prepare(`SELECT COUNT(*) c FROM stock_holds
    WHERE status='active' AND temporary=1 AND expires_at IS NOT NULL AND expires_at <= ?`).get(addHours(t, 24)).c;
  const shortOpen = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(qty_short),0) q FROM booking_shortages WHERE resolution='open'").get();
  const batches = db.prepare("SELECT stage, COUNT(*) c FROM supply_batches WHERE status='active' GROUP BY stage").all();
  const byStage = {};
  STAGE.forEach((s) => { byStage[s] = 0; });
  batches.forEach((b) => { byStage[b.stage] = b.c; });
  return {
    spot: { on_hand: onHand, held_spot: heldSpot, sellable, qty_picked: r2(proj.reduce((s, p) => s + Number(p.qty_picked || 0), 0)) },
    future_available: future,
    projection: { stale: staleCnt, anomaly: anomalyCnt, total: proj.length },
    requests: { submitted },
    holds: { active: holdsActive.c, qty: r2(holdsActive.q), due_24h: dueSoon },
    shortages: { open: shortOpen.c, qty: r2(shortOpen.q) },
    batches: byStage,
    note: '可买量 = 合格已上架 − 有效现货占用（已拣是占用的子集，不重复扣）；未来可订只算叶子批次，已上架的批次归现货不重复计数'
  };
}

function report(q = {}) {
  const proj = listProjection(q);
  const byWarehouse = {};
  proj.forEach((p) => {
    const k = p.warehouse;
    byWarehouse[k] = byWarehouse[k] || { warehouse: k, label: p.warehouse_label, on_hand: 0, held_spot: 0, sellable: 0, future: 0, stale: 0 };
    byWarehouse[k].on_hand = r2(byWarehouse[k].on_hand + Number(p.on_hand || 0));
    byWarehouse[k].held_spot = r2(byWarehouse[k].held_spot + Number(p.held_spot || 0));
    byWarehouse[k].sellable = r2(byWarehouse[k].sellable + Number(p.sellable || 0));
    byWarehouse[k].future = r2(byWarehouse[k].future + Number(p.future_available || 0));
    if (p.stale) byWarehouse[k].stale += 1;
  });
  return {
    rows: proj,
    by_warehouse: Object.values(byWarehouse),
    note: 'ERP 库存事件是唯一账源；这里是与商城共用的同一份投影'
  };
}

module.exports = {
  dict, STALE_MIN,
  // 投影
  refreshProjection, listProjection, computeOne, spotSellable, futureAvailableOf, batchAvailable,
  // 批次
  listBatches, getBatch, createBatch, moveBatch, splitBatch, recordShort, inspectBatch, deleteBatch,
  // 申请
  listRequests, getRequest, createRequest, confirmRequest, rejectRequest, cancelRequest, expireRequests, deleteRequest,
  // 占用
  listHolds, getHold, releaseHold, expireHolds, markPicked, convertHold,
  // 缺口
  listShortages, resolveShortage,
  // 汇总
  overview, report
};
