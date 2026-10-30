/**
 * 单号生成 —— 前缀 + 当日最大序号 + 1
 * ============================================================
 * ## 为什么不能用 `COUNT(*)+1`
 *
 * 只要当天中间有一条被删掉（作废、撤单、夹具清理），`COUNT(*)` 就少 1，
 * 下一条生成的号会撞上已存在的号 → `UNIQUE constraint failed` → 接口 500。
 * 这个坑已在本项目实测复现过（预下单 PD 号，删一条再建即 500）。
 *
 * ## 为什么要有这一个文件
 *
 * 同一段"取最大号 +1 并跳过已占用"的逻辑，之前在 `services/matflow.js`、
 * `services/crm.js`、`services/pricing.js`、`services/notify.js`、`services/inspection.js`
 * 里各写了一遍（注释里都写着"禁用 COUNT(*)+1"）。再加新模块时不该再抄第五份：
 * 新代码统一走 `nextNo()`，老模块按需迁移（行为完全一致，风险低）。
 *
 * ## 口径
 *
 * - 前缀里自动拼上本地日期 `yyyyMMdd`，因此是「按天」递增；
 * - 取当日已有的**最大序号** + 1，而不是"条数 + 1"；
 * - 再 `while` 检查一次是否被占用（并发或手工插号时兜底），直到不冲突为止；
 * - 表名/列名做白名单校验（本项目铁律：SQL 里拼接的表名必须来自常量或校验过）。
 *
 * @param {string} table  表名（如 'pre_orders'）
 * @param {string} col    单号列名（如 'pre_order_no'）
 * @param {string} prefix 前缀（如 'PD'，不含日期）
 * @param {number} [width=4] 序号补零宽度
 * @returns {string} 形如 `PD20261030 0001`
 */
const { db } = require('../db');

const IDENT_RE = /^[a-z][a-z0-9_]{1,48}$/i;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localYmd(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function nextNo(table, col, prefix, width = 4) {
  if (!IDENT_RE.test(String(table)) || !IDENT_RE.test(String(col))) {
    throw new Error(`nextNo 表名/列名非法：${table}.${col}`);
  }
  const p = `${prefix}${localYmd()}`;
  const rows = db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ?`).all(`${p}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.no).slice(p.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  const build = (seq) => `${p}${String(seq).padStart(width, '0')}`;
  let seq = max + 1;
  let no = build(seq);
  // 兜底：极少数情况（并发写、手工插号）会撞上，继续往后找空位
  while (db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${col} = ?`).get(no)) {
    seq += 1;
    no = build(seq);
  }
  return no;
}

module.exports = { nextNo, localYmd };
