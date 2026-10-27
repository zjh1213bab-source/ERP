/**
 * 把 schema-cost.js 里的成本对象 DDL 应用到当前库，然后刷新 schema.js 快照
 *   node scripts/apply-cost-ddl.js
 */
const path = require('path');
const { db } = require('../src/db');
const DDL = require('../src/schema-cost');

let n = 0;
DDL.forEach((sql) => {
  try {
    db.exec(sql);
    n++;
  } catch (e) {
    console.error('失败：', sql.slice(0, 60), '→', e.message);
  }
});
console.log(`已执行 ${n}/${DDL.length} 条 DDL`);

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cost_objects','cost_entries','cost_snapshots')"
).all().map((r) => r.name);
console.log('成本表：', tables.join(', '));
