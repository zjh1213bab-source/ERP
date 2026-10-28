/**
 * 计件工资 · 演示数据
 * ============================================================
 * 做两件事：
 *   1. 灌工序单价（通用价 + 一条款专属价，体现「款专属优先」与生效日版本）
 *   2. 把上一轮造的「演示·扎级进度」报工按「扎 × 工序」整组分给生产部员工
 *      —— 同扎同工序由一个人做完，符合车间实际；留最后一组不分配，
 *         用来演示「无法归属」清单（现实里总有临时工没建档）
 *
 * 用法：node scripts/seed-piecewage-demo.js [--reset]
 * 幂等：单价按 note 前缀删了重建；报工的归属只改 employee_id 为空的行。
 */
const { db, now } = require('../src/db');

// 备注写真实业务文案（页面上要像真的工价表），清理靠 created_by
const SEED_BY = '演示数据';
const NOTE = '2026 秋冬基础工价';

const RATES = [
  // 通用工序单价（元/件）
  ['备料', 0.35], ['排版算料', 0.2], ['裁剪', 0.6], ['车缝', 2.8],
  ['锁眼钉扣', 0.45], ['整烫', 0.5], ['水洗', 0.8], ['印花', 1.2],
  ['绣花', 1.5], ['检验', 0.3], ['包装', 0.25], ['成品入库', 0.15], ['出库发运', 0.2]
];

function main() {
  const t = now();

  // 重放：把上一轮分出去的归属清回来（否则再跑一次只会剩 1 条可分配）
  if (process.argv.includes('--reset')) {
    const back = db
      .prepare(
        "UPDATE production_reports SET employee_id = NULL, operator = '演示数据' WHERE remark = '演示·扎级进度'"
      )
      .run().changes;
    console.log('重置演示报工归属', back, '条');
  }

  // ---------- 1. 单价 ----------
  const removed = db.prepare('DELETE FROM piece_rates WHERE created_by = ?').run(SEED_BY).changes;
  if (removed) console.log('清理旧演示单价', removed, '条');

  const insRate = db.prepare(
    `INSERT INTO piece_rates (style_no, process_name, unit_price, currency, effective_from, effective_to, status, note, created_by, created_at, updated_at)
     VALUES (?,?,?, 'CNY', ?, NULL, 'active', ?, ?, ?, ?)`
  );
  let n = 0;
  RATES.forEach(([name, price]) => {
    try {
      insRate.run(null, name, price, '2026-10-01', NOTE, SEED_BY, t, t);
      n++;
    } catch (e) {
      console.log('  跳过', name, e.message.slice(0, 40));
    }
  });
  // 款专属价：同工序比通用价高（工艺复杂），生效日晚于通用价 → 该款从 10-15 起用专属价
  try {
    insRate.run('LEJE-AW-2601', '车缝', 3.6, '2026-10-15', NOTE, SEED_BY, t, t);
    n++;
  } catch (e) {
    console.log('  跳过款专属价', e.message.slice(0, 40));
  }
  console.log(`灌入单价 ${n} 条（通用 ${RATES.length} + 款专属 1）`);

  // ---------- 2. 报工归人 ----------
  const emps = db
    .prepare(
      `SELECT e.id, e.code, e.name FROM employees e
        WHERE e.department_id = 4 AND e.status = 'active' AND e.name NOT LIKE '%测试%'
        ORDER BY e.id`
    )
    .all();
  if (!emps.length) {
    console.log('生产部没有在职员工，跳过分摊');
    return;
  }

  const rows = db
    .prepare(
      `SELECT id, order_id, bundle_no, node_name FROM production_reports
        WHERE remark = '演示·扎级进度' AND IFNULL(employee_id, 0) = 0
        ORDER BY order_id, bundle_no, node_name, id`
    )
    .all();
  if (!rows.length) {
    console.log('没有待归人的演示报工（可能已经分过）');
  } else {
    // 同「订单+扎+工序」整组给同一个人：一扎一道工序由一个人做完才符合实际
    const groups = new Map();
    rows.forEach((r) => {
      const k = `${r.order_id}|${r.bundle_no}|${r.node_name}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    const keys = [...groups.keys()];
    // 留第一组不分配：现实里总有临时工/外协没建档，正好演示「无法归属」。
    // 特意不挑最后一组 —— 最后一组是「车缝报 25 件 / 扎 20 件」的超报样本，
    // 留它会让「超报封顶」这条演示不出来。
    const assignable = keys.slice(1);
    const upd = db.prepare('UPDATE production_reports SET employee_id = ?, operator = ? WHERE id = ?');
    let cnt = 0;
    db.exec('BEGIN');
    try {
      assignable.forEach((k, i) => {
        const who = emps[i % emps.length];
        groups.get(k).forEach((r) => {
          upd.run(who.id, who.name, r.id);
          cnt++;
        });
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    console.log(`报工归人：${cnt} 条（${assignable.length} 组 / 共 ${keys.length} 组，留 1 组不归属）`);
    console.log('参与的员工：', emps.map((e) => e.name).join('、'));
  }

  // ---------- 3. 预演一遍 ----------
  const PW = require('../src/services/pieceWage');
  const p = PW.preview('2026-10');
  const s = p.summary;
  console.log('\n=== 2026-10 试算 ===');
  console.log(
    `可计件 ${s.items_count} 行 / ${s.employees_count} 人 | 数量 ${s.total_qty} 件 | 金额 ¥${s.total_amount}`
  );
  console.log(
    `缺单价 ${s.missing_rate_count} 条 | 无法归属 ${s.unassigned_count} 条 | 超报封顶 ${s.capped_count} 条 | 未记扎 ${s.no_bundle_count} 条`
  );
  console.log('按人：');
  p.by_employee.forEach((e) => console.log(`  ${e.employee_name}（${e.department}）${e.qty} 件 ¥${e.amount}`));
  if (p.diagnostics.missing_rate.length) {
    console.log('缺单价：', [...new Set(p.diagnostics.missing_rate.map((m) => m.process_name))].join('、'));
  }
  if (p.diagnostics.unassigned.length) {
    console.log('无法归属：', p.diagnostics.unassigned.map((u) => `${u.operator}/${u.process_name}/${u.qty}件`).join('；'));
  }
  if (p.diagnostics.capped.length) {
    console.log('超报：', p.diagnostics.capped.map((c) => `${c.bundle_no}/${c.process_name} 超 ${c.over}`).join('；'));
  }
}

main();
