/**
 * 预算演示数据（幂等重放）
 *   node scripts/seed-budget-demo.js --reset
 *
 * 造的场景：
 *   - 2026 年度两版预算：V1 已关闭（历史版本）、V2 生效中
 *   - 6 个部门 × 2 个费用科目 × 2026-09/10 两个月
 *   - 2026-10 已入账费用凭证（带部门）→ 能看出谁快超、谁已经超
 *   - 一条「已提交未入账」的占用（体现 已用 = 已发生 + 已占用）
 *   - 一笔超预算特批（留痕，能看到理由）
 *   - 调整单 2 笔：1 待审批、1 已批准（追加后额度变了）
 */
const { db } = require('../src/db');
const { localNow } = require('../src/services/sla');
const B = require('../src/services/budget');

const TAG = 'BUDGET-DEMO';
const YEAR = 2026;

const DEPTS = [
  { id: 1, name: '销售部' },
  { id: 2, name: '技术部' },
  { id: 3, name: '财务部' },
  { id: 4, name: '生产部' },
  { id: 5, name: '仓储物流部' },
  { id: 6, name: '人事行政部' }
];

/** 各部门每月 6602 管理费用预算 */
const PLAN_6602 = { 1: 26000, 2: 18000, 3: 12000, 4: 45000, 5: 15000, 6: 9000 };
/** 销售部另有 6601 销售费用（招待/推广） */
const PLAN_6601 = { 1: 30000 };

function reset() {
  db.prepare('DELETE FROM budget_alerts').run();
  db.prepare('DELETE FROM budget_commitments').run();
  db.prepare('DELETE FROM budget_adjustments').run();
  db.prepare('DELETE FROM budget_items').run();
  db.prepare('DELETE FROM budgets').run();
  // 清掉本脚本造的费用与凭证
  const exp = db.prepare("SELECT id FROM admin_expenses WHERE remark LIKE ?").all(`%${TAG}%`).map((x) => x.id);
  if (exp.length) {
    db.prepare(`DELETE FROM admin_expenses WHERE id IN (${exp.map(() => '?').join(',')})`).run(...exp);
  }
  db.prepare("DELETE FROM gl_entries WHERE summary LIKE ?").run(`%${TAG}%`);
  db.prepare("DELETE FROM gl_vouchers WHERE summary LIKE ?").run(`%${TAG}%`);
}

/** 直接造一张已入账的费用凭证（带部门），模拟「钱已经花了、账也记了」 */
function mkPostedExpense({ vno, date, deptId, account, amount, summary, payee }) {
  const t = localNow();
  const period = String(date).slice(0, 7);
  const vid = db.prepare(
    `INSERT INTO gl_vouchers (voucher_no,period,biz_date,summary,source_type,source_id,status,debit_total,credit_total,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'posted',?,?,?,?,?)`
  ).run(vno, period, date, summary, 'expense', null, amount, amount, 'seed', t, t).lastInsertRowid;

  const acct = B.acctOf(account);
  const ins = db.prepare(
    `INSERT INTO gl_entries (voucher_id,period,line_no,account_code,account_name,summary,debit,credit,
       partner_type,partner_id,partner_name,department_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  ins.run(vid, period, 1, account, acct ? acct.name : account, `${summary} ${payee}`, amount, 0, null, null, null, deptId, t);
  ins.run(vid, period, 2, '1002', '银行存款', `支付 ${payee}`, 0, amount, null, null, null, null, t);
  return vid;
}

function seed() {
  const t = localNow();
  const out = [];

  // ---------- V1（历史版本，已关闭） ----------
  const v1 = db.prepare(
    `INSERT INTO budgets (budget_no,fiscal_year,company_id,name,version,status,total_amount,item_count,tolerance_pct,is_current,note,created_by,created_at,updated_at,approved_by,approved_at,closed_by,closed_at)
     VALUES (?,?,1,?,1,'closed',0,0,0,0,?,?,?,?,?,?,?,?)`
  ).run(`YS${YEAR}`, YEAR, '2026 年度费用预算（初版）', '年初按去年实际 +10% 编制', 'seed', t, t, 'admin', t, 'admin', t).lastInsertRowid;

  const insItem = db.prepare(
    `INSERT INTO budget_items (budget_id,department_id,department_name,account_code,account_name,period,amount,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  ['2026-09', '2026-10'].forEach((p) => {
    DEPTS.forEach((d) => {
      const amt = Math.round(PLAN_6602[d.id] * 0.9);
      insItem.run(v1, d.id, d.name, '6602', '管理费用', p, amt, null, t, t);
    });
  });
  B.refreshBudget(v1);

  // ---------- V2（生效中） ----------
  const v2 = db.prepare(
    `INSERT INTO budgets (budget_no,fiscal_year,company_id,name,version,status,total_amount,item_count,tolerance_pct,is_current,note,created_by,created_at,updated_at,approved_by,approved_at)
     VALUES (?,?,1,?,2,'active',0,0,5,1,?,?,?,?,?,?)`
  ).run(`YS${YEAR}-V2`, YEAR, '2026 年度费用预算（V2 调整版）',
    '生产旺季加班多，生产部上调；销售招待费单列。容忍 5% 内超支自动留痕不拦。',
    'seed', t, t, 'admin', t).lastInsertRowid;

  ['2026-09', '2026-10'].forEach((p) => {
    DEPTS.forEach((d) => {
      insItem.run(v2, d.id, d.name, '6602', '管理费用', p, PLAN_6602[d.id], null, t, t);
    });
    Object.entries(PLAN_6601).forEach(([deptId, amt]) => {
      insItem.run(v2, Number(deptId), B.deptName(Number(deptId)), '6601', '销售费用', p, amt, '招待与推广', t, t);
    });
  });
  B.refreshBudget(v2);
  out.push(`预算 2 版：V1 已关闭（历史）/ V2 生效中（容忍 5%），6 部门 × 2 科目 × 2 个月`);

  // ---------- 2027 编制中（草稿，演示「可以改」的状态） ----------
  const d27 = db.prepare(
    `INSERT INTO budgets (budget_no,fiscal_year,company_id,name,version,status,total_amount,item_count,tolerance_pct,is_current,note,created_by,created_at,updated_at)
     VALUES (?,?,1,?,1,'draft',0,0,0,0,?,?,?,?)`
  ).run('YS2027', 2027, '2027 年度费用预算（编制中）',
    '按 2026 实际 + 8% 编，1-3 月先填，后面逐月补', 'seed', t, t).lastInsertRowid;
  ['2027-01', '2027-02', '2027-03'].forEach((p) => {
    DEPTS.forEach((d) => {
      const base = PLAN_6602[d.id] || 10000;
      insItem.run(d27, d.id, d.name, '6602', '管理费用', p, Math.round(base * 1.08), null, t, t);
    });
    insItem.run(d27, 1, '销售部', '6601', '销售费用', p, Math.round((PLAN_6601[1] || 20000) * 1.08), '招待与推广', t, t);
  });
  B.refreshBudget(d27);
  out.push('2027 年度预算 1 份「编制中」（1-3 月），可编辑演示');

  // ---------- 2026-10 已入账费用（带部门） ----------
  // 生产部：预算 45000，已入账 41900 → 剩 3100，再有一笔就超
  mkPostedExpense({ vno: '记-202610-9001', date: '2026-10-08', deptId: 4, account: '6602', amount: 19800, summary: `生产部水电与耗材 ${TAG}`, payee: '园区物业' });
  mkPostedExpense({ vno: '记-202610-9002', date: '2026-10-15', deptId: 4, account: '6602', amount: 22100, summary: `生产部加班餐费 ${TAG}`, payee: '食堂' });
  // 销售部 6602：预算 26000，已入账 24800 → 95%
  mkPostedExpense({ vno: '记-202610-9003', date: '2026-10-09', deptId: 1, account: '6602', amount: 24800, summary: `销售部差旅 ${TAG}`, payee: '携程商旅' });
  // 销售部 6601：预算 30000，已入账 21500
  mkPostedExpense({ vno: '记-202610-9004', date: '2026-10-12', deptId: 1, account: '6601', amount: 21500, summary: `销售部客户招待 ${TAG}`, payee: '多家餐厅' });
  // 技术部：预算 18000，已入账 6200（花得慢）
  mkPostedExpense({ vno: '记-202610-9005', date: '2026-10-11', deptId: 2, account: '6602', amount: 6200, summary: `技术部样衣面料 ${TAG}`, payee: '面料供应商' });
  // 人事行政：预算 9000，已入账 9800 → 已经超了（超 800）
  mkPostedExpense({ vno: '记-202610-9006', date: '2026-10-06', deptId: 6, account: '6602', amount: 9800, summary: `人事行政办公用品 ${TAG}`, payee: '得力文具' });
  out.push('2026-10 已入账费用 6 张（带部门）：人事行政已超 800，生产部剩 3100，销售部用到 95%');

  // ---------- 已提交未入账的占用 ----------
  const c1 = B.commit({
    department_id: 4, account_code: '6602', period: '2026-10', amount: 2800,
    source_type: 'expense', source_no: '生产部工装采购（待入账）', remark: '已提交，等付款', operator: 'seed'
  });
  B.commit({
    department_id: 1, account_code: '6601', period: '2026-10', amount: 6000,
    source_type: 'expense', source_no: '销售部双十一推广（待入账）', remark: '已提交，等审批', operator: 'seed'
  });
  out.push('待入账占用 2 笔：生产部 2800（占用后只剩 300）、销售部推广 6000');

  // ---------- 超预算特批（留痕） ----------
  const chk1 = B.check({
    department_id: 4, account_code: '6602', period: '2026-10', amount: 3800,
    source_type: 'expense', source_no: '生产部临时工招聘费', operator: 'seed'
  });
  const chk2 = B.check({
    department_id: 4, account_code: '6602', period: '2026-10', amount: 3800,
    source_type: 'expense', source_no: '生产部临时工招聘费', operator: 'seed',
    allow_over: true, over_reason: '旺季急招 20 名临时工，招聘费超出预算，已口头报总经理同意'
  });
  out.push(`超预算判定：正常提交 → ${chk1.ok ? '放行' : '拦住（' + chk1.code + '）'}；填超预算说明后 → ${chk2.ok ? '特批放行' : '仍拦住'}`);

  // ---------- 调整单 ----------
  const adjNo = (n) => `TZ${'20261027'}${String(n).padStart(4, '0')}`;
  db.prepare(
    `INSERT INTO budget_adjustments (adj_no,budget_id,type,from_department_id,from_account_code,to_department_id,to_account_code,period,amount,reason,status,created_by,created_at)
     VALUES (?,?,'transfer',?,?,?,?,?,?,?,'pending',?,?)`
  ).run(adjNo(1), v2, 2, '6602', 4, '6602', '2026-10', 6000,
    '技术部样衣进度提前，本月费用用不完，调剂 6000 给生产部补加班餐费', 'seed', t);

  db.prepare(
    `INSERT INTO budget_adjustments (adj_no,budget_id,type,from_department_id,from_account_code,to_department_id,to_account_code,period,amount,reason,status,created_by,created_at,approved_by,approved_at)
     VALUES (?,?,'increase',NULL,NULL,?,?,?,?,?,'approved',?,?,?,?)`
  ).run(adjNo(2), v2, 1, '6601', '2026-10', 8000,
    '双十一推广加投，销售费用追加 8000（总经理已批）', 'seed', t, 'admin', t);

  // 已批准的那笔立即生效
  const it = db.prepare("SELECT * FROM budget_items WHERE budget_id=? AND department_id=1 AND account_code='6601' AND period='2026-10'").get(v2);
  if (it) db.prepare('UPDATE budget_items SET amount=amount+8000 WHERE id=?').run(it.id);
  B.refreshBudget(v2);
  out.push('调整单 2 笔：1 笔待审批（技术部→生产部调剂 6000）、1 笔已批准（销售费用追加 8000，已生效）');

  return out;
}

if (process.argv.includes('--reset')) { reset(); console.log('[reset] 预算演示数据已清空'); }
const lines = seed();
console.log('\n=== 预算演示数据 ===');
lines.forEach((l) => console.log('·', l));

const ov = B.overview('2026-10');
console.log(`\n2026-10 概览：预算 ${ov.totals.budget}，已用 ${ov.totals.used}（已发生 ${ov.totals.actual} + 占用 ${ov.totals.committed}），执行率 ${ov.totals.used_pct}%，超预算项 ${ov.totals.over_cnt} 个，待确认超支 ${ov.alert_open} 条`);
ov.by_dept.forEach((d) => console.log(`  ${d.department_name.padEnd(6)} 预算 ${String(d.budget).padStart(7)}  已用 ${String(d.used).padStart(7)}  ${d.used_pct}%${d.over_cnt ? '  ⚠ 有超支' : ''}`));
