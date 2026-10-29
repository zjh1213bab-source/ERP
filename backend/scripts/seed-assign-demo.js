/**
 * 生产分配（待分配订单 → 本厂 / 整单外发）—— 演示数据（幂等）
 * ============================================================
 * 用法：node scripts/seed-assign-demo.js [--reset]
 *
 * 造 4 张处境不同的单，覆盖分配这件事的全部岔路：
 *
 *   ASG-DEMO-1  待分配，成本已审        → 点开能看到三个按钮，点「分配本厂」立刻生效
 *   ASG-DEMO-2  待分配，成本单还没审     → 按钮变灰并说清"去补成本单"
 *   ASG-DEMO-3  整单外发（外协厂 A 480 件）→ 看板「整单外发」页签里有它，工厂列写企业名
 *   ASG-DEMO-4  拆单：本厂 300 + 外协 B 200 → 标「本厂 + 外协」，示范拆单不能被硬归成一边
 *
 * 为什么要造这几张：库里现有的在产单**一张都没有分单记录**，
 * 也没有成本单审核 —— 于是分配面板在每个真实单上都是"不能分配"，
 * 功能看着像坏的。演示数据要能证明按钮真的能按下去。
 */
const { db } = require('../src/db');
const { ensureNodes, findByCode } = require('../src/services/nodeFlow');

const TAG = 'assign_demo';
const PREFIX = 'ASG-DEMO-';
const reset = process.argv.includes('--reset');

const pad = (n) => String(n).padStart(2, '0');
function D(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const ts = `${D(-2)} 09:30:00`;

/** 清掉上一次的演示数据 */
function clean() {
  const orders = db.prepare('SELECT id FROM orders WHERE order_no LIKE ?').all(`${PREFIX}%`);
  orders.forEach((o) => {
    db.prepare('DELETE FROM dispatch_orders WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM cost_sheets WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM order_node_logs WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(o.id);
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
  });
}

function mkOrder({ no, style, qty, status, costApproved, delivery }) {
  const totalUsd = Math.round(qty * 9.5 * 100) / 100;
  const info = db.prepare(
    `INSERT INTO orders (order_no, type, status, rate, total_usd, total_amount, currency, style_name,
       cus_order_no, manager, order_date, delivery_method, trade_terms, delivery_date, remark,
       created_at, updated_at, company_id)
     VALUES (?, 'custom', ?, 7.1, ?, ?, 'USD', ?, ?, '陈跟单', ?, '海运', 'FOB', ?, ?, ?, ?, 1)`
  ).run(no, status, totalUsd, Math.round(totalUsd * 7.1 * 100) / 100, style,
    `PO-${no}`, D(-2), delivery, '生产分配演示', ts, ts);
  const orderId = Number(info.lastInsertRowid);

  const item = db.prepare(
    `INSERT INTO order_items (order_id, product_name, style_no, qty, amount_usd, amount_cny)
     VALUES (?,?,?,?,?,?)`
  ).run(orderId, style, `${style}-01`, qty, totalUsd, Math.round(totalUsd * 7.1 * 100) / 100);
  const itemId = Number(item.lastInsertRowid);
  db.prepare(
    `INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(itemId, '本白', '均码', qty, 9.5, Math.round(9.5 * 7.1 * 100) / 100,
    totalUsd, Math.round(totalUsd * 7.1 * 100) / 100);

  if (costApproved) {
    db.prepare(
      `INSERT INTO cost_sheets (order_id, material_cost, accessory_cost, labor_cost, overhead_cost,
         other_cost, total_cost, profit_rate, factory_price, status, reviewed_by, reviewed_at,
         review_opinion, created_at, updated_at)
       VALUES (?, 42, 8, 26, 11, 3, 90, 28, ?, 'approved', 'admin', ?, '演示：已核价', ?, ?)`
    ).run(orderId, Math.round(9.5 * 7.1 * 1.28 * 100) / 100, ts, ts, ts);
  } else {
    db.prepare(
      `INSERT INTO cost_sheets (order_id, material_cost, accessory_cost, labor_cost, overhead_cost,
         other_cost, total_cost, profit_rate, factory_price, status, created_at, updated_at)
       VALUES (?, 42, 8, 26, 11, 3, 90, 28, ?, 'draft', ?, ?)`
    ).run(orderId, Math.round(9.5 * 7.1 * 1.28 * 100) / 100, ts, ts);
  }

  ensureNodes(orderId);
  return orderId;
}

/** 假装这张单已经分过了：写分单 + 把「待分配订单」节点标完成（与看板按钮同一条路径的效果） */
function markAssigned(orderId, rows, operator) {
  const t = ts;
  rows.forEach((r) => {
    const fac = db.prepare('SELECT * FROM factories WHERE id = ?').get(r.factory_id);
    db.prepare(
      'INSERT INTO dispatch_orders (order_id, factory_id, factory_name, type, qty, price, status, remark, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(orderId, r.factory_id, fac.name, r.type, r.qty, r.price || 0, r.status || 'dispatched', '演示：已在看板分配', t);
  });
  const node = findByCode(orderId, 'c_new_1');
  if (node) {
    db.prepare("UPDATE order_nodes SET status='done', actual_date=?, operator=? WHERE id=?")
      .run(D(-1), operator, node.id);
    const detail = rows.map((r) => `${r.type === 'own' ? '本厂' : '外协'} × ${r.qty}`).join(' + ');
    db.prepare(
      'INSERT INTO order_node_logs (node_id, order_id, action, detail, operator, created_at) VALUES (?,?,?,?,?,?)'
    ).run(node.id, orderId, 'assign', `看板分配：${detail}`, operator, `${D(-1)} 10:05:00`);
  }
}

const own = db.prepare("SELECT * FROM factories WHERE type='own' AND IFNULL(status,'active')='active' ORDER BY id LIMIT 1").get();
const outs = db.prepare("SELECT * FROM factories WHERE type='outsource' AND IFNULL(status,'active')='active' ORDER BY id").all();
if (!own || !outs.length) {
  console.error('缺工厂档案（需要一条本厂 + 至少一条外协），先跑基础资料种子');
  process.exit(1);
}

if (reset) clean();
const existed = db.prepare('SELECT id FROM orders WHERE order_no LIKE ?').all(`${PREFIX}%`);
if (existed.length) {
  console.log(`演示单已存在（${existed.length} 张），未重建。要重建请加 --reset`);
  process.exit(0);
}

const a1 = mkOrder({ no: `${PREFIX}1`, style: '待分配圆领T', qty: 600, status: 'assigned', costApproved: true, delivery: D(20) });
const a2 = mkOrder({ no: `${PREFIX}2`, style: '待分配工装裤', qty: 350, status: 'assigned', costApproved: false, delivery: D(26) });
const a3 = mkOrder({ no: `${PREFIX}3`, style: '整单外发卫衣', qty: 480, status: 'production', costApproved: true, delivery: D(15) });
const a4 = mkOrder({ no: `${PREFIX}4`, style: '拆单夹克', qty: 500, status: 'production', costApproved: true, delivery: D(18) });

markAssigned(a3, [{ factory_id: outs[0].id, type: 'outsource', qty: 480, price: 26 }], 'demo');
markAssigned(a4, [
  { factory_id: own.id, type: 'own', qty: 300, price: 22 },
  { factory_id: (outs[1] || outs[0]).id, type: 'outsource', qty: 200, price: 25 }
], 'demo');

console.log('演示数据就绪：');
console.log(`  ${PREFIX}1  600 件  待分配（成本已审）→ 点开「待分配订单」可直接分配`);
console.log(`  ${PREFIX}2  350 件  待分配（成本单 draft）→ 按钮变灰，提示去补成本单`);
console.log(`  ${PREFIX}3  480 件  整单外发 → ${outs[0].name}`);
console.log(`  ${PREFIX}4  500 件  拆单：本厂 300 + ${(outs[1] || outs[0]).name} 200`);
