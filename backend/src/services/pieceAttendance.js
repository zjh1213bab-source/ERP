/**
 * 计件 × 考勤联动
 * ============================================================
 * 一句话：**报工那天人到底在不在？不在就别付钱。**
 *
 * 为什么需要这层：
 *   计件的输入是「报工」，而报工是人填的。车间里常见的三种情形：
 *     ① 班组长代报（人请假了，活是别人干的，名字还写他）→ 钱付错人
 *     ② 报工写错人（点错了下拉框）                        → 钱付错人
 *     ③ 虚报（人没来，凭空报一笔）                        → 白付钱
 *   以前这三种都查不出来：系统只看报工，从不看考勤。加上这层，至少能把
 *   **「考勤明确写了请假/旷工，却有一笔报工」** 这种铁证冲突挑出来。
 *
 * 三条设计红线（都为了「不误伤」）：
 *
 * 1. **没有出勤记录 ≠ 缺勤**。很多厂计件车间根本不打卡、或考勤漏录。
 *    所以「查不到当天考勤」只做提示（`no_attendance`），不进冲突清单、不扣钱。
 *    只有 `status = leave / absent`（有明确记录说人不在）才算冲突。
 *
 * 2. **默认不改一分钱**。`attendance_policy` 默认 `warn`：冲突笔照算金额，
 *    只在诊断里标红、并要求确认时写一句说明。要真扣钱得人工把策略改成
 *    `exclude`（剔除不计）或 `block`（不许确认）—— 这是主动决定，不是默认行为。
 *
 * 3. **封顶要两个前提同时成立**：`daily_cap_qty > 0` 且该人当月有考勤记录。
 *    没配日上限、或考勤整月空白时，**不封顶**（否则所有人都算 0 件，
 *    页面看着像系统坏了）。日上限是「车间一天最多能做多少件」，
 *    这个数只有厂里自己知道，系统不猜。
 *
 * 月度封顶的算法：`月上限 = 日上限 × 当月出勤天数（normal/late）`。
 * 缺勤越多、可拿的件数越少 —— 这就是「缺勤封顶」的原意：
 * 人没来，就产不出那么多件，报了也付不了。
 */
const { db, now } = require('../db');

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

const POLICIES = ['warn', 'exclude', 'block'];
const POLICY_LABEL = {
  warn: '只提示（照算，确认要写说明）',
  exclude: '剔除不计（冲突笔不付钱）',
  block: '不许确认（先处理干净）'
};

// ---------------- 配置 ----------------

function getConfig() {
  let row = db.prepare('SELECT * FROM piece_wage_config WHERE id = 1').get();
  if (!row) {
    db.prepare(
      "INSERT INTO piece_wage_config (id, daily_cap_qty, month_cap, attendance_policy, updated_at) VALUES (1, 0, 1, 'warn', ?)"
    ).run(now());
    row = db.prepare('SELECT * FROM piece_wage_config WHERE id = 1').get();
  }
  return {
    ...row,
    daily_cap_qty: round2(row.daily_cap_qty),
    month_cap: Number(row.month_cap) ? 1 : 0,
    policy_label: POLICY_LABEL[row.attendance_policy] || row.attendance_policy,
    // 前端要一眼看懂「现在到底有没有在管」
    effective: Number(row.daily_cap_qty) > 0
  };
}

function saveConfig(b = {}, operator) {
  const cap = b.daily_cap_qty === undefined ? 0 : Number(b.daily_cap_qty);
  if (!(cap >= 0)) throw bad('每人每日上限要填数字（0 = 不限制）');
  if (cap > 5000) throw bad('每人每日上限超过 5000 件不像真的，检查一下');
  const policy = String(b.attendance_policy || 'warn');
  if (!POLICIES.includes(policy)) throw bad('考勤冲突策略不合法');
  const monthCap = b.month_cap === undefined ? 1 : (b.month_cap ? 1 : 0);

  db.prepare(
    'UPDATE piece_wage_config SET daily_cap_qty=?, month_cap=?, attendance_policy=?, updated_by=?, updated_at=? WHERE id=1'
  ).run(round2(cap), monthCap, policy, operator || 'system', now());
  return getConfig();
}

// ---------------- 月度考勤 ----------------

/**
 * 读某月考勤，按员工聚合
 * @returns {{statusOf:(empId,date)=>string|null, daysOf:(empId)=>object, employees:Map}}
 */
function monthMap(from, to) {
  const rows = db
    .prepare(
      `SELECT employee_id, date, status, check_in, check_out FROM attendance
        WHERE date >= ? AND date <= ?`
    )
    .all(from, to);

  const byEmp = new Map();
  rows.forEach((r) => {
    const id = Number(r.employee_id);
    let e = byEmp.get(id);
    if (!e) {
      e = { employee_id: id, days: new Map(), attended: 0, leave: 0, absent: 0, late: 0, records: 0 };
      byEmp.set(id, e);
    }
    const st = String(r.status || 'normal');
    e.days.set(String(r.date), st);
    e.records++;
    if (st === 'leave') e.leave++;
    else if (st === 'absent') e.absent++;
    else {
      // normal / late / 其他都算出勤（人来了）
      e.attended++;
      if (st === 'late') e.late++;
    }
  });

  return {
    employees: byEmp,
    statusOf(empId, date) {
      const e = byEmp.get(Number(empId));
      if (!e) return null;
      return e.days.get(String(date)) || null;
    },
    daysOf(empId) {
      return (
        byEmp.get(Number(empId)) || { employee_id: empId, days: new Map(), attended: 0, leave: 0, absent: 0, late: 0, records: 0 }
      );
    }
  };
}

/** 该员工这月的计件上限（件）；null = 不封顶 */
function monthCapOf(empId, att, cfg) {
  const cap = Number(cfg.daily_cap_qty) || 0;
  if (cap <= 0) return null;
  if (!cfg.month_cap) return null;
  const d = att.daysOf(empId);
  // 整月没有一条考勤 → 不封顶（考勤没录不能当旷工处理）
  if (!d.records) return null;
  if (d.attended <= 0) return 0;
  return round2(cap * d.attended);
}

/**
 * 月度封顶：把超出「日上限 × 出勤天数」的件数削掉
 * 先报先算（按报工日期升序），削掉的逐笔返回
 * @param {Array} items 已按日期序的明细（会原地改 qty/amount）
 */
function applyMonthCap(items, att, cfg) {
  const capped = [];
  const capOf = new Map();
  items.forEach((it) => {
    if (it.employee_id && !capOf.has(it.employee_id)) {
      capOf.set(it.employee_id, monthCapOf(it.employee_id, att, cfg));
    }
  });
  if (![...capOf.values()].some((v) => v !== null)) return { capped, empCap: capOf };

  const acc = new Map();
  const out = [];
  items.forEach((it) => {
    const cap = capOf.get(it.employee_id);
    if (cap === undefined || cap === null) {
      out.push(it);
      return;
    }
    const used = acc.get(it.employee_id) || 0;
    const remain = Math.max(0, cap - used);
    if (it.qty > remain) {
      const over = round2(it.qty - remain);
      capped.push({
        employee_id: it.employee_id,
        employee_name: it.employee_name,
        order_no: it.order_no,
        bundle_no: it.bundle_no,
        process_name: it.process_name,
        report_date: it.report_date,
        raw_qty: round2(it.qty),
        counted: round2(remain),
        over,
        month_cap: cap,
        attended_days: att.daysOf(it.employee_id).attended
      });
      it.qty = round2(remain);
      it.amount = round2(it.qty * it.unit_price);
      it.capped = 1;
      it.cap_kind = 'month';
    }
    acc.set(it.employee_id, round2((acc.get(it.employee_id) || 0) + it.qty));
    if (it.qty > 0) out.push(it);
  });
  return { capped, empCap: capOf, items: out };
}

// ---------------- 看板 ----------------

/**
 * 考勤联动看板：每人出勤 / 请假 / 缺勤 / 计件件数 / 月上限 / 余额
 * @param {object} p preview 结果（复用试算，不重算一遍）
 */
function board(p, cfg) {
  const att = monthMap(p.from, p.to);
  const items = p.items || [];
  const dcapped = (p.diagnostics && p.diagnostics.daily_capped) || [];
  const mcapped = (p.diagnostics && p.diagnostics.month_capped) || [];
  const perEmp = new Map();
  items.forEach((it) => {
    const id = Number(it.employee_id);
    if (!perEmp.has(id)) {
      perEmp.set(id, {
        employee_id: id,
        employee_code: it.employee_code,
        employee_name: it.employee_name,
        department: it.department,
        qty: 0,
        amount: 0,
        flagged: 0
      });
    }
    const e = perEmp.get(id);
    e.qty = round2(e.qty + it.qty);
    e.amount = round2(e.amount + it.amount);
  });

  // 冲突笔数按「报工」数，不按「明细行」数：明细会合并且可能被剔除，
  // 直接从诊断清单数才和「报工日请假/缺勤 N 条」对得上。
  (p.diagnostics && p.diagnostics.attendance_conflict ? p.diagnostics.attendance_conflict : []).forEach((c) => {
    const id = Number(c.employee_id);
    if (!perEmp.has(id)) {
      perEmp.set(id, {
        employee_id: id,
        employee_code: c.employee_code,
        employee_name: c.employee_name,
        department: c.department || '',
        qty: 0,
        amount: 0,
        flagged: 0
      });
    }
    perEmp.get(id).flagged++;
  });

  const rows = [...perEmp.values()].map((e) => {
    const d = att.daysOf(e.employee_id);
    const cap = monthCapOf(e.employee_id, att, cfg);
    // 「超出」取自封顶诊断：试算里的 qty 已经被削平，用 qty−cap 永远是 0，
    // 真正被削掉的量只存在于诊断清单里
    const over = round2(
      [...dcapped, ...mcapped]
        .filter((x) => Number(x.employee_id) === Number(e.employee_id))
        .reduce((s, x) => s + (Number(x.over) || 0), 0)
    );
    return {
      ...e,
      attended_days: d.attended,
      late_days: d.late,
      leave_days: d.leave,
      absent_days: d.absent,
      attendance_records: d.records,
      month_cap: cap,
      remain: cap === null ? null : round2(Math.max(0, cap - e.qty)),
      over,
      // 「未设日上限」不用逐行写（表头已经说了），只提示真正需要解释的两种
      cap_note: cap === null
        ? (Number(cfg.daily_cap_qty) > 0 ? '整月无考勤记录，不封顶' : '')
        : (cap === 0 ? '当月无出勤，月上限 0' : '')
    };
  }).sort((a, b) => String(a.department).localeCompare(String(b.department)) || b.amount - a.amount);

  return {
    period: p.period,
    from: p.from,
    to: p.to,
    config: cfg,
    rows,
    summary: {
      employees: rows.length,
      no_attendance: rows.filter((r) => !r.attendance_records).length,
      capped_people: rows.filter((r) => r.over > 0).length,
      total_over: round2(rows.reduce((s, r) => s + r.over, 0)),
      conflict_count: (p.diagnostics && p.diagnostics.attendance_conflict ? p.diagnostics.attendance_conflict.length : 0)
    }
  };
}

module.exports = {
  POLICIES,
  POLICY_LABEL,
  getConfig,
  saveConfig,
  monthMap,
  monthCapOf,
  applyMonthCap,
  board
};
