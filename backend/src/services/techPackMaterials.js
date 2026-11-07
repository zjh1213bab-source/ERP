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

function saveMaterials(techPackId, materials, options = {}) {
  const groups=new Map();
  for(const m of materials||[]){
    if(!m.entry_json)continue;
    let data;try{if(typeof m.entry_json!=='string'||m.entry_json.length>150000)throw Error();data=JSON.parse(m.entry_json);}catch{throw Object.assign(new Error('物料配色资料格式无效'),{status:400});}
    const fail=message=>{throw Object.assign(new Error(message),{status:400});};
    if(!data||typeof data!=='object'||Array.isArray(data)||!Array.isArray(data.colors)||data.colors.length>60)fail('每条物料最多60个配色');
    const seen=new Set();
    for(const color of data.colors){
      if(!color||typeof color.colorway!=='string'||!color.colorway.trim()||color.colorway.length>150||seen.has(color.colorway))fail('物料款色为空、重复或过长');seen.add(color.colorway);
      if(color.price!=null&&(!Number.isFinite(Number(color.price))||Number(color.price)<0||Number(color.price)>1e7))fail('配色单价无效');
      require('./orderImages').imageUrl(color.image_url);
      if(color.color_no!=null&&(typeof color.color_no!=='string'||color.color_no.length>255))fail('物料色号过长');
    }
    require('./orderImages').imageUrl(data.order_image_url);
    if(!Number.isFinite(Number(m.one_use))||Number(m.one_use)<0||Number(m.one_use)>1e6)fail('部位用量无效');
    if(data.usage_group_id){const arc=m.material_id?db.prepare('SELECT unit FROM materials WHERE id=?').get(m.material_id):null;const value=JSON.stringify([m.use_part||'',Number(m.one_use),arc?.unit||m.unit]);if(groups.has(data.usage_group_id)&&groups.get(data.usage_group_id)!==value)fail('同一使用部位须统一用量及计量单位');groups.set(data.usage_group_id,value);}
  }
  // 新品可不进入公共主档，但已通过业务确认的候选规格仍是可信来源。
  // 此内部参数不由任何编辑接口透传；必须与后端已确认的开发申请逐字段匹配。
  const reviewed = options.developmentRequestId ? db.prepare(`SELECT r.*,d.candidate_name,d.candidate_spec FROM material_dev_requests r
    JOIN material_dev_rounds d ON d.request_id=r.id AND d.decision='approved'
    WHERE r.id=? AND r.status='completed' AND r.pattern_review_status IN ('pending','rejected')`).get(options.developmentRequestId) : null;
  for (const m of materials || []) {
    if (m.material_id && !db.prepare('SELECT id FROM materials WHERE id=?').get(m.material_id)) throw Object.assign(new Error('物料档案不存在，请重新选择'), { status: 400 });
    if (!m.material_id && (m.spec_info || m.fabric_param)) {
      const legacy = m.id ? db.prepare('SELECT spec_info,fabric_param FROM tech_pack_materials WHERE id=? AND tech_pack_id=?').get(m.id,techPackId) : null;
      const fromReviewed = reviewed && m.mat_type===reviewed.material_type && m.material_name===(reviewed.candidate_name || reviewed.material_name)
        && String(m.spec_info || '')===String(reviewed.candidate_spec || reviewed.requested_spec || '') && !m.fabric_param;
      if (!fromReviewed && (!legacy || String(legacy.spec_info || '') !== String(m.spec_info || '') || String(legacy.fabric_param || '') !== String(m.fabric_param || ''))) throw Object.assign(new Error('规格只能从物料档案或已审核新品开发带入，请先选择有效来源'), { status: 400 });
    }
  }
  db.prepare('DELETE FROM tech_pack_materials WHERE tech_pack_id = ?').run(techPackId);
  const ins = db.prepare(
    `INSERT INTO tech_pack_materials
     (tech_pack_id, material_id, mat_type, colorway, material_name, color_no, supplier, supplier_info, spec_info,
      composition, unit, one_use, loss_rate, air_gap, unit_price, amount, fabric_param, remark,
      use_part, image_url, color_card_url, sort, created_at, entry_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      if (arc.spec) specParts.push(arc.spec);
      row = {
        material_id: arc.id,
        mat_type: arc.type,
        colorway: m.colorway || null,
        material_name: arc.name,
        color_no: m.color_no || null,
        supplier: arc.supplier || null,
        supplier_info: arc.supplier_info || null,
        spec_info: specParts.length ? specParts.join(' ') : (arc.spec || null),
        // 成份：本单填了就以本单为准（水洗标/烫画标按客户指定），没填才用档案值
        composition: (m.composition !== undefined && m.composition !== null)
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
      oneUse, n(m.loss_rate), arc ? n(String(arc.air_gap || '').replace(/[^\d.]/g, '')) : 0, price, amount,
      row.fabric_param, m.remark || null,
      m.use_part || null,
      row.image_url, m.color_card_url || null, i, t, m.entry_json || null
    );
  });
}

module.exports = { saveMaterials, n, r2 };
