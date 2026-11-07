/** 浏览器真实填单回归，所有写入限定 __SMOKE 临时库。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
process.chdir(path.resolve(__dirname,'..'));
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-entry-ui-'));process.env.DB_PATH=path.join(folder,'__SMOKE.db');process.env.ERP_SCHEDULER='0';require('dotenv').config();
const {db,now}=require('../src/db');let server,chrome,ws,checks=0;const port=39784,debug=9974,base='http://127.0.0.1:'+port,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(v,m)=>{assert.ok(v,m);checks++;};const shots=path.resolve('../shots/sales-entry');fs.mkdirSync(shots,{recursive:true});
(async()=>{
 const svc=require('../src/services/nodeFlow');const tpl=svc.saveTemplate({name:'__SMOKE跟踪流程',is_default:1}); for(const [code,name] of Object.entries(svc.BUILTIN_CODES))db.prepare("INSERT INTO node_template_items(template_id,code,name,seq,required,builtin,visible,status,created_at,updated_at) VALUES(?,?,?,?,1,1,1,'active',?,?)").run(tpl.id,code,name,svc.BUILTIN_ORDER.indexOf(code),now(),now());
 const today=require('../src/utils/time').localDate(now());
 db.prepare("INSERT INTO customers(name,status,created_at,updated_at) VALUES('__SMOKE跟踪客户','active',?,?)").run(now(),now());
 for(let i=0;i<15;i++){
  const id=Number(db.prepare("INSERT INTO orders(order_no,cus_order_no,type,customer_id,style_name,manager,status,order_date,delivery_date,node_template_id,created_at,updated_at,company_id) VALUES(?,?,'custom',1,?,? ,?, ?,?,?,?, ?,?)").run('__SMOKE-PO-'+i,'__SMOKE-CPO-'+i,'__SMOKE款'+i,i%2?'__SMOKE甲':'__SMOKE乙',i===14?'closed':i===13?'cancelled':i===12?'finance':'production','2026-11-01',i<2?'2026-01-01':today,i===12?null:tpl.id,now(),now(),i===11?2:1).lastInsertRowid);
  db.prepare("INSERT INTO order_items(order_id,product_name,style_no,color,qty) VALUES(?,? ,?,'红,蓝',100)").run(id,'__SMOKE商品'+i,'__SMOKE款'+i);
  if(i!==12){svc.ensureNodes(id);const sew=svc.findByCode(id,'sew');db.prepare("INSERT INTO production_reports(order_id,node_id,node_name,qty_ok,created_at) VALUES(?,?,?,50,?)").run(id,sew.id,sew.name,now());}
 }
 db.prepare("INSERT INTO order_crafts(order_id,name,is_out,created_at) VALUES(1,'__SMOKE印花',1,?)").run(now());
 db.prepare("INSERT INTO order_node_logs(order_id,node_id,action,detail,created_at) VALUES(1,1,'remark','__SMOKE缺料沟通',?)").run(now());
 db.prepare("UPDATE order_nodes SET status='done',actual_date='2026-11-05T03:00:00Z' WHERE order_id=15 AND code='ship'").run();
 const second=svc.saveTemplate({name:'__SMOKE第二流程'});
 db.prepare("INSERT INTO node_template_items(template_id,code,name,seq,required,builtin,visible,status,created_at,updated_at) VALUES(?,'__SMOKE_special','__SMOKE特别工序',1,0,0,1,'active',?,?)").run(second.id,now(),now());
 db.prepare('UPDATE orders SET node_template_id=? WHERE id=10').run(second.id);
 db.prepare("INSERT INTO order_nodes(order_id,template_id,code,name,seq,status,created_at) VALUES(10,?,'__SMOKE_special','__SMOKE特别工序',1,'pending',?)").run(second.id,now());
 const opts={tracking:true,limit:5000};
 check(svc.board(opts).rows.find(r=>r.id===10).cells.some(c=>c.code==='__SMOKE_special'),'all templates retain their own process columns');
 check(svc.board(opts).rows.length===15,'tracking includes history and unassigned');
 check(svc.board({...opts,po:'__SMOKE-PO-1',poMode:'exact'}).rows.length===1,'exact PO independent filter');
 check(svc.board({...opts,po:'__SMOKE-CPO-1',poMode:'exact'}).rows[0].id===2,'customer PO exact');
 check(svc.board({...opts,style:'款14'}).rows.length===1,'style filter');
 check(svc.board({...opts,communication:'缺料'}).rows[0].id===1,'communication filter');
 check(svc.board({...opts,outCraft:true}).rows.length===1,'outsource toggle uses crafts not missing due');
 check(svc.board({...opts,noNodes:true}).rows[0].id===13,'no nodes includes template null finance');
 check(svc.board({...opts,completedFrom:'2026-11-05',completedTo:'2026-11-05'}).rows[0].id===15,'completion date uses ship fact');
 check(svc.board({...opts,batch:'__SMOKE-PO-1\n__SMOKE款3'}).rows.length===2,'batch exact multi search');
 check(svc.board({...opts,companyId:1}).rows.every(r=>r.company_id!==2)&&svc.board({...opts,companyId:1}).rows.length===14,'company scope filters before summaries');
 check(svc.board({...opts,sort:'due',sortDir:'asc'}).rows[0].delivery_date==='2026-01-01','ascending sort');
 check(svc.board({...opts,sort:'due',sortDir:'desc'}).rows[0].delivery_date===today,'descending sort');
 check(svc.board(opts).rows[0].cells.find(c=>c.code==='sew').progress===50,'node quantity progress');
 check(svc.board({...opts,limit:2}).truncated&&svc.board({...opts,limit:2}).matched_total===15,'explicit truncation');
 assert.throws(()=>svc.board({...opts,orderFrom:'2026-12-01',orderTo:'2026-01-01'}),/开始日期/);checks++;
 assert.throws(()=>svc.board({...opts,batch:Array.from({length:101},(_,i)=>'PO'+i).join(' ')}),/100/);checks++;
 // 分流夹具：纯整单外发、本厂、已发出裁片、草稿裁片及待分配。
 db.prepare("INSERT INTO factories(name,type,status,created_at) VALUES('__SMOKE本厂','own','active',?)").run(now());
 db.prepare("INSERT INTO factories(name,type,status,created_at) VALUES('__SMOKE外发厂','outsource','active',?)").run(now());
 for(let id=1;id<=15;id++){if(id===13)continue;db.prepare("INSERT INTO dispatch_orders(order_id,factory_id,factory_name,type,qty,status,created_at) VALUES(?,?,?,?,100,'dispatched',?)").run(id,id===1?2:1,id===1?'__SMOKE外发厂':'__SMOKE本厂',id===1?'outsource':'own',now());}
 db.prepare("INSERT INTO cut_orders(cut_no,order_id,status,created_at,updated_at) VALUES('__SMOKE-CUT-2',2,'handed',?,?)").run(now(),now());
 db.prepare("INSERT INTO cut_dispatches(dispatch_no,cut_order_id,order_id,factory_id,factory_name,out_date,status,out_qty,created_at,updated_at) VALUES('__SMOKE-CD-2',1,2,2,'__SMOKE外发厂',?,'sent',100,?,?)").run(today,now(),now());
 db.prepare("INSERT INTO cut_orders(cut_no,order_id,status,created_at,updated_at) VALUES('__SMOKE-CUT-3',3,'draft',?,?)").run(now(),now());
 db.prepare("INSERT INTO cut_dispatches(dispatch_no,cut_order_id,order_id,factory_id,factory_name,out_date,status,created_at,updated_at) VALUES('__SMOKE-CD-3',2,3,2,'__SMOKE外发厂',?,'draft',?,?)").run(today,now(),now());
 db.prepare("INSERT INTO cost_sheets(order_id,status,created_at,updated_at) VALUES(13,'approved',?,?)").run(now(),now());
 const factoryRows=svc.board({...opts,trackingView:'factory'}).rows;
 check(factoryRows.length===13&&!factoryRows.some(r=>[1,13].includes(r.id)),'factory module excludes whole outsourced and unassigned');
 check(factoryRows.find(r=>r.id===2).cells.find(c=>c.code==='sew').name.includes('__SMOKE外发厂'),'cut sewing shows destination factory');
 check(factoryRows.find(r=>r.id===3).cells.find(c=>c.code==='sew').name==='车缝','draft cut dispatch does not change sewing');
 const allocationRows=svc.board({...opts,trackingView:'assignment'}).rows;
 check(allocationRows.length===2&&allocationRows.some(r=>r.id===13),'allocation module contains pending and whole outsourcing');
 check(allocationRows.find(r=>r.id===1).cells[0].code==='iron','whole outsourcing starts at finishing by stable code');
 check(db.prepare("SELECT COUNT(*) n FROM order_nodes WHERE order_id=1").get().n===13,'display trimming does not remove nodes');
 check(svc.board({...opts,tracking:false,po:'__SMOKE-PO-0',poMode:'exact'}).rows[0].cells[0].code==='prep','original node board unaffected');
 server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port)},windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){await sleep(100);try{if((await fetch(base+'/api/health')).ok)break;}catch{}}
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--user-data-dir='+path.join(folder,'chrome'),'--remote-debugging-port='+debug,'--window-size=1920,1080','about:blank'],{windowsHide:true,stdio:'ignore'});
 let target;for(let i=0;i<80;i++){await sleep(100);try{target=(await(await fetch('http://127.0.0.1:'+debug+'/json')).json()).find(x=>x.type==='page');if(target)break;}catch{}}
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let next=0;const pending=new Map(),errors=[];const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,t=setTimeout(()=>reject(Error('CDP timeout '+method)),10000);pending.set(id,r=>{clearTimeout(t);resolve(r)});ws.send(JSON.stringify({id,method,params}));});let rejectNextDialog=false,dialogCount=0;ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening'){dialogCount++;send('Page.handleJavaScriptDialog',{accept:!rejectNextDialog,promptText:'__SMOKE模板'});rejectNextDialog=false;}};
 const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r?.result?.value;};
 const token=require('jsonwebtoken').sign({sub:db.prepare("SELECT id FROM users WHERE username='admin'").get().id,tv:0},require('../src/config').jwtSecret);await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:base+'/login'});await sleep(350);await ev('localStorage.setItem("erp_token",'+JSON.stringify(token)+');localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify({id:1,name:'__SMOKE管理员',username:'admin',role:'admin'}))+')');await send('Page.navigate',{url:base+'/order-tracking'});await sleep(1500);


 for(const station of ['cut','warehouse','workshop','finish']){
 await send('Page.navigate',{url:base+'/production?station='+station});await sleep(650);
 check(await ev('!!document.querySelector(".ops-workbench")'),'renders '+station);
 check(await ev('document.querySelectorAll(".ops-queues button").length>2'),'queues '+station);
 check(await ev('!document.body.textContent.includes("数据读取失败")'),'API '+station);
 }
 await send('Page.navigate',{url:base+'/pattern-board?workbench=sample'});await sleep(650);
 check(await ev('!!document.querySelector(".sample-workbench")'),'sample room renders');
 const r=await fetch(base+'/api/self/review-notices',{headers:{Authorization:'Bearer '+token}});check(r.ok,'notice HTTP succeeds');const j=await r.json();check(Array.isArray(j.data.items),'notice projection shape');
 check(errors.length===0,'no runtime errors '+errors.join(';'));console.log(JSON.stringify({checks,failed:0}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{ws?.close();chrome?.kill();server?.kill();db.close();});
