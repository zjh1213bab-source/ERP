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
const { localDate } = require('../utils/time');

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

/** 状态中文：日志里写「待开始 → 已完成」，而不是 pending → done */
const STATUS_LABEL = { pending: '待开始', doing: '进行中', done: '已完成', skipped: '不适用' };

/**
 * 写一条节点操作记录
 *
 * 单独抽出来是为了「一处实现」：setNode（人工点）、markDoneByCode（单据反推）
 * 两条路径都要记，各写一遍必然有一条漏记，于是正好在没人注意的那条漏。
 */
function logNode(nodeId, orderId, action, detail, operator) {
  db.prepare(
    'INSERT INTO order_node_logs (node_id, order_id, action, detail, operator, created_at) VALUES (?,?,?,?,?,?)'
  ).run(nodeId, orderId, action, detail || null, operator || null, now());
}

/**
 * 有代码逻辑挂在上面的内置节点 —— 只有这几个不能停用
 *
 * `cut`：裁床单完成时回写
 * `sew`：首件放行/退回时回写
 * `inspect` / `pack`：成品入库的两道闸门（`orderFlow.checkProductionReadyForStock`）
 *
 * 其余内置节点（备料、锁眼钉扣、水洗、印花、绣花…）只是**默认模板里预置的名字**，
 * 没有任何代码依赖。早先一律不许停用，结果是想按自己的工序精简流程时被卡住 ——
 * 业务不用这道工序，模板里就该能拿掉。
 */
const LOCKED_CODES = ['cut', 'sew', 'inspect', 'pack'];

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
    /** 其中占看板列的（visible=1）—— 列表上直接看出「15 个节点里 13 列」 */
    visible_count: Number(db.prepare("SELECT COUNT(*) c FROM node_template_items WHERE template_id = ? AND status = 'active' AND visible = 1").get(t.id).c),
    off_count: Number(db.prepare("SELECT COUNT(*) c FROM node_template_items WHERE template_id = ? AND status = 'off'").get(t.id).c),
    order_count: Number(db.prepare('SELECT COUNT(*) c FROM orders WHERE node_template_id = ?').get(t.id).c)
  }));
}

function getTemplate(id) {
  const t = db.prepare('SELECT * FROM node_templates WHERE id = ?').get(id);
  if (!t) throw bad('流程模板不存在', 404);
  /**
   * 每个节点带上 `locked`：**锁定清单只在后端定义一次**。
   *
   * 前端原来按 `builtin` 判断「不许停用」，而后端已收窄到 4 个 code，
   * 两边标准不一致的结果是：接口允许停用某节点，界面上按钮却是灰的，
   * 业务只会认为「这系统不让改」。
   */
  return {
    ...t,
    items: templateItems(id, { includeOff: true }).map((it) => ({
      ...it,
      locked: LOCKED_CODES.includes(it.code)
    }))
  };
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
  // 面板类型清单只有一份（utils/nodePanels）：改/新建两个分支都要用，放在函数作用域
  const { PANELS, PANEL_LABEL } = require('../utils/nodePanels');

  /**
   * 名称**只在传了的时候才校验**。
   *
   * 这是个部分更新接口：界面上的「必经/可选」「看板/仅扫码」都只传一个字段。
   * 原来一进门就 `name = String(b.name || '')`，于是那两个开关一点就报
   * 「节点名称必填」—— 配置页看着有两个可点的开关，实际都点不动。
   * 必填只在**新建**时要求。
   */
  const hasName = b.name !== undefined && String(b.name).trim() !== '';
  if (hasName && String(b.name).trim().length > 20) {
    throw bad('节点名称最多 20 字（看板一列放不下更长的）');
  }

  const t = now();

  if (b.id) {
    const row = db.prepare('SELECT * FROM node_template_items WHERE id = ? AND template_id = ?').get(b.id, templateId);
    if (!row) throw bad('节点不存在（或不属于这个流程）', 404);

    const name = hasName ? String(b.name).trim() : row.name;

    // 同模板内不允许重名：看板上两列同名，没人分得清哪个是哪个
    const dup = db.prepare(
      'SELECT id FROM node_template_items WHERE template_id = ? AND name = ? AND id <> ?'
    ).get(templateId, name, b.id);
    if (dup) throw bad(`这个流程里已经有叫「${name}」的节点了`);

    const status = b.status !== undefined ? String(b.status) : row.status;
    if (!['active', 'off'].includes(status)) throw bad('非法状态');
    if (status === 'off' && LOCKED_CODES.includes(row.code)) {
      throw bad(`「${row.name}」不能停用 —— 裁床单完成、首件确认、成品入库校验都要回写到它，`
        + '停掉之后那些环节做完了节点也不会前进（而且入库闸门会一直卡住）。'
        + '用不到就改名说明它在你们厂叫什么。');
    }

    /**
     * `visible`：这道工序要不要占看板一列。
     *
     * 0 = 仅扫码（检验、包装这类现场扫一下就走完的工序）。
     * **隐藏不等于不做**：节点照常生成、照常参与进度、入库闸门照常校验它，
     * 只是不占列 —— 15 个节点全摆出来，13 列的看板就得横向滚。
     */
    const visible = b.visible !== undefined ? (b.visible ? 1 : 0) : Number(row.visible);

    // 全流程不能一个可见节点都不剩 —— 那看板就成了一张空表，
    // 而「保存成功」会让人以为配好了。要精简到这一步，说明流程本身该重建。
    if (visible === 0 && Number(row.visible) !== 0) {
      const still = Number(db.prepare(
        "SELECT COUNT(*) c FROM node_template_items WHERE template_id = ? AND status = 'active' AND visible = 1 AND id <> ?"
      ).get(templateId, b.id).c);
      if (!still) throw bad('这是流程里最后一个看板列，不能隐藏 —— 全隐藏后看板会是空表。要精简请改流程本身。');
    }

    /**
     * `panel`：这点开的弹窗用哪种面板。
     *
     * 采购类节点背后有一张物料需求表可以摊开，其他节点只有备注和凭证。
     * 做成属性而不是按 code 判断，因为「面料采购」在真实数据里往往是业务
     * 自己加的自定义节点（code 是 c_new_2 这种自动编号）。
     */
    const panel = b.panel !== undefined ? String(b.panel) : String(row.panel || 'generic');
    if (!PANELS.includes(panel)) throw bad('弹窗类型只能是：' + PANELS.map((k) => PANEL_LABEL[k]).join(' / '));

    db.prepare(
      `UPDATE node_template_items
          SET name = ?, seq = ?, required = ?, role = ?, color = ?, status = ?, note = ?,
              visible = ?, panel = ?, updated_at = ?
        WHERE id = ?`
    ).run(
      name,
      b.seq !== undefined ? Number(b.seq) : row.seq,
      b.required !== undefined ? (b.required ? 1 : 0) : row.required,
      b.role !== undefined ? b.role : row.role,
      b.color !== undefined ? b.color : row.color,
      status,
      b.note !== undefined ? b.note : row.note,
      visible,
      panel,
      t,
      b.id
    );
    return db.prepare('SELECT * FROM node_template_items WHERE id = ?').get(b.id);
  }

  /* 新建：名称必填 */
  const name = String(b.name || '').trim();
  if (!name) throw bad('节点名称必填');

  const dup = db.prepare('SELECT id FROM node_template_items WHERE template_id = ? AND name = ?').get(templateId, name);
  if (dup) throw bad(`这个流程里已经有叫「${name}」的节点了`);

  const maxSeq = Number(db.prepare('SELECT COALESCE(MAX(seq),0) m FROM node_template_items WHERE template_id = ?').get(templateId).m);
  const code = nextCustomCode(templateId);
  const info = db.prepare(
    `INSERT INTO node_template_items
      (template_id, code, name, seq, required, role, color, builtin, status, note, visible, panel, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,0,'active',?,?,?,?,?)`
  ).run(
    templateId,
    code,
    name,
    b.seq !== undefined ? Number(b.seq) : maxSeq + 1,
    b.required !== undefined ? (b.required ? 1 : 0) : 1,
    b.role || 'production',
    b.color || null,
    b.note || null,
    // 新建的默认占列；要「仅扫码」显式传 visible:0
    b.visible !== undefined ? (b.visible ? 1 : 0) : 1,
    PANELS.includes(String(b.panel))
      ? String(b.panel) : 'generic',
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
  if (status === 'off' && LOCKED_CODES.includes(row.code)) {
    throw bad(`「${row.name}」不能停用（裁床单 / 首件确认 / 入库校验要回写到它）`);
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
 * 把某一步直接标成完成 —— 给「单据动作反推工序」用的（入库、发货）
 *
 * 入库办完、货发出去之后，那一步其实已经发生了，不该还要人回看板点一下。
 * 但这件事**必须按 code 认**：按名字认的话，业务一改名就静默失效，
 * 而且失效是按订单分批的（老单节点名还是旧的），一半生效一半不生效。
 *
 * 已经完成的不覆盖：`actual_date` 与 `operator` 记的是**第一次做完**的时间和人，
 * 补一次发货不该把它改成今天。
 *
 * 找不到节点时返回 false 而不抛错：调用它的地方库存流水已经写进事务了，
 * 为一个节点记录把整笔入库回滚是本末倒置。但会在服务端日志里留一行 —— 不静默。
 */
function markDoneByCode(orderId, code, { date = null, operator = null } = {}) {
  const node = findByCode(orderId, code);
  if (!node) {
    console.warn(`[nodeFlow] 订单 ${orderId} 没有 code=${code} 的节点，无法回写完成状态`);
    return false;
  }
  if (node.status === 'done') return false;
  db.prepare(
    "UPDATE order_nodes SET status = 'done', actual_date = COALESCE(?, actual_date), operator = COALESCE(?, operator) WHERE id = ?"
  ).run(date || localDate(new Date().toISOString()), operator, node.id);
  // 单据动作也要留痕：否则看板上这一步「自己变绿了」，没人知道是谁触发的
  logNode(node.id, node.order_id, 'status',
    `${STATUS_LABEL[node.status] || node.status} → 已完成（单据动作自动回写）`, operator);
  return true;
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
function board({
  templateId = null, status = '', q = '', limit = 200,
  customerId = null, manager = '', dueFrom = '', dueTo = '', orderFrom = '', orderTo = '',
  overdue = false, noDue = false, dueSoon = false,
  nodeCode = '', nodeStatus = '', sort = 'due',
  companyId = null
} = {}) {
  const tpl = templateId
    ? db.prepare('SELECT * FROM node_templates WHERE id = ?').get(templateId)
    : defaultTemplate();
  if (!tpl) throw bad('流程模板不存在', 404);

  const TODAY = localDate(new Date().toISOString());

  /**
   * 「超期」只有这一个定义，后端算、前端用。
   *
   * 三个条件缺一不可：
   *   1. 填了交期（没填交期的单**不是超期**，是「资料不全」，另算一项）
   *   2. 交期已过（按日期比，不比时间 —— 交期是「这一天之内」，当天不算超期）
   *   3. 还没走完（已发货/已结案/已取消不算 —— 已经交付了就不叫超期）
   *
   * 前端自己再算一遍必然和筛选结果对不上：数字显示 3、点进去 2 条，
   * 那种不一致没人会去查原因，只会不信这个数。
   */
  // 日期直接内联成字面量而不是绑参数：TODAY 由 localDate() 生成、格式固定 YYYY-MM-DD，
  // 没有注入面；而 OVERDUE 这段要在 SELECT 和 WHERE 里各用一次，
  // 用占位符就得数「第几个 ? 是它」，一改筛选条件就错位（第一版就是这么崩的）。
  const OVERDUE = `(IFNULL(o.delivery_date,'') <> '' AND date(o.delivery_date) < date('${TODAY}')`
    + " AND o.status NOT IN ('shipped','closed','cancelled'))";

  /* ---------- 1. 统计：只受模板与状态范围影响，不受其他筛选项影响 ----------
     否则点「超期 3」之后数字变 1，人以为筛错了。 */
  const baseWhere = ['o.node_template_id = ?'];
  const baseArgs = [tpl.id];
  /**
   * 主体条件放这里，而不是只加在明细查询上：baseWhere 同时给「上面的统计卡片」
   * 和「下面的明细列表」用。只改一处 → 卡片显示 12 张、点进去 3 条，
   * 这种不一致没人会去查原因，只会不信这个数。
   */
  if (companyId) { baseWhere.push('o.company_id = ?'); baseArgs.push(Number(companyId)); }
  if (status) { baseWhere.push('o.status = ?'); baseArgs.push(status); }
  else baseWhere.push("o.status IN ('assigned','production','instock')");

  const st = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN ${OVERDUE} THEN 1 ELSE 0 END) overdue,
           SUM(CASE WHEN IFNULL(o.delivery_date,'') = '' THEN 1 ELSE 0 END) no_due,
           SUM(CASE WHEN IFNULL(o.delivery_date,'') <> '' AND date(o.delivery_date) >= date('${TODAY}')
                     AND date(o.delivery_date) <= date('${TODAY}', '+7 day')
                     AND o.status NOT IN ('shipped','closed','cancelled')
                    THEN 1 ELSE 0 END) due_soon
      FROM orders o WHERE ${baseWhere.join(' AND ')}`).get(...baseArgs);

  const stats = {
    total: Number(st.total) || 0,
    overdue: Number(st.overdue) || 0,
    no_due: Number(st.no_due) || 0,
    due_soon: Number(st.due_soon) || 0
  };

  /* ---------- 2. 明细：叠加用户选的筛选 ---------- */
  const where = [...baseWhere];
  const args = [...baseArgs];
  if (q) {
    // 注意引号：SQL 里只能用单引号。写成 IFNULL(c.name,"") 时 SQLite 把 "" 当列名，
    // 报 `no such column: ""` —— 于是**搜索框一输入就 500**，而页面上只是列表没变化。
    where.push("(o.order_no LIKE ? OR o.style_name LIKE ? OR o.cus_order_no LIKE ? OR IFNULL(c.name,'') LIKE ?)");
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (customerId) { where.push('o.customer_id = ?'); args.push(Number(customerId)); }
  if (manager) { where.push('o.manager LIKE ?'); args.push(`%${manager}%`); }
  // 下单时间区间：和货期区间分开两个筛选（车间关心货期，业务关心下单日）
  if (orderFrom) { where.push("IFNULL(o.order_date,'') <> '' AND date(o.order_date) >= date(?)"); args.push(orderFrom); }
  if (orderTo) { where.push("IFNULL(o.order_date,'') <> '' AND date(o.order_date) <= date(?)"); args.push(orderTo); }
  if (dueFrom) { where.push("IFNULL(o.delivery_date,'') <> '' AND date(o.delivery_date) >= date(?)"); args.push(dueFrom); }
  if (dueTo) { where.push("IFNULL(o.delivery_date,'') <> '' AND date(o.delivery_date) <= date(?)"); args.push(dueTo); }
  if (noDue) where.push("IFNULL(o.delivery_date,'') = ''");
  if (overdue) where.push(OVERDUE);
  // 7 天内到期：与 stats.due_soon 同一段条件，点了卡片数字与列表条数才对得上
  if (dueSoon) {
    where.push(`(IFNULL(o.delivery_date,'') <> '' AND date(o.delivery_date) >= date('${TODAY}')
      AND date(o.delivery_date) <= date('${TODAY}', '+7 day')
      AND o.status NOT IN ('shipped','closed','cancelled'))`);
  }
  // 按节点筛：「这个工序还没做的单」是车间最常问的一句
  if (nodeCode) {
    if (nodeStatus) {
      where.push('EXISTS (SELECT 1 FROM order_nodes n WHERE n.order_id = o.id AND n.code = ? AND n.status = ?)');
      args.push(nodeCode, nodeStatus);
    } else {
      where.push('EXISTS (SELECT 1 FROM order_nodes n WHERE n.order_id = o.id AND n.code = ?)');
      args.push(nodeCode);
    }
  }

  const ORDER = {
    due: 'o.delivery_date IS NULL, o.delivery_date, o.id DESC',
    order: 'o.order_date IS NULL, o.order_date DESC, o.id DESC',
    no_due: "IFNULL(o.delivery_date,'') <> '', o.delivery_date, o.id DESC"
  }[sort] || 'o.delivery_date IS NULL, o.delivery_date, o.id DESC';

  const orders = db.prepare(`
    SELECT o.id, o.order_no, o.status, o.type, o.style_name, o.cus_order_no,
           o.order_date, o.delivery_date, o.total_usd, o.image_url, o.manager, o.customer_id,
           /* 款图两处可放：订单自己的 image_url，或打版（技术资料）里的图。
              大多数单实际上只填了打版那张 —— 所以不能只看订单表，否则看板上
              十张有九张是空白占位。取最新一版有图的。 */
           (SELECT tp.image_url FROM tech_packs tp
             WHERE tp.order_id = o.id AND IFNULL(tp.image_url, '') <> ''
             ORDER BY tp.id DESC LIMIT 1) AS tech_image_url,
           ${OVERDUE} AS is_overdue,
           /* 分配情况直接从分单表反算：看板页签（本厂 / 整单外发 / 裁片外发）
              和弹窗里的"还剩多少没分配"必须是同一个数。
              「未指定」的分单不算分配 —— 那是没选厂留下的脏数据。 */
           (SELECT COALESCE(SUM(d.qty),0) FROM dispatch_orders d
             WHERE d.order_id = o.id AND IFNULL(d.status,'') != 'cancelled' AND d.type = 'own'
               AND ((d.factory_id IS NOT NULL AND d.factory_id > 0)
                    OR TRIM(IFNULL(d.factory_name,'')) NOT IN ('','未指定'))) AS alloc_own,
           (SELECT COALESCE(SUM(d.qty),0) FROM dispatch_orders d
             WHERE d.order_id = o.id AND IFNULL(d.status,'') != 'cancelled' AND d.type = 'outsource'
               AND ((d.factory_id IS NOT NULL AND d.factory_id > 0)
                    OR TRIM(IFNULL(d.factory_name,'')) NOT IN ('','未指定'))) AS alloc_out,
           (SELECT COUNT(*) FROM cut_dispatches c
             WHERE c.order_id = o.id AND IFNULL(c.status,'') != 'cancelled') AS cut_cnt,
           (SELECT GROUP_CONCAT(DISTINCT d.factory_name) FROM dispatch_orders d
             WHERE d.order_id = o.id AND IFNULL(d.status,'') != 'cancelled'
               AND ((d.factory_id IS NOT NULL AND d.factory_id > 0)
                    OR TRIM(IFNULL(d.factory_name,'')) NOT IN ('','未指定'))) AS assign_names,
           CASE WHEN IFNULL(o.delivery_date,'') = '' THEN NULL
                ELSE CAST(julianday(date('${TODAY}')) - julianday(date(o.delivery_date)) AS INTEGER) END AS days_late,
           c.name AS customer_name
      FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${ORDER}
     LIMIT ?`).all(...args, Number(limit) || 200);

  /**
   * 看板列 = 模板里 `visible=1` 的节点。
   *
   * 「检验」「包装」这类工序的现场动作是车间扫码，不是跟单在电脑上点，
   * 摆在列里只会把 13 列撑成 15 列、还要横向滚。所以它们 visible=0：
   * 列不显示，但 order_nodes 里那条记录照常生成（扫码、报工、入库闸门都靠它）。
   *
   * 注意：**不能把它们的记录也删掉**，否则成品入库的两道闸门（按 code 找
   * inspect / pack）永远拦着，而界面上还找不到那个节点。
   */
  const items = templateItems(tpl.id);
  const columns = items.filter((it) => Number(it.visible) !== 0).map((it) => ({
    id: it.id, code: it.code, name: it.name, seq: it.seq,
    required: it.required, role: it.role, color: it.color, builtin: it.builtin
  }));
  /** 仅扫码的节点：不出列，但进度要算它们（否则 13 列全 ✓ 显示 100% 却入不了库） */
  const scanItems = items.filter((it) => Number(it.visible) === 0);
  const scanCodes = new Set(scanItems.map((it) => it.code));

  const rows = orders.map((o) => {
    const nodes = db.prepare('SELECT * FROM order_nodes WHERE order_id = ? ORDER BY seq, id').all(o.id);
    const byCode = new Map(nodes.map((n) => [n.code, n]));
    /**
     * 格子名用**模板当前名**，不用 order_nodes 里的快照名。
     *
     * order_nodes.name 是下单那一刻抄下来的，业务把「成品入库」改成「入库」之后，
     * 老单的快照名还是旧值 —— 于是同一列出现「表头写入库、格子里写成品入库」。
     * 列头本来就来自模板，格子必须跟列头一致。
     * 历史名字仍留在 order_nodes 里（订单详情能查），这里只是显示层取当前名。
     */
    const cells = columns.map((c) => {
      const n = byCode.get(c.code);
      return n
        ? { node_id: n.id, code: c.code, name: c.name, status: n.status, actual_date: n.actual_date, plan_date: n.plan_date, operator: n.operator, skip_reason: n.skip_reason, missing: false }
        : { node_id: null, code: c.code, name: c.name, status: 'none', missing: true };
    });
    /**
     * 模板之外的节点：**只取单据级单独加的**（is_custom=1）
     *
     * 模板里停用掉的节点不算 —— 业务停用它就是「我们厂不做这道工序」，
     * 每行尾巴还挂着 6 个灰格子只会让人以为流程没配好。
     * 历史记录仍在 order_nodes 里，订单详情能查。
     */
    const extra = nodes
      .filter((n) => Number(n.is_custom) === 1
        && !columns.some((c) => c.code === n.code)
        && !scanCodes.has(n.code))
      .map((n) => ({ node_id: n.id, code: n.code, name: n.name, status: n.status, actual_date: n.actual_date, plan_date: n.plan_date, operator: n.operator, skip_reason: n.skip_reason, missing: false, extra: true }));

    /* 仅扫码的节点：不进列，但要进进度。 */
    const scanCells = scanItems
      .map((it) => {
        const n = byCode.get(it.code);
        return n ? { node_id: n.id, code: it.code, name: it.name, status: n.status } : null;
      })
      .filter(Boolean);
    /** 还没扫码完成的步骤 —— 进度不是 100% 时，这行字说明差在哪 */
    const scanPending = scanCells.filter((c) => c.status !== 'done' && c.status !== 'skipped');

    const allCells = cells.concat(scanCells);
    const done = allCells.filter((c) => c.status === 'done').length;
    const skipped = allCells.filter((c) => c.status === 'skipped').length;
    const total = allCells.filter((c) => c.status !== 'none').length;
    /** 当前环节取可见列：看板上没有「检验」这一列，却把光标指到它，人会找不到在哪 */
    const cur = cells.find((c) => c.status === 'doing')
      || cells.find((c) => c.status === 'pending')
      || null;

    return {
      ...o,
      cells,
      extra,
      /**
       * 分配情况（本厂 / 外协各分了多少件 + 有没有裁片外发）
       *
       * `assign_mode` 是给看板页签用的标签：既分本厂又分外协时是 `mixed`，
       * 不能硬归到哪一边 —— 拆单在这行当里太常见了。
       */
      alloc_own: Number(o.alloc_own) || 0,
      alloc_out: Number(o.alloc_out) || 0,
      cut_dispatches: Number(o.cut_cnt) || 0,
      assign_names: o.assign_names || '',
      assign_mode: (() => {
        const own = Number(o.alloc_own) || 0;
        const out = Number(o.alloc_out) || 0;
        if (own <= 0 && out <= 0) return 'none';
        if (own > 0 && out > 0) return 'mixed';
        return out > 0 ? 'outsource' : 'own';
      })(),
      /** 看板缩略图：订单图优先，没有再取打版图；都没有就是空（前端出占位） */
      thumb: o.image_url || o.tech_image_url || '',
      /** 超期标记由后端算好，前端不再自己比日期（两套判断必然对不上） */
      overdue: Number(o.is_overdue) === 1,
      days_late: o.days_late === null || o.days_late === undefined ? null : Number(o.days_late),
      /** 这张单还没生成过工序（没走过「转生产中」）：看板要提示，不能显示成「全都没开始」 */
      no_nodes: nodes.length === 0,
      done_count: done,
      total_count: total,
      skipped_count: skipped,
      progress: total ? Math.round((done / total) * 100) : 0,
      current: cur ? cur.name : null,
      current_code: cur ? cur.code : null,
      /**
       * 仅扫码的步骤状态 —— 单独返回，不占列。
       *
       * 前端拿它做两件事：进度没到 100% 时说明「还差检验、包装」；
       * 全部走完时也不必让人猜为什么进度停在 86%。
       */
      scan_total: scanCells.length,
      scan_pending: scanPending.length,
      scan_pending_names: scanPending.map((c) => c.name)
    };
  });

  return {
    template: { id: tpl.id, name: tpl.name, is_default: tpl.is_default },
    columns,
    /** 仅扫码的节点清单（不进列，但它是流程的一部分，得让人知道有这几步） */
    scan_items: scanItems.map((it) => ({ code: it.code, name: it.name, seq: it.seq })),
    rows,
    stats,
    filters: {
      status, q, customer_id: customerId, manager,
      order_from: orderFrom, order_to: orderTo, due_from: dueFrom, due_to: dueTo,
      overdue: !!overdue, no_due: !!noDue, due_soon: !!dueSoon,
      node_code: nodeCode, node_status: nodeStatus, sort
    },
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

  /**
   * 分配节点不许手工标完成
   *
   * 手工点绿之后，看板上这一步是 ✓，但分单表里一条记录都没有 ——
   * 于是「工厂」列还写着未分配、转生产又提示"尚未完成整单分单"。
   * 三个地方三个说法，而每个都"有据可查"。
   * 这个节点的完成**只能由分配动作带来**（`orderAssign.assign` 里写分单 + 标完成）。
   */
  if (status === 'done' && status !== row.status) {
    const tplItem = db.prepare('SELECT panel FROM node_template_items WHERE template_id = ? AND code = ?')
      .get(row.template_id, row.code);
    if (tplItem && String(tplItem.panel) === 'assign') {
      const { snapshot } = require('./orderAssign');
      if (snapshot(row.order_id).mode === 'none') {
        throw bad(`「${row.name}」要先点「分配本厂 / 整单外发」，分配完才会自动完成；直接标完成会让看板显示"已完成但没分配"`);
      }
    }
  }

  const t = now();
  let actual = b.actual_date !== undefined ? b.actual_date : row.actual_date;
  if (status === 'done' && !actual) actual = new Date().toISOString().slice(0, 10);
  if (status !== 'done') actual = b.actual_date !== undefined ? b.actual_date : null;

  const nextPlan = b.plan_date !== undefined ? b.plan_date : row.plan_date;
  const nextOperator = b.operator !== undefined ? b.operator : row.operator;
  const nextRemark = b.remark !== undefined ? b.remark : row.remark;
  const nextSkip = status === 'skipped' ? String(b.skip_reason || '').trim() : null;

  db.prepare(
    'UPDATE order_nodes SET status = ?, plan_date = ?, actual_date = ?, operator = ?, remark = ?, skip_reason = ? WHERE id = ?'
  ).run(status, nextPlan, actual, nextOperator, nextRemark, nextSkip, nodeId);

  /**
   * 逐项记变更 —— 只记真的变了的那几项。
   *
   * 记「保存了一次」没有意义：看板上要回答的是「这一步谁在什么时候做完的」，
   * 所以按字段拆开写，同一个动作里改了状态又加了备注就记两条。
   */
  const actor = b.actor || null;
  if (status !== row.status) {
    logNode(nodeId, row.order_id, 'status',
      `${STATUS_LABEL[row.status] || row.status} → ${STATUS_LABEL[status] || status}`, actor);
  }
  if (nextPlan !== row.plan_date) {
    logNode(nodeId, row.order_id, 'plan', `计划完成 ${row.plan_date || '未填'} → ${nextPlan || '未填'}`, actor);
  }
  if (nextOperator !== row.operator) {
    logNode(nodeId, row.order_id, 'operator', `责任人 ${row.operator || '未填'} → ${nextOperator || '未填'}`, actor);
  }
  if (nextRemark !== row.remark) {
    logNode(nodeId, row.order_id, 'remark', String(nextRemark || '').slice(-200), actor);
  }
  if (nextSkip !== row.skip_reason) {
    logNode(nodeId, row.order_id, 'skip', `标记不适用：${nextSkip || '（清除）'}`, actor);
  }
  void t;
  return db.prepare('SELECT * FROM order_nodes WHERE id = ?').get(nodeId);
}

module.exports = {
  BUILTIN_CODES,
  BUILTIN_ORDER,
  STATUS_LABEL,
  logNode,
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
  markDoneByCode,
  applyToOrders,
  board,
  setNode
};
