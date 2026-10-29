/**
 * 工序流程模板 —— 节点可自定义
 * ========================================================================
 * 需求：订单跟踪看板上那一排节点（排版算料、票菲工艺单、领料、裁床、车缝、尾部…）
 * 要能由业务自己增删、改名、调顺序，而不是写死在代码里。
 *
 * 「可自定义」听起来是个配置界面的事，实际不是。真正的问题只有一个：
 *
 *   **系统里有 6 处逻辑靠 `order_nodes.name` 的字符串匹配联动。**
 *
 *     cuts.js            name LIKE '%裁剪%'   裁床单完成 → 标记裁剪节点完成
 *     firstArticles.js   name LIKE '%车缝%'   首件确认 → 回写车缝节点
 *     process_standards / skill_requirements / schedule_tasks / production_reports
 *                        都按 process_name / node_name 对齐
 *
 * 只要业务把「裁剪」改成「裁床」，第一条就**静默失效**：界面没有任何报错，
 * 只是裁床单做完了、节点还停在「待开始」。这种错最难查，因为两边看起来都正常。
 *
 * 所以本模块的第一原则是：
 *
 *   ## 1. code 是身份，name 只是标签
 *
 *   内置节点的 code 写死在 `BUILTIN_CODES`（`cut`/`sew`/…），写在代码里的联动
 *   全部改成按 code 找节点。业务怎么改名都不影响 —— 这不是「尽量兼容」，
 *   而是「改名在结构上就不可能影响联动」，因为联动根本不读 name。
 *
 *   ## 2. code 入库后不可改
 *
 *   改 code 等于让这张单的历史记录与「以后这个节点」失联。想改只能停用旧节点、
 *   新建一个 —— 这样历史还指着旧 code，能对上。
 *
 *   ## 3. 节点停用 ≠ 删除
 *
 *   停用只影响**新订单**（不再带这个节点）。已下单的订单里那条记录原样保留：
 *   它代表「这张单确实走过这一步」，删了之后「这单做过什么」就缺一块。
 *
 *   ## 4. 改模板不影响已下单
 *
 *   模板是「新订单的配方」，不是「在产订单的实时指令」。要让在产订单跟上，
 *   必须显式走 `applyToOrders`，而且**只追加缺失节点，不删不改名**：
 *     删 → 丢掉这张单已经走过的记录；
 *     改名 → 三个月后没人能证明「当时它叫这个名」。
 *
 *   ## 5. 内置节点不能停用，只能改名
 *
 *   `cut` 停了，裁床单完成时找不到该回写哪个节点，联动就断了。
 *   `builtin = 1` 的节点拦住停用，但允许改名和调序。
 */
const { db, now } = require('../db');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};

/**
 * 内置节点：code 与系统逻辑绑定，**不可停用**
 *
 * 这张表是「代码里能按 code 找节点」的唯一依据。新增联动逻辑时，
 * 从 `BUILTIN_CODES` 里挑，不要新造字符串匹配。
 */
const BUILTIN_CODES = {
  prep: '备料',
  layout: '排版算料',
  cut: '裁剪',
  sew: '车缝',
  buttonhole: '锁眼钉扣',
  iron: '整烫',
  wash: '水洗',
  print: '印花',
  embroider: '绣花',
  inspect: '检验',
  pack: '包装',
  instock: '成品入库',
  ship: '出库发运'
};

const BUILTIN_ORDER = Object.keys(BUILTIN_CODES);

/** 默认模板：没有显式指定时用这个 */
function defaultTemplate() {
  const t = db.prepare(
    "SELECT * FROM node_templates WHERE is_default = 1 AND status = 'active' ORDER BY id LIMIT 1"
  ).get();
  if (t) return t;
  // 兜底：任何 active 模板，避免「默认模板被人归档了」导致建单直接 500
  const any = db.prepare("SELECT * FROM node_templates WHERE status = 'active' ORDER BY id LIMIT 1").get();
  if (any) return any;
  throw bad('没有任何可用的工序流程模板，请先在「节点流程」里建一个');
}

function templateItems(templateId, { includeOff = false } = {}) {
  const sql = includeOff
    ? 'SELECT * FROM node_template_items WHERE template_id = ? ORDER BY seq, id'
    : "SELECT * FROM node_template_items WHERE template_id = ? AND status = 'active' ORDER BY seq, id";
  return db.prepare(sql).all(templateId);
}

function listTemplates() {
  const rows = db.prepare('SELECT * FROM node_templates ORDER BY is_default DESC, id').all();
  return rows.map((t) => ({
    ...t,
    item_count: Number(db.prepare("SELECT COUNT(*) c FROM node_template_items WHERE template_id = ? AND status = 'active'").get(t.id).c),
    off_count: Number(db.prepare("SELECT COUNT(*) c FROM node_template_items WHERE template_id = ? AND status = 'off'").get(t.id).c),
    order_count: Number(db.prepare('SELECT COUNT(*) c FROM orders WHERE node_template_id = ?').get(t.id).c)
  }));
}

function getTemplate(id) {
  const t = db.prepare('SELECT * FROM node_templates WHERE id = ?').get(id);
  if (!t) throw bad('流程模板不存在', 404);
  return { ...t, items: templateItems(id, { includeOff: true }) };
}

/** 新建 / 修改模板本体（名称、备注、是否默认） */
function saveTemplate(b) {
  const name = String(b.name || '').trim();
  if (!name) throw bad('流程名称必填');
  if (name.length > 40) throw bad('流程名称最多 40 字');
  const t = now();

  if (b.id) {
    const row = db.prepare('SELECT * FROM node_templates WHERE id = ?').get(b.id);
    if (!row) throw bad('流程模板不存在', 404);
    db.prepare(
      'UPDATE node_templates SET name = ?, note = ?, status = ?, updated_at = ? WHERE id = ?'
    ).run(name, b.note ?? row.note, b.status || row.status, t, b.id);
    if (b.is_default) setDefault(b.id);
    return getTemplate(b.id);
  }

  const info = db.prepare(
    `INSERT INTO node_templates (name, is_default, status, note, created_by, created_at, updated_at)
     VALUES (?, 0, 'active', ?, ?, ?, ?)`
  ).run(name, b.note || null, b.operator || 'system', t, t);
  const id = Number(info.lastInsertRowid);
  if (b.is_default) setDefault(id);
  return getTemplate(id);
}

/**
 * 设默认模板：全局只能一个
 *
 * 先全清再置一 —— 用两条语句而不是「只置一」，因为历史上可能已经存在
 * 两个 is_default=1 的行（手工改库、旧版本 bug），只置一不会修掉这个状态。
 */
function setDefault(id) {
  const row = db.prepare("SELECT status FROM node_templates WHERE id = ?").get(id);
  if (!row) throw bad('流程模板不存在', 404);
  if (row.status !== 'active') throw bad('已归档的流程不能设为默认');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE node_templates SET is_default = 0 WHERE is_default = 1').run();
    db.prepare('UPDATE node_templates SET is_default = 1, updated_at = ? WHERE id = ?').run(now(), id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getTemplate(id);
}

/** 生成一个模板内不重复的自定义 code */
function nextCustomCode(templateId) {
  const rows = db.prepare(
    "SELECT code FROM node_template_items WHERE template_id = ? AND code LIKE 'c\\_%' ESCAPE '\\'"
  ).all(templateId);
  let max = 0;
  rows.forEach((r) => {
    const n = parseInt(String(r.code).slice(2), 10);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return `c_${max + 1}`;
}

/**
 * 新增 / 修改模板里的一个节点
 *
 * 改的时候**忽略 code 与 builtin**：这两个字段决定「历史记录挂不挂得上」，
 * 不能由前端传什么就写什么。
 */
function saveItem(templateId, b) {
  const tpl = db.prepare('SELECT * FROM node_templates WHERE id = ?').get(templateId);
  if (!tpl) throw bad('流程模板不存在', 404);

  const name = String(b.name || '').trim();
  if (!name) throw bad('节点名称必填');
  if (name.length > 20) throw bad('节点名称最多 20 字（看板一列放不下更长的）');

  const t = now();

  if (b.id) {
    const row = db.prepare('SELECT * FROM node_template_items WHERE id = ? AND template_id = ?').get(b.id, templateId);
    if (!row) throw bad('节点不存在', 404);

    // 同模板内不允许重名：看板上两列同名，没人分得清哪个是哪个
    const dup = db.prepare(
      'SELECT id FROM node_template_items WHERE template_id = ? AND name = ? AND id <> ?'
    ).get(templateId, name, b.id);
    if (dup) throw bad(`这个流程里已经有叫「${name}」的节点了`);

    const status = b.status !== undefined ? String(b.status) : row.status;
    if (!['active', 'off'].includes(status)) throw bad('非法状态');
    if (status === 'off' && Number(row.builtin) === 1) {
      throw bad(`「${row.name}」是系统内置节点，不能停用 —— `
        + '裁床单、首件确认等环节要回写到它，停掉之后那些环节做完了节点也不会前进。'
        + '用不到就把它拖到最后、或者改名说明它在你们厂叫什么，但别停用。');
    }

    db.prepare(
      `UPDATE node_template_items
          SET name = ?, seq = ?, required = ?, role = ?, color = ?, status = ?, note = ?, updated_at = ?
        WHERE id = ?`
    ).run(
      name,
      b.seq !== undefined ? Number(b.seq) : row.seq,
      b.required !== undefined ? (b.required ? 1 : 0) : row.required,
      b.role !== undefined ? b.role : row.role,
      b.color !== undefined ? b.color : row.color,
      status,
      b.note !== undefined ? b.note : row.note,
      t,
      b.id
    );
    return db.prepare('SELECT * FROM node_template_items WHERE id = ?').get(b.id);
  }

  const dup = db.prepare('SELECT id FROM node_template_items WHERE template_id = ? AND name = ?').get(templateId, name);
  if (dup) throw bad(`这个流程里已经有叫「${name}」的节点了`);

  const maxSeq = Number(db.prepare('SELECT COALESCE(MAX(seq),0) m FROM node_template_items WHERE template_id = ?').get(templateId).m);
  const code = nextCustomCode(templateId);
  const info = db.prepare(
    `INSERT INTO node_template_items
      (template_id, code, name, seq, required, role, color, builtin, status, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,0,'active',?,?,?)`
  ).run(
    templateId,
    code,
    name,
    b.seq !== undefined ? Number(b.seq) : maxSeq + 1,
    b.required !== undefined ? (b.required ? 1 : 0) : 1,
    b.role || 'production',
    b.color || null,
    b.note || null,
    t,
    t
  );
  return db.prepare('SELECT * FROM node_template_items WHERE id = ?').get(Number(info.lastInsertRowid));
}

/**
 * 停用 / 恢复节点
 *
 * 不是 DELETE：已有订单里的那条记录必须留着（它代表「这单走过这一步」）。
 */
function setItemStatus(id, status) {
  const row = db.prepare('SELECT * FROM node_template_items WHERE id = ?').get(id);
  if (!row) throw bad('节点不存在', 404);
  if (!['active', 'off'].includes(status)) throw bad('非法状态');
  if (status === 'off' && Number(row.builtin) === 1) {
    throw bad(`「${row.name}」是系统内置节点，不能停用（裁床单 / 首件确认要回写到它）`);
  }
  db.prepare('UPDATE node_template_items SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  return db.prepare('SELECT * FROM node_template_items WHERE id = ?').get(id);
}

/**
 * 调整顺序：把整条通道的 seq 重写一遍
 *
 * 不用「交换两条 seq」的做法：历史数据里重复 seq 很常见（手工插入过），
 * 交换会把重复值带着到处跑。整段重写 = 每次都得到 1..n 的干净序列。
 */
function reorder(templateId, orderedIds) {
  const ids = (orderedIds || []).map(Number).filter(Boolean);
  if (!ids.length) throw bad('缺少排序结果');
  const own = new Set(
    db.prepare('SELECT id FROM node_template_items WHERE template_id = ?').all(templateId).map((r) => Number(r.id))
  );
  ids.forEach((id) => { if (!own.has(id)) throw bad('排序里有不属于这个流程的节点'); });

  const t = now();
  db.exec('BEGIN');
  try {
    const upd = db.prepare('UPDATE node_template_items SET seq = ?, updated_at = ? WHERE id = ?');
    ids.forEach((id, i) => upd.run(i + 1, t, id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return templateItems(templateId, { includeOff: true });
}

/**
 * 按模板给一张订单铺节点
 *
 * 三种情况要分清：
 *   1. 订单完全没有节点 → 按模板全量生成（原来 `ensureNodes` 的行为）
 *   2. 订单有节点但缺模板里新增的 code → **不自动补**（避免每次转状态都悄悄加节点，
 *      业务会不知道自己的单被改了）。补由 `applyToOrders` 显式执行。
 *   3. 订单有节点、模板后来停用了某节点 → 已生成的保留
 *
 * 所以这里只有第 1 种会写库。
 */
function ensureNodes(orderId) {
  const has = db.prepare('SELECT COUNT(*) c FROM order_nodes WHERE order_id = ?').get(orderId).c;
  if (Number(has) > 0) return false;

  const order = db.prepare('SELECT id, node_template_id FROM orders WHERE id = ?').get(orderId);
  if (!order) throw bad('订单不存在', 404);

  let tplId = order.node_template_id;
  let tpl = tplId ? db.prepare("SELECT * FROM node_templates WHERE id = ? AND status = 'active'").get(tplId) : null;
  if (!tpl) tpl = defaultTemplate();

  const items = templateItems(tpl.id);
  if (!items.length) throw bad(`流程「${tpl.name}」里还没有节点，请先在「节点流程」里配置`);

  const t = now();
  db.exec('BEGIN');
  try {
    const ins = db.prepare(
      'INSERT INTO order_nodes (order_id, name, code, template_id, is_custom, seq, status, created_at) VALUES (?,?,?,?,0,?,?,?)'
    );
    items.forEach((it) => ins.run(orderId, it.name, it.code, tpl.id, it.seq, 'pending', t));
    db.prepare('UPDATE orders SET node_template_id = ? WHERE id = ?').run(tpl.id, orderId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return true;
}

/** 按 code 找一张订单的节点（替代所有 `name LIKE '%xx%'`） */
function findByCode(orderId, code) {
  return db.prepare('SELECT * FROM order_nodes WHERE order_id = ? AND code = ? ORDER BY id LIMIT 1').get(orderId, code);
}

/**
 * 把模板的**新增节点**补到已有订单上
 *
 * 只追加、不删、不改名：
 *   删 → 丢掉「这张单走过这一步」的记录
 *   改名 → 三个月后没人能证明当时的节点叫什么
 *
 * ## 默认只补「在产」的单
 *
 * 迁移时把所有存量订单都挂到了默认模板，所以 `WHERE node_template_id = ?`
 * 会把已结案、已取消、草稿的单也捞出来。给一张已结案的单补 13 个「待开始」节点，
 * 结果是那张单在看板上从「已结案」变成「一步未动」—— **补数据反而把历史搞脏了**。
 *
 * 所以默认只作用于 assigned / production / instock（真正在跟的单）。
 * 要连带其他状态，显式传 `include_status`，并在返回值里说清跳过了多少张。
 *
 * 返回逐单会补哪些节点；`dryRun` 只算不写（默认就该先看影响面再按确认）。
 */
function applyToOrders(templateId, { orderIds = null, dryRun = true, includeStatus = null } = {}) {
  const tpl = db.prepare('SELECT * FROM node_templates WHERE id = ?').get(templateId);
  if (!tpl) throw bad('流程模板不存在', 404);

  const items = templateItems(templateId);
  const LIVE = ['assigned', 'production', 'instock'];
  const statuses = Array.isArray(includeStatus) && includeStatus.length ? includeStatus : LIVE;

  let orders;
  if (Array.isArray(orderIds) && orderIds.length) {
    const ph = orderIds.map(() => '?').join(',');
    orders = db.prepare(`SELECT id, order_no, status, node_template_id FROM orders WHERE id IN (${ph})`).all(...orderIds.map(Number));
  } else {
    const ph = statuses.map(() => '?').join(',');
    orders = db.prepare(
      `SELECT id, order_no, status, node_template_id FROM orders WHERE node_template_id = ? AND status IN (${ph}) ORDER BY id`
    ).all(templateId, ...statuses);
  }

  // 被状态过滤挡掉的张数：要让业务看见「为什么只列了这些」，否则会以为漏了单
  const skippedByStatus = Array.isArray(orderIds) && orderIds.length
    ? 0
    : Number(db.prepare(
      `SELECT COUNT(*) c FROM orders WHERE node_template_id = ?
        AND status NOT IN (${statuses.map(() => '?').join(',')})`
    ).get(templateId, ...statuses).c);

  const plan = [];
  orders.forEach((o) => {
    const have = new Set(db.prepare('SELECT code FROM order_nodes WHERE order_id = ?').all(o.id).map((r) => r.code));
    const missing = items.filter((it) => !have.has(it.code));
    if (missing.length) {
      plan.push({
        order_id: o.id,
        order_no: o.order_no,
        status: o.status,
        add: missing.map((m) => ({ code: m.code, name: m.name }))
      });
    }
  });

  const totalRows = plan.reduce((a, x) => a + x.add.length, 0);
  if (dryRun) {
    return { template: { id: tpl.id, name: tpl.name }, dry_run: true, scope: statuses, skipped_by_status: skippedByStatus, orders: plan, total_orders: plan.length, total_rows: totalRows };
  }

  const t = now();
  db.exec('BEGIN');
  try {
    const ins = db.prepare(
      'INSERT INTO order_nodes (order_id, name, code, template_id, is_custom, seq, status, created_at) VALUES (?,?,?,?,0,?,?,?)'
    );
    plan.forEach((p) => {
      p.add.forEach((a) => {
        const it = items.find((x) => x.code === a.code);
        ins.run(p.order_id, it.name, it.code, templateId, it.seq, 'pending', t);
      });
      // 订单原来没挂模板的，顺手挂上：否则下次 ensureNodes 还会走默认模板
      db.prepare('UPDATE orders SET node_template_id = COALESCE(node_template_id, ?) WHERE id = ?').run(templateId, p.order_id);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { template: { id: tpl.id, name: tpl.name }, dry_run: false, scope: statuses, skipped_by_status: skippedByStatus, orders: plan, total_orders: plan.length, total_rows: totalRows };
}

/**
 * 订单跟踪看板
 *
 * 列 = 模板的节点（按 seq）。行 = 用这个模板的订单。
 *
 * ## 默认只看「在产」的订单
 *
 * 草稿、技术、财务审核阶段的单还没进生产，工序节点也还没生成（`ensureNodes` 在
 * 转「生产中」时才铺）。把它们也列出来，看板上就是一片空格子 ——
 * 而空格子在跟踪看板上是最危险的信号（分不清「没排产」还是「排产了但没记录」）。
 *
 * 所以默认只取 assigned / production / instock：这三类才有「在跟」的意义。
 * 想看别的状态，显式传 status。
 *
 * ## 为什么一个看板只看一个模板
 *
 * 不同流程的节点对不上。混排只有两种结果：列取并集（每张单挂着一堆用不到的空格子），
 * 或者各有各的列（那就不叫看板了）。
 */
function board({ templateId = null, status = '', q = '', limit = 200 } = {}) {
  const tpl = templateId
    ? db.prepare('SELECT * FROM node_templates WHERE id = ?').get(templateId)
    : defaultTemplate();
  if (!tpl) throw bad('流程模板不存在', 404);

  const where = ['o.node_template_id = ?'];
  const args = [tpl.id];
  if (status) {
    where.push('o.status = ?');
    args.push(status);
  } else {
    where.push("o.status IN ('assigned','production','instock')");
  }
  if (q) { where.push('(o.order_no LIKE ? OR o.style_name LIKE ? OR o.cus_order_no LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const orders = db.prepare(`
    SELECT o.id, o.order_no, o.status, o.type, o.style_name, o.cus_order_no,
           o.order_date, o.delivery_date, o.total_usd, o.image_url,
           /* 款图两处可放：订单自己的 image_url，或打版（技术资料）里的图。
              大多数单实际上只填了打版那张 —— 所以不能只看订单表，否则看板上
              十张有九张是空白占位。取最新一版有图的。 */
           (SELECT tp.image_url FROM tech_packs tp
             WHERE tp.order_id = o.id AND IFNULL(tp.image_url, '') <> ''
             ORDER BY tp.id DESC LIMIT 1) AS tech_image_url,
           c.name AS customer_name
      FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY o.delivery_date IS NULL, o.delivery_date, o.id DESC
     LIMIT ?`).all(...args, Number(limit) || 200);

  const columns = templateItems(tpl.id).map((it) => ({
    id: it.id, code: it.code, name: it.name, seq: it.seq,
    required: it.required, role: it.role, color: it.color, builtin: it.builtin
  }));

  const rows = orders.map((o) => {
    const nodes = db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(o.id);
    const byCode = new Map(nodes.map((n) => [n.code, n]));
    const cells = columns.map((c) => {
      const n = byCode.get(c.code);
      return n
        ? { node_id: n.id, code: c.code, name: n.name, status: n.status, actual_date: n.actual_date, plan_date: n.plan_date, operator: n.operator, skip_reason: n.skip_reason, missing: false }
        : { node_id: null, code: c.code, name: c.name, status: 'none', missing: true };
    });
    // 模板之外的节点（单据级自定义，或模板后来删掉的）：追加在列尾，不能让它从看板上消失
    const extra = nodes
      .filter((n) => !columns.some((c) => c.code === n.code))
      .map((n) => ({ node_id: n.id, code: n.code, name: n.name, status: n.status, actual_date: n.actual_date, plan_date: n.plan_date, operator: n.operator, skip_reason: n.skip_reason, missing: false, extra: true }));

    const done = cells.filter((c) => c.status === 'done').length;
    const skipped = cells.filter((c) => c.status === 'skipped').length;
    const total = cells.filter((c) => c.status !== 'none').length;
    const cur = cells.find((c) => c.status === 'doing')
      || cells.find((c) => c.status === 'pending')
      || null;

    return {
      ...o,
      cells,
      extra,
      /** 看板缩略图：订单图优先，没有再取打版图；都没有就是空（前端出占位） */
      thumb: o.image_url || o.tech_image_url || '',
      /** 这张单还没生成过工序（没走过「转生产中」）：看板要提示，不能显示成「全都没开始」 */
      no_nodes: nodes.length === 0,
      done_count: done,
      total_count: total,
      skipped_count: skipped,
      progress: total ? Math.round((done / total) * 100) : 0,
      current: cur ? cur.name : null,
      current_code: cur ? cur.code : null
    };
  });

  return {
    template: { id: tpl.id, name: tpl.name, is_default: tpl.is_default },
    columns,
    rows,
    summary: {
      orders: rows.length,
      avg_progress: rows.length ? Math.round(rows.reduce((a, r) => a + r.progress, 0) / rows.length) : 0,
      not_started: rows.filter((r) => r.done_count === 0).length,
      finished: rows.filter((r) => r.total_count > 0 && r.done_count + r.skipped_count >= r.total_count).length
    }
  };
}

/**
 * 推进一个节点
 *
 * 允许 skipped（不适用）：定制单没有「水洗」、外协单没有「尾部」，逼着人点「完成」
 * 等于教人作假。但**必经节点不能跳过** —— 跳过 must 写理由（`skip_reason`）。
 */
function setNode(nodeId, b) {
  const row = db.prepare('SELECT * FROM order_nodes WHERE id = ?').get(nodeId);
  if (!row) throw bad('工序不存在', 404);

  const STATUS = ['pending', 'doing', 'done', 'skipped'];
  const status = b.status !== undefined ? String(b.status) : row.status;
  if (!STATUS.includes(status)) throw bad('非法状态');

  if (status === 'skipped') {
    const item = db.prepare('SELECT required FROM node_template_items WHERE template_id = ? AND code = ?')
      .get(row.template_id, row.code);
    const reason = String(b.skip_reason || '').trim();
    if (!reason) throw bad(`标记「${row.name}」不适用要写原因（这单为什么不做这一步）`);
    if (item && Number(item.required) === 1) {
      throw bad(`「${row.name}」是必经环节，不能标不适用。真的不做请改流程模板，把它的「必经」去掉`);
    }
  }

  const t = now();
  let actual = b.actual_date !== undefined ? b.actual_date : row.actual_date;
  if (status === 'done' && !actual) actual = new Date().toISOString().slice(0, 10);
  if (status !== 'done') actual = b.actual_date !== undefined ? b.actual_date : null;

  db.prepare(
    'UPDATE order_nodes SET status = ?, plan_date = ?, actual_date = ?, operator = ?, remark = ?, skip_reason = ? WHERE id = ?'
  ).run(
    status,
    b.plan_date !== undefined ? b.plan_date : row.plan_date,
    actual,
    b.operator !== undefined ? b.operator : row.operator,
    b.remark !== undefined ? b.remark : row.remark,
    status === 'skipped' ? String(b.skip_reason || '').trim() : null,
    nodeId
  );
  void t;
  return db.prepare('SELECT * FROM order_nodes WHERE id = ?').get(nodeId);
}

module.exports = {
  BUILTIN_CODES,
  BUILTIN_ORDER,
  defaultTemplate,
  listTemplates,
  getTemplate,
  saveTemplate,
  setDefault,
  saveItem,
  setItemStatus,
  reorder,
  ensureNodes,
  findByCode,
  applyToOrders,
  board,
  setNode
};
