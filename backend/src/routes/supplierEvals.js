/**
 * 供应商评价与备用产能（原型 TS-N07-05）
 * 流程：真实样本 → 评价 → 整改 / 备用验证 → 供货资格
 *
 * GET    /api/supplier-evals/board                 评价看板（含排名、样本不足不排名）
 * GET    /api/supplier-evals/board/:supplierId     单供应商明细（历史评价 + 整改 + 备用 + 资格）
 * POST   /api/supplier-evals/collect               按真实收料单生成评价 { supplier_id, period_start, period_end, price_score?, capacity_qty? }
 * POST   /api/supplier-evals/:id/recollect         同期重算样本（保留人工项）
 * PUT    /api/supplier-evals/:id                   改人工项（报价条件分 / 有效产能 / 结论 / 证据）并重算分
 * POST   /api/supplier-evals/:id/decide            按评价落供货资格 { action: keep|rectify|verify_backup|suspend, issue?, action_req?, due_date? }
 * GET    /api/supplier-evals/qualifications        当前供货资格一览
 * GET    /api/supplier-evals/rectifications        整改单列表
 * POST   /api/supplier-evals/rectifications/:id/submit  供应商/采购提交整改结果
 * POST   /api/supplier-evals/rectifications/:id/verify  验证整改（通过才可能回升资格）
 * GET    /api/supplier-evals/backups               备用产能列表
 * POST   /api/supplier-evals/backups               新增 / 更新备用产能
 * POST   /api/supplier-evals/backups/:id/verify    三项验证（技术/封样/合规）齐了才算可用
 * POST   /api/supplier-evals/backups/:id/reject    判不通过
 * GET    /api/supplier-evals/backup-pick           备用选源（**不按最低价排序**）
 *
 * 硬规则：
 * 1. 相同口径：所有供应商同一套公式，样本只来自真实收料单（GRN），不手填
 * 2. 样本不足不排名：准交分母 < MIN_SAMPLE 一律「样本不足」，不给等级、不参与排名
 * 3. 准交口径：承诺日取采购单 expect_date，实际到货取收料单 receive_date；无承诺日的样本单列，不进分母
 * 4. 备用工厂必须技术 + 封样 + 合规三项验证后才可用，**不自动选最低价**
 * 5. 有未闭环整改单的，资格不得回到「合格」
 * 6. 资格是采购下单的硬门禁：暂停的供应商不能建新采购单
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'sales', 'warehouse'];
const READ = ['admin', 'sales', 'warehouse', 'production', 'tech', 'finance'];

/** 样本不足阈值：准交分母少于这么多单，不给等级、不排名 */
const MIN_SAMPLE = 3;
const EPS = 0.005;

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const int0 = (v) => Math.round(Number(v) || 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const GRADE_LABEL = { A: 'A 优秀', B: 'B 良好', C: 'C 需改进', D: 'D 不合格', NA: '样本不足' };
const STATUS_LABEL = {
  sufficient: '样本足够',
  insufficient: '样本不足',
  improve: '需改进'
};
const QUAL_LABEL = {
  qualified: '合格供方',
  conditional: '有条件供货',
  observing: '观察期',
  suspended: '暂停新单'
};
const RECT_LABEL = {
  open: '整改中',
  submitted: '已提交待验',
  verified: '整改通过',
  failed: '整改未通过'
};
const BAK_LABEL = {
  pending: '待验证',
  verified: '可用',
  rejected: '不通过',
  expired: '已过期'
};

function dayDiff(a, b) {
  const t1 = Date.parse(String(a).slice(0, 10));
  const t2 = Date.parse(String(b).slice(0, 10));
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0;
  return Math.round((t1 - t2) / 86400000);
}

/** 按真实收料单汇总样本（同一口径，所有供应商一样） */
function samplesOf(supplierId, start, end) {
  const rows = db.prepare(
    `SELECT g.id, g.grn_no, g.receive_date, g.status,
            g.receive_qty, g.pass_qty, g.freeze_qty, g.reject_qty, g.pending_qty,
            g.short_qty, g.over_qty,
            p.expect_date, p.order_date, p.po_no
     FROM goods_receipts g
     LEFT JOIN purchase_orders p ON p.id = g.po_id
     WHERE g.supplier_id = ? AND g.status != 'cancelled'
       AND DATE(g.receive_date) >= DATE(?) AND DATE(g.receive_date) <= DATE(?)
     ORDER BY g.receive_date, g.id`
  ).all(supplierId, start, end);

  const s = {
    sample_total: 0, on_time_count: 0, late_count: 0, late_days_sum: 0, no_due_count: 0,
    recv_qty: 0, pass_qty: 0, freeze_qty: 0, reject_qty: 0, inspected_qty: 0,
    short_orders: 0, over_orders: 0,
    deliveries: []
  };
  rows.forEach((r) => {
    const recv = Number(r.receive_qty) || 0;
    s.recv_qty += recv;
    s.pass_qty += Number(r.pass_qty) || 0;
    s.freeze_qty += Number(r.freeze_qty) || 0;
    s.reject_qty += Number(r.reject_qty) || 0;
    // 已检验量 = 合格 + 冻结 + 退回；待检量不算质量样本（货还没验完，不能当不良也不能当良）
    const insp = (Number(r.pass_qty) || 0) + (Number(r.freeze_qty) || 0) + (Number(r.reject_qty) || 0);
    s.inspected_qty += insp;
    if (Number(r.short_qty) > EPS) s.short_orders += 1;
    if (Number(r.over_qty) > EPS) s.over_orders += 1;

    let late = 0;
    if (r.expect_date) {
      s.sample_total += 1;
      late = dayDiff(String(r.receive_date).slice(0, 10), String(r.expect_date).slice(0, 10));
      if (late > 0) { s.late_count += 1; s.late_days_sum += late; } else { s.on_time_count += 1; }
    } else {
      // 没设承诺日的样本不进准交分母，但列出来让人看得见（口径透明）
      s.no_due_count += 1;
    }
    s.deliveries.push({
      grn_id: r.id, grn_no: r.grn_no, po_no: r.po_no,
      receive_date: r.receive_date, expect_date: r.expect_date,
      late_days: late > 0 ? late : 0,
      receive_qty: round2(recv),
      inspected_qty: round2(insp),
      reject_qty: round2(r.reject_qty),
      freeze_qty: round2(r.freeze_qty),
      short_qty: round2(r.short_qty),
      over_qty: round2(r.over_qty),
      pending: Number(r.pending_qty) > EPS
    });
  });
  return s;
}

/** 用同一套公式算分（样本不足只算不排名） */
function computeScore(s, priceScore) {
  const onTimeRate = s.sample_total > 0 ? round2((s.on_time_count / s.sample_total) * 100) : null;
  const defectRate = s.inspected_qty > 0 ? round2(((s.freeze_qty + s.reject_qty) / s.inspected_qty) * 100) : null;
  // 质量分：不良率 0 → 100，每 1% 扣 5 分
  const qualityScore = defectRate === null ? null : round2(clamp(100 - defectRate * 5, 0, 100));
  const insufficient = s.sample_total < MIN_SAMPLE;

  let score = null;
  let grade = 'NA';
  if (!insufficient && onTimeRate !== null && qualityScore !== null) {
    const price = priceScore === null || priceScore === undefined ? 60 : Number(priceScore);
    score = round2(onTimeRate * 0.45 + qualityScore * 0.45 + price * 0.1);
    grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : 'D';
  }
  return {
    on_time_rate: onTimeRate,
    defect_rate: defectRate,
    quality_score: qualityScore,
    score,
    grade,
    status: insufficient ? 'insufficient' : grade === 'D' || grade === 'C' ? 'improve' : 'sufficient',
    insufficient,
    min_sample: MIN_SAMPLE
  };
}

function capacityOf(supplierId) {
  const rows = db.prepare("SELECT capacity_qty, used_qty FROM supplier_backups WHERE supplier_id = ? AND status = 'verified'").all(supplierId);
  if (!rows.length) return { capacity_qty: null, used_qty: null, remaining_qty: null };
  const cap = round2(rows.reduce((a, r) => a + (Number(r.capacity_qty) || 0), 0));
  const used = round2(rows.reduce((a, r) => a + (Number(r.used_qty) || 0), 0));
  return { capacity_qty: cap, used_qty: used, remaining_qty: round2(cap - used) };
}

function openRects(supplierId) {
  return db.prepare("SELECT COUNT(*) c FROM supplier_rectifications WHERE supplier_id = ? AND status IN ('open','submitted','failed')").get(supplierId).c;
}

function qualificationOf(supplierId) {
  return db.prepare('SELECT * FROM supplier_qualifications WHERE supplier_id = ?').get(supplierId) || null;
}

function setQualification(supplierId, supplierName, status, reason, evId, by) {
  const t = now();
  const exist = qualificationOf(supplierId);
  if (exist) {
    db.prepare(
      'UPDATE supplier_qualifications SET status = ?, reason = ?, based_ev_id = ?, decided_by = ?, decided_at = ?, updated_at = ?, supplier_name = ? WHERE supplier_id = ?'
    ).run(status, reason || null, evId || null, by || null, t, t, supplierName || exist.supplier_name, supplierId);
  } else {
    db.prepare(
      `INSERT INTO supplier_qualifications (supplier_id, supplier_name, status, reason, based_ev_id,
        effective_from, decided_by, decided_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(supplierId, supplierName || null, status, reason || null, evId || null, t.slice(0, 10), by || null, t, t);
  }
  return qualificationOf(supplierId);
}

function scorePrice(ev) {
  return ev.price_score === null || ev.price_score === undefined ? null : Number(ev.price_score);
}

function view(ev) {
  if (!ev) return null;
  const cap = {
    capacity_qty: ev.capacity_qty,
    used_qty: ev.used_qty,
    remaining_qty: ev.remaining_qty
  };
  return {
    ...ev,
    grade_label: GRADE_LABEL[ev.grade] || ev.grade,
    status_label: STATUS_LABEL[ev.status] || ev.status,
    late_avg_days: ev.late_count > 0 ? round2(ev.late_days_sum / ev.late_count) : null,
    capacity_qty: cap.capacity_qty,
    remaining_qty: cap.remaining_qty
  };
}

// ---------------- 看板 ----------------
router.get('/board', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { q = '', period_start = '', period_end = '', only = '' } = req.query;
  const where = ["s.status = 'active'"];
  const params = [];
  if (q) { where.push('(s.name LIKE ? OR s.code LIKE ? OR s.short_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const sups = db.prepare(`SELECT s.* FROM suppliers s WHERE ${where.join(' AND ')} ORDER BY s.id`).all(...params);

  const rows = sups.map((s) => {
    // 最新一期评价作为当前评价
    let ev;
    if (period_start && period_end) {
      ev = db.prepare('SELECT * FROM supplier_evaluations WHERE supplier_id = ? AND period_start = ? AND period_end = ?').get(s.id, period_start, period_end);
    }
    if (!ev) {
      ev = db.prepare('SELECT * FROM supplier_evaluations WHERE supplier_id = ? ORDER BY period_end DESC, id DESC').get(s.id);
    }
    const qual = qualificationOf(s.id);
    const rects = openRects(s.id);
    return {
      supplier_id: s.id,
      code: s.code,
      name: s.name,
      short_name: s.short_name,
      category: s.category,
      contact: s.contact,
      phone: s.phone,
      lead_days: s.lead_days,
      ev: view(ev),
      qualification: qual ? { ...qual, status_label: QUAL_LABEL[qual.status] || qual.status } : null,
      open_rects: rects
    };
  });

  // 排名：只有「样本足够」的参与，样本不足的给 null（原型：样本不足不排名）
  const rankable = rows.filter((r) => r.ev && r.ev.status !== 'insufficient' && r.ev.score !== null)
    .sort((a, b) => b.ev.score - a.ev.score);
  rankable.forEach((r, i) => { r.rank = i + 1; });
  rows.forEach((r) => { if (r.rank === undefined) r.rank = null; });

  // 展示顺序：有排名的按名次在前，样本不足 / 未评价的排后面
  const ordered = rows.slice().sort((a, b) => {
    const ra = a.rank === null ? 9999 : a.rank;
    const rb = b.rank === null ? 9999 : b.rank;
    if (ra !== rb) return ra - rb;
    return a.supplier_id - b.supplier_id;
  });

  const filtered = only === 'insufficient' ? ordered.filter((r) => !r.ev || r.ev.status === 'insufficient')
    : only === 'improve' ? ordered.filter((r) => r.ev && r.ev.status === 'improve')
      : only === 'ranked' ? rankable
        : ordered;

  const stat = {
    suppliers: rows.length,
    ranked: rankable.length,
    insufficient: rows.filter((r) => !r.ev || r.ev.status === 'insufficient').length,
    improve: rows.filter((r) => r.ev && r.ev.status === 'improve').length,
    suspended: rows.filter((r) => r.qualification && r.qualification.status === 'suspended').length,
    open_rects: rows.reduce((a, r) => a + r.open_rects, 0),
    backups_verified: db.prepare("SELECT COUNT(*) c FROM supplier_backups WHERE status = 'verified'").get().c,
    backups_pending: db.prepare("SELECT COUNT(*) c FROM supplier_backups WHERE status = 'pending'").get().c
  };

  return ok(res, {
    rows: filtered,
    stat,
    min_sample: MIN_SAMPLE,
    rule: '同一套公式：准交率 45% + 质量分 45% + 报价条件 10%；准交分母不足 ' + MIN_SAMPLE + ' 单不给等级、不排名'
  });
}));

// ---------------- 供应商明细 ----------------
router.get('/board/:supplierId', authRequired, requireRole(READ), wrap(async (req, res) => {
  const sid = Number(req.params.supplierId);
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(sid);
  if (!s) return fail(res, 404, '供应商不存在');
  const evs = db.prepare('SELECT * FROM supplier_evaluations WHERE supplier_id = ? ORDER BY period_end DESC, id DESC').all(sid).map(view);
  const qual = qualificationOf(sid);
  // 最新一期的交付样本明细（口径与评价一致）
  const latest = evs[0];
  const lastSamples = latest ? samplesOf(sid, latest.period_start, latest.period_end).deliveries : [];
  return ok(res, {
    last_samples: lastSamples,
    supplier: s,
    evaluations: evs,
    qualification: qual ? { ...qual, status_label: QUAL_LABEL[qual.status] || qual.status } : null,
    rectifications: db.prepare('SELECT * FROM supplier_rectifications WHERE supplier_id = ? ORDER BY id DESC').all(sid)
      .map((r) => ({ ...r, status_label: RECT_LABEL[r.status] || r.status })),
    backups: db.prepare('SELECT * FROM supplier_backups WHERE supplier_id = ? ORDER BY id DESC').all(sid)
      .map((b) => ({ ...b, status_label: BAK_LABEL[b.status] || b.status, remaining_qty: b.capacity_qty === null ? null : round2((Number(b.capacity_qty) || 0) - (Number(b.used_qty) || 0)) })),
    min_sample: MIN_SAMPLE
  });
}));

// ---------------- 生成评价（样本自动汇总） ----------------
router.post('/collect', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const sid = Number(b.supplier_id);
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(sid);
  if (!s) return fail(res, 404, '供应商不存在');
  const start = String(b.period_start || '').slice(0, 10);
  const end = String(b.period_end || '').slice(0, 10);
  if (!start || !end) return fail(res, 400, '请填观察期起止日期');
  if (start > end) return fail(res, 400, '观察期起始不能晚于结束');

  const dup = db.prepare('SELECT * FROM supplier_evaluations WHERE supplier_id = ? AND period_start = ? AND period_end = ?').get(sid, start, end);
  if (dup) {
    return fail(res, 400, `这家供应商在 ${start} ~ ${end} 已经有评价（${dup.ev_no}）。要按最新收料数据重算请点「同期重算」`);
  }

  const samePeriod = db.prepare('SELECT ev_no, period_start, period_end FROM supplier_evaluations WHERE supplier_id = ? AND period_start < ? AND period_end > ?').get(sid, end, start);
  if (samePeriod) {
    return fail(res, 400, `观察期与已有评价 ${samePeriod.ev_no}（${samePeriod.period_start} ~ ${samePeriod.period_end}）重叠，同一段样本不能评两次`);
  }

  const sm = samplesOf(sid, start, end);
  if (sm.sample_total === 0 && sm.no_due_count === 0) {
    return fail(res, 400, '这个观察期内没有这家供应商的收料记录，没有样本不能评价');
  }
  const priceScore = b.price_score === undefined || b.price_score === null || b.price_score === '' ? null : clamp(Number(b.price_score), 0, 100);
  const calc = computeScore(sm, priceScore);
  const capIn = b.capacity_qty === undefined || b.capacity_qty === null || b.capacity_qty === '' ? null : round2(b.capacity_qty);
  const capFromBak = capacityOf(sid);
  const capacity = capIn === null ? capFromBak.capacity_qty : capIn;
  const used = capFromBak.used_qty;
  const remaining = capacity === null ? null : round2(capacity - (used || 0));

  const t = now();
  const ymd = t.slice(0, 10).replace(/-/g, '');
  const seq = Number(db.prepare('SELECT COUNT(*) c FROM supplier_evaluations WHERE ev_no LIKE ?').get(`SE${ymd}%`).c) + 1;
  const evNo = `SE${ymd}${String(seq).padStart(4, '0')}`;

  const info = db.prepare(
    `INSERT INTO supplier_evaluations (ev_no, supplier_id, supplier_name, period_start, period_end,
      sample_total, on_time_count, late_count, late_days_sum, no_due_count,
      recv_qty, pass_qty, freeze_qty, reject_qty, inspected_qty, short_orders, over_orders,
      on_time_rate, defect_rate, quality_score, price_score, score, grade,
      capacity_qty, used_qty, remaining_qty, status, conclusion, evidence, evaluated_by, evaluated_at, created_at)
     VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)`
  ).run(
    evNo, sid, s.name, start, end,
    sm.sample_total, sm.on_time_count, sm.late_count, sm.late_days_sum, sm.no_due_count,
    round2(sm.recv_qty), round2(sm.pass_qty), round2(sm.freeze_qty), round2(sm.reject_qty), round2(sm.inspected_qty),
    sm.short_orders, sm.over_orders,
    calc.on_time_rate, calc.defect_rate, calc.quality_score, priceScore, calc.score, calc.grade,
    capacity, used, remaining, calc.status,
    b.conclusion || null, b.evidence || null, req.user.username, t, t
  );

  const ev = view(db.prepare('SELECT * FROM supplier_evaluations WHERE id = ?').get(Number(info.lastInsertRowid)));
  return ok(res, {
    evaluation: ev,
    samples: sm.deliveries,
    warnings: calc.insufficient ? [`准交分母只有 ${sm.sample_total} 单（要求 ${MIN_SAMPLE} 单），本次只出数据不给等级、不参与排名`] : []
  });
}));

/** 同期重算：样本重算，人工项（报价条件分 / 有效产能 / 结论 / 证据）保留 */
router.post('/:id/recollect', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const ev = db.prepare('SELECT * FROM supplier_evaluations WHERE id = ?').get(req.params.id);
  if (!ev) return fail(res, 404, '评价不存在');
  const sm = samplesOf(ev.supplier_id, ev.period_start, ev.period_end);
  const calc = computeScore(sm, scorePrice(ev));
  const capFromBak = capacityOf(ev.supplier_id);
  const capacity = ev.capacity_qty !== null ? ev.capacity_qty : capFromBak.capacity_qty;
  const remaining = capacity === null ? null : round2(capacity - (capFromBak.used_qty || 0));

  db.prepare(
    `UPDATE supplier_evaluations SET sample_total=?, on_time_count=?, late_count=?, late_days_sum=?, no_due_count=?,
      recv_qty=?, pass_qty=?, freeze_qty=?, reject_qty=?, inspected_qty=?, short_orders=?, over_orders=?,
      on_time_rate=?, defect_rate=?, quality_score=?, score=?, grade=?, capacity_qty=?, used_qty=?, remaining_qty=?, status=?
     WHERE id=?`
  ).run(
    sm.sample_total, sm.on_time_count, sm.late_count, sm.late_days_sum, sm.no_due_count,
    round2(sm.recv_qty), round2(sm.pass_qty), round2(sm.freeze_qty), round2(sm.reject_qty), round2(sm.inspected_qty),
    sm.short_orders, sm.over_orders,
    calc.on_time_rate, calc.defect_rate, calc.quality_score, calc.score, calc.grade,
    capacity, capFromBak.used_qty, remaining, calc.status, ev.id
  );
  return ok(res, { evaluation: view(db.prepare('SELECT * FROM supplier_evaluations WHERE id = ?').get(ev.id)), samples: sm.deliveries });
}));

/** 改人工项并重算分 */
router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const ev = db.prepare('SELECT * FROM supplier_evaluations WHERE id = ?').get(req.params.id);
  if (!ev) return fail(res, 404, '评价不存在');
  const b = req.body || {};
  if (db.prepare('SELECT 1 AS x FROM supplier_rectifications WHERE ev_id = ?').get(ev.id) && ev.status === 'improve' && b.price_score === undefined) {
    // 已进入整改的评价仍可补证据与结论，只是不再改分
  }
  const priceScore = b.price_score === undefined ? ev.price_score
    : (b.price_score === null || b.price_score === '' ? null : clamp(Number(b.price_score), 0, 100));
  const capacity = b.capacity_qty === undefined ? ev.capacity_qty
    : (b.capacity_qty === null || b.capacity_qty === '' ? null : round2(b.capacity_qty));

  const sm = {
    sample_total: ev.sample_total, on_time_count: ev.on_time_count, late_count: ev.late_count,
    freeze_qty: ev.freeze_qty, reject_qty: ev.reject_qty, inspected_qty: ev.inspected_qty
  };
  const calc = computeScore(sm, priceScore);
  const remaining = capacity === null ? null : round2(capacity - (Number(ev.used_qty) || 0));

  db.prepare(
    'UPDATE supplier_evaluations SET price_score=?, capacity_qty=?, remaining_qty=?, on_time_rate=?, defect_rate=?, quality_score=?, score=?, grade=?, status=?, conclusion=?, evidence=? WHERE id=?'
  ).run(
    priceScore, capacity, remaining, calc.on_time_rate, calc.defect_rate, calc.quality_score,
    calc.score, calc.grade, calc.status,
    b.conclusion !== undefined ? b.conclusion : ev.conclusion,
    b.evidence !== undefined ? b.evidence : ev.evidence,
    ev.id
  );
  return ok(res, view(db.prepare('SELECT * FROM supplier_evaluations WHERE id = ?').get(ev.id)));
}));

/** 按评价落供货资格：keep / rectify / verify_backup / suspend */
router.post('/:id/decide', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const ev = db.prepare('SELECT * FROM supplier_evaluations WHERE id = ?').get(req.params.id);
  if (!ev) return fail(res, 404, '评价不存在');
  const b = req.body || {};
  const action = String(b.action || '').trim();
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(ev.supplier_id);
  if (!supplier) return fail(res, 404, '供应商档案不存在');
  const opens = openRects(ev.supplier_id);

  if (action === 'keep') {
    if (ev.status === 'insufficient') return fail(res, 400, `准交分母只有 ${ev.sample_total} 单（要求 ${MIN_SAMPLE} 单），样本不足不能判维持合格`);
    if (!['A', 'B'].includes(ev.grade)) return fail(res, 400, `当前等级 ${ev.grade}（${GRADE_LABEL[ev.grade]}），不能判「维持合格」。C 级要整改，D 级要暂停新单`);
    if (opens > 0) return fail(res, 400, `这家供应商还有 ${opens} 张整改单没闭环，闭环前不能回到合格`);
    const q = setQualification(ev.supplier_id, supplier.name, 'qualified', `依据 ${ev.ev_no}（${ev.grade} 级，${ev.score} 分）维持合格供方`, ev.id, req.user.username);
    return ok(res, { qualification: { ...q, status_label: QUAL_LABEL[q.status] } });
  }

  if (action === 'rectify' || action === 'suspend') {
    // 同一期评价不重复开整改单：已开过的去那张单上提交 / 验证
    const exists = db.prepare(
      "SELECT rect_no FROM supplier_rectifications WHERE ev_id = ? AND status IN ('open','submitted') ORDER BY id DESC LIMIT 1"
    ).get(ev.id);
    if (exists) {
      return fail(res, 400, `这期评价已经开过整改单 ${exists.rect_no}（还没闭环）。请在整改单上提交与验证，不要重复开单`);
    }
    const closed = db.prepare(
      "SELECT rect_no FROM supplier_rectifications WHERE ev_id = ? AND status = 'verified' ORDER BY id DESC LIMIT 1"
    ).get(ev.id);
    if (closed) {
      return fail(res, 400, `这期评价的整改 ${closed.rect_no} 已经验证通过。要再整改请做一次新的评价（换观察期），不要在同一期上反复开单`);
    }
    const issue = String(b.issue || '').trim();
    const actionReq = String(b.action_req || '').trim();
    if (!issue) return fail(res, 400, '请写明问题（准交不达标 / 不良超标 / 短收未补齐 …）');
    if (!actionReq) return fail(res, 400, '请写明整改要求（怎么改、改到什么程度）');
    const t = now();
    const ymd = t.slice(0, 10).replace(/-/g, '');
    const seq = Number(db.prepare('SELECT COUNT(*) c FROM supplier_rectifications WHERE rect_no LIKE ?').get(`ZG${ymd}%`).c) + 1;
    const rectNo = `ZG${ymd}${String(seq).padStart(4, '0')}`;
    db.prepare(
      `INSERT INTO supplier_rectifications (rect_no, ev_id, supplier_id, supplier_name, issue, action, due_date, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'open', ?, ?, ?)`
    ).run(rectNo, ev.id, ev.supplier_id, supplier.name, issue, actionReq, b.due_date || null, req.user.username, t, t);

    const qStatus = action === 'suspend' ? 'suspended' : 'conditional';
    const q = setQualification(ev.supplier_id, supplier.name, qStatus,
      action === 'suspend' ? `依据 ${ev.ev_no}（${ev.grade} 级）暂停新单，整改单 ${rectNo}` : `依据 ${ev.ev_no} 有条件供货，整改单 ${rectNo}`,
      ev.id, req.user.username);
    return ok(res, { rect_no: rectNo, qualification: { ...q, status_label: QUAL_LABEL[q.status] } });
  }

  if (action === 'verify_backup') {
    const q = setQualification(ev.supplier_id, supplier.name, 'observing', `依据 ${ev.ev_no} 转备用验证：需技术 + 封样 + 合规三项都过才可用`, ev.id, req.user.username);
    return ok(res, { qualification: { ...q, status_label: QUAL_LABEL[q.status] }, notice: '已转观察期：请到「备用产能」登记并完成三项验证' });
  }

  return fail(res, 400, 'action 只能是 keep / rectify / verify_backup / suspend');
}));

// ---------------- 供货资格一览 ----------------
router.get('/qualifications', authRequired, requireRole(READ), wrap(async (req, res) => {
  const rows = db.prepare(
    `SELECT q.*, s.code, s.category, s.lead_days,
            (SELECT COUNT(*) FROM supplier_rectifications r WHERE r.supplier_id = q.supplier_id AND r.status IN ('open','submitted','failed')) AS open_rects
     FROM supplier_qualifications q LEFT JOIN suppliers s ON s.id = q.supplier_id
     ORDER BY CASE q.status WHEN 'suspended' THEN 0 WHEN 'conditional' THEN 1 WHEN 'observing' THEN 2 ELSE 3 END, q.supplier_id`
  ).all();
  return ok(res, rows.map((r) => ({ ...r, status_label: QUAL_LABEL[r.status] || r.status })));
}));

// ---------------- 整改 ----------------
router.get('/rectifications', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { status = '', supplier_id = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (supplier_id) { where.push('supplier_id = ?'); params.push(supplier_id); }
  const rows = db.prepare(
    'SELECT * FROM supplier_rectifications ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY id DESC'
  ).all(...params);
  return ok(res, rows.map((r) => ({
    ...r,
    status_label: RECT_LABEL[r.status] || r.status,
    overdue: r.status !== 'verified' && r.due_date && r.due_date < now().slice(0, 10)
  })));
}));

router.post('/rectifications/:id/submit', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM supplier_rectifications WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '整改单不存在');
  if (r.status === 'verified') return fail(res, 400, '这张整改单已经验证通过了');
  const note = String((req.body || {}).submit_note || '').trim();
  if (!note) return fail(res, 400, '请写明整改了什么（改了工艺 / 换了纱线 / 加了巡检 …）');
  db.prepare("UPDATE supplier_rectifications SET status='submitted', submit_note=?, submitted_at=?, updated_at=? WHERE id=?")
    .run(note, now(), now(), r.id);
  return ok(res, { ...db.prepare('SELECT * FROM supplier_rectifications WHERE id = ?').get(r.id), status_label: '已提交待验' });
}));

router.post('/rectifications/:id/verify', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM supplier_rectifications WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '整改单不存在');
  if (r.status === 'verified') return fail(res, 400, '已经验证过了');
  const b = req.body || {};
  const pass = b.pass === true || b.pass === 1 || b.pass === '1';
  const note = String(b.note || '').trim();
  if (!note) return fail(res, 400, '请写明验证依据（抽检数据 / 交期记录 / 现场看的结果）');
  const t = now();
  db.prepare("UPDATE supplier_rectifications SET status=?, verify_note=?, verified_by=?, verified_at=?, updated_at=? WHERE id=?")
    .run(pass ? 'verified' : 'failed', note, req.user.username, t, t, r.id);

  let qual = qualificationOf(r.supplier_id);
  if (pass) {
    // 整改通过：还有别的未闭环 → 仍有条件；全闭环 + 最近评价不低于 C → 回到合格
    const stillOpen = openRects(r.supplier_id);
    const lastEv = db.prepare('SELECT * FROM supplier_evaluations WHERE supplier_id = ? ORDER BY period_end DESC, id DESC').get(r.supplier_id);
    if (stillOpen === 0) {
      const good = lastEv && lastEv.status !== 'insufficient' && ['A', 'B'].includes(lastEv.grade);
      qual = setQualification(r.supplier_id, r.supplier_name, good ? 'qualified' : 'conditional',
        good ? `整改 ${r.rect_no} 验证通过，恢复合格供方` : `整改 ${r.rect_no} 验证通过，但最近评价未达合格线，维持有条件供货`,
        lastEv ? lastEv.id : null, req.user.username);
    }
  } else {
    qual = setQualification(r.supplier_id, r.supplier_name, 'suspended', `整改 ${r.rect_no} 验证未通过，暂停新单`, r.ev_id, req.user.username);
  }
  return ok(res, {
    rectification: { ...db.prepare('SELECT * FROM supplier_rectifications WHERE id = ?').get(r.id), status_label: RECT_LABEL[pass ? 'verified' : 'failed'] },
    qualification: qual ? { ...qual, status_label: QUAL_LABEL[qual.status] } : null
  });
}));

// ---------------- 备用产能 ----------------
router.get('/backups', authRequired, requireRole(READ), wrap(async (req, res) => {
  const { status = '', scope = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('b.status = ?'); params.push(status); }
  if (scope) { where.push('(b.scope LIKE ? OR b.item_desc LIKE ?)'); params.push(`%${scope}%`, `%${scope}%`); }
  const rows = db.prepare(
    `SELECT b.*, s.code, s.name AS supplier_name, s.lead_days
     FROM supplier_backups b LEFT JOIN suppliers s ON s.id = b.supplier_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    "ORDER BY CASE b.status WHEN 'verified' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, b.id DESC"
  ).all(...params);
  return ok(res, rows.map((b) => ({
    ...b,
    status_label: BAK_LABEL[b.status] || b.status,
    remaining_qty: b.capacity_qty === null ? null : round2((Number(b.capacity_qty) || 0) - (Number(b.used_qty) || 0)),
    missing: [
      !Number(b.tech_ok) ? '技术验证' : null,
      !Number(b.sample_ok) ? '封样验证' : null,
      !Number(b.compliance_ok) ? '合规验证' : null
    ].filter(Boolean)
  })));
}));

router.post('/backups', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const sid = Number(b.supplier_id);
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(sid);
  if (!s) return fail(res, 404, '供应商不存在');
  if (!String(b.scope || '').trim()) return fail(res, 400, '请填适用范围（面料 / 辅料 / 成衣加工 / 水洗印花）');
  const t = now();
  const cap = b.capacity_qty === undefined || b.capacity_qty === null || b.capacity_qty === '' ? null : round2(b.capacity_qty);
  let id = Number(b.id) || 0;
  if (id) {
    const old = db.prepare('SELECT * FROM supplier_backups WHERE id = ?').get(id);
    if (!old) return fail(res, 404, '备用产能记录不存在');
    if (old.status === 'verified') return fail(res, 400, '已可用的备用产能不能直接改，请先判不通过再重新登记');
    db.prepare(
      'UPDATE supplier_backups SET supplier_id=?, supplier_name=?, scope=?, item_desc=?, capacity_qty=?, used_qty=?, price_ref=?, lead_days=?, evidence=?, verify_note=?, updated_at=? WHERE id=?'
    ).run(sid, s.name, b.scope, b.item_desc || null, cap,
      b.used_qty === undefined || b.used_qty === null || b.used_qty === '' ? old.used_qty : round2(b.used_qty),
      b.price_ref === undefined || b.price_ref === '' || b.price_ref === null ? null : round2(b.price_ref),
      b.lead_days === undefined || b.lead_days === '' || b.lead_days === null ? null : int0(b.lead_days),
      b.evidence !== undefined ? b.evidence : old.evidence,
      b.verify_note !== undefined ? b.verify_note : old.verify_note, t, id);
  } else {
    const info = db.prepare(
      `INSERT INTO supplier_backups (supplier_id, supplier_name, scope, item_desc, capacity_qty, used_qty,
        price_ref, lead_days, evidence, verify_note, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, ?)`
    ).run(sid, s.name, b.scope, b.item_desc || null, cap, round2(b.used_qty), 
      b.price_ref === undefined || b.price_ref === '' || b.price_ref === null ? null : round2(b.price_ref),
      b.lead_days === undefined || b.lead_days === '' || b.lead_days === null ? null : int0(b.lead_days),
      b.evidence || null, b.verify_note || null, req.user.username, t, t);
    id = Number(info.lastInsertRowid);
  }
  const row = db.prepare('SELECT * FROM supplier_backups WHERE id = ?').get(id);
  return ok(res, { ...row, status_label: BAK_LABEL[row.status] });
}));

router.post('/backups/:id/verify', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM supplier_backups WHERE id = ?').get(req.params.id);
  if (!b) return fail(res, 404, '备用产能记录不存在');
  const body = req.body || {};
  const tech = body.tech_ok === undefined ? Number(b.tech_ok) : (body.tech_ok ? 1 : 0);
  const sample = body.sample_ok === undefined ? Number(b.sample_ok) : (body.sample_ok ? 1 : 0);
  const comp = body.compliance_ok === undefined ? Number(b.compliance_ok) : (body.compliance_ok ? 1 : 0);
  const missing = [!tech ? '技术验证' : null, !sample ? '封样验证' : null, !comp ? '合规验证' : null].filter(Boolean);
  if (missing.length) {
    return fail(res, 400, `还缺 ${missing.join('、')}。备用工厂必须三项验证都过才可用，缺一项就不能下单给它`);
  }
  const t = now();
  db.prepare("UPDATE supplier_backups SET tech_ok=?, sample_ok=?, compliance_ok=?, status='verified', verify_note=?, evidence=?, verified_by=?, verified_at=?, updated_at=? WHERE id=?")
    .run(tech, sample, comp, body.verify_note !== undefined ? body.verify_note : b.verify_note,
      body.evidence !== undefined ? body.evidence : b.evidence, req.user.username, t, t, b.id);
  const row = db.prepare('SELECT * FROM supplier_backups WHERE id = ?').get(b.id);
  return ok(res, { ...row, status_label: '可用', remaining_qty: round2((Number(row.capacity_qty) || 0) - (Number(row.used_qty) || 0)) });
}));

router.post('/backups/:id/reject', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM supplier_backups WHERE id = ?').get(req.params.id);
  if (!b) return fail(res, 404, '备用产能记录不存在');
  const note = String((req.body || {}).verify_note || '').trim();
  if (!note) return fail(res, 400, '请写明不通过的原因（做不出来 / 封样不对 / 资质不全 …）');
  db.prepare("UPDATE supplier_backups SET status='rejected', verify_note=?, verified_by=?, verified_at=?, updated_at=? WHERE id=?")
    .run(note, req.user.username, now(), now(), b.id);
  return ok(res, { id: b.id, status: 'rejected', status_label: '不通过' });
}));

/**
 * 备用选源：**不按最低价排序**
 * 排序键 = 综合分 desc → 剩余负荷 desc；价格只展示、不参与排序。
 */
router.get('/backup-pick', authRequired, requireRole(READ), wrap(async (req, res) => {
  const needQty = Number(req.query.qty) || 0;
  const scope = String(req.query.scope || '').trim();

  const rows = db.prepare("SELECT * FROM supplier_backups WHERE status = 'verified'").all()
    .map((b) => {
      const ev = db.prepare('SELECT * FROM supplier_evaluations WHERE supplier_id = ? ORDER BY period_end DESC, id DESC').get(b.supplier_id);
      const remaining = round2((Number(b.capacity_qty) || 0) - (Number(b.used_qty) || 0));
      return {
        ...b,
        status_label: '可用',
        remaining_qty: remaining,
        score: ev ? ev.score : null,
        grade: ev ? ev.grade : 'NA',
        grade_label: GRADE_LABEL[ev ? ev.grade : 'NA'],
        on_time_rate: ev ? ev.on_time_rate : null
      };
    })
    .filter((b) => (scope ? `${b.scope || ''}${b.item_desc || ''}`.includes(scope) : true))
    .sort((a, b) => {
      // 样本不足的排在有分的之后；再按剩余负荷
      const sa = a.score === null ? -1 : a.score;
      const sb = b.score === null ? -1 : b.score;
      if (sb !== sa) return sb - sa;
      return (b.remaining_qty || 0) - (a.remaining_qty || 0);
    });

  const ableToCover = needQty > 0 ? rows.filter((b) => b.remaining_qty >= needQty) : rows;
  return ok(res, {
    rows,
    can_cover: ableToCover.map((b) => b.id),
    need_qty: needQty,
    sort_note: '按综合分 → 剩余负荷排序，**不按最低价**：报价低的供应商如果准交和质量不行，不应因为便宜就选它',
    price_note: 'price_ref 只作参考价展示，不参与排序'
  });
}));

/** 采购下单门禁（供 purchases.js 调用） */
function qualificationGate(supplierId) {
  if (!supplierId) return { ok: true, status: 'unknown', reason: null };
  const q = qualificationOf(supplierId);
  if (!q) {
    return { ok: true, status: 'unrated', reason: '这家供应商还没有评价记录，建议先做一次评价再放量下单' };
  }
  if (q.status === 'suspended') {
    return { ok: false, status: q.status, reason: `供应商资格为「暂停新单」：${q.reason || '见整改单'}` };
  }
  if (q.status === 'conditional') {
    return { ok: true, status: q.status, reason: `有条件下单：${q.reason || ''}` };
  }
  if (q.status === 'observing') {
    return { ok: true, status: q.status, reason: '观察期供应商：可下单，但不要一次压满产能' };
  }
  return { ok: true, status: q.status, reason: null };
}

module.exports = router;
module.exports.qualificationGate = qualificationGate;
module.exports.qualificationOf = qualificationOf;
module.exports.MIN_SAMPLE = MIN_SAMPLE;
module.exports.QUAL_LABEL = QUAL_LABEL;
