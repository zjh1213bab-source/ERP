/**
 * 经营驾驶舱 DDL（账龄现金与经营分析）
 * ------------------------------------------------------------
 * 为什么要落表而不是纯计算：
 *   - 现金预测必须能**回看**：上个月预测这周能收 80 万，实际收了多少？不留快照就永远不知道预测准不准，
 *     也就没法改回款假设。所以每跑一次预测留一批 `cash_forecasts` + 分周明细。
 *   - 经营指标同理：周转天数、现金转换周期要能看趋势，也要能对比「当时以为的」和「后来实际的」。
 */
const { db } = require('../src/db');

function hasCol(t, c) {
  try {
    return db.prepare(`pragma table_info(${t})`).all().some((x) => x.name === c);
  } catch (e) {
    return false;
  }
}

db.exec(`CREATE TABLE IF NOT EXISTS cash_forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  forecast_no TEXT UNIQUE NOT NULL,          -- XJ+YYYYMMDD+序号
  company_id INTEGER,                        -- 空 = 全集团合并现金流
  base_date TEXT NOT NULL,                   -- 基准日（以这天为起算）
  weeks INTEGER NOT NULL DEFAULT 13,         -- 预测周数
  opening_cash REAL NOT NULL DEFAULT 0,      -- 期初现金
  inflow_total REAL NOT NULL DEFAULT 0,
  outflow_total REAL NOT NULL DEFAULT 0,
  closing_cash REAL NOT NULL DEFAULT 0,
  min_cash REAL NOT NULL DEFAULT 0,          -- 期间最低现金（判断缺口用）
  min_week INTEGER,                          -- 最低点落在第几周
  gap_amount REAL NOT NULL DEFAULT 0,        -- 缺口（最低点 < 0 时的绝对值）
  ar_open REAL NOT NULL DEFAULT 0,           -- 参与预测的未收应收
  ap_open REAL NOT NULL DEFAULT 0,
  collect_rate REAL NOT NULL DEFAULT 90,     -- 按期应收的回收假设（%）
  overdue_rates TEXT,                        -- 逾期分档回收率（JSON）
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS cash_forecast_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  forecast_id INTEGER NOT NULL,
  week_no INTEGER NOT NULL,                  -- 第几周（1 起）
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  direction TEXT NOT NULL,                   -- in / out
  category TEXT NOT NULL,                    -- ar_collect / ap_pay / payroll / fixed_cost / tax / other
  amount REAL NOT NULL DEFAULT 0,
  basis TEXT,                                -- 依据说明（哪几张单、打的什么折）
  ref_count INTEGER NOT NULL DEFAULT 0
)`);

db.exec(`CREATE TABLE IF NOT EXISTS kpi_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  company_id INTEGER,                        -- 空 = 全集团
  kpi_key TEXT NOT NULL,
  kpi_label TEXT NOT NULL,
  value REAL,
  unit TEXT,                                 -- % / 天 / 元 / 次
  caliber TEXT,                              -- 口径说明（写给人看的）
  created_at TEXT NOT NULL,
  UNIQUE (period, company_id, kpi_key)
)`);

// 首次转负的周（和「最低点」是两件事：老板问的是「哪周断」，不是「最惨是哪周」）
if (!hasCol('cash_forecasts', 'first_neg_week')) {
  db.exec('ALTER TABLE cash_forecasts ADD COLUMN first_neg_week INTEGER');
  console.log('[cockpit-ddl] cash_forecasts + first_neg_week');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_cf_base ON cash_forecasts(base_date DESC, id DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_cfi_f ON cash_forecast_items(forecast_id, week_no)');
db.exec('CREATE INDEX IF NOT EXISTS idx_kpi_p ON kpi_snapshots(period DESC, kpi_key)');

console.log('[cockpit-ddl] done');
