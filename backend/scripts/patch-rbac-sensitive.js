/**
 * 权限复核补丁：工资读取限岗 + 员工敏感字段隔离
 * 一次性脚本，跑完可删（保留以便追溯改动）
 */
const fs = require('fs');

// 1) 工资表读取限岗
let p = 'src/routes/payrolls.js';
let s = fs.readFileSync(p, 'utf8');
if (!s.includes('const READ = ')) {
  s = s.replace(
    "const WRITE = ['admin', 'hr', 'finance'];",
    "const WRITE = ['admin', 'hr', 'finance'];\n" +
      '// 工资是全公司最敏感的数据：读也要限岗（原来 GET 只要求登录，任何角色都能拉全员工资）\n' +
      "const READ = ['admin', 'boss', 'hr', 'finance'];"
  );
}
const pairs = [
  ["router.get('/', authRequired, wrap", "router.get('/', authRequired, requireRole(READ), wrap"],
  ["router.get('/periods', authRequired, wrap", "router.get('/periods', authRequired, requireRole(READ), wrap"],
  ["router.get('/summary', authRequired, wrap", "router.get('/summary', authRequired, requireRole(READ), wrap"],
  ["router.get('/export', authRequired, wrap", "router.get('/export', authRequired, requireRole(READ), wrap"]
];
pairs.forEach(([a, b]) => {
  if (!s.includes(a)) console.log('MISS payrolls:', a);
  s = s.replace(a, b);
});
fs.writeFileSync(p, s);

// 2) 员工档案：非人事/财务看不到身份证与基本工资
p = 'src/routes/employees.js';
s = fs.readFileSync(p, 'utf8');
const old = '  return ok(res, db.prepare(sql).all(...params));';
if (s.includes(old)) {
  s = s.replace(
    old,
    '  const rows = db.prepare(sql).all(...params);\n' +
      '  // 员工档案要全公司可选用（请假/考勤下拉），但身份证与基本工资只该人事与财务看到\n' +
      '  const mine = req.user.roles && req.user.roles.length ? req.user.roles : [req.user.role];\n' +
      "  const canSeePay = mine.some((r) => ['admin', 'boss', 'hr', 'finance'].includes(r));\n" +
      '  if (canSeePay) return ok(res, rows);\n' +
      '  return ok(res, rows.map((r) => ({ ...r, id_card: null, base_salary: null })));'
  );
  fs.writeFileSync(p, s);
} else {
  console.log('MISS employees: 未找到目标行');
}
console.log('patch ok');
