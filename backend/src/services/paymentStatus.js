/**
 * 收付款「有效」的唯一口径
 * ============================================================
 * 为什么单独抽一个文件：这个判断散在四个地方，写成了三种样子 ——
 *
 *   finance.js  syncStatus   `p.status = 'valid'`                    ← 只认 valid
 *   bank.js     PAY_VALID    `status IN ('valid','confirmed')`        ← 认两种
 *   crm.js                   `status IN ('valid','confirmed')`        ← 认两种
 *   原来 statements.js       `status != 'reversed'`                   ← 认剩下的全部
 *
 * 后果不是「显示有点差」，而是**账永远对不平**：
 * 一条 status='confirmed' 的收款，在客户欠款里算「已收」（crm/bank 认），
 * 在核销回写里算「没收」（finance 不认）→ 发票的 paid_amount 永远不更新 →
 * 对账单的「流水口径」和「未收发票口径」差一笔钱，且没人知道差在哪。
 *
 * 现在统一成两句话：
 *   1. 只有 `valid` / `confirmed` 算「有效收款」（`draft`/`reversed`/其他一律不算）；
 *   2. `reversed_at` 非空即等已冲销，不管 status 写的是什么。
 *
 * 新代码一律用这里的片段，别再手写 `status = 'valid'`。
 */

/** 不带表别名：直接塞进 WHERE 里 */
const PAY_VALID = "status IN ('valid', 'confirmed') AND IFNULL(reversed_at, '') = ''";

/** 带表别名（多表 JOIN 时有歧义） */
const payValidOf = (alias) =>
  `${alias}.status IN ('valid', 'confirmed') AND IFNULL(${alias}.reversed_at, '') = ''`;

/** JS 侧判断（给逐行过滤用） */
const isValidPayment = (p) =>
  !!p && ['valid', 'confirmed'].includes(String(p.status)) && !p.reversed_at;

module.exports = { PAY_VALID, payValidOf, isValidPayment };
