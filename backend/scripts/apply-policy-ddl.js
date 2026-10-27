/**
 * 制度问答引用留痕 DDL（M17 N17-02）
 * ------------------------------------------------------------
 * 为什么要单独一张表：
 *   制度是会改版的。今天回答「请假 3 天以内主管批」引的是 V2，
 *   下个月改成 V3（改为 2 天）之后，**历史回答里引用的 V2 就成了错的**。
 *   不留痕就查不出「哪些回答引的是旧版」，也就没法回访更正。
 *
 * 只记「当时引了哪一版、哪一天生效」，不存整段答案 —— 原文在 sop_versions 里，不用复制。
 */
const { db } = require('../src/db');

db.exec(`CREATE TABLE IF NOT EXISTS ai_policy_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,                    -- 用户原问题（用于回访"当时问的是什么"）
  doc_id INTEGER NOT NULL,
  doc_no TEXT NOT NULL,
  title TEXT NOT NULL,                       -- 快照：制度可能改名
  version INTEGER NOT NULL,                  -- 当时引用的版本
  effective_date TEXT,                       -- 当时的生效日期
  owner TEXT,
  coverage REAL,                             -- 问句覆盖度（%），低了说明是硬凑的
  rank INTEGER,                              -- 第几条引用（1 = 主依据）
  answer_generated_by TEXT,                  -- model / rule
  actor TEXT,
  created_at TEXT NOT NULL
)`);

db.exec('CREATE INDEX IF NOT EXISTS idx_aph_doc ON ai_policy_hits(doc_id, version)');
db.exec('CREATE INDEX IF NOT EXISTS idx_aph_actor ON ai_policy_hits(actor, id DESC)');

console.log('[policy-ddl] done');
