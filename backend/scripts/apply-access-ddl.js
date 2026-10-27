/**
 * 上线准备：岗位权限复核 —— 建表
 * ============================================================
 * 三张表分别在解决三个真问题：
 *
 * 1. user_roles —— 一人多岗
 *    小企业常见「销售部经理兼管生产」「财务兼人事」。原来 users.role 是单值，
 *    只能让这个人多开一个账号，审计时对不上人。改成主角色 + 附加岗，权限取并集。
 *
 * 2. access_exceptions —— 岗位复核时收掉不该有的权限
 *    deny：从角色默认权限里收回（例：销售不该改工艺）。
 *    allow：个别用户开口子（例：某个资深跟单确实要填面辅料用量）。
 *    allow 只用于抵消同一权限点的 deny，不跨角色提权 —— 避免变成暗门。
 *
 * 3. access_reviews —— 复核留痕
 *    权限矩阵不是配一次就完了。上线前和每年至少复核一次，要能回答
 *    「谁在什么时候、按什么范围、确认过这张矩阵、当时有几条职责冲突」。
 */
const { db } = require('../src/db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,                          -- 附加岗位（users.role 仍是主岗）
    granted_by TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, role)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_uroles_user ON user_roles(user_id)`,

  `CREATE TABLE IF NOT EXISTS access_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    perm TEXT NOT NULL,
    effect TEXT NOT NULL DEFAULT 'deny',         -- deny 收回 / allow 抵消 deny（不跨角色提权）
    reason TEXT,                                 -- 为什么收/为什么开，必填（复核时要能解释）
    created_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, perm)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_aexc_user ON access_exceptions(user_id)`,

  `CREATE TABLE IF NOT EXISTS access_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_no TEXT NOT NULL UNIQUE,              -- RV+YYYYMMDD+序号
    period TEXT,                                 -- 复核周期，如 2026Q4 / 上线前
    scope TEXT,                                  -- 复核范围说明
    users_total INTEGER NOT NULL DEFAULT 0,
    perms_total INTEGER NOT NULL DEFAULT 0,
    exceptions_count INTEGER NOT NULL DEFAULT 0,
    conflicts_count INTEGER NOT NULL DEFAULT 0,  -- 复核时点存在的职责分离冲突数
    changes TEXT,                                -- JSON：本次调整明细快照
    signed_off_by TEXT,                          -- 复核确认人（总经理/财务负责人）
    signed_off_at TEXT,
    note TEXT,
    operator TEXT,
    created_at TEXT NOT NULL
  )`,
];

function run() {
  db.exec('BEGIN');
  try {
    DDL.forEach((sql) => db.exec(sql));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log('[apply-access-ddl] user_roles / access_exceptions / access_reviews 就绪');
}

run();
