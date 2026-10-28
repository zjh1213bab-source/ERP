/**
 * 字段级脱敏：演示数据
 * ========================================================================
 * 现状问题：`employees` 25 个人里**一个身份证都没填**，手机只有 9 个有；
 * 工资单 27 条只有 10 条有金额。脱敏做完了却看不出效果（掩码和空值长得一样）。
 *
 * 所以补一批「看得出来」的数据：
 *   - 5 个员工补身份证 + 手机（号码是虚构的，格式对得上，不是真实身份）
 *   - 5 个员工补基本工资
 *   - 5 条工资单补金额（让 finance/hr 能看到数、admin 看到 ***）
 *
 * 全部带备注标记，`--clean` 一键清空（清成 null / 0，不删人）。
 */
const { db } = require('../src/db');

const MARK = 'PRIVACY-DEMO';

// 虚构号码：110101（北京东城）+ 生日 + 顺序码。**不是真实身份信息**，仅用于演示脱敏效果。
const IDS = [
  '110101199001011234',
  '110101199203156789',
  '110101198807224567',
  '110101199510098765',
  '110101199712301122'
];
const PHONES = ['13812345678', '13998765432', '13755558888', '13666667777', '13511112222'];
const SALARIES = [8500, 12000, 6800, 15000, 9500];

function clean() {
  db.prepare(`UPDATE employees SET id_card = NULL, phone = CASE WHEN remark = ? THEN NULL ELSE phone END WHERE remark = ?`).run(MARK, MARK);
  db.prepare(`UPDATE employees SET base_salary = 0 WHERE remark = ?`).run(MARK);
  db.prepare(`UPDATE payrolls SET base_salary = 0, gross_pay = 0, net_pay = 0, tax = 0, social_insurance = 0 WHERE remark = ?`).run(MARK);
  console.log('演示数据已清空');
}

if (process.argv.includes('--clean')) {
  clean();
  process.exit(0);
}

clean();

const emps = db.prepare('SELECT id, name FROM employees ORDER BY id LIMIT 5').all();
if (emps.length < 5) { console.log('员工不足 5 人，跳过'); process.exit(0); }

const upEmp = db.prepare('UPDATE employees SET id_card = ?, phone = ?, base_salary = ?, remark = ? WHERE id = ?');
emps.forEach((e, i) => {
  upEmp.run(IDS[i], PHONES[i], SALARIES[i], MARK, e.id);
});
console.log(`已给 ${emps.length} 个员工补身份证、手机与基本工资：`);
emps.forEach((e, i) => console.log(`  ${e.name}  ${IDS[i]}  ${PHONES[i]}  基本工资 ${SALARIES[i]}`));

// 工资单：挑 5 条补金额
const pays = db.prepare("SELECT id, employee_name, period FROM payrolls WHERE IFNULL(net_pay,0) = 0 ORDER BY id LIMIT 5").all();
const upPay = db.prepare(
  `UPDATE payrolls SET base_salary = ?, gross_pay = ?, net_pay = ?, tax = ?, social_insurance = ?, remark = ? WHERE id = ?`
);
pays.forEach((p, i) => {
  const base = SALARIES[i] || 8000;
  const gross = Math.round(base * 1.12);
  const tax = Math.round(base * 0.03);
  const social = Math.round(base * 0.105);
  upPay.run(base, gross, gross - tax - social, tax, social, MARK, p.id);
});
console.log(`\n已给 ${pays.length} 条工资单补金额：`);
db.prepare('SELECT employee_name, period, base_salary, gross_pay, net_pay FROM payrolls WHERE remark = ?').all(MARK)
  .forEach((p) => console.log(`  ${p.period} ${p.employee_name} 基本 ${p.base_salary} / 应发 ${p.gross_pay} / 实发 ${p.net_pay}`));

console.log('\n下一步：admin 看这些人应显示掩码，hr01 / fin01 看应显示明文');
