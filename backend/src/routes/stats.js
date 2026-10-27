/**
 * 报表中心（统计 + CSV 导出）
 * GET /api/stats/orders     订单统计
 * GET /api/stats/production 生产统计
 * GET /api/stats/stock      库存统计
 * GET /api/stats/shortage   缺货统计（按美仓核对已入库订单）
 * 任意接口加 ?export=1 返回 CSV
 */
const express = require('express');
const { db } = require('../db');
const { ok, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
const fmt = (n) => (Number(n) || 0).toFixed(2);

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

const STATUS_LABEL = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};

// ---------------- 订单 ----------------
router.get('/orders', authRequired, wrap(async (req, res) => {
  const total = db.prepare('SELECT COUNT(*) cnt, COALESCE(SUM(total_usd),0) usd, COALESCE(SUM(total_amount),0) cny FROM orders').get();
  const byStatus = db.prepare('SELECT status, COUNT(*) cnt, COALESCE(SUM(total_usd),0) usd, COALESCE(SUM(total_amount),0) cny FROM orders GROUP BY status ORDER BY cnt DESC').all();
  const byType = db.prepare('SELECT type, COUNT(*) cnt, COALESCE(SUM(total_usd),0) usd, COALESCE(SUM(total_amount),0) cny FROM orders GROUP BY type').all();
  const topCustomers = db.prepare(
    `SELECT COALESCE(c.name, '散客') AS name, COUNT(*) cnt, COALESCE(SUM(o.total_usd),0) usd
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     GROUP BY o.customer_id ORDER BY usd DESC LIMIT 10`
  ).all();

  if (req.query.export) {
    return csv(res, 'orders-report.csv', ['状态', '订单数', '金额USD', '金额CNY'],
      byStatus.map((r) => [STATUS_LABEL[r.status] || r.status, r.cnt, fmt(r.usd), fmt(r.cny)]));
  }
  return ok(res, {
    total: { cnt: Number(total.cnt), usd: Number(total.usd), cny: Number(total.cny) },
    byStatus, byType, topCustomers
  });
}));

// ---------------- 生产 ----------------
router.get('/production', authRequired, wrap(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const inProd = Number(db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('assigned','production')").get().c);
  const nodeAgg = db.prepare(
    "SELECT SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done, COUNT(*) total FROM order_nodes"
  ).get();
  const overdue = Number(db.prepare(
    "SELECT COUNT(*) c FROM orders WHERE delivery_date IS NOT NULL AND delivery_date < ? AND status NOT IN ('shipped','closed','cancelled')"
  ).get(today).c);
  const byNode = db.prepare(
    `SELECT name,
       SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
       SUM(CASE WHEN status='doing' THEN 1 ELSE 0 END) doing,
       SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending
     FROM order_nodes GROUP BY name ORDER BY MIN(seq)`
  ).all();

  if (req.query.export) {
    return csv(res, 'production-report.csv', ['工序', '已完成', '进行中', '待开始'],
      byNode.map((r) => [r.name, r.done || 0, r.doing || 0, r.pending || 0]));
  }
  return ok(res, {
    inProd, overdue,
    nodeDone: Number(nodeAgg.done || 0),
    nodeTotal: Number(nodeAgg.total || 0),
    byNode
  });
}));

// ---------------- 库存 ----------------
router.get('/stock', authRequired, wrap(async (req, res) => {
  const byWarehouse = db.prepare(
    'SELECT warehouse, COALESCE(SUM(qty),0) qty, COUNT(*) skus FROM stock_items WHERE qty != 0 GROUP BY warehouse'
  ).all();
  const byStyle = db.prepare(
    'SELECT warehouse, style_no, COALESCE(SUM(qty),0) qty FROM stock_items WHERE qty != 0 GROUP BY warehouse, style_no ORDER BY qty DESC'
  ).all();

  if (req.query.export) {
    return csv(res, 'stock-report.csv', ['仓库', '款号', '库存件数'],
      byStyle.map((r) => [r.warehouse === 'cn' ? '生产仓' : '美仓', r.style_no || '-', r.qty]));
  }
  return ok(res, { byWarehouse, byStyle });
}));

// ---------------- 缺货 ----------------
router.get('/shortage', authRequired, wrap(async (req, res) => {
  const orders = db.prepare(
    `SELECT o.id, o.order_no, o.style_name, c.name AS customer_name, o.delivery_date
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'instock' ORDER BY o.id DESC`
  ).all();
  const sizeStmt = db.prepare(
    `SELECT i.style_no, i.product_name, s.color, s.size, s.qty
     FROM order_items i JOIN order_item_sizes s ON s.item_id = i.id
     WHERE i.order_id = ? ORDER BY i.id, s.id`
  );
  const stStmt = db.prepare('SELECT qty FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?');

  const rows = [];
  let ordersShort = 0;
  let totalShort = 0;
  orders.forEach((o) => {
    let short = 0;
    sizeStmt.all(o.id).forEach((s) => {
      const st = stStmt.get('us', s.style_no || '', s.color || '', s.size || '');
      const available = st ? Number(st.qty) : 0;
      const demand = Number(s.qty) || 0;
      if (available < demand) {
        const lack = demand - available;
        short += lack;
        rows.push({ order_no: o.order_no, customer_name: o.customer_name, style_name: o.style_name, style_no: s.style_no, product_name: s.product_name, color: s.color, size: s.size, demand, available, lack });
      }
    });
    if (short > 0) { ordersShort++; totalShort += short; }
  });

  if (req.query.export) {
    return csv(res, 'shortage-report.csv', ['订单号', '客户', '款名', '款号', '产品', '颜色', '尺码', '需求', '美仓可用', '缺货'],
      rows.map((r) => [r.order_no, r.customer_name || '', r.style_name || '', r.style_no || '', r.product_name, r.color || '', r.size || '', r.demand, r.available, r.lack]));
  }
  return ok(res, { ordersShort, totalShort, rows });
}));


// ---------------- 毛利分析 ----------------
// 口径：收入取订单人民币金额；成本取「审核通过」的成本单总成本（整单，元）；
//       只有存在已审核成本单的订单才计入毛利，缺成本单的单列出来以免毛利率虚高。
router.get('/profit', authRequired, wrap(async (req, res) => {
  const period = String(req.query.period || '').trim();
  const cond = ["o.status != 'cancelled'"];
  const params = [];
  if (period) { cond.push('substr(o.created_at,1,7) = ?'); params.push(period); }

  const rows = db.prepare(
    `SELECT o.id, o.order_no, o.type, o.status, o.style_name, o.total_usd, o.total_amount AS revenue,
            COALESCE(c.name, '散客') AS customer_name,
            cs.id AS cost_id, COALESCE(cs.total_cost, 0) AS cost, COALESCE(cs.profit_rate, 0) AS markup
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN cost_sheets cs ON cs.order_id = o.id AND cs.status = 'approved'
     WHERE ${cond.join(' AND ')}
     ORDER BY o.id DESC`
  ).all(...params);

  const list = rows.map((r) => {
    const hasCost = !!r.cost_id;
    const profit = hasCost ? r.revenue - r.cost : null;
    return {
      ...r,
      has_cost: hasCost,
      profit,
      margin: hasCost && r.revenue > 0 ? Math.round((profit / r.revenue) * 10000) / 100 : null
    };
  });

  const withCost = list.filter((r) => r.has_cost);
  const revenueAll = list.reduce((s2, r) => s2 + Number(r.revenue || 0), 0);
  const revenueCosted = withCost.reduce((s2, r) => s2 + Number(r.revenue || 0), 0);
  const costSum = withCost.reduce((s2, r) => s2 + Number(r.cost || 0), 0);
  const profitSum = revenueCosted - costSum;
  const missing = list.filter((r) => !r.has_cost);

  // 按客户聚合（仅计入有成本单的订单）
  const byCustomer = {};
  withCost.forEach((r) => {
    const k = r.customer_name;
    if (!byCustomer[k]) byCustomer[k] = { name: k, revenue: 0, cost: 0, profit: 0, cnt: 0 };
    byCustomer[k].revenue += Number(r.revenue || 0);
    byCustomer[k].cost += Number(r.cost || 0);
    byCustomer[k].cnt++;
  });
  const customers = Object.values(byCustomer)
    .map((x) => ({
      ...x,
      revenue: Math.round(x.revenue * 100) / 100,
      cost: Math.round(x.cost * 100) / 100,
      profit: Math.round((x.revenue - x.cost) * 100) / 100,
      margin: x.revenue > 0 ? Math.round(((x.revenue - x.cost) / x.revenue) * 10000) / 100 : 0
    }))
    .sort((a, b) => b.profit - a.profit);

  if (req.query.export) {
    return csv(res, 'profit-report.csv',
      ['订单号', '客户', '款名', '类型', '状态', '收入CNY', '成本CNY', '毛利CNY', '毛利率%', '是否有成本单'],
      list.map((r) => [
        r.order_no, r.customer_name, r.style_name || '', r.type === 'stock' ? '现货' : '定制',
        STATUS_LABEL[r.status] || r.status, fmt(r.revenue), r.has_cost ? fmt(r.cost) : '',
        r.profit === null ? '' : fmt(r.profit), r.margin === null ? '' : r.margin,
        r.has_cost ? '是' : '否'
      ]));
  }
  // 数据质量提醒：毛利率异常高通常意味着成本单没填全，低毛利单需要重点看
  const warnings = [];
  const marginAll = revenueCosted > 0 ? Math.round((profitSum / revenueCosted) * 10000) / 100 : 0;
  if (withCost.length && marginAll > 60) {
    warnings.push(`整体毛利率 ${marginAll}% 偏高，请确认成本单里的材料费/做工费是否填写完整（漏填会让毛利虚高）`);
  }
  const lowMargin = withCost.filter((r) => r.margin !== null && r.margin < 10);
  if (lowMargin.length) {
    warnings.push(`${lowMargin.length} 张订单毛利率低于 10%：` + lowMargin.slice(0, 5).map((r) => r.order_no).join('、'));
  }
  if (missing.length) {
    warnings.push(`${missing.length} 张订单缺已审核成本单，未计入毛利（覆盖 ${list.length ? Math.round((withCost.length / list.length) * 10000) / 100 : 0}%）`);
  }

  return ok(res, {
    period: period || 'all',
    warnings,
    summary: {
      orders: list.length,
      revenue_all: Math.round(revenueAll * 100) / 100,
      costed_orders: withCost.length,
      revenue_costed: Math.round(revenueCosted * 100) / 100,
      cost: Math.round(costSum * 100) / 100,
      profit: Math.round(profitSum * 100) / 100,
      margin: revenueCosted > 0 ? Math.round((profitSum / revenueCosted) * 10000) / 100 : 0,
      missing_orders: missing.length,
      missing_revenue: Math.round(missing.reduce((s2, r) => s2 + Number(r.revenue || 0), 0) * 100) / 100,
      coverage: list.length ? Math.round((withCost.length / list.length) * 10000) / 100 : 0
    },
    byCustomer: customers,
    missing: missing.map((r) => ({
      order_no: r.order_no, customer_name: r.customer_name, style_name: r.style_name,
      revenue: r.revenue, status: r.status
    })),
    rows: list
  });
}));

// ---------------- 客户贡献 ----------------
router.get('/customers', authRequired, wrap(async (req, res) => {
  const period = String(req.query.period || '').trim();
  const cond = ["o.status != 'cancelled'"];
  const params = [];
  if (period) { cond.push('substr(o.created_at,1,7) = ?'); params.push(period); }
  const where = cond.join(' AND ');
  const today = new Date().toISOString().slice(0, 10);

  const base = db.prepare(
    `SELECT o.customer_id AS cid, COALESCE(c.name, '散客') AS name, c.level,
            COUNT(*) AS cnt,
            COALESCE(SUM(o.total_usd), 0) AS usd,
            COALESCE(SUM(o.total_amount), 0) AS cny,
            MAX(o.created_at) AS last_at,
            SUM(CASE WHEN o.delivery_date IS NOT NULL AND o.delivery_date < '${today}'
                     AND o.status NOT IN ('shipped','closed','cancelled') THEN 1 ELSE 0 END) AS overdue_cnt,
            SUM(CASE WHEN o.status IN ('shipped','closed') THEN 1 ELSE 0 END) AS shipped_cnt
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE ${where} GROUP BY o.customer_id ORDER BY cny DESC`
  ).all(...params);

  // 件数
  const pieces = db.prepare(
    `SELECT o.customer_id AS cid, COALESCE(SUM(s.qty), 0) AS qty
     FROM orders o JOIN order_items i ON i.order_id = o.id JOIN order_item_sizes s ON s.item_id = i.id
     WHERE ${where} GROUP BY o.customer_id`
  ).all(...params);
  const qtyMap = {};
  pieces.forEach((p) => { qtyMap[p.cid] = Number(p.qty) || 0; });

  // 毛利（仅已审核成本单）
  const profitRows = db.prepare(
    `SELECT o.customer_id AS cid, COALESCE(SUM(o.total_amount),0) AS revenue, COALESCE(SUM(cs.total_cost),0) AS cost
     FROM orders o JOIN cost_sheets cs ON cs.order_id = o.id AND cs.status = 'approved'
     WHERE ${where} GROUP BY o.customer_id`
  ).all(...params);
  const profitMap = {};
  profitRows.forEach((r) => {
    const rev = Number(r.revenue) || 0;
    const cost = Number(r.cost) || 0;
    profitMap[r.cid] = {
      costed_revenue: rev,
      profit: Math.round((rev - cost) * 100) / 100,
      margin: rev > 0 ? Math.round(((rev - cost) / rev) * 10000) / 100 : 0
    };
  });

  const totalCny = base.reduce((s2, r) => s2 + Number(r.cny || 0), 0);
  const list = base.map((r) => {
    const p = profitMap[r.cid] || null;
    return {
      customer_id: r.cid,
      name: r.name,
      level: r.level || '-',
      cnt: Number(r.cnt),
      qty: qtyMap[r.cid] || 0,
      usd: Math.round(Number(r.usd) * 100) / 100,
      cny: Math.round(Number(r.cny) * 100) / 100,
      avg_usd: Number(r.cnt) > 0 ? Math.round((Number(r.usd) / Number(r.cnt)) * 100) / 100 : 0,
      share: totalCny > 0 ? Math.round((Number(r.cny) / totalCny) * 10000) / 100 : 0,
      last_at: r.last_at ? String(r.last_at).slice(0, 10) : '-',
      overdue_cnt: Number(r.overdue_cnt) || 0,
      shipped_cnt: Number(r.shipped_cnt) || 0,
      profit: p ? p.profit : null,
      margin: p ? p.margin : null
    };
  });

  if (req.query.export) {
    return csv(res, 'customer-report.csv',
      ['客户', '等级', '订单数', '件数', '金额USD', '金额CNY', '占比%', '单均USD', '毛利CNY', '毛利率%', '逾期单', '最近下单'],
      list.map((r) => [r.name, r.level, r.cnt, r.qty, fmt(r.usd), fmt(r.cny), r.share,
        fmt(r.avg_usd), r.profit === null ? '' : fmt(r.profit), r.margin === null ? '' : r.margin,
        r.overdue_cnt, r.last_at]));
  }
  return ok(res, {
    period: period || 'all',
    summary: {
      customers: list.length,
      total_cny: Math.round(totalCny * 100) / 100,
      top1_share: list.length ? list[0].share : 0,
      active: list.filter((r) => r.cnt > 0).length
    },
    rows: list
  });
}));

// ---------------- 工厂产能 / 外协对账 ----------------
router.get('/factories', authRequired, wrap(async (req, res) => {
  const days30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT COALESCE(f.name, d.factory_name, '未指定') AS name,
            MAX(d.type) AS type,
            COUNT(*) AS cnt,
            COALESCE(SUM(d.qty), 0) AS qty,
            COALESCE(SUM(d.qty * d.price), 0) AS amount,
            COALESCE(SUM(CASE WHEN d.status = 'settled' THEN d.qty * d.price ELSE 0 END), 0) AS settled,
            COALESCE(SUM(CASE WHEN d.status != 'settled' THEN d.qty * d.price ELSE 0 END), 0) AS unsettled,
            MAX(d.created_at) AS last_at
     FROM dispatch_orders d LEFT JOIN factories f ON f.id = d.factory_id
     GROUP BY COALESCE(f.name, d.factory_name, '未指定')
     ORDER BY amount DESC`
  ).all();

  const inProd = db.prepare(
    `SELECT COALESCE(f.name, d.factory_name, '未指定') AS name, COUNT(DISTINCT o.id) AS c
     FROM dispatch_orders d LEFT JOIN factories f ON f.id = d.factory_id
     JOIN orders o ON o.id = d.order_id
     WHERE o.status IN ('assigned','production') GROUP BY COALESCE(f.name, d.factory_name, '未指定')`
  ).all();
  const inProdMap = {};
  inProd.forEach((r) => { inProdMap[r.name] = Number(r.c) || 0; });

  const recent = db.prepare(
    `SELECT COALESCE(f.name, d.factory_name, '未指定') AS name, COALESCE(SUM(d.qty), 0) AS qty
     FROM dispatch_orders d LEFT JOIN factories f ON f.id = d.factory_id
     WHERE d.created_at >= ? GROUP BY COALESCE(f.name, d.factory_name, '未指定')`
  ).all(days30);
  const recentMap = {};
  recent.forEach((r) => { recentMap[r.name] = Number(r.qty) || 0; });

  const list = rows.map((r) => ({
    name: r.name,
    type: r.type === 'outsource' ? '外协' : '本厂',
    cnt: Number(r.cnt),
    qty: Number(r.qty) || 0,
    amount: Math.round(Number(r.amount) * 100) / 100,
    settled: Math.round(Number(r.settled) * 100) / 100,
    unsettled: Math.round(Number(r.unsettled) * 100) / 100,
    unit_price: Number(r.qty) > 0 ? Math.round((Number(r.amount) / Number(r.qty)) * 100) / 100 : 0,
    in_prod: inProdMap[r.name] || 0,
    qty_30d: recentMap[r.name] || 0,
    last_at: r.last_at ? String(r.last_at).slice(0, 10) : '-'
  }));
  const totalQty = list.reduce((s2, r) => s2 + r.qty, 0);

  if (req.query.export) {
    return csv(res, 'factory-report.csv',
      ['工厂', '类型', '分单次数', '件数', '占比%', '金额', '已结算', '未结算', '平均单价', '在产订单', '近30天件数', '最近分单'],
      list.map((r) => [r.name, r.type, r.cnt, r.qty,
        totalQty ? Math.round((r.qty / totalQty) * 10000) / 100 : 0,
        fmt(r.amount), fmt(r.settled), fmt(r.unsettled), fmt(r.unit_price), r.in_prod, r.qty_30d, r.last_at]));
  }
  return ok(res, {
    summary: {
      factories: list.length,
      qty: totalQty,
      amount: Math.round(list.reduce((s2, r) => s2 + r.amount, 0) * 100) / 100,
      unsettled: Math.round(list.reduce((s2, r) => s2 + r.unsettled, 0) * 100) / 100,
      in_prod: list.reduce((s2, r) => s2 + r.in_prod, 0)
    },
    rows: list
  });
}));

// ---------------- 账期 / 账龄 ----------------
// 说明：系统暂无收款台账，「应收敞口」= 已发货未结案订单金额；账龄自「首次发货」起算。
router.get('/receivables', authRequired, wrap(async (req, res) => {
  const shippedAt = db.prepare(
    "SELECT MIN(created_at) AS t FROM order_logs WHERE order_id = ? AND to_status = 'shipped'"
  );
  const closedAt = db.prepare(
    "SELECT MIN(created_at) AS t FROM order_logs WHERE order_id = ? AND to_status = 'closed'"
  );

  const open = db.prepare(
    `SELECT o.id, o.order_no, o.style_name, o.total_amount, o.total_usd, o.status, o.delivery_date,
            COALESCE(c.name, '散客') AS customer_name
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'shipped' ORDER BY o.id DESC`
  ).all();

  const todayMs = Date.now();
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const rows = open.map((o) => {
    const s = shippedAt.get(o.id);
    const shipDate = s && s.t ? String(s.t).slice(0, 10) : null;
    const ageDays = shipDate ? Math.max(0, Math.floor((todayMs - new Date(shipDate).getTime()) / 86400000)) : null;
    let bucket = '未知';
    if (ageDays !== null) {
      bucket = ageDays <= 30 ? '0-30' : ageDays <= 60 ? '31-60' : ageDays <= 90 ? '61-90' : '90+';
      buckets[bucket] += Number(o.total_amount) || 0;
    }
    return {
      order_no: o.order_no, customer_name: o.customer_name, style_name: o.style_name,
      amount: Number(o.total_amount) || 0, usd: Number(o.total_usd) || 0,
      ship_date: shipDate || '-', age_days: ageDays, bucket
    };
  });

  // 已结案订单的回款周期（发货→结案 天数）
  const closed = db.prepare(
    "SELECT DISTINCT order_id FROM order_logs WHERE to_status = 'closed'"
  ).all();
  const cycles = [];
  closed.forEach((r) => {
    const s = shippedAt.get(r.order_id);
    const c2 = closedAt.get(r.order_id);
    if (s && s.t && c2 && c2.t) {
      const d = Math.floor((new Date(c2.t).getTime() - new Date(s.t).getTime()) / 86400000);
      if (d >= 0) cycles.push(d);
    }
  });

  // 按客户汇总敞口
  const byCustomer = {};
  rows.forEach((r) => {
    const k = r.customer_name;
    if (!byCustomer[k]) byCustomer[k] = { name: k, cnt: 0, amount: 0, max_age: 0, oldest: null };
    byCustomer[k].cnt++;
    byCustomer[k].amount += r.amount;
    if (r.age_days !== null && r.age_days > byCustomer[k].max_age) {
      byCustomer[k].max_age = r.age_days;
      byCustomer[k].oldest = r.order_no;
    }
  });
  const customerRows = Object.values(byCustomer)
    .map((x) => ({ ...x, amount: Math.round(x.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);

  const totalOpen = rows.reduce((s2, r) => s2 + r.amount, 0);
  const overdue60 = rows.filter((r) => r.age_days !== null && r.age_days > 60);

  if (req.query.export) {
    return csv(res, 'receivables-report.csv',
      ['订单号', '客户', '款名', '金额CNY', '金额USD', '发货日', '账龄(天)', '账龄段'],
      rows.map((r) => [r.order_no, r.customer_name, r.style_name || '', fmt(r.amount), fmt(r.usd),
        r.ship_date, r.age_days === null ? '' : r.age_days, r.bucket]));
  }
  return ok(res, {
    summary: {
      open_orders: rows.length,
      open_amount: Math.round(totalOpen * 100) / 100,
      overdue60_orders: overdue60.length,
      overdue60_amount: Math.round(overdue60.reduce((s2, r) => s2 + r.amount, 0) * 100) / 100,
      avg_cycle: cycles.length ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 10) / 10 : null,
      closed_samples: cycles.length
    },
    buckets: Object.entries(buckets).map(([k, v]) => ({ bucket: k, amount: Math.round(v * 100) / 100 })),
    byCustomer: customerRows,
    rows
  });
}));

module.exports = router;
