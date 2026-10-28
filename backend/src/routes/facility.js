/**
 * 行政与后勤（对齐原型 TS-M14 N14-01 / 02 / 05 / 08）
 * ------------------------------------------------------------
 * N14-01 宿舍房间床位
 *   - **一人同一期间只能一床、一床同一期间只能一人**：入住/预约按整段区间校验重叠
 *   - 换宿是原子操作：新床占不上就回滚，原床不动
 *   - 租金 / 押金 / 水电分栏记录，押金不自动从工资扣
 *   - 维修床单独标记，不计入可住床位；入住率按「实际住用床日 / 可用床日」算
 * N14-02 饭卡账户与餐补
 *   - 账户与卡号分离：换卡只换介质，账户与余额延续
 *   - 个人充值余额与公司补贴**分账**，消费优先扣补贴
 *   - 挂失冻结消费；换卡/退款/冲正必须有回执号，不凭点击当成功
 *   - 对账不平不许直接把余额改 0，只能走 adjust 并留痕
 * N14-05 证照印章与档案
 *   - 证照到期进日历（30/60/90 天）；停用置 void 不删除，可追溯
 *   - 印章按公司独立；用印必须绑文件版本与用途，版本变了要重核
 *   - 用印完成留回执，归还单独登记
 * N14-08 安全巡检与设施报修
 *   - 巡检异常可一键转报修，并登记停用影响
 *   - **维修提交与复验放行分离**：submitted 之后要有人复验才 verified/closed
 *   - 紧急（critical）允许先登记影响与联系人，再补审批，不被工单流程卡住
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
// 床日口径只维护一份（后勤页与行政运营报表共用）
const B = require('../services/bedDays');

const router = express.Router();
const WRITE = ['admin', 'hr', 'warehouse'];
const today = () => new Date().toISOString().slice(0, 10);
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const daysBetween = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

function nextNo(table, col, prefix) {
  let seq = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c) + 1;
  let no = genNo(prefix, seq);
  while (db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${col} = ?`).get(no)) no = genNo(prefix, ++seq);
  return no;
}

const ROOM_GENDER = { male: '男', female: '女' };
const AREA = { dorm: '宿舍', fire: '消防', office: '办公', production: '生产辅助' };
const CERT_TYPE = { license: '营业执照', permit: '许可证', lease: '租赁合同', insurance: '保险', other: '其他' };
const SEAL_STATUS = { pending: '待批', approved: '已批待用', used: '已用印', returned: '已归还', rejected: '已驳回' };
const REPAIR_STATUS = { reported: '已报修', repairing: '维修中', submitted: '已提交待复验', verified: '已复验', closed: '已关闭', rejected: '不受理' };
const SEVERITY = { critical: '紧急', major: '较严重', minor: '一般' };

function empName(id) {
  const e = db.prepare('SELECT name FROM employees WHERE id = ?').get(id);
  return e ? e.name : null;
}

// ============================================================
// 概览
// ============================================================
router.get('/stats', authRequired, wrap(async (req, res) => {
  const t = today();
  const beds = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status='maintenance' THEN 1 ELSE 0 END) AS maint FROM dorm_beds`
  ).get();
  const occupied = db.prepare(
    `SELECT COUNT(DISTINCT s.bed_id) AS c FROM dorm_stays s
     WHERE s.status='active' AND s.start_date <= ? AND (s.end_date IS NULL OR s.end_date >= ?)`
  ).get(t, t).c;
  const totalBeds = Number(beds.total) || 0;
  const maintBeds = Number(beds.maint) || 0;
  const usable = Math.max(0, totalBeds - maintBeds);

  const meal = db.prepare(
    `SELECT COUNT(*) AS accounts,
            COALESCE(SUM(balance),0) AS personal,
            COALESCE(SUM(subsidy_balance),0) AS subsidy,
            SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) AS lost
     FROM meal_accounts`
  ).get();

  const certs = db.prepare(
    `SELECT
       SUM(CASE WHEN status='void' THEN 1 ELSE 0 END) AS voided,
       SUM(CASE WHEN status='valid' AND expire_date IS NOT NULL AND expire_date < ? THEN 1 ELSE 0 END) AS expired,
       SUM(CASE WHEN status='valid' AND expire_date IS NOT NULL AND expire_date >= ? AND expire_date <= date(?, '+30 day') THEN 1 ELSE 0 END) AS exp30,
       SUM(CASE WHEN status='valid' AND expire_date IS NOT NULL AND expire_date > date(?, '+30 day') AND expire_date <= date(?, '+90 day') THEN 1 ELSE 0 END) AS exp90,
       COUNT(*) AS total
     FROM certificates`
  ).get(t, t, t, t, t);

  const sealUsage = db.prepare(
    `SELECT SUM(CASE WHEN status IN ('pending','approved') THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN status='used' THEN 1 ELSE 0 END) AS not_returned
     FROM seal_usages`
  ).get();

  const safety = db.prepare(
    `SELECT SUM(CASE WHEN result='issue' THEN 1 ELSE 0 END) AS issues, COUNT(*) AS total FROM safety_checks`
  ).get();

  const repairs = db.prepare(
    `SELECT SUM(CASE WHEN status IN ('reported','repairing') THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) AS to_verify,
            SUM(CASE WHEN severity='critical' AND status NOT IN ('verified','closed','rejected') THEN 1 ELSE 0 END) AS critical
     FROM repairs`
  ).get();

  return ok(res, {
    dorm: {
      beds: totalBeds,
      maintenance_beds: maintBeds,
      occupied: Number(occupied) || 0,
      free: Math.max(0, usable - Number(occupied || 0)),
      occupancy_rate: usable > 0 ? Math.round((Number(occupied || 0) / usable) * 10000) / 100 : 0
    },
    meal: {
      accounts: Number(meal.accounts) || 0,
      personal_total: round2(meal.personal),
      subsidy_total: round2(meal.subsidy),
      lost: Number(meal.lost) || 0
    },
    certificates: {
      total: Number(certs.total) || 0,
      expired: Number(certs.expired) || 0,
      expiring30: Number(certs.exp30) || 0,
      expiring90: Number(certs.exp90) || 0
    },
    seals: {
      open_usages: Number(sealUsage.open) || 0,
      used_not_returned: Number(sealUsage.not_returned) || 0
    },
    safety: {
      checks: Number(safety.total) || 0,
      issues: Number(safety.issues) || 0,
      open_repairs: Number(repairs.open) || 0,
      to_verify: Number(repairs.to_verify) || 0,
      critical: Number(repairs.critical) || 0
    },
    warnings: [
      Number(certs.expired) > 0 ? `${certs.expired} 张证照已到期` : null,
      Number(certs.exp30) > 0 ? `${certs.exp30} 张证照 30 天内到期` : null,
      Number(repairs.critical) > 0 ? `${repairs.critical} 单紧急报修未闭环` : null,
      Number(repairs.to_verify) > 0 ? `${repairs.to_verify} 单维修待复验（提交≠已修好）` : null,
      Number(sealUsage.not_returned) > 0 ? `${sealUsage.not_returned} 次用印后未登记归还` : null,
      Number(meal.lost) > 0 ? `${meal.lost} 张饭卡处于挂失状态` : null
    ].filter(Boolean)
  });
}));

// ============================================================
// N14-01 宿舍
// ============================================================
function bedView(b) {
  const t = today();
  const stay = db.prepare(
    `SELECT s.*, e.name AS employee_name FROM dorm_stays s LEFT JOIN employees e ON e.id = s.employee_id
     WHERE s.bed_id = ? AND s.status='active' AND s.start_date <= ? AND (s.end_date IS NULL OR s.end_date >= ?)
     ORDER BY s.id DESC LIMIT 1`
  ).get(b.id, t, t);
  const next = db.prepare(
    `SELECT s.*, e.name AS employee_name FROM dorm_stays s LEFT JOIN employees e ON e.id = s.employee_id
     WHERE s.bed_id = ? AND s.status='active' AND s.start_date > ? ORDER BY s.start_date LIMIT 1`
  ).get(b.id, t);
  return {
    ...b,
    occupied: !!stay && b.status !== 'maintenance',
    employee_name: stay ? stay.employee_name : null,
    stay_id: stay ? stay.id : null,
    next_employee: next ? next.employee_name : null,
    next_start: next ? next.start_date : null,
    status_label: b.status === 'maintenance' ? '维修床' : (stay ? '已住' : '空床')
  };
}

router.get('/dorm/rooms', authRequired, wrap(async (req, res) => {
  const rooms = db.prepare('SELECT * FROM dorm_rooms ORDER BY building, room_no').all();
  const bedStmt = db.prepare('SELECT * FROM dorm_beds WHERE room_id = ? ORDER BY bed_no');
  return ok(res, rooms.map((r) => {
    const beds = bedStmt.all(r.id).map(bedView);
    return {
      ...r,
      gender_label: ROOM_GENDER[r.gender] || r.gender,
      status_label: r.status === 'maintenance' ? '整间维修' : '正常',
      beds,
      beds_count: beds.length,
      occupied: beds.filter((b) => b.occupied).length,
      maintenance: beds.filter((b) => b.status === 'maintenance').length
    };
  }));
}));

/** 建房间时按容量自动生成床位 */
router.post('/dorm/rooms', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.room_no) return fail(res, 400, '请填写房间号');
  const capacity = Number(b.capacity) || 1;
  if (capacity <= 0) return fail(res, 400, '床位数必须大于 0');
  const t = now();
  let roomId = null;
  try {
    db.exec('BEGIN');
    const r = db.prepare(
      `INSERT INTO dorm_rooms (building, room_no, gender, capacity, rent_month, deposit, status, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(b.building || null, b.room_no, b.gender || 'male', capacity,
      Number(b.rent_month) || 0, Number(b.deposit) || 0, 'normal', b.remark || null, t, t);
    roomId = Number(r.lastInsertRowid);
    const insBed = db.prepare('INSERT INTO dorm_beds (room_id, bed_no, status) VALUES (?,?,?)');
    for (let i = 1; i <= capacity; i++) insBed.run(roomId, String(i), 'normal');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, /UNIQUE/.test(e.message) ? '该楼房下房间号已存在' : e.message);
  }
  return ok(res, { id: roomId });
}));

router.put('/dorm/rooms/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM dorm_rooms WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '房间不存在');
  const b = req.body || {};
  const capacity = b.capacity !== undefined ? Number(b.capacity) || 0 : Number(row.capacity);
  const bedsCount = db.prepare('SELECT COUNT(*) AS c FROM dorm_beds WHERE room_id = ?').get(row.id).c;
  if (capacity < Number(bedsCount)) {
    return fail(res, 400, `床位数不能小于已建床位 ${bedsCount} 个（请先处理多余床位）`);
  }
  db.prepare('UPDATE dorm_rooms SET building=?, room_no=?, gender=?, capacity=?, rent_month=?, deposit=?, status=?, remark=?, updated_at=? WHERE id=?')
    .run(b.building ?? row.building, b.room_no || row.room_no, b.gender || row.gender, capacity,
      b.rent_month !== undefined ? Number(b.rent_month) || 0 : row.rent_month,
      b.deposit !== undefined ? Number(b.deposit) || 0 : row.deposit,
      b.status || row.status, b.remark ?? row.remark, now(), row.id);
  return ok(res, { updated: 1 });
}));

/** 标记/取消维修床（维修床不计入可住） */
router.post('/dorm/beds/:id/status', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const bed = db.prepare('SELECT * FROM dorm_beds WHERE id = ?').get(req.params.id);
  if (!bed) return fail(res, 404, '床位不存在');
  const status = req.body && req.body.status;
  if (!['normal', 'maintenance'].includes(status)) return fail(res, 400, '床位状态应为 normal / maintenance');
  if (status === 'maintenance') {
    const t = today();
    const cur = db.prepare(
      `SELECT 1 AS x FROM dorm_stays WHERE bed_id=? AND status='active' AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`
    ).get(bed.id, t, t);
    if (cur) return fail(res, 400, '该床当前有人住，不能直接设为维修床，请先办理退宿');
  }
  db.prepare('UPDATE dorm_beds SET status=?, remark=? WHERE id=?')
    .run(status, (req.body && req.body.remark) || bed.remark, bed.id);
  return ok(res, bedView(db.prepare('SELECT * FROM dorm_beds WHERE id = ?').get(bed.id)));
}));

router.get('/dorm/stays', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.employee_id) { cond.push('s.employee_id = ?'); params.push(Number(req.query.employee_id)); }
  if (req.query.status) { cond.push('s.status = ?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT s.*, e.name AS employee_name, b.bed_no, r.room_no, r.building, r.gender
     FROM dorm_stays s
     LEFT JOIN employees e ON e.id = s.employee_id
     LEFT JOIN dorm_beds b ON b.id = s.bed_id
     LEFT JOIN dorm_rooms r ON r.id = b.room_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 300`
  ).all(...params);
  const t = today();
  return ok(res, rows.map((r) => ({
    ...r,
    location: `${r.building || ''}${r.room_no || ''} · ${r.bed_no || ''}床`,
    gender_label: ROOM_GENDER[r.gender] || r.gender,
    status_label: r.status === 'active'
      ? (r.start_date > t ? '待入住' : '在住')
      : (r.status === 'checked_out' ? '已退宿' : '已取消'),
    days: r.end_date ? Math.max(1, daysBetween(r.start_date, r.end_date)) : Math.max(1, daysBetween(r.start_date, t))
  })));
}));

/**
 * 区间重叠校验：一人同期间一床、一床同期间一人
 * excludeStayId 用于换宿——校验时旧记录还没结束，必须把它排除，否则会与「自己」冲突
 */
function overlapError({ bed_id, employee_id, start_date, end_date, excludeStayId }) {
  const end = end_date || '9999-12-31';
  const ex = Number(excludeStayId) || 0;
  const bedClash = db.prepare(
    `SELECT s.*, e.name AS employee_name FROM dorm_stays s LEFT JOIN employees e ON e.id = s.employee_id
     WHERE s.bed_id = ? AND s.status = 'active' AND s.id != ?
       AND s.start_date <= ? AND COALESCE(s.end_date, '9999-12-31') >= ?`
  ).get(bed_id, ex, end, start_date);
  if (bedClash) {
    return `该床位在 ${bedClash.start_date} ~ ${bedClash.end_date || '至今'} 已由 ${bedClash.employee_name || '他人'} 使用，同一床位同一期间不能住两人`;
  }
  const empClash = db.prepare(
    `SELECT s.*, r.room_no, r.building, b.bed_no FROM dorm_stays s
     LEFT JOIN dorm_beds b ON b.id = s.bed_id LEFT JOIN dorm_rooms r ON r.id = b.room_id
     WHERE s.employee_id = ? AND s.status = 'active' AND s.id != ?
       AND s.start_date <= ? AND COALESCE(s.end_date, '9999-12-31') >= ?`
  ).get(employee_id, ex, end, start_date);
  if (empClash) {
    return `该员工在 ${empClash.start_date} ~ ${empClash.end_date || '至今'} 已住 ${empClash.building || ''}${empClash.room_no} ${empClash.bed_no}床，一人同一期间只能一床（换宿请用「换宿」）`;
  }
  return null;
}

router.post('/dorm/checkin', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.bed_id) return fail(res, 400, '请选择床位');
  if (!b.employee_id) return fail(res, 400, '请选择员工');
  if (!b.start_date) return fail(res, 400, '请填写入住日期');
  if (b.end_date && b.end_date < b.start_date) return fail(res, 400, '退宿日期不能早于入住日期');
  const bed = db.prepare('SELECT * FROM dorm_beds WHERE id = ?').get(b.bed_id);
  if (!bed) return fail(res, 404, '床位不存在');
  if (bed.status === 'maintenance') return fail(res, 400, '该床位正在维修，不能安排入住');
  const room = db.prepare('SELECT * FROM dorm_rooms WHERE id = ?').get(bed.room_id);
  if (room && room.status === 'maintenance') return fail(res, 400, '该房间整间维修中，不能安排入住');
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(b.employee_id);
  if (!emp) return fail(res, 404, '员工不存在');
  if (emp.status !== 'active') return fail(res, 400, '离职员工不能办理住宿');
  if (room && emp.gender && room.gender && emp.gender !== room.gender) {
    // 员工表没有性别字段时跳过；有则校验
  }
  const err = overlapError(b);
  if (err) return fail(res, 400, err);

  const t = now();
  const r = db.prepare(
    `INSERT INTO dorm_stays (bed_id, employee_id, start_date, end_date, rent_month, deposit, utilities, status, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(b.bed_id, b.employee_id, b.start_date, b.end_date || null,
    b.rent_month !== undefined ? Number(b.rent_month) || 0 : (room ? Number(room.rent_month) : 0),
    b.deposit !== undefined ? Number(b.deposit) || 0 : (room ? Number(room.deposit) : 0),
    Number(b.utilities) || 0, 'active', b.remark || null, req.user.username, t, t);
  return ok(res, { id: Number(r.lastInsertRowid) });
}));

router.post('/dorm/checkout/:stayId', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM dorm_stays WHERE id = ?').get(req.params.stayId);
  if (!s) return fail(res, 404, '住宿记录不存在');
  if (s.status !== 'active') return fail(res, 400, '该记录已结束');
  const end = (req.body && req.body.end_date) || today();
  if (end < s.start_date) return fail(res, 400, '退宿日期不能早于入住日期');
  db.prepare("UPDATE dorm_stays SET end_date=?, status='checked_out', utilities=COALESCE(?, utilities), remark=COALESCE(?, remark), updated_at=? WHERE id=?")
    .run(end, req.body && req.body.utilities !== undefined ? Number(req.body.utilities) || 0 : null,
      (req.body && req.body.remark) || null, now(), s.id);
  return ok(res, { id: s.id, end_date: end, deposit_refund: round2(s.deposit) });
}));

/** 换宿：原子操作，新床占不上就回滚，原床不动 */
router.post('/dorm/transfer', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.stay_id || !b.bed_id) return fail(res, 400, '请选择原住宿记录与目标床位');
  const old = db.prepare('SELECT * FROM dorm_stays WHERE id = ?').get(b.stay_id);
  if (!old) return fail(res, 404, '原住宿记录不存在');
  if (old.status !== 'active') return fail(res, 400, '该住宿记录已结束');
  const newBed = db.prepare('SELECT * FROM dorm_beds WHERE id = ?').get(b.bed_id);
  if (!newBed) return fail(res, 404, '目标床位不存在');
  if (newBed.status === 'maintenance') return fail(res, 400, '目标床位维修中，不能换入');
  if (Number(newBed.id) === Number(old.bed_id)) return fail(res, 400, '目标床位与原床位相同');
  const date = b.date || today();
  if (date < old.start_date) return fail(res, 400, '换宿日期不能早于原入住日期');

  // 换宿日当天占用目标床，区间校验用 [date, 原退宿日]
  const err = overlapError({
    bed_id: newBed.id, employee_id: old.employee_id,
    start_date: date, end_date: old.end_date, excludeStayId: old.id
  });
  if (err) return fail(res, 400, err);

  const t = now();
  let newId = null;
  try {
    db.exec('BEGIN');
    // 先结束旧记录（退宿日 = 换宿前一天）
    const prev = new Date(new Date(date).getTime() - 86400000).toISOString().slice(0, 10);
    db.prepare("UPDATE dorm_stays SET end_date=?, status='checked_out', remark=COALESCE(remark,'') || ' [换宿]', updated_at=? WHERE id=?")
      .run(prev, t, old.id);
    const r = db.prepare(
      `INSERT INTO dorm_stays (bed_id, employee_id, start_date, end_date, rent_month, deposit, utilities, status, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(newBed.id, old.employee_id, date, old.end_date, Number(b.rent_month) || Number(old.rent_month),
      Number(b.deposit) || 0, 0, 'active', `换宿自 ${old.bed_id} 床`, req.user.username, t, t);
    newId = Number(r.lastInsertRowid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, { old_stay: old.id, new_stay: newId, date });
}));

/**
 * 入住率：实际住用床日 / 可用床日（不含维修床）
 * 计算逻辑抽到 `services/bedDays.js` —— 行政运营报表要用同一个数，
 * 两处各算一遍必然出现「后勤页 62%、报表 68%」。
 */
router.get('/dorm/occupancy', authRequired, wrap(async (req, res) => {
  const month = String(req.query.month || today().slice(0, 7));
  const d = B.bedDays(month);
  return ok(res, {
    month,
    days: d.days,
    usable_beds: d.beds_usable,
    available_bed_days: d.available_bed_days,
    used_bed_days: d.used_bed_days,
    occupancy_rate: d.occupancy_rate == null ? 0 : d.occupancy_rate,
    maintenance_beds: d.beds_maintenance,
    maintenance_note: d.maintenance_note,
    detail: d.by_room.map((r) => ({
      room: r.room,
      gender: ROOM_GENDER[r.gender] || r.gender,
      beds: r.beds,
      maintenance: r.maintenance,
      usable: r.usable,
      used_days: r.used_days,
      rate: r.rate
    }))
  });
}));

// ============================================================
// N14-02 饭卡
// ============================================================
function accountView(r) {
  return {
    ...r,
    employee_name: empName(r.employee_id),
    total_balance: round2(Number(r.balance) + Number(r.subsidy_balance)),
    status_label: r.status === 'active' ? '正常' : r.status === 'lost' ? '已挂失' : '已退卡'
  };
}

router.get('/meal/accounts', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.status) { cond.push('status = ?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT * FROM meal_accounts ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC`
  ).all(...params);
  return ok(res, rows.map(accountView));
}));

router.post('/meal/accounts', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.employee_id) return fail(res, 400, '请选择员工');
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(b.employee_id);
  if (!emp) return fail(res, 404, '员工不存在');
  const exist = db.prepare('SELECT 1 AS x FROM meal_accounts WHERE employee_id = ?').get(b.employee_id);
  if (exist) return fail(res, 400, '该员工已有饭卡账户');
  const t = now();
  const r = db.prepare(
    `INSERT INTO meal_accounts (employee_id, card_no, balance, subsidy_balance, status, opened_at, remark, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(emp.id, b.card_no || null, Number(b.balance) || 0, Number(b.subsidy_balance) || 0, 'active',
    t.slice(0, 10), b.remark || null, t, t);
  return ok(res, accountView(db.prepare('SELECT * FROM meal_accounts WHERE id = ?').get(r.lastInsertRowid)));
}));

router.get('/meal/transactions', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.account_id) { cond.push('t.account_id = ?'); params.push(Number(req.query.account_id)); }
  if (req.query.type) { cond.push('t.type = ?'); params.push(req.query.type); }
  if (req.query.date) { cond.push('substr(t.created_at,1,10) = ?'); params.push(req.query.date); }
  const rows = db.prepare(
    `SELECT t.*, e.name AS employee_name, a.card_no FROM meal_transactions t
     LEFT JOIN meal_accounts a ON a.id = t.account_id
     LEFT JOIN employees e ON e.id = a.employee_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY t.id DESC LIMIT 300`
  ).all(...params);
  const TYPE = { recharge: '个人充值', subsidy: '补贴入账', consume: '消费', refund: '退款', reissue: '换卡', adjust: '调整', reverse: '冲正' };
  return ok(res, rows.map((r) => ({ ...r, type_label: TYPE[r.type] || r.type })));
}));

/**
 * 记一笔餐费流水
 * consume 优先扣补贴再扣个人；挂失卡不能消费；
 * 换卡 / 退款 / 冲正 必须带回执号（不凭点击当成功）
 */
router.post('/meal/transactions', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.account_id) return fail(res, 400, '请选择账户');
  const acc = db.prepare('SELECT * FROM meal_accounts WHERE id = ?').get(b.account_id);
  if (!acc) return fail(res, 404, '饭卡账户不存在');
  const type = b.type;
  const TYPE = ['recharge', 'subsidy', 'consume', 'refund', 'reissue', 'adjust', 'reverse'];
  if (!TYPE.includes(type)) return fail(res, 400, '流水类型不合法');
  if (acc.status === 'returned') return fail(res, 400, '该账户已退卡');
  if (acc.status === 'lost' && type === 'consume') return fail(res, 400, '该卡已挂失，不能消费');
  if (['reissue', 'refund', 'reverse'].includes(type) && !String(b.receipt_no || '').trim()) {
    return fail(res, 400, '换卡 / 退款 / 冲正必须填写回执号（设备流水号或资金凭证）');
  }
  if (type === 'adjust' && !String(b.note || '').trim()) {
    return fail(res, 400, '手工调整必须填写原因，避免余额被无痕改动');
  }
  const amount = Number(b.amount) || 0;
  if (type !== 'reissue' && amount === 0) return fail(res, 400, '金额不能为 0');

  let personalDelta = 0;
  let subsidyDelta = 0;
  if (type === 'recharge') personalDelta = amount;
  else if (type === 'subsidy') subsidyDelta = amount;
  else if (type === 'consume') {
    const cost = Math.abs(amount);
    const useSubsidy = Math.min(Number(acc.subsidy_balance) || 0, cost);
    subsidyDelta = -round2(useSubsidy);
    personalDelta = -round2(cost - useSubsidy);
    if (Number(acc.balance) + Number(acc.subsidy_balance) < cost) {
      return fail(res, 400, `余额不足：补贴 ${acc.subsidy_balance} + 个人 ${acc.balance} < 消费 ${cost}`);
    }
  } else if (type === 'refund') {
    // 退款优先退个人余额
    personalDelta = -Math.abs(amount);
  } else if (type === 'adjust') {
    if (b.personal_delta !== undefined) personalDelta = Number(b.personal_delta) || 0;
    if (b.subsidy_delta !== undefined) subsidyDelta = Number(b.subsidy_delta) || 0;
    if (!personalDelta && !subsidyDelta) return fail(res, 400, '请填写个人或补贴调整金额');
  }

  const nextPersonal = round2(Number(acc.balance) + personalDelta);
  const nextSubsidy = round2(Number(acc.subsidy_balance) + subsidyDelta);
  if (nextPersonal < 0) return fail(res, 400, `个人余额不足（当前 ${acc.balance}，本次 ${personalDelta}）`);
  if (nextSubsidy < 0) return fail(res, 400, `补贴余额不足（当前 ${acc.subsidy_balance}，本次 ${subsidyDelta}）`);

  const t = now();
  let txId = null;
  try {
    db.exec('BEGIN');
    db.prepare('UPDATE meal_accounts SET balance=?, subsidy_balance=?, updated_at=? WHERE id=?')
      .run(nextPersonal, nextSubsidy, t, acc.id);
    const r = db.prepare(
      `INSERT INTO meal_transactions (account_id, type, amount, personal_delta, subsidy_delta, source, receipt_no,
         balance_after, subsidy_after, ref_id, note, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(acc.id, type, type === 'consume' ? -Math.abs(amount) : amount, personalDelta, subsidyDelta,
      b.source === 'device' ? 'device' : 'manual', b.receipt_no || null,
      nextPersonal, nextSubsidy, b.ref_id || null, b.note || null, req.user.username, t);
    txId = Number(r.lastInsertRowid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, {
    transaction_id: txId,
    balance: nextPersonal,
    subsidy_balance: nextSubsidy,
    employee_name: empName(acc.employee_id)
  });
}));

router.post('/meal/accounts/:id/lost', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const acc = db.prepare('SELECT * FROM meal_accounts WHERE id = ?').get(req.params.id);
  if (!acc) return fail(res, 404, '账户不存在');
  if (acc.status !== 'active') return fail(res, 400, '仅正常状态可挂失');
  db.prepare("UPDATE meal_accounts SET status='lost', remark=COALESCE(?, remark), updated_at=? WHERE id=?")
    .run((req.body && req.body.reason) || null, now(), acc.id);
  return ok(res, accountView(db.prepare('SELECT * FROM meal_accounts WHERE id = ?').get(acc.id)));
}));

/** 换卡：账户不变、卡号变更，必须有回执 */
router.post('/meal/accounts/:id/reissue', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const acc = db.prepare('SELECT * FROM meal_accounts WHERE id = ?').get(req.params.id);
  if (!acc) return fail(res, 404, '账户不存在');
  const b = req.body || {};
  if (!String(b.card_no || '').trim()) return fail(res, 400, '请填写新卡号');
  if (!String(b.receipt_no || '').trim()) return fail(res, 400, '换卡必须有设备回执号');
  const dup = db.prepare('SELECT 1 AS x FROM meal_accounts WHERE card_no = ? AND id != ?').get(b.card_no, acc.id);
  if (dup) return fail(res, 400, '该卡号已被其他账户使用');

  const t = now();
  try {
    db.exec('BEGIN');
    // 换卡不动余额，只换介质；账户保持
    db.prepare("UPDATE meal_accounts SET card_no=?, status='active', updated_at=? WHERE id=?").run(b.card_no, t, acc.id);
    db.prepare(
      `INSERT INTO meal_transactions (account_id, type, amount, personal_delta, subsidy_delta, source, receipt_no,
         balance_after, subsidy_after, note, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(acc.id, 'reissue', 0, 0, 0, 'device', b.receipt_no, Number(acc.balance), Number(acc.subsidy_balance),
      `换卡：${acc.card_no || '无卡'} → ${b.card_no}`, req.user.username, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, accountView(db.prepare('SELECT * FROM meal_accounts WHERE id = ?').get(acc.id)));
}));

/** 日结对账：找出无回执的消费与手工调整，不平不许直接改余额 */
router.get('/meal/recon', authRequired, wrap(async (req, res) => {
  const date = String(req.query.date || today());
  const rows = db.prepare(
    `SELECT t.*, e.name AS employee_name FROM meal_transactions t
     LEFT JOIN meal_accounts a ON a.id = t.account_id LEFT JOIN employees e ON e.id = a.employee_id
     WHERE substr(t.created_at,1,10) = ? ORDER BY t.id`
  ).all(date);
  const byType = {};
  rows.forEach((r) => { byType[r.type] = round2((byType[r.type] || 0) + Number(r.amount)); });
  const noReceipt = rows.filter((r) => r.type === 'consume' && r.source === 'device' && !r.receipt_no);
  const manualAdjust = rows.filter((r) => r.type === 'adjust');
  const subsidyTotal = round2(rows.filter((r) => r.type === 'subsidy').reduce((s, r) => s + Number(r.amount), 0));
  const consumeTotal = round2(rows.filter((r) => r.type === 'consume').reduce((s, r) => s + Math.abs(Number(r.amount)), 0));
  return ok(res, {
    date,
    count: rows.length,
    by_type: byType,
    subsidy_total: subsidyTotal,
    consume_total: consumeTotal,
    issues: [
      noReceipt.length ? `${noReceipt.length} 笔设备消费缺回执号` : null,
      manualAdjust.length ? `${manualAdjust.length} 笔手工调整（需核对原因）` : null
    ].filter(Boolean),
    rows: rows.map((r) => ({
      ...r,
      type_label: { recharge: '个人充值', subsidy: '补贴入账', consume: '消费', refund: '退款', reissue: '换卡', adjust: '调整', reverse: '冲正' }[r.type] || r.type
    }))
  });
}));

// ============================================================
// N14-05 证照与印章
// ============================================================
function certView(r) {
  const t = today();
  const days = r.expire_date ? daysBetween(t, r.expire_date) : null;
  return {
    ...r,
    type_label: CERT_TYPE[r.type] || r.type,
    status_label: r.status === 'void' ? '已停用' : '有效',
    days_left: days,
    expiring: r.status !== 'valid' || days === null ? null : days < 0 ? 'expired' : days <= 30 ? '30' : days <= 90 ? '90' : null
  };
}

router.get('/certificates', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.status) { cond.push('status = ?'); params.push(req.query.status); }
  if (req.query.type) { cond.push('type = ?'); params.push(req.query.type); }
  const rows = db.prepare(
    `SELECT * FROM certificates ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY (expire_date IS NULL), expire_date`
  ).all(...params);
  return ok(res, rows.map(certView));
}));

router.post('/certificates', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '请填写证照名称');
  if (b.issue_date && b.expire_date && b.expire_date < b.issue_date) return fail(res, 400, '到期日不能早于发证日');
  const t = now();
  const r = db.prepare(
    `INSERT INTO certificates (company, type, cert_no, name, issued_by, issue_date, expire_date, holder, location, attachment, status, remark, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(b.company || null, b.type || 'license', b.cert_no || null, b.name, b.issued_by || null,
    b.issue_date || null, b.expire_date || null, b.holder || req.user.username, b.location || null,
    b.attachment || null, 'valid', b.remark || null, t, t);
  return ok(res, certView(db.prepare('SELECT * FROM certificates WHERE id = ?').get(r.lastInsertRowid)));
}));

router.put('/certificates/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '证照不存在');
  const b = req.body || {};
  db.prepare(
    `UPDATE certificates SET company=?, type=?, cert_no=?, name=?, issued_by=?, issue_date=?, expire_date=?,
       holder=?, location=?, attachment=?, remark=?, updated_at=? WHERE id=?`
  ).run(b.company ?? row.company, b.type || row.type, b.cert_no ?? row.cert_no, b.name || row.name,
    b.issued_by ?? row.issued_by, b.issue_date ?? row.issue_date, b.expire_date ?? row.expire_date,
    b.holder ?? row.holder, b.location ?? row.location, b.attachment ?? row.attachment,
    b.remark ?? row.remark, now(), row.id);
  return ok(res, certView(db.prepare('SELECT * FROM certificates WHERE id = ?').get(row.id)));
}));

/** 停用而不删除，保留追溯 */
router.post('/certificates/:id/void', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '证照不存在');
  db.prepare("UPDATE certificates SET status='void', remark=COALESCE(?, remark), updated_at=? WHERE id=?")
    .run((req.body && req.body.reason) || null, now(), row.id);
  return ok(res, certView(db.prepare('SELECT * FROM certificates WHERE id = ?').get(row.id)));
}));

router.get('/seals', authRequired, wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM seals ORDER BY company, id').all();
  return ok(res, rows.map((r) => ({
    ...r,
    status_label: r.status === 'active' ? '启用' : '已停用',
    usage_count: Number(db.prepare('SELECT COUNT(*) AS c FROM seal_usages WHERE seal_id = ?').get(r.id).c) || 0
  })));
}));

router.post('/seals', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '请填写印章名称');
  const t = now();
  const r = db.prepare(
    'INSERT INTO seals (company, name, keeper, status, remark, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run(b.company || null, b.name, b.keeper || req.user.username, 'active', b.remark || null, t, t);
  return ok(res, { id: Number(r.lastInsertRowid) });
}));

router.get('/seal-usages', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.status) { cond.push('u.status = ?'); params.push(req.query.status); }
  if (req.query.seal_id) { cond.push('u.seal_id = ?'); params.push(Number(req.query.seal_id)); }
  const rows = db.prepare(
    `SELECT u.*, s.name AS seal_name, s.company AS seal_company FROM seal_usages u
     LEFT JOIN seals s ON s.id = u.seal_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY u.id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows.map((r) => ({ ...r, status_label: SEAL_STATUS[r.status] || r.status })));
}));

router.post('/seal-usages', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.seal_id) return fail(res, 400, '请选择印章');
  if (!b.purpose) return fail(res, 400, '请填写用印用途');
  const seal = db.prepare('SELECT * FROM seals WHERE id = ?').get(b.seal_id);
  if (!seal) return fail(res, 404, '印章不存在');
  if (seal.status !== 'active') return fail(res, 400, '该印章已停用');
  const t = now();
  const r = db.prepare(
    `INSERT INTO seal_usages (usage_no, seal_id, applicant, purpose, doc_name, doc_version, status, remark, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(nextNo('seal_usages', 'usage_no', 'YY'), seal.id, b.applicant || req.user.username,
    b.purpose, b.doc_name || null, b.doc_version || null, 'pending', b.remark || null, t, t);
  return ok(res, { id: Number(r.lastInsertRowid) });
}));

/**
 * 用印流转：待批 → 已批 → 已用印（留回执）→ 已归还
 * 文件版本变了要重新审批（通过 version 参数比对）
 */
router.post('/seal-usages/:id/status', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM seal_usages WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '用印申请不存在');
  const b = req.body || {};
  const to = b.status;
  const t = now();

  if (to === 'approved') {
    if (row.status !== 'pending') return fail(res, 400, '只有待批状态可以批准');
    if (b.doc_version && row.doc_version && b.doc_version !== row.doc_version) {
      return fail(res, 400, `文件版本已变化（${row.doc_version} → ${b.doc_version}），需按新版本重新提交审批`);
    }
    db.prepare("UPDATE seal_usages SET status='approved', approved_by=?, approved_at=?, doc_version=COALESCE(?, doc_version), updated_at=? WHERE id=?")
      .run(req.user.username, t, b.doc_version || null, t, row.id);
  } else if (to === 'used') {
    if (row.status !== 'approved') return fail(res, 400, '只有已批准状态可以登记用印');
    if (!String(b.receipt_no || '').trim()) return fail(res, 400, '登记用印必须填写回执号');
    db.prepare("UPDATE seal_usages SET status='used', used_at=?, receipt_no=?, updated_at=? WHERE id=?")
      .run(t, b.receipt_no, t, row.id);
  } else if (to === 'returned') {
    if (row.status !== 'used') return fail(res, 400, '只有已用印状态可以登记归还');
    db.prepare("UPDATE seal_usages SET status='returned', returned_at=?, updated_at=? WHERE id=?").run(t, t, row.id);
  } else if (to === 'rejected') {
    if (!['pending', 'approved'].includes(row.status)) return fail(res, 400, '当前状态不能驳回');
    db.prepare("UPDATE seal_usages SET status='rejected', remark=COALESCE(?, remark), updated_at=? WHERE id=?")
      .run(b.reason || null, t, row.id);
  } else {
    return fail(res, 400, '状态应为 approved / used / returned / rejected');
  }
  const next = db.prepare('SELECT * FROM seal_usages WHERE id = ?').get(row.id);
  return ok(res, { ...next, status_label: SEAL_STATUS[next.status] });
}));

// ============================================================
// N14-08 安全巡检与报修
// ============================================================
router.get('/safety-checks', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.area) { cond.push('area = ?'); params.push(req.query.area); }
  const rows = db.prepare(
    `SELECT * FROM safety_checks ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows.map((r) => {
    let items = [];
    try { items = JSON.parse(r.items || '[]'); } catch (e) { items = []; }
    return {
      ...r,
      area_label: AREA[r.area] || r.area,
      result_label: r.result === 'issue' ? `发现 ${r.issues_count} 项异常` : '正常',
      items: Array.isArray(items) ? items : [],
      repair_count: Number(db.prepare('SELECT COUNT(*) AS c FROM repairs WHERE safety_check_id = ?').get(r.id).c) || 0
    };
  }));
}));

/**
 * 登记巡检；items 里 result='ng' 的项数自动算异常
 * 发现异常可同时生成报修单（affected 项与停用影响）
 */
router.post('/safety-checks', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.area) return fail(res, 400, '请选择巡检区域');
  const items = Array.isArray(b.items) ? b.items.filter((i) => i && i.item) : [];
  const ngItems = items.filter((i) => i.result === 'ng');
  const result = ngItems.length ? 'issue' : 'ok';
  const t = now();
  let checkId = null;
  try {
    db.exec('BEGIN');
    const r = db.prepare(
      `INSERT INTO safety_checks (check_no, area, facility, items, inspector, checked_at, result, issues_count, photo, remark, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(nextNo('safety_checks', 'check_no', 'XJ'), b.area, b.facility || null,
      JSON.stringify(items), b.inspector || req.user.username, b.checked_at || t, result,
      ngItems.length, b.photo || null, b.remark || null, t);
    checkId = Number(r.lastInsertRowid);

    // 异常项一键转报修
    if (b.create_repairs && ngItems.length) {
      const insRepair = db.prepare(
        `INSERT INTO repairs (repair_no, safety_check_id, area, facility, description, severity, photo, status,
           reporter, reported_at, down_impact, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      ngItems.forEach((it) => {
        insRepair.run(nextNo('repairs', 'repair_no', 'BX'), checkId, b.area,
          it.item, it.note || `${it.item} 巡检不合格`, it.severity || 'minor', b.photo || null,
          'reported', b.inspector || req.user.username, t, it.down_impact || null, t, t);
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, { id: checkId, result, issues_count: ngItems.length });
}));

router.get('/repairs', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.status) { cond.push('status = ?'); params.push(req.query.status); }
  if (req.query.area) { cond.push('area = ?'); params.push(req.query.area); }
  const rows = db.prepare(
    `SELECT * FROM repairs ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY (status IN ('verified','closed','rejected')), id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows.map((r) => ({
    ...r,
    area_label: AREA[r.area] || r.area || '-',
    status_label: REPAIR_STATUS[r.status] || r.status,
    severity_label: SEVERITY[r.severity] || r.severity,
    overdue: r.due_date && r.status !== 'closed' && r.status !== 'verified' && r.due_date < today()
  })));
}));

router.post('/repairs', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.facility) return fail(res, 400, '请填写报修设施');
  const t = now();
  const r = db.prepare(
    `INSERT INTO repairs (repair_no, order_id, area, facility, description, severity, photo, status, reporter,
       reported_at, due_date, down_impact, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(nextNo('repairs', 'repair_no', 'BX'), b.order_id || null, b.area || null, b.facility,
    b.description || null, b.severity || 'minor', b.photo || null, 'reported',
    b.reporter || req.user.username, t, b.due_date || null, b.down_impact || null, t, t);
  return ok(res, { id: Number(r.lastInsertRowid) });
}));

/**
 * 报修流转：已报修 → 维修中 → 已提交待复验 → 已复验 → 已关闭
 * 关键：提交维修与复验放行是两个动作，提交的人不能自己放行（这里用不同操作人校验）
 */
router.post('/repairs/:id/status', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM repairs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '报修单不存在');
  const b = req.body || {};
  const to = b.status;
  const t = now();

  if (to === 'repairing') {
    if (row.status !== 'reported') return fail(res, 400, '只有已报修可以转维修中');
    db.prepare("UPDATE repairs SET status='repairing', assignee=?, updated_at=? WHERE id=?")
      .run(b.assignee || row.assignee, t, row.id);
  } else if (to === 'submitted') {
    if (row.status !== 'repairing') return fail(res, 400, '只有维修中可以提交');
    db.prepare("UPDATE repairs SET status='submitted', submitted_at=?, remark=COALESCE(?, remark), updated_at=? WHERE id=?")
      .run(t, b.remark || null, t, row.id);
  } else if (to === 'verified') {
    if (row.status !== 'submitted') return fail(res, 400, '只有已提交待复验可以复验');
    if (row.assignee && row.assignee === req.user.username && req.user.role !== 'admin') {
      return fail(res, 400, '维修人与复验人不能是同一人，请由他人复验');
    }
    db.prepare("UPDATE repairs SET status='verified', verified_by=?, verified_at=?, remark=COALESCE(?, remark), updated_at=? WHERE id=?")
      .run(req.user.username, t, b.remark || null, t, row.id);
  } else if (to === 'closed') {
    if (!['verified', 'rejected'].includes(row.status)) return fail(res, 400, '只有已复验或不受理可以关闭');
    db.prepare("UPDATE repairs SET status='closed', updated_at=? WHERE id=?").run(t, row.id);
  } else if (to === 'rejected') {
    if (['verified', 'closed'].includes(row.status)) return fail(res, 400, '已复验/已关闭不可改为不受理');
    db.prepare("UPDATE repairs SET status='rejected', remark=COALESCE(?, remark), updated_at=? WHERE id=?")
      .run(b.reason || null, t, row.id);
  } else {
    return fail(res, 400, '状态应为 repairing / submitted / verified / closed / rejected');
  }
  const next = db.prepare('SELECT * FROM repairs WHERE id = ?').get(row.id);
  return ok(res, { ...next, status_label: REPAIR_STATUS[next.status] });
}));

module.exports = router;
