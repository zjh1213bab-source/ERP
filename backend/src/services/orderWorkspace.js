/** 销售列表参考视图的只读投影；上游订单查询已完成主体过滤，所有子查询只取该范围。 */
const {db}=require('../db');
function group(rows,key){const m=new Map();for(const r of rows){if(!m.has(r[key]))m.set(r[key],[]);m.get(r[key]).push(r);}return m;}
function decode(value,fallback){try{return JSON.parse(value||'')||fallback;}catch{return fallback;}}
function decorate(rows){
 if(!rows.length)return [];
 const ids=rows.map(r=>Number(r.id)).filter(Number.isSafeInteger).join(',');
 const items=group(db.prepare(`SELECT i.*,COALESCE((SELECT t.id FROM tech_packs t WHERE t.order_id=i.order_id AND t.order_item_id=i.id ORDER BY t.id DESC LIMIT 1),(SELECT t.id FROM tech_packs t WHERE t.order_id=i.order_id AND t.order_item_id IS NULL ORDER BY t.id DESC LIMIT 1)) tech_pack_id FROM order_items i WHERE i.order_id IN (${ids}) ORDER BY i.id`).all(),'order_id');
 const packs=new Map(db.prepare(`SELECT t.id,t.status,t.version,p.id flow_id,p.status flow_status,p.current_stage FROM tech_packs t LEFT JOIN pattern_flows p ON p.tech_pack_id=t.id WHERE t.order_id IN (${ids})`).all().map(p=>[p.id,p]));
 const costs=new Map(db.prepare(`SELECT order_id,status FROM cost_sheets WHERE order_id IN (${ids})`).all().map(c=>[c.order_id,c.status]));
 const nodes=group(db.prepare(`SELECT order_id,status FROM order_nodes WHERE order_id IN (${ids})`).all(),'order_id');
 const dispatch=group(db.prepare(`SELECT order_id,type,qty FROM dispatch_orders WHERE order_id IN (${ids}) AND status<>'cancelled' AND qty>0 AND (factory_id>0 OR TRIM(IFNULL(factory_name,'')) NOT IN ('','未指定'))`).all(),'order_id');
 const attachments=group(db.prepare(`SELECT target_id,url,filename FROM attachments WHERE target_type='order' AND deleted_at IS NULL AND target_id IN (${ids}) ORDER BY id`).all(),'target_id');
 return rows.map(r=>{const entry=decode(r.entry_json,{}),its=(items.get(r.id)||[]).map(i=>({...i,pattern:packs.get(i.tech_pack_id)||null})),ns=nodes.get(r.id)||[],alloc=dispatch.get(r.id)||[];
 const docs=[...(attachments.get(r.id)||[]),...(Array.isArray(entry.attachments)?entry.attachments:[])].filter(a=>typeof a.url==='string'&&(/^\/uploads\//.test(a.url)||/^https?:\/\//i.test(a.url)));
 return {...r,items:its,quantity:its.reduce((n,i)=>n+Number(i.qty||0),0),tags:Array.isArray(entry.tags)?entry.tags:[],attachments:[...new Map(docs.map(a=>[a.url,a])).values()],cost_status:costs.get(r.id)||'none',node_total:ns.length,node_done:ns.filter(n=>n.status==='done').length,assignment_mode:alloc.some(d=>d.type==='own')?'own':alloc.some(d=>d.type==='outsource')?'outsource':'none'};
 });
}
module.exports={decorate};
