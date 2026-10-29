/**
 * 客户商城 —— ERP 后台管理（员工账号）
 *
 * 商品：GET/POST /api/mall-admin/products ；PUT/DELETE /:id ；POST /:id/status
 * 客户专属价：GET /api/mall-admin/prices?customer_id= ；POST /prices ；DELETE /prices/:id
 * 询价单：GET /api/mall-admin/inquiries?status= ；GET /:id
 *         POST /:id/quote { items:[{id, price_usd}], sales_remark }   销售报价
 *         POST /:id/convert                                            转为销售订单（草稿）
 * 客户账号：GET /api/mall-admin/accounts?customer_id= ；POST /accounts ；PUT /accounts/:id
 * 通知：POST /api/mall-admin/notify { customer_id, title, body, type }
 * 概览：GET /api/mall-admin/stats
 */
const express = require('express');

const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { hashPassword } = require('../auth/password');
const { PERMS, ROLE_LABEL, ROLE_PRESETS, ALL_PERMS, resolvePerms, resolveLimit, audit } = require('../services/customerPerms');
const crypto = require('crypto');

// 可开通的子账号角色（eNG21-03：采购 / 订单 / 财务）
const SUB_ROLES = ['purchase', 'orders', 'finance', 'member'];
const mall = require('../services/mall');

const router = express.Router();
const WRITE = ['admin', 'sales'];
const round2 = mall.round2;

const INQUIRY_STATUS = {
  submitted: '待报价', quoted: '已报价', confirmed: '待转订单', converted: '已转订单', cancelled: '已取消'
};

// ---------------- 商城商品 ----------------
router.get('/products', authRequired, wrap(async (req, res) => {
  const { status = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (q) { where.push('(name_cn LIKE ? OR name_en LIKE ? OR style_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    'SELECT * FROM mall_products ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY sort DESC, id DESC'
  ).all(...params);
  return ok(res, rows.map((r) => ({ ...r, sellable: mall.sellableOf(r.style_no, r.name_cn) })));
}));

router.post('/products', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name_cn) return fail(res, 400, '中文名称必填');
  let productId = b.product_id || null;
  let styleNo = b.style_no || null;
  let price = Number(b.price_usd) || 0;
  let category = b.category || null;
  if (productId) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!p) return fail(res, 404, '产品不存在');
    styleNo = styleNo || p.sku;
    category = category || p.category;
    if (!(price > 0)) price = Number(p.price) || 0;
  }
  const t = now();
  const info = db.prepare(
    `INSERT INTO mall_products (product_id, style_no, name_cn, name_en, category, cover_image, images, description,
      moq, lead_days, price_usd, visible_stock, tags, status, sort, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(productId, styleNo, b.name_cn, b.name_en || null, category, b.cover_image || null,
    Array.isArray(b.images) ? b.images.join(',') : (b.images || null), b.description || null,
    Number(b.moq) || 1, Number(b.lead_days) || 30, round2(price),
    b.visible_stock === false ? 0 : 1, b.tags || null, b.status || 'published', Number(b.sort) || 0, t, t);
  return ok(res, db.prepare('SELECT * FROM mall_products WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/products/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM mall_products WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '商城商品不存在');
  const b = req.body || {};
  db.prepare(
    `UPDATE mall_products SET name_cn=?, name_en=?, category=?, cover_image=?, images=?, description=?,
      moq=?, lead_days=?, price_usd=?, visible_stock=?, tags=?, status=?, sort=?, updated_at=? WHERE id=?`
  ).run(
    b.name_cn || row.name_cn,
    b.name_en !== undefined ? b.name_en || null : row.name_en,
    b.category !== undefined ? b.category || null : row.category,
    b.cover_image !== undefined ? b.cover_image || null : row.cover_image,
    b.images !== undefined ? (Array.isArray(b.images) ? b.images.join(',') : b.images || null) : row.images,
    b.description !== undefined ? b.description || null : row.description,
    b.moq !== undefined ? Number(b.moq) || 1 : row.moq,
    b.lead_days !== undefined ? Number(b.lead_days) || 0 : row.lead_days,
    b.price_usd !== undefined ? round2(b.price_usd) : row.price_usd,
    b.visible_stock !== undefined ? (b.visible_stock ? 1 : 0) : row.visible_stock,
    b.tags !== undefined ? b.tags || null : row.tags,
    b.status || row.status,
    b.sort !== undefined ? Number(b.sort) || 0 : row.sort,
    now(), row.id
  );
  return ok(res, db.prepare('SELECT * FROM mall_products WHERE id = ?').get(row.id));
}));

router.post('/products/:id/status', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM mall_products WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '商城商品不存在');
  const to = String((req.body || {}).status || '');
  if (!['draft', 'published', 'off'].includes(to)) return fail(res, 400, '状态只能是 draft/published/off');
  db.prepare('UPDATE mall_products SET status=?, updated_at=? WHERE id=?').run(to, now(), row.id);
  return ok(res, { id: row.id, status: to });
}));

router.delete('/products/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const info = db.prepare('DELETE FROM mall_products WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, '商城商品不存在');
  return ok(res, { deleted: info.changes });
}));

// ---------------- 客户专属价 ----------------
router.get('/prices', authRequired, wrap(async (req, res) => {
  const cid = Number(req.query.customer_id) || 0;
  if (!cid) return fail(res, 400, '缺少 customer_id');
  const rows = db.prepare(
    `SELECT mp.*, p.name_cn, p.style_no, p.price_usd AS public_price
     FROM mall_prices mp JOIN mall_products p ON p.id = mp.mall_product_id
     WHERE mp.customer_id = ? ORDER BY mp.id DESC`
  ).all(cid);
  return ok(res, rows);
}));

router.post('/prices', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const cid = Number(b.customer_id);
  const pid = Number(b.mall_product_id);
  if (!cid || !pid) return fail(res, 400, '缺少客户或商品');
  if (!(Number(b.price_usd) > 0)) return fail(res, 400, '专属价必须大于 0');
  const t = now();
  const exist = db.prepare('SELECT id FROM mall_prices WHERE customer_id = ? AND mall_product_id = ?').get(cid, pid);
  if (exist) {
    db.prepare('UPDATE mall_prices SET price_usd=?, moq=?, updated_at=? WHERE id=?')
      .run(round2(b.price_usd), Number(b.moq) || null, t, exist.id);
  } else {
    db.prepare('INSERT INTO mall_prices (customer_id, mall_product_id, price_usd, moq, updated_at) VALUES (?,?,?,?,?)')
      .run(cid, pid, round2(b.price_usd), Number(b.moq) || null, t);
  }
  return ok(res, { customer_id: cid, mall_product_id: pid, price_usd: round2(b.price_usd) });
}));

router.delete('/prices/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const info = db.prepare('DELETE FROM mall_prices WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, '记录不存在');
  return ok(res, { deleted: info.changes });
}));

// ---------------- 询价单 ----------------
function inquiryFull(id) {
  const q = db.prepare(
    `SELECT q.*, c.name AS customer_name, c.code AS customer_code, o.order_no
     FROM mall_inquiries q LEFT JOIN customers c ON c.id = q.customer_id
     LEFT JOIN orders o ON o.id = q.order_id WHERE q.id = ?`
  ).get(id);
  if (!q) return null;
  q.items = db.prepare('SELECT * FROM mall_inquiry_items WHERE inquiry_id = ? ORDER BY id').all(id);
  q.status_label = INQUIRY_STATUS[q.status] || q.status;
  return q;
}

router.get('/inquiries', authRequired, wrap(async (req, res) => {
  const { status = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('q.status = ?'); params.push(status); }
  if (q) { where.push('(q.inquiry_no LIKE ? OR c.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT q.*, c.name AS customer_name FROM mall_inquiries q
     LEFT JOIN customers c ON c.id = q.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY q.id DESC LIMIT 200'
  ).all(...params);
  rows.forEach((r) => { r.status_label = INQUIRY_STATUS[r.status] || r.status; });
  return ok(res, rows);
}));

router.get('/inquiries/:id', authRequired, wrap(async (req, res) => {
  const q = inquiryFull(req.params.id);
  if (!q) return fail(res, 404, '询价单不存在');
  return ok(res, q);
}));

router.post('/inquiries/:id/quote', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const q = inquiryFull(req.params.id);
  if (!q) return fail(res, 404, '询价单不存在');
  if (!['submitted', 'quoted'].includes(q.status)) return fail(res, 400, '该询价单当前状态不可报价');
  const b = req.body || {};
  const priceMap = {};
  (Array.isArray(b.items) ? b.items : []).forEach((it) => {
    const price = Number(it.price_usd);
    if (price > 0) priceMap[Number(it.id)] = round2(price);
  });

  let totalUsd = 0;
  let totalQty = 0;
  db.exec('BEGIN');
  try {
    for (const it of q.items) {
      const price = priceMap[it.id] !== undefined ? priceMap[it.id] : Number(it.price_usd) || 0;
      const amount = round2(Number(it.qty) * price);
      db.prepare('UPDATE mall_inquiry_items SET price_usd=?, amount_usd=? WHERE id=?').run(price, amount, it.id);
      totalUsd = round2(totalUsd + amount);
      totalQty += Number(it.qty) || 0;
    }
    db.prepare(
      `UPDATE mall_inquiries SET status='quoted', total_usd=?, total_qty=?, sales_remark=?, quoted_by=?, quoted_at=?, updated_at=? WHERE id=?`
    ).run(totalUsd, totalQty, b.sales_remark || q.sales_remark || null,
      req.user.username, now(), now(), q.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  mall.pushMessage({
    customerId: q.customer_id,
    type: 'order',
    title: `询价单 ${q.inquiry_no} 已报价`,
    body: `业务员已完成报价，合计 $${totalUsd}。请在「我的询价」中查看并确认。${b.sales_remark ? ' 说明：' + b.sales_remark : ''}`,
    refType: 'inquiry',
    refId: q.id
  });

  return ok(res, inquiryFull(q.id));
}));

router.post('/inquiries/:id/convert', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const q = inquiryFull(req.params.id);
  if (!q) return fail(res, 404, '询价单不存在');
  if (q.status === 'converted') return fail(res, 400, '该询价单已转过订单');
  if (q.status !== 'confirmed') return fail(res, 400, '询价单尚未确认，不能转为销售订单');
  if (!q.items.length) return fail(res, 400, '询价单没有明细');

  const r = mall.convertInquiryToOrder(q, q.items, req.user.username);
  return ok(res, { ...r, inquiry: inquiryFull(q.id) });
}));

// ---------------- 客户账号 ----------------
router.get('/accounts', authRequired, wrap(async (req, res) => {
  const cid = Number(req.query.customer_id) || 0;
  const where = [];
  const params = [];
  if (cid) { where.push('a.customer_id = ?'); params.push(cid); }
  const rows = db.prepare(
    `SELECT a.id, a.customer_id, a.username, a.name, a.phone, a.email, a.role, a.status, a.last_login_at, a.created_at,
            a.perms, a.limit_perms, a.parent_id, a.approved_by, a.approved_at, a.must_change_pwd,
            c.name AS customer_name
     FROM customer_accounts a LEFT JOIN customers c ON c.id = a.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY a.id DESC'
  ).all(...params).map((a) => ({
    ...a,
    role_label: ROLE_LABEL[a.role] || a.role,
    perms: resolvePerms(a),
    perm_labels: resolvePerms(a).map((x) => PERMS[x] || x),
    limit_perms: resolveLimit(a),
    limit_labels: resolveLimit(a).map((x) => PERMS[x] || x)
  }));
  return ok(res, { rows, perm_dict: PERMS, role_presets: ROLE_PRESETS, sub_roles: SUB_ROLES });
}));

router.post('/accounts', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const cid = Number(b.customer_id);
  if (!cid) return fail(res, 400, '请选择客户');
  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(cid);
  if (!customer) return fail(res, 404, '客户不存在');
  const username = String(b.username || '').trim();
  if (!username || username.length < 4) return fail(res, 400, '登录账号至少 4 位');
  if (!b.password || String(b.password).length < 6) return fail(res, 400, '密码至少 6 位');
  if (db.prepare('SELECT 1 AS x FROM customer_accounts WHERE username = ?').get(username)) {
    return fail(res, 400, '该登录账号已存在');
  }
  const isFirst = !db.prepare('SELECT 1 AS x FROM customer_accounts WHERE customer_id = ?').get(cid);
  const role = isFirst ? 'owner' : (SUB_ROLES.includes(b.role) ? b.role : 'member');
  // 销售批准的权限上限：不传则按角色预设；主账号恒为全量
  const limit = Array.isArray(b.limit_perms) && b.limit_perms.length
    ? b.limit_perms.filter((x) => PERMS[x])
    : (role === 'owner' ? ALL_PERMS.slice() : (ROLE_PRESETS[role] || ROLE_PRESETS.member));
  const t0 = now();
  const info = db.prepare(
    `INSERT INTO customer_accounts (customer_id, username, password_hash, name, phone, email, role, status,
      perms, limit_perms, approved_by, approved_at, must_change_pwd, created_by, created_at)
     VALUES (?,?,?,?,?,?,?, 'active', ?,?,?,?, 1, ?, ?)`
  ).run(cid, username, hashPassword(String(b.password)), b.name || customer.name,
    b.phone || null, b.email || null, role,
    (role === 'owner' ? ALL_PERMS : limit).join(','), limit.join(','),
    req.user.username, t0, req.user.sub, t0);
  audit(Number(info.lastInsertRowid), cid, 'create', null,
    { username, role, limit_perms: limit, by: 'staff' }, req.user.username, 'staff', '业务员开通商城账号');

  mall.pushMessage({
    customerId: cid,
    type: 'system',
    title: '商城账号已开通',
    body: `你的商城登录账号为 ${username}，登录后可查看商品、提交选品询价并跟踪订单进度。`,
    refType: 'account',
    refId: Number(info.lastInsertRowid)
  });

  return ok(res, db.prepare('SELECT id, customer_id, username, name, role, status FROM customer_accounts WHERE id = ?')
    .get(Number(info.lastInsertRowid)));
}));

router.put('/accounts/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '账号不存在');
  const b = req.body || {};
  const status = ['active', 'disabled'].includes(b.status) ? b.status : row.status;
  const pwd = b.password ? hashPassword(String(b.password)) : row.password_hash;
  db.prepare('UPDATE customer_accounts SET name=?, phone=?, email=?, status=?, password_hash=? WHERE id=?')
    .run(b.name !== undefined ? b.name || null : row.name,
      b.phone !== undefined ? b.phone || null : row.phone,
      b.email !== undefined ? b.email || null : row.email,
      status, pwd, row.id);
  return ok(res, { id: row.id, status, password_reset: !!b.password });
}));


/** 批准 / 调整客户组织可用的权限上限（销售或管理员） */
router.post('/accounts/:id/approve', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const acc = db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(req.params.id);
  if (!acc) return fail(res, 404, '账号不存在');
  if (acc.role !== 'owner') return fail(res, 400, '权限上限只在主账号上设定，子账号由主账号在组织内分配');
  const b = req.body || {};
  const limit = Array.isArray(b.limit_perms) ? b.limit_perms.filter((x) => PERMS[x]) : [];
  if (!limit.length) return fail(res, 400, '至少要批准一个权限点');
  const before = { limit_perms: resolveLimit(acc) };
  db.prepare('UPDATE customer_accounts SET limit_perms = ?, approved_by = ?, approved_at = ? WHERE id = ?')
    .run(limit.join(','), req.user.username, now(), acc.id);
  // 已发出的子账号若超出新上限，同步收紧（销售收紧权限要立刻生效）
  const subs = db.prepare('SELECT * FROM customer_accounts WHERE customer_id = ? AND role != ?').all(acc.customer_id, 'owner');
  let tightened = 0;
  subs.forEach((sub) => {
    const cur = resolvePerms(sub);
    const next = cur.filter((x) => limit.includes(x));
    if (next.length !== cur.length) {
      db.prepare('UPDATE customer_accounts SET perms = ? WHERE id = ?').run(next.join(','), sub.id);
      audit(sub.id, sub.customer_id, 'perms', { perms: cur }, { perms: next }, req.user.username, 'staff', '被销售收紧的权限上限带动收缩');
      tightened++;
    }
  });
  audit(acc.id, acc.customer_id, 'approve', before, { limit_perms: limit, tightened }, req.user.username, 'staff', b.note || null);
  return ok(res, {
    id: acc.id, limit_perms: limit, limit_labels: limit.map((x) => PERMS[x] || x), tightened,
    notice: `已批准 ${limit.length} 个权限点${tightened ? '，并收紧了 ' + tightened + ' 个子账号' : ''}`
  });
}));

/** 发出邀请令牌（客户凭令牌自己注册，销售不用替客户设密码） */
router.post('/invites', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const cid = Number(b.customer_id);
  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(cid);
  if (!customer) return fail(res, 404, '客户不存在');
  const role = SUB_ROLES.includes(b.role) ? b.role : (b.role === 'owner' ? 'owner' : 'member');
  const owner = db.prepare("SELECT * FROM customer_accounts WHERE customer_id = ? AND role = 'owner' ORDER BY id LIMIT 1").get(cid);
  if (role === 'owner' && owner) return fail(res, 400, '该客户已有主账号，请发子账号邀请或让主账号自己开');
  if (!String(b.contact || '').trim()) return fail(res, 400, '请填核验用的联系方式（手机或邮箱）');

  // 邀请携带的权限不能超过销售批准的上限
  const limit = owner ? resolveLimit(owner) : (ROLE_PRESETS[role] || ROLE_PRESETS.member);
  const perms = role === 'owner' ? ALL_PERMS.slice() : (ROLE_PRESETS[role] || ROLE_PRESETS.member).filter((x) => limit.includes(x));

  const token = crypto.randomBytes(18).toString('hex');
  const t = now();
  const days = Number(b.days) > 0 && Number(b.days) <= 30 ? Number(b.days) : 7;
  const expires = new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const info = db.prepare(
    `INSERT INTO customer_invites (token, customer_id, role, perms, contact, invited_by, expires_at, status, note, created_at)
     VALUES (?,?,?,?,?,?,?, 'pending', ?, ?)`
  ).run(token, cid, role, perms.join(','), String(b.contact).trim(), req.user.username, expires, b.note || null, t);
  audit(null, cid, 'invite', null, { role, perms, contact: b.contact, expires_at: expires, invite_id: Number(info.lastInsertRowid) },
    req.user.username, 'staff', '发出邀请');
  return ok(res, {
    id: Number(info.lastInsertRowid),
    token,
    url: '/mall/invite/' + token,
    role, role_label: ROLE_LABEL[role], perms,
    expires_at: expires,
    notice: '把链接发给客户本人，由他自己设账号密码；令牌一次性，过期作废'
  });
}));

router.get('/invites', authRequired, wrap(async (req, res) => {
  const cid = Number(req.query.customer_id) || 0;
  const where = [];
  const params = [];
  if (cid) { where.push('i.customer_id = ?'); params.push(cid); }
  const rows = db.prepare(
    `SELECT i.*, c.name AS customer_name, a.username AS used_by_username
     FROM customer_invites i
     LEFT JOIN customers c ON c.id = i.customer_id
     LEFT JOIN customer_accounts a ON a.id = i.used_by_account_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY i.id DESC LIMIT 100'
  ).all(...params).map((r) => {
    const expired = r.status === 'pending' && r.expires_at < now();
    return {
      ...r,
      token_masked: r.token.slice(0, 6) + '…' + r.token.slice(-4),
      role_label: ROLE_LABEL[r.role] || r.role,
      status: expired ? 'expired' : r.status,
      status_label: { pending: '待使用', used: '已使用', revoked: '已撤回', expired: '已过期' }[expired ? 'expired' : r.status] || r.status
    };
  });
  return ok(res, rows);
}));

router.post('/invites/:id/revoke', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const inv = db.prepare('SELECT * FROM customer_invites WHERE id = ?').get(req.params.id);
  if (!inv) return fail(res, 404, '邀请不存在');
  if (inv.status !== 'pending') return fail(res, 400, `邀请状态是「${inv.status}」，不能撤回`);
  db.prepare("UPDATE customer_invites SET status = 'revoked' WHERE id = ?").run(inv.id);
  audit(null, inv.customer_id, 'invite', { status: 'pending' }, { status: 'revoked' }, req.user.username, 'staff', '撤回邀请');
  return ok(res, { id: inv.id, status: 'revoked' });
}));

/** 客户授权审计（销售/管理员可查，只读） */
router.get('/account-audits', authRequired, wrap(async (req, res) => {
  const cid = Number(req.query.customer_id) || 0;
  const where = [];
  const params = [];
  if (cid) { where.push('a.customer_id = ?'); params.push(cid); }
  const rows = db.prepare(
    `SELECT a.*, acc.username, c.name AS customer_name FROM customer_account_audits a
     LEFT JOIN customer_accounts acc ON acc.id = a.account_id
     LEFT JOIN customers c ON c.id = a.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY a.id DESC LIMIT 200'
  ).all(...params);
  const LABEL = {
    create: '开通账号', perms: '调整权限', disable: '停用', enable: '启用',
    reset_pwd: '重置密码', approve: '批准权限上限', invite: '邀请', accept_invite: '接受邀请', login_fail: '登录失败'
  };
  return ok(res, rows.map((r) => ({
    ...r,
    action_label: LABEL[r.action] || r.action,
    scope_label: r.operator_scope === 'customer' ? '客户侧' : r.operator_scope === 'system' ? '系统' : '业务员'
  })));
}));

// ---------------- 通知 ----------------
router.post('/notify', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.customer_id) return fail(res, 400, '请选择客户');
  if (!b.title) return fail(res, 400, '标题必填');
  const id = mall.pushMessage({
    customerId: Number(b.customer_id),
    type: b.type || 'promo',
    title: b.title,
    body: b.body || null
  });
  return ok(res, { id });
}));

// ---------------- 概览 ----------------
router.get('/stats', authRequired, wrap(async (req, res) => {
  const products = db.prepare("SELECT COUNT(*) c FROM mall_products WHERE status='published'").get().c;
  const accounts = db.prepare("SELECT COUNT(*) c FROM customer_accounts WHERE status='active'").get().c;
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM mall_inquiries GROUP BY status').all();
  const map = {};
  byStatus.forEach((r) => { map[r.status] = Number(r.c); });
  const pending = Number(map.submitted || 0);
  const quoted = Number(map.quoted || 0);
  const converted = Number(map.converted || 0);
  const amount = Number(db.prepare('SELECT COALESCE(SUM(total_usd),0) s FROM mall_inquiries').get().s) || 0;
  const unreadMsg = Number(db.prepare('SELECT COUNT(*) c FROM mall_messages WHERE read_at IS NULL').get().c);
  return ok(res, {
    products: Number(products),
    accounts: Number(accounts),
    inquiries: { submitted: pending, quoted, converted, total: byStatus.reduce((s, r) => s + Number(r.c), 0) },
    amount_usd: round2(amount),
    messages_unread: unreadMsg,
    conversion: byStatus.reduce((s, r) => s + Number(r.c), 0) > 0
      ? round2((converted / byStatus.reduce((s, r) => s + Number(r.c), 0)) * 100)
      : 0
  });
}));

module.exports = router;
