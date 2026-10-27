/**
 * 多级审批服务
 * - ensureCostInstance(orderId, amount)：成本单按金额匹配审批流并生成逐级任务
 * - actTask(taskId, approve, remark, user)：处理某一级审批
 * - myTasks(user)：当前用户待审批的任务（admin 看全部）
 */
const { db, now } = require('../db');
const { applyDueToTask, computeDue } = require('./sla');

function matchFlow(targetType, amount) {
  return db.prepare(
    `SELECT * FROM approval_flows
     WHERE target_type = ? AND active = 1 AND ? >= min_amount AND ? < max_amount
     ORDER BY min_amount DESC LIMIT 1`
  ).get(targetType, amount, amount);
}

function ensureCostInstance(orderId, amount) {
  const approved = db.prepare(
    "SELECT 1 AS x FROM approval_instances WHERE target_type='cost' AND target_id=? AND status='approved' LIMIT 1"
  ).get(orderId);
  if (approved) return null;

  // 清掉旧的未完成实例
  db.prepare(
    "DELETE FROM approval_tasks WHERE instance_id IN (SELECT id FROM approval_instances WHERE target_type='cost' AND target_id=? AND status='pending')"
  ).run(orderId);
  db.prepare(
    "DELETE FROM approval_instances WHERE target_type='cost' AND target_id=? AND status='pending'"
  ).run(orderId);

  const flow = matchFlow('cost', Number(amount) || 0)
    || db.prepare("SELECT * FROM approval_flows WHERE target_type='cost' AND active=1 ORDER BY id LIMIT 1").get();
  const steps = flow ? JSON.parse(flow.steps) : [{ role: 'finance', name: '财务审核' }];

  const info = db.prepare(
    "INSERT INTO approval_instances (target_type, target_id, flow_id, current_step, status, created_at) VALUES ('cost',?,?,1,'pending',?)"
  ).run(orderId, flow ? flow.id : null, now());
  const iid = Number(info.lastInsertRowid);

  const ins = db.prepare(
    "INSERT INTO approval_tasks (instance_id, step_no, role, step_name, status) VALUES (?,?,?,?,'pending')"
  );
  steps.forEach((s, i) => ins.run(iid, i + 1, s.role, s.name || ('第 ' + (i + 1) + ' 级'), ));

  // 写时限：第 1 步从流程创建时间起算，后续步骤在上一步动作时再补
  const created = db.prepare('SELECT id FROM approval_tasks WHERE instance_id = ? ORDER BY step_no').all(iid);
  created.forEach((t) => applyDueToTask(t.id));
  return iid;
}

function actTask(taskId, approve, remark, user) {
  const task = db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error('审批任务不存在');
  if (task.status !== 'pending') throw new Error('该任务已处理');
  const inst = db.prepare('SELECT * FROM approval_instances WHERE id = ?').get(task.instance_id);
  if (!inst || inst.status !== 'pending') throw new Error('审批流程已结束');
  // 谁能审批：admin / 原角色 / 已被升级给他 / 代理给他 / 已接收
  const isEscalated = task.escalated_to && (task.escalated_to === user.username);
  const isDelegate = task.delegate_by && (task.delegate_by === user.username);
  const isReceived = task.received_by && (task.received_by === user.username);
  if (!(user.role === 'admin' || user.role === task.role || isEscalated || isDelegate || isReceived)) {
    throw new Error('你的角色无权审批该节点（也未升级/代理给你）');
  }

  const t = now();
  if (!approve) {
    db.prepare("UPDATE approval_tasks SET status='rejected', approver=?, remark=?, acted_at=? WHERE id=?")
      .run(user.username, remark || null, t, taskId);
    db.prepare("UPDATE approval_instances SET status='rejected' WHERE id=?").run(inst.id);
    if (inst.target_type === 'cost') {
      db.prepare("UPDATE cost_sheets SET status='rejected', reviewed_by=?, reviewed_at=?, review_opinion=?, updated_at=? WHERE order_id=?")
        .run(user.username, t, remark || null, t, inst.target_id);
    }
    return { instanceStatus: 'rejected', step: task.step_no };
  }

  db.prepare("UPDATE approval_tasks SET status='approved', approver=?, remark=?, acted_at=? WHERE id=?")
    .run(user.username, remark || null, t, taskId);

  const next = db.prepare('SELECT * FROM approval_tasks WHERE instance_id=? AND step_no=?').get(inst.id, inst.current_step + 1);
  if (next) {
    db.prepare('UPDATE approval_instances SET current_step=? WHERE id=?').run(inst.current_step + 1, inst.id);
    // 下一步的时限从现在起算（上一步刚动作完）
    applyDueToTask(next.id);
    return { instanceStatus: 'pending', step: inst.current_step + 1 };
  }

  db.prepare("UPDATE approval_instances SET status='approved' WHERE id=?").run(inst.id);
  if (inst.target_type === 'cost') {
    db.prepare("UPDATE cost_sheets SET status='approved', reviewed_by=?, reviewed_at=?, review_opinion=?, updated_at=? WHERE order_id=?")
      .run(user.username, t, remark || '全部通过', t, inst.target_id);
  }
  return { instanceStatus: 'approved', step: task.step_no };
}

function myTasks(user) {
  const where = ["t.status='pending'", 't.step_no = i.current_step'];
  const params = [];
  if (user.role !== 'admin') { where.push('t.role = ?'); params.push(user.role); }
  const sql = `SELECT t.*, i.target_type, i.target_id, i.current_step, i.status AS instance_status,
      o.order_no, o.style_name, c.name AS customer_name, cs.total_cost, cs.factory_price
    FROM approval_tasks t
    JOIN approval_instances i ON i.id = t.instance_id AND i.status = 'pending'
    LEFT JOIN orders o ON o.id = i.target_id AND i.target_type = 'cost'
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN cost_sheets cs ON cs.order_id = i.target_id AND i.target_type = 'cost'
    WHERE ${where.join(' AND ')}
    ORDER BY t.id DESC`;
  return db.prepare(sql).all(...params);
}

module.exports = { matchFlow, ensureCostInstance, actTask, myTasks };
