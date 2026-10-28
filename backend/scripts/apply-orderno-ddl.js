/**
 * 订单号手填 —— 建表与加列
 *
 * 两件事：
 *   1. `order_no_logs`  改号留痕（旧号、新号、原因、连带改了多少行）
 *   2. `purchase_orders` 加 `order_id` / `order_no`  —— 采购订单关联订单
 *
 * ## 为什么改号要单独一张留痕表，不复用 audit_logs
 *
 * `audit_logs` 记的是「谁调了哪个接口」（路径 + 状态码），不记内容 ——
 * 这是它的设计约束（不读 body，避免把业务数据抄进日志表）。
 * 而改号必须回答「原来是什么号」，这个信息只能专门存。
 *
 * ## 为什么 purchase_orders 要冗余 order_no
 *
 * 采购单要打印、要按订单筛、要在供应商对账单上体现「这是给哪张订单备的料」。
 * 只存 order_id 的话，每次打印都要 JOIN 回订单表；而订单号是可以改的，
 * JOIN 出来的是新号——对，这正是我们要的：**采购单上显示的永远是当前订单号**。
 * 冗余列由 `services/orderNo.js` 的级联同步维护，不在业务代码里各改各的。
 */
const { db } = require('../src/db');

db.exec(`
CREATE TABLE IF NOT EXISTS order_no_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  old_no TEXT NOT NULL,
  new_no TEXT NOT NULL,
  reason TEXT NOT NULL,                    -- 改号原因（必填，≥6 字）
  synced_rows INTEGER NOT NULL DEFAULT 0,  -- 连带改了多少行
  synced_tables TEXT,                      -- 逐表明细（JSON）
  operator TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onl_order ON order_no_logs(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_onl_new ON order_no_logs(new_no);
`);

/* ---------------- purchase_orders 加两列 ---------------- */
const cols = db.prepare('PRAGMA table_info(purchase_orders)').all().map((c) => c.name);
const add = (name, ddl) => {
  if (cols.includes(name)) return false;
  db.exec(`ALTER TABLE purchase_orders ADD COLUMN ${ddl}`);
  return true;
};
const a1 = add('order_id', 'order_id INTEGER');
const a2 = add('order_no', 'order_no TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_po_order ON purchase_orders(order_id)');

console.log('订单号手填：1 张表 + 索引已就绪');
console.log('  order_no_logs   改号留痕（旧号 / 新号 / 原因 / 连带行数）');
console.log(`  purchase_orders ${a1 ? '新增 order_id' : 'order_id 已存在'}${a2 ? ' / 新增 order_no' : ' / order_no 已存在'}`);
