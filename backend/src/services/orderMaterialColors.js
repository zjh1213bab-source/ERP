/**
 * 订单物料 → 款 × 颜色
 *
 * ## 三件事只在这里做一次
 *
 * 1. **件数口径**：物料挂在某个款上时，用量按**这个款**的件数算，不是整单件数。
 *    一张单两个款（100 件 + 200 件），挂在第一款上的面料按 100 件算；
 *    按 300 件算会多算两倍，而金额看着「挺合理」，没人会去核。
 *
 * 2. **颜色必须属于这个款**：`colorway` 要和该款 `order_item_sizes.color` 对上。
 *    不校验的话，填一个这款没有的颜色也能存，发料时才发现没有这件货。
 *
 * 3. **总用量重算**：配了颜色就按色累加，没配就按款/单件数算。
 *    重算只能有一份实现 —— 三个入口（新增 / 改物料 / 只改颜色）各写一遍，
 *    必然出现「改了颜色但总额没变」。
 *
 * ## 为什么 `all_colors` 与子表不能同时存在
 *
 * `all_colors=1` 表示「这个款的所有颜色都用这个料」。如果同时又留着几行子表，
 * 那到底是全部还是那几色？两种解释都说得通，于是谁都按自己想的理解。
 * 所以切到 all_colors 时把子表清空，切回每色配置时再写。
 */
const { db, now } = require('../db');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** 某个款的件数（不传款 = 整单件数） */
function qtyOf(orderId, itemId) {
  if (itemId) {
    return Number(db.prepare('SELECT COALESCE(SUM(qty),0) s FROM order_items WHERE id = ? AND order_id = ?')
      .get(itemId, orderId).s) || 0;
  }
  return Number(db.prepare('SELECT COALESCE(SUM(qty),0) s FROM order_items WHERE order_id = ?')
    .get(orderId).s) || 0;
}

/** 某个款某个颜色的件数 */
function qtyOfColor(itemId, colorway) {
  return Number(db.prepare(
    `SELECT COALESCE(SUM(s.qty),0) s FROM order_item_sizes s
      JOIN order_items i ON i.id = s.item_id
     WHERE s.item_id = ? AND s.color = ?`
  ).get(itemId, colorway).s) || 0;
}

/** 某个款有哪些颜色（去重、按出现顺序） */
function colorsOfItem(itemId) {
  return db.prepare(
    `SELECT color, SUM(qty) AS qty FROM order_item_sizes WHERE item_id = ? AND IFNULL(color,'') <> ''
      GROUP BY color ORDER BY MIN(id)`
  ).all(itemId).map((r) => ({ colorway: r.color, qty: Number(r.qty) || 0 }));
}

/** 颜色必须属于这个款 —— 填错颜色比填错数量更难发现（发料时才知道没这件货） */
function assertColorsBelong(itemId, colorways) {
  const own = new Set(colorsOfItem(itemId).map((c) => c.colorway));
  const outside = colorways.filter((c) => !own.has(c));
  if (outside.length) {
    throw bad(`这些颜色不属于这个款：${outside.join('、')}。该款的颜色是：${[...own].join('、') || '（还没录颜色）'}`);
  }
}

/** 把颜色行写进去（先清后插，保证不残留） */
function replaceColors(materialId, colors) {
  db.prepare('DELETE FROM order_material_colors WHERE order_material_id = ?').run(materialId);
  const t = now();
  const ins = db.prepare(
    'INSERT INTO order_material_colors (order_material_id, colorway, color_no, qty, note, created_at) VALUES (?,?,?,?,?,?)'
  );
  /**
   * 同色只留最后一条。
   *
   * 表上有 UNIQUE(order_material_id, colorway)，前端把同一个色传两遍时
   * 会直接撞约束 → 500。这不是数据库该报给用户看的错，前端勾选重复是常事。
   */
  const seen = new Map();
  (colors || []).forEach((c) => seen.set(c.colorway, c));
  [...seen.values()].forEach((c) => {
    ins.run(materialId, c.colorway, c.color_no || null,
      c.qty === '' || c.qty === undefined || c.qty === null ? null : Number(c.qty), c.note || null, t);
  });
}

/**
 * 重算总用量与金额并写回
 *
 * 配了颜色 → Σ(该色单件用量 × 该色件数)；没配 → 单件用量 × 款件数（或整单件数）。
 * 单件用量取颜色的 qty，没填就沿用物料行的 one_use。
 */
function recalc(materialId) {
  const row = db.prepare('SELECT * FROM order_materials WHERE id = ?').get(materialId);
  if (!row) throw bad('物料不存在', 404);

  const loss = 1 + (Number(row.loss) || 0) / 100;
  const colors = db.prepare('SELECT * FROM order_material_colors WHERE order_material_id = ?').all(materialId);

  let totalUse;
  if (Number(row.all_colors) === 1 || !colors.length) {
    totalUse = round2((Number(row.one_use) || 0) * qtyOf(row.order_id, row.item_id) * loss);
  } else {
    totalUse = round2(colors.reduce((sum, c) => {
      const one = c.qty === null || c.qty === undefined ? Number(row.one_use) || 0 : Number(c.qty) || 0;
      return sum + one * qtyOfColor(row.item_id, c.colorway);
    }, 0) * loss);
  }

  const amount = round2(totalUse * (Number(row.price) || 0));
  db.prepare('UPDATE order_materials SET total_use = ?, amount = ? WHERE id = ?').run(totalUse, amount, materialId);
  return { total_use: totalUse, amount };
}

/** 读一个物料的颜色行 */
function colorsOf(materialId) {
  return db.prepare(
    'SELECT id, colorway, color_no, qty, note FROM order_material_colors WHERE order_material_id = ? ORDER BY id'
  ).all(materialId);
}

/**
 * 整单物料清单（带款、颜色）
 *
 * 一次查完再拼，不逐行查：一张单几十行物料时，逐行查会把接口拖到几百毫秒，
 * 而且前端还要按款分组显示。
 */
function listByOrder(orderId) {
  const rows = db.prepare(
    `SELECT m.*, i.style_no AS item_style_no, i.product_name AS item_product_name
       FROM order_materials m LEFT JOIN order_items i ON i.id = m.item_id
      WHERE m.order_id = ? ORDER BY m.type, m.item_id, m.id`
  ).all(orderId);

  const allColors = db.prepare(
    `SELECT s.item_id, s.color, SUM(s.qty) qty FROM order_item_sizes s
       JOIN order_items i ON i.id = s.item_id
      WHERE i.order_id = ? AND IFNULL(s.color,'') <> ''
      GROUP BY s.item_id, s.color ORDER BY MIN(s.id)`
  ).all(orderId);

  const byItem = new Map();
  allColors.forEach((c) => {
    if (!byItem.has(c.item_id)) byItem.set(c.item_id, []);
    byItem.get(c.item_id).push({ colorway: c.color, qty: Number(c.qty) || 0 });
  });

  const colorsStmt = db.prepare(
    'SELECT colorway, color_no, qty FROM order_material_colors WHERE order_material_id = ? ORDER BY id'
  );

  return rows.map((m) => {
    const colors = colorsStmt.all(m.id);
    const itemColors = m.item_id ? (byItem.get(m.item_id) || []) : [];
    return {
      ...m,
      item: m.item_id
        ? { id: m.item_id, style_no: m.item_style_no, product_name: m.item_product_name }
        : null,
      colors,
      /** 该款可选的色（配置弹窗用） */
      item_colors: itemColors,
      /**
       * 界面上「适用颜色」这一列显示什么：
       *   all_colors=1 → 全部（3 色）
       *   有子表      → 印花001、印花003
       *   都没有      → 未指定（老数据 / 订单通用）
       */
      color_summary: Number(m.all_colors) === 1
        ? (itemColors.length ? `全部 ${itemColors.length} 色` : '全部颜色')
        : (colors.length ? colors.map((c) => c.colorway).join('、') : '未指定')
    };
  });
}

module.exports = {
  qtyOf, qtyOfColor, colorsOfItem, colorsOf,
  assertColorsBelong, replaceColors, recalc, listByOrder, round2
};
