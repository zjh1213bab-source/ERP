/**
 * 现货经营总览 + 备货补货与停补提案（M19）
 * ============================================================
 * 权限：
 *   读 —— 全部业务角色（销售要看到哪款快断了）
 *   写 —— admin / sales / warehouse（生成提案、下发、决策）
 *   策略 —— admin / sales（备货天数、起订量这类口径由销售把口）
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const S = require('../services/spotops');

const router = express.Router();
const READ = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const WRITE = ['admin', 'sales', 'warehouse'];
const POLICY = ['admin', 'sales'];

function guard(fn) {
  return (req, res) => {
    try {
      ok(res, fn(req));
    } catch (e) {
      const code = e.code && Number.isInteger(e.code) ? e.code : 400;
      if (e.payload) return res.status(code).json({ ok: false, message: e.message, data: e.payload });
      return fail(res, code, e.message);
    }
  };
}
const opName = (req) => (req.user && (req.user.name || req.user.username)) || String((req.user && (req.user.id || req.user.sub)) || 'system');

router.get('/dict', authRequired, requireRole(...READ), (req, res) => ok(res, S.dict()));

/** ==================== 现货经营总览 ==================== */
router.get('/overview', authRequired, requireRole(...READ), (req, res) => {
  const warehouse = String(req.query.warehouse || 'us');
  const windowDays = Math.min(365, Math.max(7, Number(req.query.window_days) || 60));
  return ok(res, S.styleOverview({ warehouse, windowDays }));
});

/** 明细：逐 SKU 快照 + 建议（不落库，供下钻） */
router.get('/skus', authRequired, requireRole(...READ), (req, res) => {
  const warehouse = String(req.query.warehouse || 'us');
  const windowDays = Math.min(365, Math.max(7, Number(req.query.window_days) || 60));
  const snap = S.snapshot({ warehouse, windowDays });
  const rows = S.markSizeBroken(snap.rows);
  const lines = S.advise(rows, warehouse);
  const styleNo = String(req.query.style_no || '').trim();
  const filtered = styleNo ? lines.filter((l) => l.style_no === styleNo) : lines;
  return ok(res, {
    as_of: snap.asOf, window_days: windowDays, warehouse,
    rows: filtered.map((l) => ({
      ...l,
      policy_scope: l.policy ? l.policy.scope : 'default'
    }))
  });
});

/** ==================== 备货策略 ==================== */
router.get('/policies', authRequired, requireRole(...READ), (req, res) => {
  const warehouse = String(req.query.warehouse || 'us');
  return ok(res, { rows: S.listPolicies(warehouse), defaults: S.DEFAULT_POLICY });
});

router.post('/policies', authRequired, requireRole(...POLICY), guard((req) => {
  const b = req.body || {};
  const warehouse = String(b.warehouse || 'us');
  const scope = ['global', 'category', 'style'].includes(b.scope) ? b.scope : 'global';
  const styleNo = scope === 'style' ? String(b.style_no || '').trim() : '';
  const category = scope === 'category' ? String(b.category || '').trim() : '';
  if (scope === 'style' && !styleNo) throw new Error('按款配置必须填款号');
  if (scope === 'category' && !category) throw new Error('按类目配置必须填类目');
  const nums = {
    target_cover_days: b.target_cover_days === undefined ? 60 : Number(b.target_cover_days),
    safety_days: b.safety_days === undefined ? 15 : Number(b.safety_days),
    lead_time_days: b.lead_time_days === undefined ? 45 : Number(b.lead_time_days),
    min_order_qty: b.min_order_qty === undefined ? 100 : Number(b.min_order_qty),
    lot_size: b.lot_size === undefined ? 50 : Number(b.lot_size),
    stop_cover_days: b.stop_cover_days === undefined ? 120 : Number(b.stop_cover_days),
    stop_age_days: b.stop_age_days === undefined ? 90 : Number(b.stop_age_days),
    dead_days: b.dead_days === undefined ? 30 : Number(b.dead_days),
    min_sample_days: b.min_sample_days === undefined ? 5 : Number(b.min_sample_days)
  };
  Object.entries(nums).forEach(([k, v]) => {
    if (!Number.isFinite(v) || v < 0) throw new Error(`${k} 必须是不小于 0 的数字`);
  });
  if (nums.target_cover_days <= 0) throw new Error('目标覆盖天数必须大于 0');
  if (nums.lead_time_days <= 0) throw new Error('生产周期必须大于 0（下单到可售）');
  if (nums.lot_size <= 0) throw new Error('补货批量倍数必须大于 0');
  if (nums.min_sample_days < 1) throw new Error('最小样本天数至少 1 天');

  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO spot_policies
      (company_id, warehouse, scope, style_no, category, target_cover_days, safety_days, lead_time_days,
       min_order_qty, lot_size, stop_cover_days, stop_age_days, dead_days, min_sample_days,
       status, note, updated_by, created_at, updated_at)
     VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(company_id, warehouse, scope, style_no, category) DO UPDATE SET
       target_cover_days=excluded.target_cover_days, safety_days=excluded.safety_days,
       lead_time_days=excluded.lead_time_days, min_order_qty=excluded.min_order_qty,
       lot_size=excluded.lot_size, stop_cover_days=excluded.stop_cover_days,
       stop_age_days=excluded.stop_age_days, dead_days=excluded.dead_days,
       min_sample_days=excluded.min_sample_days, status=excluded.status, note=excluded.note,
       updated_by=excluded.updated_by, updated_at=excluded.updated_at`
  ).run(
    warehouse, scope, styleNo, category, nums.target_cover_days, nums.safety_days, nums.lead_time_days,
    nums.min_order_qty, nums.lot_size, nums.stop_cover_days, nums.stop_age_days, nums.dead_days,
    nums.min_sample_days, b.status === 'disabled' ? 'disabled' : 'active', b.note || null,
    opName(req), ts, ts
  );
  const row = db.prepare(
    'SELECT * FROM spot_policies WHERE company_id=1 AND warehouse=? AND scope=? AND style_no=? AND category=?'
  ).get(warehouse, scope, styleNo, category);
  return row;
}));

router.delete('/policies/:id', authRequired, requireRole(...POLICY), (req, res) => {
  const row = db.prepare('SELECT * FROM spot_policies WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '策略不存在');
  if (row.scope === 'global') return fail(res, 400, '全局策略不能删，请改成停用');
  db.prepare('DELETE FROM spot_policies WHERE id = ?').run(row.id);
  return ok(res, { deleted: 1 });
});

/** ==================== 提案批次 ==================== */
router.get('/runs', authRequired, requireRole(...READ), (req, res) => {
  const warehouse = String(req.query.warehouse || 'us');
  return ok(res, S.listRuns(warehouse));
});

router.post('/runs', authRequired, requireRole(...WRITE), guard((req) => {
  const b = req.body || {};
  const windowDays = Math.min(365, Math.max(7, Number(b.window_days) || 60));
  return S.generateRun({
    warehouse: String(b.warehouse || 'us'),
    windowDays,
    operator: opName(req),
    note: b.note || null
  });
}));

router.get('/runs/:id', authRequired, requireRole(...READ), (req, res) => {
  const v = S.runView(req.params.id);
  if (!v) return fail(res, 404, '提案批次不存在');
  return ok(res, v);
});

router.post('/runs/:id/publish', authRequired, requireRole(...WRITE), guard((req) =>
  S.publishRun(req.params.id, opName(req), (req.body || {}).note)));

router.post('/runs/:id/archive', authRequired, requireRole(...WRITE), guard((req) =>
  S.archiveRun(req.params.id, opName(req))));

router.get('/runs/:id/decisions', authRequired, requireRole(...READ), (req, res) => {
  const v = S.runView(req.params.id);
  if (!v) return fail(res, 404, '提案批次不存在');
  return ok(res, v.decisions);
});

/** ==================== 决策 ==================== */
router.post('/lines/:id/decide', authRequired, requireRole(...WRITE), guard((req) => {
  const b = req.body || {};
  return S.decideLine(req.params.id, { action: b.action, qty: b.qty, note: b.note }, opName(req));
}));

/** 已批准数量的汇总：给采购/生产做「按批准量下单」的清单（本模块不下单） */
router.get('/approved', authRequired, requireRole(...READ), (req, res) => {
  const warehouse = String(req.query.warehouse || 'us');
  return ok(res, S.approvedDemand(warehouse));
});

module.exports = router;
