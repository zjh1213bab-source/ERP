/**
 * 客户子账号与授权 DDL（P1 / 原型 TS-N21-01 / 03 / 04 / 08）
 *   node scripts/apply-customer-authz-ddl.js && node scripts/rebuild-schema.js
 *
 * 1) customer_accounts 扩列：子账号归属、生效权限、销售批准上限、邀请来源
 * 2) customer_invites：销售邀请令牌（辅助注册）
 * 3) customer_account_audits：开通 / 改权限 / 停用 / 重置密码 / 主账号变更 全留痕，只读不可改
 */
const { db } = require('../src/db');

function cols(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch (e) { return []; }
}

function add(table, col, ddl) {
  const c = cols(table);
  if (c.length && !c.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    console.log(`  + ${table}.${col}`);
  }
}

console.log('customer_accounts 扩列：');
add('customer_accounts', 'parent_id', 'INTEGER');            // 子账号指向主账号 id
add('customer_accounts', 'perms', 'TEXT');                    // 实际生效权限点（逗号分隔）
add('customer_accounts', 'limit_perms', 'TEXT');              // 销售批准的权限上限
add('customer_accounts', 'approved_by', 'TEXT');              // 批准人（销售/管理员）
add('customer_accounts', 'approved_at', 'TEXT');
add('customer_accounts', 'must_change_pwd', 'INTEGER NOT NULL DEFAULT 0');
add('customer_accounts', 'invited_by', 'TEXT');               // 邀请令牌来源
add('customer_accounts', 'remark', 'TEXT');

const DDL = [
  // 销售邀请令牌：客户用一次性令牌完成注册，避免销售替客户设密码
  `CREATE TABLE IF NOT EXISTS customer_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',        -- owner 主账号 / purchase / orders / finance / member
  perms TEXT,                                 -- 令牌携带的权限（不会超过销售批准上限）
  contact TEXT,                               -- 核验的联系方式（手机或邮箱）
  invited_by TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending / used / revoked / expired
  used_by_account_id INTEGER,
  used_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_ci_customer ON customer_invites(customer_id)`,

  // 授权审计：只读留痕（普通业务用户不可改不可删）
  `CREATE TABLE IF NOT EXISTS customer_account_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  customer_id INTEGER,
  action TEXT NOT NULL,                       -- create / perms / disable / enable / reset_pwd / approve / invite / accept_invite / login_fail
  before_json TEXT,
  after_json TEXT,
  operator TEXT,
  operator_scope TEXT NOT NULL DEFAULT 'staff', -- staff 员工 / customer 客户 / system
  note TEXT,
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_caa_account ON customer_account_audits(account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_caa_customer ON customer_account_audits(customer_id)`
];

let n = 0;
for (const sql of DDL) { db.exec(sql); n++; }
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('customer_invites','customer_account_audits')").all().map((r) => r.name);
console.log(`已执行 ${n} 条建表；新表：${tables.join(', ')}`);
