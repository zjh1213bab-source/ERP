/**
 * 扎标（bundle label）
 * ============================================================
 * 为什么单独做这个模块：
 *   车间按「扎」作业 —— 裁完分扎、按扎流转、按扎结算。原来的标签只到「款色码」，
 *   一张单同一个色码可能有十几扎，标签长得一模一样，**贴上去就分不清是哪一扎**。
 *   追溯一旦断在扎上，返工、短数、索赔全查不清。
 *
 * 扎标要能回答四件事：
 *   1. 这是哪一单、哪一款（订单号 / 款号）
 *   2. 这是哪一扎（扎号大字）
 *   3. 这一扎是什么色、什么码、多少件（贴的人要能核对）
 *   4. 手机扫一下能看到这扎的全部信息并直接报工（二维码）
 *
 * 两个硬规则：
 *   - **二维码内容必须是纯 ASCII**：中文字符会让扫码枪与部分扫码 App 解不出来
 *   - **扎号必须来自系统**：不接受手填，否则打印出来的扎号与系统里对不上，
 *     比没有标签更糟（贴错一张，整批追溯就乱了）
 */
const { db } = require('../db');

/** 取订单的全部扎（跨多个裁剪单时按扎号排序） */
function bundlesOfOrder(orderId) {
  const id = Number(orderId);
  const order = db
    .prepare(
      // 订单表没有 total_qty 这一列（数量在明细与尺码行里），按明细汇总
      `SELECT o.id, o.order_no, o.style_name, o.status,
              c.name AS customer_name,
              (SELECT IFNULL(SUM(s.qty), 0) FROM order_item_sizes s
                 JOIN order_items i ON i.id = s.item_id WHERE i.order_id = o.id) AS size_qty,
              (SELECT IFNULL(SUM(i.qty), 0) FROM order_items i WHERE i.order_id = o.id) AS item_qty
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.id = ?`
    )
    .get(id);
  if (!order) {
    const e = new Error('订单不存在');
    e.status = 404;
    throw e;
  }

  const rows = db
    .prepare(
      `SELECT b.id, b.bundle_no, b.color, b.size, b.qty, b.status AS bundle_status,
              b.checked_by, b.checked_at, b.note,
              c.id AS cut_order_id, c.cut_no, c.style_no, c.mixed_dye_lot, c.bundle_rule,
              l.bed_no, l.dye_lot, l.fabric_roll
         FROM cut_bundles b
         JOIN cut_orders c ON c.id = b.cut_order_id
         LEFT JOIN cut_lots l ON l.id = b.lot_id
        WHERE c.order_id = ?
        ORDER BY c.id, b.bundle_no`
    )
    .all(id);

  const cuts = db
    .prepare(
      `SELECT c.id, c.cut_no, c.style_no, c.status, c.plan_qty, c.qualified_qty,
              c.total_cut_qty, c.bundle_count, c.bundle_qty, c.mixed_dye_lot, c.cut_at
         FROM cut_orders c WHERE c.order_id = ? ORDER BY c.id`
    )
    .all(id);

  return {
    order: {
      id: order.id,
      order_no: order.order_no,
      style_name: order.style_name,
      customer_name: order.customer_name,
      status: order.status,
      // 有尺码行就以尺码为准；老数据没有尺码行时退到明细数量
      total_qty: Number(order.size_qty) || Number(order.item_qty) || 0
    },
    cuts,
    bundles: rows.map((r) => ({
      ...r,
      qty: Number(r.qty) || 0,
      // 二维码内容：订单号-扎号。纯 ASCII，且第一段就是订单号，老扫码逻辑照样能认。
      code: `${order.order_no}-${r.bundle_no}`,
      checked: r.bundle_status === 'ok' || r.bundle_status === 'checked'
    })),
    total_qty: rows.reduce((a, r) => a + (Number(r.qty) || 0), 0)
  };
}

/**
 * 扫码解析：把扫到的码还原成「订单」或「订单 + 某一扎」
 *
 * 兼容三种码：
 *   - 订单号                 SO202610260005
 *   - 扎标码                 SO202610260005-DQDEMO-B8
 *   - 老款色码标             SO202610260005-WY-001-110（解析成订单，忽略后缀）
 */
function resolve(code) {
  const raw = String(code || '').trim();
  if (!raw) {
    const e = new Error('请输入或扫描标签码');
    e.status = 400;
    throw e;
  }

  const orderNo = raw.split('-')[0];
  const order = db
    .prepare(
      `SELECT o.id, o.order_no, o.style_name, o.status, o.customer_id, o.delivery_date
         FROM orders o WHERE o.order_no = ?`
    )
    .get(orderNo);
  if (!order) {
    const e = new Error('未找到对应订单：' + orderNo);
    e.status = 404;
    throw e;
  }

  let bundle = null;
  let missingSuffix = '';
  if (raw.length > orderNo.length + 1) {
    const rest = raw.slice(orderNo.length + 1);
    // 扎号可能自带「-」，所以不是取第二段，而是把整个剩余部分当扎号查
    bundle = db
      .prepare(
        `SELECT b.id, b.bundle_no, b.color, b.size, b.qty, b.status, b.checked_at,
                c.cut_no, c.style_no, c.order_id, l.bed_no, l.dye_lot
           FROM cut_bundles b
           JOIN cut_orders c ON c.id = b.cut_order_id
           LEFT JOIN cut_lots l ON l.id = b.lot_id
          WHERE c.order_id = ? AND b.bundle_no = ?`
      )
      .get(order.id, rest);
    // 码里带了后缀但查不到扎：可能是错印，也可能扫的是款色码标（那不是扎号）
    if (!bundle) missingSuffix = rest;
  }

  const bundleTotal = db
    .prepare('SELECT COUNT(*) AS c FROM cut_bundles b JOIN cut_orders c ON c.id = b.cut_order_id WHERE c.order_id = ?')
    .get(order.id).c;

  return {
    kind: bundle ? 'bundle' : 'order',
    code: raw,
    // 有后缀、这单确实有扎、却对不上 —— 大概率是标签印错单或扎号被改过，前端要提示
    bundle_missing: !bundle && !!missingSuffix && bundleTotal > 0 ? missingSuffix : null,
    order,
    bundle: bundle
      ? { ...bundle, qty: Number(bundle.qty) || 0, checked: bundle.status === 'ok' || bundle.status === 'checked' }
      : null,
    bundle_total: bundleTotal
  };
}

module.exports = { bundlesOfOrder, resolve };
