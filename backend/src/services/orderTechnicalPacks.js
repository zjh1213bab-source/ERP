/** 逐款技术资料的唯一归属规则：显式款式关联 > 预下单来源 > 唯一款号/名称。 */
const {db}=require('../db');
function items(orderId){return db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(orderId);}
function itemForPack(pack,rows){
 if(pack.order_item_id)return rows.find(i=>i.id===pack.order_item_id)||null;
 if(pack.pre_order_item_id)return rows.find(i=>i.source_pre_order_item_id===pack.pre_order_item_id)||null;
 const matches=rows.filter(i=>(i.style_no&&pack.customer_style_no===i.style_no)||pack.product_name===i.product_name);
 return matches.length===1?matches[0]:(rows.length===1?rows[0]:null);
}
function packForItem(orderId,item,rows=items(orderId)){
 return db.prepare('SELECT * FROM tech_packs WHERE order_id=? ORDER BY id DESC').all(orderId).find(p=>itemForPack(p,rows)?.id===item.id)||null;
}
module.exports={items,itemForPack,packForItem};
