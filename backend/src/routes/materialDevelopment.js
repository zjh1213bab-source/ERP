const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const scope = require('../access/companyScope');
const { ensureFlow } = require('./patternFlows');
const { saveMaterials } = require('../services/techPackMaterials');
const { nextNo } = require('../services/noSeries');

const router = express.Router();
const READ = ['admin', 'boss', 'sales', 'tech', 'warehouse'];
const REQUEST = ['admin', 'sales', 'tech'];
const SOURCING = ['admin', 'warehouse'];
const REVIEW = ['admin', 'sales', 'tech'];
const actor = (req) => ({ id: Number(req.user.sub || req.user.id) || null, name: req.user.name || req.user.username || '未知用户' });
const event = (requestId, roundId, action, user, details = '') => db.prepare(
  'INSERT INTO material_dev_events(request_id,round_id,action,actor_id,actor_name,details,created_at) VALUES(?,?,?,?,?,?,?)'
).run(requestId, roundId || null, action, user.id, user.name, details, now());
const getRequest = (id) => {
  const row = db.prepare(`SELECT r.*, COALESCE(c.name,p.customer_name) AS customer_name FROM material_dev_requests r
    LEFT JOIN orders o ON o.id=r.order_id LEFT JOIN customers c ON c.id=o.customer_id
    LEFT JOIN pre_orders p ON p.id=r.pre_order_id WHERE r.id=?`).get(id);
  if (!row) return null;
  row.rounds = db.prepare('SELECT * FROM material_dev_rounds WHERE request_id=? ORDER BY round_no').all(id);
  row.events = db.prepare('SELECT * FROM material_dev_events WHERE request_id=? ORDER BY id').all(id);
  row.pattern_reviews = db.prepare('SELECT * FROM material_dev_pattern_reviews WHERE request_id=? ORDER BY id').all(id);
  return row;
};

router.get('/', authRequired, requireRole(READ), wrap(async (req, res) => {
  const status = String(req.query.status || '');
  const q = String(req.query.q || '').trim();
  const where = [], args = [];
  const sc = scope.clause(req.user, 'r.company_id');
  if (sc.sql) { where.push(sc.sql.replace(/^\s*AND\s+/, '')); args.push(...sc.params); }
  if (status) { where.push('r.status=?'); args.push(status); }
  if (q) { where.push('(r.request_no LIKE ? OR r.order_no LIKE ? OR r.material_name LIKE ? OR c.name LIKE ?)'); args.push(...Array(4).fill(`%${q}%`)); }
  const rows = db.prepare(`SELECT r.*, COALESCE(c.name,p.customer_name) AS customer_name FROM material_dev_requests r
    LEFT JOIN orders o ON o.id=r.order_id LEFT JOIN customers c ON c.id=o.customer_id
    LEFT JOIN pre_orders p ON p.id=r.pre_order_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE r.status WHEN 'search_required' THEN 0 WHEN 'searching' THEN 1 WHEN 'awaiting_business' THEN 2 ELSE 3 END, r.created_at DESC`).all(...args);
  return ok(res, rows.map((r) => ({ ...r, rounds: db.prepare('SELECT * FROM material_dev_rounds WHERE request_id=? ORDER BY round_no').all(r.id), events: db.prepare('SELECT * FROM material_dev_events WHERE request_id=? ORDER BY id').all(r.id), pattern_reviews: db.prepare('SELECT * FROM material_dev_pattern_reviews WHERE request_id=? ORDER BY id').all(r.id) })));
}));

router.post('/', authRequired, requireRole(REQUEST), wrap(async (req, res) => {
  const b = req.body || {};
  const preOrderId = Number(b.pre_order_id);
  const scopedPreOrder = scope.assertRow(req.user, 'pre_orders', preOrderId, '预下单');
  if (!scopedPreOrder.ok) return fail(res, 400, '请选择系统中已录入的预下单');
  const preOrder = scopedPreOrder.row;
  if (preOrder.status !== 'open') return fail(res, 409, '该预下单当前不可用于新品寻样');
  const type = ['fabric', 'accessory'].includes(b.material_type) ? b.material_type : '';
  if (!type || !String(b.material_name || '').trim() || !String(b.customer_requirements || '').trim()) return fail(res, 400, '面辅料类型、名称和客户要求为必填项');
  const referenceImageUrl = String(b.reference_image_url || '').trim();
  if (referenceImageUrl && !/^\/uploads\/[a-f0-9]{20}\.(png|jpg|webp|gif)$/i.test(referenceImageUrl)) return fail(res, 400, '客户参考图片地址无效，请重新上传');
  const user = actor(req), ts = now();
  // 单号取「当日最大号 +1」（COUNT(*)+1 在删过记录后会撞号 → UNIQUE 报 500）
  const no = nextNo('material_dev_requests', 'request_no', 'MD');
  const info = db.prepare(`INSERT INTO material_dev_requests(request_no,company_id,order_id,order_no,style_name,material_type,material_name,customer_requirements,requested_spec,requested_color,requester_id,requester_name,status,created_by,created_at,updated_at,pre_order_id,reference_image_url)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'search_required',?,?,?,?,?)`).run(no, preOrder.company_id || 1, 0, preOrder.pre_order_no, preOrder.style_name || '', type, String(b.material_name).trim(), String(b.customer_requirements).trim(), b.requested_spec || '', b.requested_color || '', user.id, user.name, user.id, ts, ts, preOrderId, referenceImageUrl || null);
  event(info.lastInsertRowid, null, 'request_created', user, '业务确认订单后发起新品寻样');
  return ok(res, getRequest(info.lastInsertRowid));
}));

router.post('/:id/start-search', authRequired, requireRole(SOURCING), wrap(async (req, res) => {
  const id = Number(req.params.id), row = db.prepare('SELECT * FROM material_dev_requests WHERE id=?').get(id);
  if (!row || !scope.canSee(req.user, { company_id: row.company_id })) return fail(res, 404, '寻样申请不存在');
  if (!['search_required', 'searching'].includes(row.status)) return fail(res, 409, '当前状态不能开始寻样');
  const active = db.prepare("SELECT id FROM material_dev_rounds WHERE request_id=? AND decision='searching'").get(id);
  if (active) return fail(res, 409, '已有正在进行的寻样轮次');
  const previous = db.prepare('SELECT MAX(round_no) AS n FROM material_dev_rounds WHERE request_id=?').get(id).n || 0;
  const user = actor(req), ts = now();
  const info = db.prepare(`INSERT INTO material_dev_rounds(request_id,round_no,started_at,started_by,started_by_name,search_note,decision,created_at) VALUES(?,?,?,?,?,?,'searching',?)`).run(id, previous + 1, ts, user.id, user.name, String(req.body?.search_note || ''), ts);
  db.prepare("UPDATE material_dev_requests SET status='searching',updated_at=? WHERE id=?").run(ts, id);
  event(id, info.lastInsertRowid, 'search_started', user, `第${previous + 1}轮开始市场寻样`);
  return ok(res, getRequest(id));
}));

router.post('/rounds/:roundId/return', authRequired, requireRole(SOURCING), wrap(async (req, res) => {
  const round = db.prepare(`SELECT d.*,r.status AS request_status,r.company_id FROM material_dev_rounds d JOIN material_dev_requests r ON r.id=d.request_id WHERE d.id=?`).get(Number(req.params.roundId));
  if (!round) return fail(res, 404, '寻样轮次不存在');
  if (!scope.canSee(req.user, round)) return fail(res, 404, '寻样轮次不存在');
  if (round.decision !== 'searching' || round.request_status !== 'searching') return fail(res, 409, '该轮次当前不能回传');
  const b = req.body || {};
  if (!String(b.candidate_name || '').trim()) return fail(res, 400, '请填写找到的面辅料名称');
  const imageUrl = String(b.candidate_image_url || '').trim();
  if (imageUrl && !/^\/uploads\/[a-f0-9]{20}\.(png|jpg|webp|gif)$/i.test(imageUrl)) return fail(res, 400, '候选图片地址无效，请重新上传');
  const user = actor(req), ts = now();
  db.prepare(`UPDATE material_dev_rounds SET returned_at=?,returned_by=?,returned_by_name=?,candidate_name=?,candidate_spec=?,candidate_color=?,candidate_supplier=?,candidate_price=?,candidate_note=?,candidate_image_url=?,decision='awaiting_business' WHERE id=?`)
    .run(ts, user.id, user.name, String(b.candidate_name).trim(), b.candidate_spec || '', b.candidate_color || '', b.candidate_supplier || '', Number(b.candidate_price) || 0, b.candidate_note || '', imageUrl || null, round.id);
  db.prepare("UPDATE material_dev_requests SET status='awaiting_business',updated_at=? WHERE id=?").run(ts, round.request_id);
  event(round.request_id, round.id, 'candidate_returned', user, `回传候选：${String(b.candidate_name).trim()}`);
  return ok(res, getRequest(round.request_id));
}));

router.post('/rounds/:roundId/reject', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const round = db.prepare(`SELECT d.*,r.status AS request_status,r.company_id FROM material_dev_rounds d JOIN material_dev_requests r ON r.id=d.request_id WHERE d.id=?`).get(Number(req.params.roundId));
  if (!round) return fail(res, 404, '寻样轮次不存在');
  if (!scope.canSee(req.user, round)) return fail(res, 404, '寻样轮次不存在');
  if (round.decision !== 'awaiting_business' || round.request_status !== 'awaiting_business') return fail(res, 409, '该候选当前不能审核');
  const reason = String(req.body?.rejection_reason || '').trim();
  if (!reason) return fail(res, 400, '请填写不符合客户要求的原因');
  const user = actor(req), ts = now();
  db.prepare("UPDATE material_dev_rounds SET decision='rejected',rejection_reason=?,decided_at=?,decided_by=?,decided_by_name=? WHERE id=?").run(reason, ts, user.id, user.name, round.id);
  db.prepare("UPDATE material_dev_requests SET status='search_required',updated_at=? WHERE id=?").run(ts, round.request_id);
  event(round.request_id, round.id, 'candidate_rejected', user, reason);
  return ok(res, getRequest(round.request_id));
}));

router.post('/rounds/:roundId/approve', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const round = db.prepare(`SELECT d.*,r.status AS request_status,r.material_type,r.company_id FROM material_dev_rounds d JOIN material_dev_requests r ON r.id=d.request_id WHERE d.id=?`).get(Number(req.params.roundId));
  if (!round) return fail(res, 404, '寻样轮次不存在');
  if (!scope.canSee(req.user, round)) return fail(res, 404, '寻样轮次不存在');
  if (round.decision !== 'awaiting_business' || round.request_status !== 'awaiting_business') return fail(res, 409, '该候选当前不能确认');
  const user = actor(req), ts = now();
  const addMaterial = !!req.body?.add_to_material_archive;
  let materialId = null;
  /**
   * 事务用 BEGIN/COMMIT —— **不要用 `db.transaction()`**。
   *
   * 项目铁律：`db.transaction()` 是 better-sqlite3 的扩展方法，
   * `node:sqlite` 回退驱动（db.js 在 better-sqlite3 装不上时自动切换）**没有这个方法**
   * —— 实测 `typeof new DatabaseSync(':memory:').transaction === 'undefined'`。
   * 用它的后果是：在装了原生模块的机器上一切正常，换到只能回退的机器上
   * "确认可用"这种关键动作直接 TypeError 500，而且上线前完全看不出来。
   */
  db.exec('BEGIN IMMEDIATE');
  try {
    if (addMaterial) {
      const candidate = db.prepare('SELECT * FROM material_dev_rounds WHERE id=?').get(round.id);
      const inserted = db.prepare(`INSERT INTO materials(type,name,spec,supplier,status,created_at,updated_at,color,remark) VALUES(?,?,?,?, 'active',?,?,?,?)`).run(round.material_type, candidate.candidate_name, candidate.candidate_spec || '', candidate.candidate_supplier || '', ts, ts, candidate.candidate_color || '', `新品开发申请 ${round.request_id} 确认可用`);
      materialId = inserted.lastInsertRowid;
    }
    db.prepare("UPDATE material_dev_rounds SET decision='approved',decided_at=?,decided_by=?,decided_by_name=? WHERE id=?").run(ts, user.id, user.name, round.id);
    db.prepare("UPDATE material_dev_requests SET status='completed',pattern_review_status='pending',accepted_material_id=?,completed_by=?,completed_at=?,updated_at=? WHERE id=?").run(materialId, user.id, ts, ts, round.request_id);
    event(round.request_id, round.id, 'candidate_approved', user, materialId ? `确认可用并建档，面料ID ${materialId}` : '确认可用，流程闭环');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, getRequest(round.request_id));
}));

router.post('/:id/pattern-review', authRequired, requireRole(['admin', 'tech']), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT r.*,p.pre_order_no,p.customer_name AS pre_customer,p.style_name AS pre_style,
      d.candidate_name,d.candidate_spec,d.candidate_color,d.candidate_supplier,d.candidate_price,d.candidate_note,d.candidate_image_url
    FROM material_dev_requests r LEFT JOIN pre_orders p ON p.id=r.pre_order_id
    LEFT JOIN material_dev_rounds d ON d.request_id=r.id AND d.decision='approved'
    WHERE r.id=?`).get(id);
  if (!row || !scope.canSee(req.user, row)) return fail(res, 404, '新品开发申请不存在');
  if (row.status !== 'completed') return fail(res, 409, '面辅料新品尚未完成业务确认');
  if (!['pending', 'rejected'].includes(row.pattern_review_status)) return fail(res, 409, '当前申请不在打版准入审核状态');
  const b = req.body || {}, approve = !!b.approve, note = String(b.note || '').trim();
  if (!approve && !note) return fail(res, 400, '请填写退回原因');
  const user = actor(req), ts = now();
  let flowId = null, techPackId = row.tech_pack_id || null;
  // 同上：用 BEGIN/COMMIT，不用 db.transaction（node:sqlite 回退驱动没有该方法）
  db.exec('BEGIN IMMEDIATE');
  try {
    if (approve) {
      let tp = techPackId && db.prepare('SELECT * FROM tech_packs WHERE id=?').get(techPackId);
      if (!tp) {
        const materialSummary = [row.candidate_name, row.candidate_spec, row.candidate_color].filter(Boolean).join(' · ');
        const info = db.prepare(`INSERT INTO tech_packs(order_id,pre_order_id,product_name,version,fabric_info,accessory_info,customer_req,image_url,status,remark,created_by,created_at,updated_at)
          VALUES(?, ?, ?, 'V1', ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`).run(
          0, row.pre_order_id, row.pre_style || row.style_name || row.material_name,
          row.material_type === 'fabric' ? materialSummary : '', row.material_type === 'accessory' ? materialSummary : '',
          row.customer_requirements, row.candidate_image_url || row.reference_image_url || null,
          `由面辅料新品开发 ${row.request_no} 审核准入`, user.id, ts, ts
        );
        techPackId = Number(info.lastInsertRowid);
        saveMaterials(techPackId, [{
          material_id: row.accepted_material_id || null,
          mat_type: row.material_type,
          material_name: row.candidate_name || row.material_name,
          colorway: row.candidate_color || row.requested_color || '',
          color_no: row.candidate_color || row.requested_color || '',
          supplier: row.candidate_supplier || '',
          spec_info: row.candidate_spec || row.requested_spec || '',
          unit_price: row.candidate_price || 0,
          image_url: row.candidate_image_url || row.reference_image_url || '',
          remark: row.candidate_note || `面辅料新品开发 ${row.request_no} 已确认可用`
        }]);
      }
      const flow = ensureFlow(techPackId, user.id);
      flowId = Number(flow.id);
      db.prepare("UPDATE pattern_flows SET current_stage='pattern',status='running' WHERE id=?").run(flowId);
      db.prepare("UPDATE pattern_stages SET status='done',finished_at=?,operator=?,updated_at=? WHERE flow_id=? AND stage='material'").run(ts, user.name, ts, flowId);
      db.prepare("UPDATE pattern_stages SET status='doing',started_at=COALESCE(started_at,?),updated_at=? WHERE flow_id=? AND stage='pattern'").run(ts, ts, flowId);
      db.prepare("UPDATE tech_packs SET pre_order_id=?,stage='pattern',updated_at=? WHERE id=?").run(row.pre_order_id, ts, techPackId);
      db.prepare("UPDATE material_dev_requests SET pattern_review_status='approved',tech_pack_id=?,updated_at=? WHERE id=?").run(techPackId, ts, id);
    } else {
      db.prepare("UPDATE material_dev_requests SET pattern_review_status='rejected',updated_at=? WHERE id=?").run(ts, id);
    }
    db.prepare('INSERT INTO material_dev_pattern_reviews(request_id,decision,reviewer_id,reviewer_name,note,created_at,tech_pack_id) VALUES(?,?,?,?,?,?,?)')
      .run(id, approve ? 'approved' : 'rejected', user.id, user.name, note || null, ts, techPackId);
    event(id, null, approve ? 'pattern_entry_approved' : 'pattern_entry_rejected', user, note || '打版准入审核');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, { request: getRequest(id), tech_pack_id: techPackId, pattern_flow_id: flowId });
}));

router.put('/:id/resubmit-pattern-review', authRequired, requireRole(REQUEST), wrap(async (req, res) => {
  const id = Number(req.params.id), row = db.prepare('SELECT * FROM material_dev_requests WHERE id=?').get(id);
  if (!row || !scope.canSee(req.user, row)) return fail(res, 404, '新品开发申请不存在');
  if (row.status !== 'completed' || row.pattern_review_status !== 'rejected') return fail(res, 409, '只有已退回的打版准入申请可以补充后重提');
  const b = req.body || {};
  const type = ['fabric', 'accessory'].includes(b.material_type) ? b.material_type : '';
  const requirements = String(b.customer_requirements || '').trim();
  if (!type || !String(b.material_name || '').trim() || !requirements) return fail(res, 400, '面辅料类型、名称和客户要求为必填项');
  const referenceImageUrl = String(b.reference_image_url || '').trim();
  if (referenceImageUrl && !/^\/uploads\/[a-f0-9]{20}\.(png|jpg|webp|gif)$/i.test(referenceImageUrl)) return fail(res, 400, '客户参考图片地址无效，请重新上传');
  const user = actor(req), ts = now();
  db.prepare(`UPDATE material_dev_requests SET material_type=?,material_name=?,customer_requirements=?,requested_spec=?,requested_color=?,reference_image_url=?,pattern_review_status='pending',updated_at=? WHERE id=?`)
    .run(type, String(b.material_name).trim(), requirements, b.requested_spec || '', b.requested_color || '', referenceImageUrl || null, ts, id);
  db.prepare('INSERT INTO material_dev_pattern_reviews(request_id,decision,reviewer_id,reviewer_name,note,created_at,tech_pack_id) VALUES(?,?,?,?,?,?,?)')
    .run(id, 'resubmitted', user.id, user.name, '业务补充资料后重新提交打版准入审核', ts, row.tech_pack_id || null);
  event(id, null, 'pattern_entry_resubmitted', user, '业务补充资料后重新提交审核');
  return ok(res, getRequest(id));
}));

router.get('/:id', authRequired, requireRole(READ), wrap(async (req, res) => {
  const row = getRequest(Number(req.params.id));
  if (!row || !scope.canSee(req.user, row)) return fail(res, 404, '寻样申请不存在');
  return ok(res, row);
}));

module.exports = router;
