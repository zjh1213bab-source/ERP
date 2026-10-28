/**
 * 客户信用管控演示数据
 *
 * 造三家典型客户，覆盖三种必须看得到的情形：
 *
 *   CREDITDEMO01 演示·北欧服饰 AB
 *     额度 300,000 / 账期 45 天
 *     ├─ 逾期发票 180,000（到期日 25 天前）      → 逾期 + 超宽限期 → **发货被拦**
 *     ├─ 已发货未开票订单 120,000                → 「货走了钱没开票」这一类
 *     └─ 已入库订单 95,000（有明细、有库存）      → 拿它演「拦截 → 放行 → 发货」
 *
 *   CREDITDEMO02 演示·南美贸易            额度 0（未设额度）但敞口 260,000
 *     → 台账里那种「没设额度、其实一直在赊」的客户（shadow）
 *
 *   CREDITDEMO03 演示·中东精品店          额度 500,000，用得不多，但被**冻结**
 *     → 演示「额度够也发不出去」：客户跑了传闻，先冻了再说
 *
 * 全部数据打 CREDITDEMO 前缀，`--reset` 可一键清干净（含订单、明细、库存、发票、库存流水）。
 */
const { db, now } = require('../src/db');

const TAG = 'CREDITDEMO';
const t = now();

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function ymd(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function reset() {
  const orders = db.prepare("SELECT id FROM orders WHERE order_no LIKE 'CDEMO%'").all();
  orders.forEach((o) => {
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM order_logs WHERE order_id = ?').run(o.id);
    db.prepare('DELETE FROM stock_ledger WHERE ref_type = ? AND ref_id = ?').run('order', o.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
  });
  // order_items 的尺码随 item 走：先收集 item id 再删
  db.prepare(
    "DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id NOT IN (SELECT id FROM orders))"
  ).run();
  db.prepare("DELETE FROM ar_invoices WHERE bill_no LIKE 'CDEMO%'").run();
  db.prepare(
    "DELETE FROM stock_items WHERE style_no LIKE 'CDEMOST%'"
  ).run();
  // 两个前缀都清：CREDITDEMO 是客户编号，CDEMO 是历史遗留（早期演示数据把订单前缀
  // 误用在客户编号上），留着会在台账里变成查不到来源的「幽灵客户」
  const custs = db
    .prepare("SELECT id FROM customers WHERE code LIKE 'CREDITDEMO%' OR code LIKE 'CDEMO%'")
    .all();
  custs.forEach((c) => {
    db.prepare('DELETE FROM credit_limits WHERE customer_id = ?').run(c.id);
    db.prepare('DELETE FROM credit_holds WHERE customer_id = ?').run(c.id);
    db.prepare('DELETE FROM credit_overrides WHERE customer_id = ?').run(c.id);
    db.prepare('DELETE FROM customers WHERE id = ?').run(c.id);
  });
  console.log(`清理完成：客户 ${custs.length} / 订单 ${orders.length}`);
}

/** 造一个客户 */
function mkCustomer({ code, name, limit, days, owner, level = 'B' }) {
  const id = db
    .prepare(
      `INSERT INTO customers (code, name, contact, phone, email, level, credit_limit, credit_days,
        credit_status, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'active',?,?,?)`
    )
    .run(code, name, '演示联系人', '13800000000', `${code.toLowerCase()}@demo.example`,
      level, r2(limit), days, '信用管控演示数据', t, t).lastInsertRowid;
  db.prepare(
    `INSERT INTO credit_limits (customer_id, credit_limit, credit_days, old_limit, old_days, reason, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, r2(limit), days, 0, 30, '演示：初始授信', '系统管理员', t);
  return id;
}

/** 造一张订单（含款、颜色、尺码，可选造库存） */
function mkOrder({ no, customerId, amount, status, styleNo, colors, sizes, stock }) {
  const orderId = db
    .prepare(
      `INSERT INTO orders (order_no, type, customer_id, status, total_usd, total_amount, rate, currency,
        style_name, manager, delivery_date, created_at, updated_at)
       VALUES (?, 'custom', ?, ?, ?, ?, 7.1, 'CNY', ?, '系统管理员', ?, ?, ?)`
    )
    .run(no, customerId, status, r2(amount / 7.1), r2(amount), '演示款', ymd(20), t, t).lastInsertRowid;

  // 明细表实际列：amount_usd / amount_cny（没有 unit_price）
  const perSize = 100;
  const totalQty = colors.length * sizes.length * perSize;
  const usd = r2(amount / 7.1);
  const itemId = db
    .prepare(
      `INSERT INTO order_items (order_id, style_no, product_name, sku, qty, amount_usd, amount_cny)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(orderId, styleNo, '演示·针织上衣', `${styleNo}-SKU`, totalQty, usd, r2(amount))
    .lastInsertRowid;

  const st = String(status);
  colors.forEach((color) => {
    sizes.forEach((size) => {
      db.prepare(
        `INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(itemId, color, size, perSize, r2(35 / 7.1), 35, r2((perSize * 35) / 7.1), perSize * 35);
      if (stock) {
        // 库存按订单件数备齐，好让发货真能跑通
        db.prepare(
          `INSERT INTO stock_items (warehouse, style_no, product_name, color, size, qty, updated_at)
           VALUES ('cn',?,?,?,?,?,?)
           ON CONFLICT(warehouse, style_no, color, size) DO UPDATE SET qty = excluded.qty`
        ).run(styleNo, '演示·针织上衣', color, size, perSize, t);
      }
    });
  });
  return orderId;
}

/**
 * 造一张应收发票
 *
 * `billOffset` 是开票日相对今天的天数（负数 = 过去）。
 * 必须和 dueOffset 一起给，否则会出现「10-28 开票、10-03 到期」这种
 * 到期日早于开票日的怪账 —— 看的人第一反应是系统算错了，而不是数据造错了。
 */
function mkInvoice({ no, customerId, name, amount, paid, billOffset = 0, dueOffset, orderId }) {
  const billAt = ymd(billOffset) + 'T00:00:00.000Z';
  db.prepare(
    `INSERT INTO ar_invoices (bill_no, order_id, customer_id, customer_name, currency, amount_orig, rate,
      amount, paid_amount, due_date, status, source, remark, created_at, updated_at)
     VALUES (?,?,?,?, 'CNY', ?, 7.1, ?, ?, ?, ?, 'manual', '信用管控演示数据', ?, ?)`
  ).run(
    no, orderId || null, customerId, name, r2(amount), r2(amount), r2(paid),
    ymd(dueOffset), r2(paid) >= r2(amount) ? 'paid' : r2(paid) > 0 ? 'partial' : 'unpaid', billAt, billAt
  );
}

function main() {
  const resetFlag = process.argv.includes('--reset');

  const exist = db.prepare("SELECT COUNT(*) c FROM customers WHERE code LIKE 'CREDITDEMO%'").get().c;
  if (exist && !resetFlag) {
    console.log(`已存在 ${exist} 个演示客户；要重建请加 --reset`);
    return;
  }
  if (resetFlag) reset();

  // ---------- 01 逾期 + 超限 ----------
  const c1 = mkCustomer({ code: 'CREDITDEMO01', name: '演示·北欧服饰 AB', limit: 300000, days: 45, owner: '王芳' });
  // 70 天前开票、账期 45 天 → 应于 25 天前到期 → 正好逾期 25 天
  // （开票日、账期、到期日三者必须对得上，否则图上看着像系统算错了）
  mkInvoice({ no: 'CDEMOINV01', customerId: c1, name: '演示·北欧服饰 AB', amount: 180000, paid: 0, billOffset: -70, dueOffset: -25 });
  const o1b = mkOrder({
    no: 'CDEMO002', customerId: c1, amount: 120000, status: 'shipped',
    styleNo: 'CDEMOST02', colors: ['黑色'], sizes: ['M']
  });
  const o1c = mkOrder({
    no: 'CDEMO003', customerId: c1, amount: 95000, status: 'instock',
    styleNo: 'CDEMOST03', colors: ['藏青'], sizes: ['S', 'M'], stock: true
  });
  db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(o1b, 'instock', 'shipped', '系统管理员', '演示：货已发出，票未开', t);

  // ---------- 02 未设额度但有在途 ----------
  const c2 = mkCustomer({ code: 'CREDITDEMO02', name: '演示·南美贸易', limit: 0, days: 30, owner: '李强' });
  mkOrder({
    no: 'CDEMO004', customerId: c2, amount: 260000, status: 'production',
    styleNo: 'CDEMOST04', colors: ['卡其'], sizes: ['L']
  });

  // ---------- 03 额度够但被冻结 ----------
  const c3 = mkCustomer({ code: 'CREDITDEMO03', name: '演示·中东精品店', limit: 500000, days: 30, owner: '张敏' });
  const o3 = mkOrder({
    no: 'CDEMO005', customerId: c3, amount: 60000, status: 'instock',
    styleNo: 'CDEMOST05', colors: ['米白'], sizes: ['M'], stock: true
  });
  db.prepare(
    `INSERT INTO credit_holds (customer_id, action, reason, exposure_snapshot, operator, created_at)
     VALUES (?, 'hold', ?, ?, ?, ?)`
  ).run(c3, '演示：客户所在国出现外汇管制传闻，先冻结待核实', 60000, '系统管理员', t);
  db.prepare("UPDATE customers SET credit_status = 'hold', credit_hold_reason = ?, updated_at = ? WHERE id = ?")
    .run('演示：客户所在国出现外汇管制传闻，先冻结待核实', t, c3);

  // ---------- 汇总 ----------
  const C = require('../src/services/credit');
  console.log('\n=== 演示客户 ===');
  [c1, c2, c3].forEach((id) => {
    const p = C.exposureOf(id);
    const f = p.figures;
    console.log(
      `${p.customer.name}（${p.risk_label}）\n` +
      `  额度 ${f.limit} / 账期 ${p.customer.credit_days} 天\n` +
      `  敞口 ${f.exposure} = 已开票未收 ${f.billed_open} + 未开票订单 ${f.unbilled}\n` +
      `  逾期 ${f.overdue}（最长 ${f.max_overdue_days} 天）  可用 ${f.available === null ? '—（未设额度）' : f.available}`
    );
  });
  console.log('\n=== 发货预检 ===');
  [o1c, o3].forEach((id) => {
    const j = C.judge(id);
    console.log(`${j.order.order_no} → ${j.level.toUpperCase()}`);
    j.reasons.forEach((r) => console.log('   拦：', r));
    j.notes.forEach((r) => console.log('   注意：', r));
    j.tips.forEach((r) => console.log('   提示：', r));
  });
  console.log('\n要清空：node scripts/seed-credit-demo.js --reset');
}

main();
