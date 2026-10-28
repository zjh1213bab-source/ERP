/**
 * 应付台账与付款计划
 *
 * ## 这一页要回答的问题
 * 不是「一共欠多少」（驾驶舱已经有了），而是：
 *   **这周要付谁、多少钱、最晚哪天付** —— 以及「还有多少是欠着但票都没到」。
 *
 * ## 口径
 *
 * ### 1. 应付 = 已开票未付 + 已收货未开票
 * 只算发票会漏掉一类：货已收、供应商还没开票。这笔钱虽然账上还没有发票，
 * 但**是确定要付的**，做资金计划时不算进去就会「计划得好好的，突然冒出一笔」。
 * 采购单 `status='received'` 且没有对应发票（非作废）的金额，单列一项。
 *
 * ### 2. 未结清按金额判，不按状态名单
 * 口径统一走 `services/invoiceStatus.js` —— 白名单式 `status IN ('unpaid','partial')`
 * 会把 `open` 这类别名静默漏掉，而这个库曾经因此少算 210 万应付、375 万应收。
 *
 * ### 3. 到期日为空的，不许当「永不到期」
 * 没有到期日的应付在账龄里永远算「未到期」，也就永远不会被催。
 * 所以台账里单独统计「无到期日」的金额，并提醒去补供应商账期。
 *
 * ## 付款计划为什么要按周
 * 财务看的是「这周现金够不够」，不是「总共欠多少」。按天太碎（每天几笔），
 * 按月太糙（月底才发现钱不够）。周是能行动的单位。
 */
const { db } = require('../db');
const S = require('./invoiceStatus');
const T = require('./paymentTerms');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n) || 0;

function dayDiff(a, b) {
  const t1 = Date.parse(String(a || '').slice(0, 10) + 'T00:00:00');
  const t2 = Date.parse(String(b || '').slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0;
  return Math.round((t2 - t1) / 86400000);
}

function termLabel(s) {
  if (!s) return '未设账期';
  if (s.term_days !== null && s.term_days !== undefined && s.term_days !== '') {
    const d = Number(s.term_days);
    if (d === 0) return '现结';
    const tail = s.payment_terms && String(s.payment_terms).trim() ? `（${s.payment_terms}）` : '';
    return `${d} 天${tail}`;
  }
  return s.payment_terms ? `${s.payment_terms}（未解析）` : '未设账期';
}

/**
 * 供应商应付台账
 */
function board({ q, only_overdue, asOf } = {}) {
  const today = String(asOf || T.todayStr()).slice(0, 10);
  const sups = db.prepare("SELECT * FROM suppliers WHERE status <> 'deleted' ORDER BY id").all();

  // 一次性把未结发票捞出来分组，避免每个供应商查一遍
  const openInvoices = db
    .prepare(
      `SELECT id, bill_no, supplier_id, supplier_name, amount, COALESCE(paid_amount,0) AS paid_amount,
              due_date, created_at, source
         FROM ap_invoices
        WHERE ${S.OPEN_SQL}
        ORDER BY due_date`
    )
    .all();

  const bySupplier = new Map();
  openInvoices.forEach((v) => {
    const key = v.supplier_id === null || v.supplier_id === undefined ? `name:${v.supplier_name || ''}` : Number(v.supplier_id);
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(v);
  });

  // 已收货未开票：采购单已收货、且没有非作废发票
  // 收货日取 goods_receipts.receive_date —— **不能用 purchase_orders.updated_at**：
  // 那是「最后修改时间」，之后任何人改个备注都会把收货日推到今天，
  // 于是「预计到期日」全都变成「今天 + 账期」，看着像刚收的货（踩过）
  const unbilled = db
    .prepare(
      `SELECT po.id, po.po_no, po.supplier_id, po.supplier, po.total_amount, po.order_date,
              po.expect_date,
              (SELECT MAX(receive_date) FROM goods_receipts g WHERE g.po_id = po.id) AS received_date
         FROM purchase_orders po
        WHERE po.status = 'received'
          AND NOT EXISTS (SELECT 1 FROM ap_invoices a WHERE a.purchase_id = po.id AND a.status <> 'void')
        ORDER BY po.id`
    )
    .all();
  const unbilledBySup = new Map();
  unbilled.forEach((p) => {
    const k = p.supplier_id === null || p.supplier_id === undefined ? `name:${p.supplier || ''}` : Number(p.supplier_id);
    if (!unbilledBySup.has(k)) unbilledBySup.set(k, []);
    unbilledBySup.get(k).push(p);
  });

  /**
   * 算一个供应商的一行
   *
   * `s` 可能来自 suppliers 表，也可能是「只有名字、没有档案」的虚拟供应商
   * （历史采购单 / 手工应付常这样）。后者以前被**整行丢掉** ——
   * 因为老代码是 `sups.map(...)`，遍历的是档案表，档案里没有的就不存在。
   * 于是台账比资金计划少 2000 元，两个模块对不上。
   */
  const buildRow = (s, invs, pos) => {

    let openAmount = 0;
    let overdue = 0;
    let maxOverdue = 0;
    let due7 = 0;
    let due15 = 0;
    let due30 = 0;
    let noDue = 0;
    let nextDue = null;

    invs.forEach((v) => {
      const open = r2(num(v.amount) - num(v.paid_amount));
      if (open <= 0.005) return;
      openAmount = r2(openAmount + open);
      const due = String(v.due_date || '').slice(0, 10);
      if (!due) {
        // 没有到期日：既不算逾期也不算即将到期，单独统计（否则它永远"安全"）
        noDue = r2(noDue + open);
        return;
      }
      const overdueDays = dayDiff(due, today);
      if (overdueDays > 0) {
        overdue = r2(overdue + open);
        maxOverdue = Math.max(maxOverdue, overdueDays);
      }
      // 「未来 N 天内到期」= 到期日在 [今天, 今天+N]
      const inDays = dayDiff(today, due);
      if (inDays >= 0 && inDays <= 7) due7 = r2(due7 + open);
      if (inDays >= 0 && inDays <= 15) due15 = r2(due15 + open);
      if (inDays >= 0 && inDays <= 30) due30 = r2(due30 + open);
      if (!nextDue || due < nextDue) nextDue = due;
    });

    const unbilledAmount = r2(pos.reduce((a, p) => a + num(p.total_amount), 0));
    // 未开票的应付严格说没有「到期日」（账期通常从开票日起算），
    // 但做资金计划时必须知道大概什么时候要掏钱 —— 用「收货日 + 账期」给个**预计**日期，
    // 页面上明写「预计」，并且**不算进逾期**（还没到付款义务那一步）
    const termDays = s.term_days === null || s.term_days === undefined ? null : Number(s.term_days);
    const unbilledEst = pos
      .filter(() => termDays !== null)
      .map((p) => ({
        due: T.addDays(String(p.received_date || p.expect_date || p.order_date || today).slice(0, 10), termDays),
        amount: num(p.total_amount)
      }))
      .sort((a2, b2) => String(a2.due).localeCompare(String(b2.due)));
    const unbilledEstDue = unbilledEst.length ? unbilledEst[0].due : null;
    // 按「单」算过期，不按「供应商」算：一家有 5 张单，只有 1 张过期，
    // 拿"最早那张过期"去乘整家的未开票金额，会把没过期的也算成过期（差过 6 万）
    const unbilledOverdueEst = r2(
      unbilledEst.filter((x) => x.due && x.due < today).reduce((a2, x) => a2 + x.amount, 0)
    );

    return {
      supplier: {
        id: s.id,
        code: s.code,
        name: s.name,
        category: s.category,
        contact: s.contact,
        phone: s.phone,
        payment_terms: s.payment_terms || null,
        term_days: s.term_days === null || s.term_days === undefined ? null : Number(s.term_days),
        term_label: termLabel(s)
      },
      figures: {
        open_amount: r2(openAmount),
        unbilled_amount: unbilledAmount,
        payable_total: r2(openAmount + unbilledAmount),
        overdue,
        max_overdue_days: maxOverdue,
        due_7: due7,
        due_15: due15,
        due_30: due30,
        no_due: noDue,
        invoice_count: invs.length,
        unbilled_count: pos.length,
        unbilled_est_due: unbilledEstDue,
        unbilled_overdue_est: unbilledOverdueEst,
        next_due: nextDue
      },
      // 风险：逾期 > 有已收货未开票 > 账期缺失 > 正常
      risk: overdue > 0.005 ? 'overdue'
        : unbilledAmount > 0.005 ? 'unbilled'
        : (s.term_days === null || s.term_days === undefined) ? 'noterm'
        : 'ok',
      risk_label: overdue > 0.005 ? '有逾期'
        : unbilledAmount > 0.005 ? '有票未到'
        : (s.term_days === null || s.term_days === undefined) ? '未设账期'
        : '正常'
    };
  };

  // 档案内的供应商
  const rows = sups.map((s) => buildRow(s, bySupplier.get(Number(s.id)) || [], unbilledBySup.get(Number(s.id)) || []));

  // 档案外但有欠款的（只存了名字的老数据）—— 补出来，不能因为没档案就假装不存在
  const knownIds = new Set(sups.map((s) => Number(s.id)));
  const orphanKeys = new Set();
  bySupplier.forEach((v, k) => { if (typeof k === 'string' && !knownIds.has(Number(k))) orphanKeys.add(k); });
  unbilledBySup.forEach((v, k) => { if (typeof k === 'string') orphanKeys.add(k); });
  orphanKeys.forEach((k) => {
    const name = k.startsWith('name:') ? k.slice(5) : k;
    rows.push(
      buildRow(
        {
          id: null,
          code: null,
          name: name || '（未命名供应商）',
          category: null,
          contact: null,
          phone: null,
          payment_terms: null,
          term_days: null,
          status: 'active',
          _orphan: true
        },
        bySupplier.get(k) || [],
        unbilledBySup.get(k) || []
      )
    );
  });

  // 只留有钱的（否则 11 家供应商里一半是 0，看着像没数据）
  let list = rows.filter((r) => r.figures.payable_total > 0.005);

  if (q) {
    const k = String(q).toLowerCase();
    list = list.filter(
      (r) =>
        String(r.supplier.name || '').toLowerCase().includes(k) ||
        String(r.supplier.code || '').toLowerCase().includes(k) ||
        String(r.supplier.contact || '').toLowerCase().includes(k)
    );
  }
  if (only_overdue) list = list.filter((r) => r.figures.overdue > 0.005);

  const RANK = { overdue: 0, unbilled: 1, noterm: 2, ok: 3 };
  list = [...list].sort((a, b) => {
    const d = (RANK[a.risk] ?? 9) - (RANK[b.risk] ?? 9);
    if (d !== 0) return d;
    return b.figures.payable_total - a.figures.payable_total;
  });

  const all = rows.filter((r) => r.figures.payable_total > 0.005);
  const summary = {
    suppliers: all.length,
    open_amount: r2(all.reduce((a, r) => a + r.figures.open_amount, 0)),
    unbilled_amount: r2(all.reduce((a, r) => a + r.figures.unbilled_amount, 0)),
    payable_total: r2(all.reduce((a, r) => a + r.figures.payable_total, 0)),
    overdue: r2(all.reduce((a, r) => a + r.figures.overdue, 0)),
    overdue_suppliers: all.filter((r) => r.figures.overdue > 0.005).length,
    due_7: r2(all.reduce((a, r) => a + r.figures.due_7, 0)),
    due_15: r2(all.reduce((a, r) => a + r.figures.due_15, 0)),
    due_30: r2(all.reduce((a, r) => a + r.figures.due_30, 0)),
    no_due: r2(all.reduce((a, r) => a + r.figures.no_due, 0)),
    noterm_suppliers: all.filter((r) => r.supplier.term_days === null).length,
    unbilled_overdue_est: r2(all.reduce((a, r) => a + r.figures.unbilled_overdue_est, 0)),
    max_overdue_days: all.reduce((m, r) => Math.max(m, r.figures.max_overdue_days), 0)
  };

  return { as_of: today, summary, rows: list };
}

/**
 * 付款计划：按周分组
 *
 * 第一组固定是「已逾期」，后面是第 1..N 周。逾期单独成组，因为它不是"计划"，
 * 是"已经晚了"——混在"本周"里会让人以为还有时间。
 */
function schedule({ weeks = 8, asOf } = {}) {
  const today = String(asOf || T.todayStr()).slice(0, 10);
  const nWeeks = Math.min(Math.max(Number(weeks) || 8, 1), 26);

  const invoices = db
    .prepare(
      `SELECT id, bill_no, supplier_id, supplier_name, amount, COALESCE(paid_amount,0) AS paid_amount,
              due_date, created_at
         FROM ap_invoices
        WHERE ${S.OPEN_SQL}
        ORDER BY due_date`
    )
    .all()
    .map((v) => {
      const due = String(v.due_date || '').slice(0, 10);
      return {
        ...v,
        due_date: due || null,
        open_amount: r2(num(v.amount) - num(v.paid_amount)),
        overdue_days: due ? Math.max(0, dayDiff(due, today)) : 0,
        // 相对今天的天数：负数=已过期，0=今天，正数=还有几天
        offset: due ? dayDiff(today, due) : null
      };
    })
    .filter((v) => v.open_amount > 0.005);

  // 周分桶：第 k 周 = [今天+7(k-1), 今天+7k)
  const weekOf = (offset) => Math.floor((offset + 7 - 1) / 7); // 逾期(负) 会被算成 0 或负，单独处理
  const buckets = [];

  const overdueList = invoices.filter((v) => v.overdue_days > 0);
  buckets.push({
    key: 'overdue',
    label: '已逾期',
    from: null,
    to: overdueList.length ? overdueList.reduce((m, v) => (v.due_date < m ? v.due_date : m), overdueList[0].due_date) : null,
    invoices: overdueList,
    amount: r2(overdueList.reduce((a, v) => a + v.open_amount, 0)),
    count: overdueList.length,
    suppliers: new Set(overdueList.map((v) => v.supplier_id || v.supplier_name)).size
  });

  for (let k = 0; k < nWeeks; k++) {
    const from = T.addDays(today, k * 7);
    const to = T.addDays(today, k * 7 + 6);
    const list = invoices.filter((v) => {
      if (!v.due_date || v.overdue_days > 0) return false;
      return v.due_date >= from && v.due_date <= to;
    });
    buckets.push({
      key: 'w' + k,
      label: k === 0 ? '本周（含今天）' : k === 1 ? '下周' : `第 ${k + 1} 周`,
      from,
      to,
      invoices: list,
      amount: r2(list.reduce((a, v) => a + v.open_amount, 0)),
      count: list.length,
      suppliers: new Set(list.map((v) => v.supplier_id || v.supplier_name)).size
    });
  }

  // 周之后到期的，合成一个"更晚"
  const laterFrom = T.addDays(today, nWeeks * 7);
  const later = invoices.filter((v) => v.due_date && v.overdue_days === 0 && v.due_date >= laterFrom);
  if (later.length) {
    buckets.push({
      key: 'later',
      label: `${nWeeks} 周以后`,
      from: laterFrom,
      to: null,
      invoices: later,
      amount: r2(later.reduce((a, v) => a + v.open_amount, 0)),
      count: later.length,
      suppliers: new Set(later.map((v) => v.supplier_id || v.supplier_name)).size
    });
  }

  // 已收货未开票：单独一组「待开票（预计）」。
  // 不并进逾期/本周，因为账期通常从开票日才起算 —— 混进去会把"还没到时候"说成"已经晚了"。
  // 但一定要出现在计划里，否则做资金计划时这笔钱凭空消失。
  const pendingPos = db
    .prepare(
      `SELECT po.id, po.po_no, po.supplier_id, po.supplier, po.total_amount, po.order_date, po.expect_date,
              (SELECT MAX(receive_date) FROM goods_receipts g WHERE g.po_id = po.id) AS received_date
         FROM purchase_orders po
        WHERE po.status = 'received'
          AND NOT EXISTS (SELECT 1 FROM ap_invoices a WHERE a.purchase_id = po.id AND a.status <> 'void')
        ORDER BY po.id`
    )
    .all()
    .map((p) => {
      const sup = p.supplier_id ? db.prepare('SELECT term_days, payment_terms FROM suppliers WHERE id = ?').get(p.supplier_id) : null;
      const parsed = sup ? (sup.term_days !== null && sup.term_days !== undefined ? Number(sup.term_days) : (T.parseTerms(sup.payment_terms) || {}).days) : null;
      const base = String(p.received_date || p.expect_date || p.order_date || today).slice(0, 10);
      return {
        id: p.id,
        po_no: p.po_no,
        supplier_id: p.supplier_id,
        supplier_name: p.supplier,
        amount: r2(num(p.total_amount)),
        received_date: p.received_date || null,
        est_due: parsed === null || parsed === undefined ? null : T.addDays(base, parsed),
        term_known: parsed !== null && parsed !== undefined
      };
    });

  const pendingAmount = r2(pendingPos.reduce((a, p) => a + p.amount, 0));
  // 预计到期日已经过了、但票还没来 —— 这不是"逾期"（付款义务还没正式成立），
  // 但它是**确认要掏、而且已经拖了一阵的钱**，做资金计划时最容易被忘掉
  const pendingOverdue = r2(
    pendingPos.filter((p) => p.est_due && p.est_due < today).reduce((a, p) => a + p.amount, 0)
  );

  const noDue = invoices.filter((v) => !v.due_date);
  const summary = {
    as_of: today,
    weeks: nWeeks,
    total_open: r2(invoices.reduce((a, v) => a + v.open_amount, 0)),
    pending_unbilled: pendingAmount,
    pending_count: pendingPos.length,
    pending_overdue: pendingOverdue,
    overdue: buckets[0].amount,
    due_this_week: buckets[1] ? buckets[1].amount : 0,
    due_next_week: buckets[2] ? buckets[2].amount : 0,
    no_due: r2(noDue.reduce((a, v) => a + v.open_amount, 0)),
    no_due_count: noDue.length
  };

  return {
    as_of: today,
    summary,
    buckets: buckets.map((b) => ({
      key: b.key,
      label: b.label,
      from: b.from,
      to: b.to,
      amount: b.amount,
      count: b.count,
      suppliers: b.suppliers,
      invoices: b.invoices.map((v) => ({
        id: v.id,
        bill_no: v.bill_no,
        supplier_id: v.supplier_id,
        supplier_name: v.supplier_name,
        due_date: v.due_date,
        open_amount: v.open_amount,
        overdue_days: v.overdue_days
      }))
    })),
    no_due: noDue.map((v) => ({
      id: v.id,
      bill_no: v.bill_no,
      supplier_id: v.supplier_id,
      supplier_name: v.supplier_name,
      open_amount: v.open_amount
    })),
    // 还没来票的应付：有金额、有预计日期，但不该按"到期"处理
    pending: pendingPos
  };
}

/** 单供应商明细：未付发票 + 已收货未开票的采购单 + 最近付款 */
function detail(supplierId) {
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
  if (!s) return null;
  const today = T.todayStr();

  const invoices = db
    .prepare(
      `SELECT id, bill_no, amount, COALESCE(paid_amount,0) AS paid_amount, due_date, created_at, source, purchase_id
         FROM ap_invoices
        WHERE supplier_id = ? AND ${S.OPEN_SQL}
        ORDER BY due_date`
    )
    .all(supplierId)
    .map((v) => {
      const due = String(v.due_date || '').slice(0, 10);
      return {
        ...v,
        due_date: due || null,
        open_amount: r2(num(v.amount) - num(v.paid_amount)),
        overdue_days: due ? Math.max(0, dayDiff(due, today)) : 0,
        is_overdue: !!due && due < today
      };
    });

  const unbilled = db
    .prepare(
      `SELECT po.id, po.po_no, po.total_amount, po.order_date, po.expect_date,
              (SELECT MAX(receive_date) FROM goods_receipts g WHERE g.po_id = po.id) AS received_date
         FROM purchase_orders po
        WHERE po.supplier_id = ? AND po.status = 'received'
          AND NOT EXISTS (SELECT 1 FROM ap_invoices a WHERE a.purchase_id = po.id AND a.status <> 'void')
        ORDER BY po.id`
    )
    .all(supplierId);

  const paid = db
    .prepare(
      `SELECT id, pay_no, amount, pay_date, status, remark
         FROM payments
        WHERE direction = 'out' AND partner_id = ?
        ORDER BY pay_date DESC LIMIT 20`
    )
    .all(supplierId);

  const openAmount = r2(invoices.reduce((a, v) => a + v.open_amount, 0));
  const unbilledAmount = r2(unbilled.reduce((a, p) => a + num(p.total_amount), 0));

  return {
    supplier: {
      id: s.id,
      code: s.code,
      name: s.name,
      category: s.category,
      contact: s.contact,
      phone: s.phone,
      payment_terms: s.payment_terms || null,
      term_days: s.term_days === null || s.term_days === undefined ? null : Number(s.term_days),
      term_label: termLabel(s),
      lead_days: s.lead_days
    },
    figures: {
      open_amount: openAmount,
      unbilled_amount: unbilledAmount,
      payable_total: r2(openAmount + unbilledAmount),
      overdue: r2(invoices.filter((v) => v.is_overdue).reduce((a, v) => a + v.open_amount, 0)),
      max_overdue_days: invoices.reduce((m, v) => Math.max(m, v.overdue_days), 0)
    },
    invoices,
    unbilled,
    payments: paid
  };
}

/** 维护账期：手填天数优先于文本解析 */
function setTerm(supplierId, { payment_terms, term_days }, operator) {
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
  if (!s) {
    const e = new Error('供应商不存在');
    e.status = 404;
    throw e;
  }
  const days = term_days === null || term_days === undefined || term_days === '' ? null : Number(term_days);
  if (days !== null && (!Number.isFinite(days) || days < 0 || days > 365)) {
    const e = new Error('账期天数填 0–365');
    e.status = 400;
    throw e;
  }
  const terms = payment_terms === undefined ? s.payment_terms : String(payment_terms || '').trim() || null;

  // 只改文本时，顺手把天数解析出来（否则改了文本天数不变，看着像没生效）
  let effective = days;
  if (days === null) {
    const p = T.parseTerms(terms);
    effective = p ? p.days : null;
  }

  const t = require('../db').now();
  db.prepare('UPDATE suppliers SET payment_terms = ?, term_days = ?, updated_at = ? WHERE id = ?').run(
    terms,
    effective,
    t,
    supplierId
  );
  return {
    id: Number(supplierId),
    payment_terms: terms,
    term_days: effective,
    term_label: termLabel({ payment_terms: terms, term_days: effective }),
    operator: operator || null
  };
}

module.exports = { board, schedule, detail, setTerm, termLabel, dayDiff };
