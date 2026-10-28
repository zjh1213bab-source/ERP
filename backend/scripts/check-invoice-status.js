/**
 * 应收 / 应付发票状态体检
 *
 * 查三类问题（都是「钱算少了没人知道」的那一类）：
 *
 *   1. 野状态值      status 不在 unpaid/partial/paid/void 里 —— 白名单式查询会把它静默漏掉
 *   2. 状态与金额不符 已收金额 ≥ 票面，状态还写 unpaid（或反过来）
 *   3. 超付         已收 > 票面，多出来的钱挂着没人管
 *
 * 用法：
 *   node scripts/check-invoice-status.js          只看（默认，不动数据）
 *   node scripts/check-invoice-status.js --fix    归一野值 + 按金额修正状态
 *
 * 为什么默认只读：这些都是账上的钱，自动改必须有人看着跑一次。
 */
const { db, now } = require('../src/db');
const S = require('../src/services/invoiceStatus');

const FIX = process.argv.includes('--fix');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TABLES = [
  { table: 'ar_invoices', label: '应收', party: 'customer_name' },
  { table: 'ap_invoices', label: '应付', party: 'supplier_name' }
];

let problems = 0;
const fixes = [];

TABLES.forEach(({ table, label, party }) => {
  console.log(`\n========== ${label}（${table}）==========`);

  const all = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  const byStatus = {};
  all.forEach((r) => {
    const k = String(r.status || '(空)');
    byStatus[k] = byStatus[k] || { n: 0, open: 0, amount: 0 };
    byStatus[k].n++;
    byStatus[k].amount = r2(byStatus[k].amount + (Number(r.amount) || 0));
    byStatus[k].open = r2(byStatus[k].open + r2((Number(r.amount) || 0) - (Number(r.paid_amount) || 0)));
  });
  console.log(`共 ${all.length} 张`);
  Object.entries(byStatus).forEach(([k, v]) => {
    const known = S.KNOWN.includes(k);
    const alias = !known && S.ALIAS[k];
    const flag = known ? '' : alias ? `  ← 别名，应归一为 ${alias}` : '  ← 【未知状态】';
    console.log(`  ${k.padEnd(10)} ${String(v.n).padStart(3)} 张  票面 ${money(v.amount).padStart(14)}  未结 ${money(v.open).padStart(14)}${flag}`);
  });

  // ---------- 1. 野状态 ----------
  const wild = all.filter((r) => S.normalizeStatus(r.status) === null);
  if (wild.length) {
    problems += wild.length;
    console.log(`\n  ⚠ 未知状态 ${wild.length} 张（任何白名单查询都会把它们漏掉）：`);
    wild.slice(0, 20).forEach((r) => {
      console.log(`     #${r.id} ${r.bill_no || ''} ${String(r[party] || '').slice(0, 18)} status=${JSON.stringify(r.status)} 未结 ${money(r2((r.amount || 0) - (r.paid_amount || 0)))}`);
    });
  }

  // ---------- 2. 别名可归一 ----------
  const aliased = all.filter((r) => {
    const n = S.normalizeStatus(r.status);
    return n && n !== r.status;
  });
  if (aliased.length) {
    problems += aliased.length;
    const openSum = r2(aliased.reduce((s, r) => s + r2((Number(r.amount) || 0) - (Number(r.paid_amount) || 0)), 0));
    console.log(`\n  ⚠ 别名状态 ${aliased.length} 张（未结合计 ${money(openSum)}）→ 归一后这些钱才进得了统计`);
    aliased.slice(0, 20).forEach((r) => {
      console.log(`     #${r.id} ${r.bill_no || ''} ${r.status} → ${S.normalizeStatus(r.status)}  未结 ${money(r2((r.amount || 0) - (r.paid_amount || 0)))}`);
    });
    aliased.forEach((r) => fixes.push({ table, id: r.id, to: S.normalizeStatus(r.status), why: `状态别名 ${r.status}` }));
  }

  // ---------- 3. 状态与金额不符 ----------
  const mismatch = all
    .filter((r) => String(r.status || '') !== 'void')
    .filter((r) => {
      const expect = S.inferStatus(r);
      return expect !== String(r.status || '') && !S.ALIAS[String(r.status || '')];
    });
  if (mismatch.length) {
    console.log(`\n  ⚠ 状态与金额不符 ${mismatch.length} 张：`);
    mismatch.slice(0, 20).forEach((r) => {
      console.log(`     #${r.id} ${r.bill_no || ''} 票面 ${money(r.amount)} 已收 ${money(r.paid_amount)} status=${r.status} → 应为 ${S.inferStatus(r)}`);
    });
    mismatch.forEach((r) => {
      const expect = S.inferStatus(r);
      if (!fixes.some((f) => f.table === table && f.id === r.id)) {
        fixes.push({ table, id: r.id, to: expect, why: `金额与状态不符（已收 ${r2(r.paid_amount)} / 票面 ${r2(r.amount)}）` });
      }
    });
  }

  // ---------- 4. 超付 ----------
  const over = all.filter((r) => String(r.status || '') !== 'void' && r2(r.paid_amount) - r2(r.amount) > 0.005);
  if (over.length) {
    console.log(`\n  ⚠ 超付 ${over.length} 张（已收多于票面，多出来的钱要查清是预收还是录错）：`);
    over.slice(0, 10).forEach((r) => {
      console.log(`     #${r.id} ${r.bill_no || ''} 票面 ${money(r.amount)} 已收 ${money(r.paid_amount)} 多 ${money(r2(r.paid_amount - r.amount))}`);
    });
  }

  // ---------- 5. 两种口径差多少 ----------
  const openByAmount = r2(
    db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ${table} WHERE ${S.OPEN_SQL}`).get().s
  );
  const openByStatus = r2(
    db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ${table} WHERE status IN ('unpaid','partial')`).get().s
  );
  const diff = r2(openByAmount - openByStatus);
  console.log(`\n  口径对比：按金额 ${money(openByAmount)} / 按白名单状态 ${money(openByStatus)} / 差 ${money(diff)}`);
  if (Math.abs(diff) >= 0.01) {
    console.log(`  ⚠ 这个差额就是「驾驶舱和财务页对不上」的全部原因 —— 野状态被白名单漏掉了`);
  }
});

// ---------- 执行修复 ----------
console.log('');
if (!fixes.length) {
  console.log(fixes.length === 0 && problems === 0 ? '✓ 全部一致，没有需要修的地方' : '没有可自动修复的项');
} else if (!FIX) {
  console.log(`发现 ${fixes.length} 项可自动修复。**加 --fix 才会改数据**（改之前建议先备份：系统设置 → 数据备份）`);
} else {
  const t = now();
  db.exec('BEGIN');
  try {
    fixes.forEach((f) => {
      db.prepare(`UPDATE ${f.table} SET status = ?, updated_at = ? WHERE id = ?`).run(f.to, t, f.id);
      console.log(`  修 ${f.table}#${f.id} → ${f.to}（${f.why}）`);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`\n✓ 修复 ${fixes.length} 项`);

  // 修完复验：两个口径必须一致
  TABLES.forEach(({ table, label }) => {
    const a = r2(db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ${table} WHERE ${S.OPEN_SQL}`).get().s);
    const b = r2(db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ${table} WHERE status IN ('unpaid','partial')`).get().s);
    console.log(`  ${label}：按金额 ${money(a)} / 按状态 ${money(b)} ${Math.abs(a - b) < 0.01 ? '✓ 一致' : '⚠ 仍差 ' + money(a - b)}`);
  });
}

process.exit(0);
