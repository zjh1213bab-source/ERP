/**
 * 付款申请单全链路演练
 *
 * 走真实 HTTP：挑发票 → 建草稿 → 占用校验 → 提交 → 自己批（必须被拒）
 *   → 换人批（两级）→ 执行付款 → 验核销与台账 → 清理还原
 *
 * 为什么必须真跑：这条链上每一环都有「看起来对但实际没生效」的可能 ——
 *   提交了但审批实例没建 / 审批过了但状态没变 / 付了款但发票 paid_amount 没回写。
 * 单元测试只能证明函数返回值对，证明不了这三件事连起来是对的。
 *
 * 跑完自动还原（删申请单、删付款、发票已付额按核销重算），可重复执行。
 */
const BASE = 'http://127.0.0.1:3000';
const { db } = require('../src/db');
const S = require('../src/services/invoiceStatus');

const PASS = process.env.SMOKE_PASS || 'admin123456';
const ADMIN_PASS = 'admin123456';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  [' + extra + ']' : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${extra || ''}`);
  }
}
const money = (n) => '¥' + (Number(n) || 0).toFixed(2);

async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, data: json.data };
}

async function login(username, password) {
  const r = await req('/api/auth/login', { method: 'POST', body: { username, password } });
  return r.status === 200 ? r.json.data.token : null;
}

async function main() {
  console.log('=== 付款申请单全链路演练 ===\n');

  const admin = await login('admin', ADMIN_PASS);
  if (!admin) throw new Error('admin 登录失败');
  const fin1 = await login('fin01', PASS);   // 申请人（财务）
  const fin2 = await login('fin02', PASS);   // 另一名财务，批第一级
  const wh = await login('wh01', PASS);      // 出纳，执行付款
  const sales = await login('sales01', PASS);
  console.log(`账号：admin=${!!admin} fin01=${!!fin1} fin02=${!!fin2} wh01=${!!wh}` + '\n');
  if (!fin1 || !fin2 || !wh) throw new Error('缺 fin01/fin02/wh01 账号，无法验证「申请人 ≠ 审批人」');
  // 申请人统一用 fin01：这样 admin 就能批第二级，不用临时造账号
  const applicant = fin1;

  // 找一个有未付发票、且该供应商有 active 银行账户的组合
  const inv = db
    .prepare(
      `SELECT i.*, s.name AS sup_name FROM ap_invoices i
         LEFT JOIN suppliers s ON s.id = i.supplier_id
        WHERE i.status <> 'void' AND i.amount - COALESCE(i.paid_amount,0) > 1000
        ORDER BY i.amount DESC LIMIT 1`
    )
    .get();
  if (!inv) throw new Error('库里没有可用的未付应付发票');
  const acc = db.prepare("SELECT * FROM bank_accounts WHERE status='active' ORDER BY id LIMIT 1").get();
  if (!acc) throw new Error('没有 active 银行账户');

  const before = {
    paid: Number(inv.paid_amount) || 0,
    status: inv.status,
    payableOpen: Number(
      db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ap_invoices WHERE ${S.OPEN_SQL}`).get().s
    )
  };
  console.log(`测试发票：${inv.bill_no}（${inv.sup_name || '无档案'}）未付 ${money(inv.amount - before.paid)}`);
  console.log(`出账账户：${acc.bank_name} ${acc.account_masked}\n`);

  const created = [];
  const payments = [];
  try {
    // ---------- 1. 不能只填金额 ----------
    let r = await req('/api/payment-requests', { method: 'POST', token: applicant, body: { supplier_id: inv.supplier_id, amount: 5000 } });
    ok('只填金额、不挑发票 → 拒（钱出去账上还挂着应付）', r.status === 400, `HTTP ${r.status} ${r.json.message || ''}`);

    // ---------- 2. 建草稿，金额由明细决定 ----------
    r = await req('/api/payment-requests', {
      method: 'POST', token: applicant,
      body: {
        supplier_id: inv.supplier_id,
        items: [{ invoice_id: inv.id, amount: 5000 }],
        plan_pay_date: new Date().toISOString().slice(0, 10),
        method: '银行转账',
        // 刻意不填 bank_account_id：验证「执行付款那一刻必须有账户」
        reason: '演练：核对无误，按合同账期付款'
      }
    });
    ok('建草稿成功', r.status === 200 && r.data && r.data.status === 'draft', `HTTP ${r.status} ${r.json.message || ''}`);
    const id = r.data.id;
    created.push(id);
    ok('金额等于明细合计（不是手填的）', Number(r.data.amount) === 5000, money(r.data.amount));
    ok('草稿带出的明细有发票号', r.data.items.length === 1 && r.data.items[0].bill_no === inv.bill_no);

    // ---------- 3. 占用：同一张票再申请，超出可申额要拒 ----------
    const open = Number(inv.amount) - before.paid;
    r = await req('/api/payment-requests', {
      method: 'POST', token: applicant,
      body: { supplier_id: inv.supplier_id, items: [{ invoice_id: inv.id, amount: open }], reason: '演练：想再申请全额' }
    });
    ok('同一张票被草稿占用后，不能再申请全额', r.status === 400, `HTTP ${r.status} ${(r.json.message || '').slice(0, 50)}`);

    // 可申请额要能看出来（否则用户不知道为什么只能申请这么多）
    r = await req('/api/payment-requests/candidates?supplier_id=' + (inv.supplier_id || 0), { token: admin });
    const cand = (r.data.rows || []).find((x) => x.id === inv.id);
    ok('可申请额 = 未付 − 已占用', cand && Math.abs(cand.available - (open - 5000)) < 0.01 && cand.committed === 5000,
      cand ? `未付 ${cand.open_amount} 占用 ${cand.committed} 可申 ${cand.available}` : '没找到');

    // ---------- 4. 超可申额要拒 ----------
    const overId = (await req('/api/payment-requests', {
      method: 'POST', token: applicant,
      body: { supplier_id: inv.supplier_id, items: [{ invoice_id: inv.id, amount: open - 5000 + 1 }], reason: '演练：超额' }
    })).data;
    if (overId) created.push(overId.id);
    ok('单张申请额不能超过可申请余额', !overId || Number(overId.amount) === open - 5000,
      overId ? money(overId.amount) : '被拒');
    // 上面这条如果建成了（金额等于可申额），说明「取剩余」的语义正确；下面是明确超额
    r = await req('/api/payment-requests', {
      method: 'POST', token: applicant,
      body: { supplier_id: inv.supplier_id, items: [{ invoice_id: inv.id, amount: 99999999 }], reason: '演练：明确超额' }
    });
    ok('明确超额申请被拒且给出可用额', r.status === 400 && /最多可申请/.test(r.json.message || ''), (r.json.message || '').slice(0, 60));

    // ---------- 5. 提交 ----------
    r = await req(`/api/payment-requests/${id}/submit`, { method: 'POST', token: applicant });
    ok('提交成功并生成审批实例', r.status === 200 && r.data.status === 'submitted' && !!r.data.approval_instance_id,
      `HTTP ${r.status} ${r.json.message || ''}`);
    ok('审批流是两级（财务 → 总经理）', r.data.approval && r.data.approval.tasks.length === 2,
      r.data.approval ? r.data.approval.tasks.map((t) => t.step_name).join(' → ') : '无');

    // ---------- 6. 申请人不能自己批 ----------
    const t1 = r.data.approval.tasks[0];
    const t2 = r.data.approval.tasks[1];

    r = await req(`/api/approvals/tasks/${t1.id}/act`, { method: 'POST', token: applicant, body: { approve: true, remark: '我自己批' } });
    ok('申请人不能自己批自己（财务也不行）', r.status === 403, `HTTP ${r.status} ${(r.json.message || '').slice(0, 44)}`);
    ok('被拒后审批任务仍是 pending（没批成也没标错）',
      db.prepare('SELECT status FROM approval_tasks WHERE id = ?').get(t1.id).status === 'pending');

    // admin 是系统里权限最大的账号，绕过它试试 —— 只有「角色对」才该放行
    r = await req(`/api/approvals/tasks/${t2.id}/act`, { method: 'POST', token: applicant, body: { approve: true, remark: '第一级还没批就跳步' } });
    ok('不能跳步（第一级没批就批第二级）', r.status === 400 && /没轮到|当前/.test(r.json.message || ''),
      `HTTP ${r.status} ${(r.json.message || '').slice(0, 40)}`);

    // ---------- 7. 另一名财务批第一级 ----------
    r = await req(`/api/approvals/tasks/${t1.id}/act`, { method: 'POST', token: fin2, body: { approve: true, remark: '演练：金额与合同一致' } });
    ok('换一名财务批第一级成功', r.status === 200 && (r.data || {}).instanceStatus === 'pending',
      `HTTP ${r.status} ${(r.json.message || '').slice(0, 40)}`);

    // 财务不能越级批第二级（那一步要 admin）
    r = await req(`/api/approvals/tasks/${t2.id}/act`, { method: 'POST', token: fin2, body: { approve: true, remark: '演练：越级批' } });
    ok('财务不能越级批总经理那一步', r.status === 400 || r.status === 403, `HTTP ${r.status}`);

    // ---------- 8. admin 批第二级 → 待付款 ----------
    r = await req(`/api/approvals/tasks/${t2.id}/act`, { method: 'POST', token: admin, body: { approve: true, remark: '演练：同意付款' } });
    ok('admin 批第二级，流程通过', r.status === 200 && (r.data || {}).instanceStatus === 'approved',
      `HTTP ${r.status} ${(r.json.message || '').slice(0, 40)}`);

    let after = await req(`/api/payment-requests/${id}`, { token: admin });
    ok('审批通过后变「待付款」，但**还没**生成付款流水',
      after.data.status === 'approved' && !after.data.payment_id,
      `${after.data.status} payment_id=${after.data.payment_id}`);

    // ---------- 9. 执行付款 ----------
    r = await req(`/api/payment-requests/${id}/pay`, { method: 'POST', token: wh, body: {} });
    ok('没给银行账户 → 拒（无账户的流水对不上银行账）', r.status === 400 && /账户/.test(r.json.message || ''),
      `HTTP ${r.status} ${(r.json.message || '').slice(0, 44)}`);

    r = await req(`/api/payment-requests/${id}/pay`, {
      method: 'POST', token: wh,
      body: { bank_account_id: acc.id, pay_date: new Date().toISOString().slice(0, 10), amount: 4321 }
    });
    ok('执行时改金额 → 拒（等于绕过审批）', r.status === 400 && /不一致/.test(r.json.message || ''),
      `HTTP ${r.status} ${(r.json.message || '').slice(0, 40)}`);

    // 草稿状态不能直接付款
    const pre = (await req('/api/payment-requests', {
      method: 'POST', token: applicant,
      body: { supplier_id: inv.supplier_id, items: [{ invoice_id: inv.id, amount: 100 }], reason: '演练：未审批就想付' }
    })).data;
    if (pre) {
      created.push(pre.id);
      r = await req(`/api/payment-requests/${pre.id}/pay`, { method: 'POST', token: wh, body: { bank_account_id: acc.id } });
      ok('没走完审批的单不许付款', r.status === 400 && /待付款/.test(r.json.message || ''),
        `HTTP ${r.status} ${(r.json.message || '').slice(0, 40)}`);
    }

    r = await req(`/api/payment-requests/${id}/pay`, {
      method: 'POST', token: wh,
      body: { bank_account_id: acc.id, pay_date: new Date().toISOString().slice(0, 10), method: '银行转账' }
    });
    ok('出纳执行付款成功', r.status === 200 && !!r.data && r.data.status === 'paid' && !!r.data.payment_id,
      `HTTP ${r.status} ${(r.json.message || '').slice(0, 40)}`);
    if (!r.data || !r.data.payment_id) throw new Error('付款没成功，后续断言跳过：' + (r.json.message || ''));
    payments.push(r.data.payment_id);

    const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(r.data.payment_id);
    ok('付款流水记了申请单号（可追溯）', pay && Number(pay.payment_request_id) === Number(id));
    ok('付款流水带银行账户', pay && Number(pay.bank_account_id) === Number(acc.id));
    ok('付款流水方向是「付」且状态有效', pay && pay.direction === 'out' && pay.status === 'valid', pay && `${pay.direction}/${pay.status}`);

    const invAfter = db.prepare('SELECT * FROM ap_invoices WHERE id = ?').get(inv.id);
    ok('发票已付额回写了（+5000）',
      Math.abs((Number(invAfter.paid_amount) || 0) - (before.paid + 5000)) < 0.01,
      `${before.paid} → ${invAfter.paid_amount}`);
    ok('核销记录已生成',
      db.prepare("SELECT COUNT(*) c FROM payment_allocations WHERE payment_id = ? AND invoice_kind='ap'").get(r.data.payment_id).c === 1);

    const payableAfter = Number(
      db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ap_invoices WHERE ${S.OPEN_SQL}`).get().s
    );
    ok('应付未付总额减少了 5000（台账/资金计划会同步变）',
      Math.abs((before.payableOpen - payableAfter) - 5000) < 0.01,
      `${before.payableOpen} → ${payableAfter}`);

    r = await req(`/api/payment-requests/${id}/pay`, { method: 'POST', token: wh, body: { bank_account_id: acc.id } });
    ok('同一张单不能重复付款', r.status === 400, `HTTP ${r.status} ${(r.json.message || '').slice(0, 30)}`);

    r = await req(`/api/payment-requests/${id}/cancel`, { method: 'POST', token: admin, body: { reason: '演练：已付款的单不该能取消' } });
    ok('已付款的单不能取消（钱出去了要退款/红冲）', r.status === 400 && /已付款/.test(r.json.message || ''),
      `HTTP ${r.status} ${(r.json.message || '').slice(0, 36)}`);

    // ---------- 9. 取消要写原因 ----------
    const c2 = (await req('/api/payment-requests', {
      method: 'POST', token: applicant,
      body: { supplier_id: inv.supplier_id, items: [{ invoice_id: inv.id, amount: 100 }], reason: '演练：待取消' }
    })).data;
    if (c2) {
      created.push(c2.id);
      r = await req(`/api/payment-requests/${c2.id}/cancel`, { method: 'POST', token: applicant, body: { reason: '不' } });
      ok('取消要写原因（太短被拒）', r.status === 400, `HTTP ${r.status}`);
      r = await req(`/api/payment-requests/${c2.id}/cancel`, { method: 'POST', token: applicant, body: { reason: '演练：金额填错了，撤回重开' } });
      ok('取消成功并释放占用', r.status === 200 && r.data.status === 'cancelled', `HTTP ${r.status}`);
      // 注意：只验「这一张被取消的单」不再占额度。
      // 上面那张 submitted 的单还在占用，不能拿发票的总占用去断言 0
      const still = db.prepare(
        "SELECT status FROM payment_requests WHERE id = ?"
      ).get(c2.id).status;
      const cm = db.prepare(
        "SELECT COUNT(*) c FROM payment_request_items i JOIN payment_requests r ON r.id=i.request_id WHERE i.request_id = ? AND r.status IN ('draft','submitted','approved')"
      ).get(c2.id).c;
      ok('取消后这张单的额度不再被占用', still === 'cancelled' && cm === 0, `状态 ${still} 占用明细 ${cm} 条`);
    }

    // ---------- 10. 权限 ----------
    if (sales) {
      r = await req('/api/payment-requests', { token: sales });
      ok('销售看不到付款申请（欠谁钱、什么时候付是敏感信息）', r.status === 403, `HTTP ${r.status}`);
    }
    r = await req('/api/payment-requests', {});
    ok('未登录 401', r.status === 401, `HTTP ${r.status}`);
    r = await req(`/api/payment-requests/${id}/pay`, { method: 'POST', token: sales, body: { bank_account_id: acc.id } });
    ok('销售不能执行付款', r.status === 403, `HTTP ${r.status}`);
  } finally {
    // ---------- 清理还原 ----------
    console.log('\n--- 清理 ---');
    const delPay = (pid) => {
      const allocs = db.prepare('SELECT * FROM payment_allocations WHERE payment_id = ?').all(pid);
      db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?').run(pid);
      db.prepare('DELETE FROM payments WHERE id = ?').run(pid);
      allocs.forEach((a) => S.syncPaidStatus(a.invoice_kind, a.invoice_id));
    };
    payments.forEach(delPay);
    // 申请单里生成过付款的也一并还原
    created.forEach((cid) => {
      const row = db.prepare('SELECT payment_id FROM payment_requests WHERE id = ?').get(cid);
      if (row && row.payment_id && !payments.includes(row.payment_id)) delPay(row.payment_id);
      const instIds = db.prepare("SELECT id FROM approval_instances WHERE target_type='payment' AND target_id=?").all(cid).map((x) => x.id);
      instIds.forEach((i) => {
        db.prepare('DELETE FROM approval_tasks WHERE instance_id = ?').run(i);
        db.prepare('DELETE FROM approval_instances WHERE id = ?').run(i);
      });
      db.prepare('DELETE FROM payment_request_items WHERE request_id = ?').run(cid);
      db.prepare('DELETE FROM payment_requests WHERE id = ?').run(cid);
    });
    try { db.prepare("DELETE FROM users WHERE username = 'apdeputy'").run(); } catch (e) { /* 没有就算了 */ }

    const invFinal = db.prepare('SELECT paid_amount, status FROM ap_invoices WHERE id = ?').get(inv.id);
    const okRestore =
      Math.abs((Number(invFinal.paid_amount) || 0) - before.paid) < 0.01 && invFinal.status === before.status;
    ok('演练数据已还原（发票已付额与状态回到原值）', okRestore,
      `${invFinal.paid_amount}/${invFinal.status} vs ${before.paid}/${before.status}`);
    ok('申请单已清空', db.prepare('SELECT COUNT(*) c FROM payment_requests').get().c === 0,
      String(db.prepare('SELECT COUNT(*) c FROM payment_requests').get().c));
  }

  console.log(`\n=== 结果：通过 ${pass} 项，失败 ${fail} 项 ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('演练异常：', e.message);
  process.exit(1);
});
