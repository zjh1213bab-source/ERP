/**
 * 多级审批服务
 * ------------------------------------------------------------
 * `target_type` 目前支持两类：
 *   cost    —— 订单成本单（cost_sheets.order_id）
 *   payment —— 付款申请单（payment_requests.id）
 *
 * 泛化的原因：原来这套代码把 cost 写死在四个地方（建实例、驳回回写、
 * 通过回写、待办查询的 JOIN）。要做付款审批时如果复制一份，
 * 就会出现「成本单能按 SLA 升级、付款单不能」这类悄悄分叉的毛病。
 * 所以改成：**流程表统一按 target_type 匹配，业务回写按 target_type 分发**。
 *
 * 三个不变量：
 *   1. 只有 `pending` 的实例能被动作，且只能动「当前步」
 *   2. 同一 target 在同一时刻只允许一条 pending 实例（重复提交先清旧的）
 *   3. 通过/驳回的**业务回写由调用方提供回调**，审批服务不直接认识业务表
 *      （认识得越多，加一个新单据类型就要改一次这里）
 */
const { db, now } = require('../db');
const { applyDueToTask } = require('./sla');

/** 业务回写：审批结论落到具体单据上 */
const HOOKS = {
  cost: {
    approved(targetId, user, t) {
      db.prepare(
        "UPDATE cost_sheets SET status='approved', reviewed_by=?, reviewed_at=?, review_opinion=?, updated_at=? WHERE order_id=?"
      ).run(user.username, t, '全部通过', t, targetId);
    },
    rejected(targetId, user, t, remark) {
      db.prepare(
        "UPDATE cost_sheets SET status='rejected', reviewed_by=?, reviewed_at=?, review_opinion=?, updated_at=? WHERE order_id=?"
      ).run(user.username, t, remark || null, t, targetId);
    }
  },
  payment: {
    /**
     * 付款单的审批前守卫：**申请人不能自己批自己**
     *
     * 这不是流程洁癖 —— 付款是唯一能把钱搬出公司的动作。
     * 一个账号既能申请又能批，等于没有审批，审计一眼就会挑出来。
     * `admin` 也不例外：老板自己申请、自己批准，事后没人能解释这笔钱。
     */
    guard(targetId, user) {
      const pr = db.prepare('SELECT req_no, created_by FROM payment_requests WHERE id = ?').get(targetId);
      if (!pr) throw new Error('付款申请单不存在');
      if (pr.created_by && pr.created_by === user.username) {
        const e = new Error(
          `「${pr.req_no}」是你自己提交的，不能自己批 —— 付款审批必须由另一个账号完成`
        );
        e.status = 403;
        throw e;
      }
    },
    approved(targetId, user, t) {
      // 审批通过 ≠ 已付款，所以这里只推进到 approved，不碰 payments
      db.prepare(
        "UPDATE payment_requests SET status='approved', decided_at=?, decided_by=?, updated_at=? WHERE id=?"
      ).run(t, user.username, t, targetId);
    },
    rejected(targetId, user, t, remark) {
      // 驳回后退回 draft 而不是直接作废：申请人能改完再提交，不用重开一张
      db.prepare(
        "UPDATE payment_requests SET status='draft', decided_at=?, decided_by=?, updated_at=? WHERE id=? AND status='submitted'"
      ).run(t, user.username, t, targetId);
      if (remark) {
        db.prepare('UPDATE payment_requests SET remark = IFNULL(remark || ? , ?) WHERE id = ?').run(
          `\n[驳回] ${remark}`,
          `[驳回] ${remark}`,
          targetId
        );
      }
    }
  }
};

function matchFlow(targetType, amount) {
  return db
    .prepare(
      `SELECT * FROM approval_flows
        WHERE target_type = ? AND active = 1 AND ? >= min_amount AND ? < max_amount
        ORDER BY min_amount DESC LIMIT 1`
    )
    .get(targetType, amount, amount);
}

/**
 * 为一个业务单据创建审批实例（会先清掉同单据的旧 pending 实例）
 * @returns {number|null} 实例 id；已存在 approved 实例时返回 null
 */
function ensureInstance(targetType, targetId, amount) {
  const approved = db
    .prepare(
      "SELECT 1 AS x FROM approval_instances WHERE target_type=? AND target_id=? AND status='approved' LIMIT 1"
    )
    .get(targetType, targetId);
  if (approved) return null;

  db.prepare(
    "DELETE FROM approval_tasks WHERE instance_id IN (SELECT id FROM approval_instances WHERE target_type=? AND target_id=? AND status='pending')"
  ).run(targetType, targetId);
  db.prepare(
    "DELETE FROM approval_instances WHERE target_type=? AND target_id=? AND status='pending'"
  ).run(targetType, targetId);

  const flow =
    matchFlow(targetType, Number(amount) || 0) ||
    db
      .prepare('SELECT * FROM approval_flows WHERE target_type=? AND active=1 ORDER BY id LIMIT 1')
      .get(targetType);
  const steps = flow
    ? JSON.parse(flow.steps)
    : [{ role: 'finance', name: '财务审核' }];

  const info = db
    .prepare(
      'INSERT INTO approval_instances (target_type, target_id, flow_id, current_step, status, created_at) VALUES (?,?,?,1,?,?)'
    )
    .run(targetType, targetId, flow ? flow.id : null, 'pending', now());
  const iid = Number(info.lastInsertRowid);

  const ins = db.prepare(
    "INSERT INTO approval_tasks (instance_id, step_no, role, step_name, status) VALUES (?,?,?,?,'pending')"
  );
  steps.forEach((s, i) => ins.run(iid, i + 1, s.role, s.name || '第 ' + (i + 1) + ' 级'));

  // 写时限：第 1 步从流程创建时间起算，后续步骤在上一步动作时再补
  db.prepare('SELECT id FROM approval_tasks WHERE instance_id = ? ORDER BY step_no')
    .all(iid)
    .forEach((x) => applyDueToTask(x.id));
  return iid;
}

/** 兼容旧调用 */
function ensureCostInstance(orderId, amount) {
  return ensureInstance('cost', orderId, amount);
}

/**
 * 处理某一级审批
 *
 * 回写业务表时找不到 hook 就**报错**，不静默通过 ——
 * 否则新增一种单据类型时，「审批过了但单据没变」会毫无提示。
 */
function actTask(taskId, approve, remark, user) {
  const task = db.prepare('SELECT * FROM approval_tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error('审批任务不存在');
  if (task.status !== 'pending') throw new Error('该任务已处理');
  const inst = db.prepare('SELECT * FROM approval_instances WHERE id = ?').get(task.instance_id);
  if (!inst || inst.status !== 'pending') throw new Error('审批流程已结束');
  if (task.step_no !== inst.current_step) throw new Error('还没轮到这一级（前面还有未处理的）');

  // 谁能审批：admin / 原角色 / 已被升级给他 / 代理给他 / 已接收
  const isEscalated = task.escalated_to && task.escalated_to === user.username;
  const isDelegate = task.delegate_by && task.delegate_by === user.username;
  const isReceived = task.received_by && task.received_by === user.username;
  if (
    !(
      user.role === 'admin' ||
      user.role === task.role ||
      isEscalated ||
      isDelegate ||
      isReceived
    )
  ) {
    throw new Error('你的角色无权审批该节点（也未升级/代理给你）');
  }

  const hook = HOOKS[inst.target_type];
  if (!hook) throw new Error(`审批类型 ${inst.target_type} 还没接业务回写，拒绝静默通过`);
  // 业务侧守卫（如「申请人不能自己批」）。放在写任务状态之前，
  // 否则任务已被标成 approved、业务侧才拒绝，就成了「批了但没生效」
  if (typeof hook.guard === 'function') hook.guard(inst.target_id, user);

  const t = now();
  if (!approve) {
    db.prepare(
      "UPDATE approval_tasks SET status='rejected', approver=?, remark=?, acted_at=? WHERE id=?"
    ).run(user.username, remark || null, t, taskId);
    db.prepare("UPDATE approval_instances SET status='rejected' WHERE id=?").run(inst.id);
    hook.rejected(inst.target_id, user, t, remark);
    return { instanceStatus: 'rejected', step: task.step_no, targetType: inst.target_type };
  }

  db.prepare(
    "UPDATE approval_tasks SET status='approved', approver=?, remark=?, acted_at=? WHERE id=?"
  ).run(user.username, remark || null, t, taskId);

  const next = db
    .prepare('SELECT * FROM approval_tasks WHERE instance_id=? AND step_no=?')
    .get(inst.id, inst.current_step + 1);
  if (next) {
    db.prepare('UPDATE approval_instances SET current_step=? WHERE id=?').run(
      inst.current_step + 1,
      inst.id
    );
    applyDueToTask(next.id);
    return { instanceStatus: 'pending', step: inst.current_step + 1, targetType: inst.target_type };
  }

  db.prepare("UPDATE approval_instances SET status='approved' WHERE id=?").run(inst.id);
  hook.approved(inst.target_id, user, t);
  return { instanceStatus: 'approved', step: task.step_no, targetType: inst.target_type };
}

/**
 * 当前用户待审批的任务
 *
 * `admin` 看全部（小公司一个人兼多岗，不给看反而没法用）；
 * 其他人只看自己角色那一步。
 */
function myTasks(user) {
  const where = ["t.status='pending'", 't.step_no = i.current_step'];
  const params = [];
  if (user.role !== 'admin') {
    where.push('t.role = ?');
    params.push(user.role);
  }
  const sql = `SELECT t.*, i.target_type, i.target_id, i.current_step, i.status AS instance_status,
      o.order_no, o.style_name, c.name AS customer_name, cs.total_cost, cs.factory_price,
      pr.req_no, pr.supplier_name, pr.amount AS pr_amount, pr.plan_pay_date, pr.reason AS pr_reason,
      pr.status AS pr_status
    FROM approval_tasks t
    JOIN approval_instances i ON i.id = t.instance_id AND i.status = 'pending'
    LEFT JOIN orders o ON o.id = i.target_id AND i.target_type = 'cost'
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN cost_sheets cs ON cs.order_id = i.target_id AND i.target_type = 'cost'
    LEFT JOIN payment_requests pr ON pr.id = i.target_id AND i.target_type = 'payment'
    WHERE ${where.join(' AND ')}
    ORDER BY t.id DESC`;
  return db.prepare(sql).all(...params);
}

/** 某个业务单据的审批进度（给单据详情页展示「走到哪一步了」） */
function progressOf(targetType, targetId) {
  const inst = db
    .prepare(
      'SELECT * FROM approval_instances WHERE target_type=? AND target_id=? ORDER BY id DESC LIMIT 1'
    )
    .get(targetType, targetId);
  if (!inst) return null;
  const tasks = db
    .prepare('SELECT * FROM approval_tasks WHERE instance_id = ? ORDER BY step_no')
    .all(inst.id);
  return { ...inst, tasks, flow: inst.flow_id ? db.prepare('SELECT * FROM approval_flows WHERE id=?').get(inst.flow_id) : null };
}

module.exports = {
  matchFlow,
  ensureInstance,
  ensureCostInstance,
  actTask,
  myTasks,
  progressOf,
  HOOKS
};
