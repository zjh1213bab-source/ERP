/** 全部静态业务路由的深浅色渲染巡检。临时库自带 __SMOKE 基础配置，不借用真实业务数据。 */
const fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
require('dotenv').config();
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-workspace-sweep-'));
const port=35000+Math.floor(Math.random()*9000),base='http://127.0.0.1:'+port;
const env={...process.env,PORT:String(port),DB_PATH:path.join(folder,'__SMOKE.db'),ERP_SCHEDULER:'0',BASE:base};
let server;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const parser=require('../../frontend/node_modules/@babel/parser');
 const ast=parser.parse(fs.readFileSync('../frontend/src/router.js','utf8'),{sourceType:'module'}),pages=new Set();
 function walk(node){if(!node || typeof node!=='object')return;if(node.type==='ObjectProperty' && (node.key.name || node.key.value)==='children' && node.value.type==='ArrayExpression')for(const row of node.value.elements || []){const prop=row?.properties?.find(p=>(p.key?.name || p.key?.value)==='path'),route=prop?.value?.value;if(typeof route==='string' && !route.includes(':'))pages.add('/'+route.replace(/^\//,''));}for(const key in node){const child=node[key];if(Array.isArray(child))child.forEach(walk);else if(child && typeof child==='object')walk(child);}}
 walk(ast);if(process.argv[2]){pages.clear();process.argv[2].split(',').forEach(p=>pages.add(p));}
 server=spawn(process.execPath,['src/server.js'],{env,windowsHide:true,stdio:'ignore'});
 for(let i=0;i<100;i++){await sleep(100);try{if((await fetch(base+'/api/health')).ok)break;}catch{}}
 const login=await(await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:process.env.ADMIN_PASSWORD || 'admin123456'})})).json();
 if(!login.data?.token)throw new Error('Isolated login failed');
 const headers={'Content-Type':'application/json',Authorization:'Bearer '+login.data.token};
 async function setup(route,body,method='POST'){const response=await fetch(base+route,{method,headers,body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error('Fixture setup '+route+': '+result.message);return result.data;}
 const template=await setup('/api/node-flow/templates',{name:'__SMOKE UI流程模板',status:'active'});
 await setup(`/api/node-flow/templates/${template.id}/default`,{});
 await setup('/api/mindmap',{data:{center:{title:'__SMOKE 业务蓝图',subtitle:'独立页面巡检',tags:'__SMOKE'},modules:[]}},'PUT');
 let source=fs.readFileSync('scripts/sweep-pages.js','utf8').replace("password: 'admin123456'","password: (process.env.ADMIN_PASSWORD || 'admin123456')");
 source=source.replace('    const len = await ev(',`    for(const mode of ['light','dark']) {
 await ev("if(document.documentElement.dataset.theme!=="+JSON.stringify(mode)+")document.querySelector('.theme-toggle')?.click()");await sleep(100);
 const severe=await ev(\`(()=>{const rgb=s=>{const a=s.match(/^rgba?\\\\(([^)]+)\\\\)/);return a?a[1].split(',').map(Number):null};const lum=a=>a.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);const bad=[];for(const node of [...document.querySelectorAll('.panel-card,.stat-card,td,input,select,textarea')].slice(0,180)){if(!node.getBoundingClientRect().height || node.disabled)continue;const style=getComputedStyle(node),fg=rgb(style.color);let ancestor=node,bg;while(ancestor){const candidate=rgb(getComputedStyle(ancestor).backgroundColor);if(candidate && (candidate.length<4 || candidate[3]>.95)){bg=candidate;break;}ancestor=ancestor.parentElement;}if(!fg||!bg)continue;const x=lum(fg),y=lum(bg),ratio=(Math.max(x,y)+.05)/(Math.min(x,y)+.05);if(ratio<2.5 && node.textContent.trim())bad.push({tag:node.tagName,text:node.textContent.trim().slice(0,24),ratio:ratio.toFixed(2)});}return bad.slice(0,4);})()\`);
 if(severe?.length)errs.push('Contrast '+mode+': '+JSON.stringify(severe));
 }
 if((good+bad.length)%15===0)console.log('Checked '+(good+bad.length)+' / '+list.length);
    const len = await ev(`);
 const file=path.join(folder,'sweep.cjs');fs.writeFileSync(file,source);
 const log=fs.openSync(process.argv[2]?'data/logs/workspace-sweep-targeted.log':'data/logs/workspace-sweep.log','w');
 const child=spawn(process.execPath,[file,[...pages].join(',')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{fs.writeSync(log,chunk);process.stdout.write(chunk);});
 const code=await new Promise(r=>child.on('exit',r));fs.closeSync(log);process.exitCode=code;
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(server){server.kill();await new Promise(r=>server.once('exit',r));}fs.rmSync(folder,{recursive:true,force:true});});
