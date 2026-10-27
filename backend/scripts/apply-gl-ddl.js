/**
 * 总账与财务报表：会计科目 / 期间 / 凭证 / 分录 / 关账检查
 * 对应原型 M12「财务报表与关账检查」
 *
 * 核心口径：
 * 1. **凭证由业务单据生成，不靠手工录**：开票、收款、付款、成本结转、工资、费用、折旧
 *    各自对应一套分录模板；按 `source_type + source_id` 幂等，可以反复重跑补历史。
 * 2. **借贷必须平衡**：每张凭证生成后立刻校验借贷合计，不平直接不落库（宁可不生成，不留半张）。
 * 3. **关账要过检查**：试算平衡、应收应付账龄与科目对得上、本期无草稿凭证、
 *    业务单据全部入账、损益类已结转 —— 缺一项不许关账。
 * 4. **关账后锁死**：已关期间的凭证不能新增、不能作废；要改只能反关账（留痕）。
 * 5. **余额由分录算，不手工填**：科目余额表、资产负债表、利润表都是分录的投影。
 */
const { db } = require('../src/db');

const DDL = [
  // 1. 会计科目
  `CREATE TABLE IF NOT EXISTS gl_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,                         -- asset/liability/equity/income/expense
    direction TEXT NOT NULL DEFAULT 'debit',    -- debit 借 / credit 贷（余额方向）
    parent_code TEXT,
    is_leaf INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    sort_no INTEGER NOT NULL DEFAULT 0,
    remark TEXT,
    created_at TEXT NOT NULL
  )`,

  // 2. 会计期间
  `CREATE TABLE IF NOT EXISTS gl_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT UNIQUE NOT NULL,                -- 2026-10
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',        -- open / closed
    voucher_count INTEGER NOT NULL DEFAULT 0,
    debit_total REAL NOT NULL DEFAULT 0,
    credit_total REAL NOT NULL DEFAULT 0,
    profit REAL NOT NULL DEFAULT 0,             -- 本期利润
    check_pass INTEGER NOT NULL DEFAULT 0,
    check_fail_cnt INTEGER NOT NULL DEFAULT 0,
    closed_by TEXT,
    closed_at TEXT,
    reopened_by TEXT,
    reopened_at TEXT,
    reopen_reason TEXT,
    created_at TEXT NOT NULL
  )`,

  // 3. 凭证
  `CREATE TABLE IF NOT EXISTS gl_vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_no TEXT UNIQUE NOT NULL,            -- 记-202610-0001
    period TEXT NOT NULL,
    biz_date TEXT NOT NULL,
    summary TEXT,
    source_type TEXT NOT NULL,                  -- ar_invoice/ap_invoice/payment/cost_sold/payroll/expense/depreciation/manual
    source_id INTEGER,
    status TEXT NOT NULL DEFAULT 'posted',       -- posted / void
    debit_total REAL NOT NULL DEFAULT 0,
    credit_total REAL NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // 幂等键带期间：折旧/工资这类「同一对象每期各一张」的凭证才能按月分开
  `DROP INDEX IF EXISTS uq_glv_source`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_glv_src_period ON gl_vouchers(source_type, source_id, period) WHERE source_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_glv_period ON gl_vouchers(period, status)`,

  // 4. 分录
  `CREATE TABLE IF NOT EXISTS gl_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL,
    period TEXT NOT NULL,
    line_no INTEGER NOT NULL DEFAULT 1,
    account_code TEXT NOT NULL,
    account_name TEXT,
    summary TEXT,
    debit REAL NOT NULL DEFAULT 0,
    credit REAL NOT NULL DEFAULT 0,
    partner_type TEXT,
    partner_id INTEGER,
    partner_name TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gle_voucher ON gl_entries(voucher_id)`,
  `CREATE INDEX IF NOT EXISTS idx_gle_period ON gl_entries(period, account_code)`,

  // 5. 关账检查结果
  `CREATE TABLE IF NOT EXISTS gl_close_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    check_code TEXT NOT NULL,
    name TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'error',     -- error 拦住关账 / warn 只提示
    passed INTEGER NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    detail TEXT,
    checked_at TEXT NOT NULL,
    UNIQUE (period, check_code)
  )`,

  // 6. 关账余额快照（关账当时的科目余额，报表按它出，避免事后改数影响历史）
  `CREATE TABLE IF NOT EXISTS gl_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    account_code TEXT NOT NULL,
    debit_begin REAL NOT NULL DEFAULT 0,
    credit_begin REAL NOT NULL DEFAULT 0,
    debit_period REAL NOT NULL DEFAULT 0,
    credit_period REAL NOT NULL DEFAULT 0,
    debit_end REAL NOT NULL DEFAULT 0,
    credit_end REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (period, account_code)
  )`
];

/**
 * 科目表（服装外贸企业够用的一套，可按需加子科目）
 * 只启用叶子科目记账，父科目用于报表归集。
 */
const ACCOUNTS = [
  // 资产
  ['1001', '库存现金', 'asset', 'debit', null, 1, 10],
  ['1002', '银行存款', 'asset', 'debit', null, 1, 20],
  ['1122', '应收账款', 'asset', 'debit', null, 1, 30],
  ['1221', '其他应收款', 'asset', 'debit', null, 1, 40],
  ['1403', '原材料', 'asset', 'debit', null, 1, 50],
  ['1405', '库存商品', 'asset', 'debit', null, 1, 60],
  ['1601', '固定资产', 'asset', 'debit', null, 1, 70],
  ['1602', '累计折旧', 'asset', 'credit', null, 1, 80],
  // 负债
  ['2202', '应付账款', 'liability', 'credit', null, 1, 110],
  ['2211', '应付职工薪酬', 'liability', 'credit', null, 1, 120],
  ['2221', '应交税费', 'liability', 'credit', null, 1, 130],
  ['2241', '其他应付款', 'liability', 'credit', null, 1, 140],
  // 权益
  ['4001', '实收资本', 'equity', 'credit', null, 1, 210],
  ['4103', '本年利润', 'equity', 'credit', null, 1, 220],
  ['4104', '利润分配', 'equity', 'credit', null, 1, 230],
  // 收入
  ['6001', '主营业务收入', 'income', 'credit', null, 1, 310],
  ['6051', '其他业务收入', 'income', 'credit', null, 1, 320],
  // 成本费用
  ['6401', '主营业务成本', 'expense', 'debit', null, 1, 410],
  ['6601', '销售费用', 'expense', 'debit', null, 1, 420],
  ['6602', '管理费用', 'expense', 'debit', null, 1, 430],
  ['6603', '财务费用', 'expense', 'debit', null, 1, 440]
];

function seedAccounts() {
  const t = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO gl_accounts (code,name,type,direction,parent_code,is_leaf,status,sort_no,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name, type=excluded.type, direction=excluded.direction, sort_no=excluded.sort_no`
  );
  ACCOUNTS.forEach(([code, name, type, direction, parent, leaf, sort]) => {
    ins.run(code, name, type, direction, parent || null, leaf, 'active', sort, t);
  });
}

function run() {
  DDL.forEach((s) => db.exec(s));
  seedAccounts();
  const t = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE 'gl_%'").get().c;
  const a = db.prepare('SELECT COUNT(*) c FROM gl_accounts').get().c;
  console.log(`[gl] 已建 ${t} 张表，科目 ${a} 个`);
}

if (require.main === module) run();
module.exports = { DDL, ACCOUNTS, seedAccounts };
