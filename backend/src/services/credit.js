/**
 * 客户信用与账期管控
 *
 * ## 为什么要有这个模块
 * `customers.credit_limit` 这个字段从第一天就在，前端能填、客户列表能显示，
 * 但**全系统没有任何一处拿它做过判断** —— 填 500 万和填 0 完全一样。
 * 结果就是「额度」变成了一张填给审计看的表：纸面上有授信，实际发货一分钱不限。
 *
 * 这个模块只做一件事：**在货出门那一刻，把「这家客户还能不能再赊」算清楚**。
 *
 * ## 口径（这一节是全部争议的来源，必须记死）
 *
 * ### 1. 额度 0 = 不管理，不是零额度
 * 28 个客户里只有 22 家填了额度，剩下 6 家要是按「0 就是不许赊」处理，
 * 他们立刻全部发不出货 —— 系统会被人当成坏掉的。所以：
 *   `limit <= 0` → `unmanaged`，只统计不拦。
 * 要真做到「零额度不许赊」，就把额度设成 1 元，别用 0 表示。
 *
 * ### 2. 敞口 = 已开票未收 + 未开票的订单余额
 * 只算发票是不够的：**货已经发走、票还没开**的单子在账上完全看不见，
 * 而这恰恰是风险最大的一类（钱和货都不在自己手上）。
 *   敞口 = Σ(发票金额 − 已收) + Σ(订单金额 − 该单已开票金额)
 * 订单部分只算 `assigned / production / instock / shipped`，
 * 草稿和技术确认中的单子不算 —— 那些还没投料，改一改就没了。
 *
 * ### 3. 逾期按到期日，宽限期默认 7 天
 * 到期日过了一天就拦，业务上没法干活（客户财务走流程本来就要几天）。
 * 宽限期内只警告（warn），超过才拦（block）。宽限期放 app_config，可按需调。
 * 到期日为空的发票按开票日 + 客户账期算 —— **不许当成「永不到期」**，
 * 那等于给自己留了个后门。
 *
 * ### 4. 所有「放行」都要留纸
 * 额度不够但业务必须发（老客户、大单、老板拍板），走 `credit_overrides`：
 * 必须写 ≥8 字理由，一张放行单只能用一次，且绑死订单。
 * 「谁批的、什么时候批的、当时超多少」全部落库 —— 出事时这条记录就是唯一的凭据。
 */
const { db, now } = require('../db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n) || 0;

/** 本地日期 YYYY-MM-DD。now() 是 UTC ISO，直接切会跨天错位 */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayDiff(a, b) {
  if (!a || !b) return 0;
  const t1 = Date.parse(String(a).slice(0, 10) + 'T00:00:00');
  const t2 = Date.parse(String(b).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0;
  return Math.round((t2 - t1) / 86400000);
}

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/** 全局配置（宽限期等）。表是 key/value，存 JSON 字符串 */
const CFG_KEY = 'credit';

function config() {
  let raw = null;
  try {
    raw = db.prepare('SELECT value FROM app_config WHERE key = ?').get(CFG_KEY);
  } catch (e) { /* 表还没建就吃默认值 */ }
  let v = {};
  try { v = raw ? JSON.parse(raw.value) : {}; } catch (e) { v = {}; }
  return {
    // 逾期多少天以内只警告不拦。设 0 = 一天都不宽限
    grace_days: v.grace_days === undefined ? 7 : Math.max(0, Number(v.grace_days) || 0),
    // 占用达到这个比例就预警
    warn_ratio: v.warn_ratio === undefined ? 0.8 : Math.min(1, Math.max(0.1, Number(v.warn_ratio) || 0.8)),
    // 默认账期（客户没单独设时用）
    default_days: v.default_days === undefined ? 30 : Math.max(0, Number(v.default_days) || 0)
  };
}

function saveConfig(patch, operator) {
  const cur = config();
  const next = { ...cur };
  if (patch.grace_days !== undefined) next.grace_days = Math.max(0, Number(patch.grace_days) || 0);
  if (patch.warn_ratio !== undefined) next.warn_ratio = Math.min(1, Math.max(0.1, Number(patch.warn_ratio) || 0.8));
  if (patch.default_days !== undefined) next.default_days = Math.max(0, Number(patch.default_days) || 0);
  const t = now();
  db.prepare(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(CFG_KEY, JSON.stringify(next), t);
  return { ...next, updated_at: t, updated_by: operator || null };
}

// ============================================================
// 敞口计算
// ============================================================

/**
 * 算一个客户的敞口
 *
 * 返回的是「算给谁看」，不是「判给谁看」—— 判定在 judge() 里，
 * 因为发货预检和台账列表要的信息不一样（前者要拦，后者只要看）。
 */
function exposureOf(customerId, { asOf } = {}) {
  const asOfDay = asOf || todayStr();
  const cfg = config();

  const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!cust) return null;

  const limit = r2(cust.credit_limit);
  const days = cust.credit_days === null || cust.credit_days === undefined
    ? cfg.default_days
    : Number(cust.credit_days);

  // ---------- 1. 已开票未收 ----------
  // 到期日为空的不许当「永不到期」：按 开票日 + 客户账期 兜底算
  const invoices = db
    .prepare(
      `SELECT id, bill_no, order_id, amount, COALESCE(paid_amount,0) AS paid_amount,
              due_date, created_at, status
         FROM ar_invoices
        WHERE customer_id = ? AND status != 'void'
        ORDER BY due_date, id`
    )
    .all(customerId)
    .map((v) => {
      const billDate = String(v.created_at || '').slice(0, 10);
      const due = v.due_date
        ? String(v.due_date).slice(0, 10)
        : addDays(billDate, days);
      const open = r2(num(v.amount) - num(v.paid_amount));
      const overdueDays = open > 0 ? dayDiff(due, asOfDay) : 0;
      return {
        ...v,
        bill_date: billDate,
        due_date: due,
        due_estimated: !v.due_date,     // 到期日是算出来的，页面上要标
        open_amount: open,
        overdue_days: Math.max(0, overdueDays),
        is_overdue: open > 0 && overdueDays > 0
      };
    });

  const billedOpen = r2(invoices.reduce((s, v) => s + v.open_amount, 0));
  const overdueList = invoices.filter((v) => v.is_overdue);
  const overdue = r2(overdueList.reduce((s, v) => s + v.open_amount, 0));
  const maxOverdueDays = overdueList.reduce((m, v) => Math.max(m, v.overdue_days), 0);
  const oldestDue = invoices
    .filter((v) => v.open_amount > 0 && v.due_date)
    .reduce((m, v) => (!m || v.due_date < m ? v.due_date : m), '');

  // ---------- 2. 未开票的订单余额 ----------
  // 只算已经进入履约的单子（assigned 之后）；草稿/技术确认不算，那些还没投料
  const orders = db
    .prepare(
      `SELECT id, order_no, status, total_amount, currency, total_usd, created_at
         FROM orders
        WHERE customer_id = ?
          AND status IN ('assigned','production','instock','shipped')
        ORDER BY id`
    )
    .all(customerId)
    .map((o) => {
      // 该单已开票金额（作废的不算）—— 允许部分开票，只把剩下的算进敞口
      const inv = db
        .prepare(
          `SELECT COALESCE(SUM(amount),0) AS s FROM ar_invoices
            WHERE order_id = ? AND status != 'void'`
        )
        .get(o.id).s;
      const total = r2(num(o.total_amount));
      const unbilled = r2(Math.max(0, total - num(inv)));
      return {
        id: o.id,
        order_no: o.order_no,
        status: o.status,
        total_amount: total,
        invoiced: r2(num(inv)),
        unbilled,
        // 货已出门但票没开 —— 风险最高的一类，单独标出来
        shipped_unbilled: o.status === 'shipped' && unbilled > 0.005
      };
    })
    .filter((o) => o.unbilled > 0.005);

  const unbilled = r2(orders.reduce((s, o) => s + o.unbilled, 0));
  const shippedUnbilled = r2(
    orders.filter((o) => o.shipped_unbilled).reduce((s, o) => s + o.unbilled, 0)
  );
  // 还没发货的在途（生产/入库）—— 这些还撤得回来，账上单列
  const inFlight = r2(
    orders.filter((o) => o.status !== 'shipped').reduce((s, o) => s + o.unbilled, 0)
  );

  const exposure = r2(billedOpen + unbilled);
  const available = limit > 0 ? r2(limit - exposure) : null;
  const usagePct = limit > 0 ? Math.round((exposure / limit) * 1000) / 10 : null;
  const held = String(cust.credit_status || 'active') === 'hold';

  // ---------- 3. 风险等级 ----------
  // 顺序即优先级：冻结 > 超限 > 逾期 > 临界 > 正常
  let risk = 'ok';
  let risk_label = '正常';
  if (limit <= 0) {
    risk = 'unmanaged';
    risk_label = '未设额度';
  } else if (held) {
    risk = 'hold';
    risk_label = '已冻结';
  } else if (exposure > limit + 0.005) {
    risk = 'over';
    risk_label = '超额度';
  } else if (overdue > 0.005) {
    risk = 'overdue';
    risk_label = '有逾期';
  } else if (usagePct !== null && usagePct >= cfg.warn_ratio * 100) {
    risk = 'near';
    risk_label = '接近上限';
  }
  // 冻结的客户如果还超限，标签仍显示「已冻结」，但超限事实要在数字上看得见

  return {
    customer: {
      id: cust.id,
      code: cust.code,
      name: cust.name,
      level: cust.level,
      owner_name: cust.owner_name,
      status: cust.status,
      credit_limit: limit,
      credit_days: days,
      credit_status: held ? 'hold' : 'active',
      credit_hold_reason: cust.credit_hold_reason || null,
      credit_updated_at: cust.credit_updated_at || null
    },
    as_of: asOfDay,
    config: cfg,
    figures: {
      billed_open: billedOpen,
      unbilled,
      shipped_unbilled: shippedUnbilled,
      in_flight: inFlight,
      exposure,
      limit,
      available,
      usage_pct: usagePct,
      overdue,
      overdue_count: overdueList.length,
      max_overdue_days: maxOverdueDays,
      oldest_due: oldestDue || null,
      invoice_count: invoices.filter((v) => v.open_amount > 0.005).length,
      order_count: orders.length
    },
    risk,
    risk_label,
    invoices: invoices.filter((v) => v.open_amount > 0.005),
    orders
  };
}

function addDays(dateStr, n) {
  const d = new Date(String(dateStr || todayStr()).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return String(dateStr || '').slice(0, 10);
  d.setDate(d.getDate() + Number(n || 0));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ============================================================
// 判定
// ============================================================

/**
 * 发货前判定
 *
 * 注意：本单的金额**已经**在敞口里了（未开票订单余额里含它），
 * 所以这里不再加一次 —— 重复加会把正常单子误判成超限。
 */
function judge(orderId, { asOf } = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw bad('订单不存在', 404);

  // 没有客户档案的历史单：不拦，但要说明为什么不拦（否则看着像漏判）
  if (!order.customer_id) {
    return {
      order: { id: order.id, order_no: order.order_no, amount: r2(order.total_amount) },
      profile: null,
      level: 'ok',
      blocked: false,
      reasons: [],
      notes: [],
      tips: ['这张单没有关联客户档案，信用额度无法判定（历史单常见），未做限制']
    };
  }

  const p = exposureOf(order.customer_id, { asOf });
  if (!p) {
    return {
      order: { id: order.id, order_no: order.order_no, amount: r2(order.total_amount) },
      profile: null,
      level: 'ok',
      blocked: false,
      reasons: [],
      notes: [],
      tips: ['客户档案已不存在，未做限制']
    };
  }

  const f = p.figures;
  const cfg = p.config;
  const reasons = [];   // 拦下来的硬理由
  const notes = [];     // 需要注意的风险（会把 level 抬到 warn）
  const tips = [];      // 纯操作建议，不影响能不能发

  if (p.risk === 'unmanaged') {
    tips.push(
      `这家客户没设信用额度（额度 0 = 不管理），本次不限额。要管就先在「信用管控」里设额度 —— 设成 1 元表示零额度。`
    );
  } else {
    if (p.customer.credit_status === 'hold') {
      reasons.push(
        `客户已被冻结信用${p.customer.credit_hold_reason ? `（${p.customer.credit_hold_reason}）` : ''}，冻结期间一律不许发货`
      );
    }
    if (f.exposure > f.limit + 0.005) {
      reasons.push(
        `已超额度：额度 ${f.limit}，当前敞口 ${f.exposure}（已开票未收 ${f.billed_open} + 未开票订单 ${f.unbilled}），超 ${r2(f.exposure - f.limit)}`
      );
    }
    if (f.overdue > 0.005 && f.max_overdue_days > cfg.grace_days) {
      reasons.push(
        `有 ${f.overdue} 元逾期 ${f.max_overdue_days} 天（宽限 ${cfg.grace_days} 天），超过宽限期的不许再赊`
      );
    }
    if (f.overdue > 0.005 && f.max_overdue_days > 0 && f.max_overdue_days <= cfg.grace_days) {
      notes.push(
        `有 ${f.overdue} 元逾期 ${f.max_overdue_days} 天，还在 ${cfg.grace_days} 天宽限期内，本次放行但请催`
      );
    }
    if (f.shipped_unbilled > 0.005) {
      tips.push(
        `有 ${f.shipped_unbilled} 元货已发出但还没开票 —— 这部分在账上最容易被忽略，先去开票`
      );
    }
    if (f.usage_pct !== null && f.usage_pct >= cfg.warn_ratio * 100 && !reasons.length) {
      notes.push(`额度已用 ${f.usage_pct}%（预警线 ${Math.round(cfg.warn_ratio * 100)}%），注意控制后续接单`);
    }
  }

  const blocked = reasons.length > 0;
  return {
    order: {
      id: order.id,
      order_no: order.order_no,
      amount: r2(order.total_amount),
      status: order.status
    },
    profile: {
      customer_id: p.customer.id,
      customer_name: p.customer.name,
      limit: f.limit,
      exposure: f.exposure,
      available: f.available,
      usage_pct: f.usage_pct,
      overdue: f.overdue,
      max_overdue_days: f.max_overdue_days,
      risk: p.risk,
      risk_label: p.risk_label,
      credit_days: p.customer.credit_days,
      credit_status: p.customer.credit_status
    },
    // level 只看真正有风险的 notes；tips 是操作建议，不该让整张单「变黄」
    level: blocked ? 'block' : notes.length ? 'warn' : 'ok',
    blocked,
    reasons,
    notes,
    tips,
    // 放行单：本单还有没有没用掉的放行，直接带出来（页面不用再查一次）
    open_override: openOverrideOf(orderId)
  };
}

// ============================================================
// 台账
// ============================================================

/**
 * 信用台账：所有客户一行，按风险排序
 *
 * 排序把「有额度且危险」的排前面：冻结 > 超限 > 逾期 > 临界 > 未设额度 > 正常。
 * 未设额度的排在后面 —— 不是因为它重要，是因为它多（占多数时会把真问题挤到第二页）。
 */
function board({ q, risk, only_managed, limit = 300 } = {}) {
  const rows = db
    .prepare(
      `SELECT id FROM customers
        WHERE status != 'deleted'
        ORDER BY id`
    )
    .all()
    .map((c) => exposureOf(c.id))
    .filter(Boolean);

  let list = rows;
  if (q) {
    const k = String(q).toLowerCase();
    list = list.filter(
      (r) =>
        String(r.customer.name || '').toLowerCase().includes(k) ||
        String(r.customer.code || '').toLowerCase().includes(k) ||
        String(r.customer.owner_name || '').toLowerCase().includes(k)
    );
  }
  if (risk) list = list.filter((r) => r.risk === risk);
  if (only_managed) list = list.filter((r) => r.figures.limit > 0);

  const RANK = { hold: 0, over: 1, overdue: 2, near: 3, unmanaged: 4, ok: 5 };
  list = [...list].sort((a, b) => {
    const d = (RANK[a.risk] ?? 9) - (RANK[b.risk] ?? 9);
    if (d !== 0) return d;
    return num(b.figures.exposure) - num(a.figures.exposure);
  });

  const all = rows;
  const summary = {
    customers: all.length,
    managed: all.filter((r) => r.figures.limit > 0).length,
    held: all.filter((r) => r.customer.credit_status === 'hold').length,
    over: all.filter((r) => r.risk === 'over').length,
    overdue: all.filter((r) => r.risk === 'overdue').length,
    near: all.filter((r) => r.risk === 'near').length,
    unmanaged: all.filter((r) => r.risk === 'unmanaged').length,
    exposure: r2(all.reduce((s, r) => s + num(r.figures.exposure), 0)),
    exposure_managed: r2(
      all.filter((r) => r.figures.limit > 0).reduce((s, r) => s + num(r.figures.exposure), 0)
    ),
    limit: r2(all.reduce((s, r) => s + num(r.figures.limit), 0)),
    overdue_amount: r2(all.reduce((s, r) => s + num(r.figures.overdue), 0)),
    // 有多少家其实已经超了但没人管（额度为 0 却有大量在途）
    shadow: all.filter((r) => r.figures.limit <= 0 && r.figures.exposure > 0).length
  };
  summary.available = r2(summary.limit - summary.exposure_managed);

  return { as_of: todayStr(), config: config(), summary, rows: list.slice(0, Math.max(1, Number(limit) || 300)) };
}

// ============================================================
// 维护动作
// ============================================================

function setLimit(customerId, { credit_limit, credit_days, reason }, operator) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!c) throw bad('客户不存在', 404);
  const lim = Number(credit_limit);
  const days = Number(credit_days);
  if (!Number.isFinite(lim) || lim < 0) throw bad('额度要填 0 或正数（0 = 不管理）');
  if (!Number.isFinite(days) || days < 0 || days > 365) throw bad('账期填 0–365 天');
  const why = String(reason || '').trim();
  if (why.length < 4) throw bad('改额度必须写原因（至少 4 个字），以后要能解释给审计听');

  const oldLimit = r2(c.credit_limit);
  const oldDays = c.credit_days === null || c.credit_days === undefined ? null : Number(c.credit_days);
  if (Math.abs(oldLimit - lim) < 0.005 && oldDays === days) {
    throw bad('额度和账期都没变，不用改');
  }

  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE customers SET credit_limit = ?, credit_days = ?, credit_updated_at = ?, updated_at = ? WHERE id = ?`
    ).run(r2(lim), days, t, t, customerId);
    db.prepare(
      `INSERT INTO credit_limits (customer_id, credit_limit, credit_days, old_limit, old_days, reason, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(customerId, r2(lim), days, oldLimit, oldDays, why, operator || null, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return exposureOf(customerId);
}

/**
 * 冻结 / 解冻
 *
 * 冻结是纯人为动作（客户跑路传闻、老板电话），不需要等系统算出来超限。
 * 所以这里不做「你确定要冻吗」的二次判断 —— 人已经决定了，系统只负责留痕。
 */
function setHold(customerId, { action, reason }, operator) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!c) throw bad('客户不存在', 404);
  const act = action === 'release' ? 'release' : action === 'hold' ? 'hold' : null;
  if (!act) throw bad('action 只能是 hold 或 release');
  const why = String(reason || '').trim();
  if (why.length < 4) throw bad('冻结/解冻必须写原因（至少 4 个字）');

  const cur = String(c.credit_status || 'active');
  if (act === 'hold' && cur === 'hold') throw bad('这家客户已经是冻结状态');
  if (act === 'release' && cur !== 'hold') throw bad('这家客户本来就是正常状态');

  const p = exposureOf(customerId);
  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE customers SET credit_status = ?, credit_hold_reason = ?, updated_at = ? WHERE id = ?`
    ).run(act === 'hold' ? 'hold' : 'active', act === 'hold' ? why : null, t, customerId);
    db.prepare(
      `INSERT INTO credit_holds (customer_id, action, reason, exposure_snapshot, operator, created_at)
       VALUES (?,?,?,?,?,?)`
    ).run(customerId, act, why, p ? p.figures.exposure : null, operator || null, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return exposureOf(customerId);
}

/** 本单还没用掉的放行单 */
function openOverrideOf(orderId) {
  return (
    db
      .prepare(
        `SELECT * FROM credit_overrides
          WHERE order_id = ? AND used_at IS NULL
          ORDER BY id DESC LIMIT 1`
      )
      .get(orderId) || null
  );
}

/**
 * 开一张放行单
 *
 * 理由必须 ≥8 字：4 个字的理由是「客户急」，8 个字才可能写出「客户已付 30% 定金」。
 * 这条门槛不是形式主义 —— 审计问起来，唯一能自证的就是这句话。
 */
function createOverride({ orderId, reason }, operator) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw bad('订单不存在', 404);
  const why = String(reason || '').trim();
  if (why.length < 8) throw bad('放行理由至少 8 个字 —— 写下「为什么这次可以例外」，审计只认这句话');

  const exist = openOverrideOf(order.id);
  if (exist) throw bad(`这张单已经有一张没用掉的放行单（#${exist.id}），直接用它发货就行`);

  const j = judge(order.id);
  // 已经能正常发的单不需要放行单 —— 否则放行记录会变成「随手点一下就过」的万能钥匙
  if (!j.blocked) throw bad('这张单没有触发任何限制，不需要放行单（随手放行会让记录失去意义）');

  const t = now();
  const id = db
    .prepare(
      `INSERT INTO credit_overrides
         (order_id, customer_id, limit_snapshot, exposure_snapshot, order_amount, block_reasons, reason, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      order.id,
      order.customer_id || null,
      j.profile ? j.profile.limit : null,
      j.profile ? j.profile.exposure : null,
      r2(order.total_amount),
      JSON.stringify(j.reasons),
      why,
      operator || null,
      t
    ).lastInsertRowid;
  return { id, ...db.prepare('SELECT * FROM credit_overrides WHERE id = ?').get(id) };
}

/**
 * 核销放行单（发货时调用）
 *
 * 校验三件事：属于本单、还没用过、（顺手）仍是同一张客户。
 * 「一张放行单只能用一次」是硬约束 —— 能重复用的放行单等于没放行。
 */
function consumeOverride(overrideId, orderId, operator) {
  const ov = db.prepare('SELECT * FROM credit_overrides WHERE id = ?').get(overrideId);
  if (!ov) throw bad('放行单不存在', 404);
  if (Number(ov.order_id) !== Number(orderId)) throw bad('这张放行单不属于当前订单');
  if (ov.used_at) throw bad(`这张放行单已经在 ${ov.used_at} 用过了，一张只能用一次`);
  const t = now();
  db.prepare('UPDATE credit_overrides SET used_at = ?, used_by = ? WHERE id = ?').run(t, operator || null, overrideId);
  return { ...ov, used_at: t, used_by: operator || null };
}

// ============================================================
// 事件流（这一页要能解释「为什么现在是这样」）
// ============================================================

function events(customerId, limit = 60) {
  const lims = db
    .prepare('SELECT * FROM credit_limits WHERE customer_id = ? ORDER BY id DESC LIMIT ?')
    .all(customerId, limit)
    .map((v) => ({
      kind: 'limit',
      at: v.created_at,
      title: `额度 ${v.old_limit === null ? '—' : r2(v.old_limit)} → ${r2(v.credit_limit)} / 账期 ${v.old_days === null ? '—' : v.old_days} → ${v.credit_days} 天`,
      reason: v.reason,
      operator: v.operator
    }));
  const holds = db
    .prepare('SELECT * FROM credit_holds WHERE customer_id = ? ORDER BY id DESC LIMIT ?')
    .all(customerId, limit)
    .map((v) => ({
      kind: v.action,
      at: v.created_at,
      title: v.action === 'hold' ? `冻结信用（当时敞口 ${r2(v.exposure_snapshot)}）` : '解除冻结',
      reason: v.reason,
      operator: v.operator
    }));
  const ovs = db
    .prepare('SELECT * FROM credit_overrides WHERE customer_id = ? ORDER BY id DESC LIMIT ?')
    .all(customerId, limit)
    .map((v) => {
      const o = db.prepare('SELECT order_no FROM orders WHERE id = ?').get(v.order_id);
      return {
        kind: 'override',
        at: v.created_at,
        title: `发货放行 ${o ? o.order_no : '#' + v.order_id}（额度 ${r2(v.limit_snapshot)} / 敞口 ${r2(v.exposure_snapshot)}）`,
        reason: v.reason,
        operator: v.operator,
        used_at: v.used_at
      };
    });
  return [...lims, ...holds, ...ovs]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

module.exports = {
  config,
  saveConfig,
  todayStr,
  addDays,
  dayDiff,
  exposureOf,
  judge,
  board,
  setLimit,
  setHold,
  openOverrideOf,
  createOverride,
  consumeOverride,
  events
};
