/**
 * 后端时间显示
 * ============================================================
 * 库里 `created_at` 一类字段是 `new Date().toISOString()`（UTC，带 Z）。
 * 直接塞进 CSV 让 Excel 打开，用户看到的是比北京时间早 8 小时的时间 ——
 * 对账、追责时这种偏差会被当成「时间对不上」。
 *
 * 规则与前端 `utils/time.js` 一致：
 *   **带时区(Z / ±HH:MM)的转本地，不带时区的原样返回**。
 * 后者是因为业务里很多字段（`inspect_date`、`order_date`、`taken_at`）本来就是本地字符串，
 * 一律 new Date() 再转会把「2026-10-28」变成「2026-10-27 16:00」。
 */

function hasZone(s) {
  return /(Z|[+-]\d{2}:?\d{2})$/i.test(String(s).trim());
}

/** `YYYY-MM-DD HH:mm`（本地） */
function localTime(s) {
  if (!s) return '';
  const raw = String(s).trim();
  if (!hasZone(raw)) {
    const flat = raw.replace('T', ' ');
    return flat.length > 16 ? flat.slice(0, 16) : flat;
  }
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw.replace('T', ' ').slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `YYYY-MM-DD HH:mm:ss`（本地，日志/备份用） */
function localTimeSec(s) {
  if (!s) return '';
  const raw = String(s).trim();
  if (!hasZone(raw)) {
    const flat = raw.replace('T', ' ');
    return flat.length > 19 ? flat.slice(0, 19) : flat;
  }
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw.replace('T', ' ').slice(0, 19);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `YYYY-MM-DD`（本地） */
function localDate(s) {
  return localTime(s).slice(0, 10);
}

module.exports = { localTime, localTimeSec, localDate };
