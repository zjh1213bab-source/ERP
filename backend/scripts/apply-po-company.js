/**
 * 采购单挂主体（`purchase_orders.company_id`）
 *
 * ## 为什么采购单必须单独加这一列
 *
 * 其他域的表大多能"顺着订单推主体"，采购推不出来 —— 实测这个库里
 * **32 张采购单一张都没挂销售订单**（`order_id` 全空）：面辅料采购是"给这个厂备货"，
 * 不是给某一张单买的。所以没有 `order_id` 可推，也没有 `company_id` 可筛 ——
 * 采购单在库里就是**完全没有主体维度**的。
 *
 * 后果与之前几轮同源：一旦列表按 `company_id` 过滤（而这一列不存在就只能默认 1），
 * 分部采购员新建的单会记到总部，然后自己看不见。
 *
 * ## 为什么默认 1 而不是 NULL
 *
 * 历史 32 张单都是总部采的，按 1 回填是事实。而且 `company_id` 参与范围过滤，
 * 允许 NULL 会出现"既不属于任何主体、也不被任何主体看见"的单 —— 那是最难查的形态。
 *
 * ## 谁能改
 *
 * 这一列由创建时写入（`writeCompanyOf`），**不提供修改入口**：
 * 采购单换了主体，它开出的应付、收到的货、退的料全都要跟着换，而那是一条链。
 */
const { db } = require('../src/db');

const cols = db.prepare("PRAGMA table_info('purchase_orders')").all().map((c) => c.name);

if (!cols.includes('company_id')) {
  db.exec('ALTER TABLE purchase_orders ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1');
  console.log('已加列 purchase_orders.company_id（默认 1 = 总部）');
} else {
  console.log('purchase_orders.company_id 已存在');
}

// 历史回填：有挂订单的按订单主体，没挂的留在默认主体
const linked = db.prepare(
  `UPDATE purchase_orders
      SET company_id = (SELECT company_id FROM orders o WHERE o.id = purchase_orders.order_id)
    WHERE order_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM orders o WHERE o.id = purchase_orders.order_id)`
).run().changes;
console.log(`按订单主体回填 ${linked} 张`);

// 索引：列表与看板都按主体筛
db.exec('CREATE INDEX IF NOT EXISTS idx_po_company ON purchase_orders(company_id, status)');

const stat = db.prepare('SELECT company_id, COUNT(*) c FROM purchase_orders GROUP BY company_id').all();
console.log('当前分布：', stat.map((x) => `主体${x.company_id} ${x.c} 张`).join(' / '));
