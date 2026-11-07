/** 局域网实测记录只读 UI 核对。 */
const fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process'),assert=require('assert/strict'),{DatabaseSync}=require('node:sqlite');
process.chdir(path.resolve(__dirname,'..'));
const loc=JSON.parse(fs.readFileSync('../logs/retained-allocation-location.json','utf8')),state=JSON.parse(fs.readFileSync(path.join(loc.directory,'manifest.json'),'utf8'));
const base='http://192.168.110.69:5173',dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-live-allocation-ui-')),out=path.resolve('../shots/trial-allocation-20261105');fs.mkdirSync(out,{recursive:true});
let browser,ws,checks=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms));const check=(v,msg)=>{assert.ok(v,msg);checks++;};
(async()=>{
 const db=new DatabaseSync(path.resolve('data/lan-preview.db'),{readOnly:true});const user=db.prepare('SELECT id,name,username,role,employee_id,token_version FROM users WHERE id=2').get();db.close();
 const token=require('jsonwebtoken').sign({sub:user.id,tv:user.token_version},require('../src/config').jwtSecret,{expiresIn:'5m'}),login={data:{user,token}};
 browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--user-data-dir='+dir,'--remote-debugging-port=9967','--window-size=1550,1050','about:blank'],{windowsHide:true,stdio:'ignore'});
 let target;for(let i=0;i<80;i++){await sleep(100);try{target=(await(await fetch('http://127.0.0.1:9967/json')).json()).find(x=>x.type==='page');if(target)break;}catch{}}
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let n=0;const pending=new Map(),errors=[];
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++n,t=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},10000);pending.set(id,r=>{clearTimeout(t);resolve(r)});ws.send(JSON.stringify({id,method,params}));});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening'){errors.push(m.params.message);send('Page.handleJavaScriptDialog',{accept:true});}};
 const ev=async expression=>(await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}))?.result?.value;
 const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:base+'/login'});await sleep(400);
 await ev('localStorage.setItem("erp_token",'+JSON.stringify(login.data.token)+');localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify(login.data.user))+')');
 await send('Page.navigate',{url:base+'/orders'});await sleep(1100);
 for(const trial of state.trials)check(await ev('document.body.textContent.includes('+JSON.stringify(trial.order_no)+')'),'order visible '+trial.order_no);
 await shot('01-retained-orders');
 await send('Page.navigate',{url:base+'/order-tracking'});await sleep(700);
 await ev('window.__search=(value)=>{const el=document.querySelector("input[aria-label=PO号]");el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));Array.from(document.querySelectorAll(".filter-line button")).find(b=>b.textContent.trim()==="查询").click();};');
 await ev('__search("SCBH-20261105-A04")');await sleep(250);
 check(await ev('document.querySelectorAll(".tracking-order").length===1'),'cut order visible in factory module');
 check(await ev('Array.from(document.querySelectorAll(".node-detail b")).some(b=>b.textContent.includes("车缝")&&b.textContent.includes("红雷"))'),'cut sewing destination visible');await shot('02-cut-factory');
 await ev('__search("SCBH-20261105-A03")');await sleep(250);check(await ev('document.querySelectorAll(".tracking-order").length===0'),'whole outsourcing excluded from factory module');
 await send('Page.navigate',{url:base+'/order-allocation'});await sleep(650);
 await ev('window.__search=(value)=>{const el=document.querySelector("input[aria-label=PO号]");el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));Array.from(document.querySelectorAll(".filter-line button")).find(b=>b.textContent.trim()==="查询").click();};__search("SCBH-20261105-A03")');await sleep(250);
 check(await ev('document.querySelectorAll(".tracking-order").length===1'),'whole outsourcing in allocation module');check(await ev('document.querySelector(".node-detail b").textContent.includes("尾")||document.querySelector(".node-detail b").textContent.includes("烫")'),'whole outsourcing starts finishing');await shot('03-whole-outsourcing');
 await send('Page.navigate',{url:base+'/orders?order=6'});await sleep(800);check(await ev('!!document.querySelector(".trial-notice")'),'blocked order is visibly simulated');await shot('04-retained-blocked-case');
 check(errors.length===0,'no browser errors '+errors.join(';'));fs.writeFileSync(path.join(loc.directory,'ui-verification.json'),JSON.stringify({checked_at:new Date().toISOString(),checks,shots:out},null,2));console.log(JSON.stringify({checks,failed:0,shots:out}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{ws?.close();browser?.kill();});
