/**
 * 历史订单再次购买 演示数据
 * ========================================================================
 * 造一张「三个月前买过」的演示订单，三个款各代表一种再购时的典型情况：
 *
 *   1. 在架 + 涨价（$10.00 → $12.00）+ 可售量只剩 40 件（上次买 300）→ 价格变化 / 可售量不足
 *   2. 在架 + 低于起订量（上次 60 件，当前 MOQ 100）→ 低于起订量
 *   3. 已下架 → 不允许再购，必须让销售上架或推替代款
 *
 * 另外给第 1 款造两个技术包版本（v1 是下单时那版、v2 是后来改的），
 * 用来演示「再购按当前技术重新确认」。
 *
 * 全部演示数据用 `REORD-` 前缀 / `演示·` 名称，清理只认这两个标记。
 * 清理：`node scripts/seed-reorder-demo.js --clean`
 */

const { db, now } = require('../src/db');
const S = require('../src/services/mallReorder');

const MARK = 'REORD';
// 单号必须是正式格式（SO+yyyymmdd+4 位）：扫码/标签码解析会按前缀分段，
// 带横线的“演示号”会被当成标签码拆开，把「扫标签码反解订单」那条用例带崩（踩过）
const ORDER_NO = 'SO202609010001';
const CUSTOMER_ID = 1;          // 示范客户·美国 ABC（有商城账号 abc001）

function today(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cleanDemo() {
  const orders = db.prepare("SELECT id FROM orders WHERE remark LIKE '%再购演示%'").all().map((r) => r.id);
  orders.forEach((id) => {
    const items = db.prepare('SELECT id FROM order_items WHERE order_id = ?').all(id).map((r) => r.id);
    items.forEach((iid) => db.prepare('DELETE FROM order_item_sizes WHERE item_id = ?').run(iid));
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
    db.prepare('DELETE FROM order_logs WHERE order_id = ?').run(id);
  });
  db.prepare("DELETE FROM orders WHERE remark LIKE '%再购演示%'").run();

  // 再购产生的询价单（source_order_no 指向演示订单）
  const inqs = db.prepare("SELECT id FROM mall_inquiries WHERE source_order_no LIKE 'SO20260901%'").all().map((r) => r.id);
  inqs.forEach((id) => {
    db.prepare('DELETE FROM mall_inquiry_items WHERE inquiry_id = ?').run(id);
    db.prepare('DELETE FROM mall_inquiries WHERE id = ?').run(id);
  });
  db.prepare("DELETE FROM mall_messages WHERE customer_id = ? AND title LIKE '%再购%'").run(CUSTOMER_ID);

  db.prepare("DELETE FROM mall_prices WHERE mall_product_id IN (SELECT id FROM mall_products WHERE style_no LIKE 'REORD-%')").run();
  db.prepare("DELETE FROM mall_favorites WHERE mall_product_id IN (SELECT id FROM mall_products WHERE style_no LIKE 'REORD-%')").run();
  db.prepare("DELETE FROM mall_products WHERE style_no LIKE 'REORD-%'").run();
  db.prepare("DELETE FROM stock_items WHERE style_no LIKE 'REORD-%'").run();
  db.prepare("DELETE FROM tech_packs WHERE product_name LIKE '演示·再购%'").run();
  console.log('演示数据已清除');
}

if (process.argv.includes('--clean')) {
  cleanDemo();
  process.exit(0);
}

cleanDemo();

const t = now();
const inqBefore = db.prepare('SELECT COUNT(*) c FROM mall_inquiries').get().c;

/* ---------------- 1. 两个在架演示商品 ---------------- */
const mkProduct = (styleNo, name, moq, price, category) => {
  const info = db.prepare(`INSERT INTO mall_products (product_id, style_no, name_cn, name_en, category, moq, lead_days,
      price_usd, visible_stock, tags, status, sort, created_at, updated_at)
    VALUES (NULL, ?, ?, ?, ?, ?, 25, ?, 1, '再购演示', 'published', 0, ?, ?)`).run(
    styleNo, name, name, category, moq, price, t, t
  );
  return Number(info.lastInsertRowid);
};
const mpA = mkProduct('REORD-A', '演示·再购针织衫', 50, 12.0, '针织');
const mpC = mkProduct('REORD-C', '演示·再购卫衣', 100, 7.5, '卫衣');

/* ---------------- 2. 历史订单（三个月前，已发货） ---------------- */
const orderDate = today(-95);
const deliveryDate = today(-30);
const totalUsd = 300 * 10 + 60 * 7.5 + 120 * 8;
const rate = 6.9;
const orderInfo = db.prepare(`INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount,
    currency, style_name, cus_order_no, manager, order_date, delivery_method, trade_terms, delivery_date,
    remark, created_at, updated_at, company_id)
  VALUES (?, 'stock', ?, 'shipped', ?, ?, ?, 'USD', ?, ?, '王业务', ?, '海运', 'FOB', ?, ?, ?, ?, 1)`).run(
  ORDER_NO, CUSTOMER_ID, rate, totalUsd, Math.round(totalUsd * rate * 100) / 100,
  '演示·再购针织衫', 'ABC-PO-REORD', orderDate, deliveryDate,
  '再购演示：三个月前的现货单，用来演示「再来一单」', t, t
);
const orderId = Number(orderInfo.lastInsertRowid);

const mkItem = (b) => {
  const info = db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, style_no, sku, color, qty, amount_usd, amount_cny)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    orderId, b.product_id || null, b.name, b.style_no, b.sku || null, b.color || null,
    b.qty, Math.round(b.qty * b.price * 100) / 100, Math.round(b.qty * b.price * rate * 100) / 100
  );
  const itemId = Number(info.lastInsertRowid);
  const ins = db.prepare(`INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny)
    VALUES (?,?,?,?,?,?,?,?)`);
  (b.sizes || []).forEach((s) => {
    ins.run(itemId, s.color || b.color || null, s.size, s.qty, b.price,
      Math.round(b.price * rate * 100) / 100, Math.round(s.qty * b.price * 100) / 100,
      Math.round(s.qty * b.price * rate * 100) / 100);
  });
  return itemId;
};

// 1) 在架款：上次 300 件 @ $10（当前 $12，可售仅 40）
mkItem({ name: '演示·再购针织衫', style_no: 'REORD-A', color: '米白', qty: 300, price: 10, sizes: [{ color: '米白', size: 'M', qty: 150 }, { color: '米白', size: 'L', qty: 150 }] });
// 2) 在架款：上次 60 件（当前 MOQ 100）
mkItem({ name: '演示·再购卫衣', style_no: 'REORD-C', color: '藏青', qty: 60, price: 7.5, sizes: [{ color: '藏青', size: '均码', qty: 60 }] });
// 3) 已下架款：商城已找不到
mkItem({ name: '旧款牛仔外套', style_no: 'REORD-X', color: '深蓝', qty: 120, price: 8, sizes: [{ color: '深蓝', size: '均码', qty: 120 }] });

/* ---------------- 3. 美仓现货（只够 40 件） ---------------- */
db.prepare(`INSERT INTO stock_items (warehouse, style_no, product_name, color, size, qty, updated_at)
  VALUES ('us', 'REORD-A', '演示·再购针织衫', '米白', 'M', 25, ?)`).run(t);
db.prepare(`INSERT INTO stock_items (warehouse, style_no, product_name, color, size, qty, updated_at)
  VALUES ('us', 'REORD-A', '演示·再购针织衫', '米白', 'L', 15, ?)`).run(t);
db.prepare(`INSERT INTO stock_items (warehouse, style_no, product_name, color, size, qty, updated_at)
  VALUES ('us', 'REORD-C', '演示·再购卫衣', '藏青', '均码', 200, ?)`).run(t);

/* ---------------- 4. 技术包两版（v1 下单时 / v2 后来改过） ---------------- */
db.prepare(`INSERT INTO tech_packs (order_id, product_name, version, fabric_info, craft_info, stage, status, created_at, updated_at, demo_tag)
  VALUES (?, '演示·再购针织衫', 1, '32支精梳棉', '平车 12 针', 'confirmed', 'confirmed', ?, ?, ?)`).run(
  orderId, today(-96) + 'T02:00:00.000Z', today(-96) + 'T02:00:00.000Z', MARK
);
db.prepare(`INSERT INTO tech_packs (order_id, product_name, version, fabric_info, craft_info, stage, status, created_at, updated_at, demo_tag)
  VALUES (?, '演示·再购针织衫', 2, '32支精梳棉（换供应商）', '平车 12 针 + 袖口加固', 'confirmed', 'confirmed', ?, ?, ?)`).run(
  orderId, today(-20) + 'T02:00:00.000Z', today(-20) + 'T02:00:00.000Z', MARK
);

/* ---------------- 5. 跑一遍预览，把结果打出来 ---------------- */
const pv = S.preview(orderId, CUSTOMER_ID);
console.log('\n--- 演示订单 ---');
console.log(`${ORDER_NO} · 客户 #${CUSTOMER_ID} · ${pv.items.length} 个款 · 历史合计 $${pv.summary.hist_usd}`);
pv.items.forEach((it) => {
  console.log(`  [${it.status}] ${it.product_name}  历史 ${it.hist_qty} 件 @$${it.hist_price_usd} → 当前 $${it.current_price_usd || '-'}（可售 ${it.sellable} / MOQ ${it.moq}）`);
  if (it.tag_labels.length) console.log(`        标签：${it.tag_labels.join('、')}`);
  it.messages.forEach((m) => console.log(`        · ${m}`));
});
console.log(`\n汇总：可提交 ${pv.summary.ok} / 需确认 ${pv.summary.warn} / 不可再购 ${pv.summary.blocked}`);
console.log(`商城脚本：customer_accounts 中 abc001（客户 #${CUSTOMER_ID}）可登录商城点「再来一单」。`);
if (inqBefore !== db.prepare('SELECT COUNT(*) c FROM mall_inquiries').get().c) {
  console.log('（注意：预演不应产生询价单，出现变化说明 preview 里有写库语句）');
}
