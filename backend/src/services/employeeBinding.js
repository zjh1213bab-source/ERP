/** 管理员显式绑定历史手机号账号；禁止自动合并、改密或提升岗位。 */
const {db}=require('../db');
const access=require('./access');
const bad=(message,status=400)=>{throw Object.assign(Error(message),{status});};
function bind(userId,employeeId,expected){
 if(!Number.isSafeInteger(userId)||!Number.isSafeInteger(employeeId)||userId<=0||employeeId<=0)bad('账号或员工编号无效');
 const u=db.prepare('SELECT * FROM users WHERE id=?').get(userId),e=db.prepare('SELECT * FROM employees WHERE id=?').get(employeeId);
 if(!u||!e)bad('账号或员工不存在',404);
 if((u.employee_id||null)!==(expected||null))bad('员工绑定已变化，请刷新后重试',409);
 if(u.employee_id&&u.employee_id!==employeeId)bad('账号已绑定其他员工，不能直接覆盖',409);
 if(e.status!=='active'||!u.active)bad('只能绑定在职员工与启用账号',409);
 if(u.username!==String(e.phone||'').replace(/[\s-]/g,''))bad('员工手机号必须与系统账号一致');
 if(!e.company_id||u.company_id&&u.company_id!==e.company_id)bad('员工与账号所属公司不一致',409);
 if(db.prepare('SELECT id FROM users WHERE employee_id=? AND id<>?').get(employeeId,userId))bad('员工已被其他账号绑定',409);
 if(u.employee_id===employeeId)return {id:userId,employee_id:employeeId,name:u.name,token_revoked:false};
 db.exec('BEGIN IMMEDIATE');
 try{
  const result=db.prepare(`UPDATE users SET employee_id=?,name=?,company_id=?,department_id=?,token_version=COALESCE(token_version,0)+1
   WHERE id=? AND COALESCE(employee_id,0)=? AND COALESCE(token_version,0)=? AND NOT EXISTS(SELECT 1 FROM users other WHERE other.employee_id=? AND other.id<>?)`)
   .run(employeeId,e.name,e.company_id,e.department_id,userId,expected||0,u.token_version||0,employeeId,userId);
  if(result.changes!==1)bad('账号资料已更新或员工已绑定，请刷新',409);
  db.exec('COMMIT');
 }catch(err){db.exec('ROLLBACK');throw err;}
 access.clearCache(userId);
 return {id:userId,employee_id:employeeId,name:e.name,token_revoked:true};
}
module.exports={bind};
