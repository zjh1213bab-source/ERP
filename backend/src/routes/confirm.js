/**
 * 客户订单与资料确认（对齐原型 TS-M22 N22-04 / 05 / 07）
 * ------------------------------------------------------------
 * N22-04 样衣封样确认
 *   - 客户确认 ≠ 总部技术批准：两条记录分开，缺一条都不算封样完成
 *   - 确认绑定「内容校验值」而不只是版本号；版本内容一变，校验值就变，需重新确认
 *   - 新版本创建后旧版本自动 superseded，旧版本的客户确认**不能**解除新版本的阻塞
 * N22-05 订单与工艺变更
 *   - 必经链路：影响评估 → 总部批准 → 客户双向确认 → 生产工位签收 → 生效
 *   - 变更只作用于「剩余范围」（总数 − 已交数量），不追溯已交付部分
 * N22-07 交期变动与物流跟踪
 *   - 原承诺日期与最新预计分开存，后者不覆盖前者
 *   - 物流事件区分 manual / api 来源并带核实标记，人工记录不冒充实时直连
 */
const crypto = require('crypto');
const express = require('express');
const { db, now } = require('../db');
const { nextNo } = require('../utils/docNo');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const mall = require('../services/mall');
const confirmation = require('../services/confirmation');
const scope = require('../access/companyScope');
const {ensureInstance,progressOf}=require('../services/approvals');

const router = express.Router();
const WRITE = ['admin', 'sales', 'tech', 'production'];
router.use(authRequired,(req,res,next)=>{
 const match=/^\/(seals|changes|deliveries|shipments)\/(\d+)(?:\/|$)/.exec(req.path);
 const tables={seals:'sample_seals',changes:'order_changes',deliveries:'delivery_changes',shipments:'shipment_events'};
 if(match){const row=db.prepare(`SELECT order_id FROM ${tables[match[1]]} WHERE id=?`).get(match[2]);if(row && row.order_id && !scope.assertOrder(req.user,row.order_id).ok)return fail(res,404,'记录不存在');}
 if(req.body?.order_id && !scope.assertOrder(req.user,req.body.order_id).ok)return fail(res,404,'订单不存在');
 next();
});

const SEAL_STATUS = {
  draft: '草稿', sent: '待客户确认', confirmed: '客户已确认',
  rejected: '客户要求修改', superseded: '已被新版本替代'
};
const CHANGE_STATUS = {
  draft: '草稿', assessing: '评估中', pending_customer: '待客户确认',
  confirmed: '客户已确认', effective: '已生效执行', rejected: '已驳回'
};
const CHANGE_TYPE = { craft: '工艺', qty: '数量', price: '价格', delivery: '交期', material: '面辅料' };
const DELIVERY_KIND = { etd: '预计出厂', eta_wh: '预计到仓', eta_customer: '预计送达' };
const DELIVERY_STATUS = { pending: '待客户确认', confirmed: '客户已确认', rejected: '客户不接受' };

/** 内容校验值：把影响外观与规格的字段一起算，任何一项变了都必须重新确认 */
function contentHash(seal) {
  const payload = JSON.stringify({
    style_no: seal.style_no || '',
    sample_name: seal.sample_name || '',
    version: seal.version || '',
    attachments: seal.attachments || '',
    remark: seal.remark || ''
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function orderBrief(orderId) {
  // 订单表没有 total_qty 字段，件数从明细尺码表汇总（与报表口径一致）
  return db.prepare(
    `SELECT o.id, o.order_no, o.style_name, o.customer_id, o.status, o.delivery_date,
            COALESCE((SELECT SUM(s.qty) FROM order_items i JOIN order_item_sizes s ON s.item_id = i.id
                      WHERE i.order_id = o.id), 0) AS total_qty,
            COALESCE(c.name, '散客') AS customer_name
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).get(orderId);
}

function customerAccountOf(customerId) {
  return db.prepare("SELECT * FROM customer_accounts WHERE customer_id = ? AND status = 'active' ORDER BY (role = 'owner') DESC LIMIT 1")
    .get(customerId);
}

// ============================================================
// N22-04 样衣封样
// ============================================================
function sealView(r) {
  const latest = db.prepare(
    `SELECT id FROM sample_seals WHERE order_id IS ? AND COALESCE(order_item_id,0)=? AND COALESCE(style_no,'')=? ORDER BY id DESC LIMIT 1`
  ).get(r.order_id || null,r.order_item_id || 0,r.style_no || '');
  return {
    ...r,
    status_label: SEAL_STATUS[r.status] || r.status,
    is_latest: latest && Number(latest.id) === Number(r.id),
    // 阻塞解除条件：最新版本 + 客户已确认 + 技术已批准
    stale: (()=>{try{confirmation.checkSealContent(r);return false;}catch{return true;}})(),
    blocked: !(r.status === 'confirmed' && Number(r.tech_approved) === 1 && latest && Number(latest.id) === Number(r.id)),
    attachments: safeJson(r.attachments)
  };
}

function safeJson(t) {
  if (!t) return [];
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

router.get('/sources/:orderId',authRequired,wrap(async(req,res)=>{
 const result=scope.assertOrder(req.user,req.params.orderId);if(!result.ok)return fail(res,404,result.reason);
 const items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(req.params.orderId);
 const archives=db.prepare('SELECT a.*,tp.order_item_id FROM sample_archives a JOIN tech_packs tp ON tp.id=a.tech_pack_id WHERE a.order_id=? ORDER BY a.id DESC').all(req.params.orderId);
 const order=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.orderId);
 const techpacks=db.prepare('SELECT id,product_name,customer_style_no,order_item_id FROM tech_packs WHERE order_id=? OR (pre_order_id=? AND (order_id=0 OR order_id IS NULL))').all(order.id,order.source_pre_order_id || 0);
 return ok(res,{items,archives,techpacks,gate:sealGate(req.params.orderId)});
}));

router.post('/sources/:orderId/link',authRequired,requireRole(['admin','sales','tech']),wrap(async(req,res)=>{
 if(!scope.assertOrder(req.user,req.params.orderId).ok)return fail(res,404,'订单不存在');
 db.exec('BEGIN IMMEDIATE');try{confirmation.linkDevelopment(Number(req.params.orderId),Number(req.body?.order_item_id),Number(req.body?.tech_pack_id));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 return ok(res,{linked:true});
}));

router.get('/seals', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.order_id) { cond.push('s.order_id = ?'); params.push(Number(req.query.order_id)); }
  if (req.query.status) { cond.push('s.status = ?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT s.*, o.order_no, COALESCE(c.name, '散客') AS customer_name
     FROM sample_seals s LEFT JOIN orders o ON o.id = s.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows.filter(r=>scope.assertOrder(req.user,r.order_id).ok).map(sealView));
}));

/** 查询某订单的封样门槛状态：给前端展示「为什么还不能推进」 */
router.get('/seals/gate/:orderId', authRequired, wrap(async (req, res) => {
  if(!scope.assertOrder(req.user,req.params.orderId).ok)return fail(res,404,'订单不存在');
  const gate = sealGate(req.params.orderId);
  const latest = db.prepare('SELECT * FROM sample_seals WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(req.params.orderId);
  return ok(res, {
    ok: gate.ok,
    message: gate.message || null,
    latest: latest ? sealView(latest) : null
  });
}));

router.get('/seals/:id', authRequired, wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM sample_seals WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '样衣封样记录不存在');
  return ok(res, sealView(r));
}));

/**
 * 创建封样版本
 * - 同订单同款自动递增 V1/V2...
 * - 新版本创建后，旧版本立即置 superseded（旧确认不再有效）
 */
router.post('/seals', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.order_id && !b.tech_pack_id) return fail(res, 400, '请选择订单或开发单');
  if (b.order_id) {
    const o = orderBrief(b.order_id);
    if (!o) return fail(res, 404, '订单不存在');
  }
  const orderId=Number(b.order_id);
  if (!orderId || !scope.assertOrder(req.user,orderId).ok) return fail(res,404,'请选择有权访问的正式订单');
  const items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
  const item=items.find(i=>i.id===Number(b.order_item_id)) || (items.length===1?items[0]:null);
  if(!item)return fail(res,400,'多款订单须选择具体款式');
  const styleNo=item.style_no || item.product_name;
  const archiveId=Number(b.archive_id)||null;
  const snapshot=JSON.stringify(confirmation.sourceSnapshot(orderId,item.id,archiveId));
  const prior=db.prepare('SELECT id,version FROM sample_seals WHERE order_id=? AND order_item_id=?').all(orderId,item.id);
  const version='V'+(Math.max(0,...prior.map(r=>Number(/^V(\d+)$/.exec(r.version)?.[1])||0))+1);

  const t = now();
  const sealNo = nextNo('SY', 'sample_seals', 'seal_no');
  const attachments = JSON.stringify(Array.isArray(b.attachments) ? b.attachments : []);
  const hash = confirmation.digest({style_no:styleNo,sample_name:b.sample_name || '',version,attachments,remark:b.remark || '',snapshot});

  try {
    db.exec('BEGIN');
    const latest=db.prepare('SELECT id FROM sample_seals WHERE order_id=? AND order_item_id=? ORDER BY id DESC LIMIT 1').get(orderId,item.id);
    if((latest?.id || 0)!==Math.max(0,...prior.map(r=>r.id)))throw Object.assign(new Error('封样版本已被其他人更新，请刷新后重试'),{status:409});
    // 旧版本一律置为已被替代，避免「V1 已确认」被当成新版本已通过
    db.prepare(
      `UPDATE sample_seals SET status='superseded', updated_at=?
       WHERE order_id IS ? AND (order_item_id=? OR (order_item_id IS NULL AND COALESCE(style_no,'')=?)) AND status != 'superseded'`
    ).run(t,orderId,item.id,styleNo);

    const r = db.prepare(
      `INSERT INTO sample_seals (seal_no, order_id, tech_pack_id, style_no, sample_name, version, content_hash,
         attachments, status, remark, created_by, created_at, updated_at,order_item_id,archive_id,snapshot_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(sealNo, b.order_id || null, b.tech_pack_id || null, styleNo, b.sample_name || null, version,
      hash, attachments, 'draft', b.remark || null, req.user.username, t, t,item.id,archiveId,snapshot);
    db.exec('COMMIT');
    return ok(res, sealView(db.prepare('SELECT * FROM sample_seals WHERE id = ?').get(r.lastInsertRowid)));
  } catch (e) {
    db.exec('ROLLBACK');
    return fail(res, e.status || 400, e.message);
  }
}));

/** 发样给客户确认：推商城站内信，客户在商城签署 */
router.post('/seals/:id/send', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM sample_seals WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '样衣封样记录不存在');
  if(req.body?.row_version!==r.row_version)return fail(res,409,'封样已更新，请刷新');
  confirmation.checkSealContent(r);
  if (r.status === 'superseded') return fail(res, 400, '该版本已被新版本替代，不能再发样');
  if (r.status === 'confirmed') return fail(res, 400, '客户已确认，无需重复发送');
  if (!Number(r.tech_approved)) return fail(res, 400, '总部技术尚未批准，不能发给客户确认');

  db.prepare("UPDATE sample_seals SET row_version=row_version+1,status='sent', sent_at=?, updated_at=? WHERE id=?").run(now(), now(), r.id);

  const o = r.order_id ? orderBrief(r.order_id) : null;
  if (o && o.customer_id) {
    const acct = customerAccountOf(o.customer_id);
    if (acct) {
      mall.pushMessage({
        customerId: o.customer_id,
        type: 'order',
        title: `样衣待确认：${r.version}`,
        body: `订单 ${o.order_no} 的样衣「${r.sample_name || r.style_no || ''}」${r.version} 已发出，请登录商城查看附件并确认（内容校验值 ${r.content_hash}）。`,
        refType: 'sample_seal',
        refId: r.id
      });
    }
  }
  return ok(res, sealView(db.prepare('SELECT * FROM sample_seals WHERE id = ?').get(r.id)));
}));

/** 总部技术批准（独立于客户确认） */
router.post('/seals/:id/tech-approve', authRequired, requireRole(['admin','tech']), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM sample_seals WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '样衣封样记录不存在');
  if(req.body?.row_version!==r.row_version)return fail(res,409,'封样已更新，请刷新');
  confirmation.checkSealContent(r);
  if (r.status === 'superseded') return fail(res, 400, '该版本已被新版本替代');
  db.prepare("UPDATE sample_seals SET row_version=row_version+1,tech_approved=1, tech_approved_by=?, tech_approved_at=?, updated_at=? WHERE id=?")
    .run(req.user.username, now(), now(), r.id);
  return ok(res, sealView(db.prepare('SELECT * FROM sample_seals WHERE id = ?').get(r.id)));
}));

/** 内部登记客户提出修改（线下沟通后补录，客户线上确认走商城接口） */
router.post('/seals/:id/reject', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM sample_seals WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '样衣封样记录不存在');
  if(req.body?.row_version!==r.row_version)return fail(res,409,'封样已更新，请刷新');
  confirmation.checkSealContent(r);
  if (r.status === 'superseded') return fail(res, 400, '该版本已被新版本替代');
  db.prepare("UPDATE sample_seals SET row_version=row_version+1,status='rejected', customer_comment=?, updated_at=? WHERE id=?")
    .run((req.body && req.body.comment) || '客户要求修改', now(), r.id);
  return ok(res, sealView(db.prepare('SELECT * FROM sample_seals WHERE id = ?').get(r.id)));
}));

router.delete('/seals/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM sample_seals WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '样衣封样记录不存在');
  if (r.status === 'confirmed') return fail(res, 400, '客户已确认的记录不能删除，请创建新版本');
  db.prepare('DELETE FROM sample_seals WHERE id = ?').run(r.id);
  return ok(res, { deleted: 1 });
}));

/**
 * 封样门槛（供订单流转复用）
 * 规则：只要该订单建过封样记录，最新版本必须「客户已确认 + 技术已批准」。
 * 旧版本的已确认状态不算数——因为新版本创建时旧版本已被置 superseded。
 */
function sealGate(orderId) { return confirmation.sealGate(Number(orderId)); }

// ============================================================
// N22-05 订单与工艺变更
// ============================================================
function changeView(r) {
  return {
    ...r,
    status_label: CHANGE_STATUS[r.status] || r.status,
    type_label: CHANGE_TYPE[r.type] || r.type,
    before: safeObj(r.before_json),
    after: safeObj(r.after_json),
    patch: safeObj(r.patch_json),
    approval: progressOf('order_change',r.id),
    customer_confirmed: r.status === 'confirmed' || r.status === 'effective',
    // 客户确认 + 工位签收才算真正执行（已生效即已签收）
    executable: (r.status === 'confirmed' && Number(r.workstation_signed) === 1) || r.status === 'effective'
  };
}

function safeObj(t) {
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
}

router.get('/changes', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.order_id) { cond.push('g.order_id = ?'); params.push(Number(req.query.order_id)); }
  if (req.query.status) { cond.push('g.status = ?'); params.push(req.query.status); }
  if (req.query.type) { cond.push('g.type = ?'); params.push(req.query.type); }
  const rows = db.prepare(
    `SELECT g.*, o.order_no, o.style_name, COALESCE(c.name, '散客') AS customer_name
     FROM order_changes g LEFT JOIN orders o ON o.id = g.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY g.id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows.filter(r=>scope.assertOrder(req.user,r.order_id).ok).map(changeView));
}));

router.get('/changes/:id', authRequired, wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM order_changes WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '变更单不存在');
  return ok(res, changeView(r));
}));

/** 新建变更：自动带出已交数量与剩余可变更范围 */
router.post('/changes', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.order_id) return fail(res, 400, '请选择订单');
  if (!b.title) return fail(res, 400, '请填写变更内容');
  const o = orderBrief(b.order_id);
  if (!o) return fail(res, 404, '订单不存在');

  // 已交数量：该订单已发货出库的件数（从库存流水取绝对值）
  const shipped = Number(db.prepare(
    "SELECT COALESCE(SUM(-qty),0) AS q FROM stock_ledger WHERE ref_type='order' AND ref_id = ? AND type='out'"
  ).get(o.id).q) || 0;
  const total = Number(o.total_qty) || 0;


  if(String(b.title).trim().length>500 || String(b.assess_note || '').length>4000)return fail(res,400,'变更标题或评估说明过长');
  for(const key of ['affected_in_production','cost_delta','price_delta','delivery_delta_days'])if(b[key]!=null && !Number.isFinite(Number(b[key])))return fail(res,400,'影响评估数字无效');
  const patch=confirmation.preparePatch(o.id,b.type || 'craft',b.patch);
  const t = now();
  const no = nextNo('BG', 'order_changes', 'change_no');
  const r = db.prepare(
    `INSERT INTO order_changes (change_no, order_id, type, title, before_json, after_json,
       affected_in_production, affected_materials, delivered_qty, remaining_qty, cost_delta, price_delta,
       delivery_delta_days, status, created_by, created_at, updated_at,patch_json,assess_note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(no, o.id, b.type || 'craft', String(b.title).trim(),
    JSON.stringify(patch.target),JSON.stringify(patch.next),
    Number(b.affected_in_production) || 0, b.affected_materials || null,
    shipped, Math.max(0,total-shipped), Number(b.cost_delta) || 0, Number(b.price_delta) || 0,
    Number(b.delivery_delta_days) || 0, 'draft', req.user.username, t, t,JSON.stringify(patch),String(b.assess_note || '').trim());
  return ok(res, changeView(db.prepare('SELECT * FROM order_changes WHERE id = ?').get(r.lastInsertRowid)));
}));

/** 影响评估（必填项齐全才能提交客户确认） */
router.put('/changes/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM order_changes WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '变更单不存在');
  if (!['draft','assessing','rejected'].includes(r.status) || progressOf('order_change',r.id)?.status==='pending') return fail(res,409,'审批或客户确认期间不能改评估，请先驳回');
  if(req.body?.row_version!==r.row_version)return fail(res,409,'变更单已更新，请刷新');
  const b = req.body || {};
  const num = (k, cur) => (b[k] !== undefined && b[k] !== null && b[k] !== '' ? Number(b[k]) || 0 : cur);
  const nextStatus = 'assessing';
  const patch=confirmation.preparePatch(r.order_id,b.type || r.type,b.patch || safeObj(r.patch_json)?.next);
  if (!CHANGE_STATUS[nextStatus]) return fail(res, 400, '状态不合法');

  db.prepare(
    `UPDATE order_changes SET title=?, type=?, before_json=?, after_json=?, affected_in_production=?,
       affected_materials=?, delivered_qty=?, remaining_qty=?, cost_delta=?, price_delta=?,
       delivery_delta_days=?, assess_note=?, status=?, updated_at=?,patch_json=?,row_version=row_version+1 WHERE id=? AND row_version=?`
  ).run(
    b.title || r.title, b.type || r.type,
    JSON.stringify(patch.target),JSON.stringify(patch.next),
    num('affected_in_production', r.affected_in_production), b.affected_materials ?? r.affected_materials,
    r.delivered_qty,r.remaining_qty,
    num('cost_delta', r.cost_delta), num('price_delta', r.price_delta),
    num('delivery_delta_days', r.delivery_delta_days), b.assess_note ?? r.assess_note,
    nextStatus, now(),JSON.stringify(patch), r.id,r.row_version
  );
  return ok(res, changeView(db.prepare('SELECT * FROM order_changes WHERE id = ?').get(r.id)));
}));

/** 总部批准并推送客户确认：必须已做影响评估 */
router.post('/changes/:id/approve',authRequired,requireRole(WRITE),wrap(async(req,res)=>{
 const row=db.prepare('SELECT * FROM order_changes WHERE id=?').get(req.params.id);
 if(!row)return fail(res,404,'变更单不存在');
 if(req.body?.row_version!==row.row_version)return fail(res,409,'变更单已更新，请刷新');
 if(!['draft','assessing'].includes(row.status) || progressOf('order_change',row.id)?.status==='pending')return fail(res,409,'不能重复提交审批');
 if(!String(row.assess_note || '').trim())return fail(res,400,'请先填写影响评估说明');
 const p=safeObj(row.patch_json);confirmation.preparePatch(row.order_id,row.type,p?.next);
 db.exec('BEGIN IMMEDIATE');try {
  const changed=db.prepare("UPDATE order_changes SET status='assessing',row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?").run(now(),row.id,row.row_version);
  if(!changed.changes)throw Object.assign(new Error('变更单已更新'),{status:409});
  ensureInstance('order_change',row.id,Math.abs(Number(row.price_delta)||0));
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return ok(res,changeView(db.prepare('SELECT * FROM order_changes WHERE id=?').get(row.id)));
}));

router.post('/changes/:id/sign',authRequired,requireRole(['admin','production']),wrap(async(req,res)=>{
 const row=db.prepare('SELECT * FROM order_changes WHERE id=?').get(req.params.id);
 if(!row)return fail(res,404,'变更单不存在');
 if(req.body?.row_version!==row.row_version || row.status!=='confirmed')return fail(res,409,'客户尚未确认、已执行或版本已更新');
 const progress=progressOf('order_change',row.id);
 if(progress?.status!=='approved')return fail(res,409,'需先完成统一审批流程');
 db.exec('BEGIN IMMEDIATE');try {
  const snapshot=confirmation.applyChange(row,req.user);
  const result=db.prepare("UPDATE order_changes SET workstation_signed=1,signed_by=?,signed_at=?,status='effective',applied_snapshot=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=? AND status='confirmed'")
    .run(req.user.username,now(),snapshot,now(),row.id,row.row_version);
  if(!result.changes)throw Object.assign(new Error('变更单已更新'),{status:409});
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return ok(res,changeView(db.prepare('SELECT * FROM order_changes WHERE id=?').get(row.id)));
}));

router.post('/changes/:id/reject', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM order_changes WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '变更单不存在');
  if (r.status === 'effective') return fail(res, 400, '已执行，不能驳回');
  if(progressOf('order_change',r.id)?.status==='pending')return fail(res,409,'请到审批中心处理当前审批任务');
  db.prepare("UPDATE order_changes SET status='rejected', assess_note=COALESCE(?, assess_note), updated_at=? WHERE id=?")
    .run((req.body && req.body.reason) || null, now(), r.id);
  return ok(res, changeView(db.prepare('SELECT * FROM order_changes WHERE id = ?').get(r.id)));
}));

// ============================================================
// N22-07 交期变动与物流跟踪
// ============================================================
function deliveryView(r, o) {
  const days = r.promised_date && r.new_date
    ? Math.round((new Date(r.new_date).getTime() - new Date(r.promised_date).getTime()) / 86400000)
    : null;
  return {
    ...r,
    kind_label: DELIVERY_KIND[r.kind] || r.kind,
    status_label: DELIVERY_STATUS[r.status] || r.status,
    delay_days: days,
    order_no: o ? o.order_no : null,
    customer_name: o ? o.customer_name : null
  };
}

router.get('/deliveries', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.order_id) { cond.push('d.order_id = ?'); params.push(Number(req.query.order_id)); }
  if (req.query.status) { cond.push('d.status = ?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT d.*, o.order_no, COALESCE(c.name, '散客') AS customer_name
     FROM delivery_changes d LEFT JOIN orders o ON o.id = d.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY d.id DESC LIMIT 200`
  ).all(...params);
  return ok(res, rows.filter(r=>scope.assertOrder(req.user,r.order_id).ok).map((r) => deliveryView(r, { order_no: r.order_no, customer_name: r.customer_name })));
}));

/** 登记交期变动：原承诺从订单带出且不被覆盖 */
router.post('/deliveries', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.order_id) return fail(res, 400, '请选择订单');
  if (!b.new_date) return fail(res, 400, '请填写最新预计日期');
  const o = orderBrief(b.order_id);
  if (!o) return fail(res, 404, '订单不存在');
  confirmation.preparePatch(o.id,'delivery',{new_date:b.new_date});
  if(!DELIVERY_KIND[b.kind || 'etd'])return fail(res,400,'交期类型无效');
  const promised = o.delivery_date || null;
  const t = now();
  const r = db.prepare(
    `INSERT INTO delivery_changes (order_id, promised_date, new_date, kind, reason, source, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(o.id, promised, b.new_date, b.kind || 'etd', b.reason || null,
    'manual', 'pending', req.user.username, t, t);

  if (o.customer_id) {
    const acct = customerAccountOf(o.customer_id);
    if (acct) {
      const delay = promised ? Math.round((new Date(b.new_date) - new Date(promised)) / 86400000) : null;
      mall.pushMessage({
        customerId: o.customer_id,
        type: 'order',
        title: '交期变动待确认',
        body: `订单 ${o.order_no} 的${DELIVERY_KIND[b.kind || 'etd']}日期由 ${promised || '未定'} 调整为 ${b.new_date}${delay !== null ? `（${delay > 0 ? '延后' : '提前'} ${Math.abs(delay)} 天）` : ''}。原因：${b.reason || '以业务沟通为准'}。请登录商城确认。`,
        refType: 'delivery_change',
        refId: r.lastInsertRowid
      });
    }
  }
  return ok(res, deliveryView(
    db.prepare('SELECT * FROM delivery_changes WHERE id = ?').get(r.lastInsertRowid),
    { order_no: o.order_no, customer_name: o.customer_name }
  ));
}));

/** 内部代录客户确认（线下已获同意时使用） */
router.post('/deliveries/:id/confirm', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM delivery_changes WHERE id = ?').get(req.params.id);
  if(r?.source_change_id)return fail(res,409,'此交期关联订单变更，请从订单变更完成客户确认和工位签收');
  if (!r) return fail(res, 404, '交期变动记录不存在');
  const b = req.body || {};
  confirmation.confirmDelivery(r.id,b.accepted!==false && b.accepted!==0,b.by || req.user.username,b.comment);
  const o = orderBrief(r.order_id);
  return ok(res, deliveryView(
    db.prepare('SELECT * FROM delivery_changes WHERE id = ?').get(r.id),
    { order_no: o.order_no, customer_name: o.customer_name }
  ));
}));

// ---------- 物流事件 ----------
function eventView(r) {
  return {
    ...r,
    source_label: r.source === 'api' ? '接口同步' : '人工登记',
    verified_label: Number(r.verified) ? '已核实' : '待核实'
  };
}

router.get('/shipments', authRequired, wrap(async (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.order_id) { cond.push('e.order_id = ?'); params.push(Number(req.query.order_id)); }
  const rows = db.prepare(
    `SELECT e.*, o.order_no FROM shipment_events e LEFT JOIN orders o ON o.id = e.order_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY COALESCE(e.event_time, e.created_at) DESC, e.id DESC LIMIT 300`
  ).all(...params);
  return ok(res, rows.filter(r=>scope.assertOrder(req.user,r.order_id).ok).map(eventView));
}));

router.post('/shipments', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.order_id) return fail(res, 400, '请选择订单');
  if (!b.status_text) return fail(res, 400, '请填写物流状态');
  const o = orderBrief(b.order_id);
  if (!o) return fail(res, 404, '订单不存在');
  const r = db.prepare(
    `INSERT INTO shipment_events (order_id, carrier, tracking_no, event_time, status_text, location,
       source, verified, visible, remark, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(o.id, b.carrier || null, b.tracking_no || null, b.event_time || now(), b.status_text,
    b.location || null, b.source === 'api' ? 'api' : 'manual', b.verified ? 1 : 0,
    b.visible === false ? 0 : 1, b.remark || null, req.user.username, now());
  return ok(res, eventView(db.prepare('SELECT * FROM shipment_events WHERE id = ?').get(r.lastInsertRowid)));
}));

router.post('/shipments/:id/verify', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM shipment_events WHERE id = ?').get(req.params.id);
  if (!r) return fail(res, 404, '物流事件不存在');
  db.prepare('UPDATE shipment_events SET verified=1 WHERE id=?').run(r.id);
  return ok(res, eventView(db.prepare('SELECT * FROM shipment_events WHERE id = ?').get(r.id)));
}));

router.delete('/shipments/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  db.prepare('DELETE FROM shipment_events WHERE id = ?').run(req.params.id);
  return ok(res, { deleted: 1 });
}));

// ============================================================
// 概览
// ============================================================
router.get('/stats', authRequired, wrap(async (req, res) => {
  const sc=scope.clause(req.user,'company_id');
  const owned=`order_id IN (SELECT id FROM orders WHERE 1=1 ${sc.sql})`;
  const seals = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS waiting_customer,
       SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
       SUM(CASE WHEN status = 'confirmed' AND tech_approved = 1 THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
     FROM sample_seals WHERE ${owned}`
  ).get(...sc.params);
  const changes = db.prepare(
    `SELECT
       SUM(CASE WHEN status IN ('draft','assessing') THEN 1 ELSE 0 END) AS assessing,
       SUM(CASE WHEN status = 'pending_customer' THEN 1 ELSE 0 END) AS waiting_customer,
       SUM(CASE WHEN status = 'confirmed' AND workstation_signed = 0 THEN 1 ELSE 0 END) AS waiting_sign,
       SUM(CASE WHEN status = 'effective' THEN 1 ELSE 0 END) AS effective
     FROM order_changes WHERE ${owned}`
  ).get(...sc.params);
  const deliveries = db.prepare(
    `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
     FROM delivery_changes WHERE ${owned}`
  ).get(...sc.params);
  const shipments = db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) AS manual,
            SUM(CASE WHEN verified = 0 THEN 1 ELSE 0 END) AS unverified FROM shipment_events WHERE ${owned}`
  ).get(...sc.params);

  // 已延期订单：原承诺已过且未发货
  const today = new Date().toISOString().slice(0, 10);
  const overdue = db.prepare(
    `SELECT COUNT(*) AS c FROM orders
     WHERE delivery_date IS NOT NULL AND delivery_date < ?
       AND status NOT IN ('shipped','closed','cancelled') ${sc.sql}`
  ).get(today,...sc.params).c;

  return ok(res, {
    seals: {
      waiting_customer: Number(seals.waiting_customer) || 0,
      draft: Number(seals.draft) || 0,
      done: Number(seals.done) || 0,
      rejected: Number(seals.rejected) || 0
    },
    changes: {
      assessing: Number(changes.assessing) || 0,
      waiting_customer: Number(changes.waiting_customer) || 0,
      waiting_sign: Number(changes.waiting_sign) || 0,
      effective: Number(changes.effective) || 0
    },
    deliveries: { pending: Number(deliveries.pending) || 0, rejected: Number(deliveries.rejected) || 0 },
    shipments: {
      total: Number(shipments.total) || 0,
      manual: Number(shipments.manual) || 0,
      unverified: Number(shipments.unverified) || 0
    },
    overdue_orders: Number(overdue) || 0,
    warnings: [
      Number(seals.waiting_customer) > 0 ? `${seals.waiting_customer} 份样衣等待客户确认，未双确认会阻塞订单「技术确认」` : null,
      Number(changes.waiting_sign) > 0 ? `${changes.waiting_sign} 项变更客户已确认但工位未签收，尚未真正执行` : null,
      Number(deliveries.pending) > 0 ? `${deliveries.pending} 条交期变动待客户确认（原承诺保持不变）` : null,
      Number(shipments.unverified) > 0 ? `${shipments.unverified} 条物流事件待核实，客户侧会标注「待核实」` : null,
      Number(overdue) > 0 ? `${overdue} 张订单已过承诺交期仍未发货` : null
    ].filter(Boolean)
  });
}));

module.exports = router;
module.exports.sealGate = sealGate;
module.exports.SEAL_STATUS = SEAL_STATUS;
module.exports.CHANGE_STATUS = CHANGE_STATUS;
