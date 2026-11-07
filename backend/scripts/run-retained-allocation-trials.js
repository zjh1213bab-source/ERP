/** 用户授权的局域网保留实测。业务写入仅走接口；只读数据库用于证据核对。 */
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const {DatabaseSync,backup}=require('node:sqlite');
process.chdir(path.resolve(__dirname,'..'));
if(!process.argv.includes('--live')||!process.argv.includes('--keep'))throw Error('现场写入须明确 --live --keep');
const BASE='http://127.0.0.1:3100',marker='__SMOKE_流程实测保留_分配分流_20261105';
const note=marker+'；内部模拟，不代表真实签样/生产/出入库/收付款；用户要求保留，不清理';
const location=path.resolve('../logs/retained-allocation-location.json');
let folder;
if(fs.existsSync(location))folder=JSON.parse(fs.readFileSync(location,'utf8')).directory;
else{folder=path.resolve('data/backups/retained-allocation-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(location,JSON.stringify({directory:folder,base:BASE,marker},null,2));}
const file=path.join(folder,'manifest.json');
const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{marker,note,created_at:new Date().toISOString(),actor_id:2,trials:['own','cut','outsource'].map((kind,index)=>({kind,order_no:'SCBH-20261105-A0'+(index+1),qty:2})),checks:[]};
const db=new DatabaseSync(path.resolve('data/lan-preview.db'),{readOnly:true});
const user=db.prepare('SELECT id,name,username,role,employee_id,token_version FROM users WHERE id=?').get(state.actor_id);
assert(user&&user.name==='朱佳豪'&&user.employee_id===8&&user.role==='admin','确认已授权的实测账号身份');
// 内部测试令牌只在内存中使用，遵循当前账号 token_version，不重置密码、不落盘凭据。
const token=require('jsonwebtoken').sign({sub:user.id,tv:user.token_version},require('../src/config').jwtSecret,{expiresIn:'30m'});let customerToken;
function save(){fs.writeFileSync(file,JSON.stringify(state,null,2));}
async function api(method,url,body,expected=200,customer=false){const response=await fetch(BASE+url,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+(customer?customerToken:token)},body:body===undefined?undefined:JSON.stringify(body)});const j=await response.json();fs.appendFileSync(path.join(folder,'requests.jsonl'),JSON.stringify({at:new Date().toISOString(),method,url,status:response.status,ok:j.ok,message:j.message||null,actor:customer?'内部模拟确认账号':user.id})+'\n');if(response.status!==expected||expected===200&&!j.ok)throw Error(method+' '+url+' '+response.status+' '+j.message);return expected===200?j.data:j;}
async function step(key,fn){if(state.checks.includes(key))return;await fn();state.checks.push(key);save();console.log('OK '+key);}
async function customerLogin(){const password=crypto.randomBytes(24).toString('base64url'),username='__SMOKE_INTERNAL_ALLOC_20261105';let account=db.prepare('SELECT id FROM customer_accounts WHERE username=?').get(username);if(!account)account=await api('POST','/api/mall-admin/accounts',{customer_id:state.customer_id,username,name:marker+'（内部模拟签认，非真实客户）',password,limit_perms:['order.confirm']});else await api('PUT','/api/mall-admin/accounts/'+account.id,{password,status:'active'});state.customer_account_id=account.id;save();const r=await fetch(BASE+'/api/mall/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});const j=await r.json();if(!j.ok)throw Error(j.message);customerToken=j.data.token;}
async function create(trial){
 await step('create-'+trial.kind,async()=>{
  let pre=db.prepare('SELECT id,requirements FROM pre_orders WHERE order_no=?').get(trial.order_no);
  if(pre&&!pre.requirements.includes(marker))throw Error('同号已有其他业务，停止');
  pre=pre?await api('GET','/api/pre-orders/'+pre.id):await api('POST','/api/pre-orders',{order_no:trial.order_no,customer_id:state.customer_id,manager:user.name,target_date:'2026-11-30',total_usd:2,payment_ratio:50,requirements:note+'；场景：'+trial.kind,items:[{source_type:'archive',sample_archive_id:trial.archive_id||state.archive_id,expected_qty:2,remark:note}]});
  trial.pre_order_id=pre.id;save();
  if(pre.status==='open')pre=await api('POST','/api/pre-orders/'+pre.id+'/complete',{version:pre.version});
  let order=db.prepare('SELECT id FROM orders WHERE source_pre_order_id=?').get(pre.id);
  if(!order){const draft=await api('GET','/api/pre-orders/'+pre.id+'/order-draft');order=await api('POST','/api/orders',{...draft,source_pre_order_id:pre.id,source_pre_order_version:pre.version,order_no:trial.order_no,type:'custom',customer_id:state.customer_id,manager:user.name,delivery_date:'2026-11-30',order_date:'2026-11-05',rate:6.5,remark:note+'；场景：'+trial.kind,items:pre.items.map(item=>({source_pre_order_item_id:item.id,product_name:item.product_name,style_no:item.style_no,effect_image_url:item.effect_image_url,detail_images:item.detail_images,remark:note,colors:[{color:'蓝色',sizes:[{size:'M',qty:2,usd_price:1}]}]}))});}
  trial.order_id=order.id;save();
  for(const tp of db.prepare('SELECT id,status FROM tech_packs WHERE order_id=?').all(order.id))if(tp.status!=='confirmed')await api('POST','/api/techpacks/'+tp.id+'/confirm',{});
 });
 await step('seal-'+trial.kind,async()=>{const order=await api('GET','/api/orders/'+trial.order_id);for(const item of order.items){let seal=db.prepare('SELECT * FROM sample_seals WHERE order_id=? AND order_item_id=? ORDER BY id DESC LIMIT 1').get(order.id,item.id);const archive=db.prepare("SELECT a.id FROM sample_archives a JOIN tech_packs tp ON tp.id=a.tech_pack_id WHERE tp.order_id=? AND tp.order_item_id=? AND a.status='locked' ORDER BY a.id DESC LIMIT 1").get(order.id,item.id);if(!seal)seal=await api('POST','/api/confirm/seals',{archive_id:archive.id,order_id:order.id,order_item_id:item.id,sample_name:marker+' '+trial.kind,style_no:item.style_no,version:'V1',attachments:[item.effect_image_url],remark:note});if(!seal.tech_approved)seal=await api('POST','/api/confirm/seals/'+seal.id+'/tech-approve',{row_version:seal.row_version});if(!['sent','confirmed'].includes(seal.status))seal=await api('POST','/api/confirm/seals/'+seal.id+'/send',{row_version:seal.row_version});if(seal.status==='sent')await api('POST','/api/mall/seals/'+seal.id+'/confirm',{accepted:true,row_version:seal.row_version,comment:note},200,true);}});
 await step('allocate-'+trial.kind,async()=>{
  let order=await api('GET','/api/orders/'+trial.order_id);
  if(order.status==='draft'){const c=await api('GET','/api/commitments/order/'+order.id);if(c.review_status!=='approved')await api('POST','/api/commitments/'+c.id+'/review',{front_ok:true,back_ok:true,material_ok:true,promised_date:'2026-11-30',note});await api('POST','/api/orders/'+order.id+'/transition',{to:'tech',note});}
  let cost=await api('GET','/api/costs/'+order.id);if(!cost)cost=await api('POST','/api/costs/'+order.id,{material_cost:2,accessory_cost:1,labor_cost:1,overhead_cost:0.5,other_cost:0.5,profit_rate:10});for(let i=0;i<10&&cost.status!=='approved';i++)cost=await api('POST','/api/costs/'+order.id+'/review',{approve:true,opinion:note});assert.equal(cost.status,'approved');
  order=await api('GET','/api/orders/'+order.id);if(order.status==='tech')await api('POST','/api/orders/'+order.id+'/transition',{to:'finance',note});
  if(!db.prepare('SELECT 1 FROM dispatch_orders WHERE order_id=?').get(order.id)){
   await api('POST','/api/dispatch',{order_id:order.id,type:'own',factory_name:'本厂',qty:3,remark:note},400);
   const body=trial.kind==='outsource'?{factory_id:state.factory_id,type:'outsource'}:{factory_name:'本厂',type:'own'};
   await api('POST','/api/dispatch',{order_id:order.id,...body,qty:2,price:0,remark:note});
  }
  order=await api('GET','/api/orders/'+order.id);if(order.status==='assigned')await api('POST','/api/orders/'+order.id+'/transition',{to:'production',note});
  const factory=await api('GET','/api/node-flow/board?tracking=1&tracking_view=factory&po='+trial.order_no+'&po_mode=exact');const allocation=await api('GET','/api/dispatch/board?po='+trial.order_no+'&po_mode=exact');
  assert.equal(factory.rows.length,trial.kind==='outsource'?0:1);if(trial.kind==='outsource'){assert.equal(allocation.rows.length,1);assert.equal(allocation.rows[0].cells[0].code,'iron');}
 });
 await step('first-'+trial.kind,async()=>{const order=await api('GET','/api/orders/'+trial.order_id);for(const item of order.items){let fa=(await api('GET','/api/first-articles/order/'+order.id+'?order_item_id='+item.id)).fa;if(!fa)fa=await api('POST','/api/first-articles',{order_id:order.id,order_item_id:item.id,batch_qty:2,sample_size:'M',remark:note});if(fa.status==='draft'){if(!db.prepare('SELECT 1 FROM first_article_checks WHERE fa_id=?').get(fa.id))await api('POST','/api/first-articles/'+fa.id+'/checks',{part:marker+' 模拟版型',spec:'内部实测尺寸及缝制',measured:'内部模拟，不代表实物测量',result:'ok',critical:true,remark:note});fa=await api('POST','/api/first-articles/'+fa.id+'/submit',{});}if(fa.status==='submitted')await api('POST','/api/first-articles/'+fa.id+'/release',{result:'passed',release_qty:2,conclusion:note});}});
}
async function cutFlow(trial){
 await step('cut-materials',async()=>{
  const tp=db.prepare("SELECT id FROM tech_packs WHERE order_id=? AND status='confirmed' ORDER BY id DESC LIMIT 1").get(trial.order_id);const mats=db.prepare('SELECT * FROM tech_pack_materials WHERE tech_pack_id=? AND mat_type=?').all(tp.id,'fabric');const sums=new Map();for(const m of mats){if(!m.material_id)throw Error('来源面料未关联档案');const qty=Math.round(m.one_use*(1+(m.loss_rate||0)/100)*2*100)/100;if(qty>0)sums.set(m.material_id,{material_id:m.material_id,name:m.material_name,unit:m.unit,qty,price:m.unit_price||0});}assert(sums.size>0);
  let po=db.prepare('SELECT id FROM purchase_orders WHERE order_id=? AND remark LIKE ? ORDER BY id DESC LIMIT 1').get(trial.order_id,'%'+marker+'%');
  po=po?await api('GET','/api/purchases/'+po.id):await api('POST','/api/purchases',{supplier_id:state.supplier_id,order_id:trial.order_id,order_date:'2026-11-05',expect_date:'2026-11-05',remark:note,items:[...sums.values()]});trial.purchase_id=po.id;save();if(po.status==='draft')po=await api('POST','/api/purchases/'+po.id+'/order',{});
  let grn=db.prepare('SELECT id FROM goods_receipts WHERE po_id=?').get(po.id);grn=grn?await api('GET','/api/receipts/'+grn.id):await api('POST','/api/receipts',{po_id:po.id,receive_date:'2026-11-05',remark:note,items:po.items.map(i=>({po_item_id:i.id,receive_qty:i.qty,dye_lot:marker,location:'内部实测虚拟库位'}))});trial.receipt_id=grn.id;save();if(grn.status!=='passed')await api('POST','/api/receipts/'+grn.id+'/inspect',{items:grn.items.map(i=>({id:i.id,pass_qty:i.pending_qty,freeze_qty:0,reject_qty:0,note}))});
  await api('POST','/api/requirements/calc',{});
 });
 await step('cut-create-and-send',async()=>{
  let cut=await api('GET','/api/cuts/order/'+trial.order_id);trial.cut_order_id=cut.id;save();
  if(cut.status==='draft')cut=await api('POST','/api/cuts/'+cut.id+'/start',{fabric_ready:true,note});
  if(!cut.lots.length)cut=await api('POST','/api/cuts/'+cut.id+'/lots',{dye_lot:marker,layers:1,plan_qty:2,actual_qty:2,operator:user.name,note});
  if(!cut.bundles.length)cut=await api('POST','/api/cuts/'+cut.id+'/bundles/generate',{per_bundle:2});
  for(const bundle of cut.bundles)if(!['checked','handed'].includes(bundle.status))cut=await api('POST','/api/cuts/'+cut.id+'/bundles',{id:bundle.id,status:'checked',note});
  if(cut.status==='cutting')cut=await api('POST','/api/cuts/'+cut.id+'/finish',{qualified_qty:2,reject_qty:0,checked_by:user.name,note});
  if(cut.status==='cut_done')cut=await api('POST','/api/cuts/'+cut.id+'/handover',{note});
  let out=db.prepare('SELECT id FROM cut_dispatches WHERE order_id=? AND demo_tag=?').get(trial.order_id,marker);out=out?await api('GET','/api/cutdispatch/'+out.id):await api('POST','/api/cutdispatch',{cut_order_id:cut.id,factory_id:state.factory_id,bundle_ids:cut.bundles.map(b=>b.id),out_date:'2026-11-05',expect_return_date:'2026-11-30',price:0,note,demo_tag:marker});trial.cut_dispatch_id=out.id;save();if(out.status==='draft')await api('POST','/api/cutdispatch/'+out.id+'/send',{});
  const b=await api('GET','/api/node-flow/board?tracking=1&tracking_view=factory&po='+trial.order_no+'&po_mode=exact');assert(b.rows[0].cells.find(c=>c.code==='sew').name.includes(state.factory_name));
 });
 await step('cut-return',async()=>{let out=await api('GET','/api/cutdispatch/'+trial.cut_dispatch_id);if(['sent','partial'].includes(out.status))out=await api('POST','/api/cutdispatch/'+out.id+'/receive',{receive_date:'2026-11-05',handover_by:'内部实测模拟外协交接人',received_by:user.name+'（内部实测）',inspected_by:user.name+'（内部实测）',inspect_result:'pass',remark:note,items:out.items.map(i=>({dispatch_item_id:i.id,qty:i.qty,accepted_qty:i.qty,rejected_qty:0,rework_qty:0,defect_reason:note}))});if(out.status==='returned')await api('POST','/api/cutdispatch/'+out.id+'/close',{note});
 const sew=db.prepare("SELECT * FROM order_nodes WHERE order_id=? AND code='sew'").get(trial.order_id);if(sew.status!=='done')await api('PATCH','/api/order-nodes/'+sew.id,{status:'done',remark:note+'；模拟外协回货验收合格2件，非本厂员工计件报工'});
 });
 await step('cut-consume-materials',async()=>{
  let issue=db.prepare('SELECT id FROM material_issues WHERE order_id=? AND demo_tag=?').get(trial.order_id,marker);if(!issue){const lines=db.prepare('SELECT material_id,name,unit,qty,price FROM purchase_items WHERE po_id=?').all(trial.purchase_id);issue=await api('POST','/api/matflow/issues',{order_id:trial.order_id,kind:'production',receiver_type:'own',factory_name:'本厂',note,demo_tag:marker,items:lines.map(i=>({...i,req_qty:i.qty,remark:note}))});}trial.issue_id=Number(issue.id);save();let full=await api('GET','/api/matflow/issues/'+issue.id);if(full.status==='draft')full=await api('POST','/api/matflow/issues/'+issue.id+'/prepare',{});if(full.status==='prepared')await api('POST','/api/matflow/issues/'+issue.id+'/issue',{note});full=await api('GET','/api/matflow/issues/'+issue.id);if(full.status==='issued')await api('POST','/api/matflow/issues/'+issue.id+'/close',{note});
 });
}
async function finish(trial){
 await step('reports-'+trial.kind,async()=>{const nodes=await api('GET','/api/order-nodes?order_id='+trial.order_id);const item=db.prepare('SELECT id FROM order_items WHERE order_id=?').get(trial.order_id);const iron=nodes.find(n=>n.code==='iron');for(const n of nodes){if(['instock','ship'].includes(n.code)||trial.kind.startsWith('cut')&&['sew','cut'].includes(n.code)||trial.kind==='outsource'&&n.seq<iron.seq)continue;await api('POST','/api/reports',{order_id:trial.order_id,node_id:n.id,item_id:item.id,color:'蓝色',qty_ok:2,qty_defect:0,hours:0.1,employee_id:8,operator:user.name,remark:note,request_no:'ALLOC_20261105_'+trial.order_id+'_'+n.id,report_date:'2026-11-05'});}});
 await step('qc-'+trial.kind,async()=>{let q=db.prepare("SELECT id,status FROM qc_inspections WHERE order_id=? AND type='final'").get(trial.order_id);if(!q)q=await api('POST','/api/qc/inspections',{order_id:trial.order_id,type:'final',sample_qty:2,inspector:user.name+'（内部实测）',remark:note});if(q.status!=='done')await api('POST','/api/qc/inspections/'+q.id+'/finish',{aql_result:'pass',sample_qty:2,pass_qty:2,fail_qty:0,remark:note,create_issue:false});});
 await step('close-'+trial.kind,async()=>{let o=await api('GET','/api/orders/'+trial.order_id);if(o.status==='production')await api('POST','/api/stock/instock',{order_id:o.id,warehouse:'cn',remark:note});o=await api('GET','/api/orders/'+o.id);if(o.status==='instock')await api('POST','/api/stock/ship',{order_id:o.id,warehouse:'cn',remark:note});for(const inv of db.prepare("SELECT * FROM ar_invoices WHERE order_id=? AND status<>'void'").all(o.id)){const open=Math.round((inv.amount-inv.paid_amount)*100)/100;if(open>0)await api('POST','/api/finance/payments',{direction:'in',partner_id:state.customer_id,partner_name:marker+' 模拟收款',currency:'CNY',amount:open,method:'内部实测模拟（无实际资金）',pay_date:'2026-11-05',remark:note,allocations:[{invoice_id:inv.id,amount:open}]});}o=await api('GET','/api/orders/'+o.id);if(o.status==='shipped')await api('POST','/api/orders/'+o.id+'/transition',{to:'closed',note});});
}
(async()=>{
 const health=await(await fetch(BASE+'/api/health')).json();assert(health.ok);
 if(!fs.existsSync(path.join(folder,'before.db')))await backup(db,path.join(folder,'before.db'));
 await step('prepare',async()=>{const products=await api('GET','/api/pre-orders/available-products');assert(products.length);state.archive_id=products[0].id;state.customer_id=db.prepare("SELECT id FROM customers WHERE status='active' ORDER BY id LIMIT 1").get().id;const f=db.prepare("SELECT id,name FROM factories WHERE status='active' AND type<>'own' ORDER BY id LIMIT 1").get();state.factory_id=f.id;state.factory_name=f.name;state.supplier_id=db.prepare("SELECT id FROM suppliers WHERE status='active' ORDER BY id LIMIT 1").get().id;state.before_material_stock=db.prepare('SELECT id,stock_qty FROM materials').all();state.health=health;});
 await customerLogin();
 // 旧样衣资料缺失作为阻断用例保留；不改原档案，不伪造物料关联。
 const blocked=state.trials.find(t=>t.kind==='cut');
 if(blocked?.order_id && db.prepare('SELECT 1 FROM tech_pack_materials m JOIN tech_packs t ON t.id=m.tech_pack_id WHERE t.order_id=? AND (m.material_id IS NULL OR m.one_use<=0)').get(blocked.order_id)){
  blocked.blocked_reason='来源冻结样衣物料未关联档案且单件用量为0；阻断裁片备料，保留异常用例';
  await step('record-source-block',async()=>{const n=db.prepare("SELECT id,remark FROM order_nodes WHERE order_id=? AND code='layout'").get(blocked.order_id);await api('PATCH','/api/order-nodes/'+n.id,{remark:(n.remark||'')+' '+note+'；'+blocked.blocked_reason});});
  await step('verify-source-start-block',async()=>{const cut=await api('GET','/api/cuts/order/'+blocked.order_id);blocked.blocked_cut_order_id=cut.id;save();const failure=await api('POST','/api/cuts/'+cut.id+'/start',{fabric_ready:true,note},400);assert(/面料|齐套/.test(failure.message));blocked.system_block_message=failure.message;save();});
  if(!state.trials.some(t=>t.kind==='cut_valid')){const choices=await api('GET','/api/pre-orders/available-products');const chosen=choices.find(a=>{const snap=JSON.parse(db.prepare('SELECT snapshot FROM sample_archives WHERE id=?').get(a.id).snapshot);return snap.materials?.length&&snap.materials.every(m=>m.material_id&&m.one_use>0);});assert(chosen,'需要资料完整的冻结样衣');state.trials.push({kind:'cut_valid',order_no:'SCBH-20261105-A04',qty:2,archive_id:chosen.id});save();}
 }
 for(const trial of state.trials){if(trial.blocked_reason)continue;await create(trial);if(trial.kind.startsWith('cut'))await cutFlow(trial);await finish(trial);}
 await api('PUT','/api/mall-admin/accounts/'+state.customer_account_id,{status:'disabled'});
 state.finished_at=new Date().toISOString();delete state.last_error;save();await backup(db,path.join(folder,'after.db'));console.log(JSON.stringify({done:true,orders:state.trials.map(t=>({id:t.order_id,no:t.order_no,kind:t.kind})),folder}));
})().catch(e=>{state.last_error={at:new Date().toISOString(),message:e.message};save();console.error(e.stack);process.exitCode=1;}).finally(()=>db.close());
