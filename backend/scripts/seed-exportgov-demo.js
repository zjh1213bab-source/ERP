/**
 * 数据导出与订阅 演示数据
 * ========================================================================
 * 造出来的是**四类真实会发生的场景**，不是「好看的空表」：
 *
 *   1. 财务导了一次应收账龄（敏感、带水印、56 行）—— 事后能反查
 *   2. 销售导了一次客户名单（电话邮箱被掩成 138****8888）
 *   3. 人事导了一次工资汇总（工资类字段全掩，因为她没有 payroll.sensitive）
 *   4. 一条「每月 1 日应收账龄给财务」的订阅：**已到期但还没跑**（等页面点「执行到期」）
 *   5. 一条「每周一库存结存给仓库」的订阅：**已跑过，产出待领取**（站内可取）
 *   6. 一条「每月 25 日工资汇总给人事」的订阅：**已暂停**（人换了，先停掉）
 *
 * 邮件渠道的投递故意造一条 `blocked` —— 本部署没有 SMTP，假装发成功比不发更糟。
 *
 * 清理：`node scripts/seed-exportgov-demo.js --clean`
 * 所有记录带 demo_tag = 'DEMO'，清理只认这个标记，不碰真实导出记录。
 */

const { db } = require('../src/db');
const S = require('../src/services/exportGuard');

const MARK = 'DEMO';
const clean = process.argv.includes('--clean');

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function shift(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 清演示数据（导出记录是审计数据，只删带标记的） */
function cleanDemo() {
  const jobs = db.prepare("SELECT id FROM export_jobs WHERE demo_tag = ?").all(MARK).map((r) => r.id);
  if (jobs.length) {
    const ph = jobs.map(() => '?').join(',');
    db.prepare(`DELETE FROM export_deliveries WHERE job_id IN (${ph})`).run(...jobs);
    db.prepare(`DELETE FROM export_jobs WHERE id IN (${ph})`).run(...jobs);
  }
  db.prepare("DELETE FROM export_deliveries WHERE subscription_id IN (SELECT id FROM export_subscriptions WHERE demo_tag = ?)").run(MARK);
  db.prepare("DELETE FROM export_subscriptions WHERE demo_tag = ?").run(MARK);
  console.log('演示数据已清除');
}

if (clean) {
  cleanDemo();
  process.exit(0);
}

cleanDemo();

const users = db.prepare('SELECT id, username, name, role FROM users WHERE active = 1').all();
const U = (u) => users.find((x) => x.username === u) || users[0];
const asUser = (u) => ({ sub: u.id, username: u.username, name: u.name, role: u.role });

/* ---------------- 1. 手工导出：财务导应收 ---------------- */
const fin = U('fin01');
const hr = U('hr01');
const sales = U('sales01');
const wh = U('wh01');

const madeJobs = [];
function demoExport(username, defKey, params, reason) {
  const u = U(username);
  try {
    const r = S.runExport({
      def_key: defKey,
      params,
      reason,
      trigger: 'manual',
      user: asUser(u),
      ctx: { ip: '192.168.1.' + (20 + madeJobs.length), ua: 'Mozilla/5.0 (demo seed)' }
    });
    madeJobs.push(r.job);
    console.log(`导出 ${defKey}：${r.job.job_no} ${r.rowsCount} 行 掩码 ${r.maskedFields.length} 字段${r.suppressedRows ? ' 抑制 ' + r.suppressedRows + ' 组' : ''}`);
    return r;
  } catch (e) {
    console.log(`导出 ${defKey} 跳过：${e.message}`);
    return null;
  }
}

demoExport('fin01', 'ar_aging', { as_of: today() }, '月末与客户对账，需要未收明细');
demoExport('sales01', 'customer_list', {}, '业务交接，导出客户联系方式给新同事');
demoExport('hr01', 'payroll_summary', { period: today().slice(0, 7) }, '月度工资复核留底');
demoExport('wh01', 'stock_balance', {}, '仓库月度盘点基准表');
demoExport('admin', 'headcount_by_dept', {}, '编制会议：各部门人数分布（小样本已抑制）');

// 打演示标记
madeJobs.forEach((j) => {
  db.prepare('UPDATE export_jobs SET demo_tag = ? WHERE id = ?').run(MARK, j.id);
});

/* ---------------- 2. 订阅 ---------------- */
function mkSub(b) {
  try {
    const s = S.saveSubscription(b, asUser(U(b.owner)));
    db.prepare('UPDATE export_subscriptions SET demo_tag = ? WHERE id = ?').run(MARK, s.id);
    console.log(`订阅：${s.sub_no} ${s.name}（${s.schedule_text}，${s.channel_label}）`);
    return s;
  } catch (e) {
    console.log(`订阅跳过（${b.name}）：${e.message}`);
    return null;
  }
}

// A. 每月 1 日应收账龄给财务（邮件渠道 → 会落 blocked）—— 造「已到期未跑」
const subA = mkSub({
  name: '每月 1 日 · 应收账龄给财务',
  def_key: 'ar_aging',
  params: {},
  freq: 'monthly',
  day_of_month: 1,
  channel: 'email',
  recipients: ['fin01', 'boss01'],
  valid_from: shift(-60),
  valid_until: shift(365),
  note: '月初给财务与老板对账用，逾期名单要一起看',
  owner: 'fin01'
});
if (subA) {
  // 造一次「已经跑过」的历史产出，再把 next_run_at 拨到今天 → 页面显示「该跑了」
  try {
    S.runSubscription(subA.id, shift(-30));
    db.prepare("UPDATE export_deliveries SET demo_tag = ? WHERE subscription_id = ?").run(MARK, subA.id);
    db.prepare("UPDATE export_jobs SET demo_tag = ? WHERE subscription_id = ?").run(MARK, subA.id);
  } catch (e) {
    console.log('订阅历史产出跳过：' + e.message);
  }
  db.prepare("UPDATE export_subscriptions SET next_run_at = ?, run_count = 1 WHERE id = ?").run(shift(-1), subA.id);
}

// B. 每周一库存结存给仓库（站内可取）—— 已跑过一次，产出入库待领取
const subB = mkSub({
  name: '每周一 · 库存结存给仓库',
  def_key: 'stock_balance',
  params: {},
  freq: 'weekly',
  day_of_week: 1,
  channel: 'inbox',
  recipients: ['wh01'],
  valid_from: shift(-30),
  valid_until: shift(180),
  note: '周一早会前给仓库一份结存，用于跟生产对数量',
  owner: 'wh01'
});
if (subB) {
  try {
    S.runSubscription(subB.id, shift(-3));
    db.prepare("UPDATE export_deliveries SET demo_tag = ? WHERE subscription_id = ?").run(MARK, subB.id);
    db.prepare("UPDATE export_jobs SET demo_tag = ? WHERE subscription_id = ?").run(MARK, subB.id);
  } catch (e) {
    console.log('订阅产出跳过：' + e.message);
  }
}

// C. 每月 25 日工资汇总给人事 —— 已暂停（人换了）
const subC = mkSub({
  name: '每月 25 日 · 工资汇总给人事',
  def_key: 'payroll_summary',
  params: {},
  freq: 'monthly',
  day_of_month: 25,
  channel: 'inbox',
  recipients: ['hr01'],
  valid_from: shift(-90),
  valid_until: shift(200),
  note: '发薪前给人事一份汇总复核（原订阅人已换岗，暂停中）',
  owner: 'hr01'
});
if (subC) {
  db.prepare("UPDATE export_subscriptions SET status='paused', next_run_at=NULL WHERE id = ?").run(subC.id);
}

/* ---------------- 3. 结果 ---------------- */
const st = S.stats();
console.log('\n--- 结果 ---');
console.log(`导出记录 ${st.total} 条（本月 ${st.month_count} 条 / ${st.month_rows} 行，敏感以上 ${st.sensitive_count} 条）`);
console.log(`被掩码的字段行 ${st.masked_rows} 行，小样本抑制 ${st.suppressed_rows} 组`);
console.log(`订阅：${JSON.stringify(st.subs)}，到期未执行 ${st.due_subs} 条，待领取产出 ${st.pending_deliveries} 份`);
console.log(`下次打开 /export-center 点「执行到期订阅」即可看到产出。`);
