/**
 * 生产交付效率与质量报表（TS-N08-09）
 * ========================================================================
 * 这份报表的目的不是「好看」，是**让问题显形**。所以它的第一原则是：
 *
 *   **算不出来就说算不出来，不填 0、不取平均、不拿分子当分母。**
 *
 * 原型把这条写得很直白：「没有源事件不编造天数」「标准工时缺失显示覆盖率，不伪造高效率」。
 * 落地成四件事：
 *
 * 1. **每个指标都带「分母」和「覆盖率」**
 *    准交率 71% 是 5/7 还是 500/700，意义完全不同。样本 < 5 时只报数字不报比率。
 *    工序效率只在「填了工时的报工」上算，并告诉你一共 89 条里只有 30 条有工时。
 *
 * 2. **工序产出不相加成整件产量**
 *    裁 220 件、车缝 3245 件，加起来 3465 不是产量，是「工序流转量」。
 *    整件产量只认「成品入库」或订单件数，绝不把工序数求和。
 *
 * 3. **客户准交与工厂段达成并列，谁也不许减谁**
 *    把「下单前等待」从分母里剔掉，工厂准交立刻从 71% 变成 95% —— 那是化妆。
 *    两张表并排放，差额自己看。
 *
 * 4. **返工回流不刷合格件**
 *    返工后复验合格，不能再算一次产出，也不能再计一次件（计件那边同样口径）。
 *
 * 数据源（只读，不写任何业务表）：
 *   orders / commitments / commitment_nodes / order_nodes / production_reports /
 *   process_standards / rework_orders / qc_inspections / cut_orders / order_changes / tech_packs
 */
const { db } = require('../db');
const { localDate } = require('./sla');
const gl = require('./gl');
const scope = require('../access/companyScope');

/**
 * 生产报表的主体范围
 *
 * 这些报表的主表（commitments / production_reports / rework_orders / qc_inspections /
 * order_nodes / cut_orders）**都没有 company_id**，全挂在订单上 ——
 * 所以统一按 order_id（或已 JOIN 进来的 o.company_id）过滤。
 *
 * 两个容易写错的地方：
 *   1. **过滤必须加在"取原始行"的那条查询上**。这些报表都是"先把行捞出来、
 *      再在 JS 里算比率"，如果在算完之后再过滤，分母已经是全集团的了 ——
 *      分部的准交率会变成既不是自己、也不是集团的第三个数。
 *   2. **内联整数不绑参数**：一条报表查询动辄七八个条件，多绑一个就要数
 *      「第几个 ?」，错位一次条件就静默失效（见 access/companyScope.js）。
 */
const byOrder = (cid, expr) => scope.orderOwnedSql(cid, expr).sql;
const bySelf = (cid, col) => scope.companyClauseSql(cid, col).sql;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/** 期间 → [起, 止]；不传期间默认本月 */
function range(period) {
  const p = String(period || localDate().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(p)) throw bad('期间格式应为 YYYY-MM');
  const [y, m] = p.split('-').map(Number);
  const start = `${p}-01`;
  const end = `${p}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  return { period: p, start, end };
}

function daysBetween(a, b) {
  const x = Date.parse(String(a).slice(0, 10) + 'T00:00:00');
  const y = Date.parse(String(b).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return Math.round((y - x) / 86400000);
}

const pct = (a, b) => (num(b) > 0 ? r2((num(a) / num(b)) * 100) : null);

/* ==================================================================== *
 * 一、准交与交付
 * ==================================================================== */

/**
 * 准交率（按**原批准承诺**，不是最新预测）
 *
 * 两个口径并列，谁高谁低都能看见：
 *   A. 按承诺日到期（due）：本期该交的单里，准时交了几张 —— 考核「本该交的」
 *   B. 按实际发运（shipped）：本期交出去的单里，准时交了几张 —— 考核「交了的」
 *
 * 只给 B 会漏掉「该交没交」的（那是更严重的问题）；只给 A 会在没有到期单的月份显示 0/0。
 * 所以两个都给，页面上的主数字优先用有样本的那个，并标明用的哪个口径。
 *
 * 未发运且已过承诺日的 → 算延期（不能因为「还没发」就不计入分母，那是把坏消息藏起来）
 * 未到承诺日的 → 不进 A 口径（还没到该交的时候）
 */
function onTime(q = {}) {
  const { period } = range(q.period);
  const today = localDate();

  const all = db
    .prepare(
      `SELECT c.id, c.order_no, c.customer_name, c.style_no, c.qty, c.promised_date, c.actual_ship_date,
              c.delay_days, c.delay_reason, c.route_type, c.t0_at, c.risk_level,
              o.type AS order_type
         FROM commitments c
         LEFT JOIN orders o ON o.id = c.order_id
        WHERE IFNULL(c.promised_date,'') <> ''${byOrder(q.companyId, 'c.order_id')}`
    )
    .all();

  const shape = (r) => {
    const isOnTime = r.actual_ship_date ? r.actual_ship_date <= r.promised_date : null;
    const lateDays = r.actual_ship_date
      ? Math.max(0, daysBetween(r.promised_date, r.actual_ship_date) || 0)
      : Math.max(0, daysBetween(r.promised_date, today) || 0);
    return {
      order_no: r.order_no,
      customer_name: r.customer_name,
      style_no: r.style_no,
      qty: r.qty,
      order_type: r.order_type,
      promised_date: r.promised_date,
      actual_ship_date: r.actual_ship_date || null,
      status: !r.actual_ship_date ? '未发运' : (isOnTime ? '准时' : '延期'),
      late_days: lateDays,
      delay_reason: r.delay_reason || null,
      risk_level: r.risk_level
    };
  };

  const summarize = (rows, label) => {
    const onTimeRows = rows.filter((r) => r.actual_ship_date && r.actual_ship_date <= r.promised_date);
    const notShipped = rows.filter((r) => !r.actual_ship_date);
    const late = rows.length - onTimeRows.length - notShipped.length;
    return {
      label,
      sample: rows.length,
      on_time_count: onTimeRows.length,
      late_count: late,
      not_shipped_count: notShipped.length,
      // 样本不足时报数字不报比率（5 单里 1 单延期 = 80%，没有统计意义）
      rate: rows.length >= 5 ? pct(onTimeRows.length, rows.length) : null,
      rate_note: rows.length >= 5 ? null : `样本 ${rows.length} 单，不足 5 单不计算比率`,
      rows: rows.map(shape).sort((a, b) => (b.late_days || 0) - (a.late_days || 0))
    };
  };

  const dueRows = all.filter((r) => String(r.promised_date).slice(0, 7) === period && r.promised_date <= today);
  const shipRows = all.filter((r) => r.actual_ship_date && String(r.actual_ship_date).slice(0, 7) === period);

  const byDue = summarize(dueRows, '按承诺日到期');
  const byShipped = summarize(shipRows, '按实际发运');

  // 主口径：优先用有样本的；都为空时用 due（会是 0/0，如实显示）
  const primary = byShipped.sample > 0 ? 'shipped' : 'due';
  const main = primary === 'shipped' ? byShipped : byDue;

  const typed = {};
  main.rows.forEach((r) => {
    const k = r.order_type || 'unknown';
    typed[k] = typed[k] || { type: k, total: 0, on_time: 0, late: 0, not_shipped: 0, qty: 0 };
    typed[k].total += 1;
    typed[k].qty += num(r.qty);
    if (r.status === '未发运') typed[k].not_shipped += 1;
    else if (r.status === '准时') typed[k].on_time += 1;
    else typed[k].late += 1;
  });

  // 延期原因（没填的单独计数，不归到「其他」里冒充分析）
  const reasons = {};
  main.rows.forEach((r) => {
    if (r.status === '准时') return;
    const k = r.delay_reason || '__none__';
    reasons[k] = (reasons[k] || 0) + 1;
  });

  return {
    period,
    primary,
    primary_label: main.label,
    sample: main.sample,
    on_time_count: main.on_time_count,
    late_count: main.late_count,
    not_shipped_count: main.not_shipped_count,
    rate: main.rate,
    rate_note: main.rate_note,
    by_due: byDue,
    by_shipped: byShipped,
    by_type: Object.values(typed).map((x) => ({ ...x, rate: x.total >= 5 ? pct(x.on_time, x.total) : null })),
    reasons: Object.entries(reasons)
      .map(([k, v]) => ({ reason: k === '__none__' ? null : k, label: k === '__none__' ? '未填写原因' : k, count: v }))
      .sort((a, b) => b.count - a.count),
    reason_missing: reasons.__none__ || 0,
    rows: main.rows
  };
}

/**
 * 工厂段达成 vs 客户准交（并列，不相减）
 *
 * 客户准交看的是「原承诺 vs 实际发运」，所有原因都算进去。
 * 工厂段只看 P1（裁床算料）实际开始 → E1（出厂发运）实际结束，对比这两段的计划天数。
 *
 * **不许用「工厂段达标率」替代客户准交率**：两者差的那一段是下单前等待与客户变更，
 * 把那一段剔掉再叫「准交率」，等于把责任推给客户还不告诉老板。
 */
function routeSegments(q = {}) {
  const { period, start, end } = range(q.period);
  const cs = db
    .prepare(
      `SELECT id, order_no, promised_date, actual_ship_date, t0_at, planned_date, forecast_date
         FROM commitments
        WHERE IFNULL(promised_date,'') <> '' AND promised_date BETWEEN ? AND ?${byOrder(q.companyId, 'order_id')}`
    )
    .all(start, end);

  const rows = [];
  const waitBuckets = [];
  cs.forEach((c) => {
    const nodes = db
      .prepare(
        `SELECT code, name, seq, plan_days, start_date, end_date, actual_start, actual_end, status
           FROM commitment_nodes WHERE commitment_id = ? ORDER BY seq`
      )
      .all(c.id);
    if (!nodes.length) return;

    const started = nodes.filter((n) => n.actual_start);
    if (!started.length) return;

    const first = nodes.find((n) => n.code === 'P1') || started[0];
    const last = nodes.find((n) => n.code === 'E1') || started[started.length - 1];
    const factoryDays = first.actual_start && last.actual_end
      ? daysBetween(first.actual_start, last.actual_end)
      : null;
    // 工厂段计划天数必须**含 E1**：实际天数算到 E1 实际结束，
    // 计划却漏掉 E1，等于让工厂永远多背 1-2 天（这个 bug 会让达标率恒为 0）
    const factoryPlan = nodes
      .filter((n) => ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'B1', 'H1', 'H2', 'C1', 'C2', 'C3', 'E1'].includes(n.code))
      .reduce((a, n) => a + num(n.plan_days), 0);

    // 等待时长：上一节点实际结束 → 下一节点实际开始（原型：交接等待截止下游实际接收）
    const waits = [];
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const cur = nodes[i];
      if (!prev.actual_end || !cur.actual_start) continue;
      const w = daysBetween(prev.actual_end, cur.actual_start);
      if (w === null) continue;
      waits.push({ from: prev.code, to: cur.code, name: cur.name, wait_days: Math.max(0, w) });
    }
    waits.forEach((w) => waitBuckets.push(w));

    rows.push({
      order_no: c.order_no,
      t0_at: String(c.t0_at || '').slice(0, 10) || null,
      promised_date: c.promised_date,
      actual_ship_date: c.actual_ship_date || null,
      // 下单前等待：T0 → 工厂段第一个节点的实际开始
      pre_factory_days: c.t0_at && first.actual_start ? Math.max(0, daysBetween(c.t0_at, first.actual_start) || 0) : null,
      factory_days: factoryDays,
      factory_plan_days: factoryPlan || null,
      factory_ok: factoryDays !== null && factoryPlan > 0 ? factoryDays <= factoryPlan : null,
      total_wait_days: r1(waits.reduce((a, w) => a + w.wait_days, 0)),
      max_wait: waits.length ? waits.reduce((a, b) => (b.wait_days > a.wait_days ? b : a)) : null
    });
  });

  const withPlan = rows.filter((r) => r.factory_ok !== null);
  const byNode = {};
  waitBuckets.forEach((w) => {
    byNode[w.to] = byNode[w.to] || { code: w.to, name: w.name, count: 0, total: 0, max: 0 };
    byNode[w.to].count += 1;
    byNode[w.to].total += w.wait_days;
    byNode[w.to].max = Math.max(byNode[w.to].max, w.wait_days);
  });

  return {
    // 客户准交在 onTime() 里，这里只给工厂段，**不做相减**
    factory_sample: withPlan.length,
    factory_ok_count: withPlan.filter((r) => r.factory_ok).length,
    factory_rate: withPlan.length >= 5 ? pct(withPlan.filter((r) => r.factory_ok).length, withPlan.length) : null,
    factory_rate_note: withPlan.length >= 5 ? null : (withPlan.length ? `只有 ${withPlan.length} 单有完整节点实际时间，不计算比率` : '没有完整的节点实际时间'),
    waits: Object.values(byNode)
      .map((x) => ({ ...x, avg: r1(x.total / x.count) }))
      .sort((a, b) => b.avg - a.avg),
    rows
  };
}

/* ==================================================================== *
 * 二、工序效率
 * ==================================================================== */

/**
 * 工序效率 = 标准分钟 × 合格件数 ÷ （实际工时 × 60）
 *
 * 三条限制，缺一条就会得出「效率 300%」这种糊弄人的数：
 *   - 只统计**填了工时**的报工（分母只取实际有效工时）
 *   - 标准工时缺失的工序**不参与计算**，计入覆盖率
 *   - 分母为 0 的**不给 0%**，给 null（那是没数据，不是效率为零）
 */
function efficiency(q = {}) {
  const { period, start, end } = range(q.period);
  const rows = db
    .prepare(
      `SELECT r.node_name, r.qty_ok, r.qty_defect, r.hours, r.operator, r.order_id
         FROM production_reports r
        WHERE r.report_date BETWEEN ? AND ?${byOrder(q.companyId, 'r.order_id')}`
    )
    .all(start, end);

  const std = {};
  db.prepare('SELECT process_name, std_minutes, efficiency FROM process_standards WHERE active = 1')
    .all()
    .forEach((s) => { std[s.process_name] = s; });

  const map = {};
  let withHours = 0;
  let noStd = 0;
  rows.forEach((r) => {
    const k = r.node_name || '未命名工序';
    map[k] = map[k] || {
      process: k, reports: 0, qty_ok: 0, qty_defect: 0, hours: 0,
      reports_with_hours: 0, std_minutes: std[k] ? num(std[k].std_minutes) : null
    };
    const g = map[k];
    g.reports += 1;
    g.qty_ok += num(r.qty_ok);
    g.qty_defect += num(r.qty_defect);
    if (num(r.hours) > 0) {
      g.hours += num(r.hours);
      g.reports_with_hours += 1;
      withHours += 1;
    }
    if (!std[k]) noStd += 1;
  });

  const list = Object.values(map).map((g) => {
    const stdHours = g.std_minutes === null ? null : (g.std_minutes * g.qty_ok) / 60;
    const canCalc = stdHours !== null && g.hours > 0;
    return {
      process: g.process,
      reports: g.reports,
      reports_with_hours: g.reports_with_hours,
      qty_ok: r2(g.qty_ok),
      qty_defect: r2(g.qty_defect),
      pass_rate: g.qty_ok + g.qty_defect > 0 ? pct(g.qty_ok, g.qty_ok + g.qty_defect) : null,
      std_minutes: g.std_minutes,
      std_hours: stdHours === null ? null : r2(stdHours),
      actual_hours: r2(g.hours),
      // 效率 > 100% 是可能的（标准定宽了），但 > 200% 基本是数据错，标出来
      efficiency: canCalc ? r2((stdHours / g.hours) * 100) : null,
      efficiency_note: canCalc
        ? ((stdHours / g.hours) > 2 ? '效率超过 200%，先核对标准工时与报工数是否填错' : null)
        : (g.std_minutes === null ? '缺标准工时，不计算效率' : '这些报工没填工时，不计算效率（不拿 0 当分母）')
    };
  }).sort((a, b) => b.reports - a.reports);

  const calcRows = list.filter((x) => x.efficiency !== null);
  const totalStd = calcRows.reduce((a, x) => a + x.std_hours, 0);
  const totalAct = calcRows.reduce((a, x) => a + x.actual_hours, 0);

  return {
    period,
    total_reports: rows.length,
    reports_with_hours: withHours,
    hour_coverage: pct(withHours, rows.length),
    reports_without_std: noStd,
    std_coverage: pct(rows.length - noStd, rows.length),
    overall_efficiency: totalAct > 0 ? r2((totalStd / totalAct) * 100) : null,
    // 只有一部分报工能算效率 → 这个数只代表那部分
    calc_basis: `${calcRows.length} 道工序可算，覆盖 ${withHours}/${rows.length} 条报工`,
    rows: list
  };
}

/* ==================================================================== *
 * 三、质量（一次合格 / 返工 / 报废）
 * ==================================================================== */

/**
 * 一次合格率与返工报废率
 *
 * 一次合格率（整件级）= 1 − 返工件数 ÷ 投产件数
 *   **返工后复验合格不再算一次合格** —— 否则返工越多合格率越高，荒诞。
 *   这里的「投产件数」取本期有报工的订单件数（订单件数为 0 时退回报工合格数峰值，并标注口径）。
 */
function quality(q = {}) {
  const { period, start, end } = range(q.period);

  const rw = db
    .prepare(
      `SELECT id, rw_no, order_id, order_no, node_name, type, responsibility, reason, qty,
              qty_ok, qty_scrap, status, reinspect_result, created_at
         FROM rework_orders
        WHERE substr(IFNULL(created_at,''),1,7) = ?${byOrder(q.companyId, 'order_id')}`
    )
    .all(period);

  // 工序级合格率（来自报工）
  const insp = db
    .prepare(
      `SELECT node_name, SUM(qty_ok) ok, SUM(qty_defect) dft
         FROM production_reports WHERE report_date BETWEEN ? AND ?${byOrder(q.companyId, 'order_id')} GROUP BY node_name`
    )
    .all(start, end);

  const inspected = db
    .prepare(
      `SELECT COUNT(*) n, SUM(pass_qty) p, SUM(fail_qty) f, SUM(aql_result='fail') failed
         FROM qc_inspections WHERE inspect_date BETWEEN ? AND ?${byOrder(q.companyId, 'order_id')}`
    )
    .get(start, end);

  // 投产件数：本期有报工的订单（订单件数）
  const orderIds = db
    .prepare(`SELECT DISTINCT order_id FROM production_reports WHERE report_date BETWEEN ? AND ?${byOrder(q.companyId, 'order_id')}`)
    .all(start, end)
    .map((x) => x.order_id);
  let inputQty = 0;
  let qtyMissing = 0;
  orderIds.forEach((id) => {
    const sizeSum = db
      .prepare(
        `SELECT COALESCE(SUM(s.qty),0) q FROM order_item_sizes s
           JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?`
      )
      .get(id).q;
    const fallback = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE order_id = ?').get(id).q;
    const v = num(sizeSum) > 0 ? num(sizeSum) : num(fallback);
    if (v > 0) inputQty += v; else qtyMissing += 1;
  });

  const reworkQty = rw.filter((x) => x.type === 'rework').reduce((a, x) => a + num(x.qty), 0);
  const scrapQty = rw.reduce((a, x) => a + num(x.qty_scrap), 0);

  const byNode = {};
  rw.forEach((x) => {
    const k = x.node_name || '未标注工序';
    byNode[k] = byNode[k] || { node: k, count: 0, qty: 0, scrap: 0, cost: 0 };
    byNode[k].count += 1;
    byNode[k].qty += num(x.qty);
    byNode[k].scrap += num(x.qty_scrap);
  });

  const byResp = {};
  rw.forEach((x) => {
    const k = x.responsibility || '__none__';
    byResp[k] = (byResp[k] || 0) + 1;
  });

  const fpy = inputQty > 0 ? r2(((inputQty - reworkQty) / inputQty) * 100) : null;

  return {
    period,
    input_qty: r2(inputQty),
    input_qty_note: qtyMissing ? `${qtyMissing} 张订单查不到件数（缺尺码明细与款合计），未计入分母` : null,
    rework_qty: r2(reworkQty),
    scrap_qty: r2(scrapQty),
    fpy: fpy,
    fpy_note: fpy === null
      ? '查不到投产件数，不计算一次合格率（不拿返工数为分母）'
      : '一次合格 = (投产件数 − 返工件数) ÷ 投产件数；返工后复验合格不再算一次合格',
    rework_rate: inputQty > 0 ? pct(reworkQty, inputQty) : null,
    scrap_rate: inputQty > 0 ? pct(scrapQty, inputQty) : null,
    // 工序级（报工口径）
    process_pass: insp.map((x) => ({
      process: x.node_name,
      qty_ok: r2(x.ok),
      qty_defect: r2(x.dft),
      pass_rate: num(x.ok) + num(x.dft) > 0 ? pct(x.ok, num(x.ok) + num(x.dft)) : null
    })).sort((a, b) => (a.pass_rate || 0) - (b.pass_rate || 0)),
    inspection: {
      count: num(inspected.n),
      pass_qty: r2(inspected.p),
      fail_qty: r2(inspected.f),
      failed_count: num(inspected.failed),
      note: num(inspected.n) === 0 ? '本期没有质检单，合格率只来自报工口径' : null
    },
    by_node: Object.values(byNode).sort((a, b) => b.qty - a.qty),
    by_responsibility: Object.entries(byResp).map(([k, v]) => ({
      responsibility: k === '__none__' ? null : k,
      label: k === '__none__' ? '未填写责任' : k,
      count: v
    })).sort((a, b) => b.count - a.count),
    rows: rw.map((x) => ({
      rw_no: x.rw_no, order_no: x.order_no, node_name: x.node_name, type: x.type,
      responsibility: x.responsibility, reason: x.reason, qty: x.qty,
      qty_ok: x.qty_ok, qty_scrap: x.qty_scrap, status: x.status,
      reinspect_result: x.reinspect_result, created_at: x.created_at
    }))
  };
}

/* ==================================================================== *
 * 四、在制龄
 * ==================================================================== */

function wipAge(q = {}) {
  const today = localDate();
  const rows = db
    .prepare(
      `SELECT o.id, o.order_no, o.status, o.style_name, o.type, o.created_at, o.delivery_date,
              (SELECT MIN(n.actual_date) FROM order_nodes n
                WHERE n.order_id = o.id AND IFNULL(n.actual_date,'') <> '') AS first_actual,
              (SELECT c.t0_at FROM commitments c WHERE c.order_id = o.id ORDER BY c.id DESC LIMIT 1) AS t0_at
         FROM orders o
        WHERE o.status IN ('assigned','production','instock')${bySelf(q.companyId, 'o.company_id')}
        ORDER BY o.created_at ASC`
    )
    .all();

  const list = rows.map((o) => {
    // 起点优先用首个工序实际开始（真实投产），没有就退回 T0，再退回建单日
    const base = String(o.first_actual || o.t0_at || o.created_at || '').slice(0, 10);
    const age = base ? Math.max(0, daysBetween(base, today) || 0) : null;
    return {
      order_no: o.order_no,
      style_name: o.style_name,
      type: o.type,
      status: o.status,
      base_date: base || null,
      base_source: o.first_actual ? '首个工序实际开始' : (o.t0_at ? 'T0 接单起算' : '建单日'),
      age_days: age,
      delivery_date: o.delivery_date || null,
      overdue_days: o.delivery_date ? Math.max(0, daysBetween(o.delivery_date, today) || 0) : null
    };
  });

  const buckets = [
    { key: 'd7', label: '≤7 天', min: 0, max: 7 },
    { key: 'd15', label: '8-15 天', min: 8, max: 15 },
    { key: 'd30', label: '16-30 天', min: 16, max: 30 },
    { key: 'd30p', label: '30 天以上', min: 31, max: 99999 }
  ].map((b) => {
    const inB = list.filter((x) => x.age_days !== null && x.age_days >= b.min && x.age_days <= b.max);
    return { ...b, count: inB.length, orders: inB.map((x) => x.order_no) };
  });

  const withAge = list.filter((x) => x.age_days !== null);
  return {
    as_of: today,
    total: list.length,
    avg_age: withAge.length ? r1(withAge.reduce((a, x) => a + x.age_days, 0) / withAge.length) : null,
    max_age: withAge.length ? Math.max(...withAge.map((x) => x.age_days)) : null,
    unknown_age: list.length - withAge.length,
    buckets,
    rows: list.sort((a, b) => (b.age_days || 0) - (a.age_days || 0))
  };
}

/* ==================================================================== *
 * 五、计划 vs 实际（工序）
 * ==================================================================== */

/**
 * 计划日期 vs 实际完成
 *
 * order_nodes.plan_date 目前**全部为空**，所以这份表现在是「0 条可比」。
 * 这不是 bug，是数据没填 —— 报表必须把它说出来，而不是显示「平均偏差 0 天」。
 */
function planVsActual(q = {}) {
  const { period, start, end } = range(q.period);
  const rows = db
    .prepare(
      `SELECT n.name, n.order_id, n.status, n.plan_date, n.actual_date, o.order_no
         FROM order_nodes n JOIN orders o ON o.id = n.order_id
        WHERE IFNULL(n.actual_date,'') <> '' AND n.actual_date BETWEEN ? AND ?${bySelf(q.companyId, 'o.company_id')}`
    )
    .all(start, end);

  const withPlan = rows.filter((r) => r.plan_date);
  const map = {};
  rows.forEach((r) => {
    map[r.name] = map[r.name] || { process: r.name, done: 0, with_plan: 0, dev_sum: 0, dev_count: 0, late: 0, early: 0 };
    const g = map[r.name];
    g.done += 1;
    if (!r.plan_date) return;
    g.with_plan += 1;
    const dev = daysBetween(r.plan_date, r.actual_date);
    if (dev === null) return;
    g.dev_sum += dev;
    g.dev_count += 1;
    if (dev > 0) g.late += 1;
    else if (dev < 0) g.early += 1;
  });

  return {
    period,
    done_total: rows.length,
    with_plan_total: withPlan.length,
    coverage: pct(withPlan.length, rows.length),
    note: withPlan.length === 0
      ? '本期完成的工序一条都没有计划完成日（order_nodes.plan_date 为空），无法计算计划偏差 —— 先去排程里生成计划日'
      : null,
    rows: Object.values(map).map((g) => ({
      process: g.process,
      done: g.done,
      with_plan: g.with_plan,
      avg_dev: g.dev_count ? r1(g.dev_sum / g.dev_count) : null,
      late: g.late,
      early: g.early
    })).sort((a, b) => b.done - a.done)
  };
}

/* ==================================================================== *
 * 六、裁床与材料
 * ==================================================================== */

/**
 * 裁片合格率与余料
 *
 * 原型要「材料利用率」。真正的利用率 = 净用布 ÷ 投入用布，
 * 系统只记了排料长度与余料，**没有净用布面积** —— 所以这里只报裁片合格率与余料，
 * 并把「为什么不给利用率」写出来，而不是拿合格率冒充利用率。
 */
function material(q = {}) {
  const { period, start, end } = range(q.period);
  const rows = db
    .prepare(
      `SELECT cut_no, order_no, style_no, plan_qty, total_cut_qty, qualified_qty, reject_qty,
              leftover_m, diff_qty, diff_reason, lot_count, total_layers, cut_at, status
         FROM cut_orders
        WHERE substr(IFNULL(cut_at, created_at),1,7) = ?${byOrder(q.companyId, 'order_id')}`
    )
    .all(period);

  // 只统计「已验完」的裁床单：
  // 还在切（cutting/draft）的单 qualified_qty 必然是 0，把它算进分母会把合格率压成 25%，
  // 看起来像质量崩了，其实只是没切完 —— 这是报表最容易冤枉车间的地方。
  const doneStatus = ['checked', 'handover', 'closed', 'done'];
  const finished = rows.filter((x) => doneStatus.includes(x.status) || num(x.qualified_qty) > 0);
  const inProgress = rows.filter((x) => !finished.includes(x));

  const cut = finished.reduce((a, x) => a + num(x.total_cut_qty), 0);
  const ok = finished.reduce((a, x) => a + num(x.qualified_qty), 0);
  const rej = finished.reduce((a, x) => a + num(x.reject_qty), 0);
  const left = rows.reduce((a, x) => a + num(x.leftover_m), 0);
  const diff = rows.reduce((a, x) => a + num(x.diff_qty), 0);

  return {
    period,
    orders: rows.length,
    finished_orders: finished.length,
    in_progress_orders: inProgress.length,
    cut_qty: r2(cut),
    qualified_qty: r2(ok),
    reject_qty: r2(rej),
    cut_pass_rate: cut > 0 ? pct(ok, cut) : null,
    cut_pass_note: cut > 0
      ? `只统计已验完的 ${finished.length} 单；另有 ${inProgress.length} 单还在切，合格数未产出，不计入分母`
      : (inProgress.length ? `${inProgress.length} 单还在切，还没有合格数，不计算合格率` : '本期没有已验完的裁床单'),
    leftover_m: r2(left),
    diff_qty: r2(diff),
    // 明确不做的指标，写清缺什么
    utilization: null,
    utilization_note: '材料利用率 = 净用布 ÷ 投入用布，系统只记排料长度与余料，没有净用布面积，因此不计算（不拿裁片合格率冒充利用率）',
    rows: rows.map((x) => ({
      cut_no: x.cut_no, order_no: x.order_no, style_no: x.style_no,
      plan_qty: x.plan_qty, total_cut_qty: x.total_cut_qty,
      qualified_qty: x.qualified_qty, reject_qty: x.reject_qty,
      pass_rate: num(x.total_cut_qty) > 0 ? pct(x.qualified_qty, x.total_cut_qty) : null,
      leftover_m: x.leftover_m, diff_qty: x.diff_qty, diff_reason: x.diff_reason,
      status: x.status,
      cut_at: String(x.cut_at || '').slice(0, 10) || null
    }))
  };
}

/* ==================================================================== *
 * 七、交期分解下钻（原型要求可下钻的四段）
 * ==================================================================== */

/**
 * 四个下钻口径
 *   技术制版：tech_packs 创建 → confirmed
 *   销售接收：commitments T0
 *   厂方资料接收：T0 → P1 实际开始
 *   在制变更暂停：order_changes 的 delivery_delta_days 与客户确认耗时
 *
 * 每一段都可能是 null（没源事件），**不填 0**，页面上显示「无源事件」。
 */
function leadTimeBreakdown(q = {}) {
  const { period, start, end } = range(q.period);
  const cs = db
    .prepare(
      `SELECT id, order_id, order_no, t0_at, promised_date, actual_ship_date
         FROM commitments
        WHERE IFNULL(promised_date,'') <> '' AND promised_date BETWEEN ? AND ?${byOrder(q.companyId, 'order_id')}`
    )
    .all(start, end);

  const rows = cs.map((c) => {
    const tp = db
      .prepare(
        `SELECT id, created_at, confirmed_at, stage FROM tech_packs
          WHERE order_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(c.order_id);
    const techDays = tp && tp.created_at && tp.confirmed_at
      ? Math.max(0, daysBetween(tp.created_at, tp.confirmed_at) || 0)
      : null;

    const p1 = db
      .prepare(
        `SELECT actual_start FROM commitment_nodes WHERE commitment_id = ? AND code = 'P1'`
      )
      .get(c.id);
    const preFactory = c.t0_at && p1 && p1.actual_start
      ? Math.max(0, daysBetween(c.t0_at, p1.actual_start) || 0)
      : null;

    const chg = db
      .prepare(
        `SELECT change_no, type, affected_in_production, delivery_delta_days, status,
                created_at, customer_confirmed_at
           FROM order_changes WHERE order_id = ? ORDER BY id DESC`
      )
      .all(c.order_id);
    const pauseDays = chg
      .filter((x) => x.customer_confirmed_at && x.created_at)
      .map((x) => Math.max(0, daysBetween(x.created_at, x.customer_confirmed_at) || 0));

    return {
      order_no: c.order_no,
      t0_at: String(c.t0_at || '').slice(0, 10) || null,
      tech_days: techDays,
      tech_stage: tp ? tp.stage : null,
      pre_factory_days: preFactory,
      change_count: chg.length,
      change_delta_days: chg.reduce((a, x) => a + num(x.delivery_delta_days), 0) || null,
      change_wait_days: pauseDays.length ? Math.max(...pauseDays) : null,
      note: [
        techDays === null ? '技术制版无确认记录' : null,
        preFactory === null ? '厂方资料接收无节点实际时间' : null
      ].filter(Boolean).join('；') || null
    };
  });

  const avg = (arr) => (arr.length ? r1(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const techArr = rows.map((r) => r.tech_days).filter((x) => x !== null);
  const preArr = rows.map((r) => r.pre_factory_days).filter((x) => x !== null);

  return {
    period,
    sample: rows.length,
    tech: {
      sample: techArr.length,
      avg_days: avg(techArr),
      missing: rows.length - techArr.length,
      note: techArr.length ? null : '本期订单没有技术包确认记录，无法计算技术制版时长'
    },
    sales_receive: {
      note: 'T0 = 客户确认 + 约定款项实际满足，销售接收起点已落在 T0 上'
    },
    factory_receive: {
      sample: preArr.length,
      avg_days: avg(preArr),
      missing: rows.length - preArr.length,
      note: preArr.length ? null : '没有节点实际开始时间，无法计算资料接收等待'
    },
    change_pause: {
      count: rows.reduce((a, r) => a + r.change_count, 0),
      avg_wait_days: avg(rows.map((r) => r.change_wait_days).filter((x) => x !== null)),
      total_delta_days: rows.reduce((a, r) => a + num(r.change_delta_days), 0) || null
    },
    rows
  };
}

/* ==================================================================== *
 * 八、总览（把八项指标收在一处 + 口径与覆盖率）
 * ==================================================================== */

function overview(q = {}) {
  const { period } = range(q.period);
  const t = onTime(q);
  const seg = routeSegments(q);
  const eff = efficiency(q);
  const ql = quality(q);
  const wip = wipAge(q);
  const pva = planVsActual(q);
  const mat = material(q);
  const lead = leadTimeBreakdown(q);

  // 覆盖率清单：只放**真有分母概念**的指标。
  // 准交率与工厂段达成不列在这里 —— 它们的「分母」就是样本量本身（KPI 卡上已经写了 5/7），
  // 再算一个「覆盖率 100%」纯属自欺。
  const coverage = [
    {
      item: '工序效率（工时）', available: eff.reports_with_hours, total: eff.total_reports, rate: eff.hour_coverage,
      note: eff.hour_coverage < 100 ? `${eff.total_reports - eff.reports_with_hours} 条报工没填工时，效率只在这些报工上算` : null
    },
    {
      item: '工序效率（标准工时）', available: eff.total_reports - eff.reports_without_std, total: eff.total_reports, rate: eff.std_coverage,
      note: eff.reports_without_std ? `${eff.reports_without_std} 条报工的工序没有标准工时` : null
    },
    {
      item: '计划 vs 实际', available: pva.with_plan_total, total: pva.done_total, rate: pva.coverage,
      note: pva.note
    },
    {
      item: '裁片合格率', available: mat.finished_orders, total: mat.orders,
      rate: pct(mat.finished_orders, mat.orders || 1), note: mat.cut_pass_note
    },
    {
      item: '材料利用率', available: 0, total: mat.orders, rate: null, note: '缺净用布面积，不计算'
    },
    {
      item: '技术制版时长', available: lead.tech.sample, total: lead.sample,
      rate: pct(lead.tech.sample, lead.sample || 1),
      note: lead.tech.note || `在 ${lead.sample} 张有承诺日的单里，${lead.tech.sample} 张能算出制版时长`
    },
    {
      item: '资料接收等待', available: lead.factory_receive.sample, total: lead.sample,
      rate: pct(lead.factory_receive.sample, lead.sample || 1),
      note: lead.factory_receive.note || `在 ${lead.sample} 张有承诺日的单里，${lead.factory_receive.sample} 张有节点实际开始时间`
    }
  ];

  return {
    period,
    kpi: {
      on_time_rate: t.rate,
      on_time_detail: `${t.on_time_count}/${t.sample}`,
      fpy: ql.fpy,
      rework_rate: ql.rework_rate,
      scrap_rate: ql.scrap_rate,
      wip_avg_age: wip.avg_age,
      wip_total: wip.total,
      efficiency: eff.overall_efficiency,
      hour_coverage: eff.hour_coverage,
      cut_pass_rate: mat.cut_pass_rate
    },
    on_time: t,
    segments: seg,
    efficiency: eff,
    quality: ql,
    wip,
    plan_vs_actual: pva,
    material: mat,
    lead,
    coverage,
    // 页面上原样显示的判断（不让用户自己去猜口径）
    calibers: [
      '准交率按**原批准承诺日**计算；承诺被改过的单没有变更历史表，因此不单列「重承诺口径」——改期会直接体现在延期里。',
      '客户准交率与工厂段达成率**并列**，不相减。把下单前等待剔掉再叫准交率，等于把责任推给客户还不告诉老板。',
      '工序产出**不相加**成整件产量：裁 220 件、车缝 3245 件，合计不是产量，是流转量。整件只认订单件数。',
      '工序效率的分母只取**填了工时的报工**；分母为 0 不给 0%，给「—」。标准工时缺失的工序不参与计算。',
      '一次合格率按「(投产件数 − 返工件数) ÷ 投产件数」；**返工后复验合格不再算一次合格**。',
      '计划 vs 实际：`order_nodes.plan_date` 为空时显示覆盖率 0%，**不把「没有计划」当成「计划偏差 0 天」**。',
      '材料利用率 = 净用布 ÷ 投入用布；系统没有净用布字段，所以**不计算**，也不拿裁片合格率冒充。',
      '所有指标都只是统计，**不用于自动排名扣薪**：任务历时 ≠ 劳动工时。'
    ]
  };
}

module.exports = {
  overview,
  onTime,
  routeSegments,
  efficiency,
  quality,
  wipAge,
  planVsActual,
  material,
  leadTimeBreakdown
};
