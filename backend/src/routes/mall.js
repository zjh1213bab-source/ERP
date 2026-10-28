/**
 * 客户商城前台接口（客户账号，与 ERP 员工账号分离）
 *
 * 公开：
 *   POST /api/mall/auth/login           客户登录
 *   GET  /api/mall/public/products      访客目录（不含价格）
 *
 * 需登录（Bearer=客户 token）：
 *   GET  /api/mall/auth/me
 *   GET  /api/mall/products?q=&category=&only_fav=
 *   GET  /api/mall/products/:id
 *   GET  /api/mall/categories
 *   GET  /api/mall/favorites            POST /api/mall/favorites/:id（切换收藏）
 *   POST /api/mall/inquiries            提交选品/询价单
 *   GET  /api/mall/inquiries            我的询价单
 *   GET  /api/mall/inquiries/:id
 *   POST /api/mall/inquiries/:id/confirm   客户确认报价（quoted → confirmed）
 *   POST /api/mall/inquiries/:id/cancel
 *   GET  /api/mall/orders               我的订单（脱敏）
 *   GET  /api/mall/orders/:id           订单明细（脱敏）
 *   GET  /api/mall/messages             站内消息
 *   POST /api/mall/messages/:id/read    POST /api/mall/messages/read-all
 *   GET  /api/mall/summary              角标汇总
 */
const express = require('express');
const jwt = require('jsonwebtoken');

const config = require('../config');
const { db, now, getSettings } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { verifyPassword } = require('../auth/password');
const { signCustomerToken, customerRequired } = require('../middleware/customerAuth');
const { PERMS, ROLE_LABEL, resolvePerms, resolveLimit, hasPerm, withinLimit, permRequired, audit } = require('../services/customerPerms');
const { hashPassword } = require('../auth/password');
const crypto = require('crypto');
const mall = require('../services/mall');

const router = express.Router();
const round2 = mall.round2;

const INQUIRY_STATUS = {
  submitted: '待报价', quoted: '已报价', confirmed: '待转订单', converted: '已转订单', cancelled: '已取消'
};
const ORDER_STATUS = mall.ORDER_STATUS_TEXT;

function accountById(id) {
  return db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(id);
}

/**
 * 字段级隔离（TS-N21-04）
 * 没有 finance.view 的账号看不到任何金额字段——列表、详情、导出、统计同一套口径。
 * 不是前端隐藏，是服务端直接不出这个字段。
 */
const MONEY_FIELDS = ['total_usd', 'total_amount', 'rate', 'amount_usd', 'amount_cny', 'usd_price', 'price', 'unit_price'];
function stripMoney(obj, perm) {
  if (hasPerm(perm.account, 'finance.view')) return obj;
  const copy = { ...obj };
  MONEY_FIELDS.forEach((f) => { if (f in copy) delete copy[f]; });
  copy.amount_hidden = true;
  return copy;
}

// ---------------- 登录 ----------------
router.post('/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return fail(res, 400, '请输入账号和密码');

  const acc = db.prepare('SELECT * FROM customer_accounts WHERE username = ?').get(String(username).trim());
  if (!acc) return fail(res, 401, '账号不存在');
  if (acc.status !== 'active') return fail(res, 401, '账号已停用，请联系业务员');
  if (!verifyPassword(password, acc.password_hash)) return fail(res, 401, '账号或密码错误');

  const customer = db.prepare('SELECT id, name, code FROM customers WHERE id = ?').get(acc.customer_id);
  if (!customer) return fail(res, 401, '账号未绑定客户，请联系业务员');

  db.prepare('UPDATE customer_accounts SET last_login_at = ? WHERE id = ?').run(now(), acc.id);
  return ok(res, {
    token: signCustomerToken(acc),
    account: {
      id: acc.id, username: acc.username, name: acc.name, role: acc.role,
      role_label: ROLE_LABEL[acc.role] || acc.role,
      perms: resolvePerms(acc),
      must_change_pwd: Number(acc.must_change_pwd) || 0
    },
    customer: { id: customer.id, name: customer.name, code: customer.code }
  });
}));

router.get('/auth/me', customerRequired, wrap(async (req, res) => {
  const acc = accountById(req.customer.sub);
  if (!acc || acc.status !== 'active') return fail(res, 401, '账号不可用');
  const customer = db.prepare('SELECT id, name, code, level FROM customers WHERE id = ?').get(acc.customer_id);
  const owner = acc.role === 'owner' ? acc : db.prepare("SELECT id, name, username FROM customer_accounts WHERE id = ?").get(acc.parent_id);
  return ok(res, {
    account: {
      id: acc.id, username: acc.username, name: acc.name, role: acc.role,
      role_label: ROLE_LABEL[acc.role] || acc.role,
      email: acc.email, phone: acc.phone,
      perms: resolvePerms(acc),
      perm_labels: resolvePerms(acc).map((p) => PERMS[p] || p),
      limit_perms: resolveLimit(acc),
      must_change_pwd: Number(acc.must_change_pwd) || 0,
      owner_name: owner ? owner.name || owner.username : null
    },
    customer,
    rate: getSettings().exchangeRate
  });
}));

// ---------------- 访客目录（不含价格）----------------
router.get('/public/products', wrap(async (req, res) => {
  const { q = '' } = req.query;
  const where = ["status = 'published'"];
  const params = [];
  if (q) { where.push('(name_cn LIKE ? OR name_en LIKE ? OR style_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT id, style_no, name_cn, name_en, category, cover_image FROM mall_products
     WHERE ${where.join(' AND ')} ORDER BY sort DESC, id DESC LIMIT 60`
  ).all(...params);
  return ok(res, rows);
}));

// ---------------- 商品 ----------------
router.get('/categories', customerRequired, permRequired('catalog.view'), wrap(async (req, res) => {
  const rows = db.prepare(
    `SELECT COALESCE(category,'未分类') AS category, COUNT(*) AS cnt FROM mall_products
     WHERE status='published' GROUP BY COALESCE(category,'未分类') ORDER BY cnt DESC`
  ).all();
  return ok(res, rows);
}));

router.get('/products', customerRequired, permRequired('catalog.view'), wrap(async (req, res) => {
  const { q = '', category = '', only_fav = '' } = req.query;
  const cid = req.customer.cid;
  const where = ["status = 'published'"];
  const params = [];
  if (q) {
    where.push('(name_cn LIKE ? OR name_en LIKE ? OR style_no LIKE ? OR tags LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (category) { where.push("COALESCE(category,'未分类') = ?"); params.push(category); }
  if (only_fav) {
    where.push('EXISTS (SELECT 1 FROM mall_favorites f WHERE f.mall_product_id = mall_products.id AND f.account_id = ?)');
    params.push(req.customer.sub);
  }
  const rows = db.prepare(
    `SELECT * FROM mall_products WHERE ${where.join(' AND ')} ORDER BY sort DESC, id DESC LIMIT 100`
  ).all(...params);

  const favSet = new Set(
    db.prepare('SELECT mall_product_id FROM mall_favorites WHERE account_id = ?').all(req.customer.sub).map((x) => x.mall_product_id)
  );
  return ok(res, rows.map((r) => ({
    ...mall.decorate(r, cid),
    favorite: favSet.has(r.id)
  })));
}));

router.get('/products/:id', customerRequired, permRequired('catalog.view'), wrap(async (req, res) => {
  const p = db.prepare("SELECT * FROM mall_products WHERE id = ? AND status = 'published'").get(req.params.id);
  if (!p) return fail(res, 404, '商品不存在或已下架');
  const favorite = !!db.prepare('SELECT 1 AS x FROM mall_favorites WHERE account_id = ? AND mall_product_id = ?')
    .get(req.customer.sub, p.id);
  // 阶梯价（来自产品主数据，供客户参考）
  const tiers = p.product_id
    ? db.prepare('SELECT min_qty, max_qty, price_usd FROM price_tiers WHERE product_id = ? ORDER BY min_qty').all(p.product_id)
    : [];
  return ok(res, { ...mall.decorate(p, req.customer.cid), favorite, tiers });
}));

// ---------------- 收藏 ----------------
router.get('/favorites', customerRequired, permRequired('catalog.view'), wrap(async (req, res) => {
  const rows = db.prepare(
    `SELECT p.* FROM mall_favorites f JOIN mall_products p ON p.id = f.mall_product_id
     WHERE f.account_id = ? AND p.status = 'published' ORDER BY f.id DESC`
  ).all(req.customer.sub);
  return ok(res, rows.map((r) => ({ ...mall.decorate(r, req.customer.cid), favorite: true })));
}));

router.post('/favorites/:id', customerRequired, permRequired('catalog.view'), wrap(async (req, res) => {
  const pid = Number(req.params.id);
  const p = db.prepare('SELECT id FROM mall_products WHERE id = ?').get(pid);
  if (!p) return fail(res, 404, '商品不存在');
  const exist = db.prepare('SELECT id FROM mall_favorites WHERE account_id = ? AND mall_product_id = ?')
    .get(req.customer.sub, pid);
  if (exist) {
    db.prepare('DELETE FROM mall_favorites WHERE id = ?').run(exist.id);
    return ok(res, { favorite: false });
  }
  db.prepare('INSERT INTO mall_favorites (account_id, mall_product_id, created_at) VALUES (?,?,?)')
    .run(req.customer.sub, pid, now());
  return ok(res, { favorite: true });
}));

// ---------------- 选品 / 询价 ----------------
function inquiryFull(id) {
  const q = db.prepare(
    `SELECT q.*, c.name AS customer_name FROM mall_inquiries q
     LEFT JOIN customers c ON c.id = q.customer_id WHERE q.id = ?`
  ).get(id);
  if (!q) return null;
  q.items = db.prepare('SELECT * FROM mall_inquiry_items WHERE inquiry_id = ? ORDER BY id').all(id);
  q.status_label = INQUIRY_STATUS[q.status] || q.status;
  return q;
}

router.post('/inquiries', customerRequired, permRequired('inquiry.create'), wrap(async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items.filter((it) => Number(it.qty) > 0) : [];
  if (!items.length) return fail(res, 400, '请至少选择一款商品并填写数量');

  const cid = req.customer.cid;
  const rate = getSettings().exchangeRate;
  const prepared = [];
  let totalUsd = 0;
  let totalQty = 0;

  for (const it of items) {
    const mp = db.prepare("SELECT * FROM mall_products WHERE id = ? AND status = 'published'")
      .get(Number(it.mall_product_id));
    if (!mp) return fail(res, 400, `商品已下架：${it.name || it.mall_product_id}`);
    const price = mall.resolvePrice(mp, cid);
    const qty = Number(it.qty) || 0;
    if (qty < price.moq) return fail(res, 400, `「${mp.name_cn}」起订量 ${price.moq} 件`);
    const amountUsd = round2(qty * price.price_usd);
    totalUsd = round2(totalUsd + amountUsd);
    totalQty += qty;
    prepared.push({
      mall_product_id: mp.id,
      product_id: mp.product_id,
      style_no: mp.style_no,
      name: mp.name_cn,
      qty,
      price_usd: price.price_usd,
      amount_usd: amountUsd,
      remark: it.remark || null
    });
  }

  const inquiryNo = mall.genInquiryNo();
  let id;
  db.exec('BEGIN');
  try {
    const t = now();
    const info = db.prepare(
      `INSERT INTO mall_inquiries (inquiry_no, customer_id, account_id, contact, status, total_usd, total_qty, rate, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(inquiryNo, cid, req.customer.sub, b.contact || null, 'submitted', totalUsd, totalQty, rate,
      b.remark || null, t, t);
    id = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO mall_inquiry_items (inquiry_id, mall_product_id, product_id, style_no, name, qty, price_usd, amount_usd, remark)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    prepared.forEach((r) => ins.run(id, r.mall_product_id, r.product_id, r.style_no, r.name, r.qty, r.price_usd, r.amount_usd, r.remark));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // 通知内部：给负责该客户的业务员留一条系统消息（用 ERP 审计日志承载）
  // 客户商城是外部身份，这里自己写一条（不在 ERP 的登录态里，走不了统一中间件）
  try {
    require('../services/auditLog').append({
      username: '商城客户',
      role: 'customer',
      method: 'POST',
      path: '/mall/inquiries',
      status: 200,
      ip: ''
    });
  } catch (e) { /* ignore */ }

  return ok(res, inquiryFull(id));
}));

router.get('/inquiries', customerRequired, permRequired('inquiry.create'), wrap(async (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM mall_inquiries WHERE customer_id = ? ORDER BY id DESC LIMIT 60'
  ).all(req.customer.cid);
  rows.forEach((r) => { r.status_label = INQUIRY_STATUS[r.status] || r.status; });
  return ok(res, rows);
}));

router.get('/inquiries/:id', customerRequired, permRequired('inquiry.create'), wrap(async (req, res) => {
  const q = inquiryFull(req.params.id);
  if (!q || q.customer_id !== req.customer.cid) return fail(res, 404, '询价单不存在');
  return ok(res, q);
}));

router.post('/inquiries/:id/confirm', customerRequired, permRequired('inquiry.create'), wrap(async (req, res) => {
  const q = inquiryFull(req.params.id);
  if (!q || q.customer_id !== req.customer.cid) return fail(res, 404, '询价单不存在');
  if (q.status !== 'quoted') return fail(res, 400, '只有「已报价」的询价单可以确认');
  db.prepare("UPDATE mall_inquiries SET status='confirmed', updated_at=? WHERE id=?").run(now(), q.id);
  mall.pushMessage({
    customerId: q.customer_id,
    type: 'order',
    title: '已确认报价',
    body: `询价单 ${q.inquiry_no} 已确认，我们会尽快为你生成正式订单。`,
    refType: 'inquiry',
    refId: q.id
  });
  return ok(res, inquiryFull(q.id));
}));

router.post('/inquiries/:id/cancel', customerRequired, permRequired('inquiry.create'), wrap(async (req, res) => {
  const q = inquiryFull(req.params.id);
  if (!q || q.customer_id !== req.customer.cid) return fail(res, 404, '询价单不存在');
  if (['converted', 'cancelled'].includes(q.status)) return fail(res, 400, '该询价单不可取消');
  db.prepare("UPDATE mall_inquiries SET status='cancelled', updated_at=? WHERE id=?").run(now(), q.id);
  return ok(res, inquiryFull(q.id));
}));

// ---------------- 我的订单（脱敏） ----------------
router.get('/orders', customerRequired, permRequired('order.view'), wrap(async (req, res) => {
  const rows = db.prepare(
    `SELECT id, order_no, type, status, total_usd, total_amount, rate, style_name, delivery_date, created_at
     FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 60`
  ).all(req.customer.cid);
  const perm = { account: req.account };
  const out = rows.map((r) => {
    const x = stripMoney(r, perm);
    x.status_label = ORDER_STATUS[r.status] || r.status;
    return x;
  });
  return ok(res, { rows: out, amount_visible: hasPerm(req.account, 'finance.view') });
}));

router.get('/orders/:id', customerRequired, permRequired('order.view'), wrap(async (req, res) => {
  const o = db.prepare(
    `SELECT id, order_no, type, status, total_usd, total_amount, rate, style_name, delivery_date,
            delivery_method, trade_terms, created_at
     FROM orders WHERE id = ? AND customer_id = ?`
  ).get(req.params.id, req.customer.cid);
  if (!o) return fail(res, 404, '订单不存在');
  o.status_label = ORDER_STATUS[o.status] || o.status;
  o.items = db.prepare(
    `SELECT i.id, i.product_name, i.style_no, i.qty, i.amount_usd,
            s.color, s.size, s.qty AS size_qty, s.usd_price
     FROM order_items i LEFT JOIN order_item_sizes s ON s.item_id = i.id
     WHERE i.order_id = ? ORDER BY i.id, s.id`
  ).all(o.id);
  // 只暴露客户关心的进度节点
  o.timeline = db.prepare(
    "SELECT to_status, note, created_at FROM order_logs WHERE order_id = ? AND to_status IN ('draft','tech','finance','assigned','production','instock','shipped','closed') ORDER BY id"
  ).all(o.id).map((l) => ({ ...l, label: ORDER_STATUS[l.to_status] || l.to_status }));
  const perm = { account: req.account };
  const head = stripMoney(o, perm);
  head.items = (o.items || []).map((it) => stripMoney(it, perm));
  head.amount_visible = hasPerm(req.account, 'finance.view');
  return ok(res, head);
}));

// ---------------- 待我确认（样衣封样 / 订单变更 / 交期变动） ----------------
const SEAL_STATUS = { draft: '草稿', sent: '待确认', confirmed: '已确认', rejected: '已提修改', superseded: '已被替代' };
const CHANGE_TYPE = { craft: '工艺', qty: '数量', price: '价格', delivery: '交期', material: '面辅料' };

function myOrder(orderId, cid) {
  return db.prepare('SELECT * FROM orders WHERE id = ? AND customer_id = ?').get(orderId, cid);
}

router.get('/confirmations', customerRequired, permRequired('order.confirm'), wrap(async (req, res) => {
  const cid = req.customer.cid;
  const seals = db.prepare(
    `SELECT s.id, s.seal_no, s.version, s.sample_name, s.style_no, s.content_hash, s.attachments,
            s.sent_at, s.status, o.order_no
     FROM sample_seals s JOIN orders o ON o.id = s.order_id
     WHERE o.customer_id = ? AND s.status = 'sent' AND s.tech_approved = 1
     ORDER BY s.id DESC`
  ).all(cid).map((r) => {
    let att = [];
    try { att = JSON.parse(r.attachments || '[]'); } catch (e) { att = []; }
    return { ...r, attachments: Array.isArray(att) ? att : [], status_label: SEAL_STATUS[r.status] || r.status };
  });

  const changes = db.prepare(
    `SELECT g.id, g.change_no, g.type, g.title, g.affected_in_production, g.remaining_qty,
            g.price_delta, g.delivery_delta_days, g.assess_note, g.status, o.order_no
     FROM order_changes g JOIN orders o ON o.id = g.order_id
     WHERE o.customer_id = ? AND g.status = 'pending_customer'
     ORDER BY g.id DESC`
  ).all(cid).map((r) => ({ ...r, type_label: CHANGE_TYPE[r.type] || r.type }));

  const deliveries = db.prepare(
    `SELECT d.id, d.promised_date, d.new_date, d.kind, d.reason, d.status, o.order_no
     FROM delivery_changes d JOIN orders o ON o.id = d.order_id
     WHERE o.customer_id = ? AND d.status = 'pending'
     ORDER BY d.id DESC`
  ).all(cid).map((r) => ({
    ...r,
    kind_label: { etd: '预计出厂', eta_wh: '预计到仓', eta_customer: '预计送达' }[r.kind] || r.kind,
    delay_days: r.promised_date && r.new_date
      ? Math.round((new Date(r.new_date) - new Date(r.promised_date)) / 86400000) : null
  }));

  return ok(res, { seals, changes, deliveries, total: seals.length + changes.length + deliveries.length });
}));

/** 客户确认样衣：记录确认人、账号、时间、内容校验值与意见 */
router.post('/seals/:id/confirm', customerRequired, permRequired('order.confirm'), wrap(async (req, res) => {
  const s2 = db.prepare('SELECT * FROM sample_seals WHERE id = ?').get(req.params.id);
  if (!s2) return fail(res, 404, '样衣记录不存在');
  const o = myOrder(s2.order_id, req.customer.cid);
  if (!o) return fail(res, 403, '无权操作该样衣');
  if (s2.status !== 'sent') return fail(res, 400, `当前状态为「${SEAL_STATUS[s2.status] || s2.status}」，不能确认`);
  if (!Number(s2.tech_approved)) return fail(res, 400, '总部技术尚未批准，暂不能确认');

  const b = req.body || {};
  const accepted = b.accepted !== false && b.accepted !== 0;
  const acct = accountById(req.customer.sub);
  db.prepare(
    `UPDATE sample_seals SET status=?, customer_account_id=?, customer_confirmed_by=?, customer_confirmed_at=?,
       customer_comment=?, updated_at=? WHERE id=?`
  ).run(accepted ? 'confirmed' : 'rejected', req.customer.sub,
    (acct && (acct.name || acct.username)) || req.customer.username || '客户',
    now(), b.comment || null, now(), s2.id);

  if (o.customer_id) {
    mall.pushMessage({
      customerId: o.customer_id,
      type: 'order',
      title: accepted ? `样衣已确认：${s2.version}` : `样衣已提出修改：${s2.version}`,
      body: `订单 ${o.order_no} 样衣「${s2.sample_name || s2.style_no || ''}」${s2.version} ${accepted ? '已由您确认' : '已提交修改意见'}。内容校验值 ${s2.content_hash}。`,
      refType: 'sample_seal',
      refId: s2.id
    });
  }
  return ok(res, { id: s2.id, status: accepted ? 'confirmed' : 'rejected' });
}));

/** 客户确认订单变更 */
router.post('/changes/:id/confirm', customerRequired, permRequired('order.confirm'), wrap(async (req, res) => {
  const g = db.prepare('SELECT * FROM order_changes WHERE id = ?').get(req.params.id);
  if (!g) return fail(res, 404, '变更单不存在');
  const o = myOrder(g.order_id, req.customer.cid);
  if (!o) return fail(res, 403, '无权操作该变更');
  if (g.status !== 'pending_customer') return fail(res, 400, '该变更不在待确认状态');

  const b = req.body || {};
  const accepted = b.accepted !== false && b.accepted !== 0;
  const acct = accountById(req.customer.sub);
  db.prepare(
    `UPDATE order_changes SET status=?, customer_account_id=?, customer_confirmed_by=?, customer_confirmed_at=?,
       customer_comment=?, updated_at=? WHERE id=?`
  ).run(accepted ? 'confirmed' : 'rejected', req.customer.sub,
    (acct && (acct.name || acct.username)) || req.customer.username || '客户',
    now(), b.comment || null, now(), g.id);

  if (o.customer_id) {
    mall.pushMessage({
      customerId: o.customer_id,
      type: 'order',
      title: accepted ? `变更已确认：${g.change_no}` : `变更未接受：${g.change_no}`,
      body: `订单 ${o.order_no} 的变更「${g.title}」${accepted ? '已确认，生产工位签收后执行' : '未被接受，业务会与您沟通'}。`,
      refType: 'order_change',
      refId: g.id
    });
  }
  return ok(res, { id: g.id, status: accepted ? 'confirmed' : 'rejected' });
}));

/** 客户确认交期变动（原承诺保留不变） */
router.post('/deliveries/:id/confirm', customerRequired, permRequired('order.confirm'), wrap(async (req, res) => {
  const d = db.prepare('SELECT * FROM delivery_changes WHERE id = ?').get(req.params.id);
  if (!d) return fail(res, 404, '交期变动不存在');
  const o = myOrder(d.order_id, req.customer.cid);
  if (!o) return fail(res, 403, '无权操作该交期变动');
  if (d.status !== 'pending') return fail(res, 400, '该交期变动不在待确认状态');

  const b = req.body || {};
  const accepted = b.accepted !== false && b.accepted !== 0;
  const acct = accountById(req.customer.sub);
  db.prepare(
    `UPDATE delivery_changes SET status=?, customer_confirmed_by=?, customer_confirmed_at=?, customer_comment=?, updated_at=? WHERE id=?`
  ).run(accepted ? 'confirmed' : 'rejected',
    (acct && (acct.name || acct.username)) || req.customer.username || '客户',
    now(), b.comment || null, now(), d.id);
  return ok(res, { id: d.id, status: accepted ? 'confirmed' : 'rejected' });
}));

/** 订单交期与物流（承诺日与最新预计分开呈现，人工记录标注来源） */
router.get('/orders/:id/delivery', customerRequired, permRequired('order.view'), wrap(async (req, res) => {
  const o = myOrder(req.params.id, req.customer.cid);
  if (!o) return fail(res, 404, '订单不存在');
  const changes = db.prepare(
    'SELECT * FROM delivery_changes WHERE order_id = ? ORDER BY id DESC'
  ).all(o.id).map((d) => ({
    ...d,
    kind_label: { etd: '预计出厂', eta_wh: '预计到仓', eta_customer: '预计送达' }[d.kind] || d.kind,
    status_label: { pending: '待确认', confirmed: '已确认', rejected: '未接受' }[d.status] || d.status
  }));
  const latest = changes.find((c) => c.status === 'confirmed') || changes[0] || null;
  const events = db.prepare(
    `SELECT carrier, tracking_no, event_time, status_text, location, source, verified
     FROM shipment_events WHERE order_id = ? AND visible = 1
     ORDER BY COALESCE(event_time, created_at) DESC, id DESC LIMIT 50`
  ).all(o.id).map((e) => ({
    ...e,
    source_label: e.source === 'api' ? '接口同步' : '人工登记（经业务核实）',
    verified_label: Number(e.verified) ? '已核实' : '待核实'
  }));
  return ok(res, {
    promised_date: o.delivery_date,          // 原承诺，永不覆盖
    latest_expected: latest ? latest.new_date : null,
    latest_kind: latest ? latest.kind_label : null,
    status: o.status,
    status_label: ORDER_STATUS[o.status] || o.status,
    changes,
    events
  });
}));

// ---------------- 消息 ----------------
router.get('/messages', customerRequired, wrap(async (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM mall_messages WHERE customer_id = ? ORDER BY id DESC LIMIT 80'
  ).all(req.customer.cid);
  return ok(res, rows);
}));

router.post('/messages/:id/read', customerRequired, wrap(async (req, res) => {
  db.prepare('UPDATE mall_messages SET read_at = ? WHERE id = ? AND customer_id = ?')
    .run(now(), req.params.id, req.customer.cid);
  return ok(res, { read: 1 });
}));

router.post('/messages/read-all', customerRequired, wrap(async (req, res) => {
  const info = db.prepare('UPDATE mall_messages SET read_at = ? WHERE customer_id = ? AND read_at IS NULL')
    .run(now(), req.customer.cid);
  return ok(res, { read: info.changes });
}));

router.get('/summary', customerRequired, wrap(async (req, res) => {
  const cid = req.customer.cid;
  const unread = Number(db.prepare('SELECT COUNT(*) c FROM mall_messages WHERE customer_id = ? AND read_at IS NULL').get(cid).c);
  const inquiries = Number(db.prepare("SELECT COUNT(*) c FROM mall_inquiries WHERE customer_id = ? AND status IN ('submitted','quoted','confirmed')").get(cid).c);
  const orders = Number(db.prepare("SELECT COUNT(*) c FROM orders WHERE customer_id = ? AND status NOT IN ('closed','cancelled')").get(cid).c);
  const favorites = Number(db.prepare('SELECT COUNT(*) c FROM mall_favorites WHERE account_id = ?').get(req.customer.sub).c);
  // 待我确认：样衣 + 变更 + 交期
  const pending =
    Number(db.prepare(
      `SELECT COUNT(*) c FROM sample_seals s JOIN orders o ON o.id = s.order_id
       WHERE o.customer_id = ? AND s.status = 'sent' AND s.tech_approved = 1`
    ).get(cid).c) +
    Number(db.prepare(
      `SELECT COUNT(*) c FROM order_changes g JOIN orders o ON o.id = g.order_id
       WHERE o.customer_id = ? AND g.status = 'pending_customer'`
    ).get(cid).c) +
    Number(db.prepare(
      `SELECT COUNT(*) c FROM delivery_changes d JOIN orders o ON o.id = d.order_id
       WHERE o.customer_id = ? AND d.status = 'pending'`
    ).get(cid).c);
  return ok(res, { unread, inquiries, orders, favorites, pending_confirm: pending });
}));


// ---------------- 对账与账单（财务子账号） ----------------
router.get('/finance', customerRequired, permRequired('finance.view'), wrap(async (req, res) => {
  const cid = req.customer.cid;
  const rows = db.prepare(
    `SELECT a.id, a.bill_no, a.order_id, o.order_no, a.currency, a.amount_orig, a.rate, a.amount,
            a.paid_amount, a.due_date, a.status, a.created_at
     FROM ar_invoices a LEFT JOIN orders o ON o.id = a.order_id
     WHERE a.customer_id = ? AND a.status != 'void' ORDER BY a.due_date, a.id DESC`
  ).all(cid);
  const today = new Date().toISOString().slice(0, 10);
  const rowsOut = rows.map((r) => {
    const open = round2(Number(r.amount) - Number(r.paid_amount));
    return {
      ...r,
      open_amount: open,
      overdue: !!(r.due_date && r.due_date < today && open > 0.005),
      status_label: { unpaid: '未付', partial: '部分已付', paid: '已收清' }[r.status] || r.status
    };
  });
  const total = round2(rowsOut.reduce((s2, r) => s2 + Number(r.amount), 0));
  const paid = round2(rowsOut.reduce((s2, r) => s2 + Number(r.paid_amount), 0));
  const overdue = round2(rowsOut.filter((r) => r.overdue).reduce((s2, r) => s2 + r.open_amount, 0));
  return ok(res, {
    rows: rowsOut,
    summary: {
      bills: rowsOut.length,
      total, paid,
      open: round2(total - paid),
      overdue,
      paid_rate: total > 0 ? round2((paid / total) * 100) : null
    },
    note: '只含本组织的应收与货款，不含内部成本；金额口径与业务对账单一致'
  });
}));

// ---------------- 成员管理（主账号 / 有 member.manage 的子账号） ----------------
router.get('/members', customerRequired, permRequired('member.manage'), wrap(async (req, res) => {
  const cid = req.customer.cid;
  const rows = db.prepare(
    `SELECT id, username, name, phone, email, role, status, perms, parent_id, must_change_pwd,
            approved_by, approved_at, last_login_at, created_at
     FROM customer_accounts WHERE customer_id = ? ORDER BY (role = 'owner') DESC, id`
  ).all(cid).map((a) => {
    const perms = resolvePerms(a);
    return {
      ...a,
      role_label: ROLE_LABEL[a.role] || a.role,
      perms,
      perm_labels: perms.map((x) => PERMS[x] || x),
      is_self: a.id === req.customer.sub,
      limit_perms: resolveLimit(a)
    };
  });
  return ok(res, {
    rows,
    limit: resolveLimit(req.account),
    limit_labels: resolveLimit(req.account).map((x) => PERMS[x] || x),
    perm_dict: PERMS,
    role_presets: { purchase: ['catalog.view', 'inquiry.create'], orders: ['catalog.view', 'order.view', 'order.confirm'], finance: ['finance.view', 'order.view'], member: ['catalog.view', 'inquiry.create'] },
    note: '主账号可在销售批准的上限内开子账号；不能给子账号超出组织范围的权限'
  });
}));

router.post('/members', customerRequired, permRequired('member.manage'), wrap(async (req, res) => {
  const b = req.body || {};
  const cid = req.customer.cid;
  const username = String(b.username || '').trim();
  if (!/^[A-Za-z0-9_.-]{4,32}$/.test(username)) return fail(res, 400, '登录账号 4-32 位，只能用字母数字和 _ . -');
  if (!b.password || String(b.password).length < 6) return fail(res, 400, '密码至少 6 位');
  const role = ['purchase', 'orders', 'finance', 'member'].includes(b.role) ? b.role : 'member';
  const limit = resolveLimit(req.account);
  const want = Array.isArray(b.perms) && b.perms.length ? b.perms.filter((x) => PERMS[x]) : (mallRolePreset(role));
  if (!withinLimit(want, limit)) {
    const bad = want.filter((x) => !limit.includes(x)).map((x) => PERMS[x] || x);
    return fail(res, 400, `超出销售批准的权限上限：${bad.join('、')}。主账号也不能给子账号越权`);
  }
  if (db.prepare('SELECT 1 AS x FROM customer_accounts WHERE username = ?').get(username)) {
    return fail(res, 400, '登录账号已被占用');
  }
  const t = now();
  const owner = db.prepare("SELECT id FROM customer_accounts WHERE customer_id = ? AND role = 'owner' ORDER BY id LIMIT 1").get(cid);
  const info = db.prepare(
    `INSERT INTO customer_accounts (customer_id, username, password_hash, name, phone, email, role, status,
      parent_id, perms, limit_perms, must_change_pwd, invited_by, created_by, created_at)
     VALUES (?,?,?,?,?,?,?, 'active', ?,?,?, 1, ?, NULL, ?)`
  ).run(
    cid, username, hashPassword(String(b.password)), b.name || username, b.phone || null, b.email || null,
    role, owner ? owner.id : req.account.id,
    want.join(','), limit.join(','), 'customer:' + req.customer.username, t
  );
  const newId = Number(info.lastInsertRowid);
  audit(newId, cid, 'create', null,
    { username, role, perms: want, parent_id: owner ? owner.id : null },
    req.customer.username, 'customer', '主账号开子账号');
  return ok(res, {
    id: newId, username, role, role_label: ROLE_LABEL[role], perms: want,
    notice: '已开通。首次登录请让本人改密码（系统标记为需改密）'
  });
}));

router.put('/members/:id', customerRequired, permRequired('member.manage'), wrap(async (req, res) => {
  const acc = db.prepare('SELECT * FROM customer_accounts WHERE id = ? AND customer_id = ?').get(req.params.id, req.customer.cid);
  if (!acc) return fail(res, 404, '成员不存在');
  if (acc.role === 'owner') return fail(res, 400, '主账号不能在这里改：主账号变更需要业务员核验授权');
  if (acc.id === req.customer.sub) return fail(res, 400, '不能修改自己的权限');
  const b = req.body || {};
  const limit = resolveLimit(req.account);
  const before = { perms: resolvePerms(acc), status: acc.status, name: acc.name };

  let perms = resolvePerms(acc);
  if (Array.isArray(b.perms)) {
    perms = b.perms.filter((x) => PERMS[x]);
    if (!withinLimit(perms, limit)) {
      const bad = perms.filter((x) => !limit.includes(x)).map((x) => PERMS[x] || x);
      return fail(res, 400, `超出销售批准的权限上限：${bad.join('、')}`);
    }
  }
  let status = acc.status;
  if (b.status === 'active' || b.status === 'disabled') status = b.status;

  db.prepare('UPDATE customer_accounts SET perms = ?, status = ?, name = ?, phone = ?, email = ?, remark = ? WHERE id = ?')
    .run(perms.join(','), status, b.name !== undefined ? b.name : acc.name,
      b.phone !== undefined ? b.phone : acc.phone, b.email !== undefined ? b.email : acc.email,
      b.remark !== undefined ? b.remark : acc.remark, acc.id);

  const action = status !== acc.status ? (status === 'disabled' ? 'disable' : 'enable') : 'perms';
  audit(acc.id, acc.customer_id, action, before,
    { perms, status, name: b.name !== undefined ? b.name : acc.name },
    req.customer.username, 'customer', b.note || null);
  return ok(res, {
    id: acc.id, perms, status,
    notice: status === 'disabled' ? '已停用：该账号下一次请求就会被踢下线（服务端每次现读账号）' : '已保存'
  });
}));

router.post('/members/:id/reset-pwd', customerRequired, permRequired('member.manage'), wrap(async (req, res) => {
  const acc = db.prepare('SELECT * FROM customer_accounts WHERE id = ? AND customer_id = ?').get(req.params.id, req.customer.cid);
  if (!acc) return fail(res, 404, '成员不存在');
  if (acc.role === 'owner') return fail(res, 400, '主账号密码请用「找回密码」，不能由子账号重置');
  const pwd = String((req.body || {}).password || '').trim() || crypto.randomBytes(4).toString('hex');
  if (pwd.length < 6) return fail(res, 400, '密码至少 6 位');
  db.prepare('UPDATE customer_accounts SET password_hash = ?, must_change_pwd = 1 WHERE id = ?').run(hashPassword(pwd), acc.id);
  audit(acc.id, acc.customer_id, 'reset_pwd', null, { must_change_pwd: 1 }, req.customer.username, 'customer', '主账号重置子账号密码');
  return ok(res, { id: acc.id, password: pwd, notice: '密码只显示这一次，请让本人登录后立刻修改' });
}));

// ---------------- 授权审计（只读） ----------------
router.get('/audits', customerRequired, permRequired('member.manage'), wrap(async (req, res) => {
  const rows = db.prepare(
    `SELECT a.*, acc.username FROM customer_account_audits a
     LEFT JOIN customer_accounts acc ON acc.id = a.account_id
     WHERE a.customer_id = ? ORDER BY a.id DESC LIMIT 100`
  ).all(req.customer.cid);
  const LABEL = {
    create: '开通账号', perms: '调整权限', disable: '停用', enable: '启用',
    reset_pwd: '重置密码', approve: '批准权限上限', invite: '发出邀请',
    accept_invite: '接受邀请', login_fail: '登录失败'
  };
  return ok(res, rows.map((r) => ({
    ...r,
    action_label: LABEL[r.action] || r.action,
    scope_label: r.operator_scope === 'customer' ? '客户侧' : r.operator_scope === 'system' ? '系统' : '业务员'
  })));
}));

// ---------------- 邀请注册（一次性令牌，无需登录） ----------------
function mallRolePreset(role) {
  const map = { purchase: ['catalog.view', 'inquiry.create'], orders: ['catalog.view', 'order.view', 'order.confirm'], finance: ['finance.view', 'order.view'], member: ['catalog.view', 'inquiry.create'] };
  return map[role] || map.member;
}

router.get('/auth/invite/:token', wrap(async (req, res) => {
  const inv = db.prepare('SELECT * FROM customer_invites WHERE token = ?').get(req.params.token);
  if (!inv) return fail(res, 404, '邀请链接无效');
  if (inv.status === 'used') return fail(res, 400, '这个邀请已经被使用了');
  if (inv.status === 'revoked') return fail(res, 400, '邀请已被业务员撤回');
  if (inv.expires_at < now()) return fail(res, 400, '邀请已过期，请让业务员重发');
  const c = db.prepare('SELECT id, name, code FROM customers WHERE id = ?').get(inv.customer_id);
  return ok(res, {
    customer: c ? { id: c.id, name: c.name, code: c.code } : null,
    role: inv.role,
    role_label: ROLE_LABEL[inv.role] || inv.role,
    contact: inv.contact,
    expires_at: inv.expires_at,
    invited_by: inv.invited_by
  });
}));

router.post('/auth/invite/:token/accept', wrap(async (req, res) => {
  const inv = db.prepare('SELECT * FROM customer_invites WHERE token = ?').get(req.params.token);
  if (!inv) return fail(res, 404, '邀请链接无效');
  if (inv.status !== 'pending') return fail(res, 400, '这个邀请已失效');
  if (inv.expires_at < now()) return fail(res, 400, '邀请已过期，请让业务员重发');
  const b = req.body || {};
  const username = String(b.username || '').trim();
  if (!/^[A-Za-z0-9_.-]{4,32}$/.test(username)) return fail(res, 400, '登录账号 4-32 位，只能用字母数字和 _ . -');
  if (!b.password || String(b.password).length < 6) return fail(res, 400, '密码至少 6 位');
  if (db.prepare('SELECT 1 AS x FROM customer_accounts WHERE username = ?').get(username)) {
    return fail(res, 400, '登录账号已被占用');
  }
  const c = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(inv.customer_id);
  if (!c) return fail(res, 400, '邀请对应的客户不存在');

  const perms = mallRolePreset(inv.role);
  const t = now();
  const owner = db.prepare("SELECT id FROM customer_accounts WHERE customer_id = ? AND role = 'owner' ORDER BY id LIMIT 1").get(c.id);
  let accId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO customer_accounts (customer_id, username, password_hash, name, phone, email, role, status,
        parent_id, perms, must_change_pwd, invited_by, created_at)
       VALUES (?,?,?,?,?,?,?, 'active', ?,?, 0, ?, ?)`
    ).run(
      c.id, username, hashPassword(String(b.password)), b.name || username, b.phone || inv.contact || null, b.email || null,
      inv.role, owner ? owner.id : null, perms.join(','), inv.invited_by || null, t
    );
    accId = Number(info.lastInsertRowid);
    db.prepare("UPDATE customer_invites SET status = 'used', used_by_account_id = ?, used_at = ? WHERE id = ?").run(accId, t, inv.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, `注册失败：${e.message}`);
  }
  audit(accId, c.id, 'accept_invite', null, { username, role: inv.role, perms, invite: inv.token.slice(0, 8) + '…' },
    username, 'customer', '凭邀请令牌完成注册');
  const acc = db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(accId);
  return ok(res, {
    token: signCustomerToken(acc),
    account: { id: acc.id, username, name: acc.name, role: acc.role, role_label: ROLE_LABEL[acc.role], perms },
    customer: { id: c.id, name: c.name }
  });
}));

// ---------------- 改密码（首次登录 / 主动修改） ----------------
router.post('/auth/change-pwd', customerRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const acc = db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(req.customer.sub);
  if (!b.old_password || !verifyPassword(String(b.old_password), acc.password_hash)) {
    return fail(res, 400, '原密码不对');
  }
  if (!b.new_password || String(b.new_password).length < 6) return fail(res, 400, '新密码至少 6 位');
  if (String(b.new_password) === String(b.old_password)) return fail(res, 400, '新密码不能和原密码一样');
  db.prepare('UPDATE customer_accounts SET password_hash = ?, must_change_pwd = 0, last_pwd_change_at = ? WHERE id = ?')
    .run(hashPassword(String(b.new_password)), now(), acc.id);
  audit(acc.id, acc.customer_id, 'reset_pwd', null, { by_self: true }, req.customer.username, 'customer', '本人修改密码');
  return ok(res, { ok: true, notice: '密码已更新' });
}));

module.exports = router;
