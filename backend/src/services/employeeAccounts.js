const { db, now } = require('../db');
const { hashPassword } = require('../auth/password');
const access = require('./access');

// 由调用方统一开启事务：员工档案、绑定和账号必须同成同败。
// 重复导入不重置密码、不恢复已停用账号、不改变既有岗位权限。
function sync(employee) {
  const users = db.prepare('SELECT * FROM users WHERE employee_id=? ORDER BY id').all(employee.id);
  if (employee.status === 'left') {
    disable(employee.id);
    return { action: 'disabled' };
  }
  const phone = String(employee.phone || '').replace(/[\s-]/g, '');
  if (!/^1\d{10}$/.test(phone)) return { action: 'skipped', reason: '缺少有效的11位手机号' };
  if (users.length > 1) return { action: 'conflict', reason: '员工绑定了多个账号，需先核对' };
  const samePhone = db.prepare('SELECT id FROM employees WHERE phone=? AND id<>?').get(phone, employee.id);
  if (samePhone) return { action: 'conflict', reason: '手机号已被其他员工使用' };
  const occupied = db.prepare('SELECT * FROM users WHERE username=?').get(phone);
  if (occupied && (!users.length || occupied.id !== users[0].id)) return { action: 'conflict', reason: '手机号账号已存在，未覆盖或自动合并' };
  if (users.length) {
    const user = users[0];
    if (user.username === phone) return { action: 'unchanged' };
    db.prepare('UPDATE users SET username=?,token_version=COALESCE(token_version,0)+1 WHERE id=?').run(phone, user.id);
    return { action: 'renamed', user_id: user.id };
  }
  if (!employee.company_id) return { action: 'skipped', reason: '员工缺少所属公司' };
  const info = db.prepare(`INSERT INTO users(username,password_hash,name,role,company_id,department_id,employee_id,active,token_version,created_at)
    VALUES(?,?,?,'employee',?,?,?,1,0,?)`).run(phone, hashPassword(phone.slice(-4)), employee.name, employee.company_id, employee.department_id, employee.id, now());
  return { action: 'created', user_id: Number(info.lastInsertRowid) };
}
function disable(employeeId) {
  db.prepare('UPDATE users SET active=0,token_version=COALESCE(token_version,0)+1 WHERE employee_id=? AND active<>0').run(employeeId);
}
function clearEmployeeCache(employeeId) {
  db.prepare('SELECT id FROM users WHERE employee_id=?').all(employeeId).forEach(u => access.clearCache(u.id));
}
function syncAll(companyId = null) {
  const result = { created: 0, renamed: 0, unchanged: 0, disabled: 0, skipped: 0, conflict: 0, issues: [] };
  const employees = companyId ? db.prepare('SELECT * FROM employees WHERE company_id=?').all(companyId) : db.prepare('SELECT * FROM employees').all();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const employee of employees) {
      const out = sync(employee);
      result[out.action]++;
      if (out.reason) result.issues.push({ employee_id: employee.id, name: employee.name, reason: out.reason });
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  employees.forEach(e => clearEmployeeCache(e.id));
  return result;
}
module.exports = { sync, disable, clearEmployeeCache, syncAll };
