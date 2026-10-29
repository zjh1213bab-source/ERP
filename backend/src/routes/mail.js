/**
 * 内部邮件（对应原型 TS-N01-05 ~ TS-N01-09）
 * ------------------------------------------------------------------
 * ERP 内员工站内邮件。不搭公网邮箱服务器（无 SMTP/IMAP），不含外部平台消息互通。
 * 供应商 / 客户档案不是内部账号，不能收内部邮件。
 *
 * 硬规则（写在代码里）：
 *   1) 发件身份只能来自当前登录的有效 ERP 账号，不允许伪造他人（EM04）；
 *      客户账号（scope=customer）一律拒绝。
 *   2) 群组展开后**冻结收件快照**，按人去重；收件人优先于抄送（EM05）。
 *   3) 发送前重新校验账号有效性 + 源单访问权限 + 附件；用 request_no 幂等防重（EM06）。
 *   4) 每位收件人独立投递状态：排队 / 已送达 / 失败 / 已撤回；失败只重试失败对象（EM07）。
 *   5) 只有**真正打开正文**才记录首次已读；标未读只改提醒标志，不撤销首次已读（EM08）。
 *   6) 需确认逐人独立确认；提问不算确认，答复后仍需本人确认；正文更正生成新版本 + 新确认义务，
 *      不抹旧回执，抄送不承担确认义务（EM09）。
 *   7) 需办理必须关联唯一原任务（只读投影，不在邮件里结案）或创建唯一协同任务（EM10/EM12）。
 *   8) 发送后不可原地改正文：撤回逐人原子判断（未读未确认才成功），已读的只能发更正（EM17）。
 *   9) 星标 / 归档 / 回收站只作用本人副本，不影响他人内容与未办任务（EM18）。
 *  10) 主管与管理员**不默认可读**所有员工正文；只有收发双方可读（EM20）。
 *  11) 会话按每封信的实际收件范围取交集，后来加入者不自动获得全部线程历史（EM13）。
 */
const express = require('express');
const crypto = require('crypto');

const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const EPS = 0.005;

// 内部邮件对所有有效员工开放（admin 恒通过）
const ANY = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];

const TYPE_LABEL = { normal: '普通沟通', confirm: '需确认', task: '需办理' };
const DELIVERY = { queued: '排队中', delivered: '已送达', failed: '投递失败', recalled: '已撤回' };
const ACK = { none: '无需确认', pending: '待确认', acked: '已确认知悉', questioned: '已提出疑问' };
const MSG_STATUS = { sent: '已发送', partially_failed: '部分失败', recalled: '已撤回', corrected: '已更正' };

const randId = (p) => p + crypto.randomBytes(6).toString('hex');

/* ---------------- 身份 ---------------- */

/** 当前登录人（发件身份只能来自有效账号，不能伪造他人） */
function me(req) {
  const u = db.prepare('SELECT u.*, d.name AS dept FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.username = ?').get(req.user.username);
  return {
    username: req.user.username,
    name: (u && u.name) || req.user.name || req.user.username,
    dept: (u && u.dept) || null,
    dept_id: u ? u.department_id : null,
    company_id: u ? u.company_id : null,
    role: req.user.role,
    active: u ? Number(u.active) : 0
  };
}

/** 客户账号不能收发内部邮件 */
function rejectCustomer(req, res) {
  if (req.user.scope === 'customer') {
    fail(res, 403, '客户账号不能使用内部邮件：内部邮件只对有效员工账号开放');
    return true;
  }
  return false;
}

/** 有效内部账号 */
function activeUser(username) {
  const u = db.prepare('SELECT u.*, d.name AS dept FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.username = ?').get(username);
  if (!u || !Number(u.active)) return null;
  return u;
}

/* ---------------- 编号 ---------------- */

function nextNo(prefix, table, field) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const row = db.prepare(`SELECT ${field} AS no FROM ${table} WHERE ${field} LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}${ymd}%`);
  const seq = row ? Number(String(row.no).slice(-4)) + 1 : 1;
  return genNo(prefix, seq);
}

/* ---------------- 通讯录 / 群组 ---------------- */

function contacts(q) {
  const where = ['u.active = 1'];
  const args = [];
  if (q) {
    where.push('(u.name LIKE ? OR u.username LIKE ? OR d.name LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  return db.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.department_id, d.name AS department, u.company_id, u.active
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE ${where.join(' AND ')}
     ORDER BY d.id, u.id`
  ).all(...args).map((u) => ({ ...u, label: `${u.name}（${u.department || '未分部门'}）` }));
}

/** 群组 = 全员 + 各部门（原型未要求自定义群组，先按组织主档展开） */
function groups() {
  const depts = db.prepare('SELECT * FROM departments ORDER BY id').all();
  const out = [{ code: 'all', name: '全体员工', count: db.prepare('SELECT COUNT(*) c FROM users WHERE active = 1').get().c }];
  depts.forEach((d) => {
    const c = db.prepare('SELECT COUNT(*) c FROM users WHERE active = 1 AND department_id = ?').get(d.id).c;
    if (c) out.push({ code: 'dept:' + d.id, name: d.name, count: c });
  });
  return out;
}

/**
 * 展开收件人：群组 → 具体人，按人去重，收件人优先于抄送（EM05）
 * 返回 { rows:[{username,kind}], warnings:[] }
 */
function resolveAudience(toList, ccList) {
  const picks = [];
  const warnings = [];
  const expand = (code) => {
    if (!code) return [];
    const s = String(code).trim();
    if (!s) return [];
    if (s === 'all') return db.prepare('SELECT username FROM users WHERE active = 1').all().map((x) => x.username);
    if (s.startsWith('dept:')) {
      const id = Number(s.slice(5));
      return db.prepare('SELECT username FROM users WHERE active = 1 AND department_id = ?').all(id).map((x) => x.username);
    }
    return [s];   // 具体 username
  };
  const seen = new Map();
  (toList || []).forEach((c) => expand(c).forEach((u) => {
    if (!seen.has(u)) seen.set(u, 'to');
  }));
  (ccList || []).forEach((c) => expand(c).forEach((u) => {
    if (!seen.has(u)) seen.set(u, 'cc');
    // 已是收件人的不再重复加为抄送（收件人优先）
  }));
  [...seen.entries()].forEach(([username, kind]) => {
    if (!activeUser(username)) warnings.push(`${username} 不是有效账号，已跳过`);
    else picks.push({ username, kind });
  });
  return { rows: picks, warnings };
}

/* ---------------- 权限 ---------------- */

/** 我在这封信里的收件行 */
function myRow(messageId, username) {
  return db.prepare('SELECT * FROM mail_recipients WHERE message_id = ? AND username = ?').get(messageId, username);
}

/** 能否读这封信：发件人 或 收件行本人（管理员不默认读别人正文，EM20） */
function canRead(msg, username, role) {
  if (!msg) return false;
  if (msg.sender === username) return true;
  if (myRow(msg.id, username)) return true;
  return false;
}

/** 会话可见范围：只返回我作为发件人或收件人的那些信（范围取交集，EM13） */
function visibleThread(threadId, username) {
  const all = db.prepare('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY id').all(threadId);
  return all.filter((m) => canRead(m, username));
}

/* ---------------- 投递 ---------------- */

/** 逐人投递：账号有效即送达，否则失败；只处理未送达的行 */
function deliver(messageId, onlyFailed) {
  const rows = db.prepare('SELECT * FROM mail_recipients WHERE message_id = ?').all(messageId)
    .filter((r) => (onlyFailed ? r.delivery_status === 'failed' : r.delivery_status === 'queued'));
  const t = now();
  let okN = 0;
  let failN = 0;
  rows.forEach((r) => {
    const u = activeUser(r.username);
    if (u) {
      db.prepare("UPDATE mail_recipients SET delivery_status = 'delivered', delivered_at = ?, deliver_attempt = deliver_attempt + 1, fail_reason = NULL WHERE id = ?")
        .run(t, r.id);
      event(messageId, r.id, onlyFailed ? 'retry' : 'deliver', '已送达', null, t);
      okN++;
    } else {
      db.prepare("UPDATE mail_recipients SET delivery_status = 'failed', deliver_attempt = deliver_attempt + 1, fail_reason = ? WHERE id = ?")
        .run('账号不存在或已停用', r.id);
      event(messageId, r.id, onlyFailed ? 'retry' : 'fail', '账号不存在或已停用', null, t);
      failN++;
    }
  });
  const failed = db.prepare("SELECT COUNT(*) c FROM mail_recipients WHERE message_id = ? AND delivery_status = 'failed'").get(messageId).c;
  db.prepare('UPDATE mail_messages SET status = ? WHERE id = ? AND status != ?')
    .run(failed > 0 ? 'partially_failed' : 'sent', messageId, 'recalled');
  return { delivered: okN, failed: failN };
}

function event(messageId, recipientId, ev, detail, operator, t) {
  db.prepare('INSERT INTO mail_delivery_events (message_id, recipient_id, event, detail, operator, created_at) VALUES (?,?,?,?,?,?)')
    .run(messageId, recipientId, ev, detail || null, operator || null, t || now());
}

function audit(messageId, threadId, action, username, detail) {
  db.prepare('INSERT INTO mail_audits (message_id, thread_id, action, username, detail, created_at) VALUES (?,?,?,?,?,?)')
    .run(messageId || null, threadId || null, action, username || null, detail || null, now());
}

/* ---------------- 源单投影（只读，不给正文权限） ---------------- */

const SOURCE_DEF = {
  order: { table: 'orders', label: (r) => `订单 ${r.order_no}`, status: (r) => r.status, link: (r) => `/orders?q=${r.order_no}` },
  first_article: { table: 'first_articles', label: (r) => `首件 ${r.fa_no}`, status: (r) => r.status, link: (r) => '/first-article' },
  receipt: { table: 'goods_receipts', label: (r) => `收料 ${r.grn_no}`, status: (r) => r.status, link: (r) => '/receipts' },
  cut: { table: 'cut_orders', label: (r) => `裁剪 ${r.cut_no}`, status: (r) => r.status, link: (r) => '/cuts' },
  quote: { table: 'quotations', label: (r) => `报价 ${r.quote_no}`, status: (r) => r.status, link: (r) => '/quotations' }
};

const STATUS_CN = {
  draft: '草稿', tech: '待技术确认', finance: '待财务审核', assigned: '已分单', production: '生产中',
  instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消',
  submitted: '待复核', passed: '已放行', conditional: '限定放行', rejected: '不合格退回',
  pending: '待检', inspecting: '检验中', partial: '部分合格', cutting: '裁剪中', cut_done: '裁剪完成', handed: '已交接',
  sent: '已发出', accepted: '已接受', refused: '已拒绝'
};

function sourceProjection(type, id) {
  const def = SOURCE_DEF[type];
  if (!def || !id) return null;
  const row = db.prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(id);
  if (!row) return null;
  const st = def.status(row);
  return {
    type, id,
    label: def.label(row),
    status: st,
    status_label: STATUS_CN[st] || st,
    link: def.link(row),
    // 只读投影：邮件里不能改原单状态（EM12）
    readonly: true
  };
}

/* ---------------- 视图 ---------------- */

function recipientsOf(messageId) {
  return db.prepare('SELECT * FROM mail_recipients WHERE message_id = ? ORDER BY (kind = \'to\') DESC, id').all(messageId).map((r) => ({
    ...r,
    kind_label: r.kind === 'to' ? '收件人' : '抄送',
    delivery_label: DELIVERY[r.delivery_status] || r.delivery_status,
    ack_label: ACK[r.ack_state] || r.ack_state
  }));
}

function messageView(m, viewer) {
  const rows = recipientsOf(m.id);
  const to = rows.filter((r) => r.kind === 'to');
  const cc = rows.filter((r) => r.kind === 'cc');
  let attachments = [];
  try { attachments = JSON.parse(m.attachments || '[]'); } catch (e) { attachments = []; }
  const mine = myRow(m.id, viewer);
  const task = db.prepare('SELECT * FROM mail_tasks WHERE message_id = ?').get(m.id);
  return {
    ...m,
    type_label: TYPE_LABEL[m.type] || m.type,
    status_label: MSG_STATUS[m.status] || m.status,
    to, cc, recipients: rows,
    attachments,
    mine: mine ? {
      ...mine,
      kind_label: mine.kind === 'to' ? '收件人' : '抄送',
      delivery_label: DELIVERY[mine.delivery_status] || mine.delivery_status,
      ack_label: ACK[mine.ack_state] || mine.ack_state
    } : null,
    task: task || null,
    source: sourceProjection(m.source_type, m.source_id) || (m.source_label ? { label: m.source_label, readonly: true } : null),
    ack_summary: {
      must: rows.filter((r) => r.must_ack).length,
      acked: rows.filter((r) => r.must_ack && r.ack_state === 'acked').length,
      questioned: rows.filter((r) => r.must_ack && r.ack_state === 'questioned').length,
      pending: rows.filter((r) => r.must_ack && r.ack_state === 'pending').length,
      failed: rows.filter((r) => r.delivery_status === 'failed').length,
      recalled: rows.filter((r) => r.delivery_status === 'recalled').length
    }
  };
}

/* ================= 接口 ================= */

/** 通讯录 */
router.get('/contacts', authRequired, wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  return ok(res, { contacts: contacts(req.query.q), groups: groups() });
}));

/** 未读统计（顶部邮件图标） */
router.get('/unread', authRequired, wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const u = me(req).username;
  const inbox = db.prepare(
    `SELECT COUNT(*) c FROM mail_recipients r JOIN mail_messages m ON m.id = r.message_id
     WHERE r.username = ? AND r.trash = 0 AND r.archived = 0 AND r.read_flag = 1
       AND r.delivery_status IN ('delivered','recalled') AND m.sender != ?`
  ).get(u, u).c;
  const needAck = db.prepare(
    `SELECT COUNT(*) c FROM mail_recipients WHERE username = ? AND must_ack = 1 AND ack_state = 'pending' AND trash = 0`
  ).get(u).c;
  const myTasks = db.prepare("SELECT COUNT(*) c FROM mail_tasks WHERE owner = ? AND status = 'open'").get(u).c;
  return ok(res, { inbox: Number(inbox), need_ack: Number(needAck), my_tasks: Number(myTasks) });
}));

/** 邮箱列表 */
router.get('/box', authRequired, wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const u = me(req).username;
  const folder = req.query.folder || 'inbox';
  const q = String(req.query.q || '').trim();
  const type = req.query.type || '';

  let sql;
  let args;
  if (folder === 'sent') {
    sql = 'SELECT m.*, NULL AS first_read_at, 0 AS star, 0 AS archived, 0 AS trash, NULL AS ack_state, NULL AS delivery_status, NULL AS must_ack FROM mail_messages m WHERE m.sender = ?';
    args = [u];
  } else if (folder === 'drafts') {
    sql = 'SELECT m.* FROM mail_messages m WHERE 1 = 0';
    args = [];
  } else {
    const extra = folder === 'starred' ? ' AND r.star = 1 AND r.trash = 0'
      : folder === 'archived' ? ' AND r.archived = 1 AND r.trash = 0'
        : folder === 'trash' ? ' AND r.trash = 1'
          : folder === 'pending' ? " AND r.must_ack = 1 AND r.ack_state = 'pending' AND r.trash = 0 AND r.archived = 0"
            : ' AND r.trash = 0 AND r.archived = 0';
    sql = `SELECT m.*, r.first_read_at, r.read_flag, r.star, r.archived, r.trash, r.ack_state, r.delivery_status, r.must_ack
           FROM mail_messages m JOIN mail_recipients r ON r.message_id = m.id
           WHERE r.username = ? AND m.sender != ?${extra}`;
    args = [u, u];
  }
  if (type) { sql += ' AND m.type = ?'; args.push(type); }
  if (q) { sql += ' AND (m.subject LIKE ? OR m.body LIKE ? OR m.message_no LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY m.id DESC LIMIT 300';

  const rows = db.prepare(sql).all(...args).map((m) => {
    const to = db.prepare("SELECT name, username, delivery_status FROM mail_recipients WHERE message_id = ? AND kind = 'to'").all(m.id);
    const t = db.prepare('SELECT * FROM mail_tasks WHERE message_id = ?').get(m.id);
    let att = [];
    try { att = JSON.parse(m.attachments || '[]'); } catch (e) { att = []; }
    return {
      id: m.id,
      message_no: m.message_no,
      thread_id: m.thread_id,
      subject: m.subject,
      type: m.type,
      type_label: TYPE_LABEL[m.type] || m.type,
      sender: m.sender,
      sender_name: m.sender_name,
      created_at: m.created_at,
      confirm_due: m.confirm_due,
      task_due: m.task_due,
      version: m.version,
      status: m.status,
      status_label: MSG_STATUS[m.status] || m.status,
      snippet: String(m.body || '').replace(/\s+/g, ' ').slice(0, 70),
      to_names: to.map((x) => x.name || x.username).join('、'),
      to_count: to.length,
      attach_count: att.length,
      source_label: m.source_label,
      // 本人视角
      unread: folder === 'sent' ? 0 : (m.read_flag === 1 && !m.first_read_at ? 1 : 0),
      read_flag: m.read_flag,
      star: m.star || 0,
      archived: m.archived || 0,
      trash: m.trash || 0,
      must_ack: m.must_ack || 0,
      ack_state: m.ack_state || 'none',
      ack_label: ACK[m.ack_state] || '',
      delivery_status: m.delivery_status || null,
      task: t ? { id: t.id, task_no: t.task_no, title: t.title, owner: t.owner, due_at: t.due_at, status: t.status } : null
    };
  });

  const counts = {
    inbox: db.prepare("SELECT COUNT(*) c FROM mail_recipients r JOIN mail_messages m ON m.id=r.message_id WHERE r.username=? AND r.trash=0 AND r.archived=0 AND m.sender!=?").get(u, u).c,
    sent: db.prepare('SELECT COUNT(*) c FROM mail_messages WHERE sender = ?').get(u).c,
    starred: db.prepare('SELECT COUNT(*) c FROM mail_recipients WHERE username=? AND star=1 AND trash=0').get(u).c,
    archived: db.prepare('SELECT COUNT(*) c FROM mail_recipients WHERE username=? AND archived=1 AND trash=0').get(u).c,
    trash: db.prepare('SELECT COUNT(*) c FROM mail_recipients WHERE username=? AND trash=1').get(u).c,
    pending: db.prepare("SELECT COUNT(*) c FROM mail_recipients WHERE username=? AND must_ack=1 AND ack_state='pending' AND trash=0 AND archived=0").get(u).c,
    inbox_unread: db.prepare("SELECT COUNT(*) c FROM mail_recipients r JOIN mail_messages m ON m.id=r.message_id WHERE r.username=? AND r.trash=0 AND r.archived=0 AND r.read_flag=1 AND m.sender!=?").get(u, u).c
  };
  return ok(res, { folder, rows, counts });
}));

/** 统计（投递 / 确认 / 办理分开计，不能混算成功） */
router.get('/stats', authRequired, wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const u = me(req).username;
  const mine = db.prepare('SELECT id FROM mail_messages WHERE sender = ?').all(u).map((x) => x.id);
  const ids = mine.length ? mine.join(',') : '0';
  const lines = db.prepare(`SELECT COUNT(*) c FROM mail_recipients WHERE message_id IN (${ids})`).get().c;
  const delivered = db.prepare(`SELECT COUNT(*) c FROM mail_recipients WHERE message_id IN (${ids}) AND delivery_status = 'delivered'`).get().c;
  const failed = db.prepare(`SELECT COUNT(*) c FROM mail_recipients WHERE message_id IN (${ids}) AND delivery_status = 'failed'`).get().c;
  const recalled = db.prepare(`SELECT COUNT(*) c FROM mail_recipients WHERE message_id IN (${ids}) AND delivery_status = 'recalled'`).get().c;
  const must = db.prepare(`SELECT COUNT(*) c FROM mail_recipients WHERE message_id IN (${ids}) AND must_ack = 1`).get().c;
  const acked = db.prepare(`SELECT COUNT(*) c FROM mail_recipients WHERE message_id IN (${ids}) AND must_ack = 1 AND ack_state = 'acked'`).get().c;
  const questioned = db.prepare(`SELECT COUNT(*) c FROM mail_recipients WHERE message_id IN (${ids}) AND must_ack = 1 AND ack_state = 'questioned'`).get().c;
  const opened = db.prepare(`SELECT COUNT(*) c FROM mail_recipients WHERE message_id IN (${ids}) AND first_read_at IS NOT NULL`).get().c;
  const tasks = db.prepare('SELECT status, COUNT(*) c FROM mail_tasks WHERE created_by = ? GROUP BY status').all(u);
  return ok(res, {
    sent_messages: mine.length,
    lines: Number(lines),
    delivered: Number(delivered),
    failed: Number(failed),
    recalled: Number(recalled),
    opened: Number(opened),
    must_ack: Number(must),
    acked: Number(acked),
    questioned: Number(questioned),
    ack_rate: Number(must) ? Math.round((Number(acked) / Number(must)) * 100) : null,
    tasks: tasks.reduce((a, x) => ({ ...a, [x.status]: Number(x.c) }), {})
  });
}));

/** 会话详情（按实际收件范围取交集） */
router.get('/thread/:id', authRequired, wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const u = me(req).username;
  const t = db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '会话不存在');
  const msgs = visibleThread(t.id, u);
  if (!msgs.length) return fail(res, 403, '你不在这个会话的收发范围内');
  return ok(res, { thread: t, messages: msgs.map((m) => messageView(m, u)) });
}));

/**
 * 发信
 * body: {
 *   action: new|reply|reply_all|forward, parent_id,
 *   subject, body, type: normal|confirm|task,
 *   to:[username|group], cc:[],
 *   attachments:[{name,url,size,hash,ext}],
 *   source_type, source_id,
 *   confirm_due, task_due,
 *   task: {title, owner, due_at, requirement},   // 无原任务时创建协同任务
 *   acting_for,                                  // 代理发信
 *   request_no
 * }
 */
router.post('/send', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  if (!who.active) return fail(res, 403, '当前账号已停用，不能发内部邮件');
  const b = req.body || {};

  // 幂等：同一请求号只发一次
  const requestNo = String(b.request_no || '').trim() || randId('RQ');
  const dup = db.prepare('SELECT id FROM mail_messages WHERE request_no = ?').get(requestNo);
  if (dup) {
    const old = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(dup.id);
    return ok(res, { ...messageView(old, who.username), duplicate: true, notice: '这个请求号已经发过，返回原来那封信' });
  }

  const body = String(b.body || '').trim();
  if (!body) return fail(res, 400, '正文不能为空（发送后不可原地改，请写清楚再发）');
  const type = ['confirm', 'task'].includes(b.type) ? b.type : 'normal';

  // 回复 / 转发重新鉴权
  let parent = null;
  let thread = null;
  let action = b.action || 'new';
  if (b.parent_id) {
    parent = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(b.parent_id);
    if (!parent) return fail(res, 404, '被回复的邮件不存在');
    if (!canRead(parent, who.username, req.user.role)) return fail(res, 403, '你不在原邮件的收发范围，不能回复或转发');
    thread = db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(parent.thread_id);
  }

  // 收件范围
  let toList = b.to;
  let ccList = b.cc;
  if (action === 'reply' && parent) {
    // 默认只回发件人
    toList = [parent.sender];
    ccList = [];
  } else if (action === 'reply_all' && parent) {
    // 回复全部要前端主动选择，这里按原范围取（去掉自己）
    const rows = db.prepare('SELECT username, kind FROM mail_recipients WHERE message_id = ?').all(parent.id);
    toList = [parent.sender, ...rows.filter((r) => r.kind === 'to').map((r) => r.username)].filter((x) => x !== who.username);
    ccList = rows.filter((r) => r.kind === 'cc').map((r) => r.username).filter((x) => x !== who.username);
  } else if (action === 'forward' && parent) {
    // 转发：收件人由发信人重新指定，但原文引用要重新校验（不能转给无权者看源单）
    if (!Array.isArray(toList) || !toList.length) return fail(res, 400, '转发必须重新指定收件人');
  }
  const aud = resolveAudience(toList, ccList);
  if (!aud.rows.length) return fail(res, 400, '至少要有一个有效的收件人或抄送');
  if (action === 'new' && !aud.rows.some((r) => r.kind === 'to')) return fail(res, 400, '至少要有一个收件人（抄送不能代替收件人）');

  // 代理发信：必须有有效的代理授权
  let actingFor = null;
  if (b.acting_for && b.acting_for !== who.username) {
    const dg = db.prepare(
      "SELECT * FROM mail_delegates WHERE owner = ? AND agent = ? AND status = 'active' AND start_at <= ? AND end_at >= ?"
    ).get(b.acting_for, who.username, now(), now());
    if (!dg) return fail(res, 400, `没有 ${b.acting_for} 对你的有效代理授权（或已过期），不能代发`);
    if (dg.scope === 'ack') return fail(res, 400, '该代理授权只允许代确认，不允许代发');
    actingFor = b.acting_for;
  }

  // 需确认必须有截止；需办理必须有原任务或协同任务
  const confirmDue = type === 'confirm' ? (b.confirm_due || null) : null;
  if (type === 'confirm' && !confirmDue) return fail(res, 400, '需确认邮件必须填确认截止时间');
  let taskPlan = null;
  if (type === 'task') {
    const srcType = b.source_type || null;
    const srcId = b.source_id ? Number(b.source_id) : null;
    const hasSource = !!(srcType && srcId && sourceProjection(srcType, srcId));
    if (hasSource) {
      if (!b.task_due) return fail(res, 400, '需办理邮件必须填办理期限');
      taskPlan = { mode: 'source', source_type: srcType, source_id: srcId, due_at: b.task_due };
    } else {
      const t = b.task || {};
      if (!String(t.title || '').trim()) return fail(res, 400, '需办理邮件：没有关联原任务时，必须填协同任务标题');
      if (!String(t.owner || '').trim()) return fail(res, 400, '需办理邮件必须指定唯一主责人（一项交付物一名主责）');
      if (!activeUser(String(t.owner).trim())) return fail(res, 400, '主责人不是有效员工账号');
      if (!b.task_due && !t.due_at) return fail(res, 400, '需办理邮件必须填办理期限');
      taskPlan = {
        mode: 'task',
        title: String(t.title).trim(),
        owner: String(t.owner).trim(),
        due_at: t.due_at || b.task_due,
        requirement: t.requirement || null
      };
    }
  }

  // 附件重新校验（EM14）：只接受本系统上传的地址
  //
  // 两种地址都要认：图片走公开区 `/uploads/...`，PDF/Office/zip 走私有附件
  // `/api/files/att/...`（v1.68 起附件不再落在公开区）。只认 `/uploads/` 的话，
  // 新上传的 pdf 会被静默丢掉 —— 用户以为发出去了，收件人那边没有附件。
  let attachments = [];
  if (Array.isArray(b.attachments)) {
    attachments = b.attachments
      .filter((a) => a && a.url && /^\/(uploads\/|api\/files\/att\/)/.test(String(a.url)))
      .slice(0, 10)
      .map((a) => ({
        name: String(a.name || 'attachment').slice(0, 120),
        url: a.url,
        size: Number(a.size) || 0,
        ext: a.ext || String(a.name || '').split('.').pop(),
        hash: a.hash || crypto.createHash('md5').update(String(a.url)).digest('hex').slice(0, 16)
      }));
  }

  const t = now();
  const companyId = who.company_id;
  let msgId;
  let threadId;
  db.exec('BEGIN');
  try {
    // 会话
    if (thread) {
      threadId = thread.id;
    } else {
      const tno = nextNo('TH', 'mail_threads', 'thread_no');
      const src = b.source_type && b.source_id ? sourceProjection(b.source_type, Number(b.source_id)) : null;
      const info = db.prepare(
        'INSERT INTO mail_threads (thread_no, subject, source_type, source_id, source_label, message_count, last_message_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?,?)'
      ).run(tno, String(b.subject || '(无主题)').slice(0, 200), b.source_type || null, b.source_id || null,
        src ? src.label : null, t, who.username, t, t);
      threadId = Number(info.lastInsertRowid);
    }

    const subject = String(b.subject || (parent ? parent.subject : '(无主题)')).slice(0, 200);
    const info = db.prepare(
      `INSERT INTO mail_messages (message_no, thread_id, parent_id, subject, body, type, sender, sender_name, sender_dept,
        acting_for, company_id, source_type, source_id, source_label, attachments, request_no, version,
        confirm_due, task_due, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?, 'sent', ?)`
    ).run(
      nextNo('EM', 'mail_messages', 'message_no'), threadId, parent ? parent.id : null, subject, body, type,
      who.username, who.name, who.dept, actingFor, companyId,
      b.source_type || null, b.source_id || null,
      (b.source_type && b.source_id && sourceProjection(b.source_type, Number(b.source_id)))?.label || null,
      JSON.stringify(attachments), requestNo, confirmDue, taskPlan ? taskPlan.due_at : null, t
    );
    msgId = Number(info.lastInsertRowid);

    // 收件行：需确认 => 收件人必确认，抄送默认知悉
    const ins = db.prepare(
      `INSERT INTO mail_recipients (message_id, user_id, username, name, department, kind, must_ack, delivery_status, ack_state)
       VALUES (?,?,?,?,?,?,?, 'queued', ?)`
    );
    aud.rows.forEach((r) => {
      const u = activeUser(r.username);
      const mustAck = type === 'confirm' && r.kind === 'to' ? 1 : 0;
      const ackState = type === 'confirm'
        ? (r.kind === 'cc' ? 'acked' : 'pending')
        : 'none';
      ins.run(msgId, u ? u.id : null, r.username, u ? u.name : r.username, u ? u.dept : null, r.kind, mustAck, ackState);
    });

    // 协同任务
    if (taskPlan && taskPlan.mode === 'task') {
      const tno = nextNo('RW', 'mail_tasks', 'task_no');
      db.prepare(
        'INSERT INTO mail_tasks (task_no, message_id, thread_id, title, owner, due_at, requirement, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).run(tno, msgId, threadId, taskPlan.title, taskPlan.owner, taskPlan.due_at, taskPlan.requirement, 'open', who.username, t, t);
    }

    db.prepare('UPDATE mail_threads SET message_count = message_count + 1, last_message_at = ?, updated_at = ? WHERE id = ?')
      .run(t, t, threadId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `发送失败：${e.message}`);
  }

  // 逐人投递（失败只影响失败对象）
  const d = deliver(msgId, false);
  audit(msgId, threadId, 'send', who.username, `type=${type} to=${aud.rows.length} acting_for=${actingFor || '-'}`);
  if (actingFor) audit(msgId, threadId, 'delegate', who.username, `代 ${actingFor} 发信`);

  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(msgId);
  const view = messageView(m, who.username);
  const warnings = aud.warnings.slice();
  if (type === 'task' && taskPlan.mode === 'source') warnings.push('这封信关联了原业务单，办理与结案仍在原单里做，邮件里只显示只读状态');
  return ok(res, { ...view, delivery: d, warnings });
}));

/** 确认知悉（只能本人或有效代理；提问不算确认） */
router.post('/:id/ack', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(req.params.id);
  if (!m) return fail(res, 404, '邮件不存在');
  const b = req.body || {};
  const targetUser = String(b.on_behalf_of || who.username);
  let row = myRow(m.id, targetUser);
  let isDelegate = 0;
  let delegateBy = null;

  if (targetUser !== who.username) {
    // 代理确认：必须有有效代理授权，且记录代理人不伪造本人知悉
    const dg = db.prepare(
      "SELECT * FROM mail_delegates WHERE owner = ? AND agent = ? AND status = 'active' AND start_at <= ? AND end_at >= ?"
    ).get(targetUser, who.username, now(), now());
    if (!dg) return fail(res, 400, `没有 ${targetUser} 对你的有效代理授权（或已过期），不能代确认`);
    if (dg.scope === 'send') return fail(res, 400, '该代理授权只允许代发，不允许代确认');
    isDelegate = 1;
    delegateBy = who.username;
  }
  if (!row) return fail(res, 403, '你不是这封信的收件人，不能确认');
  if (row.kind === 'cc') return fail(res, 400, '抄送默认知悉，不需要单独确认');
  if (!row.must_ack) return fail(res, 400, '这封信没要求确认知悉');
  if (row.ack_state === 'acked') return fail(res, 400, '已经确认过了');
  if (row.delivery_status === 'recalled') return fail(res, 400, '这封信已撤回，不需要确认');

  const t = now();
  db.prepare('UPDATE mail_recipients SET ack_state = ?, ack_at = ?, ack_note = ?, is_delegate = ?, delegate_by = ? WHERE id = ?')
    .run('acked', t, b.note || null, isDelegate, delegateBy, row.id);
  event(m.id, row.id, 'ack', isDelegate ? `由 ${who.username} 代确认` : '本人确认知悉', who.username, t);
  return ok(res, messageView(m, who.username));
}));

/** 提出疑问（不算确认；答复后仍需本人确认） */
router.post('/:id/question', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(req.params.id);
  if (!m) return fail(res, 404, '邮件不存在');
  const q = String((req.body || {}).question || '').trim();
  if (!q) return fail(res, 400, '请写清楚疑问内容');
  const row = myRow(m.id, who.username);
  if (!row) return fail(res, 403, '你不是这封信的收件人');
  if (!row.must_ack) return fail(res, 400, '只有需确认的邮件可以提疑问');
  const t = now();
  db.prepare("UPDATE mail_recipients SET ack_state = 'questioned', question = ?, ack_at = NULL WHERE id = ?").run(q, row.id);
  event(m.id, row.id, 'question', q, who.username, t);
  return ok(res, messageView(m, who.username));
}));

/** 发件人答复疑问：答复完仍需本人确认，不自动算确认 */
router.post('/:id/answer', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(req.params.id);
  if (!m) return fail(res, 404, '邮件不存在');
  if (m.sender !== who.username) return fail(res, 403, '只有发件人可以答复疑问');
  const b = req.body || {};
  const answer = String(b.answer || '').trim();
  if (!answer) return fail(res, 400, '请填写答复内容');
  const row = b.recipient_id
    ? db.prepare('SELECT * FROM mail_recipients WHERE id = ? AND message_id = ?').get(b.recipient_id, m.id)
    : db.prepare("SELECT * FROM mail_recipients WHERE message_id = ? AND ack_state = 'questioned' LIMIT 1").get(m.id);
  if (!row) return fail(res, 404, '没有待答复的疑问');
  db.prepare("UPDATE mail_recipients SET answer = ?, ack_state = 'pending' WHERE id = ?").run(answer, row.id);
  return ok(res, messageView(m, who.username));
}));

/** 星标 / 归档 / 回收站 / 标未读 —— 只作用本人副本（不影响他人与未办任务） */
router.post('/:id/flag', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(req.params.id);
  if (!m) return fail(res, 404, '邮件不存在');
  const row = myRow(m.id, who.username);
  if (!row) return fail(res, 403, '只有收件人本人可以改自己的邮箱副本');
  const b = req.body || {};
  const sets = [];
  const args = [];
  if (b.star !== undefined) { sets.push('star = ?'); args.push(b.star ? 1 : 0); }
  if (b.archived !== undefined) { sets.push('archived = ?'); args.push(b.archived ? 1 : 0); }
  if (b.trash !== undefined) { sets.push('trash = ?'); args.push(b.trash ? 1 : 0); }
  if (b.read_flag !== undefined) {
    // 标未读只改提醒标志，首次已读历史不撤销
    sets.push('read_flag = ?');
    args.push(b.read_flag ? 1 : 0);
  }
  if (!sets.length) return fail(res, 400, '没有要改的标记');
  db.prepare(`UPDATE mail_recipients SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
  const fresh = myRow(m.id, who.username);
  return ok(res, {
    id: m.id,
    star: fresh.star, archived: fresh.archived, trash: fresh.trash,
    read_flag: fresh.read_flag, first_read_at: fresh.first_read_at,
    notice: b.read_flag ? '已标为未读（首次已读时间保留）' : null
  });
}));

/**
 * 撤回：逐人原子判断
 * 未读且未确认 → 撤回成功；已读 / 已确认 → 撤回失败，只能发更正
 */
router.post('/:id/recall', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(req.params.id);
  if (!m) return fail(res, 404, '邮件不存在');
  if (m.sender !== who.username) return fail(res, 403, '只有发件人可以撤回');
  if (m.status === 'recalled') return fail(res, 400, '这封信已经撤回过');
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return fail(res, 400, '撤回必须写原因');

  const rows = db.prepare('SELECT * FROM mail_recipients WHERE message_id = ?').all(m.id);
  const t = now();
  const okList = [];
  const failList = [];
  db.exec('BEGIN');
  try {
    rows.forEach((r) => {
      const canRecall = r.delivery_status === 'delivered' && !r.first_read_at && r.ack_state !== 'acked';
      if (canRecall) {
        db.prepare("UPDATE mail_recipients SET delivery_status = 'recalled' WHERE id = ?").run(r.id);
        event(m.id, r.id, 'recall', reason, who.username, t);
        okList.push(r.name || r.username);
      } else {
        failList.push({ name: r.name || r.username, reason: r.first_read_at ? '已读' : r.ack_state === 'acked' ? '已确认' : '未送达' });
      }
    });
    const allRecalled = failList.length === 0;
    db.prepare('UPDATE mail_messages SET status = ?, recall_reason = ? WHERE id = ?')
      .run(allRecalled ? 'recalled' : m.status, reason, m.id);
    audit(m.id, m.thread_id, 'recall', who.username, `成功 ${okList.length} / 失败 ${failList.length}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `撤回失败：${e.message}`);
  }
  return ok(res, {
    recalled: okList,
    failed: failList,
    notice: failList.length
      ? `${failList.length} 位收件人无法撤回（已读/已确认），这些副本收不回来，只能发更正`
      : '全部撤回成功'
  });
}));

/** 更正：正文不可原地改，只能发新版本，旧确认回执保留 */
router.post('/:id/correct', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(req.params.id);
  if (!m) return fail(res, 404, '邮件不存在');
  if (m.sender !== who.username) return fail(res, 403, '只有发件人可以更正');
  const b = req.body || {};
  const body = String(b.body || '').trim();
  if (!body) return fail(res, 400, '请填写更正后的正文');
  const reason = String(b.reason || '').trim();
  if (!reason) return fail(res, 400, '更正必须写原因（发错了什么，改了什么）');

  const oldRows = db.prepare('SELECT * FROM mail_recipients WHERE message_id = ?').all(m.id);
  const t = now();
  let newId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO mail_messages (message_no, thread_id, parent_id, subject, body, type, sender, sender_name, sender_dept,
        company_id, source_type, source_id, source_label, attachments, request_no, version, confirm_due, task_due, status, corrects_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'sent', ?, ?)`
    ).run(
      nextNo('EM', 'mail_messages', 'message_no'), m.thread_id, m.id, `[更正] ${m.subject}`, body, m.type,
      who.username, who.name, who.sender_dept, m.company_id, m.source_type, m.source_id, m.source_label,
      m.attachments, randId('RQ'), Number(m.version) + 1, m.confirm_due, m.task_due, m.id, t
    );
    newId = Number(info.lastInsertRowid);

    // 新版本重新产生确认义务；旧回执保留不动
    const ins = db.prepare(
      `INSERT INTO mail_recipients (message_id, user_id, username, name, department, kind, must_ack, delivery_status, ack_state)
       VALUES (?,?,?,?,?,?,?, 'queued', ?)`
    );
    oldRows.forEach((r) => {
      const mustAck = m.type === 'confirm' && r.kind === 'to' ? 1 : 0;
      const ackState = m.type === 'confirm' ? (r.kind === 'cc' ? 'acked' : 'pending') : 'none';
      ins.run(newId, r.user_id, r.username, r.name, r.department, r.kind, mustAck, ackState);
    });
    db.prepare("UPDATE mail_messages SET status = 'corrected', corrected_by = ?, recall_reason = COALESCE(recall_reason,'') || ? WHERE id = ?")
      .run(newId, ` [更正：${reason}]`, m.id);
    db.prepare('UPDATE mail_threads SET message_count = message_count + 1, last_message_at = ?, updated_at = ? WHERE id = ?')
      .run(t, t, m.thread_id);
    audit(newId, m.thread_id, 'correct', who.username, `更正 ${m.message_no}：${reason}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `更正失败：${e.message}`);
  }
  deliver(newId, false);
  const fresh = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(newId);
  return ok(res, { ...messageView(fresh, who.username), notice: '已发出更正版（V' + (Number(m.version) + 1) + '），原信回执保留' });
}));

/** 重试失败投递：只重试失败对象，已送达的不会重复生成 */
router.post('/:id/retry', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(req.params.id);
  if (!m) return fail(res, 404, '邮件不存在');
  if (m.sender !== who.username && who.role !== 'admin') return fail(res, 403, '只有发件人可以重试投递');
  const d = deliver(m.id, true);
  audit(m.id, m.thread_id, 'retry', who.username, `重试：成功 ${d.delivered} / 失败 ${d.failed}`);
  const fresh = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(m.id);
  return ok(res, { ...messageView(fresh, who.username), delivery: d });
}));

/** 协同任务完成（只针对无原任务的通用协同任务；有原任务的去原单办） */
router.post('/tasks/:id/done', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const task = db.prepare('SELECT * FROM mail_tasks WHERE id = ?').get(req.params.id);
  if (!task) return fail(res, 404, '协同任务不存在');
  if (task.owner !== who.username && task.created_by !== who.username && who.role !== 'admin') {
    return fail(res, 403, '只有主责人或创建人可以结案');
  }
  if (task.status !== 'open') return fail(res, 400, '这个任务已经结案或取消');
  const b = req.body || {};
  db.prepare("UPDATE mail_tasks SET status = 'done', done_at = ?, done_note = ?, updated_at = ? WHERE id = ?")
    .run(now(), b.note || null, now(), task.id);
  return ok(res, db.prepare('SELECT * FROM mail_tasks WHERE id = ?').get(task.id));
}));

/** 我的协同任务 */
router.get('/tasks/mine', authRequired, wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const rows = db.prepare(
    `SELECT t.*, m.subject, m.message_no, m.sender_name FROM mail_tasks t
     LEFT JOIN mail_messages m ON m.id = t.message_id
     WHERE (t.owner = ? OR t.created_by = ?) AND t.status = ?
     ORDER BY (t.due_at IS NULL), t.due_at, t.id DESC`
  ).all(who.username, who.username, req.query.status || 'open');
  return ok(res, rows);
}));

/* ---------------- 代理授权 ---------------- */

router.get('/delegates', authRequired, wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const rows = db.prepare(
    'SELECT * FROM mail_delegates WHERE owner = ? OR agent = ? ORDER BY id DESC'
  ).all(who.username, who.username).map((d) => {
    const expired = d.end_at < now();
    return { ...d, effective: d.status === 'active' && !expired, expired };
  });
  return ok(res, rows);
}));

router.post('/delegates', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const b = req.body || {};
  const owner = String(b.owner || who.username);
  const agent = String(b.agent || '').trim();
  if (!activeUser(agent)) return fail(res, 400, '代理人不是有效员工账号');
  if (agent === owner) return fail(res, 400, '不能自己代理自己');
  if (owner !== who.username && who.role !== 'admin') return fail(res, 403, '只能设置自己的代理（管理员可代设）');
  if (!b.start_at || !b.end_at) return fail(res, 400, '代理必须有起止时间');
  if (b.end_at <= b.start_at) return fail(res, 400, '代理结束时间必须晚于开始时间');
  const t = now();
  const info = db.prepare(
    'INSERT INTO mail_delegates (owner, agent, scope, start_at, end_at, status, reason, created_by, created_at) VALUES (?,?,?,?,?, \'active\', ?, ?, ?)'
  ).run(owner, agent, ['all', 'ack', 'send'].includes(b.scope) ? b.scope : 'all', b.start_at, b.end_at, b.reason || null, who.username, t);
  return ok(res, db.prepare('SELECT * FROM mail_delegates WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.post('/delegates/:id/revoke', authRequired, requireRole(ANY), wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const who = me(req);
  const d = db.prepare('SELECT * FROM mail_delegates WHERE id = ?').get(req.params.id);
  if (!d) return fail(res, 404, '代理授权不存在');
  if (d.owner !== who.username && who.role !== 'admin') return fail(res, 403, '只有委托人可以撤销');
  db.prepare("UPDATE mail_delegates SET status = 'revoked' WHERE id = ?").run(d.id);
  return ok(res, db.prepare('SELECT * FROM mail_delegates WHERE id = ?').get(d.id));
}));

/**
 * 读信（只有这里会写首次已读；发件人自己看不写）
 * 列表摘要、批量选中、后台读取都不算已读
 */
router.get('/:id', authRequired, wrap(async (req, res) => {
  if (rejectCustomer(req, res)) return;
  const u = me(req).username;
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(req.params.id);
  if (!m) return fail(res, 404, '邮件不存在');
  if (!canRead(m, u, req.user.role)) {
    audit(m.id, m.thread_id, 'read_body', u, '无权读取，已拒绝');
    return fail(res, 403, '你不是这封信的收发人，无权查看正文（管理员也不默认读员工正文）');
  }
  const t = now();
  const mine = myRow(m.id, u);
  if (mine && !mine.first_read_at && m.sender !== u) {
    db.prepare('UPDATE mail_recipients SET first_read_at = ?, read_flag = 0 WHERE id = ?').run(t, mine.id);
    event(m.id, mine.id, 'read', '首次打开正文', u, t);
  } else if (mine && mine.read_flag === 1 && m.sender !== u) {
    db.prepare('UPDATE mail_recipients SET read_flag = 0 WHERE id = ?').run(mine.id);
  }
  const view = messageView(m, u);
  view.thread = visibleThread(m.thread_id, u).map((x) => ({ id: x.id, subject: x.subject, sender_name: x.sender_name, created_at: x.created_at, type: x.type, version: x.version }));
  return ok(res, view);
}));


module.exports = router;
