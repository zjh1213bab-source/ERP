/**
 * 员工自助与薪资申诉（TS-N13-10）
 * ========================================================================
 * 一句话：把「问 HR」变成「自己看 + 走单」，但**自己只能看自己**。
 *
 * ## 为什么这个模块的第一件事是「绑定」
 *
 * `users` 表原本没有 `employee_id`，10 个登录账号（系统管理员 / 销售小王 / 李工…）
 * 一个都对不上员工档案。没有绑定就无从判断「这条工资单是不是你的」——
 * 靠名字猜，重名/花名/离职重入职随便碰上一个就会把别人的工资发错人。
 *
 * 所以：**未绑定直接拒绝**，返回 `bound:false` 让人事去绑，绝不按名字兜底。
 *
 * ## 六条口径
 *
 * 1. 未绑定不看数据，不猜。
 * 2. 只有 `confirmed` / `paid` 的工资单给员工看；`draft` 是核算中，给员工看等于制造申诉。
 * 3. 申诉窗口：发放日起 30 天。超窗不是不能提，是提示走线下 —— 不假装没这回事。
 * 4. **批准不改已付历史**：生成 `payroll_adjustments`（下一期生效）。
 *    改历史会让上月报表、个税、银行流水全部对不上。
 * 5. 主管只看摘要：出勤天数、请假天数（**不含类型**）、在岗状态；不给金额、不给病假诊断。
 * 6. 本人看自己的工资条也留痕（`granted=1`，理由「本人查看」）——
 *    这样「谁在什么时候看了谁的工资」是完整的。
 */
const { db, now } = require('../db');
const { localDate } = require('../utils/time');
const { nextNo } = require('../utils/docNo');
const privacy = require('./privacy');
const SKILL = require('./skillMatrix');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const today = () => localDate(now());
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const daysBetween = (a, b) => {
  if (!a || !b) return null;
  return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
};

const TYPES = {
  makeup: { label: '补卡', owner: 'hr', due_days: 3, hint: '漏打卡当天补，需要写清几点进、几点出' },
  leave: { label: '请假', owner: 'hr', due_days: 3, hint: '急事可后补，正常应提前申请' },
  profile: { label: '资料更正', owner: 'hr', due_days: 5, hint: '只能改联系方式这类；部门、岗位、工资不能自助改' },
  payroll: { label: '薪资申诉', owner: 'finance', due_days: 5, hint: '对某个月的工资有异议；批准后下一期调整，不改已发' }
};
// 允许自助修改的员工字段白名单 —— 部门/岗位/工资/银行卡一律走线下
const PROFILE_FIELDS = { phone: '手机号', emergency_contact: '紧急联系人' };
const ADJUST_ITEMS = { base: '基本工资', overtime: '加班费', bonus: '奖金', deduction: '扣款', piece_wage: '计件工资', other: '其他' };

/* ==================================================================== *
 * 一、账号 ↔ 员工
 * ==================================================================== */

/** 解析当前登录人对应的员工档案（未绑定返回 null，不猜） */
function resolve(user = {}) {
  const uid = Number(user.id || user.sub || 0);
  if (!uid) return { bound: false, user: null, employee: null };
  const u = db.prepare('SELECT id, username, name, role, department_id, employee_id, active FROM users WHERE id = ?').get(uid);
  if (!u) return { bound: false, user: null, employee: null };
  if (!u.employee_id) return { bound: false, user: u, employee: null };
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(u.employee_id);
  if (!emp) return { bound: false, user: u, employee: null, broken: true };
  return { bound: true, user: u, employee: emp };
}

function bindings(q = {}) {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.name, u.role, u.active, u.employee_id,
              e.code, e.name AS employee_name, e.position, e.status AS employee_status,
              d.name AS dept
         FROM users u
         LEFT JOIN employees e ON e.id = u.employee_id
         LEFT JOIN departments d ON d.id = IFNULL(e.department_id, u.department_id)
        ORDER BY u.id`
    )
    .all();
  const keyword = String(q.q || '').trim();
  const filtered = keyword
    ? rows.filter((r) => `${r.username}${r.name}${r.employee_name || ''}${r.code || ''}`.includes(keyword))
    : rows;
  return {
    rows: filtered.map((r) => ({ ...r, bound: !!r.employee_id })),
    summary: {
      users: rows.length,
      bound: rows.filter((r) => r.employee_id).length,
      unbound: rows.filter((r) => !r.employee_id).length
    }
  };
}

/**
 * 绑定账号到员工
 * 一个员工只能绑一个在职账号 —— 允许一对多会让「本人校验」失去意义
 * （两个账号都能看同一份工资，追责时说不清是谁看的）
 */
function bind(body = {}, operator = '') {
  const userId = Number(body.user_id);
  const employeeId = Number(body.employee_id);
  if (!userId) throw bad('缺少账号');
  if (!employeeId) throw bad('缺少员工');

  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw bad('账号不存在', 404);
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!emp) throw bad('员工不存在', 404);
  if (emp.status === 'left') throw bad(`${emp.name} 已离职，不能绑定为可登录账号（离职后应停用账号）`);

  const taken = db
    .prepare('SELECT id, username, name FROM users WHERE employee_id = ? AND active = 1 AND id <> ?')
    .get(employeeId, userId);
  if (taken && !body.force) {
    throw bad(`${emp.name} 已绑定账号「${taken.username}」。一个员工只能绑一个在职账号，确需换绑请先解绑`);
  }

  db.prepare('UPDATE users SET employee_id = ? WHERE id = ?').run(employeeId, userId);
  return {
    user_id: userId, username: u.username, employee_id: employeeId, employee_name: emp.name,
    note: '绑定后该账号只能看自己的考勤与工资；看别人仍走各自权限'
  };
}

function unbind(userId, operator = '') {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!u) throw bad('账号不存在', 404);
  if (!u.employee_id) throw bad('这个账号本来就没绑定');
  db.prepare('UPDATE users SET employee_id = NULL WHERE id = ?').run(u.id);
  return { user_id: u.id, username: u.username, unbound: true };
}

function employeesForBind(q = {}) {
  // 可绑定的员工：在职；已绑了在职账号的标出来（默认不可选）
  const rows = db
    .prepare(
      `SELECT e.id, e.code, e.name, e.position, e.status, d.name AS dept,
              (SELECT u.username FROM users u WHERE u.employee_id = e.id AND u.active = 1 LIMIT 1) AS bound_user
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
        WHERE IFNULL(e.status,'active') <> 'left'
        ORDER BY d.name, e.name`
    )
    .all();
  const keyword = String(q.q || '').trim();
  const list = keyword ? rows.filter((r) => `${r.name}${r.code}${r.position || ''}`.includes(keyword)) : rows;
  return list.map((r) => ({ ...r, bindable: !r.bound_user }));
}

/* ==================================================================== *
 * 二、工资条（只有 confirmed / paid 能看）
 * ==================================================================== */

/** 申诉窗口：发放日（确认日的 updated_at）起 30 天；没有确认时间就按期间末算 */
function appealWindow(p) {
  const base = String(p.updated_at || p.created_at || '').slice(0, 10);
  const periodEnd = `${p.period}-28`;
  const start = base || periodEnd;
  const end = localDate(new Date(new Date(`${start}T00:00:00`).getTime() + 30 * 86400000).toISOString());
  return { start, end, open: today() <= end };
}

function payslipsOf(employeeId) {
  const rows = db
    .prepare(
      `SELECT * FROM payrolls
        WHERE employee_id = ? AND status IN ('confirmed','paid')
        ORDER BY period DESC`
    )
    .all(Number(employeeId));
  return rows.map((p) => {
    const w = appealWindow(p);
    return {
      id: p.id, period: p.period, net_pay: r2(p.net_pay), gross_pay: r2(p.gross_pay),
      status: p.status, status_label: p.status === 'paid' ? '已发放' : '已确认',
      appeal_window: w
    };
  });
}

/** 查看某张工资条（只能看自己的；人事/财务代查要留痕并标明） */
function payslipDetail(user, id, operatorRole = '') {
  const me = resolve(user);
  const row = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(Number(id));
  if (!row) throw bad('工资单不存在', 404);
  if (!['confirmed', 'paid'].includes(row.status)) throw bad('这期工资还在核算中，暂不可查看（核算完成并确认后才对员工可见）');

  const isSelf = me.bound && Number(me.employee.id) === Number(row.employee_id);
  const isStaff = ['admin', 'hr', 'finance'].includes(operatorRole);
  if (!isSelf && !isStaff) throw bad('只能查看自己的工资单', 403);

  // 留痕：本人看自己的也记，只是 granted=1
  privacy.log({
    username: me.user ? me.user.username : user.username,
    user_name: me.user ? me.user.name : user.name,
    role: me.user ? me.user.role : user.role,
    table_name: 'payrolls',
    field_name: 'net_pay,gross_pay,base_salary',
    target_id: row.id,
    target_label: `${row.employee_name} ${row.period}`,
    action: 'view',
    granted: isSelf ? 1 : 0,
    reason: isSelf ? '本人查看自己的工资条' : `${operatorRole} 代查（非本人）`,
    row_count: 1
  });

  const w = appealWindow(row);
  const adj = db.prepare("SELECT * FROM payroll_adjustments WHERE employee_id = ? AND source_period = ? AND status <> 'void'")
    .all(row.employee_id, row.period);
  const pending = db
    .prepare("SELECT id, ticket_no, status FROM self_requests WHERE employee_id = ? AND type = 'payroll' AND status IN ('submitted','reviewing')")
    .all(row.employee_id);

  return {
    ...row,
    base_salary: r2(row.base_salary), gross_pay: r2(row.gross_pay), net_pay: r2(row.net_pay),
    appeal_window: w,
    can_appeal: w.open && isSelf,
    adjustments: adj,
    pending_appeals: pending,
    viewer: isSelf ? 'self' : 'staff'
  };
}

/* ==================================================================== *
 * 三、我的汇总
 * ==================================================================== */

function overview(user = {}) {
  const me = resolve(user);
  if (!me.bound) {
    return {
      bound: false,
      hint: me.broken
        ? '账号绑定的员工档案不存在（可能已删除），请联系人事重新绑定'
        : '无法查看个人数据。请联系人事在「我的自助 → 账号绑定」里把你的账号绑到员工档案上。',
      user: me.user ? { username: me.user.username, name: me.user.name, role: me.user.role } : null
    };
  }

  const emp = me.employee;
  const dept = emp.department_id
    ? (db.prepare('SELECT name FROM departments WHERE id = ?').get(emp.department_id) || {}).name
    : null;
  const month = today().slice(0, 7);

  // 本月考勤
  const att = db
    .prepare(
      `SELECT status, COUNT(*) c FROM attendance
        WHERE employee_id = ? AND substr(date,1,7) = ? GROUP BY status`
    )
    .all(emp.id, month);
  const attMap = {};
  att.forEach((r) => { attMap[r.status] = r.c; });
  const attTotal = att.reduce((a, r) => a + r.c, 0);

  // 假期：只报「已批已休」，余额没有额度来源就说没有
  const year = today().slice(0, 4);
  const leaves = db
    .prepare(
      `SELECT type, COUNT(*) cnt, COALESCE(SUM(days),0) d FROM leave_requests
        WHERE employee_id = ? AND status = 'approved' AND substr(start_date,1,4) = ?
        GROUP BY type`
    )
    .all(emp.id, year);

  // 我的申请（未结 + 最近）
  const openRequests = db
    .prepare("SELECT COUNT(*) c FROM self_requests WHERE employee_id = ? AND status IN ('submitted','reviewing')")
    .get(emp.id).c;
  const recentRequests = db
    .prepare('SELECT id, ticket_no, type, title, status, due_date, created_at FROM self_requests WHERE employee_id = ? ORDER BY id DESC LIMIT 5')
    .all(emp.id);

  // 我的技能（复用技能矩阵，含到期）
  let skills = { skills: [], certs: [] };
  try { skills = SKILL.mySkills(emp.id); } catch (e) { skills = { skills: [], certs: [] }; }
  const expiringSkills = (skills.skills || []).filter((s) => s.valid_until && s.valid_until <= localDate(new Date(Date.now() + 60 * 86400000).toISOString()));
  const expiringCerts = (skills.certs || []).filter((c) => c.expire_date && c.expire_date <= localDate(new Date(Date.now() + 60 * 86400000).toISOString()));

  const slips = payslipsOf(emp.id);
  const yearPaid = r2(slips.filter((s) => s.period.slice(0, 4) === year).reduce((a, s) => a + s.net_pay, 0));

  return {
    bound: true,
    me: {
      id: emp.id, code: emp.code, name: emp.name, position: emp.position, dept,
      hire_date: emp.hire_date, employment_type: emp.employment_type,
      status: emp.status, phone: emp.phone, emergency_contact: emp.emergency_contact,
      regular_date: emp.regular_date
    },
    month,
    attendance: {
      // 注意：考勤表的状态值是 normal / late / leave / absent（路由 attendance.js 写的），
      // 不是 present。按 present 统计会让所有人「出勤 0 天」—— 字段名对不上就是显示 0。
      total: attTotal,
      present: (attMap.normal || 0) + (attMap.late || 0),
      normal: attMap.normal || 0,
      late: attMap.late || 0,
      absent: attMap.absent || 0,
      leave: attMap.leave || 0,
      // 缺记录不是缺勤：没排班/没打卡记录的日子不该算旷工
      note: attTotal === 0 ? '本月还没有考勤记录（不代表缺勤）' : null
    },
    leave: {
      year,
      used: leaves.map((l) => ({ type: l.type, count: l.cnt, days: r2(l.d) })),
      total_days: r2(leaves.reduce((a, l) => a + Number(l.d || 0), 0)),
      // 没有年假额度表，就不编一个「剩余 3 天」出来
      quota: null,
      quota_note: '系统未配置年假额度，这里只列已批已休天数'
    },
    payslips: {
      latest: slips.slice(0, 6),
      count: slips.length,
      year_paid: yearPaid,
      note: slips.length ? null : '还没有已确认的工资单（核算中的不显示，避免看了又改）'
    },
    skills: {
      count: (skills.skills || []).length,
      can_work_alone: (skills.skills || []).filter((s) => s.can_work_alone).length,
      expiring: [
        ...expiringSkills.map((s) => ({ kind: 'skill', item: s.process_name, date: s.valid_until })),
        ...expiringCerts.map((c) => ({ kind: 'cert', item: c.cert_type, date: c.expire_date }))
      ]
    },
    requests: { open: openRequests, recent: recentRequests },
    // 离职后仍可看自己的历史工资单，但不给提交新申请
    can_submit: emp.status !== 'left'
  };
}

/* ==================================================================== *
 * 四、提交申请
 * ==================================================================== */

function submit(user = {}, body = {}) {
  const me = resolve(user);
  if (!me.bound) throw bad('当前账号未绑定员工档案，不能提交申请，请联系人事');
  const emp = me.employee;
  if (emp.status === 'left') throw bad('已离职账号只能查看历史记录，不能再提交申请');

  const type = String(body.type || '').trim();
  const cfg = TYPES[type];
  if (!cfg) throw bad('申请类型只能是：补卡 / 请假 / 资料更正 / 薪资申诉');
  const reason = String(body.reason || '').trim();
  if (reason.length < 5) throw bad('请写清原因（至少 5 个字），一句话说不清的申请人事没法处理');

  const payload = body.payload && typeof body.payload === 'object' ? { ...body.payload } : {};
  const t = today();

  /* ---- 分类型校验 ---- */
  if (type === 'makeup') {
    const date = String(payload.date || '').slice(0, 10);
    if (!date) throw bad('补卡要选日期');
    if (date > t) throw bad('不能给未来的日期补卡');
    const gap = daysBetween(date, t);
    if (gap != null && gap > 30) throw bad(`只能补最近 30 天的卡（${date} 已超过 ${gap} 天），更早的请联系人事走线下`);
    const inT = String(payload.check_in || '').trim();
    const outT = String(payload.check_out || '').trim();
    if (!inT && !outT) throw bad('补卡至少要填上班或下班其中一个时间');
    // 同一天已有处理中的补卡就别再开一张：两张都批会重复写考勤
    const dupMakeup = db
      .prepare("SELECT ticket_no FROM self_requests WHERE employee_id = ? AND type = 'makeup' AND status IN ('submitted','reviewing') AND payload LIKE ?")
      .get(emp.id, `%"date":"${date}"%`);
    if (dupMakeup) throw bad(`${date} 已有一条处理中的补卡申请（${dupMakeup.ticket_no}），不用重复提交`);
    payload.check_in = inT || null;
    payload.check_out = outT || null;
    payload.date = date;
  }

  if (type === 'leave') {
    const start = String(payload.start_date || '').slice(0, 10);
    const end = String(payload.end_date || start).slice(0, 10);
    if (!start) throw bad('请假要填开始日期');
    if (end < start) throw bad('结束日期不能早于开始日期');
    payload.start_date = start;
    payload.end_date = end;
    payload.days = Math.max(0.5, Number(payload.days) || daysBetween(start, end) + 1 || 0.5);
    payload.leave_type = payload.leave_type || 'personal';
  }

  if (type === 'profile') {
    const field = String(payload.field || '').trim();
    if (!PROFILE_FIELDS[field]) {
      throw bad(`「${field || '未选择'}」不能自助更正。部门、岗位、工资、银行卡请找人事走线下变更（有审批与留痕）`);
    }
    const value = String(payload.value || '').trim();
    if (value.length < 2) throw bad('更正后的内容太短');
    payload.field = field;
    payload.field_label = PROFILE_FIELDS[field];
    payload.value = value;
  }

  if (type === 'payroll') {
    const pid = Number(payload.payroll_id);
    if (!pid) throw bad('要指定是哪个月的工资单');
    const p = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(pid);
    if (!p) throw bad('工资单不存在', 404);
    if (Number(p.employee_id) !== Number(emp.id)) throw bad('只能对自己的工资单提申诉', 403);
    if (!['confirmed', 'paid'].includes(p.status)) throw bad('这期工资还在核算中，确认后才能申诉');
    const w = appealWindow(p);
    if (!w.open) throw bad(`这张工资单的申诉期已过（${w.end} 截止），请直接联系人事走线下处理`);
    // 同一张工资单只允许一条处理中的申诉：财务重复受理会演出重复补款
    const dupAppeal = db
      .prepare("SELECT ticket_no FROM self_requests WHERE employee_id = ? AND type = 'payroll' AND status IN ('submitted','reviewing') AND payload LIKE ?")
      .get(emp.id, `%"payroll_id":${pid}%`);
    if (dupAppeal) throw bad(`这张工资单已有一条处理中的申诉（${dupAppeal.ticket_no}），不用重复提交`);
    payload.payroll_id = pid;
    payload.period = p.period;
    payload.net_pay = r2(p.net_pay);
    payload.claim_amount = payload.claim_amount == null ? null : r2(payload.claim_amount);
  }

  /* ---- 落库 ---- */
  const ticket = nextNo('SR', 'self_requests', 'ticket_no');
  const due = localDate(new Date(Date.now() + cfg.due_days * 86400000).toISOString());
  const info = db
    .prepare(
      `INSERT INTO self_requests (ticket_no, employee_id, employee_name, type, title, reason, payload, status,
         owner_role, due_date, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'submitted', ?, ?, ?, ?)`
    )
    .run(ticket, emp.id, emp.name, type, String(body.title || cfg.label).slice(0, 60), reason,
      JSON.stringify(payload), cfg.owner, due, now(), now());

  return {
    id: Number(info.lastInsertRowid), ticket_no: ticket, type, type_label: cfg.label,
    owner_role: cfg.owner, due_date: due,
    note: `已提交，${cfg.owner === 'finance' ? '财务' : '人事'}在 ${due} 前回复`
  };
}

function myRequests(user = {}, q = {}) {
  const me = resolve(user);
  if (!me.bound) throw bad('当前账号未绑定员工档案');
  const where = ['employee_id = ?'];
  const args = [me.employee.id];
  if (q.status) { where.push('status = ?'); args.push(String(q.status)); }
  const rows = db
    .prepare(`SELECT * FROM self_requests WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 100`)
    .all(...args);
  return rows.map((r) => ({
    ...r,
    type_label: (TYPES[r.type] || {}).label || r.type,
    payload: safeJson(r.payload),
    overdue: ['submitted', 'reviewing'].includes(r.status) && r.due_date && r.due_date < today()
  }));
}

function withdraw(user = {}, id) {
  const me = resolve(user);
  if (!me.bound) throw bad('当前账号未绑定员工档案');
  const row = db.prepare('SELECT * FROM self_requests WHERE id = ?').get(Number(id));
  if (!row) throw bad('申请不存在', 404);
  if (Number(row.employee_id) !== Number(me.employee.id)) throw bad('只能撤回自己的申请', 403);
  if (!['submitted', 'reviewing'].includes(row.status)) throw bad('已处理完的申请不能撤回');
  db.prepare("UPDATE self_requests SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(now(), row.id);
  return { id: row.id, status: 'withdrawn' };
}

/* ==================================================================== *
 * 五、受理与结论（人事 / 财务）
 * ==================================================================== */

function review(user = {}, id, body = {}) {
  const row = db.prepare('SELECT * FROM self_requests WHERE id = ?').get(Number(id));
  if (!row) throw bad('申请不存在', 404);
  if (!['submitted', 'reviewing'].includes(row.status)) throw bad('这条申请已经处理过了');

  const approve = !!body.approve;
  const conclusion = String(body.conclusion || '').trim();
  // 驳回也得写结论：员工拿到「已驳回」三个字等于没回复
  if (conclusion.length < 5) throw bad('结论至少 5 个字（批准和驳回都要写清依据）');

  const operator = user.name || user.username || '';
  const role = user.role || '';
  const payload = safeJson(row.payload) || {};

  let adjustId = null;
  let sideEffect = null;

  if (approve) {
    if (row.type === 'makeup') {
      // 补卡批准 → 直接回写考勤（考勤不是「已付历史」，可以改）
      const date = payload.date;
      const exist = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND date = ?').get(row.employee_id, date);
      if (exist) {
        db.prepare('UPDATE attendance SET check_in = COALESCE(?, check_in), check_out = COALESCE(?, check_out), remark = ? WHERE id = ?')
          .run(payload.check_in || null, payload.check_out || null, `补卡：${row.ticket_no}`, exist.id);
        sideEffect = `已更新 ${date} 的考勤记录`;
      } else {
        db.prepare('INSERT INTO attendance (employee_id, employee_name, date, check_in, check_out, status, remark, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(row.employee_id, row.employee_name, date, payload.check_in || null, payload.check_out || null,
            // 与 attendance.js 保持一致：正常出勤是 normal，不是 present
            'normal', `补卡：${row.ticket_no}`, now());
        sideEffect = `已补建 ${date} 的考勤记录（状态：出勤）`;
      }
    } else if (row.type === 'profile') {
      const field = payload.field;
      if (!PROFILE_FIELDS[field]) throw bad('这个字段不允许自助更正');
      db.prepare(`UPDATE employees SET ${field} = ? WHERE id = ?`).run(payload.value, row.employee_id);
      sideEffect = `已更正 ${PROFILE_FIELDS[field]} 为「${payload.value}」`;
    } else if (row.type === 'leave') {
      // 不自动生成请假单：请假要占额度、要扣薪，两套状态必然打架
      sideEffect = '请在「请假管理」里按本结论登记请假单（系统不自动生成，避免与请假额度两套状态）';
    } else if (row.type === 'payroll') {
      const amount = Number(body.adjust_amount);
      if (!Number.isFinite(amount) || amount === 0) throw bad('薪资申诉批准必须填调整金额（正数=补发，负数=扣回）');
      const p = db.prepare('SELECT * FROM payrolls WHERE id = ?').get(payload.payroll_id);
      if (!p) throw bad('工资单不存在', 404);
      // 下一期生效：绝不改已发放的那一期
      const [y, m] = String(p.period).split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      const adjNo = nextNo('PA', 'payroll_adjustments', 'adj_no');
      const info = db
        .prepare(
          `INSERT INTO payroll_adjustments (adj_no, request_id, employee_id, employee_name, period, item, amount,
             reason, status, source_period, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?, ?, ?)`
        )
        .run(adjNo, row.id, row.employee_id, row.employee_name, next,
          ADJUST_ITEMS[body.adjust_item] ? body.adjust_item : 'other', r2(amount),
          `申诉 ${row.ticket_no}：${conclusion}`, p.period, operator, now(), now());
      adjustId = Number(info.lastInsertRowid);
      sideEffect = `已生成调整单 ${adjNo}，${next} 那期工资体现（${amount > 0 ? '补发' : '扣回'} ${Math.abs(r2(amount))}）；${p.period} 已发工资不动`;
    }
  }

  db.prepare(
    `UPDATE self_requests SET status = ?, conclusion = ?, decided_by = ?, decided_at = ?, adjust_id = ?, updated_at = ?
      WHERE id = ?`
  ).run(approve ? 'approved' : 'rejected', conclusion, operator, now(), adjustId, now(), row.id);

  return { id: row.id, ticket_no: row.ticket_no, status: approve ? 'approved' : 'rejected', conclusion, adjust_id: adjustId, side_effect: sideEffect };
}

function requestsForStaff(q = {}) {
  const where = [];
  const args = [];
  if (q.status) { where.push('status = ?'); args.push(String(q.status)); }
  if (q.type) { where.push('type = ?'); args.push(String(q.type)); }
  if (q.owner) { where.push('owner_role = ?'); args.push(String(q.owner)); }
  const rows = db
    .prepare(`SELECT * FROM self_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`)
    .all(...args);
  const t = today();
  return rows.map((r) => ({
    ...r,
    type_label: (TYPES[r.type] || {}).label || r.type,
    payload: safeJson(r.payload),
    overdue: ['submitted', 'reviewing'].includes(r.status) && r.due_date && r.due_date < t,
    days_left: r.due_date ? daysBetween(t, r.due_date) : null
  }));
}

function adjustments(q = {}) {
  const where = [];
  const args = [];
  if (q.employee_id) { where.push('employee_id = ?'); args.push(Number(q.employee_id)); }
  if (q.period) { where.push('period = ?'); args.push(String(q.period)); }
  if (q.status) { where.push('status = ?'); args.push(String(q.status)); }
  return db
    .prepare(`SELECT * FROM payroll_adjustments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`)
    .all(...args);
}

/* ==================================================================== *
 * 六、主管视角：只看摘要，不给钱、不给病假
 * ==================================================================== */

function teamSummary(user = {}) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(user.id || user.sub || 0));
  if (!u) throw bad('账号不存在', 404);
  if (!u.department_id) throw bad('当前账号没有归属部门，看不了团队摘要');
  const month = today().slice(0, 7);
  const emps = db
    .prepare("SELECT id, code, name, position, status FROM employees WHERE department_id = ? AND IFNULL(status,'active') <> 'left' ORDER BY name")
    .all(u.department_id);

  const rows = emps.map((e) => {
    const att = db
      .prepare('SELECT status, COUNT(*) c FROM attendance WHERE employee_id = ? AND substr(date,1,7) = ? GROUP BY status')
      .all(e.id, month);
    const attMap = {};
    att.forEach((r) => { attMap[r.status] = r.c; });
    // 只给天数，不给请假类型 —— 病假属敏感，主管默认不该知道
    const leaveDays = db
      .prepare("SELECT COALESCE(SUM(days),0) d FROM leave_requests WHERE employee_id = ? AND status='approved' AND substr(start_date,1,7) = ?")
      .get(e.id, month).d;
    return {
      employee_id: e.id, code: e.code, name: e.name, position: e.position,
      in_service: e.status !== 'left',
      // 状态值是 normal / late（见 routes/attendance.js），不是 present
      present_days: (attMap.normal || 0) + (attMap.late || 0),
      late_days: attMap.late || 0,
      absent_days: attMap.absent || 0,
      leave_days: r2(leaveDays),
      // 明确不提供：工资、病假类型、诊断
      money: null
    };
  });

  return {
    month,
    dept_id: u.department_id,
    rows,
    summary: {
      people: rows.length,
      present: rows.reduce((a, r) => a + r.present_days, 0),
      late: rows.reduce((a, r) => a + r.late_days, 0),
      absent: rows.reduce((a, r) => a + r.absent_days, 0),
      leave: r2(rows.reduce((a, r) => a + r.leave_days, 0))
    },
    boundary: '主管只看出勤与休假天数：不含工资金额，不含请假类型（病假属敏感信息，需本人或人事处理）'
  };
}

/* ==================================================================== *
 * 七、字典与统计
 * ==================================================================== */

function dict() {
  return {
    types: Object.entries(TYPES).map(([v, c]) => ({ value: v, label: c.label, owner: c.owner, due_days: c.due_days, hint: c.hint })),
    status: [
      { value: 'submitted', label: '待受理' },
      { value: 'reviewing', label: '处理中' },
      { value: 'approved', label: '已批准' },
      { value: 'rejected', label: '已驳回' },
      { value: 'withdrawn', label: '已撤回' }
    ],
    profile_fields: Object.entries(PROFILE_FIELDS).map(([v, l]) => ({ value: v, label: l })),
    adjust_items: Object.entries(ADJUST_ITEMS).map(([v, l]) => ({ value: v, label: l })),
    stats: stats()
  };
}

function stats() {
  const g = (sql, ...a) => db.prepare(sql).get(...a).c;
  const t = today();
  return {
    users: g('SELECT COUNT(*) c FROM users WHERE active = 1'),
    bound: g('SELECT COUNT(*) c FROM users WHERE active = 1 AND employee_id IS NOT NULL'),
    unbound: g('SELECT COUNT(*) c FROM users WHERE active = 1 AND (employee_id IS NULL OR employee_id = 0)'),
    pending: g("SELECT COUNT(*) c FROM self_requests WHERE status IN ('submitted','reviewing')"),
    overdue: g("SELECT COUNT(*) c FROM self_requests WHERE status IN ('submitted','reviewing') AND due_date < ?", t),
    payroll_appeals: g("SELECT COUNT(*) c FROM self_requests WHERE type = 'payroll'"),
    adjustments_pending: g("SELECT COUNT(*) c FROM payroll_adjustments WHERE status = 'pending'"),
    adjustments_amount: r2(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payroll_adjustments WHERE status = 'pending'").get().s || 0)
  };
}

function safeJson(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

module.exports = {
  TYPES, PROFILE_FIELDS, ADJUST_ITEMS,
  resolve, bindings, bind, unbind, employeesForBind,
  overview, payslipsOf, payslipDetail, appealWindow,
  submit, myRequests, withdraw,
  review, requestsForStaff, adjustments,
  teamSummary, dict, stats
};
