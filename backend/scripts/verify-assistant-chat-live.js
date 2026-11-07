/** 在真实局域网账号下只读查单和界面截图，不修改单据。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
if(!process.env.TRIAL_PASSWORD)throw Error('需要现行 TRIAL_PASSWORD，不保存密码');
const base='http://192.168.110.69:5173',folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-chat-live-')),out=path.resolve('../shots/assistant-chat');fs.mkdirSync(out,{recursive:true});
let chrome,ws,checks=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),check=(v,m)=>{assert.ok(v,m);checks++;};
(async()=>{
 const auth=await(await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'13055709733',password:process.env.TRIAL_PASSWORD})})).json();if(!auth.ok)throw Error(auth.message);
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--user-data-dir='+folder,'--remote-debugging-port=9972','--window-size=1500,1050','about:blank'],{windowsHide:true,stdio:'ignore'});
 let target;for(let i=0;i<80;i++){await sleep(100);try{target=(await(await fetch('http://127.0.0.1:9972/json')).json()).find(x=>x.type==='page');if(target)break;}catch{}}
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let n=0;const pending=new Map(),errors=[];
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++n,t=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},10000);pending.set(id,r=>{clearTimeout(t);resolve(r)});ws.send(JSON.stringify({id,method,params}));});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
 const ev=async expression=>(await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}))?.result?.value;
 const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:base+'/login'});await sleep(350);
 await ev('localStorage.setItem("erp_token",'+JSON.stringify(auth.data.token)+');localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify(auth.data.user))+')');await send('Page.navigate',{url:base+'/assistant'});await sleep(1400);
 check(await ev('document.querySelector(".chat-identity").textContent.includes("跳色 ERP 智能助手")'),'Actual LAN chat header');await shot('01-desktop');
 await ev('(()=>{const t=document.querySelector(".composer textarea");t.value="SCBH-20261103-01";t.dispatchEvent(new Event("input",{bubbles:true}));})()');await sleep(50);await ev('document.querySelector(".composer button").click()');await sleep(500);
 check(await ev('document.querySelector(".chat-result")?.textContent.includes("已结案")'),'Actual retained order queried');await shot('02-order-query');
 await ev('document.querySelector(".theme-toggle").click()');await sleep(150);await shot('03-dark-mode');
 const dark=await ev('getComputedStyle(document.querySelector(".assistant-chat")).backgroundColor');check(dark!=='rgb(255, 255, 255)','Dark mode active');
 await ev('document.querySelector(".theme-toggle").click();Array.from(document.querySelectorAll(".chat-links a")).find(a=>a.textContent.includes("查看订单详情")).click()');await sleep(600);
 await ev('document.querySelector(".modal-mask .x")?.click();document.querySelector(".assistant-launcher").click()');await sleep(150);
 check(await ev('document.querySelector(".floating-chat").textContent.includes("SCBH-20261103-01")'),'Actual global floating conversation retains query');await shot('04-floating-chat');
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await sleep(200);check(await ev('document.querySelector(".floating-chat").getBoundingClientRect().right<=innerWidth'),'Mobile panel fits viewport');await shot('05-mobile');
 check(errors.length===0,'Actual browser errors: '+errors.join(';'));console.log('ASSISTANT_CHAT_LIVE_PASS '+checks+' '+out);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{ws?.close();chrome?.kill();await sleep(1000);if(folder.startsWith(path.join(os.tmpdir(),'erp-chat-live-')))fs.rmSync(folder,{recursive:true,force:true,maxRetries:8,retryDelay:200});});
