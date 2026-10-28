/**
 * 质量与合规（对齐原型 TS-M09）
 *
 * 质量标准：GET/POST /api/qc/standards ；GET/PUT/DELETE /api/qc/standards/:id
 * 检验单：  GET/POST /api/qc/inspections ；GET/PUT /api/qc/inspections/:id
 *           POST /api/qc/inspections/:id/finish   { aql_result, fail_qty, pass_qty, create_issue }
 * 异常返修：GET/POST /api/qc/issues ；PUT /api/qc/issues/:id ；POST /api/qc/issues/:id/close
 * 批次：    GET/POST /api/qc/batches ；PUT /api/qc/batches/:id
 *           GET /api/qc/batches/:batchNo/trace   全链路追溯
 * 召回：    GET/POST /api/qc/recalls ；PUT /api/qc/recalls/:id ；POST /api/qc/recalls/:id/notify
 * 概览：    GET /api/qc/stats
 */
const express = require('express');

const { db, now } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { pushMessage } = require('../services/mall');

const router = express.Router();
const WRITE = ['admin', 'production', 'tech', 'sales'];
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const SCOPE_LABEL = { incoming: '来料', process: '过程', final: '成品', child: '童装合规' };
const TYPE_LABEL = { incoming: '来料检验', process: '过程检验', final: '成品检验' };
const ISSUE_TYPE = { rework: '返修', scrap: '报废', concession: '让步接收', complaint: '客诉' };
const ISSUE_STATUS = { open: '待处理', processing: '处理中', closed: '已关闭' };
const SOURCE_LABEL = { inspection: '检验', complaint: '客诉', recall: '召回', internal: '内部' };
const RECALL_STATUS = { assessing: '评估中', confirmed: '已确认', executing: '执行中', closed: '已结案' };
const BATCH_STATUS = { normal: '正常', hold: '已冻结', recalled: '已召回' };
const AQL_LABEL = { pass: '合格', fail: '不合格', conditional: '让步接收' };

// ---------------- 编号 ----------------
function nextNo(table, field, prefix, width) {
  let seq = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c) + 1;
  let no = genNo(prefix, seq);
  while (db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${field} = ?`).get(no)) {
    no = genNo(prefix, ++seq);
  }
  return no;
}

// ---------------- 概览 ----------------
router.get('/stats', authRequired, wrap(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const inspMonth = db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(sample_qty),0) sample, COALESCE(SUM(pass_qty),0) pass, COALESCE(SUM(fail_qty),0) fail FROM qc_inspections WHERE substr(inspect_date,1,7) = ? AND status = 'done'"
  ).get(month);
  const pending = Number(db.prepare("SELECT COUNT(*) c FROM qc_inspections WHERE status = 'draft'").get().c);
  const openIssues = Number(db.prepare("SELECT COUNT(*) c FROM qc_issues WHERE status != 'closed'").get().c);
  const criticalIssues = Number(db.prepare("SELECT COUNT(*) c FROM qc_issues WHERE status != 'closed' AND severity = 'critical'").get().c);
  const holdBatches = Number(db.prepare("SELECT COUNT(*) c FROM qc_batches WHERE status != 'normal'").get().c);
  const recalls = Number(db.prepare("SELECT COUNT(*) c FROM qc_recalls WHERE status != 'closed'").get().c);
  const standards = Number(db.prepare("SELECT COUNT(*) c FROM qc_standards WHERE status = 'active'").get().c);

  const sample = Number(inspMonth.sample) || 0;
  const pass = Number(inspMonth.pass) || 0;
  return ok(res, {
    month,
    standards,
    pending_inspections: pending,
    month_inspections: Number(inspMonth.c) || 0,
    month_sample: sample,
    month_pass: pass,
    month_fail: Number(inspMonth.fail) || 0,
    pass_rate: sample > 0 ? round2((pass / sample) * 100) : null,
    open_issues: openIssues,
    critical_issues: criticalIssues,
    hold_batches: holdBatches,
    open_recalls: recalls
  });
}));

// ---------------- 质量标准 ----------------
function standardFull(id) {
  const s = db.prepare('SELECT * FROM qc_standards WHERE id = ?').get(id);
  if (!s) return null;
  s.items = db.prepare('SELECT * FROM qc_standard_items WHERE standard_id = ? ORDER BY seq, id').all(id);
  s.scope_label = SCOPE_LABEL[s.scope] || s.scope;
  return s;
}

router.get('/standards', authRequired, wrap(async (req, res) => {
  const { scope = '', category = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (scope) { where.push('scope = ?'); params.push(scope); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (q) { where.push('(name LIKE ? OR code LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    'SELECT * FROM qc_standards ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY status DESC, id DESC'
  ).all(...params);
  const cnt = db.prepare('SELECT COUNT(*) c FROM qc_standard_items WHERE standard_id = ?');
  return ok(res, rows.map((r) => ({
    ...r,
    scope_label: SCOPE_LABEL[r.scope] || r.scope,
    item_count: Number(cnt.get(r.id).c)
  })));
}));

router.get('/standards/:id', authRequired, wrap(async (req, res) => {
  const s = standardFull(req.params.id);
  if (!s) return fail(res, 404, '质量标准不存在');
  return ok(res, s);
}));

function saveItems(standardId, items) {
  db.prepare('DELETE FROM qc_standard_items WHERE standard_id = ?').run(standardId);
  const ins = db.prepare(
    'INSERT INTO qc_standard_items (standard_id, seq, item_name, standard, method, critical) VALUES (?,?,?,?,?,?)'
  );
  (Array.isArray(items) ? items : []).forEach((it, i) => {
    if (!it.item_name) return;
    ins.run(standardId, i + 1, it.item_name, it.standard || null, it.method || null, it.critical ? 1 : 0);
  });
}

router.post('/standards', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, '标准名称必填');
  const t = now();
  const info = db.prepare(
    'INSERT INTO qc_standards (code, name, category, scope, aql, status, remark, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(b.code || null, b.name, b.category || null, b.scope || 'final', b.aql || null,
    b.status || 'active', b.remark || null, t, t);
  const id = Number(info.lastInsertRowid);
  saveItems(id, b.items);
  return ok(res, standardFull(id));
}));

router.put('/standards/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM qc_standards WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '质量标准不存在');
  const b = req.body || {};
  db.prepare(
    'UPDATE qc_standards SET code=?, name=?, category=?, scope=?, aql=?, status=?, remark=?, updated_at=? WHERE id=?'
  ).run(b.code !== undefined ? b.code || null : row.code, b.name || row.name,
    b.category !== undefined ? b.category || null : row.category,
    b.scope || row.scope, b.aql !== undefined ? b.aql || null : row.aql,
    b.status || row.status, b.remark !== undefined ? b.remark || null : row.remark, now(), row.id);
  if (b.items !== undefined) saveItems(row.id, b.items);
  return ok(res, standardFull(row.id));
}));

router.delete('/standards/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM qc_standards WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '质量标准不存在');
  db.prepare('UPDATE qc_standards SET status = ? WHERE id = ?').run('disabled', row.id);
  return ok(res, { id: row.id, status: 'disabled' });
}));

// ---------------- 检验单 ----------------
function inspectionFull(id) {
  const r = db.prepare(
    `SELECT i.*, o.order_no, c.name AS customer_name FROM qc_inspections i
     LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN customers c ON c.id = o.customer_id
     WHERE i.id = ?`
  ).get(id);
  if (!r) return null;
  r.items = db.prepare('SELECT * FROM qc_inspection_items WHERE inspection_id = ? ORDER BY seq, id').all(id);
  r.type_label = TYPE_LABEL[r.type] || r.type;
  r.ng_count = r.items.filter((x) => x.result === 'ng').length;
  return r;
}

router.get('/inspections', authRequired, wrap(async (req, res) => {
  const { order_id = '', type = '', status = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (order_id) { where.push('i.order_id = ?'); params.push(Number(order_id)); }
  if (type) { where.push('i.type = ?'); params.push(type); }
  if (status) { where.push('i.status = ?'); params.push(status); }
  if (q) { where.push('(i.inspect_no LIKE ? OR i.batch_no LIKE ? OR i.style_no LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT i.*, o.order_no, c.name AS customer_name FROM qc_inspections i
     LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN customers c ON c.id = o.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY i.id DESC LIMIT 200'
  ).all(...params);
  return ok(res, rows.map((r) => ({ ...r, type_label: TYPE_LABEL[r.type] || r.type })));
}));

router.get('/inspections/:id', authRequired, wrap(async (req, res) => {
  const r = inspectionFull(req.params.id);
  if (!r) return fail(res, 404, '检验单不存在');
  return ok(res, r);
}));

router.post('/inspections', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.order_id && !b.style_no) return fail(res, 400, '请选择订单或填写款号');
  let styleNo = b.style_no || null;
  if (b.order_id) {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(b.order_id);
    if (!o) return fail(res, 404, '订单不存在');
    styleNo = styleNo || o.style_name;
  }

  // 从标准带出检验项目
  let standardName = null;
  let stdItems = [];
  if (b.standard_id) {
    const s = standardFull(b.standard_id);
    if (s) {
      standardName = s.name;
      stdItems = s.items;
    }
  }

  const no = nextNo('qc_inspections', 'inspect_no', 'QC', 4);
  const t = now();
  let id;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO qc_inspections (inspect_no, order_id, style_no, batch_no, type, standard_id, standard_name,
        inspect_date, inspector, sample_qty, pass_qty, fail_qty, status, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(no, b.order_id || null, styleNo, b.batch_no || null, b.type || 'final',
      b.standard_id || null, standardName, b.inspect_date || t.slice(0, 10),
      b.inspector || req.user.username, Number(b.sample_qty) || 0, 0, 0, 'draft', b.remark || null, t, t);
    id = Number(info.lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO qc_inspection_items (inspection_id, seq, item_name, standard, actual, result, critical, remark) VALUES (?,?,?,?,?,?,?,?)'
    );
    stdItems.forEach((it, i) => {
      ins.run(id, i + 1, it.item_name, it.standard || null, null, 'ok', it.critical ? 1 : 0, null);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, inspectionFull(id));
}));

router.put('/inspections/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM qc_inspections WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '检验单不存在');
  if (row.status === 'done') return fail(res, 400, '已完成检验单不可修改');
  const b = req.body || {};

  db.exec('BEGIN');
  try {
    if (Array.isArray(b.items)) {
      const upd = db.prepare('UPDATE qc_inspection_items SET actual=?, result=?, remark=? WHERE id=? AND inspection_id=?');
      b.items.forEach((it) => {
        if (!it.id) return;
        upd.run(it.actual !== undefined ? String(it.actual) : null, it.result === 'ng' ? 'ng' : 'ok',
          it.remark || null, it.id, row.id);
      });
    }
    const items = db.prepare('SELECT * FROM qc_inspection_items WHERE inspection_id = ?').all(row.id);
    const autoFail = items.filter((x) => x.result === 'ng').length;
    const sample = b.sample_qty !== undefined ? Number(b.sample_qty) || 0 : row.sample_qty;
    const failQty = b.fail_qty !== undefined ? Number(b.fail_qty) || 0 : row.fail_qty;
    const passQty = b.pass_qty !== undefined ? Number(b.pass_qty) || 0 : round2(Math.max(0, sample - failQty));
    db.prepare(
      'UPDATE qc_inspections SET sample_qty=?, pass_qty=?, fail_qty=?, batch_no=?, inspector=?, remark=?, updated_at=? WHERE id=?'
    ).run(sample, passQty, failQty,
      b.batch_no !== undefined ? b.batch_no || null : row.batch_no,
      b.inspector || row.inspector, b.remark !== undefined ? b.remark || null : row.remark, now(), row.id);
    db.exec('COMMIT');
    const out = inspectionFull(row.id);
    out.auto_ng = autoFail;
    return ok(res, out);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

/**
 * 完成检验：判定结果；不合格可自动生成异常单；并把批次状态置为 正常/冻结
 */
router.post('/inspections/:id/finish', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM qc_inspections WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '检验单不存在');
  if (row.status === 'done') return fail(res, 400, '该检验单已完成');

  const b = req.body || {};
  const items = db.prepare('SELECT * FROM qc_inspection_items WHERE inspection_id = ?').all(row.id);
  const ngItems = items.filter((x) => x.result === 'ng');
  const criticalNg = ngItems.some((x) => x.critical);
  const sample = Number(b.sample_qty) || row.sample_qty;
  const failQty = b.fail_qty !== undefined ? Number(b.fail_qty) || 0 : row.fail_qty;
  const passQty = b.pass_qty !== undefined ? Number(b.pass_qty) || 0 : round2(Math.max(0, sample - failQty));

  let aqlResult = b.aql_result;
  if (!aqlResult) {
    if (criticalNg) aqlResult = 'fail';
    else if (ngItems.length > 0) aqlResult = failQty > 0 ? 'fail' : 'conditional';
    else aqlResult = 'pass';
  }
  if (!['pass', 'fail', 'conditional'].includes(aqlResult)) return fail(res, 400, '判定结果只能是 pass/fail/conditional');

  const t = now();
  let issueId = null;
  db.exec('BEGIN');
  try {
    db.prepare(
      'UPDATE qc_inspections SET status=?, aql_result=?, sample_qty=?, pass_qty=?, fail_qty=?, remark=?, updated_at=? WHERE id=?'
    ).run('done', aqlResult, sample, passQty, failQty, b.remark !== undefined ? b.remark || null : row.remark, t, row.id);

    // 不合格 → 自动开异常单
    if (aqlResult !== 'pass' && b.create_issue !== false) {
      const issueNo = nextNo('qc_issues', 'issue_no', 'QG', 4);
      const info = db.prepare(
        `INSERT INTO qc_issues (issue_no, source, inspection_id, order_id, batch_no, style_no, type, severity, qty,
          description, status, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(issueNo, 'inspection', row.id, row.order_id, row.batch_no, row.style_no,
        aqlResult === 'fail' ? 'rework' : 'concession',
        criticalNg ? 'critical' : (failQty > 0 ? 'major' : 'minor'),
        failQty > 0 ? failQty : 0,
        // 描述是给客户看的（会进验货报告），判定要写中文不能写 pass/fail
        `检验单 ${row.inspect_no} 判定${AQL_LABEL[aqlResult] || aqlResult}，不良项：${ngItems.map((x) => x.item_name).join('、') || '无明细'}`,
        'open', req.user.username, t, t);
      issueId = Number(info.lastInsertRowid);
    }

    // 批次状态联动
    if (row.batch_no) {
      const batch = db.prepare('SELECT * FROM qc_batches WHERE batch_no = ?').get(row.batch_no);
      if (batch) {
        const to = aqlResult === 'pass' ? 'normal' : 'hold';
        db.prepare('UPDATE qc_batches SET status=?, updated_at=? WHERE id=?').run(to, t, batch.id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const out = inspectionFull(row.id);
  out.issue_id = issueId;
  return ok(res, out);
}));

router.delete('/inspections/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM qc_inspections WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '检验单不存在');
  if (row.status === 'done') return fail(res, 400, '已完成的检验单不可删除');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM qc_inspection_items WHERE inspection_id = ?').run(row.id);
    db.prepare('DELETE FROM qc_inspections WHERE id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, { deleted: 1 });
}));

// ---------------- 异常 / 返修 / 纠正措施 ----------------
function issueFull(id) {
  const r = db.prepare(
    `SELECT i.*, o.order_no, c.name AS customer_name FROM qc_issues i
     LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN customers c ON c.id = o.customer_id
     WHERE i.id = ?`
  ).get(id);
  if (!r) return null;
  r.type_label = ISSUE_TYPE[r.type] || r.type;
  r.status_label = ISSUE_STATUS[r.status] || r.status;
  r.source_label = SOURCE_LABEL[r.source] || r.source;
  return r;
}

router.get('/issues', authRequired, wrap(async (req, res) => {
  const { status = '', source = '', order_id = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('i.status = ?'); params.push(status); }
  if (source) { where.push('i.source = ?'); params.push(source); }
  if (order_id) { where.push('i.order_id = ?'); params.push(Number(order_id)); }
  if (q) { where.push('(i.issue_no LIKE ? OR i.batch_no LIKE ? OR i.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT i.*, o.order_no, c.name AS customer_name FROM qc_issues i
     LEFT JOIN orders o ON o.id = i.order_id LEFT JOIN customers c ON c.id = o.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY i.id DESC LIMIT 200'
  ).all(...params);
  return ok(res, rows.map((r) => ({
    ...r,
    type_label: ISSUE_TYPE[r.type] || r.type,
    status_label: ISSUE_STATUS[r.status] || r.status,
    source_label: SOURCE_LABEL[r.source] || r.source
  })));
}));

router.post('/issues', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.description) return fail(res, 400, '请描述异常情况');
  const no = nextNo('qc_issues', 'issue_no', 'QG', 4);
  const t = now();
  const info = db.prepare(
    `INSERT INTO qc_issues (issue_no, source, inspection_id, order_id, batch_no, style_no, type, severity, qty,
      description, root_cause, action, owner, due_date, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(no, b.source || 'internal', b.inspection_id || null, b.order_id || null, b.batch_no || null,
    b.style_no || null, b.type || 'rework', b.severity || 'minor', Number(b.qty) || 0,
    b.description, b.root_cause || null, b.action || null, b.owner || null, b.due_date || null,
    'open', req.user.username, t, t);
  return ok(res, issueFull(Number(info.lastInsertRowid)));
}));

router.put('/issues/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM qc_issues WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '异常单不存在');
  const b = req.body || {};
  db.prepare(
    `UPDATE qc_issues SET type=?, severity=?, qty=?, description=?, root_cause=?, action=?, owner=?, due_date=?,
      status=?, updated_at=? WHERE id=?`
  ).run(b.type || row.type, b.severity || row.severity,
    b.qty !== undefined ? Number(b.qty) || 0 : row.qty,
    b.description || row.description,
    b.root_cause !== undefined ? b.root_cause || null : row.root_cause,
    b.action !== undefined ? b.action || null : row.action,
    b.owner !== undefined ? b.owner || null : row.owner,
    b.due_date !== undefined ? b.due_date || null : row.due_date,
    b.status && ISSUE_STATUS[b.status] ? b.status : row.status,
    now(), row.id);
  return ok(res, issueFull(row.id));
}));

router.post('/issues/:id/close', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM qc_issues WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '异常单不存在');
  if (row.status === 'closed') return fail(res, 400, '该异常单已关闭');
  const b = req.body || {};
  db.prepare('UPDATE qc_issues SET status=?, action=COALESCE(?, action), closed_at=?, updated_at=? WHERE id=?')
    .run('closed', b.action || null, now(), now(), row.id);
  return ok(res, issueFull(row.id));
}));

// ---------------- 批次（追溯） ----------------
router.get('/batches', authRequired, wrap(async (req, res) => {
  const { order_id = '', status = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (order_id) { where.push('b.order_id = ?'); params.push(Number(order_id)); }
  if (status) { where.push('b.status = ?'); params.push(status); }
  if (q) { where.push('(b.batch_no LIKE ? OR b.style_no LIKE ? OR b.fabric_batch LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT b.*, o.order_no, c.name AS customer_name FROM qc_batches b
     LEFT JOIN orders o ON o.id = b.order_id LEFT JOIN customers c ON c.id = o.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY b.id DESC LIMIT 200'
  ).all(...params);
  return ok(res, rows.map((r) => ({ ...r, status_label: BATCH_STATUS[r.status] || r.status })));
}));

router.post('/batches', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  let order = null;
  if (b.order_id) {
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(b.order_id);
    if (!order) return fail(res, 404, '订单不存在');
  }
  let batchNo = b.batch_no;
  if (!batchNo) {
    const seq = Number(db.prepare('SELECT COUNT(*) c FROM qc_batches').get().c) + 1;
    batchNo = genNo('B', seq);
    while (db.prepare('SELECT 1 AS x FROM qc_batches WHERE batch_no = ?').get(batchNo)) {
      batchNo = genNo('B', ++seq);
    }
  } else if (db.prepare('SELECT 1 AS x FROM qc_batches WHERE batch_no = ?').get(batchNo)) {
    return fail(res, 400, '批次号已存在');
  }
  const t = now();
  const info = db.prepare(
    `INSERT INTO qc_batches (batch_no, order_id, style_no, product_name, qty, production_date, factory,
      fabric_batch, child_safety, docs, status, remark, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(batchNo, b.order_id || null, b.style_no || (order && order.style_name) || null,
    b.product_name || (order && order.style_name) || null, Number(b.qty) || 0,
    b.production_date || t.slice(0, 10), b.factory || null, b.fabric_batch || null,
    b.child_safety || null, b.docs ? JSON.stringify(b.docs) : null, b.status || 'normal',
    b.remark || null, t, t);
  return ok(res, db.prepare('SELECT * FROM qc_batches WHERE id = ?').get(Number(info.lastInsertRowid)));
}));

router.put('/batches/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM qc_batches WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '批次不存在');
  const b = req.body || {};
  db.prepare(
    `UPDATE qc_batches SET product_name=?, qty=?, production_date=?, factory=?, fabric_batch=?,
      child_safety=?, docs=?, status=?, remark=?, updated_at=? WHERE id=?`
  ).run(b.product_name || row.product_name,
    b.qty !== undefined ? Number(b.qty) || 0 : row.qty,
    b.production_date !== undefined ? b.production_date || null : row.production_date,
    b.factory !== undefined ? b.factory || null : row.factory,
    b.fabric_batch !== undefined ? b.fabric_batch || null : row.fabric_batch,
    b.child_safety !== undefined ? b.child_safety || null : row.child_safety,
    b.docs !== undefined ? (b.docs ? JSON.stringify(b.docs) : null) : row.docs,
    b.status && BATCH_STATUS[b.status] ? b.status : row.status,
    b.remark !== undefined ? b.remark || null : row.remark, now(), row.id);
  return ok(res, db.prepare('SELECT * FROM qc_batches WHERE id = ?').get(row.id));
}));

/** 批次全链路追溯：订单 → 检验 → 异常 → 召回 → 库存流水 */
router.get('/batches/:batchNo/trace', authRequired, wrap(async (req, res) => {
  const batch = db.prepare('SELECT * FROM qc_batches WHERE batch_no = ?').get(req.params.batchNo);
  if (!batch) return fail(res, 404, '批次不存在');

  const order = batch.order_id
    ? db.prepare(
      `SELECT o.*, c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
    ).get(batch.order_id)
    : null;

  const inspections = db.prepare('SELECT * FROM qc_inspections WHERE batch_no = ? ORDER BY id').all(batch.batch_no)
    .map((r) => ({ ...r, type_label: TYPE_LABEL[r.type] || r.type }));

  const issues = db.prepare('SELECT * FROM qc_issues WHERE batch_no = ? ORDER BY id').all(batch.batch_no)
    .map((r) => ({ ...r, type_label: ISSUE_TYPE[r.type] || r.type, status_label: ISSUE_STATUS[r.status] || r.status }));

  const recalls = db.prepare('SELECT * FROM qc_recalls WHERE batch_no = ? ORDER BY id').all(batch.batch_no)
    .map((r) => ({ ...r, status_label: RECALL_STATUS[r.status] || r.status }));

  let ledger = [];
  if (batch.order_id) {
    ledger = db.prepare(
      "SELECT warehouse, type, qty, remark, operator, created_at FROM stock_ledger WHERE ref_type = 'order' AND ref_id = ? ORDER BY id"
    ).all(batch.order_id);
  }

  let items = [];
  if (batch.order_id) {
    items = db.prepare('SELECT product_name, style_no, qty, amount_usd FROM order_items WHERE order_id = ?').all(batch.order_id);
  }

  return ok(res, {
    batch: { ...batch, status_label: BATCH_STATUS[batch.status] || batch.status, docs: batch.docs ? JSON.parse(batch.docs) : [] },
    order,
    items,
    inspections,
    issues,
    recalls,
    ledger
  });
}));

// ---------------- 召回评估 ----------------
router.get('/recalls', authRequired, wrap(async (req, res) => {
  const { status = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('r.status = ?'); params.push(status); }
  if (q) { where.push('(r.recall_no LIKE ? OR r.batch_no LIKE ? OR r.reason LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(
    `SELECT r.*, o.order_no, c.name AS customer_name FROM qc_recalls r
     LEFT JOIN orders o ON o.id = r.order_id LEFT JOIN customers c ON c.id = o.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY r.id DESC LIMIT 200'
  ).all(...params);
  return ok(res, rows.map((r) => ({ ...r, status_label: RECALL_STATUS[r.status] || r.status })));
}));

function recallFull(id) {
  const r = db.prepare(
    `SELECT r.*, o.order_no, c.name AS customer_name FROM qc_recalls r
     LEFT JOIN orders o ON o.id = r.order_id LEFT JOIN customers c ON c.id = o.customer_id
     WHERE r.id = ?`
  ).get(id);
  if (!r) return null;
  return { ...r, status_label: RECALL_STATUS[r.status] || r.status };
}

router.post('/recalls', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.reason) return fail(res, 400, '请填写召回原因');
  const no = nextNo('qc_recalls', 'recall_no', 'ZH', 4);
  const t = now();
  let id;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO qc_recalls (recall_no, order_id, batch_no, issue_id, reason, severity, qty_affected,
        qty_recalled, status, customer_notified, remark, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(no, b.order_id || null, b.batch_no || null, b.issue_id || null, b.reason,
      b.severity || 'major', Number(b.qty_affected) || 0, 0, 'assessing', 0, b.remark || null, t, t);
    id = Number(info.lastInsertRowid);
    // 批次立即冻结，避免继续出库
    if (b.batch_no) {
      db.prepare("UPDATE qc_batches SET status='hold', updated_at=? WHERE batch_no=?").run(t, b.batch_no);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, recallFull(id));
}));

router.put('/recalls/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM qc_recalls WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '召回单不存在');
  const b = req.body || {};
  const status = RECALL_STATUS[b.status] ? b.status : row.status;
  db.prepare(
    'UPDATE qc_recalls SET status=?, qty_recalled=?, severity=?, remark=?, updated_at=? WHERE id=?'
  ).run(status,
    b.qty_recalled !== undefined ? Number(b.qty_recalled) || 0 : row.qty_recalled,
    b.severity || row.severity,
    b.remark !== undefined ? b.remark || null : row.remark,
    now(), row.id);
  // 结案时批次标记为已召回
  if (status === 'closed' && row.batch_no) {
    db.prepare("UPDATE qc_batches SET status='recalled', updated_at=? WHERE batch_no=?").run(now(), row.batch_no);
  }
  return ok(res, recallFull(row.id));
}));

/** 通知客户（走客户商城站内信） */
router.post('/recalls/:id/notify', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM qc_recalls WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '召回单不存在');
  const order = row.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(row.order_id) : null;
  if (!order || !order.customer_id) return fail(res, 400, '该召回单没有关联客户，无法发送通知');

  pushMessage({
    customerId: order.customer_id,
    type: 'system',
    title: `质量通知：订单 ${order.order_no} 启动召回评估`,
    body: `批次 ${row.batch_no || '-'} 因「${row.reason}」启动召回评估，涉及 ${row.qty_affected} 件。我们会尽快给出处理方案，请暂缓销售并保留包装。`,
    refType: 'recall',
    refId: row.id
  });
  db.prepare('UPDATE qc_recalls SET customer_notified=1, updated_at=? WHERE id=?').run(now(), row.id);
  return ok(res, { notified: 1 });
}));

module.exports = router;
