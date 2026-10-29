/**
 * 资产工衣与领归（TS-N14-03）
 * ========================================================================
 * 这一层只回答一件事：**东西现在在谁身上，什么时候该回来**。
 *
 * 与相邻模块的边界（写清楚，免得三处各记一笔账）：
 *   - `assets`      固定资产卡：原值、折旧、净值、报废。本模块**不重算折旧**，
 *                   只读 `assetDep.withDepreciation` 的结果并标注来源。
 *   - `office_*`    办公耗材仓：入库、申领、库存。本模块**不发料、不扣库存**；
 *                   从办公仓领出来的耐用品转成资产卡后，才在这里做人的归属。
 *   - `custody_*`   人的归属：谁领了哪一件、什么时候还、坏了谁负责。
 *
 * ## 口径（每条都对应一种做错的方式）
 *
 * 1. **耐用实物不双领**：`durable=1` 时同一实物只能有一条未归还记录。
 *    库里还有部分唯一索引 `uq_custody_open_item` 兜底 —— 两个人同时点发放的竞态
 *    不会靠服务层的一次 SELECT 就挡住。
 *
 * 2. **「耐用」≠「必须归还」**：工衣一物一码但按原型「不把工衣全部强制退回」，
 *    所以 `require_return=0` 的实物**永不设归还期限、永不进超期清单**。
 *    合成一个字段的结果是工衣全部逾期，行政每天收到假警报，最后没人看这个清单。
 *
 * 3. **没有期限就不是逾期**：超期只认 `expected_return_at < 今天` 且未归还，
 *    不拿「领了很久」当逾期。
 *
 * 4. **消耗品按政策核销**：`durable=0` 领出即消耗，不进归还清单，
 *    核销只改状态、不冲任何库存（它本来就不在生产仓里）。
 *
 * 5. **损坏责任独立复核，不自动扣钱**：登记损坏只生成 `pending` 复核单；
 *    复核只出责任比例，`liable_amount` 必须有财务回执号才算落地。
 *    本模块**没有任何写工资、写应付、写凭证的语句**。
 *
 * 6. **处置不能两边各自报废**：挂了资产卡的实物拒绝在本模块核销，
 *    必须回资产台账走报废（那里有处置价款与折旧）；本模块只处置无资产卡的低值实物，
 *    且处置必须填去向与单号。
 *
 * 7. **已领出量不存冗余列**：一律从领用记录聚合（`SUM(qty − returned_qty)`），
 *    少一次写就没有漂移。
 */
const { db, now } = require('../db');
const { localDate } = require('../utils/time');
const { nextNo } = require('../utils/docNo');
const { round2, withDepreciation } = require('./assetDep');
const scope = require('../access/companyScope');

/**
 * 这一域的主体怎么判（**不需要加列**，全部走父表）
 *
 * - `custody_items` 自己就有 `company_id`（实物是哪个主体的资产）；
 * - `custody_records` 的 `item_id` 是 NOT NULL → 按实物判；
 * - `custody_claims` 也挂实物 → 按实物判（不用 record 冗余，实物更稳）；
 * - `custody_clearances` 挂员工 → 按 `employees.company_id` 判；
 * - `custody_actions` 是多态留痕日志，**故意不筛** —— 它记的是"谁在什么时候动了什么"，
 *   按主体过滤会让时间线缺环节，而时间线正是定责时要看的东西。
 *
 * 为什么"实物归属"是主口径而不是"员工归属"：一件工衣在分部仓里、发给总部来支援的人，
 * 这东西仍是分部的资产，盘点与处置要分部管；反过来按员工判，分部盘点时就看不到这件东西。
 */
const itemScope = (cid, col = 'item_id') => scope.parentClauseSql(cid, 'custody_items', col).sql;
const empScope = (cid, col = 'employee_id') => scope.parentClauseSql(cid, 'employees', col).sql;

/** 取一件实物并校验归属；跨主体按不存在（403 会承认存在性） */
function ownItem(id, companyId) {
  const row = db.prepare('SELECT * FROM custody_items WHERE id = ?').get(Number(id));
  if (!row) throw bad('实物不存在', 404);
  if (companyId && Number(row.company_id) !== Number(companyId)) throw bad('实物不存在', 404);
  return row;
}

/** 取一条领用记录并校验归属（按它挂的实物判） */
function ownRecord(id, companyId) {
  const row = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(Number(id));
  if (!row) throw bad('领用记录不存在', 404);
  if (companyId) {
    const it = db.prepare('SELECT company_id FROM custody_items WHERE id = ?').get(row.item_id);
    if (!it || Number(it.company_id) !== Number(companyId)) throw bad('领用记录不存在', 404);
  }
  return row;
}

/** 取一张清退单并校验归属（按员工判） */
function ownClearance(id, companyId) {
  const row = db.prepare('SELECT * FROM custody_clearances WHERE id = ?').get(Number(id));
  if (!row) throw bad('清退单不存在', 404);
  if (companyId && row.employee_id) {
    const e = db.prepare('SELECT company_id FROM employees WHERE id = ?').get(row.employee_id);
    if (!e || Number(e.company_id) !== Number(companyId)) throw bad('清退单不存在', 404);
  }
  return row;
}

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const today = () => localDate(now());
const num = (v) => Number(v) || 0;
const str = (v) => String(v === undefined || v === null ? '' : v).trim();

const KIND = { uniform: '工衣', tool: '工具', key: '钥匙', card: '门禁卡', ppe: '劳保用品', other: '其他' };
const STATUS = { draft: '草稿', issued: '使用中', awaiting: '待归还', returned: '已归还', lost: '遗失', written_off: '已核销' };
const COND = { good: '完好', worn: '磨损', damaged: '损坏', lost: '遗失' };
const REVIEW = { pending: '待复核', cleared: '无责', partial: '部分责任', liable: '全责', closed: '已结案' };
const DAMAGE = { damaged: '损坏', lost: '遗失' };
const SCRAP_MODE = { dispose: '报废变卖', transfer: '转出', write_off: '盘亏核销' };
const CLR_STATUS = { open: '清退中', closed: '已清完' };

/** 「还在人身上」的状态。草稿不占实物，遗失/核销表示东西已经没了 */
const OPEN = ['issued', 'awaiting'];

const labels = (map) => Object.entries(map).map(([code, label]) => ({ code, label }));

/* ==================================================================== *
 * 基础工具
 * ==================================================================== */

/** 只用于「多条写操作必须一起成功」的场景；校验一律放在 BEGIN 之前 */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 事务已结束 */ }
    throw e;
  }
}

function logAction(targetType, targetId, action, detail, qty, actor) {
  db.prepare('INSERT INTO custody_actions (target_type, target_id, action, detail, qty, actor, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(targetType, targetId, action, detail || null, qty === undefined ? null : num(qty), actor || 'system', now());
}

/** 某实物当前未还量（唯一的计算入口） */
function outQtyOf(itemId) {
  const r = db.prepare(
    "SELECT COALESCE(SUM(qty - returned_qty),0) q, COUNT(*) c FROM custody_records WHERE item_id = ? AND status IN ('issued','awaiting')"
  ).get(itemId);
  return { qty: round2(r.q), cnt: r.c };
}

function assetOf(assetId) {
  if (!assetId) return null;
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  return a ? withDepreciation(a) : null;
}

/** 实物行装饰：可用量、在谁手上、能不能再发 */
function decorItem(row) {
  if (!row) return null;
  const out = round2(num(row.out_qty));
  const total = num(row.qty_total);
  // 可发放量：冻结（损坏待处理）与已处置都必须显示 0 ——
  // 显示 1 却发不出去，比不显示更糟：行政会以为仓库里还有一件好的
  const isActive = row.status === 'active';
  const item = {
    ...row,
    kind_label: KIND[row.kind] || row.kind,
    durable: Number(row.durable) ? 1 : 0,
    require_return: Number(row.require_return) ? 1 : 0,
    status_label: { active: '在册', hold: '待处理', scrapped: '已处置' }[row.status] || row.status,
    out_qty: out,
    available: isActive ? Math.max(0, round2(total - out)) : 0,
    scrap_mode_label: SCRAP_MODE[row.scrap_mode] || ''
  };
  item.durable_label = item.durable ? '一物一码' : '按量消耗';
  item.return_label = item.require_return ? '必须归还' : '不强制退回';
  if (row.asset_id) {
    const a = assetOf(row.asset_id);
    if (a) {
      // 折旧来自资产台账，本模块只读
      item.asset_code = a.code || a.name;
      item.asset_name = a.name;
      item.asset_status = a.status;
      item.asset_status_label = a.status_label;
      item.asset_net = a.net_value;
      item.asset_original = a.original_value;
      item.asset_dep_source = 'assets（不重复计提）';
      item.asset_lost = a.status === 'scrapped';
    } else {
      item.asset_status = 'missing';
      item.asset_status_label = '资产卡已删除';
      item.asset_lost = true;
    }
  }
  // 能不能再发：原因要说清楚，不能只给一个灰按钮
  let block = '';
  if (item.status === 'scrapped') block = '已处置';
  else if (item.status === 'hold') block = '损坏待处理（先恢复或处置）';
  else if (item.asset_lost) block = '关联资产卡已报废';
  else if (item.available <= 0) block = row.holder ? `全部在「${row.holder}」手上` : '无可用数量';
  item.can_issue = !block;
  item.block_reason = block;
  return item;
}

const ITEM_SELECT = `
  SELECT i.*, a.code AS asset_code_ref,
    (SELECT r.employee_name FROM custody_records r
      WHERE r.item_id = i.id AND r.status IN ('issued','awaiting') ORDER BY r.id DESC LIMIT 1) AS holder,
    (SELECT r.rec_no FROM custody_records r
      WHERE r.item_id = i.id AND r.status IN ('issued','awaiting') ORDER BY r.id DESC LIMIT 1) AS holder_rec_no,
    COALESCE(o.q,0) AS out_qty
  FROM custody_items i
  LEFT JOIN assets a ON a.id = i.asset_id
  LEFT JOIN (SELECT item_id, SUM(qty - returned_qty) q FROM custody_records
             WHERE status IN ('issued','awaiting') GROUP BY item_id) o ON o.item_id = i.id
`;

function itemById(id) {
  const row = db.prepare(ITEM_SELECT + ' WHERE i.id = ?').get(id);
  return decorItem(row);
}

/* ==================================================================== *
 * 一、字典与统计
 * ==================================================================== */

function stats(companyId) {
  const t = today();
  const cid = Number(companyId) || null;
  const it = cid ? ' AND i.company_id = ' + cid : '';
  const items = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN durable=1 THEN 1 ELSE 0 END) d FROM custody_items i WHERE i.status='active'${it}`).get();
  const open = db.prepare(`SELECT COUNT(*) c FROM custody_records r JOIN custody_items i ON i.id = r.item_id WHERE r.status IN ('issued','awaiting')${it}`).get().c;
  const awaiting = db.prepare(`SELECT COUNT(*) c FROM custody_records r JOIN custody_items i ON i.id = r.item_id WHERE r.status='awaiting'${it}`).get().c;
  // 逾期只认有期限、要求归还、还没回来
  const overdue = db.prepare(`
    SELECT COUNT(*) c FROM custody_records r JOIN custody_items i ON i.id = r.item_id
    WHERE r.status IN ('issued','awaiting') AND i.require_return = 1
      AND r.expected_return_at IS NOT NULL AND r.expected_return_at < ?${it}`).get(t).c;
  // 工衣这类不强制退回的，单列「不催」，不混进逾期
  const optionalOut = db.prepare(`
    SELECT COUNT(*) c, COALESCE(SUM(r.qty - r.returned_qty),0) q FROM custody_records r
    JOIN custody_items i ON i.id = r.item_id
    WHERE r.status IN ('issued','awaiting') AND i.require_return = 0${it}`).get();
  const due7 = db.prepare(`
    SELECT COUNT(*) c FROM custody_records r JOIN custody_items i ON i.id = r.item_id
    WHERE r.status IN ('issued','awaiting') AND i.require_return = 1
      AND r.expected_return_at >= ? AND r.expected_return_at <= ?${it}`)
    .get(t, localDate(new Date(Date.now() + 7 * 86400000).toISOString())).c;
  const cl = cid ? ' AND ' + itemScope(cid).replace(/^ AND /, '') : '';
  const claims = db.prepare(`SELECT COUNT(*) c FROM custody_claims WHERE review_status='pending'${cl}`).get().c;
  const unconfirmed = db.prepare(`
    SELECT COUNT(*) c, COALESCE(SUM(liable_amount),0) amt FROM custody_claims
    WHERE review_status IN ('partial','liable') AND finance_confirm_no IS NULL${cl}`).get();
  const confirmed = db.prepare(`
    SELECT COUNT(*) c, COALESCE(SUM(liable_amount),0) amt FROM custody_claims
    WHERE finance_confirm_no IS NOT NULL${cl}`).get();
  const clearanceOpen = db.prepare(`SELECT COUNT(*) c FROM custody_clearances c WHERE c.status='open'${cid ? ' AND c.employee_id IN (SELECT id FROM employees WHERE company_id = ' + cid + ')' : ''}`).get().c;

  const byKind = db.prepare(`
    SELECT r.item_kind kind, COUNT(*) cnt, COALESCE(SUM(r.qty - r.returned_qty),0) qty
    FROM custody_records r JOIN custody_items i ON i.id = r.item_id
    WHERE r.status IN ('issued','awaiting')${it} GROUP BY r.item_kind`).all()
    .map((x) => ({ ...x, label: KIND[x.kind] || x.kind, qty: round2(x.qty) }));

  return {
    items: items.c,
    durable_items: items.d || 0,
    open_cnt: open,
    awaiting_cnt: awaiting,
    overdue_cnt: overdue,
    due_7d: due7,
    optional_out_cnt: optionalOut.c,
    optional_out_qty: round2(optionalOut.q),
    claim_pending: claims,
    claim_unconfirmed: unconfirmed.c,
    claim_unconfirmed_amount: round2(unconfirmed.amt),
    claim_confirmed_amount: round2(confirmed.amt),
    clearance_open: clearanceOpen,
    by_kind: byKind,
    today: t
  };
}

function dict(companyId) {
  const cid = Number(companyId) || null;
  return {
    kinds: labels(KIND),
    statuses: labels(STATUS),
    conditions: labels(COND),
    review_status: labels(REVIEW),
    damage_types: labels(DAMAGE),
    scrap_modes: labels(SCRAP_MODE),
    clearance_status: labels(CLR_STATUS),
    depts: db.prepare('SELECT id, name FROM departments ORDER BY id').all(),
    // 员工下拉也按主体筛：分部的领用登记不该出现总部所有人（那是点名册，不是通讯录）
    employees: db.prepare(
      "SELECT id, code, name, department_id, status, leave_date FROM employees " +
      "WHERE (status IS NULL OR status <> 'left')" + (cid ? ' AND company_id = ' + cid : '') +
      ' ORDER BY name'
    ).all(),
    stats: stats(cid)
  };
}

/* ==================================================================== *
 * 二、实物档案
 * ==================================================================== */

function listItems(q = {}) {
  const where = [];
  const params = [];
  if (q.companyId) { where.push('i.company_id = ?'); params.push(Number(q.companyId)); }
  if (q.kind) { where.push('i.kind = ?'); params.push(q.kind); }
  if (q.status) { where.push('i.status = ?'); params.push(q.status); }
  if (q.q) {
    where.push('(i.name LIKE ? OR i.item_no LIKE ? OR i.item_code LIKE ? OR i.spec LIKE ? OR i.size LIKE ?)');
    const w = `%${q.q}%`;
    params.push(w, w, w, w, w);
  }
  const sql = ITEM_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    " ORDER BY CASE i.status WHEN 'active' THEN 0 ELSE 1 END, i.kind, i.name, i.id";
  return db.prepare(sql).all(...params).map(decorItem);
}

function saveItem(b = {}, actor, user) {
  const id = Number(b.id) || 0;
  /**
   * 归属判断放在**一切字段校验之前**。
   *
   * 原来放在「取 old」那一步（字段校验之后），于是跨主体改档会先收到
   * 「一物一码的在册数量只能是 1 件」这类 400 —— 参数本身不合规确实该报 400，
   * 但顺序反了：先该判断"这条记录是不是你的"。否则调用方会以为改成功了、
   * 只是参数要调，而不是"这台设备不属于我"。
   */
  if (id) ownItem(id, scope.filterCompanyId(user));
  const name = str(b.name);
  if (!name) throw bad('实物名称必填');
  const kind = KIND[b.kind] ? b.kind : 'uniform';
  const durable = b.durable === undefined ? 1 : (Number(b.durable) ? 1 : 0);
  // 消耗品不可能「必须归还」，这里直接归零，避免出现「按量消耗 + 必须归还」这种自相矛盾的档案
  const requireReturn = durable ? (b.require_return === undefined ? 1 : (Number(b.require_return) ? 1 : 0)) : 0;
  const qtyTotal = b.qty_total === undefined ? 1 : Number(b.qty_total);
  if (!(qtyTotal > 0)) throw bad('在册数量必须大于 0');
  // 一物一码 = 一件一个档案。允许写 2 的话，可用量会显示 1 但永远发不出第二件
  // （唯一索引只允许一条未归还记录），盘点时对不上数
  if (durable && qtyTotal !== 1) throw bad('一物一码的实物在册数量只能是 1 件；多件请分别建档（尺码/编号本来就不同）');
  if (!durable && requireReturn) throw bad('按量消耗的实物不需要归还，不能设为「必须归还」');
  const maxPer = b.max_per_person === undefined ? 0 : Number(b.max_per_person);
  if (maxPer < 0) throw bad('个人上限不能为负');
  const life = b.life_months === undefined ? 0 : Math.round(Number(b.life_months) || 0);

  const assetId = b.asset_id ? Number(b.asset_id) : null;

  if (assetId) {
    const a = db.prepare('SELECT id, status, name FROM assets WHERE id = ?').get(assetId);
    if (!a) throw bad('关联的资产卡不存在');
    if (a.status === 'scrapped') throw bad(`资产卡「${a.name}」已报废，不能再挂到在册实物上`);
    const dup = db.prepare('SELECT id, name FROM custody_items WHERE asset_id = ? AND id <> ?').get(assetId, id || 0);
    if (dup) throw bad(`资产卡已挂在实物「${dup.name}」上（一物一码不重复挂）`);
  }

  const t = now();
  if (!id) {
    const itemNo = nextNo('WW', 'custody_items', 'item_no');
    const info = db.prepare(`
      INSERT INTO custody_items (item_no, item_code, company_id, kind, name, spec, size, color, durable,
        qty_total, unit, require_return, max_per_person, life_months, asset_id, location, status, note,
        created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      itemNo, str(b.item_code) || null,
      /**
       * 主体不能直接取 b.company_id —— 那是客户端能随手改的字段。
       * writeCompanyOf(user, explicit) 的语义：只有集团角色（admin/boss）可以显式给某个主体建档
       * （总部行政替分部建实物档案是正常需求），其余角色一律落到自己主体。
       */
      scope.writeCompanyOf(user, b.company_id), kind, name, str(b.spec) || null,
      str(b.size) || null, str(b.color) || null, durable, qtyTotal, str(b.unit) || '件', requireReturn,
      maxPer, life, assetId, str(b.location) || null, 'active', str(b.note) || null, t, t
    );
    const newId = Number(info.lastInsertRowid);
    logAction('item', newId, 'create', `${KIND[kind]} ${name} ×${qtyTotal}`, qtyTotal, actor);
    return itemById(newId);
  }

  const old = db.prepare('SELECT * FROM custody_items WHERE id = ?').get(id);
  const used = db.prepare('SELECT COUNT(*) c FROM custody_records WHERE item_id = ?').get(id).c;
  if (used && (Number(old.durable) !== durable || old.kind !== kind)) {
    throw bad('该实物已有领用记录，类别与「是否一物一码」不能再改（历史统计口径会前后不一致）');
  }
  const out = outQtyOf(id).qty;
  if (qtyTotal < out) throw bad(`在册数量不能小于已领出数量（当前未还 ${out}）`);

  db.prepare(`
    UPDATE custody_items SET item_code=?, kind=?, name=?, spec=?, size=?, color=?, durable=?, qty_total=?,
      unit=?, require_return=?, max_per_person=?, life_months=?, asset_id=?, location=?, note=?, updated_at=?
    WHERE id=?`).run(
    str(b.item_code) || null, kind, name, str(b.spec) || null, str(b.size) || null, str(b.color) || null,
    durable, qtyTotal, str(b.unit) || '件', requireReturn, maxPer, life, assetId,
    str(b.location) || null, str(b.note) || null, t, id
  );
  logAction('item', id, 'update', '档案修改', null, actor);
  return itemById(id);
}

/**
 * 恢复可用：损坏件修好了（或经检查不影响使用）。
 * 必须走这一步才能再发 —— 「归还了」不等于「还能用」。
 */
function restoreItem(id, b = {}, actor, companyId) {
  ownItem(id, companyId);
  const item = itemById(id);
  if (!item) throw bad('实物不存在', 404);
  if (item.status !== 'hold') throw bad('只有在「待处理」的实物才需要恢复');
  if (!str(b.note)) throw bad('恢复可用要写处理结果（维修 / 检查合格），否则没人知道它为什么能再用');
  const note = [str(item.note), `恢复可用：${str(b.note)}`].filter(Boolean).join('；');
  db.prepare("UPDATE custody_items SET status='active', note=?, updated_at=? WHERE id=?")
    .run(note, now(), id);
  logAction('item', id, 'restore', `恢复可用：${str(b.note)}`, null, actor);
  return itemById(id);
}

/** 处置（核销/报废变卖/转出）
 * 拒绝挂资产卡的实物：那类东西的价值体现在资产台账，两边各自报废必然对不上。
 */
function scrapItem(id, b = {}, actor, companyId) {
  ownItem(id, companyId);
  const item = itemById(id);
  if (!item) throw bad('实物不存在', 404);
  if (item.status === 'scrapped') throw bad('该实物已处置');
  const out = outQtyOf(id);
  if (out.qty > 0) {
    const who = db.prepare("SELECT employee_name, rec_no FROM custody_records WHERE item_id=? AND status IN ('issued','awaiting') ORDER BY id DESC LIMIT 1").get(id);
    throw bad(`还有 ${out.qty} ${item.unit} 未归还（${who ? `${who.employee_name} ${who.rec_no}` : '在领用中'}），先归还或做损坏复核再处置`);
  }
  if (item.asset_id) {
    const a = assetOf(item.asset_id);
    throw bad(`该实物挂了固定资产卡（${a ? a.code || a.name : item.asset_id}），请到「固定资产」页走报废 —— 折旧与处置价款以资产台账为准，这里再报一次会产生两套净值`);
  }
  const mode = str(b.scrap_mode);
  if (!SCRAP_MODE[mode]) throw bad('请选择处置方式（报废变卖 / 转出 / 盘亏核销）');
  const no = str(b.scrap_no);
  if (!no) throw bad('处置必须填处置单号或财务回执号 —— 没有去处的核销等于东西凭空消失');
  db.prepare("UPDATE custody_items SET status='scrapped', scrap_mode=?, scrap_no=?, note=COALESCE(?, note), updated_at=? WHERE id=?")
    .run(mode, no, str(b.note) || null, now(), id);
  logAction('item', id, 'scrap', `${SCRAP_MODE[mode]} ${no}`, null, actor);
  return itemById(id);
}

/* ==================================================================== *
 * 三、领用
 * ==================================================================== */

function employeeOf(id) {
  return db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
}

/** 归还期限：不强制归还的实物永不设期限（工衣不催） */
function normDue(item, val) {
  if (!item.require_return) return null;
  const s = str(val);
  if (!s) return null;                       // 必须归还，但借出时没定日子
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad('归还日期格式应为 YYYY-MM-DD');
  if (s < today()) throw bad('归还日期不能早于今天');
  return s;
}

/**
 * 发放前的硬校验。草稿不调用它 ——
 * 草稿只是「登记一下」，占位会把别人挡住；真正校验在发放那一刻做。
 */
function assertIssuable(item, emp, qty) {
  if (!item) throw bad('实物不存在', 404);
  if (item.status === 'scrapped') throw bad('该实物已处置，不能再发放');
  // 损坏归还的实物先冻结：坏的对讲机不能再发给下一个人。
  // 维修好点「恢复可用」，修不好走处置 —— 不能靠「归还了就等于能用」。
  if (item.status === 'hold') throw bad('该实物「损坏待处理」，不能发放；确认修好后点「恢复可用」，不能用就走处置');
  if (item.asset_lost) throw bad(`关联资产卡（${item.asset_code || item.asset_name || ''}）已报废，不能再发放`);
  if (!emp) throw bad('领用人不存在');
  if (emp.status === 'left') throw bad(`「${emp.name}」已离职，不能新领实物；离职清退请走「清退」`);
  const q = num(qty);
  if (!(q > 0)) throw bad('领用数量必须大于 0');
  if (item.durable && q !== 1) throw bad('一物一码的实物只能按 1 件发放');

  // 只有一物一码的实物才有「不能双领」；手套口罩这类按量的，同一个人可以再领
  if (item.durable) {
    const open = db.prepare(`
      SELECT r.* FROM custody_records r WHERE r.item_id = ? AND r.status IN ('issued','awaiting')
      ORDER BY r.id DESC LIMIT 1`).get(item.id);
    if (open) {
      throw bad(`该实物已在「${open.employee_name}」手上（${open.rec_no}），耐用实物不允许双领；要换人请用「转交」`, 409);
    }
  }

  const out = outQtyOf(item.id).qty;
  if (!item.durable && out + q > num(item.qty_total)) {
    throw bad(`可用只有 ${round2(num(item.qty_total) - out)} ${item.unit}，不够领 ${q}`);
  }

  if (num(item.max_per_person) > 0) {
    const mine = round2(db.prepare(`
      SELECT COALESCE(SUM(qty - returned_qty),0) v FROM custody_records
      WHERE item_id = ? AND employee_id = ? AND status IN ('issued','awaiting')`).get(item.id, emp.id).v);
    if (mine + q > num(item.max_per_person)) {
      throw bad(`个人上限 ${item.max_per_person} ${item.unit}：${emp.name} 手上已有 ${mine}，再领 ${q} 就超了`);
    }
  }
}

function insertRecord({ item, emp, qty, due, draft, actor, handover, note, prevId, clearanceId }) {
  const recNo = nextNo('LY', 'custody_records', 'rec_no');
  const dept = emp.department_id ? db.prepare('SELECT id, name FROM departments WHERE id = ?').get(emp.department_id) : null;
  const t = now();
  const info = db.prepare(`
    INSERT INTO custody_records (rec_no, item_id, item_kind, durable, employee_id, employee_name, dept_id, dept_name,
      qty, status, issued_at, issued_by, handover_by, expected_return_at, prev_record_id, clearance_id, note,
      created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    recNo, item.id, item.kind, item.durable, emp.id, emp.name, dept ? dept.id : null, dept ? dept.name : null,
    qty, draft ? 'draft' : 'issued', draft ? null : t, actor, str(handover) || null, due,
    prevId || null, clearanceId || null, str(note) || null, t, t
  );
  return Number(info.lastInsertRowid);
}

function createRecord(b = {}, actor, companyId) {
  const draft = !!b.draft;
  // 只能给自己主体的实物登记领用：跨主体的实物是别家的资产，领了等于凭空少一件
  ownItem(b.item_id, companyId);
  const item = itemById(b.item_id);
  if (!item) throw bad('实物不存在', 404);
  const emp = employeeOf(b.employee_id);
  if (!emp) throw bad('领用人不存在');
  const qty = item.durable ? 1 : (b.qty === undefined ? 1 : Number(b.qty));
  const due = normDue(item, b.expected_return_at);

  if (!draft) assertIssuable(item, emp, qty);

  const id = insertRecord({
    item, emp, qty, due, draft, actor,
    handover: b.handover_by, note: b.note
  });
  logAction('record', id, draft ? 'draft' : 'issue',
    draft ? `登记领用草稿：${item.name} ×${qty}` : `发放 ${item.name} ×${qty} 给 ${emp.name}`,
    qty, actor);
  return detailRecord(id);
}

/** 草稿发放：这一刻才真正占实物 */
function publishRecord(id, actor, companyId) {
  ownRecord(id, companyId);
  const rec = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(id);
  if (!rec) throw bad('领用记录不存在', 404);
  if (rec.status !== 'draft') throw bad('只有草稿才能发放');
  const item = itemById(rec.item_id);
  const emp = employeeOf(rec.employee_id);
  assertIssuable(item, emp, rec.qty);                 // 校验全在 BEGIN 之前
  const t = now();
  tx(() => {
    db.prepare("UPDATE custody_records SET status='issued', issued_at=?, issued_by=?, updated_at=? WHERE id=?")
      .run(t, actor, t, id);
    logAction('record', id, 'issue', `草稿发放：${item.name} ×${rec.qty} 给 ${rec.employee_name}`, rec.qty, actor);
  });
  return detailRecord(id);
}

/**
 * 归还
 * - 一物一码必须整件归还（不能还半个）
 * - 归还时必须登记状态：不知道东西好坏就定不了责
 * - 登记损坏/遗失只**生成待复核单**，不动任何金额
 */
function returnRecord(id, b = {}, actor, companyId) {
  ownRecord(id, companyId);
  const rec = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(id);
  if (!rec) throw bad('领用记录不存在', 404);
  if (rec.status === 'draft') throw bad('草稿还没发放，不需要归还');
  if (!OPEN.includes(rec.status)) throw bad(`该记录已是「${STATUS[rec.status]}」，不能再归还`);

  const item = itemById(rec.item_id);
  const cond = str(b.condition);
  if (!COND[cond]) throw bad('请选择归还时的实物状态（完好 / 磨损 / 损坏 / 遗失）');
  const remain = round2(num(rec.qty) - num(rec.returned_qty));
  if (remain <= 0) throw bad('该记录已还清');

  let qty = b.qty === undefined ? remain : Number(b.qty);
  if (!(qty > 0)) throw bad('归还数量必须大于 0');
  if (cond === 'lost') qty = remain;                      // 遗失就是剩下的全没了
  if (rec.durable && qty !== remain) throw bad('一物一码的实物必须整件归还');
  if (qty > remain) throw bad(`最多只能还 ${remain} ${item ? item.unit : ''}`);

  if ((cond === 'damaged' || cond === 'lost') && !str(b.note)) {
    throw bad('登记损坏/遗失必须写情况说明 —— 复核时要看');
  }

  const t = now();
  const willBeDone = cond !== 'lost' && round2(num(rec.returned_qty) + qty) >= num(rec.qty);
  const newStatus = cond === 'lost' ? 'lost' : (willBeDone ? 'returned' : rec.status);
  const newNote = [str(rec.note), str(b.note)].filter(Boolean).join('；') || null;

  tx(() => {
    db.prepare(`UPDATE custody_records SET returned_qty = ?, status = ?, returned_at = ?, received_by = ?,
        condition = ?, note = ?, updated_at = ? WHERE id = ?`)
      .run(
        cond === 'lost' ? num(rec.qty) : round2(num(rec.returned_qty) + qty),
        newStatus,
        cond === 'lost' ? null : t,
        actor,
        cond,
        newNote,
        t,
        id
      );

    if (cond === 'damaged' || cond === 'lost') {
      const claimNo = nextNo('DZ', 'custody_claims', 'claim_no');
      db.prepare(`INSERT INTO custody_claims (claim_no, record_id, item_id, employee_id, employee_name,
          damage_type, qty, found_at, desc_text, claim_amount, review_status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        claimNo, id, rec.item_id, rec.employee_id, rec.employee_name, cond, qty,
        today(), str(b.note), round2(b.claim_amount), 'pending', t, t
      );
      logAction('record', id, 'claim', `${COND[cond]}：${item ? item.name : ''} ×${qty}，已生成复核单 ${claimNo}`, qty, actor);

      // 一物一码的实物：损坏 → 冻结待处理；遗失 → 东西没了，直接按盘亏核销。
      // 不冻结的话，坏掉的对讲机归还后「可用 1」，第二天就发给别人了。
      if (item && item.durable) {
        if (cond === 'damaged') {
          db.prepare("UPDATE custody_items SET status='hold', updated_at=? WHERE id=?").run(t, rec.item_id);
          logAction('item', rec.item_id, 'hold', `损坏归还，冻结待处理（${claimNo}）`, null, actor);
        } else {
          db.prepare("UPDATE custody_items SET status='scrapped', scrap_mode='write_off', scrap_no=?, updated_at=? WHERE id=?")
            .run(claimNo, t, rec.item_id);
          logAction('item', rec.item_id, 'scrap', `遗失核销，参考复核单 ${claimNo}`, null, actor);
        }
      }
    }

    logAction('record', id, cond === 'lost' ? 'lost' : 'return', `${COND[cond]} 归还 ×${qty}`, qty, actor);
  });
  return detailRecord(id);
}

/**
 * 转交：原记录归还 + 新记录发放，一次事务完成。
 * 为什么不改 employee_id —— 改了就没有「谁用过这件东西」的历史，
 * 上一任弄坏的东西会被记到下一任头上。
 */
function transferRecord(id, b = {}, actor, companyId) {
  ownRecord(id, companyId);
  const rec = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(id);
  if (!rec) throw bad('领用记录不存在', 404);
  if (!OPEN.includes(rec.status)) throw bad(`该记录是「${STATUS[rec.status]}」，不能转交`);
  const item = itemById(rec.item_id);
  if (!item.durable) throw bad('按量消耗的实物不存在「转交」，请直接归还/领用');
  const to = employeeOf(b.to_employee_id);
  if (!to) throw bad('转交对象不存在');
  if (Number(to.id) === Number(rec.employee_id)) throw bad('不能转交给自己');
  if (to.status === 'left') throw bad(`「${to.name}」已离职，不能接收实物`);
  if (num(item.max_per_person) > 0) {
    const mine = round2(db.prepare(`
      SELECT COALESCE(SUM(qty - returned_qty),0) v FROM custody_records
      WHERE item_id = ? AND employee_id = ? AND status IN ('issued','awaiting')`).get(item.id, to.id).v);
    if (mine + 1 > num(item.max_per_person)) {
      throw bad(`个人上限 ${item.max_per_person}：${to.name} 手上已有 ${mine} 件，不能再接`);
    }
  }
  if (!str(b.note)) throw bad('转交要写原因（借调 / 换岗 / 临时代用），否则事后说不清');

  const t = now();
  let newId = 0;
  tx(() => {
    db.prepare(`UPDATE custody_records SET returned_qty = qty, status='returned', returned_at = ?, received_by = ?,
        condition = 'good', note = ?, updated_at = ? WHERE id = ?`)
      .run(t, actor, [str(rec.note), `转交给 ${to.name}：${str(b.note)}`].filter(Boolean).join('；'), t, id);
    newId = insertRecord({
      item, emp: to, qty: 1, due: normDue(item, b.expected_return_at), draft: false, actor,
      handover: b.handover_by || to.name, note: `由 ${rec.employee_name} 转交：${str(b.note)}`,
      prevId: id
    });
    logAction('record', id, 'transfer_out', `转交给 ${to.name}（新记录 #${newId}）`, 1, actor);
    logAction('record', newId, 'transfer_in', `由 ${rec.employee_name} 转交`, 1, actor);
  });
  return { from: detailRecord(id), to: detailRecord(newId) };
}

/* ==================================================================== *
 * 四、台账查询
 * ==================================================================== */

function daysBetween(from, to) {
  if (!from) return 0;
  const a = new Date(`${String(from).slice(0, 10)}T00:00:00`);
  const b = new Date(`${String(to).slice(0, 10)}T00:00:00`);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b - a) / 86400000);
}

function decorRecord(r) {
  const remain = round2(num(r.qty) - num(r.returned_qty));
  const t = today();
  const overdueDays = (r.expected_return_at && remain > 0 && Number(r.require_return))
    ? daysBetween(r.expected_return_at, t) : 0;
  return {
    ...r,
    status_label: STATUS[r.status] || r.status,
    kind_label: KIND[r.item_kind] || r.item_kind,
    condition_label: COND[r.condition] || '',
    remain_qty: remain,
    overdue_days: overdueDays > 0 ? overdueDays : 0,
    overdue: overdueDays > 0,
    partial: r.status === 'issued' && num(r.returned_qty) > 0,
    days_held: r.issued_at ? Math.max(0, daysBetween(localDate(r.issued_at), r.returned_at ? localDate(r.returned_at) : t)) : 0,
    is_open: OPEN.includes(r.status),
    return_label: Number(r.require_return) ? '必须归还' : '不强制退回'
  };
}

const REC_SELECT = `
  SELECT r.*, i.name AS item_name, i.item_no, i.spec, i.size, i.color, i.unit, i.require_return,
         i.asset_id, i.status AS item_status
  FROM custody_records r LEFT JOIN custody_items i ON i.id = r.item_id
`;

function listRecords(q = {}) {
  const where = [];
  const params = [];
  // 台账按**实物**主体判（领用记录没有 company_id，item_id 是 NOT NULL）
  if (q.companyId) { where.push(itemScope(Number(q.companyId)).replace(/^ AND /, '')); }
  if (q.status) {
    if (q.status === 'open') { where.push("r.status IN ('issued','awaiting')"); }
    else { where.push('r.status = ?'); params.push(q.status); }
  }
  if (q.overdue === '1' || q.overdue === true) {
    where.push("r.status IN ('issued','awaiting') AND i.require_return = 1 AND r.expected_return_at IS NOT NULL AND r.expected_return_at < ?");
    params.push(today());
  }
  if (q.kind) { where.push('r.item_kind = ?'); params.push(q.kind); }
  if (q.employee_id) { where.push('r.employee_id = ?'); params.push(Number(q.employee_id)); }
  if (q.item_id) { where.push('r.item_id = ?'); params.push(Number(q.item_id)); }
  if (q.dept_id) { where.push('r.dept_id = ?'); params.push(Number(q.dept_id)); }
  if (q.q) {
    where.push('(r.rec_no LIKE ? OR r.employee_name LIKE ? OR i.name LIKE ? OR i.item_no LIKE ? OR r.dept_name LIKE ?)');
    const w = `%${q.q}%`;
    params.push(w, w, w, w, w);
  }
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 300));
  const sql = REC_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    " ORDER BY CASE r.status WHEN 'awaiting' THEN 0 WHEN 'issued' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, r.id DESC LIMIT ?";
  return db.prepare(sql).all(...params, limit).map(decorRecord);
}

function detailRecord(id, companyId) {
  if (companyId) {
    const own = db.prepare('SELECT item_id FROM custody_records WHERE id = ?').get(Number(id));
    if (!own) return null;
    const it = db.prepare('SELECT company_id FROM custody_items WHERE id = ?').get(own.item_id);
    if (!it || Number(it.company_id) !== Number(companyId)) return null;
  }
  const r = db.prepare(REC_SELECT + ' WHERE r.id = ?').get(id);
  if (!r) return null;
  const rec = decorRecord(r);
  rec.claims = db.prepare('SELECT * FROM custody_claims WHERE record_id = ? ORDER BY id DESC').all(id)
    .map(decorClaim);
  rec.actions = db.prepare("SELECT * FROM custody_actions WHERE target_type='record' AND target_id=? ORDER BY id").all(id);
  rec.item = r.item_id ? itemById(r.item_id) : null;
  if (r.prev_record_id) {
    const p = db.prepare('SELECT id, rec_no, employee_name FROM custody_records WHERE id = ?').get(r.prev_record_id);
    rec.prev = p || null;
  }
  return rec;
}

/** 某人身上挂着什么 */
function personView(employeeId, companyId) {
  const emp = employeeOf(employeeId);
  if (!emp) throw bad('员工不存在', 404);
  // 「谁身上有什么」按员工归属判：查别家的员工等于查别家的人拿了什么，这是点名册级别的信息
  if (companyId && Number(emp.company_id) !== Number(companyId)) throw bad('员工不存在', 404);
  const dept = emp.department_id ? db.prepare('SELECT name FROM departments WHERE id = ?').get(emp.department_id) : null;
  const open = listRecords({ employee_id: employeeId, status: 'open', limit: 500 });
  const history = listRecords({ employee_id: employeeId, limit: 500 }).filter((r) => !r.is_open);
  const claims = db.prepare('SELECT * FROM custody_claims WHERE employee_id = ? ORDER BY id DESC').all(employeeId).map(decorClaim);
  const must = open.filter((r) => Number(r.require_return));
  return {
    employee: { ...emp, dept_name: dept ? dept.name : '', status_label: emp.status === 'left' ? '已离职' : '在职' },
    open,
    history,
    claims,
    summary: {
      open_cnt: open.length,
      must_return_cnt: must.length,
      optional_cnt: open.length - must.length,
      overdue_cnt: open.filter((r) => r.overdue).length,
      claim_pending: claims.filter((c) => c.review_status === 'pending').length,
      claim_unconfirmed_amount: round2(claims.filter((c) => ['partial', 'liable'].includes(c.review_status) && !c.finance_confirm_no).reduce((s, c) => s + num(c.liable_amount), 0))
    }
  };
}

function overdueList(companyId) {
  return listRecords({ overdue: '1', limit: 500, companyId });
}

function itemTimeline(itemId, companyId) {
  ownItem(itemId, companyId);
  const item = itemById(itemId);
  const acts = db.prepare("SELECT * FROM custody_actions WHERE (target_type='item' AND target_id=?) OR (target_type='record' AND target_id IN (SELECT id FROM custody_records WHERE item_id=?)) ORDER BY id DESC LIMIT 200").all(itemId, itemId);
  return { item, records: listRecords({ item_id: itemId, limit: 200 }), actions: acts };
}

/* ==================================================================== *
 * 五、离职清退
 * ==================================================================== */

function decorClearance(r) {
  const rows = db.prepare(`
    SELECT r.id, r.rec_no, r.status, r.qty, r.returned_qty, r.expected_return_at, r.issued_at,
           i.name AS item_name, i.require_return, i.kind
    FROM custody_records r LEFT JOIN custody_items i ON i.id = r.item_id
    WHERE r.clearance_id = ? ORDER BY i.require_return DESC, r.id`).all(r.id);
  const must = rows.filter((x) => Number(x.require_return));
  const optional = rows.filter((x) => !Number(x.require_return));
  const done = (x) => ['returned', 'lost', 'written_off'].includes(x.status);
  return {
    ...r,
    status_label: CLR_STATUS[r.status] || r.status,
    items: rows.map((x) => ({
      ...x,
      kind_label: KIND[x.kind] || x.kind,
      status_label: STATUS[x.status] || x.status,
      must: !!Number(x.require_return),
      done: done(x),
      remain: round2(num(x.qty) - num(x.returned_qty))
    })),
    must_total: must.length,
    must_done: must.filter(done).length,
    optional_total: optional.length,
    optional_done: optional.filter(done).length
  };
}

/**
 * 建离职清退单
 * - 必须归还的（钥匙/门禁卡/工具）→ 转「待归还」，期限记离职日
 * - 工衣这类不强制退回的 → 只列进清单，**不改状态、不设期限**（原型：不把工衣全部强制退回）
 * - 同一人已有进行中的清退单 → 直接返回，不重复建
 */
function buildClearance(b = {}, actor, companyId) {
  const emp = employeeOf(b.employee_id);
  if (!emp) throw bad('员工不存在', 404);
  // 离职清退按**员工**主体判：给别家员工开清退单，等于替别家做离职交接
  if (companyId && Number(emp.company_id) !== Number(companyId)) throw bad('员工不存在', 404);
  const exist = db.prepare("SELECT * FROM custody_clearances WHERE employee_id = ? AND status = 'open'").get(emp.id);
  if (exist) return { ...decorClearance(exist), reused: true };

  const open = db.prepare(`
    SELECT r.*, i.require_return FROM custody_records r JOIN custody_items i ON i.id = r.item_id
    WHERE r.employee_id = ? AND r.status IN ('issued','awaiting') ORDER BY r.id`).all(emp.id);
  const must = open.filter((r) => Number(r.require_return));
  const optional = open.filter((r) => !Number(r.require_return));

  const dept = emp.department_id ? db.prepare('SELECT name FROM departments WHERE id = ?').get(emp.department_id) : null;
  const leaveDate = str(b.leave_date) || str(emp.leave_date) || today();
  const t = now();
  let cid = 0;
  tx(() => {
    const no = nextNo('QT', 'custody_clearances', 'clearance_no');
    const info = db.prepare(`INSERT INTO custody_clearances (clearance_no, employee_id, employee_name, dept_id, dept_name,
        leave_date, reason, status, must_total, must_done, optional_total, optional_done, created_by, note, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,'open',?,0,?,0,?,?,?,?)`).run(
      no, emp.id, emp.name, emp.department_id || null, dept ? dept.name : null, leaveDate,
      str(b.reason) || '离职清退', must.length, optional.length, actor, str(b.note) || null, t, t
    );
    cid = Number(info.lastInsertRowid);
    // 必须归还的转「待归还」；工衣（不强制退回）保持原状，只在清单里可见
    must.forEach((r) => {
      db.prepare("UPDATE custody_records SET status='awaiting', expected_return_at=?, clearance_id=?, updated_at=? WHERE id=?")
        .run(leaveDate, cid, t, r.id);
    });
    optional.forEach((r) => {
      db.prepare('UPDATE custody_records SET clearance_id = ?, updated_at = ? WHERE id = ?').run(cid, t, r.id);
    });
    logAction('clearance', cid, 'create',
      `${emp.name} 离职清退：必须归还 ${must.length} 件，不强制退回 ${optional.length} 件（工衣按政策）`, null, actor);

    // 一件都没有：直接结案，别留一张永远 0/0 的空单
    if (!open.length) {
      db.prepare("UPDATE custody_clearances SET status='closed', closed_at=?, closed_by=? WHERE id=?").run(t, actor, cid);
      logAction('clearance', cid, 'close', '名下无实物，直接结案', null, actor);
    }
  });
  return decorClearance(db.prepare('SELECT * FROM custody_clearances WHERE id = ?').get(cid));
}

function listClearances(q = {}) {
  const where = [];
  const params = [];
  // 清退单没有 company_id，按员工父表判
  if (q.companyId) { where.push(empScope(Number(q.companyId)).replace(/^ AND /, '')); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  const sql = 'SELECT * FROM custody_clearances ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY CASE status WHEN \'open\' THEN 0 ELSE 1 END, id DESC LIMIT 200';
  return db.prepare(sql).all(...params).map(decorClearance);
}

function closeClearance(id, b = {}, actor, companyId) {
  const row = ownClearance(id, companyId);
  if (row.status === 'closed') throw bad('该清退单已结案');
  const c = decorClearance(row);
  if (c.must_done < c.must_total) {
    const left = c.items.filter((x) => x.must && !x.done).map((x) => `${x.item_name}（${x.rec_no}）`).join('、');
    throw bad(`还有 ${c.must_total - c.must_done} 件必须归还的实物没回来：${left}`);
  }
  const t = now();
  const leftOptional = c.optional_total - c.optional_done;
  db.prepare("UPDATE custody_clearances SET status='closed', closed_at=?, closed_by=?, must_done=?, optional_done=?, note=COALESCE(?, note), updated_at=? WHERE id=?")
    .run(t, actor, c.must_done, c.optional_done, str(b.note) || null, t, id);
  logAction('clearance', id, 'close',
    leftOptional > 0 ? `结案；工衣类 ${leftOptional} 件未退回，按政策不追` : '全部清完结案', null, actor);
  return decorClearance(db.prepare('SELECT * FROM custody_clearances WHERE id = ?').get(id));
}

/* ==================================================================== *
 * 六、损坏责任复核（只出结论，不碰钱）
 * ==================================================================== */

function decorClaim(r) {
  if (!r) return null;
  return {
    ...r,
    damage_label: DAMAGE[r.damage_type] || r.damage_type,
    review_label: REVIEW[r.review_status] || r.review_status,
    status_label: r.status === 'closed' ? '已结案' : '处理中',
    needs_finance: ['partial', 'liable'].includes(r.review_status) && !r.finance_confirm_no,
    finance_done: !!r.finance_confirm_no
  };
}

function listClaims(q = {}) {
  const where = [];
  const params = [];
  // 定责单挂实物 → 按实物主体判（金额最终要进这家主体的账）
  if (q.companyId) { where.push(itemScope(Number(q.companyId)).replace(/^ AND /, '')); }
  if (q.review_status) { where.push('review_status = ?'); params.push(q.review_status); }
  if (q.employee_id) { where.push('employee_id = ?'); params.push(Number(q.employee_id)); }
  if (q.q) {
    where.push('(claim_no LIKE ? OR employee_name LIKE ? OR desc_text LIKE ?)');
    const w = `%${q.q}%`;
    params.push(w, w, w);
  }
  const sql = 'SELECT * FROM custody_claims ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    "ORDER BY CASE review_status WHEN 'pending' THEN 0 WHEN 'partial' THEN 1 WHEN 'liable' THEN 1 WHEN 'cleared' THEN 2 ELSE 3 END, id DESC LIMIT 300";
  return db.prepare(sql).all(...params).map(decorClaim);
}

function createClaim(b = {}, actor, companyId) {
  if (b.item_id) ownItem(b.item_id, companyId);   // 别家的实物不能拿来定责
  const rec = b.record_id ? db.prepare('SELECT * FROM custody_records WHERE id = ?').get(b.record_id) : null;
  if (rec && companyId) ownRecord(rec.id, companyId);
  const itemId = rec ? rec.item_id : (b.item_id ? Number(b.item_id) : null);
  const empId = rec ? rec.employee_id : (b.employee_id ? Number(b.employee_id) : null);
  if (!itemId) throw bad('请选择实物（或从一条领用记录发起）');
  if (!empId) throw bad('请选择责任人');
  const emp = employeeOf(empId);
  if (!emp) throw bad('责任人不存在');
  const type = str(b.damage_type) || 'damaged';
  if (!DAMAGE[type]) throw bad('损坏类型只能是「损坏」或「遗失」');
  if (!str(b.desc_text)) throw bad('必须写清损坏/遗失情况');
  const amount = round2(b.claim_amount);
  if (amount < 0) throw bad('申报金额不能为负');
  const t = now();
  const no = nextNo('DZ', 'custody_claims', 'claim_no');
  const info = db.prepare(`INSERT INTO custody_claims (claim_no, record_id, item_id, employee_id, employee_name,
      damage_type, qty, found_at, desc_text, claim_amount, review_status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(
    no, rec ? rec.id : null, itemId, emp.id, emp.name, type, b.qty === undefined ? 1 : Number(b.qty),
    str(b.found_at) || today(), str(b.desc_text), amount, t, t
  );
  logAction('claim', Number(info.lastInsertRowid), 'claim', `${DAMAGE[type]}：${str(b.desc_text).slice(0, 40)}`, null, actor);
  return decorClaim(db.prepare('SELECT * FROM custody_claims WHERE id = ?').get(Number(info.lastInsertRowid)));
}

/**
 * 复核结论：只写责任比例与定责金额，**不写工资、不写应付、不写凭证**。
 * 金额要真的收，得财务拿回执号来确认（下面 confirmFinance）。
 */
function reviewClaim(id, b = {}, actor, companyId) {
  const row = db.prepare('SELECT * FROM custody_claims WHERE id = ?').get(id);
  if (!row) throw bad('复核单不存在', 404);
  if (companyId && row.item_id) ownItem(row.item_id, companyId);
  if (row.finance_confirm_no) throw bad('财务已确认金额，不能再改判；如需修正请另开一张复核单');
  if (row.review_status === 'closed') throw bad('该复核单已结案');

  const decision = str(b.decision);
  if (!['cleared', 'partial', 'liable'].includes(decision)) throw bad('请选择复核结论（无责 / 部分责任 / 全责）');
  if (!str(b.reviewer_note)) throw bad('复核必须写依据 —— 只写结论的单子事后没人认');

  // 自己不能判自己：领用人本人不能出现在复核人位置
  const claim = decorClaim(row);
  if (String(claim.employee_name || '') === String(actor || '')) {
    throw bad('领用人本人不能给自己的损坏件做责任认定，请换别人复核');
  }

  let pct = Number(b.liable_pct);
  if (decision === 'cleared') pct = 0;
  else if (decision === 'liable') pct = 100;
  else {
    if (!(pct > 0 && pct < 100)) throw bad('部分责任要填 1~99 的责任比例');
  }
  const amount = round2(num(row.claim_amount) * pct / 100);
  const t = now();
  db.prepare(`UPDATE custody_claims SET review_status = ?, liable_pct = ?, liable_amount = ?, reviewer_note = ?,
      reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`)
    .run(decision, pct, amount, str(b.reviewer_note), actor, t, t, id);
  logAction('claim', id, 'review', `${REVIEW[decision]} ${pct}% → ¥${amount}（待财务确认）`, null, actor);
  return decorClaim(db.prepare('SELECT * FROM custody_claims WHERE id = ?').get(id));
}

/** 财务确认：必须有回执号；确认后金额才算落地，但本模块仍然只是「记录」，不改账 */
function confirmFinance(id, b = {}, actor, roles, companyId) {
  const row = db.prepare('SELECT * FROM custody_claims WHERE id = ?').get(id);
  if (!row) throw bad('复核单不存在', 404);
  // 财务确认的是"记到哪家的账"，跨主体确认等于替别家认下这笔赔偿
  if (companyId && row.item_id) ownItem(row.item_id, companyId);
  if (!['partial', 'liable'].includes(row.review_status)) {
    throw bad('只有「部分责任 / 全责」的复核单才需要财务确认');
  }
  if (row.finance_confirm_no) throw bad('该复核单已确认过');
  // 一人多岗：任一生效岗位是财务/管理员即可
  const mine = Array.isArray(roles) ? roles : [roles];
  if (!mine.some((r) => ['finance', 'admin'].includes(r))) throw bad('只有财务或管理员能确认定责金额', 403);
  const no = str(b.finance_confirm_no);
  if (!no) throw bad('必须填财务回执号（收款凭证 / 工资扣款单号）—— 没有回执的「已定责」只是口头');
  if (!(num(row.liable_amount) > 0)) throw bad('定责金额为 0，不需要财务确认');
  const t = now();
  db.prepare(`UPDATE custody_claims SET finance_confirm_no = ?, finance_confirmed_by = ?, finance_confirmed_at = ?,
      finance_note = ?, status = 'closed', updated_at = ? WHERE id = ?`)
    .run(no, actor, t, str(b.finance_note) || null, t, id);
  logAction('claim', id, 'finance', `财务确认 ¥${row.liable_amount}，回执 ${no}`, null, actor);
  return decorClaim(db.prepare('SELECT * FROM custody_claims WHERE id = ?').get(id));
}

/* ==================================================================== *
 * 七、看板
 * ==================================================================== */

function board(companyId) {
  const cid = Number(companyId) || null;
  const s = stats(cid);
  const overdue = overdueList(cid).slice(0, 20);
  const pendingClaims = listClaims({ review_status: 'pending', companyId: cid }).slice(0, 20);
  const clearances = listClearances({ status: 'open', companyId: cid }).slice(0, 10);
  /**
   * 「最近动作」要按 target **反查**归属，不能直接不筛。
   *
   * 教训：单条实物的时间线不筛是对的（范围已由 ownItem 卡死，筛了会缺环节），
   * 但看板这条是**全表最近 30 条** —— 不筛就把别家的员工名、物品名、赔偿金额混进分部的首页。
   * 两种"日志"的可见性口径不同，不能共用一条规则。
   */
  const actWhere = cid
    ? `WHERE (a.target_type='item' AND a.target_id IN (SELECT id FROM custody_items WHERE company_id = ${cid}))
        OR (a.target_type='record' AND a.target_id IN (
              SELECT r.id FROM custody_records r JOIN custody_items i ON i.id = r.item_id WHERE i.company_id = ${cid}))
        OR (a.target_type='clearance' AND a.target_id IN (
              SELECT c.id FROM custody_clearances c JOIN employees e ON e.id = c.employee_id WHERE e.company_id = ${cid}))
        OR (a.target_type='claim' AND a.target_id IN (
              SELECT a2.id FROM custody_claims a2 JOIN custody_items i2 ON i2.id = a2.item_id WHERE i2.company_id = ${cid}))`
    : '';
  const actions = db.prepare(`SELECT a.* FROM custody_actions a ${actWhere} ORDER BY a.id DESC LIMIT 30`).all()
    .map((a) => ({ ...a, action_label: ACTION_LABEL[a.action] || a.action }));
  return { stats: s, overdue, pending_claims: pendingClaims, clearances, actions };
}

const ACTION_LABEL = {
  create: '建档', update: '改档', issue: '发放', draft: '草稿', return: '归还', lost: '遗失',
  claim: '发起复核', review: '复核', finance: '财务确认', scrap: '处置', hold: '冻结待处理',
  restore: '恢复可用', transfer_out: '转交出', transfer_in: '转交入', close: '结案'
};

module.exports = {
  KIND, STATUS, COND, REVIEW, DAMAGE, SCRAP_MODE, CLR_STATUS, OPEN, ACTION_LABEL,
  dict, stats, listItems, saveItem, scrapItem, restoreItem, itemById, itemTimeline,
  createRecord, publishRecord, returnRecord, transferRecord, listRecords, detailRecord,
  personView, overdueList, buildClearance, listClearances, closeClearance,
  listClaims, createClaim, reviewClaim, confirmFinance, board
};
