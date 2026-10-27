/**
 * 客户营销与消息（原型 M24）
 * ============================================================
 * 六个节点：上新与到货提醒 / 采购周期与回访任务 / 站内与邮件通知 /
 *           微信通知与渠道降级 / 发送频控与审计 / 营销效果与销售归因
 *
 * 七条不能松的口径（每条都对应原型里一句明确规则）：
 *
 * 1. **事件与发送分两层**
 *    一件「上新」只有一条事件，但要发给 N 个订阅了该款号的客户 → N 条发送计划。
 *    两层各有幂等键：事件层防同一件事重复触发，发送层防同一客户同一渠道重复发。
 *
 * 2. **上新/到货提醒必须「发布审核通过 + 可售 > 0」**
 *    草稿商品、还没上架的商品不能提醒，否则客户点进去买不到，
 *    比不发更伤 —— 这是「到货提醒在合格上架且可售量大于零后触发」的原话。
 *
 * 3. **只发有商品权限且有通知资格的客户**
 *    客户账号必须 active 且有 catalog.view；没订阅、订阅被退的，一律不发（记 skipped 留痕）。
 *
 * 4. **订单通知与营销订阅分开**
 *    退订营销只关 marketing，不影响 order / service / arrival；
 *    退订是改状态，**不删订阅行** —— 删了就没有「他什么时候退的、为什么退」的记录。
 *
 * 5. **渠道不可用就降级，不能假装发过**
 *    微信未授权/未绑定 → 降级到站内（有订阅时），并把 `degraded_from` 记下来；
 *    邮件未核验 → 降级到站内；一个可用渠道都没有才 skip。
 *    **系统不会声称已通过微信发出**，除非渠道能力是 enabled + verified。
 *
 * 6. **频控只管营销，不管业务通知**
 *    订单状态、询价回复这类业务通知不受营销频控限制（否则客户收不到发货通知）；
 *    营销摘要按客户当地时间静默时段 + 日/周上限 + 最小间隔。
 *
 * 7. **回执分级，未知不算已读**
 *    submitted（已提交）→ delivered（送达）→ read（已读）。
 *    「打开邮件」只记 opened_at，**不改 read_at**；没收到送达回执就报已读，直接拒。
 *    失败有限重试（默认 3 次），重试仍失败就停在 failed，转人工跟进。
 *
 * 时间口径：本地墙钟字符串（services/sla.js）。
 */
const { db } = require('../db');
const { localNow, localDate } = require('./sla');
const CP = require('./customerPerms');
const MALL = require('./mall');

/** ==================== 常量 ==================== */

const CHANNELS = [
  { k: 'site', v: '站内消息' },
  { k: 'email', v: '邮件' },
  { k: 'wechat', v: '微信' }
];

const TOPICS = [
  { k: 'order', v: '订单通知', transactional: true },
  { k: 'service', v: '服务通知', transactional: true },
  { k: 'arrival', v: '上新与到货', transactional: false },
  { k: 'marketing', v: '营销推广', transactional: false }
];

const EVENT_KINDS = [
  { k: 'new_product', v: '上新提醒', topic: 'arrival' },
  { k: 'restock', v: '到货提醒', topic: 'arrival' },
  { k: 'order_status', v: '订单状态', topic: 'order' },
  { k: 'cycle_due', v: '补货提醒', topic: 'marketing' },
  { k: 'promo_digest', v: '营销摘要', topic: 'marketing' },
  { k: 'inquiry_reply', v: '询价回复', topic: 'service' }
];

const OUT_STATUS_LABEL = {
  queued: '待发送', held: '频控暂缓', submitted: '已提交', delivered: '已送达',
  read: '已读', failed: '发送失败', skipped: '已跳过'
};

const SUB_STATUS_LABEL = { subscribed: '已订阅', unsubscribed: '已退订', never: '未订阅' };
const VERIFY_LABEL = { none: '未核验', pending: '待核验', verified: '已核验', failed: '核验失败' };
const TP_STATUS_LABEL = { draft: '草稿', pending: '待审核', approved: '生效中', retired: '已停用' };
const ATTR_STAGE_LABEL = { delivered: '已送达', read: '已读', inquiry: '已询价', order: '已下单' };

const FREQ_FALLBACK = { max_per_day: 1, max_per_week: 4, min_gap_minutes: 720, quiet_start: '21:00', quiet_end: '08:00', digest_hour: 10 };

/** ==================== 基础工具 ==================== */

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const p2 = (n) => String(n).padStart(2, '0');
const now = () => localNow();
const today = () => localDate();
const me = (op) => (op && (op.name || op.username)) || 'system';

function addDays(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + Number(n || 0));
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function shiftHours(hours) {
  const d = new Date(Date.now() + Number(hours || 0) * 3600 * 1000);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/**
 * 单号取「已有最大号 + 1」。
 * 不用 COUNT(*)+1：中间删过一条就会撞号，而且只在偶发时炸（这个坑踩过）。
 */
function nextNo(prefix, table, col) {
  const d = today().replace(/-/g, '');
  const head = `${prefix}${d}`;
  const rows = db.prepare(`SELECT ${col} n FROM ${table} WHERE ${col} LIKE ?`).all(`${head}%`);
  let max = 0;
  rows.forEach((r) => {
    const v = Number(String(r.n).slice(head.length));
    if (Number.isFinite(v) && v > max) max = v;
  });
  return `${head}${String(max + 1).padStart(4, '0')}`;
}

/** 客户当地时间（小时）。有 Intl 用 Intl，没有就退到固定偏移表（不处理夏令时）。 */
const TZ_OFFSET = {
  'Asia/Shanghai': 8, 'Asia/Tokyo': 9, 'Asia/Seoul': 9, 'Asia/Singapore': 8,
  'Europe/London': 0, 'Europe/Berlin': 1, 'Europe/Paris': 1,
  'America/New_York': -4, 'America/Chicago': -5, 'America/Los_Angeles': -7
};

function localHourOf(tz) {
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date());
    const h = Number(String(s).replace(/\D/g, ''));
    if (Number.isFinite(h)) return h % 24;
  } catch (e) { /* 落到固定偏移 */ }
  const off = TZ_OFFSET[tz] === undefined ? 8 : TZ_OFFSET[tz];
  return (new Date().getUTCHours() + off + 24) % 24;
}

function hmToMinutes(hm) {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 静默时段（支持跨零点，如 21:00 → 08:00） */
function inQuiet(hour, start, end) {
  const s = hmToMinutes(start);
  const e = hmToMinutes(end);
  if (s === null || e === null) return false;
  const cur = hour * 60;
  if (s === e) return false;
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

/** 分钟差：'YYYY-MM-DD HH:mm:ss' */
function minutesBetween(a, b) {
  const ta = new Date(String(a).replace(' ', 'T')).getTime();
  const tb = new Date(String(b).replace(' ', 'T')).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 60000);
}

/** ==================== 字典 ==================== */

function capOf(companyId, channel) {
  const c = db.prepare('SELECT * FROM msg_channel_capabilities WHERE company_id=? AND channel=?')
    .get(Number(companyId) || 1, channel);
  if (c) return c;
  // 站内是系统自带能力；邮件/微信未配置时按「未授权」处理，绝不默认可用
  return {
    channel,
    status: channel === 'site' ? 'enabled' : 'unauthorized',
    verify_status: channel === 'site' ? 'verified' : 'unverified',
    evidence: channel === 'site' ? '系统内置' : null,
    reason: channel === 'site' ? null : '尚未完成渠道授权与验收'
  };
}

function capUsable(companyId, channel) {
  const c = capOf(companyId, channel);
  return c.status === 'enabled' && c.verify_status === 'verified';
}

function accountOf(customerId) {
  return db.prepare(`SELECT * FROM customer_accounts WHERE customer_id=? AND status='active'
    ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, id LIMIT 1`).get(Number(customerId));
}

/** 有商品权限且有通知资格：账号 active + catalog.view */
function eligibleAccount(customerId) {
  const rows = db.prepare("SELECT * FROM customer_accounts WHERE customer_id=? AND status='active'").all(Number(customerId));
  return rows.find((a) => CP.hasPerm(a, 'catalog.view')) || null;
}

function subOf(customerId, topic, channel) {
  return db.prepare('SELECT * FROM msg_subscriptions WHERE customer_id=? AND topic=? AND channel=?')
    .get(Number(customerId), topic, channel);
}

/** 订阅能不能用：已订阅；邮件还要核验通过 */
function subUsable(sub, channel) {
  if (!sub || sub.status !== 'subscribed') return false;
  if (channel === 'email' && sub.verify_status !== 'verified') return false;
  return true;
}

function dict() {
  const companyId = 1;
  return {
    channels: CHANNELS.map((c) => ({ ...c, ...capOf(companyId, c.k), usable: capUsable(companyId, c.k) })),
    topics: TOPICS,
    events: EVENT_KINDS,
    outbox_status: Object.entries(OUT_STATUS_LABEL).map(([k, v]) => ({ k, v })),
    sub_status: Object.entries(SUB_STATUS_LABEL).map(([k, v]) => ({ k, v })),
    verify_status: Object.entries(VERIFY_LABEL).map(([k, v]) => ({ k, v })),
    template_status: Object.entries(TP_STATUS_LABEL).map(([k, v]) => ({ k, v })),
    attr_stage: Object.entries(ATTR_STAGE_LABEL).map(([k, v]) => ({ k, v })),
    langs: [{ k: 'zh', v: '中文' }, { k: 'en', v: 'English' }],
    frequencies: [{ k: 'immediate', v: '即时' }, { k: 'daily', v: '每日摘要' }, { k: 'weekly', v: '每周摘要' }],
    timezones: Object.keys(TZ_OFFSET),
    companies: db.prepare('SELECT id,code,name FROM companies ORDER BY id').all(),
    customers: db.prepare(`SELECT c.id,c.code,c.name FROM customers c
      WHERE c.status<>'disabled' ORDER BY c.id DESC LIMIT 200`).all(),
    today: today()
  };
}

/** ==================== 订阅 ==================== */

function listSubs(q = {}) {
  let rows = db.prepare(`SELECT s.*, c.name customer_name, c.code customer_code
    FROM msg_subscriptions s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.customer_id, s.topic, s.channel`).all();
  if (q.customer_id) rows = rows.filter((r) => Number(r.customer_id) === Number(q.customer_id));
  if (q.topic) rows = rows.filter((r) => r.topic === q.topic);
  if (q.channel) rows = rows.filter((r) => r.channel === q.channel);
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.q) rows = rows.filter((r) => String(r.customer_name || '').includes(q.q) || String(r.customer_code || '').includes(q.q));
  return rows.map((r) => ({
    ...r,
    topic_label: (TOPICS.find((t) => t.k === r.topic) || {}).v || r.topic,
    channel_label: (CHANNELS.find((c) => c.k === r.channel) || {}).v || r.channel,
    status_label: SUB_STATUS_LABEL[r.status] || r.status,
    verify_label: VERIFY_LABEL[r.verify_status] || r.verify_status,
    usable: subUsable(r, r.channel)
  }));
}

/** 订阅/退订：退订只改状态，不删行 —— 删了就没有「何时退、为什么退」的记录 */
function upsertSub(b, op) {
  const customerId = Number(b.customer_id);
  if (!customerId) throw new Error('必须选客户');
  const topic = String(b.topic || '');
  const channel = String(b.channel || '');
  if (!TOPICS.some((t) => t.k === topic)) throw new Error('订阅主题不合法');
  if (!CHANNELS.some((c) => c.k === channel)) throw new Error('通知渠道不合法');
  if (!db.prepare('SELECT id FROM customers WHERE id=?').get(customerId)) throw new Error('客户不存在');

  // 邮件订阅必须有邮箱，否则核验无从谈起
  const account = accountOf(customerId);
  if (channel === 'email' && !(account && account.email)) {
    throw new Error('这个客户还没有邮箱，先补邮箱再订阅邮件通知');
  }
  if (channel === 'wechat') {
    const bind = db.prepare('SELECT * FROM msg_wechat_bindings WHERE customer_id=?').get(customerId);
    if (!bind) throw new Error('客户还没绑定微信，不能订阅微信通知');
    if (bind.subscribe_status !== 'subscribed') throw new Error('客户在微信侧未关注/已取消关注，不能订阅');
  }

  const status = b.status === 'unsubscribed' ? 'unsubscribed' : 'subscribed';
  const cur = subOf(customerId, topic, channel);
  const verify = channel === 'email'
    ? (cur && cur.verify_status === 'verified' ? 'verified' : (status === 'subscribed' ? 'pending' : (cur ? cur.verify_status : 'none')))
    : 'none';
  const t = now();

  if (cur) {
    db.prepare(`UPDATE msg_subscriptions SET status=?, opt_in_source=?, opt_in_at=?, opt_out_at=?, opt_out_reason=?,
      verify_status=?, locale=?, timezone=?, frequency=?, remark=?, updated_at=? WHERE id=?`).run(
      status,
      b.opt_in_source || cur.opt_in_source || 'account',
      status === 'subscribed' ? (cur.opt_in_at || t) : cur.opt_in_at,
      status === 'unsubscribed' ? t : null,
      status === 'unsubscribed' ? (b.reason || '客户/销售操作退订') : null,
      verify, b.locale || cur.locale || 'zh', b.timezone || cur.timezone || 'Asia/Shanghai',
      b.frequency || cur.frequency || 'immediate', b.remark !== undefined ? b.remark : cur.remark, t, cur.id
    );
    return { ...listSubs({ customer_id: customerId }).find((x) => x.id === cur.id), changed: 'updated' };
  }

  db.prepare(`INSERT INTO msg_subscriptions
    (customer_id,account_id,topic,channel,status,opt_in_source,opt_in_at,opt_out_at,opt_out_reason,
     verify_status,locale,timezone,frequency,remark,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    customerId, account ? account.id : null, topic, channel, status,
    b.opt_in_source || 'account', status === 'subscribed' ? t : null,
    status === 'unsubscribed' ? t : null, status === 'unsubscribed' ? (b.reason || '客户/销售操作退订') : null,
    verify, b.locale || 'zh', b.timezone || 'Asia/Shanghai', b.frequency || 'immediate',
    b.remark || null, t, t
  );
  const id = db.prepare('SELECT id FROM msg_subscriptions WHERE customer_id=? AND topic=? AND channel=?')
    .get(customerId, topic, channel).id;
  return { ...listSubs({ customer_id: customerId }).find((x) => x.id === id), changed: 'created' };
}

/**
 * 退订营销：只关 marketing，订单/服务/上新照常。
 * 这是原型里「退订营销不删除必要业务记录」的落点。
 */
function unsubscribeMarketing(customerId, b, op) {
  const rows = db.prepare("SELECT * FROM msg_subscriptions WHERE customer_id=? AND topic='marketing' AND status='subscribed'")
    .all(Number(customerId));
  if (!rows.length) throw new Error('这个客户没有生效中的营销订阅');
  const t = now();
  rows.forEach((r) => {
    db.prepare(`UPDATE msg_subscriptions SET status='unsubscribed', opt_out_at=?, opt_out_reason=?, updated_at=? WHERE id=?`)
      .run(t, b.reason || '客户退订营销', t, r.id);
  });
  const kept = db.prepare(`SELECT COUNT(*) c FROM msg_subscriptions WHERE customer_id=? AND topic IN ('order','service','arrival') AND status='subscribed'`)
    .get(Number(customerId)).c;
  return {
    unsubscribed: rows.length,
    business_subs_kept: kept,
    note: '营销订阅已退订；订单、服务、上新到货通知不受影响（业务记录不删）'
  };
}

/** 邮箱核验：发起 → 生成校验串；确认 → 置 verified */
function requestEmailVerify(customerId, op) {
  const sub = subOf(customerId, 'order', 'email') || db.prepare("SELECT * FROM msg_subscriptions WHERE customer_id=? AND channel='email' LIMIT 1").get(Number(customerId));
  if (!sub) throw new Error('这个客户还没订阅任何邮件通知');
  if (sub.verify_status === 'verified') throw new Error('邮箱已经核验过了');
  const token = `VF${Date.now().toString(36).toUpperCase()}${String(Number(customerId)).padStart(3, '0')}`;
  const t = now();
  db.prepare("UPDATE msg_subscriptions SET verify_status='pending', verify_token=?, updated_at=? WHERE customer_id=? AND channel='email'")
    .run(token, t, Number(customerId));
  return { verify_token: token, status: 'pending', note: '已生成核验串（生产环境由邮件服务发出链接，这里直接返回便于验收）' };
}

function confirmEmailVerify(customerId, b, op) {
  const subs = db.prepare("SELECT * FROM msg_subscriptions WHERE customer_id=? AND channel='email'").all(Number(customerId));
  if (!subs.length) throw new Error('没有邮件订阅记录');
  const pending = subs.find((s) => s.verify_status === 'pending');
  if (!pending) throw new Error('没有待核验的邮箱');
  if (b.token && pending.verify_token && String(b.token) !== String(pending.verify_token)) throw new Error('核验串不匹配');
  const t = now();
  db.prepare("UPDATE msg_subscriptions SET verify_status='verified', verified_at=?, verify_token=NULL, updated_at=? WHERE customer_id=? AND channel='email'")
    .run(t, t, Number(customerId));
  return { status: 'verified', verified_at: t };
}

/** ==================== 模板 ==================== */

function listTemplates(q = {}) {
  let rows = db.prepare(`SELECT * FROM msg_templates ORDER BY event_key, channel, lang, version DESC`).all();
  if (q.event_key) rows = rows.filter((r) => r.event_key === q.event_key);
  if (q.channel) rows = rows.filter((r) => r.channel === q.channel);
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.lang) rows = rows.filter((r) => r.lang === q.lang);
  return rows.map((r) => ({
    ...r,
    event_label: (EVENT_KINDS.find((e) => e.k === r.event_key) || {}).v || r.event_key,
    channel_label: (CHANNELS.find((c) => c.k === r.channel) || {}).v || r.channel,
    status_label: TP_STATUS_LABEL[r.status] || r.status,
    variables: r.variables_json ? JSON.parse(r.variables_json) : []
  }));
}

function getTemplate(id) {
  const r = db.prepare('SELECT * FROM msg_templates WHERE id=?').get(Number(id));
  if (!r) throw new Error('模板不存在');
  const siblings = db.prepare('SELECT id,version,status,approved_by,approved_at,change_note FROM msg_templates WHERE event_key=? AND channel=? AND lang=? ORDER BY version DESC')
    .all(r.event_key, r.channel, r.lang);
  return {
    ...r,
    variables: r.variables_json ? JSON.parse(r.variables_json) : [],
    event_label: (EVENT_KINDS.find((e) => e.k === r.event_key) || {}).v || r.event_key,
    channel_label: (CHANNELS.find((c) => c.k === r.channel) || {}).v || r.channel,
    status_label: TP_STATUS_LABEL[r.status] || r.status,
    versions: siblings
  };
}

function createTemplate(b, op) {
  const eventKey = String(b.event_key || '');
  const channel = String(b.channel || '');
  const lang = String(b.lang || 'zh');
  if (!EVENT_KINDS.some((e) => e.k === eventKey)) throw new Error('事件类型不合法');
  if (!CHANNELS.some((c) => c.k === channel)) throw new Error('渠道不合法');
  if (!['zh', 'en'].includes(lang)) throw new Error('语言不合法');
  if (!String(b.subject || '').trim()) throw new Error('模板标题不能为空');
  if (!String(b.body || '').trim()) throw new Error('模板正文不能为空');

  const last = db.prepare('SELECT MAX(version) v FROM msg_templates WHERE event_key=? AND channel=? AND lang=?')
    .get(eventKey, channel, lang).v || 0;
  const t = now();
  const info = db.prepare(`INSERT INTO msg_templates
    (template_no,company_id,event_key,channel,lang,version,subject,body,variables_json,status,change_note,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`).run(
    nextNo('MT', 'msg_templates', 'template_no'), Number(b.company_id) || 1,
    eventKey, channel, lang, Number(last) + 1,
    String(b.subject).trim(), String(b.body).trim(),
    JSON.stringify(extractVars(`${b.subject} ${b.body}`)),
    b.change_note || null, me(op), t, t
  );
  return getTemplate(info.lastInsertRowid);
}

function extractVars(text) {
  const set = new Set();
  String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => { set.add(k); return m; });
  return Array.from(set);
}

function updateTemplate(id, b, op) {
  const cur = db.prepare('SELECT * FROM msg_templates WHERE id=?').get(Number(id));
  if (!cur) throw new Error('模板不存在');
  if (cur.status === 'approved') throw new Error('生效中的模板不能改，要改请出新版本（旧版本会保留）');
  if (cur.status === 'retired') throw new Error('已停用的模板不能改');
  const subject = b.subject === undefined ? cur.subject : String(b.subject).trim();
  const body = b.body === undefined ? cur.body : String(b.body).trim();
  if (!subject || !body) throw new Error('模板标题与正文都不能为空');
  db.prepare('UPDATE msg_templates SET subject=?, body=?, variables_json=?, change_note=?, updated_at=? WHERE id=?')
    .run(subject, body, JSON.stringify(extractVars(`${subject} ${body}`)), b.change_note || cur.change_note, now(), cur.id);
  return getTemplate(cur.id);
}

function submitTemplate(id, op) {
  const cur = db.prepare('SELECT * FROM msg_templates WHERE id=?').get(Number(id));
  if (!cur) throw new Error('模板不存在');
  if (cur.status !== 'draft') throw new Error(`当前是「${TP_STATUS_LABEL[cur.status]}」，只有草稿能提交审核`);
  const vars = cur.variables_json ? JSON.parse(cur.variables_json) : [];
  if (!vars.length) throw new Error('模板里至少要有一个变量（如 {{customer_name}}），否则发给谁都是同一句话');
  db.prepare("UPDATE msg_templates SET status='pending', updated_at=? WHERE id=?").run(now(), cur.id);
  return getTemplate(cur.id);
}

/**
 * 审核通过：同事件同渠道同语言只能有一条生效 —— 旧的自动 retired。
 * 不是覆盖，是「新版生效、旧版保留」，这样历史消息仍能对上当时用的文案。
 */
function approveTemplate(id, b, op) {
  const cur = db.prepare('SELECT * FROM msg_templates WHERE id=?').get(Number(id));
  if (!cur) throw new Error('模板不存在');
  if (cur.status !== 'pending') throw new Error(`当前是「${TP_STATUS_LABEL[cur.status]}」，只有待审核的能批准`);
  if (cur.created_by && cur.created_by === me(op)) throw new Error('模板制单人不能自己批准');
  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE msg_templates SET status='retired', updated_at=? WHERE event_key=? AND channel=? AND lang=? AND status='approved' AND id<>?")
      .run(t, cur.event_key, cur.channel, cur.lang, cur.id);
    db.prepare("UPDATE msg_templates SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?")
      .run(me(op), t, t, cur.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getTemplate(cur.id);
}

function retireTemplate(id, b, op) {
  const cur = db.prepare('SELECT * FROM msg_templates WHERE id=?').get(Number(id));
  if (!cur) throw new Error('模板不存在');
  if (cur.status === 'retired') throw new Error('模板已经是停用状态');
  if (cur.status === 'approved' && !String(b.reason || '').trim()) throw new Error('停用生效中的模板必须写原因');
  db.prepare("UPDATE msg_templates SET status='retired', change_note=?, updated_at=? WHERE id=?")
    .run(b.reason || cur.change_note, now(), cur.id);
  return getTemplate(cur.id);
}

/** 删模板：只允许草稿或待审核（发错了要能撤；生效过的要留痕，只能停用不能删） */
function deleteTemplate(id, op) {
  const t = db.prepare('SELECT * FROM msg_templates WHERE id=?').get(Number(id));
  if (!t) throw new Error('模板不存在');
  if (!['draft', 'pending'].includes(t.status)) {
    throw new Error('只有草稿或待审核的模板可以删除；生效过的请用停用，历史消息要能对上文案');
  }
  db.prepare('DELETE FROM msg_templates WHERE id=?').run(t.id);
  return { deleted: 1, template_no: t.template_no, by: me(op) };
}

function approvedTemplate(eventKey, channel, lang) {
  return db.prepare("SELECT * FROM msg_templates WHERE event_key=? AND channel=? AND lang=? AND status='approved'")
    .get(eventKey, channel, lang) || null;
}

function renderTemplate(tpl, vars) {
  const missing = [];
  const fill = (text) => String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
    const v = vars[k];
    if (v === undefined || v === null || v === '') { missing.push(k); return m; }
    return String(v);
  });
  return { subject: fill(tpl.subject), body: fill(tpl.body), missing: Array.from(new Set(missing)) };
}

/** ==================== 渠道能力 / 微信绑定 ==================== */

function listCaps(companyId = 1) {
  return CHANNELS.map((c) => {
    const cap = capOf(companyId, c.k);
    return {
      ...cap,
      channel: c.k,
      channel_label: c.v,
      usable: cap.status === 'enabled' && cap.verify_status === 'verified',
      bindings: c.k === 'wechat'
        ? db.prepare("SELECT COUNT(*) c FROM msg_wechat_bindings WHERE subscribe_status='subscribed'").get().c
        : null
    };
  });
}

function setCap(b, op) {
  const channel = String(b.channel || '');
  if (!CHANNELS.some((c) => c.k === channel)) throw new Error('渠道不合法');
  if (channel === 'site') throw new Error('站内消息是系统内置能力，不需要也不允许改');
  const status = String(b.status || 'unauthorized');
  if (!['enabled', 'disabled', 'unauthorized'].includes(status)) throw new Error('渠道状态不合法');
  const verify = String(b.verify_status || (status === 'enabled' ? 'verified' : 'unverified'));
  if (!['verified', 'unverified'].includes(verify)) throw new Error('核验状态不合法');
  if (status === 'enabled' && verify !== 'verified') throw new Error('渠道要启用必须先完成授权验收（核验状态需为已核验）');
  if (status === 'enabled' && !String(b.evidence || '').trim()) throw new Error('启用渠道必须填写授权/验收依据');

  const companyId = Number(b.company_id) || 1;
  const cur = db.prepare('SELECT * FROM msg_channel_capabilities WHERE company_id=? AND channel=?').get(companyId, channel);
  const t = now();
  if (cur) {
    db.prepare('UPDATE msg_channel_capabilities SET status=?, verify_status=?, evidence=?, reason=?, verified_at=?, updated_at=? WHERE id=?')
      .run(status, verify, b.evidence || cur.evidence, b.reason || null,
        verify === 'verified' ? t : null, t, cur.id);
  } else {
    db.prepare(`INSERT INTO msg_channel_capabilities (company_id,channel,status,verify_status,evidence,reason,verified_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(companyId, channel, status, verify, b.evidence || null, b.reason || null,
      verify === 'verified' ? t : null, t);
  }
  return listCaps(companyId).find((c) => c.channel === channel);
}

function listBindings(q = {}) {
  let rows = db.prepare(`SELECT b.*, c.name customer_name, c.code customer_code
    FROM msg_wechat_bindings b LEFT JOIN customers c ON c.id=b.customer_id ORDER BY b.id DESC`).all();
  if (q.customer_id) rows = rows.filter((r) => Number(r.customer_id) === Number(q.customer_id));
  if (q.subscribe_status) rows = rows.filter((r) => r.subscribe_status === q.subscribe_status);
  return rows.map((r) => ({ ...r, template_ids: r.template_ids_json ? JSON.parse(r.template_ids_json) : [] }));
}

function bindWechat(b, op) {
  const customerId = Number(b.customer_id);
  if (!customerId) throw new Error('必须选客户');
  if (!db.prepare('SELECT id FROM customers WHERE id=?').get(customerId)) throw new Error('客户不存在');
  const openid = String(b.openid || '').trim();
  if (!openid) throw new Error('必须填微信 openid');
  const cap = capOf(1, 'wechat');
  // 未授权也能登记绑定关系吗？可以登记，但发送一律走降级 —— 登记不等于可用
  const t = now();
  const cur = db.prepare('SELECT * FROM msg_wechat_bindings WHERE openid=?').get(openid);
  if (cur && Number(cur.customer_id) !== customerId) throw new Error('这个 openid 已绑定到别的客户');
  const subStatus = String(b.subscribe_status || 'unknown');
  if (!['subscribed', 'unsubscribed', 'unknown'].includes(subStatus)) throw new Error('微信订阅状态不合法');
  if (cur) {
    db.prepare(`UPDATE msg_wechat_bindings SET subscribe_status=?, unionid=?, template_ids_json=?, verified=?, verified_at=?, last_sync_at=?, note=? WHERE id=?`)
      .run(subStatus, b.unionid || cur.unionid, JSON.stringify(b.template_ids || []),
        b.verified ? 1 : cur.verified, b.verified ? t : cur.verified_at, t, b.note || cur.note, cur.id);
    return { ...listBindings({ customer_id: customerId })[0], channel_usable: cap.status === 'enabled' && cap.verify_status === 'verified' };
  }
  db.prepare(`INSERT INTO msg_wechat_bindings
    (customer_id,account_id,openid,unionid,subscribe_status,template_ids_json,verified,verified_at,last_sync_at,note,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    customerId, b.account_id || (accountOf(customerId) || {}).id || null, openid, b.unionid || null,
    subStatus, JSON.stringify(b.template_ids || []), b.verified ? 1 : 0, b.verified ? t : null, t,
    b.note || null, t
  );
  const row = db.prepare('SELECT id FROM msg_wechat_bindings WHERE openid=?').get(openid);
  return { ...listBindings({ customer_id: customerId }).find((x) => x.id === row.id), channel_usable: cap.status === 'enabled' && cap.verify_status === 'verified' };
}

/** 同步微信订阅状态（生产环境由开放平台推送；这里模拟拉取） */
function syncWechat(b, op) {
  const rows = db.prepare('SELECT * FROM msg_wechat_bindings').all();
  const t = now();
  rows.forEach((r) => {
    db.prepare('UPDATE msg_wechat_bindings SET last_sync_at=? WHERE id=?').run(t, r.id);
  });
  const cap = capOf(1, 'wechat');
  return {
    synced: rows.length,
    channel_usable: cap.status === 'enabled' && cap.verify_status === 'verified',
    note: cap.status === 'enabled' ? '已同步微信订阅状态' : '微信渠道未授权：本次只更新同步时间，不会改变订阅结论'
  };
}

/** ==================== 频控 ==================== */

function freqRuleOf(customerId) {
  const own = db.prepare("SELECT * FROM msg_frequency_rules WHERE scope='customer' AND customer_id=? AND status='active'")
    .get(Number(customerId));
  if (own) return { ...FREQ_FALLBACK, ...own };
  const g = db.prepare("SELECT * FROM msg_frequency_rules WHERE scope='global' AND status='active'").get();
  return { ...FREQ_FALLBACK, ...(g || {}) };
}

function listRules() {
  return db.prepare("SELECT * FROM msg_frequency_rules ORDER BY CASE scope WHEN 'global' THEN 0 ELSE 1 END, id").all()
    .map((r) => ({ ...r, scope_label: r.scope === 'global' ? '全局默认' : '客户例外' }));
}

function saveRule(b, op) {
  const scope = String(b.scope || 'global');
  if (!['global', 'customer'].includes(scope)) throw new Error('规则范围不合法');
  if (scope === 'customer' && !Number(b.customer_id)) throw new Error('客户例外规则必须选客户');
  const nums = {
    max_per_day: Number(b.max_per_day === undefined ? 1 : b.max_per_day),
    max_per_week: Number(b.max_per_week === undefined ? 4 : b.max_per_week),
    min_gap_minutes: Number(b.min_gap_minutes === undefined ? 720 : b.min_gap_minutes),
    digest_hour: Number(b.digest_hour === undefined ? 10 : b.digest_hour)
  };
  if (nums.max_per_day < 0 || nums.max_per_day > 10) throw new Error('每日上限需在 0–10 之间');
  if (nums.max_per_week < nums.max_per_day) throw new Error('每周上限不能小于每日上限');
  if (nums.min_gap_minutes < 0 || nums.min_gap_minutes > 10080) throw new Error('最小间隔需在 0–10080 分钟之间');
  if (nums.digest_hour < 0 || nums.digest_hour > 23) throw new Error('发送时点需在 0–23 之间');
  const qs = String(b.quiet_start || '21:00');
  const qe = String(b.quiet_end || '08:00');
  if (hmToMinutes(qs) === null || hmToMinutes(qe) === null) throw new Error('静默时段格式应为 HH:mm');

  const t = now();
  const cid = scope === 'customer' ? Number(b.customer_id) : null;
  const cur = scope === 'customer'
    ? db.prepare("SELECT * FROM msg_frequency_rules WHERE scope='customer' AND customer_id=?").get(cid)
    : db.prepare("SELECT * FROM msg_frequency_rules WHERE scope='global'").get();
  if (cur) {
    db.prepare(`UPDATE msg_frequency_rules SET max_per_day=?, max_per_week=?, min_gap_minutes=?, quiet_start=?, quiet_end=?, digest_hour=?, note=?, updated_at=? WHERE id=?`)
      .run(nums.max_per_day, nums.max_per_week, nums.min_gap_minutes, qs, qe, nums.digest_hour, b.note || cur.note, t, cur.id);
    return db.prepare('SELECT * FROM msg_frequency_rules WHERE id=?').get(cur.id);
  }
  const info = db.prepare(`INSERT INTO msg_frequency_rules
    (company_id,scope,customer_id,max_per_day,max_per_week,min_gap_minutes,quiet_start,quiet_end,digest_hour,status,note,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?)`).run(
    Number(b.company_id) || 1, scope, cid, nums.max_per_day, nums.max_per_week,
    nums.min_gap_minutes, qs, qe, nums.digest_hour, b.note || null, t, t
  );
  return db.prepare('SELECT * FROM msg_frequency_rules WHERE id=?').get(info.lastInsertRowid);
}

/**
 * 营销频控检查（只对 marketing 主题生效）
 * 返回 { ok, reason, until }：ok=false 时发送置 held，until 是下次可发时间。
 */
function checkFrequency(customerId) {
  const rule = freqRuleOf(customerId);
  const tz = (db.prepare("SELECT timezone FROM msg_subscriptions WHERE customer_id=? AND topic='marketing' AND timezone IS NOT NULL LIMIT 1")
    .get(Number(customerId)) || {}).timezone || 'Asia/Shanghai';
  const hour = localHourOf(tz);

  if (inQuiet(hour, rule.quiet_start, rule.quiet_end)) {
    return {
      ok: false, reason: `客户当地时间 ${p2(hour)} 点处于静默时段（${rule.quiet_start}–${rule.quiet_end}）`,
      until: `${today()} ${rule.quiet_end}:00`, timezone: tz
    };
  }
  const dayCnt = Number(db.prepare(`SELECT COUNT(*) c FROM msg_outbox
    WHERE customer_id=? AND topic='marketing' AND status IN ('submitted','delivered','read')
      AND substr(COALESCE(sent_at,created_at),1,10)=?`).get(Number(customerId), today()).c);
  if (dayCnt >= rule.max_per_day) {
    return {
      ok: false, reason: `今天已发 ${dayCnt} 条营销消息，达到每日上限 ${rule.max_per_day}`,
      until: `${addDays(today(), 1)} ${p2(rule.digest_hour)}:00`, timezone: tz
    };
  }
  const weekFrom = addDays(today(), -6);
  const weekCnt = Number(db.prepare(`SELECT COUNT(*) c FROM msg_outbox
    WHERE customer_id=? AND topic='marketing' AND status IN ('submitted','delivered','read')
      AND substr(COALESCE(sent_at,created_at),1,10)>=?`).get(Number(customerId), weekFrom).c);
  if (weekCnt >= rule.max_per_week) {
    return {
      ok: false, reason: `近 7 天已发 ${weekCnt} 条营销消息，达到每周上限 ${rule.max_per_week}`,
      until: `${addDays(today(), 1)} ${p2(rule.digest_hour)}:00`, timezone: tz
    };
  }
  const last = db.prepare(`SELECT sent_at FROM msg_outbox WHERE customer_id=? AND topic='marketing'
    AND status IN ('submitted','delivered','read') AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1`).get(Number(customerId));
  if (last && last.sent_at) {
    const gap = minutesBetween(last.sent_at, now());
    if (gap !== null && gap >= 0 && gap < rule.min_gap_minutes) {
      const until = new Date(new Date(String(last.sent_at).replace(' ', 'T')).getTime() + rule.min_gap_minutes * 60000);
      return {
        ok: false, reason: `距上一条营销消息仅 ${gap} 分钟，未达最小间隔 ${rule.min_gap_minutes} 分钟`,
        until: `${until.getFullYear()}-${p2(until.getMonth() + 1)}-${p2(until.getDate())} ${p2(until.getHours())}:${p2(until.getMinutes())}:00`,
        timezone: tz
      };
    }
  }
  return { ok: true, rule, hour, timezone: tz };
}

/** ==================== 事件 ==================== */

function productReady(styleNo) {
  const p = db.prepare("SELECT * FROM mall_products WHERE style_no=?").get(String(styleNo));
  if (!p) return { ok: false, reason: '这个款号还没进商城商品库', qty: 0 };
  if (p.status !== 'published') return { ok: false, reason: `商品当前是「${p.status}」，未通过发布审核`, qty: 0 };
  const qty = MALL.sellableOf(p.style_no, p.name_cn);
  if (qty <= 0) return { ok: false, reason: '可售量为 0（还没合格上架）', qty: 0 };
  return { ok: true, qty, product: p };
}

function eventVars(event, extra) {
  const customer = event.customer_id
    ? db.prepare('SELECT id,name,code FROM customers WHERE id=?').get(Number(event.customer_id))
    : null;
  const p = event.style_no ? db.prepare('SELECT * FROM mall_products WHERE style_no=?').get(event.style_no) : null;
  const payload = event.payload_json ? JSON.parse(event.payload_json) : {};
  return {
    customer_name: (customer && customer.name) || payload.customer_name || '客户',
    style_no: event.style_no || payload.style_no || '',
    product_name: (p && (p.name_cn || p.name_en)) || payload.product_name || '',
    order_no: payload.order_no || '',
    status_label: payload.status_label || '',
    qty: payload.qty === undefined ? '' : payload.qty,
    cycle_days: payload.cycle_days === undefined ? '' : payload.cycle_days,
    due_date: payload.due_date || '',
    overdue_days: payload.overdue_days === undefined ? '' : payload.overdue_days,
    price_usd: payload.price_usd === undefined ? '' : payload.price_usd,
    inquiry_no: payload.inquiry_no || '',
    note: payload.note || ''
  };
}

/**
 * 创建一条业务事件（幂等）。
 * 返回 { event, duplicated, outbox:[], skipped:[] }
 */
function emitEvent(eventKey, payload = {}, op) {
  const kind = EVENT_KINDS.find((e) => e.k === eventKey);
  if (!kind) throw new Error('事件类型不合法');
  const bizType = payload.biz_type || (eventKey === 'new_product' || eventKey === 'restock' ? 'mall_product'
    : eventKey === 'order_status' ? 'order' : eventKey === 'cycle_due' ? 'cycle' : 'campaign');
  const bizId = payload.biz_id || payload.order_id || payload.mall_product_id || payload.customer_id || null;
  // 事件幂等键：同一件事（同一业务对象 + 同一类型）一天只触发一次
  const dedupe = payload.dedupe_key || [eventKey, bizType, bizId || payload.style_no || '', today()].join('|');
  const exist = db.prepare('SELECT * FROM msg_events WHERE dedupe_key=?').get(dedupe);
  if (exist) {
    return {
      event: exist, duplicated: true, outbox: [],
      note: '同一件事今天已经触发过，不再重复发送（事件级去重）'
    };
  }

  const t = now();
  const info = db.prepare(`INSERT INTO msg_events
    (event_no,company_id,event_key,biz_type,biz_id,style_no,sku,title,payload_json,occurred_at,dedupe_key,created_by,demo_tag,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    nextNo('EV', 'msg_events', 'event_no'), Number(payload.company_id) || 1, eventKey, bizType, bizId,
    payload.style_no || null, payload.sku || null, payload.title || kind.v,
    JSON.stringify(payload), payload.occurred_at || t, dedupe, me(op),
    payload.demo_tag || (op && op.demo_tag) || null, t
  );
  const event = db.prepare('SELECT * FROM msg_events WHERE id=?').get(info.lastInsertRowid);
  event.customer_id = payload.customer_id || null;

  // 到货/上新：必须发布通过且可售 > 0，否则连事件都不该产生
  if (eventKey === 'new_product' || eventKey === 'restock') {
    const ready = productReady(payload.style_no);
    if (!ready.ok) {
      db.prepare("UPDATE msg_events SET title=? WHERE id=?").run(`${kind.v}（未触发：${ready.reason}）`, event.id);
      return {
        event, duplicated: false, outbox: [], skipped: [{ reason: ready.reason }],
        note: '商品未满足「发布审核通过 + 可售 > 0」，提醒不触发'
      };
    }
    if (Number(payload.qty || 0) <= 0 && ready.qty <= 0) {
      return { event, duplicated: false, outbox: [], skipped: [{ reason: '可售量为 0' }] };
    }
  }

  const topic = kind.topic;
  const recipients = recipientsFor(eventKey, payload);
  const outbox = [];
  const skipped = [];
  recipients.forEach((rc) => {
    const channels = candidateChannels(rc.customer_id, topic, payload);
    if (!channels.length) {
      skipped.push({ customer_id: rc.customer_id, reason: '没有可用的订阅渠道（未订阅或已退订）' });
      return;
    }
    channels.forEach((ch) => {
      const r = createOutbox(event, rc, ch, topic, payload, op);
      if (r.outbox) outbox.push(r.outbox);
      if (r.skipped) skipped.push(r.skipped);
    });
  });

  return { event, duplicated: false, outbox, skipped };
}

function recipientsFor(eventKey, payload) {
  if (payload.customer_id) {
    return [{ customer_id: Number(payload.customer_id), account_id: null }];
  }
  if (eventKey === 'new_product' || eventKey === 'restock') {
    // 谁订阅了这款 → 只发给订阅者，不做全量群发
    const rows = db.prepare("SELECT * FROM msg_arrival_alerts WHERE style_no=? AND kind=? AND status='waiting'")
      .all(String(payload.style_no || ''), eventKey);
    return rows.map((r) => ({ customer_id: Number(r.customer_id), account_id: r.account_id, alert_id: r.id }));
  }
  return [];
}

/**
 * 客户订阅了哪些渠道（按主题）；没有订阅就一个都不返。
 *
 * 注意这里**不按渠道能力过滤**：客户选了微信但渠道还没授权时，
 * 仍然排进队列，由发送阶段降级到站内并留下 `degraded_from`。
 * 这样「为什么没走微信」在记录里查得到；如果在这里就悄悄丢掉，
 * 客户会以为订阅没生效，运营也看不到渠道缺口。
 * 微信至少要绑定过（否则根本无从降级）。
 */
function candidateChannels(customerId, topic) {
  const subs = db.prepare('SELECT * FROM msg_subscriptions WHERE customer_id=? AND topic=? AND status=?')
    .all(Number(customerId), topic, 'subscribed');
  return subs.filter((s) => {
    if (s.channel === 'site' || s.channel === 'email') return true;
    if (s.channel === 'wechat') {
      const bind = db.prepare('SELECT * FROM msg_wechat_bindings WHERE customer_id=? AND subscribe_status=?')
        .get(Number(customerId), 'subscribed');
      return !!bind;
    }
    return false;
  }).map((s) => s.channel);
}

function createOutbox(event, rc, channel, topic, payload, op) {
  const customerId = Number(rc.customer_id);
  const account = eligibleAccount(customerId);
  if (!account) {
    return { skipped: { customer_id: customerId, channel, reason: '客户账号无效或没有商品权限（catalog.view）' } };
  }
  const sub = subOf(customerId, topic, channel);
  // 这里只看「有没有订阅 / 有没有退订」；邮箱未核验留到发送阶段降级处理，
  // 否则客户永远看不到「邮件没核验」这条真实原因，只看到一条消失的订阅。
  if (!sub || sub.status !== 'subscribed') {
    return { skipped: { customer_id: customerId, channel, reason: !sub ? '未订阅该主题' : '已退订该主题' } };
  }
  if (channel === 'wechat') {
    const bind = db.prepare('SELECT * FROM msg_wechat_bindings WHERE customer_id=?').get(customerId);
    if (!bind) return { skipped: { customer_id: customerId, channel, reason: '未绑定微信' } };
  }

  const tpl = approvedTemplate(event.event_key, channel, sub.locale || 'zh');
  if (!tpl) {
    return { skipped: { customer_id: customerId, channel, reason: `没有生效中的「${(EVENT_KINDS.find((e) => e.k === event.event_key) || {}).v}」${(CHANNELS.find((c) => c.k === channel) || {}).v}模板` } };
  }

  const vars = eventVars({ ...event, customer_id: customerId }, payload);
  const rendered = renderTemplate(tpl, vars);
  if (rendered.missing.length) {
    return { skipped: { customer_id: customerId, channel, reason: `模板变量缺失：${rendered.missing.join('、')}` } };
  }

  const recipient = channel === 'email' ? account.email
    : channel === 'wechat' ? (db.prepare('SELECT openid FROM msg_wechat_bindings WHERE customer_id=? AND subscribe_status=?').get(customerId, 'subscribed') || {}).openid
      : account.id;

  const dedupe = `e${event.id}|c${customerId}|${channel}|v${tpl.version}`;
  const dup = db.prepare('SELECT * FROM msg_outbox WHERE dedupe_key=?').get(dedupe);
  if (dup) return { outbox: null, skipped: { customer_id: customerId, channel, reason: '同一事件同一渠道已发过（发送级去重）' } };

  const t = now();
  const info = db.prepare(`INSERT INTO msg_outbox
    (outbox_no,event_id,company_id,customer_id,account_id,topic,channel,template_id,template_version,recipient,subject,body,
     status,dedupe_key,scheduled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)`).run(
    nextNo('OB', 'msg_outbox', 'outbox_no'), event.id, Number(event.company_id) || 1, customerId, account.id,
    topic, channel, tpl.id, tpl.version, recipient || null, rendered.subject, rendered.body,
    dedupe, t, t, t
  );
  const ob = db.prepare('SELECT * FROM msg_outbox WHERE id=?').get(info.lastInsertRowid);
  log(ob.id, channel, 'generated', `按模板 V${tpl.version} 生成，收件人 ${recipient || '—'}`, null, me(op));
  return { outbox: ob };
}

function log(outboxId, channel, event, detail, providerCode, operator) {
  db.prepare('INSERT INTO msg_delivery_logs (outbox_id,channel,event,detail,provider_code,operator,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(Number(outboxId), channel || null, event, detail || null, providerCode || null, operator || 'system', now());
}

/** ==================== 发送 ==================== */

function listOutbox(q = {}) {
  let rows = db.prepare(`SELECT o.*, c.name customer_name, c.code customer_code, e.event_key, e.title event_title
    FROM msg_outbox o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN msg_events e ON e.id=o.event_id
    ORDER BY o.id DESC`).all();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.channel) rows = rows.filter((r) => r.channel === q.channel);
  if (q.topic) rows = rows.filter((r) => r.topic === q.topic);
  if (q.customer_id) rows = rows.filter((r) => Number(r.customer_id) === Number(q.customer_id));
  if (q.event_key) rows = rows.filter((r) => r.event_key === q.event_key);
  if (q.q) rows = rows.filter((r) => String(r.customer_name || '').includes(q.q) || String(r.subject || '').includes(q.q));
  if (q.limit) rows = rows.slice(0, Number(q.limit));
  return rows.map((r) => ({
    ...r,
    status_label: OUT_STATUS_LABEL[r.status] || r.status,
    channel_label: (CHANNELS.find((c) => c.k === r.channel) || {}).v || r.channel,
    topic_label: (TOPICS.find((t) => t.k === r.topic) || {}).v || r.topic,
    event_label: (EVENT_KINDS.find((e) => e.k === r.event_key) || {}).v || r.event_key,
    can_retry: r.status === 'failed' && Number(r.retry_cnt) < Number(r.max_retry)
  }));
}

function getOutbox(id) {
  const o = db.prepare('SELECT * FROM msg_outbox WHERE id=?').get(Number(id));
  if (!o) throw new Error('发送记录不存在');
  const logs = db.prepare('SELECT * FROM msg_delivery_logs WHERE outbox_id=? ORDER BY id').all(o.id);
  const attrs = db.prepare('SELECT * FROM msg_attributions WHERE outbox_id=? ORDER BY stage, id').all(o.id);
  return {
    ...o,
    status_label: OUT_STATUS_LABEL[o.status] || o.status,
    channel_label: (CHANNELS.find((c) => c.k === o.channel) || {}).v || o.channel,
    topic_label: (TOPICS.find((t) => t.k === o.topic) || {}).v || o.topic,
    customer_name: (db.prepare('SELECT name FROM customers WHERE id=?').get(o.customer_id) || {}).name,
    event: db.prepare('SELECT * FROM msg_events WHERE id=?').get(o.event_id),
    logs,
    attributions: attrs.map((a) => ({ ...a, stage_label: ATTR_STAGE_LABEL[a.stage] || a.stage })),
    next: nextOutboxStatuses(o)
  };
}

function nextOutboxStatuses(o) {
  if (o.status === 'queued') return ['submitted', 'skipped'];
  if (o.status === 'held') return ['queued', 'skipped'];
  if (o.status === 'submitted') return ['delivered', 'failed'];
  if (o.status === 'delivered') return ['read', 'failed'];
  if (o.status === 'failed') return Number(o.retry_cnt) < Number(o.max_retry) ? ['queued'] : [];
  return [];
}

/**
 * 发送一条：频控 → 渠道降级 → 提交。
 * 只有真的提交出去了才置 submitted；站内消息提交即送达。
 */
function sendOutbox(id, op) {
  const o = db.prepare('SELECT * FROM msg_outbox WHERE id=?').get(Number(id));
  if (!o) throw new Error('发送记录不存在');
  if (!['queued', 'held', 'failed'].includes(o.status)) {
    throw new Error(`当前状态是「${OUT_STATUS_LABEL[o.status]}」，不能再发送`);
  }
  if (o.status === 'failed' && Number(o.retry_cnt) >= Number(o.max_retry)) {
    throw new Error(`已重试 ${o.retry_cnt} 次仍失败，请人工跟进后再发`);
  }
  if (o.status === 'held' && o.next_retry_at && o.next_retry_at > now()) {
    throw new Error(`频控暂缓到 ${o.next_retry_at} 才能发`);
  }

  // ① 频控只作用于营销主题；业务通知不受营销频控限制
  if (o.topic === 'marketing') {
    const f = checkFrequency(o.customer_id);
    if (!f.ok) {
      db.prepare("UPDATE msg_outbox SET status='held', next_retry_at=?, skip_reason=?, updated_at=? WHERE id=?")
        .run(f.until, f.reason, now(), o.id);
      log(o.id, o.channel, 'held', f.reason, null, me(op));
      return { ...getOutbox(o.id), held: true, hold_reason: f.reason, next_at: f.until };
    }
  }

  // ② 渠道降级：不可用就换可用渠道，一个都没有才跳过
  let channel = o.channel;
  let degradedFrom = o.degraded_from;
  if (channel !== 'site' && !capUsable(1, channel)) {
    const cap = capOf(1, channel);
    const siteSub = subOf(o.customer_id, o.topic, 'site');
    if (subUsable(siteSub, 'site')) {
      degradedFrom = channel;
      channel = 'site';
      log(o.id, channel, 'degraded', `${(CHANNELS.find((c) => c.k === degradedFrom) || {}).v}渠道不可用（${cap.reason || '未授权'}），改走站内消息`, null, me(op));
    } else {
      db.prepare("UPDATE msg_outbox SET status='skipped', skip_reason=?, updated_at=? WHERE id=?")
        .run(`${(CHANNELS.find((c) => c.k === channel) || {}).v}渠道不可用且客户没有站内订阅`, now(), o.id);
      log(o.id, channel, 'skipped', '渠道不可用且无可用降级渠道', null, me(op));
      return getOutbox(o.id);
    }
  }
  // 邮件必须核验过
  if (channel === 'email') {
    const sub = subOf(o.customer_id, o.topic, 'email');
    if (!subUsable(sub, 'email')) {
      const siteSub = subOf(o.customer_id, o.topic, 'site');
      if (subUsable(siteSub, 'site')) {
        degradedFrom = 'email';
        channel = 'site';
        log(o.id, channel, 'degraded', '邮箱未核验，改走站内消息', null, me(op));
      } else {
        db.prepare("UPDATE msg_outbox SET status='skipped', skip_reason='邮箱未核验且没有站内订阅', updated_at=? WHERE id=?")
          .run(now(), o.id);
        log(o.id, channel, 'skipped', '邮箱未核验且没有站内订阅', null, me(op));
        return getOutbox(o.id);
      }
    }
  }
  if (channel === 'wechat') {
    const bind = db.prepare('SELECT * FROM msg_wechat_bindings WHERE customer_id=?').get(o.customer_id);
    if (!bind || bind.subscribe_status !== 'subscribed') {
      const siteSub = subOf(o.customer_id, o.topic, 'site');
      if (subUsable(siteSub, 'site')) {
        degradedFrom = 'wechat';
        channel = 'site';
        log(o.id, channel, 'degraded', '微信未绑定或未关注，改走站内消息', null, me(op));
      } else {
        db.prepare("UPDATE msg_outbox SET status='skipped', skip_reason='微信不可用且没有站内订阅', updated_at=? WHERE id=?")
          .run(now(), o.id);
        log(o.id, channel, 'skipped', '微信不可用且没有站内订阅', null, me(op));
        return getOutbox(o.id);
      }
    }
  }

  const t = now();
  const providerId = `SIM-${channel.toUpperCase()}-${o.outbox_no}`;
  db.prepare(`UPDATE msg_outbox SET channel=?, degraded_from=?, status=?, sent_at=?, fail_reason=NULL,
    provider_msg_id=?, next_retry_at=NULL, updated_at=? WHERE id=?`)
    .run(channel, degradedFrom || null, 'submitted', t, providerId, t, o.id);
  log(o.id, channel, 'submitted', '已提交至渠道', providerId, me(op));

  // 站内消息投递即达；邮件/微信等回执
  if (channel === 'site') {
    db.prepare("UPDATE msg_outbox SET status='delivered', delivered_at=?, updated_at=? WHERE id=?").run(t, t, o.id);
    log(o.id, channel, 'delivered', '站内消息投递即送达', null, me(op));
    // 真的写进客户商城收件箱，客户登录能看到
    const info = MALL.pushMessage({
      customerId: o.customer_id,
      accountId: o.account_id,
      type: o.topic === 'order' ? 'order' : o.topic === 'arrival' ? 'arrival' : o.topic === 'marketing' ? 'promo' : 'system',
      title: o.subject,
      body: o.body,
      refType: 'msg_outbox',
      refId: o.id
    });
    if (info) db.prepare('UPDATE msg_outbox SET provider_msg_id=? WHERE id=?').run(`SITE-${info}`, o.id);
  }
  return getOutbox(o.id);
}

/**
 * 回执：delivered / read / opened / failed。
 * 「打开」只记 opened_at，不改状态 —— 打开邮件不等于读了，更不等于成交。
 */
function receipt(id, b, op) {
  const o = db.prepare('SELECT * FROM msg_outbox WHERE id=?').get(Number(id));
  if (!o) throw new Error('发送记录不存在');
  const event = String(b.event || '');
  const t = now();

  if (event === 'delivered') {
    if (o.status === 'read') throw new Error('这条已经标记已读，回执只能往前走，不能改回已送达');
    if (o.status === 'delivered') return getOutbox(o.id);
    if (o.status !== 'submitted') throw new Error(`当前是「${OUT_STATUS_LABEL[o.status]}」，没提交过不能报送达`);
    db.prepare("UPDATE msg_outbox SET status='delivered', delivered_at=?, updated_at=? WHERE id=?").run(t, t, o.id);
    log(o.id, o.channel, 'delivered', b.detail || '渠道回执：已送达', b.provider_code || null, me(op));
    return getOutbox(o.id);
  }

  if (event === 'read') {
    if (o.status === 'read') return getOutbox(o.id);
    if (o.status !== 'delivered') {
      throw new Error(`还没收到送达回执（当前「${OUT_STATUS_LABEL[o.status]}」），不能标记已读 —— 未知不算已读`);
    }
    db.prepare("UPDATE msg_outbox SET status='read', read_at=?, updated_at=? WHERE id=?").run(t, t, o.id);
    log(o.id, o.channel, 'read', b.detail || '客户已读', b.provider_code || null, me(op));
    return getOutbox(o.id);
  }

  if (event === 'opened') {
    // 只记打开，不改状态、不置已读
    db.prepare('UPDATE msg_outbox SET opened_at=?, updated_at=? WHERE id=?').run(t, t, o.id);
    log(o.id, o.channel, 'opened', b.detail || '渠道回执：已打开（打开不等于已读，不计入阅读率）', b.provider_code || null, me(op));
    return { ...getOutbox(o.id), note: '已记录打开时间；状态不变，阅读率只认 read 回执' };
  }

  if (event === 'failed') {
    if (!['submitted', 'delivered'].includes(o.status)) {
      throw new Error(`当前是「${OUT_STATUS_LABEL[o.status]}」，不能标记失败`);
    }
    const cnt = Number(o.retry_cnt) + 1;
    const canRetry = cnt < Number(o.max_retry);
    db.prepare(`UPDATE msg_outbox SET status='failed', retry_cnt=?, fail_reason=?, next_retry_at=?, updated_at=? WHERE id=?`)
      .run(cnt, b.detail || '渠道返回失败', canRetry ? shiftHours(1) : null, t, o.id);
    log(o.id, o.channel, 'failed', `${b.detail || '渠道返回失败'}（第 ${cnt} 次，${canRetry ? '将重试' : '已达上限，转人工'}）`, b.provider_code || null, me(op));
    return { ...getOutbox(o.id), can_retry: canRetry };
  }

  throw new Error('回执类型只能是 delivered / read / opened / failed');
}

/** 手工重试失败的发送 */
function retryOutbox(id, op) {
  const o = db.prepare('SELECT * FROM msg_outbox WHERE id=?').get(Number(id));
  if (!o) throw new Error('发送记录不存在');
  if (o.status !== 'failed') throw new Error('只有失败的才能重试');
  if (Number(o.retry_cnt) >= Number(o.max_retry)) throw new Error(`已重试 ${o.retry_cnt} 次仍失败，请人工联系客户后再决定是否重发`);
  db.prepare("UPDATE msg_outbox SET status='queued', next_retry_at=NULL, updated_at=? WHERE id=?").run(now(), o.id);
  log(o.id, o.channel, 'retry', '人工重试', null, me(op));
  return sendOutbox(o.id, op);
}

function skipOutbox(id, b, op) {
  const o = db.prepare('SELECT * FROM msg_outbox WHERE id=?').get(Number(id));
  if (!o) throw new Error('发送记录不存在');
  if (['delivered', 'read'].includes(o.status)) throw new Error('已送达/已读的不能跳过');
  if (!String(b.reason || '').trim()) throw new Error('跳过必须写原因');
  db.prepare("UPDATE msg_outbox SET status='skipped', skip_reason=?, updated_at=? WHERE id=?").run(b.reason, now(), o.id);
  log(o.id, o.channel, 'skipped', b.reason, null, me(op));
  return getOutbox(o.id);
}

/** 批量派发：待发送 + 到点的暂缓 + 到点的失败重试 */
function dispatchPending(b = {}, op) {
  const t = now();
  let rows = db.prepare("SELECT * FROM msg_outbox WHERE status IN ('queued','held','failed') ORDER BY id").all();
  if (b.channel) rows = rows.filter((r) => r.channel === b.channel);
  if (b.event_key) {
    const ids = db.prepare('SELECT id FROM msg_events WHERE event_key=?').all(b.event_key).map((x) => x.id);
    rows = rows.filter((r) => ids.includes(r.event_id));
  }
  rows = rows.filter((r) => {
    if (r.status === 'held') return !r.next_retry_at || r.next_retry_at <= t;
    if (r.status === 'failed') return Number(r.retry_cnt) < Number(r.max_retry) && (!r.next_retry_at || r.next_retry_at <= t);
    return true;
  });
  if (b.limit) rows = rows.slice(0, Number(b.limit));

  const out = { total: rows.length, sent: 0, held: 0, skipped: 0, failed: 0, rows: [] };
  rows.forEach((r) => {
    try {
      const r2v = sendOutbox(r.id, op);
      if (r2v.held) out.held += 1;
      else if (r2v.status === 'skipped') out.skipped += 1;
      else out.sent += 1;
      out.rows.push({ id: r.id, outbox_no: r.outbox_no, status: r2v.status, channel: r2v.channel });
    } catch (e) {
      out.failed += 1;
      out.rows.push({ id: r.id, outbox_no: r.outbox_no, error: e.message });
    }
  });
  return out;
}

function listEvents(q = {}) {
  let rows = db.prepare('SELECT * FROM msg_events ORDER BY id DESC').all();
  if (q.event_key) rows = rows.filter((r) => r.event_key === q.event_key);
  if (q.style_no) rows = rows.filter((r) => r.style_no === q.style_no);
  if (q.q) rows = rows.filter((r) => String(r.event_no).includes(q.q) || String(r.title || '').includes(q.q));
  if (q.limit) rows = rows.slice(0, Number(q.limit));
  return rows.map((r) => {
    const cnt = db.prepare('SELECT COUNT(*) c FROM msg_outbox WHERE event_id=?').get(r.id).c;
    return {
      ...r,
      event_label: (EVENT_KINDS.find((e) => e.k === r.event_key) || {}).v || r.event_key,
      outbox_cnt: cnt,
      payload: r.payload_json ? JSON.parse(r.payload_json) : null
    };
  });
}

/** ==================== 到货提醒 ==================== */

function listAlerts(q = {}) {
  let rows = db.prepare(`SELECT a.*, c.name customer_name, c.code customer_code,
      (SELECT COALESCE(SUM(qty),0) FROM stock_items s WHERE s.warehouse='us' AND s.style_no=a.style_no AND s.qty>0) stock_qty
    FROM msg_arrival_alerts a LEFT JOIN customers c ON c.id=a.customer_id ORDER BY a.id DESC`).all();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.customer_id) rows = rows.filter((r) => Number(r.customer_id) === Number(q.customer_id));
  if (q.style_no) rows = rows.filter((r) => r.style_no === q.style_no);
  return rows.map((r) => {
    const p = db.prepare('SELECT status,name_cn FROM mall_products WHERE style_no=?').get(r.style_no);
    const ready = productReady(r.style_no);
    return {
      ...r,
      kind_label: r.kind === 'new_product' ? '上新提醒' : '到货提醒',
      status_label: r.status === 'waiting' ? '等待到货' : r.status === 'notified' ? '已通知' : '已取消',
      product_status: p ? p.status : 'not_in_mall',
      product_name: p ? p.name_cn : null,
      ready: ready.ok,
      ready_reason: ready.ok ? null : ready.reason,
      sellable_qty: ready.qty
    };
  });
}

function createAlert(b, op) {
  const customerId = Number(b.customer_id);
  if (!customerId) throw new Error('必须选客户');
  const styleNo = String(b.style_no || '').trim();
  if (!styleNo) throw new Error('必须填款号');
  const kind = String(b.kind || 'restock');
  if (!['new_product', 'restock'].includes(kind)) throw new Error('提醒类型不合法');
  const account = eligibleAccount(customerId);
  if (!account) throw new Error('这个客户没有可用账号或没有商品权限，不能订阅提醒');
  const sub = subOf(customerId, 'arrival', 'site') || db.prepare("SELECT * FROM msg_subscriptions WHERE customer_id=? AND topic='arrival' AND status='subscribed' LIMIT 1").get(customerId);
  if (!sub) throw new Error('这个客户还没订阅「上新与到货」，先订阅再登记提醒');
  const exists = db.prepare("SELECT * FROM msg_arrival_alerts WHERE customer_id=? AND style_no=? AND kind=? AND status='waiting'")
    .get(customerId, styleNo, kind);
  if (exists) throw new Error(`这个客户已经订阅过 ${styleNo} 的提醒，等通知即可`);

  const info = db.prepare(`INSERT INTO msg_arrival_alerts
    (alert_no,company_id,customer_id,account_id,style_no,kind,threshold_qty,status,source,note,created_at)
    VALUES (?,?,?,?,?,?,?,'waiting',?,?,?)`).run(
    nextNo('AL', 'msg_arrival_alerts', 'alert_no'), Number(b.company_id) || 1, customerId, account.id,
    styleNo, kind, Number(b.threshold_qty || 1), b.source || 'manual', b.note || null, now()
  );
  return listAlerts({ customer_id: customerId }).find((x) => x.id === info.lastInsertRowid);
}

function cancelAlert(id, b, op) {
  const a = db.prepare('SELECT * FROM msg_arrival_alerts WHERE id=?').get(Number(id));
  if (!a) throw new Error('提醒不存在');
  if (a.status !== 'waiting') throw new Error('只有等待中的提醒能取消');
  db.prepare("UPDATE msg_arrival_alerts SET status='cancelled', note=? WHERE id=?").run(b.reason || a.note, a.id);
  return listAlerts({}).find((x) => x.id === a.id);
}

/**
 * 触发扫描：把「商品已发布 + 可售 ≥ 阈值」的等待提醒发出去。
 * 这是「到货提醒在合格上架且可售量大于零后触发」的执行点。
 */
function sweepAlerts(op) {
  const rows = db.prepare("SELECT * FROM msg_arrival_alerts WHERE status='waiting' ORDER BY id").all();
  const fired = [];
  const waiting = [];
  rows.forEach((a) => {
    const ready = productReady(a.style_no);
    if (!ready.ok) {
      waiting.push({ alert_no: a.alert_no, style_no: a.style_no, reason: ready.reason });
      return;
    }
    if (ready.qty < Number(a.threshold_qty || 1)) {
      waiting.push({ alert_no: a.alert_no, style_no: a.style_no, reason: `可售 ${ready.qty} 未达阈值 ${a.threshold_qty}` });
      return;
    }
    const p = ready.product;
    const r = emitEvent(a.kind, {
      style_no: a.style_no,
      mall_product_id: p.id,
      product_name: p.name_cn || p.name_en,
      customer_id: a.customer_id,
      price_usd: p.price_usd,
      qty: ready.qty,
      title: `${a.kind === 'new_product' ? '上新' : '到货'}提醒：${p.name_cn || a.style_no}`,
      dedupe_key: `alert|${a.id}|${today()}`
    }, op);
    if (r.duplicated) {
      waiting.push({ alert_no: a.alert_no, style_no: a.style_no, reason: '今天已经提醒过' });
      return;
    }
    if (!r.outbox.length && r.skipped.length) {
      waiting.push({ alert_no: a.alert_no, style_no: a.style_no, reason: r.skipped[0].reason });
      return;
    }
    const obId = r.outbox[0].id;
    db.prepare("UPDATE msg_arrival_alerts SET status='notified', notified_at=?, outbox_id=? WHERE id=?")
      .run(now(), obId, a.id);
    fired.push({ alert_no: a.alert_no, style_no: a.style_no, outbox_no: r.outbox[0].outbox_no, qty: ready.qty });
  });
  return { fired: fired.length, rows: fired, waiting: waiting.length, waiting_rows: waiting.slice(0, 10) };
}

/** ==================== 周期回访任务 ==================== */

/**
 * 周期超期 → 生成销售回访任务；**没有营销授权不发促销消息**。
 * 样衣/免费补发不刷新复购这条由 CRM 侧保证，这里只消费 next_due_date。
 */
function cycleTasks(b = {}, op) {
  const date = b.date || today();
  let rows = db.prepare(`SELECT cy.*, c.name customer_name, c.code customer_code
    FROM crm_customer_cycles cy LEFT JOIN customers c ON c.id=cy.customer_id
    WHERE cy.next_due_date IS NOT NULL AND cy.next_due_date < ? AND cy.status IN ('known','seasonal')
    ORDER BY cy.next_due_date`).all(date);
  if (b.customer_id) rows = rows.filter((r) => Number(r.customer_id) === Number(b.customer_id));

  const out = { scanned: rows.length, tasks: 0, messages: 0, no_auth: 0, rows: [] };
  rows.forEach((cy) => {
    const overdue = Math.max(0, Math.round((new Date(`${date}T00:00:00`) - new Date(`${cy.next_due_date}T00:00:00`)) / 86400000));
    // 今天已经生成过就不再生成（一天一条，避免刷屏）
    const dup = db.prepare("SELECT 1 x FROM crm_followups WHERE customer_id=? AND kind='cycle_due' AND substr(created_at,1,10)=?")
      .get(cy.customer_id, today());
    const taskCreated = !dup;
    if (!dup) {
      db.prepare(`INSERT INTO crm_followups (customer_id,cycle_id,kind,due_date,contact_note,result,operator,created_at)
        VALUES (?,?,'cycle_due',?,?,NULL,?,?)`).run(
        cy.customer_id, cy.id, date,
        `采购周期超期 ${overdue} 天（上次有效采购 ${cy.last_purchase_date || '—'}，周期 ${cy.cycle_days || '—'} 天），请回访`,
        `system:${me(op)}`, now()
      );
      out.tasks += 1;
    }

    // 营销授权：只有 marketing 订阅可用的才发补货提醒
    const mktSubs = db.prepare("SELECT * FROM msg_subscriptions WHERE customer_id=? AND topic='marketing' AND status='subscribed'")
      .all(cy.customer_id).filter((s) => subUsable(s, s.channel));
    if (!mktSubs.length) {
      out.no_auth += 1;
      out.rows.push({
        customer: cy.customer_name, overdue, task: taskCreated, message: false,
        reason: taskCreated ? '未获营销授权：只生成回访任务，不发促销消息' : '未获营销授权；今天的回访任务已生成过'
      });
      return;
    }
    const r = emitEvent('cycle_due', {
      customer_id: cy.customer_id,
      biz_type: 'cycle',
      biz_id: cy.id,
      title: `补货提醒：${cy.customer_name} 已超期 ${overdue} 天`,
      cycle_days: cy.cycle_days,
      due_date: cy.next_due_date,
      overdue_days: overdue,
      dedupe_key: `cycle|${cy.id}|${today()}`
    }, op);
    if (r.outbox.length) out.messages += r.outbox.length;
    out.rows.push({
      customer: cy.customer_name, overdue, task: taskCreated,
      message: r.outbox.length > 0,
      outbox: r.outbox.map((x) => x.outbox_no),
      reason: r.outbox.length ? null : (r.duplicated ? '今天的补货提醒已经发过（事件去重）' : '没有生效模板或订阅不可用，未生成消息')
    });
  });
  return out;
}

/** ==================== 效果归因 ==================== */

/**
 * 归因四层：送达 → 阅读 → 询价 → 订单。
 * 订单只认已确认（status 至少 assigned）；打开邮件不算成交；快照存下来，
 * 销售交接/客户归属变化都不回写历史归因。
 */
function refreshAttribution(b = {}, op) {
  const days = Number(b.days || 30);
  const from = addDays(today(), -days);
  // 按 id 升序：同一张订单只归给**最早一条**触达（首次触达归因），
  // 否则一个客户收到 4 条消息、下了 1 张单，报表会显示「归因订单 4」。
  const outs = db.prepare(`SELECT o.*, e.style_no, e.event_key FROM msg_outbox o
    LEFT JOIN msg_events e ON e.id=o.event_id
    WHERE o.status IN ('delivered','read') AND substr(COALESCE(o.sent_at,o.created_at),1,10)>=?
    ORDER BY o.id`).all(from);

  const out = { scanned: outs.length, delivered: 0, read: 0, inquiry: 0, order: 0, revenue_cny: 0 };
  const ins = (o, stage, refType, refId, refNo, windowDays, revenue, note) => {
    const exist = db.prepare('SELECT id FROM msg_attributions WHERE outbox_id=? AND stage=? AND ref_id=?')
      .get(o.id, stage, refId || 0);
    if (exist) return false;
    // 同一张订单 / 同一次询价只记一次：跨消息重复记会把 1 张单算成 4 张
    if (refId && stage !== 'delivered' && stage !== 'read') {
      const taken = db.prepare('SELECT id FROM msg_attributions WHERE stage=? AND ref_type=? AND ref_id=?')
        .get(stage, refType || null, refId);
      if (taken) return false;
    }
    db.prepare(`INSERT INTO msg_attributions
      (outbox_id,event_id,customer_id,style_no,stage,ref_type,ref_id,ref_no,window_days,revenue_cny,snapshot_at,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      o.id, o.event_id, o.customer_id, o.style_no || null, stage, refType || null, refId || 0, refNo || null,
      windowDays, r2(revenue), now(), note || null
    );
    return true;
  };

  outs.forEach((o) => {
    if (ins(o, 'delivered', null, 0, null, 7, 0, '送达即计触达')) out.delivered += 1;
    if (o.read_at && ins(o, 'read', null, 0, null, 7, 0, '客户已读')) out.read += 1;

    const sentDate = String(o.sent_at || o.created_at).slice(0, 10);
    const to = addDays(sentDate, 7);

    // 询价：同客户 + 窗口内；款号能对上时只算对得上的
    const inqs = db.prepare(`SELECT * FROM mall_inquiries WHERE customer_id=?
      AND substr(created_at,1,10) BETWEEN ? AND ?`).all(o.customer_id, sentDate, to);
    inqs.forEach((q) => {
      if (o.style_no) {
        const hit = db.prepare(`SELECT 1 x FROM mall_inquiry_items i JOIN mall_inquiries q ON q.id=i.inquiry_id
          WHERE i.inquiry_id=? AND i.style_no=?`).get(q.id, o.style_no);
        if (!hit) return;
      }
      const rev = r2(Number(q.total_usd || 0) * 7.1);
      if (ins(o, 'inquiry', 'mall_inquiry', q.id, q.inquiry_no, 7, rev, '归因窗口内询价')) {
        out.inquiry += 1;
        // 询价金额只挂在归因行上做参考，**不计入归因金额** ——
        // 报表里的「归因金额」只算已确认订单，否则询价和订单会加在一起，看着像成交了两遍
      }
    });

    // 订单：只认已确认（assigned 及之后），草稿/取消不算
    const ords = db.prepare(`SELECT * FROM orders WHERE customer_id=?
      AND order_date BETWEEN ? AND ? AND status IN ('assigned','production','instock','shipped','closed')`)
      .all(o.customer_id, sentDate, to);
    ords.forEach((od) => {
      const rev = od.currency === 'CNY' ? Number(od.total_amount || 0)
        : Number(od.total_amount || 0) * Number(od.rate || 7.1);
      if (ins(o, 'order', 'order', od.id, od.order_no, 7, rev, '归因窗口内已确认订单')) {
        out.order += 1;
        out.revenue_cny = r2(out.revenue_cny + rev);
      }
    });
  });
  return out;
}

function attributionReport(q = {}) {
  const from = q.from || addDays(today(), -30);
  const to = q.to || today();
  // 触达口径直接读发送表（送达/已读），询价/订单读归因快照
  const outs = db.prepare(`SELECT o.id,o.customer_id,o.channel,o.topic,o.status,o.sent_at,o.read_at,o.opened_at,
      e.event_key,e.style_no,c.name customer_name
    FROM msg_outbox o LEFT JOIN msg_events e ON e.id=o.event_id LEFT JOIN customers c ON c.id=o.customer_id
    WHERE substr(COALESCE(o.sent_at,o.created_at),1,10) BETWEEN ? AND ?
      AND o.status IN ('submitted','delivered','read','failed')`).all(from, to);

  const attrs = db.prepare(`SELECT a.* FROM msg_attributions a JOIN msg_outbox o ON o.id=a.outbox_id
    WHERE substr(COALESCE(o.sent_at,o.created_at),1,10) BETWEEN ? AND ?`).all(from, to);

  const byCustomer = new Map();
  const byStyle = new Map();
  const touch = (map, key, name) => {
    if (!map.has(key)) map.set(key, { key, name, sent: 0, delivered: 0, read: 0, opened: 0, inquiry: 0, order: 0, revenue_cny: 0 });
    return map.get(key);
  };

  outs.forEach((o) => {
    const c = touch(byCustomer, String(o.customer_id), o.customer_name || `客户#${o.customer_id}`);
    c.sent += 1;
    if (['delivered', 'read'].includes(o.status)) c.delivered += 1;
    if (o.status === 'read') c.read += 1;
    if (o.opened_at) c.opened += 1;
    if (o.style_no) {
      const s = touch(byStyle, o.style_no, o.style_no);
      s.sent += 1;
      if (['delivered', 'read'].includes(o.status)) s.delivered += 1;
      if (o.status === 'read') s.read += 1;
      if (o.opened_at) s.opened += 1;
    }
  });

  attrs.forEach((a) => {
    const c = touch(byCustomer, String(a.customer_id), `客户#${a.customer_id}`);
    const s = a.style_no ? touch(byStyle, a.style_no, a.style_no) : null;
    if (a.stage === 'inquiry') { c.inquiry += 1; if (s) s.inquiry += 1; }
    if (a.stage === 'order') { c.order += 1; c.revenue_cny = r2(c.revenue_cny + Number(a.revenue_cny || 0)); if (s) { s.order += 1; s.revenue_cny = r2(s.revenue_cny + Number(a.revenue_cny || 0)); } }
  });

  const finish = (r) => ({
    ...r,
    delivered_rate: r.sent ? r2((r.delivered / r.sent) * 100) : 0,
    read_rate: r.delivered ? r2((r.read / r.delivered) * 100) : 0,
    inquiry_rate: r.delivered ? r2((r.inquiry / r.delivered) * 100) : 0,
    order_rate: r.delivered ? r2((r.order / r.delivered) * 100) : 0
  });

  const customers = Array.from(byCustomer.values()).map(finish).sort((a, b) => b.order - a.order || b.delivered - a.delivered);
  const styles = Array.from(byStyle.values()).map(finish).sort((a, b) => b.order - a.order || b.delivered - a.delivered);

  return {
    from, to,
    customers, styles,
    totals: {
      sent: outs.length,
      delivered: outs.filter((o) => ['delivered', 'read'].includes(o.status)).length,
      read: outs.filter((o) => o.status === 'read').length,
      opened_only: outs.filter((o) => o.opened_at && o.status !== 'read').length,
      inquiry: attrs.filter((a) => a.stage === 'inquiry').length,
      order: attrs.filter((a) => a.stage === 'order').length,
      revenue_cny: r2(attrs.filter((a) => a.stage === 'order').reduce((x, a) => x + Number(a.revenue_cny || 0), 0))
    },
    note: '送达 / 阅读 / 询价 / 已确认订单 分四层；**打开邮件不算已读，更不算成交**；归因窗口 7 天，订单只认已确认（草稿与取消不计）；归因是快照，销售交接与客户归属变更都不回写历史'
  };
}

/** ==================== 概览 ==================== */

function overview() {
  const cnt = (sql, ...args) => Number(db.prepare(sql).get(...args).c);
  const cap = listCaps(1);
  const wechat = cap.find((c) => c.channel === 'wechat');
  const email = cap.find((c) => c.channel === 'email');
  const todayCnt = cnt(`SELECT COUNT(*) c FROM msg_outbox WHERE substr(COALESCE(sent_at,created_at),1,10)=?`, today());
  return {
    outbox: {
      queued: cnt("SELECT COUNT(*) c FROM msg_outbox WHERE status='queued'"),
      held: cnt("SELECT COUNT(*) c FROM msg_outbox WHERE status='held'"),
      submitted: cnt("SELECT COUNT(*) c FROM msg_outbox WHERE status='submitted'"),
      delivered: cnt("SELECT COUNT(*) c FROM msg_outbox WHERE status='delivered'"),
      read: cnt("SELECT COUNT(*) c FROM msg_outbox WHERE status='read'"),
      failed: cnt("SELECT COUNT(*) c FROM msg_outbox WHERE status='failed'"),
      skipped: cnt("SELECT COUNT(*) c FROM msg_outbox WHERE status='skipped'"),
      today: todayCnt
    },
    subs: {
      customers: cnt('SELECT COUNT(DISTINCT customer_id) c FROM msg_subscriptions'),
      subscribed: cnt("SELECT COUNT(*) c FROM msg_subscriptions WHERE status='subscribed'"),
      marketing_off: cnt("SELECT COUNT(*) c FROM msg_subscriptions WHERE topic='marketing' AND status='unsubscribed'"),
      email_unverified: cnt("SELECT COUNT(*) c FROM msg_subscriptions WHERE channel='email' AND status='subscribed' AND verify_status<>'verified'")
    },
    alerts: {
      waiting: cnt("SELECT COUNT(*) c FROM msg_arrival_alerts WHERE status='waiting'"),
      notified: cnt("SELECT COUNT(*) c FROM msg_arrival_alerts WHERE status='notified'")
    },
    channels: cap,
    wechat_ready: !!(wechat && wechat.usable),
    email_ready: !!(email && email.usable),
    templates: {
      approved: cnt("SELECT COUNT(*) c FROM msg_templates WHERE status='approved'"),
      pending: cnt("SELECT COUNT(*) c FROM msg_templates WHERE status='pending'"),
      draft: cnt("SELECT COUNT(*) c FROM msg_templates WHERE status='draft'")
    },
    attribution: {
      delivered: cnt("SELECT COUNT(*) c FROM msg_attributions WHERE stage='delivered'"),
      read: cnt("SELECT COUNT(*) c FROM msg_attributions WHERE stage='read'"),
      inquiry: cnt("SELECT COUNT(*) c FROM msg_attributions WHERE stage='inquiry'"),
      order: cnt("SELECT COUNT(*) c FROM msg_attributions WHERE stage='order'")
    },
    notes: [
      '上新/到货提醒只在「发布审核通过 + 可售 > 0」后触发，且只发给订阅了该款号的客户',
      wechat && wechat.usable ? '微信渠道已授权可用' : '微信渠道未授权：所有微信消息自动降级到站内/邮件，系统不声称已通过微信发出',
      email && !email.usable ? '邮件渠道未启用：邮件消息会降级到站内' : null
    ].filter(Boolean)
  };
}

module.exports = {
  CHANNELS, TOPICS, EVENT_KINDS,
  dict, overview,
  // 订阅
  listSubs, upsertSub, unsubscribeMarketing, requestEmailVerify, confirmEmailVerify, subOf, subUsable,
  // 模板
  listTemplates, getTemplate, createTemplate, updateTemplate, submitTemplate, approveTemplate, retireTemplate, deleteTemplate, approvedTemplate,
  // 渠道
  listCaps, setCap, capOf, capUsable, listBindings, bindWechat, syncWechat,
  // 频控
  listRules, saveRule, checkFrequency, freqRuleOf, localHourOf, inQuiet,
  // 事件与发送
  emitEvent, listEvents, createOutbox, listOutbox, getOutbox, sendOutbox, receipt, retryOutbox, skipOutbox, dispatchPending,
  // 到货提醒
  listAlerts, createAlert, cancelAlert, sweepAlerts, productReady,
  // 周期
  cycleTasks,
  // 归因
  refreshAttribution, attributionReport
};
