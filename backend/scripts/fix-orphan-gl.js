/**
 * 清理孤儿凭证分录（分录指向的凭证不存在）
 * ============================================================
 * 怎么产生的：演示/回放脚本中途被打断，或某次事务只写了一半就回滚。
 * 危害：这些分录没有对应凭证，却会计入总账合计 —— 表现为「总账借贷不平」，
 *       而且怎么查凭证都查不出原因（因为它们没有凭证）。
 *
 * 安全措施：
 *   1. 默认只列出（dry-run），不加 --apply 不动数据
 *   2. 只删「凭证确实不存在」的行，有任何疑问的行不删
 *   3. 删除前打印金额，便于人工核对是否与不平差额吻合
 *
 * 用法：
 *   node scripts/fix-orphan-gl.js            # 只看
 *   node scripts/fix-orphan-gl.js --apply    # 真删
 */
const { db } = require('../src/db');

const APPLY = process.argv.includes('--apply');

const rows = db
  .prepare(
    `SELECT e.id, e.voucher_id, e.period, e.account_code, e.account_name,
            e.debit, e.credit, e.summary
       FROM gl_entries e
       LEFT JOIN gl_vouchers v ON v.id = e.voucher_id
      WHERE v.id IS NULL
      ORDER BY e.id`
  )
  .all();

const sum = (k) => Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;

console.log(`\n孤儿分录：${rows.length} 条`);
if (rows.length) {
  console.log(`借方合计 ${sum('debit')} / 贷方合计 ${sum('credit')} / 净影响 ${Math.round((sum('debit') - sum('credit')) * 100) / 100}`);
  console.log('\n前 10 条：');
  rows.slice(0, 10).forEach((r) => {
    console.log(
      `  #${r.id} 凭证#${r.voucher_id} ${r.period} ${r.account_code} ${r.account_name} ` +
        `借${r.debit} 贷${r.credit} | ${r.summary || ''}`
    );
  });
  if (rows.length > 10) console.log(`  …其余 ${rows.length - 10} 条`);
}

if (!rows.length) {
  console.log('✓ 没有孤儿分录，总账数据是干净的');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n这是只读检查。确认要删除请加 --apply');
  process.exit(0);
}

db.exec('BEGIN');
try {
  const info = db.prepare(
    `DELETE FROM gl_entries
      WHERE id IN (SELECT e.id FROM gl_entries e
                     LEFT JOIN gl_vouchers v ON v.id = e.voucher_id
                    WHERE v.id IS NULL)`
  ).run();
  db.exec('COMMIT');
  console.log(`\n✓ 已删除 ${info.changes} 条孤儿分录`);
  const after = db.prepare('SELECT ROUND(SUM(debit),2) d, ROUND(SUM(credit),2) c FROM gl_entries').get();
  console.log(`  清理后总账：借 ${after.d} / 贷 ${after.c}（差 ${Math.round((after.d - after.c) * 100) / 100}）`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('✗ 清理失败，已回滚：' + e.message);
  process.exit(1);
}
