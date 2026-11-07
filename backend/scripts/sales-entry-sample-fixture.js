/** 仅供独立 __SMOKE 库使用：完整六阶段完成的冻结样衣。 */
module.exports=function(db,t,options={}){
 const style=options.style||'__SMOKE-STYLE-01',archiveNo=options.archiveNo||'__SMOKE-SAMPLE';
 const pack=Number(db.prepare("INSERT INTO tech_packs(order_id,product_name,customer_style_no,status,created_at,updated_at) VALUES(0,'__SMOKE商品',?,'confirmed',?,?)").run(style,t,t).lastInsertRowid);
 const flow=Number(db.prepare("INSERT INTO pattern_flows(tech_pack_id,status,started_at,finished_at) VALUES(?,'done',?,?)").run(pack,t,t).lastInsertRowid);
 for(const stage of ['material','pattern','craft','sample','biz','audit'])db.prepare("INSERT INTO pattern_stages(flow_id,stage,status,finished_at) VALUES(?,?,'done',?)").run(flow,stage,t);
 return Number(db.prepare("INSERT INTO sample_archives(archive_no,tech_pack_id,sample_name,style_no,version,status,snapshot,created_at) VALUES(?,?,'__SMOKE商品',?,'V1','locked',?,?)").run(archiveNo,pack,style,JSON.stringify({price:26}),t).lastInsertRowid);
};
