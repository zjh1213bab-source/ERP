/**
 * 付款申请单演示数据
 *
 * 造四张单，覆盖四种状态（页面一眼能看到全流程长什么样）：
 *   1. 草稿     —— 已占额度，还没提交
 *   2. 审批中   —— 停在第一级财务审核
 *   3. 待付款   —— 两级都批了，等出纳按付款
 *   4. 已付款   —— 走完整条链，发票已核销（这条会真改 ap_invoices，reset 时还原）
 *
 * 状态不是直接 UPDATE 出来的，而是**真跑了 submit / actTask / pay** ——
 * 手改状态造出来的数据，页面能显示但流程一走就露馅（任务表对不上）。
 *
 * 用法：node scripts/seed-payment-request-demo.js [--reset]
 */
const { db, now } = require('../src/db');
const PR = require('../src/services/paymentRequest');
const approvals = require('../src/services/approvals');
const S = require('../src/services/invoiceStatus');

const RESET = process.argv.includes('--reset');
const TAG = '演示·';
const t = now();

function cleanup() {
  const reqs = db.prepare("SELECT * FROM payment_requests WHERE IFNULL(reason,'') LIKE ?").all(TAG + '%');
  const payIds = [];
  reqs.forEach((r) => {
    if (r.payment_id) payIds.push(r.payment_id);
    const insts = db
      .prepare("SELECT id FROM approval_instances WHERE target_type='payment' AND target_id=?")
      .all(r.id)
      .map((x) => x.id);
    insts.forEach((i) => {
      db.prepare('DELETE FROM approval_tasks WHERE instance_id = ?').run(i);
      db.prepare('DELETE FROM approval_instances WHERE id = ?').run(i);
    });
    db.prepare('DELETE FROM payment_request_items WHERE request_id = ?').run(r.id);
    db.prepare('DELETE FROM payment_requests WHERE id = ?').run(r.id);
  });
  payIds.forEach((pid) => {
    const allocs = db.prepare('SELECT * FROM payment_allocations WHERE payment_id = ?').all(pid);
    db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?').run(pid);
    db.prepare('DELETE FROM payments WHERE id = ?').run(pid);
    // 已付额按剩余核销重算，把发票状态还原
    allocs.forEach((a) => S.syncPaidStatus(a.invoice_kind, a.invoice_id));
  });
  return { reqs: reqs.length, pays: payIds.length };
}

function main() {
  const before = cleanup();
  console.log(`清理旧演示数据：${before.reqs} 张申请单 / ${before.pays} 笔付款\n`);
  if (RESET && process.argv.length <= 2) {
    console.log('（--reset 只清理不重建）');
    return;
  }

  const fin1 = { username: 'fin01', role: 'finance' };
  const fin2 = { username: 'fin02', role: 'finance' };
  const boss = { username: 'admin', role: 'admin' };
  const cashier = { username: 'wh01', role: 'warehouse' };
  const acc = db.prepare("SELECT * FROM bank_accounts WHERE status='active' ORDER BY id LIMIT 1").get();
  if (!acc) throw new Error('没有 active 银行账户，先建一个再跑');

  // 挑几家有未付发票的供应商
  const sups = db
    .prepare(
      `SELECT i.supplier_id, i.supplier_name, COUNT(*) n,
              SUM(i.amount - COALESCE(i.paid_amount,0)) open
         FROM ap_invoices i
        WHERE i.status <> 'void' AND i.amount - COALESCE(i.paid_amount,0) > 1000
          AND i.supplier_id IS NOT NULL
        GROUP BY i.supplier_id
        HAVING open > 5000
        ORDER BY open DESC
        LIMIT 4`
    )
    .all();
  if (!sups.length) throw new Error('没有可用的未付应付发票');

  const invOf = (supplierId, min) =>
    db
      .prepare(
        `SELECT * FROM ap_invoices
          WHERE supplier_id = ? AND status <> 'void' AND amount - COALESCE(paid_amount,0) >= ?
          ORDER BY IFNULL(due_date, created_at) ASC, id ASC LIMIT 1`
      )
      .get(supplierId, min);

  const made = [];

  // ---------- 1. 草稿 ----------
  {
    const s = sups[0];
    const inv = invOf(s.supplier_id, 8000);
    if (inv) {
      const amount = Math.min(20000, Math.round((Number(inv.amount) - Number(inv.paid_amount)) * 0.3));
      const r = PR.create(
        {
          supplier_id: s.supplier_id,
          items: [{ invoice_id: inv.id, amount }],
          plan_pay_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
          method: '银行转账',
          reason: `${TAG}发票已核对无误，按合同账期申请付款（草稿待提交）`
        },
        fin1
      );
      made.push({ id: r.id, state: 'draft', no: r.req_no, amount: r.amount });
    }
  }

  // ---------- 2. 审批中（停在第一级） ----------
  {
    const s = sups[1] || sups[0];
    const inv = invOf(s.supplier_id, 20000);
    if (inv) {
      const open = Number(inv.amount) - Number(inv.paid_amount);
      const amount = Math.min(60000, Math.round(open * 0.5));
      const r = PR.create(
        {
          supplier_id: s.supplier_id,
          items: [{ invoice_id: inv.id, amount }],
          plan_pay_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
          method: '电汇',
          reason: `${TAG}月结到期，供应商已催款两次，申请本周内付清本批`
        },
        fin1
      );
      PR.submit(r.id, fin1);
      made.push({ id: r.id, state: 'submitted', no: r.req_no, amount: r.amount, supplier: s.supplier_name });
    }
  }

  // ---------- 3. 待付款（两级都批了） ----------
  {
    const s = sups[2] || sups[0];
    const inv = invOf(s.supplier_id, 15000);
    if (inv) {
      const open = Number(inv.amount) - Number(inv.paid_amount);
      const amount = Math.min(35000, Math.round(open * 0.4));
      const r = PR.create(
        {
          supplier_id: s.supplier_id,
          items: [{ invoice_id: inv.id, amount }],
          plan_pay_date: new Date(Date.now() + 1 * 86400000).toISOString().slice(0, 10),
          method: '银行转账',
          reason: `${TAG}已收到货并验收合格，财务与总经理均已同意，待出纳安排出账`
        },
        fin1
      );
      PR.submit(r.id, fin1);
      const det = PR.detail(r.id);
      const t1 = det.approval.tasks.find((x) => x.step_no === 1);
      const t2 = det.approval.tasks.find((x) => x.step_no === 2);
      approvals.actTask(t1.id, true, '金额与合同一致，发票已验真', fin2);
      approvals.actTask(t2.id, true, '同意，按计划出账', boss);
      made.push({ id: r.id, state: 'approved', no: r.req_no, amount: r.amount, supplier: s.supplier_name });
    }
  }

  // ---------- 4. 已付款（走完整条链） ----------
  {
    const s = sups[3] || sups[0];
    const inv = invOf(s.supplier_id, 10000);
    if (inv) {
      const open = Number(inv.amount) - Number(inv.paid_amount);
      const amount = Math.min(25000, Math.round(open * 0.25));
      const r = PR.create(
        {
          supplier_id: s.supplier_id,
          items: [{ invoice_id: inv.id, amount }],
          plan_pay_date: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
          method: '银行转账',
          reason: `${TAG}上周已审批通过，出纳昨日完成出账（示例：已付款的单长什么样）`
        },
        fin1
      );
      PR.submit(r.id, fin1);
      const det = PR.detail(r.id);
      approvals.actTask(det.approval.tasks.find((x) => x.step_no === 1).id, true, '核对无误', fin2);
      approvals.actTask(det.approval.tasks.find((x) => x.step_no === 2).id, true, '同意付款', boss);
      const paid = PR.pay(
        r.id,
        {
          bank_account_id: acc.id,
          pay_date: new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10),
          method: '银行转账'
        },
        cashier
      );
      made.push({
        id: r.id,
        state: 'paid',
        no: r.req_no,
        amount: r.amount,
        supplier: s.supplier_name,
        pay_no: paid.pay_no
      });
    }
  }

  console.log('=== 生成的演示单 ===');
  made.forEach((m) => {
    console.log(
      `  ${m.no}  ${String(m.state).padEnd(10)} ${String(m.supplier || '').slice(0, 16).padEnd(18)} ¥${m.amount}` +
        (m.pay_no ? `  → ${m.pay_no}` : '')
    );
  });

  const st = PR.stats();
  console.log(
    `\n汇总：草稿 ${st.draft.count} / 审批中 ${st.submitted.count} / 待付款 ${st.approved.count} / 已付款 ${st.paid.count}`
  );
  console.log(`已申请未付合计 ¥${st.pipeline_amount}（资金计划要预留这笔钱）`);
  console.log(`占用发票额度 ¥${st.committed_amount}`);
}

main();
