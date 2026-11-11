/** 预单物料快照：读取不依赖当前档案；写入时校验档案并冻结可信字段。 */
const bad=message=>{throw Object.assign(new Error(message),{status:400});};
const str=(v,max=500)=>{if(v!=null&&typeof v!=='string')bad('物料文本格式无效');const s=(v||'').trim();if(s.length>max)bad('物料文本过长');return s;};
const num=(v,max=1e6)=>{const n=Number(v??0);if(!Number.isFinite(n)||n<0||n>max)bad('物料数值无效');return n;};
const list=(v,max=100)=>{if(!Array.isArray(v)||v.length>max)bad('物料明细数量无效');return v;};
const img=v=>require('./orderImages').imageUrl(v)||'';
function normalize(rows,groups=[]){
 const gs=list(groups).map(g=>({id:str(g.id,100),type:g.type,name:str(g.name),one_use:num(g.one_use),unit:str(g.unit,50)}));
 if(gs.some(g=>!g.id||!['fabric','accessory'].includes(g.type))||new Set(gs.map(g=>g.id)).size!==gs.length)bad('物料部位分组无效');
 const units=new Map();
 const ms=list(rows).map((m,i)=>{
  if(!m||!Number.isSafeInteger(m.material_id)||m.material_id<=0||!['fabric','accessory'].includes(m.type))bad('请选择有效的物料档案');
  const r={key:str(m.key,100)||'material-'+i,material_id:m.material_id,type:m.type,archive_version:m.archive_version==null?undefined:num(m.archive_version),one_use:num(m.one_use),loss:num(m.loss,1000),price:num(m.price,1e7),air_gap:num(m.air_gap??100,1000),split_use:false,colors_configured:m.colors_configured===true,order_image_url:img(m.order_image_url)};
  if(!r.air_gap)bad('物料空差必须大于0');
  for(const k of ['name','order_name','code','unit','width','weight','spec','supplier','ingredient','usage_part','remark','usage_group_id','role'])r[k]=str(m[k],['spec','ingredient','remark'].includes(k)?2000:500);
  if(r.usage_group_id){const g=gs.find(g=>g.id===r.usage_group_id);if(!g||g.type!==r.type)bad('物料部位分组不存在');if(units.has(g.id)&&units.get(g.id)!==r.unit)bad('同一部位物料单位须一致');units.set(g.id,r.unit);r.one_use=g.one_use;r.usage_part=g.name;}
  r.colors=list(m.colors||[],60).map(c=>({colorway:str(c.colorway,100),color_no:str(c.color_no,150),price:c.price==null||c.price===''?null:num(c.price,1e7),qty:null,sizes:[],image_url:img(c.image_url)}));
  r.shared_color = m.shared_color ?? (m.type === 'accessory' && !r.colors_configured && !r.colors.length);
  r.shared_config = r.shared_color ? r.colors[0] || null : null;
  if(r.colors.some(c=>!c.colorway)||new Set(r.colors.map(c=>c.colorway)).size!==r.colors.length)bad('物料配色为空或重复');return r;
 });
 if(new Set(ms.map(m=>m.key)).size!==ms.length)bad('物料标识重复');return {material_details:ms,material_groups:gs};
}
function prepare(meta){
 if(meta.material_details===undefined)return meta;
 const {db}=require('../db'),{archiveInput}=require('./orderMaterialInput');
 const rows=meta.material_details.map(m=>{const trusted=archiveInput(m),a=db.prepare('SELECT * FROM materials WHERE id=?').get(m.material_id);return {...m,...trusted,colors:(m.colors||[]).map(c=>({...c,price:null})),archive_version:a.version,code:a.code||'',width:a.width||'',weight:a.weight||'',air_gap:Number(String(a.air_gap||100).replace('%',''))};});
 const data=normalize(rows,meta.material_groups||[]);
 if(data.material_details.some(m=>m.colors.some(c=>!meta.colors.includes(c.colorway))))bad('物料配色不属于本款已选颜色');
 return {...meta,...data};
}
function techRows(rows){return rows.flatMap(m=>{const entry_json=JSON.stringify({editor_material_key:m.key,shared_color:m.shared_color,shared_config:m.shared_config,usage_group_id:m.usage_group_id,colors_configured:m.colors_configured,colors:m.colors,order_image_url:m.order_image_url,width:m.width,weight:m.weight,base_price:m.price});return (m.colors.length?m.colors:[{colorway:'',price:m.price}]).map(c=>({material_id:m.material_id,mat_type:m.type,material_name:m.name,unit:m.unit,composition:m.ingredient,supplier:m.supplier,spec_info:m.spec,one_use:m.one_use,unit_price:c.price??m.price,loss_rate:m.loss,air_gap:m.air_gap,use_part:m.usage_part,remark:m.remark,image_url:m.order_image_url,color_card_url:c.image_url||'',colorway:c.colorway,color_no:c.color_no||'',entry_json}));});}
module.exports={normalize,prepare,techRows};
