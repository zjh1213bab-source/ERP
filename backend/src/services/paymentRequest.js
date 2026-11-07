/**
 * 付款申请单
 * ============================================================
 * 解决的问题：现在付款是在「往来账」页直接登记一笔 payments ——
 * 填金额、勾发票、点确定，钱就出去了，**没有任何人事先批过**。
 * 出纳可以付，销售改权限也能付，事后账上只多一条流水。
 *
 * ## 五条硬规则（都是为了「钱」这件事不出岔子）
 *
 * 1. **金额不许手填**：申请单的金额 = 明细合计。想付 5 万就勾出 5 万的发票。
 *    允许填一个总数，就一定出现「钱付了、账上应付还挂着」的烂账。
 *
 * 2. **同一张发票不许重复申请**：未完成的申请（draft/submitted/approved）
 *    会**占用**该发票的未付额。占用额 = 明细金额，已付额另算。
 *    否则两个人各申请一次，同一张票能付两遍。
 *
 * 3. **审批通过 ≠ 已付**：approved 之后还要出纳「执行付款」。
 *    钱出门是独立动作，中间隔几天很正常（等资金到位、等票据）。合成一步，
 *    就等于审批一通过钱就自动划走，没人敢用。
 *
 * 4. **不许自己批自己**：申请人和审批人必须是不同账号（admin 也不例外）。
 *    这不是流程洁癖 —— 付款是唯一能把钱搬出公司的动作，
 *    一个账号能自己申请自己批，等于没有审批。
 *
 * 5. **执行付款必须指定银行账户**：没有账户的流水永远对不上银行账。
 *
 * ## 状态机
 *   draft    → 可改、可删（草稿占了额度，页面上会标出来）
 *   submitted→ 审批中（已生成 approval_instance）
 *   approved → 已批准，待付款（此时仍占用额度）
 *   paid     → 已付款（生成 payments + 核销，占用解除）
 *   draft    ← 被驳回会退回来（不是作废，改完能再提交）
 *   cancelled→ 申请人撤回 / 财务作废（占用解除）
 */
const { db, now } = require('../db');
const { nextNo } = require('../utils/docNo');
const { PAY_VALID } = require('./paymentStatus');
const S = require('./invoiceStatus');
const approvals = require('./approvals');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/** 业务错误：带 400，路由层直接透传（不写 status 会变成 500） */
function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/** 未完结的状态 = 占用发票额度 */
const OPEN_STATUS = ['draft', 'submitted', 'approved'];

const STATUS_LABEL = {
  draft: '草稿',
  submitted: '审批中',
  approved: '待付款',
  paid: '已付款',
  cancelled: '已取消'
};

/* ------------------------------------------------------------------ *
 * 占用：某张应付发票被「未完成的申请单」占掉多少
 * ------------------------------------------------------------------ */

/**
 * @param {number[]} [invoiceIds] 只算这几张（不传则算全部）
 * @returns {Map<number, {amount:number, items:Array}>} invoice_id → 占用情况
 */
function committedMap(invoiceIds) {
  const where = [`r.status IN (${OPEN_STATUS.map(() => '?').join(',')})`];
  const params = [...OPEN_STATUS];
  if (Array.isArray(invoiceIds) && invoiceIds.length) {
    where.push(`i.invoice_id IN (${invoiceIds.map(() => '?').join(',')})`);
    params.push(...invoiceIds.map(Number));
  }
  const rows = db
    .prepare(
      `SELECT i.invoice_id, i.amount, i.request_id, r.req_no, r.status, r.created_by
         FROM payment_request_items i
         JOIN payment_requests r ON r.id = i.request_id
        WHERE ${where.join(' AND ')}`
    )
    .all(...params);

  const map = new Map();
  rows.forEach((x) => {
    const k = Number(x.invoice_id);
    if (!map.has(k)) map.set(k, { amount: 0, items: [] });
    const e = map.get(k);
    e.amount = r2(e.amount + (Number(x.amount) || 0));
    e.items.push({ request_id: x.request_id, req_no: x.req_no, status: x.status, created_by: x.created_by, amount: r2(x.amount) });
  });
  return map;
}

/* ------------------------------------------------------------------ *
 * 可申请的发票（给「新建申请」页挑单用）
 * ------------------------------------------------------------------ */

/**
 * 列出可申请的应付发票
 *
 * 「可申请额」= 未付余额 − 已被其他未完成申请占用的额。
 * 这个数必须**算给你看**，否则用户会问「为什么这张票只能申请 3 万，
 * 我明明欠他 10 万」—— 因为另外 7 万已经在另一张申请单里了。
 */
/** 付款核对依据只取实际采购/生产/验收单据，工序模板的外发标识不参与。 */
function productionBasis(invoice) {
  if(!invoice.purchase_id) return {source:'invoice',purchase:null,order:null,dispatches:[],receipts:[],payment_terms:null};
  const purchase=db.prepare('SELECT id,po_no,order_id,status,supplier_id FROM purchase_orders WHERE id=?').get(invoice.purchase_id);
  if(!purchase)return {source:'missing_purchase',purchase:null,order:null,dispatches:[],receipts:[],payment_terms:null};
  const order=purchase.order_id ? db.prepare('SELECT id,order_no,status FROM orders WHERE id=?').get(purchase.order_id) : null;
  const dispatches=order ? db.prepare("SELECT id,factory_name,type,qty,status FROM dispatch_orders WHERE order_id=? AND status<>'cancelled' ORDER BY id").all(order.id) : [];
  const receipts=db.prepare("SELECT id,grn_no,receive_date,status,receive_qty,pass_qty,reject_qty FROM goods_receipts WHERE po_id=? AND status<>'cancelled' ORDER BY id").all(purchase.id);
  const supplier=invoice.supplier_id ? db.prepare('SELECT payment_terms,term_days FROM suppliers WHERE id=?').get(invoice.supplier_id) : null;
  return {source:'purchase',purchase,order,dispatches,receipts,payment_terms:supplier?.payment_terms || null,term_days:supplier?.term_days ?? null};
}

function candidates(q = {}) {
  const where = [`${S.OPEN_SQL}`];
  const params = [];
  if (q.supplier_id) {
    where.push('supplier_id = ?');
    params.push(Number(q.supplier_id));
  }
  if (q.q) {
    where.push('(bill_no LIKE ? OR IFNULL(supplier_name,\'\') LIKE ?)');
    const k = `%${q.q}%`;
    params.push(k, k);
  }

  const rows = db
    .prepare(
      `SELECT id, bill_no, supplier_id, supplier_name, currency, amount, paid_amount,
              due_date, status, created_at, purchase_id
         FROM ap_invoices
        WHERE ${where.join(' AND ')}
        ORDER BY IFNULL(due_date, created_at) ASC, id ASC
        LIMIT 500`
    )
    .all(...params);

  const cm = committedMap(rows.map((r) => r.id));
  const out = rows.map((r) => {
    const open = r2((Number(r.amount) || 0) - (Number(r.paid_amount) || 0));
    const c = cm.get(Number(r.id)) || { amount: 0, items: [] };
    const avail = r2(Math.max(0, open - c.amount));
    const overdueDays = r.due_date
      ? Math.max(0, Math.floor((Date.parse(today() + 'T00:00:00') - Date.parse(String(r.due_date).slice(0, 10) + 'T00:00:00')) / 86400000))
      : null;
    return {
      id: r.id,
      bill_no: r.bill_no,
      supplier_id: r.supplier_id,
      supplier_name: r.supplier_name,
      currency: r.currency || 'CNY',
      amount: r2(r.amount),
      paid_amount: r2(r.paid_amount),
      open_amount: open,
      committed: c.amount,
      committed_by: c.items,
      available: avail,
      due_date: r.due_date,
      overdue_days: overdueDays,
      status: r.status,
      created_at: r.created_at,
      // 全部被占满的票在页面上要能看出来（不然点了才发现申请不了）
      production_basis: productionBasis(r),
      fully_committed: avail <= 0.005
    };
  });
  return {
    rows: out,
    summary: {
      count: out.length,
      open_total: r2(out.reduce((a, x) => a + x.open_amount, 0)),
      committed_total: r2(out.reduce((a, x) => a + x.committed, 0)),
      available_total: r2(out.reduce((a, x) => a + x.available, 0)),
      fully_committed_count: out.filter((x) => x.fully_committed).length
    }
  };
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

function list(q = {}) {
  const where = [];
  const params = [];
  if (q.status) {
    const arr = String(q.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (arr.length) {
      where.push(`r.status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
  }
  if (q.supplier_id) {
    where.push('r.supplier_id = ?');
    params.push(Number(q.supplier_id));
  }
  if (q.mine === '1' && q.username) {
    where.push('r.created_by = ?');
    params.push(q.username);
  }
  if (q.q) {
    where.push("(r.req_no LIKE ? OR IFNULL(r.supplier_name,'') LIKE ? OR IFNULL(r.reason,'') LIKE ?)");
    const k = `%${q.q}%`;
    params.push(k, k, k);
  }
  const sql = `SELECT r.*, 
      (SELECT COUNT(*) FROM payment_request_items i WHERE i.request_id = r.id) AS item_count,
      pr.pay_no, pr.pay_date
    FROM payment_requests r
    LEFT JOIN payments pr ON pr.id = r.payment_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.id DESC LIMIT 200`;
  const rows = db.prepare(sql).all(...params).map((r) => ({
    ...r,
    status_label: STATUS_LABEL[r.status] || r.status
  }));

  // 摘要直接用 stats()，**不再自己算一遍** ——
  // 之前列表摘要叫 unpaid_amount、统计接口叫 pipeline_amount，
  // 前端两个都读，结果页面上「已申请未付合计」永远显示 0
  return { rows, summary: { ...stats(), total: rows.length } };
}

function detail(id) {
  const req = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
  if (!req) throw bad('付款申请单不存在', 404);
  const items = db
    .prepare(
      `SELECT i.*, inv.status AS invoice_status, inv.amount AS invoice_amount,
              inv.paid_amount AS invoice_paid
         FROM payment_request_items i
         LEFT JOIN ap_invoices inv ON inv.id = i.invoice_id
        WHERE i.request_id = ?
        ORDER BY i.id`
    )
    .all(id)
    .map((x) => ({
      ...x,
      open_now: x.invoice_amount === null ? null : r2((Number(x.invoice_amount) || 0) - (Number(x.invoice_paid) || 0))
    }));
  const progress = approvals.progressOf('payment', Number(id));
  const payment = req.payment_id ? db.prepare('SELECT * FROM payments WHERE id = ?').get(req.payment_id) : null;
  const account = req.bank_account_id
    ? db.prepare('SELECT id, bank_name, account_masked, currency FROM bank_accounts WHERE id = ?').get(req.bank_account_id)
    : null;
  return {
    ...req,
    status_label: STATUS_LABEL[req.status] || req.status,
    items,
    items_total: r2(items.reduce((a, x) => a + (Number(x.amount) || 0), 0)),
    approval: progress,
    payment: payment
      ? { id: payment.id, pay_no: payment.pay_no, pay_date: payment.pay_date, amount: payment.amount, status: payment.status }
      : null,
    bank_account: account || null
  };
}

/* ------------------------------------------------------------------ *
 * 新建 / 修改
 * ------------------------------------------------------------------ */

/**
 * 校验并整理明细
 *
 * 这里刻意不接收 `amount`：金额由明细加总得出。
 * 允许传 amount 就等于允许「申请 10 万但只核销 6 万」，
 * 剩下 4 万会变成付了但没销账的孤立款 —— 对账时最难查的就是这种。
 */
function normalizeItems(rawItems, supplierId, excludeRequestId) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw bad('至少要挑一张发票 —— 付款申请必须绑到具体单据上，不许只填个金额');
  }
  const seen = new Set();
  const out = [];
  rawItems.forEach((x) => {
    const invoiceId = Number(x && x.invoice_id);
    if (!invoiceId) throw bad('明细里有空的发票行');
    if (seen.has(invoiceId)) throw bad(`发票 #${invoiceId} 在同一张申请单里重复出现`);
    seen.add(invoiceId);

    const inv = db.prepare('SELECT * FROM ap_invoices WHERE id = ?').get(invoiceId);
    if (!inv) throw bad(`发票 #${invoiceId} 不存在`);
    if (String(inv.status) === 'void') throw bad(`发票 ${inv.bill_no} 已作废，不能申请付款`);
    if (supplierId && Number(inv.supplier_id) !== Number(supplierId)) {
      throw bad(`发票 ${inv.bill_no} 不属于这个供应商 —— 一张申请单只能给一个供应商`);
    }
    const open = r2((Number(inv.amount) || 0) - (Number(inv.paid_amount) || 0));
    if (open <= 0.005) throw bad(`发票 ${inv.bill_no} 已经付清了，不用再申请`);

    // 占用：排除自己（改草稿时，自己已占的额度不能算成别人占的）
    const cm = committedMap([invoiceId]);
    let committed = cm.get(invoiceId) ? cm.get(invoiceId).amount : 0;
    if (excludeRequestId) {
      const own = db
        .prepare('SELECT COALESCE(SUM(amount),0) s FROM payment_request_items WHERE request_id = ? AND invoice_id = ?')
        .get(excludeRequestId, invoiceId).s;
      committed = r2(committed - (Number(own) || 0));
    }
    const avail = r2(open - committed);
    if (avail <= 0.005) {
      const who = (cm.get(invoiceId) ? cm.get(invoiceId).items : [])
        .filter((i) => !excludeRequestId || i.request_id !== Number(excludeRequestId))
        .map((i) => `${i.req_no}(${i.status})`)
        .join('、');
      throw bad(`发票 ${inv.bill_no} 的未付额已被其他申请单占用（${who || '—'}），没有可申请余额`);
    }

    const want = x.amount === undefined || x.amount === null || x.amount === '' ? avail : r2(x.amount);
    if (want <= 0.005) throw bad(`发票 ${inv.bill_no} 的申请金额必须大于 0`);
    if (want > avail + 0.005) {
      throw bad(
        `发票 ${inv.bill_no} 最多可申请 ${avail}（未付 ${open}${committed > 0.005 ? `，已被其他申请占用 ${committed}` : ''}），不能申请 ${want}`
      );
    }

    out.push({
      invoice_id: invoiceId,
      bill_no: inv.bill_no,
      due_date: inv.due_date || null,
      open_amount: open,
      amount: want,
      currency: inv.currency || 'CNY'
    });
  });

  const currencies = [...new Set(out.map((x) => x.currency))];
  if (currencies.length > 1) throw bad(`明细里有多种币种（${currencies.join('、')}），一张申请单只能一种币`);

  return out;
}

function create(payload, user) {
  const b = payload || {};
  const items = normalizeItems(b.items, b.supplier_id, null);
  const total = r2(items.reduce((a, x) => a + x.amount, 0));
  const supplierId = Number(b.supplier_id) || Number(
    db.prepare('SELECT supplier_id FROM ap_invoices WHERE id = ?').get(items[0].invoice_id).supplier_id
  ) || null;
  const supplier = supplierId
    ? db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(supplierId)
    : null;
  const supplierName = supplier ? supplier.name : (
    db.prepare('SELECT supplier_name FROM ap_invoices WHERE id = ?').get(items[0].invoice_id).supplier_name || null
  );

  const t = now();
  db.exec('BEGIN');
  try {
    const reqNo = nextNo('FKSQ', 'payment_requests', 'req_no');
    const info = db
      .prepare(
        `INSERT INTO payment_requests
           (req_no, supplier_id, supplier_name, amount, currency, plan_pay_date, method,
            bank_account_id, status, reason, remark, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?, 'draft', ?,?,?,?,?)`
      )
      .run(
        reqNo, supplierId, supplierName, total, items[0].currency,
        b.plan_pay_date || today(), b.method || '银行转账',
        b.bank_account_id ? Number(b.bank_account_id) : null,
        b.reason || null, b.remark || null, user.username, t, t
      );
    const id = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO payment_request_items (request_id, invoice_id, bill_no, due_date, open_amount, amount, created_at)
       VALUES (?,?,?,?,?,?,?)`
    );
    items.forEach((x) => ins.run(id, x.invoice_id, x.bill_no, x.due_date, x.open_amount, x.amount, t));

    db.exec('COMMIT');
    return detail(id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 改草稿：只允许 draft，改完明细重算金额（金额永远由明细决定） */
function update(id, payload, user) {
  const req = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
  if (!req) throw bad('付款申请单不存在', 404);
  if (req.status !== 'draft') {
    throw bad(`只有草稿能改，这张单现在是「${STATUS_LABEL[req.status] || req.status}」`);
  }
  const b = payload || {};
  const items = normalizeItems(b.items, b.supplier_id || req.supplier_id, Number(id));
  const total = r2(items.reduce((a, x) => a + x.amount, 0));

  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE payment_requests
          SET amount=?, currency=?, plan_pay_date=?, method=?, bank_account_id=?, reason=?, remark=?, updated_at=?
        WHERE id=?`
    ).run(
      total, items[0].currency,
      b.plan_pay_date || req.plan_pay_date, b.method || req.method,
      b.bank_account_id === undefined ? req.bank_account_id : (b.bank_account_id ? Number(b.bank_account_id) : null),
      b.reason === undefined ? req.reason : b.reason,
      b.remark === undefined ? req.remark : b.remark,
      t, id
    );
    db.prepare('DELETE FROM payment_request_items WHERE request_id = ?').run(id);
    const ins = db.prepare(
      `INSERT INTO payment_request_items (request_id, invoice_id, bill_no, due_date, open_amount, amount, created_at)
       VALUES (?,?,?,?,?,?,?)`
    );
    items.forEach((x) => ins.run(id, x.invoice_id, x.bill_no, x.due_date, x.open_amount, x.amount, t));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return detail(id);
}

/* ------------------------------------------------------------------ *
 * 提交 → 审批 → 付款
 * ------------------------------------------------------------------ */

function submit(id, user) {
  const req = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
  if (!req) throw bad('付款申请单不存在', 404);
  if (req.status !== 'draft') throw bad(`只有草稿能提交，现在是「${STATUS_LABEL[req.status]}」`);
  if (!(Number(req.amount) > 0)) throw bad('金额为 0，不能提交');

  const items = db.prepare('SELECT * FROM payment_request_items WHERE request_id = ?').all(id);
  if (!items.length) throw bad('没有明细，不能提交');

  const t = now();
  db.exec('BEGIN');
  try {
    // 提交前重新校验一次占用：从建草稿到提交之间，别人可能已经申请了同一张票
    const ids = items.map((x) => x.invoice_id);
    const cm = committedMap(ids);
    items.forEach((it) => {
      const inv = db.prepare('SELECT * FROM ap_invoices WHERE id = ?').get(it.invoice_id);
      if (!inv || String(inv.status) === 'void') throw bad(`发票 ${it.bill_no} 已不存在或已作废`);
      const open = r2((Number(inv.amount) || 0) - (Number(inv.paid_amount) || 0));
      const others = r2(((cm.get(Number(it.invoice_id)) || {}).amount || 0) - (Number(it.amount) || 0));
      if (Number(it.amount) > r2(open - others) + 0.005) {
        throw bad(
          `发票 ${it.bill_no} 的未付额已被别的申请单占用，本单申请 ${it.amount} 超出可申请余额 ${r2(open - others)}，请先调整明细`
        );
      }
    });

    const iid = approvals.ensureInstance('payment', Number(id), Number(req.amount));
    db.prepare(
      "UPDATE payment_requests SET status='submitted', submitted_at=?, approval_instance_id=?, updated_at=? WHERE id=?"
    ).run(t, iid, t, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return detail(id);
}

/** 撤回 / 作废：申请人撤回自己的草稿/审批中；财务可作废已批准未付的 */
function cancel(id, reason, user) {
  const req = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
  if (!req) throw bad('付款申请单不存在', 404);
  if (req.status === 'paid') throw bad('已付款的申请单不能取消（钱已经出去了，要退只能走退款/红冲）');
  if (req.status === 'cancelled') throw bad('这张单已经取消过了');
  if (!reason || String(reason).trim().length < 4) {
    throw bad('取消要写原因（至少 4 个字）—— 谁撤的、为什么撤，事后要能查');
  }
  const isOwner = req.created_by === user.username;
  const canForce = ['admin', 'finance'].includes(user.role);
  if (!isOwner && !canForce) throw bad('只有申请人本人或财务能取消', 403);
  if (req.status === 'approved' && !canForce) {
    throw bad('已经批下来的单要取消，得财务或管理员来', 403);
  }

  const t = now();
  db.exec('BEGIN');
  try {
    // 审批实例一并终止，否则待办里会一直挂着这条
    if (req.approval_instance_id) {
      db.prepare(
        "UPDATE approval_tasks SET status='cancelled', remark=?, acted_at=? WHERE instance_id=? AND status='pending'"
      ).run(`单已取消：${reason}`, t, req.approval_instance_id);
      db.prepare("UPDATE approval_instances SET status='cancelled' WHERE id=? AND status='pending'").run(
        req.approval_instance_id
      );
    }
    db.prepare(
      "UPDATE payment_requests SET status='cancelled', remark=IFNULL(remark,'') || ?, decided_at=?, decided_by=?, updated_at=? WHERE id=?"
    ).run(`\n[取消] ${reason}`, t, user.username, t, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return detail(id);
}

/** 删除：只有草稿能删（删掉会释放占用） */
function remove(id, user) {
  const req = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
  if (!req) throw bad('付款申请单不存在', 404);
  if (req.status !== 'draft') {
    throw bad(`只有草稿能删。处于「${STATUS_LABEL[req.status]}」的单请走「取消」，否则审批记录会断`);
  }
  if (req.created_by !== user.username && !['admin', 'finance'].includes(user.role)) {
    throw bad('只能删自己的草稿', 403);
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM payment_request_items WHERE request_id = ?').run(id);
    db.prepare('DELETE FROM payment_requests WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { deleted: Number(id) };
}

/**
 * 执行付款（出纳动作）
 *
 * 这是钱真正出门的那一刻，所以要求最严：
 *   - 必须是 approved
 *   - 必须有银行账户（对账前提）
 *   - 实际付款额必须等于申请额（要改金额请重新走审批，不许在执行时改）
 *   - 写完 payments 立刻回写发票状态，让应付台账、资金计划、对账三条线同时变
 */
function pay(id, payload, user) {
  const b = payload || {};
  const req = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id);
  if (!req) throw bad('付款申请单不存在', 404);
  if (req.status === 'paid') throw bad('这张单已经付过款了');
  if (req.status !== 'approved') {
    throw bad(`只有「待付款」的单能执行付款，现在是「${STATUS_LABEL[req.status] || req.status}」`);
  }

  const bankAccountId = b.bank_account_id ? Number(b.bank_account_id) : (req.bank_account_id ? Number(req.bank_account_id) : null);
  if (!bankAccountId) throw bad('执行付款必须选择出账银行账户 —— 没有账户的流水永远对不上银行账');
  const acc = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(bankAccountId);
  if (!acc) throw bad('银行账户不存在');
  if (acc.status && String(acc.status) !== 'active') throw bad(`账户「${acc.bank_name}」已停用，不能出账`);

  const items = db.prepare('SELECT * FROM payment_request_items WHERE request_id = ?').all(id);
  if (!items.length) throw bad('这张单没有明细，不能付款');

  // 金额必须与申请一致：执行时改金额等于绕过审批
  if (b.amount !== undefined && b.amount !== null && b.amount !== '' && Math.abs(r2(b.amount) - r2(req.amount)) > 0.005) {
    throw bad(`实际付款额 ${r2(b.amount)} 与批准金额 ${r2(req.amount)} 不一致 —— 要改金额请重新提交审批`);
  }

  const payDate = b.pay_date || today();
  const method = b.method || req.method || '银行转账';
  const t = now();
  const payNo = nextNo('FK', 'payments', 'pay_no');

  db.exec('BEGIN');
  try {
    // 逐张复查未付额：审批期间可能有人手工改了发票（哪怕是同一张单，也要以库为准）
    // 同时收集主体：付款单落在哪个主体，由它核销的发票决定（发票上有 company_id）
    const payCompanies = new Set();
    items.forEach((it) => {
      const inv = db.prepare('SELECT * FROM ap_invoices WHERE id = ?').get(it.invoice_id);
      if (!inv) throw bad(`发票 ${it.bill_no} 不存在`);
      if (String(inv.status) === 'void') throw bad(`发票 ${it.bill_no} 已作废，不能付款`);
      const open = r2((Number(inv.amount) || 0) - (Number(inv.paid_amount) || 0));
      if (Number(it.amount) > open + 0.005) {
        throw bad(
          `发票 ${it.bill_no} 的未付额只剩 ${open}，不够这次付款 ${it.amount}（可能已被别的单据先付了），请重新核对`
        );
      }
      payCompanies.add(Number(inv.company_id) || 1);
    });
    // 一笔付款只能结一个主体的账：跨主体时两边账上都不对，而合计刚好对得上
    if (payCompanies.size > 1) {
      throw bad(`付款申请 ${req.req_no} 核销了多个主体的发票（${[...payCompanies].join(' / ')}），请拆单后再执行`);
    }
    const payCompanyId = payCompanies.size === 1 ? [...payCompanies][0] : 1;

    const info = db
      .prepare(
        `INSERT INTO payments (pay_no, direction, partner_type, partner_id, partner_name, currency,
            amount_orig, rate, amount, method, pay_date, status, remark, operator, created_at,
            bank_account_id, payment_request_id, company_id)
         VALUES (?, 'out', 'supplier', ?, ?, ?, ?, 1, ?, ?, ?, 'valid', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payNo, req.supplier_id || null, req.supplier_name || null, req.currency || 'CNY',
        r2(req.amount), r2(req.amount), method, payDate,
        `付款申请 ${req.req_no}`, user.username, t,
        bankAccountId, Number(id), payCompanyId
      );
    const paymentId = Number(info.lastInsertRowid);

    const insAlloc = db.prepare(
      'INSERT INTO payment_allocations (payment_id, invoice_kind, invoice_id, amount, created_at) VALUES (?,?,?,?,?)'
    );
    items.forEach((it) => {
      insAlloc.run(paymentId, 'ap', it.invoice_id, r2(it.amount), t);
      S.syncPaidStatus('ap', it.invoice_id);
    });

    db.prepare(
      "UPDATE payment_requests SET status='paid', payment_id=?, bank_account_id=?, paid_at=?, paid_by=?, method=?, updated_at=? WHERE id=?"
    ).run(paymentId, bankAccountId, t, user.username, method, t, id);

    db.exec('COMMIT');
    return { ...detail(id), paid_payment_id: paymentId, pay_no: payNo };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * 统计（给页面顶部 & 审批中心）
 * ------------------------------------------------------------------ */

function stats() {
  const rows = db.prepare('SELECT status, COUNT(*) n, COALESCE(SUM(amount),0) amt FROM payment_requests GROUP BY status').all();
  const g = (s) => {
    const x = rows.find((r) => r.status === s);
    return { count: x ? Number(x.n) : 0, amount: x ? r2(x.amt) : 0 };
  };
  const committed = committedMap();
  let committedTotal = 0;
  committed.forEach((v) => { committedTotal = r2(committedTotal + v.amount); });

  const overduePending = db
    .prepare(
      `SELECT COUNT(*) n FROM payment_request_items i
         JOIN payment_requests r ON r.id = i.request_id
        WHERE r.status IN ('draft','submitted','approved')
          AND i.due_date IS NOT NULL AND i.due_date < ?`
    )
    .get(today()).n;

  return {
    draft: g('draft'),
    submitted: g('submitted'),
    approved: g('approved'),
    paid: g('paid'),
    cancelled: g('cancelled'),
    // 已申请未付：挂在发票上的钱，台账的"可申请额"要减掉它
    committed_amount: committedTotal,
    // 审批中 + 已批准 = 马上要出门的钱，资金计划里要预留
    pipeline_amount: r2(g('submitted').amount + g('approved').amount),
    // 旧字段名，保留一处别名给还没改的调用方（避免又出现「两个名字一个意思」）
    unpaid_amount: r2(g('submitted').amount + g('approved').amount),
    overdue_pending_count: Number(overduePending)
  };
}

module.exports = {
  STATUS_LABEL,
  OPEN_STATUS,
  committedMap,
  candidates,
  list,
  detail,
  create,
  update,
  submit,
  cancel,
  remove,
  pay,
  stats
};
