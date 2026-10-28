/**
 * 审计归档演练
 * ============================================================
 * 用法：node scripts/drill-audit-archive.js [条数=500]
 *
 * 归档是这个系统里唯一会「减少日志」的动作，所以它必须真跑一遍才敢上线：
 * 文件有没有落？条目数对不对？归档之后链还验得通吗？水位推得对不对？
 *
 * 做法：
 *   1. 用 `VACUUM INTO` 从生产库做一个一致性快照（不动生产库）
 *   2. 在副本上把最早 N 条日志的时间改到 60 天前，并**重算整条链**（改时间会破链）
 *   3. 在副本上执行归档，检查文件 / 行数 / 水位 / verify
 *   4. 删副本与演练产生的归档文件
 *
 * 关键点：归档必须只切「连续前缀」。按时间删会留下 seq 断档 ——
 * 那之后的每次校验都会报「头部不连续」，等于自己把审计废掉。
 */
const fs = require('fs');
const pathMod = require('path');

const N = Math.max(Number(process.argv[2]) || 500, 10);
const DATA = pathMod.resolve(__dirname, '../data');
const SRC = pathMod.join(DATA, 'erp-mindmap.db');
const TMP = pathMod.join(DATA, `tmp-drill-audit-${Date.now()}.db`);

if (!fs.existsSync(SRC)) {
  console.error('找不到生产库：', SRC);
  process.exit(1);
}

// 1) 一致性快照
{
  const Database = require('better-sqlite3');
  const d = new Database(SRC, { readonly: true });
  d.exec(`VACUUM INTO '${TMP.replace(/\\/g, '/')}'`);
  d.close();
  console.log('快照 →', pathMod.basename(TMP), (fs.statSync(TMP).size / 1048576).toFixed(1) + ' MB');
}

// 2) 后续所有模块都连副本
process.env.DB_PATH = TMP;
const { db } = require('../src/db');
const audit = require('../src/services/auditLog');

function fail(msg) {
  console.error('✗', msg);
  try { fs.unlinkSync(TMP); } catch (e) { /* ignore */ }
  process.exit(1);
}

// 3) 把最早 N 条改成 60 天前，并重算整条链（created_at 参与哈希）
const cut = new Date(Date.now() - 60 * 86400000).toISOString();
const before = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c;
db.prepare('UPDATE audit_logs SET created_at = ? WHERE seq <= ?').run(cut, N);

const rows = db.prepare('SELECT seq, username, method, path, status, created_at FROM audit_logs ORDER BY seq ASC').all();
const upd = db.prepare('UPDATE audit_logs SET prev_hash = ?, hash = ? WHERE seq = ?');
let prev = audit.GENESIS;
db.exec('BEGIN');
try {
  rows.forEach((r) => {
    const h = audit.chainHash(r, prev);
    upd.run(prev, h, r.seq);
    prev = h;
  });
  db.prepare('UPDATE audit_chain_state SET last_hash = ? WHERE id = 1').run(prev);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  fail('重算链失败：' + e.message);
}
console.log(`已把前 ${N} 条改成 60 天前，并重算 ${rows.length} 条哈希`);

const pre = audit.verify();
if (!pre.ok) fail('改时间后链就不对了：' + JSON.stringify(pre.problems.slice(0, 3)));
console.log(`改造后校验：通过（${pre.checked} 条）`);

// 4) 归档
const rec = audit.archive({ beforeDays: 30, operator: '演练', note: '归档演练（临时库）' });
console.log(`归档：${rec.archive_no} | #${rec.from_seq}~#${rec.to_seq} | ${rec.rows} 条 | ${rec.file}`);

const filePath = pathMod.join(__dirname, '../data/audit-archives', rec.file);
if (!fs.existsSync(filePath)) fail('归档文件没落盘：' + filePath);
const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
const after = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c;
const st = audit.chainState();
const post = audit.verify();

const checks = [
  ['归档文件存在', fs.existsSync(filePath)],
  ['文件行数 = 归档条数', lines.length === rec.rows, `${lines.length} vs ${rec.rows}`],
  ['主表减少了对应条数', before - after === rec.rows, `${before - after} vs ${rec.rows}`],
  ['归档只切连续前缀（从 #1 开始）', Number(rec.from_seq) === 1, `from=${rec.from_seq}`],
  ['水位推到归档末尾', Number(st.anchor_seq) === Number(rec.to_seq), `${st.anchor_seq} vs ${rec.to_seq}`],
  ['水位哈希 = 归档末条哈希', st.anchor_hash === rec.last_hash],
  ['归档后链仍通过校验', post.ok, JSON.stringify(post.problems.slice(0, 2))],
  ['剩余日志从 anchor+1 开始', post.head && Number(post.head.seq) === Number(rec.to_seq) + 1, `head=${post.head && post.head.seq}`]
];

let bad = 0;
checks.forEach(([name, cond, extra]) => {
  if (cond) console.log('  ✓', name);
  else { bad++; console.log('  ✗', name, extra ? '-> ' + extra : ''); }
});

// 5) 清理（副本 + 演练文件 + 演练归档目录里的空目录）
try { fs.unlinkSync(TMP); } catch (e) { /* ignore */ }
try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }

console.log(`\n演练结束：${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
