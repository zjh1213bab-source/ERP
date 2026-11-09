// 在内存数据库中验证旧单号缺口和生产环境示例密钥检查。
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
for (const [table, column] of [
  ['equipment_downtimes', 'dt_no'],
  ['purchase_changes', 'change_no'],
  ['purchase_returns', 'return_no']
]) {
  db.exec(`CREATE TABLE ${table} (${column} TEXT)`);
}
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { db } };
const { nextNo } = require('../src/utils/docNo');

const date = new Date();
const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
for (const [prefix, table, column] of [
  ['DT', 'equipment_downtimes', 'dt_no'],
  ['PC', 'purchase_changes', 'change_no'],
  ['RT', 'purchase_returns', 'return_no']
]) {
  const insert = db.prepare(`INSERT INTO ${table} (${column}) VALUES (?)`);
  insert.run(`${prefix}${day}0001`);
  insert.run(`${prefix}${day}0003`);
  assert.strictEqual(nextNo(prefix, table, column), `${prefix}${day}0004`);
  insert.run(`${prefix}${day}10001-A`);
  assert.strictEqual(nextNo(prefix, table, column), `${prefix}${day}10002`);
}
db.close();

process.env.NODE_ENV = 'production';
process.env.ADMIN_PASSWORD = 'test-password-not-the-default';
process.env.CORS_ORIGIN = 'http://localhost:3100';
process.env.JWT_SECRET = 'please_change_me_to_a_long_random_secret_string';
const config = require('../src/config');
assert(config.fatalIssues().some((issue) => issue.key === 'JWT_SECRET'));
process.env.JWT_SECRET = 'a-distinct-random-secret-for-testing-12345';
assert(!config.fatalIssues().some((issue) => issue.key === 'JWT_SECRET'));
console.log('单号缺口和示例 JWT 密钥检查通过');
