/**
 * 扎级完工进度 · 演示数据
 * ============================================================
 * 给一张有扎的订单，按扎造几组典型状态的报工：
 *   - 全流程走完（完工）
 *   - 走到车缝（在制）
 *   - 末道报了但不足件数（短数）
 *   - 某道超报（记错扎号的样子）
 * 剩下的保持未开工，方便看四种状态在一张表里。
 *
 * 用法：node scripts/seed-bundleprogress-demo.js [orderId]
 *
 * 注意：这里**直接写库**，绕过「首件未放行不许报工」的门禁 ——
 * 演示数据要的是四种状态齐全，不是流程合规。真实报工仍走接口校验。
 * 重复执行幂等（先删 remark 带标记的行）。
 */
const { db, now } = require('../src/db');
const { localDate } = require('../src/utils/time');

const TAG = '演示·扎级进度';

function main() {
  // 挑扎最多的订单
  let orderId = Number(process.argv[2]);
  if (!orderId) {
    const row = db
      .prepare(
        `SELECT co.order_id AS id, COUNT(b.id) n FROM cut_bundles b
           JOIN cut_orders co ON co.id = b.cut_order_id
          GROUP BY co.order_id ORDER BY n DESC LIMIT 1`
      )
      .get();
    if (!row) {
      console.log('库里没有扎包数据，先做「裁床与扎包」');
      process.exit(1);
    }
    orderId = row.id;
  }

  const order = db.prepare('SELECT id, order_no FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    console.log('订单不存在', orderId);
    process.exit(1);
  }

  const nodes = db.prepare('SELECT id, name, seq FROM order_nodes WHERE order_id = ? ORDER BY seq').all(orderId);
  const nodeOf = (name) => nodes.find((n) => n.name === name);
  const NEED = ['备料', '排版算料', '裁剪', '车缝', '锁眼钉扣', '整烫', '成品入库'];
  const missing = NEED.filter((n) => !nodeOf(n));
  if (missing.length) {
    console.log('该单缺少工序：', missing.join('、'), '；先在生产管理初始化工序');
    process.exit(1);
  }

  const bundles = db
    .prepare(
      `SELECT b.bundle_no, b.qty FROM cut_bundles b
         JOIN cut_orders co ON co.id = b.cut_order_id
        WHERE co.order_id = ? ORDER BY b.bundle_no`
    )
    .all(orderId);
  if (!bundles.length) {
    console.log('该订单没有扎');
    process.exit(1);
  }

  // 幂等：先清掉上次的演示报工
  const removed = db.prepare('DELETE FROM production_reports WHERE remark = ?').run(TAG).changes;
  console.log(`清理上次演示报工 ${removed} 条`);

  const today = localDate(now());
  const ins = db.prepare(
    `INSERT INTO production_reports
       (order_id, node_id, node_name, report_date, qty_ok, qty_defect, hours, operator, remark, created_at, bundle_no)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );

  const plan = [];
  // 1-3 扎：全流程完工
  bundles.slice(0, 3).forEach((b) => plan.push({ b, nodes: NEED, qty: b.qty }));
  // 4-8 扎：走到车缝（在制）
  bundles.slice(3, 8).forEach((b) => plan.push({ b, nodes: NEED.slice(0, 4), qty: b.qty }));
  // 9-10 扎：成品入库报了但短 2 件（短数）
  bundles.slice(8, 10).forEach((b) => plan.push({ b, nodes: NEED, qty: b.qty, lastDeficit: 2 }));
  // 11 扎：车缝超报（记错扎号的样子）
  if (bundles[10]) plan.push({ b: bundles[10], nodes: NEED.slice(0, 4), qty: bundles[10].qty, over: 5 });

  let inserted = 0;
  db.exec('BEGIN');
  try {
    plan.forEach(({ b, nodes: seq, qty, lastDeficit, over }) => {
      seq.forEach((name, idx) => {
        const node = nodeOf(name);
        let ok = Number(qty) || 0;
        if (lastDeficit && idx === seq.length - 1) ok = Math.max(0, ok - lastDeficit);
        if (over && name === '车缝') ok = (Number(qty) || 0) + over;
        ins.run(
          orderId,
          node.id,
          name,
          today,
          ok,
          // 短数与超报旁边给一点不良数，看起来更像真实记录
          Math.random() < 0.15 ? 1 : 0,
          0,
          '演示数据',
          TAG,
          now(),
          b.bundle_no
        );
        inserted++;
      });
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const bp = require('../src/services/bundleProgress');
  const p = bp.progressOf(orderId);
  console.log(`\n订单 ${order.order_no}：写入 ${inserted} 条带扎号报工`);
  console.log(
    `扎 ${p.summary.bundles}（${p.summary.total_qty} 件）| 完工 ${p.summary.done} | 在制 ${p.summary.doing} | 短数 ${p.summary.short}（差 ${p.summary.short_qty} 件）| 未开工 ${p.summary.idle} | 超报 ${p.summary.over}`
  );
  console.log(`末道工序：${p.summary.final_process} | 未归扎报工 ${p.summary.unassigned_reports} 条`);
  console.log('四种状态：', p.bundles.map((b) => `${b.bundle_no}:${b.status}${b.over ? '+over' : ''}`).join(' '));
}

main();
