/** 岗位授权：复用 app_config 原子保存版本，账号和权限均由后端验证。 */
const {db,now}=require('../db');
const {PERMS,ROLES,ROLE_LABELS,GUARDED,positionAction,positionActions,POSITION_MASTER,positionGrants,positionFieldPermissions}=require('../access/permissions');
const crypto=require('crypto');
const KEY='access_positions_v1';
const modules=require('../access/permissions').positionModules();
const bad=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function read(){const r=db.prepare('SELECT value FROM app_config WHERE key=?').get(KEY);return r?JSON.parse(r.value):{revision:0,positions:[],bindings:{},history:[]};}
function catalog(){return {roles:ROLES.filter(r=>!['admin','boss'].includes(r)).map(code=>({code,label:ROLE_LABELS[code]})),permissions:Object.keys(PERMS),field_permissions:positionFieldPermissions,actions:positionActions(),modules};}
function assigned(userId){
 const s=read();if(s.bindings[String(userId)]==='unassigned')return {id:'unassigned',roles:['employee'],perms:[]};
 const position=s.positions.find(p=>p.id===s.bindings[String(userId)]);if(!position)return null;
 // 已分配岗位也走同一授权模型；读取时兼容旧配置，不改写历史授权记录。
 return {...position,direct:true,perms:positionGrants(position.selected_perms||position.perms)};
}
function save(body,user){
 if(!body||!Number.isSafeInteger(body.revision))bad('缺少配置版本，请刷新',409);
 const current=read();if(body.revision!==current.revision)bad('岗位已被其他管理员修改，请刷新',409);
 if(current.positions.length>=300 && body.action==='save' && !body.id)bad('岗位数量已达300，请先整理岗位');
 const action=body.action;let positions=current.positions.map(p=>({...p})),bindings={...current.bindings};
 if(action==='save'){
  const name=String(body.name||'').trim();if(!name||name.length>40)bad('岗位名称必填且不能超过40字');
  if(positions.some(p=>p.name===name&&p.id!==body.id))bad('岗位名称重复');
  if(body.roles!==undefined&&(!Array.isArray(body.roles)||body.roles.some(r=>!catalog().roles.some(x=>x.code===r))))bad('包含无效业务职责');
  const valid=new Set([...Object.keys(PERMS),...Object.values(positionActions()).flat().map(a=>a.code),...modules.flatMap(m=>['module.'+m+'.read','module.'+m+'.write'])]);
  if(!Array.isArray(body.perms)||body.perms.some(p=>!valid.has(p)))bad('包含未知权限');
  const old=body.id?positions.find(p=>p.id===body.id):null;if(body.id&&!old)bad('岗位不存在',404);
  const selected=[...new Set(body.perms)];
  if(selected.some(p=>!valid.has(p)))bad('包含未知权限');
  const row={direct:true,action_version:1,id:old?.id||crypto.randomUUID(),name,roles:body.roles?.length?[...new Set(body.roles)]:['employee'],selected_perms:selected,perms:positionGrants(selected),updated_at:now(),updated_by:user.username};
  positions=old?positions.map(p=>p.id===row.id?row:p):[...positions,row];
 }else if(action==='delete'){
  if(!positions.some(p=>p.id===body.id))bad('岗位不存在',404);
  if(Object.values(bindings).includes(body.id))bad('岗位仍有成员，请先移出或改派成员');
  positions=positions.filter(p=>p.id!==body.id);
 }else if(action==='members'){
  if(!positions.some(p=>p.id===body.id))bad('岗位不存在',404);
  if(!Array.isArray(body.user_ids)||body.user_ids.some(id=>!Number.isSafeInteger(id)||id<=0))bad('成员参数无效');
  for(const id of body.user_ids){const u=db.prepare('SELECT id,role FROM users WHERE id=?').get(id);if(!u||u.role==='admin')bad('管理员账号不能改派到普通岗位');}
  Object.keys(bindings).forEach(id=>{if(bindings[id]===body.id)bindings[id]='unassigned';});body.user_ids.forEach(id=>bindings[id]=body.id);
 }else bad('无效操作');
 const next={action_version:1,revision:current.revision+1,positions,bindings,history:[...current.history,{revision:current.revision+1,action,id:body.id||null,operator:user.username,time:now(),before:{positions:current.positions,bindings:current.bindings},after:{positions,bindings}}]};
 db.exec('BEGIN IMMEDIATE');try{if(read().revision!==current.revision)bad('岗位已更新，请刷新',409);db.prepare('INSERT INTO app_config(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(KEY,JSON.stringify(next),now());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 require('./access').clearCache();console.info('[position-access]',{action,revision:next.revision,operator:user.username});return snapshot();
}
function snapshot(){const s=read();return {...s,history:undefined,audit:s.history.slice(-50).reverse().map(h=>({revision:h.revision,action:h.action,id:h.id,operator:h.operator,time:h.time})),catalog:catalog(),users:db.prepare('SELECT id,username,name,role,active FROM users ORDER BY name,id').all()};}
/** 岗位授权必须先通过模块门禁，再通过原业务角色和职责分离约束。未映射入口拒绝。 */
function check(req){
 if(req.user.role==='admin')return null;const p=assigned(req.user.sub);if(!p)return null;
 const url=(req.originalUrl||req.url).split('?')[0],method=req.method.toUpperCase();
 if(/^\/api\/(auth\/|access\/me$|self\/)/.test(url)||method==='GET'&&url==='/api/settings/appearance')return null;
 const m=/^\/api\/([\w-]+)/.exec(url)?.[1];const readOnly=['GET','HEAD'].includes(method);
 if(!modules.includes(m)||!p.perms.includes('module.'+m+'.'+(readOnly?'read':'write')))return '岗位未授权此模块的'+(readOnly?'查看':'操作')+'权限';
 // 每次请求重新读取岗位；无需等旧令牌过期。模块操作不能代替按钮动作。
 const route=typeof req.route?.path==='string'?req.route.path:url.replace(/^\/api\/[^/]+/,'').replace(/\/\d+(?=\/|$)/g,'/:id');
 const action=positionAction(m,method,route);
 const required=action?['action.'+m+'.'+action]:[];
 // 档案编辑同时提交状态时，比较数据库当前值，只有真实状态变化才要求启停权限。
 const master=POSITION_MASTER[m],body=req.body||{};
 if(master&&!readOnly&&method!=='DELETE'&&(/^\/:\w+$/.test(route)||route==='/')){
  const field=master.field||'status',value=body[field];
  if(value!==undefined){
   const id=req.params?.id||/^\/:?(\d+)$/.exec(route)?.[1];
   const previous=id?db.prepare('SELECT '+field+' AS value FROM '+master.table+' WHERE id=?').get(id):null;
   const disabled=master.disabled??'disabled',enabled=master.enabled??'active';
   if((previous&&String(previous.value)!==String(value))||(!previous&&String(value)===String(disabled))){
    if(String(value)===String(disabled))required.push('action.'+m+'.disable');
    else if(String(value)===String(enabled)||m==='employees'&&value==='employed')required.push('action.'+m+'.enable');
   }
  }
 }
 for(const code of required)if(!p.perms.includes(code))return '岗位未授权按钮操作：'+code;
 if(!p.direct&&!readOnly){for(const g of GUARDED){if((g.method==='*'||g.method===method)&&(url===g.prefix||!g.exact&&url.startsWith(g.prefix+'/'))&&!p.perms.includes(g.perm))return '岗位未授权操作：'+g.perm;}}
 return null;
}
module.exports={assigned,save,snapshot,check};
