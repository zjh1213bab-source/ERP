/**
 * 样衣管理「开发款视图」只读聚合（截图一比一改造的数据底座）
 * ------------------------------------------------------------
 * 数据源：tech_packs + pattern_flows + orders / pre_orders / customers
 *         + order_items + sample_archives
 * 权限：逐条复用 patternManagement.owns()，与打版看板 /board 完全一致，
 *       不绕过主体隔离。无权限的行直接丢弃，不返回占位数据。
 * 约束：只读。不写库、不改状态、不造数字。参考系统里本地不存在的环节
 *       （面辅料供应商选择、技术部审核）计数如实为 0 并带 hint 说明。
 * 实时链路：本文件改动由 deploy/lan-live.js 监听，会自动重启 3200 后端。
 *
 * 参考系统 11 个流程节点与本地环节的对应关系：
 *   可打版            → tech_packs.stage='draft'（刚立项、流程尚未推进）
 *   制版完善面辅料部位 → current_stage='material' 面辅料确认
 *   面辅料供应商选择   → 本地无独立环节（0）
 *   制版              → current_stage='pattern'
 *   工艺/工序明细      → current_stage='craft'
 *   车板做样衣        → current_stage='sample'
 *   业务确认样        → current_stage='biz'
 *   工序审核/工价核算  → current_stage='audit'
 *   技术部审核        → 本地无独立环节（0，审核合并在 audit 阶段）
 *   打版完成          → flow.status='done' 或已有归档样衣
 *   已淘汰            → flow.status='cancelled'
 */
const { db } = require('../db');

const STAGE_LABEL = {
  material: '面辅料确认',
  pattern: '制版',
  craft: '工艺明细',
  sample: '车板做样衣',
  biz: '业务确认样',
  audit: '工序审核·工价核价'
};

const FLOW_NODES = [
  { key: 'ready', label: '可打版', local: true },
  { key: 'material', label: '制版完善面辅料部位', local: true },
  { key: 'supplier', label: '面辅料供应商选择', local: false, hint: '本系统暂无独立环节，面辅料供应商信息在面辅料档案维护' },
  { key: 'pattern', label: '制版', local: true },
  { key: 'craft', label: '工艺/工序明细', local: true },
  { key: 'sample', label: '车板做样衣', local: true },
  { key: 'biz', label: '业务确认样', local: true },
  { key: 'audit', label: '工序审核/工价核算', local: true },
  { key: 'tech_review', label: '技术部审核', local: false, hint: '本系统暂无独立环节，技术审核合并在工序审核·工价核价阶段' },
  { key: 'done', label: '打版完成', local: true },
  { key: 'cancelled', label: '已淘汰', local: true }
];

/** 每行只归属一个节点，保证各胶囊计数之和 = 总数，不会出现重复或凭空数字。 */
function nodeKeyOf(r) {
  if (r.flow_status === 'cancelled') return 'cancelled';
  if (r.flow_status === 'done' || r.archive_id) return 'done';
  if (r.tp_stage === 'draft') return 'ready';
  return STAGE_LABEL[r.current_stage] ? r.current_stage : 'ready';
}

const SQL = `
  SELECT pf.id AS flow_id, pf.tech_pack_id, pf.order_id, pf.current_stage,
         pf.status AS flow_status, pf.started_at, pf.finished_at,
         tp.pattern_no, tp.product_name, tp.customer_style_no, tp.designer,
         tp.pattern_maker, tp.category, tp.label_name, tp.series, tp.wave,
         tp.sales_owner, tp.po_no, tp.brand, tp.colors, tp.size_range,
         tp.size_spec, tp.image_url, tp.stage AS tp_stage, tp.status AS tp_status,
         tp.created_at, tp.created_by, tp.pre_order_id,
         o.order_no, o.style_name AS order_style_name, o.type AS order_type,
         o.customer_name_snapshot,
         p.pre_order_no, p.style_name AS pre_style_name, p.customer_name AS pre_customer_name,
         c.name AS customer_name,
         (SELECT oi.style_no FROM order_items oi WHERE oi.order_id = tp.order_id AND TRIM(COALESCE(oi.style_no,'')) != '' ORDER BY oi.id LIMIT 1) AS item_style_no,
         (SELECT GROUP_CONCAT(DISTINCT tm.colorway) FROM tech_pack_materials tm WHERE tm.tech_pack_id = tp.id AND TRIM(COALESCE(tm.colorway,'')) != '') AS colorways,
         (SELECT GROUP_CONCAT(DISTINCT ts.size) FROM tech_pack_sizes ts WHERE ts.tech_pack_id = tp.id AND TRIM(COALESCE(ts.size,'')) != '') AS size_list,
         (SELECT u.username FROM users u WHERE u.id = tp.created_by) AS created_by_name,
         sa.id AS archive_id, sa.status AS archive_status, sa.archive_no,
         sa.style_no AS archive_style_no, sa.snapshot AS archive_snapshot
  FROM pattern_flows pf
  JOIN tech_packs tp ON tp.id = pf.tech_pack_id
  LEFT JOIN orders o ON o.id = pf.order_id
  LEFT JOIN pre_orders p ON p.id = tp.pre_order_id
  LEFT JOIN customers c ON c.id = o.customer_id
  LEFT JOIN sample_archives sa ON sa.id = (
    SELECT MAX(s2.id) FROM sample_archives s2 WHERE s2.tech_pack_id = tp.id AND s2.status != 'revised'
  )
  ORDER BY pf.id DESC
`;

function text(v) { return v == null ? '' : String(v).trim(); }
function has(v, kw) { return text(v).toLowerCase().includes(kw); }

function decorate(r) {
  const node = nodeKeyOf(r);
  // 归档快照是真实数据，可补齐 tech_packs 上尚未维护的颜色/尺码/人员字段
  let snap = {};
  try { snap = JSON.parse(r.archive_snapshot || '{}'); } catch (e) { snap = {}; }
  const customer = text(r.customer_name || r.customer_name_snapshot || r.pre_customer_name);
  const styleName = text(r.product_name || snap.product_name || r.order_style_name || r.pre_style_name);
  // 款号按真实来源依次兜底：版号 → 订单明细款号 → 归档款号 → 客户款号 → 样衣/订单编号
  const styleNo = text(
    r.pattern_no || r.item_style_no || r.archive_style_no || r.customer_style_no ||
    r.archive_no || r.order_no || r.pre_order_no
  );
  let badge = '可打版';
  if (r.flow_status === 'cancelled') badge = '已淘汰';
  else if (r.flow_status === 'done' || r.archive_id) badge = r.archive_status === 'changing' ? '变更审核中' : '打版完成';
  else badge = STAGE_LABEL[r.current_stage] || '可打版';

  return {
    id: `flow-${r.flow_id}`,
    kind: r.archive_id ? 'archived' : 'flow',
    flow_id: r.flow_id,
    tech_pack_id: r.tech_pack_id,
    archive_id: r.archive_id || null,
    archive_no: text(r.archive_no),
    archive_status: text(r.archive_status),
    // 卡片字段：本地没有 SKC / 车版师 / 打版工厂，不伪造，留空并在 unsupported 里说明
    style_no: styleNo,
    style_name: styleName,
    skc: text(r.pattern_no),
    colors: text(r.colors || r.colorways || snap.colors),
    size_range: text(r.size_range || r.size_spec || r.size_list || snap.size_range),
    customer,
    created_at: r.created_at || r.started_at || '',
    created_by: text(r.created_by_name || r.created_by),
    image_url: text(r.image_url),
    // 筛选字段
    designer: text(r.designer || snap.designer),
    pattern_maker: text(r.pattern_maker || snap.pattern_maker),
    car_pattern_maker: '',
    factory: '',
    sales_owner: text(r.sales_owner),
    series: text(r.series),
    category: text(r.category),
    brand: text(r.brand),
    label_name: text(r.label_name),
    customer_style_no: text(r.customer_style_no),
    type: text(r.order_type),
    order_no: text(r.order_no || r.pre_order_no),
    has_order: !!r.order_no,
    // 环节
    node,
    stage: text(r.current_stage),
    stage_label: STAGE_LABEL[r.current_stage] || '可打版',
    flow_status: text(r.flow_status),
    badge
  };
}

/** 去重后的下拉可选值，全部来自真实数据，不造枚举。 */
function buildOptions(rows) {
  const keys = ['designer', 'pattern_maker', 'sales_owner', 'series', 'category', 'brand', 'label_name', 'customer', 'customer_style_no', 'created_by', 'type'];
  const out = {};
  keys.forEach((k) => {
    out[k] = [...new Set(rows.map((r) => text(r[k])).filter(Boolean))].sort();
  });
  return out;
}

function matches(row, q) {
  const kw = text(q.q).toLowerCase();
  if (kw && ![row.style_no, row.style_name, row.skc, row.customer, row.customer_style_no, row.order_no]
    .some((v) => has(v, kw))) return false;

  // 精确匹配类：值来自下拉框（真实可选值），空串表示不过滤
  const eq = {
    designer: 'designer', pattern_maker: 'pattern_maker', car_pattern_maker: 'car_pattern_maker',
    sales_owner: 'sales_owner', series: 'series', category: 'category', brand: 'brand',
    label_name: 'label_name', customer_style_no: 'customer_style_no', type: 'type',
    created_by: 'created_by', factory: 'factory', skc: 'skc'
  };
  for (const [param, field] of Object.entries(eq)) {
    const want = text(q[param]);
    if (!want) continue;
    if (text(row[field]) !== want) return false;
  }

  // 模糊匹配类（输入框）
  const like = { customer: 'customer', style_name: 'style_name', car_maker: 'car_pattern_maker' };
  for (const [param, field] of Object.entries(like)) {
    const want = text(q[param]).toLowerCase();
    if (want && !has(row[field], want)) return false;
  }

  if (q.created_from && row.created_at.slice(0, 10) < text(q.created_from)) return false;
  if (q.created_to && row.created_at.slice(0, 10) > text(q.created_to)) return false;
  if (q.node && row.node !== text(q.node)) return false;
  if (q.status === 'ordered' && !row.has_order) return false;
  if (q.status === 'done' && row.node !== 'done') return false;
  return true;
}

/**
 * @param {object} user  经 authRequired 注入的当前用户
 * @param {object} q     查询参数
 * @returns 列表 + 真实流程计数 + 下拉可选值；全量返回，分页由前端本地完成
 */
function read(user, q) {
  const mg = require('./patternManagement');
  const raw = db.prepare(SQL).all();
  // 与 /api/pattern-flows/board 相同的主体/角色过滤
  const allowed = raw.filter((r) => {
    try { mg.owns(user, r.flow_id); return true; } catch (e) { return false; }
  });
  const all = allowed.map(decorate);

  const countMap = Object.fromEntries(FLOW_NODES.map((n) => [n.key, 0]));
  all.forEach((r) => { if (countMap[r.node] !== undefined) countMap[r.node] += 1; });

  return {
    total: all.length,
    rows: all.filter((r) => matches(r, q || {})),
    nodes: FLOW_NODES.map((n) => ({ ...n, count: countMap[n.key] || 0 })),
    statusCounts: {
      all: all.length,
      ordered: all.filter((r) => r.has_order).length,
      done: all.filter((r) => r.node === 'done').length
    },
    options: buildOptions(all),
    // 参考系统有、本地没有的筛选项：如实告知前端显示为「暂无数据」，不假装有值
    unsupported: [
      { field: 'factory', label: '打版工厂', reason: '本地 tech_packs 未存打版工厂字段' },
      { field: 'car_pattern_maker', label: '车版师', reason: '本地未存车版师，纸样师字段为 pattern_maker' },
      { field: 'skc', label: 'SKC', reason: '本地无 SKC 字段，检索已映射到版号 pattern_no' }
    ],
    stageLabels: STAGE_LABEL
  };
}

module.exports = { read, FLOW_NODES, STAGE_LABEL };
