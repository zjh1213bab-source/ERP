/** 外观发布在独立数据库验证，上传测试文件由本脚本单独清理。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'erp-appearance-'));
process.env.DB_PATH=path.join(directory,'__SMOKE.db');process.env.PORT=String(34000+Math.floor(Math.random()*10000));process.env.ERP_SCHEDULER='0';
require('dotenv').config();const {db,now}=require('../src/db');let server,token,file,checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
async function request(route,body,status=200,method){const r=await fetch(`http://127.0.0.1:${process.env.PORT}`+route,{method:method || (body?'POST':'GET'),headers:{'Content-Type':'application/json',Authorization:token?'Bearer '+token:''},body:body?JSON.stringify(body):undefined});const json=await r.json();assert.equal(r.status,status,route+': '+JSON.stringify(json));checks++;return json.data ?? json;}
(async()=>{
 server=spawn(process.execPath,['src/server.js'],{cwd:path.resolve(__dirname,'..'),env:process.env,windowsHide:true,stdio:'ignore'});
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));try{if((await fetch(`http://127.0.0.1:${process.env.PORT}/api/health`)).ok)break;}catch{}}
 await request('/api/settings/appearance',undefined,401);
 token=(await request('/api/auth/login',{username:'admin',password:process.env.ADMIN_PASSWORD || 'admin123456'})).token;const adminToken=token;
 let config=await request('/api/settings/appearance');check(!config.enabled && config.revision===0,'Safe default without wallpaper');
 const uploaded=await request('/api/upload',{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='});
 check(/^\/uploads\/[a-f0-9]{20}\.png$/.test(uploaded.url),'Uploaded raster only');file=path.resolve(__dirname,'../data',uploaded.url.slice(1));
 const next={...config,enabled:true,image_url:uploaded.url,label:'__SMOKE 节日',opacity:.2,blur:2,position:'center'};
 await request('/api/settings/appearance',{...next,image_url:'https://invalid.example/background.svg'},400,'PUT');
 await request('/api/settings/appearance',{...next,image_url:'/uploads/ffffffffffffffffffff.png'},400,'PUT');
 await request('/api/settings/appearance',{...next,opacity:1},400,'PUT');
 await request('/api/settings/appearance',{...next,position:'center; color:red'},400,'PUT');
 config=await request('/api/settings/appearance',next,200,'PUT');check(config.enabled && config.revision===1 && config.image_url===uploaded.url,'Shared wallpaper persisted');
 await request('/api/settings/appearance',next,409,'PUT');
 const t=now(),userId=Number(db.prepare("INSERT INTO users(username,password_hash,name,role,active,created_at) VALUES('__SMOKE-employee','unused','__SMOKE','employee',1,?)").run(t).lastInsertRowid);
 token=require('jsonwebtoken').sign({sub:userId,tv:0},require('../src/config').jwtSecret);
 const employee=await request('/api/settings/appearance');check(employee.revision===config.revision,'Ordinary employee reads shared appearance');
 await request('/api/settings/appearance',{...config,enabled:false},403,'PUT');
 await request('/api/settings',undefined,403);
 token=adminToken;
 const settings=await request('/api/settings');await request('/api/settings',{exchangeRate:7.1},200,'PUT');
 check((await request('/api/settings/appearance')).revision===config.revision,'Currency update cannot overwrite appearance');
 config=await request('/api/settings/appearance',{...config,enabled:false,image_url:null},200,'PUT');
 check(!config.enabled && !config.image_url && config.revision===2,'Reset removes wallpaper globally');
 check((await request('/api/settings')).exchangeRate===7.1,'Appearance cannot overwrite business settings');
 console.log(`PASS: ${checks} appearance assertions, isolated database only.`);
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(server){server.kill();await new Promise(r=>server.once('exit',r));}db.close();if(file)fs.unlinkSync(file);fs.rmSync(directory,{recursive:true,force:true});});
