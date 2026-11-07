/** __SMOKE 独立库：档位、颜色汇总、员工扫码、计价快照、幂等与月度计件。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-wage-multiplier-'));process.env.DB_PATH=path.join(folder,'__SMOKE.db');process.env.ERP_SCHEDULER='0';require('dotenv').config();
const {db,now}=require('../src/db'),WM=require('../src/services/wageMultiplier'),PW=require('../src/services/pieceWage');let server,token,checks=0;const check=(v,msg)=>{assert.ok(v,msg);checks++;};
const expectThrow=(fn,status)=>{assert.throws(fn,e=>!status||e.status===status);checks++;};
async function request(route,body,status=200,method){const r=await fetch('http://127.0.0.1:39763'+route,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined});const j=await r.json();assert.equal(r.status,status,route+': '+JSON.stringify(j));checks++;return j.data;}
(async()=>{
 const emp=Number(db.prepare("INSERT INTO employees(name,code,status,company_id,created_at) VALUES('__SMOKE计件','__SMOKE-wage','active',1,?)").run(now()).lastInsertRowid);
 const uid=Number(db.prepare("INSERT INTO users(username,name,password_hash,role,active,company_id,employee_id,created_at) VALUES('__SMOKE-worker','__SMOKE计件','unused','employee',1,1,?,?)").run(emp,now()).lastInsertRowid);
 const order=Number(db.prepare("INSERT INTO orders(order_no,status,company_id,created_at,updated_at) VALUES('__SMOKE-WAGE','production',1,?,?)").run(now(),now()).lastInsertRowid);
 const item=Number(db.prepare("INSERT INTO order_items(order_id,product_name,style_no,qty) VALUES(?,'__SMOKE款','__SMOKE-STYLE',25)").run(order).lastInsertRowid);
 const sizes=db.prepare('INSERT INTO order_item_sizes(item_id,color,size,qty) VALUES(?,?,?,?)');sizes.run(item,'红','S',8);sizes.run(item,'红','M',12);sizes.run(item,'蓝','S',5);
 const nodeId=Number(db.prepare("INSERT INTO order_nodes(order_id,name,code,status,created_at) VALUES(?,'备料','prep','doing',?)").run(order,now()).lastInsertRowid);const node=db.prepare('SELECT * FROM order_nodes WHERE id=?').get(nodeId);
 PW.saveRate({style_no:'__SMOKE-STYLE',process_name:'备料',unit_price:0.4,effective_from:'2026-01-01'},'__SMOKE');
 const cut=Number(db.prepare("INSERT INTO cut_orders(cut_no,order_id,style_no) VALUES('__SMOKE-CUT',?,'__SMOKE-STYLE')").run(order).lastInsertRowid);
 db.prepare("INSERT INTO cut_bundles(cut_order_id,bundle_no,color,size,qty) VALUES(?,'__SMOKE-B1','红','S',1)").run(cut);
 check(WM.quote(order,node,{bundle_no:'__SMOKE-B1'}).color_qty===20,'Bundle size must not change color tier');
 const base=WM.read();check(base.tiers.length===5,'Default tiers');
 check(WM.quote(order,node,{item_id:item,color:'红',report_date:'2026-11-03'}).unit_price===0.48,'0.4 × 1.2 = 0.48');
 check(WM.quote(order,node,{item_id:item,color:'蓝',report_date:'2026-11-03'}).unit_price===0.864,'Unit precision is not rounded prematurely');
 check(WM.quote(order,node,{}).requires_selection,'Multiple colors require explicit selection');
 const bounds=[[1,3],[2,2.16],[5,2.16],[6,1.8],[10,1.8],[11,1.44],[19,1.44],[20,1.2],[21,1.2]];
 for(const [qty,factor]of bounds){db.prepare("UPDATE order_item_sizes SET qty=? WHERE item_id=? AND color='蓝'").run(qty,item);check(WM.quote(order,node,{item_id:item,color:'蓝'}).multiplier===factor,'Boundary '+qty);}
 db.prepare("UPDATE order_item_sizes SET qty=5 WHERE item_id=? AND color='蓝'").run(item);
 expectThrow(()=>WM.save({...base,tiers:[{min:1,max:5,multiplier:1},{min:7,max:null,multiplier:2}]},{username:'__SMOKE'}),400);
 expectThrow(()=>WM.save({...base,tiers:[{min:1,max:5,multiplier:1},{min:5,max:null,multiplier:2}]},{username:'__SMOKE'}),400);
 expectThrow(()=>WM.save({...base,tiers:[{min:1,max:null,multiplier:0}]},{username:'__SMOKE'}),400);
 expectThrow(()=>WM.quote(order,node,{item_id:item,color:'不存在'}),400);
 server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:'39763'},windowsHide:true,stdio:'ignore'});
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));try{if((await fetch('http://127.0.0.1:39763/api/health')).ok)break;}catch{}}
 token=require('jsonwebtoken').sign({sub:uid,tv:0},require('../src/config').jwtSecret);
 const q=await request('/api/self/work-quote?node_id='+nodeId+'&item_id='+item+'&color='+encodeURIComponent('红'));check(q.color_qty===20&&q.multiplier===1.2,'Color quantities combine all sizes');
 await request('/api/self/work-order/'+order);await request('/api/settings/piece-multipliers',{revision:0,enabled:false,tiers:base.tiers},403,'PUT');
 const body={node_id:nodeId,order_id:order,qty_ok:2,qty_defect:0,report_date:'2026-11-03',item_id:item,color:'红',wage_config_revision:0,request_no:'__SMOKE_report_0001',employee_id:9999,operator:'伪造人',base_unit_price:999,multiplier:999};
 const report=await request('/api/self/work-report',body);const saved=JSON.parse(report.wage_snapshot);
 check(report.employee_id===emp&&report.operator==='__SMOKE计件','Worker identity cannot be spoofed');check(saved.unit_price===0.48&&saved.base_unit_price===0.4&&saved.multiplier===1.2,'Client prices ignored');
 check((await request('/api/self/work-report',body)).id===report.id,'Idempotent retry returns same report');
 await request('/api/self/work-report',{...body,qty_ok:3},409);
 check(db.prepare('SELECT COUNT(*) AS n FROM production_reports').get().n===1,'Duplicate submission cannot add wages');
 await request('/api/self/work-report',{...body,request_no:'__SMOKE_report_0002',qty_ok:21},400);
 check(db.prepare('SELECT COUNT(*) AS n FROM production_reports').get().n===1,'Over-color-cap rollback');
 let config=WM.save({revision:0,enabled:true,tiers:base.tiers.map(t=>({...t,multiplier:2}))},{username:'__SMOKE-admin'});
 expectThrow(()=>WM.save({revision:0,enabled:true,tiers:base.tiers},{username:'__SMOKE-admin'}),409);
 await request('/api/self/work-report',{...body,request_no:'__SMOKE_report_0003'},409);
 db.prepare("UPDATE piece_rates SET unit_price=0.9 WHERE process_name='备料'").run();
 const preview=PW.preview('2026-11',1);check(preview.items.length===1&&preview.items[0].unit_price===0.48&&preview.items[0].amount===0.96,'Month preview uses report price snapshot');
 const run=PW.createRun('2026-11','__SMOKE-admin','__SMOKE倍率快照',1);check(run.items[0].unit_price===0.48&&JSON.parse(run.items[0].wage_snapshot).multiplier===1.2,'Payrun persists price basis');
 check(PW.getRun(run.id,1).total_amount===0.96,'Saved payrun stable after settings edits');
 const legacy={order_id:order,wage_snapshot:null};check(WM.reportPrice(legacy,{rate:{unit_price:0.4},source:'generic'}).rate.unit_price===0.4,'Legacy reports do not gain retroactive multiplier');
 config=WM.save({revision:config.revision,enabled:false,tiers:base.tiers},{username:'__SMOKE-admin'});check(WM.quote(order,node,{item_id:item,color:'红'}).multiplier===1,'Disabled multiplier applies 1 to new work');
 // 参与范围：类别、单个生产工序、具体档案，以及完全不参与。
 const selected={mode:'selected',categories:['sewing'],craft_type_ids:[],node_codes:[]};
 config=WM.save({revision:config.revision,enabled:true,tiers:base.tiers,process_scope:selected},{username:'__SMOKE-admin'});
 let scoped=WM.quote(order,node,{item_id:item,color:'红'});check(scoped.multiplier===1&&!scoped.participates,'Non-selected process uses base price');
 scoped=WM.quote(order,{...node,code:'sew'},{item_id:item,color:'红'});check(scoped.multiplier===1.2&&scoped.participates&&scoped.process_category==='sewing','Stable node code survives rename');
 expectThrow(()=>WM.save({revision:config.revision,enabled:true,tiers:base.tiers,process_scope:{...selected,categories:['fake']}},{username:'__SMOKE-admin'}),400);
 expectThrow(()=>WM.save({revision:config.revision,enabled:true,tiers:base.tiers,process_scope:{...selected,craft_type_ids:[999999]}},{username:'__SMOKE-admin'}),400);
 config=WM.save({revision:config.revision,enabled:true,tiers:base.tiers,process_scope:{...selected,categories:[],node_codes:['prep']}},{username:'__SMOKE-admin'});
 check(WM.quote(order,node,{item_id:item,color:'红'}).participates,'Specific production node may participate');
 const craftId=Number(db.prepare("INSERT INTO craft_types(name,category,status,created_at,updated_at) VALUES('平车','sewing','active',?,?)").run(now(),now()).lastInsertRowid);
 config=WM.save({revision:config.revision,enabled:true,tiers:base.tiers,process_scope:{...selected,categories:[],craft_type_ids:[craftId]}},{username:'__SMOKE-admin'});
 scoped=WM.quote(order,{...node,code:'c_1',name:'平车'},{item_id:item,color:'红'});check(scoped.participates&&scoped.matched_craft_type_id===craftId,'Individual craft archive selection');
 check(!WM.quote(order,{...node,code:'pack',name:'平车'},{item_id:item,color:'红'}).participates,'Builtin category cannot be spoofed by renamed label');
 config=WM.save({revision:config.revision,enabled:true,tiers:base.tiers,process_scope:{...selected,categories:[]}},{username:'__SMOKE-admin'});
 check(WM.quote(order,node,{item_id:item,color:'红'}).multiplier===1,'Empty selection means none');
 check(JSON.parse(PW.getRun(run.id,1).items[0].wage_snapshot).multiplier===1.2,'Scope edits preserve prior wage snapshots');
 check(WM.view().process_catalog.categories.length===7&&WM.view().process_catalog.nodes.some(n=>n.code==='prep'),'Scope catalog is server owned');
 console.log('PASS '+checks+' wage multiplier assertions');
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{if(server){server.kill();await new Promise(r=>server.once('exit',r));}db.close();fs.rmSync(folder,{recursive:true,force:true});});
