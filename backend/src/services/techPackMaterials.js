/**
 * 开发单面辅料明细的落库逻辑（开发单编辑 与 打版流程·面辅料确认 共用一份）
 *
 * 档案来源行：名称 / 供应商 / 规格 / 单位 一律以档案现值覆盖；
 * 例外——**成份允许本单覆盖**：水洗标、烫画标这类辅料的成份要按客户指定填写，
 * 档案里存的是标准值，不能用它盖掉业务填的客户要求。
 * 其余 色号 / 款色 / 使用部位 / 图片 / 用量 / 损耗 / 空差 / 单价 / 备注 也在本单填。
 */
const { db, now } = require('../db');

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (v) => Math.round(n(v) * 100) / 100;

function saveMaterials(techPackId, materials) {
  db.prepare('DELETE FROM tech_pack_materials WHERE tech_pack_id = ?').run(techPackId);
  const ins = db.prepare(
    `INSERT INTO tech_pack_materials
     (tech_pack_id, material_id, mat_type, colorway, material_name, color_no, supplier, supplier_info, spec_info,
      composition, unit, one_use, loss_rate, air_gap, unit_price, amount, fabric_param, remark,
      use_part, image_url, color_card_url, sort, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const arcStmt = db.prepare('SELECT * FROM materials WHERE id = ?');
  const t = now();

  (materials || []).forEach((m, i) => {
    const oneUse = n(m.one_use);
    const price = n(m.unit_price);
    const amount = r2(oneUse * price);

    const arc = m.material_id ? arcStmt.get(m.material_id) : null;
    let row = {
      material_id: null,
      mat_type: m.mat_type === 'accessory' ? 'accessory' : 'fabric',
      colorway: m.colorway || null,
      material_name: m.material_name || null,
      color_no: m.color_no || null,
      supplier: m.supplier || null,
      supplier_info: m.supplier_info || null,
      spec_info: m.spec_info || null,
      composition: m.composition || null,
      unit: m.unit || '',
      fabric_param: m.fabric_param || null,
      image_url: m.image_url || null
    };
    if (arc) {
      const specParts = [];
      if (arc.width) specParts.push('幅宽' + arc.width);
      if (arc.weight) specParts.push('克重' + arc.weight);
      if (arc.air_gap) specParts.push('空差' + arc.air_gap);
      row = {
        material_id: arc.id,
        mat_type: arc.type,
        colorway: m.colorway || arc.color || null,
        material_name: arc.name,
        color_no: m.color_no || arc.color_no || null,
        supplier: arc.supplier || null,
        supplier_info: arc.supplier_info || null,
        spec_info: specParts.length ? specParts.join(' ') : (arc.spec || null),
        // 成份：本单填了就以本单为准（水洗标/烫画标按客户指定），没填才用档案值
        composition: (m.composition !== undefined && m.composition !== null && m.composition !== '')
          ? m.composition
          : (arc.composition || null),
        unit: arc.unit || '',
        fabric_param: arc.spec || null,
        image_url: m.image_url || arc.image_url || null
      };
    }

    ins.run(
      techPackId, row.material_id, row.mat_type, row.colorway, row.material_name, row.color_no,
      row.supplier, row.supplier_info, row.spec_info, row.composition, row.unit,
      oneUse, n(m.loss_rate), n(m.air_gap), price, amount,
      row.fabric_param, m.remark || null,
      m.use_part || null,
      row.image_url, m.color_card_url || null, i, t
    );
  });
}

module.exports = { saveMaterials, n, r2 };
