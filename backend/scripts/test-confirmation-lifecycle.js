/** 真 HTTP + 独立空库回归；不借用真实业务夹具，不连接 3000 或现场库。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {spawn}=require('child_process');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-confirm-'));
process.env.DB_PATH=path.join(directory,'__SMOKE-confirm.db');
process.env.PORT=String(34000+Math.floor(Math.random()*10000));
process.env.ERP_SCHEDULER='0';process.env.SINGLE_COMPANY='0';
require('dotenv').config();
const {db,now}=require('../src/db');
const lifecycle=require('../src/services/confirmation');
let server,token,customerToken,checks=0;
const insert=(table,row)=>{const keys=Object.keys(row);return Number(db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k])).lastInsertRowid);};
const get=(table,id)=>db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
const check=(value,message)=>{assert.ok(value,message);checks++;};
async function api(route,body,status=200,customer=false,method) {
 const response=await fetch(`http://127.0.0.1:${process.env.PORT}`+route,{method:method || (body?'POST':'GET'),headers:{'Content-Type':'application/json',Authorization:'Bearer '+(customer?customerToken:token)},body:body?JSON.stringify(body):undefined});
 const json=await response.json();assert.equal(response.status,status,route+': '+JSON.stringify(json));checks++;
 return json.data ?? json;
}
async function approveAll(row) {
 let result=await api(`/api/confirm/changes/${row.id}/approve`,{row_version:row.row_version});
 check(result.status==='assessing','Submitting does not bypass internal approval');
 for(const task of result.approval.tasks) await api(`/api/approvals/tasks/${task.id}/act`,{approve:true,remark:'__SMOKE 审核'});
 return get('order_changes',row.id);
}
async function confirmedChange(orderId,type,patch) {
 let row=await api('/api/confirm/changes',{order_id:orderId,type,patch,title:'__SMOKE '+type,assess_note:'__SMOKE 已评估数量金额与执行范围'});
 row=await approveAll(row);
 await api(`/api/mall/changes/${row.id}/confirm`,{accepted:true,row_version:row.row_version},200,true);
 return get('order_changes',row.id);
}
(async()=>{
 const t=now(),cid=insert('customers',{name:'__SMOKE 客户',status:'active',created_at:t,updated_at:t});
 const account=insert('customer_accounts',{customer_id:cid,username:'__SMOKE-customer',password_hash:'unused',role:'owner',status:'active',created_at:t});
 customerToken=require('../src/middleware/customerAuth').signCustomerToken(get('customer_accounts',account));
 const oid=insert('orders',{order_no:'__SMOKE-001',customer_id:cid,type:'custom',status:'draft',rate:6.5,total_usd:20,total_amount:130,created_at:t,updated_at:t,delivery_date:'2026-12-01'});
 const item1=insert('order_items',{order_id:oid,product_name:'__SMOKE A',style_no:'A',qty:10,amount_usd:10,amount_cny:65});
 const item2=insert('order_items',{order_id:oid,product_name:'__SMOKE B',style_no:'B',qty:10,amount_usd:10,amount_cny:65});
 const size1=insert('order_item_sizes',{item_id:item1,size:'M',color:'黑',qty:10,usd_price:1,cny_price:6.5,amount_usd:10,amount_cny:65});
 insert('order_item_sizes',{item_id:item2,size:'M',color:'白',qty:10,usd_price:1,cny_price:6.5,amount_usd:10,amount_cny:65});
 const craft=insert('order_crafts',{order_id:oid,name:'__SMOKE 工艺',instruction:'旧工艺',created_at:t});
 const material=insert('order_materials',{order_id:oid,name:'__SMOKE 物料',type:'fabric',ingredient:'旧成分',spec:'160cm',created_at:t});
 server=spawn(process.execPath,['src/server.js'],{cwd:path.resolve(__dirname,'..'),env:process.env,windowsHide:true,stdio:'ignore'});
 let ready=false;for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));try{if((await fetch(`http://127.0.0.1:${process.env.PORT}/api/health`)).ok){ready=true;break;}}catch{}}
 check(ready,'Isolated server started');
 const auth=await api('/api/auth/login',{username:'admin',password:process.env.ADMIN_PASSWORD || 'admin123456'});token=auth.token;
 check(!!token,'Admin login');check(!lifecycle.sealGate(oid).ok,'Custom multi-style requires all seals');
 await api('/api/confirm/seals',{order_id:oid},400);
 let seals=[];
 for(const itemId of [item1,item2]) {
  let row=await api('/api/confirm/seals',{order_id:oid,order_item_id:itemId,sample_name:'__SMOKE 封样'});
  row=await api(`/api/confirm/seals/${row.id}/tech-approve`,{row_version:row.row_version});
  row=await api(`/api/confirm/seals/${row.id}/send`,{row_version:row.row_version});
  await api(`/api/mall/seals/${row.id}/confirm`,{accepted:true,row_version:row.row_version},200,true);seals.push(row);
  if(itemId===item1)check(!lifecycle.sealGate(oid).ok,'First style does not release second');
 }
 check(lifecycle.sealGate(oid).ok,'Both styles confirmed');
 const next=await api('/api/confirm/seals',{order_id:oid,order_item_id:item1});
 check(get('sample_seals',seals[1].id).status==='confirmed','New A version does not supersede B');
 check(!lifecycle.sealGate(oid).ok,'New A version blocks order again');
 db.prepare('UPDATE order_items SET remark=? WHERE id=?').run('__SMOKE changed source',item1);
 await api(`/api/confirm/seals/${next.id}/tech-approve`,{row_version:next.row_version},409);
 let row=await confirmedChange(oid,'craft',{row_id:craft,instruction:'新工艺'});
 check(get('order_crafts',craft).instruction==='旧工艺','Customer acceptance alone does not apply');
 await api(`/api/confirm/changes/${row.id}/sign`,{row_version:row.row_version});
 check(get('order_crafts',craft).instruction==='新工艺','Sign applies real craft data');
 check(!!get('order_changes',row.id).applied_snapshot,'Application snapshot retained');
 await api(`/api/confirm/changes/${row.id}/sign`,{row_version:row.row_version},409);
 row=await confirmedChange(oid,'material',{row_id:material,ingredient:'新成分',mat_color:'蓝'});
 await api(`/api/confirm/changes/${row.id}/sign`,{row_version:row.row_version});
 check(get('order_materials',material).ingredient==='新成分' && get('order_materials',material).spec==='160cm','Material change keeps locked specification');
 row=await confirmedChange(oid,'qty',{row_id:size1,qty:12});
 await api(`/api/confirm/changes/${row.id}/sign`,{row_version:row.row_version});
 check(get('order_items',item1).qty===12 && get('orders',oid).total_usd===22,'Quantity updates matrix and totals');
 row=await confirmedChange(oid,'price',{row_id:size1,usd_price:2});
 await api(`/api/confirm/changes/${row.id}/sign`,{row_version:row.row_version});
 check(get('orders',oid).total_usd===34 && get('orders',oid).total_amount===221,'Price updates currency totals');
 row=await confirmedChange(oid,'delivery',{new_date:'2026-12-08'});
 await api(`/api/confirm/changes/${row.id}/sign`,{row_version:row.row_version});
 check(get('orders',oid).delivery_date==='2026-12-01' && get('orders',oid).latest_delivery_date==='2026-12-08','Delivery retains original commitment');
 // A competing edit makes final approval fail. The current task must remain pending.
 row=await api('/api/confirm/changes',{order_id:oid,type:'craft',patch:{row_id:craft,instruction:'另一个工艺'},title:'__SMOKE 冲突',assess_note:'__SMOKE 评估'});
 row=await api(`/api/confirm/changes/${row.id}/approve`,{row_version:row.row_version});
 const tasks=row.approval.tasks;for(const task of tasks.slice(0,-1))await api(`/api/approvals/tasks/${task.id}/act`,{approve:true});
 db.prepare('UPDATE order_crafts SET remark=? WHERE id=?').run('__SMOKE competing edit',craft);
 await api(`/api/approvals/tasks/${tasks.at(-1).id}/act`,{approve:true},409);
 check(get('approval_tasks',tasks.at(-1).id).status==='pending','Failed business hook rolls back approval task');
 // Explicit development source link reconnects pre-order -> formal order -> sample archive.
 const pre=insert('pre_orders',{pre_order_no:'__SMOKE-PRE',customer_name:'__SMOKE 客户',created_at:t,updated_at:t});
 const pi=insert('pre_order_items',{pre_order_id:pre,product_name:'__SMOKE A'});
 db.prepare('UPDATE orders SET source_pre_order_id=? WHERE id=?').run(pre,oid);
 db.prepare('UPDATE order_items SET source_pre_order_item_id=? WHERE id=?').run(pi,item1);
 const tp=insert('tech_packs',{order_id:0,pre_order_id:pre,pre_order_item_id:pi,product_name:'__SMOKE A',created_at:t,updated_at:t});
 const flow=insert('pattern_flows',{tech_pack_id:tp,status:'done',started_at:t});
 const archive=require('../src/services/sampleArchive').archiveFromFlow(get('pattern_flows',flow),'__SMOKE');
 await api(`/api/confirm/sources/${oid}/link`,{order_item_id:item1,tech_pack_id:tp});
 check(get('tech_packs',tp).order_item_id===item1 && get('sample_archives',archive.id).order_id===oid,'Development archive source linked');
 const snap=get('sample_archives',archive.id).snapshot;
 const seal=await api('/api/confirm/seals',{order_id:oid,order_item_id:item1,archive_id:archive.id});
 check(JSON.parse(seal.snapshot_json).archive.snapshot===snap,'Seal freezes sample archive snapshot');
 await api('/api/confirm/seals',{order_id:oid,order_item_id:item2,archive_id:archive.id},400);
 // A newer sample archive invalidates the old seal without editing its historical snapshot.
 const archive2=require('../src/services/sampleArchive').archiveFromFlow(get('pattern_flows',flow),'__SMOKE');
 check(!lifecycle.sealGate(oid).ok,'New sample version invalidates old seal');
 check(get('sample_archives',archive.id).snapshot===snap,'Old sample snapshot unchanged');
 await api('/api/confirm/seals',{order_id:oid,order_item_id:item1,archive_id:archive.id},409);
 check(archive2.id!==archive.id,'New sample gets separate identity');
 const standalone=await api('/api/confirm/deliveries',{order_id:oid,new_date:'2026-12-09',kind:'etd'});
 await api(`/api/confirm/deliveries/${standalone.id}/confirm`,{accepted:true});
 check(get('orders',oid).latest_delivery_date==='2026-12-09' && get('orders',oid).delivery_date==='2026-12-01','Standalone delivery uses same safe writeback');
 await api(`/api/confirm/deliveries/${standalone.id}/confirm`,{accepted:true},409);
 // Replacement comes from the material master; its locked spec is copied only to this order.
 const master=insert('materials',{type:'fabric',name:'__SMOKE replacement',spec:'180cm',unit:'米',status:'active',created_at:t,updated_at:t});
 row=await confirmedChange(oid,'material',{row_id:material,material_id:master});
 await api(`/api/confirm/changes/${row.id}/sign`,{row_version:row.row_version});
 check(get('order_materials',material).material_id===master && get('order_materials',material).spec==='180cm','Replacement uses master specification');
 check(get('materials',master).spec==='180cm','Master not overwritten by order');
 // Multi-subject lookup/gate/statistics must not expose this company's records.
 const other=insert('users',{username:'__SMOKE-other',password_hash:'unused',name:'__SMOKE other',role:'sales',active:1,company_id:2,created_at:t});
 const adminToken=token;token=require('jsonwebtoken').sign({sub:other,tv:0},require('../src/config').jwtSecret);
 await api(`/api/confirm/seals/gate/${oid}`,undefined,404);
 await api(`/api/confirm/sources/${oid}`,undefined,404);
 const hidden=await api('/api/confirm/changes');check(!hidden.some(r=>r.order_id===oid),'Changes list scoped');
 const stats=await api('/api/confirm/stats');check(stats.changes.effective===0,'Aggregates scoped');token=adminToken;
 // Saving a pre-order keeps referenced style IDs; deleting such a style rolls the parent back.
 const po=await api('/api/pre-orders',{order_no:'__SMOKE-PRESERVE',customer_name:'__SMOKE 客户',items:[{product_name:'__SMOKE linked style'}]});
 const preStyle=po.items[0];check(!!db.prepare('SELECT id FROM tech_packs WHERE pre_order_item_id=?').get(preStyle.id),'New pre-order creates development source automatically');
 const edited=await api(`/api/pre-orders/${po.id}`,{...po,requirements:'__SMOKE edited'},200,false,'PUT');
 check(edited.items[0].id===preStyle.id,'Pre-order edits preserve development identity');
 await api(`/api/pre-orders/${po.id}`,{...edited,items:[{product_name:'__SMOKE replacement row'}]},409,false,'PUT');
 check(get('pre_orders',po.id).version===edited.version,'Failed removal rolls back parent version');
 const multi=await api('/api/pre-orders',{order_no:'__SMOKE-AUTO-LINK',customer_id:cid,customer_name:'__SMOKE 客户',items:[{product_name:'__SMOKE C'},{product_name:'__SMOKE D'}]});
 await api('/api/material-development',{pre_order_id:multi.id,material_type:'fabric',material_name:'__SMOKE 寻样',customer_requirements:'__SMOKE 手感'},400);
 const request=await api('/api/material-development',{pre_order_id:multi.id,pre_order_item_id:multi.items[0].id,material_type:'fabric',material_name:'__SMOKE 寻样',customer_requirements:'__SMOKE 手感'});
 check(request.pre_order_item_id===multi.items[0].id && request.style_name==='__SMOKE C','Sourcing is per style');
 const searching=await api(`/api/material-development/${request.id}/start-search`,{});
 const round=searching.rounds[0];
 await api(`/api/material-development/rounds/${round.id}/return`,{candidate_name:'__SMOKE 新品候选',candidate_spec:'220g',candidate_color:'蓝'});
 await api(`/api/material-development/rounds/${round.id}/approve`,{add_to_material_archive:false});
 const reviewed=await api(`/api/material-development/${request.id}/pattern-review`,{approve:true,note:'__SMOKE 准入通过'});
 const autoTp=reviewed.tech_pack_id;
 check(get('tech_packs',autoTp).pre_order_item_id===multi.items[0].id,'Reviewed sourcing retains style identity');
 const reviewedMaterial=db.prepare('SELECT * FROM tech_pack_materials WHERE tech_pack_id=?').get(autoTp);
 check(reviewedMaterial.spec_info==='220g' && !reviewedMaterial.material_id,'Approved candidate can enter development without polluting master');
 const prepared=await api(`/api/pre-orders/${multi.id}/complete`,{version:multi.version});
 const order=await api('/api/orders',{order_no:multi.order_no,customer_id:cid,type:'custom',source_pre_order_id:multi.id,source_pre_order_version:prepared.version,items:multi.items.map(i=>({product_name:i.product_name,style_no:i.style_no,source_pre_order_item_id:i.id,colors:[{color:'黑',sizes:[{size:'M',qty:1,usd_price:1}]}]}))});
 check(get('tech_packs',autoTp).order_id===order.id && get('tech_packs',autoTp).order_item_id===order.items[0].id,'Formal order creation auto-links exact development style');
 // Failed archive creation must not leave a flow marked done.
 const broken=insert('pattern_flows',{tech_pack_id:999999,status:'running',started_at:t});
 for(const stage of ['material','pattern','craft','sample','biz','audit'])insert('pattern_stages',{flow_id:broken,stage,status:'done',updated_at:t});
 await api(`/api/pattern-flows/${broken}/finish`,{},500);
 check(get('pattern_flows',broken).status==='running','Failed sample archive rolls back workflow finish');
 console.log(`PASS: ${checks} lifecycle assertions; isolated database only.`);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{
 if(server){server.kill();await new Promise(r=>server.once('exit',r));}db.close();
 // Only the exact directory created above is removed, never a configured business DB.
 fs.rmSync(directory,{recursive:true,force:true});
});
