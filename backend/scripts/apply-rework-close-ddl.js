/**
 * 返工报废与生产结单 DDL（P1 / 原型 TS-N08-06）
 *   node scripts/apply-rework-close-ddl.js && node scripts/rebuild-schema.js
 *
 * 1) rework_orders：返工/报废处理单（原工序、原因、数量、损失、批准、复验、返工次数）
 * 2) production_closures：生产结单（五项检查快照、部分关闭与争议挂账、实际日期与录入时间分开）
 */
const { db } = require('../src/db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS rework_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rw_no TEXT UNIQUE NOT NULL,                  -- RW+日期+序号
  order_id INTEGER NOT NULL,
  order_no TEXT,
  order_item_id INTEGER,                       -- 关联款（可空）
  node_id INTEGER,                             -- 原工序 order_nodes.id
  node_name TEXT,                              -- 原工序名（快照）
  type TEXT NOT NULL DEFAULT 'rework',          -- rework 返工 / scrap 报废
  source TEXT NOT NULL DEFAULT 'inhouse',       -- inhouse 本厂 / outsource 外协 / supplier 供方 / customer 客户端
  responsibility TEXT,                         -- 责任方（车间/外协厂/供方/客户改单）
  reason TEXT NOT NULL,                         -- 不良原因（必填）
  qty REAL NOT NULL DEFAULT 0,                  -- 不良数量
  rework_times INTEGER NOT NULL DEFAULT 1,      -- 第几次返工
  qty_ok REAL NOT NULL DEFAULT 0,               -- 返工后合格量
  qty_scrap REAL NOT NULL DEFAULT 0,            -- 报废量
  cost_labor REAL NOT NULL DEFAULT 0,           -- 人工损失
  cost_material REAL NOT NULL DEFAULT 0,        -- 材料损失
  cost_total REAL NOT NULL DEFAULT 0,           -- 合计损失（进成本 rework 层）
  cost_entry_id INTEGER,                        -- 已写入的成本明细（幂等标记）
  status TEXT NOT NULL DEFAULT 'draft',          -- draft / pending_approve / approved / in_progress / closed / rejected
  approved_by TEXT,
  approved_at TEXT,
  approve_note TEXT,
  reinspect_result TEXT,                        -- pass / fail
  reinspect_by TEXT,
  reinspect_at TEXT,
  reinspect_note TEXT,
  evidence TEXT,
  remark TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rw_order ON rework_orders(order_id, status)`,

  `CREATE TABLE IF NOT EXISTS production_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  close_no TEXT UNIQUE NOT NULL,                -- CL+日期+序号
  order_id INTEGER NOT NULL,
  order_no TEXT,
  close_type TEXT NOT NULL DEFAULT 'full',       -- full 全结 / partial 部分关闭
  status TEXT NOT NULL DEFAULT 'closed',          -- closed / blocked

  -- 结单检查快照（结单当时的数字，事后可追溯）
  open_rework_cnt INTEGER NOT NULL DEFAULT 0,    -- 未闭环返工报废
  open_rework_qty REAL NOT NULL DEFAULT 0,
  open_qc_cnt INTEGER NOT NULL DEFAULT 0,        -- 质量未决
  wip_nodes INTEGER NOT NULL DEFAULT 0,          -- 未完成工序数
  total_nodes INTEGER NOT NULL DEFAULT 0,
  unshipped_qty REAL NOT NULL DEFAULT 0,         -- 未交（未出库）件数
  leftover_m REAL NOT NULL DEFAULT 0,            -- 余料（米）
  cost_open INTEGER NOT NULL DEFAULT 0,          -- 成本是否还没归集
  blocked_json TEXT,                             -- 卡住的检查项（JSON）
  warn_json TEXT,                                -- 软提示（JSON）

  dispute_note TEXT,                             -- 部分关闭：争议挂账说明（必填）
  balance_source TEXT,                           -- 部分关闭：余额来源（未交/在制/质量）
  follow_up_owner TEXT,                          -- 未决项跟进人
  actual_close_date TEXT,                        -- 实际结单日期（人工填，可与录入日不同）
  recorded_at TEXT,                              -- 录入时间（系统时间，补录也留真实时间）
  closed_by TEXT,
  remark TEXT,
  created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pclose_order ON production_closures(order_id)`
];

DDL.forEach((sql) => db.exec(sql));
console.log('新增 2 张表 / 2 个索引');
console.log('完成。记得执行 scripts/rebuild-schema.js');
