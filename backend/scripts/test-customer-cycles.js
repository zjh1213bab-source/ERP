const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
process.env.DB_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'erp-cycles-')),'__SMOKE.db');process.env.ERP_SCHEDULER='0';
const {db}=require('../src/db'),svc=require('../src/services/customerCycles');
let checks=0;const check=(v)=>{assert.ok(v);checks++;};
try{
 const user=db.prepare("SELECT * FROM users WHERE username='admin'").get();
 const at='2026-11-04T04:00:00Z';
 const id=Number(db.prepare("INSERT INTO customers(name,status,created_at,updated_at,owner_user_id,order_cycle_days,cycle_started_at,company_id) VALUES('__SMOKE周期','active',?,?,?,?,?,1)").run(at,at,user.id,30,'2026-09-01T00:00:00Z').lastInsertRowid);
 const row=()=>db.prepare('SELECT * FROM customers WHERE id=?').get(id);
 const order=(no,date,status,amount)=>db.prepare('INSERT INTO orders(order_no,customer_id,status,total_amount,order_date,created_at,updated_at,company_id) VALUES(?,?,?,?,?,?,?,1)').run(no,id,status,amount,date,at,at);
 order('__SMOKE-1','2026-09-01','closed',100);order('__SMOKE-2','2025-10-01','closed',200);order('__SMOKE-draft','2026-11-01','draft',999);
 let s=svc.summary(row(),user,at);check(s.orders_1y===1&&s.orders_2y===2);check(s.amount_1y===100&&s.amount_2y===300);check(s.cycle_overdue);
 check(svc.tick(at)===1);check(svc.tick(at)===0);check(db.prepare('SELECT COUNT(*) n FROM mail_recipients WHERE username=? AND read_flag=0').get(user.username).n===1);
 order('__SMOKE-new','2026-11-04','tech',50);check(!svc.summary(row(),user,at).cycle_overdue);check(svc.tick(at)===0);
 assert.throws(()=>svc.input({order_cycle_days:-1},row(),user));checks++;
 assert.throws(()=>svc.input({owner_user_id:null,order_cycle_days:30}, {},user));checks++;
 assert.throws(()=>svc.input({cycle_version:999},row(),user));checks++;
 check(svc.input({},row(),user).cycle_version===row().cycle_version+1);
 db.prepare("UPDATE customers SET status='disabled' WHERE id=?").run(id);check(svc.tick('2027-01-01T00:00:00Z')===0);
 console.log(JSON.stringify({checks,failed:0,db:process.env.DB_PATH}));
}finally{db.close();}
