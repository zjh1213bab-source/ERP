/** 修复回归：禁止默认连业务库、显式父子级联、关系缓存刷新、排程留因、空报表原因。 */
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{spawnSync}=require('child_process');
process.chdir(path.resolve(__dirname,'..'));const folder=fs.mkdtempSync(path.join(os.tmpdir(),'erp-smoke-infrastructure-'));
Object.assign(process.env,{DB_PATH:path.join(folder,'__SMOKE.db'),ERP_SCHEDULER:'0',SMOKE_ISOLATED:'0'});
const {db,now}=require('../src/db'),A=require('./audit-demo-data'),S=require('../src/services/scheduling');let checks=0;
const check=(v,m)=>{assert.ok(v,m);checks++;};
const add=(table,row)=>{for(const c of db.prepare(`PRAGMA table_info(${table})`).all())if(c.notnull&&c.name.endsWith('_at')&&row[c.name]===undefined)row[c.name]=now();const cols=Object.keys(row);return Number(db.prepare(`INSERT INTO ${table}(${cols}) VALUES(${cols.map(()=>'?')})`).run(...cols.map(k=>row[k])).lastInsertRowid);};
try{
 const denied=spawnSync(process.execPath,['scripts/smoke-test.js'],{env:{...process.env,BASE:'http://127.0.0.1:3100'},encoding:'utf8',windowsHide:true});check(denied.status!==0&&/npm run smoke/.test(denied.stderr),'direct unsafe entry rejected before HTTP');
 A.refsOf('order_items');A.refsOf('pattern_flows');
 const o=add('orders',{order_no:'__SMOKE_CASCADE',type:'custom',status:'draft'}),item=add('order_items',{order_id:o,product_name:'普通明细'});add('order_item_sizes',{item_id:item,color:'红',size:'M',qty:1});
 const tp=add('tech_packs',{order_id:o,product_name:'普通技术包'}),flow=add('pattern_flows',{tech_pack_id:tp,status:'draft'});add('pattern_stages',{flow_id:flow,stage:'pattern'});
 check(A.refsOf('order_items').some(x=>x.child==='order_item_sizes'&&x.col==='item_id'&&x.rows===1),'cached explicit item relationship recounts newly inserted rows');check(A.refsOf('pattern_flows').some(x=>x.child==='pattern_stages'&&x.col==='flow_id'&&x.rows===1),'explicit flow_id relationship included');
 const keep=add('orders',{order_no:'KEEP_UNMARKED',type:'stock',status:'draft'});const keepItem=add('order_items',{order_id:keep,product_name:'普通明细',sku:'SMOKE-批次文本不得代表整张订单'});
 const cleaned=A.clean({includeFinance:true,skipBackup:true});check(cleaned.deleted>=5,'root and all dependent children removed');check(!db.prepare('SELECT 1 FROM order_items WHERE id=?').get(item)&&!db.prepare('SELECT 1 FROM order_item_sizes WHERE item_id=?').get(item),'item child cascade');check(!db.prepare('SELECT 1 FROM pattern_stages WHERE flow_id=?').get(flow),'pattern stages cascade');check(!!db.prepare('SELECT 1 FROM order_items WHERE id=?').get(keepItem),'unmarked parent and detail retained');check(A.findOrphans().length===0,'no orphan after cleanup');
 const run=add('schedule_runs',{run_no:'__SMOKE_RUN',horizon_from:'2026-11-01',horizon_to:'2026-11-30',status:'draft'});const task=add('schedule_tasks',{run_id:run,order_id:keep,process_name:'__SMOKE车缝',work_center:'__SMOKE车间',est_hours:2,start_at:'2026-11-02 08:00',end_at:'2026-11-02 10:00'});
 assert.throws(()=>S.adjustTask(task,{est_hours:3},'__SMOKE'),/原因/);checks++;check(db.prepare('SELECT est_hours FROM schedule_tasks WHERE id=?').get(task).est_hours===2,'missing reason makes no partial change');S.adjustTask(task,{est_hours:3,reason:'__SMOKE产能调整'},'__SMOKE');check(db.prepare('SELECT est_hours FROM schedule_tasks WHERE id=?').get(task).est_hours===3,'valid adjustment saved');check(db.prepare('SELECT reason FROM schedule_changes WHERE task_id=?').get(task).reason==='__SMOKE产能调整','adjustment reason logged');
 const report=require('../src/services/prodReport').overview({period:'1990-01'});const row=report.coverage.find(x=>x.item==='工序效率（标准工时）');check(row.rate===null&&/没有报工/.test(row.note),'empty efficiency denominator has an explicit reason');
 console.log(JSON.stringify({checks,failed:0,folder}));
}finally{db.close();}
