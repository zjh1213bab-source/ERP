/**
 * 齐套与缺料演示数据
 *   node scripts/seed-requirements.js
 *
 * 造三张「已评审通过、待生产」的订单，让库存在多单之间按承诺日争抢：
 *   SO-010 承诺 11-05，要 850 米面料 — 库存 300 先给它
 *   SO-011 承诺 11-12，要 510 米面料 — 只剩在途 500，缺 10
 *   SO-005 承诺 11-04，要 510 米面料 — 库存/在途都被前两单抢完，全缺
 * 辅料同样制造差异：主唛只有 800 个，用不到三单合计。
 */
const { db, now } = require('../src/db');
const { calcAll } = require('../src/routes/requirements');

const t = now();
const addDays = (d, n) => {
  const x = new Date(String(d).slice(0, 10) + 'T00:00:00');
  x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
};
const today = t.slice(0, 10);

/** 找档案 */
const mat = (kw) => db.prepare("SELECT * FROM materials WHERE name LIKE ? AND status = 'active' ORDER BY id LIMIT 1").get('%' + kw + '%');
const FABRIC = mat('600 32S精梳拉架');
const BUTTON = mat('树脂四眼扣');
const LABEL = mat('主唛');
const OPP = mat('OPP');

/** 1. 物料库存：故意不足 */
const setStock = (id, qty) => db.prepare('UPDATE materials SET stock_qty = ?, updated_at = ? WHERE id = ?').run(qty, t, id);
if (FABRIC) setStock(FABRIC.id, 300);   // 三单合计要 1870 米
if (BUTTON) setStock(BUTTON.id, 2000);  // 够用（每件 5 个）
if (LABEL) setStock(LABEL.id, 800);     // 三单合计 2120 套，缺
if (OPP) setStock(OPP.id, 5000);

/** 2. 在途采购：面料 500 米、主唛 500 套 */
function ensurePO(no, supplier, status, date, items) {
  let po = db.prepare('SELECT * FROM purchase_orders WHERE po_no = ?').get(no);
  if (!po) {
    const info = db.prepare(
      'INSERT INTO purchase_orders (po_no, supplier, status, order_date, expect_date, remark, total_amount, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(no, supplier, status, date, addDays(date, 10), '齐套演示：在途采购', 0, 'system', t, t);
    po = { id: Number(info.lastInsertRowid) };
    items.forEach((it) => {
      db.prepare('INSERT INTO purchase_items (po_id, material_id, name, spec, unit, qty, received_qty, price, amount) VALUES (?,?,?,?,?,?,0,?,?)')
        .run(po.id, it.id, it.name, it.spec || '', it.unit || '米', it.qty, it.price || 0, (it.qty || 0) * (it.price || 0));
    });
  }
  return po;
}
if (FABRIC) ensurePO('CG202610270001', FABRIC.supplier || '蒙特布料', 'ordered', today, [{ id: FABRIC.id, name: FABRIC.name, qty: 500, unit: '米', price: FABRIC.stock_qty ? 32.8 : 32.8 }]);
if (LABEL) ensurePO('CG202610270002', LABEL.supplier || '晟彩数码科技', 'ordered', today, [{ id: LABEL.id, name: LABEL.name, qty: 500, unit: '套', price: 0.65 }]);

/** 3. 订单 5 的开发单补物料（原来没明细，齐套算不出来） */
function fillMaterials(techPackId, qty) {
  const exist = db.prepare('SELECT COUNT(*) AS c FROM tech_pack_materials WHERE tech_pack_id = ?').get(techPackId).c;
  if (exist) return exist;
  const ins = db.prepare(
    `INSERT INTO tech_pack_materials
     (tech_pack_id, material_id, mat_type, colorway, material_name, color_no, supplier, supplier_info, spec_info,
      composition, unit, one_use, loss_rate, air_gap, unit_price, amount, use_part, sort, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const plan = [
    [FABRIC, 'fabric', '黑色', 0.85, 32.8, '整件'],
    [BUTTON, 'accessory', '黑色', 5, 0.08, '门襟'],
    [LABEL, 'accessory', '通配', 1, 0.65, '后领中'],
    [OPP, 'accessory', '透明', 1, 0.12, '包装']
  ].filter((x) => x[0]);

  plan.forEach(([m, type, color, use, price, part], i) => {
    const spec = [m.width ? '幅宽' + m.width : '', m.weight ? '克重' + m.weight : ''].filter(Boolean).join(' ');
    ins.run(techPackId, m.id, type, color, m.name, m.color_no || '', m.supplier || '', m.supplier_info || '', spec,
      m.composition || '', m.unit || '', use, 3, 0, price, Math.round(use * price * 100) / 100, part, i, t);
  });
  return plan.length;
}

const tp5 = db.prepare("SELECT * FROM tech_packs WHERE order_id = 5 AND status = 'confirmed' ORDER BY id LIMIT 1").get();
if (tp5) console.log('订单5 开发单补物料:', fillMaterials(tp5.id, 600), '行');

/** 4. 新建两张待生产订单 */
function createOrder({ no, qty, styleName, deliveryDays, promiseDays }) {
  const exist = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(no);
  if (exist) return exist.id;
  const cust = db.prepare('SELECT * FROM customers ORDER BY id LIMIT 1').get();
  const rate = 6.5;
  const unitUsd = 13.88;
  const totalUsd = Math.round(unitUsd * qty * 100) / 100;
  const info = db.prepare(
    `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency, style_name,
      manager, order_date, delivery_date, created_by, created_at, updated_at)
     VALUES (?,?,?, 'draft', ?,?,?, 'USD', ?,?,?,?,?,?,?)`
  ).run(no, 'custom', cust.id, rate, totalUsd, Math.round(totalUsd * rate * 100) / 100, styleName,
    '李静', today, addDays(today, deliveryDays), 1, t, t);
  const orderId = Number(info.lastInsertRowid);

  const itemInfo = db.prepare(
    'INSERT INTO order_items (order_id, product_id, product_name, style_no, sku, color, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(orderId, null, styleName, 'LEJE-AW-2601', 'LEJE-SY-001', '藏青', qty, totalUsd, Math.round(totalUsd * rate * 100) / 100);
  const itemId = Number(itemInfo.lastInsertRowid);
  db.prepare('INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?)')
    .run(itemId, '藏青', 'M', qty, unitUsd, Math.round(unitUsd * rate * 100) / 100, totalUsd, Math.round(totalUsd * rate * 100) / 100);

  // 开发单 + 物料
  const tpInfo = db.prepare(
    "INSERT INTO tech_packs (order_id, product_name, version, status, stage, created_at, updated_at) VALUES (?,?, 'V1', 'draft', 'draft', ?, ?)"
  ).run(orderId, styleName, t, t);
  fillMaterials(Number(tpInfo.lastInsertRowid), qty);

  // 承诺单：直接 approved，承诺日按传入
  db.prepare(
    `INSERT INTO commitments (order_id, order_no, customer_name, style_no, qty, route_type, t0_at, t0_source,
      promised_date, review_status, front_ok, back_ok, material_ok, review_note, reviewed_by, reviewed_at, created_at, updated_at)
     VALUES (?,?,?,?,?, 'inhouse', ?, 'confirm', ?, 'approved', 1,1,1, ?, 'system', ?, ?, ?)`
  ).run(orderId, no, cust.name, styleName, qty, today, addDays(today, promiseDays),
    '齐套演示单：裁床与缝制档期已确认', t, t, t);

  return orderId;
}

const id10 = createOrder({ no: 'SO202610260010', qty: 1000, styleName: '女式针织开衫 B 款', deliveryDays: 30, promiseDays: 9 });
const id11 = createOrder({ no: 'SO202610260011', qty: 600, styleName: '女式针织开衫 C 款', deliveryDays: 40, promiseDays: 16 });
console.log('新建订单:', id10, id11);

/** 5. 重算齐套 */
const r = calcAll();
console.log('齐套计算:', JSON.stringify(r));

db.prepare(
  `SELECT order_no, material_name, mat_type, need_qty, alloc_stock, alloc_po, gap_qty, status
   FROM material_requirements WHERE gap_qty > 0.005 ORDER BY order_no, mat_type`
).all().forEach((x) =>
  console.log('  缺口', x.order_no, x.material_name, `${x.need_qty}(库${x.alloc_stock}+途${x.alloc_po})`, '缺', x.gap_qty, x.status));
