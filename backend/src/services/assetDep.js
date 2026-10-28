/**
 * 资产折旧口径（唯一实现）
 * ========================================================================
 * 行政的「工衣与领归」页面要显示关联资产卡的净值，但不能自己再算一遍折旧 ——
 * 原型原话：**「折旧不是行政再算一次」**。
 * 若两边各写一份公式，资产页显示净值 8,420、行政页 8,400，
 * 财务年底对固定资产净值时会不知道该信谁；更糟的是行政那边改了一行代码，
 * 资产台账自己没变，两张报表就永久对不上。
 *
 * 所以公式与取整只在这里维护，`routes/assets.js` 与 `services/custody.js`
 * 都从这里取。改动只有一处。
 */
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const STATUS_LABELS = { in_use: '在用', idle: '闲置', scrapped: '已报废' };

/** 已用整月：不足一个月不算（与财务「当月购入次月起提」的习惯接近，且不会出现负数） */
function monthsSince(dateStr, until) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  const end = until ? new Date(until) : new Date();
  let m = (end.getFullYear() - d.getFullYear()) * 12 + (end.getMonth() - d.getMonth());
  if (end.getDate() < d.getDate()) m -= 1;
  return Math.max(0, m);
}

/**
 * 直线法：
 *   月折旧 = 原值 × (1 − 残值率) / (年限 × 12)
 *   累计折旧 = min(月折旧 × 已用整月, 原值 × (1 − 残值率))
 *   净值 = 原值 − 累计折旧
 */
function withDepreciation(row) {
  if (!row) return row;
  const original = Number(row.original_value) || 0;
  const salvageRate = Number(row.salvage_rate) || 0;
  const years = Number(row.useful_years) || 0;
  const months = monthsSince(row.purchase_date);
  const depreciable = round2(original * (1 - salvageRate));
  const monthly = years > 0 ? round2(depreciable / (years * 12)) : 0;
  const accumulated = Math.min(round2(monthly * months), depreciable);
  return {
    ...row,
    status_label: STATUS_LABELS[row.status] || row.status,
    months_used: months,
    monthly_depreciation: monthly,
    accumulated_depreciation: accumulated,
    net_value: round2(original - accumulated)
  };
}

module.exports = { round2, STATUS_LABELS, monthsSince, withDepreciation };
