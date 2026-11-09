/** 预单报价转业务下单时保留统一单价、分价、客户尺码与颜色图片。 */
import { sortColorNames, sortSizeNames } from './orderAxes.js';

export function preOrderMatrixForSales(item) {
  const rows = item.size_prices || [];
  const meta = item.matrix_meta || {};
  const split = typeof meta.split_price === 'boolean' ? meta.split_price : rows.length > 0;
  const unitPrice = Number(rows[0]?.unit_price || 0);
  const colors = sortColorNames([...(meta.colors || []), ...rows.map(row => row.color || '')]);
  const sizes = sortSizeNames([...(meta.sizes || []), ...rows.map(row => row.size)]);
  // 正式下单以颜色行承载尺码；仅选尺码时保留未确认颜色，避免回落到默认矩阵。
  if (!colors.length && sizes.length) colors.push('');
  let pendingColor = '待确认', suffix = 2;
  while (colors.includes(pendingColor)) pendingColor = `待确认（${suffix++}）`;
  const displayColor = color => color || pendingColor;
  const cellKey = (color, size) => JSON.stringify([String(color || '').trim(), String(size || '').trim()]);
  const cells = new Map(rows.map(row => [cellKey(row.color, row.size), row]));
  const images = meta.color_images || {};
  return {
    ...(meta.material_details ? {materials:JSON.parse(JSON.stringify(meta.material_details)),material_groups:JSON.parse(JSON.stringify(meta.material_groups||[]))}:{}),
    customer_sizes: Object.fromEntries(rows.filter(row => row.customer_size).map(row => [row.size, row.customer_size])),
    colors: colors.map(color => ({
      color: displayColor(color), sizes: sizes.map(size => {
        const row = cells.get(cellKey(color, size));
        return { size, qty: row?.qty ?? 0, usd_price: row?.unit_price ?? (split ? 0 : unitPrice) };
      })
    })),
    color_images: Object.fromEntries(colors.filter(color => Object.hasOwn(images, color)).map(color => [displayColor(color), images[color]])),
    split_price: split,
    unit_price: unitPrice
  };
}
