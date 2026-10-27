/**
 * M24 客户营销与消息 —— 演示数据（幂等）
 * ============================================================
 * 造出这些场景，让人一眼看出规则在哪生效：
 *
 *   c1 Nordic Textile（欧洲）  站内 + 邮件（已核验）+ 微信（渠道未授权 → 降级）
 *   c2 Tokyo Mode（日本）      站内 + 邮件（已核验）
 *   c3 West Coast（美国）      只订阅订单，**营销已退订**（退订不删业务记录）
 *   c4 Shenzhen Trial（美西）  只有邮件且**未核验** → 发送时整条跳过
 *
 * 事件：
 *   · N24-DEMO-01 已发布且有可售 120 → 上新提醒真的发出去
 *   · N24-DEMO-02 已发布但可售 0    → 提醒停在等待（不触发）
 *   · N24-DEMO-03 还是草稿          → 提醒停在等待（说明未过发布审核）
 *   · 订单状态通知 / 营销摘要 / 周期补货提醒各一条
 *
 * 回执：一个已读、一个已送达、一个打开未读、一个发送失败待重试
 * 频控：c1 当天第 3 条营销被暂缓；c4 处于客户当地静默时段
 *
 * 用法：node scripts/seed-notify-demo.js --reset
 */
const { db } = require('../src/db');
const { localNow, localDate } = require('../src/services/sla');
const { hashPassword } = require('../src/auth/password');
const N = require('../src/services/notify');

const TAG = 'N24DEMO';
const RESET = process.argv.includes('--reset');
const OP = { name: `demo:${TAG}`, role: 'sales', demo_tag: TAG };
const APPROVER = { name: '财务-陈默', role: 'finance' };

const p2 = (n) => String(n).padStart(2, '0');
function addDays(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + Number(n || 0));
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
const today = () => localDate();

/* ---------------- 清场 ---------------- */
const out = {};
out.attributions = 0;
out.logs = 0;
out.outbox = 0;
out.events = 0;
out.alerts = 0;
out.subs = 0;
out.bindings = 0;
out.templates = 0;
out.followups = 0;
out.cycles = 0;
out.orders = 0;
out.inquiries = 0;
out.stock = 0;
out.products = 0;
out.accounts = 0;
out.mall_messages = 0;
out.customers = 0;

if (RESET) {
  const custIds = db.prepare("SELECT id FROM customers WHERE code LIKE 'N24DEMO%'").all().map((r) => r.id);
  const inCust = custIds.length ? `(${custIds.map(() => '?').join(',')})` : '(0)';
  const outIds = db.prepare(`SELECT id FROM msg_outbox WHERE demo_tag=? OR customer_id IN ${inCust}`)
    .all(TAG, ...custIds).map((r) => r.id);
  const inOut = outIds.length ? `(${outIds.map(() => '?').join(',')})` : '(0)';

  out.attributions = db.prepare(`DELETE FROM msg_attributions WHERE outbox_id IN ${inOut} OR customer_id IN ${inCust}`)
    .run(...outIds, ...custIds).changes;
  out.logs = db.prepare(`DELETE FROM msg_delivery_logs WHERE outbox_id IN ${inOut}`).run(...outIds).changes;
  out.outbox = db.prepare(`DELETE FROM msg_outbox WHERE demo_tag=? OR customer_id IN ${inCust}`)
    .run(TAG, ...custIds).changes;
  out.events = db.prepare("DELETE FROM msg_events WHERE demo_tag=? OR dedupe_key LIKE 'N24DEMO%'").run(TAG).changes;
  out.alerts = db.prepare(`DELETE FROM msg_arrival_alerts WHERE demo_tag=? OR customer_id IN ${inCust}`)
    .run(TAG, ...custIds).changes;
  out.subs = db.prepare(`DELETE FROM msg_subscriptions WHERE demo_tag=? OR customer_id IN ${inCust}`)
    .run(TAG, ...custIds).changes;
  out.bindings = db.prepare(`DELETE FROM msg_wechat_bindings WHERE demo_tag=? OR customer_id IN ${inCust}`)
    .run(TAG, ...custIds).changes;
  out.templates = db.prepare('DELETE FROM msg_templates WHERE demo_tag=?').run(TAG).changes;
  out.followups = db.prepare(`DELETE FROM crm_followups WHERE customer_id IN ${inCust} AND kind='cycle_due'`)
    .run(...custIds).changes;
  out.cycles = db.prepare(`DELETE FROM crm_customer_cycles WHERE demo_tag=? OR customer_id IN ${inCust}`)
    .run(TAG, ...custIds).changes;
  out.orders = db.prepare("DELETE FROM orders WHERE order_no LIKE 'N24DEMO%'").run().changes;
  out.inquiries = db.prepare(`DELETE FROM mall_inquiry_items WHERE inquiry_id IN
    (SELECT id FROM mall_inquiries WHERE inquiry_no LIKE 'N24DEMO%')`).run().changes
    + db.prepare("DELETE FROM mall_inquiries WHERE inquiry_no LIKE 'N24DEMO%'").run().changes;
  out.stock = db.prepare("DELETE FROM stock_ledger WHERE style_no LIKE 'N24-DEMO%'").run().changes
    + db.prepare("DELETE FROM stock_items WHERE style_no LIKE 'N24-DEMO%'").run().changes;
  out.products = db.prepare("DELETE FROM mall_products WHERE style_no LIKE 'N24-DEMO%'").run().changes;
  // 站内消息会真的写进客户商城收件箱；消息模块产生的那些要跟着清，否则每重放一次就多一批
  out.mall_messages = db.prepare(`DELETE FROM mall_messages
    WHERE ref_type='msg_outbox' AND (customer_id IN ${inCust} OR customer_id NOT IN (SELECT id FROM customers))`)
    .run(...custIds).changes;
  out.accounts = db.prepare(`DELETE FROM customer_accounts WHERE customer_id IN ${inCust}`).run(...custIds).changes;
  out.customers = db.prepare("DELETE FROM customers WHERE code LIKE 'N24DEMO%'").run().changes;
  // 渠道能力与全局频控是演示配置，每次重放回到基线
  db.prepare("DELETE FROM msg_channel_capabilities WHERE company_id=1 AND channel IN ('email','wechat')").run();
  db.prepare("DELETE FROM msg_frequency_rules WHERE scope='global'").run();
}

/* ---------------- 渠道能力 ---------------- */
const nowStr = localNow();
db.prepare(`INSERT INTO msg_channel_capabilities (company_id,channel,status,verify_status,evidence,reason,verified_at,updated_at)
  VALUES (1,'email','enabled','verified','邮件服务商 SMTP 验收单 MAIL-2026-10-08（发信域 SPF/DKIM 已通过）',NULL,?,?)`)
  .run(nowStr, nowStr);
// 微信故意不授权：所有微信消息都该降级，系统也不能声称已通过微信发出
db.prepare(`INSERT INTO msg_channel_capabilities (company_id,channel,status,verify_status,evidence,reason,verified_at,updated_at)
  VALUES (1,'wechat','unauthorized','unverified',NULL,'公众号未完成认证，模板消息未开通',NULL,?)`)
  .run(nowStr);

/* ---------------- 频控 ---------------- */
db.prepare(`INSERT INTO msg_frequency_rules
  (company_id,scope,customer_id,max_per_day,max_per_week,min_gap_minutes,quiet_start,quiet_end,digest_hour,status,note,created_at,updated_at)
  VALUES (1,'global',NULL,1,3,0,'21:00','08:00',10,'active',?,?,?)`)
  .run(`${TAG} 全局默认：每天最多 1 条营销，21:00–08:00（客户当地时间）不发`, nowStr, nowStr);

/* ---------------- 客户与账号 ---------------- */
function mkCustomer(code, name, level) {
  const info = db.prepare(`INSERT INTO customers (code,name,level,status,company_id,created_at,updated_at)
    VALUES (?,?,?,'active',1,?,?)`).run(code, name, level, nowStr, nowStr);
  return Number(info.lastInsertRowid);
}

function mkAccount(customerId, username, name, email) {
  const info = db.prepare(`INSERT INTO customer_accounts
    (customer_id,username,password_hash,name,phone,email,role,status,perms,created_at)
    VALUES (?,?,?,?,?,?,'member','active',?,?)`).run(
    customerId, username, hashPassword('demo123456'), name, null, email,
    JSON.stringify(['catalog.view', 'inquiry.create', 'order.view']), nowStr
  );
  return Number(info.lastInsertRowid);
}

const c1 = mkCustomer('N24DEMO01', 'Nordic Textile AB（瑞典）', 'A');
const c2 = mkCustomer('N24DEMO02', 'Tokyo Mode Co., Ltd.（日本）', 'B');
const c3 = mkCustomer('N24DEMO03', 'West Coast Apparel Inc.（美国）', 'A');
const c4 = mkCustomer('N24DEMO04', 'Shenzhen Trial Trading（美国仓试单）', 'C');

mkAccount(c1, 'n24nordic', 'Erik Lund', 'erik@nordic-textile.example');
mkAccount(c2, 'n24tokyo', '佐藤 健', 'sato@tokyo-mode.example');
mkAccount(c3, 'n24west', 'Dana Ruiz', 'dana@westcoast-apparel.example');
mkAccount(c4, 'n24sz', 'Chen Wei', 'chen@sz-trial.example');

db.prepare('UPDATE customers SET owner_user_id=?, owner_name=? WHERE id=?').run(2, '销售小王', c1);
db.prepare('UPDATE customers SET owner_user_id=?, owner_name=? WHERE id=?').run(9, '朱佳豪', c2);
db.prepare('UPDATE customers SET owner_user_id=?, owner_name=? WHERE id=?').run(2, '销售小王', c3);

/* ---------------- 商品与库存 ---------------- */
function mkProduct(styleNo, nameCn, price, status) {
  const info = db.prepare(`INSERT INTO mall_products
    (style_no,name_cn,name_en,category,price_usd,moq,lead_days,status,visible_stock,created_at,updated_at)
    VALUES (?,?,?,?,?,1,30,?,1,?,?)`).run(
    styleNo, nameCn, nameCn, 'outerwear', price, status, nowStr, nowStr
  );
  return Number(info.lastInsertRowid);
}

function mkStock(styleNo, nameCn, qty) {
  db.prepare('INSERT INTO stock_items (warehouse,style_no,product_name,color,size,qty,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('us', styleNo, nameCn, '藏青', 'M', qty, nowStr);
  if (qty > 0) {
    db.prepare(`INSERT INTO stock_ledger (warehouse,style_no,product_name,color,size,type,qty,ref_type,ref_id,remark,operator,created_at)
      VALUES (?,?,?,?,?,'in',?,'demo',NULL,?,?,?)`).run(
      'us', styleNo, nameCn, '藏青', 'M', qty, `${TAG} 美仓上架`, TAG, nowStr
    );
  }
}

mkProduct('N24-DEMO-01', '秋冬羊毛混纺大衣', 42.5, 'published');
mkProduct('N24-DEMO-02', '轻薄羽绒马甲', 28, 'published');
mkProduct('N24-DEMO-03', '春季棉麻衬衫', 15.5, 'draft');
mkStock('N24-DEMO-01', '秋冬羊毛混纺大衣', 120);
mkStock('N24-DEMO-02', '轻薄羽绒马甲', 0);
mkStock('N24-DEMO-03', '春季棉麻衬衫', 40);

/* ---------------- 微信绑定 ---------------- */
db.prepare(`INSERT INTO msg_wechat_bindings (customer_id,openid,subscribe_status,verified,verified_at,last_sync_at,note,demo_tag,created_at)
  VALUES (?,?, 'subscribed',1,?,?,?,?,?)`).run(c1, `o${TAG}_c1`, nowStr, nowStr, '客户在公众号内关注并授权', TAG, nowStr);
db.prepare(`INSERT INTO msg_wechat_bindings (customer_id,openid,subscribe_status,verified,verified_at,last_sync_at,note,demo_tag,created_at)
  VALUES (?,?, 'unsubscribed',1,?,?,?,?,?)`).run(c3, `o${TAG}_c3`, nowStr, nowStr, '客户已取消关注', TAG, nowStr);

/* ---------------- 订阅 ---------------- */
function sub(customerId, topic, channel, extra = {}) {
  const r = N.upsertSub({ customer_id: customerId, topic, channel, ...extra }, OP);
  db.prepare('UPDATE msg_subscriptions SET demo_tag=? WHERE id=?').run(TAG, r.id);
  return r;
}

// c1：全渠道（欧洲时区），邮件要核验
sub(c1, 'order', 'site');
sub(c1, 'order', 'email');
sub(c1, 'arrival', 'site', { timezone: 'Europe/London' });
sub(c1, 'arrival', 'email', { timezone: 'Europe/London' });
sub(c1, 'arrival', 'wechat', { timezone: 'Europe/London' });
sub(c1, 'marketing', 'site', { timezone: 'Europe/London', frequency: 'daily' });
sub(c1, 'marketing', 'email', { timezone: 'Europe/London', frequency: 'daily' });
sub(c1, 'marketing', 'wechat', { timezone: 'Europe/London', frequency: 'daily' });
const verify = N.requestEmailVerify(c1, OP);
N.confirmEmailVerify(c1, { token: verify.verify_token }, OP);

// c2：站内 + 邮件
sub(c2, 'order', 'site', { timezone: 'Asia/Tokyo' });
sub(c2, 'order', 'email', { timezone: 'Asia/Tokyo' });
sub(c2, 'arrival', 'site', { timezone: 'Asia/Tokyo' });
const verify2 = N.requestEmailVerify(c2, OP);
N.confirmEmailVerify(c2, { token: verify2.verify_token }, OP);

// c3：只订阅订单，营销先订后退（演示「退订不删业务记录」）
sub(c3, 'order', 'site', { timezone: 'America/Los_Angeles' });
sub(c3, 'arrival', 'site', { timezone: 'America/Los_Angeles' });
sub(c3, 'marketing', 'site', { timezone: 'America/Los_Angeles' });
N.unsubscribeMarketing(c3, { reason: '客户邮件里点了退订链接' }, OP);

// c4：只有邮件，且故意不核验（发送时整条跳过）；营销站内（当地正处静默时段）
sub(c4, 'order', 'email', { timezone: 'America/Los_Angeles' });
sub(c4, 'arrival', 'email', { timezone: 'America/Los_Angeles' });
sub(c4, 'marketing', 'site', { timezone: 'America/Los_Angeles', frequency: 'daily' });

/* ---------------- 模板 ---------------- */
function mkTpl(eventKey, channel, lang, subject, body, opts = {}) {
  const t = N.createTemplate({ event_key: eventKey, channel, lang, subject, body, change_note: opts.note || null }, OP);
  db.prepare('UPDATE msg_templates SET demo_tag=? WHERE id=?').run(TAG, t.id);
  if (opts.submit) N.submitTemplate(t.id, OP);
  if (opts.approve) N.approveTemplate(t.id, {}, APPROVER);
  return t;
}

mkTpl('new_product', 'site', 'zh', '新品上架：{{product_name}}',
  '{{customer_name}} 您好，{{product_name}}（款号 {{style_no}}）已上架，当前可售 {{qty}} 件，美国仓可直接发货。\n参考价 {{price_usd}} USD，起订 1 件。',
  { submit: true, approve: true });
// 同一个组合再出一版：批准后 V1 自动停用，历史消息仍能对上当时文案
const v2 = N.createTemplate({
  event_key: 'new_product', channel: 'site', lang: 'zh',
  subject: '新品上架：{{product_name}}（现货可发）',
  body: '{{customer_name}} 您好，{{product_name}}（款号 {{style_no}}）已上架，美国仓可售 {{qty}} 件，参考价 {{price_usd}} USD。\n如需退订营销消息，可在商城「消息订阅」里关掉，订单与服务通知不受影响。',
  change_note: '补上退订指引与现货说明'
}, OP);
db.prepare('UPDATE msg_templates SET demo_tag=? WHERE id=?').run(TAG, v2.id);
N.submitTemplate(v2.id, OP);
N.approveTemplate(v2.id, {}, APPROVER);

mkTpl('new_product', 'email', 'zh', '【上新】{{product_name}} 已可下单',
  '{{customer_name}} 您好：\n\n{{product_name}}（{{style_no}}）已上架，美国仓可售 {{qty}} 件，参考价 {{price_usd}} USD。\n\n如需退订营销邮件，请点击邮件底部的退订链接（退订不影响订单与服务通知）。',
  { submit: true, approve: true });
mkTpl('new_product', 'wechat', 'zh', '{{product_name}} 已上新',
  '{{customer_name}}，{{style_no}} 已到仓 {{qty}} 件，可下单。',
  { submit: true, approve: true });
mkTpl('restock', 'site', 'zh', '到货提醒：{{product_name}}',
  '{{customer_name}} 您好，您关注的 {{style_no}} 已补货，当前可售 {{qty}} 件。',
  { submit: true, approve: true });
mkTpl('order_status', 'site', 'zh', '订单状态更新：{{order_no}}',
  '{{customer_name}} 您好，订单 {{order_no}} 的最新状态为「{{status_label}}」。如有疑问请联系您的业务员。',
  { submit: true, approve: true });
mkTpl('order_status', 'email', 'zh', '订单 {{order_no}} 状态更新为「{{status_label}}」',
  '{{customer_name}} 您好：\n\n订单 {{order_no}} 状态已更新为「{{status_label}}」。\n\n此邮件为业务通知，不受营销订阅影响。',
  { submit: true, approve: true });
mkTpl('cycle_due', 'site', 'zh', '补货提醒：距上次采购已 {{cycle_days}} 天',
  '{{customer_name}} 您好，按您的采购节奏（约 {{cycle_days}} 天）该补货了，上次采购日期 {{due_date}}，已超期 {{overdue_days}} 天。',
  { submit: true, approve: true });
// 待审核：英文上新（演示审核队列，未生效不会用于发送）
mkTpl('new_product', 'site', 'en', 'New arrival: {{product_name}}',
  'Hi {{customer_name}}, {{product_name}} ({{style_no}}) is now available with {{qty}} pcs in stock.',
  { submit: true });
// 营销摘要：站内已批准（能发），邮件还是草稿（未提交）→ 演示「模板没批就发不出去」
mkTpl('promo_digest', 'site', 'zh', '{{customer_name}}，本月上新与补货汇总',
  '本月上新 1 款、补货 1 款，详见客户商城。如不想再收这类消息，可在商城「消息订阅」里关掉营销通知。',
  { submit: true, approve: true });
mkTpl('promo_digest', 'email', 'zh', '{{customer_name}}，本月上新与补货汇总',
  '本月上新与补货汇总，详见客户商城。', { note: '待运营补全内容' });

/* ---------------- 到货/上新提醒 ---------------- */
const alerts = {};
['c1', 'c2', 'c3', 'c4'].forEach((k) => { alerts[k] = []; });
function mkAlert(customerId, styleNo, kind, note) {
  const r = N.createAlert({ customer_id: customerId, style_no: styleNo, kind, note, source: 'mall_publish' }, OP);
  db.prepare('UPDATE msg_arrival_alerts SET demo_tag=? WHERE id=?').run(TAG, r.id);
  return r;
}
// 已发布 + 有库存 → 会真的发出去
mkAlert(c1, 'N24-DEMO-01', 'new_product', '客户在商城点了「到货通知我」');
mkAlert(c2, 'N24-DEMO-01', 'restock', '老客户等这款补货');
// 已发布但可售 0 → 停在等待
mkAlert(c3, 'N24-DEMO-02', 'new_product', '等这款到仓');
// 还是草稿 → 停在等待（未过发布审核）
mkAlert(c4, 'N24-DEMO-03', 'restock', '客户想要这件的到货提醒');

/* ---------------- 触发上新提醒 ---------------- */
const sweep = N.sweepAlerts(OP);

/* ---------------- 发送 ---------------- */
const dispatch1 = N.dispatchPending({}, OP);

/* ---------------- 订单状态通知 ---------------- */
// c2：站内 + 邮件都通；邮件随后被退回 → 演示失败重试
N.emitEvent('order_status', {
  customer_id: c2, biz_type: 'order', biz_id: null,
  order_no: 'N24DEMO-ORD2', status_label: '已发货',
  title: 'N24DEMO-ORD2 状态更新为已发货',
  dedupe_key: `${TAG}|order_status|c2|${today()}`
}, OP);
// c4：只有未核验的邮件 → 发送阶段整条跳过
N.emitEvent('order_status', {
  customer_id: c4, biz_type: 'order', biz_id: null,
  order_no: 'N24DEMO-ORD4', status_label: '已入库',
  title: 'N24DEMO-ORD4 状态更新为已入库',
  dedupe_key: `${TAG}|order_status|c4|${today()}`
}, OP);
// c3：营销已退订，但订单通知照常（退订不影响业务记录）
N.emitEvent('order_status', {
  customer_id: c3, biz_type: 'order', biz_id: null,
  order_no: 'N24DEMO-ORD3', status_label: '生产中',
  title: 'N24DEMO-ORD3 状态更新为生产中',
  dedupe_key: `${TAG}|order_status|c3|${today()}`
}, OP);
const dispatch2 = N.dispatchPending({}, OP);

/* ---------------- 营销摘要（演示频控） ---------------- */
N.emitEvent('promo_digest', {
  customer_id: c1, biz_type: 'campaign', biz_id: null,
  title: '本月上新与补货汇总',
  note: '秋冬大衣 + 羽绒马甲合集',
  dedupe_key: `${TAG}|promo|c1|${today()}`
}, OP);
const dispatch3 = N.dispatchPending({}, OP);

/* ---------------- 回执 ---------------- */
const findOb = (customerId, eventKey, channel, degradedFrom) => db.prepare(`SELECT o.* FROM msg_outbox o
  JOIN msg_events e ON e.id=o.event_id
  WHERE o.customer_id=? AND e.event_key=? AND o.channel=?
    ${degradedFrom ? 'AND o.degraded_from=?' : 'AND o.degraded_from IS NULL'}
  ORDER BY o.id DESC LIMIT 1`).get(...[customerId, eventKey, channel, ...(degradedFrom ? [degradedFrom] : [])]);

const receipts = [];
// 站内上新提醒：客户看了 → 已读
const obSite = findOb(c1, 'new_product', 'site');
if (obSite) { N.receipt(obSite.id, { event: 'read', detail: '客户在商城点开消息' }, OP); receipts.push('c1 站内上新 → 已读'); }
// 邮件上新提醒：送达 + 打开（打开不算已读）
const obMail = findOb(c1, 'new_product', 'email');
if (obMail) {
  N.receipt(obMail.id, { event: 'delivered', detail: 'SMTP 250 接收', provider_code: '250' }, OP);
  N.receipt(obMail.id, { event: 'opened', detail: '邮件被打开（不置已读）' }, OP);
  receipts.push('c1 邮件上新 → 已送达 + 已打开（不置已读）');
}
// 微信降级到站内的那条：送达
const obDeg = findOb(c1, 'new_product', 'site', 'wechat');
if (obDeg) { receipts.push(`c1 微信 → 降级站内（${obDeg.outbox_no}）已完成送达`); }
// c2 邮件订单通知：渠道退信 → 失败待重试
const obFail = findOb(c2, 'order_status', 'email');
if (obFail) {
  N.receipt(obFail.id, { event: 'failed', detail: '550 mailbox unavailable（收件箱不存在）', provider_code: '550' }, OP);
  receipts.push('c2 邮件订单通知 → 发送失败（第 1 次，1 小时后重试）');
}

/* ---------------- 周期回访任务 ---------------- */
const cycles = [
  { customer_id: c1, days: 45, last: -55, due: -10, owner: 2 },
  { customer_id: c2, days: 60, last: -64, due: -4, owner: 9 },
  { customer_id: c3, days: 30, last: -42, due: -12, owner: 2 },
  { customer_id: c4, days: 90, last: -91, due: -1, owner: 9 }
];
cycles.forEach((cy) => {
  db.prepare(`INSERT INTO crm_customer_cycles
    (customer_id,company_id,status,cycle_days,basis,reason,owner_user_id,owner_name,
     last_purchase_date,next_due_date,grace_days,updated_by,updated_at,demo_tag)
    VALUES (?,1,'known',?,'contract','演示：合同约定的补货节奏',?,?,?,?,5,?,?,?)`).run(
    cy.customer_id, cy.days, cy.owner,
    cy.owner === 2 ? '销售小王' : '朱佳豪',
    addDays(today(), cy.last), addDays(today(), cy.due), TAG, nowStr, TAG
  );
});
// 逐个客户跑，只看演示客户；真实场景是全局扫一遍（不传 customer_id）
const cyc = { tasks: 0, messages: 0, no_auth: 0, rows: [] };
[c1, c2, c3, c4].forEach((cid) => {
  const r = N.cycleTasks({ customer_id: cid }, OP);
  cyc.tasks += r.tasks;
  cyc.messages += r.messages;
  cyc.no_auth += r.no_auth;
  cyc.rows = cyc.rows.concat(r.rows);
});
const dispatch4 = N.dispatchPending({}, OP);

/* ---------------- 询价与订单（用于归因） ---------------- */
const iq = db.prepare(`INSERT INTO mall_inquiries
  (inquiry_no,customer_id,contact,status,total_usd,total_qty,remark,created_at,updated_at)
  VALUES (?,?,?,'submitted',?,?,?,?,?)`).run(
  'N24DEMO-XJ01', c1, 'Erik Lund', 4200, 120, '看了上新提醒后来问价', nowStr, nowStr
);
const iqId = Number(iq.lastInsertRowid);
db.prepare(`INSERT INTO mall_inquiry_items (inquiry_id,mall_product_id,style_no,name,qty,price_usd,amount_usd,remark)
  VALUES (?,?,?,?,?,?,?,?)`).run(
  iqId, db.prepare("SELECT id FROM mall_products WHERE style_no='N24-DEMO-01'").get().id,
  'N24-DEMO-01', '秋冬羊毛混纺大衣', 120, 35, 4200, '来自上新提醒'
);
db.prepare(`INSERT INTO orders (order_no,type,customer_id,status,rate,total_usd,total_amount,currency,
    style_name,cus_order_no,manager,order_date,created_by,company_id,created_at,updated_at)
  VALUES (?,'stock',?,'assigned',7.1,?,?,'CNY',?,?,?,?,1,1,?,?)`).run(
  'N24DEMO-ORD1', c1, 4400, 31240, '秋冬羊毛混纺大衣', 'N24-CUS-88', '销售小王', today(), nowStr, nowStr
);

/* ---------------- 归因 ---------------- */
const attr = N.refreshAttribution({ days: 7 }, OP);

/* ---------------- 输出 ---------------- */
const c = (t, w = '') => Number(db.prepare(`SELECT COUNT(*) c FROM ${t} ${w}`).get().c);
console.log(`[${TAG}] reset:`, JSON.stringify(out));
console.log(`[${TAG}] 客户 4 / 账号 ${c('customer_accounts', "WHERE customer_id IN (SELECT id FROM customers WHERE code LIKE 'N24DEMO%')")} / 商品 3 / 订阅 ${c('msg_subscriptions', `WHERE demo_tag='${TAG}'`)} / 模板 ${c('msg_templates', `WHERE demo_tag='${TAG}'`)}`);
console.log(`[${TAG}] 提醒触发 ${sweep.fired} 条，仍在等待 ${sweep.waiting} 条（未发布或无可售）`);
sweep.waiting_rows.forEach((w) => console.log(`   · 等待 ${w.style_no}：${w.reason}`));
console.log(`[${TAG}] 派发：上新 ${dispatch1.sent} 发 / ${dispatch1.held} 暂缓 / ${dispatch1.skipped} 跳过；订单 ${dispatch2.sent} 发 / ${dispatch2.skipped} 跳过；营销 ${dispatch3.sent} 发 / ${dispatch3.held} 暂缓；周期 ${dispatch4.sent} 发 / ${dispatch4.held} 暂缓`);
console.log(`[${TAG}] 回执：${receipts.join('；')}`);
console.log(`[${TAG}] 周期任务：生成 ${cyc.tasks} 条回访任务，营销消息 ${cyc.messages} 条，无营销授权 ${cyc.no_auth} 户`);
cyc.rows.forEach((r) => console.log(`   · ${r.customer} 超期 ${r.overdue} 天 → 任务${r.task ? '✅' : '❌'} 消息${r.message ? '✅' : '❌'}${r.reason ? `（${r.reason}）` : ''}`));
console.log(`[${TAG}] 归因：送达 ${attr.delivered} / 阅读 ${attr.read} / 询价 ${attr.inquiry} / 订单 ${attr.order} / 归因金额 ¥${attr.revenue_cny}`);
const stat = db.prepare(`SELECT status, COUNT(*) c FROM msg_outbox WHERE customer_id IN (SELECT id FROM customers WHERE code LIKE 'N24DEMO%') GROUP BY status`).all();
console.log(`[${TAG}] 发送状态分布：`, stat.map((x) => `${x.status}=${x.c}`).join(' '));
