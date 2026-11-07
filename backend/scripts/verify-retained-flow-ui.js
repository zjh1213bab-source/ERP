/** 使用朱佳豪实际账号、局域网真实页面核对保留单据；不新增或更改业务记录。 */
const fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process'),assert=require('assert/strict');
if(!process.env.TRIAL_PASSWORD)throw Error('需要 TRIAL_PASSWORD');
const loc=JSON.parse(fs.readFileSync('../logs/retained-trials-location.json','utf8')),state=JSON.parse(fs.readFileSync(path.join(loc.directory,'manifest.json'),'utf8'));
const base='http://192.168.110.69:5173',dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-live-flow-ui-')),out=path.resolve('../shots/trial-flow-20261103');fs.mkdirSync(out,{recursive:true});
let browser,ws,checks=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms));const check=(v,msg)=>{assert.ok(v,msg);checks++;};
(async()=>{
 const login=await(await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'13055709733',password:process.env.TRIAL_PASSWORD})})).json();if(!login.ok)throw Error(login.message);check(login.data.user.name==='朱佳豪','Actual account name');
 browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--user-data-dir='+dir,'--remote-debugging-port=9967','--window-size=1550,1050','about:blank'],{windowsHide:true,stdio:'ignore'});
 let target;for(let i=0;i<80;i++){await sleep(100);try{target=(await(await fetch('http://127.0.0.1:9967/json')).json()).find(x=>x.type==='page');if(target)break;}catch{}}
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let n=0;const pending=new Map(),errors=[];
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++n,t=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},10000);pending.set(id,r=>{clearTimeout(t);resolve(r)});ws.send(JSON.stringify({id,method,params}));});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening'){errors.push(m.params.message);send('Page.handleJavaScriptDialog',{accept:true});}};
 const ev=async expression=>(await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}))?.result?.value;
 const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:base+'/login'});await sleep(400);
 await ev('localStorage.setItem("erp_token",'+JSON.stringify(login.data.token)+');localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify(login.data.user))+')');
 await send('Page.navigate',{url:base+'/orders'});await sleep(1500);
 for(const trial of state.trials)check(await ev('document.querySelector("table.data tbody").textContent.includes('+JSON.stringify(trial.order_no)+')'),'Order in live list '+trial.order_no);
 check(await ev('Array.from(document.querySelectorAll("table.data tbody tr")).filter(r=>r.textContent.includes("已结案")).length===3'),'Three closed orders in UI');check(await ev('Array.from(document.querySelectorAll("table.data tbody .tag")).filter(n=>n.textContent==="内部实测").length===3'),'Trial badges explicit on all orders');await shot('01-three-closed-orders');
 await send('Page.navigate',{url:base+'/orders?order='+state.trials[0].order_id});await sleep(1200);
 check(await ev('!!document.querySelector(".modal-mask")'),'Order detail opens');check(await ev('document.querySelector(".trial-notice")?.textContent.includes("不代表真实")'),'Trial disclaimer visible in detail');
 await ev('document.querySelector(".modal-mask").dispatchEvent(new MouseEvent("click",{bubbles:true}))');
 check(await ev('!!document.querySelector(".modal-mask")'),'Backdrop click preserves detail');await shot('02-order-detail');
 await send('Page.navigate',{url:base+'/self'});await sleep(1000);check(await ev('document.body.textContent.includes("朱佳豪")'),'Employee self view resolves identity');await shot('03-employee-self');
 await send('Page.navigate',{url:base+'/sample-archive'});await sleep(1000);
 const dataUrl=await ev('(async()=>{const blob=await(await fetch('+JSON.stringify(state.images[0])+')).blob();return await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(blob)})})()');
 await ev('(async()=>{const blob=await(await fetch('+JSON.stringify(dataUrl)+')).blob(),dt=new DataTransfer();dt.items.add(new File([blob],"internal-trial.png",{type:"image/png"}));const input=document.querySelector(".sample-image-search input[type=file]");input.files=dt.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');
 for(let i=0;i<100;i++){await sleep(500);if(await ev('document.querySelector(".image-search-message")?.textContent.includes("找到")'))break;}
 check(await ev('document.querySelector(".image-search-message")?.textContent.includes("找到")'),'Actual SYSTEM backend CLIP job completes');
 check(await ev('document.querySelector("table.data tbody")?.textContent.includes("100%")'),'Real archive image exact match');await shot('04-live-image-search');
 await send('Page.navigate',{url:base+'/first-article'});await sleep(1100);
 check(await ev('Array.from(document.querySelectorAll("table.data tbody tr")).some(r=>r.textContent.includes('+JSON.stringify(state.trials[1].order_no)+'))'),'Multi-style history remains accessible after closing');
 await ev('Array.from(document.querySelectorAll("table.data tbody tr")).find(r=>r.textContent.includes('+JSON.stringify(state.trials[1].order_no)+')).querySelector("button").click()');await sleep(400);
 check(await ev('document.querySelector(".fa-modal .modal-body select").options.length===2'),'Live per-style first article selector has two choices');
 const firstHeader=await ev('document.querySelector(".fa-modal .modal-head").textContent');
 await ev('(()=>{const select=document.querySelector(".fa-modal .modal-body select");select.value=select.options[1].value;select.dispatchEvent(new Event("change",{bubbles:true}));})()');await sleep(400);
 check(await ev('document.querySelector(".fa-modal .modal-head").textContent!=='+JSON.stringify(firstHeader)),'Each style opens a distinct first article');await shot('05-per-style-first-article');
 check(errors.length===0,'Browser errors: '+errors.join(';'));console.log('RETAINED_LIVE_UI_PASS '+checks+' '+out);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{ws?.close();browser?.kill();await sleep(1000);if(dir.startsWith(path.join(os.tmpdir(),'erp-live-flow-ui-')))fs.rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});});
