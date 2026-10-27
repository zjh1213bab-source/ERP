/**
 * 内部邮件 DDL（P1 / 原型 TS-N01-05 ~ TS-N01-09）
 *   node scripts/apply-mail-ddl.js && node scripts/rebuild-schema.js
 *
 * 说明：ERP 内员工站内邮件，不搭公网邮箱服务器（无 SMTP/IMAP）。
 *      供应商 / 客户档案不是内部账号，不能收内部邮件。
 */
const { db } = require('../src/db');

const DDL = [
  // 会话（thread）：同一主题的来信来往，按每封信实际收件范围取交集
  `CREATE TABLE IF NOT EXISTS mail_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_no TEXT UNIQUE,                       -- TH+日期+序号
  subject TEXT NOT NULL,
  source_type TEXT,                            -- order/node/first_article/receipt/approval/none
  source_id INTEGER,
  source_label TEXT,                           -- 源单摘要（受权限控制的链接）
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_mt_source ON mail_threads(source_type, source_id)`,

  // 信件（frozen 内容；发送后不可原地改正文）
  `CREATE TABLE IF NOT EXISTS mail_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_no TEXT UNIQUE,                      -- EM+日期+序号
  thread_id INTEGER NOT NULL,
  parent_id INTEGER,                           -- 回复 / 转发的来源信件
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'normal',         -- normal 普通沟通 / confirm 需确认 / task 需办理
  sender TEXT NOT NULL,                        -- 发件人 username（来自有效账号，不可伪造）
  sender_name TEXT,
  sender_dept TEXT,
  acting_for TEXT,                             -- 代理发信：被代理人 username
  company_id INTEGER,
  source_type TEXT,
  source_id INTEGER,
  source_label TEXT,
  attachments TEXT,                            -- JSON: [{name,url,size,hash,ext}]
  request_no TEXT,                             -- 幂等请求号（防重复发送）
  version INTEGER NOT NULL DEFAULT 1,          -- 更正后递增
  confirm_due TEXT,                            -- 需确认截止
  task_due TEXT,                               -- 需办理期限
  status TEXT NOT NULL DEFAULT 'sent',         -- sent / partially_failed / recalled / corrected
  recall_reason TEXT,
  corrected_by INTEGER,                        -- 更正生成的新信 id
  corrects_id INTEGER,                         -- 本信更正的原信 id
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_mm_thread ON mail_messages(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mm_sender ON mail_messages(sender)`,
  `CREATE INDEX IF NOT EXISTS idx_mm_request ON mail_messages(request_no)`,

  // 收件行：一人一行，投递 / 已读 / 确认 各自独立
  `CREATE TABLE IF NOT EXISTS mail_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT NOT NULL,
  name TEXT,
  department TEXT,
  kind TEXT NOT NULL DEFAULT 'to',              -- to 收件人 / cc 抄送
  must_ack INTEGER NOT NULL DEFAULT 0,          -- 1=必确认行（需确认邮件的主收件人）
  delivery_status TEXT NOT NULL DEFAULT 'queued', -- queued / delivered / failed / recalled
  deliver_attempt INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  fail_reason TEXT,
  first_read_at TEXT,                           -- 只有真正打开正文才写
  read_flag INTEGER NOT NULL DEFAULT 1,         -- 本人标未读=0（不撤销 first_read_at）
  ack_state TEXT NOT NULL DEFAULT 'none',       -- none / pending / acked / questioned
  ack_at TEXT,
  ack_note TEXT,
  question TEXT,
  answer TEXT,                                  -- 发件人对疑问的答复
  is_delegate INTEGER NOT NULL DEFAULT 0,       -- 代理确认（不伪造本人知悉）
  delegate_by TEXT,
  star INTEGER NOT NULL DEFAULT 0,              -- 以下三个只作用本人副本
  archived INTEGER NOT NULL DEFAULT 0,
  trash INTEGER NOT NULL DEFAULT 0,
  UNIQUE (message_id, username)
)`,
  `CREATE INDEX IF NOT EXISTS idx_mr_user ON mail_recipients(username)`,
  `CREATE INDEX IF NOT EXISTS idx_mr_msg ON mail_recipients(message_id)`,

  // 需办理：无原任务时创建的唯一协同任务（一项交付物一名主责）
  `CREATE TABLE IF NOT EXISTS mail_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no TEXT UNIQUE,                         -- RW+日期+序号
  message_id INTEGER,
  thread_id INTEGER,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  due_at TEXT,
  requirement TEXT,
  status TEXT NOT NULL DEFAULT 'open',         -- open / done / cancelled
  done_at TEXT,
  done_note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_mt_task_owner ON mail_tasks(owner)`,

  // 投递回执事件：每人独立，失败只重试失败对象
  `CREATE TABLE IF NOT EXISTS mail_delivery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  event TEXT NOT NULL,                         -- queue / deliver / fail / retry / recall / read / ack / question
  detail TEXT,
  operator TEXT,
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_mde_msg ON mail_delivery_events(message_id)`,

  // 审计：发送 / 撤回 / 更正 / 正文读取 / 代理
  `CREATE TABLE IF NOT EXISTS mail_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER,
  thread_id INTEGER,
  action TEXT NOT NULL,                        -- send / recall / correct / read_body / delegate / retry
  username TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_ma_msg ON mail_audits(message_id)`,

  // 代理授权：有起止时间与范围，代理确认不伪造本人知悉
  `CREATE TABLE IF NOT EXISTS mail_delegates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,                         -- 委托人 username
  agent TEXT NOT NULL,                         -- 代理人 username
  scope TEXT NOT NULL DEFAULT 'all',           -- all 全部 / ack 只代确认 / send 只代发
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',       -- active / revoked / expired
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_md_agent ON mail_delegates(agent)`
];

let n = 0;
for (const sql of DDL) {
  db.exec(sql);
  n++;
}
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mail%'")
  .all()
  .map((r) => r.name);
console.log(`已执行 ${n} 条 DDL；新表：${tables.join(', ')}`);
