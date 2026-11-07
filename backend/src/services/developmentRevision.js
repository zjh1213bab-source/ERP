/** 业务交版及改版许可。所有写入由调用方事务包住，快照保留修改前资料。 */
const {db,now}=require('../db');
const bad=message=>{throw Object.assign(new Error(message),{status:409});};
function request(tpId){return db.prepare("SELECT cr.* FROM pattern_change_requests cr JOIN pattern_flows pf ON pf.id=cr.flow_id WHERE pf.tech_pack_id=? AND cr.field_key='development_revision' ORDER BY cr.id DESC LIMIT 1").get(tpId);}
function snapshot(tp){return JSON.stringify({customer_req:tp.customer_req,craft_info:tp.craft_info,version:tp.version,outsource_json:tp.outsource_json||'[]',materials:db.prepare('SELECT * FROM tech_pack_materials WHERE tech_pack_id=? ORDER BY sort,id').all(tp.id)});}
function nextVersion(value){const match=/^V(\d+)$/i.exec(value||'');return match?'V'+(Number(match[1])+1):(value||'V1')+'.R'+Date.now();}
function permitted(tp,user){const change=request(tp.id);return change?.status==='editing'&&(change.applicant===(user.name||user.username)||user.role==='admin');}
function submitted(tp){return !!tp.business_submitted_at||tp.status==='confirmed';}
function checkEdit(tp,user){if(submitted(tp)&&!permitted(tp,user))bad('资料已交版，请先申请修改并等待版房同意');}
function review(change,approve){
 if(!approve)return;
 const flow=db.prepare('SELECT * FROM pattern_flows WHERE id=?').get(change.flow_id);
 if(!flow||flow.status==='done')bad('样衣已归档，请在样衣管理申请变更');
 const tp=db.prepare('SELECT * FROM tech_packs WHERE id=?').get(flow.tech_pack_id);
 db.prepare("UPDATE tech_packs SET version=?,status='draft',business_submitted_at=COALESCE(business_submitted_at,?),updated_at=? WHERE id=?").run(nextVersion(tp.version),now(),now(),tp.id);
}
function saved(tp,user){const change=request(tp.id);if(change?.status==='editing'&&permitted(tp,user))db.prepare("UPDATE pattern_change_requests SET proposed_value=?,status='awaiting_recheck',updated_at=? WHERE id=? AND status='editing'").run(snapshot(db.prepare('SELECT * FROM tech_packs WHERE id=?').get(tp.id)),now(),change.id);}
function recheck(change,approve){
 if(approve)return;
 const flow=db.prepare('SELECT * FROM pattern_flows WHERE id=?').get(change.flow_id),before=JSON.parse(change.before_value);
 db.prepare('UPDATE tech_packs SET customer_req=?,craft_info=?,outsource_json=?,updated_at=? WHERE id=?').run(before.customer_req,before.craft_info,before.outsource_json||'[]',now(),flow.tech_pack_id);
 db.prepare('DELETE FROM tech_pack_materials WHERE tech_pack_id=?').run(flow.tech_pack_id);
 for(const row of before.materials){const keys=Object.keys(row).filter(k=>k!=='id');db.prepare('INSERT INTO tech_pack_materials('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]));}
}
module.exports={request,snapshot,submitted,permitted,checkEdit,review,saved,recheck};
