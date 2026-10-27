/**
 * M11 价格快照与费用池 —— 演示数据（幂等）
 * ============================================================
 * 用法：node scripts/seed-pricing-demo.js [--reset]
 *
 * 演示 7 种处境：
 *   ① 制造费用池**已分摊**：水电 + 折旧 + 车间管理工资，按工时摊到本期 6 个成本对象，
 *      分摊合计**正好等于池额**（尾差归基数最大的），并写进成本对象的 overhead 层
 *   ② 管理费用池**草稿**：房租 + 办公，按件数（**不摊进产品成本**，只做分析口径）
 *   ③ 期间没有动因的池：**基数为 0，不许分摊**（预览直接报 blocker）
 *   ④ 价格本 V1 已被 V2 取代（superseded）——历史价仍可查
 *   ⑤ 价格本 V2 **生效中**：三档数量价 + 一项**低于成本**的清理价（发布时写了说明）
 *   ⑥ 价格本 V3 草稿：基于 V2 上调 3%，另含一项**取不到成本**的款（发布会被拒）
 *   ⑦ 取价接口：客户专价优先于通用价，返回命中的价格本版本
 *
 * 全部走 services/pricing 的真实逻辑，演示本身就是回归。
 */
const { db } = require('../src/db');
const P = require('../src/services/pricing');

const TAG = 'pricing_demo';
const reset = process.argv.includes('--reset');
const pad = (n) => String(n).padStart(2, '0');
const PERIOD = new Date().toISOString().slice(0, 7);   // 本期
const COST_STYLE = 'LEJE-AW-2601';                     // 有成本对象的款
const SIMPLE_STYLE = 'LEJE-SY-001';

function clean() {
  // 1) 先把演示池写进成本的分录撤掉（否则重放会一直累加 actual_cost）
  const pools = db.prepare("SELECT * FROM cost_pools WHERE demo_tag = ? OR name LIKE '%冒烟测试%'").all(TAG);
  db.exec('BEGIN');
  try {
    pools.forEach((p) => {
      const allocs = db.prepare('SELECT * FROM cost_pool_allocations WHERE pool_id = ?').all(p.id);
      allocs.forEach((a) => {
        if (a.cost_entry_id) {
          db.prepare('DELETE FROM cost_entries WHERE id = ?').run(a.cost_entry_id);
          db.prepare(
            'UPDATE cost_objects SET actual_cost = ROUND(MAX(0, COALESCE(actual_cost,0) - ?), 2), updated_at = ? WHERE id = ?'
          ).run(P.r2(a.amount), new Date().toISOString().slice(0, 19).replace('T', ' '), a.cost_object_id);
        }
      });
      db.prepare('DELETE FROM cost_pool_allocations WHERE pool_id = ?').run(p.id);
    });
    // 兜底：任何指向演示池的残留分录
    const ids = pools.map((p) => p.id);
    if (ids.length) {
      db.prepare(`DELETE FROM cost_entries WHERE ref_type='cost_pool' AND ref_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
    db.prepare("DELETE FROM cost_pool_expenses WHERE pool_id IN (SELECT id FROM cost_pools WHERE demo_tag = ? OR name LIKE '%冒烟测试%')").run(TAG);
    db.prepare("DELETE FROM cost_pools WHERE demo_tag = ? OR name LIKE '%冒烟测试%'").run(TAG);
    db.prepare("DELETE FROM price_book_items WHERE book_id IN (SELECT id FROM price_books WHERE demo_tag = ? OR note LIKE '%冒烟测试%')").run(TAG);
    db.prepare("DELETE FROM price_books WHERE demo_tag = ? OR note LIKE '%冒烟测试%'").run(TAG);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seedPools() {
  const op = 'demo';
  const { from, to } = P.monthRange(PERIOD);

  // ---- ① 制造费用池：按工时分摊 ----
  const p1 = P.createPool({ period: PERIOD, name: `${PERIOD} 车间制造费用`, kind: 'manufacturing', driver: 'labor_hours', demo_tag: TAG }, op);
  P.addExpense(p1.id, { expense_date: `${PERIOD}-05`, category: '水电', description: '车间水电（10 月抄表）', amount: 8851.3 }, op);
  P.addExpense(p1.id, { expense_date: `${PERIOD}-10`, category: '折旧', description: '车缝/裁剪设备折旧（10 月）', amount: 12000 }, op);
  P.addExpense(p1.id, { expense_date: `${PERIOD}-15`, category: '工资', description: '车间管理人员工资（10 月）', amount: 26000 }, op);
  const pre1 = P.previewPool(p1.id);
  if (pre1.blockers.length) throw new Error(`制造费用池不能分摊：${pre1.blockers.join('；')}`);
  const d1 = P.distributePool(p1.id, { note: '按本期报工工时摊销（水电+折旧+车间管理工资）' }, op);

  // ---- ② 管理费用池：按件数（不摊进产品成本）----
  const p2 = P.createPool({ period: PERIOD, name: `${PERIOD} 管理费用`, kind: 'admin', driver: 'qty', demo_tag: TAG }, op);
  P.addExpense(p2.id, { expense_date: `${PERIOD}-01`, category: '房租', description: '厂房与办公租金（10 月）', amount: 38000 }, op);
  P.addExpense(p2.id, { expense_date: `${PERIOD}-12`, category: '办公', description: '办公用品与耗材', amount: 2140 }, op);

  // ---- ③ 期间没有动因：基数为 0 ----
  const p3 = P.createPool({ period: '2026-06', name: '2026-06 制造费用（无动因演示）', kind: 'manufacturing', driver: 'labor_hours', demo_tag: TAG }, op);
  P.addExpense(p3.id, { expense_date: '2026-06-15', category: '水电', description: '6 月车间水电（当月无报工）', amount: 4200 }, op);

  console.log(`[1] 制造费用池 ${d1.pool_no} 已分摊：池额 ¥${P.r2(d1.total_amount)} → ${d1.allocations.length} 个成本对象，合计 ¥${P.r2(d1.alloc_sum)}（差 ${P.r2(d1.total_amount - d1.alloc_sum)}）`);
  console.log(`[2] 管理费用池 ${p2.pool_no} 草稿（不摊进产品成本，只做分析口径）`);
  console.log(`[3] 无动因池 ${p3.pool_no}：基数为 0，分摊会被拒`);
  return { p1: d1, p2, p3, from, to };
}

function seedBooks() {
  const op = 'demo';
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // ---- ④ V1：上月价格（很快会被 V2 取代）----
  const v1 = P.createBook({ scope: 'factory', currency: 'CNY', effective_from: day(-60), note: '历史版本（演示已被新版取代）', demo_tag: TAG }, op);
  P.upsertItem(v1.id, { style_no: COST_STYLE, size: '', min_qty: 1, max_qty: 299, price: 95 }, op);
  P.upsertItem(v1.id, { style_no: COST_STYLE, size: '', min_qty: 300, max_qty: 799, price: 88 }, op);
  P.upsertItem(v1.id, { style_no: COST_STYLE, size: '', min_qty: 800, max_qty: null, price: 82 }, op);
  P.upsertItem(v1.id, { style_no: SIMPLE_STYLE, size: '', min_qty: 1, max_qty: null, price: 12 }, op);
  P.publishBook(v1.id, { note: '首版出厂价' }, op);

  // ---- ⑤ V2：本期生效（涨 3 元，并加一档清理价）----
  // V2 从 V1 复制了明细，所以这里**按档位找到已有行再改价**（真实改价姿势），
  // 不是再插一遍同样的档位——那样会撞「数量档不能交叉」。
  const v2 = P.createBook({
    scope: 'factory', currency: 'CNY', effective_from: day(-1),
    copy_from: v1.id, note: '本期调价：面料涨 4%，主流档上调 3 元', demo_tag: TAG
  }, op);
  const v2items = P.bookDetail(v2.id).items;
  // 按「款 + 起始量」定位要改的那一行（同款同码的起始量唯一），
  // 不能按「起始量 + 上限」匹配——改了上限就找不到了，会变成又插一行而撞档位
  const patch = (style, minQ, maxQ, price, note) => {
    const it = v2items.find((x) => x.style_no === style
      && Number(x.min_qty) === Number(minQ)
      && String(x.size || '') === '');
    return P.upsertItem(v2.id, it
      ? { id: it.id, style_no: style, size: it.size || '', min_qty: minQ, max_qty: maxQ, price, note }
      : { style_no: style, size: '', min_qty: minQ, max_qty: maxQ, price, note }, op);
  };
  // 清仓尾货档：故意低于成本（这个款取得到成本，才能演示「低于成本可发但要写说明」）
  patch(COST_STYLE, 1, 29, 58, '清仓尾货（低于成本，已报批）');
  P.upsertItem(v2.id, { style_no: COST_STYLE, size: '', min_qty: 30, max_qty: 299, price: 98 }, op);
  const before = P.bookDetail(v2.id);
  const pub2 = P.publishBook(v2.id, { note: 'LEJE-AW-2601 首 29 件为清仓尾货价 ¥58，低于成本，已报销售总监确认' }, op);

  // ---- ⑥ V3 草稿：基于 V2 上调，含一项取不到成本的款 ----
  const v3 = P.createBook({
    scope: 'factory', currency: 'CNY', effective_from: day(30),
    copy_from: v2.id, note: '下期调价草案（面料继续上涨）', demo_tag: TAG
  }, op);
  const items = P.bookDetail(v3.id).items;
  items.forEach((i) => {
    P.upsertItem(v3.id, { id: i.id, style_no: i.style_no, size: i.size, min_qty: i.min_qty, max_qty: i.max_qty, price: P.r2(i.price * 1.03), note: i.note }, op);
  });
  P.upsertItem(v3.id, { style_no: 'DEMO-NOCOST-01', size: '', min_qty: 1, max_qty: null, price: 120, note: '未做成本核算的新款' }, op);

  console.log(`[4] 价格本 V1 ${v1.book_no}：已被 V2 取代（superseded）`);
  console.log(`[5] 价格本 V2 ${pub2.book_no}：生效中，${pub2.items.length} 项，低于成本 ${pub2.below_cost_count} 项（发布时写了说明）`);
  console.log(`[6] 价格本 V3 ${v3.book_no}：草稿，含 1 项取不到成本（发布会被拒）`);
  return { v1, v2: pub2, v3, belowBefore: before.below_cost_count };
}

function seedCustomerPrice() {
  // ⑦ 客户专价：取一个有订单的客户，给它一个低于通用价的专价，验证「客户专价优先」
  const c = db.prepare(
    `SELECT DISTINCT c.id, c.name
     FROM customers c
     JOIN orders o ON o.customer_id = c.id
     JOIN cost_objects co ON co.order_id = o.id
     JOIN order_items i ON i.order_id = o.id
     WHERE i.style_no = ? AND co.qty > 0
     LIMIT 1`
  ).get(COST_STYLE);
  if (!c) return null;
  const op = 'demo';
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const cb = P.createBook({
    scope: 'factory', customer_id: c.id, currency: 'CNY', effective_from: day(-1),
    note: `客户专价（${c.name} 年度框架价）`, demo_tag: TAG
  }, op);
  P.upsertItem(cb.id, { style_no: COST_STYLE, size: '', min_qty: 1, max_qty: null, price: 84 }, op);
  const pub = P.publishBook(cb.id, { note: '年度框架协议价，全场统一 84（9.5 折）' }, op);
  console.log(`[7] 客户专价 ${pub.book_no}：${c.name} 命中专价 84（通用价同档 88，大客户 9.5 折）`);
  return pub;
}

(function main() {
  if (reset) { clean(); console.log('[0] 已清理旧演示数据'); }
  else {
    const exists = db.prepare('SELECT COUNT(*) c FROM cost_pools WHERE demo_tag = ?').get(TAG).c;
    if (exists) { console.log('演示数据已存在；要重放请加 --reset'); return; }
  }

  const pools = seedPools();
  const books = seedBooks();
  seedCustomerPrice();

  // 预览与取价
  const pv = P.previewPool(pools.p2.id);
  console.log(`\n--- 管理费用池预览（按件数，不摊进产品成本）---`);
  pv.rows.slice(0, 6).forEach((r) => console.log(`  ${String(r.order_no).padEnd(16)} 件数 ${String(r.qty).padStart(5)}  占比 ${String(P.r4(r.share_ratio)).padStart(6)}%  分摊 ¥${r.amount}`));
  console.log(`  基数合计 ${pv.base_total} 件，分摊合计 ¥${P.r2(pv.rows.reduce((s, r) => s + r.amount, 0))}（池额 ¥${P.r2(pv.total_amount)}，in_cost=${pv.in_cost}）`);

  const q1 = P.quote({ style_no: COST_STYLE, qty: 500 });
  const q2 = P.quote({ style_no: COST_STYLE, qty: 500, customer_id: (db.prepare('SELECT customer_id FROM price_books WHERE scope=? AND customer_id IS NOT NULL AND demo_tag=? LIMIT 1').get('factory', TAG) || {}).customer_id });
  console.log(`\n--- 取价 ---`);
  console.log(`  ${COST_STYLE} × 500 件（无客户）→ ¥${q1.item.price}/件（${q1.book.book_no} V${q1.book.version} · ${q1.by_label}），金额 ¥${q1.amount}`);
  if (q2.found) console.log(`  ${COST_STYLE} × 500 件（客户专价）→ ¥${q2.item.price}/件（${q2.book.book_no} V${q2.book.version} · ${q2.by_label}），金额 ¥${q2.amount}`);

  const d1 = P.poolDetail(pools.p1.id);
  console.log(`\n--- 制造费用分摊明细（合计必须等于池额）---`);
  d1.allocations.slice(0, 8).forEach((a) => console.log(`  ${String(a.order_no).padEnd(16)} 工时 ${String(a.driver_base).padStart(6)}  占比 ${String(P.r4(a.share_ratio)).padStart(6)}%  分摊 ¥${a.amount}`));
  console.log(`  分摊合计 ¥${d1.alloc_sum} / 池额 ¥${d1.total_amount} / 差 ¥${P.r2(d1.total_amount - d1.alloc_sum)}`);
  console.log('\n演示数据就绪。');
})();
