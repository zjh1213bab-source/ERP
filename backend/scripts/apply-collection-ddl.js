/**
 * 应收催收任务：建表
 *
 * 为什么要有这张表：
 *   应收逾期 11 张 278 万，但系统里**没有「谁去催、催了几次、客户答应什么时候付」**。
 *   业务员在微信里催，财务在系统里看不到；客户说「下周付」，下周没人记得；
 *   真付了，也没人把催收的事收尾。对账单只解决了「账说不清」，解决不了「没人跟」。
 *
 * 三个设计决定（都写在表结构里）：
 *
 *   1. **一个客户一张任务，不是一张发票一张任务**
 *      业务员是跟这个客户谈的（「你们这 3 张票一起结」），不是跟发票谈。
 *      按发票派单会出现「同一个客户 5 张任务、5 个人在催」，客户被烦死。
 *
 *   2. **欠多少由发票实时算，不存快照**
 *      `remaining` 每次读取时从未付发票重算。存快照就必然出现
 *      「催收说欠 80 万、账上只欠 20 万」—— 这种数字对不上，业务员立刻不信系统。
 *      只存 `overdue_amount`（生成时快照）用于对比「催了这么久降了多少」。
 *
 *   3. **承诺还款（PTP）是核心字段**
 *      催收唯一有意义的产出就是「客户答应哪天付多少」。
 *      只说「下周付」不写金额，等于没承诺 —— 所以 promise_amount 与 promise_date 必须成对。
 */
const { db, now } = require('../src/db');

const t = now();

db.exec(`
CREATE TABLE IF NOT EXISTS collection_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no TEXT UNIQUE,                          -- CS202610280001
  customer_id INTEGER,
  customer_name TEXT,

  -- 负责人解析三级：客户档案 → 订单跟单员 → 未指派（宁可标「待指派」也不瞎分）
  owner_user_id INTEGER,
  owner_username TEXT,
  owner_name TEXT,
  owner_source TEXT,                            -- profile / order / none

  -- 金额
  overdue_amount REAL NOT NULL DEFAULT 0,       -- 生成时的逾期快照（看降了多少）
  remaining REAL NOT NULL DEFAULT 0,            -- 上次刷新时的剩余（仅供展示，读取时实时重算）
  invoice_count INTEGER DEFAULT 0,
  max_overdue_days INTEGER DEFAULT 0,
  oldest_due TEXT,

  -- 承诺还款（PTP）
  promise_date TEXT,
  promise_amount REAL,
  promised_at TEXT,
  promise_count INTEGER DEFAULT 0,              -- 承诺过几次（老赖识别）
  promise_broken INTEGER DEFAULT 0,             -- 违约过几次

  level TEXT,                                   -- D1 1-30 / D2 31-60 / D3 61-90 / D4 90+
  status TEXT NOT NULL DEFAULT 'open',          -- open/following/promised/escalated/closed
  next_follow_at TEXT,
  follow_count INTEGER DEFAULT 0,               -- 跟进次数

  closed_reason TEXT,                           -- paid/bad_debt/legal/offset/other
  closed_note TEXT,
  closed_at TEXT,
  closed_by TEXT,

  note TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_col_customer ON collection_tasks(customer_id);
CREATE INDEX IF NOT EXISTS idx_col_status ON collection_tasks(status);
CREATE INDEX IF NOT EXISTS idx_col_owner ON collection_tasks(owner_username);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS collection_task_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  invoice_id INTEGER NOT NULL,
  bill_no TEXT,
  due_date TEXT,
  open_at_create REAL DEFAULT 0,                -- 挂单时的未付（快照）
  open_now REAL DEFAULT 0,                      -- 上次刷新时的未付
  settled_at TEXT,                              -- 结清时间（<>NULL 即这笔已收）
  created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_col_item ON collection_task_items(task_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_col_item_inv ON collection_task_items(invoice_id);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS collection_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  channel TEXT,                                 -- phone/wechat/email/visit/letter
  contact TEXT,                                 -- 对接人（客户那边的谁）
  result TEXT,                                  -- no_answer/promised/refused/partial/dispute/other
  promise_date TEXT,
  promise_amount REAL,
  note TEXT,
  operator TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_col_log_task ON collection_logs(task_id);
`);

const n = db.prepare('SELECT COUNT(*) c FROM collection_tasks').get().c;
console.log(`collection_tasks: ${n} 条`);
console.log('催收表结构就绪');
