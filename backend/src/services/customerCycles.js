/** 客户复购统计与内部邮件预警。配置版本、最近订单共同构成幂等键；投递与去重同事务提交。 */
const {db,now}=require('../db');
const scope=require('../access/companyScope');
const {localDate}=require('../utils/time');
function bad(message){throw Object.assign(new Error(message),{status:400});}
function input(body,old,user){
  if(body.cycle_version!=null && old.id && Number(body.cycle_version)!==old.cycle_version) throw Object.assign(new Error('客户已被修改，请刷新'),{status:409});
  const rawOwner=Object.prototype.hasOwnProperty.call(body,'owner_user_id')?body.owner_user_id:old.owner_user_id;
  const owner=rawOwner==null||rawOwner===''?null:Number(rawOwner);
  if(owner!==null&&(!Number.isSafeInteger(owner)||owner<=0))bad('业务员账号无效');
  const days=Number(body.order_cycle_days ?? old.order_cycle_days ?? 0);
  if(!Number.isInteger(days)||days<0||days>3650) bad('下单周期须为 0–3650 天，0 表示关闭');
  if(owner){const c=scope.clause(user);if(!db.prepare('SELECT id FROM users WHERE id=? AND active=1'+c.sql).get(owner,...c.params))bad('业务员账号不存在、停用或不在当前主体');}
  if(days&&!owner)bad('启用下单周期预警前请绑定业务员');
  return {owner_user_id:owner,order_cycle_days:days,cycle_started_at:(!old.order_cycle_days&&days)?now():(old.cycle_started_at||now()),cycle_version:(old.cycle_version||0)+1};
}
function summary(c,user,at=now()){
  const sc=user?scope.clause(user):{sql:'',params:[]};
  const rows=db.prepare("SELECT id,order_date,created_at,total_amount FROM orders WHERE customer_id=? AND status NOT IN ('draft','cancelled','void','canceled')"+sc.sql).all(c.id,...sc.params);
  const today=localDate(at);const cutoff=y=>{const d=new Date(today+'T00:00:00Z');d.setUTCFullYear(d.getUTCFullYear()-y);return d.toISOString().slice(0,10);};
  const dates=rows.map(r=>({...r,date:localDate(r.order_date||r.created_at)})).filter(r=>r.date<=today);
  const last=dates.sort((a,b)=>b.date.localeCompare(a.date)||b.id-a.id)[0];
  const anchor=last?.date||localDate(c.cycle_started_at||c.created_at);
  const elapsed=Math.max(0,Math.floor((Date.parse(today)-Date.parse(anchor))/86400000));
  const result={owner_name:db.prepare('SELECT name FROM users WHERE id=?').get(c.owner_user_id)?.name||'',last_order_date:last?.date||null,days_since_order:elapsed,cycle_overdue:!!c.order_cycle_days&&elapsed>c.order_cycle_days,cycle_anchor:last?String(last.id)+':'+last.date:anchor};
  for(const y of [1,2]){const rr=dates.filter(r=>r.date>=cutoff(y));result['orders_'+y+'y']=rr.length;result['amount_'+y+'y']=Math.round(rr.reduce((n,r)=>n+Number(r.total_amount||0),0)*100)/100;}
  return result;
}
function tick(at=now()){
  let sent=0;
  for(const c of db.prepare("SELECT * FROM customers WHERE status='active' AND order_cycle_days>0 AND owner_user_id IS NOT NULL").all()){
    const u=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(c.owner_user_id);if(!u)continue;
    const s=summary(c,u,at);if(!s.cycle_overdue)continue;
    const key=`customer-cycle:${c.id}:${c.order_cycle_days}:${c.cycle_started_at}:${c.owner_user_id}:${s.cycle_anchor}`;
    db.exec('BEGIN');
    try{
      if(db.prepare('SELECT key FROM app_config WHERE key=?').get(key)){db.exec('ROLLBACK');continue;}
      const subject=`客户下单周期预警：${c.name}`;
      const body=`客户：${c.name}\n最近下单：${s.last_order_date||'暂无正式订单'}\n已间隔 ${s.days_since_order} 天，设置周期 ${c.order_cycle_days} 天。请及时联系客户。\n近1年：${s.orders_1y} 单，人民币 ${s.amount_1y} 元；近2年：${s.orders_2y} 单，人民币 ${s.amount_2y} 元。\n统计排除草稿及作废单，金额为订单人民币快照。`;
      const thread=db.prepare("INSERT INTO mail_threads(subject,message_count,last_message_at,created_by,created_at,updated_at) VALUES(?,1,?,'system',?,?)").run(subject,at,at,at).lastInsertRowid;
      const message=db.prepare("INSERT INTO mail_messages(thread_id,subject,body,sender,sender_name,company_id,request_no,created_at) VALUES(?,?,?,'system','系统预警',?,?,?)").run(thread,subject,body,c.company_id,key,at).lastInsertRowid;
      const recipient=db.prepare("INSERT INTO mail_recipients(message_id,user_id,username,name,delivery_status,delivered_at,read_flag,deliver_attempt) VALUES(?,?,?,?,'delivered',?,0,1)").run(message,u.id,u.username,u.name,at).lastInsertRowid;
      db.prepare("INSERT INTO mail_delivery_events(message_id,recipient_id,event,detail,operator,created_at) VALUES(?,?,'deliver','客户周期自动预警','system',?)").run(message,recipient,at);
      db.prepare("INSERT INTO app_config(key,value,updated_at) VALUES(?,?,?)").run(key,JSON.stringify({message_id:Number(message)}),at);
      db.exec('COMMIT');sent++;
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  return sent;
}
function start(){if(process.env.ERP_SCHEDULER==='0'&&process.env.CUSTOMER_CYCLE_SCHEDULER!=='1')return;const run=()=>{try{tick();}catch(e){console.error('[customer-cycle]',e.stack);}};run();setInterval(run,15*60*1000).unref();}
module.exports={input,summary,tick,start};
