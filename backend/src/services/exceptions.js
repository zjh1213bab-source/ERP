/**
 * 异常协同与日清（TS-N01-03）
 * ========================================================================
 * 「今天有哪些事没清掉、卡在谁手里、会不会影响交货或收钱」——
 * 这是全公司每天都会问的一句话。本服务把散在 20 多个模块里的异常
 * **扫描**成一张统一清单，并且每条都能点回原单。
 *
 * ## 设计要点（每条都对应一个具体的坑）
 *
 * 1. 扫描而非上报。异常由规则直接判定业务事实，不靠人工提报 ——
 *    漏报的永远是最要命的那些。
 *
 * 2. 幂等。唯一键 (主体, 规则, 来源类型, 来源ID, 区分键) 只约束「未关闭」条目，
 *    同一天扫 10 次还是一条；关掉后复发才生成新条目（那是新事实，不该覆盖历史处理记录）。
 *
 * 3. 「事实消失」≠「人处理完了」。前者记 auto_resolved 并写「由系统按事实消除」，
 *    不计入人工完成量 —— 否则「异常处理率」会虚高。
 *
 * 4. 缺数据写进覆盖率。12 张订单没填交期，不能说「超期 0 单」，
 *    要说「12 张无交期，未参与判定」。同理「人事类暂无自动检测规则」要明说，
 *    不能显示 0 让人误以为没问题。
 *
 * 5. 归口到部门，人落不到就标「待指派」。宁可空着，也不按角色随便抓人顶上。
 *
 * 6. 只写清单，不动业务单据、不动绩效、不动工资（原型明确：预警升级不等于自动处罚）。
 */
const { db } = require('../db');
const { localNow, localDate, toLocal } = require('./sla');
const { nextNo } = require('../utils/docNo');
const gl = require('./gl');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

const CATEGORY_LABEL = {
  tech: '技术',
  material: '缺料',
  quality: '质量',
  capacity: '产能与交付',
  hr: '人事',
  cash: '资金',
  // 原型只要求六类「业务」归口；审批超时不是业务异常而是流程异常，
  // 硬塞进六类里会让「技术类 8 条」看起来像技术部的问题，所以单列。
  governance: '流程与审批'
};

const STATUS_LABEL = {
  open: '待认领',
  claimed: '已认领',
  handling: '处理中',
  waiting: '等外部',
  closed: '已关闭',
  auto_resolved: '已自动消除',
  ignored: '已忽略（数据遗留）'
};

const ACTIVE = ['open', 'claimed', 'handling', 'waiting'];   // 未关闭状态（数组，给 JS 判断用）
const ACTIVE_SQL = "('open','claimed','handling','waiting')";  // 同上，给 SQL 用 —— 两个都要，混用会静默不匹配

/** 日期差（天），b - a */
function daysBetween(a, b) {
  const x = Date.parse(String(a).slice(0, 10) + 'T00:00:00');
  const y = Date.parse(String(b).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return Math.round((y - x) / 86400000);
}

/** 小时差（b - a），入参可为本地串或 ISO */
function hoursBetween(a, b) {
  if (!a || !b) return null;
  const x = Date.parse(String(toLocal(a)).replace(' ', 'T'));
  const y = Date.parse(String(toLocal(b)).replace(' ', 'T'));
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return (y - x) / 3600000;
}

/** 规则配置（DB 里读，页面能改阈值） */
function rules(onlyEnabled = false) {
  const rows = db.prepare('SELECT * FROM exception_rules ORDER BY category, id').all();
  const list = rows.map((r) => ({
    ...r,
    category_label: CATEGORY_LABEL[r.category] || r.category,
    enabled: !!r.enabled
  }));
  return onlyEnabled ? list.filter((r) => r.enabled) : list;
}

function ruleOf(code) {
  return rules().find((r) => r.code === code) || null;
}

/* ==================================================================== *
 * 一、检测器
 * 每个 detector 返回：
 *   { scanned, skipped, skip_reason, items: [...] }
 * scanned 是「本规则判定过的对象数」，skipped 是「因数据缺失没判的」，
 * 两者一起构成覆盖率，页面上必须让用户看见。
 * ==================================================================== */

/** 订单总件数（尺码明细优先，没有再退回款合计） */
function orderQty(orderId) {
  const s = db
    .prepare(
      `SELECT COALESCE(SUM(s.qty),0) q FROM order_item_sizes s
        JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?`
    )
    .get(orderId);
  if (num(s.q) > 0) return r2(s.q);
  const i = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE order_id = ?').get(orderId);
  return r2(i.q);
}

const DETECTORS = {
  /** 订单已过交期未发货 */
  order_overdue(ctx) {
    const rows = db
      .prepare(
        `SELECT id, order_no, style_name, status, delivery_date, total_amount, manager, created_by
           FROM orders
          WHERE status IN ('assigned','production','instock') AND IFNULL(company_id,1) = ?`
      )
      .all(ctx.company_id);
    const out = { scanned: rows.length, skipped: 0, skip_reason: '', items: [] };
    const noDate = [];
    rows.forEach((o) => {
      if (!o.delivery_date) {
        noDate.push(o.order_no);
        return;
      }
      const over = daysBetween(o.delivery_date, ctx.day);
      if (over === null || over <= 0) return;
      out.items.push({
        source_type: 'order',
        source_id: o.id,
        source_no: o.order_no,
        biz_key: '',
        title: `${o.order_no} 超交期 ${over} 天未发货`,
        detail: `款名 ${o.style_name || '—'}，状态 ${o.status}，约定交期 ${String(o.delivery_date).slice(0, 10)}`,
        impact_qty: orderQty(o.id),
        impact_amount: r2(o.total_amount),
        impact_note: '按订单合计金额（含税口径同订单）',
        overdue_days: over,
        owner_name: o.manager || null,
        owner_source: o.manager ? 'order' : 'none',
        need_owner_role: 'production',
        owner_dept: '生产部'
      });
    });
    out.skipped = noDate.length;
    if (noDate.length) {
      out.skip_reason = `${noDate.length} 张在产订单未填交期，未参与超期判定（${noDate.slice(0, 5).join('、')}${noDate.length > 5 ? ' 等' : ''}）`;
    }
    return out;
  },

  /** 订单卡在同一状态超时 */
  order_stuck(ctx) {
    const rule = ruleOf('order_stuck');
    const limit = num(rule && rule.threshold) || 3;
    const rows = db
      .prepare(
        `SELECT o.id, o.order_no, o.style_name, o.status, o.created_at, o.total_amount, o.manager,
                (SELECT MAX(l.created_at) FROM order_logs l WHERE l.order_id = o.id) AS last_log
           FROM orders o
          WHERE o.status NOT IN ('closed','cancelled','shipped') AND IFNULL(o.company_id,1) = ?`
      )
      .all(ctx.company_id);
    const out = { scanned: rows.length, skipped: 0, skip_reason: '', items: [] };
    const noTime = [];
    rows.forEach((o) => {
      // 有流转记录就用最后一条（= 进入当前状态的时刻），没有就退回创建时间
      const since = toLocal(o.last_log || o.created_at);
      if (!since) { noTime.push(o.order_no); return; }
      const stay = daysBetween(String(since).slice(0, 10), ctx.day);
      if (stay === null || stay < limit) return;
      out.items.push({
        source_type: 'order',
        source_id: o.id,
        source_no: o.order_no,
        // 与 order_overdue 区分：同一张单可以同时「超期」和「卡住」，这是两件事
        biz_key: 'stuck',
        title: `${o.order_no} 在「${o.status}」停留 ${stay} 天`,
        detail: `款名 ${o.style_name || '—'}，自 ${String(since).slice(0, 16)} 起无流转`,
        impact_qty: orderQty(o.id),
        impact_amount: r2(o.total_amount),
        impact_note: '按订单合计金额',
        overdue_days: stay,
        owner_name: o.manager || null,
        owner_source: o.manager ? 'order' : 'none',
        need_owner_role: 'sales',
        owner_dept: '总经办'
      });
    });
    out.skipped = noTime.length;
    if (noTime.length) out.skip_reason = `${noTime.length} 张订单无流转时间与创建时间，未参与判定`;
    return out;
  },

  /** 缺料影响开工 */
  material_short(ctx) {
    const live = db
      .prepare(
        `SELECT COUNT(*) c FROM orders WHERE status IN ('assigned','production','instock') AND IFNULL(company_id,1) = ?`
      )
      .get(ctx.company_id).c;
    const calcOrders = db
      .prepare(
        `SELECT COUNT(DISTINCT r.order_id) c FROM material_requirements r
           JOIN orders o ON o.id = r.order_id
          WHERE o.status IN ('assigned','production','instock')`
      )
      .get().c;
    const rows = db
      .prepare(
        `SELECT r.id, r.order_id, r.order_no, r.material_id, r.material_name, r.mat_type, r.unit,
                r.need_qty, r.alloc_stock, r.alloc_po, r.gap_qty, r.gap_amount, r.impact_node, r.status
           FROM material_requirements r
           JOIN orders o ON o.id = r.order_id
          WHERE r.gap_qty > 0.005 AND o.status IN ('assigned','production','instock')
          ORDER BY r.gap_qty DESC`
      )
      .all();

    const out = { scanned: calcOrders, skipped: Math.max(live - calcOrders, 0), skip_reason: '', items: [] };
    // 关键：没算料的订单不是「不缺料」，是「不知道」。必须写进覆盖率。
    if (out.skipped > 0) {
      out.skip_reason = `${out.skipped} 张在产订单尚未齐套算料，无法判定是否缺料（不等于不缺料）`;
    }
    rows.forEach((r) => {
      out.items.push({
        // 幂等键不能用 material_requirements 的行 id：齐套算料是「整批删了重建」，
        // 每算一次 id 就换一批，用行 id 会变成「同一件缺料天天出新单」。
        // 用订单 id + 物料做键，算料重算多少次都是同一条。
        source_type: 'order',
        source_id: r.order_id,
        source_no: r.order_no,
        // 一张订单缺多种料 → 多条异常，用物料区分（否则唯一键会把它们压成一条）
        biz_key: `mat:${r.material_id || r.material_name}`,
        title: `${r.order_no} 缺 ${r.material_name} ${r2(r.gap_qty)}${r.unit || ''}`,
        detail: `需求 ${r2(r.need_qty)} ／ 库存可用 ${r2(r.alloc_stock)} ／ 在途 ${r2(r.alloc_po)}，影响节点：${r.impact_node || '未标注'}`,
        impact_qty: r2(r.gap_qty),
        impact_amount: r2(r.gap_amount),
        impact_note: r.gap_amount == null || num(r.gap_amount) === 0
          ? '未计价（该物料无采购单价），只报数量'
          : '按齐套算料的缺口金额',
        overdue_days: null,
        owner_name: null,
        owner_source: 'none',
        need_owner_role: 'purchase',
        owner_dept: '供应链'
      });
    });
    return out;
  },

  /** 采购超承诺到货日 */
  purchase_late(ctx) {
    const rows = db
      .prepare(
        `SELECT po.id, po.po_no, po.supplier, po.expect_date, po.status,
                SUM(pi.qty - pi.received_qty) pend_qty,
                SUM((pi.qty - pi.received_qty) * pi.price) pend_amount
           FROM purchase_orders po
           JOIN purchase_items pi ON pi.po_id = po.id
          WHERE po.status NOT IN ('cancelled','closed','draft')
          GROUP BY po.id
         HAVING pend_qty > 0.005`
      )
      .all();
    const out = { scanned: rows.length, skipped: 0, skip_reason: '', items: [] };
    const noDate = [];
    rows.forEach((p) => {
      if (!p.expect_date) { noDate.push(p.po_no); return; }
      const over = daysBetween(p.expect_date, ctx.day);
      if (over === null || over <= 0) return;
      out.items.push({
        source_type: 'purchase_order',
        source_id: p.id,
        source_no: p.po_no,
        biz_key: '',
        title: `${p.po_no} 超到货日 ${over} 天`,
        detail: `供应商 ${p.supplier || '—'}，未到货 ${r2(p.pend_qty)}，承诺日 ${String(p.expect_date).slice(0, 10)}`,
        impact_qty: r2(p.pend_qty),
        impact_amount: r2(p.pend_amount),
        impact_note: '按未到货数量 × 采购单价',
        overdue_days: over,
        owner_name: null,
        owner_source: 'none',
        need_owner_role: 'purchase',
        owner_dept: '供应链'
      });
    });
    out.skipped = noDate.length;
    if (noDate.length) {
      out.skip_reason = `${noDate.length} 张未交完的采购单没填承诺到货日（${noDate.slice(0, 5).join('、')}${noDate.length > 5 ? ' 等' : ''}）`;
    }
    return out;
  },

  /** 定制单无已确认技术包就往下走 */
  tech_pack_missing(ctx) {
    const rows = db
      .prepare(
        `SELECT id, order_no, status, style_name, total_amount, manager
           FROM orders
          WHERE type = 'custom' AND status IN ('finance','assigned','production','instock')
            AND IFNULL(company_id,1) = ?`
      )
      .all(ctx.company_id);
    const out = { scanned: rows.length, skipped: 0, skip_reason: '', items: [] };
    rows.forEach((o) => {
      const ok1 = db
        .prepare("SELECT id FROM tech_packs WHERE order_id = ? AND status = 'confirmed' LIMIT 1")
        .get(o.id);
      if (ok1) return;
      const any = db.prepare('SELECT COUNT(*) c FROM tech_packs WHERE order_id = ?').get(o.id).c;
      out.items.push({
        source_type: 'order',
        source_id: o.id,
        source_no: o.order_no,
        // 与 order_overdue / order_stuck 区分：同一张单可能三件事都占
        biz_key: 'tech',
        title: `${o.order_no} 无已确认技术包已在「${o.status}」`,
        detail: any
          ? `有 ${any} 份技术包，但没有一份状态是 confirmed（都在草稿/待确认）`
          : '完全没有技术包记录',
        impact_qty: orderQty(o.id),
        impact_amount: r2(o.total_amount),
        impact_note: '按订单合计金额',
        overdue_days: null,
        owner_name: o.manager || null,
        owner_source: o.manager ? 'order' : 'none',
        need_owner_role: 'tech',
        owner_dept: '技术部'
      });
    });
    return out;
  },

  /** 首件未放行但已投产 */
  fa_not_released(ctx) {    const rows = db
      .prepare(
        `SELECT fa.id, fa.fa_no, fa.order_id, fa.order_no, fa.style_no, fa.status, fa.batch_qty, fa.conclusion,
                (SELECT COUNT(*) FROM production_reports pr WHERE pr.order_id = fa.order_id) AS rpt_cnt
           FROM first_articles fa
          WHERE fa.status NOT IN ('released','cancelled')`
      )
      .all();
    const out = { scanned: rows.length, skipped: 0, skip_reason: '', items: [] };
    rows.forEach((f) => {
      if (!num(f.rpt_cnt)) return;
      out.items.push({
        source_type: 'first_article',
        source_id: f.id,
        source_no: f.fa_no,
        biz_key: '',
        title: `${f.order_no || f.fa_no} 首件未放行已报工 ${f.rpt_cnt} 次`,
        detail: `款号 ${f.style_no || '—'}，首件状态 ${f.status}${f.conclusion ? '，结论 ' + f.conclusion : ''}`,
        impact_qty: r2(f.batch_qty),
        impact_amount: null,
        impact_note: '首件涉及批量件数，不折算金额',
        overdue_days: null,
        owner_name: null,
        owner_source: 'none',
        need_owner_role: 'tech',
        owner_dept: '品控部'
      });
    });
    return out;
  },

  /** 验货不合格未处置 */
  qc_fail_open(ctx) {
    const rows = db
      .prepare(
        `SELECT id, inspect_no, order_id, style_no, aql_result, fail_qty, sample_qty, status, inspect_date
           FROM qc_inspections
          WHERE aql_result = 'fail' AND status NOT IN ('closed','cancelled')`
      )
      .all();
    const out = { scanned: rows.length, skipped: 0, skip_reason: '', items: [] };
    const st = db.prepare('SELECT COUNT(*) c FROM qc_inspections').get().c;
    out.scanned = st;
    rows.forEach((q) => {
      out.items.push({
        source_type: 'qc_inspection',
        source_id: q.id,
        source_no: q.inspect_no,
        biz_key: '',
        title: `${q.inspect_no} 验货不合格未处置`,
        detail: `款号 ${q.style_no || '—'}，抽检 ${r2(q.sample_qty)}，不合格 ${r2(q.fail_qty)}，检验日 ${String(q.inspect_date || '').slice(0, 10)}`,
        impact_qty: r2(q.fail_qty),
        impact_amount: null,
        impact_note: '不合格件数，损失金额待返工/报废单确认',
        overdue_days: null,
        owner_name: null,
        owner_source: 'none',
        need_owner_role: 'tech',
        owner_dept: '品控部'
      });
    });
    return out;
  },

  /** 设备停机超时未恢复 */
  equipment_down(ctx) {
    const rule = ruleOf('equipment_down');
    const limit = num(rule && rule.threshold) || 24;
    const rows = db
      .prepare(
        `SELECT id, dt_no, eq_no, eq_name, work_center, start_at, end_at, status,
                capacity_loss, affected_orders
           FROM equipment_downtimes
          WHERE status NOT IN ('recovered','cancelled')`
      )
      .all();
    const out = { scanned: rows.length, skipped: 0, skip_reason: '', items: [] };
    const noTime = [];
    rows.forEach((e) => {
      if (!e.start_at) { noTime.push(e.dt_no); return; }
      const h = hoursBetween(e.start_at, ctx.nowLocal);
      if (h === null) { noTime.push(e.dt_no); return; }
      if (h < limit) return;
      out.items.push({
        source_type: 'equipment_downtime',
        source_id: e.id,
        source_no: e.dt_no,
        biz_key: '',
        title: `${e.eq_name || e.eq_no} 停机 ${Math.round(h)} 小时未恢复`,
        detail: `工作中心 ${e.work_center || '—'}，状态 ${e.status}，开始 ${String(toLocal(e.start_at)).slice(0, 16)}${e.affected_orders ? '，影响订单 ' + e.affected_orders : ''}`,
        impact_qty: r2(e.capacity_loss),
        impact_amount: null,
        impact_note: '产能损失（台时），不折算金额',
        overdue_days: Math.floor(h / 24),
        owner_name: null,
        owner_source: 'none',
        need_owner_role: 'production',
        owner_dept: '生产部'
      });
    });
    out.skipped = noTime.length;
    if (noTime.length) out.skip_reason = `${noTime.length} 张停机单没有开始时间，未参与判定`;
    return out;
  },

  /** 应收逾期未收 */
  ar_overdue(ctx) {
    const rule = ruleOf('ar_overdue');
    const limit = num(rule && rule.threshold);
    const rows = db
      .prepare(
        `SELECT id, bill_no, customer_id, customer_name, amount, paid_amount, due_date, created_at, currency
           FROM ar_invoices
          WHERE status <> 'void' AND IFNULL(company_id,1) = ?
            AND amount - COALESCE(paid_amount,0) > 0.005`
      )
      .all(ctx.company_id);
    let internal = new Set();
    try {
      internal = new Set(
        db.prepare(
          "SELECT ref_id FROM intercompany_parties WHERE ref_type='customer' AND IFNULL(status,'active')='active' AND ref_id IS NOT NULL"
        ).all().map((x) => Number(x.ref_id))
      );
    } catch (e) { /* 表不存在时按外部处理 */ }

    const out = { scanned: rows.length, skipped: 0, skip_reason: '', items: [] };
    const noDate = [];
    rows.forEach((r) => {
      const base = r.due_date || r.created_at;
      if (!base) { noDate.push(r.bill_no); return; }
      const over = daysBetween(base, ctx.day);
      if (over === null || over <= limit) return;
      const open = r2(num(r.amount) - num(r.paid_amount));
      const isInternal = internal.has(Number(r.customer_id));
      out.items.push({
        source_type: 'ar_invoice',
        source_id: r.id,
        source_no: r.bill_no,
        biz_key: '',
        title: `${r.customer_name || '未知客户'} 逾期 ${over} 天未收 ¥${open}`,
        detail: `发票 ${r.bill_no}，${r.due_date ? '到期日 ' + String(r.due_date).slice(0, 10) : '未填到期日，按开票日 ' + String(r.created_at).slice(0, 10) + ' 计'}${isInternal ? '，集团内部往来' : ''}`,
        impact_qty: null,
        impact_amount: open,
        impact_note: `未收金额（${r.currency || 'CNY'}）`,
        overdue_days: over,
        owner_name: null,
        owner_source: 'none',
        need_owner_role: 'finance',
        owner_dept: '财务部'
      });
    });
    out.skipped = noDate.length;
    if (noDate.length) out.skip_reason = `${noDate.length} 张应收发票无到期日也无开票日，未参与判定`;
    return out;
  },

  /** 应付已过账期未付 */
  ap_overdue(ctx) {
    const rows = db
      .prepare(
        `SELECT id, bill_no, supplier_name, amount, paid_amount, due_date, created_at, currency
           FROM ap_invoices
          WHERE status <> 'void' AND IFNULL(company_id,1) = ?
            AND amount - COALESCE(paid_amount,0) > 0.005`
      )
      .all(ctx.company_id);
    const out = { scanned: rows.length, skipped: 0, skip_reason: '', items: [] };
    const noDate = [];
    rows.forEach((r) => {
      const base = r.due_date || r.created_at;
      if (!base) { noDate.push(r.bill_no); return; }
      const over = daysBetween(base, ctx.day);
      if (over === null || over <= 0) return;
      const open = r2(num(r.amount) - num(r.paid_amount));
      out.items.push({
        source_type: 'ap_invoice',
        source_id: r.id,
        source_no: r.bill_no,
        biz_key: '',
        title: `${r.supplier_name || '未知供应商'} 账期已过 ${over} 天未付 ¥${open}`,
        detail: `发票 ${r.bill_no}，到期日 ${String(base).slice(0, 10)}`,
        impact_qty: null,
        impact_amount: open,
        impact_note: `未付金额（${r.currency || 'CNY'}）`,
        overdue_days: over,
        owner_name: null,
        owner_source: 'none',
        need_owner_role: 'finance',
        owner_dept: '财务部'
      });
    });
    out.skipped = noDate.length;
    if (noDate.length) out.skip_reason = `${noDate.length} 张应付发票无账期日，未参与判定`;
    return out;
  },

  /** 审批超时未处理 */
  approval_timeout(ctx) {
    const rows = db
      .prepare(
        `SELECT t.id, t.step_name, t.approver, t.due_at, t.escalate_level,
                i.target_type, i.target_id
           FROM approval_tasks t
           JOIN approval_instances i ON i.id = t.instance_id
          WHERE t.status = 'pending' AND t.due_at IS NOT NULL AND t.due_at <> ''`
      )
      .all();
    const out = { scanned: rows.length, skipped: 0, skip_reason: '', items: [] };
    const noTime = [];
    rows.forEach((x) => {
      const h = hoursBetween(x.due_at, ctx.nowLocal);
      if (h === null) { noTime.push(String(x.id)); return; }
      if (h <= 0) return;   // 还没到时限
      out.items.push({
        source_type: 'approval_task',
        source_id: x.id,
        source_no: `#${x.id}`,
        biz_key: '',
        title: `审批「${x.step_name || '待办'}」超时 ${Math.round(h)} 小时`,
        detail: `单据 ${x.target_type}#${x.target_id}，应处理时限 ${String(toLocal(x.due_at)).slice(0, 16)}，审批人 ${x.approver || '未指定'}`,
        impact_qty: null,
        impact_amount: null,
        impact_note: '不折算金额；超时只提醒，不自动通过',
        overdue_days: Math.floor(h / 24),
        owner_name: x.approver || null,
        owner_source: x.approver ? 'order' : 'none',
        need_owner_role: 'admin',
        owner_dept: '总经办'
      });
    });
    out.skipped = noTime.length;
    if (noTime.length) out.skip_reason = `${noTime.length} 条审批任务时限格式无法解析，未参与判定`;
    return out;
  }
};

/* ==================================================================== *
 * 二、扫描
 * ==================================================================== */

/**
 * 跑一遍扫描（幂等）
 *
 * @param {object} opt { day, company_id, operator, rules? }
 * @returns 本次结果：新开 / 仍在 / 自动消除 / 升级 / 覆盖率
 */
function scan(opt = {}) {
  const companyId = Number(opt.company_id) || gl.companyOf();
  const day = String(opt.day || localDate()).slice(0, 10);
  const ctx = { day, company_id: companyId, nowLocal: localNow() };
  const t = new Date().toISOString();

  const list = rules(true).filter((r) => !opt.rules || opt.rules.includes(r.code));
  let opened = 0, refreshed = 0, autoResolved = 0, escalated = 0, suppressed = 0;
  const coverage = [];
  const created = [];

  const findOpen = db.prepare(
    `SELECT * FROM exception_items
      WHERE company_id=? AND rule_code=? AND source_type=? AND source_id=? AND biz_key=?
        AND status NOT IN ('closed','auto_resolved','ignored')`
  );
  // 「标为数据遗留」的事实：未到期就不再提醒；到期后会重新开一条（旧条目保留状态）
  const findIgnored = db.prepare(
    `SELECT id, ignore_until FROM exception_items
      WHERE company_id=? AND rule_code=? AND source_type=? AND source_id=? AND biz_key=?
        AND status='ignored'`
  );
  // 「系统按事实消除」过的同一事实又出现了 —— 说明上游数据在抖（比如齐套算料重算），
  // 这不是新问题，应当把原条目恢复成 open，而不是每次新建一条。
  // 否则一天重算十次就堆十张单，日清里看着像「反复出现」，实际是同一件事。
  const findAuto = db.prepare(
    `SELECT id, auto_resolved_at FROM exception_items
      WHERE company_id=? AND rule_code=? AND source_type=? AND source_id=? AND biz_key=?
        AND status='auto_resolved'
      ORDER BY id DESC LIMIT 1`
  );
  const reopenAuto = db.prepare(
    `UPDATE exception_items
        SET status='open', auto_resolved_at=NULL, auto_resolve_note=NULL, escalated=0,
            last_seen_at=?, seen_count=seen_count+1, title=?, detail=?, impact_qty=?, impact_amount=?,
            impact_note=?, overdue_days=?, updated_at=?
      WHERE id=?`
  );
  const insItem = db.prepare(
    `INSERT INTO exception_items
      (item_no, company_id, rule_code, category, severity, first_day, last_seen_at, seen_count,
       source_type, source_id, source_no, biz_key, title, detail, impact_qty, impact_amount, impact_note,
       overdue_days, owner_user_id, owner_username, owner_name, owner_source, owner_dept,
       status, escalated, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',0,?,?)`
  );
  const touchItem = db.prepare(
    `UPDATE exception_items
        SET last_seen_at=?, seen_count=seen_count+1, title=?, detail=?, impact_qty=?, impact_amount=?,
            impact_note=?, overdue_days=?, updated_at=?
      WHERE id=?`
  );
  const resolveItem = db.prepare(
    `UPDATE exception_items
        SET status='auto_resolved', auto_resolved_at=?, auto_resolve_note=?, updated_at=?
      WHERE id=?`
  );
  const insAct = db.prepare(
    `INSERT INTO exception_actions (item_id, action, from_status, to_status, operator, target, reason, payload, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  db.exec('BEGIN');
  try {
    list.forEach((rule) => {
      const fn = DETECTORS[rule.code];
      if (!fn) {
        coverage.push({ rule: rule.code, name: rule.name, scanned: 0, skipped: 0, skip_reason: '暂无自动检测实现' });
        return;
      }
      const res = fn(ctx) || { scanned: 0, skipped: 0, skip_reason: '', items: [] };
      const seenKeys = new Set();

      res.items.forEach((it) => {
        const key = `${it.source_type}|${it.source_id}|${it.biz_key || ''}`;
        seenKeys.add(key);

        // 已标为数据遗留且未到期 → 不再提醒（日清要能清零，否则没人看）
        const ign = findIgnored.get(companyId, rule.code, it.source_type, it.source_id, it.biz_key || '');
        if (ign && (!ign.ignore_until || String(ign.ignore_until).slice(0, 10) >= day)) {
          suppressed += 1;
          return;
        }

        const existed = findOpen.get(companyId, rule.code, it.source_type, it.source_id, it.biz_key || '');
        if (existed) {
          touchItem.run(t, it.title, it.detail || '', it.impact_qty, it.impact_amount,
            it.impact_note || '', it.overdue_days, t, existed.id);
          refreshed += 1;
          return;
        }

        // 之前被系统按事实消除过（不是人关的）→ 恢复原条目，不新建
        const back1 = findAuto.get(companyId, rule.code, it.source_type, it.source_id, it.biz_key || '');
        if (back1) {
          reopenAuto.run(t, it.title, it.detail || '', it.impact_qty, it.impact_amount,
            it.impact_note || '', it.overdue_days, t, back1.id);
          insAct.run(back1.id, 'reopen', 'auto_resolved', 'open', '系统', null,
            '同一事实再次出现（上游数据变化），恢复原条目而不是新开一张', null, t);
          refreshed += 1;
          return;
        }
        const id = insItem.run(
          nextNo('EX', 'exception_items', 'item_no'),
          companyId, rule.code, rule.category, rule.severity || 'warn', day, t,
          it.source_type, it.source_id, it.source_no || null, it.biz_key || '',
          it.title, it.detail || null, it.impact_qty, it.impact_amount, it.impact_note || null,
          it.overdue_days,
          null, null, it.owner_name || null, it.owner_source || 'none', it.owner_dept || rule.owner_dept,
          t, t
        ).lastInsertRowid;
        insAct.run(id, 'detect', null, 'open', '系统', null, null,
          JSON.stringify({ rule: rule.code, scanned: res.scanned }), t);
        opened += 1;
        created.push({ id, title: it.title, category: rule.category });
      });

      // 事实消失 → 自动消除（不是人处理的，单独记）
      const stillOpen = db
        .prepare(
          `SELECT id, source_type, source_id, biz_key, title FROM exception_items
            WHERE company_id=? AND rule_code=? AND status NOT IN ('closed','auto_resolved','ignored')`
        )
        .all(companyId, rule.code);
      stillOpen.forEach((row) => {
        const key = `${row.source_type}|${row.source_id}|${row.biz_key || ''}`;
        if (seenKeys.has(key)) return;
        const note = '本次扫描未再检出该事实（单据状态已变或已处理），由系统按事实自动消除';
        resolveItem.run(t, note, t, row.id);
        insAct.run(row.id, 'auto_resolve', 'open', 'auto_resolved', '系统', null, note, null, t);
        autoResolved += 1;
      });

      coverage.push({
        rule: rule.code,
        name: rule.name,
        category: rule.category,
        category_label: CATEGORY_LABEL[rule.category] || rule.category,
        scanned: res.scanned,
        found: res.items.length,
        skipped: res.skipped || 0,
        skip_reason: res.skip_reason || ''
      });
    });

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // 升级判定放在事务外（只是标记，失败不影响清单）
  escalated = escalateTick({ companyId, operator: opt.operator || '系统' });

  const mustDo = daily({ day, company_id: companyId }).must.length;

  // 覆盖率里「没有规则的类别」要显式说明，不能让人以为 0 异常。
  // 多个类别合并成一条 —— 逐类各写一行会把提示框撑成噪音，反而没人看。
  const covered = new Set(list.map((r) => r.category));
  const gapCats = Object.keys(CATEGORY_LABEL)
    .filter((c) => !covered.has(c))
    .map((c) => CATEGORY_LABEL[c]);
  const catGaps = gapCats.length
    ? [{ category: 'multi', category_label: gapCats.join('、'), reason: '暂无自动检测规则，需人工排查' }]
    : [];

  const summary = categoryCount(companyId);

  db.prepare(
    `INSERT INTO daily_clear_batches
       (batch_no, company_id, day, data_until, scanned_rules, opened, refreshed, auto_resolved, escalated, must_do, coverage, summary, generated_by, generated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(company_id, day) DO UPDATE SET
       data_until=excluded.data_until, scanned_rules=excluded.scanned_rules,
       opened=excluded.opened, refreshed=excluded.refreshed, auto_resolved=excluded.auto_resolved,
       escalated=excluded.escalated, must_do=excluded.must_do, coverage=excluded.coverage,
       summary=excluded.summary, generated_by=excluded.generated_by, generated_at=excluded.generated_at`
  ).run(
    `DC${day.replace(/-/g, '')}`, companyId, day, ctx.nowLocal, list.length,
    opened, refreshed, autoResolved, escalated, mustDo,
    JSON.stringify({ rules: coverage, category_gaps: catGaps }),
    JSON.stringify(summary), opt.operator || '系统', t
  );

  return {
    day,
    company_id: companyId,
    data_until: ctx.nowLocal,
    rules_scanned: list.length,
    opened,
    refreshed,
    auto_resolved: autoResolved,
    escalated,
    // 因「标为数据遗留」而未再提醒的条数（要让人知道有东西被压住了）
    suppressed,
    must_do: mustDo,
    created,
    coverage,
    category_gaps: catGaps,
    summary
  };
}

/* ==================================================================== *
 * 三、升级
 * ==================================================================== */

/**
 * 升级判定：只标「该有人管但没人管」的
 *
 * 两种升级：
 *   1. 还没人认领，且从首次发现到现在超过规则 SLA
 *   2. 有人认领，但过了「预计解决日」仍未关闭
 *
 * 只升一级，不重复刷流水（escalated_at 已有就跳过）。
 */
function escalateTick(opt = {}) {
  const companyId = Number(opt.companyId) || gl.companyOf();
  const nowLocalStr = localNow();
  const t = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT i.*, r.sla_hours FROM exception_items i
         JOIN exception_rules r ON r.code = i.rule_code
        WHERE i.company_id = ? AND i.status IN ${ACTIVE_SQL} AND i.escalated = 0`
    )
    .all(companyId);

  let n = 0;
  const insAct = db.prepare(
    `INSERT INTO exception_actions (item_id, action, from_status, to_status, operator, target, reason, payload, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const upd = db.prepare(
    'UPDATE exception_items SET escalated=1, escalated_at=?, escalate_reason=?, updated_at=? WHERE id=?'
  );

  rows.forEach((r) => {
    let reason = null;
    const ageH = hoursBetween(r.first_seen_at || r.created_at, nowLocalStr);
    if (r.status === 'open' && ageH !== null && ageH > num(r.sla_hours)) {
      reason = `首次发现后 ${Math.round(ageH)} 小时无人认领（SLA ${num(r.sla_hours)} 小时），升级到归口 ${r.owner_dept || '部门'} 负责人`;
    } else if (r.expect_date && daysBetween(r.expect_date, String(nowLocalStr).slice(0, 10)) > 0) {
      reason = `已过预计解决日 ${r.expect_date} 仍未关闭`;
    }
    if (!reason) return;
    upd.run(t, reason, t, r.id);
    insAct.run(r.id, 'escalate', r.status, r.status, opt.operator || '系统', r.owner_dept || null, reason, null, t);
    n += 1;
  });
  return n;
}

/* ==================================================================== *
 * 四、日清视图
 * ==================================================================== */

/** 六类归口计数（只算未关闭） */
function categoryCount(companyId) {
  const co = Number(companyId) || gl.companyOf();
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) c, SUM(escalated) e FROM exception_items
        WHERE company_id = ? AND status IN ${ACTIVE_SQL} GROUP BY category`
    )
    .all(co);
  const map = {};
  rows.forEach((r) => { map[r.category] = { count: r.c, escalated: r.e || 0 }; });
  return Object.keys(CATEGORY_LABEL).map((c) => ({
    category: c,
    label: CATEGORY_LABEL[c],
    count: map[c] ? map[c].count : 0,
    escalated: map[c] ? map[c].escalated : 0
  }));
}

/**
 * 日清清单
 *
 * 「今日必办」只收三类（原型：日清只处理升级事项，不是所有任务重新审批）：
 *   - 已升级（超 SLA 没人管 / 过了预计解决日）
 *   - 今日新增
 *   - 待认领且停留超 SLA 的
 * 其余在 SLA 内、已有人认领在办的进「处理中」。
 */
function daily(opt = {}) {
  const co = Number(opt.company_id) || gl.companyOf();
  const day = String(opt.day || localDate()).slice(0, 10);
  const rows = db
    .prepare(
      `SELECT i.*, r.name AS rule_name, r.sla_hours FROM exception_items i
         LEFT JOIN exception_rules r ON r.code = i.rule_code
        WHERE i.company_id = ? AND i.status IN ${ACTIVE_SQL}
        ORDER BY i.escalated DESC, i.severity = 'serious' DESC, i.id ASC`
    )
    .all(co);

  const nowLocalStr = localNow();
  const must = [];
  const doing = [];
  rows.forEach((r) => {
    const ageH = hoursBetween(r.first_seen_at || r.created_at, nowLocalStr);
    const overExpect = r.expect_date ? daysBetween(r.expect_date, day) > 0 : false;
    const isNew = String(r.first_day) === day;
    const staleNoOwner = r.status === 'open' && ageH !== null && ageH > num(r.sla_hours);
    const row = decorate(r);
    // 必办口径（原型：日清只处理升级事项，不是把所有待办重列一遍）：
    //   已升级 / 严重级 / 超 SLA 未认领 / 过预计解决日
    // 今日新增但普通级、且仍在 SLA 内的，进「处理中」并标「今日新进」——
    // 否则上线第一天会把存量全砸进必办，第三天就没人打开了。
    const serious = r.severity === 'serious';
    if (r.escalated || serious || overExpect || staleNoOwner) {
      row.why = r.escalated ? '已升级'
        : (serious ? '严重级'
          : (overExpect ? '过预计解决日' : '超时未认领'));
      must.push(row);
    } else {
      if (isNew) row.why = '今日新进';
      doing.push(row);
    }
  });

  const autoToday = db
    .prepare(
      `SELECT COUNT(*) c FROM exception_items
        WHERE company_id = ? AND status = 'auto_resolved' AND substr(auto_resolved_at,1,10) = ?`
    )
    .get(co, day).c;

  const batch = db
    .prepare('SELECT * FROM daily_clear_batches WHERE company_id = ? AND day = ?')
    .get(co, day);

  return {
    day,
    company_id: co,
    data_until: batch ? batch.data_until : null,
    must,
    doing,
    auto_resolved_today: autoToday,
    summary: categoryCount(co),
    /**
     * 覆盖率**只来自当天已生成的那次扫描**，不现算
     *
     * 现算等于把 11 条规则全跑一遍（重查询 + 建单副作用），一个 GET 不该干这个；
     * 而且"这次看到的覆盖率"必须与"这批清单"是同一次扫描的产物，否则
     * 清单里 3 条、覆盖率说扫了 500 张单，对不上。
     *
     * 但**没扫过 ≠ 没有缺口**：`coverage: null` 时页面如果什么都不显示，
     * 人会以为"今天没异常"（实际是"今天没扫"）。所以额外给一个 `coverage_pending`，
     * 前端据此提示"今日尚未扫描"，而不是静默留白。
     */
    coverage: batch ? JSON.parse(batch.coverage || '{}') : null,
    coverage_pending: !batch,
    batch: batch || null
  };
}

function decorate(r) {
  const rule = ruleOf(r.rule_code);
  return {
    id: r.id,
    item_no: r.item_no,
    rule_code: r.rule_code,
    rule_name: rule ? rule.name : r.rule_code,
    category: r.category,
    category_label: CATEGORY_LABEL[r.category] || r.category,
    severity: r.severity,
    first_day: r.first_day,
    seen_count: r.seen_count,
    source_type: r.source_type,
    source_id: r.source_id,
    source_no: r.source_no,
    biz_key: r.biz_key,
    title: r.title,
    detail: r.detail,
    impact_qty: r.impact_qty,
    impact_amount: r.impact_amount,
    impact_note: r.impact_note,
    overdue_days: r.overdue_days,
    owner_name: r.owner_name,
    owner_username: r.owner_username,
    owner_source: r.owner_source,
    owner_source_label: { order: '原单负责人', assign: '人工指派', none: '待指派' }[r.owner_source] || r.owner_source,
    owner_dept: r.owner_dept,
    status: r.status,
    status_label: STATUS_LABEL[r.status] || r.status,
    cause: r.cause,
    expect_date: r.expect_date,
    result: r.result,
    escalated: !!r.escalated,
    escalate_reason: r.escalate_reason,
    review_status: r.review_status,
    ignore_reason: r.ignore_reason || null,
    ignore_until: r.ignore_until || null,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

/* ==================================================================== *
 * 五、列表与详情
 * ==================================================================== */

function list(q = {}) {
  const co = Number(q.company_id) || gl.companyOf();
  const where = ['i.company_id = ?'];
  const args = [co];
  if (q.status) {
    if (q.status === 'active') where.push(`i.status IN ${ACTIVE_SQL}`);
    else { where.push('i.status = ?'); args.push(q.status); }
  } else {
    where.push(`i.status IN ${ACTIVE_SQL}`);
  }
  if (q.category) { where.push('i.category = ?'); args.push(q.category); }
  if (q.rule) { where.push('i.rule_code = ?'); args.push(q.rule); }
  if (q.escalated === '1' || q.escalated === true) where.push('i.escalated = 1');
  if (q.viewer_username) { where.push('i.owner_username = ?'); args.push(q.viewer_username); }
  if (q.owner) { where.push('(i.owner_username = ? OR i.owner_name = ?)'); args.push(q.owner, q.owner); }
  if (q.no_owner === '1') where.push("i.owner_source = 'none'");
  if (q.q) {
    where.push('(i.title LIKE ? OR i.source_no LIKE ? OR i.item_no LIKE ?)');
    args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  const rows = db
    .prepare(
      `SELECT i.*, r.name AS rule_name FROM exception_items i
         LEFT JOIN exception_rules r ON r.code = i.rule_code
        WHERE ${where.join(' AND ')}
        ORDER BY i.escalated DESC, i.severity = 'serious' DESC, i.id DESC
        LIMIT 500`
    )
    .all(...args);
  return rows.map(decorate);
}

function get(id) {
  const r = db
    .prepare(
      `SELECT i.*, r.name AS rule_name, r.rule_note, r.sla_hours FROM exception_items i
         LEFT JOIN exception_rules r ON r.code = i.rule_code WHERE i.id = ?`
    )
    .get(id);
  if (!r) throw bad('异常条目不存在', 404);
  const acts = db
    .prepare('SELECT * FROM exception_actions WHERE item_id = ? ORDER BY id ASC')
    .all(id)
    .map((a) => ({
      ...a,
      action_label: {
        detect: '系统检出', claim: '认领', assign: '指派', note: '备注',
        close: '关闭', reopen: '重开', review: '复核', auto_resolve: '系统自动消除', escalate: '升级',
        ignore: '标为数据遗留'
      }[a.action] || a.action
    }));
  return {
    ...decorate(r),
    rule_note: r.rule_note,
    sla_hours: r.sla_hours,
    actions: acts
  };
}

/* ==================================================================== *
 * 六、动作
 * ==================================================================== */

function logAct(itemId, action, from, to, operator, target, reason, payload) {
  db.prepare(
    `INSERT INTO exception_actions (item_id, action, from_status, to_status, operator, target, reason, payload, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(itemId, action, from, to, operator || null, target || null, reason || null,
    payload ? JSON.stringify(payload) : null, new Date().toISOString());
}

/** 认领：谁认领谁负责，认领后 owner_source 变 assign */
function claim(id, opt = {}) {
  const r = db.prepare('SELECT * FROM exception_items WHERE id = ?').get(id);
  if (!r) throw bad('异常条目不存在', 404);
  if (!ACTIVE.includes(r.status)) throw bad('该条目已关闭，不能再认领');
  if (r.owner_username && r.owner_username !== opt.username) {
    throw bad(`已由 ${r.owner_name || r.owner_username} 认领，要接手请让 TA 转派或由管理员改派`);
  }
  const t = new Date().toISOString();
  db.prepare(
    `UPDATE exception_items SET status='claimed', owner_username=?, owner_name=?, owner_source='assign',
       escalated=0, updated_at=? WHERE id=?`
  ).run(opt.username || null, opt.name || opt.username || null, t, id);
  logAct(id, 'claim', r.status, 'claimed', opt.name || opt.username, null, null);
  return get(id);
}

/** 指派 / 转派：必须写原因（谁的责任被挪走了，事后要能查） */
function assign(id, opt = {}) {
  const r = db.prepare('SELECT * FROM exception_items WHERE id = ?').get(id);
  if (!r) throw bad('异常条目不存在', 404);
  if (!ACTIVE.includes(r.status)) throw bad('该条目已关闭，不能再指派');
  const to = String(opt.to_username || opt.to_name || '').trim();
  if (!to) throw bad('请指定接收人');
  const reason = String(opt.reason || '').trim();
  if (reason.length < 4) throw bad('转派必须写原因（至少 4 个字），否则事后查不出为什么换人');
  const user = db
    .prepare('SELECT id, username, name, department_id FROM users WHERE (username = ? OR name = ?) AND active = 1')
    .get(to, to);
  if (!user) throw bad(`接收人「${to}」不存在或已停用`, 404);
  const t = new Date().toISOString();
  const isTransfer = !!r.owner_username;
  db.prepare(
    `UPDATE exception_items SET status=IFNULL(NULLIF(status,'open'),'claimed'),
       owner_user_id=?, owner_username=?, owner_name=?, owner_source='assign', escalated=0, updated_at=?
     WHERE id=?`
  ).run(user.id, user.username, user.name, t, id);
  logAct(id, 'assign', r.status, 'claimed', opt.operator || null, user.name,
    (isTransfer ? '转派：' : '指派：') + reason);
  return get(id);
}

/**
 * 关闭：处理结果必填
 *
 * 原因（cause）是「为什么会这样」，结果（result）是「怎么解决的」——
 * 两个都要，因为月度复盘要看前者、追责看后者。只填一个的话，
 * 下个月同类问题照样发生，没人知道根因。
 */
function close(id, opt = {}) {
  const r = db.prepare('SELECT * FROM exception_items WHERE id = ?').get(id);
  if (!r) throw bad('异常条目不存在', 404);
  if (!ACTIVE.includes(r.status)) throw bad('该条目已关闭');
  const cause = String(opt.cause || r.cause || '').trim();
  const result = String(opt.result || '').trim();
  if (cause.length < 4) throw bad('请写原因（至少 4 个字）：这条异常为什么会发生');
  if (result.length < 4) throw bad('请写处理结果（至少 4 个字）：具体怎么解决的');
  const t = new Date().toISOString();
  db.prepare(
    `UPDATE exception_items SET status='closed', cause=?, result=?, expect_date=IFNULL(?, expect_date),
       closed_by=?, closed_at=?, updated_at=?, review_status='pending'
     WHERE id=?`
  ).run(cause, result, opt.expect_date || null, opt.operator || null, t, t, id);
  logAct(id, 'close', r.status, 'closed', opt.operator || null, null, result, { cause });
  return get(id);
}

/** 复核：复核人不能是处理人（自己复核自己等于没复核） */
function review(id, opt = {}) {
  const r = db.prepare('SELECT * FROM exception_items WHERE id = ?').get(id);
  if (!r) throw bad('异常条目不存在', 404);
  if (r.status !== 'closed') throw bad('只有已关闭的条目才需要复核');
  if (r.review_status === 'passed') throw bad('该条目已复核通过');
  if (!opt.operator) throw bad('缺少复核人');
  if (r.closed_by && r.closed_by === opt.operator) {
    throw bad('复核人不能是处理人本人，请换一个人复核');
  }
  const pass = opt.pass === true || opt.pass === 'true' || opt.pass === 1;
  const note = String(opt.note || '').trim();
  if (!pass && note.length < 4) throw bad('复核不通过必须写原因');
  const t = new Date().toISOString();
  if (pass) {
    db.prepare("UPDATE exception_items SET review_status='passed', reviewed_by=?, reviewed_at=?, review_note=?, updated_at=? WHERE id=?")
      .run(opt.operator, t, note || null, t, id);
    logAct(id, 'review', 'closed', 'closed', opt.operator, null, '复核通过' + (note ? '：' + note : ''));
  } else {
    // 复核不通过 → 打回处理中，重新办
    db.prepare("UPDATE exception_items SET review_status='rejected', reviewed_by=?, reviewed_at=?, review_note=?, status='handling', closed_at=NULL, closed_by=NULL, updated_at=? WHERE id=?")
      .run(opt.operator, t, note, t, id);
    logAct(id, 'review', 'closed', 'handling', opt.operator, null, '复核不通过，打回重办：' + note);
  }
  return get(id);
}

/** 加备注（不改状态） */
function note(id, opt = {}) {
  const r = db.prepare('SELECT * FROM exception_items WHERE id = ?').get(id);
  if (!r) throw bad('异常条目不存在', 404);
  const txt = String(opt.note || '').trim();
  if (txt.length < 2) throw bad('备注不能为空');
  const t = new Date().toISOString();
  db.prepare("UPDATE exception_items SET note = TRIM(IFNULL(note,'') || char(10) || ?), updated_at=? WHERE id=?")
    .run(`[${localNow().slice(0, 16)} ${opt.operator || '系统'}] ${txt}`, t, id);
  logAct(id, 'note', r.status, r.status, opt.operator || null, null, txt);
  return get(id);
}

/** 重开：只允许「自动消除」的条目重开（人工关掉的要重开说明原处理无效，走备注+新单） */
function reopen(id, opt = {}) {
  const r = db.prepare('SELECT * FROM exception_items WHERE id = ?').get(id);
  if (!r) throw bad('异常条目不存在', 404);
  if (r.status !== 'auto_resolved') throw bad('只有系统自动消除的条目可以重开；人工关闭的请新开一条');
  const reason = String(opt.reason || '').trim();
  if (reason.length < 4) throw bad('重开必须写原因');
  const t = new Date().toISOString();
  db.prepare(
    `UPDATE exception_items SET status='open', auto_resolved_at=NULL, auto_resolve_note=NULL,
       escalated=0, updated_at=? WHERE id=?`
  ).run(t, id);
  logAct(id, 'reopen', 'auto_resolved', 'open', opt.operator || null, null, reason);
  return get(id);
}

/**
 * 标为数据遗留（不再提醒）
 *
 * 为什么必须有这个动作：日清要能清零。
 * 历史夹具单、系统迁移带进来的老单据、已经确认不适用的事实，
 * 如果每次扫描都重新报出来，清单永远降不到 0，第三次之后没人再打开它 ——
 * 那这个模块就白做了。
 *
 * 但「不再提醒」不是「当它没发生」：
 *   - 必须写理由（至少 4 个字）
 *   - 可以设到期日，到期后自动重新检出（临时豁免要能自动失效）
 *   - 状态是 ignored 而不是 closed，单独统计，不算处理完成
 *   - 被压住的条数会出现在扫描结果的 suppressed 里，不静默
 */
function ignore(id, opt = {}) {
  const r = db.prepare('SELECT * FROM exception_items WHERE id = ?').get(id);
  if (!r) throw bad('异常条目不存在', 404);
  if (!ACTIVE.includes(r.status)) throw bad('只有未关闭的条目可以标为数据遗留');
  const reason = String(opt.reason || '').trim();
  if (reason.length < 4) throw bad('标为数据遗留必须写理由（至少 4 个字），否则下次没人知道为什么不再提醒');
  const until = opt.until ? String(opt.until).slice(0, 10) : null;
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw bad('到期日格式应为 YYYY-MM-DD');
  if (until && daysBetween(localDate(), until) < 0) throw bad('到期日不能早于今天');
  const t = new Date().toISOString();
  db.prepare(
    "UPDATE exception_items SET status='ignored', ignore_reason=?, ignore_until=?, escalated=0, updated_at=? WHERE id=?"
  ).run(reason, until, t, id);
  logAct(id, 'ignore', r.status, 'ignored', opt.operator || null, null,
    reason + (until ? `（豁免至 ${until}）` : '（永久豁免）'));
  return get(id);
}

/* ==================================================================== *
 * 七、统计与日报
 * ==================================================================== */

function stats(companyId) {
  const co = Number(companyId) || gl.companyOf();
  // 今天（本地日）—— 补参数时漏了它会让整条 SQL 报「Too few parameter values」，
  // 而 stats 一挂，页面顶部全空（这个坑踩过一次）
  const day = localDate();
  const g = (sql, ...a) => db.prepare(sql).get(co, ...a);
  return {
    active: g(`SELECT COUNT(*) c FROM exception_items WHERE company_id=? AND status IN ${ACTIVE_SQL}`).c,
    escalated: g(`SELECT COUNT(*) c FROM exception_items WHERE company_id=? AND status IN ${ACTIVE_SQL} AND escalated=1`).c,
    no_owner: g(`SELECT COUNT(*) c FROM exception_items WHERE company_id=? AND status IN ${ACTIVE_SQL} AND owner_source='none'`).c,
    serious: g(`SELECT COUNT(*) c FROM exception_items WHERE company_id=? AND status IN ${ACTIVE_SQL} AND severity='serious'`).c,
    closed_today: g("SELECT COUNT(*) c FROM exception_items WHERE company_id=? AND status='closed' AND substr(closed_at,1,10)=?", day).c,
    auto_today: g("SELECT COUNT(*) c FROM exception_items WHERE company_id=? AND status='auto_resolved' AND substr(auto_resolved_at,1,10)=?", day).c,
    pending_review: g(`SELECT COUNT(*) c FROM exception_items WHERE company_id=? AND status='closed' AND review_status='pending'`).c,
    // 被压住不提醒的条数：要能看见，否则「清零」可能是假的
    ignored: g("SELECT COUNT(*) c FROM exception_items WHERE company_id=? AND status='ignored'").c,
    categories: categoryCount(co)
  };
}

/**
 * 日报初稿
 *
 * 原型要求：由**已确认的业务事件和统一指标**生成初稿，列数据截止、
 * 已完成、处理中、等待谁、超时、责任和下一步，附原单链接；
 * 员工只补充系统外的事实；AI 可解释整理但**不能编造数量/金额**。
 *
 * 所以这里每一行都来自库里，没有一句是「生成」出来的。
 */
function dailyReport(opt = {}) {
  const co = Number(opt.company_id) || gl.companyOf();
  const day = String(opt.day || localDate()).slice(0, 10);
  const d = daily({ day, company_id: co });
  const closedToday = db
    .prepare(
      `SELECT * FROM exception_items WHERE company_id=? AND status='closed' AND substr(closed_at,1,10)=? ORDER BY closed_at`
    )
    .all(co, day)
    .map(decorate);
  const autoToday = db
    .prepare(
      `SELECT * FROM exception_items WHERE company_id=? AND status='auto_resolved' AND substr(auto_resolved_at,1,10)=? ORDER BY auto_resolved_at`
    )
    .all(co, day)
    .map(decorate);
  const waiting = d.doing.filter((x) => x.status === 'waiting');

  const waitingWho = {};
  d.must.concat(d.doing).forEach((x) => {
    const k = x.owner_name || '待指派';
    waitingWho[k] = (waitingWho[k] || 0) + 1;
  });

  return {
    day,
    data_until: d.data_until,
    generated_at: localNow(),
    sections: {
      done: { title: '已完成', rows: closedToday },
      doing: { title: '处理中', rows: d.doing.filter((x) => x.status !== 'waiting') },
      waiting: { title: '等待外部', rows: waiting },
      overdue: { title: '超时/升级', rows: d.must.filter((x) => x.escalated) },
      auto: { title: '系统按事实消除', rows: autoToday }
    },
    counts: {
      done: closedToday.length,
      doing: d.doing.length - waiting.length,
      waiting: waiting.length,
      must: d.must.length,
      auto: autoToday.length
    },
    by_owner: Object.entries(waitingWho).map(([k, v]) => ({ owner: k, count: v })).sort((a, b) => b.count - a.count),
    coverage: d.coverage,
    summary: d.summary,
    // 明确写出来：这些数字来自系统单据，没填的字段就是没填，不补 0
    basis: '本初稿全部取自已录入系统的单据与规则判定结果，未做任何推算；标「待指派」的是系统解析不到责任人，需人工指定。'
  };
}

/* ==================================================================== *
 * 八、字典与规则维护
 * ==================================================================== */

function dict() {
  return {
    categories: Object.entries(CATEGORY_LABEL).map(([code, label]) => ({ code, label })),
    statuses: Object.entries(STATUS_LABEL).map(([code, label]) => ({ code, label })),
    rules: rules(),
    users: db
      .prepare("SELECT username, name, role FROM users WHERE active = 1 ORDER BY id")
      .all()
  };
}

/** 改阈值 / 启停：阈值改了下次扫描生效，不动历史条目 */
function saveRule(code, opt = {}) {
  const r = ruleOf(code);
  if (!r) throw bad('规则不存在', 404);
  const t = new Date().toISOString();
  const threshold = opt.threshold === undefined || opt.threshold === null || opt.threshold === ''
    ? r.threshold : Number(opt.threshold);
  if (Number.isNaN(threshold)) throw bad('阈值必须是数字');
  const sla = opt.sla_hours === undefined ? r.sla_hours : Number(opt.sla_hours);
  if (!Number.isFinite(sla) || sla <= 0) throw bad('SLA 小时必须大于 0');
  const enabled = opt.enabled === undefined ? r.enabled : (opt.enabled ? 1 : 0);
  db.prepare(
    'UPDATE exception_rules SET threshold=?, sla_hours=?, enabled=?, rule_note=IFNULL(?, rule_note), updated_at=? WHERE code=?'
  ).run(threshold, sla, enabled, opt.rule_note || null, t, code);
  return ruleOf(code);
}

module.exports = {
  CATEGORY_LABEL,
  STATUS_LABEL,
  rules,
  ruleOf,
  scan,
  escalateTick,
  daily,
  list,
  get,
  claim,
  assign,
  close,
  review,
  note,
  reopen,
  ignore,
  stats,
  dailyReport,
  dict,
  saveRule,
  DETECTORS
};
