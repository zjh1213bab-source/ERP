/**
 * 上线准备：备份恢复演练 —— 建表
 * ============================================================
 * 为什么要有 backup_jobs：
 *   之前备份只是「点一下下载一个文件」，服务端什么都不留。结果三个问题：
 *     1. 没人知道上次备份是什么时候 —— 出事时才发现备份是两周前的
 *     2. 恢复前不先备份当前库 —— 传错版本就把好数据盖了，没法回退
 *     3. 恢复到底成没成功，没有记录 —— 只能靠人记得「我重启过了」
 *
 *   这张表就是这三个问题的答案：每一次备份、每一次恢复、每一次校验都留一条。
 */
const { db } = require('../src/db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS backup_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_no TEXT NOT NULL UNIQUE,                 -- BK20261028-01
    kind TEXT NOT NULL DEFAULT 'manual',         -- manual 手动 / pre_restore 恢复前自动备份 / auto 定时 / drill 演练
    file_name TEXT NOT NULL,
    file_path TEXT,                              -- 服务端留存路径（下载型备份可为空）
    size_bytes INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT,                                 -- 校验和：同一个文件传到哪都能比对
    tables_count INTEGER,                        -- 快照里的表数（用来判断「是不是本系统的库」）
    rows_total INTEGER,                          -- 关键表行数合计
    key_rows TEXT,                               -- JSON：关键表各自行数（演练对比基线）
    app_version TEXT,
    verify_status TEXT NOT NULL DEFAULT 'unchecked',  -- unchecked / ok / failed
    verify_at TEXT,
    verify_note TEXT,                            -- 校验结论或失败原因（integrity_check 的结果）
    restore_status TEXT,                         -- pending 待重启 / applied 已生效 / rolled_back 已撤销 / failed 失败
    restore_at TEXT,
    note TEXT,
    operator TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bkjobs_kind ON backup_jobs(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_bkjobs_created ON backup_jobs(created_at)`
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
  console.log('[apply-backup-ddl] backup_jobs 就绪');
}

run();
