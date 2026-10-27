/**
 * 异常解释与可控动作（M17 N17-04）
 *
 * 分级（写死在返回里，不给模型发挥空间）：
 *   read  只解释「为什么会这样」，不产生任何单据
 *   draft 需要人做的动作，AI 只生成草稿，人工核准后才生效
 *   （没有 execute —— 付款、工资、出厂价、质检判定、跨货调整这些动作 AI 一律不能做）
 *
 * 解释必须是「有证据的因果」，不是「可能吧」：
 *   每条结论都要带上支撑它的单据号/数量/日期，让人能点进去核。
 */
const { db } = require('../db');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;

/** 单号 → 订单 */
function findOrder(no) {
  if (!no) return null;
  return db.prepare('SELECT * FROM orders WHERE order_no=?').get(String(no).trim());
}

/** 解释：订单为什么卡住 / 延期 */
function explainOrder(o) {
  const findings = [];
  const nodes = db.prepare('SELECT * FROM order_nodes WHERE order_id=? ORDER BY seq ASC').all(o.id);
  const done = nodes.filter((n) => n.status === 'done');
  const pending = nodes.filter((n) => n.status !== 'done');

  findings.push({
    item: '当前环节',
    detail: `订单处于「${o.status}」${done.length ? `，工序已完成 ${done.length}/${nodes.length}` : ''}`,
    evidence: o.order_no,
    grade: 'read'
  });

  if (pending.length) {
    const n = pending[0];
    const late = n.plan_date && n.plan_date < new Date().toISOString().slice(0, 10);
    findings.push({
      item: '卡在哪道工序',
      detail: `下一道是「${n.name}」，责任人 ${n.operator || '未指定'}${n.plan_date ? `，计划 ${n.plan_date}` : ''}${late ? '，已过计划日' : ''}`,
      evidence: `${o.order_no} / ${n.name}`,
      action: '在生产看板确认该工序实际进度；如缺料或缺人请写明原因',
      grade: 'draft'
    });
  }

  // 报工是否覆盖订单数量
  const rep = db.prepare('SELECT COALESCE(SUM(qty_ok),0) ok, COALESCE(SUM(qty_defect),0) bad FROM production_reports WHERE order_id=?').get(o.id);
  const qty = db.prepare('SELECT COALESCE(SUM(qty),0) q FROM order_item_sizes WHERE item_id IN (SELECT id FROM order_items WHERE order_id=?)').get(o.id).q;
  if (num(qty) > 0) {
    const gap = r2(num(qty) - num(rep.ok));
    if (gap > 0) {
      findings.push({
        item: '报工缺口',
        detail: `订单 ${r2(qty)} 件，累计报工合格 ${r2(rep.ok)} 件，还差 ${gap} 件（不良 ${r2(rep.bad)} 件）`,
        evidence: o.order_no,
        action: gap > num(qty) * 0.3 ? '缺口超过三成，先确认是不是没报工而不是没生产' : '按实际补报工',
        grade: 'draft'
      });
    }
  }

  // 技术/财务门禁
  if (['draft', 'tech'].includes(o.status)) {
    const tp = db.prepare('SELECT * FROM tech_packs WHERE order_id=? ORDER BY id DESC LIMIT 1').get(o.id);
    if (!tp) {
      findings.push({ item: '技术资料', detail: '还没有开发单，技术无法确认', evidence: o.order_no, action: '在「开发管理」建开发单', grade: 'draft' });
    } else if (tp.status !== 'confirmed') {
      findings.push({
        item: '技术资料', detail: `开发单 ${tp.pack_no || '#' + tp.id} 状态为「${tp.status}」，未确认`,
        evidence: tp.pack_no, action: '技术确认面料/辅料/工艺/客户要求后推进', grade: 'draft'
      });
    }
  }
  if (['tech', 'finance'].includes(o.status)) {
    const cs = db.prepare('SELECT * FROM cost_sheets WHERE order_id=? ORDER BY id DESC LIMIT 1').get(o.id);
    if (!cs) findings.push({ item: '成本单', detail: '没有成本单，财务无法核价', evidence: o.order_no, action: '在订单详情生成成本单', grade: 'draft' });
    else if (cs.status !== 'approved') findings.push({ item: '成本单', detail: `成本单 ${cs.sheet_no || '#' + cs.id} 未通过审核`, evidence: cs.sheet_no, action: '财务审核成本单', grade: 'draft' });
  }

  // 交期
  if (o.delivery_date) {
    const days = Math.round((new Date(o.delivery_date) - new Date(new Date().toISOString().slice(0, 10))) / 86400000);
    if (days < 0) findings.push({ item: '交期', detail: `交期 ${o.delivery_date} 已过 ${Math.abs(days)} 天`, evidence: o.order_no, action: '与客户确认新交期并留痕（客户确认后才改）', grade: 'draft' });
    else if (days <= 7) findings.push({ item: '交期', detail: `距交期只剩 ${days} 天`, evidence: o.order_no, action: '确认能否按期，必要时提前沟通', grade: 'read' });
  }

  return { entity_type: 'order', entity_id: o.id, entity_no: o.order_no, title: `订单 ${o.order_no} 异常解释`, findings };
}

/** 解释：库存账实不符 */
function explainStockIssue(issue) {
  const findings = [];
  const style = issue.entity_no || '';
  findings.push({
    item: '差异本身',
    detail: `账面结存 ${r2(issue.actual_val)}，按流水应为 ${r2(issue.expect_val)}，差 ${r2(num(issue.actual_val) - num(issue.expect_val))}`,
    evidence: issue.rule_code, grade: 'read'
  });
  // 找最近的流水，看有没有可疑来源
  const rows = db.prepare(
    'SELECT * FROM stock_ledger WHERE style_no=? ORDER BY id DESC LIMIT 8'
  ).all(style);
  if (rows.length) {
    const byRef = {};
    rows.forEach((r) => { byRef[r.ref_type || '手工'] = (byRef[r.ref_type || '手工'] || 0) + 1; });
    findings.push({
      item: '最近流水来源',
      detail: Object.entries(byRef).map(([k, v]) => `${k} ${v} 笔`).join('，'),
      evidence: rows[0].remark || '', grade: 'read'
    });
  } else {
    findings.push({
      item: '没有流水',
      detail: '这个款没有任何出入库流水，说明库存是历史导入或直接改数，没有凭证',
      evidence: style,
      action: '补一张期初/调整单；不要每次都对不上就手工改数',
      grade: 'draft'
    });
  }
  if (issue.fixable) {
    findings.push({
      item: '能不能自动修',
      detail: '可以：系统能按流水净额重算结存，属于「由明细唯一推导」的字段',
      evidence: issue.rule_code, action: '在「数据质量与勾稽」点自动修复，会留痕', grade: 'draft'
    });
  } else {
    findings.push({
      item: '为什么不能自动修',
      detail: '涉及数量认定或单据归属，系统不敢替你判断，必须人工核',
      evidence: issue.rule_code, grade: 'read'
    });
  }
  return { entity_type: 'dq_issue', entity_id: issue.id, entity_no: issue.entity_no, title: `异常「${issue.rule_name || issue.rule_code}」解释`, findings };
}

/** 解释：应收没收回来 */
function explainReceivable(a) {
  const alloc = db.prepare(
    "SELECT COALESCE(SUM(amount),0) s FROM payment_allocations WHERE invoice_kind='ar' AND invoice_id=?"
  ).get(a.id).s;
  const findings = [{
    item: '单据状态',
    detail: `发票 ${a.bill_no} 金额 ${r2(a.amount)}，登记已收 ${r2(a.paid_amount)}，核销明细 ${r2(alloc)}`,
    evidence: a.bill_no, grade: 'read'
  }];
  if (Math.abs(num(a.paid_amount) - num(alloc)) > 0.01) {
    findings.push({
      item: '登记与核销不一致',
      detail: `「已收金额」与「核销明细」差 ${r2(num(a.paid_amount) - num(alloc))}，催收按错的数在跑`,
      evidence: a.bill_no, action: '按核销明细重算已收金额（可自动修）', grade: 'draft'
    });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (a.due_date && a.due_date < today) {
    const days = Math.round((new Date(today) - new Date(a.due_date)) / 86400000);
    findings.push({ item: '逾期', detail: `账期 ${a.due_date} 已过 ${days} 天，未收 ${r2(num(a.amount) - num(a.paid_amount))}`, evidence: a.bill_no, action: '发起催收并登记客户反馈', grade: 'draft' });
  }
  return { entity_type: 'receivable', entity_id: a.id, entity_no: a.bill_no, title: `应收 ${a.bill_no} 解释`, findings };
}

/** 解释：采购到货延迟 */
function explainPurchase(p) {
  const items = db.prepare('SELECT * FROM purchase_items WHERE po_id=?').all(p.id);
  const pending = items.filter((i) => num(i.received_qty) < num(i.qty));
  const findings = [{
    item: '到货情况',
    detail: `预计到货 ${p.expect_date || '未填'}，${pending.length} 条明细未收齐`,
    evidence: p.po_no, grade: 'read'
  }];
  pending.slice(0, 5).forEach((i) => {
    findings.push({
      item: i.name || '明细', detail: `订 ${r2(i.qty)}，已到 ${r2(i.received_qty)}，差 ${r2(num(i.qty) - num(i.received_qty))}`,
      evidence: p.po_no, grade: 'read'
    });
  });
  findings.push({
    item: '建议',
    detail: '先确认是不是「货到了没做收料单」—— 没做收料的库存在系统里等于没到，会连带影响齐套判断',
    evidence: p.po_no, action: '到「原料收货检验」补收料并做检验', grade: 'draft'
  });
  return { entity_type: 'purchase', entity_id: p.id, entity_no: p.po_no, title: `采购 ${p.po_no} 解释`, findings };
}

/**
 * 统一入口：给定实体，产出分级解释
 * @returns {{ok:boolean, title?, findings?, error?}}
 */
function explain({ entity_type, entity_id, entity_no }) {
  try {
    if (entity_type === 'order') {
      const o = entity_id ? db.prepare('SELECT * FROM orders WHERE id=?').get(entity_id) : findOrder(entity_no);
      if (!o) return { ok: false, error: '找不到该订单' };
      return { ok: true, ...explainOrder(o) };
    }
    if (entity_type === 'dq_issue') {
      const d = entity_id
        ? db.prepare('SELECT * FROM dq_issues WHERE id=?').get(entity_id)
        : db.prepare('SELECT * FROM dq_issues WHERE entity_no=? ORDER BY id DESC LIMIT 1').get(entity_no);
      if (!d) return { ok: false, error: '找不到该勾稽问题' };
      return { ok: true, ...explainStockIssue(d) };
    }
    if (entity_type === 'receivable') {
      const a = entity_id
        ? db.prepare('SELECT * FROM ar_invoices WHERE id=?').get(entity_id)
        : db.prepare('SELECT * FROM ar_invoices WHERE bill_no=?').get(entity_no);
      if (!a) return { ok: false, error: '找不到该应收发票' };
      return { ok: true, ...explainReceivable(a) };
    }
    if (entity_type === 'purchase') {
      const p = entity_id
        ? db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(entity_id)
        : db.prepare('SELECT * FROM purchase_orders WHERE po_no=?').get(entity_no);
      if (!p) return { ok: false, error: '找不到该采购单' };
      return { ok: true, ...explainPurchase(p) };
    }
    if (entity_type === 'approval') {
      const t = db.prepare(
        `SELECT t.*, o.order_no AS biz_no, f.name AS flow_name FROM approval_tasks t
         LEFT JOIN approval_instances i ON i.id=t.instance_id
         LEFT JOIN approval_flows f ON f.id=i.flow_id
         LEFT JOIN orders o ON o.id=i.target_id AND i.target_type='cost'
         WHERE t.id=?`
      ).get(entity_id);
      if (!t) return { ok: false, error: '找不到该待办' };
      return {
        ok: true, entity_type: 'approval', entity_id: t.id, entity_no: t.biz_no || `#${t.id}`,
        title: `待办「${t.step_name}」解释`,
        findings: [
          { item: '为什么停在这', detail: `流程「${t.flow_name || ''}」走到第 ${t.step_no} 步「${t.step_name}」，需要「${t.role}」角色处理`, evidence: t.biz_no, grade: 'read' },
          { item: '时限', detail: t.due_at ? `要求 ${t.due_at} 前完成${t.remind_count ? `，已提醒 ${t.remind_count} 次` : ''}` : '没有设时限', evidence: t.biz_no, grade: 'read' },
          { item: '谁能处理', detail: `角色「${t.role}」的在职账号可以处理；如果这个角色没人，流程会一直卡着`, evidence: t.biz_no, action: '给该角色安排账号，或转给现有的人', grade: 'draft' }
        ]
      };
    }
    return { ok: false, error: `暂不支持解释「${entity_type}」，可解释：order / dq_issue / receivable / purchase / approval` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 当前可解释的异常清单（从风险快照与勾稽问题合并） */
function anomalies(limit = 40) {
  const out = [];
  const lastRun = db.prepare('SELECT run_id FROM ai_risks ORDER BY id DESC LIMIT 1').get();
  if (lastRun) {
    db.prepare(
      "SELECT * FROM ai_risks WHERE run_id=? AND status='open' AND level IN ('high','mid') ORDER BY score DESC LIMIT 20"
    ).all(lastRun.run_id).forEach((r) => {
      out.push({
        source: 'risk', entity_type: r.entity_type, entity_id: r.entity_id, entity_no: r.entity_no,
        level: r.level, title: r.entity_no, desc: (() => { try { return JSON.parse(r.reasons)[0]; } catch (e) { return ''; } })(),
        due_at: r.due_at, owner: r.owner
      });
    });
  }
  db.prepare("SELECT * FROM dq_issues WHERE status='open' AND severity IN ('error','warn') ORDER BY severity, id DESC LIMIT 20")
    .all().forEach((d) => {
      out.push({
        source: 'dq', entity_type: 'dq_issue', entity_id: d.id, entity_no: d.entity_no,
        level: d.severity === 'error' ? 'high' : 'mid', title: d.rule_name || d.rule_code,
        desc: d.message, due_at: null, owner: '财务'
      });
    });
  return out.slice(0, Math.min(100, Number(limit) || 40));
}

module.exports = { explain, anomalies };
