/**
 * M12 长期投资抵消 —— 建表（幂等）
 * ============================================================
 * 缺口来源：GAP-ANALYSIS M12「长期投资抵消」。
 *
 * 要解决的事：
 *   合并报表里，母公司账上的「长期股权投资」和子公司账上的「实收资本/留存收益」
 *   是同一笔钱的两种记法。直接相加会把同一块钱算两遍（资产虚增、权益虚增），
 *   所以必须抵消。而现在系统只抵消了内部往来和内部交易，**长投一分没抵**，
 *   于是合并后 `资产 = 负债 + 权益` 是靠两边一起虚增维持平衡的假平衡。
 *
 * 关键区分（很多系统在这里就错了）：
 *   - **分公司（branch）不是独立法人**：没有股权、没有实收资本，合并时**直接并入**，
 *     **不做长投抵消**。
 *   - **子公司（subsidiary）是独立法人**：母公司有长期股权投资，必须抵消
 *     长投 ↔ 子公司权益，差额是**商誉**（或负商誉），非全资还要确认**少数股东权益**。
 *
 * 用法：node scripts/apply-investment-ddl.js
 */
const { db } = require('../src/db');

db.exec(`
-- 1) 长期股权投资（一家被投企业一条有效记录）
CREATE TABLE IF NOT EXISTS equity_investments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inv_no TEXT NOT NULL UNIQUE,                 -- TZ+YYYYMMDD+序号
  company_id INTEGER NOT NULL,                 -- 投资方（母公司）
  investee_id INTEGER NOT NULL,                -- 被投企业（必须是子公司）
  investee_code TEXT,
  investee_name TEXT,
  method TEXT NOT NULL DEFAULT 'cost',         -- cost 成本法 / equity 权益法
  acquire_date TEXT NOT NULL,                  -- 取得日
  acquire_cost REAL NOT NULL DEFAULT 0,        -- 初始投资成本
  share_pct REAL NOT NULL DEFAULT 100,         -- 持股比例 %（0~100）
  -- 权益法下的累计调整（成本法这两项恒为 0）
  equity_adjust REAL NOT NULL DEFAULT 0,       -- 累计确认的投资损益（亏损为负）
  dividend_received REAL NOT NULL DEFAULT 0,   -- 累计收到的分红（冲减账面）
  book_value REAL NOT NULL DEFAULT 0,          -- 账面价值 = 成本 + 损益调整 − 分红（成本法不看后两项）
  status TEXT NOT NULL DEFAULT 'active',       -- active 持有 / disposed 已处置
  dispose_date TEXT, dispose_reason TEXT,
  note TEXT,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  demo_tag TEXT
);
-- 同一被投企业只能有一条有效投资（防重复计入）
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_active
  ON equity_investments(company_id, investee_id) WHERE status = 'active';

-- 2) 投资变动留痕（增持 / 减持 / 权益法确认 / 分红 / 处置）
CREATE TABLE IF NOT EXISTS equity_investment_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investment_id INTEGER NOT NULL,
  change_date TEXT NOT NULL,
  type TEXT NOT NULL,                          -- equity_share 权益法确认损益 / dividend 收到分红
                                               -- increase 增持 / decrease 减持 / dispose 处置
  amount REAL NOT NULL DEFAULT 0,              -- 对账面价值的影响（带符号）
  share_before REAL NOT NULL DEFAULT 0,
  share_after REAL NOT NULL DEFAULT 0,
  book_before REAL NOT NULL DEFAULT 0,
  book_after REAL NOT NULL DEFAULT 0,
  reason TEXT,
  operator TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invchg_inv ON equity_investment_changes(investment_id, id);
`);

// 合并主表补四列：商誉 / 少数股东权益 / 长投抵消额 / 负商誉（都参与「资产=负债+权益」平衡）
const cols = [
  ['goodwill', 'REAL NOT NULL DEFAULT 0'],
  ['minority_equity', 'REAL NOT NULL DEFAULT 0'],
  ['investment_offset', 'REAL NOT NULL DEFAULT 0'],
  ['bargain_gain', 'REAL NOT NULL DEFAULT 0'],
];
cols.forEach(([name, ddl]) => {
  const has = db.prepare('PRAGMA table_info(consolidations)').all().some((c) => c.name === name);
  if (!has) {
    db.exec(`ALTER TABLE consolidations ADD COLUMN ${name} ${ddl}`);
    console.log(`  + consolidations.${name}`);
  }
});

// 补四个科目：长投抵消分录要落到真实科目上，否则合并表里凭空出现不存在的科目
const ACCOUNTS = [
  ['1511', '长期股权投资', 'asset', 'debit', 1511],
  ['1701', '商誉', 'asset', 'debit', 1701],
  ['4201', '少数股东权益', 'equity', 'credit', 4201],
  ['6301', '营业外收入', 'income', 'credit', 6301],
];
const t = new Date().toISOString().slice(0, 19).replace('T', ' ');
ACCOUNTS.forEach(([code, name, type, dir, sort]) => {
  const has = db.prepare('SELECT id FROM gl_accounts WHERE code = ?').get(code);
  if (has) return;
  db.prepare(
    `INSERT INTO gl_accounts (code, name, type, direction, is_leaf, status, sort_no, remark, created_at)
     VALUES (?,?,?,?,1,'active',?, '长期投资抵消用', ?)`
  ).run(code, name, type, dir, sort, t);
  console.log(`  + gl_accounts ${code} ${name}`);
});

console.log('[apply-investment-ddl] equity_investments / equity_investment_changes 就绪，consolidations 已补 4 列，科目已补 4 个');
