/**
 * 备份文件校验 + 启动时应用待恢复文件
 * ============================================================
 * 这个模块**不能 require ../db**，因为它要在 db.js 打开数据库连接**之前**运行
 * （先换文件，再连库；顺序反了就会连到旧库上，恢复看起来「没生效」）。
 *
 * 三条硬规则，都是踩过的坑：
 *
 * 1. 换库必须同时删掉 `-wal` / `-shm`
 *    SQLite 恢复文件后，若残留旧库的 WAL，会被当作「未提交事务」重放到新库上，
 *    结果是「恢复完数据是新的，但一部分旧数据又冒出来了」——最难查的一类错。
 *
 * 2. 覆盖前必须校验，校验不过就不覆盖
 *    宁可恢复失败继续用旧库，也绝不能把一个坏文件盖上去。
 *
 * 3. 旧库不删，改名留档
 *    上传错版本时，唯一的退路就是那个被换下来的文件。磁盘不值钱。
 */
const fs = require('fs');
const path = require('path');

/** 还原时必须存在的表：缺任何一张，说明这不是本系统的库（或版本差太多） */
const REQUIRED_TABLES = [
  'users',
  'orders',
  'order_items',
  'customers',
  'products',
  'stock_items',
  'stock_ledger',
  'gl_entries'
];

/** 用来做「恢复前后对比」的关键表（业务主干，行数能反映数据是否丢） */
const KEY_TABLES = [
  'users', 'customers', 'products', 'materials', 'orders', 'order_items',
  'stock_items', 'stock_ledger', 'gl_vouchers', 'gl_entries',
  'payrolls', 'employees', 'tech_packs', 'backup_jobs'
];

function selectDriver() {
  try {
    return { Ctor: require('better-sqlite3'), driver: 'better-sqlite3' };
  } catch (e) {
    try {
      return { Ctor: require('node:sqlite').DatabaseSync, driver: 'node:sqlite' };
    } catch (e2) {
      return { Ctor: null, driver: 'none' };
    }
  }
}

/** 以只读方式打开一个 SQLite 文件（校验用，不改它） */
function openReadonly(file) {
  const { Ctor, driver } = selectDriver();
  if (!Ctor) throw new Error('没有可用的 SQLite 驱动，无法校验备份文件');
  // 两个驱动的只读参数名不同：better-sqlite3 = readonly，node:sqlite = readOnly
  if (driver === 'better-sqlite3') {
    return new Ctor(file, { readonly: true, fileMustExist: true });
  }
  return new Ctor(file, { readOnly: true });
}

function tableNames(conn) {
  try {
    return conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
  } catch (e) {
    return [];
  }
}

function countOf(conn, table) {
  try {
    const r = conn.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
    return Number(r && (r.c !== undefined ? r.c : r['COUNT(*)'])) || 0;
  } catch (e) {
    return null; // 表不存在
  }
}

/**
 * 校验一个备份文件能不能用来恢复
 * @returns {{ok:boolean, errors:string[], warnings:string[], integrity:string,
 *            tables:number, table_names:string[], rows_total:number, key_rows:object,
 *            size:number, sha256:string}}
 */
function inspectFile(file, { keepOpen = false } = {}) {
  const out = {
    ok: false, errors: [], warnings: [], integrity: '',
    tables: 0, table_names: [], rows_total: 0, key_rows: {},
    size: 0, sha256: '', handle: null
  };
  if (!fs.existsSync(file)) {
    out.errors.push('文件不存在');
    return out;
  }
  out.size = fs.statSync(file).size;
  out.sha256 = sha256File(file);

  // 文件头：不是 SQLite 就直接拒（避免把图片/CSV 当备份传上来）
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== 'SQLite format 3\u0000') {
    out.errors.push('不是 SQLite 数据库文件（文件头不匹配）');
    return out;
  }

  let conn;
  try {
    conn = openReadonly(file);
  } catch (e) {
    out.errors.push('打不开文件：' + e.message);
    return out;
  }

  try {
    // integrity_check 是 SQLite 自带的完整性校验；损坏的库这里就会报出具体页
    try {
      const rows = conn.prepare('PRAGMA integrity_check').all();
      out.integrity = rows.map((r) => Object.values(r)[0]).join('; ');
    } catch (e) {
      out.integrity = 'integrity_check 执行失败：' + e.message;
    }
    if (String(out.integrity).toLowerCase() !== 'ok') {
      out.errors.push('数据库完整性校验未通过：' + String(out.integrity).slice(0, 300));
    }

    out.table_names = tableNames(conn);
    out.tables = out.table_names.length;

    const missing = REQUIRED_TABLES.filter((t) => !out.table_names.includes(t));
    if (missing.length) {
      out.errors.push('缺少关键表：' + missing.join('、') + '（这不是本系统的库，或版本差距过大）');
    }

    // 太小的库基本是空壳（表建了没数据），恢复它等于清库 —— 必须让人明确知道
    KEY_TABLES.forEach((t) => {
      const c = countOf(conn, t);
      if (c !== null) {
        out.key_rows[t] = c;
        out.rows_total += c;
      }
    });
    if ((out.key_rows.users || 0) === 0) {
      out.errors.push('备份里没有任何账号（users 为 0），恢复后将无法登录');
    }
    if (out.rows_total === 0) {
      out.errors.push('备份里没有任何业务数据');
    }

    // 表数明显少于当前库时给个提醒，但不拦（可能是早期精简版本，人工判断）
    if (out.tables > 0 && out.tables < 50) {
      out.warnings.push(`快照里只有 ${out.tables} 张表，明显少于完整版本，请确认是不是要恢复这个版本`);
    }

    out.ok = out.errors.length === 0;
    if (keepOpen) out.handle = conn;
    return out;
  } finally {
    if (!keepOpen && conn) {
      try { conn.close(); } catch (e) { /* ignore */ }
    }
  }
}

function sha256File(file) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      h.update(buf.slice(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** 备份目录 */
function backupDir(dbPath) {
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 换下来的旧库放这里（**有保留上限**，见 pruneReplaced） */
function replacedDir(dbPath) {
  const dir = path.join(path.dirname(dbPath), 'replaced');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 清理 replaced 目录里过期的库副本
 *
 * ## 为什么必须有这个
 *
 * 「撤销恢复」每点一次就把待恢复文件改名丢进 `replaced/`（`restore-cancelled-*`），
 * 一份 ≈ 80MB。做恢复演练时反复取消，目录几天就长到 138 个文件 / 6.4GB ——
 * 全是不再需要的中间态，而磁盘不会被谁提醒。
 *
 * ## 保留多少
 *
 *   replaced-*           10 份：真正的「换库前原库」，回滚要靠它，多留
 *   restore-cancelled-*   5 份：只是留痕，最近的够查
 *   restore-failed-*      5 份：同上
 *
 * 按修改时间取最新 N 份，多出来的删掉。删的是**副本**，不是当前库。
 */
function pruneReplaced(dbPath, opts = {}) {
  const limits = Object.assign({
    'replaced-': 10,
    'restore-cancelled-': 5,
    'restore-failed-': 5
  }, opts.keep || {});
  const dir = replacedDir(dbPath);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.db')); } catch (e) { return { deleted: 0, freed: 0 }; }

  const groups = new Map();
  names.forEach((f) => {
    const prefix = Object.keys(limits).find((p) => f.startsWith(p));
    if (!prefix) return;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(f);
  });

  let deleted = 0;
  let freed = 0;
  groups.forEach((files, prefix) => {
    files
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(limits[prefix])
      .forEach((x) => {
        const full = path.join(dir, x.f);
        try {
          const size = fs.statSync(full).size;
          fs.unlinkSync(full);
          deleted += 1;
          freed += size;
        } catch (e) { /* 被占用就下次再删，不阻断 */ }
      });
  });
  return { deleted, freed };
}

function pendingPath(dbPath) {
  return path.join(path.dirname(dbPath), 'restore-pending.db');
}

function planPath(dbPath) {
  return path.join(path.dirname(dbPath), 'restore-plan.json');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * 启动时应用待恢复文件（在打开数据库连接之前调用）
 * @returns {{applied:boolean, reason?:string, replacedFile?:string, plan?:object, error?:string}}
 */
function applyPendingRestore({ dbPath }) {
  const pending = pendingPath(dbPath);
  if (!fs.existsSync(pending)) return { applied: false, reason: 'no-pending' };

  let plan = {};
  try {
    plan = JSON.parse(fs.readFileSync(planPath(dbPath), 'utf8'));
  } catch (e) {
    plan = {};
  }

  // 覆盖前再校验一次：pending 可能因为磁盘问题损坏
  const check = inspectFile(pending);
  if (!check.ok) {
    const bad = path.join(replacedDir(dbPath), `restore-failed-${stamp()}.db`);
    try { fs.renameSync(pending, bad); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(planPath(dbPath)); } catch (e) { /* ignore */ }
    return {
      applied: false,
      error: '待恢复文件校验未通过，已放弃恢复（旧库继续使用）：' + check.errors.join('；'),
      failedFile: bad,
      plan
    };
  }

  const target = path.join(replacedDir(dbPath), `replaced-${stamp()}.db`);
  try {
    // 旧库改名留档（不是删除）
    if (fs.existsSync(dbPath)) fs.renameSync(dbPath, target);
    // 关键：删掉旧库的 -wal / -shm，否则残留事务会被重放到新库上
    ['-wal', '-shm'].forEach((suffix) => {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
      }
    });
    fs.renameSync(pending, dbPath);
    fs.unlinkSync(planPath(dbPath));
  } catch (e) {
    // 尽量把旧库放回去，别把人挡在系统外面
    try {
      if (!fs.existsSync(dbPath) && fs.existsSync(target)) fs.renameSync(target, dbPath);
    } catch (e2) { /* ignore */ }
    return { applied: false, error: '替换数据库文件失败：' + e.message, plan };
  }

  // 换库成功后顺手裁一遍旧副本：恢复演练可以来回折腾几十次，不裁就会堆到几个 GB
  try { pruneReplaced(dbPath); } catch (e) { /* 清理失败不影响恢复结果 */ }

  return {
    applied: true,
    replacedFile: target,
    plan,
    checks: { integrity: check.integrity, tables: check.tables, rows_total: check.rows_total, key_rows: check.key_rows }
  };
}

module.exports = {
  REQUIRED_TABLES,
  KEY_TABLES,
  inspectFile,
  sha256File,
  openReadonly,
  backupDir,
  replacedDir,
  pruneReplaced,
  pendingPath,
  planPath,
  applyPendingRestore,
  stamp
};
