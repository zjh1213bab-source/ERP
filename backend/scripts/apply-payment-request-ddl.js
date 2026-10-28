/**
 * 付款申请单：建表 + payments 加来源列
 *
 * 为什么要有这张表：
 *   现在付款是直接在「往来账」页登记一笔 `INSERT INTO payments`，
 *   填个金额、勾几张发票就出去了 —— **没有任何人事先批过**。
 *   出纳（warehouse 角色也能碰）可以直接把钱付出去，事后账上只多一条流水。
 *   这不是「流程不够优雅」，是内控上没有闸门。
 *
 * 设计要点（都是被现实逼出来的）：
 *   1. 申请单必须绑**发票明细**，金额 = 明细合计，不许手填一个总数
 *      —— 否则钱出去了、账上应付还挂着，形成"付了但没销账"的烂账
 *   2. 同一张发票不许重复申请：未完成的申请会**占用**该发票的未付额
 *   3. 审批通过 ≠ 已付：approved 之后还要出纳执行付款，才真正写 payments
 *   4. 付款必须指定银行账户（对账的前提，没有账户的流水永远对不上银行）
 */
const { db, now } = require('../src/db');

const t = now();

// ---------- 1. payment_requests ----------
db.exec(`
CREATE TABLE IF NOT EXISTS payment_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  req_no TEXT UNIQUE,                          -- FKSQ202610280001
  supplier_id INTEGER,
  supplier_name TEXT,
  amount REAL NOT NULL DEFAULT 0,              -- = 明细合计（不许手填）
  currency TEXT DEFAULT 'CNY',
  plan_pay_date TEXT,                          -- 计划付款日
  method TEXT,                                 -- 银行转账/承兑/现金
  bank_account_id INTEGER,                     -- 出账账户（付款时必填）
  status TEXT NOT NULL DEFAULT 'draft',        -- draft/submitted/approved/rejected/paid/cancelled
  reason TEXT,                                 -- 申请理由（给审批人看）
  remark TEXT,
  approval_instance_id INTEGER,
  payment_id INTEGER,                          -- 执行付款后生成的 payments.id
  created_by TEXT,
  submitted_at TEXT,
  decided_at TEXT,
  decided_by TEXT,
  paid_at TEXT,
  paid_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_preq_supplier ON payment_requests(supplier_id);
CREATE INDEX IF NOT EXISTS idx_preq_status ON payment_requests(status);
`);

// ---------- 2. payment_request_items ----------
// 一张申请单下的发票明细。金额与发票未付额分开存：
// `open_amount` 是申请那一刻的发票未付余额（快照），`amount` 是本次要付的
db.exec(`
CREATE TABLE IF NOT EXISTS payment_request_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  invoice_id INTEGER NOT NULL,
  bill_no TEXT,
  due_date TEXT,
  open_amount REAL DEFAULT 0,                  -- 申请时发票未付余额（快照）
  amount REAL NOT NULL DEFAULT 0,              -- 本次申请金额
  created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_preq_item ON payment_request_items(request_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_preq_item_inv ON payment_request_items(invoice_id);
`);

// ---------- 3. payments.payment_request_id ----------
const payCols = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
if (!payCols.includes('payment_request_id')) {
  db.exec('ALTER TABLE payments ADD COLUMN payment_request_id INTEGER');
  console.log('加列 payments.payment_request_id');
} else {
  console.log('payments.payment_request_id 已存在');
}

// ---------- 4. 审批流：付款的默认流程 ----------
// 只建一条，金额区间拉到最大；财务能自己改区间做「大额加签总经理」
const hasPayFlow = db
  .prepare("SELECT COUNT(*) c FROM approval_flows WHERE target_type = 'payment'")
  .get().c;
if (!hasPayFlow) {
  db.prepare(
    `INSERT INTO approval_flows (name, target_type, min_amount, max_amount, steps, active, created_at, sla_hours, escalate_role)
     VALUES (?, 'payment', 0, 999999999, ?, 1, ?, 24, 'admin')`
  ).run(
    '付款审批（默认：财务审核 → 总经理）',
    JSON.stringify([
      { role: 'finance', name: '财务审核', sla_hours: 8, escalate_to: 'admin' },
      { role: 'admin', name: '总经理审批', sla_hours: 24, escalate_to: 'admin' }
    ]),
    t
  );
  console.log('新建付款审批流（财务 → 总经理）');
} else {
  console.log('付款审批流已存在');
}

const cnt = db.prepare('SELECT COUNT(*) c FROM payment_requests').get().c;
console.log(`\npayment_requests: ${cnt} 条`);
console.log('表结构就绪');
