/**
 * 领料按「款 × 颜色」发料 —— 演示数据（幂等）
 * ============================================================
 * 用法：node scripts/seed-issuecolor-demo.js [--reset]
 *
 * 演示的是一张真实的**多款多色**订单怎么领料：
 *
 *   款 A「印花T恤」印花001 / 印花002     款 B「印花卫衣」印花003 / 印花004
 *     面料 32支精梳棉   按色配（001 用 A1 色号 1.35 米，002 用 A2 色号 1.45 米）
 *     面料 双面卫衣布   按色配（003 用 C3，004 用 C4）
 *     纽扣 4 孔         全部颜色通用（4 个/件）
 *     织唛 主标         全部颜色通用（1 个/件）
 *
 * 然后生成一张**分色领料单**并走到「部分发出」：
 *   印花001 发全、印花002 只发了 6 成、印花003 发全、印花004 一米没发
 * —— 这样界面上能同时看到「按色需求 / 按色已发 / 按色欠发」，
 * 以及纽扣那种「不分色」的行和分色行各自扣减互不串味。
 *
 * 全部走 services/matflow 的真实逻辑（备料占用、发料扣减），
 * 演示数据本身就是这一层的回归测试。
 */
const { db } = require('../src/db');
const M = require('../src/services/matflow');
const OMC = require('../src/services/orderMaterialColors');

const TAG = 'issue_color_demo';
const ORDER_NO = 'MCOL-DEMO-1';
const reset = process.argv.includes('--reset');
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
function D(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const ts = `${D(-3)} 10:20:00`;

const MATS = [
  { code: 'IC-DEMO-01', type: 'fabric', name: '32支精梳棉', spec: '160cm', unit: '米', stock: 3000, price: 18 },
  { code: 'IC-DEMO-02', type: 'fabric', name: '双面卫衣布 320G', spec: '165cm', unit: '米', stock: 2400, price: 22 },
  { code: 'IC-DEMO-03', type: 'accessory', name: '树脂纽扣 4 孔 18L', spec: '18L', unit: '个', stock: 20000, price: 0.12 },
  { code: 'IC-DEMO-04', type: 'accessory', name: '织唛主标', spec: '30×30mm', unit: '个', stock: 8000, price: 0.6 }
];

/** 清掉上一次的演示数据（按标记精确清，绝不按「像」清） */
function clean() {
  const o = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(ORDER_NO);
  if (o) {
    const issues = db.prepare('SELECT id FROM material_issues WHERE order_id = ?').all(o.id).map((r) => r.id);
    issues.forEach((id) => {
      db.prepare('DELETE FROM material_return_items WHERE return_id IN (SELECT id FROM material_returns WHERE issue_id = ?)').run(id);
      db.prepare('DELETE FROM material_returns WHERE issue_id = ?').run(id);
      db.prepare('DELETE FROM material_ledger WHERE ref_type IN (?,?) AND ref_id = ?').run('material_issue', 'material_return', id);
      db.prepare('DELETE FROM material_issue_items WHERE issue_id = ?').run(id);
    });
    db.prepare('DELETE FROM material_issues WHERE order_id = ?').run(o.id);
    db.prepare(`DELETE FROM order_material_colors WHERE order_material_id IN
                (SELECT id FROM order_materials WHERE order_id = ?)`).run(o.id);
    db.prepare('DELETE FROM order_materials WHERE order_id = ?').run(o.id);
    db.prepare(`DELETE FROM order_item_sizes WHERE item_id IN
                (SELECT id FROM order_items WHERE order_id = ?)`).run(o.id);
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
  }
  db.prepare("DELETE FROM materials WHERE code LIKE 'IC-DEMO-%'").run();
}

/** 原料档案：库存按演示需要先给足（盘点演示用的是别的料，互不影响） */
function seedMaterials() {
  const ids = {};
  const ins = db.prepare(
    `INSERT INTO materials (type, code, name, spec, unit, stock_qty, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'active', ?, ?)`
  );
  MATS.forEach((m) => {
    const info = ins.run(m.type, m.code, m.name, m.spec, m.unit, m.stock, ts, ts);
    ids[m.code] = Number(info.lastInsertRowid);
    // 期初流水：让台账「账面 = 流水累计」成立，不然盘点差异页会多出一条莫名缺口
    db.prepare(
      `INSERT INTO material_ledger (company_id, material_id, material_name, type, qty, unit, ref_type, ref_no, remark, operator, created_at, demo_tag)
       VALUES (1,?,?, 'receipt', ?, ?, 'demo_open', NULL, '演示期初库存', 'demo', ?, ?)`
    ).run(ids[m.code], m.name, m.stock, m.unit, ts, TAG);
  });
  console.log(`[1] 演示原料 ${MATS.length} 种（${MATS.map((m) => m.name).join('、')}）`);
  return ids;
}

/** 一张 2 款 4 色的订单 + 一份配到「款 × 颜色」的用料 */
function seedOrder(ids) {
  const totalUsd = 150 * 8 + 80 * 8 + 200 * 9 + 120 * 9;
  const o = db.prepare(
    `INSERT INTO orders (order_no, type, status, rate, total_usd, total_amount, currency, style_name,
       cus_order_no, manager, order_date, delivery_method, trade_terms, delivery_date, remark,
       created_at, updated_at, company_id)
     VALUES (?, 'custom', 'production', 7.1, ?, ?, 'USD', ?, 'PO-MCOL-1', '王业务', ?, '海运', 'FOB', ?, ?, ?, ?, 1)`
  ).run(ORDER_NO, totalUsd, round2(totalUsd * 7.1), '多款多色演示单', D(-3), D(18), '按颜色发料演示', ts, ts);
  const orderId = Number(o.lastInsertRowid);

  const mkItem = (name, styleNo, price, colors) => {
    const qty = colors.reduce((s, c) => s + c.sizes.reduce((a, b) => a + b.qty, 0), 0);
    const info = db.prepare(
      `INSERT INTO order_items (order_id, product_name, style_no, qty, amount_usd, amount_cny)
       VALUES (?,?,?,?,?,?)`
    ).run(orderId, name, styleNo, qty, round2(qty * price), round2(qty * price * 7.1));
    const itemId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    colors.forEach((c) => c.sizes.forEach((s) => {
      ins.run(itemId, c.color, s.size, s.qty, price, round2(price * 7.1),
        round2(s.qty * price), round2(s.qty * price * 7.1));
    }));
    return itemId;
  };

  const itemA = mkItem('印花T恤', 'IC-TZ-01', 8, [
    { color: '印花001', sizes: [{ size: 'M', qty: 100 }, { size: 'L', qty: 50 }] },
    { color: '印花002', sizes: [{ size: 'M', qty: 80 }] }
  ]);
  const itemB = mkItem('印花卫衣', 'IC-WY-01', 9, [
    { color: '印花003', sizes: [{ size: 'M', qty: 200 }] },
    { color: '印花004', sizes: [{ size: 'M', qty: 120 }] }
  ]);
  console.log(`[2] 订单 ${ORDER_NO}：印花T恤 230 件（2 色）/ 印花卫衣 320 件（2 色）`);

  /**
   * 用料行：先插，再用 orderMaterialColors 的重算把 total_use 算出来。
   * 手算 total_use 会跟界面上的数越走越远 —— 一份实现只算一次。
   */
  const insMat = db.prepare(
    `INSERT INTO order_materials (order_id, item_id, material_id, type, name, unit, one_use, loss,
       total_use, price, amount, spec, all_colors, created_at)
     VALUES (?,?,?,?,?,?,?,?, 0, ?, 0, ?, ?, ?)`
  );
  const addMat = (itemId, code, oneUse, loss, colors, allColors) => {
    const m = MATS.find((x) => x.code === code);
    const price = m.price;
    const info = insMat.run(orderId, itemId, ids[code], m.type, m.name, m.unit, oneUse, loss, price, m.spec, allColors ? 1 : 0, ts);
    const mid = Number(info.lastInsertRowid);
    if (allColors) {
      OMC.replaceColors(mid, []);
    } else {
      OMC.replaceColors(mid, colors);
    }
    // recalc 一次把 total_use 与 amount 都写回（别自己再算一遍金额，两份实现必然漂移）
    const r = OMC.recalc(mid);
    return { id: mid, total: r.total_use };
  };

  const fabA = addMat(itemA, 'IC-DEMO-01', 1.35, 5, [
    { colorway: '印花001', color_no: 'A1', qty: 1.35 },
    { colorway: '印花002', color_no: 'A2', qty: 1.45 }
  ], false);
  const fabB = addMat(itemB, 'IC-DEMO-02', 0.9, 5, [
    { colorway: '印花003', color_no: 'C3', qty: 0.9 },
    { colorway: '印花004', color_no: 'C4', qty: 0.95 }
  ], false);
  const btn = addMat(itemA, 'IC-DEMO-03', 4, 2, null, true);
  const label = addMat(itemB, 'IC-DEMO-04', 1, 2, null, true);

  console.log(`[3] 用料：精梳棉 ${fabA.total} 米（按色）/ 卫衣布 ${fabB.total} 米（按色）/ 纽扣 ${btn.total} 个 / 织唛 ${label.total} 个`);
  return { orderId, items: [itemA, itemB] };
}

function seedIssue(orderId) {
  const op = 'demo';
  const sug = M.suggestFromOrder(orderId);
  const colored = sug.items.filter((x) => x.color_mode === 'per_color').length;
  console.log(`[4] 备料建议展开成 ${sug.items.length} 行（其中按色 ${colored} 行，不分色 ${sug.items.length - colored} 行）`);

  const doc = M.createIssue({
    order_id: orderId, kind: 'order', req_date: D(3),
    note: '按颜色备料：每个颜色单独一行，仓库按色配比发料', demo_tag: TAG,
    items: sug.items.map((x) => ({
      material_id: x.material_id, name: x.name, spec: x.spec, unit: x.unit,
      req_qty: x.req_qty, item_id: x.item_id, colorway: x.colorway, color_no: x.color_no,
      price: x.price
    }))
  }, op);
  M.prepareIssue(doc.id, op);

  // 发料：001 发全 / 002 发六成 / 003 发全 / 004 不发 —— 停在「部分发出」，欠发按色挂着
  const detail = M.issueDetail(doc.id);
  const plan = detail.items.map((it) => {
    let qty = it.req_qty;
    if (it.colorway === '印花002') qty = round2(it.req_qty * 0.6);
    if (it.colorway === '印花004') qty = 0;
    return { id: it.id, issued_qty: qty, batch_no: it.colorway ? `G-${it.color_no}` : null };
  }).filter((x) => x.issued_qty > 0);
  const out = M.issueOut(doc.id, { items: plan }, op);

  console.log(`[5] 领料单 ${doc.issue_no}：${out.status_label}，欠发 ${out.open_qty}（按色挂着）`);
  out.by_color.forEach((g) => {
    console.log(`    ${(g.style_no || '不分款').padEnd(9)} ${(g.colorway || '不分色').padEnd(6)} 需求 ${String(g.req_qty).padStart(8)} 已发 ${String(g.issued_qty).padStart(8)} 欠发 ${String(g.short).padStart(7)}`);
  });
  return doc;
}

/**
 * 不能自己包一层 BEGIN：`createIssue` / `issueOut` 内部各自开事务，
 * 嵌套 BEGIN 会直接抛「cannot start a transaction within a transaction」。
 * 演示脚本靠 `--reset` 保证可重复，不靠外层事务。
 */
try {
  if (reset) clean();
  const existed = db.prepare('SELECT id FROM orders WHERE order_no = ?').get(ORDER_NO);
  if (existed) {
    console.log(`订单 ${ORDER_NO} 已存在，未重复生成（要重建请加 --reset）`);
    process.exit(0);
  }
  const ids = seedMaterials();
  const { orderId } = seedOrder(ids);
  seedIssue(orderId);
  console.log('\n演示数据就绪：仓库 → 备料领退与盘点 → 备料与领料，找「MCOL-DEMO-1」那张单。');
} catch (e) {
  console.error('生成失败：', e.message);
  process.exit(1);
}
