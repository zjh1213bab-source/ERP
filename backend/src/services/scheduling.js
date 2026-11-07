/**
 * 有限产能排程（M06 · 对应原型 TS-N06「有限产能排程」）
 * ============================================================
 * 一句话：把「订单 × 工序」排到「工作中心 × 日期 × 工时」上，而且**不许超卖产能**。
 *
 * 硬规则（都在下面的代码里，不靠人记）：
 * 1. **没有班次日历的天不可用**：`wc_calendars` 缺行 = 当天 0 小时，
 *    绝不默认 8 小时。日历没配全就直接拒绝生成，并列出缺哪几天。
 * 2. **停机先扣再排**：设备停机（未恢复）当天占用的小时从基准工时里扣掉，
 *    扣到 0 为止（不出现负产能）。停机中的产能不可承诺。
 * 3. **没有定额的工序不排**：`std_minutes <= 0` 视为未配置，记 `no_standard` 硬冲突，
 *    **不允许按 0 工时排**（0 工时等于无限产能，会把整条线排成同一天）。
 * 4. **前后道不许倒序**：同一订单后道开工 ≥ 前道完工；跨工作中心同理。
 * 5. **不是所有工序都占产能**：`排版算料 / 成品入库 / 出库发运 / 备料` 是计划与仓储动作，
 *    不排进工作中心；`水洗 / 印花 / 绣花` 只有订单工艺里确实有才排。
 * 6. **缺料不许排产**：净缺口 > 0 的订单，开工日不早于缺料预计到货日；
 *    有缺口但查不到到货日 → 硬冲突，不排。
 * 7. **装不下要报**：窗口内产能装不下时记 `horizon_short` 并给出缺口工时，
 *    不静默丢弃、不排到窗口外。
 * 8. **超交期要报**：排完晚于交期，记 `late_delivery` 并给出超期天数；
 *    排到交期后不算「已答复客户」，只是内部计划。
 * 9. **锁定任务不动但占产能**：人工锁定（`locked=1`）的任务在重排时原样保留并预占工时。
 * 10. **已发布批次只读**：改计划必须重新生成新版本；人工调整必须写原因并留痕。
 * 11. **发布前硬冲突必须逐条处理**：block 级冲突要写处理意见（resolve）后才允许发布。
 *
 * 时间口径：日期 `YYYY-MM-DD`，时刻 `YYYY-MM-DD HH:mm`，工时是「小时（小数）」。
 * 一个工作中心一天的可用工时 = 班次基准工时 − 当天停机占用（下限 0）。
 */

const { db } = require('../db');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const EPS = 1e-6;

/** 不占工作中心产能的工序（计划 / 仓储动作） */
const NON_CAPACITY = ['排版算料', '成品入库', '出库发运', '备料'];
/** 条件工序：订单工艺里没有就不排 */
const CONDITIONAL = { 水洗: ['水洗', '洗水'], 印花: ['印花'], 绣花: ['绣花'] };
/** 没生成工序节点时的兜底基础工序 */
const BASE_PROCESSES = ['备料', '裁剪', '车缝', '锁眼钉扣', '整烫', '检验', '包装'];

const CONFLICT_LABEL = {
  no_standard: '工序无定额',
  no_calendar: '班次日历缺失',
  material_short: '缺料未到',
  late_delivery: '交期不可达',
  horizon_short: '窗口装不下',
  no_due: '无交期',
  no_qty: '无明细件数',
  review_pending: '评审未通过',
  sequence: '前后道倒序',
  over_capacity: '产能超卖'
};

// ---------- 日期 / 时间工具 ----------
const pad = (n) => String(n).padStart(2, '0');
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayDiff(a, b) {
  return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
}
function dateList(from, to) {
  const out = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard++ < 400) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
/** 小数小时 → HH:mm（相对当天 00:00） */
function hm(h) {
  const total = Math.max(0, Math.min(24 * 60, Math.round((Number(h) || 0) * 60)));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
/** 某天第 h 小时（从班次起点计）→ 时刻字符串 */
function atTime(date, startHour, h) {
  return `${date} ${hm(Number(startHour) + h)}`;
}
function toDate(str) {
  return String(str || '').slice(0, 10);
}

// ---------- 定额 / 工作中心 ----------
function standardsMap() {
  const map = {};
  db.prepare('SELECT * FROM process_standards WHERE active = 1').all().forEach((s) => {
    map[s.process_name] = s;
  });
  return map;
}

/** 在用工作中心：设备台账 ∩ 工序定额 */
function workCenters() {
  const fromEq = db.prepare('SELECT work_center, COUNT(*) AS eq_cnt, SUM(capacity_per_hour) AS cap FROM equipment WHERE active = 1 GROUP BY work_center').all();
  const fromStd = db.prepare('SELECT work_center, COUNT(*) AS proc_cnt FROM process_standards WHERE active = 1 GROUP BY work_center').all();
  const map = {};
  fromEq.forEach((x) => {
    map[x.work_center] = map[x.work_center] || { work_center: x.work_center, eq_cnt: 0, capacity_per_hour: 0, proc_cnt: 0 };
    map[x.work_center].eq_cnt = Number(x.eq_cnt) || 0;
    map[x.work_center].capacity_per_hour = r2(x.cap);
  });
  fromStd.forEach((x) => {
    map[x.work_center] = map[x.work_center] || { work_center: x.work_center, eq_cnt: 0, capacity_per_hour: 0, proc_cnt: 0 };
    map[x.work_center].proc_cnt = Number(x.proc_cnt) || 0;
  });
  return Object.values(map).sort((a, b) => String(a.work_center).localeCompare(String(b.work_center), 'zh'));
}

// ---------- 日历与可用工时 ----------
function calendarRows(from, to, workCenter) {
  const args = [from, to];
  let sql = 'SELECT * FROM wc_calendars WHERE cal_date >= ? AND cal_date <= ?';
  if (workCenter) {
    sql += ' AND work_center = ?';
    args.push(workCenter);
  }
  sql += ' ORDER BY cal_date, work_center';
  return db.prepare(sql).all(...args);
}

/** 某工作中心某天停机占用小时（与当天重叠部分） */
function downtimeHours(workCenter, date) {
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const dayEnd = dayStart + 86400000;
  const rows = db.prepare(
    "SELECT start_at, end_at, status FROM equipment_downtimes WHERE work_center = ? AND status != 'cancelled'"
  ).all(workCenter);
  let hours = 0;
  rows.forEach((row) => {
    const s = Math.max(new Date(String(row.start_at).replace(' ', 'T')).getTime(), dayStart);
    const eRaw = row.end_at ? new Date(String(row.end_at).replace(' ', 'T')).getTime() : Date.now();
    const e = Math.min(eRaw, dayEnd);
    if (e > s) hours += (e - s) / 3600000;
  });
  return r2(hours);
}

/**
 * 构建可用工时池：{ wc: { date: { base, down, avail, start_hour } } }
 * 缺日历行 = avail 0（并记录缺哪天）
 */
function capacityPool({ from, to, workCenters: wcs }) {
  const dates = dateList(from, to);
  const rows = calendarRows(from, to);
  const byKey = {};
  rows.forEach((r) => {
    byKey[`${r.work_center}|${r.cal_date}`] = r;
  });
  const pool = {};
  const missing = {};
  wcs.forEach((wc) => {
    pool[wc] = {};
    dates.forEach((d) => {
      const r = byKey[`${wc}|${d}`];
      if (!r) {
        pool[wc][d] = { base: 0, down: 0, avail: 0, start_hour: 8, configured: false };
        (missing[wc] = missing[wc] || []).push(d);
        return;
      }
      const base = Math.max(0, Number(r.base_hours) || 0);
      const down = base > 0 ? Math.min(base, downtimeHours(wc, d)) : 0;
      pool[wc][d] = {
        base: r2(base),
        down: r2(down),
        avail: r2(Math.max(0, base - down)),
        start_hour: Number(r.start_hour) || 8,
        configured: true
      };
    });
  });
  return { pool, missing, dates };
}

// ---------- 订单侧数据 ----------
const SCHED_STATUS = ['tech', 'finance', 'assigned', 'production'];

function orderQty(orderId) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(s.qty),0) AS q FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?'
  ).get(orderId);
  return Number(r.q) || 0;
}

function orderStyle(orderId) {
  const it = db.prepare('SELECT style_no, product_name FROM order_items WHERE order_id = ? ORDER BY id LIMIT 1').get(orderId);
  const o = db.prepare('SELECT style_name FROM orders WHERE id = ?').get(orderId);
  return (it && (it.style_no || it.product_name)) || (o && o.style_name) || null;
}

/** 订单该做哪些工序（按 order_nodes 顺序；过滤不占产能与不适用条件工序） */
function processesOf(orderId) {
  const crafts = db.prepare('SELECT name FROM order_crafts WHERE order_id = ?').all(orderId).map((c) => String(c.name || ''));
  const nodes = db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(orderId);
  const src = nodes.length ? nodes.map((n) => n.name) : BASE_PROCESSES.slice();
  const out = [];
  src.forEach((name, idx) => {
    if (NON_CAPACITY.includes(name)) return;
    const condKey = Object.keys(CONDITIONAL).find((k) => CONDITIONAL[k].some((x) => name.includes(x)));
    if (condKey) {
      const hit = crafts.some((c) => CONDITIONAL[condKey].some((x) => c.includes(x)));
      if (!hit) return;
    }
    const node = nodes.find((n) => n.name === name);
    out.push({ name, seq: idx + 1, node_id: node ? node.id : null });
  });
  return out;
}

/** 缺料情况：净缺口与预计到货日 */
function shortageOf(orderId) {
  const rows = db.prepare(
    'SELECT * FROM material_requirements WHERE order_id = ? AND gap_qty > 0.5'
  ).all(orderId);
  let etaLatest = null;
  let noEta = 0;
  const names = [];
  rows.forEach((r) => {
    names.push(`${r.material_name}（缺 ${r2(r.gap_qty)}${r.unit || ''}）`);
    let eta = null;
    if (r.material_id) {
      const pi = db.prepare(
        `SELECT MIN(po.expect_date) AS eta FROM purchase_items pi
         JOIN purchase_orders po ON po.id = pi.po_id
         WHERE pi.material_id = ? AND pi.qty > pi.received_qty
           AND po.status NOT IN ('cancelled','closed') AND po.expect_date IS NOT NULL`
      ).get(r.material_id);
      eta = pi && pi.eta ? toDate(pi.eta) : null;
    }
    if (!eta) noEta += 1;
    else if (!etaLatest || eta > etaLatest) etaLatest = eta;
  });
  return { count: rows.length, names, eta: etaLatest, no_eta: noEta };
}

function dueOf(order) {
  const c = db.prepare('SELECT promised_date, review_status FROM commitments WHERE order_id = ?').get(order.id);
  return {
    due: toDate((c && c.promised_date) || order.delivery_date || '') || null,
    review: c ? c.review_status : null
  };
}

// ---------- 主算法 ----------
function nextRunNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const prefix = `PS${ymd}`;
  const rows = db.prepare('SELECT run_no FROM schedule_runs WHERE run_no LIKE ?').all(`${prefix}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.run_no).slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  let seq = max + 1;
  let no = `${prefix}${String(seq).padStart(4, '0')}`;
  while (db.prepare('SELECT 1 x FROM schedule_runs WHERE run_no = ?').get(no)) {
    seq += 1;
    no = `${prefix}${String(seq).padStart(4, '0')}`;
  }
  return { runNo: no, seq };
}

/**
 * 生成排程（只算不写库，便于预演）
 * @returns {{ tasks:[], conflicts:[], stats:{}, missing:{}, pool:{} }}
 */
function plan({
  from, to, algo = 'edd', orderIds = null, carryLocked = true, materialGate = true, companyId = 1
}) {
  const stds = standardsMap();
  const wcs = workCenters().map((x) => x.work_center);
  const { pool, missing, dates } = capacityPool({ from, to, workCenters: wcs });

  const conflicts = [];
  const addC = (c) => conflicts.push({
    level: 'warn', metric: 0, resolved: 0, ...c
  });

  // 1) 日历缺失 → 硬冲突（一次性汇总，按工作中心）
  Object.keys(missing).forEach((wc) => {
    const list = missing[wc];
    if (!list.length) return;
    addC({
      type: 'no_calendar',
      level: 'block',
      work_center: wc,
      on_date: list[0],
      metric: list.length,
      detail: `${wc} 有 ${list.length} 天没配班次日历（${list[0]}${list.length > 1 ? ` 至 ${list[list.length - 1]}` : ''}），这些天按 0 小时算`,
      suggestion: '先到「班次日历」页签按默认班次补齐，或调整排程窗口'
    });
  });

  // 2) 取订单
  let orders = db.prepare(
    `SELECT * FROM orders WHERE company_id = ? AND status IN (${SCHED_STATUS.map(() => '?').join(',')}) ORDER BY id`
  ).all(companyId, ...SCHED_STATUS);
  if (Array.isArray(orderIds) && orderIds.length) {
    const set = new Set(orderIds.map(Number));
    orders = orders.filter((o) => set.has(Number(o.id)));
  }

  // 3) 预占：沿用上一个生效排程里锁定的任务
  const consumed = {};
  const avail = {};
  wcs.forEach((wc) => {
    consumed[wc] = {};
    avail[wc] = {};
    dates.forEach((d) => {
      consumed[wc][d] = 0;
      avail[wc][d] = pool[wc][d].avail;
    });
  });

  const fixed = [];
  if (carryLocked) {
    const cur = db.prepare('SELECT * FROM schedule_runs WHERE company_id = ? AND is_current = 1').get(companyId);
    if (cur) {
      const lockedTasks = db.prepare('SELECT * FROM schedule_tasks WHERE run_id = ? AND locked = 1').all(cur.id);
      lockedTasks.forEach((t) => {
        let loads = {};
        try { loads = t.day_load ? JSON.parse(t.day_load) : {}; } catch (e) { loads = {}; }
        const wc = avail[t.work_center] ? t.work_center : null;
        Object.keys(loads).forEach((d) => {
          if (!wc || !avail[wc][d]) return;
          const take = Math.min(avail[wc][d], Number(loads[d]) || 0);
          avail[wc][d] = r2(avail[wc][d] - take);
          consumed[wc][d] = r2(consumed[wc][d] + take);
        });
        fixed.push({ ...t, carried: true });
      });
    }
  }

  // 4) 先判「能不能排」：不能排的订单不留半截计划，只留一条硬冲突
  const enriched = orders.map((o) => {
    const d = dueOf(o);
    const qty = orderQty(o.id);
    const shortage = materialGate ? shortageOf(o.id) : { count: 0, names: [], eta: null, no_eta: 0 };
    let earliest = from;
    let skip = false;
    let skipReason = null;

    if (!qty || qty <= 0) {
      skip = true;
      skipReason = 'no_qty';
      addC({
        type: 'no_qty', level: 'block', order_id: o.id, order_no: o.order_no,
        detail: '订单没有明细件数，折算不出工时，未排',
        suggestion: '先补订单明细与尺码数量再重排'
      });
    }

    // 缺料：有到货日 → 开工日不早于到货；查不到到货日 → 不排
    if (!skip && shortage.count > 0) {
      if (shortage.no_eta > 0) {
        skip = true;
        skipReason = 'material_short';
        addC({
          type: 'material_short', level: 'block', order_id: o.id, order_no: o.order_no,
          metric: shortage.no_eta,
          detail: `缺 ${shortage.count} 项料，其中 ${shortage.no_eta} 项查不到预计到货日：${shortage.names.slice(0, 3).join('、')}${shortage.names.length > 3 ? ' 等' : ''}，未排`,
          suggestion: '补下采购单并填预计到货日，或改用替代料，再重排'
        });
      } else if (shortage.eta) {
        earliest = shortage.eta > from ? shortage.eta : from;
        addC({
          type: 'material_short', level: 'warn', order_id: o.id, order_no: o.order_no,
          metric: shortage.count, on_date: earliest,
          detail: `缺 ${shortage.count} 项料，最早 ${earliest} 到货：${shortage.names.slice(0, 3).join('、')}${shortage.names.length > 3 ? ' 等' : ''}`,
          suggestion: `开工日已按到货日 ${earliest} 起算；催货可提前`
        });
      }
    }

    if (!d.due) {
      addC({
        type: 'no_due', level: 'warn', order_id: o.id, order_no: o.order_no,
        detail: '没有对客承诺日也没有订单交期，无法判断是否超期，按窗口末排序',
        suggestion: '先做接单评审，写承诺日'
      });
    }
    if (d.review !== 'approved') {
      addC({
        type: 'review_pending', level: 'warn', order_id: o.id, order_no: o.order_no,
        detail: `接单评审未通过（当前 ${d.review || '未评审'}），此计划只能内部参考，不可下发`,
        suggestion: '走接单评审，前后端物料三项全过再下发'
      });
    }
    return { order: o, due: d.due, qty, earliest, shortage, skip, skipReason };
  });

  enriched.sort((a, b) => {
    const da = a.due || '9999-12-31';
    const dbb = b.due || '9999-12-31';
    if (da !== dbb) return da < dbb ? -1 : 1;
    if (a.qty !== b.qty) return a.qty - b.qty;
    return a.order.id - b.order.id;
  });
  // 5) 逐单逐工序正排（不能排的整单跳过，不给半截计划）
  const lastStyle = {};   // 工作中心上次做的款（换款要加调试时间）
  const tasks = [];
  let horizonShort = 0;

  enriched.forEach((env) => {
    const { order, due, qty, earliest, skip } = env;
    if (skip) return;

    // 5.1 可行性：任一工序没定额、或承做中心不在台账 → 整单不排
    const procs = processesOf(order.id);
    if (!procs.length) {
      addC({
        type: 'no_standard', level: 'block', order_id: order.id, order_no: order.order_no,
        detail: '订单没有可排的产能工序（工序节点为空，或全是不占产能的工序），未排',
        suggestion: '先在开发单/订单里生成工序节点'
      });
      return;
    }
    let bad = false;
    procs.forEach((p) => {
      const std = stds[p.name];
      if (!std || Number(std.std_minutes) <= 0) {
        bad = true;
        addC({
          type: 'no_standard', level: 'block', order_id: order.id, order_no: order.order_no,
          process_name: p.name,
          detail: `工序「${p.name}」没有单件标准工时，不能按 0 工时排（0 工时等于无限产能），本单未排`,
          suggestion: '到「工序定额」页签配置承做工作中心与单件分钟数'
        });
      } else if (!avail[std.work_center]) {
        bad = true;
        addC({
          type: 'no_standard', level: 'block', order_id: order.id, order_no: order.order_no,
          process_name: p.name, work_center: std.work_center,
          detail: `工序「${p.name}」的承做工作中心「${std.work_center}」不在设备台账里，本单未排`,
          suggestion: '在工作中心维护设备，或改工序定额的承做中心'
        });
      }
    });
    if (bad) return;

    // 5.2 产能预检：整单所需工时 vs 开工日之后窗口内剩余产能
    const need = {};
    procs.forEach((p) => {
      const std = stds[p.name];
      const eff = Math.max(1, Number(std.efficiency) || 85) / 100;
      need[std.work_center] = (need[std.work_center] || 0) + (qty * (Number(std.std_minutes) || 0)) / 60 / eff;
    });
    const short = [];
    Object.keys(need).forEach((wc) => {
      const remain = dates.reduce((a, d) => (d >= earliest ? a + (avail[wc][d] || 0) : a), 0);
      if (need[wc] > remain + 1e-6) short.push({ wc, need: r2(need[wc]), remain: r2(remain), gap: r2(need[wc] - remain) });
    });
    if (short.length) {
      const gap = r2(short.reduce((a, x) => a + x.gap, 0));
      horizonShort = r2(horizonShort + gap);
      addC({
        type: 'horizon_short', level: 'block', order_id: order.id, order_no: order.order_no,
        work_center: short[0].wc, on_date: to, metric: gap,
        detail: `${short.map((x) => `${x.wc} 需 ${x.need}h 只剩 ${x.remain}h`).join('；')}，窗口 ${from}~${to} 装不下，本单未排`,
        suggestion: '加开班次 / 增加设备 / 部分数量外协，或把交期往后挪再重排'
      });
      return;
    }

    // 5.3 正排：按工序顺序串行，逐日扣产能
    const styleNo = orderStyle(order.id);
    let cursorAt = null;   // 前道完工时刻：后道不得早于它（否则会出现后道先于前道的倒序）

    procs.forEach((p) => {
      const std = stds[p.name];
      const wc = std.work_center;
      const eff = Math.max(1, Number(std.efficiency) || 85) / 100;
      const setupHours = lastStyle[wc] && lastStyle[wc] !== styleNo
        ? r2((Number(std.setup_minutes) || 0) / 60)
        : 0;
      const runHours = r2((qty * (Number(std.std_minutes) || 0)) / 60 / eff);
      const needHours = r2(runHours + setupHours);
      if (needHours <= 0) return;

      let remaining = needHours;
      let d = cursorAt ? String(cursorAt).slice(0, 10) : earliest;
      let startAt = null;
      let endAt = null;
      const loads = {};
      let guard = 0;
      while (remaining > EPS && guard++ < 400) {
        if (d > to) break;
        const cap = avail[wc][d] || 0;
        const used = consumed[wc][d] || 0;
        const startHour = pool[wc][d] ? pool[wc][d].start_hour : 8;
        // 前道在同一工作中心/另一工作中心都算：前道当天没做完，这段产能对本工序不可用，
        // 否则会出现「后道 08:00 开工，前道 13:59 才完工」的倒序。
        let pos = used;
        if (cursorAt && d === String(cursorAt).slice(0, 10)) {
          const ch = Number(String(cursorAt).slice(11, 13)) + Number(String(cursorAt).slice(14, 16)) / 60;
          pos = Math.max(pos, ch - startHour);
        }
        const usable = r2(used + cap - pos);
        if (cap <= EPS || usable <= EPS) {
          d = addDays(d, 1);
          continue;
        }
        const take = Math.min(usable, remaining);
        if (startAt === null) startAt = atTime(d, startHour, pos);
        consumed[wc][d] = r2(pos + take);
        avail[wc][d] = r2(used + cap - consumed[wc][d]);
        loads[d] = r2((loads[d] || 0) + take);
        endAt = atTime(d, startHour, consumed[wc][d]);
        remaining = r2(remaining - take);
        if (remaining > EPS) d = addDays(d, 1);
      }

      // 兜底：预检通过了还装不下（换款/碎片导致），照实报
      if (remaining > EPS) {
        horizonShort = r2(horizonShort + remaining);
        addC({
          type: 'horizon_short', level: 'block', order_id: order.id, order_no: order.order_no,
          process_name: p.name, work_center: wc, on_date: to, metric: remaining,
          detail: `${wc} 在 ${to} 前装不下「${p.name}」，还差 ${remaining} 小时`,
          suggestion: '加开班次 / 增加设备 / 部分数量外协，或延后排程窗口'
        });
        const lastInfo = pool[wc][to] || { start_hour: 8, avail: 0 };
        startAt = startAt || atTime(to, lastInfo.start_hour, 0);
        endAt = atTime(to, lastInfo.start_hour, lastInfo.avail);
      }

      lastStyle[wc] = styleNo;

      const lateDays = due && endAt ? Math.max(0, dayDiff(due, String(endAt).slice(0, 10))) : 0;
      if (due && lateDays > 0) {
        addC({
          type: 'late_delivery', level: 'warn', order_id: order.id, order_no: order.order_no,
          process_name: p.name, work_center: wc, on_date: String(endAt).slice(0, 10), metric: lateDays,
          detail: `「${p.name}」排到 ${String(endAt).slice(0, 10)}，比交期 ${due} 晚 ${lateDays} 天`,
          suggestion: '回复客户改期、加人加班，或把这批数量拆到外协'
        });
      }

      tasks.push({
        order_id: order.id,
        order_no: order.order_no,
        node_id: p.node_id,
        style_no: styleNo,
        process_name: p.name,
        seq: p.seq,
        work_center: wc,
        qty,
        std_minutes: Number(std.std_minutes) || 0,
        setup_hours: setupHours,
        est_hours: needHours,
        start_at: startAt || endAt || `${earliest} 08:00`,
        end_at: endAt || startAt || `${earliest} 08:00`,
        day_load: JSON.stringify(loads),
        due_date: due,
        finish_by_due: due && lateDays > 0 ? 0 : 1
      });

      // 后道不得早于前道
      cursorAt = endAt || startAt || cursorAt || `${earliest} 08:00`;
    });
  });

  // 6) 统计
  const totalBase = wcs.reduce((a, wc) => a + dates.reduce((b, d) => b + (pool[wc][d].base || 0), 0), 0);
  const totalUsed = wcs.reduce((a, wc) => a + dates.reduce((b, d) => b + (consumed[wc][d] || 0), 0), 0);
  let fullDays = 0;
  wcs.forEach((wc) => {
    dates.forEach((d) => {
      const base = pool[wc][d].avail;
      if (base > 0 && consumed[wc][d] >= base - 0.01) fullDays += 1;
    });
  });
  const lateOrders = new Set(tasks.filter((t) => !t.finish_by_due).map((t) => t.order_id));
  const blockCount = conflicts.filter((c) => c.level === 'block').length;

  const stats = {
    order_count: enriched.length,
    task_count: tasks.length,
    conflict_count: conflicts.length,
    block_count: blockCount,
    late_count: lateOrders.size,
    full_days: fullDays,
    util_rate: totalBase > 0 ? r2((totalUsed / totalBase) * 100) : 0,
    total_base_hours: r2(totalBase),
    total_used_hours: r2(totalUsed),
    horizon_short_hours: horizonShort
  };

  return { tasks, conflicts, stats, fixed, missing, pool, dates };
}

/** 写库：生成批次 */
function createRun(opts) {
  const { from, to, algo = 'edd', companyId = 1, operator = 'system', note = null, carryLocked = true } = opts;
  if (!from || !to || from > to) throw new Error('排程窗口不合法：需要 from <= to');
  const res = plan({ ...opts, from, to, algo, companyId, carryLocked });

  // 硬门槛：日历没配全、或存在 block 级「无定额」，一律不落库（避免生成一份假计划）
  const fatal = res.conflicts.filter(
    (c) => c.level === 'block' && (c.type === 'no_calendar' || c.type === 'no_standard')
  );
  if (fatal.length) {
    const msg = fatal.slice(0, 3).map((c) => c.detail).join('；');
    const err = new Error(`无法生成排程：${msg}${fatal.length > 3 ? ` 等 ${fatal.length} 项` : ''}`);
    err.code = 422;
    err.payload = { conflicts: res.conflicts, missing: res.missing };
    throw err;
  }

  const { runNo } = nextRunNo();
  const ts = new Date().toISOString();
  const scope = `订单状态 tech/finance/assigned/production，窗口 ${from} ~ ${to}，算法 ${algo === 'spt' ? '短工时优先' : '交期优先'}`;
  // 版本号按公司递增：同一公司第 N 次生成的批次就是 VN
  const version = Number(
    db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schedule_runs WHERE company_id = ?').get(companyId).v
  ) + 1;

  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO schedule_runs
        (run_no, company_id, version, algo, horizon_from, horizon_to, scope_note,
         order_count, task_count, conflict_count, block_count, late_count, full_days, util_rate,
         status, is_current, created_by, created_at, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      runNo, companyId, version, algo, from, to, scope,
      res.stats.order_count, res.stats.task_count, res.stats.conflict_count, res.stats.block_count,
      res.stats.late_count, res.stats.full_days, res.stats.util_rate,
      'draft', 0, operator, ts, note
    );
    const runId = info.lastInsertRowid;

    const insTask = db.prepare(
      `INSERT INTO schedule_tasks
        (run_id, order_id, order_no, node_id, style_no, process_name, seq, work_center, qty,
         std_minutes, setup_hours, est_hours, start_at, end_at, day_load, due_date, finish_by_due,
         locked, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    res.tasks.forEach((t) => {
      insTask.run(
        runId, t.order_id, t.order_no, t.node_id, t.style_no, t.process_name, t.seq, t.work_center, t.qty,
        t.std_minutes, t.setup_hours, t.est_hours, t.start_at, t.end_at, t.day_load, t.due_date,
        t.finish_by_due, 0, 'planned', ts
      );
    });

    // 沿用的锁定任务原样带过来
    const insFixed = db.prepare(
      `INSERT OR IGNORE INTO schedule_tasks
        (run_id, order_id, order_no, node_id, style_no, process_name, seq, work_center, qty,
         std_minutes, setup_hours, est_hours, start_at, end_at, day_load, due_date, finish_by_due,
         locked, lock_reason, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    res.fixed.forEach((t) => {
      insFixed.run(
        runId, t.order_id, t.order_no, t.node_id, t.style_no, t.process_name, t.seq, t.work_center, t.qty,
        t.std_minutes, t.setup_hours, t.est_hours, t.start_at, t.end_at, t.day_load, t.due_date,
        t.finish_by_due, 1, t.lock_reason || '沿用上一版锁定', t.status, ts
      );
    });

    const insConf = db.prepare(
      `INSERT INTO schedule_conflicts
        (run_id, type, level, order_id, order_no, work_center, process_name, on_date,
         detail, suggestion, metric, resolved, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    res.conflicts.forEach((c) => {
      insConf.run(
        runId, c.type, c.level, c.order_id || null, c.order_no || null, c.work_center || null,
        c.process_name || null, c.on_date || null, c.detail, c.suggestion || null,
        r2(c.metric), c.resolved ? 1 : 0, ts
      );
    });

    db.exec('COMMIT');
    return { run_id: runId, run_no: runNo, ...res.stats };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 批次详情（含甘特数据） */
function runView(runId) {
  const run = db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const tasks = db.prepare(
    'SELECT * FROM schedule_tasks WHERE run_id = ? ORDER BY work_center, start_at, order_no'
  ).all(runId).map((t) => {
    let loads = {};
    try { loads = t.day_load ? JSON.parse(t.day_load) : {}; } catch (e) { loads = {}; }
    const days = Object.keys(loads).sort();
    const segments = days.filter((d) => Number(loads[d]) > 0).length;
    return {
      ...t,
      day_load: loads,
      // 分段数 > 1 说明这批中途被别的单插进来过（产能有限，先到先占）
      segments,
      preempted: segments > 1 ? 1 : 0,
      start_date: days[0] || String(t.start_at).slice(0, 10),
      end_date: days[days.length - 1] || String(t.end_at).slice(0, 10)
    };
  });
  const conflicts = db.prepare(
    'SELECT * FROM schedule_conflicts WHERE run_id = ? ORDER BY (level = \'block\') DESC, id'
  ).all(runId).map((c) => ({ ...c, type_label: CONFLICT_LABEL[c.type] || c.type }));

  const dates = dateList(run.horizon_from, run.horizon_to);
  const pool = capacityPool({
    from: run.horizon_from,
    to: run.horizon_to,
    workCenters: [...new Set(tasks.map((t) => t.work_center))].sort()
  }).pool;

  const lanes = [...new Set(tasks.map((t) => t.work_center))].sort().map((wc) => {
    const ts = tasks.filter((t) => t.work_center === wc);
    const used = ts.reduce((a, t) => a + (Number(t.est_hours) || 0), 0);
    const base = dates.reduce((a, d) => a + ((pool[wc] && pool[wc][d] ? pool[wc][d].avail : 0) || 0), 0);
    return {
      work_center: wc,
      task_count: ts.length,
      used_hours: r2(used),
      base_hours: r2(base),
      util_rate: base > 0 ? r2((used / base) * 100) : 0,
      tasks: ts
    };
  });

  const dayLoad = [];
  lanes.forEach((l) => {
    dates.forEach((d) => {
      const used = l.tasks.reduce((a, t) => a + (Number(t.day_load[d]) || 0), 0);
      const info = pool[l.work_center] && pool[l.work_center][d] ? pool[l.work_center][d] : { base: 0, down: 0, avail: 0 };
      dayLoad.push({
        work_center: l.work_center, date: d,
        base: info.base, down: info.down, avail: info.avail, used: r2(used),
        util_rate: info.avail > 0 ? r2((used / info.avail) * 100) : 0
      });
    });
  });

  return { run, tasks, conflicts, lanes, dates, day_load: dayLoad };
}

/** 当前生效排程 */
function currentRun(companyId = 1) {
  return db.prepare('SELECT * FROM schedule_runs WHERE company_id = ? AND is_current = 1').get(companyId);
}

function publishRun(runId, operator, note) {
  const run = db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(runId);
  if (!run) throw new Error('排程批次不存在');
  if (run.status === 'published') throw new Error('该批次已发布，请勿重复发布');
  if (run.status === 'archived') throw new Error('已归档的批次不能再发布');

  // 硬冲突必须逐条处理
  const open = db.prepare(
    "SELECT * FROM schedule_conflicts WHERE run_id = ? AND level = 'block' AND resolved = 0"
  ).all(runId);
  if (open.length) {
    const msg = open.slice(0, 2).map((c) => c.detail).join('；');
    const err = new Error(`还有 ${open.length} 条硬冲突没处理：${msg}`);
    err.code = 409;
    err.payload = { conflicts: open };
    throw err;
  }

  const ts = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(
      "UPDATE schedule_runs SET is_current = 0, status = CASE WHEN status = 'published' THEN 'archived' ELSE status END, archived_at = CASE WHEN status = 'published' THEN ? ELSE archived_at END WHERE company_id = ? AND is_current = 1"
    ).run(ts, run.company_id);
    db.prepare(
      "UPDATE schedule_runs SET status = 'published', is_current = 1, published_by = ?, published_at = ?, note = COALESCE(?, note) WHERE id = ?"
    ).run(operator, ts, note || null, runId);
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(runId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 人工调整任务（仅草稿批次）
 * 只允许改：起止时间 / 工作中心 / 锁定 / 工时；一律写原因并留痕
 */
function adjustTask(taskId, body, operator) {
  const t = db.prepare('SELECT * FROM schedule_tasks WHERE id = ?').get(taskId);
  if (!t) throw new Error('排程任务不存在');
  const run = db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(t.run_id);
  if (!run) throw new Error('排程批次不存在');
  if (run.status === 'published') {
    throw new Error('已发布的批次只读：要改计划请重新生成新版本，不原地改历史');
  }
  if (run.status === 'archived') throw new Error('已归档批次不可调整');

  const reason = String(body.reason || '').trim();
  const changes = [];

  const patch = {};
  ['start_at', 'end_at', 'work_center', 'est_hours'].forEach((k) => {
    if (body[k] !== undefined && body[k] !== null && body[k] !== '') {
      if (String(body[k]) !== String(t[k])) patch[k] = body[k];
    }
  });
  if (body.locked !== undefined && Number(body.locked) !== Number(t.locked)) {
    patch.locked = Number(body.locked) ? 1 : 0;
  }
  if (!Object.keys(patch).length) throw new Error('没有需要调整的字段');
  // 所有计划变动均需原因，不能仅在锁定任务时要求，工时变化同样影响产能。
  if (!reason) throw new Error('调整排程任务必须写原因');

  Object.keys(patch).forEach((k) => {
    if (k === 'start_at' || k === 'end_at') {
      const v = String(patch[k]).trim();
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) throw new Error(`${k} 格式必须是 YYYY-MM-DD HH:mm`);
    }
  });
  if (patch.work_center) {
    const exists = db.prepare('SELECT 1 x FROM wc_calendars WHERE work_center = ? LIMIT 1').get(patch.work_center);
    if (!exists) throw new Error(`工作中心「${patch.work_center}」没有班次日历，不能作为承做中心`);
  }
  if (patch.est_hours !== undefined && Number(patch.est_hours) <= 0) {
    throw new Error('工时必须大于 0（0 工时等于无限产能）');
  }

  const start = patch.start_at || t.start_at;
  const end = patch.end_at || t.end_at;
  if (String(end) < String(start)) throw new Error('结束时间不能早于开始时间');
  if (patch.locked === 1 && !reason) throw new Error('锁定任务必须写锁定原因');

  const ts = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const sets = [];
    const args = [];
    Object.keys(patch).forEach((k) => {
      sets.push(`${k} = ?`);
      args.push(patch[k]);
      changes.push({ field: k, old: t[k], now: patch[k] });
    });
    if (patch.locked !== undefined) {
      sets.push('lock_reason = ?');
      args.push(patch.locked ? reason : null);
    }
    // 起止变了要重算 day_load 比例（简单按天均摊，人工调整后不再假装精确）
    if (patch.start_at || patch.end_at) {
      const hours = Number(patch.est_hours || t.est_hours) || 0;
      const d0 = String(start).slice(0, 10);
      const d1 = String(end).slice(0, 10);
      const days = dateList(d0, d1);
      const per = days.length ? r2(hours / days.length) : 0;
      const loads = {};
      days.forEach((d) => { loads[d] = per; });
      sets.push('day_load = ?');
      args.push(JSON.stringify(loads));
    }
    args.push(taskId);
    db.prepare(`UPDATE schedule_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);

    const insChg = db.prepare(
      `INSERT INTO schedule_changes (run_id, task_id, order_no, process_name, field, old_value, new_value, reason, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    changes.forEach((c) => {
      insChg.run(run.id, taskId, t.order_no, t.process_name, c.field, String(c.old == null ? '' : c.old), String(c.now == null ? '' : c.now), reason, operator, ts);
    });
    db.exec('COMMIT');
    return { task: db.prepare('SELECT * FROM schedule_tasks WHERE id = ?').get(taskId), changes: changes.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = {
  CONFLICT_LABEL,
  NON_CAPACITY,
  BASE_PROCESSES,
  todayStr,
  addDays,
  dateList,
  hm,
  atTime,
  workCenters,
  standardsMap,
  capacityPool,
  downtimeHours,
  calendarRows,
  processesOf,
  shortageOf,
  dueOf,
  plan,
  createRun,
  runView,
  currentRun,
  publishRun,
  adjustTask,
  nextRunNo,
  r2
};
