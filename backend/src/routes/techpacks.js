/**
 * 技术资料 / 开发单（tech_packs）—— P2
 * 字段：面料、辅料、工艺工序、客户要求、尺码规格
 * 定制订单「技术确认」前，必须填写 面料/辅料/工艺工序/客户要求
 * GET  /api/techpacks?order_id=
 * POST /api/techpacks
 * PUT  /api/techpacks/:id
 * POST /api/techpacks/:id/confirm
 * POST /api/techpacks/:id/reject
 */
const express = require('express');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { saveMaterials } = require('../services/techPackMaterials');
const { ensureFlow } = require('./patternFlows');

const router = express.Router();
const WRITE = ['admin', 'tech', 'sales'];
const REVIEW = ['admin', 'tech'];

function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 定制订单确认前的齐备性校验。
 * 面辅料既可以来自结构化明细（工艺单里的物料行），也可以来自旧版文本框 / 主数据勾选，任一即可。
 */
function missingOf(row) {
  const mats = db.prepare('SELECT mat_type FROM tech_pack_materials WHERE tech_pack_id = ?').all(row.id);
  const hasFabricRow = mats.some((m) => m.mat_type === 'fabric');
  const hasAccRow = mats.some((m) => m.mat_type === 'accessory');
  const reqCount = Number(
    db.prepare('SELECT COUNT(*) AS c FROM tech_pack_requirements WHERE tech_pack_id = ?').get(row.id).c
  );
  const sizeCount = Number(
    db.prepare('SELECT COUNT(*) AS c FROM tech_pack_sizes WHERE tech_pack_id = ?').get(row.id).c
  );

  const missing = [];
  if (!hasFabricRow && !hasText(row.fabric_info) && !hasText(row.fabric_ids)) missing.push('面料');
  if (!hasAccRow && !hasText(row.accessory_info) && !hasText(row.accessory_ids)) missing.push('辅料');
  if (!hasText(row.craft_info) && !reqCount) missing.push('工艺工序 / 生产要求');
  if (!hasText(row.customer_req)) missing.push('客户要求');
  return { missing, sizeCount };
}

/**
 * 工序明细里的车缝道数（0 = 没填）
 *
 * 数据只有一份：打版流程 craft 阶段的 `data.sewing`（见下方 crafts 接口的说明）。
 * 没有流程、没有 craft 阶段、`data` 是坏 JSON —— 对"确认前的齐备性"来说都和"没填"是同一件事，
 * 一律返回 0，不去猜。
 */
function sewingCountOf(tpId) {
  const { stage } = craftStageOf(tpId);
  return normCraftRows(readCraftData(stage).sewing).length;
}

/**
 * 确认前的阻断项 —— **唯一一份实现**
 *
 * ## 为什么必须抽成一个函数
 *
 * 把开发单置为"已确认"有**两条路**：
 *   1. `POST /:id/confirm`   —— 订单页 / 审批页的「确认」按钮
 *   2. `POST /:id/stage`     —— 打版流程推到最后一步 `confirmed`
 * 校验各写一份，结果一定是"这条拦、那条漏"（本仓库已经在"单张 vs 批量"上踩过一次：
 * 单张拦住了、批量漏了，而且漏的时候页面还显示成功）。所以两条路都调这一个函数。
 *
 * ## 口径
 *
 * - 只针对**定制订单**：现货订单的开发单是轻量资料，不卡工序，卡了会挡住正常发货节奏；
 * - 字段齐备性沿用 `missingOf`（面料 / 辅料 / 工艺说明或生产要求 / 客户要求）；
 * - 工序明细：**至少 1 道车缝**。没有车缝工序 = 工价算不出、报工没法按工序报、
 *   外发/自产的工钱都对不上 —— 这时候"确认"等于把问题推给生产车间。
 *
 * 返回空数组表示可以确认。
 */
function confirmBlocks(row) {
  const order = db.prepare('SELECT type FROM orders WHERE id = ?').get(row.order_id);
  if (!order || order.type !== 'custom') return [];

  const blocks = [];
  const { missing } = missingOf(row);
  if (missing.length) {
    blocks.push({
      key: 'fields',
      label: '必填项缺失',
      detail: missing.join('、'),
      where: '开发单基本资料'
    });
  }
  if (sewingCountOf(row.id) === 0) {
    blocks.push({
      key: 'craft_sewing',
      label: '工序明细未填',
      detail: '至少 1 道车缝工序',
      where: '工艺工序 → 展开填写工序明细（与打版「工艺/工序明细」同一份数据）'
    });
  }
  return blocks;
}

/** 阻断项拼成人话：接口报错与页面提示共用一份措辞，避免两边说法不一致 */
function blockMessage(blocks) {
  return (
    '定制订单的开发单还不能确认：' +
    blocks.map((b) => `${b.label}（${b.detail}）`).join('；') +
    '。请补充后再确认。'
  );
}

// 开发管理：全量列表（关联订单/客户）
router.get('/all', authRequired, wrap(async (req, res) => {
  const { status = '', q = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('tp.status = ?'); params.push(status); }
  if (q) {
    where.push('(tp.product_name LIKE ? OR o.order_no LIKE ? OR o.style_name LIKE ? OR c.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sql = `SELECT tp.*, o.order_no, o.style_name, o.type AS order_type, o.status AS order_status, c.name AS customer_name
    FROM tech_packs tp
    LEFT JOIN orders o ON o.id = tp.order_id
    LEFT JOIN customers c ON c.id = o.customer_id ` +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY tp.id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/', authRequired, wrap(async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return fail(res, 400, '缺少 order_id');
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE order_id = ? ORDER BY id DESC').all(order_id));
}));

// ---------- 开发单完整明细（工艺单 / 总单的打印数据源） ----------
function loadFull(id) {
  const tp = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(id);
  if (!tp) return null;
  tp.materials = db.prepare('SELECT * FROM tech_pack_materials WHERE tech_pack_id = ? ORDER BY sort, id').all(id);
  tp.sizes = db.prepare('SELECT * FROM tech_pack_sizes WHERE tech_pack_id = ? ORDER BY sort, id').all(id);
  tp.requirements = db.prepare('SELECT * FROM tech_pack_requirements WHERE tech_pack_id = ? ORDER BY sort, id').all(id);
  tp.order = db.prepare(
    `SELECT o.*, c.name AS customer_name FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).get(tp.order_id) || null;
  /**
   * 确认前还差什么 —— 跟着明细一起返回
   *
   * 放这里而不是让页面另发一次请求：详情弹窗、订单页、打印源都用 `loadFull`，
   * 一次带出来就不会出现"页面显示可以确认、点了却被接口拒绝"。
   * 已确认的单不再算（它已经过了校验，再算只会显示一堆历史提示）。
   */
  tp.confirm_blocks = tp.status === 'confirmed' ? [] : confirmBlocks(tp);
  return tp;
}

router.get('/:id/full', authRequired, wrap(async (req, res) => {
  const tp = loadFull(req.params.id);
  if (!tp) return fail(res, 404, '技术资料不存在');
  return ok(res, tp);
}));

/**
 * 取该订单「当前生效」的开发单（打印总单/工艺单用）
 * 优先级：已确认且款名匹配订单款 > 最新的已确认 > 最新一条
 * 不用「最新一条」是因为草稿版本可能还没有任何明细，打出来是空的
 */
router.get('/by-order/:orderId/current', authRequired, wrap(async (req, res) => {
  const list = db.prepare('SELECT * FROM tech_packs WHERE order_id = ? ORDER BY id DESC').all(req.params.orderId);
  if (!list.length) return ok(res, null);
  const order = db.prepare('SELECT style_name FROM orders WHERE id = ?').get(req.params.orderId);
  const style = (order && order.style_name) || '';
  let pick = null;
  if (style) {
    pick = list.find((t) => t.status === 'confirmed' && t.product_name && t.product_name.includes(style));
  }
  if (!pick) pick = list.find((t) => t.status === 'confirmed');
  if (!pick) pick = list[0];
  return ok(res, loadFull(pick.id));
}));

/** 取数字（空 / 非法一律 0） */
function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function r2(v) {
  return Math.round(n(v) * 100) / 100;
}

const HEAD_FIELDS = [
  'customer_style_no', 'designer', 'pattern_maker', 'pattern_no', 'category', 'label_name',
  'series', 'wave', 'sales_owner', 'po_no', 'brand', 'colors', 'size_range', 'delivery_date',
  'customer_req', 'craft_info', 'size_spec', 'remark'
];

/**
 * 整份保存开发单明细（头部 + 面辅料 + 成衣尺寸 + 生产要求）
 * 采用「事务内全量替换」：前端提交什么就是什么，天然幂等，避免逐行 diff 出错
 */
router.put('/:id/detail', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');
  if (row.status === 'confirmed') return fail(res, 400, '已确认的开发单不可修改，请新建版本');

  const b = req.body || {};
  const materials = Array.isArray(b.materials) ? b.materials : null;
  const sizes = Array.isArray(b.sizes) ? b.sizes : null;
  const requirements = Array.isArray(b.requirements) ? b.requirements : null;

  // 头部：只更新传了的字段
  const sets = [];
  const vals = [];
  HEAD_FIELDS.forEach((f) => {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f] === '' ? null : b[f]); }
  });
  if (b.product_name) { sets.push('product_name = ?'); vals.push(b.product_name); }
  if (b.version) { sets.push('version = ?'); vals.push(b.version); }
  if (b.image_url !== undefined) { sets.push('image_url = ?'); vals.push(b.image_url || null); }

  const t = now();
  db.exec('BEGIN');
  try {
    if (sets.length) {
      db.prepare(`UPDATE tech_packs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, t, req.params.id);
    } else {
      db.prepare('UPDATE tech_packs SET updated_at = ? WHERE id = ?').run(t, req.params.id);
    }

    if (materials) {
      saveMaterials(req.params.id, materials);
    }

    if (sizes) {
      db.prepare('DELETE FROM tech_pack_sizes WHERE tech_pack_id = ?').run(req.params.id);
      const ins = db.prepare(
        'INSERT INTO tech_pack_sizes (tech_pack_id, part, size, value, tolerance, sort, created_at) VALUES (?,?,?,?,?,?,?)'
      );
      sizes.forEach((s, i) => {
        if (!s.part || !s.size) return;
        ins.run(req.params.id, String(s.part).trim(), String(s.size).trim(), s.value || null, s.tolerance || null, i, t);
      });
    }

    if (requirements) {
      db.prepare('DELETE FROM tech_pack_requirements WHERE tech_pack_id = ?').run(req.params.id);
      const ins = db.prepare(
        'INSERT INTO tech_pack_requirements (tech_pack_id, category, content, sort, created_at) VALUES (?,?,?,?,?)'
      );
      requirements.forEach((r, i) => {
        if (!r.content || !String(r.content).trim()) return;
        const cat = ['craft', 'packing', 'test', 'note'].includes(r.category) ? r.category : 'craft';
        ins.run(req.params.id, cat, String(r.content).trim(), i, t);
      });
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, loadFull(req.params.id));
}));

/**
 * 从订单明细带出成衣尺寸骨架：按订单里出现的尺码建列，部位用默认清单
 * 已有尺寸数据时不覆盖，避免误清手工录入
 */
router.post('/:id/sizes/from-order', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');
  if (row.status === 'confirmed') return fail(res, 400, '已确认的开发单不可修改，请新建版本');

  const exists = db.prepare('SELECT COUNT(*) AS c FROM tech_pack_sizes WHERE tech_pack_id = ?').get(req.params.id).c;
  if (Number(exists) > 0 && !(req.body || {}).overwrite) {
    return fail(res, 400, '该开发单已有尺寸数据；如需重建请传 overwrite:true');
  }

  const sizeRows = db.prepare(
    `SELECT DISTINCT s.size FROM order_items i
     JOIN order_item_sizes s ON s.item_id = i.id
     WHERE i.order_id = ? AND s.size IS NOT NULL AND s.size != ''`
  ).all(row.order_id);
  const sizes = sizeRows.map((r) => r.size);
  if (!sizes.length) return fail(res, 400, '订单明细里没有尺码，无法生成尺寸表');

  const DEFAULT_PARTS = req.body && Array.isArray(req.body.parts) && req.body.parts.length
    ? req.body.parts
    : ['衣长', '胸围', '肩宽', '袖长', '下摆', '袖口'];

  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM tech_pack_sizes WHERE tech_pack_id = ?').run(req.params.id);
    const ins = db.prepare(
      'INSERT INTO tech_pack_sizes (tech_pack_id, part, size, value, tolerance, sort, created_at) VALUES (?,?,?,?,?,?,?)'
    );
    let i = 0;
    DEFAULT_PARTS.forEach((p) => sizes.forEach((s) => ins.run(req.params.id, p, s, null, null, i++, t)));
    db.prepare('UPDATE tech_packs SET size_range = ?, updated_at = ? WHERE id = ?').run(sizes.join('/'), t, req.params.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, loadFull(req.params.id));
}));


router.post('/', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.order_id) return fail(res, 400, '缺少 order_id');
  if (!db.prepare('SELECT 1 AS x FROM orders WHERE id = ?').get(b.order_id)) {
    return fail(res, 404, '订单不存在');
  }
  if (!b.product_name) return fail(res, 400, '请填写产品/款号');
  const t = now();
  const info = db.prepare(
    `INSERT INTO tech_packs (order_id, product_name, version, fabric_info, accessory_info, craft_info, customer_req, fabric_ids, accessory_ids, size_spec, image_url, status, remark, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`
  ).run(
    b.order_id, b.product_name, b.version || 'V1',
    b.fabric_info || null, b.accessory_info || null, b.craft_info || null,
    b.customer_req || null, b.fabric_ids || null, b.accessory_ids || null, b.size_spec || null,
    b.image_url || null,
    b.remark || null, req.user.sub, t, t
  );
  const created = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(Number(info.lastInsertRowid));
  // 每份开发单自动开一条打版流程（面辅料确认 → … → 工价核价）
  try { ensureFlow(created.id, req.user.sub); } catch (e) { /* 流程创建失败不影响开发单本身 */ }
  return ok(res, created);
}));

router.put('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');
  if (row.status === 'confirmed') return fail(res, 400, '已确认的开发单不可修改，请新建版本');
  const patternFlow = db.prepare('SELECT current_stage,status FROM pattern_flows WHERE tech_pack_id=?').get(row.id);
  if (patternFlow && patternFlow.status !== 'done' && patternFlow.current_stage !== 'material') {
    return fail(res, 409, '打版流程已开始；业务信息修改请从打版流程提交申请并通过修改后复核');
  }
  const b = req.body || {};
  db.prepare(
    `UPDATE tech_packs SET product_name=?, version=?, fabric_info=?, accessory_info=?, craft_info=?, customer_req=?, fabric_ids=?, accessory_ids=?, size_spec=?, image_url=?, remark=?, updated_at=? WHERE id=?`
  ).run(
    b.product_name || row.product_name,
    b.version || row.version,
    b.fabric_info ?? row.fabric_info,
    b.accessory_info ?? row.accessory_info,
    b.craft_info ?? row.craft_info,
    b.customer_req ?? row.customer_req,
    b.fabric_ids ?? row.fabric_ids,
    b.accessory_ids ?? row.accessory_ids,
    b.size_spec ?? row.size_spec,
    b.image_url ?? row.image_url,
    b.remark ?? row.remark,
    now(), req.params.id
  );
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id));
}));

/**
 * 工序明细（开发单里「工艺工序」的"展开填写"）
 * ============================================================
 * ## 为什么读写的是打版流程的 craft 阶段
 *
 * 工序在系统里本来就有一份主数据：打版流程「工艺/工序明细」阶段的
 * `data.sewing` / `data.finish` —— 就是订单工序页面那张表（类别 / 名称 / 单价 /
 * 倍率 / 负责人 / 备注 / 开放单价）。
 *
 * 如果开发单再存一份自己的工序表，**立刻就是两份真相**：开发单改完打版页不知道，
 * 打版页改完开发单又盖回去，最后没人知道哪份对、工价按哪份算。
 * 所以这里只做**同一份数据的另一个入口**：按 tech_pack 找到流程 → 定位 craft 阶段 → 读/写它的 data。
 *
 * ## 为什么权限是 admin/tech 而不是"能建开发单的人"
 *
 * 建开发单允许 sales（业务先立项），但**工序与工价是技术岗的活** ——
 * 与打版页 `STAGE_DEF.craft.roles = ['admin','tech']` 保持同一口径。
 * 同一件事两套权限，最后一定出现"页面能改、接口不让改"（或反过来）这种半截状态。
 */
const CRAFT_GROUPS = ['sewing', 'finish'];
/** 单组最多 300 行：够任何一款衣服用，同时挡住"贴一万行进库"这种误操作 */
const CRAFT_MAX_ROWS = 300;

function craftStageOf(tpId) {
  const flow = db.prepare('SELECT * FROM pattern_flows WHERE tech_pack_id = ?').get(Number(tpId));
  if (!flow) return { flow: null, stage: null };
  const stage = db.prepare("SELECT * FROM pattern_stages WHERE flow_id = ? AND stage = 'craft'").get(flow.id);
  return { flow, stage };
}

/** 行归一：只留认识的字段、丢掉空行、数字转干净（前端传什么脏值都进不来） */
function normCraftRows(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, CRAFT_MAX_ROWS).map((r) => ({
    category: String((r && r.category) || '').slice(0, 24),
    name: String((r && r.name) || '').trim().slice(0, 60),
    price: Math.round((Number(r && r.price) || 0) * 100) / 100,
    ratio: Number(r && r.ratio) || 0,
    owner: String((r && r.owner) || '').slice(0, 24),
    remark: String((r && r.remark) || '').slice(0, 120),
    open_price: Math.round((Number(r && r.open_price) || 0) * 100) / 100
  })).filter((r) => r.name);
}

function readCraftData(stage) {
  if (!stage || !stage.data) return {};
  try { return JSON.parse(stage.data) || {}; } catch (e) { return {}; }
}

/** 读：开发单的工序明细（没有流程时返回空表，不自动建流程） */
router.get('/:id/crafts', authRequired, wrap(async (req, res) => {
  const tp = db.prepare('SELECT id FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!tp) return fail(res, 404, '开发单不存在');
  const { flow, stage } = craftStageOf(tp.id);
  const data = readCraftData(stage);
  return ok(res, {
    flow_id: flow ? flow.id : null,
    flow_status: flow ? flow.status : null,
    stage_status: stage ? stage.status : null,
    sewing: normCraftRows(data.sewing),
    finish: normCraftRows(data.finish),
    process_note: data.process_note || ''
  });
}));

/** 写：只替换 sewing / finish（可选 process_note），**保留 data 里其它键** */
router.put('/:id/crafts', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const tp = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!tp) return fail(res, 404, '开发单不存在');
  if (tp.status === 'confirmed') return fail(res, 400, '已确认的开发单不可修改，请新建版本');

  const flow = ensureFlow(tp.id, req.user.sub);
  if (!flow) return fail(res, 404, '开发单不存在');
  if (flow.status === 'done') {
    return fail(res, 400, '打版流程已完成、样衣已归档锁定；要改工序请提交变更需求');
  }

  let stage = db.prepare("SELECT * FROM pattern_stages WHERE flow_id = ? AND stage = 'craft'").get(flow.id);
  if (!stage) {
    db.prepare("INSERT INTO pattern_stages (flow_id, stage, status, updated_at) VALUES (?,?,'pending',?)")
      .run(flow.id, 'craft', now());
    stage = db.prepare("SELECT * FROM pattern_stages WHERE flow_id = ? AND stage = 'craft'").get(flow.id);
  }

  const data = readCraftData(stage);
  const b = req.body || {};
  CRAFT_GROUPS.forEach((k) => { if (b[k] !== undefined) data[k] = normCraftRows(b[k]); });
  if (b.process_note !== undefined) data.process_note = String(b.process_note || '').slice(0, 500);

  db.prepare('UPDATE pattern_stages SET data = ?, operator = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(data), req.user.username, now(), stage.id);

  return ok(res, {
    sewing: normCraftRows(data.sewing),
    finish: normCraftRows(data.finish),
    process_note: data.process_note || ''
  });
}));

/**
 * 确认前检查（只读）
 *
 * 页面在点「确认」之前先问一次，把缺什么直接列出来 —— 而不是让人点了才收到一句报错。
 * 与 `POST /:id/confirm`、`POST /:id/stage` 用的是同一个 `confirmBlocks()`，
 * 所以"检查说没问题、点确认却被拒"这种情况不会发生。
 */
router.get('/:id/confirm-check', authRequired, wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');
  const blocks = confirmBlocks(row);
  return ok(res, {
    ok: blocks.length === 0,
    blocks,
    message: blocks.length ? blockMessage(blocks) : ''
  });
}));

router.post('/:id/confirm', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');

  // 确认前校验（定制订单）：字段齐备 + 至少 1 道车缝工序。两条确认路径共用同一份判断
  const blocks = confirmBlocks(row);
  if (blocks.length) return fail(res, 400, blockMessage(blocks));

  const t = now();
  db.prepare("UPDATE tech_packs SET status='confirmed', confirmed_by=?, confirmed_at=?, updated_at=? WHERE id=?")
    .run(req.user.username, t, t, req.params.id);
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id));
}));

router.post('/:id/reject', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const row = db.prepare('SELECT 1 AS x FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');
  db.prepare("UPDATE tech_packs SET status='rejected', updated_at=? WHERE id=?").run(now(), req.params.id);
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id));
}));

// 打版流程推进：draft→material→pattern→craft→sample→biz→confirmed
const STAGES = ['draft', 'material', 'pattern', 'craft', 'sample', 'biz', 'confirmed'];

router.post('/:id/stage', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const { stage } = req.body || {};
  if (!STAGES.includes(stage)) return fail(res, 400, '非法的流程阶段');
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');

  if (stage === 'confirmed') {
    // 与 POST /:id/confirm 完全同一份校验（两条路都会把开发单置为已确认）
    const blocks = confirmBlocks(row);
    if (blocks.length) return fail(res, 400, blockMessage(blocks));
    const t = now();
    db.prepare("UPDATE tech_packs SET stage='confirmed', status='confirmed', confirmed_by=?, confirmed_at=?, updated_at=? WHERE id=?")
      .run(req.user.username, t, t, req.params.id);
  } else {
    db.prepare("UPDATE tech_packs SET stage=?, status=CASE WHEN status='confirmed' THEN 'draft' ELSE status END, updated_at=? WHERE id=?")
      .run(stage, now(), req.params.id);
  }
  return ok(res, db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id));
}));

/**
 * 新建版本：已确认的开发单要改，必须走这里。
 * 复制头部 + 面辅料 / 成衣尺寸 / 生产要求 到新版本（草稿），旧版本原样保留可追溯。
 */
router.post('/:id/new-version', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');

  // 版本号：取同订单里最大的 Vn，+1
  const versions = db.prepare('SELECT version FROM tech_packs WHERE order_id = ?').all(row.order_id);
  let maxN = 0;
  versions.forEach((v) => {
    const m = /V(\d+)/i.exec(v.version || '');
    if (m) maxN = Math.max(maxN, Number(m[1]));
  });
  const nextVersion = 'V' + (maxN + 1);

  const t = now();
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO tech_packs
       (order_id, product_name, version, fabric_info, accessory_info, craft_info, customer_req,
        fabric_ids, accessory_ids, size_spec, image_url, stage, status, remark, created_by, created_at, updated_at,
        customer_style_no, designer, pattern_maker, pattern_no, category, label_name, series, wave,
        sales_owner, po_no, brand, colors, size_range, delivery_date)
       VALUES (${new Array(31).fill('?').join(',')})`
    ).run(
      row.order_id, row.product_name, nextVersion,
      row.fabric_info, row.accessory_info, row.craft_info, row.customer_req,
      row.fabric_ids, row.accessory_ids, row.size_spec, row.image_url,
      'draft', 'draft',
      row.remark, req.user.sub, t, t,
      row.customer_style_no, row.designer, row.pattern_maker, row.pattern_no, row.category,
      row.label_name, row.series, row.wave, row.sales_owner, row.po_no, row.brand,
      row.colors, row.size_range, row.delivery_date
    );
    const newId = Number(info.lastInsertRowid);

    db.prepare(
      `INSERT INTO tech_pack_materials
       (tech_pack_id, material_id, mat_type, colorway, material_name, color_no, supplier, supplier_info, spec_info,
        composition, unit, one_use, loss_rate, air_gap, unit_price, amount, fabric_param, remark,
        image_url, color_card_url, sort, created_at)
       SELECT ?, material_id, mat_type, colorway, material_name, color_no, supplier, supplier_info, spec_info,
        composition, unit, one_use, loss_rate, air_gap, unit_price, amount, fabric_param, remark,
        image_url, color_card_url, sort, ?
       FROM tech_pack_materials WHERE tech_pack_id = ?`
    ).run(newId, t, row.id);

    db.prepare(
      `INSERT INTO tech_pack_sizes (tech_pack_id, part, size, value, tolerance, sort, created_at)
       SELECT ?, part, size, value, tolerance, sort, ? FROM tech_pack_sizes WHERE tech_pack_id = ?`
    ).run(newId, t, row.id);

    db.prepare(
      `INSERT INTO tech_pack_requirements (tech_pack_id, category, content, sort, created_at)
       SELECT ?, category, content, sort, ? FROM tech_pack_requirements WHERE tech_pack_id = ?`
    ).run(newId, t, row.id);

    db.exec('COMMIT');
    return ok(res, loadFull(newId));
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

router.delete('/:id', authRequired, requireRole(REVIEW), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM tech_packs WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '技术资料不存在');
  if (row.status === 'confirmed') return fail(res, 400, '已确认的开发单不可删除');
  /**
   * 子表必须手工删干净 —— 这个库 360 张表零外键，漏一步只会在库里留孤儿，
   * 不会报错（v1.68.5 之前就漏了 pattern_flows / pattern_stages，
   * 累计 130 条孤儿流程，正是"删父行前先删子行"那条教训）。
   *
   * 顺序：孙子（pattern_stages）→ 子（pattern_flows / 供方协同三张）→ 本体。
   * `sample_archives` / `sample_seals` **不删**：它们是带快照的历史记录，
   * 开发单删了也要能追溯当时封样确认的是什么内容。
   */
  db.exec('BEGIN');
  let flowsDeleted = 0;
  try {
    const flows = db.prepare('SELECT id FROM pattern_flows WHERE tech_pack_id = ?').all(req.params.id);
    flowsDeleted = flows.length;
    flows.forEach((f) => db.prepare('DELETE FROM pattern_stages WHERE flow_id = ?').run(f.id));
    db.prepare('DELETE FROM pattern_flows WHERE tech_pack_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tech_assignments WHERE tech_pack_id = ?').run(req.params.id);
    db.prepare('DELETE FROM supplier_confirms WHERE tech_pack_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tech_reviews WHERE tech_pack_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tech_pack_materials WHERE tech_pack_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tech_pack_sizes WHERE tech_pack_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tech_pack_requirements WHERE tech_pack_id = ?').run(req.params.id);
    db.prepare('DELETE FROM tech_packs WHERE id = ?').run(req.params.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return ok(res, { id: Number(req.params.id), flows_deleted: flowsDeleted });
}));

module.exports = router;
