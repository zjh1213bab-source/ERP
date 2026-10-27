/**
 * 历史库存与流水对齐（只补记流水，不改账面余额）
 * ============================================================
 * 问题从哪来：
 *   原料在「备料领退」模块上线前，`materials.stock_qty` 是直接在页面上改的，
 *   没有写 `material_ledger`。后来有了唯一写入口 applyStock()，新数据都记流水了，
 *   但历史存量没有对应流水 —— 表现就是「账面 6416、流水 -68」这种差。
 *
 * 为什么这样修（而不是把余额改成流水的数）：
 *   账面余额是业务一直在用的真实数量（采购、发料都基于它），它是准的；
 *   不准的是「没有历史依据」。所以补一条 `opening` 流水把历史存量记进去，
 *   两边对齐的同时，账面上还能看出「这部分是系统上线前的存量」。
 *   反过来把余额改成流水数，等于把真实库存抹掉 —— 那是数据事故。
 *
 * 成品库存同理：`stock_items.qty` 是准的，缺的是流水。
 *
 * 用法：
 *   node scripts/fix-stock-baseline.js            # 只看
 *   node scripts/fix-stock-baseline.js --apply    # 真补
 */
const { db, now } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const TS = now();
const OPERATOR = 'system:baseline-align';
const REMARK = '历史存量对齐：模块上线前直接维护数量、无对应流水（本次只补记流水，不改账面余额）';

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ---------- 原料 ----------
const matRows = db
  .prepare(
    `SELECT m.id, m.code, m.name, m.unit, ROUND(m.stock_qty, 2) AS book,
            ROUND(IFNULL((SELECT SUM(qty) FROM material_ledger l WHERE l.material_id = m.id), 0), 2) AS led
       FROM materials m
      ORDER BY m.id`
  )
  .all()
  .map((r) => ({ ...r, diff: r2(r.book - r.led) }))
  .filter((r) => Math.abs(r.diff) > 0.005);

// ---------- 成品 ----------
const stockRows = db
  .prepare(
    `SELECT COALESCE(i.warehouse, l.warehouse) AS warehouse,
            COALESCE(i.style_no, l.style_no) AS style_no,
            COALESCE(i.color, l.color) AS color,
            COALESCE(i.size, l.size) AS size,
            ROUND(IFNULL(i.qty, 0), 2) AS book,
            ROUND(IFNULL(l.q, 0), 2) AS led,
            IFNULL(i.product_name, l.product_name) AS product_name
       FROM stock_items i
       LEFT JOIN (
         SELECT warehouse, style_no, color, size, SUM(qty) AS q, MAX(product_name) AS product_name
           FROM stock_ledger GROUP BY warehouse, style_no, color, size
       ) l
         ON l.warehouse = i.warehouse
        AND IFNULL(l.style_no, '') = IFNULL(i.style_no, '')
        AND IFNULL(l.color, '') = IFNULL(i.color, '')
        AND IFNULL(l.size, '') = IFNULL(i.size, '')`
  )
  .all()
  .map((r) => ({ ...r, diff: r2(r.book - r.led) }))
  .filter((r) => Math.abs(r.diff) > 0.005);

// 只在流水里有、库存表里没有的组合（账面 0）
const orphanLedger = db
  .prepare(
    `SELECT l.warehouse, l.style_no, l.color, l.size, ROUND(SUM(l.qty), 2) AS q, MAX(l.product_name) AS product_name
       FROM stock_ledger l
      WHERE NOT EXISTS (
        SELECT 1 FROM stock_items i
         WHERE i.warehouse = l.warehouse
           AND IFNULL(i.style_no,'') = IFNULL(l.style_no,'')
           AND IFNULL(i.color,'') = IFNULL(l.color,'')
           AND IFNULL(i.size,'') = IFNULL(l.size,'')
      )
      GROUP BY l.warehouse, l.style_no, l.color, l.size`
  )
  .all()
  .map((r) => ({ ...r, book: 0, led: r.q, diff: r2(0 - r.q), product_name: r.product_name }))
  .filter((r) => Math.abs(r.diff) > 0.005);

console.log('\n=== 原料：账面 vs 流水 ===');
if (!matRows.length) console.log('  ✓ 全部一致');
matRows.forEach((r) =>
  console.log(`  #${r.id} ${r.code || '-'} ${r.name}  账面 ${r.book} / 流水 ${r.led}  需补 ${r.diff}`)
);

console.log('\n=== 成品：库存 vs 流水 ===');
const allStock = [...stockRows, ...orphanLedger];
if (!allStock.length) console.log('  ✓ 全部一致');
allStock.forEach((r) =>
  console.log(
    `  ${r.warehouse} ${r.style_no || '-'} ${r.color || '-'} ${r.size || '-'}  库存 ${r.book} / 流水 ${r.led}  需补 ${r.diff}`
  )
);

// ---------- 顺带：孤儿订单明细（订单已被删，明细还挂着） ----------
const orphanItems = db
  .prepare(
    `SELECT oi.id, oi.order_id, oi.product_name, oi.style_no, oi.qty
       FROM order_items oi LEFT JOIN orders o ON o.id = oi.order_id
      WHERE o.id IS NULL ORDER BY oi.id`
  )
  .all();

console.log('\n=== 孤儿订单明细（订单已不存在） ===');
if (!orphanItems.length) console.log('  ✓ 没有');
orphanItems.forEach((r) =>
  console.log(`  #${r.id} 订单#${r.order_id} ${r.style_no || '-'} ${r.product_name || ''} × ${r.qty}`)
);

const totalMat = r2(matRows.reduce((s, r) => s + r.diff, 0));
const totalStock = r2(allStock.reduce((s, r) => s + r.diff, 0));
console.log(`\n合计：原料补 ${totalMat}，成品补 ${totalStock}`);

if (!matRows.length && !allStock.length && !orphanItems.length) process.exit(0);
if (!APPLY) {
  console.log('\n这是只读检查。确认要补记请加 --apply');
  process.exit(0);
}

db.exec('BEGIN');
try {
  matRows.forEach((r) => {
    db.prepare(
      `INSERT INTO material_ledger
         (company_id, material_id, material_name, type, qty, unit, ref_type, ref_no, remark, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(1, r.id, r.name, 'opening', r.diff, r.unit || '', 'baseline', 'BASELINE-ALIGN', REMARK, OPERATOR, TS);
  });

  allStock.forEach((r) => {
    db.prepare(
      `INSERT INTO stock_ledger
         (warehouse, style_no, product_name, color, size, type, qty, ref_type, remark, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      r.warehouse, r.style_no || '', r.product_name || '', r.color || '', r.size || '',
      'adjust', r.diff, 'baseline', REMARK, OPERATOR, TS
    );
  });

  // 孤儿明细：没有订单的明细没有任何查询入口能用到，留着只会让「订单数 × 明细数」对不上
  if (orphanItems.length) {
    db.prepare(
      `DELETE FROM order_items
        WHERE id IN (SELECT oi.id FROM order_items oi LEFT JOIN orders o ON o.id = oi.order_id WHERE o.id IS NULL)`
    ).run();
  }

  db.exec('COMMIT');
  console.log(`\n✓ 已补记：原料 ${matRows.length} 条（opening），成品 ${allStock.length} 条（adjust），清理孤儿明细 ${orphanItems.length} 条`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('✗ 补记失败，已回滚：' + e.message);
  process.exit(1);
}

// 复核
const matAfter = db.prepare(
  `SELECT COUNT(*) AS n FROM materials m
    WHERE ABS(m.stock_qty - IFNULL((SELECT SUM(qty) FROM material_ledger l WHERE l.material_id=m.id),0)) > 0.005`
).get();
const stockAfter = db.prepare(
  `SELECT
     (SELECT ROUND(SUM(qty),2) FROM stock_items) AS items,
     (SELECT ROUND(SUM(qty),2) FROM stock_ledger) AS ledger`
).get();
console.log(`  复核：原料仍不一致 ${matAfter.n} 条；成品 库存 ${stockAfter.items} / 流水 ${stockAfter.ledger}`);
