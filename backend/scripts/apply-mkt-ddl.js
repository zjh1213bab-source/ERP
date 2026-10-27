/**
 * 营销与素材 DDL（原型 M16）
 * ------------------------------------------------------------
 * 四张业务主表对应原型四个节点：
 *   mkt_tasks        N16-01 营销任务与上新日历
 *   mkt_assets       N16-02 品牌素材与授权
 *   mkt_campaigns    N16-03 活动预算与效果
 *   mkt_reviews      N16-04 运营复盘与协同
 *
 * 为什么「上新」要单独一张表，而不是直接写进 tech_packs / orders：
 *   原型规则写明「素材发布日期与商品技术投产不是同一状态」。
 *   营销能把款推到店铺，但技术确认、排产、入库各有自己的状态机。
 *   如果为了省事在上新时顺手把开发单标成 confirmed，生产端就会按未确认的版型投产。
 *   所以这里只做**依赖校验**（素材/技术/到仓），绝不回写生产状态。
 */
const { db } = require('../src/db');

function hasCol(t, c) {
  try {
    return db.prepare(`pragma table_info(${t})`).all().some((x) => x.name === c);
  } catch (e) {
    return false;
  }
}

/** 营销任务：一个款 × 一个渠道 × 一个计划上线日 = 一条任务 */
db.exec(`CREATE TABLE IF NOT EXISTS mkt_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no TEXT UNIQUE NOT NULL,              -- MK+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,                       -- 任务名（如「K002 春夏首波」）
  biz_type TEXT NOT NULL DEFAULT 'stock',    -- stock 现货上新 / custom 定制上新（决定要过哪些门槛）
  channel TEXT,                              -- 阿里现货 / Etsy / 独立站 / 微信小店
  shop_name TEXT,                            -- 店铺
  style_no TEXT,                             -- 款号（与订单/开发单/库存对齐的键）
  sku TEXT,
  product_name TEXT,
  customer_id INTEGER,                       -- 客户专属上新（决定素材授权范围能不能用）
  campaign_id INTEGER,                       -- 关联活动
  plan_launch_date TEXT,                     -- 计划上线（素材发布日，不是投产日）
  actual_launch_date TEXT,                   -- 实际上线
  owner TEXT,                                -- 主责
  depends TEXT,                              -- 依赖说明（合规资料 / 可靠到仓 …）
  status TEXT NOT NULL DEFAULT 'draft',      -- draft/material/ready/launched/reviewed/cancelled
  gate_json TEXT,                            -- 最近一次三项门槛校验快照（改素材/改技术后可重算）
  blocker TEXT,                              -- 卡在哪（人写的）
  remark TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

/** 任务拆步骤：营销是「运营+美工+设计」协作，光有任务状态看不出谁卡住 */
db.exec(`CREATE TABLE IF NOT EXISTS mkt_task_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  owner TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending/doing/done
  done_at TEXT,
  remark TEXT
)`);

/** 素材：版权来源 + 授权范围 + 有效期，三者缺一不可 */
db.exec(`CREATE TABLE IF NOT EXISTS mkt_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_no TEXT UNIQUE NOT NULL,             -- AS+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'image',        -- image/video/pattern/doc
  title TEXT NOT NULL,
  url TEXT,
  version TEXT,                              -- IMG-V2：与开发单版本要能对上
  style_no TEXT,
  product_name TEXT,
  tech_version TEXT,                         -- TECH-V2（素材与哪一版技术资料一致）
  scope TEXT NOT NULL DEFAULT 'channel',     -- public 公开 / channel 指定渠道 / exclusive 客户专属
  customer_id INTEGER,                       -- scope=exclusive 必填
  channels TEXT,                             -- scope=channel 时生效（逗号分隔）
  license_source TEXT,                       -- own 自有 / customer 客户提供 / supplier 供应商 / ai AI 生成
  license_from TEXT,
  license_to TEXT,                           -- 到期日：过了这天不能再上架
  ai_generated INTEGER NOT NULL DEFAULT 0,   -- AI 生成只能当草稿，必须人工审核
  status TEXT NOT NULL DEFAULT 'draft',      -- draft/pending/approved/revoked
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  remark TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

/** 任务 ↔ 素材：绑定即授权校验（客户专属/渠道范围/有效期） */
db.exec(`CREATE TABLE IF NOT EXISTS mkt_task_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'main',         -- main 主图 / detail 细节 / video / material
  bound_by TEXT,
  bound_at TEXT NOT NULL,
  UNIQUE (task_id, asset_id)
)`);

/** 活动：一个活动只有一种币种，账单和归因收入都必须同币种（不混加人民币） */
db.exec(`CREATE TABLE IF NOT EXISTS mkt_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_no TEXT UNIQUE NOT NULL,          -- CAM+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  channel TEXT,
  shop_name TEXT,
  currency TEXT NOT NULL DEFAULT 'CNY',      -- CNY / USD
  budget_amount REAL NOT NULL DEFAULT 0,     -- 批准预算（原币）
  start_date TEXT,
  end_date TEXT,
  attribution_days INTEGER NOT NULL DEFAULT 7,  -- 归因窗口：结束后还追几天
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'draft',      -- draft/approved/running/billed/closed/cancelled
  approved_by TEXT,
  approved_at TEXT,
  approve_note TEXT,
  actual_amount REAL NOT NULL DEFAULT 0,     -- 账单合计（同币种）
  attributed_orders INTEGER NOT NULL DEFAULT 0,
  attributed_revenue REAL NOT NULL DEFAULT 0,      -- 归因收入（原币）
  attributed_revenue_cny REAL NOT NULL DEFAULT 0,  -- 归因收入（本币，仅供同类比）
  attributed_gross_cny REAL NOT NULL DEFAULT 0,    -- 归因毛利（本币，来自成本对象；不是净利润）
  roas REAL,                                       -- 归因收入 ÷ 实际花费（同币种）
  settled_at TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

/** 实际账单：广告平台/代理/发票 */
db.exec(`CREATE TABLE IF NOT EXISTS mkt_campaign_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  bill_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,                    -- 必须与活动币种一致
  vendor TEXT,
  ref_no TEXT,
  source TEXT,                               -- ads 平台 / agency 代理 / invoice 发票 / other
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
)`);

/** 运营复盘：事实 → 原因 → 动作 → 责任期限 → 效果 */
db.exec(`CREATE TABLE IF NOT EXISTS mkt_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_no TEXT UNIQUE NOT NULL,            -- REV+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  period TEXT,                               -- YYYY-MM
  topic TEXT NOT NULL,
  category TEXT,                             -- shortage 缺货/tech_delay 技术延期/complaint 客诉/asset 素材/conversion 转化/other
  evidence TEXT,                             -- 证据：单号、事件、工单
  source_type TEXT,                          -- order/campaign/style/customer/manual
  source_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',      -- draft/open/doing/done
  owner TEXT,
  due_date TEXT,
  findings TEXT,                             -- 原因分析
  closed_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

/** 复盘行动项：没有负责人和期限的「动作」等于没做 */
db.exec(`CREATE TABLE IF NOT EXISTS mkt_review_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL,
  owner TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending/doing/done/cancelled
  done_at TEXT,
  result TEXT,
  created_at TEXT NOT NULL
)`);

/** 任务状态流转留痕（谁在什么时候把任务推到上新，出了事要能追） */
db.exec(`CREATE TABLE IF NOT EXISTS mkt_task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  operator TEXT,
  note TEXT,
  gate_json TEXT,
  created_at TEXT NOT NULL
)`);

// 轻量补列（后续加字段时按这个模式，保证脚本可重复执行）
if (!hasCol('mkt_tasks', 'biz_type')) {
  db.exec("ALTER TABLE mkt_tasks ADD COLUMN biz_type TEXT NOT NULL DEFAULT 'stock'");
  console.log('[mkt-ddl] mkt_tasks + biz_type');
}
// 复盘的原因分析是给人看的正文，不能塞演示标记，所以单独留一列
if (!hasCol('mkt_reviews', 'demo_tag')) {
  db.exec('ALTER TABLE mkt_reviews ADD COLUMN demo_tag TEXT');
  console.log('[mkt-ddl] mkt_reviews + demo_tag');
}
if (!hasCol('mkt_campaigns', 'attributed_revenue_cny')) {
  db.exec('ALTER TABLE mkt_campaigns ADD COLUMN attributed_revenue_cny REAL NOT NULL DEFAULT 0');
  console.log('[mkt-ddl] mkt_campaigns + attributed_revenue_cny');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_task_status ON mkt_tasks(status, plan_launch_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_task_channel ON mkt_tasks(channel)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_task_style ON mkt_tasks(style_no)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_step_task ON mkt_task_steps(task_id, seq)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_asset_status ON mkt_assets(status, license_to)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_asset_style ON mkt_assets(style_no)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_ta_task ON mkt_task_assets(task_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_ta_asset ON mkt_task_assets(asset_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_camp_status ON mkt_campaigns(status, start_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_bill_camp ON mkt_campaign_bills(campaign_id, bill_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_rev_period ON mkt_reviews(period, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_act_review ON mkt_review_actions(review_id, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_mkt_log_task ON mkt_task_logs(task_id)');

console.log('[mkt-ddl] done');
