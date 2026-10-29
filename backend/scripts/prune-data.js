/**
 * 清理工程里的「过程产物」—— 旧库副本、旧发布包、临时快照
 *
 * 用法：
 *   node scripts/prune-data.js            # 只列清单，不删（默认）
 *   node scripts/prune-data.js --apply    # 真的删
 *   node scripts/prune-data.js --apply --keep-packages 3
 *
 * ## 清什么
 *
 *   1. `data/replaced/` —— 恢复演练换下来的库副本。
 *      撤销一次留一份（≈80MB），138 份就是 6.4GB。按 backup-restore.pruneReplaced
 *      的保留策略裁（replaced 10 / cancelled 5 / failed 5）。
 *   2. `data/*.bak-*` —— apply 脚本跑前的库快照，只留最新 1 份。
 *   3. `packages/*.zip` —— 历史发布包，只留最新 N 份（默认 2）。
 *
 * ## 不碰什么
 *
 *   备份单据（`data/backups/` 里 `BK*`、`pre-cleanup-*`）不删：
 *   它们是备份列表页能下载到的东西，删了页面上就会出现点了没反应的记录。
 *   要清备份请走「系统 → 备份」里的删除，那里会同时清理 backup_jobs 行。
 */
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const argNum = (name, dflt) => {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const KEEP_PACKAGES = argNum('--keep-packages', 2);
const KEEP_BAK = argNum('--keep-bak', 1);

const DATA = path.resolve(__dirname, '../data');
const PKG = path.resolve(__dirname, '../../packages');

const human = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB'
  : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
    : (n / 1024).toFixed(0) + ' KB');

function rm(files) {
  let freed = 0;
  files.forEach((f) => {
    try { freed += fs.statSync(f).size; fs.unlinkSync(f); } catch (e) { /* 占用就跳过 */ }
  });
  return freed;
}

const report = [];
let totalFreed = 0;

/* ---------- 1. replaced/：走备份模块同一套保留策略 ---------- */
{
  const { pruneReplaced } = require('../src/services/backup-restore');
  const dbPath = path.join(DATA, 'erp-mindmap.db');
  const dir = path.join(DATA, 'replaced');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')) : [];
  const beforeSize = before.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);

  if (!APPLY) {
    // 预览：按同样规则算「会留下哪些」
    const limits = { 'replaced-': 10, 'restore-cancelled-': 5, 'restore-failed-': 5 };
    const groups = new Map();
    before.forEach((f) => {
      const p = Object.keys(limits).find((x) => f.startsWith(x));
      if (!p) return;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(f);
    });
    let del = [];
    groups.forEach((files, p) => {
      const sorted = files.map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
      del = del.concat(sorted.slice(limits[p]).map((x) => x.f));
    });
    const freed = del.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
    report.push(`replaced/：${before.length} 个文件 ${human(beforeSize)} → 可清理 ${del.length} 个 ${human(freed)}`);
    totalFreed += freed;
  } else {
    const r = pruneReplaced(dbPath);
    const after = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
    report.push(`replaced/：删 ${r.deleted} 个，释放 ${human(r.freed)}（剩 ${after.length} 个）`);
    totalFreed += r.freed;
  }
}

/* ---------- 2. data/*.bak-*：保留最新 N 份 ---------- */
{
  const files = fs.readdirSync(DATA)
    .filter((f) => /^erp-mindmap\.db\.bak-/.test(f))
    .map((f) => ({ f: path.join(DATA, f), m: fs.statSync(path.join(DATA, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const del = files.slice(KEEP_BAK);
  const freed = del.reduce((s, x) => s + fs.statSync(x.f).size, 0);
  if (APPLY && del.length) rm(del.map((x) => x.f));
  report.push(`data/*.bak-*：${files.length} 个 → 保留 ${Math.min(KEEP_BAK, files.length)}，清 ${del.length} 个 ${human(freed)}`);
  totalFreed += freed;
}

/* ---------- 3. packages/*.zip：保留最新 N 份 ---------- */
{
  if (fs.existsSync(PKG)) {
    const ver = (f) => {
      const m = f.match(/v(\d+)\.(\d+)\.(\d+)/);
      return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
    };
    const files = fs.readdirSync(PKG)
      .filter((f) => /^erp-mindmap-v.*\.zip$/.test(f))
      .sort((a, b) => {
        const A = ver(a); const B = ver(b);
        for (let i = 0; i < 3; i += 1) if (A[i] !== B[i]) return B[i] - A[i];
        return 0;
      });
    const del = files.slice(KEEP_PACKAGES);
    const freed = del.reduce((s, f) => s + fs.statSync(path.join(PKG, f)).size, 0);
    if (APPLY && del.length) rm(del.map((f) => path.join(PKG, f)));
    report.push(`packages/*.zip：${files.length} 个 → 保留最新 ${Math.min(KEEP_PACKAGES, files.length)}，清 ${del.length} 个 ${human(freed)}`);
    totalFreed += freed;
  }
}

console.log(APPLY ? '—— 清理结果 ——' : '—— 预览（加 --apply 才会真删）——');
report.forEach((r) => console.log('  ' + r));
console.log(`\n合计可释放 / 已释放：${human(totalFreed)}`);
