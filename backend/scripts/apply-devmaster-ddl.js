/**
 * M05 研发立项与款式生命周期 + 商品 SKU 与配码包装主档 —— 建表
 * ============================================================
 * 为什么单独建表而不用现有 tech_packs：
 *   tech_packs 是「一张订单的技术包」，生命周期从下单才开始。研发立项在**下单之前**，
 *   而且要回答「这个款今年开发了没有、核准了没有、什么时候第一次上架」——
 *   这些事件不能记在订单上（一个款可以没有订单，也可以有多个订单）。
 */
const { db } = require('../src/db');

const DDL = [
  // ---------- 1) 研发立项 ----------
  `CREATE TABLE IF NOT EXISTS dev_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_no TEXT NOT NULL UNIQUE,             -- DEV+YYYYMMDD+序号
    company_id INTEGER NOT NULL DEFAULT 1,
    style_no TEXT NOT NULL,                      -- 款号（研发期就可能没有正式款号，先占位）
    style_name TEXT,
    category TEXT,                               -- 品类：上衣/裤子/套装
    season TEXT,
    biz_type TEXT NOT NULL DEFAULT 'spot',       -- spot 现货 / custom 定制
    customer_id INTEGER,                         -- 目标客户（现货可空）
    source TEXT NOT NULL DEFAULT 'new',          -- new 全新开发 / repeat 返单复用 / new_pattern 同款新增花型
    dev_type TEXT,                               -- self 自主开发 / customer_sample 客户来样 / market 市场仿版
    reuse_project_id INTEGER,                    -- source=repeat 时必须指向原项目
    classify_approved_by TEXT,                   -- source=new_pattern 的批准分类人
    classify_approved_at TEXT,
    owner TEXT,                                  -- 技术负责人
    sales_owner TEXT,                            -- 销售对接人
    pattern_maker TEXT,                          -- 版师
    target_qty REAL NOT NULL DEFAULT 0,          -- 预计首单量（**只做计划，不产生采购/生产**）
    target_price REAL,                           -- 目标出厂价
    plan_launch_date TEXT,                       -- 计划上市日
    stage TEXT NOT NULL DEFAULT 'draft',         -- draft/tech/sample/confirmed/delivered/ordered/launched/closed
    status TEXT NOT NULL DEFAULT 'active',       -- active 在研 / closed 已结案 / cancelled 已取消
    pattern_reusable INTEGER NOT NULL DEFAULT 0, -- 1 = 版型经确认仍适用，返单可直接复用
    pattern_no TEXT,                             -- 版型编号
    sample_no TEXT,                              -- 样衣编号
    tech_pack_id INTEGER,                        -- 核准后生成/关联的技术包
    closed_reason TEXT,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    demo_tag TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_devp_stage ON dev_projects(stage)`,
  `CREATE INDEX IF NOT EXISTS idx_devp_style ON dev_projects(style_no)`,

  // ---------- 2) 里程碑事件 ----------
  // 关键：里程碑是**事件流**，不是主表上的一个状态位。
  // 「开发完成 / 销售接收 / 正式下单 / 投产 / 首次上架」各自计数，**绝不相加**。
  `CREATE TABLE IF NOT EXISTS dev_milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    kind TEXT NOT NULL,                          -- tech_approved 技术核准 / sales_accepted 销售接收 / order_placed 正式下单 / in_production 投产 / us_launched 首次美仓上架
    occurred_on TEXT NOT NULL,                   -- 发生日期
    qty REAL,                                    -- 该次事件的件数（下单/投产/上架）
    ref_type TEXT,                               -- order / batch / stock
    ref_id INTEGER,
    ref_no TEXT,
    note TEXT,
    operator TEXT,
    created_at TEXT NOT NULL,
    demo_tag TEXT
  )`,
  // 一次性事件不允许重复（重复登记会让「开发款数」虚高）
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_devms_once ON dev_milestones(project_id, kind)
     WHERE kind IN ('tech_approved','sales_accepted','us_launched')`,
  `CREATE INDEX IF NOT EXISTS idx_devms_proj ON dev_milestones(project_id)`,

  // ---------- 3) 研发任务（制版/样衣）----------
  // 与大货订单**分类型**：研发任务不进 orders，否则「制版没做完 → 订单开不了工」
  `CREATE TABLE IF NOT EXISTS dev_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    kind TEXT NOT NULL,                          -- pattern 制版 / sample 样衣 / tech_pack 工艺 / costing 核价
    title TEXT,
    owner TEXT,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'todo',         -- todo / doing / done / blocked / cancelled
    blocked_reason TEXT,                         -- blocked 必填
    output TEXT,                                 -- 产出（版型号 / 样衣号 / 工艺单号）
    reuse_pattern INTEGER NOT NULL DEFAULT 0,    -- 1 = 复用原版，不重新制版
    qty REAL NOT NULL DEFAULT 0,
    note TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    demo_tag TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_devt_proj ON dev_tasks(project_id)`,

  // ---------- 4) SKU 主档 ----------
  `CREATE TABLE IF NOT EXISTS sku_masters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL UNIQUE,                    -- TS-K002-A-3T
    style_no TEXT NOT NULL,
    style_name TEXT,
    pattern TEXT,                                -- 花型
    color TEXT,
    size TEXT,
    kind TEXT NOT NULL DEFAULT 'single',         -- single 单件 / set 套装
    unit TEXT NOT NULL DEFAULT '件',             -- 库存基本单位：单件=件，套装=套（**套不能当件**）
    barcode TEXT,
    customer_id INTEGER,                         -- 客户专属；NULL = 通用
    pack_spec_id INTEGER,                        -- 当前生效的配码/箱规版本
    status TEXT NOT NULL DEFAULT 'active',       -- active / inactive
    remark TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    demo_tag TEXT
  )`,
  // 单花单码唯一：同一款 + 花型 + 颜色 + 尺码只能有一个单件 SKU
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_sku_single
     ON sku_masters(style_no, IFNULL(pattern,''), IFNULL(color,''), IFNULL(size,''), IFNULL(customer_id,0))
     WHERE kind = 'single'`,
  `CREATE INDEX IF NOT EXISTS idx_sku_style ON sku_masters(style_no)`,

  // ---------- 5) 配码/包装关系（有版本）----------
  `CREATE TABLE IF NOT EXISTS pack_specs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_no TEXT NOT NULL,                       -- PK-V1 / SET-V1 / CTN-V1
    sku_id INTEGER,                              -- 箱规挂在单件 SKU 上；套装配码挂在套装 SKU 上
    kind TEXT NOT NULL,                          -- set 套装配码 / carton 箱规
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',        -- draft / active / superseded
    total_qty REAL NOT NULL DEFAULT 0,           -- 一箱/一套的合计件数（由明细算出，不手填）
    effective_from TEXT,
    effective_to TEXT,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    demo_tag TEXT
  )`,
  // 同一个对象的同一类组合关系，同时只能有一版生效
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_packspec_active
     ON pack_specs(IFNULL(sku_id,0), kind) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS pack_spec_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_id INTEGER NOT NULL,
    item_type TEXT NOT NULL DEFAULT 'ratio',     -- ratio 箱规配比（尺码） / component 套装组件（SKU）
    component_sku_id INTEGER,                    -- item_type=component 必填
    size TEXT,                                   -- item_type=ratio 必填
    qty REAL NOT NULL DEFAULT 0                  -- 每箱/每套的件数
  )`,
  `CREATE INDEX IF NOT EXISTS idx_packi_spec ON pack_spec_items(spec_id)`,

  // ---------- 6) SKU 别名（供应商/客户叫法）----------
  `CREATE TABLE IF NOT EXISTS sku_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku_id INTEGER NOT NULL,
    alias TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'supplier',     -- supplier 供应商别名 / customer 客户专属叫法 / system 旧编码
    status TEXT NOT NULL DEFAULT 'active',       -- active / inactive（停用后仍可查历史）
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    demo_tag TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_sku_alias ON sku_aliases(alias)`,
];

function run() {
  db.exec('BEGIN');
  try {
    DDL.forEach((sql) => db.exec(sql));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // 已建过表的话补列（DDL 幂等）
  const hasStatus = db.prepare('PRAGMA table_info(dev_projects)').all().some((c) => c.name === 'status');
  if (!hasStatus) {
    db.exec("ALTER TABLE dev_projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    console.log('  + dev_projects.status');
  }

  console.log('[apply-devmaster-ddl] 7 张表就绪：dev_projects / dev_milestones / dev_tasks / sku_masters / pack_specs / pack_spec_items / sku_aliases');
}

run();
