/**
 * 打版流程（面辅料确认 → 制版 → 工艺/工序明细 → 车板做样衣 → 业务确认样 → 工序审核·工价核价）
 *
 * 设计要点：
 * 1) 一个开发单一条流程实例，每个阶段一行记录（内容 / 责任人 / 时长 / 状态）
 * 2) 阶段按顺序推进，前置未完成不能做下一步
 * 3) 每个阶段有独立写权限（角色不同），后端强制校验，前端按钮只是提示
 * 4) 六个阶段全部完成 → 流程 done，并把样衣归档到「样衣管理」，档案锁定不可改
 *
 * GET    /api/pattern-flows/board                 看板数据（全部流程 + 阶段）
 * GET    /api/pattern-flows/by-techpack/:tpId     按开发单取
 * POST   /api/pattern-flows/ensure                确保流程存在（幂等）{tech_pack_id}
 * PUT    /api/pattern-flows/:flowId/stage/:stage  保存阶段内容
 * POST   /api/pattern-flows/:flowId/stage/:stage/done    完成该阶段
 * POST   /api/pattern-flows/:flowId/stage/:stage/reopen  退回重做
 * POST   /api/pattern-flows/:flowId/finish        完成流程并归档样衣
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { archiveFromFlow } = require('../services/sampleArchive');
const { saveMaterials } = require('../services/techPackMaterials');
const { normalizeCraftRows, validateCraftData } = require('../services/craftRows');

const router = express.Router();

/** 阶段定义：顺序 + 可写角色 + 卡片展示字段说明 */
const STAGE_DEF = [
  { key: 'material', label: '面辅料确认', roles: ['admin', 'tech'] },
  { key: 'pattern', label: '制版', roles: ['admin', 'tech'] },
  { key: 'craft', label: '工艺/工序明细', roles: ['admin', 'tech'] },
  { key: 'sample', label: '车板做样衣', roles: ['admin', 'tech', 'production'] },
  { key: 'biz', label: '业务确认样', roles: ['admin', 'sales'] },
  { key: 'audit', label: '工序审核 / 工价核价', roles: ['admin', 'finance', 'production'] }
];
const STAGE_KEYS = STAGE_DEF.map((s) => s.key);
const stageDef = (k) => STAGE_DEF.find((s) => s.key === k);
const revision=require('../services/developmentRevision');
const CHANGE_FIELDS = {
  development_revision:'业务开发资料改版',
  development_submission:'开发资料准入审核',
  customer_req: '客户要求', fabric_info: '面料信息', accessory_info: '辅料信息',
  craft_info: '工艺要求', size_spec: '尺码规格'
};

function changeHold(flowId) {
  return db.prepare("SELECT * FROM pattern_change_requests WHERE flow_id=? AND status IN ('pending','editing','awaiting_recheck') ORDER BY id DESC").all(flowId);
}

function canWrite(user, stage) {
  const d = stageDef(stage);
  if (!d) return false;
  return user.role === 'admin' || user.positionDirect || d.roles.includes(user.role);
}

/** 取流程 + 阶段（阶段不存在则补一行 pending） */
function ensureStages(flowId) {
  const t = now();
  const ins = db.prepare(
    'INSERT OR IGNORE INTO pattern_stages (flow_id, stage, status, updated_at) VALUES (?,?,?,?)'
  );
  STAGE_KEYS.forEach((k) => ins.run(flowId, k, 'pending', t));
}

function loadFlow(flowId) {
  const flow = db.prepare('SELECT * FROM pattern_flows WHERE id = ?').get(flowId);
  if (!flow) return null;
  ensureStages(flow.id);
  const rows = db.prepare('SELECT * FROM pattern_stages WHERE flow_id = ?').all(flow.id);
  const map = {};
  rows.forEach((r) => (map[r.stage] = r));
  flow.stages = STAGE_KEYS.map((k) => {
    const r = map[k] || {};
    return {
      stage: k,
      label: stageDef(k).label,
      status: r.status || 'pending',
      owner: r.owner || '',
      work_hours: r.work_hours || 0,
      actual_hours: r.actual_hours || 0,
      due_date: r.due_date || '',
      price: r.price || 0,
      pattern_size: r.pattern_size || '',
      label_name: r.label_name || '',
      remark: r.remark || '',
      data: r.data ? safeJson(r.data) : {},
      operator: r.operator || '',
      started_at: r.started_at || null,
      finished_at: r.finished_at || null
    };
  });
  flow.stage_map = Object.fromEntries(flow.stages.map((s) => [s.stage, s]));
  return flow;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}

/** 看板：带开发单 / 订单 / 客户信息 */
function boardRows() {
  const rows = db.prepare(
    `SELECT pf.*, tp.product_name, tp.version, tp.stage AS tp_stage, tp.status AS tp_status,
            tp.image_url, tp.customer_style_no,tp.updated_at AS style_no_version, tp.category,tp.pre_order_id,
            COALESCE(o.order_no,p.pre_order_no) AS order_no,p.pre_order_no,
            COALESCE(o.style_name,p.style_name) AS style_name, o.delivery_date, o.type AS order_type, o.status AS order_status,
            COALESCE(c.name,p.customer_name) AS customer_name
     FROM pattern_flows pf
     JOIN tech_packs tp ON tp.id = pf.tech_pack_id
     LEFT JOIN orders o ON o.id = pf.order_id
     LEFT JOIN pre_orders p ON p.id = tp.pre_order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     ORDER BY pf.id DESC`
  ).all();
  return rows.map((r) => {
    const flow = loadFlow(r.id);
    return {
      ...r,
      stages: flow.stages,
      stage_map: flow.stage_map,
      change_requests: db.prepare('SELECT * FROM pattern_change_requests WHERE flow_id=? ORDER BY id DESC').all(r.id),
      change_hold: changeHold(r.id).length > 0,
      total: STAGE_KEYS.length,
      done_count: flow.stages.filter((s) => s.status === 'done').length
    };
  });
}

router.get('/management',authRequired,wrap(async(req,res)=>{const mg=require('../services/patternManagement'),config=mg.read(req.user);const permitted=boardRows().filter(f=>{try{mg.owns(req.user,f.id);return true;}catch{return false;}});config.tasks=Object.fromEntries(Object.entries(config.tasks).filter(([id])=>permitted.some(f=>f.id===Number(id))));return ok(res,{config,flows:permitted,stages:STAGE_DEF});}));
router.put('/management',authRequired,requireRole(['admin']),wrap(async(req,res)=>ok(res,require('../services/patternManagement').config(req.user,req.body,STAGE_DEF))));
router.post('/:flowId/follow',authRequired,requireRole(['admin','tech','sales','production']),wrap(async(req,res)=>{const r=require('../services/patternManagement').follow(req.user,Number(req.params.flowId),req.body);return ok(res,{version:r.version});}));
router.get('/board', authRequired, wrap(async (req, res) => {
  const mg=require('../services/patternManagement'),config=mg.read(req.user);return ok(res, { stages: STAGE_DEF.map(s=>({...s,label:config.stages.find(c=>c.key===s.key)?.label||s.label})), flows: boardRows().filter(f=>{try{mg.owns(req.user,f.id);return true;}catch{return false;}}) });
}));

router.get('/by-techpack/:tpId', authRequired, wrap(async (req, res) => {
  const flow = db.prepare('SELECT * FROM pattern_flows WHERE tech_pack_id = ?').get(req.params.tpId);
  if (!flow) return ok(res, null);
  return ok(res, loadFlow(flow.id));
}));

router.post('/:flowId/changes', authRequired, requireRole(['admin', 'sales']), wrap(async (req, res) => {
  const flow = db.prepare('SELECT * FROM pattern_flows WHERE id=?').get(req.params.flowId);
  if (!flow || flow.status === 'done') return fail(res, 404, '进行中的打版流程不存在');
  if (changeHold(flow.id).length) return fail(res, 409, '该流程已有待审核或待复核的修改申请');
  const b = req.body || {};
  if(['development_revision','development_submission'].includes(b.field_key))return fail(res,400,'请从开发管理申请修改资料');
  if (!CHANGE_FIELDS[b.field_key]) return fail(res, 400, '请选择可申请修改的信息项');
  if (b.proposed_value === undefined) return fail(res, 400, '请填写修改后的内容');
  const reason = String(b.reason || '').trim();
  if (!reason) return fail(res, 400, '请填写修改原因');
  const tp = db.prepare('SELECT * FROM tech_packs WHERE id=?').get(flow.tech_pack_id);
  const ts = now();
  const info = db.prepare(`INSERT INTO pattern_change_requests(flow_id,field_key,before_value,proposed_value,reason,applicant,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'pending',?,?)`).run(flow.id, b.field_key, tp[b.field_key] || '', String(b.proposed_value), reason, req.user.name || req.user.username, ts, ts);
  return ok(res, db.prepare('SELECT * FROM pattern_change_requests WHERE id=?').get(Number(info.lastInsertRowid)));
}));

router.post('/changes/:id/review', authRequired, requireRole(['admin', 'tech']), wrap(async (req, res) => {
  const change = db.prepare('SELECT * FROM pattern_change_requests WHERE id=?').get(req.params.id);
  if (!change) return fail(res, 404, '打版修改申请不存在');
  if (change.status !== 'pending') return fail(res, 409, '该修改申请已审核');
  if (change.applicant === (req.user.name || req.user.username) && req.user.role !== 'admin') return fail(res, 403, '申请人不能审核自己的修改');
  const approve = !!req.body?.approve, note = String(req.body?.note || '').trim();
  if (!approve && !note) return fail(res, 400, '请填写驳回原因');
  const ts = now(), user = req.user.name || req.user.username;
  /**
   * 字段名要拼进 SQL，用前**再校验一次**白名单。
   * 写入时（POST /:flowId/changes）已经校验过，但库里的历史行、手工改库、
   * 或以后新增的写入路径都可能带进意外的列名 —— 那时拼进 SQL 就是列名注入。
   * 一次判断一行代码，把这类风险彻底关掉。
   */
  if (!CHANGE_FIELDS[change.field_key]) return fail(res, 409, '该修改申请的信息项已失效，请重新提交');
  // 事务用 BEGIN/COMMIT（项目铁律：node:sqlite 回退驱动没有 db.transaction）
  db.exec('BEGIN IMMEDIATE');
  try {
    if(change.field_key==='development_submission'){if(!approve)db.prepare("UPDATE tech_packs SET business_submitted_at=NULL,updated_at=? WHERE id=(SELECT tech_pack_id FROM pattern_flows WHERE id=?)").run(ts,change.flow_id);}
    else if(change.field_key==='development_revision')revision.review(change,approve);
    else if (approve) db.prepare(`UPDATE tech_packs SET ${change.field_key}=?,updated_at=? WHERE id=(SELECT tech_pack_id FROM pattern_flows WHERE id=?)`).run(change.proposed_value, ts, change.flow_id);
    db.prepare('UPDATE pattern_change_requests SET status=?,reviewed_by=?,reviewed_at=?,review_note=?,updated_at=? WHERE id=?')
      .run(approve ? (change.field_key==='development_submission'?'released':change.field_key==='development_revision'?'editing':'awaiting_recheck') : 'rejected', user, ts, note || null, ts, change.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, db.prepare('SELECT * FROM pattern_change_requests WHERE id=?').get(change.id));
}));

router.post('/changes/:id/recheck', authRequired, requireRole(['admin', 'tech']), wrap(async (req, res) => {
  const change = db.prepare('SELECT * FROM pattern_change_requests WHERE id=?').get(req.params.id);
  if (!change) return fail(res, 404, '打版修改申请不存在');
  if (change.status !== 'awaiting_recheck') return fail(res, 409, '该修改尚未进入修改后复核');
  const approve = !!req.body?.approve, note = String(req.body?.note || '').trim();
  if (!approve && !note) return fail(res, 400, '请填写复核未通过的原因');
  const user = req.user.name || req.user.username;
  if (approve && change.reviewed_by === user && req.user.role !== 'admin') return fail(res, 403, '修改后复核需由另一位技术审核人完成');
  const ts = now();
  // 同上：列名白名单再校验一次 + 用 BEGIN/COMMIT 而不是 db.transaction
  if (!CHANGE_FIELDS[change.field_key]) return fail(res, 409, '该修改申请的信息项已失效，请重新提交');
  db.exec('BEGIN IMMEDIATE');
  try {
    if(change.field_key==='development_revision')revision.recheck(change,approve);
    else if (!approve) db.prepare(`UPDATE tech_packs SET ${change.field_key}=?,updated_at=? WHERE id=(SELECT tech_pack_id FROM pattern_flows WHERE id=?)`).run(change.before_value, ts, change.flow_id);
    db.prepare('UPDATE pattern_change_requests SET status=?,rechecked_by=?,rechecked_at=?,recheck_note=?,updated_at=? WHERE id=?')
      .run(approve ? 'released' : 'rejected', user, ts, note || null, ts, change.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, db.prepare('SELECT * FROM pattern_change_requests WHERE id=?').get(change.id));
}));

/** 确保流程存在（幂等），供开发单创建时内部调用 */
function ensureFlow(techPackId, userId) {
  const tp = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(techPackId);
  if (!tp) return null;
  if(['sample_review','new_review'].includes(tp.stage))throw Object.assign(new Error('请先在开发管理核对款式'),{status:409});
  let flow = db.prepare('SELECT * FROM pattern_flows WHERE tech_pack_id = ?').get(techPackId);
  if (!flow) {
    const t = now();
    const info = db.prepare(
      'INSERT INTO pattern_flows (tech_pack_id, order_id, current_stage, status, started_at, created_by) VALUES (?,?,?,?,?,?)'
    ).run(techPackId, tp.order_id, 'material', 'running', t, userId || null);
    ensureStages(Number(info.lastInsertRowid));
    flow = db.prepare('SELECT * FROM pattern_flows WHERE id = ?').get(Number(info.lastInsertRowid));
  }
  return flow;
}
router.post('/ensure', authRequired, wrap(async (req, res) => {
  const { tech_pack_id } = req.body || {};
  if (!tech_pack_id) return fail(res, 400, '缺少 tech_pack_id');
  const tp = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(tech_pack_id);
  if (!tp) return fail(res, 404, '开发单不存在');
  const flow = ensureFlow(tech_pack_id, req.user.sub);
  return ok(res, loadFlow(flow.id));
}));

/** 保存阶段内容（不改变阶段状态） */
router.put('/:flowId/stage/:stage', authRequired, wrap(async (req, res) => {
  const { flowId, stage } = req.params;
  if (!STAGE_KEYS.includes(stage)) return fail(res, 400, '非法的阶段');
  const flow = db.prepare('SELECT * FROM pattern_flows WHERE id = ?').get(flowId);
  if (!flow) return fail(res, 404, '流程不存在');
  if (flow.status === 'done') return fail(res, 400, '流程已完成，样衣已归档锁定；如需修改请提交变更需求');
  if (changeHold(flow.id).length) return fail(res, 409, '业务信息修改正在审核；修改后复核通过前不能继续打版');
  if (!canWrite(req.user, stage)) {
    return fail(res, 403, `你的角色无权填写「${stageDef(stage).label}」阶段`);
  }
  const b = req.body || {};
  if(b.data?.basic_info!==undefined){
    const basic=b.data.basic_info,keys=['type','colors','designer','assistant','sample_maker','pattern_maker','salesperson','brand','category'];
    if(!basic||typeof basic!=='object'||Array.isArray(basic)||Object.keys(basic).some(k=>!keys.includes(k)||typeof basic[k]!=='string'||basic[k].length>500))return fail(res,400,'任务基本信息格式错误或内容超长');
    if(!Number.isFinite(Number(b.price))||Number(b.price)<0||Number(b.price)>10000000)return fail(res,400,'加工费须为合法非负金额');
    if(String(b.remark||'').length>500)return fail(res,400,'备注最多500字');
  }
  if(stage==='craft') {
    validateCraftData(b.data || {});
    b.data={...(b.data || {})};
    for(const key of ['sewing','finish']) if(b.data[key]!==undefined)b.data[key]=normalizeCraftRows(b.data[key]);
  }
  ensureStages(flow.id);
  const t = now();
  // 制版资料和版房款号回传必须一起保存，冲突或后续写入失败全部回滚。
  db.exec('BEGIN IMMEDIATE');
  try {
    if(stage==='pattern'&&b.data?.style_no!==undefined){
      const tp=db.prepare('SELECT * FROM tech_packs WHERE id=?').get(flow.tech_pack_id);
      if(String(b.data.style_no||'').trim()||tp.customer_style_no)require('../services/preOrderStyles').assignStyleNumber(tp,b.data.style_no,b.data.style_no_version,req.user);
    }
  db.prepare(
    `UPDATE pattern_stages SET
       owner = ?, work_hours = ?, actual_hours = ?, due_date = ?, price = ?,
       pattern_size = ?, label_name = ?, remark = ?, data = ?, operator = ?, updated_at = ?
     WHERE flow_id = ? AND stage = ?`
  ).run(
    b.owner ?? null,
    Number(b.work_hours) || 0,
    Number(b.actual_hours) || 0,
    b.due_date || null,
    Number(b.price) || 0,
    b.pattern_size || null,
    b.label_name || null,
    b.remark || null,
    JSON.stringify(b.data || {}),
    req.user.username,
    t, flow.id, stage
  );
    db.exec('COMMIT');
  } catch(e){db.exec('ROLLBACK');throw e;}
  return ok(res, loadFlow(flow.id));
}));

/**
 * 面辅料确认阶段的物料清单
 * 直接读写开发单的 tech_pack_materials——确认阶段定下来的清单，就是工艺单与样衣快照的来源，
 * 避免「确认一套、工艺单另一套」。开发单已确认时，只要流程还在 material 阶段仍允许技术调整。
 */
router.get('/:flowId/materials', authRequired, wrap(async (req, res) => {
  const flow = db.prepare('SELECT * FROM pattern_flows WHERE id = ?').get(req.params.flowId);
  if (!flow) return fail(res, 404, '流程不存在');
  const rows = db.prepare('SELECT * FROM tech_pack_materials WHERE tech_pack_id = ? ORDER BY sort, id').all(flow.tech_pack_id);
  return ok(res, { tech_pack_id: flow.tech_pack_id, materials: rows });
}));

router.put('/:flowId/materials', authRequired, wrap(async (req, res) => {
  const flow = db.prepare('SELECT * FROM pattern_flows WHERE id = ?').get(req.params.flowId);
  if (!flow) return fail(res, 404, '流程不存在');
  if (flow.status === 'done') return fail(res, 400, '流程已完成，样衣已归档锁定；如需调整物料请提交变更需求');
  if (changeHold(flow.id).length) return fail(res, 409, '业务信息修改正在审核；修改后复核通过前不能继续打版');
  if (flow.current_stage !== 'material') {
    return fail(res, 400, `面辅料确认已完成，当前在「${STAGE_DEF.find((s) => s.key === flow.current_stage)?.label || flow.current_stage}」阶段；如需改物料请退回该阶段`);
  }
  if (!canWrite(req.user, 'material')) {
    return fail(res, 403, '你的角色无权修改面辅料确认清单');
  }
  const b = req.body || {};
  if (!Array.isArray(b.materials)) return fail(res, 400, '缺少 materials 数组');

  db.exec('BEGIN');
  try {
    saveMaterials(flow.tech_pack_id, b.materials);
    db.prepare('UPDATE pattern_stages SET operator=?, updated_at=? WHERE flow_id=? AND stage=?')
      .run(req.user.username, now(), flow.id, 'material');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const rows = db.prepare('SELECT * FROM tech_pack_materials WHERE tech_pack_id = ? ORDER BY sort, id').all(flow.tech_pack_id);
  return ok(res, { tech_pack_id: flow.tech_pack_id, materials: rows });
}));

/** 完成阶段：校验前置，推进 current_stage */router.post('/:flowId/stage/:stage/done', authRequired, wrap(async (req, res) => {
  const { flowId, stage } = req.params;
  if (!STAGE_KEYS.includes(stage)) return fail(res, 400, '非法的阶段');
  const flow = db.prepare('SELECT * FROM pattern_flows WHERE id = ?').get(flowId);
  if (!flow) return fail(res, 404, '流程不存在');
  if (flow.status === 'done') return fail(res, 400, '流程已完成');
  const developmentPack=db.prepare('SELECT tp.business_submitted_at,i.source_type FROM tech_packs tp LEFT JOIN pre_order_items i ON i.id=tp.pre_order_item_id WHERE tp.id=?').get(flow.tech_pack_id);
  if(developmentPack?.source_type==='new'&&!developmentPack.business_submitted_at)return fail(res,409,'请先在开发管理提交资料并通过版房审核');
  if (changeHold(flow.id).length) return fail(res, 409, '业务信息修改正在审核；修改后复核通过前不能继续打版');
  if (!canWrite(req.user, stage)) {
    return fail(res, 403, `你的角色无权完成「${stageDef(stage).label}」阶段`);
  }

  if(stage==='material'){
    const tp=db.prepare('SELECT pre_order_item_id FROM tech_packs WHERE id=?').get(flow.tech_pack_id);
    if(tp?.pre_order_item_id&&db.prepare("SELECT 1 FROM material_dev_requests WHERE pre_order_item_id=? AND (status<>'completed' OR COALESCE(pattern_review_status,'pending')<>'approved')").get(tp.pre_order_item_id))return fail(res,409,'该款面辅料新品尚未完成确认或打版准入审核，不能跳过开发流程');
  }
  if(stage==='pattern'){
    const tp=db.prepare('SELECT tp.customer_style_no,i.source_type FROM tech_packs tp LEFT JOIN pre_order_items i ON i.id=tp.pre_order_item_id WHERE tp.id=?').get(flow.tech_pack_id);
    if(tp?.source_type==='new'&&!String(tp.customer_style_no||'').trim())return fail(res,400,'请版房先填写款号，再完成制版阶段');
  }
  ensureStages(flow.id);
  const idx = STAGE_KEYS.indexOf(stage);
  const prev = idx > 0 ? db.prepare('SELECT status FROM pattern_stages WHERE flow_id = ? AND stage = ?').get(flow.id, STAGE_KEYS[idx - 1]) : null;
  if (prev && prev.status !== 'done') {
    return fail(res, 400, `上一阶段「${stageDef(STAGE_KEYS[idx - 1]).label}」尚未完成，不能跳到当前阶段`);
  }

  const t = now();
  db.prepare(
    "UPDATE pattern_stages SET status='done', finished_at=COALESCE(finished_at, ?), operator=?, updated_at=? WHERE flow_id=? AND stage=?"
  ).run(t, req.user.username, t, flow.id, stage);

  // 推进 current_stage
  const nextStage = STAGE_KEYS[idx + 1] || null;
  if (nextStage) {
    db.prepare('UPDATE pattern_flows SET current_stage = ? WHERE id = ?').run(nextStage, flow.id);
    db.prepare("UPDATE pattern_stages SET status='doing', started_at=COALESCE(started_at, ?) WHERE flow_id=? AND stage=? AND status='pending'")
      .run(t, flow.id, nextStage);
  }
  // 同步开发单 stage（兼容开发管理旧看板）
  syncTpStage(flow.tech_pack_id, nextStage || 'confirmed');

  const doneCount = db.prepare("SELECT COUNT(*) AS c FROM pattern_stages WHERE flow_id=? AND status='done'").get(flow.id).c;
  if (Number(doneCount) >= STAGE_KEYS.length) {
    return ok(res, { finished: true, flow: loadFlow(flow.id) });
  }
  return ok(res, { finished: false, flow: loadFlow(flow.id) });
}));

/** 退回重做：把该阶段及之后全部重置为待开始 */
router.post('/:flowId/stage/:stage/reopen', authRequired, wrap(async (req, res) => {
  const { flowId, stage } = req.params;
  if (!STAGE_KEYS.includes(stage)) return fail(res, 400, '非法的阶段');
  const flow = db.prepare('SELECT * FROM pattern_flows WHERE id = ?').get(flowId);
  if (!flow) return fail(res, 404, '流程不存在');
  if (flow.status === 'done') return fail(res, 400, '流程已完成，样衣已归档，请走样衣变更流程');
  if (changeHold(flow.id).length) return fail(res, 409, '业务信息修改正在审核；修改后复核通过前不能继续打版');
  if (!canWrite(req.user, stage)) return fail(res, 403, '你的角色无权退回该阶段');

  const idx = STAGE_KEYS.indexOf(stage);
  const t = now();
  db.exec('BEGIN');
  try {
    STAGE_KEYS.slice(idx).forEach((k, i) => {
      db.prepare(
        "UPDATE pattern_stages SET status=?, finished_at=NULL, started_at=?, updated_at=? WHERE flow_id=? AND stage=?"
      ).run(i === 0 ? 'doing' : 'pending', i === 0 ? t : null, t, flow.id, k);
    });
    db.prepare('UPDATE pattern_flows SET current_stage = ? WHERE id = ?').run(stage, flow.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  syncTpStage(flow.tech_pack_id, stage);
  return ok(res, loadFlow(flow.id));
}));

function syncTpStage(tpId, stage) {
  const map = { material: 'material', pattern: 'pattern', craft: 'craft', sample: 'sample', biz: 'biz', audit: 'biz', confirmed: 'confirmed' };
  const s = map[stage] || 'draft';
  try {
    db.prepare('UPDATE tech_packs SET stage = ?, updated_at = ? WHERE id = ?').run(s, now(), tpId);
  } catch (e) { /* ignore */ }
}

/** 完成流程：六个阶段都 done 才允许，完成后归档样衣并锁定 */
router.post('/:flowId/finish', authRequired, wrap(async (req, res) => {
  const flow = db.prepare('SELECT * FROM pattern_flows WHERE id = ?').get(req.params.flowId);
  if (!flow) return fail(res, 404, '流程不存在');
  if (flow.status === 'done') return fail(res, 400, '流程已完成');
  if (changeHold(flow.id).length) return fail(res, 409, '业务信息修改正在审核；修改后复核通过前不能继续打版');

  const left = db.prepare("SELECT stage FROM pattern_stages WHERE flow_id=? AND status!='done'").all(flow.id);
  if (left.length) {
    const names = left.map((r) => stageDef(r.stage).label).join('、');
    return fail(res, 400, `还有阶段未完成：${names}`);
  }
  if (!canWrite(req.user, 'audit')) {
    return fail(res, 403, '只有工序审核/工价核价角色可以结束打版流程');
  }

  // 归档前与开发确认使用同一份齐备性判断，避免锁出一份永远不能确认的样衣。
  const pack=db.prepare('SELECT * FROM tech_packs WHERE id=?').get(flow.tech_pack_id);
  const checks=require('./techpacks');
  const blocks=checks.confirmBlocks(pack);
  if(blocks.length)return fail(res,400,checks.blockMessage(blocks)+'请补齐资料再归档。');

  const t = now();
  let archive;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE pattern_flows SET status='done', finished_at=?, current_stage='done' WHERE id=?").run(t, flow.id);
    archive = archiveFromFlow(flow, req.user.username);
    if(!archive)throw new Error('样衣归档失败，流程完成操作已回滚');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  // 流程完成与归档已在同一事务完成，归档失败不会留下完成状态。
  if (archive) {
    const change = db.prepare(`SELECT c.id FROM sample_change_requests c
      JOIN sample_archives old ON old.id=c.archive_id
      WHERE old.tech_pack_id=? AND c.status='approved' AND c.new_archive_id IS NULL
      ORDER BY c.id DESC LIMIT 1`).get(flow.tech_pack_id);
    if (change) db.prepare('UPDATE sample_change_requests SET new_archive_id=? WHERE id=?').run(archive.id, change.id);
  }
  syncTpStage(flow.tech_pack_id, 'confirmed');
  return ok(res, { flow: loadFlow(flow.id), archive });
}));

module.exports = router;
module.exports.ensureFlow = ensureFlow;
module.exports.STAGE_DEF = STAGE_DEF;
module.exports.STAGE_KEYS = STAGE_KEYS;
module.exports.STAGE_LABELS = Object.fromEntries(STAGE_DEF.map((s) => [s.key, s.label]));
