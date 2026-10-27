/**
 * 流程超时升级与任务替岗 / 岗位 SOP 与制度知识
 * 原型 TS-N15-04（超时升级与任务替岗）+ TS-N15-02（岗位SOP与制度知识）
 *
 * 硬规则（写在代码里，不靠人记）：
 * 1. **待办可分配但不可失主**：任务永远有当前主责（原审批人 → 有效代理 → 升级接收人）
 * 2. **财务与工艺关键审批不得因超时自动通过**：超时只升级到人，**绝不自动 approve**
 * 3. **代理只按有效授权转交**：`approval_delegates` 未覆盖 → 400，走升级队列而不是静默转人
 * 4. **提醒去重**：同一任务同一级别只提醒一次（dedupe_key 唯一），按风险汇总
 * 5. **保留原责任与历史**：代理/升级都写 original_approver，不清空原审批人
 * 6. **SOP 旧版本可追但不默认用于当前**：只有 effective 版本算「当前」，retired 只读
 * 7. **每版 SOP 必须写全** 做法 / 输入 / 完成标准 / 升级路径，缺一项不许发布
 *
 * 时间口径：一律「本地墙钟字符串」YYYY-MM-DD HH:mm:ss（now() 是 UTC ISO，必须换算，否则差 8 小时）
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const {
  localNow, localDate, toLocal, addHours, hoursBetween, slaHoursOf, computeDue, refreshDue
} = require('../services/sla');

const router = express.Router();
const READ = ['admin', 'boss', 'sales', 'tech', 'finance', 'production', 'warehouse', 'hr'];
const WRITE = ['admin', 'hr'];
const REVIEW = ['admin', 'hr', 'sales', 'finance', 'production'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const LEVEL = { soon: '临近到期', overdue: '已超时', escalate: '已升级' };
const SOP_STATUS = { draft: '草稿', pending: '待批准', effective: '生效', retired: '已废止' };
const SOP_CATEGORY = { sop: '岗位SOP', policy: '制度', rule: '规定' };
const DELEGATE_STATUS = { active: '有效', revoked: '已撤销', expired: '已过期' };

function nextNo(table, col, prefix) {
  let seq = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c) + 1;
  let no = genNo(prefix, seq);
  while (db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${col} = ?`).get(no)) no = genNo(prefix, ++seq);
  return no;
}

/** 该角色下有哪些在职用户 */
function usersOfRole(role) {
  return db.prepare("SELECT id, username, name, role FROM users WHERE role = ? AND active = 1").all(role);
}

/** 某人的有效代理（覆盖该 target_type） */
function activeDelegateOf(username, targetType) {
  const t = localDate();
  const rows = db.prepare("SELECT * FROM approval_delegates WHERE from_user = ? AND status = 'active'").all(username);
  return rows.find((d) => {
    if (d.valid_from && d.valid_from > t) return false;
    if (d.valid_to && d.valid_to < t) return false;
    const types = String(d.target_types || '').split(',').map((x) => x.trim()).filter(Boolean);
    return !types.length || types.includes(targetType);
  }) || null;
}

/** 任务当前主责（代理/升级接收优先，但保留原责任） */
function ownerOf(task, instance) {
  if (task.received_by) return { kind: 'received', who: task.received_by, note: '已接收' };
  if (task.escalated_to) return { kind: 'escalated', who: task.escalated_to, note: '升级接手' };
  if (task.delegate_by) return { kind: 'delegate', who: task.delegate_by, note: '代理审批' };
  const users = usersOfRole(task.role);
  if (users.length) return { kind: 'role', who: users.map((u) => u.username).join(','), note: `${users.length} 人可办` };
  const dg = db.prepare("SELECT * FROM approval_delegates WHERE status='active'").all()
    .find((d) => activeDelegateOf(d.from_user, instance ? instance.target_type : ''));
  void dg;
  return { kind: 'none', who: null, note: '该角色没有在职账号，且无代理 → 进升级队列' };
}

/** 任务视图：带截止、剩余、主责、提醒状态 */
function taskView(t, instance) {
  const inst = instance || db.prepare('SELECT * FROM approval_instances WHERE id = ?').get(t.instance_id);
  const owner = ownerOf(t, inst);
  const c = computeDue(inst, t.step_no);
  const due = t.due_at ? toLocal(t.due_at) : c.due_at;
  const left = hoursBetween(localNow(), due);
  const overdue = t.status === 'pending' && left !== null && left < 0;
  const soon = t.status === 'pending' && left !== null && left >= 0 && left <= 4;
  return {
    id: t.id,
    instance_id: t.instance_id,
    step_no: t.step_no,
    step_name: t.step_name,
    role: t.role,
    status: t.status,
    approver: t.approver,
    acted_at: t.acted_at,
    remark: t.remark,
    target_type: inst ? inst.target_type : null,
    target_id: inst ? inst.target_id : null,
    target_label: inst ? targetLabel(inst.target_type, inst.target_id) : null,
    due_at: due,
    sla_hours: t.sla_hours || c.sla_hours,
    hours_left: left,
    overdue,
    soon,
    level: overdue ? 'overdue' : (soon ? 'soon' : (t.escalate_level || 'normal')),
    owner,
    no_owner: owner.kind === 'none',
    escalate_level: t.escalate_level,
    escalated_to: t.escalated_to,
    escalated_at: t.escalated_at,
    escalate_reason: t.escalate_reason,
    original_approver: t.original_approver,
    delegate_by: t.delegate_by,
    received_by: t.received_by,
    received_at: t.received_at,
    remind_count: t.remind_count || 0,
    last_remind_at: t.last_remind_at,
    escalate_role: c.escalate_role,
    can_auto_approve: false   // 原型死规定：关键审批不因超时自动通过
  };
}

/** 在办任务：只要「当前步」，下一步还没轮到不算待办（否则超时统计会翻倍） */
function pendingTasks() {
  return db.prepare(
    `SELECT t.* FROM approval_tasks t
     JOIN approval_instances i ON i.id = t.instance_id
     WHERE t.status = 'pending' AND i.status = 'pending' AND t.step_no = i.current_step
     ORDER BY t.id`
  ).all();
}

/** 业务对象标签（升级队列要能看懂在等什么） */
function targetLabel(type, id) {
  try {
    if (type === 'cost') {
      const r = db.prepare(
        `SELECT cs.order_id, cs.total_cost, o.order_no, o.style_name FROM cost_sheets cs
         LEFT JOIN orders o ON o.id = cs.order_id WHERE cs.order_id = ?`
      ).get(id);
      if (r && r.order_no) return `成本审核 ${r.order_no} ${r.style_name || ''}（¥${round2(r.total_cost)}）`;
      const o = db.prepare('SELECT order_no, style_name FROM orders WHERE id = ?').get(id);
      return o ? `成本审核 ${o.order_no} ${o.style_name || ''}` : `成本审核 #${id}`;
    }
    if (type === 'order') {
      const r = db.prepare('SELECT order_no, style_name FROM orders WHERE id = ?').get(id);
      return r ? `订单 ${r.order_no} ${r.style_name || ''}` : `订单 #${id}`;
    }
    if (type === 'techpack') {
      const r = db.prepare('SELECT product_name, version FROM tech_packs WHERE id = ?').get(id);
      return r ? `技术资料 ${r.product_name || ''} ${r.version || ''}` : `技术资料 #${id}`;
    }
  } catch (e) { /* ignore */ }
  return `${type} #${id}`;
}

// ============================================================
// 一、总览
// ============================================================
router.get('/board', authRequired, requireRole(READ), wrap(async (req, res) => {
  refreshDue();
  const pend = pendingTasks().map((t) => taskView(t));
  const overdue = pend.filter((t) => t.overdue);
  const soon = pend.filter((t) => t.soon);
  const noOwner = pend.filter((t) => t.no_owner);
  const escalated = pend.filter((t) => t.escalated_to);

  // SOP
  const effectiveDocs = db.prepare("SELECT * FROM sop_documents WHERE status = 'effective'").all();
  const pendingAcks = db.prepare(
    `SELECT a.*, d.title, d.doc_no, d.position, v.version FROM sop_acks a
     JOIN sop_documents d ON d.id = a.doc_id
     LEFT JOIN sop_versions v ON v.doc_id = a.doc_id AND v.version = a.version
     WHERE a.acked_at IS NULL AND d.status = 'effective' ORDER BY a.id DESC LIMIT 100`
  ).all();

  // 提醒历史（最近）
  const reminders = db.prepare('SELECT * FROM approval_reminders ORDER BY id DESC LIMIT 12').all();

  // 代理
  const t = localDate();
  const delegates = db.prepare("SELECT * FROM approval_delegates WHERE status = 'active'").all().map((d) => ({
    ...d,
    status_label: d.valid_to && d.valid_to < t ? '已过期' : '有效',
    effective_status: d.valid_to && d.valid_to < t ? 'expired' : 'active'
  }));

  return ok(res, {
    stat: {
      pending: pend.length,
      overdue: overdue.length,
      soon: soon.length,
      no_owner: noOwner.length,
      escalated: escalated.length,
      delegate_active: delegates.filter((d) => d.effective_status === 'active').length,
      sop_effective: effectiveDocs.length,
      sop_pending_ack: pendingAcks.length
    },
    queue: [...overdue, ...soon, ...noOwner.filter((x) => !x.overdue && !x.soon)]
      .filter((v, i, arr) => arr.findIndex((x) => x.id === v.id) === i)
      .sort((a, b) => (a.hours_left === null ? 1 : a.hours_left) - (b.hours_left === null ? 1 : b.hours_left)),
    escalated,
    no_owner: noOwner,
    reminders,
    delegates,
    sop: {
      effective: effectiveDocs.map((d) => ({
        ...d,
        status_label: SOP_STATUS[d.status] || d.status,
        category_label: SOP_CATEGORY[d.category] || d.category,
        pending_ack: db.prepare('SELECT COUNT(*) c FROM sop_acks WHERE doc_id = ? AND version = ? AND acked_at IS NULL').get(d.id, d.current_version).c,
        ack_total: db.prepare('SELECT COUNT(*) c FROM sop_acks WHERE doc_id = ? AND version = ?').get(d.id, d.current_version).c,
        ack_done: db.prepare('SELECT COUNT(*) c FROM sop_acks WHERE doc_id = ? AND version = ? AND acked_at IS NOT NULL').get(d.id, d.current_version).c
      })),
      pending_acks: pendingAcks
    },
    dict: { level: LEVEL, sop_status: SOP_STATUS, sop_category: SOP_CATEGORY, delegate_status: DELEGATE_STATUS },
    note: '超时只升级到人，不会自动通过审批；财务与工艺等关键节点尤其不自动放行'
  });
}));

// ============================================================
// 二、超时清单与升级
// ============================================================
router.get('/tasks', authRequired, requireRole(READ), wrap(async (req, res) => {
  refreshDue();
  const level = req.query.level || 'all';
  let rows = pendingTasks().map((t) => taskView(t));
  if (level === 'overdue') rows = rows.filter((t) => t.overdue);
  else if (level === 'soon') rows = rows.filter((t) => t.soon);
  else if (level === 'escalated') rows = rows.filter((t) => t.escalated_to);
  else if (level === 'no_owner') rows = rows.filter((t) => t.no_owner);
  return ok(res, {
    rows,
    stat: {
      total: rows.length,
      overdue: rows.filter((t) => t.overdue).length,
      soon: rows.filter((t) => t.soon).length,
      no_owner: rows.filter((t) => t.no_owner).length
    }
  });
}));

/** 发提醒：同一任务同一级别只发一次（去重），按风险汇总不轰炸 */
router.post('/tasks/:id/remind', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '审批任务不存在');
  if (t.status !== 'pending') return fail(res, 400, '该任务已处理，不用再提醒');
  const v = taskView(t);
  const level = v.overdue ? 'overdue' : (v.soon ? 'soon' : 'soon');
  const key = `task:${t.id}:${level}`;
  const exists = db.prepare('SELECT * FROM approval_reminders WHERE dedupe_key = ?').get(key);
  if (exists) {
    return fail(res, 400, `这个任务的「${LEVEL[level]}」提醒已经在 ${toLocal(exists.sent_at)} 发过了（同一级别不重复打扰）`);
  }
  const tNow = now();
  const msg = `${v.target_label || '待办'}：${v.step_name || ''} 已${v.overdue ? `超时 ${Math.abs(v.hours_left)} 小时` : `剩 ${v.hours_left} 小时到期`}`;
  db.prepare(
    'INSERT INTO approval_reminders (task_id, instance_id, level, dedupe_key, to_role, to_user, message, sent_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(t.id, t.instance_id, level, key, t.escalated_to || t.role, v.owner.who || null, msg, tNow);
  db.prepare('UPDATE approval_tasks SET remind_count = COALESCE(remind_count,0) + 1, last_remind_at = ? WHERE id = ?').run(tNow, t.id);
  return ok(res, { task: taskView(db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(t.id)), message: msg, notice: '已发送一次提醒（同级别不再重复）' });
}));

/**
 * 升级：必须写原因，且必须指定接手人/角色
 * —— 注意这里**不会** approve，只是把主责转移，原审批人仍留历史
 */
router.post('/tasks/:id/escalate', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '审批任务不存在');
  if (t.status !== 'pending') return fail(res, 400, '该任务已处理，不能升级');
  const b = req.body || {};
  const toUser = String(b.escalated_to || '').trim();
  const reason = String(b.reason || '').trim();
  if (!toUser) return fail(res, 400, '升级必须指定接手人（不能只喊「超时了」）');
  if (!reason) return fail(res, 400, '升级必须写原因（超时多久、影响什么）');
  if (toUser === t.role) return fail(res, 400, '接收人不能还是原审批角色，否则等于没升级');
  const u = db.prepare('SELECT * FROM users WHERE (username = ? OR name = ?) AND active = 1').get(toUser, toUser);
  if (!u) return fail(res, 404, `接收人「${toUser}」不存在或已停用`);

  const tNow = now();
  const v = taskView(t);
  db.prepare(
    `UPDATE approval_tasks SET escalate_level = 'escalated', escalated_to = ?, escalated_at = ?, escalate_reason = ?,
       original_approver = COALESCE(original_approver, ?), remind_count = COALESCE(remind_count,0) + 1, last_remind_at = ?
     WHERE id = ?`
  ).run(u.username, tNow, `${reason}（原审批：${v.approver || t.role}，已超时 ${v.hours_left !== null && v.hours_left < 0 ? Math.abs(v.hours_left) + ' 小时' : '未超时'}）`,
    t.approver || t.role, tNow, t.id);

  // 升级也要留一条提醒记录，便于追溯「什么时候通知了谁」
  const key = `task:${t.id}:escalate`;
  if (!db.prepare('SELECT 1 AS x FROM approval_reminders WHERE dedupe_key = ?').get(key)) {
    db.prepare('INSERT INTO approval_reminders (task_id, instance_id, level, dedupe_key, to_role, to_user, message, sent_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(t.id, t.instance_id, 'escalate', key, u.role, u.username, `升级给 ${u.name}：${reason}`, tNow);
  }
  return ok(res, {
    task: taskView(db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(t.id)),
    notice: `已升级给 ${u.name}（原审批人 ${t.approver || t.role} 的历史保留）。注意：升级不等于通过，仍需有人审批`
  });
}));

/** 接收：升级后的接手人显式接单（避免「升级了但没人认」） */
router.post('/tasks/:id/receive', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '审批任务不存在');
  if (t.status !== 'pending') return fail(res, 400, '该任务已处理');
  if (!t.escalated_to) return fail(res, 400, '这个任务没有被升级，直接审批即可');
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub) || {};
  const who = me.username || req.user.username;
  if (t.escalated_to !== who && me.role !== 'admin') {
    return fail(res, 403, `这个任务升级给 ${t.escalated_to} 了，只有本人或管理员能接收`);
  }
  const tNow = now();
  db.prepare('UPDATE approval_tasks SET received_by = ?, received_at = ? WHERE id = ?').run(who, tNow, t.id);
  return ok(res, { task: taskView(db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(t.id)), notice: `${who} 已接手，待办不再失主` });
}));

/** 代理转交：必须有有效代理授权，否则 400（进升级队列，而不是随便转人） */
router.post('/tasks/:id/delegate', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '审批任务不存在');
  if (t.status !== 'pending') return fail(res, 400, '该任务已处理');
  const inst = db.prepare('SELECT * FROM approval_instances WHERE id = ?').get(t.instance_id);
  const b = req.body || {};
  const fromUser = String(b.from_user || '').trim();
  const toUser = String(b.to_user || '').trim();
  if (!fromUser || !toUser) return fail(res, 400, '代理转交要写清原审批人和代理人');
  const dg = db.prepare(
    "SELECT * FROM approval_delegates WHERE from_user = ? AND to_user = ? AND status = 'active'"
  ).get(fromUser, toUser);
  if (!dg) {
    return fail(res, 400, `没有「${fromUser} → ${toUser}」的有效代理授权，不能直接转交。请先建代理授权，或走「升级」把任务交出去`);
  }
  const chk = activeDelegateOf(fromUser, inst ? inst.target_type : '');
  if (!chk || chk.to_user !== toUser) {
    return fail(res, 400, `代理授权不覆盖「${inst ? inst.target_type : '该类型'}」或已过期，不能转交`);
  }
  const tNow = now();
  db.prepare(
    'UPDATE approval_tasks SET delegate_by = ?, original_approver = COALESCE(original_approver, ?), last_remind_at = ? WHERE id = ?'
  ).run(toUser, fromUser, tNow, t.id);
  return ok(res, {
    task: taskView(db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(t.id)),
    notice: `已按代理授权转给 ${toUser}，原审批人 ${fromUser} 仍记在历史里`
  });
}));

// ============================================================
// 三、代理授权
// ============================================================
router.get('/delegates', authRequired, requireRole(READ), wrap(async (req, res) => {
  const t = localDate();
  const rows = db.prepare('SELECT * FROM approval_delegates ORDER BY (status = \'active\') DESC, id DESC').all().map((d) => {
    const expired = d.valid_to && d.valid_to < t;
    const eff = d.status === 'revoked' ? 'revoked' : (expired ? 'expired' : 'active');
    return {
      ...d,
      effective_status: eff,
      status_label: DELEGATE_STATUS[eff] || eff,
      active_now: eff === 'active' && (!d.valid_from || d.valid_from <= t)
    };
  });
  return ok(res, { rows, dict: { delegate_status: DELEGATE_STATUS } });
}));

router.post('/delegates', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const from = String(b.from_user || '').trim();
  const to = String(b.to_user || '').trim();
  if (!from || !to) return fail(res, 400, '原审批人与代理人都必填');
  if (from === to) return fail(res, 400, '不能给自己设代理');
  const fu = db.prepare('SELECT * FROM users WHERE username = ? OR name = ?').get(from, from);
  const tu = db.prepare('SELECT * FROM users WHERE (username = ? OR name = ?) AND active = 1').get(to, to);
  if (!fu) return fail(res, 404, `原审批人「${from}」不存在`);
  if (!tu) return fail(res, 404, `代理人「${to}」不存在或已停用`);
  if (!String(b.reason || '').trim()) return fail(res, 400, '设代理必须写原因（休假 / 出差 / 调动）');
  if (b.valid_from && b.valid_to && b.valid_to < b.valid_from) return fail(res, 400, '代理截止日不能早于起始日');
  const exists = db.prepare(
    "SELECT 1 AS x FROM approval_delegates WHERE from_user = ? AND to_user = ? AND status = 'active' AND (valid_to IS NULL OR valid_to >= ?)"
  ).get(fu.username, tu.username, localDate());
  if (exists) return fail(res, 400, '这两人之间已有生效中的代理授权，不用重复设');
  const tNow = now();
  const info = db.prepare(
    `INSERT INTO approval_delegates (from_user, to_user, target_types, valid_from, valid_to, status, reason, created_by, created_at)
     VALUES (?,?,?,?,?, 'active', ?,?,?)`
  ).run(fu.username, tu.username, String(b.target_types || '').trim() || null,
    b.valid_from || localDate(), b.valid_to || null, String(b.reason).trim(), (db.prepare('SELECT username FROM users WHERE id = ?').get(req.user.sub) || {}).username || req.user.username, tNow);
  return ok(res, {
    id: Number(info.lastInsertRowid),
    notice: `${fu.username} 的审批权在 ${b.valid_from || localDate()}${b.valid_to ? ' ~ ' + b.valid_to : ' 起'} 期间转给 ${tu.username}；原责任仍留在记录里`
  });
}));

router.post('/delegates/:id/revoke', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const d = db.prepare('SELECT * FROM approval_delegates WHERE id = ?').get(req.params.id);
  if (!d) return fail(res, 404, '代理授权不存在');
  if (d.status === 'revoked') return fail(res, 400, '这条代理已经撤销了');
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return fail(res, 400, '撤销代理必须写原因');
  db.prepare("UPDATE approval_delegates SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE id = ?").run(now(), reason, d.id);
  // 撤销后已经代理出去的任务要回到升级队列（不能悄悄失主）
  const pending = db.prepare("SELECT * FROM approval_tasks WHERE status = 'pending' AND delegate_by = ?").all(d.to_user);
  let reverted = 0;
  pending.forEach((t) => {
    db.prepare("UPDATE approval_tasks SET delegate_by = NULL, escalate_level = 'escalate', escalate_reason = ? WHERE id = ?")
      .run('代理授权已撤销，任务回到原审批角色或升级队列', t.id);
    reverted++;
  });
  return ok(res, { id: d.id, status: 'revoked', reverted, notice: `代理已撤销${reverted ? `，${reverted} 个在办任务已回到升级队列` : ''}` });
}));

// ============================================================
// 四、时限规则
// ============================================================
router.get('/sla', authRequired, requireRole(READ), wrap(async (req, res) => {
  const flows = db.prepare('SELECT * FROM approval_flows ORDER BY id').all().map((f) => {
    let steps = [];
    try { steps = JSON.parse(f.steps || '[]'); } catch (e) { steps = []; }
    return {
      id: f.id, name: f.name, target_type: f.target_type, active: f.active,
      min_amount: f.min_amount, max_amount: f.max_amount,
      sla_hours: f.sla_hours || 24, escalate_role: f.escalate_role,
      steps: steps.map((s, i) => ({
        step_no: i + 1, role: s.role, name: s.name,
        sla_hours: Number(s.sla_hours) > 0 ? Number(s.sla_hours) : (f.sla_hours || 24),
        escalate_to: s.escalate_to || f.escalate_role || null
      }))
    };
  });
  return ok(res, {
    flows,
    note: '财务与工艺等关键审批节点不设「超时自动通过」；超时只升级到人，必须有人真审批'
  });
}));

router.put('/sla/:flowId', authRequired, requireRole(['admin']), wrap(async (req, res) => {
  const f = db.prepare('SELECT * FROM approval_flows WHERE id = ?').get(req.params.flowId);
  if (!f) return fail(res, 404, '审批流不存在');
  const b = req.body || {};
  let steps = [];
  try { steps = JSON.parse(f.steps || '[]'); } catch (e) { steps = []; }
  if (Array.isArray(b.steps)) {
    steps = b.steps.map((s) => ({
      role: s.role, name: s.name || s.role,
      sla_hours: Number(s.sla_hours) > 0 ? Number(s.sla_hours) : null,
      escalate_to: s.escalate_to || null
    }));
  }
  const flowSla = Number(b.sla_hours) > 0 ? Number(b.sla_hours) : (f.sla_hours || 24);
  if (flowSla > 24 * 30) return fail(res, 400, 'SLA 超过 30 天等于没有时限，请检查');
  db.prepare('UPDATE approval_flows SET sla_hours = ?, escalate_role = ?, steps = ? WHERE id = ?')
    .run(flowSla, b.escalate_role || f.escalate_role || null, JSON.stringify(steps), f.id);
  // 在办任务按新 SLA 重算截止
  refreshDue();
  const pend = db.prepare("SELECT COUNT(*) c FROM approval_tasks WHERE status = 'pending'").get().c;
  return ok(res, { id: f.id, sla_hours: flowSla, steps: steps.length, notice: `已更新；${pend} 个在办任务按新时限重算` });
}));

// ============================================================
// 五、岗位 SOP 与制度
// ============================================================
router.get('/sop', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { status, position, q, category } = req.query;
  const cond = [];
  const params = [];
  if (status) { cond.push('status = ?'); params.push(status); }
  if (position) { cond.push("(position = ? OR position IS NULL OR position = '')"); params.push(position); }
  if (category) { cond.push('category = ?'); params.push(category); }
  if (q) { cond.push('(title LIKE ? OR doc_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT * FROM sop_documents ${cond.length ? 'WHERE ' + cond.join(' AND ') + ' ' : ''} ORDER BY (status = 'effective') DESC, id DESC`
  ).all(...params).map((d) => {
    const v = db.prepare('SELECT * FROM sop_versions WHERE doc_id = ? AND version = ?').get(d.id, d.current_version);
    const ackTotal = d.current_version ? db.prepare('SELECT COUNT(*) c FROM sop_acks WHERE doc_id = ? AND version = ?').get(d.id, d.current_version).c : 0;
    const ackDone = d.current_version ? db.prepare('SELECT COUNT(*) c FROM sop_acks WHERE doc_id = ? AND version = ? AND acked_at IS NOT NULL').get(d.id, d.current_version).c : 0;
    return {
      ...d,
      status_label: SOP_STATUS[d.status] || d.status,
      category_label: SOP_CATEGORY[d.category] || d.category,
      current: v ? { version: v.version, doing: v.doing, done_criteria: v.done_criteria } : null,
      // 只有生效版本才谈签收；废止/草稿显示「-」，避免误读成「还没签」
      ack_total: d.status === 'effective' ? ackTotal : 0,
      ack_done: d.status === 'effective' ? ackDone : 0,
      ack_pending: d.status === 'effective' ? ackTotal - ackDone : 0
    };
  });
  return ok(res, { rows, dict: { sop_status: SOP_STATUS, sop_category: SOP_CATEGORY } });
}));

router.get('/sop/:id', authRequired, requireRole(READ), wrap(async (req, res) => {
  const d = db.prepare('SELECT * FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!d) return fail(res, 404, '制度不存在');
  const versions = db.prepare('SELECT * FROM sop_versions WHERE doc_id = ? ORDER BY version DESC').all(d.id).map((v) => ({
    ...v, status_label: SOP_STATUS[v.status === 'effective' ? 'effective' : v.status === 'retired' ? 'retired' : 'draft']
  }));
  const acks = db.prepare('SELECT * FROM sop_acks WHERE doc_id = ? ORDER BY version DESC, acked_at IS NOT NULL, id').all(d.id);
  const cur = versions.find((v) => v.version === d.current_version) || null;
  return ok(res, {
    ...d,
    status_label: SOP_STATUS[d.status] || d.status,
    category_label: SOP_CATEGORY[d.category] || d.category,
    current_version_detail: cur,
    versions,
    acks,
    ack_stat: {
      total: acks.filter((a) => a.version === d.current_version).length,
      done: acks.filter((a) => a.version === d.current_version && a.acked_at).length
    },
    note: '只有「生效」版本是当前执行依据；已废止版本可查询追溯，但不作为现行做法'
  });
}));

router.post('/sop', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.title || '').trim()) return fail(res, 400, '请填制度/SOP 名称');
  if (!SOP_CATEGORY[b.category || 'sop']) return fail(res, 400, '类别应为 sop / policy / rule');
  if (!String(b.owner || '').trim()) return fail(res, 400, '请填制度责任人（以后谁维护）');
  const tNow = now();
  const info = db.prepare(
    `INSERT INTO sop_documents (doc_no, title, category, company, position, owner, status, current_version, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'draft', 0, ?,?,?,?)`
  ).run(nextNo('sop_documents', 'doc_no', 'SOP'), String(b.title).trim(), b.category || 'sop',
    b.company || null, b.position || null, String(b.owner).trim(), b.remark || null,
    (db.prepare('SELECT username FROM users WHERE id = ?').get(req.user.sub) || {}).username || req.user.username, tNow, tNow);
  return ok(res, { id: Number(info.lastInsertRowid), notice: '已建草稿，接着写 V1 的四要素（做法/输入/完成标准/升级路径）' });
}));

/** 加版本：四要素缺一项不允许提交批准 */
router.post('/sop/:id/versions', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const d = db.prepare('SELECT * FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!d) return fail(res, 404, '制度不存在');
  if (d.status === 'retired') return fail(res, 400, '已废止的制度不能出新版本；要重启请新建一份');
  const b = req.body || {};
  const missing = [];
  if (!String(b.doing || '').trim()) missing.push('做法');
  if (!String(b.inputs || '').trim()) missing.push('输入');
  if (!String(b.done_criteria || '').trim()) missing.push('完成标准');
  if (!String(b.escalate_path || '').trim()) missing.push('升级路径');
  if (missing.length) return fail(res, 400, `制度版本必须写全四要素，缺：${missing.join('、')}（缺项的制度没法照着做）`);
  const ver = Number(d.current_version) + 1 || (db.prepare('SELECT COALESCE(MAX(version),0) v FROM sop_versions WHERE doc_id = ?').get(d.id).v + 1);
  const tNow = now();
  try {
    const info = db.prepare(
      `INSERT INTO sop_versions (doc_id, version, doing, inputs, done_criteria, escalate_path, change_note, status, created_by, created_at)
       VALUES (?,?,?,?,?,?,?, 'draft', ?,?)`
    ).run(d.id, ver, String(b.doing).trim(), String(b.inputs).trim(), String(b.done_criteria).trim(),
      String(b.escalate_path).trim(), b.change_note || `第 ${ver} 版`, (db.prepare('SELECT username FROM users WHERE id = ?').get(req.user.sub) || {}).username || req.user.username, tNow);
    db.prepare("UPDATE sop_documents SET status = 'pending', updated_at = ? WHERE id = ?").run(tNow, d.id);
    return ok(res, { id: Number(info.lastInsertRowid), version: ver, notice: '版本已保存为草稿，提交批准后才生效' });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return fail(res, 400, `V${ver} 已存在，请直接编辑或出新版本`);
    throw e;
  }
}));

/** 发布：批准 → 生效，旧版转 retired，并按岗位生成签收 */
router.post('/sop/:id/publish', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const d = db.prepare('SELECT * FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!d) return fail(res, 404, '制度不存在');
  if (d.status === 'retired') return fail(res, 400, '已废止的制度不能发布');
  const b = req.body || {};
  const ver = Number(b.version) || db.prepare('SELECT COALESCE(MAX(version),0) v FROM sop_versions WHERE doc_id = ?').get(d.id).v;
  const v = db.prepare('SELECT * FROM sop_versions WHERE doc_id = ? AND version = ?').get(d.id, ver);
  if (!v) return fail(res, 404, `V${ver} 不存在`);
  if (!v.doing || !v.inputs || !v.done_criteria || !v.escalate_path) {
    return fail(res, 400, '这一版四要素不齐，不能发布（做法/输入/完成标准/升级路径）');
  }
  const tNow = now();
  const effDate = b.effective_date || localDate();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE sop_versions SET status = 'retired' WHERE doc_id = ? AND version != ? AND status = 'effective'").run(d.id, ver);
    db.prepare("UPDATE sop_versions SET status = 'effective' WHERE id = ?").run(v.id);
    db.prepare(
      `UPDATE sop_documents SET status = 'effective', current_version = ?, effective_date = ?,
         approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`
    ).run(ver, effDate, (db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.sub) || {}).name || req.user.username, tNow, tNow, d.id);
    // 按岗位生成签收（岗位为空 = 全员）
    const emps = d.position
      ? db.prepare("SELECT * FROM employees WHERE status = 'active' AND position = ?").all(d.position)
      : db.prepare("SELECT * FROM employees WHERE status = 'active'").all();
    const insAck = db.prepare(
      'INSERT OR IGNORE INTO sop_acks (doc_id, version, employee_id, employee_name, position, acked_at) VALUES (?,?,?,?,?, NULL)'
    );
    emps.forEach((e) => insAck.run(d.id, ver, e.id, e.name, e.position));
    db.exec('COMMIT');
    return ok(res, {
      id: d.id, version: ver, effective_date: effDate, ack_targets: emps.length,
      notice: `V${ver} 已生效（${effDate}），已生成 ${emps.length} 份岗位签收待办；旧版本转「已废止」，可查不再执行`
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

router.post('/sop/:id/retire', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const d = db.prepare('SELECT * FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!d) return fail(res, 404, '制度不存在');
  if (d.status === 'retired') return fail(res, 400, '已经废止过了');
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return fail(res, 400, '废止制度必须写原因');
  const tNow = now();
  db.prepare("UPDATE sop_documents SET status = 'retired', retired_at = ?, retire_reason = ?, updated_at = ? WHERE id = ?")
    .run(tNow, reason, tNow, d.id);
  db.prepare("UPDATE sop_versions SET status = 'retired' WHERE doc_id = ? AND status = 'effective'").run(d.id);
  return ok(res, { id: d.id, status: 'retired', notice: '已废止：历史版本仍可查，但不再作为现行做法' });
}));

/** 岗位签收 */
router.post('/sop/:id/ack', authRequired, requireRole(READ), wrap(async (req, res) => {
  const d = db.prepare('SELECT * FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!d) return fail(res, 404, '制度不存在');
  if (d.status !== 'effective') return fail(res, 400, '只有生效版本的制度才需要签收');
  const b = req.body || {};
  const empId = Number(b.employee_id);
  if (!empId) return fail(res, 400, '请指定签收人（员工）');
  const ack = db.prepare('SELECT * FROM sop_acks WHERE doc_id = ? AND version = ? AND employee_id = ?').get(d.id, d.current_version, empId);
  if (!ack) return fail(res, 400, '这个员工不在本制度的适用岗位里，不需要签收');
  if (ack.acked_at) return fail(res, 400, `${ack.employee_name} 已经在 ${toLocal(ack.acked_at)} 签收过了`);
  const tNow = now();
  db.prepare('UPDATE sop_acks SET acked_at = ?, note = ? WHERE id = ?').run(tNow, b.note || null, ack.id);
  const left = db.prepare('SELECT COUNT(*) c FROM sop_acks WHERE doc_id = ? AND version = ? AND acked_at IS NULL').get(d.id, d.current_version).c;
  return ok(res, {
    employee: ack.employee_name, version: d.current_version, remaining: left,
    notice: left ? `已签收，还有 ${left} 人待补签` : '已签收，本制度全员签收完成'
  });
}));

// ============================================================
// 六、字典
// ============================================================
router.get('/dict', authRequired, wrap(async (req, res) => {
  return ok(res, {
    level: LEVEL, sop_status: SOP_STATUS, sop_category: SOP_CATEGORY, delegate_status: DELEGATE_STATUS,
    note: '超时只升级到人，不自动通过；旧版制度可追溯但不作为现行做法'
  });
}));

/** 一键扫描（把超时的挑出来，返回给人看，不做任何自动审批） */
router.post('/scan', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const n = refreshDue();
  const pend = pendingTasks().map((t) => taskView(t));
  const overdue = pend.filter((t) => t.overdue);
  const noOwner = pend.filter((t) => t.no_owner);
  return ok(res, {
    scanned: pend.length,
    refreshed: n,
    overdue: overdue.map((t) => ({ id: t.id, target: t.target_label, step: t.step_name, hours_over: Math.abs(t.hours_left), owner: t.owner })),
    no_owner: noOwner.map((t) => ({ id: t.id, target: t.target_label, step: t.step_name, role: t.role })),
    notice: `扫描 ${pend.length} 个在办任务：${overdue.length} 个超时、${noOwner.length} 个无主。系统不会自动通过这些审批`
  });
}));

module.exports = router;
module.exports.taskView = taskView;
module.exports.computeDue = computeDue;
module.exports.refreshDue = refreshDue;
module.exports.addHours = addHours;
module.exports.toLocal = toLocal;
