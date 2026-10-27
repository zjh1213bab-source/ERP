/**
 * 上线准备：真实数据导入 —— 建表
 * ============================================================
 * 为什么单独记批次：
 *   上线期初导入是「一次性、不可重来」的操作。必须能回答：
 *   谁在什么时候、从哪个文件、导了多少行、成功多少、失败哪些行、为什么失败。
 */
const { db } = require('../src/db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no TEXT NOT NULL UNIQUE,              -- IMP+日期+序号
    type TEXT NOT NULL,                         -- customers / suppliers / materials / products / skus / stock_opening
    type_label TEXT,
    file_name TEXT,
    delimiter TEXT,                             -- , 或 \t（Excel 直接粘贴常见制表符）
    total_rows INTEGER NOT NULL DEFAULT 0,
    ok_rows INTEGER NOT NULL DEFAULT 0,
    new_rows INTEGER NOT NULL DEFAULT 0,
    update_rows INTEGER NOT NULL DEFAULT 0,
    error_rows INTEGER NOT NULL DEFAULT 0,
    skipped_rows INTEGER NOT NULL DEFAULT 0,    -- skip_errors=1 时被跳过的错误行
    status TEXT NOT NULL DEFAULT 'committed',   -- committed / failed
    skip_errors INTEGER NOT NULL DEFAULT 0,
    errors TEXT,                                -- JSON：错误行明细（最多留 200 条）
    note TEXT,
    operator TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_impb_type ON import_batches(type)`,
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
  console.log('[apply-importops-ddl] import_batches 就绪');
}

run();
