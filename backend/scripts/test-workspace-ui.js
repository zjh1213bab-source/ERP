/** Headless Chromium UI verification with isolated service/database and deterministic screenshots. */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
require('dotenv').config();
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-workspace-ui-'));
const port=35000+Math.floor(Math.random()*9000),debug=45000+Math.floor(Math.random()*9000),base='http://127.0.0.1:'+port;
const env={...process.env,PORT:String(port),DB_PATH:path.join(folder,'__SMOKE-ui.db'),ERP_SCHEDULER:'0'};
const output=path.resolve('data/logs/workspace-ui');fs.mkdirSync(output,{recursive:true});
const uploaded=new Set();let server,chrome,ws,token,checks=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function check(condition,label){assert.ok(condition,label);checks++;}
async function request(route,body,method){const r=await fetch(base+route,{method:method || (body?'POST':'GET'),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined});const json=await r.json();assert.ok(r.ok,route+': '+json.message);return json.data;}
(async()=>{
 server=spawn(process.execPath,['src/server.js'],{env,windowsHide:true,stdio:'ignore'});
 for(let i=0;i<100;i++){await sleep(100);try{if((await fetch(base+'/api/health')).ok)break;}catch{}}
 const login=await request('/api/auth/login',{username:'admin',password:process.env.ADMIN_PASSWORD || 'admin123456'});token=login.token;
 await request('/api/quotations',{items:[{product_name:'__SMOKE 春夏针织系列',qty:120,price_usd:8.5,color:'米白'},{product_name:'__SMOKE 商务休闲系列',qty:80,price_usd:12,color:'深灰'}]});
 const executable='C:/Program Files/Google/Chrome/Application/chrome.exe';
 chrome=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-port='+debug,'--user-data-dir='+path.join(folder,'chrome'),'--window-size=1600,1000','about:blank'],{windowsHide:true,stdio:'ignore'});
 let target;for(let i=0;i<100;i++){await sleep(100);try{target=(await(await fetch(`http://127.0.0.1:${debug}/json`)).json()).find(t=>t.type==='page');if(target)break;}catch{}}
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let id=0;const pending=new Map();let errors=[];
 ws.onmessage=event=>{const data=JSON.parse(event.data);if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.text);if(data.id && pending.has(data.id)){const done=pending.get(data.id);pending.delete(data.id);data.error?done.reject(new Error(JSON.stringify(data.error))):done.resolve(data.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception.description);return result.result?.value;};
 async function wait(expression){for(let i=0;i<80;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error('UI wait timed out: '+expression);}
 async function shot(name){const result=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));}
 await send('Page.enable');await send('Runtime.enable');const preload=await send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('erp_token',${JSON.stringify(token)});localStorage.setItem('erp_user',${JSON.stringify(JSON.stringify(login.user))});if(!localStorage.getItem('erp_theme'))localStorage.setItem('erp_theme','light');localStorage.setItem('erp_nav_palette','pearl');`});
 await send('Page.navigate',{url:base+'/quotations'});await wait("document.querySelector('table.data tbody td') && document.querySelector('.appearance-top-trigger')");await sleep(250);
 check(await evaluate("document.querySelectorAll('.erp-nav svg').length>10"),'Navigation uses unified line icons');
 check(await evaluate("getComputedStyle(document.querySelector('.erp-sidebar')).width==='244px'"),'New workspace structure applied');
 await shot('quotations-light');await evaluate("document.querySelector('.theme-toggle').click()");await sleep(150);
 check(await evaluate("document.documentElement.dataset.theme==='dark' && getComputedStyle(document.querySelector('.erp-topbar')).backgroundColor==='rgb(27, 37, 45)'"),'Dark surfaces applied');await shot('quotations-dark');
 await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('新建报价单')).click()");await wait("!!document.querySelector('.modal-mask')");await shot('quotation-dialog-dark');
 await evaluate("document.querySelector('.modal-mask').dispatchEvent(new MouseEvent('click',{bubbles:true}))");check(await evaluate("!!document.querySelector('.modal-mask')"),'Backdrop retains business form');await evaluate("document.querySelector('.modal-head .x').click()");
 await evaluate("document.querySelector('.appearance-top-trigger').click()");await wait("!!document.querySelector('#holiday-file') && !document.querySelector('.appearance-panel fieldset').disabled");
 check(await evaluate("document.activeElement===document.querySelector('.appearance-close')"),'Appearance drawer receives keyboard focus');
 await evaluate("[...document.querySelectorAll('.appearance-tabs button')].find(b=>b.textContent.includes('节假日背景')).click()");
 const imagePath=path.join(folder,'__SMOKE-background.png');fs.writeFileSync(imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
 const documentNode=await send('DOM.getDocument');const input=await send('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'#holiday-file'});await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[imagePath]});await wait("document.querySelector('.appearance-panel').textContent.includes('上传成功')");uploaded.add(await evaluate("document.querySelector('.wallpaper-preview>img').getAttribute('src')"));
 await evaluate("[...document.querySelectorAll('.appearance-foot button')].find(b=>b.textContent.includes('发布全站')).click()");await wait("document.querySelector('.appearance-panel').textContent.includes('已发布')");
 const appearance=await request('/api/settings/appearance');uploaded.add(appearance.image_url);
 check(appearance.enabled && appearance.revision===1,'Actual image upload and shared publish work');
 check(await evaluate("document.documentElement.dataset.wallpaper==='on' && getComputedStyle(document.querySelector('.erp-shell'),'::before').backgroundImage.includes('/uploads/')"),'Published background is visible in workspace layer');
 await shot('appearance-settings');await evaluate("document.querySelector('.appearance-close').click()");
 await send('Emulation.setEmulatedMedia',{media:'print'});
 check(await evaluate("getComputedStyle(document.querySelector('.erp-shell'),'::before').display==='none' && getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()==='#fff'"),'Printing hides wallpaper and restores paper surfaces in dark mode');
 await send('Emulation.setEmulatedMedia',{media:''});await send('Page.reload');await wait("!!document.querySelector('.appearance-top-trigger') && document.documentElement.dataset.wallpaper==='on'");
 check(await evaluate("document.documentElement.dataset.theme==='dark'"),'Mode and background persist after reload');
 await request('/api/settings/appearance',{...appearance,enabled:false},'PUT');await evaluate("window.dispatchEvent(new Event('focus'))");await wait("document.documentElement.dataset.wallpaper==='off'");checks++;
 await evaluate("document.querySelector('.theme-toggle').click()");await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(250);
 check(await evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"),'Mobile workspace has no page-wide horizontal overflow');await shot('quotations-mobile');
 await evaluate("document.querySelector('.nav-toggle').click()");check(await evaluate("document.querySelector('.erp-sidebar').classList.contains('open')"),'Mobile navigation remains accessible');
 await send('Emulation.clearDeviceMetricsOverride');await send('Page.navigate',{url:base+'/blueprint'});await wait("document.body.textContent.includes('尚未配置业务蓝图')");checks++;
 await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:preload.identifier});await evaluate("localStorage.removeItem('erp_token');localStorage.removeItem('erp_user')");
 await send('Page.navigate',{url:base+'/login'});await wait("!!document.querySelector('.login-intro')");
 check(await evaluate("getComputedStyle(document.querySelector('.login-intro')).display!=='none' && document.querySelectorAll('.login-box .input').length===2"),'Login uses redesigned workspace composition');await shot('login-light');
 check(errors.length===0,'No uncaught UI exceptions: '+errors.join(','));
 console.log(`PASS: ${checks} workspace interactions. Screenshots: ${output}`);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{
 if(ws)ws.close();for(const process of [chrome,server])if(process){process.kill();await new Promise(r=>process.once('exit',r));}
 for(const url of uploaded)if(/^\/uploads\/[a-f0-9]{20}\.png$/.test(url))fs.unlinkSync(path.resolve('data',url.slice(1)));
 await sleep(250);fs.rmSync(folder,{recursive:true,force:true,maxRetries:5,retryDelay:200});
});
