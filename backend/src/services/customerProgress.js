/**
 * 客户进度发布（TS-N22-02 / TS-N22-03）
 * ========================================================================
 * 一句话：内部照常报工，**客户只看我们主动发布过的快照**，而且这份快照里
 * 不会有工厂名、工人姓名、成本、返工数。
 *
 * ## 三条路线怎么判
 *
 * - `inhouse` 本厂：备料 → 裁剪 → 车缝 → 后整 → 检验 → 发运
 * - `cut_outsource` 裁片外发：本厂备料裁剪 → **外发（交出/回货）** → 回厂后整 → 检验 → 发运
 * - `full_outsource` 整单外发：**外发（交出/回货）** → 检验 → 发运
 *
 * 自动推断：该订单有 `cut_dispatches` 且外发数量 > 0 → 裁片外发；否则本厂。
 * 人工可改（旺季整单转外发很常见），改过就记 `source='manual'`，不再被自动覆盖。
 *
 * ## 最硬的一条
 *
 * **裁片外发没回厂、后整与终检没做，就不能出现「整单完工 / 可发货」**（原型原话）。
 * 客户看到「完工」就会安排自己的货代和上架计划，标早了是实打实的商业损失。
 * 所以 `can_complete` 由服务层算，不交给页面判断。
 */
const { db, now } = require('../db');
const { localDate } = require('../utils/time');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const today = () => localDate(now());
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const ROUTES = {
  inhouse: { label: '本厂生产', stages: ['prep', 'cut', 'sew', 'finish', 'inspect', 'ship'] },
  cut_outsource: { label: '裁片外发', stages: ['prep', 'cut', 'outsource', 'finish', 'inspect', 'ship'] },
  full_outsource: { label: '整单外发', stages: ['outsource', 'inspect', 'ship'] }
};

const STAGE_LABEL = {
  prep: '备料',
  cut: '裁剪',
  sew: '车缝',
  outsource: '外发加工',
  finish: '后整',
  inspect: '检验',
  ship: '发运'
};

// 内部工序 → 对外阶段。**这张表决定了客户看到什么，也决定了什么会被藏起来**
const NODE_STAGE = {
  备料: 'prep',
  排版算料: 'prep',
  裁剪: 'cut',
  车缝: 'sew',
  锁眼钉扣: 'sew',
  印花: 'sew',
  绣花: 'sew',
  水洗: 'sew',
  整烫: 'finish',
  包装: 'finish',
  成品入库: 'finish',
  检验: 'inspect',
  出库发运: 'ship'
};

/* ==================================================================== *
 * 一、路线
 * ==================================================================== */

function routeOf(orderId) {
  const manual = db.prepare('SELECT * FROM order_routes WHERE order_id = ?').get(Number(orderId));
  if (manual && manual.source === 'manual') return { route: manual.route, source: 'manual', note: manual.note };
  const inferred = inferRoute(orderId);
  return { route: inferred, source: 'auto', note: manual ? manual.note : null };
}

function inferRoute(orderId) {
  const d = db
    .prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(out_qty),0) q FROM cut_dispatches
        WHERE order_id = ? AND status <> 'void'`
    )
    .get(Number(orderId));
  if (d.c > 0 && Number(d.q) > 0) return 'cut_outsource';
  return 'inhouse';
}

function setRoute(orderId, body = {}, operator = '') {
  const route = String(body.route || '').trim();
  if (!ROUTES[route]) throw bad('路线只能是：本厂(inhouse) / 裁片外发(cut_outsource) / 整单外发(full_outsource)');
  const order = db.prepare('SELECT id, order_no FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) throw bad('订单不存在', 404);
  const t = now();
  const old = db.prepare('SELECT * FROM order_routes WHERE order_id = ?').get(order.id);
  if (old) {
    db.prepare('UPDATE order_routes SET route = ?, source = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .run(route, 'manual', body.note || old.note, operator, t, old.id);
  } else {
    db.prepare(
      `INSERT INTO order_routes (order_id, route, source, note, updated_by, created_at, updated_at)
       VALUES (?,?,'manual',?,?,?,?)`
    ).run(order.id, route, body.note || null, operator, t, t);
  }
  return {
    order_no: order.order_no, route, route_label: ROUTES[route].label,
    // 改路线会让客户看到的阶段变多变少，提醒一句
    warning: route === 'full_outsource'
      ? '整单外发下客户只会看到「外发加工 / 检验 / 发运」三个阶段，本厂的裁剪车缝不再展示'
      : null
  };
}

/* ==================================================================== *
 * 二、内部真实进度（不外发）
 * ==================================================================== */

function internal(orderId) {
  const order = db
    .prepare('SELECT id, order_no, style_name, status, delivery_date, customer_id FROM orders WHERE id = ?')
    .get(Number(orderId));
  if (!order) throw bad('订单不存在', 404);

  const nodes = db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq').all(order.id);
  const nodesByStage = {};
  nodes.forEach((n) => {
    const st = NODE_STAGE[n.name];
    if (!st) return;
    nodesByStage[st] = nodesByStage[st] || [];
    nodesByStage[st].push(n);
  });

  // 外发：交出 / 回货 / 验收 —— 三个数分开记（原型：交出、接收、合格、可发分别保存）
  const dispatch = db
    .prepare(
      `SELECT COUNT(*) cnt, COALESCE(SUM(out_qty),0) out_qty, COALESCE(SUM(returned_qty),0) returned_qty,
              COALESCE(SUM(accepted_qty),0) accepted_qty, COALESCE(SUM(rejected_qty),0) rejected_qty,
              MAX(status) status
         FROM cut_dispatches WHERE order_id = ? AND status <> 'void'`
    )
    .get(order.id);

  const reps = db
    .prepare('SELECT COALESCE(SUM(qty_ok),0) ok, COALESCE(SUM(qty_defect),0) bad FROM production_reports WHERE order_id = ?')
    .get(order.id);

  const { route } = routeOf(order.id);
  const stages = ROUTES[route].stages.map((key) => {
    if (key === 'outsource') {
      const out = Number(dispatch.out_qty) || 0;
      const back = Number(dispatch.returned_qty) || 0;
      const done = dispatch.cnt > 0 && out > 0 && back >= out;
      return {
        key, label: STAGE_LABEL[key],
        status: dispatch.cnt === 0 ? 'pending' : done ? 'done' : 'doing',
        out_qty: out, returned_qty: back, accepted_qty: Number(dispatch.accepted_qty) || 0,
        dispatch_count: dispatch.cnt,
        done_at: null
      };
    }
    const mine = nodesByStage[key] || [];
    const allDone = mine.length > 0 && mine.every((n) => n.status === 'done');
    const anyDone = mine.some((n) => n.status === 'done');
    const dates = mine.map((n) => n.actual_date).filter(Boolean).sort();
    return {
      key, label: STAGE_LABEL[key],
      status: allDone ? 'done' : anyDone ? 'doing' : 'pending',
      node_count: mine.length,
      done_at: allDone && dates.length ? dates[dates.length - 1] : null
    };
  });

  const doneCount = stages.filter((s) => s.status === 'done').length;
  const canComplete = stages.every((s) => s.status === 'done');

  // 为什么还不能说完工 —— 必须能一条条说出来
  const blockers = [];
  stages.filter((s) => s.status !== 'done').forEach((s) => {
    if (s.key === 'outsource' && s.dispatch_count > 0) {
      blockers.push(`外发还没全部回货（交出 ${s.out_qty}，已回 ${s.returned_qty}）`);
    } else if (s.key === 'outsource') {
      blockers.push('还没有外发记录');
    } else if (s.key === 'finish' && route === 'cut_outsource') {
      blockers.push('回厂后整还没完成');
    } else if (s.key === 'inspect') {
      blockers.push('终检还没完成');
    } else {
      blockers.push(`${s.label}还没完成`);
    }
  });

  return {
    order,
    route,
    route_label: ROUTES[route].label,
    stages,
    done_count: doneCount,
    stage_count: stages.length,
    progress_pct: stages.length ? r2((doneCount / stages.length) * 100) : 0,
    can_complete: canComplete,
    blockers,
    internal_only: {
      nodes_total: nodes.length,
      qty_ok: r2(reps.ok),
      qty_defect: r2(reps.bad),
      dispatch_status: dispatch.status || null,
      // 这些字段客户永远看不到，列出来是为了让销售知道「为什么客户看不到」
      hidden: ['外发工厂名称', '加工单价与金额', '返工数', '工人姓名', '内部备注']
    }
  };
}

/* ==================================================================== *
 * 三、生成客户投影（快照内容）
 * ==================================================================== */

function projection(orderId, opts = {}) {
  const it = internal(orderId);
  const showQty = !!opts.show_qty;
  const showPlan = opts.show_plan !== false; // 默认给预计完成日（客户最关心），可关

  const stages = it.stages.map((s, i) => {
    const out = {
      key: s.key,
      label: s.label,
      status: s.status,
      status_label: s.status === 'done' ? '已完成' : s.status === 'doing' ? '进行中' : '未开始',
      // 对外只到天，不给具体时刻（避免客户拿分钟级时间来质疑）
      done_at: s.status === 'done' ? s.done_at : null,
      seq: i + 1
    };
    if (showQty && (s.key === 'sew' || s.key === 'finish')) {
      // 合格数取报工累计，仅对车缝/后整显示（客户关心的是「做了多少件」）
      out.qty_ok = it.internal_only.qty_ok;
    }
    return out;
  });

  return {
    order_no: it.order.order_no,
    style_name: it.order.style_name,
    route: it.route,
    route_label: it.route_label,
    stages,
    done_count: it.done_count,
    stage_count: it.stage_count,
    progress_pct: it.progress_pct,
    // 「完工 / 可发货」只在真的满足条件时才给客户，否则连字段都不出现
    completed: it.can_complete,
    completion_label: it.can_complete ? '已完工，可安排发货' : null,
    plan_finish: showPlan ? it.order.delivery_date || null : null,
    published_at: null,
    note: it.can_complete
      ? null
      : `尚有 ${it.blockers.length} 项未完成：${it.blockers.slice(0, 3).join('；')}${it.blockers.length > 3 ? ' 等' : ''}`
  };
}

/**
 * 发布前要挡的自相矛盾（预览与发布共用一份判断）
 * 返回给发布人看的警告文案，不阻断 —— 业务可以分阶段对外，但必须知道客户会看到什么。
 */
function consistencyWarnings(orderId) {
  const it = internal(orderId);
  const warnings = [];
  const outStage = it.stages.find((s) => s.key === 'outsource');
  if (outStage && (it.route === 'cut_outsource' || it.route === 'full_outsource')) {
    const laterDone = it.stages.some((s) => ['finish', 'inspect', 'ship'].includes(s.key) && s.status !== 'pending');
    if (!outStage.dispatch_count) {
      warnings.push('这单没有任何外发记录，客户会看到「外发加工 未开始」。如果实际是本厂做的，请把路线改回「本厂生产」再发布');
    }
    if (!outStage.dispatch_count && laterDone) {
      warnings.push('外发阶段没开始，但后整/检验/发运已有进度 —— 客户看到会自相矛盾，建议先核对路线');
    }
  }
  return warnings;
}

/** 内部预览：客户将会看到什么 + 我们藏了什么 */
function preview(orderId, opts = {}) {
  const proj = projection(orderId, opts);
  const it = internal(orderId);
  return {
    ...proj,
    hidden: it.internal_only.hidden,
    can_complete: it.can_complete,
    blockers: it.blockers,
    // 让销售清楚这句话是从哪来的（发布页上直接显示）
    warnings: consistencyWarnings(orderId),
    rule_note: it.route === 'cut_outsource'
      ? '裁片外发：外发未全部回货、或回厂后整/终检未完成时，页面不会出现「完工 / 可发货」'
      : it.route === 'full_outsource'
        ? '整单外发：外发未全部回货、或终检未完成时不出现「完工 / 可发货」'
        : '本厂：六个阶段全部完成后才出现「完工 / 可发货」'
  };
}

/* ==================================================================== *
 * 四、发布 / 撤回 / 版本
 * ==================================================================== */

function publish(orderId, body = {}, operator = '') {
  const order = db.prepare('SELECT id, order_no, status FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) throw bad('订单不存在', 404);
  if (['draft', 'cancelled'].includes(order.status)) {
    throw bad(`订单当前为「${order.status}」，还没进入生产，没有可发布的进度`);
  }
  const existing = db.prepare("SELECT * FROM progress_publications WHERE order_id = ? AND status = 'published'").get(order.id);
  const snap = projection(order.id, body);
  const lastVer = db.prepare('SELECT COALESCE(MAX(version_no),0) v FROM progress_publications WHERE order_id = ?').get(order.id).v;
  const t = now();

  // 已有生效版本时，先把它标为 withdrawn（留版本，不删）
  if (existing) {
    db.prepare(
      `UPDATE progress_publications SET status='withdrawn', withdrawn_by=?, withdrawn_at=?, withdraw_reason=? WHERE id=?`
    ).run(operator || null, t, '重新发布新版本（自动撤回旧版）', existing.id);
  }

  const info = db
    .prepare(
      `INSERT INTO progress_publications (order_id, version_no, status, route, snapshot, stage_count, done_count,
         can_complete, show_qty, published_by, published_at, note)
       VALUES (?,?, 'published', ?,?,?,?,?,?,?,?,?)`
    )
    .run(order.id, lastVer + 1, snap.route, JSON.stringify(snap), snap.stage_count, snap.done_count,
      snap.completed ? 1 : 0, body.show_qty ? 1 : 0, operator || null, t, body.note || null);

  // 路线与外发记录对不上时，客户看到的会是自相矛盾的进度（判断与预览共用一份）
  const warnings = consistencyWarnings(order.id);

  return {
    id: Number(info.lastInsertRowid), order_no: order.order_no, version_no: lastVer + 1,
    stage_count: snap.stage_count, done_count: snap.done_count, completed: snap.completed,
    warnings,
    note: snap.completed ? '已对外发布：客户可见「可安排发货」' : '已对外发布；因未全部完成，客户看到的是「进行中」'
  };
}

function withdraw(id, body = {}, operator = '') {
  const row = db.prepare('SELECT * FROM progress_publications WHERE id = ?').get(Number(id));
  if (!row) throw bad('发布记录不存在', 404);
  if (row.status !== 'published') throw bad('这条已经不是生效版本了');
  const reason = String(body.reason || '').trim();
  if (reason.length < 4) throw bad('撤回要写原因（至少 4 个字）—— 客户那边已经看到了，撤回本身就是一次对外沟通');
  const t = now();
  db.prepare("UPDATE progress_publications SET status='withdrawn', withdrawn_by=?, withdrawn_at=?, withdraw_reason=? WHERE id=?")
    .run(operator || null, t, reason, row.id);
  return {
    id: row.id, order_id: row.order_id, version_no: row.version_no, status: 'withdrawn',
    note: '已撤回。撤回后客户侧显示「暂无对外进度」，直到重新发布'
  };
}

function history(orderId) {
  return db
    .prepare('SELECT id, version_no, status, route, stage_count, done_count, can_complete, published_by, published_at, withdrawn_by, withdrawn_at, withdraw_reason FROM progress_publications WHERE order_id = ? ORDER BY version_no DESC')
    .all(Number(orderId));
}

/* ==================================================================== *
 * 五、内部列表（发布页用）
 * ==================================================================== */

function listOrders(q = {}) {
  const where = ["o.status IN ('production','shipped','closed')"];
  const args = [];
  if (q.q) {
    where.push('(o.order_no LIKE ? OR o.style_name LIKE ?)');
    args.push(`%${q.q}%`, `%${q.q}%`);
  }
  const rows = db
    .prepare(
      `SELECT o.id, o.order_no, o.style_name, o.status, o.delivery_date, o.customer_id,
              c.name AS customer_name,
              (SELECT COUNT(*) FROM progress_publications p WHERE p.order_id = o.id) AS pub_count,
              (SELECT p.version_no FROM progress_publications p WHERE p.order_id = o.id AND p.status='published') AS live_version
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY o.id DESC LIMIT 200`
    )
    .all(...args);

  return rows.map((r) => {
    let it = null;
    try { it = internal(r.id); } catch (e) { it = null; }
    return {
      ...r,
      route: it ? it.route : null,
      route_label: it ? it.route_label : null,
      done_count: it ? it.done_count : 0,
      stage_count: it ? it.stage_count : 0,
      progress_pct: it ? it.progress_pct : 0,
      can_complete: it ? it.can_complete : false,
      published: !!r.live_version,
      // 内部进度已变但还没重新发布 —— 客户看到的还是旧快照，必须能一眼看出来
      stale: !!r.live_version && it ? it.done_count !== (db.prepare('SELECT done_count FROM progress_publications WHERE order_id=? AND status=?').get(r.id, 'published') || {}).done_count : false
    };
  });
}

/* ==================================================================== *
 * 六、客户侧（只读快照）
 * ==================================================================== */

/** 客户能看到的订单：必须是本公司客户，且订单已发布 */
function customerOrders(customerId) {
  const rows = db
    .prepare(
      `SELECT o.id, o.order_no, o.style_name, o.status, o.delivery_date,
              p.version_no, p.published_at, p.snapshot, p.can_complete
         FROM orders o
         JOIN progress_publications p ON p.order_id = o.id AND p.status = 'published'
        WHERE o.customer_id = ?
        ORDER BY o.id DESC`
    )
    .all(Number(customerId));

  return rows.map((r) => {
    const snap = safeJson(r.snapshot) || {};
    return {
      order_id: r.id,
      order_no: r.order_no,
      style_name: r.style_name,
      // 客户看到的进度以快照为准，不用内部实时值
      progress_pct: snap.progress_pct || 0,
      done_count: snap.done_count || 0,
      stage_count: snap.stage_count || 0,
      completed: !!r.can_complete,
      current_stage: (snap.stages || []).find((s) => s.status === 'doing')
        || (snap.stages || []).filter((s) => s.status === 'done').slice(-1)[0]
        || null,
      plan_finish: snap.plan_finish || null,
      published_at: r.published_at,
      version_no: r.version_no
    };
  });
}

function customerOrderProgress(customerId, orderId) {
  const row = db
    .prepare(
      `SELECT p.*, o.customer_id, o.order_no
         FROM progress_publications p JOIN orders o ON o.id = p.order_id
        WHERE p.order_id = ? AND p.status = 'published'`
    )
    .get(Number(orderId));
  if (!row) return { published: false, order_id: Number(orderId), hint: '这单还没有对外发布进度，请联系业务员' };
  if (Number(row.customer_id) !== Number(customerId)) throw bad('只能查看自己公司的订单', 403);
  const snap = safeJson(row.snapshot) || {};
  return {
    published: true,
    order_no: row.order_no,
    version_no: row.version_no,
    published_at: row.published_at,
    ...snap
  };
}

function safeJson(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

/* ==================================================================== *
 * 七、统计与字典
 * ==================================================================== */

function stats() {
  const g = (sql, ...a) => db.prepare(sql).get(...a).c;
  // 裁片外发多数是自动推断出来的（cut_dispatches 有记录），order_routes 里只有人工指定的；
  // 所以两个来源要一起算，否则「裁片外发 0 单」会和下面的列表自相矛盾。
  const cutOut = g("SELECT COUNT(DISTINCT order_id) c FROM cut_dispatches WHERE status <> 'void'");
  const fullOut = g("SELECT COUNT(*) c FROM order_routes WHERE route = 'full_outsource'");
  const production = g("SELECT COUNT(*) c FROM orders WHERE status IN ('production','shipped')");
  return {
    orders_in_production: production,
    published: g("SELECT COUNT(DISTINCT order_id) c FROM progress_publications WHERE status='published'"),
    versions: g('SELECT COUNT(*) c FROM progress_publications'),
    withdrawn: g("SELECT COUNT(*) c FROM progress_publications WHERE status='withdrawn'"),
    cut_outsource: cutOut,
    full_outsource: fullOut,
    inhouse: Math.max(0, production - cutOut - fullOut)
  };
}

function dict() {
  return {
    routes: Object.entries(ROUTES).map(([v, c]) => ({ value: v, label: c.label, stages: c.stages.map((k) => STAGE_LABEL[k]) })),
    stages: Object.entries(STAGE_LABEL).map(([v, l]) => ({ value: v, label: l })),
    stats: stats()
  };
}

module.exports = {
  ROUTES, STAGE_LABEL, NODE_STAGE,
  routeOf, setRoute, inferRoute,
  internal, projection, preview,
  publish, withdraw, history, listOrders,
  customerOrders, customerOrderProgress,
  stats, dict, today
};
