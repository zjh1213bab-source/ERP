/** 工序档案是可复用模板；各款复制独立工序快照与数组顺序。 */
const {db}=require('../db');
const bad=message=>{throw Object.assign(new Error(message),{status:400});};
function normalizeCraftRows(list) {
 if(!Array.isArray(list))return [];
 return list.slice(0,300).filter(r=>r && typeof r==='object').map(r=>({
  craft_type_id:Number(r.craft_type_id)||null,category:String(r.category||'').slice(0,24),name:String(r.name||'').trim().slice(0,60),
  price:Math.round((Number(r.price)||0)*100)/100,ratio:Number(r.ratio)||0,owner:String(r.owner||'').slice(0,24),remark:String(r.remark||'').slice(0,120),
  open_price:Math.round((Number(r.open_price)||0)*100)/100,unit:String(r.unit||'件').slice(0,16),image_url:String(r.image_url||'').slice(0,2048)
 })).filter(r=>r.name);
}
function validateCraftData(data) {
 for(const key of ['sewing','finish']) {
  if(data[key]===undefined)continue;
  if(!Array.isArray(data[key]) || data[key].length>300)bad('每组工序最多300行');
  for(const row of data[key]) {
   if(!row || typeof row!=='object' || String(row.name||'').trim().length>60)bad('工序名称格式无效或超过60字');
   for(const field of ['price','ratio','open_price'])if(row[field]!=null && row[field]!=='' && (!Number.isFinite(Number(row[field])) || Number(row[field])<0))bad('工序单价和倍率必须为非负数');
   if(row.craft_type_id && !db.prepare('SELECT id FROM craft_types WHERE id=?').get(row.craft_type_id))bad('引用的工序档案不存在，请重新选择');
  }
 }
}
module.exports={normalizeCraftRows,validateCraftData};
