/** 独立夹具验证提醒投影和计件成本复用；不触碰局域网业务库。 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
process.chdir(path.resolve(__dirname,'..'));process.env.DB_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'erp-workbench-')),'__SMOKE.db');process.env.ERP_SCHEDULER='0';require('dotenv').config();
const {db,now}=require('../src/db');const notices=require('../src/services/reviewNotices'),cost=require('../src/services/sampleCostEvidence');let checks=0;function check(v,m){assert.ok(v,m);checks++;}
const admin={sub:1,role:'admin',company_id:1};const insert=(table,row)=>{const k=Object.keys(row);return Number(db.prepare(`INSERT INTO ${table}(${k.join(',')}) VALUES(${k.map(()=>'?').join(',')})`).run(...Object.values(row)).lastInsertRowid);};
const order=insert('orders',{order_no:'__SMOKE-WORKBENCH',company_id:1,status:'production',created_at:now(),updated_at:now()});
const tp=insert('tech_packs',{order_id:order,product_name:'__SMOKE样衣',customer_style_no:'__SMOKE-ST',version:'V1',status:'draft',created_at:now(),updated_at:now()});
check(cost.read(tp).scan_known_amount===null,'No report amount is unknown rather than zero');
check(cost.read(tp).material_unit_cost===null,'No material quote is unknown rather than zero');
insert('cost_sheets',{order_id:order,status:'pending',created_at:now(),updated_at:now()});
check(notices.list(admin).items.some(r=>r.key==='cost'&&r.count===1),'Pending cost produces one notice');
db.prepare("UPDATE cost_sheets SET status='approved' WHERE order_id=?").run(order);
check(notices.list(admin).items.find(r=>r.key==='cost').count===0,'Reviewed cost disappears');
check(!notices.list({sub:99999,role:'employee',company_id:1}).items.some(r=>r.count>0),'Employee does not receive unauthorized cost notices');
const original=require('../src/services/pieceWage').preview;let called=0;
insert('production_reports',{order_id:order,node_name:'__SMOKE平车',qty_ok:99,report_date:'2026-11-06',created_at:now()});
require('../src/services/pieceWage').preview=()=>{called++;return {items:[{order_id:order,style_no:'__SMOKE-ST',amount:0.48,capped:1}],diagnostics:{missing_rate:[],unassigned:[]}};};
const result=cost.read(tp);check(called===1&&result.scan_known_amount===0.48,'Uses canonical preview amount, not raw 99-piece multiplication');check(result.capped_rows===1,'Shows canonical cap evidence');check(result.combined_total===null,'Never adds per-unit materials to total wages');
require('../src/services/pieceWage').preview=original;check(cost.read(999999)===null,'Unknown pack missing');console.log('通过 '+checks+' 项');db.close();
