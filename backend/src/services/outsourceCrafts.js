/** 外发工艺按样版、阶段、款色保存；档案与本单明细分离。 */
const {db}=require('../db');const {imageUrl}=require('./orderImages');
const bad=message=>{throw Object.assign(new Error(message),{status:400});};
const text=(v,label,max=1000)=>{if(typeof v!=='string'||v.length>max)bad(label+'格式或长度无效');return v.trim();};
function normalize(rows,previous=[]){
 if(!Array.isArray(rows)||rows.length>200)bad('最多200条外发工艺明细');
 const keys=new Set();
 return rows.map(row=>{
  if(!row||typeof row!=='object')bad('外发工艺明细无效');
  const key=text(row.key,'行标识',100);if(!key||keys.has(key))bad('行标识为空或重复');keys.add(key);
  const old=previous.find(x=>x.key===key),craftId=Number(row.craft_type_id),factoryId=row.factory_id?Number(row.factory_id):null;
  if(!Number.isSafeInteger(craftId)||craftId<1)bad('请从工艺档案选择工艺');
  const craft=db.prepare('SELECT * FROM craft_types WHERE id=?').get(craftId);if(!craft||(craft.status!=='active'&&old?.craft_type_id!==craftId))bad('工艺档案不存在或已停用');
  const factory=factoryId?db.prepare('SELECT * FROM factories WHERE id=?').get(factoryId):null;
  if(factoryId&&(!Number.isSafeInteger(factoryId)||!factory||(factory.status!=='active'&&old?.factory_id!==factoryId)))bad('工艺厂不存在或已停用');
  if(!['fabric','cut'].includes(row.phase))bad('外发工艺阶段无效');
  const color=text(row.color,'款色',100);if(!color)bad('每条工艺须指定款色');
  const qty=Number(row.qty),price=Number(row.price);if(!Number.isFinite(qty)||qty<0||qty>1e7||!Number.isFinite(price)||price<0||price>1e7||Math.abs(price*100-Math.round(price*100))>0.00001)bad('数量或工艺单价无效（单价最多两位小数）');
  return {key,phase:row.phase,color,craft_type_id:craftId,name:old?.craft_type_id===craftId?old.name:craft.name,unit:craft.unit,factory_id:factoryId,factory_name:factory?.name||'',phone:factory?.phone||'',address:factory?.address||'',qty,price,amount:Math.round((qty*price+Number.EPSILON)*100)/100,image_url:imageUrl(row.image_url),remark:text(row.remark||'','备注',2000)};
 });
}
function read(value){try{const a=JSON.parse(value||'[]');return Array.isArray(a)?a:[];}catch{return [];}}
module.exports={normalize,read};
