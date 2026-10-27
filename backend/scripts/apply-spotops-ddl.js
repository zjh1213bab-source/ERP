/**
 * M19 现货经营总览 + 备货补货与停补提案 —— 建表（幂等）
 * ============================================================
 * 缺口来源：GAP-ANALYSIS M19「现货经营总览」「备货补货与停补提案」。
 * 已有基础：`stock_items`（实物）、`stock_holds`（有效现货占用）、
 *          `sellable_projection`（可买量投影）、`supply_batches`（在产/待发/在途）,
 *          `stock_ledger`（出库流 → 销速与库龄）、`spot.js`（FIFO 库龄）。
 *
 * 为什么不新建「现货库存表」：
 *   可售 = 已上架合格 − 有效现货占用，两个都是既有账源（`sellable_projection` 已经是这份投影）。
 *   在途/在产在 `supply_batches`。销速在 `stock_ledger`。再加一张表就要同步四处，迟早对不上。
 *   本模块只新增「策略」与「提案」两类**决策记录**，不持有任何数量。
 *
 * 用法：node scripts/apply-spotops-ddl.js
 */
const { db } = require('../src/db');

db.exec(`
-- 1) 备货策略（按主体/款/类目/仓配置；没配就用全局行或内置默认）
CREATE TABLE IF NOT EXISTS spot_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  warehouse TEXT NOT NULL DEFAULT 'us',
  scope TEXT NOT NULL DEFAULT 'global',        -- global 全局 / category 类目 / style 按款
  style_no TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  target_cover_days REAL NOT NULL DEFAULT 60,  -- 目标覆盖天数（卖多少天）
  safety_days REAL NOT NULL DEFAULT 15,        -- 安全天数（比目标再留一点）
  lead_time_days REAL NOT NULL DEFAULT 45,     -- 下单到可售的周期（含船期）
  min_order_qty REAL NOT NULL DEFAULT 100,     -- 最小起订量
  lot_size REAL NOT NULL DEFAULT 50,           -- 补货批量倍数
  stop_cover_days REAL NOT NULL DEFAULT 120,   -- 覆盖天数超过它 → 停补
  stop_age_days REAL NOT NULL DEFAULT 90,      -- 最老库龄超过它 → 停补
  dead_days INTEGER NOT NULL DEFAULT 30,       -- 近 N 天零出库 → 停补
  min_sample_days INTEGER NOT NULL DEFAULT 5,  -- 窗口内至少 N 天有出库才算样本足够
  status TEXT NOT NULL DEFAULT 'active',       -- active / disabled
  note TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_spot_policy
  ON spot_policies(company_id, warehouse, scope, style_no, category);

-- 2) 提案批次（一次生成 = 一批，可对比上周/本周）
CREATE TABLE IF NOT EXISTS spot_proposal_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_no TEXT NOT NULL UNIQUE,                 -- SE+日期+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  warehouse TEXT NOT NULL DEFAULT 'us',
  as_of_date TEXT NOT NULL,                    -- 计算基准日
  window_days INTEGER NOT NULL DEFAULT 60,     -- 销速统计窗口
  line_count INTEGER NOT NULL DEFAULT 0,
  replenish_count INTEGER NOT NULL DEFAULT 0,
  stop_count INTEGER NOT NULL DEFAULT 0,
  urgent_count INTEGER NOT NULL DEFAULT 0,     -- 来不及（建议下单日已过）
  sample_short_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',        -- draft 草稿 / published 已下发 / archived 已归档
  is_current INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  published_by TEXT,
  published_at TEXT,
  note TEXT,
  demo_tag TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_spot_run_current
  ON spot_proposal_runs(company_id, warehouse) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_spot_run_status ON spot_proposal_runs(status);

-- 3) 提案行（一行 = 一个 SKU 的一条建议，数量全部是**当时快照**）
CREATE TABLE IF NOT EXISTS spot_proposal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                          -- replenish 补货 / stop 停补 / watch 观察
  reason_code TEXT NOT NULL,                   -- 见 services/spotops.js 的 REASON
  style_no TEXT NOT NULL,
  product_name TEXT,
  color TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  sku TEXT,

  -- 快照（改库存不影响历史提案）
  on_hand REAL NOT NULL DEFAULT 0,             -- 实物在库
  held REAL NOT NULL DEFAULT 0,                -- 有效现货占用（含已拣）
  sellable REAL NOT NULL DEFAULT 0,            -- 可买量
  in_transit REAL NOT NULL DEFAULT 0,          -- 在途（待发 + 在途）
  in_production REAL NOT NULL DEFAULT 0,       -- 在产
  future_available REAL NOT NULL DEFAULT 0,    -- 未来可订（叶子批次）
  qty_available REAL NOT NULL DEFAULT 0,       -- 可承诺量 = 可售 + 有 ETA 的在途/在产
  daily_out REAL NOT NULL DEFAULT 0,           -- 日均销（按自然日摊）
  out_qty REAL NOT NULL DEFAULT 0,             -- 窗口内出库合计
  out_days INTEGER NOT NULL DEFAULT 0,         -- 窗口内有出库的天数（样本量）
  sample_ok INTEGER NOT NULL DEFAULT 0,        -- 1 = 样本足够
  cover_days REAL,                             -- 覆盖天数（NULL = 样本不足不编）
  stockout_date TEXT,                          -- 预计断货日
  age_days INTEGER NOT NULL DEFAULT 0,         -- 最老批次库龄
  sell_through REAL NOT NULL DEFAULT 0,        -- 售罄率 %
  size_broken INTEGER NOT NULL DEFAULT 0,      -- 1 = 该码是断码
  unit_cost REAL,                              -- 单件成本（成本对象取，缺则 NULL）

  target_cover_days REAL NOT NULL DEFAULT 0,
  lead_time_days REAL NOT NULL DEFAULT 0,
  suggest_qty REAL NOT NULL DEFAULT 0,         -- 建议补货量（已按批量取整）
  suggest_order_date TEXT,                     -- 建议下单日 = 断货日 − 周期
  urgent INTEGER NOT NULL DEFAULT 0,           -- 1 = 建议下单日已过（来不及）
  priority TEXT NOT NULL DEFAULT 'P3',         -- P1 / P2 / P3
  reason TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending',      -- pending / approved / rejected / deferred
  approved_qty REAL NOT NULL DEFAULT 0,
  decided_by TEXT,
  decided_at TEXT,
  decide_note TEXT,
  demo_tag TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, style_no, color, size, kind)
);
CREATE INDEX IF NOT EXISTS idx_spotline_run ON spot_proposal_lines(run_id, kind);
CREATE INDEX IF NOT EXISTS idx_spotline_style ON spot_proposal_lines(run_id, style_no);

-- 4) 决策留痕（批准/驳回/暂缓；驳回必须写原因）
CREATE TABLE IF NOT EXISTS spot_proposal_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  line_id INTEGER NOT NULL,
  action TEXT NOT NULL,                        -- approve / reject / defer
  qty_before REAL NOT NULL DEFAULT 0,
  qty_after REAL NOT NULL DEFAULT 0,
  note TEXT,
  operator TEXT,
  created_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_spotdec_line ON spot_proposal_decisions(line_id);
`);

console.log('[spotops] 表已就绪：spot_policies / spot_proposal_runs / spot_proposal_lines / spot_proposal_decisions');
