/**
 * 客户信用与账期管控 —— 建表 + 扩列
 *
 * 背景：customers.credit_limit 这个字段从 P1 就有了，前端能填、列表能显示，
 * 但**全系统没有一处用它做过判断** —— 填 100 万和填 0 效果完全一样。
 * 这一版把它变成真的闸门。
 *
 * 三张表分别管三件事：
 *   credit_limits    额度/账期的**每次调整**（现值仍在 customers 上，这里留历史）
 *   credit_holds     冻结与解冻（谁、什么时候、为什么）
 *   credit_overrides 发货放行（额度不够但业务要发，得有人签字）
 *
 * 为什么不把 history 挤进一张 events 表：三者的字段和约束完全不同
 * （放行要绑订单且只能用一次，冻结要能算「现在还冻着吗」），
 * 合表会让每个查询都带一堆 kind 判断。
 */
const { db, now } = require('../src/db');

// ---------- 1. customers 扩列 ----------
const COLS = [
  ['credit_days', 'REAL DEFAULT 30'],            // 账期天数（到期日 = 开票日 + N 天）
  ['credit_status', "TEXT DEFAULT 'active'"],    // active / hold（冻结：一律不许发货）
  ['credit_hold_reason', 'TEXT'],
  ['credit_updated_at', 'TEXT']                  // 额度或账期最后一次变动的时间
];

const have = new Set(db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name));
COLS.forEach(([name, type]) => {
  if (have.has(name)) {
    console.log(`跳过 customers.${name}（已存在）`);
    return;
  }
  db.exec(`ALTER TABLE customers ADD COLUMN ${name} ${type}`);
  console.log(`加列 customers.${name} ${type}`);
});

// ---------- 2. 额度调整历史 ----------
db.exec(`
CREATE TABLE IF NOT EXISTS credit_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  credit_limit REAL NOT NULL DEFAULT 0,
  credit_days REAL NOT NULL DEFAULT 30,
  old_limit REAL,
  old_days REAL,
  reason TEXT,
  operator TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_limits_cust ON credit_limits(customer_id, id);
`);

// ---------- 3. 冻结 / 解冻 ----------
db.exec(`
CREATE TABLE IF NOT EXISTS credit_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  action TEXT NOT NULL,              -- hold / release
  reason TEXT,
  exposure_snapshot REAL,            -- 冻结那一刻的敞口，事后复盘用
  operator TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_holds_cust ON credit_holds(customer_id, id);
`);

// ---------- 4. 发货放行 ----------
db.exec(`
CREATE TABLE IF NOT EXISTS credit_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  customer_id INTEGER,
  limit_snapshot REAL,
  exposure_snapshot REAL,
  order_amount REAL,
  block_reasons TEXT,                -- JSON：放行时挡在前面的是哪几条
  reason TEXT NOT NULL,              -- 放行理由（必填，≥8 字）
  operator TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT,                      -- 用掉的时间；一张放行单只能发一次货
  used_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_credit_overrides_order ON credit_overrides(order_id, id);
`);

// ---------- 5. 存量客户给个默认账期 ----------
const blank = db.prepare("SELECT COUNT(*) c FROM customers WHERE credit_days IS NULL").get().c;
if (blank) {
  db.prepare("UPDATE customers SET credit_days = 30 WHERE credit_days IS NULL").run();
  console.log(`给 ${blank} 个客户补默认账期 30 天`);
}

console.log('\n=== 现状 ===');
const s = db.prepare(
  `SELECT COUNT(*) total,
          SUM(CASE WHEN IFNULL(credit_limit,0) > 0 THEN 1 ELSE 0 END) with_limit,
          SUM(CASE WHEN credit_status = 'hold' THEN 1 ELSE 0 END) held
     FROM customers`
).get();
console.log(`客户 ${s.total} 家 / 设了额度 ${s.with_limit} 家 / 冻结 ${s.held} 家`);
console.log('（额度为 0 = 不管理，不是「零额度」，这一步故意不批量刷值）');
