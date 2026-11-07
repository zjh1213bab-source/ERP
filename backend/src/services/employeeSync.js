/**
 * 钉钉通讯录 → 本系统员工档案
 * ============================================================
 * 目标：把钉钉里已经维护好的组织与人员，一次性变成系统里的员工档案（并顺手绑好 userid，
 * 之后考勤同步就能直接用）。手工录 25 个人既慢又容易把工号/手机敲错。
 *
 * 三条必须守住的规则：
 *
 * 1. **部门按“名称”对齐，不重复建**。钉钉根部门（dept_id=1）通常是公司名，不能当部门用，
 *    所以根部门不入库；成员若只属于根部门，`department_id` 留空（不硬塞一个假部门）。
 * 2. **员工只按 userid / 工号 / 手机这三样认人**，不再按姓名猜 —— 同名的两个人会被合并成
 *    一个人的考勤与工资，这类错误事后极难发现。
 * 3. **`replace` 只删“没有钉钉 userid 的”员工**，也就是系统里手工造/演示出来的人；
 *    带 userid 的是钉钉来的，一根手指都不碰。
 *
 * 钉钉侧需要的两个权限（缺一个就 60011，错误里会写清是哪个）：
 *   qyapi_get_department_list    通讯录部门信息读权限（拉部门树）
 *   qyapi_get_department_member  通讯录部门成员读权限（拉成员）
 */
const { db, now } = require('../db');
const DT = require('./dingtalk');
const accounts = require('./employeeAccounts');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};

const TZ_MS = Number(process.env.DINGTALK_TZ_OFFSET || 8) * 3600 * 1000;
const dateOf = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ms = Number(s);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms + TZ_MS).toISOString().slice(0, 10);
};

/** 兼容钉钉不同版本的字段命名（v2 用 job_number / userid，个别返回 user_id） */
const pick = (u, ...keys) => {
  for (const k of keys) {
    const v = u[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
};

/**
 * 拉全量：部门树（递归）+ 每个部门的成员（按 userid 去重）
 * 钉钉没有“一次取全公司”的接口，只能逐层遍历部门再逐个部门取人。
 */
async function fetchAll({ maxDepts = 300 } = {}) {
  DT.assertReady();
  let apiCalls = 0;

  const depts = [];
  const seen = new Set([1]);
  const queue = [1];
  while (queue.length && depts.length < maxDepts) {
    const id = queue.shift();
    const subs = await DT.listSubDepts(id);
    apiCalls += 1;
    for (const d of subs) {
      const did = Number(d.dept_id || d.id || 0);
      if (!did || seen.has(did)) continue;
      seen.add(did);
      depts.push({ dept_id: did, name: String(d.name || '').trim(), parent_id: id });
      queue.push(did);
    }
  }

  const users = new Map();
  const deptIds = [1, ...depts.map((d) => d.dept_id)];
  for (const id of deptIds) {
    const list = await DT.listDeptUsers(id);
    apiCalls += 1;
    for (const u of list) {
      const uid = String(pick(u, 'userid', 'user_id', 'userId') || '').trim();
      if (!uid) continue;
      const rec = users.get(uid) || { raw: u, userid: uid, depts: [] };
      if (!rec.depts.includes(id)) rec.depts.push(id);
      users.set(uid, rec);
    }
  }

  return { depts, users: [...users.values()], apiCalls };
}

/** 把钉钉的一条成员记录整理成我方字段 */
function toEmployee(rec, deptMap) {
  const u = rec.raw;
  const name = String(pick(u, 'name', 'nick') || '').trim();
  const mobile = String(pick(u, 'mobile', 'phone') || '').replace(/[-\s]/g, '') || null;
  const code = String(pick(u, 'job_number', 'jobNumber', 'job_no') || '').trim() || null;
  const position = String(pick(u, 'title', 'position') || '').trim() || null;
  // 部门：取第一个能对上我方部门 id 的（根部门不在 deptMap 里，自然被跳过）
  let departmentId = null;
  for (const d of rec.depts) {
    if (deptMap.has(d)) { departmentId = deptMap.get(d); break; }
  }
  return {
    dingtalk_userid: rec.userid,
    name,
    code,
    position,
    phone: mobile && /^1\d{10}$/.test(mobile) ? mobile : null,
    hire_date: dateOf(pick(u, 'hired_date', 'hiredDate', 'confirm_join_time')),
    department_id: departmentId
  };
}

/** 只读预览：会建多少部门 / 新增多少员工 / 覆盖多少 / 哪些人对不上 */
async function preview() {
  const { depts, users, apiCalls } = await fetchAll();
  const byName = new Map(
    db.prepare("SELECT id, name FROM departments WHERE IFNULL(TRIM(name),'') <> ''").all()
      .map((d) => [String(d.name).trim(), d.id])
  );

  const willCreateDepts = depts.filter((d) => d.name && !byName.has(d.name));
  // 钉钉 dept_id → 我方部门 id（未建的用负数占位，只为预览能匹配上）
  const deptIdMap = new Map();
  let placeholder = -1;
  for (const d of depts) {
    if (!d.name) continue;
    const ourId = byName.get(d.name) || (placeholder -= 1);
    deptIdMap.set(d.dept_id, ourId);
  }

  const rows = users.map((rec) => {
    const v = toEmployee(rec, deptIdMap);
    const exist = v.dingtalk_userid
      ? db.prepare('SELECT id FROM employees WHERE dingtalk_userid = ?').get(v.dingtalk_userid)
      : null;
    return {
      userid: v.dingtalk_userid,
      name: v.name,
      code: v.code,
      position: v.position,
      phone: v.phone,
      dept_name: (depts.find((d) => rec.depts.includes(d.dept_id)) || {}).name || null,
      action: exist ? 'update' : 'new',
      problems: [
        v.name ? null : '钉钉里没名字',
        v.phone ? null : '没有可用手机号'
      ].filter(Boolean)
    };
  });

  return {
    api_calls: apiCalls,
    depts_total: depts.length,
    depts_to_create: willCreateDepts.map((d) => d.name),
    employees_total: users.length,
    employees_new: rows.filter((r) => r.action === 'new').length,
    employees_update: rows.filter((r) => r.action === 'update').length,
    problems: rows.filter((r) => r.problems.length).length,
    sample: rows.slice(0, 20)
  };
}

/**
 * 执行导入
 * @param {object} p
 * @param {boolean} p.replace  先删掉“没有钉钉 userid”的员工（系统里手工造的那些）
 * @param {string} p.operator
 */
async function importContacts({ replace = false, operator = '' } = {}) {
  const { depts, users, apiCalls } = await fetchAll();
  if (!users.length) {
    throw bad('钉钉通讯录没有返回任何成员：确认应用已开通「通讯录部门成员读权限」，且应用可见范围覆盖了这些部门', 400);
  }

  const ts = now();
  const stats = {
    api_calls: apiCalls, depts_created: 0, depts_matched: 0,
    employees_created: 0, employees_updated: 0, removed: 0, skipped: 0,
    conflicts: [], no_dept: 0, accounts_created: 0, accounts_renamed: 0, account_issues: []
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    /* ---------- 1. 部门：按名称对齐，缺的建 ---------- */
    const byName = new Map();
    db.prepare("SELECT id, name FROM departments WHERE IFNULL(TRIM(name),'') <> ''").all()
      .forEach((d) => byName.set(String(d.name).trim(), d.id));

    // 钉钉 dept_id → 我方部门 id（toEmployee 用它把成员落到部门上）
    const deptMap = new Map();
    for (const d of depts) {
      if (!d.name) continue;
      let ourId = byName.get(d.name);
      if (ourId) {
        stats.depts_matched += 1;
      } else {
        ourId = Number(db.prepare(
          'INSERT INTO departments (company_id, name, created_at) VALUES (1,?,?)'
        ).run(d.name, ts).lastInsertRowid);
        byName.set(d.name, ourId);
        stats.depts_created += 1;
      }
      deptMap.set(d.dept_id, ourId);
    }

    /* ---------- 2. 删掉系统里“假设的”员工（没有钉钉 userid 的） ---------- */
    if (replace) {
      /**
       * 只删没有 userid 的：带 userid 的是钉钉来源，不能碰。
       * 这些人如果还挂着打卡/工资记录，删了会留孤儿 —— 所以先查一遍，
       * 有依赖就整批不动，让人先决定（宁可少删，也不能把考勤记录变成孤儿）。
       */
      const candidates = db.prepare(
        "SELECT id, name FROM employees WHERE IFNULL(TRIM(dingtalk_userid),'') = ''"
      ).all();
      const dependent = [];
      for (const e of candidates) {
        const hit = db.prepare(
          `SELECT (SELECT COUNT(*) FROM attendance       WHERE employee_id = ?) a,
                  (SELECT COUNT(*) FROM payrolls         WHERE employee_id = ?) p,
                  (SELECT COUNT(*) FROM users            WHERE employee_id = ?) u,
                  (SELECT COUNT(*) FROM leave_requests   WHERE employee_id = ?) l,
                  (SELECT COUNT(*) FROM piece_wage_items WHERE employee_id = ?) w,
                  (SELECT COUNT(*) FROM self_requests    WHERE employee_id = ?) s`
        ).get(e.id, e.id, e.id, e.id, e.id, e.id);
        if (hit.a || hit.p || hit.u || hit.l || hit.w || hit.s) dependent.push({ id: e.id, name: e.name, ...hit });
      }
      if (dependent.length) {
        const names = dependent.slice(0, 5).map((d) => `「${d.name}」`).join('');
        throw bad(`有 ${dependent.length} 名待删员工还挂着考勤/工资/账号（${names}${dependent.length > 5 ? '…' : ''}），`
          + '先处理这些依赖再导入（否则会留下孤儿记录）', 409);
      }
      for (const e of candidates) {
        db.prepare('DELETE FROM employees WHERE id = ?').run(e.id);
        stats.removed += 1;
      }
    }

    /* ---------- 3. 员工：只按 userid / 工号 / 手机认人 ---------- */
    for (const rec of users) {
      const v = toEmployee(rec, deptMap);
      if (!v.name) { stats.skipped += 1; continue; }
      if (!v.department_id) stats.no_dept += 1;

      const byUid = db.prepare('SELECT * FROM employees WHERE dingtalk_userid = ?').get(v.dingtalk_userid);
      const byCode = v.code ? db.prepare('SELECT * FROM employees WHERE code = ?').get(v.code) : null;
      const byPhone = v.phone ? db.prepare('SELECT * FROM employees WHERE phone = ?').get(v.phone) : null;

      const found = [byUid, byCode, byPhone].filter(Boolean);
      const ids = [...new Set(found.map((e) => e.id))];
      if (ids.length > 1) {
        stats.conflicts.push({
          userid: v.dingtalk_userid, name: v.name,
          reason: '钉钉这个人的 userid / 工号 / 手机分别对上了系统里不同的员工，未自动合并',
          employee_ids: ids
        });
        stats.skipped += 1;
        continue;
      }

      if (ids.length === 1) {
        const ex = found[0];
        db.prepare(
          `UPDATE employees SET name=?, code=?, position=?, phone=?, hire_date=?, department_id=?, dingtalk_userid=?
             WHERE id=?`
        ).run(
          v.name,
          v.code || ex.code,
          v.position || ex.position,
          v.phone || ex.phone,
          v.hire_date || ex.hire_date,
          v.department_id || ex.department_id,
          v.dingtalk_userid,
          ex.id
        );
        stats.employees_updated += 1;
      } else {
        db.prepare(
          `INSERT INTO employees (code, name, department_id, position, phone, hire_date, status, dingtalk_userid, base_salary, remark, created_at, company_id)
           VALUES (?,?,?,?,?,?, 'active', ?, 0, ?, ?, 1)`
        ).run(v.code, v.name, v.department_id, v.position, v.phone, v.hire_date, v.dingtalk_userid,
          `钉钉导入 ${ts.slice(0, 10)}`, ts);
        stats.employees_created += 1;
      }
    }

    // 同事务同步手机号账号，失败时全部回滚；冲突仅记为待人工核对，不覆盖他人账号。
    for (const rec of users) {
      const employee = db.prepare('SELECT * FROM employees WHERE dingtalk_userid=?').get(rec.userid);
      if (!employee) continue;
      const out = accounts.sync(employee);
      if (out.action === 'created') stats.accounts_created++;
      if (out.action === 'renamed') stats.accounts_renamed++;
      if (out.reason) stats.account_issues.push({ employee_id: employee.id, name: employee.name, reason: out.reason });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  db.prepare('SELECT id FROM employees').all().forEach(e => accounts.clearEmployeeCache(e.id));
  return { ...stats, operator: operator || null };
}

module.exports = { preview, importContacts, fetchAll, toEmployee };
