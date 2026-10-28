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
const { notifyOrderStatus } = require('./mall');
const { sealGate } = require('../routes/confirm');
const { STAGE_LABELS } = require('../routes/patternFlows');
const { openARForOrder } = require('../routes/finance');
const { ensureCostObject, collectAuto, syncSold } = require('../routes/costObjects');
const { ensureCommitment } = require('../routes/commitments');

const STATUS_LABELS = {
  draft: '草稿', tech: '技术确认', finance: '财务审核', assigned: '已分单',
  production: '生产中', instock: '已入库', shipped: '已发货', closed: '已结案', cancelled: '已取消'
};

const FLOW = {
  draft: ['tech'], tech: ['finance'], finance: ['assigned'], assigned: ['production'],
  production: ['instock'], instock: ['shipped'], shipped: ['closed']
};

/** 正向链路：反审只能往前面的状态退，不能跨过 draft，也不能退已发货/已结案 */
const CHAIN = ['draft', 'tech', 'finance', 'assigned', 'production', 'instock', 'shipped', 'closed'];

const TRANSITION_ROLES = {
  tech: ['admin', 'sales', 'tech'], finance: ['admin', 'sales', 'tech'], assigned: ['admin', 'finance'],
  production: ['admin', 'sales', 'production'], instock: ['admin', 'production', 'warehouse'],
  shipped: ['admin', 'warehouse'], closed: ['admin', 'sales'], cancelled: ['admin', 'sales']
};

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
function check(orderId, { to, force, user, write = true } = {}) {
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
    const tp = db.prepare("SELECT id FROM tech_packs WHERE order_id = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 1").get(id);
    if (!tp) throw bad('开发单尚未确认，无法通过「技术确认」；请先补全并确认开发单');
    if (order.type === 'custom') {
      const flow = db.prepare('SELECT * FROM pattern_flows WHERE tech_pack_id = ?').get(tp.id);
      if (!flow) throw bad('定制订单必须走打版流程：该开发单还没有打版流程记录，请到「打版流程」发起');
      if (flow.status !== 'done') {
        const left = db.prepare('SELECT stage FROM pattern_stages WHERE flow_id = ? AND status != ?').all(flow.id, 'done');
        const names = left.map((r) => STAGE_LABELS[r.stage] || r.stage).join('、');
        throw bad(`定制订单的打版流程尚未完成，剩余：${names || '收尾确认'}；请到「打版流程」完成后再做技术确认`);
      }
    }
    // 走过样衣封样的订单：最新版本必须「客户已确认 + 总部技术已批准」双确认
    const gate = sealGate(id);
    if (!gate.ok) throw bad(gate.message);
  }

  // ---------- 门槛 2：进入已分单 ----------
  if (to === 'assigned') {
    const cs = db.prepare("SELECT 1 AS x FROM cost_sheets WHERE order_id = ? AND status = 'approved' LIMIT 1").get(id);
    if (!cs) throw bad('财务尚未审核通过，无法「分单」；请先录入成本并完成财务审核');
  }

  // ---------- 门槛 3：结案前应收要清 ----------
  if (to === 'closed' && !force) {
    const ar = db.prepare('SELECT * FROM ar_invoices WHERE order_id = ? AND status != ?').get(id, 'void');
    if (ar) {
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

  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(to, t, id);

  // 进入生产：自动初始化 13 道工序
  if (to === 'production') ensureNodes(id);

  // 发货：开应收 + 成本对象归集（都幂等；失败不影响发货本身）
  if (to === 'shipped') {
    try { openARForOrder(id, who); } catch (e) { /* 开票失败不影响发货 */ }
    try {
      const obj = ensureCostObject(id);
      if (obj) { collectAuto(obj); syncSold(obj.id, who); }
    } catch (e) { /* 成本归集失败不影响发货 */ }
  }

  db.prepare('INSERT INTO order_logs (order_id, from_status, to_status, operator, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, cur, to, who, finalNote, t);

  // 客户商城站内消息（客户有账号才推）
  try { notifyOrderStatus(id, to, finalNote); } catch (e) { /* 消息失败不影响主流程 */ }

  return { id, from: cur, to };
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
  transition,
  batchTransition,
  batchNo
};
