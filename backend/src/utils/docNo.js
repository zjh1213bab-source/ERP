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

/** 表名/列名白名单：这两个值会拼进 SQL，只允许标识符形态（本项目铁律） */
const IDENT_RE = /^[a-z][a-z0-9_]{1,48}$/i;

/**
 * @param {string} prefix  单号前缀（如 'PD'）
 * @param {string} table   表名
 * @param {string} column  单号列名
 * @param {number} [width=4] 序号补零宽度（有个别单据是 3 位，如 AI 评测批次 EV）
 */
function nextNo(prefix, table, column = 'bill_no', width = 4) {
  if (!IDENT_RE.test(String(table)) || !IDENT_RE.test(String(column))) {
    throw new Error(`nextNo 表名/列名非法：${table}.${column}`);
  }
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
    + `${String(d.getDate()).padStart(2, '0')}`;
  const like = `${prefix}${ymd}%`;
  const rows = db.prepare(`SELECT ${column} AS no FROM ${table} WHERE ${column} LIKE ?`).all(like);

  /**
   * 取「当天该前缀下最大的尾部序号 + 1」
   *
   * 原来只取 `ORDER BY id DESC LIMIT 1` 再 `slice(-4)`，在手填单号的库上会出事：
   *   - 业务可能自己填过 `SO202610280007`（尾部是序号，没事）
   *   - 也可能填 `SO202610280001-A`（尾部不是数字）→ `Number('1-A')` 是 NaN
   *     → 生成 `SO202610280NaN`，之后所有取号全乱
   *   - 还可能是 `SO2026102800001`（5 位序号）→ slice(-4) 得到 `0001`=1，倒退
   *
   * 所以：**先剥掉「前缀 + 日期」这 8 位，剩下的才是序号部分**，再从中取开头的连续数字。
   *
   * 不能直接在整串上取尾部数字：`ZZTEST202610280007` 的尾部 6 位是 `280007`，
   * 那是日期的一部分，算出来会是 280008 号（真踩过）。
   * 也不能要求尾部必须是数字：手填的 `...0001-A` 是合法单号，取开头的 1 才是对的。
   */
  const head = `${prefix}${ymd}`;
  let max = 0;
  rows.forEach((r) => {
    const full = String(r.no || '').trim();
    if (!full.startsWith(head)) return;
    const m = /^(\d{1,6})/.exec(full.slice(head.length));
    if (!m) return;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return `${head}${String(max + 1).padStart(width, '0')}`;
}

module.exports = { nextNo };
