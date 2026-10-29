/**
 * 采购收货 → 自动开应付
 *
 * ## 这个函数以前是「死代码」
 * 它一直写在 `routes/finance.js` 里并导出，但**全项目没有一处调用它**。
 * 结果是：27 张已收货的采购单（31 万）从来没有生成过应付发票，
 * 财务账上完全看不到这批欠款 —— 只有采购页面显示「已收货」。
 *
 * 这类 bug 比写错更难发现：函数看起来是有的、逻辑也像对的，
 * 只是没人按那个按钮。所以除了接上调用，还要在冒烟里断言
 * 「收货后应付确实多了一张」（下面 `service` 里没有断言，断言在冒烟里）。
 *
 * ## 两处曾经算错的字段
 * 1. `supplier_id` 传 null，只存名字 → 应付永远没法按供应商汇总
 * 2. `due_date` 用采购单的「预计到货日」→ 那是「货什么时候到」，
 *    不是「钱什么时候该付」。月结 30 天的单子，货 9/20 到，到期日就被算成 9/20，
 *    账龄凭空多出 30 天
 *
 * ## 什么时候开票
 * **只在全部收完（allDone）时开**。分次收货时按「总量」开票会开早了，
 * 按「本次收货量」开票又会在最后一次多出一张零头票 —— 两种都让对账变难。
 * 全部收完开一张全额票，是这里最不容易出错的规则。
 */
const { db, now } = require('../db');
const T = require('./paymentTerms');
const { nextNo } = require('../utils/docNo');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * 采购单开应付（幂等：同一张采购单只会有一张非作废发票）
 * @returns {object|null} 发票行；金额为 0 或已存在时返回已有/ null
 */
function openAPForPurchase(purchaseId, userId) {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseId);
  if (!po) return null;

  const exist = db
    .prepare("SELECT * FROM ap_invoices WHERE purchase_id = ? AND status <> 'void'")
    .get(purchaseId);
  if (exist) return exist;

  const amount = r2(po.total_amount);
  if (amount <= 0) return null;

  const supplier = po.supplier_id
    ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(po.supplier_id)
    : null;

  const t = now();
  // 到期日 = 开票日（= 全部收完那天） + 供应商账期；账期读不出来就留空，**不猜一个 30 天**
  const due = T.apDueDate(supplier, String(t).slice(0, 10));

  /**
   * 应付跟着采购单走主体。
   *
   * v1.63 给 `purchase_orders` 加了 `company_id`：采购单自己就能回答"这是哪个主体采的"。
   * 在这个列存在之前只能顺着订单推，而**备货采购根本不挂订单**（实测 32 张单一张都没挂）
   * —— 于是分部的采购一律记到总部，谁也查不出来。现在优先用采购单上的主体，
   * 只有在老数据缺这一列（0/空）时才退回订单主体。
   */
  const companyId = Number(po.company_id)
    || Number((db.prepare('SELECT company_id FROM orders WHERE id = ?').get(po.order_id || 0) || {}).company_id)
    || 1;

  const info = db
    .prepare(
      `INSERT INTO ap_invoices
         (bill_no, purchase_id, supplier_id, supplier_name, currency, amount_orig, rate, amount,
          paid_amount, due_date, status, source, remark, created_by, created_at, updated_at, company_id)
       VALUES (?,?,?,?, 'CNY', ?, 1, ?, 0, ?, 'unpaid', 'purchase', ?, ?, ?, ?, ?)`
    )
    .run(
      nextNo('YF', 'ap_invoices'),
      purchaseId,
      po.supplier_id || null,
      (supplier && supplier.name) || po.supplier || null,
      amount,
      amount,
      due,
      `采购单 ${po.po_no} 收货自动开票${due ? '' : '（供应商未设账期，到期日为空）'}`,
      userId || 'system',
      t,
      t,
      companyId
    );

  return db.prepare('SELECT * FROM ap_invoices WHERE id = ?').get(Number(info.lastInsertRowid));
}

module.exports = { openAPForPurchase };
