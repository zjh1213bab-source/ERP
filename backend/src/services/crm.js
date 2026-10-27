/**
 * 销售与客户（原型 M03 剩余 5 个节点）
 * ============================================================
 * 线索商机 / 客户采购周期 / 客户价值排行 / 目标与提成 / 客户交接
 *
 * 五条不能松的口径（每条都对应原型里一句明确规则）：
 *
 * 1. **预计商机金额不是收入**
 *    `crm_leads.est_amount` 只出现在线索列表和商机漏斗里，任何「金额 / 收入 / 目标 / 提成」
 *    都从订单、发票、收付款取数。一旦让商机金额进口径，销售就会去堆商机而不是成交。
 *
 * 2. **有效采购才刷新周期**
 *    内部交易、样衣、免费补发都不算复购。所以刷新采购日时按「订单状态已到 assigned 之后 +
 *    非集团内部客户 + 订单金额 > 0」过滤；回访本身**绝不**刷新采购日（否则永远不超期）。
 *
 * 3. **周期未知不编 0 天**
 *    `status=unknown` 时 `cycle_days` 必须为空，并且必须写原因、指定责任人、给出复核日。
 *    填 0 会让「应购日 = 采购日」，客户天天超期，预警立刻失去意义。
 *
 * 4. **提成来源行防重**
 *    同一条订单 / 发票 / 收款在全公司范围内只能被计一次提成（库里有唯一索引兜底）。
 *    退款与坏账调整必须指向来源单据，且不自动扣薪 —— 提成单只生成一笔薪酬来源。
 *
 * 5. **交接不改历史业绩**
 *    交接只改客户归属与未结任务归属，历史提成单的 `dept_snapshot` / `manager_snapshot`
 *    保持原样。员工调动不改历史归属，否则去年做完的单子会被算到今年的人头上。
 *
 * 时间口径：本地墙钟字符串（services/sla.js 的 localNow/localDate）。
 */
const { db } = require('../db');
const { localNow, localDate } = require('./sla');
const { genNo } = require('../utils/http');

/** ==================== 基础工具 ==================== */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (s) => String(s || '').slice(0, 10);
const periodOf = (s) => String(s || '').slice(0, 7);
const today = () => localDate();
const now = () => localNow();

/** 日期加减（只处理 YYYY-MM-DD，不碰时区） */
function addDays(dateStr, n) {
  const [y, m, d] = ymd(dateStr).split('-').map(Number);
  const t = new Date(y, m - 1, d);
  t.setDate(t.getDate() + Number(n || 0));
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function daysBetween(a, b) {
  const p = (x) => {
    const [y, m, d] = ymd(x).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((p(b) - p(a)) / 86400000);
}
/**
 * 单号：前缀 + 日期 + 4 位序号。
 * 序号取「已有的最大号 + 1」，不能用 COUNT(*)+1 —— 中间删过一条就会撞号
 * （历史数据里断号很常见；撞的是 UNIQUE 约束，只在偶发情况下才炸，很难查）。
 */
function nextNo(prefix, table, col) {
  const d = localDate().replace(/-/g, '');
  const head = `${prefix}${d}`;
  const rows = db.prepare(`SELECT ${col} n FROM ${table} WHERE ${col} LIKE ?`).all(`${head}%`);
  let max = 0;
  rows.forEach((r) => {
    const v = Number(String(r.n).slice(head.length));
    if (Number.isFinite(v) && v > max) max = v;
  });
  return `${head}${String(max + 1).padStart(4, '0')}`;
}
function me(op) {
  if (!op) return 'system';
  return typeof op === 'string' ? op : (op.name || op.username || 'system');
}
/** JWT 里用户 id 在 sub 上（不是 id），两种都认，否则认领这类动作会拿不到人 */
function userIdOf(op) {
  if (!op || typeof op === 'string') return null;
  return op.id || op.sub || null;
}

/** ==================== 字典 ==================== */

const LEAD_SOURCE_LABEL = {
  platform: '平台询盘', referral: '客户转介绍', exhibition: '展会', website: '官网/社媒',
  import: '受控导入', manual: '手工登记'
};
const LEAD_STAGE = ['new', 'qualifying', 'sampling', 'won', 'lost'];
const LEAD_STAGE_LABEL = {
  new: '新线索', qualifying: '需求确认', sampling: '样衣中', won: '已转订单', lost: '已丢单'
};
const LOST_REASON_LABEL = {
  price: '价格', spec: '规格工艺做不了', delivery: '交期来不及', sample: '样衣不满意',
  credit: '付款条件/信用', no_budget: '客户预算取消', competitor: '被同行拿走',
  duplicate: '重复线索合并', no_response: '客户失联', other: '其他'
};
const CYCLE_STATUS = ['unknown', 'known', 'seasonal', 'oneoff'];
const CYCLE_STATUS_LABEL = {
  unknown: '周期未知', known: '周期已知', seasonal: '季节客户', oneoff: '一次性客户'
};
const CYCLE_BASIS_LABEL = { manual: '人工确认', inferred: '系统推断', contract: '合同约定' };
const FOLLOW_RESULT_LABEL = {
  no_answer: '未接通', replied: '已回复未下单', ordered: '已下单', lost_contact: '已失联'
};
const HANDOVER_REASON_LABEL = { resign: '离职', transfer: '调岗', leave: '长期休假' };
const METRIC_LABEL = { amount: '订单净额', revenue: '确认收入', collection: '回款', gross: '毛利' };
const BASE_TYPE_LABEL = { collection: '已批准回款', revenue: '确认收入', gross: '毛利' };
const COMM_STATUS_LABEL = {
  draft: '草稿', reviewing: '待复核', rejected: '已驳回', approved: '已批准', settled: '已引薪酬'
};
const COMM_BASE_LABEL = { collection: '已批准回款', revenue: '确认收入', gross: '毛利' };

/** 有效采购订单状态：草稿/取消还不算买过东西 */
const VALID_ORDER_STATUS = ['assigned', 'production', 'instock', 'shipped', 'closed'];

function dict() {
  return {
    companies: db.prepare('SELECT id, code, name FROM companies ORDER BY id').all(),
    customers: db.prepare("SELECT id, code, name FROM customers WHERE status<>'disabled' ORDER BY name").all(),
    users: db.prepare("SELECT id, username, name, role FROM users WHERE role IN ('sales','admin','finance') ORDER BY id").all(),
    lead_source: Object.entries(LEAD_SOURCE_LABEL).map(([k, v]) => ({ k, v })),
    lead_stage: LEAD_STAGE.map((k) => ({ k, v: LEAD_STAGE_LABEL[k] })),
    lost_reason: Object.entries(LOST_REASON_LABEL).map(([k, v]) => ({ k, v })),
    cycle_status: CYCLE_STATUS.map((k) => ({ k, v: CYCLE_STATUS_LABEL[k] })),
    follow_result: Object.entries(FOLLOW_RESULT_LABEL).map(([k, v]) => ({ k, v })),
    handover_reason: Object.entries(HANDOVER_REASON_LABEL).map(([k, v]) => ({ k, v })),
    metric: Object.entries(METRIC_LABEL).map(([k, v]) => ({ k, v })),
    base_type: Object.entries(BASE_TYPE_LABEL).map(([k, v]) => ({ k, v })),
    today: today()
  };
}

/** ==================== 集团内部往来识别 ==================== */
/**
 * 内部转单不是「销售业绩」，也不刷新客户复购周期。
 * 这里按 ref_id 与 ref_name 双条件匹配（历史数据里两种都出现过）。
 */
function internalSet() {
  const rows = db.prepare("SELECT ref_id, ref_name FROM intercompany_parties WHERE status='active'").all();
  const ids = new Set();
  const names = new Set();
  rows.forEach((r) => {
    if (r.ref_id) ids.add(Number(r.ref_id));
    if (r.ref_name) names.add(String(r.ref_name).trim());
  });
  return { ids, names };
}
function isInternal(cust, set) {
  if (!cust) return false;
  return set.ids.has(Number(cust.id)) || set.names.has(String(cust.name || '').trim());
}

function customerMap() {
  const m = new Map();
  db.prepare('SELECT id, code, name, company_id, owner_user_id, owner_name, status FROM customers').all()
    .forEach((c) => m.set(Number(c.id), c));
  return m;
}

/** ==================== 一、线索与商机 ==================== */

function leadRows(q) {
  const where = [];
  const args = [];
  if (q.company_id) { where.push('l.company_id=?'); args.push(Number(q.company_id)); }
  if (q.stage && q.stage !== 'all') { where.push('l.stage=?'); args.push(q.stage); }
  if (q.source) { where.push('l.source=?'); args.push(q.source); }
  if (q.owner_user_id) { where.push('l.owner_user_id=?'); args.push(Number(q.owner_user_id)); }
  if (String(q.pool) === '1') where.push('l.in_pool=1');
  if (String(q.pool) === '0') where.push('l.in_pool=0');
  if (q.q) { where.push('(l.customer_name_raw LIKE ? OR l.lead_no LIKE ? OR l.contact LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const sql = `SELECT l.*, c.code customer_code, c.name customer_name, c.owner_name customer_owner
    FROM crm_leads l LEFT JOIN customers c ON c.id=l.customer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE l.stage WHEN 'sampling' THEN 0 WHEN 'qualifying' THEN 1 WHEN 'new' THEN 2 WHEN 'won' THEN 3 ELSE 4 END,
             COALESCE(l.next_action_date,'9999-12-31'), l.id DESC`;
  return db.prepare(sql).all(...args);
}

function decorateLead(l) {
  const t = today();
  const late = !l.first_response_at && l.response_due && l.response_due < t;
  const nextLate = l.next_action_date && l.next_action_date < t && !['won', 'lost'].includes(l.stage);
  const logs = db.prepare('SELECT * FROM crm_lead_logs WHERE lead_id=? ORDER BY id DESC').all(l.id);
  return {
    ...l,
    stage_label: LEAD_STAGE_LABEL[l.stage] || l.stage,
    source_label: LEAD_SOURCE_LABEL[l.source] || l.source,
    lost_reason_label: l.lost_reason ? (LOST_REASON_LABEL[l.lost_reason] || l.lost_reason) : null,
    is_response_late: !!late,
    is_next_late: !!nextLate,
    // 商机金额只是参考，不进任何收入口径 —— 界面上也这么写
    est_amount_note: '预计商机金额，不计入收入、目标或提成',
    dup_cnt: db.prepare("SELECT COUNT(*) c FROM crm_leads WHERE customer_name_raw=? AND id<>? AND stage NOT IN ('won','lost')")
      .get(l.customer_name_raw, l.id).c,
    log_cnt: logs.length,
    logs
  };
}

function listLeads(q = {}) {
  return leadRows(q).map(decorateLead);
}

function getLead(id) {
  const l = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(Number(id));
  if (!l) throw new Error('线索不存在');
  const out = decorateLead(l);
  out.dups = db.prepare(
    "SELECT id, lead_no, customer_name_raw, stage, owner_name, created_at FROM crm_leads WHERE customer_name_raw=? AND id<>? AND stage NOT IN ('won','lost')"
  ).all(l.customer_name_raw, l.id);
  out.sample = l.sample_id ? db.prepare('SELECT id, style_no, type, status, due_date FROM sample_requests WHERE id=?').get(l.sample_id) : null;
  out.order = l.order_id ? db.prepare('SELECT id, order_no, status, total_amount, currency FROM orders WHERE id=?').get(l.order_id) : null;
  out.next_stages = LEAD_NEXT[l.stage] || [];
  return out;
}

/** 阶段流转：只能一步一步往前，won/lost 是终态（admin 可退回） */
const LEAD_NEXT = {
  new: ['qualifying', 'lost'],
  qualifying: ['sampling', 'won', 'lost'],
  sampling: ['won', 'lost'],
  won: [],
  lost: ['qualifying']
};

function createLead(b, op) {
  const name = String(b.customer_name_raw || b.customer_name || '').trim();
  let cust = null;
  if (b.customer_id) {
    cust = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(b.customer_id));
    if (!cust) throw new Error('客户不存在');
  }
  if (!name && !cust) throw new Error('客户名称必填（新客户也要先写一个可识别的名字）');
  const source = b.source && LEAD_SOURCE_LABEL[b.source] ? b.source : 'manual';
  const srcRef = String(b.source_ref || '').trim();

  // 查重：同一平台同一条线索 ID 只进一次
  if (srcRef) {
    const dup = db.prepare('SELECT * FROM crm_leads WHERE company_id=? AND source=? AND source_ref=?')
      .get(Number(b.company_id) || 1, source, srcRef);
    if (dup) throw new Error(`这条线索已经在系统里（${dup.lead_no}），不要重复录入；确认是同一客户请用「合并」`);
  }

  const est = b.est_amount === undefined || b.est_amount === null || b.est_amount === '' ? null : Number(b.est_amount);
  if (est !== null && (!Number.isFinite(est) || est < 0)) throw new Error('预计商机金额不能为负');

  const owner = b.owner_user_id ? db.prepare('SELECT * FROM users WHERE id=?').get(Number(b.owner_user_id)) : null;
  const due = b.response_due || addDays(today(), 1);
  const leadNo = nextNo('LD', 'crm_leads', 'lead_no');
  const info = db.prepare(`INSERT INTO crm_leads
    (lead_no,company_id,source,source_ref,customer_id,customer_name_raw,contact,phone,email,country,
     est_amount,est_currency,stage,owner_user_id,owner_name,response_due,next_action_date,next_action,
     in_pool,pool_since,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    leadNo, Number(b.company_id) || 1, source, srcRef || null, cust ? cust.id : null,
    name || cust.name, b.contact || null, b.phone || null, b.email || null, b.country || null,
    est, b.est_currency || 'USD', 'new',
    owner ? owner.id : null, owner ? owner.name : null,
    due, b.next_action_date || null, b.next_action || null,
    owner ? 0 : 1, owner ? null : now(), me(op), now(), now()
  );
  const id = info.lastInsertRowid;
  logLead(id, {
    action: 'create', to_stage: 'new', operator: me(op),
    note: `来源：${LEAD_SOURCE_LABEL[source]}${srcRef ? `（${srcRef}）` : ''}${owner ? '' : '；未指派 → 进公海'}`
  });
  return getLead(id);
}

function logLead(leadId, b) {
  db.prepare(`INSERT INTO crm_lead_logs (lead_id,action,from_stage,to_stage,note,evidence,next_date,operator,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    Number(leadId), b.action, b.from_stage || null, b.to_stage || null,
    b.note || null, b.evidence || null, b.next_date || null, b.operator || 'system', now()
  );
}

function updateLead(id, b, op) {
  const l = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(Number(id));
  if (!l) throw new Error('线索不存在');
  if (l.stage === 'won') throw new Error('已转订单的线索不能再改内容（要改请到订单上改）');
  const fields = [];
  const args = [];
  const MAP = ['contact', 'phone', 'email', 'country', 'next_action', 'next_action_date', 'est_currency', 'customer_name_raw'];
  MAP.forEach((k) => {
    if (b[k] !== undefined) { fields.push(`${k}=?`); args.push(b[k] === '' ? null : b[k]); }
  });
  if (b.est_amount !== undefined) {
    const v = b.est_amount === '' || b.est_amount === null ? null : Number(b.est_amount);
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error('预计商机金额不能为负');
    fields.push('est_amount=?'); args.push(v);
  }
  if (b.customer_id !== undefined) {
    const c = b.customer_id ? db.prepare('SELECT * FROM customers WHERE id=?').get(Number(b.customer_id)) : null;
    fields.push('customer_id=?'); args.push(c ? c.id : null);
    if (c && !b.customer_name_raw) { fields.push('customer_name_raw=?'); args.push(c.name); }
  }
  if (!fields.length) return getLead(id);
  fields.push('updated_at=?'); args.push(now());
  db.prepare(`UPDATE crm_leads SET ${fields.join(',')} WHERE id=?`).run(...args, l.id);
  return getLead(id);
}

function assignLead(id, b, op) {
  const l = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(Number(id));
  if (!l) throw new Error('线索不存在');
  if (['won'].includes(l.stage)) throw new Error('已转订单的线索不用再分配');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(b.to_user_id || b.owner_user_id));
  if (!u) throw new Error('接收人不存在');
  if (!['sales', 'admin'].includes(u.role)) throw new Error(`${u.name} 不是销售角色，不能接线索`);
  db.prepare('UPDATE crm_leads SET owner_user_id=?, owner_name=?, in_pool=0, pool_since=NULL, updated_at=? WHERE id=?')
    .run(u.id, u.name, now(), l.id);
  logLead(l.id, {
    action: 'assign', from_stage: l.stage, to_stage: l.stage, operator: me(op),
    note: `分配给 ${u.name}${l.owner_name ? `（原责任人 ${l.owner_name}）` : ''}`
  });
  return getLead(l.id);
}

function claimLead(id, op) {
  const l = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(Number(id));
  if (!l) throw new Error('线索不存在');
  if (!l.in_pool && l.owner_user_id) throw new Error(`这条线索已有责任人（${l.owner_name}），不能直接认领`);
  const uid = userIdOf(op);
  if (!uid) throw new Error('认领需要登录账号');
  db.prepare('UPDATE crm_leads SET owner_user_id=?, owner_name=?, in_pool=0, pool_since=NULL, updated_at=? WHERE id=?')
    .run(uid, me(op), now(), l.id);
  logLead(l.id, { action: 'claim', from_stage: l.stage, to_stage: l.stage, operator: me(op), note: '公海认领' });
  return getLead(l.id);
}

function recycleLead(id, b, op) {
  const l = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(Number(id));
  if (!l) throw new Error('线索不存在');
  if (['won', 'lost'].includes(l.stage)) throw new Error('已结束的线索不能回收公海');
  if (l.in_pool) throw new Error('这条线索已经在公海');
  db.prepare('UPDATE crm_leads SET in_pool=1, pool_since=?, owner_user_id=NULL, owner_name=NULL, updated_at=? WHERE id=?')
    .run(now(), now(), l.id);
  logLead(l.id, {
    action: 'recycle', from_stage: l.stage, to_stage: l.stage, operator: me(op),
    note: b.reason || `回收公海（原责任人 ${l.owner_name || '未指派'}）`
  });
  return getLead(l.id);
}

/** 响应超时自动回收：只回收「一次都没响应过」的，别把正在谈的也扫走 */
function sweepPool(op) {
  const rows = db.prepare(`SELECT * FROM crm_leads
    WHERE in_pool=0 AND first_response_at IS NULL AND stage IN ('new','qualifying')
      AND response_due IS NOT NULL AND response_due < ?`).all(today());
  rows.forEach((l) => {
    db.prepare('UPDATE crm_leads SET in_pool=1, pool_since=?, owner_user_id=NULL, owner_name=NULL, updated_at=? WHERE id=?')
      .run(now(), now(), l.id);
    logLead(l.id, {
      action: 'recycle', from_stage: l.stage, to_stage: l.stage, operator: me(op),
      note: `响应超期（期限 ${l.response_due}）自动回收公海`
    });
  });
  return { recycled: rows.length, leads: rows.map((r) => r.lead_no) };
}

function followLead(id, b, op) {
  const l = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(Number(id));
  if (!l) throw new Error('线索不存在');
  if (['won', 'lost'].includes(l.stage)) throw new Error('线索已结束，不能再登记跟进');
  const evidence = String(b.evidence || '').trim();
  const nextDate = String(b.next_action_date || '').trim();
  // 原型：跟进有下次日期和证据 —— 缺一个就变成「聊过了但没下文」
  if (!evidence) throw new Error('跟进必须写证据（聊天记录 / 邮件 / 会议纪要编号）');
  if (!nextDate) throw new Error('跟进必须写下一次动作日期');
  if (!b.note) throw new Error('写一句这次谈了什么');
  const t = today();
  const late = !l.first_response_at && l.response_due && l.response_due < t;
  db.prepare('UPDATE crm_leads SET first_response_at=COALESCE(first_response_at,?), next_action_date=?, next_action=?, updated_at=? WHERE id=?')
    .run(now(), nextDate, b.next_action || l.next_action || null, now(), l.id);
  logLead(l.id, {
    action: 'follow', from_stage: l.stage, to_stage: l.stage, operator: me(op),
    note: (late ? '【响应超时】' : '') + b.note, evidence, next_date: nextDate
  });
  return getLead(l.id);
}

function setLeadStage(id, b, op) {
  const l = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(Number(id));
  if (!l) throw new Error('线索不存在');
  const to = String(b.to || '');
  if (!LEAD_STAGE.includes(to)) throw new Error('状态不合法');
  if (to === l.stage) throw new Error('已经在这个状态了');
  const allow = LEAD_NEXT[l.stage] || [];
  if (!allow.includes(to)) {
    throw new Error(`不能从「${LEAD_STAGE_LABEL[l.stage]}」直接到「${LEAD_STAGE_LABEL[to]}」`);
  }
  if (to === 'lost') {
    if (!b.lost_reason || !LOST_REASON_LABEL[b.lost_reason]) throw new Error('丢单必须选原因（丢单原因是复盘的基础）');
    if (b.lost_reason === 'other' && !String(b.lost_note || '').trim()) throw new Error('原因选「其他」时必须写说明');
  }
  let order = null;
  if (to === 'won') {
    if (!b.order_id) throw new Error('转订单必须指定真实订单（线索不能凭空变成订单）');
    order = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(b.order_id));
    if (!order) throw new Error('订单不存在');
    if (order.status === 'draft') throw new Error('订单还是草稿，确认后再把线索转成订单');
    // 同源关联：线索客户与订单客户必须一致，避免拿别的单来充数
    if (l.customer_id && order.customer_id && Number(order.customer_id) !== Number(l.customer_id)) {
      throw new Error('这条线索的客户与所选订单的客户不一致，不能关联');
    }
  }
  const patch = ['stage=?', 'updated_at=?'];
  const args = [to, now()];
  if (to === 'lost') { patch.push('lost_reason=?', 'lost_note=?'); args.push(b.lost_reason, b.lost_note || null); }
  if (to === 'won') { patch.push('order_id=?', 'in_pool=0', 'pool_since=NULL', 'lost_reason=NULL'); args.push(order.id); }
  if (b.sample_id) { patch.push('sample_id=?'); args.push(Number(b.sample_id)); }
  if (to === 'sampling' && !l.customer_id && order) { /* 样衣阶段不强制客户 */ }
  db.prepare(`UPDATE crm_leads SET ${patch.join(',')} WHERE id=?`).run(...args, l.id);
  // won 时若线索还没挂客户，跟着订单补上
  if (to === 'won' && !l.customer_id && order.customer_id) {
    db.prepare('UPDATE crm_leads SET customer_id=? WHERE id=?').run(order.customer_id, l.id);
  }
  logLead(l.id, {
    action: 'stage', from_stage: l.stage, to_stage: to, operator: me(op),
    note: b.note || (to === 'won' ? `转订单 ${order.order_no}` : to === 'lost' ? `丢单：${LOST_REASON_LABEL[b.lost_reason]}` : '')
  });
  return getLead(l.id);
}

/** 合并重复线索：只建议、不自动并客户（原型明确） */
function mergeLead(id, b, op) {
  const l = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(Number(id));
  const t = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(Number(b.into_id));
  if (!l) throw new Error('线索不存在');
  if (!t) throw new Error('合并目标不存在');
  if (l.id === t.id) throw new Error('不能合并到自己');
  if (['won'].includes(l.stage)) throw new Error('已转订单的线索不要合并（会丢订单关联）');
  if (['won', 'lost'].includes(t.stage)) throw new Error('目标是已结束的线索，请选一条还在跟的');
  db.prepare("UPDATE crm_leads SET duplicate_of=?, stage='lost', lost_reason='duplicate', in_pool=0, pool_since=NULL, updated_at=? WHERE id=?")
    .run(t.id, now(), l.id);
  logLead(l.id, { action: 'merge', from_stage: l.stage, to_stage: 'lost', operator: me(op), note: `合并入 ${t.lead_no}（客户档案不自动合并，需人工核对）` });
  logLead(t.id, { action: 'merge', from_stage: t.stage, to_stage: t.stage, operator: me(op), note: `${l.lead_no} 合并到本条` });
  return getLead(t.id);
}

/** 受控导入：平台接口授权不足时走这里，逐行校验，坏行不落库 */
function importLeads(rows, op) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('没有要导入的数据');
  if (rows.length > 200) throw new Error('一次最多导入 200 条');
  const okRows = [];
  const failed = [];
  rows.forEach((r, i) => {
    try {
      const created = createLead({ ...r, source: r.source || 'import' }, op);
      okRows.push({ row: i + 1, lead_no: created.lead_no, name: created.customer_name_raw });
    } catch (e) {
      failed.push({ row: i + 1, name: r.customer_name_raw || r.customer_name || '', reason: e.message });
    }
  });
  return { imported: okRows.length, failed, rows: okRows };
}

function deleteLead(id, op) {
  const l = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(Number(id));
  if (!l) throw new Error('线索不存在');
  if (['won'].includes(l.stage)) throw new Error('已转订单的线索不能删（订单还要能追来源）');
  db.prepare('DELETE FROM crm_lead_logs WHERE lead_id=?').run(l.id);
  db.prepare('DELETE FROM crm_leads WHERE id=?').run(l.id);
  return { deleted: 1, lead_no: l.lead_no, by: me(op) };
}

/** ==================== 二、客户采购周期 ==================== */

/** 每个客户的有效采购统计（内部交易/样衣/零金额不算） */
function purchaseStats() {
  const set = internalSet();
  const cmap = customerMap();
  const orders = db.prepare(`SELECT id, order_no, customer_id, status, type, order_date, total_amount, currency
    FROM orders WHERE order_date IS NOT NULL ORDER BY order_date`).all();
  const stat = new Map();
  const t = today();
  orders.forEach((o) => {
    const c = cmap.get(Number(o.customer_id));
    if (!c) return;
    if (isInternal(c, set)) return;                       // 内部转单不算复购
    if (o.type === 'sample') return;                      // 样衣不算
    if (Number(o.total_amount || 0) <= 0) return;         // 免费补发不算
    if (!VALID_ORDER_STATUS.includes(o.status)) return;    // 草稿/取消不算买过东西
    const s = stat.get(Number(o.customer_id)) || { dates: [], amount: 0, cnt: 0, last: null, orders: [] };
    s.dates.push(ymd(o.order_date));
    s.amount += Number(o.total_amount || 0);
    s.cnt += 1;
    s.last = ymd(o.order_date);
    s.orders.push(o.id);
    stat.set(Number(o.customer_id), s);
  });
  // 3 / 6 / 12 月窗口（自然月观察，与周期超期分开算）
  stat.forEach((s) => {
    const w = (m) => s.dates.filter((d) => daysBetween(d, t) <= m * 30 && daysBetween(d, t) >= 0).length;
    s.win3 = w(3); s.win6 = w(6); s.win12 = w(12);
  });
  return stat;
}

function cycleRow(cust, cyc, stat) {
  const t = today();
  const s = stat.get(Number(cust.id)) || { dates: [], amount: 0, cnt: 0, last: null, win3: 0, win6: 0, win12: 0 };
  const lastPurchase = s.last || (cyc && cyc.last_purchase_date) || null;
  const cycleDays = cyc && cyc.cycle_days ? Number(cyc.cycle_days) : null;
  const nextDue = cycleDays && lastPurchase ? addDays(lastPurchase, cycleDays) : null;
  const overdueDays = nextDue && t > nextDue ? daysBetween(nextDue, t) : 0;
  const grace = cyc ? Number(cyc.grace_days || 0) : 0;
  return {
    customer_id: cust.id,
    customer_code: cust.code,
    customer_name: cust.name,
    company_id: cust.company_id,
    owner_user_id: (cyc && cyc.owner_user_id) || cust.owner_user_id || null,
    owner_name: (cyc && cyc.owner_name) || cust.owner_name || null,
    status: cyc ? cyc.status : 'unknown',
    status_label: CYCLE_STATUS_LABEL[(cyc && cyc.status) || 'unknown'],
    basis: cyc ? cyc.basis : null,
    basis_label: cyc && cyc.basis ? (CYCLE_BASIS_LABEL[cyc.basis] || cyc.basis) : '—',
    cycle_days: cyc ? cyc.cycle_days : null,
    reason: cyc ? cyc.reason : null,
    review_date: cyc ? cyc.review_date : null,
    grace_days: grace,
    last_purchase_date: lastPurchase,
    last_order_id: cyc ? cyc.last_order_id : null,
    next_due_date: nextDue,
    overdue_days: overdueDays,
    // 宽限只控制升级，不改变「是否超期」
    is_overdue: overdueDays > 0,
    escalated: overdueDays > grace,
    due_in_days: nextDue ? daysBetween(t, nextDue) : null,
    order_cnt: s.cnt,
    amount_12m: r2(s.amount),
    win3: s.win3 || 0,
    win6: s.win6 || 0,
    win12: s.win12 || 0,
    last_followup_at: cyc ? cyc.last_followup_at : null
  };
}

function listCycles(q = {}) {
  const stat = purchaseStats();
  const cycMap = new Map();
  db.prepare('SELECT * FROM crm_customer_cycles').all().forEach((c) => cycMap.set(Number(c.customer_id), c));
  let custs = db.prepare("SELECT * FROM customers WHERE status<>'disabled' ORDER BY name").all();
  if (q.company_id) custs = custs.filter((c) => !c.company_id || Number(c.company_id) === Number(q.company_id));
  let rows = custs.map((c) => cycleRow(c, cycMap.get(Number(c.id)), stat));
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (String(q.overdue) === '1') rows = rows.filter((r) => r.is_overdue);
  if (String(q.escalated) === '1') rows = rows.filter((r) => r.escalated);
  if (q.owner_user_id) rows = rows.filter((r) => Number(r.owner_user_id) === Number(q.owner_user_id));
  if (q.q) rows = rows.filter((r) => r.customer_name.includes(q.q) || r.customer_code.includes(q.q));
  // 默认只看「有周期记录或有过有效采购」的客户：全量客户里大半是没往来的档案，
  // 全铺出来会把真正的预警埋掉；要看全部档案的周期缺口时传 scope=all
  if (q.scope !== 'all') {
    rows = rows.filter((r) => r.status !== 'unknown' || r.last_purchase_date || r.order_cnt > 0);
  }
  rows.sort((a, b) => {
    if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1;
    return (b.overdue_days || 0) - (a.overdue_days || 0);
  });
  return rows;
}

function upsertCycle(b, op) {
  const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(b.customer_id));
  if (!cust) throw new Error('客户不存在');
  const status = String(b.status || '');
  if (!CYCLE_STATUS.includes(status)) throw new Error('周期状态不合法');

  let days = b.cycle_days === '' || b.cycle_days === null || b.cycle_days === undefined ? null : Number(b.cycle_days);
  if (status === 'known') {
    if (!days || days < 1) throw new Error('周期已知时必须填天数（至少 1 天）');
    if (days > 3650) throw new Error('周期天数不合常理（>3650 天）');
  }
  // 未知 / 一次性：不允许编 0 天
  if (status === 'unknown' || status === 'oneoff') days = null;
  if (status === 'unknown') {
    if (!String(b.reason || '').trim()) throw new Error('周期未知必须写原因（不知道客户多久买一次，是常态不是空白）');
    if (!b.owner_user_id) throw new Error('周期未知必须指定责任人');
    if (!b.review_date) throw new Error('周期未知必须给复核日（什么时候回来确认）');
  }
  if (status === 'seasonal' && !String(b.reason || '').trim()) throw new Error('季节客户必须写清采购季（几月到几月）');
  if (status === 'seasonal' && !b.review_date) throw new Error('季节客户必须有下次复核日');

  let owner = null;
  if (b.owner_user_id) {
    owner = db.prepare('SELECT * FROM users WHERE id=?').get(Number(b.owner_user_id));
    if (!owner) throw new Error('责任人不存在');
  }
  const old = db.prepare('SELECT * FROM crm_customer_cycles WHERE customer_id=?').get(cust.id);
  const stat = purchaseStats();
  const last = (stat.get(cust.id) || {}).last || (old && old.last_purchase_date) || null;
  const nextDue = days && last ? addDays(last, days) : null;

  if (old) {
    db.prepare(`UPDATE crm_customer_cycles SET status=?, cycle_days=?, basis=?, reason=?, owner_user_id=?, owner_name=?,
      review_date=?, last_purchase_date=COALESCE(?,last_purchase_date), next_due_date=?, grace_days=?, updated_by=?, updated_at=?
      WHERE customer_id=?`).run(
      status, days, b.basis || 'manual', b.reason || null,
      owner ? owner.id : old.owner_user_id, owner ? owner.name : old.owner_name,
      b.review_date || null, last, nextDue,
      b.grace_days === undefined ? old.grace_days : Number(b.grace_days || 0),
      me(op), now(), cust.id
    );
  } else {
    db.prepare(`INSERT INTO crm_customer_cycles
      (customer_id,company_id,status,cycle_days,basis,reason,owner_user_id,owner_name,review_date,
       last_purchase_date,next_due_date,grace_days,updated_by,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      cust.id, cust.company_id || 1, status, days, b.basis || 'manual', b.reason || null,
      owner ? owner.id : null, owner ? owner.name : null, b.review_date || null,
      last, nextDue, Number(b.grace_days || 0), me(op), now()
    );
  }
  db.prepare(`INSERT INTO crm_cycle_logs (customer_id,from_status,to_status,from_cycle,to_cycle,from_due,to_due,reason,operator,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    cust.id, old ? old.status : null, status, old ? old.cycle_days : null, days,
    old ? old.next_due_date : null, nextDue, b.reason || b.note || '维护周期', me(op), now()
  );
  return listCycles({ q: cust.name }).find((r) => Number(r.customer_id) === Number(cust.id));
}

/** 刷新有效采购日：只认有效订单，回访不刷新 */
function refreshCycles(op) {
  const stat = purchaseStats();
  const rows = db.prepare('SELECT * FROM crm_customer_cycles').all();
  let changed = 0;
  rows.forEach((c) => {
    const s = stat.get(Number(c.customer_id));
    if (!s || !s.last) return;
    if (c.last_purchase_date === s.last) return;
    const due = c.status === 'known' && c.cycle_days ? addDays(s.last, Number(c.cycle_days)) : c.next_due_date;
    db.prepare('UPDATE crm_customer_cycles SET last_purchase_date=?, last_order_id=?, next_due_date=?, updated_at=? WHERE id=?')
      .run(s.last, s.orders[s.orders.length - 1] || null, due, now(), c.id);
    changed += 1;
  });
  return { refreshed: changed, by: me(op) };
}

/**
 * 周期推断：只给建议，不落库。
 * 取相邻两次有效采购的间隔中位数，至少 3 次采购才给建议（2 次只能算一个间隔，噪声太大）。
 */
function inferCycles() {
  const stat = purchaseStats();
  const cmap = customerMap();
  const cyc = new Map();
  db.prepare('SELECT * FROM crm_customer_cycles').all().forEach((c) => cyc.set(Number(c.customer_id), c));
  const out = [];
  stat.forEach((s, cid) => {
    const c = cmap.get(cid);
    if (!c) return;
    const cur = cyc.get(cid);
    if (cur && cur.status === 'known' && cur.basis !== 'inferred') return; // 已人工确认过的不再建议
    const dates = [...s.dates].sort();
    if (dates.length < 3) return;
    const gaps = [];
    for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
    const valid = gaps.filter((g) => g > 0);
    if (!valid.length) return;
    valid.sort((a, b) => a - b);
    const mid = valid.length % 2 ? valid[(valid.length - 1) / 2] : Math.round((valid[valid.length / 2 - 1] + valid[valid.length / 2]) / 2);
    out.push({
      customer_id: cid, customer_code: c.code, customer_name: c.name,
      sample_cnt: dates.length, gaps: valid, suggested_days: mid,
      current_status: cur ? cur.status : 'unknown', current_cycle: cur ? cur.cycle_days : null,
      note: '系统按历史间隔推断，仅作建议；采纳需人工确认（会记进周期变更留痕）'
    });
  });
  out.sort((a, b) => b.sample_cnt - a.sample_cnt);
  return out;
}

/** 采纳推断：人工确认后写成 known */
function acceptInference(customerId, days, op) {
  const n = Number(days);
  if (!n || n < 1) throw new Error('推断天数不合法');
  return upsertCycle({
    customer_id: customerId, status: 'known', cycle_days: n, basis: 'manual',
    reason: `采纳系统推断（${n} 天）`
  }, op);
}

function listFollowups(q = {}) {
  const where = [];
  const args = [];
  if (q.customer_id) { where.push('f.customer_id=?'); args.push(Number(q.customer_id)); }
  if (q.result) { where.push('f.result=?'); args.push(q.result); }
  const rows = db.prepare(`SELECT f.*, c.name customer_name, c.code customer_code
    FROM crm_followups f LEFT JOIN customers c ON c.id=f.customer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY f.id DESC LIMIT 200`).all(...args);
  return rows.map((r) => ({ ...r, result_label: r.result ? (FOLLOW_RESULT_LABEL[r.result] || r.result) : '—' }));
}

/** 回访：只写跟进记录与 last_followup_at，**不刷新采购日**（否则永远不超期） */
function addFollowup(b, op) {
  const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(b.customer_id));
  if (!cust) throw new Error('客户不存在');
  if (!b.contact_note || !String(b.contact_note).trim()) throw new Error('写一句这次联系的结果');
  const result = b.result || 'replied';
  if (!FOLLOW_RESULT_LABEL[result]) throw new Error('回访结果不合法');
  const cyc = db.prepare('SELECT * FROM crm_customer_cycles WHERE customer_id=?').get(cust.id);
  const info = db.prepare(`INSERT INTO crm_followups
    (customer_id,cycle_id,kind,due_date,contact_note,result,next_date,evidence,order_id,operator,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    cust.id, cyc ? cyc.id : null, b.kind || 'cycle_due', b.due_date || (cyc ? cyc.next_due_date : null),
    b.contact_note, result, b.next_date || null, b.evidence || null,
    b.order_id ? Number(b.order_id) : null, me(op), now()
  );
  if (cyc) db.prepare('UPDATE crm_customer_cycles SET last_followup_at=?, updated_at=? WHERE id=?').run(now(), now(), cyc.id);
  return { id: info.lastInsertRowid, note: '回访已登记；采购日不会被回访刷新，只有真实有效订单才刷新' };
}

/** 预警清单：超期（宽限内也算超期）+ 未来 7 天到期 */
function cycleAlerts(q = {}) {
  const rows = listCycles(q);
  const overdue = rows.filter((r) => r.is_overdue);
  const escalated = overdue.filter((r) => r.escalated);
  const soon = rows.filter((r) => !r.is_overdue && r.due_in_days !== null && r.due_in_days >= 0 && r.due_in_days <= 7);
  return {
    overdue, escalated, soon,
    counts: { overdue: overdue.length, escalated: escalated.length, soon: soon.length },
    note: '超期次日提醒；宽限期只控制是否升级，不改变「已超期」这个事实'
  };
}

/** ==================== 三、客户价值排行 ==================== */

/**
 * 四个指标分口径取数，各有自己的时间与币种（原型：订单额/收入/回款/毛利分口径）。
 * 净下单扣取消但不混减退货；实物交付另扣退回；缺成本不进毛利榜。
 */
function ranking(q = {}) {
  const from = q.from || `${periodOf(today())}-01`;
  const to = q.to || today();
  const metric = q.metric || 'revenue';
  const set = internalSet();
  const cmap = customerMap();
  const ownerOf = (cust) => (cust ? (cust.owner_name || (cust.owner_user_id ? `#${cust.owner_user_id}` : '未归属')) : '未归属');

  const stat = new Map();
  const bump = (cid, k, v) => {
    const row = stat.get(Number(cid)) || {
      customer_id: Number(cid), orders_net: 0, order_cnt: 0, revenue: 0, collection: 0,
      gross: 0, has_cost: false, cost_missing: false, returned_qty: 0
    };
    row[k] = r2((row[k] || 0) + Number(v || 0));
    stat.set(Number(cid), row);
  };

  // 净下单：订单状态已确认（非草稿/取消）
  const orders = db.prepare(`SELECT id, order_no, customer_id, status, order_date, total_amount, currency
    FROM orders WHERE order_date>=? AND order_date<=? AND status NOT IN ('draft','cancelled')`).all(from, to);
  const orderIds = [];
  orders.forEach((o) => {
    const c = cmap.get(Number(o.customer_id));
    if (!c) return;
    orderIds.push(o.id);
    bump(c.id, 'orders_net', o.total_amount);
    const row = stat.get(Number(c.id));
    row.order_cnt += 1;
  });

  // 净收入：开票金额（作废不算）
  const inv = db.prepare(`SELECT customer_id, SUM(amount) s FROM ar_invoices
    WHERE status<>'void' AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=? GROUP BY customer_id`).all(from, to);
  inv.forEach((x) => { if (cmap.has(Number(x.customer_id))) bump(x.customer_id, 'revenue', x.s); });

  // 回款：已确认收款（退回的不算）
  const pay = db.prepare(`SELECT partner_id, SUM(amount) s FROM payments
    WHERE direction='in' AND partner_type='customer' AND status IN ('valid','confirmed')
      AND pay_date>=? AND pay_date<=? GROUP BY partner_id`).all(from, to);
  pay.forEach((x) => { if (cmap.has(Number(x.partner_id))) bump(x.partner_id, 'collection', x.s); });

  // 毛利：成本对象结转，成本缺失的客户标「毛利待核」不进榜
  const costs = db.prepare(`SELECT o.customer_id, co.sold_revenue, co.sold_cost
    FROM cost_objects co JOIN orders o ON o.id=co.order_id
    WHERE o.order_date>=? AND o.order_date<=?`).all(from, to);
  costs.forEach((x) => {
    if (!cmap.has(Number(x.customer_id))) return;
    const rev = Number(x.sold_revenue || 0);
    const cost = Number(x.sold_cost || 0);
    if (cost <= 0) {
      // 有收入没成本 = 毛利算不出来，这个客户不进毛利榜（不是「毛利 0」）
      bump(x.customer_id, 'gross', 0);
      stat.get(Number(x.customer_id)).cost_missing = true;
      return;
    }
    bump(x.customer_id, 'gross', rev - cost);
    stat.get(Number(x.customer_id)).has_cost = true;
  });

  // 实物退回：从客户退货单扣（已收货的）
  const rets = db.prepare(`SELECT partner_name, order_id, SUM(COALESCE(qty_received,qty_apply,0)) q
    FROM stock_returns WHERE type='customer' AND status IN ('received','done')
      AND return_date>=? AND return_date<=? GROUP BY partner_name, order_id`).all(from, to);
  const nameToId = new Map();
  cmap.forEach((c, id) => nameToId.set(c.name, id));
  rets.forEach((r) => {
    const cid = r.order_id
      ? (db.prepare('SELECT customer_id FROM orders WHERE id=?').get(r.order_id) || {}).customer_id
      : nameToId.get(r.partner_name);
    if (cid && cmap.has(Number(cid))) bump(cid, 'returned_qty', r.q);
  });

  const rows = Array.from(stat.values()).map((r) => {
    const c = cmap.get(r.customer_id);
    const internal = isInternal(c, set);
    return {
      ...r,
      customer_code: c.code,
      customer_name: c.name,
      owner_name: ownerOf(c),
      is_internal: internal,
      coverage: r.orders_net > 0 ? r2((r.revenue / r.orders_net) * 100) : null,
      gross_ready: r.has_cost && !r.cost_missing,
      note: internal ? '集团内部转单：不计销售业绩' : (r.has_cost && !r.cost_missing ? '' : '毛利待核：成本未结转')
    };
  }).filter((r) => (r.orders_net || r.revenue || r.collection || r.gross || r.order_cnt)
      && (!q.exclude_internal || !r.is_internal));

  const key = { amount: 'orders_net', revenue: 'revenue', collection: 'collection', gross: 'gross' }[metric] || 'revenue';
  const ready = rows.filter((r) => !(metric === 'gross' && !r.gross_ready));
  const pending = rows.filter((r) => metric === 'gross' && !r.gross_ready);
  ready.sort((a, b) => Number(b[key] || 0) - Number(a[key] || 0));
  ready.forEach((r, i) => { r.rank = i + 1; });
  pending.forEach((r) => { r.rank = null; });

  return {
    from, to, metric, metric_label: METRIC_LABEL[metric],
    rows: [...ready, ...pending],
    pending_cnt: pending.length,
    total: r2(ready.reduce((s, r) => s + Number(r[key] || 0), 0)),
    note: '订单额 / 确认收入 / 回款 / 毛利各有时间与币种口径；销售业绩 ≠ 财务收入；缺成本的客户不进毛利榜'
  };
}

/** ==================== 四、客户与未结业务交接 ==================== */

function listHandovers(q = {}) {
  const where = [];
  const args = [];
  if (q.status) { where.push('h.status=?'); args.push(q.status); }
  if (q.company_id) { where.push('h.company_id=?'); args.push(Number(q.company_id)); }
  const rows = db.prepare(`SELECT h.* FROM crm_handovers h
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY h.id DESC`).all(...args);
  return rows.map((h) => ({
    ...h,
    status_label: { draft: '草稿', pending: '待接收', received: '已接收', done: '已完成', cancelled: '已取消' }[h.status] || h.status,
    reason_label: HANDOVER_REASON_LABEL[h.reason] || h.reason,
    customers: String(h.customer_ids || '').split(',').filter(Boolean).map((id) => {
      const c = db.prepare('SELECT id, code, name FROM customers WHERE id=?').get(Number(id));
      return c || { id: Number(id), code: '—', name: `#${id}` };
    })
  }));
}

function getHandover(id) {
  const h = listHandovers({}).find((x) => Number(x.id) === Number(id));
  if (!h) throw new Error('交接单不存在');
  h.open_orders = db.prepare(`SELECT id, order_no, status, total_amount, currency FROM orders
    WHERE customer_id IN (${h.customers.map(() => '?').join(',') || '0'}) AND status NOT IN ('closed','cancelled')
    ORDER BY id DESC`).all(...h.customers.map((c) => c.id));
  h.open_leads = db.prepare(`SELECT id, lead_no, customer_name_raw, stage FROM crm_leads
    WHERE owner_user_id=? AND stage NOT IN ('won','lost')`).all(h.from_user_id);
  h.next = { draft: ['pending', 'cancelled'], pending: ['received', 'cancelled'], received: ['done', 'pending'], done: [], cancelled: [] }[h.status] || [];
  return h;
}

function createHandover(b, op) {
  const fromU = db.prepare('SELECT * FROM users WHERE id=?').get(Number(b.from_user_id));
  const toU = db.prepare('SELECT * FROM users WHERE id=?').get(Number(b.to_user_id));
  if (!fromU) throw new Error('原责任人不存在');
  if (!toU) throw new Error('接收人不存在');
  if (fromU.id === toU.id) throw new Error('原责任人和接收人不能是同一个人');
  // 接收者须有效授权（这里按在职 + 销售角色校验）
  if (!['sales', 'admin'].includes(toU.role)) throw new Error(`${toU.name} 不是销售角色，不能接客户`);
  if (!b.reason || !HANDOVER_REASON_LABEL[b.reason]) throw new Error('必须写明交接原因（离职 / 调岗 / 长期休假）');
  const ids = String(b.customer_ids || '').split(',').map((x) => Number(x)).filter(Boolean);
  if (!ids.length) throw new Error('至少选一个要交接的客户');
  const custod = db.prepare(`SELECT id, name FROM customers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (custod.length !== ids.length) throw new Error('有客户不存在，检查选择');
  // 快照未结数量：写进单里，之后订单变了也不影响当时交接的口径
  const openOrders = db.prepare(`SELECT COUNT(*) c FROM orders WHERE customer_id IN (${ids.map(() => '?').join(',')})
    AND status NOT IN ('closed','cancelled')`).get(...ids).c;
  const openTasks = db.prepare(`SELECT COUNT(*) c FROM crm_leads WHERE owner_user_id=? AND stage NOT IN ('won','lost')`).get(fromU.id).c;
  const no = nextNo('HO', 'crm_handovers', 'handover_no');
  const info = db.prepare(`INSERT INTO crm_handovers
    (handover_no,company_id,from_user_id,from_name,to_user_id,to_name,reason,customer_ids,customer_cnt,
     open_order_cnt,open_task_cnt,status,note,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    no, Number(b.company_id) || fromU.company_id || 1, fromU.id, fromU.name, toU.id, toU.name,
    b.reason, ids.join(','), ids.length, openOrders, openTasks, 'draft', b.note || null, now(), now()
  );
  return getHandover(info.lastInsertRowid);
}

function setHandoverStatus(id, b, op) {
  const h = db.prepare('SELECT * FROM crm_handovers WHERE id=?').get(Number(id));
  if (!h) throw new Error('交接单不存在');
  const to = String(b.to || '');
  const allow = { draft: ['pending', 'cancelled'], pending: ['received', 'cancelled'], received: ['done'], done: [], cancelled: [] }[h.status] || [];
  if (!allow.includes(to)) throw new Error(`不能从「${h.status}」到「${to}」`);
  const uid = userIdOf(op);
  if (to === 'received') {
    // 只能由接收人本人确认接收（admin 可代确认）
    if (uid && Number(uid) !== Number(h.to_user_id) && !(op && op.role === 'admin')) {
      throw new Error('只有接收人本人能确认接收');
    }
    db.prepare("UPDATE crm_handovers SET status='received', accepted_by=?, accepted_at=?, updated_at=? WHERE id=?")
      .run(me(op), now(), now(), h.id);
  } else if (to === 'done') {
    if (h.accepted_at === null) throw new Error('接收人还没确认接收，不能完成');
    // 交接：只改归属，不改历史业绩（提成单里的快照保持原样）
    const ids = String(h.customer_ids || '').split(',').map((x) => Number(x)).filter(Boolean);
    ids.forEach((cid) => {
      db.prepare('UPDATE customers SET owner_user_id=?, owner_name=? WHERE id=?').run(h.to_user_id, h.to_name, cid);
      db.prepare('UPDATE crm_customer_cycles SET owner_user_id=?, owner_name=?, updated_at=? WHERE customer_id=?')
        .run(h.to_user_id, h.to_name, now(), cid);
    });
    const movedLeads = db.prepare(`UPDATE crm_leads SET owner_user_id=?, owner_name=?, updated_at=?
      WHERE owner_user_id=? AND stage NOT IN ('won','lost')`).run(h.to_user_id, h.to_name, now(), h.from_user_id).changes;
    db.prepare("UPDATE crm_handovers SET status='done', approved_by=?, approved_at=?, updated_at=? WHERE id=?")
      .run(me(op), now(), now(), h.id);
    return { ...getHandover(h.id), moved_leads: movedLeads, note: '已转移客户归属与未结任务；历史提成单的归属快照不变' };
  } else if (to === 'cancelled') {
    if (!String(b.note || '').trim()) throw new Error('取消交接必须写原因');
    db.prepare("UPDATE crm_handovers SET status='cancelled', note=COALESCE(note,'')||?, updated_at=? WHERE id=?")
      .run(`\n[取消] ${b.note}`, now(), h.id);
  } else {
    db.prepare('UPDATE crm_handovers SET status=?, updated_at=? WHERE id=?').run(to, now(), h.id);
  }
  return getHandover(h.id);
}

function deleteHandover(id, op) {
  const h = db.prepare('SELECT * FROM crm_handovers WHERE id=?').get(Number(id));
  if (!h) throw new Error('交接单不存在');
  if (!['draft', 'cancelled'].includes(h.status)) throw new Error('只有草稿或已取消的交接单可以删除');
  db.prepare('DELETE FROM crm_handovers WHERE id=?').run(h.id);
  return { deleted: 1, handover_no: h.handover_no, by: me(op) };
}

/** ==================== 五、销售目标 ==================== */

function listTargets(q = {}) {
  const where = [];
  const args = [];
  if (q.period) { where.push('period=?'); args.push(q.period); }
  if (q.company_id) { where.push('company_id=?'); args.push(Number(q.company_id)); }
  if (q.status) { where.push('status=?'); args.push(q.status); }
  const rows = db.prepare(`SELECT * FROM sales_targets ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY period DESC, id DESC`).all(...args);
  return rows.map((t) => ({
    ...t,
    status_label: { draft: '草稿', approved: '已批准', effective: '生效中', closed: '已关闭' }[t.status] || t.status,
    item_cnt: db.prepare('SELECT COUNT(*) c FROM sales_target_items WHERE target_id=?').get(t.id).c,
    total_target: r2(db.prepare("SELECT COALESCE(SUM(target_amount),0) s FROM sales_target_items WHERE target_id=? AND metric='amount'").get(t.id).s)
  }));
}

/** 按客户归属人汇总某个指标的本期实际（归属快照在客户档案上） */
function metricByOwner(metric, period, companyId) {
  const cmap = customerMap();
  const set = internalSet();
  const ownerName = (cid) => {
    const c = cmap.get(Number(cid));
    if (!c) return '未归属';
    // 内部转单不进销售目标口径（原型：内部备货不计外部复购）
    if (isInternal(c, set)) return null;
    return c.owner_name || (c.owner_user_id ? `#${c.owner_user_id}` : '未归属');
  };
  const out = new Map();
  const add = (name, v) => { if (name) out.set(name, r2((out.get(name) || 0) + Number(v || 0))); };
  if (metric === 'amount') {
    const rows = db.prepare(`SELECT customer_id, SUM(total_amount) s FROM orders
      WHERE substr(order_date,1,7)=? AND status NOT IN ('draft','cancelled') ${companyId ? 'AND company_id=' + Number(companyId) : ''}
      GROUP BY customer_id`).all(period);
    rows.forEach((r) => add(ownerName(r.customer_id), r.s));
  } else if (metric === 'revenue') {
    const rows = db.prepare(`SELECT customer_id, SUM(amount) s FROM ar_invoices
      WHERE substr(created_at,1,7)=? AND status<>'void' ${companyId ? 'AND company_id=' + Number(companyId) : ''}
      GROUP BY customer_id`).all(period);
    rows.forEach((r) => add(ownerName(r.customer_id), r.s));
  } else if (metric === 'collection') {
    const rows = db.prepare(`SELECT partner_id, SUM(amount) s FROM payments
      WHERE direction='in' AND partner_type='customer' AND status IN ('valid','confirmed')
        AND substr(pay_date,1,7)=? ${companyId ? 'AND company_id=' + Number(companyId) : ''}
      GROUP BY partner_id`).all(period);
    rows.forEach((r) => add(ownerName(r.partner_id), r.s));
  } else {
    const rows = db.prepare(`SELECT o.customer_id, co.sold_revenue, co.sold_cost FROM cost_objects co
      JOIN orders o ON o.id=co.order_id WHERE substr(o.order_date,1,7)=?
      ${companyId ? 'AND o.company_id=' + Number(companyId) : ''}`).all(period);
    rows.forEach((r) => {
      const cost = Number(r.sold_cost || 0);
      const rev = Number(r.sold_revenue || 0);
      if (cost > 0) add(ownerName(r.customer_id), rev - cost);
    });
  }
  return out;
}

function getTarget(id) {
  const t = db.prepare('SELECT * FROM sales_targets WHERE id=?').get(Number(id));
  if (!t) throw new Error('目标版不存在');
  const items = db.prepare('SELECT * FROM sales_target_items WHERE target_id=? ORDER BY metric, id').all(t.id);
  const cache = {};
  const rows = items.map((it) => {
    if (!cache[it.metric]) cache[it.metric] = metricByOwner(it.metric, t.period, t.company_id);
    const actual = cache[it.metric].get(it.user_name) || 0;
    const hit = it.target_amount > 0 ? r2((actual / it.target_amount) * 100) : null;
    return {
      ...it,
      metric_label: METRIC_LABEL[it.metric] || it.metric,
      actual: r2(actual),
      gap: r2(actual - it.target_amount),
      hit_rate: hit,
      // 目标完成率必须能看到分子分母
      formula: `${METRIC_LABEL[it.metric]} ${r2(actual).toLocaleString('zh-CN')} ÷ 目标 ${r2(it.target_amount).toLocaleString('zh-CN')}`
    };
  });
  return { ...t, items: rows, currency: t.currency || 'CNY' };
}

function createTarget(b, op) {
  const period = String(b.period || '').trim();
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('期间要写成 YYYY-MM');
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new Error('至少填一个人的目标');
  const seen = new Set();
  items.forEach((it) => {
    if (!it.user_name) throw new Error('目标要指定业务员');
    if (!METRIC_LABEL[it.metric]) throw new Error(`指标口径不合法：${it.metric}`);
    const key = `${it.user_name}|${it.metric}`;
    if (seen.has(key)) throw new Error(`${it.user_name} 的${METRIC_LABEL[it.metric]}填了两行`);
    seen.add(key);
    if (Number(it.target_amount || 0) < 0) throw new Error('目标不能为负');
  });
  const ver = db.prepare("SELECT COALESCE(MAX(version),0) v FROM sales_targets WHERE period=? AND COALESCE(team,'')=COALESCE(?,'')")
    .get(period, b.team || '').v + 1;
  const no = nextNo('TGT', 'sales_targets', 'target_no');
  const info = db.prepare(`INSERT INTO sales_targets (target_no,company_id,team,period,version,status,currency,note,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,'draft',?,?,?,?,?)`).run(
    no, Number(b.company_id) || 1, b.team || null, period, ver, b.currency || 'CNY', b.note || null, me(op), now(), now()
  );
  const tid = info.lastInsertRowid;
  items.forEach((it) => {
    db.prepare('INSERT INTO sales_target_items (target_id,user_id,user_name,metric,target_amount,note) VALUES (?,?,?,?,?,?)')
      .run(tid, it.user_id || null, it.user_name, it.metric, Number(it.target_amount || 0), it.note || null);
  });
  return getTarget(tid);
}

function approveTarget(id, op) {
  const t = db.prepare('SELECT * FROM sales_targets WHERE id=?').get(Number(id));
  if (!t) throw new Error('目标版不存在');
  if (t.status !== 'draft') throw new Error('只有草稿状态的目标版可以批准');
  if (t.created_by === me(op)) throw new Error('目标由自己编制、自己批准不行，请找上级批');
  // 同一期间同一团队同时只能有一个生效版本
  db.prepare("UPDATE sales_targets SET status='closed', updated_at=? WHERE period=? AND COALESCE(team,'')=COALESCE(?,'') AND status IN ('approved','effective') AND id<>?")
    .run(now(), t.period, t.team || '', t.id);
  db.prepare("UPDATE sales_targets SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?")
    .run(me(op), now(), now(), t.id);
  return getTarget(t.id);
}

/** ==================== 六、提成规则与提成单 ==================== */

function listRules(q = {}) {
  const where = [];
  const args = [];
  if (q.company_id) { where.push('company_id=?'); args.push(Number(q.company_id)); }
  if (q.status) { where.push('status=?'); args.push(q.status); }
  const rows = db.prepare(`SELECT * FROM commission_rules ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`).all(...args);
  return rows.map((r) => {
    let tiers = [];
    try { tiers = JSON.parse(r.tiers_json || '[]'); } catch (e) { tiers = []; }
    return {
      ...r,
      tiers,
      base_type_label: BASE_TYPE_LABEL[r.base_type] || r.base_type,
      status_label: { draft: '草稿', approved: '已批准', superseded: '已被替代' }[r.status] || r.status
    };
  });
}

function createRule(b, op) {
  if (!b.name) throw new Error('规则名必填');
  const baseType = b.base_type || 'collection';
  if (!BASE_TYPE_LABEL[baseType]) throw new Error('提成基数口径不合法');
  let tiers = Array.isArray(b.tiers) ? b.tiers : [];
  if (!tiers.length) throw new Error('至少配一档阶梯（不预设百分比，由公司批准）');
  tiers = tiers.map((t) => ({
    from: Number(t.from || 0),
    to: t.to === '' || t.to === null || t.to === undefined ? null : Number(t.to),
    rate: Number(t.rate)
  })).sort((a, b2) => a.from - b2.from);
  let lastTo = -1;
  tiers.forEach((t, i) => {
    if (!Number.isFinite(t.rate) || t.rate < 0 || t.rate > 100) throw new Error(`第 ${i + 1} 档费率要在 0~100% 之间`);
    if (t.from < 0) throw new Error(`第 ${i + 1} 档起点不能为负`);
    if (t.to !== null && t.to <= t.from) throw new Error(`第 ${i + 1} 档终点要大于起点`);
    if (t.from < lastTo) throw new Error(`第 ${i + 1} 档与上一档区间重叠`);
    lastTo = t.to === null ? Infinity : t.to;
  });
  if (!b.effective_from) throw new Error('必须写生效起始日');
  const no = nextNo('CR', 'commission_rules', 'rule_no');
  const info = db.prepare(`INSERT INTO commission_rules
    (rule_no,company_id,name,base_type,tiers_json,deduct_refund,effective_from,status,note,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,'draft',?,?,?)`).run(
    no, Number(b.company_id) || 1, b.name, baseType, JSON.stringify(tiers),
    b.deduct_refund === false || b.deduct_refund === 0 ? 0 : 1, b.effective_from,
    b.note || null, me(op), now()
  );
  return listRules({}).find((r) => Number(r.id) === Number(info.lastInsertRowid));
}

function approveRule(id, op) {
  const r = db.prepare('SELECT * FROM commission_rules WHERE id=?').get(Number(id));
  if (!r) throw new Error('规则不存在');
  if (r.status !== 'draft') throw new Error('只有草稿规则可以批准');
  if (r.created_by === me(op)) throw new Error('规则由自己编制、自己批准不行');
  // 同一主体同一基数口径，只有一条生效
  db.prepare("UPDATE commission_rules SET status='superseded' WHERE company_id=? AND base_type=? AND status='approved' AND id<>?")
    .run(r.company_id, r.base_type, r.id);
  db.prepare("UPDATE commission_rules SET status='approved', approved_by=?, approved_at=? WHERE id=?")
    .run(me(op), now(), r.id);
  return listRules({}).find((x) => Number(x.id) === Number(r.id));
}

/** 按阶梯算提成（超额累进，不是全额跳档） */
function tierAmount(base, tiers) {
  const detail = [];
  let amount = 0;
  tiers.forEach((t) => {
    const from = Number(t.from || 0);
    const to = t.to === null || t.to === undefined ? Infinity : Number(t.to);
    if (base <= from) return;
    const part = Math.min(base, to) - from;
    if (part <= 0) return;
    const amt = part * (Number(t.rate) / 100);
    amount += amt;
    detail.push({ from, to: to === Infinity ? null : to, part: r2(part), rate: Number(t.rate), amount: r2(amt) });
  });
  return { amount: r2(amount), detail };
}

/**
 * 提成取数：按客户归属人归属到业务员。
 * 收款 / 开票 / 毛利三个口径各取各的表，不做「订单额当回款」这种替代。
 */
function collectSources(userName, period, baseType, companyId) {
  const cmap = customerMap();
  const set = internalSet();
  const ownerName = (cid) => {
    const c = cmap.get(Number(cid));
    if (!c) return null;
    // 集团内部转单不计业务业绩（原型：内部备货不计外部复购，也不算销售提成）
    if (isInternal(c, set)) return null;
    return c.owner_name || (c.owner_user_id ? `#${c.owner_user_id}` : null);
  };
  const co = companyId ? ` AND company_id=${Number(companyId)}` : '';
  if (baseType === 'collection') {
    return db.prepare(`SELECT id, pay_no no, pay_date d, amount, partner_id FROM payments
      WHERE direction='in' AND partner_type='customer' AND status IN ('valid','confirmed')
        AND substr(pay_date,1,7)=?${co} ORDER BY pay_date`).all(period)
      .filter((r) => ownerName(r.partner_id) === userName)
      .map((r) => ({ source_type: 'payment', source_id: r.id, source_no: r.no, source_date: r.d, amount: Number(r.amount || 0) }));
  }
  if (baseType === 'revenue') {
    return db.prepare(`SELECT id, bill_no no, substr(created_at,1,10) d, amount, customer_id FROM ar_invoices
      WHERE status<>'void' AND substr(created_at,1,7)=?${co} ORDER BY created_at`).all(period)
      .filter((r) => ownerName(r.customer_id) === userName)
      .map((r) => ({ source_type: 'ar_invoice', source_id: r.id, source_no: r.no, source_date: r.d, amount: Number(r.amount || 0) }));
  }
  // gross：成本对象结转的毛利，成本缺失的跳过（不能用 0 成本充数）
  return db.prepare(`SELECT co.id, co.cost_no no, co.order_id, co.sold_revenue, co.sold_cost, o.customer_id, o.order_date
    FROM cost_objects co JOIN orders o ON o.id=co.order_id
    WHERE substr(o.order_date,1,7)=?${co ? co.replace('company_id', 'o.company_id') : ''}
      AND COALESCE(co.sold_cost,0)>0`).all(period)
    .filter((r) => ownerName(r.customer_id) === userName)
    .map((r) => ({
      source_type: 'cost_object', source_id: r.id, source_no: r.no, source_date: r.order_date,
      amount: r2(Number(r.sold_revenue || 0) - Number(r.sold_cost || 0))
    }));
}

/** 试算：不落库，先把基数、阶梯、金额、来源行都摆出来 */
function previewCommission(b) {
  const period = String(b.period || '').trim();
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('期间要写成 YYYY-MM');
  if (!b.user_name) throw new Error('要指定业务员');
  const rule = b.rule_id
    ? listRules({}).find((r) => Number(r.id) === Number(b.rule_id))
    : listRules({ status: 'approved' }).find((r) => (!b.base_type || r.base_type === b.base_type));
  if (!rule) throw new Error('没有已批准的提成规则，先让公司批一条（系统不预设百分比）');
  const baseType = b.base_type || rule.base_type;
  const src = collectSources(b.user_name, period, baseType, b.company_id);
  const filterOut = db.prepare("SELECT COUNT(*) c FROM commission_sources s JOIN commissions c ON c.id=s.commission_id WHERE s.kind='base' AND s.source_type=? AND s.source_id=?");
  const fresh = [];
  const used = [];
  src.forEach((s) => {
    const dup = filterOut.get(s.source_type, s.source_id).c;
    (dup ? used : fresh).push(s);
  });
  const base = r2(fresh.reduce((x, s) => x + s.amount, 0));
  const calc = tierAmount(base, rule.tiers || []);
  const user = db.prepare('SELECT * FROM users WHERE name=?').get(b.user_name);
  return {
    period, user_name: b.user_name, user_id: user ? user.id : null,
    rule_id: rule.id, rule_no: rule.rule_no, rule_name: rule.name,
    base_type: baseType, base_type_label: COMM_BASE_LABEL[baseType],
    base_amount: base, amount: calc.amount, tiers: rule.tiers, detail: calc.detail,
    sources: fresh, already_taken: used,
    already_taken_note: used.length ? `${used.length} 条来源行已被别的提成单计过，本次不再重复计提` : null,
    note: '试算不落库；确认基数与阶梯无误后再生成提成单'
  };
}

function listCommissions(q = {}) {
  const where = [];
  const args = [];
  if (q.period) { where.push('period=?'); args.push(q.period); }
  if (q.status) { where.push('status=?'); args.push(q.status); }
  if (q.user_id) { where.push('user_id=?'); args.push(Number(q.user_id)); }
  if (q.company_id) { where.push('company_id=?'); args.push(Number(q.company_id)); }
  const rows = db.prepare(`SELECT * FROM commissions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY period DESC, id DESC`).all(...args);
  return rows.map((c) => ({
    ...c,
    status_label: COMM_STATUS_LABEL[c.status] || c.status,
    base_type_label: COMM_BASE_LABEL[c.base_type] || c.base_type,
    net_amount: r2(Number(c.amount || 0) + Number(c.refund_adj || 0) + Number(c.bad_debt_adj || 0)),
    source_cnt: db.prepare('SELECT COUNT(*) c FROM commission_sources WHERE commission_id=?').get(c.id).c
  }));
}

function getCommission(id) {
  const c = listCommissions({}).find((x) => Number(x.id) === Number(id));
  if (!c) throw new Error('提成单不存在');
  c.sources = db.prepare('SELECT * FROM commission_sources WHERE commission_id=? ORDER BY kind, id').all(c.id);
  c.next = { draft: ['reviewing'], reviewing: ['approved', 'rejected'], rejected: ['draft'], approved: ['settled'], settled: [] }[c.status] || [];
  return c;
}

function createCommission(b, op) {
  const period = String(b.period || '').trim();
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('期间要写成 YYYY-MM');
  const co = Number(b.company_id) || 1;
  const u0 = db.prepare('SELECT id FROM users WHERE name=?').get(String(b.user_name || ''));

  // 防重 ①：同一业务员同一期间只能有一张已批准 / 已结算
  // （先查这个，否则来源行被上一张单占完后，报错会变成「没有可计提的来源」，看不出真正原因）
  if (u0) {
    const dup = db.prepare("SELECT * FROM commissions WHERE user_id=? AND period=? AND company_id=? AND status IN ('approved','settled')")
      .get(u0.id, period, co);
    if (dup) throw new Error(`${b.user_name} ${period} 已经有提成单（${dup.commission_no}），不能重复计提`);
  }

  const p = previewCommission(b);
  if (!p.sources.length) {
    if (p.already_taken.length) {
      throw new Error(`这个期间的 ${p.already_taken.length} 条来源单据都已经被别的提成单计过了，不能重复计提`);
    }
    throw new Error('这个期间没有可计提的来源单据（没回款 / 没开票 / 没毛利都提不了）');
  }

  const user = p.user_id ? db.prepare('SELECT u.*, d.name dept_name FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=?').get(p.user_id) : null;
  const emp = user ? db.prepare('SELECT * FROM employees WHERE name=?').get(user.name) : null;
  const no = nextNo('CM', 'commissions', 'commission_no');
  const info = db.prepare(`INSERT INTO commissions
    (commission_no,company_id,period,user_id,user_name,dept_snapshot,manager_snapshot,rule_id,rule_no,rule_snapshot,
     base_type,base_amount,amount,currency,status,note,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`).run(
    no, Number(b.company_id) || 1, period, p.user_id, p.user_name,
    (user && user.dept_name) || (emp && emp.position) || null, null,
    p.rule_id, p.rule_no, JSON.stringify(p.tiers),
    p.base_type, p.base_amount, p.amount, b.currency || 'CNY', b.note || null, me(op), now(), now()
  );
  const cid = info.lastInsertRowid;
  const insSrc = db.prepare(`INSERT INTO commission_sources
    (commission_id,kind,source_type,source_id,source_no,source_date,base_amount,rate,amount,note)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  p.sources.forEach((s) => {
    insSrc.run(cid, 'base', s.source_type, s.source_id, s.source_no, s.source_date, s.amount, null, s.amount, null);
  });
  return getCommission(cid);
}

/** 退款 / 坏账调整：必须指向来源单据，且不自动扣薪 */
function addAdjustment(id, b, op) {
  const c = db.prepare('SELECT * FROM commissions WHERE id=?').get(Number(id));
  if (!c) throw new Error('提成单不存在');
  if (!['draft', 'rejected'].includes(c.status)) throw new Error('只有草稿或已驳回的提成单可以加调整');
  const kind = b.source_type;
  if (!['refund', 'bad_debt'].includes(kind)) throw new Error('调整类型只能是退款或坏账');
  if (!b.source_no) throw new Error('调整必须写来源单据号（不能凭空扣钱）');
  // 调整的是**提成金额**，不是提成基数：退款 6,000 元不该直接扣 6,000 元提成
  const amt = Number(b.amount || 0);
  if (!amt) throw new Error('调整金额不能为 0');
  // 统一按负数记（扣减），正数会被强制转成负数并提示
  const signed = amt > 0 ? -amt : amt;
  // 调整必须能对上一条已计提的来源行
  const base = db.prepare("SELECT * FROM commission_sources WHERE commission_id=? AND kind='base' AND source_no=? ORDER BY id LIMIT 1")
    .get(c.id, b.source_no);
  if (!base) throw new Error(`提成单里没有来源单号 ${b.source_no} 的记录，无法建立调整（调整必须指向已计提的来源）`);
  const info = db.prepare(`INSERT INTO commission_sources
    (commission_id,kind,source_type,source_id,source_no,source_date,base_amount,rate,amount,adjust_of,note)
    VALUES (?,?,?,?,?,?,0,NULL,?,?,?)`).run(
    c.id, 'adjust', kind, base.source_id, b.source_no, base.source_date, signed, base.id, b.note || null
  );
  const col = kind === 'refund' ? 'refund_adj' : 'bad_debt_adj';
  db.prepare(`UPDATE commissions SET ${col}=COALESCE(${col},0)+?, updated_at=? WHERE id=?`)
    .run(signed, now(), c.id);
  return {
    ...getCommission(c.id),
    adjustment_id: info.lastInsertRowid,
    note: '调整只影响本次提成金额，不会自动去扣工资（工资侧只引用一笔提成来源）'
  };
}

function setCommissionStatus(id, b, op) {
  const c = db.prepare('SELECT * FROM commissions WHERE id=?').get(Number(id));
  if (!c) throw new Error('提成单不存在');
  const to = String(b.to || '');
  const allow = { draft: ['reviewing'], reviewing: ['approved', 'rejected'], rejected: ['draft'], approved: ['settled'], settled: [] }[c.status] || [];
  if (!allow.includes(to)) throw new Error(`不能从「${COMM_STATUS_LABEL[c.status]}」到「${COMM_STATUS_LABEL[to] || to}」`);
  if (to === 'reviewing') {
    const src = db.prepare("SELECT COUNT(*) c FROM commission_sources WHERE commission_id=? AND kind='base'").get(c.id).c;
    if (!src) throw new Error('没有来源行的提成单不能提交复核');
    db.prepare("UPDATE commissions SET status='reviewing', updated_at=? WHERE id=?").run(now(), c.id);
  } else if (to === 'rejected') {
    if (!String(b.reason || '').trim()) throw new Error('驳回必须写原因');
    db.prepare("UPDATE commissions SET status='rejected', note=COALESCE(note,'')||?, updated_at=? WHERE id=?")
      .run(`\n[驳回] ${b.reason}`, now(), c.id);
  } else if (to === 'approved') {
    if (c.created_by === me(op)) throw new Error('提成单由自己复核通过不行，请换人批');
    db.prepare("UPDATE commissions SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?")
      .run(me(op), now(), now(), c.id);
  }
  return getCommission(c.id);
}

/** 删提成单：只允许草稿或已驳回（已批准的是薪酬依据，不能删） */
function deleteCommission(id, op) {
  const c = db.prepare('SELECT * FROM commissions WHERE id=?').get(Number(id));
  if (!c) throw new Error('提成单不存在');
  if (!['draft', 'rejected'].includes(c.status)) throw new Error('只有草稿或已驳回的提成单可以删除；已批准的是薪酬依据，不能删');
  db.prepare('DELETE FROM commission_sources WHERE commission_id=?').run(c.id);
  db.prepare('DELETE FROM commissions WHERE id=?').run(c.id);
  return { deleted: 1, commission_no: c.commission_no, by: me(op) };
}

/** 引用薪酬：只生成一笔来源，且该期间工资已发放就不许再计提（防二次计提） */
function linkPayroll(id, b, op) {
  const c = db.prepare('SELECT * FROM commissions WHERE id=?').get(Number(id));
  if (!c) throw new Error('提成单不存在');
  // 先看有没有引过：已引过的状态是 settled，如果先判状态会报成「要先批准」，看不出真实原因
  if (c.payroll_ref) throw new Error(`已经引过薪酬（${c.payroll_ref}），不能重复生成薪酬来源`);
  if (c.status !== 'approved') throw new Error('提成单要先批准才能引薪酬');
  const period = String(b.payroll_period || c.period);
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('薪酬期间要写成 YYYY-MM');
  const emp = db.prepare('SELECT id FROM employees WHERE name=?').get(c.user_name);
  const pay = emp ? db.prepare('SELECT * FROM payrolls WHERE employee_id=? AND period=?').get(emp.id, period) : null;
  if (pay && pay.status === 'paid') throw new Error(`${period} 的工资已发放，提成不能再计提（会二次计提）`);
  const ref = `PR${period.replace('-', '')}-${c.commission_no}`;
  db.prepare("UPDATE commissions SET status='settled', payroll_period=?, payroll_ref=?, payroll_linked_at=?, updated_at=? WHERE id=?")
    .run(period, ref, now(), now(), c.id);
  return { ...getCommission(c.id), payroll_ref: ref, note: '已生成一笔薪酬来源；工资发放时把提成作为整体引用，不再二次计提' };
}

/** ==================== 汇总 / 报表 ==================== */

function overview() {
  const t = today();
  const leads = db.prepare('SELECT stage, COUNT(*) c FROM crm_leads GROUP BY stage').all();
  const stageCnt = Object.fromEntries(LEAD_STAGE.map((s) => [s, 0]));
  leads.forEach((l) => { stageCnt[l.stage] = l.c; });
  const lateResp = db.prepare(`SELECT COUNT(*) c FROM crm_leads
    WHERE first_response_at IS NULL AND response_due IS NOT NULL AND response_due < ? AND stage IN ('new','qualifying')`).get(t).c;
  const pool = db.prepare('SELECT COUNT(*) c FROM crm_leads WHERE in_pool=1').get().c;
  const alerts = cycleAlerts({});
  const handovers = db.prepare("SELECT COUNT(*) c FROM crm_handovers WHERE status IN ('pending','received')").get().c;
  const commPending = db.prepare("SELECT COUNT(*) c FROM commissions WHERE status='reviewing'").get().c;
  const commApproved = db.prepare("SELECT COALESCE(SUM(amount+COALESCE(refund_adj,0)+COALESCE(bad_debt_adj,0)),0) s FROM commissions WHERE status IN ('approved','settled') AND period=?")
    .get(periodOf(t)).s;
  const unknownCycle = db.prepare(`SELECT COUNT(*) c FROM customers cu
    LEFT JOIN crm_customer_cycles cy ON cy.customer_id=cu.id
    WHERE cu.status<>'disabled' AND (cy.id IS NULL OR cy.status='unknown')`).get().c;
  return {
    leads: {
      by_stage: stageCnt, total: Object.values(stageCnt).reduce((a, b) => a + b, 0),
      late_response: lateResp, pool,
      note: '商机金额只作参考，不计入收入 / 目标 / 提成'
    },
    cycles: {
      unknown: unknownCycle, known: db.prepare("SELECT COUNT(*) c FROM crm_customer_cycles WHERE status='known'").get().c,
      overdue: alerts.counts.overdue, escalated: alerts.counts.escalated, soon: alerts.counts.soon,
      note: '周期未知不是空白，要有原因、责任人和复核日'
    },
    handovers: { open: handovers },
    commissions: { pending: commPending, approved_amount_this_period: r2(commApproved) },
    today: t
  };
}

function reportCycle(q = {}) {
  const rows = listCycles(q);
  const byStatus = {};
  rows.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  return {
    rows: rows.filter((r) => r.is_overdue || r.due_in_days !== null || r.status === 'unknown').slice(0, 60),
    by_status: Object.entries(byStatus).map(([k, v]) => ({ status: k, label: CYCLE_STATUS_LABEL[k] || k, cnt: v })),
    overdue: rows.filter((r) => r.is_overdue).length,
    unknown: rows.filter((r) => r.status === 'unknown').length,
    note: '自然月观察（3/6/12 月下单次数）与周期超期分开看；回访不算复购'
  };
}

function reportCommission(q = {}) {
  const rows = listCommissions(q);
  const byPeriod = new Map();
  rows.forEach((c) => {
    const p = byPeriod.get(c.period) || { period: c.period, cnt: 0, base: 0, amount: 0, net: 0 };
    p.cnt += 1;
    p.base = r2(p.base + Number(c.base_amount || 0));
    p.amount = r2(p.amount + Number(c.amount || 0));
    p.net = r2(p.net + Number(c.net_amount || 0));
    byPeriod.set(c.period, p);
  });
  return {
    rows,
    by_period: Array.from(byPeriod.values()).sort((a, b) => b.period.localeCompare(a.period)),
    total: r2(rows.reduce((s, c) => s + Number(c.net_amount || 0), 0)),
    note: '提成金额按已批准口径；退款与坏账调整单列，不自动扣薪；提成 ≠ 财务收入'
  };
}

module.exports = {
  dict,
  // 线索
  listLeads, getLead, createLead, updateLead, assignLead, claimLead, recycleLead, sweepPool,
  followLead, setLeadStage, mergeLead, importLeads, deleteLead,
  // 周期
  listCycles, upsertCycle, refreshCycles, inferCycles, acceptInference,
  listFollowups, addFollowup, cycleAlerts, reportCycle,
  // 排行
  ranking,
  // 交接
  listHandovers, getHandover, createHandover, setHandoverStatus, deleteHandover,
  // 目标与提成
  listTargets, getTarget, createTarget, approveTarget, metricByOwner,
  listRules, createRule, approveRule, tierAmount,
  previewCommission, listCommissions, getCommission, createCommission, addAdjustment,
  setCommissionStatus, deleteCommission, linkPayroll, reportCommission,
  // 汇总
  overview
};
