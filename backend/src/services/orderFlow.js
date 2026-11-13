/**
 * 订单状态流转（唯一实现）
 * ============================================================
 * 为什么要把这段从路由里搬出来：
 *   `/api/orders/:id/transition` 和「批量流转」必须走**同一套门槛**。
 *   如果批量再抄一遍判断，迟早出现「单张要评审、批量能跳过」——
 *   这类洞在权限系统里最常见，也最难解释给审计听。
 *
 * 拆成三步，是为了批量能「先看再动」：
 *   check()  —— 只校验不改库（返回 order 或抛错）。批量先用它对全部 id 预检。
 *   apply()  —— 真正写库 + 副作用（工序初始化、开应收、成本归集、客户消息）。
 *   transition() —— check + apply，单张流转用。
 *
 * 门槛（少一道都不行）：
 *   进入 tech     —— 接单评审 approved + 开发单 confirmed + 定制单打版流程 done + 封样双确认
 *   进入 assigned —— 成本单已财务审核通过
 *   进入 closed   —— 应收已收清（force 可跳，但必须写备注）
 *   进入 production —— 自动初始化 13 道工序
 *   进入 shipped  —— 幂等开应收 + 成本对象归集并按发货数量结转
 */
const { db, now } = require('../db');
const { ensureNodes } = require('./production');
const { findByCode } = require('./nodeFlow');
const { notifyOrderStatus } = require('./mall');
const { sealGate } = require('../routes/confirm');
const { STAGE_LABELS } = require('../routes/patternFlows');
const { openARForOrder } = require('../routes/finance');
const { ensureCostObject, collectAuto, syncSold } = require('../routes/costObjects');
const { ensureCommitment } = require('../routes/commitments');

const STATUS_LABELS = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', production_audit: '生产审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};

// 财务确认之后先到技术开发「生产审核」，核对无误才允许进入供应链分配（assigned）。
const FLOW = {
  draft: ['tech'], tech: ['finance'], finance: ['production_audit'], production_audit: ['assigned'],
  assigned: ['production'], production: ['instock'], instock: ['shipped'], shipped: ['closed']
};

/** 正向链路：反审只能往前面的状态退，不能跨过 draft，也不能退已发货/已结案 */
const CHAIN = ['draft', 'tech', 'finance', 'production_audit', 'assigned', 'production', 'instock', 'shipped', 'closed'];

const TRANSITION_ROLES = {
  tech: ['admin', 'sales', 'tech'], finance: ['admin', 'sales', 'tech'],
  production_audit: ['admin', 'sales', 'tech'], assigned: ['admin', 'finance'],
  production: ['admin', 'sales', 'production'], instock: ['admin', 'production', 'warehouse'],
  shipped: ['admin', 'warehouse', 'finance'], closed: ['admin', 'sales'], cancelled: ['admin', 'sales']
};

/** 生产审核以最新一条记录为准；状态机与分配服务共用，避免两边判断不一致。 */
function productionAuditPassed(orderId) {
  const row = db.prepare('SELECT decision FROM order_production_audits WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(orderId);
  return row?.decision === 'approve';
}

const QTY_EPSILON = 0.0001;

function orderQty(orderId) {
  return Number(db.prepare('SELECT COALESCE(SUM(qty),0) AS qty FROM order_items WHERE order_id = ?').get(orderId).qty) || 0;
}

function dispatchedQty(orderId) {
  return Number(db.prepare(
    `SELECT COALESCE(SUM(qty),0) AS qty FROM dispatch_orders
      WHERE order_id = ? AND IFNULL(status,'') != 'cancelled'
        AND ((factory_id IS NOT NULL AND factory_id > 0) OR TRIM(IFNULL(factory_name,'')) NOT IN ('','未指定'))`
  ).get(orderId).qty) || 0;
}

function checkOrderMatrix(orderId) {
  const items = db.prepare('SELECT id, product_name, qty FROM order_items WHERE order_id = ?').all(orderId);
  if (!items.length) throw bad('订单没有款式明细，不能进入技术确认');
  const sizes = db.prepare('SELECT color, size, qty FROM order_item_sizes WHERE item_id = ?');
  const placeholderColors = new Set(['', '待定', '待分色', '未定']);
  const placeholderSizes = new Set(['', '待定', '待定尺码', '待补尺码']);
  for (const item of items) {
    const rows = sizes.all(item.id);
    if (!rows.length) throw bad(`款「${item.product_name}」没有颜色尺码明细，请先完善订单明细`);
    const qty = rows.reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
    if (Math.abs(qty - Number(item.qty || 0)) > QTY_EPSILON) {
      throw bad(`款「${item.product_name}」颜色尺码数量合计与款式总数不一致，请先修正订单明细`);
    }
    if (rows.some((row) => placeholderColors.has(String(row.color || '').trim()) || placeholderSizes.has(String(row.size || '').trim()) || !(Number(row.qty) > 0))) {
      throw bad(`款「${item.product_name}」仍有待定颜色、空尺码或无效数量，请先完善订单明细`);
    }
  }
}

function checkProductionReadyForStock(orderId) {
  const qty = orderQty(orderId);
  if (!(qty > 0)) throw bad('订单数量为 0，不能办理成品入库');
  // 按 code 找，不按名字：业务把「检验」改成「质检 / 尾检 / 全检」都不能让这道闸失效
  const node = findByCode(orderId, 'inspect');
  if (!node || node.status !== 'done') throw bad('生产检验工序尚未完成，不能办理成品入库');
  const report = db.prepare(
    'SELECT COALESCE(SUM(qty_ok),0) AS qty_ok FROM production_reports WHERE order_id = ? AND node_id = ?'
  ).get(orderId, node.id);
  if (Number(report.qty_ok) + QTY_EPSILON < qty) throw bad(`检验工序合格报工不足：订单 ${qty} 件，已报合格 ${Number(report.qty_ok) || 0} 件`);
  const packing = findByCode(orderId, 'pack');
  if (!packing || packing.status !== 'done') throw bad('包装工序尚未完成，不能办理成品入库');
  const packingReport = db.prepare(
    'SELECT COALESCE(SUM(qty_ok),0) AS qty_ok FROM production_reports WHERE order_id = ? AND node_id = ?'
  ).get(orderId, packing.id);
  if (Number(packingReport.qty_ok) + QTY_EPSILON < qty) {
    throw bad(`包装工序合格报工不足：订单 ${qty} 件，已报合格 ${Number(packingReport.qty_ok) || 0} 件`);
  }
  const qc = db.prepare(
    `SELECT aql_result FROM qc_inspections WHERE order_id = ? AND type = 'final' AND status = 'done'
      ORDER BY IFNULL(inspect_date, '') DESC, id DESC LIMIT 1`
  ).get(orderId);
  if (!qc || !['pass', 'conditional'].includes(qc.aql_result)) throw bad('订单尚无已完成且放行的尾期验货记录，不能办理成品入库');
}

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

/**
 * 校验能不能流转（不改库）
 * @returns {object} order 行
 * @throws 400/403/404 带人话原因
 */
function check(orderId, { to, force, user, write = true, source } = {}) {
  const id = Number(orderId);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) throw bad('订单不存在', 404);

  const cur = order.status;
  const allowedRoles = TRANSITION_ROLES[to];
  if (!allowedRoles) throw bad('非法的目标状态（' + (to || '空') + '）');

  const isCancel = to === 'cancelled';
  const normalOk = (FLOW[cur] || []).includes(to);
  const cancelOk = isCancel && cur !== 'closed' && cur !== 'cancelled';
  if (!normalOk && !cancelOk) {
    throw bad(`订单当前为「${STATUS_LABELS[cur] || cur}」，不能流转到「${STATUS_LABELS[to] || to}」`);
  }
  const role = user && user.role;
  if (!(role === 'admin' || allowedRoles.includes(role))) {
    throw bad('你的角色无权执行该状态变更', 403);
  }

  // 库存状态必须和真实库存流水同事务产生，不能通过通用状态接口或批量流转伪造。
  if (to === 'instock' && source !== 'stock') throw bad('请通过「成品入库」办理入库并生成库存流水');
  if (to === 'shipped' && source !== 'stock') throw bad('请通过「发货出库」办理发货并生成库存流水');

  // ---------- 门槛 1：进入技术确认 ----------
  if (to === 'tech') {
    // 接单评审：前端裁床 / 后端缝制 / 物料三项分别确认，未通过不得进入技术确认
    // write=false 是「预检」分支：ensureCommitment 在记录不存在时会创建一条草稿，
    // 预检要是也去创建，就等于「看一眼就把数据改了」
    const commit = write
      ? ensureCommitment(id, null, user && user.username)
      : db.prepare('SELECT * FROM commitments WHERE order_id = ?').get(id);
    if (!commit || commit.review_status !== 'approved') {
      const why = !commit ? '还没有接单评审记录'
        : commit.review_status === 'rejected'
          ? `评审未通过（${commit.review_note || '有环节不能承接'}）`
          : '评审还没做';
      throw bad(`接单评审${commit && commit.review_status === 'rejected' ? '未通过' : '未完成'}：${why}。` +
        '请到「生产 → 接单评审与交期」确认前端裁床、后端缝制、物料齐套三项并给出承诺交期后再做技术确认');
    }
    const packs=db.prepare('SELECT * FROM tech_packs WHERE order_id=? ORDER BY id DESC').all(id);
    if (!packs.length) throw bad('开发单尚未确认，无法通过「技术确认」；请先补全并确认开发单');
    const styles=db.prepare('SELECT id,source_pre_order_item_id,product_name,style_no FROM order_items WHERE order_id=?').all(id);
    for(const style of styles){
      const tp=require('./orderTechnicalPacks').packForItem(id,style,styles);
      if(!tp)throw bad(`款「${style.style_no||style.product_name}」没有对应开发单，请逐款关联技术资料`);
      if(tp.status!=='confirmed')throw bad(`款「${style.style_no||style.product_name}」开发单尚未确认，请逐款完成技术确认`);
      if (order.type === 'custom') {
      const flow = db.prepare('SELECT * FROM pattern_flows WHERE tech_pack_id = ?').get(tp.id);
      if (!flow) throw bad('定制订单必须走打版流程：该开发单还没有打版流程记录，请到「打版流程」发起');
      if (flow.status !== 'done') {
        const left = db.prepare('SELECT stage FROM pattern_stages WHERE flow_id = ? AND status != ?').all(flow.id, 'done');
        const names = left.map((r) => STAGE_LABELS[r.stage] || r.stage).join('、');
        throw bad(`定制订单的打版流程尚未完成，剩余：${names || '收尾确认'}；请到「打版流程」完成后再做技术确认`);
      }
      }
    }
    // 走过样衣封样的订单：最新版本必须「客户已确认 + 总部技术已批准」双确认
    const gate = sealGate(id);
    if (!gate.ok) throw bad(gate.message);
    // 业务评审与技术资料门禁都完成后，再检查转生产所需的颜色尺码矩阵；
    // 这样提示用户先处理当前最靠前的业务缺项，而不是被后续明细校验遮住。
    checkOrderMatrix(id);
  }

  // ---------- 门槛 2：进入已分单 ----------
  if (to === 'assigned') {
    if (!productionAuditPassed(id)) throw bad('技术开发「生产审核」尚未核对通过，不能进入已分单');
    const cs = db.prepare("SELECT 1 AS x FROM cost_sheets WHERE order_id = ? AND status = 'approved' LIMIT 1").get(id);
    if (!cs) throw bad('财务尚未审核通过，无法「分单」；请先录入成本并完成财务审核');
    const qty = orderQty(id);
    const dispatched = dispatchedQty(id);
    if (!(qty > 0) || dispatched + QTY_EPSILON < qty) throw bad(`分单数量未覆盖整张订单：订单 ${qty} 件，已分单 ${dispatched} 件`);
  }

  // ---------- 门槛 3：进入生产前必须完成整单分配 ----------
  if (to === 'production') {
    const qty = orderQty(id);
    const dispatched = dispatchedQty(id);
    if (!(qty > 0) || dispatched + QTY_EPSILON < qty) throw bad(`尚未完成整单分单：订单 ${qty} 件，已分单 ${dispatched} 件`);
  }

  // ---------- 门槛 4：成品入库前必须有完整生产检验与尾期验货 ----------
  if (to === 'instock') {
    if (source !== 'stock') throw bad('请通过「成品入库」办理入库并生成库存流水');
    checkProductionReadyForStock(id);
  }

  // ---------- 门槛 5：结案前应收要清 ----------
  if (to === 'closed' && !force) {
    const invoices = db.prepare('SELECT * FROM ar_invoices WHERE order_id = ? AND status != ?').all(id, 'void');
    const invoiced=invoices.reduce((sum,a)=>sum+(Number(a.amount)||0),0);
    if(Number(order.total_amount)>0.005&&invoiced+0.005<Number(order.total_amount))throw bad('订单应收尚未完整生成，请核对应收账款后再结案');
    for(const ar of invoices){
      const open = Math.round(((Number(ar.amount) || 0) - (Number(ar.paid_amount) || 0)) * 100) / 100;
      if (open > 0.005) {
        throw bad(`该订单还有未收金额 ${open} 元（${ar.bill_no}），收清后再结案；确需先结案请传 force=true 并说明原因`);
      }
    }
  }

  return order;
}

/**
 * 执行流转（调用前必须先 check 通过）
 * @param {object} order check 返回的订单
 * @param {{to:string, note?:string, batchNo?:string, user:object}} opts
 */
function apply(order, { to, note, batchNo, user } = {}) {
  const id = order.id;
  const cur = order.status;
  const t = now();
  const who = (user && user.username) || 'system';

  // 批次说明写在备注最前面：事后按批次号能一把捞出「这一批动了哪些单」
  const finalNote = [batchNo ? `${batchNo} 批量流转` : null, note || null].filter(Boolean).join('：') || null;

  /**
   * 先建工序节点，再改状态。
   *
   * 原来是「先 UPDATE status='production'，再 ensureNodes()」，两步之间没有事务 ——
   * ensureNodes 抛错（模板被删光/模板里没节点）时，**订单已经变成生产中、节点一个没有**，
   * 后面既不能报工（没有 node_id）、也不能重推（状态已经是 production，再流转被「不能流转到生产中」挡回来）。
   * 这单就死在中间态，只能改库救。
   *
   * 现在把 ensureNodes 放在改状态之前：它自带事务，失败就整段抛出、状态原样不动。
   */
  if (to === 'production') ensureNodes(id);

  db.exec('BEGIN');
  try {
    const updated=db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status=? AND updated_at IS ?').run(to,t,id,cur,order.updated_at);
    if(updated.changes!==1)throw bad('订单已被其他操作更新，请刷新后重试',409);
    db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, cur, to, who, finalNote, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  afterTransition(order, { to, note: finalNote, user });

  return { id, from: cur, to };
}

/** 在业务事务提交后执行通知及发货财务副作用；库存路由也复用此方法。 */
function afterTransition(order, { to, note, user } = {}) {
  const id = order.id;
  const who = (user && user.username) || 'system';
  if (to === 'shipped') {
    try { openARForOrder(id, who); } catch (e) { /* 开票失败不影响已完成的实物发货 */ }
    try {
      const obj = ensureCostObject(id);
      if (obj) { collectAuto(obj); syncSold(obj.id, who); }
    } catch (e) { /* 成本归集失败不影响已完成的实物发货 */ }
  }
  try { notifyOrderStatus(id, to, note || null); } catch (e) { /* 消息失败不影响主流程 */ }
}

/** 单张流转 = check + apply */
function transition({ orderId, to, note, force, user }) {
  const order = check(orderId, { to, force, user });
  const r = apply(order, { to, note, user });
  return { ...r, order_no: order.order_no };
}

/**
 * 批次号：只用于追溯，不做序号递增
 * 同一天同一秒做两次批量几乎不可能（真发生了也只是两批同号，按时间仍能区分）。
 */
function batchNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `BAT${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 批量流转
 * @param {{ids:number[], to:string, note?:string, force?:boolean, dryRun?:boolean, allOrNothing?:boolean, user:object}} p
 *
 * 两种模式：
 *   - 默认「逐单尽力」：能过的过，过不去的逐条列出原因。批量场景里各单情况本来就不同，
 *     一刀切回滚会让「199 单成功、1 单失败」变成「200 单全不动」，等于没法用。
 *   - allOrNothing=true：先对全部 id 预检，有一单不过就整批不执行（适用于强一致场景）。
 * 无论哪种，**返回里每一单的结果都有**，前端必须逐条展示，不许一句「部分成功」带过。
 */
function batchTransition({ ids, to, note, force, dryRun, allOrNothing, user } = {}) {
  const list = [...new Set((ids || []).map(Number).filter((n) => n > 0))];
  if (!list.length) throw bad('没有选中任何订单');
  if (list.length > 200) throw bad('一次最多处理 200 单，分批来');
  if (!TRANSITION_ROLES[to]) throw bad('非法的目标状态');

  if (dryRun) {
    const ok = [];
    const fail = [];
    list.forEach((id) => {
      try {
        // 预检同样判角色（否则会出现「预检通过、执行 403」的惊吓）；但不写库
        const o = check(id, { to, force, user, write: false });
        ok.push({ id, order_no: o.order_no, from: o.status });
      } catch (e) {
        const row = db.prepare('SELECT order_no, status FROM orders WHERE id = ?').get(id);
        fail.push({
          id,
          order_no: row ? row.order_no : null,
          status: row ? row.status : null,
          reason: e.message
        });
      }
    });
    return {
      dry_run: true,
      to,
      to_label: STATUS_LABELS[to],
      requested: list.length,
      ok_count: ok.length,
      fail_count: fail.length,
      ok,
      fail
    };
  }

  const no = batchNo();
  const ok = [];
  const fail = [];

  // 整批一致性：先全检，有一个不过就整体不动（并且把原因全列出来，而不是只报第一个）
  if (allOrNothing) {
    list.forEach((id) => {
      try {
        check(id, { to, force, user });
      } catch (e) {
        const row = db.prepare('SELECT order_no, status FROM orders WHERE id = ?').get(id);
        fail.push({ id, order_no: row ? row.order_no : null, status: row ? row.status : null, reason: e.message });
      }
    });
    if (fail.length) {
      return {
        batch_no: null,
        to,
        to_label: STATUS_LABELS[to],
        requested: list.length,
        ok_count: 0,
        fail_count: fail.length,
        ok: [],
        fail,
        aborted: true,
        message: `整批模式：${fail.length} 单不满足条件，整批未执行`
      };
    }
  }

  list.forEach((id) => {
    try {
      const order = check(id, { to, force, user });
      const r = apply(order, { to, note, batchNo: no, user });
      ok.push({ id, order_no: order.order_no, from: r.from, to: r.to });
    } catch (e) {
      const row = db.prepare('SELECT order_no, status FROM orders WHERE id = ?').get(id);
      fail.push({ id, order_no: row ? row.order_no : null, status: row ? row.status : null, reason: e.message });
    }
  });

  return {
    batch_no: ok.length ? no : null,
    to,
    to_label: STATUS_LABELS[to],
    requested: list.length,
    ok_count: ok.length,
    fail_count: fail.length,
    ok,
    fail,
    aborted: false
  };
}

module.exports = {
  STATUS_LABELS,
  FLOW,
  CHAIN,
  TRANSITION_ROLES,
  check,
  apply,
  afterTransition,
  transition,
  batchTransition,
  batchNo,
  productionAuditPassed
};
