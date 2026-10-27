/**
 * 营销与素材演示数据（M16）
 * ------------------------------------------------------------
 * 造数据围绕四个页面各给一组「有话说」的样例：
 *
 *   上新日历：按期上新的、延期上新的、计划日已过还卡在资料确认的（红色逾期）、
 *             定制单卡在技术未确认的（门槛不过，说明上新不是营销一个人说了算）
 *   素材库：  公开素材、客户专属花型、AI 生成待审、30 天内到期、已过期
 *   活动投放：人民币活动已超预算（15000 预算花 16500）、美金活动单独一套账不混加；
 *             归因里埋了 3 类「假增长」——未确认订单、集团内部转单、渠道对不上
 *   运营复盘：缺货断码已逾期、技术延期在做、客诉已闭环
 *
 * 用法：node scripts/seed-mkt-demo.js --reset
 */
const { db } = require('../src/db');
const M = require('../src/services/mkt');
const { localNow, localDate } = require('../src/services/sla');

const TAG = 'MKTDEMO';
const RESET = process.argv.includes('--reset');
const OP = '演示脚本';
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function addDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + Number(n || 0));
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}

function reset() {
  const taskIds = db.prepare('SELECT id FROM mkt_tasks WHERE remark LIKE ?').all(`%${TAG}%`).map((r) => r.id);
  const campIds = db.prepare('SELECT id FROM mkt_campaigns WHERE note LIKE ?').all(`%${TAG}%`).map((r) => r.id);
  const revIds = db.prepare('SELECT id FROM mkt_reviews WHERE demo_tag=?').all(TAG).map((r) => r.id);
  const orderIds = db.prepare("SELECT id FROM orders WHERE order_no LIKE 'MKDEMO%'").all().map((r) => r.id);

  taskIds.forEach((id) => {
    db.prepare('DELETE FROM mkt_task_assets WHERE task_id=?').run(id);
    db.prepare('DELETE FROM mkt_task_steps WHERE task_id=?').run(id);
    db.prepare('DELETE FROM mkt_task_logs WHERE task_id=?').run(id);
    db.prepare('DELETE FROM mkt_tasks WHERE id=?').run(id);
  });
  campIds.forEach((id) => {
    db.prepare('DELETE FROM mkt_campaign_bills WHERE campaign_id=?').run(id);
    db.prepare('DELETE FROM mkt_campaigns WHERE id=?').run(id);
  });
  revIds.forEach((id) => {
    db.prepare('DELETE FROM mkt_review_actions WHERE review_id=?').run(id);
    db.prepare('DELETE FROM mkt_reviews WHERE id=?').run(id);
  });
  orderIds.forEach((id) => {
    db.prepare('DELETE FROM order_items WHERE order_id=?').run(id);
    db.prepare('DELETE FROM order_logs WHERE order_id=?').run(id);
    db.prepare('DELETE FROM cost_objects WHERE order_id=?').run(id);
    db.prepare('DELETE FROM orders WHERE id=?').run(id);
  });
  db.prepare("DELETE FROM mkt_assets WHERE remark LIKE ?").run(`%${TAG}%`);
  db.prepare("DELETE FROM stock_items WHERE style_no LIKE 'MK-%'").run();
  db.prepare("DELETE FROM stock_ledger WHERE style_no LIKE 'MK-%'").run();
  db.prepare("DELETE FROM intercompany_parties WHERE note LIKE ?").run(`%${TAG}%`);
  db.prepare("DELETE FROM customers WHERE code LIKE 'MKTDEMO%'").run();
  return { tasks: taskIds.length, campaigns: campIds.length, reviews: revIds.length, orders: orderIds.length };
}

function ensureCustomer(code, name, level, companyId, t) {
  const old = db.prepare('SELECT id FROM customers WHERE code=?').get(code);
  if (old) return old.id;
  return db.prepare(
    'INSERT INTO customers (code,name,contact,phone,level,credit_limit,status,company_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(code, name, '演示联系人', '—', level, 500000, 'active', companyId, t, t).lastInsertRowid;
}

function main() {
  const t = localNow();
  const today = localDate();
  const HQ = db.prepare("SELECT id FROM companies WHERE type='headquarters' ORDER BY id LIMIT 1").get()?.id || 1;
  const BRANCH = db.prepare("SELECT id FROM companies WHERE type<>'headquarters' ORDER BY id LIMIT 1").get()?.id || HQ;
  const out = [];

  // ---------- 客户 ----------
  const cusA = ensureCustomer('MKTDEMO01', '杭州拾光服饰有限公司', 'A', HQ, t);
  const cusB = ensureCustomer('MKTDEMO02', '杭州拾光（专属花型客户）', 'A', HQ, t);
  const cusIn = ensureCustomer('MKTDEMO03', '跳色科技（义乌）分公司【集团内】', 'B', HQ, t);

  // 集团内部往来登记：用于演示「内部转单不算增长」
  if (!db.prepare("SELECT id FROM intercompany_parties WHERE note LIKE ?").get(`%${TAG}%`)) {
    db.prepare(
      `INSERT INTO intercompany_parties (company_id,counter_company_id,kind,ref_type,ref_id,ref_name,match_key,offset_account,status,note,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(HQ, BRANCH, 'customer', 'customer', cusIn, '跳色科技（义乌）分公司【集团内】',
      '跳色科技（义乌）分公司【集团内】', '1122', 'active', `${TAG} 内部往来`, t);
  }

  // ---------- 库存与订单（归因用） ----------
  const stock = [
    { style_no: 'MK-S001', product_name: '早秋针织开衫', color: '米白', size: 'M', qty: 120 },
    { style_no: 'MK-S002', product_name: '高腰阔腿裤', color: '黑', size: 'M', qty: 60 },
    { style_no: 'MK-C001', product_name: '定制提花连衣裙', color: '雾蓝', size: 'S', qty: 0 }
  ];
  stock.forEach((s) => {
    const old = db.prepare('SELECT id FROM stock_items WHERE warehouse=? AND style_no=? AND color=? AND size=?')
      .get('cn', s.style_no, s.color, s.size);
    if (old) {
      db.prepare('UPDATE stock_items SET qty=?, product_name=?, updated_at=? WHERE id=?')
        .run(s.qty, s.product_name, t, old.id);
      return;
    }
    db.prepare('INSERT INTO stock_items (warehouse,style_no,product_name,color,size,qty,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run('cn', s.style_no, s.product_name, s.color, s.size, s.qty, t);
    db.prepare('INSERT INTO stock_ledger (warehouse,style_no,product_name,color,size,type,qty,ref_type,remark,operator,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('cn', s.style_no, s.product_name, s.color, s.size, 'in', s.qty, 'manual', `${TAG} 演示期初`, OP, t);
  });

  const mkOrder = (no, customerId, status, amountUsd, dateStr, shop) => {
    const rate = 7.1;
    const id = db.prepare(
      `INSERT INTO orders (order_no,type,customer_id,status,rate,total_usd,total_amount,currency,style_name,
         order_date,shop_name,created_by,created_at,updated_at,company_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(no, 'stock', customerId, status, rate, r2(amountUsd), r2(amountUsd * rate), 'USD',
      '演示款', dateStr, shop, null, t, t, HQ).lastInsertRowid;
    return id;
  };

  const shopMain = '天猫旗舰店';
  const o1 = mkOrder('MKDEMO0001', cusA, 'shipped', 4200, addDays(today, -15), shopMain);
  const o2 = mkOrder('MKDEMO0002', cusA, 'closed', 2600, addDays(today, -9), shopMain);
  const o3 = mkOrder('MKDEMO0003', cusA, 'instock', 1500, addDays(today, -4), shopMain);
  // 三类不该算增长的
  const oDraft = mkOrder('MKDEMO0004', cusA, 'draft', 9000, addDays(today, -6), shopMain);          // 未确认
  const oInternal = mkOrder('MKDEMO0005', cusIn, 'shipped', 7800, addDays(today, -8), shopMain);    // 内部转单
  const oOtherShop = mkOrder('MKDEMO0006', cusA, 'shipped', 3300, addDays(today, -12), '抖音小店'); // 渠道不符
  // 归因窗口外的
  const oOutside = mkOrder('MKDEMO0007', cusA, 'shipped', 5000, addDays(today, -60), shopMain);

  // 成本对象：给算得清的几单补毛利（毛利 ≠ 净利润，页面会写清楚）
  [[o1, 12000, 8600], [o2, 8200, 5400], [o3, 4600, 3100]].forEach(([oid, rev, cost], i) => {
    if (db.prepare('SELECT id FROM cost_objects WHERE order_id=?').get(oid)) return;
    db.prepare(
      `INSERT INTO cost_objects (cost_no,order_id,order_no,customer_name,style_no,qty,currency,rate,
         revenue_orig,revenue_cny,budget_cost,actual_cost,sold_qty,sold_cost,sold_revenue,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(`MKCOST-A${i}`, oid, `MKDEMO000${i + 1}`, '演示客户', 'MK-S001', 100, 'CNY', 1,
      r2(rev / 7.1), rev, cost, cost, 100, cost, rev, 'open', t, t);
  });

  // ---------- 素材 ----------
  const mkAsset = (b) => M.createAsset({ ...b, remark: `${b.remark || ''} ${TAG}`.trim() }, OP);

  const aPublic = mkAsset({
    kind: 'image', title: 'MK-S001 早秋针织开衫 主图 V2', version: 'IMG-V2',
    style_no: 'MK-S001', product_name: '早秋针织开衫', tech_version: 'TECH-V2',
    scope: 'public', license_source: 'own', license_from: addDays(today, -90),
    license_to: addDays(today, 180), url: '/uploads/demo-mk-s001-main.jpg'
  });
  M.submitAsset(aPublic.id, OP);
  M.reviewAsset(aPublic.id, { pass: true, note: '版型与 TECH-V2 一致，可用' }, OP);

  const aDetail = mkAsset({
    kind: 'image', title: 'MK-S002 高腰阔腿裤 细节三图', version: 'IMG-V1',
    style_no: 'MK-S002', scope: 'channel', channels: '天猫旗舰店,抖音小店',
    license_source: 'own', license_from: addDays(today, -30), license_to: addDays(today, 12)
  });
  M.submitAsset(aDetail.id, OP);
  M.reviewAsset(aDetail.id, { pass: true, note: '自有拍摄，渠道授权到本月底' }, OP);

  const aExclusive = mkAsset({
    kind: 'pattern', title: '客户专属提花图案 PAT-V1', version: 'PAT-V1',
    style_no: 'MK-C001', product_name: '定制提花连衣裙', tech_version: 'TECH-V1',
    scope: 'exclusive', customer_id: cusB, license_source: 'customer',
    license_from: addDays(today, -20), license_to: addDays(today, 200)
  });
  M.submitAsset(aExclusive.id, OP);
  M.reviewAsset(aExclusive.id, { pass: true, note: '客户提供并书面授权本款使用' }, OP);

  const aOld = mkAsset({
    kind: 'image', title: 'MK-S002 旧版主图（已到期）', version: 'IMG-V0',
    style_no: 'MK-S002', scope: 'public', license_source: 'supplier',
    license_from: addDays(today, -400), license_to: addDays(today, -5)
  });
  M.submitAsset(aOld.id, OP);
  db.prepare("UPDATE mkt_assets SET status='approved', reviewed_by=?, reviewed_at=? WHERE id=?").run(OP, t, aOld.id);
  // 故意让它停在 approved，用来演示「读取时按到期算已过期」

  const aAi = mkAsset({
    kind: 'image', title: 'AI 生成场景图（待审）', version: 'IMG-AI1',
    style_no: 'MK-S001', tech_version: 'TECH-V2', scope: 'public', license_source: 'ai',
    license_from: today, license_to: addDays(today, 90)
  });

  // ---------- 上新任务 ----------
  const bind = (taskId, assetId, role) => M.bindAsset(taskId, { asset_id: assetId, role }, OP);

  // 1) 筹备中，3 天后上线（有素材，等审核资料）
  const t1 = M.createTask({
    title: 'MK-S001 早秋开衫 天猫首波', biz_type: 'stock', channel: shopMain, shop_name: shopMain,
    style_no: 'MK-S001', product_name: '早秋针织开衫', plan_launch_date: addDays(today, 3),
    owner: '运营-林夏', depends: '合规资料 / 可靠到仓', remark: `${TAG} 正常推进`
  }, OP);
  bind(t1.id, aPublic.id, 'main');
  M.advanceTask(t1.id, 'material', { note: '素材已交付，进入筹备' }, OP);

  // 2) 计划日已过 2 天还在资料确认（逾期红）
  const t2 = M.createTask({
    title: 'MK-S002 阔腿裤 抖音上新', biz_type: 'stock', channel: '抖音小店', shop_name: '抖音小店',
    style_no: 'MK-S002', product_name: '高腰阔腿裤', plan_launch_date: addDays(today, -2),
    owner: '运营-周舟', depends: '可靠到仓', remark: `${TAG} 逾期未上`
  }, OP);
  bind(t2.id, aDetail.id, 'main');
  M.advanceTask(t2.id, 'material', { note: '素材到位' }, OP);
  M.advanceTask(t2.id, 'ready', { note: '资料已确认，等仓里齐码' }, OP);

  // 3) 已上新（按期）
  const t3 = M.createTask({
    title: 'MK-S001 早秋开衫 抖音首波', biz_type: 'stock', channel: '抖音小店', shop_name: '抖音小店',
    style_no: 'MK-S001', product_name: '早秋针织开衫', plan_launch_date: addDays(today, -10),
    owner: '运营-周舟', remark: `${TAG} 按期上新`
  }, OP);
  bind(t3.id, aPublic.id, 'main');
  M.advanceTask(t3.id, 'material', {}, OP);
  M.advanceTask(t3.id, 'ready', {}, OP);
  M.advanceTask(t3.id, 'launched', { launch_date: addDays(today, -10), note: '按期上线' }, OP);

  // 4) 已上新（延期 4 天）
  const t4 = M.createTask({
    title: 'MK-S002 阔腿裤 天猫首波', biz_type: 'stock', channel: shopMain, shop_name: shopMain,
    style_no: 'MK-S002', product_name: '高腰阔腿裤', plan_launch_date: addDays(today, -15),
    owner: '运营-林夏', remark: `${TAG} 延期上新`
  }, OP);
  bind(t4.id, aDetail.id, 'main');
  M.advanceTask(t4.id, 'material', {}, OP);
  M.advanceTask(t4.id, 'ready', {}, OP);
  M.advanceTask(t4.id, 'launched', { launch_date: addDays(today, -11), note: '等面料到仓，晚了 4 天' }, OP);

  // 5) 定制单卡在技术未确认（门槛演示）
  const t5 = M.createTask({
    title: 'MK-C001 定制提花连衣裙 客户专属上新', biz_type: 'custom', channel: shopMain, shop_name: shopMain,
    style_no: 'MK-C001', product_name: '定制提花连衣裙', customer_id: cusB,
    plan_launch_date: addDays(today, 6), owner: '运营-林夏',
    depends: '技术确认 / 客户素材授权', remark: `${TAG} 卡技术`
  }, OP);
  bind(t5.id, aExclusive.id, 'main');
  M.advanceTask(t5.id, 'material', {}, OP);
  M.advanceTask(t5.id, 'ready', {}, OP);
  db.prepare('UPDATE mkt_tasks SET blocker=? WHERE id=?').run('开发单未确认，技术说面料克重还要再确认一版', t5.id);

  // 6) 已上新已复盘
  const t6 = M.createTask({
    title: 'MK-S001 早秋开衫 微信小店', biz_type: 'stock', channel: '微信小店', shop_name: '微信小店',
    style_no: 'MK-S001', plan_launch_date: addDays(today, -25), owner: '运营-周舟',
    remark: `${TAG} 已复盘`
  }, OP);
  bind(t6.id, aPublic.id, 'main');
  M.advanceTask(t6.id, 'material', {}, OP);
  M.advanceTask(t6.id, 'ready', {}, OP);
  M.advanceTask(t6.id, 'launched', { launch_date: addDays(today, -24) }, OP);
  M.advanceTask(t6.id, 'reviewed', { note: '上新 3 天售罄，复购待观察' }, OP);

  // ---------- 活动 ----------
  const c1 = M.createCampaign({
    name: '天猫早秋上新投放', channel: shopMain, shop_name: shopMain, currency: 'CNY',
    budget_amount: 15000, start_date: addDays(today, -20), end_date: addDays(today, -2),
    attribution_days: 7, owner: '运营-林夏', note: `${TAG} 已超预算的样例`
  }, OP);
  M.approveCampaign(c1.id, { note: '按 1.5 万执行' }, '财务-陈默');
  M.advanceCampaign(c1.id, 'running', {}, OP);
  M.addBill(c1.id, { bill_date: addDays(today, -14), amount: 9000, currency: 'CNY', vendor: '阿里妈妈', ref_no: 'MM-20261001', source: 'ads', note: `${TAG} 首期` }, OP);
  M.addBill(c1.id, { bill_date: addDays(today, -5), amount: 7500, currency: 'CNY', vendor: '杭州星禾传媒', ref_no: 'XH-20261012', source: 'agency', note: `${TAG} 达人合作` }, OP);

  const c2 = M.createCampaign({
    name: 'US Etsy 秋季测试投放', channel: 'Etsy', shop_name: 'Etsy', currency: 'USD',
    budget_amount: 3000, start_date: addDays(today, 5), end_date: addDays(today, 35),
    attribution_days: 14, owner: '零售运营-Tom', note: `${TAG} 美金活动，不与人民币相加`
  }, OP);
  M.approveCampaign(c2.id, { note: '小额测试，先看点击成本' }, '财务-陈默');

  // 把任务挂到活动上
  db.prepare('UPDATE mkt_tasks SET campaign_id=? WHERE id IN (?,?)').run(c1.id, t1.id, t4.id);

  // ---------- 复盘 ----------
  const rv1 = M.createReview({
    period: today.slice(0, 7), topic: 'MK-S002 阔腿裤断码，上新首周缺 M/L',
    category: 'shortage', evidence: 'MKDEMO0004 / 仓内 M 码 0 件，客服 12 单催发',
    source_type: 'style', source_id: null, owner: '运营-林夏',
    findings: '缺货主因是首单备货按历史均码比例，实际 M/L 占 68%', due_date: addDays(today, 5)
  }, OP);
  M.addReviewAction(rv1.id, { action: '把 M/L 备货比例从 40% 提到 65%，下批执行', owner: '供应链-何工', due_date: addDays(today, 2) }, OP);
  M.addReviewAction(rv1.id, { action: '客服话术加缺码优先推替代款', owner: '客服-小柯', due_date: addDays(today, -1) }, OP);
  db.prepare('UPDATE mkt_reviews SET demo_tag=? WHERE id=?').run(TAG, rv1.id);
  M.advanceReview(rv1.id, 'open', { owner: '运营-林夏' }, OP);

  const rv2 = M.createReview({
    period: today.slice(0, 7), topic: 'MK-C001 开发单延期 5 天，影响客户专属上新',
    category: 'tech_delay', evidence: '开发单 TECH-V1 仍在 craft 阶段，面辅料未确认',
    source_type: 'style', owner: '运营-林夏',
    findings: '面料克重反复，客户改了两版', due_date: addDays(today, 8)
  }, OP);
  M.addReviewAction(rv2.id, { action: '面辅料确认提前到大货下单前 3 天，卡点写进评审表', owner: '技术-许工', due_date: addDays(today, 6) }, OP);
  db.prepare('UPDATE mkt_reviews SET demo_tag=? WHERE id=?').run(TAG, rv2.id);
  M.advanceReview(rv2.id, 'open', { owner: '运营-林夏' }, OP);
  M.advanceReview(rv2.id, 'doing', {}, OP);

  const rv3 = M.createReview({
    period: today.slice(0, 7), topic: '抖音首波上新图与实物色差，3 单退货',
    category: 'complaint', evidence: '售后工单 SH-20261012-018 / 退货原因「颜色偏灰」',
    source_type: 'manual', owner: '运营-周舟',
    findings: '拍摄用了暖光，实物是冷调米白', due_date: today
  }, OP);
  const a1 = M.addReviewAction(rv3.id, { action: '拍摄标准加色卡对比，主图统一 5500K', owner: '设计-阿岚', due_date: addDays(today, -3) }, OP);
  M.setReviewAction(rv3.id, a1.actions[0].id, { status: 'done', result: '已出拍摄规范 V1，本周新拍全部带色卡' }, OP);
  db.prepare('UPDATE mkt_reviews SET demo_tag=? WHERE id=?').run(TAG, rv3.id);
  M.advanceReview(rv3.id, 'open', { owner: '运营-周舟' }, OP);
  M.advanceReview(rv3.id, 'doing', {}, OP);
  M.advanceReview(rv3.id, 'done', {}, OP);

  out.push(`任务 6 条（含 1 条逾期、1 条卡技术）`);
  out.push(`素材 5 个（含 1 个 AI 待审、1 个 30 天内到期、1 个已过期）`);
  out.push(`活动 2 个（CNY 超预算 / USD 独立）`);
  out.push(`复盘 3 个（待行动 / 执行中 / 已关闭）`);
  out.push(`归因样例订单 7 张（3 张计入、1 未确认、1 内部转单、1 渠道不符、1 超窗）`);
  return out;
}

if (RESET) {
  const r = reset();
  console.log('[mkt-demo] reset', JSON.stringify(r));
}
const lines = main();
console.log('[mkt-demo] 写入完成：');
lines.forEach((l) => console.log('  - ' + l));
console.log(`[mkt-demo] 基准日 ${localDate()}`);
