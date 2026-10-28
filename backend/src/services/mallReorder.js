/**
 * 历史订单再次购买（TS-N20-08）
 * ========================================================================
 * 核心口径见 `scripts/apply-reorder-ddl.js` 顶部注释。这里只强调三件事：
 *
 * 1. **只复制选品条件**（款号 + 颜色 + 尺码 + 数量）+ 源订单号。
 *    价格、可售量、技术版本、起订量全部按**现在**重算；付款/折扣/占用一律不带。
 *
 * 2. **差异必须逐条给客户看，包括对我们有利的和不利的**。
 *    只报涨价不报降价，客户第一次发现就会开始核对每一张单。
 *
 * 3. **「已下架」不允许提交**，其余问题允许提交但打标。
 *    已下架的款如果硬提交，仓库发不出货、业务还要手工解释；
 *    而可售量不足很可能是「在产」——直接拒掉会把真实订单挡在门外。
 */

const { db, now, getSettings } = require('../db');
const mall = require('./mall');

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/** 客户端可见的差异标签 */
const TAG_LABEL = {
  off_shelf: '已下架',
  price_changed: '价格变化',
  moq_short: '低于起订量',
  stock_short: '可售量不足',
  size_note: '尺码需确认',
  tech_newer: '技术版本更新',
  ref_only: '按款号匹配'
};

const SEV = { off_shelf: 'block', moq_short: 'warn', stock_short: 'warn', price_changed: 'info', size_note: 'info', tech_newer: 'info', ref_only: 'info' };

/**
 * 找当前在架商品
 *
 * 先按 `product_id`（最准），再按 `style_no`（历史订单常见 product_id 已变），
 * 最后按款名（老数据的款号不规范）。三层都记在 `matched_by` 里 ——
 * 客户问「为什么给我这个款」，答案就是这三层里的一层。
 */
function currentProduct(item, order) {
  const pub = "status = 'published'";
  let row = null;
  let matchedBy = null;
  if (item.product_id) {
    row = db.prepare(`SELECT * FROM mall_products WHERE ${pub} AND product_id = ? ORDER BY sort DESC, id DESC LIMIT 1`).get(item.product_id);
    if (row) matchedBy = 'product_id';
  }
  if (!row && item.style_no) {
    row = db.prepare(`SELECT * FROM mall_products WHERE ${pub} AND style_no = ? ORDER BY sort DESC, id DESC LIMIT 1`).get(item.style_no);
    if (row) matchedBy = 'style_no';
  }
  if (!row) {
    const name = item.product_name || order.style_name;
    if (name) {
      row = db.prepare(`SELECT * FROM mall_products WHERE ${pub} AND (name_cn = ? OR name_en = ?) ORDER BY sort DESC, id DESC LIMIT 1`).get(name, name);
      if (row) matchedBy = 'name';
    }
  }
  return { row, matchedBy };
}

/**
 * 该款**当前最新**的技术包版本
 *
 * 按 `version` 数值取最大，不按 id —— 补录历史版本时 id 顺序与版本号不一定同步，
 * 按 id 取会把「补录的旧版」当成最新版。
 */
function latestTechVersion(productName) {
  if (!productName) return null;
  const r = db.prepare('SELECT version, order_id, created_at FROM tech_packs WHERE product_name = ? ORDER BY CAST(version AS REAL) DESC, id DESC LIMIT 1').get(productName);
  return r || null;
}

/** 源订单**当时**该款用的技术包版本（取该单最早的一版，代表下单依据） */
function sourceTechVersion(orderId, productName) {
  if (!productName) return null;
  const r = db.prepare('SELECT version, id FROM tech_packs WHERE order_id = ? AND product_name = ? ORDER BY CAST(version AS REAL) ASC, id ASC LIMIT 1').get(orderId, productName);
  return r || null;
}

/**
 * 预览：把历史订单拆成「可再购的行」，逐行算差异
 *
 * 返回结构给前端直接用：
 *   { order, items[], summary{ total, ok, warn, blocked }, notes[], as_of }
 */
function preview(orderId, customerId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) throw bad('订单不存在', 404);
  if (Number(order.customer_id) !== Number(customerId)) throw bad('这不是你的订单', 403);

  // 只认已成交/已完成的单：草稿单、已取消单没有「再买一次」的意义
  if (['draft', 'cancelled'].includes(order.status)) {
    throw bad(`这张单是「${order.status === 'draft' ? '草稿' : '已取消'}」，没有可再购的历史`);
  }

  const rows = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  if (!rows.length) throw bad('这张订单没有款式明细，无法再购');

  const items = [];
  rows.forEach((it, idx) => {
    const sizes = db.prepare('SELECT * FROM order_item_sizes WHERE item_id = ? ORDER BY id').all(it.id);
    const histQty = Number(it.qty) || sizes.reduce((s, x) => s + (Number(x.qty) || 0), 0);
    // 历史单价：优先尺码级，回退款级金额/数量
    const histUsd = (() => {
      const withPrice = sizes.filter((x) => Number(x.usd_price) > 0);
      if (withPrice.length) {
        const q = withPrice.reduce((s, x) => s + (Number(x.qty) || 0), 0);
        const a = withPrice.reduce((s, x) => s + (Number(x.usd_price) || 0) * (Number(x.qty) || 0), 0);
        return q > 0 ? round2(a / q) : 0;
      }
      return histQty > 0 ? round2((Number(it.amount_usd) || 0) / histQty) : 0;
    })();

    const { row: mp, matchedBy } = currentProduct(it, order);
    const tags = [];
    const messages = [];
    let status = 'ok';
    let price = null;
    let sellable = 0;
    let moq = 0;

    if (!mp) {
      tags.push('off_shelf');
      messages.push('该款已下架或本账号不可见，无法直接再购；请联系业务员上架或推荐替代款');
      status = 'blocked';
    } else {
      price = mall.resolvePrice(mp, customerId);
      moq = price.moq;
      sellable = mall.sellableOf(mp.style_no, mp.name_cn);
      if (matchedBy === 'style_no' || matchedBy === 'name') {
        tags.push('ref_only');
        messages.push(matchedBy === 'style_no'
          ? '按款号匹配到当前在架款（原商品链接已更新，价格与图片以当前为准）'
          : '原商品已下架，按款名匹配到当前在架款，请确认是否同一款');
      }
      if (histUsd > 0 && Math.abs(price.price_usd - histUsd) >= 0.01) {
        tags.push('price_changed');
        const diff = round2(price.price_usd - histUsd);
        messages.push(diff > 0
          ? `单价从 $${histUsd} 涨到 $${price.price_usd}（+$${diff}），按当前价格授权重算`
          : `单价从 $${histUsd} 降到 $${price.price_usd}（-$${Math.abs(diff)}），按当前价格重算`);
      }
      if (histQty < moq) {
        tags.push('moq_short');
        messages.push(`起订量 ${moq} 件，上次只买了 ${histQty} 件；建议按 ${moq} 件提交（不会自动加量）`);
        status = 'warn';
      }
      if (sellable <= 0) {
        tags.push('stock_short');
        messages.push('当前美仓没有现货，可能仍在产；可以提交，由销售确认可供日期');
        status = 'warn';
      } else if (histQty > sellable) {
        tags.push('stock_short');
        messages.push(`当前可售 ${sellable} 件，少于上次的 ${histQty} 件；可提交，由销售确认可供量`);
        status = 'warn';
      }
      if (sizes.length > 1) {
        tags.push('size_note');
        messages.push(`上次分了 ${sizes.length} 个颜色/尺码组合，当前只有款级库存，尺码配比需销售确认`);
      }
      const latest = latestTechVersion(it.product_name || order.style_name);
      const src = sourceTechVersion(order.id, it.product_name || order.style_name);
      if (latest && src && Number(latest.version || 0) > Number(src.version || 0)) {
        tags.push('tech_newer');
        messages.push(`该款技术包已有第 ${latest.version} 版（原单为第 ${src.version} 版），再购按当前技术重新确认`);
      }
    }

    if (status === 'ok' && tags.some((t) => SEV[t] === 'warn')) status = 'warn';

    items.push({
      line_no: idx + 1,
      source_item_id: it.id,
      product_name: it.product_name || order.style_name,
      style_no: it.style_no || (mp ? mp.style_no : null) || null,
      color_summary: [...new Set(sizes.map((s) => s.color).filter(Boolean))].join('/') || it.color || null,
      sizes: sizes.map((s) => ({ color: s.color, size: s.size, qty: Number(s.qty) || 0, usd_price: Number(s.usd_price) || 0 })),
      hist_qty: histQty,
      hist_price_usd: histUsd,
      mall_product_id: mp ? mp.id : null,
      current_name: mp ? mp.name_cn : null,
      current_price_usd: price ? price.price_usd : null,
      price_source: price ? price.source : null,
      moq,
      sellable,
      quote_qty: Math.max(histQty, 0),
      tags,
      tag_labels: tags.map((t) => TAG_LABEL[t] || t),
      messages,
      status,
      matched_by: matchedBy
    });
  });

  const summary = {
    total: items.length,
    ok: items.filter((x) => x.status === 'ok').length,
    warn: items.filter((x) => x.status === 'warn').length,
    blocked: items.filter((x) => x.status === 'blocked').length,
    hist_usd: round2(items.reduce((s, x) => s + x.hist_price_usd * x.hist_qty, 0)),
    now_usd: round2(items.reduce((s, x) => s + (x.current_price_usd || 0) * (x.quote_qty || 0), 0)),
    hist_qty: items.reduce((s, x) => s + x.hist_qty, 0)
  };

  return {
    order: {
      id: order.id,
      order_no: order.order_no,
      status: order.status,
      style_name: order.style_name,
      order_date: order.order_date,
      delivery_date: order.delivery_date,
      total_usd: order.total_usd
    },
    items,
    summary,
    as_of: now(),
    notes: [
      '只复制款号与数量，价格、起订量、可售量按当前重新确认',
      '不沿用原单的折扣、库存占用与付款状态 —— 这是一张新询价单',
      '提交后由业务员确认价格与可供日期，确认前不占产能'
    ]
  };
}

/**
 * 提交再购：生成一张新询价单
 *
 * 明确不做的事：
 *   - 不复制 `order_id`（那是「已生成订单」的回指，复制就等于凭空造一张订单）
 *   - 不复制付款/折扣/占用（原型原话）
 *   - 不因为「上次买过」跳过 MOQ 与权限
 */
function submit(orderId, customerId, accountId, body = {}) {
  const p = preview(orderId, customerId);
  const wanted = Array.isArray(body.items) && body.items.length ? body.items : null;

  const blockedRows = p.items.filter((x) => x.status === 'blocked');
  const picked = [];
  const diffSnapshot = [];
  const skipped = [];

  p.items.forEach((row) => {
    const input = wanted ? wanted.find((w) => Number(w.line_no) === row.line_no || Number(w.source_item_id) === row.source_item_id) : row;
    // 未勾选的行直接跳过：客户只挑其中两行提交时，没挑的那行即使已下架也不该拦住他
    if (wanted && !input) return;
    const qty = Number(input && input.qty !== undefined ? input.qty : row.quote_qty);
    if (!(qty > 0)) return;   // 客户自己取消这一行
    if (row.status === 'blocked') {
      // 客户逐行勾选时明确要了这一行 → 直接拒绝，让他知道这行不行；
      // 没逐行勾选（一键全要）时 → 跳过并记进 skipped，不因为一行下架就整单失败。
      // 后者更重要：一键再购的旧单里通常有一两个停产款，整单被打回等于这个功能不能用。
      if (wanted) throw bad(`「${row.product_name}」${row.tag_labels[0]}：${row.messages[0] || '无法再购'}`, 400);
      skipped.push({
        product_name: row.product_name,
        style_no: row.style_no,
        hist_qty: row.hist_qty,
        reason: row.tag_labels[0] || '已下架',
        message: row.messages[0] || '无法再购'
      });
      return;
    }
    picked.push({ row, qty });
    diffSnapshot.push({
      source_item_id: row.source_item_id,
      product_name: row.product_name,
      style_no: row.style_no,
      mall_product_id: row.mall_product_id,
      hist_qty: row.hist_qty,
      hist_price_usd: row.hist_price_usd,
      quote_qty: qty,
      current_price_usd: row.current_price_usd,
      moq: row.moq,
      sellable: row.sellable,
      tags: row.tags,
      messages: row.messages
    });
  });

  if (!picked.length) {
    throw bad(blockedRows.length
      ? '选中的款式都已下架，没有可提交的行'
      : '请至少保留一行数量大于 0 的款式');
  }

  const rate = getSettings().exchangeRate;
  let totalUsd = 0;
  let totalQty = 0;
  picked.forEach(({ row, qty }) => {
    // MOQ 只提示不硬拦：客户可能确实只要小批量，让业务员去谈；
    // 但单价与起订量一律用**当前**的，不沿用历史
    totalUsd = round2(totalUsd + (Number(row.current_price_usd) || 0) * qty);
    totalQty += qty;
  });

  const inquiryNo = mall.genInquiryNo();
  const t = now();
  let id;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO mall_inquiries (inquiry_no, customer_id, account_id, contact, status, total_usd, total_qty, rate,
          remark, created_at, updated_at, source_order_id, source_order_no, reorder_diff)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      inquiryNo, customerId, accountId || null, body.contact || null, 'submitted', totalUsd, totalQty, rate,
      body.remark || `历史订单 ${p.order.order_no} 再次购买`, t, t,
      p.order.id, p.order.order_no, JSON.stringify({ at: t, as_of: p.as_of, items: diffSnapshot })
    );
    id = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO mall_inquiry_items (inquiry_id, mall_product_id, product_id, style_no, name, qty, price_usd, amount_usd, remark)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    picked.forEach(({ row, qty }) => {
      const mp = db.prepare('SELECT * FROM mall_products WHERE id = ?').get(row.mall_product_id);
      const price = Number(row.current_price_usd) || 0;
      const note = row.messages.length ? row.messages.join('；') : null;
      ins.run(id, row.mall_product_id, mp ? mp.product_id : null, row.style_no, row.product_name, qty, price, round2(price * qty), note);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // 给业务员/客户各留一句：客户侧用站内消息，内部侧走 ERP 审计日志
  try {
    mall.pushMessage({
      customerId,
      accountId: accountId || null,
      type: 'system',
      title: `已按历史订单 ${p.order.order_no} 提交再购询价 ${inquiryNo}`,
      body: '价格与可供量按当前重新确认，业务员确认后会通知你',
      refType: 'inquiry',
      refId: id
    });
  } catch (e) { /* 消息推不出去不影响单据 */ }

  const needsReview = diffSnapshot.some((x) => (x.tags || []).some((tg) => tg !== 'size_note'));
  return {
    id,
    inquiry_no: inquiryNo,
    total_usd: totalUsd,
    total_qty: totalQty,
    source_order_no: p.order.order_no,
    needs_review: needsReview,
    skipped,
    lines: diffSnapshot,
    note: needsReview
      ? '这张询价里有价格/可售量/起订量等方面的差异，业务员会逐条确认'
      : '与上次差异不大，业务员确认价格与交期即可'
  };
}

module.exports = { preview, submit, TAG_LABEL, SEV };
