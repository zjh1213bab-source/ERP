/**
 * 扎级完工进度
 * ============================================================
 * 解决什么问题：有了扎标、报工也记了扎号之后，**没人能看出「哪一扎做到了哪一道」**。
 * 车间问「B012 那扎车缝完了没」，只能一张张翻报工记录。
 *
 * 三条口径（写死在代码里，页面只展示，不再二次判断）
 *
 * 1. **只统计记了扎号的报工**。没记扎号的报工（历史数据、或有人直接在生产页报工）
 *    单独汇总成「未归扎报工」，**绝不摊派到扎上** —— 摊派就是编数据，
 *    看起来进度漂亮，实际查不出是谁做的。
 *
 * 2. **按工序名聚合，不按 node_id**。历史上有两套工序列（同名单重复 node），
 *    也有报工记了别的单的 node_id（脏数据）。按 id 分列会把同一道车缝拆成两列，
 *    还会漏掉脏数据里真实的合格数。
 *
 * 3. **完工看「末道工序」，不是「最后一条报工」**。末道 = 名字含「入库」的工序
 *    （成品入库）；没有就退到 seq 最大的、且不是「出库发运」的那道 ——
 *    出库发运是整单动作，不是单扎动作，拿它判扎完工会让所有扎永远不完工。
 *
 * 判定结果只有四种，外加一个异常标记：
 *   done  完工（末道合格 ≥ 扎件数）
 *   short 短数（末道有报工但不足件数）—— 要单独查，短数是钱
 *   doing 在制（有报工，末道还没报）
 *   idle  未开工（一条报工都没有）
 *   over  超报（任一工序合格 > 扎件数）—— 通常是报工记错扎号，单独标出来
 */
const { db } = require('../db');

/** 末道工序：成品入库优先；排除出库发运（整单动作） */
function pickFinal(processes) {
  if (!processes.length) return null;
  const inbound = processes.find((p) => /入库/.test(p.name));
  if (inbound) return inbound;
  const cand = [...processes].reverse().find((p) => !/出库|发运/.test(p.name));
  return cand || processes[processes.length - 1];
}

/** 有扎的订单清单（页面左上角选单用） */
function ordersWithBundles(limit = 60) {
  return db
    .prepare(
      `SELECT o.id, o.order_no, o.style_name, o.status, c.name AS customer_name,
              COUNT(b.id) AS bundles,
              IFNULL(SUM(b.qty), 0) AS bundle_qty,
              (SELECT COUNT(*) FROM production_reports r WHERE r.order_id = o.id AND r.bundle_no IS NOT NULL) AS assigned_reports,
              (SELECT COUNT(*) FROM production_reports r WHERE r.order_id = o.id AND r.bundle_no IS NULL) AS unassigned_reports
         FROM cut_bundles b
         JOIN cut_orders co ON co.id = b.cut_order_id
         JOIN orders o ON o.id = co.order_id
         LEFT JOIN customers c ON c.id = o.customer_id
        GROUP BY o.id
        ORDER BY o.id DESC
        LIMIT ?`
    )
    .all(Number(limit) || 60)
    .map((r) => ({
      ...r,
      bundles: Number(r.bundles) || 0,
      bundle_qty: Number(r.bundle_qty) || 0,
      assigned_reports: Number(r.assigned_reports) || 0,
      unassigned_reports: Number(r.unassigned_reports) || 0
    }));
}

/**
 * 某订单的扎级进度
 * @param {number|string} orderId
 */
function progressOf(orderId) {
  const order = db
    .prepare(
      `SELECT o.id, o.order_no, o.style_name, o.status, o.delivery_date,
              c.name AS customer_name
         FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.id = ?`
    )
    .get(orderId);
  if (!order) {
    const e = new Error('订单不存在（可能已被删除）');
    e.status = 404;
    throw e;
  }

  // ---------- 工序列：按 seq 排，同名去重 ----------
  const nodeRows = db
    .prepare('SELECT id, name, seq, status FROM order_nodes WHERE order_id = ? ORDER BY seq, id')
    .all(order.id);
  const processes = [];
  const seen = new Set();
  nodeRows.forEach((n) => {
    const name = String(n.name || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    processes.push({ name, seq: Number(n.seq) || processes.length + 1 });
  });
  const finalP = pickFinal(processes);
  const finalName = finalP ? finalP.name : null;

  // ---------- 扎 ----------
  const bundles = db
    .prepare(
      `SELECT b.id, b.bundle_no, b.color, b.size, b.qty, b.status, b.checked_at, b.note,
              co.cut_no, co.mixed_dye_lot,
              l.bed_no, l.dye_lot
         FROM cut_bundles b
         JOIN cut_orders co ON co.id = b.cut_order_id
         LEFT JOIN cut_lots l ON l.id = b.lot_id
        WHERE co.order_id = ?
        ORDER BY b.bundle_no, b.id`
    )
    .all(order.id);

  // ---------- 报工：按 扎号 + 工序名 聚合 ----------
  const reportRows = db
    .prepare(
      `SELECT IFNULL(bundle_no, '') AS bundle_no,
              IFNULL(node_name, '（未记工序）') AS node_name,
              SUM(IFNULL(qty_ok, 0)) AS ok,
              SUM(IFNULL(qty_defect, 0)) AS defect,
              MAX(report_date) AS last_date,
              COUNT(*) AS n
         FROM production_reports
        WHERE order_id = ?
        GROUP BY IFNULL(bundle_no, ''), IFNULL(node_name, '（未记工序）')`
    )
    .all(order.id);

  const byBundle = {}; // bundle_no -> { 工序名: {ok, defect, last_date, n} }
  const unassigned = { count: 0, qty: 0, by_node: {} };
  let unknownProcess = 0; // 报工里的工序名不在该单工序列里

  reportRows.forEach((r) => {
    const ok = Number(r.ok) || 0;
    const defect = Number(r.defect) || 0;
    const n = Number(r.n) || 0;
    if (!r.bundle_no) {
      unassigned.count += n;
      unassigned.qty += ok;
      unassigned.by_node[r.node_name] = (unassigned.by_node[r.node_name] || 0) + ok;
      return;
    }
    if (!seen.has(r.node_name)) unknownProcess += n;
    byBundle[r.bundle_no] = byBundle[r.bundle_no] || {};
    byBundle[r.bundle_no][r.node_name] = { ok, defect, last_date: r.last_date, n };
  });

  // ---------- 逐扎判定 ----------
  const out = bundles.map((b) => {
    const qty = Number(b.qty) || 0;
    const cells = byBundle[b.bundle_no] || {};
    const cellList = {};
    let touched = 0;
    let over = false;
    let lastDate = '';
    processes.forEach((p) => {
      const c = cells[p.name];
      if (!c) {
        cellList[p.name] = null;
        return;
      }
      cellList[p.name] = c;
      if (c.ok > 0) touched++;
      if (qty > 0 && c.ok > qty) over = true;
      if (c.last_date && c.last_date > lastDate) lastDate = c.last_date;
    });
    // 不在工序列里的报工（历史脏数据）也要能看见，否则合计对不上
    Object.keys(cells).forEach((name) => {
      if (!seen.has(name)) {
        cellList[name] = cells[name];
        if (cells[name].ok > 0) touched++;
        if (qty > 0 && cells[name].ok > qty) over = true;
        if (cells[name].last_date && cells[name].last_date > lastDate) lastDate = cells[name].last_date;
      }
    });

    const finalCell = finalName ? cells[finalName] : null;
    const finalOk = finalCell ? Number(finalCell.ok) || 0 : 0;

    let status = 'idle';
    if (qty > 0 && finalOk >= qty) status = 'done';
    else if (finalOk > 0) status = 'short';
    else if (touched > 0) status = 'doing';

    return {
      id: b.id,
      bundle_no: b.bundle_no,
      color: b.color,
      size: b.size,
      qty,
      cut_no: b.cut_no,
      dye_lot: b.dye_lot || '',
      bed_no: b.bed_no || '',
      mixed_dye_lot: Number(b.mixed_dye_lot) === 1,
      checked: b.status === 'ok' || b.status === 'checked',
      note: b.note || '',
      cells: cellList,
      final_ok: finalOk,
      touched,
      over,
      last_date: lastDate,
      status
    };
  });

  // ---------- 汇总 ----------
  const summary = {
    bundles: out.length,
    total_qty: out.reduce((s, b) => s + b.qty, 0),
    done: out.filter((b) => b.status === 'done').length,
    done_qty: out.filter((b) => b.status === 'done').reduce((s, b) => s + b.qty, 0),
    short: out.filter((b) => b.status === 'short').length,
    short_qty: out.filter((b) => b.status === 'short').reduce((s, b) => s + (b.qty - b.final_ok), 0),
    doing: out.filter((b) => b.status === 'doing').length,
    idle: out.filter((b) => b.status === 'idle').length,
    over: out.filter((b) => b.over).length,
    unassigned_reports: unassigned.count,
    unassigned_qty: unassigned.qty,
    unknown_process_reports: unknownProcess,
    final_process: finalName,
    process_count: processes.length
  };

  // ---------- 提示（页面直接显示，不要让人自己猜口径） ----------
  const notices = [];
  if (!out.length) {
    notices.push({
      level: 'warn',
      text: '这批订单还没有裁床扎包。扎级进度需要先「裁床与扎包」分扎，否则没有统计单位。'
    });
  }
  if (summary.unassigned_reports > 0) {
    notices.push({
      level: 'warn',
      text:
        `有 ${summary.unassigned_reports} 条报工没有记扎号（合计合格 ${summary.unassigned_qty} 件），` +
        '这部分进度无法归到具体扎，没有算进下面的扎级进度。要按扎追溯，扫扎标报工才会记扎号。'
    });
  }
  if (unknownProcess > 0) {
    notices.push({
      level: 'warn',
      text: `有 ${unknownProcess} 条报工记的工序不在本单工序表里（历史脏数据），已按工序名单独成列，未丢弃。`
    });
  }
  if (summary.over > 0) {
    notices.push({
      level: 'bad',
      text: `有 ${summary.over} 扎出现「合格数超过扎件数」（红色行），多半是报工记错了扎号 —— 核对后再算完工。`
    });
  }
  if (summary.short > 0) {
    notices.push({
      level: 'bad',
      text: `有 ${summary.short} 扎末道报了但不足件数，共差 ${summary.short_qty} 件。短数要当场追，不要留到装箱才发现。`
    });
  }
  if (!finalName) {
    notices.push({ level: 'bad', text: '本单没有工序表，无法判定完工（末道工序为空）。' });
  }

  // 未归扎报工的分工序明细（页面要能看出「哪道工序没记扎」）
  const unassignedByNode = Object.keys(unassigned.by_node)
    .map((name) => ({ name, qty: unassigned.by_node[name] }))
    .sort((a, b) => b.qty - a.qty);

  return {
    order: {
      id: order.id,
      order_no: order.order_no,
      style_name: order.style_name,
      status: order.status,
      delivery_date: order.delivery_date,
      customer_name: order.customer_name
    },
    processes,
    bundles: out,
    summary,
    unassigned_by_node: unassignedByNode,
    notices
  };
}

module.exports = { ordersWithBundles, progressOf };
