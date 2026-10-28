/**
 * 应收催收任务
 * ============================================================
 * 解决的问题：应收逾期 278 万，系统里**没有「谁去催、催了几次、客户答应哪天付」**。
 * 业务员在微信里催，财务看不见；客户说「下周付」，下周没人记得；
 * 真付了，也没人把催收收尾。上个月的对账单只解决了「账说不清」，
 * 解决不了「没人跟」。
 *
 * ## 六条规则（每条都对应一种催收失败的真实情形）
 *
 * 1. **一个客户一张任务**，不按发票派单
 *    业务员跟客户谈的是「你们这几张票一起结」，按发票派单会让客户一周接到 5 个电话。
 *
 * 2. **欠多少由发票实时算**
 *    `remaining` 每次读取从未付发票重算。存快照就会「催收说欠 80 万、账上只欠 20 万」，
 *    业务员一看数不对就再也不信系统了。
 *
 * 3. **集团内部客户不生成催收任务**
 *    `intercompany_parties` 里登记过的内部往来（比如 Tiaose USA LLC 的 80 万），
 *    给自家分公司发催收单是笑话，而且会把逾期总额虚高，让外部账的占比失真。
 *    **按表判断，不按名字猜**（名字里有没有「集团」两个字不可靠）。
 *
 * 4. **负责人三级解析，解析不到就标「待指派」**
 *    客户档案 owner → 订单跟单员（匹配 users.name）→ 无。
 *    绝不按「谁最近碰过这单」瞎分 —— 分错人的后果是「有人以为别人在催」。
 *    没人的任务落在财务待办里，至少不会消失。
 *
 * 5. **承诺还款必须「日期 + 金额」成对**
 *    只说「下周付」不写金额，等于没承诺，事后无法验证他说的是真是假。
 *
 * 6. **回款结清自动关闭**
 *    钱收到了任务就该收尾。这条靠 `syncPaidStatus` 里回调实现 ——
 *    所有应收回款都走那一个口子，挂在那里才不会漏。
 *
 * ## 状态机
 *   open      待跟进（刚生成）
 *   following 已联系（联系过但客户没给承诺）
 *   promised  客户已承诺（有 promise_date + promise_amount）
 *   escalated 承诺跳票（过了承诺日还没收到钱，升级给财务/老板）
 *   closed    已结清 / 核销坏账 / 转法务
 */
const { db, now } = require('../db');
const { nextNo } = require('../utils/docNo');
const S = require('./invoiceStatus');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) =>
  Math.round((Date.parse(String(a).slice(0, 10) + 'T00:00:00') - Date.parse(String(b).slice(0, 10) + 'T00:00:00')) / 86400000);

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

const STATUS_LABEL = {
  open: '待跟进',
  following: '已联系',
  promised: '客户承诺',
  escalated: '承诺跳票',
  closed: '已结案'
};

const CHANNEL_LABEL = {
  phone: '电话', wechat: '微信', email: '邮件', visit: '上门', letter: '函件', other: '其他'
};
const RESULT_LABEL = {
  no_answer: '未接通', promised: '答应付款', refused: '拒付', partial: '部分付款',
  dispute: '有争议', other: '其他'
};
const CLOSE_REASON_LABEL = {
  paid: '已收回', bad_debt: '核销坏账', legal: '转法务', offset: '内部/协议对冲', other: '其他'
};

/** 逾期天数分档：催收力度按档升 */
function levelOf(days) {
  if (days >= 91) return 'D4';
  if (days >= 61) return 'D3';
  if (days >= 31) return 'D2';
  return 'D1';
}
const LEVEL_LABEL = { D1: '1-30 天', D2: '31-60 天', D3: '61-90 天', D4: '90 天以上' };

/* ------------------------------------------------------------------ *
 * 集团内部客户：按 intercompany_parties 判断，不按名字猜
 * ------------------------------------------------------------------ */
function internalCustomerIds() {
  try {
    return new Set(
      db
        .prepare(
          "SELECT ref_id FROM intercompany_parties WHERE ref_type = 'customer' AND IFNULL(status,'active') = 'active' AND ref_id IS NOT NULL"
        )
        .all()
        .map((x) => Number(x.ref_id))
    );
  } catch (e) {
    // 表不存在时不能把内部客户当外部催收，宁可全部当外部并提示
    return new Set();
  }
}

/* ------------------------------------------------------------------ *
 * 负责人解析三级
 * ------------------------------------------------------------------ */
/**
 * @returns {{user_id:number|null, username:string|null, name:string|null, source:string}}
 *   source: profile 档案 / order 订单跟单员 / none 待指派
 */
function resolveOwner(customerId) {
  const c = db
    .prepare('SELECT id, name, owner_user_id, owner_name FROM customers WHERE id = ?')
    .get(customerId);
  if (!c) return { user_id: null, username: null, name: null, source: 'none' };

  // 1) 档案里绑了账号，最准
  if (c.owner_user_id) {
    const u = db.prepare('SELECT id, username, name FROM users WHERE id = ?').get(c.owner_user_id);
    if (u) return { user_id: u.id, username: u.username, name: u.name, source: 'profile' };
  }
  // 2) 档案里只有名字 → 到账号表按姓名精确匹配（不做模糊，模糊会分错人）
  if (c.owner_name) {
    const u = db.prepare('SELECT id, username, name FROM users WHERE name = ? LIMIT 1').get(c.owner_name);
    if (u) return { user_id: u.id, username: u.username, name: u.name, source: 'profile' };
    // 有名字但没账号：仍然记下来（是个人，只是没系统账号），别丢掉
    return { user_id: null, username: null, name: c.owner_name, source: 'profile' };
  }
  // 3) 回退到该客户最近一张有跟单员的订单
  const o = db
    .prepare(
      `SELECT manager FROM orders
        WHERE customer_id = ? AND manager IS NOT NULL AND manager <> ''
        ORDER BY id DESC LIMIT 1`
    )
    .get(customerId);
  if (o && o.manager) {
    const u = db.prepare('SELECT id, username, name FROM users WHERE name = ? LIMIT 1').get(o.manager);
    if (u) return { user_id: u.id, username: u.username, name: u.name, source: 'order' };
    return { user_id: null, username: null, name: o.manager, source: 'order' };
  }
  // 4) 都没有 → 待指派（落到财务）
  return { user_id: null, username: null, name: null, source: 'none' };
}

/* ------------------------------------------------------------------ *
 * 逾期台账（还没生成任务之前先看清楚）
 * ------------------------------------------------------------------ */
/**
 * 逾期客户清单
 * 每行包含：逾期金额 / 最长逾期 / 是否集团内部 / 是否已有任务 / 负责人
 */
function board(q = {}) {
  const internal = internalCustomerIds();
  const rows = db
    .prepare(
      `SELECT customer_id, IFNULL(customer_name,'（无客户名）') AS customer_name,
              COUNT(*) AS invoice_count,
              SUM(amount - COALESCE(paid_amount,0)) AS overdue_amount,
              MIN(due_date) AS oldest_due
         FROM ar_invoices
        WHERE ${S.OPEN_SQL}
          AND due_date IS NOT NULL AND due_date < ?
          AND customer_id IS NOT NULL
        GROUP BY customer_id
        ORDER BY overdue_amount DESC`
    )
    .all(today());

  const out = rows.map((r) => {
    const days = Math.max(0, daysBetween(today(), r.oldest_due));
    const task = db
      .prepare(
        "SELECT * FROM collection_tasks WHERE customer_id = ? AND status <> 'closed' ORDER BY id DESC LIMIT 1"
      )
      .get(r.customer_id);
    const owner = resolveOwner(r.customer_id);
    return {
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      invoice_count: Number(r.invoice_count),
      overdue_amount: r2(r.overdue_amount),
      oldest_due: r.oldest_due,
      max_overdue_days: days,
      level: levelOf(days),
      level_label: LEVEL_LABEL[levelOf(days)],
      // 集团内部：不催，但要在台账上看得见（否则会以为漏了）
      is_internal: internal.has(Number(r.customer_id)),
      has_task: !!task,
      task: task
        ? {
            id: task.id,
            task_no: task.task_no,
            status: task.status,
            owner_name: task.owner_name,
            promise_date: task.promise_date
          }
        : null,
      owner,
      can_generate: !internal.has(Number(r.customer_id)) && !task
    };
  });

  const external = out.filter((x) => !x.is_internal);
  const withTask = external.filter((x) => x.has_task);
  return {
    rows: out,
    summary: {
      customers: out.length,
      internal_count: out.filter((x) => x.is_internal).length,
      internal_amount: r2(out.filter((x) => x.is_internal).reduce((a, x) => a + x.overdue_amount, 0)),
      // 外部逾期才是真要催的
      external_count: external.length,
      external_amount: r2(external.reduce((a, x) => a + x.overdue_amount, 0)),
      tasked_count: withTask.length,
      untasked_count: external.filter((x) => !x.can_generate ? false : true).filter((x) => !x.has_task).length,
      no_owner_count: external.filter((x) => !x.has_task && x.owner.source === 'none').length
    }
  };
}

/* ------------------------------------------------------------------ *
 * 生成任务
 * ------------------------------------------------------------------ */
/**
 * 给逾期客户生成催收任务
 *
 * 幂等：已有未结任务的客户**跳过**（只刷新，不重复建）。
 * 这样定时跑也不会一天堆一堆重复单。
 *
 * @param {{all?:boolean, customer_ids?:number[], min_overdue_days?:number}} opts
 */
function generate(opts = {}, user) {
  const bd = board({});
  const minDays = Math.max(1, Number(opts.min_overdue_days) || 1);
  const internal = internalCustomerIds();

  let targets;
  if (Array.isArray(opts.customer_ids) && opts.customer_ids.length) {
    const want = new Set(opts.customer_ids.map(Number));
    targets = bd.rows.filter((x) => want.has(Number(x.customer_id)));
  } else {
    targets = bd.rows;
  }

  const created = [];
  const skipped = [];
  const t = now();

  targets.forEach((x) => {
    if (x.is_internal) {
      skipped.push({ customer_id: x.customer_id, customer_name: x.customer_name, reason: '集团内部往来，不催收' });
      return;
    }
    if (x.max_overdue_days < minDays) {
      skipped.push({ customer_id: x.customer_id, customer_name: x.customer_name, reason: `逾期不足 ${minDays} 天` });
      return;
    }
    if (x.has_task) {
      skipped.push({ customer_id: x.customer_id, customer_name: x.customer_name, reason: `已有任务 ${x.task.task_no}` });
      return;
    }

    const invs = db
      .prepare(
        `SELECT * FROM ar_invoices
          WHERE ${S.OPEN_SQL} AND customer_id = ? AND due_date IS NOT NULL AND due_date < ?
          ORDER BY due_date`
      )
      .all(x.customer_id, today());
    if (!invs.length) {
      skipped.push({ customer_id: x.customer_id, customer_name: x.customer_name, reason: '没有逾期发票' });
      return;
    }

    const owner = resolveOwner(x.customer_id);
    db.exec('BEGIN');
    try {
      const taskNo = nextNo('CS', 'collection_tasks', 'task_no');
      const info = db
        .prepare(
          `INSERT INTO collection_tasks
             (task_no, customer_id, customer_name, owner_user_id, owner_username, owner_name, owner_source,
              overdue_amount, remaining, invoice_count, max_overdue_days, oldest_due, level, status,
              next_follow_at, follow_count, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?, 0, ?, ?, ?)`
        )
        .run(
          taskNo, x.customer_id, x.customer_name, owner.user_id, owner.username, owner.name, owner.source,
          r2(x.overdue_amount), r2(x.overdue_amount), invs.length, x.max_overdue_days, x.oldest_due,
          levelOf(x.max_overdue_days), today(), user ? user.username : null, t, t
        );
      const tid = Number(info.lastInsertRowid);
      const ins = db.prepare(
        `INSERT INTO collection_task_items (task_id, invoice_id, bill_no, due_date, open_at_create, open_now, created_at)
         VALUES (?,?,?,?,?,?,?)`
      );
      invs.forEach((inv) => {
        const open = r2(Number(inv.amount) - (Number(inv.paid_amount) || 0));
        ins.run(tid, inv.id, inv.bill_no, inv.due_date, open, open, t);
      });
      db.exec('COMMIT');
      created.push({ id: tid, task_no: taskNo, customer_id: x.customer_id, customer_name: x.customer_name, amount: r2(x.overdue_amount), owner: owner.name || '待指派' });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  return {
    created,
    skipped,
    summary: { created: created.length, skipped: skipped.length, amount: r2(created.reduce((a, x) => a + x.amount, 0)) }
  };
}

/* ------------------------------------------------------------------ *
 * 读取时重算：欠多少、结清没、承诺跳票没
 * ------------------------------------------------------------------ */

/**
 * 刷新一张任务（不写库，返回计算结果）
 *
 * 这里**每次都从发票重算**，不用 `remaining` 列的历史值 ——
 * 那一列只是「上次刷新时的数」，用于展示趋势，不参与判定。
 */
function computeTask(task) {
  const items = db
    .prepare(
      `SELECT i.*, inv.amount AS invoice_amount, inv.paid_amount AS invoice_paid, inv.status AS invoice_status
         FROM collection_task_items i
         LEFT JOIN ar_invoices inv ON inv.id = i.invoice_id
        WHERE i.task_id = ?
        ORDER BY i.due_date`
    )
    .all(task.id)
    .map((x) => {
      const openNow =
        x.invoice_amount === null
          ? 0
          : r2(Math.max(0, Number(x.invoice_amount) - (Number(x.invoice_paid) || 0)));
      return { ...x, open_now_calc: openNow, settled: openNow <= 0.005 || x.invoice_status === 'void' };
    });

  const remaining = r2(items.reduce((a, x) => a + (x.settled ? 0 : x.open_now_calc), 0));
  const settledCount = items.filter((x) => x.settled).length;
  const todayStr = today();
  // 「承诺跳票」是**事实**，不是状态的附属品：
  // 任务是 promised 时当然算跳票；已经升级成 escalated 之后，这个标记还得继续亮着，
  // 否则页面在升级那一刻反而看不出「为什么升级了」（踩过）。
  const promiseBroken =
    !!task.promise_date && task.promise_date < todayStr && remaining > 0.005 && task.status !== 'closed';

  // 承诺到期还差几天（给页面提示用）
  const promiseOverdueDays =
    task.promise_date && promiseBroken ? Math.max(0, daysBetween(todayStr, task.promise_date)) : 0;

  return { items, remaining, settledCount, promiseBroken, promiseOverdueDays, fullySettled: remaining <= 0.005 };
}

/** 把计算结果落到任务上（结清自动关闭、承诺跳票自动升级） */
function syncTask(task) {
  const c = computeTask(task);
  const t = now();
  let status = task.status;
  let closedReason = task.closed_reason;
  let closedNote = task.closed_note;

  if (c.fullySettled && task.status !== 'closed') {
    status = 'closed';
    closedReason = 'paid';
    closedNote = closedNote || `全部回款结清（系统自动结案，${c.settledCount} 张发票）`;
  } else if (c.promiseBroken && task.status === 'promised') {
    status = 'escalated';
  }

  if (status !== task.status) {
    db.prepare(
      `UPDATE collection_tasks
          SET status=?, remaining=?, invoice_count=?,
              closed_reason=?, closed_note=?,
              closed_at=CASE WHEN ?='closed' THEN ? ELSE closed_at END,
              closed_by=CASE WHEN ?='closed' THEN IFNULL(closed_by,'system') ELSE closed_by END,
              updated_at=?
        WHERE id=?`
    ).run(status, c.remaining, c.items.length, closedReason, closedNote, status, t, status, t, task.id);
    return { ...task, status, remaining: c.remaining, ...c };
  }

  db.prepare('UPDATE collection_tasks SET remaining=?, invoice_count=?, updated_at=? WHERE id=?').run(
    c.remaining, c.items.length, t, task.id
  );
  return { ...task, remaining: c.remaining, ...c };
}

/**
 * 刷新所有未结任务
 * 便宜：只处理未结的任务，且只做一次重算。页面加载时调一次足够。
 */
function refreshAll() {
  const tasks = db.prepare("SELECT * FROM collection_tasks WHERE status <> 'closed'").all();
  let closed = 0;
  let escalated = 0;
  tasks.forEach((task) => {
    const before = task.status;
    const after = syncTask(task);
    if (after.status === 'closed' && before !== 'closed') closed++;
    if (after.status === 'escalated' && before !== 'escalated') escalated++;
  });
  return { scanned: tasks.length, closed, escalated };
}

/**
 * 某客户的钱被收了 → 立刻重算他的任务（不刷新全表）
 *
 * 由 `syncPaidStatus` 在每次应收核销后调用。**所有应收回款都走那一个口子**，
 * 所以挂在那里才不会漏（这是上一轮把状态回写抽成公共函数带来的红利）。
 */
function onInvoiceSettled(kind, invoiceId) {
  if (kind !== 'ar') return null;
  const item = db
    .prepare('SELECT DISTINCT task_id FROM collection_task_items WHERE invoice_id = ?')
    .all(invoiceId);
  if (!item.length) return null;
  let closed = 0;
  item.forEach((x) => {
    const task = db.prepare('SELECT * FROM collection_tasks WHERE id = ?').get(x.task_id);
    if (task && task.status !== 'closed') {
      const after = syncTask(task);
      if (after.status === 'closed') closed++;
    }
  });
  return { tasks: item.length, closed };
}

/* ------------------------------------------------------------------ *
 * 列表 / 详情
 * ------------------------------------------------------------------ */

function list(q = {}) {
  // 每次列表先跑一次轻量刷新：保证「钱已收但单还挂着」不会超过一次页面加载
  try { refreshAll(); } catch (e) { /* 刷新失败不能影响读取 */ }

  const where = [];
  const params = [];
  if (q.status) {
    const arr = String(q.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (arr.length) {
      where.push(`status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
  } else {
    where.push("status <> 'closed'");
  }
  if (q.level) {
    where.push('level = ?');
    params.push(q.level);
  }
  if (q.owner) {
    // 销售只看自己的单：优先按账号，其次按姓名（有些单只解析出名字、没绑账号）
    where.push('(owner_username = ? OR (owner_username IS NULL AND owner_name = ?))');
    params.push(q.owner, q.owner_name || q.owner);
  }
  if (q.no_owner === '1') {
    where.push("(owner_username IS NULL AND owner_name IS NULL)");
  }
  if (q.q) {
    where.push("(task_no LIKE ? OR IFNULL(customer_name,'') LIKE ? OR IFNULL(owner_name,'') LIKE ?)");
    const k = `%${q.q}%`;
    params.push(k, k, k);
  }

  const rows = db
    .prepare(
      `SELECT * FROM collection_tasks
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY
          CASE status WHEN 'escalated' THEN 0 WHEN 'promised' THEN 1 WHEN 'following' THEN 2 WHEN 'open' THEN 3 ELSE 4 END,
          remaining DESC, id DESC
        LIMIT 300`
    )
    .all(...params)
    .map((t) => {
      const todayStr = today();
      const promiseLate = t.promise_date && t.promise_date < todayStr && t.status !== 'closed';
      return {
        ...t,
        status_label: STATUS_LABEL[t.status] || t.status,
        level_label: LEVEL_LABEL[t.level] || t.level,
        // 催收进度：降了多少
        recovered: r2(Math.max(0, Number(t.overdue_amount) - Number(t.remaining))),
        recover_rate: Number(t.overdue_amount) > 0
          ? Math.round((Math.max(0, Number(t.overdue_amount) - Number(t.remaining)) / Number(t.overdue_amount)) * 100)
          : 0,
        promise_late: !!promiseLate,
        promise_late_days: promiseLate ? Math.max(0, daysBetween(todayStr, t.promise_date)) : 0
      };
    });

  return { rows, summary: stats() };
}

function stats() {
  const all = db.prepare('SELECT status, COUNT(*) n, COALESCE(SUM(remaining),0) amt FROM collection_tasks GROUP BY status').all();
  const g = (s) => {
    const x = all.find((r) => r.status === s);
    return { count: x ? Number(x.n) : 0, amount: x ? r2(x.amt) : 0 };
  };
  const openTasks = db.prepare("SELECT * FROM collection_tasks WHERE status <> 'closed'").all();
  const noOwner = openTasks.filter((t) => !t.owner_username && !t.owner_name).length;
  const broken = db
    .prepare(
      "SELECT COUNT(*) c, COALESCE(SUM(remaining),0) amt FROM collection_tasks WHERE status = 'escalated'"
    )
    .get();
  return {
    open: g('open'),
    following: g('following'),
    promised: g('promised'),
    escalated: g('escalated'),
    closed: g('closed'),
    active_count: openTasks.length,
    active_amount: r2(openTasks.reduce((a, t) => a + (Number(t.remaining) || 0), 0)),
    no_owner_count: noOwner,
    // 承诺跳票：催收真正失败的地方，一定要单独计数
    broken_count: Number(broken.c),
    broken_amount: r2(broken.amt)
  };
}

function detail(id) {
  const task = db.prepare('SELECT * FROM collection_tasks WHERE id = ?').get(id);
  if (!task) throw bad('催收任务不存在', 404);
  const synced = syncTask(task);
  const fresh = db.prepare('SELECT * FROM collection_tasks WHERE id = ?').get(id);
  const logs = db
    .prepare('SELECT * FROM collection_logs WHERE task_id = ? ORDER BY id DESC')
    .all(id)
    .map((x) => ({
      ...x,
      channel_label: CHANNEL_LABEL[x.channel] || x.channel || '—',
      result_label: RESULT_LABEL[x.result] || x.result || '—'
    }));
  return {
    ...fresh,
    status_label: STATUS_LABEL[fresh.status] || fresh.status,
    level_label: LEVEL_LABEL[fresh.level] || fresh.level,
    closed_reason_label: fresh.closed_reason ? CLOSE_REASON_LABEL[fresh.closed_reason] || fresh.closed_reason : null,
    live: {
      remaining: synced.remaining,
      settled_count: synced.settledCount,
      invoice_count: synced.items.length,
      fully_settled: synced.fullySettled,
      promise_broken: !!synced.promiseBroken,
      promise_overdue_days: synced.promiseOverdueDays
    },
    items: synced.items.map((x) => ({
      id: x.id,
      invoice_id: x.invoice_id,
      bill_no: x.bill_no,
      due_date: x.due_date,
      open_at_create: r2(x.open_at_create),
      open_now: x.open_now_calc,
      settled: x.settled,
      invoice_status: x.invoice_status,
      overdue_days: x.due_date ? Math.max(0, daysBetween(today(), x.due_date)) : 0
    })),
    logs
  };
}

/* ------------------------------------------------------------------ *
 * 跟进记录
 * ------------------------------------------------------------------ */

/**
 * 记一次跟进
 *
 * 这条是催收的**唯一产出**，所以校验最严：
 *   - 答应付款（promised）必须同时给承诺日期和金额
 *   - 承诺日期不能是过去（那不是承诺，是记录已经违约）
 *   - 拒付/有争议必须写说明（否则下次接手的人不知道吵的是什么）
 */
function log(id, payload, user) {
  const b = payload || {};
  const task = db.prepare('SELECT * FROM collection_tasks WHERE id = ?').get(id);
  if (!task) throw bad('催收任务不存在', 404);
  if (task.status === 'closed') throw bad('任务已结案，不能再记跟进（要重启请新建任务）');

  const channel = String(b.channel || 'phone');
  if (!CHANNEL_LABEL[channel]) throw bad('跟进渠道不合法');
  const result = String(b.result || 'other');
  if (!RESULT_LABEL[result]) throw bad('跟进结果不合法');

  let promiseDate = null;
  let promiseAmount = null;
  if (result === 'promised') {
    promiseDate = String(b.promise_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(promiseDate)) {
      throw bad('「答应付款」必须填承诺日期 —— 只说「下周付」没法验证，下周就忘了');
    }
    if (promiseDate < today()) throw bad('承诺日期不能早于今天（那不是在承诺，是在记录已经违约）');
    promiseAmount = r2(b.promise_amount);
    if (!(promiseAmount > 0)) {
      throw bad('「答应付款」必须填承诺金额 —— 不写金额等于没承诺');
    }
    const remain = computeTask(task).remaining;
    if (promiseAmount > remain + 0.005) {
      throw bad(`承诺金额 ${promiseAmount} 超过当前未收 ${remain}，请核对`);
    }
  }
  if (['refused', 'dispute'].includes(result) && String(b.note || '').trim().length < 4) {
    throw bad('拒付/有争议必须写清原因（至少 4 个字）—— 下次接手的人要知道问题在哪');
  }

  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO collection_logs (task_id, channel, contact, result, promise_date, promise_amount, note, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(id, channel, b.contact || null, result, promiseDate, promiseAmount, b.note || null, user.username, t);

    db.prepare(
      "UPDATE collection_tasks SET follow_count = follow_count + 1, updated_at=? WHERE id=?"
    ).run(t, id);

    if (result === 'promised') {
      // 承诺次数 +1；如果上一次承诺已过期才付，说明跳票过一次
      const brokenBefore =
        task.promise_date && task.promise_date < today() && Number(task.remaining) > 0.005 ? 1 : 0;
      db.prepare(
        `UPDATE collection_tasks
            SET status='promised', promise_date=?, promise_amount=?, promised_at=?,
                promise_count = promise_count + 1,
                promise_broken = promise_broken + ?,
                next_follow_at=?,
                updated_at=?
          WHERE id=?`
      ).run(promiseDate, promiseAmount, t, brokenBefore, promiseDate, t, id);
    } else if (task.status === 'open' || task.status === 'escalated') {
      // 联系过了但没拿到承诺：从「待跟进」推进到「已联系」；
      // 已跳票的任务记了新跟进，说明人还在跟，退回 promised 之外的状态不合理，
      // 所以保持 escalated（页面靠最新记录看进展）
      if (task.status === 'open') {
        db.prepare("UPDATE collection_tasks SET status='following', updated_at=? WHERE id=?").run(t, id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return detail(id);
}

/** 指派负责人（财务把「待指派」的单派给业务员） */
function assign(id, payload, user) {
  const b = payload || {};
  const task = db.prepare('SELECT * FROM collection_tasks WHERE id = ?').get(id);
  if (!task) throw bad('催收任务不存在', 404);
  if (task.status === 'closed') throw bad('任务已结案，不需要指派');

  let ownerUser = null;
  if (b.username) {
    ownerUser = db.prepare('SELECT id, username, name FROM users WHERE username = ?').get(b.username);
    if (!ownerUser) throw bad('指定的账号不存在');
  }
  const name = (ownerUser && ownerUser.name) || String(b.owner_name || '').trim() || null;
  if (!name) throw bad('请指定负责人');

  const t = now();
  db.prepare(
    `UPDATE collection_tasks
        SET owner_user_id=?, owner_username=?, owner_name=?, owner_source='manual', updated_at=?
      WHERE id=?`
  ).run(ownerUser ? ownerUser.id : null, ownerUser ? ownerUser.username : null, name, t, id);
  return detail(id);
}

/**
 * 结案
 *
 * 只有「钱收回来了」能自动结案；其余（坏账/法务/对冲）必须人工结，且要写原因。
 * 核销坏账的说明要求 ≥8 字 —— 「坏账」两个字谁都会写，写清「为什么认定收不回」
 * 才是以后能被审计接受的记录。
 */
function close(id, payload, user) {
  const b = payload || {};
  const task = db.prepare('SELECT * FROM collection_tasks WHERE id = ?').get(id);
  if (!task) throw bad('催收任务不存在', 404);
  if (task.status === 'closed') throw bad('这张任务已经结案了');

  const reason = String(b.reason || '').trim();
  if (!CLOSE_REASON_LABEL[reason]) throw bad('结案原因不合法');
  if (reason === 'other' && !String(b.note || '').trim()) throw bad('选「其他」必须写说明');

  const c = computeTask(task);
  if (reason === 'paid' && !c.fullySettled) {
    throw bad(`还有 ${c.remaining} 没收到，不能按「已收回」结案 —— 请先确认回款是否已核销`);
  }
  if (reason === 'bad_debt' && String(b.note || '').trim().length < 8) {
    throw bad('核销坏账要写清理由（至少 8 个字）—— 比如「客户已停业，律师函无回应，坏账审批单 BD-26-03」');
  }
  if (reason !== 'paid' && c.remaining > 0.005 && String(b.note || '').trim().length < 4) {
    throw bad(`这张任务还有 ${c.remaining} 未收，结案要写清处理方式（至少 4 个字）`);
  }

  const t = now();
  db.prepare(
    `UPDATE collection_tasks
        SET status='closed', closed_reason=?, closed_note=?, closed_at=?, closed_by=?, updated_at=?
      WHERE id=?`
  ).run(reason, b.note || null, t, user.username, t, id);
  return detail(id);
}

/** 重新激活（结错了/客户又开始付） */
function reopen(id, payload, user) {
  const task = db.prepare('SELECT * FROM collection_tasks WHERE id = ?').get(id);
  if (!task) throw bad('催收任务不存在', 404);
  if (task.status !== 'closed') throw bad('只有已结案的任务能重新打开');
  const reason = String((payload || {}).reason || '').trim();
  if (reason.length < 4) throw bad('重新打开要写原因（至少 4 个字）');

  const t = now();
  db.prepare(
    `UPDATE collection_tasks
        SET status='following', closed_reason=NULL, closed_note=NULL, closed_at=NULL, closed_by=NULL,
            note = IFNULL(note,'') || ?, updated_at=?
      WHERE id=?`
  ).run(`\n[重开] ${reason}`, t, id);
  return detail(id);
}

module.exports = {
  STATUS_LABEL,
  LEVEL_LABEL,
  CHANNEL_LABEL,
  RESULT_LABEL,
  CLOSE_REASON_LABEL,
  levelOf,
  internalCustomerIds,
  resolveOwner,
  board,
  generate,
  computeTask,
  syncTask,
  refreshAll,
  onInvoiceSettled,
  list,
  detail,
  stats,
  log,
  assign,
  close,
  reopen
};
