/**
 * 供应商评价演示数据（原型 TS-N07-05）
 *   node scripts/seed-supplier-eval.js           # 增量生成
 *   node scripts/seed-supplier-eval.js --reset   # 先清掉本脚本造过的数据
 *
 * 造的是「观察期 2026-07-01 ~ 2026-09-30 的历史交付」：
 *   采购单（有承诺日）+ 收料单（实际到货日、合格/冻结/退回、短收超收）
 * 评价本身走 API 生成（scripts/eval-supplier-demo.js），确保样本口径与生产一致。
 *
 * 五家供应商刻意造出四种状态：
 *   明发织造     6 单全准交、零不良        → A 维持合格
 *   正邦布业     5 单 2 迟、退回多         → C 需整改
 *   蓝雨辅料     4 单全准交、轻微不良      → B 合格
 *   蒙特布料     3 单 1 迟、短收           → B/C 边界
 *   恒泰制衣厂   5 单 3 迟、退回率高       → D 暂停新单
 *   晟彩数码     2 单                      → 样本不足，不排名
 */
const { db, now } = require('../src/db');

const DEMO = '演示历史交付';

if (process.argv.includes('--reset')) {
  const grns = db.prepare('SELECT id FROM goods_receipts WHERE remark = ?').all(DEMO).map((x) => x.id);
  if (grns.length) {
    const list = grns.join(',');
    db.prepare(`DELETE FROM goods_receipt_items WHERE grn_id IN (${list})`).run();
    db.prepare(`DELETE FROM goods_receipt_actions WHERE grn_id IN (${list})`).run();
    db.prepare(`DELETE FROM goods_receipts WHERE id IN (${list})`).run();
  }
  const pos = db.prepare('SELECT id FROM purchase_orders WHERE remark = ?').all(DEMO).map((x) => x.id);
  if (pos.length) {
    const list = pos.join(',');
    db.prepare(`DELETE FROM purchase_items WHERE po_id IN (${list})`).run();
    db.prepare(`DELETE FROM purchase_orders WHERE id IN (${list})`).run();
  }
  db.prepare('DELETE FROM supplier_evaluations').run();
  db.prepare('DELETE FROM supplier_rectifications').run();
  db.prepare('DELETE FROM supplier_backups').run();
  db.prepare('DELETE FROM supplier_qualifications').run();
  console.log(`已清理：收料单 ${grns.length} 张、采购单 ${pos.length} 张、评价/整改/备用/资格全部清空`);
}

const H = [
  // supplier_id, 物料, 规格, 单位, 数量, 单价, 下单日, 承诺日, 到货日, 合格, 冻结, 退回, 短收, 超收
  // 明发织造：全准交零不良
  [1, '32S 精梳拉架', '190G/165cm', '公斤', 600, 26.5, '2026-07-03', '2026-07-10', '2026-07-09', 600, 0, 0, 0, 0],
  [1, '40S 双纱汗布', '200G/170cm', '公斤', 820, 28.0, '2026-07-20', '2026-07-28', '2026-07-27', 820, 0, 0, 0, 0],
  [1, '32S 精梳拉架', '190G/165cm', '公斤', 540, 26.5, '2026-08-05', '2026-08-12', '2026-08-12', 540, 0, 0, 0, 0],
  [1, '罗纹 2×2', '260G/70cm', '公斤', 260, 31.0, '2026-08-18', '2026-08-25', '2026-08-24', 260, 0, 0, 0, 0],
  [1, '32S 精梳拉架', '190G/165cm', '公斤', 700, 26.2, '2026-09-04', '2026-09-11', '2026-09-10', 700, 0, 0, 0, 0],
  [1, '40S 双纱汗布', '200G/170cm', '公斤', 480, 28.0, '2026-09-22', '2026-09-29', '2026-09-29', 480, 0, 0, 0, 0],

  // 正邦布业：2 迟 + 退回多
  [2, '2099# 极蓝棉', '220G/160cm', '米', 900, 18.5, '2026-07-06', '2026-07-14', '2026-07-17', 830, 10, 30, 0, 0],
  [2, '2099# 极蓝棉', '220G/160cm', '米', 760, 18.8, '2026-07-25', '2026-08-02', '2026-08-02', 760, 0, 0, 0, 0],
  [2, '320G 卫衣布', '320G/185cm', '公斤', 640, 24.0, '2026-08-10', '2026-08-18', '2026-08-23', 560, 20, 30, 0, 0],
  [2, '2099# 极蓝棉', '220G/160cm', '米', 880, 18.6, '2026-09-02', '2026-09-10', '2026-09-10', 880, 0, 0, 0, 0],
  [2, '320G 卫衣布', '320G/185cm', '公斤', 520, 24.2, '2026-09-18', '2026-09-26', '2026-09-26', 480, 0, 20, 0, 0],

  // 蓝雨辅料：全准交，轻微不良
  [4, '织唛主标', '30×50mm', '个', 8000, 0.35, '2026-07-08', '2026-07-12', '2026-07-12', 7960, 0, 40, 0, 0],
  [4, '洗水标', '30×80mm', '个', 9000, 0.12, '2026-08-02', '2026-08-06', '2026-08-05', 9000, 0, 0, 0, 0],
  [4, '五爪扣', '15mm 黑色', '套', 6000, 0.28, '2026-08-26', '2026-08-30', '2026-08-30', 5950, 0, 50, 0, 0],
  [4, '织唛主标', '30×50mm', '个', 7500, 0.34, '2026-09-16', '2026-09-20', '2026-09-19', 7500, 0, 0, 0, 0],

  // 蒙特布料：1 迟 + 短收
  [3, '鱼鳞布 150D', '150D/160cm', '米', 1200, 12.8, '2026-07-10', '2026-07-18', '2026-07-20', 1180, 0, 0, 20, 0],
  [3, '鱼鳞布 150D', '150D/160cm', '米', 1000, 12.8, '2026-08-14', '2026-08-22', '2026-08-22', 1000, 0, 0, 0, 0],
  [3, '摇粒绒 260G', '260G/170cm', '公斤', 700, 21.5, '2026-09-08', '2026-09-16', '2026-09-15', 700, 0, 0, 0, 0],

  // 恒泰制衣厂：3 迟 + 退回高（成衣加工）
  [6, '成衣加工 2099#', 'M/L/XL', '件', 800, 22.0, '2026-07-02', '2026-07-27', '2026-07-31', 700, 20, 80, 0, 0],
  [6, '成衣加工 2099#', 'M/L/XL', '件', 600, 22.0, '2026-07-28', '2026-08-22', '2026-08-22', 600, 0, 0, 0, 0],
  [6, '成衣加工 320G', 'M/L/XL', '件', 500, 26.0, '2026-08-12', '2026-09-06', '2026-09-13', 420, 30, 50, 0, 0],
  [6, '成衣加工 2099#', 'M/L/XL', '件', 700, 22.0, '2026-09-01', '2026-09-26', '2026-09-29', 660, 0, 40, 0, 0],
  [6, '成衣加工 320G', 'M/L/XL', '件', 400, 26.0, '2026-09-15', '2026-09-28', '2026-09-28', 400, 0, 0, 0, 0],

  // 晟彩数码：只有 2 单（样本不足）
  [5, '数码印花 2099#', '前片 A3', '件', 600, 4.2, '2026-08-06', '2026-08-12', '2026-08-11', 600, 0, 0, 0, 0],
  [5, '数码印花 320G', '后背 A4', '件', 400, 5.6, '2026-09-10', '2026-09-16', '2026-09-16', 400, 0, 0, 0, 0]
];

const t = now();
let seqPo = Number(db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE remark = ?").get(DEMO).c) + 1;
let seqGrn = Number(db.prepare("SELECT COUNT(*) c FROM goods_receipts WHERE remark = ?").get(DEMO).c) + 1;

const insPo = db.prepare(
  'INSERT INTO purchase_orders (po_no, supplier, supplier_id, status, order_date, expect_date, remark, total_amount, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
);
const insItem = db.prepare('INSERT INTO purchase_items (po_id, material_id, name, spec, unit, qty, price, amount, received_qty) VALUES (?,?,?,?,?,?,?,?,?)');
const insGrn = db.prepare(
  `INSERT INTO goods_receipts (grn_no, po_id, po_no, supplier, supplier_id, receive_date, warehouse, status,
    line_count, expect_qty, receive_qty, pending_qty, pass_qty, freeze_qty, reject_qty, over_qty, short_qty,
    receive_by, receive_at, inspect_by, inspect_at, remark, created_by, created_at, updated_at)
   VALUES (?,?,?,?,?,?, '原料库', ?, 1, ?,?,0,?,?,?,?,?, '系统导入',?, '质检组',?, ?, 'system', ?, ?)`
);

db.exec('BEGIN');
try {
  H.forEach((h) => {
    const [sid, name, spec, unit, qty, price, orderDate, expectDate, recvDate,
      pass, freeze, reject, short, over] = h;
    const sup = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(sid);
    const recvQty = pass + freeze + reject;

    const poNo = `CG${orderDate.replace(/-/g, '')}H${String(seqPo).padStart(3, '0')}`;
    const poInfo = insPo.run(poNo, sup.name, sid, 'received', orderDate, expectDate, DEMO,
      Math.round(qty * price * 100) / 100, 1, t, t);
    const poId = Number(poInfo.lastInsertRowid);
    insItem.run(poId, null, name, spec, unit, qty, price, Math.round(qty * price * 100) / 100, recvQty);

    const grnNo = `GRN${recvDate.replace(/-/g, '')}H${String(seqGrn).padStart(3, '0')}`;
    insGrn.run(grnNo, poId, poNo, sup.name, sid, recvDate,
      pass + freeze + reject === 0 ? 'pending' : (freeze + reject > 0 ? 'partial' : 'passed'),
      recvQty + short, recvQty, pass, freeze, reject, over, short,
      t, t, DEMO, t, t);
    seqPo++; seqGrn++;
  });
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const stat = db.prepare(
  `SELECT s.name, COUNT(g.id) AS grns, SUM(g.reject_qty) AS rej, SUM(g.freeze_qty) AS frz
   FROM suppliers s LEFT JOIN goods_receipts g ON g.supplier_id = s.id AND g.remark = ?
   GROUP BY s.id ORDER BY s.id`
).all(DEMO);
stat.forEach((r) => console.log(`  ${r.name}: ${r.grns} 张收料单，退回 ${r.rej || 0}，冻结 ${r.frz || 0}`));
console.log(`\n完成：采购单 ${H.length} 张 / 收料单 ${H.length} 张（观察期 2026-07-01 ~ 2026-09-30）`);
