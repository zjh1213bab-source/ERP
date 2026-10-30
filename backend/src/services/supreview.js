/**
 * M05-06 供方信息协同与技术再次审核 —— 服务层
 * ============================================================
 * 三段链路，顺序不能反：
 *   A1 技术处理与制版分工 → A2 供方确认（有版本）→ A3 技术复审（必须引用同版本 A2）
 *
 * 这个模块要挡住的四类真实现象：
 *   ① 技术包直接「核准」，没人说得清材料是哪家的、什么规格
 *   ② 换了供方或用了替代材料，旧的核准结论照用不误
 *   ③ 找料样料直接当大货买（没有批准依据、没有转正式确认）
 *   ④ 每单都重新制版 / 每单都重新开发供方（成熟供方只要核对适用性）
 */
const { db } = require('../db');

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const r2 = (v) => Math.round(num(v) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const now = () => new Date().toISOString();
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PATTERN_SCOPE = {
  self: '自制版',
  outsource: '外发制版',
  reuse: '复用原版'
};
const SOURCE_TYPE = {
  existing: '现有成熟供方',
  new_dev: '新开发供方',
  sample_only: '仅样料'
};
const CONCLUSION = {
  pass: '通过',
  conditional: '有条件通过',
  reject: '退回'
};

/** 阶段：A1 未确认 / A2 未齐 / A3 待审 / A3 失效需重审 / 可核准 */
const STAGE = {
  a1_pending: 'A1 待分工',
  a2_pending: 'A2 待供方确认',
  a3_pending: 'A3 待技术复审',
  a3_stale: 'A3 已失效需重审',
  ready: '可核准技术包'
};

function nextNo(table, col, prefix) {
  const d = new Date();
  const p = `${prefix}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rows = db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ?`).all(`${p}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.no).slice(p.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  return `${p}${String(max + 1).padStart(4, '0')}`;
}

function dict() {
  return {
    pattern_scope: Object.entries(PATTERN_SCOPE).map(([k, label]) => ({ k, label })),
    source_type: Object.entries(SOURCE_TYPE).map(([k, label]) => ({ k, label })),
    conclusion: Object.entries(CONCLUSION).map(([k, label]) => ({ k, label })),
    stage: Object.entries(STAGE).map(([k, label]) => ({ k, label })),
    current_date: localDate()
  };
}

// ---------------- 内部 ----------------

function packRow(techPackId) {
  const tp = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(techPackId);
  if (!tp) throw new Error('技术包不存在');
  return tp;
}

function assignmentOf(techPackId) {
  return db.prepare('SELECT * FROM tech_assignments WHERE tech_pack_id = ?').get(techPackId) || null;
}

function confirmsOf(techPackId) {
  return db.prepare(
    'SELECT * FROM supplier_confirms WHERE tech_pack_id = ? ORDER BY material_name, version DESC'
  ).all(techPackId);
}

/**
 * A3 是否失效：它引用的 A2 已经不是当前版本了。
 * **这是整个模块的核心判断**——供货条件变了，原核准就没有依据。
 */
function reviewStale(rv) {
  const c = db.prepare('SELECT * FROM supplier_confirms WHERE id = ?').get(rv.confirm_id);
  if (!c) return { stale: true, reason: '引用的供方确认已被删除' };
  if (c.is_current !== 1) {
    const cur = db.prepare(
      'SELECT version, supplier_name FROM supplier_confirms WHERE tech_pack_id = ? AND material_key = ? AND is_current = 1'
    ).get(c.tech_pack_id, c.material_key);
    return {
      stale: true,
      reason: cur
        ? `供货条件已更新到 V${cur.version}（${cur.supplier_name || '—'}），原核准依据 V${c.version} 已作废`
        : '供货条件已撤版，原核准失去依据'
    };
  }
  if (Number(rv.confirm_version) !== Number(c.version)) {
    return { stale: true, reason: `核准时引用 V${rv.confirm_version}，当前已是 V${c.version}` };
  }
  return { stale: false, reason: null };
}

function reviewOf(techPackId) {
  return db.prepare(
    'SELECT * FROM tech_reviews WHERE tech_pack_id = ? ORDER BY id DESC'
  ).all(techPackId).map((r) => {
    const st = reviewStale(r);
    const c = db.prepare('SELECT confirm_no, supplier_name, spec, version FROM supplier_confirms WHERE id = ?').get(r.confirm_id);
    return { ...r, stale: st.stale ? 1 : 0, stale_reason: st.reason, live: st.stale ? 0 : 1, confirm: c || null };
  });
}

/** 单张技术包的协同状态 */
function packDetail(techPackId) {
  const tp = packRow(techPackId);
  const a1 = assignmentOf(techPackId);
  const confirms = confirmsOf(techPackId).map((c) => ({
    ...c,
    unit_price: c.unit_price === null ? null : r2(c.unit_price),
    source_label: SOURCE_TYPE[c.source_type] || c.source_type,
    // 只有「仅样料」明确不能直接大货采购；现有供方与新开发供方确认后都能转采购
    can_purchase: c.source_type === 'sample_only' ? 0 : 1,
    needs_reconfirm: c.source_type === 'sample_only' ? 1 : 0
  }));
  const current = confirms.filter((c) => c.is_current === 1);
  const reviews = reviewOf(techPackId);
  const liveReviews = reviews.filter((r) => r.live === 1 && r.conclusion !== 'reject');

  // 阶段判定：A1 未确认 → 卡在 A1；有物料没确认 → 卡在 A2；确认齐了但没复审或复审失效 → 卡在 A3
  let stage = 'ready';
  if (!a1 || a1.status !== 'confirmed') stage = 'a1_pending';
  else if (!current.length || current.some((c) => c.status !== 'confirmed')) stage = 'a2_pending';
  // 顺序很重要：**先看有没有失效的核准**，再看缺不缺复审。
  // 反过来的话，换了供方只会显示「待复审」，看不出「原来那份核准已经不作数了」。
  else if (reviews.some((r) => r.stale === 1 && r.conclusion !== 'reject')) stage = 'a3_stale';
  else if (!liveReviews.length) stage = 'a3_pending';
  else if (liveReviews.some((r) => r.conclusion === 'reject')) stage = 'a3_pending';

  const problems = [];
  if (!a1) problems.push('还没有技术处理与制版分工（A1）');
  else if (a1.status !== 'confirmed') problems.push('A1 分工还没确认');
  if (a1 && a1.pattern_scope === 'reuse' && !a1.reuse_tech_pack_id) problems.push('复用原版但没指定原技术包');
  if (a1 && a1.pattern_scope === 'outsource' && !a1.pattern_vendor_id) problems.push('外发制版但没指定版房');
  if (!confirms.length) problems.push('还没有任何供方确认（A2）');
  current.forEach((c) => {
    if (c.status !== 'confirmed') problems.push(`「${c.material_name}」供方确认还是草稿`);
    if (c.source_type === 'sample_only' && !c.approval_ref) problems.push(`「${c.material_name}」仅有样料，没写批准依据`);
    if (!c.supplier_id) problems.push(`「${c.material_name}」没填供方`);
    if (!c.spec) problems.push(`「${c.material_name}」没填适用规格`);
  });
  const staleOnes = reviews.filter((r) => r.stale === 1 && r.conclusion !== 'reject');
  staleOnes.forEach((r) => problems.push(`「${r.material_name || '—'}」的复审已失效：${r.stale_reason}`));

  return {
    tech_pack: {
      id: tp.id, order_id: tp.order_id, product_name: tp.product_name,
      version: tp.version, stage: tp.stage, status: tp.status, pattern_no: tp.pattern_no,
      customer_style_no: tp.customer_style_no, maker: tp.pattern_maker
    },
    assignment: a1 ? { ...a1, scope_label: PATTERN_SCOPE[a1.pattern_scope] || a1.pattern_scope } : null,
    confirms,
    current_confirms: current,
    reviews,
    stage,
    stage_label: STAGE[stage],
    can_approve: stage === 'ready',
    problems,
    summary: {
      materials: current.length,
      confirmed: current.filter((c) => c.status === 'confirmed').length,
      sample_only: current.filter((c) => c.source_type === 'sample_only').length,
      new_dev: current.filter((c) => c.source_type === 'new_dev').length,
      existing: current.filter((c) => c.source_type === 'existing').length,
      reviews_live: liveReviews.length,
      reviews_stale: staleOnes.length
    }
  };
}

// ---------------- 看板 ----------------

function board(q) {
  const packs = db.prepare(
    `SELECT tp.*, o.order_no FROM tech_packs tp LEFT JOIN orders o ON o.id = tp.order_id
     ORDER BY tp.id DESC LIMIT 200`
  ).all();

  const rows = packs.map((tp) => {
    const a1 = assignmentOf(tp.id);
    const confirms = db.prepare('SELECT * FROM supplier_confirms WHERE tech_pack_id = ?').all(tp.id);
    const cur = confirms.filter((c) => c.is_current === 1);
    const reviews = reviewOf(tp.id);
    const staleCnt = reviews.filter((r) => r.stale === 1 && r.conclusion !== 'reject').length;
    const liveCnt = reviews.filter((r) => r.live === 1 && r.conclusion !== 'reject').length;

    let stage = 'ready';
    if (!a1 || a1.status !== 'confirmed') stage = 'a1_pending';
    else if (!cur.length || cur.some((c) => c.status !== 'confirmed')) stage = 'a2_pending';
    else if (staleCnt) stage = 'a3_stale';
    else if (!liveCnt) stage = 'a3_pending';

    return {
      tech_pack_id: tp.id, order_no: tp.order_no, product_name: tp.product_name,
      style_no: tp.customer_style_no, pattern_no: tp.pattern_no,
      tp_stage: tp.stage,
      a1_status: a1 ? a1.status : null,
      pattern_scope: a1 ? a1.pattern_scope : null,
      scope_label: a1 ? PATTERN_SCOPE[a1.pattern_scope] : null,
      materials: cur.length,
      confirmed: cur.filter((c) => c.status === 'confirmed').length,
      sample_only: cur.filter((c) => c.source_type === 'sample_only').length,
      reviews_live: liveCnt,
      reviews_stale: staleCnt,
      stage,
      stage_label: STAGE[stage]
    };
  });

  const cnt = (k) => rows.filter((r) => r.stage === k).length;
  return {
    stat: {
      packs: rows.length,
      a1_pending: cnt('a1_pending'),
      a2_pending: cnt('a2_pending'),
      a3_pending: cnt('a3_pending'),
      a3_stale: cnt('a3_stale'),
      ready: cnt('ready'),
      sample_only_materials: r2(rows.reduce((s, r) => s + r.sample_only, 0))
    },
    stages: Object.entries(STAGE).map(([k, label]) => ({ k, label, count: cnt(k) })),
    rows,
    rule_note: 'A2 供货条件有版本；A3 必须引用当前版本。换了供方、改了规格或用替代材料，原 A3 自动失效需重审——核准结论不能脱离依据活着'
  };
}

/** 下拉选项：供方、可复用的已核准技术包 */
function options() {
  const suppliers = db.prepare("SELECT id, code, name, category FROM suppliers WHERE status='active' ORDER BY name").all();
  const reusable = db.prepare(
    "SELECT id, product_name, version, pattern_no, customer_style_no FROM tech_packs WHERE status='confirmed' ORDER BY id DESC LIMIT 100"
  ).all();
  return { suppliers, reusable_packs: reusable };
}

// ---------------- A1 ----------------

const PATTERN_SCOPES = Object.keys(PATTERN_SCOPE);

function saveAssignment(techPackId, body, operator) {
  const tp = packRow(techPackId);
  const scope = String(body.pattern_scope || 'self');
  if (!PATTERN_SCOPES.includes(scope)) throw new Error(`未知制版分工：${scope}`);
  const owner = String(body.tech_owner || '').trim();
  if (!owner) throw new Error('技术处理人必填（A1 就是要把「本单谁负责」写清楚）');

  let vendorId = null;
  let vendorName = null;
  if (scope === 'outsource') {
    vendorId = Number(body.pattern_vendor_id || 0) || null;
    if (!vendorId) throw new Error('外发制版必须指定版房（不指定版房就不知道版费付给谁）');
    const v = db.prepare('SELECT id, name, status FROM suppliers WHERE id = ?').get(vendorId);
    if (!v) throw new Error('版房不存在');
    if (v.status !== 'active') throw new Error('该版房已停用');
    vendorName = v.name;
  }

  let reuseId = null;
  if (scope === 'reuse') {
    reuseId = Number(body.reuse_tech_pack_id || 0) || null;
    if (!reuseId) throw new Error('复用原版必须指定原技术包（否则不知道复用哪一版）');
    if (reuseId === Number(techPackId)) throw new Error('不能复用自己');
    const origin = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(reuseId);
    if (!origin) throw new Error('原技术包不存在');
    // 不重复制版的前提是原版确实已核准过
    if (origin.status !== 'confirmed' && origin.stage !== 'confirmed') {
      throw new Error(`原技术包 #${reuseId} 还没核准，不能作为复用依据（复用未核准的版等于跳过了技术审核）`);
    }
  }

  const ts = now();
  const exist = assignmentOf(techPackId);
  if (exist) {
    if (exist.status === 'confirmed' && body.force !== 1) {
      throw new Error('A1 分工已确认；要改请显式带上 force=1（改了分工会影响后续 A2/A3 的依据）');
    }
    db.prepare(
      `UPDATE tech_assignments SET tech_owner=?, pattern_scope=?, pattern_vendor_id=?, pattern_vendor_name=?,
         reuse_tech_pack_id=?, pattern_price=?, due_date=?, note=?, status='draft',
         confirmed_by=NULL, confirmed_at=NULL, updated_at=? WHERE tech_pack_id=?`
    ).run(owner, scope, vendorId, vendorName, reuseId,
      body.pattern_price === undefined || body.pattern_price === '' ? null : r2(body.pattern_price),
      body.due_date || null, body.note || null, ts, techPackId);
  } else {
    db.prepare(
      `INSERT INTO tech_assignments (tech_pack_id, order_id, tech_owner, pattern_scope, pattern_vendor_id,
         pattern_vendor_name, reuse_tech_pack_id, pattern_price, due_date, status, note,
         created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`
    ).run(techPackId, tp.order_id, owner, scope, vendorId, vendorName, reuseId,
      body.pattern_price === undefined || body.pattern_price === '' ? null : r2(body.pattern_price),
      body.due_date || null, body.note || null, operator || null, ts, ts);
  }
  return packDetail(techPackId);
}

function confirmAssignment(techPackId, operator) {
  const a1 = assignmentOf(techPackId);
  if (!a1) throw new Error('还没有分工可确认');
  if (a1.status === 'confirmed') throw new Error('A1 已经确认过了');
  if (a1.pattern_scope === 'outsource' && !a1.pattern_vendor_id) throw new Error('外发制版没指定版房，不能确认');
  if (a1.pattern_scope === 'reuse' && !a1.reuse_tech_pack_id) throw new Error('复用原版没指定原技术包，不能确认');
  db.prepare("UPDATE tech_assignments SET status='confirmed', confirmed_by=?, confirmed_at=?, updated_at=? WHERE id=?")
    .run(operator || null, now(), now(), a1.id);
  return packDetail(techPackId);
}

// ---------------- A2 ----------------

/**
 * 建供方确认版本。三种来源的差别是这一节的全部意义：
 *  existing   现有成熟供方 → 只核对适用性，不需要重新开发
 *  new_dev    新开发供方   → 必须有样料依据
 *  sample_only仅样料       → 必须有批准依据，且**不能直接大货采购**（要找料与采购分开）
 */
function createConfirm(techPackId, body, operator) {
  packRow(techPackId);
  const a1 = assignmentOf(techPackId);
  if (!a1 || a1.status !== 'confirmed') throw new Error('A1 技术处理与制版分工还没确认，不能做供方确认');

  const name = String(body.material_name || '').trim();
  if (!name) throw new Error('物料名称必填');
  const sourceType = String(body.source_type || 'existing');
  if (!SOURCE_TYPE[sourceType]) throw new Error(`未知供方来源：${sourceType}`);

  const spec = String(body.spec || '').trim();
  if (!spec) throw new Error('适用规格必填（同一种料不同规格不能混着用）');

  const supplierId = Number(body.supplier_id || 0) || null;
  if (!supplierId) throw new Error('必须指定供方');
  const sup = db.prepare('SELECT id, name, status FROM suppliers WHERE id = ?').get(supplierId);
  if (!sup) throw new Error('供方不存在');
  if (sup.status !== 'active') throw new Error('该供方已停用，不能作为供货来源');
  // 供货资格门禁：复用采购那套判定，别在这里另写一份（两处口径一定会分叉）
  const gate = require('../routes/supplierEvals').qualificationGate(supplierId);
  if (!gate.ok) throw new Error(`供方「${sup.name}」${gate.reason || '资格未通过'}，不能作为供货来源`);

  if (sourceType === 'new_dev' && !String(body.sample_basis || '').trim()) {
    throw new Error('新开发供方必须写样料依据（色卡号 / 样布编号 / 检测报告），否则无法确认能做');
  }
  if (sourceType === 'sample_only' && !String(body.approval_ref || '').trim()) {
    throw new Error('仅样料必须有批准依据（谁批准了这次找料样料），找料与正式大货采购要分开');
  }

  const materialId = Number(body.material_id || 0) || null;
  const ts = now();
  db.exec('BEGIN');
  try {
    // 有新版本就把上一版置为作废（同物料只能一版当前）
    // 物料键：有编码用编码，没编码用名称。**不能只看 material_id**——
    // 那样同一技术包里所有「只有名称的物料」会共用一条版本链，互相冲掉（踩过）。
    const materialKey = materialId ? `M${materialId}` : `N${name}`;
    const prev = db.prepare(
      'SELECT * FROM supplier_confirms WHERE tech_pack_id = ? AND material_key = ? AND is_current = 1'
    ).get(techPackId, materialKey);
    const version = (db.prepare(
      'SELECT COALESCE(MAX(version),0) v FROM supplier_confirms WHERE tech_pack_id = ? AND material_key = ?'
    ).get(techPackId, materialKey).v) + 1;

    const info = db.prepare(
      `INSERT INTO supplier_confirms
        (confirm_no, tech_pack_id, requirement_no, material_id, material_key, material_name, spec, composition,
         supplier_id, supplier_name, source_type, sample_basis, approval_ref, unit_price, lead_days,
         version, is_current, status, note, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'draft',?,?,?,?)`
    ).run(
      nextNo('supplier_confirms', 'confirm_no', 'SC'),
      techPackId, body.requirement_no || null, materialId, materialKey, name, spec, body.composition || null,
      supplierId, sup.name, sourceType, body.sample_basis || null, body.approval_ref || null,
      body.unit_price === undefined || body.unit_price === '' ? null : r2(body.unit_price),
      body.lead_days === undefined || body.lead_days === '' ? null : Number(body.lead_days),
      version, body.note || null, operator || null, ts, ts
    );
    const newId = info.lastInsertRowid;

    if (prev) {
      db.prepare('UPDATE supplier_confirms SET is_current=0, superseded_by=?, superseded_at=?, updated_at=? WHERE id=?')
        .run(newId, ts, ts, prev.id);
    }
    db.prepare('UPDATE supplier_confirms SET is_current=1 WHERE id=?').run(newId);
    db.exec('COMMIT');
    return packDetail(techPackId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function confirmSupplierConfirm(confirmId, operator) {
  const c = db.prepare('SELECT * FROM supplier_confirms WHERE id = ?').get(confirmId);
  if (!c) throw new Error('供方确认不存在');
  if (c.status === 'confirmed') throw new Error('这条供方确认已经确认过了');
  if (c.is_current !== 1) throw new Error('这是已作废的版本，不能确认（请确认当前版本）');
  if (c.source_type === 'sample_only' && !c.approval_ref) throw new Error('仅样料没写批准依据，不能确认');
  if (!c.unit_price || num(c.unit_price) <= 0) throw new Error('必须填有效单价（没有价格就无法核算成本与比价）');
  const ts = now();
  db.prepare("UPDATE supplier_confirms SET status='confirmed', confirmed_by=?, confirmed_at=?, updated_at=? WHERE id=?")
    .run(operator || null, ts, ts, confirmId);
  return packDetail(c.tech_pack_id);
}

/** 作废一条草稿供方确认（录错了要能撤；已确认的不能撤，改条件请出新版本） */
function cancelConfirm(confirmId, body) {
  const c = db.prepare('SELECT * FROM supplier_confirms WHERE id = ?').get(confirmId);
  if (!c) throw new Error('供方确认不存在');
  if (c.status === 'confirmed') throw new Error('已确认的供货条件不能作废：改条件请出新版本（换供方/改规格都会自动出新版）');
  if (c.status === 'cancelled') throw new Error('这条已经作废了');
  const reason = String(body.reason || '').trim();
  if (reason.length < 4) throw new Error('作废要写原因（≥4 字）');
  const ts = now();
  db.prepare("UPDATE supplier_confirms SET status='cancelled', is_current=0, superseded_at=?, note=COALESCE(note,'')||?, updated_at=? WHERE id=?")
    .run(ts, ' [作废] ' + reason, ts, confirmId);
  return packDetail(c.tech_pack_id);
}

// ---------------- A3 ----------------

/**
 * 技术复审。核心一条：**必须引用当前版本的 A2**。
 * 引用旧版本 = 拿过期的供货条件去核准技术包。
 */
function createReview(techPackId, body, operator) {
  packRow(techPackId);
  const confirmId = Number(body.confirm_id || 0) || null;
  if (!confirmId) throw new Error('复审必须引用一条供方确认（没有依据的核准就是拍板）');
  const c = db.prepare('SELECT * FROM supplier_confirms WHERE id = ?').get(confirmId);
  if (!c) throw new Error('引用的供方确认不存在');
  if (c.tech_pack_id !== Number(techPackId)) throw new Error('引用的供方确认不属于这个技术包');
  if (c.is_current !== 1) {
    const cur = db.prepare(
      'SELECT version FROM supplier_confirms WHERE tech_pack_id = ? AND material_key = ? AND is_current = 1'
    ).get(c.tech_pack_id, c.material_key);
    throw new Error(
      `引用的供货条件是已作废的 V${c.version}${cur ? `，当前是 V${cur.version}` : ''}：A3 必须引用同版本 A2`
    );
  }
  if (c.status !== 'confirmed') throw new Error('引用的供方确认还是草稿，先确认再复审');

  const conclusion = String(body.conclusion || '').trim();
  if (!CONCLUSION[conclusion]) throw new Error(`未知复审结论：${conclusion}`);
  const diffReason = String(body.diff_reason || '').trim();
  if (conclusion !== 'pass' && diffReason.length < 4) {
    throw new Error('有条件通过或退回必须写差异原因（≥4 字），否则下次没人知道差在哪');
  }
  const approvedBy = String(body.approved_by || '').trim();
  if (conclusion !== 'reject' && !approvedBy) throw new Error('通过类结论必须写核准人');

  const ts = now();
  db.exec('BEGIN');
  try {
    // 同一物料只能有一份生效结论：新结论覆盖旧的（旧的留痕，不删）
    if (conclusion !== 'reject') {
      db.prepare(
        "DELETE FROM tech_reviews WHERE tech_pack_id = ? AND IFNULL(material_name,'') = ? AND conclusion <> 'reject'"
      ).run(techPackId, c.material_name || '');
    }
    db.prepare(
      `INSERT INTO tech_reviews (review_no, tech_pack_id, confirm_id, confirm_version, material_name,
         conclusion, diff_reason, approved_by, approved_at, note, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      nextNo('tech_reviews', 'review_no', 'TR'),
      techPackId, confirmId, c.version, c.material_name,
      conclusion, diffReason || null, approvedBy || null,
      conclusion === 'reject' ? null : ts, body.note || null, operator || null, ts, ts
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return packDetail(techPackId);
}

/**
 * 核准技术包：三道门都过了才写 tech_packs.status = confirmed
 *
 * ⚠️ 这里**刻意不校验"至少 1 道车缝工序"**（该判断在 `routes/techpacks.js` 的
 * `confirmBlocks()`，由「开发单确认」与「打版流程推到已完成」两条路共用）。
 * 原因不是漏了：供方协同发生在打版流程的 **material 阶段**（面辅料确认），
 * 而工序明细要到 **craft 阶段**才存在。若在这里也要求车缝工序，
 * 等于"面辅料核准前先把工艺填好"，把正常业务顺序倒过来、卡住 A1→A3。
 * 也就是说这是两个里程碑的两个判断，不是同一个判断的两份实现。
 */
function approvePack(techPackId, body, operator) {
  const d = packDetail(techPackId);
  if (!d.can_approve) {
    throw new Error(`还不能核准技术包（当前：${d.stage_label}）：${d.problems.slice(0, 3).join('；')}`);
  }
  const rejects = d.reviews.filter((r) => r.conclusion === 'reject' && r.live === 1);
  if (rejects.length) throw new Error('还有被退回的复审结论，先处理');
  const ts = now();
  db.prepare("UPDATE tech_packs SET status='confirmed', stage='confirmed', confirmed_by=?, confirmed_at=?, updated_at=? WHERE id=?")
    .run(operator || body.approved_by || null, ts, ts, techPackId);
  return packDetail(techPackId);
}

module.exports = {
  dict, board, packDetail, options,
  saveAssignment, confirmAssignment,
  createConfirm, confirmSupplierConfirm, cancelConfirm,
  createReview, approvePack,
  // 给其他模块复用
  PATTERN_SCOPE, SOURCE_TYPE, CONCLUSION, STAGE, reviewStale
};
