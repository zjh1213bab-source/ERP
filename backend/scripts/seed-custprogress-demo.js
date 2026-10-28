/**
 * 客户进度发布演示数据
 * ========================================================================
 * 造四种状态，正好覆盖三条路线和「发布 / 撤回」：
 *
 *   1. 裁片外发进行中（外发还没全部回货）→ 客户看到「外发加工 进行中」，**没有完工字样**
 *   2. 本厂已全部完成 → 客户看到「已完工，可安排发货」
 *   3. 本厂进行中，发布后又被撤回 → 客户侧看不到，内部留版本历史
 *   4. 一单改为整单外发 → 客户只看到「外发加工 / 检验 / 发运」三个阶段
 *
 * 标记方式：`progress_publications.published_by = '演示数据'`、
 * `order_routes.updated_by = '演示数据'`（都是内部字段，客户看不到）。
 *
 * 用法：
 *   node scripts/seed-custprogress-demo.js            # 造数据
 *   node scripts/seed-custprogress-demo.js --clean    # 清干净
 */
const { db } = require('../src/db');
const P = require('../src/services/customerProgress');

const MARK = '演示数据';

function clean() {
  const a = db.prepare('DELETE FROM progress_publications WHERE published_by = ? OR withdrawn_by = ?').run(MARK, MARK).changes;
  const b = db.prepare('DELETE FROM order_routes WHERE updated_by = ?').run(MARK).changes;
  console.log(`已清理：发布记录 ${a} 条 · 路线设定 ${b} 条`);
}

if (process.argv.includes('--clean')) {
  clean();
  process.exit(0);
}

const rows = P.listOrders({});
const cut = rows.find((r) => r.route === 'cut_outsource' && !r.can_complete);
const done = rows.find((r) => r.can_complete);
const mid = rows.find((r) => r.route === 'inhouse' && !r.can_complete && r.order_no.startsWith('RPTDEMO'));
const toOutsource = rows.find((r) => r.route === 'inhouse' && !r.can_complete && r.id !== (mid && mid.id));

const out = [];

/* ① 裁片外发进行中 */
if (cut) {
  const r = P.publish(cut.id, { note: '客户催得紧，先把外发阶段给客户看' }, MARK);
  out.push(`① ${cut.order_no} 裁片外发 → 发布 v${r.version_no}（${r.done_count}/${r.stage_count}，客户看不到完工）`);
}

/* ② 本厂已完成 */
if (done) {
  const r = P.publish(done.id, { note: '已完工，通知客户安排货代' }, MARK);
  out.push(`② ${done.order_no} 本厂完成 → 发布 v${r.version_no}（可完工：${r.completed}）`);
}

/* ③ 发布后撤回（留版本） */
if (mid) {
  const r = P.publish(mid.id, { note: '先发一版给客户看' }, MARK);
  const w = P.withdraw(r.id, { reason: '交期要往后挪 3 天，先把进度撤回，改完再发' }, MARK);
  out.push(`③ ${mid.order_no} 本厂进行中 → 发布 v${r.version_no} 后撤回（${w.status}），客户侧已看不到`);
}

/* ④ 改整单外发：**只改路线，不发布**
 * 库里只有一张订单有真实外发记录，把它改成整单外发后发布，客户会看到
 * 「外发加工 未开始 / 检验 已完成」这种自相矛盾的进度。演示数据不制造矛盾：
 * 这里只把路线改掉，让内部列表上显示「整单外发 · 未发布」，并在输出里说明原因。
 */
if (toOutsource) {
  const s = P.setRoute(toOutsource.id, { route: 'full_outsource', note: '客户要求整单外发（演示：无外发记录，故不发布）' }, MARK);
  out.push(`④ ${toOutsource.order_no} 改为${s.route_label} → 仅改路线，未发布会（它没有外发记录，发出去客户会看到自相矛盾的进度）`);
}

console.log(out.join('\n'));
const st = P.stats();
console.log('\n--- 统计 ---', JSON.stringify(st));

// 客户视角复核：ABC 客户能看到什么
const customer = db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(cut ? cut.id : (done ? done.id : 1));
const list = P.customerOrders(customer.customer_id);
console.log(`\n--- 客户 ${customer.customer_id} 能看到 ${list.length} 单 ---`);
list.slice(0, 6).forEach((x) => {
  console.log(` ${x.order_no} ${x.done_count}/${x.stage_count} ${x.progress_pct}% ` +
    `当前阶段《${x.current_stage ? x.current_stage.label : '—'}》` + (x.completed ? ' ✅已完工' : ''));
});
const one = cut ? P.customerOrderProgress(customer.customer_id, cut.id) : null;
if (one) {
  console.log('\n--- 客户看这一单的完整快照 ---');
  console.log('阶段:', one.stages.map((s) => `${s.label}(${s.status_label})`).join(' → '));
  console.log('完工字段:', one.completed, '| completion_label:', one.completion_label || '（不出现）');
  console.log('快照里是否含工厂/成本:', /factory|amount|price|成本|工厂名/.test(JSON.stringify(one)) ? '❌ 有' : '✅ 没有');
}
