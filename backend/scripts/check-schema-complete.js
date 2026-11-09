/**
 * schema.js 完整性自检：空库建出来 vs 实际库，结构必须一致
 * ============================================================
 * 为什么需要这个脚本：
 *   `db.js` 的约定是「全新库直接由 schema.js 建出完整结构」。
 *   但历史上有些表是靠 `scripts/apply-*.js` 单独建的，**没有回写 schema.js**。
 *   后果是：老库（跑过 apply 脚本）一切正常，**新装的机器却缺表** ——
 *   财务总账的 gl_periods / gl_vouchers / gl_balances / gl_close_checks 就是这么漏的，
 *   平时看不出来，一交付到客户环境才报 `no such table`。
 *
 *   这个脚本把「空库 vs 实际库」比一遍：表名、索引名、每张表的列名，逐个对。
 *
 * 用法：
 *   node scripts/check-schema-complete.js            # 对比生产库 data/erp-mindmap.db
 *   node scripts/check-schema-complete.js --db xxx   # 对比指定库
 *
 * 退出码：0 一致；1 有差异（有差异就说明 schema.js 需要补，别去改实际库凑）
 */
const fs = require('fs');
const path = require('path');

const argIdx = process.argv.indexOf('--db');
const TARGET = path.resolve(
  __dirname, '..',
  argIdx > 0 && process.argv[argIdx + 1] ? process.argv[argIdx + 1] : 'data/erp-mindmap.db'
);

if (!fs.existsSync(TARGET)) {
  console.error('对比目标库不存在：' + TARGET);
  process.exit(1);
}

const TMP = path.resolve(__dirname, '../data/.schema-check.db');
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) {
  try { fs.unlinkSync(f); } catch (e) { /* 不存在 */ }
}

/* 用 schema.js 建一个空库（走 db.js，才能连 migrate 补列一起验证） */
process.env.DB_PATH = TMP;
process.env.ERP_SCHEDULER = '0';
const { db: fresh, driver } = require('../src/db');

const live = new fresh.constructor(TARGET, driver === 'node:sqlite'
  ? { readOnly: true }
  : { readonly: true });

const q = (conn, sql, ...p) => conn.prepare(sql).all(...p);

const tablesOf = (conn) =>
  q(conn, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
const indexesOf = (conn) =>
  q(conn, "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
const colsOf = (conn, t) => q(conn, `PRAGMA table_info(${t})`);

const ft = tablesOf(fresh);
const lt = tablesOf(live);

const missingTables = lt.filter((x) => !ft.includes(x));   // 实际库有、schema.js 建不出 → 最严重
const extraTables = ft.filter((x) => !lt.includes(x));     // schema.js 有、实际库没有 → 一般是还没迁移

const fi = indexesOf(fresh);
const li = indexesOf(live);
const missingIdx = li.filter((x) => !fi.includes(x));
const extraIdx = fi.filter((x) => !li.includes(x));

// 列差异：同一张表，实际库有的列、空库建不出来 → 新装环境会缺列
const colDiffs = [];
for (const t of lt) {
  if (!ft.includes(t)) continue;
  const a = new Set(colsOf(fresh, t).map((c) => c.name));
  const b = colsOf(live, t).map((c) => c.name);
  const miss = b.filter((c) => !a.has(c));
  if (miss.length) colDiffs.push({ table: t, missing: miss });
}

const problems = missingTables.length + missingIdx.length + colDiffs.length;

console.log('schema.js 完整性自检');
console.log('  空库（由 schema.js 建）：表 ' + ft.length + ' / 索引 ' + fi.length);
console.log('  实际库（' + path.basename(TARGET) + '）：表 ' + lt.length + ' / 索引 ' + li.length);
console.log('');

if (missingTables.length) {
  console.log('✗ 实际库有、schema.js 建不出的表（新装环境会缺）：');
  console.log('  ' + missingTables.join(', '));
  console.log('  → 用 scripts/rebuild-schema.js 或手工把 DDL 补进 schema.js，不要改实际库凑');
  console.log('');
}
if (colDiffs.length) {
  console.log('✗ 列缺失（新装环境会缺列）：');
  colDiffs.forEach((d) => console.log('  ' + d.table + '：缺 ' + d.missing.join(', ')));
  console.log('');
}
if (missingIdx.length) {
  console.log('✗ 索引缺失：' + missingIdx.join(', '));
  console.log('');
}
if (extraTables.length) console.log('· schema.js 有、实际库没有（一般是还没迁移）：' + extraTables.join(', '));
if (extraIdx.length) console.log('· 索引：schema.js 有、实际库没有 ' + extraIdx.length + ' 个');

fresh.close();
live.close();
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) {
  try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ }
}

if (problems) {
  console.log('\n结论：schema.js 与实际库不一致（' + problems + ' 处）—— 新装/交付环境会缺东西，必须先补齐');
  process.exit(1);
}
console.log('结论：一致，schema.js 可以独立建出完整结构 ✓');
