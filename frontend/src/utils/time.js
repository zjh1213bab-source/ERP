/**
 * 时间显示
 * ============================================================
 * 后端 `now()` 存的是 `new Date().toISOString()` —— UTC 带 Z。
 * 直接 `slice(0, 16)` 显示，在 GMT+8 会整整差 8 小时：
 * 早上 8 点生成的报告，客户看到的是「00:18」。
 *
 * 这里只做一件事：**带时区的转本地，不带时区的原样返回**。
 * 后者是因为业务里很多字段（inspect_date、taken_at、order_date）本来就是本地字符串，
 * 一律 new Date() 解析再转会把「2026-10-28」变成「2026-10-27 16:00」。
 */

/** 是否是带时区的时刻（ISO 的 Z 或 ±HH:MM 结尾） */
function hasZone(s) {
  return /(Z|[+-]\d{2}:?\d{2})$/i.test(String(s).trim());
}

/**
 * 格式化成 `YYYY-MM-DD HH:mm`（本地时区）
 * @param {string} s 后端返回的时间字符串
 * @param {boolean} dateOnly 只要日期
 */
export function fmtTime(s, dateOnly = false) {
  if (!s) return '—';
  const raw = String(s).trim();
  if (!hasZone(raw)) {
    // 已经是本地字符串（或只有日期），只做 T → 空格与截断
    const flat = raw.replace('T', ' ');
    if (dateOnly) return flat.slice(0, 10);
    // 'YYYY-MM-DD HH:mm:ss.SSS' → 去掉毫秒
    return flat.length > 16 ? flat.slice(0, 16) : flat;
  }
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw.replace('T', ' ').slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (dateOnly) return ymd;
  return `${ymd} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 只要日期 */
export function fmtDate(s) {
  return fmtTime(s, true);
}
