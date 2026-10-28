/**
 * 应收催收演示数据
 *
 * 覆盖页面能看到的四种典型情形（都是真实催收里最常见的）：
 *   1. 客户已答应付款、还没到期        → promised
 *   2. 客户答应过但过了日子还没付       → escalated（跳票，页面标红）
 *   3. 联系过、对方在扯验收单           → following（有争议记录）
 *   4. 已经认定收不回、核销坏账         → closed
 *
 * 状态不是直接 UPDATE 出来的：承诺/跳票/结案都走服务层真实逻辑，
 * 只有「把承诺日挪到过去」这一步是改库模拟时间流逝（没法让服务器等一个月）。
 *
 * 用法：node scripts/seed-collection-demo.js [--reset]
 */
const { db, now } = require('../src/db');
const C = require('../src/services/collection');

const RESET = process.argv.includes('--reset');
const TAG = '演示·';
const t = now();

function cleanup() {
  const tasks = db.prepare("SELECT id FROM collection_tasks WHERE IFNULL(note,'') LIKE ?").all(TAG + '%').map((x) => x.id);
  tasks.forEach((id) => {
    db.prepare('DELETE FROM collection_logs WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM collection_task_items WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM collection_tasks WHERE id = ?').run(id);
  });
  return tasks.length;
}

const ymd = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

function main() {
  const removed = cleanup();
  console.log(`清理旧演示任务：${removed} 张\n`);
  if (RESET) return;

  const admin = { username: 'admin', role: 'admin' };
  const fin = { username: 'fin01', role: 'finance' };

  // ---------- 先按真实逾期全量生成 ----------
  const g = C.generate({ all: true, min_overdue_days: 1 }, fin);
  console.log(`生成任务 ${g.summary.created} 张，跳过 ${g.summary.skipped} 家`);
  g.skipped.forEach((x) => console.log(`  跳 ${String(x.customer_name).slice(0, 22)}：${x.reason}`));

  // 给本次生成 + 已存在的未结任务都打上演示标记，方便下次清理
  db.prepare(
    "UPDATE collection_tasks SET note = ? WHERE IFNULL(note,'') = '' AND status <> 'closed'"
  ).run(TAG + '应收催收演示数据');

  const open = db
    .prepare("SELECT * FROM collection_tasks WHERE status <> 'closed' AND IFNULL(note,'') LIKE ? ORDER BY remaining DESC")
    .all(TAG + '%');
  if (!open.length) {
    console.log('\n没有未结任务可加工（库里可能没有逾期应收）');
    return;
  }
  console.log(`\n可加工的未结任务 ${open.length} 张`);

  // ---------- 1. 客户答应付款（还没到期） ----------
  {
    const task = open[0];
    C.log(task.id, {
      channel: 'wechat',
      contact: '采购 Steve',
      result: 'promised',
      promise_date: ymd(6),
      promise_amount: Math.min(Number(task.remaining), 300000),
      note: `${TAG}客户财务确认本期对账单已签回，承诺本月内付清这部分`
    }, fin);
    console.log(`  ${task.task_no} ${String(task.customer_name).slice(0, 20)} → 已承诺（${ymd(6)}）`);
  }

  // ---------- 2. 承诺跳票 ----------
  if (open[1]) {
    const task = open[1];
    C.log(task.id, {
      channel: 'phone',
      contact: '老板本人',
      result: 'promised',
      promise_date: ymd(3),
      promise_amount: Number(task.remaining),
      note: `${TAG}对方口头答应月底前付清`
    }, fin);
    // 把承诺日推到过去，模拟「日子过了钱没到」——没法让服务器真等几天
    db.prepare('UPDATE collection_tasks SET promise_date = ? WHERE id = ?').run(ymd(-4), task.id);
    // 再记一条后续沟通（跳票后业务员又催了一次）
    C.log(task.id, {
      channel: 'phone',
      result: 'no_answer',
      note: `${TAG}承诺日后第四天再次联系，电话未接通；已发书面催款函`
    }, fin);
    db.prepare('UPDATE collection_tasks SET promise_date = ? WHERE id = ?').run(ymd(-4), task.id);
    C.refreshAll();
    const after = db.prepare('SELECT status FROM collection_tasks WHERE id = ?').get(task.id).status;
    console.log(`  ${task.task_no} ${String(task.customer_name).slice(0, 20)} → ${after === 'escalated' ? '承诺跳票（已升级）' : after}`);
  }

  // ---------- 3. 联系过但在扯皮 ----------
  if (open[2]) {
    const task = open[2];
    C.log(task.id, {
      channel: 'email',
      result: 'dispute',
      contact: '财务 Lily',
      note: `${TAG}对方称有两箱货色差超标，要求先处理索赔再付款；已转品质部出检验报告`
    }, fin);
    C.log(task.id, {
      channel: 'phone',
      result: 'no_answer',
      note: `${TAG}打对方财务直线两次未接，改发邮件`
    }, admin);
    console.log(`  ${task.task_no} ${String(task.customer_name).slice(0, 20)} → 有争议（跟进中）`);
  }

  // ---------- 4. 核销坏账（已结案示例） ----------
  if (open[3]) {
    const task = open[3];
    C.close(task.id, {
      reason: 'bad_debt',
      note: `${TAG}客户已停止经营，工商显示注销；律师函两次无回应，坏账审批单 BD-2026-07`
    }, fin);
    console.log(`  ${task.task_no} ${String(task.customer_name).slice(0, 20)} → 核销坏账（已结案）`);
  }

  const st = C.stats();
  console.log(
    `\n汇总：待跟进 ${st.open.count} / 已联系 ${st.following.count} / 已承诺 ${st.promised.count} / 跳票 ${st.escalated.count} / 已结案 ${st.closed.count}`
  );
  console.log(`在催 ¥${st.active_amount}（${st.active_count} 张）｜无人负责 ${st.no_owner_count} 张｜跳票 ¥${st.broken_amount}`);
}

main();
