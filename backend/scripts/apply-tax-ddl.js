/**
 * 税负测算 DDL（原型 M12 / N12-06 税票银行与结算接口的「税」这一半）
 * ------------------------------------------------------------
 * 三张表：
 *   tax_policies    税政配置（主体 × 税区 × 税种 × 期间 × 税率）
 *   tax_runs        测算批次（一期一主体一税区一份结果）
 *   tax_run_items   每个税种一行（依据 / 税率 / 税额 / 公式 / 取数来源）
 *
 * 为什么不把税率写死在代码里：
 *   原型明确「主体税种税率不可照抄样例」。13% 是内销货物的常见税率，不是所有主体所有业务都适用；
 *   美国公司没有增值税、出口货物适用免抵退、小规模纳税人另有征收率。
 *   税率放库里按「主体 × 税区 × 税种 × 生效期间」配，改税率时旧记录保留（superseded），
 *   否则上个月的测算会被新税率整体改写，历史就没法回看了。
 *
 * 为什么测算要留批次而不是实时算：
 *   税负测算的价值在**对比**：这个月税负率 3.2%，上个月 2.8%，为什么？
 *   不留快照就永远只能看到"现在算出来是多少"，看不出趋势，也无法解释差异。
 */
const { db } = require('../src/db');

function hasCol(t, c) {
  try {
    return db.prepare(`pragma table_info(${t})`).all().some((x) => x.name === c);
  } catch (e) {
    return false;
  }
}

/** 税政配置 */
db.exec(`CREATE TABLE IF NOT EXISTS tax_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  tax_region TEXT NOT NULL DEFAULT 'CN',     -- CN / US / OTHER（按税区配，不按公司硬编码）
  tax_type TEXT NOT NULL,                    -- vat 增值税 / surcharge 附加税 / cit 企业所得税 / export_rebate 出口退税 / stamp 印花税
  name TEXT NOT NULL,
  rate REAL NOT NULL DEFAULT 0,              -- %
  price_includes_tax INTEGER NOT NULL DEFAULT 0,  -- 1=票面含税（按含税换算出税额）
  effective_from TEXT NOT NULL,
  effective_to TEXT,                         -- 空 = 长期有效
  status TEXT NOT NULL DEFAULT 'active',     -- active 生效 / superseded 已被新政策替代
  policy_no TEXT,                            -- 政策文号（可空）
  remark TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
)`);

/** 测算批次 */
db.exec(`CREATE TABLE IF NOT EXISTS tax_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_no TEXT UNIQUE NOT NULL,               -- TAX+YYYYMMDD+序号
  company_id INTEGER NOT NULL DEFAULT 1,
  tax_region TEXT NOT NULL DEFAULT 'CN',
  period TEXT NOT NULL,                      -- YYYY-MM
  revenue_total REAL NOT NULL DEFAULT 0,     -- 收入合计（不含税，来自利润表）
  domestic_revenue REAL NOT NULL DEFAULT 0,  -- 内销收入（= 收入合计 − 出口收入）
  export_revenue REAL NOT NULL DEFAULT 0,    -- 出口/外销收入（原币折算人民币）
  output_tax REAL NOT NULL DEFAULT 0,        -- 销项税额
  input_tax REAL NOT NULL DEFAULT 0,         -- 进项税额（按采购收票含税价换算）
  vat_payable REAL NOT NULL DEFAULT 0,       -- 应纳增值税（<=0 时记 0）
  credit_carry REAL NOT NULL DEFAULT 0,      -- 期末留抵（进项大于销项的差额）
  surcharge_base REAL NOT NULL DEFAULT 0,    -- 附加税基数（= 应纳增值税，不是销项）
  surcharge_amount REAL NOT NULL DEFAULT 0,
  profit_total REAL NOT NULL DEFAULT 0,      -- 利润总额
  cit_amount REAL NOT NULL DEFAULT 0,        -- 企业所得税
  rebate_amount REAL NOT NULL DEFAULT 0,     -- 出口退税（免抵退估算）
  exempt_offset REAL NOT NULL DEFAULT 0,     -- 免抵额（退不完的部分）
  total_burden REAL NOT NULL DEFAULT 0,      -- 合计税负
  burden_rate REAL NOT NULL DEFAULT 0,       -- 税负率 %（合计 ÷ 收入）
  status TEXT NOT NULL DEFAULT 'draft',      -- draft / confirmed / void
  policy_json TEXT,                          -- 本次用到的税率与政策版本快照
  note TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
)`);

/** 测算明细：一个税种一行，公式与取数来源都写进来 */
db.exec(`CREATE TABLE IF NOT EXISTS tax_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  tax_type TEXT NOT NULL,
  label TEXT NOT NULL,
  base_amount REAL NOT NULL DEFAULT 0,
  rate REAL,
  amount REAL NOT NULL DEFAULT 0,
  formula TEXT,                              -- 给人看的算式，如「内销收入 120,000 × 13%」
  source TEXT,                               -- 取数来源，如「利润表 6001 贷方 − 出口收入」
  note TEXT
)`);

// 同一主体同一税区同一税种，只能有一条 active（改税率要先把旧的置 superseded）
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_active ON tax_policies(company_id, tax_region, tax_type) WHERE status='active'");
db.exec('CREATE INDEX IF NOT EXISTS idx_taxpol_co ON tax_policies(company_id, tax_region, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_taxrun_period ON tax_runs(period DESC, company_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_taxrun_status ON tax_runs(status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_taxitem_run ON tax_run_items(run_id, seq)');

// note 会被「确认 / 作废」动作追加内容，演示标记单独一列（这个坑踩过两次了）
if (!hasCol('tax_runs', 'demo_tag')) {
  db.exec('ALTER TABLE tax_runs ADD COLUMN demo_tag TEXT');
  console.log('[tax-ddl] tax_runs + demo_tag');
}

console.log('[tax-ddl] done');
