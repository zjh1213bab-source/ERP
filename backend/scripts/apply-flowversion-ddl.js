/**
 * 流程变更发布与审计（TS-N15-05）
 * ========================================================================
 * 现状的问题：`approval_flows` 把 steps 直接存在一行里，改流程就是 UPDATE 这一行。
 *
 * 于是有三件事说不清：
 *   1. **这单是按哪个版本的流程审的？** —— `flow_id` 只指向 flow，不指向版本
 *   2. **谁在什么时候把「财务复核」删了？** —— 没有变更留痕
 *   3. **改完发现问题，怎么回去？** —— 没有回滚，只能凭记忆改回去
 *
 * 更麻烦的是「在途单」：虽然 `ensureInstance` 会把 steps 展开成 approval_tasks（天然快照），
 * 但**没人能证明这一点** —— 页面上看不到「这张单锁定的是 v2」，
 * 一旦有人问「为什么这单只要两级」，就得去翻代码。
 *
 * ## 这一版做的四件事
 *
 * 1. **版本化**：每次改流程产生一个新版本（不可变），`approval_flows` 只是「当前生效版本的投影」。
 * 2. **变更单**：草稿 → 试运行 → 发布 → 可回滚。**没有试运行证据不许发布**（原型：所有规则改变有版本和测试证据）。
 * 3. **在途单锁定版本**：`approval_instances.flow_version_id` 记录发起时用的版本，默认**不跟着改**。
 * 4. **审计**：创建/试运行/发布/回滚/迁移，每一步都落 `flow_audits`。
 *
 * ## 两条不许绕的门槛（原型：关键财审、技术版本、分厂、质量和资金门槛不允许被绕过）
 *
 * - **关键角色不可随手删**：财务、总经理这类角色从流程里删掉时，必须在变更单里写清楚理由，
 *   并且**在试运行结果里单独列出来**。想删可以，但删了会被记下来。
 * - **生效日不能倒签**：不能「今天发布、生效日写上周」，那等于偷偷改历史。
 */
const { db, now } = require('../src/db');

const t = now();

/* ---------------- 1. 流程版本 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS flow_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,                    -- cost / payment / ...
  flow_key TEXT NOT NULL,                       -- target_type + 原流程名（稳定标识）
  version_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  min_amount REAL NOT NULL DEFAULT 0,
  max_amount REAL NOT NULL DEFAULT 999999999,
  steps TEXT NOT NULL,                          -- JSON 快照（不可变）
  sla_hours INTEGER,
  escalate_role TEXT,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft / trial / published / superseded / rolled_back
  effective_from TEXT,                          -- 生效日（YYYY-MM-DD）
  trial_summary TEXT,                           -- 试运行证据（JSON）
  trial_at TEXT,
  published_by TEXT,
  published_at TEXT,
  source_change_no TEXT,                        -- 由哪张变更单发布
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flowver ON flow_versions(flow_key, version_no);
-- 同一流程只能有一个已发布版本（并发发布在这里兜底）
CREATE UNIQUE INDEX IF NOT EXISTS uq_flowver_pub ON flow_versions(flow_key) WHERE status = 'published';
`);

/* ---------------- 2. 变更单 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS flow_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_no TEXT UNIQUE,                        -- FC202610280001
  flow_key TEXT NOT NULL,
  target_type TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  impact_nodes TEXT,                            -- 影响节点（逗号分隔，人工填写）
  from_version_id INTEGER,
  to_version_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft / trialed / published / rolled_back / rejected
  trial_summary TEXT,
  trial_at TEXT,
  inflight_count INTEGER DEFAULT 0,             -- 发布时的在途单数（影响面）
  inflight_migrated INTEGER DEFAULT 0,
  migration_mode TEXT DEFAULT 'keep_old',       -- keep_old 在途单不动 / migrate 迁到新版本
  migration_note TEXT,
  critical_role_note TEXT,                      -- 删关键角色时必须写理由
  effective_from TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_flowchg_key ON flow_changes(flow_key);
`);

/* ---------------- 3. 审计 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS flow_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_no TEXT,
  flow_key TEXT,
  version_id INTEGER,
  action TEXT NOT NULL,                         -- init / create / trial / publish / rollback / migrate / reject
  actor TEXT,
  detail TEXT,                                  -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flowaudit_key ON flow_audits(flow_key);
`);

/* ---------------- 4. 在途单锁定版本 ---------------- */

const cols = db.prepare('PRAGMA table_info(approval_instances)').all().map((c) => c.name);
if (!cols.includes('flow_version_id')) {
  db.exec('ALTER TABLE approval_instances ADD COLUMN flow_version_id INTEGER');
  console.log('已加列 approval_instances.flow_version_id（记录发起时用的流程版本）');
}
if (!cols.includes('steps_snapshot')) {
  db.exec('ALTER TABLE approval_instances ADD COLUMN steps_snapshot TEXT');
  console.log('已加列 approval_instances.steps_snapshot（发起时的步骤快照，改版不影响在途单）');
}

/* ---------------- 5. 把现有流程迁成 v1 ---------------- */
// 起点必须干净：现在库里每条 approval_flows 都当成「v1 已发布」，
// 之后所有改动都是 v2、v3…，历史才有得比。
const flows = db.prepare('SELECT * FROM approval_flows ORDER BY id').all();
let seeded = 0;
flows.forEach((f) => {
  const key = `${f.target_type}::${f.name}`;
  const has = db.prepare('SELECT id FROM flow_versions WHERE flow_key = ?').get(key);
  if (has) return;
  const v = db
    .prepare(
      `INSERT INTO flow_versions (target_type, flow_key, version_no, name, min_amount, max_amount, steps,
         sla_hours, escalate_role, status, effective_from, published_by, published_at, created_by, created_at, updated_at)
       VALUES (?,?,1,?,?,?,?,?,?,'published',?,?,?,?,?,?)`
    )
    .run(f.target_type, key, f.name, Number(f.min_amount) || 0, Number(f.max_amount) || 999999999,
      f.steps, f.sla_hours || 24, f.escalate_role || null, t.slice(0, 10),
      '系统初始化', t, '系统初始化', t, t).lastInsertRowid;
  db.prepare(
    "INSERT INTO flow_audits (change_no, flow_key, version_id, action, actor, detail, created_at) VALUES (NULL,?,?,?,?,?,?)"
  ).run(key, v, 'init', '系统初始化', JSON.stringify({ note: '从 approval_flows 迁移为 v1', flow_name: f.name }), t);
  seeded += 1;
});

const n = (tb) => db.prepare(`SELECT COUNT(*) c FROM ${tb}`).get().c;
console.log(`flow_versions: ${n('flow_versions')} 行（新迁入 ${seeded} 条 v1）`);
console.log(`flow_changes: ${n('flow_changes')} 行`);
console.log(`flow_audits: ${n('flow_audits')} 行`);
console.log('流程变更发布与审计 表结构就绪');
