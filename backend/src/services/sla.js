/**
 * 审批时限（SLA）计算 —— 唯一来源
 * 路由 process.js 与 services/approvals.js 共用，避免两处算法不一致。
 *
 * 时间口径：一律「本地墙钟字符串」YYYY-MM-DD HH:mm:ss
 * now() 是 UTC ISO（带 Z），必须换算成本地墙钟，否则差 8 小时（此前设备停机模块踩过这个坑）。
 */
const { db } = require('../db');

function localNow(d = new Date()) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 19).replace('T', ' ');
}
function localDate(d = new Date()) {
  return localNow(d).slice(0, 10);
}
/** ISO(带Z) / 本地串 → 本地墙钟 */
function toLocal(s) {
  if (!s) return null;
  const raw = String(s).trim();
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return localNow(d);
  }
  return raw.replace('T', ' ').slice(0, 19);
}
function addHours(localStr, h) {
  if (!localStr) return null;
  const base = new Date(String(localStr).replace(' ', 'T'));
  if (Number.isNaN(base.getTime())) return null;
  base.setTime(base.getTime() + Number(h || 0) * 3600000);
  return localNow(base);
}
function hoursBetween(a, b) {
  if (!a || !b) return null;
  const x = new Date(String(a).replace(' ', 'T'));
  const y = new Date(String(b).replace(' ', 'T'));
  if (Number.isNaN(x.getTime()) || Number.isNaN(y.getTime())) return null;
  return Math.round(((y - x) / 3600000) * 10) / 10;
}

/** 某流程某步的时限（小时）：步骤自带 > 流程默认 > 24 */
function slaHoursOf(flow, step) {
  if (step && Number(step.sla_hours) > 0) return Number(step.sla_hours);
  if (flow && Number(flow.sla_hours) > 0) return Number(flow.sla_hours);
  return 24;
}

function flowOf(flowId) {
  return flowId ? db.prepare('SELECT * FROM approval_flows WHERE id = ?').get(flowId) : null;
}

function stepsOf(flow) {
  try { return JSON.parse((flow && flow.steps) || '[]'); } catch (e) { return []; }
}

/**
 * 算某步的截止时间：上一步动作时间（或流程创建时间）+ SLA
 * @returns {{due_at, sla_hours, escalate_role, step}}
 */
function computeDue(instance, stepNo) {
  const flow = flowOf(instance && instance.flow_id);
  const steps = stepsOf(flow);
  const step = steps[stepNo - 1] || {};
  const sla = slaHoursOf(flow, step);
  let base = toLocal(instance.created_at);
  if (stepNo > 1) {
    const prev = db.prepare('SELECT * FROM approval_tasks WHERE instance_id = ? AND step_no = ?').get(instance.id, stepNo - 1);
    if (prev && prev.acted_at) base = toLocal(prev.acted_at);
  }
  return {
    due_at: addHours(base, sla),
    sla_hours: sla,
    escalate_role: step.escalate_to || (flow && flow.escalate_role) || null,
    step
  };
}

/** 给单个任务写时限（幂等） */
function applyDueToTask(taskId) {
  const t = db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(taskId);
  if (!t) return null;
  const inst = db.prepare('SELECT * FROM approval_instances WHERE id = ?').get(t.instance_id);
  if (!inst) return null;
  const c = computeDue(inst, t.step_no);
  if (c.due_at) {
    db.prepare('UPDATE approval_tasks SET due_at = COALESCE(due_at, ?), sla_hours = COALESCE(sla_hours, ?) WHERE id = ?')
      .run(c.due_at, c.sla_hours, t.id);
  }
  return c;
}

/** 回填所有未结任务的时限 */
function refreshDue() {
  const pend = db.prepare("SELECT * FROM approval_tasks WHERE status = 'pending'").all();
  const upd = db.prepare('UPDATE approval_tasks SET due_at = ?, sla_hours = ? WHERE id = ?');
  pend.forEach((t) => {
    const inst = db.prepare('SELECT * FROM approval_instances WHERE id = ?').get(t.instance_id);
    if (!inst) return;
    const c = computeDue(inst, t.step_no);
    if (c.due_at) upd.run(c.due_at, c.sla_hours, t.id);
  });
  return pend.length;
}

module.exports = { localNow, localDate, toLocal, addHours, hoursBetween, slaHoursOf, flowOf, stepsOf, computeDue, applyDueToTask, refreshDue };
