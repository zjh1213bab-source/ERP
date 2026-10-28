/**
 * 上线检查清单 —— 演示数据
 *
 * 造两轮评估，刻意做成「一轮被拦住、一轮还在评估」：
 *
 *   第 1 轮  演示库交付口径，人工项全部验完，结论 **暂不上线**（no_go）
 *            理由是真的：12 个账号还在用示例密码、9 个业务账号没绑员工、JWT 密钥是示例值。
 *            这一轮存在的意义是——**它真的拦住了一次上线**，并且留下了冻结快照。
 *
 *   第 2 轮  正式上线口径，人工项勾了一部分，仍被阻塞项挡住，停在「有阻塞」。
 *            这一轮是「现在打开页面看到的样子」。
 *
 * 为什么演示数据不造「已通过」的假结论：
 * 一张全绿的清单什么都演示不了。真实的库现在就是过不了（默认密码、演示数据、示例密钥），
 * 把这事如实做进演示数据，比造一张漂亮的绿灯图有用得多。
 */
const { db, now } = require('../src/db');
const S = require('../src/services/goLive');

const MARK = 'DEMO-GOLIVE';
const t = now();

/* ---------------- 清理 ---------------- */
const clean = () => {
  const rounds = db.prepare('SELECT id FROM golive_rounds WHERE demo_tag = ?').all(MARK).map((r) => r.id);
  rounds.forEach((id) => db.prepare('DELETE FROM golive_items WHERE round_id = ?').run(id));
  db.prepare('DELETE FROM golive_rounds WHERE demo_tag = ?').run(MARK);
  return rounds.length;
};
const cleaned = clean();

/** 按 item_key 找本轮某一项 */
const itemsOf = (roundId) => db.prepare('SELECT * FROM golive_items WHERE round_id = ? ORDER BY sort').all(roundId);
const byKey = (roundId, key) => itemsOf(roundId).find((x) => x.item_key === key);

/** 人工项判定（带证据） */
function done(roundId, key, status, payload) {
  const it = byKey(roundId, key);
  if (!it) return;
  S.setManual(it.id, { status, ...payload }, '行政主管');
}

const pad = (n) => String(n).padStart(2, '0');
const dayStr = (offset) => {
  const d = new Date(Date.now() + offset * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/* ============================================================
 * 第 1 轮：演示库交付（已完成评估 → 结论「暂不上线」）
 * ============================================================ */
const r1 = S.buildRound({
  scope: 'demo',
  env_label: '演示库 · 客户演示环境',
  plan_date: dayStr(-2),
  app_version: '1.42.0'
}, '行政主管');

// 人工项全部验完
done(r1.id, 'matrix_signoff', 'pass', {
  evidence: '《岗位权限矩阵 v1.42》签署件 · 档号 QX-2026-018；销售/技术/生产/仓库/财务/人事六岗负责人均已签字',
  owner: '行政主管', result: '六岗负责人签字确认，争议点 3 项当场调整（销售不可见成本、仓管不可作废凭证、技术不可改价）'
});
done(r1.id, 'rollback_plan', 'pass', {
  evidence: '上一版发布包 erp-mindmap-v1.42.0-20261028.zip + 库备份 BK20261028-02.db（10.9 MB）已归档到 packages/',
  owner: 'IT 运维', result: '代码、前端产物、数据库三样均已留底，回滚脚本 deploy/rollback.sh 试跑通过'
});
done(r1.id, 'opening_confirmed', 'pass', {
  evidence: '期初库存表 QC-2026-10-009 / 应收应付对账表 DZ-2026-10-011 / 试算平衡表 SS-2026-10-003',
  owner: '财务主管', result: '库存 61 项全部盘到实物、往来 31 户对账无差异、试算平衡差额 0.00'
});
done(r1.id, 'app_version', 'pass', {
  evidence: '页面底部 v1.42.0，与交付包 erp-mindmap-v1.42.0-20261028.zip 一致',
  owner: 'IT 运维', result: '版本号核对一致'
});
done(r1.id, 'switch_window', 'pass', {
  evidence: '切换窗口 2026-11-01 20:00–23:00（周日，不接单不发货）；值守 11-01 至 11-04 三班',
  owner: '运营总监', result: '切换期间停止接单；值守人：11/1 张工、11/2 李工、11/3-4 行政主管待命'
});
done(r1.id, 'manual_signoff', 'pass', {
  evidence: '七册签收记录：销售 6/6、技术 4/4、生产 8/8、仓库 5/5、财务 4/4、人事 3/3、管理员 2/2',
  owner: '行政主管', result: '分册全部签收，另有 2 名新员工安排在 11 月首周补训'
});
done(r1.id, 'key_training', 'pass', {
  evidence: '实操演练记录 LX-2026-10-006：接单→技术确认→开料→报工→验货→入库→发货→收款 全链路走通',
  owner: '运营总监', result: '5 个关键岗位各 1 人完成全链路演练，卡点 2 处（尺码表录入、验货不合格判定）已修复'
});
done(r1.id, 'parallel_run', 'pass', {
  evidence: '并行计划 BH-2026-11：11/1–11/30 与旧系统并行，以新系统为准，差异登记在《并行差异台账》',
  owner: '运营总监', result: '并行一个完整账期，每周五核对一次差异并归零'
});
done(r1.id, 'account_issue', 'pass', {
  evidence: '开通名单 KH-2026-10-021（32 个账号）；初始密码当面交付，首次登录强制改密已在系统内开启',
  owner: '行政主管', result: '32 个账号名单已确认，密码当面/企业微信单发，不写纸面名单'
});
done(r1.id, 'contact_list', 'pass', {
  evidence: '一线支持 张工 138****6621 / 系统负责人 李工 / 决策人 运营总监；升级：30 分钟无响应直呼负责人',
  owner: 'IT 运维', result: '三级联系人与 30 分钟升级阈值已确认'
});

// 签署：被阻塞项拦住 → 只能暂不上线（这正是这一轮的价值）
let r1Final = null;
try {
  r1Final = S.sign(r1.id, {
    conclusion: 'no_go',
    note: '数据与流程层面已具备条件，但账号仍在用示例密码（12 个）、9 个业务账号未绑定员工、JWT 密钥为示例值。'
      + '这三项都属于「上线即等于对外开门」，整改完成后重新评估。'
  }, '运营总监');
} catch (e) {
  console.log('第 1 轮签署失败：' + e.message);
}
db.prepare('UPDATE golive_rounds SET demo_tag = ? WHERE id = ?').run(MARK, r1.id);

/* ============================================================
 * 第 2 轮：正式上线（当前进度：评估中，被阻塞）
 * ============================================================ */
const r2 = S.buildRound({
  scope: 'production',
  env_label: '生产环境 · 跳色科技总部',
  plan_date: dayStr(4),
  app_version: '1.43.0'
}, '行政主管');

// 只勾了一部分：证明「进度是可以中途保存的」，也让人看到证据该写成什么样
done(r2.id, 'rollback_plan', 'pass', {
  evidence: 'erp-mindmap-v1.43.0-20261028.zip + clean-backup-1793185321508.db 已归档',
  owner: 'IT 运维', result: '发布包与库备份已留底，回滚脚本待 11/1 试跑'
});
done(r2.id, 'opening_confirmed', 'na', {
  na_reason: '本次是逐模块分批上线，期初数据在 9 月首启时已三方签认（SS-2026-09-002），本期不重复导入期初',
  owner: '财务主管', result: '沿用 9 月期初，不重新导入'
});
done(r2.id, 'manual_signoff', 'fail', {
  evidence: '七册签收：销售 6/6、技术 4/4、生产 5/8、仓库 5/5、财务 4/4、人事 3/3、管理员 2/2',
  owner: '行政主管', result: '生产册还有 3 人未签收（3 名新入职车工，11 月首周补）'
});
done(r2.id, 'switch_window', 'pass', {
  evidence: '切换窗口 2026-11-01 20:00–23:00；值守 72 小时排班表 ZS-2026-11',
  owner: '运营总监', result: '窗口与值守已定，切换期间停止接单'
});
db.prepare('UPDATE golive_rounds SET demo_tag = ? WHERE id = ?').run(MARK, r2.id);

/* ---------------- 结果 ---------------- */
const rounds = db.prepare('SELECT * FROM golive_rounds WHERE demo_tag = ? ORDER BY id').all(MARK);
console.log(cleaned ? `已清理旧演示轮次 ${cleaned} 轮` : '首次生成，无旧数据');
rounds.forEach((r) => {
  const items = itemsOf(r.id);
  const auto = items.filter((x) => x.kind === 'auto');
  const manual = items.filter((x) => x.kind === 'manual');
  console.log(`\n${r.round_no} · ${r.scope === 'demo' ? '演示库交付' : '正式上线'} · ${r.status}`
    + (r.conclusion ? ` · ${r.conclusion}` : ''));
  console.log(`  自动 ${auto.filter((x) => x.status === 'pass').length}/${auto.length} 通过`
    + `，人工 ${manual.filter((x) => ['pass', 'fail', 'na'].includes(x.status)).length}/${manual.length} 已验`
    + `，阻塞项 ${r.blocker_open}`);
  const blockers = items.filter((x) => x.severity === 'blocker' && ['fail', 'pending', 'warn'].includes(x.status));
  blockers.forEach((b) => console.log(`   ⛔ ${b.title} :: ${(b.result || '').slice(0, 70)}`));
  if (r.snapshot) console.log(`   冻结快照 ${JSON.parse(r.snapshot).items.length} 项，签署人 ${r.signed_by}`);
});
console.log('\n第 1 轮签署结果：' + (r1Final ? `已签「${r1Final.conclusion_label}」` : '未签（被阻塞项拦住）'));
console.log('提示：第 1 轮之所以「暂不上线」，是因为默认密码/绑定员工/密钥三项真的没过 —— 这不是假数据。');
