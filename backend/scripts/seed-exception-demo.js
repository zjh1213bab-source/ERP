/**
 * 异常协同与日清：演示数据
 * ========================================================================
 * 造 3 条「一眼能看懂」的异常，用来演示日清怎么用：
 *   1. 一张已过交期还在生产的订单（严重级 → 必办置顶）
 *   2. 一张卡在技术确认 8 天的订单（普通级 → 处理中）
 *   3. 一张超到货日 5 天还没到货的采购单
 *
 * 另外顺手把「缺料」和「应收逾期」交给现有数据（齐套算料 + 应收发票本来就有）。
 *
 * 全部带 EXDEMO 前缀，`node scripts/seed-exception-demo.js --clean` 可一键清干净。
 */
const { db } = require('../src/db');
const { nextNo } = require('../src/utils/docNo');

const TAG = 'EXDEMO';
const t = new Date().toISOString();
const dayOffset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

function clean() {
  const orders = db.prepare("SELECT id FROM orders WHERE order_no LIKE 'EXDEMO%'").all();
  orders.forEach((o) => {
    db.prepare('DELETE FROM order_logs WHERE order_id=?').run(o.id);
    db.prepare('DELETE FROM order_items WHERE order_id=?').run(o.id);
    db.prepare('DELETE FROM orders WHERE id=?').run(o.id);
  });
  db.prepare("DELETE FROM purchase_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE po_no LIKE 'EXDEMO%')").run();
  db.prepare("DELETE FROM purchase_orders WHERE po_no LIKE 'EXDEMO%'").run();
  console.log('演示订单/采购单已清理');
}

if (process.argv.includes('--clean')) {
  clean();
  process.exit(0);
}

/**
 * 把「历史夹具单」造成的技术包异常标为数据遗留
 *
 * 演示库里有几十张各模块自己造的夹具单（CRMDEMO / SCHDEMO / CDEMO …），
 * 它们只服务于某个模块的演示，从来没有技术包。真实上线不会有这种单。
 * 如果天天报出来，日清永远降不到 0，用户第三次就不看了 ——
 * 这正是「标为数据遗留」要解决的问题，所以拿它当演示数据。
 */
if (process.argv.includes('--ignore-legacy')) {
  const E = require('../src/services/exceptions');
  const rows = db
    .prepare(
      `SELECT id, source_no, title FROM exception_items
        WHERE rule_code = 'tech_pack_missing' AND status IN ('open','claimed','handling','waiting')
          AND source_no NOT LIKE 'SO%'`
    )
    .all();
  let n = 0;
  rows.forEach((r) => {
    try {
      E.ignore(r.id, { reason: '历史演示夹具单（其他模块造的测试单），没有技术包，不参与日清', operator: '系统管理员' });
      n += 1;
    } catch (e) { console.log('跳过', r.source_no, e.message); }
  });
  console.log(`已把 ${n} 条技术包异常标为数据遗留（写明了理由，可在条目流水里查）`);
  process.exit(0);
}

clean();

const cust = db.prepare('SELECT id, name FROM customers ORDER BY id LIMIT 1').get();
const product = db.prepare('SELECT id, sku, name FROM products ORDER BY id LIMIT 1').get();
const supplier = db.prepare('SELECT id, name FROM suppliers ORDER BY id LIMIT 1').get();
const material = db.prepare('SELECT id, name FROM materials ORDER BY id LIMIT 1').get();

/* ---------- 1. 已过交期仍在生产的订单 ---------- */
const o1 = db
  .prepare(
    `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency,
       style_name, manager, order_date, delivery_date, remark, created_by, created_at, updated_at, company_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
  )
  .run(`${TAG}0001`, 'stock', cust ? cust.id : null, 'production', 6.5, 10461.54, 68000, 'USD',
    'EXDEMO-过交期款', '张跟单', dayOffset(-20), dayOffset(-3), '演示：已过交期仍在生产', 1, t, t).lastInsertRowid;

db.prepare(
  `INSERT INTO order_items (order_id, product_id, product_name, style_no, qty, amount_usd, amount_cny)
   VALUES (?,?,?,?,?,?,?)`
).run(o1, product ? product.id : null, product ? product.name : '演示款', 'EXDEMO-S1', 1200, 10461.54, 68000);

db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
  .run(o1, 'assigned', 'production', '系统管理员', '演示：进入生产中', t);

/* ---------- 2. 卡在技术确认 8 天的订单 ---------- */
const o2 = db
  .prepare(
    `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency,
       style_name, manager, order_date, delivery_date, remark, created_by, created_at, updated_at, company_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
  )
  .run(`${TAG}0002`, 'custom', cust ? cust.id : null, 'tech', 6.5, 7384.62, 48000, 'USD',
    'EXDEMO-卡技术款', '李跟单', dayOffset(-8), dayOffset(12), '演示：卡在技术确认', 1, t, t).lastInsertRowid;

db.prepare(
  `INSERT INTO order_items (order_id, product_id, product_name, style_no, qty, amount_usd, amount_cny)
   VALUES (?,?,?,?,?,?,?)`
).run(o2, product ? product.id : null, product ? product.name : '演示款', 'EXDEMO-S2', 800, 7384.62, 48000);

db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
  .run(o2, 'draft', 'tech', '李跟单', '演示：进入技术确认', new Date(Date.now() - 8 * 86400000).toISOString());

/* ---------- 3. 超到货日 5 天未到的采购单 ---------- */
const po = db
  .prepare(
    `INSERT INTO purchase_orders (po_no, supplier, status, order_date, expect_date, remark, total_amount, created_by, created_at, updated_at, supplier_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  .run(`${TAG}-PO01`, supplier ? supplier.name : '演示供应商', 'ordered', dayOffset(-15), dayOffset(-5),
    '演示：超承诺到货日', 12000, 1, t, t, supplier ? supplier.id : null).lastInsertRowid;

db.prepare(
  `INSERT INTO purchase_items (po_id, material_id, name, spec, unit, qty, received_qty, price, amount)
   VALUES (?,?,?,?,?,?,?,?,?)`
).run(po, material ? material.id : null, material ? material.name : '演示面料', '150D', '米', 600, 0, 20, 12000);

console.log('演示数据已就绪：');
console.log(`  订单 ${TAG}0001（过交期 3 天，生产中，¥68000）`);
console.log(`  订单 ${TAG}0002（卡在 tech 8 天，¥48000）`);
console.log(`  采购 ${TAG}-PO01（超到货日 5 天，600 米未到）`);
console.log('\n下一步：POST /api/exceptions/scan 生成日清清单');
