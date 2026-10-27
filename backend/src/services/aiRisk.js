/**
 * 全岗位任务风险预测与提前预警（M17 N17-07）
 *
 * 覆盖销售、技术、财务、采购、生产、质量、仓库、美仓、客服、行政、人事、管理各岗位。
 * 做法：把「有明确时限的业务对象」全部扫一遍，算分、说明原因、指到人。
 *
 * 三条原则：
 *   1. **只预警不执行**：风险清单给建议动作，绝不自动改单、自动批准或自动催人
 *   2. **必须可解释**：每条风险都要带 reasons（为什么算风险）+ 建议动作
 *   3. **无主也要报**：待办挂在一个没有任何在职账号的角色上，是最危险的情况，
 *      要单独标出来，否则活儿就一直悬着没人管
 */
const { db } = require('../db');
const { localNow, hoursBetween, toLocal } = require('./sla');

const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

const ROLE_CN = {
  admin: '管理员', sales: '销售', tech: '技术', finance: '财务',
  production: '生产', warehouse: '仓库', qc: '质检', hr: '人事', pmc: '计划'
};
const roleCn = (r) => ROLE_CN[r] || r || '未指定';

/** 角色对应的在职账号（用来判断「无主」并指到人） */
function roleOwners() {
  const rows = db.prepare('SELECT username, name, role FROM users WHERE active IS NULL OR active=1').all();
  const map = {};
  rows.forEach((u) => {
    (map[u.role] = map[u.role] || []).push(u.name || u.username);
  });
  return map;
}

function levelOf(score) {
  if (score >= 70) return 'high';
  if (score >= 50) return 'mid';
  return 'low';
}

/** 1. 待办与审批超时 */
function scanApprovals(now, today, owners) {
  const out = [];
  // 注意：approval_instances 没有 biz_no/flow_name，target_type='cost' 时 target_id 是 order_id，
  // 单号要从 orders 取；流名从 approval_flows 取。
  const rows = db.prepare(
    `SELECT t.*, i.target_type, i.target_id, f.name AS flow_name,
       o.order_no, o.style_name, c.name AS customer_name, cs.total_cost
     FROM approval_tasks t
     JOIN approval_instances i ON i.id=t.instance_id
     LEFT JOIN approval_flows f ON f.id=i.flow_id
     LEFT JOIN orders o ON o.id=i.target_id AND i.target_type='cost'
     LEFT JOIN customers c ON c.id=o.customer_id
     LEFT JOIN cost_sheets cs ON cs.order_id=o.id
     WHERE t.status='pending'`
  ).all();
  rows.forEach((t) => {
    const reasons = [];
    let score = 30;
    let hoursLeft = null;

    if (t.due_at) {
      hoursLeft = r1(hoursBetween(now, t.due_at));
      if (hoursLeft < 0) {
        const over = Math.abs(hoursLeft);
        score = over > 48 ? 92 : over > 24 ? 82 : 72;
        reasons.push(`已超时 ${Math.round(over)} 小时（时限 ${t.due_at}）`);
      } else if (hoursLeft <= 8) {
        score = 62; reasons.push(`还剩 ${Math.round(hoursLeft)} 小时到期，即将超时`);
      } else if (hoursLeft <= 24) {
        score = 50; reasons.push(`还剩 ${Math.round(hoursLeft)} 小时到期`);
      } else {
        score = 32;
      }
    } else {
      reasons.push('没有设置时限，容易一直拖着');
      score = 45;
    }

    const holders = owners[t.role] || [];
    if (!holders.length) {
      score = Math.min(100, score + 8);
      reasons.push(`待办挂在「${roleCn(t.role)}」角色上，但该角色没有在职账号 —— 没人会看到这条`);
    }
    if (t.remind_count > 0) reasons.push(`已提醒 ${t.remind_count} 次仍未处理`);
    if (Number(t.escalate_level) > 0) reasons.push(`已升级至第 ${t.escalate_level} 级`);

    out.push({
      entity_type: 'approval',
      entity_id: t.id,
      entity_no: t.order_no ? `${t.order_no}·成本单` : `待办#${t.id}`,
      score,
      reasons,
      owner: holders.length ? holders.join('/') : `角色：${roleCn(t.role)}（无在职账号）`,
      role: t.role,
      due_at: t.due_at,
      hours_left: hoursLeft,
      next_action: holders.length
        ? `请 ${holders[0]} 在「审批中心 → 待我审批」处理「${t.step_name || ''}」`
        : `给「${roleCn(t.role)}」安排在职账号，或把这条待办转给现有的人`
    });
  });
  return out;
}

/** 2. 订单交期风险 */
function scanOrders(now, today) {
  const out = [];
  const rows = db.prepare(
    `SELECT o.*, c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
     WHERE o.status NOT IN ('shipped','closed','cancelled') AND o.delivery_date IS NOT NULL`
  ).all();
  rows.forEach((o) => {
    const left = Math.round(hoursBetween(now, o.delivery_date + ' 18:00:00') / 24);
    const reasons = [];
    let score = 0;
    if (left < 0) {
      score = 90; reasons.push(`交期已过 ${Math.abs(left)} 天，当前状态「${o.status}」`);
    } else if (left <= 3) {
      score = 80; reasons.push(`距交期只剩 ${left} 天`);
    } else if (left <= 7) {
      score = 68; reasons.push(`距交期 ${left} 天`);
    } else if (left <= 14) {
      score = 52; reasons.push(`距交期 ${left} 天`);
    } else return;

    // 还没到投产的，风险再加一档
    if (['draft', 'tech', 'finance'].includes(o.status)) {
      score = Math.min(100, score + 10);
      reasons.push(`仍在「${o.status === 'draft' ? '草稿' : o.status === 'tech' ? '技术确认' : '财务审核'}」环节，尚未投产`);
    }
    if (o.status === 'instock') reasons.push('已入库待发货，注意订舱与美仓到仓时间');
    out.push({
      entity_type: 'order',
      entity_id: o.id,
      entity_no: o.order_no,
      score,
      reasons,
      owner: o.manager || roleCn('sales'),
      role: 'sales',
      due_at: o.delivery_date,
      hours_left: r1(hoursBetween(now, o.delivery_date + ' 18:00:00')),
      next_action: `在「订单管理」核对进度；必要时提前与客户沟通交期变更（需客户确认）`
    });
  });
  return out;
}

/** 3. 工序延期（在产订单的关键工序过了计划日还没完成） */
function scanNodes(now, today) {
  const out = [];
  const rows = db.prepare(
    `SELECT n.*, o.order_no FROM order_nodes n JOIN orders o ON o.id=n.order_id
     WHERE n.status='pending' AND n.plan_date IS NOT NULL AND n.plan_date < ?`
  ).all(today);
  rows.forEach((n) => {
    const days = Math.max(0, Math.round(hoursBetween(now, n.plan_date + ' 18:00:00') / 24));
    out.push({
      entity_type: 'order_node',
      entity_id: n.id,
      entity_no: `${n.order_no} / ${n.name}`,
      score: days > 5 ? 78 : days > 2 ? 66 : 56,
      reasons: [`工序「${n.name}」计划 ${n.plan_date} 完成，已过 ${Math.abs(days)} 天仍未完成`],
      owner: n.operator || roleCn('production'),
      role: 'production',
      due_at: n.plan_date,
      hours_left: r1(hoursBetween(now, n.plan_date + ' 18:00:00')),
      next_action: '在「生产看板」确认实际进度并报工；确实卡住请说明原因'
    });
  });
  return out;
}

/** 4. 原料到货延迟 */
function scanPurchases(now, today) {
  const out = [];
  const rows = db.prepare(
    `SELECT p.*, COALESCE(s.name,p.supplier) AS supplier_name FROM purchase_orders p
     LEFT JOIN suppliers s ON s.id=p.supplier_id
     WHERE p.expect_date IS NOT NULL AND p.expect_date < ?
       AND p.status NOT IN ('received','closed','cancelled')`
  ).all(today);
  rows.forEach((p) => {
    const days = Math.max(0, Math.round(hoursBetween(now, p.expect_date + ' 18:00:00') / 24));
    out.push({
      entity_type: 'purchase',
      entity_id: p.id,
      entity_no: p.po_no,
      score: days > 7 ? 82 : days > 3 ? 70 : 58,
      reasons: [`预计到货 ${p.expect_date}，已过 ${Math.abs(days)} 天仍未收货（${p.supplier_name || '未指定供应商'}）`],
      owner: p.created_by || roleCn('pmc'),
      role: 'pmc',
      due_at: p.expect_date,
      hours_left: r1(hoursBetween(now, p.expect_date + ' 18:00:00')),
      next_action: '在「采购管理」跟进交期；影响投产时同步给生产与业务'
    });
  });
  return out;
}

/** 5. 质检未完成 */
function scanQc(now, today) {
  const out = [];
  const rows = db.prepare(
    `SELECT b.*, o.order_no FROM qc_batches b LEFT JOIN orders o ON o.id=b.order_id
     WHERE b.status NOT IN ('checked','closed','passed')`
  ).all();
  rows.forEach((b) => {
    const days = b.production_date ? Math.round(hoursBetween(now, b.production_date + ' 18:00:00') / 24) : null;
    const late = days !== null && days < -3;
    out.push({
      entity_type: 'qc',
      entity_id: b.id,
      entity_no: b.batch_no,
      score: late ? 64 : 52,
      reasons: [late ? `批次 ${b.production_date} 生产，已过 ${Math.abs(days)} 天仍未检验` : '批次尚未完成检验'],
      owner: roleCn('qc'),
      role: 'qc',
      due_at: b.production_date,
      hours_left: days === null ? null : r1(hoursBetween(now, b.production_date + ' 18:00:00')),
      next_action: '在「质量检验」完成批次检验；判定必须由质检本人现场确认'
    });
  });
  return out;
}

/** 6. 应收逾期 */
function scanReceivables(now, today) {
  const out = [];
  const rows = db.prepare(
    `SELECT a.*, c.name AS customer_name FROM ar_invoices a LEFT JOIN customers c ON c.id=a.customer_id
     WHERE a.status IN ('open','partial') AND a.due_date IS NOT NULL AND a.due_date < ?`
  ).all(today);
  rows.forEach((a) => {
    const days = Math.max(0, Math.round(hoursBetween(now, a.due_date + ' 18:00:00') / 24));
    const unpaid = r1(Number(a.amount) - Number(a.paid_amount));
    out.push({
      entity_type: 'receivable',
      entity_id: a.id,
      entity_no: a.bill_no,
      score: days > 30 ? 76 : days > 10 ? 64 : 54,
      reasons: [`应收 ${a.bill_no} 超期 ${Math.abs(days)} 天，未收 ${unpaid}`],
      owner: roleCn('finance'),
      role: 'finance',
      due_at: a.due_date,
      hours_left: r1(hoursBetween(now, a.due_date + ' 18:00:00')),
      next_action: '在「往来账」发起催收；客户有争议时登记争议说明，不要静默挂着'
    });
  });
  return out;
}

/** 7. 邮件待办超期 */
function scanMails(now) {
  const out = [];
  const rows = db.prepare(
    `SELECT * FROM mail_messages
     WHERE status NOT IN ('closed','archived','done') AND task_due IS NOT NULL`
  ).all();
  rows.forEach((m) => {
    const left = r1(hoursBetween(now, toLocal(m.task_due)));
    if (left > 0 && left > 24) return;
    out.push({
      entity_type: 'mail',
      entity_id: m.id,
      entity_no: m.message_no,
      score: left < 0 ? 70 : 54,
      reasons: [left < 0 ? `邮件待办已超期 ${Math.round(Math.abs(left))} 小时` : `邮件待办还剩 ${Math.round(left)} 小时到期`],
      owner: m.sender_name || roleCn('admin'),
      role: 'admin',
      due_at: m.task_due,
      hours_left: left,
      next_action: '在「内部邮件 → 需办理」处理并回执'
    });
  });
  return out;
}

/** 8. 数据质量严重问题 */
function scanDq() {
  const out = [];
  const rows = db.prepare(
    "SELECT * FROM dq_issues WHERE status='open' AND severity='error' LIMIT 30"
  ).all();
  rows.forEach((d) => {
    out.push({
      entity_type: 'dq_issue',
      entity_id: d.id,
      entity_no: d.entity_no || d.rule_code,
      score: 48,
      reasons: [`勾稽严重问题：${d.message || d.rule_name}`],
      owner: roleCn('finance'),
      role: 'finance',
      due_at: null,
      hours_left: null,
      next_action: d.fixable
        ? '在「数据质量与勾稽」点自动修复（只重算，不改认定）'
        : '到「数据质量与勾稽」核对单据后人工更正'
    });
  });
  return out;
}

/** 跑一次全量扫描，写入 ai_risks 快照 */
function run(operator) {
  const now = localNow();
  const today = now.slice(0, 10);
  const owners = roleOwners();

  let list = [];
  const scanners = [scanApprovals, scanOrders, scanNodes, scanPurchases, scanQc, scanReceivables, scanMails];
  const errs = [];
  scanners.forEach((fn) => {
    try {
      list = list.concat(fn(now, today, owners) || []);
    } catch (e) {
      errs.push(`${fn.name}: ${e.message}`);
    }
  });
  try { list = list.concat(scanDq() || []); } catch (e) { errs.push('scanDq: ' + e.message); }

  // 序号
  const n = db.prepare("SELECT COUNT(*) c FROM ai_risks WHERE run_id LIKE 'RSK%'").get().c;
  const runId = 'RSK' + today.replace(/-/g, '') + String((n % 10000) + 1).padStart(4, '0');

  // 只保留有意义的（分数 >= 30）
  list = list.filter((x) => x.score >= 30).sort((a, b) => b.score - a.score);

  const ins = db.prepare(
    `INSERT INTO ai_risks (run_id,scope,entity_type,entity_id,entity_no,level,score,reasons,next_action,
       owner,role,due_at,hours_left,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?)`
  );
  db.exec('BEGIN');
  try {
    list.forEach((x) => {
      ins.run(runId, 'all', x.entity_type, x.entity_id, x.entity_no, levelOf(x.score), x.score,
        JSON.stringify(x.reasons || []), x.next_action, x.owner, x.role, x.due_at, x.hours_left, localNow());
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const stat = { high: 0, mid: 0, low: 0 };
  list.forEach((x) => { stat[levelOf(x.score)] += 1; });
  return {
    run_id: runId,
    total: list.length,
    ...stat,
    by_role: Object.entries(
      list.reduce((a, x) => { a[x.role] = (a[x.role] || 0) + 1; return a; }, {})
    ).map(([role, c]) => ({ role, role_label: roleCn(role), count: c })).sort((a, b) => b.count - a.count),
    by_type: Object.entries(
      list.reduce((a, x) => { a[x.entity_type] = (a[x.entity_type] || 0) + 1; return a; }, {})
    ).map(([t, c]) => ({ type: t, count: c })),
    unowned: list.filter((x) => String(x.owner || '').includes('无在职账号')).length,
    operator: operator || 'system',
    errors: errs
  };
}

/** 最新一批风险 */
function latest(filter = {}) {
  const last = db.prepare('SELECT run_id FROM ai_risks ORDER BY id DESC LIMIT 1').get();
  if (!last) return { run_id: null, rows: [], stat: {} };
  const where = ['run_id=?'];
  const params = [last.run_id];
  if (filter.level) { where.push('level=?'); params.push(filter.level); }
  if (filter.role) { where.push('role=?'); params.push(filter.role); }
  if (filter.status) { where.push('status=?'); params.push(filter.status); }
  const rows = db.prepare(
    `SELECT * FROM ai_risks WHERE ${where.join(' AND ')} ORDER BY score DESC, id ASC`
  ).all(...params).map((r) => ({
    ...r,
    reasons: safeJson(r.reasons, []),
    level_label: { high: '高', mid: '中', low: '低' }[r.level] || r.level,
    role_label: roleCn(r.role),
    type_label: {
      approval: '待办审批', order: '订单交期', order_node: '工序延期', purchase: '原料到货',
      qc: '质量检验', receivable: '应收逾期', mail: '邮件待办', dq_issue: '数据异常'
    }[r.entity_type] || r.entity_type
  }));
  const stat = { high: 0, mid: 0, low: 0 };
  rows.forEach((r) => { stat[r.level] = (stat[r.level] || 0) + 1; });
  return { run_id: last.run_id, rows, stat, total: rows.length };
}

function safeJson(s, dflt) {
  try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; }
}

module.exports = { run, latest, roleOwners, roleCn, levelOf };
