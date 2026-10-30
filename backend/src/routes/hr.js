/**
 * 人事办理：招聘入职 / 转调离 / 劳动合同 / 调薪（对齐原型 TS-M13 N13-02 / 03 / 11）
 * ------------------------------------------------------------
 * N13-02 招聘入职与转调离
 *   - 招聘需求按「需求人数 / 已到岗」分开记，招满自动关闭，避免需求挂着没人管
 *   - 候选人阶段：已投递 → 面试中 → 已发 offer → 已入职（或未通过）；入职即生成/关联员工档案
 *   - 异动（入职/转正/调岗/晋升/离职）**生效才改档案**：生效日未到先挂「待生效」，避免提前改错
 *   - 离职必须有交接清单，不允许裸退
 * N13-03 合同试用与续签
 *   - 同一员工不允许存在两份时间重叠的有效合同
 *   - 试用期必须落在合同期内
 *   - 合同需「交付员工」并留证据（劳动合同法要求双方各执一份）
 *   - 续签生成新合同并指向前一份，旧合同标记已续签
 * N13-11 调薪（薪资规则里的调薪部分）
 *   - 调薪必须留前后值与生效日；生效后才回写员工基本工资，历史可追溯
 */
const express = require('express');
const { db, now } = require('../db');
const { nextNo } = require('../utils/docNo');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'hr'];
const today = () => new Date().toISOString().slice(0, 10);

const RECRUIT_STATUS = { open: '在招', paused: '暂停', closed: '已关闭' };
const CAND_STAGE = { applied: '已投递', interview: '面试中', offer: '已发 offer', hired: '已入职', rejected: '未通过' };
const MOV_TYPE = { onboard: '入职', regular: '转正', transfer: '调岗', promote: '晋升', resign: '离职' };
const MOV_STATUS = { pending: '待生效', effective: '已生效', cancelled: '已撤销' };
const CONTRACT_TYPE = { fixed: '固定期限', open: '无固定期限', internship: '实习', labor: '劳务' };
const DELIVERY = { pending: '未交付', delivered: '已交付' };
const CONTRACT_STATUS = { active: '有效', renewed: '已续签', expired: '已到期', terminated: '已解除' };
const ADJ_TYPE = { annual: '年度调薪', regular: '转正调薪', promote: '晋升调薪', adjust: '个别调整' };
const ADJ_STATUS = { draft: '草稿', approved: '已批准', effective: '已生效', cancelled: '已取消' };

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const daysBetween = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

function empBrief(id) {
  return db.prepare(
    `SELECT e.*, d.name AS department_name FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`
  ).get(id);
}

function deptName(id) {
  if (!id) return null;
  const d = db.prepare('SELECT name FROM departments WHERE id = ?').get(id);
  return d ? d.name : null;
}

// ============================================================
// 概览
// ============================================================
router.get('/stats', authRequired, wrap(async (req, res) => {
  const t = today();
  const recru = db.prepare(
    `SELECT SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_req,
            COALESCE(SUM(CASE WHEN status = 'open' THEN headcount - hired ELSE 0 END), 0) AS open_head,
            SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS _x
     FROM hr_recruitments`
  ).get();
  const cand = db.prepare(
    `SELECT SUM(CASE WHEN stage IN ('applied','interview','offer') THEN 1 ELSE 0 END) AS pipeline,
            SUM(CASE WHEN stage = 'hired' THEN 1 ELSE 0 END) AS hired
     FROM hr_candidates`
  ).get();

  const contracts = db.prepare(
    `SELECT
       SUM(CASE WHEN status IN ('active','renewed') AND end_date IS NOT NULL AND end_date < ? THEN 1 ELSE 0 END) AS expired,
       SUM(CASE WHEN status IN ('active','renewed') AND end_date IS NOT NULL AND end_date >= ? AND end_date <= date(?, '+30 day') THEN 1 ELSE 0 END) AS expiring30,
       SUM(CASE WHEN status IN ('active','renewed') AND end_date IS NOT NULL AND end_date > date(?, '+30 day') AND end_date <= date(?, '+90 day') THEN 1 ELSE 0 END) AS expiring90,
       SUM(CASE WHEN delivery_status = 'pending' THEN 1 ELSE 0 END) AS undelivered,
       COUNT(*) AS total
     FROM labor_contracts`
  ).get(t, t, t, t, t);

  const movements = db.prepare(
    `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'effective' AND type = 'resign' THEN 1 ELSE 0 END) AS resigned,
            SUM(CASE WHEN status = 'effective' AND type IN ('transfer','promote') THEN 1 ELSE 0 END) AS moved
     FROM employee_movements`
  ).get();

  const adj = db.prepare(
    `SELECT SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
            COALESCE(SUM(CASE WHEN status = 'effective' THEN after_salary - before_salary ELSE 0 END), 0) AS delta
     FROM salary_adjustments`
  ).get();

  // 无合同在职员工（合规风险，容易被忽略）
  const noContract = db.prepare(
    `SELECT COUNT(*) AS c FROM employees e
     WHERE e.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM labor_contracts c WHERE c.employee_id = e.id AND c.status IN ('active','renewed'))`
  ).get().c;

  return ok(res, {
    recruit: {
      open_req: Number(recru.open_req) || 0,
      open_head: Number(recru.open_head) || 0,
      pipeline: Number(cand.pipeline) || 0,
      hired: Number(cand.hired) || 0
    },
    contracts: {
      total: Number(contracts.total) || 0,
      expired: Number(contracts.expired) || 0,
      expiring30: Number(contracts.expiring30) || 0,
      expiring90: Number(contracts.expiring90) || 0,
      undelivered: Number(contracts.undelivered) || 0,
      no_contract_employees: Number(noContract) || 0
    },
    movements: {
      pending: Number(movements.pending) || 0,
      resigned: Number(movements.resigned) || 0,
      moved: Number(movements.moved) || 0
    },
    adjustments: {
      draft: Number(adj.draft) || 0,
      approved: Number(adj.approved) || 0,
      salary_delta: round2(adj.delta)
    },
    warnings: [
      Number(contracts.expired) > 0 ? `${contracts.expired} 份合同已过期仍未续签` : null,
      Number(contracts.expiring30) > 0 ? `${contracts.expiring30} 份合同 30 天内到期，请启动续签` : null,
      Number(contracts.undelivered) > 0 ? `${contracts.undelivered} 份合同未交付员工（需双方各执一份）` : null,
      Number(noContract) > 0 ? `${noContract} 名在职员工没有有效劳动合同` : null,
      Number(movements.pending) > 0 ? `${movements.pending} 项人事异动待生效` : null,
      Number(adj.draft) + Number(adj.approved) > 0 ? `${Number(adj.draft) + Number(adj.approved)} 条调薪待生效` : null
    ].filter(Boolean)
  });
}));

// ============================================================
// N13-02 招聘需求
// ============================================================
function recruitView(r) {
  const t = today();
  const extra = db.prepare(
    `SELECT SUM(CASE WHEN stage IN ('applied','interview','offer') THEN 1 ELSE 0 END) AS pipeline,
            COUNT(*) AS cands FROM hr_candidates WHERE recruitment_id = ?`
  ).get(r.id);
  return {
    ...r,
    department_name: deptName(r.department_id),
    status_label: RECRUIT_STATUS[r.status] || r.status,
    gap: Math.max(0, Number(r.headcount) - Number(r.hired)),
    candidates: Number(extra.cands) || 0,
    pipeline: Number(extra.pipeline) || 0,
    empty: Number(r.hired) >= Number(r.headcount),
    opened_days: r.opened_at ? Math.max(0, daysBetween(r.opened_at, t)) : null
  };
}

router.get('/recruitments', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.status) { cond.push('status = ?'); params.push(req.query.status); }
  if (req.query.q) { cond.push('(position LIKE ? OR req_no LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const rows = db.prepare(
    `SELECT * FROM hr_recruitments ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC`
  ).all(...params);
  return ok(res, rows.map(recruitView));
}));

router.post('/recruitments', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.position) return fail(res, 400, '请填写招聘岗位');
  const head = Number(b.headcount) || 1;
  if (head <= 0) return fail(res, 400, '需求人数必须大于 0');
  const t = now();
  const r = db.prepare(
    `INSERT INTO hr_recruitments (req_no, position, department_id, headcount, hired, requirement, channel,
       salary_range, owner, status, opened_at, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(nextNo('ZP', 'hr_recruitments', 'req_no'), b.position, b.department_id || null, head, 0,
    b.requirement || null, b.channel || null, b.salary_range || null, b.owner || req.user.username,
    b.status || 'open', b.opened_at || t.slice(0, 10), b.remark || null, req.user.username, t, t);
  return ok(res, recruitView(db.prepare('SELECT * FROM hr_recruitments WHERE id = ?').get(r.lastInsertRowid)));
}));

router.put('/recruitments/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM hr_recruitments WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '招聘需求不存在');
  const b = req.body || {};
  const head = b.headcount !== undefined ? Number(b.headcount) || 0 : Number(row.headcount);
  if (head < Number(row.hired)) {
    return fail(res, 400, `需求人数 ${head} 不能小于已到岗 ${row.hired} 人`);
  }
  db.prepare(
    `UPDATE hr_recruitments SET position=?, department_id=?, headcount=?, requirement=?, channel=?,
       salary_range=?, owner=?, status=?, remark=?, updated_at=? WHERE id=?`
  ).run(b.position || row.position,
    b.department_id !== undefined ? b.department_id : row.department_id, head,
    b.requirement ?? row.requirement, b.channel ?? row.channel, b.salary_range ?? row.salary_range,
    b.owner ?? row.owner, b.status || row.status, b.remark ?? row.remark, now(), row.id);
  return ok(res, recruitView(db.prepare('SELECT * FROM hr_recruitments WHERE id = ?').get(row.id)));
}));

router.delete('/recruitments/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM hr_candidates WHERE recruitment_id = ?').get(req.params.id).c;
  if (Number(cnt) > 0) return fail(res, 400, '该需求下已有候选人，请改为「关闭」而不是删除');
  db.prepare('DELETE FROM hr_recruitments WHERE id = ?').run(req.params.id);
  return ok(res, { deleted: 1 });
}));

// ---------- 候选人 ----------
function candView(r) {
  const rec = r.recruitment_id ? db.prepare('SELECT position, req_no FROM hr_recruitments WHERE id = ?').get(r.recruitment_id) : null;
  return {
    ...r,
    stage_label: CAND_STAGE[r.stage] || r.stage,
    position: rec ? rec.position : null,
    req_no: rec ? rec.req_no : null
  };
}

router.get('/candidates', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.recruitment_id) { cond.push('recruitment_id = ?'); params.push(Number(req.query.recruitment_id)); }
  if (req.query.stage) { cond.push('stage = ?'); params.push(req.query.stage); }
  const rows = db.prepare(
    `SELECT * FROM hr_candidates ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC`
  ).all(...params);
  return ok(res, rows.map(candView));
}));

router.post('/candidates', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '请填写候选人姓名');
  const t = now();
  const r = db.prepare(
    `INSERT INTO hr_candidates (recruitment_id, name, phone, source, resume_url, expected_salary, offer_salary,
       stage, interview_note, expected_onboard, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(b.recruitment_id || null, b.name, b.phone || null, b.source || null, b.resume_url || null,
    Number(b.expected_salary) || 0, Number(b.offer_salary) || 0, b.stage || 'applied',
    b.interview_note || null, b.expected_onboard || null, t, t);
  return ok(res, candView(db.prepare('SELECT * FROM hr_candidates WHERE id = ?').get(r.lastInsertRowid)));
}));

router.put('/candidates/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM hr_candidates WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '候选人不存在');
  if (row.stage === 'hired') return fail(res, 400, '已入职候选人不能再修改');
  const b = req.body || {};
  const stage = b.stage || row.stage;
  if (!CAND_STAGE[stage]) return fail(res, 400, '候选人阶段不合法');
  if (stage === 'offer' && !Number(b.offer_salary || row.offer_salary)) {
    return fail(res, 400, '发 offer 前请填写 offer 薪资');
  }
  db.prepare(
    `UPDATE hr_candidates SET name=?, phone=?, source=?, resume_url=?, expected_salary=?, offer_salary=?,
       stage=?, interview_note=?, expected_onboard=?, updated_at=? WHERE id=?`
  ).run(b.name || row.name, b.phone ?? row.phone, b.source ?? row.source, b.resume_url ?? row.resume_url,
    b.expected_salary !== undefined ? Number(b.expected_salary) || 0 : row.expected_salary,
    b.offer_salary !== undefined ? Number(b.offer_salary) || 0 : row.offer_salary,
    stage, b.interview_note ?? row.interview_note, b.expected_onboard ?? row.expected_onboard,
    now(), row.id);
  return ok(res, candView(db.prepare('SELECT * FROM hr_candidates WHERE id = ?').get(row.id)));
}));

/**
 * 候选人入职：生成员工档案 + 关联需求已到岗人数 + 一条「入职」异动
 * 招满后需求自动关闭，避免长期挂着
 */
router.post('/candidates/:id/hire', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM hr_candidates WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '候选人不存在');
  if (c.stage === 'hired') return fail(res, 400, '该候选人已办理入职');
  if (c.stage === 'rejected') return fail(res, 400, '该候选人已标记未通过');
  const b = req.body || {};
  const rec = c.recruitment_id ? db.prepare('SELECT * FROM hr_recruitments WHERE id = ?').get(c.recruitment_id) : null;
  const hireDate = b.hire_date || c.expected_onboard || today();
  const salary = Number(b.base_salary || c.offer_salary) || 0;
  const deptId = b.department_id !== undefined ? b.department_id : (rec ? rec.department_id : null);
  const position = b.position || (rec ? rec.position : null);
  const t = now();

  let empId = null;
  try {
    db.exec('BEGIN');
    const e = db.prepare(
      `INSERT INTO employees (code, name, department_id, position, phone, hire_date, status, base_salary,
         employment_type, remark, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(b.code || null, c.name, deptId || null, position, c.phone || null, hireDate, 'active', salary,
      'probation', '由招聘转入', t);
    empId = Number(e.lastInsertRowid);

    db.prepare("UPDATE hr_candidates SET stage='hired', hired_employee_id=?, updated_at=? WHERE id=?").run(empId, t, c.id);

    if (rec) {
      const hired = Number(rec.hired) + 1;
      const full = hired >= Number(rec.headcount);
      db.prepare("UPDATE hr_recruitments SET hired=?, status=?, closed_at=?, updated_at=? WHERE id=?")
        .run(hired, full ? 'closed' : rec.status, full ? t.slice(0, 10) : rec.closed_at, t, rec.id);
    }

    db.prepare(
      `INSERT INTO employee_movements (mov_no, employee_id, type, effective_date, to_department_id, to_position,
         reason, status, applied_at, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(nextNo('YD', 'employee_movements', 'mov_no'), empId, 'onboard', hireDate, deptId || null, position,
      '招聘入职', 'effective', t, req.user.username, t, t);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, { candidate_id: c.id, employee_id: empId, hire_date: hireDate, base_salary: round2(salary) });
}));

router.delete('/candidates/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM hr_candidates WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '候选人不存在');
  if (row.stage === 'hired') return fail(res, 400, '已入职候选人不能删除');
  db.prepare('DELETE FROM hr_candidates WHERE id = ?').run(row.id);
  return ok(res, { deleted: 1 });
}));

// ============================================================
// N13-02 转调离（员工异动）
// ============================================================
function movView(r) {
  const emp = empBrief(r.employee_id);
  let handover = [];
  try { handover = JSON.parse(r.handover || '[]'); } catch (e) { handover = []; }
  return {
    ...r,
    type_label: MOV_TYPE[r.type] || r.type,
    status_label: MOV_STATUS[r.status] || r.status,
    employee_name: emp ? emp.name : null,
    from_department_name: deptName(r.from_department_id) || (emp ? emp.department_name : null),
    to_department_name: deptName(r.to_department_id),
    handover,
    handover_done: Array.isArray(handover) && handover.length ? handover.filter((h) => h.done).length : 0,
    handover_total: Array.isArray(handover) ? handover.length : 0,
    due: r.status === 'pending' && r.effective_date <= today()
  };
}

router.get('/movements', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.type) { cond.push('m.type = ?'); params.push(req.query.type); }
  if (req.query.status) { cond.push('m.status = ?'); params.push(req.query.status); }
  if (req.query.employee_id) { cond.push('m.employee_id = ?'); params.push(Number(req.query.employee_id)); }
  const rows = db.prepare(
    `SELECT m.* FROM employee_movements m ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
     ORDER BY m.id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows.map(movView));
}));

router.post('/movements', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.employee_id) return fail(res, 400, '请选择员工');
  if (!MOV_TYPE[b.type]) return fail(res, 400, '异动类型应为 onboard / regular / transfer / promote / resign');
  if (!b.effective_date) return fail(res, 400, '请填写生效日期');
  const emp = empBrief(b.employee_id);
  if (!emp) return fail(res, 404, '员工不存在');
  if (emp.status === 'left' && b.type !== 'onboard') return fail(res, 400, '该员工已离职，不能再办理其他异动');

  // 离职必须有交接清单，避免裸退
  let handover = Array.isArray(b.handover) ? b.handover.filter((h) => h && h.task) : [];
  if (b.type === 'resign' && !handover.length) {
    return fail(res, 400, '离职必须填写交接清单（至少一项）');
  }
  if (b.type === 'transfer' && !b.to_department_id && !b.to_position) {
    return fail(res, 400, '调岗需填写目标部门或目标岗位');
  }

  const t = now();
  const r = db.prepare(
    `INSERT INTO employee_movements (mov_no, employee_id, type, effective_date, from_department_id, to_department_id,
       from_position, to_position, reason, handover, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(nextNo('YD', 'employee_movements', 'mov_no'), emp.id, b.type, b.effective_date,
    b.type === 'onboard' ? null : emp.department_id, b.to_department_id || null,
    b.type === 'onboard' ? null : emp.position, b.to_position || null,
    b.reason || null, handover.length ? JSON.stringify(handover) : null,
    'pending', req.user.username, t, t);
  return ok(res, movView(db.prepare('SELECT * FROM employee_movements WHERE id = ?').get(r.lastInsertRowid)));
}));

/**
 * 异动生效：把档案改过来，并留生效时间
 * 生效日未到默认不允许生效，除非显式 force（提前执行）
 */
router.post('/movements/:id/apply', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM employee_movements WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '异动单不存在');
  if (r.status === 'effective') return fail(res, 400, '该异动已生效');
  if (r.status === 'cancelled') return fail(res, 400, '该异动已撤销');
  const force = !!(req.body && req.body.force);
  if (r.effective_date > today() && !force) {
    return fail(res, 400, `生效日 ${r.effective_date} 未到；如需提前执行请选择「立即生效」`);
  }
  const emp = empBrief(r.employee_id);
  if (!emp) return fail(res, 404, '员工不存在');
  const t = now();

  try {
    db.exec('BEGIN');
    if (r.type === 'onboard') {
      db.prepare("UPDATE employees SET status='active', hire_date=?, department_id=COALESCE(?, department_id), position=COALESCE(?, position), employment_type='probation' WHERE id=?")
        .run(r.effective_date, r.to_department_id, r.to_position, emp.id);
    } else if (r.type === 'regular') {
      db.prepare("UPDATE employees SET employment_type='fulltime', regular_date=? WHERE id=?")
        .run(r.effective_date, emp.id);
    } else if (r.type === 'transfer' || r.type === 'promote') {
      db.prepare('UPDATE employees SET department_id=COALESCE(?, department_id), position=COALESCE(?, position) WHERE id=?')
        .run(r.to_department_id, r.to_position, emp.id);
    } else if (r.type === 'resign') {
      db.prepare("UPDATE employees SET status='left', leave_date=? WHERE id=?").run(r.effective_date, emp.id);
      // 离职时把未到期的有效合同置为已解除
      db.prepare("UPDATE labor_contracts SET status='terminated', updated_at=? WHERE employee_id=? AND status IN ('active','renewed')")
        .run(t, emp.id);
    }
    db.prepare("UPDATE employee_movements SET status='effective', applied_at=?, updated_at=? WHERE id=?").run(t, t, r.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, movView(db.prepare('SELECT * FROM employee_movements WHERE id = ?').get(r.id)));
}));

router.post('/movements/:id/cancel', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM employee_movements WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '异动单不存在');
  if (r.status === 'effective') return fail(res, 400, '已生效的异动不能撤销');
  db.prepare("UPDATE employee_movements SET status='cancelled', reason=COALESCE(?, reason), updated_at=? WHERE id=?")
    .run((req.body && req.body.reason) || null, now(), r.id);
  return ok(res, movView(db.prepare('SELECT * FROM employee_movements WHERE id = ?').get(r.id)));
}));

router.delete('/movements/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM employee_movements WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '异动单不存在');
  if (r.status === 'effective') return fail(res, 400, '已生效的异动不能删除');
  db.prepare('DELETE FROM employee_movements WHERE id = ?').run(r.id);
  return ok(res, { deleted: 1 });
}));

// ============================================================
// N13-03 劳动合同
// ============================================================
function contractView(r) {
  const emp = empBrief(r.employee_id);
  const t = today();
  let expiring = null;
  if (r.end_date && ['active', 'renewed'].includes(r.status)) {
    const d = daysBetween(t, r.end_date);
    expiring = d < 0 ? 'expired' : d <= 30 ? '30' : d <= 90 ? '90' : null;
  }
  return {
    ...r,
    type_label: CONTRACT_TYPE[r.type] || r.type,
    status_label: CONTRACT_STATUS[r.status] || r.status,
    delivery_label: DELIVERY[r.delivery_status] || r.delivery_status,
    employee_name: emp ? emp.name : null,
    department_name: emp ? emp.department_name : null,
    days_left: r.end_date ? daysBetween(t, r.end_date) : null,
    expiring,
    // 合同期内但状态仍是 active 却已过期 → 需要续签
    need_renew: expiring === 'expired'
  };
}

router.get('/contracts', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.employee_id) { cond.push('employee_id = ?'); params.push(Number(req.query.employee_id)); }
  if (req.query.status) { cond.push('status = ?'); params.push(req.query.status); }
  if (req.query.expiring) {
    cond.push("end_date IS NOT NULL AND end_date <= date(?, '+' || ? || ' day') AND status IN ('active','renewed')");
    params.push(today(), Number(req.query.expiring) || 30);
  }
  const rows = db.prepare(
    `SELECT * FROM labor_contracts ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC`
  ).all(...params);
  return ok(res, rows.map(contractView));
}));

/** 合同校验：时间不重叠、试用期在合同期内、无固定期限不能填结束日 */
function validateContract(b, excludeId) {
  if (!b.employee_id) return '请选择员工';
  if (!b.start_date) return '请填写合同开始日期';
  if (b.type !== 'open' && !b.end_date) return '固定期限合同必须填写结束日期';
  if (b.type === 'open' && b.end_date) return '无固定期限合同不应填写结束日期';
  if (b.end_date && b.end_date < b.start_date) return '结束日期不能早于开始日期';
  if (b.probation_end) {
    if (b.probation_end < b.start_date) return '试用期结束日不能早于合同开始日';
    if (b.end_date && b.probation_end > b.end_date) return '试用期必须在合同期内（不能晚于合同结束日）';
  }
  // 同一员工不允许时间重叠的有效合同
  const others = db.prepare(
    `SELECT * FROM labor_contracts WHERE employee_id = ? AND status IN ('active','renewed') AND id != ?`
  ).all(b.employee_id, excludeId || 0);
  const s1 = b.start_date;
  const e1 = b.end_date || '9999-12-31';
  for (const o of others) {
    const s2 = o.start_date;
    const e2 = o.end_date || '9999-12-31';
    if (s1 <= e2 && s2 <= e1) {
      return `与合同 ${o.contract_no}（${s2} ~ ${o.end_date || '无固定'}）时间重叠，请先处理旧合同`;
    }
  }
  return null;
}

router.post('/contracts', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const err = validateContract(b, null);
  if (err) return fail(res, 400, err);
  const emp = empBrief(b.employee_id);
  if (!emp) return fail(res, 404, '员工不存在');
  const t = now();
  const r = db.prepare(
    `INSERT INTO labor_contracts (contract_no, employee_id, type, sign_date, start_date, end_date, probation_end,
       delivery_status, delivery_evidence, attachment, renewal_of, status, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(b.contract_no || nextNo('HT', 'labor_contracts', 'contract_no'), emp.id, b.type || 'fixed',
    b.sign_date || null, b.start_date, b.end_date || null, b.probation_end || null,
    b.delivery_status || 'pending', b.delivery_evidence || null, b.attachment || null,
    b.renewal_of || null, 'active', b.remark || null, req.user.username, t, t);
  return ok(res, contractView(db.prepare('SELECT * FROM labor_contracts WHERE id = ?').get(r.lastInsertRowid)));
}));

router.put('/contracts/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM labor_contracts WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '合同不存在');
  const b = req.body || {};
  const merged = {
    employee_id: row.employee_id, type: b.type || row.type,
    start_date: b.start_date || row.start_date,
    end_date: b.end_date !== undefined ? b.end_date : row.end_date,
    probation_end: b.probation_end !== undefined ? b.probation_end : row.probation_end
  };
  const err = validateContract(merged, row.id);
  if (err) return fail(res, 400, err);
  db.prepare(
    `UPDATE labor_contracts SET type=?, sign_date=?, start_date=?, end_date=?, probation_end=?, attachment=?,
       status=?, remark=?, updated_at=? WHERE id=?`
  ).run(merged.type, b.sign_date ?? row.sign_date, merged.start_date, merged.end_date || null,
    merged.probation_end || null, b.attachment ?? row.attachment, b.status || row.status,
    b.remark ?? row.remark, now(), row.id);
  return ok(res, contractView(db.prepare('SELECT * FROM labor_contracts WHERE id = ?').get(row.id)));
}));

/** 登记合同交付证据（员工签收） */
router.post('/contracts/:id/deliver', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM labor_contracts WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '合同不存在');
  const evidence = (req.body && req.body.evidence) || '';
  if (!String(evidence).trim()) return fail(res, 400, '请填写交付证据（签收单号 / 扫描件路径）');
  db.prepare("UPDATE labor_contracts SET delivery_status='delivered', delivery_evidence=?, updated_at=? WHERE id=?")
    .run(String(evidence).trim(), now(), row.id);
  return ok(res, contractView(db.prepare('SELECT * FROM labor_contracts WHERE id = ?').get(row.id)));
}));

/** 续签：生成新合同，旧合同标记已续签 */
router.post('/contracts/:id/renew', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const old = db.prepare('SELECT * FROM labor_contracts WHERE id = ?').get(req.params.id);
  if (!old) return fail(res, 404, '合同不存在');
  if (!['active', 'renewed'].includes(old.status)) return fail(res, 400, '该合同状态不可续签');
  const already = db.prepare('SELECT 1 AS x FROM labor_contracts WHERE renewal_of = ?').get(old.id);
  if (already) return fail(res, 400, '该合同已经续签过，请勿重复操作');

  const b = req.body || {};
  const start = b.start_date || (old.end_date
    ? new Date(new Date(old.end_date).getTime() + 86400000).toISOString().slice(0, 10)
    : today());
  const b2 = {
    employee_id: old.employee_id, type: b.type || old.type,
    start_date: start, end_date: b.end_date || null,
    probation_end: b.probation_end || null
  };
  if (b2.type !== 'open' && !b2.end_date) {
    return fail(res, 400, '续签需填写新合同的结束日期（或选择无固定期限）');
  }
  const err = validateContract(b2, null);
  if (err) return fail(res, 400, err);

  const t = now();
  let newId = null;
  try {
    db.exec('BEGIN');
    const r = db.prepare(
      `INSERT INTO labor_contracts (contract_no, employee_id, type, sign_date, start_date, end_date, probation_end,
         delivery_status, renewal_of, status, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(nextNo('HT', 'labor_contracts', 'contract_no'), old.employee_id, b2.type, b.sign_date || null,
      b2.start_date, b2.end_date, b2.probation_end, 'pending', old.id, 'active',
      b.remark || `续签自 ${old.contract_no}`, req.user.username, t, t);
    newId = Number(r.lastInsertRowid);
    db.prepare("UPDATE labor_contracts SET status='renewed', updated_at=? WHERE id=?").run(t, old.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, contractView(db.prepare('SELECT * FROM labor_contracts WHERE id = ?').get(newId)));
}));

router.post('/contracts/:id/terminate', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM labor_contracts WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '合同不存在');
  db.prepare("UPDATE labor_contracts SET status='terminated', remark=COALESCE(?, remark), updated_at=? WHERE id=?")
    .run((req.body && req.body.reason) || null, now(), row.id);
  return ok(res, contractView(db.prepare('SELECT * FROM labor_contracts WHERE id = ?').get(row.id)));
}));

router.delete('/contracts/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM labor_contracts WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '合同不存在');
  if (db.prepare('SELECT 1 AS x FROM labor_contracts WHERE renewal_of = ?').get(row.id)) {
    return fail(res, 400, '该合同已有续签记录，不能删除');
  }
  db.prepare('DELETE FROM labor_contracts WHERE id = ?').run(row.id);
  return ok(res, { deleted: 1 });
}));

// ============================================================
// N13-11 调薪
// ============================================================
function adjView(r) {
  const emp = empBrief(r.employee_id);
  const diff = round2(Number(r.after_salary) - Number(r.before_salary));
  return {
    ...r,
    type_label: ADJ_TYPE[r.type] || r.type,
    status_label: ADJ_STATUS[r.status] || r.status,
    employee_name: emp ? emp.name : null,
    department_name: emp ? emp.department_name : null,
    current_salary: emp ? Number(emp.base_salary) || 0 : null,
    diff,
    diff_pct: Number(r.before_salary) > 0 ? Math.round((diff / Number(r.before_salary)) * 10000) / 100 : null,
    due: r.status === 'approved' && r.effective_date <= today()
  };
}

router.get('/adjustments', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.status) { cond.push('status = ?'); params.push(req.query.status); }
  if (req.query.employee_id) { cond.push('employee_id = ?'); params.push(Number(req.query.employee_id)); }
  const rows = db.prepare(
    `SELECT * FROM salary_adjustments ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows.map(adjView));
}));

router.post('/adjustments', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.employee_id) return fail(res, 400, '请选择员工');
  const emp = empBrief(b.employee_id);
  if (!emp) return fail(res, 404, '员工不存在');
  if (emp.status !== 'active') return fail(res, 400, '离职员工不能调薪');
  const before = b.before_salary !== undefined && b.before_salary !== null && b.before_salary !== ''
    ? Number(b.before_salary) : Number(emp.base_salary) || 0;
  const after = Number(b.after_salary) || 0;
  if (after <= 0) return fail(res, 400, '调整后工资必须大于 0');
  if (round2(after) === round2(before)) return fail(res, 400, '调整后工资与当前一致，无需调薪');
  if (!b.effective_date) return fail(res, 400, '请填写生效日期');

  const t = now();
  const r = db.prepare(
    `INSERT INTO salary_adjustments (adj_no, employee_id, type, before_salary, after_salary, effective_date,
       reason, status, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(nextNo('TX', 'salary_adjustments', 'adj_no'), emp.id, b.type || 'annual', round2(before), round2(after),
    b.effective_date, b.reason || null, 'draft', b.remark || null, req.user.username, t, t);
  return ok(res, adjView(db.prepare('SELECT * FROM salary_adjustments WHERE id = ?').get(r.lastInsertRowid)));
}));

router.put('/adjustments/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM salary_adjustments WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '调薪记录不存在');
  if (row.status === 'effective') return fail(res, 400, '已生效的调薪不能修改，请新建一条');
  const b = req.body || {};
  const after = b.after_salary !== undefined ? Number(b.after_salary) || 0 : Number(row.after_salary);
  if (after <= 0) return fail(res, 400, '调整后工资必须大于 0');
  db.prepare(
    'UPDATE salary_adjustments SET type=?, before_salary=?, after_salary=?, effective_date=?, reason=?, remark=?, updated_at=? WHERE id=?'
  ).run(b.type || row.type,
    b.before_salary !== undefined ? round2(Number(b.before_salary) || 0) : row.before_salary,
    round2(after), b.effective_date || row.effective_date, b.reason ?? row.reason,
    b.remark ?? row.remark, now(), row.id);
  return ok(res, adjView(db.prepare('SELECT * FROM salary_adjustments WHERE id = ?').get(row.id)));
}));

router.post('/adjustments/:id/approve', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM salary_adjustments WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '调薪记录不存在');
  if (row.status !== 'draft') return fail(res, 400, '只有草稿可以批准');
  db.prepare("UPDATE salary_adjustments SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?")
    .run(req.user.username, now(), now(), row.id);
  return ok(res, adjView(db.prepare('SELECT * FROM salary_adjustments WHERE id = ?').get(row.id)));
}));

/**
 * 调薪生效：回写员工基本工资
 * 生效日未到默认不允许，除非 force
 */
router.post('/adjustments/:id/apply', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM salary_adjustments WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '调薪记录不存在');
  if (row.status === 'effective') return fail(res, 400, '该调薪已生效');
  if (row.status !== 'approved') return fail(res, 400, '请先批准再执行生效');
  const force = !!(req.body && req.body.force);
  if (row.effective_date > today() && !force) {
    return fail(res, 400, `生效日 ${row.effective_date} 未到；如需提前执行请选择「立即生效」`);
  }
  const emp = empBrief(row.employee_id);
  if (!emp) return fail(res, 404, '员工不存在');
  const t = now();
  try {
    db.exec('BEGIN');
    // 以执行时的实际工资作为 before，避免中间还有别的调薪导致前后值错位
    const realBefore = Number(emp.base_salary) || 0;
    db.prepare('UPDATE employees SET base_salary=? WHERE id=?').run(round2(row.after_salary), emp.id);
    db.prepare("UPDATE salary_adjustments SET status='effective', before_salary=?, applied_at=?, updated_at=? WHERE id=?")
      .run(round2(realBefore), t, t, row.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, adjView(db.prepare('SELECT * FROM salary_adjustments WHERE id = ?').get(row.id)));
}));

router.post('/adjustments/:id/cancel', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM salary_adjustments WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '调薪记录不存在');
  if (row.status === 'effective') return fail(res, 400, '已生效的调薪不能取消');
  db.prepare("UPDATE salary_adjustments SET status='cancelled', updated_at=? WHERE id=?").run(now(), row.id);
  return ok(res, adjView(db.prepare('SELECT * FROM salary_adjustments WHERE id = ?').get(row.id)));
}));

module.exports = router;
