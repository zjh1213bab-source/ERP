/**
 * M05-06 供方信息协同与技术再次审核 —— 建表
 * ============================================================
 * 这条链是三段，顺序不能反：
 *   A1 技术处理与制版分工（本单谁来处理、版自制还是外发还是复用）
 *   A2 材料供货条件（哪个供方、什么规格、什么价、什么依据）——**有版本**
 *   A3 技术复审并核准技术包（**必须引用同版本 A2**）
 *
 * 为什么不塞进 tech_packs：
 *   技术包是一张表的快照，而 A2 会变（换供方、改规格、用替代材料）。
 *   一旦 A2 变了，原来的 A3 核准就失去依据——必须能查出来「这份核准依据的是哪一版供货条件」。
 */
const { db } = require('../src/db');

const DDL = [
  // ---------- A1 技术处理与制版分工 ----------
  `CREATE TABLE IF NOT EXISTS tech_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tech_pack_id INTEGER NOT NULL UNIQUE,       -- 一个技术包只有一条分工
    order_id INTEGER,
    tech_owner TEXT,                            -- 本单技术处理人
    pattern_scope TEXT NOT NULL DEFAULT 'self', -- self 自制 / outsource 外发制版 / reuse 复用原版
    pattern_vendor_id INTEGER,                  -- 外发时的版房（供应商）
    pattern_vendor_name TEXT,
    reuse_tech_pack_id INTEGER,                 -- 复用时的原技术包
    pattern_price REAL,                         -- 版费
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'draft',       -- draft / confirmed
    confirmed_by TEXT,
    confirmed_at TEXT,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    demo_tag TEXT
  )`,

  // ---------- A2 供方确认（有版本）----------
  `CREATE TABLE IF NOT EXISTS supplier_confirms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    confirm_no TEXT NOT NULL UNIQUE,
    tech_pack_id INTEGER NOT NULL,
    requirement_no TEXT,                        -- 需求ID / 找料任务号
    material_id INTEGER,                        -- 物料ID（可为空：技术包里经常只有名称没有编码）
    material_key TEXT NOT NULL,                  -- 规范化物料键：有编码用 M{id}，没编码用 N{名称}
    material_name TEXT NOT NULL,
    spec TEXT,                                  -- 适用规格
    composition TEXT,                           -- 成分（替代材料变动要看得出来）
    supplier_id INTEGER,
    supplier_name TEXT,
    source_type TEXT NOT NULL DEFAULT 'existing', -- existing 现有成熟供方 / new_dev 新开发供方 / sample_only 仅样料
    sample_basis TEXT,                          -- 样料依据（色卡号 / 样布编号 / 检测报告）
    approval_ref TEXT,                          -- 批准依据（sample_only 必填：谁批的、批什么）
    unit_price REAL,
    lead_days INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    is_current INTEGER NOT NULL DEFAULT 0,      -- 1 = 当前版本
    superseded_by INTEGER,                      -- 被哪一版取代
    superseded_at TEXT,
    status TEXT NOT NULL DEFAULT 'draft',       -- draft / confirmed
    confirmed_by TEXT,
    confirmed_at TEXT,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    demo_tag TEXT
  )`,
  // 同一技术包 + 同一物料，同时只能有一版「当前」
  // **注意：不能用 IFNULL(material_id,0) 当键**——那样所有「没编码的物料」会共用一条版本链，
  // 第二条供方确认会把第一条冲掉（踩过）。要用规范化的 material_key。
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_supc_current
     ON supplier_confirms(tech_pack_id, material_key) WHERE is_current = 1`,
  `CREATE INDEX IF NOT EXISTS idx_supc_tp ON supplier_confirms(tech_pack_id)`,

  // ---------- A3 技术复审 ----------
  `CREATE TABLE IF NOT EXISTS tech_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_no TEXT NOT NULL UNIQUE,
    tech_pack_id INTEGER NOT NULL,
    confirm_id INTEGER NOT NULL,                -- 引用的 A2
    confirm_version INTEGER NOT NULL,           -- 引用时的 A2 版本号（快照）
    material_name TEXT,
    conclusion TEXT NOT NULL,                   -- pass 通过 / conditional 有条件通过 / reject 退回
    diff_reason TEXT,                           -- 差异原因（conditional / reject 必填）
    approved_by TEXT,
    approved_at TEXT,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    demo_tag TEXT
  )`,
  // 同一技术包 + 同一物料，同时只能有一份生效的复审结论
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_review_live
     ON tech_reviews(tech_pack_id, IFNULL(material_name,'')) WHERE conclusion <> 'reject'`,
  `CREATE INDEX IF NOT EXISTS idx_review_tp ON tech_reviews(tech_pack_id)`,
];

function run() {
  // tech_packs 补 demo_tag：演示要建自己的技术包，不能借用别人的（核准会改 status）
  const hasTag = db.prepare('PRAGMA table_info(tech_packs)').all().some((c) => c.name === 'demo_tag');
  if (!hasTag) {
    db.exec('ALTER TABLE tech_packs ADD COLUMN demo_tag TEXT');
    console.log('  + tech_packs.demo_tag');
  }

  db.exec('BEGIN');
  try {
    DDL.forEach((sql) => db.exec(sql));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log('[apply-supreview-ddl] 3 张表就绪：tech_assignments / supplier_confirms / tech_reviews');
}

run();
