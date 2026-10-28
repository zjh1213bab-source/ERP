/**
 * 应付侧地基：供应商账期 + 应付到期日 + 供应商关联补齐
 *
 * 1. suppliers 加 `term_days`：把「月结30天」这类文本解析成可计算的天数，缓存下来
 * 2. ap_invoices 补 `supplier_id`：老数据只存了名字，导致没法按供应商汇总
 * 3. ap_invoices 重算 `due_date`：原来拿「预计到货日」当到期日，账龄凭空多算一个月
 *
 * 第 3 条是**可选**的（`--redue`），因为它会改账龄 —— 财务得先看一眼改完什么样。
 */
const { db, now } = require('../src/db');
const T = require('../src/services/paymentTerms');

const REDO_DUE = process.argv.includes('--redue');
const t = now();

// ---------- 1. suppliers.term_days ----------
const haveCol = db.prepare('PRAGMA table_info(suppliers)').all().some((c) => c.name === 'term_days');
if (!haveCol) {
  db.exec('ALTER TABLE suppliers ADD COLUMN term_days INTEGER');
  console.log('加列 suppliers.term_days');
} else {
  console.log('suppliers.term_days 已存在');
}

const sups = db.prepare('SELECT * FROM suppliers ORDER BY id').all();
console.log(`\n=== 账期解析（${sups.length} 家）===`);
let parsed = 0;
let unknown = [];
sups.forEach((s) => {
  const p = T.parseTerms(s.payment_terms);
  if (s.term_days !== null && s.term_days !== undefined && s.term_days !== '') {
    console.log(`  ${String(s.name).slice(0, 16).padEnd(18)} 手工天数 ${s.term_days}（文本「${s.payment_terms || '—'}」不覆盖）`);
    return;
  }
  if (!p) {
    unknown.push(s);
    console.log(`  ${String(s.name).slice(0, 16).padEnd(18)} 【读不出】文本「${s.payment_terms || '—'}」→ 留空，请手工填天数`);
    return;
  }
  db.prepare('UPDATE suppliers SET term_days = ?, updated_at = ? WHERE id = ?').run(p.days, t, s.id);
  parsed++;
  console.log(
    `  ${String(s.name).slice(0, 16).padEnd(18)} ${String(s.payment_terms).padEnd(10)} → ${p.days} 天（${p.kind}）`
  );
});
console.log(`  解析成功 ${parsed} 家${unknown.length ? `，读不出 ${unknown.length} 家（这些供应商的应付到期日会为空）` : ''}`);

// ---------- 2. 补 supplier_id ----------
const orphan = db
  .prepare("SELECT * FROM ap_invoices WHERE supplier_id IS NULL AND IFNULL(supplier_name,'') <> ''")
  .all();
console.log(`\n=== 应付供应商关联（缺 ${orphan.length} 张）===`);
orphan.forEach((inv) => {
  // 先按名称精确匹配，再按简称/包含匹配 —— 只做确定性匹配，不做模糊猜
  let hit = db.prepare('SELECT id, name FROM suppliers WHERE name = ?').get(inv.supplier_name);
  if (!hit) {
    hit = db.prepare('SELECT id, name FROM suppliers WHERE short_name = ?').get(inv.supplier_name);
  }
  if (!hit) {
    console.log(`  #${inv.id} ${inv.bill_no} 「${inv.supplier_name}」→ 档案里没有同名供应商，跳过`);
    return;
  }
  db.prepare('UPDATE ap_invoices SET supplier_id = ?, updated_at = ? WHERE id = ?').run(hit.id, t, inv.id);
  console.log(`  #${inv.id} ${inv.bill_no} 「${inv.supplier_name}」→ supplier_id=${hit.id}`);
});

// ---------- 3. 重算到期日 ----------
if (REDO_DUE) {
  console.log('\n=== 重算到期日（按「开票日 + 供应商账期」）===');
  const rows = db.prepare("SELECT * FROM ap_invoices WHERE status <> 'void' ORDER BY id").all();
  let changed = 0;
  db.exec('BEGIN');
  try {
    rows.forEach((inv) => {
      const sup = inv.supplier_id ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(inv.supplier_id) : null;
      const billDate = String(inv.created_at || '').slice(0, 10) || T.todayStr();
      const due = T.apDueDate(sup, billDate);
      if (!due) return;              // 账期读不出 → 保持原值，不瞎算
      if (String(inv.due_date || '').slice(0, 10) === due) return;
      db.prepare('UPDATE ap_invoices SET due_date = ?, updated_at = ? WHERE id = ?').run(due, t, inv.id);
      console.log(`  #${inv.id} ${inv.bill_no} ${inv.due_date || '（空）'} → ${due}`);
      changed++;
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`  改了 ${changed} 张`);
} else {
  console.log('\n（到期日未重算。要按「开票日 + 账期」重算请加 --redue，改完先看账龄对不对）');
}

// ---------- 汇总 ----------
console.log('\n=== 汇总 ===');
const S = require('../src/services/invoiceStatus');
const ap = db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s, COUNT(*) n FROM ap_invoices WHERE ${S.OPEN_SQL}`).get();
const withDue = db.prepare(`SELECT COUNT(*) c FROM ap_invoices WHERE ${S.OPEN_SQL} AND due_date IS NOT NULL AND due_date <> ''`).get().c;
console.log(`应付未结 ${ap.n} 张 / ${(Number(ap.s) || 0).toLocaleString('zh-CN')} 元；其中 ${withDue} 张有到期日`);
if (ap.n > withDue) {
  console.log(`⚠ ${ap.n - withDue} 张没有到期日 —— 这些在账龄里只能算「未到期」，永远不会被判为逾期`);
}
