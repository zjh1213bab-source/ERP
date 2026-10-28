/**
 * 坏账准备计提
 * ============================================================
 * 应收账款 450 万在账上都是资产，但逾期 90 天以上的那部分实际能收回来的可能不到一半。
 * 会计上必须按账龄计提「坏账准备」，把这部分从资产里减掉 ——
 * 否则利润是虚的，报表给银行/投资人看也不成立。
 *
 * ## 四条口径（第一条最容易被写错）
 *
 * 1. **计的是「期末准备余额」，不是「本期费用」**
 *    坏账准备是余额概念（备抵科目 1231 的贷方余额）。每期做的是**差额**：
 *      本期计提 = 期末应有准备 − 期初已有准备
 *    正数补提（借 6702 贷 1231），负数冲回（借 1231 贷 6702）。
 *    直接按「应收 × 比例」记费用，第 2 个月会再提一次同样金额，准备越滚越大，
 *    纯属虚增费用（这是手工做账最常犯的错）。
 *
 * 2. **集团内部往来不计提**
 *    内部往来不是信用风险，计提只会在合并报表里虚增费用。
 *    按 `intercompany_parties` 判断，与催收模块同一口径。
 *
 * 3. **已核销坏账的按 100% 计提**
 *    催收单上认定「收不回」并结案的那部分，虽然发票还挂在账上（没走核销应收的手续），
 *    但准备必须全额提 —— 不然等于系统里同时承认「收不回」和「这是好资产」。
 *
 * 4. **比例按主体可配**
 *    制造业和贸易、国内和海外，账龄风险不一样。比例表 `bad_debt_policies` 按主体存，
 *    页面上能改，改完重算即可（不影响已过账的历史凭证）。
 *
 * ## 账龄档
 *   未到期 / 逾期 1-30 / 31-60 / 61-90 / 90 天以上
 *   与驾驶舱账龄、催收等级用同一套分档，避免「同一个客户在不同页面落在不同档」。
 */
const { db } = require('../db');
const gl = require('./gl');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const today = () => new Date().toISOString().slice(0, 10);

/** 与 cockpit / collection 保持一致的账龄档 */
const BUCKETS = [
  { key: 'current', label: '未到期', min: -99999, max: -1 },
  { key: 'd1_30', label: '逾期 1-30 天', min: 0, max: 30 },
  { key: 'd31_60', label: '逾期 31-60 天', min: 31, max: 60 },
  { key: 'd61_90', label: '逾期 61-90 天', min: 61, max: 90 },
  { key: 'd90p', label: '逾期 90 天以上', min: 91, max: 999999 }
];

function bucketOf(overdueDays) {
  const d = Number(overdueDays);
  return BUCKETS.find((b) => d >= b.min && d <= b.max) || BUCKETS[0];
}

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function daysBetween(a, b) {
  const x = Date.parse(String(a).slice(0, 10) + 'T00:00:00');
  const y = Date.parse(String(b).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(x) || Number.isNaN(y)) return 0;
  return Math.round((x - y) / 86400000);
}

/* ------------------------------------------------------------------ *
 * 比例
 * ------------------------------------------------------------------ */

/** 某主体的计提比例（缺档按 0，并在返回里标出来，不猜） */
function policy(companyId) {
  const co = gl.companyOf(companyId);
  const rows = db
    .prepare('SELECT bucket, rate, note FROM bad_debt_policies WHERE company_id = ?')
    .all(co);
  const map = {};
  rows.forEach((x) => { map[x.bucket] = { rate: num(x.rate), note: x.note }; });
  return BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    rate: map[b.key] ? map[b.key].rate : 0,
    note: map[b.key] ? map[b.key].note : null,
    missing: !map[b.key]
  }));
}

function savePolicy(list, companyId) {
  const co = gl.companyOf(companyId);
  if (!Array.isArray(list) || !list.length) throw bad('比例清单为空');
  const t = new Date().toISOString();
  db.exec('BEGIN');
  try {
    list.forEach((x) => {
      const key = String(x.bucket || x.key || '');
      if (!BUCKETS.some((b) => b.key === key)) throw bad(`未知账龄档：${key}`);
      const rate = num(x.rate);
      if (rate < 0 || rate > 100) throw bad(`比例必须在 0-100 之间（${key} 传了 ${rate}）`);
      const has = db
        .prepare('SELECT id FROM bad_debt_policies WHERE company_id = ? AND bucket = ?')
        .get(co, key);
      if (has) {
        db.prepare('UPDATE bad_debt_policies SET rate=?, note=?, updated_at=? WHERE id=?')
          .run(rate, x.note || null, t, has.id);
      } else {
        db.prepare(
          'INSERT INTO bad_debt_policies (company_id, bucket, rate, note, created_at, updated_at) VALUES (?,?,?,?,?,?)'
        ).run(co, key, rate, x.note || null, t, t);
      }
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return policy(co);
}

/* ------------------------------------------------------------------ *
 * 账龄明细
 * ------------------------------------------------------------------ */

/** 集团内部客户（与催收模块同一口径：查表，不猜名字） */
function internalSet() {
  try {
    return new Set(
      db
        .prepare(
          "SELECT ref_id FROM intercompany_parties WHERE ref_type='customer' AND IFNULL(status,'active')='active' AND ref_id IS NOT NULL"
        )
        .all()
        .map((x) => Number(x.ref_id))
    );
  } catch (e) {
    return new Set();
  }
}

/** 已被催收认定为坏账的发票（结案原因 bad_debt） */
function writtenOffSet() {
  try {
    return new Set(
      db
        .prepare(
          `SELECT DISTINCT i.invoice_id
             FROM collection_task_items i
             JOIN collection_tasks t ON t.id = i.task_id
            WHERE t.status = 'closed' AND t.closed_reason = 'bad_debt'`
        )
        .all()
        .map((x) => Number(x.invoice_id))
    );
  } catch (e) {
    return new Set();
  }
}

/**
 * 账龄明细（到 asOf 为止已开票且未收的部分）
 *
 * 口径与 `ar_tie` 关账检查一致：`created_at <= 期末`，
 * 否则会出现「账上 1122 有这笔、计提明细里却没有」的对不上。
 */
function aging(asOf, companyId) {
  const co = gl.companyOf(companyId);
  const end = String(asOf).slice(0, 10);
  const internal = internalSet();
  const off = writtenOffSet();

  const rows = db
    .prepare(
      `SELECT id, bill_no, customer_id, customer_name, currency, amount, paid_amount, due_date, created_at
         FROM ar_invoices
        WHERE status <> 'void' AND company_id = ?
          AND amount - COALESCE(paid_amount,0) > 0.005
          AND substr(created_at,1,10) <= ?
        ORDER BY IFNULL(due_date, created_at) ASC, id ASC`
    )
    .all(co, end)
    .map((r) => {
      const open = r2(num(r.amount) - num(r.paid_amount));
      // 没有到期日的按开票日算（与账龄统计一致，不留「永不到期」的后门）
      const base = String(r.due_date || r.created_at || end).slice(0, 10);
      const overdue = daysBetween(end, base);
      const b = bucketOf(overdue);
      const isInternal = internal.has(Number(r.customer_id));
      const isWrittenOff = off.has(Number(r.id));
      return {
        invoice_id: r.id,
        bill_no: r.bill_no,
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        currency: r.currency || 'CNY',
        open_amount: open,
        due_date: r.due_date,
        billed_at: String(r.created_at || '').slice(0, 10),
        overdue_days: overdue,
        bucket: b.key,
        bucket_label: b.label,
        is_internal: isInternal,
        written_off: isWrittenOff,
        // 内部往来不参与计提；已核销坏账按 100%
        provision_rate: isInternal ? 0 : (isWrittenOff ? 100 : null)
      };
    });

  return rows;
}

/* ------------------------------------------------------------------ *
 * 测算与过账
 * ------------------------------------------------------------------ */

/**
 * 测算某期间的坏账准备（不写库）
 *
 * @returns 目标准备 / 账面已有准备 / 差额 / 分档明细 / 拟生成的凭证分录
 */
function preview(period, companyId) {
  const co = gl.companyOf(companyId);
  const pr = gl.periodRange(period);
  const pol = policy(co);
  const rateOf = {};
  pol.forEach((x) => { rateOf[x.key] = x.rate; });

  const rows = aging(pr.end, co);

  // 分档汇总
  const buckets = BUCKETS.map((b) => {
    const list = rows.filter((r) => r.bucket === b.key && !r.is_internal && !r.written_off);
    const amount = r2(list.reduce((a, r) => a + r.open_amount, 0));
    const rate = num(rateOf[b.key]);
    return {
      key: b.key,
      label: b.label,
      rate,
      amount,
      provision: r2((amount * rate) / 100),
      invoice_count: list.length
    };
  });

  const internalRows = rows.filter((r) => r.is_internal);
  const offRows = rows.filter((r) => r.written_off && !r.is_internal);

  const targetNormal = r2(buckets.reduce((a, b) => a + b.provision, 0));
  const targetOff = r2(offRows.reduce((a, r) => a + r.open_amount, 0));
  const target = r2(targetNormal + targetOff);

  // 账面已有准备：1231 的期末贷方余额（备抵科目，credit 方向 end = 贷 − 借）
  const bal = gl.balances(period, co).find((b) => b.code === '1231');
  const current = r2(bal ? bal.end : 0);

  const diff = r2(target - current);
  const t = new Date().toISOString();
  const entries = [];
  if (diff > 0.005) {
    entries.push({ code: '6702', debit: diff, credit: 0, summary: '计提坏账准备' });
    entries.push({ code: '1231', debit: 0, credit: diff, summary: '计提坏账准备' });
  } else if (diff < -0.005) {
    entries.push({ code: '1231', debit: r2(-diff), credit: 0, summary: '冲回多提的坏账准备' });
    entries.push({ code: '6702', debit: 0, credit: r2(-diff), summary: '冲回多提的坏账准备' });
  }

  const existed = db
    .prepare(
      "SELECT id, voucher_no, status, debit_total FROM gl_vouchers WHERE company_id=? AND period=? AND source_type='bad_debt' ORDER BY id DESC LIMIT 1"
    )
    .get(co, period);

  return {
    period,
    company_id: co,
    as_of: pr.end,
    policy: pol,
    buckets,
    totals: {
      ar_open: r2(rows.reduce((a, r) => a + r.open_amount, 0)),
      // 参与计提的部分
      base_amount: r2(buckets.reduce((a, b) => a + b.amount, 0)),
      target_normal: targetNormal,
      written_off_amount: targetOff,
      written_off_count: offRows.length,
      target,             // 期末应有准备余额
      current,            // 账面已有准备（1231 贷方余额）
      diff,               // 本期应补提（负数=冲回）
      internal_amount: r2(internalRows.reduce((a, r) => a + r.open_amount, 0)),
      internal_count: internalRows.length,
      // 计提后的应收净额
      net_ar: r2(rows.reduce((a, r) => a + r.open_amount, 0) - target)
    },
    entries,
    action: diff > 0.005 ? 'provision' : (diff < -0.005 ? 'reverse' : 'none'),
    action_label: diff > 0.005 ? '补提' : (diff < -0.005 ? '冲回' : '无需计提'),
    existing_voucher: existed || null,
    // 明细（页面展开用，内部往来与已核销单独标出来）
    detail: {
      normal: rows.filter((r) => !r.is_internal && !r.written_off),
      internal: internalRows,
      written_off: offRows
    },
    generated_at: t
  };
}

/**
 * 过账：把本期应计提额写成凭证
 *
 * 幂等：同一主体同一期间只有一张 `bad_debt` 凭证。
 * 已存在时**必须显式 force** 才重建（先作废旧凭证），否则报错 ——
 *  silently 覆盖别人已经过账的凭证是最不该发生的事。
 */
function post(period, opt = {}) {
  const co = gl.companyOf(opt.company_id);
  gl.assertOpen(period, co);
  const pv = preview(period, co);

  if (pv.action === 'none') {
    return { skipped: true, message: '本期无需计提（应有准备与账面一致）', preview: pv };
  }

  const existed = db
    .prepare(
      "SELECT id, voucher_no, status FROM gl_vouchers WHERE company_id=? AND period=? AND source_type='bad_debt' ORDER BY id DESC LIMIT 1"
    )
    .get(co, period);
  if (existed && existed.status === 'posted' && !opt.force) {
    throw bad(
      `${period} 已经有一张坏账计提凭证（${existed.voucher_no}）。` +
        '要按新比例重算，请勾选「覆盖重算」—— 它会作废旧凭证再开一张，不删除历史。'
    );
  }
  if (existed) gl.voidVoucher(existed.id, opt.force ? '坏账计提重算' : '重做');

  const vid = gl.writeVoucher({
    period,
    biz_date: gl.periodRange(period).end,
    summary: `${period} 坏账准备${pv.action_label} ${pv.totals.diff > 0 ? '' : '（冲回）'}¥${Math.abs(pv.totals.diff)}`,
    source_type: 'bad_debt',
    // 一个期间一张：source_id 用期间数字（与损益结转同一套约定）
    source_id: Number(String(period).replace('-', '')),
    entries: pv.entries,
    operator: opt.operator,
    company_id: co
  });

  return {
    skipped: false,
    voucher_id: vid,
    voucher_no: db.prepare('SELECT voucher_no FROM gl_vouchers WHERE id = ?').get(vid).voucher_no,
    action: pv.action,
    action_label: pv.action_label,
    amount: Math.abs(pv.totals.diff),
    target: pv.totals.target,
    before: pv.totals.current,
    preview: pv
  };
}

/** 计提历史（每个期间一张，带凭证状态） */
function history(companyId, limit = 24) {
  const co = gl.companyOf(companyId);
  return db
    .prepare(
      `SELECT v.id, v.period, v.voucher_no, v.biz_date, v.status, v.debit_total, v.summary, v.created_by, v.created_at
         FROM gl_vouchers v
        WHERE v.company_id = ? AND v.source_type = 'bad_debt'
        ORDER BY v.period DESC, v.id DESC
        LIMIT ?`
    )
    .all(co, Math.min(Math.max(Number(limit) || 24, 1), 120));
}

/**
 * 给关账检查用：本期是否已计提
 *
 * 只在「有需要计提的敞口」时才要求 —— 没有应收的期间不该被这条卡住。
 */
function checkForClose(period, companyId) {
  const co = gl.companyOf(companyId);
  const pv = preview(period, co);
  if (pv.totals.target <= 0.005) {
    return { passed: true, amount: 0, detail: '本期没有需要计提的应收敞口' };
  }
  const v = db
    .prepare(
      "SELECT voucher_no FROM gl_vouchers WHERE company_id=? AND period=? AND source_type='bad_debt' AND status='posted'"
    )
    .get(co, period);
  if (v) {
    return { passed: true, amount: pv.totals.target, detail: `已计提，准备余额 ${pv.totals.target}（${v.voucher_no}）` };
  }
  return {
    passed: false,
    amount: pv.totals.diff,
    detail: `期末应收敞口 ${pv.totals.base_amount}，应有坏账准备 ${pv.totals.target}，本期未计提`
  };
}

module.exports = {
  BUCKETS,
  bucketOf,
  policy,
  savePolicy,
  aging,
  preview,
  post,
  history,
  checkForClose,
  internalSet,
  writtenOffSet
};
