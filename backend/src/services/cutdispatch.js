/**
 * M07 裁片外发与外协验货交接 —— 服务层
 * ============================================================
 * 裁片外发和「整单分厂」是两件事：
 *   分单回答「这单交给哪家做、多少件、什么价」；
 *   裁片外发回答「**具体哪几扎**裁片走了、回来几件、合格几件、短了为什么」。
 *   扎是能追到缸号/色差/裁片批次的唯一单位，所以外发必须按扎登记，
 *   不能拿整单件数糊过去 —— 糊过去以后色差、短数都找不到责任扎。
 *
 * 写进代码的硬规则：
 *   1) **只能发复核过的扎**：没复核的扎发出去，回来分不清是裁错还是车错
 *   2) **发出件数 = 扎包件数合计**，不能手改（能手改就一定有人改）
 *   3) **一扎同时只能在一张未完结的外发单里**（`open_flag` + 部分唯一索引兜底），
 *      否则同一扎被两张单算两次，回货永远对不上
 *   4) **只能发合格裁片**：外发件数不得超过裁剪单的合格裁片数（减去已发出的）
 *   5) **回货 ≤ 未回数量**（不能凭空多回来）
 *   6) **回货验收三分必须闭合**：合格 + 不良 + 返工 = 本次回货
 *   7) **不良必须写原因**（疵点/缝制/尺寸），返工也要留痕
 *   8) **短数必须写原因**（遗失/污损/外协自留），不写不许结案
 *   9) **交接三方都要留名**：外协交货人 + 本厂接收人 + 验货人
 *   10) **已发出不能改扎、已结案不能改任何数**；取消只放行草稿/已发出且未回货的
 *   11) 回货合格**不自动入成品库存**：成品入库走既有 `/api/stock/instock`，
 *       这里只负责「外协交回来多少、合格多少」，两边职责不混
 */
const { db } = require('../db');

const EPS = 0.005;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const int0 = (v) => Math.round(num(v));
const pad = (n) => String(n).padStart(2, '0');

function now() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nextNo(table, col, prefix) {
  const d = new Date();
  const p = `${prefix}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rows = db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ?`).all(`${p}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.no).slice(p.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  let seq = max + 1;
  let no = `${p}${String(seq).padStart(4, '0')}`;
  while (db.prepare(`SELECT 1 x FROM ${table} WHERE ${col} = ?`).get(no)) {
    seq += 1;
    no = `${p}${String(seq).padStart(4, '0')}`;
  }
  return no;
}

const STATUS = {
  draft: '草稿', sent: '已发出', partial: '部分回货', returned: '已回齐', closed: '已结案', cancelled: '已取消'
};
const INSPECT = { pass: '合格放行', conditional: '让步接收', reject: '退回' };

/** 可发外协的扎：已复核（兼容历史 status 值 checked / ok / handed） */
const CHECKED_STATUS = ['checked', 'ok', 'handed'];

/** 某裁剪单的可外发扎（复核对过 + 没挂在未完结外发单里） */
function availableBundles(cutOrderId) {
  const rows = db.prepare(
    `SELECT b.*, l.bed_no AS lot_no, l.dye_lot
     FROM cut_bundles b
     LEFT JOIN cut_lots l ON l.id = b.lot_id
     WHERE b.cut_order_id = ?
     ORDER BY b.bundle_no`
  ).all(cutOrderId);
  const busy = new Map();
  db.prepare(
    `SELECT i.bundle_id, d.dispatch_no FROM cut_dispatch_items i
     JOIN cut_dispatches d ON d.id = i.dispatch_id
     WHERE i.open_flag = 1 AND d.status NOT IN ('closed','cancelled')`
  ).all().forEach((r) => busy.set(r.bundle_id, r.dispatch_no));
  return rows.map((b) => ({
    id: b.id, bundle_no: b.bundle_no, color: b.color, size: b.size, qty: r2(b.qty),
    lot_no: b.lot_no, dye_lot: b.dye_lot,
    checked: CHECKED_STATUS.includes(String(b.status)),
    busy_dispatch: busy.get(b.id) || null,
    can_send: CHECKED_STATUS.includes(String(b.status)) && !busy.has(b.id)
  }));
}

/** 外发建议：给某裁剪单算出「还能发多少」 */
function dispatchSuggest(cutOrderId) {
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(cutOrderId);
  if (!c) throw new Error('裁剪单不存在');
  const bundles = availableBundles(cutOrderId);
  const sentBefore = r2(num(db.prepare(
    `SELECT COALESCE(SUM(i.qty),0) q FROM cut_dispatch_items i
     JOIN cut_dispatches d ON d.id = i.dispatch_id
     WHERE d.cut_order_id = ? AND d.status <> 'cancelled' AND i.open_flag = 1`
  ).get(cutOrderId).q));
  const qualified = r2(num(c.qualified_qty));
  const usable = bundles.filter((b) => b.can_send);
  return {
    cut: {
      id: c.id, cut_no: c.cut_no, order_no: c.order_no, style_no: c.style_no,
      status: c.status, qualified_qty: qualified, reject_qty: r2(num(c.reject_qty)),
      bundle_count: int0(c.bundle_count), bundle_qty: r2(num(c.bundle_qty))
    },
    bundles,
    sent_before: sentBefore,
    remain_qualified: r2(Math.max(0, qualified - sentBefore)),
    can_send_qty: r2(usable.reduce((s, b) => s + num(b.qty), 0)),
    uncheckable: bundles.filter((b) => !b.checked).length,
    busy: bundles.filter((b) => b.busy_dispatch).length,
    // 合格裁片数没填就不许外发——否则「发了多少」没有上限依据
    blockers: qualified <= EPS
      ? ['这张裁剪单还没录合格裁片数，先把裁剪完成（实裁/合格/疵片）录进去，否则外发没有上限依据']
      : []
  };
}

function list(q) {
  const where = [];
  const args = [];
  if (q.status) { where.push('d.status = ?'); args.push(q.status); }
  if (q.factory_id) { where.push('d.factory_id = ?'); args.push(int0(q.factory_id)); }
  if (q.order_no) { where.push('d.order_no LIKE ?'); args.push(`%${q.order_no}%`); }
  const rows = db.prepare(
    `SELECT d.*, (SELECT COUNT(*) FROM cut_dispatch_receipts r WHERE r.dispatch_id = d.id) AS receipt_count,
            (d.out_qty - d.returned_qty) AS open_qty
     FROM cut_dispatches d ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY d.id DESC LIMIT 200`
  ).all(...args);
  return rows.map((r) => ({
    ...r,
    status_label: STATUS[r.status] || r.status,
    out_qty: r2(r.out_qty),
    returned_qty: r2(r.returned_qty),
    accepted_qty: r2(r.accepted_qty),
    rejected_qty: r2(r.rejected_qty),
    rework_qty: r2(r.rework_qty),
    open_qty: r2(num(r.open_qty)),
    amount: r2(r.amount),
    overdue: r.expect_return_date && r.expect_return_date < today() && ['sent', 'partial'].includes(r.status)
  }));
}

function detail(id) {
  const d = db.prepare('SELECT * FROM cut_dispatches WHERE id = ?').get(id);
  if (!d) return null;
  const items = db.prepare('SELECT * FROM cut_dispatch_items WHERE dispatch_id = ? ORDER BY bundle_no').all(id)
    .map((i) => ({
      ...i,
      qty: r2(i.qty), returned_qty: r2(i.returned_qty),
      accepted_qty: r2(i.accepted_qty), rejected_qty: r2(i.rejected_qty), rework_qty: r2(i.rework_qty),
      open_qty: r2(Math.max(0, num(i.qty) - num(i.returned_qty) - num(i.short_qty))),
      short_qty: r2(i.short_qty)
    }));
  const receipts = db.prepare('SELECT * FROM cut_dispatch_receipts WHERE dispatch_id = ? ORDER BY receive_date, id').all(id)
    .map((r) => ({
      ...r,
      qty: r2(r.qty), accepted_qty: r2(r.accepted_qty), rejected_qty: r2(r.rejected_qty),
      rework_qty: r2(r.rework_qty), short_qty: r2(r.short_qty),
      inspect_label: INSPECT[r.inspect_result] || r.inspect_result || '—',
      items: db.prepare('SELECT * FROM cut_dispatch_receipt_items WHERE receipt_id = ? ORDER BY bundle_no').all(r.id)
    }));
  const outQty = r2(d.out_qty);
  const returned = r2(d.returned_qty);
  return {
    ...d,
    status_label: STATUS[d.status] || d.status,
    out_qty: outQty, returned_qty: returned,
    accepted_qty: r2(d.accepted_qty), rejected_qty: r2(d.rejected_qty), rework_qty: r2(d.rework_qty),
    open_qty: r2(Math.max(0, outQty - returned - r2(d.loss_qty))),
    loss_qty: r2(d.loss_qty),
    amount: r2(d.amount),
    items,
    receipts,
    // 验收闭合自检：合格+不良+返工 必须等于已回货
    accepted_check: Math.abs(r2(d.accepted_qty + d.rejected_qty + d.rework_qty) - returned) < 0.02,
    can: {
      edit: d.status === 'draft',
      send: d.status === 'draft',
      receive: ['sent', 'partial'].includes(d.status),
      close: ['sent', 'partial', 'returned'].includes(d.status),
      cancel: ['draft', 'sent'].includes(d.status) && returned <= EPS
    }
  };
}

function create(b, operator) {
  const cutId = int0(b.cut_order_id);
  const c = db.prepare('SELECT * FROM cut_orders WHERE id = ?').get(cutId);
  if (!c) throw new Error('裁剪单不存在');
  const f = db.prepare('SELECT * FROM factories WHERE id = ?').get(int0(b.factory_id));
  if (!f) throw new Error('外协工厂不存在');
  if (f.status !== 'active') throw new Error(`工厂「${f.name}」已停用，不能外发`);
  const sug = dispatchSuggest(cutId);
  if (sug.blockers.length) throw new Error(sug.blockers.join('；'));

  const ids = Array.isArray(b.bundle_ids) ? b.bundle_ids.map(int0) : [];
  if (!ids.length) throw new Error('至少要选一扎裁片');
  const bundles = sug.bundles.filter((x) => ids.includes(x.id));
  if (bundles.length !== ids.length) throw new Error('有选中的扎不属于这张裁剪单');
  const uncheckable = bundles.filter((x) => !x.checked);
  if (uncheckable.length) {
    throw new Error(`有 ${uncheckable.length} 扎还没复核（${uncheckable.slice(0, 3).map((x) => x.bundle_no).join('、')}）：
      没复核的扎发出去，回来分不清是裁错还是车错，请先复核`);
  }
  const busy = bundles.filter((x) => x.busy_dispatch);
  if (busy.length) {
    throw new Error(`有 ${busy.length} 扎已经挂在未完结的外发单里（${busy.slice(0, 3).map((x) => `${x.bundle_no} → ${x.busy_dispatch}`).join('、')}）：
      同一扎不能同时发两家，请先结掉那张单`);
  }

  const outQty = r2(bundles.reduce((s, x) => s + num(x.qty), 0));
  if (outQty <= EPS) throw new Error('选中的扎件数合计为 0，没有可发的裁片');
  if (outQty > sug.remain_qualified + 0.02) {
    throw new Error(`本次要发 ${outQty} 件，超过可发上限 ${sug.remain_qualified}（合格裁片 ${sug.cut.qualified_qty} − 已发 ${sug.sent_before}）`);
  }
  const price = r2(b.price);
  if (price < -EPS) throw new Error('加工单价不能为负');
  const outDate = b.out_date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(outDate)) throw new Error('发出日期格式应为 YYYY-MM-DD');

  const ts = now();
  const no = nextNo('cut_dispatches', 'dispatch_no', 'WF');
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO cut_dispatches
        (dispatch_no, company_id, cut_order_id, cut_no, order_id, order_no, style_no,
         factory_id, factory_name, out_date, expect_return_date, bundle_count, out_qty,
         returned_qty, accepted_qty, rejected_qty, rework_qty, loss_qty, price, amount,
         status, note, created_by, created_at, updated_at, demo_tag)
       VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?, 0,0,0,0,0,?,0, 'draft', ?,?,?,?,?)`
    ).run(no, c.id, c.cut_no, c.order_id, c.order_no, c.style_no, f.id, f.name,
      outDate, b.expect_return_date || null, bundles.length, outQty, price, b.note || null,
      operator, ts, ts, b.demo_tag || null);
    const did = Number(info.lastInsertRowid);
    const stmt = db.prepare(
      `INSERT INTO cut_dispatch_items (dispatch_id, bundle_id, bundle_no, lot_no, dye_lot, color, size, qty, open_flag, note)
       VALUES (?,?,?,?,?,?,?,?,1,?)`
    );
    bundles.forEach((x) => stmt.run(did, x.id, x.bundle_no, x.lot_no || null, x.dye_lot || null,
      x.color || null, x.size || null, num(x.qty), null));
    db.exec('COMMIT');
    return detail(did);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 发出：草稿 → 已发出，扎包标记 handover（已在别处） */
function send(id, operator) {
  const d = db.prepare('SELECT * FROM cut_dispatches WHERE id = ?').get(id);
  if (!d) throw new Error('外发单不存在');
  if (d.status !== 'draft') throw new Error(`当前状态「${STATUS[d.status] || d.status}」不能发出`);
  const items = db.prepare('SELECT * FROM cut_dispatch_items WHERE dispatch_id = ?').all(id);
  if (!items.length) throw new Error('外发单没有明细');
  const ts = now();
  db.prepare("UPDATE cut_dispatches SET status='sent', out_by=?, out_at=?, updated_at=? WHERE id=?")
    .run(operator, ts, ts, id);
  return detail(id);
}

/**
 * 回货验收：外协把裁片送回来，本厂验收分流
 * body: { receive_date, handover_by, received_by, inspected_by, inspect_result,
 *         short_reason, remark, items:[{ dispatch_item_id, qty, accepted_qty, rejected_qty, rework_qty, defect_reason }] }
 */
function receive(id, b, operator) {
  const d = db.prepare('SELECT * FROM cut_dispatches WHERE id = ?').get(id);
  if (!d) throw new Error('外发单不存在');
  if (!['sent', 'partial'].includes(d.status)) {
    throw new Error(`当前状态「${STATUS[d.status] || d.status}」不能登记回货（只有已发出/部分回货能收）`);
  }
  const date = b.receive_date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('回货日期格式应为 YYYY-MM-DD');
  const handoverBy = String(b.handover_by || '').trim();
  const receivedBy = String(b.received_by || '').trim();
  const inspectedBy = String(b.inspected_by || '').trim();
  if (!handoverBy) throw new Error('必须填外协交货人（交接要能追到人）');
  if (!receivedBy) throw new Error('必须填本厂接收人');
  if (!inspectedBy) throw new Error('必须填验货人（谁来判定合格）');
  const inspectResult = INSPECT[b.inspect_result] ? b.inspect_result : 'pass';

  const input = Array.isArray(b.items) ? b.items.filter((x) => num(x.qty) > EPS) : [];
  if (!input.length) throw new Error('至少要填一扎的回货数量');
  const rows = db.prepare('SELECT * FROM cut_dispatch_items WHERE dispatch_id = ?').all(id);

  const plan = [];
  for (const x of input) {
    const row = rows.find((r) => r.id === int0(x.dispatch_item_id));
    if (!row) throw new Error(`明细 #${x.dispatch_item_id} 不属于这张外发单`);
    const qty = r2(x.qty);
    const open = r2(num(row.qty) - num(row.returned_qty));
    if (qty > open + EPS) throw new Error(`扎 ${row.bundle_no} 未回只有 ${open} 件，回不了 ${qty} 件`);
    const acc = r2(x.accepted_qty);
    const rej = r2(x.rejected_qty);
    const rew = r2(x.rework_qty);
    if (acc < -EPS || rej < -EPS || rew < -EPS) throw new Error('验收数量不能为负');
    if (Math.abs(r2(acc + rej + rew) - qty) > 0.02) {
      throw new Error(`扎 ${row.bundle_no}：合格 ${acc} + 不良 ${rej} + 返工 ${rew} ≠ 本次回货 ${qty}。三块必须加起来等于回货数`);
    }
    if ((rej > EPS || rew > EPS) && String(x.defect_reason || '').trim().length < 2) {
      throw new Error(`扎 ${row.bundle_no} 有不良/返工，必须写原因（疵点 / 缝制 / 尺寸）`);
    }
    plan.push({ row, qty, acc, rej, rew, reason: x.defect_reason || null });
  }

  // 短数：本次声明不再补的数量（发出但没回来）
  const shortQty = r2(b.short_qty);
  if (shortQty < -EPS) throw new Error('短数不能为负');
  if (shortQty > EPS && String(b.short_reason || '').trim().length < 4) {
    throw new Error('有短数必须写原因（遗失 / 污损 / 外协自留），不写不许过关');
  }

  const sumQty = r2(plan.reduce((s, p) => s + p.qty, 0));
  const sumAcc = r2(plan.reduce((s, p) => s + p.acc, 0));
  const sumRej = r2(plan.reduce((s, p) => s + p.rej, 0));
  const sumRew = r2(plan.reduce((s, p) => s + p.rew, 0));
  const openTotal = r2(rows.reduce((s, r) => s + (num(r.qty) - num(r.returned_qty)), 0));
  if (sumQty + shortQty > openTotal + 0.02) {
    throw new Error(`本次回货 ${sumQty} + 短数 ${shortQty} 超过未回 ${openTotal}，不能凭空多回来`);
  }

  const ts = now();
  const no = nextNo('cut_dispatch_receipts', 'receipt_no', 'HH');
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO cut_dispatch_receipts
        (receipt_no, dispatch_id, receive_date, qty, accepted_qty, rejected_qty, rework_qty, short_qty,
         handover_by, received_by, inspected_by, inspect_result, short_reason, remark, created_by, created_at, demo_tag)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(no, id, date, sumQty, sumAcc, sumRej, sumRew, shortQty,
      handoverBy, receivedBy, inspectedBy, inspectResult, b.short_reason || null, b.remark || null,
      operator, ts, b.demo_tag || null);
    const rid = Number(info.lastInsertRowid);
    const insItem = db.prepare(
      `INSERT INTO cut_dispatch_receipt_items (receipt_id, dispatch_item_id, bundle_no, qty, accepted_qty, rejected_qty, rework_qty, defect_reason, note)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    plan.forEach((p) => {
      insItem.run(rid, p.row.id, p.row.bundle_no, p.qty, p.acc, p.rej, p.rew, p.reason, null);
      db.prepare(
        `UPDATE cut_dispatch_items
           SET returned_qty = ROUND(COALESCE(returned_qty,0) + ?, 2),
               accepted_qty = ROUND(COALESCE(accepted_qty,0) + ?, 2),
               rejected_qty = ROUND(COALESCE(rejected_qty,0) + ?, 2),
               rework_qty = ROUND(COALESCE(rework_qty,0) + ?, 2)
         WHERE id = ?`
      ).run(p.qty, p.acc, p.rej, p.rew, p.row.id);
    });

    // 短数要落到具体扎上：否则单据显示「未回 0」、某扎却还挂着「未回 2」，
    // 谁也说不清这 2 件是丢了还是还没送。按未回量从多到少摊。
    if (shortQty > EPS) {
      let left = shortQty;
      const fresh = db.prepare('SELECT * FROM cut_dispatch_items WHERE dispatch_id = ?').all(id)
        .sort((a, b) => (num(b.qty) - num(b.returned_qty) - num(b.short_qty)) - (num(a.qty) - num(a.returned_qty) - num(a.short_qty)));
      fresh.forEach((r) => {
        if (left <= EPS) return;
        const open = r2(num(r.qty) - num(r.returned_qty) - num(r.short_qty));
        if (open <= EPS) return;
        const take = Math.min(open, left);
        db.prepare('UPDATE cut_dispatch_items SET short_qty = ROUND(COALESCE(short_qty,0) + ?, 2) WHERE id = ?').run(take, r.id);
        left = r2(left - take);
      });
    }

    refreshDispatch(id, ts);
    db.exec('COMMIT');
    return detail(id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 汇总外发单：已回、合格、不良、返工、差异、加工费；并推进状态 */
function refreshDispatch(id, ts) {
  const items = db.prepare('SELECT * FROM cut_dispatch_items WHERE dispatch_id = ?').all(id);
  const sum = (f) => r2(items.reduce((s, x) => s + num(x[f]), 0));
  const returned = sum('returned_qty');
  const acc = sum('accepted_qty');
  const rej = sum('rejected_qty');
  const rew = sum('rework_qty');
  const d = db.prepare('SELECT * FROM cut_dispatches WHERE id = ?').get(id);
  const outQty = r2(d.out_qty);
  // 差异 = 外协已声明「不再补」的短数合计。**不能把短数塞进 returned_qty**，
  // 否则「合格 + 不良 + 返工 = 回货」这条闭合当场破掉（踩过）。
  const shortSum = r2(num(db.prepare(
    'SELECT COALESCE(SUM(short_qty),0) s FROM cut_dispatch_receipts WHERE dispatch_id = ?'
  ).get(id).s));
  const loss = shortSum;
  const open = r2(outQty - returned - loss);
  const amount = r2(acc * num(d.price));
  const status = open <= 0.02 ? 'returned' : ((returned > EPS || loss > EPS) ? 'partial' : d.status);
  db.prepare(
    `UPDATE cut_dispatches
       SET returned_qty=?, accepted_qty=?, rejected_qty=?, rework_qty=?, loss_qty=?, amount=?, status=?, updated_at=?
     WHERE id=?`
  ).run(returned, acc, rej, rew, loss, amount, status, ts || now(), id);
}

/** 结案：有差异必须写原因；结案后扎释放（可再外发/回仓） */
function close(id, b, operator) {
  const d = db.prepare('SELECT * FROM cut_dispatches WHERE id = ?').get(id);
  if (!d) throw new Error('外发单不存在');
  if (!['sent', 'partial', 'returned'].includes(d.status)) {
    throw new Error(`当前状态「${STATUS[d.status] || d.status}」不能结案`);
  }
  const open = r2(num(d.out_qty) - num(d.returned_qty) - num(d.loss_qty));
  const reason = String((b && b.loss_reason) || '').trim();
  if (open > EPS && reason.length < 4) {
    throw new Error(`还有 ${open} 件没回来，结案必须写差异原因（遗失 / 污损 / 外协自留 / 放弃追讨）`);
  }
  const ts = now();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE cut_dispatches SET status='closed', closed_by=?, closed_at=?, loss_qty=?, loss_reason=?, updated_at=? WHERE id=?")
      .run(operator, ts, r2(num(d.loss_qty) + Math.max(0, open)), reason || d.loss_reason || null, ts, id);
    // 结案后这扎才算「了结」，释放占用
    db.prepare('UPDATE cut_dispatch_items SET open_flag = 0 WHERE dispatch_id = ?').run(id);
    db.exec('COMMIT');
    return detail(id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function cancel(id, reason, operator) {
  const d = db.prepare('SELECT * FROM cut_dispatches WHERE id = ?').get(id);
  if (!d) throw new Error('外发单不存在');
  if (!['draft', 'sent'].includes(d.status)) throw new Error('只有草稿或已发出（还没回货）的外发单能取消');
  if (num(d.returned_qty) > EPS) throw new Error('已经回货了，不能取消，请走结案');
  const rs = String(reason || '').trim();
  if (rs.length < 4) throw new Error('取消外发单必须写原因（≥4 字）');
  const ts = now();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE cut_dispatches SET status='cancelled', note=COALESCE(note,'')||?, updated_at=? WHERE id=?")
      .run(` [取消] ${rs}`, ts, id);
    db.prepare('UPDATE cut_dispatch_items SET open_flag = 0 WHERE dispatch_id = ?').run(id);
    db.exec('COMMIT');
    return detail(id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function board(q) {
  const where = [];
  const args = [];
  const from = q.from || today().slice(0, 8) + '01';
  if (from) { where.push('d.out_date >= ?'); args.push(from); }
  const rows = db.prepare(
    `SELECT d.* FROM cut_dispatches d WHERE ${where.join(' AND ') || '1=1'} ORDER BY d.id DESC`
  ).all(...args);
  const stat = {
    count: rows.length,
    open: rows.filter((r) => ['sent', 'partial'].includes(r.status)).length,
    out_qty: r2(rows.reduce((s, r) => s + num(r.out_qty), 0)),
    returned_qty: r2(rows.reduce((s, r) => s + num(r.returned_qty), 0)),
    accepted_qty: r2(rows.reduce((s, r) => s + num(r.accepted_qty), 0)),
    rejected_qty: r2(rows.reduce((s, r) => s + num(r.rejected_qty), 0)),
    loss_qty: r2(rows.reduce((s, r) => s + num(r.loss_qty), 0)),
    amount: r2(rows.reduce((s, r) => s + num(r.amount), 0))
  };
  stat.accept_rate = stat.returned_qty > 0 ? r2((stat.accepted_qty / stat.returned_qty) * 100) : null;
  // 逾期未回：约定回货日已过但还在「已发出/部分回货」
  const overdue = rows.filter((r) => ['sent', 'partial'].includes(r.status)
    && r.expect_return_date && r.expect_return_date < today())
    .map((r) => ({
      id: r.id, dispatch_no: r.dispatch_no, factory_name: r.factory_name, order_no: r.order_no,
      expect_return_date: r.expect_return_date, open_qty: r2(num(r.out_qty) - num(r.returned_qty)),
      days: Math.round((new Date(today()) - new Date(r.expect_return_date)) / 86400000)
    }));
  // 外协质量排名（按验收合格率，样本不足不排名）
  const byFactory = {};
  rows.forEach((r) => {
    if (num(r.returned_qty) <= 0) return;
    const k = r.factory_id || 0;
    byFactory[k] = byFactory[k] || { factory_id: r.factory_id, factory_name: r.factory_name, returned: 0, accepted: 0, rejected: 0, batches: 0 };
    byFactory[k].returned = r2(byFactory[k].returned + num(r.returned_qty));
    byFactory[k].accepted = r2(byFactory[k].accepted + num(r.accepted_qty));
    byFactory[k].rejected = r2(byFactory[k].rejected + num(r.rejected_qty));
    byFactory[k].batches += 1;
  });
  const factories = Object.values(byFactory).map((x) => ({
    ...x,
    rate: x.returned > 0 ? r2((x.accepted / x.returned) * 100) : null,
    // 少于 50 件不排名：样品量太小，一个疵点就把合格率拉到 90%
    rankable: x.returned >= 50
  })).sort((a, b) => (b.rate === null ? -1 : b.rate) - (a.rate === null ? -1 : a.rate));
  return { from, stat, overdue, factories };
}

function dict() {
  return {
    status: STATUS, inspect: INSPECT, today: today(),
    factories: db.prepare("SELECT id, name, type FROM factories WHERE status='active' ORDER BY (CASE WHEN type='outsource' THEN 0 ELSE 1 END), id").all(),
    cuts: db.prepare(
      `SELECT c.id, c.cut_no, c.order_no, c.style_no, c.qualified_qty, c.status
       FROM cut_orders c WHERE c.qualified_qty > 0 ORDER BY c.id DESC LIMIT 60`
    ).all()
  };
}

module.exports = {
  EPS, r2, num, today, STATUS, INSPECT,
  availableBundles, dispatchSuggest, list, detail, create, send, receive, close, cancel, board, dict
};
