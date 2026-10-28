/**
 * 行政运营报表 演示数据
 * ----------------------------------------------------------------------
 * 目的：让八项指标都有真实可见的数，而不是一片 0。
 * 只补「正常业务」，**刻意造两条有问题的数据**用来演示差异清单：
 *   1. 一个饭卡账户余额比流水多 50 元（对账恒等式断开）
 *   2. 一条报修提交后直接关单、没有复验记录（复验分离被跳过）
 * 两条都带 `DEMO-ADMINOPS` 标记，`--clean` 一并清掉。
 *
 * 补的业务：
 *   - 2 条住宿（10 月入住 / 10 月中退宿），把入住率抬到有意义的水平
 *   - 3 条报修（已复验关闭 / 维修中超期 / 提交待复验）
 *   - 3 条行政费用（培训、招聘、招待），让行政预算接近/超过预算线
 *   - 1 个饭卡账户 + 2 条流水（其中余额与流水不符的那条）
 *
 * 用法：
 *   node scripts/seed-adminops-demo.js           生成
 *   node scripts/seed-adminops-demo.js --clean    清干净
 */
const { db, now } = require('../src/db');
const { localDate } = require('../src/utils/time');
const { genNo } = require('../src/utils/http');

const MARK = 'DEMO-ADMINOPS';
const t = now();
const day = (n) => localDate(new Date(Date.now() + n * 86400000).toISOString());
const monthOf = (d) => String(d).slice(0, 7);
const cur = monthOf(day(0));

function clean() {
  const acc = db.prepare('SELECT id FROM meal_accounts WHERE card_no LIKE ?').all('DEMO%').map((r) => r.id);
  acc.forEach((id) => {
    db.prepare('DELETE FROM meal_transactions WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM meal_accounts WHERE id = ?').run(id);
  });
  const rep = db.prepare('SELECT id FROM repairs WHERE remark LIKE ?').all(`%${MARK}%`).map((r) => r.id);
  rep.forEach((id) => db.prepare('DELETE FROM repairs WHERE id = ?').run(id));
  const stays = db.prepare('SELECT id FROM dorm_stays WHERE remark LIKE ?').all(`%${MARK}%`).map((r) => r.id);
  stays.forEach((id) => db.prepare('DELETE FROM dorm_stays WHERE id = ?').run(id));
  db.prepare('DELETE FROM admin_expenses WHERE remark LIKE ?').run(`%${MARK}%`);
  db.prepare('DELETE FROM admin_report_findings WHERE demo_tag = ?').run(MARK);
  db.prepare('DELETE FROM admin_report_runs WHERE demo_tag = ?').run(MARK);
  console.log(`清掉演示：饭卡账户 ${acc.length} · 报修 ${rep.length} · 住宿 ${stays.length} · 费用/报表按标记删除`);
}

if (process.argv.includes('--clean')) { clean(); process.exit(0); }
clean();

const emps = db.prepare("SELECT id, name FROM employees WHERE status='active' ORDER BY id LIMIT 6").all();
if (emps.length < 4) { console.error('需要至少 4 名在职员工'); process.exit(1); }
const [E1, E2, E3, E4] = emps;

/* ---------------- 1. 住宿：本月入住两条（避开已占床位与维修床） ---------------- */
const beds = db.prepare(`
  SELECT b.id, b.bed_no, r.building, r.room_no FROM dorm_beds b
  JOIN dorm_rooms r ON r.id = b.room_id
  WHERE b.status = 'normal' AND r.status = 'normal' ORDER BY b.id`).all();
const occupied = new Set(db.prepare("SELECT bed_id FROM dorm_stays WHERE status='active'").all().map((r) => r.bed_id));
const free = beds.filter((b) => !occupied.has(b.id));

if (free.length >= 2) {
  const mStart = `${cur}-01`;
  db.prepare(`INSERT INTO dorm_stays (bed_id, employee_id, start_date, end_date, rent_month, deposit, utilities, status, remark, created_by, created_at, updated_at)
    VALUES (?,?,?,NULL,200,400,0,'active',?,'seed',?,?)`)
    .run(free[0].id, E3.id, mStart, `入职安排宿舍 ${MARK}`, t, t);
  // 第二条：月中入住、月末前退宿（体现「退住押金待退」）
  db.prepare(`INSERT INTO dorm_stays (bed_id, employee_id, start_date, end_date, rent_month, deposit, utilities, status, remark, created_by, created_at, updated_at)
    VALUES (?,?,?,?,200,400,0,'checked_out',?,'seed',?,?)`)
    .run(free[1].id, E4.id, `${cur}-05`, `${cur}-22`, `短期住宿 ${MARK}`, t, t);
}

/* ---------------- 2. 报修：已复验关闭 / 维修超期 / 提交待复验 ---------------- */
const lastNo = db.prepare("SELECT repair_no FROM repairs ORDER BY id DESC LIMIT 1").get();
let seq = lastNo ? Number(String(lastNo.repair_no).slice(-4)) + 1 : 1;
const mkRepair = (b) => {
  const no = genNo('BX', seq++);
  db.prepare(`INSERT INTO repairs (repair_no, area, facility, description, severity, status, reporter, assignee,
      reported_at, due_date, submitted_at, verified_by, verified_at, down_impact, remark, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    no, b.area || null, b.facility, b.description, b.severity, b.status, b.reporter || '行政',
    b.assignee || null, b.reported_at, b.due_date || null, b.submitted_at || null,
    b.verified_by || null, b.verified_at || null, b.down_impact || null,
    `${b.note || ''} ${MARK}`.trim(), t, t
  );
  return no;
};

mkRepair({
  area: 'A栋201', facility: '洗手间下水管', description: '下水管漏水，地面渗水', severity: 'major',
  status: 'closed', reporter: '宿管', assignee: '水电班',
  reported_at: `${cur}-06T09:10:00.000Z`, due_date: `${cur}-09`,
  submitted_at: `${cur}-08T14:30:00.000Z`, verified_by: '行政主管', verified_at: `${cur}-09T10:00:00.000Z`,
  note: '已更换弯管，复验通过'
});
mkRepair({
  area: 'A栋202', facility: '空调', description: '外机异响，制冷不足', severity: 'major',
  status: 'repairing', reporter: '宿管', assignee: '空调售后',
  reported_at: `${cur}-12T08:00:00.000Z`, due_date: `${cur}-16`,
  note: '等配件，已报备'
});
mkRepair({
  area: '办公区', facility: '打印机', description: '卡纸频繁，进纸轮磨损', severity: 'minor',
  status: 'submitted', reporter: '行政', assignee: 'IT',
  reported_at: `${cur}-18T10:00:00.000Z`, submitted_at: `${cur}-19T16:20:00.000Z`,
  note: '已换进纸轮，待复核'
});
// 刻意造：提交后直接关闭、没有复验记录（复验分离被跳过）
mkRepair({
  area: 'A栋201', facility: '门锁', description: '门锁卡顿', severity: 'minor',
  status: 'closed', reporter: '宿管', assignee: '水电班',
  reported_at: `${cur}-03T11:00:00.000Z`, submitted_at: `${cur}-03T18:00:00.000Z`,
  note: '【演示】提交后直接关单，没有复验记录 —— 报表会点名'
});

/* ---------------- 3. 行政费用：让行政预算接近/超过预算线 ---------------- */
const dept = db.prepare("SELECT id FROM departments WHERE name='人事行政部'").get();
const mkExp = (date, category, amount, deptId, payee, note) => db.prepare(`
  INSERT INTO admin_expenses (expense_date, category, amount, payee, handler, payment_method, remark, created_at, department_id, company_id)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(date, category, amount, payee, '行政', '转账', `${note} ${MARK}`, t, deptId || null, 1);

mkExp(`${cur}-08`, '培训', 3200, dept ? dept.id : null, 'XX 安全生产培训', '新员工安全培训');
mkExp(`${cur}-15`, '招聘', 2100, dept ? dept.id : null, 'XX 招聘平台', '招聘平台年费分摊');
mkExp(`${cur}-21`, '招待', 680, null, 'XX 餐饮', '客户来访接待（未归口部门）');

/* ---------------- 4. 饭卡：新建一个账户，余额比流水多 50 ---------------- */
// 必须挑一个「还没有饭卡账户」的员工：meal_accounts.employee_id 唯一，
// 挑到已有账户的人会静默跳过，差异就演示不出来（第一次跑就踩了）
const noAcc = emps.find((e) => !db.prepare('SELECT 1 x FROM meal_accounts WHERE employee_id = ?').get(e.id));
if (noAcc) {
  const acc = db.prepare(`INSERT INTO meal_accounts (employee_id, card_no, balance, subsidy_balance, status, opened_at, remark, created_at, updated_at)
    VALUES (?,?,?,?, 'active', ?, ?, ?, ?)`).run(
    noAcc.id, 'DEMO-C9', 150, 0, `${cur}-01`, `演示账户 ${MARK}`, t, t
  );
  const accId = Number(acc.lastInsertRowid);
  // 流水只有 +100（充值），余额却被写成 150 → 对账恒等式断开 50 元
  db.prepare(`INSERT INTO meal_transactions (account_id, type, amount, personal_delta, subsidy_delta, source, receipt_no, balance_after, note, operator, created_at)
    VALUES (?, 'recharge', 100, 100, 0, 'manual', ?, 100, ?, '行政', ?)`)
    .run(accId, `RC-${cur}-01`, `充值 100 ${MARK}`, `${cur}-02T03:00:00.000Z`);
  db.prepare(`INSERT INTO meal_transactions (account_id, type, amount, personal_delta, subsidy_delta, source, receipt_no, balance_after, note, operator, created_at)
    VALUES (?, 'consume', -20, 0, 0, 'device', ?, 80, ?, '食堂', ?)`)
    .run(accId, `DV-${cur}-02`, `食堂消费 20 ${MARK}`, `${cur}-03T04:00:00.000Z`);
  console.log(`饭卡演示账户 #${accId}：余额 150 vs 流水净额 100（差 50，用于演示对账差异）`);
}

/* ---------------- 5. 跑一份定版报表（演示历史版本与差异清单） ---------------- */
const S = require('../src/services/adminOps');
try {
  const run = S.runReport(cur, { force: true }, 'seed');
  db.prepare('UPDATE admin_report_runs SET demo_tag = ? WHERE id = ?').run(MARK, run.id);
  db.prepare('UPDATE admin_report_findings SET demo_tag = ? WHERE run_id = ?').run(MARK, run.id);
  console.log(`报表已定版：${run.run_no} · ${run.findings.length} 条差异（严重 ${run.findings.filter((f) => f.severity === 'high').length}）`);
} catch (e) {
  console.log('定版跳过：' + e.message);
}

/* ---------------- 结果 ---------------- */
const B = require('../src/services/bedDays');
const d = B.bedDays(cur);
console.log('演示数据已生成：');
console.log(`  住宿：可用床日 ${d.available_bed_days} / 住用床日 ${d.used_bed_days} / 入住率 ${d.occupancy_rate}%`);
console.log(`  费用：本月 ${db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) v FROM admin_expenses WHERE expense_date BETWEEN ? AND ?").get(d.start, d.end).c} 笔 / ¥${db.prepare("SELECT COALESCE(SUM(amount),0) v FROM admin_expenses WHERE expense_date BETWEEN ? AND ?").get(d.start, d.end).v}`);
console.log(`  报修：本月 ${db.prepare("SELECT COUNT(*) c FROM repairs WHERE strftime('%Y-%m', reported_at, 'localtime') = ?").get(cur).c} 条`);
console.log(`  清理：node scripts/seed-adminops-demo.js --clean`);
