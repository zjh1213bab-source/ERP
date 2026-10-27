/**
 * M05 研发立项与款式生命周期 + 商品 SKU 与配码包装主档 —— 服务层
 * ============================================================
 * 这一块要回答的问题只有三个，但答错代价很大：
 *   1) 这个月到底开发了几个款？（**里程碑不能相加**，开发款数只数「技术核准」）
 *   2) 这个 SKU 是什么？（**单花单码唯一**，套装/配码/箱规是**有版本的组合关系**）
 *   3) 研发计划会不会偷偷变成订单？（**不会**：目标数量只做计划，不产生采购与生产）
 */
const { db } = require('../db');

const EPS = 0.0001;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const r2 = (v) => Math.round(num(v) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const now = () => new Date().toISOString();
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const STAGES = [
  { k: 'draft', label: '立项草稿' },
  { k: 'tech', label: '技术开发中' },
  { k: 'sample', label: '打样中' },
  { k: 'confirmed', label: '技术核准' },
  { k: 'delivered', label: '已交付销售' },
  { k: 'ordered', label: '已下单' },
  { k: 'launched', label: '已首次上架' },
  { k: 'closed', label: '已结案' }
];
const STAGE_ORDER = STAGES.map((s) => s.k);
const STAGE_LABEL = STAGES.reduce((m, s) => ({ ...m, [s.k]: s.label }), {});

const SOURCE = {
  new: '全新开发',
  repeat: '返单复用',
  new_pattern: '同款新增花型'
};

/**
 * 里程碑定义。**顺序即因果**：前一个没发生，后一个不许登记。
 * 特别注意 `counted: true` 的只有 tech_approved ——
 * 「开发完成」按技术核准计数，其余是过程事件，**不能相加当开发款数**。
 */
const MILESTONES = [
  { k: 'tech_approved', label: '技术核准（开发完成）', counted: true, once: true },
  { k: 'sales_accepted', label: '销售接收', counted: false, once: true },
  { k: 'order_placed', label: '正式下单', counted: false, once: false },
  { k: 'in_production', label: '实际投产', counted: false, once: false },
  { k: 'us_launched', label: '首次美仓上架', counted: false, once: true }
];
const MS_BY_KEY = MILESTONES.reduce((m, x) => ({ ...m, [x.k]: x }), {});
const MS_ORDER = MILESTONES.map((x) => x.k);

const TASK_KIND = {
  pattern: '制版',
  sample: '样衣',
  tech_pack: '工艺单',
  costing: '核价'
};

const SKU_KIND = { single: '单件', set: '套装' };
const PACK_KIND = { set: '套装配码', carton: '箱规' };

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
    stages: STAGES,
    source: Object.entries(SOURCE).map(([k, label]) => ({ k, label })),
    milestones: MILESTONES.map((m) => ({ k: m.k, label: m.label, counted: m.counted, once: m.once })),
    task_kinds: Object.entries(TASK_KIND).map(([k, label]) => ({ k, label })),
    sku_kinds: Object.entries(SKU_KIND).map(([k, label]) => ({ k, label })),
    pack_kinds: Object.entries(PACK_KIND).map(([k, label]) => ({ k, label })),
    current_date: localDate()
  };
}

// ---------------- 里程碑 ----------------

function projectRow(id) {
  const p = db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(id);
  if (!p) throw new Error('研发项目不存在');
  return p;
}

function msOf(projectId) {
  return db.prepare('SELECT * FROM dev_milestones WHERE project_id = ? ORDER BY id').all(projectId);
}

function hasMs(projectId, kind) {
  return !!db.prepare('SELECT 1 x FROM dev_milestones WHERE project_id = ? AND kind = ?').get(projectId, kind);
}

/**
 * 登记里程碑。三条硬规则：
 *  ① 前驱必须先发生（没技术核准就不可能有「销售接收」）
 *  ② once 类事件不许重复（重复登记会让开发款数虚高）
 *  ③ 只有 tech_approved 计入「开发款数」
 */
function addMilestone(projectId, body, operator) {
  const p = projectRow(projectId);
  const kind = String(body.kind || '').trim();
  const def = MS_BY_KEY[kind];
  if (!def) throw new Error(`未知里程碑：${kind}`);
  if (p.status !== 'active') throw new Error('已结案/已取消的项目不能再登记里程碑');

  if (def.once && hasMs(projectId, kind)) {
    throw new Error(`「${def.label}」只能登记一次（重复登记会让开发款数虚高）`);
  }

  const idx = MS_ORDER.indexOf(kind);
  const prev = MS_ORDER.slice(0, idx);
  const missing = prev.filter((k) => {
    // 投产/下单允许多次，但只要有过一次就算满足
    return !hasMs(projectId, k);
  });
  if (missing.length) {
    throw new Error(
      `「${def.label}」的前置事件还没发生：${missing.map((k) => MS_BY_KEY[k].label).join('、')}`
    );
  }

  const occurredOn = String(body.occurred_on || localDate()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) throw new Error('发生日期格式应为 YYYY-MM-DD');

  const qty = body.qty === undefined || body.qty === null || body.qty === '' ? null : r2(body.qty);
  // 技术核准必须已经有样衣：核准一个没做出来的样衣是假核准
  if (kind === 'tech_approved') {
    if (!p.sample_no) throw new Error('技术核准前必须有样衣编号（没有样衣就核准，等于核准了一张图纸）');
    if (qty !== null && qty < 0) throw new Error('数量不能为负');
  }
  if (['order_placed', 'in_production', 'us_launched'].includes(kind)) {
    if (!(qty > 0)) throw new Error(`「${def.label}」必须登记件数`);
  }

  const ts = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO dev_milestones (project_id, kind, occurred_on, qty, ref_type, ref_id, ref_no, note, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      projectId, kind, occurredOn, qty,
      body.ref_type || null, body.ref_id || null, body.ref_no || null,
      body.note || null, operator || null, ts
    );

    // 阶段随里程碑推进（只前进，不回退）
    const target = {
      tech_approved: 'confirmed',
      sales_accepted: 'delivered',
      order_placed: 'ordered',
      in_production: 'ordered',
      us_launched: 'launched'
    }[kind];
    const cur = STAGE_ORDER.indexOf(p.stage);
    const tgt = STAGE_ORDER.indexOf(target);
    if (target && tgt > cur) {
      db.prepare('UPDATE dev_projects SET stage = ?, updated_at = ? WHERE id = ?').run(target, ts, projectId);
    }
    // 投产/上架要顺带把版型标为可复用（已经过大货验证）
    if (kind === 'in_production' || kind === 'us_launched') {
      db.prepare('UPDATE dev_projects SET pattern_reusable = 1, updated_at = ? WHERE id = ?').run(ts, projectId);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return projectDetail(projectId);
}

// ---------------- 项目 ----------------

function listProjects(q) {
  const where = [];
  const args = [];
  if (q.stage) { where.push('p.stage = ?'); args.push(q.stage); }
  if (q.biz_type) { where.push('p.biz_type = ?'); args.push(q.biz_type); }
  if (q.source) { where.push('p.source = ?'); args.push(q.source); }
  if (q.style_no) { where.push('p.style_no LIKE ?'); args.push(`%${q.style_no}%`); }
  if (q.month) { where.push('substr(p.created_at,1,7) = ?'); args.push(q.month); }
  if (q.keyword) {
    where.push('(p.style_no LIKE ? OR p.style_name LIKE ? OR p.project_no LIKE ?)');
    const k = `%${q.keyword}%`;
    args.push(k, k, k);
  }
  const rows = db.prepare(
    `SELECT p.*, c.name AS customer_name
     FROM dev_projects p LEFT JOIN customers c ON c.id = p.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.id DESC LIMIT 300`
  ).all(...args);

  return rows.map((p) => {
    const ms = msOf(p.id);
    const msKinds = ms.map((m) => m.kind);
    const tasks = db.prepare(
      `SELECT COUNT(*) c,
              SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) blocked
       FROM dev_tasks WHERE project_id = ?`
    ).get(p.id);
    return {
      ...p,
      stage_label: STAGE_LABEL[p.stage] || p.stage,
      source_label: SOURCE[p.source] || p.source,
      target_qty: r2(p.target_qty),
      milestone_done: msKinds.length,
      milestones: msKinds,
      dev_completed: msKinds.includes('tech_approved'),
      task_count: tasks.c || 0,
      task_done: tasks.done || 0,
      task_blocked: tasks.blocked || 0,
      // 计划上市日已过但还没上架 → 逾期
      launch_overdue:
        !!p.plan_launch_date && p.plan_launch_date < localDate() && !msKinds.includes('us_launched')
    };
  });
}

function projectDetail(id) {
  const p = projectRow(id);
  const cust = p.customer_id ? db.prepare('SELECT name FROM customers WHERE id = ?').get(p.customer_id) : null;
  // 返单复用的「技术核准」只是核对原版仍适用，**不算开发完成**；
  // 否则每月开发款数会被返单撑大，正是这个模块要防的错。
  const devCountable = p.source !== 'repeat';
  const milestones = msOf(id).map((m) => ({
    ...m,
    label: (MS_BY_KEY[m.kind] || {}).label || m.kind,
    counted: !!(MS_BY_KEY[m.kind] || {}).counted && devCountable,
    qty: m.qty === null ? null : r2(m.qty)
  }));
  const msKinds = milestones.map((m) => m.kind);
  const tasks = db.prepare('SELECT * FROM dev_tasks WHERE project_id = ? ORDER BY id').all(id).map((t) => ({
    ...t,
    kind_label: TASK_KIND[t.kind] || t.kind
  }));
  const skus = db.prepare(
    `SELECT s.*, pk.pack_no FROM sku_masters s LEFT JOIN pack_specs pk ON pk.id = s.pack_spec_id
     WHERE s.style_no = ? ORDER BY s.kind, s.pattern, s.color, s.size`
  ).all(p.style_no).map((s) => ({ ...s, kind_label: SKU_KIND[s.kind] || s.kind }));

  // 返单复用的原项目：有才取，没有就是新开发
  const reuse = p.reuse_project_id
    ? db.prepare('SELECT id, project_no, style_no, pattern_no, pattern_reusable FROM dev_projects WHERE id = ?').get(p.reuse_project_id)
    : null;

  // 真实发生的单据（里程碑登记）与「计划数量」严格分开
  const orderedQty = r2(milestones
    .filter((m) => m.kind === 'order_placed')
    .reduce((s, m) => s + num(m.qty), 0));
  const launchedQty = r2(milestones
    .filter((m) => m.kind === 'us_launched')
    .reduce((s, m) => s + num(m.qty), 0));

  const next = MILESTONES.find((m) => !msKinds.includes(m.k));
  const checks = [
    {
      k: 'pattern_before_sample',
      // 不看阶段：没版型就是没版型。草稿阶段显示未满足不是「错误」，是告诉人下一步要做什么
      // 返单的版型是原项目的：本项目没有版号不代表没版型
      ok: tasks.some((t) => t.kind === 'pattern' && t.status === 'done') || !!p.pattern_no || p.pattern_reusable === 1
        || (!!reuse && (!!reuse.pattern_no || reuse.pattern_reusable === 1)),
      label: '打样前已有版型（自建制版完成 / 复用原版 / 已有版型号）'
    },
    { k: 'sample_before_approve', ok: !!p.sample_no, label: '技术核准前已有样衣编号' },
    { k: 'classify_approved', ok: p.source !== 'new_pattern' || !!p.classify_approved_by, label: '同款新增花型已批准分类' },
    {
      k: 'reuse_source',
      ok: p.source !== 'repeat' || (!!reuse && reuse.pattern_reusable === 1),
      label: '返单复用的原版型已确认仍适用'
    },
    {
      k: 'no_side_effect',
      ok: true,
      label: '立项只做计划：不产生采购单、不产生生产单、不改库存'
    }
  ];

  return {
    ...p,
    target_qty: r2(p.target_qty),
    stage_label: STAGE_LABEL[p.stage] || p.stage,
    source_label: SOURCE[p.source] || p.source,
    customer_name: (cust && cust.name) || null,
    milestones,
    milestone_kinds: msKinds,
    dev_completed: msKinds.includes('tech_approved') && devCountable,
    counts_as_dev: devCountable ? 1 : 0,
    tasks,
    task_summary: {
      total: tasks.length,
      done: tasks.filter((t) => t.status === 'done').length,
      blocked: tasks.filter((t) => t.status === 'blocked').length
    },
    skus,
    reuse,
    next_milestone: next ? { k: next.k, label: next.label } : null,
    ordered_qty: orderedQty,
    launched_qty: launchedQty,
    plan_vs_actual: {
      target_qty: r2(p.target_qty),
      ordered_qty: orderedQty,
      note: '计划量只做参考，实际以里程碑登记为准；两者不能相加'
    },
    checks
  };
}

/**
 * 建立研发草稿。
 * 三个不许：
 *  - source=repeat 必须指向原项目，且原项目版型可复用
 *  - source=new_pattern 必须有批准分类人（返单/新花型算不算新开发要有批准依据）
 *  - 目标数量只记计划，**不写采购单、不写生产单、不动库存**
 */
function createProject(body, operator) {
  const styleNo = String(body.style_no || '').trim();
  if (!styleNo) throw new Error('款号必填（研发期没有正式款号也要先占位）');
  const bizType = body.biz_type === 'custom' ? 'custom' : 'spot';
  const source = Object.keys(SOURCE).includes(body.source) ? body.source : 'new';
  const targetQty = r2(body.target_qty || 0);
  if (targetQty < 0) throw new Error('预计首单量不能为负');

  let reuseId = null;
  if (source === 'repeat') {
    reuseId = Number(body.reuse_project_id || 0) || null;
    if (!reuseId) throw new Error('返单复用必须指定原项目（否则无法判断版型能不能沿用）');
    const origin = db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(reuseId);
    if (!origin) throw new Error('原项目不存在');
    if (origin.pattern_reusable !== 1) {
      throw new Error(`原项目 ${origin.project_no} 的版型还没确认可复用（需完成过投产或上架），返单要重新制版`);
    }
    const dup = db.prepare(
      `SELECT 1 x FROM dev_projects WHERE reuse_project_id = ? AND status = 'active'`
    ).get(reuseId);
    if (dup) throw new Error('该原项目已有一条在进行的返单，请先结案');
  }
  if (source === 'new_pattern' && !String(body.classify_approved_by || '').trim()) {
    throw new Error('同款新增花型必须先有批准分类人（算不算新开发要有依据，不能自己说了算）');
  }

  const ts = now();
  const projectNo = nextNo('dev_projects', 'project_no', 'DEV');
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO dev_projects
        (project_no, company_id, style_no, style_name, category, season, biz_type, customer_id,
         source, dev_type, reuse_project_id, classify_approved_by, classify_approved_at,
         owner, sales_owner, pattern_maker, target_qty, target_price, plan_launch_date,
         stage, note, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      projectNo, Number(body.company_id || 1), styleNo, body.style_name || null,
      body.category || null, body.season || null, bizType, body.customer_id || null,
      source, body.dev_type || 'self', reuseId,
      body.classify_approved_by || null,
      body.classify_approved_by ? ts : null,
      body.owner || null, body.sales_owner || null, body.pattern_maker || null,
      targetQty, body.target_price === undefined || body.target_price === '' ? null : r2(body.target_price),
      body.plan_launch_date || null,
      'draft', body.note || null, operator || null, ts, ts
    );
    db.exec('COMMIT');
    return projectDetail(info.lastInsertRowid);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function updateProject(id, body) {
  const p = projectRow(id);
  if (p.stage === 'closed') throw new Error('已结案的研发项目不能再改');
  const allow = ['style_name', 'category', 'season', 'customer_id', 'owner', 'sales_owner',
    'pattern_maker', 'pattern_no', 'sample_no', 'target_price', 'plan_launch_date', 'note', 'tech_pack_id'];
  const sets = [];
  const args = [];
  allow.forEach((k) => {
    if (body[k] === undefined) return;
    sets.push(`${k} = ?`);
    args.push(body[k] === '' ? null : body[k]);
  });
  if (body.target_qty !== undefined) {
    const q = r2(body.target_qty);
    if (q < 0) throw new Error('预计首单量不能为负');
    sets.push('target_qty = ?');
    args.push(q);
  }
  if (body.pattern_reusable !== undefined) {
    // 只有真正做过大货（投产/上架）才允许标可复用，否则返单就是拿未验证的版型去用
    if (body.pattern_reusable && !hasMs(id, 'in_production') && !hasMs(id, 'us_launched')) {
      throw new Error('版型还没经过大货验证（未投产/未上架），不能标记为可复用');
    }
    sets.push('pattern_reusable = ?');
    args.push(body.pattern_reusable ? 1 : 0);
  }
  if (!sets.length) return projectDetail(id);
  sets.push('updated_at = ?');
  args.push(now(), id);
  db.prepare(`UPDATE dev_projects SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return projectDetail(id);
}

/** 推进阶段：只许往前走一格，且必须满足该阶段的入门条件 */
function advanceStage(id, body) {
  const p = projectRow(id);
  if (p.stage === 'closed') throw new Error('已结案不能再推进');
  const target = String(body.stage || '').trim();
  if (!STAGE_LABEL[target]) throw new Error(`未知阶段：${target}`);
  const cur = STAGE_ORDER.indexOf(p.stage);
  const tgt = STAGE_ORDER.indexOf(target);
  if (tgt <= cur) throw new Error(`阶段只能往前走（当前 ${STAGE_LABEL[p.stage]}）`);
  if (tgt > cur + 1) throw new Error(`不能跳阶段：当前 ${STAGE_LABEL[p.stage]}，下一格应是 ${STAGE_LABEL[STAGE_ORDER[cur + 1]]}`);

  if (target === 'tech' && !p.owner) throw new Error('进入技术开发前要有技术负责人');
  if (target === 'sample') {
    const hasPattern = !!p.pattern_no || p.pattern_reusable === 1
      || db.prepare("SELECT 1 x FROM dev_tasks WHERE project_id = ? AND kind = 'pattern' AND status = 'done'").get(id);
    if (!hasPattern) throw new Error('打样前要先出版型（建一条制版任务并完成，或复用原版）');
  }
  if (target === 'confirmed') throw new Error('技术核准请走里程碑登记（要同时有样衣编号与发生日期）');
  if (target === 'delivered') throw new Error('交付销售请登记「销售接收」里程碑');
  if (target === 'ordered') throw new Error('已下单请登记「正式下单」里程碑（带件数与单据号）');
  if (target === 'launched') throw new Error('首次上架请登记「首次美仓上架」里程碑');

  db.prepare('UPDATE dev_projects SET stage = ?, updated_at = ? WHERE id = ?').run(target, now(), id);
  return projectDetail(id);
}

function addTask(projectId, body, operator) {
  projectRow(projectId);
  const kind = String(body.kind || '').trim();
  if (!TASK_KIND[kind]) throw new Error(`未知任务类型：${kind}`);
  const ts = now();
  const info = db.prepare(
    `INSERT INTO dev_tasks (project_id, kind, title, owner, due_date, status, blocked_reason,
       output, reuse_pattern, qty, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    projectId, kind, body.title || `${TASK_KIND[kind]}任务`, body.owner || null, body.due_date || null,
    'todo', null, null, body.reuse_pattern ? 1 : 0, r2(body.qty || 0), body.note || null, ts, ts
  );
  return { id: info.lastInsertRowid, project: projectDetail(projectId) };
}

/** 任务流转：blocked 必须写原因；done 必须写产出（否则等于没说做了啥） */
function setTaskStatus(taskId, body) {
  const t = db.prepare('SELECT * FROM dev_tasks WHERE id = ?').get(taskId);
  if (!t) throw new Error('任务不存在');
  const status = String(body.status || '').trim();
  if (!['todo', 'doing', 'done', 'blocked', 'cancelled'].includes(status)) throw new Error(`未知状态：${status}`);
  const ts = now();
  if (status === 'blocked') {
    const reason = String(body.blocked_reason || '').trim();
    if (reason.length < 4) throw new Error('阻塞必须写原因（≥4 字），否则下一个人不知道为什么卡住');
    db.prepare('UPDATE dev_tasks SET status=?, blocked_reason=?, updated_at=? WHERE id=?').run(status, reason, ts, taskId);
  } else if (status === 'done') {
    const output = String(body.output || '').trim();
    if (!output) throw new Error('完成必须写产出（版型号 / 样衣号 / 工艺单号），否则无法追溯');
    db.prepare(
      `UPDATE dev_tasks SET status=?, output=?, blocked_reason=NULL,
         started_at = COALESCE(started_at, ?), finished_at=?, updated_at=? WHERE id=?`
    ).run(status, output, ts, ts, ts, taskId);
    // 制版完成顺手把版型号写回项目，打样就不再拦
    if (t.kind === 'pattern') {
      db.prepare('UPDATE dev_projects SET pattern_no = COALESCE(pattern_no, ?), updated_at = ? WHERE id = ?')
        .run(output, ts, t.project_id);
    }
    if (t.kind === 'sample') {
      db.prepare('UPDATE dev_projects SET sample_no = COALESCE(sample_no, ?), updated_at = ? WHERE id = ?')
        .run(output, ts, t.project_id);
    }
  } else {
    db.prepare(
      'UPDATE dev_tasks SET status=?, started_at = CASE WHEN ? THEN COALESCE(started_at, ?) ELSE started_at END, updated_at=? WHERE id=?'
    ).run(status, status === 'doing' ? 1 : 0, ts, ts, taskId);
  }
  return projectDetail(t.project_id);
}

function closeProject(id, body) {
  const p = projectRow(id);
  if (p.stage === 'closed') throw new Error('已经结案了');
  const reason = String(body.reason || '').trim();
  if (reason.length < 4) throw new Error('结案必须写原因（≥4 字）：完成上市 / 终止开发 / 取消');
  const ts = now();
  db.prepare("UPDATE dev_projects SET stage='closed', status='closed', closed_reason=?, updated_at=? WHERE id=?")
    .run(reason, ts, id);
  return projectDetail(id);
}

// ---------------- 总览 ----------------

/**
 * 研发总览。这里的每个数字都必须能单独解释：
 *  开发款数 = tech_approved 的**去重项目数**（不是里程碑条数之和）
 *  下单件数 = order_placed 件数合计（多次下单会累加，这是应该的）
 */
function board(q) {
  const month = String(q.month || localDate().slice(0, 7));
  const rows = db.prepare(
    `SELECT * FROM dev_projects WHERE substr(created_at,1,7) <= ? ORDER BY id DESC`
  ).all(month);

  const ids = rows.map((r) => r.id);
  const msRows = ids.length
    ? db.prepare(
      `SELECT project_id, kind, COUNT(*) c, COALESCE(SUM(qty),0) qty
       FROM dev_milestones WHERE project_id IN (${ids.map(() => '?').join(',')})
       GROUP BY project_id, kind`
    ).all(...ids)
    : [];

  const perProject = {};
  msRows.forEach((m) => {
    perProject[m.project_id] = perProject[m.project_id] || {};
    perProject[m.project_id][m.kind] = { c: m.c, qty: r2(m.qty) };
  });

  const countOf = (kind) => rows.filter((r) => perProject[r.id] && perProject[r.id][kind]).length;
  // 开发款数：技术核准里**不含返单复用**（返单只是核对原版仍适用）
  const devCompletedCount = rows.filter((r) => r.source !== 'repeat'
    && perProject[r.id] && perProject[r.id].tech_approved).length;
  const sumQty = (kind) => r2(rows.reduce((s, r) => s + ((perProject[r.id] || {})[kind] ? perProject[r.id][kind].qty : 0), 0));

  const monthRows = rows.filter((r) => String(r.created_at).slice(0, 7) === month);
  const stageStat = STAGES.map((s) => ({
    stage: s.k,
    label: s.label,
    count: rows.filter((r) => r.stage === s.k).length
  }));

  const skuStat = db.prepare(
    `SELECT kind, COUNT(*) c, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active
     FROM sku_masters GROUP BY kind`
  ).all().map((x) => ({ kind: x.kind, label: SKU_KIND[x.kind] || x.kind, count: x.c, active: x.active || 0 }));

  const overdue = rows.filter(
    (r) => r.plan_launch_date && r.plan_launch_date < localDate()
      && !(perProject[r.id] && perProject[r.id].us_launched) && r.status === 'active'
  );

  return {
    month,
    stat: {
      month_new: monthRows.length,
      month_target_qty: r2(monthRows.reduce((s, r) => s + num(r.target_qty), 0)),
      // 开发款数：只数技术核准的**项目数**
      dev_completed: devCompletedCount,
      tech_approved_all: countOf('tech_approved'),
      repeat_count: rows.filter((r) => r.source === 'repeat').length,
      sales_accepted: countOf('sales_accepted'),
      ordered_projects: countOf('order_placed'),
      ordered_qty: sumQty('order_placed'),
      in_production_qty: sumQty('in_production'),
      launched_projects: countOf('us_launched'),
      launched_qty: sumQty('us_launched'),
      active: rows.filter((r) => r.status === 'active').length,
      overdue_launch: overdue.length,
      sku_total: skuStat.reduce((s, x) => s + x.count, 0)
    },
    // 这句话必须显式写在返回体里：前端直接渲染，不靠人记
    counting_note: '开发款数 = 技术核准的项目数，且不含返单复用（返单只是核对原版仍适用）；其余里程碑是过程事件，相加不等于开发款数',
    plan_note: '月度计划与预计首单量只做参考，不产生采购单、不产生生产单、不改库存',
    month_rows: monthRows.map((r) => ({
      id: r.id, project_no: r.project_no, style_no: r.style_no, style_name: r.style_name,
      stage: r.stage, stage_label: STAGE_LABEL[r.stage] || r.stage,
      target_qty: r2(r.target_qty), source_label: SOURCE[r.source] || r.source
    })),
    stage_stat: stageStat,
    sku_stat: skuStat,
    milestones: MILESTONES.map((m) => ({
      k: m.k, label: m.label, counted: m.counted,
      projects: m.k === 'tech_approved' ? devCompletedCount : countOf(m.k),
      projects_all: countOf(m.k),
      qty: sumQty(m.k)
    })),
    overdue: overdue.map((r) => ({
      id: r.id, project_no: r.project_no, style_no: r.style_no,
      plan_launch_date: r.plan_launch_date, stage_label: STAGE_LABEL[r.stage] || r.stage
    }))
  };
}

// ---------------- SKU 主档 ----------------

function skuRow(id) {
  const s = db.prepare('SELECT * FROM sku_masters WHERE id = ?').get(id);
  if (!s) throw new Error('SKU 不存在');
  return s;
}

function packDetail(specId) {
  const s = db.prepare('SELECT * FROM pack_specs WHERE id = ?').get(specId);
  if (!s) return null;
  const items = db.prepare('SELECT * FROM pack_spec_items WHERE spec_id = ? ORDER BY id').all(specId)
    .map((i) => {
      const comp = i.component_sku_id
        ? db.prepare('SELECT sku, style_no, pattern, color, size, unit FROM sku_masters WHERE id = ?').get(i.component_sku_id)
        : null;
      return { ...i, qty: r2(i.qty), component: comp || null };
    });
  return {
    ...s,
    kind_label: PACK_KIND[s.kind] || s.kind,
    total_qty: r2(s.total_qty),
    items,
    item_count: items.length
  };
}

function listSkus(q) {
  const where = [];
  const args = [];
  if (q.style_no) { where.push('s.style_no LIKE ?'); args.push(`%${q.style_no}%`); }
  if (q.kind) { where.push('s.kind = ?'); args.push(q.kind); }
  if (q.status) { where.push('s.status = ?'); args.push(q.status); }
  if (q.keyword) {
    where.push('(s.sku LIKE ? OR s.style_name LIKE ? OR s.pattern LIKE ? OR s.color LIKE ?)');
    const k = `%${q.keyword}%`;
    args.push(k, k, k, k);
  }
  const rows = db.prepare(
    `SELECT s.*, c.name AS customer_name, pk.pack_no, pk.version AS pack_version
     FROM sku_masters s
     LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN pack_specs pk ON pk.id = s.pack_spec_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.style_no, s.kind DESC, s.pattern, s.color, s.size LIMIT 500`
  ).all(...args);

  return rows.map((s) => {
    const spec = s.pack_spec_id ? packDetail(s.pack_spec_id) : null;
    const aliasCount = db.prepare("SELECT COUNT(*) c FROM sku_aliases WHERE sku_id = ? AND status='active'").get(s.id).c;
    return {
      ...s,
      kind_label: SKU_KIND[s.kind] || s.kind,
      pack_spec: spec,
      alias_count: aliasCount,
      // 套装必须能换算成件，否则库存单位就断了
      convertible: s.kind === 'single' ? true : !!(spec && spec.total_qty > 0)
    };
  });
}

/**
 * 建 SKU。两条硬约束：
 *  ① 单件：单花单码唯一（同款+花型+颜色+尺码+客户范围 只能有一个）
 *  ② 套装：单位必须是「套」，且**组件必须齐**——没有组件的套装没法换算成件，
 *     库存就既不能按套算也不能按件算。
 */
function createSku(body, operator) {
  const sku = String(body.sku || '').trim();
  if (!sku) throw new Error('SKU 编码必填');
  const styleNo = String(body.style_no || '').trim();
  if (!styleNo) throw new Error('款号必填');
  const kind = body.kind === 'set' ? 'set' : 'single';
  const unit = String(body.unit || (kind === 'set' ? '套' : '件')).trim();
  if (kind === 'set' && unit !== '套') throw new Error('套装的基本单位必须是「套」（库存基本单位是件，套要能换算成件）');
  if (kind === 'single' && unit !== '件') throw new Error('单件的基本单位必须是「件」');

  if (db.prepare('SELECT 1 x FROM sku_masters WHERE sku = ?').get(sku)) throw new Error(`SKU ${sku} 已存在`);
  if (db.prepare('SELECT 1 x FROM sku_aliases WHERE alias = ?').get(sku)) {
    throw new Error(`编码 ${sku} 已被用作别名，不能再当正式 SKU`);
  }

  // 单花单码唯一：先给一句人话，再让部分唯一索引兜并发
  if (kind === 'single') {
    const dup = db.prepare(
      `SELECT sku FROM sku_masters
       WHERE kind='single' AND style_no=? AND IFNULL(pattern,'')=? AND IFNULL(color,'')=?
         AND IFNULL(size,'')=? AND IFNULL(customer_id,0)=?`
    ).get(styleNo, body.pattern || '', body.color || '', body.size || '', Number(body.customer_id || 0));
    if (dup) {
      throw new Error(
        `同款同花型同色同码已有 SKU「${dup.sku}」：单花单码只能有一个身份证（不同客户要做专属，请指定客户）`
      );
    }
  }

  const ts = now();
  const info = db.prepare(
    `INSERT INTO sku_masters (sku, style_no, style_name, pattern, color, size, kind, unit, barcode,
       customer_id, status, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    sku, styleNo, body.style_name || null, body.pattern || null, body.color || null, body.size || null,
    kind, unit, body.barcode || null, body.customer_id || null,
    body.status === 'inactive' ? 'inactive' : 'active', body.remark || null, operator || null, ts, ts
  );
  // 单件唯一由部分唯一索引兜底（并发下也拦得住），这里给出友好错误
  const id = info.lastInsertRowid;
  return skuDetail(id);
}

function skuDetail(id) {
  const s = skuRow(id);
  const aliases = db.prepare('SELECT * FROM sku_aliases WHERE sku_id = ? ORDER BY id').all(id);
  const spec = s.pack_spec_id ? packDetail(s.pack_spec_id) : null;
  const specs = db.prepare('SELECT * FROM pack_specs WHERE sku_id = ? ORDER BY kind, version DESC').all(id)
    .map((x) => packDetail(x.id));
  return {
    ...s,
    kind_label: SKU_KIND[s.kind] || s.kind,
    pack_spec: spec,
    specs,
    aliases,
    // 组件（套装用）：这个套装由哪些 SKU 组成
    components: spec && spec.kind === 'set' ? spec.items : [],
    convertible: s.kind === 'single' ? true : !!(spec && spec.total_qty > 0)
  };
}

function updateSku(id, body) {
  const s = skuRow(id);
  const allow = ['barcode', 'remark', 'customer_id', 'pattern', 'color', 'size'];
  const sets = [];
  const args = [];
  allow.forEach((k) => {
    if (body[k] === undefined) return;
    sets.push(`${k} = ?`);
    args.push(body[k] === '' ? null : body[k]);
  });
  if (body.status !== undefined) {
    const st = body.status === 'inactive' ? 'inactive' : 'active';
    if (st === 'inactive' && s.kind === 'set') {
      const used = db.prepare("SELECT COUNT(*) c FROM pack_spec_items WHERE component_sku_id = ?").get(id).c;
      if (used > 0) throw new Error('这个 SKU 还是某个套装的组件，先改套装配码再停用');
    }
    sets.push('status = ?');
    args.push(st);
  }
  if (!sets.length) return skuDetail(id);
  sets.push('updated_at = ?');
  args.push(now(), id);
  db.prepare(`UPDATE sku_masters SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return skuDetail(id);
}

function addAlias(skuId, body) {
  const s = skuRow(skuId);
  const alias = String(body.alias || '').trim();
  if (!alias) throw new Error('别名必填');
  if (alias === s.sku) throw new Error('别名不能和正式 SKU 一样');
  if (db.prepare('SELECT 1 x FROM sku_masters WHERE sku = ?').get(alias)) throw new Error('该编码已是正式 SKU');
  if (db.prepare('SELECT 1 x FROM sku_aliases WHERE alias = ?').get(alias)) throw new Error('该别名已被占用');
  const ts = now();
  db.prepare(
    `INSERT INTO sku_aliases (sku_id, alias, source, status, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(skuId, alias, body.source || 'supplier', 'active', body.note || null, ts, ts);
  return skuDetail(skuId);
}

/** 停用别名：**不删**，历史单据还要靠它反查（停用只是不再用于新单） */
function disableAlias(aliasId, body) {
  const a = db.prepare('SELECT * FROM sku_aliases WHERE id = ?').get(aliasId);
  if (!a) throw new Error('别名不存在');
  if (a.status === 'inactive') throw new Error('这个别名已经停用了');
  const note = String(body.note || '').trim();
  if (note.length < 2) throw new Error('停用别名要写原因（新老系统切换 / 供应商改名 / 录入错误）');
  db.prepare("UPDATE sku_aliases SET status='inactive', note=?, updated_at=? WHERE id=?")
    .run(note, now(), aliasId);
  return skuDetail(a.sku_id);
}

// ---------------- 配码 / 箱规 ----------------

/**
 * 新建配码版本。规则：
 *  - total_qty **由明细算出，不手填**（手填的东西永远会和明细对不上）
 *  - 套装组件不能是它自己（自己装自己，件数无限）
 *  - 箱规配比必须 qty>0
 */
function createPackSpec(body, operator) {
  const skuId = body.sku_id ? Number(body.sku_id) : null;
  if (!skuId) throw new Error('配码必须挂在某个 SKU 上');
  const sku = skuRow(skuId);
  const kind = body.kind === 'set' ? 'set' : 'carton';
  if (kind === 'set' && sku.kind !== 'set') throw new Error('套装配码只能挂在套装 SKU 上');
  if (kind === 'carton' && sku.kind !== 'single') throw new Error('箱规只能挂在单件 SKU 上');

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new Error('配码明细不能为空（没有明细就换算不出件数）');

  const ts = now();
  const version = r2(
    (db.prepare('SELECT COALESCE(MAX(version),0) v FROM pack_specs WHERE sku_id = ? AND kind = ?').get(skuId, kind).v) + 1
  );
  const prefix = kind === 'set' ? 'SET' : 'PK';
  const packNo = String(body.pack_no || '').trim() || `${prefix}-${sku.sku}-V${version}`;

  let total = 0;
  const rows = items.map((it) => {
    const qty = r2(it.qty);
    if (!(qty > 0)) throw new Error('每条配码的件数必须大于 0');
    total = r2(total + qty);
    if (kind === 'set') {
      const cid = Number(it.component_sku_id || 0);
      if (!cid) throw new Error('套装组件必须指定 SKU');
      if (cid === skuId) throw new Error('套装不能把自己当组件（件数会无限循环）');
      const comp = db.prepare('SELECT id, kind, status FROM sku_masters WHERE id = ?').get(cid);
      if (!comp) throw new Error('组件 SKU 不存在');
      if (comp.kind === 'set') throw new Error('套装组件不能再是套装（多层嵌套换算不出件数）');
      if (comp.status !== 'active') throw new Error('组件 SKU 已停用');
      return { item_type: 'component', component_sku_id: cid, size: null, qty };
    }
    const size = String(it.size || '').trim();
    if (!size) throw new Error('箱规必须是「尺码 + 件数」');
    return { item_type: 'ratio', component_sku_id: null, size, qty };
  });

  // 同尺码只能出现一次
  if (kind === 'carton') {
    const seen = new Set();
    rows.forEach((x) => {
      if (seen.has(x.size)) throw new Error(`尺码 ${x.size} 重复了`);
      seen.add(x.size);
    });
  } else {
    const seen = new Set();
    rows.forEach((x) => {
      if (seen.has(x.component_sku_id)) throw new Error('同一个组件只能出现一次');
      seen.add(x.component_sku_id);
    });
  }

  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO pack_specs (pack_no, sku_id, kind, version, status, total_qty, effective_from, note, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(packNo, skuId, kind, version, 'draft', total, body.effective_from || null, body.note || null, operator || null, ts, ts);
    const specId = info.lastInsertRowid;
    const stmt = db.prepare(
      'INSERT INTO pack_spec_items (spec_id, item_type, component_sku_id, size, qty) VALUES (?,?,?,?,?)'
    );
    rows.forEach((r) => stmt.run(specId, r.item_type, r.component_sku_id, r.size, r.qty));
    db.exec('COMMIT');
    return packDetail(specId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 启用某一版：同对象同类只能有一版生效，旧版自动 superseded 并回填失效日 */
function activatePackSpec(specId, body) {
  const s = db.prepare('SELECT * FROM pack_specs WHERE id = ?').get(specId);
  if (!s) throw new Error('配码版本不存在');
  if (s.status === 'active') throw new Error('这一版已经在生效了');
  const ts = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      "UPDATE pack_specs SET status='superseded', effective_to=?, updated_at=? WHERE sku_id=? AND kind=? AND status='active'"
    ).run(ts.slice(0, 10), ts, s.sku_id, s.kind);
    db.prepare("UPDATE pack_specs SET status='active', effective_from=COALESCE(effective_from,?), updated_at=? WHERE id=?")
      .run(ts.slice(0, 10), ts, specId);
    // SKU 主档指向当前生效版本（箱规/套装配码都是）
    db.prepare('UPDATE sku_masters SET pack_spec_id=?, updated_at=? WHERE id=?').run(specId, ts, s.sku_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return packDetail(specId);
}

/**
 * 套件换算：把「套」拆成「件」。
 * 库存基本单位是件，所以任何按套出入库之前都要能算出件数；
 * 算不出来就不许动库存（宁可不做，也不要把套当件记）。
 */
function explode(skuId, qty) {
  const s = skuRow(skuId);
  const q = r2(qty);
  if (!(q > 0)) throw new Error('换算数量必须大于 0');
  if (s.kind === 'single') {
    return { sku: s.sku, kind: 'single', unit: s.unit, qty: q, pieces: q, components: [] };
  }
  const spec = s.pack_spec_id ? packDetail(s.pack_spec_id) : null;
  if (!spec || !spec.items.length) throw new Error('这个套装没有生效的配码版本，换算不出件数');
  if (spec.kind !== 'set') throw new Error('这个 SKU 当前生效的配码不是套装关系');
  const comps = spec.items.map((i) => ({
    sku_id: i.component_sku_id,
    sku: i.component ? i.component.sku : null,
    qty_per_set: r2(i.qty),
    pieces: r2(i.qty * q)
  }));
  const pieces = r2(comps.reduce((sum, c) => sum + c.pieces, 0));
  return {
    sku: s.sku, kind: 'set', unit: s.unit, qty: q,
    pieces, pieces_per_set: spec.total_qty, pack_no: spec.pack_no, version: spec.version,
    components: comps
  };
}

module.exports = {
  dict, board,
  listProjects, projectDetail, createProject, updateProject, advanceStage,
  addMilestone, addTask, setTaskStatus, closeProject,
  listSkus, skuDetail, createSku, updateSku, addAlias, disableAlias,
  createPackSpec, activatePackSpec, packDetail, explode,
  // 供演示与冒烟复用
  STAGES, MILESTONES, SOURCE, r2
};
