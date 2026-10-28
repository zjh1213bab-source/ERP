/**
 * 审计日志 · 建表 + 哈希链回填
 * ============================================================
 * 给 audit_logs 加：seq / prev_hash / hash / module / action / target / summary / actor_role / duration_ms
 * 新建：audit_chain_state（链头水位，单行）、audit_archives（归档登记）
 *
 * 为什么要回填：老日志没有 seq 和 hash。不回填，链就从 5 万条之后才开始，
 * 「前 5 万条」永远是链外之物 —— 审计员问「前面那些能不能保证没被改」就答不上来。
 * 回填按 id 升序重放一遍，链是「从第一条到今天」完整的。
 *
 * 幂等：列用 PRAGMA 查、表用 IF NOT EXISTS；已回填过（seq 都不为 NULL）就只补缺的。
 */
const { db } = require('../src/db');
const audit = require('../src/services/auditLog');

function hasCol(table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (e) {
    return false;
  }
}

const COLS = [
  ['seq', 'INTEGER'],                                   // 链序号，1..N 连续
  ['prev_hash', 'TEXT'],                                // 上一条的 hash
  ['hash', 'TEXT'],                                     // 本条 hash
  ['module', 'TEXT'],                                   // 子域：orders/gl/piece-wage/auth…
  ['module_group', 'TEXT'],                             // 大类：sales/finance/hr/system…（统计用）
  ['action', 'TEXT'],                                   // login/create/update/delete/approve/flow/export/other
  ['target', 'TEXT'],                                   // orders#123
  ['summary', 'TEXT'],                                  // 人读：销售订单 orders#123 · 流转
  ['actor_role', 'TEXT'],                               // 当时的岗位
  ['duration_ms', 'INTEGER']
];
COLS.forEach(([col, type]) => {
  if (!hasCol('audit_logs', col)) {
    db.exec(`ALTER TABLE audit_logs ADD COLUMN ${col} ${type}`);
    console.log('audit_logs 新增列：', col);
  }
});

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_seq ON audit_logs(seq);
CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(username, created_at);

-- 链头水位：单行。删日志不会动这张表，所以「库里最大 seq < 水位」= 尾部被删
CREATE TABLE IF NOT EXISTS audit_chain_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq INTEGER NOT NULL DEFAULT 0,      -- 已写出的最大序号
  last_hash TEXT,                           -- 最后一条的 hash
  anchor_seq INTEGER NOT NULL DEFAULT 0,    -- 归档水位：这之前的日志已归档移出主表
  anchor_hash TEXT,
  updated_at TEXT
);

-- 归档登记：每次归档一个文件 + 哈希 + 覆盖的序号区间
CREATE TABLE IF NOT EXISTS audit_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_no TEXT UNIQUE,
  from_seq INTEGER,
  to_seq INTEGER,
  rows INTEGER,
  first_hash TEXT,
  last_hash TEXT,
  file TEXT,                                -- data/audit-archives/AUD20261028-01.jsonl
  file_sha256 TEXT,
  cutoff TEXT,                              -- 归档的保留期分界
  note TEXT,
  created_by TEXT,
  created_at TEXT
);
`);

db.prepare(
  'INSERT OR IGNORE INTO audit_chain_state (id, last_seq, last_hash, anchor_seq, anchor_hash, updated_at) VALUES (1, 0, ?, 0, ?, ?)'
).run(audit.GENESIS, audit.GENESIS, new Date().toISOString());

const pend = db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE seq IS NULL').get().c;
if (pend) {
  console.log(`回填 ${pend} 条历史日志的哈希链与语义…`);
  const r = audit.backfill();
  console.log(`回填完成：${r.updated} 条，链头 seq=${r.total}`);
} else {
  const st = audit.chainState();
  console.log('历史日志已全部在链上，链头 seq =', st.last_seq);
}

// 分类规则可能改过（补子域、加新前缀）→ 重算语义。
// 只动 module / module_group / action / target / summary，**不动 hash**（链不含这几列）。
const sem = audit.backfillSemantics();
console.log(`语义重算 ${sem.updated} 条（模块/动作/摘要）`);

const v = audit.verify();
console.log(`链校验：${v.ok ? '通过' : '未通过'} | 共 ${v.total} 条，本次逐条重算 ${v.checked} 条，问题 ${v.problems.length} 处`);
if (!v.ok) v.problems.slice(0, 5).forEach((p) => console.log('  ✗', p.code, p.message));
console.log('审计表就绪');
