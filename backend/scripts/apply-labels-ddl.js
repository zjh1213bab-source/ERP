/**
 * 扎标 DDL
 *
 * 只加一列：`production_reports.bundle_no`。
 *
 * 为什么需要：扎是车间追溯的最小单位，但报工一直是「按工序」报，不记是哪一扎做的。
 * 出了问题只能查到「车缝这道工序做过」，查不到「哪一扎」—— 而扎标存在的意义就是补上这一段。
 *
 * 关键约束：**这一列只用于追溯，不参与成本与进度的任何汇总**。
 * 报工累计、工序状态、成本分摊仍按 `order_id + node_id` 汇总，
 * 所以加这一列不会改变既有口径（这是敢加它的前提）。
 */
const { db } = require('../src/db');

const has = (t, c) => {
  try {
    return db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  } catch (e) {
    return false;
  }
};

if (has('production_reports', 'bundle_no')) {
  console.log('  · production_reports.bundle_no 已存在');
} else {
  db.exec('ALTER TABLE production_reports ADD COLUMN bundle_no TEXT');
  console.log('  ✓ production_reports.bundle_no');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_preport_bundle ON production_reports(bundle_no)');
console.log('  ✓ 索引 idx_preport_bundle');
console.log('\n完成。');
