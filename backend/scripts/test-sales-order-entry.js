/** 独立临时库集成回归：原子建单、主档边界、金额、草稿 CAS 和重试。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
process.chdir(path.resolve(__dirname,'..'));
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-sales-entry-'));process.env.DB_PATH=path.join(folder,'__SMOKE.db');process.env.ERP_SCHEDULER='0';require('dotenv').config();
const {db,now}=require('../src/db');let server,checks=0,token;const port=39783,base='http://127.0.0.1:'+port;
const check=(v,m)=>{assert.ok(v,m);checks++;};
const insert=(table,data)=>{const cols=db.prepare('PRAGMA table_info('+table+')').all();for(const col of cols)if(col.notnull&&col.name.endsWith('_at')&&data[col.name]===undefined)data[col.name]=now();const keys=Object.keys(data);return Number(db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?')})`).run(...keys.map(k=>data[k])).lastInsertRowid);};
async function api(method,url,body,status=200){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));checks++;return j.data;}
(async()=>{
 const t=now(),admin=db.prepare("SELECT * FROM users WHERE username='admin'").get();token=require('jsonwebtoken').sign({sub:admin.id,tv:0},require('../src/config').jwtSecret);
 const customer=insert('customers',{name:'__SMOKE下单客户',status:'active',contact:'__SMOKE收货人',shipping_address:'__SMOKE地址',created_at:t});
 const supplier=insert('suppliers',{name:'__SMOKE档案供应商',status:'active',created_at:t});
 const material=insert('materials',{name:'__SMOKE档案面料',type:'fabric',unit:'米',width:'165',weight:'220',air_gap:'80%',composition:'档案成分',supplier_id:supplier,supplier:'旧简称',status:'active',version:1,created_at:t,updated_at:t});
 const sampleId=require('./sales-entry-sample-fixture')(db,now());
 server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port)},windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));try{if((await fetch(base+'/api/health')).ok)break;}catch{}}
 await api('GET','/api/orders/entry/salespeople');const d=await api('GET','/api/orders/entry/draft?scope_key=new');check(d.version===0&&!d.payload,'new draft empty');
 const body={entry_version:1,request_no:'__SMOKE-entry-request-0001',scope_key:'new',draft_version:0,order_no:'__SMOKE-ENTRY-01',type:'custom',customer_id:customer,shop_name:'__SMOKE店铺',shop_order_no:'__SMOKE-PO',delivery_days:30,tags:['__SMOKE'],freight:1,discount:2,surcharge:3,deposit:5,items:[{sample_archive_id:sampleId,product_name:'__SMOKE款',tax_rate:10,colors:[{color:'红',sizes:[{size:'S',qty:2,usd_price:4},{size:'M',qty:3,usd_price:4}]}],materials:[{material_id:material,archive_version:1,name:'伪造料名',supplier:'伪造供应商',spec:'伪造规格',unit:'个',ingredient:'本单成分',one_use:0.4,loss:10,price:2,air_gap:1,colors:[{colorway:'红',color_no:'红/01',price:3,qty:null,sizes:[{size:'M',one_use:0.5}]}]}]}]};
 check((await api('GET','/api/orders/entry/sample-materials/'+sampleId)).length===0,'sample materials use frozen sample');check((await api('GET','/api/orders/entry/samples')).some(a=>a.id===sampleId),'completed sample visible');
 db.prepare("UPDATE pattern_flows SET status='running' WHERE tech_pack_id=(SELECT tech_pack_id FROM sample_archives WHERE id=?)").run(sampleId);check(!(await api('GET','/api/orders/entry/samples')).some(a=>a.id===sampleId),'unfinished sample hidden');await api('GET','/api/orders/entry/sample-materials/'+sampleId,undefined,409);await api('POST','/api/orders',body,409);
 db.prepare("UPDATE pattern_flows SET status='done' WHERE tech_pack_id=(SELECT tech_pack_id FROM sample_archives WHERE id=?)").run(sampleId);db.prepare("UPDATE pattern_stages SET status='pending' WHERE stage='biz'").run();check(!(await api('GET','/api/orders/entry/samples')).some(a=>a.id===sampleId),'incomplete stage hidden');await api('POST','/api/orders',body,409);db.prepare("UPDATE pattern_stages SET status='done' WHERE stage='biz'").run();
 await api('POST','/api/orders',{...body,items:body.items.map(i=>({...i,sample_archive_id:null}))},400);check(!db.prepare('SELECT 1 FROM orders').get(),'invalid sample creates no order');
 // Duplicate checks use authoritative archive style; forged client style cannot bypass them.
 await api('POST','/api/orders',{...body,items:[body.items[0],{...body.items[0],style_no:'FORGED-OTHER'}]},400);
 const sameStyleId=require('./sales-entry-sample-fixture')(db,now(),{archiveNo:'__SMOKE-OTHER-ARCHIVE'});
 const catalog=await api('GET','/api/orders/entry/samples');check(catalog.filter(a=>a.style_no==='__SMOKE-STYLE-01').length===1,'catalog deduplicates completed same style');
 await api('POST','/api/orders',{...body,items:[body.items[0],{...body.items[0],sample_archive_id:sameStyleId,style_no:'FORGED-OTHER'}]},400);
 check(!db.prepare('SELECT 1 FROM orders').get(),'duplicate styles rejected before any order write');
 const saved=await api('PUT','/api/orders/entry/draft',{scope_key:'new',version:0,payload:body});check(saved.version===1,'draft version advanced');
 await api('PUT','/api/orders/entry/draft',{scope_key:'new',version:0,payload:body},409);body.draft_version=1;
 const order=await api('POST','/api/orders',body);check(order.total_usd===24,'server total goods20 tax2 freight1 surcharge3 discount2');check(order.recipient_name==='__SMOKE收货人'&&order.shipping_address==='__SMOKE地址','customer shipping snapshot');
 const meta=JSON.parse(order.entry_json);check(meta.deposit_usd===5&&meta.balance_usd===19,'deposit agreement persisted');check(!db.prepare("SELECT 1 FROM payments WHERE remark LIKE '%__SMOKE-ENTRY-01%'").get(),'no payment fabricated');
 const mats=await api('GET','/api/order-materials?order_id='+order.id);check(mats.length===1&&mats[0].name==='__SMOKE档案面料'&&mats[0].supplier==='__SMOKE档案供应商'&&mats[0].unit==='米','material canonical snapshot');check(mats[0].spec.includes('165')&&!mats[0].spec.includes('伪造'),'spec authoritative');check(mats[0].ingredient==='本单成分','order-only composition');check(mats[0].total_use===3.16&&mats[0].amount===9.49,'color price size usage loss and air gap centrally calculated');check(db.prepare('SELECT composition FROM materials WHERE id=?').get(material).composition==='档案成分','master unchanged');
 const replay=await api('POST','/api/orders',body);check(replay.id===order.id,'same request replay returns same order');await api('POST','/api/orders',{...body,remark:'different'},409);
 const originalItem=order.items[0].id;
 const edited=await api('PUT','/api/orders/'+order.id+'/items',{items:[{...order.items[0],sizes:[{color:'红',size:'S',qty:3,usd_price:4},{color:'红',size:'M',qty:3,usd_price:4}]}]});
 check(edited.items[0].id===originalItem,'editing keeps item identity');check(edited.total_usd===28.4&&JSON.parse(edited.entry_json).deposit_usd===5,'editing retains tax discount freight and deposit');
 const recalced=await api('GET','/api/order-materials?order_id='+order.id);check(recalced[0].item_id===originalItem&&recalced[0].total_use===3.71&&recalced[0].amount===11.14,'quantity edit recalculates material without orphan');
 const cleared=await api('GET','/api/orders/entry/draft?scope_key=new');check(!cleared.payload&&cleared.version===2,'successful submission clears own active draft');await api('PUT','/api/orders/entry/draft',{scope_key:'new',version:1,payload:body},409);
 const before=db.prepare('SELECT count(*) n FROM orders').get().n;
 const next={...body,request_no:'__SMOKE-entry-request-0002',order_no:'__SMOKE-ENTRY-02',draft_version:2};
 await api('POST','/api/orders',{...next,items:[{...body.items[0],materials:[{...body.items[0].materials[0],archive_version:0}]}]},409);
 await api('POST','/api/orders',{...next,discount:9999},400);await api('POST','/api/orders',{...next,deposit:9999},400);await api('POST','/api/orders',{...next,shop_name:''},400);
 await api('POST','/api/orders',{...next,items:[{...body.items[0],materials:[{material_id:999999}]}]},400);check(db.prepare('SELECT count(*) n FROM orders').get().n===before,'validation failures leave no parent rows');
 // Force a write failure after order and item insert: whole transaction, including consumed draft, must roll back.
 db.exec("CREATE TRIGGER __SMOKE_fail_material BEFORE INSERT ON order_materials BEGIN SELECT RAISE(ABORT,'__SMOKE rollback'); END");await api('POST','/api/orders',next,500);db.exec('DROP TRIGGER __SMOKE_fail_material');check(!db.prepare('SELECT 1 FROM orders WHERE order_no=?').get(next.order_no),'late material failure rolls back order');check(!db.prepare('SELECT 1 FROM order_items i LEFT JOIN orders o ON o.id=i.order_id WHERE o.id IS NULL').get(),'no item orphan');
 const cny=await api('POST','/api/orders',{...next,request_no:'__SMOKE-entry-cny-000003',order_no:'__SMOKE-CNY',rate:9999,items:[{sample_archive_id:sampleId,product_name:'__SMOKE人民币款',currency:'CNY',tax_rate:0,colors:[{color:'红',sizes:[{size:'S',qty:2,entry_price:26,usd_price:999}]}],materials:[]}]});check(cny.rate===6.5&&cny.items[0].amount_usd===8&&cny.total_usd===10,'CNY calculated by server system rate; forged USD/rate ignored');
 const other=insert('users',{username:'__SMOKE-entry-other',password_hash:'unused',role:'sales',active:1,company_id:1,created_at:t});token=require('jsonwebtoken').sign({sub:other,tv:0},require('../src/config').jwtSecret);check(!(await api('GET','/api/orders/entry/draft?scope_key=new')).payload,'other account cannot read draft');
 console.log(JSON.stringify({checks,failed:0,folder}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{server?.kill();db.close();});
