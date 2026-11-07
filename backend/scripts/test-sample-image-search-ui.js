/** 真浏览器上传搜款与深浅色验证，使用独立库与临时图片。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-image-search-ui-'));
process.env.DB_PATH=path.join(folder,'__SMOKE.db');process.env.ERP_SCHEDULER='0';require('dotenv').config();
const {db,now}=require('../src/db');const port=39767,debug=9965,base='http://127.0.0.1:'+port;
let server,chrome,ws,file,checks=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms));const check=(v,m)=>{assert.ok(v,m);checks++;};
(async()=>{
 const bytes=await require('sharp')({create:{width:320,height:320,channels:3,background:'#395caa'}}).png().toBuffer();
 const name=require('crypto').randomBytes(10).toString('hex')+'.png';file=path.resolve(__dirname,'../data/uploads',name);fs.writeFileSync(file,bytes);
 const order=Number(db.prepare("INSERT INTO orders(order_no,status,company_id,created_at,updated_at) VALUES('__SMOKE_AI_UI','draft',1,?,?)").run(now(),now()).lastInsertRowid);
 db.prepare("INSERT INTO sample_archives(archive_no,sample_name,order_id,image_url,status,created_at) VALUES('__SMOKE_AI_UI','__SMOKE测试样衣',?,?,'locked',?)").run(order,'/uploads/'+name,now());
 server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port)},windowsHide:true,stdio:'ignore'});
 for(let i=0;i<100;i++){await sleep(100);try{if((await fetch(base+'/api/health')).ok)break;}catch{}}
 chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-sandbox','--disable-gpu','--user-data-dir='+path.join(folder,'chrome'),'--remote-debugging-port='+debug,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let target;for(let i=0;i<80;i++){await sleep(100);try{target=(await(await fetch('http://127.0.0.1:'+debug+'/json')).json()).find(x=>x.type==='page');if(target)break;}catch{}}
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let id=0;const pending=new Map(),errors=[];
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},8000);pending.set(n,r=>{clearTimeout(t);resolve(r)});ws.send(JSON.stringify({id:n,method,params}));});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method==='Page.javascriptDialogOpening'){errors.push(m.params.message);send('Page.handleJavaScriptDialog',{accept:true});}};
 const ev=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}))?.result?.value;
 await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:base+'/login'});await sleep(500);
 const adminId=db.prepare("SELECT id FROM users WHERE username='admin'").get().id,token=require('jsonwebtoken').sign({sub:adminId,tv:0},require('../src/config').jwtSecret);
 await ev('localStorage.setItem("erp_token",'+JSON.stringify(token)+');localStorage.setItem("erp_user",'+JSON.stringify(JSON.stringify({id:adminId,username:'admin',role:'admin'}))+')');
 await send('Page.navigate',{url:base+'/sample-archive'});await sleep(1100);
 check(await ev('!!document.querySelector(".sample-image-search")'),'Image search panel rendered');
 check(await ev('document.querySelector(".sample-image-search button").textContent.includes("上传图片搜款")'),'Upload entry visible');
 const data='data:image/png;base64,'+bytes.toString('base64');
 await ev('(async()=>{const blob=await(await fetch('+JSON.stringify(data)+')).blob();const dt=new DataTransfer();dt.items.add(new File([blob],"__SMOKE.png",{type:"image/png"}));const input=document.querySelector(".sample-image-search input[type=file]");input.files=dt.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');
 for(let i=0;i<60;i++){await sleep(500);if(await ev('document.querySelector(".image-search-message")?.textContent.includes("找到 1 款")'))break;}
 check(await ev('document.querySelector(".image-search-message")?.textContent.includes("找到 1 款")'),'Search completed through UI');
 check(await ev('document.querySelector("table.data tbody")?.textContent.includes("100%")'),'Similarity shown');
 check(await ev('document.querySelector("table.data tbody")?.textContent.includes("__SMOKE_AI_UI")'),'Correct sample displayed');
 check(await ev('!!document.querySelector(".query-thumb")'),'Query preview visible');
 const light=await ev('getComputedStyle(document.querySelector(".sample-image-search")).backgroundColor');
 await ev('document.documentElement.setAttribute("data-theme","dark")');await sleep(200);
 const dark=await ev('getComputedStyle(document.querySelector(".sample-image-search")).backgroundColor');
 check(light!==dark,'Dark mode changes search surface');
 await ev('document.documentElement.setAttribute("data-theme","light");Array.from(document.querySelectorAll(".sample-image-search button")).find(b=>b.textContent.includes("返回全部样衣")).click()');await sleep(400);
 check(await ev('!document.querySelector(".query-thumb")'),'Clear removes query preview');
 check(await ev('!document.querySelector("table.data thead").textContent.includes("相似度")'),'Clear restores ordinary table');
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await sleep(150);
 check(await ev('document.querySelector(".sample-image-search").scrollWidth<=document.querySelector(".sample-image-search").clientWidth+1'),'Search panel fits narrow viewport');
 check(errors.length===0,'Browser errors: '+errors.join(';'));
 console.log('SAMPLE_IMAGE_SEARCH_UI_PASS '+checks);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{
 ws?.close();chrome?.kill();server?.kill();db.close();if(file)fs.rmSync(file,{force:true});await sleep(1500);
 if(folder.startsWith(path.join(os.tmpdir(),'erp-image-search-ui-')))fs.rmSync(folder,{recursive:true,force:true,maxRetries:8,retryDelay:200});
});
