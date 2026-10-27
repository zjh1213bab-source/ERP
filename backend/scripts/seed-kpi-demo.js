/**
 * 岗位绩效演示数据（可重复执行）
 *
 * 覆盖场景：
 *  - 缝制岗模板已批准（V1），检验岗模板已批准
 *  - 缝制岗 V2 待复核（演示：未批准只能模拟试算，不发布正式绩效）
 *  - 三个周周期：已冻结（历史）/ 已确认 / 本周进行中
 *  - 本周：李四已复核确认；陈国强仍待复核；刘海燕有未结申诉（分数暂定）；王芳部分待复核
 *  - 每人都有一个「待配置」指标（订单时限未核定 → 不预测、不自动扣分）
 *
 * 用法：node scripts/seed-kpi-demo.js [--reset]
 */
const { db, now } = require('../src/db');

const BASE = process.env.SEED_BASE || 'http://127.0.0.1:3000';
const PWD = 'admin123456';

async function req(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) return { s: r.status, j, error: j.message || 'HTTP ' + r.status };
  return { s: r.status, j };
}

function localDate(d = new Date()) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay() || 7;
  d.setDate(d.getDate() - dow + 1);
  return localDate(d);
}

const RESET = process.argv.includes('--reset');

/* ---------------- 0. 清空（只清绩效相关） ---------------- */
if (RESET) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM kpi_appeals').run();
    db.prepare('DELETE FROM kpi_items').run();
    db.prepare('DELETE FROM kpi_scores').run();
    db.prepare('DELETE FROM kpi_cycles').run();
    db.prepare('DELETE FROM kpi_rules').run();
    db.prepare('DELETE FROM kpi_templates').run();
    db.exec('COMMIT');
    console.log('已清空绩效演示数据');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------------- 1. 员工 ---------------- */
const EMP = [
  { code: 'E101', name: '李四', position: '车工', department_id: 4, base_salary: 9000 },
  { code: 'E102', name: '陈国强', position: '车工', department_id: 4, base_salary: 8800 },
  { code: 'E103', name: '王芳', position: '样衣工', department_id: 4, base_salary: 8500 },
  { code: 'E104', name: '刘海燕', position: '质检员', department_id: 4, base_salary: 8200 },
  { code: 'E105', name: '周建军', position: '裁剪工', department_id: 4, base_salary: 8600 },
  { code: 'E106', name: '吴小玲', position: '车工', department_id: 4, base_salary: 8700 }
];
const empId = {};
EMP.forEach((e) => {
  const exist = db.prepare('SELECT * FROM employees WHERE name = ?').get(e.name);
  if (exist) {
    db.prepare("UPDATE employees SET position = ?, department_id = ?, status = 'active', base_salary = ?, code = COALESCE(code, ?) WHERE id = ?")
      .run(e.position, e.department_id, e.base_salary, e.code, exist.id);
    empId[e.name] = exist.id;
  } else {
    const info = db.prepare(
      "INSERT INTO employees (code, name, department_id, position, status, base_salary, hire_date, created_at) VALUES (?,?,?,?, 'active', ?, '2025-03-01', ?)"
    ).run(e.code, e.name, e.department_id, e.position, e.base_salary, now());
    empId[e.name] = Number(info.lastInsertRowid);
  }
});
console.log('员工就绪：', EMP.map((e) => `${e.name}(${e.position})`).join(' · '));

(async () => {
  const login = await req(null, 'POST', '/api/auth/login', { username: 'admin', password: PWD });
  if (!login.j || !login.j.data) { console.error('登录失败', login); process.exit(1); }
  const TK = login.j.data.token;

  /* ---------------- 2. 模板 ---------------- */
  const tplId = {};

  async function ensureTemplate(def) {
    const list = (await req(TK, 'GET', '/api/kpi/templates')).j.data.rows;
    const hit = list.find((t) => t.name === def.name && t.version === 1);
    if (hit) return hit.id;
    const c = await req(TK, 'POST', '/api/kpi/templates', def);
    if (!c.j.ok) { throw new Error('建模板失败：' + c.error); }
    return c.j.data.id;
  }

  async function addRules(tid, rules) {
    const cur = (await req(TK, 'GET', '/api/kpi/templates/' + tid)).j.data.rules;
    if (cur.length) return cur.length;
    for (const r of rules) {
      const x = await req(TK, 'POST', `/api/kpi/templates/${tid}/rules`, r);
      if (!x.j.ok) throw new Error(`加指标「${r.name}」失败：${x.error}`);
    }
    return rules.length;
  }

  // ---- 缝制岗 V1 ----
  const SEW_RULES = [
    {
      code: 'Q1', name: '一次交检不良率', category: 'quality',
      definition: '本周期报工中不良件数占报工总件数的比例',
      formula: '不良件数 ÷ (合格件数 + 不良件数) × 100%',
      target_value: 2, unit: '%', weight: 30,
      threshold: { op: 'gt', value: 2, step: 1, deduct: 2 },
      data_source: 'production_defect', cap_score: 10, reviewer: '生产主管',
      exception_note: '返工返修件不重复计入不良；来料疵点经确认后剔除'
    },
    {
      code: 'Q2', name: '本人责任返工', category: 'quality',
      definition: '经确认责任方为本人的返工件数',
      formula: '统计周期内 responsibility 含本人的返工单件数合计',
      target_value: 0, unit: '件', weight: 20,
      threshold: { op: 'gt', value: 0, step: 1, deduct: 1 },
      data_source: 'rework_duty', cap_score: 6, reviewer: '生产主管',
      exception_note: '责任方未认定前不计；复验、二次审核不重复计同一事件'
    },
    {
      code: 'D1', name: '出勤准时', category: 'delivery',
      definition: '本周期迟到次数（按考勤记录）',
      formula: '统计周期内 attendance.status=late 的天数；批准休假覆盖的日期不计',
      target_value: 0, unit: '次', weight: 20,
      threshold: { op: 'gt', value: 0, step: 1, deduct: 1 },
      data_source: 'attendance_late', cap_score: 4, reviewer: '直属主管',
      exception_note: '批准的年假/病假/事假、公司安排外出、交通管制等非本人原因不计'
    },
    {
      code: 'D2', name: '订单时限达成', category: 'delivery',
      definition: '本周期承担的订单工序是否按时限完成',
      formula: '按已核定的工序时限核对；时限未核定时标「待配置」，不预测为 0 天',
      target_value: null, unit: '单', weight: 20,
      threshold: { op: 'gt', value: 0, step: 1, deduct: 2 },
      data_source: 'order_due', cap_score: 20, reviewer: '生产主管',
      exception_note: '订单超期与个人责任分别核；非本人责任、外部依赖未到位、主管改期不计'
    },
    {
      code: 'S1', name: '现场 5S 与安全', category: 'site',
      definition: '工位 5S 与安全操作检查结果',
      formula: '按车间巡检记录人工登记，一次不合格扣 1 分',
      target_value: 0, unit: '次', weight: 10,
      threshold: { op: 'gt', value: 0, step: 1, deduct: 1 },
      data_source: 'manual', cap_score: 5, reviewer: '车间主任',
      exception_note: '设备本身缺陷导致的不计入个人'
    }
  ];

  const tid = await ensureTemplate({
    name: '缝制岗位周度绩效', job_family: '缝制', department_id: 4, base_score: 100,
    remark: '适用车工、样衣工、整烫、锁钉等缝制岗'
  });
  await addRules(tid, SEW_RULES);
  tplId.sew = tid;

  // ---- 检验岗 ----
  const tidQc = await ensureTemplate({
    name: '检验岗位周度绩效', job_family: '检验', department_id: 4, base_score: 100,
    remark: '适用质检员、巡检员'
  });
  await addRules(tidQc, [
    {
      code: 'Q1', name: '漏检率', category: 'quality',
      definition: '下道工序或客户反馈的漏检件数占本周期检验件数比例',
      formula: '漏检件数 ÷ 检验件数 × 100%',
      target_value: 0.5, unit: '%', weight: 40,
      threshold: { op: 'gt', value: 0.5, step: 0.5, deduct: 3 },
      data_source: 'production_defect', cap_score: 12, reviewer: '质量主管',
      exception_note: '客户标准变更导致的漏检不计；已按旧标准判定合格的不追溯'
    },
    {
      code: 'D1', name: '出勤准时', category: 'delivery',
      definition: '本周期迟到次数', formula: 'attendance.status=late 的天数，批准休假覆盖不计',
      target_value: 0, unit: '次', weight: 30,
      threshold: { op: 'gt', value: 0, step: 1, deduct: 2 },
      data_source: 'attendance_late', cap_score: 6, reviewer: '质量主管',
      exception_note: '批准休假、公司安排外出不计'
    },
    {
      code: 'S1', name: '检验记录完整性', category: 'site',
      definition: '检验记录的批次、缸号、结论是否齐全',
      formula: '抽查不合格批次数，一次扣 2 分',
      target_value: 0, unit: '次', weight: 30,
      threshold: { op: 'gt', value: 0, step: 1, deduct: 2 },
      data_source: 'manual', cap_score: 10, reviewer: '质量主管',
      exception_note: '系统故障期间的记录缺失不计'
    }
  ]);
  tplId.qc = tidQc;

  // ---- 裁剪岗（再演示一套不同指标） ----
  const tidCut = await ensureTemplate({
    name: '裁剪岗位周度绩效', job_family: '裁剪', department_id: 4, base_score: 100,
    remark: '适用裁剪工、验片工'
  });
  await addRules(tidCut, [
    {
      code: 'Q1', name: '裁片合格率', category: 'quality',
      definition: '裁床扎包复核的合格裁片占实裁数比例',
      formula: '不合格裁片数 ÷ 实裁数 × 100%',
      target_value: 1, unit: '%', weight: 40,
      threshold: { op: 'gt', value: 1, step: 1, deduct: 2 },
      data_source: 'production_defect', cap_score: 12, reviewer: '裁剪组长',
      exception_note: '面料本身疵点（已验出）不计；错缸导致的返裁按责任归属另计'
    },
    {
      code: 'Q2', name: '用料超耗', category: 'quality',
      definition: '实际用料超出排版算料的比例',
      formula: '(实际用料 − 算料) ÷ 算料 × 100%',
      target_value: 2, unit: '%', weight: 30,
      threshold: { op: 'gt', value: 2, step: 1, deduct: 2 },
      data_source: 'manual', cap_score: 10, reviewer: '裁剪组长',
      exception_note: '面料幅宽不足、疵点避让导致的超耗经技术确认后不计'
    },
    {
      code: 'D1', name: '出勤准时', category: 'delivery',
      definition: '本周期迟到次数', formula: 'attendance.status=late 的天数，批准休假覆盖不计',
      target_value: 0, unit: '次', weight: 30,
      threshold: { op: 'gt', value: 0, step: 1, deduct: 2 },
      data_source: 'attendance_late', cap_score: 6, reviewer: '裁剪组长',
      exception_note: '批准休假、公司安排外出不计'
    }
  ]);
  tplId.cut = tidCut;

  // 提交 + 批准三个 V1
  for (const id of [tid, tidQc, tidCut]) {
    const t = (await req(TK, 'GET', '/api/kpi/templates/' + id)).j.data;
    if (t.status === 'draft') {
      const sb = await req(TK, 'POST', `/api/kpi/templates/${id}/submit`, {});
      if (!sb.j.ok) throw new Error('提交失败：' + sb.error);
    }
    const t2 = (await req(TK, 'GET', '/api/kpi/templates/' + id)).j.data;
    if (t2.status === 'pending_review') {
      const ap = await req(TK, 'POST', `/api/kpi/templates/${id}/approve`, { agree: true, effective_from: addDays(localDate(), -21) });
      if (!ap.j.ok) throw new Error('批准失败：' + ap.error);
      console.log('已批准：', t2.name, 'V' + t2.version);
    }
  }

  // ---- 缝制岗 V2 待复核（演示「未批只能试算」） ----
  let v2 = db.prepare("SELECT * FROM kpi_templates WHERE job_family = '缝制' AND version = 2").get();
  if (!v2) {
    const nv = await req(TK, 'POST', `/api/kpi/templates/${tid}/new-version`, {});
    if (!nv.j.ok) throw new Error('出新版本失败：' + nv.error);
    const nid = nv.j.data.id;
    // 调权重：不良率 30→35，出勤 20→15
    const rules = (await req(TK, 'GET', '/api/kpi/templates/' + nid)).j.data.rules;
    const r1 = rules.find((r) => r.code === 'Q1');
    const r3 = rules.find((r) => r.code === 'D1');
    await req(TK, 'PUT', `/api/kpi/templates/${nid}/rules/${r1.id}`, { weight: 35, threshold: { op: 'gt', value: 1.5, step: 1, deduct: 2 } });
    await req(TK, 'PUT', `/api/kpi/templates/${nid}/rules/${r3.id}`, { weight: 15 });
    const sb = await req(TK, 'POST', `/api/kpi/templates/${nid}/submit`, {});
    if (!sb.j.ok) throw new Error('V2 提交失败：' + sb.error);
    console.log('缝制岗 V2 已提交待复核（演示：未批准只能模拟试算）');
    v2 = db.prepare('SELECT * FROM kpi_templates WHERE id = ?').get(nid);
  }

  /* ---------------- 3. 周期 ---------------- */
  const thisMonday = mondayOf(localDate());
  const weeks = [isoWeek(addDays(thisMonday, -14)), isoWeek(addDays(thisMonday, -7)), isoWeek(thisMonday)];
  for (const w of weeks) {
    if (!db.prepare('SELECT 1 AS x FROM kpi_cycles WHERE cycle_no = ?').get(w)) {
      await req(TK, 'POST', '/api/kpi/cycles', { cycle_no: w });
    }
  }
  const cycles = db.prepare('SELECT * FROM kpi_cycles ORDER BY start_date').all();
  console.log('周期：', cycles.map((c) => `${c.cycle_no}(${c.start_date}~${c.end_date})`).join(' · '));
  const cur = cycles[cycles.length - 1];

  /* ---------------- 4. 报工与考勤（当前周期） ---------------- */
  const orders = db.prepare("SELECT id, order_no FROM orders WHERE status IN ('production','instock','shipped','closed') ORDER BY id").all();
  const nodes = (oid) => db.prepare('SELECT id, name FROM order_nodes WHERE order_id = ? ORDER BY seq').all(oid);

  // 每人本周的报工与不良（刻意造出差异，让分数有高低）
  const plan = {
    李四: { ok: 420, df: 4, reports: 5, lateDays: [] },          // 不良 0.94% → 达标，不扣分
    陈国强: { ok: 380, df: 16, reports: 5, lateDays: [1] },      // 不良 4.04% → 扣分；迟到 1 次
    王芳: { ok: 260, df: 6, reports: 4, lateDays: [] },          // 不良 2.26% → 待复核小扣分
    刘海燕: { ok: 640, df: 9, reports: 6, lateDays: [] },        // 漏检率 1.39% → 扣分（后被申诉）
    周建军: { ok: 900, df: 2, reports: 4, lateDays: [] },        // 裁片合格率达标
    吴小玲: { ok: 410, df: 12, reports: 5, lateDays: [3, 4] }    // 迟到 2 次，其中 1 次在批准休假期间（不计）
  };

  db.prepare('DELETE FROM production_reports WHERE report_date >= ? AND report_date <= ?').run(cur.start_date, cur.end_date);
  db.prepare('DELETE FROM attendance WHERE date >= ? AND date <= ?').run(cur.start_date, cur.end_date);

  Object.entries(plan).forEach(([name, p], idx) => {
    const eid = empId[name];
    const o = orders[(idx + 10) % orders.length];
    const nd = nodes(o.id);
    const node = nd[Math.min(nd.length - 1, 3)] || { id: null, name: '车缝' };
    const per = Math.floor(p.ok / p.reports);
    const okExtra = p.ok - per * p.reports;
    const dfBase = Math.floor(p.df / p.reports);
    const dfExtra = p.df - dfBase * p.reports;
    for (let i = 0; i < p.reports; i++) {
      const date = addDays(cur.start_date, i);
      db.prepare(
        `INSERT INTO production_reports (order_id, node_id, node_name, report_date, qty_ok, qty_defect, hours, operator, employee_id, remark, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(o.id, node.id, node.name, date,
        per + (i === 0 ? okExtra : 0),
        dfBase + (i === 0 ? dfExtra : 0),
        7.5, name, eid, '绩效演示数据', now());
    }
    // 考勤：工作日全勤 + 按 plan 造迟到
    for (let i = 0; i < 5; i++) {
      const date = addDays(cur.start_date, i);
      const late = (p.lateDays || []).includes(i);
      db.prepare(
        `INSERT OR REPLACE INTO attendance (employee_id, employee_name, date, check_in, check_out, status, remark, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(eid, name, date, late ? '09:1' + (5 + i) : '08:5' + i, '18:0' + i,
        late ? 'late' : 'normal', late ? '打卡迟到' : null, now());
    }
  });
  console.log(`已造：当前周期 ${Object.keys(plan).length} 人 × 报工 + 考勤`);

  // 一条批准休假（演示：休假覆盖的迟到不计）
  db.prepare("DELETE FROM leave_requests WHERE reason LIKE '%绩效演示%'").run();
  db.prepare(
    `INSERT INTO leave_requests (employee_id, employee_name, type, start_date, end_date, days, reason, status, reviewed_by, created_at)
     VALUES (?,?, 'annual', ?, ?, 1, ?, 'approved', 'admin', ?)`
  ).run(empId['吴小玲'], '吴小玲', addDays(cur.start_date, 4), addDays(cur.start_date, 4), '绩效演示：批准年假一天（该日迟到不计）', now());

  /* ---------------- 5. 生成建议扣分 ---------------- */
  const gen = await req(TK, 'POST', '/api/kpi/generate', { cycle_id: cur.id });
  if (!gen.j.ok) throw new Error('生成失败：' + gen.error);
  gen.j.data.results.forEach((r) => {
    console.log(`  ${r.employee_name}: 建议扣 ${r.suggested_score} 分（新增 ${r.added} 项）${r.notes && r.notes.length ? ' | ' + r.notes.join('；') : ''}`);
  });

  /* ---------------- 6. 主管复核（李四全确认 / 刘海燕确认后申诉 / 王芳留一项待复核） ---------------- */
  const scoreOf = (name) => db.prepare('SELECT * FROM kpi_scores WHERE cycle_id = ? AND employee_name = ?').get(cur.id, name);

  async function confirmAll(name, { skipUnconfigured = true } = {}) {
    const s = scoreOf(name);
    if (!s) { console.log(`  ${name}: 没有绩效单（没有匹配模板），跳过复核`); return; }
    const items = db.prepare('SELECT * FROM kpi_items WHERE score_id = ?').all(s.id);
    for (const it of items) {
      if (it.review_status !== 'pending') continue;
      if (skipUnconfigured && it.review_status === 'unconfigured') continue;
      const r = await req(TK, 'POST', `/api/kpi/items/${it.id}/confirm`, { note: '主管核对报工与考勤记录后确认' });
      if (!r.j.ok) console.log('   复核失败', it.rule_name, r.error);
    }
    const cf = await req(TK, 'POST', `/api/kpi/scores/${s.id}/confirm`, {});
    if (!cf.j.ok) console.log(`  ${name} 确认失败：`, cf.error);
  }

  await confirmAll('李四');
  await confirmAll('刘海燕');
  await confirmAll('周建军');
  await confirmAll('吴小玲');

  // 王芳：只确认一项，留一项待复核
  {
    const s = scoreOf('王芳');
    const pend = db.prepare("SELECT * FROM kpi_items WHERE score_id = ? AND review_status = 'pending'").all(s.id);
    if (pend.length > 1) {
      await req(TK, 'POST', `/api/kpi/items/${pend[0].id}/confirm`, { note: '已核对报工记录' });
    }
  }

  // 陈国强：全部待复核（演示「建议分不计入当前分」）

  /* ---------------- 7. 申诉（刘海燕对漏检率扣分提出申诉） ---------------- */
  {
    const s = scoreOf('刘海燕');
    const it = db.prepare("SELECT * FROM kpi_items WHERE score_id = ? AND rule_code = 'Q1' AND review_status = 'confirmed'").get(s.id);
    if (it && it.appeal_status === 'none') {
      const ap = await req(TK, 'POST', '/api/kpi/appeals', {
        item_id: it.id,
        reason_type: 'external',
        reason: '这批 320G 卫衣布来料缸差明显，客户确认前我已按旧标准全检并出具了保留意见，漏检部分是客户改判标准导致的',
        evidence: '检验记录 QC-2610-08；客户 10-24 邮件确认改判；来料缸差报告 A2310/A2312'
      });
      if (ap.j.ok) console.log('刘海燕申诉已提交：', ap.j.data.appeal_no);
      else console.log('申诉失败：', ap.error);
    }
  }

  /* ---------------- 8. 历史周期：生成 + 确认 + 冻结 ---------------- */
  for (const c of cycles.slice(0, 2)) {
    const g = await req(TK, 'POST', '/api/kpi/generate', { cycle_id: c.id });
    if (!g.j.ok) { console.log('历史周期生成失败', c.cycle_no, g.error); continue; }
    const ss = db.prepare('SELECT * FROM kpi_scores WHERE cycle_id = ?').all(c.id);
    for (const s of ss) {
      const items = db.prepare("SELECT * FROM kpi_items WHERE score_id = ? AND review_status = 'pending'").all(s.id);
      for (const it of items) await req(TK, 'POST', `/api/kpi/items/${it.id}/confirm`, { note: '历史周期复核' });
      await req(TK, 'POST', `/api/kpi/scores/${s.id}/confirm`, {});
    }
    const fz = await req(TK, 'POST', `/api/kpi/cycles/${c.id}/freeze`, {});
    console.log(`历史周期 ${c.cycle_no}：${fz.j.ok ? fz.j.data.notice : fz.error}`);
  }

  /* ---------------- 9. 汇总 ---------------- */
  const board = (await req(TK, 'GET', `/api/kpi/board?cycle_id=${cur.id}`)).j.data;
  console.log('\n=== 本周绩效看板 ===');
  console.log('周期', board.cycle.cycle_no, board.cycle.start_date, '~', board.cycle.end_date, '|', board.cycle.status_label);
  board.rows.forEach((r) => {
    console.log(`  ${r.employee_name}(${r.position}) ${r.status_label} 基准${r.base_score} 建议-${r.suggested_score} 已确认-${r.confirmed_score} 当前${r.current_score === null ? '-' : r.current_score}${r.not_final ? ' [暂定]' : ''} 模板${r.template_no}V${r.template_version}`);
  });
  console.log('stat', JSON.stringify(board.stat));
  console.log('待复核', board.pending.length, '项 | 申诉', board.appeals.length, '条');
  const tplList = (await req(TK, 'GET', '/api/kpi/templates')).j.data;
  console.log('\n=== 模板 ===');
  tplList.rows.forEach((t) => console.log(`  ${t.template_no} ${t.name} V${t.version} ${t.status_label} 指标${t.rule_count} 权重${t.weight_sum}% 已用${t.used_count}单`));
  console.log('\n完成。打开「人事 → 岗位绩效」查看。');
  process.exit(0);
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
