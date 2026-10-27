/**
 * 客户商城公共逻辑：价格解析、可售量、站内消息、单据号
 */
const { db, now, getSettings } = require('../db');
const { genNo } = require('../utils/http');

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 客户专属价优先，否则商品公开价；返回 { price_usd, moq, source } */
function resolvePrice(mallProduct, customerId) {
  const base = {
    price_usd: Number(mallProduct.price_usd) || 0,
    moq: Number(mallProduct.moq) || 1,
    source: 'public'
  };
  if (!customerId) return base;
  const p = db.prepare('SELECT * FROM mall_prices WHERE customer_id = ? AND mall_product_id = ?')
    .get(customerId, mallProduct.id);
  if (!p) return base;
  return {
    price_usd: Number(p.price_usd) || 0,
    moq: Number(p.moq) || base.moq,
    source: 'customer'
  };
}

/**
 * 可售量：美仓现货。
 * 优先按款号匹配；库存款号与商品款号不一致时（历史数据常见），回退按产品名匹配。
 */
function sellableOf(styleNo, productName) {
  let q = 0;
  if (styleNo) {
    q = Number(db.prepare(
      "SELECT COALESCE(SUM(qty),0) AS q FROM stock_items WHERE warehouse = 'us' AND style_no = ? AND qty > 0"
    ).get(styleNo).q) || 0;
  }
  if (!q && productName) {
    q = Number(db.prepare(
      "SELECT COALESCE(SUM(qty),0) AS q FROM stock_items WHERE warehouse = 'us' AND product_name = ? AND qty > 0"
    ).get(productName).q) || 0;
  }
  return Math.round(q);
}

/** 兼容旧调用：只传款号 */
function sellableQty(styleNo, productName) {
  return sellableOf(styleNo, productName);
}

function genInquiryNo() {
  let seq = Number(db.prepare('SELECT COUNT(*) AS c FROM mall_inquiries').get().c) + 1;
  let no = genNo('XJ', seq);
  while (db.prepare('SELECT 1 AS x FROM mall_inquiries WHERE inquiry_no = ?').get(no)) {
    no = genNo('XJ', ++seq);
  }
  return no;
}

/** 站内消息 */
function pushMessage({ customerId, accountId = null, type = 'system', title, body = null, refType = null, refId = null }) {
  if (!customerId || !title) return null;
  const info = db.prepare(
    'INSERT INTO mall_messages (customer_id, account_id, type, title, body, ref_type, ref_id, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(customerId, accountId, type, title, body, refType, refId, now());
  return Number(info.lastInsertRowid);
}

const ORDER_STATUS_TEXT = {
  draft: '草稿', tech: '技术确认中', finance: '财务审核中', assigned: '已分派生产',
  production: '生产中', instock: '已入库待发', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};

/**
 * 订单状态流转 → 给客户推一条商城消息（数据流转关键环节）
 * 只在客户有商城账号时推送，避免给纯线下客户发无效消息。
 */
function notifyOrderStatus(orderId, toStatus, note) {
  const order = db.prepare(
    'SELECT o.order_no, o.customer_id, o.delivery_date, c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?'
  ).get(orderId);
  if (!order || !order.customer_id) return null;
  const hasAccount = db.prepare('SELECT 1 AS x FROM customer_accounts WHERE customer_id = ? AND status = ?')
    .get(order.customer_id, 'active');
  if (!hasAccount) return null;

  const label = ORDER_STATUS_TEXT[toStatus] || toStatus;
  const parts = [`订单 ${order.order_no} 状态更新为「${label}」`];
  if (toStatus === 'production') parts.push('已进入生产环节，我们会按交期推进。');
  if (toStatus === 'instock') parts.push('成品已入库，正在安排发货。');
  if (toStatus === 'shipped') parts.push(`已发货${order.delivery_date ? '，预计交期 ' + order.delivery_date : ''}。`);
  if (toStatus === 'closed') parts.push('订单已结案，感谢配合。');
  if (toStatus === 'cancelled') parts.push('订单已取消，如有疑问请联系业务员。');
  if (note) parts.push('备注：' + note);

  return pushMessage({
    customerId: order.customer_id,
    type: 'order',
    title: `订单进度：${label}`,
    body: parts.join(' '),
    refType: 'order',
    refId: Number(orderId)
  });
}

/** 商城商品展示态（含客户价与可售量） */
function decorate(mallProduct, customerId, sellable) {
  const p = resolvePrice(mallProduct, customerId);
  const stock = sellable !== undefined ? sellable : sellableOf(mallProduct.style_no, mallProduct.name_cn);
  const images = mallProduct.images ? String(mallProduct.images).split(',').filter(Boolean) : [];
  return {
    ...mallProduct,
    images,
    price_usd: p.price_usd,
    moq: p.moq,
    price_source: p.source,
    sellable: mallProduct.visible_stock ? stock : null,
    in_stock: stock > 0,
    category_label: mallProduct.category || '未分类'
  };
}

/** 一键把商城询价单转成销售订单草稿（与报价单转订单口径一致） */
function convertInquiryToOrder(inquiry, items, operator) {
  const rate = Number(inquiry.rate) || getSettings().exchangeRate;
  const t = now();

  let seq = Number(db.prepare('SELECT COUNT(*) AS c FROM orders').get().c) + 1;
  let orderNo = genNo('SO', seq);
  while (db.prepare('SELECT 1 AS x FROM orders WHERE order_no = ?').get(orderNo)) {
    orderNo = genNo('SO', ++seq);
  }

  let orderId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO orders (order_no, type, customer_id, status, rate, total_usd, total_amount, currency,
        style_name, cus_order_no, manager, order_date, delivery_method, trade_terms, delivery_days,
        delivery_date, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(orderNo, 'custom', inquiry.customer_id, 'draft', rate, inquiry.total_usd,
      round2(inquiry.total_usd * rate), 'USD',
      items[0] ? items[0].name : null,
      inquiry.inquiry_no, operator || '商城询价', t.slice(0, 10), null, null, 0, null,
      `由商城询价单 ${inquiry.inquiry_no} 转入`, null, t, t);
    orderId = Number(info.lastInsertRowid);

    const insItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, product_name, sku, remark, qty, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?)'
    );
    const insSize = db.prepare(
      'INSERT INTO order_item_sizes (item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny) VALUES (?,?,?,?,?,?,?,?)'
    );
    for (const it of items) {
      const amountUsd = round2(Number(it.qty) * Number(it.price_usd));
      const r = insItem.run(orderId, it.product_id || null, it.name, it.style_no, it.remark || null,
        it.qty, amountUsd, round2(amountUsd * rate));
      const itemId = Number(r.lastInsertRowid);
      insSize.run(itemId, '待定', '均码', it.qty, it.price_usd, round2(Number(it.price_usd) * rate),
        amountUsd, round2(amountUsd * rate));
    }

    db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(orderId, null, 'draft', operator || '商城', `由商城询价单 ${inquiry.inquiry_no} 转入`, t);
    db.prepare("UPDATE mall_inquiries SET status='converted', order_id=?, updated_at=? WHERE id=?")
      .run(orderId, t, inquiry.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  pushMessage({
    customerId: inquiry.customer_id,
    type: 'order',
    title: '询价已转订单',
    body: `询价单 ${inquiry.inquiry_no} 已生成销售订单 ${orderNo}，后续进度可在「我的订单」查看。`,
    refType: 'order',
    refId: orderId
  });

  return { order_id: orderId, order_no: orderNo };
}

module.exports = {
  round2,
  resolvePrice,
  sellableQty,
  sellableOf,
  genInquiryNo,
  pushMessage,
  notifyOrderStatus,
  decorate,
  convertInquiryToOrder,
  ORDER_STATUS_TEXT
};
