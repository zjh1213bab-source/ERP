/**
 * 技能矩阵与岗位资格（TS-N13-06）
 * ========================================================================
 * 这个模块要回答的不是「谁会什么」这么简单，而是三个能直接用于排产的问题：
 *
 *   1. 这道工序**现在有几个人能上**（不是「档案里有 6 个车工」，是「6 个人里 4 个合格、2 个证过期」）
 *   2. 这个**人能不能上**这道工序（受限工序没资格要拦住）
 *   3. 下个月**谁会掉资格**（证书/复评到期，提前 60 天要看得见）
 *
 * ## 五条口径（写在这里是因为代码里看不出来）
 *
 * 1. **等级只来自「评定」**。报工次数只回填 `report_count` 作证据，不参与评级 ——
 *    报工多可能只是干得多，也可能是返工最多的那个人。
 * 2. **证据来源分开记**：`assessed` 评定 / `actual` 仅报工事实 / `self` 自报。
 *    只有 assessed 且等级达标的才算「可独立上岗」，否则矩阵只能看不能派工。
 * 3. **证书过期即失效，但记录不删**：状态转 `expired`，矩阵上显示「有·已过期」——
 *    「曾经有」和「现在没有」是两件事，抹掉前者等于丢掉追溯。
 * 4. **查不到人不拦**：报工人不在员工档案里时不拦报工，但计入覆盖缺口的「未归属」。
 *    拿档案缺失当否决事实，等于让 HR 的数据质量决定车间能不能开工。
 * 5. **本模块不产生扣款、不参与打分**。原型：AI 不能自动打低分裁员、离职风险不得凭敏感记录评分。
 *    这里只有资格与覆盖；破格放行必须写理由 + 有期限 + 留痕。
 */
const { db, now } = require('../db');
const { localDate } = require('../utils/time');

const LEVELS = { 1: '学徒', 2: '熟练', 3: '骨干', 4: '师傅' };
const SOURCES = { assessed: '考核评定', actual: '仅有报工', self: '本人自报' };
const COURSE_TYPES = { onboard: '入职培训', skill: '技能培训', refresh: '复训', safety: '安全教育' };

const today = () => localDate(now());
const bad = (msg) => {
  const e = new Error(msg);
  e.status = 400;
  return e;
};
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const diffDays = (from, to) => {
  if (!from || !to) return null;
  const a = new Date(`${String(from).slice(0, 10)}T00:00:00`);
  const b = new Date(`${String(to).slice(0, 10)}T00:00:00`);
  return Math.round((b - a) / 86400000);
};

/* ==================================================================== *
 * 一、基础查询
 * ==================================================================== */

/** 技能行是否还在有效期内（技能有效期 + 状态） */
function skillLive(row) {
  if (!row) return false;
  if (row.status !== 'active') return false;
  if (!row.valid_until) return true;
  return String(row.valid_until).slice(0, 10) >= today();
}

/** 证书是否有效（没有到期日 = 长期有效） */
function certLive(row) {
  if (!row) return false;
  if (row.status !== 'valid') return false;
  if (!row.expire_date) return true;
  return String(row.expire_date).slice(0, 10) >= today();
}

function requirements() {
  return db.prepare('SELECT * FROM skill_requirements ORDER BY id').all();
}

function reqOf(processName) {
  return db.prepare('SELECT * FROM skill_requirements WHERE process_name = ?').get(processName) || null;
}

function skillOf(employeeId, processName) {
  return db
    .prepare('SELECT * FROM employee_skills WHERE employee_id = ? AND process_name = ?')
    .get(employeeId, processName) || null;
}

/** 生效中的破格放行 */
function overrideOf(employeeId, processName) {
  return (
    db
      .prepare(
        `SELECT * FROM skill_overrides
          WHERE employee_id = ? AND process_name = ? AND status = 'active' AND valid_until >= ?
          ORDER BY valid_until DESC LIMIT 1`
      )
      .get(employeeId, processName, today()) || null
  );
}

/* ==================================================================== *
 * 二、能不能上这道工序（门禁，报工时调用）
 * ==================================================================== */

/**
 * 判定某人能不能上某道工序
 * 返回 { allowed, reason, need_level, level, source, via_override }
 *
 * 注意：`allowed=true` 不代表「有资格」，只代表「不拦」。
 * 非受限工序、查不到的门槛、破格放行都属于「不拦但要能看见」。
 */
function canWork(employeeId, processName, opts = {}) {
  const proc = String(processName || '').trim();
  if (!proc) return { allowed: true, reason: '未指定工序，不校验' };

  const req = reqOf(proc);
  const skill = employeeId ? skillOf(Number(employeeId), proc) : null;
  const ov = employeeId ? overrideOf(Number(employeeId), proc) : null;
  const level = skill ? Number(skill.level) : null;
  const live = skillLive(skill);
  const needLevel = req ? Number(req.min_level) : 0;

  if (!req) {
    return {
      allowed: true, need_level: null, level, source: skill ? skill.source : null, via_override: !!ov,
      reason: `「${proc}」还没设资格门槛，本次不校验`
    };
  }
  if (!req.restricted) {
    return {
      allowed: true, need_level: needLevel, level, source: skill ? skill.source : null, via_override: !!ov,
      reason: `「${proc}」非受限工序（要求 ${LEVELS[needLevel] || needLevel}），只提示不拦`
    };
  }
  if (live && level >= needLevel) {
    return {
      allowed: true, need_level: needLevel, level, source: skill.source, via_override: false,
      reason: `资格有效（${LEVELS[level]} ≥ ${LEVELS[needLevel]}）`
    };
  }
  if (ov) {
    return {
      allowed: true, need_level: needLevel, level, source: skill ? skill.source : null, via_override: true,
      reason: `破格放行至 ${ov.valid_until}（${ov.reason}），本次放行但已记入覆盖清单`
    };
  }

  let why;
  if (!skill) why = `没有「${proc}」的技能记录`;
  else if (skill.status !== 'active') why = `技能状态为${skill.status === 'revoked' ? '已撤销' : '已失效'}`;
  else if (!live) why = `技能有效期到 ${skill.valid_until}，已过期需复评`;
  else why = `等级不够（${LEVELS[level] || level} < ${LEVELS[needLevel]})`;
  return {
    allowed: false, need_level: needLevel, level, source: skill ? skill.source : null, via_override: false,
    reason: `「${proc}」是受限工序：${why}`
  };
}

/**
 * 报工门禁用：查不到人就不拦（但覆盖分析里会把「未归属报工」单列出来）
 * 返回 { ok, reason, blocked_by: 'skill' }
 */
function gateForReport(employeeId, processName) {
  if (!employeeId) return { ok: true, reason: '报工人不在员工档案，本次不校验技能' };
  const r = canWork(employeeId, processName);
  return { ok: r.allowed, reason: r.reason, detail: r };
}

/* ==================================================================== *
 * 三、矩阵
 * ==================================================================== */

/**
 * 人 × 工序 矩阵
 * @param {object} q { department_id, q, include_left, include_empty }
 *
 * 默认只列「有技能记录的人」：24 个人里 8 个跟单、4 个运营一条技能都没有，
 * 全列出来就是十几行空白，矩阵反而看不清谁真会做。
 * 没记录的人数单独返回（without_skill），页脚写出来 —— 不显示不等于不存在。
 */
function matrix(q = {}) {
  const where = [];
  const args = [];
  if (!q.include_left) where.push("IFNULL(e.status,'active') = 'active'");
  if (q.department_id) {
    where.push('e.department_id = ?');
    args.push(Number(q.department_id));
  }
  if (q.q) {
    where.push('(e.name LIKE ? OR e.code LIKE ? OR IFNULL(e.position,\'\') LIKE ?)');
    args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  const emps = db
    .prepare(
      `SELECT e.id, e.code, e.name, e.position, e.department_id, IFNULL(d.name,'未分部门') dept
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY d.name, e.name`
    )
    .all(...args);

  const reqs = requirements();
  // 矩阵的列：资格要求里的工序 + 员工已经做过/评过的工序（避免「做过但没门槛」的格子消失）
  const used = db.prepare('SELECT DISTINCT process_name FROM employee_skills').all().map((r) => r.process_name);
  const procNames = [...reqs.map((r) => r.process_name)];
  used.forEach((p) => {
    if (p && !procNames.includes(p)) procNames.push(p);
  });
  const reqMap = {};
  reqs.forEach((r) => { reqMap[r.process_name] = r; });

  const processes = procNames.map((p) => ({
    process_name: p,
    work_center: reqMap[p] ? reqMap[p].work_center : null,
    min_level: reqMap[p] ? Number(reqMap[p].min_level) : null,
    restricted: reqMap[p] ? !!reqMap[p].restricted : false,
    has_requirement: !!reqMap[p]
  }));

  const skills = db.prepare('SELECT * FROM employee_skills').all();
  const ovs = db
    .prepare("SELECT * FROM skill_overrides WHERE status='active' AND valid_until >= ?")
    .all(today());
  const cellMap = {};
  skills.forEach((s) => { cellMap[`${s.employee_id}|${s.process_name}`] = s; });
  const ovMap = {};
  ovs.forEach((o) => { ovMap[`${o.employee_id}|${o.process_name}`] = o; });

  const rows = emps.map((e) => {
    const cells = {};
    let qualified = 0;
    let evidenceOnly = 0;
    processes.forEach((p) => {
      const s = cellMap[`${e.id}|${p.process_name}`];
      const ov = ovMap[`${e.id}|${p.process_name}`];
      if (!s && !ov) return;
      const live = skillLive(s);
      const meets = s && live && p.min_level != null ? Number(s.level) >= Number(p.min_level) : (s ? live : false);
      if (meets) qualified += 1;
      if (s && s.source === 'actual') evidenceOnly += 1;
      cells[p.process_name] = {
        level: s ? Number(s.level) : null,
        level_label: s ? LEVELS[s.level] : null,
        source: s ? s.source : null,
        source_label: s ? SOURCES[s.source] : null,
        status: s ? (live ? 'active' : (s.status === 'revoked' ? 'revoked' : 'expired')) : 'none',
        valid_until: s ? s.valid_until : null,
        report_count: s ? s.report_count : 0,
        meets: !!meets,
        override_until: ov ? ov.valid_until : null
      };
    });
    return {
      employee_id: e.id, code: e.code, name: e.name, position: e.position,
      department_id: e.department_id, dept: e.dept,
      cells, qualified_count: qualified, evidence_only_count: evidenceOnly
    };
  });

  // 默认只留有技能记录的人（见函数注释）；要全量传 include_empty=1
  const keepAll = String(q.include_empty) === '1' || q.include_empty === true;
  const shown = keepAll ? rows : rows.filter((r) => Object.keys(r.cells).length > 0);
  const withoutSkill = rows.length - shown.length;

  return {
    processes,
    rows: shown,
    without_skill: withoutSkill,
    summary: {
      employees: shown.length,
      employees_all: rows.length,
      without_skill: withoutSkill,
      processes: processes.length,
      // 「有门槛但没人合格」的工序：排产时最容易漏的地方
      uncovered: processes
        .filter((p) => p.has_requirement)
        .filter((p) => !rows.some((r) => r.cells[p.process_name] && r.cells[p.process_name].meets))
        .map((p) => p.process_name),
      multi_skill: shown.filter((r) => r.qualified_count >= 2).length
    }
  };
}

/* ==================================================================== *
 * 四、覆盖缺口（给排产看：这道工序到底几个人能上）
 * ==================================================================== */

function coverage() {
  const reqs = requirements();
  const rows = db.prepare('SELECT * FROM employee_skills').all();
  const ovs = db
    .prepare("SELECT * FROM skill_overrides WHERE status='active' AND valid_until >= ?")
    .all(today());

  const list = reqs.map((r) => {
    const mine = rows.filter((s) => s.process_name === r.process_name);
    const qualified = mine.filter((s) => skillLive(s) && Number(s.level) >= Number(r.min_level));
    const evidenceOnly = mine.filter((s) => s.source === 'actual');
    const expired = mine.filter((s) => !skillLive(s) && s.status === 'active'); // 有记录但过期
    const ovCount = ovs.filter((o) => o.process_name === r.process_name).length;
    const need = Number(r.min_headcount) || 1;
    const gap = need - qualified.length;
    return {
      process_name: r.process_name,
      work_center: r.work_center,
      min_level: Number(r.min_level),
      min_level_label: LEVELS[r.min_level] || String(r.min_level),
      min_headcount: need,
      qualified: qualified.length,
      evidence_only: evidenceOnly.length,
      expired: expired.length,
      overrides: ovCount,
      restricted: !!r.restricted,
      gap: gap > 0 ? gap : 0,
      status: qualified.length === 0 ? 'none' : (gap > 0 ? 'short' : 'ok'),
      // 只有事实证据的人不是「没人」，但也不能算「合格」——单独说清楚
      note: qualified.length === 0 && evidenceOnly.length > 0
        ? `有 ${evidenceOnly.length} 人做过，但都没评定过，不能算合格上岗`
        : null,
      people: qualified.map((s) => ({ employee_id: s.employee_id, name: s.employee_name, level: s.level, valid_until: s.valid_until }))
    };
  });

  // 排程/报工用到、但资格要求里没有的工序：要么漏建门槛，要么工序名对不上
  const usedByProd = db
    .prepare("SELECT name, COUNT(*) c FROM order_nodes WHERE IFNULL(name,'') <> '' GROUP BY name")
    .all();
  const known = new Set(reqs.map((r) => r.process_name));
  const unmapped = usedByProd
    .filter((x) => !known.has(x.name))
    .map((x) => ({ process_name: x.name, node_count: x.c }));

  // 报工里查不到员工的比例：这部分技能永远进不了矩阵
  const rep = db
    .prepare(
      `SELECT COUNT(*) total, SUM(CASE WHEN employee_id IS NULL THEN 1 ELSE 0 END) no_emp
         FROM production_reports`
    )
    .get();

  return {
    list,
    unmapped,
    summary: {
      processes: list.length,
      ok: list.filter((x) => x.status === 'ok').length,
      short: list.filter((x) => x.status === 'short').length,
      none: list.filter((x) => x.status === 'none').length,
      restricted: list.filter((x) => x.restricted).length,
      unmapped: unmapped.length,
      report_total: rep.total || 0,
      report_no_employee: rep.no_emp || 0,
      report_employee_rate: rep.total ? r2(((rep.total - (rep.no_emp || 0)) / rep.total) * 100) : null
    }
  };
}

/* ==================================================================== *
 * 五、到期提醒
 * ==================================================================== */

/**
 * 到期清单：技能复评 / 资格证书 / 复训
 * @param {object} q { days=60 }
 */
function expiring(q = {}) {
  const days = Number(q.days) || 60;
  const until = localDate(new Date(Date.now() + days * 86400000).toISOString());
  const t = today();
  const out = [];

  db.prepare(
    `SELECT * FROM employee_skills WHERE status='active' AND IFNULL(valid_until,'') <> ''
       AND valid_until <= ? ORDER BY valid_until`
  ).all(until).forEach((s) => {
    out.push({
      kind: 'skill',
      kind_label: '技能复评',
      employee_id: s.employee_id,
      employee_name: s.employee_name,
      item: s.process_name,
      expire_date: s.valid_until,
      days_left: diffDays(t, s.valid_until),
      overdue: String(s.valid_until).slice(0, 10) < t
    });
  });

  db.prepare(
    `SELECT * FROM skill_certs WHERE status='valid' AND IFNULL(expire_date,'') <> ''
       AND expire_date <= ? ORDER BY expire_date`
  ).all(until).forEach((c) => {
    out.push({
      kind: 'cert',
      kind_label: '资格证书',
      employee_id: c.employee_id,
      employee_name: c.employee_name,
      item: `${c.cert_type}${c.cert_no ? '（' + c.cert_no + '）' : ''}`,
      expire_date: c.expire_date,
      days_left: diffDays(t, c.expire_date),
      overdue: String(c.expire_date).slice(0, 10) < t
    });
  });

  db.prepare(
    `SELECT * FROM training_records WHERE IFNULL(expire_date,'') <> '' AND expire_date <= ?
       AND result = 'pass' ORDER BY expire_date`
  ).all(until).forEach((r) => {
    out.push({
      kind: 'refresh',
      kind_label: '复训到期',
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      item: r.course_name,
      expire_date: r.expire_date,
      days_left: diffDays(t, r.expire_date),
      overdue: String(r.expire_date).slice(0, 10) < t
    });
  });

  out.sort((a, b) => String(a.expire_date).localeCompare(String(b.expire_date)));
  return {
    days,
    until,
    rows: out,
    summary: {
      total: out.length,
      overdue: out.filter((x) => x.overdue).length,
      within30: out.filter((x) => !x.overdue && x.days_left != null && x.days_left <= 30).length,
      skill: out.filter((x) => x.kind === 'skill').length,
      cert: out.filter((x) => x.kind === 'cert').length,
      refresh: out.filter((x) => x.kind === 'refresh').length
    }
  };
}

/* ==================================================================== *
 * 六、写操作：评定 / 撤销 / 门槛 / 证书 / 培训 / 破格
 * ==================================================================== */

/** 评定技能（唯一能改等级的地方） */
function assess(body = {}, operator = '') {
  const employeeId = Number(body.employee_id);
  const proc = String(body.process_name || '').trim();
  const level = Number(body.level);
  if (!employeeId) throw bad('缺少员工');
  if (!proc) throw bad('缺少工序');
  if (!LEVELS[level]) throw bad('等级只能是 1 学徒 / 2 熟练 / 3 骨干 / 4 师傅');

  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!emp) throw bad('员工不存在');
  if (emp.status === 'left') throw bad(`${emp.name} 已离职，不能评定技能`);

  const req = reqOf(proc);
  if (!req) throw bad(`「${proc}」不在资格要求里，请先在「工序门槛」里建这条`);

  // 评级必须有人负责、有依据：否则矩阵就是一堆谁都能填的数字
  const evidence = String(body.evidence || '').trim();
  if (evidence.length < 4) throw bad('评定依据至少 4 个字（考了什么、做了几件、谁在旁边看）');
  const validUntil = body.valid_until ? String(body.valid_until).slice(0, 10) : null;
  if (validUntil && validUntil < today()) throw bad('有效期不能早于今天');

  const old = skillOf(employeeId, proc);
  const t = now();
  if (old) {
    db.prepare(
      `UPDATE employee_skills
          SET level = ?, source = 'assessed', assessed_by = ?, assessed_at = ?, evidence = ?,
              valid_until = ?, status = 'active', employee_name = ?, updated_at = ?
        WHERE id = ?`
    ).run(level, operator || null, t, evidence, validUntil, emp.name, t, old.id);
  } else {
    db.prepare(
      `INSERT INTO employee_skills (employee_id, employee_name, process_name, level, source, assessed_by, assessed_at,
         evidence, valid_until, status, report_count, created_at, updated_at)
       VALUES (?,?,?,?,'assessed',?,?,?,?,'active',0,?,?)`
    ).run(employeeId, emp.name, proc, level, operator || null, t, evidence, validUntil, t, t);
  }

  return {
    employee_id: employeeId,
    employee_name: emp.name,
    process_name: proc,
    level,
    level_label: LEVELS[level],
    before: old ? { level: old.level, source: old.source } : null,
    // 降级要显式提示：多半是复评没过，别让人以为点错了
    downgraded: !!(old && Number(old.level) > level)
  };
}

/** 撤销技能（离职、调岗、复评不合格） */
function revoke(body = {}, operator = '') {
  const employeeId = Number(body.employee_id);
  const proc = String(body.process_name || '').trim();
  const reason = String(body.reason || '').trim();
  if (!employeeId || !proc) throw bad('缺少员工或工序');
  if (reason.length < 4) throw bad('撤销要写原因（至少 4 个字）');
  const s = skillOf(employeeId, proc);
  if (!s) throw bad('没有这条技能记录');
  db.prepare("UPDATE employee_skills SET status='revoked', remark=?, updated_at=? WHERE id=?")
    .run(`${reason}（${operator || '系统'} 于 ${now()}）`, now(), s.id);
  return { employee_id: employeeId, process_name: proc, status: 'revoked' };
}

/** 维护工序门槛 */
function saveRequirement(body = {}, operator = '') {
  const proc = String(body.process_name || '').trim();
  if (!proc) throw bad('缺少工序名');
  const minLevel = Number(body.min_level) || 2;
  if (!LEVELS[minLevel]) throw bad('最低等级只能是 1–4');
  const restricted = body.restricted ? 1 : 0;
  const minHead = Math.max(1, Number(body.min_headcount) || 1);
  const t = now();
  const old = reqOf(proc);
  const warnings = [];

  if (old) {
    db.prepare(
      `UPDATE skill_requirements SET work_center=?, min_level=?, restricted=?, cert_type=?, min_headcount=?,
         note=?, updated_by=?, updated_at=? WHERE id=?`
    ).run(body.work_center || old.work_center, minLevel, restricted, body.cert_type || null,
      minHead, body.note || old.note, operator || null, t, old.id);
  } else {
    db.prepare(
      `INSERT INTO skill_requirements (process_name, work_center, min_level, restricted, cert_type, min_headcount, note, updated_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(proc, body.work_center || null, minLevel, restricted, body.cert_type || null, minHead,
      body.note || null, operator || null, t, t);
  }

  // 打开受限开关时先算一下现状：没人合格就说明「一开就停线」
  if (restricted && (!old || !old.restricted)) {
    const cov = coverage().list.find((x) => x.process_name === proc);
    if (cov && cov.qualified === 0) {
      warnings.push(`「${proc}」目前 0 人合格，打开受限后这道工序将无法报工 —— 请先评定或开破格放行`);
    }
  }
  return { process_name: proc, restricted, min_level: minLevel, warnings };
}

/* ---------------- 证书 ---------------- */

function addCert(body = {}, operator = '') {
  const employeeId = Number(body.employee_id);
  const certType = String(body.cert_type || '').trim();
  if (!employeeId) throw bad('缺少员工');
  if (!certType) throw bad('缺少证书类型');
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!emp) throw bad('员工不存在');
  const expire = body.expire_date ? String(body.expire_date).slice(0, 10) : null;
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO skill_certs (employee_id, employee_name, cert_type, cert_no, issuer, issue_date, expire_date, status, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(employeeId, emp.name, certType, body.cert_no || null, body.issuer || null,
      body.issue_date || null, expire, expire && expire < today() ? 'expired' : 'valid',
      body.remark || null, t, t);
  return db.prepare('SELECT * FROM skill_certs WHERE id = ?').get(Number(info.lastInsertRowid));
}

function revokeCert(id, reason = '', operator = '') {
  const row = db.prepare('SELECT * FROM skill_certs WHERE id = ?').get(Number(id));
  if (!row) throw bad('证书不存在');
  if (String(reason).trim().length < 4) throw bad('作废证书要写原因（至少 4 个字）');
  db.prepare("UPDATE skill_certs SET status='revoked', remark=?, updated_at=? WHERE id=?")
    .run(`${reason}（${operator || '系统'}）`, now(), row.id);
  return { id: row.id, status: 'revoked' };
}

/* ---------------- 培训 ---------------- */

function addTraining(body = {}, operator = '') {
  const employeeId = Number(body.employee_id);
  const course = String(body.course_name || '').trim();
  if (!employeeId) throw bad('缺少员工');
  if (course.length < 2) throw bad('缺少课程名称');
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!emp) throw bad('员工不存在');
  const type = COURSE_TYPES[body.course_type] ? body.course_type : 'skill';
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO training_records (employee_id, employee_name, course_name, course_type, planned_at, finished_at,
         hours, score, result, expire_date, trainer, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(employeeId, emp.name, course, type, body.planned_at || null, body.finished_at || null,
      Number(body.hours) || null, body.score == null ? null : Number(body.score),
      ['pending', 'pass', 'fail'].includes(body.result) ? body.result : 'pending',
      body.expire_date || null, body.trainer || operator || null, body.remark || null, t, t);
  return db.prepare('SELECT * FROM training_records WHERE id = ?').get(Number(info.lastInsertRowid));
}

/** 登记培训结果（通过/不通过 + 复训到期日） */
function finishTraining(id, body = {}, operator = '') {
  const row = db.prepare('SELECT * FROM training_records WHERE id = ?').get(Number(id));
  if (!row) throw bad('培训记录不存在');
  const result = ['pass', 'fail'].includes(body.result) ? body.result : null;
  if (!result) throw bad('结果只能是 pass 或 fail');
  const finished = body.finished_at || today();
  db.prepare(
    'UPDATE training_records SET result=?, finished_at=?, score=?, expire_date=?, remark=?, updated_at=? WHERE id=?'
  ).run(result, finished, body.score == null ? row.score : Number(body.score),
    body.expire_date || row.expire_date, body.remark || row.remark, now(), row.id);
  const out = db.prepare('SELECT * FROM training_records WHERE id = ?').get(row.id);
  // 培训不通过不扣钱、不自动降级 —— 只提示需要复训（原型：AI 不能自动打低分）
  return { ...out, note: result === 'fail' ? '未通过，需安排复训；本系统不因此扣款或自动降级' : null };
}

/* ---------------- 破格放行 ---------------- */

function overrideSkill(body = {}, operator = '') {
  const employeeId = Number(body.employee_id);
  const proc = String(body.process_name || '').trim();
  const reason = String(body.reason || '').trim();
  const until = String(body.valid_until || '').slice(0, 10);
  if (!employeeId || !proc) throw bad('缺少员工或工序');
  if (reason.length < 6) throw bad('破格理由至少 6 个字（受限工序放行要能追溯）');
  if (!until) throw bad('必须写有效期，破格不能变成永久后门');
  if (until < today()) throw bad('有效期不能早于今天');

  const req = reqOf(proc);
  if (!req) throw bad(`「${proc}」没有资格要求，不需要破格`);
  if (!req.restricted) throw bad(`「${proc}」不是受限工序，不需要破格`);

  const chk = canWork(employeeId, proc);
  if (chk.allowed && !chk.via_override) throw bad(`${chk.reason}，无需破格`);

  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!emp) throw bad('员工不存在');
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO skill_overrides (employee_id, employee_name, process_name, reason, approved_by, valid_until, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'active',?,?)`
    )
    .run(employeeId, emp.name, proc, reason, operator || null, until, t, t);
  return {
    id: Number(info.lastInsertRowid),
    employee_name: emp.name, process_name: proc, valid_until: until,
    note: '已记入覆盖清单，排产和稽核都能看到这条破格'
  };
}

/* ==================================================================== *
 * 七、统计与字典
 * ==================================================================== */

function stats() {
  const t = today();
  const g = (sql, ...a) => db.prepare(sql).get(...a).c;
  return {
    employees: g("SELECT COUNT(*) c FROM employees WHERE IFNULL(status,'active')='active'"),
    processes: g('SELECT COUNT(*) c FROM skill_requirements'),
    restricted: g('SELECT COUNT(*) c FROM skill_requirements WHERE restricted = 1'),
    skill_rows: g('SELECT COUNT(*) c FROM employee_skills'),
    assessed: g("SELECT COUNT(*) c FROM employee_skills WHERE source='assessed'"),
    evidence_only: g("SELECT COUNT(*) c FROM employee_skills WHERE source='actual'"),
    expired: g("SELECT COUNT(*) c FROM employee_skills WHERE status='active' AND IFNULL(valid_until,'') <> '' AND valid_until < ?", t),
    certs: g("SELECT COUNT(*) c FROM skill_certs WHERE status='valid'"),
    certs_expired: g("SELECT COUNT(*) c FROM skill_certs WHERE expire_date IS NOT NULL AND expire_date < ?", t),
    overrides: g("SELECT COUNT(*) c FROM skill_overrides WHERE status='active' AND valid_until >= ?", t),
    trainings: g('SELECT COUNT(*) c FROM training_records'),
    training_rate: (() => {
      const r = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN result='pass' THEN 1 ELSE 0 END) ok FROM training_records").get();
      return r.total ? r2((r.ok / r.total) * 100) : null;
    })()
  };
}

function meta() {
  return {
    levels: Object.entries(LEVELS).map(([v, label]) => ({ value: Number(v), label })),
    sources: Object.entries(SOURCES).map(([v, label]) => ({ value: v, label })),
    course_types: Object.entries(COURSE_TYPES).map(([v, label]) => ({ value: v, label })),
    departments: db.prepare('SELECT id, name FROM departments ORDER BY id').all(),
    processes: requirements(),
    stats: stats()
  };
}

/** 员工视角：我有哪些技能、哪些快到期（给员工自助留的接口，权限单独控） */
function mySkills(employeeId) {
  const id = Number(employeeId);
  const emp = db.prepare('SELECT id, code, name, position FROM employees WHERE id = ?').get(id);
  if (!emp) throw bad('员工不存在');
  const skills = db.prepare('SELECT * FROM employee_skills WHERE employee_id = ? ORDER BY process_name').all(id);
  const reqs = {};
  requirements().forEach((r) => { reqs[r.process_name] = r; });
  return {
    employee: emp,
    skills: skills.map((s) => {
      const req = reqs[s.process_name];
      const live = skillLive(s);
      return {
        process_name: s.process_name,
        level: s.level,
        level_label: LEVELS[s.level],
        source: s.source,
        source_label: SOURCES[s.source],
        status: live ? 'active' : (s.status === 'revoked' ? 'revoked' : 'expired'),
        valid_until: s.valid_until,
        // 能不能独立上这道工序，员工自己就能看出来
        can_work_alone: !!(req && live && Number(s.level) >= Number(req.min_level)),
        need_level: req ? Number(req.min_level) : null
      };
    }),
    certs: db.prepare('SELECT * FROM skill_certs WHERE employee_id = ? ORDER BY expire_date').all(id),
    trainings: db.prepare('SELECT * FROM training_records WHERE employee_id = ? ORDER BY IFNULL(planned_at, created_at) DESC').all(id)
  };
}

module.exports = {
  LEVELS, SOURCES, COURSE_TYPES,
  canWork, gateForReport,
  matrix, coverage, expiring,
  assess, revoke, saveRequirement,
  addCert, revokeCert, addTraining, finishTraining, overrideSkill,
  stats, meta, mySkills,
  certLive, skillLive
};
