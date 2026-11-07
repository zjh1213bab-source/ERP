const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'erp-position-'));process.env.DB_PATH=path.join(dir,'__SMOKE.db');process.env.ERP_SCHEDULER='0';require('dotenv').config();
const {db,now}=require('../src/db');const P=require('../src/services/positionAccess'),A=require('../src/services/access');let n=0;const check=(v)=>{assert.ok(v);n++;};
try{
const admin={username:'__SMOKE-admin'},u=Number(db.prepare("INSERT INTO users(username,password_hash,role,active,company_id,created_at) VALUES('__SMOKE-user','unused','sales',1,1,?)").run(now()).lastInsertRowid);
let s=P.snapshot();check(s.positions.length===0);assert.throws(()=>P.save({revision:0,action:'save',name:'bad',roles:['admin'],perms:[]},admin));n++;
s=P.save({revision:0,action:'save',name:'__SMOKE岗位',roles:['production'],perms:['module.customers.read']},admin);const id=s.positions[0].id;
assert.throws(()=>P.save({revision:0,action:'delete',id},admin));n++;
s=P.save({revision:s.revision,action:'members',id,user_ids:[u]},admin);
check(A.effective(u,'sales').roles.includes('production'));check(!A.effective(u,'sales').roles.includes('sales'));
const req=(url,method='GET')=>({user:{sub:u,role:'production'},originalUrl:url,method});
check(P.check(req('/api/customers'))===null);check(!!P.check(req('/api/orders')));check(!!P.check(req('/api/customers','POST')));check(!!P.check(req('/api/access/positions')));
assert.throws(()=>P.save({revision:s.revision,action:'delete',id},admin));n++;
s=P.save({revision:s.revision,action:'save',id,name:'__SMOKE岗位',roles:['sales'],perms:['module.stock.read','module.stock.write']},admin);check(!!P.check(req('/api/stock/adjust','POST')));
s=P.save({revision:s.revision,action:'save',id,name:'__SMOKE岗位',roles:['warehouse'],perms:['module.stock.read','module.stock.write','stock.write','action.stock.adjust']},admin);check(P.check(req('/api/stock/adjust','POST'))===null);
s=P.save({revision:s.revision,action:'members',id,user_ids:[]},admin);check(!!P.check(req('/api/stock')));check(A.effective(u,'sales').perms.length===0);
s=P.save({revision:s.revision,action:'delete',id},admin);check(s.positions.length===0);check(P.check({user:{sub:u,role:'admin'},originalUrl:'/api/access/positions',method:'PUT'})===null);
check(require('../src/access/permissions').positionGrants(['action.stock.instock']).includes('order.instock'));
console.log('PASS '+n+' position permission assertions');
}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
