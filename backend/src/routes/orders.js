/**
 * 销售订单（定制/现货）
 * 结构：订单 → 款(order_items) → 颜色(order_item_sizes.color) → 尺码(数量/美金单价)
 * 美金计价，汇率取后台设置（默认6.5），自动折人民币
 */
const express = require('express');
const { localTime } = require('../utils/time');
const { db, now, getSettings } = require('../db');
const { applyStock, addLedger } = require('../services/stockOps');
const { notifyOrderStatus } = require('../services/mall');
const { ok, fail, wrap } = require('../utils/http');
const orderSheet = require('../services/orderSheet');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();

// 状态机常量与流转实现已抽到 services/orderFlow.js —— 单张流转与批量流转必须共用同一套门槛，
// 所以这里只做转发，不再自己判断（抄一份判断，迟早出现「批量能绕过评审」的洞）
const orderFlow = require('../services/orderFlow');
// 订单号由业务手填（必填、唯一、可改但要级联同步下游）—— 规则统一在服务层，
// 这里只调用，不在这里重写一遍判断
const orderNoSvc = require('../services/orderNo');
const { STATUS_LABELS, FLOW, CHAIN, TRANSITION_ROLES } = orderFlow;

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
  // 关联采购（这张订单的料买了没有）—— 采购单那边有 order_id，这里反查，
  // 让「订单 → 采购」和「采购 → 订单」两个方向都能看，不用来回找
  order.purchases = db.prepare(`SELECT id, po_no, supplier, status, order_date, expect_date, total_amount
    FROM purchase_orders WHERE order_id = ? ORDER BY id DESC`).all(id);
  // 改号历史（没有就是空数组，前端不用判 null）
  order.order_no_logs = db.prepare('SELECT * FROM order_no_logs WHERE order_id = ? ORDER BY id DESC').all(id);
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

  // 标签码是「订单号-扎号-款号-色-码」，所以常规做法是取第一段。
  // 但**订单号自身可能含横线**（客户给的编号、历史导入的数据都常见），
  // 无脑切第一段会把 CREDITDEMO-03 切成 CREDITDEMO，扫出来是 404。
  // 所以先拿整串精确匹配，匹配不到再退化到第一段 —— 两种码都能用。
  const sel = 'SELECT id, order_no, style_name, status, customer_id FROM orders WHERE order_no = ?';
  let order = db.prepare(sel).get(raw);
  let matchedBy = 'exact';
  if (!order) {
    /**
     * 退化匹配：**从最长前缀往短试**，不是只取第一段。
     *
     * 单号从「业务手填」之后可以自己带横线（`MC-TEST-1`、客户给的 `ABC-2026-07`）。
     * 只取第一段会把 `MC-TEST-1-WY-001-110` 切成 `MC`，扫出来 404 ——
     * 而这条码本身是对的。逐段加长试，既认 `SO123-WY-001-110`，也认带横线的单号。
     */
    const parts = raw.split('-');
    for (let n = parts.length - 1; n >= 1 && !order; n -= 1) {
      const cand = parts.slice(0, n).join('-');
      if (!cand) continue;
      const hit = db.prepare(sel).get(cand);
      if (hit) { order = hit; matchedBy = 'prefix'; }
    }
  }
  if (!order) return fail(res, 404, '未找到对应订单：' + raw);
  return ok(res, { ...order, matched_by: matchedBy });
}));

// ============================================================
// 订单号：反查 / 改号 / 改号历史
//
// 全部收在 `/order-no/` 这一段下，两个原因：
//   1. **必须放在 `/:id` 之前** —— 否则 `/order-no/trace` 会被当成 id=order-no
//   2. **`GUARDED` 是前缀匹配**，只有独立路径段才能精确挂「改号」这类高危动作
//      （写成 `/:id/order-no` 无法用前缀锁，会退回到只靠路由里的 requireRole）
// ============================================================

// 反查：这个订单号现在挂着哪些单（采购、排产、领料、计件……）
router.get('/order-no/trace', authRequired, wrap(async (req, res) =>
  ok(res, orderNoSvc.trace(req.query.no))));

// 改号预览：先看清会连带改哪些表多少行，再决定按不按确认
router.get('/order-no/:id/preview', authRequired, wrap(async (req, res) =>
  ok(res, orderNoSvc.previewRename(req.params.id, req.query.no))));

// 改号历史
router.get('/order-no/:id/logs', authRequired, wrap(async (req, res) =>
  ok(res, orderNoSvc.renameLogs(req.params.id))));

/**
 * 改订单号
 *
 * 比下单更严：已经在产或已入库的单只允许管理员改，已发货/已结案/已取消一律不许改。
 * 理由不是「怕麻烦」，而是这三种状态下订单号已经出现在**系统之外**：
 * 已发货的号印在面单和客户对账单上，已结案的号进了结算，
 * 已取消的号还留着改会让历史里出现一个从没存在过的编号。
 */
router.post('/order-no/:id', authRequired, requireRole(['admin', 'sales']), wrap(async (req, res) => {
  const order = db.prepare('SELECT id, order_no, status FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return fail(res, 404, '订单不存在');
  const LOCKED = ['shipped', 'closed', 'cancelled'];
  if (LOCKED.includes(order.status)) {
    return fail(res, 400, `订单${STATUS_LABELS[order.status] || order.status}，订单号不能再改`
      + '（号已印在面单/进了结算/已作废，改了会和系统外的文件对不上）');
  }
  const inProduction = ['production', 'instock'].includes(order.status);
  if (inProduction && req.user.role !== 'admin') {
    return fail(res, 400, `订单${STATUS_LABELS[order.status]}，改订单号需要管理员操作`
      + '（车间与仓库正在按这个号找货，改号会让实物与单据对不上）');
  }
  return ok(res, orderNoSvc.rename(req.params.id, req.body && req.body.order_no, req.body || {},
    (req.user && (req.user.username || req.user.name)) || 'system'));
}));

// ---------- 详情 ----------
/**
 * 订单信息收集看板 —— 下单信息 + 打版信息合成一份
 *
 * 屏幕上的速览与纸质打印都吃这一份，避免「屏幕有、纸上没有」这种谁也发现不了的偏差。
 * `printable=1` 时额外返回可打印字段清单（打印勾选框用）。
 */
router.get('/sheet-fields', authRequired, wrap(async (req, res) =>
  ok(res, orderSheet.printableFields())));

router.get('/:id/sheet', authRequired, wrap(async (req, res) =>
  ok(res, orderSheet.sheet(req.params.id))));

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
      const colorName = String(c.color || '').trim();
      const sizes = Array.isArray(c.sizes) ? c.sizes.filter((s) => Number(s.qty) > 0) : [];
      if (sizes.length && !String(colorName).trim()) return fail(res, 400, `款「${it.product_name || '未命名'}」有数量的颜色组必须填写颜色`);
      for (const s of sizes) {
        const qty = Number(s.qty) || 0;
        const usd = Number(s.usd_price ?? 0);
        if (!Number.isFinite(usd) || usd < 0) return fail(res, 400, `款「${it.product_name || '未命名'}」有无效美金单价`);
        const sizeName = String(s.size || '').trim();
        if (!sizeName) return fail(res, 400, `款「${it.product_name || '未命名'}」有数量的尺码行必须填写尺码`);
        const amtUsd = round2(qty * usd);
        itemQty += qty;
        itemUsd += amtUsd;
        sizeRows.push({
          color: colorName,
          size: sizeName,
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

  // 订单号由业务手工填写（必填），不再自动生成。
  //
  // 之前是 genNo(SO/XS + 日期 + 序号) 自动出号，改成手填之后有三个直接后果，
  // 都在 orderNoSvc.check 里处理：
  //   1. 不能为空 —— 手填最容易出现的不是填错，而是漏填，让系统兜个号就变成两张单号体系
  //   2. 不能重号（不分大小写）—— so001 与 SO001 在人眼里是同一个号，
  //      数据库的唯一索引分大小写，兜不住这个
  //   3. 不强制格式 —— 业务填的是客户 PO / 平台单号 / 老系统流水，强制 SO 前缀等于没改
  const orderNo = orderNoSvc.check(b.order_no);

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

// ---------- 完善草稿订单的颜色尺码矩阵 ----------
router.put('/:id/items', authRequired, requireRole(['admin', 'sales']), wrap(async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return fail(res, 404, '订单不存在');
  if (order.status !== 'draft') return fail(res, 400, '订单进入技术确认后不可修改颜色尺码明细');
  if (db.prepare('SELECT 1 AS x FROM dispatch_orders WHERE order_id = ? LIMIT 1').get(order.id)) {
    return fail(res, 400, '订单已有分单记录，不可修改明细');
  }
  const input = req.body && req.body.items;
  if (!Array.isArray(input) || !input.length) return fail(res, 400, '至少保留一款订单明细');

  const rate = Number(order.rate) > 0 ? Number(order.rate) : getSettings().exchangeRate;
  const items = [];
  let orderUsd = 0;
  for (const it of input) {
    const sizes = Array.isArray(it.sizes) ? it.sizes : (Array.isArray(it.colors)
      ? it.colors.flatMap((c) => (c.sizes || []).map((s) => ({ ...s, color: c.color })))
      : []);
    const validRows = [];
    let qty = 0;
    let amountUsd = 0;
    for (const s of sizes) {
      const rowQty = Number(s.qty);
      if (!Number.isFinite(rowQty) || rowQty < 0) return fail(res, 400, `款「${it.product_name || '未命名'}」有无效数量`);
      if (rowQty === 0) continue;
      const color = String(s.color || '').trim();
      const size = String(s.size || '').trim();
      const usd = Number(s.usd_price ?? 0);
      if (!color || ['待定', '待分色', '未定'].includes(color)) return fail(res, 400, `款「${it.product_name || '未命名'}」的颜色仍未确定`);
      if (!size || ['待定', '待定尺码'].includes(size)) return fail(res, 400, `款「${it.product_name || '未命名'}」的尺码仍未确定`);
      if (!Number.isFinite(usd) || usd < 0) return fail(res, 400, `款「${it.product_name || '未命名'}」有无效单价`);
      const amount = round2(rowQty * usd);
      qty += rowQty;
      amountUsd += amount;
      validRows.push({ color, size, qty: rowQty, usd, amount });
    }
    if (!String(it.product_name || '').trim()) return fail(res, 400, '每款都必须填写产品名称');
    if (!validRows.length) return fail(res, 400, `款「${it.product_name}」没有有效的颜色尺码数量`);
    amountUsd = round2(amountUsd);
    orderUsd = round2(orderUsd + amountUsd);
    items.push({
      product_id: it.product_id || null,
      product_name: String(it.product_name).trim(),
      style_no: it.style_no || null,
      sku: it.sku || null,
      remark: it.remark || null,
      qty,
      amount_usd: amountUsd,
      amount_cny: round2(amountUsd * rate),
      sizes: validRows.map((s) => ({
        ...s,
        cny: round2(s.usd * rate),
        amount_cny: round2(s.amount * rate)
      }))
    });
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id = ?)').run(order.id);
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);
    const insItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, product_name, style_no, sku, remark, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const insSize = db.prepare(
      'INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?)'
    );
    for (const it of items) {
      const info = insItem.run(order.id, it.product_id, it.product_name, it.style_no, it.sku, it.remark,
        it.qty, it.amount_usd, it.amount_cny);
      for (const s of it.sizes) insSize.run(Number(info.lastInsertRowid), s.color, s.size, s.qty, s.usd, s.cny, s.amount, s.amount_cny);
    }
    const t = now();
    db.prepare('UPDATE orders SET total_usd = ?, total_amount = ?, updated_at = ? WHERE id = ?')
      .run(orderUsd, round2(orderUsd * rate), t, order.id);
    db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(order.id, 'draft', 'draft', req.user.username, `完善颜色尺码明细：${items.length} 款，共 ${items.reduce((sum, it) => sum + it.qty, 0)} 件`, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, getOrderFull(order.id));
}));

// ---------- 设置款图 ----------
router.post('/:id/image', authRequired, requireRole(['admin', 'sales', 'tech']), wrap(async (req, res) => {
  const { image_url } = req.body || {};
  const exists = db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(req.params.id);
  if (!exists) return fail(res, 404, '订单不存在');
  db.prepare('UPDATE orders SET image_url = ?, updated_at = ? WHERE id = ?').run(image_url || null, now(), req.params.id);
  return ok(res, { id: Number(req.params.id), image_url: image_url || null });
}));

// ---------- 批量流转 ----------
/**
 * POST /api/orders/batch/transition
 * { ids: number[], to, note?, force?, dry_run?, all_or_nothing? }
 *
 * 三种返回形态：
 *   dry_run=1        → 只预检，告诉你「几单能过、几单会被拦、分别为什么」（前端点开弹窗就先跑这个）
 *   all_or_nothing=1 → 整批一致：有一单不过就整批不动，且把所有失败原因都列出来
 *   默认             → 逐单尽力：能过的过，过不去的逐条列原因
 *
 * 为什么不默认整批回滚：批量场景里各单情况本来就不同（有的缺评审、有的已终态），
 * 一刀切回滚会让「199 单能过、1 单不能」变成「200 单全不动」—— 那就没法用了。
 * 但无论哪种模式，**每一单的结果都要返回并在页面上逐条展示**，不许一句「部分成功」带过。
 *
 * 批次号 BATyyyymmdd-hhmmss 会写进每单 order_logs.note 的开头，
 * 事后按批次号能一把捞出「这一批动了哪些单」（审计追溯用）。
 */
router.post(
  '/batch/transition',
  authRequired,
  requireRole(['admin', 'sales', 'tech', 'finance', 'production', 'warehouse']),
  wrap(async (req, res) => {
    const b = req.body || {};
    const r = orderFlow.batchTransition({
      ids: b.ids,
      to: b.to,
      note: b.note,
      force: b.force === true || b.force === 1,
      dryRun: b.dry_run === true || b.dry_run === 1,
      allOrNothing: b.all_or_nothing === true || b.all_or_nothing === 1,
      user: req.user
    });
    return ok(res, r);
  })
);

// ---------- 状态流转（单张） ----------
router.post('/:id/transition', authRequired, wrap(async (req, res) => {
  const { to, note, force } = req.body || {};
  const r = orderFlow.transition({ orderId: req.params.id, to, note, force, user: req.user });
  return ok(res, getOrderFull(r.id));
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
