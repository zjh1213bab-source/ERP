/**
 * 有限产能排程（M06）
 * ============================================================
 * 权限：
 *   读 —— 全部业务角色（销售看自己订单排到哪天）
 *   写 —— admin / production（维护班次日历、工序定额、生成与调整排程）
 *   发布 —— admin / production（**发布即对生产下发，必须先把硬冲突处理完**）
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/scheduling');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'production'];
const PUBLISH = ['admin', 'production'];

/** 统一错误出口：带 code 的业务错误按 code 返回，其余 400 */
function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      const code = e.code && Number.isInteger(e.code) ? e.code : 400;
      if (e.payload) return res.status(code).json({ ok: false, message: e.message, data: e.payload });
      return fail(res, code, e.message);
    }
  };
}

const opName = (req) => (req.user && (req.user.name || req.user.username)) || String((req.user && (req.user.id || req.user.sub)) || 'system');

/** ==================== 字典与概况 ==================== */
router.get('/meta', authRequired, requireRole(...READ), (req, res) => {
  const wcs = S.workCenters();
  const stds = db.prepare('SELECT * FROM process_standards ORDER BY work_center, process_name').all()
    .map((s) => ({ ...s, pieces_per_hour: s.std_minutes > 0 ? S.r2(60 / s.std_minutes) : 0 }));
  const calRange = db.prepare('SELECT MIN(cal_date) AS from_d, MAX(cal_date) AS to_d, COUNT(*) AS n, COUNT(DISTINCT work_center) AS wc FROM wc_calendars').get();
  const cur = S.currentRun(1);
  return ok(res, {
    work_centers: wcs,
    standards: stds,
    calendar: calRange,
    current_run: cur || null,
    today: S.todayStr(),
    conflict_labels: S.CONFLICT_LABEL,
    non_capacity: S.NON_CAPACITY
  });
});

/** 可排订单预览：谁在队列里、交期、缺料、要做几道工序 */
router.get('/orders', authRequired, requireRole(...READ), (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM orders WHERE company_id = 1 AND status IN ('tech','finance','assigned','production') ORDER BY COALESCE(delivery_date,'9999'), id`
  ).all();
  const out = rows.map((o) => {
    const d = S.dueOf(o);
    const sh = S.shortageOf(o.id);
    const procs = S.processesOf(o.id);
    const qty = db.prepare(
      'SELECT COALESCE(SUM(s.qty),0) q FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?'
    ).get(o.id).q;
    return {
      id: o.id, order_no: o.order_no, status: o.status, style_name: o.style_name,
      qty: Number(qty) || 0,
      due: d.due, review: d.review,
      process_count: procs.length,
      processes: procs.map((p) => p.name),
      shortage_count: sh.count, shortage_eta: sh.eta, shortage_no_eta: sh.no_eta,
      in_schedule: Boolean(db.prepare("SELECT 1 x FROM schedule_tasks t JOIN schedule_runs r ON r.id = t.run_id WHERE r.is_current = 1 AND t.order_id = ? LIMIT 1").get(o.id))
    };
  });
  return ok(res, out);
});

/** ==================== 班次日历 ==================== */
router.get('/calendars', authRequired, requireRole(...READ), (req, res) => {
  const from = String(req.query.from || S.todayStr()).slice(0, 10);
  const to = String(req.query.to || S.addDays(from, 20)).slice(0, 10);
  const wc = String(req.query.work_center || '').trim();
  const rows = S.calendarRows(from, to, wc);
  const wcs = wc ? [wc] : S.workCenters().map((x) => x.work_center);
  const dates = S.dateList(from, to);
  const have = new Set(rows.map((r) => `${r.work_center}|${r.cal_date}`));
  const missing = [];
  wcs.forEach((w) => dates.forEach((d) => { if (!have.has(`${w}|${d}`)) missing.push({ work_center: w, date: d }); }));
  return ok(res, { from, to, work_centers: wcs, dates, rows, missing });
});

/** 单条 upsert（0 小时 = 休息/停产） */
router.post('/calendars', authRequired, requireRole(...WRITE), (req, res) => {
  const b = req.body || {};
  const wc = String(b.work_center || '').trim();
  const date = String(b.cal_date || '').slice(0, 10);
  if (!wc) return fail(res, 400, '请选择工作中心');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 400, '日期格式必须是 YYYY-MM-DD');
  const base = Number(b.base_hours);
  if (!Number.isFinite(base) || base < 0 || base > 24) return fail(res, 400, '基准工时必须在 0~24 之间');
  const startHour = b.start_hour === undefined ? 8 : Number(b.start_hour);
  if (!Number.isFinite(startHour) || startHour < 0 || startHour >= 24) return fail(res, 400, '班次开始时间必须在 0~24 之间');
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO wc_calendars (company_id, work_center, cal_date, base_hours, start_hour, is_workday, note, created_by, created_at, updated_at)
     VALUES (1,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(work_center, cal_date) DO UPDATE SET
       base_hours = excluded.base_hours, start_hour = excluded.start_hour,
       is_workday = excluded.is_workday, note = excluded.note, updated_at = excluded.updated_at`
  ).run(wc, date, base, startHour, base > 0 ? 1 : 0, b.note || null, opName(req), ts, ts);
  return ok(res, db.prepare('SELECT * FROM wc_calendars WHERE work_center = ? AND cal_date = ?').get(wc, date));
});

/**
 * 批量填充：显式写入每一天（不写库就没有默认值）
 * body: { work_center | work_centers[], from, to, base_hours, start_hour, weekdays_only, overrides:[{date, base_hours}] }
 */
router.post('/calendars/fill', authRequired, requireRole(...WRITE), (req, res) => {
  try {
  const b = req.body || {};
  const from = String(b.from || '').slice(0, 10);
  const to = String(b.to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return fail(res, 400, '日期区间不合法');
  if (from > to) return fail(res, 400, '开始日期不能晚于结束日期');
  const list = Array.isArray(b.work_centers) && b.work_centers.length
    ? b.work_centers.map((x) => String(x).trim()).filter(Boolean)
    : (b.work_center ? [String(b.work_center).trim()] : S.workCenters().map((x) => x.work_center));
  if (!list.length) return fail(res, 400, '没有可填充的工作中心');
  const base = Number(b.base_hours === undefined ? 8 : b.base_hours);
  if (!Number.isFinite(base) || base < 0 || base > 24) return fail(res, 400, '基准工时必须在 0~24 之间');
  const startHour = b.start_hour === undefined ? 8 : Number(b.start_hour);
  const weekdaysOnly = b.weekdays_only === undefined ? true : Boolean(b.weekdays_only);
  const overrides = {};
  (Array.isArray(b.overrides) ? b.overrides : []).forEach((x) => {
    if (x && x.date) overrides[String(x.date).slice(0, 10)] = Number(x.base_hours);
  });

  const dates = S.dateList(from, to);
  const ts = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO wc_calendars (company_id, work_center, cal_date, base_hours, start_hour, is_workday, note, created_by, created_at, updated_at)
     VALUES (1,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(work_center, cal_date) DO UPDATE SET
       base_hours = excluded.base_hours, start_hour = excluded.start_hour,
       is_workday = excluded.is_workday, note = excluded.note, updated_at = excluded.updated_at`
  );

  let written = 0;
  db.exec('BEGIN');
  try {
    list.forEach((wc) => {
      dates.forEach((d) => {
        const dow = new Date(`${d}T00:00:00`).getDay();
        let hours = base;
        if (overrides[d] !== undefined && Number.isFinite(overrides[d])) hours = Number(overrides[d]);
        else if (weekdaysOnly && (dow === 0 || dow === 6)) hours = 0;
        stmt.run(wc, d, hours, startHour, hours > 0 ? 1 : 0, hours > 0 ? null : '休息 / 停产', opName(req), ts, ts);
        written += 1;
      });
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, { written, work_centers: list, from, to, base_hours: base, weekdays_only: weekdaysOnly });
  } catch (e) {
    return fail(res, 400, e.message);
  }
});

/** ==================== 工序定额 ==================== */
router.get('/standards', authRequired, requireRole(...READ), (req, res) => {
  const rows = db.prepare('SELECT * FROM process_standards ORDER BY work_center, process_name').all();
  return ok(res, rows.map((s) => ({
    ...s,
    pieces_per_hour: s.std_minutes > 0 ? S.r2(60 / s.std_minutes) : 0,
    configured: s.std_minutes > 0 && s.work_center
  })));
});

router.post('/standards', authRequired, requireRole(...WRITE), (req, res) => {
  const b = req.body || {};
  const name = String(b.process_name || '').trim();
  const wc = String(b.work_center || '').trim();
  if (!name) return fail(res, 400, '工序名称必填');
  if (!wc) return fail(res, 400, '承做工作中心必填');
  const std = Number(b.std_minutes);
  if (!Number.isFinite(std) || std <= 0) return fail(res, 400, '单件标准工时必须大于 0（0 工时等于无限产能）');
  if (std > 600) return fail(res, 400, '单件标准工时超过 600 分钟，请核对单位（应为分钟/件）');
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO process_standards (process_name, work_center, std_minutes, setup_minutes, efficiency, batch_min_qty, active, remark, updated_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(process_name) DO UPDATE SET
       work_center = excluded.work_center, std_minutes = excluded.std_minutes,
       setup_minutes = excluded.setup_minutes, efficiency = excluded.efficiency,
       batch_min_qty = excluded.batch_min_qty, active = excluded.active,
       remark = excluded.remark, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(
    name, wc, std,
    Number(b.setup_minutes) || 0,
    b.efficiency === undefined ? 85 : Number(b.efficiency) || 85,
    Number(b.batch_min_qty) || 0,
    b.active === undefined ? 1 : (b.active ? 1 : 0),
    b.remark || null, opName(req), ts, ts
  );
  return ok(res, db.prepare('SELECT * FROM process_standards WHERE process_name = ?').get(name));
});

router.put('/standards/:id', authRequired, requireRole(...WRITE), (req, res) => {
  const row = db.prepare('SELECT * FROM process_standards WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '定额不存在');
  const b = req.body || {};
  const std = b.std_minutes === undefined ? row.std_minutes : Number(b.std_minutes);
  if (!Number.isFinite(std) || std <= 0) return fail(res, 400, '单件标准工时必须大于 0（0 工时等于无限产能）');
  const wc = b.work_center === undefined ? row.work_center : String(b.work_center).trim();
  if (!wc) return fail(res, 400, '承做工作中心必填');
  db.prepare(
    'UPDATE process_standards SET work_center=?, std_minutes=?, setup_minutes=?, efficiency=?, batch_min_qty=?, active=?, remark=?, updated_by=?, updated_at=? WHERE id=?'
  ).run(
    wc, std,
    b.setup_minutes === undefined ? row.setup_minutes : Number(b.setup_minutes) || 0,
    b.efficiency === undefined ? row.efficiency : Number(b.efficiency) || 85,
    b.batch_min_qty === undefined ? row.batch_min_qty : Number(b.batch_min_qty) || 0,
    b.active === undefined ? row.active : (b.active ? 1 : 0),
    b.remark === undefined ? row.remark : b.remark,
    opName(req), new Date().toISOString(), row.id
  );
  return ok(res, db.prepare('SELECT * FROM process_standards WHERE id = ?').get(row.id));
});

/** ==================== 排程批次 ==================== */
router.get('/runs', authRequired, requireRole(...READ), (req, res) => {
  const rows = db.prepare('SELECT * FROM schedule_runs ORDER BY id DESC LIMIT 100').all();
  return ok(res, rows);
});

/** 预演：只算不落库，让计划员先看「排得下排不下」 */
router.post('/runs/preview', authRequired, requireRole(...WRITE), (req, res) => {
  const b = req.body || {};
  const from = String(b.from || S.todayStr()).slice(0, 10);
  const to = String(b.to || S.addDays(from, 20)).slice(0, 10);
  if (from > to) return fail(res, 400, '窗口开始不能晚于结束');
  const resv = S.plan({
    from, to, algo: b.algo || 'edd',
    orderIds: Array.isArray(b.order_ids) ? b.order_ids : null,
    carryLocked: b.carry_locked === undefined ? true : Boolean(b.carry_locked),
    materialGate: b.material_gate === undefined ? true : Boolean(b.material_gate),
    companyId: 1
  });
  const byType = {};
  resv.conflicts.forEach((c) => { byType[c.type] = (byType[c.type] || 0) + 1; });
  const ordered = resv.conflicts.slice().sort((a, b) => {
    if (a.level !== b.level) return a.level === 'block' ? -1 : 1;
    return 0;
  });
  return ok(res, {
    from, to,
    stats: resv.stats,
    conflicts: ordered,
    conflicts_by_type: byType,
    missing: resv.missing,
    tasks: resv.tasks.slice(0, 200)
  });
});

router.post('/runs', authRequired, requireRole(...WRITE), (req, res) => {
  const b = req.body || {};
  const from = String(b.from || S.todayStr()).slice(0, 10);
  const to = String(b.to || S.addDays(from, 20)).slice(0, 10);
  if (from > to) return fail(res, 400, '窗口开始不能晚于结束');
  try {
    const created = S.createRun({
      from, to, algo: b.algo || 'edd',
      orderIds: Array.isArray(b.order_ids) ? b.order_ids : null,
      carryLocked: b.carry_locked === undefined ? true : Boolean(b.carry_locked),
      materialGate: b.material_gate === undefined ? true : Boolean(b.material_gate),
      companyId: 1, operator: opName(req), note: b.note || null
    });
    return ok(res, created);
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 400;
    if (e.payload) return res.status(code).json({ ok: false, message: e.message, data: e.payload });
    return fail(res, code, e.message);
  }
});

router.get('/runs/:id', authRequired, requireRole(...READ), (req, res) => {
  const v = S.runView(req.params.id);
  if (!v) return fail(res, 404, '排程批次不存在');
  return ok(res, v);
});

router.post('/runs/:id/publish', authRequired, requireRole(...PUBLISH), (req, res) => {
  try {
    return ok(res, S.publishRun(req.params.id, opName(req), (req.body || {}).note));
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 400;
    if (e.payload) return res.status(code).json({ ok: false, message: e.message, data: e.payload });
    return fail(res, code, e.message);
  }
});

router.post('/runs/:id/archive', authRequired, requireRole(...PUBLISH), (req, res) => {
  const run = db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(req.params.id);
  if (!run) return fail(res, 404, '排程批次不存在');
  if (run.is_current) return fail(res, 400, '当前生效的排程不能归档，请先发布新版本');
  db.prepare("UPDATE schedule_runs SET status = 'archived', archived_at = ? WHERE id = ?").run(new Date().toISOString(), run.id);
  return ok(res, db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(run.id));
});

/** ==================== 冲突处理 ==================== */
router.get('/conflicts', authRequired, requireRole(...READ), (req, res) => {
  const runId = req.query.run_id
    || (S.currentRun(1) || {}).id
    || (db.prepare('SELECT id FROM schedule_runs ORDER BY id DESC LIMIT 1').get() || {}).id;
  if (!runId) return ok(res, []);
  const rows = db.prepare("SELECT * FROM schedule_conflicts WHERE run_id = ? ORDER BY (level='block') DESC, id").all(runId)
    .map((c) => ({ ...c, type_label: S.CONFLICT_LABEL[c.type] || c.type }));
  return ok(res, rows);
});

/** 处理硬冲突：必须写处理意见，不能一键「忽略」而不留痕 */
router.post('/conflicts/:id/resolve', authRequired, requireRole(...WRITE), (req, res) => {
  const row = db.prepare('SELECT * FROM schedule_conflicts WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '冲突不存在');
  const note = String((req.body || {}).note || '').trim();
  if (!note) return fail(res, 400, '处理冲突必须写处理意见');
  if (note.length < 4) return fail(res, 400, '处理意见太短，请写清怎么处理的');
  const ts = new Date().toISOString();
  db.prepare('UPDATE schedule_conflicts SET resolved = 1, resolved_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
    .run(note, opName(req), ts, row.id);
  return ok(res, db.prepare('SELECT * FROM schedule_conflicts WHERE id = ?').get(row.id));
});

/** ==================== 任务调整 ==================== */
router.patch('/tasks/:id', authRequired, requireRole(...WRITE), (req, res) => {
  try {
    return ok(res, S.adjustTask(req.params.id, req.body || {}, opName(req)));
  } catch (e) {
    return fail(res, 400, e.message);
  }
});

router.get('/changes', authRequired, requireRole(...READ), (req, res) => {
  const runId = req.query.run_id
    || (S.currentRun(1) || {}).id
    || (db.prepare('SELECT id FROM schedule_runs ORDER BY id DESC LIMIT 1').get() || {}).id;
  if (!runId) return ok(res, []);
  return ok(res, db.prepare('SELECT * FROM schedule_changes WHERE run_id = ? ORDER BY id DESC').all(runId));
});

/** 当天各工作中心负载（与设备产能日历对照用） */
router.get('/load', authRequired, requireRole(...READ), (req, res) => {
  const cur = S.currentRun(1);
  if (!cur) return ok(res, { run: null, rows: [] });
  const v = S.runView(cur.id);
  return ok(res, { run: cur, rows: v.day_load });
});

module.exports = router;
