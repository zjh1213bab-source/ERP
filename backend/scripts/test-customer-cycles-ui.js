/** 浏览器真实填单回归，所有写入限定 __SMOKE 临时库。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
process.chdir(path.resolve(__dirname,'..'));
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-entry-ui-'));process.env.DB_PATH=path.join(folder,'__SMOKE.db');process.env.ERP_SCHEDULER='0';require('dotenv').config();
const {db,now}=require('../src/db');let server,chrome,ws,checks=0;const port=39784,debug=9974,base='http://127.0.0.1:'+port,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(v,m)=>{assert.ok(v,m);checks++;};const shots=path.resolve('../shots/sales-entry');fs.mkdirSync(shots,{recursive:true});
(async()=>{
 db.prepare("INSERT INTO customers(name,status,contact,shipping_address,created_at,updated_at) VALUES('__SMOKE客户','active','__SMOKE收货人','__SMOKE地址',?,?)").run(now(),now());
 db.prepare("INSERT INTO suppliers(name,status,created_at,updated_at) VALUES('__SMOKE供应商','active',?,?)").run(now(),now());
 db.prepare("INSERT INTO materials(name,type,unit,width,weight,composition,supplier,supplier_id,status,version,created_at,updated_at) VALUES('__SMOKE面料','fabric','米','165','220','__SMOKE档案成分','__SMOKE供应商',1,'active',1,?,?)").run(now(),now());
 db.prepare("INSERT INTO materials(name,type,unit,composition,supplier,status,version,created_at,updated_at) VALUES('__SMOKE辅料','accessory','条','__SMOKE辅料成分','__SMOKE供应商','active',1,?,?)").run(now(),now());
 db.prepare("INSERT INTO products(sku,name,price,status,created_at,updated_at) VALUES('__SMOKE-STYLE-01','__SMOKE商品',26,'active',?,?)").run(now(),now());
 server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port)},windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){await sleep(100);try{if((await fetch(base+'/api/health')).ok)break;}catch{}}
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--user-data-dir='+path.join(folder,'chrome'),'--remote-debugging-port='+debug,'--window-size=1920,1080','about:blank'],{windowsHide:true,stdio:'ignore'});
 let target;for(let i=0;i<80;i++){await sleep(100);try{target=(await(await fetch('http://127.0.0.1:'+debug+'/json')).json()).find(x=>x.type==='page');if(target)break;}catch{}}
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let next=0;const pending=new Map(),errors=[];const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,t=setTimeout(()=>reject(Error('CDP timeout '+method)),10000);pending.set(id,r=>{clearTimeout(t);resolve(r)});ws.send(JSON.stringify({id,method,params}));});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening')send('Page.handleJavaScriptDialog',{accept:true,promptText:'__SMOKE模板'});};
 const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description);return r?.result?.value;};
 const token=require('jsonwebtoken').sign({sub:db.prepare("SELECT id FROM users WHERE username='admin'").get().id,tv:0},require('../src/config').jwtSecret);await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:base+'/login'});await sleep(350);await ev('localStorage.setItem("erp_token",'+JSON.stringify(token)+');localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify({id:1,name:'__SMOKE管理员',username:'admin',role:'admin'}))+')');await send('Page.navigate',{url:base+'/customers'});await sleep(1500);
 check(await ev('document.body.textContent.includes("近1年")&&document.body.textContent.includes("近2年")'),'customer statistics visible');
 await ev('__noop=0;Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="编辑").click()');await sleep(100);
 check(await ev('document.querySelector(".modal-body").textContent.includes("绑定业务员")'),'salesperson selector visible');
 check(await ev('document.querySelector(".modal-body").textContent.includes("下单周期")'),'cycle editor visible');
 check(await ev('Array.from(document.querySelectorAll(".modal-body select option")).some(o=>o.textContent.includes("管理员"))'),'salesperson API populated');
 check(errors.length===0,'no browser errors');console.log(JSON.stringify({checks,failed:0}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{ws?.close();chrome?.kill();server?.kill();db.close();});
