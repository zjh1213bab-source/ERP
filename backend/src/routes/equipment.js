/**
 * 设备停机与产能影响（原型 TS-N08-08）
 * 只做设备日历 + 停机报修 + 受影响排程，不做 IoT 采集平台。
 *
 * 设备台账
 * GET  /api/equipment/board                 台账 + 当前停机 + 指标（?work_center=&q=）
 * POST /api/equipment                       建设备
 * PUT  /api/equipment/:id                    改设备
 *
 * 停机报修
 * GET  /api/equipment/downtimes              停机单列表（?status=&work_center=&q=&equipment_id=）
 * POST /api/equipment/downtimes              登记停机/保养 { equipment_id, type, start_at, reason, repair_task, affected_orders }
 * POST /api/equipment/downtimes/:id/start-repair    待维修/计划保养 → 维修中
 * POST /api/equipment/downtimes/:id/finish-repair   维修中 → 待安全复核（需维修说明）
 * POST /api/equipment/downtimes/:id/safety          安全复核放行 → 已恢复（**人工确认，不自动**）
 * POST /api/equipment/downtimes/:id/cancel          作废（误报/重复登记）
 *
 * 产能
 * GET  /api/equipment/capacity?work_center=&date=   当天基准台时 / 停机占用 / 可用台时 / 产能损失
 *
 * 硬规则：
 * 1. 登记必填设备、停机开始、原因
 * 2. 同一设备不能同时有两条未结停机单（待维修 / 维修中 / 待安全复核）
 * 3. 不能跳过安全复核直接恢复；安全放行必须人工指定责任人并写依据
 * 4. 放行人不能是登记人本人（admin 例外）—— 自己登记自己放行，等于没复核
 * 5. 停机期间设备 status 置为 stopped/maintenance，恢复后才回 running；**维修占用期间不承诺产能**
 * 6. 产能损失 = 占用工时 × 台时产能（登记时的快照），恢复时按实际结束时间重算
 * 7. 受影响订单在登记时记录，恢复后仍保留，便于复盘交期风险
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { nextNo } = require('../utils/docNo');

const router = express.Router();
const WRITE = ['admin', 'production', 'warehouse', 'tech'];
const READ = ['admin', 'production', 'warehouse', 'tech', 'sales', 'finance'];

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const EPS = 0.005;

const DT_LABEL = {
  planned: '计划保养',
  pending_repair: '待维修',
  repairing: '维修中',
  pending_safety: '待安全复核',
  recovered: '已恢复',
  cancelled: '已作废'
};
const TYPE_LABEL = {
  breakdown: '故障停机',
  maintenance: '计划保养',
  changeover: '换款调试',
  power: '停电/外部'
};
const EQ_TYPE = {
  sewing: '缝纫', cutting: '裁剪', ironing: '整烫', washing: '水洗',
  printing: '印花', embroidery: '绣花', inspection: '检验', other: '其他'
};
const EQ_STATUS = { running: '运行', stopped: '停机', maintenance: '保养中', retired: '报废' };

const OPEN_STATUSES = ['planned', 'pending_repair', 'repairing', 'pending_safety'];

/** 统一时间解析：支持 'YYYY-MM-DDTHH:mm' / 'YYYY-MM-DD HH:mm[:ss]' */
function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}
/**
 * 统一时间格式：一律存「本地墙钟时间」字符串 YYYY-MM-DD HH:mm:ss
 * - 前端 datetime-local 给的是本地墙钟（'2026-10-27T09:30'）
 * - now() 给的是 UTC ISO（'2026-10-27T06:10:12.345Z'）→ 必须换算成本地墙钟，否则差 8 小时
 */
function normTime(s) {
  if (!s) return null;
  const raw = String(s).trim();
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 19).replace('T', ' ');
  }
  const t = raw.replace('T', ' ');
  return t.length === 16 ? t + ':00' : t.slice(0, 19);
}
function hoursBetween(a, b) {
  const t1 = parseTime(a);
  const t2 = parseTime(b);
  if (t1 === null || t2 === null || t2 <= t1) return 0;
  return round2((t2 - t1) / 3600000);
}
function occupiedOf(row) {
  const end = row.end_at || normTime(now());
  return hoursBetween(row.start_at, end);
}

function dtView(id) {
  const r = db.prepare('SELECT * FROM equipment_downtimes WHERE id = ?').get(id);
  if (!r) return null;
  let affected = [];
  try { affected = r.affected_orders ? JSON.parse(r.affected_orders) : []; } catch (e) { affected = []; }
  const occ = occupiedOf(r);
  const loss = round2(occ * (Number(r.capacity_per_hour) || 0));
  return {
    ...r,
    affected_orders: affected,
    occupied_hours: occ,
    capacity_loss: loss,
    status_label: DT_LABEL[r.status] || r.status,
    type_label: TYPE_LABEL[r.type] || r.type,
    open: OPEN_STATUSES.includes(r.status)
  };
}

/** 某工作中心某天的产能占用（按停机区间与该天重叠小时数算） */
function dayCapacity(workCenter, date) {
  const dayStart = parseTime(`${date}T00:00:00`);
  const dayEnd = dayStart + 86400000;
  const eqs = db.prepare('SELECT * FROM equipment WHERE active = 1 AND (? = \'\' OR work_center = ?)').all(workCenter, workCenter);
  const shiftHours = 8;
  const baseHours = round2(eqs.length * shiftHours);
  const baseQty = round2(eqs.reduce((a, e) => a + (Number(e.capacity_per_hour) || 0) * shiftHours, 0));

  const rows = db.prepare(
    "SELECT * FROM equipment_downtimes WHERE status != 'cancelled' AND (? = '' OR work_center = ?)"
  ).all(workCenter, workCenter);

  let downtimeHours = 0;
  let lossQty = 0;
  const detail = [];
  rows.forEach((r) => {
    const s = Math.max(parseTime(r.start_at), dayStart);
    const e = Math.min(parseTime(r.end_at || normTime(now())), dayEnd);
    if (e <= s) return;
    const h = round2((e - s) / 3600000);
    const perHour = Number(r.capacity_per_hour) || 0;
    const qty = round2(h * perHour);
    downtimeHours += h;
    lossQty += qty;
    detail.push({
      dt_no: r.dt_no, equipment: r.eq_name, work_center: r.work_center,
      from: new Date(s).toISOString().slice(11, 16), to: new Date(e).toISOString().slice(11, 16),
      hours: h, qty, status: DT_LABEL[r.status] || r.status, type: TYPE_LABEL[r.type] || r.type
    });
  });

  // 受影响订单（停机单里登记的）
  const orderIds = new Set();
  rows.forEach((r) => {
    try { (JSON.parse(r.affected_orders || '[]') || []).forEach((x) => { if (x.order_id) orderIds.add(x.order_id); }); } catch (e) { /* ignore */ }
  });
  const riskOrders = orderIds.size ? db.prepare(
    `SELECT id, order_no, style_name, delivery_date, status FROM orders WHERE id IN (${[...orderIds].join(',')})`
  ).all() : [];

  return {
    date,
    work_center: workCenter || '全部',
    equipment_count: eqs.length,
    shift_hours: shiftHours,
    base_hours: baseHours,
    base_qty: baseQty,
    downtime_hours: round2(downtimeHours),
    available_hours: round2(Math.max(0, baseHours - downtimeHours)),
    available_qty: round2(Math.max(0, baseQty - lossQty)),
    loss_qty: round2(lossQty),
    utilization: baseHours > 0 ? round2(((baseHours - downtimeHours) / baseHours) * 100) : null,
    detail,
    risk_orders: riskOrders,
    promise_note: downtimeHours > EPS
      ? '本工作中心当天有停机占用，按原型规则「维修占用不得继续承诺产能」，新单交期只能按可用台时排'
      : '当天无停机占用，可按基准台时承诺产能'
  };
}

// ---------------- 台账 ----------------
router.get('/board', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { work_center = '', q = '' } = req.query;
  const w = ['active = 1'];
  const p = [];
  if (work_center) { w.push('work_center = ?'); p.push(work_center); }
  if (q) { w.push('(name LIKE ? OR eq_no LIKE ? OR owner LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const eqs = db.prepare(`SELECT * FROM equipment WHERE ${w.join(' AND ')} ORDER BY work_center, eq_no`).all(...p)
    .map((e) => {
      const open = db.prepare(
        `SELECT * FROM equipment_downtimes WHERE equipment_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`
      ).get(e.id, ...OPEN_STATUSES);
      return {
        ...e,
        type_label: EQ_TYPE[e.type] || e.type,
        status_label: EQ_STATUS[e.status] || e.status,
        open_downtime: open ? dtView(open.id) : null
      };
    });

  const openRows = db.prepare(
    `SELECT * FROM equipment_downtimes WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')}) ORDER BY start_at`
  ).all(...OPEN_STATUSES).map((r) => dtView(r.id));

  const workCenters = [...new Set(db.prepare('SELECT work_center FROM equipment WHERE active = 1').all().map((x) => x.work_center))];

  const stat = {
    equipment: eqs.length,
    running: eqs.filter((e) => e.status === 'running').length,
    down: eqs.filter((e) => e.status !== 'running').length,
    open_downtimes: openRows.length,
    pending_safety: openRows.filter((r) => r.status === 'pending_safety').length,
    loss_open: round2(openRows.reduce((a, r) => a + r.capacity_loss, 0)),
    work_centers: workCenters.length
  };
  return ok(res, { equipment: eqs, open_downtimes: openRows, work_centers: workCenters, stat });
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const wc = String(b.work_center || '').trim();
  if (!name) return fail(res, 400, '请填设备名称');
  if (!wc) return fail(res, 400, '请填工作中心');
  const cap = round2(b.capacity_per_hour);
  if (!(cap > 0)) return fail(res, 400, '台时产能必须大于 0（件/小时），否则算不出停机损失');
  const t = now();
  const last = db.prepare("SELECT COUNT(*) c FROM equipment").get().c;
  const eqNo = 'EQ' + String(last + 1).padStart(3, '0');
  const info = db.prepare(
    `INSERT INTO equipment (eq_no, name, type, work_center, capacity_per_hour, status, owner, location, next_maintain_at, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?, 'running', ?,?,?,?,?,?,?)`
  ).run(eqNo, name, b.type || 'sewing', wc, cap, b.owner || null, b.location || null,
    b.next_maintain_at || null, b.remark || null, req.user.username, t, t);
  return ok(res, db.prepare('SELECT * FROM equipment WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const e = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!e) return fail(res, 404, '设备不存在');
  const b = req.body || {};
  db.prepare(
    `UPDATE equipment SET name=?, type=?, work_center=?, capacity_per_hour=?, owner=?, location=?, next_maintain_at=?, remark=?, status=?, updated_at=? WHERE id=?`
  ).run(
    b.name !== undefined ? b.name : e.name,
    b.type !== undefined ? b.type : e.type,
    b.work_center !== undefined ? b.work_center : e.work_center,
    b.capacity_per_hour !== undefined ? round2(b.capacity_per_hour) : e.capacity_per_hour,
    b.owner !== undefined ? b.owner : e.owner,
    b.location !== undefined ? b.location : e.location,
    b.next_maintain_at !== undefined ? b.next_maintain_at : e.next_maintain_at,
    b.remark !== undefined ? b.remark : e.remark,
    b.status !== undefined ? b.status : e.status,
    now(), e.id
  );
  return ok(res, db.prepare('SELECT * FROM equipment WHERE id = ?').get(e.id));
}));

// ---------------- 停机单 ----------------
router.get('/downtimes', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { status = '', work_center = '', q = '', equipment_id = '' } = req.query;
  const w = [];
  const p = [];
  if (status) { w.push('status = ?'); p.push(status); }
  if (work_center) { w.push('work_center = ?'); p.push(work_center); }
  if (equipment_id) { w.push('equipment_id = ?'); p.push(equipment_id); }
  if (q) { w.push('(dt_no LIKE ? OR eq_name LIKE ? OR reason LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    'SELECT * FROM equipment_downtimes ' + (w.length ? 'WHERE ' + w.join(' AND ') + ' ' : '') + 'ORDER BY id DESC LIMIT 200'
  ).all(...p).map((r) => dtView(r.id));

  const stat = {
    total: rows.length,
    pending_repair: rows.filter((r) => r.status === 'pending_repair').length,
    repairing: rows.filter((r) => r.status === 'repairing').length,
    pending_safety: rows.filter((r) => r.status === 'pending_safety').length,
    recovered: rows.filter((r) => r.status === 'recovered').length,
    hours: round2(rows.reduce((a, r) => a + r.occupied_hours, 0)),
    loss: round2(rows.reduce((a, r) => a + r.capacity_loss, 0))
  };
  return ok(res, { rows, stat });
}));

router.post('/downtimes', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(Number(b.equipment_id));
  if (!eq) return fail(res, 404, '设备不存在');
  const startAt = normTime(b.start_at) || normTime(now());
  const reason = String(b.reason || '').trim();
  if (!reason) return fail(res, 400, '请写明停机原因（主轴异响 / 断针频繁 / 计划保养 …）');
  const type = ['breakdown', 'maintenance', 'changeover', 'power'].includes(b.type) ? b.type : 'breakdown';

  // 同一设备不能有两条未结停机单
  const open = db.prepare(
    `SELECT dt_no, status FROM equipment_downtimes WHERE equipment_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) LIMIT 1`
  ).get(eq.id, ...OPEN_STATUSES);
  if (open) {
    return fail(res, 400, `这台设备已有未结停机单 ${open.dt_no}（${DT_LABEL[open.status]}）。同一时间只能有一条，先把那条恢复到「已恢复」再登记新的`);
  }

  // 受影响订单校验
  let affected = [];
  if (Array.isArray(b.affected_orders)) {
    affected = b.affected_orders.filter((x) => x && x.order_id).map((x) => {
      const o = db.prepare('SELECT id, order_no, delivery_date FROM orders WHERE id = ?').get(Number(x.order_id));
      return o ? { order_id: o.id, order_no: o.order_no, note: x.note || null } : null;
    }).filter(Boolean);
  }

  const status = type === 'maintenance' && parseTime(startAt) > Date.now() ? 'planned' : 'pending_repair';
  const dtNo = nextNo('DT', 'equipment_downtimes', 'dt_no');
  const t = now();
  const info = db.prepare(
    `INSERT INTO equipment_downtimes (dt_no, equipment_id, eq_no, eq_name, work_center, type, start_at, reason, repair_task,
      status, capacity_per_hour, affected_orders, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(dtNo, eq.id, eq.eq_no, eq.name, eq.work_center, type, startAt, reason, b.repair_task || null,
    status, Number(eq.capacity_per_hour) || 0, affected.length ? JSON.stringify(affected) : null,
    req.user.username, t, t);

  // 停机占住设备：维修占用期间不承诺产能
  // 计划保养（未来开始）不改设备当前状态，等真正开始维修时再置 maintenance
  if (status !== 'planned') {
    db.prepare('UPDATE equipment SET status = ?, updated_at = ? WHERE id = ?')
      .run(type === 'maintenance' ? 'maintenance' : 'stopped', t, eq.id);
  }

  return ok(res, dtView(Number(info.lastInsertRowid)));
}));

router.post('/downtimes/:id/start-repair', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM equipment_downtimes WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '停机单不存在');
  if (!['planned', 'pending_repair'].includes(r.status)) return fail(res, 400, '只有待维修或计划保养的能开始维修');
  const t = now();
  db.prepare("UPDATE equipment_downtimes SET status='repairing', updated_at=? WHERE id=?").run(t, r.id);
  db.prepare("UPDATE equipment SET status='maintenance', updated_at=? WHERE id=?").run(t, r.equipment_id);
  return ok(res, dtView(r.id));
}));

router.post('/downtimes/:id/finish-repair', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM equipment_downtimes WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '停机单不存在');
  if (r.status !== 'repairing') return fail(res, 400, '只有维修中的单能结束维修');
  const b = req.body || {};
  const note = String(b.repair_note || '').trim();
  if (!note) return fail(res, 400, '请写维修内容（换了什么、怎么修的），安全复核要看这个');
  const t = now();
  db.prepare("UPDATE equipment_downtimes SET status='pending_safety', repair_by=?, repair_at=?, repair_note=?, updated_at=? WHERE id=?")
    .run(b.repair_by || req.user.username, t, note, t, r.id);
  return ok(res, { ...dtView(r.id), notice: '维修已完成，等安全责任人复核放行后才能恢复产能' });
}));

/** 安全复核放行：人工确认，不自动 */
router.post('/downtimes/:id/safety', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM equipment_downtimes WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '停机单不存在');
  if (r.status !== 'pending_safety') {
    return fail(res, 400, `当前是「${DT_LABEL[r.status]}」，只有「待安全复核」能放行。不能跳过维修直接恢复产能`);
  }
  const b = req.body || {};
  const safetyBy = String(b.safety_by || '').trim();
  const note = String(b.safety_note || '').trim();
  if (!safetyBy) return fail(res, 400, '请填安全放行责任人（谁确认设备可以安全开工）');
  if (!note) return fail(res, 400, '请写安全复核依据（试机正常 / 防护罩复位 / 专人试缝 3 件合格）');
  if (safetyBy === r.created_by && req.user.role !== 'admin') {
    return fail(res, 400, '登记人不能自己放行安全复核（admin 除外）——换设备责任人或生产主管确认');
  }

  const endAt = normTime(b.end_at) || normTime(now());
  if (parseTime(endAt) < parseTime(r.start_at)) {
    return fail(res, 400, '恢复时间不能早于停机开始时间');
  }
  const hours = hoursBetween(r.start_at, endAt);
  const loss = round2(hours * (Number(r.capacity_per_hour) || 0));
  const t = now();

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE equipment_downtimes SET status='recovered', end_at=?, occupied_hours=?, capacity_loss=?,
        safety_by=?, safety_at=?, safety_note=?, updated_at=? WHERE id=?`
    ).run(endAt, hours, loss, safetyBy, t, note, t, r.id);
    db.prepare("UPDATE equipment SET status='running', last_maintain_at=?, updated_at=? WHERE id=?")
      .run(endAt.slice(0, 10), t, r.equipment_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, {
    ...dtView(r.id),
    notice: `已安全放行恢复，停机 ${hours} 小时，产能损失约 ${loss} 件`
  });
}));

router.post('/downtimes/:id/cancel', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM equipment_downtimes WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '停机单不存在');
  if (r.status === 'recovered') return fail(res, 400, '已恢复的停机单不能作废（它是产能损失的历史依据）');
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return fail(res, 400, '请写作废原因（误报 / 重复登记）');
  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE equipment_downtimes SET status='cancelled', end_at=?, occupied_hours=0, capacity_loss=0, repair_note=?, updated_at=? WHERE id=?")
      .run(normTime(now()), `作废：${reason}`, t, r.id);
    // 还有别的未结单就不改设备状态
    const still = db.prepare(
      `SELECT COUNT(*) c FROM equipment_downtimes WHERE equipment_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`
    ).get(r.equipment_id, ...OPEN_STATUSES).c;
    if (!still) db.prepare("UPDATE equipment SET status='running', updated_at=? WHERE id=?").run(t, r.equipment_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, dtView(r.id));
}));

// ---------------- 产能 ----------------
router.get('/capacity', authRequired, requireRole(READ), wrap(async (req, res) => {
  const date = String(req.query.date || now().slice(0, 10)).slice(0, 10);
  const wc = String(req.query.work_center || '').trim();
  return ok(res, dayCapacity(wc, date));
}));

/** 多工作中心当天汇总（看板用） */
router.get('/capacity-board', authRequired, requireRole(READ), wrap(async (req, res) => {
  const date = String(req.query.date || now().slice(0, 10)).slice(0, 10);
  const wcs = [...new Set(db.prepare('SELECT work_center FROM equipment WHERE active = 1').all().map((x) => x.work_center))];
  const rows = wcs.map((w) => dayCapacity(w, date));
  return ok(res, {
    date,
    rows,
    total: {
      base_hours: round2(rows.reduce((a, r) => a + r.base_hours, 0)),
      downtime_hours: round2(rows.reduce((a, r) => a + r.downtime_hours, 0)),
      available_hours: round2(rows.reduce((a, r) => a + r.available_hours, 0)),
      loss_qty: round2(rows.reduce((a, r) => a + r.loss_qty, 0))
    }
  });
}));

module.exports = router;
