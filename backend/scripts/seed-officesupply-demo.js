/**
 * 办公耗材与服务采购 演示数据
 * ----------------------------------------------------------------------
 * 造一个真实的行政月：
 *   - 9 个物品档（含 2 个耐用品），其中 2 个已低于最低库存（用来演示「只提示不自动下单」）
 *   - 1 张已验收的物品采购（纸 + 笔 + 2 台打印机）→ 费用与资产已分开
 *   - 1 张已下单待验收的服务采购（保洁）
 *   - 4 张申领单：待审批 / 已批准待领 / 已领用 / 已驳回
 *   - 1 张超月限额但写了例外说明的申领
 *
 * 用法：
 *   node scripts/seed-officesupply-demo.js           生成
 *   node scripts/seed-officesupply-demo.js --clean    清干净（按 demo_tag + 单据特征）
 */
const { db, now } = require('../src/db');
const { localDate } = require('../src/utils/time');
const S = require('../src/services/officeSupply');

const MARK = 'DEMO';
const day = (n) => localDate(new Date(Date.now() + n * 86400000).toISOString());

function clean() {
  const items = db.prepare('SELECT id FROM office_items WHERE demo_tag = ?').all(MARK).map((r) => r.id);
  const pos = db.prepare('SELECT id, po_no FROM office_purchases WHERE demo_tag = ?').all(MARK);
  const reqs = db.prepare('SELECT id FROM office_requests WHERE demo_tag = ?').all(MARK).map((r) => r.id);

  pos.forEach((p) => {
    db.prepare('DELETE FROM office_purchase_items WHERE purchase_id = ?').run(p.id);
    db.prepare('DELETE FROM office_purchase_sources WHERE purchase_id = ?').run(p.id);
    // 验收时生成的资产与费用：备注里带着采购单号，按它清
    db.prepare('DELETE FROM assets WHERE remark LIKE ?').run(`%${p.po_no}%`);
    db.prepare('DELETE FROM admin_expenses WHERE remark LIKE ?').run(`%${p.po_no}%`);
    db.prepare("DELETE FROM budget_commitments WHERE source_type='office_purchase' AND source_id=?").run(p.id);
  });
  db.prepare('DELETE FROM office_purchases WHERE demo_tag = ?').run(MARK);

  reqs.forEach((id) => db.prepare('DELETE FROM office_request_items WHERE request_id = ?').run(id));
  db.prepare('DELETE FROM office_requests WHERE demo_tag = ?').run(MARK);

  items.forEach((id) => {
    db.prepare('DELETE FROM office_ledger WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM office_stock WHERE item_id = ?').run(id);
  });
  db.prepare('DELETE FROM office_items WHERE demo_tag = ?').run(MARK);

  console.log(`清掉演示：物品 ${items.length} · 申领 ${reqs.length} · 采购 ${pos.length}`);
}

if (process.argv.includes('--clean')) { clean(); process.exit(0); }
clean();

/* ---------------- 物品档案 ---------------- */
const mk = (body) => {
  const r = S.saveItem(body, '行政部');
  db.prepare('UPDATE office_items SET demo_tag = ? WHERE id = ?').run(MARK, r.id);
  return r;
};

const paper = mk({ name: 'A4 打印纸', spec: '70g / 500 张一包', category: 'printing', unit: '包', min_qty: 10, monthly_limit: 0 });
const pen = mk({ name: '中性笔', spec: '0.5mm 黑色', category: 'stationery', unit: '支', min_qty: 20, monthly_limit: 30 });
const clip = mk({ name: '长尾夹', spec: '32mm / 盒', category: 'stationery', unit: '盒', min_qty: 5 });
const bag = mk({ name: '垃圾袋', spec: '45×50cm 加厚', category: 'cleaning', unit: '卷', min_qty: 6 });
const soap = mk({ name: '洗手液', spec: '500ml', category: 'cleaning', unit: '瓶', min_qty: 4 });
const tissue = mk({ name: '抽纸', spec: '3 层 120 抽', category: 'cleaning', unit: '提', min_qty: 8 });
const toner = mk({ name: '硒鼓', spec: '适配 HP M405', category: 'printing', unit: '个', min_qty: 2 });
const printer = mk({ name: '激光一体机', spec: 'A4 黑白 打印/复印/扫描', category: 'electronic', unit: '台', durable: 1, asset_category: '办公设备', useful_years: 5 });
const chair = mk({ name: '人体工学椅', spec: '网布 可调腰托', category: 'furniture', unit: '把', durable: 1, asset_category: '办公家具', useful_years: 8 });

/* ---------------- 采购一：耗材 + 耐用品混单，已验收 ---------------- */
const po1 = S.createPurchase({
  supplier: '义乌文具批发中心', dept_id: 6, expected_date: day(-6),
  items: [
    { item_id: paper.id, qty: 60, price: 18.5 },
    { item_id: pen.id, qty: 120, price: 1.6 },
    { item_id: tissue.id, qty: 30, price: 12 },
    { item_id: clip.id, qty: 10, price: 6.5 },
    { item_id: bag.id, qty: 20, price: 8 },
    // 洗手液与硒鼓故意少买：低于最低库存，用来演示「只提示不自动下单」
    { item_id: soap.id, qty: 3, price: 15 },
    { item_id: toner.id, qty: 1, price: 320 },
    { item_id: printer.id, qty: 2, price: 1180 },
    { item_id: chair.id, qty: 3, price: 460 }
  ],
  demo_tag: MARK
}, '行政部');
db.prepare('UPDATE office_purchases SET demo_tag = ? WHERE id = ?').run(MARK, po1.id);
S.approvePurchase(po1.id, {}, '行政主管');
S.orderPurchase(po1.id, { expected_date: day(-6) }, '行政部');
const rc1 = S.receivePurchase(po1.id, { payment_method: '转账' }, '行政部');
// 验收时间往前挪，看起来像上周的事
db.prepare('UPDATE office_purchases SET received_at=?, created_at=? WHERE id=?')
  .run(`${day(-6)}T10:20:00.000Z`, `${day(-8)}T09:00:00.000Z`, po1.id);
db.prepare('UPDATE office_ledger SET created_at=? WHERE ref_type=\'purchase\' AND ref_id=?')
  .run(`${day(-6)}T10:20:00.000Z`, po1.id);
db.prepare("UPDATE admin_expenses SET expense_date=? WHERE id=?").run(day(-6), rc1.expense_id);

/* ---------------- 采购二：服务（保洁），已下单待验收 ---------------- */
const po2 = S.createPurchase({
  kind: 'service', supplier: '洁美保洁服务部', dept_id: 6, expected_date: day(2),
  items: [
    { line_type: 'service', item_name: '办公区保洁（10 月）', qty: 1, price: 3200, note: '每周两次，含茶水间与卫生间' },
    { line_type: 'service', item_name: '地毯深度清洗', qty: 1, price: 800, note: '会议室 + 前厅' }
  ],
  demo_tag: MARK
}, '行政部');
db.prepare('UPDATE office_purchases SET demo_tag = ? WHERE id = ?').run(MARK, po2.id);
S.approvePurchase(po2.id, {}, '行政主管');
S.orderPurchase(po2.id, { expected_date: day(2) }, '行政部');

/* ---------------- 采购三：草稿（还没核价），演示「0 元不能审批」 ---------------- */
const po3 = S.createPurchase({
  supplier: '办公设备维修（待核价）', dept_id: 6,
  items: [{ line_type: 'service', item_name: '空调清洗保养', qty: 4, price: 0 }],
  demo_tag: MARK
}, '行政部');
db.prepare('UPDATE office_purchases SET demo_tag = ? WHERE id = ?').run(MARK, po3.id);

/* ---------------- 申领单：四种状态 ---------------- */
// ① 待审批
const rq1 = S.saveRequest({
  items: [{ item_id: paper.id, qty_apply: 6 }, { item_id: clip.id, qty_apply: 2 }],
  dept_id: 1, requester: 'sales01', requester_name: '小陈（销售）',
  purpose: '客户来访要打印资料，另外缺长尾夹夹合同', need_date: day(1), submit: true, demo_tag: MARK
}, 'sales01');
db.prepare('UPDATE office_requests SET demo_tag = ? WHERE id = ?').run(MARK, rq1.id);

// ② 已批准待领（库存够，等行政发）
const rq2 = S.saveRequest({
  items: [{ item_id: bag.id, qty_apply: 4 }, { item_id: soap.id, qty_apply: 2 }],
  dept_id: 5, requester: 'wh01', requester_name: '老赵（仓库）',
  purpose: '仓库打包区垃圾袋用完，洗手液也见底了', submit: true, demo_tag: MARK
}, 'wh01');
db.prepare('UPDATE office_requests SET demo_tag = ? WHERE id = ?').run(MARK, rq2.id);
S.approveRequest(rq2.id, {}, '行政主管');

// ③ 已领用（完整走完）
const rq3 = S.saveRequest({
  items: [{ item_id: paper.id, qty_apply: 10 }, { item_id: pen.id, qty_apply: 20 }],
  dept_id: 3, requester: 'fin01', requester_name: '王会计（财务）',
  purpose: '月末结账打印凭证，笔也不出水了', submit: true, demo_tag: MARK
}, 'fin01');
db.prepare('UPDATE office_requests SET demo_tag = ? WHERE id = ?').run(MARK, rq3.id);
S.approveRequest(rq3.id, {}, '行政主管');
S.issueRequest(rq3.id, {}, '行政部');
db.prepare('UPDATE office_requests SET created_at=?, issued_at=? WHERE id=?')
  .run(`${day(-4)}T09:10:00.000Z`, `${day(-3)}T14:00:00.000Z`, rq3.id);
db.prepare("UPDATE office_ledger SET created_at=? WHERE ref_type='request' AND ref_id=?")
  .run(`${day(-3)}T14:00:00.000Z`, rq3.id);

// ④ 已驳回
const rq4 = S.saveRequest({
  items: [{ item_id: tissue.id, qty_apply: 8 }],
  dept_id: 2, requester: 'tech01', requester_name: '李工（技术）',
  purpose: '技术部领 8 提抽纸放工位，顺便备一批', submit: true, demo_tag: MARK
}, 'tech01');
db.prepare('UPDATE office_requests SET demo_tag = ? WHERE id = ?').run(MARK, rq4.id);
S.rejectRequest(rq4.id, {
  reason: '技术部上个月刚领过 20 提，行政这边领用记录还没用完。按「先用完再提」的规矩先驳回，确实不够再来提，并在申领里写清剩余量'
}, '行政主管');

// ⑤ 超月限额 + 例外说明（新入职集中配文具）
// 月限额按「部门 + 月份已出库」算，所以要先让行政部本月已经领过一批笔，这条才会真的触发限额
const rq6 = S.saveRequest({
  items: [{ item_id: pen.id, qty_apply: 15 }],
  dept_id: 6, requester: 'zhang', requester_name: '张行政',
  purpose: '行政前台与会议室补充用笔', submit: true, demo_tag: MARK
}, 'zhang');
db.prepare('UPDATE office_requests SET demo_tag = ? WHERE id = ?').run(MARK, rq6.id);
S.approveRequest(rq6.id, {}, '行政主管');
S.issueRequest(rq6.id, {}, '行政部');
db.prepare('UPDATE office_requests SET created_at=?, issued_at=? WHERE id=?')
  .run(`${day(-10)}T09:00:00.000Z`, `${day(-9)}T15:00:00.000Z`, rq6.id);
db.prepare("UPDATE office_ledger SET created_at=? WHERE ref_type='request' AND ref_id=?")
  .run(`${day(-9)}T15:00:00.000Z`, rq6.id);

const rq5 = S.saveRequest({
  items: [{ item_id: pen.id, qty_apply: 25 }],
  dept_id: 6, requester: 'hr01', requester_name: '小周（人事）',
  purpose: '本月新入职 6 人，统一配办公文具', submit: true, demo_tag: MARK,
  exception_reason: '10 月新入职 6 人，一次性配齐笔与本子，下月恢复常规领用'
}, 'hr01');
db.prepare('UPDATE office_requests SET demo_tag = ? WHERE id = ?').run(MARK, rq5.id);

/* 低库存不靠手改：采购量本来就没买够，库存与流水天然一致 */

const low = S.lowStock();
console.log('\n物品档案:', db.prepare('SELECT COUNT(*) c FROM office_items WHERE demo_tag = ?').get(MARK).c, '个');
console.log('低于最低库存:', low.rows.map((r) => `${r.name} ${r.qty}/${r.min_qty}（建议补 ${r.suggest_qty}）`).join('、') || '无');
console.log('\n采购单:');
db.prepare('SELECT po_no, kind, status, total_amount, expense_amount, asset_amount FROM office_purchases WHERE demo_tag = ? ORDER BY id').all(MARK)
  .forEach((p) => console.log(` ${p.po_no} ${p.kind === 'service' ? '服务' : '物品'} ${p.status} 金额 ${p.total_amount} 费用 ${p.expense_amount} 资产 ${p.asset_amount}`));
console.log('\n申领单:');
db.prepare('SELECT req_no, status, requester_name FROM office_requests WHERE demo_tag = ? ORDER BY id').all(MARK)
  .forEach((r) => console.log(` ${r.req_no} ${r.status} ${r.requester_name}`));
console.log('\n完成。清空用 --clean');
