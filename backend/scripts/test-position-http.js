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
token=(await request('/api/auth/login',{username:'admin',password:process.env.ADMIN_PASSWORD||'admin123456'})).token;const admin=token;
let s=await request('/api/access/positions');s=await request('/api/access/positions',{revision:s.revision,action:'save',name:'__SMOKE岗位',roles:['sales'],perms:['module.customers.read']},200,'PUT');const id=s.positions[0].id;
const uid=Number(db.prepare("INSERT INTO users(username,password_hash,role,active,company_id,created_at) VALUES('__SMOKE-http','unused','employee',1,1,?)").run(now()).lastInsertRowid);
s=await request('/api/access/positions',{revision:s.revision,action:'members',id,user_ids:[uid]},200,'PUT');token=require('jsonwebtoken').sign({sub:uid,tv:0},require('../src/config').jwtSecret);
await request('/api/customers');await request('/api/orders',undefined,403);await request('/api/customers',{name:'__SMOKE-denied'},403);await request('/api/access/positions',undefined,403);check((await request('/api/access/me')).roles.includes('sales'),'New position replaces employee ceiling');
token=admin;s=await request('/api/access/positions',{revision:s.revision,action:'members',id,user_ids:[]},200,'PUT');token=require('jsonwebtoken').sign({sub:uid,tv:0},require('../src/config').jwtSecret);await request('/api/customers',undefined,403);
// 模块操作与编辑不能隐含删除、停用、启用权限。
token=admin;
const customer=await request('/api/customers',{name:'__SMOKE-action',contact:'__SMOKE',email:'smoke@example.test'});
const assign=async(perms)=>{
 token=admin;s=await request('/api/access/positions',{revision:s.revision,action:'save',id,name:'__SMOKE岗位',roles:['sales'],perms},200,'PUT');
 s=await request('/api/access/positions',{revision:s.revision,action:'members',id,user_ids:[uid]},200,'PUT');
 token=require('jsonwebtoken').sign({sub:uid,tv:0},require('../src/config').jwtSecret);
};
const base=['module.customers.read','module.customers.write','customer.write'];
await assign([...base,'action.customers.edit']);
await request('/api/customers/'+customer.id,{remark:'__SMOKE edited',status:'active'},200,'PUT');
await request('/api/customers/'+customer.id,undefined,403,'DELETE');
await request('/api/customers/'+customer.id,{status:'disabled'},403,'PUT');
await request('/api/customers',{name:'__SMOKE denied',contact:'__SMOKE',email:'smoke@example.test'},403);
await assign([...base,'action.customers.disable']);
await request('/api/customers/'+customer.id,undefined,200,'DELETE');
await request('/api/customers/'+customer.id,{status:'active'},403,'PUT');
await assign([...base,'action.customers.edit','action.customers.enable']);
await request('/api/customers/'+customer.id,{status:'active'},200,'PUT');
await request('/api/customers/'+customer.id,undefined,403,'DELETE');
check((await request('/api/access/me')).position_permissions.includes('action.customers.enable'),'Button permissions supplied by access/me');
token=admin;
const quote=await request('/api/quotations',{customer_id:customer.id,items:[{product_name:'__SMOKE delete test',qty:1,price_usd:1}]});
await assign(['module.quotations.read','module.quotations.write','quote.write','action.quotations.edit']);
await request('/api/quotations/'+quote.id,undefined,403,'DELETE');
await assign(['module.quotations.read','module.quotations.write','quote.write','action.quotations.delete']);
await request('/api/quotations/'+quote.id,undefined,200,'DELETE');
check(!db.prepare('SELECT id FROM quotations WHERE id=?').get(quote.id),'Granted delete removed only the fixture');
const {positionAction,positionActions}=require('../src/access/permissions');
check(positionAction('customers','DELETE','/:id')==='disable','Master delete means disable');
check(positionAction('products','DELETE','/:id/colors/:colorId')==='delete','Child deletion stays separate');
check(positionAction('quotations','DELETE','/:id')==='delete','Quotation deletion stays separate');
check(positionActions().customers.some(x=>x.action==='disable')&&!positionActions().customers.some(x=>x.action==='delete'),'Customer catalog matches actual semantics');
// 未分配业务岗位的真实员工：基础入口可用，业务接口仍拒绝。
const employeeId=Number(db.prepare("INSERT INTO users(username,name,password_hash,role,active,company_id,created_at) VALUES('__SMOKE-portal','__SMOKE portal','unused','employee',1,1,?)").run(now()).lastInsertRowid);
token=require('jsonwebtoken').sign({sub:employeeId,tv:0},require('../src/config').jwtSecret);
await request('/api/mail/box');await request('/api/mail/contacts');
check((await request('/api/assistant/query',{q:'本月工资'})).scope==='self','Assistant does not expose payroll data');
await request('/api/assistant/insights');await request('/api/assistant/report');
await request('/api/orders',undefined,403);await request('/api/exceptions/scan',{},403);
await request('/api/exceptions/meta');await request('/api/exceptions/daily');await request('/api/exceptions/report');
const addException=(no,owner)=>Number(db.prepare("INSERT INTO exception_items(item_no,company_id,rule_code,category,first_day,source_type,source_id,title,owner_username,status,biz_key) VALUES(?,1,'__SMOKE','tech','2026-11-03','__SMOKE',1,?,?, 'open',?)").run(no,no,owner,no).lastInsertRowid);
const own=addException('__SMOKE-own','__SMOKE-portal'),other=addException('__SMOKE-other','admin');
const ownList=await request('/api/exceptions?owner=admin');check(ownList.length===0,'Query cannot impersonate another owner');
const all=await request('/api/exceptions');check(all.length===1&&all[0].id===own,'Only assigned exceptions visible');
await request('/api/exceptions/'+own);await request('/api/exceptions/'+other,undefined,404);
// 统一入口无需业务职责、旧写权限或第二次复核。
token=admin;s=await request('/api/access/positions');
s=await request('/api/access/positions',{revision:s.revision,action:'save',id,name:'__SMOKE统一权限',perms:['action.customers.edit']},200,'PUT');
s=await request('/api/access/positions',{revision:s.revision,action:'members',id,user_ids:[uid]},200,'PUT');
db.prepare("INSERT INTO access_exceptions(user_id,perm,effect,reason,created_at) VALUES(?,'customer.write','deny','__SMOKE legacy review',?)").run(uid,now());
// 新岗位不会再被历史复核例外覆盖。
token=require('jsonwebtoken').sign({sub:uid,tv:0},require('../src/config').jwtSecret);
const unified=await request('/api/access/me');
check(unified.position_direct&&unified.perms.includes('customer.write')&&!unified.denied.includes('customer.write'),'Selected action is sole authority');
check(unified.position_permissions.includes('module.customers.read')&&unified.position_permissions.includes('module.customers.write'),'No extra module write toggle required');
await request('/api/customers/'+customer.id,{remark:'__SMOKE unified direct'},200,'PUT');
await request('/api/customers/'+customer.id,undefined,403,'DELETE');
await request('/api/access/positions',undefined,403);
token=admin;s=await request('/api/access/positions');check(s.audit.some(x=>x.action==='save'&&x.operator==='admin'),'Changes remain auditable without signoff');
console.log('PASS '+checks+' HTTP position assertions');
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(server){server.kill();await new Promise(r=>server.once('exit',r));}db.close();fs.rmSync(directory,{recursive:true,force:true});});
