/**
 * M24 客户营销与消息 —— 建表（幂等）
 * ============================================================
 * 十个节点拆成十张表：
 *   模板 / 订阅 / 业务事件 / 发送队列 / 投递回执 / 频控规则 /
 *   到货提醒 / 渠道能力 / 微信绑定 / 效果归因
 *
 * 为什么把「事件」和「发送」拆两张表：
 *   一个上新事件要发给 N 个订阅了该款号的客户，事件只有一条，
 *   发送计划有 N 条；去重键也分两层 —— 事件层防「同一件事重复触发」，
 *   发送层防「同一个客户同一渠道重复发」。
 *
 * 用法：node scripts/apply-notify-ddl.js
 */
const { db } = require('../src/db');

function hasCol(table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (e) {
    return false;
  }
}

db.exec(`
-- 1) 消息模板（按事件 × 渠道 × 语言分版本；同一组合同时只有一条生效）
CREATE TABLE IF NOT EXISTS msg_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL DEFAULT 1,
  event_key TEXT NOT NULL,                  -- new_product / restock / order_status / cycle_due / promo_digest / inquiry_reply
  channel TEXT NOT NULL,                    -- site / email / wechat
  lang TEXT NOT NULL DEFAULT 'zh',          -- zh / en
  version INTEGER NOT NULL DEFAULT 1,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  variables_json TEXT,                      -- 模板里可用变量，发送时缺省即失败
  status TEXT NOT NULL DEFAULT 'draft',     -- draft / pending / approved / retired
  approved_by TEXT,
  approved_at TEXT,
  change_note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_tpl_ver ON msg_templates(event_key, channel, lang, version);
-- 同一事件 + 渠道 + 语言，只能有一条生效：改文案 = 出新版本并把旧的标 retired
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_tpl_live ON msg_templates(event_key, channel, lang) WHERE status='approved';

-- 2) 订阅（客户 × 主题 × 渠道；退订保留记录，不删行）
CREATE TABLE IF NOT EXISTS msg_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  account_id INTEGER,
  topic TEXT NOT NULL,                      -- order / service / arrival / marketing
  channel TEXT NOT NULL,                    -- site / email / wechat
  status TEXT NOT NULL DEFAULT 'never',     -- subscribed / unsubscribed / never
  opt_in_source TEXT,                       -- account / request / sales / import
  opt_in_at TEXT,
  opt_out_at TEXT,
  opt_out_reason TEXT,
  verify_status TEXT DEFAULT 'none',        -- none / pending / verified / failed（邮箱核验）
  verified_at TEXT,
  verify_token TEXT,
  locale TEXT DEFAULT 'zh',
  timezone TEXT DEFAULT 'Asia/Shanghai',
  frequency TEXT DEFAULT 'immediate',       -- immediate / daily / weekly（只影响营销摘要）
  remark TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_sub ON msg_subscriptions(customer_id, topic, channel);

-- 3) 业务事件（一个事件一条；幂等键防重复触发）
CREATE TABLE IF NOT EXISTS msg_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL DEFAULT 1,
  event_key TEXT NOT NULL,                  -- new_product / restock / order_status / cycle_due / promo_digest
  biz_type TEXT,                            -- mall_product / supply_batch / order / cycle / campaign
  biz_id INTEGER,
  style_no TEXT,
  sku TEXT,
  title TEXT,
  payload_json TEXT,
  occurred_at TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,          -- event_key|biz_id|日期（同一件事一天只发一次）
  created_by TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_ev_biz ON msg_events(biz_type, biz_id);

-- 4) 发送队列（事件 × 客户 × 渠道 一条）
CREATE TABLE IF NOT EXISTS msg_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_no TEXT NOT NULL UNIQUE,
  event_id INTEGER,
  company_id INTEGER NOT NULL DEFAULT 1,
  customer_id INTEGER,
  account_id INTEGER,
  topic TEXT NOT NULL,
  channel TEXT NOT NULL,
  template_id INTEGER,
  template_version INTEGER,
  recipient TEXT,                           -- 邮箱 / openid / 账号
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'queued',    -- queued / held / submitted / delivered / read / failed / skipped
  skip_reason TEXT,
  retry_cnt INTEGER NOT NULL DEFAULT 0,
  max_retry INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT,
  fail_reason TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  scheduled_at TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  read_at TEXT,
  opened_at TEXT,                           -- 打开 ≠ 已读，单独记
  provider_msg_id TEXT,
  degraded_from TEXT,                       -- 微信不可用降级到站内/邮件时记来源渠道
  demo_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_out_status ON msg_outbox(status);
CREATE INDEX IF NOT EXISTS idx_msg_out_cust ON msg_outbox(customer_id);

-- 5) 投递回执（生成 / 暂缓 / 跳过 / 已提交 / 送达 / 失败 / 打开 / 已读 / 重试 / 降级）
CREATE TABLE IF NOT EXISTS msg_delivery_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL,
  channel TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  provider_code TEXT,
  operator TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_log_out ON msg_delivery_logs(outbox_id);

-- 6) 频控规则（全局一份 + 可按客户覆盖）
CREATE TABLE IF NOT EXISTS msg_frequency_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'global',     -- global / customer
  customer_id INTEGER,
  max_per_day INTEGER NOT NULL DEFAULT 1,
  max_per_week INTEGER NOT NULL DEFAULT 4,
  min_gap_minutes INTEGER NOT NULL DEFAULT 720,
  quiet_start TEXT DEFAULT '21:00',
  quiet_end TEXT DEFAULT '08:00',
  digest_hour INTEGER DEFAULT 10,           -- 客户当地时间几点发
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_freq ON msg_frequency_rules(scope, COALESCE(customer_id, 0));

-- 7) 到货 / 上新提醒（客户订阅某个款号，等可售 > 0 时通知）
CREATE TABLE IF NOT EXISTS msg_arrival_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_no TEXT NOT NULL UNIQUE,
  company_id INTEGER NOT NULL DEFAULT 1,
  customer_id INTEGER NOT NULL,
  account_id INTEGER,
  style_no TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'restock',     -- new_product / restock
  threshold_qty REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'waiting',   -- waiting / notified / cancelled
  notified_at TEXT,
  outbox_id INTEGER,
  source TEXT,                              -- mall_publish / stock_in / manual
  note TEXT,
  demo_tag TEXT,
  created_at TEXT
);
-- 同一客户同一款号同一类型只留一条待通知，重复登记不叠加
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_alert_wait
  ON msg_arrival_alerts(customer_id, style_no, kind) WHERE status='waiting';

-- 8) 渠道能力（微信 / 邮件 / 站内各自到底能不能用，要有依据）
CREATE TABLE IF NOT EXISTS msg_channel_capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unauthorized',  -- enabled / disabled / unauthorized
  verify_status TEXT DEFAULT 'unverified',      -- verified / unverified
  evidence TEXT,
  reason TEXT,
  verified_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_cap ON msg_channel_capabilities(company_id, channel);

-- 9) 微信绑定（openid + 订阅状态 + 可用模板）
CREATE TABLE IF NOT EXISTS msg_wechat_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  account_id INTEGER,
  openid TEXT NOT NULL UNIQUE,
  unionid TEXT,
  subscribe_status TEXT NOT NULL DEFAULT 'unknown',  -- subscribed / unsubscribed / unknown
  template_ids_json TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  last_sync_at TEXT,
  note TEXT,
  demo_tag TEXT,
  created_at TEXT
);

-- 10) 效果归因（送达 / 阅读 / 询价 / 订单 四层，订单只认已确认）
CREATE TABLE IF NOT EXISTS msg_attributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER,
  event_id INTEGER,
  customer_id INTEGER,
  style_no TEXT,
  stage TEXT NOT NULL,                      -- delivered / read / inquiry / order
  ref_type TEXT,                            -- mall_inquiry / order
  ref_id INTEGER,
  ref_no TEXT,
  window_days INTEGER DEFAULT 7,
  revenue_cny REAL DEFAULT 0,
  snapshot_at TEXT,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_attr ON msg_attributions(outbox_id, stage, ref_id);
`);

/* ---------- 轻量迁移：后续补列写在这里 ---------- */
if (!hasCol('msg_outbox', 'opened_at')) {
  db.exec('ALTER TABLE msg_outbox ADD COLUMN opened_at TEXT');
  console.log('[notify-ddl] msg_outbox + opened_at');
}
// 模板的 change_note 是给人看的变更说明，会被后续版本改写 ——
// 演示标记单独一列（凡是「会被业务逻辑覆盖的字段」都不能当标记，这个坑踩过三次）
if (!hasCol('msg_templates', 'demo_tag')) {
  db.exec('ALTER TABLE msg_templates ADD COLUMN demo_tag TEXT');
  console.log('[notify-ddl] msg_templates + demo_tag');
}

console.log('[notify-ddl] done');
