/**
 * 样衣档案（打版完成后归档，锁定不可改）
 *
 * GET    /api/sample-archives?q=&status=      列表
 * GET    /api/sample-archives/:id             详情（含快照）
 * POST   /api/sample-archives/:id/change-request   提交更改需求 {reason, detail}
 * GET    /api/sample-archives/changes         变更申请列表
 * POST   /api/sample-archives/changes/:id/review   审核 {approve, note}
 *
 * 规则：样衣归档即锁定；要改必须提变更需求，审核通过后才解锁开发单重新打版，
 *       重新完成后自动生成下一版样衣，旧样衣标记「已出新版」并保留。
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');

const router = express.Router();
const REVIEW = ['admin', 'tech'];

// 静态图搜路径必须置于 /:id 之前。任务只属于提交人，检索不修改样衣。
router.post('/image-search', authRequired, requireRole('admin', 'tech', 'sales', 'boss'), wrap(async (req, res) => {
  return ok(res, require('../services/sampleImageSearch').create(req.user, req.body || {}));
}));
router.get('/image-search/:jobId', authRequired, requireRole('admin', 'tech', 'sales', 'boss'), wrap(async (req, res) => {
  return ok(res, require('../services/sampleImageSearch').result(req.user, req.params.jobId));
}));

/**
 * 样衣管理「开发款视图」只读聚合（一比一卡片列表 / 流程节点计数 / 下拉可选值）。
 * 静态路径必须留在 /:id 之前；权限在 service 内逐条复用 patternManagement.owns。
 */
router.get('/workspace', authRequired, wrap(async (req, res) => {
  return ok(res, require('../services/sampleWorkspace').read(req.user, req.query || {}));
}));

function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}

function withSnapshot(row) {
  if (!row) return null;
  return { ...row, snapshot: row.snapshot ? safeJson(row.snapshot) : {} };
}

router.get('/', authRequired, wrap(async (req, res) => {
  const { q = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (q) {
    where.push('(a.archive_no LIKE ? OR a.style_no LIKE ? OR a.sample_name LIKE ? OR a.customer LIKE ?)');
    const kw = `%${q}%`;
    params.push(kw, kw, kw, kw);
  }
  const sql = `SELECT a.*, COALESCE(o.order_no,p.pre_order_no) AS order_no,
      (SELECT COUNT(*) FROM sample_change_requests r WHERE r.archive_id = a.id AND r.status='pending') AS pending_changes
    FROM sample_archives a
    LEFT JOIN orders o ON o.id = a.order_id ` +
    'LEFT JOIN pre_orders p ON p.id = a.pre_order_id ' +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY a.id DESC';
  const rows = db.prepare(sql).all(...params);
  return ok(res, rows.map((r) => ({ ...r, snapshot: undefined })));
}));

router.get('/changes', authRequired, wrap(async (req, res) => {
  const { status = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('r.status = ?'); params.push(status); }
  const sql = `SELECT r.*, a.archive_no, a.style_no, a.sample_name, a.version
    FROM sample_change_requests r
    LEFT JOIN sample_archives a ON a.id = r.archive_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY r.id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/:id', authRequired, wrap(async (req, res) => {
  const row = withSnapshot(db.prepare('SELECT * FROM sample_archives WHERE id = ?').get(req.params.id));
  if (!row) return fail(res, 404, '样衣档案不存在');
  row.changes = db.prepare(`SELECT c.*,n.archive_no AS new_archive_no FROM sample_change_requests c
    LEFT JOIN sample_archives n ON n.id=c.new_archive_id WHERE c.archive_id=? ORDER BY c.id DESC`).all(req.params.id);
  return ok(res, row);
}));

/** 提交更改需求（样衣锁定后唯一的修改入口） */
router.post('/:id/change-request', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const row = db.prepare('SELECT * FROM sample_archives WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '样衣档案不存在');
  if (row.status === 'revised') return fail(res, 400, '该样衣已出新版本，请在新版本上提变更');
  if (!b.reason || !String(b.reason).trim()) return fail(res, 400, '请填写更改原因');

  const pending = db.prepare(
    "SELECT 1 AS x FROM sample_change_requests WHERE archive_id = ? AND status = 'pending'"
  ).get(row.id);
  if (pending) return fail(res, 400, '该样衣已有待审核的更改需求，请等待审核结果');

  const t = now();
  const info = db.prepare(
    'INSERT INTO sample_change_requests (archive_id, reason, detail, applicant, status, created_at) VALUES (?,?,?,?,?,?)'
  ).run(row.id, String(b.reason).trim(), b.detail || null, req.user.username, 'pending', t);

  db.prepare("UPDATE sample_archives SET status = 'changing' WHERE id = ?").run(row.id);
  return ok(res, db.prepare('SELECT * FROM sample_change_requests WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

/** 审核更改需求：通过则解锁开发单重走打版，并保留旧样衣 */
router.post('/changes/:id/review', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const b = req.body || {};
  const reqRow = db.prepare('SELECT * FROM sample_change_requests WHERE id = ?').get(req.params.id);
  if (!reqRow) return fail(res, 404, '更改需求不存在');
  if (reqRow.status !== 'pending') return fail(res, 400, '该需求已审核过');
  if (reqRow.applicant === req.user.username && req.user.role !== 'admin') {
    return fail(res, 400, '提交人不能审批自己提的更改需求');
  }

  const archive = db.prepare('SELECT * FROM sample_archives WHERE id = ?').get(reqRow.archive_id);
  const t = now();
  const approve = !!b.approve;

  db.exec('BEGIN');
  try {
    db.prepare(
      "UPDATE sample_change_requests SET status=?, reviewer=?, reviewed_at=?, review_note=? WHERE id=?"
    ).run(approve ? 'approved' : 'rejected', req.user.username, t, b.note || null, reqRow.id);

    if (approve && archive) {
      // 旧样衣保留，标记已出新版
      db.prepare("UPDATE sample_archives SET status='revised' WHERE id=?").run(archive.id);
      // 解锁开发单：流程回到制版阶段重做后面几步
      const flow = db.prepare('SELECT * FROM pattern_flows WHERE tech_pack_id = ?').get(archive.tech_pack_id);
      if (flow) {
        db.prepare("UPDATE pattern_flows SET status='running', current_stage='pattern', finished_at=NULL WHERE id=?").run(flow.id);
        db.prepare("UPDATE pattern_stages SET status='pending', finished_at=NULL WHERE flow_id=? AND stage IN ('pattern','craft','sample','biz','audit')").run(flow.id);
        db.prepare("UPDATE pattern_stages SET status='doing', started_at=COALESCE(started_at,?), finished_at=NULL WHERE flow_id=? AND stage='pattern'").run(t, flow.id);
      }
      // 开发单解除确认锁，允许修改
      db.prepare("UPDATE tech_packs SET status='draft', stage='pattern', confirmed_by=NULL, confirmed_at=NULL, updated_at=? WHERE id=?").run(t, archive.tech_pack_id);
    } else if (archive) {
      db.prepare("UPDATE sample_archives SET status='locked' WHERE id=?").run(archive.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return ok(res, db.prepare('SELECT * FROM sample_change_requests WHERE id = ?').get(reqRow.id));
}));

module.exports = router;
