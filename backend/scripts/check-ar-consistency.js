/**
 * 应收/应付核销一致性体检
 * ============================================================
 * 用法：
 *   node scripts/check-ar-consistency.js          # 只列出不一致（只读）
 *   node scripts/check-ar-consistency.js --fix    # 按核销记录回写 paid_amount 与状态
 *
 * 查什么：每张发票的 `paid_amount` 是否等于「它被核销掉的金额合计」。
 *
 * 为什么这条会不平：`paid_amount` 是冗余字段（为了列表查询快），
 * 真值在 `payment_allocations`（哪笔收款核销了哪张发票）。只要有代码绕过核销直接改
 * `paid_amount`（早期演示数据、手工修数、或 status 口径不一致导致 syncStatus 没写回），
 * 两者就会分叉 —— 分叉之后：账龄算错、对账单对不平、结案校验用错数。
 *
 * 口径：收款只认 `valid`/`confirmed` 且未冲销（`services/paymentStatus.js`）。
 */
const { db, now } = require('../src/db');
const { payValidOf } = require('../src/services/paymentStatus');

const FIX = process.argv.includes('--fix');
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function scan(kind) {
  const table = kind === 'ar' ? 'ar_invoices' : 'ap_invoices';
  const partyCol = kind === 'ar' ? 'customer_name' : 'supplier_name';
  const rows = db
    .prepare(
      `SELECT i.id, i.bill_no, i.amount, IFNULL(i.paid_amount, 0) AS paid_amount, i.status,
              IFNULL(i.${partyCol}, '') AS party,
              (SELECT COALESCE(SUM(a.amount), 0)
                 FROM payment_allocations a
                 JOIN payments p ON p.id = a.payment_id AND ${payValidOf('p')}
                WHERE a.invoice_kind = ? AND a.invoice_id = i.id) AS alloc
         FROM ${table} i
        WHERE i.status != 'void'`
    )
    .all(kind);
  return rows
    .map((r) => ({ ...r, alloc: r2(r.alloc), diff: r2((Number(r.paid_amount) || 0) - r2(r.alloc)) }))
    .filter((r) => Math.abs(r.diff) >= 0.01);
}

function statusOf(amount, paid) {
  if (paid >= r2(amount) - 0.005) return 'paid';
  if (paid > 0) return 'partial';
  return 'unpaid';
}

let totalDiff = 0;
let badCount = 0;

['ar', 'ap'].forEach((kind) => {
  const bad = scan(kind);
  const label = kind === 'ar' ? '应收' : '应付';
  console.log(`\n=== ${label}发票：${bad.length} 张不一致 ===`);
  if (!bad.length) {
    console.log('  全部一致 ✓');
    return;
  }
  bad.forEach((r) => {
    badCount++;
    totalDiff = r2(totalDiff + r.diff);
    console.log(
      `  ${r.bill_no}（${r.party}）开票 ${r.amount} / 记录已收 ${r.paid_amount} / 实际核销 ${r.alloc} / 差 ${r.diff}`
    );
  });
});

console.log(`\n合计：${badCount} 张发票不一致，净差额 ${totalDiff} 元`);

if (!badCount) process.exit(0);

if (!FIX) {
  console.log('\n（只读模式。确认要按核销记录回写，加 --fix 再跑一次）');
  console.log('  回写规则：paid_amount = Σ核销金额；status 按 unpaid / partial / paid 重算');
  process.exit(0);
}

// ---------- 回写 ----------
let fixed = 0;
const updAr = db.prepare('UPDATE ar_invoices SET paid_amount = ?, status = ?, updated_at = ? WHERE id = ?');
const updAp = db.prepare('UPDATE ap_invoices SET paid_amount = ?, status = ?, updated_at = ? WHERE id = ?');

db.exec('BEGIN');
try {
  ['ar', 'ap'].forEach((kind) => {
    const table = kind === 'ar' ? 'ar_invoices' : 'ap_invoices';
    const upd = kind === 'ar' ? updAr : updAp;
    scan(kind).forEach((r) => {
      const st = statusOf(r.amount, r.alloc);
      upd.run(r.alloc, st, now(), r.id);
      fixed++;
      console.log(`  修正 ${kind.toUpperCase()} ${r.bill_no}：已收 ${r.paid_amount} → ${r.alloc}，状态 → ${st}`);
    });
  });
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('回滚：', e.message);
  process.exit(1);
}

console.log(`\n已修正 ${fixed} 张发票。重新体检：`);
const after = ['ar', 'ap'].reduce((s, k) => s + scan(k).length, 0);
console.log(after === 0 ? '  全部一致 ✓' : `  仍有 ${after} 张不一致，需要人工核`);
process.exit(after === 0 ? 0 : 1);
