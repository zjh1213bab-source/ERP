/** 真 CLIP 模型 + 临时库 + 临时端口：相似排序、隔离、权限、坏图、缓存、任务归属。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-image-search-'));
process.env.DB_PATH=path.join(folder,'__SMOKE.db');process.env.ERP_SCHEDULER='0';process.env.SINGLE_COMPANY='0';
require('dotenv').config();
const {db,now}=require('../src/db'),{decode,localImage,infer,archiveVector,shutdown}=require('../src/services/sampleImageSearch');
const port=39766,base='http://127.0.0.1:'+port,uploads=path.resolve(__dirname,'../data/uploads');
let server,checks=0,admin,other,token;const files=[];
const check=(value,msg)=>{assert.ok(value,msg);checks++;};
const insert=(table,row)=>{const keys=Object.keys(row);return Number(db.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k])).lastInsertRowid);};
async function req(route,body,expected=200,method){const r=await fetch(base+route,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});const j=await r.json();assert.equal(r.status,expected,route+': '+JSON.stringify(j));checks++;return j.data;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function finish(job){for(let i=0;i<180;i++){const j=await req('/api/sample-archives/image-search/'+job.id);if(j.state==='done'||j.state==='error')return j;await sleep(500);}throw Error('Image search timeout');}
(async()=>{
 const sharp=require('sharp'),{randomBytes}=require('crypto');fs.mkdirSync(uploads,{recursive:true});
 const tee='<svg width="320" height="320"><rect width="320" height="320" fill="white"/><path d="M90 40 L130 28 Q160 64 190 28 L230 40 L290 110 L240 150 L220 125 L220 290 L100 290 L100 125 L80 150 L30 110 Z" fill="#176bcc"/></svg>';
 const bag='<svg width="320" height="320"><rect width="320" height="320" fill="white"/><path d="M110 120 Q110 20 160 20 Q210 20 210 120" stroke="#351b12" stroke-width="14" fill="none"/><rect x="60" y="110" width="200" height="180" rx="20" fill="#a4662a"/></svg>';
 const bytes=await sharp(Buffer.from(tee)).png().toBuffer(),alt=await sharp(Buffer.from(bag)).png().toBuffer();
 const photo=async b=>{const name=randomBytes(10).toString('hex')+'.png',file=path.join(uploads,name);fs.writeFileSync(file,b);files.push(file);return '/uploads/'+name;};
 const url=await photo(bytes),bagUrl=await photo(alt),badUrl=await photo(Buffer.from('not-an-image'));
 check(decode('data:image/png;base64,'+bytes.toString('base64')).equals(bytes),'dataURL decoding');
 assert.throws(()=>decode('data:image/svg+xml;base64,PHN2Zz4='));checks++;
 assert.throws(()=>decode('data:image/png;base64,'+Buffer.alloc(4*1024*1024).toString('base64')));checks++;
 await assert.rejects(()=>localImage('/uploads/../.env'));checks++;
 await assert.rejects(()=>localImage('http://127.0.0.1/private.png'));checks++;
 const vector=await infer(bytes);check(vector.length===512&&Math.abs(Math.hypot(...vector)-1)<0.0001,'Real model normalized vector');
 const cached=await archiveVector(bytes),same=await archiveVector(bytes);check(JSON.stringify(cached)===JSON.stringify(same),'Content cache deterministic');
 const bagVector=await infer(alt);check(vector.reduce((s,v,i)=>s+v*bagVector[i],0)<0.99,'Real model distinguishes shapes');shutdown();
 const company1=Number(db.prepare('SELECT id FROM companies ORDER BY id LIMIT 1').get().id);
 const company2=insert('companies',{code:'__SMOKE_AI_2',name:'__SMOKE AI 2',type:'subsidiary',created_at:now()});
 const ownOrder=insert('orders',{order_no:'__SMOKE_AI_OWN',status:'draft',company_id:company1,created_at:now(),updated_at:now()});
 const otherOrder=insert('orders',{order_no:'__SMOKE_AI_OTHER',status:'draft',company_id:company2,created_at:now(),updated_at:now()});
 const sample=(no,image,order)=>insert('sample_archives',{archive_no:no,sample_name:no,style_no:no,order_id:order,image_url:image,status:'locked',created_at:now()});
 const sameId=sample('__SMOKE_AI_TEE',url,ownOrder),bagId=sample('__SMOKE_AI_BAG',bagUrl,ownOrder),hiddenId=sample('__SMOKE_AI_SECRET',url,otherOrder);sample('__SMOKE_AI_CORRUPT',badUrl,ownOrder);sample('__SMOKE_AI_BROKEN_PNG',await photo(Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(20)])),ownOrder);
 const adminId=db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
 const member=insert('users',{username:'__SMOKE_AI_USER',password_hash:'unused',role:'employee',company_id:company1,active:1,created_at:now()});
 const jwt=require('jsonwebtoken'),secret=require('../src/config').jwtSecret;
 admin=jwt.sign({sub:adminId,tv:0},secret);other=jwt.sign({sub:member,tv:0},secret);
 server=spawn(process.execPath,['src/server.js'],{env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','ignore','pipe']});server.stderr.on('data',b=>fs.appendFileSync(path.join(folder,'server.log'),b));
 for(let i=0;i<100;i++){await sleep(100);try{if((await fetch(base+'/api/health')).ok)break;}catch{}}
 const body={dataUrl:'data:image/png;base64,'+bytes.toString('base64')};
 await req('/api/sample-archives/image-search',body,401);token=admin;
 await req('/api/sample-archives/image-search',{dataUrl:'https://example.com/a.png'},400);
 await req('/api/sample-archives/image-search',{...body,status:'invalid'},400);
 const job=await req('/api/sample-archives/image-search',body);await req('/api/sample-archives/image-search',body,409);
 let result=await finish(job);
 // 损坏的文件头应跳过，其余图片必须生成真实模型结果。
 check(result.state==='done','Search completes: '+result.message);check(result.skipped===2,'Corrupt archive skipped');
 check(result.matches.find(m=>m.id===sameId).similarity===100,'Identical image 100 percent');
 check(result.matches.find(m=>m.id===bagId).similarity<100,'Different style lower score');
 check(result.matches.some(m=>m.id===hiddenId),'Admin may see cross-company');
 token=other;await req('/api/sample-archives/image-search',body,403);token=admin;
 let settings=await req('/api/access/positions');
 settings=await req('/api/access/positions',{revision:settings.revision,action:'save',name:'__SMOKE AI岗',perms:['module.sample-archives.read']},200,'PUT');
 const position=settings.positions.find(p=>p.name==='__SMOKE AI岗');
 settings=await req('/api/access/positions',{revision:settings.revision,action:'members',id:position.id,user_ids:[member]},200,'PUT');
 token=other;await req('/api/sample-archives/image-search',body,403);token=admin;
 settings=await req('/api/access/positions',{revision:settings.revision,action:'save',id:position.id,name:position.name,perms:['action.sample-archives.image-search']},200,'PUT');
 token=other;await req('/api/sample-archives/image-search/'+job.id,undefined,404);
 result=await finish(await req('/api/sample-archives/image-search',body));
 check(result.state==='done'&&!result.matches.some(m=>m.id===hiddenId),'Company isolation with granted action');
 const filtered=await finish(await req('/api/sample-archives/image-search',{...body,q:'__SMOKE_AI_BAG'}));check(filtered.matches.length===1&&filtered.matches[0].id===bagId,'Keyword filter respected');
 db.prepare('UPDATE sample_archives SET image_url=? WHERE id=?').run(bagUrl,sameId);
 const invalidated=await req('/api/sample-archives/image-search/'+result.id);check(!invalidated.matches.some(m=>m.id===sameId),'Changed image removed from old results');
 const after=await finish(await req('/api/sample-archives/image-search',body));check(after.matches.find(m=>m.id===sameId).similarity<100,'Changed bytes recomputed');
 token=admin;const empty=await finish(await req('/api/sample-archives/image-search',{...body,q:'__SMOKE_AI_EMPTY'}));check(empty.matches.length===0&&empty.total===0,'Empty archive scope handled');
 console.log('SAMPLE_IMAGE_SEARCH_PASS '+checks);
})().catch(e=>{console.error(e.stack);try{console.error(fs.readFileSync(path.join(folder,'server.log'),'utf8').slice(-4000));}catch{}process.exitCode=1;}).finally(async()=>{
 shutdown();server?.kill();db.close();for(const file of files)fs.rmSync(file,{force:true});
 await new Promise(r=>setTimeout(r,1500));
 // Only remove the exact freshly-created test directory under the OS temp folder.
 if(folder.startsWith(path.join(os.tmpdir(),'erp-image-search-')))fs.rmSync(folder,{recursive:true,force:true,maxRetries:5,retryDelay:200});
});
