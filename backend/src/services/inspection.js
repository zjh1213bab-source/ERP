/**
 * 验货报告
 * ============================================================
 * 为什么要有这个模块：
 *   照片拍了一堆、验货单开了一张，但真正要发给客户时，没人会去系统里一张张截图。
 *   外贸客户（或第三方验货行）要的是一份能签字的文件：订单信息 + 抽检结果 + 不良照片 + 结论。
 *
 * 三个设计决定：
 *
 * 1. **报告是快照，不是实时视图**
 *    生成那一刻把数据序列化进 snapshot。之后内部又报了工、又补了照片，
 *    客户手里那份不会跟着变 —— 否则一出纠纷就说不清「你给我的和系统里的不一样」。
 *
 * 2. **结论只能来自验货单，没有就写「未验货」**
 *    绝不根据「照片看起来还行」推断合格。报告一旦替公司下结论，就要担责任。
 *
 * 3. **照片存引用 + 元信息，不复制文件**
 *    因为照片是软删除（`deleted_at`）且文件不删，快照里的 URL 长期有效 ——
 *    这是上一轮那个决定的兑现。若当初做的是物理删除，这份报告过几个月就是一堆红叉。
 */
const { db, now } = require('../db');
const { genNo } = require('../utils/http');
const { stripDemo } = require('../utils/demo');

/** 报告编号：JH+日期+4 位序号，取「已有最大号 +1」，不用 COUNT(*)+1（删过行就会撞号） */
function nextReportNo() {
  const prefix = genNo('JH', 1).slice(0, 10); // JH + yyyymmdd
  const row = db
    .prepare("SELECT report_no FROM inspection_reports WHERE report_no LIKE ? ORDER BY report_no DESC LIMIT 1")
    .get(prefix + '%');
  let seq = 1;
  if (row) {
    const n = parseInt(String(row.report_no).slice(prefix.length), 10);
    if (!isNaN(n)) seq = n + 1;
  }
  return prefix + String(seq).padStart(4, '0');
}

const STATUS_LABEL = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};
const CAT_LABEL = { defect: '不良', incoming: '到货', packing: '装箱', sample: '样品', other: '其他' };
const CAT_ORDER = ['defect', 'incoming', 'packing', 'sample', 'other'];
const QC_RESULT_LABEL = { pass: '合格', fail: '不合格', conditional: '让步接收' };

/**
 * 组装快照
 * @param {number} orderId
 */
function buildSnapshot(orderId) {
  const id = Number(orderId);
  const order = db
    .prepare(
      `SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.contact AS customer_contact, c.phone AS customer_phone
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.id = ?`
    )
    .get(id);
  if (!order) {
    const e = new Error('订单不存在');
    e.status = 404;
    throw e;
  }

  // ---- 款 / 颜色 / 尺码明细 ----
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  const sizes = db.prepare(
    `SELECT s.* FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id
      WHERE i.order_id = ? ORDER BY s.id`
  ).all(id);

  const itemLines = items.map((it) => {
    const own = sizes.filter((s) => Number(s.item_id) === Number(it.id));
    // 有尺码行就按尺码汇总，没有就退到单头数量（老数据没有尺码行）
    const qty = own.length ? own.reduce((a, s) => a + (Number(s.qty) || 0), 0) : Number(it.qty) || 0;
    return {
      product_name: it.product_name,
      style_no: it.style_no,
      sku: it.sku,
      color: it.color,
      qty,
      sizes: own.map((s) => ({ color: s.color, size: s.size, qty: Number(s.qty) || 0 }))
    };
  });
  const totalQty = itemLines.reduce((a, l) => a + l.qty, 0) || Number(order.total_qty) || 0;

  // 尺码矩阵（验货时按码点数量，这是最常用的视图）
  const sizeSet = [];
  const sizeMap = {};
  itemLines.forEach((l) => {
    l.sizes.forEach((s) => {
      const size = s.size || '—';
      if (!sizeSet.includes(size)) { sizeSet.push(size); sizeMap[size] = 0; }
      sizeMap[size] += s.qty;
    });
  });

  // ---- 验货单（可能有中期 / 尾期多张）----
  const inspections = db
    .prepare(
      `SELECT * FROM qc_inspections WHERE order_id = ?
        ORDER BY IFNULL(inspect_date, '') DESC, id DESC`
    )
    .all(id);
  const inspDetail = inspections.map((ins) => ({
    ...ins,
    items: db
      .prepare('SELECT * FROM qc_inspection_items WHERE inspection_id = ? ORDER BY IFNULL(seq, 0), id')
      .all(ins.id)
  }));

  // 结论：只认「已完成」的验货单，取最新一张
  const done = inspDetail.filter((x) => x.status === 'done' && x.aql_result);
  const latest = done[0] || null;
  const qcResult = latest ? latest.aql_result : 'none';

  // ---- 质量异常 ----
  const issues = db
    .prepare('SELECT * FROM qc_issues WHERE order_id = ? ORDER BY id DESC')
    .all(id);
  const issuesOpen = issues.filter((x) => x.status !== 'closed');

  // ---- 首件确认 ----
  const fa = db
    .prepare('SELECT * FROM first_articles WHERE order_id = ? ORDER BY id DESC LIMIT 1')
    .get(id) || null;

  // ---- 报工统计（不良率的口径：不良 / (合格 + 不良)）----
  const rep = db
    .prepare(
      `SELECT COALESCE(SUM(qty_ok),0) ok, COALESCE(SUM(qty_defect),0) defect, COALESCE(SUM(hours),0) hours
         FROM production_reports WHERE order_id = ?`
    )
    .get(id);
  const okQty = Number(rep.ok) || 0;
  const defectQty = Number(rep.defect) || 0;
  const defectRate = okQty + defectQty > 0 ? Math.round((defectQty / (okQty + defectQty)) * 10000) / 100 : null;

  // ---- 照片（软删除的不算）----
  const photos = db
    .prepare(
      `SELECT a.id, a.url, a.cat, a.note, a.taken_at, a.created_at, a.size, a.uploader, n.name AS node_name
         FROM attachments a LEFT JOIN order_nodes n ON n.id = a.node_id
        WHERE a.target_type = 'order' AND a.target_id = ? AND a.deleted_at IS NULL
        ORDER BY a.id`
    )
    .all(id)
    .map((p) => ({
      ...p,
      // 演示数据的前缀不能带到客户看的报告里
      note: stripDemo(p.note),
      cat_label: CAT_LABEL[p.cat] || '其他',
      shot_at: p.taken_at || p.created_at,
      size_kb: Math.round((Number(p.size) || 0) / 1024)
    }))
    .sort((a, b) => {
      // 不良排最前：报告里客户最先看的就是问题件
      const ca = CAT_ORDER.indexOf(a.cat);
      const cb = CAT_ORDER.indexOf(b.cat);
      return ca === cb ? String(a.shot_at).localeCompare(String(b.shot_at)) : ca - cb;
    });

  const photosByCat = CAT_ORDER.filter((c) => photos.some((p) => p.cat === c)).map((c) => ({
    cat: c,
    label: CAT_LABEL[c],
    items: photos.filter((p) => p.cat === c)
  }));

  return {
    schema: 1,
    generated_at: now(),
    order: {
      id: order.id,
      order_no: order.order_no,
      status: order.status,
      status_label: STATUS_LABEL[order.status] || order.status,
      style_name: order.style_name,
      cus_order_no: order.cus_order_no,
      customer_name: order.customer_name || '—',
      customer_code: order.customer_code || '',
      customer_contact: order.customer_contact || '',
      customer_phone: order.customer_phone || '',
      manager: order.manager || '',
      order_date: order.order_date || '',
      delivery_date: order.delivery_date || '',
      delivery_method: order.delivery_method || '',
      trade_terms: order.trade_terms || '',
      packaging: order.packaging || '',
      shop_name: order.shop_name || '',
      shop_order_no: order.shop_order_no || ''
    },
    total_qty: totalQty,
    item_lines: itemLines,
    size_matrix: { sizes: sizeSet, counts: sizeSet.map((s) => ({ size: s, qty: sizeMap[s] })) },
    qc: {
      result: qcResult,
      result_label: qcResult === 'none' ? '未验货' : QC_RESULT_LABEL[qcResult] || qcResult,
      inspection_no: latest ? latest.inspect_no : null,
      inspect_date: latest ? latest.inspect_date : null,
      inspector: latest ? latest.inspector : null,
      sample_qty: latest ? Number(latest.sample_qty) || 0 : 0,
      pass_qty: latest ? Number(latest.pass_qty) || 0 : 0,
      fail_qty: latest ? Number(latest.fail_qty) || 0 : 0,
      remark: latest ? latest.remark : null,
      // 报告里要打印全部验货单的检验项，不只最新一张
      inspections: inspDetail.map((x) => ({
        id: x.id,
        inspect_no: x.inspect_no,
        type: x.type,
        type_label: { inline: '中期', final: '尾期', pre: '产前' }[x.type] || x.type,
        inspect_date: x.inspect_date,
        inspector: x.inspector,
        standard_name: x.standard_name,
        sample_qty: Number(x.sample_qty) || 0,
        pass_qty: Number(x.pass_qty) || 0,
        fail_qty: Number(x.fail_qty) || 0,
        aql_result: x.aql_result,
        status: x.status,
        remark: x.remark,
        items: (x.items || []).map((i) => ({
          seq: i.seq,
          item_name: i.item_name,
          standard: i.standard,
          actual: i.actual,
          result: i.result,
          critical: !!i.critical,
          remark: i.remark
        })),
        ng_count: (x.items || []).filter((i) => i.result === 'ng').length,
        critical_ng: (x.items || []).some((i) => i.result === 'ng' && i.critical)
      }))
    },
    issues: issues.map((x) => ({
      issue_no: x.issue_no,
      type: x.type,
      severity: x.severity,
      qty: Number(x.qty) || 0,
      description: x.description,
      status: x.status,
      action: x.action || '',
      owner: x.owner || '',
      due_date: x.due_date || '',
      created_at: x.created_at
    })),
    issues_open: issuesOpen.length,
    first_article: fa
      ? {
          fa_no: fa.fa_no,
          style_no: fa.style_no,
          status: fa.status,
          conclusion: fa.conclusion,
          inspector: fa.inspector,
          inspected_at: fa.inspected_at,
          released_at: fa.released_at
        }
      : null,
    production: { ok_qty: okQty, defect_qty: defectQty, defect_rate: defectRate, hours: Number(rep.hours) || 0 },
    photos,
    photos_by_cat: photosByCat,
    photos_count: photos.length
  };
}

/** 生成一份报告（快照入库） */
function create(orderId, user, note) {
  const snap = buildSnapshot(orderId);
  const reportNo = nextReportNo();
  const prev = db
    .prepare('SELECT MAX(version) AS v FROM inspection_reports WHERE order_id = ?')
    .get(Number(orderId));
  const version = (Number(prev && prev.v) || 0) + 1;

  const info = db
    .prepare(
      `INSERT INTO inspection_reports
       (report_no, order_id, version, qc_result, qc_inspection_no, photos_count, issues_open, snapshot, generated_by, generated_at, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      reportNo,
      Number(orderId),
      version,
      snap.qc.result,
      snap.qc.inspection_no,
      snap.photos_count,
      snap.issues_open,
      JSON.stringify(snap),
      user || null,
      now(),
      note || null
    );

  return get(Number(info.lastInsertRowid));
}

function get(idOrNo) {
  const row = /^\d+$/.test(String(idOrNo))
    ? db.prepare('SELECT * FROM inspection_reports WHERE id = ?').get(Number(idOrNo))
    : db.prepare('SELECT * FROM inspection_reports WHERE report_no = ?').get(String(idOrNo));
  if (!row) {
    const e = new Error('报告不存在');
    e.status = 404;
    throw e;
  }
  let snap = {};
  try {
    snap = JSON.parse(row.snapshot || '{}');
  } catch (e) {
    snap = {};
  }
  return {
    id: row.id,
    report_no: row.report_no,
    order_id: row.order_id,
    version: row.version,
    qc_result: row.qc_result,
    qc_inspection_no: row.qc_inspection_no,
    photos_count: row.photos_count,
    issues_open: row.issues_open,
    generated_by: row.generated_by,
    generated_at: row.generated_at,
    note: row.note,
    snapshot: snap
  };
}

/** 某订单的报告历史（不含 snapshot，列表用） */
function listByOrder(orderId) {
  return db
    .prepare(
      `SELECT id, report_no, order_id, version, qc_result, qc_inspection_no,
              photos_count, issues_open, generated_by, generated_at, note
         FROM inspection_reports WHERE order_id = ? ORDER BY version DESC`
    )
    .all(Number(orderId));
}

/** 最近的报告（首页/报表用） */
function recent(limit = 20) {
  return db
    .prepare(
      `SELECT r.id, r.report_no, r.order_id, r.version, r.qc_result, r.photos_count,
              r.generated_by, r.generated_at, o.order_no, o.style_name
         FROM inspection_reports r LEFT JOIN orders o ON o.id = r.order_id
        ORDER BY r.id DESC LIMIT ${Math.min(Number(limit) || 20, 100)}`
    )
    .all();
}

module.exports = { buildSnapshot, create, get, listByOrder, recent, nextReportNo, CAT_LABEL, QC_RESULT_LABEL };
