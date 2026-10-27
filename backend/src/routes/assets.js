/**
 * 固定资产（含车辆）
 * GET    /api/assets?category=&status=&q=
 * GET    /api/assets/summary                数量/原值/净值/按类别
 * POST   /api/assets
 * PUT    /api/assets/:id
 * POST   /api/assets/:id/status             { status } in_use / idle / scrapped
 * DELETE /api/assets/:id
 *
 * 折旧：直线法（残值率默认 5%，年限默认 5 年）
 *   月折旧 = 原值 × (1 − 残值率) / (年限 × 12)
 *   累计折旧 = min(月折旧 × 已用整月, 原值 × (1 − 残值率))
 *   净值 = 原值 − 累计折旧
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const WRITE = ['admin', 'hr', 'finance'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const STATUS_LABELS = { in_use: '在用', idle: '闲置', scrapped: '已报废' };

function monthsSince(dateStr, until) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  const end = until ? new Date(until) : new Date();
  let m = (end.getFullYear() - d.getFullYear()) * 12 + (end.getMonth() - d.getMonth());
  if (end.getDate() < d.getDate()) m -= 1;
  return Math.max(0, m);
}

function withDepreciation(row) {
  const original = Number(row.original_value) || 0;
  const salvageRate = Number(row.salvage_rate) || 0;
  const years = Number(row.useful_years) || 0;
  const months = monthsSince(row.purchase_date);
  const depreciable = round2(original * (1 - salvageRate));
  const monthly = years > 0 ? round2(depreciable / (years * 12)) : 0;
  const accumulated = Math.min(round2(monthly * months), depreciable);
  return {
    ...row,
    status_label: STATUS_LABELS[row.status] || row.status,
    months_used: months,
    monthly_depreciation: monthly,
    accumulated_depreciation: accumulated,
    net_value: round2(original - accumulated)
  };
}

router.get('/', authRequired, wrap(async (req, res) => {
  const { category = '', status = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (category) { where.push('category = ?'); params.push(category); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (q) { where.push('(name LIKE ? OR code LIKE ? OR keeper LIKE ? OR plate_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = 'SELECT * FROM assets ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    "ORDER BY CASE status WHEN 'in_use' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END, id DESC";
  return ok(res, db.prepare(sql).all(...params).map(withDepreciation));
}));

router.get('/summary', authRequired, wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM assets').all().map(withDepreciation);
  const active = rows.filter((r) => r.status !== 'scrapped');
  const byCategory = {};
  active.forEach((r) => {
    const k = r.category || '未分类';
    if (!byCategory[k]) byCategory[k] = { category: k, count: 0, original: 0, net: 0 };
    byCategory[k].count++;
    byCategory[k].original = round2(byCategory[k].original + Number(r.original_value || 0));
    byCategory[k].net = round2(byCategory[k].net + Number(r.net_value || 0));
  });
  const byStatus = {};
  rows.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });

  // 30 天内年检/保养到期（车辆）
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const dueSoon = active.filter((r) => r.next_check_date && r.next_check_date <= in30)
    .map((r) => ({ id: r.id, name: r.name, plate_no: r.plate_no, next_check_date: r.next_check_date }));

  return ok(res, {
    count: rows.length,
    in_use: byStatus.in_use || 0,
    idle: byStatus.idle || 0,
    scrapped: byStatus.scrapped || 0,
    original_total: round2(active.reduce((s, r) => s + Number(r.original_value || 0), 0)),
    net_total: round2(active.reduce((s, r) => s + Number(r.net_value || 0), 0)),
    monthly_depreciation: round2(active.reduce((s, r) => s + Number(r.monthly_depreciation || 0), 0)),
    byCategory: Object.values(byCategory).sort((a, b) => b.original - a.original),
    dueSoon,
    today
  });
}));

router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '资产名称必填');
  const t = now();
  const info = db.prepare(
    `INSERT INTO assets (code, name, category, dept, keeper, purchase_date, original_value, salvage_rate,
      useful_years, plate_no, next_check_date, status, remark, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(b.code || null, b.name, b.category || null, b.dept || null, b.keeper || null,
    b.purchase_date || null, round2(b.original_value), b.salvage_rate !== undefined ? Number(b.salvage_rate) : 0.05,
    b.useful_years !== undefined ? Number(b.useful_years) : 5, b.plate_no || null,
    b.next_check_date || null, b.status || 'in_use', b.remark || null, t, t);
  return ok(res, withDepreciation(db.prepare('SELECT * FROM assets WHERE id = ?').get(Number(info.lastInsertRowid))));
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '资产不存在');
  const b = req.body || {};
  db.prepare(
    `UPDATE assets SET code=?, name=?, category=?, dept=?, keeper=?, purchase_date=?, original_value=?,
      salvage_rate=?, useful_years=?, plate_no=?, next_check_date=?, status=?, remark=?, updated_at=? WHERE id=?`
  ).run(
    b.code !== undefined ? b.code || null : row.code,
    b.name || row.name,
    b.category !== undefined ? b.category || null : row.category,
    b.dept !== undefined ? b.dept || null : row.dept,
    b.keeper !== undefined ? b.keeper || null : row.keeper,
    b.purchase_date !== undefined ? b.purchase_date || null : row.purchase_date,
    b.original_value !== undefined ? round2(b.original_value) : row.original_value,
    b.salvage_rate !== undefined ? Number(b.salvage_rate) : row.salvage_rate,
    b.useful_years !== undefined ? Number(b.useful_years) : row.useful_years,
    b.plate_no !== undefined ? b.plate_no || null : row.plate_no,
    b.next_check_date !== undefined ? b.next_check_date || null : row.next_check_date,
    b.status || row.status,
    b.remark !== undefined ? b.remark || null : row.remark,
    now(), row.id
  );
  return ok(res, withDepreciation(db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id)));
}));

router.post('/:id/status', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '资产不存在');
  const to = String((req.body || {}).status || '');
  if (!STATUS_LABELS[to]) return fail(res, 400, '未知状态');
  db.prepare('UPDATE assets SET status = ?, updated_at = ? WHERE id = ?').run(to, now(), row.id);
  return ok(res, withDepreciation(db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id)));
}));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const info = db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
  if (!info.changes) return fail(res, 404, '资产不存在');
  return ok(res, { deleted: info.changes });
}));

module.exports = router;
