/**
 * 工序节点弹窗（点开一个格子看到什么）
 *
 * ## 为什么不同节点弹的东西不一样
 *
 * 看板上十几个格子长得一样，但点开要处理的事完全不同：
 *
 *   面料采购 / 辅料采购 → 有一张物料需求表可以摊开：需求多少、单价多少、
 *                        库存够不够、缺口多少、哪个供应商
 *   排版算料 / 车缝 / 尾部 → 没有自己的明细表，要的是「谁在做、什么时候做完、
 *                        留了什么说明、拍了什么照片」
 *
 * 所以面板类型（`panel`）是**节点的属性**，不是按 code 写死的分支。
 * 真实数据里「面料采购」往往是业务自己加的自定义节点（code 是 `c_new_2`
 * 这种自动编号），按 code 判断必然落空。
 *
 * ## 操作记录是拼出来的，不是编出来的
 *
 * 时间线里每一条都有出处：
 *   order_node_logs      人工改状态 / 计划 / 责任人 / 备注（setNode 写）
 *   attachments(node_id) 现场照片（车间扫码拍的凭证）
 *   production_reports   报工记录（合格数 / 不良数）
 *
 * 不生成「系统于 xx 更新」这种无来源的记录 —— 那种记录除了让时间线看起来热闹，
 * 查不了任何事。
 */
const { db } = require('../db');
const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};

const STATUS_LABEL = { pending: '待开始', doing: '进行中', done: '已完成', skipped: '不适用' };

const PANEL_LABEL = {
  generic: '节点信息',
  purchase_fabric: '面料采购明细',
  purchase_accessory: '辅料采购明细',
  purchase_all: '面辅料采购明细'
};

/** 只允许这几种：面板类型是配置项，不能由前端传什么就渲染什么 */
const PANELS = Object.keys(PANEL_LABEL);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * 采购明细行
 *
 * 金额用 `需求数量 × 单价` 现算，不取 `gap_amount`（那是**缺口**金额，
 * 齐套时恒为 0，当总额显示会得到一排 0，比不显示更误导）。
 */
function purchaseRows(orderId, kind) {
  const types = kind === 'purchase_fabric' ? ['fabric']
    : kind === 'purchase_accessory' ? ['accessory']
      : ['fabric', 'accessory'];
  const ph = types.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM material_requirements WHERE order_id = ? AND mat_type IN (${ph}) ORDER BY mat_type, id`
  ).all(orderId, ...types);

  const matStmt = db.prepare('SELECT supplier, supplier_info, stock_qty, image_url FROM materials WHERE id = ?');
  const lines = rows.map((r) => {
    const m = r.material_id ? matStmt.get(r.material_id) : null;
    const qty = Number(r.need_qty) || 0;
    const price = Number(r.unit_price) || 0;
    return {
      id: r.id,
      material_id: r.material_id,
      mat_type: r.mat_type,
      type_label: r.mat_type === 'fabric' ? '面料' : '辅料',
      colorway: r.colorway || '',
      material_name: r.material_name || '',
      color_no: r.color_no || '',
      spec_info: r.spec_info || '',
      unit: r.unit || '',
      need_qty: qty,
      unit_price: price,
      amount: round2(qty * price),
      /** 真实库存（materials.stock_qty）—— 参考表里那列「库存」说的是这个 */
      stock_qty: m ? Number(m.stock_qty) || 0 : null,
      /** 本单已分配占用的库存 */
      alloc_qty: Number(r.alloc_stock) || 0,
      gap_qty: Number(r.gap_qty) || 0,
      gap_amount: Number(r.gap_amount) || 0,
      supplier: (m && (m.supplier || m.supplier_info)) || '',
      note: r.note || '',
      status: r.status || '',
      status_label: r.gap_qty > 0 ? '缺料' : '齐套',
      impact_node: r.impact_node || ''
    };
  });

  const totalAmount = round2(lines.reduce((a, x) => a + x.amount, 0));
  const gapLines = lines.filter((x) => x.gap_qty > 0);

  return {
    lines,
    summary: {
      line_count: lines.length,
      total_amount: totalAmount,
      gap_lines: gapLines.length,
      gap_amount: round2(gapLines.reduce((a, x) => a + x.gap_amount, 0)),
      calc_at: rows.length ? rows[0].calc_at : null,
      /** 没有需求行时前端要说清「先去齐套算料」，而不是显示一张空表 */
      empty_hint: rows.length ? '' : '这张单还没有物料需求，先在「齐套与缺料」里算一次料'
    }
  };
}

/** 关联单据：让非采购节点也有「简单显示」，不至于弹出一个空壳 */
function traces(orderId) {
  const out = [];
  const push = (label, rows, noKey, extra) => {
    if (!rows || !rows.length) return;
    out.push({
      label,
      items: rows.slice(0, 20).map((r) => ({ no: r[noKey], status: r.status, extra: extra ? extra(r) : '' }))
    });
  };
  try {
    push('采购单', db.prepare('SELECT po_no, status, expect_date FROM purchase_orders WHERE order_id = ? ORDER BY id DESC').all(orderId),
      'po_no', (r) => (r.expect_date ? `预计 ${r.expect_date}` : ''));
  } catch (e) { /* 老库没有该表就跳过 */ }
  try {
    push('裁床单', db.prepare('SELECT cut_no, status FROM cut_orders WHERE order_id = ? ORDER BY id DESC').all(orderId), 'cut_no');
  } catch (e) { /* ignore */ }
  try {
    push('领料单', db.prepare('SELECT issue_no, status FROM material_issues WHERE order_id = ? ORDER BY id DESC').all(orderId), 'issue_no');
  } catch (e) { /* ignore */ }
  try {
    push('退料单', db.prepare('SELECT return_no, status FROM material_returns WHERE order_id = ? ORDER BY id DESC').all(orderId), 'return_no');
  } catch (e) { /* ignore */ }
  return out;
}

/**
 * 时间线：节点变更 + 现场照片 + 报工，按时间倒序
 *
 * 三条来源合成一条线，因为现场问的是「这一步发生过什么」，
 * 而不是「节点表里改过什么」——分开列会让人自己拼时间顺序。
 */
function timeline(node) {
  const logs = db.prepare(
    'SELECT action, detail, operator, created_at FROM order_node_logs WHERE node_id = ? ORDER BY id DESC LIMIT 60'
  ).all(node.id).map((r) => ({
    kind: 'log', action: r.action, detail: r.detail || '', operator: r.operator || '', at: r.created_at
  }));

  const photos = db.prepare(
    `SELECT id, filename, url, note, uploader, created_at FROM attachments
      WHERE node_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 40`
  ).all(node.id).map((r) => ({
    kind: 'photo', action: 'photo', detail: r.note || r.filename || '上传凭证',
    operator: r.uploader || '', at: r.created_at, url: r.url, id: r.id
  }));

  const reports = db.prepare(
    `SELECT qty_ok, qty_defect, operator, created_at, report_date FROM production_reports
      WHERE node_id = ? ORDER BY id DESC LIMIT 40`
  ).all(node.id).map((r) => ({
    kind: 'report', action: 'report',
    detail: `报工 合格 ${Number(r.qty_ok) || 0} 件${Number(r.qty_defect) ? ` / 不良 ${Number(r.qty_defect)} 件` : ''}`,
    operator: r.operator || '', at: r.created_at
  }));

  return logs.concat(photos, reports)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 80);
}

/**
 * 取一个节点的弹窗内容
 *
 * `kind` 决定前端画哪块：
 *   purchase_* → 采购明细表（+ 汇总）
 *   generic    → 备注 / 凭证 / 时间线
 * 两种情况都带「状态、计划、责任人」的编辑区与时间线，因为那是每个节点都要的。
 */
function panel(nodeId) {
  const node = db.prepare('SELECT * FROM order_nodes WHERE id = ?').get(Number(nodeId));
  if (!node) throw bad('工序不存在', 404);

  const order = db.prepare(
    'SELECT id, order_no, style_name, cus_order_no, status, type, order_date, delivery_date, customer_id FROM orders WHERE id = ?'
  ).get(node.order_id);
  const cus = order && order.customer_id
    ? db.prepare('SELECT name FROM customers WHERE id = ?').get(order.customer_id)
    : null;

  const item = db.prepare(
    'SELECT id, code, name, panel, required, visible, role, note FROM node_template_items WHERE template_id = ? AND code = ?'
  ).get(node.template_id, node.code);

  const kind = (item && PANELS.includes(String(item.panel))) ? String(item.panel) : 'generic';

  const photos = db.prepare(
    `SELECT id, filename, url, note, uploader, created_at FROM attachments
      WHERE node_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 40`
  ).all(node.id);

  const payload = {
    node: {
      ...node,
      status_label: STATUS_LABEL[node.status] || node.status
    },
    order: order
      ? { ...order, customer_name: cus ? cus.name : null }
      : null,
    kind,
    panel_label: PANEL_LABEL[kind] || PANEL_LABEL.generic,
    /** 模板里这个节点的配置（必经与否、是否仅扫码），前端据此决定「能不能标不适用」 */
    item: item || null,
    purchase: kind === 'generic' ? null : purchaseRows(node.order_id, kind),
    traces: traces(node.order_id),
    photos: photos.map((p) => ({ id: p.id, url: p.url, note: p.note || '', uploader: p.uploader || '', at: p.created_at })),
    timeline: timeline(node)
  };

  return payload;
}

module.exports = { panel, PANELS, PANEL_LABEL, STATUS_LABEL, purchaseRows, timeline };
