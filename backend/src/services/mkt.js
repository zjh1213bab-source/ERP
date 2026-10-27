/**
 * 营销与素材（原型 M16）
 * ============================================================
 * 四个业务对象：上新任务 / 品牌素材 / 活动投放 / 运营复盘。
 *
 * 设计上要坚持的三件事（都是原型规则里写死的）：
 *
 * 1. **上新状态 ≠ 生产状态**
 *    营销把款推到店铺，不代表技术确认了、也不代表排产了。
 *    所以这里对 tech_packs / orders 只读不写；上新门槛只是「检查依赖过没过」，
 *    绝不因为点了「上新」就把开发单标成 confirmed —— 否则生产端会按未确认版型投产。
 *
 * 2. **素材必须带授权范围**
 *   客户专属花型给别的客户用是真实的法律风险，不是提示一下就算。
 *     - scope=exclusive → 必须绑客户；绑任务时任务客户必须一致
 *     - scope=channel   → 任务渠道必须在授权渠道里
 *     - 过了 license_to  → 一律不可用（到期不等于没人管）
 *    AI 生成的素材只能停在草稿，必须人工审核过才能上架。
 *
 * 3. **活动不混币种**
 *    一个活动一种币种，账单币种不一致直接拒；汇总按币种分组，不做「人民币+美金」的假合计。
 *    归因收入还要剔两类虚假增长：未确认的订单、集团内部转单。
 *    而且归因收入 ≠ 净利润，页面只给 ROAS 和本币毛利，不给「活动赚了多少净利」。
 *
 * 时间口径：本地墙钟字符串（services/sla.js 的 localNow/localDate）。
 */
const { db } = require('../db');
const { localNow, localDate } = require('./sla');

/** ==================== 字典 ==================== */

const TASK_FLOW = ['draft', 'material', 'ready', 'launched', 'reviewed'];
const TASK_LABEL = {
  draft: '待资料',
  material: '素材筹备',
  ready: '资料确认',
  launched: '已上新',
  reviewed: '已复盘',
  cancelled: '已取消'
};
const TASK_NEXT = {
  draft: ['material', 'cancelled'],
  material: ['ready', 'draft', 'cancelled'],
  ready: ['launched', 'material', 'cancelled'],
  launched: ['reviewed', 'ready'],
  reviewed: ['launched'],
  cancelled: ['draft']
};
/** 往前退的状态（要写原因） */
const TASK_BACK = new Set(['material>draft', 'ready>material', 'launched>ready', 'reviewed>launched', 'cancelled>draft']);

const DEFAULT_STEPS = ['选品确认', '素材制作', '素材审核', '资料对接', '上新发布', '复盘检查'];

const ASSET_KIND_LABEL = {
  image: '图片', video: '视频', pattern: '图案文件', doc: '文档'
};
const ASSET_SCOPE_LABEL = {
  public: '公开可用', channel: '指定渠道', exclusive: '客户专属'
};
const LICENSE_LABEL = {
  own: '自有', customer: '客户提供', supplier: '供应商', ai: 'AI 生成'
};
const ASSET_STATUS_LABEL = {
  draft: '草稿', pending: '待审', approved: '可用', revoked: '作废', expired: '已过期'
};

const CAMP_FLOW = ['draft', 'approved', 'running', 'billed', 'closed', 'cancelled'];
const CAMP_LABEL = {
  draft: '草稿',
  approved: '已批准',
  running: '执行中',
  billed: '已账单',
  closed: '已复核',
  cancelled: '已取消'
};

const REVIEW_LABEL = {
  draft: '草稿', open: '待行动', doing: '执行中', done: '已关闭'
};
const REVIEW_CATEGORY = {
  shortage: '缺货断码',
  tech_delay: '技术延期',
  complaint: '客户投诉',
  asset: '素材问题',
  conversion: '转化下滑',
  other: '其他'
};
const BILL_SOURCE_LABEL = {
  ads: '广告平台', agency: '代理商', invoice: '发票', other: '其他'
};

const CURRENCIES = ['CNY', 'USD'];

/** 已确认销售的状态（未到 assigned 的不算卖出去） */
const CONFIRMED_ORDER_STATUS = ['assigned', 'production', 'instock', 'shipped', 'closed'];

/** ==================== 小工具 ==================== */

function addDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(n || 0));
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const x = new Date(String(a).slice(0, 10) + 'T00:00:00');
  const y = new Date(String(b).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(x.getTime()) || Number.isNaN(y.getTime())) return null;
  return Math.round((y - x) / 86400000);
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isPeriod = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 单号：前缀 + 日期 + 4 位序号（取当日最大值 +1，删单后不会撞号） */
function nextNo(prefix, table, col) {
  const d = localDate().replace(/-/g, '');
  const head = `${prefix}${d}`;
  const row = db.prepare(
    `SELECT ${col} AS v FROM ${table} WHERE ${col} LIKE ? ORDER BY ${col} DESC LIMIT 1`
  ).get(head + '%');
  const seq = row && row.v ? Number(String(row.v).slice(head.length)) + 1 : 1;
  return head + String(seq).padStart(4, '0');
}

function defaultCompany() {
  const c = db.prepare("SELECT id FROM companies WHERE status='active' ORDER BY id LIMIT 1").get();
  return c ? c.id : 1;
}

/** ==================== 素材可用性 ==================== */

/**
 * 素材的「有效状态」：approved 但过了授权期，按已过期算。
 * 不在读取时改库（列表页刷一下就改状态会让审计记录失真），要固化请调 sweepExpired。
 */
function assetStatus(a, today = localDate()) {
  if (a.status === 'approved' && a.license_to && String(a.license_to).slice(0, 10) < today) return 'expired';
  return a.status;
}

function shapeAsset(a, today = localDate()) {
  if (!a) return null;
  const st = assetStatus(a, today);
  const customer = a.customer_id
    ? db.prepare('SELECT id, name FROM customers WHERE id=?').get(a.customer_id)
    : null;
  const uses = db.prepare(
    `SELECT COUNT(*) c FROM mkt_task_assets ta JOIN mkt_tasks t ON t.id=ta.task_id
     WHERE ta.asset_id=? AND t.status NOT IN ('cancelled')`
  ).get(a.id).c;
  return {
    ...a,
    kind_label: ASSET_KIND_LABEL[a.kind] || a.kind,
    scope_label: ASSET_SCOPE_LABEL[a.scope] || a.scope,
    license_label: LICENSE_LABEL[a.license_source] || a.license_source,
    status: st,
    status_label: ASSET_STATUS_LABEL[st] || st,
    customer_name: customer ? customer.name : null,
    channel_list: (a.channels || '').split(',').map((s) => s.trim()).filter(Boolean),
    days_left: a.license_to ? daysBetween(today, a.license_to) : null,
    used_by: uses
  };
}

/** 素材能不能给这条任务用；不能用就返回原因 */
function assetBlockReason(asset, task, today = localDate()) {
  const st = assetStatus(asset, today);
  if (st === 'expired') return `素材 ${asset.asset_no} 授权已于 ${asset.license_to} 到期`;
  if (st !== 'approved') return `素材 ${asset.asset_no} 当前是「${ASSET_STATUS_LABEL[st] || st}」，未审核通过不能用`;
  if (asset.scope === 'exclusive') {
    if (!asset.customer_id) return `素材 ${asset.asset_no} 登记为客户专属但没绑客户，先补客户再上架`;
    if (!task.customer_id || Number(asset.customer_id) !== Number(task.customer_id)) {
      return `素材 ${asset.asset_no} 是客户专属素材，不能用于其他客户的上新`;
    }
  }
  if (asset.scope === 'channel') {
    const list = (asset.channels || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length && task.channel && !list.includes(task.channel)) {
      return `素材 ${asset.asset_no} 只授权渠道「${list.join('/')}」，不能用于「${task.channel}」`;
    }
  }
  return null;
}

/** 把已过期但仍标 approved 的素材落库成 expired（审计用，需显式调用） */
function sweepExpired(operator) {
  const today = localDate();
  const rows = db.prepare(
    "SELECT id, asset_no FROM mkt_assets WHERE status='approved' AND license_to IS NOT NULL AND license_to<>'' AND license_to < ?"
  ).all(today);
  rows.forEach((r) => {
    db.prepare("UPDATE mkt_assets SET status='expired', updated_at=?, remark=COALESCE(remark,'')||? WHERE id=?")
      .run(localNow(), ` [${localNow()}] 授权到期自动置为已过期（${operator || 'system'}）`, r.id);
  });
  return { swept: rows.length, assets: rows.map((r) => r.asset_no) };
}

/** ==================== 上新门槛 ==================== */

/** 关联开发单（只读，用来判断技术是否确认；不负责推进技术状态） */
function techStateOf(styleNo) {
  if (!styleNo) return null;
  return db.prepare(
    `SELECT tp.id, tp.status, tp.stage, tp.version
     FROM tech_packs tp
     WHERE tp.order_id IN (SELECT oi.order_id FROM order_items oi WHERE oi.style_no=?)
     ORDER BY tp.id DESC LIMIT 1`
  ).get(styleNo) || null;
}

function stockQtyOf(styleNo) {
  if (!styleNo) return 0;
  return Number(db.prepare('SELECT COALESCE(SUM(qty),0) q FROM stock_items WHERE style_no=?').get(styleNo).q) || 0;
}

function boundAssets(taskId) {
  return db.prepare(
    `SELECT a.*, ta.role AS bind_role, ta.bound_at FROM mkt_task_assets ta
     JOIN mkt_assets a ON a.id=ta.asset_id WHERE ta.task_id=? ORDER BY ta.id`
  ).all(taskId);
}

/**
 * 三项门槛：
 *   asset 素材 —— 至少 1 个可用素材（所有任务都要）
 *   tech  技术 —— 定制单必须有开发单且已确认（现货不要求）
 *   stock 到仓 —— 现货单必须有可售库存（定制单是接了才做，不要求先有库存）
 */
function gatesOf(task) {
  const today = localDate();
  const items = [];

  const assets = boundAssets(task.id);
  const usable = assets.filter((a) => !assetBlockReason(a, task, today));
  items.push({
    key: 'asset',
    label: '可用素材',
    required: true,
    ok: usable.length > 0,
    detail: usable.length
      ? `已绑 ${usable.length} 个可用素材`
      : assets.length
        ? '已绑素材全部不可用（未审 / 受限 / 过期）'
        : '还没绑素材'
  });

  const needTech = task.biz_type === 'custom';
  const tp = techStateOf(task.style_no);
  items.push({
    key: 'tech',
    label: '技术确认',
    required: needTech,
    ok: !needTech ? true : !!(tp && tp.status === 'confirmed'),
    detail: !needTech
      ? '现货单不依赖开发单'
      : tp
        ? `开发单 ${tp.version || ''} 状态 ${tp.status}${tp.stage ? ' / 阶段 ' + tp.stage : ''}`
        : '按款号没找到开发单'
  });

  const needStock = task.biz_type !== 'custom';
  const qty = stockQtyOf(task.style_no);
  items.push({
    key: 'stock',
    label: '库存到仓',
    required: needStock,
    ok: !needStock ? true : qty > 0,
    detail: !needStock ? '定制单按订单生产，不要求先有库存' : qty > 0 ? `可售 ${qty} 件` : '该款号暂无库存'
  });

  const blocking = items.filter((i) => i.required && !i.ok);
  return { items, ok: blocking.length === 0, blocking: blocking.map((i) => i.label) };
}

/** ==================== 任务 ==================== */

function listTasks(q = {}) {
  const wh = [];
  const args = [];
  if (q.status) {
    const list = String(q.status).split(',').filter(Boolean);
    if (list.length) { wh.push(`t.status IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (q.channel) { wh.push('t.channel=?'); args.push(q.channel); }
  if (q.owner) { wh.push('t.owner=?'); args.push(q.owner); }
  if (q.company_id) { wh.push('t.company_id=?'); args.push(Number(q.company_id)); }
  if (q.month && isPeriod(q.month)) {
    wh.push("substr(COALESCE(t.plan_launch_date,''),1,7)=?"); args.push(q.month);
  }
  if (q.q) {
    wh.push('(t.title LIKE ? OR t.style_no LIKE ? OR t.task_no LIKE ?)');
    args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  if (q.overdue === '1' || q.overdue === 1) {
    wh.push("t.plan_launch_date < ? AND t.status IN ('draft','material','ready')");
    args.push(localDate());
  }

  const rows = db.prepare(
    `SELECT t.*, c.name AS customer_name, co.name AS company_name, cp.name AS campaign_name
     FROM mkt_tasks t
     LEFT JOIN customers c ON c.id=t.customer_id
     LEFT JOIN companies co ON co.id=t.company_id
     LEFT JOIN mkt_campaigns cp ON cp.id=t.campaign_id
     ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY COALESCE(t.plan_launch_date,'9999-12-31'), t.id DESC`
  ).all(...args);

  const today = localDate();
  return rows.map((t) => {
    const delay = t.actual_launch_date && t.plan_launch_date
      ? daysBetween(t.plan_launch_date, t.actual_launch_date) : null;
    return {
      ...t,
      status_label: TASK_LABEL[t.status] || t.status,
      delay_days: delay,
      is_overdue: !!(t.plan_launch_date && t.plan_launch_date < today
        && ['draft', 'material', 'ready'].includes(t.status)),
      days_left: t.plan_launch_date ? daysBetween(today, t.plan_launch_date) : null,
      asset_cnt: db.prepare('SELECT COUNT(*) c FROM mkt_task_assets WHERE task_id=?').get(t.id).c
    };
  });
}

function getTask(id) {
  const t = db.prepare('SELECT * FROM mkt_tasks WHERE id=?').get(Number(id));
  if (!t) return null;
  const gates = gatesOf(t);
  let gateSnapshot = null;
  try { gateSnapshot = t.gate_json ? JSON.parse(t.gate_json) : null; } catch (e) { gateSnapshot = null; }
  const today = localDate();
  const assets = boundAssets(t.id).map((a) => ({
    ...shapeAsset(a, today),
    bind_role: a.bind_role,
    bound_at: a.bound_at,
    blocked: assetBlockReason(a, t, today)
  }));
  return {
    ...t,
    status_label: TASK_LABEL[t.status] || t.status,
    customer_name: t.customer_id ? (db.prepare('SELECT name FROM customers WHERE id=?').get(t.customer_id) || {}).name : null,
    campaign_name: t.campaign_id ? (db.prepare('SELECT name FROM mkt_campaigns WHERE id=?').get(t.campaign_id) || {}).name : null,
    gates,
    gate_snapshot: gateSnapshot,
    assets,
    steps: db.prepare('SELECT * FROM mkt_task_steps WHERE task_id=? ORDER BY seq, id').all(t.id),
    logs: db.prepare('SELECT * FROM mkt_task_logs WHERE task_id=? ORDER BY id DESC').all(t.id),
    next: TASK_NEXT[t.status] || [],
    delay_days: t.actual_launch_date && t.plan_launch_date ? daysBetween(t.plan_launch_date, t.actual_launch_date) : null
  };
}

function createTask(b = {}, operator) {
  const title = String(b.title || '').trim();
  if (!title) throw new Error('任务名必填');
  const bizType = b.biz_type === 'custom' ? 'custom' : 'stock';
  if (!b.style_no && !b.product_name) throw new Error('款号或款名至少填一个');
  if (b.plan_launch_date && !isDate(b.plan_launch_date)) throw new Error('计划上线日期格式必须是 YYYY-MM-DD');
  if (b.customer_id && !db.prepare('SELECT id FROM customers WHERE id=?').get(Number(b.customer_id))) {
    throw new Error('客户不存在');
  }
  if (b.campaign_id) {
    const cp = db.prepare('SELECT id, status FROM mkt_campaigns WHERE id=?').get(Number(b.campaign_id));
    if (!cp) throw new Error('活动不存在');
    if (cp.status === 'cancelled') throw new Error('已取消的活动不能挂新任务');
  }

  const now = localNow();
  const companyId = Number(b.company_id) || defaultCompany();
  const id = db.prepare(
    `INSERT INTO mkt_tasks (task_no,company_id,title,biz_type,channel,shop_name,style_no,sku,product_name,
       customer_id,campaign_id,plan_launch_date,owner,depends,status,blocker,remark,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo('MK', 'mkt_tasks', 'task_no'), companyId, title, bizType,
    b.channel || null, b.shop_name || null, b.style_no || null, b.sku || null, b.product_name || null,
    b.customer_id ? Number(b.customer_id) : null, b.campaign_id ? Number(b.campaign_id) : null,
    b.plan_launch_date || null, b.owner || null, b.depends || null,
    'draft', b.blocker || null, b.remark || null, operator || 'system', now, now
  ).lastInsertRowid;

  const steps = Array.isArray(b.steps) && b.steps.length ? b.steps : DEFAULT_STEPS;
  steps.forEach((name, i) => {
    db.prepare('INSERT INTO mkt_task_steps (task_id,seq,name,owner,due_date,status) VALUES (?,?,?,?,?,?)')
      .run(id, i + 1, String(name), b.owner || null, null, 'pending');
  });

  db.prepare('INSERT INTO mkt_task_logs (task_id,from_status,to_status,operator,note,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, null, 'draft', operator || 'system', '创建任务', now);

  return getTask(id);
}

function updateTask(id, b = {}, operator) {
  const t = db.prepare('SELECT * FROM mkt_tasks WHERE id=?').get(Number(id));
  if (!t) throw new Error('任务不存在');
  if (t.status === 'reviewed') throw new Error('已复盘的任务不能再改，要改先退回「已上新」');
  if (b.plan_launch_date && !isDate(b.plan_launch_date)) throw new Error('计划上线日期格式必须是 YYYY-MM-DD');
  if (b.customer_id && !db.prepare('SELECT id FROM customers WHERE id=?').get(Number(b.customer_id))) {
    throw new Error('客户不存在');
  }
  // 客户改了，已绑的客户专属素材可能就违规了，先检查
  const nextCustomer = b.customer_id !== undefined ? (b.customer_id ? Number(b.customer_id) : null) : t.customer_id;
  if (nextCustomer !== t.customer_id) {
    const bad = boundAssets(t.id).filter((a) => a.scope === 'exclusive'
      && Number(a.customer_id || 0) !== Number(nextCustomer || 0));
    if (bad.length) throw new Error(`换客户后素材 ${bad.map((a) => a.asset_no).join('、')} 不再被授权，请先解绑`);
  }

  const pick = (k, d) => (b[k] !== undefined ? b[k] : d);
  db.prepare(
    `UPDATE mkt_tasks SET title=?,biz_type=?,channel=?,shop_name=?,style_no=?,sku=?,product_name=?,
       customer_id=?,campaign_id=?,plan_launch_date=?,owner=?,depends=?,blocker=?,remark=?,updated_at=?
     WHERE id=?`
  ).run(
    pick('title', t.title), b.biz_type === 'custom' || b.biz_type === 'stock' ? b.biz_type : t.biz_type,
    pick('channel', t.channel), pick('shop_name', t.shop_name), pick('style_no', t.style_no),
    pick('sku', t.sku), pick('product_name', t.product_name), nextCustomer,
    b.campaign_id !== undefined ? (b.campaign_id ? Number(b.campaign_id) : null) : t.campaign_id,
    pick('plan_launch_date', t.plan_launch_date), pick('owner', t.owner), pick('depends', t.depends),
    pick('blocker', t.blocker), pick('remark', t.remark), localNow(), t.id
  );
  return getTask(t.id);
}

/**
 * 推进任务状态。
 * 硬门槛：到「资料确认」必须有可用素材；到「已上新」三项门槛必须全过。
 * 这里只是**检查**依赖，不会去改开发单或库存 —— 上新与投产是两个状态。
 */
function advanceTask(id, to, b = {}, operator) {
  const t = db.prepare('SELECT * FROM mkt_tasks WHERE id=?').get(Number(id));
  if (!t) throw new Error('任务不存在');
  if (!TASK_LABEL[to]) throw new Error('状态不合法');
  if (to === t.status) throw new Error('已经是这个状态了');
  const allowed = TASK_NEXT[t.status] || [];
  if (!allowed.includes(to)) {
    throw new Error(`不能从「${TASK_LABEL[t.status]}」直接到「${TASK_LABEL[to]}」，可选：${allowed.map((x) => TASK_LABEL[x]).join(' / ') || '无'}`);
  }
  const isBack = TASK_BACK.has(`${t.status}>${to}`);
  if (isBack && !String(b.note || '').trim()) throw new Error('退回上一个状态必须写原因');

  const gates = gatesOf(t);
  if (to === 'ready' && !gates.items.find((i) => i.key === 'asset').ok) {
    throw new Error('还没有可用素材，不能进入「资料确认」');
  }
  if (to === 'launched' && !gates.ok) {
    throw new Error(`上新门槛未通过：${gates.blocking.join('、')}`);
  }
  if (to === 'launched' && !b.launch_date && !t.actual_launch_date) b.launch_date = localDate();
  if (b.launch_date && !isDate(b.launch_date)) throw new Error('上线日期格式必须是 YYYY-MM-DD');

  const now = localNow();
  const actual = to === 'launched' ? (b.launch_date || t.actual_launch_date || localDate()) : t.actual_launch_date;
  db.prepare('UPDATE mkt_tasks SET status=?, actual_launch_date=?, gate_json=?, updated_at=? WHERE id=?')
    .run(to, actual, JSON.stringify(gates), now, t.id);
  db.prepare('INSERT INTO mkt_task_logs (task_id,from_status,to_status,operator,note,gate_json,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(t.id, t.status, to, operator || 'system', b.note || null, JSON.stringify(gates.items), now);

  // 上新时把「上新发布」这一步自动打勾，避免两处状态各说各话
  if (to === 'launched') {
    const step = db.prepare("SELECT id FROM mkt_task_steps WHERE task_id=? AND name LIKE '%上新%' ORDER BY seq LIMIT 1").get(t.id);
    if (step) {
      db.prepare("UPDATE mkt_task_steps SET status='done', done_at=? WHERE id=? AND status<>'done'").run(now, step.id);
    }
  }
  return getTask(t.id);
}

function deleteTask(id, operator) {
  const t = db.prepare('SELECT * FROM mkt_tasks WHERE id=?').get(Number(id));
  if (!t) throw new Error('任务不存在');
  if (['launched', 'reviewed'].includes(t.status)) throw new Error('已上新的任务不能删，请改为取消或退回');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM mkt_task_assets WHERE task_id=?').run(t.id);
    db.prepare('DELETE FROM mkt_task_steps WHERE task_id=?').run(t.id);
    db.prepare('DELETE FROM mkt_task_logs WHERE task_id=?').run(t.id);
    db.prepare('DELETE FROM mkt_tasks WHERE id=?').run(t.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { deleted: 1, task_no: t.task_no, by: operator };
}

/** ==================== 任务步骤 ==================== */

function addStep(taskId, b = {}) {
  const t = db.prepare('SELECT id FROM mkt_tasks WHERE id=?').get(Number(taskId));
  if (!t) throw new Error('任务不存在');
  const name = String(b.name || '').trim();
  if (!name) throw new Error('步骤名必填');
  if (b.due_date && !isDate(b.due_date)) throw new Error('截止日期格式必须是 YYYY-MM-DD');
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) m FROM mkt_task_steps WHERE task_id=?').get(t.id).m) + 1;
  const id = db.prepare('INSERT INTO mkt_task_steps (task_id,seq,name,owner,due_date,status,remark) VALUES (?,?,?,?,?,?,?)')
    .run(t.id, seq, name, b.owner || null, b.due_date || null, 'pending', b.remark || null).lastInsertRowid;
  return db.prepare('SELECT * FROM mkt_task_steps WHERE id=?').get(id);
}

function setStep(taskId, stepId, b = {}) {
  const s = db.prepare('SELECT * FROM mkt_task_steps WHERE id=? AND task_id=?').get(Number(stepId), Number(taskId));
  if (!s) throw new Error('步骤不存在');
  const st = b.status || s.status;
  if (!['pending', 'doing', 'done'].includes(st)) throw new Error('步骤状态只能是 待开始 / 进行中 / 已完成');
  db.prepare('UPDATE mkt_task_steps SET status=?, owner=?, due_date=?, done_at=?, remark=? WHERE id=?')
    .run(st, b.owner !== undefined ? b.owner : s.owner, b.due_date !== undefined ? b.due_date : s.due_date,
      st === 'done' ? (s.done_at || localNow()) : null,
      b.remark !== undefined ? b.remark : s.remark, s.id);
  return db.prepare('SELECT * FROM mkt_task_steps WHERE id=?').get(s.id);
}

/** ==================== 素材 ==================== */

function listAssets(q = {}) {
  const today = localDate();
  const wh = [];
  const args = [];
  if (q.status) {
    const list = String(q.status).split(',').filter(Boolean);
    if (list.length) { wh.push(`a.status IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (q.kind) { wh.push('a.kind=?'); args.push(q.kind); }
  if (q.scope) { wh.push('a.scope=?'); args.push(q.scope); }
  if (q.style_no) { wh.push('a.style_no=?'); args.push(q.style_no); }
  if (q.customer_id) { wh.push('a.customer_id=?'); args.push(Number(q.customer_id)); }
  if (q.q) { wh.push('(a.title LIKE ? OR a.asset_no LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.expiring === '1' || q.expiring === 1) {
    const days = Number(q.days) > 0 ? Number(q.days) : 30;
    wh.push("a.status='approved' AND a.license_to IS NOT NULL AND a.license_to<>'' AND a.license_to BETWEEN ? AND ?");
    args.push(today, addDays(today, days));
  }

  return db.prepare(
    `SELECT a.*, c.name AS customer_name FROM mkt_assets a
     LEFT JOIN customers c ON c.id=a.customer_id
     ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY a.id DESC`
  ).all(...args).map((a) => shapeAsset(a, today));
}

function getAsset(id) {
  const a = db.prepare('SELECT * FROM mkt_assets WHERE id=?').get(Number(id));
  if (!a) return null;
  const today = localDate();
  const tasks = db.prepare(
    `SELECT t.id, t.task_no, t.title, t.status, t.channel, t.plan_launch_date, ta.role
     FROM mkt_task_assets ta JOIN mkt_tasks t ON t.id=ta.task_id
     WHERE ta.asset_id=? ORDER BY t.id DESC`
  ).all(a.id);
  return {
    ...shapeAsset(a, today),
    tasks: tasks.map((t) => ({ ...t, status_label: TASK_LABEL[t.status] || t.status }))
  };
}

function createAsset(b = {}, operator) {
  const title = String(b.title || '').trim();
  if (!title) throw new Error('素材名称必填');
  const kind = ['image', 'video', 'pattern', 'doc'].includes(b.kind) ? b.kind : 'image';
  const scope = ['public', 'channel', 'exclusive'].includes(b.scope) ? b.scope : 'channel';
  if (scope === 'exclusive' && !b.customer_id) throw new Error('客户专属素材必须指定客户');
  if (b.customer_id && !db.prepare('SELECT id FROM customers WHERE id=?').get(Number(b.customer_id))) {
    throw new Error('客户不存在');
  }
  if (scope === 'channel' && !String(b.channels || '').trim()) throw new Error('指定渠道素材必须填授权渠道');
  const licenseSource = ['own', 'customer', 'supplier', 'ai'].includes(b.license_source) ? b.license_source : 'own';
  if (b.license_from && !isDate(b.license_from)) throw new Error('授权开始日期格式必须是 YYYY-MM-DD');
  if (b.license_to && !isDate(b.license_to)) throw new Error('授权到期日期格式必须是 YYYY-MM-DD');
  if (b.license_from && b.license_to && b.license_to < b.license_from) throw new Error('授权到期日不能早于开始日');

  const now = localNow();
  const aiGen = licenseSource === 'ai' || b.ai_generated ? 1 : 0;
  const id = db.prepare(
    `INSERT INTO mkt_assets (asset_no,company_id,kind,title,url,version,style_no,product_name,tech_version,
       scope,customer_id,channels,license_source,license_from,license_to,ai_generated,status,remark,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo('AS', 'mkt_assets', 'asset_no'), Number(b.company_id) || defaultCompany(), kind, title,
    b.url || null, b.version || null, b.style_no || null, b.product_name || null, b.tech_version || null,
    scope, b.customer_id ? Number(b.customer_id) : null, b.channels || null,
    licenseSource, b.license_from || null, b.license_to || null, aiGen, 'draft',
    b.remark || null, operator || 'system', now, now
  ).lastInsertRowid;
  return getAsset(id);
}

function updateAsset(id, b = {}, operator) {
  const a = db.prepare('SELECT * FROM mkt_assets WHERE id=?').get(Number(id));
  if (!a) throw new Error('素材不存在');
  if (a.status === 'approved') throw new Error('已审核通过的素材不能再改，请新建一个新版本（版本号区分）');
  const scope = b.scope || a.scope;
  const customerId = b.customer_id !== undefined ? (b.customer_id ? Number(b.customer_id) : null) : a.customer_id;
  const channels = b.channels !== undefined ? b.channels : a.channels;
  if (scope === 'exclusive' && !customerId) throw new Error('客户专属素材必须指定客户');
  if (scope === 'channel' && !String(channels || '').trim()) throw new Error('指定渠道素材必须填授权渠道');
  const from = b.license_from !== undefined ? b.license_from : a.license_from;
  const to = b.license_to !== undefined ? b.license_to : a.license_to;
  if (from && !isDate(from)) throw new Error('授权开始日期格式必须是 YYYY-MM-DD');
  if (to && !isDate(to)) throw new Error('授权到期日期格式必须是 YYYY-MM-DD');
  if (from && to && to < from) throw new Error('授权到期日不能早于开始日');

  const pick = (k, d) => (b[k] !== undefined ? b[k] : d);
  const licenseSource = ['own', 'customer', 'supplier', 'ai'].includes(b.license_source) ? b.license_source : a.license_source;
  db.prepare(
    `UPDATE mkt_assets SET kind=?,title=?,url=?,version=?,style_no=?,product_name=?,tech_version=?,
       scope=?,customer_id=?,channels=?,license_source=?,license_from=?,license_to=?,ai_generated=?,remark=?,updated_at=?
     WHERE id=?`
  ).run(
    ['image', 'video', 'pattern', 'doc'].includes(b.kind) ? b.kind : a.kind,
    pick('title', a.title), pick('url', a.url), pick('version', a.version), pick('style_no', a.style_no),
    pick('product_name', a.product_name), pick('tech_version', a.tech_version), scope, customerId, channels,
    licenseSource, from, to, (licenseSource === 'ai' || b.ai_generated) ? 1 : 0,
    pick('remark', a.remark), localNow(), a.id
  );
  return getAsset(a.id);
}

/** 提交审核：草稿 → 待审 */
function submitAsset(id, operator) {
  const a = db.prepare('SELECT * FROM mkt_assets WHERE id=?').get(Number(id));
  if (!a) throw new Error('素材不存在');
  if (!['draft', 'revoked', 'expired'].includes(a.status)) throw new Error(`当前是「${ASSET_STATUS_LABEL[a.status]}」，不需要重新提交`);
  if (!a.license_source) throw new Error('请先填版权来源');
  if (a.license_source === 'ai' && !a.tech_version) {
    // AI 生成最容易「看起来像这个款其实不是」，必须声明对应的技术资料版本
    throw new Error('AI 生成素材必须填写对应的技术资料版本（如 TECH-V2），便于核对适用性');
  }
  db.prepare("UPDATE mkt_assets SET status='pending', updated_at=? WHERE id=?").run(localNow(), a.id);
  return getAsset(a.id);
}

/** 审核：通过 / 驳回（AI 生成的内容只能走这条路，不能直接上架） */
function reviewAsset(id, b = {}, operator) {
  const a = db.prepare('SELECT * FROM mkt_assets WHERE id=?').get(Number(id));
  if (!a) throw new Error('素材不存在');
  if (a.status !== 'pending') throw new Error('只有「待审」的素材可以审核');
  const pass = !!b.pass;
  if (!pass && !String(b.note || '').trim()) throw new Error('驳回必须写原因');
  if (a.license_to && a.license_to < localDate()) throw new Error('授权已到期，不能通过审核，请先续期');
  const now = localNow();
  db.prepare("UPDATE mkt_assets SET status=?,review_note=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?")
    .run(pass ? 'approved' : 'draft', b.note || null, operator || 'system', now, now, a.id);
  return getAsset(a.id);
}

function revokeAsset(id, b = {}, operator) {
  const a = db.prepare('SELECT * FROM mkt_assets WHERE id=?').get(Number(id));
  if (!a) throw new Error('素材不存在');
  if (!String(b.note || '').trim()) throw new Error('作废必须写原因（客户撤授权、侵权投诉等）');
  const now = localNow();
  db.prepare("UPDATE mkt_assets SET status='revoked',review_note=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?")
    .run(b.note, operator || 'system', now, now, a.id);
  return getAsset(a.id);
}

/** 删素材：只允许「草稿 / 已作废」且没被任何任务引用的（有引用的删了会让历史任务说不清用了什么） */
function deleteAsset(id, operator) {
  const a = db.prepare('SELECT * FROM mkt_assets WHERE id=?').get(Number(id));
  if (!a) throw new Error('素材不存在');
  if (!['draft', 'revoked'].includes(a.status)) throw new Error('只有草稿或已作废的素材可以删除');
  const used = db.prepare('SELECT COUNT(*) c FROM mkt_task_assets WHERE asset_id=?').get(a.id).c;
  if (used) throw new Error(`这个素材还被 ${used} 条任务引用，先解绑再删`);
  db.prepare('DELETE FROM mkt_assets WHERE id=?').run(a.id);
  return { deleted: 1, asset_no: a.asset_no, by: operator || 'system' };
}

/** 绑定素材到任务：这里做授权校验，不是提示 */
function bindAsset(taskId, b = {}, operator) {
  const t = db.prepare('SELECT * FROM mkt_tasks WHERE id=?').get(Number(taskId));
  if (!t) throw new Error('任务不存在');
  if (['reviewed', 'cancelled'].includes(t.status)) throw new Error('已复盘/已取消的任务不能再挂素材');
  const a = db.prepare('SELECT * FROM mkt_assets WHERE id=?').get(Number(b.asset_id));
  if (!a) throw new Error('素材不存在');
  const why = assetBlockReason(a, t);
  if (why) throw new Error(why);
  if (db.prepare('SELECT id FROM mkt_task_assets WHERE task_id=? AND asset_id=?').get(t.id, a.id)) {
    throw new Error('这个素材已经挂在这条任务上了');
  }
  db.prepare('INSERT INTO mkt_task_assets (task_id,asset_id,role,bound_by,bound_at) VALUES (?,?,?,?,?)')
    .run(t.id, a.id, b.role || 'main', operator || 'system', localNow());
  return getTask(t.id);
}

function unbindAsset(taskId, assetId) {
  const t = db.prepare('SELECT * FROM mkt_tasks WHERE id=?').get(Number(taskId));
  if (!t) throw new Error('任务不存在');
  if (t.status === 'reviewed') throw new Error('已复盘的任务不能再解绑素材');
  const r = db.prepare('DELETE FROM mkt_task_assets WHERE task_id=? AND asset_id=?').run(t.id, Number(assetId));
  if (!r.changes) throw new Error('这条素材没挂在该任务上');
  return getTask(t.id);
}

/** ==================== 活动 ==================== */

function billTotal(campaignId) {
  return r2(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM mkt_campaign_bills WHERE campaign_id=?').get(campaignId).s);
}

/** 内部往来单位对应的客户 id（用于剔除内部转单） */
function internalCustomerIds(companyId) {
  const rows = db.prepare(
    `SELECT p.ref_id, p.ref_name FROM intercompany_parties p
     WHERE p.company_id=? AND p.kind IN ('customer','both') AND p.status='active'`
  ).all(Number(companyId));
  const ids = new Set();
  const names = new Set();
  rows.forEach((r) => {
    if (r.ref_id) ids.add(Number(r.ref_id));
    if (r.ref_name) names.add(String(r.ref_name));
  });
  if (names.size) {
    db.prepare('SELECT id, name FROM customers').all().forEach((c) => {
      if (names.has(c.name)) ids.add(c.id);
    });
  }
  return ids;
}

/**
 * 归因：活动期间 + 归因窗口内的订单。
 * 剔除两类「看起来是增长其实不是」的：
 *   1. 未确认销售（还在 draft/tech/finance，没排产）—— 下单不等于卖掉
 *   2. 集团内部转单（intercompany_parties 登记的内部客户）
 * 另：渠道对不上的订单不算这个活动的功劳。
 */
function attributionOf(campaign) {
  const start = campaign.start_date || '0000-01-01';
  const end = campaign.end_date ? addDays(campaign.end_date, Number(campaign.attribution_days) || 0) : localDate();
  const key = String(campaign.shop_name || campaign.channel || '').trim();
  const internal = internalCustomerIds(campaign.company_id || defaultCompany());

  const rows = db.prepare(
    `SELECT o.id, o.order_no, o.status, o.customer_id, o.total_usd, o.total_amount, o.rate,
            o.order_date, o.shop_name, c.name AS customer_name
     FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
     WHERE o.order_date >= ? AND o.order_date <= ?
     ORDER BY o.order_date, o.id`
  ).all(start, end);

  const counted = [];
  const excluded = { unconfirmed: [], internal: [], channel: [] };
  rows.forEach((o) => {
    if (!CONFIRMED_ORDER_STATUS.includes(o.status)) { excluded.unconfirmed.push(o); return; }
    if (o.customer_id && internal.has(Number(o.customer_id))) { excluded.internal.push(o); return; }
    if (key && String(o.shop_name || '').trim() !== key) { excluded.channel.push(o); return; }
    counted.push(o);
  });

  const cur = campaign.currency === 'USD' ? 'USD' : 'CNY';
  const revenueOf = (o) => (cur === 'USD' ? r2(o.total_usd) : r2(o.total_amount));
  const revenue = r2(counted.reduce((s, o) => s + revenueOf(o), 0));
  const revenueCny = r2(counted.reduce((s, o) => s + r2(o.total_amount), 0));
  const grossCny = r2(counted.reduce((s, o) => {
    const co = db.prepare('SELECT sold_revenue, sold_cost FROM cost_objects WHERE order_id=?').get(o.id);
    return s + (co ? r2(co.sold_revenue) - r2(co.sold_cost) : 0);
  }, 0));
  const spend = billTotal(campaign.id);

  return {
    window: { start, end, attribution_days: Number(campaign.attribution_days) || 0 },
    currency: cur,
    match_key: key || '(未限定店铺/渠道)',
    counted: counted.map((o) => ({ ...o, revenue: revenueOf(o) })),
    counted_cnt: counted.length,
    excluded: {
      unconfirmed: { cnt: excluded.unconfirmed.length, orders: excluded.unconfirmed.map((o) => ({ order_no: o.order_no, status: o.status, order_date: o.order_date })) },
      internal: { cnt: excluded.internal.length, orders: excluded.internal.map((o) => ({ order_no: o.order_no, customer_name: o.customer_name, order_date: o.order_date })) },
      channel: { cnt: excluded.channel.length, orders: excluded.channel.map((o) => ({ order_no: o.order_no, shop_name: o.shop_name, order_date: o.order_date })) }
    },
    scanned: rows.length,
    revenue,
    revenue_cny: revenueCny,
    gross_cny: grossCny,
    spend,
    roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null,
    cpso: counted.length ? r2(spend / counted.length) : null
  };
}

function listCampaigns(q = {}) {
  const wh = [];
  const args = [];
  if (q.status) {
    const list = String(q.status).split(',').filter(Boolean);
    if (list.length) { wh.push(`cp.status IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (q.currency) { wh.push('cp.currency=?'); args.push(q.currency); }
  if (q.channel) { wh.push('cp.channel=?'); args.push(q.channel); }
  if (q.company_id) { wh.push('cp.company_id=?'); args.push(Number(q.company_id)); }

  return db.prepare(
    `SELECT cp.*, co.name AS company_name,
       (SELECT COUNT(*) FROM mkt_campaign_bills b WHERE b.campaign_id=cp.id) AS bill_cnt
     FROM mkt_campaigns cp LEFT JOIN companies co ON co.id=cp.company_id
     ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY COALESCE(cp.start_date,'9999-12-31') DESC, cp.id DESC`
  ).all(...args).map((c) => {
    const actual = billTotal(c.id);
    return {
      ...c,
      status_label: CAMP_LABEL[c.status] || c.status,
      actual_amount: actual,
      over_budget: actual > c.budget_amount,
      over_rate: c.budget_amount > 0 ? Math.round((actual / c.budget_amount) * 1000) / 10 : null,
      roas: actual > 0 ? Math.round((c.attributed_revenue / actual) * 100) / 100 : null
    };
  });
}

function getCampaign(id) {
  const c = db.prepare('SELECT * FROM mkt_campaigns WHERE id=?').get(Number(id));
  if (!c) return null;
  const actual = billTotal(c.id);
  const bills = db.prepare('SELECT * FROM mkt_campaign_bills WHERE campaign_id=? ORDER BY bill_date, id').all(c.id)
    .map((b) => ({ ...b, source_label: BILL_SOURCE_LABEL[b.source] || b.source }));
  const tasks = db.prepare('SELECT id, task_no, title, status, channel, plan_launch_date FROM mkt_tasks WHERE campaign_id=? ORDER BY id').all(c.id);
  return {
    ...c,
    status_label: CAMP_LABEL[c.status] || c.status,
    actual_amount: actual,
    over_budget: actual > c.budget_amount,
    bills,
    tasks: tasks.map((t) => ({ ...t, status_label: TASK_LABEL[t.status] || t.status })),
    live_attribution: attributionOf(c)
  };
}

function createCampaign(b = {}, operator) {
  const name = String(b.name || '').trim();
  if (!name) throw new Error('活动名必填');
  const currency = CURRENCIES.includes(b.currency) ? b.currency : 'CNY';
  const budget = Number(b.budget_amount);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('预算必须是大于 0 的数字');
  if (b.start_date && !isDate(b.start_date)) throw new Error('开始日期格式必须是 YYYY-MM-DD');
  if (b.end_date && !isDate(b.end_date)) throw new Error('结束日期格式必须是 YYYY-MM-DD');
  if (b.start_date && b.end_date && b.end_date < b.start_date) throw new Error('结束日期不能早于开始日期');
  const attrDays = Number(b.attribution_days);
  if (b.attribution_days !== undefined && (!Number.isFinite(attrDays) || attrDays < 0 || attrDays > 90)) {
    throw new Error('归因窗口必须在 0-90 天之间');
  }
  const now = localNow();
  const id = db.prepare(
    `INSERT INTO mkt_campaigns (campaign_no,company_id,name,channel,shop_name,currency,budget_amount,
       start_date,end_date,attribution_days,owner,status,note,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo('CAM', 'mkt_campaigns', 'campaign_no'), Number(b.company_id) || defaultCompany(),
    name, b.channel || null, b.shop_name || null, currency, budget,
    b.start_date || null, b.end_date || null,
    b.attribution_days !== undefined ? attrDays : 7,
    b.owner || null, 'draft', b.note || null, operator || 'system', now, now
  ).lastInsertRowid;
  return getCampaign(id);
}

function updateCampaign(id, b = {}) {
  const c = db.prepare('SELECT * FROM mkt_campaigns WHERE id=?').get(Number(id));
  if (!c) throw new Error('活动不存在');
  if (c.status !== 'draft') throw new Error('只有草稿状态能改预算与周期，已批准的要另开调整记录');
  const budget = b.budget_amount !== undefined ? Number(b.budget_amount) : c.budget_amount;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('预算必须是大于 0 的数字');
  const start = b.start_date !== undefined ? b.start_date : c.start_date;
  const end = b.end_date !== undefined ? b.end_date : c.end_date;
  if (start && !isDate(start)) throw new Error('开始日期格式必须是 YYYY-MM-DD');
  if (end && !isDate(end)) throw new Error('结束日期格式必须是 YYYY-MM-DD');
  if (start && end && end < start) throw new Error('结束日期不能早于开始日期');
  const pick = (k, d) => (b[k] !== undefined ? b[k] : d);
  db.prepare(
    `UPDATE mkt_campaigns SET name=?,channel=?,shop_name=?,currency=?,budget_amount=?,start_date=?,end_date=?,
       attribution_days=?,owner=?,note=?,updated_at=? WHERE id=?`
  ).run(
    pick('name', c.name), pick('channel', c.channel), pick('shop_name', c.shop_name),
    CURRENCIES.includes(b.currency) ? b.currency : c.currency, budget, start, end,
    b.attribution_days !== undefined ? Number(b.attribution_days) : c.attribution_days,
    pick('owner', c.owner), pick('note', c.note), localNow(), c.id
  );
  return getCampaign(c.id);
}

function approveCampaign(id, b = {}, operator) {
  const c = db.prepare('SELECT * FROM mkt_campaigns WHERE id=?').get(Number(id));
  if (!c) throw new Error('活动不存在');
  if (c.status !== 'draft') throw new Error('只有草稿可以批准');
  if (!c.start_date || !c.end_date) throw new Error('批准前必须填活动起止日期');
  const now = localNow();
  db.prepare("UPDATE mkt_campaigns SET status='approved',approved_by=?,approved_at=?,approve_note=?,updated_at=? WHERE id=?")
    .run(operator || 'system', now, b.note || null, now, c.id);
  return getCampaign(c.id);
}

function advanceCampaign(id, to, b = {}, operator) {
  const c = db.prepare('SELECT * FROM mkt_campaigns WHERE id=?').get(Number(id));
  if (!c) throw new Error('活动不存在');
  if (!CAMP_LABEL[to]) throw new Error('状态不合法');
  if (to === c.status) throw new Error('已经是这个状态了');
  const flow = { draft: ['cancelled'], approved: ['running', 'cancelled'], running: ['billed'], billed: ['closed'], closed: [], cancelled: [] };
  if (!(flow[c.status] || []).includes(to)) {
    throw new Error(`不能从「${CAMP_LABEL[c.status]}」直接到「${CAMP_LABEL[to]}」`);
  }
  const actual = billTotal(c.id);
  if (to === 'billed' && actual <= 0) throw new Error('还没有登记任何账单，不能标记为已账单');
  if (to === 'closed') {
    if (actual <= 0) throw new Error('没有账单的活动不能复核关闭');
    if (actual > c.budget_amount && !String(b.note || '').trim() && !String(c.note || '').trim()) {
      throw new Error('实际花费已超预算，关闭时必须写说明');
    }
  }
  const attr = attributionOf(c);
  const now = localNow();
  db.prepare(
    `UPDATE mkt_campaigns SET status=?,actual_amount=?,attributed_orders=?,attributed_revenue=?,
       attributed_revenue_cny=?,attributed_gross_cny=?,roas=?,settled_at=?,updated_at=? WHERE id=?`
  ).run(
    to, actual, attr.counted_cnt, attr.revenue, attr.revenue_cny, attr.gross_cny, attr.roas,
    to === 'closed' ? now : null, now, c.id
  );
  if (b.note) {
    db.prepare('UPDATE mkt_campaigns SET note=? WHERE id=?').run(b.note, c.id);
  }
  return getCampaign(c.id);
}

function addBill(campaignId, b = {}, operator) {
  const c = db.prepare('SELECT * FROM mkt_campaigns WHERE id=?').get(Number(campaignId));
  if (!c) throw new Error('活动不存在');
  if (['draft', 'cancelled'].includes(c.status)) throw new Error('活动还没批准，不能登记账单');
  if (['billed', 'closed'].includes(c.status)) throw new Error('活动已结算，账单不能再补');
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('账单金额必须大于 0');
  const cur = b.currency || c.currency;
  if (cur !== c.currency) {
    throw new Error(`账单币种 ${cur} 与活动币种 ${c.currency} 不一致，不同币种不能相加，请按同一币种重新登记`);
  }
  const billDate = b.bill_date || localDate();
  if (!isDate(billDate)) throw new Error('账单日期格式必须是 YYYY-MM-DD');
  const now = localNow();
  db.prepare(
    `INSERT INTO mkt_campaign_bills (campaign_id,bill_date,amount,currency,vendor,ref_no,source,note,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(c.id, billDate, r2(amount), cur, b.vendor || null, b.ref_no || null,
    ['ads', 'agency', 'invoice', 'other'].includes(b.source) ? b.source : 'ads',
    b.note || null, operator || 'system', now);
  const total = billTotal(c.id);
  db.prepare('UPDATE mkt_campaigns SET actual_amount=?, updated_at=? WHERE id=?').run(total, now, c.id);
  return getCampaign(c.id);
}

/** ==================== 复盘 ==================== */

function listReviews(q = {}) {
  const wh = [];
  const args = [];
  if (q.status) {
    const list = String(q.status).split(',').filter(Boolean);
    if (list.length) { wh.push(`r.status IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (q.period && isPeriod(q.period)) { wh.push('r.period=?'); args.push(q.period); }
  if (q.category) { wh.push('r.category=?'); args.push(q.category); }
  if (q.owner) { wh.push('r.owner=?'); args.push(q.owner); }

  return db.prepare(
    `SELECT r.*, co.name AS company_name,
       (SELECT COUNT(*) FROM mkt_review_actions a WHERE a.review_id=r.id) AS action_cnt,
       (SELECT COUNT(*) FROM mkt_review_actions a WHERE a.review_id=r.id AND a.status='done') AS done_cnt,
       (SELECT COUNT(*) FROM mkt_review_actions a WHERE a.review_id=r.id AND a.status IN ('pending','doing') AND a.due_date < ?) AS overdue_cnt
     FROM mkt_reviews r LEFT JOIN companies co ON co.id=r.company_id
     ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY COALESCE(r.period,'') DESC, r.id DESC`
  ).all(localDate(), ...args).map((r) => ({
    ...r,
    status_label: REVIEW_LABEL[r.status] || r.status,
    category_label: REVIEW_CATEGORY[r.category] || r.category
  }));
}

function getReview(id) {
  const r = db.prepare('SELECT * FROM mkt_reviews WHERE id=?').get(Number(id));
  if (!r) return null;
  const actions = db.prepare('SELECT * FROM mkt_review_actions WHERE review_id=? ORDER BY seq, id').all(r.id)
    .map((a) => ({ ...a, is_overdue: ['pending', 'doing'].includes(a.status) && a.due_date < localDate() }));
  return {
    ...r,
    status_label: REVIEW_LABEL[r.status] || r.status,
    category_label: REVIEW_CATEGORY[r.category] || r.category,
    actions,
    open_actions: actions.filter((a) => ['pending', 'doing'].includes(a.status)).length
  };
}

function createReview(b = {}, operator) {
  const topic = String(b.topic || '').trim();
  if (!topic) throw new Error('复盘主题必填');
  const category = REVIEW_CATEGORY[b.category] ? b.category : 'other';
  const period = b.period && isPeriod(b.period) ? b.period : localDate().slice(0, 7);
  // 「有来源」：要么写清证据，要么挂到具体单据，否则复盘就是空谈
  if (!String(b.evidence || '').trim() && !b.source_type) {
    throw new Error('复盘必须有来源：填证据（单号/事件/工单）或关联单据');
  }
  if (b.due_date && !isDate(b.due_date)) throw new Error('期限格式必须是 YYYY-MM-DD');
  const now = localNow();
  const id = db.prepare(
    `INSERT INTO mkt_reviews (review_no,company_id,period,topic,category,evidence,source_type,source_id,
       status,owner,due_date,findings,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo('REV', 'mkt_reviews', 'review_no'), Number(b.company_id) || defaultCompany(),
    period, topic, category, b.evidence || null, b.source_type || 'manual',
    b.source_id ? Number(b.source_id) : null, 'draft', b.owner || null, b.due_date || null,
    b.findings || null, operator || 'system', now, now
  ).lastInsertRowid;
  return getReview(id);
}

function addReviewAction(reviewId, b = {}) {
  const r = db.prepare('SELECT * FROM mkt_reviews WHERE id=?').get(Number(reviewId));
  if (!r) throw new Error('复盘不存在');
  if (r.status === 'done') throw new Error('已关闭的复盘不能再加行动项，请重新打开');
  const action = String(b.action || '').trim();
  if (!action) throw new Error('行动内容必填');
  if (!String(b.owner || '').trim()) throw new Error('行动项必须有负责人');
  if (!b.due_date) throw new Error('行动项必须有期限');
  if (!isDate(b.due_date)) throw new Error('期限格式必须是 YYYY-MM-DD');
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) m FROM mkt_review_actions WHERE review_id=?').get(r.id).m) + 1;
  const id = db.prepare('INSERT INTO mkt_review_actions (review_id,seq,action,owner,due_date,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(r.id, seq, action, b.owner, b.due_date, 'pending', localNow()).lastInsertRowid;
  return getReview(r.id);
}

function setReviewAction(reviewId, actionId, b = {}) {
  const a = db.prepare('SELECT * FROM mkt_review_actions WHERE id=? AND review_id=?').get(Number(actionId), Number(reviewId));
  if (!a) throw new Error('行动项不存在');
  const st = b.status || a.status;
  if (!['pending', 'doing', 'done', 'cancelled'].includes(st)) throw new Error('行动状态不合法');
  if (st === 'done' && !String(b.result || '').trim()) throw new Error('标记完成要写结果（做了什么、效果如何）');
  db.prepare('UPDATE mkt_review_actions SET status=?,done_at=?,result=? WHERE id=?')
    .run(st, st === 'done' ? (a.done_at || localNow()) : null,
      b.result !== undefined ? b.result : a.result, a.id);
  return getReview(reviewId);
}

function advanceReview(id, to, b = {}, operator) {
  const r = db.prepare('SELECT * FROM mkt_reviews WHERE id=?').get(Number(id));
  if (!r) throw new Error('复盘不存在');
  if (!REVIEW_LABEL[to]) throw new Error('状态不合法');
  if (to === r.status) throw new Error('已经是这个状态了');
  const flow = { draft: ['open', 'done'], open: ['doing', 'done'], doing: ['done', 'open'], done: ['doing'] };
  if (!(flow[r.status] || []).includes(to)) throw new Error(`不能从「${REVIEW_LABEL[r.status]}」直接到「${REVIEW_LABEL[to]}」`);

  const acts = db.prepare('SELECT * FROM mkt_review_actions WHERE review_id=?').all(r.id);
  if (to === 'open' && !acts.length) throw new Error('待行动之前至少要有 1 条行动项（有负责人和期限）');
  if (to === 'open' && acts.some((a) => !a.owner || !a.due_date)) throw new Error('有行动项缺负责人或期限，补齐再推进');
  if (to === 'done') {
    const open = acts.filter((a) => ['pending', 'doing'].includes(a.status));
    if (open.length) throw new Error(`还有 ${open.length} 条行动项未完成，不能关闭复盘`);
    if (!acts.length) throw new Error('没有任何行动项的复盘不能关闭');
  }
  if (!r.owner && to !== 'open') {
    // 复盘本身也要有主责，否则没人对闭环负责
    if (!String(b.owner || '').trim()) throw new Error('请指定复盘主责人');
  }
  const now = localNow();
  db.prepare('UPDATE mkt_reviews SET status=?,owner=?,closed_at=?,findings=?,updated_at=? WHERE id=?')
    .run(to, b.owner || r.owner, to === 'done' ? now : null,
      b.findings !== undefined ? b.findings : r.findings, now, r.id);
  return getReview(r.id);
}

/** ==================== 日历 / 汇总 / 报表 ==================== */

/** 上新日历：按计划上线日铺开，前端直接按天渲染 */
function calendar(month) {
  const m = isPeriod(month) ? month : localDate().slice(0, 7);
  const tasks = listTasks({ month: m });
  const byDate = {};
  tasks.forEach((t) => {
    const d = t.plan_launch_date || '未排期';
    (byDate[d] = byDate[d] || []).push(t);
  });
  return { month: m, tasks, by_date: byDate };
}

function overview() {
  const today = localDate();
  const weekEnd = addDays(today, 7);

  const tasks = db.prepare('SELECT status, plan_launch_date, actual_launch_date, biz_type FROM mkt_tasks').all();
  const byStatus = {};
  TASK_FLOW.concat(['cancelled']).forEach((s) => { byStatus[s] = 0; });
  tasks.forEach((t) => { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });

  const dueSoon = tasks.filter((t) => t.plan_launch_date && t.plan_launch_date >= today
    && t.plan_launch_date <= weekEnd && ['draft', 'material', 'ready'].includes(t.status)).length;
  const overdue = tasks.filter((t) => t.plan_launch_date && t.plan_launch_date < today
    && ['draft', 'material', 'ready'].includes(t.status)).length;

  const launched = tasks.filter((t) => ['launched', 'reviewed'].includes(t.status));
  const onTime = launched.filter((t) => t.actual_launch_date && t.plan_launch_date
    && t.actual_launch_date <= t.plan_launch_date).length;

  const assets = db.prepare('SELECT status, license_to, scope FROM mkt_assets').all()
    .map((a) => ({ ...a, eff: assetStatus(a, today) }));
  const expiring = assets.filter((a) => a.eff === 'approved' && a.license_to
    && a.license_to >= today && a.license_to <= addDays(today, 30)).length;

  const campaigns = listCampaigns({});
  const running = campaigns.filter((c) => ['approved', 'running'].includes(c.status));
  const overBudget = campaigns.filter((c) => ['running', 'billed'].includes(c.status) && c.over_budget);
  const spendByCur = {};
  campaigns.filter((c) => c.status !== 'cancelled' && c.status !== 'draft').forEach((c) => {
    spendByCur[c.currency] = r2((spendByCur[c.currency] || 0) + c.actual_amount);
  });

  const reviews = listReviews({});
  const openReviews = reviews.filter((r) => ['open', 'doing'].includes(r.status)).length;
  const overdueActions = reviews.reduce((s, r) => s + r.overdue_cnt, 0);

  return {
    tasks: {
      total: tasks.length,
      by_status: byStatus,
      due_soon_7d: dueSoon,
      overdue,
      launched: launched.length,
      on_time: onTime,
      launch_rate: launched.length ? Math.round((onTime / launched.length) * 1000) / 10 : null
    },
    assets: {
      total: assets.length,
      approved: assets.filter((a) => a.eff === 'approved').length,
      pending: assets.filter((a) => a.eff === 'pending').length,
      draft: assets.filter((a) => a.eff === 'draft').length,
      expired: assets.filter((a) => a.eff === 'expired').length,
      exclusive: assets.filter((a) => a.scope === 'exclusive').length,
      expiring_30d: expiring
    },
    campaigns: {
      total: campaigns.length,
      running: running.length,
      over_budget: overBudget.length,
      over_budget_names: overBudget.map((c) => c.name),
      spend_by_currency: spendByCur
    },
    reviews: {
      total: reviews.length,
      open: openReviews,
      overdue_actions: overdueActions,
      closure_rate: reviews.length
        ? Math.round((reviews.filter((r) => r.status === 'done').length / reviews.length) * 1000) / 10 : null
    },
    today
  };
}

/** 上新达成率：按月上/按渠道 */
function reportLaunch(q = {}) {
  const rows = db.prepare(
    `SELECT * FROM mkt_tasks WHERE status IN ('launched','reviewed') ORDER BY actual_launch_date`
  ).all();
  const group = (keyFn) => {
    const m = {};
    rows.forEach((t) => {
      const k = keyFn(t) || '(未填)';
      m[k] = m[k] || { key: k, planned: 0, launched: 0, on_time: 0, delayed: 0, delay_days: 0 };
      m[k].planned++;
      m[k].launched++;
      const d = t.actual_launch_date && t.plan_launch_date ? daysBetween(t.plan_launch_date, t.actual_launch_date) : null;
      if (d === null) return;
      if (d <= 0) m[k].on_time++;
      else { m[k].delayed++; m[k].delay_days += d; }
    });
    return Object.values(m).map((x) => ({
      ...x,
      on_time_rate: x.launched ? Math.round((x.on_time / x.launched) * 1000) / 10 : null,
      avg_delay: x.delayed ? Math.round((x.delay_days / x.delayed) * 10) / 10 : 0
    })).sort((a, b) => String(b.key).localeCompare(String(a.key)));
  };
  const pending = db.prepare("SELECT COUNT(*) c FROM mkt_tasks WHERE status IN ('draft','material','ready')").get().c;
  const plannedMonth = isPeriod(q.month) ? q.month : null;
  const monthRows = plannedMonth
    ? db.prepare("SELECT * FROM mkt_tasks WHERE substr(COALESCE(plan_launch_date,''),1,7)=?").all(plannedMonth)
    : [];
  return {
    month: plannedMonth,
    by_month: group((t) => String(t.actual_launch_date || '').slice(0, 7)),
    by_channel: group((t) => t.channel),
    pending,
    month_plan: plannedMonth ? {
      planned: monthRows.length,
      launched: monthRows.filter((t) => ['launched', 'reviewed'].includes(t.status)).length,
      cancelled: monthRows.filter((t) => t.status === 'cancelled').length,
      rate: monthRows.length
        ? Math.round((monthRows.filter((t) => ['launched', 'reviewed'].includes(t.status)).length / monthRows.length) * 1000) / 10
        : null
    } : null
  };
}

/** 活动效果：按币种分组，绝不做跨币种合计 */
function reportCampaign() {
  const list = listCampaigns({});
  const byCur = {};
  list.filter((c) => c.status !== 'draft' && c.status !== 'cancelled').forEach((c) => {
    byCur[c.currency] = byCur[c.currency] || {
      currency: c.currency, budget: 0, actual: 0, revenue: 0, revenue_cny: 0, gross_cny: 0, orders: 0, cnt: 0
    };
    const g = byCur[c.currency];
    g.budget = r2(g.budget + c.budget_amount);
    g.actual = r2(g.actual + c.actual_amount);
    g.revenue = r2(g.revenue + c.attributed_revenue);
    g.revenue_cny = r2(g.revenue_cny + c.attributed_revenue_cny);
    g.gross_cny = r2(g.gross_cny + c.attributed_gross_cny);
    g.orders += c.attributed_orders;
    g.cnt++;
  });
  Object.values(byCur).forEach((g) => {
    g.roas = g.actual > 0 ? Math.round((g.revenue / g.actual) * 100) / 100 : null;
    g.over_budget = g.actual > g.budget;
    g.roi_cny = g.actual > 0 && g.currency !== 'CNY'
      ? null : (g.actual > 0 ? Math.round(((g.revenue_cny - g.actual) / g.actual) * 1000) / 10 : null);
  });
  return {
    currencies: Object.values(byCur).sort((a, b) => a.currency.localeCompare(b.currency)),
    campaigns: list,
    note: '不同币种不做合计；归因收入是订单金额，不等于净利润，毛利仅供参考'
  };
}

function reportReview() {
  const list = listReviews({});
  const byCat = {};
  list.forEach((r) => {
    const k = r.category || 'other';
    byCat[k] = byCat[k] || { key: k, label: REVIEW_CATEGORY[k] || k, cnt: 0, done: 0, actions: 0, overdue: 0 };
    byCat[k].cnt++;
    if (r.status === 'done') byCat[k].done++;
    byCat[k].actions += r.action_cnt;
    byCat[k].overdue += r.overdue_cnt;
  });
  const actions = db.prepare('SELECT status, due_date FROM mkt_review_actions').all();
  return {
    reviews: list,
    by_category: Object.values(byCat).sort((a, b) => b.cnt - a.cnt),
    actions: {
      total: actions.length,
      done: actions.filter((a) => a.status === 'done').length,
      cancelled: actions.filter((a) => a.status === 'cancelled').length,
      open: actions.filter((a) => ['pending', 'doing'].includes(a.status)).length,
      overdue: actions.filter((a) => ['pending', 'doing'].includes(a.status) && a.due_date < localDate()).length,
      close_rate: actions.length
        ? Math.round((actions.filter((a) => ['done', 'cancelled'].includes(a.status)).length / actions.length) * 1000) / 10
        : null
    }
  };
}

function dict() {
  const today = localDate();
  return {
    today,
    channels: db.prepare(
      `SELECT DISTINCT channel AS v FROM mkt_tasks WHERE channel IS NOT NULL AND channel<>''
       UNION SELECT DISTINCT shop_name FROM orders WHERE shop_name IS NOT NULL AND shop_name<>''
       ORDER BY v`
    ).all().map((r) => r.v),
    companies: db.prepare("SELECT id, code, name, type FROM companies WHERE status='active' ORDER BY id").all(),
    customers: db.prepare("SELECT id, code, name FROM customers WHERE status='active' ORDER BY name LIMIT 200").all(),
    task_status: TASK_FLOW.concat(['cancelled']).map((k) => ({ key: k, label: TASK_LABEL[k] })),
    asset_kind: Object.entries(ASSET_KIND_LABEL).map(([k, v]) => ({ key: k, label: v })),
    asset_scope: Object.entries(ASSET_SCOPE_LABEL).map(([k, v]) => ({ key: k, label: v })),
    asset_status: Object.entries(ASSET_STATUS_LABEL).map(([k, v]) => ({ key: k, label: v })),
    license_source: Object.entries(LICENSE_LABEL).map(([k, v]) => ({ key: k, label: v })),
    campaign_status: CAMP_FLOW.map((k) => ({ key: k, label: CAMP_LABEL[k] })),
    bill_source: Object.entries(BILL_SOURCE_LABEL).map(([k, v]) => ({ key: k, label: v })),
    review_status: Object.keys(REVIEW_LABEL).map((k) => ({ key: k, label: REVIEW_LABEL[k] })),
    review_category: Object.entries(REVIEW_CATEGORY).map(([k, v]) => ({ key: k, label: v })),
    currencies: CURRENCIES
  };
}

module.exports = {
  // 任务
  listTasks, getTask, createTask, updateTask, advanceTask, deleteTask,
  addStep, setStep, calendar,
  // 素材
  listAssets, getAsset, createAsset, updateAsset, submitAsset, reviewAsset, revokeAsset,
  bindAsset, unbindAsset, deleteAsset, sweepExpired, assetStatus, assetBlockReason,
  // 活动
  listCampaigns, getCampaign, createCampaign, updateCampaign, approveCampaign, advanceCampaign, addBill,
  attributionOf,
  // 复盘
  listReviews, getReview, createReview, addReviewAction, setReviewAction, advanceReview,
  // 汇总
  overview, reportLaunch, reportCampaign, reportReview, dict,
  // 常量
  TASK_LABEL, CAMP_LABEL, REVIEW_LABEL, REVIEW_CATEGORY, DEFAULT_STEPS
};
