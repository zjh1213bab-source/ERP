/** 独立库回归：账号归属、归档锁、逐款技术门禁、结案全额核销和并发状态。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-flow-hardening-'));process.env.DB_PATH=path.join(dir,'__SMOKE.db');process.env.ERP_SCHEDULER='0';require('dotenv').config();
const {db,now}=require('../src/db'),bind=require('../src/services/employeeBinding').bind,flow=require('../src/services/orderFlow');
let server,browser,ws,token,checks=0;const port=39769;
const check=(v,m)=>{assert.ok(v,m);checks++;};const rejects=(fn,pattern)=>{assert.throws(fn,pattern);checks++;};
const insert=(t,row)=>{const keys=Object.keys(row);return Number(db.prepare('INSERT INTO '+t+'('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k])).lastInsertRowid);};
async function api(method,url,body,status=200){const r=await fetch('http://127.0.0.1:'+port+url,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));checks++;return j.data;}
(async()=>{
 const t=now(),eid=insert('employees',{name:'__SMOKE绑定员工',phone:'13900000001',status:'active',company_id:1,created_at:t}),uid=insert('users',{username:'13900000001',name:'旧简称',password_hash:'keep-hash',role:'admin',company_id:1,active:1,created_at:t});
 rejects(()=>bind(uid,eid,999),/绑定已变化/);bind(uid,eid,null);let u=db.prepare('SELECT * FROM users WHERE id=?').get(uid);check(u.employee_id===eid&&u.name==='__SMOKE绑定员工','Employee linked and named');check(u.password_hash==='keep-hash'&&u.role==='admin'&&u.token_version===1,'Password and privileges preserved; token revoked');check(!bind(uid,eid,eid).token_revoked,'Binding replay idempotent');
 const wrong=insert('users',{username:'13900000002',password_hash:'unused',role:'employee',active:1,created_at:t});rejects(()=>bind(wrong,eid,null),/手机号/);
 const oid=insert('orders',{order_no:'__SMOKE_HARDEN',type:'custom',status:'draft',rate:1,total_amount:20,created_at:t,updated_at:t,company_id:1});
 const p=insert('pre_orders',{pre_order_no:'__SMOKE_HARDEN',order_no:'__SMOKE_HARDEN',customer_name:'__SMOKE',company_id:1,created_at:t,updated_at:t});
 const i1=insert('pre_order_items',{pre_order_id:p,product_name:'__SMOKE款1',source_type:'new'}),i2=insert('pre_order_items',{pre_order_id:p,product_name:'__SMOKE款2',source_type:'new'});
 const tp=insert('tech_packs',{order_id:oid,pre_order_id:p,pre_order_item_id:i1,product_name:'__SMOKE款1',status:'draft',created_at:t,updated_at:t});
 const pf=require('../src/routes/patternFlows').ensureFlow(tp,1);db.prepare("UPDATE pattern_stages SET status='done' WHERE flow_id=?").run(pf.id);
 server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port)},windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));try{if((await fetch('http://127.0.0.1:'+port+'/api/health')).ok)break;}catch{}}
 token=require('jsonwebtoken').sign({sub:db.prepare("SELECT id FROM users WHERE username='admin'").get().id,tv:0},require('../src/config').jwtSecret);
 await api('POST','/api/pattern-flows/'+pf.id+'/finish',{},400);check(!db.prepare('SELECT 1 FROM sample_archives WHERE tech_pack_id=?').get(tp),'Incomplete pattern not archived');
 db.prepare("UPDATE tech_packs SET fabric_info='__SMOKE面料',accessory_info='__SMOKE辅料',craft_info='__SMOKE工艺',customer_req='__SMOKE要求' WHERE id=?").run(tp);
 db.prepare("UPDATE pattern_stages SET data=? WHERE flow_id=? AND stage='craft'").run(JSON.stringify({sewing:[{name:'__SMOKE车缝',category:'sewing',price:0.4,ratio:1}]}),pf.id);
 await api('POST','/api/pattern-flows/'+pf.id+'/finish',{});
 await api('PUT','/api/techpacks/'+tp,{accessory_info:'bypass'},409);await api('PUT','/api/techpacks/'+tp+'/detail',{customer_req:'bypass'},409);
 insert('order_items',{order_id:oid,source_pre_order_item_id:i1,product_name:'__SMOKE款1',style_no:'T1',qty:1});insert('order_items',{order_id:oid,source_pre_order_item_id:i2,product_name:'__SMOKE款2',style_no:'T2',qty:1});
 const commitment=require('../src/routes/commitments').ensureCommitment(oid,null,'__SMOKE');db.prepare("UPDATE commitments SET review_status='approved' WHERE id=?").run(commitment.id);
 db.prepare("UPDATE tech_packs SET status='confirmed' WHERE id=?").run(tp);
 rejects(()=>flow.check(oid,{to:'tech',user:{role:'admin'}}),/款.*没有对应开发单/);
 const tp2=insert('tech_packs',{order_id:oid,pre_order_id:p,pre_order_item_id:i2,product_name:'__SMOKE款2',status:'draft',created_at:t,updated_at:t});
 rejects(()=>flow.check(oid,{to:'tech',user:{role:'admin'}}),/尚未确认/);
 db.prepare("UPDATE tech_packs SET status='confirmed' WHERE id=?").run(tp2);
 const styles=db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(oid),FA=require('../src/routes/firstArticles');
 await api('POST','/api/first-articles',{order_id:oid,batch_qty:1},400);
 const first=await api('POST','/api/first-articles',{order_id:oid,order_item_id:styles[0].id,batch_qty:1,remark:'__SMOKE逐款首件'});
 const second=await api('POST','/api/first-articles',{order_id:oid,order_item_id:styles[1].id,batch_qty:1,remark:'__SMOKE逐款首件'});
 check(first.tech_pack_id===tp&&second.tech_pack_id===tp2,'Each style selects its own frozen technical pack');
 for(const fa of [first,second]){
  await api('POST','/api/first-articles/'+fa.id+'/checks',{part:'__SMOKE尺寸',spec:'60',measured:'60',result:'ok'});
  await api('POST','/api/first-articles/'+fa.id+'/submit',{});
  await api('POST','/api/first-articles/'+fa.id+'/release',{result:'passed',release_qty:1});
  if(fa.id===first.id)check(!FA.faGate(oid).ok,'One style cannot release the entire multi-style order');
 }
 check(FA.faGate(oid).ok,'All styles individually passed release order');check(!FA.staleOf(db.prepare('SELECT * FROM first_articles WHERE id=?').get(first.id)).stale,'Another style does not invalidate this style');
 const selected=await api('GET','/api/first-articles/order/'+oid+'?order_item_id='+styles[1].id);check(selected.fa.id===second.id&&selected.selected_item_id===styles[1].id,'UI can switch to each style history');
 insert('tech_packs',{order_id:oid,pre_order_id:p,pre_order_item_id:i1,product_name:'__SMOKE款1',status:'confirmed',version:'V2',created_at:t,updated_at:t});
 check(!FA.faGate(oid).ok,'Revised style needs a new first article');check(!FA.staleOf(db.prepare('SELECT * FROM first_articles WHERE id=?').get(second.id)).stale,'Revision does not stale unrelated style');
 db.prepare("UPDATE orders SET status='shipped' WHERE id=?").run(oid);
 rejects(()=>flow.check(oid,{to:'closed',user:{role:'admin'}}),/应收尚未完整生成/);
 const ar1=insert('ar_invoices',{bill_no:'__SMOKE_AR1',order_id:oid,amount:10,paid_amount:10,status:'paid',created_at:t});const ar2=insert('ar_invoices',{bill_no:'__SMOKE_AR2',order_id:oid,amount:10,paid_amount:0,status:'unpaid',created_at:t});
 rejects(()=>flow.check(oid,{to:'closed',user:{role:'admin'}}),/未收金额/);
 db.prepare("UPDATE ar_invoices SET paid_amount=10,status='paid' WHERE id=?").run(ar2);
 check(flow.check(oid,{to:'closed',user:{role:'admin'}}).id===oid,'All invoices paid allows close');
 const stale=db.prepare('SELECT * FROM orders WHERE id=?').get(oid);db.prepare('UPDATE orders SET updated_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z',oid);
 rejects(()=>flow.apply(stale,{to:'closed',user:{username:'__SMOKE'}}),/已被其他操作更新/);check(db.prepare('SELECT status FROM orders WHERE id=?').get(oid).status==='shipped','Concurrent transition rolled back');
 const fulfill=insert('orders',{order_no:'__SMOKE_STOCK_NOTE',type:'custom',status:'production',rate:6.5,total_usd:2,total_amount:13,remark:'__SMOKE内部模拟，不代表真实出入库/收款',created_at:t,updated_at:t,company_id:1});
 const it=insert('order_items',{order_id:fulfill,product_name:'__SMOKE实测款',style_no:'__SMOKE_NOTE',qty:1});insert('order_item_sizes',{item_id:it,color:'蓝',size:'M',qty:1,usd_price:2});
 for(const code of ['inspect','pack']){const node=insert('order_nodes',{order_id:fulfill,name:code,code,status:'done',seq:1,created_at:t});insert('production_reports',{order_id:fulfill,node_id:node,qty_ok:1,qty_defect:0,report_date:'2026-11-03',created_at:t});}
 insert('qc_inspections',{inspect_no:'__SMOKE_NOTE',order_id:fulfill,type:'final',status:'done',aql_result:'pass',created_at:t,updated_at:t});
 await api('POST','/api/stock/instock',{order_id:fulfill,remark:{wrong:true}},400);
 await api('POST','/api/stock/instock',{order_id:fulfill,remark:'__SMOKE内部模拟入库'});
 await api('POST','/api/stock/ship',{order_id:fulfill,remark:'__SMOKE内部模拟出库'});
 const ledger=db.prepare("SELECT * FROM stock_ledger WHERE ref_type='order' AND ref_id=?").all(fulfill);check(ledger.length===2&&ledger.every(r=>r.remark.includes('__SMOKE内部模拟')),'Movement notes preserved');
 const invoice=db.prepare('SELECT * FROM ar_invoices WHERE order_id=?').get(fulfill);check(invoice.remark.includes('不代表真实'),'Auto receivable retains order disclaimer');
 await api('POST','/api/stock/ship',{order_id:fulfill,remark:'__SMOKE重复提交'},400);
 check(db.prepare('SELECT COUNT(*) AS n FROM stock_ledger WHERE ref_id=?').get(fulfill).n===2,'Duplicate shipping creates no extra movement');
 if(process.argv.includes('--ui')){
  browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--user-data-dir='+path.join(dir,'chrome'),'--remote-debugging-port=9969','about:blank'],{windowsHide:true,stdio:'ignore'});
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));let target;
  for(let i=0;i<80;i++){await sleep(100);try{target=(await(await fetch('http://127.0.0.1:9969/json')).json()).find(x=>x.type==='page');if(target)break;}catch{}}
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let n=0;const waiting=new Map(),errors=[];
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++n,timer=setTimeout(()=>{waiting.delete(id);reject(Error('Browser timeout '+method))},8000);waiting.set(id,r=>{clearTimeout(timer);resolve(r)});ws.send(JSON.stringify({id,method,params}));});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){waiting.get(m.id)?.(m.result);waiting.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening'){errors.push(m.params.message);send('Page.handleJavaScriptDialog',{accept:true});}};
  const ev=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}))?.result?.value;
  await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:'http://127.0.0.1:'+port+'/login'});await sleep(400);
  await ev('localStorage.setItem("erp_token",'+JSON.stringify(token)+');localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify({id:1,username:'admin',role:'admin'}))+')');
  await send('Page.navigate',{url:'http://127.0.0.1:'+port+'/first-article'});await sleep(1000);
  check(await ev('Array.from(document.querySelectorAll("table tbody tr")).some(r=>r.textContent.includes("__SMOKE_HARDEN"))'),'First article history visible after production');
  await ev('Array.from(document.querySelectorAll("table tbody tr")).find(r=>r.textContent.includes("__SMOKE_HARDEN")).querySelector("button").click()');await sleep(350);
  check(await ev('document.querySelector(".fa-modal .modal-body select").options.length===2'),'UI exposes per-style selector');
  await ev('(()=>{const s=document.querySelector(".fa-modal .modal-body select");s.value='+JSON.stringify(String(styles[1].id))+';s.dispatchEvent(new Event("change",{bubbles:true}));})()');await sleep(350);
  check(await ev('document.querySelector(".fa-modal .modal-head").textContent.includes('+JSON.stringify(second.fa_no)+')'),'Switching style loads its own first article');
  check(errors.length===0,'Per-style browser errors: '+errors.join(';'));
 }
 console.log('FLOW_HARDENING_PASS '+checks);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{ws?.close();browser?.kill();server?.kill();db.close();await new Promise(r=>setTimeout(r,1200));if(dir.startsWith(path.join(os.tmpdir(),'erp-flow-hardening-')))fs.rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});});
