/**
 * M19 美仓作业计划 —— 演示数据（幂等）
 * ============================================================
 * 造出五条波次覆盖全部状态：
 *   W1 已交承运（库存已扣、占用已收口）
 *   W2 已复核待发（有短拣并写了原因）
 *   W3 拣货中（只拣了一半）
 *   W4 草稿（还没释放）
 *   W5 已取消（未拣，占用已释放）
 * 另有一条现货不足的占用，演示「为什么进不了波次」。
 *
 * 头程：一张 3 段头程（海运已到、卡车在途）+ 箱级短少 + ETA 变更（算出受影响需求）。
 * 库容：三个演示库位（其中一个小库位 95% 接近满），用于演示上架建议与预警。
 *
 * 用法：node scripts/seed-whplan-demo.js --reset
 */
const { db } = require('../src/db');
const { localNow, localDate } = require('../src/services/sla');
const W = require('../src/services/whplan');

const TAG = 'WHPDEMO';
const RESET = process.argv.includes('--reset');
const OP = { name: `demo:${TAG}`, role: 'warehouse', demo_tag: TAG };

const p2 = (n) => String(n).padStart(2, '0');
function addDays(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + Number(n || 0));
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
const today = () => localDate();
const nowStr = localNow();

/* ---------------- 清场 ---------------- */
const out = {};
if (RESET) {
  // 连同冒烟测试留下的波次一起清（它们没有 demo_tag，但 note 带「冒烟」）
  const waveIds = db.prepare("SELECT id FROM pick_waves WHERE demo_tag=? OR note LIKE '%冒烟%'").all(TAG).map((r) => r.id);
  const inW = waveIds.length ? `(${waveIds.map(() => '?').join(',')})` : '(0)';
  out.wave_items = db.prepare(`DELETE FROM pick_wave_items WHERE wave_id IN ${inW}`).run(...waveIds).changes;
  out.waves = db.prepare("DELETE FROM pick_waves WHERE demo_tag=? OR note LIKE '%冒烟%'").run(TAG).changes;

  const asnIds = db.prepare("SELECT id FROM wh_asns WHERE asn_no LIKE 'WHP-ASN-%'").all().map((r) => r.id);
  const inA = asnIds.length ? `(${asnIds.map(() => '?').join(',')})` : '(0)';
  out.legs = db.prepare(`DELETE FROM wh_asn_legs WHERE asn_id IN ${inA}`).run(...asnIds).changes;
  out.boxes = db.prepare(`DELETE FROM wh_asn_boxes WHERE asn_id IN ${inA}`).run(...asnIds).changes;
  out.asn_changes = db.prepare(`DELETE FROM wh_asn_changes WHERE asn_id IN ${inA}`).run(...asnIds).changes;
  out.asn_items = db.prepare(`DELETE FROM wh_asn_items WHERE asn_id IN ${inA}`).run(...asnIds).changes;
  out.receipt_items = db.prepare("DELETE FROM wh_receipt_items WHERE rcv_id IN (SELECT id FROM wh_receipts WHERE rcv_no LIKE 'WHP-RCV-%')").run().changes;
  out.receipts = db.prepare("DELETE FROM wh_receipts WHERE rcv_no LIKE 'WHP-RCV-%'").run().changes;
  out.asns = db.prepare("DELETE FROM wh_asns WHERE asn_no LIKE 'WHP-ASN-%'").run().changes;

  out.holds = db.prepare('DELETE FROM stock_holds WHERE demo_tag=?').run(TAG).changes;
  out.putaways = db.prepare("DELETE FROM wh_putaways WHERE put_no LIKE 'WHP-PUT-%'").run().changes;
  out.locations = db.prepare("DELETE FROM wh_locations WHERE code LIKE 'WHP-%'").run().changes;
  out.ledger = db.prepare("DELETE FROM stock_ledger WHERE ref_type='whplan_demo'").run().changes;
  out.stock = db.prepare("DELETE FROM stock_items WHERE style_no LIKE 'WHP-DEMO%'").run().changes;
}

/* ---------------- 库位 ---------------- */
function mkLoc(code, zone, aisle, capacity, remark) {
  const cur = db.prepare('SELECT * FROM wh_locations WHERE warehouse=? AND code=?').get('us', code);
  if (cur) return Number(cur.id);
  const info = db.prepare(`INSERT INTO wh_locations (warehouse,code,zone,aisle,capacity,status,remark,created_at)
    VALUES ('us',?,?,?,?,'active',?,?)`).run(code, zone, aisle, capacity, remark || TAG, nowStr);
  return Number(info.lastInsertRowid);
}

const locA1 = mkLoc('WHP-A-01', 'sellable', 'A 区小件', 100, '小件快出区（演示）');
const locA2 = mkLoc('WHP-A-02', 'sellable', 'A 区小件', 40, '小件补货位（演示，接近满）');
const locB1 = mkLoc('WHP-B-01', 'sellable', 'B 区整箱', 600, '整箱存储区（演示）');
const locI1 = mkLoc('WHP-I-01', 'inspect', '待检隔离', 200, '待检区（演示）');

/* ---------------- 期初到货与上架 ---------------- */
// 上架记录必须挂在一张点收明细上（rcv_item_id NOT NULL），
// 所以期初库存也走一遍「到货 → 点收 → 上架」，不直接往库位里塞数量。
const initAsn = db.prepare(`INSERT INTO wh_asns
  (asn_no,warehouse,from_warehouse,carrier,container_no,ship_date,eta_date,arrive_date,carton_plan,carton_actual,
   expect_qty,received_qty,damaged_qty,short_qty,over_qty,status,remark,created_by,created_at,updated_at)
  VALUES ('WHP-ASN-000','us','cn','Matson','MATU8800111',?,?,?,8,8,400,400,0,0,0,'done',?,'demo',?,?)`).run(
  addDays(today(), -40), addDays(today(), -12), addDays(today(), -13), `${TAG} 期初到货`, nowStr, nowStr
);
const initAsnId = Number(initAsn.lastInsertRowid);

const rcv = db.prepare(`INSERT INTO wh_receipts
  (rcv_no,asn_id,arrive_date,carton_actual,expect_qty,received_qty,damaged_qty,short_qty,over_qty,status,note,receive_by,received_at,created_at,updated_at)
  VALUES ('WHP-RCV-000',?,?,8,400,400,0,0,0,'done',?, 'demo',?,?,?)`).run(
  initAsnId, addDays(today(), -13), `${TAG} 期初点收（已上架）`, nowStr, nowStr, nowStr
);
const rcvId = Number(rcv.lastInsertRowid);

function stockIn(styleNo, name, color, size, qty, locationId) {
  const asnItem = db.prepare(`INSERT INTO wh_asn_items (asn_id,style_no,product_name,color,size,expect_qty,remark)
    VALUES (?,?,?,?,?,?,?)`).run(initAsnId, styleNo, name, color, size, qty, TAG);
  const it = db.prepare(`INSERT INTO wh_receipt_items
    (rcv_id,asn_item_id,style_no,product_name,color,size,expect_qty,received_qty,damaged_qty,short_qty,over_qty,put_qty,remark)
    VALUES (?,?,?,?,?,?,?,?,0,0,0,0,?)`).run(
    rcvId, Number(asnItem.lastInsertRowid), styleNo, name, color, size, qty, qty, TAG
  );
  const itemId = Number(it.lastInsertRowid);

  // 同一 SKU 可能分两个库位到货：库存要累加，不能插两行（stock_items 有唯一约束）
  const cur = db.prepare(`SELECT * FROM stock_items WHERE warehouse='us' AND style_no=? AND color=? AND size=?`)
    .get(styleNo, color, size);
  if (cur) db.prepare('UPDATE stock_items SET qty=?, updated_at=? WHERE id=?').run(Number(cur.qty) + Number(qty), nowStr, cur.id);
  else db.prepare(`INSERT INTO stock_items (warehouse,style_no,product_name,color,size,qty,updated_at)
    VALUES ('us',?,?,?,?,?,?)`).run(styleNo, name, color, size, qty, nowStr);
  db.prepare(`INSERT INTO stock_ledger (warehouse,style_no,product_name,color,size,type,qty,ref_type,ref_id,remark,operator,created_at)
    VALUES ('us',?,?,?,?,'in',?,'whplan_demo',NULL,?,?,?)`).run(
    styleNo, name, color, size, qty, `${TAG} 期初上架`, TAG, nowStr
  );
  // 上架记录带 SKU，拣货才能按「这个 SKU 在哪个库位」分配
  db.prepare(`INSERT INTO wh_putaways (put_no,rcv_item_id,location_id,qty,operator,put_at,remark,style_no,color,size)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    `WHP-PUT-${styleNo}-${color}-${size}-${locationId}`, itemId, locationId, qty, TAG, nowStr, `${TAG} 期初上架`, styleNo, color, size
  );
  db.prepare('UPDATE wh_receipt_items SET put_qty=? WHERE id=?').run(qty, itemId);
}

stockIn('WHP-DEMO-01', '美仓现货羊毛开衫', '藏青', 'M', 38, locA2);   // 小库位 95%
stockIn('WHP-DEMO-01', '美仓现货羊毛开衫', '藏青', 'M', 162, locB1);
stockIn('WHP-DEMO-02', '美仓现货卫衣', '米白', 'L', 120, locB1);
stockIn('WHP-DEMO-03', '美仓现货休闲裤', '黑色', 'L', 60, locA1);

/* ---------------- 占用 ---------------- */
const cust = (id) => db.prepare('SELECT id,name FROM customers WHERE id=?').get(Number(id));
const c1 = cust(1) || { id: 1, name: '示范客户·美国 ABC' };
const c2 = cust(2) || { id: 2, name: '示范客户·欧洲 DEF' };

function mkHold(no, customer, styleNo, color, size, qty, note) {
  const info = db.prepare(`INSERT INTO stock_holds
    (hold_no,company_id,kind,batch_id,warehouse,style_no,color,size,sku,qty,qty_picked,customer_id,customer_name,
     request_id,order_id,status,temporary,expires_at,version,demo_tag,created_by,created_at,updated_at)
    VALUES (?,1,'spot',NULL,'us',?,?,?,?,?,0,?,?,NULL,NULL,'active',0,?,1,?,?,?,?)`).run(
    no, styleNo, color, size, `${styleNo}/${color}/${size}`, qty, customer.id, customer.name,
    addDays(today(), 7), TAG, note || TAG, nowStr, nowStr
  );
  return Number(info.lastInsertRowid);
}

const h1 = mkHold('WHP-HD-01', c1, 'WHP-DEMO-01', '藏青', 'M', 12, '客户批发单预留');
const h2 = mkHold('WHP-HD-02', c2, 'WHP-DEMO-01', '藏青', 'M', 8, '客户零售单预留');
const h3 = mkHold('WHP-HD-03', c1, 'WHP-DEMO-02', '米白', 'L', 6, '客户补货预留');
const h4 = mkHold('WHP-HD-04', c2, 'WHP-DEMO-03', '黑色', 'L', 5, '客户试单预留');
const h5 = mkHold('WHP-HD-05', c1, 'WHP-DEMO-01', '藏青', 'M', 300, '占用超过实物：演示「进不了波次」');
const h6 = mkHold('WHP-HD-06', c1, 'WHP-DEMO-03', '黑色', 'L', 3, '草稿波次用');
const h7 = mkHold('WHP-HD-07', c2, 'WHP-DEMO-02', '米白', 'L', 4, '取消波次用');

/* ---------------- 波次 ---------------- */
function wave(holdIds, label) {
  const r = W.createWave({ warehouse: 'us', hold_ids: holdIds, note: `${TAG} ${label}` }, OP);
  db.prepare('UPDATE pick_waves SET demo_tag=? WHERE id=?').run(TAG, r.wave.id);
  return r;
}

const pickedLines = [];
const w1 = wave([h1, h2], '整波发货');
W.releaseWave(w1.wave.id, OP);
W.getWave(w1.wave.id).items.forEach((it) => { W.pickItem(w1.wave.id, it.id, { qty: it.qty }, OP); });
W.packWave(w1.wave.id, { weight: 6.4, carrier: 'UPS', tracking_no: '1Z-WHP-0001', short_reason: null }, OP);
const w1s = W.shipWave(w1.wave.id, OP);
pickedLines.push(`W1 ${w1s.wave_no} 已交承运，发 ${w1s.qty_picked} 件`);

const w2 = wave([h3], '短拣演示');
W.releaseWave(w2.wave.id, OP);
const w2items = W.getWave(w2.wave.id).items;
W.pickItem(w2.wave.id, w2items[0].id, { qty: 4 }, OP);
const w2p = W.packWave(w2.wave.id, {
  weight: 2.1, carrier: 'UPS', tracking_no: '1Z-WHP-0002',
  short_reason: '客户催货，先发 4 件，剩余 2 件下批补'
}, OP);
pickedLines.push(`W2 ${w2p.wave_no} 已复核（短拣 ${w2p.shortfall} 件，待发）`);

const w3 = wave([h4], '拣货中');
W.releaseWave(w3.wave.id, OP);
W.pickItem(w3.wave.id, W.getWave(w3.wave.id).items[0].id, { qty: 2 }, OP);
pickedLines.push(`W3 ${w3.wave.wave_no} 拣货中（1 行只拣了 2 件）`);

const w4 = wave([h6], '草稿');
pickedLines.push(`W4 ${w4.wave.wave_no} 草稿（未释放）`);

const w5 = wave([h7], '取消演示');
W.releaseWave(w5.wave.id, OP);
const w5c = W.cancelWave(w5.wave.id, { reason: '客户改单，整波取消', confirm_return: false }, OP);
pickedLines.push(`W5 ${w5c.wave_no} 已取消（未拣，占用已释放）`);

// 现货不足的占用尝试进波次（应被跳过；全部不可行时服务层会抛错，这里接住原因）
let skipTry = { skipped: [] };
try {
  skipTry = W.createWave({ warehouse: 'us', hold_ids: [h5], note: `${TAG} 现货不足尝试` }, OP);
} catch (e) {
  skipTry = { skipped: [{ hold_no: 'WHP-HD-05', reason: e.message }] };
}

/* ---------------- 头程 ---------------- */
const asnInfo = db.prepare(`INSERT INTO wh_asns
  (asn_no,warehouse,from_warehouse,carrier,container_no,ship_date,eta_date,carton_plan,carton_actual,
   expect_qty,received_qty,damaged_qty,short_qty,over_qty,status,remark,created_by,created_at,updated_at)
  VALUES ('WHP-ASN-001','us','cn','Matson','MATU9900123',?,?,12,0,400,0,0,0,0,'in_transit',?,'demo',?,?)`).run(
  addDays(today(), -17), addDays(today(), 9), `${TAG} 头程演示`, nowStr, nowStr
);
const asnId = Number(asnInfo.lastInsertRowid);
db.prepare(`INSERT INTO wh_asn_items (asn_id,style_no,product_name,color,size,expect_qty,carton_no,remark)
  VALUES (?,?,?,?,?,?,?,?)`).run(asnId, 'WHP-DEMO-01', '美仓现货羊毛开衫', '藏青', 'M', 220, 'C1-C7', TAG);
db.prepare(`INSERT INTO wh_asn_items (asn_id,style_no,product_name,color,size,expect_qty,carton_no,remark)
  VALUES (?,?,?,?,?,?,?,?)`).run(asnId, 'WHP-DEMO-02', '美仓现货卫衣', '米白', 'L', 180, 'C8-C12', TAG);

const leg1 = W.addLeg(asnId, { mode: 'ocean', carrier: 'Matson', etd: addDays(today(), -17), eta: addDays(today(), -1), note: '宁波 → 洛杉矶' }, OP);
W.arriveLeg(leg1.id, { actual_at: today() }, OP);
W.addLeg(asnId, { mode: 'truck', carrier: 'XPO', etd: addDays(today(), 1), eta: addDays(today(), 3), note: '洛杉矶港 → 安大略仓' }, OP);

// 箱级：一箱齐、一箱短少（外箱破损）、一箱多到
W.addBox(asnId, { carton_no: 'C1', style_no: 'WHP-DEMO-01', expect_qty: 120, received_qty: 120 }, OP);
W.addBox(asnId, { carton_no: 'C2', style_no: 'WHP-DEMO-01', expect_qty: 100, received_qty: 98, short_qty: 2, reason: '外箱破损，2 件污损退回' }, OP);
W.addBox(asnId, { carton_no: 'C3', style_no: 'WHP-DEMO-02', expect_qty: 60, received_qty: 61, over_qty: 1, reason: '工厂多发 1 件' }, OP);

// ETA 变更：算出受影响的有效占用与待确认申请
const etaChange = W.changeEta(asnId, { eta_date: addDays(today(), 5), reason: '船公司调整班期，整体顺延两天' }, OP);

// 另一张已有的在途头程补运输段（把历史数据补成可跟踪的）
const oldAsn = db.prepare("SELECT * FROM wh_asns WHERE asn_no='ASN-DEMO-001'").get();
if (oldAsn && !db.prepare('SELECT COUNT(*) c FROM wh_asn_legs WHERE asn_id=?').get(oldAsn.id).c) {
  const l = W.addLeg(oldAsn.id, { mode: 'ocean', carrier: oldAsn.carrier || 'Matson', etd: oldAsn.ship_date || addDays(today(), -6), eta: oldAsn.eta_date || addDays(today(), 5), note: '宁波 → 洛杉矶（补录）' }, OP);
  db.prepare("UPDATE wh_asn_legs SET status='in_transit' WHERE id=?").run(l.id);
}

/* ---------------- 输出 ---------------- */
const cnt = (t, w = '') => Number(db.prepare(`SELECT COUNT(*) c FROM ${t} ${w}`).get().c);
console.log(`[${TAG}] reset:`, JSON.stringify(out));
console.log(`[${TAG}] 波次 ${cnt('pick_waves', `WHERE demo_tag='${TAG}'`)} 条 / 明细 ${cnt('pick_wave_items', `WHERE wave_id IN (SELECT id FROM pick_waves WHERE demo_tag='${TAG}')`)} 行`);
pickedLines.forEach((l) => console.log('   · ' + l));
console.log(`[${TAG}] 跳过原因：${skipTry.skipped.map((s) => s.hold_no + ' — ' + s.reason).join('；') || '（无）'}`);
console.log(`[${TAG}] 头程：3 段（1 已到 / 1 在途），箱 3 只（短少 2、多到 1），ETA 变更影响 ${etaChange.impacted_cnt} 条需求`);
const cap = W.listCapacity({ warehouse: 'us' }).filter((l) => l.code.startsWith('WHP-'));
cap.forEach((l) => console.log(`   · 库位 ${l.code} ${l.used}/${l.capacity}（${l.pct}%）${l.near_full ? ' 接近满' : ''}${l.anomaly ? ' 超容' : ''}`));
const sug = W.suggestCapacity({ warehouse: 'us', qty: 30 });
console.log(`[${TAG}] 上架建议（30 件）：${sug.blocked ? '拒绝 — ' + sug.reason : sug.location.code + '（剩余 ' + sug.free + '）'}`);
console.log(`[${TAG}] 库存：${db.prepare("SELECT style_no,color,size,qty FROM stock_items WHERE style_no LIKE 'WHP-DEMO%'").all().map((x) => `${x.style_no}/${x.color}/${x.size}=${x.qty}`).join('  ')}`);
