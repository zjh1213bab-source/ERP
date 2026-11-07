/** 采购订单工作台只读投影：采购状态取单据事实，技术用量只作参考，不修改齐套缓存/库存。 */
const {db}=require('../db');
const round=v=>Math.round(Number(v||0)*100)/100;
function group(rows,key){const out=new Map();for(const row of rows){const k=row[key];if(!out.has(k))out.set(k,[]);out.get(k).push(row);}return out;}
function procurementState(lines){if(!lines.length)return 'pending';if(lines.every(l=>l.status==='cancelled'))return 'cancelled';const active=lines.filter(l=>l.status!=='cancelled');if(active.length&&active.every(l=>l.status!=='draft'&&Number(l.received_qty)>=Number(l.qty)))return 'received';if(active.some(l=>l.status!=='draft'))return 'ordering';return 'pending';}
function workspace(companyId){
 const condition=companyId?' AND o.company_id=?':'',params=companyId?[companyId]:[];
 const orders=db.prepare(`SELECT o.*,COALESCE(c.name,o.customer_name_snapshot) customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.status<>'cancelled'${condition} ORDER BY o.id DESC LIMIT 5001`).all(...params);
 const pos=db.prepare(`SELECT p.*,u.name buyer_name FROM purchase_orders p LEFT JOIN users u ON u.id=p.created_by WHERE 1=1${companyId?' AND p.company_id=?':''} ORDER BY p.id DESC LIMIT 5001`).all(...params);
 const permitted=new Set(pos.map(p=>p.id));
 // 查询子表时同样沿父单限定主体，避免汇总页泄露另一主体物料和回料记录。
 const lines=db.prepare(`SELECT i.*,p.po_no,p.order_id,p.supplier,p.status,p.created_at,p.created_by,u.name buyer_name,COALESCE(m.type,'unknown') material_type FROM purchase_items i JOIN purchase_orders p ON p.id=i.po_id LEFT JOIN materials m ON m.id=i.material_id LEFT JOIN users u ON u.id=p.created_by WHERE 1=1${companyId?' AND p.company_id=?':''} ORDER BY i.id DESC`).all(...params).filter(i=>permitted.has(i.po_id));
 const returns=db.prepare(`SELECT gi.*,g.grn_no,g.po_id,g.receive_date,g.status receipt_status,g.remark,g.supplier,p.order_id,p.po_no FROM goods_receipt_items gi JOIN goods_receipts g ON g.id=gi.grn_id JOIN purchase_orders p ON p.id=g.po_id WHERE 1=1${companyId?' AND p.company_id=?':''} ORDER BY gi.id DESC`).all(...params).filter(i=>permitted.has(i.po_id));
 const orderIds=new Set(orders.map(o=>o.id)),poByOrder=group(pos,'order_id'),linesByPo=group(lines,'po_id'),receiptsByPo=group(returns,'po_id');
 const orderItems=group(db.prepare(`SELECT i.* FROM order_items i JOIN orders o ON o.id=i.order_id WHERE 1=1${condition}`).all(...params),'order_id');
 const sizes=group(db.prepare(`SELECT s.*,i.order_id FROM order_item_sizes s JOIN order_items i ON i.id=s.item_id JOIN orders o ON o.id=i.order_id WHERE 1=1${condition}`).all(...params),'order_id');
 const allocations=group(db.prepare(`SELECT d.* FROM dispatch_orders d JOIN orders o ON o.id=d.order_id WHERE d.status<>'cancelled'${condition}`).all(...params),'order_id');
 const mats=group(db.prepare(`SELECT m.*,tp.order_id,tp.order_item_id,tp.version FROM tech_pack_materials m JOIN tech_packs tp ON tp.id=m.tech_pack_id WHERE tp.id IN (SELECT MAX(t.id) FROM tech_packs t JOIN orders o ON o.id=t.order_id WHERE 1=1${condition} GROUP BY t.order_id,COALESCE(t.order_item_id,0)) ORDER BY m.id`).all(...params),'order_id');
 const cards=[];
 function assemble(order,purchases,key){
  const id=order?.id,items=orderItems.get(id)||[],variants=sizes.get(id)||[],technical=mats.get(id)||[],pi=purchases.flatMap(p=>linesByPo.get(p.id)||[]),grn=purchases.flatMap(p=>receiptsByPo.get(p.id)||[]);
  const thumb=order?.image_url||items.find(i=>i.effect_image_url)?.effect_image_url||'';
  const materialRows=technical.map(m=>{const item=items.find(i=>i.id===m.order_item_id);let qty=item?.qty??(items.length===1?items[0].qty:null);const byColor=variants.filter(v=>(!item||v.item_id===item.id)&&v.color===m.colorway);if(byColor.length)qty=byColor.reduce((n,v)=>n+Number(v.qty),0);else if(m.colorway&&new Set(variants.map(v=>v.color)).size>1)qty=null;return {...m,key,order_no:order?.order_no||'',need_qty:qty!==null&&m.one_use>0?round(qty*m.one_use*(1+Number(m.loss_rate||0)/100)):null};});
  const stateFor=type=>{const found=pi.filter(l=>l.material_type===type);return found.length?procurementState(found):technical.some(m=>m.mat_type===type)?'pending':'unknown';};
  const fabricStatus=stateFor('fabric'),accessoryStatus=stateFor('accessory');
  let overall=procurementState(pi);if(overall==='received'&&[fabricStatus,accessoryStatus].includes('pending'))overall='ordering';
  cards.push({key,order_id:id||null,order_no:order?.order_no||'',customer_name:order?.customer_name||'',po_no:order?.cus_order_no||'',style_name:items.map(i=>i.style_no||i.product_name).filter(Boolean).join(' / ')||order?.style_name||'备货采购',thumb,type:order?.type||'stock',colors:[...new Set(variants.map(v=>v.color).filter(Boolean))].join(','),sizes:[...new Set(variants.map(v=>v.size).filter(Boolean))].join(','),factory_names:[...new Set((allocations.get(id)||[]).map(d=>d.factory_name).filter(Boolean))].join(' / '),buyer_names:[...new Set(purchases.map(p=>p.buyer_name).filter(Boolean))].join(' / '),created_at:purchases[0]?.created_at||order?.created_at,order_date:order?.order_date||purchases[0]?.order_date||'',order_remark:order?.remark||'',purchase_ids:purchases.map(p=>p.id),purchase_nos:purchases.map(p=>p.po_no).join(' / '),purchases,purchase_lines:pi.map(l=>({...l,key,order_no:order?.order_no||''})),material_rows:materialRows,receipts:grn.map(l=>({...l,key,order_no:order?.order_no||''})),status:overall,fabric_status:fabricStatus,accessory_status:accessoryStatus,audit_status:'not_required'});
 }
 orders.slice(0,5000).forEach(o=>assemble(o,poByOrder.get(o.id)||[],'order:'+o.id));
 pos.filter(p=>!p.order_id||!orderIds.has(p.order_id)).slice(0,5000).forEach(p=>assemble(null,[p],'purchase:'+p.id));
 return {cards,truncated:orders.length>5000||pos.length>5000,approval_enabled:false};
}
module.exports={workspace,procurementState};
