/** 排版采购需求米数：与销售预估用量分开，带版本比较及完整修改记录。 */
const {db,now}=require('../db');
const bad=(m,s=400)=>Object.assign(new Error(m),{status:s});
function rows(orderId){return db.prepare(`SELECT m.*,i.style_no,i.product_name FROM order_materials m LEFT JOIN order_items i ON i.id=m.item_id WHERE m.order_id=? ORDER BY m.id`).all(orderId).map(m=>({...m,colors:db.prepare('SELECT colorway,color_no FROM order_material_colors WHERE order_material_id=? ORDER BY id').all(m.id)}));}
function save(orderId,body,user){
 if(!Array.isArray(body.rows)||!body.rows.length||body.rows.length>1000)throw bad('请提交1至1000条面料米数');
 const seen=new Set(),updates=body.rows.map(b=>{const m=db.prepare("SELECT * FROM order_materials WHERE id=? AND order_id=? AND type='fabric'").get(Number(b.id),orderId);if(!m||seen.has(m.id))throw bad('面料不存在或重复');seen.add(m.id);if(!['米','m','M'].includes(m.unit))throw bad(m.name+'的单位不是米，请先核对物料');if(b.meters!==null&&(typeof b.meters!=='number'||!Number.isFinite(b.meters)||b.meters<0||b.meters>10000000||Math.abs(b.meters*1000-Math.round(b.meters*1000))>0.00001))throw bad('米数须为0至10000000，最多三位小数');if(!Number.isSafeInteger(b.version)||b.version!==m.layout_version)throw bad('数据已更新，请刷新后重试',409);return {m,b};});
 const t=now();db.exec('BEGIN');try{for(const {m,b} of updates){let history=JSON.parse(m.layout_history||'[]');history.push({before:m.layout_m,after:b.meters,by:user.username||String(user.sub),at:t,version:m.layout_version+1});const r=db.prepare('UPDATE order_materials SET layout_m=?,layout_by=?,layout_at=?,layout_version=layout_version+1,layout_history=? WHERE id=? AND layout_version=?').run(b.meters,user.username||String(user.sub),t,JSON.stringify(history),m.id,b.version);if(!r.changes)throw bad('数据已更新，请刷新后重试',409);}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return rows(orderId);
}
function exportRows(numbers,user){
 if(typeof numbers!=='string'||numbers.length>10000)throw bad('请输入订单号');const tokens=[...new Set(numbers.split(/[\s,，;；]+/).filter(Boolean))];if(!tokens.length||tokens.length>100||tokens.some(n=>n.length>100))throw bad('请选择1至100个订单号');
 const scope=require('../access/companyScope'),out=[];
 for(const no of tokens){const orders=db.prepare('SELECT * FROM orders WHERE order_no=? OR cus_order_no=? ORDER BY id').all(no,no).filter(o=>scope.canSee(user,o));if(!orders.length)throw bad('订单不存在或无权访问：'+no,404);for(const o of orders){if(out.some(x=>x.order_id===o.id))continue;const ms=rows(o.id);if(!ms.length)out.push({order_id:o.id,order_no:o.order_no,supplier:'未指定供应商',name:'未填写订单物料'});else for(const m of ms)out.push({...m,order_no:o.order_no,po_no:o.cus_order_no,supplier:m.supplier||'未指定供应商'});}}
 return out.sort((a,b)=>a.supplier.localeCompare(b.supplier,'zh-CN')||a.order_no.localeCompare(b.order_no)||Number(a.item_id||0)-Number(b.item_id||0));
}
function csv(numbers,user){const headers=['供应商','订单号','客户订单号','款号','款式名称','物料类型','物料名称','颜色/色号','单位','排版采购需求米数','米数填写人','米数填写时间','米数版本','技术预估总用量','备注'];const data=exportRows(numbers,user).map(m=>[m.supplier,m.order_no,m.po_no,m.style_no||(!m.item_id?'订单通用':''),m.product_name,m.type==='fabric'?'面料':m.type==='accessory'?'辅料':'',m.name,(m.colors||[]).map(c=>c.colorway+'/'+(c.color_no||'')).join('；'),m.unit,m.type==='fabric'?(m.layout_m??'未填写'):'不适用',m.layout_by,m.layout_at,m.layout_version,m.total_use,m.remark]);
 // Excel公式注入防护：业务文本永远按文字导出。
 const safe=v=>typeof v==='string'&&/^[\s]*[=+@-]/.test(v)?"'"+v:v;
 return require('../utils/csv').toCsv([headers,...data.map(r=>r.map(safe))]);}
module.exports={rows,save,exportRows,csv};
