/**
 * 床日计算（唯一实现）
 * ========================================================================
 * 宿舍入住率只有一个正确口径：**住用床日 / 可用床日**（原型原话），
 * 且「不拿当前人数除年末床数」—— 分子分母不同源，除出来的百分比没有意义。
 *
 * 为什么单独抽出来：
 *   `routes/facility.js` 的「宿舍入住率」和 `services/adminOps.js` 的行政运营报表
 *   都要算这个数。各写一份的结果是可预期的：行政报表说 68%，后勤页说 62%，
 *   月底开会先花二十分钟争论哪个是对的。
 *
 * 三个容易算错的地方，都在这一个文件里处理：
 *
 * 1. **月末日期不能用 `toISOString().slice(0,10)`**。
 *    东八区下 `new Date(2026, 10, 0)` 是本地 10-31 00:00，转 UTC 变 10-30 16:00，
 *    slice 出来是 `2026-10-30` —— 整个月少一天，可用床日少 4 床×1 天。
 *    这里用本地构造 + `getDate()` 取月末日。
 *
 * 2. **整间维修的房间，床位也要扣**。只扣 `dorm_beds.status='maintenance'` 的话，
 *    「301 整间刷墙」这种情形床位仍算可用，入住率被系统性低估。
 *
 * 3. **维修床上不该有人住**。若出现，不去篡改数字，而是把这条单列出来
 *    （`used_on_unusable_beds`），由报表变成差异清单里的「数据矛盾」。
 *    同时住用床日只统计可用床，避免出现 120% 的入住率。
 */
const { db } = require('../db');

const pad = (n) => String(n).padStart(2, '0');

/** 期间边界（本地日期字符串，YYYY-MM） */
function periodRange(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) {
    const e = new Error('期间格式应为 YYYY-MM');
    e.status = 400;
    throw e;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) {
    const e = new Error('期间月份不合法');
    e.status = 400;
    throw e;
  }
  const lastDay = new Date(y, mo, 0).getDate();   // 本地月末日，别转 UTC
  return { start: `${y}-${pad(mo)}-01`, end: `${y}-${pad(mo)}-${pad(lastDay)}`, days: lastDay };
}

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);

/** 与期间重叠的天数（含首尾） */
function overlapDays(startDate, endDate, start, end) {
  const from = startDate > start ? startDate : start;
  const to = !endDate || endDate > end ? end : endDate;
  if (to < from) return 0;
  return daysBetween(from, to) + 1;
}

/**
 * 床日统计
 * @param {string} period YYYY-MM
 * @returns {object}
 */
function bedDays(period) {
  const { start, end, days } = periodRange(period);

  const rooms = db.prepare('SELECT * FROM dorm_rooms').all();
  const beds = db.prepare('SELECT * FROM dorm_beds').all();
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  const roomMaintenance = rooms.filter((r) => r.status === 'maintenance');
  const isUsable = (b) => {
    const room = roomById.get(b.room_id);
    if (!room) return false;
    return b.status !== 'maintenance' && room.status !== 'maintenance';
  };

  const usable = beds.filter(isUsable);
  const maintenanceBeds = beds.length - usable.length;
  const availableBedDays = usable.length * days;

  // 住宿单：active（在住，end_date 空）与 checked_out（已退）；cancelled 不算
  const stays = db.prepare(
    "SELECT * FROM dorm_stays WHERE status IN ('active','checked_out')"
  ).all();

  const usableIds = new Set(usable.map((b) => b.id));
  const perBed = new Map();          // bed_id → 重叠天数
  const usedOnUnusable = [];
  stays.forEach((s) => {
    const n = overlapDays(String(s.start_date), s.end_date ? String(s.end_date) : null, start, end);
    if (n <= 0) return;
    if (!usableIds.has(s.bed_id)) {
      const bed = beds.find((b) => b.id === s.bed_id);
      const room = bed ? roomById.get(bed.room_id) : null;
      usedOnUnusable.push({
        stay_id: s.id,
        employee_id: s.employee_id,
        bed_id: s.bed_id,
        bed_no: bed ? bed.bed_no : String(s.bed_id),
        room: room ? `${room.building || ''}${room.room_no}` : '（床位已删除）',
        days: n
      });
      return;
    }
    perBed.set(s.bed_id, (perBed.get(s.bed_id) || 0) + n);
  });

  let usedBedDays = 0;
  perBed.forEach((v) => { usedBedDays += Math.min(v, days); });   // 单床封顶，不出现 >100%
  const emptyBedDays = Math.max(0, availableBedDays - usedBedDays);

  // 按房间
  const byRoom = rooms.map((r) => {
    const bs = beds.filter((b) => b.room_id === r.id);
    const usableCount = bs.filter(isUsable).length;
    const used = bs.reduce((s, b) => s + Math.min(perBed.get(b.id) || 0, days), 0);
    const avail = usableCount * days;
    return {
      room_id: r.id,
      room: `${r.building || ''}${r.room_no}`,
      building: r.building || '',
      room_no: r.room_no,
      gender: r.gender,
      room_status: r.status,
      beds: bs.length,
      maintenance: bs.length - usableCount,
      usable: usableCount,
      available_days: avail,
      used_days: used,
      empty_days: Math.max(0, avail - used),
      rate: avail > 0 ? Math.round((used / avail) * 10000) / 100 : null
    };
  }).sort((a, b) => a.room.localeCompare(b.room, 'zh'));

  // 押金与租金：在住（active）
  const activeStays = stays.filter((s) => s.status === 'active');
  const checkedOut = stays.filter((s) => s.status === 'checked_out');

  return {
    period,
    start,
    end,
    days,
    rooms: rooms.length,
    rooms_maintenance: roomMaintenance.length,
    beds_total: beds.length,
    beds_usable: usable.length,
    beds_maintenance: maintenanceBeds,
    available_bed_days: availableBedDays,
    used_bed_days: usedBedDays,
    empty_bed_days: emptyBedDays,
    occupancy_rate: availableBedDays > 0 ? Math.round((usedBedDays / availableBedDays) * 10000) / 100 : null,
    // 口径限制：床位没有维修历史区间
    maintenance_note: maintenanceBeds > 0
      ? `可用床日按期末状态整期计算：${maintenanceBeds} 张维修/封房床已整月扣除，期内临时维修无历史区间，未单独扣减`
      : '期末无维修床；期内临时维修无历史区间，未单独扣减',
    used_on_unusable_beds: usedOnUnusable,
    deposits: {
      active_count: activeStays.length,
      deposit_total: Math.round(activeStays.reduce((s, x) => s + (Number(x.deposit) || 0), 0) * 100) / 100,
      rent_month_total: Math.round(activeStays.reduce((s, x) => s + (Number(x.rent_month) || 0), 0) * 100) / 100,
      checked_out_count: checkedOut.length,
      checked_out_deposit: Math.round(checkedOut.reduce((s, x) => s + (Number(x.deposit) || 0), 0) * 100) / 100
    },
    by_room: byRoom
  };
}

module.exports = { periodRange, overlapDays, daysBetween, bedDays };
