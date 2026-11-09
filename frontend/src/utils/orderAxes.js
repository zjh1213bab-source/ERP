/** 订单颜色、服装尺码及报价矩阵的排序/对齐；排序复用原单元，不重置已填资料。 */
const natural = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const text = value => String(value ?? '').trim();
function uniqueNames(values, keepEmpty = false) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(value => keepEmpty || value))];
}
function colorRank(value) {
  if (/^纯色\d*$/u.test(value)) return 0;
  if (/^印花\d+$/u.test(value)) return 1;
  if (/^款式\d+$/u.test(value)) return 2;
  return value ? 3 : 4;
}
export function sortColorNames(values) {
  return uniqueNames(values, true).sort((a, b) => colorRank(a) - colorRank(b) || natural.compare(a, b));
}
function sizeRank(value) {
  const size = value.toUpperCase().replace(/\s+/g, '');
  if (/^(NB|NEWBORN|新生儿)$/u.test(size)) return [0, 0, 0];
  const months = /(?:^|[（(])(\d+(?:\.\d+)?)(?:[-/](\d+(?:\.\d+)?))?(?:M|MONTHS?|月|个月)(?:[）)]|$)/u.exec(size);
  if (months) return [1, Number(months[1]), Number(months[2] || months[1])];
  const child = /(?:^|[（(])(\d+(?:\.\d+)?)(?:[-/](\d+(?:\.\d+)?))?(?:T|岁)(?:[）)]|$)/u.exec(size);
  if (child) return [2, Number(child[1]), Number(child[2] || child[1])];
  if (size === 'S') return [3, 0, 0];
  if (size === 'M') return [3, 1, 0];
  if (size === 'L') return [3, 2, 0];
  const small = /^(?:(X+)|(\d+)X)S$/u.exec(size);
  if (small) return [3, -(small[1]?.length || Number(small[2])), 0];
  const large = /^(?:(X+)|(\d+)X)L$/u.exec(size);
  if (large) return [3, 2 + (large[1]?.length || Number(large[2])), 0];
  if (/^\d+(?:[-/]\d+)?$/u.test(size)) return [4, Number(size.split(/[-/]/u)[0]), 0];
  return [5, 0, 0];
}
export function sortSizeNames(values) {
  return uniqueNames(values).sort((a, b) => {
    const x = sizeRank(a), y = sizeRank(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || natural.compare(a, b);
  });
}
export const orderSizeOptions = sortSizeNames(['NB', '0-3M', '3-6M', '6-12M', '12-18M', '18-24M', '2T', '3T', '4T',
  '5-6T', '6-7T', '7-8T', '8-9T', '9-10T', '10-12T', '12-14T', '14-16T', '16T', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL']);
export function templateSizeNames(template) {
  const values = Array.isArray(template?.sizes) ? template.sizes.map(value => typeof value === 'string' ? value : value?.size || value?.name) : String(template?.sizes || '').split(/[,，\n]/u);
  return sortSizeNames(values);
}
const cellKey = (color, size) => JSON.stringify([text(color), text(size)]);
export function removedQuoteCells(rows, colors, sizes) {
  const keepColors = new Set(colors), keepSizes = new Set(sizes);
  return rows.filter(row => !keepColors.has(text(row.color)) || !keepSizes.has(text(row.size)));
}
export function hasQuoteData(row) {
  return Number(row.qty || 0) !== 0 || Number(row.unit_price || 0) !== 0 || !!text(row.customer_size);
}
export function reconcileQuoteMatrix(rows, colors, sizes, { defaultPrice = 0, splitPrice = false } = {}) {
  const existing = new Map(rows.map(row => [cellKey(row.color, row.size), row]));
  const customerSizes = new Map();
  for (const row of rows) if (text(row.customer_size) && !customerSizes.has(text(row.size))) customerSizes.set(text(row.size), row.customer_size);
  return sortColorNames(colors).flatMap(color => sortSizeNames(sizes).map(size => existing.get(cellKey(color, size)) || {
    color, size, customer_size: customerSizes.get(size) || '', qty: 0, unit_price: splitPrice ? 0 : defaultPrice
  }));
}
/** 独立轴也能保存；旧单没有 metadata 时从报价格恢复。图片仅保留当前颜色。 */
export function readQuoteMatrixMeta(rows, meta) {
  const saved = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const colors = sortColorNames([...(Array.isArray(saved.colors) ? saved.colors : []), ...rows.map(row => row.color || '')]);
  const sizes = sortSizeNames([...(Array.isArray(saved.sizes) ? saved.sizes : []), ...rows.map(row => row.size)]);
  const images = saved.color_images && typeof saved.color_images === 'object' ? saved.color_images : {};
  return { colors, sizes, color_images: Object.fromEntries(colors.filter(color => Object.hasOwn(images, color) && typeof images[color] === 'string' && images[color]).map(color => [color, images[color]])),
    split_price: saved.split_price === true || new Set(rows.map(row => Number(row.unit_price || 0))).size > 1 };
}
/** 行/列复制只改变正在编辑的字段，避免输入数量时覆盖分价，或输入价格时覆盖数量。 */
export function applyQuoteField(rows, color, size, field, value, copyMode = '') {
  if (!['qty', 'unit_price'].includes(field)) throw new Error('Unsupported quote field');
  const number = value === '' ? 0 : Number(value);
  for (const row of rows) {
    const matches = copyMode === 'row' ? text(row.color) === text(color) : copyMode === 'column' ? text(row.size) === text(size) : cellKey(row.color, row.size) === cellKey(color, size);
    if (matches) row[field] = number;
  }
}
export function applyQuoteQuantity(rows, color, size, value, copyMode = '') {
  applyQuoteField(rows, color, size, 'qty', value, copyMode);
}
/** 点击复制图标：先冻结当前格数值，再覆盖同行/同列其他格，返回目标格数。 */
export function copyQuoteCell(rows, color, size, copyMode, { splitPrice = false } = {}) {
  if (!Array.isArray(rows) || !['row', 'column'].includes(copyMode)) return 0;
  const key = cellKey(color, size);
  const source = rows.find(row => cellKey(row.color, row.size) === key);
  if (!source) return 0;
  const qty = Number(source.qty || 0), price = Number(source.unit_price || 0);
  let targets = 0;
  for (const row of rows) {
    if (cellKey(row.color, row.size) === key) continue;
    const matches = copyMode === 'row' ? text(row.color) === text(color) : text(row.size) === text(size);
    if (!matches) continue;
    row.qty = qty;
    if (splitPrice) row.unit_price = price;
    targets++;
  }
  return targets;
}
/** 与预单报价现有口径一致：单价先转整数分，再累加各格金额。 */
export function quoteTotals(rows) {
  return rows.reduce((totals, row) => {
    totals.qty += Number(row.qty || 0);
    totals.cents += Math.round(Number(row.qty || 0) * Math.round(Number(row.unit_price || 0) * 100));
    return totals;
  }, { qty: 0, cents: 0 });
}
