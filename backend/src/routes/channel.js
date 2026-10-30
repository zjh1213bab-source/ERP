/**
 * 零售与渠道（对齐原型 TS-M04，4 项能力）
 * ------------------------------------------------------------
 * N04-01 平台与主体映射：一个公司可开多店、一个店可跨主体，映射关系显式登记，
 *        外部接口授权状态单独跟踪（未授权不得当作已对接）。
 * N04-02 零售订单与支付核对：单件为独立履约模式；支付/退款/结算三个状态互相独立，
 *        支付未核对不得释放拣配（硬门槛）。
 * N04-03 批零库存配额与承诺：配额只是「可卖上限」，不是第二份实物；
 *        可分配 = min(渠道限额 - 已预留, 该货主实物可用量)，两者取小。
 * N04-04 渠道费率与经营损益：商品毛利之外再扣平台费/广告/履约费得「贡献」，
 *        预估与账单确认分开标识，差异留痕。
 *
 * 所有数量变动都走 services/stockOps，与仓库/美仓发货同一套口径。
 */
const express = require('express');
const { db, now, getSettings } = require('../db');
const { nextNo } = require('../utils/docNo');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { round2, applyStock, addLedger, availableQty } = require('../services/stockOps');

const router = express.Router();
const WRITE = ['admin', 'sales', 'finance'];

const PLATFORMS = {
  amazon: 'Amazon', etsy: 'Etsy', shopify: 'Shopify 独立站',
  tiktok: 'TikTok Shop', alibaba: '阿里国际站', other: '其他'
};
const API_STATUS = { unauthorized: '未授权', authorized: '已授权', limited: '受限' };
const PAY_STATUS = { pending: '支付待核', checked: '回执已核', mismatch: '核对异常' };
const FULFILL_STATUS = { waiting: '待预留', reserved: '已预留', shortage: '缺货待补', shipped: '已发货', cancelled: '已取消' };
const SETTLE_STATUS = { unsettled: '未结算', settled: '已结算' };
const AS_TYPE = { refund: '仅退款', return: '退货退款', exchange: '换货' };
const REFUND_STATUS = { draft: '草稿', processing: '处理中', done: '已退款', rejected: '已驳回' };
const RETURN_STATUS = { none: '无需退回', pending: '待退回', received: '已收到' };
const MODE = { agency: '总部代理零售', direct: '直营' };
const STL_STATUS = { draft: '草稿', confirmed: '账单已确认', diff: '有差异' };

function csv(res, filename, header, rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send('\ufeff' + lines.join('\r\n'));
}

function rate() {
  const s = getSettings();
  return Number(s.exchangeRate) || 6.5;
}

// ============================================================
// N04-01 平台与主体映射
// ============================================================
function shopView(r) {
  return {
    ...r,
    platform_label: PLATFORMS[r.platform] || r.platform,
    api_label: API_STATUS[r.api_status] || r.api_status,
    warehouse_label: r.warehouse === 'us' ? '美仓' : '生产仓'
  };
}

router.get('/meta', authRequired, wrap(async (req, res) => {
  return ok(res, {
    platforms: Object.entries(PLATFORMS).map(([k, v]) => ({ value: k, label: v })),
    api_status: Object.entries(API_STATUS).map(([k, v]) => ({ value: k, label: v })),
    pay_status: Object.entries(PAY_STATUS).map(([k, v]) => ({ value: k, label: v })),
    fulfill_status: Object.entries(FULFILL_STATUS).map(([k, v]) => ({ value: k, label: v })),
    as_type: Object.entries(AS_TYPE).map(([k, v]) => ({ value: k, label: v })),
    mode: Object.entries(MODE).map(([k, v]) => ({ value: k, label: v })),
    rate: rate()
  });
}));

router.get('/shops', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.platform) { cond.push('platform = ?'); params.push(req.query.platform); }
  if (req.query.status) { cond.push('status = ?'); params.push(req.query.status); }
  if (req.query.q) {
    cond.push('(shop_name LIKE ? OR code LIKE ? OR company LIKE ? OR contract_party LIKE ?)');
    const kw = `%${req.query.q}%`;
    params.push(kw, kw, kw, kw);
  }
  const rows = db.prepare(
    `SELECT * FROM channel_shops ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC`
  ).all(...params);

  // 每店订单数与金额，便于判断店铺是否真的在用
  const stat = db.prepare(
    `SELECT shop_id, COUNT(*) AS cnt, COALESCE(SUM(paid_amount),0) AS paid
     FROM retail_orders GROUP BY shop_id`
  ).all();
  const map = {};
  stat.forEach((s) => { map[s.shop_id] = s; });
  return ok(res, rows.map((r) => ({
    ...shopView(r),
    order_count: map[r.id] ? Number(map[r.id].cnt) : 0,
    paid_total: map[r.id] ? round2(map[r.id].paid) : 0
  })));
}));

router.post('/shops', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.shop_name || !String(b.shop_name).trim()) return fail(res, 400, '店铺名称必填');
  const t = now();
  const r = db.prepare(
    `INSERT INTO channel_shops (code, platform, shop_name, company, reg_license, contract_party, invoice_party,
       payee_party, warehouse, currency, api_status, api_note, fee_rate, status, remark, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.code || null, b.platform || 'other', String(b.shop_name).trim(), b.company || null, b.reg_license || null,
    b.contract_party || null, b.invoice_party || null, b.payee_party || null,
    b.warehouse || 'us', b.currency || 'USD', b.api_status || 'unauthorized', b.api_note || null,
    Number(b.fee_rate) || 0, b.status || 'active', b.remark || null, t, t
  );
  return ok(res, shopView(db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(r.lastInsertRowid)));
}));

router.put('/shops/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '店铺不存在');
  const b = req.body || {};
  db.prepare(
    `UPDATE channel_shops SET code=?, platform=?, shop_name=?, company=?, reg_license=?, contract_party=?,
       invoice_party=?, payee_party=?, warehouse=?, currency=?, api_status=?, api_note=?, fee_rate=?,
       status=?, remark=?, updated_at=? WHERE id=?`
  ).run(
    b.code ?? row.code, b.platform || row.platform, b.shop_name || row.shop_name,
    b.company ?? row.company, b.reg_license ?? row.reg_license, b.contract_party ?? row.contract_party,
    b.invoice_party ?? row.invoice_party, b.payee_party ?? row.payee_party,
    b.warehouse || row.warehouse, b.currency || row.currency,
    b.api_status || row.api_status, b.api_note ?? row.api_note,
    b.fee_rate !== undefined ? Number(b.fee_rate) || 0 : row.fee_rate,
    b.status || row.status, b.remark ?? row.remark, now(), req.params.id
  );
  return ok(res, shopView(db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(req.params.id)));
}));

/** 核查接口授权：必须人工确认才能改成已授权，避免「以为对接了」 */
router.post('/shops/:id/verify', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '店铺不存在');
  const status = req.body && req.body.api_status;
  if (!API_STATUS[status]) return fail(res, 400, '授权状态应为 unauthorized / authorized / limited');
  db.prepare('UPDATE channel_shops SET api_status=?, api_note=?, updated_at=? WHERE id=?')
    .run(status, (req.body && req.body.api_note) || row.api_note, now(), row.id);
  return ok(res, shopView(db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(row.id)));
}));

router.delete('/shops/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM retail_orders WHERE shop_id = ?').get(req.params.id).c;
  if (Number(cnt) > 0) return fail(res, 400, '该店铺已有零售订单，不能删除，请改为「暂停」');
  db.prepare('DELETE FROM channel_shops WHERE id = ?').run(req.params.id);
  return ok(res, { deleted: 1 });
}));

// ============================================================
// N04-02 零售订单与支付核对
// ============================================================
function retailItems(id) {
  return db.prepare('SELECT * FROM retail_order_items WHERE retail_id = ? ORDER BY id').all(id);
}

function retailFull(id) {
  const r = db.prepare(
    `SELECT r.*, s.shop_name, s.platform, s.warehouse, s.fee_rate
     FROM retail_orders r LEFT JOIN channel_shops s ON s.id = r.shop_id WHERE r.id = ?`
  ).get(id);
  if (!r) return null;
  const items = retailItems(id);
  const as = db.prepare('SELECT * FROM retail_after_sales WHERE retail_id = ? ORDER BY id DESC').all(id);
  const cost = items.reduce((s, i) => s + Number(i.cost || 0) * Number(i.qty || 0), 0);
  return {
    ...r,
    platform_label: PLATFORMS[r.platform] || r.platform,
    mode_label: MODE[r.mode] || r.mode,
    pay_label: PAY_STATUS[r.pay_status] || r.pay_status,
    fulfill_label: FULFILL_STATUS[r.fulfill_status] || r.fulfill_status,
    settle_label: SETTLE_STATUS[r.settle_status] || r.settle_status,
    items,
    after_sales: as.map((a) => ({
      ...a,
      type_label: AS_TYPE[a.type] || a.type,
      refund_label: REFUND_STATUS[a.refund_status] || a.refund_status,
      return_label: RETURN_STATUS[a.return_status] || a.return_status
    })),
    total_qty: items.reduce((s, i) => s + Number(i.qty || 0), 0),
    cost_amount: round2(cost),
    gross_profit: round2(Number(r.paid_amount) - Number(r.refund_amount) - cost)
  };
}

router.get('/retail-orders', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  const q = req.query;
  if (q.shop_id) { cond.push('r.shop_id = ?'); params.push(Number(q.shop_id)); }
  if (q.pay_status) { cond.push('r.pay_status = ?'); params.push(q.pay_status); }
  if (q.fulfill_status) { cond.push('r.fulfill_status = ?'); params.push(q.fulfill_status); }
  if (q.from) { cond.push('r.order_date >= ?'); params.push(q.from); }
  if (q.to) { cond.push('r.order_date <= ?'); params.push(q.to); }
  if (q.q) {
    cond.push('(r.channel_order_no LIKE ? OR r.retail_no LIKE ? OR r.receiver LIKE ?)');
    const kw = `%${q.q}%`;
    params.push(kw, kw, kw);
  }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT r.*, s.shop_name, s.platform FROM retail_orders r
     LEFT JOIN channel_shops s ON s.id = r.shop_id
     ${where} ORDER BY r.id DESC LIMIT 300`
  ).all(...params);

  const itemStmt = db.prepare(
    'SELECT sku, style_no, name, color, size, qty FROM retail_order_items WHERE retail_id = ? ORDER BY id'
  );
  const list = rows.map((r) => {
    const items = itemStmt.all(r.id);
    return {
      ...r,
      platform_label: PLATFORMS[r.platform] || r.platform,
      mode_label: MODE[r.mode] || r.mode,
      pay_label: PAY_STATUS[r.pay_status] || r.pay_status,
      fulfill_label: FULFILL_STATUS[r.fulfill_status] || r.fulfill_status,
      sku_text: items.map((i) => i.sku || i.style_no).filter(Boolean).slice(0, 3).join(' / '),
      total_qty: items.reduce((s, i) => s + Number(i.qty || 0), 0)
    };
  });
  return ok(res, list);
}));

router.get('/retail-orders/export', authRequired, wrap(async (req, res) => {
  const rows = db.prepare(
    `SELECT r.*, s.shop_name FROM retail_orders r LEFT JOIN channel_shops s ON s.id = r.shop_id ORDER BY r.id DESC`
  ).all();
  return csv(res, 'retail-orders.csv',
    ['内部单号', '渠道订单号', '店铺', '经营主体', '模式', '日期', '币种', '商品金额', '优惠', '税费', '运费', '实付', '已退款', '支付核对', '履约', '结算'],
    rows.map((r) => [r.retail_no, r.channel_order_no, r.shop_name || '', r.company || '', MODE[r.mode] || r.mode,
      r.order_date || '', r.currency, r.goods_amount, r.discount, r.tax, r.shipping_fee, r.paid_amount, r.refund_amount,
      PAY_STATUS[r.pay_status] || r.pay_status, FULFILL_STATUS[r.fulfill_status] || r.fulfill_status,
      SETTLE_STATUS[r.settle_status] || r.settle_status]));
}));

router.get('/retail-orders/:id', authRequired, wrap(async (req, res) => {
  const r = retailFull(req.params.id);
  if (!r) return fail(res, 404, '零售订单不存在');
  return ok(res, r);
}));

/**
 * 新建零售订单
 * 支持一次传多行明细（同一渠道订单拆成多个 SKU 行）
 */
router.post('/retail-orders', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.shop_id) return fail(res, 400, '请选择店铺');
  if (!b.channel_order_no || !String(b.channel_order_no).trim()) return fail(res, 400, '渠道订单号必填');
  const shop = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(b.shop_id);
  if (!shop) return fail(res, 404, '店铺不存在');
  if (shop.status !== 'active') return fail(res, 400, '店铺已暂停，不能接单');
  const items = Array.isArray(b.items) ? b.items.filter((i) => i && (i.qty || i.sku || i.style_no)) : [];
  if (!items.length && !b.goods_amount) return fail(res, 400, '请至少填一行商品明细');

  const dup = db.prepare('SELECT id FROM retail_orders WHERE shop_id = ? AND channel_order_no = ?')
    .get(b.shop_id, String(b.channel_order_no).trim());
  if (dup) return fail(res, 400, `该店铺下渠道订单号「${b.channel_order_no}」已存在`);

  const t = now();
  const goods = items.length
    ? items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0), 0)
    : Number(b.goods_amount) || 0;
  const discount = Number(b.discount) || 0;
  const tax = Number(b.tax) || 0;
  const ship = Number(b.shipping_fee) || 0;
  const paid = b.paid_amount !== undefined && b.paid_amount !== null && b.paid_amount !== ''
    ? Number(b.paid_amount) || 0
    : round2(goods - discount + tax + ship);

  const retailNo = nextNo('RT', 'retail_orders', 'retail_no');
  let newId = null;
  try {
    db.exec('BEGIN');
    const r = db.prepare(
      `INSERT INTO retail_orders (retail_no, channel_order_no, shop_id, company, mode, order_date, currency, rate,
         goods_amount, discount, tax, shipping_fee, paid_amount, pay_status, receiver, address, remark, created_by,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(retailNo, String(b.channel_order_no).trim(), shop.id, b.company || shop.company || null,
      b.mode || 'agency', b.order_date || t.slice(0, 10), b.currency || shop.currency || 'USD', rate(),
      round2(goods), discount, tax, ship, round2(paid), 'pending', b.receiver || null, b.address || null,
      b.remark || null, req.user.username, t, t);
    const id = Number(r.lastInsertRowid);
    const insItem = db.prepare(
      `INSERT INTO retail_order_items (retail_id, sku, style_no, product_id, name, color, size, qty, price, amount, cost)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    items.forEach((i) => {
      const qty = Number(i.qty) || 1;
      const price = Number(i.price) || 0;
      insItem.run(id, i.sku || null, i.style_no || i.sku || null, i.product_id || null, i.name || null,
        i.color || null, i.size || null, qty, price, round2(price * qty), Number(i.cost) || 0);
    });
    db.exec('COMMIT');
    newId = id;
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, retailFull(newId));
}));

/**
 * 受控批量导入：逐行导入渠道订单行，按 (店铺, 渠道订单号) 幂等
 * rows: [{ shop_code|shop_id, channel_order_no, sku, style_no, qty, price, paid_amount, order_date, receiver }]
 */
router.post('/retail-orders/import', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return fail(res, 400, '导入内容为空');

  const groups = {};
  const errors = [];
  rows.forEach((r, idx) => {
    const line = idx + 2; // 表头占 1 行
    const shopId = r.shop_id
      ? Number(r.shop_id)
      : (db.prepare('SELECT id FROM channel_shops WHERE code = ?').get(r.shop_code || '') || {}).id;
    if (!shopId) { errors.push(`第 ${line} 行：店铺编码「${r.shop_code || ''}」不存在`); return; }
    const no = String(r.channel_order_no || '').trim();
    if (!no) { errors.push(`第 ${line} 行：渠道订单号为空`); return; }
    const key = shopId + '|' + no;
    if (!groups[key]) {
      groups[key] = {
        shop_id: shopId, channel_order_no: no, order_date: r.order_date || null,
        paid_amount: r.paid_amount === '' || r.paid_amount === undefined ? null : Number(r.paid_amount),
        receiver: r.receiver || null, items: []
      };
    }
    groups[key].items.push({
      sku: r.sku || null, style_no: r.style_no || r.sku || null, name: r.name || null,
      color: r.color || null, size: r.size || null,
      qty: Number(r.qty) || 1, price: Number(r.price) || 0, cost: Number(r.cost) || 0
    });
  });

  let inserted = 0;
  let skipped = 0;
  const t = now();
  try {
    db.exec('BEGIN');
    Object.values(groups).forEach((g) => {
      const exist = db.prepare('SELECT id FROM retail_orders WHERE shop_id = ? AND channel_order_no = ?')
        .get(g.shop_id, g.channel_order_no);
      if (exist) { skipped++; return; }
      const shop = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(g.shop_id);
      const goods = g.items.reduce((s, i) => s + i.price * i.qty, 0);
      const paid = g.paid_amount === null || g.paid_amount === undefined ? goods : g.paid_amount;
      const no = nextNo('RT', 'retail_orders', 'retail_no');
      const r = db.prepare(
        `INSERT INTO retail_orders (retail_no, channel_order_no, shop_id, company, mode, order_date, currency, rate,
           goods_amount, discount, tax, shipping_fee, paid_amount, pay_status, receiver, remark, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(no, g.channel_order_no, g.shop_id, shop.company || null, 'agency',
        g.order_date || t.slice(0, 10), shop.currency || 'USD', rate(),
        round2(goods), 0, 0, 0, round2(paid), 'pending', g.receiver, '受控导入', req.user.username, t, t);
      const id = Number(r.lastInsertRowid);
      const insItem = db.prepare(
        `INSERT INTO retail_order_items (retail_id, sku, style_no, name, color, size, qty, price, amount, cost)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      g.items.forEach((i) => insItem.run(id, i.sku, i.style_no, i.name, i.color, i.size,
        i.qty, i.price, round2(i.price * i.qty), i.cost));
      inserted++;
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, '导入失败（已回滚）：' + e.message);
  }

  return ok(res, { inserted, skipped, errors });
}));

/** 核对支付回执：只有 checked 才允许释放拣配 */
router.post('/retail-orders/:id/check-pay', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '零售订单不存在');
  if (row.fulfill_status === 'shipped') return fail(res, 400, '已发货订单不能再改支付核对状态');
  const b = req.body || {};
  const action = b.action || 'check'; // check 核对通过 / mismatch 标记异常
  if (!['check', 'mismatch'].includes(action)) return fail(res, 400, 'action 应为 check 或 mismatch');

  if (action === 'check') {
    const paid = b.paid_amount !== undefined && b.paid_amount !== null && b.paid_amount !== ''
      ? Number(b.paid_amount) : Number(row.paid_amount);
    // 实付与回执金额不一致时不允许直接标记已核，必须走异常
    if (b.receipt_amount !== undefined && b.receipt_amount !== null && b.receipt_amount !== '') {
      const rec = Number(b.receipt_amount) || 0;
      if (Math.abs(rec - paid) > 0.01) {
        return fail(res, 400, `回执金额 ${rec} 与订单实付 ${paid} 不一致，请标记为核对异常`);
      }
    }
    db.prepare('UPDATE retail_orders SET pay_status=?, pay_ref=?, paid_amount=?, pay_checked_at=?, updated_at=? WHERE id=?')
      .run('checked', b.pay_ref || row.pay_ref, round2(paid), now(), now(), row.id);
  } else {
    db.prepare('UPDATE retail_orders SET pay_status=?, pay_ref=?, pay_checked_at=?, remark=COALESCE(?, remark), updated_at=? WHERE id=?')
      .run('mismatch', b.pay_ref || row.pay_ref, now(), b.reason || null, now(), row.id);
  }
  return ok(res, retailFull(row.id));
}));

// ---------- 配额计算：配额不是第二份实物 ----------
function quotaOf(shopId, styleNo, owner) {
  return db.prepare('SELECT * FROM channel_quotas WHERE shop_id=? AND style_no=? AND owner=?')
    .get(shopId, styleNo || '', owner || '总部货主');
}

/** 同一货主该款被所有渠道预留的总量（批零共享同一批实物） */
function reservedAllShops(styleNo, owner) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(reserved),0) AS q FROM channel_quotas WHERE style_no=? AND owner=?'
  ).get(styleNo || '', owner || '总部货主');
  return round2(r.q);
}

function quotaCalc(q, shop) {
  const warehouse = shop ? shop.warehouse : 'us';
  const stock = availableQty(warehouse, q.style_no);
  const reservedAll = reservedAllShops(q.style_no, q.owner);
  const free = Math.max(0, round2(stock - reservedAll));
  const roomByLimit = Math.max(0, round2(Number(q.channel_limit) - Number(q.reserved)));
  // 可再承诺 = min(限额剩余, 实物剩余)；超过限额即为超额承诺
  const allocatable = Math.min(roomByLimit, free);
  return {
    stock,                 // 合格上架（该货主实物可用量，跨渠道共用）
    reserved_all: reservedAll,
    free,
    room_by_limit: roomByLimit,
    allocatable,
    over_limit: Number(q.reserved) > Number(q.channel_limit),
    shortage: Math.max(0, round2(Number(q.reserved) - stock))
  };
}

// ============================================================
// N04-03 批零库存配额与承诺
// ============================================================
router.get('/quotas', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.shop_id) { cond.push('q.shop_id = ?'); params.push(Number(req.query.shop_id)); }
  if (req.query.status) { cond.push('q.status = ?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT q.*, s.shop_name, s.warehouse, s.platform FROM channel_quotas q
     LEFT JOIN channel_shops s ON s.id = q.shop_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY q.id DESC`
  ).all(...params);
  return ok(res, rows.map((q) => ({ ...q, ...quotaCalc(q, { warehouse: q.warehouse }) })));
}));

/** 提交配额调整（先草稿，人工启用后才约束下单） */
router.post('/quotas', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.shop_id) return fail(res, 400, '请选择店铺');
  if (!b.style_no) return fail(res, 400, '款号必填');
  const shop = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(b.shop_id);
  if (!shop) return fail(res, 404, '店铺不存在');
  const limit = Number(b.channel_limit) || 0;
  if (limit < 0) return fail(res, 400, '渠道限额不能为负');
  const owner = b.owner || '总部货主';
  const t = now();
  const exist = quotaOf(b.shop_id, b.style_no, owner);
  if (exist) {
    if (Number(b.channel_limit) < Number(exist.reserved)) {
      return fail(res, 400, `渠道限额 ${limit} 低于已预留 ${exist.reserved}，请先释放预留再下调`);
    }
    db.prepare(
      'UPDATE channel_quotas SET channel_limit=?, product_name=COALESCE(?, product_name), pre_sale_date=?, status=?, remark=?, updated_at=? WHERE id=?'
    ).run(limit, b.product_name || null, b.pre_sale_date || exist.pre_sale_date,
      b.status || exist.status, b.remark ?? exist.remark, t, exist.id);
    const q = db.prepare('SELECT * FROM channel_quotas WHERE id = ?').get(exist.id);
    return ok(res, { ...q, ...quotaCalc(q, shop), created: false });
  }
  const planNo = nextNo('QP', 'channel_quotas', 'plan_no');
  const r = db.prepare(
    `INSERT INTO channel_quotas (plan_no, shop_id, style_no, product_name, owner, channel_limit, reserved,
       pre_sale_date, status, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(planNo, shop.id, b.style_no, b.product_name || null, owner, limit, 0,
    b.pre_sale_date || null, b.status || 'active', b.remark || null, req.user.username, t, t);
  const q = db.prepare('SELECT * FROM channel_quotas WHERE id = ?').get(r.lastInsertRowid);
  return ok(res, { ...q, ...quotaCalc(q, shop), created: true });
}));

/** 占用明细：谁占了这个款 */
router.get('/quotas/:id/usage', authRequired, wrap(async (req, res) => {
  const q = db.prepare('SELECT * FROM channel_quotas WHERE id = ?').get(req.params.id);
  if (!q) return fail(res, 404, '配额记录不存在');
  const rows = db.prepare(
    `SELECT r.id, r.retail_no, r.channel_order_no, r.fulfill_status, r.pay_status, r.order_date,
            i.sku, i.style_no, i.color, i.size, i.qty
     FROM retail_orders r JOIN retail_order_items i ON i.retail_id = r.id
     WHERE r.shop_id = ? AND i.style_no = ? AND r.fulfill_status IN ('reserved','shortage','shipped')
     ORDER BY r.id DESC`
  ).all(q.shop_id, q.style_no);
  return ok(res, {
    quota: q,
    rows: rows.map((r) => ({
      ...r,
      fulfill_label: FULFILL_STATUS[r.fulfill_status] || r.fulfill_status,
      pay_label: PAY_STATUS[r.pay_status] || r.pay_status
    })),
    total_qty: rows.reduce((s, r) => s + Number(r.qty || 0), 0)
  });
}));

/** 重算预留：以未发货零售单的实际占用为准，修正手工误差 */
router.post('/quotas/:id/sync', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const q = db.prepare('SELECT * FROM channel_quotas WHERE id = ?').get(req.params.id);
  if (!q) return fail(res, 404, '配额记录不存在');
  const used = db.prepare(
    `SELECT COALESCE(SUM(i.qty),0) AS q FROM retail_orders r JOIN retail_order_items i ON i.retail_id = r.id
     WHERE r.shop_id = ? AND i.style_no = ? AND r.fulfill_status IN ('reserved','shortage')`
  ).get(q.shop_id, q.style_no).q;
  db.prepare('UPDATE channel_quotas SET reserved=?, updated_at=? WHERE id=?').run(round2(used), now(), q.id);
  const shop = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(q.shop_id);
  const next = db.prepare('SELECT * FROM channel_quotas WHERE id = ?').get(q.id);
  return ok(res, { ...next, ...quotaCalc(next, shop) });
}));

/** 预留：只占承诺，不动物理库存 */
router.post('/retail-orders/:id/reserve', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '零售订单不存在');
  if (row.fulfill_status === 'shipped') return fail(res, 400, '已发货，无需再预留');
  if (row.pay_status !== 'checked') return fail(res, 400, '支付回执未核对，不能释放拣配');
  const items = retailItems(row.id);
  if (!items.length) return fail(res, 400, '订单无明细');

  const shop = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(row.shop_id);
  const problems = [];
  try {
    db.exec('BEGIN');
    // 先整体校验，避免部分预留
    items.forEach((i) => {
      const q = quotaOf(row.shop_id, i.style_no, '总部货主');
      if (!q) { problems.push(`${i.style_no}：该店铺未配置渠道配额`); return; }
      if (q.status !== 'active') { problems.push(`${i.style_no}：配额已暂停`); return; }
      const c = quotaCalc(q, shop);
      if (Number(i.qty) > c.allocatable) {
        problems.push(`${i.style_no}：需 ${i.qty}，可分配 ${c.allocatable}（限额剩余 ${c.room_by_limit}，实物可用 ${c.free}）`);
      }
    });
    if (problems.length) throw new Error(problems.join('；'));
    items.forEach((i) => {
      db.prepare('UPDATE channel_quotas SET reserved = reserved + ?, updated_at=? WHERE shop_id=? AND style_no=? AND owner=?')
        .run(Number(i.qty), now(), row.shop_id, i.style_no, '总部货主');
    });
    db.prepare('UPDATE retail_orders SET fulfill_status=?, updated_at=? WHERE id=?').run('reserved', now(), row.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, retailFull(row.id));
}));

/** 发货：校验支付已核 → 扣美仓实物 → 释放预留 → 写流水 */
router.post('/retail-orders/:id/ship', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '零售订单不存在');
  if (row.fulfill_status === 'shipped') return fail(res, 400, '该订单已发货');
  if (row.fulfill_status === 'cancelled') return fail(res, 400, '该订单已取消');
  if (row.pay_status !== 'checked') return fail(res, 400, '支付回执未核对，不能发货（不释放拣配）');
  const items = retailItems(row.id);
  if (!items.length) return fail(res, 400, '订单无明细');
  const shop = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(row.shop_id);
  const warehouse = (req.body && req.body.warehouse) || shop.warehouse || 'us';

  try {
    db.exec('BEGIN');
    items.forEach((i) => {
      applyStock({
        warehouse, style_no: i.style_no, product_name: i.name,
        color: i.color, size: i.size, delta: -Number(i.qty)
      });
      addLedger({
        warehouse, style_no: i.style_no, product_name: i.name, color: i.color, size: i.size,
        type: 'out', qty: -Number(i.qty), ref_type: 'retail', ref_id: row.id,
        remark: `零售发货 ${row.retail_no}`, operator: req.user.username
      });
      // 释放该款预留（若之前预留过）
      const q = quotaOf(row.shop_id, i.style_no, '总部货主');
      if (q) {
        const next = Math.max(0, round2(Number(q.reserved) - Number(i.qty)));
        db.prepare('UPDATE channel_quotas SET reserved=?, updated_at=? WHERE id=?').run(next, now(), q.id);
      }
    });
    db.prepare('UPDATE retail_orders SET fulfill_status=?, updated_at=? WHERE id=?').run('shipped', now(), row.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    // 库存不足：标记缺货待补，保留订单等补货，不静默失败
    if (/库存不足/.test(e.message)) {
      db.prepare('UPDATE retail_orders SET fulfill_status=?, remark=COALESCE(remark||char(10),\' \')||?, updated_at=? WHERE id=?')
        .run('shortage', `[缺货] ${e.message}`, now(), row.id);
      return fail(res, 400, `${e.message}；已标记为「缺货待补」，补货后可再发货`);
    }
    return fail(res, 400, e.message);
  }
  return ok(res, retailFull(row.id));
}));

router.post('/retail-orders/:id/cancel', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '零售订单不存在');
  if (row.fulfill_status === 'shipped') return fail(res, 400, '已发货订单不能取消，请走售后');
  const items = retailItems(row.id);
  try {
    db.exec('BEGIN');
    // 释放已占预留
    if (row.fulfill_status === 'reserved') {
      items.forEach((i) => {
        const q = quotaOf(row.shop_id, i.style_no, '总部货主');
        if (q) {
          const next = Math.max(0, round2(Number(q.reserved) - Number(i.qty)));
          db.prepare('UPDATE channel_quotas SET reserved=?, updated_at=? WHERE id=?').run(next, now(), q.id);
        }
      });
    }
    db.prepare('UPDATE retail_orders SET fulfill_status=?, remark=COALESCE(?, remark), updated_at=? WHERE id=?')
      .run('cancelled', (req.body && req.body.reason) || null, now(), row.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, retailFull(row.id));
}));

// ============================================================
// 售后：退款与实物退回各自独立
// ============================================================
router.get('/after-sales', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.refund_status) { cond.push('a.refund_status = ?'); params.push(req.query.refund_status); }
  if (req.query.return_status) { cond.push('a.return_status = ?'); params.push(req.query.return_status); }
  const rows = db.prepare(
    `SELECT a.*, r.retail_no, r.channel_order_no, r.currency FROM retail_after_sales a
     LEFT JOIN retail_orders r ON r.id = a.retail_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 300`
  ).all(...params);
  return ok(res, rows.map((a) => ({
    ...a,
    type_label: AS_TYPE[a.type] || a.type,
    refund_label: REFUND_STATUS[a.refund_status] || a.refund_status,
    return_label: RETURN_STATUS[a.return_status] || a.return_status
  })));
}));

router.post('/after-sales', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.retail_id) return fail(res, 400, '请选择零售订单');
  const retail = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(b.retail_id);
  if (!retail) return fail(res, 404, '零售订单不存在');
  if (retail.fulfill_status !== 'shipped' && b.type === 'return') {
    return fail(res, 400, '未发货订单没有实物可退，请用「仅退款」');
  }
  const type = b.type || 'refund';
  if (!AS_TYPE[type]) return fail(res, 400, '售后类型应为 refund / return / exchange');
  const refundAmount = Number(b.refund_amount) || 0;
  if (refundAmount < 0) return fail(res, 400, '退款金额不能为负');
  if (refundAmount > Number(retail.paid_amount) - Number(retail.refund_amount) + 0.01) {
    return fail(res, 400, `退款金额超过可退余额（实付 ${retail.paid_amount}，已退 ${retail.refund_amount}）`);
  }
  const t = now();
  // 仅退款无需退回实物；退货/换货才建「待退回」
  const returnStatus = type === 'refund' ? 'not_required' : 'pending';
  const no = nextNo('AS', 'retail_after_sales', 'no');
  const r = db.prepare(
    `INSERT INTO retail_after_sales (no, retail_id, item_id, type, reason, refund_amount, return_qty,
       refund_status, return_status, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(no, retail.id, b.item_id || null, type, b.reason || null, round2(refundAmount),
    Number(b.return_qty) || 0, 'draft', returnStatus, b.remark || null, req.user.username, t, t);
  const row = db.prepare('SELECT * FROM retail_after_sales WHERE id = ?').get(r.lastInsertRowid);
  return ok(res, {
    ...row, type_label: AS_TYPE[row.type], refund_label: REFUND_STATUS[row.refund_status],
    return_label: RETURN_STATUS[row.return_status]
  });
}));

router.put('/after-sales/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM retail_after_sales WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '售后单不存在');
  if (row.refund_status === 'done') return fail(res, 400, '已退款完成，不能再修改');
  const b = req.body || {};
  db.prepare('UPDATE retail_after_sales SET reason=?, refund_amount=?, return_qty=?, remark=?, updated_at=? WHERE id=?')
    .run(b.reason ?? row.reason,
      b.refund_amount !== undefined ? round2(Number(b.refund_amount) || 0) : row.refund_amount,
      b.return_qty !== undefined ? Number(b.return_qty) || 0 : row.return_qty,
      b.remark ?? row.remark, now(), row.id);
  const next = db.prepare('SELECT * FROM retail_after_sales WHERE id = ?').get(row.id);
  return ok(res, {
    ...next, type_label: AS_TYPE[next.type], refund_label: REFUND_STATUS[next.refund_status],
    return_label: RETURN_STATUS[next.return_status]
  });
}));

/** 退款完成（渠道侧）：只改钱，不动实物退回状态 */
router.post('/after-sales/:id/confirm-refund', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM retail_after_sales WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '售后单不存在');
  if (row.refund_status === 'done') return fail(res, 400, '该售后单已退款完成');
  const retail = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(row.retail_id);
  const remain = round2(Number(retail.paid_amount) - Number(retail.refund_amount));
  if (Number(row.refund_amount) > remain + 0.01) {
    return fail(res, 400, `退款 ${row.refund_amount} 超过可退余额 ${remain}`);
  }
  try {
    db.exec('BEGIN');
    db.prepare('UPDATE retail_after_sales SET refund_status=?, refund_ref=?, updated_at=? WHERE id=?')
      .run('done', (req.body && req.body.refund_ref) || null, now(), row.id);
    db.prepare('UPDATE retail_orders SET refund_amount = refund_amount + ?, updated_at=? WHERE id=?')
      .run(round2(Number(row.refund_amount)), now(), retail.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  const next = db.prepare('SELECT * FROM retail_after_sales WHERE id = ?').get(row.id);
  return ok(res, {
    ...next, type_label: AS_TYPE[next.type], refund_label: REFUND_STATUS[next.refund_status],
    return_label: RETURN_STATUS[next.return_status],
    order_refund_total: db.prepare('SELECT refund_amount FROM retail_orders WHERE id = ?').get(retail.id).refund_amount
  });
}));

/** 实物退回（仓储侧）：与退款状态独立，收到货才回补库存 */
router.post('/after-sales/:id/receive-return', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM retail_after_sales WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '售后单不存在');
  if (row.type === 'refund') return fail(res, 400, '仅退款没有实物退回');
  if (row.return_status === 'received') return fail(res, 400, '实物已确认收到');
  const retail = db.prepare('SELECT * FROM retail_orders WHERE id = ?').get(row.retail_id);
  const shop = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(retail.shop_id);
  const restock = req.body && req.body.restock ? 1 : 0;
  const qty = Number(req.body && req.body.qty) || Number(row.return_qty) || 0;
  const item = row.item_id
    ? db.prepare('SELECT * FROM retail_order_items WHERE id = ?').get(row.item_id)
    : db.prepare('SELECT * FROM retail_order_items WHERE retail_id = ? ORDER BY id LIMIT 1').get(retail.id);

  try {
    db.exec('BEGIN');
    if (restock && item && qty > 0) {
      // 退回品默认不直接回可售库存，需质检；这里按「良品回补」登记并留痕
      applyStock({
        warehouse: (req.body && req.body.warehouse) || shop.warehouse || 'us',
        style_no: item.style_no, product_name: item.name, color: item.color, size: item.size, delta: qty
      });
      addLedger({
        warehouse: (req.body && req.body.warehouse) || shop.warehouse || 'us',
        style_no: item.style_no, product_name: item.name, color: item.color, size: item.size,
        type: 'in', qty, ref_type: 'retail_return', ref_id: row.id,
        remark: `零售退回 ${retail.retail_no}`, operator: req.user.username
      });
    }
    db.prepare('UPDATE retail_after_sales SET return_status=?, return_qty=?, restock=?, updated_at=? WHERE id=?')
      .run('received', qty, restock, now(), row.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  const next = db.prepare('SELECT * FROM retail_after_sales WHERE id = ?').get(row.id);
  return ok(res, {
    ...next, type_label: AS_TYPE[next.type], refund_label: REFUND_STATUS[next.refund_status],
    return_label: RETURN_STATUS[next.return_status]
  });
}));

router.post('/after-sales/:id/reject', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM retail_after_sales WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '售后单不存在');
  if (row.refund_status === 'done') return fail(res, 400, '已退款完成，不能驳回');
  db.prepare('UPDATE retail_after_sales SET refund_status=?, return_status=?, remark=?, updated_at=? WHERE id=?')
    .run('rejected', 'not_required', (req.body && req.body.reason) || row.remark, now(), row.id);
  const next = db.prepare('SELECT * FROM retail_after_sales WHERE id = ?').get(row.id);
  return ok(res, {
    ...next, type_label: AS_TYPE[next.type], refund_label: REFUND_STATUS[next.refund_status],
    return_label: RETURN_STATUS[next.return_status]
  });
}));

// ============================================================
// N04-04 渠道费率与经营损益
// ============================================================
function settlementView(r) {
  const shop = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(r.shop_id);
  return {
    ...r,
    shop_name: shop ? shop.shop_name : '',
    platform_label: shop ? (PLATFORMS[shop.platform] || shop.platform) : '',
    status_label: STL_STATUS[r.status] || r.status,
    basis_label: r.profit_basis === 'confirmed' ? '账单确认' : '预估',
    // 商品毛利（只扣成本）与贡献（再扣渠道/履约费用）分开呈现
    gross_profit: round2(Number(r.order_amount) - Number(r.refund_amount) - Number(r.cost_amount)),
    gross_margin: Number(r.order_amount) > 0
      ? Math.round(((Number(r.order_amount) - Number(r.refund_amount) - Number(r.cost_amount)) / Number(r.order_amount)) * 10000) / 100
      : 0,
    contribution_margin: Number(r.order_amount) > 0
      ? Math.round((Number(r.contribution) / Number(r.order_amount)) * 10000) / 100 : 0,
    fee_total: round2(Number(r.platform_fee) + Number(r.ad_fee) + Number(r.fulfillment_fee) + Number(r.other_fee))
  };
}

router.get('/settlements', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.shop_id) { cond.push('shop_id = ?'); params.push(Number(req.query.shop_id)); }
  if (req.query.status) { cond.push('status = ?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT * FROM channel_settlements ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC`
  ).all(...params);
  return ok(res, rows.map(settlementView));
}));

router.get('/settlements/export', authRequired, wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM channel_settlements ORDER BY id DESC').all().map(settlementView);
  return csv(res, 'channel-settlements.csv',
    ['结算批', '店铺', '公司', '币种', '期间', '订单数', '订单实付', '平台费', '广告费', '履约费', '退款', '结算净额', '商品成本', '商品毛利', '贡献', '利润口径', '差异', '状态'],
    rows.map((r) => [r.batch_no, r.shop_name, r.company || '', r.currency, `${r.period_start || ''}~${r.period_end || ''}`,
      r.order_count, r.order_amount, r.platform_fee, r.ad_fee, r.fulfillment_fee, r.refund_amount,
      r.net_amount, r.cost_amount, r.gross_profit, r.contribution, r.basis_label, r.diff_amount, r.status_label]));
}));

router.get('/settlements/:id', authRequired, wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM channel_settlements WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '结算批不存在');
  const orders = db.prepare(
    `SELECT id, retail_no, channel_order_no, order_date, paid_amount, refund_amount, currency
     FROM retail_orders WHERE settle_id = ? ORDER BY id`
  ).all(r.id);
  return ok(res, { ...settlementView(r), orders });
}));

/**
 * 生成结算批（预估口径）
 * 范围：该店铺、支付已核、期间内、尚未结算的零售订单
 */
router.post('/settlements/generate', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.shop_id) return fail(res, 400, '请选择店铺');
  const shop = db.prepare('SELECT * FROM channel_shops WHERE id = ?').get(b.shop_id);
  if (!shop) return fail(res, 404, '店铺不存在');
  const from = b.period_start || '1970-01-01';
  const to = b.period_end || '2999-12-31';

  // 只结算「已发货」订单：平台按实际履约结算，未发货的单不该进结算批，
  // 否则会把还在仓库里的货算成收入（退款也还没发生）。
  const orders = db.prepare(
    `SELECT * FROM retail_orders
     WHERE shop_id = ? AND settle_status = 'unsettled' AND pay_status = 'checked'
       AND fulfill_status = 'shipped'
       AND COALESCE(order_date, '') BETWEEN ? AND ?
     ORDER BY id`
  ).all(shop.id, from, to);
  if (!orders.length) return fail(res, 400, '该期间没有可结算订单（需「已发货 + 支付已核 + 未结算」）');

  const ids = orders.map((o) => o.id);
  const inList = ids.map(() => '?').join(',');
  const costRow = db.prepare(
    `SELECT COALESCE(SUM(cost * qty), 0) AS c FROM retail_order_items WHERE retail_id IN (${inList})`
  ).get(...ids);
  const costAmount = round2(costRow.c);
  const orderAmount = round2(orders.reduce((s, o) => s + Number(o.paid_amount || 0), 0));
  const refundAmount = round2(orders.reduce((s, o) => s + Number(o.refund_amount || 0), 0));
  const platformFee = round2(orderAmount * (Number(shop.fee_rate) || 0) / 100);
  const adFee = round2(Number(b.ad_fee) || 0);
  const fulfillFee = round2(Number(b.fulfillment_fee) || 0);
  const otherFee = round2(Number(b.other_fee) || 0);
  const net = round2(orderAmount - refundAmount - platformFee - adFee - fulfillFee - otherFee);
  const contribution = round2(net - costAmount);
  const batchNo = nextNo('JS', 'channel_settlements', 'batch_no');
  const t = now();

  let sid = null;
  try {
    db.exec('BEGIN');
    const r = db.prepare(
      `INSERT INTO channel_settlements (batch_no, shop_id, company, currency, period_start, period_end, order_count,
         order_amount, platform_fee, ad_fee, fulfillment_fee, refund_amount, other_fee, net_amount, cost_amount,
         contribution, profit_basis, source, status, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(batchNo, shop.id, shop.company || null, shop.currency || 'USD', from === '1970-01-01' ? null : from,
      to === '2999-12-31' ? null : to, orders.length, orderAmount, platformFee, adFee, fulfillFee, refundAmount,
      otherFee, net, costAmount, contribution, 'estimated', b.source || '系统按费率预估', 'draft',
      b.remark || null, req.user.username, t, t);
    sid = Number(r.lastInsertRowid);
    const upd = db.prepare("UPDATE retail_orders SET settle_status='settled', settle_id=?, updated_at=? WHERE id=?");
    ids.forEach((id) => upd.run(sid, t, id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, 400, e.message);
  }
  return ok(res, settlementView(db.prepare('SELECT * FROM channel_settlements WHERE id = ?').get(sid)));
}));

/**
 * 核对账单：传平台实际结算数据，与预估对比出差异
 * 所有扣项都必须有账单来源，预估不能当最终利润
 */
router.post('/settlements/:id/confirm', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM channel_settlements WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '结算批不存在');
  if (row.status === 'confirmed') return fail(res, 400, '该结算批已确认');
  const b = req.body || {};
  if (!b.source || !String(b.source).trim()) return fail(res, 400, '请填写账单来源（如平台结算报表编号）');

  const pick = (k, cur) => (b[k] !== undefined && b[k] !== null && b[k] !== '' ? round2(Number(b[k]) || 0) : round2(Number(cur)));
  const orderAmount = pick('order_amount', row.order_amount);
  const refundAmount = pick('refund_amount', row.refund_amount);
  const platformFee = pick('platform_fee', row.platform_fee);
  const adFee = pick('ad_fee', row.ad_fee);
  const fulfillFee = pick('fulfillment_fee', row.fulfillment_fee);
  const otherFee = pick('other_fee', row.other_fee);
  const net = round2(orderAmount - refundAmount - platformFee - adFee - fulfillFee - otherFee);
  const contribution = round2(net - Number(row.cost_amount));
  const diff = round2(contribution - Number(row.contribution));
  const status = Math.abs(diff) > 0.01 ? 'diff' : 'confirmed';

  db.prepare(
    `UPDATE channel_settlements SET order_amount=?, refund_amount=?, platform_fee=?, ad_fee=?, fulfillment_fee=?,
       other_fee=?, net_amount=?, contribution=?, profit_basis='confirmed', diff_amount=?, source=?,
       status=?, remark=COALESCE(?, remark), updated_at=? WHERE id=?`
  ).run(orderAmount, refundAmount, platformFee, adFee, fulfillFee, otherFee, net, contribution, diff,
    String(b.source).trim(), status, b.remark || null, now(), row.id);
  return ok(res, settlementView(db.prepare('SELECT * FROM channel_settlements WHERE id = ?').get(row.id)));
}));

// ============================================================
// 概览
// ============================================================
router.get('/stats', authRequired, wrap(async (req, res) => {
  const shops = db.prepare('SELECT COUNT(*) AS c FROM channel_shops WHERE status = ?').get('active').c;
  const unauthorized = db.prepare("SELECT COUNT(*) AS c FROM channel_shops WHERE api_status = 'unauthorized'").get().c;

  const pay = db.prepare(
    `SELECT
       SUM(CASE WHEN pay_status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN pay_status = 'mismatch' THEN 1 ELSE 0 END) AS mismatch,
       SUM(CASE WHEN fulfill_status = 'shortage' THEN 1 ELSE 0 END) AS shortage,
       SUM(CASE WHEN fulfill_status = 'shipped' THEN 1 ELSE 0 END) AS shipped,
       COUNT(*) AS total
     FROM retail_orders WHERE fulfill_status != 'cancelled'`
  ).get();

  const amount = db.prepare(
    `SELECT COALESCE(SUM(paid_amount),0) AS paid, COALESCE(SUM(refund_amount),0) AS refund
     FROM retail_orders WHERE fulfill_status != 'cancelled'`
  ).get();

  // 配额预警：超额承诺或预留逼近限额
  const quotas = db.prepare(
    `SELECT q.*, s.warehouse FROM channel_quotas q LEFT JOIN channel_shops s ON s.id = q.shop_id`
  ).all();
  let overLimit = 0;
  let nearLimit = 0;
  let shortage = 0;
  quotas.forEach((q) => {
    const c = quotaCalc(q, { warehouse: q.warehouse });
    if (c.over_limit) overLimit++;
    else if (Number(q.channel_limit) > 0 && Number(q.reserved) / Number(q.channel_limit) >= 0.8) nearLimit++;
    if (c.shortage > 0) shortage++;
  });

  const as = db.prepare(
    `SELECT
       SUM(CASE WHEN refund_status IN ('draft','processing') THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN type != 'refund' AND return_status = 'pending' THEN 1 ELSE 0 END) AS return_pending
     FROM retail_after_sales`
  ).get();

  const stl = db.prepare(
    `SELECT COUNT(*) AS batches, COALESCE(SUM(contribution),0) AS contribution,
            COALESCE(SUM(CASE WHEN status = 'diff' THEN 1 ELSE 0 END),0) AS diffs
     FROM channel_settlements WHERE profit_basis = 'confirmed'`
  ).get();
  const est = db.prepare(
    "SELECT COALESCE(SUM(contribution),0) AS c FROM channel_settlements WHERE profit_basis = 'estimated'"
  ).get();

  const byPlatform = db.prepare(
    `SELECT s.platform, COUNT(r.id) AS cnt, COALESCE(SUM(r.paid_amount),0) AS paid
     FROM channel_shops s LEFT JOIN retail_orders r ON r.shop_id = s.id AND r.fulfill_status != 'cancelled'
     GROUP BY s.platform ORDER BY paid DESC`
  ).all();

  return ok(res, {
    shops,
    unauthorized_shops: unauthorized,
    orders: {
      total: Number(pay.total) || 0,
      pay_pending: Number(pay.pending) || 0,
      pay_mismatch: Number(pay.mismatch) || 0,
      shortage: Number(pay.shortage) || 0,
      shipped: Number(pay.shipped) || 0
    },
    amount: { paid: round2(amount.paid), refund: round2(amount.refund) },
    quota: { over_limit: overLimit, near_limit: nearLimit, shortage: shortage, total: quotas.length },
    after_sales: { open: Number(as.open) || 0, return_pending: Number(as.return_pending) || 0 },
    settlement: {
      confirmed_batches: Number(stl.batches) || 0,
      confirmed_contribution: round2(stl.contribution),
      diff_batches: Number(stl.diffs) || 0,
      estimated_contribution: round2(est.c)
    },
    by_platform: byPlatform.map((p) => ({
      platform: p.platform,
      platform_label: PLATFORMS[p.platform] || p.platform,
      cnt: Number(p.cnt) || 0,
      paid: round2(p.paid)
    })),
    warnings: [
      Number(unauthorized) > 0 ? `${unauthorized} 个店铺尚未完成接口授权，订单只能受控导入` : null,
      Number(pay.pending) > 0 ? `${pay.pending} 张零售单支付待核，未核对不会释放拣配` : null,
      Number(pay.mismatch) > 0 ? `${pay.mismatch} 张零售单支付核对异常，请查回执` : null,
      Number(pay.shortage) > 0 ? `${pay.shortage} 张零售单缺货待补` : null,
      overLimit > 0 ? `${overLimit} 条渠道配额已超额承诺（预留 > 限额）` : null,
      shortage > 0 ? `${shortage} 条配额预留超过实物可用量，配额不是第二份库存` : null,
      Number(as.return_pending) > 0 ? `${as.return_pending} 单退货待收实物（退款与实物退回相互独立）` : null
    ].filter(Boolean)
  });
}));

module.exports = router;
