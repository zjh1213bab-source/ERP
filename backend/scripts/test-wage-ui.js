/** 独立数据库与浏览器验证按钮显隐、普通员工入口及附加岗位路由。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
require('dotenv').config();const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-wage-ui-'));
process.env.DB_PATH=path.join(folder,'__SMOKE.db');process.env.ERP_SCHEDULER='0';
const {db,now}=require('../src/db'),PW=require('../src/services/pieceWage');
const port=39672,debug=9962,base='http://127.0.0.1:'+port;let server,chrome,ws,checks=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(v,msg)=>{assert.ok(v,msg);checks++;};
(async()=>{
 const employee=Number(db.prepare("INSERT INTO employees(name,code,status,company_id,created_at) VALUES('__SMOKE计件UI','__SMOKE-ui-wage','active',1,?)").run(now()).lastInsertRowid);
 const employeeUser=Number(db.prepare("INSERT INTO users(username,name,password_hash,role,active,company_id,employee_id,created_at) VALUES('__SMOKE-ui','__SMOKE计件UI','unused','employee',1,1,?,?)").run(employee,now()).lastInsertRowid);
 const order=Number(db.prepare("INSERT INTO orders(order_no,status,company_id,created_at,updated_at) VALUES('__SMOKE-WAGE-UI','production',1,?,?)").run(now(),now()).lastInsertRowid);
 const item=Number(db.prepare("INSERT INTO order_items(order_id,product_name,style_no,qty) VALUES(?,'__SMOKE款','__SMOKE-UI-STYLE',20)").run(order).lastInsertRowid);
 db.prepare("INSERT INTO order_item_sizes(item_id,color,size,qty) VALUES(?,'红','S',20)").run(item);
 db.prepare("INSERT INTO order_nodes(order_id,name,code,status,created_at) VALUES(?,'备料','prep','doing',?)").run(order,now());
 PW.saveRate({style_no:'__SMOKE-UI-STYLE',process_name:'备料',unit_price:0.4,effective_from:'2026-01-01'},'__SMOKE');
 server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port)},windowsHide:true,stdio:'ignore'});
 for(let i=0;i<100;i++){await sleep(100);try{if((await fetch(base+'/api/health')).ok)break;}catch{}}
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--user-data-dir='+path.join(folder,'chrome'),'--remote-debugging-port='+debug,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let target;for(let i=0;i<80;i++){await sleep(100);try{target=(await(await fetch('http://127.0.0.1:'+debug+'/json')).json()).find(x=>x.type==='page');if(target)break;}catch{}}
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let id=0;const pending=new Map(),errors=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening'){errors.push('Dialog: '+m.params.message);send('Page.handleJavaScriptDialog',{accept:true});}};
 const send=(method,params={})=>new Promise(r=>{const n=++id;const timeout=setTimeout(()=>{pending.delete(n);r({result:{value:null}})},8000);pending.set(n,result=>{clearTimeout(timeout);r(result)});ws.send(JSON.stringify({id:n,method,params}));});
 const ev=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}))?.result?.value;
 await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:base+'/login'});await sleep(500);

 const adminId=db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
 const tokenFor=id=>require('jsonwebtoken').sign({sub:id,tv:0},require('../src/config').jwtSecret);
 const session=async(id,role,name)=>ev('localStorage.setItem("erp_token",'+JSON.stringify(tokenFor(id))+');localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify({id,username:role==='admin'?'admin':'__SMOKE-ui',name,role}))+')');
 await session(adminId,'admin','管理员');await send('Page.navigate',{url:base+'/settings'});await sleep(1200);
 check(await ev('document.querySelector("#wage-multipliers h3")?.textContent==="工价倍率"'),'Settings section exists');
 check(await ev('document.querySelectorAll("#wage-multipliers tbody tr").length===5'),'All five tiers shown');
 await ev('document.querySelector(".process-scope input[value=selected]").click()');await sleep(150);
 check(await ev('document.querySelectorAll(".process-scope input[type=checkbox]").length>=20'),'Selectable categories and production processes');
 await ev('document.querySelector(".process-scope input[value=prep]").click()');
 await ev('Array.from(document.querySelectorAll("#wage-multipliers button")).find(b=>b.textContent.includes("保存工价倍率")).click()');await sleep(400);
 check(await ev('document.querySelector("#wage-multipliers").textContent.includes("工价倍率已保存")'),'Save setting via UI');
 await session(employeeUser,'employee','__SMOKE计件UI');await send('Page.navigate',{url:base+'/m/report?order='+order});await sleep(1000);
 check(await ev('location.pathname==="/m/report"'),'Worker can enter scan page');
 await ev('document.querySelector(".mr-node").click()');await sleep(600);
 check(await ev('document.querySelector(".report-wage").textContent.includes("0.48 元/件")'),'Worker sees calculated price 0.48');
 check(await ev('document.querySelector(".report-wage").textContent.includes("同款同色 20 件")'),'Worker sees tier quantity');
 check(await ev('!document.querySelector(".mr-submit").disabled'),'Selected quote allows submission');
 await ev('(()=>{const input=document.querySelector(".mr-fields input");input.value="2";input.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".mr-submit").click();})()');await sleep(700);
 const report=db.prepare('SELECT * FROM production_reports WHERE employee_id=?').get(employee);
 check(!!report&&report.qty_ok===2,'Worker UI creates report for own employee');
 check(JSON.parse(report.wage_snapshot).unit_price===0.48,'Worker submitted price snapshot matches display');
 check(JSON.parse(report.wage_snapshot).participates===true,'Report records participation decision');
 await session(adminId,'admin','管理员');await send('Page.navigate',{url:base+'/settings'});await sleep(800);
 await ev('document.querySelector(".process-scope input[value=prep]").click();Array.from(document.querySelectorAll("#wage-multipliers button")).find(b=>b.textContent.includes("保存工价倍率")).click()');await sleep(300);
 await session(employeeUser,'employee','__SMOKE计件UI');await send('Page.navigate',{url:base+'/m/report?order='+order});await sleep(700);await ev('document.querySelector(".mr-node").click()');await sleep(500);
 check(await ev('document.querySelector(".report-wage").textContent.includes("0.4 元/件")'),'Unselected process displays base rate');
 check(await ev('document.querySelector(".report-wage").textContent.includes("未勾选参与")'),'Exclusion reason visible to worker');
 check(JSON.parse(db.prepare('SELECT wage_snapshot FROM production_reports WHERE id=?').get(report.id).wage_snapshot).multiplier===1.2,'UI setting edit cannot rewrite prior report');
 check(errors.length===0,'Runtime errors: '+errors.join(','));console.log('PASS '+checks+' wage browser assertions');
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{
 ws?.close();if(chrome){chrome.kill();await new Promise(r=>chrome.once('exit',r));}if(server){server.kill();await new Promise(r=>server.once('exit',r));}db.close();try{fs.rmSync(folder,{recursive:true,force:true,maxRetries:8,retryDelay:200});}catch(e){console.error('Temporary browser folder cleanup: '+e.message);}
});
