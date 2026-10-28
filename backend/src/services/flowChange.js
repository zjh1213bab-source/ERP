/**
 * 流程变更发布与审计（TS-N15-05）
 * ========================================================================
 * 审批流不是代码，是制度。制度可以改，但改制度这件事本身必须留痕、可回滚、
 * 而且**不能让正在走的单子跟着变形**。
 *
 * ## 四步链路，缺一步都不许发布
 *
 *   创建变更（草稿，带新 steps）
 *     → 试运行（拿历史单对比审批路径，出证据）
 *     → 发布（定生效日，旧版转 superseded，同步 approval_flows）
 *     → 可回滚（回上一版，必须写原因）
 *
 * **没有试运行证据不许发布** —— 原型原话「所有规则改变有版本和测试证据」。
 *
 * ## 三条硬门槛
 *
 * 1. **关键角色不许悄悄删**：财务、总经理这类角色从流程里消失时，
 *    试运行结果会单独列出来，发布必须写理由（`critical_role_note`）。
 *    想删可以，但删了会被记下来 —— 这就是「不允许因加急被绕过」的落地。
 *
 * 2. **生效日不能倒签**：不能今天发布、生效日写上周。那等于偷偷改历史，
 *    上个月的审批记录会突然「不符合流程」。
 *
 * 3. **在途单默认不动**：发布只影响之后新建的实例。
 *    要迁移必须显式选 `migrate` 并写原因，且只迁「一步都没开始处理」的实例 ——
 *    已经有人认领/批过一半的单，迁移会把它变回起点，那是破坏。
 *
 * ## 为什么 `approval_flows` 还要同步
 *
 * 审批逻辑（`services/approvals.js` → `matchFlow`）读的是 `approval_flows`。
 * 不动它就得改所有调用方。所以版本发布后把生效版本的 steps 写回 `approval_flows`，
 * 让它只是「当前生效版本的投影」，而不是真相本身。
 */
const { db, now } = require('../db');
const { localDate } = require('./sla');
const { nextNo } = require('../utils/docNo');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/** 关键角色：从流程里删掉必须写理由（对应原型「关键门槛不允许被绕过」） */
const CRITICAL_ROLES = ['finance', 'admin'];
const ROLE_LABEL = { finance: '财务', admin: '总经理', boss: '老板', tech: '技术', production: '生产', sales: '销售', warehouse: '仓库', hr: '人事' };

const dayShift = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ==================================================================== *
 * 一、查询
 * ==================================================================== */

/** 流程清单（按 flow_key 聚合） */
function listFlows() {
  const keys = db.prepare('SELECT DISTINCT flow_key, target_type FROM flow_versions').all();
  return keys.map((k) => {
    const pub = db
      .prepare("SELECT * FROM flow_versions WHERE flow_key = ? AND status = 'published'")
      .get(k.flow_key);
    const versions = db
      .prepare('SELECT id, version_no, status, effective_from, published_at, source_change_no FROM flow_versions WHERE flow_key = ? ORDER BY version_no DESC')
      .all(k.flow_key);
    const inflight = pub
      ? db
        .prepare(
          `SELECT COUNT(*) c FROM approval_instances
            WHERE status = 'pending' AND (flow_version_id = ? OR (flow_version_id IS NULL AND flow_id IN
              (SELECT id FROM approval_flows WHERE target_type = ? AND name = ?)))`
        )
        .get(pub.id, k.target_type, pub.name).c
      : 0;
    return {
      flow_key: k.flow_key,
      target_type: k.target_type,
      name: pub ? pub.name : (versions.length ? '' : ''),
      current: pub ? decorateVersion(pub) : null,
      version_count: versions.length,
      inflight,
      last_published_at: pub ? pub.published_at : null,
      drafts: db
        .prepare("SELECT COUNT(*) c FROM flow_changes WHERE flow_key = ? AND status IN ('draft','trialed')")
        .get(k.flow_key).c
    };
  }).sort((a, b) => a.flow_key.localeCompare(b.flow_key));
}

function decorateVersion(v) {
  let steps = [];
  try { steps = JSON.parse(v.steps || '[]'); } catch (e) { steps = []; }
  return {
    id: v.id,
    flow_key: v.flow_key,
    target_type: v.target_type,
    version_no: v.version_no,
    name: v.name,
    min_amount: v.min_amount,
    max_amount: v.max_amount,
    steps,
    step_count: steps.length,
    path: steps.map((s) => `${s.name || ROLE_LABEL[s.role] || s.role}（${ROLE_LABEL[s.role] || s.role}）`).join(' → '),
    sla_hours: v.sla_hours,
    escalate_role: v.escalate_role,
    status: v.status,
    status_label: {
      draft: '草稿', trial: '已试运行', published: '生效中', superseded: '已替代', rolled_back: '已回滚'
    }[v.status] || v.status,
    effective_from: v.effective_from,
    trial_summary: v.trial_summary ? JSON.parse(v.trial_summary) : null,
    published_by: v.published_by,
    published_at: v.published_at,
    source_change_no: v.source_change_no,
    created_at: v.created_at
  };
}

function versions(flowKey) {
  return db
    .prepare('SELECT * FROM flow_versions WHERE flow_key = ? ORDER BY version_no DESC')
    .all(flowKey)
    .map(decorateVersion);
}

function listChanges(q = {}) {
  const where = [];
  const args = [];
  if (q.flow_key) { where.push('flow_key = ?'); args.push(q.flow_key); }
  if (q.status) { where.push('status = ?'); args.push(q.status); }
  const sql = `SELECT * FROM flow_changes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`;
  return db.prepare(sql).all(...args).map(decorateChange);
}

function decorateChange(c) {
  const to = c.to_version_id ? db.prepare('SELECT * FROM flow_versions WHERE id = ?').get(c.to_version_id) : null;
  const from = c.from_version_id ? db.prepare('SELECT * FROM flow_versions WHERE id = ?').get(c.from_version_id) : null;
  return {
    ...c,
    status_label: {
      draft: '草稿', trialed: '待发布', published: '已发布', rolled_back: '已回滚', rejected: '已作废'
    }[c.status] || c.status,
    from_version: from ? decorateVersion(from) : null,
    to_version: to ? decorateVersion(to) : null,
    trial_summary: c.trial_summary ? JSON.parse(c.trial_summary) : null
  };
}

function detail(changeId) {
  const c = db.prepare('SELECT * FROM flow_changes WHERE id = ?').get(changeId);
  if (!c) throw bad('变更单不存在', 404);
  const out = decorateChange(c);
  out.audits = db
    .prepare('SELECT * FROM flow_audits WHERE change_no = ? ORDER BY id')
    .all(c.change_no)
    .map((a) => ({
      ...a,
      action_label: { init: '初始化', create: '创建变更', trial: '试运行', publish: '发布', rollback: '回滚', migrate: '迁移在途单', reject: '作废' }[a.action] || a.action,
      detail: a.detail ? JSON.parse(a.detail) : null
    }));
  out.impact = impact(changeId);
  return out;
}

/* ==================================================================== *
 * 二、创建变更
 * ==================================================================== */

function audit(changeNo, flowKey, versionId, action, actor, detailObj) {
  db.prepare(
    'INSERT INTO flow_audits (change_no, flow_key, version_id, action, actor, detail, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(changeNo || null, flowKey || null, versionId || null, action, actor || '系统',
    detailObj ? JSON.stringify(detailObj) : null, now());
}

function createChange(opt = {}) {
  const flowKey = String(opt.flow_key || '').trim();
  if (!flowKey) throw bad('缺少 flow_key');
  const cur = db.prepare("SELECT * FROM flow_versions WHERE flow_key = ? AND status = 'published'").get(flowKey);
  if (!cur) throw bad('该流程没有生效版本，无法创建变更', 404);

  const title = String(opt.title || '').trim();
  if (title.length < 4) throw bad('变更标题至少 4 个字（要能看出改了什么）');
  const reason = String(opt.reason || '').trim();
  if (reason.length < 6) throw bad('必须写变更原因（至少 6 个字）：为什么这条流程要改');

  const steps = Array.isArray(opt.steps) ? opt.steps : null;
  if (!steps || !steps.length) throw bad('新流程至少要有一级审批');
  steps.forEach((s, i) => {
    if (!s.role) throw bad(`第 ${i + 1} 级没指定角色`);
  });

  const nextNo_ = db.prepare('SELECT MAX(version_no) v FROM flow_versions WHERE flow_key = ?').get(flowKey).v || 0;
  const versionNo = Number(nextNo_) + 1;
  const changeNo = nextNo('FC', 'flow_changes', 'change_no');

  db.exec('BEGIN');
  try {
    const vid = db
      .prepare(
        `INSERT INTO flow_versions (target_type, flow_key, version_no, name, min_amount, max_amount, steps,
           sla_hours, escalate_role, status, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?)`
      )
      .run(cur.target_type, flowKey, versionNo, opt.name || cur.name,
        num(opt.min_amount !== undefined ? opt.min_amount : cur.min_amount),
        num(opt.max_amount !== undefined ? opt.max_amount : cur.max_amount),
        JSON.stringify(steps), num(opt.sla_hours || cur.sla_hours) || 24,
        opt.escalate_role !== undefined ? opt.escalate_role : cur.escalate_role,
        opt.created_by || null, now(), now()).lastInsertRowid;

    const cid = db
      .prepare(
        `INSERT INTO flow_changes (change_no, flow_key, target_type, title, reason, impact_nodes,
           from_version_id, to_version_id, status, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?)`
      )
      .run(changeNo, flowKey, cur.target_type, title, reason, opt.impact_nodes || null,
        cur.id, vid, opt.created_by || null, now(), now()).lastInsertRowid;

    db.prepare('UPDATE flow_versions SET source_change_no = ? WHERE id = ?').run(changeNo, vid);
    audit(changeNo, flowKey, vid, 'create', opt.created_by,
      { title, reason, from_version: cur.version_no, to_version: versionNo, steps_count: steps.length });
    db.exec('COMMIT');
    return detail(cid);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ==================================================================== *
 * 三、试运行（拿历史单对比路径）
 * ==================================================================== */

/**
 * 试运行：把这套新流程套到最近的历史审批单上，看路径会不会变
 *
 * 为什么用历史实例而不是「模拟几个金额」：
 * 模拟金额只能证明「匹配逻辑通」，证明不了「真实单子会怎么走」。
 * 历史实例的 tasks 是当时的真实路径（本身就是快照），拿它比最直接。
 */
function trial(changeId, opt = {}) {
  const c = db.prepare('SELECT * FROM flow_changes WHERE id = ?').get(changeId);
  if (!c) throw bad('变更单不存在', 404);
  if (!['draft', 'trialed'].includes(c.status)) throw bad('只有草稿状态的变更单可以试运行');

  const to = db.prepare('SELECT * FROM flow_versions WHERE id = ?').get(c.to_version_id);
  const from = db.prepare('SELECT * FROM flow_versions WHERE id = ?').get(c.from_version_id);
  const newSteps = JSON.parse(to.steps || '[]');
  const newPath = newSteps.map((s) => s.role).join(' > ');

  const days = num(opt.days) || 90;
  const since = dayShift(-days);
  const samples = db
    .prepare(
      `SELECT id, status, created_at FROM approval_instances
        WHERE target_type = ? AND substr(created_at,1,10) >= ?
        ORDER BY id DESC LIMIT 300`
    )
    .all(c.target_type, since);

  const changed = [];
  const same = [];
  const noStep = [];
  samples.forEach((s) => {
    const roles = db
      .prepare('SELECT role, step_name FROM approval_tasks WHERE instance_id = ? ORDER BY step_no')
      .all(s.id);
    if (!roles.length) { noStep.push(s.id); return; }
    const oldPath = roles.map((r) => r.role).join(' > ');
    if (oldPath === newPath) { same.push(s.id); return; }
    changed.push({
      instance_id: s.id,
      status: s.status,
      created_at: String(s.created_at).slice(0, 10),
      old_path: roles.map((r) => `${r.step_name || ROLE_LABEL[r.role] || r.role}`).join(' → '),
      new_path: newSteps.map((x) => x.name || ROLE_LABEL[x.role] || x.role).join(' → '),
      delta: newSteps.length - roles.length
    });
  });

  // 关键角色是否被删（原型：关键门槛不许绕过）
  const oldRoles = new Set(JSON.parse(from.steps || '[]').map((s) => s.role));
  const newRoleSet = new Set(newSteps.map((s) => s.role));
  const removedCritical = [...oldRoles].filter((r) => CRITICAL_ROLES.includes(r) && !newRoleSet.has(r));
  const addedRoles = [...newRoleSet].filter((r) => !oldRoles.has(r));

  // 金额区间变化会影响哪些单（区间是匹配条件，改了会换流程）
  const rangeChanged = num(to.min_amount) !== num(from.min_amount) || num(to.max_amount) !== num(from.max_amount);

  const summary = {
    trial_days: days,
    trial_at: now(),
    sample: samples.length,
    same_count: same.length,
    changed_count: changed.length,
    changed_rate: samples.length ? Math.round((changed.length / samples.length) * 1000) / 10 : null,
    no_step_count: noStep.length,
    changed_samples: changed.slice(0, 20),
    removed_critical_roles: removedCritical,
    removed_critical_note: removedCritical.length
      ? `新流程删掉了关键角色：${removedCritical.map((r) => ROLE_LABEL[r] || r).join('、')}。发布时必须写清理由`
      : null,
    added_roles: addedRoles,
    amount_range_changed: rangeChanged,
    amount_range: rangeChanged
      ? `匹配区间从 ${cur(from)} 变为 ${cur(to)} —— 区间是「哪条流程被选中」的条件，改它等于改了适用范围`
      : null,
    verdict: buildVerdict(changed, samples, removedCritical)
  };

  db.prepare("UPDATE flow_changes SET status='trialed', trial_summary=?, trial_at=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(summary), summary.trial_at, now(), changeId);
  db.prepare("UPDATE flow_versions SET status='trial', trial_summary=?, trial_at=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(summary), summary.trial_at, now(), to.id);
  audit(c.change_no, c.flow_key, to.id, 'trial', opt.operator,
    { sample: summary.sample, changed: summary.changed_count, removed_critical: removedCritical });

  return detail(changeId);
}

function cur(from, to) {
  const f = (v) => (num(v) >= 999999999 ? '无上限' : `¥${num(v).toLocaleString('zh-CN')}`);
  return to ? `${f(to.min_amount)} ~ ${f(to.max_amount)}` : `${f(from.min_amount)} ~ ${f(from.max_amount)}`;
}

function buildVerdict(changed, samples, removedCritical) {
  if (!samples.length) return '没有可对比的历史单（该流程近 90 天没走过），试运行结论仅供参考';
  if (removedCritical.length) return `会删掉关键角色（${removedCritical.join('、')}），属于制度性变更，须书面说明`;
  if (changed.length === 0) return '历史单的审批路径全部不变，属于低风险调整';
  const rate = changed.length / samples.length;
  if (rate >= 0.5) return `超过一半的历史单审批路径会变（${changed.length}/${samples.length}），影响面大，建议先小范围试运行`;
  return `${changed.length}/${samples.length} 单的审批路径会变，其余不变`;
}

/** 影响分析：发布会不会动到在途单 */
function impact(changeId) {
  const c = db.prepare('SELECT * FROM flow_changes WHERE id = ?').get(changeId);
  if (!c) throw bad('变更单不存在', 404);
  const from = c.from_version_id ? db.prepare('SELECT * FROM flow_versions WHERE id = ?').get(c.from_version_id) : null;
  const flow = from
    ? db.prepare('SELECT id FROM approval_flows WHERE target_type = ? AND name = ?').get(from.target_type, from.name)
    : null;
  const rows = db
    .prepare(
      `SELECT i.id, i.target_type, i.target_id, i.current_step, i.status, i.flow_version_id, i.created_at,
              (SELECT COUNT(*) FROM approval_tasks t WHERE t.instance_id = i.id AND t.status <> 'pending') AS acted
         FROM approval_instances i
        WHERE i.status = 'pending' AND i.target_type = ?
          AND (i.flow_version_id = ? OR (i.flow_version_id IS NULL AND i.flow_id = ?))
        ORDER BY i.id`
    )
    .all(c.target_type, c.from_version_id || -1, flow ? flow.id : -1);

  const untouched = rows.filter((r) => num(r.acted) === 0);
  const inProgress = rows.filter((r) => num(r.acted) > 0);

  return {
    inflight_total: rows.length,
    // 一步都没开始的可以安全迁移；已经有人批过的不能动
    migratable: untouched.length,
    in_progress: inProgress.length,
    in_progress_note: inProgress.length
      ? `${inProgress.length} 单已经有人批过或认领，迁移会把它们打回起点，所以不迁 —— 这些单继续走旧版`
      : null,
    rows: rows.map((r) => ({
      instance_id: r.id,
      target: `${r.target_type}#${r.target_id}`,
      current_step: r.current_step,
      acted_steps: num(r.acted),
      flow_version_id: r.flow_version_id,
      created_at: String(r.created_at).slice(0, 10),
      can_migrate: num(r.acted) === 0
    }))
  };
}

/* ==================================================================== *
 * 四、发布与回滚
 * ==================================================================== */

/**
 * 发布
 *
 * 四道校验，缺一道就退回：
 *   1. 必须做过试运行（trial_summary 不为空）
 *   2. 生效日不能早于今天（不能倒签改历史）
 *   3. 删了关键角色必须写理由
 *   4. 迁移模式选了 migrate 必须写原因
 */
function publish(changeId, opt = {}) {
  const c = db.prepare('SELECT * FROM flow_changes WHERE id = ?').get(changeId);
  if (!c) throw bad('变更单不存在', 404);
  if (c.status !== 'trialed') throw bad('必须先试运行，通过后才能发布（没有测试证据的流程改动不许上线）');

  const to = db.prepare('SELECT * FROM flow_versions WHERE id = ?').get(c.to_version_id);
  const from = db.prepare('SELECT * FROM flow_versions WHERE id = ?').get(c.from_version_id);
  const trialSummary = c.trial_summary ? JSON.parse(c.trial_summary) : null;
  if (!trialSummary) throw bad('缺少试运行证据，不能发布');

  const effFrom = String(opt.effective_from || localDate()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effFrom)) throw bad('生效日格式应为 YYYY-MM-DD');
  if (effFrom < localDate()) throw bad(`生效日不能早于今天（${localDate()}）—— 倒签会改动历史，上个月的审批记录会突然「不合流程」`);
  if (effFrom > dayShift(90)) throw bad('生效日不要超过 90 天，太远的生效日等于埋了个雷');

  const removedCritical = trialSummary.removed_critical_roles || [];
  const criticalNote = String(opt.critical_role_note || '').trim();
  if (removedCritical.length && criticalNote.length < 8) {
    throw bad(`本次变更删掉了关键角色（${removedCritical.map((r) => ROLE_LABEL[r] || r).join('、')}），必须写不少于 8 字的理由说明为什么可以删`);
  }

  const mode = opt.migration_mode === 'migrate' ? 'migrate' : 'keep_old';
  const migrationNote = String(opt.migration_note || '').trim();
  if (mode === 'migrate' && migrationNote.length < 6) {
    throw bad('要把在途单迁到新版本，必须写清迁移原因（至少 6 个字）');
  }

  const imp = impact(changeId);
  if (mode === 'migrate' && imp.migratable === 0) {
    throw bad('没有可以安全迁移的在途单（都已在处理中），请改用「在途单保持原版本」');
  }

  const t = now();
  db.exec('BEGIN');
  let migrated = 0;
  try {
    // 旧版转 superseded：同 key 只能一个 published（唯一索引兜底）
    db.prepare("UPDATE flow_versions SET status='superseded', updated_at=? WHERE flow_key=? AND status='published'")
      .run(t, c.flow_key);
    db.prepare(
      "UPDATE flow_versions SET status='published', effective_from=?, published_by=?, published_at=?, updated_at=? WHERE id=?"
    ).run(effFrom, opt.operator || null, t, t, to.id);

    // 同步到 approval_flows（审批逻辑读这张表）
    const existed = db
      .prepare('SELECT id FROM approval_flows WHERE target_type = ? AND name = ?')
      .get(to.target_type, to.name);
    if (existed) {
      db.prepare(
        'UPDATE approval_flows SET steps=?, min_amount=?, max_amount=?, sla_hours=?, escalate_role=?, active=1 WHERE id=?'
      ).run(to.steps, to.min_amount, to.max_amount, to.sla_hours, to.escalate_role, existed.id);
    } else {
      db.prepare(
        `INSERT INTO approval_flows (name, target_type, min_amount, max_amount, steps, active, created_at, sla_hours, escalate_role)
         VALUES (?,?,?,?,?,1,?,?,?)`
      ).run(to.name, to.target_type, to.min_amount, to.max_amount, to.steps, t, to.sla_hours, to.escalate_role);
    }

    db.prepare(
      `UPDATE flow_changes SET status='published', effective_from=?, migration_mode=?, migration_note=?,
         critical_role_note=?, inflight_count=?, inflight_migrated=?, updated_at=? WHERE id=?`
    ).run(effFrom, mode, migrationNote || null, criticalNote || null, imp.inflight_total, 0, t, changeId);

    if (mode === 'migrate') {
      const newSteps = JSON.parse(to.steps || '[]');
      imp.rows.filter((r) => r.can_migrate).forEach((r) => {
        db.prepare('DELETE FROM approval_tasks WHERE instance_id = ? AND status = ?').run(r.instance_id, 'pending');
        const ins = db.prepare(
          "INSERT INTO approval_tasks (instance_id, step_no, role, step_name, status) VALUES (?,?,?,?,'pending')"
        );
        newSteps.forEach((s, i) => ins.run(r.instance_id, i + 1, s.role, s.name || `第 ${i + 1} 级`));
        db.prepare('UPDATE approval_instances SET flow_version_id=?, steps_snapshot=?, current_step=1 WHERE id=?')
          .run(to.id, to.steps, r.instance_id);
        migrated += 1;
      });
      db.prepare('UPDATE flow_changes SET inflight_migrated=? WHERE id=?').run(migrated, changeId);
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  audit(c.change_no, c.flow_key, to.id, 'publish', opt.operator, {
    effective_from: effFrom,
    from_version: from ? from.version_no : null,
    to_version: to.version_no,
    inflight_total: imp.inflight_total,
    migration_mode: mode,
    migrated,
    removed_critical_roles: removedCritical
  });
  if (migrated) audit(c.change_no, c.flow_key, to.id, 'migrate', opt.operator, { migrated });

  return detail(changeId);
}

/**
 * 回滚：把上一版重新设为生效
 *
 * 只能回滚「最近一次发布」的变更 —— 回滚到更早的版本会让中间几次变更的去向说不清。
 */
function rollback(changeId, opt = {}) {
  const c = db.prepare('SELECT * FROM flow_changes WHERE id = ?').get(changeId);
  if (!c) throw bad('变更单不存在', 404);
  if (c.status !== 'published') throw bad('只有已发布的变更可以回滚');

  const cur1 = db.prepare("SELECT * FROM flow_versions WHERE flow_key = ? AND status = 'published'").get(c.flow_key);
  if (!cur1 || cur1.id !== c.to_version_id) {
    throw bad('只能回滚最近一次发布的变更（当前生效版本不是这次变更的版本）');
  }

  const reason = String(opt.reason || '').trim();
  if (reason.length < 6) throw bad('回滚必须写原因（至少 6 个字）：不写清为什么回滚，下次还会踩同一个坑');

  const prev = db
    .prepare("SELECT * FROM flow_versions WHERE flow_key = ? AND version_no < ? ORDER BY version_no DESC LIMIT 1")
    .get(c.flow_key, cur1.version_no);
  if (!prev) throw bad('没有可以回滚的历史版本', 400);

  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE flow_versions SET status='rolled_back', updated_at=? WHERE id=?").run(t, cur1.id);
    db.prepare("UPDATE flow_versions SET status='published', updated_at=? WHERE id=?").run(t, prev.id);
    const af = db.prepare('SELECT id FROM approval_flows WHERE target_type = ? AND name = ?').get(prev.target_type, prev.name);
    if (af) {
      db.prepare('UPDATE approval_flows SET steps=?, min_amount=?, max_amount=?, sla_hours=?, escalate_role=?, active=1 WHERE id=?')
        .run(prev.steps, prev.min_amount, prev.max_amount, prev.sla_hours, prev.escalate_role, af.id);
    }
    db.prepare("UPDATE flow_changes SET status='rolled_back', updated_at=? WHERE id=?").run(t, changeId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  audit(c.change_no, c.flow_key, prev.id, 'rollback', opt.operator,
    { reason, rolled_back_version: cur1.version_no, restored_version: prev.version_no });
  return detail(changeId);
}

/** 作废草稿（不发布） */
function reject(changeId, opt = {}) {
  const c = db.prepare('SELECT * FROM flow_changes WHERE id = ?').get(changeId);
  if (!c) throw bad('变更单不存在', 404);
  if (!['draft', 'trialed'].includes(c.status)) throw bad('只有未发布的变更可以作废');
  const reason = String(opt.reason || '').trim();
  if (reason.length < 4) throw bad('作废要写原因');
  db.prepare("UPDATE flow_changes SET status='rejected', updated_at=? WHERE id=?").run(now(), changeId);
  db.prepare("UPDATE flow_versions SET status='draft', updated_at=? WHERE id=?").run(now(), c.to_version_id);
  audit(c.change_no, c.flow_key, c.to_version_id, 'reject', opt.operator, { reason });
  return detail(changeId);
}

/* ==================================================================== *
 * 五、审计与字典
 * ==================================================================== */

function audits(q = {}) {
  const where = [];
  const args = [];
  if (q.flow_key) { where.push('flow_key = ?'); args.push(q.flow_key); }
  return db
    .prepare(`SELECT * FROM flow_audits ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`)
    .all(...args)
    .map((a) => ({
      ...a,
      action_label: { init: '初始化', create: '创建变更', trial: '试运行', publish: '发布', rollback: '回滚', migrate: '迁移在途单', reject: '作废' }[a.action] || a.action,
      detail: a.detail ? JSON.parse(a.detail) : null
    }));
}

function dict() {
  return {
    roles: Object.entries(ROLE_LABEL).map(([code, label]) => ({ code, label })),
    critical_roles: CRITICAL_ROLES,
    statuses: [
      { code: 'draft', label: '草稿' },
      { code: 'trialed', label: '已试运行（待发布）' },
      { code: 'published', label: '已发布' },
      { code: 'rolled_back', label: '已回滚' },
      { code: 'rejected', label: '已作废' }
    ],
    migration_modes: [
      { code: 'keep_old', label: '在途单保持原版本（推荐）' },
      { code: 'migrate', label: '把未开始的在途单迁到新版本' }
    ]
  };
}

module.exports = {
  CRITICAL_ROLES,
  ROLE_LABEL,
  listFlows,
  versions,
  listChanges,
  detail,
  createChange,
  trial,
  publish,
  rollback,
  reject,
  impact,
  audits,
  dict
};
