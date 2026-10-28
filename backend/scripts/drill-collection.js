/**
 * 应收催收全链路演练
 *
 * 走真实 HTTP：生成任务 → 记跟进 → 承诺还款 → 承诺跳票升级 → 部分回款 → 全部回款自动结案
 *
 * ## 为什么必须真跑
 * 这条链最怕的是「看起来有催收，实际上账一分没动」：
 *   - 承诺填了但状态没变
 *   - 钱收到了但任务还挂在业务员名下
 *   - 结案了但发票还欠着
 * 单元测试验不了这三件事连起来对不对。
 *
 * 跑完自动还原（删任务、删收款、发票已付额按核销重算），可重复执行。
 */
const BASE = 'http://127.0.0.1:3000';
const { db } = require('../src/db');
const S = require('../src/services/invoiceStatus');
const C = require('../src/services/collection');

const PASS = process.env.SMOKE_PASS || 'admin123456';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '  [' + extra + ']' : ''}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra || ''}`); }
}
const money = (n) => '¥' + (Number(n) || 0).toFixed(2);

async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, data: json.data };
}
const login = async (u, p) => {
  const r = await req('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
  return r.status === 200 ? r.json.data.token : null;
};
const ymd = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

async function main() {
  console.log('=== 应收催收全链路演练 ===\n');
  const admin = await login('admin', PASS);
  if (!admin) throw new Error('admin 登录失败');
  const sales = await login('sales01', PASS);
  const fin = await login('fin01', PASS);
  console.log(`账号：admin=${!!admin} sales01=${!!sales} fin01=${!!fin}\n`);

  // ---------- 造独立测试样本 ----------
  // 不用现成的演示发票：它们多半已经挂着催收任务（演示数据就是全量生成的），
  // 拿它们做样本会「因为已有任务而跳过」，演练反而跑不起来。
  // 自建一个客户 + 一张逾期 40 天的发票，跑完连客户一起删，跟演示数据完全隔离。
  const TAG = 'DRILLCOL';
  const t0 = new Date().toISOString();
  const cleanupFixture = () => {
    const ivs = db.prepare('SELECT id FROM ar_invoices WHERE bill_no LIKE ?').all(TAG + '%').map((x) => x.id);
    ivs.forEach((id) => {
      db.prepare("DELETE FROM collection_task_items WHERE invoice_id = ?").run(id);
      db.prepare('DELETE FROM ar_invoices WHERE id = ?').run(id);
    });
    db.prepare("DELETE FROM collection_tasks WHERE customer_name LIKE '演练·催收测试客户%'").run();
    db.prepare('DELETE FROM customers WHERE code = ?').run(TAG);
  };
  cleanupFixture();

  const custId = db
    .prepare(
      `INSERT INTO customers (code, name, level, credit_limit, credit_days, credit_status, created_at, updated_at)
       VALUES (?, '演练·催收测试客户', 'B', 200000, 30, 'active', ?, ?)`
    )
    .run(TAG, t0, t0).lastInsertRowid;

  const invId = db
    .prepare(
      `INSERT INTO ar_invoices (bill_no, customer_id, customer_name, currency, amount_orig, rate, amount,
         paid_amount, due_date, status, source, remark, created_at, updated_at)
       VALUES (?, ?, '演练·催收测试客户', 'CNY', 50000, 1, 50000, 0, ?, 'unpaid', 'manual', 'DRILL', ?, ?)`
    )
    .run(TAG + '-INV1', custId, ymd(-40), t0, t0).lastInsertRowid;

  const inv = db.prepare('SELECT * FROM ar_invoices WHERE id = ?').get(invId);
  const open = 50000;
  const before = { paid: 0, status: 'unpaid' };
  console.log(`测试发票：${inv.bill_no}（客户 ${inv.customer_name}）未付 ${money(open)} 到期 ${inv.due_date}（逾期 40 天）\n`);

  const createdTasks = [];
  const createdPays = [];

  try {
    // ---------- 1. 生成任务 ----------
    let r = await req('/api/collections/generate', {
      method: 'POST', token: admin, body: { customer_ids: [inv.customer_id], min_overdue_days: 1 }
    });
    const task = (r.data.created || [])[0];
    if (!task) throw new Error('没生成任务：' + JSON.stringify(r.data.skipped));
    createdTasks.push(task.id);
    ok('按客户生成催收任务', r.status === 200 && !!task.id, `${task.task_no} ${money(task.amount)}`);

    // 幂等：再跑一次应跳过
    r = await req('/api/collections/generate', {
      method: 'POST', token: admin, body: { customer_ids: [inv.customer_id], min_overdue_days: 1 }
    });
    ok('重复生成被跳过（不堆重复单）',
      r.data.summary.created === 0 && r.data.skipped.some((x) => /已有任务/.test(x.reason)),
      JSON.stringify(r.data.summary));

    // 集团内部不催
    const internalId = [...C.internalCustomerIds()][0];
    if (internalId) {
      r = await req('/api/collections/generate', {
        method: 'POST', token: admin, body: { customer_ids: [internalId], min_overdue_days: 1 }
      });
      ok('集团内部往来不生成催收任务（按 intercompany_parties 判断，不按名字猜）',
        r.data.summary.created === 0 && r.data.skipped.some((x) => /集团内部/.test(x.reason)),
        JSON.stringify(r.data.skipped.map((x) => x.reason)));
    }

    // ---------- 2. 详情：欠多少实时算 ----------
    r = await req(`/api/collections/${task.id}`, { token: admin });
    ok('详情里的剩余额 = 发票实时未付（不是快照）',
      Math.abs(Number(r.data.live.remaining) - open) < 0.01, `${r.data.live.remaining} vs ${open}`);
    ok('明细带发票号与逾期天数',
      r.data.items.length >= 1 && r.data.items.every((x) => x.bill_no && x.overdue_days >= 0));

    // ---------- 3. 跟进记录校验 ----------
    r = await req(`/api/collections/${task.id}/log`, {
      method: 'POST', token: admin, body: { channel: 'phone', result: 'promised' }
    });
    ok('「答应付款」不填日期 → 拒', r.status === 400 && /承诺日期/.test(r.json.message || ''),
      (r.json.message || '').slice(0, 36));

    r = await req(`/api/collections/${task.id}/log`, {
      method: 'POST', token: admin, body: { channel: 'phone', result: 'promised', promise_date: ymd(7) }
    });
    ok('「答应付款」不填金额 → 拒（只说下周付等于没承诺）',
      r.status === 400 && /承诺金额/.test(r.json.message || ''), (r.json.message || '').slice(0, 36));

    r = await req(`/api/collections/${task.id}/log`, {
      method: 'POST', token: admin,
      body: { channel: 'phone', result: 'promised', promise_date: ymd(-1), promise_amount: 100 }
    });
    ok('承诺日期早于今天 → 拒（那不是承诺）',
      r.status === 400 && /不能早于今天/.test(r.json.message || ''), (r.json.message || '').slice(0, 36));

    r = await req(`/api/collections/${task.id}/log`, {
      method: 'POST', token: admin,
      body: { channel: 'phone', result: 'promised', promise_date: ymd(5), promise_amount: open + 1000 }
    });
    ok('承诺金额超过未收额 → 拒', r.status === 400 && /超过/.test(r.json.message || ''),
      (r.json.message || '').slice(0, 36));

    r = await req(`/api/collections/${task.id}/log`, {
      method: 'POST', token: admin, body: { channel: 'phone', result: 'dispute' }
    });
    ok('「有争议」不写说明 → 拒（下次接手要知道吵什么）',
      r.status === 400 && /至少 4 个字/.test(r.json.message || ''), (r.json.message || '').slice(0, 36));

    // ---------- 4. 正常记跟进 ----------
    r = await req(`/api/collections/${task.id}/log`, {
      method: 'POST', token: admin,
      body: { channel: 'wechat', contact: '采购 Steve', result: 'promised', promise_date: ymd(5), promise_amount: open, note: '客户确认本月 5 号前付清' }
    });
    ok('记承诺成功，任务变「客户承诺」',
      r.status === 200 && r.data.status === 'promised', `HTTP ${r.status} ${r.data && r.data.status_label}`);
    ok('承诺日期与金额落在任务上',
      r.data.promise_date === ymd(5) && Math.abs(Number(r.data.promise_amount) - open) < 0.01,
      `${r.data.promise_date} / ${r.data.promise_amount}`);
    ok('跟进次数 +1，跟进记录可查',
      Number(r.data.follow_count) === 1 && r.data.logs.length === 1);

    // ---------- 5. 承诺跳票 → 自动升级 ----------
    // 把承诺日改到过去（模拟「承诺日后仍未回款」），再刷新
    db.prepare('UPDATE collection_tasks SET promise_date = ? WHERE id = ?').run(ymd(-3), task.id);
    C.refreshAll();
    const afterRefresh = db.prepare('SELECT status FROM collection_tasks WHERE id = ?').get(task.id).status;
    ok('过了承诺日还没收到钱 → 自动升级为「承诺跳票」', afterRefresh === 'escalated', afterRefresh);

    r = await req(`/api/collections/${task.id}`, { token: admin });
    ok('详情标出「跳票」与逾期天数', r.data.live.promise_broken === true && r.data.live.promise_overdue_days >= 2,
      `${r.data.live.promise_broken} / ${r.data.live.promise_overdue_days} 天`);

    // ---------- 6. 部分回款 → 剩余额减少 ----------
    const partAmount = Math.round(open * 0.4 * 100) / 100;
    let pay = await req('/api/finance/payments', {
      method: 'POST', token: admin,
      body: {
        direction: 'in', partner_id: inv.customer_id, partner_name: inv.customer_name,
        currency: 'CNY', amount: partAmount, pay_date: ymd(0), method: '银行转账',
        remark: 'DRILL-COLLECTION 部分回款',
        allocations: [{ invoice_id: inv.id, amount: partAmount }]
      }
    });
    if (pay.data && pay.data.id) createdPays.push(pay.data.id);
    ok('部分回款登记成功', pay.status === 200, `HTTP ${pay.status} ${pay.json.message || ''}`);

    r = await req(`/api/collections/${task.id}`, { token: admin });
    ok('催收任务的剩余额跟着降（催收与账不脱节）',
      Math.abs(Number(r.data.live.remaining) - (open - partAmount)) < 0.01,
      `${r.data.live.remaining} vs ${(open - partAmount).toFixed(2)}`);
    ok('部分回款不会结案', r.data.status !== 'closed', r.data.status);

    // ---------- 7. 结案校验 ----------
    r = await req(`/api/collections/${task.id}/close`, {
      method: 'POST', token: admin, body: { reason: 'paid' }
    });
    ok('还有钱没收到，不能按「已收回」结案',
      r.status === 400 && /没收到/.test(r.json.message || ''), (r.json.message || '').slice(0, 40));

    // ---------- 8. 全部回款 → 自动结案 ----------
    const rest = Math.round((open - partAmount) * 100) / 100;
    pay = await req('/api/finance/payments', {
      method: 'POST', token: admin,
      body: {
        direction: 'in', partner_id: inv.customer_id, partner_name: inv.customer_name,
        currency: 'CNY', amount: rest, pay_date: ymd(0), method: '银行转账',
        remark: 'DRILL-COLLECTION 尾款',
        allocations: [{ invoice_id: inv.id, amount: rest }]
      }
    });
    if (pay.data && pay.data.id) createdPays.push(pay.data.id);
    ok('尾款回款登记成功', pay.status === 200, `HTTP ${pay.status}`);

    const closed = db.prepare('SELECT * FROM collection_tasks WHERE id = ?').get(task.id);
    ok('钱收齐后催收任务**自动结案**（不用人去点）', closed.status === 'closed', closed.status);
    ok('自动结案的 reason 是 paid 且写了说明',
      closed.closed_reason === 'paid' && /自动结案|回款结清/.test(closed.closed_note || ''),
      `${closed.closed_reason} / ${(closed.closed_note || '').slice(0, 20)}`);

    r = await req(`/api/collections/${task.id}`, { token: admin });
    ok('结案后剩余额为 0，明细都标成已结清',
      Number(r.data.live.remaining) === 0 && r.data.items.every((x) => x.settled));

    // ---------- 9. 核销坏账要写理由 ----------
    const inv2 = db
      .prepare(
        `SELECT * FROM ar_invoices i WHERE ${S.OPEN_SQL} AND i.due_date < ? AND i.customer_id IS NOT NULL
           AND id <> ? ORDER BY id DESC LIMIT 1`
      )
      .get(ymd(0), inv.id);
    if (inv2) {
      let g = await req('/api/collections/generate', {
        method: 'POST', token: admin, body: { customer_ids: [inv2.customer_id], min_overdue_days: 1 }
      });
      const t2 = (g.data.created || [])[0];
      if (t2) {
        createdTasks.push(t2.id);
        r = await req(`/api/collections/${t2.id}/close`, {
          method: 'POST', token: admin, body: { reason: 'bad_debt', note: '坏账' }
        });
        ok('核销坏账说明太短 → 拒（要写清为什么认定收不回）',
          r.status === 400 && /8 个字/.test(r.json.message || ''), (r.json.message || '').slice(0, 36));

        r = await req(`/api/collections/${t2.id}/close`, {
          method: 'POST', token: admin,
          body: { reason: 'bad_debt', note: '客户已停业半年，律师函三次无回应，坏账审批单 BD-26-03' }
        });
        ok('写清理由后可以核销坏账', r.status === 200 && r.data.status === 'closed',
          `HTTP ${r.status} ${r.data && r.data.status_label}`);
        ok('结案原因显示为「核销坏账」', r.data.closed_reason_label === '核销坏账', r.data.closed_reason_label);

        // 重新打开
        r = await req(`/api/collections/${t2.id}/reopen`, {
          method: 'POST', token: admin, body: { reason: '客户恢复营业，答应分期还' }
        });
        ok('结错了可以重新打开（要写原因）',
          r.status === 200 && r.data.status !== 'closed', `HTTP ${r.status} ${r.data && r.data.status}`);
      }
    }

    // ---------- 10. 权限 ----------
    if (sales) {
      r = await req('/api/collections', { token: sales });
      ok('销售能看自己的催收单', r.status === 200, `HTTP ${r.status} 共 ${r.data ? r.data.rows.length : 0} 条`);
      const otherOwner = db
        .prepare("SELECT id FROM collection_tasks WHERE status <> 'closed' AND IFNULL(owner_username,'') <> 'sales01' LIMIT 1")
        .get();
      if (otherOwner) {
        r = await req(`/api/collections/${otherOwner.id}/close`, {
          method: 'POST', token: sales, body: { reason: 'other', note: '销售想自己结案' }
        });
        ok('销售不能结案（会影响应收质量口径）', r.status === 403, `HTTP ${r.status}`);
      }
    }
    if (fin) {
      r = await req('/api/collections/board', { token: fin });
      ok('财务能看逾期台账', r.status === 200, `HTTP ${r.status}`);
    }
    r = await req('/api/collections', {});
    ok('未登录 401', r.status === 401, `HTTP ${r.status}`);
  } finally {
    // ---------- 清理还原 ----------
    console.log('\n--- 清理 ---');
    createdTasks.forEach((tid) => {
      db.prepare('DELETE FROM collection_logs WHERE task_id = ?').run(tid);
      db.prepare('DELETE FROM collection_task_items WHERE task_id = ?').run(tid);
      db.prepare('DELETE FROM collection_tasks WHERE id = ?').run(tid);
    });
    createdPays.forEach((pid) => {
      const allocs = db.prepare('SELECT * FROM payment_allocations WHERE payment_id = ?').all(pid);
      db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?').run(pid);
      db.prepare('DELETE FROM payments WHERE id = ?').run(pid);
      allocs.forEach((a) => S.syncPaidStatus(a.invoice_kind, a.invoice_id));
    });
    const fin2 = db.prepare('SELECT paid_amount, status FROM ar_invoices WHERE id = ?').get(inv.id);
    ok('演练数据已还原（发票已付额与状态回到原值）',
      Math.abs((Number(fin2.paid_amount) || 0) - before.paid) < 0.01 && fin2.status === before.status,
      `${fin2.paid_amount}/${fin2.status} vs ${before.paid}/${before.status}`);
    ok('催收任务已清空', createdTasks.every((tid) => !db.prepare('SELECT 1 x FROM collection_tasks WHERE id = ?').get(tid)),
      `建了 ${createdTasks.length} 张`);
    cleanupFixture();
    ok('测试客户与发票已删净（与演示数据隔离）',
      db.prepare('SELECT COUNT(*) c FROM customers WHERE code = ?').get(TAG).c === 0 &&
        db.prepare('SELECT COUNT(*) c FROM ar_invoices WHERE bill_no LIKE ?').get(TAG + '%').c === 0);
  }

  console.log(`\n=== 结果：通过 ${pass} 项，失败 ${fail} 项 ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('演练异常：', e.message); process.exit(1); });
