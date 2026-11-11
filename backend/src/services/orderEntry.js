/** 完整下单协议 v1。校验在订单 BEGIN 前完成；apply 只在调用方事务内写入。 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, now } = require('../db');
const scope = require('../access/companyScope');
const { archiveInput } = require('./orderMaterialInput');
const materials = require('./orderMaterialColors');
const bad = (message, status=400) => Object.assign(new Error(message), {status});
const money = n => Math.round((n + Number.EPSILON)*100)/100;
function number(v, label, max=1e9) { const n=Number(v ?? 0); if(!Number.isFinite(n)||n<0||n>max)throw bad(label+'无效'); return n; }
function text(v,label,max=255) { if(v!=null&&typeof v!=='string')throw bad(label+'格式无效');const s=String(v??'').trim();if(s.length>max)throw bad(label+'过长');return s; }
function list(v,label,max) { if(!Array.isArray(v)||v.length>max)throw bad(label+'格式或数量无效');return v; }
function json(v) { return JSON.stringify(v); }
/** 创建与草稿明细二次编辑共用结算口径，避免编辑数量后丢失税费/优惠/定金。 */
function settlement(goods,tax,values) {
  number(goods,'商品金额',1e12);number(tax,'税费',1e12);
  const freight=number(values.freight_usd??values.freight,'运费'),discount=number(values.discount_usd??values.discount,'优惠金额'),surcharge=number(values.surcharge_usd??values.surcharge,'附加金额'),deposit=number(values.deposit_usd??values.deposit,'约定定金');
  const total=money(goods+tax+freight+surcharge-discount);if(total<0)throw bad('优惠金额超过应付金额');if(deposit>total)throw bad('定金不能超过订单金额');
  return {version:1,tags:values.tags||[],goods_usd:goods,tax_usd:tax,freight_usd:freight,discount_usd:discount,surcharge_usd:surcharge,deposit_usd:deposit,total_usd:total,balance_usd:money(total-deposit)};
}
function reprice(order,items){if(!order.entry_json)return null;const saved=JSON.parse(order.entry_json);return settlement(money(items.reduce((s,i)=>s+i.amount_usd,0)),money(items.reduce((s,i)=>s+money(i.amount_usd*Number(JSON.parse(i.entry_json||'{}').tax_rate||0)/100),0)),saved);}
function image(v) {const s=text(v,'图片地址',400);if(s&&!/^\/uploads\/[\w./-]+\.(png|jpe?g|webp|gif)$/i.test(s))throw bad('请使用系统上传的图片');return s;}
function company(user) { return scope.writeCompanyOf(user); }
function key(b) { const k=text(b.scope_key||'new','草稿标识',80);if(!/^(new|pre:\d+)$/.test(k))throw bad('草稿标识无效');return k; }
function draft(user,b={}) { return db.prepare('SELECT * FROM order_entry_drafts WHERE user_id=? AND company_id=? AND scope_key=?').get(user.sub,company(user),key(b)); }
function readDraft(user,b) {const row=draft(user,b);return {version:row?.version||0,payload:row?.status==='draft'?JSON.parse(row.payload_json):null};}
function saveDraft(user,b) {
  const payload=json(b.payload);if(!payload||payload.length>900000)throw bad('草稿内容过大');
  const doc=text(b.payload?.request_no,'请求编号',80);if(!/^[\w-]{16,80}$/.test(doc))throw bad('缺少草稿请求编号');
  const row=draft(user,b), version=Number(b.version);if(!Number.isSafeInteger(version)||version!==(row?.version||0))throw bad('草稿已在另一窗口修改，请重新打开后继续',409);
  const t=now();
  if(row){const r=db.prepare("UPDATE order_entry_drafts SET status='draft',document_no=?,payload_json=?,request_hash=NULL,order_id=NULL,version=version+1,updated_at=? WHERE id=? AND version=?").run(doc,payload,t,row.id,version);if(!r.changes)throw bad('草稿保存冲突',409);}
  else db.prepare('INSERT INTO order_entry_drafts(user_id,company_id,scope_key,document_no,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(user.sub,company(user),key(b),doc,payload,t,t);
  return readDraft(user,b);
}
/** 重试返回原订单，避免网络超时后生成第二张单；摘要不包含仅用于 CAS 的草稿版本。 */
function request(b,user) {
  if(b.entry_version!==1)return null;
  const doc=text(b.request_no,'请求编号',80);if(!/^[\w-]{16,80}$/.test(doc))throw bad('请求编号无效，请重新打开下单');
  const body={...b};delete body.draft_version;const hash=crypto.createHash('sha256').update(json(body)).digest('hex');
  const row=draft(user,b);
  if(row?.status==='submitted'&&row.document_no===doc){if(row.request_hash!==hash)throw bad('此请求已保存，请打开订单编辑，不可重复创建',409);return {orderId:row.order_id};}
  if(Number(b.draft_version)!==(row?.version||0))throw bad('草稿版本已变化，请重新打开后保存',409);
  return {doc,hash,version:row?.version||0,scope:key(b)};
}
function prepare(b,prepared,user) {
  if(b.entry_version!==1)return null;
  for(const k of ['manager','style_name','cus_order_no','shop_name','shop_order_no','delivery_method','packaging','trade_terms'])text(b[k],k,255);
  text(b.remark,'备注',2000);
  if(!b.customer_id)throw bad('请选择客户');
  ['shop_name','shop_order_no'].forEach(k=>{if(!text(b[k],k==='shop_name'?'店铺名称':'店铺订单编号'))throw bad(k==='shop_name'?'请填写店铺名称':'请填写店铺订单编号');});
  const tags=list(b.tags||[],'标签',20).map(v=>text(v,'标签',50)).filter(Boolean);if(!tags.length)throw bad('请填写至少一个标签');
  const days=number(b.delivery_days,'交货天数',3650);if(!Number.isInteger(days)||days<1)throw bad('请选择交货天数');
  for(const k of ['order_date','delivery_date'])if(b[k]&&!/^\d{4}-\d{2}-\d{2}$/.test(b[k]))throw bad('日期格式无效');
  let tax=0;
  // 按后端确认的样衣款号去重，不能信任前端传入的款号或归档ID。
  const selectedArchives=new Set(),selectedStyles=new Set();
  const entries=list(b.items,'款式',100).map((it,i)=>{
    let archiveId=Number(it.sample_archive_id);
    if(!archiveId&&it.source_pre_order_item_id){const tp=db.prepare('SELECT id FROM tech_packs WHERE pre_order_item_id=?').get(it.source_pre_order_item_id);archiveId=tp?db.prepare("SELECT id FROM sample_archives WHERE tech_pack_id=? AND status='locked' ORDER BY id DESC LIMIT 1").get(tp.id)?.id:0;}
    if(!archiveId)throw bad('请从已完成打版的样衣中选择商品，未打版款请先走预下单开发流程');
    const archive=require('./preOrderStyles').approvedArchive(user,archiveId);
    if(it.sample_archive_version&&it.sample_archive_version!==archive.version)throw bad('样衣版本已更新，请重新选择',409);
    const styleKey=String(archive.style_no||'').trim().toLowerCase();
    if(selectedArchives.has(archive.id)||(styleKey&&selectedStyles.has(styleKey)))throw bad('同一款号只能选择一次：'+(archive.style_no||archive.archive_no));
    selectedArchives.add(archive.id);if(styleKey)selectedStyles.add(styleKey);
    prepared[i].product_name=archive.sample_name||archive.source_data.product_name||archive.style_no;prepared[i].style_no=archive.style_no;
    if(!text(it.product_name,'款式名称',255))throw bad('请填写款式名称');
    text(it.style_no,'款号',100);text(it.remark,'款式备注',2000);
    const tax_rate=number(it.tax_rate,'税率',100);tax=money(tax+money(prepared[i].amount_usd*tax_rate/100));
    const own=new Map(prepared[i].sizeRows.map(s=>[s.color+'\0'+s.size,s]));
    if(prepared[i].sizeRows.some(s=>!Number.isSafeInteger(s.qty)))throw bad('下单件数必须是整数');
    const groups=list(it.material_groups||[],'使用部位',100).map(g=>({id:text(g.id,'部位标识',100),name:text(g.name,'使用部位名称',500),one_use:number(g.one_use,'部位单件用量',1e6)}));
    if(groups.some(g=>!g.id)||new Set(groups.map(g=>g.id)).size!==groups.length)throw bad('使用部位标识无效或重复');
    const groupUnits=new Map();
    const rows=list(it.materials||[],'物料',100).map(input=>{
      const group=input.usage_group_id?groups.find(g=>g.id===input.usage_group_id):null;
      if(input.usage_group_id&&!group)throw bad('物料关联的使用部位不存在');
      const m=archiveInput(input);if(group){if(groupUnits.has(group.id)&&groupUnits.get(group.id)!==m.unit)throw bad('同一部位物料的计量单位须一致');groupUnits.set(group.id,m.unit);}
      const one_use=group?group.one_use:number(m.one_use,'单件用量',1e6),loss=number(m.loss,'损耗',1000),price=number(m.price,'物料单价',1e7);
      const air_gap=number(m.archive_air_gap==null||m.archive_air_gap===''?100:String(m.archive_air_gap).replace(/%/g,''),'档案空差',1000);if(air_gap===0)throw bad('空差必须大于 0');
      if((input.colors||[]).some(c=>!prepared[i].sizeRows.some(s=>s.color===c.colorway)))throw bad('物料款色不属于当前款的下单颜色');
      const colors=list(input.colors||[],'物料配色',100).map(c=>({
        colorway:text(c.colorway,'款色',100),color_no:text(c.color_no,'物料颜色 / 色号',150),price:c.price==null||c.price===''?null:number(c.price,'颜色单价',1e7),image_url:image(c.image_url),
        qty:group?null:(c.qty==null||c.qty===''?null:number(c.qty,'颜色用量',1e6)),
        sizes:list(group?[]:(c.sizes||[]),'分码用量',100).map(s=>{if(!own.has(c.colorway+'\0'+s.size))throw bad('物料尺码不属于当前款');return {size:s.size,one_use:number(s.one_use,'分码用量',1e6)};})
      }));
      if(new Set(colors.map(c=>c.colorway)).size!==colors.length)throw bad('物料配色重复');
      return {...m,one_use,loss,price,ingredient:text(m.ingredient,'成分',2000),remark:text(m.remark,'物料备注',2000),entry:{version:1,shared_color:input.shared_color ?? (m.type==='accessory' && !input.colors_configured && !colors.length),shared_config:input.shared_color===true ? colors[0] || null : null,colors_configured:input.colors_configured===true,order_image_url:image(input.order_image_url),role:m.type==='fabric'?'主料':'辅料',usage_group_id:group?.id||null,usage_part:group?group.name:text(input.usage_part,'使用部位',500),air_gap,colors}};
    });
    const color_images={};for(const [color,url]of Object.entries(it.color_images||{})){if(prepared[i].sizeRows.some(s=>s.color===color))color_images[color]=image(url);}
    const crafts=list(it.crafts||[],'工艺要求',60).map(c=>{const arc=db.prepare("SELECT * FROM craft_types WHERE id=? AND status='active'").get(c.craft_type_id);if(!arc)throw bad('工序档案已停用或不存在');return {craft_type_id:arc.id,name:arc.name,instruction:text(c.instruction,'工艺要求',2000)};});
    return {version:1,sample_archive_id:archive.id,sample_archive_version:archive.version,tax_rate,currency:it.currency==='CNY'?'CNY':'USD',color_images,customer_sizes:it.customer_sizes||{},crafts,material_groups:groups,materials:rows};
  });
  const goods=money(prepared.reduce((s,p)=>s+p.amount_usd,0));
  const summary=settlement(goods,tax,{...b,tags});
  const attachments=list(b.attachments||[],'附件',30).map(a=>{
    const url=text(a.url,'附件地址',400);const match=/^\/(uploads|api\/files\/att)\/([\w-]+\.[\w]+)$/.exec(url);if(!match)throw bad('附件地址无效');
    const file=path.resolve(__dirname,'../../data/uploads',match[1]==='uploads'?'':'private',match[2]);if(!fs.existsSync(file))throw bad('附件文件不存在，请重新上传');
    return {filename:text(a.filename,'附件名称',255),url,size:fs.statSync(file).size,mime:text(a.mime,'附件类型',100)};
  });
  return {entries,attachments,summary};
}
function apply(orderId,itemIds,data,requestInfo,user) {
  if(!data)return;
  const t=now();db.prepare('UPDATE orders SET entry_json=? WHERE id=?').run(json(data.summary),orderId);
  data.entries.forEach((entry,i)=>{
    const {materials:rows,...meta}=entry;db.prepare('UPDATE order_items SET entry_json=? WHERE id=?').run(json(meta),itemIds[i]);
    for(const m of rows){
      const r=db.prepare(`INSERT INTO order_materials(order_id,item_id,material_id,type,name,unit,one_use,loss,price,spec,ingredient,supplier,remark,all_colors,created_at,entry_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(orderId,itemIds[i],m.material_id,m.type,m.name,m.unit||'',m.one_use,m.loss,m.price,m.spec||'',m.ingredient,m.supplier,m.remark,(m.entry.colors_configured||m.entry.colors.length)?0:1,t,json(m.entry));
      const id=Number(r.lastInsertRowid);materials.replaceColors(id,m.entry.colors);materials.recalc(id);
    }
    for(const c of entry.crafts)db.prepare('INSERT INTO order_crafts(order_id,name,qty,price,is_out,instruction,remark,created_at) VALUES(?,?,?,0,0,?,?,?)').run(orderId,c.name,0,c.instruction,'款式 #'+itemIds[i]+'；生产分单时确定本厂/外发',t);
  });
  for(const a of data.attachments)db.prepare('INSERT INTO attachments(target_type,target_id,filename,url,size,mime,uploader,created_at) VALUES(?,?,?,?,?,?,?,?)').run('order',orderId,a.filename,a.url,a.size,a.mime,user.username,t);
  const row=draft(user,{scope_key:requestInfo.scope});
  if(row){const updated=db.prepare("UPDATE order_entry_drafts SET document_no=?,status='submitted',request_hash=?,order_id=?,payload_json='{}',version=version+1,updated_at=? WHERE id=? AND version=?").run(requestInfo.doc,requestInfo.hash,orderId,t,row.id,requestInfo.version);if(!updated.changes)throw bad('草稿保存冲突，请重新打开',409);}
  else db.prepare("INSERT INTO order_entry_drafts(user_id,company_id,scope_key,document_no,status,payload_json,request_hash,order_id,created_at,updated_at) VALUES(?,?,?,?,'submitted','{}',?,?,?,?)").run(user.sub,company(user),requestInfo.scope,requestInfo.doc,requestInfo.hash,orderId,t,t);
}
function templateKey(user){return 'order-material-templates:'+company(user)+':'+user.sub;}
function templates(user){const row=db.prepare('SELECT value FROM app_config WHERE key=?').get(templateKey(user));return row?JSON.parse(row.value):[];}
function saveTemplate(user,b){const name=text(b.name,'模板名称',80);if(!name)throw bad('模板名称必填');const rows=list(b.materials,'模板物料',100).map(m=>{archiveInput(m);return {material_id:m.material_id,one_use:number(m.one_use,'用量'),loss:number(m.loss,'损耗',1000),price:number(m.price,'单价'),usage_part:text(m.usage_part,'使用部位',500)};});const all=templates(user).filter(t=>t.name!==name);all.push({name,materials:rows});if(all.length>50)throw bad('最多保存50个辅料模板');db.prepare('INSERT INTO app_config(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(templateKey(user),json(all),now());return all;}
module.exports={request,prepare,apply,readDraft,saveDraft,templates,saveTemplate,reprice};
