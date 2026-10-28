/**
 * 供应商账期解析 + 应收应付到期日推算
 *
 * ## 为什么账期要"解析"而不是"选"
 * `suppliers.payment_terms` 是自由文本（"月结30天" / "现结" / "月结45天"），
 * 采购同事填的时候不会考虑机器怎么读。让人改成下拉选择，等于要求他们
 * 把所有历史数据重录一遍 —— 不现实，也没人愿意干。
 *
 * 所以：**能读懂的自动读，读不懂的留空并提示人工填天数**。
 * 解析结果缓存在 `suppliers.term_days`，可以手工覆盖
 * （遇到"月结30天，但这家实际是次月15日付"这种，填死天数就行）。
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * 解析账期文本
 * @returns {{days:number, kind:string, source:string}|null} 读不懂返回 null（不要瞎猜成 30 天）
 */
function parseTerms(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  // 现结 / 预付 / 款到发货 → 0 天
  if (/现结|现金|预付|款到|货到付款|一手交钱/.test(s)) {
    return { days: 0, kind: 'cash', source: s };
  }
  // 月结 N 天 / 月结
  const m1 = s.match(/月结\s*(\d+)?\s*天?/);
  if (m1) {
    const d = m1[1] === undefined ? 30 : Number(m1[1]);   // 「月结」不带数字默认 30
    return { days: d, kind: 'monthly', source: s };
  }
  // 次月 N 日
  const m2 = s.match(/次月\s*(\d{1,2})\s*[日号]/);
  if (m2) {
    // 次月 15 日 ≈ 45 天（近似值，够算账龄；要精确请手工填天数）
    return { days: 30 + Number(m2[1]), kind: 'next_month_day', source: s, approx: true };
  }
  // 纯数字："30" / "30天" / "45 天"
  const m3 = s.match(/^(\d{1,3})\s*天?$/);
  if (m3) return { days: Number(m3[1]), kind: 'days', source: s };
  // 货到 N 天
  const m4 = s.match(/货到\s*(\d+)\s*天/);
  if (m4) return { days: Number(m4[1]), kind: 'after_arrival', source: s };

  return null;
}

/** 客户侧账期（credit_days 是数字，直接给默认值兜底） */
function customerTermDays(customer, fallback = 30) {
  if (!customer) return fallback;
  const v = customer.credit_days;
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 加天数（YYYY-MM-DD） */
function addDays(dateStr, n) {
  const base = String(dateStr || '').slice(0, 10);
  const d = new Date(base + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return base;
  d.setDate(d.getDate() + Number(n || 0));
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function todayStr() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 根据供应商算应付到期日
 *
 * **优先级**（这是应付账龄准不准的关键）：
 *   1. 手工填的 `term_days`（明确指定，压过一切）
 *   2. `payment_terms` 文本解析
 *   3. 都读不出来 → 返回 null，**不猜**
 *
 * 为什么不用采购单的 `expect_date`（预计到货日）：那是「货什么时候到」，
 * 不是「钱什么时候该付」。之前应付到期日就是拿它填的，于是
 * 「9 月 20 日到货、月结 30 天」被算成 9-20 到期，账龄凭空多出 30 天。
 */
function apDueDate(supplier, billDate = todayStr()) {
  if (!supplier) return null;
  let days = null;
  if (supplier.term_days !== null && supplier.term_days !== undefined && supplier.term_days !== '') {
    days = Number(supplier.term_days);
  } else {
    const p = parseTerms(supplier.payment_terms);
    if (p) days = p.days;
  }
  if (days === null || !Number.isFinite(days)) return null;
  return addDays(billDate, days);
}

module.exports = { parseTerms, apDueDate, addDays, todayStr, customerTermDays, r2 };
