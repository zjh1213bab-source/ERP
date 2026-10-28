/**
 * 售后与对账资料（TS-N22-08）
 * ========================================================================
 * 一句话：客户能提售后、能看到处理到哪一步；能下载**我们授权过**的对账单文件。
 *
 * ## 为什么售后单要单独一张表，而不是直接用 `stock_returns`
 *
 * `stock_returns` 是**仓库视角的实物单**：待点收 → 待判定 → 良品入库。
 * 但客户投诉里有一半根本不涉及实物：
 *
 * - 「少发了 20 件」→ 要补发或赔款，不一定退货
 * - 「色差，我自己处理掉」→ 只要赔款，货留在客户手上
 * - 「这批要退，但运费你们出」→ 退货 + 退款 + 追偿三条线同时走
 *
 * 把赔款硬塞进实物退货单，就会出现「退货单上没有实物、却要写退款金额」的怪状。
 * 所以：**售后单是业务对象（谁、哪一批、什么问题、怎么处理）**，
 * **实物部分生成一张 `stock_returns` 去走仓库流程**，两者用 `stock_return_id` 关联。
 *
 * ## 二、四条轨道互不阻塞
 *
 * | 轨道 | 谁管 | 状态从哪来 |
 * |---|---|---|
 * | 退款 | 财务/销售 | `after_sale_tickets.refund_status` |
 * | 实物实收 | 仓库 | **关联退货单实时算** |
 * | 质量检验 | 质检 | **关联退货单实时算** |
 * | 再上架 | 仓库 | **关联退货单实时算** |
 * | 追偿 | 采购/生产 | `after_sale_tickets.recovery_*` |
 *
 * 实收/检验/再上架**不存副本**。存了副本，售后页与仓库页必然说两个数 ——
 * 同一判断只能一份实现，这是踩过的坑。
 *
 * ## 三、最重要的一条：退款不直接恢复库存
 *
 * 原型原话「分开退款、实物实收、质量检验、再上架和追偿；**退款不直接恢复库存**」。
 * 落到代码里是两句：
 *
 * 1. `refund()` 里**没有**任何 `applyStock` / `addLedger` 调用，改的只有退款字段；
 * 2. 库存只由 `routes/spot.js` 的 `inspect()` 写（那里要求逐件判完、良品必须指定可售库位）。
 *
 * 混在一起的后果：钱退了、货没回来、库存却多了 —— 月底盘点永远差这一笔。
 */
const { db, now } = require('../db');
const { localDate } = require('../utils/time');
const { nextNo } = require('../utils/docNo');
const PHOTOS = require('./photos');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const today = () => localDate(now());
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;

const REASONS = {
  quality: { label: '质量问题', need_photo: true, hint: '破洞、开线、色差、缩水等做工或面料问题' },
  short: { label: '短装', need_photo: false, hint: '实收数量少于订单数量' },
  wrong_item: { label: '错款错色', need_photo: true, hint: '发的不是我订的款或颜色' },
  damaged: { label: '运输破损', need_photo: true, hint: '外箱或货物在运输中受损' },
  late: { label: '交期延误', need_photo: false, hint: '晚于承诺出厂日，影响上架档期' },
  other: { label: '其他', need_photo: false, hint: '以上都不是，请在描述里写清' }
};

const RESOLUTIONS = {
  return: { label: '退货退款', need_goods: true, hint: '货物退回仓库，检验后良品再上架' },
  replace: { label: '补件补发', need_goods: false, hint: '不退货，重新做或补发缺的数量' },
  refund: { label: '仅赔款', need_goods: false, hint: '货物留在客户手上，只退钱' },
  repair: { label: '返修', need_goods: true, hint: '退回修好后送回客户' }
};

const STATUS = {
  submitted: '待受理',
  accepted: '处理中',
  handling: '处理中',
  rejected: '已驳回',
  settled: '已结案',
  cancelled: '已撤销'
};

const REFUND_STATUS = { none: '未涉及', pending: '待退款', paid: '已退款' };
const RECOVERY_STATUS = { none: '未涉及', pending: '待追偿', done: '已追偿', waived: '放弃追偿' };
const PARTY = { factory: '本厂生产', supplier: '面料供应商', carrier: '货代/承运' };
const OWNER = { sales: '销售', quality: '质检', production: '生产', warehouse: '仓库' };

const OPEN = ['submitted', 'accepted', 'handling'];

/* ==================================================================== *
 * 一、四条轨道：实物部分从关联退货单实时算
 * ==================================================================== */

/**
 * 退货单状态 → 三条轨道状态
 * 不存副本的原因：仓库点了「判定」，售后页必须立刻跟着变；存副本就必然要写同步逻辑，
 * 同步逻辑漏一处就是两个页面说两个数。
 */
function tracksOf(ret) {
  const out = {
    receipt: { code: 'none', label: '无需收货', qty_apply: 0, qty_received: 0 },
    inspect: { code: 'none', label: '无需检验', qty_good: 0, qty_defect: 0, qty_scrap: 0 },
    restock: { code: 'none', label: '不涉及', qty: 0 }
  };
  if (!ret) return out;

  const apply = num(ret.qty_apply);
  const received = num(ret.qty_received);
  const good = num(ret.qty_good);
  const defect = num(ret.qty_defect);
  const scrap = num(ret.qty_scrap);

  out.receipt.qty_apply = apply;
  out.receipt.qty_received = received;
  if (ret.status === 'cancelled') {
    out.receipt = { code: 'cancelled', label: '退货单已取消', qty_apply: apply, qty_received: 0 };
    out.inspect = { code: 'none', label: '无需检验', qty_good: 0, qty_defect: 0, qty_scrap: 0 };
    out.restock = { code: 'none', label: '不涉及', qty: 0 };
    return out;
  }
  if (ret.status === 'draft') {
    out.receipt.code = 'pending';
    out.receipt.label = `待点收（申请 ${apply} 件）`;
    out.inspect.code = 'pending';
    out.inspect.label = '待收货后判定';
    out.restock.code = 'pending';
    out.restock.label = '待检验结果';
    return out;
  }

  // received / inspected / closed
  out.receipt.code = received + 0.001 >= apply ? 'received' : 'partial';
  out.receipt.label = received + 0.001 >= apply
    ? `已实收 ${received} 件`
    : `已实收 ${received} / 申请 ${apply} 件`;

  if (ret.status === 'received') {
    out.inspect.code = 'pending';
    out.inspect.label = '待判定';
    out.restock.code = 'pending';
    out.restock.label = '待判定结果';
    return out;
  }

  // inspected / closed
  out.inspect.qty_good = good;
  out.inspect.qty_defect = defect;
  out.inspect.qty_scrap = scrap;
  if (good <= 0) {
    out.inspect.code = 'failed';
    out.inspect.label = `全部不合格（次品 ${defect} / 报废 ${scrap}）`;
  } else if (defect > 0 || scrap > 0) {
    out.inspect.code = 'partial';
    out.inspect.label = `良品 ${good} · 次品 ${defect} · 报废 ${scrap}`;
  } else {
    out.inspect.code = 'passed';
    out.inspect.label = `全部合格 ${good} 件`;
  }

  out.restock.code = good > 0 ? 'done' : 'none';
  out.restock.label = good > 0 ? `良品 ${good} 件已入可售` : '无良品可上架';
  out.restock.qty = good;
  return out;
}

function stockReturnOf(row) {
  if (!row.stock_return_id) return null;
  return db.prepare('SELECT * FROM stock_returns WHERE id = ?').get(row.stock_return_id) || null;
}

/** 补齐展示字段 */
function decorate(row) {
  const ret = stockReturnOf(row);
  const tracks = tracksOf(ret);
  // 还没受理的「退货/返修」单：退货单要等受理才生成，这里不能显示「不涉及实物」——
  // 那会让人以为这单不用收货。说清「受理后生成」。
  if (!ret && OPEN.includes(row.status) && (RESOLUTIONS[row.resolution] || {}).need_goods) {
    tracks.receipt = { code: 'pending', label: '待生成退货单', qty_apply: num(row.qty), qty_received: 0 };
    tracks.inspect = { code: 'pending', label: '待收货后判定', qty_good: 0, qty_defect: 0, qty_scrap: 0 };
    tracks.restock = { code: 'pending', label: '待检验结果', qty: 0 };
  }
  const t = today();
  const open = OPEN.includes(row.status);
  const overdue = !!(open && row.due_date && row.due_date < t);
  const daysOpen = row.settled_at
    ? Math.max(0, Math.round((new Date(String(row.settled_at).slice(0, 10)) - new Date(String(row.created_at).slice(0, 10))) / 86400000))
    : Math.max(0, Math.round((new Date(t) - new Date(String(row.created_at).slice(0, 10))) / 86400000));

  return {
    ...row,
    status_label: STATUS[row.status] || row.status,
    reason_label: (REASONS[row.reason_code] || {}).label || row.reason_code,
    resolution_label: (RESOLUTIONS[row.resolution] || {}).label || row.resolution,
    refund_status_label: REFUND_STATUS[row.refund_status] || row.refund_status,
    recovery_status_label: RECOVERY_STATUS[row.recovery_status] || row.recovery_status,
    recovery_party_label: row.recovery_party ? (PARTY[row.recovery_party] || row.recovery_party) : null,
    owner_label: row.owner_role ? (OWNER[row.owner_role] || row.owner_role) : null,
    open,
    overdue,
    overdue_days: overdue ? Math.round((new Date(t) - new Date(String(row.due_date).slice(0, 10))) / 86400000) : 0,
    days_open: daysOpen,
    tracks,
    stock_return: ret
      ? { id: ret.id, return_no: ret.return_no, status: ret.status, warehouse: ret.warehouse, qty_apply: ret.qty_apply, qty_received: ret.qty_received }
      : null,
    // 一句话总结「这单走到哪了」，列表里不用点进去也能看懂
    progress_text: progressText(row, tracks),
    photos: db.prepare("SELECT id, url, filename, note FROM attachments WHERE target_type='after_sale' AND target_id=? AND deleted_at IS NULL ORDER BY id")
      .all(row.id)
  };
}

function progressText(row, tracks) {
  if (row.status === 'submitted') return '等业务受理';
  if (row.status === 'rejected') return `已驳回：${row.reject_reason || ''}`;
  if (row.status === 'cancelled') return '客户已撤销';
  if (row.status === 'settled') return '已结案';
  const bits = [];
  if (row.refund_status === 'paid') bits.push(`已退 ${row.refund_amount}`);
  else if (row.refund_status === 'pending') bits.push('待退款');
  if (tracks.receipt.code !== 'none') bits.push(tracks.receipt.label);
  if (tracks.inspect.code !== 'none' && tracks.inspect.code !== 'pending') bits.push(tracks.inspect.label);
  if (tracks.restock.code === 'done') bits.push(tracks.restock.label);
  if (row.recovery_status === 'done') bits.push('已追偿');
  return bits.length ? bits.join(' · ') : '处理中';
}

/* ==================================================================== *
 * 二、字典
 * ==================================================================== */

function dict() {
  const g = (sql) => db.prepare(sql).get().c;
  return {
    reasons: Object.entries(REASONS).map(([code, v]) => ({ code, ...v })),
    resolutions: Object.entries(RESOLUTIONS).map(([code, v]) => ({ code, ...v })),
    status: Object.entries(STATUS).map(([code, label]) => ({ code, label })),
    refund_status: Object.entries(REFUND_STATUS).map(([code, label]) => ({ code, label })),
    recovery_status: Object.entries(RECOVERY_STATUS).map(([code, label]) => ({ code, label })),
    parties: Object.entries(PARTY).map(([code, label]) => ({ code, label })),
    owners: Object.entries(OWNER).map(([code, label]) => ({ code, label })),
    stats: stats()
  };
}

function stats() {
  const g = (sql, ...a) => db.prepare(sql).get(...a).c;
  const sum = (sql, ...a) => r2(db.prepare(sql).get(...a).v);
  return {
    open: g(`SELECT COUNT(*) c FROM after_sale_tickets WHERE status IN ('submitted','accepted','handling')`),
    pending_accept: g(`SELECT COUNT(*) c FROM after_sale_tickets WHERE status='submitted'`),
    overdue: g(`SELECT COUNT(*) c FROM after_sale_tickets WHERE status IN ('accepted','handling') AND IFNULL(due_date,'') <> '' AND due_date < ?`, today()),
    refund_pending: g(`SELECT COUNT(*) c FROM after_sale_tickets WHERE refund_status='pending'`),
    refund_paid_amount: sum(`SELECT COALESCE(SUM(refund_amount),0) v FROM after_sale_tickets WHERE refund_status='paid'`),
    recovery_open: g(`SELECT COUNT(*) c FROM after_sale_tickets WHERE recovery_status IN ('pending')`),
    recovery_pending_amount: sum(`SELECT COALESCE(SUM(recovery_amount),0) v FROM after_sale_tickets WHERE recovery_status IN ('pending','done')`),
    settled_30d: g(`SELECT COUNT(*) c FROM after_sale_tickets WHERE status='settled' AND substr(IFNULL(settled_at,''),1,10) >= ?`,
      localDate(new Date(Date.now() - 30 * 86400000).toISOString())),
    statements_published: g(`SELECT COUNT(*) c FROM statement_files WHERE status='published'`),
    statements_draft: g(`SELECT COUNT(*) c FROM statement_files WHERE status='draft'`)
  };
}

/* ==================================================================== *
 * 三、客户侧：提交、查询、撤销
 * ==================================================================== */

function submit(ctx) {
  const {
    customerId, customerName, source = 'customer', body = {}, operator
  } = ctx;

  const orderId = Number(body.order_id);
  const itemId = Number(body.order_item_id);
  const qty = r2(body.qty);
  const reasonCode = String(body.reason_code || '').trim();
  const resolution = String(body.resolution || '').trim();
  const reason = String(body.reason || '').trim();
  const amountClaim = r2(body.amount_claim);

  if (!orderId) throw bad('请选择要售后的订单');
  if (!REASONS[reasonCode]) throw bad('售后原因不合法');
  if (!RESOLUTIONS[resolution]) throw bad('处理方式不合法');
  if (!(qty > 0)) throw bad('售后数量必须大于 0');
  if (reason.length < 8) throw bad('请把问题说清楚（至少 8 个字），业务要照着处理');

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw bad('订单不存在', 404);
  if (customerId && Number(order.customer_id) !== Number(customerId)) {
    throw bad('这不是你的订单', 403);
  }
  if (order.status === 'draft') throw bad('订单还没确认，暂时不能提售后');

  const item = itemId
    ? db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId)
    : null;
  if (itemId && !item) throw bad('这一行不属于该订单');

  // 数量上限：订单行数量 − 已提过且未被驳回/撤销的数量
  const lineQty = item ? num(item.qty) : 0;
  if (item) {
    const used = r2(db.prepare(
      `SELECT COALESCE(SUM(qty),0) v FROM after_sale_tickets
        WHERE order_item_id = ? AND status NOT IN ('rejected','cancelled')`
    ).get(item.id).v);
    if (qty > lineQty - used + 0.001) {
      throw bad(`这一行只剩 ${r2(lineQty - used)} 件可提售后（订单 ${lineQty} 件 − 已提 ${used} 件）`);
    }
  }

  // 金额上限：不能超过这一行（没有明细时退到订单总额）
  const cap = item ? num(item.amount_usd) : num(order.total_usd);
  if (amountClaim < 0) throw bad('索赔金额不能为负');
  if (amountClaim > cap + 0.001) {
    throw bad(`索赔金额 ${amountClaim} 超过这一行的货款 ${r2(cap)}，请核对数量与单价（手滑多打一个零不该变成巨额退款）`);
  }

  // 照片：质量问题/错款/破损必须有证据，否则业务只能凭一句话去和工厂吵。
  // 客户上传的是 dataUrl（浏览器没有别的上传通道），先落盘再记路径；
  // 内部代提或演示数据可以直接给 url。
  const rawPhotos = Array.isArray(body.photos) ? body.photos : [];
  const photos = rawPhotos.map((p) => {
    if (!p) return null;
    if (p.dataUrl) {
      const f = PHOTOS.writeImage(p.dataUrl, p.filename);
      return { ...f, note: p.note };
    }
    return p.url ? p : null;
  }).filter(Boolean);
  if (REASONS[reasonCode].need_photo && !photos.length) {
    throw bad(`「${REASONS[reasonCode].label}」必须上传至少 1 张照片`);
  }
  if (photos.length > 6) throw bad('一次最多 6 张照片，多的话请分批补');

  // 幂等：同一订单行 + 同一原因 + 同一处理方式，处理中只能有一条
  if (item) {
    const dup = db.prepare(
      `SELECT ticket_no FROM after_sale_tickets
        WHERE order_item_id = ? AND reason_code = ? AND resolution = ?
          AND status IN ('submitted','accepted','handling')`
    ).get(item.id, reasonCode, resolution);
    if (dup) throw bad(`这一行已经有一条同原因的售后单在处理中（${dup.ticket_no}），请等业务回复`);
  }

  const t = now();
  const ts = today();
  const no = nextNo('AS', 'after_sale_tickets', 'ticket_no');
  // 处理时限：受理后才起算，这里先给一个内部参考值
  const info = db.prepare(
    `INSERT INTO after_sale_tickets (ticket_no, company_id, source, customer_id, customer_name,
       order_id, order_no, order_item_id, style_no, product_name, qty, amount_claim, currency,
       reason_code, reason, photo_count, resolution, status, created_at, updated_at, demo_tag)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'submitted', ?,?,?)`
  ).run(no, order.company_id || 1, source, order.customer_id || customerId || null,
    customerName || null, order.id, order.order_no, item ? item.id : null,
    item ? item.style_no : null, item ? item.product_name : (order.style_name || null),
    qty, amountClaim, order.currency || 'USD', reasonCode, reason, photos.length, resolution,
    t, t, body.demo_tag || null);
  const id = Number(info.lastInsertRowid);

  // 照片落在通用附件表（target_type='after_sale'），不另建一套文件表
  const insA = db.prepare(
    "INSERT INTO attachments (target_type, target_id, filename, url, size, mime, uploader, created_at, cat, note) VALUES ('after_sale',?,?,?,?,?,?,?, 'after_sale', ?)"
  );
  photos.forEach((p, i) => {
    insA.run(id, String(p.filename || `售后照片${i + 1}`).slice(0, 120), String(p.url),
      Number(p.size) || 0, String(p.mime || 'image/jpeg'), operator || customerName || 'customer',
      t, p.note ? String(p.note).slice(0, 200) : null);
  });

  return { id, ticket_no: no, status: 'submitted', note: `已提交，单号 ${no}。业务会先核对照片与数量再回复` };
}

function list(q = {}) {
  const w = [];
  const a = [];
  if (q.status === 'open') { w.push("status IN ('submitted','accepted','handling')"); }
  else if (q.status) { w.push('status = ?'); a.push(q.status); }
  if (q.customer_id) { w.push('customer_id = ?'); a.push(Number(q.customer_id)); }
  if (q.order_id) { w.push('order_id = ?'); a.push(Number(q.order_id)); }
  if (q.refund_status) { w.push('refund_status = ?'); a.push(q.refund_status); }
  if (q.recovery_status) { w.push('recovery_status = ?'); a.push(q.recovery_status); }
  if (q.overdue) { w.push("status IN ('accepted','handling') AND IFNULL(due_date,'') <> '' AND due_date < ?"); a.push(today()); }
  if (q.q) {
    w.push('(order_no LIKE ? OR ticket_no LIKE ? OR customer_name LIKE ? OR reason LIKE ?)');
    const k = `%${q.q}%`;
    a.push(k, k, k, k);
  }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM after_sale_tickets ${where} ORDER BY
      CASE status WHEN 'submitted' THEN 0 WHEN 'accepted' THEN 1 WHEN 'handling' THEN 1 ELSE 2 END,
      id DESC LIMIT 300`).all(...a);
  return rows.map(decorate);
}

function detail(id) {
  const row = db.prepare('SELECT * FROM after_sale_tickets WHERE id = ?').get(Number(id));
  if (!row) throw bad('售后单不存在', 404);
  const d = decorate(row);
  d.order = row.order_id
    ? db.prepare('SELECT id, order_no, status, delivery_date, currency, total_usd FROM orders WHERE id = ?').get(row.order_id)
    : null;
  d.line = row.order_item_id
    ? db.prepare('SELECT id, style_no, product_name, color, qty, amount_usd FROM order_items WHERE id = ?').get(row.order_item_id)
    : null;
  d.return_items = row.stock_return_id
    ? db.prepare('SELECT * FROM stock_return_items WHERE return_id = ?').all(row.stock_return_id)
    : [];
  d.can = {
    accept: row.status === 'submitted',
    reject: row.status === 'submitted',
    refund: ['accepted', 'handling'].includes(row.status) && row.refund_status !== 'paid',
    recovery: ['accepted', 'handling', 'settled'].includes(row.status) && row.recovery_status !== 'done',
    settle: ['accepted', 'handling'].includes(row.status)
  };
  d.settle_blockers = settleBlockers(row);
  return d;
}

/* ==================================================================== *
 * 四、内部处理
 * ==================================================================== */

const OWNER_DEFAULT = {
  quality: 'quality', short: 'warehouse', wrong_item: 'warehouse', damaged: 'sales', late: 'sales', other: 'sales'
};

/**
 * 受理：确定主责与时限；需要实物的**在这里生成退货单**
 * 退货单只建草稿，实物到仓库才点收 —— 售后单里不复制仓库流程
 */
function accept(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM after_sale_tickets WHERE id = ?').get(Number(id));
  if (!row) throw bad('售后单不存在', 404);
  if (row.status !== 'submitted') throw bad(`当前状态「${STATUS[row.status]}」不能受理`);
  const owner = OWNER[body.owner_role] ? body.owner_role : OWNER_DEFAULT[row.reason_code] || 'sales';
  const t = now();
  const days = { return: 7, repair: 10, replace: 7, refund: 3 }[row.resolution] || 7;
  const due = body.due_date || localDate(new Date(Date.now() + days * 86400000).toISOString());

  let returnId = null;
  // 需要实物的处理方式：退货 / 返修 —— 生成退货单草稿，交给仓库去点收
  if (RESOLUTIONS[row.resolution].need_goods && !row.stock_return_id) {
    returnId = createReturnDraft(row, operator);
  }

  db.exec('BEGIN');
  try {
    // 只有「要退钱」的处理方式才把退款轨道立起来；补件/返修不涉及钱，硬设成待退款
    // 会让财务天天看到一堆不用付的单子。
    const refundTrack = ['return', 'refund'].includes(row.resolution) ? 'pending' : 'none';
    db.prepare(
      `UPDATE after_sale_tickets SET status='accepted', owner_role=?, due_date=?,
         stock_return_id=COALESCE(stock_return_id, ?), refund_status=?,
         handled_by=?, handled_at=?, updated_at=? WHERE id=?`
    ).run(owner, due, returnId, refundTrack, operator, t, t, row.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  return {
    id: row.id, status: 'accepted', owner_role: owner, due_date: due,
    stock_return_id: returnId,
    note: returnId
      ? `已受理，并在仓库生成退货单草稿（等客户把货寄回后点收）。主责：${OWNER[owner]}`
      : `已受理，主责：${OWNER[owner]}。这类处理不需要实物退回`
  };
}

/** 生成退货单草稿（复用仓库现有流程，不另写一套收货/检验） */
function createReturnDraft(row, operator) {
  const t = now();
  const no = nextNo('RT', 'stock_returns', 'return_no');
  const item = row.order_item_id
    ? db.prepare('SELECT * FROM order_items WHERE id = ?').get(row.order_item_id)
    : null;
  const info = db.prepare(
    `INSERT INTO stock_returns (return_no,type,warehouse,order_id,order_no,partner_name,source_no,reason,status,
       qty_apply,qty_received,qty_good,qty_defect,qty_scrap,return_date,remark,created_by,created_at,updated_at)
     VALUES (?, 'customer', 'us', ?,?,?,?,?, 'draft', ?,0,0,0,0,?,?,?,?,?)`
  ).run(no, row.order_id, row.order_no, row.customer_name, row.ticket_no,
    `售后 ${row.ticket_no}：${(REASONS[row.reason_code] || {}).label || row.reason_code}`,
    num(row.qty), today(),
    `由售后单自动创建（${RESOLUTIONS[row.resolution].label}）`, operator || 'system', t, t);
  const rid = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO stock_return_items (return_id,style_no,product_name,color,size,qty_apply,qty_received,qty_good,qty_defect,qty_scrap,note)
     VALUES (?,?,?,?,?,?,0,0,0,0,?)`
  ).run(rid, item ? item.style_no : (row.style_no || ''), item ? item.product_name : (row.product_name || ''),
    item ? (item.color || '') : '', '', num(row.qty), `售后单 ${row.ticket_no}`);
  return rid;
}

function reject(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM after_sale_tickets WHERE id = ?').get(Number(id));
  if (!row) throw bad('售后单不存在', 404);
  if (row.status !== 'submitted') throw bad(`当前状态「${STATUS[row.status]}」不能驳回`);
  const reason = String(body.reason || '').trim();
  if (reason.length < 6) throw bad('驳回必须写清原因（至少 6 个字）—— 客户拿到「已驳回」三个字等于没回复');
  const t = now();
  db.prepare("UPDATE after_sale_tickets SET status='rejected', reject_reason=?, handled_by=?, handled_at=?, updated_at=? WHERE id=?")
    .run(reason, operator, t, t, row.id);
  return { id: row.id, status: 'rejected' };
}

/**
 * 登记退款 —— **这里绝不碰库存**
 *
 * 只要在这加一句 applyStock，就会出现「钱退了、货还在路上、可售库存却多了」。
 * 入库只允许由仓库的检验步骤写（`routes/spot.js` 的 inspect），那里要求逐件判完、良品指定库位。
 */
function refund(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM after_sale_tickets WHERE id = ?').get(Number(id));
  if (!row) throw bad('售后单不存在', 404);
  if (!['accepted', 'handling'].includes(row.status)) {
    throw bad(`当前状态「${STATUS[row.status]}」不能登记退款（先受理）`);
  }
  if (row.refund_status === 'paid') throw bad('这单已经登记过退款了，不能重复退（重复退要冲销原记录，找财务走线下）');

  const amount = r2(body.amount);
  if (!(amount > 0)) throw bad('退款金额必须大于 0');
  if (amount > num(row.amount_claim) + 0.001) {
    throw bad(`退款 ${amount} 超过客户索赔的 ${num(row.amount_claim)}，超出部分要重新走审批`);
  }
  const method = String(body.method || '').trim();
  const note = String(body.note || '').trim();
  if (method.length < 2) throw bad('请填写退款方式（原路退回 / 抵扣下批货款 / 线下支付），否则财务没法对账');

  // 是否确认货物会回厂：这一项决定后续要不要盯仓库
  const goodsReturned = body.goods_returned === true || body.goods_returned === 1 ? 1 : 0;
  if (goodsReturned && !RESOLUTIONS[row.resolution].need_goods) {
    throw bad(`处理方式是「${RESOLUTIONS[row.resolution].label}」，不该有货物回厂。如果货要退，请改走「退货退款」`);
  }
  if (!goodsReturned && RESOLUTIONS[row.resolution].need_goods) {
    // 要退货却说不回厂 —— 必须写清（客户自己处理掉、就地报废等）
    if (note.length < 8) throw bad('处理方式是退货/返修，但没确认货物回厂。若客户保留货物，请在备注里写清原因（至少 8 个字）');
  }

  const t = now();
  db.prepare(
    `UPDATE after_sale_tickets SET refund_status='paid', refund_amount=?, refund_method=?, refund_at=?,
       refund_by=?, refund_note=?, goods_returned=?, status = CASE WHEN status='accepted' THEN 'handling' ELSE status END,
       updated_at=? WHERE id=?`
  ).run(amount, method, t, operator, note || null, goodsReturned, t, row.id);

  return {
    id: row.id, refund_status: 'paid', refund_amount: amount,
    // 明确写出来，避免有人以为退款就完事了
    note: '已登记退款。**库存未变动** —— 良品入库只由仓库的检验步骤写；若货要回厂，去仓库页点收与判定',
    stock_untouched: true
  };
}

/** 追偿：向本厂/供应商/货代要回来，与客户退款是两条独立的线 */
function recovery(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM after_sale_tickets WHERE id = ?').get(Number(id));
  if (!row) throw bad('售后单不存在', 404);
  if (!['accepted', 'handling', 'settled'].includes(row.status)) throw bad('还没受理，谈不上追偿');
  if (row.recovery_status === 'done') throw bad('这单已经追偿过了');

  const waive = body.waive === true;
  if (waive) {
    const reason = String(body.note || '').trim();
    if (reason.length < 6) throw bad('放弃追偿也要写原因（至少 6 个字），否则看不出是「不该追」还是「忘了追」');
    db.prepare("UPDATE after_sale_tickets SET recovery_status='waived', recovery_note=?, updated_at=? WHERE id=?")
      .run(reason, now(), row.id);
    return { id: row.id, recovery_status: 'waived' };
  }

  if (!PARTY[body.party]) throw bad('请选择追偿对象（本厂生产 / 面料供应商 / 货代）');
  const amount = r2(body.amount);
  if (!(amount > 0)) throw bad('追偿金额必须大于 0');
  const paid = num(row.refund_amount);
  if (paid > 0 && amount > paid + 0.001) {
    throw bad(`追偿 ${amount} 超过赔给客户的 ${paid} —— 追回来的不能比赔出去的还多，请核对`);
  }
  if (paid <= 0) {
    // 还没赔钱就追偿：只可能是补件/返修的工时损失，允许但要写清
    const note = String(body.note || '').trim();
    if (note.length < 8) throw bad('还没赔款就追偿（补件/返修的工时损失），请在备注里写清依据（至少 8 个字）');
  }

  const t = now();
  db.prepare(
    `UPDATE after_sale_tickets SET recovery_status='done', recovery_party=?, recovery_amount=?, recovery_note=?, updated_at=? WHERE id=?`
  ).run(body.party, amount, String(body.note || '').trim() || null, t, row.id);
  return {
    id: row.id, recovery_status: 'done', recovery_amount: amount,
    note: `已登记向「${PARTY[body.party]}」追偿 ${amount}。追偿是内部口径，不会改变客户那边的退款记录`
  };
}

/** 结案前置条件：实物没走完、钱没退完，不许关单 */
function settleBlockers(row) {
  const out = [];
  if (RESOLUTIONS[row.resolution].need_goods) {
    const ret = stockReturnOf(row);
    if (!ret) {
      out.push('处理方式是退货/返修，但仓库还没有生成收货单');
    } else if (ret.status === 'draft') {
      out.push(`货物还没到仓（退货单 ${ret.return_no} 待点收）`);
    } else if (ret.status === 'received') {
      out.push(`货已到仓但还没判定（退货单 ${ret.return_no} 待判定），不知道多少件能再上架`);
    } else if (ret.status === 'inspected') {
      out.push(`已判定但退货单未关单（${ret.return_no}），关掉它才能结案`);
    } else if (ret.status === 'cancelled') {
      out.push('关联的退货单被取消了，请先确认货物是否真的没回来');
    }
  }
  if (['return', 'refund'].includes(row.resolution) && row.refund_status !== 'paid') {
    out.push('还没登记退款');
  }
  return out;
}

function settle(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM after_sale_tickets WHERE id = ?').get(Number(id));
  if (!row) throw bad('售后单不存在', 404);
  if (!['accepted', 'handling'].includes(row.status)) throw bad(`当前状态「${STATUS[row.status]}」不能结案`);
  const blockers = settleBlockers(row);
  if (blockers.length) throw bad(`还不能结案：${blockers.join('；')}`);
  const conclusion = String(body.conclusion || '').trim();
  if (conclusion.length < 8) throw bad('结案结论至少 8 个字（处理了什么、客户是否认可），客户会看到这段');
  const t = now();
  db.prepare("UPDATE after_sale_tickets SET status='settled', conclusion=?, settled_at=?, updated_at=? WHERE id=?")
    .run(conclusion, t, t, row.id);
  return { id: row.id, status: 'settled' };
}

function cancel(id, body = {}, operator, customerId) {
  const row = db.prepare('SELECT * FROM after_sale_tickets WHERE id = ?').get(Number(id));
  if (!row) throw bad('售后单不存在', 404);
  if (customerId && Number(row.customer_id) !== Number(customerId)) throw bad('这不是你的售后单', 403);
  if (row.status !== 'submitted') throw bad('业务已受理，不能直接撤销，请联系业务员协商');
  db.prepare("UPDATE after_sale_tickets SET status='cancelled', updated_at=? WHERE id=?").run(now(), row.id);
  return { id: row.id, status: 'cancelled' };
}

function note(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM after_sale_tickets WHERE id = ?').get(Number(id));
  if (!row) throw bad('售后单不存在', 404);
  const txt = String(body.note || '').trim();
  if (txt.length < 2) throw bad('备注太短');
  db.prepare("UPDATE after_sale_tickets SET updated_at=? WHERE id=?").run(now(), row.id);
  return { id: row.id, note: txt };
}

/* ==================================================================== *
 * 五、客户侧查询（只能看自己的）
 * ==================================================================== */

function customerList(customerId, q = {}) {
  const rows = db.prepare(
    `SELECT * FROM after_sale_tickets WHERE customer_id = ? ORDER BY id DESC LIMIT 100`
  ).all(Number(customerId));
  return rows.map((r) => {
    const d = decorate(r);
    // 客户不需要看到内部追偿对象与内部负责人，只留对他有意义的部分
    return {
      id: d.id, ticket_no: d.ticket_no, order_no: d.order_no, style_no: d.style_no,
      product_name: d.product_name, qty: d.qty, amount_claim: d.amount_claim, currency: d.currency,
      reason_label: d.reason_label, resolution_label: d.resolution_label,
      status: d.status, status_label: d.status_label, progress_text: d.progress_text,
      refund_status: d.refund_status, refund_status_label: d.refund_status_label,
      refund_amount: d.refund_amount, photos: d.photos.length,
      created_at: d.created_at, due_date: d.due_date, overdue: d.overdue
    };
  });
}

function customerDetail(customerId, id) {
  const row = db.prepare('SELECT * FROM after_sale_tickets WHERE id = ?').get(Number(id));
  if (!row) throw bad('售后单不存在', 404);
  if (Number(row.customer_id) !== Number(customerId)) throw bad('这不是你的售后单', 403);
  const d = decorate(row);
  return {
    id: d.id, ticket_no: d.ticket_no, order_no: d.order_no, style_no: d.style_no,
    product_name: d.product_name, qty: d.qty, amount_claim: d.amount_claim, currency: d.currency,
    reason_code: d.reason_code, reason_label: d.reason_label, reason: d.reason,
    resolution_label: d.resolution_label, status: d.status, status_label: d.status_label,
    progress_text: d.progress_text, tracks: d.tracks,
    refund_status: d.refund_status, refund_status_label: d.refund_status_label,
    refund_amount: d.refund_amount, refund_method: d.refund_method, refund_note: d.refund_note,
    conclusion: d.conclusion, reject_reason: d.reject_reason,
    due_date: d.due_date, overdue: d.overdue, created_at: d.created_at, settled_at: d.settled_at,
    photos: d.photos,
    // 追偿是内部口径，不给客户看 —— 客户知道自己退了多少就够了
    can_cancel: row.status === 'submitted'
  };
}

/** 客户可提交的范围：自己已确认的订单 + 还没提超的行 */
function submitOptions(customerId) {
  const orders = db.prepare(
    `SELECT id, order_no, status, currency, total_usd, style_name, delivery_date, created_at
       FROM orders WHERE customer_id = ? AND status NOT IN ('draft','cancelled')
       ORDER BY id DESC LIMIT 60`
  ).all(Number(customerId));
  return orders.map((o) => {
    const items = db.prepare('SELECT id, style_no, product_name, color, qty, amount_usd FROM order_items WHERE order_id = ?').all(o.id)
      .map((it) => {
        const used = r2(db.prepare(
          `SELECT COALESCE(SUM(qty),0) v FROM after_sale_tickets
            WHERE order_item_id = ? AND status NOT IN ('rejected','cancelled')`
        ).get(it.id).v);
        return {
          id: it.id, style_no: it.style_no, product_name: it.product_name, color: it.color,
          qty: it.qty, amount_usd: it.amount_usd, claimed: used, available: r2(num(it.qty) - used)
        };
      });
    return { ...o, items };
  });
}

module.exports = {
  REASONS, RESOLUTIONS, STATUS, REFUND_STATUS, RECOVERY_STATUS, PARTY, OWNER,
  dict, stats, submit, list, detail, accept, reject, refund, recovery, settle, cancel, note,
  customerList, customerDetail, submitOptions, tracksOf, settleBlockers
};
