/**
 * 多主体核算（分公司总账 / 集团合并）DDL
 * ------------------------------------------------------------
 * 为什么要重建三张表：
 *   gl_periods / gl_balances / gl_close_checks 的唯一约束是**表级 UNIQUE**（period 等），
 *   SQLite 不支持 DROP CONSTRAINT，只能「建新表 → 拷数据 → 删旧表 → 改名」。
 *   三张表都没有外键引用、数据量极小（3/21/16 行），重建是安全的。
 *
 * 关键口径：
 *   - 凭证号按公司各自编号（记-YYYYMM-0001 在每家都从 0001 起）；
 *   - 凭证幂等键加 company_id，否则两家公司的同源单据会互相顶掉；
 *   - 期间表 (company_id, period) 唯一 → 每家公司各自关账。
 */
const { db } = require('../src/db');

function hasCol(t, c) {
  try {
    return db.prepare(`pragma table_info(${t})`).all().some((x) => x.name === c);
  } catch (e) {
    return false;
  }
}
function hasTable(t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}

const DDL = [
  // ============================================================
  // 1. 主体档案（companies 扩列）
  // ============================================================
  `CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  // ============================================================
  // 2. 内部往来单位映射（判断「这笔交易的对方是不是集团内公司」）
  // ============================================================
  `CREATE TABLE IF NOT EXISTS intercompany_parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,              -- 本方主体
    counter_company_id INTEGER NOT NULL,      -- 对方主体
    kind TEXT NOT NULL,                       -- customer / supplier / both
    ref_type TEXT,                            -- customer / supplier / other
    ref_id INTEGER,                           -- customers.id 或 suppliers.id
    ref_name TEXT NOT NULL,                   -- 单据上显示的名称（用于兜底匹配）
    match_key TEXT,                           -- 名称关键词（模糊命中用）
    offset_account TEXT DEFAULT '1122',       -- 内部往来抵消用科目（应收 1122 / 应付 2202）
    status TEXT NOT NULL DEFAULT 'active',    -- active / disabled
    note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (company_id, ref_name)
  )`,

  // ============================================================
  // 3. 内部交易配对（双向核销）
  // ============================================================
  `CREATE TABLE IF NOT EXISTS intercompany_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'balance',     -- balance 往来 / txn 交易 / investment 投资
    from_company_id INTEGER NOT NULL,         -- 债权方（记应收的）
    to_company_id INTEGER NOT NULL,           -- 债务方（记应付的）
    from_voucher_id INTEGER,
    to_voucher_id INTEGER,
    from_amount REAL NOT NULL DEFAULT 0,
    to_amount REAL NOT NULL DEFAULT 0,
    diff_amount REAL NOT NULL DEFAULT 0,      -- 两边不一致时非 0
    currency TEXT NOT NULL DEFAULT 'CNY',
    status TEXT NOT NULL DEFAULT 'open',      -- open 未平 / matched 已平 / diff 有差异 / ignored
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  )`,

  // ============================================================
  // 4. 合并批次
  // ============================================================
  `CREATE TABLE IF NOT EXISTS consolidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    con_no TEXT UNIQUE NOT NULL,              -- HB+YYYYMM+序号
    period TEXT NOT NULL,
    company_count INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'CNY',
    sum_asset REAL NOT NULL DEFAULT 0,        -- 简单加总
    sum_liability REAL NOT NULL DEFAULT 0,
    sum_equity REAL NOT NULL DEFAULT 0,
    sum_income REAL NOT NULL DEFAULT 0,
    sum_expense REAL NOT NULL DEFAULT 0,
    adj_asset REAL NOT NULL DEFAULT 0,        -- 抵消金额（正数表示冲减）
    adj_liability REAL NOT NULL DEFAULT 0,
    adj_equity REAL NOT NULL DEFAULT 0,
    adj_income REAL NOT NULL DEFAULT 0,
    adj_expense REAL NOT NULL DEFAULT 0,
    asset_total REAL NOT NULL DEFAULT 0,      -- 合并后
    liability_total REAL NOT NULL DEFAULT 0,
    equity_total REAL NOT NULL DEFAULT 0,
    income_total REAL NOT NULL DEFAULT 0,
    expense_total REAL NOT NULL DEFAULT 0,
    net_profit REAL NOT NULL DEFAULT 0,
    diff_amount REAL NOT NULL DEFAULT 0,      -- 合并后资产 −（负债+权益），必须 0
    ic_diff_cnt INTEGER NOT NULL DEFAULT 0,   -- 未平的内部往来笔数
    status TEXT NOT NULL DEFAULT 'draft',     -- draft / confirmed
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    confirmed_by TEXT,
    confirmed_at TEXT
  )`,

  // ============================================================
  // 5. 抵消分录
  // ============================================================
  `CREATE TABLE IF NOT EXISTS consolidation_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    con_id INTEGER NOT NULL,
    period TEXT NOT NULL,
    type TEXT NOT NULL,                       -- ic_balance 内部往来 / ic_txn 内部交易 / investment 长期投资 / unrealized 未实现利润
    company_id INTEGER,                       -- 影响的单体（可空=影响合计）
    account_code TEXT NOT NULL,
    account_name TEXT,
    debit REAL NOT NULL DEFAULT 0,
    credit REAL NOT NULL DEFAULT 0,
    counterpart_company_id INTEGER,
    summary TEXT,
    source TEXT NOT NULL DEFAULT 'auto',      -- auto / manual
    created_at TEXT NOT NULL
  )`,
];

db.exec('PRAGMA foreign_keys=off');

// ------------------------------------------------------------
// 重建 gl_periods（加 company_id）
// ------------------------------------------------------------
if (!hasCol('gl_periods', 'company_id')) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE gl_periods_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      period TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      voucher_count INTEGER NOT NULL DEFAULT 0,
      debit_total REAL NOT NULL DEFAULT 0,
      credit_total REAL NOT NULL DEFAULT 0,
      profit REAL NOT NULL DEFAULT 0,
      check_pass INTEGER NOT NULL DEFAULT 0,
      check_fail_cnt INTEGER NOT NULL DEFAULT 0,
      closed_by TEXT,
      closed_at TEXT,
      reopened_by TEXT,
      reopened_at TEXT,
      reopen_reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (company_id, period)
    )`);
    db.exec(`INSERT INTO gl_periods_new (id,company_id,period,start_date,end_date,status,voucher_count,
      debit_total,credit_total,profit,check_pass,check_fail_cnt,closed_by,closed_at,
      reopened_by,reopened_at,reopen_reason,created_at)
      SELECT id,1,period,start_date,end_date,status,voucher_count,debit_total,credit_total,profit,
             check_pass,check_fail_cnt,closed_by,closed_at,reopened_by,reopened_at,reopen_reason,created_at
      FROM gl_periods`);
    db.exec('DROP TABLE gl_periods');
    db.exec('ALTER TABLE gl_periods_new RENAME TO gl_periods');
    db.exec('CREATE INDEX IF NOT EXISTS idx_glp_company ON gl_periods(company_id, period)');
    db.exec('COMMIT');
    console.log('[group-ddl] gl_periods 已重建（+company_id，唯一键改为 公司+期间）');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ------------------------------------------------------------
// gl_vouchers / gl_entries 加 company_id
// ------------------------------------------------------------
if (!hasCol('gl_vouchers', 'company_id')) {
  db.exec('ALTER TABLE gl_vouchers ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1');
  console.log('[group-ddl] gl_vouchers + company_id');
}
if (!hasCol('gl_entries', 'company_id')) {
  db.exec('ALTER TABLE gl_entries ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1');
  console.log('[group-ddl] gl_entries + company_id');
}

// 凭证号本来是表级 UNIQUE(voucher_no)，多主体下两家都从 0001 起会撞号 → 重建成 (company_id, voucher_no)
const vchSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='gl_vouchers'").get()?.sql || '';
if (/voucher_no\s+TEXT\s+UNIQUE/i.test(vchSql)) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE gl_vouchers_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_no TEXT NOT NULL,
      company_id INTEGER NOT NULL DEFAULT 1,
      period TEXT NOT NULL,
      biz_date TEXT NOT NULL,
      summary TEXT,
      source_type TEXT NOT NULL,
      source_id INTEGER,
      status TEXT NOT NULL DEFAULT 'posted',
      debit_total REAL NOT NULL DEFAULT 0,
      credit_total REAL NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (company_id, voucher_no)
    )`);
    db.exec(`INSERT INTO gl_vouchers_new (id,voucher_no,company_id,period,biz_date,summary,source_type,
      source_id,status,debit_total,credit_total,created_by,created_at,updated_at)
      SELECT id,voucher_no,company_id,period,biz_date,summary,source_type,source_id,status,
             debit_total,credit_total,created_by,created_at,updated_at FROM gl_vouchers`);
    db.exec('DROP TABLE gl_vouchers');
    db.exec('ALTER TABLE gl_vouchers_new RENAME TO gl_vouchers');
    db.exec('COMMIT');
    console.log('[group-ddl] gl_vouchers 已重建（凭证号唯一键改为 公司+凭证号）');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 幂等键换成分公司版：不带 company_id 的话，两家公司同源单据会互相顶掉
db.exec('DROP INDEX IF EXISTS uq_glv_src_period');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_glv_src_period_co
         ON gl_vouchers(company_id, source_type, source_id, period) WHERE source_id IS NOT NULL`);
db.exec('CREATE INDEX IF NOT EXISTS idx_glv_company ON gl_vouchers(company_id, period, status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_gle_company ON gl_entries(company_id, period, account_code)');

// ------------------------------------------------------------
// 重建 gl_balances（唯一键加 company_id）
// ------------------------------------------------------------
if (!hasCol('gl_balances', 'company_id')) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE gl_balances_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      period TEXT NOT NULL,
      account_code TEXT NOT NULL,
      debit_begin REAL NOT NULL DEFAULT 0,
      credit_begin REAL NOT NULL DEFAULT 0,
      debit_period REAL NOT NULL DEFAULT 0,
      credit_period REAL NOT NULL DEFAULT 0,
      debit_end REAL NOT NULL DEFAULT 0,
      credit_end REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (company_id, period, account_code)
    )`);
    db.exec(`INSERT INTO gl_balances_new (id,company_id,period,account_code,debit_begin,credit_begin,
      debit_period,credit_period,debit_end,credit_end,created_at)
      SELECT id,1,period,account_code,debit_begin,credit_begin,debit_period,credit_period,
             debit_end,credit_end,created_at FROM gl_balances`);
    db.exec('DROP TABLE gl_balances');
    db.exec('ALTER TABLE gl_balances_new RENAME TO gl_balances');
    db.exec('COMMIT');
    console.log('[group-ddl] gl_balances 已重建（+company_id）');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ------------------------------------------------------------
// 重建 gl_close_checks（唯一键加 company_id）
// ------------------------------------------------------------
if (!hasCol('gl_close_checks', 'company_id')) {
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE gl_close_checks_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 1,
      period TEXT NOT NULL,
      check_code TEXT NOT NULL,
      name TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'error',
      passed INTEGER NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      detail TEXT,
      checked_at TEXT NOT NULL,
      UNIQUE (company_id, period, check_code)
    )`);
    db.exec(`INSERT INTO gl_close_checks_new (id,company_id,period,check_code,name,severity,passed,amount,detail,checked_at)
      SELECT id,1,period,check_code,name,severity,passed,amount,detail,checked_at FROM gl_close_checks`);
    db.exec('DROP TABLE gl_close_checks');
    db.exec('ALTER TABLE gl_close_checks_new RENAME TO gl_close_checks');
    db.exec('COMMIT');
    console.log('[group-ddl] gl_close_checks 已重建（+company_id）');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ------------------------------------------------------------
// 业务单据归主体（销售主体）
// ------------------------------------------------------------
if (!hasCol('orders', 'company_id')) {
  db.exec('ALTER TABLE orders ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1');
  console.log('[group-ddl] orders + company_id');
}
if (!hasCol('customers', 'company_id')) {
  db.exec('ALTER TABLE customers ADD COLUMN company_id INTEGER');
  console.log('[group-ddl] customers + company_id（空=集团共享客户）');
}

// 发票也要归主体：勾稽检查、凭证生成都要按主体过滤，否则总部关账会把分公司发票算进来
['ar_invoices', 'ap_invoices'].forEach((t) => {
  if (hasTable(t) && !hasCol(t, 'company_id')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1`);
    console.log(`[group-ddl] ${t} + company_id`);
  }
});
if (hasTable('payments') && !hasCol('payments', 'company_id')) {
  db.exec('ALTER TABLE payments ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1');
  console.log('[group-ddl] payments + company_id');
}
['payrolls', 'assets'].forEach((t) => {
  if (hasTable(t) && !hasCol(t, 'company_id')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1`);
    console.log(`[group-ddl] ${t} + company_id`);
  }
});
if (hasTable('admin_expenses') && !hasCol('admin_expenses', 'company_id')) {
  db.exec('ALTER TABLE admin_expenses ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1');
  console.log('[group-ddl] admin_expenses + company_id');
}

// ------------------------------------------------------------
// companies 扩列
// ------------------------------------------------------------
const companyCols = [
  ['short_name', 'TEXT'],
  ['type', "TEXT DEFAULT 'headquarters'"],   // headquarters 总部 / branch 分公司 / subsidiary 子公司
  ['tax_no', 'TEXT'],
  ['legal_person', 'TEXT'],
  ['base_currency', "TEXT DEFAULT 'CNY'"],
  ['consolidation', 'INTEGER DEFAULT 1'],    // 1 = 纳入合并范围
  ['parent_id', 'INTEGER'],
  ['open_period', 'TEXT'],                   // 账套启用期间：之前的数据不进账
  ['status', "TEXT DEFAULT 'active'"],       // active / closed
  ['addr', 'TEXT'],
  ['phone', 'TEXT'],
  ['remark', 'TEXT'],
  ['updated_at', 'TEXT']
];
companyCols.forEach(([c, t]) => {
  if (!hasCol('companies', c)) {
    db.exec(`ALTER TABLE companies ADD COLUMN ${c} ${t}`);
    console.log(`[group-ddl] companies + ${c}`);
  }
});

// 新表
DDL.forEach((sql) => db.exec(sql));

db.exec('PRAGMA foreign_keys=on');
console.log('[group-ddl] done');
