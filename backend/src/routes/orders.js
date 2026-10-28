/**
 * 销售订单（定制/现货）
 * 结构：订单 → 款(order_items) → 颜色(order_item_sizes.color) → 尺码(数量/美金单价)
 * 美金计价，汇率取后台设置（默认6.5），自动折人民币
 */
const express = require('express');
const { localTime } = require('../utils/time');
const { db, now, getSettings } = require('../db');
const { ensureNodes } = require('../services/production');
const { applyStock, addLedger } = require('../services/stockOps');
const { notifyOrderStatus } = require('../services/mall');
const { sealGate } = require('./confirm');
const { STAGE_LABELS } = require('./patternFlows');
const { openARForOrder } = require('./finance');
const { ensureCostObject, collectAuto, syncSold } = require('./costObjects');
const { ensureCommitment } = require('./commitments');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

const STATUS_LABELS = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};
const FLOW = {
  draft: ['tech'], tech: ['finance'], finance: ['assigned'], assigned: ['production'],
  production: ['instock'], instock: ['shipped'], shipped: ['closed']
};
/** 正向链路：反审只能往前面的状态退，不能跨过 draft，也不能退已发货/已结案 */
const CHAIN = ['draft', 'tech', 'finance', 'assigned', 'production', 'instock', 'shipped', 'closed'];
const TRANSITION_ROLES = {
  tech: ['admin', 'sales', 'tech'], finance: ['admin', 'sales', 'tech'], assigned: ['admin', 'finance'],
  production: ['admin', 'sales', 'production'], instock: ['admin', 'production', 'warehouse'],
  shipped: ['admin', 'warehouse'], closed: ['admin', 'sales'], cancelled: ['admin', 'sales']
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 把尺码行按颜色分组 */
function groupByColor(sizes) {
  const map = new Map();
  for (const s of sizes) {
    const c = s.color || '';
    if (!map.has(c)) map.set(c, { color: c, qty: 0, amount_usd: 0, amount_cny: 0, sizes: [] });
    const g = map.get(c);
    g.qty += Number(s.qty) || 0;
    g.amount_usd += Number(s.amount_usd) || 0;
    g.amount_cny += Number(s.amount_cny) || 0;
    g.sizes.push(s);
  }
  return [...map.values()].map((g) => ({
    ...g,
    amount_usd: round2(g.amount_usd),
    amount_cny: round2(g.amount_cny)
  }));
}

function getOrderFull(id) {
  const order = db.prepare(
    `SELECT o.*, c.name AS customer_name FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).get(id);
  if (!order) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  const sizeStmt = db.prepare('SELECT * FROM order_item_sizes WHERE item_id = ? ORDER BY id');
  order.items = items.map((it) => {
    const sizes = sizeStmt.all(it.id);
    return { ...it, sizes, colors: groupByColor(sizes) };
  });
  order.logs = db.prepare('SELECT * FROM order_logs WHERE order_id = ? ORDER BY id').all(id);
  order.crafts = db.prepare('SELECT * FROM order_crafts WHERE order_id = ? ORDER BY id').all(id);
  return order;
}

// ---------- 列表 ----------
router.get('/', authRequired, wrap(async (req, res) => {
  const { q = '', status = '', type = '' } = req.query;
  const where = [];
  const params = [];
  if (q) { where.push('(o.order_no LIKE ? OR c.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (type) { where.push('o.type = ?'); params.push(type); }
  const sql = `SELECT o.*, c.name AS customer_name FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY o.id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

// ---------- 状态机元数据 ----------
router.get('/meta', authRequired, wrap(async (req, res) => {
  return ok(res, { labels: STATUS_LABELS, flow: FLOW, roles: TRANSITION_ROLES, rate: getSettings().exchangeRate });
}));

// ---------- 工作台统计 ----------
router.get('/stats/summary', authRequired, wrap(async (req, res) => {
  const customers = Number(db.prepare('SELECT COUNT(*) AS c FROM customers').get().c);
  const products = Number(db.prepare('SELECT COUNT(*) AS c FROM products').get().c);
  const orders = Number(db.prepare('SELECT COUNT(*) AS c FROM orders').get().c);
  const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM orders GROUP BY status').all();
  const amount = db.prepare('SELECT COALESCE(SUM(total_amount),0) AS s FROM orders').get().s;
  const usd = db.prepare('SELECT COALESCE(SUM(total_usd),0) AS s FROM orders').get().s;
  return ok(res, { customers, products, orders, byStatus, totalAmount: Number(amount), totalUsd: Number(usd) });
}));

// ---------- 导出 CSV（Excel 可直接打开） ----------
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/export', authRequired, wrap(async (req, res) => {
  const { q = '', status = '', type = '' } = req.query;
  const where = [];
  const params = [];
  if (q) { where.push('(o.order_no LIKE ? OR c.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (type) { where.push('o.type = ?'); params.push(type); }
  const sql = `SELECT o.*, c.name AS customer_name FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY o.id DESC';
  const rows = db.prepare(sql).all(...params);

  const header = ['订单号', '类型', '客户', '款名', '客户订单号', '跟单员', '下单日期', '交期', '交货方式', '贸易条款', '状态', '金额USD', '金额CNY', '创建时间'];
  const lines = [header.map(csvCell).join(',')];
  rows.forEach((o) => {
    lines.push([
      o.order_no, o.type === 'stock' ? '现货' : '定制', o.customer_name || '', o.style_name || '',
      o.cus_order_no || '', o.manager || '', o.order_date || '', o.delivery_date || '',
      o.delivery_method || '', o.trade_terms || '', STATUS_LABELS[o.status] || o.status,
      o.total_usd, o.total_amount, localTime(o.created_at)
    ].map(csvCell).join(','));
  });
  const csv = '\ufeff' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send(csv);
}));

// ---------- 扫码查询（标签码 → 订单） ----------
router.get('/find', authRequired, wrap(async (req, res) => {
  const raw = String(req.query.no || '').trim();
  if (!raw) return fail(res, 400, '请输入标签码');
  const orderNo = raw.split('-')[0];
  const order = db.prepare('SELECT id, order_no, style_name, status, customer_id FROM orders WHERE order_no = ?').get(orderNo);
  if (!order) return fail(res, 404, '未找到对应订单：' + orderNo);
  return ok(res, order);
}));

// ---------- 详情 ----------
router.get('/:id', authRequired, wrap(async (req, res) => {
  const order = getOrderFull(req.params.id);
  if (!order) return fail(res, 404, '订单不存在');
  return ok(res, order);
}));

// ---------- 新建 ----------
router.post('/', authRequired, requireRole(['admin', 'sales']), wrap(async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return fail(res, 400, '至少需要一条订单明细');

  const rate = Number(b.rate) > 0 ? Number(b.rate) : getSettings().exchangeRate;
  const type = b.type === 'stock' ? 'stock' : 'custom';

  let orderUsd = 0;
  const prepared = [];
  for (const it of items) {
    // 新结构 colors[]；兼容旧结构 sizes[]
    const colors = Array.isArray(it.colors) ? it.colors : [{ color: it.color || '', sizes: it.sizes || [] }];
    let itemQty = 0, itemUsd = 0;
    const sizeRows = [];
    for (const c of colors) {
      const colorName = c.color || '';
      const sizes = Array.isArray(c.sizes) ? c.sizes.filter((s) => Number(s.qty) > 0) : [];
      for (const s of sizes) {
        const qty = Number(s.qty) || 0;
        const usd = Number(s.usd_price) || 0;
        const amtUsd = round2(qty * usd);
        itemQty += qty;
        itemUsd += amtUsd;
        sizeRows.push({
          color: colorName,
          size: String(s.size || '均码'),
          qty,
          usd_price: usd,
          cny_price: round2(usd * rate),
          amount_usd: amtUsd,
          amount_cny: round2(qty * usd * rate)
        });
      }
    }
    if (!sizeRows.length) return fail(res, 400, `款「${it.product_name || '未命名'}」没有填写任何一个尺码的数量`);
    itemUsd = round2(itemUsd);
    orderUsd = round2(orderUsd + itemUsd);
    prepared.push({
      product_id: it.product_id || null,
      product_name: it.product_name || '未命名产品',
      style_no: it.style_no || null,
      sku: it.sku || null,
      remark: it.remark || null,
      qty: itemQty,
      amount_usd: itemUsd,
      amount_cny: round2(itemUsd * rate),
      sizeRows
    });
  }
  const orderCny = round2(orderUsd * rate);

  let seq = Number(db.prepare('SELECT COUNT(*) AS c FROM orders').get().c) + 1;
  let orderNo = genNo(type === 'stock' ? 'XS' : 'SO', seq);
  while (db.prepare('SELECT 1 AS x FROM orders WHERE order_no = ?').get(orderNo)) {
    orderNo = genNo(type === 'stock' ? 'XS' : 'SO', ++seq);
  }

  let orderId;
  db.exec('BEGIN');
  try {
    const t = now();
    const info = db.prepare(
      `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency, style_name, cus_order_no, manager, order_date, delivery_method, packaging, trade_terms, shop_name, shop_order_no, delivery_days, freight, image_url, delivery_date, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(orderNo, type, b.customer_id || null, 'draft', rate, orderUsd, orderCny, 'USD',
      b.style_name || null, b.cus_order_no || null, b.manager || null,
      b.order_date || null, b.delivery_method || null, b.packaging || null, b.trade_terms || null,
      b.shop_name || null, b.shop_order_no || null, Number(b.delivery_days) || 0, Number(b.freight) || 0,
      b.image_url || null,
      b.delivery_date || null, b.remark || null, req.user.sub, t, t);
    orderId = Number(info.lastInsertRowid);

    const insItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, product_name, style_no, sku, remark, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const insSize = db.prepare(
      'INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?)'
    );
    prepared.forEach((p) => {
      const r = insItem.run(orderId, p.product_id, p.product_name, p.style_no, p.sku, p.remark, p.qty, p.amount_usd, p.amount_cny);
      const itemId = Number(r.lastInsertRowid);
      p.sizeRows.forEach((s) =>
        insSize.run(itemId, s.color, s.size, s.qty, s.usd_price, s.cny_price, s.amount_usd, s.amount_cny)
      );
    });

    db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(orderId, null, 'draft', req.user.username, '创建订单', t);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return ok(res, getOrderFull(orderId));
}));

// ---------- 设置款图 ----------
router.post('/:id/image', authRequired, requireRole(['admin', 'sales', 'tech']), wrap(async (req, res) => {
  const { image_url } = req.body || {};
  const exists = db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(req.params.id);
  if (!exists) return fail(res, 404, '订单不存在');
  db.prepare('UPDATE orders SET image_url = ?, updated_at = ? WHERE id = ?').run(image_url || null, now(), req.params.id);
  return ok(res, { id: Number(req.params.id), image_url: image_url || null });
}));

// ---------- 状态流转 ----------
router.post('/:id/transition', authRequired, wrap(async (req, res) => {
  const id = req.params.id;
  const { to, note } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return fail(res, 404, '订单不存在');

  const cur = order.status;
  const allowedRoles = TRANSITION_ROLES[to];
  if (!allowedRoles) return fail(res, 400, '非法的目标状态');

  const isCancel = to === 'cancelled';
  const normalOk = (FLOW[cur] || []).includes(to);
  const cancelOk = isCancel && cur !== 'closed' && cur !== 'cancelled';
  if (!normalOk && !cancelOk) {
    return fail(res, 400, `订单当前为「${STATUS_LABELS[cur] || cur}」，不能流转到「${STATUS_LABELS[to] || to}」`);
  }
  if (!(req.user.role === 'admin' || allowedRoles.includes(req.user.role))) {
    return fail(res, 403, '你的角色无权执行该状态变更');
  }

  // P2 硬门槛
  if (to === 'tech') {
    // 接单评审：前端裁床 / 后端缝制 / 物料三项分别确认，未通过不得进入技术确认
    const commit = ensureCommitment(id, null, req.user.username);
    if (!commit || commit.review_status !== 'approved') {
      const why = !commit ? '还没有接单评审记录'
        : commit.review_status === 'rejected'
          ? `评审未通过（${commit.review_note || '有环节不能承接'}）`
          : '评审还没做';
      return fail(res, 400, `接单评审${commit && commit.review_status === 'rejected' ? '未通过' : '未完成'}：${why}。` +
        '请到「生产 → 接单评审与交期」确认前端裁床、后端缝制、物料齐套三项并给出承诺交期后再做技术确认');
    }

    const tp = db.prepare("SELECT id FROM tech_packs WHERE order_id = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 1").get(id);
    if (!tp) return fail(res, 400, '开发单尚未确认，无法通过「技术确认」；请先补全并确认开发单');
    // 定制单必须走完打版流程（面辅料确认 → 制版 → 工艺明细 → 车板 → 业务确认 → 工价核价）
    if (order.type === 'custom') {
      const flow = db.prepare('SELECT * FROM pattern_flows WHERE tech_pack_id = ?').get(tp.id);
      if (!flow) {
        return fail(res, 400, '定制订单必须走打版流程：该开发单还没有打版流程记录，请到「打版流程」发起');
      }
      if (flow.status !== 'done') {
        const left = db.prepare("SELECT stage FROM pattern_stages WHERE flow_id = ? AND status != 'done'").all(flow.id);
        const names = left.map((r) => STAGE_LABELS[r.stage] || r.stage).join('、');
        return fail(res, 400, `定制订单的打版流程尚未完成，剩余：${names || '收尾确认'}；请到「打版流程」完成后再做技术确认`);
      }
    }
    // 走过样衣封样的订单：最新版本必须「客户已确认 + 总部技术已批准」双确认
    const gate = sealGate(id);
    if (!gate.ok) return fail(res, 400, gate.message);
  }
  if (to === 'assigned') {
    const cs = db.prepare("SELECT 1 AS x FROM cost_sheets WHERE order_id = ? AND status = 'approved' LIMIT 1").get(id);
    if (!cs) return fail(res, 400, '财务尚未审核通过，无法「分单」；请先录入成本并完成财务审核');
  }

  // 结案前必须有财务口径：未收清的应收不允许直接结案（特殊情况传 force=true 并写备注）
  if (to === 'closed' && !(req.body && req.body.force)) {
    const ar = db.prepare("SELECT * FROM ar_invoices WHERE order_id = ? AND status != 'void'").get(id);
    if (ar) {
      const open = Math.round(((Number(ar.amount) || 0) - (Number(ar.paid_amount) || 0)) * 100) / 100;
      if (open > 0.005) {
        return fail(res, 400, `该订单还有未收金额 ${open} 元（${ar.bill_no}），收清后再结案；确需先结案请传 force=true 并说明原因`);
      }
    }
  }

  const t = now();
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(to, t, id);
  // 进入生产：自动初始化 13 道工序
  if (to === 'production') ensureNodes(id);
  // 发货：自动开应收（幂等，重复发货不会重复开票）
  if (to === 'shipped') {
    try { openARForOrder(id, req.user.username); } catch (e) { /* 开票失败不影响发货 */ }
    // 成本对象：归集物料 + 工缴 + 制造费用，并按发货数量结转已售成本
    try {
      const obj = ensureCostObject(id);
      if (obj) { collectAuto(obj); syncSold(obj.id, req.user.username); }
    } catch (e) { /* 成本归集失败不影响发货 */ }
  }
  db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, cur, to, req.user.username, note || null, t);

  // 数据流转：订单状态变化 → 客户商城站内消息（客户有商城账号才推）
  try { notifyOrderStatus(id, to, note); } catch (e) { /* 消息失败不影响主流程 */ }

  return ok(res, getOrderFull(id));
}));

// ---------- 反审退回（生产出问题 → 退回业务/技术/财务） ----------
/**
 * POST /api/orders/:id/rollback  { to, reason }
 *
 * 和正向 transition 相反：只能退到链路前面的状态，并且要把下游产生的副作用收回来。
 *  - 已入库 → 按库存流水把这一单的入库数量冲销掉（库存不足说明货已发走，直接拒绝）
 *  - 已投产 → 工序节点全部重置为待开始（保留节点本身，返工从头报）
 *  - 已发货 / 已结案 → 不允许反审，走退货流程
 * 原因必填，写进流转日志，前后状态都要留痕。
 */
router.post('/:id/rollback', authRequired, wrap(async (req, res) => {
  const id = req.params.id;
  const { to, reason } = req.body || {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return fail(res, 404, '订单不存在');

  const cur = order.status;
  if (!CHAIN.includes(cur) || !CHAIN.includes(to)) return fail(res, 400, '非法的状态');
  if (cur === 'shipped' || cur === 'closed') {
    return fail(res, 400, `订单已「${STATUS_LABELS[cur]}」，不能反审；如需退回请走退货流程`);
  }
  if (cur === 'cancelled') return fail(res, 400, '订单已取消，无需反审');
  if (CHAIN.indexOf(to) >= CHAIN.indexOf(cur)) {
    return fail(res, 400, `只能退回到「${STATUS_LABELS[cur]}」之前的环节，「${STATUS_LABELS[to]}」不在其之前`);
  }
  if (!reason || !String(reason).trim()) {
    return fail(res, 400, '请填写反审原因（会写进流转记录，方便后续追溯）');
  }
  const allowedRoles = TRANSITION_ROLES[cur] || ['admin'];
  if (!(req.user.role === 'admin' || allowedRoles.includes(req.user.role) || req.user.role === 'production')) {
    return fail(res, 403, '你的角色无权对当前环节发起反审');
  }

  const curIdx = CHAIN.indexOf(cur);
  const toIdx = CHAIN.indexOf(to);
  const effects = { stockReversed: 0, nodesReset: 0 };

  const t = now();
  db.exec('BEGIN');
  try {
    // A. 已入库：冲销这一单进到仓库的货
    if (curIdx >= CHAIN.indexOf('instock')) {
      const inRows = db.prepare(
        `SELECT warehouse, style_no, product_name, color, size, SUM(qty) AS qty
         FROM stock_ledger
         WHERE ref_type = 'order' AND ref_id = ? AND type = 'in'
         GROUP BY warehouse, style_no, product_name, color, size`
      ).all(id);
      // 出库（发货）也要算进去，净额才是当前还压在仓里的
      const outRows = db.prepare(
        `SELECT warehouse, style_no, product_name, color, size, SUM(qty) AS qty
         FROM stock_ledger
         WHERE ref_type = 'order' AND ref_id = ? AND type IN ('out','ship')
         GROUP BY warehouse, style_no, product_name, color, size`
      ).all(id);
      const outMap = new Map(outRows.map((r) => [`${r.warehouse}|${r.style_no}|${r.color}|${r.size}`, Number(r.qty) || 0]));

      for (const r of inRows) {
        const key = `${r.warehouse}|${r.style_no}|${r.color}|${r.size}`;
        const net = (Number(r.qty) || 0) - Math.abs(outMap.get(key) || 0);
        if (net === 0) continue;
        if (net < 0) throw new Error(`库存账不平：${r.product_name || r.style_no} ${r.color}/${r.size} 净额为负`);
        // 库存不足会抛错 → 整个事务回滚，不会留下半截数据
        applyStock({ warehouse: r.warehouse, style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size, delta: -net });
        addLedger({
          warehouse: r.warehouse, style_no: r.style_no, product_name: r.product_name, color: r.color, size: r.size,
          type: 'rollback', qty: -net, ref_type: 'order', ref_id: Number(id),
          remark: `反审退回（${STATUS_LABELS[to]}）：${String(reason).trim()}`,
          operator: req.user.username
        });
        effects.stockReversed += net;
      }
    }

    // B. 已投产：工序全部回到待开始，返工从头报
    if (curIdx >= CHAIN.indexOf('production') && toIdx < CHAIN.indexOf('production')) {
      const nodes = db.prepare("SELECT id FROM order_nodes WHERE order_id = ? AND status != 'pending'").all(id);
      if (nodes.length) {
        db.prepare("UPDATE order_nodes SET status='pending', actual_date=NULL, operator=NULL, remark=COALESCE(remark,'') || ? WHERE order_id = ? AND status != 'pending'")
          .run(' [反审退回作废]', id);
        effects.nodesReset = nodes.length;
      }
    }

    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(to, t, id);
    db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, cur, to, req.user.username, `[反审退回] ${String(reason).trim()}`, t);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    const msg = String(e.message || '');
    // 库存不足是最常见的拦截：货已经发走或被别的单据占用，不能凭空冲销
    if (msg.includes('库存不足')) {
      return fail(res, 400,
        `反审失败：这单的货已经部分出库或已发货（${msg}）。` +
        '请先处理对应的出库 / 退货 / 发货记录，再回来反审；' +
        '如果只是个别颜色尺码不够，也可以先只退不涉及库存的环节（如退回到「生产中」）。');
    }
    return fail(res, 400, `反审失败：${msg}`);
  }

  try { notifyOrderStatus(id, to, `反审退回：${String(reason).trim()}`); } catch (e) { /* 消息失败不影响主流程 */ }

  const full = getOrderFull(id);
  return ok(res, { order: full, effects });
}));

module.exports = router;
