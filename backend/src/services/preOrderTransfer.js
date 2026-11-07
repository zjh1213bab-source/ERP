const {db}=require('../db');const scope=require('../access/companyScope');
const bad=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
function sourceForOrder(user,id,version) {
 const sc=scope.assertRow(user,'pre_orders',id,'预下单');if(!sc.ok)bad(sc.reason,sc.status);
 const row=sc.row;
 if(row.converted_order_id||row.status==='converted')bad('该预下单已生成正式订单，请打开原订单');
 if(row.status!=='ready')bad('请先完成预下单，再转业务下单');
 if(version!==undefined && Number(version)!==row.version)bad('预下单已更新，请重新带入资料');
 const incomplete=db.prepare("SELECT i.id FROM pre_order_items i WHERE i.pre_order_id=? AND i.source_type='new' AND NOT EXISTS(SELECT 1 FROM tech_packs t JOIN pattern_flows f ON f.tech_pack_id=t.id WHERE t.pre_order_item_id=i.id AND f.status='done') LIMIT 1").get(row.id);if(incomplete)bad('预下单新款尚未完成打版，不能转业务下单');
 return row;
}
module.exports={sourceForOrder};
