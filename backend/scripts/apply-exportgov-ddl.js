/**
 * 数据导出与订阅（TS-N18-03 权限隐私与审计 / TS-N18-09 导出记录）
 * ========================================================================
 * 现状：项目里有 **21 个端点会吐 CSV**，其中只有「工资单导出」一处做了脱敏和留痕
 * （v1.32.0 字段级脱敏时补的）。其余 20 个是直接拼字符串 `res.send(csv)` 发出去的：
 *
 *   - 谁导的、什么时候导的、导走了多少行 —— 库里一个字都没有
 *   - 文件里没有水印，导出去之后转手十个人也追不回来
 *   - 客户名单、应收账龄、应付台账，各写各的拼装逻辑，脱敏规则挂不上
 *   - 没人能回答「上个月财务导了几次客户清单」，也没人能拦住「每晚导一次全量客户」
 *
 * 导出是数据离开系统的最后一米。这一米上没有记录，前面所有字段级脱敏都白做 ——
 * 因为拦不住的那一次导出，比看一百次页面更彻底。
 *
 * ## 四张表
 * - `export_defs`         可导出数据集白名单（字段、敏感级、所需权限、是否小样本抑制）
 * - `export_jobs`         每一次导出＝一条记录（行数、字段、水印、内容哈希、理由、谁导的）
 * - `export_subscriptions` 周期订阅（把某个数据集按月发给某人，必须有到期日）
 * - `export_deliveries`   订阅产出（站内可取 / 邮件待发），带下载次数
 *
 * ## 六条口径
 *
 * 1. **只允许从白名单选，不允许自定义 SQL / 自选表**。开放「随便导」的最后结果是
 *    有人导走 `users` 表和 `employees` 全字段，而这件事在日志里看起来完全正常。
 *
 * 2. **必须写导出理由**。手工导出强制填（最少 4 字）；订阅在创建时写一次，
 *    之后每次执行沿用。没有理由的导出记录，三个月后没人知道那次导出是干什么的。
 *
 * 3. **水印有两处**：文件首行注释（单号 + 人 + 时间 + 水印串），以及
 *    敏感数据集的**每行末列**（这样截图截到一行也能反查是谁导的）。
 *    水印串格式 `EXP-{单号}-{日期}-{4位随机}`，唯一索引，可反查。
 *
 * 4. **小样本抑制**：聚合类数据集（按部门/客户分组的计数与金额）在分组人数 < 阈值时，
 *    数值列替换为 `<N`，并计入 `suppressed_rows`。不抑制的话，用「合计 − 其他组」
 *    就能反推出某个人的工资或某个客户的欠款 —— 这正是原型要求的「敏感报表小样本抑制」。
 *
 * 5. **订阅必须有到期日**，且不允许永久。（`valid_until` 必填，最长 24 个月。）
 *    没有到期日的订阅会一直跑下去，换了岗位、离了职也没人停 —— 这是数据外流最常见的形态。
 *
 * 6. **订阅的「发出去了」不等于「邮件发出去了」**：本部署没有 SMTP，
 *    `channel='email'` 的投递状态直接标 `blocked` 并写明原因，产出落站内可取。
 *    假装发成功比不发更糟：收件人以为没收到，数据其实已经在库里等着被谁点走。
 *
 * ## 与已有模块的关系
 * 脱敏复用 `services/privacy.js` 的 `maskRows`（服务端掩码，规则来自 `field_guards`），
 * CSV 拼装复用 `utils/csv.js` 的 `toCsv`。本模块不新增任何脱敏规则，
 * 只保证「导出这条路和页面看到的是同一套规则」。
 */

const { db } = require('../src/db');

db.exec(`
CREATE TABLE IF NOT EXISTS export_defs (
  def_key TEXT PRIMARY KEY,                        -- 稳定标识，代码里引用它，不用中文名
  name TEXT NOT NULL,
  module TEXT,                                     -- 来源模块（页面归类用）
  table_name TEXT,                                 -- 对应 field_guards.table_name（脱敏规则匹配）
  perm TEXT,                                       -- 该数据集额外要求的权限点（双闸）
  sensitivity TEXT NOT NULL DEFAULT 'normal',      -- normal 一般 / sensitive 敏感 / restricted 受限
  columns TEXT,                                    -- JSON [{key,label}]，导出列以白名单为准
  small_sample INTEGER NOT NULL DEFAULT 0,         -- 1 表示聚合数据集，需要小样本抑制
  small_sample_min INTEGER NOT NULL DEFAULT 5,
  row_cap INTEGER NOT NULL DEFAULT 5000,           -- 单次导出行数上限（超了让人缩小范围）
  note TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS export_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_no TEXT NOT NULL UNIQUE,                     -- CK + yyyymmdd + 4
  def_key TEXT NOT NULL,
  def_name TEXT,
  sensitivity TEXT,
  params TEXT,                                     -- JSON 导出条件（原样留档）
  trigger_by TEXT NOT NULL DEFAULT 'manual',       -- manual 手工 / subscription 订阅
  row_count INTEGER NOT NULL DEFAULT 0,
  col_count INTEGER NOT NULL DEFAULT 0,
  masked_fields TEXT,                              -- 实际被掩码的字段（逗号分隔）
  masked_rows INTEGER NOT NULL DEFAULT 0,
  suppressed_rows INTEGER NOT NULL DEFAULT 0,
  watermark TEXT,                                  -- EXP-CK202610280001-20261028-A7F3
  file_name TEXT,
  content_hash TEXT,                               -- 内容 sha256（同一份文件导两次能看出来）
  reason TEXT,                                     -- 导出理由
  requester TEXT, requester_name TEXT, requester_role TEXT,
  ip TEXT, ua TEXT,
  subscription_id INTEGER,
  demo_tag TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS export_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_no TEXT NOT NULL UNIQUE,                     -- DY + yyyymmdd + 4
  name TEXT NOT NULL,
  def_key TEXT NOT NULL,
  def_name TEXT,
  params TEXT,
  freq TEXT NOT NULL DEFAULT 'monthly',            -- weekly / monthly
  day_of_month INTEGER,                            -- 月订阅：几号跑（1-28，避免 31 号不存在的月份）
  day_of_week INTEGER,                             -- 周订阅：周几（1=周一）
  channel TEXT NOT NULL DEFAULT 'inbox',           -- inbox 站内可取 / email 邮件（未配置时 blocked）
  recipients TEXT NOT NULL,                        -- JSON ["hr01","finance01"]
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,                       -- 必填：不允许永久订阅
  next_run_at TEXT,
  last_run_at TEXT,
  last_job_id INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',           -- active / paused / expired
  owner TEXT, owner_name TEXT,
  note TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS export_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  subscription_id INTEGER,
  recipient TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'inbox',
  status TEXT NOT NULL DEFAULT 'pending',          -- pending 待取 / taken 已取 / blocked 通道未配置 / failed
  notify_note TEXT,                                -- 为什么 blocked，要能看懂
  download_count INTEGER NOT NULL DEFAULT 0,
  first_download_at TEXT,
  last_download_at TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_def ON export_jobs(def_key);
CREATE INDEX IF NOT EXISTS idx_export_jobs_time ON export_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_export_jobs_req ON export_jobs(requester);
CREATE UNIQUE INDEX IF NOT EXISTS uq_export_jobs_watermark ON export_jobs(watermark);
CREATE INDEX IF NOT EXISTS idx_export_sub_status ON export_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_export_sub_next ON export_subscriptions(next_run_at);
CREATE INDEX IF NOT EXISTS idx_export_del_job ON export_deliveries(job_id);
CREATE INDEX IF NOT EXISTS idx_export_del_sub ON export_deliveries(subscription_id);
CREATE INDEX IF NOT EXISTS idx_export_del_rcpt ON export_deliveries(recipient, status);
`);

console.log('数据导出与订阅：4 张表 + 9 个索引已就绪');
console.log('  export_defs 数据集白名单 / export_jobs 导出记录');
console.log('  export_subscriptions 周期订阅 / export_deliveries 投递');
