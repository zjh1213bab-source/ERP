/**
 * 技能矩阵演示数据
 * ========================================================================
 * 造出来的不是一个「漂亮的全绿矩阵」，而是**四种真实状态同时存在**：
 *
 *   1. 合格且有效 —— 陈国强、吴小玲、陆师傅（车缝），周建军（裁剪）
 *   2. 有事实证据但等级不够 —— 李四裁剪 L1，低于门槛 2 级（要靠破格才能临时上）
 *   3. 快到期 —— 李四车缝技能 20 天后复评、周建军叉车证 45 天后到期
 *   4. 已过期 —— 王芳整烫技能过期（工序非受限，只提示）；吴小玲质检证过期
 *
 * 外加：两道工序（车缝/裁剪）设为受限，验证「没资格真的报不了工」。
 *
 * ⚠️ 演示标记只放在不参与展示的字段里（assessed_by / attachment / approved_by / trainer）：
 *    课程名、证书备注、破格理由都是给人看的，带上「【演示】」字样很脏。
 *
 * 用法：
 *   node scripts/seed-skill-demo.js            # 造数据
 *   node scripts/seed-skill-demo.js --clean    # 清干净（只删带演示标记的）
 */
const { db, now } = require('../src/db');
const { localDate } = require('../src/utils/time');

const t = now();
const day = (offset) => localDate(new Date(Date.now() + offset * 86400000).toISOString());

const MARK_WHO = '人事主管（演示）';   // employee_skills.assessed_by
const MARK_CERT = 'DEMO';              // skill_certs.attachment
const MARK_OV = '生产经理（演示）';    // skill_overrides.approved_by
const MARK_TRAIN = '演示数据';         // training_records.trainer

function clean() {
  const del = (sql, ...a) => db.prepare(sql).run(...a).changes;
  const a = del('DELETE FROM employee_skills WHERE assessed_by = ?', MARK_WHO);
  const b = del('DELETE FROM skill_certs WHERE attachment = ?', MARK_CERT);
  const c = del('DELETE FROM skill_overrides WHERE approved_by = ?', MARK_OV);
  const d = del('DELETE FROM training_records WHERE trainer = ?', MARK_TRAIN);
  // 门槛恢复默认：全部非受限、2 级、1 人
  db.prepare(
    "UPDATE skill_requirements SET restricted = 0, min_level = 2, min_headcount = 1, updated_by = NULL, updated_at = ?"
  ).run(t);
  console.log(`已清理演示数据：技能 ${a} · 证书 ${b} · 破格 ${c} · 培训 ${d}；门槛已恢复默认（全部非受限）`);
}

if (process.argv.includes('--clean')) {
  clean();
  process.exit(0);
}

const emp = (name) => {
  const e = db.prepare("SELECT id, name FROM employees WHERE name = ? AND IFNULL(status,'active')='active'").get(name);
  if (!e) throw new Error(`演示员工不存在：${name}`);
  return e;
};

/* ---------------- 1. 把两道工序设为受限（真会拦） ---------------- */

const setReq = db.prepare(
  `UPDATE skill_requirements SET restricted = ?, min_level = ?, min_headcount = ?, updated_by = ?, updated_at = ?
    WHERE process_name = ?`
);
setReq.run(1, 2, 3, '人事主管', t, '车缝');       // 车缝：必须熟练以上，至少 3 人（一个组）
setReq.run(1, 2, 2, '人事主管', t, '裁剪');       // 裁剪：必须熟练以上，至少 2 人
setReq.run(0, 2, 2, '人事主管', t, '锁眼钉扣');   // 只剩 1 人会做，先只提示不拦（一拦就停线）
setReq.run(0, 2, 1, '人事主管', t, '整烫');
console.log('工序门槛：车缝/裁剪已设为受限，锁眼钉扣/整烫仍为只提示');

/* ---------------- 2. 评定技能 ---------------- */

function assess(name, proc, level, evidence, validUntil) {
  const e = emp(name);
  const old = db.prepare('SELECT id FROM employee_skills WHERE employee_id = ? AND process_name = ?').get(e.id, proc);
  if (old) {
    db.prepare(
      `UPDATE employee_skills SET level=?, source='assessed', assessed_by=?, assessed_at=?, evidence=?, valid_until=?,
         status='active', updated_at=? WHERE id=?`
    ).run(level, MARK_WHO, t, evidence, validUntil, t, old.id);
  } else {
    db.prepare(
      `INSERT INTO employee_skills (employee_id, employee_name, process_name, level, source, assessed_by, assessed_at,
         evidence, valid_until, status, report_count, created_at, updated_at)
       VALUES (?,?,?,?,'assessed',?,?,?,?,'active',0,?,?)`
    ).run(e.id, e.name, proc, level, MARK_WHO, t, evidence, validUntil, t, t);
  }
}

// 车缝：4 人合格（含 1 个师傅），其中李四 20 天后要复评
assess('陈国强', '车缝', 3, '现场车 3 款各 20 件，返工 0，组长自评后生产经理复核', day(180));
assess('李四', '车缝', 2, '平车连续 6 个月无返工，2026-09 内部考核 82 分', day(20));
assess('吴小玲', '车缝', 2, '入职考核合格，独立完成整件 3 款', day(240));
assess('陆师傅', '车缝', 4, '带徒 2 人、能调机换款，车间公认的调车师傅', day(365));
// 王芳：样衣工，车缝更高 + 整烫（整烫技能已过期）
assess('王芳', '车缝', 3, '样衣工，样衣一次性通过率 91%', day(200));
assess('王芳', '整烫', 2, '2025 年评定，一年有效期已到，需复评', day(-12));
// 裁剪：周建军合格，李四只有 1 级（不够门槛 2 级，要破格才能临时上）
assess('周建军', '裁剪', 3, '裁床 5 年，裁片合格率 99.2%，能独立排版', day(150));
assess('李四', '裁剪', 1, '跟着周建军学过 2 个月，能辅助铺布，不能独立裁剪', day(60));
// 质检：刘海燕本岗
assess('刘海燕', '检验', 3, '质检员岗，AQL 判定与验货报告独立出具', day(365));
// 锁眼钉扣：只有吴小玲会
assess('吴小玲', '锁眼钉扣', 2, '锁眼机独立操作，换款调试合格', day(180));

/* ---------------- 3. 证书（含已过期） ---------------- */

function cert(name, type, no, issuer, issue, expire, remark) {
  const e = emp(name);
  db.prepare(
    `INSERT INTO skill_certs (employee_id, employee_name, cert_type, cert_no, issuer, issue_date, expire_date, status, remark, attachment, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(e.id, e.name, type, no, issuer, issue, expire,
    expire && expire < localDate(t) ? 'expired' : 'valid', remark, MARK_CERT, t, t);
}

cert('周建军', '叉车证', 'CC-2024-0917', '市市场监管局', day(-320), day(45), '45 天后到期，需提前安排复审');
cert('陈国强', '电工证（低压）', 'DG-2023-2288', '应急管理局', day(-500), day(210), '车间用电作业资格');
cert('吴小玲', '质检员资格证', 'QC-2023-0451', '行业协会', day(-700), day(-5), '已过期，仍在本岗做检验，需补考');

/* ---------------- 4. 培训（完成率不到 100） ---------------- */

function train(name, course, type, planned, finished, hours, score, result, expire, remark) {
  const e = emp(name);
  db.prepare(
    `INSERT INTO training_records (employee_id, employee_name, course_name, course_type, planned_at, finished_at, hours, score, result, expire_date, trainer, remark, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(e.id, e.name, course, type, planned, finished, hours, score, result, expire, MARK_TRAIN, remark || null, t, t);
}

train('李四', '新员工入职安全培训', 'onboard', day(-200), day(-198), 4, 92, 'pass', null, null);
train('吴小玲', '新员工入职安全培训', 'onboard', day(-160), day(-158), 4, 88, 'pass', null, null);
train('陈国强', '车缝工序质量要点', 'skill', day(-40), day(-38), 3, 95, 'pass', null, null);
train('王芳', '整烫工艺复训', 'refresh', day(-30), day(-28), 2, 90, 'pass', day(25), '25 天后又到复训期');
train('周建军', '叉车安全操作复训', 'refresher', day(-10), null, 4, null, 'pending', null, '计划 10 天前，一直没排上课');
train('刘海燕', 'AQL 抽样标准更新', 'skill', day(-6), null, 2, null, 'pending', null, '等着外部讲师，尚未开课');

/* ---------------- 5. 破格放行 ---------------- */

const lisi = emp('李四');
db.prepare(
  `INSERT INTO skill_overrides (employee_id, employee_name, process_name, reason, approved_by, valid_until, status, created_at, updated_at)
   VALUES (?,?,?,?,?,?,'active',?,?)`
).run(lisi.id, lisi.name, '裁剪',
  '旺季裁片跟不上，周建军一人排不开；李四已学过 2 个月铺布，限其只做铺布与辅助，30 天后复评',
  MARK_OV, day(30), t, t);

/* ---------------- 6. 结果 ---------------- */

const S = require('../src/services/skillMatrix');
const c = S.coverage();
const e = S.expiring({ days: 90 });
console.log('\n--- 覆盖 ---');
c.list.forEach((x) => {
  const flag = x.restricted ? '受限' : '提示';
  console.log(` ${x.process_name.padEnd(5, ' ')} [${flag}] 合格 ${x.qualified}/${x.min_headcount} · 事实证据 ${x.evidence_only} · 过期 ${x.expired} · ${x.status}`);
});
console.log('\n--- 90 天内到期 ---', JSON.stringify(e.summary));
console.log('--- 统计 ---', JSON.stringify(S.stats()));
console.log('\n--- 门禁自检 ---');
[
  ['陈国强', '车缝'], ['李四', '车缝'], ['李四', '裁剪'], ['刘海燕', '车缝'], ['周建军', '裁剪'], ['王芳', '整烫']
].forEach(([n, p]) => {
  const id = emp(n).id;
  const r = S.canWork(id, p);
  console.log(` ${n} 做${p}：${r.allowed ? '✅ 放行' : '⛔ 拦下'} — ${r.reason}`);
});
