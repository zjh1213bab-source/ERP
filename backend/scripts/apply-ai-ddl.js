/**
 * AI 能力扩展（M17）建表
 * 10 张表：
 *   ai_providers      模型网关（供应商/就绪状态/数据范围/预算/超时）
 *   ai_calls          调用审计与成本（每次调用落一条，含降级原因）
 *   ai_drafts         AI 产出草稿（需求抽取/客服答复/异常解释），人工核准才有效
 *   ai_evals          评测基准用例（含「必须拒绝」类）
 *   ai_eval_runs      评测批次
 *   ai_eval_results   评测明细
 *   ai_risks          全岗位风险快照
 *   ai_weekly         周报（本人/部门/公司）
 *   ai_faq            客服 FAQ 知识（须批准才可被引用）
 *   ai_handovers      人工接管会话
 *
 * 幂等：全部 IF NOT EXISTS，可重复执行。
 */
const { db } = require('../src/db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS ai_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,                    -- LLM-CN01
    name TEXT NOT NULL,
    vendor TEXT,                                  -- deepseek / qwen / openai
    base_url TEXT,
    model TEXT,
    key_env TEXT,                                 -- 环境变量名，绝不存明文
    key_masked TEXT,                              -- 后端脱敏后的展示值
    data_scope TEXT NOT NULL DEFAULT 'internal',  -- public / internal / restricted（可处理的最高敏感级）
    region TEXT,                                  -- cn / overseas
    input_price REAL DEFAULT 0,                   -- 元/千 token
    output_price REAL DEFAULT 0,
    monthly_budget REAL DEFAULT 0,
    used_amount REAL DEFAULT 0,
    timeout_ms INTEGER DEFAULT 15000,
    priority INTEGER DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'planning',      -- planning / pending / enabled / disabled
    note TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ai_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene TEXT NOT NULL,                          -- ask / extract / explain / reply / weekly / eval
    sensitivity TEXT,                             -- public / internal / restricted
    provider_id INTEGER,
    provider_code TEXT,
    model TEXT,
    actor TEXT,
    prompt_digest TEXT,                           -- 摘要（不存原文，避免留下敏感内容）
    prompt_len INTEGER DEFAULT 0,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    latency_ms INTEGER DEFAULT 0,
    status TEXT NOT NULL,                         -- ok / fallback / blocked / error
    reason TEXT,                                  -- 降级/拦截原因
    http_code INTEGER,
    created_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ai_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_no TEXT NOT NULL UNIQUE,                -- AI+日期+序号
    scene TEXT NOT NULL,                          -- requirement / reply / anomaly
    source_type TEXT,                             -- inquiry / mail / order / dq_issue
    source_id INTEGER,
    source_label TEXT,
    payload TEXT,                                 -- JSON：抽取结果或解释条目
    confidence REAL DEFAULT 0,
    missing TEXT,                                 -- JSON：抽取时缺哪些必填项
    status TEXT NOT NULL DEFAULT 'draft',         -- draft / approved / rejected
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT,
    applied_to TEXT,                              -- 人工核准后去了哪（页面/单据号），不自动写业务表
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ai_evals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_code TEXT NOT NULL UNIQUE,
    scene TEXT NOT NULL,
    title TEXT NOT NULL,
    input_text TEXT NOT NULL,
    asker_role TEXT,                              -- 以什么岗位身份提问（决定权限守卫结果）
    expect_kind TEXT NOT NULL,                    -- answer / refuse
    expect_keywords TEXT,                         -- JSON 数组：answer 类必须命中
    leak_keywords TEXT,                           -- JSON 数组：refuse 类出现即算越权泄漏
    risk_level TEXT DEFAULT 'normal',             -- high / normal
    enabled INTEGER DEFAULT 1,
    note TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ai_eval_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_no TEXT NOT NULL UNIQUE,
    provider_code TEXT,
    model TEXT,
    total INTEGER DEFAULT 0,
    passed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    leak_cnt INTEGER DEFAULT 0,                   -- 越权泄漏（必须 0）
    refuse_ok INTEGER DEFAULT 0,
    source TEXT,                                  -- ai / rule
    cost REAL DEFAULT 0,
    ms INTEGER DEFAULT 0,
    status TEXT DEFAULT 'done',
    operator TEXT,
    created_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ai_eval_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    case_code TEXT,
    scene TEXT,
    title TEXT,
    expect_kind TEXT,
    passed INTEGER DEFAULT 0,
    leaked INTEGER DEFAULT 0,
    answer TEXT,
    hit_keywords TEXT,
    leak_hit TEXT,
    ms INTEGER DEFAULT 0,
    note TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ai_risks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,                         -- RSK+日期+序号
    scope TEXT,                                   -- all / 部门名
    entity_type TEXT NOT NULL,                    -- approval / order / purchase / qc / receivable / stock / commitment
    entity_id INTEGER,
    entity_no TEXT,
    level TEXT NOT NULL,                          -- high / mid / low
    score INTEGER DEFAULT 0,
    reasons TEXT,                                 -- JSON：为什么算风险（可解释）
    next_action TEXT,                             -- 建议动作（不自动执行）
    owner TEXT,
    role TEXT,
    due_at TEXT,
    hours_left REAL,
    status TEXT DEFAULT 'open',                   -- open / ack / done
    ack_by TEXT,
    ack_at TEXT,
    created_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ai_weekly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_no TEXT NOT NULL,                        -- 2026-W44
    scope TEXT NOT NULL,                          -- user / dept / company
    subject_id INTEGER,
    subject_name TEXT,
    period_from TEXT,
    period_to TEXT,
    content TEXT,                                 -- JSON：已完成/未完成/逾期/阻塞/扣分/待复核/建议
    cnt_done INTEGER DEFAULT 0,
    cnt_open INTEGER DEFAULT 0,
    cnt_overdue INTEGER DEFAULT 0,
    cnt_blocked INTEGER DEFAULT 0,
    cnt_penalty INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',                  -- draft / published
    source TEXT DEFAULT 'rule',                   -- ai / rule
    created_by TEXT,
    created_at TEXT,
    published_at TEXT,
    UNIQUE(week_no, scope, subject_id)
  )`,

  `CREATE TABLE IF NOT EXISTS ai_faq (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category TEXT,
    keywords TEXT,
    version INTEGER DEFAULT 1,
    status TEXT DEFAULT 'draft',                  -- draft / approved / retired
    approved_by TEXT,
    approved_at TEXT,
    hit_count INTEGER DEFAULT 0,
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ai_handovers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_no TEXT NOT NULL UNIQUE,
    customer TEXT,
    channel TEXT,                                 -- mall / mail / phone
    status TEXT DEFAULT 'ai',                     -- ai / human / closed
    trigger_reason TEXT,
    question TEXT,
    taken_by TEXT,
    taken_at TEXT,
    closed_at TEXT,
    summary TEXT,
    created_at TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_aicalls_scene ON ai_calls(scene, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_aidrafts_status ON ai_drafts(scene, status)`,
  `CREATE INDEX IF NOT EXISTS idx_airisks_run ON ai_risks(run_id, level, status)`,
  `CREATE INDEX IF NOT EXISTS idx_aievalres_run ON ai_eval_results(run_id)`
];

db.exec('BEGIN');
try {
  DDL.forEach((sql) => db.exec(sql));
  db.exec('COMMIT');
  const n = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%'").get().c;
  console.log('[ai-ddl] ok, ai_* 表', n, '张');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('[ai-ddl] failed:', e.message);
  process.exit(1);
}
