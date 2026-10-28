/**
 * 员工自助演示数据
 * ========================================================================
 * 造的不是「一切顺利」的演示，而是四种状态并存：
 *
 *   1. **已绑定**的普通员工账号（王芳 / 吴小玲）—— 能看自己的工资条与考勤
 *   2. **未绑定**的账号（销售小王 / 李工…）—— 打开自助页只能看到「请联系人事绑定」
 *   3. **待受理**的申请（补卡 / 请假 / 薪资申诉），其中一条已超期未处理
 *   4. **已批准并生成调整单**的申诉 —— 证明「批准不改已付历史，走下一期」
 *
 * 标记方式：`self_requests.payload._demo = true`（payload 是内部 JSON，不直接展示），
 * 不往结论、理由这些给人看的字段里塞「【演示】」。
 *
 * 用法：
 *   node scripts/seed-selfservice-demo.js            # 造数据
 *   node scripts/seed-selfservice-demo.js --clean    # 清干净
 */
const { db, now } = require('../src/db');
const { localDate } = require('../src/utils/time');
const { hashPassword } = require('../src/auth/password');

const t = now();
const today = localDate(t);
const day = (offset) => localDate(new Date(Date.now() + offset * 86400000).toISOString());
const DEMO_USERS = ['wangfang', 'wuxiaoling'];

function clean() {
  // 先删调整单（引用申请单）
  const reqIds = db.prepare("SELECT id FROM self_requests WHERE IFNULL(payload,'') LIKE '%\"_demo\":true%'").all().map((r) => r.id);
  let adj = 0;
  let req = 0;
  if (reqIds.length) {
    const marks = reqIds.map(() => '?').join(',');
    adj = db.prepare(`DELETE FROM payroll_adjustments WHERE request_id IN (${marks})`).run(...reqIds).changes;
    // 资料更正要还原手机号
    db.prepare(`SELECT * FROM self_requests WHERE id IN (${marks})`).all(...reqIds).forEach((r) => {
      const p = JSON.parse(r.payload || '{}');
      if (r.type === 'profile' && p.original != null) {
        db.prepare(`UPDATE employees SET ${p.field} = ? WHERE id = ?`).run(p.original, r.employee_id);
      }
    });
    req = db.prepare(`DELETE FROM self_requests WHERE id IN (${marks})`).run(...reqIds).changes;
  }
  const us = db.prepare("DELETE FROM users WHERE username IN ('wangfang','wuxiaoling')").run().changes;
  console.log(`已清理：申请 ${req} 条 · 调整单 ${adj} 条 · 演示账号 ${us} 个（手机号已还原）`);
}

if (process.argv.includes('--clean')) {
  clean();
  process.exit(0);
}

const emp = (name) => {
  const e = db.prepare("SELECT * FROM employees WHERE name = ? AND IFNULL(status,'active')='active'").get(name);
  if (!e) throw new Error(`演示员工不存在：${name}`);
  return e;
};

/* ---------------- 1. 两个员工账号并绑定 ---------------- */

function ensureUser(username, employeeName, role = 'production') {
  const e = emp(employeeName);
  let u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u) {
    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, name, role, company_id, department_id, active, employee_id, created_at)
         VALUES (?,?,?,?,1,?,1,?,?)`
      )
      .run(username, hashPassword('admin123456'), e.name, role, e.department_id || null, e.id, t);
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  } else {
    db.prepare('UPDATE users SET employee_id = ?, name = ?, department_id = ? WHERE id = ?')
      .run(e.id, e.name, e.department_id || null, u.id);
  }
  return { user: u, employee: e };
}

const wf = ensureUser('wangfang', '王芳', 'production');
const wxl = ensureUser('wuxiaoling', '吴小玲', 'production');
console.log(`已绑定：wangfang → ${wf.employee.name}（${wf.employee.code}）· wuxiaoling → ${wxl.employee.name}（${wxl.employee.code}）`);

/* ---------------- 2. 申请单 ---------------- */

const ins = db.prepare(
  `INSERT INTO self_requests (ticket_no, employee_id, employee_name, type, title, reason, payload, status,
     owner_role, due_date, conclusion, decided_by, decided_at, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
const ticket = (prefix, seq) => `${prefix}${today.replace(/-/g, '')}${String(seq).padStart(4, '0')}`;

const P = (o) => JSON.stringify({ ...o, _demo: true });

// ① 补卡：上周三漏打下班卡（那天确实没有考勤记录，补卡批准后会补建一条）
ins.run(ticket('SR', 9001), wf.employee.id, wf.employee.name, 'makeup', '昨天漏打下班卡',
  '昨天下午 18:10 走的，忘了打卡，车间考勤机当时在升级',
  P({ date: day(-7), check_in: null, check_out: '18:10' }),
  'submitted', 'hr', day(2), null, null, null, t, t);

// ② 薪资申诉：2026-09 计件少算，待财务受理（在申诉窗口内）
const sep = db.prepare("SELECT id, period, net_pay FROM payrolls WHERE employee_id = ? AND period = '2026-09' AND status = 'confirmed'").get(wf.employee.id);
if (sep) {
  ins.run(ticket('SR', 9002), wf.employee.id, wf.employee.name, 'payroll', '9 月计件工资少算',
    '9 月我做了 3 款样衣共 46 件，工资条上计件只算了 38 件的量，请核对报工记录',
    P({ payroll_id: sep.id, period: sep.period, net_pay: sep.net_pay, claim_amount: 320 }),
    'submitted', 'finance', day(3), null, null, null, t, t);
}

// ③ 请假：下周二家里有事，待人事受理
ins.run(ticket('SR', 9003), wxl.employee.id, wxl.employee.name, 'leave', '下周二请假一天',
  '下周二孩子学校家长会，需要请一天事假，手上的活已经交给李四',
  P({ start_date: day(6), end_date: day(6), days: 1, leave_type: 'personal' }),
  'submitted', 'hr', day(2), null, null, null, t, t);

// ④ 资料更正：已批准（手机号已改），证明批准会真的改档案并留痕
const origPhone = wxl.employee.phone;
db.prepare('UPDATE employees SET phone = ? WHERE id = ?').run('13900001234', wxl.employee.id);
ins.run(ticket('SR', 9004), wxl.employee.id, wxl.employee.name, 'profile', '手机号换了',
  '换了新号，旧号收不到考勤提醒',
  P({ field: 'phone', field_label: '手机号', value: '13900001234', original: origPhone }),
  'approved', 'hr', day(-1), '已核对本人身份，档案手机号已更新；考勤提醒次日生效',
  '孙人事', t, t, t);
db.prepare('UPDATE employees SET phone = ? WHERE id = ?').run(origPhone, wxl.employee.id); // 演示库里保持电话脱敏样本不变

// ⑤ 薪资申诉：已批准 → 生成下一期调整单（不改已付历史）
if (sep) {
  const adjNo = `PA${today.replace(/-/g, '')}9001`;
  const info = db
    .prepare(
      `INSERT INTO payroll_adjustments (adj_no, request_id, employee_id, employee_name, period, item, amount,
         reason, status, source_period, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?, ?, ?)`
    )
    .run(adjNo, null, wf.employee.id, wf.employee.name, '2026-10', 'piece_wage', 186,
      '申诉核实：9 月样衣报工 46 件，工资单只计 38 件，差额 186 元并入 10 月发放', '2026-09', '费用会计', t, t);
  const adjId = Number(info.lastInsertRowid);
  ins.run(ticket('SR', 9005), wf.employee.id, wf.employee.name, 'payroll', '8 月计件漏算（已处理）',
    '8 月有两扎样衣没进计件，请复核',
    P({ payroll_id: sep.id, period: '2026-08', claim_amount: 186 }),
    'approved', 'finance', day(-3),
    '核实报工记录后确认漏算 8 件，已生成调整单并入 2026-10 工资，已发放的 8 月工资不动',
    '钱会计', t, t, t);
  db.prepare('UPDATE self_requests SET adjust_id = ? WHERE ticket_no = ?').run(adjId, `${'SR'}${today.replace(/-/g, '')}9005`);
  db.prepare('UPDATE payroll_adjustments SET request_id = (SELECT id FROM self_requests WHERE ticket_no = ?) WHERE id = ?')
    .run(`${'SR'}${today.replace(/-/g, '')}9005`, adjId);
}

/* ---------------- 3. 结果 ---------------- */

const S = require('../src/services/selfService');
const st = S.stats();
console.log('\n--- 统计 ---', JSON.stringify(st));
const wfUser = db.prepare("SELECT * FROM users WHERE username = 'wangfang'").get();
const ov = S.overview({ sub: wfUser.id });
console.log('王芳看到：', JSON.stringify({
  bound: ov.bound, 姓名: ov.me && ov.me.name,
  本月考勤: ov.attendance, 工资条数: ov.payslips.count, 已发合计: ov.payslips.year_paid,
  技能: ov.skills, 未结申请: ov.requests.open
}, null, 1));
const unbound = db.prepare('SELECT id FROM users WHERE active = 1 AND employee_id IS NULL LIMIT 1').get();
console.log('\n未绑定账号看到：', JSON.stringify(S.overview({ sub: unbound.id }), null, 1));