/**
 * 智能助手（规则式数据洞察，无需外部大模型）
 * GET  /api/assistant/insights            风险预警（含跳转链接）+ 关键指标
 * GET  /api/assistant/report?period=      经营解读（环比/同比 + 自动结论）
 * POST /api/assistant/query  { q }        自然语言查数（订单号/客户/款号/主题）
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
/** 基础账号可使用工作指引；全公司问数仍需业务岗位。 */
router.use(authRequired, wrap(async(req,res,next)=>{
 if(req.user.positionDirect||!req.user.roles?.every(r=>r==='employee'))return next();
 if(req.method==='GET'&&req.path==='/insights')return ok(res,{alerts:[],overdue:[],dueSoon:[],lowStock:[],scope:'self'});
 if(req.method==='GET'&&req.path==='/report')return ok(res,{metrics:{},conclusions:[],risks:[],tips:[],compare:{},scope:'self'});
 if(req.method==='POST'&&req.path==='/query'){
  const q=String(req.body?.q||'').trim();if(!q||q.length>500)return fail(res,400,'请输入1至500字的问题');
  return ok(res,{q,title:'员工工作指引',summary:'普通员工可查询本人自助、本人异常和内部邮件；业务数据需管理员分配对应岗位。',columns:[{key:'topic',label:'事项'},{key:'guide',label:'办理入口'}],rows:[{topic:'考勤、工资条、请假',guide:'我的自助'},{topic:'本人异常任务',guide:'异常日清'},{topic:'同事协作',guide:'内部邮件'},{topic:'标签查询',guide:'扫码查询'}],links:[{to:'/self',text:'我的自助'},{to:'/exceptions',text:'本人异常'},{to:'/mail',text:'内部邮件'}],scope:'self'});
 }
 return fail(res,403,'此功能需要业务岗位授权');
}));
const LOW_STOCK = 20;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const money = (v) => round2(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

const STATUS_LABELS = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};

function periodShift(period, delta) {
  const [y, m] = String(period).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function periodRange(period) {
  const [y, m] = String(period).split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}
function growth(cur, prev) {
  const a = Number(cur) || 0;
  const b = Number(prev) || 0;
  if (b === 0) return a === 0 ? 0 : null; // null = 无可比基数
  return round2(((a - b) / b) * 100);
}

/** 美仓缺货统计（按待发货订单逐码比对） */
function shortageStats() {
  const orders = db.prepare("SELECT id, order_no FROM orders WHERE status='instock'").all();
  const sizeStmt = db.prepare(
    'SELECT i.style_no, s.color, s.size, s.qty FROM order_items i JOIN order_item_sizes s ON s.item_id=i.id WHERE i.order_id=?'
  );
  const stStmt = db.prepare('SELECT qty FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?');
  let orderCount = 0;
  let pieces = 0;
  const detail = [];
  orders.forEach((o) => {
    let lack = 0;
    sizeStmt.all(o.id).forEach((s) => {
      const st = stStmt.get('us', s.style_no || '', s.color || '', s.size || '');
      const avail = st ? Number(st.qty) : 0;
      const demand = Number(s.qty) || 0;
      if (avail < demand) lack += demand - avail;
    });
    if (lack > 0) {
      orderCount++;
      pieces += lack;
      detail.push({ order_no: o.order_no, lack });
    }
  });
  return { orders: orderCount, pieces, detail };
}

// ---------------- 风险预警 ----------------
router.get('/insights', authRequired, wrap(async (req, res) => {
  const t = today();
  const month = t.slice(0, 7);
  const in3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const overdue = db.prepare(
    `SELECT o.id, o.order_no, o.style_name, o.delivery_date, o.status, c.name AS customer_name
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.delivery_date IS NOT NULL AND o.delivery_date < ?
       AND o.status NOT IN ('shipped','closed','cancelled')
     ORDER BY o.delivery_date ASC LIMIT 20`
  ).all(t);

  // 3 天内到期（尚未发货）
  const dueSoon = db.prepare(
    `SELECT o.id, o.order_no, o.style_name, o.delivery_date, o.status, c.name AS customer_name
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.delivery_date IS NOT NULL AND o.delivery_date >= ? AND o.delivery_date <= ?
       AND o.status NOT IN ('shipped','closed','cancelled')
     ORDER BY o.delivery_date ASC LIMIT 20`
  ).all(t, in3);

  const techPending = Number(db.prepare("SELECT COUNT(*) c FROM tech_packs WHERE status='draft'").get().c);
  const costPending = Number(db.prepare("SELECT COUNT(*) c FROM cost_sheets WHERE status='pending'").get().c);
  const toDispatch = Number(db.prepare(
    "SELECT COUNT(*) c FROM orders o WHERE o.status='finance' AND EXISTS (SELECT 1 FROM cost_sheets cs WHERE cs.order_id=o.id AND cs.status='approved')"
  ).get().c);

  const shortage = shortageStats();

  const lowStock = db.prepare(
    'SELECT warehouse, style_no, product_name, color, size, qty FROM stock_items WHERE qty > 0 AND qty < ? ORDER BY qty ASC LIMIT 20'
  ).all(LOW_STOCK);

  const monthAgg = db.prepare(
    'SELECT COUNT(*) cnt, COALESCE(SUM(total_usd),0) usd, COALESCE(SUM(total_amount),0) cny FROM orders WHERE substr(created_at,1,7) = ?'
  ).get(month);

  const inProdBatch = Number(db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('assigned','production')").get().c);
  const overdueNodes = Number(db.prepare(
    "SELECT COUNT(*) c FROM order_nodes WHERE status != 'done' AND plan_date IS NOT NULL AND plan_date < ?"
  ).get(t).c);

  // 报价单即将过期（7 天内且未成交）
  const quoteExpiring = db.prepare(
    `SELECT id, quote_no, total_usd, valid_until, status FROM quotations
     WHERE valid_until IS NOT NULL AND valid_until >= ? AND valid_until <= ?
       AND status IN ('draft','sent') ORDER BY valid_until LIMIT 10`
  ).all(t, new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));

  // 本月工资未发放
  const payrollUnpaid = Number(db.prepare(
    "SELECT COUNT(*) c FROM payrolls WHERE period = ? AND status != 'paid'"
  ).get(month).c);

  // 固定资产年检/保养 30 天内到期
  const assetDue = db.prepare(
    `SELECT id, name, plate_no, next_check_date FROM assets
     WHERE status != 'scrapped' AND next_check_date IS NOT NULL AND next_check_date <= ?
     ORDER BY next_check_date LIMIT 10`
  ).all(in30);

  // 行政费用：本月 vs 上月
  const expCur = Number(db.prepare(
    'SELECT COALESCE(SUM(amount),0) s FROM admin_expenses WHERE substr(expense_date,1,7) = ?'
  ).get(month).s);
  const expPrev = Number(db.prepare(
    'SELECT COALESCE(SUM(amount),0) s FROM admin_expenses WHERE substr(expense_date,1,7) = ?'
  ).get(periodShift(month, -1)).s);

  const alerts = [];
  const push = (level, text, to, tag) => alerts.push({ level, text, to: to || null, tag: tag || null });
  if (overdue.length) push('danger', `${overdue.length} 张订单已逾期，最久 ${overdue[0].delivery_date}`, '/orders', '逾期');
  if (shortage.orders) push('danger', `${shortage.orders} 张待发货订单美仓缺货，共缺 ${shortage.pieces} 件`, '/us-ship', '缺货');
  if (dueSoon.length) push('warn', `${dueSoon.length} 张订单 3 天内到期且未发货`, '/orders', '临期');
  if (overdueNodes) push('warn', `${overdueNodes} 道工序超过计划完成日期`, '/production', '工序超期');
  if (payrollUnpaid) push('warn', `${month} 有 ${payrollUnpaid} 条工资单未发放`, '/payrolls', '工资');
  if (quoteExpiring.length) push('warn', `${quoteExpiring.length} 张报价单 7 天内到期`, '/quotations', '报价');
  if (assetDue.length) push('warn', `${assetDue.length} 项资产年检/保养即将到期`, '/assets', '资产');
  if (costPending) push('info', `${costPending} 张成本单待财务审核`, '/approvals', '审批');
  if (techPending) push('info', `${techPending} 份开发单待技术确认`, '/approvals', '审批');
  if (toDispatch) push('info', `${toDispatch} 张订单财务已通过，待分单`, '/approvals', '分单');
  if (expPrev > 0 && expCur > expPrev * 1.3) {
    push('info', `本月行政费用 ¥${money(expCur)}，比上月高 ${growth(expCur, expPrev)}%`, '/admin-expenses', '费用');
  }
  if (!alerts.length) push('ok', '暂无紧急事项，运转正常', null, null);

  return ok(res, {
    alerts,
    overdue,
    dueSoon,
    pending: { techPending, costPending, toDispatch },
    shortage: { orders: shortage.orders, pieces: shortage.pieces, detail: shortage.detail },
    lowStock,
    inProdBatch,
    overdueNodes,
    quoteExpiring,
    payrollUnpaid,
    assetDue,
    expense: { cur: expCur, prev: expPrev, growth: growth(expCur, expPrev) },
    month: { cnt: Number(monthAgg.cnt), usd: Number(monthAgg.usd), cny: Number(monthAgg.cny) }
  });
}));

// ---------------- 经营解读 ----------------
router.get('/report', authRequired, wrap(async (req, res) => {
  const period = String(req.query.period || today().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(period)) return fail(res, 400, 'period 格式应为 YYYY-MM');
  const prev = periodShift(period, -1);
  const lastYear = periodShift(period, -12);
  const { from, to } = periodRange(period);

  const agg = (p) => db.prepare(
    `SELECT COUNT(*) cnt, COALESCE(SUM(total_usd),0) usd, COALESCE(SUM(total_amount),0) cny
     FROM orders WHERE substr(created_at,1,7) = ?`
  ).get(p);
  const cur = agg(period);
  const prevAgg = agg(prev);
  const lyAgg = agg(lastYear);

  // 按状态流转日志统计本期入库/发货（不依赖订单当前状态）
  const flow = (toStatus) => Number(db.prepare(
    `SELECT COUNT(DISTINCT order_id) c FROM order_logs WHERE to_status = ? AND substr(created_at,1,7) = ?`
  ).get(toStatus, period).c);
  const instockCnt = flow('instock');
  const shippedCnt = flow('shipped');
  const closedCnt = flow('closed');

  // 报工产量
  const produced = db.prepare(
    'SELECT COALESCE(SUM(qty_ok),0) ok, COALESCE(SUM(qty_defect),0) bad, COALESCE(SUM(hours),0) h FROM production_reports WHERE substr(report_date,1,7) = ?'
  ).get(period);

  // 库存现状
  const stockCn = Number(db.prepare("SELECT COALESCE(SUM(qty),0) q FROM stock_items WHERE warehouse='cn'").get().q);
  const stockUs = Number(db.prepare("SELECT COALESCE(SUM(qty),0) q FROM stock_items WHERE warehouse='us'").get().q);
  const shortage = shortageStats();

  // 在产 / 逾期
  const inProd = Number(db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('assigned','production')").get().c);
  const overdueCnt = Number(db.prepare(
    "SELECT COUNT(*) c FROM orders WHERE delivery_date IS NOT NULL AND delivery_date < ? AND status NOT IN ('shipped','closed','cancelled')"
  ).get(today()).c);

  // 费用 / 工资
  const exp = Number(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM admin_expenses WHERE substr(expense_date,1,7) = ?').get(period).s);
  const expPrev = Number(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM admin_expenses WHERE substr(expense_date,1,7) = ?').get(prev).s);
  const pay = db.prepare(
    'SELECT COUNT(*) c, COALESCE(SUM(gross_pay),0) g, COALESCE(SUM(net_pay),0) n, COALESCE(SUM(tax),0) t FROM payrolls WHERE period = ?'
  ).get(period);

  // 报价
  const quote = db.prepare(
    'SELECT COUNT(*) c, COALESCE(SUM(total_usd),0) usd FROM quotations WHERE substr(created_at,1,7) = ?'
  ).get(period);
  const quoteWon = Number(db.prepare(
    "SELECT COUNT(*) c FROM quotations WHERE substr(created_at,1,7) = ? AND status IN ('accepted','converted')"
  ).get(period).c);

  // TOP 客户 / TOP 款
  const topCustomers = db.prepare(
    `SELECT c.name, COUNT(*) cnt, COALESCE(SUM(o.total_usd),0) usd FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE substr(o.created_at,1,7) = ? GROUP BY o.customer_id ORDER BY usd DESC LIMIT 5`
  ).all(period);
  const topStyles = db.prepare(
    `SELECT i.product_name, i.style_no, COALESCE(SUM(i.qty),0) qty, COALESCE(SUM(i.amount_usd),0) usd
     FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE substr(o.created_at,1,7) = ? GROUP BY i.product_name ORDER BY usd DESC LIMIT 5`
  ).all(period);

  const m = {
    period,
    orders: Number(cur.cnt),
    usd: round2(cur.usd),
    cny: round2(cur.cny),
    usdGrowth: growth(cur.usd, prevAgg.usd),
    usdYoy: growth(cur.usd, lyAgg.usd),
    ordersGrowth: growth(cur.cnt, prevAgg.cnt),
    instock: instockCnt,
    shipped: shippedCnt,
    closed: closedCnt,
    producedOk: round2(produced.ok),
    producedBad: round2(produced.bad),
    produceHours: round2(produced.h),
    defectRate: produced.ok + produced.bad > 0 ? round2((produced.bad / (produced.ok + produced.bad)) * 100) : 0,
    stockCn,
    stockUs,
    shortOrders: shortage.orders,
    shortPieces: shortage.pieces,
    inProd,
    overdue: overdueCnt,
    expense: exp,
    expenseGrowth: growth(exp, expPrev),
    payrollCount: Number(pay.c),
    payrollGross: round2(pay.g),
    payrollNet: round2(pay.n),
    payrollTax: round2(pay.t),
    quotes: Number(quote.c),
    quoteUsd: round2(quote.usd),
    quoteWon,
    quoteWinRate: Number(quote.c) > 0 ? round2((quoteWon / Number(quote.c)) * 100) : 0,
    avgOrderUsd: Number(cur.cnt) > 0 ? round2(cur.usd / Number(cur.cnt)) : 0,
    topCustomers: topCustomers.map((r) => ({ name: r.name || '未指定', cnt: Number(r.cnt), usd: round2(r.usd) })),
    topStyles: topStyles.map((r) => ({ name: r.product_name, style_no: r.style_no, qty: Number(r.qty), usd: round2(r.usd) }))
  };

  // ---------- 自动结论 ----------
  const conclusions = [];
  const gText = (g) => (g === null ? '（上月无数据，无法比较）' : `${g >= 0 ? '↑' : '↓'} ${Math.abs(g)}%`);

  conclusions.push({
    kind: 'order',
    title: `${period} 订单`,
    text: `本月新接订单 ${m.orders} 张，金额 $${money(m.usd)}（≈¥${money(m.cny)}），环比 ${gText(m.usdGrowth)}，同比 ${gText(m.usdYoy)}；单均 $${money(m.avgOrderUsd)}。`
  });
  conclusions.push({
    kind: 'delivery',
    title: '交付与生产',
    text: `本月入库 ${m.instock} 单、发货 ${m.shipped} 单、结案 ${m.closed} 单；报工合格 ${m.producedOk} 件、不良 ${m.producedBad} 件（不良率 ${m.defectRate}%），共 ${m.produceHours} 工时。当前在产 ${m.inProd} 单，逾期未发 ${m.overdue} 单。`
  });
  conclusions.push({
    kind: 'stock',
    title: '库存与缺货',
    text: `生产仓 ${m.stockCn} 件、美仓 ${m.stockUs} 件；待发货订单中 ${m.shortOrders} 单缺货，合计缺 ${m.shortPieces} 件。`
  });
  conclusions.push({
    kind: 'sales',
    title: '报价转化',
    text: `本月报价 ${m.quotes} 张（$ ${money(m.quoteUsd)}），成交 ${m.quoteWon} 张，成交率 ${m.quoteWinRate}%。`
  });
  conclusions.push({
    kind: 'cost',
    title: '费用与人工',
    text: `行政费用 ¥${money(m.expense)}（环比 ${gText(m.expenseGrowth)}）；本月工资 ${m.payrollCount} 人，应发 ¥${money(m.payrollGross)}、实发 ¥${money(m.payrollNet)}、代扣个税 ¥${money(m.payrollTax)}。`
  });

  const risks = [];
  if (m.overdue > 0) risks.push(`${m.overdue} 张订单已逾期未发，建议优先排产并通知客户交期。`);
  if (m.shortOrders > 0) risks.push(`${m.shortOrders} 张待发货订单美仓缺货（缺 ${m.shortPieces} 件），建议用「库存管理 → 一键补货」从生产仓调拨。`);
  if (m.defectRate > 5) risks.push(`不良率 ${m.defectRate}% 偏高，建议追查工序与工厂。`);
  if (m.payrollCount > 0 && m.payrollNet === 0) risks.push('本月工资单尚未核算完成。');
  if (m.expenseGrowth !== null && m.expenseGrowth > 30) risks.push(`行政费用环比上涨 ${m.expenseGrowth}%，建议核对大额支出。`);
  if (m.usdGrowth !== null && m.usdGrowth < -20) risks.push(`订单金额环比下降 ${Math.abs(m.usdGrowth)}%，建议加强客户跟进。`);
  if (!risks.length) risks.push('本期未发现明显经营风险。');

  const tips = [];
  if (m.quoteWinRate < 30 && m.quotes >= 3) tips.push('报价成交率偏低，可检查报价单价格档位与交期承诺。');
  if (m.stockUs > 0 && m.shipped === 0) tips.push('美仓有库存但本月无发货，确认是否有滞销款需要促销或调拨。');
  if (m.topCustomers.length && m.topCustomers[0].usd > m.usd * 0.6) tips.push(`客户「${m.topCustomers[0].name}」占本月金额 ${round2((m.topCustomers[0].usd / m.usd) * 100)}%，客户集中度偏高。`);
  if (m.produceHours > 0) tips.push(`本期平均每工时产出 ${round2(m.producedOk / m.produceHours)} 件。`);
  if (!tips.length) tips.push('继续保持当前节奏，可按周复盘逾期与缺货。');

  return ok(res, { metrics: m, conclusions, risks, tips, compare: { prevPeriod: prev, lastYear } });
}));

// ---------------- 自然语言查数 ----------------
const COL = (key, label, align) => ({ key, label, align: align || 'left' });

function findOrderByNo(q) {
  const m = q.match(/(SO|XS)\s*-?\s*(\d{6,})/i);
  if (!m) return null;
  const no = (m[1].toUpperCase() === 'SO' ? 'SO' : 'XS') + m[2];
  return db.prepare(
    `SELECT o.*, c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.order_no = ?`
  ).get(no);
}

function ordersOf(where, params, title, links) {
  const rows = db.prepare(
    `SELECT o.order_no, c.name AS customer_name, o.style_name, o.status, o.total_usd, o.delivery_date
     FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
     WHERE ${where} ORDER BY o.id DESC LIMIT 50`
  ).all(...params);
  const amount = round2(rows.reduce((s, r) => s + Number(r.total_usd || 0), 0));
  return {
    intent: 'orders',
    title,
    summary: `共 ${rows.length} 单，合计 $${money(amount)}`,
    columns: [COL('order_no', '订单号'), COL('customer_name', '客户'), COL('style_name', '款名'),
      COL('status_label', '状态'), COL('total_usd', '金额USD', 'right'), COL('delivery_date', '交期')],
    rows: rows.map((r) => ({ ...r, status_label: STATUS_LABELS[r.status] || r.status })),
    links: links || [{ text: '去订单列表', to: '/orders' }]
  };
}

function answerQuery(raw) {
  const q = String(raw || '').trim();
  if (!q) return null;
  const t = today();
  const month = t.slice(0, 7);

  // 1) 订单号
  const order = findOrderByNo(q);
  if (order) {
    const sizes = db.prepare(
      'SELECT i.product_name, i.style_no, s.color, s.size, s.qty, s.usd_price FROM order_items i JOIN order_item_sizes s ON s.item_id=i.id WHERE i.order_id=? ORDER BY s.id'
    ).all(order.id);
    const totalQty = sizes.reduce((s, r) => s + Number(r.qty || 0), 0);
    return {
      intent: 'order-detail',
      title: `订单 ${order.order_no}`,
      summary: `${order.customer_name || '未指定客户'} · ${order.style_name || '未命名款'} · ${STATUS_LABELS[order.status] || order.status} · 共 ${totalQty} 件 · $${money(order.total_usd)}（≈¥${money(order.total_amount)}）· 交期 ${order.delivery_date || '未定'}`,
      columns: [COL('product_name', '产品'), COL('style_no', '款号'), COL('color', '颜色'), COL('size', '尺码'),
        COL('qty', '数量', 'right'), COL('usd_price', '单价USD', 'right')],
      rows: sizes,
      links: [{ text: '查看订单详情', to: '/orders?order=' + order.id }]
    };
  }

  // 2) 客户
  const cust = db.prepare('SELECT * FROM customers WHERE name LIKE ? OR code LIKE ? LIMIT 1').get(`%${q}%`, `%${q}%`);
  if (cust && q.length >= 2 && !/订单|库存|工资|费用|报价|资产|生产|逾期/.test(q)) {
    return ordersOf('o.customer_id = ?', [cust.id], `客户「${cust.name}」的订单`,
      [{ text: '去客户管理', to: '/customers' }, { text: '去订单列表', to: '/orders' }]);
  }

  // 3) 产品 / 款号
  const prod = db.prepare('SELECT * FROM products WHERE sku LIKE ? OR name LIKE ? LIMIT 1').get(`%${q}%`, `%${q}%`);
  if (prod && q.length >= 2 && !/订单|库存|工资|费用|报价|资产|生产|逾期/.test(q)) {
    const tiers = db.prepare('SELECT min_qty, max_qty, price_usd FROM price_tiers WHERE product_id=? ORDER BY min_qty').all(prod.id);
    const tierText = tiers.length
      ? tiers.map((x) => `${x.min_qty}${x.max_qty ? '-' + x.max_qty : '+'} 件 $${x.price_usd}`).join('，')
      : '未配置阶梯价';
    const stock = round2(db.prepare('SELECT COALESCE(SUM(qty),0) q FROM stock_items WHERE style_no = ?').get(prod.sku || '').q);
    const res2 = ordersOf(
      'EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND (i.product_id = ? OR i.style_no = ?))',
      [prod.id, prod.sku || ''],
      `产品「${prod.name}」相关订单`,
      [{ text: '去产品管理', to: '/products' }]
    );
    return {
      ...res2,
      summary: `款号 ${prod.sku || '-'} · 基础价 ¥${money(prod.price)} · 阶梯价：${tierText} · 当前库存 ${stock} 件　|　相关订单 ${res2.rows.length} 张`
    };
  }

  // 4) 应收 / 应付（必须排在「逾期」前面，否则「应收逾期」会被当成订单逾期）
  if (/应收|回款|开票|发票/.test(q) || /应付|付款|欠供应商/.test(q)) {
    const isAp = /应付|付款|欠供应商/.test(q) && !/应收|回款/.test(q);
    const table = isAp ? 'ap_invoices' : 'ar_invoices';
    const partnerCol = isAp ? 'supplier_name' : 'customer_name';
    const overdueOnly = /逾期|超期/.test(q);
    const where = overdueOnly
      ? `status IN ('open','partial') AND due_date IS NOT NULL AND due_date < '${t}'`
      : "status IN ('open','partial')";
    const rows = db.prepare(
      `SELECT bill_no, ${partnerCol} AS partner, amount, paid_amount,
         ROUND(amount - paid_amount, 2) AS unpaid, due_date, status
       FROM ${table} WHERE ${where} ORDER BY due_date ASC LIMIT 50`
    ).all();
    const sum = round2(rows.reduce((s2, r) => s2 + Number(r.unpaid || 0), 0));
    return {
      intent: isAp ? 'ap' : 'ar',
      title: isAp ? (overdueOnly ? '应付逾期未付' : '应付未结清') : (overdueOnly ? '应收逾期未收' : '应收未结清'),
      summary: `共 ${rows.length} 张，合计未结 ¥${money(sum)}`,
      columns: [COL('bill_no', '发票号'), COL('partner', isAp ? '供应商' : '客户'),
        COL('amount', '金额', 'right'), COL('paid_amount', '已结', 'right'),
        COL('unpaid', '未结', 'right'), COL('due_date', '账期')],
      rows,
      links: [{ text: '去往来账', to: '/finance' }]
    };
  }

  // 5) 逾期
  if (/逾期|超期|延迟/.test(q)) {
    return ordersOf(
      `o.delivery_date IS NOT NULL AND o.delivery_date < '${t}' AND o.status NOT IN ('shipped','closed','cancelled')`,
      [], '逾期未发订单');
  }

  // 5) 库存 / 缺货
  if (/缺货/.test(q)) {
    const s = shortageStats();
    return {
      intent: 'shortage',
      title: '美仓缺货（待发货订单）',
      summary: `${s.orders} 张订单缺货，合计缺 ${s.pieces} 件`,
      columns: [COL('order_no', '订单号'), COL('lack', '缺口件数', 'right')],
      rows: s.detail,
      links: [{ text: '去美仓发货', to: '/us-ship' }, { text: '去库存管理', to: '/inventory' }]
    };
  }
  if (/库存/.test(q)) {
    const cn = round2(db.prepare("SELECT COALESCE(SUM(qty),0) q FROM stock_items WHERE warehouse='cn'").get().q);
    const us = round2(db.prepare("SELECT COALESCE(SUM(qty),0) q FROM stock_items WHERE warehouse='us'").get().q);
    const rows = db.prepare(
      'SELECT warehouse, style_no, product_name, color, size, qty FROM stock_items ORDER BY qty DESC LIMIT 50'
    ).all();
    return {
      intent: 'stock',
      title: '库存概况',
      summary: `生产仓 ${cn} 件，美仓 ${us} 件，合计 ${round2(cn + us)} 件（下表按数量降序，最多 50 条）`,
      columns: [COL('warehouse_label', '仓库'), COL('style_no', '款号'), COL('product_name', '产品'), COL('color', '颜色'),
        COL('size', '尺码'), COL('qty', '数量', 'right')],
      rows: rows.map((r) => ({ ...r, warehouse_label: r.warehouse === 'cn' ? '生产仓' : '美仓' })),
      links: [{ text: '去库存管理', to: '/inventory' }]
    };
  }

  // 6) 工资 / 薪酬
  if (/工资|薪酬|薪资|个税/.test(q)) {
    const p = (q.match(/(\d{4})-(\d{1,2})/) || [])[0] || month;
    const rows = db.prepare(
      'SELECT employee_name, department, base_salary, gross_pay, social_insurance, tax, net_pay, status FROM payrolls WHERE period = ? ORDER BY net_pay DESC'
    ).all(p);
    const net = round2(rows.reduce((s, r) => s + Number(r.net_pay || 0), 0));
    return {
      intent: 'payroll',
      title: `${p} 工资单`,
      summary: rows.length ? `${rows.length} 人，实发合计 ¥${money(net)}` : `${p} 还没有工资单`,
      columns: [COL('employee_name', '姓名'), COL('department', '部门'), COL('gross_pay', '应发', 'right'),
        COL('social_insurance', '社保', 'right'), COL('tax', '个税', 'right'), COL('net_pay', '实发', 'right')],
      rows,
      links: [{ text: '去薪酬核算', to: '/payrolls' }]
    };
  }

  // 7) 费用
  if (/费用|支出|开销/.test(q)) {
    const p = (q.match(/(\d{4})-(\d{1,2})/) || [])[0] || month;
    const rows = db.prepare(
      "SELECT category, COALESCE(SUM(amount),0) amount FROM admin_expenses WHERE substr(expense_date,1,7)=? GROUP BY category ORDER BY amount DESC"
    ).all(p);
    const total = round2(rows.reduce((s, r) => s + Number(r.amount || 0), 0));
    return {
      intent: 'expense',
      title: `${p} 行政费用`,
      summary: `合计 ¥${money(total)}`,
      columns: [COL('category', '类别'), COL('amount', '金额', 'right')],
      rows,
      links: [{ text: '去行政费用', to: '/admin-expenses' }]
    };
  }

  // 8) 报价
  if (/报价|报价单|quotation/i.test(q)) {
    const rows = db.prepare(
      `SELECT q.quote_no, c.name AS customer_name, q.status, q.total_usd, q.valid_until
       FROM quotations q LEFT JOIN customers c ON c.id=q.customer_id ORDER BY q.id DESC LIMIT 30`
    ).all();
    const QS = { draft: '草稿', sent: '已发出', accepted: '已接受', rejected: '已拒绝', converted: '已转订单' };
    return {
      intent: 'quotations',
      title: '报价单',
      summary: `共 ${rows.length} 张，美元合计 $${money(rows.reduce((s, r) => s + Number(r.total_usd || 0), 0))}`,
      columns: [COL('quote_no', '单号'), COL('customer_name', '客户'), COL('status_label', '状态'),
        COL('total_usd', '金额USD', 'right'), COL('valid_until', '有效期至')],
      rows: rows.map((r) => ({ ...r, status_label: QS[r.status] || r.status })),
      links: [{ text: '去报价单', to: '/quotations' }]
    };
  }

  // 9) 审批 / 待办
  if (/审批|待办|待处理/.test(q)) {
    const tech = Number(db.prepare("SELECT COUNT(*) c FROM tech_packs WHERE status='draft'").get().c);
    const cost = Number(db.prepare("SELECT COUNT(*) c FROM cost_sheets WHERE status='pending'").get().c);
    const dispatch = Number(db.prepare(
      "SELECT COUNT(*) c FROM orders o WHERE o.status='finance' AND EXISTS (SELECT 1 FROM cost_sheets cs WHERE cs.order_id=o.id AND cs.status='approved')"
    ).get().c);
    return {
      intent: 'approvals',
      title: '待办事项',
      summary: `待技术确认 ${tech} 份，待财务审核 ${cost} 张，待分单 ${dispatch} 张`,
      columns: [COL('item', '事项'), COL('count', '数量', 'right')],
      rows: [{ item: '开发单待技术确认', count: tech }, { item: '成本单待财务审核', count: cost }, { item: '订单待分单', count: dispatch }],
      links: [{ text: '去审批中心', to: '/approvals' }]
    };
  }

  // 10) 生产
  if (/生产|在产|工序|报工/.test(q)) {
    const rows = db.prepare(
      `SELECT o.order_no, c.name AS customer_name, o.status, o.delivery_date
       FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
       WHERE o.status IN ('assigned','production') ORDER BY o.delivery_date LIMIT 50`
    ).all();
    const nodes = Number(db.prepare(
      "SELECT COUNT(*) c FROM order_nodes WHERE status != 'done' AND plan_date IS NOT NULL AND plan_date < ?"
    ).get(t).c);
    return {
      intent: 'production',
      title: '在产订单',
      summary: `在产 ${rows.length} 单，另有 ${nodes} 道工序超过计划完成日期`,
      columns: [COL('order_no', '订单号'), COL('customer_name', '客户'), COL('status_label', '状态'), COL('delivery_date', '交期')],
      rows: rows.map((r) => ({ ...r, status_label: STATUS_LABELS[r.status] || r.status })),
      links: [{ text: '去生产管理', to: '/production' }]
    };
  }

  // 11) 资产 / 年检
  if (/资产|设备|年检|折旧/.test(q)) {
    const rows = db.prepare(
      "SELECT name, category, original_value, purchase_date, plate_no, next_check_date, status FROM assets WHERE status != 'scrapped' ORDER BY next_check_date LIMIT 50"
    ).all();
    return {
      intent: 'assets',
      title: '固定资产',
      summary: `在用/闲置 ${rows.length} 项，原值合计 ¥${money(rows.reduce((s, r) => s + Number(r.original_value || 0), 0))}`,
      columns: [COL('name', '名称'), COL('category', '类别'), COL('original_value', '原值', 'right'),
        COL('plate_no', '车牌'), COL('next_check_date', '年检到期')],
      rows,
      links: [{ text: '去固定资产', to: '/assets' }]
    };
  }

  // 12) 订单（带时间/状态限定）
  if (/订单/.test(q)) {
    if (/上月/.test(q)) {
      const p = periodShift(month, -1);
      return ordersOf("substr(o.created_at,1,7) = ?", [p], `${p} 订单`);
    }
    if (/今年/.test(q)) {
      return ordersOf('substr(o.created_at,1,4) = ?', [String(new Date().getFullYear())], `${new Date().getFullYear()} 年订单`);
    }
    return ordersOf('substr(o.created_at,1,7) = ?', [month], `${month} 订单`);
  }

  // 13) 兜底：全系统概况
  const total = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(total_usd),0) u FROM orders').get();
  const monthAgg = db.prepare(
    'SELECT COUNT(*) c, COALESCE(SUM(total_usd),0) u FROM orders WHERE substr(created_at,1,7)=?'
  ).get(month);
  return {
    intent: 'overview',
    title: '系统概况',
    summary: `累计订单 ${total.c} 单（$${money(total.u)}），本月 ${monthAgg.c} 单（$${money(monthAgg.u)}）。可以这样问我：SO202610260001 / 逾期订单 / 美仓缺货 / 库存 / 本月工资 / 行政费用 / 报价单 / 在产订单 / 固定资产。`,
    columns: [COL('item', '指标'), COL('value', '数值', 'right')],
    rows: [
      { item: '累计订单数', value: Number(total.c) },
      { item: '本月订单数', value: Number(monthAgg.c) },
      { item: '本月订单金额(USD)', value: money(monthAgg.u) }
    ],
    links: [{ text: '看经营解读', to: '/assistant' }, { text: '去订单列表', to: '/orders' }]
  };
}

router.post('/query', authRequired, wrap(async (req, res) => {
  const q = (req.body || {}).q;
  if (!q || !String(q).trim()) return fail(res, 400, '请输入要查询的内容');
  const result = answerQuery(q);
  return ok(res, { ...result, q: String(q).trim() });
}));

module.exports = router;
module.exports.answerQuery = answerQuery;
