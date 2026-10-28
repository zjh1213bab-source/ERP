/**
 * 流程变更发布与审计：演示数据
 * ========================================================================
 * 留下两种状态各一条，正好演示「已发布」与「试运行完待发布」的差别：
 *   A. 成本审批：加一级「成本复核」→ 试运行 → 发布（v2 生效）
 *   B. 付款审批：把总经理终审改成「财务总监终审 + 总经理」→ 只试运行，留在待发布
 *
 * 幂等：已有同名变更就跳过，重复跑不会堆数据。
 * 清理：`--clean` 会把本脚本建的变更与版本回退掉（回滚到 v1 并删草稿）。
 */
const { db } = require('../src/db');
const F = require('../src/services/flowChange');

const COST = 'cost::成本审批（默认）';
const PAY = 'payment::付款审批（默认：财务审核 → 总经理）';

const exists = (title) => db.prepare('SELECT id FROM flow_changes WHERE title = ?').get(title);

function clean() {
  ['成本审批加一级成本复核', '付款审批改为财务总监终审'].forEach((title) => {
    const c = exists(title);
    if (!c) return;
    // 已发布的先回滚，再删草稿/版本
    const row = db.prepare('SELECT * FROM flow_changes WHERE id = ?').get(c.id);
    try {
      if (row.status === 'published') F.rollback(c.id, { reason: '演示数据清理：回滚到上一版', operator: '系统' });
    } catch (e) { /* 已经不是最近一次发布，忽略 */ }
    const after = db.prepare('SELECT * FROM flow_changes WHERE id = ?').get(c.id);
    if (after.to_version_id) {
      db.prepare("DELETE FROM flow_versions WHERE id = ? AND status IN ('draft','trial','rolled_back')").run(after.to_version_id);
    }
    db.prepare('DELETE FROM flow_audits WHERE change_no = ?').run(row.change_no);
    db.prepare('DELETE FROM flow_changes WHERE id = ?').run(c.id);
  });
  console.log('演示变更已清理');
}

if (process.argv.includes('--clean')) {
  clean();
  process.exit(0);
}

clean();

/* ---------- A. 成本审批：试运行 → 发布 ---------- */
if (!exists('成本审批加一级成本复核')) {
  const a = F.createChange({
    flow_key: COST,
    title: '成本审批加一级成本复核',
    reason: '上季度出现两笔成本单算错材料用量，财务初审没发现，需要在终审前加一道成本复核',
    impact_nodes: '成本单审核、订单分单',
    steps: [
      { role: 'finance', name: '财务初审', sla_hours: 8, escalate_to: 'admin' },
      { role: 'finance', name: '成本复核', sla_hours: 8, escalate_to: 'admin' },
      { role: 'admin', name: '总经理终审', sla_hours: 24, escalate_to: 'admin' }
    ],
    created_by: '系统管理员'
  });
  F.trial(a.id, { days: 180, operator: '系统管理员' });
  F.publish(a.id, { effective_from: new Date().toISOString().slice(0, 10), migration_mode: 'keep_old', operator: '系统管理员' });
  console.log(`A. 成本审批已发布 v2（${a.change_no}）`);
}

/* ---------- B. 付款审批：只试运行 ---------- */
if (!exists('付款审批改为财务总监终审')) {
  const b = F.createChange({
    flow_key: PAY,
    title: '付款审批改为财务总监终审',
    reason: '总经理审批积压严重，付款经常卡 3 天以上，改成财务总监终审后由总经理抽查',
    impact_nodes: '付款申请审批、出纳付款',
    steps: [
      { role: 'finance', name: '财务审核', sla_hours: 8, escalate_to: 'admin' },
      { role: 'finance', name: '财务总监终审', sla_hours: 12, escalate_to: 'admin' }
    ],
    created_by: '系统管理员'
  });
  F.trial(b.id, { days: 180, operator: '系统管理员' });
  console.log(`B. 付款审批已试运行，待发布（${b.change_no}）`);
}

/* ---------- 汇总 ---------- */
const flows = F.listFlows();
console.log('\n流程现状：');
flows.forEach((f) => console.log(`  ${f.flow_key} → v${f.current ? f.current.version_no : '-'}（在途 ${f.inflight} 单，${f.version_count} 个版本）`));
const chg = F.listChanges({});
console.log(`变更单 ${chg.length} 条：`);
chg.forEach((c) => console.log(`  ${c.change_no} ${c.status_label} · ${c.title}`));
