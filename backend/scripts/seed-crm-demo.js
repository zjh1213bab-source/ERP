/**
 * 销售与客户演示数据（M03：线索商机 / 周期预警 / 价值排行 / 目标提成 / 客户交接）
 * ------------------------------------------------------------
 * 这个脚本刻意造了下面这些「不好看但是真实」的情形，用来演示规则不是装饰：
 *   · 一条线索响应超期（没人接过）→ 在公海，可被认领
 *   · 一条线索跟进逾期（下一次动作日期已过）→ 列表标红
 *   · 一条线索与另一条重复 → 合并（只合并线索，客户档案不自动并）
 *   · 一个客户周期已知且已超期 11 天（宽限 0 → 直接升级）
 *   · 一个客户超期 10 天但宽限 14 天（超期但未升级，两种口径分开）
 *   · 一个客户周期未知（写了原因、责任人、复核日）、一个季节性、一个一次性
 *   · 一个集团内部客户下了 40 万单 → 不计销售业绩、不计提成、不刷新复购
 *   · 一个客户成本未结转 → 不进毛利榜（毛利待核）
 *   · 一条已批准提成（含薪酬来源唯一）、一条草稿（带退款调整）、一条待复核
 *   · 一张待接收的客户交接单、一张草稿交接单
 *
 * 幂等：--reset 先按演示标记清掉上一批，再重建，连跑两次结果一致。
 */
const { db } = require('../src/db');
const { localDate, localNow } = require('../src/services/sla');
const C = require('../src/services/crm');

const TAG = 'CRMDEMO';
const TODAY = localDate();

function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const t = new Date(y, m - 1, d);
  t.setDate(t.getDate() + Number(n || 0));
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
/** 往前第 n 个月（返回 YYYY-MM） */
function monthAgo(n) {
  const d = new Date(TODAY.slice(0, 4), Number(TODAY.slice(5, 7)) - 1 - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const M0 = monthAgo(0);
const M1 = monthAgo(1);
const OP = { name: '销售小王', username: 'sales01', role: 'sales', id: 2 };
const SUP = { name: '销售总监-李静', role: 'sales', id: 0 };
const FIN = { name: '财务-钱会计', username: 'fin01', role: 'finance', id: 7 };

/** ==================== 清理 ==================== */
function reset() {
  const out = {};
  out.comm_sources = db.prepare(
    'DELETE FROM commission_sources WHERE commission_id IN (SELECT id FROM commissions WHERE demo_tag=?)'
  ).run(TAG).changes;
  out.commissions = db.prepare('DELETE FROM commissions WHERE demo_tag=?').run(TAG).changes;
  out.rules = db.prepare('DELETE FROM commission_rules WHERE demo_tag=?').run(TAG).changes;
  out.target_items = db.prepare(
    'DELETE FROM sales_target_items WHERE target_id IN (SELECT id FROM sales_targets WHERE demo_tag=?)'
  ).run(TAG).changes;
  out.targets = db.prepare('DELETE FROM sales_targets WHERE demo_tag=?').run(TAG).changes;
  out.handovers = db.prepare('DELETE FROM crm_handovers WHERE demo_tag=?').run(TAG).changes;
  // 周期与回访是服务层写的，可能没带演示标记 → 按「演示客户 + 孤儿行」一起清
  out.followups = db.prepare(`DELETE FROM crm_followups
    WHERE demo_tag=? OR customer_id IN (SELECT id FROM customers WHERE code LIKE 'CRMDEMO%')
       OR customer_id NOT IN (SELECT id FROM customers)`).run(TAG).changes;
  out.lead_logs = db.prepare(
    'DELETE FROM crm_lead_logs WHERE lead_id IN (SELECT id FROM crm_leads WHERE demo_tag=?)'
  ).run(TAG).changes;
  out.leads = db.prepare('DELETE FROM crm_leads WHERE demo_tag=?').run(TAG).changes;
  out.cycle_logs = db.prepare(`DELETE FROM crm_cycle_logs
    WHERE customer_id IN (SELECT id FROM customers WHERE code LIKE 'CRMDEMO%')
       OR customer_id NOT IN (SELECT id FROM customers)`).run().changes;
  out.orphan_lead_logs = db.prepare('DELETE FROM crm_lead_logs WHERE lead_id NOT IN (SELECT id FROM crm_leads)').run().changes;
  out.cycles = db.prepare(`DELETE FROM crm_customer_cycles
    WHERE demo_tag=? OR customer_id IN (SELECT id FROM customers WHERE code LIKE 'CRMDEMO%')
       OR customer_id NOT IN (SELECT id FROM customers)`).run(TAG).changes;

  const ids = db.prepare('SELECT id FROM customers WHERE code LIKE ?').all('CRMDEMO%').map((r) => r.id);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    // 先删引用客户的业务数据，再删客户（顺序反了会留下挂空客户的单据）
    out.cost_objects = db.prepare(`DELETE FROM cost_objects WHERE order_id IN (SELECT id FROM orders WHERE customer_id IN (${ph}))`).run(...ids).changes;
    out.order_items = db.prepare(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id IN (${ph}))`).run(...ids).changes;
    out.orders = db.prepare(`DELETE FROM orders WHERE customer_id IN (${ph})`).run(...ids).changes;
    out.ar = db.prepare(`DELETE FROM ar_invoices WHERE customer_id IN (${ph})`).run(...ids).changes;
    out.pay = db.prepare(`DELETE FROM payments WHERE partner_type='customer' AND partner_id IN (${ph})`).run(...ids).changes;
    out.returns = db.prepare(`DELETE FROM stock_returns WHERE return_no LIKE 'RT-CRMDEMO%'`).run().changes;
    out.icp = db.prepare('DELETE FROM intercompany_parties WHERE note LIKE ?').run(`%${TAG}%`).changes;
    out.customers = db.prepare(`DELETE FROM customers WHERE id IN (${ph})`).run(...ids).changes;
  }
  return out;
}

/** ==================== 造数 ==================== */
function run() {
  const out = { reset: reset() };
  const t = TODAY;

  const uWang = db.prepare("SELECT * FROM users WHERE username='sales01'").get() || { id: 2, name: '销售小王' };
  const uZhu = db.prepare("SELECT * FROM users WHERE username='13055709733'").get() || { id: 9, name: '朱佳豪' };

  /** ---------- 客户 ---------- */
  const mkCust = (code, name, owner, level) => {
    const info = db.prepare(`INSERT INTO customers (code,name,contact,phone,email,level,credit_limit,status,remark,created_at,updated_at,company_id,owner_user_id,owner_name)
      VALUES (?,?,?,?,?,?,?, 'active', ?, ?, ?, 1, ?, ?)`).run(
      code, name, null, null, null, level || 'B', 200000, TAG, localNow(), localNow(),
      owner.id, owner.name
    );
    return info.lastInsertRowid;
  };
  const c1 = mkCust('CRMDEMO01', 'Westline Apparel（洛杉矶）', uWang, 'A');
  const c2 = mkCust('CRMDEMO02', 'Nordic Textile AB（瑞典）', uWang, 'A');
  const c3 = mkCust('CRMDEMO03', 'Tokyo Mode Co., Ltd.', uZhu, 'B');
  const c4 = mkCust('CRMDEMO04', 'Dubai Fashion LLC', uZhu, 'B');
  const c5 = mkCust('CRMDEMO05', 'Chicago Denim Co.', uWang, 'C');
  const c6 = mkCust('CRMDEMO06', '跳色科技（义乌）分公司【集团内部】', uZhu, 'A');
  const c7 = mkCust('CRMDEMO07', 'Maple Leaf Sports（多伦多）', uWang, 'B');
  const c8 = mkCust('CRMDEMO08', 'Seoul Trend Co.', uZhu, 'B');
  // 内部客户：登记进内部往来，后面所有业绩口径都要把它剔掉
  db.prepare(`INSERT INTO intercompany_parties (company_id,counter_company_id,kind,ref_type,ref_id,ref_name,match_key,
      offset_account,status,note,created_at) VALUES (1,2,'customer','customer',?,?,?, '1122','active',?,?)`).run(
    c6, '跳色科技（义乌）分公司【集团内部】', '跳色科技（义乌）分公司【集团内部】', `${TAG} 内部往来`, localNow()
  );

  /** ---------- 订单（有效采购） ---------- */
  let seq = 0;
  const insOrder = (custId, daysAgo, cny, status) => {
    seq += 1;
    const no = `CRMDEMO${String(seq).padStart(4, '0')}`;
    const rate = 7.1;
    const d = addDays(t, -daysAgo);
    db.prepare(`INSERT INTO orders (order_no,type,customer_id,status,rate,total_usd,total_amount,currency,
        style_name,order_date,manager,created_by,created_at,updated_at,company_id)
      VALUES (?, 'custom', ?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?, 1)`).run(
      no, custId, status, rate, Math.round((cny / rate) * 100) / 100, cny,
      '演示款', d, null, 'seed', localNow(), localNow()
    );
    return db.prepare('SELECT * FROM orders WHERE order_no=?').get(no);
  };

  const o = {};
  o.c1a = insOrder(c1, 190, 120000, 'closed');
  o.c1b = insOrder(c1, 130, 140000, 'closed');
  o.c1c = insOrder(c1, 95, 150000, 'shipped');
  o.c1d = insOrder(c1, 56, 180000, 'production');   // 最近有效采购：56 天前
  o.c2a = insOrder(c2, 300, 90000, 'closed');
  o.c2b = insOrder(c2, 200, 110000, 'closed');
  o.c2c = insOrder(c2, 100, 130000, 'shipped');     // 100 天前
  o.c3a = insOrder(c3, 270, 70000, 'closed');
  o.c3b = insOrder(c3, 180, 80000, 'closed');
  o.c3c = insOrder(c3, 90, 95000, 'shipped');
  o.c3d = insOrder(c3, 30, 105000, 'instock');
  o.c4a = insOrder(c4, 150, 60000, 'shipped');
  o.c7a = insOrder(c7, 12, 130000, 'production');   // 本月：目标分子
  o.c8a = insOrder(c8, 6, 95000, 'assigned');       // 本月
  o.c6a = insOrder(c6, 10, 400000, 'shipped');       // 内部转单 40 万

  /** ---------- 开票（确认收入） ---------- */
  let inv = 0;
  const mkInv = (custId, period, amount, suffix) => {
    inv += 1;
    db.prepare(`INSERT INTO ar_invoices (bill_no,order_id,customer_id,customer_name,amount,paid_amount,due_date,
        status,source,currency,amount_orig,rate,company_id,created_at,updated_at)
      VALUES (?,?,?,?,?,0,?, 'open', 'order', 'CNY', ?, 7.1, 1, ?, ?)`).run(
      `CRMDEMO-INV${String(inv).padStart(3, '0')}`, null, custId,
      db.prepare('SELECT name FROM customers WHERE id=?').get(custId).name,
      amount, addDays(`${period}-28`, 30), amount, `${period}-15 10:00:00`, localNow()
    );
  };
  mkInv(c1, M1, 150000);
  mkInv(c1, M0, 90000);
  mkInv(c2, M1, 130000);
  mkInv(c3, M1, 95000);
  mkInv(c3, M0, 60000);
  mkInv(c4, M1, 60000);
  mkInv(c6, M1, 400000);
  mkInv(c7, M0, 130000);
  mkInv(c8, M0, 95000);

  /** ---------- 收款（提成基数） ---------- */
  let pn = 0;
  const mkPay = (custId, dateStr, amount, st) => {
    pn += 1;
    db.prepare(`INSERT INTO payments (pay_no,direction,partner_type,partner_id,partner_name,amount,method,pay_date,
        status,currency,amount_orig,rate,company_id,operator,created_at)
      VALUES (?,'in','customer',?,?,?,'transfer',?,?, 'CNY', ?, 7.1, 1, 'seed', ?)`).run(
      `CRMDEMO-PAY${String(pn).padStart(3, '0')}`, custId,
      db.prepare('SELECT name FROM customers WHERE id=?').get(custId).name,
      amount, dateStr, st || 'confirmed', amount, localNow()
    );
    return db.prepare('SELECT * FROM payments WHERE pay_no=?').get(`CRMDEMO-PAY${String(pn).padStart(3, '0')}`);
  };
  mkPay(c1, `${M1}-12`, 120000);
  mkPay(c1, `${M0}-08`, 80000);
  mkPay(c2, `${M1}-20`, 100000);
  mkPay(c3, `${M1}-22`, 70000);
  mkPay(c4, `${M1}-25`, 40000);
  mkPay(c6, `${M1}-18`, 300000);            // 内部收款：不计提成
  mkPay(c7, `${M0}-20`, 100000);
  mkPay(c8, `${M0}-24`, 60000);

  /** ---------- 成本对象（毛利） ---------- */
  let cn = 0;
  const mkCost = (order, revenue, cost) => {
    cn += 1;
    const cname = db.prepare('SELECT name FROM customers WHERE id=?').get(order.customer_id).name;
    db.prepare(`INSERT INTO cost_objects (cost_no,order_id,order_no,customer_name,style_no,qty,currency,rate,
        revenue_orig,revenue_cny,budget_cost,actual_cost,sold_qty,sold_cost,sold_revenue,status,created_at,updated_at)
      VALUES (?,?,?,?,?,1,'CNY',7.1,?,?,?,?,1,?,?, 'closed', ?, ?)`).run(
      `CRMDEMO-COST${String(cn).padStart(3, '0')}`, order.id, order.order_no, cname, '演示款',
      revenue, revenue, cost, cost, cost, revenue, localNow(), localNow()
    );
  };
  mkCost(o.c1c, 150000, 118000);   // 毛利 3.2 万
  mkCost(o.c1d, 180000, 140000);   // 4 万
  mkCost(o.c2c, 130000, 104000);   // 2.6 万
  mkCost(o.c3c, 95000, 75000);     // 2 万
  mkCost(o.c3d, 105000, 0);        // 成本未结转 → 毛利待核
  mkCost(o.c4a, 60000, 47000);     // 1.3 万
  mkCost(o.c7a, 130000, 101000);   // 2.9 万
  mkCost(o.c8a, 95000, 0);         // 成本未结转 → 毛利待核

  /** ---------- 客户退货（净交付扣减） ---------- */
  db.prepare(`INSERT INTO stock_returns (return_no,type,warehouse,order_id,order_no,partner_name,source_no,reason,
      status,qty_apply,qty_received,qty_good,qty_defect,qty_scrap,return_date,remark,created_by,created_at,updated_at)
    VALUES ('RT-CRMDEMO01','customer','us',?,?,?,?,'尺码偏差整批退回','received',40,40,0,0,0,?,?, 'seed', ?, ?)`).run(
    o.c1c.id, o.c1c.order_no, 'Westline Apparel（洛杉矶）', 'CRMDEMO-TRK001',
    addDays(t, -20), TAG, localNow(), localNow()
  );

  /** ---------- 线索与商机 ---------- */
  const L = {};
  L.pool = C.createLead({
    source: 'platform', source_ref: 'ALI-2026-1001', customer_name_raw: 'Sunrise Trading（新询盘）',
    contact: 'Amy', phone: '+1-213-555-0101', country: 'US', est_amount: 80000, est_currency: 'USD',
    next_action: '回复询价单并索要款式图'
  }, OP);
  db.prepare('UPDATE crm_leads SET demo_tag=?, response_due=?, created_at=? WHERE id=?')
    .run(TAG, addDays(t, -3), `${addDays(t, -3)} 09:12:00`, L.pool.id);   // 响应期限已过 → 超时

  L.hot = C.createLead({
    source: 'exhibition', customer_id: c1, customer_name_raw: 'Westline Apparel（洛杉矶）',
    contact: 'Mike', country: 'US', est_amount: 150000, est_currency: 'USD',
    owner_user_id: uWang.id, next_action: '寄 3 款样衣'
  }, OP);
  db.prepare('UPDATE crm_leads SET demo_tag=? WHERE id=?').run(TAG, L.hot.id);
  C.setLeadStage(L.hot.id, { to: 'qualifying', note: '客户确认要 2 款卫衣报价' }, OP);
  C.followLead(L.hot.id, {
    note: '客户看中 2 款卫衣，要报 FOB 上海价', evidence: '微信记录 2026-10-20 截图 #A17',
    next_action: '报 FOB 价并确认面料克重', next_action_date: addDays(t, -2)   // 逾期
  }, OP);

  L.sampling = C.createLead({
    source: 'referral', customer_id: c3, customer_name_raw: 'Tokyo Mode Co., Ltd.',
    contact: '佐藤', country: 'JP', est_amount: 60000, est_currency: 'USD',
    owner_user_id: uZhu.id, next_action: '等样衣确认'
  }, OP);
  db.prepare('UPDATE crm_leads SET demo_tag=? WHERE id=?').run(TAG, L.sampling.id);
  C.setLeadStage(L.sampling.id, { to: 'qualifying', note: '客户确认 300 件小单' }, OP);
  C.setLeadStage(L.sampling.id, { to: 'sampling', note: '已打白坯样' }, OP);

  L.dubai = C.createLead({
    source: 'website', customer_name_raw: 'Gulf Uniform Supply',
    contact: 'Hassan', country: 'AE', est_amount: 40000, est_currency: 'USD',
    owner_user_id: uZhu.id
  }, OP);
  db.prepare('UPDATE crm_leads SET demo_tag=? WHERE id=?').run(TAG, L.dubai.id);
  C.setLeadStage(L.dubai.id, { to: 'qualifying', note: '要穆斯林工作服，需确认面料' }, OP);
  C.setLeadStage(L.dubai.id, { to: 'lost', lost_reason: 'competitor', lost_note: '同行报价低 8%，客户转单' }, OP);

  L.won = C.createLead({
    source: 'manual', customer_id: c1, customer_name_raw: 'Westline Apparel（洛杉矶）',
    owner_user_id: uWang.id, est_amount: 180000, est_currency: 'USD'
  }, OP);
  db.prepare('UPDATE crm_leads SET demo_tag=? WHERE id=?').run(TAG, L.won.id);
  C.setLeadStage(L.won.id, { to: 'qualifying', note: '确认 4000 件' }, OP);
  C.setLeadStage(L.won.id, { to: 'won', order_id: o.c1d.id, note: '已转订单' }, OP);

  L.dup = C.createLead({
    source: 'platform', source_ref: 'ALI-2026-1002', customer_id: c5, customer_name_raw: 'Chicago Denim Co.',
    email: 'buy@chicagodenim.example', est_amount: 30000, est_currency: 'USD'
  }, OP);
  db.prepare('UPDATE crm_leads SET demo_tag=? WHERE id=?').run(TAG, L.dup.id);
  const leadDup2 = C.createLead({
    source: 'manual', customer_name_raw: 'Chicago Denim Co.',
    owner_user_id: uWang.id, est_amount: 30000, est_currency: 'USD'
  }, OP);
  db.prepare('UPDATE crm_leads SET demo_tag=? WHERE id=?').run(TAG, leadDup2.id);
  C.mergeLead(leadDup2.id, { into_id: L.dup.id }, OP);

  /** ---------- 客户周期 ---------- */
  // 周期是服务层写的，写完补演示标记（否则每次重放都会多一批孤儿周期）
  const cyc = (b) => {
    const r = C.upsertCycle(b, OP);
    db.prepare('UPDATE crm_customer_cycles SET demo_tag=? WHERE customer_id=?').run(TAG, b.customer_id);
    return r;
  };
  const W = cyc({ customer_id: c1, status: 'known', cycle_days: 45, basis: 'manual', reason: '客户每季一次，间隔 45 天左右', grace_days: 0, owner_user_id: uWang.id });
  cyc({ customer_id: c2, status: 'known', cycle_days: 90, basis: 'contract', reason: '年度框架协议，每 90 天补一次货', grace_days: 14, owner_user_id: uWang.id }, OP);
  cyc({ customer_id: c3, status: 'seasonal', reason: '3-4 月与 9-10 月两个采购季，其余月份不下单', grace_days: 7, owner_user_id: uZhu.id, review_date: addDays(t, 30) }, OP);
  cyc({ customer_id: c4, status: 'unknown', reason: '只下过一次试单，采购节奏还不清楚', owner_user_id: uZhu.id, review_date: addDays(t, 20) }, OP);
  cyc({ customer_id: c5, status: 'oneoff', reason: '活动一次性采购，不做复购预期', owner_user_id: uWang.id }, OP);
  cyc({ customer_id: c6, status: 'known', cycle_days: 30, basis: 'manual', reason: '集团内部调货，按月一次', grace_days: 5, owner_user_id: uZhu.id }, OP);
  cyc({ customer_id: c7, status: 'known', cycle_days: 60, basis: 'manual', reason: '两月补一次货，节奏稳定', grace_days: 5, owner_user_id: uWang.id }, OP);
  cyc({ customer_id: c8, status: 'known', cycle_days: 30, basis: 'contract', reason: '合同约定每月补货一次', grace_days: 3, owner_user_id: uZhu.id });
  C.refreshCycles(OP);

  // 回访：只留痕，不刷新采购日
  C.addFollowup({
    customer_id: c1, kind: 'cycle_due', contact_note: '发邮件问下一季款式方向，客户说月底给回复',
    result: 'replied', next_date: addDays(t, 5), evidence: '邮件 2026-10-18 #M-221'
  }, OP);
  C.addFollowup({
    customer_id: c2, kind: 'cycle_due', contact_note: '电话未接通，留了语音', result: 'no_answer',
    next_date: addDays(t, 2), evidence: '通话记录 2026-10-24'
  }, OP);

  /** ---------- 客户交接 ---------- */
  const h1 = C.createHandover({
    from_user_id: uWang.id, to_user_id: uZhu.id, reason: 'transfer',
    customer_ids: [c2, c5].join(','), note: '小王转岗做定制客户，北欧与芝加哥两家交给朱佳豪'
  }, OP);
  db.prepare('UPDATE crm_handovers SET demo_tag=? WHERE id=?').run(TAG, h1.id);
  C.setHandoverStatus(h1.id, { to: 'pending' }, OP);
  const h2 = C.createHandover({
    from_user_id: uWang.id, to_user_id: uZhu.id, reason: 'leave',
    customer_ids: [c1].join(','), note: '小王休假一个月，Westline 暂由朱佳豪跟'
  }, OP);
  db.prepare('UPDATE crm_handovers SET demo_tag=? WHERE id=?').run(TAG, h2.id);

  /** ---------- 销售目标（上月已批准） ---------- */
  const tgt = C.createTarget({
    period: M0, team: '外贸一部', currency: 'CNY',
    items: [
      { user_id: uWang.id, user_name: uWang.name || '销售小王', metric: 'amount', target_amount: 300000 },
      { user_id: uWang.id, user_name: uWang.name || '销售小王', metric: 'collection', target_amount: 200000 },
      { user_id: uZhu.id, user_name: uZhu.name || '朱佳豪', metric: 'amount', target_amount: 150000 },
      { user_id: uZhu.id, user_name: uZhu.name || '朱佳豪', metric: 'collection', target_amount: 100000 }
    ],
    note: '按上月实际与在手订单编制'
  }, SUP);
  db.prepare('UPDATE sales_targets SET demo_tag=? WHERE id=?').run(TAG, tgt.id);
  C.approveTarget(tgt.id, FIN);

  /** ---------- 提成规则 ---------- */
  const ruleA = C.createRule({
    name: '外贸回款提成（超额累进）', base_type: 'collection',
    tiers: [{ from: 0, to: 100000, rate: 1 }, { from: 100000, to: 300000, rate: 1.5 }, { from: 300000, to: null, rate: 2 }],
    deduct_refund: 1, effective_from: `${M1}-01`, note: '按已批准回款计提；退款与坏账单列调整'
  }, SUP);
  db.prepare('UPDATE commission_rules SET demo_tag=? WHERE id=?').run(TAG, ruleA.id);
  C.approveRule(ruleA.id, FIN);

  const ruleB = C.createRule({
    name: '毛利提成（试运行）', base_type: 'gross',
    tiers: [{ from: 0, to: null, rate: 3 }],
    effective_from: `${M0}-01`, note: '毛利口径待财务确认成本结转完整性后再批'
  }, SUP);
  db.prepare('UPDATE commission_rules SET demo_tag=? WHERE id=?').run(TAG, ruleB.id);

  /** ---------- 提成单 ---------- */
  // 已批准 + 已引薪酬
  const cm1 = C.createCommission({ period: M1, user_name: uWang.name || '销售小王', rule_id: ruleA.id, note: '9 月回款提成' }, OP);
  db.prepare('UPDATE commissions SET demo_tag=? WHERE id=?').run(TAG, cm1.id);
  C.setCommissionStatus(cm1.id, { to: 'reviewing' }, OP);
  C.setCommissionStatus(cm1.id, { to: 'approved' }, FIN);
  C.linkPayroll(cm1.id, { payroll_period: M1 }, FIN);

  // 草稿 + 退款调整
  const cm2 = C.createCommission({ period: M1, user_name: uZhu.name || '朱佳豪', rule_id: ruleA.id, note: '9 月回款提成（含退货调整）' }, OP);
  db.prepare('UPDATE commissions SET demo_tag=? WHERE id=?').run(TAG, cm2.id);
  const zhuPay = db.prepare(`SELECT p.pay_no FROM payments p JOIN customers c ON c.id=p.partner_id
    WHERE c.id=? AND substr(p.pay_date,1,7)=? ORDER BY p.id DESC LIMIT 1`).get(c3, M1);
  if (zhuPay) {
    try {
      // 调整的是「提成金额」而不是基数：退款 6,000 元按 1.5% 档折算 ≈ 90 元
      C.addAdjustment(cm2.id, {
        source_type: 'refund', source_no: zhuPay.pay_no, amount: 90,
        note: '客户退货 6,000 元 × 1.5% ≈ 90 元提成冲减（来源：客户退货单 RT-CRMDEMO01 同批）'
      }, OP);
    } catch (e) {
      out.adjust_skipped = e.message;
    }
  }

  // 待复核（不给批准，留给界面演示）
  const cm3 = C.createCommission({ period: M0, user_name: uWang.name || '销售小王', rule_id: ruleA.id, note: '本月回款提成（待财务复核）' }, OP);
  db.prepare('UPDATE commissions SET demo_tag=? WHERE id=?').run(TAG, cm3.id);
  C.setCommissionStatus(cm3.id, { to: 'reviewing' }, OP);

  out.ids = {
    customers: { c1, c2, c3, c4, c5, c6, c7, c8 },
    orders: Object.values(o).length,
    leads: Object.keys(L).length,
    handovers: [h1.id, h2.id],
    target: tgt.id,
    rules: [ruleA.id, ruleB.id],
    commissions: [cm1.id, cm2.id, cm3.id],
    cycle_c1_due: W && W.next_due_date
  };
  return out;
}

const doReset = process.argv.includes('--reset');
const result = doReset ? run() : run();
console.log(JSON.stringify(result, null, 1));
console.log(`\n[${TAG}] 演示数据就绪：今天 ${TODAY}，本期 ${M0}，上期 ${M1}`);
