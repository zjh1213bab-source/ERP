/**
 * 生产分配（待分配订单 → 本厂生产 / 整单外发 / 裁片外发）
 * ============================================================
 * ## 分配的事实只有一个地方：`dispatch_orders`
 *
 * 「这张单自己做还是发外协」在这套系统里本来就有落点 —— 分单表
 * （`dispatch_orders`，`type` 分 own / outsource，带工厂与数量）。
 * 转生产的前置门槛、外协对账、分单删除限制全挂在它上面。
 *
 * 所以看板上「待分配订单」这一格点开的按钮，**不能另起一套标记**
 * （比如给 `orders` 加个 `prod_mode` 字段）。两套标记的结果是可预见的：
 * 看板说"已外发"、分单页说"未分单"、转生产又说"尚未完成整单分单" ——
 * 三个页面三个答案，而每个都"有据可查"。
 *
 * 这里做的事就一件：把「分配」写成一条分单，然后：
 *   1. 走 `addDispatch()` —— 与分单页**同一份校验**（财务审核、超量、覆盖整单）；
 *   2. 把点开的那个节点标完成，并在时间线里写明分给了谁、多少件；
 *   3. 不自动把订单推进到「生产中」：分配完成 ≠ 可以开工，
 *      哪天投产由生产计划定，自动推会让齐套/排产提前看见一张还没备料的单。
 *
 * ## 为什么外发必须选厂
 *
 * 不选厂的外发，后面排产找不到产能、验货找不到人、对账找不到户头 ——
 * 而这三件事都会在两周后才暴露。所以宁可在这一步拦下来。
 */
const { db, now } = require('../db');
const { localDate } = require('../utils/time');
const nodeFlow = require('./nodeFlow');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const MODES = {
  own: '本厂生产',
  outsource: '整单外发',
  cut: '裁片外发'
};
const TYPE_LABEL = { own: '本厂', outsource: '外协' };

/** 订单总件数（分单上限） */
function orderQty(orderId) {
  return num(db.prepare('SELECT COALESCE(SUM(qty),0) AS s FROM order_items WHERE order_id = ?').get(orderId).s);
}

/** 已有效分单件数 —— 只认有工厂或明确写了承做方的行（"未指定"不算分配） */
function allocatedQty(orderId) {
  return num(db.prepare(
    `SELECT COALESCE(SUM(qty),0) AS qty FROM dispatch_orders
      WHERE order_id = ? AND IFNULL(status,'') != 'cancelled'
        AND ((factory_id IS NOT NULL AND factory_id > 0) OR TRIM(IFNULL(factory_name,'')) NOT IN ('','未指定'))`
  ).get(orderId).qty);
}

/**
 * 当前分配方式（**从分单事实反算，不存字段**）
 *
 *   none      一条有效分单都没有
 *   own       全部本厂
 *   outsource 全部外协
 *   mixed     既分本厂又分外协（拆单很常见，不能硬归成一边）
 */
function modeOf(orderId) {
  const rows = db.prepare(
    `SELECT type, COALESCE(SUM(qty),0) qty FROM dispatch_orders
      WHERE order_id = ? AND IFNULL(status,'') != 'cancelled'
        AND ((factory_id IS NOT NULL AND factory_id > 0) OR TRIM(IFNULL(factory_name,'')) NOT IN ('','未指定'))
      GROUP BY type`
  ).all(orderId);
  const own = num((rows.find((r) => r.type === 'own') || {}).qty);
  const out = num((rows.find((r) => r.type === 'outsource') || {}).qty);
  if (own <= 0 && out <= 0) return 'none';
  if (own > 0 && out > 0) return 'mixed';
  return out > 0 ? 'outsource' : 'own';
}

const MODE_TEXT = { none: '未分配', own: '本厂生产', outsource: '整单外发', mixed: '本厂 + 外协（拆单）' };

function factories() {
  return db.prepare("SELECT id, name, type, status FROM factories WHERE IFNULL(status,'active') = 'active' ORDER BY type DESC, id")
    .all()
    .map((f) => ({ ...f, type_label: TYPE_LABEL[f.type] || f.type }));
}

function ownFactory() {
  return db.prepare("SELECT id, name FROM factories WHERE type = 'own' AND IFNULL(status,'active') = 'active' ORDER BY id LIMIT 1").get() || null;
}

/**
 * 插入一条分单（**唯一实现**）
 *
 * 分单页（`routes/dispatch.js`）和看板分配按钮都走这里。
 * 各写一遍的失败方式很具体：面板能分超量、分单页拦住；或者面板不看财务审核，
 * 于是财务没过账的单已经在车间做了。
 *
 * @returns {{id, dispatches, allocated, order_qty, covered, promoted}}
 */
function addDispatch({ orderId, factory_id = null, factory_name = '', type = '', qty = null, price = 0, remark = '' }, operator) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw bad('订单不存在', 404);
  if (!['finance', 'assigned'].includes(order.status)) {
    throw bad(`订单当前为「${order.status}」，只有财务审核/已分单状态可分单`);
  }
  const cost = db.prepare("SELECT 1 AS x FROM cost_sheets WHERE order_id = ? AND status = 'approved' LIMIT 1").get(orderId);
  if (!cost) throw bad('财务尚未审核通过，不能分单');

  const fac = factory_id ? db.prepare('SELECT * FROM factories WHERE id = ?').get(factory_id) : null;
  if (factory_id && !fac) throw bad('工厂不存在');
  const factoryName = fac ? fac.name : String(factory_name || '').trim();
  if (!factoryName) throw bad('请选择实际承做的工厂/车间');

  const kind = type === 'outsource' || (fac && fac.type === 'outsource') ? 'outsource' : 'own';
  const orderTotal = orderQty(orderId);
  if (!(orderTotal > 0)) throw bad('订单数量为 0，不能分单');
  const q = qty === null || qty === undefined || qty === '' ? orderTotal : Number(qty);
  if (!Number.isFinite(q) || !(q > 0)) throw bad('分单数量必须是大于 0 的有效数字');

  const t = now();
  let dispatchId;
  let assignedNote = null;
  let covered = false;
  db.exec('BEGIN');
  try {
    const allocated = num(db.prepare('SELECT COALESCE(SUM(qty),0) AS qty FROM dispatch_orders WHERE order_id = ?').get(orderId).qty);
    if (allocated + q > orderTotal + 0.0001) {
      throw bad(`分单超出订单总量：订单 ${orderTotal} 件，已分单 ${allocated} 件，本次 ${q} 件`);
    }
    const info = db.prepare(
      'INSERT INTO dispatch_orders (order_id, factory_id, factory_name, type, qty, price, status, remark, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(orderId, factory_id || null, factoryName, kind, q, num(price), 'dispatched', remark || null, t);
    dispatchId = Number(info.lastInsertRowid);

    const validAllocated = allocatedQty(orderId);
    covered = validAllocated + 0.0001 >= orderTotal;
    if (order.status === 'finance' && covered) {
      assignedNote = `分单数量覆盖整单：${factoryName}（${kind === 'own' ? '本厂' : '外协'}）× ${validAllocated}`;
      db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run('assigned', t, orderId);
      db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
        .run(orderId, 'finance', 'assigned', operator || 'system', assignedNote, t);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // 副作用（通知等）必须在事务提交后：事务里发消息，回滚了消息已经发出去
  if (assignedNote) {
    try {
      const orderFlow = require('./orderFlow');
      orderFlow.afterTransition(order, { to: 'assigned', note: assignedNote, user: { username: operator } });
    } catch (e) { /* 通知失败不影响已落库的分单 */ }
  }
  return {
    id: dispatchId,
    dispatches: db.prepare('SELECT * FROM dispatch_orders WHERE order_id = ? ORDER BY id').all(orderId),
    allocated: allocatedQty(orderId),
    order_qty: orderTotal,
    covered,
    promoted: !!assignedNote
  };
}

/** 面板要的全部信息：当前分配、可选工厂、能不能分、为什么不能 */
function snapshot(orderId) {
  const order = db.prepare(
    'SELECT id, order_no, style_name, status, delivery_date FROM orders WHERE id = ?'
  ).get(orderId);
  if (!order) throw bad('订单不存在', 404);

  const rows = db.prepare(
    'SELECT * FROM dispatch_orders WHERE order_id = ? ORDER BY id'
  ).all(orderId).map((d) => ({
    ...d,
    type_label: TYPE_LABEL[d.type] || d.type,
    status_label: d.status === 'settled' ? '已结算' : '已分单'
  }));

  const total = orderQty(orderId);
  const alloc = allocatedQty(orderId);
  const pending = r2(Math.max(0, total - alloc));
  const mode = modeOf(orderId);
  const fs = factories();
  const own = ownFactory();
  const cost = db.prepare("SELECT status FROM cost_sheets WHERE order_id = ? ORDER BY id DESC LIMIT 1").get(orderId);

  const blocked = [];
  if (!['finance', 'assigned'].includes(order.status)) {
    blocked.push(`订单状态「${order.status}」不能分单：要先走完财务审核（订单详情 → 状态流转）`);
  }
  if (!cost || cost.status !== 'approved') {
    blocked.push('成本单还没审核通过：去「订单 → 成本核算」提交并审核，通过后才允许定谁做');
  }
  if (!own) blocked.push('系统里没有启用的「本厂」工厂档案：先去「基础资料 → 工厂」建一条 type=本厂');
  if (!fs.some((f) => f.type === 'outsource')) blocked.push('没有启用的外协厂档案，无法外发');
  if (total <= 0) blocked.push('订单件数为 0，无法分单');

  return {
    order,
    order_qty: total,
    allocated: alloc,
    pending_qty: pending,
    mode,
    mode_label: MODE_TEXT[mode] || mode,
    dispatches: rows,
    factories: fs,
    own_factory: own,
    can_assign: blocked.length === 0,
    block_reason: blocked.join('；'),
    /** 已经分完了：此时只能去分单页删改，面板按钮不该还能点 */
    full: pending <= 0.0001
  };
}

/**
 * 从看板节点上执行分配
 *
 * @param {number} nodeId 点开的那个节点（用它标完成 —— 不按 code 认，
 *   业务把节点改名/换模板后 code 依然稳定，但「点的是哪一格」是最不会错的）
 * @param {{mode:string, factory_id?:number, qty?:number, note?:string}} b
 */
function assign(nodeId, b, operator) {
  const node = db.prepare('SELECT * FROM order_nodes WHERE id = ?').get(Number(nodeId));
  if (!node) throw bad('工序不存在', 404);
  const item = db.prepare('SELECT panel, name FROM node_template_items WHERE template_id = ? AND code = ?')
    .get(node.template_id, node.code);
  if (!item || String(item.panel) !== 'assign') {
    throw bad(`「${node.name}」不是分配节点：请在节点流程里把它的弹窗类型设为「生产分配」`);
  }

  const mode = String(b.mode || '');
  if (!MODES[mode]) throw bad('分配方式只能是：本厂生产 / 整单外发 / 裁片外发');

  const snap = snapshot(node.order_id);
  if (!snap.can_assign) throw bad(`现在不能分配：${snap.block_reason}`);

  // 已经分完：同一方式再点一次算幂等（不报错、不重复写），否则要人先去改分单
  if (snap.full) {
    const want = mode === 'outsource' ? 'outsource' : 'own';
    const same = snap.mode === want
      && (want === 'own' || new Set(snap.dispatches.filter((d) => d.type === 'outsource').map((d) => d.factory_id)).size <= 1);
    if (same) {
      markNode(node, operator, `分配确认：${snap.mode_label}（已分 ${snap.allocated} 件）`);
      return { ...snap, mode_label: snap.mode_label, changed: false, idempotent: true };
    }
    throw bad(`这张单已经分配完了（${snap.mode_label}，共 ${snap.allocated} 件），要改请先到分单页删掉原分单`);
  }

  /**
   * 工厂怎么定：
   *   本厂 / 裁片外发 → 取「本厂」工厂档案，不用人选
   *   整单外发       → 必须选，且必须是外协厂（分给本厂却叫外发，标签就假了）
   */
  let factoryId = null;
  let factoryName = '';
  let dispatchType = 'own';
  if (mode === 'outsource') {
    factoryId = b.factory_id ? Number(b.factory_id) : null;
    if (!factoryId) throw bad('外发要选具体的外协厂：不选厂，后面排产、验货、对账都找不到人');
    const fac = db.prepare('SELECT * FROM factories WHERE id = ?').get(factoryId);
    if (!fac) throw bad('外协厂不存在', 404);
    if (fac.type === 'own') throw bad(`「${fac.name}」是自有车间，走「分配本厂」`);
    if (String(fac.status || 'active') !== 'active') throw bad(`「${fac.name}」已停用，不能外发`);
    factoryName = fac.name;
    dispatchType = 'outsource';
  } else {
    const own = snap.own_factory;
    if (!own) throw bad('系统里没有启用的「本厂」工厂档案');
    factoryId = own.id;
    factoryName = own.name;
  }

  const qty = b.qty === undefined || b.qty === null || b.qty === '' ? snap.pending_qty : Number(b.qty);
  if (!(qty > 0)) throw bad('分配数量必须大于 0');
  if (qty > snap.pending_qty + 0.0001) {
    throw bad(`还有 ${snap.pending_qty} 件没分配，本次填了 ${qty} 件`);
  }

  const res = addDispatch({
    orderId: node.order_id,
    factory_id: factoryId,
    type: dispatchType,
    qty,
    remark: [`看板分配（${MODES[mode]}）`, String(b.note || '').trim()].filter(Boolean).join('：')
  }, operator);

  const after = snapshot(node.order_id);
  const detail = `${MODES[mode]} → ${factoryName} × ${r2(qty)} 件`
    + (after.full ? `（整单已分完 ${after.allocated} 件）` : `（还剩 ${after.pending_qty} 件未分配）`);
  markNode(node, operator, detail);

  return {
    ...after,
    changed: true,
    dispatch_id: res.id,
    qty: r2(qty),
    factory: { id: factoryId, name: factoryName },
    /** 裁片外发不是整单外发：本厂照常做，只是裁片那一环节发出去 */
    hint: mode === 'cut'
      ? '已按「本厂生产」入账。裁片外发要另外建外发单（裁片外发 → 新建），否则扎包发出去就没有回货记录'
      : null
  };
}

/** 把节点标完成 + 写时间线（分配是业务动作，节点不该还停在「待开始」） */
function markNode(node, operator, detail) {
  const t = localDate(new Date().toISOString());
  if (node.status !== 'done') {
    db.prepare("UPDATE order_nodes SET status = 'done', actual_date = COALESCE(actual_date, ?), operator = COALESCE(operator, ?) WHERE id = ?")
      .run(t, operator || null, node.id);
    nodeFlow.logNode(node.id, node.order_id, 'status',
      `${nodeFlow.STATUS_LABEL[node.status] || node.status} → 已完成（看板分配）`, operator);
  }
  nodeFlow.logNode(node.id, node.order_id, 'assign', detail, operator);
}

module.exports = { MODES, MODE_TEXT, TYPE_LABEL, orderQty, allocatedQty, modeOf, factories, snapshot, addDispatch, assign };
