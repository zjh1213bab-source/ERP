/** 独立数据库与浏览器验证按钮显隐、普通员工入口及附加岗位路由。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
require('dotenv').config();const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-position-ui-'));
process.env.DB_PATH=path.join(folder,'__SMOKE.db');process.env.ERP_SCHEDULER='0';
const {db,now}=require('../src/db'),P=require('../src/services/positionAccess');
const port=39671,debug=9961,base='http://127.0.0.1:'+port;let server,chrome,ws,checks=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(v,msg)=>{assert.ok(v,msg);checks++;};
(async()=>{
 const employee=Number(db.prepare("INSERT INTO users(username,name,password_hash,role,active,company_id,created_at) VALUES('__SMOKE-ui','__SMOKE ui','unused','employee',1,1,?)").run(now()).lastInsertRowid);
 db.prepare("INSERT INTO customers(name,contact,email,status,created_at,updated_at) VALUES('__SMOKE client','__SMOKE','ui@example.test','active',?,?)").run(now(),now());
 server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port)},windowsHide:true,stdio:'ignore'});
 for(let i=0;i<100;i++){await sleep(100);try{if((await fetch(base+'/api/health')).ok)break;}catch{}}
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--user-data-dir='+path.join(folder,'chrome'),'--remote-debugging-port='+debug,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let target;for(let i=0;i<80;i++){await sleep(100);try{target=(await(await fetch('http://127.0.0.1:'+debug+'/json')).json()).find(x=>x.type==='page');if(target)break;}catch{}}
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let id=0;const pending=new Map(),errors=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening'){errors.push('Dialog: '+m.params.message);send('Page.handleJavaScriptDialog',{accept:true});}};
 const send=(method,params={})=>new Promise(r=>{const n=++id;const timeout=setTimeout(()=>{pending.delete(n);r({result:{value:null}})},8000);pending.set(n,result=>{clearTimeout(timeout);r(result)});ws.send(JSON.stringify({id:n,method,params}));});
 const ev=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}))?.result?.value;
 await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:base+'/login'});await sleep(500);
 const token=require('jsonwebtoken').sign({sub:employee,tv:0},require('../src/config').jwtSecret);
 await ev('localStorage.setItem("erp_token",'+JSON.stringify(token)+');localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify({id:employee,username:'__SMOKE-ui',name:'__SMOKE ui',role:'employee'}))+')');
 for(const [route,title]of [['/exceptions','异常日清'],['/scan','扫码查询'],['/assistant','智能助手'],['/mail','内部邮件']]){
  await send('Page.navigate',{url:base+route});await sleep(1100);
  check(await ev('location.pathname==='+JSON.stringify(route)),route+' was redirected');
  check(await ev('document.body.textContent.includes('+JSON.stringify(title)+')'),route+' not rendered');
 }
 const adminId=db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
 const adminToken=require('jsonwebtoken').sign({sub:adminId,tv:0},require('../src/config').jwtSecret);
 const update=async body=>{const r=await fetch(base+'/api/access/positions',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+adminToken},body:JSON.stringify(body)});const j=await r.json();assert.equal(r.status,200,j.message);return j.data;};
 let s=await update({revision:0,action:'save',name:'__SMOKE编辑岗',perms:['action.customers.edit']});
 await update({revision:s.revision,action:'members',id:s.positions[0].id,user_ids:[employee]});
 await send('Page.navigate',{url:base+'/customers'});await sleep(1200);
 check(await ev('location.pathname==="/customers"'),'Effective sales position routing; errors='+errors.join(','));
 const buttons=await ev('Array.from(document.querySelectorAll("button")).map(b=>({text:b.textContent.trim(),visible:getComputedStyle(b).display!=="none"}))');
 check(buttons.some(b=>b.text==='编辑'&&b.visible),'Edit permission should show edit');
 check(buttons.some(b=>b.text==='停用'&&!b.visible),'No disable permission should hide disable');
 check(buttons.some(b=>b.text.includes('新增客户')&&!b.visible),'No create permission should hide create');
 check(await ev('!Array.from(document.querySelectorAll("a")).some(a=>a.getAttribute("href")==="/suppliers")'),'Unauthorized module must not appear in menu');
 // 两个旧入口都归到同一个权限管理页，管理员不再需要复核签字。
 await ev('localStorage.setItem("erp_token",'+JSON.stringify(adminToken)+' );localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify({id:adminId,username:'admin',role:'admin'}))+')');
 for(const route of ['/access-review','/position-permissions']){
  await send('Page.navigate',{url:base+route});await sleep(800);
  check(await ev('location.pathname==="/permission-management"'),route+' must redirect to unified page');
  check(await ev('document.querySelector("h2")?.textContent==="权限管理"'),'Unified title');
 }
 check(await ev('!document.body.textContent.includes("业务职责")&&!document.body.textContent.includes("模块操作入口")'),'No extra permission controls');
 check(errors.length===0,'Runtime errors: '+errors.join(','));
 console.log('PASS '+checks+' browser permission assertions');
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{
 ws?.close();if(chrome){chrome.kill();await new Promise(r=>chrome.once('exit',r));}if(server){server.kill();await new Promise(r=>server.once('exit',r));}db.close();try{fs.rmSync(folder,{recursive:true,force:true,maxRetries:8,retryDelay:200});}catch(e){console.error('Temporary browser folder cleanup: '+e.message);}
});
