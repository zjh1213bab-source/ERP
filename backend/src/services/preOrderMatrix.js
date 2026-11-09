/** 预下单颜色/尺码界面快照。报价仍由 preOrderPricing 校验和计价。 */
const { imageUrl } = require('./orderImages');
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const unique = values => [...new Set(values)];
const axes = rows => ({ colors: unique(rows.map(row => row.color || '')), sizes: unique(rows.map(row => row.size)) });
const differentPrices = rows => new Set(rows.map(row => Number(row.unit_price))).size > 1;
function names(value, label, max, length, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > max) bad(`${label}最多${max}项`);
  const result = value.map(name => {
    if (typeof name !== 'string') bad(`${label}格式无效`);
    const trimmed = name.trim();
    if ((!allowEmpty && !trimmed) || trimmed.length > length) bad(`${label}名称无效或超过${length}字`);
    return trimmed;
  });
  if (new Set(result).size !== result.length) bad(`${label}不能重复`);
  return result;
}
function normalize(value, rows) {
  if (!object(value)) bad('颜色尺码配置格式无效');
  // 空颜色为历史报价中的“待确认”，仍须能完整回读旧预单。
  const colors = names(value.colors, '颜色', 60, 100, true);
  const sizes = names(value.sizes, '尺码', 30, 50);
  if (typeof value.split_price !== 'boolean') bad('分码分色分价设置无效');
  if (!value.split_price && differentPrices(rows)) bad('颜色尺码单价不同，请开启分码分色分价');
  if (!object(value.color_images)) bad('颜色图片格式无效');
  const images = [];
  for (const [color, url] of Object.entries(value.color_images)) {
    if (!colors.includes(color)) bad('颜色图片必须属于已选颜色');
    const valid = imageUrl(url);
    if (valid) images.push([color, valid]);
  }
  if (rows.some(row => !colors.includes(row.color || '') || !sizes.includes(row.size))) bad('颜色尺码配置与报价明细不一致');
  const requirements=value.material_details===undefined?{}:require('./preOrderMaterials').normalize(value.material_details,value.material_groups||[]);
  for(const key of ['materials','crafts'])if(value[key]!==undefined)requirements[key]=names(value[key],key==='materials'?'面辅料':'工艺',100,500);
  if(value.craft_note!==undefined){if(typeof value.craft_note!=='string'||value.craft_note.length>2000)bad('工艺要求最多2000字');requirements.craft_note=value.craft_note.trim();}
  return { colors, sizes, color_images: Object.fromEntries(images), split_price: value.split_price,...requirements };
}
function derived(rows) {
  return { ...axes(rows), color_images: {}, split_price: differentPrices(rows) };
}
function read(value, rows) {
  try {
    const parsed = JSON.parse(value || '{}');
    if (object(parsed) && Object.keys(parsed).length) {
      if (typeof parsed.split_price === 'boolean' && differentPrices(rows)) parsed.split_price = true;
      return normalize(parsed, rows);
    }
  } catch {}
  return derived(rows);
}
function sameNames(left, right) {
  return left.length === right.length && left.every(name => right.includes(name));
}
/** 旧客户端不传新字段时，保留仍在本单中的颜色图；报价删轴后对应图同步移除。 */
function prepare(value, rows, previous, previousRows = []) {
  if (value !== undefined) {
    if(previous&&object(value)){const saved=read(previous.matrix_json,previousRows);value={...value};for(const key of ['materials','crafts','craft_note','material_details','material_groups'])if(value[key]===undefined&&saved[key]!==undefined)value[key]=saved[key];}
    return normalize(value, rows);
  }
  if (!previous) return normalize(derived(rows), rows);
  const saved = read(previous.matrix_json, previousRows), before = axes(previousRows), after = axes(rows);
  const changed = !sameNames(before.colors, after.colors) || !sameNames(before.sizes, after.sizes);
  const next = changed ? { ...saved, ...after } : saved;
  const color_images = Object.fromEntries(Object.entries(saved.color_images).filter(([color]) => next.colors.includes(color)));
  return normalize({ ...next, color_images, split_price: next.split_price || differentPrices(rows) }, rows);
}
module.exports = { normalize, prepare, read };
