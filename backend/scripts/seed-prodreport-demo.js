/**
 * 生产交付效率与质量报表：演示数据
 * ========================================================================
 * 造 8 张「本月已发运」的订单，让八项指标都有样本：
 *   6 张准时 / 2 张延期（其中 2 张写了延期原因）
 *   每张 5 道工序节点，带计划日与实际日（偏差 -1 ~ +3 天）
 *   每张 5 个交期节点（P1 裁床算料 → E1 出厂发运），带实际开始/结束
 *
 * 为什么不用现成订单改数：现成的承诺日都在 11-12 月，改成本月会把真实演示数据弄乱。
 * 这里全部用 RPTDEMO 前缀，`--clean` 一键删净。
 */
const { db } = require('../src/db');

const TAG = 'RPTDEMO';
const t = new Date().toISOString();

function d(offset) {
  const x = new Date();
  x.setDate(x.getDate() + offset);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function clean() {
  const cs = db.prepare("SELECT id FROM commitments WHERE order_no LIKE 'RPTDEMO%'").all();
  cs.forEach((c) => db.prepare('DELETE FROM commitment_nodes WHERE commitment_id = ?').run(c.id));
  db.prepare("DELETE FROM commitments WHERE order_no LIKE 'RPTDEMO%'").run();
  const os = db.prepare("SELECT id FROM orders WHERE order_no LIKE 'RPTDEMO%'").all();
  os.forEach((o) => {
    db.prepare('DELETE FROM order_nodes WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
  });
  console.log('演示订单/交期已清理');
}

if (process.argv.includes('--clean')) {
  clean();
  process.exit(0);
}

clean();

const cust = db.prepare('SELECT id, name FROM customers ORDER BY id LIMIT 1').get();
const product = db.prepare('SELECT id, name FROM products ORDER BY id LIMIT 1').get();

/**
 * 8 张单：承诺日都在本月（今天之前），6 准时 2 延期
 * [序号, 承诺日偏移, 发运日偏移(null=未发运), 件数, 类型, 延期原因]
 */
const PLAN = [
  [1, -20, -22, 800, 'custom', null],
  [2, -18, -20, 600, 'custom', null],
  [3, -15, -16, 1200, 'stock', null],
  [4, -12, -13, 450, 'custom', null],
  [5, -10, -9, 900, 'stock', null],
  [6, -8, -10, 700, 'custom', null],
  [7, -6, -3, 1000, 'custom', '面料到货延后，供应商补发'],
  [8, -4, null, 500, 'custom', '客户确认工艺变更，重新排产'] // 过了承诺日还没发运
];

const NODES = [
  // [工序, 计划日偏移, 实际日偏移]
  ['排版算料', -26, -27],
  ['裁剪', -24, -23],
  ['车缝', -20, -17],
  ['检验', -16, -15],
  ['整烫', -14, -14],
  ['包装', -13, -12]
];

// 交期节点：P1 起算 → E1 出厂
// 计划天数之和 16 天（含节点间等待前的口径），实际执行前 6 单贴计划、后 2 单拖 2 天 ——
// 这样「工厂段达成」有 6/8 达标，而不是一边倒的 0% 或 100%（两种都看不出问题）
const CNODES = [
  ['P1', '裁床用量·算料', 3, 2],
  ['P5', '实际裁剪', 4, 4],
  ['B1', '车间缝制', 4, 5],
  ['H2', '终检·包装', 3, 2],
  ['E1', '出厂发运', 2, 1]
];

let made = 0;
PLAN.forEach(([no, promiseOff, shipOff, qty, type, reason], idx) => {
  const orderNo = `${TAG}${String(no).padStart(4, '0')}`;
  const oid = db
    .prepare(
      `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency,
         style_name, manager, order_date, delivery_date, remark, created_by, created_at, updated_at, company_id)
       VALUES (?,?,?,?,6.5,?,?,'USD',?,?,?,?,?,1,?,?,1)`
    )
    .run(orderNo, type, cust ? cust.id : null, 'shipped',
      Math.round(qty * 12), Math.round(qty * 12 * 6.5),
      `报表演示款 ${no}`, '张跟单', d(-30), d(promiseOff), '报表演示数据', t, t).lastInsertRowid;

  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, style_no, qty, amount_usd, amount_cny)
     VALUES (?,?,?,?,?,?,?)`
  ).run(oid, product ? product.id : null, product ? product.name : '演示款', `${TAG}-S${no}`,
    qty, Math.round(qty * 12), Math.round(qty * 12 * 6.5));

  // 工序节点：带计划日与实际日（偏差 -1 ~ +3）
  NODES.forEach(([name, planOff, actOff], i) => {
    // 让前 3 单的计划偏差略正（延期），后 5 单略负（提前），报表有正有负才看得出东西
    const shift = idx < 3 ? (idx === 2 ? 3 : 1) : -1;
    db.prepare(
      `INSERT INTO order_nodes (order_id, name, seq, status, plan_date, actual_date, operator, remark, created_at)
       VALUES (?,?,?,'done',?,?,?,?,?)`
    ).run(oid, name, i + 1, d(planOff), d(actOff + shift), '演示班长', '报表演示', t);
  });

  // 交期承诺 + 节点实际时间
  const cid = db
    .prepare(
      `INSERT INTO commitments (order_id, order_no, customer_name, style_no, qty, route_type, t0_at,
         promised_date, planned_date, forecast_date, actual_ship_date, review_status,
         front_ok, back_ok, material_ok, risk_level, delay_days, delay_reason, created_at, updated_at)
       VALUES (?,?,?,?,?,'inhouse',?,?,?,?,?,'reviewed',1,1,1,'low',?,?,?,?)`
    )
    .run(oid, orderNo, cust ? cust.name : '演示客户', `${TAG}-S${no}`, qty,
      d(-30), d(promiseOff), d(promiseOff), d(promiseOff),
      shipOff === null ? null : d(shipOff),
      shipOff === null ? (promiseOff * -1) : (shipOff - promiseOff), reason, t, t).lastInsertRowid;

  // 节点实际时间：从 -28 天开始依次推进
  let cursor = -28;
  CNODES.forEach(([code, name, planDays, baseDays], i) => {
    // 后两单每个节点多拖半天（向上取整成 1 天），累计超出计划 → 工厂段不达标
    const actDays = baseDays + (idx >= 6 ? 1 : 0);
    const start = cursor;
    const end = cursor + actDays;
    db.prepare(
      `INSERT INTO commitment_nodes (commitment_id, code, name, seq, plan_days, start_date, end_date,
         actual_start, actual_end, status, owner)
       VALUES (?,?,?,?,?,?,?,?,?,'done','演示')`
    ).run(cid, code, name, i + 1, planDays, d(start), d(end), d(start), d(end));
    // 节点之间留 0~1 天等待（报表里「等待时长」就有数）
    cursor = end + (i % 2 === 0 ? 1 : 0);
  });

  made += 1;
});

console.log(`已造 ${made} 张报表演示订单（${TAG}0001 ~ ${TAG}0008）`);
console.log('  6 张准时发运、1 张延期发运、1 张过了承诺日未发运');
console.log('  每张 6 道工序节点（带计划日/实际日）+ 5 个交期节点（带实际起止）');
console.log('\n下一步：GET /api/prod-report/overview');
