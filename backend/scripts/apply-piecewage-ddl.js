/**
 * 计件工资 · 建表
 * ============================================================
 * 三张表：
 *   piece_rates       工序计件单价（按款可选、按生效日版本化）
 *   piece_wage_runs   月度计件核算单（draft → confirmed，可 void）
 *   piece_wage_items  明细（人 × 工序 × 订单 × 扎）
 *
 * 为什么单价要版本化：改价不能改历史。今天把「车缝」从 1.2 调到 1.5，
 * 上个月已经算过并确认过的工钱不能跟着变，否则对不上账、也没法解释给工人。
 * 做法：新价是一条新记录（effective_from = 生效日），查找时取「生效日 ≤ 报工日期」里最新的一条。
 * 不覆盖旧记录、不做 supersede 更新 —— 历史单价永远查得到。
 *
 * 幂等：全部 CREATE TABLE / INDEX IF NOT EXISTS；ALTER 前先查 PRAGMA。
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
CREATE TABLE IF NOT EXISTS piece_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  style_no TEXT,                          -- 空 = 通用工序单价（所有款共用）
  process_name TEXT NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'CNY',
  effective_from TEXT NOT NULL,           -- 生效日 YYYY-MM-DD
  effective_to TEXT,                      -- 空 = 长期有效
  status TEXT DEFAULT 'active',           -- active / disabled（停用后不再被选中，历史仍可查）
  note TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- 同一款同一工序同一生效日只能有一条（防重复录入导致取价摇摆）
CREATE UNIQUE INDEX IF NOT EXISTS idx_piece_rate_key
  ON piece_rates(IFNULL(style_no, ''), process_name, effective_from);
CREATE INDEX IF NOT EXISTS idx_piece_rate_lookup
  ON piece_rates(process_name, effective_from, status);

CREATE TABLE IF NOT EXISTS piece_wage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_no TEXT UNIQUE,
  period TEXT NOT NULL,                   -- 核算月份 YYYY-MM
  status TEXT DEFAULT 'draft',            -- draft / confirmed / void
  items_count INTEGER DEFAULT 0,
  employees_count INTEGER DEFAULT 0,
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  missing_rate_count INTEGER DEFAULT 0,   -- 缺单价的报工笔数（>0 不许确认）
  unassigned_count INTEGER DEFAULT 0,     -- 无法归属到人的报工笔数
  capped_count INTEGER DEFAULT 0,         -- 超报被拦下的笔数
  payload TEXT,                           -- 预览诊断快照（缺单价/无法归属/超报清单）
  note TEXT,
  created_by TEXT,
  created_at TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  void_reason TEXT
);

-- 一个月份只能有一份「已确认」的核算单（草案可以有多份/覆盖重建）
CREATE UNIQUE INDEX IF NOT EXISTS idx_piece_run_confirmed
  ON piece_wage_runs(period) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_piece_run_period ON piece_wage_runs(period, status);

CREATE TABLE IF NOT EXISTS piece_wage_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  employee_id INTEGER,
  employee_code TEXT,
  employee_name TEXT,
  department TEXT,
  style_no TEXT,
  process_name TEXT,
  order_id INTEGER,
  order_no TEXT,
  bundle_no TEXT,
  raw_qty REAL DEFAULT 0,                 -- 报工原始合格数
  qty REAL DEFAULT 0,                     -- 计件数量（超报封顶后）
  capped INTEGER DEFAULT 0,               -- 是否被扎件数封顶
  unit_price REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  rate_id INTEGER,
  rate_source TEXT,                       -- style / generic
  matched_by TEXT,                        -- id / name（怎么认出这个人的）
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_piece_item_run ON piece_wage_items(run_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_piece_item_emp ON piece_wage_items(employee_id, run_id);
`);

// 工资单加计件列（计件金额只能由核算单带进来，不允许手填）
if (!hasCol('payrolls', 'piece_wage')) {
  db.exec('ALTER TABLE payrolls ADD COLUMN piece_wage REAL DEFAULT 0');
  console.log('payrolls 新增列：piece_wage');
}

console.log('计件工资表就绪');
