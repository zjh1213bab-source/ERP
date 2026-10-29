/**
 * 员工档案挂主体（`employees.company_id`）
 *
 * ## 为什么员工也要分主体
 *
 * 劳动合同签在哪一家、社保在哪缴、工资由谁发 —— 这三件事在集团里是按法人主体分开的。
 * 而库里 `employees` 没有这一列，于是：
 *   - 分部人事打开员工档案能看到总部所有人的底薪（手机、身份证已脱敏，但底薪是**工资**）；
 *   - 考勤、请假、计件明细都挂在 `employee_id` 上，员工不分主体 → 这三张表也推不出主体。
 *
 * ## 为什么不建"离职"字段来替代
 *
 * 这不是状态问题，是归属问题。离职员工也要留档、也要能被原主体查到。
 *
 * ## 回填
 *
 * 存量 26 名员工都在总部（`users.company_id = 1`），按 1 回填是事实。
 * 与 `purchase_orders` 同一条原则：**能回答"属于谁"的列，就显式存**，
 * 不靠"推不出来就归默认"来凑 —— 那种凑法在多主体上线那天会集体失真。
 */
const { db } = require('../src/db');

const cols = db.prepare("PRAGMA table_info('employees')").all().map((c) => c.name);

if (!cols.includes('company_id')) {
  db.exec('ALTER TABLE employees ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1');
  console.log('已加列 employees.company_id（默认 1 = 总部）');
} else {
  console.log('employees.company_id 已存在');
}

/**
 * 索引名在 SQLite 里是**全局唯一**的，不是按表隔离的 ——
 * 第一版叫 idx_emp_company，而 `employments(employer_company_id)` 早就占用了这个名字，
 * 于是 IF NOT EXISTS 直接静默跳过，employees 上一条索引都没建，脚本却打印"成功"。
 * 换个名字，并且建完**回读确认**它真的落在 employees 上。
 */
const IDX = 'idx_employee_company';
db.exec('CREATE INDEX IF NOT EXISTS ' + IDX + ' ON employees(company_id, status)');
const landed = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name = ?").get(IDX);
if (!landed || landed.tbl_name !== 'employees') {
  throw new Error('索引 ' + IDX + ' 没有落在 employees 上（实际：' + JSON.stringify(landed) + '）');
}
console.log('索引 ' + IDX + ' 已确认在 employees 上');

const stat = db.prepare('SELECT company_id, COUNT(*) c FROM employees GROUP BY company_id').all();
console.log('当前分布：', stat.map((x) => `主体${x.company_id} ${x.c} 人`).join(' / '));
