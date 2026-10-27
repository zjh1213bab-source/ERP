/**
 * M06 有限产能排程 —— 建表（幂等）
 * ============================================================
 * 缺口来源：GAP-ANALYSIS M06「有限产能排程」。
 * 已有基础：设备台账（台时产能）+ 设备停机（产能损失）+ 接单评审（交期承诺）
 *          + 齐套缺料（净缺口）+ 13 道工序（order_nodes）。
 * 本模块把「订单 × 工序」真正排到「工作中心 × 日期 × 工时」上，且**不许超卖产能**。
 *
 * 为什么不复用 commitment_nodes 的日期：
 *   commitment_nodes 是交期倒排的节点计划（P1..E1），只看天、不看工作中心和产能，
 *   多个订单可以同时「占用」同一天而不冲突。有限产能排程必须按工作中心逐日扣工时，
 *   所以另开 schedule_runs / schedule_tasks，commitment 仍作为交期来源。
 *
 * 为什么不新建「工作中心产能表」：
 *   工作中心的设备与台时产能已在 equipment 里，停机占用已在 equipment_downtimes 里，
 *   再建一张产能表就要同步三处。这里只建**班次日历**（哪天开几个班、几小时），
 *   可用工时 = 班次基准工时 − 当天停机占用。
 *
 * 用法：node scripts/apply-schedule-ddl.js
 */
const { db } = require('../src/db');

db.exec(`
-- 1) 工作中心班次日历（显式配置，缺行 = 当天不可用，不假设 8 小时）
CREATE TABLE IF NOT EXISTS wc_calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  work_center TEXT NOT NULL,
  cal_date TEXT NOT NULL,                      -- YYYY-MM-DD
  base_hours REAL NOT NULL DEFAULT 8,          -- 基准可用工时（0 = 休息 / 停产）
  start_hour REAL NOT NULL DEFAULT 8,          -- 班次开始（8 = 08:00）
  is_workday INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  demo_tag TEXT,
  UNIQUE(work_center, cal_date)
);
CREATE INDEX IF NOT EXISTS idx_wccal_wc ON wc_calendars(work_center, cal_date);
CREATE INDEX IF NOT EXISTS idx_wccal_date ON wc_calendars(cal_date);

-- 2) 工序产能定额（工序 → 工作中心 + 单件标准工时 + 换款调试 + 效率）
CREATE TABLE IF NOT EXISTS process_standards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_name TEXT NOT NULL UNIQUE,           -- 对应 order_nodes.name
  work_center TEXT NOT NULL,                   -- 承做工作中心
  std_minutes REAL NOT NULL DEFAULT 0,         -- 单件标准工时（分钟/件），<=0 视为未配置
  setup_minutes REAL NOT NULL DEFAULT 0,       -- 换款调试（分钟/次，同工作中心换款才计）
  efficiency REAL NOT NULL DEFAULT 85,         -- 效率系数 %（人机实际发挥）
  batch_min_qty REAL NOT NULL DEFAULT 0,       -- 起做批量（低于该数量不单独开线，只提示）
  active INTEGER NOT NULL DEFAULT 1,
  remark TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_pstd_wc ON process_standards(work_center);

-- 3) 排程批次（版本化，已发布只读）
CREATE TABLE IF NOT EXISTS schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_no TEXT NOT NULL UNIQUE,                 -- PS+日期+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  algo TEXT NOT NULL DEFAULT 'edd',            -- edd 交期优先 / spt 短工时优先 / lock 沿用锁定量
  horizon_from TEXT NOT NULL,                  -- 排程窗口起
  horizon_to TEXT NOT NULL,                    -- 排程窗口止
  scope_note TEXT,                             -- 纳入范围（自动生成，便于追溯）
  order_count INTEGER NOT NULL DEFAULT 0,
  task_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  block_count INTEGER NOT NULL DEFAULT 0,
  late_count INTEGER NOT NULL DEFAULT 0,
  full_days INTEGER NOT NULL DEFAULT 0,        -- 满负荷天数（利用率 ≥ 100%）
  util_rate REAL NOT NULL DEFAULT 0,           -- 整体产能利用率 %
  status TEXT NOT NULL DEFAULT 'draft',        -- draft 草稿 / published 已发布 / archived 已归档
  is_current INTEGER NOT NULL DEFAULT 0,       -- 当前生效排程（同公司唯一）
  created_by TEXT,
  created_at TEXT NOT NULL,
  published_by TEXT,
  published_at TEXT,
  archived_at TEXT,
  note TEXT,
  demo_tag TEXT
);
-- 同一公司只能有一个「当前生效」排程，数据库兜底
CREATE UNIQUE INDEX IF NOT EXISTS ux_run_current ON schedule_runs(company_id) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_run_status ON schedule_runs(status);

-- 4) 排程任务（订单 × 工序 → 工作中心 × 时段）
CREATE TABLE IF NOT EXISTS schedule_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  order_no TEXT,
  node_id INTEGER,                             -- order_nodes.id（可空）
  style_no TEXT,
  process_name TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  work_center TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  std_minutes REAL NOT NULL DEFAULT 0,         -- 定额快照（后续改定额不影响历史批次）
  setup_hours REAL NOT NULL DEFAULT 0,
  est_hours REAL NOT NULL DEFAULT 0,           -- 本任务占用工时（含换款）
  start_at TEXT NOT NULL,                      -- YYYY-MM-DD HH:mm
  end_at TEXT NOT NULL,
  day_load TEXT,                               -- JSON：{"2026-10-28":6.5,...} 每天占用明细
  due_date TEXT,                               -- 订单交期快照
  finish_by_due INTEGER NOT NULL DEFAULT 1,    -- 本工序是否在交期前完成
  locked INTEGER NOT NULL DEFAULT 0,           -- 人工锁定，重排不动
  lock_reason TEXT,
  status TEXT NOT NULL DEFAULT 'planned',      -- planned 计划 / released 已下发 / done 已完成
  note TEXT,
  created_at TEXT NOT NULL,
  demo_tag TEXT,
  UNIQUE(run_id, order_id, process_name)
);
CREATE INDEX IF NOT EXISTS idx_stask_run ON schedule_tasks(run_id, work_center);
CREATE INDEX IF NOT EXISTS idx_stask_order ON schedule_tasks(run_id, order_id);
CREATE INDEX IF NOT EXISTS idx_stask_start ON schedule_tasks(run_id, start_at);

-- 5) 排程冲突（无定额 / 无班次 / 缺料 / 交期不可达 / 窗口装不下 / 倒序）
CREATE TABLE IF NOT EXISTS schedule_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  type TEXT NOT NULL,                          -- no_standard/no_calendar/material_short/late_delivery/horizon_short/no_due/review_pending/sequence
  level TEXT NOT NULL DEFAULT 'warn',          -- block 硬 / warn 软 / info
  order_id INTEGER,
  order_no TEXT,
  work_center TEXT,
  process_name TEXT,
  task_id INTEGER,
  on_date TEXT,
  detail TEXT NOT NULL,
  suggestion TEXT,
  metric REAL NOT NULL DEFAULT 0,              -- 缺料数 / 超期天数 / 缺工时
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_note TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_sconf_run ON schedule_conflicts(run_id, level);

-- 6) 人工调整留痕（改排程必须写原因）
CREATE TABLE IF NOT EXISTS schedule_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  task_id INTEGER,
  order_no TEXT,
  process_name TEXT,
  field TEXT NOT NULL,                         -- start_at / work_center / locked / est_hours
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  operator TEXT,
  created_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_schg_run ON schedule_changes(run_id);
`);

const cols = db.prepare("PRAGMA table_info(process_standards)").all().map((c) => c.name);
console.log('[schedule] 表已就绪：wc_calendars / process_standards / schedule_runs / schedule_tasks / schedule_conflicts / schedule_changes');
console.log('[schedule] process_standards 列：', cols.join(', '));
