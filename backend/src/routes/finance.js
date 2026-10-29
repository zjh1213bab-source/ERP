/**
 * 往来账与资金核销：应收（AR） / 应付（AP） / 收付款 / 账龄
 * ------------------------------------------------------------
 * 模型：一张账款可以被多笔收付款核销，一笔收付款也能核销多张账款，
 * 所以 paid_amount 不直接改，而是由 payment_allocations 汇总后回写，
 * 保证「核销明细之和 = 已收/已付」永远成立，红冲时按明细反向回退。
 *
 * 数据流：
 *   订单发货 → 自动开应收（source=order）
 *   采购入库 → 自动开应付（source=purchase，接采购模块时调用 openAP）
 *   登记收款/付款 → 核销 → 账款状态 unpaid/partial/paid
 *   红冲 → 反向回退已收已付，款项置 reversed，记录保留
 */
const express = require('express');
const { db, now, getSettings } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { payValidOf, PAY_VALID } = require('../services/paymentStatus');
// 发票「是否还欠着」的唯一口径（按金额，不按状态名单）——
// 白名单会把 open/pending 这类别名静默漏掉，漏掉的都是真钱
const S = require('../services/invoiceStatus');
const T = require('../services/paymentTerms');
// 主体范围：往来账是"某个法人主体的账"，必须按 company_id 过滤（集团角色跨主体）
const scope = require('../access/companyScope');

const router = express.Router();
const WRITE = ['admin', 'finance'];
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * 范围条件拼进 SQL：`WHERE ${S.OPEN_SQL} ${sc.sql}` / `WHERE 1=1 ${sc.sql}`
 *
 * 集团角色与未绑定主体的账号返回空串，查询保持原样 —— 这两类账号的"能不能看"
 * 是权限问题，不该在这里悄悄变成"什么都看不到"。
 */
const sc = (user, col = 'company_id') => scope.clause(user, col);

/** 按 id 取一张账款并校验归属；不属于本公司按不存在处理 */
function invoiceInScope(user, table, id, label) {
  const r = scope.assertRow(user, table, id, label);
  if (!r.ok) {
    const e = new Error(r.reason);
    e.status = r.status;
    throw e;
  }
  return r.row;
}

const INVOICE = {
  ar: { table: 'ar_invoices', prefix: 'YS', label: '应收' },
  ap: { table: 'ap_invoices', prefix: 'YF', label: '应付' }
};

/** 按前缀 + 当天流水生成单号 */
// 单号生成统一到 utils/docNo（与 services/apInvoice 共用一份实现）
const { nextNo: nextDocNo } = require('../utils/docNo');
function nextNo(prefix, table) {
  return nextDocNo(prefix, table);
}
function nextPayNo(direction) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const prefix = direction === 'in' ? 'SK' : 'FK';
  const row = db.prepare('SELECT pay_no FROM payments WHERE pay_no LIKE ? ORDER BY id DESC LIMIT 1').get(`${prefix}${ymd}%`);
  const seq = row ? Number(String(row.pay_no).slice(-4)) + 1 : 1;
  return genNo(prefix, seq);
}

/** 未收 / 未付金额（本币） */
const openAmount = (inv) => r2((Number(inv.amount) || 0) - (Number(inv.paid_amount) || 0));
/** 未收 / 未付金额（原币）：本币未收 ÷ 开票汇率 */
const openOrig = (inv) => {
  const rate = Number(inv.rate) || 1;
  return r2(openAmount(inv) / rate);
};
/** 外币单据的展示补充字段 */
const withCurrency = (inv) => ({
  ...inv,
  currency: inv.currency || 'CNY',
  amount_orig: r2(inv.amount_orig || inv.amount),
  rate: Number(inv.rate) || 1,
  open_amount: openAmount(inv),
  open_amount_orig: openOrig(inv)
});

// 「按核销重算发票状态」搬到 services/invoiceStatus（付款申请执行付款时也要用，
// 抄一份必然出现「两条路算出的 paid_amount 不一样」）
const { syncPaidStatus } = require('../services/invoiceStatus');
function syncStatus(kind, invoiceId) {
  return syncPaidStatus(kind, invoiceId);
}

/** 账龄天数（按到期日算，未设到期日按开票日+30 天） */
function agingDays(inv) {
  const base = inv.due_date || inv.created_at;
  if (!base) return 0;
  const d = new Date(String(base).slice(0, 10));
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

/* ---------------- 自动开票（供订单/采购调用） ---------------- */

/**
 * 订单发货时开应收；已开过就返回原单，不重复开。
 *
 * 外币口径：外贸订单以美金签单，开票按**美金原币金额**开，
 * 汇率取订单上的 rate（下单时的结算汇率），本币金额 = 美金 × 汇率 用于记账与账龄。
 * 订单没有美金金额时（纯内销）退化成人民币开票。
 */
function openARForOrder(orderId, userId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const exist = db.prepare("SELECT * FROM ar_invoices WHERE order_id = ? AND status != 'void'").get(orderId);
  if (exist) return exist;

  const usd = r2(order.total_usd);
  const rate = Number(order.rate) || Number(getSettings().exchangeRate) || 1;
  let currency = 'CNY';
  let amountOrig = 0;
  let amount = 0;
  if (usd > 0) {
    currency = 'USD';
    amountOrig = usd;
    amount = r2(usd * rate);
  } else {
    amountOrig = r2(order.total_amount);
    amount = amountOrig;
  }
  if (amount <= 0) return null;

  const cust = order.customer_id
    ? db.prepare('SELECT name FROM customers WHERE id = ?').get(order.customer_id)
    : null;
  const t = now();
  // 应收跟着订单走主体：订单属于哪个法人主体，应收就记哪个
  // （不写这一列会用表默认值 1 → 分部的账全进总部，开完自己又看不见）
  const info = db.prepare(
    `INSERT INTO ar_invoices (bill_no, order_id, customer_id, customer_name, currency, amount_orig, rate, amount, paid_amount, due_date, status, source, remark, created_by, created_at, updated_at, company_id)
     VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo(INVOICE.ar.prefix, INVOICE.ar.table),
    orderId, order.customer_id || null, cust ? cust.name : null,
    currency, amountOrig, rate, amount,
    order.delivery_date || null, 'unpaid', 'order',
    currency === 'USD'
      ? `订单 ${order.order_no} 发货自动开票（USD ${amountOrig} × ${rate}）`
      : `订单 ${order.order_no} 发货自动开票`,
    userId || 'system', t, t, Number(order.company_id) || 1
  );
  return db.prepare('SELECT * FROM ar_invoices WHERE id = ?').get(Number(info.lastInsertRowid));
}

// 采购收货开应付的实现搬到 services/apInvoice.js（路由之间不该互相 require）
const { openAPForPurchase } = require('../services/apInvoice');

/* ---------------- 总览 ---------------- */

router.get('/summary', authRequired, wrap(async (req, res) => {
  const sum = (sql, ...args) => r2(db.prepare(sql).get(...args).s);
  const monthStart = new Date();
  monthStart.setDate(1);
  const ms = monthStart.toISOString().slice(0, 10);
  // 每一项都要带主体条件（多主体模式下：总览数字是"分部的应收"，不是"集团的应收"）。
  // **单公司模式下这些条件恒为空**，见 access/companyScope.js 的 of()。
  const a = sc(req.user);

  const arTotal = sum(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) AS s FROM ar_invoices WHERE ${S.OPEN_SQL}${a.sql}`, ...a.params);
  const apTotal = sum(`SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) AS s FROM ap_invoices WHERE ${S.OPEN_SQL}${a.sql}`, ...a.params);
  const overdueAr = sum(
    `SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) AS s FROM ar_invoices WHERE ${S.OPEN_SQL} AND due_date IS NOT NULL AND due_date < ?${a.sql}`,
    today(), ...a.params
  );
  const paidIn = sum(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE direction='in' AND ${PAY_VALID} AND pay_date >= ?${a.sql}`, ms, ...a.params);
  const paidOut = sum(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE direction='out' AND ${PAY_VALID} AND pay_date >= ?${a.sql}`, ms, ...a.params);

  // 美金口径：外贸客户欠的是美金，本币数字受汇率波动影响，业务更需要看原币
  const usdOpen = sum(
    `SELECT COALESCE(SUM((amount - COALESCE(paid_amount,0)) / CASE WHEN rate > 0 THEN rate ELSE 1 END),0) AS s FROM ar_invoices WHERE ${S.OPEN_SQL} AND currency = 'USD'${a.sql}`,
    ...a.params
  );
  const usdTotal = sum(`SELECT COALESCE(SUM(amount_orig),0) AS s FROM ar_invoices WHERE status != 'void' AND currency = 'USD'${a.sql}`, ...a.params);
  const usdPaid = sum(
    `SELECT COALESCE(SUM(paid_amount / CASE WHEN rate > 0 THEN rate ELSE 1 END),0) AS s FROM ar_invoices WHERE status != 'void' AND currency = 'USD'${a.sql}`,
    ...a.params
  );

  return ok(res, {
    ar_open: arTotal,
    ap_open: apTotal,
    ar_overdue: overdueAr,
    month_in: paidIn,
    month_out: paidOut,
    // 美金口径
    ar_open_usd: usdOpen,
    ar_total_usd: usdTotal,
    ar_paid_usd: usdPaid,
    ar_count: db.prepare(`SELECT COUNT(*) AS c FROM ar_invoices WHERE ${S.OPEN_SQL}${a.sql}`).get(...a.params).c,
    ap_count: db.prepare(`SELECT COUNT(*) AS c FROM ap_invoices WHERE ${S.OPEN_SQL}${a.sql}`).get(...a.params).c,
    // 让前端/排查能看出这份数字是"本公司"还是"全集团"
    scope: a.scoped ? 'company' : 'group'
  });
}));

/* ---------------- 账龄 ---------------- */

router.get('/aging', authRequired, wrap(async (req, res) => {
  const kind = req.query.kind === 'ap' ? 'ap' : 'ar';
  const { table } = INVOICE[kind];
  // 账龄桶是给"这家主体"看的催收/付款节奏，必须与列表同口径
  const a = sc(req.user);
  const rows = db.prepare(`SELECT * FROM ${table} WHERE ${S.OPEN_SQL}${a.sql} ORDER BY due_date`).all(...a.params);
  const buckets = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
  rows.forEach((inv) => {
    const open = openAmount(inv);
    if (open <= 0) return;
    const days = agingDays(inv);
    const overdue = inv.due_date && String(inv.due_date).slice(0, 10) < today();
    if (!overdue) buckets.current += open;
    else if (days <= 30) buckets.d30 += open;
    else if (days <= 60) buckets.d60 += open;
    else if (days <= 90) buckets.d90 += open;
    else buckets.over90 += open;
  });
  Object.keys(buckets).forEach((k) => (buckets[k] = r2(buckets[k])));
  return ok(res, { kind, buckets, count: rows.length });
}));

/* ---------------- 应收 / 应付 列表与维护 ---------------- */

function listInvoices(kind) {
  return wrap(async (req, res) => {
    const { table } = INVOICE[kind];
    const { status, q, partner_id } = req.query;
    const where = [];
    const args = [];
    // 主体条件放最前：后面所有筛选都在"本公司"这个集合里做
    const a = sc(req.user);
    if (a.scoped) { where.push(`company_id = ?`); args.push(a.params[0]); }
    if (status) { where.push('status = ?'); args.push(status); }
    if (partner_id) { where.push(`${kind === 'ar' ? 'customer_id' : 'supplier_id'} = ?`); args.push(partner_id); }
    if (q) {
      where.push(`(bill_no LIKE ? OR ${kind === 'ar' ? 'customer_name' : 'supplier_name'} LIKE ? OR remark LIKE ?)`);
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    // 默认不显示已作废，除非显式筛 status=void
    if (status !== 'void') where.push("status != 'void'");
    const sql = `SELECT * FROM ${table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (status='paid'), due_date IS NULL, due_date, id DESC LIMIT 500`;
    const rows = db.prepare(sql).all(...args).map((r) => ({
      ...withCurrency(r),
      aging_days: agingDays(r),
      overdue: !!(r.due_date && String(r.due_date).slice(0, 10) < today() && openAmount(r) > 0)
    }));
    return ok(res, rows);
  });
}

router.get('/ar', authRequired, listInvoices('ar'));
router.get('/ap', authRequired, listInvoices('ap'));

function createInvoice(kind) {
  return wrap(async (req, res) => {
    const { table, prefix } = INVOICE[kind];
    const b = req.body || {};

    // 币种：外币传 { currency:'USD', amount_orig, rate }；本币传 { amount }
    const currency = String(b.currency || 'CNY').toUpperCase();
    const rate = currency === 'CNY'
      ? 1
      : (Number(b.rate) || Number(getSettings().exchangeRate) || 1);
    let amountOrig = currency === 'CNY' ? r2(b.amount || b.amount_orig) : r2(b.amount_orig);
    let amount = currency === 'CNY' ? amountOrig : r2(amountOrig * rate);
    if (currency !== 'CNY' && !(amountOrig > 0)) return fail(res, 400, '外币单据请填写原币金额');
    if (!(amount > 0)) return fail(res, 400, '金额必须大于 0');

    const partnerName = b.partner_name || b.customer_name || b.supplier_name || null;
    if (!partnerName) return fail(res, 400, kind === 'ar' ? '请填写客户' : '请填写供应商');

    // 挂订单的手工应收：订单必须是本主体的（否则等于把别家的单挂到自己账上）
    if (kind === 'ar' && b.order_id) {
      const ord = scope.assertOrder(req.user, b.order_id);
      if (!ord.ok) return fail(res, 404, '订单不存在');
    }
    // 主体：分部开的单记分部，集团账号可显式指定（合并口径补录）
    const companyId = scope.writeCompanyOf(req.user, b.company_id);

    const t = now();
    const info = db.prepare(
      `INSERT INTO ${table} (bill_no, ${kind === 'ar' ? 'order_id, customer_id, customer_name' : 'purchase_id, supplier_id, supplier_name'},
        currency, amount_orig, rate, amount, paid_amount, due_date, status, source, remark, created_by, created_at, updated_at, company_id)
       VALUES (?,?,?,?, ?,?,?,?,0, ?,?,?,?,?,?,?,?)`
    ).run(
      nextNo(prefix, table),
      b.order_id || null, b.partner_id || null, partnerName,
      currency, amountOrig, rate, amount,
      b.due_date || null, 'unpaid', b.source || 'manual', b.remark || null,
      req.user.username, t, t, companyId
    );
    return ok(res, withCurrency(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(info.lastInsertRowid))));
  });
}

router.post('/ar', authRequired, requireRole(WRITE), createInvoice('ar'));
router.post('/ap', authRequired, requireRole(WRITE), createInvoice('ap'));

function voidInvoice(kind) {
  return wrap(async (req, res) => {
    const { table } = INVOICE[kind];
    const inv = invoiceInScope(req.user, table, req.params.id, '单据');
    if (inv.status === 'void') return fail(res, 400, '已经作废过');
    if (r2(inv.paid_amount) > 0) return fail(res, 400, '已有核销记录，请先红冲对应收付款再作废');
    const reason = (req.body && req.body.reason) || '';
    if (!reason.trim()) return fail(res, 400, '请填写作废原因');
    db.prepare(`UPDATE ${table} SET status='void', void_reason=?, updated_at=? WHERE id=?`)
      .run(reason.trim(), now(), req.params.id);
    return ok(res, { id: Number(req.params.id), status: 'void' });
  });
}

router.post('/ar/:id/void', authRequired, requireRole(WRITE), voidInvoice('ar'));
router.post('/ap/:id/void', authRequired, requireRole(WRITE), voidInvoice('ap'));

/* ---------------- 收付款 + 核销 ---------------- */

router.get('/payments', authRequired, wrap(async (req, res) => {
  const { direction, partner_id } = req.query;
  const where = [];
  const args = [];
  const a = sc(req.user);
  if (a.scoped) { where.push('company_id = ?'); args.push(a.params[0]); }
  if (direction) { where.push('direction = ?'); args.push(direction); }
  if (partner_id) { where.push('partner_id = ?'); args.push(partner_id); }
  const rows = db.prepare(
    `SELECT * FROM payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pay_date DESC, id DESC LIMIT 300`
  ).all(...args);
  const detail = rows.map((p) => {
    const allocs = db.prepare(
      `SELECT a.*, CASE WHEN a.invoice_kind='ar' THEN (SELECT bill_no FROM ar_invoices WHERE id=a.invoice_id)
                         ELSE (SELECT bill_no FROM ap_invoices WHERE id=a.invoice_id) END AS bill_no
       FROM payment_allocations a WHERE a.payment_id = ?`
    ).all(p.id);
    return { ...p, allocations: allocs };
  });
  return ok(res, detail);
}));

/**
 * 登记收付款并核销
 * body: { direction, partner_id, partner_name, amount, method, pay_date, remark,
 *         allocations: [{ invoice_id, amount }] }
 */
router.post('/payments', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const direction = b.direction === 'out' ? 'out' : 'in';
  const kind = direction === 'in' ? 'ar' : 'ap';
  const { table } = INVOICE[kind];

  // 币种：客户汇美金就填美金原币 + 汇率，本币金额自动换算；核销一律用本币
  const currency = String(b.currency || 'CNY').toUpperCase();
  const rate = currency === 'CNY'
    ? 1
    : (Number(b.rate) || Number(getSettings().exchangeRate) || 1);
  const amountOrig = currency === 'CNY' ? r2(b.amount || b.amount_orig) : r2(b.amount_orig);
  const amount = currency === 'CNY' ? amountOrig : r2(amountOrig * rate);
  if (currency !== 'CNY' && !(amountOrig > 0)) return fail(res, 400, '外币收付款请填写原币金额与汇率');
  if (!(amount > 0)) return fail(res, 400, '金额必须大于 0');
  const partnerType = direction === 'in' ? 'customer' : 'supplier';
  const partnerName = b.partner_name || null;
  if (!partnerName) return fail(res, 400, direction === 'in' ? '请填写客户' : '请填写供应商');

  const allocs = Array.isArray(b.allocations) ? b.allocations.filter((a) => a && a.invoice_id && r2(a.amount) > 0) : [];
  const allocTotal = r2(allocs.reduce((s, a) => s + r2(a.amount), 0));
  if (allocTotal > amount + 0.005) {
    return fail(res, 400, `核销合计 ${allocTotal} 超过收款金额 ${amount}，请检查`);
  }

  const t = now();
  const payDate = b.pay_date || today();
  db.exec('BEGIN');
  try {
    /**
     * 一笔收付款只能结**同一主体**的账
     *
     * 这笔钱落在哪个主体的账上，取决于它核销了谁的发票。核销两家主体的发票时
     * 这个钱在两边账上都不对：一边多收、一边少收，而合计刚好对得上 —— 最难查的那种。
     * 所以遇到跨主体核销直接拒绝，让人分开登记。
     */
    const comps = new Set();
    for (const a of allocs) {
      const r = scope.assertRow(req.user, table, a.invoice_id, '账款');
      if (!r.ok) throw new Error(`账款 #${a.invoice_id} 不存在`);
      const inv = r.row;
      if (inv.status === 'void') throw new Error(`${inv.bill_no} 已作废，不能核销`);
      const open = openAmount(inv);
      if (r2(a.amount) > open + 0.005) {
        throw new Error(`${inv.bill_no} 未${direction === 'in' ? '收' : '付'}只有 ${open}，不能核销 ${r2(a.amount)}`);
      }
      comps.add(Number(inv.company_id) || 1);
    }
    if (comps.size > 1) throw new Error('同一笔收付款不能跨主体核销（涉及 ' + [...comps].join(' / ') + '），请分开登记');
    const companyId = comps.size === 1 ? [...comps][0] : scope.writeCompanyOf(req.user, b.company_id);

    const info = db.prepare(
      `INSERT INTO payments (pay_no, direction, partner_type, partner_id, partner_name, currency, amount_orig, rate, amount, method, pay_date, status, remark, operator, created_at, company_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      nextPayNo(direction), direction, partnerType, b.partner_id || null, partnerName,
      currency, amountOrig, rate, amount, b.method || '银行转账', payDate, 'valid', b.remark || null, req.user.username, t, companyId
    );
    const payId = Number(info.lastInsertRowid);

    for (const a of allocs) {
      db.prepare('INSERT INTO payment_allocations (payment_id, invoice_kind, invoice_id, amount, created_at) VALUES (?,?,?,?,?)')
        .run(payId, kind, a.invoice_id, r2(a.amount), t);
      syncStatus(kind, a.invoice_id);
    }
    db.exec('COMMIT');

    return ok(res, {
      id: payId,
      pay_no: db.prepare('SELECT pay_no FROM payments WHERE id = ?').get(payId).pay_no,
      currency, amount_orig: amountOrig, rate, amount,
      allocated: allocTotal,
      unallocated: r2(amount - allocTotal)
    });
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
}));

/** 红冲：款项作废，核销金额退回各账款 */
router.post('/payments/:id/reverse', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const pay = invoiceInScope(req.user, 'payments', req.params.id, '收付款记录');
  if (pay.status === 'reversed') return fail(res, 400, '已经红冲过');
  const reason = ((req.body && req.body.reason) || '').trim();
  if (!reason) return fail(res, 400, '请填写红冲原因');

  const kind = pay.direction === 'in' ? 'ar' : 'ap';
  const allocs = db.prepare('SELECT * FROM payment_allocations WHERE payment_id = ?').all(pay.id);

  db.exec('BEGIN');
  try {
    db.prepare("UPDATE payments SET status='reversed', reversed_at=?, reverse_reason=? WHERE id=?")
      .run(now(), reason, pay.id);
    // 明细保留（可追溯），状态重算时只统计 valid 的款项
    allocs.forEach((a) => syncStatus(kind, a.invoice_id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, { id: pay.id, status: 'reversed', released: allocs.reduce((s, a) => s + r2(a.amount), 0) });
}));

/** 某客户/供应商还有哪些未结账款（登记收款时给前端选） */
router.get('/open-invoices', authRequired, wrap(async (req, res) => {
  const kind = req.query.kind === 'ap' ? 'ap' : 'ar';
  const { table } = INVOICE[kind];
  const partnerId = req.query.partner_id;
  const where = [S.OPEN_SQL];
  const args = [];
  const a = sc(req.user);
  if (a.scoped) { where.push('company_id = ?'); args.push(a.params[0]); }
  if (partnerId) {
    where.push(`${kind === 'ar' ? 'customer_id' : 'supplier_id'} = ?`);
    args.push(partnerId);
  }
  const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY due_date IS NULL, due_date, id`).all(...args)
    .map((r) => ({ ...withCurrency(r), aging_days: agingDays(r) }));
  return ok(res, rows);
}));

module.exports = router;
module.exports.openARForOrder = openARForOrder;
module.exports.openAPForPurchase = openAPForPurchase;
