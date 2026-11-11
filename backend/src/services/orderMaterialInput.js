/** 订单引用主档的唯一入口：规格、单位、供应商不可由订单请求覆盖。 */
const { db } = require('../db');
function archiveInput(body, previous = {}) {
  const bad = (message, status = 400) => Object.assign(new Error(message), { status });
  const id = body.material_id ?? previous.material_id;
  const arc = id ? db.prepare('SELECT * FROM materials WHERE id=?').get(id) : null;
  if (id && !arc) throw bad('物料档案不存在');
  if (!arc && !previous.id) throw bad('请先从物料档案选择物料');
  if (!arc) return { ...body, spec: previous.spec };
  if (!previous.id && arc.status !== 'active') throw bad('该物料已停用，请重新选择');
  if (body.archive_version != null && Number(body.archive_version) !== Number(arc.version)) throw bad('物料档案已修改，请刷新物料后重试', 409);
  const spec = [arc.width && '幅宽'+arc.width, arc.weight && '克重'+arc.weight, arc.air_gap && '空差'+arc.air_gap, arc.spec].filter(Boolean).join(' ');
  const supplier = arc.supplier_id ? db.prepare('SELECT name FROM suppliers WHERE id=?').get(arc.supplier_id)?.name : arc.supplier;
  return { ...body, price: arc.unit_price, material_id: arc.id, type: arc.type, name: arc.name, unit: arc.unit,
    spec, archive_air_gap:arc.air_gap, supplier: supplier || '', ingredient: body.ingredient ?? previous.ingredient ?? arc.composition,
    mat_color: body.mat_color ?? previous.mat_color ?? null };
}
module.exports = { archiveInput };
