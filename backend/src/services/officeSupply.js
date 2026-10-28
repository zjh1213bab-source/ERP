/**
 * 办公耗材与服务采购（TS-N14-07）
 * ========================================================================
 * 一句话：办公用品有自己的仓、自己的流水、自己的申领单；
 * 采购验收时**一次把三件事做完**（入库 / 耐用品转资产 / 生成费用），三者互不重复。
 *
 * ## 为什么不复用面辅料那套（`materials` + `material_ledger`）
 *
 * 原型原话：**「材料生产仓不会被办公领用误扣」**。
 * 共用的后果是真实存在的：面料库存里出现「A4 纸 -5 包」，齐套算料把打印纸算成缺料，
 * 月底盘点两边都解释不清。所以这里单独一套 `office_stock` / `office_ledger`，
 * 与本厂生产物料**没有任何写入口**。
 *
 * ## 验收为什么要分 three-way
 *
 * 一张采购单里常常既有耗材又有耐用品（「打印纸 10 包 + 打印机 2 台」）。
 * 全进费用 → 打印机被全额费用化，资产台账里没有它，明年盘点对不上；
 * 全进资产 → 打印纸成了固定资产，财务要按 5 年折旧一包纸。
 * 所以按明细行的 `durable` 分开算，**金额各走一边，绝不重叠**。
 */
const { db, now } = require('../db');
const { localDate } = require('../utils/time');
const { nextNo } = require('../utils/docNo');
const B = require('./budget');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const today = () => localDate(now());
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;

const CATEGORY = {
  stationery: '文具',
  printing: '打印耗材',
  cleaning: '清洁用品',
  ppe: '劳保用品',
  electronic: '电子配件',
  furniture: '家具',
  service: '服务'
};

const REQ_STATUS = {
  draft: '草稿',
  submitted: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  issued: '已领用',
  returned: '部分退回',
  closed: '已结案'
};

const PO_STATUS = {
  draft: '草稿',
  approved: '已批准',
  ordered: '已下单',
  received: '已验收',
  closed: '已结束',
  cancelled: '已撤销'
};

const OPEN_REQ = ['draft', 'submitted', 'approved'];
const EXPENSE_CATEGORY = { item: '办公', service: '服务采购' };

/* ==================================================================== *
 * 一、字典与统计
 * ==================================================================== */

function dict() {
  const items = db.prepare("SELECT id, item_no, name, spec, unit, category, durable, monthly_limit FROM office_items WHERE status='active' ORDER BY category, name").all();
  const depts = db.prepare('SELECT id, name FROM departments ORDER BY id').all();
  return {
    categories: Object.entries(CATEGORY).map(([code, label]) => ({ code, label })),
    req_status: Object.entries(REQ_STATUS).map(([code, label]) => ({ code, label })),
    po_status: Object.entries(PO_STATUS).map(([code, label]) => ({ code, label })),
    items,
    depts,
    stats: stats()
  };
}

function stats() {
  const g = (sql, ...a) => db.prepare(sql).get(...a).c;
  const sum = (sql, ...a) => r2(db.prepare(sql).get(...a).v);
  const month = today().slice(0, 7);
  return {
    items: g("SELECT COUNT(*) c FROM office_items WHERE status='active'"),
    low_stock: g(`SELECT COUNT(*) c FROM office_items i LEFT JOIN office_stock s ON s.item_id=i.id
                   WHERE i.status='active' AND i.min_qty > 0 AND IFNULL(s.qty,0) < i.min_qty`),
    pending_req: g("SELECT COUNT(*) c FROM office_requests WHERE status IN ('submitted')"),
    to_issue: g("SELECT COUNT(*) c FROM office_requests WHERE status='approved'"),
    open_po: g("SELECT COUNT(*) c FROM office_purchases WHERE status IN ('approved','ordered')"),
    // 不按 department_id 过滤：办公采购都会挂部门，按「无部门」筛会把本模块自己入的账漏掉
    month_expense: sum(`SELECT COALESCE(SUM(amount),0) v FROM admin_expenses
                         WHERE substr(expense_date,1,7)=? AND category IN ('办公','服务采购')`, month),
    month_asset: sum(`SELECT COALESCE(SUM(asset_amount),0) v FROM office_purchases
                       WHERE status IN ('received','closed') AND substr(received_at,1,7)=?`, month),
    month_requests: g("SELECT COUNT(*) c FROM office_requests WHERE substr(created_at,1,7)=?", month)
  };
}

/* ==================================================================== *
 * 二、物品档案
 * ==================================================================== */

function listItems(q = {}) {
  const w = ["i.status <> 'deleted'"];
  const a = [];
  if (q.category) { w.push('i.category = ?'); a.push(q.category); }
  if (q.durable === '1' || q.durable === 1) { w.push('i.durable = 1'); }
  if (q.q) { w.push('(i.name LIKE ? OR i.item_no LIKE ? OR IFNULL(i.spec,\'\') LIKE ?)'); const k = `%${q.q}%`; a.push(k, k, k); }
  const rows = db.prepare(
    `SELECT i.*, IFNULL(s.qty,0) qty, IFNULL(s.avg_price,0) avg_price, s.location
       FROM office_items i LEFT JOIN office_stock s ON s.item_id = i.id
      WHERE ${w.join(' AND ')}
      ORDER BY i.category, i.name`
  ).all(...a);
  return rows.map((r) => {
    // 先算出来再用：写在对象字面量里引 r.low 是拿不到刚定义的那个字段的（会恒为 undefined）
    const low = num(r.min_qty) > 0 && num(r.qty) < num(r.min_qty);
    return {
      ...r,
      category_label: CATEGORY[r.category] || r.category,
      low,
      // 耐用品不进办公仓（验收即转资产），库存显示 0 不是「缺货」，要说清楚
      stock_note: num(r.durable) ? '耐用品：验收后直接转资产，不占办公仓' : null,
      // 建议采购量：补到最低库存的 2 倍，只给建议，不自动下单
      suggest_qty: low ? Math.max(1, Math.ceil(num(r.min_qty) * 2 - num(r.qty))) : 0
    };
  });
}

function saveItem(body = {}, operator) {
  const name = String(body.name || '').trim();
  if (name.length < 2) throw bad('物品名称至少 2 个字');
  const category = CATEGORY[body.category] ? body.category : 'stationery';
  const unit = String(body.unit || '个').trim() || '个';
  const durable = body.durable ? 1 : 0;
  if (durable && !String(body.asset_category || '').trim()) {
    throw bad('耐用品必须填资产分类（建资产卡时要用，空着在资产台账里会归不进任何一类）');
  }
  const t = now();

  if (body.id) {
    const row = db.prepare('SELECT * FROM office_items WHERE id = ?').get(Number(body.id));
    if (!row) throw bad('物品不存在', 404);
    db.prepare(
      `UPDATE office_items SET name=?, spec=?, category=?, unit=?, min_qty=?, durable=?, asset_category=?,
         useful_years=?, monthly_limit=?, default_supplier=?, status=?, note=?, updated_at=? WHERE id=?`
    ).run(name, body.spec || null, category, unit, r2(body.min_qty), durable,
      body.asset_category || null, body.useful_years ? Number(body.useful_years) : null,
      r2(body.monthly_limit), body.default_supplier || null, body.status || row.status,
      body.note || null, t, row.id);
    return { id: row.id, item_no: row.item_no };
  }

  const no = nextNo('BG', 'office_items', 'item_no');
  const info = db.prepare(
    `INSERT INTO office_items (item_no, company_id, name, spec, category, unit, min_qty, durable, asset_category,
       useful_years, monthly_limit, default_supplier, status, note, created_at, updated_at)
     VALUES (?,1,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,?)`
  ).run(no, name, body.spec || null, category, unit, r2(body.min_qty), durable,
    body.asset_category || null, body.useful_years ? Number(body.useful_years) : null,
    r2(body.monthly_limit), body.default_supplier || null, body.note || null, t, t);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO office_stock (item_id, qty, avg_price, location, updated_at) VALUES (?,0,0,?,?)')
    .run(id, body.location || null, t);
  return { id, item_no: no };
}

/* ==================================================================== *
 * 三、库存与流水
 * ==================================================================== */

function board(q = {}) {
  return listItems(q);
}

/**
 * 最低库存缺口 —— **只提示**，不自动生成采购单（原型原话）
 * 自动补货在没人核价的项目上等于自动花钱。
 */
function lowStock() {
  const rows = listItems({}).filter((r) => r.low);
  return {
    rows,
    count: rows.length,
    note: '低于最低库存只做提示，不会自动下单。确认需要补货后，在「采购与服务」里选物品建单 —— '
      + '自动补货等于在没人核价的项目上自动花钱。'
  };
}

function ledger(q = {}) {
  const w = [];
  const a = [];
  if (q.item_id) { w.push('l.item_id = ?'); a.push(Number(q.item_id)); }
  if (q.type) { w.push('l.type = ?'); a.push(q.type); }
  if (q.month) { w.push('substr(l.created_at,1,7) = ?'); a.push(q.month); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  return db.prepare(
    `SELECT l.*, i.name item_name, i.unit FROM office_ledger l
       LEFT JOIN office_items i ON i.id = l.item_id
       ${where} ORDER BY l.id DESC LIMIT 300`
  ).all(...a).map((r) => ({
    ...r,
    type_label: { in: '入库', out: '领用', back: '退回', adjust: '调整' }[r.type] || r.type
  }));
}

/** 写流水并同步库存（唯一入口，外面不许直接改 office_stock.qty） */
function moveStock(itemId, delta, meta = {}) {
  const t = now();
  const qty = r2(delta);
  const st = db.prepare('SELECT * FROM office_stock WHERE item_id = ?').get(itemId);
  if (!st) {
    db.prepare('INSERT INTO office_stock (item_id, qty, avg_price, updated_at) VALUES (?,?,0,?)').run(itemId, qty, t);
  } else {
    const next = r2(num(st.qty) + qty);
    // 允许为负只可能出现在盘点调整；业务路径上都先校验，不会走到这里
    db.prepare('UPDATE office_stock SET qty = ?, updated_at = ? WHERE item_id = ?').run(next, t, itemId);
  }
  db.prepare(
    `INSERT INTO office_ledger (item_id, type, qty, ref_type, ref_id, ref_no, dept_id, operator, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(itemId, meta.type, qty, meta.ref_type || null, meta.ref_id || null, meta.ref_no || null,
    meta.dept_id || null, meta.operator || null, meta.note || null, t);
}

function stockOf(itemId) {
  const s = db.prepare('SELECT qty FROM office_stock WHERE item_id = ?').get(itemId);
  return r2(s ? s.qty : 0);
}

/* ==================================================================== *
 * 四、申领单
 * ==================================================================== */

/** 本月某部门已领用某物品的数量（月限额口径：按实际出库算，不按申请算） */
function monthIssuedOf(itemId, deptId) {
  const month = today().slice(0, 7);
  const row = db.prepare(
    `SELECT COALESCE(SUM(-qty),0) v FROM office_ledger
      WHERE item_id = ? AND type = 'out' AND IFNULL(dept_id,0) = ? AND substr(created_at,1,7) = ?`
  ).get(Number(itemId), Number(deptId) || 0, month);
  return r2(row.v);
}

/** 同一人同一物品是否已有未结申领（重复领用拦截） */
function openReqOf(requester, itemId) {
  return db.prepare(
    `SELECT r.req_no FROM office_request_items ri
       JOIN office_requests r ON r.id = ri.request_id
      WHERE r.requester = ? AND ri.item_id = ? AND r.status IN ('submitted','approved')`
  ).get(requester, Number(itemId));
}

function decorateReq(row) {
  const items = db.prepare(
    `SELECT ri.*, i.category, i.durable, IFNULL(s.qty,0) stock_qty
       FROM office_request_items ri
       LEFT JOIN office_items i ON i.id = ri.item_id
       LEFT JOIN office_stock s ON s.item_id = ri.item_id
      WHERE ri.request_id = ? ORDER BY ri.id`
  ).all(row.id);
  const src = db.prepare(
    `SELECT ps.purchase_id, p.po_no, p.status FROM office_purchase_sources ps
       JOIN office_purchases p ON p.id = ps.purchase_id
      WHERE ps.request_id = ? ORDER BY ps.id DESC LIMIT 1`
  ).get(row.id);
  return {
    ...row,
    status_label: REQ_STATUS[row.status] || row.status,
    items,
    total_qty: r2(items.reduce((s, x) => s + num(x.qty_apply), 0)),
    merged: src && !['cancelled'].includes(src.status) ? { purchase_id: src.purchase_id, po_no: src.po_no, status: src.status } : null,
    open: OPEN_REQ.includes(row.status),
    // 已批准但库存不够出库的，要在列表上直接看出来
    short: row.status === 'approved' && items.some((x) => num(x.qty_approved) > num(x.stock_qty))
  };
}

function listRequests(q = {}) {
  const w = [];
  const a = [];
  if (q.status === 'open') w.push("r.status IN ('draft','submitted','approved')");
  else if (q.status) { w.push('r.status = ?'); a.push(q.status); }
  if (q.dept_id) { w.push('r.dept_id = ?'); a.push(Number(q.dept_id)); }
  if (q.q) { w.push('(r.req_no LIKE ? OR r.requester_name LIKE ? OR IFNULL(r.purpose,\'\') LIKE ?)'); const k = `%${q.q}%`; a.push(k, k, k); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  return db.prepare(
    `SELECT r.* FROM office_requests r ${where}
      ORDER BY CASE r.status WHEN 'submitted' THEN 0 WHEN 'approved' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, r.id DESC
      LIMIT 200`
  ).all(...a).map(decorateReq);
}

function requestDetail(id) {
  const row = db.prepare('SELECT * FROM office_requests WHERE id = ?').get(Number(id));
  if (!row) throw bad('申领单不存在', 404);
  const d = decorateReq(row);
  d.items = d.items.map((x) => {
    const item = db.prepare('SELECT * FROM office_items WHERE id = ?').get(x.item_id);
    return {
      ...x,
      monthly_limit: item ? num(item.monthly_limit) : 0,
      month_issued: monthIssuedOf(x.item_id, row.dept_id),
      available: num(x.stock_qty)
    };
  });
  d.can = {
    submit: row.status === 'draft',
    approve: row.status === 'submitted',
    issue: row.status === 'approved',
    reject: row.status === 'submitted',
    returnItems: ['issued', 'returned'].includes(row.status)
  };
  return d;
}

/**
 * 建申领单（草稿或直接提交）
 * 三道闸在这里与 submit 各拦一次：草稿可以先存，提交必须过闸
 */
function saveRequest(body = {}, operator) {
  const items = Array.isArray(body.items) ? body.items.filter((x) => x && num(x.qty_apply) > 0) : [];
  if (!items.length) throw bad('至少填一行申领物品，数量要大于 0');
  const deptId = Number(body.dept_id) || null;
  const dept = deptId ? db.prepare('SELECT id, name FROM departments WHERE id = ?').get(deptId) : null;
  if (deptId && !dept) throw bad('部门不存在');
  const requester = String(body.requester || operator || '').trim();
  if (!requester) throw bad('请填申领人');
  const purpose = String(body.purpose || '').trim();
  if (purpose.length < 4) throw bad('申领事由至少 4 个字（「办公用」三个字事后看不出为什么领）');

  const t = now();
  const no = nextNo('SQ', 'office_requests', 'req_no');
  const status = body.submit ? 'submitted' : 'draft';

  // 明细校验：物品存在、数量为正、整数件（耐用品按件建卡，半件没有意义）
  const prepared = items.map((x) => {
    const item = db.prepare("SELECT * FROM office_items WHERE id = ? AND status = 'active'").get(Number(x.item_id));
    if (!item) throw bad(`物品 #${x.item_id} 不存在或已停用`);
    // 耐用品不进办公仓（验收时直接转资产），所以永远「库存 0」。
    // 让它走耗材申领的结果是：数量校验永远失败，或者勉强放行后从空仓里扣出负数。
    if (num(item.durable)) {
      throw bad(`「${item.name}」是耐用品，不走耗材申领 —— 请在「资产台账」里做领用登记（一物一码，要记保管人）`);
    }
    const qty = r2(x.qty_apply);
    if (!(qty > 0)) throw bad(`「${item.name}」的数量必须大于 0`);
    return { item, qty, note: x.note || null };
  });
  if (status === 'submitted') checkRequestGates(prepared, requester, deptId, body.exception_reason);

  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO office_requests (req_no, company_id, dept_id, dept_name, requester, requester_name, status,
         purpose, need_date, exception_reason, note, created_at, updated_at, demo_tag)
       VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(no, deptId, dept ? dept.name : null, requester, body.requester_name || null, status,
      purpose, body.need_date || null, body.exception_reason || null, body.note || null, t, t, body.demo_tag || null);
    const rid = Number(info.lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO office_request_items (request_id, item_id, item_name, unit, qty_apply, qty_approved, note) VALUES (?,?,?,?,?,0,?)'
    );
    prepared.forEach((p) => ins.run(rid, p.item.id, p.item.name, p.item.unit, p.qty, p.note));
    db.exec('COMMIT');
    return { id: rid, req_no: no, status, note: status === 'submitted' ? '已提交，等审批' : '草稿已保存' };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/**
 * 提交前的三道闸（原型：数量不足、重复领用、超权限配发 —— 拦截或例外审批）
 * 与审批时的校验共用这一份实现：抄两遍必然「建单拦、审批漏」。
 */
function checkRequestGates(prepared, requester, deptId, exceptionReason, opts = {}) {
  const exReason = String(exceptionReason || '').trim();
  const warnings = [];
  for (const p of prepared) {
    const stock = stockOf(p.item.id);
    if (!opts.allowShort && p.qty > stock + 0.001) {
      const hint = stock > 0
        ? `只能先领 ${stock} ${p.item.unit}，其余等采购到货`
        : '这项现在一件都没有，请先在「采购与服务」里采购到货';
      throw bad(`「${p.item.name}」库存只有 ${stock} ${p.item.unit}，申领 ${p.qty} 不够。${hint}`);
    }
    const dup = openReqOf(requester, p.item.id);
    if (dup) throw bad(`「${p.item.name}」你已经有一条未结的申领（${dup.req_no}），等它领完再提，避免重复领用`);
    if (num(p.item.monthly_limit) > 0) {
      const used = monthIssuedOf(p.item.id, deptId);
      if (used + p.qty > num(p.item.monthly_limit) + 0.001) {
        if (exReason.length < 6) {
          throw bad(`「${p.item.name}」本月本部门已领 ${used}，限额 ${p.item.monthly_limit}。超限领用要写例外说明（≥6 字），说明为什么必须超`);
        }
        warnings.push(`「${p.item.name}」超部门月限额（已领 ${used} / 限额 ${p.item.monthly_limit}），已记例外说明`);
      }
    }
  }
  return warnings;
}

function submitRequest(id, operator) {
  const row = db.prepare('SELECT * FROM office_requests WHERE id = ?').get(Number(id));
  if (!row) throw bad('申领单不存在', 404);
  if (row.status !== 'draft') throw bad(`当前状态「${REQ_STATUS[row.status]}」不能提交`);
  const items = db.prepare('SELECT * FROM office_request_items WHERE request_id = ?').all(row.id);
  const prepared = items.map((x) => ({
    item: db.prepare('SELECT * FROM office_items WHERE id = ?').get(x.item_id),
    qty: num(x.qty_apply)
  }));
  const warnings = checkRequestGates(prepared, row.requester, row.dept_id, row.exception_reason);
  db.prepare("UPDATE office_requests SET status='submitted', updated_at=? WHERE id=?").run(now(), row.id);
  return { id: row.id, status: 'submitted', warnings };
}

/**
 * 审批：可以砍量（qty_approved ≤ qty_apply）
 * 砍量而不是整单驳回 —— 申领 10 包只批 3 包是常态，整单驳回会让人重新提一次
 */
function approveRequest(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM office_requests WHERE id = ?').get(Number(id));
  if (!row) throw bad('申领单不存在', 404);
  if (row.status !== 'submitted') throw bad(`当前状态「${REQ_STATUS[row.status]}」不能审批`);
  const items = db.prepare('SELECT * FROM office_request_items WHERE request_id = ?').all(row.id);
  const input = Array.isArray(body.items) ? body.items : [];
  const t = now();
  let any = 0;

  db.exec('BEGIN');
  try {
    const upd = db.prepare('UPDATE office_request_items SET qty_approved = ? WHERE id = ?');
    items.forEach((x) => {
      const give = input.find((i) => Number(i.id) === x.id);
      const qty = give ? r2(give.qty_approved) : num(x.qty_apply);
      if (qty < 0) throw bad('批准数量不能为负');
      if (qty > num(x.qty_apply) + 0.001) throw bad(`「${x.item_name}」批准 ${qty} 超过申请 ${x.qty_apply}`);
      // 审批时再核一次库存：建单到审批之间可能被别人领走
      const stock = stockOf(x.item_id);
      if (qty > stock + 0.001) {
        throw bad(`「${x.item_name}」当前库存只有 ${stock}，批 ${qty} 出不了库。要么少批，要么先采购`);
      }
      if (qty > 0) any += 1;
      upd.run(qty, x.id);
    });
    if (!any) throw bad('一行都没批（全部批 0 等于驳回，请用驳回并写原因）');
    db.prepare("UPDATE office_requests SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?")
      .run(operator, t, t, row.id);
    // 批准了但库存不够的，明确告诉审批人「先采购」
    const shortages = db.prepare(
      `SELECT ri.item_name, ifnull(s.qty,0) stock, ri.qty_approved FROM office_request_items ri
         LEFT JOIN office_stock s ON s.item_id = ri.item_id WHERE ri.request_id = ? AND ri.qty_approved > ifnull(s.qty,0)`
    ).all(row.id);
    db.exec('COMMIT');
    return {
      id: row.id, status: 'approved',
      note: shortages.length ? `已批准，但 ${shortages.map((x) => x.item_name).join('、')} 库存不够，需先采购` : '已批准，可以去领用了'
    };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function rejectRequest(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM office_requests WHERE id = ?').get(Number(id));
  if (!row) throw bad('申领单不存在', 404);
  if (row.status !== 'submitted') throw bad(`当前状态「${REQ_STATUS[row.status]}」不能驳回`);
  const reason = String(body.reason || '').trim();
  if (reason.length < 6) throw bad('驳回要写清原因（≥6 字）—— 只写「不同意」，申领人下次还会提一样的');
  const t = now();
  db.prepare("UPDATE office_requests SET status='rejected', reject_reason=?, approved_by=?, approved_at=?, updated_at=? WHERE id=?")
    .run(reason, operator, t, t, row.id);
  return { id: row.id, status: 'rejected' };
}

/** 出库：真正扣库存的地方，扣完写入流水 */
function issueRequest(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM office_requests WHERE id = ?').get(Number(id));
  if (!row) throw bad('申领单不存在', 404);
  if (row.status !== 'approved') throw bad(`当前状态「${REQ_STATUS[row.status]}」不能出库`);
  const items = db.prepare('SELECT * FROM office_request_items WHERE request_id = ?').all(row.id)
    .filter((x) => num(x.qty_approved) > 0);
  if (!items.length) throw bad('没有可出库的行');

  const t = now();
  db.exec('BEGIN');
  try {
    items.forEach((x) => {
      const stock = stockOf(x.item_id);
      const qty = num(x.qty_approved);
      if (qty > stock + 0.001) {
        throw bad(`「${x.item_name}」库存只有 ${stock}，不够发 ${qty}。先采购到货再出库`);
      }
      moveStock(x.item_id, -qty, {
        type: 'out', ref_type: 'request', ref_id: row.id, ref_no: row.req_no,
        dept_id: row.dept_id, operator, note: `申领出库 · ${row.requester_name || row.requester}`
      });
      db.prepare('UPDATE office_request_items SET qty_issued = ? WHERE id = ?').run(qty, x.id);
    });
    db.prepare("UPDATE office_requests SET status='issued', issued_by=?, issued_at=?, updated_at=? WHERE id=?")
      .run(operator, t, t, row.id);
    db.exec('COMMIT');
    return { id: row.id, status: 'issued', note: `已出库 ${items.length} 项，库存已扣减并记流水` };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** 退回：领了用不完退回仓库 */
function returnRequest(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM office_requests WHERE id = ?').get(Number(id));
  if (!row) throw bad('申领单不存在', 404);
  if (!['issued', 'returned'].includes(row.status)) throw bad('只有已领用的单能退');
  const input = Array.isArray(body.items) ? body.items : [];
  const lines = db.prepare('SELECT * FROM office_request_items WHERE request_id = ?').all(row.id);
  const plan = input.map((x) => {
    const line = lines.find((l) => l.id === Number(x.id));
    if (!line) throw bad(`明细 #${x.id} 不属于这张申领单`);
    const qty = r2(x.qty);
    if (!(qty > 0)) throw bad('退回数量要大于 0');
    const can = r2(num(line.qty_issued) - num(line.qty_returned));
    if (qty > can + 0.001) throw bad(`「${line.item_name}」已领 ${line.qty_issued}、已退 ${line.qty_returned}，最多还能退 ${can}`);
    return { line, qty };
  });
  if (!plan.length) throw bad('请填要退回的数量');

  const t = now();
  db.exec('BEGIN');
  try {
    plan.forEach((p) => {
      moveStock(p.line.item_id, p.qty, {
        type: 'back', ref_type: 'request', ref_id: row.id, ref_no: row.req_no,
        dept_id: row.dept_id, operator, note: `领用退回 · ${body.reason || ''}`.trim()
      });
      db.prepare('UPDATE office_request_items SET qty_returned = qty_returned + ? WHERE id = ?').run(p.qty, p.line.id);
    });
    // 全退完记 returned，部分退也记 returned（结案与否看人；结案不是必须的动作）
    db.prepare("UPDATE office_requests SET status='returned', updated_at=? WHERE id=?").run(t, row.id);
    db.exec('COMMIT');
    return { id: row.id, status: 'returned', note: `已退回 ${plan.length} 项，库存已回补` };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ==================================================================== *
 * 五、采购（物品 + 服务）
 * ==================================================================== */

function decoratePo(row) {
  const items = db.prepare('SELECT * FROM office_purchase_items WHERE purchase_id = ? ORDER BY id').all(row.id);
  const sources = db.prepare('SELECT request_id, req_no FROM office_purchase_sources WHERE purchase_id = ?').all(row.id);
  const dept = row.dept_id ? db.prepare('SELECT name FROM departments WHERE id = ?').get(row.dept_id) : null;
  return {
    ...row,
    status_label: PO_STATUS[row.status] || row.status,
    kind_label: row.kind === 'service' ? '服务采购' : '物品采购',
    dept_name: dept ? dept.name : null,
    items,
    sources,
    durable_amount: r2(items.filter((x) => num(x.durable)).reduce((s, x) => s + num(x.amount), 0)),
    consumable_amount: r2(items.filter((x) => !num(x.durable)).reduce((s, x) => s + num(x.amount), 0)),
    can: {
      submit: row.status === 'draft',
      approve: ['draft', 'submitted'].includes(row.status),
      receive: ['approved', 'ordered'].includes(row.status),
      cancel: ['draft', 'submitted', 'approved', 'ordered'].includes(row.status)
    }
  };
}

function listPurchases(q = {}) {
  const w = [];
  const a = [];
  if (q.status) { w.push('status = ?'); a.push(q.status); }
  if (q.kind) { w.push('kind = ?'); a.push(q.kind); }
  if (q.q) { w.push('(po_no LIKE ? OR IFNULL(supplier,\'\') LIKE ?)'); const k = `%${q.q}%`; a.push(k, k); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM office_purchases ${where} ORDER BY id DESC LIMIT 200`).all(...a).map(decoratePo);
}

function purchaseDetail(id) {
  const row = db.prepare('SELECT * FROM office_purchases WHERE id = ?').get(Number(id));
  if (!row) throw bad('采购单不存在', 404);
  return decoratePo(row);
}

/**
 * 建采购单
 * 两种来源：① 从已批准的申领合并（自动带出物品与数量）② 手工建（含服务采购）
 */
function createPurchase(body = {}, operator) {
  const reqIds = Array.isArray(body.request_ids) ? body.request_ids.map(Number).filter(Boolean) : [];
  const manualItems = Array.isArray(body.items) ? body.items.filter((x) => x && num(x.qty) > 0) : [];
  const kind = reqIds.length ? 'item' : (body.kind === 'service' ? 'service' : 'item');
  if (!reqIds.length && !manualItems.length) throw bad('采购单至少要有明细（或从申领单合并）');

  const supplier = String(body.supplier || '').trim();
  if (supplier.length < 2) throw bad('请填供应商 / 服务商名称（没有对手方的采购单事后没法对账）');

  // 合并来源校验：必须是已批准、且没被别的在途采购单占用
  const reqRows = reqIds.map((id) => {
    const r = db.prepare('SELECT * FROM office_requests WHERE id = ?').get(id);
    if (!r) throw bad(`申领单 #${id} 不存在`);
    if (r.status !== 'approved') throw bad(`申领单 ${r.req_no} 状态是「${REQ_STATUS[r.status]}」，只有已批准的才能合并采购`);
    const used = db.prepare(
      `SELECT p.po_no FROM office_purchase_sources ps JOIN office_purchases p ON p.id = ps.purchase_id
        WHERE ps.request_id = ? AND p.status <> 'cancelled'`
    ).get(id);
    if (used) throw bad(`申领单 ${r.req_no} 已在采购单 ${used.po_no} 里，不能重复合并`);
    return r;
  });

  const t = now();
  const no = nextNo('CG', 'office_purchases', 'po_no');

  // 归属部门：优先取入参，其次取被合并申领的部门（全同才用），最后落到「人事行政部」。
  // 为什么要麻烦：budget.commit 对 department_id 为空**直接返回 null**，
  // 不挂部门的采购在预算执行表里根本不出现，月底一看「这个月办公没花钱」。
  const reqDepts = [...new Set(reqRows.map((r) => Number(r.dept_id) || 0))];
  let deptId = Number(body.dept_id) || null;
  if (!deptId && reqDepts.length === 1 && reqDepts[0]) deptId = reqDepts[0];
  if (!deptId) {
    const admin = db.prepare("SELECT id FROM departments WHERE name LIKE '%行政%' ORDER BY id LIMIT 1").get();
    deptId = admin ? admin.id : null;
  }

  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO office_purchases (po_no, company_id, kind, dept_id, supplier, status, total_amount, expected_date, note,
         created_by, created_at, updated_at, demo_tag)
       VALUES (?,1,?,?,?, 'draft', 0, ?,?,?,?,?,?)`
    ).run(no, kind, deptId, supplier, body.expected_date || null, body.note || null, operator, t, t, body.demo_tag || null);
    const pid = Number(info.lastInsertRowid);

    const insLine = db.prepare(
      `INSERT INTO office_purchase_items (purchase_id, line_type, item_id, item_name, spec, unit, qty, price, amount, durable, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );

    if (reqIds.length) {
      // 合并同一物品的多张申领 → 一行汇总（这就是「需求合并」的意义：不要按单分开买）
      const agg = new Map();
      const lines = db.prepare(
        `SELECT ri.*, i.spec, i.unit, i.durable, i.default_supplier
           FROM office_request_items ri JOIN office_items i ON i.id = ri.item_id
          WHERE ri.request_id IN (${reqIds.map(() => '?').join(',')})`
      ).all(...reqIds);
      lines.forEach((l) => {
        const qty = num(l.qty_approved) - num(l.qty_issued);
        if (qty <= 0) return;
        const key = l.item_id;
        if (!agg.has(key)) {
          agg.set(key, { id: l.item_id, name: l.item_name, spec: l.spec, unit: l.unit, qty: 0, durable: l.durable });
        }
        agg.get(key).qty = r2(agg.get(key).qty + qty);
      });
      if (!agg.size) throw bad('这些申领单里没有「已批准但未领用」的数量，不需要采购');
      agg.forEach((x) => {
        const price = Number(body.prices && body.prices[x.id]) || 0;
        insLine.run(pid, 'item', x.id, x.name, x.spec, x.unit, x.qty, price, r2(x.qty * price), x.durable ? 1 : 0, null);
      });
      const insSrc = db.prepare('INSERT INTO office_purchase_sources (purchase_id, request_id, req_no) VALUES (?,?,?)');
      reqRows.forEach((r) => insSrc.run(pid, r.id, r.req_no));
    } else {
      manualItems.forEach((x) => {
        const lineType = x.line_type === 'service' || kind === 'service' ? 'service' : 'item';
        if (lineType === 'service') {
          const name = String(x.item_name || '').trim();
          if (name.length < 2) throw bad('服务项要写清是什么服务（保洁 / 空调维修 / 快递月结…）');
          insLine.run(pid, 'service', null, name, x.spec || null, x.unit || '次',
            r2(x.qty), r2(x.price), r2(num(x.qty) * num(x.price)), 0, x.note || null);
          return;
        }
        const item = db.prepare("SELECT * FROM office_items WHERE id = ? AND status='active'").get(Number(x.item_id));
        if (!item) throw bad(`物品 #${x.item_id} 不存在或已停用`);
        insLine.run(pid, 'item', item.id, item.name, item.spec, item.unit, r2(x.qty), r2(x.price),
          r2(num(x.qty) * num(x.price)), item.durable, x.note || null);
      });
    }

    // 金额只在明确给了单价时才有意义：0 元采购单会在验收时被当成免费，必须提醒
    const total = r2(db.prepare('SELECT COALESCE(SUM(amount),0) v FROM office_purchase_items WHERE purchase_id = ?').get(pid).v);
    db.prepare('UPDATE office_purchases SET total_amount = ?, updated_at = ? WHERE id = ?').run(total, t, pid);
    db.exec('COMMIT');
    return {
      id: pid, po_no: no, total_amount: total,
      note: total > 0 ? '已建单，核对单价后可审批' : '已建单，但还没填单价（金额 0）。验收前必须补上，否则费用会是 0'
    };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** 填单价（合并来的单默认没价，必须人工核价） */
function setPrices(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM office_purchases WHERE id = ?').get(Number(id));
  if (!row) throw bad('采购单不存在', 404);
  if (!['draft', 'submitted'].includes(row.status)) throw bad('已审批的单不能改价，撤销后重建');
  const lines = Array.isArray(body.items) ? body.items : [];
  const t = now();
  db.exec('BEGIN');
  try {
    const upd = db.prepare('UPDATE office_purchase_items SET price = ?, amount = ? WHERE id = ? AND purchase_id = ?');
    lines.forEach((x) => {
      const price = r2(x.price);
      if (price < 0) throw bad('单价不能为负');
      const line = db.prepare('SELECT * FROM office_purchase_items WHERE id = ? AND purchase_id = ?').get(Number(x.id), row.id);
      if (!line) throw bad(`明细 #${x.id} 不属于这张采购单`);
      upd.run(price, r2(num(line.qty) * price), line.id, row.id);
    });
    const total = r2(db.prepare('SELECT COALESCE(SUM(amount),0) v FROM office_purchase_items WHERE purchase_id = ?').get(row.id).v);
    db.prepare('UPDATE office_purchases SET total_amount = ?, updated_at = ? WHERE id = ?').run(total, t, row.id);
    db.exec('COMMIT');
    return { id: row.id, total_amount: total };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function approvePurchase(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM office_purchases WHERE id = ?').get(Number(id));
  if (!row) throw bad('采购单不存在', 404);
  if (!['draft', 'submitted'].includes(row.status)) throw bad(`当前状态「${PO_STATUS[row.status]}」不能审批`);
  if (num(row.total_amount) <= 0) throw bad('金额为 0 的采购单不能审批 —— 先填单价');
  const t = now();
  db.prepare("UPDATE office_purchases SET status='approved', updated_at=? WHERE id=?").run(t, row.id);
  return { id: row.id, status: 'approved' };
}

function orderPurchase(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM office_purchases WHERE id = ?').get(Number(id));
  if (!row) throw bad('采购单不存在', 404);
  if (row.status !== 'approved') throw bad('只有已批准的单能标「已下单」');
  const t = now();
  db.prepare("UPDATE office_purchases SET status='ordered', expected_date=COALESCE(?,expected_date), updated_at=? WHERE id=?")
    .run(body.expected_date || null, t, row.id);
  return { id: row.id, status: 'ordered' };
}

/**
 * 验收 —— 本模块最关键的一步，一次做完三件事
 *
 * ① 耗材 → 入办公仓 + 写流水
 * ② 耐用品 → 逐件建资产卡片（一物一码），**金额不进费用**
 * ③ 费用 → 只把「耗材 + 服务」的金额生成一条行政支出，并占用预算
 *
 * 原型两句原话都落在这里：「采购验收和费用入账同源」「耐用品转资产不再当耗材重复费用化」。
 */
function receivePurchase(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM office_purchases WHERE id = ?').get(Number(id));
  if (!row) throw bad('采购单不存在', 404);
  if (!['approved', 'ordered'].includes(row.status)) throw bad(`当前状态「${PO_STATUS[row.status]}」不能验收${row.status === 'received' ? '（已经验收过了）' : ''}`);
  const lines = db.prepare('SELECT * FROM office_purchase_items WHERE purchase_id = ?').all(row.id);
  if (!lines.length) throw bad('采购单没有明细');
  if (num(row.total_amount) <= 0) throw bad('金额为 0 不能验收（费用会是 0，账上就丢了这笔）');

  const t = now();
  const day = today();
  db.exec('BEGIN');
  try {
    let expenseAmount = 0;
    let assetAmount = 0;
    const assetCreated = [];

    for (const line of lines) {
      if (line.line_type === 'service') {
        // 服务没有库存，验收即计费
        expenseAmount = r2(expenseAmount + num(line.amount));
        continue;
      }
      if (num(line.durable)) {
        // 耐用品：一物一码，逐件建卡；金额进资产、不进费用
        const qty = Math.round(num(line.qty));
        if (qty <= 0) throw bad(`「${line.item_name}」数量为 0，不能验收`);
        const item = db.prepare('SELECT * FROM office_items WHERE id = ?').get(line.item_id);
        const unitValue = r2(num(line.amount) / qty);
        for (let i = 0; i < qty; i++) {
          const code = nextNo('ZC', 'assets', 'code');
          const info = db.prepare(
            `INSERT INTO assets (code, name, category, dept, keeper, purchase_date, original_value, salvage_rate,
               useful_years, status, remark, created_at, updated_at, company_id)
             VALUES (?,?,?,?,?,?,?,?,?, 'in_use', ?,?,?,1)`
          ).run(code, line.item_name, (item && item.asset_category) || '办公设备', null, operator,
            day, unitValue, 0.05, (item && item.useful_years) || 5,
            `办公采购 ${row.po_no} 验收转入`, t, t);
          assetCreated.push({ asset_id: Number(info.lastInsertRowid), code, name: line.item_name });
          assetAmount = r2(assetAmount + unitValue);
        }
        db.prepare('UPDATE office_purchase_items SET asset_id = ? WHERE id = ?')
          .run(assetCreated[assetCreated.length - 1].asset_id, line.id);
        continue;
      }
      // 耗材：入库 + 流水 + 计入费用
      moveStock(line.item_id, num(line.qty), {
        type: 'in', ref_type: 'purchase', ref_id: row.id, ref_no: row.po_no,
        operator, note: `采购验收 · ${row.supplier || ''}`.trim()
      });
      const st = db.prepare('SELECT * FROM office_stock WHERE item_id = ?').get(line.item_id);
      if (st && num(line.qty) > 0) {
        // 移动加权：只用于估算金额，不做成本核算（办公耗材不值得走存货计价）
        const nextQty = num(st.qty);
        const unit = r2(num(line.amount) / num(line.qty));
        const avg = nextQty > 0
          ? r2((num(st.avg_price) * (nextQty - num(line.qty)) + unit * num(line.qty)) / nextQty)
          : unit;
        db.prepare('UPDATE office_stock SET avg_price = ? WHERE item_id = ?').run(Math.max(0, avg), line.item_id);
      }
      expenseAmount = r2(expenseAmount + num(line.amount));
    }

    // 生成费用：只有耗材 + 服务部分，耐用品已经进资产了
    let expenseId = null;
    let budgetNote = null;
    if (expenseAmount > 0) {
      const category = EXPENSE_CATEGORY[row.kind] || '办公';
      const info = db.prepare(
        `INSERT INTO admin_expenses (expense_date, category, amount, payee, handler, payment_method, remark,
           department_id, budget_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(day, category, expenseAmount, row.supplier || null, operator, body.payment_method || null,
        `办公采购 ${row.po_no} 验收自动入账（耐用品 ${assetAmount} 已转资产，不在本条）`,
        row.dept_id || null, null, t);
      expenseId = Number(info.lastInsertRowid);

      // 占用预算：与在「费用」页手工录一条的行为完全一致，否则预算报表会少这笔
      if (row.dept_id) {
        try {
          B.commit({
            department_id: row.dept_id,
            account_code: '6602',
            period: B.periodOf(day),
            amount: expenseAmount,
            source_type: 'office_purchase',
            source_id: row.id,
            source_no: `${row.po_no} ${row.supplier || ''}`.trim(),
            remark: '办公采购验收',
            operator
          });
        } catch (e) {
          budgetNote = `预算占用没记上（${e.message}），这笔费用在预算执行表里会缺一行，请手工补`;
        }
      } else {
        budgetNote = '采购单没有归属部门，费用已入账但**没占预算额度** —— 预算执行表里看不到这笔';
      }
    }

    db.prepare(
      `UPDATE office_purchases SET status='received', expense_amount=?, asset_amount=?, expense_id=?,
         received_by=?, received_at=?, updated_at=? WHERE id=?`
    ).run(expenseAmount, assetAmount, expenseId, operator, t, t, row.id);
    db.exec('COMMIT');

    return {
      id: row.id, status: 'received',
      expense_amount: expenseAmount,
      asset_amount: assetAmount,
      assets: assetCreated,
      expense_id: expenseId,
      note: [
        expenseAmount > 0 ? `已生成行政支出 ${expenseAmount}（耗材 + 服务）` : '本单没有需要计费用的行',
        assetCreated.length ? `${assetCreated.length} 件耐用品已转资产（${assetAmount}），不再计入费用` : null,
        expenseAmount === 0 && !assetCreated.length ? '没有耗材也没有服务，什么也没发生' : null,
        budgetNote
      ].filter(Boolean).join('；')
    };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function cancelPurchase(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM office_purchases WHERE id = ?').get(Number(id));
  if (!row) throw bad('采购单不存在', 404);
  if (['received', 'closed'].includes(row.status)) throw bad('已验收的单不能撤销 —— 货已经入库、费用已经入账，要退就走退货流程');
  if (row.status === 'cancelled') throw bad('已经是撤销状态');
  const reason = String(body.reason || '').trim();
  if (reason.length < 4) throw bad('撤销要写原因（≥4 字）');
  const t = now();
  db.prepare("UPDATE office_purchases SET status='cancelled', note=COALESCE(note||' · ','')||?, updated_at=? WHERE id=?")
    .run(`撤销：${reason}`, t, row.id);
  // 来源申领自动释放（下次可以重新合并）
  return { id: row.id, status: 'cancelled', note: '已撤销；合并的申领单已释放，可以重新合并' };
}

module.exports = {
  CATEGORY, REQ_STATUS, PO_STATUS,
  dict, stats, listItems, saveItem, board, lowStock, ledger, stockOf, monthIssuedOf,
  listRequests, requestDetail, saveRequest, submitRequest, approveRequest, rejectRequest, issueRequest, returnRequest,
  listPurchases, purchaseDetail, createPurchase, setPrices, approvePurchase, orderPurchase, receivePurchase, cancelPurchase
};
