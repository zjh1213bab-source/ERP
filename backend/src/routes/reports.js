/**
 * 生产报工明细
 * GET    /api/reports?node_id= | ?order_id=
 * GET    /api/reports/summary?order_id=      按工序汇总
 * POST   /api/reports
 * DELETE /api/reports/:id
 *
 * 硬规则：缝制及之后工序报工前，必须有「有效且放行量>0」的首件单——
 *        首件没放行就报工，等于绕过首件确认直接批量投产（原型 TS-N08-03）。
 */
const express = require('express');
const { localDate } = require('../utils/time');
const { db, now } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { faGate, PRE_NODES } = require('./firstArticles');
const SKILL = require('../services/skillMatrix');
const wageMultiplier=require('../services/wageMultiplier');
const crypto=require('crypto');
const scope = require('../access/companyScope');

/**
 * 报工没有自己的 `company_id` —— 它挂在订单上。
 * （单公司模式下按订单判归属这一段**不生效**：orderOr404 仍查存在性，但不再判主体。）
 * 所以范围一律通过订单判：读不到的订单，它的报工也不存在。
 */
function orderOr404(user, orderId) {
  const r = scope.assertOrder(user, orderId);
  if (!r.ok) {
    const e = new Error(r.reason);
    e.status = r.status;
    throw e;
  }
  return r.row;
}

const router = express.Router();
const WRITE = ['admin', 'production'];
router.get('/wage-quote',authRequired,wrap(async(req,res)=>{
 const node=db.prepare('SELECT * FROM order_nodes WHERE id=?').get(Number(req.query.node_id));
 if(!node)return fail(res,404,'生产工序不存在');orderOr404(req.user,node.order_id);
 return ok(res,wageMultiplier.quote(node.order_id,node,req.query));
}));

router.get('/', authRequired, wrap(async (req, res) => {
  const { node_id, order_id } = req.query;
  const where = [];
  const params = [];
  if (node_id) { where.push('node_id = ?'); params.push(node_id); }
  if (order_id) { where.push('order_id = ?'); params.push(order_id); }
  if (!where.length) return fail(res, 400, '缺少 node_id 或 order_id');
  // 按工序查时不带订单：先由工序反查订单再判归属（别家的工序 = 不存在）
  if (node_id) {
    const node = db.prepare('SELECT order_id FROM order_nodes WHERE id = ?').get(node_id);
    if (!node) return fail(res, 404, '生产工序不存在');
    orderOr404(req.user, node.order_id);
  } else {
    orderOr404(req.user, order_id);
  }
  const sc = scope.orderOwnedSql(scope.filterCompanyId(req.user), 'order_id');
  const sql = 'SELECT * FROM production_reports WHERE ' + where.join(' AND ') + sc.sql + ' ORDER BY id DESC';
  return ok(res, db.prepare(sql).all(...params));
}));

router.get('/summary', authRequired, wrap(async (req, res) => {
  const { order_id } = req.query;
  if (!order_id) return fail(res, 400, '缺少 order_id');
  orderOr404(req.user, order_id);
  const rows = db.prepare(
    `SELECT node_id, SUM(qty_ok) AS ok, SUM(qty_defect) AS defect, SUM(hours) AS hours, COUNT(*) AS cnt
     FROM production_reports WHERE order_id = ? GROUP BY node_id`
  ).all(order_id);
  return ok(res, rows);
}));

async function createReport(req,res) {
  const b = req.body || {};
  if (!b.node_id) return fail(res, 400, '报工必须关联具体生产工序');
  const node = db.prepare('SELECT * FROM order_nodes WHERE id = ?').get(b.node_id);
  if (!node) return fail(res, 404, '生产工序不存在');
  const orderId = b.order_id ? Number(b.order_id) : Number(node.order_id);
  if (orderId !== Number(node.order_id)) return fail(res, 400, '所选工序不属于该订单，报工未保存');
  const order = orderOr404(req.user, orderId);   // 别家的订单在这里就是 404
  if (!order) return fail(res, 404, '订单不存在');
  const requestNo=b.request_no??null;
  if(requestNo!==null&&(typeof requestNo!=='string'||!/^[A-Za-z0-9_-]{12,100}$/.test(requestNo)))return fail(res,400,'报工请求编号格式无效');
  const requestHash=crypto.createHash('sha256').update(JSON.stringify([req.user.sub,node.id,orderId,b.report_date||localDate(now()),Number(b.qty_ok??0),Number(b.qty_defect??0),Number(b.hours??0),b.employee_id||null,b.operator||'',b.bundle_no||'',b.item_id||null,b.color??null,b.remark||''])).digest('hex');
  const replay=()=>{
   if(!requestNo)return null;const existing=db.prepare('SELECT * FROM production_reports WHERE request_no=?').get(requestNo);
   if(existing&&existing.request_hash!==requestHash)throw Object.assign(new Error('报工请求编号已使用，不能重复提交不同内容'),{status:409});return existing;
  };
  const previous=replay();if(previous)return ok(res,previous);
  if (order.status !== 'production') return fail(res, 400, `订单当前为「${order.status}」，只有生产中的订单可以报工`);

  const qtyOk = Number(b.qty_ok ?? 0);
  const qtyDefect = Number(b.qty_defect ?? 0);
  const hours = Number(b.hours ?? 0);
  if (![qtyOk, qtyDefect, hours].every(Number.isFinite) || qtyOk < 0 || qtyDefect < 0 || hours < 0 || qtyOk + qtyDefect <= 0) {
    return fail(res, 400, '合格数、不良数和工时必须是非负有效数字，且报工数量不能全为 0');
  }
  const totalQty = Number(db.prepare('SELECT COALESCE(SUM(qty),0) AS qty FROM order_items WHERE order_id = ?').get(orderId).qty) || 0;
  if (!(totalQty > 0)) return fail(res, 400, '订单没有有效明细，不能报工');

  // 首件门禁：备料/排版算料/裁剪之外的工序（车缝及以后）必须先有放行首件
  const nodeName = (node && node.name) || b.node_name || '';
  if (nodeName && !PRE_NODES.includes(nodeName)) {
    const gate = faGate(orderId);
    if (!gate.ok) {
      return fail(res, 400, `「${nodeName}」报工被拦下：${gate.reason}`);
    }
  }

  // 报工归属到人：绩效按人汇总，不能只留一个自由文本的姓名
  const operatorName = String(b.operator || req.user.name || req.user.username || '').trim();
  let employeeId = b.employee_id ? Number(b.employee_id) : null;
  if (!employeeId && operatorName) {
    const emp = db.prepare("SELECT id FROM employees WHERE status = 'active' AND name = ? LIMIT 1").get(operatorName);
    if (emp) employeeId = emp.id;
  }

  // 扎号（可选）：扫扎标报工时带上，用于追溯「这一扎是谁做的」
  // 必须是这单真实存在的扎，否则追溯链就是假的
  let bundleNo = b.bundle_no ? String(b.bundle_no).trim() : null;
  if (bundleNo) {
    const hit = db
      .prepare(
        `SELECT b.bundle_no FROM cut_bundles b JOIN cut_orders c ON c.id = b.cut_order_id
          WHERE c.order_id = ? AND b.bundle_no = ?`
      )
      .get(orderId, bundleNo);
    if (!hit) return fail(res, 400, `扎号「${bundleNo}」不属于这张订单，报工未保存`);
    bundleNo = hit.bundle_no;
  }

  // 技能门禁：受限工序没资格不许上机（原型 TS-N13-06「受限岗位才拦」）。
  // 只拦「能认出是谁」的报工 —— 报工人不在员工档案时不拦，否则 HR 少录一个人
  // 就会让整条线开不了工；这部分会进技能矩阵的「未归属报工」清单，去补档案而不是堵生产。
  const skillGate = SKILL.gateForReport(employeeId, nodeName);
  if (!skillGate.ok) {
    return fail(res, 400, `「${nodeName}」报工被拦下：${skillGate.reason}`);
  }

  /**
   * 写入：**校验 + 插入 + 回写工序状态必须在同一个写事务里**
   *
   * 原来是「先查累计 → 通过上限检查 → 再 INSERT」，三步分开。
   * 单进程 + 全程同步时它恰好不会出错（Node 单线程不给别人插队的机会）——
   * 但这不是设计，是运气：
   *   · 哪天有人在中间加一个 await（查缓存、调外部系统），立刻变成超报；
   *   · PM2 cluster / 多实例部署时，两个进程读到同一个"已报 350"，
   *     各自判过 350+100 ≤ 500，最后写进 700 件，而两笔都"校验通过"。
   *
   * `BEGIN IMMEDIATE` 立刻拿写锁：读累计、判上限、写入、改节点一次性原子完成。
   * 事务里不许 `return fail()`（那样事务不会回滚），所以校验失败直接抛，
   * 由下面的 catch 统一 ROLLBACK —— 抛出去的错误带 status=400，全局错误处理照旧回 400。
   */
  const httpErr = (msg, status = 400) => {
    const e = new Error(msg);
    e.status = status;
    return e;
  };

  // 价格只由后端计算。快照和报工在同一事务保存，失败一起回滚。
  const wageSnapshot=wageMultiplier.snapshot(orderId,node,{...b,bundle_no:bundleNo});
  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicate=replay();if(duplicate){db.exec('COMMIT');return ok(res,duplicate);}
    if(wageSnapshot&&wageMultiplier.read().revision!==wageSnapshot.config_revision)throw httpErr('工价倍率已更新，请重新确认',409);
    if(wageSnapshot){
     const previous=db.prepare('SELECT wage_snapshot,qty_ok,qty_defect FROM production_reports WHERE order_id=? AND node_id=? AND wage_snapshot IS NOT NULL').all(orderId,node.id);
     const used=previous.reduce((sum,r)=>{const s=JSON.parse(r.wage_snapshot);return s.style_key===wageSnapshot.style_key&&s.color===wageSnapshot.color?sum+Number(r.qty_ok)+Number(r.qty_defect):sum;},0);
     if(used+qtyOk+qtyDefect>wageSnapshot.color_qty)throw httpErr('该款该颜色累计报工不能超过订单颜色件数：'+wageSnapshot.color_qty+'件');
    }
    const alreadyReported = Number(db.prepare(
      'SELECT COALESCE(SUM(qty_ok + qty_defect),0) AS qty FROM production_reports WHERE order_id = ? AND node_id = ?'
    ).get(orderId, node.id).qty) || 0;
    if (alreadyReported + qtyOk + qtyDefect > totalQty + 0.0001) {
      throw httpErr(`「${node.name}」累计报工不能超过订单数量：订单 ${totalQty} 件，已报 ${alreadyReported} 件，本次 ${qtyOk + qtyDefect} 件`);
    }

    const info = db.prepare(
      `INSERT INTO production_reports (order_id, node_id, node_name, report_date, qty_ok, qty_defect, hours, operator, employee_id, remark, bundle_no, created_at,wage_snapshot,request_no,request_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      orderId, b.node_id || null, (node && node.name) || b.node_name || null,
      // 默认日期用本地时区：toISOString 是 UTC，晚上 8 点后报工会被记成前一天
      b.report_date || localDate(now()),
      qtyOk, qtyDefect, hours,
      operatorName, employeeId, b.remark || null, bundleNo, now(),wageSnapshot?JSON.stringify(wageSnapshot):null,requestNo,requestHash
    );
    const reportedAfterSave = Number(db.prepare(
      'SELECT COALESCE(SUM(qty_ok + qty_defect),0) AS qty FROM production_reports WHERE order_id = ? AND node_id = ?'
    ).get(orderId, node.id).qty) || 0;
    if (reportedAfterSave + 0.0001 >= totalQty && node.status !== 'done') {
      db.prepare("UPDATE order_nodes SET status = 'done', actual_date = ?, operator = COALESCE(?, operator) WHERE id = ?")
        .run(localDate(now()), operatorName || null, node.id);
    }
    db.exec('COMMIT');
    console.info('[production-report]',{id:Number(info.lastInsertRowid),operator:req.user.username,multiplier:wageSnapshot?.multiplier,revision:wageSnapshot?.config_revision});
    return ok(res, db.prepare('SELECT * FROM production_reports WHERE id = ?').get(Number(info.lastInsertRowid)));
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 已经自动回滚时不重复报错 */ }
    throw e;
  }
}
router.post('/',authRequired,requireRole(WRITE),wrap(createReport));

router.delete('/:id', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM production_reports WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '报工记录不存在');
  orderOr404(req.user, row.order_id);   // 别家的报工不能删
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(row.order_id);
  if (!order || order.status !== 'production') return fail(res, 400, '订单离开生产状态后，报工记录不可删除');

  /**
   * 删除 + 回写工序状态必须同一个事务
   *
   * 原来两步分开：先删记录，再按剩余量决定要不要把工序退回「待开始」。
   * 第二步失败（锁超时、进程被 kill）就留下「报工没了、工序还绿着」——
   * 看板上这一步显示已完成，实际一件都没做，而且没有任何地方会报错。
   */
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM production_reports WHERE id = ?').run(req.params.id);
    if (row.node_id) {
      const totalQty = Number(db.prepare('SELECT COALESCE(SUM(qty),0) AS qty FROM order_items WHERE order_id = ?').get(row.order_id).qty) || 0;
      const reported = Number(db.prepare(
        'SELECT COALESCE(SUM(qty_ok + qty_defect),0) AS qty FROM production_reports WHERE order_id = ? AND node_id = ?'
      ).get(row.order_id, row.node_id).qty) || 0;
      if (reported + 0.0001 < totalQty) {
        db.prepare("UPDATE order_nodes SET status='pending', actual_date=NULL WHERE id=? AND order_id=? AND status='done'")
          .run(row.node_id, row.order_id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 已自动回滚 */ }
    throw e;
  }
  return ok(res, { id: Number(req.params.id) });
}));

module.exports = router;
module.exports.createReport=createReport;
