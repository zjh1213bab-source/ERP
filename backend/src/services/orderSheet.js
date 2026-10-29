/**
 * 订单信息收集看板 —— 下单信息 + 打版信息合成一份
 * ========================================================================
 * 需求：点款式进详情，要把「下单时填的」和「打版时填的」放在一张看板上；
 * 打印纸质订单时能勾选哪些字段打出来。
 *
 * ## 为什么字段清单在后端定义，而不是前端拼
 *
 * 同一份信息有两个出口：屏幕上看、纸上打。如果屏幕由前端拼、打印由打印页再拼一遍，
 * 必然出现「屏幕上有、纸上没有」或者反过来 —— 而且没人会发现，因为两边都「看着正常」。
 *
 * 所以这里一次性算出 `groups[].fields[].value`，屏幕和打印都只是**渲染这份结果**，
 * 勾选打印也只是「挑哪几个 field 渲染」。加一个字段只改这一个文件。
 *
 * ## 分组不是装饰
 *
 * 打印时按组勾选（下单信息 / 款式信息 / 物料与工艺要求 / 明细表 / 工序），
 * 因为不同用途的纸不一样：给车间的工艺单要物料与工艺，给客户的确认单不要工序，
 * 给财务的对账单不要面料成分。按字段一个个勾太细，按组勾刚好。
 */
const { db } = require('../db');
const { localDate } = require('../utils/time');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};

const TYPE_LABEL = { custom: '定制', stock: '现货' };
const STATUS_LABEL = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};

/** 空值统一成空串，让前端/打印自己决定显示「—」还是留白 */
const s = (v) => (v === null || v === undefined ? '' : String(v).trim());
const n = (v) => Number(v) || 0;
const money = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 字段定义 —— 加字段只改这里
 *
 * `group` 决定打印时按哪一组勾选；`wide: true` 表示长文本（占整行）。
 */
function buildGroups(ctx) {
  const { o, cus, tp, items, nodes } = ctx;
  const firstNo = items.length ? s(items[0].style_no) : '';

  const order = [
    ['order_no', '订单号', s(o.order_no)],
    ['type', '订单类型', TYPE_LABEL[o.type] || s(o.type)],
    ['status', '当前状态', STATUS_LABEL[o.status] || s(o.status)],
    ['customer_name', '客户', s(cus && cus.name)],
    ['cus_order_no', '客户订单号', s(o.cus_order_no)],
    ['order_date', '下单日期', s(o.order_date).slice(0, 10)],
    ['delivery_date', '交期', s(o.delivery_date).slice(0, 10)],
    ['delivery_method', '交货方式', s(o.delivery_method)],
    ['trade_terms', '贸易条款', s(o.trade_terms)],
    ['packaging', '包装要求', s(o.packaging)],
    ['manager', '跟单员', s(o.manager)],
    ['shop_name', '店铺名称', s(o.shop_name)],
    ['shop_order_no', '店铺订单号', s(o.shop_order_no)],
    ['total_usd', '金额（USD）', o.total_usd === null || o.total_usd === undefined ? '' : '$' + money(o.total_usd).toLocaleString('zh-CN')],
    ['total_amount', '金额（CNY）', o.total_amount === null || o.total_amount === undefined ? '' : '¥' + money(o.total_amount).toLocaleString('zh-CN')],
    ['rate', '汇率', o.rate ? String(o.rate) : '']
  ];

  const style = [
    ['style_name', '款名', s(o.style_name)],
    ['style_no', '款号', firstNo],
    ['category', '品类', s(tp && tp.category)],
    ['series', '系列', s(tp && tp.series)],
    ['wave', '波段', s(tp && tp.wave)],
    ['brand', '品牌', s(tp && tp.brand)],
    ['label_name', '标签', s(tp && tp.label_name)],
    ['colors', '颜色', s(tp && tp.colors)],
    ['size_range', '尺码范围', s(tp && tp.size_range)],
    ['customer_style_no', '客户款号', s(tp && tp.customer_style_no)],
    ['designer', '设计师', s(tp && tp.designer)],
    ['pattern_maker', '打版师', s(tp && tp.pattern_maker)],
    ['pattern_no', '版单号', s(tp && tp.pattern_no)],
    ['sales_owner', '业务员', s(tp && tp.sales_owner)]
  ];

  const material = [
    ['fabric_info', '面料要求', s(tp && tp.fabric_info), true],
    ['accessory_info', '辅料要求', s(tp && tp.accessory_info), true],
    ['craft_info', '工艺 / 工序', s(tp && tp.craft_info), true],
    ['customer_req', '客户要求', s(tp && tp.customer_req), true],
    ['size_spec', '尺码规格说明', s(tp && tp.size_spec), true]
  ];

  const note = [['remark', '订单备注', s(o.remark), true]];

  const map = (arr) => arr.map(([key, label, value, wide]) => ({ key, label, value: value === undefined ? '' : value, wide: !!wide }));

  const doneCount = nodes.filter((x) => x.status === 'done').length;
  const process = [
    { key: 'node_progress', label: '工序进度', value: nodes.length ? `${doneCount}/${nodes.length} 已完成` : '未生成工序', wide: false },
    { key: 'node_current', label: '当前环节', value: (nodes.find((x) => x.status === 'doing') || nodes.find((x) => x.status === 'pending') || {}).name || '—', wide: false },
    { key: 'node_detail', label: '工序明细', value: nodes.map((x) => `${x.name}(${x.status === 'done' ? '✓' : x.status === 'doing' ? '进行中' : x.status === 'skipped' ? '不适用' : '待'})`).join(' · '), wide: true }
  ];

  return [
    { key: 'order', label: '下单信息', fields: map(order) },
    { key: 'style', label: '款式信息（打版）', fields: map(style) },
    { key: 'material', label: '物料与工艺要求（打版）', fields: map(material) },
    { key: 'note', label: '订单备注', fields: map(note) },
    { key: 'process', label: '工序进度', fields: process },
    { key: 'detail', label: '颜色尺码明细', fields: [] }   // 表格类，值在 details 里
  ];
}

/**
 * 算出一张订单的全部可展示信息
 *
 * 屏幕上的速览弹窗与纸质打印都吃这一份，保证「看到的」和「打出来的」永远一致。
 */
function sheet(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw bad('订单不存在', 404);

  const cus = o.customer_id
    ? db.prepare('SELECT id, name, code, contact, phone, email, level FROM customers WHERE id = ?').get(o.customer_id)
    : null;

  // 打版信息取「当前生效」那一版：已确认且款名匹配 > 最新已确认 > 最新一条
  const tps = db.prepare('SELECT * FROM tech_packs WHERE order_id = ? ORDER BY id DESC').all(orderId);
  let tp = null;
  if (tps.length) {
    const style = s(o.style_name);
    tp = (style && tps.find((t) => t.status === 'confirmed' && s(t.product_name).includes(style)))
      || tps.find((t) => t.status === 'confirmed')
      || tps[0];
  }
  if (tp) {
    tp.materials = db.prepare(
      'SELECT * FROM tech_pack_materials WHERE tech_pack_id = ? ORDER BY sort, id'
    ).all(tp.id);
    tp.sizes = db.prepare(
      'SELECT * FROM tech_pack_sizes WHERE tech_pack_id = ? ORDER BY sort, id'
    ).all(tp.id);
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId).map((it) => ({
    ...it,
    sizes: db.prepare('SELECT * FROM order_item_sizes WHERE item_id = ? ORDER BY color, size').all(it.id)
  }));

  const nodes = db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(orderId);

  const groups = buildGroups({ o, cus, tp, items, nodes });

  return {
    order_id: o.id,
    order_no: o.order_no,
    /** 原始值：前端要按它上色/判断，别从中文标签反推 */
    type_raw: o.type,
    status_raw: o.status,
    /** 超期判定与看板同一口径：填了交期 + 交期已过 + 还没走完 */
    overdue: (() => {
      const d = s(o.delivery_date).slice(0, 10);
      if (!d) return false;
      if (['shipped', 'closed', 'cancelled'].includes(o.status)) return false;
      return d < localDate(new Date().toISOString());
    })(),
    thumb: o.image_url || (tp && tp.image_url) || '',
    customer: cus,
    techpack: tp
      ? {
        id: tp.id, version: tp.version, status: tp.status, stage: tp.stage,
        image_url: tp.image_url, confirmed_at: tp.confirmed_at
      }
      : null,
    groups,
    details: {
      items: items.map((it) => ({
        id: it.id, product_name: it.product_name, style_no: it.style_no, sku: it.sku,
        qty: n(it.qty), amount_usd: money(it.amount_usd), amount_cny: money(it.amount_cny),
        sizes: it.sizes.map((sz) => ({
          color: sz.color, size: sz.size, qty: n(sz.qty),
          usd_price: money(sz.usd_price), amount_usd: money(sz.amount_usd)
        }))
      })),
      materials: (tp && tp.materials ? tp.materials : []).map((m) => ({
        type: m.mat_type, name: m.material_name, spec: m.spec_info, composition: m.composition,
        color: m.colorway, supplier: m.supplier, unit: m.unit,
        one_use: money(m.one_use), loss_rate: money(m.loss_rate), amount: money(m.amount)
      })),
      sizes: tp && tp.sizes ? tp.sizes : [],
      nodes
    }
  };
}

/** 可打印字段清单（打印勾选框用） */
function printableFields() {
  const fake = { o: {}, cus: null, tp: null, items: [], nodes: [] };
  return buildGroups(fake)
    .filter((g) => g.fields.length)
    .map((g) => ({
      key: g.key,
      label: g.label,
      fields: g.fields.map((f) => ({ key: f.key, label: f.label, wide: f.wide }))
    }));
}

module.exports = { sheet, printableFields, TYPE_LABEL, STATUS_LABEL };
