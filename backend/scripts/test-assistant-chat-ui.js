/** 独立库浏览器回归：客服式对话、真实查单、浮窗复用、员工入口、深浅色和移动端。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-chat-ui-'));process.env.DB_PATH=path.join(folder,'__SMOKE.db');process.env.ERP_SCHEDULER='0';require('dotenv').config();
const {db,now}=require('../src/db');let server,chrome,ws,checks=0;
const port=39781,debug=9971,base='http://127.0.0.1:'+port,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(v,m)=>{assert.ok(v,m);checks++;};
(async()=>{
 db.prepare("INSERT INTO orders(order_no,type,status,style_name,company_id,created_at,updated_at) VALUES('SCBH-CHAT-20261103','custom','draft','__SMOKE客服测试款',1,?,?)").run(now(),now());
 const employee=Number(db.prepare("INSERT INTO users(username,name,password_hash,role,company_id,active,created_at) VALUES('__SMOKE-chat-worker','__SMOKE员工','unused','employee',1,1,?)").run(now()).lastInsertRowid);
 server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port)},windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){await sleep(100);try{if((await fetch(base+'/api/health')).ok)break;}catch{}}
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--user-data-dir='+path.join(folder,'chrome'),'--remote-debugging-port='+debug,'--window-size=1500,1050','about:blank'],{windowsHide:true,stdio:'ignore'});
 let target;for(let i=0;i<80;i++){await sleep(100);try{target=(await(await fetch('http://127.0.0.1:'+debug+'/json')).json()).find(x=>x.type==='page');if(target)break;}catch{}}
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let next=0;const pending=new Map(),errors=[];
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,t=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},10000);pending.set(id,r=>{clearTimeout(t);resolve(r)});ws.send(JSON.stringify({id,method,params}));});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening'){errors.push(m.params.message);send('Page.handleJavaScriptDialog',{accept:true});}};
 const ev=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}))?.result?.value;
 const adminId=db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
 async function enter(id,role){
  await send('Page.navigate',{url:base+'/login'});await sleep(300);
  const token=require('jsonwebtoken').sign({sub:id,tv:0},require('../src/config').jwtSecret);
  await ev('localStorage.setItem("erp_token",'+JSON.stringify(token)+');localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify({id,username:role==='admin'?'admin':'__SMOKE-chat-worker',role}))+')');
  await send('Page.navigate',{url:base+'/assistant'});await sleep(1100);
 }
 async function ask(text){await ev('(()=>{const t=document.querySelector(".composer textarea");t.value='+JSON.stringify(text)+';t.dispatchEvent(new Event("input",{bubbles:true}));})()');await sleep(30);await ev('document.querySelector(".composer button").click()');await sleep(350);}
 await send('Page.enable');await send('Runtime.enable');await enter(adminId,'admin');
 check(await ev('document.querySelectorAll(".assistant-service").length===6'),'Six business help categories');
 check(await ev('document.querySelectorAll(".assistant-chat").length===1'),'One chat panel on assistant page');
 check(await ev('!document.querySelector(".assistant-launcher")'),'No duplicate floating panel on full assistant page');
 await ev('Array.from(document.querySelectorAll(".chat-choices button")).find(b=>b.textContent==="订单与报价").click()');await sleep(100);
 check(await ev('document.querySelectorAll(".chat-message.user").length===1'),'Guided choice becomes user bubble');
 await ev('Array.from(document.querySelectorAll(".chat-choices button")).find(b=>b.textContent==="怎样下单").click()');await sleep(100);
 check(await ev('document.querySelector(".chat-messages").textContent.includes("新款还没打版")'),'Follow-up choices displayed');
 await ask('SCBH-CHAT-20261103');
 check(await ev('document.querySelector(".chat-result").textContent.includes("SCBH-CHAT-20261103")'),'Handwritten hyphenated order resolved through existing scoped find endpoint');
 check(await ev('document.querySelectorAll(".chat-message.user").length===3'),'Conversation keeps earlier turns');
 check(await ev('!Object.values(localStorage).some(v=>v.includes("SCBH-CHAT-20261103"))'),'Query results not persisted to localStorage');
 const count=await ev('document.querySelectorAll(".chat-message.user").length');
 await ev('(()=>{const t=document.querySelector(".composer textarea");t.value="你好";t.dispatchEvent(new Event("input",{bubbles:true}));t.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true}));})()');
 check(await ev('document.querySelectorAll(".chat-message.user").length==='+count),'IME Enter does not submit');
 await ev('document.querySelector(".composer textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",shiftKey:true,bubbles:true}))');
 check(await ev('document.querySelectorAll(".chat-message.user").length==='+count),'Shift Enter does not submit');
 await ev('document.querySelector(".composer textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');await sleep(100);
 check(await ev('document.querySelectorAll(".chat-message.user").length==='+String(count+1)),'Enter sends a new turn');
 await ask('请帮我查一下订单 SCBH-CHAT-20261103 的进度');check(await ev('document.querySelectorAll(".chat-result").length===2'),'Natural order question resolves handwritten order number');
 await ev('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="经营概览").click()');await sleep(400);check(await ev('document.querySelector(".assistant-overview").textContent.includes("经营解读")'),'Existing business report remains available');
 await ev('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="返回工作指引").click()');
 await ev('Array.from(document.querySelectorAll(".chat-links a")).find(a=>a.textContent.includes("查看订单详情")).click()');await sleep(650);
 check(await ev('location.pathname==="/orders"'),'Result link opens original business page');
 // 先明确关闭业务弹窗，再打开非遮罩式助手。
 await ev('document.querySelector(".modal-mask .x")?.click();document.querySelector(".assistant-launcher").click()');await sleep(150);
 check(await ev('document.querySelector(".floating-chat .chat-messages").textContent.includes("SCBH-CHAT-20261103")'),'Floating chat shares route conversation');
 await ev('document.querySelector(".erp-content").dispatchEvent(new MouseEvent("click",{bubbles:true}))');
 check(await ev('!!document.querySelector(".floating-chat")'),'Outside click does not close chat');
 await ev('document.querySelector("[aria-label=收起智能助手]").click()');check(await ev('!document.querySelector(".floating-chat")'),'Explicit minimize works');
 await ev('document.querySelector(".assistant-launcher").click()');
 const light=await ev('getComputedStyle(document.querySelector(".assistant-chat")).backgroundColor');await ev('document.documentElement.dataset.theme="dark"');await sleep(100);
 check(await ev('getComputedStyle(document.querySelector(".assistant-chat")).backgroundColor!=='+JSON.stringify(light)),'Dark theme updates chat surface');
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await sleep(150);
 check(await ev('document.querySelector(".floating-chat").getBoundingClientRect().right<=innerWidth&&document.querySelector(".floating-chat").getBoundingClientRect().left>=0'),'Floating chat fits narrow screen');
 await enter(employee,'employee');
 check(await ev('document.querySelectorAll(".assistant-service").length===2'),'Employee sees self-service and collaboration only');
 check(await ev('!Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="经营概览")'),'Employee cannot see company overview entry');
 check(await ev('!document.querySelector(".chat-messages").textContent.includes("SCBH-CHAT-20261103")'),'Switching account clears conversation');
 await ask('本月工资');
 check(await ev('document.querySelector(".chat-messages").textContent.includes("员工工作指引")'),'Employee salary query retains backend self-service guide');
 await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1050,deviceScaleFactor:1,mobile:false});await enter(adminId,'admin');
 await ev('window.__originalChatFetch=window.fetch;window.fetch=(url,options)=>String(url).includes("/api/assistant/query")?Promise.reject(new TypeError("__SMOKE网络暂不可用")):window.__originalChatFetch(url,options)');
 await ask('测试网络错误');check(await ev('document.querySelector(".message-bubble.error").textContent.includes("__SMOKE网络暂不可用")'),'Query failure shown inline');
 check(await ev('Array.from(document.querySelectorAll(".chat-text-button")).some(b=>b.textContent==="重新查询")'),'Failure offers retry');
 await ev('window.fetch=window.__originalChatFetch;Array.from(document.querySelectorAll(".chat-text-button")).find(b=>b.textContent==="重新查询").click()');await sleep(350);
 check(await ev('document.querySelector(".chat-messages").textContent.includes("暂时没有识别出具体业务问题")'),'Retry recovers without discarding history');
 await ev('document.querySelector("[aria-label=开始新对话]").click()');check(await ev('document.querySelectorAll(".chat-message").length===1'),'New conversation resets only local chat');
 check(errors.length===0,'Browser errors: '+errors.join(';'));console.log('ASSISTANT_CHAT_UI_PASS '+checks);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{ws?.close();chrome?.kill();server?.kill();db.close();await sleep(1100);if(folder.startsWith(path.join(os.tmpdir(),'erp-chat-ui-')))fs.rmSync(folder,{recursive:true,force:true,maxRetries:8,retryDelay:200});});
