/**
 * 客户对账单（对账函）
 * ============================================================
 * 为什么需要这张纸：发票开了不代表客户会付。外贸/内销都一样 ——
 * 客户财务那边没对上账，就会一直「等核对完再付」。你催得再勤，
 * 他一句「你们的账跟我们的对不上」就把球踢回来。
 *
 * 对账函的作用是**把话说到纸面上**：本期期初多少、开了几张票、收了几笔款、
 * 期末结欠多少，逐笔流水带余额，客户盖个章，后面就不再有「没对清」这个借口。
 *
 * 三条口径（都写在这里，页面只展示）
 *
 * 1. **期间按「开票日 / 收款日」切**，不按到期日。
 *    账龄才有到期日的概念，对账只关心「这段时间发生了什么」。
 *    系统里发票没有独立开票日字段，取 `created_at` 的日期部分（单据创建即开票）。
 *
 * 2. **只认有效单据**：发票排除 `status='void'`；收款只认 `valid`/`confirmed` 且未冲销
 *    （口径见 `services/paymentStatus.js`）。冲销过的收款算进来，客户会拿那笔退款质疑整张表。
 *
 * 3. **余额用流水累计**：期末 = 期初 + 本期开票 − 本期收款，逐行滚动。
 *    但同时用「未收发票口径」（Σ amount − paid_amount）做一次交叉校验 ——
 *    两者不相等说明**系统里有发票的 paid_amount 被手工改过、或有收款没走流水**，
 *    这种账在不给客户之前必须先自己查清（`warnings` 会点名）。
 */
const { db } = require('../db');
// 收款「有效」的唯一口径（valid/confirmed 且未冲销）—— 与 finance/bank/crm 共用
const { PAY_VALID, payValidOf } = require('./paymentStatus');

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const day = (s) => String(s || '').slice(0, 10);

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function defaultPeriod() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const last = new Date(y, m, 0).getDate();
  return { from: `${y}-${p(m)}-01`, to: `${y}-${p(m)}-${p(last)}` };
}

/** 有往来（发票或收款）的客户清单 + 当前结欠，供选客户用 */
function listCustomers() {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.code,
              COALESCE(inv.amt, 0) - COALESCE(inv.paid, 0) AS open_amount,
              COALESCE(inv.cnt, 0) AS invoice_count,
              inv.last_date
         FROM customers c
         JOIN (
              SELECT customer_id,
                     SUM(amount) AS amt,
                     SUM(paid_amount) AS paid,
                     COUNT(*) AS cnt,
                     MAX(substr(created_at,1,10)) AS last_date
                FROM ar_invoices WHERE status != 'void' AND customer_id IS NOT NULL
               GROUP BY customer_id
         ) inv ON inv.customer_id = c.id
        ORDER BY open_amount DESC, c.name`
    )
    .all()
    .map((r) => {
      // 未核销收款：钱到了但没分到发票上，列表里要减掉，否则「他还欠我多少」是虚高的
      const un = db
        .prepare(
          `SELECT COALESCE(SUM(p.amount), 0) AS paid,
                  (SELECT COALESCE(SUM(a.amount), 0) FROM payment_allocations a JOIN payments p2 ON p2.id = a.payment_id
                    WHERE a.invoice_kind = 'ar' AND p2.partner_id = p.partner_id AND p2.direction = 'in'
                      AND ${payValidOf('p2')}) AS alloc
             FROM payments p
            WHERE p.direction = 'in' AND p.partner_type = 'customer' AND p.partner_id = ?
              AND ${payValidOf('p')}`
        )
        .get(r.id);
      const unallocated = round2((Number(un.paid) || 0) - (Number(un.alloc) || 0));
      return {
        ...r,
        open_amount: round2(r.open_amount),          // 未收发票口径
        unallocated,
        real_open: round2(r.open_amount - unallocated) // 实际结欠（减掉已到账未核销的钱）
      };
    });
  return rows;
}

/**
 * 生成某客户某期间的对账单
 * @param {number} customerId
 * @param {{from?:string,to?:string}} q
 */
function build(customerId, q = {}) {
  const id = Number(customerId);
  const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!cust) throw bad('客户不存在', 404);

  const def = defaultPeriod();
  const from = day(q.from) || def.from;
  const to = day(q.to) || def.to;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw bad('期间格式应为 YYYY-MM-DD');
  }
  if (from > to) throw bad('开始日期不能晚于结束日期');

  const invoices = db
    .prepare(
      `SELECT id, bill_no, order_id, amount, paid_amount, currency, amount_orig, rate, due_date, source,
              substr(created_at,1,10) AS invoice_date
         FROM ar_invoices
        WHERE customer_id = ? AND status != 'void'
        ORDER BY invoice_date, id`
    )
    .all(id);

  const payments = db
    .prepare(
      `SELECT id, pay_no, amount, pay_date, method, remark, currency, amount_orig, rate
         FROM payments
        WHERE direction = 'in' AND partner_type = 'customer' AND partner_id = ?
          AND ${PAY_VALID}
        ORDER BY pay_date, id`
    )
    .all(id);

  // 核销表：收款分到哪张发票。对账单的「未核销收款」就靠它算，
  // 否则客户会问「我明明付了 6 万，你怎么还说我欠 9.5 万」
  const alloc = db
    .prepare(
      `SELECT COALESCE(SUM(a.amount), 0) AS s
         FROM payment_allocations a
         JOIN payments p ON p.id = a.payment_id
        WHERE a.invoice_kind = 'ar' AND p.partner_id = ? AND p.direction = 'in'
          AND ${payValidOf('p')}
          AND substr(p.pay_date, 1, 10) <= ?`
    )
    .get(id, to).s;
  const receivedToDate = round2(payments.filter((r) => day(r.pay_date) <= to).reduce((s2, r) => s2 + (Number(r.amount) || 0), 0));
  const allocated = round2(alloc);
  const unallocated = round2(receivedToDate - allocated);   // 钱到了但还没核销到发票

  // 期初：期间开始之前发生的一切
  const opening = round2(
    invoices.filter((r) => r.invoice_date < from).reduce((s, r) => s + (Number(r.amount) || 0), 0) -
      payments.filter((r) => day(r.pay_date) < from).reduce((s, r) => s + (Number(r.amount) || 0), 0)
  );

  // 本期流水（开票记借方、收款记贷方），按日期排序后滚动余额
  const events = [];
  invoices
    .filter((r) => r.invoice_date >= from && r.invoice_date <= to)
    .forEach((r) =>
      events.push({
        kind: 'invoice',
        date: r.invoice_date,
        no: r.bill_no,
        order_id: r.order_id,
        debit: round2(r.amount),
        credit: 0,
        note: r.due_date ? `到期 ${r.due_date}` : '',
        currency: r.currency || 'CNY',
        amount_orig: Number(r.amount_orig) || null,
        rate: Number(r.rate) || null,
        seq: r.id
      })
    );
  payments
    .filter((r) => day(r.pay_date) >= from && day(r.pay_date) <= to)
    .forEach((r) =>
      events.push({
        kind: 'payment',
        date: day(r.pay_date),
        no: r.pay_no,
        order_id: null,
        debit: 0,
        credit: round2(r.amount),
        note: [r.method, r.remark].filter(Boolean).join(' '),
        currency: r.currency || 'CNY',
        amount_orig: Number(r.amount_orig) || null,
        rate: Number(r.rate) || null,
        seq: r.id
      })
    );

  events.sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date.localeCompare(b.date)));

  let running = opening;
  const rows = events.map((e) => {
    running = round2(running + e.debit - e.credit);
    return { ...e, balance: running };
  });

  const invoiceAmount = round2(events.filter((e) => e.kind === 'invoice').reduce((s, e) => s + e.debit, 0));
  const paymentAmount = round2(events.filter((e) => e.kind === 'payment').reduce((s, e) => s + e.credit, 0));
  const closing = round2(opening + invoiceAmount - paymentAmount);

  // 交叉校验：未收发票口径
  const openByInvoice = round2(
    invoices
      .filter((r) => r.invoice_date <= to)
      .reduce((s, r) => s + ((Number(r.amount) || 0) - (Number(r.paid_amount) || 0)), 0)
  );
  // 恒等式：流水口径期末 = 未收发票口径 − 未核销收款
  // 因为 Σ发票 − Σ收款 = Σ(发票 − 核销) − (Σ收款 − Σ核销)。等式不成立才是真异常。
  const diff = round2(closing - openByInvoice);
  const checkDiff = round2(closing - (openByInvoice - unallocated));

  const warnings = [];
  const notices = [];

  if (Math.abs(checkDiff) >= 0.01) {
    warnings.push(
      `对不平：流水口径期末 ${closing} 元，按「未收发票 − 未核销收款」算应为 ${round2(openByInvoice - unallocated)} 元，` +
        `差 ${checkDiff} 元。说明有发票的已收金额被手工改过、或有收款没走收款单 —— ` +
        '这种账不能直接发给客户，先查清。'
    );
  }
  if (unallocated > 0.005) {
    notices.push(
      `有 ${unallocated} 元收款已到账但尚未核销到具体发票，对账单里单列一项 —— ` +
        '客户问「我这笔钱去哪了」时指这一项。'
    );
  }
  const negPaid = invoices.filter((r) => Number(r.paid_amount) > Number(r.amount) + 0.005);
  if (negPaid.length) {
    warnings.push(`有 ${negPaid.length} 张发票的已收金额大于开票金额（${negPaid.map((r) => r.bill_no).join('、')}），检查是否多收或串户`);
  }
  if (!rows.length && Math.abs(opening) < 0.005) {
    warnings.push('该期间没有开票也没有收款，且期初余额为 0 —— 这张对账单是空的，确认期间选对了没');
  }

  return {
    customer: {
      id: cust.id,
      name: cust.name,
      code: cust.code || '',
      contact: cust.contact || '',
      phone: cust.phone || '',
      address: cust.address || ''
    },
    period: { from, to },
    opening,
    rows,
    summary: {
      invoice_count: events.filter((e) => e.kind === 'invoice').length,
      invoice_amount: invoiceAmount,
      payment_count: events.filter((e) => e.kind === 'payment').length,
      payment_amount: paymentAmount,
      opening,
      closing,
      open_by_invoice: openByInvoice,
      allocated,
      unallocated,
      diff,
      check_diff: checkDiff
    },
    warnings,
    notices
  };
}

module.exports = { listCustomers, build, defaultPeriod };
