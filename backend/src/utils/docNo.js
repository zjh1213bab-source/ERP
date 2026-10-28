/**
 * 单据号生成：前缀 + yyyymmdd + 4 位序号
 *
 * 规则：**取当天已有最大号 +1**，不用 COUNT(*)+1。
 * COUNT 会把「作废后重号」和「删除后回退」都算错 —— 删掉一张就会生成一个已存在的号，
 * 而 `bill_no` 上有唯一约束，整个开票动作会直接炸掉。
 *
 * 为什么独立成文件：`routes/finance.js`（应收/应付开票）与
 * `services/apInvoice.js`（采购收货开应付）都要开票号，
 * 各写一份迟早出现「一边 4 位序号、一边 5 位」。
 */
const { db } = require('../db');
const { genNo } = require('./http');

function nextNo(prefix, table, column = 'bill_no') {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const row = db
    .prepare(`SELECT ${column} AS no FROM ${table} WHERE ${column} LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`${prefix}${ymd}%`);
  // 号形如 YS202610280001：日期 8 位之后才是 4 位序号，从尾部取，不从头部切
  const seq = row ? Number(String(row.no).slice(-4)) + 1 : 1;
  return genNo(prefix, seq);
}

module.exports = { nextNo };
