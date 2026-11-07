/** 预下单款式来源：图片新款进入开发，已完成样衣复用冻结版本，绝不改原样衣。 */
const {db,now}=require('../db'),scope=require('../access/companyScope');
const {styleImages}=require('./orderImages');
const bad=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function archiveRow(id){return db.prepare(`SELECT a.*,pf.id AS source_flow_id,pf.status AS flow_status,COALESCE(o.company_id,p.company_id) AS company_id
 FROM sample_archives a JOIN tech_packs tp ON tp.id=a.tech_pack_id JOIN pattern_flows pf ON pf.tech_pack_id=tp.id
 LEFT JOIN orders o ON o.id=tp.order_id LEFT JOIN pre_orders p ON p.id=tp.pre_order_id WHERE a.id=?`).get(id);}
function approvedArchive(user,id){
 if(!Number.isSafeInteger(id)||id<=0)bad('请选择有效的已打版商品');const a=archiveRow(id);
 if(!a||(!scope.isSingle()&&!a.company_id)||!scope.canSee(user,a))bad('已打版商品不存在或无权访问',404);
 if(a.status!=='locked'||a.flow_status!=='done')bad('只能选择已完成打版且锁定的样衣版本',409);
 const stages=require('../routes/patternFlows').STAGE_KEYS;
 if(Number(db.prepare("SELECT COUNT(*) AS n FROM pattern_stages WHERE flow_id=? AND status='done' AND stage IN ("+stages.map(()=>'?').join(',')+")").get(a.source_flow_id,...stages).n)!==stages.length)bad('该样衣打版阶段未完整完成',409);
 if(db.prepare("SELECT 1 FROM sample_archives WHERE tech_pack_id=? AND id>? LIMIT 1").get(a.tech_pack_id,a.id))bad('该商品已有更新版本，请重新选择',409);
 if(db.prepare("SELECT 1 FROM sample_change_requests WHERE archive_id=? AND status IN ('pending','approved') AND new_archive_id IS NULL LIMIT 1").get(a.id))bad('该样衣正在变更，暂不可选',409);
 let snap;try{snap=JSON.parse(a.snapshot);}catch{bad('样衣快照无效，请核对样衣档案',409);}if(!snap||typeof snap!=='object'||Array.isArray(snap))bad('样衣快照无效',409);
 return {...a,source_data:snap};
}
function available(user,q=''){
 const rows=db.prepare("SELECT id FROM sample_archives WHERE status='locked' ORDER BY id DESC").all(),result=[];
 for(const r of rows){try{const a=approvedArchive(user,r.id);if(q&&![a.archive_no,a.sample_name,a.style_no].some(s=>String(s||'').toLowerCase().includes(q.toLowerCase())))continue;result.push({id:a.id,archive_no:a.archive_no,product_name:a.sample_name||a.source_data.product_name||a.style_no,style_no:a.style_no||a.source_data.customer_style_no||'',version:a.version,image_url:a.image_url||null});}catch(e){if(![404,409].includes(e.status))throw e;}}
 return result;
}
/** 下单目录同款只保留最新有效归档，预单与正式单共用。 */
function availableDistinct(user,q=''){const seen=new Set();return available(user,q).filter(a=>{const k=String(a.style_no||'').trim().toLowerCase()||'archive:'+a.id;if(seen.has(k))return false;seen.add(k);return true;});}
function prepare(user,item,previous){
 const type=item.source_type||previous?.source_type||'new';if(!['new','archive','legacy'].includes(type)||type==='legacy'&&!previous)bad('请重新选择款式来源');
 if(previous){const used=db.prepare('SELECT 1 FROM tech_packs WHERE pre_order_item_id=? LIMIT 1').get(previous.id);if(used&&(type!==previous.source_type||type==='archive'&&Number(item.sample_archive_id)!==Number(previous.sample_archive_id)))bad('该款已有开发或复用记录，不能更换来源，请另增一款',409);}
 if(type==='archive'){
  const a=approvedArchive(user,Number(item.sample_archive_id));
  return {source_type:type,sample_archive_id:a.id,source_snapshot:(Number(previous?.sample_archive_id)===a.id&&previous?.source_snapshot)||JSON.stringify({archive_id:a.id,archive_no:a.archive_no,version:a.version,style_no:a.style_no,product_name:a.sample_name,image_url:a.image_url,snapshot:a.source_data}),product_name:a.sample_name||a.source_data.product_name||a.style_no||'',style_no:a.style_no||a.source_data.customer_style_no||'',...styleImages({...item,effect_image_url:a.image_url||item.effect_image_url})};
 }
 const images=styleImages(item),name=String(item.product_name||previous?.product_name||'').trim()||(type==='new'?'新款-'+require('crypto').randomUUID().replace(/-/g,'').slice(0,12).toUpperCase():'');
 if(!String(item.product_name||previous?.product_name||'').trim()&&!images.effect_image_url&&!images.detail_images.length)bad('新款请上传图片或填写款式名称');
 const style=String(item.style_no||'').trim();if(type==='new'&&style!==(previous?.style_no||''))bad('新款款号由版房在开发打版时填写，业务不能修改');
 return {source_type:type,sample_archive_id:null,source_snapshot:null,product_name:name,style_no:style,...images};
}
/** 仅复制后端允许的表列；来源是样衣冻结快照，不读取被后续修改的实时物料。 */
function copyRows(table,tpId,rows){
 const columns=db.prepare('PRAGMA table_info('+table+')').all().map(r=>r.name).filter(k=>!['id','tech_pack_id'].includes(k));
 for(const row of Array.isArray(rows)?rows:[]){const keys=columns.filter(k=>Object.hasOwn(row,k));if(!keys.length)bad('样衣明细没有有效字段，不能复用',409);db.prepare('INSERT INTO '+table+'(tech_pack_id,'+keys.join(',')+') VALUES (?,'+keys.map(()=>'?').join(',')+')').run(tpId,...keys.map(k=>row[k]));}
}
/** 在调用方预下单事务内执行，失败与预下单一起回滚。 */
function ensureDevelopment(pre,item,user,reuse=false){
 const details=Array.isArray(item.detail_images)?item.detail_images:require('./orderImages').readImages(item.detail_images);
 const referenceImages=[item.effect_image_url,...details].filter(Boolean),primaryImage=referenceImages[0]||null;
 const syncReferences=flowId=>{
  const stage=db.prepare("SELECT data FROM pattern_stages WHERE flow_id=? AND stage='material'").get(flowId);let data={};try{data=JSON.parse(stage?.data||'{}');}catch{}
  const ownImages=(Array.isArray(data.images)?data.images:[]).filter(url=>!(data.pre_order_reference_images||[]).includes(url));
  db.prepare("UPDATE pattern_stages SET data=? WHERE flow_id=? AND stage='material'").run(JSON.stringify({...data,images:[...new Set([...referenceImages,...ownImages])],pre_order_reference_images:referenceImages}),flowId);
 };
 if(item.source_type==='legacy'||item.source_type==='archive'&&!reuse)return null;
 const existing=db.prepare('SELECT * FROM tech_packs WHERE pre_order_item_id=? ORDER BY id DESC LIMIT 1').get(item.id);if(existing){
  const f=db.prepare('SELECT * FROM pattern_flows WHERE tech_pack_id=?').get(existing.id);
  if(!existing.source_archive_id&&f?.status==='running'&&f.current_stage==='material'&&!db.prepare("SELECT 1 FROM pattern_stages WHERE flow_id=? AND status='done'").get(f.id)){db.prepare('UPDATE tech_packs SET product_name=?,image_url=?,customer_req=?,updated_at=? WHERE id=?').run(item.product_name||existing.product_name,primaryImage,pre.requirements||'',now(),existing.id);syncReferences(f.id);}
  return existing;
 }
 const a=item.source_type==='archive'?approvedArchive(user,item.sample_archive_id):null,snap=a?.source_data||{},t=now();
 const name=item.product_name||item.style_no||'图片新款 · '+pre.pre_order_no+' / '+(item.sort+1);
 const tpId=Number(db.prepare(`INSERT INTO tech_packs(order_id,pre_order_id,pre_order_item_id,source_archive_id,product_name,customer_style_no,version,status,stage,image_url,customer_req,fabric_info,accessory_info,craft_info,size_spec,created_by,created_at,updated_at,remark)
 VALUES(0,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?, ?,?)`).run(pre.id,item.id,a?.id||null,name,item.style_no||null,a?.version||'V1',a?'confirmed':'material',primaryImage,pre.requirements||'',snap.fabric_info||'',snap.accessory_info||'',snap.craft_info||'',snap.size_spec||'',user.sub,t,t,a?'复用已完成样衣 '+a.archive_no+' '+a.version:'由预下单图片新款发起开发').lastInsertRowid);
 if(a&&snap.outsource_json)db.prepare('UPDATE tech_packs SET outsource_json=? WHERE id=?').run(snap.outsource_json,tpId);
 const flow=require('../routes/patternFlows').ensureFlow(tpId,user.sub);
 // 来自预下单的公共资料只写入新开发单，不能回写来源样衣或已推进的技术记录。
 db.prepare('UPDATE tech_packs SET designer=?,category=?,series=?,wave=?,sales_owner=?,po_no=? WHERE id=?').run(pre.designer||snap.designer||'',pre.category||snap.category||'',pre.series||snap.series||'',pre.wave||snap.wave||'',pre.manager||snap.sales_owner||'',pre.po_no||snap.po_no||'',tpId);
 if(!a)syncReferences(flow.id);
 if(a){
  copyRows('tech_pack_materials',tpId,snap.materials);copyRows('tech_pack_sizes',tpId,snap.sizes);copyRows('tech_pack_requirements',tpId,snap.requirements);
  for(const old of db.prepare('SELECT * FROM pattern_stages WHERE flow_id=?').all(a.source_flow_id)){
   let data={};try{data=JSON.parse(old.data||'{}');}catch{}
   if(old.stage==='craft')data={...data,sewing:snap.processes?.sewing||[],finish:snap.processes?.finish||[]};
   db.prepare("UPDATE pattern_stages SET status='done',owner=?,pattern_size=?,data=?,remark=?,operator=?,started_at=?,finished_at=?,updated_at=? WHERE flow_id=? AND stage=?").run(old.owner,old.pattern_size,JSON.stringify({...data,reused_archive_id:a.id}), '继承已完成样衣 '+a.archive_no,user.username,t,t,t,flow.id,old.stage);
  }
  if(db.prepare("SELECT 1 FROM pattern_stages WHERE flow_id=? AND status<>'done'").get(flow.id))bad('原样衣打版阶段记录不完整，不可复用',409);
  db.prepare("UPDATE pattern_flows SET status='done',current_stage='done',finished_at=? WHERE id=?").run(t,flow.id);
  require('./sampleArchive').archiveFromFlow({...flow,status:'done'},user.username,{remark:'复用来源 '+a.archive_no+' '+a.version});
 }
 return db.prepare('SELECT * FROM tech_packs WHERE id=?').get(tpId);
}
/** 单号只允许版房阶段变更；同事务回写来源并留事件，转单后也衔接当前订单款式。 */
function assignStyleNumber(tp,value,expected,user){
 const code=String(value??'').trim();if(!code||code.length>100)bad('款号必填且最多100字');
 if(tp.customer_style_no===code)return;
 if(expected!==tp.updated_at)bad('款号资料已更新，请刷新打版看板后重试',409);
 if(tp.pre_order_id){const scoped=scope.assertRow(user,'pre_orders',tp.pre_order_id,'预下单');if(!scoped.ok)bad(scoped.reason,scoped.status);}
 if(db.prepare("SELECT 1 FROM pattern_stages ps JOIN pattern_flows pf ON pf.id=ps.flow_id WHERE pf.tech_pack_id=? AND ps.stage='pattern' AND ps.status='done'").get(tp.id))bad('制版阶段已完成，请退回重做后修改款号',409);
 if(tp.source_archive_id)bad('复用样衣款号已锁定，如需改版请走样衣变更流程',409);
 const t=now();db.prepare('UPDATE tech_packs SET customer_style_no=?,updated_at=? WHERE id=?').run(code,t,tp.id);
 if(tp.pre_order_item_id){
  db.prepare('UPDATE pre_order_items SET style_no=? WHERE id=?').run(code,tp.pre_order_item_id);
  const names=db.prepare('SELECT product_name,style_no FROM pre_order_items WHERE pre_order_id=? ORDER BY sort,id').all(tp.pre_order_id).map((i,n)=>i.product_name||i.style_no||'图片新款 '+(n+1)).join(' / ');
  db.prepare('UPDATE pre_orders SET style_name=?,updated_at=?,version=version+1 WHERE id=?').run(names,t,tp.pre_order_id);
  const p=db.prepare('SELECT version FROM pre_orders WHERE id=?').get(tp.pre_order_id);
  db.prepare('INSERT INTO pre_order_events(pre_order_id,action,version,operator,details,created_at) VALUES(?,?,?,?,?,?)').run(tp.pre_order_id,'style_number_assigned',p.version,user.name||user.username,JSON.stringify({item_id:tp.pre_order_item_id,before:tp.customer_style_no||'',after:code,tech_pack_id:tp.id}),t);
  for(const it of db.prepare('SELECT i.id,o.status FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.source_pre_order_item_id=?').all(tp.pre_order_item_id)){
   if(!['draft','tech'].includes(it.status))bad('正式订单已进入后续环节，款号修改需走订单变更',409);
   db.prepare('UPDATE order_items SET style_no=? WHERE id=?').run(code,it.id);
  }
 }
}
function reuseArchives(preId,user){const pre=db.prepare('SELECT * FROM pre_orders WHERE id=?').get(preId);for(const item of db.prepare("SELECT * FROM pre_order_items WHERE pre_order_id=? AND source_type='archive'").all(preId))ensureDevelopment(pre,item,user,true);}
module.exports={availableDistinct,available,approvedArchive,prepare,ensureDevelopment,assignStyleNumber,reuseArchives};
