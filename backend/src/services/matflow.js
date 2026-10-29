/**
 * M10 备料领退与盘点差异服务层
 * ============================================================
 * 原料库存(`materials.stock_qty`)在这里第一次有了**流水支撑**。
 *
 * 全局硬规则（都不依赖人记）：
 *   1) 原料余额只有一处写入口：`applyStock()` —— 写流水 + 改余额同一事务，禁止裸 UPDATE。
 *   2) **备料即占用，发料才扣减**：`prepared` 状态的单据把可用量占住，
 *      避免「两个车间同时看到 100 米、各领 100 米」→ 第二张发料单发不出去。
 *   3) **发料不许超占用量**：实发 ≤ 已备料量；要超领必须先改备料量（改不动就说明被别人占了）。
 *   4) **欠发要留痕**：实发 < 需求 → 单据转 `partial`，欠发数量挂在明细上，不能静默视为齐套。
 *   5) **退料不许超过已领未退**：可退 = 已发 − 已退。
 *   6) **盘点冻结**：`counting` / `submitted` 期间，原料的领料、退料、收货一律拦住。
 *   7) **未盘的料不进差异**：`count_qty = NULL` 表示没盘，不当 0 算盘亏。
 *   8) **有差异必须写原因**（≥4 字），否则不许提交；盘盈也要原因。
 *   9) **差异按最近采购价计价**；没有采购价 → 金额 NULL（不是 0），并计入 `uncosted_count`，
 *      报表里必须显示「N 条未计价」，不能把「不知道多少钱」算成「没损失」。
 *   10) 盘点调账只调数量（写 `stock_gain` / `stock_loss` 流水），**不改采购价、不生成凭证**。
 */
const { db } = require('../db');
const OMC = require('./orderMaterialColors');   // 件数口径与颜色归属只认这一份实现

const EPS = 0.005;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const int0 = (v) => Math.round(num(v));
const pad = (n) => String(n).padStart(2, '0');

function now() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

/** 单号：前缀 + 当日最大序号 +1（禁用 COUNT(*)+1，删过行就撞号） */
function nextNo(table, col, prefix) {
  const d = new Date();
  const p = `${prefix}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rows = db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ?`).all(`${p}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.no).slice(p.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  let seq = max + 1;
  let no = `${p}${String(seq).padStart(4, '0')}`;
  while (db.prepare(`SELECT 1 x FROM ${table} WHERE ${col} = ?`).get(no)) {
    seq += 1;
    no = `${p}${String(seq).padStart(4, '0')}`;
  }
  return no;
}

// ---------- 库存唯一写入口 ----------

/**
 * 改原料库存：必须同时写流水。
 * @param {object} p {materialId, materialName, type, qty(带符号), unit, refType, refId, refNo, remark, operator}
 * @returns {number} 变动后余额
 */
function applyStock(p, t) {
  const ts = t || now();
  const mat = db.prepare('SELECT id, name, unit, stock_qty, type FROM materials WHERE id = ?').get(p.materialId);
  if (!mat) throw new Error(`原料 #${p.materialId} 不存在`);
  const before = num(mat.stock_qty);
  const after = r2(before + num(p.qty));
  db.prepare('UPDATE materials SET stock_qty = ?, updated_at = ? WHERE id = ?').run(after, ts, p.materialId);
  db.prepare(
    `INSERT INTO material_ledger
       (company_id, material_id, material_name, type, qty, unit, ref_type, ref_id, ref_no, remark, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    p.companyId || 1, p.materialId, mat.name, p.type, r2(p.qty), p.unit || mat.unit || '',
    p.refType || null, p.refId || null, p.refNo || null, p.remark || null, p.operator || 'system', ts
  );
  return after;
}

/** 最近采购单价：取该原料最后一次采购明细的单价；从没采购过 → null（不猜价格） */
function lastPrice(materialId) {
  if (!materialId) return null;
  const r = db.prepare(
    `SELECT price FROM purchase_items WHERE material_id = ? AND price > 0 ORDER BY id DESC LIMIT 1`
  ).get(materialId);
  return r && num(r.price) > 0 ? r2(r.price) : null;
}

/**
 * 占用中（已备料未发料）的数量：按原料汇总
 * @param {number} excludeIssueId 排除某张单（发料时必须排除自己，
 *   否则本单已占用的量会被当成「别人占的」，出现「备了 1188、账面 1500、可用却只有 312」）
 * @param {number} excludeOrderId 排除某订单下所有单（同一订单再次备料时，
 *   它自己之前的占用不能算成自己的缺口——那批料本来就是给它留的）
 */
function reservedOf(materialId, excludeIssueId, excludeOrderId) {
  const extra = [];
  const args = [materialId];
  if (excludeIssueId) { extra.push('AND d.id <> ?'); args.push(excludeIssueId); }
  if (excludeOrderId) { extra.push('AND (d.order_id IS NULL OR d.order_id <> ?)'); args.push(excludeOrderId); }
  const r = db.prepare(
    `SELECT COALESCE(SUM(i.req_qty - i.issued_qty),0) q
     FROM material_issue_items i JOIN material_issues d ON d.id = i.issue_id
     WHERE i.material_id = ? AND d.status = 'prepared' ${extra.join(' ')}`
  ).get(...args);
  return r2(Math.max(0, num(r.q)));
}

/** 可用量 = 账面 − 已备未发（占用），可排除本单 / 本订单 */
function availableOf(materialId, excludeIssueId, excludeOrderId) {
  const m = db.prepare('SELECT stock_qty FROM materials WHERE id = ?').get(materialId);
  if (!m) return 0;
  return r2(num(m.stock_qty) - reservedOf(materialId, excludeIssueId, excludeOrderId));
}

/** 盘点冻结检查：原料盘点进行中不许动库存 */
function assertNotFrozen(scope) {
  const sc = scope || 'material';
  const f = db.prepare(
    `SELECT take_no, take_date, status FROM stocktakes
     WHERE scope = ? AND status IN ('counting','submitted') AND freeze = 1
     ORDER BY id DESC LIMIT 1`
  ).get(sc);
  if (f) {
    throw new Error(`盘点单 ${f.take_no}（${f.take_date}）${f.status === 'counting' ? '正在盘点' : '已提交待调账'}，库存冻结中：请先完成或取消盘点再操作`);
  }
}

// ---------- 备料 / 领料 ----------

/**
 * 订单用料建议：把 order_materials 变成备料明细，并带出可用量与缺口
 *
 * ## 按「款 × 颜色」展开
 *
 * 物料配了颜色 → 一行一个颜色（`order_material_colors` 有几行就出几行）；
 * 配的是「全部颜色通用」或压根没配 → 一行，颜色留空，按整款件数算。
 *
 * ## 已发量必须按同一个口径扣
 *
 * 分色行只能扣**同款同色**的发料量。拿整料的已发量去减每个颜色，会把同一个
 * 306 米从两个颜色里各减一次，看起来「早就领够了」，实际一米没发。
 * 所以：
 *   分色行 → 只减 (原料, 款, 色) 完全相同的已发
 *   未分色行 → 减该原料在该订单的全部已发
 *
 * ## 老单据（未分色）已经在发的料不摊派
 *
 * 历史领料单没有款/色（`item_id=0`、`colorway=''`）。那些料已经发出去了，
 * 但**发给了哪个颜色无从得知**。这时若还按颜色出建议，用户会以为「一米没领」，
 * 再领一遍就是双倍。所以整料退回到总量口径：只出一行、扣掉全部已发、
 * 在 `color_mode='legacy'` 上标出来 —— 不猜、不摊派，让人按总量核对。
 */
function suggestFromOrder(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new Error('订单不存在');
  // 面料在前、辅料在后：仓库是照这个顺序配料的，界面上倒过来会让人来回翻
  const rows = db.prepare(
    `SELECT * FROM order_materials WHERE order_id = ?
      ORDER BY CASE type WHEN 'fabric' THEN 0 ELSE 1 END, item_id, id`
  ).all(orderId);

  const mKeyOf = (materialId, name) => `${materialId || 0}|${name}`;
  const cKeyOf = (materialId, name, itemId, colorway) => `${mKeyOf(materialId, name)}|${int0(itemId)}|${colorway || ''}`;

  const issuedRows = db.prepare(
    `SELECT i.material_id, i.name, i.item_id, i.colorway,
            COALESCE(SUM(i.issued_qty - i.returned_qty),0) q
     FROM material_issue_items i JOIN material_issues d ON d.id = i.issue_id
     WHERE d.order_id = ? AND d.status IN ('issued','partial','closed')
     GROUP BY i.material_id, i.name, i.item_id, i.colorway`
  ).all(orderId);

  const issuedByColor = new Map();   // 精确到款+色
  const issuedByMat = new Map();     // 整料（含未分色）
  const issuedColored = new Map();   // 整料里已经分过色的部分
  issuedRows.forEach((r) => {
    const q = r2(num(r.q));
    issuedByColor.set(cKeyOf(r.material_id, r.name, r.item_id, r.colorway), q);
    const mk = mKeyOf(r.material_id, r.name);
    issuedByMat.set(mk, r2((issuedByMat.get(mk) || 0) + q));
    if (int0(r.item_id) || String(r.colorway || '')) {
      issuedColored.set(mk, r2((issuedColored.get(mk) || 0) + q));
    }
  });

  const styleOf = new Map(
    db.prepare('SELECT id, style_no, product_name FROM order_items WHERE order_id = ?').all(orderId)
      .map((i) => [Number(i.id), i])
  );
  const colorsStmt = db.prepare('SELECT colorway, color_no, qty FROM order_material_colors WHERE order_material_id = ? ORDER BY id');

  const lines = [];
  const mismatch = [];
  rows.forEach((m) => {
    const loss = 1 + (num(m.loss) || 0) / 100;
    const oneUse = num(m.one_use);
    const style = m.item_id ? styleOf.get(int0(m.item_id)) : null;
    const base = {
      order_material_id: m.id,
      material_id: m.material_id,
      name: m.name,
      spec: m.spec,
      unit: m.unit,
      item_id: int0(m.item_id),
      style_no: style ? style.style_no : '',
      product_name: style ? style.product_name : '',
      price: num(m.price) > 0 ? r2(m.price) : lastPrice(m.material_id),
      linked: !!m.material_id
    };
    const colors = colorsStmt.all(m.id);
    const made = [];
    if (num(m.all_colors) === 1 || !colors.length) {
      const piece = OMC.qtyOf(m.order_id, m.item_id);
      made.push({
        ...base,
        colorway: '',
        color_no: null,
        color_mode: num(m.all_colors) === 1 ? 'all' : 'none',
        color_label: num(m.all_colors) === 1 ? '全部颜色' : '未指定颜色',
        piece_qty: piece,
        one_use: r2(oneUse),
        order_total: r2(oneUse * piece * loss)
      });
    } else {
      colors.forEach((c) => {
        const one = c.qty === null || c.qty === undefined ? oneUse : num(c.qty);
        const piece = OMC.qtyOfColor(m.item_id, c.colorway);
        made.push({
          ...base,
          colorway: c.colorway,
          color_no: c.color_no || null,
          color_mode: 'per_color',
          color_label: c.colorway,
          piece_qty: piece,
          one_use: r2(one),
          order_total: r2(one * piece * loss)
        });
      });
      // 同一套账两个数：分色合计必须等于物料行上的总用量（差在 0.02 以上说明 total_use 没重算）
      const sum = r2(made.reduce((s, x) => s + x.order_total, 0));
      if (Math.abs(sum - num(m.total_use)) > 0.02) {
        mismatch.push(`${m.name}（${style ? style.style_no : '不分款'}）：分色合计 ${sum}，物料总用量 ${r2(num(m.total_use))}`);
      }
    }
    made.forEach((x) => lines.push(x));
  });

  /**
   * 同一原料 + 同一款 + 同一色只留一行（两张物料行填成一样的料时合并，别让仓库领两遍）
   */
  const merged = new Map();
  let mergedRows = 0;
  lines.forEach((x) => {
    const k = `${cKeyOf(x.material_id, x.name, x.item_id, x.colorway)}|${x.spec || ''}`;
    const hit = merged.get(k);
    if (hit) {
      hit.order_total = r2(hit.order_total + x.order_total);
      hit.piece_qty = r2(hit.piece_qty + x.piece_qty);
      mergedRows += 1;
    } else {
      merged.set(k, { ...x });
    }
  });

  /** 有历史未分色发料的料 → 退回总量口径（一行，扣全部已发），不摊派到颜色 */
  const legacyMats = new Set();
  issuedByMat.forEach((all, mk) => {
    if (all - (issuedColored.get(mk) || 0) > EPS) legacyMats.add(mk);
  });

  const groups = new Map();
  [...merged.values()].forEach((x) => {
    const mk = mKeyOf(x.material_id, x.name);
    if (!groups.has(mk)) groups.set(mk, []);
    groups.get(mk).push(x);
  });

  const items = [];
  groups.forEach((list, mk) => {
    const legacy = legacyMats.has(mk);
    if (legacy) {
      const total = r2(list.reduce((s, x) => s + x.order_total, 0));
      const already = r2(issuedByMat.get(mk) || 0);
      const head = list[0];
      items.push({
        ...head,
        item_id: 0,
        style_no: '',
        colorway: '',
        color_no: null,
        color_mode: 'legacy',
        color_label: list.length > 1 ? `历史已发未分色（${list.length} 色合并）` : '历史已发未分色',
        piece_qty: r2(list.reduce((s, x) => s + x.piece_qty, 0)),
        order_total: total,
        already_issued: already,
        req_qty: r2(Math.max(0, total - already)),
        note: '这料之前有未分色的发料记录，本行按总量核对；后续按色发料请先把这张单结清'
      });
      return;
    }
    list.forEach((x) => {
      const already = r2(issuedByColor.get(cKeyOf(x.material_id, x.name, x.item_id, x.colorway)) || 0);
      const total = r2(x.order_total);
      items.push({
        ...x,
        order_total: total,
        already_issued: already,
        req_qty: r2(Math.max(0, total - already)),
        note: x.color_mode === 'none' && x.item_id ? '该款还没配颜色，按整款件数算' : null
      });
    });
  });

  items.forEach((x) => {
    const avail = x.material_id ? availableOf(x.material_id, null, orderId) : null;
    x.stock_qty = x.material_id ? r2(num((db.prepare('SELECT stock_qty FROM materials WHERE id = ?').get(x.material_id) || {}).stock_qty)) : null;
    x.reserved = x.material_id ? reservedOf(x.material_id, null, orderId) : null;
    x.available = avail;
    x.gap = avail === null ? null : r2(Math.max(0, num(x.req_qty) - avail));
  });

  const warnings = [];
  if (mismatch.length) warnings.push(`分色合计与物料总用量不一致：${mismatch.slice(0, 3).join('；')}`);
  if (legacyMats.size) warnings.push(`${legacyMats.size} 个原料有未分色的历史发料，已按总量单列出单（不摊到颜色）`);
  if (mergedRows) warnings.push(`合并了 ${mergedRows} 行重复的「同料同款同色」需求`);

  return {
    order: { id: o.id, order_no: o.order_no, style_no: o.style_name, type: o.type, status: o.status },
    items,
    unlinked: items.filter((x) => !x.linked).length,
    shortage: items.filter((x) => x.gap !== null && x.gap > EPS).length,
    color_lines: items.filter((x) => x.color_mode === 'per_color').length,
    legacy_lines: items.filter((x) => x.color_mode === 'legacy').length,
    item_count: items.length,
    warnings
  };
}

function listIssues(q) {
  const where = [];
  const args = [];
  if (q.status) { where.push('d.status = ?'); args.push(q.status); }
  if (q.order_no) { where.push('d.order_no LIKE ?'); args.push(`%${q.order_no}%`); }
  if (q.kind) { where.push('d.kind = ?'); args.push(q.kind); }
  if (q.from) { where.push('date(d.created_at) >= ?'); args.push(q.from); }
  if (q.to) { where.push('date(d.created_at) <= ?'); args.push(q.to); }
  const rows = db.prepare(
    `SELECT d.*, (d.req_qty - d.issued_qty) AS open_qty
     FROM material_issues d ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY d.id DESC LIMIT ?`
  ).all(...args, Math.min(500, Number(q.limit) || 200));
  return rows.map((r) => ({
    ...r,
    status_label: ISSUE_STATUS[r.status] || r.status,
    kind_label: ISSUE_KIND[r.kind] || r.kind,
    open_qty: r2(num(r.open_qty)),
    overdue: r.req_date && r.req_date < today() && ['draft', 'prepared', 'partial'].includes(r.status)
  }));
}

const ISSUE_STATUS = {
  draft: '草稿', prepared: '已备料', issued: '已发料', partial: '部分发出', closed: '已结案', cancelled: '已取消'
};
const ISSUE_KIND = { order: '订单备料', extra: '车间补料', sample: '打样领料' };
const RETURN_TYPE = {
  leftover: '余料退回', wrong_spec: '规格不符', defect: '质量不合格', order_cancel: '订单取消'
};
const TAKE_STATUS = { draft: '草稿', counting: '盘点中', submitted: '待调账', adjusted: '已调账', cancelled: '已取消' };

function issueDetail(id) {
  const d = db.prepare('SELECT * FROM material_issues WHERE id = ?').get(id);
  if (!d) return null;
  const items = db.prepare(
    `SELECT i.*, (i.issued_qty - i.returned_qty) AS returnable,
            (i.req_qty - i.issued_qty) AS short,
            oi.style_no AS item_style_no, oi.product_name AS item_product_name
     FROM material_issue_items i
     LEFT JOIN order_items oi ON oi.id = i.item_id
     WHERE i.issue_id = ? ORDER BY i.item_id, i.colorway, i.id`
  ).all(id).map((r) => ({
    ...r,
    item_id: int0(r.item_id),
    colorway: r.colorway || '',
    returnable: r2(Math.max(0, num(r.returnable))),
    short: r2(Math.max(0, num(r.short))),
    stock_qty: r.material_id ? r2(num((db.prepare('SELECT stock_qty FROM materials WHERE id=?').get(r.material_id) || {}).stock_qty)) : null,
    available: r.material_id ? availableOf(r.material_id, id) : null
  }));

  /** 按款+颜色汇总：分色发料后唯一能回答「印花001 到底领了多少」的地方 */
  const byColor = [];
  const cMap = new Map();
  items.forEach((x) => {
    const k = `${x.item_id}|${x.colorway}`;
    if (!cMap.has(k)) {
      cMap.set(k, {
        item_id: x.item_id, style_no: x.item_style_no || '', product_name: x.item_product_name || '',
        colorway: x.colorway, color_no: x.color_no || null,
        req_qty: 0, issued_qty: 0, short: 0, returned_qty: 0
      });
    }
    const g = cMap.get(k);
    g.req_qty = r2(g.req_qty + num(x.req_qty));
    g.issued_qty = r2(g.issued_qty + num(x.issued_qty));
    g.short = r2(g.short + num(x.short));
    g.returned_qty = r2(g.returned_qty + num(x.returned_qty));
    if (!g.color_no && x.color_no) g.color_no = x.color_no;
  });
  cMap.forEach((g) => byColor.push(g));

  const returns = db.prepare('SELECT * FROM material_returns WHERE issue_id = ? ORDER BY id DESC').all(id)
    .map((r) => ({ ...r, type_label: RETURN_TYPE[r.type] || r.type }));
  const ledgers = db.prepare(
    `SELECT * FROM material_ledger WHERE ref_type IN ('material_issue','material_return') AND ref_id = ?
     ORDER BY id DESC LIMIT 100`
  ).all(id);
  return {
    ...d,
    status_label: ISSUE_STATUS[d.status] || d.status,
    kind_label: ISSUE_KIND[d.kind] || d.kind,
    open_qty: r2(num(d.req_qty) - num(d.issued_qty)),
    items,
    by_color: byColor,
    colored: items.filter((x) => x.colorway || x.item_id).length,
    returns,
    ledgers,
    can: {
      prepare: d.status === 'draft',
      issue: ['prepared', 'partial'].includes(d.status),
      return: ['issued', 'partial', 'closed'].includes(d.status) && items.some((x) => x.returnable > EPS),
      close: ['issued', 'partial'].includes(d.status),
      cancel: ['draft', 'prepared'].includes(d.status)
    }
  };
}

function createIssue(b, operator) {
  const items = Array.isArray(b.items) ? b.items : [];
  const clean = items
    .map((x) => ({
      material_id: x.material_id ? int0(x.material_id) : null,
      name: String(x.name || '').trim(),
      spec: x.spec || null,
      unit: x.unit || '',
      req_qty: r2(num(x.req_qty)),
      price: x.price === null || x.price === undefined || x.price === '' ? null : r2(num(x.price)),
      batch_no: x.batch_no || null,
      remark: x.remark || null,
      item_id: x.item_id ? int0(x.item_id) : 0,
      colorway: String(x.colorway || '').trim(),
      color_no: x.color_no || null
    }))
    .filter((x) => x.name && x.req_qty > EPS);

  if (!clean.length) throw new Error('至少要有一样原料，且数量大于 0');
  // 校验全在事务之前
  const orderId = b.order_id ? int0(b.order_id) : null;
  let order = null;
  if (orderId) {
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new Error('订单不存在');
    if (['cancelled', 'closed'].includes(order.status)) throw new Error(`订单 ${order.order_no} 已${order.status === 'cancelled' ? '取消' : '结案'}，不能再备料`);
  }

  /**
   * 款与颜色：颜色必须属于这个款。
   *
   * 没有款的「颜色」是自由文本，谁也保证不了它是真的颜色；
   * 发料时才发现在系统里查不到这个色，就是车间台账和系统账对不上的起点。
   */
  clean.forEach((x) => {
    if (!x.colorway) { x.color_no = null; return; }
    if (!x.item_id) throw new Error(`「${x.name}」填了颜色「${x.colorway}」但没指定是哪个款：颜色属于款，请先选款`);
    const item = db.prepare('SELECT id, order_id, style_no FROM order_items WHERE id = ?').get(x.item_id);
    if (!item) throw new Error(`款 #${x.item_id} 不存在`);
    if (orderId && Number(item.order_id) !== Number(orderId)) throw new Error(`款 ${item.style_no} 不属于这张订单，不能挂到这张领料单上`);
    OMC.assertColorsBelong(x.item_id, [x.colorway]);   // 不属于该款直接拒（带出该款真实颜色）
  });

  const dup = new Set();
  clean.forEach((x) => {
    const k = `${x.material_id || 0}|${x.name}|${x.item_id || 0}|${x.colorway || ''}`;
    if (dup.has(k)) {
      const label = x.colorway ? `「${x.name}」的「${x.colorway}」` : `原料「${x.name}」`;
      throw new Error(`${label}重复出现，同一张单同一款同一色只能有一行（数量请合并）`);
    }
    dup.add(k);
  });
  const kind = ['order', 'extra', 'sample'].includes(b.kind) ? b.kind : 'order';
  if (kind === 'order' && !orderId) throw new Error('订单备料必须选订单；车间补料/打样领料请换类型');
  if (kind === 'extra' && !String(b.note || '').trim()) throw new Error('车间补料必须写补料原因');

  const ts = now();
  const no = nextNo('material_issues', 'issue_no', 'LL');
  const reqQty = r2(clean.reduce((s, x) => s + x.req_qty, 0));

  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO material_issues
        (issue_no, company_id, order_id, order_no, style_no, kind, receiver_type, factory_id, factory_name,
         req_date, status, item_count, req_qty, issued_qty, amount, note, created_by, created_at, updated_at, demo_tag)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,0,0,?,?,?,?,?)`
    ).run(
      no, 1, orderId, order ? order.order_no : null, order ? order.style_name : null,
      kind, b.receiver_type === 'outsource' ? 'outsource' : 'own',
      b.factory_id ? int0(b.factory_id) : null, b.factory_name || null,
      b.req_date || today(), clean.length, reqQty, b.note || null, operator, ts, ts, b.demo_tag || null
    );
    const issueId = info.lastInsertRowid;
    const stmt = db.prepare(
      `INSERT INTO material_issue_items
        (issue_id, material_id, name, spec, unit, req_qty, issued_qty, returned_qty, price, amount, batch_no, short_qty, remark,
         item_id, colorway, color_no)
       VALUES (?,?,?,?,?,?,0,0,?,0,?,?,?,?,?,?)`
    );
    clean.forEach((x) => {
      const price = x.price !== null ? x.price : lastPrice(x.material_id);
      stmt.run(issueId, x.material_id, x.name, x.spec, x.unit, x.req_qty, price, x.batch_no, x.req_qty, x.remark,
        x.item_id, x.colorway, x.color_no);
    });
    db.exec('COMMIT');
    return issueDetail(issueId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 备料：占用库存。占用按原料汇总检查，避免同一原料多行重复占用 */
function prepareIssue(id, operator) {
  const d = db.prepare('SELECT * FROM material_issues WHERE id = ?').get(id);
  if (!d) throw new Error('备料单不存在');
  if (d.status !== 'draft') throw new Error(`当前状态「${ISSUE_STATUS[d.status] || d.status}」不能备料（只有草稿能备料）`);
  const items = db.prepare('SELECT * FROM material_issue_items WHERE issue_id = ?').all(id);
  if (!items.length) throw new Error('单据没有明细');

  // 同一原料多行合并检查；没关联原料档案的行无法占用（只能备注手工核对）
  const need = new Map();
  items.forEach((x) => {
    if (!x.material_id) return;
    need.set(x.material_id, r2((need.get(x.material_id) || 0) + num(x.req_qty)));
  });
  const shorts = [];
  need.forEach((qty, mid) => {
    const avail = availableOf(mid);   // 已备未发已经扣掉，本单还是 draft 不占
    if (qty > avail + EPS) {
      const m = db.prepare('SELECT name, unit FROM materials WHERE id = ?').get(mid);
      shorts.push(`${m.name} 需 ${qty}${m.unit || ''}，可用 ${avail}${m.unit || ''}，缺 ${r2(qty - avail)}`);
    }
  });
  if (shorts.length) {
    throw new Error(`备料量超过可用库存，请先改数量或补货：${shorts.join('；')}`);
  }
  const unlinked = items.filter((x) => !x.material_id);
  if (unlinked.length) {
    throw new Error(`有 ${unlinked.length} 行没关联原料档案（${unlinked.slice(0, 3).map((x) => x.name).join('、')}），无法占用与扣减库存：请先在原料库补齐档案再备料`);
  }

  const ts = now();
  db.prepare("UPDATE material_issues SET status='prepared', prepared_by=?, prepared_at=?, updated_at=? WHERE id=?")
    .run(operator, ts, ts, id);
  return issueDetail(id);
}

/** 发料：扣库存。允许少发，少发转 partial 并记欠发 */
function issueOut(id, b, operator) {
  const d = db.prepare('SELECT * FROM material_issues WHERE id = ?').get(id);
  if (!d) throw new Error('备料单不存在');
  if (!['prepared', 'partial'].includes(d.status)) throw new Error(`当前状态「${ISSUE_STATUS[d.status] || d.status}」不能发料（需先备料）`);
  assertNotFrozen('material');

  const rows = db.prepare('SELECT * FROM material_issue_items WHERE issue_id = ?').all(id);
  const input = Array.isArray(b.items) && b.items.length ? b.items : rows.map((r) => ({ id: r.id, issued_qty: num(r.req_qty) - num(r.issued_qty) }));
  const tag = (r) => `「${r.name}${r.colorway ? ' · ' + r.colorway : ''}」`;
  const plan = [];
  for (const x of input) {
    const row = rows.find((r) => r.id === int0(x.id));
    if (!row) throw new Error(`明细 #${x.id} 不属于本单`);
    const want = r2(num(x.issued_qty));
    if (want < -EPS) throw new Error('发料数量不能为负');
    const left = r2(num(row.req_qty) - num(row.issued_qty));
    if (want > left + EPS) throw new Error(`${tag(row)}本次发 ${want} 超过未发量 ${left}；要超领请先改备料量`);
    if (want <= EPS) continue;
    const avail = availableOf(row.material_id, id);
    if (want > avail + EPS) throw new Error(`${tag(row)}可用只有 ${avail}，发不出 ${want}（可扣本单已备量后仍不足）`);
    plan.push({ row, qty: want, batch_no: x.batch_no || row.batch_no, price: x.price === undefined ? row.price : (x.price === null ? null : r2(num(x.price))) });
  }
  if (!plan.length) throw new Error('没有填任何发料数量');

  // 同一原料多行合计也不能超可用
  const byMat = new Map();
  plan.forEach((p) => {
    if (!p.row.material_id) return;
    byMat.set(p.row.material_id, r2((byMat.get(p.row.material_id) || 0) + p.qty));
  });
  byMat.forEach((qty, mid) => {
    const avail = availableOf(mid, id);
    if (qty > avail + EPS) {
      const m = db.prepare('SELECT name, unit FROM materials WHERE id = ?').get(mid);
      throw new Error(`「${m.name}」合计发 ${qty} 超过可用 ${avail}`);
    }
  });

  const ts = now();
  db.exec('BEGIN');
  try {
    let amountTotal = 0;
    plan.forEach((p) => {
      const price = p.price === null ? lastPrice(p.row.material_id) : p.price;
      const amount = price === null ? 0 : r2(p.qty * price);
      amountTotal = r2(amountTotal + amount);
      db.prepare(
        `UPDATE material_issue_items
           SET issued_qty = ?, amount = ?, short_qty = MAX(0, req_qty - ?),
               price = COALESCE(?, price), batch_no = COALESCE(?, batch_no)
         WHERE id = ?`
      ).run(r2(num(p.row.issued_qty) + p.qty), r2(num(p.row.amount) + amount), r2(num(p.row.issued_qty) + p.qty), price, p.batch_no || null, p.row.id);
      applyStock({
        materialId: p.row.material_id, type: 'issue', qty: -p.qty, unit: p.row.unit,
        refType: 'material_issue', refId: id, refNo: d.issue_no,
        remark: `${ISSUE_KIND[d.kind] || d.kind}${d.order_no ? ' · ' + d.order_no : ''}`
          + `${p.row.colorway ? ' · ' + p.row.colorway : ''}`
          + `${p.row.color_no ? '(' + p.row.color_no + ')' : ''}`
          + `${p.batch_no ? ' · 缸号 ' + p.batch_no : ''}`,
        operator
      }, ts);
    });

    const after = db.prepare('SELECT * FROM material_issue_items WHERE issue_id = ?').all(id);
    const issued = r2(after.reduce((s, r) => s + num(r.issued_qty), 0));
    const req = r2(after.reduce((s, r) => s + num(r.req_qty), 0));
    const openQty = r2(req - issued);
    const status = openQty > EPS ? 'partial' : 'issued';
    db.prepare('UPDATE material_issues SET status=?, issued_qty=?, amount=?, issued_by=?, issued_at=?, updated_at=? WHERE id=?')
      .run(status, issued, r2(num(d.amount) + amountTotal), operator, ts, ts, id);
    db.exec('COMMIT');
    return { ...issueDetail(id), short_now: openQty > EPS, open_qty: openQty };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 结案：还有欠发时要写说明（不许把欠发静默关掉） */
function closeIssue(id, note, operator) {
  const d = db.prepare('SELECT * FROM material_issues WHERE id = ?').get(id);
  if (!d) throw new Error('备料单不存在');
  if (!['issued', 'partial'].includes(d.status)) throw new Error('只有已发料（含部分发出）的单据能结案');
  const open = r2(num(d.req_qty) - num(d.issued_qty));
  if (open > EPS && String(note || '').trim().length < 4) {
    throw new Error(`还有 ${open} 未发出，结案必须写说明（例如「余量车间自购」「订单已减量」）`);
  }
  const ts = now();
  db.prepare("UPDATE material_issues SET status='closed', closed_by=?, closed_at=?, updated_at=?, note=COALESCE(?, note) WHERE id=?")
    .run(operator, ts, ts, note || null, id);
  return issueDetail(id);
}

function cancelIssue(id, reason, operator) {
  const d = db.prepare('SELECT * FROM material_issues WHERE id = ?').get(id);
  if (!d) throw new Error('备料单不存在');
  if (!['draft', 'prepared'].includes(d.status)) throw new Error('已发料的单据不能取消，请走退料');
  if (String(reason || '').trim().length < 4) throw new Error('取消备料单必须写原因（≥4 字）');
  const ts = now();
  db.prepare("UPDATE material_issues SET status='cancelled', note=?, updated_at=? WHERE id=?")
    .run(`[取消] ${reason}`, ts, id);
  return issueDetail(id);
}

// ---------- 退料 ----------

function listReturns(q) {
  const where = [];
  const args = [];
  if (q.status) { where.push('r.status = ?'); args.push(q.status); }
  if (q.order_no) { where.push('r.order_no LIKE ?'); args.push(`%${q.order_no}%`); }
  const rows = db.prepare(
    `SELECT r.*, d.issue_no FROM material_returns r LEFT JOIN material_issues d ON d.id = r.issue_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT ?`
  ).all(...args, Math.min(300, Number(q.limit) || 150));
  return rows.map((r) => ({ ...r, type_label: RETURN_TYPE[r.type] || r.type, status_label: r.status === 'draft' ? '草稿' : (r.status === 'confirmed' ? '已入库' : '已取消') }));
}

function createReturn(b, operator) {
  const issueId = int0(b.issue_id);
  const d = db.prepare('SELECT * FROM material_issues WHERE id = ?').get(issueId);
  if (!d) throw new Error('退料必须选一张领料单');
  if (!['issued', 'partial', 'closed'].includes(d.status)) throw new Error('这张单还没发过料，没有可退的');
  const reason = String(b.reason || '').trim();
  if (reason.length < 4) throw new Error('退料原因必填（≥4 字），写清是余料、规格错还是质量问题');
  const type = RETURN_TYPE[b.type] ? b.type : 'leftover';

  const items = db.prepare('SELECT * FROM material_issue_items WHERE issue_id = ?').all(issueId);
  const input = Array.isArray(b.items) ? b.items.filter((x) => r2(num(x.qty)) > EPS) : [];
  if (!input.length) throw new Error('至少填一行退料数量');

  const plan = [];
  for (const x of input) {
    const row = items.find((r) => r.id === int0(x.issue_item_id));
    if (!row) throw new Error(`明细 #${x.issue_item_id} 不属于该领料单`);
    const qty = r2(num(x.qty));
    const can = r2(num(row.issued_qty) - num(row.returned_qty));
    if (qty > can + EPS) throw new Error(`「${row.name}${row.colorway ? ' · ' + row.colorway : ''}」可退只有 ${can}（已发 ${row.issued_qty} − 已退 ${row.returned_qty}），退不了 ${qty}`);
    plan.push({ row, qty });
  }

  const ts = now();
  const no = nextNo('material_returns', 'return_no', 'TL');
  const totalQty = r2(plan.reduce((s, p) => s + p.qty, 0));
  const totalAmount = r2(plan.reduce((s, p) => s + p.qty * num(p.row.price), 0));

  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO material_returns (return_no, company_id, issue_id, order_id, order_no, type, status, qty, amount, reason, created_by, created_at, updated_at, demo_tag)
       VALUES (?,1,?,?,?,?, 'draft', ?,?,?,?,?,?,?)`
    ).run(no, issueId, d.order_id, d.order_no, type, totalQty, totalAmount, reason, operator, ts, ts, b.demo_tag || null);
    const rid = info.lastInsertRowid;
    const stmt = db.prepare(
      `INSERT INTO material_return_items (return_id, issue_item_id, material_id, name, spec, unit, qty, price, amount, batch_no, remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    plan.forEach((p) => {
      stmt.run(rid, p.row.id, p.row.material_id, p.row.name, p.row.spec, p.row.unit, p.qty, p.row.price, r2(p.qty * num(p.row.price)), p.row.batch_no, p.row.remark);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return returnDetail(ridOf(no));
}

function ridOf(no) {
  return db.prepare('SELECT id FROM material_returns WHERE return_no = ?').get(no).id;
}

function returnDetail(id) {
  const r = db.prepare(
    `SELECT r.*, d.issue_no FROM material_returns r LEFT JOIN material_issues d ON d.id = r.issue_id WHERE r.id = ?`
  ).get(id);
  if (!r) return null;
  return {
    ...r,
    type_label: RETURN_TYPE[r.type] || r.type,
    // 颜色从领料明细带过来：退料单自己不再存一份，避免两处存的色不一致
    items: db.prepare(
      `SELECT t.*, i.item_id, i.colorway, i.color_no, oi.style_no AS item_style_no
         FROM material_return_items t
         LEFT JOIN material_issue_items i ON i.id = t.issue_item_id
         LEFT JOIN order_items oi ON oi.id = i.item_id
        WHERE t.return_id = ? ORDER BY t.id`
    ).all(id).map((x) => ({ ...x, colorway: x.colorway || '', item_id: int0(x.item_id) }))
  };
}

/** 退料入库：加回库存 + 写流水 + 累加已退 */
function confirmReturn(id, operator) {
  const r = db.prepare('SELECT * FROM material_returns WHERE id = ?').get(id);
  if (!r) throw new Error('退料单不存在');
  if (r.status !== 'draft') throw new Error('只有草稿状态的退料单能入库');
  assertNotFrozen('material');
  const items = db.prepare('SELECT * FROM material_return_items WHERE return_id = ?').all(id);
  if (!items.length) throw new Error('退料单没有明细');

  // 校验：可退量以「已发 − 已退」为准（可能已被别的退料单吃掉）
  const issues = db.prepare('SELECT * FROM material_issue_items WHERE issue_id = ?').all(r.issue_id);
  items.forEach((it) => {
    const row = issues.find((x) => x.id === it.issue_item_id);
    if (!row) throw new Error(`明细 #${it.issue_item_id} 已不存在`);
    const can = r2(num(row.issued_qty) - num(row.returned_qty));
    if (num(it.qty) > can + EPS) {
      throw new Error(`「${it.name}${row.colorway ? ' · ' + row.colorway : ''}」可退只剩 ${can}，本单退了 ${it.qty}（可能另一张退料单已先入库）`);
    }
  });

  const ts = now();
  db.exec('BEGIN');
  try {
    items.forEach((it) => {
      if (!it.material_id) throw new Error(`「${it.name}」没有关联原料档案，无法入库（请先补档案）`);
      db.prepare('UPDATE material_issue_items SET returned_qty = COALESCE(returned_qty,0) + ? WHERE id = ?').run(it.qty, it.issue_item_id);
      const colorRow = issues.find((x) => x.id === it.issue_item_id) || {};
      applyStock({
        materialId: it.material_id, type: 'issue_return', qty: it.qty, unit: it.unit,
        refType: 'material_return', refId: id, refNo: r.return_no,
        remark: `${RETURN_TYPE[r.type] || r.type}${r.order_no ? ' · ' + r.order_no : ''}`
          + `${colorRow.colorway ? ' · ' + colorRow.colorway : ''}`
          + `：${r.reason}`,
        operator
      }, ts);
    });
    db.prepare("UPDATE material_returns SET status='confirmed', confirmed_by=?, confirmed_at=?, updated_at=? WHERE id=?")
      .run(operator, ts, ts, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return returnDetail(id);
}

// ---------- 盘点 ----------

/** 建盘点单：默认把「有库存或有往来的原料」全列上，账面数在此时快照 */
function createStocktake(b, operator) {
  const takeDate = b.take_date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(takeDate)) throw new Error('盘点日期格式应为 YYYY-MM-DD');
  const running = db.prepare("SELECT take_no FROM stocktakes WHERE status IN ('draft','counting','submitted') LIMIT 1").get();
  if (running) throw new Error(`已有未完成的盘点单 ${running.take_no}，先把它盘完或取消（避免两套账面数打架）`);

  const scope = 'material';
  const filterIds = Array.isArray(b.material_ids) && b.material_ids.length ? b.material_ids.map(int0) : null;
  const mats = db.prepare(
    `SELECT id, name, spec, unit, stock_qty, type FROM materials WHERE status = 'active'
     ${filterIds ? `AND id IN (${filterIds.map(() => '?').join(',')})` : ''}
     ORDER BY type, id`
  ).all(...(filterIds || []));
  if (!mats.length) throw new Error('没有可盘的原料（原料库为空或筛选后为空）');

  const ts = now();
  const no = nextNo('stocktakes', 'take_no', 'PD');
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO stocktakes (take_no, company_id, scope, warehouse, take_date, status, freeze, item_count, counter, note, created_by, created_at, updated_at, demo_tag)
       VALUES (?,1,?,?,?, 'draft', 1, ?,?,?,?,?,?,?)`
    ).run(no, scope, b.warehouse || 'cn', takeDate, mats.length, b.counter || operator, b.note || null, operator, ts, ts, b.demo_tag || null);
    const tid = info.lastInsertRowid;
    const stmt = db.prepare(
      `INSERT INTO stocktake_items (take_id, material_id, name, spec, unit, book_qty, count_qty, diff_qty, price, diff_amount)
       VALUES (?,?,?,?,?,?,NULL,0,?,NULL)`
    );
    mats.forEach((m) => stmt.run(tid, m.id, m.name, m.spec, m.unit, r2(num(m.stock_qty)), lastPrice(m.id)));
    db.exec('COMMIT');
    return stocktakeDetail(tid);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function stocktakeDetail(id) {
  const t = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
  if (!t) return null;
  const items = db.prepare('SELECT * FROM stocktake_items WHERE take_id = ? ORDER BY (count_qty IS NULL) DESC, material_id').all(id);
  const counted = items.filter((x) => x.count_qty !== null && x.count_qty !== undefined).length;
  return {
    ...t,
    status_label: TAKE_STATUS[t.status] || t.status,
    counted,
    uncounted: items.length - counted,
    items,
    gain_amount: r2(num(t.gain_amount)),
    loss_amount: r2(num(t.loss_amount))
  };
}

function listStocktakes(q) {
  const rows = db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM stocktake_items i WHERE i.take_id = t.id AND i.count_qty IS NULL) AS uncounted
     FROM stocktakes t ${q.status ? 'WHERE t.status = ?' : ''} ORDER BY t.id DESC LIMIT 100`
  ).all(...(q.status ? [q.status] : []));
  return rows.map((r) => ({
    ...r,
    status_label: TAKE_STATUS[r.status] || r.status,
    net_amount: r2(num(r.gain_amount) - num(r.loss_amount))
  }));
}

/** 开始盘点：转 counting（冻结生效） */
function startCount(id, operator) {
  const t = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
  if (!t) throw new Error('盘点单不存在');
  if (t.status !== 'draft') throw new Error('只有草稿能开始盘点');
  const ts = now();
  db.prepare("UPDATE stocktakes SET status='counting', updated_at=? WHERE id=?").run(ts, id);
  return stocktakeDetail(id);
}

/** 录实盘数：只改实盘与差异，不动库存 */
function saveCount(id, b) {
  const t = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
  if (!t) throw new Error('盘点单不存在');
  if (!['draft', 'counting'].includes(t.status)) throw new Error(`当前状态「${TAKE_STATUS[t.status]}」不能再录数`);
  const input = Array.isArray(b.items) ? b.items : [];
  if (!input.length) throw new Error('没有要保存的盘点行');

  const rows = db.prepare('SELECT * FROM stocktake_items WHERE take_id = ?').all(id);
  const plan = [];
  for (const x of input) {
    const row = rows.find((r) => r.id === int0(x.id));
    if (!row) throw new Error(`盘点行 #${x.id} 不属于本单`);
    const raw = x.count_qty;
    // 空 = 没盘（不是 0）
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      plan.push({ row, count: null });
      continue;
    }
    const c = r2(num(raw));
    if (c < -EPS) throw new Error(`「${row.name}」实盘数量不能为负`);
    plan.push({ row, count: c });
  }
  const ts = now();
  db.exec('BEGIN');
  try {
    plan.forEach((p) => {
      if (p.count === null) {
        db.prepare('UPDATE stocktake_items SET count_qty=NULL, diff_qty=0, diff_amount=NULL WHERE id=?').run(p.row.id);
      } else {
        const diff = r2(p.count - num(p.row.book_qty));
        const amount = p.row.price === null ? null : r2(diff * num(p.row.price));
        db.prepare('UPDATE stocktake_items SET count_qty=?, diff_qty=?, diff_amount=? WHERE id=?').run(p.count, diff, amount, p.row.id);
      }
    });
    refreshTakeSummary(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return stocktakeDetail(id);
}

function refreshTakeSummary(id) {
  const items = db.prepare('SELECT * FROM stocktake_items WHERE take_id = ?').all(id);
  const counted = items.filter((x) => x.count_qty !== null);
  const gain = counted.filter((x) => num(x.diff_qty) > EPS);
  const loss = counted.filter((x) => num(x.diff_qty) < -EPS);
  const sum = (arr, f) => r2(arr.reduce((s, x) => s + num(x[f]), 0));
  const uncosted = counted.filter((x) => Math.abs(num(x.diff_qty)) > EPS && (x.price === null || x.diff_amount === null)).length;
  db.prepare(
    `UPDATE stocktakes SET item_count=?, diff_count=?, gain_qty=?, loss_qty=?, gain_amount=?, loss_amount=?, uncosted_count=?, updated_at=? WHERE id=?`
  ).run(
    items.length, gain.length + loss.length,
    sum(gain, 'diff_qty'), r2(Math.abs(sum(loss, 'diff_qty'))),
    r2(gain.reduce((s, x) => s + num(x.diff_amount), 0)),
    r2(Math.abs(loss.reduce((s, x) => s + num(x.diff_amount), 0))),
    uncosted, now(), id
  );
}

/** 提交：有差异必须写原因；没盘的行不许蒙混过关 */
function submitStocktake(id, b, operator) {
  const t = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
  if (!t) throw new Error('盘点单不存在');
  if (!['draft', 'counting'].includes(t.status)) throw new Error('只有草稿/盘点中的单据能提交');
  // 允许在提交时一并带上原因
  if (b && Array.isArray(b.items) && b.items.length) {
    const rows = db.prepare('SELECT * FROM stocktake_items WHERE take_id = ?').all(id);
    const ts0 = now();
    db.exec('BEGIN');
    try {
      b.items.forEach((x) => {
        const row = rows.find((r) => r.id === int0(x.id));
        if (!row) return;
        if (x.reason !== undefined) {
          db.prepare('UPDATE stocktake_items SET reason=? WHERE id=?').run(String(x.reason || '').trim() || null, row.id);
        }
        if (x.count_qty !== undefined && x.count_qty !== null && String(x.count_qty).trim() !== '') {
          const c = r2(num(x.count_qty));
          const amount = row.price === null ? null : r2((c - num(row.book_qty)) * num(row.price));
          db.prepare('UPDATE stocktake_items SET count_qty=?, diff_qty=?, diff_amount=? WHERE id=?').run(c, r2(c - num(row.book_qty)), amount, row.id);
        }
      });
      refreshTakeSummary(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const items = db.prepare('SELECT * FROM stocktake_items WHERE take_id = ?').all(id);
  const uncounted = items.filter((x) => x.count_qty === null);
  if (uncounted.length) {
    throw new Error(`还有 ${uncounted.length} 样没盘（${uncounted.slice(0, 3).map((x) => x.name).join('、')}${uncounted.length > 3 ? ' 等' : ''}）：要么填实盘数，要么明确填账面数表示已盘、账实相符`);
  }
  const noReason = items.filter((x) => Math.abs(num(x.diff_qty)) > EPS && String(x.reason || '').trim().length < 4);
  if (noReason.length) {
    throw new Error(`有 ${noReason.length} 条差异没写原因（${noReason.slice(0, 3).map((x) => x.name).join('、')}${noReason.length > 3 ? ' 等' : ''}）：盘盈盘亏都要写清原因`)
  }
  const ts = now();
  db.prepare("UPDATE stocktakes SET status='submitted', submitted_by=?, submitted_at=?, updated_at=? WHERE id=?")
    .run(operator, ts, ts, id);
  return stocktakeDetail(id);
}

/** 调账：写盘盈/盘亏流水并改余额（一次落账，不可重复） */
function adjustStocktake(id, operator) {
  const t = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
  if (!t) throw new Error('盘点单不存在');
  if (t.status !== 'submitted') throw new Error('只有「待调账」的盘点单能落账');
  const items = db.prepare('SELECT * FROM stocktake_items WHERE take_id = ?').all(id);
  const diffs = items.filter((x) => Math.abs(num(x.diff_qty)) > EPS && !x.adjusted);
  if (!diffs.length) {
    // 账实完全相符：直接完结，不写流水
    const ts0 = now();
    db.prepare("UPDATE stocktakes SET status='adjusted', adjusted_by=?, adjusted_at=?, updated_at=? WHERE id=?")
      .run(operator, ts0, ts0, id);
    return stocktakeDetail(id);
  }

  const ts = now();
  db.exec('BEGIN');
  try {
    diffs.forEach((x) => {
      const qty = r2(num(x.diff_qty));
      applyStock({
        materialId: x.material_id, type: qty > 0 ? 'stock_gain' : 'stock_loss', qty,
        unit: x.unit, refType: 'stocktake', refId: id, refNo: t.take_no,
        remark: `${qty > 0 ? '盘盈' : '盘亏'} ${Math.abs(qty)}${x.unit || ''}（账面 ${x.book_qty}，实盘 ${x.count_qty}）：${x.reason || ''}`,
        operator
      }, ts);
      db.prepare('UPDATE stocktake_items SET adjusted = 1 WHERE id = ?').run(x.id);
    });
    db.prepare("UPDATE stocktakes SET status='adjusted', adjusted_by=?, adjusted_at=?, updated_at=? WHERE id=?")
      .run(operator, ts, ts, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return stocktakeDetail(id);
}

function cancelStocktake(id, reason, operator) {
  const t = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
  if (!t) throw new Error('盘点单不存在');
  if (t.status === 'adjusted') throw new Error('已调账的盘点单不能取消（差异已经落到库存上了）');
  if (String(reason || '').trim().length < 4) throw new Error('取消盘点必须写原因（≥4 字）');
  const ts = now();
  db.prepare("UPDATE stocktakes SET status='cancelled', note=COALESCE(note,'')||?, updated_at=? WHERE id=?")
    .run(` [取消] ${reason}`, ts, id);
  return stocktakeDetail(id);
}

// ---------- 总览 / 流水 ----------

function board(q) {
  const from = q.from || monthStart();
  const to = q.to || today();
  const issues = db.prepare(
    `SELECT status, COUNT(*) c, COALESCE(SUM(req_qty),0) req, COALESCE(SUM(issued_qty),0) issued, COALESCE(SUM(amount),0) amount
     FROM material_issues WHERE date(created_at) BETWEEN ? AND ? GROUP BY status`
  ).all(from, to);
  const stat = { draft: 0, prepared: 0, issued: 0, partial: 0, closed: 0, cancelled: 0 };
  let amount = 0; let issuedQty = 0;
  issues.forEach((x) => { stat[x.status] = x.c; amount = r2(amount + num(x.amount)); issuedQty = r2(issuedQty + num(x.issued)); });

  const openShort = db.prepare(
    `SELECT d.id, d.issue_no, d.order_no, d.status, d.req_qty, d.issued_qty, (d.req_qty - d.issued_qty) open_qty, d.req_date
     FROM material_issues d WHERE d.status IN ('prepared','partial') AND (d.req_qty - d.issued_qty) > 0.005
     ORDER BY d.req_date, d.id LIMIT 60`
  ).all().map((r) => ({ ...r, open_qty: r2(num(r.open_qty)), overdue: r.req_date && r.req_date < today() }));

  const runningTake = db.prepare(
    `SELECT id, take_no, take_date, status FROM stocktakes WHERE status IN ('draft','counting','submitted') ORDER BY id DESC LIMIT 1`
  ).get();

  const ledgerStat = db.prepare(
    `SELECT type, COUNT(*) c, COALESCE(SUM(qty),0) q FROM material_ledger WHERE date(created_at) BETWEEN ? AND ? GROUP BY type`
  ).all(from, to).map((x) => ({ ...x, q: r2(num(x.q)), label: LEDGER_TYPE[x.type] || x.type }));

  const lastTake = db.prepare(
    `SELECT take_no, take_date, diff_count, gain_amount, loss_amount, uncosted_count, status FROM stocktakes
     WHERE status = 'adjusted' ORDER BY take_date DESC, id DESC LIMIT 1`
  ).get();

  const lowStock = db.prepare(
    `SELECT m.id, m.name, m.unit, COALESCE(m.stock_qty,0) stock_qty,
            (SELECT COALESCE(SUM(i.req_qty - i.issued_qty),0) FROM material_issue_items i JOIN material_issues d ON d.id=i.issue_id
              WHERE i.material_id=m.id AND d.status='prepared') reserved
     FROM materials m WHERE m.status='active' AND COALESCE(m.stock_qty,0) <= 0 ORDER BY m.id LIMIT 20`
  ).all().map((r) => ({ ...r, stock_qty: r2(num(r.stock_qty)), reserved: r2(num(r.reserved)) }));

  return {
    from, to,
    stat: { ...stat, amount, issued_qty: issuedQty },
    open_short: openShort,
    open_short_count: openShort.length,
    running_take: runningTake || null,
    ledger_stat: ledgerStat,
    last_take: lastTake || null,
    zero_stock: lowStock
  };
}

const LEDGER_TYPE = {
  receipt: '收货入库', issue: '领料发出', issue_return: '退料入库',
  po_return: '退回供应商', stock_gain: '盘盈', stock_loss: '盘亏', scrap: '报废'
};

function ledger(q) {
  const where = [];
  const args = [];
  if (q.material_id) { where.push('l.material_id = ?'); args.push(int0(q.material_id)); }
  if (q.type) { where.push('l.type = ?'); args.push(q.type); }
  if (q.from) { where.push('date(l.created_at) >= ?'); args.push(q.from); }
  if (q.to) { where.push('date(l.created_at) <= ?'); args.push(q.to); }
  const rows = db.prepare(
    `SELECT l.*, m.unit AS unit_now FROM material_ledger l LEFT JOIN materials m ON m.id = l.material_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ?`
  ).all(...args, Math.min(500, Number(q.limit) || 200));
  return rows.map((r) => ({
    ...r, qty: r2(num(r.qty)), type_label: LEDGER_TYPE[r.type] || r.type,
    direction: num(r.qty) > 0 ? 'in' : 'out'
  }));
}

/** 原料台账：余额 + 占用 + 可用 + 期间收发 */
function stockList(q) {
  const from = q.from || monthStart();
  const to = q.to || today();
  const rows = db.prepare(
    `SELECT m.id, m.code, m.type, m.name, m.spec, m.unit, COALESCE(m.stock_qty,0) stock_qty,
            (SELECT COALESCE(SUM(i.req_qty - i.issued_qty),0) FROM material_issue_items i JOIN material_issues d ON d.id=i.issue_id
              WHERE i.material_id=m.id AND d.status='prepared') reserved
     FROM materials m WHERE m.status='active' ${q.type ? 'AND m.type = ?' : ''} ORDER BY m.type, m.id`
  ).all(...(q.type ? [q.type] : []));
  const flow = db.prepare(
    `SELECT material_id,
            COALESCE(SUM(CASE WHEN type IN ('receipt','issue_return','stock_gain') THEN qty END),0) in_qty,
            COALESCE(SUM(CASE WHEN type IN ('issue','po_return','stock_loss','scrap') THEN -qty END),0) out_qty
     FROM material_ledger WHERE date(created_at) BETWEEN ? AND ? GROUP BY material_id`
  ).all(from, to);
  const fmap = new Map(flow.map((x) => [x.material_id, x]));
  return rows.map((r) => {
    const stock = r2(num(r.stock_qty));
    const reserved = r2(num(r.reserved));
    const f = fmap.get(r.id) || { in_qty: 0, out_qty: 0 };
    return {
      id: r.id, code: r.code, type: r.type, type_label: r.type === 'fabric' ? '面料' : '辅料',
      name: r.name, spec: r.spec, unit: r.unit,
      stock_qty: stock, reserved, available: r2(stock - reserved),
      in_qty: r2(num(f.in_qty)), out_qty: r2(num(f.out_qty)),
      price: lastPrice(r.id),
      neg: stock < -EPS
    };
  });
}

function dict() {
  return {
    issue_status: ISSUE_STATUS, issue_kind: ISSUE_KIND, return_type: RETURN_TYPE,
    take_status: TAKE_STATUS, ledger_type: LEDGER_TYPE,
    today: today(), month_start: monthStart()
  };
}

module.exports = {
  EPS, r2, num, today,
  applyStock, lastPrice, reservedOf, availableOf, assertNotFrozen,
  suggestFromOrder, listIssues, issueDetail, createIssue, prepareIssue, issueOut, closeIssue, cancelIssue,
  listReturns, createReturn, returnDetail, confirmReturn,
  listStocktakes, stocktakeDetail, createStocktake, startCount, saveCount, submitStocktake, adjustStocktake, cancelStocktake,
  board, ledger, stockList, dict
};
