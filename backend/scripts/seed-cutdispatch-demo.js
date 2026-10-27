/**
 * M07 裁片外发与外协验货交接 —— 演示数据（幂等）
 * ============================================================
 * 用法：node scripts/seed-cutdispatch-demo.js [--reset]
 *
 * 演示 6 种处境：
 *   ① 已结案：发 4 扎 104 件 → 回 102（合格 96 / 不良 4 / 返工 2）+ 短数 2（污损）
 *      —— 三块加起来必须等于回货数，短数不写原因不许结案
 *   ② 已发出逾期未回：约定回货日过了还在外协手上（跟单要看得见）
 *   ③ 草稿待发出：扎已选好还没送走
 *   ④ 未复核的扎不能发：扎 B8 状态还是 created，选它会直接被拒
 *   ⑤ 一扎不能同时在两张未完结单里：同一扎再发一次会被拒
 *   ⑥ 外协质量排名：按验收合格率排，样本不足 50 件不排名
 *
 * 基础数据用 DQDEMO-CY-001（已裁完、已复核的裁剪单），补几扎凑到 208 件，
 * 让「发出 → 回货 → 验收 → 短数 → 结案」一条链完整可走。
 */
const { db } = require('../src/db');
const S = require('../src/services/cutdispatch');

const TAG = 'cutdisp_demo';
const reset = process.argv.includes('--reset');
const CUT_NO = 'DQDEMO-CY-001';
const pad = (n) => String(n).padStart(2, '0');
const D = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function clean() {
  const ids = db.prepare("SELECT id FROM cut_dispatches WHERE demo_tag = ? OR note LIKE '%冒烟测试%'").all(TAG).map((r) => r.id);
  db.exec('BEGIN');
  try {
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const recIds = db.prepare(`SELECT id FROM cut_dispatch_receipts WHERE dispatch_id IN (${ph})`).all(...ids).map((r) => r.id);
      if (recIds.length) {
        db.prepare(`DELETE FROM cut_dispatch_receipt_items WHERE receipt_id IN (${recIds.map(() => '?').join(',')})`).run(...recIds);
      }
      db.prepare(`DELETE FROM cut_dispatch_receipts WHERE dispatch_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM cut_dispatch_items WHERE dispatch_id IN (${ph})`).run(...ids);
      db.prepare(`DELETE FROM cut_dispatches WHERE id IN (${ph})`).run(...ids);
    }
    // 演示补的扎（B3..B8）
    db.prepare("DELETE FROM cut_bundles WHERE bundle_no LIKE 'DQDEMO-B%' AND bundle_no NOT IN ('DQDEMO-B1','DQDEMO-B2')").run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 补扎：在已有 B1/B2（各 44 件）基础上加 B3..B8（各 20 件），并把合格裁片数提到 208 */
function seedBundles() {
  const c = db.prepare('SELECT * FROM cut_orders WHERE cut_no = ?').get(CUT_NO);
  if (!c) throw new Error(`找不到裁剪单 ${CUT_NO}，请先跑裁床演示`);
  const t = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const sizes = ['S', 'M', 'L', 'XL'];
  const ins = db.prepare(
    `INSERT INTO cut_bundles (cut_order_id, lot_id, bundle_no, color, size, qty, status, checked_by, checked_at, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const exist = db.prepare("SELECT COUNT(*) c FROM cut_bundles WHERE bundle_no = 'DQDEMO-B3'").get().c;
  if (!exist) {
    for (let i = 3; i <= 8; i++) {
      // B8 故意留在「未复核」状态：演示「没复核的扎不能发」
      const status = i === 8 ? 'created' : 'ok';
      ins.run(c.id, null, `DQDEMO-B${i}`, '藏青', sizes[(i - 3) % sizes.length], 20, status,
        status === 'ok' ? 'qc01' : null, status === 'ok' ? t : null,
        status === 'ok' ? '裁片复核通过' : '待复核（演示：未复核不能外发）', t);
    }
  }
  const agg = db.prepare('SELECT COUNT(*) cnt, COALESCE(SUM(qty),0) q FROM cut_bundles WHERE cut_order_id = ?').get(c.id);
  db.prepare('UPDATE cut_orders SET qualified_qty = ?, total_cut_qty = ?, bundle_count = ?, bundle_qty = ?, updated_at = ? WHERE id = ?')
    .run(agg.q, agg.q, agg.cnt, agg.q, t, c.id);
  return { cut: db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(c.id), bundleQty: agg.q, bundleCnt: agg.cnt };
}

function seed() {
  const op = 'demo';
  const { cut, bundleQty, bundleCnt } = seedBundles();
  const sug = S.dispatchSuggest(cut.id);
  const bundles = sug.bundles;
  const byNo = (no) => bundles.find((b) => b.bundle_no === no);
  const fA = db.prepare("SELECT * FROM factories WHERE name LIKE '%外协厂 A%'").get();
  const fB = db.prepare("SELECT * FROM factories WHERE name LIKE '%外协厂 B%'").get();

  // ---- ① 已结案：发 4 扎 104 件 ----
  const d1 = S.create({
    cut_order_id: cut.id, factory_id: fA.id, out_date: D(-12), expect_return_date: D(-5),
    price: 8, note: '首批外发（4 扎）', demo_tag: TAG,
    bundle_ids: [byNo('DQDEMO-B1').id, byNo('DQDEMO-B3').id, byNo('DQDEMO-B4').id, byNo('DQDEMO-B5').id]
  }, op);
  S.send(d1.id, op);

  const det1 = S.detail(d1.id);
  const recItems = det1.items.map((it) => {
    // 把不良集中在 B4 那一扎：现实里疵点通常是一缸布、一刀裁片集中出现
    if (it.bundle_no === 'DQDEMO-B4') {
      return { dispatch_item_id: it.id, qty: 18, accepted_qty: 12, rejected_qty: 4, rework_qty: 2, defect_reason: '领口缝制跳针 2 件、袖口尺寸超差 2 件，另 2 件返工重修' };
    }
    return { dispatch_item_id: it.id, qty: it.qty, accepted_qty: it.qty, rejected_qty: 0, rework_qty: 0, defect_reason: '' };
  });
  S.receive(d1.id, {
    receive_date: D(-6), handover_by: '外协厂 A · 送货员老陈', received_by: '仓管 李梅', inspected_by: 'QC 王倩',
    inspect_result: 'conditional', remark: 'B4 有 4 件不良、2 件返工',
    // 短数 2：B4 发了 20 只回 18，声明污损不再补
    short_qty: 2, short_reason: '外协厂自述裁片污损 2 件，已拍照确认，不再补送',
    items: recItems
  }, op);
  S.close(d1.id, { loss_reason: 'B4 裁片污损 2 件，外协已确认不再补，按短数结案' }, op);

  // ---- ② 已发出逾期未回 ----
  const d2 = S.create({
    cut_order_id: cut.id, factory_id: fB.id, out_date: D(-8), expect_return_date: D(-3),
    price: 9.5, note: '第二批外发（2 扎），已过约定回货日', demo_tag: TAG,
    bundle_ids: [byNo('DQDEMO-B2').id, byNo('DQDEMO-B6').id]
  }, op);
  S.send(d2.id, op);

  // ---- ③ 草稿待发出 ----
  const d3 = S.create({
    cut_order_id: cut.id, factory_id: fA.id, out_date: D(0), expect_return_date: D(7),
    price: 8, note: '第三批（1 扎），还没送走', demo_tag: TAG,
    bundle_ids: [byNo('DQDEMO-B7').id]
  }, op);

  console.log(`[1] 裁剪单 ${cut.cut_no}：${bundleCnt} 扎 / ${bundleQty} 件（其中 1 扎未复核）`);
  const fin = S.detail(d1.id);
  console.log(`[2] ${fin.dispatch_no} 已结案：发 ${fin.out_qty} → 回 ${fin.returned_qty}（合格 ${fin.accepted_qty} / 不良 ${fin.rejected_qty} / 返工 ${fin.rework_qty}），差异 ${fin.loss_qty}，未回 ${fin.open_qty}，加工费 ¥${fin.amount}`);
  console.log(`[3] ${d2.dispatch_no} 已发出（约定 ${D(-3)} 回货，已逾期）`);
  console.log(`[4] ${d3.dispatch_no} 草稿待发出（${d3.out_qty} 件）`);
  return { cut, d1, d2, d3 };
}

(function main() {
  if (reset) { clean(); console.log('[0] 已清理旧演示数据'); }
  else {
    const exists = db.prepare('SELECT COUNT(*) c FROM cut_dispatches WHERE demo_tag = ?').get(TAG).c;
    if (exists) { console.log('演示数据已存在；要重放请加 --reset'); return; }
  }
  const { cut, d1 } = seed();

  const b = S.board({});
  console.log(`\n--- 外发看板 ---`);
  console.log(`  批次 ${b.stat.count} / 在途 ${b.stat.open} / 发出 ${b.stat.out_qty} / 已回 ${b.stat.returned_qty} / 合格 ${b.stat.accepted_qty} / 不良 ${b.stat.rejected_qty} / 差异 ${b.stat.loss_qty}`);
  console.log(`  验收合格率 ${b.stat.accept_rate}% / 加工费 ¥${b.stat.amount}`);
  console.log(`  逾期未回 ${b.overdue.length} 张：${b.overdue.map((x) => `${x.dispatch_no} 逾 ${x.days} 天（未回 ${x.open_qty}）`).join('；') || '无'}`);
  console.log(`  外协合格率排名：${b.factories.map((f) => `${f.factory_name} ${f.rate}%${f.rankable ? '' : '（样本不足不排名）'}`).join(' / ')}`);

  // 自检：验收三分闭合
  const bad = db.prepare(
    `SELECT d.dispatch_no FROM cut_dispatches d
     WHERE d.status IN ('partial','returned','closed')
       AND ABS(d.accepted_qty + d.rejected_qty + d.rework_qty - d.returned_qty) > 0.02`
  ).all();
  console.log(`\n验收三分闭合自检：${bad.length ? '不闭合 ' + bad.map((x) => x.dispatch_no).join(',') : '全部闭合'}`);
  console.log('演示数据就绪。');
})();
