/** 现场实测证据只读核对；不清单据、不回写状态，不输出凭据。 */
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{DatabaseSync,backup}=require('node:sqlite');
const location=JSON.parse(fs.readFileSync(path.resolve('../logs/retained-trials-location.json'),'utf8'));
const state=JSON.parse(fs.readFileSync(path.join(location.directory,'manifest.json'),'utf8'));
const db=new DatabaseSync(path.resolve('data/lan-preview.db'),{readOnly:true});let checks=0;
const check=(v,m)=>{assert.ok(v,m);checks++;};
(async()=>{
 const actor=db.prepare('SELECT id,name,employee_id,role FROM users WHERE id=?').get(state.actor_id);check(actor.employee_id===8&&actor.name==='朱佳豪','账号对应朱佳豪');
 const rows=[];
 for(const trial of state.trials){
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(trial.order_id);check(order.status==='closed'&&order.created_by===actor.id,'指定账号完成结案 '+trial.order_no);check(order.remark.includes(state.marker),'单据保留明确实测标记');
  const items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id),qty=items.reduce((s,i)=>s+i.qty,0);
  const pre=db.prepare('SELECT * FROM pre_orders WHERE id=?').get(trial.pre_order_id);check(pre.converted_order_id===order.id&&pre.status==='converted','来源预下单闭环');
  const packs=db.prepare('SELECT * FROM tech_packs WHERE order_id=?').all(order.id);check(items.every(i=>packs.some(p=>p.order_item_id===i.id&&p.status==='confirmed')),'逐款技术资料确认');
  const firsts=db.prepare("SELECT * FROM first_articles WHERE order_id=? AND status IN ('passed','conditional')").all(order.id);check(items.every(i=>packs.some(p=>p.order_item_id===i.id&&firsts.some(f=>f.tech_pack_id===p.id&&f.release_qty>0))),'每款首件分别放行');
  const seals=db.prepare('SELECT * FROM sample_seals WHERE order_id=?').all(order.id);check(items.every(i=>seals.some(s=>s.order_item_id===i.id&&s.status==='confirmed'&&s.tech_approved&&s.customer_confirmed_by.includes('内部模拟'))),'逐款双确认且无冒用客户署名');
  const logs=db.prepare('SELECT to_status,operator,note FROM order_logs WHERE order_id=? ORDER BY id').all(order.id);check(['draft','tech','finance','assigned','production','instock','shipped','closed'].every(s=>logs.some(l=>l.to_status===s)),'状态机全程有日志');check(logs.every(l=>l.operator==='13055709733'),'全部状态日志为指定账号');
  const reports=db.prepare('SELECT * FROM production_reports WHERE order_id=?').all(order.id);check(reports.length>0&&reports.every(r=>r.employee_id===8&&r.remark.includes(state.marker)),'报工归人且标记实测');
  const missingWages=reports.filter(r=>JSON.parse(r.wage_snapshot||'{}').base_unit_price==null).length;
  const ledger=db.prepare("SELECT * FROM stock_ledger WHERE ref_type='order' AND ref_id=?").all(order.id);check(ledger.length===2*items.length&&ledger.reduce((s,l)=>s+l.qty,0)===0,'实测入出库抵消');check(ledger.every(l=>l.remark.includes('内部模拟')),'库存流水保留实测说明');
  const invoices=db.prepare("SELECT * FROM ar_invoices WHERE order_id=? AND status<>'void'").all(order.id);check(invoices.length>0&&invoices.every(a=>Math.abs(a.amount-a.paid_amount)<0.005&&a.remark.includes(state.marker)),'应收核销及说明完整');
  const payments=db.prepare("SELECT DISTINCT p.id,p.amount,p.remark,p.method FROM payments p JOIN payment_allocations a ON a.payment_id=p.id JOIN ar_invoices ar ON ar.id=a.invoice_id WHERE a.invoice_kind='ar' AND ar.order_id=?").all(order.id);check(payments.every(p=>p.remark.includes('内部模拟')&&p.method.includes('内部实测')),'收款仅标记内部模拟');
  const qc=db.prepare("SELECT * FROM qc_inspections WHERE order_id=? AND type='final' AND status='done'").get(order.id);check(qc?.aql_result==='pass'&&qc.remark.includes(state.marker),'模拟尾验放行');
  rows.push({order_id:order.id,order_no:order.order_no,scenario:trial.kind,status:order.status,styles:items.length,qty,reports:reports.length,missing_wage_prices:missingWages,simulated_receipts:invoices.reduce((s,a)=>s+a.paid_amount,0),stock_net:ledger.reduce((s,l)=>s+l.qty,0)});
 }
 check(db.prepare('SELECT status FROM customer_accounts WHERE id=?').get(state.customer_account_id).status==='disabled','内部确认账号停用，记录保留');
 const result={checked_at:new Date().toISOString(),checks,actor,orders:rows,total_qty:rows.reduce((s,r)=>s+r.qty,0),simulated_receipts:rows.reduce((s,r)=>s+r.simulated_receipts,0),remaining:'现场未维护计件单价，未伪造计件工资结算'};
 fs.writeFileSync(path.join(location.directory,'verification.json'),JSON.stringify(result,null,2));await backup(db,path.join(location.directory,'after.db'));console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>db.close());
