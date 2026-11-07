const pricing=require('../services/preOrderPricing');
const express=require('express');const {db,now}=require('../db');const {ok,fail,wrap}=require('../utils/http');const {authRequired,requireRole}=require('../middleware/auth');const scope=require('../access/companyScope');const {nextNo}=require('../utils/docNo');const orderNo=require('../services/orderNo');const {styleImages,readImages}=require('../services/orderImages');const {sourceForOrder}=require('../services/preOrderTransfer');
const styles=require('../services/preOrderStyles');
const router=express.Router(),READ=['admin','boss','sales','tech','warehouse'],WRITE=['admin','sales'];
const bad=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function scoped(req){const r=scope.assertRow(req.user,'pre_orders',req.params.id,'预下单');if(!r.ok)bad(r.reason,r.status);return r.row;}
function detail(row){if(!row)return null;const items=db.prepare('SELECT * FROM pre_order_items WHERE pre_order_id=? ORDER BY sort,id').all(row.id).map(item=>{const tp=db.prepare(`SELECT tp.id,tp.status,tp.business_submitted_at,CASE WHEN TRIM(IFNULL(tp.customer_req,''))<>'' THEN 1 ELSE 0 END AS has_customer_req,tp.version,(SELECT COUNT(*) FROM tech_pack_materials m WHERE m.tech_pack_id=tp.id) material_count,pf.id AS flow_id,pf.status AS flow_status,pf.current_stage FROM tech_packs tp LEFT JOIN pattern_flows pf ON pf.tech_pack_id=tp.id WHERE tp.pre_order_item_id=? ORDER BY tp.id DESC LIMIT 1`).get(item.id);return {...item,size_prices:pricing.read(item.pricing_json),amount_usd:pricing.amount(pricing.read(item.pricing_json)),development:tp||null,detail_images:readImages(item.detail_images)};});const actual=items.length?items:[{id:null,product_name:row.style_name||'',style_no:'',expected_qty:row.expected_qty||0,effect_image_url:null,detail_images:[],remark:''}];
 const finance=!!row.converted_order_id&&!!db.prepare("SELECT 1 FROM cost_sheets WHERE order_id=? AND status='approved'").get(row.converted_order_id);
 const missing=actual.some(i=>i.source_type!=='archive'&&(!i.development?.material_count||!i.development?.has_customer_req));
 const finished=actual.length>0&&actual.every(i=>i.source_type==='archive'||i.development?.flow_status==='done');
 return {...row,items:actual,finance_passed:finance,missing_details:missing,pattern_running:actual.some(i=>i.development?.flow_status==='running'),pattern_complete_unordered:finished&&row.status!=='converted'};}
function text(value,label,max=255){if(value!=null && typeof value!=='string')bad(label+'格式错误');const v=String(value||'').trim();if(v.length>max)bad(label+'超过长度限制');return v;}
/** 金额及比例在事务前校验；空值表示尚未约定，不能接受布尔值、指数或超过两位小数。 */
function decimal(value,label,max){
 if(value===null||value===undefined||value==='')return null;
 if(!['number','string'].includes(typeof value)||!/^\d+(\.\d{1,2})?$/.test(String(value)))bad(label+'须为最多两位小数的非负数');
 const n=Number(value);if(!Number.isFinite(n)||n>max)bad(label+'超出允许范围');return n;
}
const META_FIELDS={designer:'设计师',category:'分类',series:'系列',wave:'波段',sample_source:'样品来源',po_no:'PO单号'};
function saveHeader(id,v){db.prepare('UPDATE pre_orders SET total_usd=?,payment_ratio=?,designer=?,category=?,series=?,wave=?,sample_source=?,po_no=? WHERE id=?').run(v.total_usd,v.payment_ratio,...Object.keys(META_FIELDS).map(k=>v[k]),id);}
function input(body,user,preId) {
 const customerId=body.customer_id?Number(body.customer_id):null;
 if(customerId!==null && (!Number.isSafeInteger(customerId)||customerId<=0))bad('客户档案编号无效');
 const customer=customerId?db.prepare("SELECT * FROM customers WHERE id=? AND status='active'").get(customerId):null;
 if(customerId&&!customer)bad('客户档案不存在或已停用');
 const customerName=text(body.customer_name||customer?.name,'客户名称');if(!customerName)bad('客户名称必填');
 const businessNo=orderNo.check(body.order_no);
 if(body.target_date && (!/^\d{4}-\d{2}-\d{2}$/.test(body.target_date)||!Number.isFinite(Date.parse(body.target_date))))bad('目标交期格式无效');
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>100)bad('请填写1–100款明细');
 const items=body.items.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item))bad('款式明细格式无效');
  const previous=item.id&&preId?db.prepare('SELECT * FROM pre_order_items WHERE id=? AND pre_order_id=?').get(Number(item.id),preId):null;
  if(item.id&&!previous)bad('款式不属于当前预下单');
  text(item.product_name,'款式名称',120);text(item.style_no,'款号',100);
  const source=styles.prepare(user,item,previous),size_prices=pricing.normalize(item.size_prices??pricing.read(previous?.pricing_json)),qty=size_prices.length?size_prices.reduce((n,r)=>n+r.qty,0):Number(item.expected_qty||0);
  if(!Number.isFinite(qty)||qty<0)bad('预估数量必须为非负数');
  return {id:Number(item.id)||null,...source,size_prices,expected_qty:qty,remark:text(item.remark,'款式要求',2000)};
 });
 const archives=new Set(),codes=new Set();for(const item of items){const code=String(item.style_no||'').trim().toLowerCase();if((item.sample_archive_id&&archives.has(item.sample_archive_id))||(code&&codes.has(code)))bad('同一款号不能重复选择：'+(item.style_no||item.product_name));if(item.sample_archive_id)archives.add(item.sample_archive_id);if(code)codes.add(code);}
 return {order_no:businessNo,customer_id:customerId,customer_name:customerName,recipient_name:text(body.recipient_name??customer?.contact,'联系人'),recipient_phone:text(body.recipient_phone??customer?.phone,'电话'),shipping_address:text(body.shipping_address??customer?.shipping_address,'收货地址',2000),manager:text(body.manager??user.name??user.username,'业务员'),target_date:body.target_date||null,requirements:text(body.requirements,'订单要求',4000),total_usd:items.every(i=>i.size_prices.length)?decimal(pricing.amount(items.flatMap(i=>i.size_prices)),'订单总金额',999999999999.99):decimal(body.total_usd,'订单总金额',999999999999.99),payment_ratio:decimal(body.payment_ratio,'付款比例',100),...Object.fromEntries(Object.entries(META_FIELDS).map(([k,label])=>[k,text(body[k],label,k==='po_no'?100:120)])),items};
}
function event(id,action,version,req,details){db.prepare('INSERT INTO pre_order_events(pre_order_id,action,version,operator,details,created_at) VALUES(?,?,?,?,?,?)').run(id,action,version,req.user.name||req.user.username,JSON.stringify(details),now());}
function saveItems(id,items,user){
 const previous=db.prepare('SELECT * FROM pre_order_items WHERE pre_order_id=?').all(id);
 const referenced=item=>db.prepare('SELECT 1 FROM material_dev_requests WHERE pre_order_item_id=? UNION ALL SELECT 1 FROM tech_packs WHERE pre_order_item_id=? LIMIT 1').get(item.id,item.id);
 const retained=new Set(items.map(i=>i.id).filter(Boolean));
 if(retained.size!==items.filter(i=>i.id).length)bad('款式编号重复');
 for(const item of items)if(item.id && !previous.some(r=>r.id===item.id))bad('款式不属于此预下单');
 for(const item of previous)if(!retained.has(item.id)){if(referenced(item))bad('款式已进入开发，不可删除；请保留来源款式',409);db.prepare('DELETE FROM pre_order_items WHERE id=?').run(item.id);}
 const insert=db.prepare('INSERT INTO pre_order_items(pre_order_id,product_name,style_no,expected_qty,effect_image_url,detail_images,remark,sort,source_type,sample_archive_id,source_snapshot,pricing_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
 const update=db.prepare('UPDATE pre_order_items SET product_name=?,style_no=?,expected_qty=?,effect_image_url=?,detail_images=?,remark=?,sort=?,source_type=?,sample_archive_id=?,source_snapshot=?,pricing_json=? WHERE id=? AND pre_order_id=?');
 items.forEach((item,index)=>{const values=[item.product_name,item.style_no,item.expected_qty,item.effect_image_url,JSON.stringify(item.detail_images),item.remark,index,item.source_type,item.sample_archive_id,item.source_snapshot,JSON.stringify(item.size_prices)];if(item.id)update.run(...values,item.id,id);else insert.run(id,...values);});
 const pre=db.prepare('SELECT * FROM pre_orders WHERE id=?').get(id);
 for(const item of db.prepare('SELECT * FROM pre_order_items WHERE pre_order_id=? ORDER BY sort,id').all(id))styles.ensureDevelopment(pre,item,user);
}

router.get('/',authRequired,requireRole(READ),wrap(async(req,res)=>{
 const where=[],args=[],sc=scope.clause(req.user,'p.company_id');if(sc.sql){where.push(sc.sql.replace(/^\s*AND\s+/,''));args.push(...sc.params);}if(req.query.status){where.push('p.status=?');args.push(String(req.query.status));}const q=String(req.query.q||'').trim();if(q){where.push('(p.pre_order_no LIKE ? OR p.order_no LIKE ? OR p.customer_name LIKE ? OR p.style_name LIKE ? OR EXISTS(SELECT 1 FROM pre_order_items si WHERE si.pre_order_id=p.id AND (si.product_name LIKE ? OR si.style_no LIKE ?)))');args.push(...Array(6).fill('%'+q+'%'));}return ok(res,db.prepare(`SELECT p.* FROM pre_orders p ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY p.id DESC`).all(...args).map(detail));
}));
router.get('/available-products',authRequired,requireRole(READ),wrap(async(req,res)=>ok(res,styles.availableDistinct(req.user,String(req.query.q||'').trim()))));
router.get('/:id/order-draft',authRequired,requireRole(WRITE),wrap(async(req,res)=>{const row=sourceForOrder(req.user,req.params.id);return ok(res,detail(row));}));
router.get('/:id',authRequired,requireRole(READ),wrap(async(req,res)=>ok(res,detail(scoped(req)))));
router.post('/',authRequired,requireRole(WRITE),wrap(async(req,res)=>{
 const v=input(req.body||{},req.user);if(db.prepare('SELECT id FROM pre_orders WHERE order_no=? COLLATE NOCASE').get(v.order_no))return fail(res,409,'预下单订单号已存在');const company=scope.writeCompanyOf(req.user),ts=now();let id;
 db.exec('BEGIN IMMEDIATE');try{const no=nextNo('PD','pre_orders','pre_order_no');id=Number(db.prepare(`INSERT INTO pre_orders(pre_order_no,order_no,company_id,customer_id,customer_name,recipient_name,recipient_phone,shipping_address,manager,style_name,expected_qty,target_date,requirements,status,created_by,created_by_name,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?,1)`).run(no,v.order_no,company,v.customer_id,v.customer_name,v.recipient_name,v.recipient_phone,v.shipping_address,v.manager,v.items.map((i,n)=>i.product_name||i.style_no||'图片新款 '+(n+1)).join(' / '),v.items.reduce((sum,i)=>sum+i.expected_qty,0),v.target_date,v.requirements,req.user.sub,req.user.name||req.user.username,ts,ts).lastInsertRowid);saveHeader(id,v);saveItems(id,v.items,req.user);event(id,'created',1,req,v);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');if(String(e.message).includes('UNIQUE'))bad('预下单订单号重复，请刷新后重试',409);throw e;}return ok(res,detail(db.prepare('SELECT * FROM pre_orders WHERE id=?').get(id)));
}));
router.put('/:id',authRequired,requireRole(WRITE),wrap(async(req,res)=>{
 const row=scoped(req);if(row.status==='converted')return fail(res,409,'已转正式订单的预下单不能再编辑');const b=req.body||{};if(b.version!==row.version)return fail(res,409,'预下单已更新，请刷新后重试');const v=input({...row,...b},req.user,row.id);if(db.prepare('SELECT id FROM pre_orders WHERE order_no=? COLLATE NOCASE AND id<>?').get(v.order_no,row.id))return fail(res,409,'预下单订单号已存在');
 db.exec('BEGIN IMMEDIATE');try{const result=db.prepare(`UPDATE pre_orders SET order_no=?,customer_id=?,customer_name=?,recipient_name=?,recipient_phone=?,shipping_address=?,manager=?,style_name=?,expected_qty=?,target_date=?,requirements=?,status='open',completed_at=NULL,completed_by=NULL,updated_at=?,version=version+1 WHERE id=? AND version=? AND status<>'converted'`).run(v.order_no,v.customer_id,v.customer_name,v.recipient_name,v.recipient_phone,v.shipping_address,v.manager,v.items.map((i,n)=>i.product_name||i.style_no||'图片新款 '+(n+1)).join(' / '),v.items.reduce((sum,i)=>sum+i.expected_qty,0),v.target_date,v.requirements,now(),row.id,b.version);if(!result.changes)bad('预下单已更新，请刷新后重试',409);saveHeader(row.id,v);saveItems(row.id,v.items,req.user);event(row.id,'updated',row.version+1,req,v);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return ok(res,detail(db.prepare('SELECT * FROM pre_orders WHERE id=?').get(row.id)));
}));
router.post('/:id/complete',authRequired,requireRole(WRITE),wrap(async(req,res)=>{
 const row=scoped(req);if(row.status!=='open')return fail(res,409,'当前预下单不能重复完成');if(req.body?.version!==row.version)return fail(res,409,'预下单已更新，请刷新后重试');const ready=detail(row);input({...ready,order_no:row.order_no},req.user,row.id);const ts=now();
 db.exec('BEGIN IMMEDIATE');try{const change=db.prepare("UPDATE pre_orders SET status='ready',completed_at=?,completed_by=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND status='open'").run(ts,req.user.name||req.user.username,ts,row.id,row.version);if(!change.changes)bad('预下单已更新，请刷新后重试',409);event(row.id,'completed',row.version+1,req,{});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return ok(res,detail(db.prepare('SELECT * FROM pre_orders WHERE id=?').get(row.id)));
}));
module.exports=router;
