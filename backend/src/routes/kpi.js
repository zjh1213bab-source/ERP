/**
 * 岗位绩效指标与规则 / 个人周度绩效 / 绩效申诉（原型 TS-N13-12 / 13 / 14）
 *
 * 核心口径（写死在这里，不从别处猜）：
 * 1. 模板按「岗位族」配置，version 递增；已批准版本不原地改，改就出新版本
 * 2. 指标必须带 定义/计算口径/数据源/例外条件/扣分上限/复核人，缺一项不许提交审批
 * 3. 权重合计必须 = 100%，未审批通过只能「模拟试算」，不写正式绩效
 * 4. 周期可冻结；冻结后规则版本不再追溯影响该周期（快照在 kpi_items.rule_snapshot）
 * 5. 个人分 = 基准分 − 已确认扣分；**建议分和待复核分不进最终分**
 * 6. 同一事件只扣一次（dedupe_key 唯一）；非本人责任不自动扣分
 * 7. 申诉：未结申诉时分数是「暂定」，不得伪装成无争议最终分
 * 8. 复核人 ≠ 原确认人（涉及主管本人转上一级/人事）
 * 9. 绩效分不自动等同扣薪：本模块只出分与明细，工资仍由薪酬模块人工确认
 *
 * 数据源（自动建议扣分）：
 *   production_defect  报工不良率（production_reports）
 *   attendance_late    迟到次数（attendance，批准休假覆盖的日期不计）
 *   rework_duty        责任返工件数（rework_orders，责任方含本人）
 *   order_due          订单超期 —— **未核时限标待配置，不预测为 0 天，不自动扣分**
 *   manual             人工登记
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const EPS = 0.005;

// 角色口径对齐现有模块（系统没有独立 hr 角色，人事职能由 sales 兼）
const READ = ['admin', 'boss', 'sales', 'tech', 'finance', 'production', 'warehouse', 'hr'];
const WRITE = ['admin', 'hr'];                    // 模板、周期、生成：人事
const REVIEW = ['admin', 'hr', 'sales', 'production'];  // 扣分复核、申诉复核：人事 + 部门负责人

const TPL_STATUS = { draft: '草稿', pending_review: '待复核', approved: '已批准', retired: '已停用' };
const SCORE_STATUS = { draft: '草稿', pending_review: '待复核', confirmed: '已确认', appealing: '申诉中', closed: '已关闭' };
const REVIEW_STATUS = { pending: '待复核', confirmed: '已确认', rejected: '已驳回', unconfigured: '待配置' };
const APPEAL_STATUS = { none: '无', appealing: '申诉中', upheld: '维持原判', adjusted: '已调整', revoked: '已撤销' };
const APPEAL_DECISION = { pending: '未决', uphold: '维持', reduce: '调整', revoke: '撤销' };
const REASON_TYPES = {
  task_own: '任务归属不对', data_error: '数据错误', external: '外部依赖未到位',
  due_change: '截止时间变更', evidence: '证据不足', rule: '规则适用错误'
};
const DATA_SOURCES = {
  production_defect: '报工不良率', attendance_late: '迟到次数',
  rework_duty: '责任返工件数', order_due: '订单超期（待配置）', manual: '人工登记'
};
const CATEGORIES = { delivery: '交付', quality: '质量', site: '现场', coop: '协作', safety: '安全' };

/** 本地日期（YYYY-MM-DD），不要用 toISOString 的 UTC */
function localDate(d = new Date()) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}

/** ISO 周号：2026-W44 */
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 岗位 → 岗位族 */
function jobFamilyOf(position) {
  const p = String(position || '');
  if (/缝|车工|样衣|整烫|锁眼|钉扣|包装/.test(p)) return '缝制';
  if (/裁/.test(p)) return '裁剪';
  if (/检|质/.test(p)) return '检验';
  if (/印|绣/.test(p)) return '印花';
  if (/仓|物|库/.test(p)) return '仓储';
  if (/业务|销售|跟单|外贸/.test(p)) return '业务';
  if (/人事|行政|财务|会计|出纳|采购/.test(p)) return '职能';
  return '通用';
}

function templateNo(seq) {
  return genNo('KPI', seq);
}

function nextSeq(table, prefixLen) {
  const n = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c + 1;
  return n;
}

/** 该员工当前适用的已批准模板：岗位优先，其次岗位族，最后部门兜底 */
function templateFor(emp) {
  const fam = jobFamilyOf(emp.position);
  const rows = db.prepare("SELECT * FROM kpi_templates WHERE status = 'approved' ORDER BY version DESC, id DESC").all();
  const byTitle = rows.find((t) => t.job_title && t.job_title === emp.position && (!t.department_id || t.department_id === emp.department_id));
  if (byTitle) return byTitle;
  const byFamDept = rows.find((t) => t.job_family === fam && t.department_id && t.department_id === emp.department_id);
  if (byFamDept) return byFamDept;
  const byFam = rows.find((t) => t.job_family === fam && !t.department_id);
  if (byFam) return byFam;
  return rows.find((t) => t.job_family === '通用' && !t.department_id) || null;
}

/** 按阈值算建议扣分：超过目标值每 step 扣 deduct，封顶 */
function evalThreshold(rule, actual) {
  const cap = Number(rule.cap_score) || 0;
  let th = {};
  try { th = JSON.parse(rule.threshold_json || '{}'); } catch (e) { th = {}; }
  const base = Number(rule.target_value);
  if (!Number.isFinite(actual)) return { score: 0, steps: 0, note: '无数据，不扣分' };
  if (!Number.isFinite(base)) return { score: 0, steps: 0, note: '目标值未配置，不扣分' };
  const op = th.op || 'gt';
  const beyond = op === 'gt' ? actual - base : (op === 'lt' ? base - actual : 0);
  if (beyond <= EPS) return { score: 0, steps: 0, note: `达标（目标 ${base}${rule.unit || ''}，实际 ${round2(actual)}${rule.unit || ''}）` };
  const step = Number(th.step) > 0 ? Number(th.step) : 1;
  const per = Number(th.deduct) >= 0 ? Number(th.deduct) : 1;
  const steps = Math.ceil(beyond / step - 1e-9);
  const raw = steps * per;
  const score = cap > 0 ? Math.min(raw, cap) : raw;
  return {
    score: round2(score),
    steps,
    note: `超出目标 ${round2(beyond)}${rule.unit || ''}（${steps} 档 × ${per} 分${cap > 0 && raw > cap ? `，封顶 ${cap}` : ''}）`
  };
}

/** 期内的批准休假是否覆盖某天 */
function onApprovedLeave(employeeId, dateStr) {
  const row = db.prepare(
    "SELECT 1 AS x FROM leave_requests WHERE employee_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ? LIMIT 1"
  ).get(employeeId, dateStr, dateStr);
  return !!row;
}

/** 统计某员工在周期内的指标实绩 */
function metricOf(employee, rule, cycle) {
  const src = rule.data_source;
  if (src === 'production_defect') {
    const rows = db.prepare(
      `SELECT COALESCE(SUM(qty_ok),0) ok, COALESCE(SUM(qty_defect),0) df, COUNT(*) n
       FROM production_reports
       WHERE report_date >= ? AND report_date <= ? AND (employee_id = ? OR (employee_id IS NULL AND operator = ?))`
    ).get(cycle.start_date, cycle.end_date, employee.id, employee.name);
    const total = Number(rows.ok) + Number(rows.df);
    if (!total) return { value: null, evidence: '期内没有报工记录，不出分也不扣分（不按 0 计）', detail: { ok: 0, defect: 0, reports: 0 } };
    return {
      value: round2((Number(rows.df) / total) * 100),
      evidence: `期内报工 ${rows.n} 笔：合格 ${round2(rows.ok)} 件 / 不良 ${round2(rows.df)} 件，不良率 ${round2((Number(rows.df) / total) * 100)}%`,
      detail: { ok: round2(rows.ok), defect: round2(rows.df), reports: rows.n }
    };
  }
  if (src === 'attendance_late') {
    const rows = db.prepare(
      "SELECT date, check_in FROM attendance WHERE employee_id = ? AND date >= ? AND date <= ? AND status = 'late' ORDER BY date"
    ).all(employee.id, cycle.start_date, cycle.end_date);
    const excused = rows.filter((r) => onApprovedLeave(employee.id, r.date));
    const counted = rows.filter((r) => !onApprovedLeave(employee.id, r.date));
    if (!rows.length) return { value: 0, evidence: '期内无迟到记录', detail: { late: 0, excused: 0 } };
    return {
      value: counted.length,
      evidence: `期内迟到 ${rows.length} 次${excused.length ? `，其中 ${excused.length} 次在批准休假/外出期间（不计）` : ''}`,
      detail: { late: rows.length, excused: excused.length, counted: counted.length }
    };
  }
  if (src === 'rework_duty') {
    const rows = db.prepare(
      `SELECT id, rw_no, qty, reason, responsibility FROM rework_orders
       WHERE substr(created_at,1,10) >= ? AND substr(created_at,1,10) <= ?
         AND (responsibility LIKE ? OR responsibility LIKE ?)`
    ).all(cycle.start_date, cycle.end_date, `%${employee.name}%`, `%${employee.code || '@@'}%`);
    if (!rows.length) return { value: 0, evidence: '期内无本人责任的返工件', detail: { reworks: 0 } };
    const qty = rows.reduce((a, r) => a + Number(r.qty || 0), 0);
    return {
      value: qty,
      evidence: `期内本人责任返工 ${rows.length} 单（${rows.map((r) => r.rw_no).join('、')}），合计 ${qty} 件`,
      detail: { reworks: rows.length, qty }
    };
  }
  if (src === 'order_due') {
    // 原型明确：订单超期与个人责任分别核；未核时限标待配置，不预测为 0 天，不自动扣分
    return {
      value: null,
      unconfigured: true,
      evidence: '订单超期与个人责任分别核：时限未核定时标「待配置」，不预测为 0 天，不自动扣分',
      detail: {}
    };
  }
  return { value: null, manual: true, evidence: '人工登记项，系统不自动生成', detail: {} };
}

/** 重算一张绩效单的合计与状态 */
function recalc(scoreId) {
  const s = db.prepare('SELECT * FROM kpi_scores WHERE id = ?').get(scoreId);
  if (!s) return null;
  const items = db.prepare('SELECT * FROM kpi_items WHERE score_id = ?').all(scoreId);

  const suggested = items.filter((i) => i.review_status === 'pending').reduce((a, i) => a + Number(i.suggested_score), 0);
  const confirmedAll = items.filter((i) => i.review_status === 'confirmed').reduce((a, i) => a + Number(i.confirmed_score), 0);
  const appealing = items.filter((i) => i.review_status === 'confirmed' && i.appeal_status === 'appealing').reduce((a, i) => a + Number(i.confirmed_score), 0);
  const pendingReview = suggested;
  const confirmed = round2(confirmedAll);
  const base = Number(s.base_score) || 0;
  const current = round2(base - confirmed);

  const openAppeals = db.prepare("SELECT COUNT(*) c FROM kpi_appeals WHERE score_id = ? AND status IN ('submitted','accepted')").get(scoreId).c;
  const provisional = openAppeals > 0 ? 1 : 0;

  let status = s.status;
  const cycle = db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(s.cycle_id);
  const frozen = cycle && cycle.status === 'frozen';
  if (openAppeals > 0) status = 'appealing';
  else if (items.some((i) => i.review_status === 'pending')) status = 'pending_review';
  else if (frozen) status = 'closed';
  else if (items.length && items.every((i) => i.review_status !== 'pending')) status = 'confirmed';
  else status = 'confirmed';

  db.prepare(
    `UPDATE kpi_scores SET suggested_score = ?, pending_score = ?, confirmed_score = ?, appeal_score = ?,
       current_score = ?, provisional = ?, item_count = ?, appeal_count = ?, status = ?, updated_at = ?
     WHERE id = ?`
  ).run(round2(suggested), round2(pendingReview), confirmed, round2(appealing), current, provisional,
    items.length, openAppeals, status, now(), scoreId);
  return db.prepare('SELECT * FROM kpi_scores WHERE id = ?').get(scoreId);
}

function scoreView(s) {
  if (!s) return null;
  const items = db.prepare('SELECT * FROM kpi_items WHERE score_id = ? ORDER BY id').all(s.id).map((i) => {
    let snap = {};
    try { snap = JSON.parse(i.rule_snapshot || '{}'); } catch (e) { snap = {}; }
    const appeal = db.prepare("SELECT * FROM kpi_appeals WHERE item_id = ? ORDER BY id DESC LIMIT 1").get(i.id);
    return {
      ...i,
      rule_snapshot: snap,
      review_label: REVIEW_STATUS[i.review_status] || i.review_status,
      appeal_label: APPEAL_STATUS[i.appeal_status] || i.appeal_status,
      effective_score: i.review_status === 'confirmed' ? round2(i.confirmed_score) : 0,
      appeal: appeal ? { ...appeal, decision_label: APPEAL_DECISION[appeal.decision] || appeal.decision } : null
    };
  });
  return {
    ...s,
    status_label: SCORE_STATUS[s.status] || s.status,
    base_score: round2(s.base_score),
    current_score: s.current_score === null ? null : round2(s.current_score),
    // 有未结申诉时不给「最终分」，只给暂定分
    final_score: s.provisional ? null : (s.current_score === null ? null : round2(s.current_score)),
    items,
    breakdown: items.reduce((acc, i) => {
      const k = i.category || 'other';
      acc[k] = round2((acc[k] || 0) + i.effective_score);
      return acc;
    }, {}),
    category_labels: CATEGORIES,
    notice: s.provisional
      ? '有未结申诉，当前分是暂定分，不能作为无争议最终分使用'
      : (s.status === 'closed' ? '周期已冻结，分数已定版' : null)
  };
}

function quarterRange(target) {
  const parts = String(target || '').split('-W');
  const year = Number(parts[0]);
  const week = Number(parts[1]);
  const jan4 = new Date(year, 0, 4);
  const dow = jan4.getDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - dow + 1);
  const monday = new Date(week1Monday);
  monday.setDate(week1Monday.getDate() + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const cycleNo = isoWeek(localDate(monday));
  return { cycle_no: cycleNo, start_date: localDate(monday), end_date: localDate(sunday) };
}

// ============================================================
// 一、模板与规则（TS-N13-12）
// ============================================================

/** 模板列表 */
router.get('/templates', authRequired, wrap(async (req, res) => {
  const { status, q, job_family } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (job_family) { where.push('t.job_family = ?'); params.push(job_family); }
  if (q) { where.push('(t.name LIKE ? OR t.template_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT t.*, d.name AS department_name,
       (SELECT COUNT(*) FROM kpi_rules r WHERE r.template_id = t.id) AS rule_count,
       (SELECT COUNT(*) FROM kpi_scores s WHERE s.template_id = t.id) AS used_count,
       (SELECT COALESCE(SUM(r.weight),0) FROM kpi_rules r WHERE r.template_id = t.id) AS weight_sum
     FROM kpi_templates t LEFT JOIN departments d ON d.id = t.department_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY t.job_family, t.version DESC, t.id DESC'
  ).all(...params).map((t) => ({
    ...t,
    status_label: TPL_STATUS[t.status] || t.status,
    weight_sum: round2(t.weight_sum),
    weight_ok: Math.abs(Number(t.weight_sum) - 100) < 0.01,
    can_publish: t.status === 'pending_review'
  }));
  return ok(res, {
    rows,
    stat: {
      total: rows.length,
      approved: rows.filter((r) => r.status === 'approved').length,
      pending: rows.filter((r) => r.status === 'pending_review').length,
      draft: rows.filter((r) => r.status === 'draft').length,
      families: [...new Set(rows.map((r) => r.job_family))].filter(Boolean)
    },
    dict: {
      status: TPL_STATUS, categories: CATEGORIES, data_sources: DATA_SOURCES
    },
    note: '按岗位族配置，不用一套指标考核所有岗位；已批准的版本不原地改，改就出新版本'
  });
}));

/** 模板详情（含指标） */
router.get('/templates/:id', authRequired, wrap(async (req, res) => {
  const t = db.prepare(
    `SELECT t.*, d.name AS department_name FROM kpi_templates t
     LEFT JOIN departments d ON d.id = t.department_id WHERE t.id = ?`
  ).get(req.params.id);
  if (!t) return fail(res, 404, '模板不存在');
  const rules = db.prepare('SELECT * FROM kpi_rules WHERE template_id = ? ORDER BY sort, id').all(t.id).map((r) => {
    let th = {};
    try { th = JSON.parse(r.threshold_json || '{}'); } catch (e) { th = {}; }
    return {
      ...r,
      threshold: th,
      category_label: CATEGORIES[r.category] || r.category,
      data_source_label: DATA_SOURCES[r.data_source] || r.data_source,
      // 完整性检查：缺一项不许提交审批
      missing: [
        !r.definition && '定义',
        !r.formula && '计算口径',
        !r.data_source && '数据源',
        !r.reviewer && '复核人',
        !(Number(r.cap_score) > 0) && '扣分上限'
      ].filter(Boolean)
    };
  });
  const hist = db.prepare("SELECT id, template_no, version, status FROM kpi_templates WHERE job_family = ? ORDER BY version DESC").all(t.job_family);
  return ok(res, {
    ...t,
    status_label: TPL_STATUS[t.status] || t.status,
    rules,
    weight_sum: round2(rules.reduce((a, r) => a + Number(r.weight), 0)),
    versions: hist,
    dict: { categories: CATEGORIES, data_sources: DATA_SOURCES },
    can_edit: t.status === 'draft',
    locked_reason: t.status === 'approved'
      ? '已批准版本不能改：要调整请用「出新版本」，历史周期仍按旧版本结算'
      : (t.status === 'pending_review' ? '待复核中不能改：先驳回或等批准' : null)
  });
}));

/** 建模板（草稿） */
router.post('/templates', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.name || '').trim()) return fail(res, 400, '请填模板名称');
  const fam = String(b.job_family || '').trim();
  if (!fam) return fail(res, 400, '请选择岗位族（不同岗位不能共用一套指标）');
  const base = Number(b.base_score);
  if (!(base > 0)) return fail(res, 400, '基准分必须大于 0');
  const t = now();
  const info = db.prepare(
    `INSERT INTO kpi_templates (template_no, name, job_family, job_title, department_id, base_score,
       cycle_type, version, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'weekly', 1, 'draft', ?,?,?)`
  ).run(templateNo(nextSeq('kpi_templates')), String(b.name).trim(), fam, b.job_title || null,
    b.department_id || null, base, req.user.username, t, t);
  return ok(res, { id: Number(info.lastInsertRowid), notice: '已建草稿，接着配置指标并提交审批' });
}));

/** 改模板（仅草稿） */
router.put('/templates/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM kpi_templates WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '模板不存在');
  if (t.status !== 'draft') return fail(res, 400, `模板状态是「${TPL_STATUS[t.status]}」，不能改。要调整请出新版本`);
  const b = req.body || {};
  if (b.base_score !== undefined && !(Number(b.base_score) > 0)) return fail(res, 400, '基准分必须大于 0');
  db.prepare(
    `UPDATE kpi_templates SET name = ?, job_family = ?, job_title = ?, department_id = ?, base_score = ?,
       remark = ?, updated_at = ? WHERE id = ?`
  ).run(
    b.name !== undefined ? String(b.name).trim() : t.name,
    b.job_family !== undefined ? b.job_family : t.job_family,
    b.job_title !== undefined ? b.job_title : t.job_title,
    b.department_id !== undefined ? b.department_id : t.department_id,
    b.base_score !== undefined ? Number(b.base_score) : t.base_score,
    b.remark !== undefined ? b.remark : t.remark, now(), t.id
  );
  return ok(res, { id: t.id });
}));

/** 加 / 改指标 */
router.post('/templates/:id/rules', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM kpi_templates WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '模板不存在');
  if (t.status !== 'draft') return fail(res, 400, `模板状态是「${TPL_STATUS[t.status]}」，不能改指标`);
  const b = req.body || {};
  if (!String(b.name || '').trim()) return fail(res, 400, '请填指标名称');
  const weight = Number(b.weight);
  if (!(weight > 0)) return fail(res, 400, '权重必须大于 0');
  const t2 = now();
  const info = db.prepare(
    `INSERT INTO kpi_rules (template_id, code, name, category, definition, formula, target_value, unit,
       weight, threshold_json, data_source, exception_note, cap_score, reviewer, auto_suggest, sort, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(t.id, b.code || null, String(b.name).trim(), b.category || 'quality', b.definition || null,
    b.formula || null, b.target_value === undefined ? null : Number(b.target_value), b.unit || null,
    weight, b.threshold_json ? JSON.stringify(b.threshold_json) : JSON.stringify(b.threshold || {}),
    b.data_source || 'manual', b.exception_note || null, Number(b.cap_score) || 0,
    b.reviewer || null, b.auto_suggest === 0 ? 0 : 1,
    Number(b.sort) || db.prepare('SELECT COUNT(*) c FROM kpi_rules WHERE template_id = ?').get(t.id).c,
    t2, t2);
  return ok(res, { id: Number(info.lastInsertRowid) });
}));

router.put('/templates/:id/rules/:rid', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM kpi_templates WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '模板不存在');
  if (t.status !== 'draft') return fail(res, 400, '只有草稿模板能改指标（已批准的请出新版本）');
  const r = db.prepare('SELECT * FROM kpi_rules WHERE id = ? AND template_id = ?').get(req.params.rid, t.id);
  if (!r) return fail(res, 404, '指标不存在');
  const b = req.body || {};
  db.prepare(
    `UPDATE kpi_rules SET name = ?, category = ?, definition = ?, formula = ?, target_value = ?, unit = ?,
       weight = ?, threshold_json = ?, data_source = ?, exception_note = ?, cap_score = ?, reviewer = ?,
       auto_suggest = ?, updated_at = ? WHERE id = ?`
  ).run(
    b.name !== undefined ? b.name : r.name,
    b.category !== undefined ? b.category : r.category,
    b.definition !== undefined ? b.definition : r.definition,
    b.formula !== undefined ? b.formula : r.formula,
    b.target_value !== undefined ? Number(b.target_value) : r.target_value,
    b.unit !== undefined ? b.unit : r.unit,
    b.weight !== undefined ? Number(b.weight) : r.weight,
    b.threshold_json !== undefined ? JSON.stringify(b.threshold_json)
      : (b.threshold !== undefined ? JSON.stringify(b.threshold) : r.threshold_json),
    b.data_source !== undefined ? b.data_source : r.data_source,
    b.exception_note !== undefined ? b.exception_note : r.exception_note,
    b.cap_score !== undefined ? Number(b.cap_score) : r.cap_score,
    b.reviewer !== undefined ? b.reviewer : r.reviewer,
    b.auto_suggest !== undefined ? (b.auto_suggest ? 1 : 0) : r.auto_suggest,
    now(), r.id);
  return ok(res, { id: r.id });
}));

router.delete('/templates/:id/rules/:rid', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM kpi_templates WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '模板不存在');
  if (t.status !== 'draft') return fail(res, 400, '只有草稿模板能删指标');
  const r = db.prepare('SELECT * FROM kpi_rules WHERE id = ? AND template_id = ?').get(req.params.rid, t.id);
  if (!r) return fail(res, 404, '指标不存在');
  db.prepare('DELETE FROM kpi_rules WHERE id = ?').run(r.id);
  return ok(res, { id: r.id });
}));

/** 提交复核（校验完整性 + 权重 100%） */
router.post('/templates/:id/submit', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM kpi_templates WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '模板不存在');
  if (t.status !== 'draft') return fail(res, 400, `模板状态是「${TPL_STATUS[t.status]}」，不能提交`);
  const rules = db.prepare('SELECT * FROM kpi_rules WHERE template_id = ?').all(t.id);
  if (!rules.length) return fail(res, 400, '还没有配置指标，不能提交审批');
  const bad = [];
  rules.forEach((r) => {
    const miss = [];
    if (!r.definition) miss.push('定义');
    if (!r.formula) miss.push('计算口径');
    if (!r.data_source) miss.push('数据源');
    if (!r.reviewer) miss.push('复核人');
    if (!(Number(r.cap_score) > 0)) miss.push('扣分上限');
    if (miss.length) bad.push(`「${r.name}」缺 ${miss.join('、')}`);
  });
  if (bad.length) return fail(res, 400, `指标信息不全，不能提交审批：\n${bad.join('\n')}`);
  const sum = round2(rules.reduce((a, r) => a + Number(r.weight), 0));
  if (Math.abs(sum - 100) > 0.01) return fail(res, 400, `权重合计 ${sum}%，必须正好 100% 才能提交审批`);
  db.prepare("UPDATE kpi_templates SET status = 'pending_review', submitted_by = ?, submitted_at = ?, updated_at = ? WHERE id = ?")
    .run(req.user.username, now(), now(), t.id);
  return ok(res, { id: t.id, status: 'pending_review', notice: `已提交复核：${rules.length} 项指标、权重合计 ${sum}%` });
}));

/** 批准发布 / 驳回 */
router.post('/templates/:id/approve', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM kpi_templates WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '模板不存在');
  if (t.status !== 'pending_review') return fail(res, 400, `模板状态是「${TPL_STATUS[t.status]}」，只有待复核能批`);
  const b = req.body || {};
  if (b.agree === false) {
    const note = String(b.note || '').trim();
    if (!note) return fail(res, 400, '驳回必须写原因');
    db.prepare("UPDATE kpi_templates SET status = 'draft', approved_by = ?, approved_at = ?, review_note = ?, updated_at = ? WHERE id = ?")
      .run(req.user.username, now(), note, now(), t.id);
    return ok(res, { id: t.id, status: 'draft', notice: '已驳回，模板回到草稿' });
  }
  // 批准前再核一次权重与完整性（防止提交后又被动过）
  const rules = db.prepare('SELECT * FROM kpi_rules WHERE template_id = ?').all(t.id);
  const sum = round2(rules.reduce((a, r) => a + Number(r.weight), 0));
  if (Math.abs(sum - 100) > 0.01) return fail(res, 400, `权重合计 ${sum}%，不是 100%，不能批准`);
  const eff = b.effective_from || localDate();
  const t2 = now();
  db.exec('BEGIN');
  try {
    // 同岗位族同岗位的旧版本置为 retired（保留历史可查）
    db.prepare(
      "UPDATE kpi_templates SET status = 'retired', updated_at = ? WHERE id != ? AND status = 'approved' AND job_family = ? AND COALESCE(job_title,'') = COALESCE(?, '')"
    ).run(t2, t.id, t.job_family, t.job_title);
    db.prepare(
      "UPDATE kpi_templates SET status = 'approved', approved_by = ?, approved_at = ?, effective_from = ?, review_note = ?, updated_at = ? WHERE id = ?"
    ).run(req.user.username, t2, eff, b.note || null, t2, t.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return ok(res, {
    id: t.id, status: 'approved', effective_from: eff, version: t.version,
    notice: `已批准并生效（${eff} 起）：${rules.length} 项指标、权重 ${sum}%。同一岗位族的旧版本已转「已停用」`
  });
}));

/** 出新版本（基于已批准版本复制成草稿；历史周期不受影响） */
router.post('/templates/:id/new-version', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM kpi_templates WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '模板不存在');
  if (t.status !== 'approved') return fail(res, 400, '只有已批准的模板才需要出新版本');
  const rules = db.prepare('SELECT * FROM kpi_rules WHERE template_id = ? ORDER BY sort, id').all(t.id);
  const t2 = now();
  let newId;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO kpi_templates (template_no, name, job_family, job_title, department_id, base_score,
         cycle_type, version, parent_id, status, remark, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?)`
    ).run(templateNo(nextSeq('kpi_templates')), t.name, t.job_family, t.job_title, t.department_id,
      t.base_score, t.cycle_type, Number(t.version) + 1, t.id, t.remark, req.user.username, t2, t2);
    newId = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO kpi_rules (template_id, code, name, category, definition, formula, target_value, unit,
         weight, threshold_json, data_source, exception_note, cap_score, reviewer, auto_suggest, sort, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    rules.forEach((r) => ins.run(newId, r.code, r.name, r.category, r.definition, r.formula, r.target_value,
      r.unit, r.weight, r.threshold_json, r.data_source, r.exception_note, r.cap_score, r.reviewer,
      r.auto_suggest, r.sort, t2, t2));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return ok(res, {
    id: newId, version: Number(t.version) + 1,
    notice: `已出 V${Number(t.version) + 1} 草稿（复制 ${rules.length} 项指标）。旧版本继续用于已冻结周期，新周期用新版本`
  });
}));

/** 模拟试算（模板未批准时可看效果，不写正式绩效） */
router.post('/templates/:id/simulate', authRequired, wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM kpi_templates WHERE id = ?').get(req.params.id);
  if (!t) return fail(res, 404, '模板不存在');
  const b = req.body || {};
  const cycle = b.cycle_id
    ? db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(b.cycle_id)
    : db.prepare('SELECT * FROM kpi_cycles ORDER BY start_date DESC LIMIT 1').get();
  if (!cycle) return fail(res, 400, '还没有考核周期，请先生成周期');
  const rules = db.prepare('SELECT * FROM kpi_rules WHERE template_id = ? ORDER BY sort, id').all(t.id);
  const emps = db.prepare("SELECT * FROM employees WHERE status = 'active'").all()
    .filter((e) => jobFamilyOf(e.position) === t.job_family || (t.job_title && e.position === t.job_title));

  const rows = emps.map((e) => {
    const detail = rules.filter((r) => r.auto_suggest).map((r) => {
      const m = metricOf(e, r, cycle);
      const ev = evalThreshold(r, m.value);
      return {
        rule: r.name, actual: m.value, target: r.target_value, unit: r.unit,
        suggested: ev.score, note: ev.note, unconfigured: !!m.unconfigured, evidence: m.evidence
      };
    });
    const total = round2(detail.reduce((a, x) => a + x.suggested, 0));
    return {
      employee_id: e.id, employee_name: e.name, position: e.position,
      base_score: Number(t.base_score), suggested_total: total,
      simulated_score: round2(Number(t.base_score) - total), detail
    };
  });
  return ok(res, {
    template: { id: t.id, name: t.name, version: t.version, status: t.status, status_label: TPL_STATUS[t.status] },
    cycle: { id: cycle.id, cycle_no: cycle.cycle_no, start_date: cycle.start_date, end_date: cycle.end_date },
    rows,
    simulated: true,
    notice: '这是模拟试算，没有写入正式绩效。任何权重/阈值未审批通过，只能试算，不发布正式分数'
  });
}));

// ============================================================
// 二、考核周期
// ============================================================

router.get('/cycles', authRequired, wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM kpi_cycles ORDER BY start_date DESC').all().map((c) => ({
    ...c,
    status_label: c.status === 'frozen' ? '已冻结' : '进行中',
    score_count: db.prepare('SELECT COUNT(*) c FROM kpi_scores WHERE cycle_id = ?').get(c.id).c,
    appeal_count: db.prepare("SELECT COUNT(*) c FROM kpi_appeals WHERE cycle_id = ? AND status IN ('submitted','accepted')").get(c.id).c
  }));
  return ok(res, rows);
}));

/** 生成周期：{weeks: 4} 从本周往前推，或 {cycle_no:'2026-W44'} 指定 */
router.post('/cycles', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const created = [];
  const t = now();
  const targets = [];
  if (b.cycle_no) {
    targets.push(String(b.cycle_no));
  } else {
    const n = Math.min(Math.max(Number(b.weeks) || 1, 1), 26);
    let cur = localDate();
    for (let i = 0; i < n; i++) {
      targets.push(isoWeek(cur));
      cur = addDays(cur, -7);
    }
  }
  targets.forEach((no) => {
    const r = quarterRange(no);
    if (db.prepare('SELECT 1 AS x FROM kpi_cycles WHERE cycle_no = ?').get(r.cycle_no)) return;
    const info = db.prepare('INSERT INTO kpi_cycles (cycle_no, start_date, end_date, status, created_at) VALUES (?,?,?, \'open\', ?)')
      .run(r.cycle_no, r.start_date, r.end_date, t);
    created.push({ id: Number(info.lastInsertRowid), ...r });
  });
  return ok(res, { created, skipped: targets.length - created.length, notice: created.length ? `新建 ${created.length} 个周期` : '这些周期已存在' });
}));

/** 冻结周期：冻结后规则版本不再追溯，有未结申诉的仍标记暂定 */
router.post('/cycles/:id/freeze', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(req.params.id);
  if (!c) return fail(res, 404, '周期不存在');
  if (c.status === 'frozen') return fail(res, 400, '这个周期已经冻结了');
  const pending = db.prepare("SELECT COUNT(*) c FROM kpi_items WHERE cycle_id = ? AND review_status = 'pending'").get(c.id).c;
  if (pending > 0) return fail(res, 400, `还有 ${pending} 项待复核，复核完才能冻结（冻结后分数就定版了）`);
  db.prepare("UPDATE kpi_cycles SET status = 'frozen', frozen_by = ?, frozen_at = ? WHERE id = ?").run(req.user.username, now(), c.id);
  const scores = db.prepare('SELECT id FROM kpi_scores WHERE cycle_id = ?').all(c.id);
  scores.forEach((s) => recalc(s.id));
  const openAppeals = db.prepare("SELECT COUNT(*) c FROM kpi_appeals WHERE cycle_id = ? AND status IN ('submitted','accepted')").get(c.id).c;
  return ok(res, {
    id: c.id, status: 'frozen',
    notice: `已冻结 ${c.cycle_no}，${scores.length} 张绩效单定版` +
      (openAppeals ? `；其中 ${openAppeals} 项申诉未结，对应分数仍是暂定，不能当无争议最终分` : '')
  });
}));

// ============================================================
// 三、个人周度绩效（TS-N13-13）
// ============================================================

/** 生成某周期的绩效与建议扣分 */
router.post('/generate', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const cycle = b.cycle_id
    ? db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(b.cycle_id)
    : db.prepare('SELECT * FROM kpi_cycles ORDER BY start_date DESC LIMIT 1').get();
  if (!cycle) return fail(res, 400, '还没有考核周期，请先生成周期');
  if (cycle.status === 'frozen') return fail(res, 400, `${cycle.cycle_no} 已冻结，不能再生成或改写`);

  let emps;
  if (Array.isArray(b.employee_ids) && b.employee_ids.length) {
    emps = db.prepare(`SELECT * FROM employees WHERE id IN (${b.employee_ids.map(() => '?').join(',')})`).all(...b.employee_ids);
  } else {
    emps = db.prepare("SELECT * FROM employees WHERE status = 'active'").all();
  }
  if (!emps.length) return fail(res, 400, '没有在职员工');

  const results = [];
  const t = now();
  db.exec('BEGIN');
  try {
    emps.forEach((emp) => {
      const tpl = templateFor(emp);
      if (!tpl) { results.push({ employee_id: emp.id, employee_name: emp.name, skipped: '没有匹配的已批准模板' }); return; }
      const rules = db.prepare('SELECT * FROM kpi_rules WHERE template_id = ? ORDER BY sort, id').all(tpl.id);

      let score = db.prepare('SELECT * FROM kpi_scores WHERE employee_id = ? AND cycle_id = ?').get(emp.id, cycle.id);
      if (!score) {
        const info = db.prepare(
          `INSERT INTO kpi_scores (employee_id, employee_name, department_id, position, cycle_id, cycle_no,
             template_id, template_no, template_version, base_score, status, generated_by, generated_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?)`
        ).run(emp.id, emp.name, emp.department_id, emp.position, cycle.id, cycle.cycle_no,
          tpl.id, tpl.template_no, tpl.version, tpl.base_score, req.user.username, t, t, t);
        score = db.prepare('SELECT * FROM kpi_scores WHERE id = ?').get(Number(info.lastInsertRowid));
      }
      if (score.status === 'closed') { results.push({ employee_id: emp.id, employee_name: emp.name, skipped: '这张单已关闭' }); return; }

      const existing = db.prepare("SELECT dedupe_key FROM kpi_items WHERE score_id = ? AND review_status IN ('pending','confirmed')").all(score.id).map((x) => x.dedupe_key);
      const ins = db.prepare(
        `INSERT OR IGNORE INTO kpi_items (score_id, employee_id, cycle_id, rule_id, rule_code, rule_name, rule_snapshot,
           category, order_id, order_no, node_id, node_name, task_desc, target_value, actual_value,
           evidence, suggested_score, confirmed_score, responsibility, dedupe_key, source, review_status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?, 'auto', ?, ?)`
      );
      let added = 0;
      const notes = [];
      rules.forEach((r) => {
        if (!r.auto_suggest) return;
        const m = metricOf(emp, r, cycle);
        const key = `${r.id}:${cycle.id}`;
        if (existing.includes(key)) return;

        if (m.unconfigured) {
          ins.run(score.id, emp.id, cycle.id, r.id, r.code, r.name,
            JSON.stringify({ version: tpl.version, template_no: tpl.template_no, threshold: safeJson(r.threshold_json), cap: r.cap_score, data_source: r.data_source, unit: r.unit, name: r.name }),
            r.category, null, null, null, null, `${r.name}（时限未核定）`,
            r.target_value, null, m.evidence, 0, 'pending', key, 'unconfigured', t);
          added++;
          notes.push(`「${r.name}」标记待配置，未自动扣分`);
          return;
        }
        if (m.value === null && !m.manual) {
          // 无数据：不按 0 计，不生成扣分项
          return;
        }
        const ev = evalThreshold(r, m.value);
        if (ev.score <= EPS) return;
        ins.run(score.id, emp.id, cycle.id, r.id, r.code, r.name,
          JSON.stringify({ version: tpl.version, template_no: tpl.template_no, threshold: safeJson(r.threshold_json), cap: r.cap_score, data_source: r.data_source, unit: r.unit, name: r.name }),
          r.category, null, null, null, null, r.name,
          r.target_value, m.value, `${m.evidence}；${ev.note}`,
          ev.score, 'self', key, 'pending', t);
        added++;
      });
      recalc(score.id);
      const after = db.prepare('SELECT * FROM kpi_scores WHERE id = ?').get(score.id);
      results.push({
        employee_id: emp.id, employee_name: emp.name, position: emp.position,
        template: `${tpl.template_no} V${tpl.version}`, added,
        suggested_score: round2(after.suggested_score),
        base_score: round2(after.base_score), status: after.status, notes
      });
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return ok(res, {
    cycle: { id: cycle.id, cycle_no: cycle.cycle_no, start_date: cycle.start_date, end_date: cycle.end_date },
    results,
    notice: '已生成建议扣分。建议分不计入当前分，必须主管逐项复核确认后才生效'
  });
}));

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}

/** 绩效列表 */
router.get('/scores', authRequired, wrap(async (req, res) => {
  const { cycle_id, employee_id, status, q } = req.query;
  const cycle = cycle_id
    ? db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(cycle_id)
    : db.prepare('SELECT * FROM kpi_cycles ORDER BY start_date DESC LIMIT 1').get();
  if (!cycle) return ok(res, { cycle: null, rows: [], stat: {}, note: '还没有考核周期，先在「周期」里生成' });
  const where = ['s.cycle_id = ?'];
  const params = [cycle.id];
  if (employee_id) { where.push('s.employee_id = ?'); params.push(employee_id); }
  if (status) { where.push('s.status = ?'); params.push(status); }
  if (q) { where.push('s.employee_name LIKE ?'); params.push(`%${q}%`); }
  const rows = db.prepare(
    `SELECT s.*, d.name AS department_name FROM kpi_scores s
     LEFT JOIN departments d ON d.id = s.department_id
     WHERE ${where.join(' AND ')} ORDER BY s.current_score IS NULL, s.current_score DESC, s.id`
  ).all(...params).map((s) => ({
    ...s,
    status_label: SCORE_STATUS[s.status] || s.status,
    base_score: round2(s.base_score),
    suggested_score: round2(s.suggested_score),
    confirmed_score: round2(s.confirmed_score),
    current_score: s.current_score === null ? null : round2(s.current_score),
    final_score: s.provisional ? null : (s.current_score === null ? null : round2(s.current_score)),
    not_final: !!s.provisional
  }));
  const pendingItems = db.prepare("SELECT COUNT(*) c FROM kpi_items WHERE cycle_id = ? AND review_status = 'pending'").get(cycle.id).c;
  const openAppeals = db.prepare("SELECT COUNT(*) c FROM kpi_appeals WHERE cycle_id = ? AND status IN ('submitted','accepted')").get(cycle.id).c;
  return ok(res, {
    cycle: { ...cycle, status_label: cycle.status === 'frozen' ? '已冻结' : '进行中' },
    rows,
    stat: {
      people: rows.length,
      avg_score: rows.length ? round2(rows.reduce((a, r) => a + (r.current_score || 0), 0) / rows.length) : null,
      pending_items: pendingItems,
      open_appeals: openAppeals,
      confirmed: rows.filter((r) => r.status === 'confirmed' || r.status === 'closed').length,
      below90: rows.filter((r) => r.current_score !== null && r.current_score < 90).length
    },
    note: '当前分 = 基准分 − 已确认扣分；建议分与待复核分不进最终分'
  });
}));

/** 单人绩效详情 */
router.get('/scores/:id', authRequired, wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM kpi_scores WHERE id = ?').get(req.params.id);
  if (!s) return fail(res, 404, '绩效单不存在');
  const v = scoreView(s);
  const tpl = s.template_id ? db.prepare('SELECT * FROM kpi_templates WHERE id = ?').get(s.template_id) : null;
  const rules = s.template_id ? db.prepare('SELECT * FROM kpi_rules WHERE template_id = ? ORDER BY sort, id').all(s.template_id) : [];
  const appeals = db.prepare('SELECT * FROM kpi_appeals WHERE score_id = ? ORDER BY id DESC').all(s.id).map((a) => ({
    ...a, decision_label: APPEAL_DECISION[a.decision] || a.decision,
    reason_type_label: REASON_TYPES[a.reason_type] || a.reason_type,
    status_label: { submitted: '待受理', accepted: '已受理', decided: '已复核', withdrawn: '已撤回' }[a.status] || a.status
  }));
  const cycle = db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(s.cycle_id);
  return ok(res, {
    ...v,
    template: tpl ? { id: tpl.id, name: tpl.name, template_no: tpl.template_no, version: tpl.version, status: tpl.status, status_label: TPL_STATUS[tpl.status] } : null,
    rules,
    appeals,
    cycle: cycle ? { ...cycle, status_label: cycle.status === 'frozen' ? '已冻结' : '进行中' } : null,
    can_generate: cycle && cycle.status !== 'frozen',
    can_freeze: cycle && cycle.status !== 'frozen',
    dict: { reason_types: REASON_TYPES, review_status: REVIEW_STATUS, categories: CATEGORIES }
  });
}));

/** 主管复核单项：确认扣分 / 驳回建议 / 改分 */
router.post('/items/:id/confirm', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const it = db.prepare('SELECT * FROM kpi_items WHERE id = ?').get(req.params.id);
  if (!it) return fail(res, 404, '扣分项不存在');
  const score = db.prepare('SELECT * FROM kpi_scores WHERE id = ?').get(it.score_id);
  const cycle = db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(score.cycle_id);
  if (cycle && cycle.status === 'frozen') return fail(res, 400, '周期已冻结，不能再改扣分');
  if (it.review_status === 'confirmed' || it.review_status === 'rejected') {
    return fail(res, 400, `这一项已经「${REVIEW_STATUS[it.review_status]}」了，不能重复复核`);
  }
  const b = req.body || {};
  const action = b.action || 'confirm';   // confirm | reject
  if (action === 'reject') {
    const note = String(b.note || '').trim();
    if (!note) return fail(res, 400, '驳回建议必须写原因（比如非本人责任、证据不足、已登记外部依赖）');
    db.prepare(
      "UPDATE kpi_items SET review_status = 'rejected', confirmed_score = 0, reviewed_by = ?, reviewed_at = ?, review_note = ?, responsibility = ? WHERE id = ?"
    ).run(req.user.username, now(), note, b.responsibility || 'not_self', it.id);
    recalc(it.score_id);
    return ok(res, { item: db.prepare('SELECT * FROM kpi_items WHERE id = ?').get(it.id), score: scoreView(recalc(it.score_id)), notice: '已驳回建议，该项不计分' });
  }
  if (it.review_status === 'unconfigured') {
    return fail(res, 400, '这一项是「待配置」（时限未核定），不能直接确认扣分；请先补齐规则与时限，再走人工登记');
  }
  const val = b.confirmed_score === undefined ? Number(it.suggested_score) : Number(b.confirmed_score);
  if (!(val >= 0)) return fail(res, 400, '确认扣分不能是负数');
  const capRule = safeJson(it.rule_snapshot || '{}').cap;
  if (capRule > 0 && val > Number(capRule) + EPS) return fail(res, 400, `确认扣分 ${val} 超过该指标扣分上限 ${capRule}`);
  if (val > Number(it.suggested_score) + EPS) return fail(res, 400, `确认扣分不能高于建议扣分 ${round2(it.suggested_score)}（要加重请改规则或人工登记项）`);
  db.prepare(
    "UPDATE kpi_items SET review_status = 'confirmed', confirmed_score = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, responsibility = ? WHERE id = ?"
  ).run(round2(val), req.user.username, now(), b.note || null, b.responsibility || 'self', it.id);
  const after = recalc(it.score_id);
  return ok(res, {
    item: db.prepare('SELECT * FROM kpi_items WHERE id = ?').get(it.id),
    score: scoreView(after),
    notice: `已确认扣 ${round2(val)} 分，当前分 ${after.current_score}`
  });
}));

/** 人工登记扣分（规则之外的现场事件，仍需复核） */
router.post('/scores/:id/items', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM kpi_scores WHERE id = ?').get(req.params.id);
  if (!s) return fail(res, 404, '绩效单不存在');
  const cycle = db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(s.cycle_id);
  if (cycle && cycle.status === 'frozen') return fail(res, 400, '周期已冻结，不能新增扣分');
  const b = req.body || {};
  if (!String(b.rule_name || '').trim()) return fail(res, 400, '请填扣分事项');
  if (!String(b.evidence || '').trim()) return fail(res, 400, '扣分必须有证据说明（原型要求：无证据不计分）');
  const val = Number(b.suggested_score);
  if (!(val > 0)) return fail(res, 400, '扣分必须是正数');
  const key = b.dedupe_key || `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    const info = db.prepare(
      `INSERT INTO kpi_items (score_id, employee_id, cycle_id, rule_id, rule_name, rule_snapshot, category,
         order_id, order_no, task_desc, target_value, actual_value, evidence, evidence_url,
         suggested_score, confirmed_score, responsibility, dedupe_key, source, review_status, created_at)
       VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,0,'self',?, 'manual', 'pending', ?)`
    ).run(s.id, s.employee_id, s.cycle_id, String(b.rule_name).trim(),
      JSON.stringify({ manual: true, created_by: req.user.username }), b.category || 'site',
      b.order_id || null, b.order_no || null, b.task_desc || null,
      b.target_value === undefined ? null : Number(b.target_value),
      b.actual_value === undefined ? null : Number(b.actual_value),
      String(b.evidence).trim(), b.evidence_url || null, round2(val), key, now());
    recalc(s.id);
    return ok(res, { id: Number(info.lastInsertRowid), score: scoreView(recalc(s.id)), notice: '已登记，需主管复核后才计入' });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return fail(res, 400, '这个事件已经扣过分了（同一事件不得重复扣分）');
    throw e;
  }
}));

/** 删除未生效的扣分项（待复核 / 已驳回；已确认的要走申诉或周期回退） */
router.delete('/items/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const it = db.prepare('SELECT * FROM kpi_items WHERE id = ?').get(req.params.id);
  if (!it) return fail(res, 404, '扣分项不存在');
  if (it.review_status === 'confirmed') return fail(res, 400, '已确认的扣分不能直接删：员工可申诉，或由主管走申诉复核调整');
  db.prepare('DELETE FROM kpi_items WHERE id = ?').run(it.id);
  recalc(it.score_id);
  return ok(res, { id: it.id, score: scoreView(recalc(it.score_id)) });
}));

/** 确认整张绩效单（所有项复核完才能确认） */
router.post('/scores/:id/confirm', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM kpi_scores WHERE id = ?').get(req.params.id);
  if (!s) return fail(res, 404, '绩效单不存在');
  const cycle = db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(s.cycle_id);
  if (cycle && cycle.status === 'frozen') return fail(res, 400, '周期已冻结，分数已定版');
  const pending = db.prepare("SELECT COUNT(*) c FROM kpi_items WHERE score_id = ? AND review_status = 'pending'").get(s.id).c;
  if (pending > 0) return fail(res, 400, `还有 ${pending} 项待复核，全部复核完才能确认这张单`);
  db.prepare("UPDATE kpi_scores SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?")
    .run(req.user.username, now(), now(), s.id);
  const after = recalc(s.id);
  return ok(res, { score: scoreView(after), notice: `已确认：当前分 ${after.current_score}（基准 ${after.base_score} − 已确认扣分 ${after.confirmed_score}）` });
}));

/** 本周总览（看板） */
router.get('/board', authRequired, wrap(async (req, res) => {
  const cycle = req.query.cycle_id
    ? db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(req.query.cycle_id)
    : db.prepare('SELECT * FROM kpi_cycles ORDER BY start_date DESC LIMIT 1').get();
  if (!cycle) {
    return ok(res, {
      cycle: null, rows: [], stat: {}, pending: [], appeals: [],
      note: '还没有考核周期。先在「规则」页配置模板并批准，再生成周期'
    });
  }
  const rows = db.prepare(
    `SELECT s.*, d.name AS department_name FROM kpi_scores s
     LEFT JOIN departments d ON d.id = s.department_id
     WHERE s.cycle_id = ? ORDER BY s.current_score IS NULL, s.current_score DESC`
  ).all(cycle.id).map((s) => ({
    ...s, status_label: SCORE_STATUS[s.status] || s.status,
    current_score: s.current_score === null ? null : round2(s.current_score),
    not_final: !!s.provisional
  }));
  const pending = db.prepare(
    `SELECT i.*, s.employee_name, s.cycle_no FROM kpi_items i JOIN kpi_scores s ON s.id = i.score_id
     WHERE i.cycle_id = ? AND i.review_status = 'pending' ORDER BY i.id DESC`
  ).all(cycle.id).map((i) => ({ ...i, review_label: REVIEW_STATUS[i.review_status] }));
  const appeals = db.prepare(
    `SELECT a.*, i.rule_name FROM kpi_appeals a LEFT JOIN kpi_items i ON i.id = a.item_id
     WHERE a.cycle_id = ? ORDER BY a.id DESC`
  ).all(cycle.id).map((a) => ({
    ...a,
    decision_label: APPEAL_DECISION[a.decision] || a.decision,
    reason_type_label: REASON_TYPES[a.reason_type] || a.reason_type,
    status_label: { submitted: '待受理', accepted: '已受理', decided: '已复核', withdrawn: '已撤回' }[a.status] || a.status,
    overdue: a.status === 'submitted' && (Date.now() - new Date(a.submitted_at).getTime()) > 3 * 86400000
  }));
  return ok(res, {
    cycle: { ...cycle, status_label: cycle.status === 'frozen' ? '已冻结' : '进行中' },
    rows,
    pending,
    appeals,
    stat: {
      people: rows.length,
      avg_score: rows.length ? round2(rows.reduce((a, r) => a + (r.current_score || 0), 0) / rows.length) : null,
      pending_items: pending.length,
      open_appeals: appeals.filter((a) => a.status === 'submitted' || a.status === 'accepted').length,
      not_final: rows.filter((r) => r.not_final).length,
      template_missing: db.prepare("SELECT COUNT(*) c FROM employees WHERE status = 'active'").get().c - rows.length
    },
    note: '分数只用于绩效管理，不自动等同扣薪或劳动处分；未结申诉的单据标记为「暂定」'
  });
}));

// ============================================================
// 四、申诉与独立复核（TS-N13-14）
// ============================================================

router.get('/appeals', authRequired, wrap(async (req, res) => {
  const { status, cycle_id, employee_id } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (cycle_id) { where.push('a.cycle_id = ?'); params.push(cycle_id); }
  if (employee_id) { where.push('a.employee_id = ?'); params.push(employee_id); }
  const rows = db.prepare(
    `SELECT a.*, i.rule_name, i.suggested_score, i.confirmed_score, i.evidence AS item_evidence,
            i.reviewed_by AS item_reviewed_by
     FROM kpi_appeals a LEFT JOIN kpi_items i ON i.id = a.item_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY a.id DESC'
  ).all(...params).map((a) => ({
    ...a,
    decision_label: APPEAL_DECISION[a.decision] || a.decision,
    reason_type_label: REASON_TYPES[a.reason_type] || a.reason_type,
    status_label: { submitted: '待受理', accepted: '已受理', decided: '已复核', withdrawn: '已撤回' }[a.status] || a.status,
    overdue: a.status === 'submitted' && (Date.now() - new Date(a.submitted_at).getTime()) > 3 * 86400000,
    // 违规提示：复核人不能是原确认人
    same_reviewer: !!(a.reviewer && a.item_reviewed_by && a.reviewer === a.item_reviewed_by)
  }));
  return ok(res, {
    rows,
    stat: {
      total: rows.length,
      open: rows.filter((r) => r.status === 'submitted' || r.status === 'accepted').length,
      overdue: rows.filter((r) => r.overdue).length,
      upheld: rows.filter((r) => r.decision === 'uphold').length,
      adjusted: rows.filter((r) => r.decision === 'reduce').length,
      revoked: rows.filter((r) => r.decision === 'revoke').length
    },
    dict: { reason_types: REASON_TYPES, decisions: APPEAL_DECISION }
  });
}));

/** 提交申诉（员工本人或人事代登记） */
router.post('/appeals', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const it = db.prepare('SELECT * FROM kpi_items WHERE id = ?').get(b.item_id);
  if (!it) return fail(res, 404, '扣分项不存在');
  if (it.review_status !== 'confirmed') return fail(res, 400, '只有已确认的扣分才能申诉（建议分还没生效，不用申诉）');
  if (it.appeal_status === 'appealing') return fail(res, 400, '这一项已经在申诉中');
  if (it.appeal_status === 'upheld' || it.appeal_status === 'revoked') return fail(res, 400, '这一项的申诉已经复核过，同一事件不重复受理');
  if (it.appeal_status === 'adjusted') return fail(res, 400, '这一项已经因申诉调整过，不再重复受理');
  const reasonType = REASON_TYPES[b.reason_type] ? b.reason_type : null;
  if (!reasonType) return fail(res, 400, `请选择申诉类型：${Object.values(REASON_TYPES).join(' / ')}`);
  const reason = String(b.reason || '').trim();
  if (reason.length < 4) return fail(res, 400, '请把申诉理由写清楚（至少 4 个字）');
  const score = db.prepare('SELECT * FROM kpi_scores WHERE id = ?').get(it.score_id);
  const cycle = db.prepare('SELECT * FROM kpi_cycles WHERE id = ?').get(score.cycle_id);
  if (cycle && cycle.status === 'frozen' && !b.allow_after_freeze) {
    // 冻结后仍可申诉（保护员工），但要显式确认，防止随手改已定版数据
    return fail(res, 400, '周期已冻结。确实要申诉请带上 allow_after_freeze=true（系统会保留原记录并标争议中，不会篡改定版分数）');
  }
  const t = now();
  const appealNo = genNo('AP', nextSeq('kpi_appeals'));
  const info = db.prepare(
    `INSERT INTO kpi_appeals (appeal_no, item_id, score_id, employee_id, employee_name, cycle_id, cycle_no,
       reason_type, reason, evidence, original_score, decision, status, submitted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', 'submitted', ?)`
  ).run(appealNo, it.id, it.score_id, it.employee_id, score.employee_name,
    it.cycle_id, score.cycle_no, reasonType, reason, b.evidence || null, round2(it.confirmed_score), t);
  // 保留原记录，只标「争议中」：分数不下调也不上调，等复核
  db.prepare("UPDATE kpi_items SET appeal_status = 'appealing' WHERE id = ?").run(it.id);
  recalc(score.id);
  return ok(res, {
    id: Number(info.lastInsertRowid), appeal_no: appealNo,
    score: scoreView(recalc(score.id)),
    notice: '已受理申诉：原扣分记录保留并标记争议中，分数暂定为「暂定分」，等独立复核'
  });
}));

/** 受理（记录受理人，转独立复核） */
router.post('/appeals/:id/accept', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM kpi_appeals WHERE id = ?').get(req.params.id);
  if (!a) return fail(res, 404, '申诉不存在');
  if (a.status !== 'submitted') return fail(res, 400, `申诉状态是「${a.status}」，不能受理`);
  db.prepare("UPDATE kpi_appeals SET status = 'accepted', accepted_at = ? WHERE id = ?").run(now(), a.id);
  return ok(res, { id: a.id, status: 'accepted' });
}));

/** 独立复核：维持 / 调整 / 撤销 */
router.post('/appeals/:id/decide', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM kpi_appeals WHERE id = ?').get(req.params.id);
  if (!a) return fail(res, 404, '申诉不存在');
  if (a.status === 'decided') return fail(res, 400, '这条申诉已经复核过了');
  if (a.status === 'withdrawn') return fail(res, 400, '申诉已撤回');
  const it = db.prepare('SELECT * FROM kpi_items WHERE id = ?').get(a.item_id);
  const score = db.prepare('SELECT * FROM kpi_scores WHERE id = ?').get(it.score_id);
  const b = req.body || {};
  const decision = ['uphold', 'reduce', 'revoke'].includes(b.decision) ? b.decision : null;
  if (!decision) return fail(res, 400, '请选择复核结论：维持 / 调整 / 撤销');
  const note = String(b.note || '').trim();
  if (!note) return fail(res, 400, '复核必须写理由（记录改分前后值，便于事后追溯）');

  // 独立性：复核人不能是原扣分确认人；涉及主管本人转上一级/人事
  const reviewer = String(b.reviewer || req.user.username).trim();
  if (it.reviewed_by && reviewer === it.reviewed_by) {
    return fail(res, 400, `复核人不能是原扣分确认人（${it.reviewed_by}）。涉及主管本人或敏感事项，请转上一级/人事授权复核`);
  }

  let newScore = Number(it.confirmed_score);
  if (decision === 'uphold') newScore = Number(it.confirmed_score);
  if (decision === 'reduce') {
    newScore = b.new_score === undefined ? 0 : Number(b.new_score);
    if (!(newScore >= 0)) return fail(res, 400, '调整后的扣分不能是负数');
    if (newScore > Number(it.confirmed_score) + EPS) return fail(res, 400, '申诉复核只能调低扣分，不能加重处罚（要加重请走新的规则/事件）');
  }
  if (decision === 'revoke') newScore = 0;

  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE kpi_appeals SET decision = ?, new_score = ?, reviewer = ?, reviewer_role = ?,
         decision_note = ?, status = 'decided', decided_at = ? WHERE id = ?`
    ).run(decision, round2(newScore), reviewer, req.user.role || 'hr', note, t, a.id);
    if (decision === 'uphold') {
      db.prepare("UPDATE kpi_items SET appeal_status = 'upheld' WHERE id = ?").run(it.id);
    } else if (decision === 'reduce') {
      db.prepare("UPDATE kpi_items SET appeal_status = 'adjusted', confirmed_score = ?, review_note = ? WHERE id = ?")
        .run(round2(newScore), `申诉调整：${note}`, it.id);
    } else {
      db.prepare("UPDATE kpi_items SET appeal_status = 'revoked', confirmed_score = 0, review_status = 'rejected', review_note = ? WHERE id = ?")
        .run(`申诉撤销扣分：${note}`, it.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const after = recalc(score.id);
  return ok(res, {
    appeal: db.prepare('SELECT * FROM kpi_appeals WHERE id = ?').get(a.id),
    item: db.prepare('SELECT * FROM kpi_items WHERE id = ?').get(it.id),
    score: scoreView(after),
    notice: decision === 'uphold'
      ? `维持原判：扣 ${round2(it.confirmed_score)} 分。当前分 ${after.current_score}`
      : `${decision === 'revoke' ? '撤销' : '调整'}扣分 ${round2(it.confirmed_score)} → ${round2(newScore)}，当前分 ${after.current_score}`
  });
}));

/** 员工撤回申诉 */
router.post('/appeals/:id/withdraw', authRequired, wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM kpi_appeals WHERE id = ?').get(req.params.id);
  if (!a) return fail(res, 404, '申诉不存在');
  if (a.status === 'decided') return fail(res, 400, '已复核的申诉不能撤回');
  const it = db.prepare('SELECT * FROM kpi_items WHERE id = ?').get(a.item_id);
  db.prepare("UPDATE kpi_appeals SET status = 'withdrawn', decision_note = ? WHERE id = ?").run(req.body && req.body.note || '员工撤回', a.id);
  db.prepare("UPDATE kpi_items SET appeal_status = 'none' WHERE id = ?").run(a.item_id);
  const after = recalc(it.score_id);
  return ok(res, { score: scoreView(after), notice: '已撤回申诉，扣分保持不变' });
}));

// ============================================================
// 五、字典与统计
// ============================================================

router.get('/dict', authRequired, wrap(async (req, res) => {
  return ok(res, {
    template_status: TPL_STATUS, score_status: SCORE_STATUS, review_status: REVIEW_STATUS,
    appeal_status: APPEAL_STATUS, appeal_decision: APPEAL_DECISION, reason_types: REASON_TYPES,
    data_sources: DATA_SOURCES, categories: CATEGORIES,
    job_families: ['缝制', '裁剪', '检验', '印花', '仓储', '业务', '职能', '通用'],
    note: '指标数据源决定系统能自动生成哪类建议扣分；「订单超期」按原型标待配置，不预测、不自动扣分'
  });
}));

router.get('/summary', authRequired, wrap(async (req, res) => {
  const cycles = db.prepare('SELECT * FROM kpi_cycles ORDER BY start_date DESC LIMIT 8').all();
  const trend = cycles.slice().reverse().map((c) => {
    const agg = db.prepare(
      'SELECT COUNT(*) n, COALESCE(AVG(current_score),0) avg, COALESCE(SUM(confirmed_score),0) ded FROM kpi_scores WHERE cycle_id = ?'
    ).get(c.id);
    return {
      cycle_no: c.cycle_no, start_date: c.start_date, end_date: c.end_date,
      status: c.status, people: agg.n, avg_score: agg.n ? round2(agg.avg) : null, deductions: round2(agg.ded)
    };
  });
  const byCategory = db.prepare(
    `SELECT COALESCE(i.category,'other') category, COALESCE(SUM(i.confirmed_score),0) score, COUNT(*) c
     FROM kpi_items i WHERE i.review_status = 'confirmed' GROUP BY i.category`
  ).all().map((x) => ({ ...x, label: CATEGORIES[x.category] || x.category, score: round2(x.score) }));
  const topRules = db.prepare(
    `SELECT rule_name, COUNT(*) c, COALESCE(SUM(confirmed_score),0) score
     FROM kpi_items WHERE review_status = 'confirmed' GROUP BY rule_name ORDER BY score DESC LIMIT 6`
  ).all().map((x) => ({ ...x, score: round2(x.score) }));
  return ok(res, { trend, by_category: byCategory, top_rules: topRules });
}));

module.exports = router;
module.exports.jobFamilyOf = jobFamilyOf;
module.exports.templateFor = templateFor;
