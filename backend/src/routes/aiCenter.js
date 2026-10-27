/**
 * AI 能力中心（M17）
 *   /api/ai/overview            总览（模式、供应商、调用成本、待办数）
 *   /api/ai/gateway             模型网关：供应商列表 / 登记 / 启停 / 连通测试
 *   /api/ai/calls               调用审计
 *   /api/ai/ask                 受权限守卫的业务问答（推荐入口）
 *   /api/ai/extract             需求抽取 → 草稿
 *   /api/ai/reply               客服建议答复 → 草稿
 *   /api/ai/drafts              草稿列表 / 详情 / 核准 / 驳回
 *   /api/ai/anomalies           可解释异常清单
 *   /api/ai/explain             异常解释（分级：只读解释 / 草稿动作）
 *   /api/ai/risk                风险预测：跑 / 查 / 认领
 *   /api/ai/weekly              周报：生成 / 列表 / 详情 / 发布
 *   /api/ai/faq                 客服 FAQ：查 / 建 / 批准 / 停用
 *   /api/ai/handovers           人工接管：查 / 建 / 接管 / 关单
 *   /api/ai/evals               评测：用例 / 跑 / 批次 / 明细
 *
 * 一条贯穿全局的硬规则：本模块所有接口都不会直接改业务单据。
 * AI 只能产出「草稿」或「解释」，落地动作一律由人在原业务页面完成。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap, genNo } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { localNow, localDate } = require('../services/sla');
const GW = require('../services/aiGateway');
const EXT = require('../services/aiExtract');
const RISK = require('../services/aiRisk');
const WEEK = require('../services/aiWeekly');
const EVAL = require('../services/aiEval');
const EXP = require('../services/aiExplain');
const { guard, redact } = require('../services/aiGuard');
const { answerQuery } = require('./assistant');
const POLICY = require('../services/policyQA');   // 制度问答（答案带原文版本与日期）

const router = express.Router();

const WRITE = ['admin', 'sales', 'tech', 'finance', 'production', 'warehouse'];
const ADMIN = ['admin'];

const seq = (prefix, table, col) => {
  const d = localDate().replace(/-/g, '');
  const n = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${col} LIKE ?`).get(`${prefix}${d}%`).c;
  return genNo(prefix, n + 1);
};

function safeJson(s, d) {
  try { return s ? JSON.parse(s) : d; } catch (e) { return d; }
}

// ============================================================
// 总览
// ============================================================
router.get('/overview', authRequired, wrap(async (req, res) => {
  const g = GW.overview();
  const risk = RISK.latest();
  const draftCnt = db.prepare("SELECT COUNT(*) c FROM ai_drafts WHERE status='draft'").get().c;
  const lastEval = db.prepare('SELECT * FROM ai_eval_runs ORDER BY id DESC LIMIT 1').get();
  const weeklyCnt = db.prepare('SELECT COUNT(*) c FROM ai_weekly').get().c;
  const handoverOpen = db.prepare("SELECT COUNT(*) c FROM ai_handovers WHERE status<>'closed'").get().c;
  const faqApproved = db.prepare("SELECT COUNT(*) c FROM ai_faq WHERE status='approved'").get().c;

  return ok(res, {
    mode: g.mode,
    mode_label: g.mode_label,
    providers: g.providers,
    ready_count: g.ready_count,
    has_any_key: g.has_any_key,
    today_calls: g.today_calls,
    today_cost: g.today_cost,
    total_cost: g.total_cost,
    by_scene: g.by_scene,
    risk: { run_id: risk.run_id, total: risk.total, stat: risk.stat || {} },
    drafts: draftCnt,
    weekly: weeklyCnt,
    handover_open: handoverOpen,
    faq_approved: faqApproved,
    last_eval: lastEval ? {
      run_no: lastEval.run_no, passed: lastEval.passed, total: lastEval.total,
      leak_cnt: lastEval.leak_cnt, run_at: lastEval.created_at, status: lastEval.status
    } : null
  });
}));

// ============================================================
// 模型网关
// ============================================================
router.get('/gateway', authRequired, wrap(async (req, res) => ok(res, GW.overview())));

router.post('/gateway', authRequired, requireRole(ADMIN), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.code) return fail(res, 400, '供应商编码必填');
  if (!b.name) return fail(res, 400, '名称必填');
  if (!b.key_env) return fail(res, 400, '必须指定密钥所在的环境变量名（密钥不能存数据库）');
  if (b.data_scope && !['public', 'internal', 'restricted'].includes(b.data_scope)) {
    return fail(res, 400, '数据级别只能是 public / internal / restricted');
  }
  if (db.prepare('SELECT id FROM ai_providers WHERE code=?').get(b.code)) {
    return fail(res, 400, `供应商编码 ${b.code} 已存在`);
  }
  const t = localNow();
  db.prepare(
    `INSERT INTO ai_providers (code,name,vendor,base_url,model,key_env,key_masked,data_scope,region,
       input_price,output_price,monthly_budget,used_amount,timeout_ms,priority,status,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`
  ).run(b.code, b.name, b.vendor || null, b.base_url || null, b.model || null, b.key_env,
    GW.maskEnv(b.key_env), b.data_scope || 'internal', b.region || 'cn',
    Number(b.input_price) || 0, Number(b.output_price) || 0, Number(b.monthly_budget) || 0,
    Number(b.timeout_ms) || 15000, Number(b.priority) || 100,
    b.status || 'planning', b.note || null, t, t);
  return ok(res, { code: b.code });
}));

router.put('/gateway/:id', authRequired, requireRole(ADMIN), wrap(async (req, res) => {
  const p = db.prepare('SELECT * FROM ai_providers WHERE id=?').get(req.params.id);
  if (!p) return fail(res, 404, '供应商不存在');
  const b = req.body || {};
  const status = b.status || p.status;
  if (b.status && !['planning', 'pending', 'enabled', 'disabled'].includes(b.status)) {
    return fail(res, 400, '状态只能是 planning / pending / enabled / disabled');
  }
  if (status === 'enabled' && !process.env[p.key_env]) {
    return fail(res, 400, `密钥未配置（环境变量 ${p.key_env} 为空），不能启用；请先在后端 .env 配置后再启用`);
  }
  db.prepare(
    `UPDATE ai_providers SET name=?, model=?, base_url=?, data_scope=?, monthly_budget=?,
       timeout_ms=?, priority=?, status=?, note=?, updated_at=? WHERE id=?`
  ).run(
    b.name || p.name, b.model || p.model, b.base_url || p.base_url,
    b.data_scope || p.data_scope,
    b.monthly_budget === undefined ? p.monthly_budget : Number(b.monthly_budget),
    b.timeout_ms === undefined ? p.timeout_ms : Number(b.timeout_ms),
    b.priority === undefined ? p.priority : Number(b.priority),
    status, b.note === undefined ? p.note : b.note, localNow(), p.id
  );
  return ok(res, { id: p.id, status });
}));

/** 连通性测试：有密钥才真打一次，没有就明确说是「未接入」 */
router.post('/gateway/:id/test', authRequired, requireRole(ADMIN), wrap(async (req, res) => {
  const p = db.prepare('SELECT * FROM ai_providers WHERE id=?').get(req.params.id);
  if (!p) return fail(res, 404, '供应商不存在');
  if (!process.env[p.key_env]) {
    return ok(res, { ok: false, mode: 'not_connected', message: `环境变量 ${p.key_env} 未配置，当前按规则模式运行` });
  }
  const r = await GW.call({
    scene: 'eval', actor: req.user.username,
    system: '只回复 OK 两个字母。', prompt: '连通性测试', maxTokens: 8
  });
  return ok(res, {
    ok: !!r.ok, mode: r.ok ? 'ai' : 'rule',
    answer: r.ok ? r.answer : null, reason: r.reason || null, latency_ms: r.latency_ms, cost: r.cost || 0
  });
}));

router.get('/calls', authRequired, wrap(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const where = [];
  const params = [];
  if (req.query.scene) { where.push('scene=?'); params.push(req.query.scene); }
  if (req.query.status) { where.push('status=?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT * FROM ai_calls ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  ).all(...params, limit).map((r) => ({
    ...r,
    status_label: { ok: '模型作答', fallback: '规则降级', blocked: '已拦截', error: '调用失败' }[r.status] || r.status,
    scene_label: (GW.SCENES[r.scene] || {}).name || r.scene
  }));
  return ok(res, rows);
}));

// ============================================================
// 业务问答（带权限守卫）
// ============================================================
router.post('/ask', authRequired, wrap(async (req, res) => {
  const message = String((req.body || {}).message || '').trim();
  if (!message) return fail(res, 400, '请输入问题');

  const g = guard(message, { ...req.user, name: req.user.name });
  if (g.blocked) {
    GW.logCall({
      scene: 'ask', sensitivity: g.sensitivity || 'internal', actor: req.user.username,
      status: 'blocked', reason: g.reason, prompt_len: message.length
    });
    return ok(res, {
      answer: `【不能回答】${g.reason}${g.tip ? '\n' + g.tip : ''}`,
      source: 'guard', blocked: true, code: g.code, tip: g.tip, data: null
    });
  }

  let grounded = null;
  try { grounded = answerQuery(message); } catch (e) { grounded = null; }

  // 制度类问题先检索制度：命中就必须带原文与版本，不能只凭模型印象答
  let policy = null;
  try { policy = POLICY.search(message); } catch (e) { policy = null; }

  // 命中得够实（覆盖 ≥40%），这条就整个走制度通道：
  // 否则「请假三天要谁批」会被通用问答答成「本月订单 19 张」，看着像系统坏了。
  if (policy && policy.hits.length && policy.hits[0].coverage >= 40) {
    const pr = await POLICY.ask(message, req.user, { use_model: true });
    POLICY.logHits(message, pr, req.user.username);
    return ok(res, {
      answer: pr.answer,
      source: 'rule',                 // 属于规则检索，不走模型自由发挥
      answered_by: 'policy',
      blocked: false,
      citations: pr.citations,
      policy_confidence: pr.confidence,
      data: pr.basis,
      fallback_reason: null
    });
  }

  const render = (r) => {
    if (!r) return '没听懂这个问题。可以问：逾期订单、在产订单、库存、美仓缺货、应收逾期、本月工资（限财务）。';
    const lines = [`【${r.title}】`, r.summary];
    (r.rows || []).slice(0, 8).forEach((row) => {
      lines.push(Object.values(row).filter((v) => v !== null && v !== undefined).join(' | '));
    });
    if (r.links && r.links.length) lines.push('', '入口：' + r.links.map((l) => `${l.text}（${l.to}）`).join('　'));
    return lines.join('\n');
  };

  const ai = await GW.call({
    scene: 'ask', actor: req.user.username,
    system: `你是跳色科技 ERP 助手。用简体中文、最多 6 行回答。用户岗位：${req.user.role}。只能使用下面给出的实时数据，不要编造数字。涉及操作给出页面路径。`,
    prompt: grounded
      ? `问题：${message}\n\n系统实时查询结果（以此为准）：\n${JSON.stringify({ title: grounded.title, summary: grounded.summary, rows: (grounded.rows || []).slice(0, 20) })}`
      : `问题：${message}`,
    maxTokens: 400
  });

  let answer = ai.ok ? redact(ai.answer) : render(grounded);

  // 引用行由服务端拼，不交给模型：模型少写一个生效日期，答案就成了无主条款
  let citations = [];
  if (policy && policy.hits.length) {
    const top = policy.hits[0];
    citations = policy.hits.map((d) => ({
      doc_no: d.doc_no, title: d.title, version: d.version,
      effective_date: d.effective_date, owner: d.owner, coverage: d.coverage,
      cite: POLICY.citeLine(d)
    }));
    const basis = policy.hits[0].excerpt.slice(0, 2).map((e) => '· ' + e.text);
    answer += '\n\n【制度依据】' + POLICY.citeLine(top)
      + (basis.length ? '\n' + basis.join('\n') : '');
    POLICY.logHits(message, { citations, generated_by: ai.ok ? 'model' : 'rule' }, req.user.username);
  } else if (policy && policy.invalid && policy.invalid.length) {
    // 只有草稿/已废止制度：明确说不能作为依据，别让用户以为是「没这条规定」
    answer += '\n\n【提醒】相关制度目前是'
      + policy.invalid.map((x) => `《${x.title}》${x.status_label}`).join('、')
      + '，不能作为执行依据。';
  }

  return ok(res, {
    answer, source: ai.source, blocked: false,
    fallback_reason: ai.ok ? null : ai.reason,
    provider: ai.provider || null, latency_ms: ai.latency_ms || 0, cost: ai.cost || 0,
    citations,
    policy_confidence: policy ? policy.confidence : 0,
    data: grounded
  });
}));

// ============================================================
// 需求抽取
// ============================================================
router.post('/extract', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim();
  if (text.length < 10) return fail(res, 400, '请粘贴完整的询价/需求文本（至少 10 个字）');
  if (text.length > 8000) return fail(res, 400, '文本太长（上限 8000 字），请分段抽取');

  const built = EXT.buildDraft(text);

  // 有模型时让它只补规则抓不到的语义项，不改数值
  const ai = await GW.call({
    scene: 'extract', actor: req.user.username,
    system: '你是服装外贸跟单助手。只输出 JSON：{"notes":["需要向客户确认的点"]}，不要重复已有数值，不要编造数字。',
    prompt: `需求原文：\n${text}\n\n规则已抽到：${JSON.stringify(built.fields.map((f) => ({ 项: f.label, 值: f.value })))}`,
    maxTokens: 300
  });
  let aiNotes = [];
  if (ai.ok) {
    try {
      const m = String(ai.answer).match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : {};
      aiNotes = Array.isArray(j.notes) ? j.notes.slice(0, 8) : [];
    } catch (e) { aiNotes = []; }
  }

  const draftNo = seq('AID', 'ai_drafts', 'draft_no');
  const t = localNow();
  const payload = {
    fields: built.fields,
    missing: built.missing,
    craft: built.craft,
    summary: built.summary,
    ai_notes: aiNotes,
    text_excerpt: text.slice(0, 800)
  };
  const r = db.prepare(
    `INSERT INTO ai_drafts (draft_no,scene,source_type,source_id,source_label,payload,confidence,missing,
       status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?)`
  ).run(draftNo, 'requirement', b.source_type || 'manual', b.source_id || null,
    b.source_label || '手工粘贴文本', JSON.stringify(payload), built.confidence,
    JSON.stringify(built.missing), req.user.username, t, t);

  return ok(res, {
    id: r.lastInsertRowid, draft_no: draftNo, ...payload,
    confidence: built.confidence,
    source: ai.ok ? 'ai' : 'rule',
    fallback_reason: ai.ok ? null : ai.reason
  });
}));

// ============================================================
// 客服建议答复
// ============================================================
router.post('/reply', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const question = String(b.question || '').trim();
  if (question.length < 4) return fail(res, 400, '请填写客户问题（至少 4 个字）');

  // 1. 先查已批准的 FAQ（命中就用，不编）
  const faqs = db.prepare("SELECT * FROM ai_faq WHERE status='approved'").all();
  const hitFaq = faqs.find((f) => {
    const kws = safeJson(f.keywords, []);
    if (!kws.length) return question.includes(f.question.slice(0, 6));
    return kws.some((k) => k && question.includes(k));
  });
  if (hitFaq) {
    db.prepare('UPDATE ai_faq SET hit_count=hit_count+1 WHERE id=?').run(hitFaq.id);
  }

  // 2. 订单相关：查单号给出真实进度
  const orderNo = (question.match(/(SO\d{8,}|\b[A-Z]{2,4}\d{6,}\b)/) || [])[1];
  let orderCtx = null;
  if (orderNo) {
    const o = db.prepare('SELECT * FROM orders WHERE order_no=?').get(orderNo);
    if (o) {
      const nodes = db.prepare('SELECT name,status,plan_date,actual_date FROM order_nodes WHERE order_id=? ORDER BY seq').all(o.id);
      const doneN = nodes.filter((n) => n.status === 'done').length;
      orderCtx = {
        order_no: o.order_no, status: o.status, delivery_date: o.delivery_date,
        progress: nodes.length ? `${doneN}/${nodes.length}` : '未投产',
        next_step: (nodes.find((n) => n.status !== 'done') || {}).name || null
      };
    }
  }

  const base = hitFaq ? hitFaq.answer : null;
  const ai = await GW.call({
    scene: 'reply', actor: req.user.username,
    system: '你是服装外贸客服助手。用简体中文写一段可以直接发给客户的中文答复，3-5 句，语气礼貌但不承诺无法保证的事（不改价格、不承诺未确认的交期）。',
    prompt: `客户问题：${question}\n${orderCtx ? '订单实际情况：' + JSON.stringify(orderCtx) : '没有匹配的订单'}\n${base ? '公司已批准的标准答复：' + base : '没有标准答复'}`,
    maxTokens: 400
  });

  let suggestion;
  if (ai.ok) suggestion = ai.answer;
  else if (base) suggestion = base;
  else if (orderCtx) {
    suggestion = `您好，您的订单 ${orderCtx.order_no} 目前状态为「${orderCtx.status}」，工序进度 ${orderCtx.progress}${orderCtx.next_step ? `，下一步是「${orderCtx.next_step}」` : ''}${orderCtx.delivery_date ? `，约定交期为 ${orderCtx.delivery_date}` : ''}。如有变化我们会第一时间通知您。`;
  } else {
    suggestion = '这个问题暂时没有可引用的标准答复，建议先向技术或财务确认后再回复客户；不要在未确认前承诺交期或价格。';
  }

  const draftNo = seq('AID', 'ai_drafts', 'draft_no');
  const t = localNow();
  const payload = { question, suggestion, faq_id: hitFaq ? hitFaq.id : null, faq_hit: !!hitFaq, order: orderCtx };
  const r = db.prepare(
    `INSERT INTO ai_drafts (draft_no,scene,source_type,source_id,source_label,payload,confidence,
       status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'draft',?,?,?)`
  ).run(draftNo, 'reply', 'customer_question', b.customer_id || null, b.customer || '客户咨询',
    JSON.stringify(payload), hitFaq ? 0.9 : orderCtx ? 0.7 : 0.4, req.user.username, t, t);

  return ok(res, {
    id: r.lastInsertRowid, draft_no: draftNo, ...payload,
    source: ai.ok ? 'ai' : (hitFaq ? 'faq' : 'rule'),
    fallback_reason: ai.ok ? null : ai.reason,
    warning: !hitFaq && !orderCtx ? '既没有批准过的标准答复，也没有匹配到订单，这段只是提醒你先去确认，不要直接发给客户。' : null
  });
}));

// ============================================================
// 草稿
// ============================================================
router.get('/drafts', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.scene) { where.push('scene=?'); params.push(req.query.scene); }
  if (req.query.status) { where.push('status=?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT * FROM ai_drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  ).all(...params, Math.min(200, Number(req.query.limit) || 50)).map((r) => ({
    ...r,
    payload: safeJson(r.payload, {}),
    missing: safeJson(r.missing, []),
    scene_label: { requirement: '需求抽取', reply: '客服答复', anomaly: '异常解释' }[r.scene] || r.scene,
    status_label: { draft: '待核准', approved: '已核准', rejected: '已驳回' }[r.status] || r.status
  }));
  return ok(res, rows);
}));

router.get('/drafts/:id', authRequired, wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM ai_drafts WHERE id=?').get(req.params.id);
  if (!r) return fail(res, 404, '草稿不存在');
  return ok(res, {
    ...r, payload: safeJson(r.payload, {}), missing: safeJson(r.missing, []),
    scene_label: { requirement: '需求抽取', reply: '客服答复', anomaly: '异常解释' }[r.scene] || r.scene,
    status_label: { draft: '待核准', approved: '已核准', rejected: '已驳回' }[r.status] || r.status
  });
}));

router.post('/drafts/:id/approve', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM ai_drafts WHERE id=?').get(req.params.id);
  if (!r) return fail(res, 404, '草稿不存在');
  if (r.status !== 'draft') return fail(res, 400, `草稿已经是「${r.status === 'approved' ? '已核准' : '已驳回'}」状态`);
  if (r.created_by === req.user.username && req.user.role !== 'admin') {
    // 自己抽自己批没有复核意义；但业务上单人小店也需要能推进，所以只提示不拦
  }
  const appliedTo = String((req.body || {}).applied_to || '').trim();
  if (r.scene === 'requirement' && !appliedTo) {
    // 核准需求草稿必须说明「带入到哪」，否则等于点了下按钮什么都没发生
    return fail(res, 400, '核准需求草稿时请填写带入去向（例如：已建开发单 KP2026...），否则草稿只是被标记了一下');
  }
  db.prepare(
    "UPDATE ai_drafts SET status='approved', reviewed_by=?, reviewed_at=?, review_note=?, applied_to=?, updated_at=? WHERE id=?"
  ).run(req.user.username, localNow(), (req.body || {}).note || null, appliedTo || null, localNow(), r.id);
  return ok(res, { id: r.id, status: 'approved', applied_to: appliedTo || null });
}));

router.post('/drafts/:id/reject', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM ai_drafts WHERE id=?').get(req.params.id);
  if (!r) return fail(res, 404, '草稿不存在');
  if (r.status !== 'draft') return fail(res, 400, '只有待核准的草稿可以驳回');
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 4) return fail(res, 400, '驳回必须写原因（至少 4 个字），否则无法改进抽取规则');
  db.prepare("UPDATE ai_drafts SET status='rejected', reviewed_by=?, reviewed_at=?, review_note=?, updated_at=? WHERE id=?")
    .run(req.user.username, localNow(), reason, localNow(), r.id);
  return ok(res, { id: r.id, status: 'rejected' });
}));

// ============================================================
// 异常解释
// ============================================================
router.get('/anomalies', authRequired, wrap(async (req, res) => {
  const rows = EXP.anomalies(req.query.limit);
  return ok(res, {
    rows,
    labels: { order: '订单', dq_issue: '数据异常', receivable: '应收', purchase: '采购', approval: '待办审批' }
  });
}));

router.post('/explain', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.entity_type) return fail(res, 400, '请指定要解释的对象类型');
  if (!b.entity_id && !b.entity_no) return fail(res, 400, '请指定对象 ID 或单号');

  const r = EXP.explain(b);
  if (!r.ok) return fail(res, 400, r.error || '解释失败');

  // 有模型时补一段人话总结（不改结论）
  const ai = await GW.call({
    scene: 'explain', actor: req.user.username,
    system: '你是 ERP 异常解释助手。把下面的结构化结论用简体中文讲成 3 句话，不要新增事实、不要建议系统未提供的动作。',
    prompt: JSON.stringify({ title: r.title, findings: r.findings }),
    maxTokens: 260
  });

  let savedId = null;
  if (b.save) {
    const draftNo = seq('AID', 'ai_drafts', 'draft_no');
    const t = localNow();
    savedId = db.prepare(
      `INSERT INTO ai_drafts (draft_no,scene,source_type,source_id,source_label,payload,confidence,
         status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'draft',?,?,?)`
    ).run(draftNo, 'anomaly', r.entity_type, r.entity_id, r.entity_no,
      JSON.stringify({ findings: r.findings, summary: r.title }), 0.9,
      req.user.username, t, t).lastInsertRowid;
  }

  return ok(res, {
    ...r, summary: ai.ok ? ai.answer : null,
    source: ai.ok ? 'ai' : 'rule', fallback_reason: ai.ok ? null : ai.reason,
    draft_id: savedId,
    note: '本页只解释原因；所有动作都是草稿，需要人到原业务页面执行。付款、工资、出厂价、质检判定、跨货调整 AI 一律不能做。'
  });
}));

// ============================================================
// 风险预测
// ============================================================
router.post('/risk/run', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = RISK.run(req.user.username);
  return ok(res, r);
}));

router.get('/risk', authRequired, wrap(async (req, res) => {
  const r = RISK.latest({
    level: req.query.level, role: req.query.role,
    status: req.query.status === 'all' ? null : (req.query.status || 'open')
  });
  const roles = db.prepare('SELECT DISTINCT role FROM ai_risks WHERE role IS NOT NULL').all()
    .map((x) => ({ role: x.role, label: RISK.roleCn(x.role) }));
  return ok(res, {
    ...r,
    roles,
    type_labels: {
      approval: '待办审批', order: '订单交期', order_node: '工序延期', purchase: '原料到货',
      qc: '质量检验', receivable: '应收逾期', mail: '邮件待办', dq_issue: '数据异常'
    }
  });
}));

router.post('/risk/:id/ack', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM ai_risks WHERE id=?').get(req.params.id);
  if (!r) return fail(res, 404, '风险项不存在');
  if (r.status !== 'open') return fail(res, 400, `该风险已是「${r.status === 'ack' ? '已认领' : '已处理'}」状态`);
  const status = (req.body || {}).status === 'done' ? 'done' : 'ack';
  db.prepare('UPDATE ai_risks SET status=?, ack_by=?, ack_at=? WHERE id=?')
    .run(status, req.user.username, localNow(), r.id);
  return ok(res, { id: r.id, status });
}));

// ============================================================
// 周报
// ============================================================
router.post('/weekly/generate', authRequired, requireRole(['admin', 'sales', 'tech', 'finance', 'production', 'warehouse']), wrap(async (req, res) => {
  const b = req.body || {};
  const scope = b.scope || 'user';
  if (!['user', 'dept', 'company'].includes(scope)) return fail(res, 400, '范围只能是 user / dept / company');
  if (scope === 'user' && !b.subject) return fail(res, 400, '按人生成时必须指定 subject（姓名或账号）');
  // 非管理员只能生成本人的
  if (scope !== 'user' && req.user.role !== 'admin') return fail(res, 403, '只有管理员能按部门或全公司生成周报');
  if (scope === 'user' && req.user.role !== 'admin' && b.subject !== req.user.name && b.subject !== req.user.username) {
    return fail(res, 403, '只能生成自己的周报');
  }
  const r = WEEK.generate({ week: b.week, scope, subject: b.subject, operator: req.user.username });
  if (r.error) return fail(res, 400, r.error);
  return ok(res, r);
}));

router.get('/weekly', authRequired, wrap(async (req, res) => {
  const r = WEEK.list({
    week: req.query.week, scope: req.query.scope, viewer: req.user, limit: req.query.limit
  });
  return ok(res, r);
}));

router.get('/weekly/:id', authRequired, wrap(async (req, res) => {
  const r = WEEK.detail(req.params.id, req.user);
  if (!r) return fail(res, 404, '周报不存在');
  if (r.forbidden) return fail(res, 403, '只能查看自己的周报；同事的绩效与待办属于本人数据');
  return ok(res, r);
}));

router.post('/weekly/:id/publish', authRequired, requireRole(['admin', 'sales', 'tech', 'finance', 'production', 'warehouse']), wrap(async (req, res) => {
  const r = db.prepare('SELECT * FROM ai_weekly WHERE id=?').get(req.params.id);
  if (!r) return fail(res, 404, '周报不存在');
  if (req.user.role !== 'admin' && r.subject_name !== req.user.name && r.subject_name !== req.user.username) {
    return fail(res, 403, '只能发布自己的周报');
  }
  if (r.status === 'published') return fail(res, 400, '已经发布过了');
  db.prepare("UPDATE ai_weekly SET status='published', published_at=? WHERE id=?").run(localNow(), r.id);
  return ok(res, { id: r.id, status: 'published' });
}));

// ============================================================
// 客服 FAQ
// ============================================================
router.get('/faq', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('status=?'); params.push(req.query.status); }
  if (req.query.q) { where.push('(question LIKE ? OR answer LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const rows = db.prepare(
    `SELECT * FROM ai_faq ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 100`
  ).all(...params).map((r) => ({
    ...r,
    keywords: safeJson(r.keywords, []),
    status_label: { draft: '待批准', approved: '已批准', retired: '已停用' }[r.status] || r.status
  }));
  return ok(res, rows);
}));

router.post('/faq', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const q = String(b.question || '').trim();
  const a = String(b.answer || '').trim();
  if (q.length < 4) return fail(res, 400, '问题至少 4 个字');
  if (a.length < 6) return fail(res, 400, '答案至少 6 个字（太短的答复发出去等于没答）');
  const t = localNow();
  const r = db.prepare(
    `INSERT INTO ai_faq (question,answer,category,keywords,version,status,created_by,created_at,updated_at)
     VALUES (?,?,?,?,1,'draft',?,?,?)`
  ).run(q, a, b.category || null, JSON.stringify(b.keywords || []), req.user.username, t, t);
  return ok(res, { id: r.lastInsertRowid, status: 'draft' });
}));

router.put('/faq/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const f = db.prepare('SELECT * FROM ai_faq WHERE id=?').get(req.params.id);
  if (!f) return fail(res, 404, 'FAQ 不存在');
  const b = req.body || {};
  const status = b.status || f.status;
  if (b.status && !['draft', 'approved', 'retired'].includes(b.status)) {
    return fail(res, 400, '状态只能是 draft / approved / retired');
  }
  // 批准必须是有权限的人明确动作，避免自己写自己批
  if (status === 'approved' && f.status !== 'approved') {
    if (f.created_by === req.user.username && req.user.role !== 'admin') {
      return fail(res, 400, '自己写的 FAQ 不能自己批准，请让主管批准（避免把未经确认的说法固化成标准答复）');
    }
  }
  if (b.question !== undefined && String(b.question).trim().length < 4) return fail(res, 400, '问题至少 4 个字');
  if (b.answer !== undefined && String(b.answer).trim().length < 6) return fail(res, 400, '答案至少 6 个字');

  const t = localNow();
  db.prepare(
    `UPDATE ai_faq SET question=?, answer=?, category=?, keywords=?, status=?,
       approved_by=?, approved_at=?, updated_at=? WHERE id=?`
  ).run(
    b.question === undefined ? f.question : String(b.question).trim(),
    b.answer === undefined ? f.answer : String(b.answer).trim(),
    b.category === undefined ? f.category : b.category,
    b.keywords === undefined ? f.keywords : JSON.stringify(b.keywords),
    status,
    status === 'approved' ? (f.approved_by || req.user.username) : f.approved_by,
    status === 'approved' ? (f.approved_at || t) : f.approved_at,
    t, f.id
  );
  return ok(res, { id: f.id, status });
}));

// ============================================================
// 人工接管
// ============================================================
router.get('/handovers', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('status=?'); params.push(req.query.status); }
  const rows = db.prepare(
    `SELECT * FROM ai_handovers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 100`
  ).all(...params).map((r) => ({
    ...r,
    status_label: { ai: 'AI 处理中', human: '人工接管中', closed: '已关闭' }[r.status] || r.status
  }));
  return ok(res, rows);
}));

router.post('/handovers', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const question = String(b.question || '').trim();
  if (question.length < 4) return fail(res, 400, '请填写客户问题');
  const reason = String(b.trigger_reason || '').trim();
  if (reason.length < 4) return fail(res, 400, '转人工必须写触发原因（至少 4 个字）');

  const d = localDate().replace(/-/g, '');
  const n = db.prepare('SELECT COUNT(*) c FROM ai_handovers').get().c + 1;
  const sessionNo = `CS${d}${String(n).padStart(4, '0')}`;
  const t = localNow();
  const r = db.prepare(
    `INSERT INTO ai_handovers (session_no,customer,channel,status,trigger_reason,question,created_at)
     VALUES (?,?,?,'ai',?,?,?)`
  ).run(sessionNo, b.customer || null, b.channel || 'mall', reason, question, t);
  return ok(res, { id: r.lastInsertRowid, session_no: sessionNo, status: 'ai' });
}));

router.post('/handovers/:id/take', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const h = db.prepare('SELECT * FROM ai_handovers WHERE id=?').get(req.params.id);
  if (!h) return fail(res, 404, '会话不存在');
  if (h.status === 'closed') return fail(res, 400, '会话已关闭');
  if (h.status === 'human') return fail(res, 400, `已由 ${h.taken_by} 接管，不能重复接管`);
  db.prepare("UPDATE ai_handovers SET status='human', taken_by=?, taken_at=? WHERE id=?")
    .run(req.user.username, localNow(), h.id);
  return ok(res, { id: h.id, status: 'human', taken_by: req.user.username });
}));

router.post('/handovers/:id/close', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const h = db.prepare('SELECT * FROM ai_handovers WHERE id=?').get(req.params.id);
  if (!h) return fail(res, 404, '会话不存在');
  if (h.status === 'closed') return fail(res, 400, '已经关闭过了');
  const summary = String((req.body || {}).summary || '').trim();
  if (summary.length < 4) return fail(res, 400, '关单必须写处理结论（至少 4 个字）');
  db.prepare("UPDATE ai_handovers SET status='closed', closed_at=?, summary=? WHERE id=?")
    .run(localNow(), summary, h.id);
  return ok(res, { id: h.id, status: 'closed' });
}));

// ============================================================
// 制度问答（N17-02：答案带制度原文版本与日期）
// ============================================================
router.get('/policy/recent', authRequired, wrap(async (req, res) => ok(res, POLICY.recent(req.query.limit))));

router.get('/policy/search', authRequired, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return fail(res, 400, '请输入要查的内容');
  return ok(res, POLICY.search(q, { include_invalid: true, limit: 5 }));
}));

router.post('/policy/ask', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const question = String(b.question || b.message || '').trim();
  if (!question) return fail(res, 400, '请输入问题');
  if (question.length > 500) return fail(res, 400, '问题太长（上限 500 字）');
  const r = await POLICY.ask(question, req.user, { use_model: b.use_model !== false });
  const logged = POLICY.logHits(question, r, req.user.username);
  return ok(res, { ...r, logged });
}));

router.get('/policy/hits', authRequired, wrap(async (req, res) => {
  const rows = POLICY.hits(req.query);
  return ok(res, {
    rows,
    outdated: rows.filter((x) => x.outdated).length,
    note: '引用留痕：制度改版后，这里能看出哪些回答当时引的是旧版'
  });
}));

router.get('/policy/doc/:docNo', authRequired, wrap(async (req, res) => {
  const d = POLICY.docByNo(req.params.docNo);
  if (!d) return fail(res, 404, '制度不存在');
  return ok(res, d);
}));

// ============================================================
// 评测审计
// ============================================================
router.get('/evals/cases', authRequired, wrap(async (req, res) => ok(res, EVAL.cases())));

router.post('/evals/run', authRequired, requireRole(ADMIN), wrap(async (req, res) => {
  const mode = (req.body || {}).mode === 'ai' ? 'ai' : 'rule';
  const r = await EVAL.run({ operator: req.user.username, mode });
  return ok(res, r);
}));

router.get('/evals/runs', authRequired, wrap(async (req, res) => {
  const rows = EVAL.listRuns(req.query.limit).map((r) => ({
    ...r,
    gate: r.leak_cnt === 0 ? 'pass' : 'block',
    gate_label: r.leak_cnt === 0 ? '通过' : '拦住',
    source_label: r.source === 'ai' ? '模型' : '规则'
  }));
  return ok(res, rows);
}));

router.get('/evals/runs/:id', authRequired, wrap(async (req, res) => {
  const r = EVAL.runDetail(req.params.id);
  if (!r) return fail(res, 404, '评测批次不存在');
  return ok(res, {
    ...r,
    gate: r.leak_cnt === 0 ? 'pass' : 'block',
    gate_label: r.leak_cnt === 0 ? '通过（无越权泄漏）' : `拦住：${r.leak_cnt} 条越权泄漏`
  });
}));

module.exports = router;
