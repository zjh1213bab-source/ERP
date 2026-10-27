/**
 * 税票银行与结算（M12）建表
 *
 * 6 张表：
 *   bank_accounts          银行账户（期初余额在这里，对账的起点）
 *   bank_imports           流水导入批次（留来源文件名与合计，便于追溯）
 *   bank_statement_lines   银行流水明细（含去重指纹，重复导入不会翻倍）
 *   bank_reconciliations   对账批次（银行余额 vs 账面余额 + 调节表）
 *   bank_reconciliation_items 未达账项（银行有企业没记 / 企业记了银行没记）
 *   bank_bills             票据台账（应收/应付承兑汇票）
 *
 * 补列：payments.bank_account_id —— 收付款单要能归到具体账户，否则做不了账户级对账
 */
const { db } = require('../src/db');

const hasCol = (t, c) => {
  try {
    return db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  } catch (e) {
    return false;
  }
};

const DDL = [
  `CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_no TEXT NOT NULL UNIQUE,             -- 内部编码：CN-ICBC-001
    company_id INTEGER,
    bank_name TEXT NOT NULL,
    account_masked TEXT,                         -- 账号展示（尾号）
    currency TEXT DEFAULT 'CNY',
    account_type TEXT DEFAULT 'basic',           -- basic 基本户 / general 一般户 / fx 外币户
    open_balance REAL DEFAULT 0,                 -- 期初余额
    open_date TEXT,                              -- 期初日期
    status TEXT NOT NULL DEFAULT 'active',       -- active / closed
    note TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS bank_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_no TEXT NOT NULL UNIQUE,              -- IMP+日期+序号
    account_id INTEGER NOT NULL,
    period TEXT,                                 -- YYYY-MM（按交易日期归月）
    source_name TEXT,                            -- 文件名 / 来源说明
    line_count INTEGER DEFAULT 0,
    dup_count INTEGER DEFAULT 0,                 -- 重复跳过条数
    in_total REAL DEFAULT 0,
    out_total REAL DEFAULT 0,
    status TEXT DEFAULT 'done',                  -- done / partial
    operator TEXT,
    created_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS bank_statement_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER,
    account_id INTEGER NOT NULL,
    trade_date TEXT NOT NULL,                    -- YYYY-MM-DD
    period TEXT,
    direction TEXT NOT NULL,                     -- in 收入 / out 支出
    amount REAL NOT NULL DEFAULT 0,
    balance REAL,                                -- 银行给的余额（对账用最后一条）
    summary TEXT,
    counterparty TEXT,                           -- 对方户名
    counterparty_acct TEXT,
    currency TEXT DEFAULT 'CNY',
    dedupe_key TEXT NOT NULL UNIQUE,             -- 账户|日期|方向|金额|对方|摘要 的指纹
    match_status TEXT NOT NULL DEFAULT 'unmatched', -- unmatched / auto / manual / ignored
    payment_id INTEGER,
    matched_at TEXT,
    matched_by TEXT,
    note TEXT,
    created_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS bank_reconciliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recon_no TEXT NOT NULL UNIQUE,               -- DZ+日期+序号
    account_id INTEGER NOT NULL,
    period TEXT NOT NULL,
    statement_balance REAL DEFAULT 0,            -- 银行对账单期末余额
    book_balance REAL DEFAULT 0,                 -- 账面余额（期初 + 已确认收付）
    bank_only_in REAL DEFAULT 0,                 -- 银行已收 企业未收
    bank_only_out REAL DEFAULT 0,                -- 银行已付 企业未付
    book_only_in REAL DEFAULT 0,                 -- 企业已收 银行未收
    book_only_out REAL DEFAULT 0,                -- 企业已付 银行未付
    adjusted_statement REAL DEFAULT 0,           -- 调节后银行余额
    adjusted_book REAL DEFAULT 0,                -- 调节后账面余额
    diff_amount REAL DEFAULT 0,                  -- 两者差额（应为 0）
    unmatched_lines INTEGER DEFAULT 0,
    unmatched_payments INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',        -- draft / confirmed
    note TEXT,
    created_by TEXT,
    created_at TEXT,
    confirmed_by TEXT,
    confirmed_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recon_id INTEGER NOT NULL,
    type TEXT NOT NULL,                          -- bank_only（银行记了企业没记）/ book_only（企业记了银行没记）
    direction TEXT,                              -- in / out
    amount REAL DEFAULT 0,
    trade_date TEXT,
    ref_no TEXT,                                 -- 流水行或收付款单号
    counterparty TEXT,
    summary TEXT,
    handled INTEGER DEFAULT 0                    -- 是否已在后续期间补记
  )`,

  `CREATE TABLE IF NOT EXISTS bank_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_no TEXT NOT NULL,                       -- 票号
    type TEXT NOT NULL,                          -- receivable 应收票据 / payable 应付票据
    direction TEXT DEFAULT 'in',                 -- 收票/付票
    drawer TEXT,                                 -- 出票人
    payee TEXT,                                  -- 收款人
    acceptor TEXT,                               -- 承兑人（银行/商业）
    accept_type TEXT DEFAULT 'bank',             -- bank 银承 / commercial 商承
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'CNY',
    issue_date TEXT,                             -- 出票日
    due_date TEXT,                               -- 到期日
    status TEXT NOT NULL DEFAULT 'holding',      -- holding 持有 / endorsed 已背书 / discounted 已贴现 / collected 已托收 / settled 已兑付 / void 作废
    partner_type TEXT,                           -- customer / supplier
    partner_id INTEGER,
    partner_name TEXT,
    ref_no TEXT,                                 -- 关联订单/合同
    discount_rate REAL,                          -- 贴现率
    discount_cost REAL,                          -- 贴现息
    cash_in_date TEXT,                           -- 实际到账日
    note TEXT,
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT,
    UNIQUE(bill_no, type)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_banklines_match ON bank_statement_lines(account_id, match_status, trade_date)`,
  `CREATE INDEX IF NOT EXISTS idx_banklines_period ON bank_statement_lines(period, account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bankbills_due ON bank_bills(type, status, due_date)`
];

db.exec('BEGIN');
try {
  DDL.forEach((sql) => db.exec(sql));

  if (!hasCol('payments', 'bank_account_id')) {
    db.exec('ALTER TABLE payments ADD COLUMN bank_account_id INTEGER');
    console.log('[bank-ddl] payments + bank_account_id');
  }

  db.exec('COMMIT');
  const n = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE 'bank%'").get().c;
  console.log('[bank-ddl] ok, bank* 表', n, '张');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('[bank-ddl] failed:', e.message);
  process.exit(1);
}
