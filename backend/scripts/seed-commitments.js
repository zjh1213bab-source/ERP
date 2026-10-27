/**
 * 初始化交期承诺演示数据
 *   node scripts/seed-commitments.js
 *
 * 规则：
 *   已开工/已完成的老单 → 补历史评审（approved），节点按订单状态推进到对应位置
 *   草稿单 → 保持待评审，用来演示真实评审流程
 *   其中一单给出很紧的承诺日，用来演示「预测超期」红色预警
 */
const path = require('path');
const { db, now } = require('../src/db');
const { ensureCommitment, reforecast } = require('../src/routes/commitments');

const addDays = (d, n) => {
  const x = new Date(String(d).slice(0, 10) + 'T00:00:00');
  x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
};

/** 订单状态 → 节点推进到第几个 */
const PROGRESS = {
  assigned: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'],
  production: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'B1'],
  instock: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'B1', 'H1', 'H2'],
  shipped: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'B1', 'H1', 'H2', 'E1'],
  closed: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'B1', 'H1', 'H2', 'E1']
};

const orders = db.prepare('SELECT * FROM orders ORDER BY id').all();
let made = 0;

for (const o of orders) {
  const c = ensureCommitment(o.id, null, 'system');
  if (!c) continue;
  made++;
  const isDraft = o.status === 'draft';
  const t0 = c.t0_at || String(o.created_at || now()).slice(0, 10);

  if (isDraft) {
    // 草稿单保持待评审；订单 5 给一个很紧的承诺日，评审后会立刻暴露超期风险
    if (o.id === 5) {
      db.prepare("UPDATE commitments SET promised_date = ?, review_status = 'pending' WHERE id = ?")
        .run(addDays(t0, 10), c.id);
    }
    continue;
  }

  const promised = o.delivery_date || addDays(t0, 30);
  const reach = PROGRESS[o.status] || PROGRESS.assigned;

  // 历史单补评审（三项都确认过，属补录）
  db.prepare(
    `UPDATE commitments SET front_ok = 1, back_ok = 1, material_ok = 1, promised_date = ?,
      review_status = 'approved', review_note = ?, reviewed_by = 'system', reviewed_at = ?
     WHERE id = ?`
  ).run(promised, '历史订单补录：已开工/已交付，按当时承接情况补评审记录', now(), c.id);

  // 节点推进：按顺序给实绩，实际完工日按计划日 ± 0~2 天
  const nodes = db.prepare('SELECT * FROM commitment_nodes WHERE commitment_id = ? ORDER BY seq').all(c.id);
  nodes.forEach((n) => {
    if (!reach.includes(n.code)) return;
    const drift = (n.seq % 3) - 1; // -1 / 0 / 1，制造一点真实波动
    const end = n.end_date ? addDays(n.end_date, drift) : null;
    db.prepare(
      `UPDATE commitment_nodes SET status = 'done', actual_start = ?, actual_end = ?, delay_days = ?, owner = ?
       WHERE id = ?`
    ).run(n.start_date || null, end, drift > 0 ? drift : 0, n.code.startsWith('P') ? '仓库' : '车间', n.id);
  });

  if (o.status === 'shipped' || o.status === 'closed') {
    const ship = addDays(promised, -3);
    db.prepare('UPDATE commitments SET actual_ship_date = ? WHERE id = ?').run(ship, c.id);
  }
  reforecast(c.id);
}

console.log(`已为 ${made} 张订单初始化交期承诺`);

const rows = db.prepare('SELECT order_no, review_status, risk_level, promised_date, forecast_date, delay_days FROM commitments ORDER BY id').all();
rows.forEach((r) => console.log(' ', r.order_no, '| 评审', r.review_status, '| 风险', r.risk_level, '| 承诺', r.promised_date, '| 预测', r.forecast_date, '| 延期', r.delay_days));

const stat = db.prepare("SELECT risk_level, COUNT(*) c FROM commitments GROUP BY risk_level").all();
console.log('风险分布:', stat.map((x) => `${x.risk_level}=${x.c}`).join(' '));
