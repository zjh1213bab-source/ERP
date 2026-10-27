/**
 * 现货经营总览 + 备货补货与停补提案（M19）
 * ============================================================
 * 一句话：把「卖多快、还剩多少、在路上多少、多久会断」算清楚，然后给出**补多少 / 什么时候下单 / 哪些该停**，
 * 但**只出提案，不自动下单、不改库存**。
 *
 * 硬规则（都在下面的代码里）：
 * 1. **可售不是库存**：可售 = 已上架合格 − 有效现货占用（优先读 `sellable_projection`）。
 *    绝不拿 `stock_items.qty` 当可售——那是实物，含已被客户占掉的部分。
 * 2. **只算有 ETA 的供给**：在途/在产里没有预计到货时间的，算「不可承诺」，不进覆盖天数，
 *    但要在明细里列出来（让人看到「在产 800 件但不知道什么时候到」）。
 * 3. **销速按自然日摊，且样本不足就不编**：窗口内至少 N 天有出库才算样本足够；
 *    样本不足只给「观察」，**不给补货数量**（编一个日均会直接搞错补货量）。
 * 4. **覆盖天数 = 可承诺量 ÷ 日均销**；样本不足时 cover_days 为 NULL，不写 0、不写 999。
 * 5. **补货量 = 日均销 ×（目标覆盖 + 安全天数）− 可承诺量**，向上取到批量倍数；
 *    不足起订量按起订量补并注明；补货量 ≤ 0 → 不补。
 * 6. **建议下单日 = 预计断货日 − 生产周期**；下单日已过 → 标「来不及」，优先级最高，
 *    但**不自动插单、不自动改订单交期**。
 * 7. **停补三条路，必须写清是哪一条**：覆盖天数超过阈值 / 最老库龄超过阈值 / 近 N 天零出库。
 * 8. **断码单独看**：同款某些码卖光、别的码还多 → 是断码补货，不是整款停补。
 * 9. **毛利不参与补货决策**：成本只作参考列。避免「越亏越补」——补不补看卖得动不动，
 *    亏不亏是定价问题，两件事不能混在一个按钮里。
 * 10. **提案不自动执行**：批准只把行标记 approved 并记录批准数量，**不写采购单、不写生产单、不改库存**；
 *     驳回必须写原因。一次生成 = 一个批次，历史批次只读。
 *
 * 时间口径：日期 YYYY-MM-DD；天数一律自然日。
 */

const { db } = require('../db');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + Math.round(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayDiff(a, b) {
  if (!a || !b) return 0;
  return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
}

/** 内置默认策略（没有任何配置时用它，但在界面上标「用默认值」） */
const DEFAULT_POLICY = {
  target_cover_days: 60,
  safety_days: 15,
  lead_time_days: 45,
  min_order_qty: 100,
  lot_size: 50,
  stop_cover_days: 120,
  stop_age_days: 90,
  dead_days: 30,
  min_sample_days: 5,
  scope: 'default',
  policy_id: null
};

const REASON = {
  stockout: '已断货（可售与在途都为 0）',
  below_cover: '低于目标覆盖天数',
  short_size: '断码（该码卖光，同款其他码还有）',
  below_moq: '不足起订量，按起订量补',
  urgent: '按生产周期倒推已来不及',
  slow_cover: '覆盖天数超过停补阈值',
  old_age: '最老库龄超过停补阈值',
  zero_sales: '窗口内零出库',
  sample_short: '样本不足（窗口内有出库天数不够），只观察不给量',
  no_cost: '成本未核（参考列，不影响补货决策）',
  negative_sellable: '可售为负（投影与占用不一致），先修数再补货'
};

const KIND_LABEL = { replenish: '补货', stop: '停补', watch: '观察' };
const STATUS_LABEL = { pending: '待决策', approved: '已批准', rejected: '已驳回', deferred: '已暂缓' };

// ---------- 策略 ----------
function listPolicies(warehouse = 'us') {
  return db.prepare(
    "SELECT * FROM spot_policies WHERE warehouse = ? ORDER BY (scope='global') DESC, scope, style_no"
  ).all(warehouse);
}

/** 按款 → 类目 → 全局 → 内置默认，逐级回退 */
function resolvePolicy(styleNo, category, warehouse) {
  const pick = (sql, args) => db.prepare(sql).get(...args);
  let row = pick(
    "SELECT * FROM spot_policies WHERE warehouse=? AND scope='style' AND style_no=? AND status='active'",
    [warehouse, styleNo || '']
  );
  if (!row && category) {
    row = pick(
      "SELECT * FROM spot_policies WHERE warehouse=? AND scope='category' AND category=? AND status='active'",
      [warehouse, category]
    );
  }
  if (!row) {
    row = pick(
      "SELECT * FROM spot_policies WHERE warehouse=? AND scope='global' AND status='active'",
      [warehouse]
    );
  }
  if (!row) return { ...DEFAULT_POLICY };
  return {
    target_cover_days: Number(row.target_cover_days) || 0,
    safety_days: Number(row.safety_days) || 0,
    lead_time_days: Number(row.lead_time_days) || 0,
    min_order_qty: Number(row.min_order_qty) || 0,
    lot_size: Math.max(1, Number(row.lot_size) || 1),
    stop_cover_days: Number(row.stop_cover_days) || 0,
    stop_age_days: Number(row.stop_age_days) || 0,
    dead_days: Number(row.dead_days) || 0,
    min_sample_days: Number(row.min_sample_days) || 1,
    scope: row.scope,
    policy_id: row.id
  };
}

// ---------- 数据快照 ----------
const KEY = (s, c, z) => `${s || ''}|${c || ''}|${z || ''}`;

/** FIFO 反算每 SKU 在库批次（与 spot.js 同一口径：正数入批，负数按先进先出冲） */
function fifoBatches(warehouse, fromDate) {
  const rows = db.prepare(
    `SELECT style_no, color, size, qty, created_at FROM stock_ledger
     WHERE warehouse = ? AND substr(created_at,1,10) >= ? ORDER BY created_at, id`
  ).all(warehouse, fromDate);
  const map = {};
  rows.forEach((r) => {
    const k = KEY(r.style_no, r.color, r.size);
    map[k] = map[k] || [];
    const q = Number(r.qty) || 0;
    if (q > 0) map[k].push({ date: String(r.created_at).slice(0, 10), remain: q });
    else if (q < 0) {
      let need = -q;
      for (const b of map[k]) {
        if (need <= 1e-6) break;
        if (b.remain <= 1e-6) continue;
        const take = Math.min(b.remain, need);
        b.remain = r2(b.remain - take);
        need = r2(need - take);
      }
    }
  });
  return map;
}

/**
 * 逐 SKU 指标快照。
 * 数据来源优先级：sellable_projection（可买量投影）→ stock_items − 有效现货占用（兜底，标 fallback）
 */
function snapshot({ warehouse = 'us', windowDays = 60, asOf = todayStr() } = {}) {
  const from = addDays(asOf, -windowDays);
  const ledgerFrom = addDays(asOf, -400); // 库龄要往前看更久

  // 1) 实物
  const items = db.prepare(
    `SELECT style_no, product_name, color, size, qty FROM stock_items WHERE warehouse = ?`
  ).all(warehouse);

  // 2) 有效现货占用（active，含已拣；只算现货，未来供给占用不占现货可售）
  const holds = db.prepare(
    `SELECT style_no, color, size, COALESCE(SUM(qty),0) q FROM stock_holds
     WHERE warehouse = ? AND status = 'active' AND kind = 'spot'
     GROUP BY style_no, color, size`
  ).all(warehouse);
  const holdMap = {};
  holds.forEach((h) => { holdMap[KEY(h.style_no, h.color, h.size)] = Number(h.q) || 0; });

  // 3) 可买量投影
  const projs = db.prepare(
    `SELECT style_no, color, size, on_hand, held_spot, sellable, future_available, stale
     FROM sellable_projection WHERE warehouse = ?`
  ).all(warehouse);
  const projMap = {};
  projs.forEach((p) => { projMap[KEY(p.style_no, p.color, p.size)] = p; });

  // 4) 在途 / 在产（只看叶子批次：parent 未被拆走的按自己算，已拆父批不重复计）
  const batches = db.prepare(
    `SELECT * FROM supply_batches
     WHERE warehouse = ? AND status = 'active' AND stage IN ('in_production','ready_to_ship','in_transit')`
  ).all(warehouse);
  const transitMap = {};
  const prodMap = {};
  batches.forEach((b) => {
    const k = KEY(b.style_no, b.color, b.size);
    const transitQty = (Number(b.qty_ready) || 0) + (Number(b.qty_in_transit) || 0);
    const prodQty = (Number(b.qty_produced) || 0) > 0
      ? Number(b.qty_produced)
      : (Number(b.qty_planned) || 0);
    const eta = b.eta_covered && b.eta_date ? String(b.eta_date).slice(0, 10) : null;
    if (b.stage === 'in_production') {
      prodMap[k] = prodMap[k] || { qty: 0, committed: 0, no_eta: 0 };
      prodMap[k].qty = r2(prodMap[k].qty + prodQty);
      if (eta) prodMap[k].committed = r2(prodMap[k].committed + prodQty);
      else prodMap[k].no_eta += 1;
    } else if (transitQty > 0) {
      transitMap[k] = transitMap[k] || { qty: 0, committed: 0, no_eta: 0 };
      transitMap[k].qty = r2(transitMap[k].qty + transitQty);
      if (eta) transitMap[k].committed = r2(transitMap[k].committed + transitQty);
      else transitMap[k].no_eta += 1;
    }
  });

  // 5) 出库（销量）：只算真出库 out，调拨/套装拆组不算销量
  const outs = db.prepare(
    `SELECT style_no, color, size, COALESCE(SUM(-qty),0) q, COUNT(DISTINCT substr(created_at,1,10)) d
     FROM stock_ledger WHERE warehouse = ? AND type = 'out' AND qty < 0 AND substr(created_at,1,10) >= ?
     GROUP BY style_no, color, size`
  ).all(warehouse, from);
  const outMap = {};
  outs.forEach((o) => { outMap[KEY(o.style_no, o.color, o.size)] = { q: Number(o.q) || 0, d: Number(o.d) || 0 }; });

  // 6) 累计到货（售罄率分母）
  const ins = db.prepare(
    `SELECT style_no, color, size, COALESCE(SUM(qty),0) q FROM stock_ledger
     WHERE warehouse = ? AND type IN ('in','transfer_in') AND qty > 0
     GROUP BY style_no, color, size`
  ).all(warehouse);
  const inMap = {};
  ins.forEach((i) => { inMap[KEY(i.style_no, i.color, i.size)] = Number(i.q) || 0; });

  // 7) 库龄（FIFO 余量按入库日期算加权，最老批次单独给）
  const fifo = fifoBatches(warehouse, ledgerFrom);

  // 8) 单件成本（成本对象按款取，取不到就是 null，不猜）
  const costRows = db.prepare(
    `SELECT style_no, SUM(actual_cost) c, SUM(qty) q FROM cost_objects
     WHERE style_no IS NOT NULL AND qty > 0 GROUP BY style_no`
  ).all();
  const costMap = {};
  costRows.forEach((c) => {
    if (Number(c.q) > 0 && Number(c.c) > 0) costMap[c.style_no] = Number(c.c) / Number(c.q);
  });

  // 9) 款名与类目
  const names = {};
  const cats = {};
  items.forEach((i) => {
    if (i.product_name) names[KEY(i.style_no, i.color, i.size)] = i.product_name;
    names[i.style_no] = names[i.style_no] || i.product_name;
  });
  db.prepare('SELECT sku, name, category FROM products').all().forEach((p) => {
    if (!p.sku) return;
    const [style] = String(p.sku).split('-');
    if (!names[style]) names[style] = p.name;
    if (p.category) cats[style] = p.category;
  });

  // 10) 汇总所有出现过的 SKU
  const keys = new Set();
  items.forEach((i) => keys.add(KEY(i.style_no, i.color, i.size)));
  projs.forEach((p) => keys.add(KEY(p.style_no, p.color, p.size)));
  Object.keys(transitMap).forEach((k) => keys.add(k));
  Object.keys(prodMap).forEach((k) => keys.add(k));
  Object.keys(outMap).forEach((k) => keys.add(k));

  const rows = [];
  keys.forEach((k) => {
    const [styleNo, color, size] = k.split('|');
    if (!styleNo) return;
    const item = items.find((i) => KEY(i.style_no, i.color, i.size) === k);
    const proj = projMap[k];
    const onHand = item ? r2(item.qty) : (proj ? r2(proj.on_hand) : 0);
    const held = proj ? r2(proj.held_spot) : r2(holdMap[k] || 0);
    // 规则 1：优先用投影的可买量；没有投影时 可售 = 实物 − 有效占用（足够保守）
    const sellable = proj ? r2(proj.sellable) : r2(Math.max(0, onHand - held));
    const source = proj ? 'projection' : 'fallback';

    const tr = transitMap[k] || { qty: 0, committed: 0, no_eta: 0 };
    const pd = prodMap[k] || { qty: 0, committed: 0, no_eta: 0 };
    // 规则 2：只有带 ETA 的供给才算「可承诺」
    const committed = r2(sellable + tr.committed + pd.committed);

    const out = outMap[k] || { q: 0, d: 0 };
    const daily = windowDays > 0 ? r2(out.q / windowDays) : 0;

    const totalIn = inMap[k] || 0;
    const soldTotal = Math.max(0, r2(totalIn - onHand));

    // 库龄
    const lots = (fifo[k] || []).filter((b) => b.remain > 0.5);
    const lotQty = lots.reduce((a, b) => a + b.remain, 0);
    const ageW = lotQty > 0
      ? Math.round(lots.reduce((a, b) => a + Math.max(0, dayDiff(b.date, asOf)) * b.remain, 0) / lotQty)
      : 0;
    const oldest = lots.length ? Math.max(...lots.map((b) => Math.max(0, dayDiff(b.date, asOf)))) : 0;

    rows.push({
      key: k,
      style_no: styleNo,
      product_name: (item && item.product_name) || names[styleNo] || null,
      category: cats[styleNo] || null,
      color: color || '',
      size: size || '',
      sku: [styleNo, color, size].filter(Boolean).join('-'),
      on_hand: onHand,
      held,
      sellable,
      in_transit: tr.qty,
      in_transit_no_eta: tr.no_eta,
      in_production: pd.qty,
      in_production_no_eta: pd.no_eta,
      future_available: proj ? r2(proj.future_available) : 0,
      qty_available: committed,
      out_qty: r2(out.q),
      out_days: out.d,
      daily_out: daily,
      total_in: r2(totalIn),
      sold_total: soldTotal,
      sell_through: totalIn > 0 ? Math.round((soldTotal / totalIn) * 1000) / 10 : 0,
      age_days: oldest,
      avg_age: ageW,
      unit_cost: costMap[styleNo] === undefined ? null : r2(costMap[styleNo]),
      proj_source: source,
      proj_stale: proj ? Number(proj.stale) || 0 : 0
    });
  });

  return { asOf, warehouse, windowDays, from, rows };
}

/** 同一款里「有的码断、有的码还有」→ 断码 SKU 标记 */
function markSizeBroken(rows) {
  const byStyle = {};
  rows.forEach((r) => {
    byStyle[r.style_no] = byStyle[r.style_no] || [];
    byStyle[r.style_no].push(r);
  });
  Object.values(byStyle).forEach((list) => {
    const sizesWithStock = list.filter((r) => r.sellable > 0).length;
    if (sizesWithStock === 0 || sizesWithStock === list.length) return;
    list.forEach((r) => {
      if (r.sellable <= 0 && r.out_qty > 0) r.size_broken = 1;
      else r.size_broken = 0;
    });
  });
  rows.forEach((r) => { if (r.size_broken === undefined) r.size_broken = 0; });
  return rows;
}

/** 按 SKU 出建议（纯计算，不落库） */
function advise(rows, warehouse) {
  const out = [];
  rows.forEach((r) => {
    const p = resolvePolicy(r.style_no, r.category, warehouse);
    const sampleOk = r.out_days >= p.min_sample_days;
    const daily = r.daily_out;
    const coverDays = sampleOk && daily > 0 ? r2(r.qty_available / daily) : null;
    const stockoutDate = coverDays === null ? null : addDays(todayStr(), Math.floor(coverDays));

    const base = {
      ...r,
      policy: p,
      sample_ok: sampleOk ? 1 : 0,
      cover_days: coverDays,
      stockout_date: stockoutDate,
      target_cover_days: p.target_cover_days,
      lead_time_days: p.lead_time_days
    };

    // ---- 可售为负：先修数，不给补货建议（否则会按错误的可售量补货） ----
    if (r.sellable < -0.5) {
      out.push({
        ...base,
        kind: 'watch',
        reason_code: 'negative_sellable',
        priority: 'P1',
        suggest_qty: 0,
        suggest_order_date: null,
        urgent: 0,
        reason: `可售 ${r.sellable} 件为负数（实物 ${r.on_hand}、有效占用 ${r.held}），投影与占用对不上；先跑到「数据质量与勾稽」核账，不要按这个数补货`
      });
      return;
    }

    // ---- 样本不足：只观察，不给数量（规则 3） ----
    if (!sampleOk) {
      const dead = r.out_qty <= 0 && r.age_days >= p.dead_days;
      if (dead) {
        out.push({
          ...base,
          kind: 'stop',
          reason_code: 'zero_sales',
          priority: 'P2',
          suggest_qty: 0,
          suggest_order_date: null,
          urgent: 0,
          reason: `近 ${p.dead_days} 天零出库且最老库龄 ${r.age_days} 天，建议停补并清理（库存 ${r.on_hand} 件）`
        });
      } else if (r.on_hand > 0 || r.sellable > 0) {
        out.push({
          ...base,
          kind: 'watch',
          reason_code: 'sample_short',
          priority: 'P3',
          suggest_qty: 0,
          suggest_order_date: null,
          urgent: 0,
          reason: `窗口内只有 ${r.out_days} 天有出库（需 ≥${p.min_sample_days} 天），样本不足不给量；先观察`
        });
      }
      return;
    }

    // ---- 停补三条路（规则 7） ----
    const stopBy = [];
    if (p.stop_cover_days > 0 && coverDays !== null && coverDays > p.stop_cover_days) {
      stopBy.push(`覆盖 ${Math.round(coverDays)} 天 > 阈值 ${p.stop_cover_days} 天`);
    }
    if (p.stop_age_days > 0 && r.age_days > p.stop_age_days) {
      stopBy.push(`最老库龄 ${r.age_days} 天 > 阈值 ${p.stop_age_days} 天`);
    }
    if (stopBy.length) {
      out.push({
        ...base,
        kind: 'stop',
        reason_code: p.stop_age_days > 0 && r.age_days > p.stop_age_days ? 'old_age' : 'slow_cover',
        priority: r.age_days > p.stop_age_days * 1.5 ? 'P1' : 'P2',
        suggest_qty: 0,
        suggest_order_date: null,
        urgent: 0,
        reason: `建议停补：${stopBy.join('；')}`
      });
      return;
    }

    // ---- 补货 ----
    const targetQty = r2(daily * (p.target_cover_days + p.safety_days));
    const gap = r2(targetQty - r.qty_available);
    if (gap <= 0) {
      // 覆盖够，但接近阈值时也给个观察行（避免「看起来没事」）
      if (coverDays !== null && coverDays < p.target_cover_days * 1.2) {
        out.push({
          ...base,
          kind: 'watch',
          reason_code: 'below_cover',
          priority: 'P3',
          suggest_qty: 0,
          suggest_order_date: null,
          urgent: 0,
          reason: `覆盖 ${Math.round(coverDays)} 天，略高于目标 ${p.target_cover_days} 天，暂不补`
        });
      }
      return;
    }

    let qty = gap;
    let reasonCode = r.size_broken ? 'short_size' : (r.sellable <= 0 && r.qty_available <= 0 ? 'stockout' : 'below_cover');
    let extra = '';
    if (qty < p.min_order_qty) {
      qty = p.min_order_qty;
      extra = `（差额 ${gap} 件不足起订量，按起订量 ${p.min_order_qty} 补）`;
    }
    qty = Math.ceil(qty / p.lot_size) * p.lot_size;

    const orderDate = stockoutDate ? addDays(stockoutDate, -p.lead_time_days) : null;
    const urgent = orderDate ? dayDiff(orderDate, todayStr()) >= 0 : false;
    const priority = urgent || coverDays <= p.lead_time_days ? 'P1' : 'P2';
    const reason =
      (r.size_broken && reasonCode === 'short_size'
        ? `断码补货：该码可售 ${r.sellable} 件、日均销 ${daily} 件，同款其他码仍有货；`
        : reasonCode === 'stockout'
          ? `已断货（可售 0、可承诺 ${r.qty_available} 件）；`
          : `日均销 ${daily} 件，可承诺 ${r.qty_available} 件只能卖 ${Math.round(coverDays)} 天；`) +
      `补 ${qty} 件可覆盖 ${Math.round((r.qty_available + qty) / daily)} 天${extra}`;

    out.push({
      ...base,
      kind: 'replenish',
      reason_code: reasonCode,
      priority,
      suggest_qty: qty,
      suggest_order_date: orderDate,
      urgent: urgent ? 1 : 0,
      reason: urgent
        ? `${reason}；按 ${p.lead_time_days} 天周期倒推，下单日 ${orderDate} 已过，现在下单也要晚到 ${dayDiff(orderDate, todayStr())} 天`
        : `${reason}；最迟 ${orderDate} 下单`
    });
  });
  return out;
}

/** 按款聚合的经营总览 */
function styleOverview({ warehouse = 'us', windowDays = 60 } = {}) {
  const snap = snapshot({ warehouse, windowDays });
  const rows = markSizeBroken(snap.rows);
  const adv = advise(rows, warehouse);
  const byStyle = {};
  rows.forEach((r) => {
    const s = byStyle[r.style_no] = byStyle[r.style_no] || {
      style_no: r.style_no, product_name: r.product_name, category: r.category,
      sku_count: 0, on_hand: 0, held: 0, sellable: 0, in_transit: 0, in_production: 0,
      future_available: 0, qty_available: 0, out_qty: 0, total_in: 0, sold_total: 0,
      broken_sizes: [], no_eta_cnt: 0, unit_cost: r.unit_cost, age_days: 0, avg_age: 0
    };
    s.sku_count += 1;
    s.on_hand = r2(s.on_hand + r.on_hand);
    s.held = r2(s.held + r.held);
    s.sellable = r2(s.sellable + r.sellable);
    s.in_transit = r2(s.in_transit + r.in_transit);
    s.in_production = r2(s.in_production + r.in_production);
    s.future_available = r2(s.future_available + r.future_available);
    s.out_qty = r2(s.out_qty + r.out_qty);
    s.total_in = r2(s.total_in + r.total_in);
    s.sold_total = r2(s.sold_total + r.sold_total);
    s.qty_available = r2((s.qty_available || 0) + r.qty_available);
    s.no_eta_cnt += (r.in_transit_no_eta ? 1 : 0) + (r.in_production_no_eta ? 1 : 0);
    s.age_days = Math.max(s.age_days, r.age_days);
    if (r.size_broken) s.broken_sizes.push(r.size || r.colorsize || '—');
  });

  const list = Object.values(byStyle).map((s) => {
    const daily = windowDays > 0 ? r2(s.out_qty / windowDays) : 0;
    const avail = r2(s.qty_available || 0);
    const cover = daily > 0 ? r2(avail / daily) : null;
    const lines = adv.filter((a) => a.style_no === s.style_no);
    const kinds = lines.map((l) => l.kind);
    return {
      ...s,
      daily_out: daily,
      qty_available: avail,
      cover_days: cover,
      stockout_date: cover === null ? null : addDays(todayStr(), Math.floor(cover)),
      sell_through: s.total_in > 0 ? Math.round((s.sold_total / s.total_in) * 1000) / 10 : 0,
      stock_value: s.unit_cost === null ? null : r2(s.on_hand * s.unit_cost),
      broken_sizes: s.broken_sizes,
      anomaly: lines.some((l) => l.reason_code === 'negative_sellable'),
      has_replenish: kinds.includes('replenish'),
      has_stop: kinds.includes('stop'),
      suggestion: lines.some((l) => l.reason_code === 'negative_sellable')
        ? '数据异常'
        : (kinds.includes('replenish') && kinds.includes('stop')
          ? '补货 + 停补'
          : (kinds.includes('stop') ? '停补' : (kinds.includes('replenish') ? '补货' : (kinds.includes('watch') ? '观察' : '正常'))))
    };
  });

  const totalStock = r2(list.reduce((a, s) => a + s.on_hand, 0));
  const totalSellable = r2(list.reduce((a, s) => a + s.sellable, 0));
  const totalHeld = r2(list.reduce((a, s) => a + s.held, 0));
  const totalOut = r2(list.reduce((a, s) => a + s.out_qty, 0));
  const dailyTotal = windowDays > 0 ? r2(totalOut / windowDays) : 0;

  return {
    warehouse, window_days: windowDays, as_of: snap.asOf,
    stat: {
      style_count: list.length,
      sku_count: rows.length,
      on_hand: totalStock,
      sellable: totalSellable,
      held: totalHeld,
      held_pct: totalStock > 0 ? Math.round((totalHeld / totalStock) * 1000) / 10 : 0,
      in_transit: r2(list.reduce((a, s) => a + s.in_transit, 0)),
      in_production: r2(list.reduce((a, s) => a + s.in_production, 0)),
      daily_out: dailyTotal,
      cover_days: dailyTotal > 0 ? Math.round(r2(list.reduce((a, s) => a + s.qty_available, 0)) / dailyTotal) : null,
      broken_style: list.filter((s) => s.broken_sizes.length).length,
      replenish_style: list.filter((s) => s.has_replenish).length,
      stop_style: list.filter((s) => s.has_stop).length,
      no_eta_cnt: list.reduce((a, s) => a + s.no_eta_cnt, 0)
    },
    styles: list.sort((a, b) => {
      const av = a.cover_days === null ? 999999 : a.cover_days;
      const bv = b.cover_days === null ? 999999 : b.cover_days;
      return av - bv;
    }),
    rows
  };
}

// ---------- 批次 ----------
function nextRunNo(warehouse) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const prefix = `SE${ymd}`;
  const rows = db.prepare('SELECT run_no FROM spot_proposal_runs WHERE run_no LIKE ?').all(`${prefix}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.run_no).slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  let seq = max + 1;
  let no = `${prefix}${String(seq).padStart(4, '0')}`;
  while (db.prepare('SELECT 1 x FROM spot_proposal_runs WHERE run_no = ?').get(no)) {
    seq += 1;
    no = `${prefix}${String(seq).padStart(4, '0')}`;
  }
  void warehouse;
  return no;
}

/** 生成提案批次（一次生成一批；历史批次不动） */
function generateRun({ warehouse = 'us', windowDays = 60, operator = 'system', note = null } = {}) {
  if (!(windowDays > 0)) throw new Error('销速统计窗口必须大于 0 天');
  const snap = snapshot({ warehouse, windowDays });
  const rows = markSizeBroken(snap.rows);
  const lines = advise(rows, warehouse);
  if (!lines.length) {
    const err = new Error('这批没有可提的建议（没有可售也没有出库的款），先确认库存与流水');
    err.code = 422;
    throw err;
  }

  const runNo = nextRunNo(warehouse);
  const ts = new Date().toISOString();
  const replenish = lines.filter((l) => l.kind === 'replenish');
  const stops = lines.filter((l) => l.kind === 'stop');
  const urgent = lines.filter((l) => l.urgent);
  const sampleShort = lines.filter((l) => l.reason_code === 'sample_short');

  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO spot_proposal_runs
        (run_no, company_id, warehouse, as_of_date, window_days, line_count, replenish_count, stop_count,
         urgent_count, sample_short_count, status, is_current, created_by, created_at, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      runNo, 1, warehouse, snap.asOf, windowDays, lines.length, replenish.length, stops.length,
      urgent.length, sampleShort.length, 'draft', 0, operator, ts, note
    );
    const runId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO spot_proposal_lines
        (run_id, kind, reason_code, style_no, product_name, color, size, sku,
         on_hand, held, sellable, in_transit, in_production, future_available, qty_available,
         daily_out, out_qty, out_days, sample_ok, cover_days, stockout_date, age_days, sell_through,
         size_broken, unit_cost, target_cover_days, lead_time_days, suggest_qty, suggest_order_date,
         urgent, priority, reason, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    lines.forEach((l) => {
      ins.run(
        runId, l.kind, l.reason_code, l.style_no, l.product_name || null, l.color || '', l.size || '', l.sku,
        r2(l.on_hand), r2(l.held), r2(l.sellable), r2(l.in_transit), r2(l.in_production),
        r2(l.future_available), r2(l.qty_available),
        r2(l.daily_out), r2(l.out_qty), l.out_days, l.sample_ok,
        l.cover_days === null ? null : r2(l.cover_days), l.stockout_date,
        l.age_days, r2(l.sell_through), l.size_broken || 0,
        l.unit_cost === null || l.unit_cost === undefined ? null : r2(l.unit_cost),
        r2(l.target_cover_days), r2(l.lead_time_days), r2(l.suggest_qty), l.suggest_order_date,
        l.urgent ? 1 : 0, l.priority, l.reason, 'pending', ts
      );
    });
    db.exec('COMMIT');
    return {
      run_id: runId, run_no: runNo,
      line_count: lines.length,
      replenish_count: replenish.length,
      stop_count: stops.length,
      urgent_count: urgent.length,
      sample_short_count: sampleShort.length
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function listRuns(warehouse = 'us') {
  return db.prepare(
    `SELECT * FROM spot_proposal_runs WHERE warehouse = ? ORDER BY id DESC LIMIT 60`
  ).all(warehouse);
}

/** 批次详情；line 上带 expired（读取时算，不改状态） */
function runView(runId) {
  const run = db.prepare('SELECT * FROM spot_proposal_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const lines = db.prepare(
    `SELECT * FROM spot_proposal_lines WHERE run_id = ? ORDER BY
       CASE kind WHEN 'replenish' THEN 1 WHEN 'stop' THEN 2 ELSE 3 END,
       CASE priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
       style_no, size`
  ).all(runId).map((l) => ({
    ...l,
    kind_label: KIND_LABEL[l.kind] || l.kind,
    status_label: STATUS_LABEL[l.status] || l.status,
    reason_label: REASON[l.reason_code] || l.reason_code,
    // 提案有效期：同一款过了 14 天还没决策，销速早变了，提示重算（不擅自改状态）
    expired: l.status === 'pending' && dayDiff(String(l.created_at).slice(0, 10), todayStr()) > 14 ? 1 : 0
  }));
  const decisions = db.prepare(
    'SELECT * FROM spot_proposal_decisions WHERE run_id = ? ORDER BY id DESC LIMIT 200'
  ).all(runId);
  const byKind = {};
  lines.forEach((l) => { byKind[l.kind] = (byKind[l.kind] || 0) + 1; });
  return { run, lines, decisions, by_kind: byKind };
}

function publishRun(runId, operator, note) {
  const run = db.prepare('SELECT * FROM spot_proposal_runs WHERE id = ?').get(runId);
  if (!run) throw new Error('提案批次不存在');
  if (run.status === 'published') throw new Error('该批次已下发，请勿重复下发');
  if (run.status === 'archived') throw new Error('已归档批次不能再下发');
  const pending = db.prepare(
    "SELECT COUNT(*) c FROM spot_proposal_lines WHERE run_id = ? AND status = 'pending'"
  ).get(runId).c;
  if (pending === 0) throw new Error('这批没有待决策的行，无需下发');

  const ts = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(
      "UPDATE spot_proposal_runs SET is_current = 0, status = CASE WHEN status='published' THEN 'archived' ELSE status END WHERE warehouse = ? AND is_current = 1"
    ).run(run.warehouse);
    db.prepare(
      "UPDATE spot_proposal_runs SET status='published', is_current=1, published_by=?, published_at=?, note=COALESCE(?, note) WHERE id=?"
    ).run(operator, ts, note || null, runId);
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM spot_proposal_runs WHERE id = ?').get(runId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function archiveRun(runId, operator) {
  const run = db.prepare('SELECT * FROM spot_proposal_runs WHERE id = ?').get(runId);
  if (!run) throw new Error('提案批次不存在');
  if (run.is_current) throw new Error('当前生效的批次不能归档，请先下发新批次');
  db.prepare("UPDATE spot_proposal_runs SET status='archived' WHERE id=?").run(runId);
  void operator;
  return db.prepare('SELECT * FROM spot_proposal_runs WHERE id = ?').get(runId);
}

/**
 * 决策：approve / reject / defer
 * 规则 10：只记录决策与批准数量，**不写采购单/生产单/库存**。
 * 驳回必须写原因；批准数量不能超过建议量（要加量请改建议量或重新生成）。
 */
function decideLine(lineId, { action, qty, note } = {}, operator) {
  const line = db.prepare('SELECT * FROM spot_proposal_lines WHERE id = ?').get(lineId);
  if (!line) throw new Error('提案行不存在');
  const run = db.prepare('SELECT * FROM spot_proposal_runs WHERE id = ?').get(line.run_id);
  if (!run) throw new Error('提案批次不存在');
  if (run.status === 'archived') throw new Error('已归档批次只读');
  if (!['approve', 'reject', 'defer'].includes(action)) throw new Error('决策动作不合法');
  if (line.status !== 'pending') throw new Error(`该行已${STATUS_LABEL[line.status] || line.status}，不能重复决策`);
  if (action === 'reject' && !String(note || '').trim()) throw new Error('驳回必须写原因');
  if (action === 'reject' && String(note || '').trim().length < 4) throw new Error('驳回原因太短，请写清为什么');

  let approvedQty = 0;
  if (action === 'approve') {
    if (line.kind !== 'replenish') throw new Error('停补 / 观察行没有可批准的数量，请用「驳回」或「暂缓」');
    approvedQty = qty === undefined || qty === null || qty === '' ? Number(line.suggest_qty) : Number(qty);
    if (!Number.isFinite(approvedQty) || approvedQty <= 0) throw new Error('批准数量必须大于 0');
    if (approvedQty > Number(line.suggest_qty) + 0.001) {
      throw new Error(`批准数量不能超过建议量 ${line.suggest_qty}（要加量请重新生成提案或改策略）`);
    }
  }
  if (action === 'defer' && !String(note || '').trim()) throw new Error('暂缓要写清楚为什么先不动');

  const status = action === 'approve' ? 'approved' : (action === 'reject' ? 'rejected' : 'deferred');
  const ts = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(
      'UPDATE spot_proposal_lines SET status=?, approved_qty=?, decided_by=?, decided_at=?, decide_note=? WHERE id=?'
    ).run(status, approvedQty, operator, ts, note || null, lineId);
    db.prepare(
      `INSERT INTO spot_proposal_decisions (run_id, line_id, action, qty_before, qty_after, note, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(run.id, lineId, action, Number(line.suggest_qty) || 0, approvedQty, note || null, operator, ts);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return {
    line: db.prepare('SELECT * FROM spot_proposal_lines WHERE id = ?').get(lineId),
    note: '已记录决策。系统不会自动下采购单或生产单，请到对应模块按批准数量下单。'
  };
}

/** 已批准行的汇总（给采购/生产做「按批准量下单」的入口清单） */
function approvedDemand(warehouse = 'us') {
  const cur = db.prepare(
    'SELECT * FROM spot_proposal_runs WHERE warehouse = ? AND is_current = 1'
  ).get(warehouse);
  if (!cur) return { run: null, rows: [] };
  const rows = db.prepare(
    `SELECT style_no, product_name, color, size, sku, SUM(approved_qty) qty, MIN(suggest_order_date) need_by
     FROM spot_proposal_lines
     WHERE run_id = ? AND status = 'approved' AND approved_qty > 0
     GROUP BY style_no, color, size
     ORDER BY need_by`
  ).all(cur.id);
  return {
    run: cur,
    rows: rows.map((r) => ({ ...r, qty: r2(r.qty) })),
    total: r2(rows.reduce((a, r) => a + Number(r.qty), 0))
  };
}

function dict() {
  return {
    kind: Object.entries(KIND_LABEL).map(([k, v]) => ({ k, v })),
    status: Object.entries(STATUS_LABEL).map(([k, v]) => ({ k, v })),
    reason: Object.entries(REASON).map(([k, v]) => ({ k, v })),
    defaults: DEFAULT_POLICY
  };
}

module.exports = {
  REASON,
  KIND_LABEL,
  STATUS_LABEL,
  DEFAULT_POLICY,
  todayStr,
  addDays,
  dayDiff,
  listPolicies,
  resolvePolicy,
  snapshot,
  markSizeBroken,
  advise,
  styleOverview,
  generateRun,
  listRuns,
  runView,
  publishRun,
  archiveRun,
  decideLine,
  approvedDemand,
  dict,
  r2
};
