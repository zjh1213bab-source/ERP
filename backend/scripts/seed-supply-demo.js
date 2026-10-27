/**
 * 供给批次与预订演示数据（M23）
 * ------------------------------------------------------------
 * 造出来的情形都是「真会出事」的那几种：
 *   · 一个批次已上架 → 未来可订必须是 0（不能和现货重复算）
 *   · 一个父批拆了子批 → 父批不再单独算可订量（否则同一批货卖两次）
 *   · 一个批次实收后只检验了一部分 → 未检的不能承诺
 *   · 一个批次短装 40 件 → 已承诺 120 保留，形成缺口等人工决议（不隐瞒、不超售）
 *   · 一条现货占用已拣 10 件 → 可买量只扣占用，不再重复扣「已拣」
 *   · 一条临时占用 20 小时内到期 → 到期清理会释放
 *   · 一条占用已转订单 → 数量没有回到可卖池（不先释放再抢量）
 *   · 一条申请只有意向没确认 → 不占量
 *
 * 幂等：--reset 先按演示标记 + 演示款号清掉上一批，再重建。
 */
const { db } = require('../src/db');
const { localDate, localNow } = require('../src/services/sla');
const S = require('../src/services/supply');

const TAG = 'SUPDEMO';
const STYLE = 'SP-DEMO-01';
const TODAY = localDate();
const OP = { name: '美仓-现货主责', username: 'wh01', role: 'warehouse', id: 6 };
const SALES = { name: '销售小王', username: 'sales01', role: 'sales', id: 2 };

function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const t = new Date(y, m - 1, d);
  t.setDate(t.getDate() + Number(n || 0));
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function addHoursTs(h) {
  const d = new Date();
  d.setHours(d.getHours() + h);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** ==================== 清理 ==================== */
function reset() {
  const out = {};
  const scope = "scope_key LIKE 'us|SP-DEMO%'";
  out.events = db.prepare(`DELETE FROM projection_events WHERE ${scope}`).run().changes;
  out.proj = db.prepare("DELETE FROM sellable_projection WHERE style_no LIKE 'SP-DEMO%'").run().changes;
  // 演示款号上的申请/占用一律清掉（含手工试出来的、没带标记的），
  // 否则它们会一直占着可卖量，让演示数字每次都不一样
  out.shortages = db.prepare(`DELETE FROM booking_shortages
    WHERE demo_tag=? OR sku LIKE 'SP-DEMO%'`).run(TAG).changes;
  out.holds = db.prepare(`DELETE FROM stock_holds
    WHERE demo_tag=? OR style_no LIKE 'SP-DEMO%'
       OR (batch_id IS NOT NULL AND batch_id NOT IN (SELECT id FROM supply_batches))`).run(TAG).changes;
  out.requests = db.prepare(`DELETE FROM booking_requests
    WHERE demo_tag=? OR style_no LIKE 'SP-DEMO%'`).run(TAG).changes;
  out.moves = db.prepare('DELETE FROM supply_batch_moves WHERE batch_id IN (SELECT id FROM supply_batches WHERE demo_tag=?)').run(TAG).changes;
  out.batches = db.prepare('DELETE FROM supply_batches WHERE demo_tag=?').run(TAG).changes;
  // 现货演示库存与流水
  const items = db.prepare("SELECT id FROM stock_items WHERE style_no LIKE 'SP-DEMO%'").all().map((r) => r.id);
  out.stock = items.length ? db.prepare(`DELETE FROM stock_items WHERE id IN (${items.map(() => '?').join(',')})`).run(...items).changes : 0;
  out.ledger = db.prepare("DELETE FROM stock_ledger WHERE style_no LIKE 'SP-DEMO%'").run().changes;
  const ids = db.prepare("SELECT id FROM customers WHERE code LIKE 'SPDEMO%'").all().map((r) => r.id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    out.order_items = db.prepare(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id IN (${ph}))`).run(...ids).changes;
    out.orders = db.prepare(`DELETE FROM orders WHERE customer_id IN (${ph})`).run(...ids).changes;
    out.customers = db.prepare(`DELETE FROM customers WHERE id IN (${ph})`).run(...ids).changes;
  }
  return out;
}

/** ==================== 造数 ==================== */
function run() {
  const out = { reset: reset() };
  const t = TODAY;

  /** ---------- 客户 ---------- */
  const mkCust = (code, name, owner) => db.prepare(`INSERT INTO customers
    (code,name,level,credit_limit,status,remark,created_at,updated_at,company_id,owner_user_id,owner_name)
    VALUES (?,?,'A',300000,'active',?,?,?,1,?,?)`).run(
    code, name, TAG, localNow(), localNow(), owner.id, owner.name
  ).lastInsertRowid;
  const c1 = mkCust('SPDEMO01', 'West Coast Apparel Inc.', SALES);
  const c2 = mkCust('SPDEMO02', 'Nordic Textile AB', SALES);

  /** ---------- 现货库存（美国仓，已上架可售） ---------- */
  const mkStock = (color, size, qty) => {
    db.prepare(`INSERT INTO stock_items (warehouse,style_no,product_name,color,size,qty,updated_at)
      VALUES ('us',?,?,?,?,?,?)`).run(STYLE, '女式连帽卫衣', color, size, qty, localNow());
    db.prepare(`INSERT INTO stock_ledger (warehouse,style_no,product_name,color,size,type,qty,ref_type,ref_id,remark,operator,created_at)
      VALUES ('us',?,?,?,?,'in',?,'seed',0,'期初现货',?,?)`).run(
      STYLE, '女式连帽卫衣', color, size, qty, TAG, localNow()
    );
  };
  mkStock('藏青', 'S', 120);
  mkStock('藏青', 'M', 80);
  mkStock('米白', 'S', 60);

  /** ---------- 供给批次 ---------- */
  let seq = 0;
  const mkBatch = (b) => {
    seq += 1;
    const no = `SB${TODAY.replace(/-/g, '')}${String(seq).padStart(4, '0')}`;
    const info = db.prepare(`INSERT INTO supply_batches
      (batch_no,company_id,owner_company_id,warehouse,style_no,product_name,color,size,sku,source_type,source_no,order_id,customer_id,
       qc_grade,intended_use,stage,qty_planned,qty_produced,qty_ready,qty_in_transit,qty_received,qty_checked_ok,qty_on_shelf,
       qty_short,risk_buffer,frozen_qty,eta_date,eta_evidence,eta_covered,parent_batch_id,split_qty,status,note,created_by,demo_tag,created_at,updated_at)
      VALUES (?,1,1,'us',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,'active',?,?,?,?,?)`).run(
      no, STYLE, '女式连帽卫衣', b.color, b.size, `${STYLE}/${b.color}/${b.size}`,
      b.source_type || 'production', b.source_no || null, b.order_id || null, b.customer_id || null,
      b.qc_grade || 'A', b.use || 'sellable', b.stage,
      b.planned || 0, b.produced || 0, b.ready || 0, b.transit || 0, b.received || 0, b.checked || 0, b.shelf || 0,
      b.short || 0, b.buffer || 0,
      b.eta || null, b.evidence || null, b.eta && b.evidence ? 1 : 0,
      b.parent || null, b.split || null, b.note || null, TAG, TAG, localNow(), localNow()
    );
    const id = info.lastInsertRowid;
    const base = b.planned || b.produced || b.ready || b.transit || b.received || b.checked || 0;
    db.prepare(`INSERT INTO supply_batch_moves (batch_id,from_stage,to_stage,qty,qty_before,qty_after,holds_carried,operator,note,created_at)
      VALUES (?,NULL,?,?,0,?,0,?,?,?)`).run(id, 'in_production', base, base, TAG, '建批次', localNow());
    // 补齐到当前阶段的过程记录（演示时间线要看得出「怎么走到这一步的」）
    const PATH = ['in_production', 'ready_to_ship', 'in_transit', 'received_checked', 'on_shelf'];
    const idx = PATH.indexOf(b.stage);
    const stageQtyOf = {
      ready_to_ship: b.ready || base, in_transit: b.transit || base,
      received_checked: b.received || base, on_shelf: b.shelf || b.checked || base
    };
    const noteOf = {
      ready_to_ship: `下线待发（${b.evidence || '待补依据'}）`,
      in_transit: '已装柜出运',
      received_checked: '到仓点收，待检',
      on_shelf: '检验合格，上架可售'
    };
    for (let i = 1; i <= idx; i++) {
      const to = PATH[i];
      const q = stageQtyOf[to] || base;
      db.prepare(`INSERT INTO supply_batch_moves (batch_id,from_stage,to_stage,qty,qty_before,qty_after,holds_carried,operator,note,created_at)
        VALUES (?,?,?,?,?,?,0,?,?,?)`).run(
        id, PATH[i - 1], to, q, q, q, TAG, noteOf[to] || null, localNow()
      );
    }
    return id;
  };

  const bProduction = mkBatch({
    color: '藏青', size: 'S', stage: 'in_production', planned: 500,
    eta: addDays(t, 25), evidence: '排产单 PP-2026-1024（含工序完工计划）',
    source_no: 'PP-2026-1024', note: '下一批大货，尚在产'
  });
  const bReady = mkBatch({
    color: '藏青', size: 'S', stage: 'ready_to_ship', planned: 300, produced: 300, ready: 300,
    eta: addDays(t, 12), evidence: '订舱 SO-8831（船期 11-08）', note: '已下线待发，可接预订'
  });
  const bTransit = mkBatch({
    color: '藏青', size: 'M', stage: 'in_transit', planned: 240, produced: 240, ready: 240, transit: 240,
    eta: addDays(t, 5), evidence: '提单 B/L COSU6231887', note: '在途，可接预订'
  });
  // 实收后只检验了一部分：未检的不能承诺
  const bReceived = mkBatch({
    color: '米白', size: 'S', stage: 'received_checked', planned: 200, produced: 200, ready: 160, transit: 160,
    received: 50, checked: 150, buffer: 10,
    eta: t, evidence: '到仓签收单 RC-2026-1022', note: '实收 200，已检 150、待检 50'
  });
  // 已上架：归现货，未来可订必须 0
  // 已上架的数量必须与现货库存对得上（80 = 期初现货里的藏青/M），
  // 否则「批次说上架 120、库存只有 80」会让人以为账实不符
  const bShelf = mkBatch({
    color: '藏青', size: 'M', stage: 'on_shelf', planned: 80, produced: 80, ready: 80, transit: 80,
    received: 80, checked: 80, shelf: 80,
    eta: addDays(t, -6), evidence: '上架单 PT-2026-1020', note: '已上架，未来可订按 0 算'
  });
  // 父批 + 子批：父批不再单独算可订
  const bParent = mkBatch({
    color: '藏青', size: 'S', stage: 'in_transit', planned: 200, produced: 200, ready: 200, transit: 120,
    eta: addDays(t, 8), evidence: '提单 B/L COSU6231999', note: '分两车发，先到 80 已拆子批'
  });
  const bChild = mkBatch({
    color: '藏青', size: 'S', stage: 'in_transit', planned: 80, produced: 80, ready: 80, transit: 80,
    eta: addDays(t, 3), evidence: '提单 B/L COSU6231999-1（子批）',
    parent: bParent, split: 80, note: '父批拆分出的子批'
  });
  // 短装批次：已承诺 120，实际只有 100 → 缺口
  const bShort = mkBatch({
    color: '米白', size: 'S', stage: 'received_checked', planned: 140, produced: 140, ready: 140, transit: 140,
    received: 140, checked: 100, short: 40,
    eta: addDays(t, -2), evidence: '到仓签收单 RC-2026-1019', note: '短装 40（来料不足）'
  });

  out.batches = { bProduction, bReady, bTransit, bReceived, bShelf, bParent, bChild, bShort };

  /** ---------- 预订申请 ---------- */
  const mkReq = (b) => {
    const no = `BK${TODAY.replace(/-/g, '')}${String(++seq).padStart(4, '0')}`;
    const info = db.prepare(`INSERT INTO booking_requests
      (request_no,company_id,customer_id,customer_name,channel,style_no,color,size,sku,qty,expect_date,quote_price,currency,
       kind,batch_id,status,valid_until,idempotency_key,version,sales_user_id,sales_confirmed_at,reject_reason,note,created_by,demo_tag,created_at,updated_at)
      VALUES (?,1,?,?,?,?,?,?,?,?,?,?,'CNY',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      no, b.customer_id, b.customer_name, b.channel || 'mall', STYLE, b.color, b.size, `${STYLE}/${b.color}/${b.size}`,
      b.qty, b.expect || null, b.price, b.kind, b.batch_id || null, b.status, b.valid_until || addDays(t, 7),
      b.idem || null, b.version || 1,
      b.status === 'sales_confirmed' || b.status === 'converted' ? SALES.id : null,
      b.status === 'sales_confirmed' || b.status === 'converted' ? addHoursTs(-6) : null,
      b.reject_reason || null, b.note || null, TAG, TAG, localNow(), localNow()
    );
    return info.lastInsertRowid;
  };
  // 只有意向：不占量
  const r1 = mkReq({ customer_id: c1, customer_name: 'West Coast Apparel Inc.', color: '藏青', size: 'S', qty: 100, kind: 'future', batch_id: bReady, status: 'submitted', price: 78, expect: addDays(t, 20), note: '客户要 11 月中到仓' });
  // 已确认：占量
  const r2 = mkReq({ customer_id: c2, customer_name: 'Nordic Textile AB', color: '藏青', size: 'M', qty: 80, kind: 'future', batch_id: bTransit, status: 'sales_confirmed', price: 82, expect: addDays(t, 10) });
  // 现货申请：待确认
  const r3 = mkReq({ customer_id: c1, customer_name: 'West Coast Apparel Inc.', color: '藏青', size: 'S', qty: 40, kind: 'spot', status: 'submitted', price: 76, note: '要现货，越快越好' });
  // 驳回
  const r4 = mkReq({ customer_id: c2, customer_name: 'Nordic Textile AB', color: '米白', size: 'S', qty: 60, kind: 'future', batch_id: bShort, status: 'rejected', price: 80, reject_reason: '该批次短装，可承诺量不足，建议等下一批' });
  // 过期（有效期内没确认）
  const r5 = mkReq({ customer_id: c1, customer_name: 'West Coast Apparel Inc.', color: '米白', size: 'S', qty: 30, kind: 'future', batch_id: bReceived, status: 'submitted', price: 80, valid_until: addDays(t, -3), note: '报价已过期，待清理' });

  /** ---------- 占用 ---------- */
  const mkHold = (b) => {
    const no = `HD${TODAY.replace(/-/g, '')}${String(++seq).padStart(4, '0')}`;
    const info = db.prepare(`INSERT INTO stock_holds
      (hold_no,company_id,kind,batch_id,warehouse,style_no,color,size,sku,qty,qty_picked,customer_id,customer_name,request_id,order_id,
       status,temporary,expires_at,version,release_reason,released_by,released_at,converted_at,created_by,demo_tag,created_at,updated_at)
      VALUES (?,1,?,?,'us',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      no, b.kind, b.batch_id || null, STYLE, b.color, b.size, `${STYLE}/${b.color}/${b.size}`,
      b.qty, b.picked || 0, b.customer_id || null, b.customer_name || null, b.request_id || null, b.order_id || null,
      b.status, b.temporary === 0 ? 0 : 1, b.expires || null, b.version || 1,
      b.release_reason || null, b.released_by || null, b.released_at || null, b.converted_at || null,
      TAG, TAG, localNow(), localNow()
    );
    return info.lastInsertRowid;
  };
  // 未来供给占用（对应已确认申请）
  const hTransit = mkHold({ kind: 'future', batch_id: bTransit, color: '藏青', size: 'M', qty: 80, customer_id: c2, customer_name: 'Nordic Textile AB', request_id: r2, status: 'active', expires: addHoursTs(60) });
  // 短装批次上的占用：20 小时内到期（到期清理演示）
  const hShort = mkHold({ kind: 'future', batch_id: bShort, color: '米白', size: 'S', qty: 120, customer_id: c1, customer_name: 'West Coast Apparel Inc.', status: 'active', expires: addHoursTs(20) });
  // 现货占用：已拣 10 件（是占用的子集，不重复扣）
  const hSpot = mkHold({ kind: 'spot', color: '藏青', size: 'S', qty: 40, picked: 10, customer_id: c2, customer_name: 'Nordic Textile AB', status: 'active', expires: addHoursTs(96) });
  // 已转订单的占用：数量没回可卖池
  const demoOrder = db.prepare(`INSERT INTO orders (order_no,type,customer_id,status,rate,total_usd,total_amount,currency,style_name,
      order_date,created_by,created_at,updated_at,company_id)
    VALUES (?, 'stock', ?, 'production', 7.1, 9859.15, 70000, 'CNY', '女式连帽卫衣', ?, ?, ?, ?, 1)`).run(
    `SUPDEMO${String(++seq).padStart(3, '0')}`, c1, addDays(t, -4), TAG, localNow(), localNow()
  ).lastInsertRowid;
  db.prepare('UPDATE booking_requests SET hold_id=? WHERE id=?').run(hTransit, r2);
  db.prepare('UPDATE booking_requests SET hold_id=? WHERE id=?').run(hSpot, r3);
  const hConverted = mkHold({
    kind: 'spot', color: '藏青', size: 'M', qty: 60, customer_id: c1, customer_name: 'West Coast Apparel Inc.',
    status: 'converted', temporary: 0, order_id: demoOrder, converted_at: addHoursTs(-30)
  });
  // 已到期未清理的占用（演示 sweep）
  mkHold({ kind: 'spot', color: '米白', size: 'S', qty: 15, customer_id: c2, customer_name: 'Nordic Textile AB', status: 'active', expires: addHoursTs(-8) });

  /** ---------- 缺口 ---------- */
  const mkShort = (b) => {
    const no = `SH${TODAY.replace(/-/g, '')}${String(++seq).padStart(4, '0')}`;
    db.prepare(`INSERT INTO booking_shortages
      (shortage_no,batch_id,hold_id,request_id,customer_id,customer_name,sku,qty_short,qty_committed,resolution,substitute_batch_id,decided_by,decided_at,note,demo_tag,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      no, b.batch_id, b.hold_id, b.request_id || null, b.customer_id, b.customer_name, `${STYLE}/${b.color}/${b.size}`,
      b.qty_short, b.qty_committed, b.resolution, b.substitute || null, b.decided_by || null, b.decided_at || null,
      b.note || null, TAG, localNow()
    );
  };
  mkShort({ batch_id: bShort, hold_id: hShort, customer_id: c1, customer_name: 'West Coast Apparel Inc.', color: '米白', size: 'S', qty_short: 20, qty_committed: 120, resolution: 'open', note: '短装 40，按占用先后形成缺口 20' });
  mkShort({ batch_id: bShort, hold_id: hShort, customer_id: c1, customer_name: 'West Coast Apparel Inc.', color: '米白', size: 'S', qty_short: 20, qty_committed: 120, resolution: 'delay', decided_by: '美仓-现货主责', decided_at: addHoursTs(-20), note: '客户同意延到下一批，承诺保留' });

  /** ---------- 重算投影 ---------- */
  const refreshed = S.refreshProjection(OP, 'us');
  out.refreshed = refreshed.refreshed;
  out.ids = { customers: [c1, c2], requests: [r1, r2, r3, r4, r5], holds: [hTransit, hShort, hSpot, hConverted] };
  return out;
}

run();
console.log(`\n[${TAG}] 供给与预订演示数据就绪：今天 ${TODAY}`);
