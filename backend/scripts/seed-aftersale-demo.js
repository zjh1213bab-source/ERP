/**
 * 售后与对账资料 演示数据
 * ----------------------------------------------------------------------
 * 造五种真实状态（都是为了让人一眼看出「这单卡在哪」）：
 *   A 待受理        —— 客户刚提，带照片，业务还没回
 *   B 处理中·逾期    —— 已受理并生成退货单，货到仓但还没判定（主责质检，已过时限）
 *   C 处理中·已退款  —— 仅赔款，货留客户手上（退款完成但实物不回来）
 *   D 已结案        —— 退款 + 向本厂追偿，全链路走完
 *   E 已驳回        —— 客户把别一单的问题算到这一单，写明原因驳回
 *
 * 对账文件三种状态：
 *   F 已授权（客户能下载）/ G 已撤销（发错了撤回）/ H 草稿（待财务确认）
 *
 * 用法：
 *   node scripts/seed-aftersale-demo.js           生成
 *   node scripts/seed-aftersale-demo.js --clean    清干净（按 demo_tag 与退货单备注）
 */
const { db, now } = require('../src/db');
const { localDate } = require('../src/utils/time');
const AS = require('../src/services/afterSale');
const SF = require('../src/services/statementFile');

const MARK = 'DEMO';
const day = (n) => localDate(new Date(Date.now() + n * 86400000).toISOString());

// 演示照片直接用工作区里已有的真实图片（assets 是空的，用不存在的路径会变成破图）
const P1 = '/uploads/photos/2026-10/56d1e148529e2f43e399.jpg';
const P2 = '/uploads/photos/2026-10/39b675c30f389741c2ea.jpg';
const P3 = '/uploads/photos/2026-10/8f5344256f46b6494bd8.jpg';

function clean() {
  const ids = db.prepare('SELECT id FROM after_sale_tickets WHERE demo_tag = ?').all(MARK).map((r) => r.id);
  // 售后单生成的退货单把售后单号写在 source_no 里（createReturnDraft 的约定），按它反查
  const retIds = db.prepare(
    "SELECT r.id FROM stock_returns r JOIN after_sale_tickets t ON r.source_no = t.ticket_no WHERE t.demo_tag = ?"
  ).all(MARK).map((r) => r.id);
  retIds.forEach((id) => {
    db.prepare('DELETE FROM stock_return_items WHERE return_id = ?').run(id);
    db.prepare('DELETE FROM stock_returns WHERE id = ?').run(id);
  });
  ids.forEach((id) => db.prepare("DELETE FROM attachments WHERE target_type='after_sale' AND target_id=?").run(id));
  db.prepare('DELETE FROM after_sale_tickets WHERE demo_tag = ?').run(MARK);
  const sfIds = db.prepare('SELECT id FROM statement_files WHERE demo_tag = ?').all(MARK).map((r) => r.id);
  sfIds.forEach((id) => db.prepare("DELETE FROM doc_access_logs WHERE doc_type='statement_file' AND doc_id=?").run(id));
  db.prepare('DELETE FROM statement_files WHERE demo_tag = ?').run(MARK);
  console.log(`清掉演示：售后 ${ids.length} 张 · 关联退货单 ${retIds.length} 张 · 对账文件 ${sfIds.length} 份`);
  return { ids, retIds, sfIds };
}

const buyer = db.prepare('SELECT * FROM customers WHERE id = 1').get()
  || db.prepare('SELECT * FROM customers ORDER BY id LIMIT 1').get();
const custId = buyer.id;

/** 挑几张 shipped 且有明细的订单行，且没被别的演示占用 */
function pickLines(n) {
  const used = new Set(
    db.prepare("SELECT order_item_id FROM after_sale_tickets WHERE order_item_id IS NOT NULL AND status NOT IN ('cancelled')")
      .all().map((r) => r.order_item_id)
  );
  const rows = db.prepare(
    `SELECT i.id item_id, i.style_no, i.product_name, i.qty, i.amount_usd,
            o.id order_id, o.order_no, o.currency, o.status
       FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.customer_id = ? AND o.status IN ('shipped','completed','production')
      ORDER BY o.id DESC`
  ).all(custId).filter((r) => !used.has(r.item_id));
  if (rows.length < n) throw new Error(`订单行不够（只剩 ${rows.length} 行），先清理演示数据`);
  return rows.slice(0, n);
}

const cleanOnly = process.argv.includes('--clean');
if (cleanOnly) { clean(); process.exit(0); }

clean();
const lines = pickLines(5);

/* ---------------- A 待受理 ---------------- */
const A = AS.submit({
  customerId: custId, customerName: buyer.name, source: 'customer',
  body: {
    order_id: lines[0].order_id, order_item_id: lines[0].item_id, qty: 5,
    reason_code: 'quality', resolution: 'return',
    reason: '袖口多处开线，门店已经收到两起客户投诉，需要退回并退款',
    amount_claim: 260,
    photos: [{ url: P1, filename: '袖口开线.jpg', size: 305330, note: '左袖口开线 3cm' },
      { url: P2, filename: '整体.jpg', size: 298000 }],
    demo_tag: MARK
  },
  operator: 'abc001'
});
// 让它看起来是昨天提的、今天还没人管
db.prepare('UPDATE after_sale_tickets SET created_at=?, updated_at=? WHERE id=?')
  .run(`${day(-1)}T09:20:00.000Z`, `${day(-1)}T09:20:00.000Z`, A.id);

/* ---------------- B 处理中 · 逾期（货到仓待判定） ---------------- */
const B = AS.submit({
  customerId: custId, customerName: buyer.name, source: 'customer',
  body: {
    order_id: lines[1].order_id, order_item_id: lines[1].item_id, qty: 12,
    reason_code: 'damaged', resolution: 'return',
    reason: '到仓开箱发现外箱被压扁，里层 12 件有折痕和污渍，客户拒收',
    amount_claim: 420,
    photos: [{ url: P3, filename: '外箱压损.jpg', size: 310000 }],
    demo_tag: MARK
  },
  operator: 'abc001'
});
const bAcc = AS.accept(B.id, { owner_role: 'quality', due_date: day(-2) }, '李质检');
// 货已到仓（点收完成），但还没判定 —— 这是最常见的卡点
db.prepare("UPDATE stock_returns SET status='received', qty_received=12 WHERE id=?").run(bAcc.stock_return_id);
db.prepare('UPDATE stock_return_items SET qty_received=12 WHERE return_id=?').run(bAcc.stock_return_id);
db.prepare('UPDATE after_sale_tickets SET created_at=?, updated_at=? WHERE id=?')
  .run(`${day(-6)}T10:05:00.000Z`, `${day(-3)}T16:40:00.000Z`, B.id);

/* ---------------- C 处理中 · 已退款但货不回来 ---------------- */
const C = AS.submit({
  customerId: custId, customerName: buyer.name, source: 'customer',
  body: {
    order_id: lines[2].order_id, order_item_id: lines[2].item_id, qty: 30,
    reason_code: 'short', resolution: 'refund',
    reason: '清点后短装 30 件，箱单写 300 实际 270，请核对装箱记录',
    amount_claim: 540,
    demo_tag: MARK
  },
  operator: 'abc001'
});
AS.accept(C.id, { owner_role: 'warehouse' }, '赵仓库');
AS.refund(C.id, {
  amount: 540, method: '抵扣下批货款', goods_returned: 0,
  note: '客户已按 270 件入库上架，货物不退回，直接抵扣下批货款'
}, '王财务');
db.prepare('UPDATE after_sale_tickets SET created_at=?, updated_at=? WHERE id=?')
  .run(`${day(-9)}T14:12:00.000Z`, `${day(-5)}T11:30:00.000Z`, C.id);

/* ---------------- D 已结案（退款 + 向本厂追偿） ---------------- */
const D = AS.submit({
  customerId: custId, customerName: buyer.name, source: 'customer',
  body: {
    order_id: lines[3].order_id, order_item_id: lines[3].item_id, qty: 20,
    reason_code: 'quality', resolution: 'refund',
    reason: '面料起球严重，客户要求赔偿不退货，已经在当地折价处理',
    amount_claim: 300,
    photos: [{ url: P2, filename: '起球.jpg', size: 298000 }],
    demo_tag: MARK
  },
  operator: 'abc001'
});
AS.accept(D.id, { owner_role: 'quality' }, '李质检');
AS.refund(D.id, { amount: 300, method: '原路退回', goods_returned: 0, note: '客户已折价处理，货物不退回' }, '王财务');
AS.recovery(D.id, { party: 'supplier', amount: 180, note: '起球是面料批次问题，按采购合同向面料商追偿 60%' }, '李质检');
AS.settle(D.id, { conclusion: '赔款 300 美元已退，向面料商追偿 180；客户保留货物自行折价处理，已确认不再追究' }, '李质检');
db.prepare('UPDATE after_sale_tickets SET created_at=?, updated_at=? WHERE id=?')
  .run(`${day(-20)}T08:40:00.000Z`, `${day(-12)}T15:20:00.000Z`, D.id);

/* ---------------- E 已驳回 ---------------- */
const E = AS.submit({
  customerId: custId, customerName: buyer.name, source: 'customer',
  body: {
    order_id: lines[4].order_id, order_item_id: lines[4].item_id, qty: 8,
    reason_code: 'wrong_item', resolution: 'return',
    reason: '收到的颜色和订单上的不一样，我要退货',
    amount_claim: 160,
    photos: [{ url: P1, filename: '颜色对比.jpg', size: 305330 }],
    demo_tag: MARK
  },
  operator: 'abc001'
});
AS.reject(E.id, {
  reason: '核对了装箱照片与色卡：发出的是订单确认的藏青色（PANTONE 19-3921），客户对比的是另一张订单的黑色款。已把两单色卡并排发到客户邮箱'
}, '小陈销售');
db.prepare('UPDATE after_sale_tickets SET created_at=?, updated_at=? WHERE id=?')
  .run(`${day(-14)}T13:00:00.000Z`, `${day(-13)}T09:10:00.000Z`, E.id);

const rows = db.prepare('SELECT ticket_no, status, refund_status, recovery_status FROM after_sale_tickets WHERE demo_tag=? ORDER BY id').all(MARK);
console.log('\n售后单：');
rows.forEach((r) => console.log(' ', r.ticket_no, r.status, '| 退款', r.refund_status, '| 追偿', r.recovery_status));

/* ---------------- 对账文件 三种状态 ---------------- */
const f9 = SF.generate({ customer_id: custId, period: '2026-09', kind: 'monthly', demo_tag: MARK }, '王财务');
const f9p = SF.publish(f9.id, {}, '王财务');

const f10a = SF.generate({ customer_id: custId, period: '2026-10', kind: 'monthly', demo_tag: MARK }, '王财务');
SF.publish(f10a.id, {}, '王财务');
SF.revoke(f10a.id, { reason: '10 月漏了一张补开发票，金额不对，撤回重出' }, '王财务');

const f10b = SF.generate({ customer_id: custId, period: '2026-10', kind: 'monthly', demo_tag: MARK }, '王财务');

console.log('\n对账文件：');
db.prepare('SELECT file_no, period_from, period_to, version_no, status, amount_closing FROM statement_files WHERE demo_tag=? ORDER BY id').all(MARK)
  .forEach((r) => console.log(' ', r.file_no, `${r.period_from}~${r.period_to}`, 'v' + r.version_no, r.status, '期末', r.amount_closing));

console.log('\n已授权给客户（abc001 能在商城下载）：', f9p.file_no);
console.log('待财务确认的草稿：', f10b.file_no);
console.log('\n完成。清空用 --clean');
