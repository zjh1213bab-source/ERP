/**
 * 组织编制与岗位管理（原型 M02）
 * ============================================================
 * 四个业务对象：
 *   1. 岗位序列与编制（org_positions）—— 一个部门下有几个岗、每个岗几个编、向谁汇报
 *   2. 任职关系（employments）—— 谁被哪家公司雇佣、服务哪些主体、在哪个岗、从哪天到哪天
 *   3. 交易路线（trade_routes）—— 一单生意里谁是卖方/履约/货主/签约/付款
 *   4. 主体视图（subject_scopes）—— 某个账号能看哪些公司、哪些字段、能不能汇总
 *
 * 几条必须写死的规矩（都是实际会出事的地方）：
 *
 * ① **一个人同一时刻只能有一条生效任职**
 *    数据库用部分唯一索引兜底（`WHERE status='effective'`），服务层再做一次友好提示。
 *    换岗不能「改原来那条」，必须结束旧的 + 起新的，否则历史没了，查去年在哪个岗查不到。
 *
 * ② **雇佣公司 ≠ 服务公司**
 *    技术部是总部独立部门，但要服务各公司。所以 employments 同时记 employer 和 service。
 *    也不能拿 A 公司的岗位挂在 B 公司的雇佣上 —— 岗位归属与雇佣公司必须一致。
 *
 * ③ **超编要拦，特批要留痕**
 *    编制数 > 0 才有约束（0 = 未核定）。占用编制是在**批准**那一刻算的，不是起草时；
 *    超编必须带 over_headcount 标记 + 原因，两个缺一个都不许批。
 *
 * ④ **不能自己批自己**
 *    任职、授权范围两类单据，批准人不能是申请人。
 *
 * ⑤ **签约方 ≠ 卖方，必须有服务协议**
 *    这是真实税务风险：谁签合同、谁开票、谁收款不一致，没有协议就是三流不一致。
 *
 * ⑥ **授权有到期日，到期自动失效**
 *    字段范围（不看薪资/不看成本）与汇总范围（单主体/集团）分开记；
 *    股权比例不等于权限，也不等于费用分摊比例 —— 这里只记「能看什么」，不参与分摊计算。
 *
 * 时间口径：本地墙钟字符串（services/sla.js）。
 */
const { db } = require('../db');
const { localNow, localDate } = require('./sla');

/** ==================== 字典 ==================== */

const SEQ_LABEL = {
  manage: '管理序列', professional: '专业序列', sales: '销售序列', tech: '技术序列', ops: '操作序列'
};
const EMP_TYPE_LABEL = {
  fulltime: '全职', parttime: '兼职', secondment: '外派', outsource: '外包'
};
const EMP_STATUS_LABEL = {
  draft: '草稿', pending: '待批', effective: '生效中', ended: '已结束', rejected: '已驳回'
};
const ROUTE_LABEL = {
  spot: '现货', custom: '定制', outsource: '外协', service: '服务'
};
const ROUTE_STATUS_LABEL = {
  draft: '草稿', confirmed: '已确认', pending_terms: '条款待配', disabled: '已停用'
};
const SCOPE_STATUS_LABEL = {
  draft: '草稿', pending: '待批', effective: '有效', expired: '已到期', rejected: '已驳回'
};
const FIELD_SCOPE_LABEL = {
  full: '全部字段', no_salary: '不看薪资', no_cost: '不看成本'
};
const AGG_LABEL = { company: '单主体', group: '集团汇总' };

/** ==================== 小工具 ==================== */

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function addDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(n || 0));
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const x = new Date(String(a).slice(0, 10) + 'T00:00:00');
  const y = new Date(String(b).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(x.getTime()) || Number.isNaN(y.getTime())) return null;
  return Math.round((y - x) / 86400000);
}

function nextNo(prefix, table, col) {
  const d = localDate().replace(/-/g, '');
  const head = `${prefix}${d}`;
  const row = db.prepare(`SELECT ${col} AS v FROM ${table} WHERE ${col} LIKE ? ORDER BY ${col} DESC LIMIT 1`).get(head + '%');
  const seq = row && row.v ? Number(String(row.v).slice(head.length)) + 1 : 1;
  return head + String(seq).padStart(4, '0');
}

function defaultCompany() {
  const c = db.prepare("SELECT id FROM companies WHERE status='active' ORDER BY id LIMIT 1").get();
  return c ? c.id : 1;
}

const companyName = (id) => (id ? (db.prepare('SELECT name FROM companies WHERE id=?').get(id) || {}).name : null);
const deptName = (id) => (id ? (db.prepare('SELECT name FROM departments WHERE id=?').get(id) || {}).name : null);
const empName = (id) => (id ? (db.prepare('SELECT name FROM employees WHERE id=?').get(id) || {}).name : null);

/** ==================== 岗位与编制 ==================== */

/** 某岗位当前在职人数（只算生效中的任职） */
function inServiceOf(positionId) {
  return db.prepare("SELECT COUNT(*) c FROM employments WHERE position_id=? AND status='effective'").get(positionId).c;
}

/** 某部门已核定的编制合计与在职合计（部门下所有启用岗位） */
function deptHeadcount(departmentId) {
  const row = db.prepare(
    "SELECT COALESCE(SUM(headcount),0) hc, COUNT(*) pos FROM org_positions WHERE department_id=? AND status='active'"
  ).get(departmentId);
  const used = db.prepare(
    `SELECT COUNT(*) c FROM employments e JOIN org_positions p ON p.id=e.position_id
     WHERE p.department_id=? AND e.status='effective'`
  ).get(departmentId).c;
  return { headcount: row.hc, positions: row.pos, in_service: used, vacant: Math.max(0, row.hc - used), over: Math.max(0, used - row.hc) };
}

/** 汇报链：往上走到头，顺便检测环 */
function reportChain(positionId) {
  const chain = [];
  const seen = new Set();
  let cur = db.prepare('SELECT * FROM org_positions WHERE id=?').get(Number(positionId));
  while (cur) {
    if (seen.has(cur.id)) {
      chain.push({ id: cur.id, title: cur.title, cyclic: true });
      break;
    }
    seen.add(cur.id);
    chain.push({ id: cur.id, title: cur.title, dept: deptName(cur.department_id), grade: cur.grade });
    if (!cur.reports_to_id) break;
    cur = db.prepare('SELECT * FROM org_positions WHERE id=?').get(cur.reports_to_id);
  }
  return chain;
}

function shapePosition(p) {
  const used = inServiceOf(p.id);
  const hc = Number(p.headcount) || 0;
  return {
    ...p,
    sequence_label: SEQ_LABEL[p.sequence] || p.sequence,
    company_name: companyName(p.company_id),
    department_name: deptName(p.department_id),
    reports_to_title: p.reports_to_id
      ? (db.prepare('SELECT title FROM org_positions WHERE id=?').get(p.reports_to_id) || {}).title
      : null,
    in_service: used,
    headcount: hc,
    vacant: hc > 0 ? Math.max(0, hc - used) : null,
    over: hc > 0 ? Math.max(0, used - hc) : 0,
    fill_rate: hc > 0 ? Math.round((used / hc) * 1000) / 10 : null
  };
}

function listPositions(q = {}) {
  const wh = [];
  const args = [];
  if (q.company_id) { wh.push('company_id=?'); args.push(Number(q.company_id)); }
  if (q.department_id) { wh.push('department_id=?'); args.push(Number(q.department_id)); }
  if (q.status) { wh.push('status=?'); args.push(q.status); }
  if (q.sequence) { wh.push('sequence=?'); args.push(q.sequence); }
  if (q.q) { wh.push('(title LIKE ? OR code LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
  return db.prepare(
    `SELECT * FROM org_positions ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY company_id, department_id, COALESCE(grade,99), id`
  ).all(...args).map(shapePosition);
}

function getPosition(id) {
  const p = db.prepare('SELECT * FROM org_positions WHERE id=?').get(Number(id));
  if (!p) return null;
  const staff = db.prepare(
    `SELECT e.*, m.code AS emp_code FROM employments e LEFT JOIN employees m ON m.id=e.employee_id
     WHERE e.position_id=? AND e.status='effective' ORDER BY e.start_date`
  ).all(p.id).map((e) => ({
    ...e,
    employee_name: empName(e.employee_id),
    employee_code: e.emp_code,
    employer_name: companyName(e.employer_company_id),
    service_name: e.service_company_id ? companyName(e.service_company_id) : '全部主体'
  }));
  return {
    ...shapePosition(p),
    staff,
    chain: reportChain(p.id),
    sub: db.prepare('SELECT id, code, title FROM org_positions WHERE reports_to_id=?').all(p.id)
  };
}

function createPosition(b = {}, operator) {
  const title = String(b.title || '').trim();
  if (!title) throw new Error('岗位名称必填');
  const companyId = Number(b.company_id) || defaultCompany();
  if (!db.prepare("SELECT id FROM companies WHERE id=? AND status='active'").get(companyId)) {
    throw new Error('岗位归属公司不存在或已停用');
  }
  const deptId = b.department_id ? Number(b.department_id) : null;
  if (deptId) {
    const d = db.prepare('SELECT * FROM departments WHERE id=?').get(deptId);
    if (!d) throw new Error('部门不存在');
    if (Number(d.company_id) !== companyId) throw new Error('部门不属于该岗位归属公司');
  }
  const seq = Object.keys(SEQ_LABEL).includes(b.sequence) ? b.sequence : 'ops';
  const hc = Number(b.headcount);
  if (b.headcount !== undefined && (!Number.isFinite(hc) || hc < 0 || hc > 999)) throw new Error('编制数必须是 0-999 的整数');
  const grade = b.grade === undefined || b.grade === '' ? null : Number(b.grade);
  if (grade !== null && (!Number.isInteger(grade) || grade < 1 || grade > 9)) throw new Error('职级必须是 1-9');
  if (b.effective_from && !isDate(b.effective_from)) throw new Error('生效日期格式必须是 YYYY-MM-DD');

  const dup = db.prepare('SELECT id FROM org_positions WHERE company_id=? AND department_id IS ? AND title=?')
    .get(companyId, deptId, title);
  if (dup) throw new Error(`同一部门下已有岗位「${title}」，不要重复建`);

  const reportsTo = b.reports_to_id ? Number(b.reports_to_id) : null;
  if (reportsTo) {
    if (!db.prepare('SELECT id FROM org_positions WHERE id=?').get(reportsTo)) throw new Error('汇报岗位不存在');
  }

  const now = localNow();
  const id = db.prepare(
    `INSERT INTO org_positions (code,title,company_id,department_id,sequence,grade,headcount,reports_to_id,
       status,effective_from,remark,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo('P', 'org_positions', 'code'), title, companyId, deptId, seq, grade,
    b.headcount === undefined ? 0 : Math.round(hc), reportsTo, 'active',
    b.effective_from || localDate(), b.remark || null, operator || 'system', now, now
  ).lastInsertRowid;
  return getPosition(id);
}

function updatePosition(id, b = {}, operator) {
  const p = db.prepare('SELECT * FROM org_positions WHERE id=?').get(Number(id));
  if (!p) throw new Error('岗位不存在');
  const used = inServiceOf(p.id);

  let reportsTo = b.reports_to_id !== undefined ? (b.reports_to_id ? Number(b.reports_to_id) : null) : p.reports_to_id;
  if (reportsTo === p.id) throw new Error('不能汇报给自己');
  if (reportsTo) {
    if (!db.prepare('SELECT id FROM org_positions WHERE id=?').get(reportsTo)) throw new Error('汇报岗位不存在');
    // 汇报链不能成环：把「我」放进去走一遍，若回到「我」就是环
    let cur = db.prepare('SELECT id, reports_to_id FROM org_positions WHERE id=?').get(reportsTo);
    const seen = new Set([p.id]);
    while (cur) {
      if (seen.has(cur.id)) throw new Error('这样设置会让汇报关系成环（A 报 B，B 又报回 A）');
      seen.add(cur.id);
      cur = cur.reports_to_id
        ? db.prepare('SELECT id, reports_to_id FROM org_positions WHERE id=?').get(cur.reports_to_id)
        : null;
    }
  }

  const hc = b.headcount !== undefined ? Number(b.headcount) : p.headcount;
  if (!Number.isFinite(hc) || hc < 0 || hc > 999) throw new Error('编制数必须是 0-999 的整数');
  // 编制不能降到在职人数以下 —— 那等于把已经在岗的人变成「超编」
  if (hc > 0 && hc < used && !b.force) {
    throw new Error(`该岗位在职 ${used} 人，编制不能压到 ${hc}；先调岗或确认超编（force=1）`);
  }
  const status = b.status || p.status;
  if (!['active', 'closed'].includes(status)) throw new Error('岗位状态只能是启用/关闭');
  if (status === 'closed' && used > 0) throw new Error(`该岗位还有 ${used} 人在职，不能关闭；先办调岗或离职结束任职`);

  const pick = (k, d) => (b[k] !== undefined ? b[k] : d);
  db.prepare(
    `UPDATE org_positions SET title=?,sequence=?,grade=?,headcount=?,reports_to_id=?,status=?,effective_from=?,remark=?,updated_at=?
     WHERE id=?`
  ).run(
    pick('title', p.title),
    Object.keys(SEQ_LABEL).includes(b.sequence) ? b.sequence : p.sequence,
    b.grade === undefined ? p.grade : (b.grade === '' ? null : Number(b.grade)),
    Math.round(hc), reportsTo, status,
    pick('effective_from', p.effective_from), pick('remark', p.remark), localNow(), p.id
  );
  return getPosition(p.id);
}

/** 汇报树：从没有上级的岗位往下挂（公司维度） */
function positionTree(companyId) {
  const rows = listPositions({ company_id: companyId, status: 'active' });
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  byId.forEach((node) => {
    if (node.reports_to_id && byId.has(node.reports_to_id)) byId.get(node.reports_to_id).children.push(node);
    else roots.push(node);
  });
  return roots;
}

/** ==================== 任职 ==================== */

function shapeEmployment(e) {
  const pos = e.position_id ? db.prepare('SELECT * FROM org_positions WHERE id=?').get(e.position_id) : null;
  const today = localDate();
  return {
    ...e,
    employee_name: empName(e.employee_id),
    employer_name: companyName(e.employer_company_id),
    service_name: e.service_company_id ? companyName(e.service_company_id) : '全部主体',
    position_title: pos ? pos.title : null,
    department_name: deptName(e.department_id || (pos ? pos.department_id : null)),
    type_label: EMP_TYPE_LABEL[e.employment_type] || e.employment_type,
    status_label: EMP_STATUS_LABEL[e.status] || e.status,
    days_left: e.end_date ? daysBetween(today, e.end_date) : null,
    expiring_soon: e.status === 'effective' && !!e.end_date && e.end_date >= today && e.end_date <= addDays(today, 30),
    is_over_expired: e.status === 'effective' && !!e.end_date && e.end_date < today
  };
}

function listEmployments(q = {}) {
  const wh = [];
  const args = [];
  if (q.status) {
    const list = String(q.status).split(',').filter(Boolean);
    if (list.length) { wh.push(`e.status IN (${list.map(() => '?').join(',')})`); args.push(...list); }
  }
  if (q.company_id) { wh.push('e.employer_company_id=?'); args.push(Number(q.company_id)); }
  if (q.employee_id) { wh.push('e.employee_id=?'); args.push(Number(q.employee_id)); }
  if (q.position_id) { wh.push('e.position_id=?'); args.push(Number(q.position_id)); }
  if (q.q) {
    wh.push('(m.name LIKE ? OR m.code LIKE ? OR e.employment_no LIKE ?)');
    args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  return db.prepare(
    `SELECT e.* FROM employments e LEFT JOIN employees m ON m.id=e.employee_id
     ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY (CASE e.status WHEN 'pending' THEN 0 WHEN 'draft' THEN 1 WHEN 'effective' THEN 2 ELSE 3 END),
       COALESCE(e.start_date,'') DESC, e.id DESC`
  ).all(...args).map(shapeEmployment);
}

function getEmployment(id) {
  const e = db.prepare('SELECT * FROM employments WHERE id=?').get(Number(id));
  if (!e) return null;
  const pos = e.position_id ? db.prepare('SELECT * FROM org_positions WHERE id=?').get(e.position_id) : null;
  const used = pos ? inServiceOf(pos.id) : 0;
  return {
    ...shapeEmployment(e),
    position: pos ? shapePosition(pos) : null,
    headcount_check: pos ? {
      headcount: Number(pos.headcount) || 0,
      in_service: used,
      remaining: Number(pos.headcount) > 0 ? Math.max(0, Number(pos.headcount) - used) : null,
      would_exceed: Number(pos.headcount) > 0 && used + 1 > Number(pos.headcount)
    } : null,
    prev: e.prev_employment_id
      ? shapeEmployment(db.prepare('SELECT * FROM employments WHERE id=?').get(e.prev_employment_id))
      : null,
    next: (() => {
      if (e.status === 'draft') return ['pending', 'rejected'];
      if (e.status === 'pending') return ['effective', 'rejected', 'draft'];
      if (e.status === 'effective') return ['ended'];
      return [];
    })()
  };
}

/** 起草任职：这里只做「明显不合法」的拦截，编制在批准时才真正占用 */
function draftEmployment(b = {}, operator) {
  const employeeId = Number(b.employee_id);
  const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(employeeId);
  if (!emp) throw new Error('员工不存在');
  if (emp.status !== 'active') throw new Error(`员工「${emp.name}」不是在职业状态，不能新建任职`);
  const employerId = Number(b.employer_company_id) || defaultCompany();
  if (!db.prepare("SELECT id FROM companies WHERE id=? AND status='active'").get(employerId)) {
    throw new Error('雇佣公司不存在或已停用');
  }
  if (!b.position_id) throw new Error('必须选择岗位');
  const pos = db.prepare('SELECT * FROM org_positions WHERE id=?').get(Number(b.position_id));
  if (!pos) throw new Error('岗位不存在');
  if (pos.status !== 'active') throw new Error('该岗位已关闭，不能再用');
  if (Number(pos.company_id) !== employerId) {
    throw new Error(`岗位「${pos.title}」属于${companyName(pos.company_id)}，与雇佣公司${companyName(employerId)}不一致`);
  }
  const serviceId = b.service_company_id ? Number(b.service_company_id) : null;
  if (serviceId && !db.prepare('SELECT id FROM companies WHERE id=?').get(serviceId)) {
    throw new Error('服务公司不存在');
  }
  const start = b.start_date || localDate();
  if (!isDate(start)) throw new Error('开始日期格式必须是 YYYY-MM-DD');
  if (b.end_date && !isDate(b.end_date)) throw new Error('结束日期格式必须是 YYYY-MM-DD');
  if (b.end_date && b.end_date < start) throw new Error('结束日期不能早于开始日期');
  const type = Object.keys(EMP_TYPE_LABEL).includes(b.employment_type) ? b.employment_type : 'fulltime';

  // 已有生效/待批任职：先结束或走换岗，不要直接叠加
  const exist = db.prepare("SELECT * FROM employments WHERE employee_id=? AND status IN ('effective','pending')").get(employeeId);
  if (exist && exist.status === 'effective') {
    throw new Error(`该员工已有生效任职（${exist.employment_no}），换岗请走「调整岗位」，直接新增会留下两条同时生效的记录`);
  }
  if (exist && exist.status === 'pending') {
    throw new Error(`该员工已有待批任职（${exist.employment_no}），先处理完再提交新的`);
  }

  const now = localNow();
  const id = db.prepare(
    `INSERT INTO employments (employment_no,employee_id,employer_company_id,service_company_id,position_id,
       department_id,employment_type,start_date,end_date,status,reason,prev_employment_id,remark,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo('EMP', 'employments', 'employment_no'), employeeId, employerId, serviceId, pos.id,
    pos.department_id, type, start, b.end_date || null, 'draft',
    b.reason || null, b.prev_employment_id ? Number(b.prev_employment_id) : null,
    b.remark || null, operator || 'system', now, now
  ).lastInsertRowid;
  return getEmployment(id);
}

function submitEmployment(id, operator) {
  const e = db.prepare('SELECT * FROM employments WHERE id=?').get(Number(id));
  if (!e) throw new Error('任职不存在');
  if (e.status !== 'draft') throw new Error('只有草稿可以提交');
  db.prepare("UPDATE employments SET status='pending', updated_at=? WHERE id=?").run(localNow(), e.id);
  return getEmployment(e.id);
}

/**
 * 批准：这一步才真正占用编制。
 * 超编必须同时有标记和原因；批准人不能是起草人。
 */
function approveEmployment(id, b = {}, operator) {
  const e = db.prepare('SELECT * FROM employments WHERE id=?').get(Number(id));
  if (!e) throw new Error('任职不存在');
  if (e.status !== 'pending') throw new Error('只有待批的任职可以批准');
  if (String(e.created_by || '') === String(operator || '')) {
    throw new Error('不能批准自己起草的任职，请让部门负责人或人事负责人批');
  }
  const pos = e.position_id ? db.prepare('SELECT * FROM org_positions WHERE id=?').get(e.position_id) : null;
  if (!pos) throw new Error('岗位已被删除，无法批准');
  const hc = Number(pos.headcount) || 0;
  const used = inServiceOf(pos.id);
  if (hc > 0 && used >= hc) {
    const over = b.over_headcount === true || b.over_headcount === 1 || b.over_headcount === '1';
    if (!over) {
      throw new Error(`岗位「${pos.title}」编制 ${hc} 人、已在职 ${used} 人，已满编；确需超编请勾选特批并写原因`);
    }
    if (!String(b.over_reason || '').trim()) throw new Error('超编特批必须写原因（业务量增加、临时代班等）');
    db.prepare('UPDATE employments SET over_headcount=1, over_reason=? WHERE id=?').run(b.over_reason.trim(), e.id);
  }

  // 换岗：批准新任职的同时结束旧任职（结束日 = 新任职开始日前一天）
  if (e.prev_employment_id) {
    const prev = db.prepare('SELECT * FROM employments WHERE id=?').get(e.prev_employment_id);
    if (prev && prev.status === 'effective') {
      const endDate = addDays(e.start_date, -1);
      if (endDate && endDate < prev.start_date) {
        throw new Error('新任职开始日期早于旧任职开始日期，请先核对日期');
      }
      db.prepare("UPDATE employments SET status='ended', end_date=?, updated_at=? WHERE id=?")
        .run(endDate, localNow(), prev.id);
    }
  }

  const now = localNow();
  try {
    db.prepare("UPDATE employments SET status='effective', approved_by=?, approved_at=?, updated_at=? WHERE id=?")
      .run(operator || 'system', now, now, e.id);
  } catch (err) {
    // 数据库唯一索引兜底：并发或脚本直连时也拦得住
    if (String(err.message || '').includes('UNIQUE')) {
      throw new Error('该员工已有一条生效任职（数据库唯一约束拦截），请先结束旧任职');
    }
    throw err;
  }
  return getEmployment(e.id);
}

function rejectEmployment(id, b = {}, operator) {
  const e = db.prepare('SELECT * FROM employments WHERE id=?').get(Number(id));
  if (!e) throw new Error('任职不存在');
  if (!['pending', 'draft'].includes(e.status)) throw new Error('只有草稿或待批的任职可以驳回');
  const reason = String(b.reason || '').trim();
  if (!reason) throw new Error('驳回必须写原因');
  db.prepare("UPDATE employments SET status='rejected', reject_reason=?, approved_by=?, approved_at=?, updated_at=? WHERE id=?")
    .run(reason, operator || 'system', localNow(), localNow(), e.id);
  return getEmployment(e.id);
}

/** 结束任职（离职/调出）：end_date 不能早于 start_date */
function endEmployment(id, b = {}, operator) {
  const e = db.prepare('SELECT * FROM employments WHERE id=?').get(Number(id));
  if (!e) throw new Error('任职不存在');
  if (e.status !== 'effective') throw new Error('只有在生效中的任职可以结束');
  const end = b.end_date || localDate();
  if (!isDate(end)) throw new Error('结束日期格式必须是 YYYY-MM-DD');
  if (end < e.start_date) throw new Error('结束日期不能早于开始日期');
  db.prepare("UPDATE employments SET status='ended', end_date=?, updated_at=? WHERE id=?")
    .run(end, localNow(), e.id);
  return getEmployment(e.id);
}

/** 换岗专用：允许存在旧生效任职的情况下起草新任职 */
function draftTransfer(employeeId, b = {}, operator) {
  const cur = db.prepare("SELECT * FROM employments WHERE employee_id=? AND status='effective'").get(Number(employeeId));
  if (!cur) throw new Error('该员工没有生效任职，直接新建任职即可');
  if (!b.position_id) throw new Error('请选择新岗位');
  const pos = db.prepare('SELECT * FROM org_positions WHERE id=?').get(Number(b.position_id));
  if (!pos) throw new Error('岗位不存在');
  if (pos.status !== 'active') throw new Error('该岗位已关闭');
  if (Number(pos.id) === Number(cur.position_id)) throw new Error('新岗位与当前岗位相同');
  const employerId = Number(b.employer_company_id) || cur.employer_company_id;
  if (Number(pos.company_id) !== employerId) {
    throw new Error(`岗位「${pos.title}」属于${companyName(pos.company_id)}，与雇佣公司${companyName(employerId)}不一致`);
  }
  const pend = db.prepare("SELECT id FROM employments WHERE employee_id=? AND status='pending'").get(Number(employeeId));
  if (pend) throw new Error('该员工已有待批的任职变动，先处理完');
  const start = b.start_date || addDays(localDate(), 1);
  if (!isDate(start)) throw new Error('开始日期格式必须是 YYYY-MM-DD');
  const now = localNow();
  const id = db.prepare(
    `INSERT INTO employments (employment_no,employee_id,employer_company_id,service_company_id,position_id,
       department_id,employment_type,start_date,end_date,status,reason,prev_employment_id,remark,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo('EMP', 'employments', 'employment_no'), employeeId, employerId,
    b.service_company_id !== undefined ? (b.service_company_id ? Number(b.service_company_id) : null) : cur.service_company_id,
    pos.id, pos.department_id, b.employment_type || cur.employment_type, start, null, 'pending',
    b.reason || '调岗', cur.id, b.remark || null, operator || 'system', now, now
  ).lastInsertRowid;
  return getEmployment(id);
}

/** ==================== 交易路线 ==================== */

function shapeRoute(r) {
  const seller = r.seller_company_id;
  const sign = r.sign_company_id;
  const mismatch = !!(seller && sign && Number(seller) !== Number(sign));
  return {
    ...r,
    biz_label: ROUTE_LABEL[r.biz_type] || r.biz_type,
    status_label: ROUTE_STATUS_LABEL[r.status] || r.status,
    seller_name: companyName(r.seller_company_id),
    buyer_name: companyName(r.buyer_company_id),
    fulfill_name: companyName(r.fulfill_company_id),
    owner_name: companyName(r.goods_owner_company_id),
    sign_name: companyName(r.sign_company_id),
    pay_name: companyName(r.pay_company_id),
    // 签约方与卖方不一致 = 代签/委托，必须有服务协议，否则就是三流不一致
    need_agreement: mismatch && !String(r.service_agreement || '').trim(),
    sign_mismatch: mismatch
  };
}

function listRoutes(q = {}) {
  const wh = [];
  const args = [];
  if (q.status) { wh.push('status=?'); args.push(q.status); }
  if (q.biz_type) { wh.push('biz_type=?'); args.push(q.biz_type); }
  return db.prepare(
    `SELECT * FROM trade_routes ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY id DESC`
  ).all(...args).map(shapeRoute);
}

function getRoute(id) {
  const r = db.prepare('SELECT * FROM trade_routes WHERE id=?').get(Number(id));
  if (!r) return null;
  // 该路线涉及主体名下的订单数（只做对照，不改订单）
  const orderCnt = r.seller_company_id
    ? db.prepare('SELECT COUNT(*) c FROM orders WHERE company_id=?').get(r.seller_company_id).c
    : 0;
  return { ...shapeRoute(r), order_cnt: orderCnt };
}

function createRoute(b = {}, operator) {
  const name = String(b.name || '').trim();
  if (!name) throw new Error('路线名称必填');
  const biz = Object.keys(ROUTE_LABEL).includes(b.biz_type) ? b.biz_type : 'spot';
  const NEED = {
    seller_company_id: '卖方', sign_company_id: '签约方',
    fulfill_company_id: '履约方', goods_owner_company_id: '货主'
  };
  Object.entries(NEED).forEach(([k, label]) => {
    if (!b[k]) throw new Error(`必须选「${label}」主体`);
    if (!db.prepare('SELECT id FROM companies WHERE id=?').get(Number(b[k]))) throw new Error(`${label}主体不存在`);
  });
  const fee = b.service_fee_rate === undefined || b.service_fee_rate === '' ? null : Number(b.service_fee_rate);
  if (fee !== null && (!Number.isFinite(fee) || fee < 0 || fee > 100)) throw new Error('服务费率必须在 0-100 之间');
  const mismatch = Number(b.seller_company_id) !== Number(b.sign_company_id);
  if (mismatch && !String(b.service_agreement || '').trim()) {
    throw new Error('签约方与卖方不是同一主体，必须填服务协议编号（否则谁签合同、谁开票说不清）');
  }
  const now = localNow();
  const id = db.prepare(
    `INSERT INTO trade_routes (route_no,name,biz_type,seller_company_id,buyer_company_id,fulfill_company_id,
       goods_owner_company_id,sign_company_id,pay_company_id,service_agreement,service_fee_rate,status,note,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo('RT', 'trade_routes', 'route_no'), name, biz, Number(b.seller_company_id),
    b.buyer_company_id ? Number(b.buyer_company_id) : null, Number(b.fulfill_company_id),
    Number(b.goods_owner_company_id), Number(b.sign_company_id),
    // 付款方：不传默认同卖方（谁开票谁收款）；显式传 null 表示「还没定」，确认时会被拦
    b.pay_company_id === undefined ? Number(b.seller_company_id)
      : (b.pay_company_id ? Number(b.pay_company_id) : null),
    b.service_agreement || null, fee, 'draft', b.note || null, operator || 'system', now, now
  ).lastInsertRowid;
  return getRoute(id);
}

function updateRoute(id, b = {}) {
  const r = db.prepare('SELECT * FROM trade_routes WHERE id=?').get(Number(id));
  if (!r) throw new Error('路线不存在');
  if (r.status === 'confirmed') throw new Error('已确认的路线不能改主体，要改请停用后新建一条');
  const pick = (k, d) => (b[k] !== undefined ? b[k] : d);
  const seller = Number(pick('seller_company_id', r.seller_company_id));
  const sign = Number(pick('sign_company_id', r.sign_company_id));
  const agreement = pick('service_agreement', r.service_agreement);
  if (seller !== sign && !String(agreement || '').trim()) {
    throw new Error('签约方与卖方不是同一主体，必须填服务协议编号');
  }
  const fee = b.service_fee_rate === undefined ? r.service_fee_rate
    : (b.service_fee_rate === '' || b.service_fee_rate === null ? null : Number(b.service_fee_rate));
  if (fee !== null && (!Number.isFinite(fee) || fee < 0 || fee > 100)) throw new Error('服务费率必须在 0-100 之间');
  db.prepare(
    `UPDATE trade_routes SET name=?,biz_type=?,seller_company_id=?,buyer_company_id=?,fulfill_company_id=?,
       goods_owner_company_id=?,sign_company_id=?,pay_company_id=?,service_agreement=?,service_fee_rate=?,note=?,updated_at=?
     WHERE id=?`
  ).run(
    pick('name', r.name), Object.keys(ROUTE_LABEL).includes(b.biz_type) ? b.biz_type : r.biz_type,
    seller, b.buyer_company_id !== undefined ? (b.buyer_company_id ? Number(b.buyer_company_id) : null) : r.buyer_company_id,
    Number(pick('fulfill_company_id', r.fulfill_company_id)),
    Number(pick('goods_owner_company_id', r.goods_owner_company_id)),
    sign, Number(pick('pay_company_id', r.pay_company_id)),
    agreement || null, fee, pick('note', r.note), localNow(), r.id
  );
  return getRoute(r.id);
}

/** 确认路线：把能查的都查一遍，别等出了税务问题才回头找 */
function confirmRoute(id, b = {}) {
  const r = db.prepare('SELECT * FROM trade_routes WHERE id=?').get(Number(id));
  if (!r) throw new Error('路线不存在');
  if (r.status === 'confirmed') throw new Error('已经是已确认状态');
  const missing = [];
  if (!r.seller_company_id) missing.push('卖方');
  if (!r.sign_company_id) missing.push('签约方');
  if (!r.fulfill_company_id) missing.push('履约方');
  if (!r.goods_owner_company_id) missing.push('货主');
  if (missing.length) throw new Error(`缺少必填主体：${missing.join('、')}`);
  if (Number(r.seller_company_id) !== Number(r.sign_company_id) && !String(r.service_agreement || '').trim()) {
    throw new Error('签约方与卖方不一致且没有服务协议，不能确认（三流不一致）');
  }
  if (!r.pay_company_id) throw new Error('缺少付款方');
  db.prepare("UPDATE trade_routes SET status='confirmed', updated_at=? WHERE id=?").run(localNow(), r.id);
  return getRoute(r.id);
}

function setRouteStatus(id, b = {}) {
  const r = db.prepare('SELECT * FROM trade_routes WHERE id=?').get(Number(id));
  if (!r) throw new Error('路线不存在');
  const st = String(b.status || '');
  if (!['draft', 'pending_terms', 'disabled'].includes(st)) throw new Error('只能切到 草稿 / 条款待配 / 已停用');
  if (st === 'draft' && r.status === 'confirmed') throw new Error('已确认的路线不能退回草稿，请新建');
  const note = String(b.note || '').trim();
  if (st === 'disabled' && !note) throw new Error('停用必须写原因');
  db.prepare('UPDATE trade_routes SET status=?, note=COALESCE(?,note), updated_at=? WHERE id=?')
    .run(st, note || null, localNow(), r.id);
  return getRoute(r.id);
}

/** ==================== 主体视图与授权范围 ==================== */

function shapeScope(s) {
  const ids = String(s.company_ids || '').split(',').map((x) => Number(x)).filter(Boolean);
  const today = localDate();
  return {
    ...s,
    status_label: SCOPE_STATUS_LABEL[s.status] || s.status,
    field_label: FIELD_SCOPE_LABEL[s.field_scope] || s.field_scope,
    agg_label: AGG_LABEL[s.aggregate_scope] || s.aggregate_scope,
    companies: ids.map((id) => ({ id, name: companyName(id) })).filter((x) => x.name),
    days_left: s.expires_at ? daysBetween(today, s.expires_at) : null,
    expiring_soon: s.status === 'effective' && !!s.expires_at && s.expires_at >= today && s.expires_at <= addDays(today, 30)
  };
}

function listScopes(q = {}) {
  const wh = [];
  const args = [];
  if (q.status) { wh.push('status=?'); args.push(q.status); }
  if (q.user_id) { wh.push('user_id=?'); args.push(Number(q.user_id)); }
  return db.prepare(
    `SELECT * FROM subject_scopes ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY (CASE status WHEN 'pending' THEN 0 WHEN 'effective' THEN 1 ELSE 2 END), id DESC`
  ).all(...args).map(shapeScope);
}

function getScope(id) {
  const s = db.prepare('SELECT * FROM subject_scopes WHERE id=?').get(Number(id));
  if (!s) return null;
  return {
    ...shapeScope(s),
    next: s.status === 'draft' ? ['pending']
      : s.status === 'pending' ? ['effective', 'rejected']
        : s.status === 'expired' ? ['pending'] : []
  };
}

function createScope(b = {}, operator) {
  const userId = Number(b.user_id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!u) throw new Error('账号不存在');
  if (u.role === 'admin') throw new Error('admin 默认看全部，不需要单独授权');
  const ids = String(b.company_ids || '').split(',').map((x) => Number(String(x).trim())).filter(Boolean);
  if (!ids.length) throw new Error('至少要选一个可见公司');
  ids.forEach((id) => {
    if (!db.prepare("SELECT id FROM companies WHERE id=? AND status='active'").get(id)) {
      throw new Error(`公司 ${id} 不存在或已停用`);
    }
  });
  const field = Object.keys(FIELD_SCOPE_LABEL).includes(b.field_scope) ? b.field_scope : 'full';
  const agg = Object.keys(AGG_LABEL).includes(b.aggregate_scope) ? b.aggregate_scope : 'company';
  if (agg === 'group' && ids.length < 2) throw new Error('要集团汇总，至少选两家公司');
  if (!String(b.reason || '').trim()) throw new Error('申请授权必须写用途（要对什么数据做什么）');
  if (!b.expires_at) throw new Error('授权必须有到期日（到期自动失效，续期要重新申请）');
  if (!isDate(b.expires_at)) throw new Error('到期日格式必须是 YYYY-MM-DD');
  if (b.expires_at <= localDate()) throw new Error('到期日必须晚于今天');

  const eff = db.prepare("SELECT * FROM subject_scopes WHERE user_id=? AND status IN ('effective','pending')").get(userId);
  if (eff) {
    throw new Error(eff.status === 'effective'
      ? `该账号已有生效授权（${eff.scope_no}），要改范围请走「续期/变更」`
      : `该账号已有待批申请（${eff.scope_no}），先处理完`);
  }

  const now = localNow();
  const id = db.prepare(
    `INSERT INTO subject_scopes (scope_no,user_id,username,role_label,company_ids,field_scope,aggregate_scope,
       status,requested_by,effective_from,expires_at,relation_version,reason,remark,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo('SC', 'subject_scopes', 'scope_no'), userId, u.username,
    ({ admin: '管理员', sales: '销售', tech: '技术', finance: '财务', production: '生产', warehouse: '仓库' }[u.role] || u.role),
    ids.join(','), field, agg, 'draft', operator || 'system',
    b.effective_from && isDate(b.effective_from) ? b.effective_from : localDate(),
    b.expires_at, 1, b.reason.trim(), b.remark || null, now, now
  ).lastInsertRowid;
  return getScope(id);
}

function submitScope(id) {
  const s = db.prepare('SELECT * FROM subject_scopes WHERE id=?').get(Number(id));
  if (!s) throw new Error('授权单不存在');
  if (!['draft', 'expired'].includes(s.status)) throw new Error('只有草稿或已到期的授权单可以提交');
  db.prepare("UPDATE subject_scopes SET status='pending', updated_at=? WHERE id=?").run(localNow(), s.id);
  return getScope(s.id);
}

/** 独立批准：不能自己批自己；批完旧的有效授权置为已到期（避免两条同时有效） */
function approveScope(id, b = {}, operator) {
  const s = db.prepare('SELECT * FROM subject_scopes WHERE id=?').get(Number(id));
  if (!s) throw new Error('授权单不存在');
  if (s.status !== 'pending') throw new Error('只有待批的授权单可以批准');
  if (String(s.requested_by || '') === String(operator || '')) {
    throw new Error('不能批准自己申请的授权范围，需要独立批准人');
  }
  if (s.expires_at && s.expires_at <= localDate()) throw new Error('到期日已过，请先改期再批');
  const now = localNow();
  const old = db.prepare("SELECT * FROM subject_scopes WHERE user_id=? AND status='effective' AND id<>?").get(s.user_id, s.id);
  if (old) {
    db.prepare("UPDATE subject_scopes SET status='expired', updated_at=? WHERE id=?").run(now, old.id);
  }
  try {
    db.prepare("UPDATE subject_scopes SET status='effective', approved_by=?, approved_at=?, updated_at=? WHERE id=?")
      .run(operator || 'system', now, now, s.id);
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      throw new Error('该账号已有一条生效授权（数据库唯一约束拦截）');
    }
    throw err;
  }
  return getScope(s.id);
}

function rejectScope(id, b = {}, operator) {
  const s = db.prepare('SELECT * FROM subject_scopes WHERE id=?').get(Number(id));
  if (!s) throw new Error('授权单不存在');
  if (!['pending', 'draft'].includes(s.status)) throw new Error('只有草稿或待批可以驳回');
  const reason = String(b.reason || '').trim();
  if (!reason) throw new Error('驳回必须写原因');
  db.prepare("UPDATE subject_scopes SET status='rejected', reject_reason=?, approved_by=?, approved_at=?, updated_at=? WHERE id=?")
    .run(reason, operator || 'system', localNow(), localNow(), s.id);
  return getScope(s.id);
}

/** 续期/变更：旧记录置到期，新建一条待批，版本号 +1 */
function renewScope(id, b = {}, operator) {
  const s = db.prepare('SELECT * FROM subject_scopes WHERE id=?').get(Number(id));
  if (!s) throw new Error('授权单不存在');
  if (!['effective', 'expired'].includes(s.status)) throw new Error('只有生效中或已到期的授权可以续期');
  const expires = b.expires_at || addDays(localDate(), 180);
  if (!isDate(expires)) throw new Error('到期日格式必须是 YYYY-MM-DD');
  if (expires <= localDate()) throw new Error('到期日必须晚于今天');
  const ids = b.company_ids !== undefined ? String(b.company_ids) : s.company_ids;
  const now = localNow();
  if (s.status === 'effective') {
    db.prepare("UPDATE subject_scopes SET status='expired', updated_at=? WHERE id=?").run(now, s.id);
  }
  const newId = db.prepare(
    `INSERT INTO subject_scopes (scope_no,user_id,username,role_label,company_ids,field_scope,aggregate_scope,
       status,requested_by,effective_from,expires_at,relation_version,reason,remark,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextNo('SC', 'subject_scopes', 'scope_no'), s.user_id, s.username, s.role_label, ids,
    b.field_scope || s.field_scope, b.aggregate_scope || s.aggregate_scope, 'pending',
    operator || 'system', localDate(), expires, (Number(s.relation_version) || 1) + 1,
    b.reason || `续期：${s.scope_no}`, b.remark || null, now, now
  ).lastInsertRowid;
  return getScope(newId);
}

/** 删授权单：只允许草稿或已驳回（发错了要能撤；已生效的不能删，只能到期/续期） */
function deleteScope(id, operator) {
  const s = db.prepare('SELECT * FROM subject_scopes WHERE id=?').get(Number(id));
  if (!s) throw new Error('授权单不存在');
  if (!['draft', 'rejected'].includes(s.status)) {
    throw new Error('只有草稿或已驳回的授权单可以删除；生效中的请等它到期或走续期');
  }
  db.prepare('DELETE FROM subject_scopes WHERE id=?').run(s.id);
  return { deleted: 1, scope_no: s.scope_no, by: operator || 'system' };
}

/** 到期清扫：把过期仍标「有效」的授权置为已到期 */
function sweepScopes(operator) {
  const today = localDate();
  const rows = db.prepare("SELECT * FROM subject_scopes WHERE status='effective' AND expires_at IS NOT NULL AND expires_at < ?").all(today);
  rows.forEach((s) => {
    db.prepare("UPDATE subject_scopes SET status='expired', remark=COALESCE(remark,'')||?, updated_at=? WHERE id=?")
      .run(` [${localNow()}] 到期自动失效（${operator || 'system'}）`, localNow(), s.id);
  });
  return { swept: rows.length, scopes: rows.map((s) => s.scope_no) };
}

/** 某账号当前的可见范围（供其他模块判断数据范围用） */
function scopeOf(user) {
  if (!user) return null;
  if (user.role === 'admin') return { all: true, company_ids: null, field_scope: 'full', aggregate_scope: 'group' };
  const s = db.prepare("SELECT * FROM subject_scopes WHERE user_id=? AND status='effective'").get(Number(user.id));
  if (!s) return null;
  if (s.expires_at && s.expires_at < localDate()) return null;
  return {
    all: false,
    company_ids: String(s.company_ids || '').split(',').map(Number).filter(Boolean),
    field_scope: s.field_scope,
    aggregate_scope: s.aggregate_scope,
    scope_no: s.scope_no,
    expires_at: s.expires_at
  };
}

/** ==================== 汇总 ==================== */

function overview() {
  const today = localDate();
  const positions = db.prepare("SELECT * FROM org_positions WHERE status='active'").all();
  const hc = positions.reduce((s, p) => s + (Number(p.headcount) || 0), 0);
  const used = db.prepare("SELECT COUNT(*) c FROM employments WHERE status='effective'").get().c;
  const overPositions = positions.filter((p) => {
    const h = Number(p.headcount) || 0;
    return h > 0 && inServiceOf(p.id) > h;
  });

  const pendingEmp = db.prepare("SELECT COUNT(*) c FROM employments WHERE status='pending'").get().c;
  const expiringEmp = db.prepare(
    "SELECT COUNT(*) c FROM employments WHERE status='effective' AND end_date IS NOT NULL AND end_date>=? AND end_date<=?"
  ).get(today, addDays(today, 30)).c;

  const routes = db.prepare('SELECT * FROM trade_routes').all().map(shapeRoute);
  const pendingScopes = db.prepare("SELECT COUNT(*) c FROM subject_scopes WHERE status='pending'").get().c;
  const effScopes = db.prepare("SELECT COUNT(*) c FROM subject_scopes WHERE status='effective'").get().c;
  const expiringScopes = db.prepare(
    "SELECT COUNT(*) c FROM subject_scopes WHERE status='effective' AND expires_at>=? AND expires_at<=?"
  ).get(today, addDays(today, 30)).c;
  const expiredScopes = db.prepare("SELECT COUNT(*) c FROM subject_scopes WHERE status='effective' AND expires_at<?").get(today).c;

  const byCompany = db.prepare(
    `SELECT c.id, c.name,
       (SELECT COUNT(*) FROM org_positions p WHERE p.company_id=c.id AND p.status='active') AS pos_cnt,
       (SELECT COALESCE(SUM(p.headcount),0) FROM org_positions p WHERE p.company_id=c.id AND p.status='active') AS headcount,
       (SELECT COUNT(*) FROM employments e WHERE e.employer_company_id=c.id AND e.status='effective') AS in_service
     FROM companies c WHERE c.status='active' ORDER BY c.id`
  ).all().map((r) => ({
    ...r,
    vacant: Math.max(0, (r.headcount || 0) - (r.in_service || 0)),
    over: Math.max(0, (r.in_service || 0) - (r.headcount || 0))
  }));

  return {
    positions: {
      total: positions.length,
      headcount: hc,
      in_service: used,
      vacant: Math.max(0, hc - used),
      over: Math.max(0, used - hc),
      over_positions: overPositions.length,
      over_names: overPositions.map((p) => p.title),
      fill_rate: hc > 0 ? Math.round((used / hc) * 1000) / 10 : null
    },
    employments: { pending: pendingEmp, expiring_30d: expiringEmp },
    routes: {
      total: routes.length,
      confirmed: routes.filter((r) => r.status === 'confirmed').length,
      pending_terms: routes.filter((r) => r.status === 'pending_terms' || r.need_agreement).length,
      no_agreement: routes.filter((r) => r.need_agreement).length
    },
    scopes: {
      effective: effScopes, pending: pendingScopes,
      expiring_30d: expiringScopes, expired_today: expiredScopes
    },
    by_company: byCompany,
    today
  };
}

function dict() {
  return {
    companies: db.prepare("SELECT id, code, name, type FROM companies WHERE status='active' ORDER BY id").all(),
    departments: db.prepare(
      `SELECT d.id, d.name, d.company_id FROM departments d ORDER BY d.company_id, d.id`
    ).all(),
    employees: db.prepare("SELECT id, code, name, department_id, position FROM employees WHERE status='active' ORDER BY name LIMIT 300").all(),
    users: db.prepare("SELECT id, username, name, role, company_id FROM users WHERE active=1 ORDER BY id").all(),
    positions: db.prepare("SELECT id, code, title, company_id, department_id, headcount FROM org_positions WHERE status='active' ORDER BY title").all(),
    sequences: Object.entries(SEQ_LABEL).map(([k, v]) => ({ key: k, label: v })),
    emp_types: Object.entries(EMP_TYPE_LABEL).map(([k, v]) => ({ key: k, label: v })),
    emp_status: Object.entries(EMP_STATUS_LABEL).map(([k, v]) => ({ key: k, label: v })),
    route_biz: Object.entries(ROUTE_LABEL).map(([k, v]) => ({ key: k, label: v })),
    route_status: Object.entries(ROUTE_STATUS_LABEL).map(([k, v]) => ({ key: k, label: v })),
    field_scopes: Object.entries(FIELD_SCOPE_LABEL).map(([k, v]) => ({ key: k, label: v })),
    agg_scopes: Object.entries(AGG_LABEL).map(([k, v]) => ({ key: k, label: v })),
    scope_status: Object.entries(SCOPE_STATUS_LABEL).map(([k, v]) => ({ key: k, label: v }))
  };
}

module.exports = {
  // 岗位
  listPositions, getPosition, createPosition, updatePosition, positionTree, deptHeadcount, reportChain,
  // 任职
  listEmployments, getEmployment, draftEmployment, submitEmployment, approveEmployment, rejectEmployment,
  endEmployment, draftTransfer,
  // 路线
  listRoutes, getRoute, createRoute, updateRoute, confirmRoute, setRouteStatus,
  // 授权范围
  listScopes, getScope, createScope, submitScope, approveScope, rejectScope, renewScope, deleteScope, sweepScopes, scopeOf,
  // 汇总
  overview, dict,
  // 常量
  SEQ_LABEL, EMP_TYPE_LABEL, EMP_STATUS_LABEL, ROUTE_LABEL, ROUTE_STATUS_LABEL, SCOPE_STATUS_LABEL
};
