/**
 * 总账服务：从业务单据生成凭证 → 科目余额 → 三表 → 关账检查
 * ------------------------------------------------------------
 * 设计取舍：
 * - **凭证由业务单据反推**（拉取式），不在业务路由里散写，避免开票/核销/工资各改一处。
 *   好处：可重跑补历史、口径只有一份；代价：需要按 source_type + source_id 做幂等。
 * - **不平不落库**：每张凭证生成后立刻校验借贷合计，不等下次检查。
 * - **损益结转单独一张凭证**：关账前必须把收入/费用类科目余额转到 4103 本年利润，
 *   否则下期利润会重复累计。
 */
const { db } = require('../db');
const { localNow } = require('./sla');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const TYPE_LABEL = {
  asset: '资产', liability: '负债', equity: '所有者权益', income: '收入', expense: '成本费用'
};
const MONTH_CN = { '01': '1月', '02': '2月', '03': '3月', '04': '4月', '05': '5月', '06': '6月', '07': '7月', '08': '8月', '09': '9月', '10': '10月', '11': '11月', '12': '12月' };

/**
 * 默认主体：总部优先，没有就取第一家。
 * 多主体改造前所有数据都归 1 号公司，所以缺省值必须能兜住老调用。
 */
function defaultCompany() {
  const r = db.prepare(
    "SELECT id FROM companies ORDER BY (CASE WHEN type='headquarters' THEN 0 ELSE 1 END), id LIMIT 1"
  ).get();
  return r ? r.id : 1;
}
function companyOf(id) {
  const cid = Number(id) || defaultCompany();
  return cid;
}
/** 主体中文名（报表表头用） */
function companyName(id) {
  const r = db.prepare('SELECT name, short_name FROM companies WHERE id=?').get(companyOf(id));
  return r ? (r.short_name || r.name) : `主体#${id}`;
}

/** 期间工具：2026-10 → { start:'2026-10-01', end:'2026-10-31' } */
function periodRange(period) {
  const [y, m] = String(period).split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}
function periodOf(dateStr) {
  return String(dateStr || '').slice(0, 7) || localNow().slice(0, 7);
}
function shiftPeriod(period, delta) {
  const [y, m] = String(period).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 凭证号：记-YYYYMM-0001（**按主体各自编号**，两家公司都从 0001 起） */
function nextVoucherNo(period, companyId) {
  const co = companyOf(companyId);
  const ym = String(period).replace('-', '');
  const n = db.prepare('SELECT COUNT(*) c FROM gl_vouchers WHERE company_id=? AND period=?').get(co, period).c + 1;
  return `记-${ym}-${String(n).padStart(4, '0')}`;
}

/** 下一笔分录行号 */
function acct(code) {
  return db.prepare('SELECT * FROM gl_accounts WHERE code=?').get(code);
}

/**
 * 写一张凭证（借贷必须平）
 * @returns {id|null} 平则返回 id；不平抛错
 */
function writeVoucher({ period, biz_date, summary, source_type, source_id, entries, operator, company_id }) {
  const co = companyOf(company_id);
  const lines = entries.filter((e) => num(e.debit) > 0.001 || num(e.credit) > 0.001);
  if (!lines.length) return null;
  const d = r2(lines.reduce((a, e) => a + num(e.debit), 0));
  const c = r2(lines.reduce((a, e) => a + num(e.credit), 0));
  if (Math.abs(d - c) > 0.01) {
    throw new Error(`凭证不平：借 ${d} / 贷 ${c}（${source_type}#${source_id}）`);
  }
  for (const e of lines) {
    if (!acct(e.code)) throw new Error(`科目 ${e.code} 不存在`);
  }

  const t = localNow();
  const no = nextVoucherNo(period, co);
  const vid = db.prepare(
    `INSERT INTO gl_vouchers (voucher_no,company_id,period,biz_date,summary,source_type,source_id,status,debit_total,credit_total,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(no, co, period, biz_date, summary || null, source_type, source_id == null ? null : source_id,
    'posted', d, c, operator || 'system', t, t).lastInsertRowid;

  const ins = db.prepare(
    `INSERT INTO gl_entries (voucher_id,company_id,period,line_no,account_code,account_name,summary,debit,credit,
       partner_type,partner_id,partner_name,department_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  lines.forEach((e, i) => {
    const a = acct(e.code);
    ins.run(vid, co, period, i + 1, e.code, a.name, e.summary || summary || null,
      r2(e.debit), r2(e.credit), e.partner_type || null, e.partner_id || null, e.partner_name || null,
      e.department_id || null, t);
  });
  return vid;
}

/** 作废凭证（留痕，不删分录） */
function voidVoucher(id, reason) {
  const v = db.prepare('SELECT * FROM gl_vouchers WHERE id=?').get(id);
  if (!v || v.status === 'void') return false;
  db.prepare("UPDATE gl_vouchers SET status='void', summary=COALESCE(summary,'')||?, updated_at=? WHERE id=?")
    .run(`\n[作废] ${reason || ''}`, localNow(), id);
  return true;
}

/** ==================== 凭证模板 ==================== */
/** 每条取数函数返回 [{period, biz_date, summary, source_id, entries}] */
const SOURCES = {
  /** 应收开票：借 应收账款 / 贷 主营业务收入 */
  ar_invoice(period, companyId) {
    const co = companyOf(companyId);
    const { start, end } = periodRange(period);
    const rows = db.prepare(
      `SELECT * FROM ar_invoices WHERE status<>'void' AND company_id=?
         AND substr(created_at,1,10) BETWEEN ? AND ?`
    ).all(co, start, end);
    return rows.filter((r) => num(r.amount) > 0).map((r) => ({
      period, source_id: r.id, biz_date: String(r.created_at).slice(0, 10),
      summary: `应收开票 ${r.bill_no}`,
      entries: [
        { code: '1122', debit: num(r.amount), credit: 0, summary: `应收 ${r.customer_name || ''}`,
          partner_type: 'customer', partner_id: r.customer_id, partner_name: r.customer_name },
        // 收入行也带对方：合并时据此识别「内部销售」，不带的话抵消不起来
        { code: '6001', debit: 0, credit: num(r.amount), summary: `销售收入 ${r.bill_no}`,
          partner_type: 'customer', partner_id: r.customer_id, partner_name: r.customer_name }
      ]
    }));
  },

  /** 应付开票：有采购单 → 原材料；否则 → 管理费用 */
  ap_invoice(period, companyId) {
    const co = companyOf(companyId);
    const { start, end } = periodRange(period);
    const rows = db.prepare(
      `SELECT * FROM ap_invoices WHERE status<>'void' AND company_id=?
         AND substr(created_at,1,10) BETWEEN ? AND ?`
    ).all(co, start, end);
    return rows.filter((r) => num(r.amount) > 0).map((r) => {
      const isPurchase = !!r.purchase_id;
      return {
        period, source_id: r.id, biz_date: String(r.created_at).slice(0, 10),
        summary: `应付开票 ${r.bill_no}`,
        entries: [
          { code: isPurchase ? '1403' : '6602', debit: num(r.amount), credit: 0,
            summary: isPurchase ? `采购入库 ${r.supplier_name || ''}` : `费用 ${r.supplier_name || ''}`,
            partner_type: 'supplier', partner_id: r.supplier_id, partner_name: r.supplier_name },
          { code: '2202', debit: 0, credit: num(r.amount), summary: `应付 ${r.supplier_name || ''}`,
            partner_type: 'supplier', partner_id: r.supplier_id, partner_name: r.supplier_name }
        ]
      };
    });
  },

  /** 收付款：in → 借 银行 / 贷 应收；out → 借 应付(或薪酬/其他) / 贷 银行 */
  payment(period, companyId) {
    const co = companyOf(companyId);
    const { start, end } = periodRange(period);
    const rows = db.prepare(
      `SELECT * FROM payments WHERE status<>'cancelled' AND reversed_at IS NULL AND company_id=?
        AND substr(created_at,1,10) BETWEEN ? AND ?`
    ).all(co, start, end);
    return rows.filter((r) => num(r.amount) > 0).map((r) => {
      const isIn = r.direction === 'in';
      const counter = isIn ? '1122' : (r.partner_type === 'employee' ? '2211' : r.partner_type === 'supplier' ? '2202' : '2241');
      return {
        period, source_id: r.id, biz_date: String(r.pay_date || r.created_at).slice(0, 10),
        summary: `${isIn ? '收款' : '付款'} ${r.pay_no}`,
        entries: isIn
          ? [
              { code: '1002', debit: num(r.amount), credit: 0, summary: `收到 ${r.partner_name || ''} 货款` },
              { code: counter, debit: 0, credit: num(r.amount), summary: `冲应收 ${r.partner_name || ''}`,
                partner_type: 'customer', partner_id: r.partner_id, partner_name: r.partner_name }
            ]
          : [
              { code: counter, debit: num(r.amount), credit: 0, summary: `支付 ${r.partner_name || ''}`,
                partner_type: r.partner_type, partner_id: r.partner_id, partner_name: r.partner_name },
              { code: '1002', debit: 0, credit: num(r.amount), summary: `付款 ${r.pay_no}` }
            ]
      };
    });
  },

  /** 已售成本结转：借 主营业务成本 / 贷 库存商品（按订单累计已售成本） */
  cost_sold(period, companyId) {
    const co = companyOf(companyId);
    const { start, end } = periodRange(period);
    // 用成本快照的结转记录作为触发点，避免累计值重复入账
    // 主体归属跟订单走：成本对象本身不存公司，订单才是销售主体
    const rows = db.prepare(
      `SELECT s.*, c.order_id, c.order_no, c.cost_no FROM cost_snapshots s
       JOIN cost_objects c ON c.id=s.cost_object_id
       LEFT JOIN orders o ON o.id=c.order_id
       WHERE substr(s.created_at,1,10) BETWEEN ? AND ? AND s.sold_cost > 0
         AND COALESCE(o.company_id, ?) = ?`
    ).all(start, end, co, co);
    return rows.map((r) => ({
      period, source_id: r.id, biz_date: String(r.created_at).slice(0, 10),
      summary: `成本结转 ${r.cost_no}（第 ${r.seq} 次）`,
      entries: [
        { code: '6401', debit: num(r.sold_cost), credit: 0, summary: `结转已售成本 ${r.cost_no}` },
        { code: '1405', debit: 0, credit: num(r.sold_cost), summary: `出库 ${r.cost_no}` }
      ]
    })).filter((x) => x.entries[0].debit > 0);
  },

  /** 工资计提：借 管理费用 / 贷 应付职工薪酬（按工资期，不含发放） */
  payroll(period, companyId) {
    const co = companyOf(companyId);
    const rows = db.prepare(
      "SELECT * FROM payrolls WHERE status<>'cancelled' AND period=? AND company_id=?"
    ).all(period, co);
    if (!rows.length) return [];
    const gross = r2(rows.reduce((a, r) => a + num(r.gross_pay), 0));
    if (gross <= 0) return [];
    return [{
      period, source_id: Number(String(period).replace('-', '')), biz_date: periodRange(period).end,
      summary: `计提 ${period} 工资（${rows.length} 人）`,
      entries: [
        { code: '6602', debit: gross, credit: 0, summary: `计提 ${period} 工资` },
        { code: '2211', debit: 0, credit: gross, summary: `应付职工薪酬 ${period}` }
      ]
    }];
  },

  /** 行政费用：借 管理费用 / 贷 银行存款 */
  expense(period, companyId) {
    const co = companyOf(companyId);
    const { start, end } = periodRange(period);
    const rows = db.prepare(
      'SELECT * FROM admin_expenses WHERE company_id=? AND substr(expense_date,1,10) BETWEEN ? AND ?'
    ).all(co, start, end);
    return rows.filter((r) => num(r.amount) > 0).map((r) => ({
      period, source_id: r.id, biz_date: String(r.expense_date).slice(0, 10),
      summary: `行政费用 ${r.category || ''} ${r.payee || ''}`,
      entries: [
        { code: '6602', debit: num(r.amount), credit: 0, summary: `${r.category || '费用'} ${r.payee || ''}`,
          department_id: r.department_id || null },
        { code: '1002', debit: 0, credit: num(r.amount), summary: `支付 ${r.payee || ''}` }
      ]
    }));
  },

  /** 折旧：借 管理费用 / 贷 累计折旧（按月直线法，同一资产同月只提一次） */
  depreciation(period, companyId) {
    const co = companyOf(companyId);
    const month = period;
    const rows = db.prepare(
      "SELECT * FROM assets WHERE company_id=? AND status IN ('active','in_use') AND original_value > 0 AND useful_years > 0"
    ).all(co);
    const list = [];
    rows.forEach((a) => {
      // 购入当月不提，次月起提
      const buyPeriod = periodOf(a.purchase_date);
      if (!buyPeriod || buyPeriod >= month) return;
      const salvage = num(a.salvage_rate) / 100;
      const monthly = r2((num(a.original_value) * (1 - salvage)) / (num(a.useful_years) * 12));
      if (monthly <= 0) return;
      list.push({
        period, source_id: a.id, biz_date: periodRange(period).end,
        summary: `折旧 ${a.name}（${month}）`,
        entries: [
          { code: '6602', debit: monthly, credit: 0, summary: `${a.name} 折旧` },
          { code: '1602', debit: 0, credit: monthly, summary: `${a.name} 累计折旧` }
        ]
      });
    });
    return list;
  }
};

/**
 * 生成期间凭证
 * @param {string} period
 * @param {object} opt { force, types, operator }
 */
function generateVouchers(period, opt = {}) {
  const co = companyOf(opt.company_id);
  const types = Array.isArray(opt.types) && opt.types.length ? opt.types : Object.keys(SOURCES);
  const existed = {};
  db.prepare('SELECT source_type, source_id, status FROM gl_vouchers WHERE company_id=? AND period=?').all(co, period)
    .forEach((v) => { existed[`${v.source_type}|${v.source_id}`] = v; });

  const result = { created: 0, skipped: 0, updated: 0, failed: [] };
  const t = localNow();

  db.exec('BEGIN');
  try {
    for (const type of types) {
      const fn = SOURCES[type];
      if (!fn) continue;
      let list = [];
      // 取数函数按主体过滤：老模板只收 period，多传一个参数无害
      try { list = fn(period, co) || []; } catch (e) {
        result.failed.push(`${type}: ${e.message}`);
        continue;
      }
      for (const item of list) {
        const key = `${type}|${item.source_id}`;
        const old = existed[key];
        if (old && old.status === 'posted' && !opt.force) { result.skipped += 1; continue; }
        if (old) {
          // 强制重建：作废旧凭证后重新开一张（唯一索引靠作废行的 source 冲突避免 → 先把旧行的 source 置空）
          db.prepare("UPDATE gl_vouchers SET status='void', source_type=source_type||'#void', source_id=NULL, updated_at=? WHERE id=?")
            .run(t, old.id);
          result.updated += 1;
        }
        try {
          const vid = writeVoucher({
            period, biz_date: item.biz_date, summary: item.summary,
            source_type: type, source_id: item.source_id,
            entries: item.entries, operator: opt.operator, company_id: co
          });
          if (vid) {
            result.created += 1;
            // 入了账就把「占用」核销掉，否则已发生与已承诺会重复计一次
            if (type === 'expense' || type === 'payroll') {
              try { require('./budget').consume(type, item.source_id); } catch (e) { /* 预算模块未启用时忽略 */ }
            }
          }
        } catch (e) {
          result.failed.push(`${type}#${item.source_id}: ${e.message}`);
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}

/**
 * 损益结转：把收入/费用类科目本期余额转到 4103 本年利润
 * 生成一张单独凭证（source_type='profit_carry'），关账前必须做
 */
function carryProfit(period, operator, companyId) {
  const co = companyOf(companyId);
  const { start, end } = periodRange(period);
  const exist = db.prepare(
    "SELECT id, status FROM gl_vouchers WHERE company_id=? AND period=? AND source_type='profit_carry' ORDER BY id DESC LIMIT 1"
  ).get(co, period);
  if (exist && exist.status === 'posted') {
    return { skipped: true, voucher_id: exist.id, message: '本期已结转' };
  }

  const rows = db.prepare(
    `SELECT e.account_code, a.name, a.type,
       COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
     JOIN gl_accounts a ON a.code=e.account_code
     WHERE v.company_id=? AND v.period=? AND v.status='posted' AND a.type IN ('income','expense')
     GROUP BY e.account_code`
  ).all(co, period);

  const entries = [];
  let net = 0;
  rows.forEach((r) => {
    if (r.type === 'income') {
      const bal = r2(r.c - r.d);
      if (Math.abs(bal) < 0.01) return;
      // 收入：借收入 / 贷本年利润
      entries.push({ code: r.account_code, debit: bal, credit: 0, summary: `结转 ${r.name}` });
      net += bal;
    } else {
      const bal = r2(r.d - r.c);
      if (Math.abs(bal) < 0.01) return;
      // 费用：贷费用 / 借本年利润
      entries.push({ code: r.account_code, debit: 0, credit: bal, summary: `结转 ${r.name}` });
      net -= bal;
    }
  });
  if (!entries.length) return { skipped: true, message: '本期没有损益类发生额' };

  const netR = r2(net);
  if (netR >= 0) entries.push({ code: '4103', debit: 0, credit: netR, summary: '结转本期利润' });
  else entries.push({ code: '4103', debit: -netR, credit: 0, summary: '结转本期亏损' });

  const vid = writeVoucher({
    period, biz_date: end, summary: `${period} 损益结转`,
    source_type: 'profit_carry', source_id: Number(String(period).replace('-', '')),
    entries, operator, company_id: co
  });
  return { skipped: false, voucher_id: vid, profit: netR, entry_count: entries.length };
}

/** ==================== 余额与报表 ==================== */
/** 科目余额（截至某期间，含期初与本期） */
function balances(period, companyId) {
  const co = companyOf(companyId);
  const { start, end } = periodRange(period);
  const accounts = db.prepare('SELECT * FROM gl_accounts ORDER BY sort_no, code').all();

  const prior = db.prepare(
    `SELECT e.account_code, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
     WHERE v.status='posted' AND e.company_id=? AND v.biz_date < ? GROUP BY e.account_code`
  ).all(co, start);
  const cur = db.prepare(
    `SELECT e.account_code, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
     WHERE v.status='posted' AND e.company_id=? AND v.biz_date BETWEEN ? AND ? GROUP BY e.account_code`
  ).all(co, start, end);

  const pm = {};
  prior.forEach((r) => { pm[r.account_code] = { d: num(r.d), c: num(r.c) }; });
  const cm = {};
  cur.forEach((r) => { cm[r.account_code] = { d: num(r.d), c: num(r.c) }; });

  return accounts.map((a) => {
    const p = pm[a.code] || { d: 0, c: 0 };
    const c = cm[a.code] || { d: 0, c: 0 };
    const beginBal = a.direction === 'debit' ? r2(p.d - p.c) : r2(p.c - p.d);
    const endBal = a.direction === 'debit' ? r2(p.d - p.c + c.d - c.c) : r2(p.c - p.d + c.c - c.d);
    return {
      code: a.code, name: a.name, type: a.type, type_label: TYPE_LABEL[a.type],
      direction: a.direction,
      begin: beginBal,
      period_debit: r2(c.d), period_credit: r2(c.c),
      end: endBal
    };
  });
}

/** 试算平衡表 */
function trialBalance(period, companyId) {
  const rows = balances(period, companyId).filter((r) => Math.abs(r.begin) > 0.001 || Math.abs(r.period_debit) > 0.001 || Math.abs(r.period_credit) > 0.001);
  const sum = rows.reduce((a, r) => ({
    begin_debit: a.begin_debit + (r.direction === 'debit' ? Math.max(r.begin, 0) : 0),
    begin_credit: a.begin_credit + (r.direction === 'credit' ? Math.max(r.begin, 0) : 0),
    debit: a.debit + r.period_debit,
    credit: a.credit + r.period_credit,
    end_debit: a.end_debit + (r.direction === 'debit' ? Math.max(r.end, 0) : 0),
    end_credit: a.end_credit + (r.direction === 'credit' ? Math.max(r.end, 0) : 0)
  }), { begin_debit: 0, begin_credit: 0, debit: 0, credit: 0, end_debit: 0, end_credit: 0 });
  Object.keys(sum).forEach((k) => { sum[k] = r2(sum[k]); });
  return { rows, sum, balanced: Math.abs(sum.debit - sum.credit) < 0.01 };
}

/** 资产负债表（期末） */
function balanceSheet(period, companyId) {
  const co = companyOf(companyId);
  const bs = balances(period, co);
  // 备抵科目（如 1602 累计折旧）余额在贷方，报表里要从资产中扣除
  const amountOf = (b) => (b.type === 'asset' && b.direction === 'credit' ? -b.end : b.end);
  const pick = (type) => bs.filter((b) => b.type === type && Math.abs(b.end) > 0.001)
    .map((b) => ({ code: b.code, name: b.name, amount: amountOf(b) }));
  const assets = pick('asset');
  const liabilities = pick('liability');
  const equity = pick('equity');

  // 已做损益结转的期间，利润已进 4103，不能再加一次「未结转损益」
  const hasCarry = !!db.prepare(
    "SELECT id FROM gl_vouchers WHERE company_id=? AND period=? AND source_type='profit_carry' AND status='posted'"
  ).get(co, period);
  const pnl = hasCarry ? { income: 0, expense: 0, net: 0 } : pnlOf(period, co);

  const sum = (arr) => r2(arr.reduce((a, x) => a + x.amount, 0));
  const eqTotal = r2(sum(equity) + pnl.net);
  return {
    period,
    company_id: co,
    company_name: companyName(co),
    assets, liabilities, equity,
    asset_total: sum(assets),
    liability_total: sum(liabilities),
    equity_total: eqTotal,
    profit_unposted: pnl.net,
    liability_equity_total: r2(sum(liabilities) + eqTotal),
    diff: r2(sum(assets) - sum(liabilities) - eqTotal),
    balanced: Math.abs(r2(sum(assets) - sum(liabilities) - eqTotal)) < 0.01
  };
}

/** 损益发生额（排除结转凭证，否则结转后收入费用会互相抵平算成 0） */
function pnlOf(period, companyId) {
  const co = companyOf(companyId);
  const rows = db.prepare(
    `SELECT a.type, COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
     JOIN gl_accounts a ON a.code=e.account_code
     WHERE v.company_id=? AND v.period=? AND v.status='posted' AND v.source_type<>'profit_carry'
       AND a.type IN ('income','expense')
     GROUP BY a.type`
  ).all(co, period);
  const income = r2(num(rows.find((r) => r.type === 'income')?.c) - num(rows.find((r) => r.type === 'income')?.d));
  const expense = r2(num(rows.find((r) => r.type === 'expense')?.d) - num(rows.find((r) => r.type === 'expense')?.c));
  return { income, expense, net: r2(income - expense) };
}

/**
 * 利润表（本期发生）
 * 必须排除损益结转凭证：结转是「借收入/贷本年利润」，算进去会把收入费用互相抵平。
 */
function incomeStatement(period, companyId) {
  const co = companyOf(companyId);
  const rows = db.prepare(
    `SELECT e.account_code, a.name, a.type,
       COALESCE(SUM(e.debit),0) d, COALESCE(SUM(e.credit),0) c
     FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
     JOIN gl_accounts a ON a.code=e.account_code
     WHERE v.company_id=? AND v.period=? AND v.status='posted' AND v.source_type<>'profit_carry'
       AND a.type IN ('income','expense')
     GROUP BY e.account_code ORDER BY e.account_code`
  ).all(co, period);
  const income = rows.filter((r) => r.type === 'income')
    .map((r) => ({ code: r.account_code, name: r.name, amount: r2(num(r.c) - num(r.d)) }))
    .filter((x) => Math.abs(x.amount) > 0.001);
  const expense = rows.filter((r) => r.type === 'expense')
    .map((r) => ({ code: r.account_code, name: r.name, amount: r2(num(r.d) - num(r.c)) }))
    .filter((x) => Math.abs(x.amount) > 0.001);
  const incomeTotal = r2(income.reduce((a, x) => a + x.amount, 0));
  const expenseTotal = r2(expense.reduce((a, x) => a + x.amount, 0));
  return {
    period,
    company_id: co,
    company_name: companyName(co),
    income, expense,
    income_total: incomeTotal,
    expense_total: expenseTotal,
    gross_profit: incomeTotal,
    net_profit: r2(incomeTotal - expenseTotal)
  };
}

/**
 * 现金流量表（直接法简易版）
 * 只看 1002 银行存款的分录，按对方科目归类
 */
function cashFlow(period, companyId) {
  const co = companyOf(companyId);
  const { start, end } = periodRange(period);
  const rows = db.prepare(
    `SELECT v.id, v.voucher_no, v.summary, e.account_code, e.debit, e.credit, e.partner_name
     FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
     WHERE v.status='posted' AND e.company_id=? AND v.biz_date BETWEEN ? AND ? AND e.account_code='1002'
     ORDER BY v.id`
  ).all(co, start, end);

  const groups = { operating_in: [], operating_out: [], investing_out: [], other_in: [], other_out: [] };
  const add = (bucket, name, amt) => {
    const g = groups[bucket];
    const hit = g.find((x) => x.name === name);
    if (hit) hit.amount = r2(hit.amount + amt);
    else g.push({ name, amount: r2(amt) });
  };

  rows.forEach((r) => {
    const vid = r.id;
    const others = db.prepare(
      'SELECT account_code, account_name, partner_name FROM gl_entries WHERE voucher_id=? AND account_code<>? ORDER BY line_no'
    ).all(vid, '1002');
    const counter = others[0];
    const isIn = num(r.debit) > 0;
    const amt = isIn ? num(r.debit) : num(r.credit);
    if (amt <= 0) return;
    let label = counter ? counter.account_name : '其他';
    if (counter && counter.partner_name) label += `·${counter.partner_name}`;

    if (!counter) {
      add(isIn ? 'other_in' : 'other_out', label, amt);
      return;
    }
    const code = counter.account_code;
    if (code === '1122' || code === '6001') add(isIn ? 'operating_in' : 'other_out', label, amt);
    else if (['2202', '2211', '6601', '6602', '6603', '1403'].includes(code)) add('operating_out', label, amt);
    else if (code === '1601' || code === '1602') add('investing_out', label, amt);
    else add(isIn ? 'other_in' : 'other_out', label, amt);
  });

  const sum = (arr) => r2(arr.reduce((a, x) => a + x.amount, 0));
  const oi = sum(groups.operating_in);
  const oo = sum(groups.operating_out);
  const io = sum(groups.investing_out);
  const xi = sum(groups.other_in);
  const xo = sum(groups.other_out);
  return {
    period,
    company_id: co,
    company_name: companyName(co),
    ...groups,
    operating_in_total: oi, operating_out_total: oo, operating_net: r2(oi - oo),
    investing_out_total: io, investing_net: r2(-io),
    other_in_total: xi, other_out_total: xo,
    net_increase: r2(oi - oo - io + xi - xo),
    closing_cash: r2(balances(period, co).find((b) => b.code === '1002')?.end || 0)
  };
}

/** ==================== 关账检查 ==================== */
const CHECKS = [
  {
    code: 'balance',
    name: '试算平衡（借贷合计相等）',
    run(period, co) {
      const tb = trialBalance(period, co);
      return { passed: tb.balanced, amount: r2(tb.sum.debit - tb.sum.credit), detail: `本期借 ${tb.sum.debit} / 贷 ${tb.sum.credit}` };
    }
  },
  {
    code: 'draft',
    name: '本期无草稿/异常凭证',
    run(period, co) {
      const n = db.prepare("SELECT COUNT(*) c FROM gl_vouchers WHERE company_id=? AND period=? AND status<>'posted'").get(co, period).c;
      return { passed: n === 0, amount: n, detail: n ? `${n} 张凭证非已过账状态` : '全部已过账' };
    }
  },
  {
    code: 'ar_tie',
    name: '应收账款科目余额 = 未收发票余额',
    run(period, co) {
      const acctBal = balances(period, co).find((b) => b.code === '1122')?.end || 0;
      const { end } = periodRange(period);
      const inv = db.prepare(
        `SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ar_invoices
         WHERE status<>'void' AND company_id=? AND substr(created_at,1,10) <= ?`
      ).get(co, end).s;
      const diff = r2(acctBal - num(inv));
      return { passed: Math.abs(diff) < 1, amount: diff, detail: `账面 ${r2(acctBal)} / 单据 ${r2(num(inv))}，差 ${diff}` };
    }
  },
  {
    code: 'ap_tie',
    name: '应付账款科目余额 = 未付发票余额',
    run(period, co) {
      const acctBal = balances(period, co).find((b) => b.code === '2202')?.end || 0;
      const { end } = periodRange(period);
      const inv = db.prepare(
        `SELECT COALESCE(SUM(amount - COALESCE(paid_amount,0)),0) s FROM ap_invoices
         WHERE status<>'void' AND company_id=? AND substr(created_at,1,10) <= ?`
      ).get(co, end).s;
      const diff = r2(acctBal - num(inv));
      return { passed: Math.abs(diff) < 1, amount: diff, detail: `账面 ${r2(acctBal)} / 单据 ${r2(num(inv))}，差 ${diff}` };
    }
  },
  {
    code: 'bill_posted',
    name: '业务单据已全部入账',
    run(period, co) {
      const { start, end } = periodRange(period);
      const un = db.prepare(
        `SELECT COUNT(*) c FROM ar_invoices a WHERE a.status<>'void' AND a.company_id=?
           AND substr(a.created_at,1,10) BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM gl_vouchers v WHERE v.status='posted' AND v.company_id=a.company_id
                           AND v.period=? AND v.source_type='ar_invoice' AND v.source_id=a.id)`
      ).get(co, start, end, period).c;
      return { passed: un === 0, amount: un, detail: un ? `${un} 张应收发票未入账` : '全部已入账' };
    }
  },
  {
    code: 'profit_carry',
    name: '损益类科目已结转',
    run(period, co) {
      const v = db.prepare(
        "SELECT id FROM gl_vouchers WHERE company_id=? AND period=? AND source_type='profit_carry' AND status='posted'"
      ).get(co, period);
      const inc = balances(period, co).filter((b) => b.type === 'income' || b.type === 'expense');
      const left = r2(inc.reduce((a, b) => a + Math.abs(b.period_debit - b.period_credit), 0));
      return {
        passed: !!v && left < 1,
        amount: left,
        detail: v ? (left < 1 ? '已结转' : `还有 ${left} 元损益未结转`) : '本期未做损益结转凭证'
      };
    }
  },
  {
    code: 'cash_negative',
    name: '银行存款余额不为负',
    run(period, co) {
      const bal = balances(period, co).find((b) => b.code === '1002')?.end || 0;
      return { passed: bal >= -0.01, amount: r2(bal), detail: `期末银行存款 ${r2(bal)}` };
    }
  },
  {
    code: 'cost_missing',
    name: '已发货订单成本已结转',
    run(period, co) {
      const { end } = periodRange(period);
      const rows = db.prepare(
        `SELECT o.id, o.order_no FROM orders o
         WHERE o.company_id=? AND o.status IN ('shipped','closed') AND substr(COALESCE(o.updated_at,''),1,10) <= ?
           AND NOT EXISTS (SELECT 1 FROM gl_vouchers v WHERE v.status='posted' AND v.company_id=o.company_id
                           AND v.source_type='cost_sold' AND v.period<=?)`
      ).all(co, end, period);
      return {
        passed: rows.length === 0, amount: rows.length,
        detail: rows.length ? `${rows.length} 张订单已发货但无成本结转凭证` : '已发货订单成本均已结转'
      };
    }
  }
];

/** 跑一遍检查并落库 */
function runChecks(period, companyId) {
  const co = companyOf(companyId);
  const t = localNow();
  const out = [];
  const ins = db.prepare(
    `INSERT INTO gl_close_checks (company_id,period,check_code,name,severity,passed,amount,detail,checked_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(company_id, period, check_code) DO UPDATE SET name=excluded.name, severity=excluded.severity,
       passed=excluded.passed, amount=excluded.amount, detail=excluded.detail, checked_at=excluded.checked_at`
  );
  db.prepare('DELETE FROM gl_close_checks WHERE company_id=? AND period=?').run(co, period);
  CHECKS.forEach((c) => {
    let r;
    try { r = c.run(period, co); } catch (e) { r = { passed: false, amount: 0, detail: '检查异常：' + e.message }; }
    const severity = c.code === 'cost_missing' ? 'warn' : 'error';
    ins.run(co, period, c.code, c.name, severity, r.passed ? 1 : 0, r2(r.amount), r.detail || '', t);
    out.push({ code: c.code, name: c.name, severity, passed: !!r.passed, amount: r2(r.amount), detail: r.detail });
  });
  return out;
}

/** 关账 */
function closePeriod(period, operator, companyId) {
  const co = companyOf(companyId);
  const p = ensurePeriod(period, co);
  if (p.status === 'closed') throw new Error('该期间已关账');
  const checks = runChecks(period, co);
  const failed = checks.filter((c) => !c.passed && c.severity === 'error');
  if (failed.length) {
    throw new Error('关账检查未通过：' + failed.map((c) => c.name).join('；'));
  }
  const tb = trialBalance(period, co);
  const is = incomeStatement(period, co);
  // 损益结转后收入/费用科目已被冲平，利润表会算成 0；
  // 有结转凭证时以 4103 本年利润当期发生额为准，没有才用利润表净额。
  const hasCarry = !!db.prepare(
    "SELECT id FROM gl_vouchers WHERE company_id=? AND period=? AND source_type='profit_carry' AND status='posted'"
  ).get(co, period);
  const p4103 = db.prepare(
    `SELECT COALESCE(SUM(e.credit),0) c, COALESCE(SUM(e.debit),0) d
     FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
     WHERE v.status='posted' AND e.company_id=? AND v.period=? AND e.account_code='4103'`
  ).get(co, period);
  const periodProfit = hasCarry ? r2(num(p4103.c) - num(p4103.d)) : is.net_profit;

  // 余额快照
  db.prepare('DELETE FROM gl_balances WHERE company_id=? AND period=?').run(co, period);
  const ins = db.prepare(
    `INSERT INTO gl_balances (company_id,period,account_code,debit_begin,credit_begin,debit_period,credit_period,debit_end,credit_end,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const nowStr = localNow();
  balances(period, co).forEach((b) => {
    const debitEnd = b.direction === 'debit' ? Math.max(b.end, 0) : Math.max(-b.end, 0);
    const creditEnd = b.direction === 'debit' ? Math.max(-b.end, 0) : Math.max(b.end, 0);
    const debitBegin = b.direction === 'debit' ? Math.max(b.begin, 0) : Math.max(-b.begin, 0);
    const creditBegin = b.direction === 'debit' ? Math.max(-b.begin, 0) : Math.max(b.begin, 0);
    ins.run(co, period, b.code, r2(debitBegin), r2(creditBegin), b.period_debit, b.period_credit, r2(debitEnd), r2(creditEnd), nowStr);
  });

  const vc = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(debit_total),0) d, COALESCE(SUM(credit_total),0) c2 FROM gl_vouchers WHERE company_id=? AND period=? AND status='posted'").get(co, period);
  db.prepare(
    `UPDATE gl_periods SET status='closed', voucher_count=?, debit_total=?, credit_total=?, profit=?,
       check_pass=1, check_fail_cnt=0, closed_by=?, closed_at=? WHERE company_id=? AND period=?`
  ).run(vc.c, r2(tb.sum.debit), r2(tb.sum.credit), periodProfit, operator || 'system', localNow(), co, period);

  return { period, company_id: co, company_name: companyName(co), status: 'closed',
    voucher_count: vc.c, debit_total: r2(tb.sum.debit), credit_total: r2(tb.sum.credit), profit: periodProfit, checks };
}

/** 反关账（必须写原因） */
function reopenPeriod(period, operator, reason, companyId) {
  const co = companyOf(companyId);
  const p = db.prepare('SELECT * FROM gl_periods WHERE company_id=? AND period=?').get(co, period);
  if (!p) throw new Error('期间不存在');
  if (p.status !== 'closed') throw new Error('该期间未关账');
  if (String(reason || '').trim().length < 4) throw new Error('反关账必须写原因（至少 4 个字）');
  db.prepare(
    `UPDATE gl_periods SET status='open', reopened_by=?, reopened_at=?, reopen_reason=?, closed_by=NULL, closed_at=NULL
     WHERE company_id=? AND period=?`
  ).run(operator || 'system', localNow(), reason, co, period);
  db.prepare('DELETE FROM gl_balances WHERE company_id=? AND period=?').run(co, period);
  return { period, company_id: co, status: 'open' };
}

/** 期间不存在则建 */
function ensurePeriod(period, companyId) {
  const co = companyOf(companyId);
  let p = db.prepare('SELECT * FROM gl_periods WHERE company_id=? AND period=?').get(co, period);
  if (p) return p;
  const { start, end } = periodRange(period);
  db.prepare(
    'INSERT INTO gl_periods (company_id,period,start_date,end_date,status,created_at) VALUES (?,?,?,?,?,?)'
  ).run(co, period, start, end, 'open', localNow());
  return db.prepare('SELECT * FROM gl_periods WHERE company_id=? AND period=?').get(co, period);
}

/** 期间是否可写（已关账不能改） */
function assertOpen(period, companyId) {
  const co = companyOf(companyId);
  const p = db.prepare('SELECT status FROM gl_periods WHERE company_id=? AND period=?').get(co, period);
  if (p && p.status === 'closed') throw new Error(`${period} 已关账，不能改凭证（需先反关账）`);
}

module.exports = {
  periodRange, periodOf, shiftPeriod, nextVoucherNo,
  writeVoucher, voidVoucher, generateVouchers, carryProfit,
  balances, trialBalance, balanceSheet, incomeStatement, pnlOf, cashFlow,
  runChecks, closePeriod, reopenPeriod, ensurePeriod, assertOpen,
  defaultCompany, companyOf, companyName,
  CHECKS, SOURCES, TYPE_LABEL, MONTH_CN, r2, num
};
