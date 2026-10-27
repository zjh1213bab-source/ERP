/**
 * 从实际数据库文件导出 DDL，生成 docs/schema-ddl.js（供 db.js 引用）
 * 用途：db.js 被误清空后的应急重建；也可在结构变更后刷新这份快照。
 *   node scripts/rebuild-schema.js
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB = path.resolve(__dirname, '../data/erp-mindmap.db');
const OUT = path.resolve(__dirname, '../src/schema.js');

const d = new DatabaseSync(DB);
const rows = d.prepare(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
).all();

const stmts = rows
  .map((r) => {
    let sql = String(r.sql).trim();
    if (r.type === 'table') sql = sql.replace(/^CREATE TABLE\s+(?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ');
    if (r.type === 'index') sql = sql.replace(/^CREATE UNIQUE INDEX\s+(?!IF NOT EXISTS)/i, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
                                       .replace(/^CREATE INDEX\s+(?!IF NOT EXISTS)/i, 'CREATE INDEX IF NOT EXISTS ');
    if (r.type === 'view') sql = sql.replace(/^CREATE VIEW\s+(?!IF NOT EXISTS)/i, 'CREATE VIEW IF NOT EXISTS ');
    return sql.endsWith(';') ? sql : sql + ';';
  });

const body = `/**
 * 数据库结构快照（自动生成，勿手改）
 * ---------------------------------------------
 * 由 scripts/rebuild-schema.js 从实际库导出，包含 ${rows.length} 个对象
 * （${rows.filter((r) => r.type === 'table').length} 张表 + ${rows.filter((r) => r.type === 'index').length} 个索引）。
 * 表格改名 / 加列请先改 DDL（db.js 里的 migrate 或本文件重新生成），再刷库。
 */
module.exports = [
${stmts.map((s) => '  ' + JSON.stringify(s)).join(',\n')}
];
`;

fs.writeFileSync(OUT, body, 'utf8');
console.log(`已生成 ${OUT}`);
console.log(`对象 ${rows.length} 个：表 ${rows.filter((r) => r.type === 'table').length}，索引 ${rows.filter((r) => r.type === 'index').length}`);
