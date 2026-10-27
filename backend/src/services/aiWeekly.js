/**
 * 周报、绩效解释与整改建议（M17 N17-08）
 *
 * 每人一份，结构固定 7 段：
 *   已完成 / 未完成 / 即将逾期 / 被谁阻塞 / 已确认扣分 / 待复核建议 / 下周整改建议
 * 每条都带可跳转的原单据（order_no / node / bill_no / task id），不是空话。
 *
 * 三条约束：
 *   1. **本人可见自己的，管理员可见全部**；不能拿这份周报去看同事的扣分
 *   2. **扣分只展示「已确认」的**，AI 建议分不写进周报正文，单列在「待复核建议」
 *   3. **建议只给做法，不给评价**：不写「你态度有问题」，只写「这周 3 张单卡在技术确认，建议先跟李工确认排期」
 */
const { db } = require('../db');
const { localNow } = require('./sla');

const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const pad = (n) => String(n).padStart(2, '0');

/** 求某天所在周（周一 ~ 周日） */
function weekOf(dateStr) {
  const d = new Date(String(dateStr || localNow().slice(0, 10)) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return weekOf(localNow().slice(0, 10));
  const day = (d.getDay() + 6) % 7; // 周一=0
  const mon = new Date(d);
  mon.setDate(d.getDate() - day);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  // ISO 周号
  const tmp = new Date(mon);
  tmp.setDate(mon.getDate() + 3); // 周四决定年份
  const year = tmp.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week = 1 + Math.round(((tmp - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  const iso = (dd) => `${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`;
  return { week_no: `${year}-W${pad(week)}`, from: iso(mon), to: iso(sun) };
}

/** 人员池：在职员工 + 启用账号（按姓名去重，账号优先） */
function persons() {
  const emps = db.prepare("SELECT * FROM employees WHERE status='active'").all();
  const users = db.prepare('SELECT * FROM users WHERE active IS NULL OR active=1').all();
  const map = new Map();
  users.forEach((u) => {
    map.set(u.name || u.username, {
      name: u.name || u.username, role: u.role, dept_id: u.department_id,
      employee_id: null, user_id: u.id, username: u.username, kind: 'user'
    });
  });
  emps.forEach((e) => {
    const key = e.name;
    if (map.has(key)) {
      map.get(key).employee_id = e.id;
      map.get(key).position = e.position;
      if (!map.get(key).dept_id) map.get(key).dept_id = e.department_id;
    } else {
      map.set(key, {
        name: e.name, role: 'production', dept_id: e.department_id,
        employee_id: e.id, user_id: null, username: null, position: e.position, kind: 'employee'
      });
    }
  });
  return [...map.values()];
}

const ROLE_CN = {
  admin: '管理员', sales: '销售', tech: '技术', finance: '财务',
  production: '生产', warehouse: '仓库', qc: '质检', hr: '人事', pmc: '计划'
};

/** 单人单周 */
function buildPersonWeek(p, from, to) {
  const inWeek = (s) => {
    const d = String(s || '').slice(0, 10);
    return d >= from && d <= to;
  };

  // ---- 已完成 ----
  const done = [];
  if (p.employee_id) {
    const reps = db.prepare(
      `SELECT r.*, o.order_no FROM production_reports r LEFT JOIN orders o ON o.id=r.order_id
       WHERE r.employee_id=? AND r.report_date BETWEEN ? AND ? ORDER BY r.report_date DESC`
    ).all(p.employee_id, from, to);
    if (reps.length) {
      const ok = reps.reduce((a, r) => a + Number(r.qty_ok || 0), 0);
      const bad = reps.reduce((a, r) => a + Number(r.qty_defect || 0), 0);
      const hrs = reps.reduce((a, r) => a + Number(r.hours || 0), 0);
      done.push({
        type: 'report', n: reps.length, label: `报工 ${reps.length} 次`,
        detail: `合格 ${ok} 件 / 不良 ${bad} 件 / 工时 ${r1(hrs)} 小时`,
        refs: [...new Set(reps.map((r) => r.order_no).filter(Boolean))].slice(0, 5),
        to: '/production'
      });
    }
  }
  const nodes = db.prepare(
    `SELECT n.*, o.order_no FROM order_nodes n JOIN orders o ON o.id=n.order_id
     WHERE n.operator=? AND n.status='done' AND n.actual_date BETWEEN ? AND ?`
  ).all(p.name, from, to);
  if (nodes.length) {
    done.push({
      type: 'node', n: nodes.length, label: `完成工序 ${nodes.length} 道`,
      detail: [...new Set(nodes.map((n) => n.name))].slice(0, 6).join('、'),
      refs: [...new Set(nodes.map((n) => n.order_no))].slice(0, 5),
      to: '/production'
    });
  }
  const approvals = db.prepare(
    `SELECT t.*, o.order_no AS biz_no FROM approval_tasks t
     LEFT JOIN approval_instances i ON i.id=t.instance_id
     LEFT JOIN orders o ON o.id=i.target_id AND i.target_type='cost'
     WHERE (t.approver=? OR t.escalated_to=?) AND t.status IN ('approved','rejected')
       AND substr(t.acted_at,1,10) BETWEEN ? AND ?`
  ).all(p.username || p.name, p.username || p.name, from, to);
  if (approvals.length) {
    done.push({
      type: 'approval', n: approvals.length, label: `处理审批 ${approvals.length} 条`,
      detail: approvals.slice(0, 4).map((a) => `${a.step_name}·${a.biz_no || '#' + a.id}`).join('；'),
      refs: approvals.map((a) => a.biz_no).filter(Boolean).slice(0, 5),
      to: '/approvals'
    });
  }
  const acted = db.prepare(
    `SELECT l.*, o.order_no FROM order_logs l JOIN orders o ON o.id=l.order_id
     WHERE l.operator=? AND substr(l.created_at,1,10) BETWEEN ? AND ?`
  ).all(p.username || p.name, from, to);
  if (acted.length) {
    done.push({
      type: 'order', n: acted.length, label: `推进订单 ${acted.length} 次`,
      detail: [...new Set(acted.map((a) => a.to_status))].join(' → '),
      refs: [...new Set(acted.map((a) => a.order_no))].slice(0, 5),
      to: '/orders'
    });
  }

  // ---- 未完成（岗位待办，按角色归属） ----
  const open = [];
  const myTasks = db.prepare(
    `SELECT t.*, o.order_no AS biz_no FROM approval_tasks t
     LEFT JOIN approval_instances i ON i.id=t.instance_id
     LEFT JOIN orders o ON o.id=i.target_id AND i.target_type='cost'
     WHERE t.status='pending' AND (t.role=? OR t.approver=? OR t.received_by=?)`
  ).all(p.role, p.username || p.name, p.username || p.name);
  myTasks.forEach((t) => {
    open.push({
      type: 'approval', label: `${t.step_name || '待办'}（${t.biz_no || '#' + t.id}）`,
      due_at: t.due_at, ref: t.biz_no || '#' + t.id, to: '/approvals'
    });
  });

  // ---- 即将逾期 / 已逾期（复用风险快照，按 owner 匹配） ----
  const lastRun = db.prepare('SELECT run_id FROM ai_risks ORDER BY id DESC LIMIT 1').get();
  let overdue = [];
  if (lastRun) {
    overdue = db.prepare(
      "SELECT * FROM ai_risks WHERE run_id=? AND status='open' AND hours_left IS NOT NULL AND hours_left < 24 ORDER BY hours_left ASC"
    ).all(lastRun.run_id).filter((r) => String(r.owner || '').includes(p.name) || r.role === p.role);
  }

  // ---- 被谁阻塞 ----
  const blocked = [];
  const myOrders = db.prepare(
    `SELECT o.* FROM orders o WHERE o.manager=? AND o.status NOT IN ('shipped','closed','cancelled')`
  ).all(p.name);
  myOrders.forEach((o) => {
    const where = {
      draft: '还在草稿，等业务补完资料',
      tech: '等技术确认开发单',
      finance: '等财务核价',
      assigned: '等分单/开工',
      production: '在生产中',
      instock: '等发货（订舱/美仓收货）'
    }[o.status];
    if (o.status === 'tech' || o.status === 'finance' || o.status === 'draft') {
      blocked.push({
        type: 'order', label: `订单 ${o.order_no} 卡在「${where}」`,
        by: o.status === 'tech' ? '技术' : o.status === 'finance' ? '财务' : '业务自身',
        to: '/orders', ref: o.order_no
      });
    }
  });

  // ---- 已确认扣分 / 待复核建议 ----
  const penalty = [];
  const pendingReview = [];
  if (p.employee_id) {
    const items = db.prepare(
      `SELECT i.*, s.cycle_no FROM kpi_items i LEFT JOIN kpi_scores s ON s.cycle_id=i.cycle_id
        AND s.employee_id=i.employee_id
       WHERE i.employee_id=? ORDER BY i.id DESC LIMIT 40`
    ).all(p.employee_id);
    items.forEach((it) => {
      const confirmed = Number(it.confirmed_score || 0);
      if (confirmed > 0 && it.appeal_status !== 'pending') {
        penalty.push({
          rule: it.rule_name || it.rule_code, score: confirmed,
          desc: it.task_desc || it.node_name || '',
          ref: it.order_no || '', cycle: it.cycle_no, review: it.review_status
        });
      } else if (['pending', 'pending_review'].includes(it.review_status) || it.appeal_status === 'pending') {
        pendingReview.push({
          rule: it.rule_name || it.rule_code, suggested: Number(it.suggested_score || 0),
          desc: it.task_desc || it.node_name || '', ref: it.order_no || '',
          appeal: it.appeal_status
        });
      }
    });
  }

  // ---- 下周建议（规则生成，只给做法） ----
  const suggestions = [];
  if (overdue.length) {
    suggestions.push(`本周有 ${overdue.length} 件事已超时或即将超时，建议周一上班先清「${overdue[0].entity_no}」，其余按到期时间排。`);
  }
  if (blocked.length) {
    const by = [...new Set(blocked.map((b) => b.by))].filter((x) => x && x !== '业务自身');
    if (by.length) suggestions.push(`${blocked.length} 张单卡在${by.join('、')}，建议主动同步一次进度，别等对方来找。`);
  }
  if (pendingReview.length) {
    suggestions.push(`有 ${pendingReview.length} 条绩效建议分待复核，如认为不成立可在「岗位绩效」提交申诉（需写理由）。`);
  }
  if (penalty.length) {
    const top = penalty[0];
    suggestions.push(`已确认扣分里「${top.rule}」占 ${top.score} 分，下周优先改这一项：先在报工时按实际填写，附不良图。`);
  }
  if (!suggestions.length) suggestions.push('本周没有超时和被阻塞的事项，保持现有节奏即可。');

  return {
    subject: p.name,
    role: p.role,
    role_label: ROLE_CN[p.role] || p.role,
    position: p.position || null,
    period_from: from,
    period_to: to,
    done, open, overdue: overdue.map((o) => ({
      entity: o.entity_no, level: o.level, reasons: safeJson(o.reasons, []),
      hours_left: o.hours_left, action: o.next_action
    })),
    blocked, penalty, pending_review: pendingReview, suggestions,
    counts: {
      done: done.reduce((a, d) => a + Number(d.n || 0), 0),
      open: open.length, overdue: overdue.length, blocked: blocked.length,
      penalty: r1(penalty.reduce((a, x) => a + x.score, 0)), pending_review: pendingReview.length
    }
  };
}

function safeJson(s, d) {
  try { return s ? JSON.parse(s) : d; } catch (e) { return d; }
}

/** 生成并落库 */
function generate({ week, scope = 'user', subject, operator }) {
  const w = week ? weekOf(week) : weekOf(localNow().slice(0, 10));
  const all = persons();
  let targets = [];

  if (scope === 'user') {
    const one = all.find((p) => p.name === subject || p.username === subject);
    if (!one) return { error: `找不到人员「${subject || ''}」` };
    targets = [one];
  } else if (scope === 'dept') {
    const deptId = Number(subject);
    targets = all.filter((p) => Number(p.dept_id) === deptId);
    if (!targets.length) return { error: '该部门没有在职人员' };
  } else {
    targets = all;
  }

  const ins = db.prepare(
    `INSERT INTO ai_weekly (week_no,scope,subject_id,subject_name,period_from,period_to,content,
       cnt_done,cnt_open,cnt_overdue,cnt_blocked,cnt_penalty,status,source,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'draft','rule',?,?)
     ON CONFLICT(week_no,scope,subject_id) DO UPDATE SET
       content=excluded.content, cnt_done=excluded.cnt_done, cnt_open=excluded.cnt_open,
       cnt_overdue=excluded.cnt_overdue, cnt_blocked=excluded.cnt_blocked, cnt_penalty=excluded.cnt_penalty,
       created_at=excluded.created_at`
  );

  const t = localNow();
  const made = [];
  db.exec('BEGIN');
  try {
    targets.forEach((p) => {
      const content = buildPersonWeek(p, w.from, w.to);
      // 主键去重靠 subject_id，所以必须每个人都不一样：
      // 有员工档案用 employee_id，只有账号的用「负账号 id」，避免所有人挤到 0 号被覆盖
      const subjectId = p.employee_id ? p.employee_id : -(p.user_id || 0);
      ins.run(w.week_no, scope, subjectId, p.name, w.from, w.to,
        JSON.stringify(content), content.counts.done, content.counts.open, content.counts.overdue,
        content.counts.blocked, content.counts.penalty, operator || 'system', t);
      made.push(p.name);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { week_no: w.week_no, from: w.from, to: w.to, scope, count: made.length, subjects: made };
}

/** 读取：本人只能看自己 */
function list({ week, scope, subject, viewer, limit = 50 }) {
  const where = [];
  const params = [];
  if (week) { where.push('week_no=?'); params.push(weekOf(week).week_no); }
  if (scope) { where.push('scope=?'); params.push(scope); }
  // 注意：下面还要按「人是否还在」过滤，所以 SQL 的 LIMIT 必须留够余量，
  // 否则孤儿行占满条数，本周人数就会少于实际生成的条数（生成 32 条只回来 28 条就是这么来的）。
  const lim = Math.min(2000, Number(limit) || (week ? 500 : 120));
  const rows = db.prepare(
    `SELECT id,week_no,scope,subject_id,subject_name,period_from,period_to,cnt_done,cnt_open,
       cnt_overdue,cnt_blocked,cnt_penalty,status,source,created_at,published_at
     FROM ai_weekly ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY week_no DESC, id ASC LIMIT ?`
  ).all(...params, lim);

  // 人员已不存在的历史行要过滤掉：员工或账号删了，这些周报点进去也查不到人，
  // 留着只会让「本周人数」和实际在岗人数对不上（每换一批演示员工就多几条）。
  const alive = new Set(persons().map((p) => (p.employee_id ? p.employee_id : -(p.user_id || 0))));
  const live = rows.filter((r) => alive.has(r.subject_id));

  // 非管理员只能看自己那份
  const isAdmin = viewer && viewer.role === 'admin';
  const mine = live.filter((r) => isAdmin || r.subject_name === (viewer && (viewer.name || viewer.username)));
  return { rows: mine, hidden: live.length - mine.length, stale: rows.length - live.length, is_admin: isAdmin };
}

function detail(id, viewer) {
  const r = db.prepare('SELECT * FROM ai_weekly WHERE id=?').get(id);
  if (!r) return null;
  const isAdmin = viewer && viewer.role === 'admin';
  if (!isAdmin && r.subject_name !== (viewer.name || viewer.username)) return { forbidden: true };
  return { ...r, content: safeJson(r.content, {}) };
}

module.exports = { weekOf, persons, buildPersonWeek, generate, list, detail, ROLE_CN };
