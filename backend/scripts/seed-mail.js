/**
 * 内部邮件演示数据（P1 / 原型 TS-N01-05 ~ TS-N01-09）
 *   node scripts/seed-mail.js
 *
 * 做的事：
 *   1) 补几个跨部门的演示账号（原来只有 admin + 一个 sales01，没有通讯录可展开）
 *   2) 造 4 封演示邮件：
 *      · 需确认（关联订单 5，1 人已确认 / 1 人提疑问 / 1 人未读）
 *      · 需办理（关联首件单，只读投影，办理仍在原单）
 *      · 普通沟通 + 回复（同一会话两个来回）
 *      · 抄送为主的一封普通邮件
 *   3) 建一条代理授权（admin 委托李工代确认）
 *
 * 幂等：已存在的账号 / 已存在的邮件主题会跳过。
 */
const crypto = require('crypto');
const { db, now } = require('../src/db');
const { hashPassword } = require('../src/auth/password');

const PWD = 'admin123456';
const t = now();

// 本脚本造的邮件主题前缀（--reset 时按这些前缀清掉，可重复执行）
const DEMO_LIKE = ['SO202610260005 面料改用%', '%首件按 V1 重做%', '领口罗纹 2×2%', 'Re: 领口罗纹%',
  '本周外贸面料到货计划%', '11 月面料到货台账%', '测试%', '%测试%'];

if (process.argv.includes('--reset')) {
  const ids = db.prepare(`SELECT id FROM mail_messages WHERE ${DEMO_LIKE.map(() => 'subject LIKE ?').join(' OR ')}`).all(...DEMO_LIKE).map((x) => x.id);
  if (ids.length) {
    const inList = ids.join(',');
    db.prepare(`DELETE FROM mail_delivery_events WHERE message_id IN (${inList})`).run();
    db.prepare(`DELETE FROM mail_audits WHERE message_id IN (${inList})`).run();
    db.prepare(`DELETE FROM mail_tasks WHERE message_id IN (${inList})`).run();
    db.prepare(`DELETE FROM mail_recipients WHERE message_id IN (${inList})`).run();
    db.prepare(`DELETE FROM mail_messages WHERE id IN (${inList})`).run();
    console.log(`已清理 ${ids.length} 封演示/测试邮件`);
  }
  const ths = db.prepare('SELECT id FROM mail_threads WHERE message_count = 0 OR message_count IS NULL').all().map((x) => x.id);
  if (ths.length) db.prepare(`DELETE FROM mail_threads WHERE id IN (${ths.join(',')})`).run();
  db.prepare("DELETE FROM mail_delegates WHERE owner = 'admin' AND agent = 'tech01'").run();
  console.log('已清理空的会话与演示代理授权');
}

/* ---------- 1. 演示账号 ---------- */
const USERS = [
  { username: 'tech01', name: '李工', role: 'tech', dept: 2 },
  { username: 'prod01', name: '赵主管', role: 'production', dept: 4 },
  { username: 'wh01', name: '周仓管', role: 'warehouse', dept: 5 },
  { username: 'fin01', name: '钱会计', role: 'finance', dept: 3 },
  { username: 'hr01', name: '孙人事', role: 'sales', dept: 6 }
];

let created = 0;
USERS.forEach((u) => {
  const exist = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
  if (exist) {
    db.prepare('UPDATE users SET name = ?, role = ?, department_id = ?, active = 1 WHERE id = ?')
      .run(u.name, u.role, u.dept, exist.id);
    return;
  }
  const companyId = db.prepare('SELECT id FROM companies ORDER BY id LIMIT 1').get();
  db.prepare('INSERT INTO users (username, password_hash, name, role, department_id, company_id, active, created_at) VALUES (?,?,?,?,?,?,1,?)')
    .run(u.username, hashPassword(PWD), u.name, u.role, u.dept, companyId ? companyId.id : null, t);
  created++;
});
// sales01 的部门与角色修正（原来没有部门，角色写成 warehouse）
const s1 = db.prepare("SELECT id FROM users WHERE username = 'sales01'").get();
if (s1) db.prepare("UPDATE users SET role = 'sales', department_id = 1, name = '销售小王' WHERE id = ?").run(s1.id);
console.log(`账号：新建 ${created} 个，其余已存在（密码统一 ${PWD}）`);

const uid = (u) => {
  const r = db.prepare('SELECT id, name, department_id FROM users WHERE username = ?').get(u);
  return r;
};
const deptName = (id) => {
  const d = id ? db.prepare('SELECT name FROM departments WHERE id = ?').get(id) : null;
  return d ? d.name : null;
};

/* ---------- 工具 ---------- */
function nextNo(prefix, table, field) {
  const ymd = t.slice(0, 10).replace(/-/g, '');
  const row = db.prepare(`SELECT ${field} AS no FROM ${table} WHERE ${field} LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}${ymd}%`);
  const seq = row ? Number(String(row.no).slice(-4)) + 1 : 1;
  return `${prefix}${ymd}${String(seq).padStart(4, '0')}`;
}

function makeThread(subject, source) {
  const exist = db.prepare('SELECT * FROM mail_threads WHERE subject = ?').get(subject);
  if (exist) return exist;
  const info = db.prepare(
    'INSERT INTO mail_threads (thread_no, subject, source_type, source_id, source_label, message_count, last_message_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?,?,?)'
  ).run(nextNo('TH', 'mail_threads', 'thread_no'), subject, source ? source.type : null,
    source ? source.id : null, source ? source.label : null, t, 'admin', t, t);
  return db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(Number(info.lastInsertRowid));
}

function makeMessage(o) {
  const dup = db.prepare('SELECT * FROM mail_messages WHERE subject = ? AND sender = ?').get(o.subject, o.sender);
  if (dup) return dup;
  const s = uid(o.sender);
  const info = db.prepare(
    `INSERT INTO mail_messages (message_no, thread_id, parent_id, subject, body, type, sender, sender_name, sender_dept,
      acting_for, company_id, source_type, source_id, source_label, attachments, request_no, version,
      confirm_due, task_due, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'sent', ?)`
  ).run(
    nextNo('EM', 'mail_messages', 'message_no'), o.thread_id, o.parent_id || null, o.subject, o.body, o.type,
    o.sender, s ? s.name : o.sender, deptName(s ? s.department_id : null), null, 1,
    o.source ? o.source.type : null, o.source ? o.source.id : null, o.source ? o.source.label : null,
    '[]', 'SEED' + crypto.randomBytes(6).toString('hex'), 1, o.confirm_due || null, o.task_due || null, t
  );
  const msgId = Number(info.lastInsertRowid);
  db.prepare('UPDATE mail_threads SET message_count = message_count + 1, last_message_at = ? WHERE id = ?').run(t, o.thread_id);
  return db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(msgId);
}

function addRcpt(msgId, username, kind, opt = {}) {
  const u = uid(username);
  const mustAck = opt.must_ack ? 1 : 0;
  db.prepare(
    `INSERT OR IGNORE INTO mail_recipients (message_id, user_id, username, name, department, kind, must_ack,
      delivery_status, deliver_attempt, delivered_at, first_read_at, read_flag, ack_state, ack_at, ack_note, question)
     VALUES (?,?,?,?,?,?,?, 'delivered', 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    msgId, u ? u.id : null, username, u ? u.name : username, deptName(u ? u.department_id : null), kind, mustAck,
    t, opt.read_at || null, opt.read_at ? 0 : 1, opt.ack_state || (mustAck ? 'pending' : 'none'),
    opt.ack_at || null, opt.ack_note || null, opt.question || null
  );
  const row = db.prepare('SELECT id FROM mail_recipients WHERE message_id = ? AND username = ?').get(msgId, username);
  if (row) {
    db.prepare('INSERT INTO mail_delivery_events (message_id, recipient_id, event, detail, operator, created_at) VALUES (?,?,?,?,?,?)')
      .run(msgId, row.id, 'deliver', '已送达', null, t);
    if (opt.read_at) {
      db.prepare('INSERT INTO mail_delivery_events (message_id, recipient_id, event, detail, operator, created_at) VALUES (?,?,?,?,?,?)')
        .run(msgId, row.id, 'read', '首次打开正文', username, opt.read_at);
    }
  }
}

/* ---------- 2. 演示邮件 ---------- */
const order = db.prepare('SELECT * FROM orders WHERE id = 5').get();
const fa = db.prepare('SELECT * FROM first_articles ORDER BY id DESC LIMIT 1').get();

// ① 需确认：面料换缸，关联订单
if (order) {
  const th = makeThread(`SO202610260005 面料改用 A2312 缸，请确认`, { type: 'order', id: order.id, label: `订单 ${order.order_no}` });
  const m = makeMessage({
    thread_id: th.id,
    subject: `SO202610260005 面料改用 A2312 缸，请确认`,
    type: 'confirm',
    sender: 'admin',
    body: `各位：\n\nA2310 缸余料不足，供应商补发的 30 米是 A2312 缸。同单混缸会出色差，技术、生产、仓库三方各自确认一下能否接受：\n\n`
      + `1) 技术：色差是否在客户可接受范围\n2) 生产：是否需要分床裁剪\n3) 仓库：A2312 缸是否已过检验\n\n`
      + `请在截止前点「确认知悉」。有疑问直接提，别只在群里说一句"收到"。\n\n仓库补的那 30 米还在待检，检验合格才算可用。`,
    source: { type: 'order', id: order.id, label: `订单 ${order.order_no}` },
    confirm_due: new Date(Date.now() + 86400000).toISOString().slice(0, 16).replace('T', ' ')
  });
  addRcpt(m.id, 'tech01', 'to', { must_ack: 1, read_at: t, ack_state: 'acked', ack_at: t, ack_note: '色差 4 级以内，可接受' });
  addRcpt(m.id, 'prod01', 'to', { must_ack: 1, read_at: t, ack_state: 'questioned', question: 'A2312 缸的颜色偏深，能不能只做 S 码？M 码还是用 A2310。' });
  addRcpt(m.id, 'wh01', 'to', { must_ack: 1 });
  addRcpt(m.id, 'fin01', 'cc', {});
  console.log('① 需确认（订单 5）→ 李工已确认 / 赵主管提疑问 / 周仓管未读');
}

// ② 需办理：关联首件单，只读投影
if (fa) {
  const th = makeThread(`${fa.fa_no} 首件按 V1 重做，出结果后回复`, { type: 'first_article', id: fa.id, label: `首件 ${fa.fa_no}` });
  const m = makeMessage({
    thread_id: th.id,
    subject: `${fa.fa_no} 首件按 V1 重做，出结果后回复`,
    type: 'task',
    sender: 'admin',
    body: `赵主管：\n\n${fa.fa_no} 的 11 项已经测完待复核，但首件还没放行，车缝报工被系统拦着。\n\n`
      + `请按冻结版 V1 重做一件，尺寸全测（4 项）、关键工艺 6 项逐条核，结果填回首件单再提交复核。\n\n`
      + `注意：这封邮件只关联首件单，办理和放行都在首件单里做，邮件里改不了状态。`,
    source: { type: 'first_article', id: fa.id, label: `首件 ${fa.fa_no}` },
    task_due: new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  });
  addRcpt(m.id, 'prod01', 'to', { read_at: t });
  addRcpt(m.id, 'tech01', 'cc', { read_at: t });
  console.log(`② 需办理（首件 ${fa.fa_no}）→ 赵主管主责，李工抄送`);
}

// ③ 普通沟通 + 回复：同一会话两个来回
{
  const th = makeThread('领口罗纹 2×2 已按客供样试做', null);
  const m1 = makeMessage({
    thread_id: th.id,
    subject: '领口罗纹 2×2 已按客供样试做',
    type: 'normal',
    sender: 'tech01',
    body: `按客供样打了三件领口罗纹 2×2，拉伸回复率实测 93%，比客供样高 2 个点。\n\n`
      + `机器用绷缝机，线用 40s/2 涤纶，针距 3mm。照片回头传到开发单里。\n\n如果客户问起，可以说是按客供样 1:1 复制的。`
  });
  addRcpt(m1.id, 'admin', 'to', { read_at: t });
  const m2 = makeMessage({
    thread_id: th.id,
    parent_id: m1.id,
    subject: 'Re: 领口罗纹 2×2 已按客供样试做',
    type: 'normal',
    sender: 'admin',
    body: `收到，93% 可以。\n\n提醒一句：客户在开发单里写的是"拉伸回复率不低于 90%"，93% 达标，但别为了好看往上拉，回复率太高领口会勒。\n\n照片记得传到开发单的工艺页，别只发在邮件里——邮件附件不替代工艺单。`
  });
  addRcpt(m2.id, 'tech01', 'to', { read_at: t });
  console.log('③ 普通沟通会话（李工 ↔ 管理员，两个来回）');
}

// ④ 抄送为主的普通邮件
{
  const th = makeThread('本周外贸面料到货计划（10/27-11/02）', null);
  const m = makeMessage({
    thread_id: th.id,
    subject: '本周外贸面料到货计划（10/27-11/02）',
    type: 'normal',
    sender: 'wh01',
    body: `本周到货：\n\n· 2099# 极蓝棉 220G：800 米，蒙特布料，预计 11-02\n· 600 32S 精梳拉架：已到 480 米 + 补发 30 米（A2312 缸，待检）\n\n`
      + `提醒：到货只进「待检」，检验合格才进可用库存。别按到货数量去排产，齐套看板看的是合格可用量。`
  });
  addRcpt(m.id, 'admin', 'to', {});   // 留作未读，演示顶部红点与首次已读
  addRcpt(m.id, 'tech01', 'cc', {});
  addRcpt(m.id, 'prod01', 'cc', {});
  console.log('④ 普通沟通 + 抄送（周仓管发起，技术/生产抄送）');
}

// ⑤ 需办理 + 协同任务（没有原任务时，建唯一协同任务；主责一人）
{
  const th = makeThread('11 月面料到货台账请按供应商整理', null);
  const m = makeMessage({
    thread_id: th.id,
    subject: '11 月面料到货台账请按供应商整理',
    type: 'task',
    sender: 'admin',
    body: `孙人事：\n\n麻烦按供应商把 11 月的面料到货台账整理出来，我要拿去看供应商履约。\n\n`
      + `口径：\n· 按供应商分组，列出采购量 / 实收 / 合格 / 冻结 / 退回\n· 待检量单列，不能算进"已到货"\n`
      + `· 短收和超收各标一列，超收的原因要带上\n\n数据从「仓储 → 原料收货检验」导。做完在这封邮件里点「完成」，别只在群里说一声。`
  });
  addRcpt(m.id, 'hr01', 'to', {});
  addRcpt(m.id, 'wh01', 'cc', {});
  const taskNo = `RW${t.slice(0, 10).replace(/-/g, '')}0001`;
  const exist = db.prepare('SELECT id FROM mail_tasks WHERE message_id = ?').get(m.id);
  if (!exist) {
    db.prepare(
      'INSERT INTO mail_tasks (task_no, message_id, thread_id, title, owner, due_at, requirement, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(taskNo, m.id, th.id, '整理 11 月面料到货台账', 'hr01',
      new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
      '按供应商分组，含采购量/实收/合格/冻结/退回，待检量单列，超收带原因', 'open', 'admin', t, t);
  }
  console.log('⑤ 需办理 + 协同任务（孙人事主责，周仓管抄送）');
}

/* ---------- 3. 代理授权 ---------- */
{
  const exist = db.prepare("SELECT id FROM mail_delegates WHERE owner = 'admin' AND agent = 'tech01'").get();
  if (!exist) {
    db.prepare(
      'INSERT INTO mail_delegates (owner, agent, scope, start_at, end_at, status, reason, created_by, created_at) VALUES (?,?,?,?,?, \'active\', ?, ?, ?)'
    ).run('admin', 'tech01', 'ack',
      new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      '出差期间由李工代确认技术类邮件', 'admin', t);
    console.log('⑤ 代理授权：admin → 李工（只代确认，7 天）');
  }
}

// 校正会话信件数（多次重置后不会虚增）
db.exec("UPDATE mail_threads SET message_count = (SELECT COUNT(*) FROM mail_messages m WHERE m.thread_id = mail_threads.id)");

console.log('\n完成。打开「工作台 → 内部邮件」或顶部邮件图标查看。');
