/**
 * M12 分公司经营对比（细化）—— 建表（幂等）
 * ============================================================
 * 缺口来源：GAP-ANALYSIS M12「分公司经营对比细化」。
 * 已有基础：`gl.js` 的资产负债表 / 利润表 / 现金流量表（**按主体、按期间**）、
 *          `intercompany_parties`（往来单位 → 对方主体）、`intercompany_links`（内部往来对账）、
 *          `consolidations`（合并数）、`employments`（在职人数）、`companies.base_currency`。
 *
 * 为什么只用两张表：
 *   对比的原始数据全在总账里（凭证/科目/往来单位），不需要再抄一份「分部报表」。
 *   这里只存两样东西：
 *     1) 人登记的「可比口径调整」——一次性损益、总部费用分摊、汇率影响，**不改账**；
 *     2) 老板看到并确认过的**报告快照**——确认后数字冻结，后面再改账不会悄悄改历史报告。
 *
 * 用法：node scripts/apply-segment-ddl.js
 */
const { db } = require('../src/db');

db.exec(`
-- 1) 可比口径调整（不改账，只影响「可比」列）
CREATE TABLE IF NOT EXISTS segment_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  period TEXT NOT NULL,                        -- YYYY-MM
  kind TEXT NOT NULL DEFAULT 'one_off',        -- one_off 一次性损益 / allocation 总部费用分摊 / fx 汇率影响 / other
  amount REAL NOT NULL DEFAULT 0,              -- 对「可比净利」的影响：正数=可比利润更高，负数=更低
  note TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_segadj_period ON segment_adjustments(period, company_id);

-- 2) 对比报告快照（确认后冻结）
CREATE TABLE IF NOT EXISTS segment_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_no TEXT NOT NULL UNIQUE,              -- SEG+YYYYMM+序号
  company_id INTEGER NOT NULL DEFAULT 1,       -- 出具主体（集团总部）
  period TEXT NOT NULL,
  company_count INTEGER NOT NULL DEFAULT 0,
  total_income REAL NOT NULL DEFAULT 0,        -- 分部合计（含内部交易）
  total_external_income REAL NOT NULL DEFAULT 0,
  total_net REAL NOT NULL DEFAULT 0,
  consolidated_income REAL,                    -- 合并数（没有合并批次时为空，不填 0）
  ic_amount REAL NOT NULL DEFAULT 0,           -- 分部合计 − 合并数 = 内部交易
  issue_count INTEGER NOT NULL DEFAULT 0,      -- 口径问题条数（未关账 / 未映射 / 汇率缺失）
  payload TEXT NOT NULL,                       -- JSON 快照（整张对比表）
  status TEXT NOT NULL DEFAULT 'draft',        -- draft / confirmed
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT,
  demo_tag TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_seg_report_no ON segment_reports(report_no);
CREATE INDEX IF NOT EXISTS idx_seg_report_period ON segment_reports(period, status);
`);

console.log('[segment] 表已就绪：segment_adjustments / segment_reports');
