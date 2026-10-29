/**
 * 首件确认与工位工艺（对应原型 TS-N08-03）
 * ------------------------------------------------------------------
 * 流程：接收正式资料 → 制作首件 → 按冻结标准测量 → 异常交总部技术 → 质量限定放行
 *
 * 硬规则（写在代码里）：
 *   1) 首件只能按「冻结版」做：必须引用一张 status=confirmed 的技术版，并把版本号快照下来；
 *      订单一旦改版，旧首件自动失效（stale），不能拿来放行。
 *   2) 尺寸项必须有实测值，不许空着提交；关键项（critical）有 NG 一律不许放行。
 *   3) 有非关键项 NG 时只能走「限定放行」并写明限定条件，或者退回销售/总部技术。
 *   4) 首件发现资料不全 / 不可制造，退回销售或总部技术，工厂不得自行改版、不得替客户确认变更。
 *   5) 复核放行人与首件制作人不能是同一个人（admin 除外），避免自己测自己放。
 *   6) 放行量不能超过本批件数；放行量为 0 等于没有放行。
 *   7) 没有有效放行首件的订单，缝制及之后工序不允许报工（批量投产门禁）。
 */
const express = require('express');

const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { findByCode } = require('../services/nodeFlow');

const router = express.Router();
const WRITE = ['admin', 'production', 'tech', 'sales'];   // 登记首件 / 填测量
const RELEASE = ['admin', 'production', 'tech'];          // 质量复核放行 / 退回

const int = (v) => Math.round(Number(v) || 0);
const num = (v) => Math.round((Number(v) || 0) * 100) / 100;

const STATUS = {
  draft: '草稿',
  submitted: '待复核',
  passed: '已放行',
  conditional: '限定放行',
  rejected: '不合格退回'
};
const KIND = { size: '尺寸', craft: '关键工艺', look: '外观' };
const RETURN_TO = { sales: '退回销售', tech: '退回总部技术' };

/** 缝制及之后工序：首件放行才允许报工 */
const PRE_NODES = ['备料', '排版算料', '裁剪'];

/** 工位默认映射：按工序名给一个可改的默认工位 */
const WS_DEFAULT = {
  备料: 'W-01 备料区',
  排版算料: 'W-02 排版房',
  裁剪: 'W-03 裁床',
  车缝: 'W-04 车缝一组',
  锁眼钉扣: 'W-05 锁眼钉扣位',
  整烫: 'W-06 整烫台',
  水洗: 'W-07 水洗间',
  印花: 'W-08 印花位',
  绣花: 'W-09 绣花位',
  检验: 'W-10 检验台',
  包装: 'W-11 包装位',
  成品入库: 'W-12 成品仓',
  出库发运: 'W-13 发运区'
};
/** 默认关键工序：首件必检 */
const CRITICAL_NODES = ['车缝', '锁眼钉扣', '印花', '绣花', '水洗', '整烫'];

/* ---------------- 基础工具 ---------------- */

function nextFaNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const row = db.prepare('SELECT fa_no FROM first_articles WHERE fa_no LIKE ? ORDER BY id DESC LIMIT 1').get(`FA${ymd}%`);
  const seq = row ? Number(String(row.fa_no).slice(-4)) + 1 : 1;
  return genNo('FA', seq);
}

function orderQty(orderId) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(s.qty),0) AS q FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?'
  ).get(orderId);
  return int(r.q);
}

/** 当前冻结版：该订单最新一张已确认技术版 */
function frozenTechpack(orderId) {
  return db.prepare(
    "SELECT * FROM tech_packs WHERE order_id = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 1"
  ).get(orderId);
}

/** 首件是否已失效：引用的技术版不是当前冻结版（改版了） */
function staleOf(fa) {
  if (!fa.tech_pack_id) return { stale: 1, reason: '首件单没有引用技术版，无法证明是按冻结版做的' };
  const tp = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(fa.tech_pack_id);
  if (!tp) return { stale: 1, reason: '引用的技术版已被删除' };
  if (tp.status !== 'confirmed') return { stale: 1, reason: `引用的技术版 ${tp.version} 当前不是确认状态` };
  const cur = frozenTechpack(fa.order_id);
  if (cur && cur.id !== fa.tech_pack_id) {
    return { stale: 1, reason: `订单已改版到 ${cur.version}（技术版 #${cur.id}），本首件是按 ${fa.tech_pack_version || '旧版'} 做的，必须按新版重做` };
  }
  return { stale: 0, reason: null };
}

/**
 * 批量投产门禁：有没有一张「有效且放行量 > 0」的首件单
 * 供报工（reports.js）与前端调用
 */
function faGate(orderId) {
  const rows = db.prepare(
    "SELECT * FROM first_articles WHERE order_id = ? AND status IN ('passed','conditional') ORDER BY id DESC"
  ).all(orderId);
  if (rows.length) {
    for (const fa of rows) {
      if (int(fa.release_qty) <= 0) continue;
      const s = staleOf(fa);
      if (s.stale) continue;
      return { ok: true, fa, reason: null };
    }
    const s = staleOf(rows[0]);
    return {
      ok: false,
      reason: s.stale ? `已放行的首件失效：${s.reason}` : `首件单 ${rows[0].fa_no} 放行量为 0，等于没有放行`
    };
  }
  const any = db.prepare('SELECT * FROM first_articles WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId);
  if (any) {
    return {
      ok: false,
      reason: `首件单 ${any.fa_no} 现在是「${STATUS[any.status] || any.status}」，还没放行。质检复核放行后才能批量投产`
    };
  }
  return {
    ok: false,
    reason: '这单还没有做首件。按冻结版做首件、测尺寸、验关键工艺，质检复核放行后才能批量投产'
  };
}

/* ---------------- 视图组装 ---------------- */

function checkList(faId) {
  return db.prepare('SELECT * FROM first_article_checks WHERE fa_id = ? ORDER BY seq, id').all(faId).map((c) => ({
    ...c,
    kind_label: KIND[c.kind] || c.kind,
    result_label: c.result === 'ok' ? '合格' : c.result === 'ng' ? '不合格' : '未测'
  }));
}

function view(fa) {
  if (!fa) return null;
  const checks = checkList(fa.id);
  const s = staleOf(fa);
  const tp = fa.tech_pack_id ? db.prepare('SELECT id, version, status, product_name FROM tech_packs WHERE id = ?').get(fa.tech_pack_id) : null;
  const cur = frozenTechpack(fa.order_id);
  const sizeN = checks.filter((c) => c.kind === 'size').length;
  const craftN = checks.filter((c) => c.kind === 'craft').length;
  const done = checks.filter((c) => c.result).length;
  const ng = checks.filter((c) => c.result === 'ng');
  const ngCritical = ng.filter((c) => c.critical);
  return {
    ...fa,
    checks,
    tech_pack: tp || null,
    current_tech_pack: cur ? { id: cur.id, version: cur.version } : null,
    status_label: STATUS[fa.status] || fa.status,
    return_to_label: fa.return_to ? RETURN_TO[fa.return_to] : null,
    stale: s.stale,
    stale_reason: s.reason,
    sum: {
      total: checks.length,
      size: sizeN,
      craft: craftN,
      done,
      undone: checks.length - done,
      ok: checks.filter((c) => c.result === 'ok').length,
      ng: ng.length,
      ng_critical: ngCritical.length
    },
    // 能否提交复核：至少 1 项，且全部有结论与实测
    can_submit: checks.length > 0 && checks.every((c) => c.result && String(c.measured || '').trim() !== ''),
    // 能否放行：待复核 + 无关键项 NG + 未失效
    can_release: fa.status === 'submitted' && ngCritical.length === 0 && !s.stale,
    // 有非关键 NG 时只能限定放行
    must_limit: fa.status === 'submitted' && ngCritical.length === 0 && ng.length > 0,
    batch_qty: int(fa.batch_qty),
    order_qty: orderQty(fa.order_id)
  };
}

function detail(id) {
  const fa = db.prepare('SELECT * FROM first_articles WHERE id = ?').get(id);
  return view(fa);
}

/* ---------------- 工位工艺 ---------------- */

function wsList(orderId) {
  return db.prepare('SELECT * FROM workstation_crafts WHERE order_id = ? ORDER BY seq, id').all(orderId);
}

/** 从工序 + 技术版工艺要求生成工位工艺卡（已有则保留，不覆盖人工改过的） */
function generateWorkstations(orderId, user) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const tp = frozenTechpack(orderId);
  const nodes = db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(orderId);
  if (!nodes.length) return { created: 0, warnings: ['订单还没有工序节点，无法生成工位工艺'] };

  const crafts = tp
    ? db.prepare("SELECT * FROM tech_pack_requirements WHERE tech_pack_id = ? AND category = 'craft' ORDER BY sort, id").all(tp.id)
    : [];
  const orderCrafts = db.prepare('SELECT * FROM order_crafts WHERE order_id = ? ORDER BY id').all(orderId);

  const t = now();
  const warnings = [];
  if (!tp) warnings.push('订单还没有确认的技术版，工位工艺只能按标准工序生成，工艺要求需技术部补充');
  if (!crafts.length) warnings.push('技术版没有缝制工艺要求，首件核对前请技术部补全工艺说明');

  let created = 0;
  let seq = 0;
  nodes.forEach((n) => {
    seq++;
    const exist = db.prepare('SELECT 1 AS x FROM workstation_crafts WHERE order_id = ? AND node_id = ?').get(orderId, n.id);
    if (exist) return;

    // 工序对应的工艺说明：先匹配 order_crafts 同名，再退回技术版工艺要求（挂到车缝）
    const oc = orderCrafts.find((c) => c.name === n.name);
    const reqs = [];
    if (oc && oc.instruction) reqs.push(oc.instruction);
    if (n.name === '车缝' && crafts.length) reqs.push(...crafts.map((c) => c.content));

    const keyPoint = n.name === '车缝'
      ? '开筒顺直、缝份均匀、无跳针断线；首件必须核车线密度与针距'
      : n.name === '锁眼钉扣'
        ? '扣位与门襟对位、扣距一致、锁眼无毛边'
        : n.name === '裁剪'
          ? '同床缸号一致、裁片对条对格、扎号与扎包一致'
          : null;

    db.prepare(
      `INSERT INTO workstation_crafts (order_id, node_id, node_name, seq, workstation, craft_name, requirement,
        machine, key_point, std_time, critical, operator, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?)`
    ).run(
      orderId, n.id, n.name, seq, WS_DEFAULT[n.name] || `W-${String(seq).padStart(2, '0')}`,
      n.name, reqs.length ? reqs.join('；') : null,
      n.name === '车缝' ? '平车 / 包缝机 / 绷缝机' : n.name === '锁眼钉扣' ? '锁眼机 / 钉扣机' : null,
      keyPoint, 0, CRITICAL_NODES.includes(n.name) ? 1 : 0, n.operator || null, t, t
    );
    created++;
  });
  return { created, warnings };
}

/* ---------------- 接口：工位工艺 ---------------- */

router.get('/workstations', authRequired, wrap(async (req, res) => {
  const orderId = Number(req.query.order_id);
  if (!orderId) return fail(res, 400, '缺少 order_id');
  return ok(res, wsList(orderId));
}));

router.post('/workstations/generate', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const orderId = Number((req.body || {}).order_id);
  if (!orderId) return fail(res, 400, '缺少 order_id');
  const r = generateWorkstations(orderId, req.user.username);
  if (!r) return fail(res, 404, '订单不存在');
  return ok(res, { ...r, rows: wsList(orderId) });
}));

router.post('/workstations', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const orderId = Number(b.order_id);
  if (!orderId) return fail(res, 400, '缺少 order_id');
  if (!b.craft_name || !String(b.craft_name).trim()) return fail(res, 400, '请填写工序 / 工艺名称');
  const t = now();

  if (b.id) {
    const row = db.prepare('SELECT * FROM workstation_crafts WHERE id = ? AND order_id = ?').get(b.id, orderId);
    if (!row) return fail(res, 404, '工位工艺不存在');
    db.prepare(
      `UPDATE workstation_crafts SET workstation = ?, craft_name = ?, requirement = ?, machine = ?, key_point = ?,
        std_time = ?, critical = ?, operator = ?, remark = ?, updated_at = ? WHERE id = ?`
    ).run(
      b.workstation || null, String(b.craft_name).trim(), b.requirement || null, b.machine || null, b.key_point || null,
      num(b.std_time), b.critical ? 1 : 0, b.operator || null, b.remark || null, t, row.id
    );
  } else {
    const seq = int(db.prepare('SELECT COALESCE(MAX(seq),0) + 1 AS s FROM workstation_crafts WHERE order_id = ?').get(orderId).s);
    db.prepare(
      `INSERT INTO workstation_crafts (order_id, node_id, node_name, seq, workstation, craft_name, requirement,
        machine, key_point, std_time, critical, operator, status, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?, ?)`
    ).run(
      orderId, b.node_id || null, b.node_name || null, seq, b.workstation || null, String(b.craft_name).trim(),
      b.requirement || null, b.machine || null, b.key_point || null, num(b.std_time), b.critical ? 1 : 0,
      b.operator || null, b.remark || null, t, t
    );
  }
  return ok(res, wsList(orderId));
}));

router.delete('/workstations/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM workstation_crafts WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '工位工艺不存在');
  db.prepare('DELETE FROM workstation_crafts WHERE id = ?').run(row.id);
  return ok(res, wsList(row.order_id));
}));

/* ---------------- 接口：首件看板 ---------------- */

router.get('/board', authRequired, wrap(async (req, res) => {
  const { q, status } = req.query;

  // 只看还在生产链路上的订单：已分单 / 生产中 / 已入库，以及评审通过待生产的
  const orders = db.prepare(
    `SELECT o.id, o.order_no, o.style_name, o.status, o.type
     FROM orders o
     LEFT JOIN commitments c ON c.order_id = o.id
     WHERE o.status IN ('assigned','production','instock')
        OR (o.status = 'draft' AND c.review_status = 'approved')
     ORDER BY o.id DESC`
  ).all();

  const rows = orders.map((o) => {
    const fa = db.prepare('SELECT * FROM first_articles WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(o.id);
    const gate = faGate(o.id);
    const ws = wsList(o.id);
    const tp = frozenTechpack(o.id);
    const stale = fa ? staleOf(fa) : { stale: 0, reason: null };
    return {
      order_id: o.id,
      order_no: o.order_no,
      style_no: o.style_name,
      order_status: o.status,
      order_type: o.type,
      tech_pack_id: tp ? tp.id : null,
      tech_pack_version: tp ? tp.version : null,
      ws_count: ws.length,
      ws_critical: ws.filter((w) => w.critical).length,
      fa: fa ? {
        id: fa.id,
        fa_no: fa.fa_no,
        status: fa.status,
        status_label: STATUS[fa.status] || fa.status,
        tech_pack_version: fa.tech_pack_version,
        batch_qty: int(fa.batch_qty),
        release_qty: int(fa.release_qty),
        stale: stale.stale,
        stale_reason: stale.reason,
        inspected_at: fa.inspected_at,
        released_at: fa.released_at
      } : null,
      released: gate.ok,
      block_reason: gate.ok ? null : gate.reason
    };
  });

  const filtered = rows.filter((r) => {
    if (status === 'none' && r.fa) return false;
    if (status && status !== 'none' && (!r.fa || r.fa.status !== status)) return false;
    if (q) {
      const s = `${r.order_no} ${r.style_no || ''} ${r.fa ? r.fa.fa_no : ''}`;
      if (!s.includes(String(q))) return false;
    }
    return true;
  });

  const stat = {
    orders: rows.length,
    need_fa: rows.filter((r) => !r.released).length,
    no_fa: rows.filter((r) => !r.fa).length,
    draft: rows.filter((r) => r.fa && r.fa.status === 'draft').length,
    submitted: rows.filter((r) => r.fa && r.fa.status === 'submitted').length,
    passed: rows.filter((r) => r.fa && (r.fa.status === 'passed' || r.fa.status === 'conditional')).length,
    rejected: rows.filter((r) => r.fa && r.fa.status === 'rejected').length,
    stale: rows.filter((r) => r.fa && r.fa.stale).length,
    released_qty: rows.reduce((s, r) => s + (r.released && r.fa ? int(r.fa.release_qty) : 0), 0)
  };
  return ok(res, { stat, rows: filtered });
}));

/** 订单当前投产权限（供订单详情/生产页提示） */
router.get('/gate/:orderId', authRequired, wrap(async (req, res) => {
  const g = faGate(req.params.orderId);
  const latest = g.fa || db.prepare('SELECT * FROM first_articles WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(req.params.orderId);
  return ok(res, {
    released: g.ok,
    reason: g.reason,
    fa_no: latest ? latest.fa_no : null,
    status: latest ? latest.status : null,
    release_qty: g.fa ? int(g.fa.release_qty) : 0
  });
}));

/** 订单的首件单（含新建模板） */
router.get('/order/:orderId', authRequired, wrap(async (req, res) => {
  const orderId = Number(req.params.orderId);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return fail(res, 404, '订单不存在');
  const fa = db.prepare('SELECT * FROM first_articles WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId);
  const tp = frozenTechpack(orderId);
  const gate = faGate(orderId);
  return ok(res, {
    fa: fa ? detail(fa.id) : null,
    order: { id: order.id, order_no: order.order_no, style_no: order.style_name, type: order.type, status: order.status },
    tech_pack: tp ? { id: tp.id, version: tp.version, product_name: tp.product_name } : null,
    workstations: wsList(orderId),
    gate: { released: gate.ok, reason: gate.reason },
    template: {
      fa_type: 'full',
      batch_qty: orderQty(orderId),
      sample_size: null,
      status: 'draft',
      status_label: STATUS.draft
    }
  });
}));

router.get('/:id', authRequired, wrap(async (req, res) => {
  const d = detail(req.params.id);
  if (!d) return fail(res, 404, '首件单不存在');
  return ok(res, d);
}));

/* ---------------- 接口：首件单 ---------------- */

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const orderId = Number(b.order_id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return fail(res, 404, '订单不存在');

  const tp = frozenTechpack(orderId);
  if (!tp) {
    return fail(res, 400, '这单还没有已确认的技术版，不能做首件。首件是按冻结版核验，请先让总部技术把开发单确认后再来');
  }
  const open = db.prepare("SELECT * FROM first_articles WHERE order_id = ? AND status IN ('draft','submitted')").get(orderId);
  if (open) return fail(res, 400, `这单已有进行中的首件单 ${open.fa_no}（${STATUS[open.status]}），请先把这张处理完`);

  const cut = db.prepare('SELECT * FROM cut_orders WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId);
  const t = now();
  const info = db.prepare(
    `INSERT INTO first_articles (fa_no, order_id, order_no, style_no, cut_order_id, tech_pack_id, tech_pack_version,
      fa_type, batch_qty, sample_bundle_no, sample_size, scope, status, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?, ?)`
  ).run(
    nextFaNo(), orderId, order.order_no, order.style_name || null, cut ? cut.id : null,
    tp.id, tp.version, b.fa_type === 'simple' ? 'simple' : 'full',
    int(b.batch_qty) || orderQty(orderId), b.sample_bundle_no || null, b.sample_size || null,
    b.scope || null, b.remark || null, req.user.username, t, t
  );
  return ok(res, detail(Number(info.lastInsertRowid)));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const fa = db.prepare('SELECT * FROM first_articles WHERE id = ?').get(req.params.id);
  if (!fa) return fail(res, 404, '首件单不存在');
  if (fa.status === 'passed' || fa.status === 'conditional') {
    return fail(res, 400, `首件单 ${fa.fa_no} 已放行，不能改；要改只能重新做一张首件（改版也能让本单失效）`);
  }
  const b = req.body || {};
  const batch = b.batch_qty !== undefined ? int(b.batch_qty) : int(fa.batch_qty);
  if (batch <= 0) return fail(res, 400, '本批件数必须大于 0');
  const t = now();
  db.prepare(
    `UPDATE first_articles SET fa_type = ?, batch_qty = ?, sample_bundle_no = ?, sample_size = ?, scope = ?,
      conclusion = ?, evidence = ?, remark = ?, updated_at = ? WHERE id = ?`
  ).run(
    b.fa_type === 'simple' ? 'simple' : (b.fa_type === 'full' ? 'full' : fa.fa_type),
    batch, b.sample_bundle_no !== undefined ? b.sample_bundle_no : fa.sample_bundle_no,
    b.sample_size !== undefined ? b.sample_size : fa.sample_size,
    b.scope !== undefined ? b.scope : fa.scope,
    b.conclusion !== undefined ? b.conclusion : fa.conclusion,
    b.evidence !== undefined ? (typeof b.evidence === 'string' ? b.evidence : JSON.stringify(b.evidence || [])) : fa.evidence,
    b.remark !== undefined ? b.remark : fa.remark, t, fa.id
  );
  return ok(res, detail(fa.id));
}));

/** 从冻结版 + 工位工艺生成检查项（尺寸按首件尺码，工艺取关键工序） */
router.post('/:id/checks/generate', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const fa = db.prepare('SELECT * FROM first_articles WHERE id = ?').get(req.params.id);
  if (!fa) return fail(res, 404, '首件单不存在');
  if (fa.status === 'passed' || fa.status === 'conditional') return fail(res, 400, '已放行的首件不能重生成检查项');
  if (!fa.tech_pack_id) return fail(res, 400, '首件单没有引用技术版');

  const b = req.body || {};
  const replace = !!b.replace;
  const size = (b.size || fa.sample_size || '').trim();
  const warnings = [];

  // 尺寸项：技术版尺寸表按首件尺码取
  let sizes = db.prepare('SELECT * FROM tech_pack_sizes WHERE tech_pack_id = ? ORDER BY sort, id').all(fa.tech_pack_id);
  if (!sizes.length) warnings.push('这张技术版没有成衣尺寸表，尺寸项无法生成；请退回总部技术补全尺寸与公差');
  const sizeSet = [...new Set(sizes.map((s) => s.size))];
  let useSize = size;
  if (!useSize && sizeSet.length) {
    useSize = sizeSet[0];
    warnings.push(`首件尺码未填，默认按 ${useSize} 生成尺寸项`);
  }
  if (useSize && sizeSet.length && !sizeSet.includes(useSize)) {
    warnings.push(`技术版没有 ${useSize} 码的尺寸表（现有 ${sizeSet.join('/')}），尺寸项按现有尺码生成`);
  }
  const picked = useSize ? sizes.filter((s) => s.size === useSize) : sizes;

  // 工艺项：工位工艺里的关键工序
  const wsAll = wsList(fa.order_id);
  if (!wsAll.length) warnings.push('这单还没有工位工艺卡，关键工艺项无法生成；请先「从工序生成工位工艺」');
  const wsCritical = b.include_all_craft ? wsAll : wsAll.filter((w) => w.critical);
  if (wsAll.length && !wsCritical.length) warnings.push('工位工艺里没有标记关键工序，没有生成工艺核对项');

  if (replace) db.prepare('DELETE FROM first_article_checks WHERE fa_id = ?').run(fa.id);

  const t = now();
  let seq = int(db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM first_article_checks WHERE fa_id = ?').get(fa.id).s);
  const ins = db.prepare(
    `INSERT INTO first_article_checks (fa_id, seq, kind, workstation, part, spec, tolerance, measured, result, critical, remark)
     VALUES (?,?,?,?,?,?,?, NULL, NULL, ?, NULL)`
  );

  // 首件尺寸全测全关键：超差就是不合格，不能靠「非关键」放过
  picked.forEach((s) => {
    seq++;
    ins.run(fa.id, seq, 'size', null, s.part, s.value, s.tolerance || null, 1);
  });
  wsCritical.forEach((w) => {
    seq++;
    ins.run(fa.id, seq, 'craft', w.workstation || null, w.craft_name,
      w.requirement || w.key_point || '按工艺要求执行', null, w.critical ? 1 : 0);
  });

  // 外观项（全项首件才有）：轻微瑕疵可限定放行，故非关键
  if (fa.fa_type !== 'simple') {
    seq++;
    ins.run(fa.id, seq, 'look', null, '外观与标识', '无色差、无线头、洗水标/烫画标内容与客户指定一致', null, 0);
  }

  db.prepare('UPDATE first_articles SET sample_size = ?, updated_at = ? WHERE id = ?').run(useSize || null, t, fa.id);
  const d = detail(fa.id);
  return ok(res, { ...d, warnings, generated: d.checks.length });
}));

/** 保存单条检查项（实测 / 结论 / 备注） */
router.post('/:id/checks', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const fa = db.prepare('SELECT * FROM first_articles WHERE id = ?').get(req.params.id);
  if (!fa) return fail(res, 404, '首件单不存在');
  if (fa.status === 'passed' || fa.status === 'conditional') return fail(res, 400, '已放行的首件不能再改检查项');
  const b = req.body || {};

  if (b.id) {
    const row = db.prepare('SELECT * FROM first_article_checks WHERE id = ? AND fa_id = ?').get(b.id, fa.id);
    if (!row) return fail(res, 404, '检查项不存在');
    const result = b.result === '' ? null : (b.result || row.result);
    if (result && !['ok', 'ng'].includes(result)) return fail(res, 400, '结论只能是合格或不合格');
    db.prepare(
      'UPDATE first_article_checks SET measured = ?, result = ?, remark = ?, checked_by = ?, checked_at = ? WHERE id = ?'
    ).run(
      b.measured !== undefined ? b.measured : row.measured, result,
      b.remark !== undefined ? b.remark : row.remark, req.user.username, now(), row.id
    );
  } else {
    if (!b.part || !String(b.part).trim()) return fail(res, 400, '请填写部位 / 检查项');
    const seq = int(db.prepare('SELECT COALESCE(MAX(seq),0) + 1 AS s FROM first_article_checks WHERE fa_id = ?').get(fa.id).s);
    db.prepare(
      `INSERT INTO first_article_checks (fa_id, seq, kind, workstation, part, spec, tolerance, measured, result, critical, remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      fa.id, seq, b.kind || 'size', b.workstation || null, String(b.part).trim(), b.spec || null,
      b.tolerance || null, b.measured || null, b.result || null, b.critical ? 1 : 0, b.remark || null
    );
  }
  return ok(res, detail(fa.id));
}));

router.delete('/:id/checks/:cid', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const fa = db.prepare('SELECT * FROM first_articles WHERE id = ?').get(req.params.id);
  if (!fa) return fail(res, 404, '首件单不存在');
  if (fa.status === 'passed' || fa.status === 'conditional') return fail(res, 400, '已放行的首件不能再改检查项');
  const row = db.prepare('SELECT * FROM first_article_checks WHERE id = ? AND fa_id = ?').get(req.params.cid, fa.id);
  if (!row) return fail(res, 404, '检查项不存在');
  db.prepare('DELETE FROM first_article_checks WHERE id = ?').run(row.id);
  return ok(res, detail(fa.id));
}));

/** 提交复核：所有项都要有实测与结论 */
router.post('/:id/submit', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const fa = db.prepare('SELECT * FROM first_articles WHERE id = ?').get(req.params.id);
  if (!fa) return fail(res, 404, '首件单不存在');
  if (fa.status !== 'draft' && fa.status !== 'rejected') {
    return fail(res, 400, `首件单当前是「${STATUS[fa.status]}」，不能重复提交`);
  }
  const s = staleOf(fa);
  if (s.stale) return fail(res, 400, `首件已失效：${s.reason}。请按当前冻结版重做`);

  const checks = db.prepare('SELECT * FROM first_article_checks WHERE fa_id = ?').all(fa.id);
  if (!checks.length) return fail(res, 400, '还没有检查项，请先「按技术版生成检查项」或手工添加');
  const noResult = checks.filter((c) => !c.result);
  if (noResult.length) {
    const names = noResult.slice(0, 4).map((c) => c.part).join('、');
    return fail(res, 400, `还有 ${noResult.length} 项没有结论（${names}${noResult.length > 4 ? '…' : ''}），测完再提交`);
  }
  const noMeasured = checks.filter((c) => !String(c.measured || '').trim());
  if (noMeasured.length) {
    const names = noMeasured.slice(0, 4).map((c) => c.part).join('、');
    return fail(res, 400, `还有 ${noMeasured.length} 项没填实测（${names}${noMeasured.length > 4 ? '…' : ''}），空着不能提交复核`);
  }

  const t = now();
  db.prepare("UPDATE first_articles SET status = 'submitted', inspector = ?, inspected_at = ?, return_to = NULL, return_reason = NULL, updated_at = ? WHERE id = ?")
    .run(req.user.username, t, t, fa.id);
  return ok(res, detail(fa.id));
}));

/**
 * 质量复核放行
 * body: { result: 'passed' | 'conditional', release_qty, limit_note, conclusion }
 */
router.post('/:id/release', authRequired, requireRole(RELEASE), wrap(async (req, res) => {
  const fa = db.prepare('SELECT * FROM first_articles WHERE id = ?').get(req.params.id);
  if (!fa) return fail(res, 404, '首件单不存在');
  if (fa.status !== 'submitted') return fail(res, 400, `首件单当前是「${STATUS[fa.status]}」，只有「待复核」才能放行`);
  const s = staleOf(fa);
  if (s.stale) return fail(res, 400, `首件已失效：${s.reason}。改版后必须按新版重做首件`);

  // 自己测自己放不行
  if (fa.inspector && fa.inspector === req.user.username && req.user.role !== 'admin') {
    return fail(res, 400, `首件由 ${fa.inspector} 制作并测量，不能自己复核放行；请换质量/生产负责人复核（admin 可代放）`);
  }

  const checks = db.prepare('SELECT * FROM first_article_checks WHERE fa_id = ?').all(fa.id);
  const ngCritical = checks.filter((c) => c.result === 'ng' && c.critical);
  if (ngCritical.length) {
    const names = ngCritical.map((c) => `${c.part}（${c.spec || '关键项'}）`).join('、');
    return fail(res, 400, `关键项不合格：${names}。关键项 NG 不能放行，请修改后重做首件，或退回总部技术/销售处理`);
  }
  const ng = checks.filter((c) => c.result === 'ng');

  const b = req.body || {};
  const result = b.result === 'conditional' ? 'conditional' : 'passed';
  if (result === 'passed' && ng.length) {
    return fail(res, 400, `还有 ${ng.length} 项非关键项不合格（${ng.map((c) => c.part).join('、')}），不能「合格放行」；请走「限定放行」并写明限定条件，或退回处理`);
  }
  if (result === 'conditional' && !String(b.limit_note || '').trim()) {
    return fail(res, 400, '限定放行必须写明限定条件（例如：仅放行 XS 码 45 件，领口罗纹待客户确认后执行）');
  }

  const batch = int(fa.batch_qty);
  const qty = b.release_qty !== undefined ? int(b.release_qty) : batch;
  if (qty <= 0) return fail(res, 400, '放行量必须大于 0，放行量为 0 等于没有放行');
  if (batch > 0 && qty > batch) return fail(res, 400, `放行量 ${qty} 件超过本批 ${batch} 件，不能超批放行`);

  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE first_articles SET status = ?, release_qty = ?, limit_note = ?, conclusion = ?,
        released_by = ?, released_at = ?, updated_at = ? WHERE id = ?`
    ).run(
      result, qty, result === 'conditional' ? String(b.limit_note).trim() : null,
      b.conclusion !== undefined ? b.conclusion : (result === 'passed' ? '首件合格，全批放行' : '首件限定放行'),
      req.user.username, t, t, fa.id
    );

    // 数据流转：首件放行 → 生产工序节点写备注，生产页/报工可见
    // 按 code 找「车缝」节点：业务把它改名叫「缝制」「车工」都不影响这里回写
    const node = findByCode(fa.order_id, 'sew');
    if (node) {
      db.prepare("UPDATE order_nodes SET remark = COALESCE(remark,'') || ? WHERE id = ?")
        .run(` [首件 ${fa.fa_no} ${result === 'passed' ? '合格放行' : '限定放行'} ${qty} 件，按 ${fa.tech_pack_version} 版]`, node.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `放行失败：${e.message}`);
  }
  return ok(res, detail(fa.id));
}));

/** 不合格退回：退回销售 / 总部技术，工厂不自行改版 */
router.post('/:id/reject', authRequired, requireRole(RELEASE), wrap(async (req, res) => {
  const fa = db.prepare('SELECT * FROM first_articles WHERE id = ?').get(req.params.id);
  if (!fa) return fail(res, 404, '首件单不存在');
  if (fa.status === 'passed' || fa.status === 'conditional') return fail(res, 400, '已放行的首件不能退回');
  const b = req.body || {};
  const to = b.return_to === 'tech' ? 'tech' : 'sales';
  const reason = String(b.reason || '').trim();
  if (!reason) return fail(res, 400, '退回必须写明原因（缺资料 / 不可制造 / 与客户要求不符…），方便对方改');

  const t = now();
  db.prepare(
    "UPDATE first_articles SET status = 'rejected', release_qty = 0, return_to = ?, return_reason = ?, released_by = ?, released_at = ?, updated_at = ? WHERE id = ?"
  ).run(to, reason, req.user.username, t, t, fa.id);

  // 数据流转：首件退回 → 订单节点留痕，技术/销售在开发单侧看到
  const node = findByCode(fa.order_id, 'sew');
  if (node) {
    db.prepare("UPDATE order_nodes SET remark = COALESCE(remark,'') || ? WHERE id = ?")
      .run(` [首件 ${fa.fa_no} ${RETURN_TO[to]}：${reason}]`, node.id);
  }
  return ok(res, { ...detail(fa.id), returned_to: RETURN_TO[to] });
}));

/** 退回后重做：回到草稿，保留原检查项，方便按新资料改 */
router.post('/:id/reopen', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const fa = db.prepare('SELECT * FROM first_articles WHERE id = ?').get(req.params.id);
  if (!fa) return fail(res, 404, '首件单不存在');
  if (fa.status !== 'rejected') return fail(res, 400, `只有「不合格退回」的首件才能重做，当前是「${STATUS[fa.status]}」`);
  const s = staleOf(fa);
  const t = now();
  db.prepare("UPDATE first_articles SET status = 'draft', release_qty = 0, updated_at = ? WHERE id = ?").run(t, fa.id);
  return ok(res, { ...detail(fa.id), stale_reason: s.stale ? s.reason : null });
}));

/**
 * 改版失效后按新冻结版重做：自动指向当前冻结版 + 重生成检查项
 */
router.post('/:id/refresh-version', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const fa = db.prepare('SELECT * FROM first_articles WHERE id = ?').get(req.params.id);
  if (!fa) return fail(res, 404, '首件单不存在');
  const tp = frozenTechpack(fa.order_id);
  if (!tp) return fail(res, 400, '这单没有已确认的技术版，无法指向新版');
  if (tp.id === fa.tech_pack_id) return fail(res, 400, '首件已经指向当前冻结版，不需要刷新');

  const t = now();
  db.prepare(
    "UPDATE first_articles SET tech_pack_id = ?, tech_pack_version = ?, status = 'draft', release_qty = 0, released_by = NULL, released_at = NULL, updated_at = ? WHERE id = ?"
  ).run(tp.id, tp.version, t, fa.id);
  db.prepare('DELETE FROM first_article_checks WHERE fa_id = ?').run(fa.id);
  return ok(res, { ...detail(fa.id), refreshed_to: tp.version });
}));

module.exports = router;
module.exports.faGate = faGate;
module.exports.PRE_NODES = PRE_NODES;
module.exports.staleOf = staleOf;
