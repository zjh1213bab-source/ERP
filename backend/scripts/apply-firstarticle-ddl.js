/**
 * 首件确认与工位工艺 DDL（P0-6 / 原型 TS-N08-03）
 *   node scripts/apply-firstarticle-ddl.js && node scripts/rebuild-schema.js
 */
const { db } = require('../src/db');

const DDL = [
  // 首件确认单：按冻结版做首件，质检复核后限定放行
  `CREATE TABLE IF NOT EXISTS first_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fa_no TEXT UNIQUE NOT NULL,                 -- FA+日期+序号
  order_id INTEGER NOT NULL,
  order_no TEXT,
  style_no TEXT,
  cut_order_id INTEGER,                       -- 首件取自哪张裁剪单（可空）
  tech_pack_id INTEGER,                       -- 冻结版技术版
  tech_pack_version TEXT,                     -- 版本快照：后续改版会让本首件失效
  fa_type TEXT NOT NULL DEFAULT 'full',       -- full 全项首件 / simple 成熟返单简化
  batch_qty INTEGER NOT NULL DEFAULT 0,       -- 本批件数（放行上限）
  sample_bundle_no TEXT,                      -- 首件取自哪一扎（追溯）
  sample_size TEXT,                           -- 首件尺码
  scope TEXT,                                 -- 检查范围（领口/尺寸/缝线…）
  status TEXT NOT NULL DEFAULT 'draft',       -- draft 草稿 / submitted 待复核 / passed 已放行 / conditional 限定放行 / rejected 不合格退回
  conclusion TEXT,                            -- 结论说明
  release_qty INTEGER NOT NULL DEFAULT 0,     -- 放行量（0=不放行）
  limit_note TEXT,                            -- 限定放行条件（conditional 必填）
  inspector TEXT,                             -- 首件制作/送检人
  inspected_at TEXT,
  released_by TEXT,
  released_at TEXT,
  return_to TEXT,                             -- sales 退回销售 / tech 退回总部技术
  return_reason TEXT,
  evidence TEXT,                              -- 证据图片 JSON 数组
  remark TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_fa_order ON first_articles(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fa_status ON first_articles(status)`,

  // 首件检查项：尺寸实测 + 关键工艺核对
  `CREATE TABLE IF NOT EXISTS first_article_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fa_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'size',          -- size 尺寸 / craft 关键工艺 / look 外观
  workstation TEXT,                           -- 关联工位（工艺项）
  part TEXT NOT NULL,                         -- 部位 / 检查项
  spec TEXT,                                  -- 标准值 / 要求
  tolerance TEXT,                             -- 公差
  measured TEXT,                              -- 实测值 / 实测结论
  result TEXT,                                -- ok 合格 / ng 不合格 / 空=未测
  critical INTEGER NOT NULL DEFAULT 0,        -- 1=关键项，NG 不允许放行
  remark TEXT,
  checked_by TEXT,
  checked_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_fac_fa ON first_article_checks(fa_id)`,

  // 工位工艺卡：每道工序在哪个工位做、怎么做、关键控制点是什么
  `CREATE TABLE IF NOT EXISTS workstation_crafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  node_id INTEGER,                            -- order_nodes.id
  node_name TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  workstation TEXT,                           -- 工位号 / 工位名，如 C-01 车缝一组
  craft_name TEXT NOT NULL,                   -- 工序 / 工艺名称
  requirement TEXT,                           -- 工艺要求（作业指导）
  machine TEXT,                               -- 设备 / 辅具
  key_point TEXT,                             -- 关键控制点
  std_time REAL NOT NULL DEFAULT 0,           -- 标准工时（分钟/件）
  critical INTEGER NOT NULL DEFAULT 0,        -- 1=关键工序（首件必检）
  operator TEXT,                              -- 工位责任人
  status TEXT NOT NULL DEFAULT 'active',
  remark TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_wc_order ON workstation_crafts(order_id)`
];

let n = 0;
for (const sql of DDL) {
  db.exec(sql);
  n++;
}
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('first_articles','first_article_checks','workstation_crafts')")
  .all()
  .map((r) => r.name);
console.log(`已执行 ${n} 条 DDL；新表：${tables.join(', ')}`);
