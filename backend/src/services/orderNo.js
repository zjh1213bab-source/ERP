/**
 * 订单号（业务手填）
 * ========================================================================
 * 从「系统自动生成」改成「业务手填」，看起来只是少了一行代码，
 * 实际上把订单号从**系统内部编号**变成了**业务主键**。这两者的差别是全部麻烦的来源：
 *
 *   自动生成时：格式由代码保证、永不自相矛盾、没人会填错。
 *   业务手填时：客户可能给号、平台单可能复用、隔天可能要求改号、打错一位是常态。
 *
 * 所以这一个文件处理四件事，少一件就会在别的环节炸：
 *
 * ## 1. 必填且必须唯一（不分大小写）
 *
 * `orders.order_no` 本来就有 `UNIQUE NOT NULL`，数据库兜得住「重号」。
 * 但数据库**分大小写**：`so001` 与 `SO001` 是两条合法记录，而人眼里是同一个号。
 * 所以唯一性判断在服务层用 `UPPER()` 比较 —— 宁可拦住，也不要出现
 * 「单号看着一样、打开是两张单」。
 *
 * ## 2. 不强制格式，但要挡住明显不是单号的东西
 *
 * 业务填的是**他们自己的编号**（客户 PO、平台单号、老系统流水号）。
 * 强制 `SO+日期+序号` 等于把「手填」做成「按系统格式手填」，那不如不改。
 * 所以只拦：空白、纯符号、超长、控制字符、换行。
 * 格式建议走 placeholder 提示，不做硬校验。
 *
 * ## 3. 改号必须级联同步下游（这是最容易出事的一处）
 *
 * 订单号被 18 张表冗余引用（生产任务、排产、裁片外发、领料、计件工资、售后……）。
 * 这些冗余是有意的：打生产单、报工、算工钱时不要一路 JOIN 回订单表。
 * 但代价是——**改了订单号不同步，生产单上印的还是旧号**，
 * 车间按单号找货就会找不到，而系统里显示一切正常。
 *
 * 所以改号不是一句 UPDATE，而是：
 *   预览影响面（`previewRename`）→ 按 `order_id` 逐表同步 → 留痕 → 返回改了哪些表几行。
 * 有 `order_id` 的按 id 改（精准）；只有 `order_no` 的（`schedule_changes`）按旧号改。
 *
 * ## 4. 改号要留痕、要理由
 *
 * 改完之后，三个月后有人问「这张单原来是什么号」，必须答得出来。
 * 所以写 `order_no_logs`：旧号、新号、谁改的、为什么、当时连带改了多少行。
 */
const { db, now } = require('../db');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};

/**
 * 订单号被冗余引用的地方（**显式登记，不自动探测**）
 *
 * 为什么不用「扫所有含 order_no 的表」：那样某天有人建了一张
 * `order_no_blacklist` 之类的表，也会被卷进来改。登记制的代价是新增表要记得加一行，
 * 但漏加会在预览里看得见（订单号还是旧值），而误改是看不见的。
 *
 * `byId`：有 `order_id`，按 id 精准更新。`byNo`：只有 `order_no`，按旧号更新。
 */
const CHAINS = [
  { table: 'cost_objects', byId: true, label: '成本对象' },
  { table: 'commitments', byId: true, label: '订单承诺' },
  { table: 'material_requirements', byId: true, label: '物料需求' },
  { table: 'cut_orders', byId: true, label: '裁床单' },
  { table: 'cut_dispatches', byId: true, label: '裁片外发' },
  { table: 'first_articles', byId: true, label: '首件确认' },
  { table: 'rework_orders', byId: true, label: '返修单' },
  { table: 'production_closures', byId: true, label: '生产结案' },
  { table: 'schedule_tasks', byId: true, label: '排产任务' },
  { table: 'schedule_conflicts', byId: true, label: '排产冲突' },
  { table: 'schedule_changes', byId: false, label: '排产变更' },
  { table: 'material_issues', byId: true, label: '领料单' },
  { table: 'material_returns', byId: true, label: '退料单' },
  { table: 'piece_wage_items', byId: true, label: '计件明细' },
  { table: 'cost_pool_allocations', byId: true, label: '费用池分摊' },
  { table: 'kpi_items', byId: true, label: '绩效指标项' },
  { table: 'stock_returns', byId: true, label: '退货单' },
  { table: 'after_sale_tickets', byId: true, label: '售后工单' },
  { table: 'purchase_orders', byId: true, label: '采购订单' }
];

const MAX_LEN = 50;
const MIN_LEN = 2;

/**
 * 规范化：只清掉「看不见但会咬人」的字符，不改业务写的内容
 *
 * - 首尾空白（粘贴常带）
 * - 全角空格 → 半角（中文输入法下极常见，肉眼分辨不出，但 `=` 比不中）
 * - 零宽字符（从网页/Excel 复制带进来，最阴）
 * - 换行 / 制表符（多行粘贴）
 */
function normalize(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw)
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 校验并返回规范值
 *
 * 只在**明显不是单号**时拒绝；不判断业务格式（客户 PO、平台单号、老系统流水都合法）。
 */
function validate(raw, { required = true } = {}) {
  const value = normalize(raw);
  if (!value) {
    if (required) throw bad('订单号必填 —— 业务手工填写的订单号是全流程的锚点，不能留空');
    return '';
  }
  if (value.length < MIN_LEN) throw bad(`订单号至少 ${MIN_LEN} 个字符（当前「${value}」）`);
  if (value.length > MAX_LEN) throw bad(`订单号最多 ${MAX_LEN} 个字符（当前 ${value.length} 个）`);
  // 纯符号不行：`----`、`////` 这种看着像占位，实际会让下游按号检索全部失效
  if (!/[0-9A-Za-z\u4e00-\u9fa5]/.test(value)) {
    throw bad('订单号里至少要有数字或字母 —— 纯符号无法检索，也不能当单号用');
  }
  // 控制字符（除已清掉的换行制表）
  if (/[\x00-\x1f\x7f]/.test(value)) throw bad('订单号不能包含控制字符');
  return value;
}

/** 该号是否已被占用（不分大小写；改号时排除自己） */
function findConflict(orderNo, excludeId = null) {
  const sql = excludeId
    ? 'SELECT id, order_no, customer_id, status FROM orders WHERE UPPER(order_no) = UPPER(?) AND id <> ?'
    : 'SELECT id, order_no, customer_id, status FROM orders WHERE UPPER(order_no) = UPPER(?)';
  return excludeId ? db.prepare(sql).get(orderNo, excludeId) : db.prepare(sql).get(orderNo);
}

/** 完整校验（含唯一性），返回可直接写库的值 */
function check(raw, excludeId = null) {
  const value = validate(raw);
  const dup = findConflict(value, excludeId);
  if (dup) {
    const cus = dup.customer_id
      ? (db.prepare('SELECT name FROM customers WHERE id = ?').get(dup.customer_id) || {}).name
      : null;
    throw bad(
      `订单号「${value}」已被占用：${dup.order_no}（#${dup.id}`
      + (cus ? ` · ${cus}` : '')
      + ` · ${dup.status}）。订单号必须唯一，否则生产单与领料单会对不上`,
      409
    );
  }
  return value;
}

/**
 * 预览改号影响面
 *
 * 改号前先算清「会连带改哪些表、多少行」—— 直接改完再发现改了 300 行计件明细，
 * 人是不敢按确认的；先看清楚才敢。
 */
function previewRename(orderId, newRaw) {
  const order = db.prepare('SELECT id, order_no, status FROM orders WHERE id = ?').get(orderId);
  if (!order) throw bad('订单不存在', 404);
  const next = validate(newRaw);
  const dup = findConflict(next, orderId);

  const impacts = [];
  let total = 0;
  CHAINS.forEach((c) => {
    let rows = 0;
    try {
      rows = c.byId
        ? db.prepare(`SELECT COUNT(*) c FROM ${c.table} WHERE order_id = ? AND COALESCE(order_no,'') <> ?`).get(orderId, next).c
        : db.prepare(`SELECT COUNT(*) c FROM ${c.table} WHERE order_no = ?`).get(order.order_no).c;
    } catch (e) {
      rows = 0; // 表不存在（老库）就跳过，不让整次预览失败
    }
    if (rows) {
      impacts.push({ table: c.table, label: c.label, rows, by: c.byId ? 'order_id' : 'order_no' });
      total += rows;
    }
  });

  return {
    order_id: order.id,
    old_no: order.order_no,
    new_no: next,
    changed: normalize(next) !== normalize(order.order_no),
    conflict: dup ? { id: dup.id, order_no: dup.order_no, status: dup.status } : null,
    impacts,
    total_rows: total
  };
}

/**
 * 执行改号：同步下游 + 留痕
 *
 * 顺序很重要：**先同步下游，最后改订单自己**。
 * 反过来的话，中途失败会留下「订单已是新号、下游还是旧号」——
 * 而这种不一致没有任何界面能提示出来。
 */
function rename(orderId, newRaw, b = {}, actor) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw bad('订单不存在', 404);

  const pv = previewRename(orderId, newRaw);
  if (!pv.changed) throw bad(`新订单号与当前一致（${order.order_no}），无需修改`);
  if (pv.conflict) throw bad(`订单号「${pv.new_no}」已被 #${pv.conflict.id} 占用，不能改`, 409);

  const reason = String(b.reason || '').trim();
  if (reason.length < 6) throw bad('改订单号必须写原因（至少 6 字）—— 下游单据会跟着变，事后要说得清');

  const t = now();
  const done = [];

  db.exec('BEGIN');
  try {
    CHAINS.forEach((c) => {
      try {
        const info = c.byId
          ? db.prepare(`UPDATE ${c.table} SET order_no = ? WHERE order_id = ?`).run(pv.new_no, orderId)
          : db.prepare(`UPDATE ${c.table} SET order_no = ? WHERE order_no = ?`).run(pv.new_no, order.order_no);
        if (info.changes) done.push({ table: c.table, label: c.label, rows: info.changes });
      } catch (e) {
        // 老库里可能没有这张表：跳过，但不能吞掉别的错误
        if (!/no such table/i.test(e.message)) throw e;
      }
    });

    db.prepare('UPDATE orders SET order_no = ?, updated_at = ? WHERE id = ?').run(pv.new_no, t, orderId);

    db.prepare(`INSERT INTO order_no_logs (order_id, old_no, new_no, reason, synced_rows, synced_tables, operator, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      orderId, order.order_no, pv.new_no, reason, done.reduce((a, x) => a + x.rows, 0),
      JSON.stringify(done), actor || 'system', t
    );

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    // 数据库不认这个新号（唯一索引兜底）时，给一句人话
    if (/UNIQUE/i.test(e.message)) throw bad(`订单号「${pv.new_no}」已存在（数据库唯一约束）`, 409);
    throw e;
  }

  return {
    id: orderId,
    old_no: order.order_no,
    new_no: pv.new_no,
    synced: done,
    total_rows: done.reduce((a, x) => a + x.rows, 0),
    reason
  };
}

/** 改号历史（按订单） */
function renameLogs(orderId) {
  return db.prepare('SELECT * FROM order_no_logs WHERE order_id = ? ORDER BY id DESC').all(orderId).map((r) => ({
    ...r,
    synced: (() => { try { return JSON.parse(r.synced_tables || '[]'); } catch (e) { return []; } })()
  }));
}

/**
 * 该订单号被谁挂着（反查）
 *
 * 采购、生产、领料都要能回答「这个号现在挂了几张单」。手填之后尤为重要：
 * 业务敲错一位，可能挂到别人订单上，这里能立刻看出来。
 */
function trace(orderNo) {
  const no = normalize(orderNo);
  if (!no) throw bad('请输入订单号');
  const order = db.prepare('SELECT id, order_no, status, customer_id, style_name, order_date FROM orders WHERE UPPER(order_no) = UPPER(?)').get(no);
  const rows = [];
  CHAINS.forEach((c) => {
    try {
      const n = c.byId
        ? (order ? db.prepare(`SELECT COUNT(*) c FROM ${c.table} WHERE order_id = ?`).get(order.id).c : 0)
        : db.prepare(`SELECT COUNT(*) c FROM ${c.table} WHERE UPPER(order_no) = UPPER(?)`).get(no).c;
      if (n) rows.push({ table: c.table, label: c.label, rows: n });
    } catch (e) { /* 无此表 */ }
  });
  return {
    order_no: order ? order.order_no : no,
    found: !!order,
    order: order || null,
    chains: rows,
    total: rows.reduce((a, x) => a + x.rows, 0)
  };
}

module.exports = {
  CHAINS, normalize, validate, check, findConflict, previewRename, rename, renameLogs, trace
};
