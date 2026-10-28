/**
 * 薪酬计件与工资核对 演示数据
 * ----------------------------------------------------------------------
 * 这件事本身没有"演示数据"—— 差异是从真实账里算出来的。所以这个脚本做两件事：
 *
 * ## 一、把不自洽的历史工资单修正到能勾稽
 * 库里有 5 张工资单的 `gross_pay` 比「各项之和」多 12%（早期导入时按「月薪 ×1.12」写，
 * 那 12% 没落到 `allowance` 列），`tax` 也是按基本工资估的。
 * 工资单自己内部就对不上，核对永远一片红，看不出真正的问题。
 * 修正方式：把差额补进 `allowance`（应发不变），再按 `payrollCalc` 重算个税与实发。
 * 这是**数据修正**，不是造数；跑几次结果一样（幂等）。
 *
 * ## 二、造 3 条可控的差异，用来演示核对能发现什么
 *   1. 计件金额被手工改过（`piece_wage` +50）
 *   2. 有计件但没有工资单（在确认批次里插一条给新员工）
 *   3. 境外主体（USD）发薪 → 政策待配，不套国内税
 * 三条都带 `__DEMO` 标记，`--clean` 能还原。
 *
 * 用法：
 *   node scripts/seed-paycheck-demo.js           生成
 *   node scripts/seed-paycheck-demo.js --clean    还原
 */
const { db, now } = require('../src/db');
const { recalc, round2 } = require('../src/services/payrollCalc');
const { localDate } = require('../src/utils/time');

const MARK = 'DEMO-PAYCHECK';
const t = now();
const period = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();

function clean() {
  // 1. 还原被改过的计件
  const touched = db.prepare("SELECT id, piece_wage FROM payrolls WHERE remark LIKE ?").all(`%${MARK}%`);
  touched.forEach(() => { /* 金额在下面按标记恢复 */ });
  const restore = db.prepare("SELECT id, piece_wage FROM payrolls WHERE remark LIKE '%计件加 50%'").all();
  restore.forEach((r) => {
    db.prepare('UPDATE payrolls SET piece_wage = ?, remark = NULL, updated_at = ? WHERE id = ?')
      .run(round2(r.piece_wage - 50), now(), r.id);
  });
  // 2. 境外主体改回
  const foreign = db.prepare("SELECT id FROM payrolls WHERE remark LIKE '%境外主体演示%'").all();
  foreign.forEach((r) => {
    db.prepare('UPDATE payrolls SET company_id = 1, remark = NULL, updated_at = ? WHERE id = ?').run(now(), r.id);
  });
  // 3. 删掉插进去的计件明细，并把批次汇总减回来
  const demoItems = db.prepare("SELECT id, run_id, qty, amount FROM piece_wage_items WHERE bundle_no = ?").all('DEMO-PC');
  demoItems.forEach((x) => {
    db.prepare('DELETE FROM piece_wage_items WHERE id = ?').run(x.id);
    db.prepare(`UPDATE piece_wage_runs SET total_qty = MAX(0, total_qty - ?), total_amount = MAX(0, total_amount - ?),
        items_count = MAX(0, items_count - 1) WHERE id = ?`).run(Number(x.qty) || 0, Number(x.amount) || 0, x.run_id);
  });
  db.prepare("DELETE FROM employees WHERE code = 'DEMO-PC'").run();
  // 4. 核对批次
  const runs = db.prepare("SELECT id FROM payroll_check_runs WHERE note LIKE ?").all(`%${MARK}%`).map((r) => r.id);
  runs.forEach((id) => db.prepare('DELETE FROM payroll_check_items WHERE run_id = ?').run(id));
  db.prepare("DELETE FROM payroll_check_runs WHERE note LIKE ?").run(`%${MARK}%`);
  console.log(`还原：计件改动 ${restore.length} · 境外主体 ${foreign.length} · 插入明细 ${demoItems.length} · 核对批次 ${runs.length}`);
}

if (process.argv.includes('--clean')) { clean(); process.exit(0); }
clean();

/* ---------------- 一、把不自洽的工资单修正到能勾稽 ---------------- */
const rows = db.prepare('SELECT * FROM payrolls WHERE period = ?').all(period);
let fixed = 0;
rows.forEach((r) => {
  const c = recalc(r);
  if (Math.abs(Number(r.gross_pay) - c.gross) < 0.01 && Math.abs(Number(r.net_pay) - c.net) < 0.01) return;
  // 差额进补贴：应发不变，但「应发 = 各项之和」成立
  const allowance = round2(Number(r.allowance) + (Number(r.gross_pay) - c.gross));
  const c2 = recalc({ ...r, allowance });
  db.prepare('UPDATE payrolls SET allowance=?, tax=?, gross_pay=?, net_pay=?, updated_at=? WHERE id=?')
    .run(allowance, c2.tax, c2.gross, c2.net, now(), r.id);
  fixed++;
});
console.log(`修正工资单内部勾稽：${fixed} 张（差额补进补贴列，应发不变）`);

/* ---------------- 二、造三条差异 ---------------- */
// 1. 计件被手工改过：找一张有计件的工资单，+50
const piecePay = db.prepare(`SELECT * FROM payrolls WHERE period = ? AND piece_wage > 0 AND status = 'draft' ORDER BY piece_wage DESC LIMIT 1`).get(period);
if (piecePay) {
  db.prepare("UPDATE payrolls SET piece_wage = ?, remark = ?, updated_at = ? WHERE id = ?")
    .run(round2(Number(piecePay.piece_wage) + 50), '计件加 50（演示：模拟手工改过工资单）', now(), piecePay.id);
  console.log(`计件不符演示：${piecePay.employee_name} 工资单计件 ${piecePay.piece_wage} → ${round2(Number(piecePay.piece_wage) + 50)}`);
}

// 2. 有计件但没有工资单：建一个员工 + 在确认批次插一条明细
const run = db.prepare("SELECT * FROM piece_wage_runs WHERE period = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 1").get(period);
if (run) {
  let emp = db.prepare("SELECT id, name FROM employees WHERE code = 'DEMO-PC'").get();
  if (!emp) {
    const info = db.prepare("INSERT INTO employees (code, name, department_id, status, hire_date, created_at) VALUES ('DEMO-PC', '演示新员工（无工资单）', 4, 'active', ?, ?)")
      .run(`${period}-01`, t);
    emp = { id: Number(info.lastInsertRowid), name: '演示新员工（无工资单）' };
  }
  db.prepare(`INSERT INTO piece_wage_items (run_id, employee_id, employee_code, employee_name, department, style_no,
      process_name, bundle_no, raw_qty, qty, capped, unit_price, amount, rate_source, matched_by, report_date, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?, 'style', 'id', ?, ?)`).run(
    run.id, emp.id, 'DEMO-PC', emp.name, '生产部', 'DEMO-STYLE', '车缝', 'DEMO-PC',
    10, 10, 12, 120, `${period}-10`, t
  );
  db.prepare(`UPDATE piece_wage_runs SET total_qty = total_qty + 10, total_amount = total_amount + 120,
      items_count = items_count + 1 WHERE id = ?`).run(run.id);
  console.log(`缺工资单演示：给「${emp.name}」插入 10 件 / ¥120 计件，但不生成工资单`);
}

// 3. 境外主体：把一名美仓员工的工资单挂到美国公司
const us = db.prepare("SELECT id FROM companies WHERE base_currency <> 'CNY' ORDER BY id LIMIT 1").get();
const usEmp = db.prepare("SELECT * FROM payrolls WHERE period = ? AND (employee_name LIKE 'David%' OR employee_name LIKE 'Mike%' OR employee_name LIKE 'Linda%') ORDER BY id LIMIT 1").get(period);
if (us && usEmp) {
  db.prepare('UPDATE payrolls SET company_id = ?, remark = ?, updated_at = ? WHERE id = ?')
    .run(us.id, '境外主体演示：挂在 USD 公司发薪，个税社保政策待配', now(), usEmp.id);
  console.log(`境外主体演示：${usEmp.employee_name} 改挂 USD 主体`);
}

/* ---------------- 三、生成一份核对批次 ---------------- */
const S = require('../src/services/payrollCheck');
try {
  const chk = S.runCheck(period, { force: true, note: `演示核对 ${MARK}` }, 'seed');
  db.prepare('UPDATE payroll_check_runs SET demo_tag = ? WHERE id = ?').run(MARK, chk.id);
  db.prepare('UPDATE payroll_check_items SET demo_tag = ? WHERE run_id = ?').run(MARK, chk.id);
  const s = chk.payload.summary;
  console.log(`核对批次 ${chk.check_no}：${s.items} 人，一致 ${s.ok} / 差异 ${s.diff} / 政策待配 ${s.policy} / 缺工资单 ${s.missing}`);
  console.log(`  计件应计 ¥${s.piece_expected}，工资单计件 ¥${s.piece_in_payroll}，差 ${s.piece_diff}`);
} catch (e) {
  console.log('核对批次跳过：' + e.message);
}
console.log('清理：node scripts/seed-paycheck-demo.js --clean');
