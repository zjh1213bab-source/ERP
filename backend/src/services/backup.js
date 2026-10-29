/**
 * 备份中心：服务端备份、校验、恢复计划、回滚
 * ============================================================
 * 原来的备份是「点一下，浏览器下载一个文件」，服务端不留任何东西。这在实际出事时不够用：
 *
 *   1. 不知道上次备份是什么时候 —— 出事才发现备份是两周前的
 *   2. 恢复前不先备份当前库 —— 传错版本就把好数据盖了，没有退路
 *   3. 恢复到底成没成功没有记录 —— 只能靠人记得「我重启过了」
 *
 * 所以这里做四件事：
 *   createBackup  服务端落盘 + 记录（sha256 / 表数 / 行数 / 耗时）
 *   inspectFile   恢复前校验（integrity_check + 关键表 + 非空库）
 *   prepareRestore 校验通过 → **先自动备份当前库** → 写待恢复文件与计划
 *   rollbackRestore 撤销待恢复（重启前反悔）
 *
 * 恢复的「生效」动作在 services/backup-restore.js 的 applyPendingRestore()，
 * 由 db.js 在打开连接之前调用 —— 那里不能依赖本模块（会有循环依赖）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const { db, now } = require('../db');
const BR = require('./backup-restore');

const APP_VERSION = (() => {
  try {
    return require('../../package.json').version || '';
  } catch (e) {
    return '';
  }
})();

/** 保留策略：手动备份留 30 份，恢复前自动备份留 10 份，定时备份留 15 份 */
const KEEP = { manual: 30, pre_restore: 10, auto: 15, drill: 10 };

function esc(p) {
  // VACUUM INTO 用 SQL 字符串字面量，路径里的单引号要双写（Windows 用户目录可能带 '）
  return String(p).replace(/\\/g, '/').replace(/'/g, "''");
}

function nextJobNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const prefix = 'BK' + day;
  const row = db
    .prepare('SELECT job_no FROM backup_jobs WHERE job_no LIKE ? ORDER BY job_no DESC LIMIT 1')
    .get(prefix + '%');
  let seq = 1;
  if (row) {
    // job_no 形如 BK20261028-03：跳过分隔符再解析，否则 parseInt('-03') = -3，序号会倒退
    const tail = String(row.job_no).slice(prefix.length + 1);
    const n = parseInt(tail, 10);
    if (!isNaN(n)) seq = n + 1;
  }
  // 文件可能已存在：恢复会把 backup_jobs 记录回滚到更早，但磁盘上的备份文件还在。
  // 只按记录算序号会覆盖既有备份文件（而且是静默覆盖），所以这里同时检查磁盘，跳过已占用的号。
  const dir = BR.backupDir(config.dbPath);
  for (;;) {
    const no = prefix + '-' + p(seq);
    if (!fs.existsSync(path.join(dir, no + '.db')) && !fs.existsSync(path.join(dir, no + '-pre-restore.db'))) {
      return no;
    }
    seq++;
  }
}

/**
 * 生成一份服务端备份
 * @param {{kind?:string, note?:string, operator?:string}} opts
 */
function createBackup({ kind = 'manual', note = '', operator = '' } = {}) {
  const t0 = Date.now();
  const jobNo = nextJobNo();
  const fileName = `${jobNo}${kind === 'pre_restore' ? '-pre-restore' : ''}.db`;
  const file = path.join(BR.backupDir(config.dbPath), fileName);

  try {
    // VACUUM INTO 会生成一个已合并 WAL 的干净副本（直接 copy 文件可能丢未合并数据）
    db.exec(`VACUUM INTO '${esc(file)}'`);
  } catch (e) {
    // 兜底：先 checkpoint 再复制（WAL 模式下 copy 主文件会漏数据，所以必须先合并）
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(config.dbPath, file);
    } catch (e2) {
      throw new Error('生成备份失败：' + e2.message);
    }
  }

  const info = BR.inspectFile(file);
  const duration = Date.now() - t0;

  let id;
  try {
    id = db
      .prepare(
        `INSERT INTO backup_jobs
         (job_no, kind, file_name, file_path, size_bytes, sha256, tables_count, rows_total, key_rows,
          app_version, verify_status, verify_at, verify_note, note, operator, duration_ms, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        jobNo, kind, fileName, file, info.size, info.sha256, info.tables, info.rows_total,
        JSON.stringify(info.key_rows), APP_VERSION,
        info.ok ? 'ok' : 'failed', now(), info.ok ? '备份时校验通过' : info.errors.join('；'),
        note, operator, duration, now()
      )
      .lastInsertRowid;
  } catch (e) {
    // 记录写不进去就把文件删掉：留一个没人认领的 .db 只会让人以为「有备份」
    try { fs.unlinkSync(file); } catch (e2) { /* ignore */ }
    throw new Error('备份记录写入失败（已删除生成的备份文件）：' + e.message);
  }

  pruneOld(kind);

  return getJob(Number(id));
}

function getJob(id) {
  return db.prepare('SELECT * FROM backup_jobs WHERE id = ?').get(id);
}

function listJobs({ kind = '', limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  const sql =
    'SELECT * FROM backup_jobs ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY id DESC LIMIT ?';
  params.push(Number(limit) || 100);
  return db.prepare(sql).all(...params).map((r) => ({
    ...r,
    exists: !!(r.file_path && fs.existsSync(r.file_path)),
    size_human: humanSize(r.size_bytes)
  }));
}

function humanSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 重新校验某份备份（备份会放在磁盘上，时间久了可能损坏） */
function verifyJob(id) {
  const job = getJob(id);
  if (!job) throw new Error('备份记录不存在');
  if (!job.file_path || !fs.existsSync(job.file_path)) {
    db.prepare("UPDATE backup_jobs SET verify_status='failed', verify_at=?, verify_note=? WHERE id=?")
      .run(now(), '备份文件已不在磁盘上（可能被手工删除）', id);
    throw new Error('备份文件已不在磁盘上');
  }
  const info = BR.inspectFile(job.file_path);
  db.prepare(
    `UPDATE backup_jobs
        SET verify_status=?, verify_at=?, verify_note=?, size_bytes=?, sha256=?,
            tables_count=?, rows_total=?, key_rows=?
      WHERE id=?`
  ).run(
    info.ok ? 'ok' : 'failed', now(),
    info.ok ? '校验通过：完整性 ok，' + info.tables + ' 张表' : info.errors.join('；'),
    info.size, info.sha256, info.tables, info.rows_total, JSON.stringify(info.key_rows), id
  );
  return { job: getJob(id), checks: info };
}

function deleteJob(id) {
  const job = getJob(id);
  if (!job) throw new Error('备份记录不存在');
  const plan = readPlan();
  if (plan && plan.backup_id === Number(id)) {
    throw new Error('这份备份正等着恢复，请先撤销恢复再删除');
  }
  if (job.file_path && fs.existsSync(job.file_path)) {
    try { fs.unlinkSync(job.file_path); } catch (e) { /* ignore */ }
  }
  db.prepare('DELETE FROM backup_jobs WHERE id = ?').run(id);
  return { id: Number(id) };
}

/** 保留策略：同类备份超过上限时删最老的（只删文件，记录留着当历史） */
function pruneOld(kind) {
  const keep = KEEP[kind] || 20;
  const rows = db
    .prepare('SELECT id, file_path FROM backup_jobs WHERE kind = ? ORDER BY id DESC')
    .all(kind);
  rows.slice(keep).forEach((r) => {
    if (r.file_path && fs.existsSync(r.file_path)) {
      try { fs.unlinkSync(r.file_path); } catch (e) { /* ignore */ }
    }
    db.prepare("UPDATE backup_jobs SET verify_note = COALESCE(verify_note, '') || ' [已按保留策略清理文件]' WHERE id = ?")
      .run(r.id);
  });
}

// ---------------- 恢复 ----------------

function readPlan() {
  try {
    const f = BR.planPath(config.dbPath);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return null;
  }
}

function pendingStatus() {
  const pending = BR.pendingPath(config.dbPath);
  const exists = fs.existsSync(pending);
  return {
    pending: exists,
    size: exists ? fs.statSync(pending).size : 0,
    plan: exists ? readPlan() : null
  };
}

/**
 * 准备恢复：校验 → 自动备份当前库 → 写待恢复文件
 *
 * @param {{buffer?:Buffer, filePath?:string, backupId?:number, note?:string, operator?:string}} opts
 * @returns 预检结果 + 回滚点
 */
function prepareRestore({ buffer, filePath, backupId, note = '', operator = '' } = {}) {
  let src = filePath;
  let tmp = null;

  if (buffer) {
    // 上传的文件先落到临时目录，走同一套校验
    tmp = path.join(os.tmpdir(), `erp-restore-upload-${BR.stamp()}.db`);
    fs.writeFileSync(tmp, buffer);
    src = tmp;
  } else if (backupId) {
    const job = getJob(backupId);
    if (!job) throw new Error('备份记录不存在');
    if (!job.file_path || !fs.existsSync(job.file_path)) throw new Error('备份文件已不在磁盘上');
    src = job.file_path;
  }

  if (!src || !fs.existsSync(src)) throw new Error('没有可恢复的文件');

  const checks = BR.inspectFile(src);
  if (!checks.ok) {
    if (tmp) try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    const err = new Error('备份文件校验未通过，已拒绝恢复：' + checks.errors.join('；'));
    err.checks = checks;
    throw err;
  }

  // 恢复前先把当前库存一份 —— 这是唯一的退路
  const rollback = createBackup({
    kind: 'pre_restore',
    note: '准备恢复前自动备份（回滚点）：' + (note || '未填说明'),
    operator
  });

  const pending = BR.pendingPath(config.dbPath);
  try {
    if (tmp) {
      fs.copyFileSync(tmp, pending);
      fs.unlinkSync(tmp);
    } else {
      fs.copyFileSync(src, pending);
    }
  } catch (e) {
    throw new Error('写入待恢复文件失败：' + e.message);
  }

  // 待恢复文件也要能通过校验（复制过程可能出错）
  const verifyPending = BR.inspectFile(pending);
  if (!verifyPending.ok) {
    try { fs.unlinkSync(pending); } catch (e) { /* ignore */ }
    const err = new Error('待恢复文件写入后校验失败，已放弃：' + verifyPending.errors.join('；'));
    err.checks = verifyPending;
    throw err;
  }

  const plan = {
    at: now(),
    operator,
    note,
    source: backupId ? { backup_id: backupId, job_no: getJob(backupId) && getJob(backupId).job_no } : { upload: true },
    rollback_job_id: rollback.id,
    rollback_job_no: rollback.job_no,
    target: {
      file: path.basename(pending),
      size: verifyPending.size,
      sha256: verifyPending.sha256,
      tables: verifyPending.tables,
      rows_total: verifyPending.rows_total,
      key_rows: verifyPending.key_rows,
      integrity: verifyPending.integrity
    },
    current: {
      tables: rollback.tables_count,
      rows_total: rollback.rows_total,
      key_rows: safeJson(rollback.key_rows)
    }
  };
  fs.writeFileSync(BR.planPath(config.dbPath), JSON.stringify(plan, null, 2), 'utf8');

  if (backupId) {
    db.prepare("UPDATE backup_jobs SET restore_status='pending', restore_at=? WHERE id=?").run(now(), backupId);
  }

  return {
    prepared: true,
    need_restart: true,
    plan,
    checks: {
      integrity: verifyPending.integrity,
      tables: verifyPending.tables,
      rows_total: verifyPending.rows_total,
      key_rows: verifyPending.key_rows,
      warnings: verifyPending.warnings
    },
    rollback_job_no: rollback.job_no
  };
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}

/** 撤销待恢复（重启前反悔） */
function rollbackRestore({ operator = '' } = {}) {
  const pending = BR.pendingPath(config.dbPath);
  const plan = readPlan();
  if (!fs.existsSync(pending)) throw new Error('当前没有待恢复的文件');
  const archived = path.join(
    BR.replacedDir(config.dbPath),
    `restore-cancelled-${BR.stamp()}.db`
  );
  try {
    fs.renameSync(pending, archived);
  } catch (e) {
    fs.unlinkSync(pending);
  }
  try { fs.unlinkSync(BR.planPath(config.dbPath)); } catch (e) { /* ignore */ }
  /**
   * 撤销一次就留下一份 80MB 的库副本。演练时来回取消十几次，`replaced/` 能长到几个 GB，
   * 而没有任何界面会提醒磁盘 —— 所以每次撤销后按保留上限裁一遍（最新 5 份够查）。
   *
   * 裁剪结果**随返回值出去**：删不掉的文件（Windows 上被占就是 EPERM）原来被静默吞掉，
   * 症状是目录稳定多留一份而每轮都显示"成功"。
   */
  let pruned = null;
  try { pruned = BR.pruneReplaced(config.dbPath); } catch (e) { pruned = { error: String(e.message || e), failed: [] }; }
  if (plan && plan.source && plan.source.backup_id) {
    db.prepare("UPDATE backup_jobs SET restore_status='rolled_back', restore_at=? WHERE id=?")
      .run(now(), plan.source.backup_id);
  }
  return { rolled_back: true, archived, operator, plan, pruned };
}

// ---------------- 业务级校验（恢复后要看的，不只是行数） ----------------

/**
 * 数据健康检查（只做展示，不参与「恢复是否成功」的判定）
 *
 * 为什么分开：
 *   恢复成功后如果库里本来就有脏数据（例如演示脚本中断留下的孤儿分录），
 *   把「数据健康」当成恢复判定标准，就会得出「恢复失败」的结论 —— 那是误判。
 *   恢复判定只看：文件完整性、表数与关键表、行数与备份一致、标记数据已回滚。
 *
 * severity:
 *   hard 该有问题说明库是坏的（账号重复会让登录错乱）
 *   data 数据质量问题，可能来自历史脏数据或演示脚本，需要人工判断
 */
function businessChecks() {
  const one = (sql) => {
    try {
      const r = db.prepare(sql).get();
      const v = r ? Object.values(r)[0] : null;
      return v === null || v === undefined ? 0 : Number(v);
    } catch (e) {
      return null;
    }
  };
  const out = [];

  // 1) 已过账凭证借贷平衡 —— 这是总账的底线，不平就是真错
  const postedD = one(
    "SELECT ROUND(SUM(e.debit),2) AS v FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id WHERE v.status='posted'"
  );
  const postedC = one(
    "SELECT ROUND(SUM(e.credit),2) AS v FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id WHERE v.status='posted'"
  );
  out.push({
    key: 'gl_posted_balanced',
    severity: 'hard',
    item: '已过账凭证借贷平衡',
    expected: postedC,
    actual: postedD,
    pass: postedD === null ? null : Math.abs(postedD - (postedC || 0)) < 0.01,
    note: postedD === null ? '无总账数据' : `借 ${postedD} / 贷 ${postedC}`
  });

  // 2) 孤儿分录（分录的凭证不存在）—— 演示脚本或中断的事务留下的
  const orphan = one(
    'SELECT COUNT(*) AS v FROM gl_entries e LEFT JOIN gl_vouchers v ON v.id=e.voucher_id WHERE v.id IS NULL'
  );
  const orphanAmt = one(
    'SELECT ROUND(SUM(e.debit - e.credit),2) AS v FROM gl_entries e LEFT JOIN gl_vouchers v ON v.id=e.voucher_id WHERE v.id IS NULL'
  );
  out.push({
    key: 'gl_orphan_entries',
    severity: 'data',
    item: '凭证分录无孤儿行',
    expected: 0,
    actual: orphan,
    pass: orphan === 0,
    note: orphan
      ? `有 ${orphan} 条分录找不到凭证，净影响 ${orphanAmt}（会让总账不平，需清理）`
      : '正常'
  });

  // 3) 成品库存 = 流水净额
  const stockItems = one('SELECT ROUND(SUM(qty), 2) AS v FROM stock_items');
  const stockLedger = one('SELECT ROUND(SUM(qty), 2) AS v FROM stock_ledger');
  out.push({
    key: 'stock_balance',
    severity: 'data',
    item: '成品库存 = 流水净额',
    expected: stockLedger,
    actual: stockItems,
    pass: stockItems === null || stockLedger === null ? null : Math.abs(stockItems - stockLedger) < 0.01,
    note: `库存 ${stockItems} / 流水 ${stockLedger}`
  });

  // 4) 原料库存 = 流水净额（早期直接改 stock_qty，历史数据可能对不上）
  const matStock = one('SELECT ROUND(SUM(stock_qty), 2) AS v FROM materials');
  const matLedger = one('SELECT ROUND(SUM(qty), 2) AS v FROM material_ledger');
  out.push({
    key: 'material_balance',
    severity: 'data',
    item: '原料库存 = 流水净额',
    expected: matLedger,
    actual: matStock,
    pass: matStock === null || matLedger === null ? null : Math.abs(matStock - matLedger) < 0.01,
    note: `库存 ${matStock} / 流水 ${matLedger}`
  });

  // 5) 订单明细孤儿
  const orphanItems = one(
    'SELECT COUNT(*) AS v FROM order_items oi LEFT JOIN orders o ON o.id = oi.order_id WHERE o.id IS NULL'
  );
  out.push({
    key: 'order_items_orphan',
    severity: 'data',
    item: '订单明细无孤儿行',
    expected: 0,
    actual: orphanItems,
    pass: orphanItems === 0,
    note: orphanItems ? `有 ${orphanItems} 行明细找不到订单` : '正常'
  });

  // 6) 账号唯一
  const dupUsers = one('SELECT COUNT(*) AS v FROM (SELECT username FROM users GROUP BY username HAVING COUNT(*) > 1)');
  out.push({
    key: 'users_unique',
    severity: 'hard',
    item: '账号无重复',
    expected: 0,
    actual: dupUsers,
    pass: dupUsers === 0,
    note: dupUsers ? `有 ${dupUsers} 个重名账号` : '正常'
  });

  return out;
}

/** 最近一次备份距今多少小时（页面用来告警） */
function backupHealth() {
  const last = db
    .prepare("SELECT * FROM backup_jobs WHERE kind IN ('manual','auto') ORDER BY id DESC LIMIT 1")
    .get();
  if (!last) {
    return { has_backup: false, hours_since: null, level: 'danger', message: '从未备份过，上线前必须配置备份' };
  }
  const hours = (Date.now() - new Date(last.created_at).getTime()) / 3600000;
  let level = 'ok';
  let message = `最近备份：${last.created_at}（${last.job_no}）`;
  if (hours > 24 * 7) {
    level = 'danger';
    message = `已超过 7 天没有备份（上次 ${last.created_at}）`;
  } else if (hours > 24) {
    level = 'warn';
    message = `已超过 24 小时没有备份（上次 ${last.created_at}）`;
  }
  return {
    has_backup: true,
    last_job: { id: last.id, job_no: last.job_no, created_at: last.created_at, kind: last.kind },
    hours_since: Math.round(hours * 10) / 10,
    level,
    message
  };
}

/** 磁盘占用概览 */
function storageInfo() {
  const dir = BR.backupDir(config.dbPath);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
  let total = 0;
  files.forEach((f) => {
    try { total += fs.statSync(path.join(dir, f)).size; } catch (e) { /* ignore */ }
  });
  const replaced = BR.replacedDir(config.dbPath);
  let replacedTotal = 0;
  let replacedCount = 0;
  try {
    fs.readdirSync(replaced).forEach((f) => {
      try {
        replacedTotal += fs.statSync(path.join(replaced, f)).size;
        replacedCount++;
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
  return {
    dir,
    files: files.length,
    total,
    total_human: humanSize(total),
    replaced_count: replacedCount,
    replaced_total_human: humanSize(replacedTotal),
    replaced_dir: replaced
  };
}

module.exports = {
  APP_VERSION,
  createBackup,
  listJobs,
  getJob,
  verifyJob,
  deleteJob,
  prepareRestore,
  rollbackRestore,
  pendingStatus,
  readPlan,
  businessChecks,
  backupHealth,
  storageInfo,
  humanSize
};
