/** 用户明确授权的现场实测，必须 --live --keep；只调用业务接口，绝不直接改业务状态。 */
const fs=require('fs'),path=require('path'),{DatabaseSync}=require('node:sqlite');
if(!process.argv.includes('--live')||!process.argv.includes('--keep')||!process.env.TRIAL_PASSWORD)throw Error('需要明确的 --live --keep 和 TRIAL_PASSWORD，禁止误跑');
const location=JSON.parse(fs.readFileSync(path.resolve('../logs/retained-trials-location.json'),'utf8'));
const BASE=location.base,FILE=path.join(location.directory,'manifest.json');
if(BASE!=='http://127.0.0.1:3100')throw Error('实测地址不符');
const marker='__SMOKE_流程实测保留_朱佳豪_20261103';
const disclaimer=marker+'；内部模拟，不代表真实签样/出入库/收款；用户要求保留，不清理';
const read=new DatabaseSync(path.resolve('data/lan-preview.db'),{readOnly:true});
let token,customerToken;
const state=fs.existsSync(FILE)?JSON.parse(fs.readFileSync(FILE,'utf8')):{marker,disclaimer,actor_id:location.user_id,trials:[],images:[],checks:[],created_at:new Date().toISOString()};
function save(){fs.writeFileSync(FILE,JSON.stringify(state,null,2));}
async function login(){const r=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'13055709733',password:process.env.TRIAL_PASSWORD})});const j=await r.json();if(!j.ok||j.data.user.id!==location.user_id)throw Error('指定账号登录失败');token=j.data.token;}
async function api(method,url,body,expected=200,customer=false){
 const r=await fetch(BASE+url,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+(customer?customerToken:token)},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();
 fs.appendFileSync(path.join(location.directory,'requests.jsonl'),JSON.stringify({at:new Date().toISOString(),method,url,status:r.status,ok:j.ok,message:j.message||null,actor:customer?'内部实测客户确认账号':location.user_id})+'\n');
 if(r.status!==expected)throw Error(method+' '+url+' '+r.status+' '+j.message);
 return j.data;
}
async function checkpoint(name,fn){if(state.checks.includes(name))return;await fn();state.checks.push(name);save();console.log('OK '+name);}
function tp(id){return read.prepare('SELECT * FROM tech_packs WHERE id=?').get(id);}
async function prepare(){
 const customer=read.prepare("SELECT * FROM customers WHERE status='active' ORDER BY id LIMIT 1").get();
 state.customer_id=customer.id;state.material_id=read.prepare("SELECT id FROM materials WHERE status='active' ORDER BY id LIMIT 1").get().id;state.factory_id=read.prepare("SELECT id FROM factories WHERE status='active' ORDER BY id LIMIT 1").get().id;save();
 for(let i=state.images.length;i<3;i++){
  const colors=['#2679bd','#687b83','#bb634b'];
  const svg='<svg width="420" height="460"><rect width="420" height="460" fill="#fafafa"/><path d="M120 70 L170 45 Q210 90 250 45 L300 70 L390 150 L320 210 L285 170 L285 380 L135 380 L135 170 L100 210 L30 150 Z" fill="'+colors[i]+'"/><text x="210" y="425" text-anchor="middle" font-size="16" fill="#222">INTERNAL FLOW TRIAL ONLY '+(i+1)+'</text></svg>';
  const png=await require('sharp')(Buffer.from(svg)).png().toBuffer();const image=await api('POST','/api/upload',{dataUrl:'data:image/png;base64,'+png.toString('base64')});state.images.push(image.url);save();
 }
 for(let i=state.trials.length;i<2;i++){
  const items=i===0?[{source_type:'new',product_name:'',expected_qty:2,effect_image_url:state.images[0],detail_images:[state.images[1]],remark:disclaimer}]:[1,2].map((n)=>({source_type:'new',product_name:marker+' 多款'+n,expected_qty:n+1,effect_image_url:state.images[n],remark:disclaimer}));
  const orderNo='SCBH-20261103-0'+(i+1);
  const existing=read.prepare('SELECT id FROM pre_orders WHERE order_no=?').get(orderNo);
  const pre=existing?await api('GET','/api/pre-orders/'+existing.id):await api('POST','/api/pre-orders',{order_no:orderNo,customer_id:customer.id,manager:'朱佳豪',target_date:'2026-11-30',requirements:disclaimer,items});
  state.trials.push({order_no:orderNo,pre_order_id:pre.id,pre_order_no:pre.pre_order_no,kind:i===0?'图片新款寻样驳回重找':'多款并行开发',item_ids:pre.items.map(x=>x.id)});save();console.log('CREATED '+orderNo+' '+pre.pre_order_no);
 }
}
async function develop(){
 const one=state.trials[0];
 await checkpoint('trial1-material-development',async()=>{
  let dev=read.prepare('SELECT id FROM material_dev_requests WHERE pre_order_id=? AND pre_order_item_id=?').get(one.pre_order_id,one.item_ids[0]);
  dev=dev?await api('GET','/api/material-development/'+dev.id):await api('POST','/api/material-development',{pre_order_id:one.pre_order_id,pre_order_item_id:one.item_ids[0],material_type:'fabric',material_name:marker+' 瑜伽四面弹寻样',customer_requirements:disclaimer+'；实测要求220G四面弹，业务对图片确认',reference_image_url:state.images[0],requested_spec:'220G 165cm 四面弹'});
  state.material_request_id=dev.id;save();
  for(let roundNo=1;roundNo<=2;roundNo++){
   dev=await api('GET','/api/material-development/'+dev.id);let round=dev.rounds.find(r=>r.round_no===roundNo);
   if(!round){dev=await api('POST','/api/material-development/'+dev.id+'/start-search',{search_note:disclaimer+'；第'+roundNo+'轮模拟市场寻样'});round=dev.rounds.at(-1);}
   if(round.decision==='searching')dev=await api('POST','/api/material-development/rounds/'+round.id+'/return',{candidate_name:marker+' 候选'+roundNo,candidate_spec:roundNo===1?'180G 弹性不足':'220G 四面弹',candidate_image_url:state.images[roundNo===1?1:0],supplier_id:1,supplier_name:'正邦985',return_note:disclaimer});
   dev=await api('GET','/api/material-development/'+dev.id);round=dev.rounds.find(r=>r.round_no===roundNo);
   if(round.decision==='awaiting_business')await api('POST','/api/material-development/rounds/'+round.id+(roundNo===1?'/reject':'/approve'),roundNo===1?{rejection_reason:disclaimer+'；模拟克重和弹性不满足，重新寻样'}:{create_material:false});
  }
  dev=await api('GET','/api/material-development/'+dev.id);
  if(dev.pattern_review_status!=='approved')await api('POST','/api/material-development/'+dev.id+'/pattern-review',{approve:true,note:disclaimer+'；模拟准入审核'});
 });
 for(const trial of state.trials.slice(0,2)){
  const pre=await api('GET','/api/pre-orders/'+trial.pre_order_id);
  for(let index=0;index<pre.items.length;index++){
   const item=pre.items[index],development=item.development;
   await checkpoint('develop-'+item.id,async()=>{
    let pack=tp(development.id);let flow=await api('GET','/api/pattern-flows/by-techpack/'+development.id);
    const technical={fabric_info:'正邦220G瑜伽印花；165cm；四面弹',accessory_info:'实测洗唛、吊牌',craft_info:'四针六线0.5元；检验与包装',customer_req:disclaimer,size_spec:'M：胸围90cm 衣长60cm'};
    if(flow.status==='done'&&Object.keys(technical).some(k=>!pack[k])){
     const archive=read.prepare('SELECT * FROM sample_archives WHERE tech_pack_id=? ORDER BY id DESC').get(pack.id);
     let change=read.prepare("SELECT * FROM sample_change_requests WHERE archive_id=? AND status IN ('pending','approved') ORDER BY id DESC LIMIT 1").get(archive.id);
     if(!change)change=await api('POST','/api/sample-archives/'+archive.id+'/change-request',{reason:disclaimer+'；实操发现归档资料未齐备，申请补正保留旧版',detail:'补齐辅料、工艺说明、尺码；完整变更审计'});
     if(change.status==='pending')await api('POST','/api/sample-archives/changes/'+change.id+'/review',{approve:true,note:disclaimer+'；同意按变更流程补正'});
     flow=await api('GET','/api/pattern-flows/by-techpack/'+pack.id);
    }
    if(flow.status==='done'){if(pack.status!=='confirmed')await api('POST','/api/techpacks/'+pack.id+'/confirm',{});return;}
    if(flow.current_stage==='material'){
     await api('PUT','/api/techpacks/'+pack.id,technical);
     await api('PUT','/api/pattern-flows/'+flow.id+'/materials',{materials:[{material_id:state.material_id,mat_type:'fabric',colorway:index?'灰':'蓝',color_no:'TRIAL-'+(index+1),composition:'实测80%/20%，不修改主档',one_use:1,unit_price:10,remark:disclaimer}]});
    }else{
     for(const [field,value] of Object.entries(technical))if(!tp(pack.id)[field]){
      let change=read.prepare("SELECT * FROM pattern_change_requests WHERE flow_id=? AND field_key=? AND status IN ('pending','awaiting_recheck') ORDER BY id DESC LIMIT 1").get(flow.id,field);
      if(!change)change=await api('POST','/api/pattern-flows/'+flow.id+'/changes',{field_key:field,proposed_value:value,reason:disclaimer+'；补正归档资料'});
      if(change.status==='pending')change=await api('POST','/api/pattern-flows/changes/'+change.id+'/review',{approve:true,note:disclaimer});
      if(change.status==='awaiting_recheck')await api('POST','/api/pattern-flows/changes/'+change.id+'/recheck',{approve:true,note:disclaimer+'；修改后复核通过'});
     }
    }
    for(const stage of ['material','pattern','craft','sample','biz','audit']){
     flow=await api('GET','/api/pattern-flows/by-techpack/'+pack.id);const row=flow.stages.find(s=>s.stage===stage);if(row.status==='done')continue;
     pack=tp(pack.id);let data={images:[item.effect_image_url||state.images[0]],trial_disclaimer:disclaimer};
     if(stage==='pattern')data={...data,style_no:'SCBH-'+String(trial.pre_order_id)+'-'+(index+1),style_no_version:pack.updated_at};
     if(stage==='craft')data={...data,sewing:[{name:'四针六线',category:'sewing',craft_type_id:1,price:0.5,ratio:1,remark:disclaimer}],finish:[{name:'检验',category:'finish',price:0.1,ratio:1,remark:disclaimer},{name:'包装',category:'packing',price:0.1,ratio:1,remark:disclaimer}]};
     await api('PUT','/api/pattern-flows/'+flow.id+'/stage/'+stage,{owner:'朱佳豪（内部实测）',pattern_size:'M',remark:disclaimer,data});
     await api('POST','/api/pattern-flows/'+flow.id+'/stage/'+stage+'/done',{});
    }
    await api('POST','/api/pattern-flows/'+flow.id+'/finish',{});
    await api('POST','/api/techpacks/'+pack.id+'/confirm',{});
   });
  }
 }
 await checkpoint('trial3-create-archive-reuse',async()=>{
  const first=tp((await api('GET','/api/pre-orders/'+one.pre_order_id)).items[0].development.id);
  const archive=read.prepare('SELECT * FROM sample_archives WHERE tech_pack_id=? ORDER BY id DESC').get(first.id);
  const no='SCBH-20261103-03';let pre=read.prepare('SELECT id FROM pre_orders WHERE order_no=?').get(no);
  pre=pre?await api('GET','/api/pre-orders/'+pre.id):await api('POST','/api/pre-orders',{order_no:no,customer_id:state.customer_id,manager:'朱佳豪',target_date:'2026-11-30',requirements:disclaimer,items:[{source_type:'archive',sample_archive_id:archive.id,expected_qty:2,remark:disclaimer}]});
  state.trials.push({order_no:no,pre_order_id:pre.id,pre_order_no:pre.pre_order_no,kind:'已打版样衣复用',item_ids:pre.items.map(i=>i.id)});
 });
}
async function customerLogin(){
 const password=require('crypto').randomBytes(24).toString('base64url');
 let account=read.prepare('SELECT id FROM customer_accounts WHERE username=?').get('__SMOKE_INTERNAL_FLOW_20261103');
 if(!account)account=await api('POST','/api/mall-admin/accounts',{customer_id:state.customer_id,username:'__SMOKE_INTERNAL_FLOW_20261103',name:marker+'（内部模拟签认，非真实客户）',password,limit_perms:['order.confirm']});
 else await api('PUT','/api/mall-admin/accounts/'+account.id,{password,status:'active'});
 state.customer_account_id=account.id;save();
 const r=await fetch(BASE+'/api/mall/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'__SMOKE_INTERNAL_FLOW_20261103',password})});const j=await r.json();if(!j.ok)throw Error(j.message);customerToken=j.data.token;
}
async function transfer(){
 await customerLogin();
 for(const trial of state.trials){
  await checkpoint('transfer-'+trial.pre_order_id,async()=>{
   let pre=await api('GET','/api/pre-orders/'+trial.pre_order_id);
   if(pre.status==='open')pre=await api('POST','/api/pre-orders/'+pre.id+'/complete',{version:pre.version});
   let order=read.prepare('SELECT id FROM orders WHERE source_pre_order_id=?').get(pre.id);
   if(!order){
    const draft=await api('GET','/api/pre-orders/'+pre.id+'/order-draft');
    order=await api('POST','/api/orders',{...draft,source_pre_order_id:pre.id,source_pre_order_version:pre.version,order_no:pre.order_no,type:'custom',customer_id:state.customer_id,manager:'朱佳豪',delivery_date:'2026-11-30',rate:6.5,remark:disclaimer,items:pre.items.map((item,index)=>({source_pre_order_item_id:item.id,product_name:item.product_name||item.style_no,style_no:item.style_no,effect_image_url:item.effect_image_url,detail_images:item.detail_images,remark:disclaimer,colors:[{color:index?'灰色':'蓝色',sizes:[{size:'M',qty:item.expected_qty,usd_price:1}]}]}))});
   }
   trial.order_id=order.id;save();
   for(const pack of read.prepare('SELECT id,status FROM tech_packs WHERE order_id=?').all(order.id))if(pack.status!=='confirmed')await api('POST','/api/techpacks/'+pack.id+'/confirm',{});
  });
  const orderId=trial.order_id;
  await checkpoint('seals-'+orderId,async()=>{
   const details=await api('GET','/api/orders/'+orderId);
   for(const item of details.items){
    let seal=read.prepare("SELECT * FROM sample_seals WHERE order_id=? AND order_item_id=? ORDER BY id DESC LIMIT 1").get(orderId,item.id);
    const archive=read.prepare("SELECT a.id FROM sample_archives a JOIN tech_packs tp ON tp.id=a.tech_pack_id WHERE tp.order_id=? AND tp.order_item_id=? AND a.status='locked' ORDER BY a.id DESC LIMIT 1").get(orderId,item.id);
    if(!seal)seal=await api('POST','/api/confirm/seals',{archive_id:archive?.id,order_id:orderId,order_item_id:item.id,sample_name:marker+' '+item.style_no,style_no:item.style_no,version:'V1',attachments:[item.effect_image_url||state.images[0]],remark:disclaimer});
    if(!seal.tech_approved)seal=await api('POST','/api/confirm/seals/'+seal.id+'/tech-approve',{row_version:seal.row_version});
    if(!['sent','confirmed'].includes(seal.status))seal=await api('POST','/api/confirm/seals/'+seal.id+'/send',{row_version:seal.row_version});
    if(seal.status==='sent')await api('POST','/api/mall/seals/'+seal.id+'/confirm',{accepted:true,row_version:seal.row_version,comment:disclaimer+'；仅验证客户签认接口'},200,true);
   }
  });
  await checkpoint('production-ready-'+orderId,async()=>{
   const order=await api('GET','/api/orders/'+orderId);if(order.status==='draft'){
    const commitment=await api('GET','/api/commitments/order/'+orderId);
    if(commitment.review_status!=='approved')await api('POST','/api/commitments/'+commitment.id+'/review',{front_ok:true,back_ok:true,material_ok:true,promised_date:'2026-11-30',note:disclaimer});
    await api('POST','/api/orders/'+orderId+'/transition',{to:'tech',note:disclaimer});
   }
   let cost=await api('GET','/api/costs/'+orderId);
   if(!cost)cost=await api('POST','/api/costs/'+orderId,{material_cost:2,accessory_cost:1,labor_cost:1,overhead_cost:0.5,other_cost:0.5,profit_rate:10});
   for(let i=0;i<10&&cost.status!=='approved';i++)cost=await api('POST','/api/costs/'+orderId+'/review',{approve:true,opinion:disclaimer});
   if(cost.status!=='approved')throw Error('成本审批未完成');
   let current=await api('GET','/api/orders/'+orderId);if(current.status==='tech')await api('POST','/api/orders/'+orderId+'/transition',{to:'finance',note:disclaimer});
   const qty=current.items.reduce((s,i)=>s+Number(i.qty),0);
   if(!read.prepare('SELECT 1 FROM dispatch_orders WHERE order_id=?').get(orderId))await api('POST','/api/dispatch',{order_id:orderId,factory_id:state.factory_id,type:'outsource',qty,price:1,remark:disclaimer});
   current=await api('GET','/api/orders/'+orderId);if(current.status==='finance')await api('POST','/api/orders/'+orderId+'/transition',{to:'assigned',note:disclaimer});
   current=await api('GET','/api/orders/'+orderId);if(current.status==='assigned')await api('POST','/api/orders/'+orderId+'/transition',{to:'production',note:disclaimer});
  });
 }
}
async function execute(){
 for(const trial of state.trials){
  const orderId=trial.order_id;
  await checkpoint('first-article-'+orderId,async()=>{
   const order=await api('GET','/api/orders/'+orderId),qty=order.items.reduce((s,i)=>s+Number(i.qty),0);
   let fa=read.prepare('SELECT * FROM first_articles WHERE order_id=? ORDER BY id DESC LIMIT 1').get(orderId);
   if(!fa)fa=await api('POST','/api/first-articles',{order_id:orderId,batch_qty:qty,sample_size:'M',remark:disclaimer});
   if(fa.status==='draft'){
    const checks=read.prepare('SELECT id FROM first_article_checks WHERE fa_id=?').all(fa.id);
    if(!checks.length)await api('POST','/api/first-articles/'+fa.id+'/checks',{part:marker+' 版型及工艺模拟核验',spec:'模拟尺寸60cm；缝线平整',measured:'内部模拟60cm，不代表实物测量',result:'ok',critical:true,remark:disclaimer});
    fa=await api('POST','/api/first-articles/'+fa.id+'/submit',{});
   }
   if(fa.status==='submitted')await api('POST','/api/first-articles/'+fa.id+'/release',{result:'passed',release_qty:qty,conclusion:disclaimer});
  });
  await checkpoint('reports-'+orderId,async()=>{
   const items=read.prepare('SELECT id FROM order_items WHERE order_id=?').all(orderId),nodes=await api('GET','/api/order-nodes?order_id='+orderId);
   for(const node of nodes){
    if(['instock','ship'].includes(node.code))continue;
    for(const item of items){
     const colors=read.prepare('SELECT color,SUM(qty) AS qty FROM order_item_sizes WHERE item_id=? GROUP BY color').all(item.id);
     for(let c=0;c<colors.length;c++){
      const row=colors[c],requestNo='SCBH_20261103_'+orderId+'_'+node.id+'_'+item.id+'_'+c;
      await api('POST','/api/reports',{order_id:orderId,node_id:node.id,item_id:item.id,color:row.color,qty_ok:row.qty,qty_defect:0,hours:0.1,employee_id:8,operator:'朱佳豪',remark:disclaimer,request_no:requestNo,report_date:'2026-11-03'});
     }
    }
   }
  });
  await checkpoint('qc-'+orderId,async()=>{
   const order=await api('GET','/api/orders/'+orderId),qty=order.items.reduce((s,i)=>s+Number(i.qty),0);
   let qc=read.prepare("SELECT * FROM qc_inspections WHERE order_id=? AND type='final' ORDER BY id DESC LIMIT 1").get(orderId);
   if(!qc)qc=await api('POST','/api/qc/inspections',{order_id:orderId,type:'final',sample_qty:qty,inspector:'朱佳豪（内部实测）',remark:disclaimer});
   if(qc.status!=='done')await api('POST','/api/qc/inspections/'+qc.id+'/finish',{aql_result:'pass',sample_qty:qty,pass_qty:qty,fail_qty:0,remark:disclaimer,create_issue:false});
  });
  await checkpoint('stock-and-close-'+orderId,async()=>{
   let order=await api('GET','/api/orders/'+orderId);
   if(order.status==='production')await api('POST','/api/stock/instock',{order_id:orderId,warehouse:'cn',remark:disclaimer});
   order=await api('GET','/api/orders/'+orderId);
   if(order.status==='instock')await api('POST','/api/stock/ship',{order_id:orderId,warehouse:'cn',remark:disclaimer});
   const invoices=read.prepare("SELECT * FROM ar_invoices WHERE order_id=? AND status<>'void'").all(orderId);
   if(!invoices.length)throw Error('发货后未生成应收，停止结案');
   for(const invoice of invoices){
    const open=Math.round((invoice.amount-invoice.paid_amount)*100)/100;
    if(open>0)await api('POST','/api/finance/payments',{direction:'in',partner_id:state.customer_id,partner_name:marker+' 模拟收款（非真实交易）',currency:'CNY',amount:open,method:'内部实测模拟（无实际资金）',pay_date:'2026-11-03',remark:disclaimer,allocations:[{invoice_id:invoice.id,amount:open}]});
   }
   order=await api('GET','/api/orders/'+orderId);
   if(order.status==='shipped')await api('POST','/api/orders/'+orderId+'/transition',{to:'closed',note:disclaimer+'；模拟应收已核销'});
  });
 }
 if(state.customer_account_id)await api('PUT','/api/mall-admin/accounts/'+state.customer_account_id,{status:'disabled'});
 state.finished_at=new Date().toISOString();save();
}
async function supplementFirstArticles(){
 for(const trial of state.trials){
  const items=read.prepare('SELECT id,qty FROM order_items WHERE order_id=?').all(trial.order_id);
  for(const item of items)await checkpoint('fa-style-'+item.id,async()=>{
   const current=await api('GET','/api/first-articles/order/'+trial.order_id+'?order_item_id='+item.id);
   let fa=current.fa;
   if(fa&&['passed','conditional'].includes(fa.status)&&!fa.stale)return;
   if(!fa)fa=await api('POST','/api/first-articles',{order_id:trial.order_id,order_item_id:item.id,batch_qty:item.qty,sample_size:'M',remark:disclaimer+'；逐款首件门禁回归补充，保留原记录'});
   if(fa.status==='draft'){
    const checks=read.prepare('SELECT id FROM first_article_checks WHERE fa_id=?').all(fa.id);
    if(!checks.length)await api('POST','/api/first-articles/'+fa.id+'/checks',{part:marker+' 逐款模拟核验',spec:'模拟版型60cm，检查四针六线',measured:'内部模拟60cm，不代表实物测量',result:'ok',critical:true,remark:disclaimer});
    fa=await api('POST','/api/first-articles/'+fa.id+'/submit',{});
   }
   if(fa.status==='submitted')await api('POST','/api/first-articles/'+fa.id+'/release',{result:'passed',release_qty:item.qty,conclusion:disclaimer+'；逐款回归补充'});
  });
 }
}
(async()=>{await login();const phase=process.argv.find(x=>x.startsWith('--phase='))?.slice(8)||'prepare';if(phase==='prepare')await prepare();else if(phase==='develop')await develop();else if(phase==='transfer')await transfer();else if(phase==='execute')await execute();else if(phase==='supplement-fa')await supplementFirstArticles();else throw Error('未知阶段');delete state.last_error;save();console.log('RETAINED '+FILE);})().catch(e=>{state.last_error={at:new Date().toISOString(),message:e.message};save();console.error(e.stack);process.exitCode=1;}).finally(()=>read.close());
