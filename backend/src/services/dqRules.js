/**
 * 数据质量与业务勾稽 · 规则库
 * ---------------------------------------------
 * 设计原则：
 * - 每条规则都是「期望值 / 实际值 / 差额」三件套，能算差额的才叫勾稽
 * - 规则只读，不改数；修复由 FIXERS 单独负责，且只做「由明细重算汇总」这一类
 * - 同一实体同一字段只产生一条 issue（fingerprint 去重），避免刷屏
 */
const { db } = require('../db');
const { localNow } = require('./sla');

const EPS = 0.011; // 一分钱容差

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function r2(v) {
  return Math.round(num(v) * 100) / 100;
}
function diffOf(expect, actual) {
  return r2(num(expect) - num(actual));
}
function mk(o) {
  return {
    entity_type: o.entity_type,
    entity_id: o.entity_id,
    entity_no: o.entity_no,
    field: o.field || '',
    expect: o.expect === undefined || o.expect === null ? '' : String(o.expect),
    actual: o.actual === undefined || o.actual === null ? '' : String(o.actual),
    diff: diffOf(o.expect, o.actual),
    message: o.message || '',
    severity: o.severity || null,
    detail: o.detail || null
  };
}

/** 订单总件数：优先尺码明细，回退款数量 */
function orderQty(orderId) {
  const bySize = db
    .prepare('SELECT COALESCE(SUM(s.qty),0) q FROM order_item_sizes s JOIN order_items i ON i.id = s.item_id WHERE i.order_id = ?')
    .get(orderId).q;
  if (num(bySize) > 0) return num(bySize);
  return num(
    db.prepare('SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE order_id = ?').get(orderId).q
  );
}

// ============================================================ 规则定义
const RULES = [
  // ---------------------------------------------------- 账账对齐
  {
    code: 'BAL-STOCK',
    name: '库存结存 = 流水净额',
    category: 'balance',
    kind: 'balance',
    severity: 'error',
    desc: '库存余额表（stock_items.qty）必须等于出入库流水（stock_ledger）按仓位+款+色+码汇总的净额。',
    suggest: '点「重算余额」按流水重建该行结存；若流水本身有误，先到库存流水页核对单据。',
    fixable: 1,
    fix_key: 'stock-balance',
    sort_no: 10,
    run() {
      const rows = db
        .prepare(
          `SELECT si.id, si.warehouse, si.style_no, si.color, si.size, si.qty,
             COALESCE((SELECT SUM(l.qty) FROM stock_ledger l
               WHERE IFNULL(l.warehouse,'') = IFNULL(si.warehouse,'')
                 AND IFNULL(l.style_no,'') = IFNULL(si.style_no,'')
                 AND IFNULL(l.color,'')   = IFNULL(si.color,'')
                 AND IFNULL(l.size,'')    = IFNULL(si.size,'')), 0) AS net
           FROM stock_items si`
        )
        .all();
      return rows
        .filter((r) => Math.abs(num(r.qty) - num(r.net)) > EPS)
        .map((r) =>
          mk({
            entity_type: 'stock_item',
            entity_id: r.id,
            entity_no: `${r.warehouse}/${r.style_no || '-'}/${r.color || '-'}/${r.size || '-'}`,
            field: 'qty',
            expect: r2(r.net),
            actual: r2(r.qty),
            message: `${r.warehouse} 仓 ${r.style_no || ''}（${r.color || '-'}/${r.size || '-'}）结存 ${r2(r.qty)}，流水净额 ${r2(r.net)}`
          })
        );
    }
  },
  {
    code: 'BAL-ORDER-SHIP',
    name: '订单发货数 = 出库流水',
    category: 'balance',
    kind: 'balance',
    severity: 'error',
    desc: '订单标记已发货/已结单时，按该订单出库的流水合计不得大于订单件数；已标发货却完全没有出库记录要单独提示。',
    suggest: '超发需查是否有跨单借用或手工出库；零出库但已标发货，多为直接线下发货未过账。',
    sort_no: 20,
    run() {
      const rows = db
        .prepare(
          `SELECT o.id, o.order_no, o.status,
             COALESCE((SELECT SUM(ABS(l.qty)) FROM stock_ledger l
               WHERE l.ref_type='order' AND l.type='out' AND l.ref_id=o.id),0) AS out_qty
           FROM orders o WHERE o.status IN ('shipped','closed')`
        )
        .all();
      const out = [];
      rows.forEach((r) => {
        const qty = orderQty(r.id);
        if (num(r.out_qty) > num(qty) + EPS) {
          out.push(
            mk({
              entity_type: 'order',
              entity_id: r.id,
              entity_no: r.order_no,
              field: 'shipped_qty',
              expect: r2(qty),
              actual: r2(r.out_qty),
              message: `出库 ${r2(r.out_qty)} 件 > 订单 ${r2(qty)} 件，存在超发`
            })
          );
        } else if (num(r.out_qty) === 0 && num(qty) > 0) {
          out.push(
            mk({
              entity_type: 'order',
              entity_id: r.id,
              entity_no: r.order_no,
              field: 'shipped_qty',
              severity: 'warn',
              expect: r2(qty),
              actual: 0,
              message: `订单已标记 ${r.status}，但没有任何出库流水`
            })
          );
        }
      });
      return out;
    }
  },
  {
    code: 'BAL-AR',
    name: '订单金额 = 应收发票',
    category: 'balance',
    kind: 'balance',
    severity: 'warn',
    desc: '同一订单的有效应收发票合计不得超过订单金额（超开为错）；已结单订单应至少开过票。分批开票属正常，只在未开满时提示。',
    suggest: '超开要作废多余发票；结单未开票请到往来账开票。',
    sort_no: 30,
    run() {
      const rows = db
        .prepare(
          `SELECT o.id, o.order_no, o.status, o.total_amount,
             COALESCE((SELECT SUM(a.amount) FROM ar_invoices a WHERE a.order_id=o.id AND a.status<>'void'),0) AS ar
           FROM orders o WHERE o.status NOT IN ('draft','cancelled')`
        )
        .all();
      const out = [];
      rows.forEach((r) => {
        const amt = num(r.total_amount);
        const ar = num(r.ar);
        if (ar > amt + EPS) {
          out.push(
            mk({
              entity_type: 'order',
              entity_id: r.id,
              entity_no: r.order_no,
              field: 'ar_amount',
              severity: 'error',
              expect: r2(amt),
              actual: r2(ar),
              message: `已开票 ¥${r2(ar)} > 订单金额 ¥${r2(amt)}，超开 ¥${r2(ar - amt)}`
            })
          );
        } else if (r.status === 'closed' && ar <= EPS && amt > EPS) {
          out.push(
            mk({
              entity_type: 'order',
              entity_id: r.id,
              entity_no: r.order_no,
              field: 'ar_amount',
              expect: r2(amt),
              actual: 0,
              message: `订单已结单但未开应收发票（订单额 ¥${r2(amt)}）`
            })
          );
        }
      });
      return out;
    }
  },
  {
    code: 'BAL-AR-PAID',
    name: '应收已收 = 核销明细',
    category: 'balance',
    kind: 'balance',
    severity: 'error',
    desc: '应收发票的已收金额必须等于收款核销明细合计，状态（未收/部分/已收）由金额推导，不得手改。',
    suggest: '点「重算已收」按核销明细回写发票已收金额与状态。',
    fixable: 1,
    fix_key: 'ar-paid',
    sort_no: 40,
    run() {
      const rows = db
        .prepare(
          `SELECT a.id, a.bill_no, a.amount, a.paid_amount, a.status,
             COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
               WHERE pa.invoice_kind='ar' AND pa.invoice_id=a.id),0) AS alloc
           FROM ar_invoices a WHERE a.status<>'void'`
        )
        .all();
      return rows
        .filter((r) => Math.abs(num(r.paid_amount) - num(r.alloc)) > EPS)
        .map((r) =>
          mk({
            entity_type: 'ar_invoice',
            entity_id: r.id,
            entity_no: r.bill_no,
            field: 'paid_amount',
            expect: r2(r.alloc),
            actual: r2(r.paid_amount),
            message: `已收 ¥${r2(r.paid_amount)} ≠ 核销合计 ¥${r2(r.alloc)}（票面 ¥${r2(r.amount)}）`
          })
        );
    }
  },
  {
    code: 'BAL-AP',
    name: '采购金额 ≥ 应付发票（不超开）',
    category: 'balance',
    kind: 'balance',
    severity: 'error',
    desc: '同一采购单的有效应付发票合计不得超过采购金额；超开说明票开错了单或重复开票。',
    suggest: '超开请作废多余应付票。',
    sort_no: 50,
    run() {
      const rows = db
        .prepare(
          `SELECT p.id, p.po_no, p.status, p.total_amount,
             COALESCE((SELECT SUM(a.amount) FROM ap_invoices a WHERE a.purchase_id=p.id AND a.status<>'void'),0) AS ap
           FROM purchase_orders p WHERE p.status IN ('received','closed')`
        )
        .all();
      return rows
        .filter((r) => num(r.ap) > num(r.total_amount) + EPS)
        .map((r) =>
          mk({
            entity_type: 'purchase',
            entity_id: r.id,
            entity_no: r.po_no,
            field: 'ap_amount',
            expect: r2(r.total_amount),
            actual: r2(r.ap),
            message: `已开应付 ¥${r2(r.ap)} > 采购金额 ¥${r2(r.total_amount)}`
          })
        );
    }
  },
  {
    code: 'BAL-PO-AMT',
    name: '采购单金额 = 明细汇总',
    category: 'balance',
    kind: 'balance',
    severity: 'warn',
    desc: '采购单总金额必须等于各采购明细金额之和；表头金额留着不更新，应付与到货对账都会错位。',
    suggest: '点「重算金额」按明细回写表头总额。',
    fixable: 1,
    fix_key: 'po-amount',
    sort_no: 55,
    run() {
      const rows = db
        .prepare(
          `SELECT p.id, p.po_no, p.total_amount,
             COALESCE((SELECT SUM(amount) FROM purchase_items WHERE po_id=p.id),0) AS sd
           FROM purchase_orders p WHERE p.status<>'cancelled'`
        )
        .all();
      return rows
        .filter((r) => Math.abs(num(r.total_amount) - num(r.sd)) > EPS)
        .map((r) =>
          mk({
            entity_type: 'purchase',
            entity_id: r.id,
            entity_no: r.po_no,
            field: 'total_amount',
            expect: r2(r.sd),
            actual: r2(r.total_amount),
            message: `表头 ¥${r2(r.total_amount)} ≠ 明细合计 ¥${r2(r.sd)}`
          })
        );
    }
  },
  {
    code: 'DQ-AP-MISS',
    name: '收货完成须开应付票',
    category: 'quality',
    kind: 'quality',
    severity: 'info',
    desc: '按供应商汇总：已收货完成的采购单如果一张应付票都没挂，应付账款就会被少计（手工票未关联采购单也算未挂）。',
    suggest: '到往来账按采购单补开应付票，或把已有手工票关联到采购单。',
    limit: 5,
    sort_no: 205,
    run() {
      const rows = db
        .prepare(
          `SELECT COALESCE(s.name, p.supplier, '未知供应商') AS sup, COUNT(*) cnt, SUM(p.total_amount) amt,
             MIN(p.id) AS pid
           FROM purchase_orders p LEFT JOIN suppliers s ON s.id=p.supplier_id
           WHERE p.status IN ('received','closed') AND COALESCE(p.total_amount,0) > 0
             AND NOT EXISTS (SELECT 1 FROM ap_invoices a WHERE a.purchase_id=p.id AND a.status<>'void')
           GROUP BY COALESCE(p.supplier_id, p.supplier)`
        )
        .all();
      return rows.map((r) =>
        mk({
          entity_type: 'supplier',
          entity_id: r.pid,
          entity_no: r.sup,
          field: 'ap_invoice',
          expect: `应开 ¥${r2(r.amt)}`,
          actual: '未开票',
          diff: r.amt,
          message: `${r.sup}：${r.cnt} 张采购单已收货（¥${r2(r.amt)}）无应付发票`
        })
      );
    }
  },
  {
    code: 'BAL-AP-PAID',
    name: '应付已付 = 核销明细',
    category: 'balance',
    kind: 'balance',
    severity: 'error',
    desc: '应付发票的已付金额必须等于付款核销明细合计。',
    suggest: '点「重算已付」按核销明细回写。',
    fixable: 1,
    fix_key: 'ap-paid',
    sort_no: 60,
    run() {
      const rows = db
        .prepare(
          `SELECT a.id, a.bill_no, a.amount, a.paid_amount,
             COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
               WHERE pa.invoice_kind='ap' AND pa.invoice_id=a.id),0) AS alloc
           FROM ap_invoices a WHERE a.status<>'void'`
        )
        .all();
      return rows
        .filter((r) => Math.abs(num(r.paid_amount) - num(r.alloc)) > EPS)
        .map((r) =>
          mk({
            entity_type: 'ap_invoice',
            entity_id: r.id,
            entity_no: r.bill_no,
            field: 'paid_amount',
            expect: r2(r.alloc),
            actual: r2(r.paid_amount),
            message: `已付 ¥${r2(r.paid_amount)} ≠ 核销合计 ¥${r2(r.alloc)}（票面 ¥${r2(r.amount)}）`
          })
        );
    }
  },
  {
    code: 'BAL-COST',
    name: '成本对象实际成本 = 成本明细',
    category: 'balance',
    kind: 'balance',
    severity: 'error',
    desc: '成本对象的 actual_cost 必须等于该对象下全部成本明细（cost_entries）金额之和，不得手工填写。',
    suggest: '点「重算成本」按明细重新汇总。',
    fixable: 1,
    fix_key: 'cost-object',
    sort_no: 70,
    run() {
      const rows = db
        .prepare(
          `SELECT c.id, c.cost_no, c.actual_cost,
             COALESCE((SELECT SUM(e.amount) FROM cost_entries e WHERE e.cost_object_id=c.id),0) AS detail
           FROM cost_objects c`
        )
        .all();
      return rows
        .filter((r) => Math.abs(num(r.actual_cost) - num(r.detail)) > EPS)
        .map((r) =>
          mk({
            entity_type: 'cost_object',
            entity_id: r.id,
            entity_no: r.cost_no,
            field: 'actual_cost',
            expect: r2(r.detail),
            actual: r2(r.actual_cost),
            message: `实际成本 ¥${r2(r.actual_cost)} ≠ 明细合计 ¥${r2(r.detail)}`
          })
        );
    }
  },
  {
    code: 'BAL-PO-RECV',
    name: '采购到货数 = 收料实收',
    category: 'balance',
    kind: 'balance',
    severity: 'error',
    desc: '已经有收料单的采购明细，其 received_qty 必须等于收料单实收数量合计。没有收料单的历史到货不在本规则内（见「到货缺凭证」）。',
    suggest: '点「重算到货」按收料单重新汇总；如收料单本身有误，先改收料单。',
    fixable: 1,
    fix_key: 'po-recv',
    sort_no: 80,
    run() {
      const rows = db
        .prepare(
          `SELECT i.id, i.name, i.qty, i.received_qty, p.po_no,
             (SELECT COUNT(*) FROM goods_receipt_items g WHERE g.po_item_id=i.id) AS gcnt,
             COALESCE((SELECT SUM(g.receive_qty) FROM goods_receipt_items g WHERE g.po_item_id=i.id),0) AS recv
           FROM purchase_items i JOIN purchase_orders p ON p.id=i.po_id
           WHERE (SELECT COUNT(*) FROM goods_receipt_items g WHERE g.po_item_id=i.id) > 0`
        )
        .all();
      return rows
        .filter((r) => Math.abs(num(r.received_qty) - num(r.recv)) > EPS)
        .map((r) =>
          mk({
            entity_type: 'purchase_item',
            entity_id: r.id,
            entity_no: `${r.po_no}/${r.name || ''}`,
            field: 'received_qty',
            expect: r2(r.recv),
            actual: r2(r.received_qty),
            message: `到货 ${r2(r.received_qty)} ≠ 收料实收 ${r2(r.recv)}（订购 ${r2(r.qty)}）`
          })
        );
    }
  },
  {
    code: 'DQ-RECV-NOVOUCHER',
    name: '到货必须有收料凭证',
    category: 'quality',
    kind: 'quality',
    severity: 'info',
    desc: '采购明细记了到货数量，却查不到任何收料单（goods_receipt_items）——物料进了厂但没有点收、检验凭证，出问题无法追溯供应商。',
    suggest: '到原料收货检验页补录收料单；确实无法补录的，在备注标注「历史数据」并忽略。',
    limit: 6,
    sort_no: 200,
    run() {
      const rows = db
        .prepare(
          `SELECT i.id, i.name, i.qty, i.received_qty, p.po_no, p.po_no AS no2
           FROM purchase_items i JOIN purchase_orders p ON p.id=i.po_id
           WHERE COALESCE(i.received_qty,0) > 0
             AND NOT EXISTS (SELECT 1 FROM goods_receipt_items g WHERE g.po_item_id=i.id)`
        )
        .all();
      return rows.map((r) =>
        mk({
          entity_type: 'purchase_item',
          entity_id: r.id,
          entity_no: `${r.po_no}/${r.name || ''}`,
          field: 'receipt',
          expect: '有收料单',
          actual: `已到货 ${r2(r.received_qty)}，无收料单`,
          message: `到货 ${r2(r.received_qty)}（订购 ${r2(r.qty)}）缺少收料凭证`
        })
      );
    }
  },
  {
    code: 'BAL-CUT',
    name: '裁床合格数 = 扎包合计',
    category: 'balance',
    kind: 'balance',
    severity: 'error',
    desc: '裁床单的合格裁片数必须等于该单所有扎包的件数合计（错缸/返修不得计入合格）。',
    suggest: '核对扎包明细后改扎包或重开裁床单，不允许直接改合格数。',
    sort_no: 90,
    run() {
      const rows = db
        .prepare(
          `SELECT c.id, c.cut_no, c.qualified_qty,
             COALESCE((SELECT SUM(b.qty) FROM cut_bundles b WHERE b.cut_order_id=c.id),0) AS bq
           FROM cut_orders c WHERE c.status IN ('checked','handover','closed')`
        )
        .all();
      return rows
        .filter((r) => Math.abs(num(r.qualified_qty) - num(r.bq)) > EPS)
        .map((r) =>
          mk({
            entity_type: 'cut_order',
            entity_id: r.id,
            entity_no: r.cut_no,
            field: 'qualified_qty',
            expect: r2(r.bq),
            actual: r2(r.qualified_qty),
            message: `合格 ${r2(r.qualified_qty)} ≠ 扎包合计 ${r2(r.bq)}`
          })
        );
    }
  },
  {
    code: 'BAL-ORDER-AMT',
    name: '订单金额 = 尺码明细汇总',
    category: 'balance',
    kind: 'balance',
    severity: 'warn',
    desc: '订单合计（USD/CNY）必须等于各款各色各码金额汇总；款金额必须等于其尺码明细金额汇总。',
    suggest: '点「重算金额」按尺码明细回写款与订单合计（汇率取订单快照）。',
    fixable: 1,
    fix_key: 'order-amount',
    sort_no: 100,
    run() {
      const out = [];
      const items = db
        .prepare(
          `SELECT i.id, i.order_id, i.style_no, i.amount_usd,
             COALESCE((SELECT SUM(s.amount_usd) FROM order_item_sizes s WHERE s.item_id=i.id),0) AS sd,
             (SELECT COUNT(*) FROM order_item_sizes s WHERE s.item_id=i.id) AS cnt,
             o.order_no
           FROM order_items i JOIN orders o ON o.id=i.order_id`
        )
        .all();
      items.forEach((r) => {
        if (num(r.cnt) === 0) return; // 无尺码明细的款由 DQ-ORDER-SIZE 报
        if (Math.abs(num(r.amount_usd) - num(r.sd)) > EPS) {
          out.push(
            mk({
              entity_type: 'order_item',
              entity_id: r.id,
              entity_no: `${r.order_no}/${r.style_no || ''}`,
              field: 'amount_usd',
              expect: r2(r.sd),
              actual: r2(r.amount_usd),
              message: `款金额 $${r2(r.amount_usd)} ≠ 尺码汇总 $${r2(r.sd)}`
            })
          );
        }
      });
      const orders = db
        .prepare(
          `SELECT o.id, o.order_no, o.total_usd, o.rate,
             COALESCE((SELECT SUM(s.amount_usd) FROM order_item_sizes s
               JOIN order_items i ON i.id=s.item_id WHERE i.order_id=o.id),0) AS sd
           FROM orders o WHERE o.status<>'cancelled'`
        )
        .all();
      orders.forEach((r) => {
        if (Math.abs(num(r.total_usd) - num(r.sd)) > EPS) {
          out.push(
            mk({
              entity_type: 'order',
              entity_id: r.id,
              entity_no: r.order_no,
              field: 'total_usd',
              expect: r2(r.sd),
              actual: r2(r.total_usd),
              message: `订单合计 $${r2(r.total_usd)} ≠ 明细汇总 $${r2(r.sd)}`
            })
          );
        }
      });
      return out;
    }
  },
  {
    code: 'BAL-REPORT-OVER',
    name: '工序报工累计不超订单数',
    category: 'balance',
    kind: 'balance',
    severity: 'warn',
    desc: '同一订单同一工序的合格报工累计不得超过订单件数（返工重报应走返工单而不是重复报工）。',
    suggest: '核对报工记录，重复报工请作废明细；确属补做请开返工单。',
    sort_no: 110,
    run() {
      const rows = db
        .prepare(
          `SELECT r.order_id, r.node_id, r.node_name, SUM(r.qty_ok) qty, o.order_no
           FROM production_reports r JOIN orders o ON o.id=r.order_id
           GROUP BY r.order_id, r.node_id`
        )
        .all();
      const cache = {};
      const out = [];
      rows.forEach((r) => {
        if (cache[r.order_id] === undefined) cache[r.order_id] = orderQty(r.order_id);
        const q = cache[r.order_id];
        if (q > 0 && num(r.qty) > q + EPS) {
          out.push(
            mk({
              entity_type: 'order_node',
              entity_id: r.order_id * 1000 + num(r.node_id),
              entity_no: `${r.order_no}/${r.node_name || r.node_id}`,
              field: 'qty_ok',
              expect: r2(q),
              actual: r2(r.qty),
              message: `工序「${r.node_name || ''}」合格累计 ${r2(r.qty)} > 订单 ${r2(q)}`
            })
          );
        }
      });
      return out;
    }
  },
  {
    code: 'BAL-REWORK-COST',
    name: '返工报废损失必须入成本',
    category: 'balance',
    kind: 'balance',
    severity: 'warn',
    desc: '已批准的返工/报废单若有损失金额，必须已挂到成本明细（cost_entry_id 非空），否则成本少计。',
    suggest: '到返工单点「入成本」，或检查成本对象是否存在。',
    sort_no: 120,
    run() {
      const rows = db
        .prepare(
          `SELECT r.id, r.rw_no, r.cost_total, r.cost_entry_id, r.status
           FROM rework_orders r WHERE r.status='approved' AND COALESCE(r.cost_total,0) > 0`
        )
        .all();
      return rows
        .filter((r) => !r.cost_entry_id)
        .map((r) =>
          mk({
            entity_type: 'rework',
            entity_id: r.id,
            entity_no: r.rw_no,
            field: 'cost_entry_id',
            expect: `已入账 ¥${r2(r.cost_total)}`,
            actual: '未入账',
            diff: r.cost_total,
            message: `返工损失 ¥${r2(r.cost_total)} 未进成本`
          })
        );
    }
  },

  // ---------------------------------------------------- 数据质量
  {
    code: 'DQ-ORDER-CORE',
    name: '订单关键字段完整',
    category: 'quality',
    kind: 'quality',
    severity: 'warn',
    desc: '非草稿订单必须有客户、交期、有效汇率（>0）；定制单还要有款名。缺一项后续算价、排产、开票都会缺依据。',
    suggest: '到订单详情补齐字段后重新勾稽。',
    sort_no: 210,
    run() {
      const rows = db
        .prepare(
          `SELECT o.id, o.order_no, o.customer_id, o.delivery_date, o.rate, o.type, o.style_name
           FROM orders o WHERE o.status NOT IN ('draft','cancelled')`
        )
        .all();
      const out = [];
      rows.forEach((r) => {
        if (!r.customer_id) {
          out.push(mk({ entity_type: 'order', entity_id: r.id, entity_no: r.order_no, field: 'customer_id', expect: '已选客户', actual: '空', message: '订单未关联客户' }));
        }
        if (!r.delivery_date) {
          out.push(mk({ entity_type: 'order', entity_id: r.id, entity_no: r.order_no, field: 'delivery_date', expect: '有交期', actual: '空', message: '订单未填交期' }));
        }
        if (num(r.rate) <= 0) {
          out.push(mk({ entity_type: 'order', entity_id: r.id, entity_no: r.order_no, field: 'rate', expect: '>0', actual: r2(r.rate), message: '订单汇率缺失或为 0' }));
        }
        if (r.type === 'custom' && !r.style_name) {
          out.push(mk({ entity_type: 'order', entity_id: r.id, entity_no: r.order_no, field: 'style_name', severity: 'info', expect: '有款名', actual: '空', message: '定制订单缺款名' }));
        }
      });
      return out;
    }
  },
  {
    code: 'DQ-ORDER-SIZE',
    name: '款数量 = 尺码明细合计',
    category: 'quality',
    kind: 'quality',
    severity: 'error',
    desc: '每一款的订购数量必须等于该款各颜色各尺码的数量合计；没有尺码明细的款无法排产也无法发货。',
    suggest: '到订单详情「款与尺码」补齐或修正数量。',
    sort_no: 220,
    run() {
      const rows = db
        .prepare(
          `SELECT i.id, i.order_id, i.style_no, i.qty, o.order_no,
             (SELECT COUNT(*) FROM order_item_sizes s WHERE s.item_id=i.id) cnt,
             COALESCE((SELECT SUM(s.qty) FROM order_item_sizes s WHERE s.item_id=i.id),0) sq
           FROM order_items i JOIN orders o ON o.id=i.order_id
           WHERE o.status<>'cancelled'`
        )
        .all();
      const out = [];
      rows.forEach((r) => {
        if (num(r.cnt) === 0) {
          out.push(
            mk({
              entity_type: 'order_item',
              entity_id: r.id,
              entity_no: `${r.order_no}/${r.style_no || ''}`,
              field: 'sizes',
              expect: `款数量 ${r2(r.qty)}`,
              actual: 0,
              message: '该款没有尺码明细，无法排产'
            })
          );
        } else if (Math.abs(num(r.qty) - num(r.sq)) > EPS) {
          out.push(
            mk({
              entity_type: 'order_item',
              entity_id: r.id,
              entity_no: `${r.order_no}/${r.style_no || ''}`,
              field: 'qty',
              expect: r2(r.qty),
              actual: r2(r.sq),
              message: `款数量 ${r2(r.qty)} ≠ 尺码明细合计 ${r2(r.sq)}`
            })
          );
        }
      });
      return out;
    }
  },
  {
    code: 'DQ-CUSTOMER-CREDIT',
    name: '有在途订单的客户须有信用额度',
    category: 'quality',
    kind: 'quality',
    severity: 'info',
    desc: '存在未结订单（未发货/未收款）的客户，信用额度不应为 0，否则赊账风险无法评估。',
    suggest: '到客户档案补充信用额度与等级。',
    sort_no: 230,
    run() {
      const rows = db
        .prepare(
          `SELECT c.id, c.name, c.code, c.credit_limit, COUNT(o.id) cnt, SUM(o.total_amount) amt
           FROM customers c JOIN orders o ON o.customer_id=c.id
           WHERE o.status NOT IN ('closed','cancelled','draft')
           GROUP BY c.id`
        )
        .all();
      return rows
        .filter((r) => num(r.credit_limit) <= 0)
        .map((r) =>
          mk({
            entity_type: 'customer',
            entity_id: r.id,
            entity_no: r.code || r.name,
            field: 'credit_limit',
            expect: '>0',
            actual: 0,
            message: `${r.name} 有 ${r.cnt} 张未结订单（¥${r2(r.amt)}），信用额度为 0`
          })
        );
    }
  },
  {
    code: 'DQ-SUPPLIER-LINK',
    name: '采购单须关联供应商档案',
    category: 'quality',
    kind: 'quality',
    severity: 'warn',
    desc: '采购单必须挂供应商档案（supplier_id），否则供应商评价、资格门禁、对账都挂不上。',
    suggest: '到采购单重新选择供应商档案；若档案不存在，先建档案。',
    sort_no: 240,
    run() {
      const rows = db
        .prepare(
          `SELECT p.id, p.po_no, p.supplier, p.status FROM purchase_orders p
           WHERE p.supplier_id IS NULL AND p.status<>'cancelled'`
        )
        .all();
      return rows.map((r) =>
        mk({
          entity_type: 'purchase',
          entity_id: r.id,
          entity_no: r.po_no,
          field: 'supplier_id',
          expect: '已关联档案',
          actual: r.supplier || '空',
          message: `采购单仅记供应商名称「${r.supplier || ''}」，未关联档案`
        })
      );
    }
  },
  {
    code: 'DQ-EMP-REF',
    name: '报工须挂到员工',
    category: 'quality',
    kind: 'quality',
    severity: 'warn',
    desc: '生产报工必须能对应到在职员工（employee_id），否则工时、绩效、工资都统计不到人。',
    suggest: '到生产管理补记报工员工；历史数据可按 operator 姓名批量匹配。',
    sort_no: 250,
    run() {
      const rows = db
        .prepare(
          `SELECT r.id, r.order_id, r.node_name, r.operator, r.report_date, o.order_no
           FROM production_reports r LEFT JOIN orders o ON o.id=r.order_id
           WHERE r.employee_id IS NULL`
        )
        .all();
      return rows.map((r) =>
        mk({
          entity_type: 'production_report',
          entity_id: r.id,
          entity_no: `${r.order_no || ''}/${r.node_name || ''}`,
          field: 'employee_id',
          expect: '已挂员工',
          actual: r.operator || '空',
          message: `报工（${r.report_date || ''}）操作人「${r.operator || ''}」未关联员工档案`
        })
      );
    }
  },
  {
    code: 'DQ-ORPHAN',
    name: '明细不得悬空',
    category: 'quality',
    kind: 'quality',
    severity: 'error',
    desc: '所有明细行必须挂在存在的主单上；主单被删而明细残留会造成金额与数量虚增。',
    suggest: '清理悬空明细（需人工确认后删除或补建主单）。',
    sort_no: 260,
    run() {
      // [对象类型, 明细表, 外键列, 主表, 主键列]
      const checks = [
        ['order_item', 'order_items', 'order_id', 'orders', 'id'],
        ['order_item_size', 'order_item_sizes', 'item_id', 'order_items', 'id'],
        ['cost_entry', 'cost_entries', 'cost_object_id', 'cost_objects', 'id'],
        ['purchase_item', 'purchase_items', 'po_id', 'purchase_orders', 'id'],
        ['receipt_item', 'goods_receipt_items', 'grn_id', 'goods_receipts', 'id'],
        ['cut_bundle', 'cut_bundles', 'cut_order_id', 'cut_orders', 'id'],
        ['production_report', 'production_reports', 'order_id', 'orders', 'id'],
        ['dispatch_order', 'dispatch_orders', 'order_id', 'orders', 'id']
      ];
      const out = [];
      checks.forEach(([label, table, fk, parent, pk]) => {
        const rows = db
          .prepare(
            `SELECT t.id, t.${fk} AS ref FROM ${table} t
             WHERE t.${fk} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.${pk}=t.${fk})`
          )
          .all();
        if (!rows.length) return;
        const sample = rows.slice(0, 5).map((r) => `#${r.id}→${r.ref}`).join('，');
        // 同源问题合并成一条，避免一次刷出几十条
        out.push(
          mk({
            entity_type: label,
            entity_id: null,
            entity_no: `${table}.${fk}`,
            field: fk,
            expect: '0 条悬空',
            actual: `${rows.length} 条`,
            diff: rows.length,
            message: `${table}.${fk} 有 ${rows.length} 条指向不存在的主单（${sample}${rows.length > 5 ? ' 等' : ''}）`
          })
        );
      });
      return out;
    }
  },
  {
    code: 'DQ-MATERIAL-ZERO',
    name: '面辅料用量与单价不可为 0',
    category: 'quality',
    kind: 'quality',
    severity: 'warn',
    desc: '订单面辅料明细的单件用量应大于 0，单价为 0 会导致成本低计（打样赠送也需标明）。',
    suggest: '到订单面辅料页修正用量/单价；确实为客供料请在备注标注。',
    sort_no: 270,
    run() {
      const rows = db
        .prepare(
          `SELECT m.id, m.order_id, m.name, m.type, m.one_use, m.price, m.amount, o.order_no
           FROM order_materials m JOIN orders o ON o.id=m.order_id
           WHERE o.status<>'cancelled'`
        )
        .all();
      const out = [];
      rows.forEach((r) => {
        if (num(r.one_use) <= 0) {
          out.push(
            mk({
              entity_type: 'order_material',
              entity_id: r.id,
              entity_no: `${r.order_no}/${r.name || ''}`,
              field: 'one_use',
              expect: '>0',
              actual: r2(r.one_use),
              message: `面辅料「${r.name || ''}」单件用量为 0`
            })
          );
        } else if (num(r.price) <= 0) {
          out.push(
            mk({
              entity_type: 'order_material',
              entity_id: r.id,
              entity_no: `${r.order_no}/${r.name || ''}`,
              field: 'price',
              severity: 'info',
              expect: '>0',
              actual: 0,
              message: `面辅料「${r.name || ''}」单价为 0（客供或赠送请在备注说明）`
            })
          );
        }
      });
      return out;
    }
  },
  {
    code: 'DQ-RECV-PENDING',
    name: '收料待检不得长期挂账',
    category: 'quality',
    kind: 'quality',
    severity: 'warn',
    desc: '收料单里待检数量超过 3 个工作日仍未出结果，说明检验环节卡住，物料进了厂却不能用。',
    suggest: '到原料收货检验页完成检验；确实无法检验的做让步接收并写明理由。',
    sort_no: 280,
    run() {
      const rows = db
        .prepare(
          `SELECT g.id, g.grn_no, g.receive_date, g.pending_qty, g.status
           FROM goods_receipts g
           WHERE COALESCE(g.pending_qty,0) > 0 AND g.status<>'cancelled'`
        )
        .all();
      const today = localNow().slice(0, 10);
      const days = (d1, d2) => Math.round((new Date(d2 + 'T00:00:00') - new Date(d1 + 'T00:00:00')) / 86400000);
      const out = [];
      rows.forEach((r) => {
        const base = String(r.receive_date || '').slice(0, 10);
        if (!base) return;
        const n = days(base, today);
        if (n > 3) {
          out.push(
            mk({
              entity_type: 'receipt',
              entity_id: r.id,
              entity_no: r.grn_no,
              field: 'pending_qty',
              expect: '3 天内完成检验',
              actual: `已挂 ${n} 天`,
              diff: r.pending_qty,
              message: `待检 ${r2(r.pending_qty)} 已 ${n} 天未出结果`
            })
          );
        }
      });
      return out;
    }
  }
];

// ============================================================ 修复器
/** 只做「由明细重算汇总/状态」这类确定性修复 */
const FIXERS = {
  'stock-balance'(issue) {
    const row = db.prepare('SELECT * FROM stock_items WHERE id=?').get(issue.entity_id);
    if (!row) return { skip: '库存行已不存在' };
    const net = num(
      db
        .prepare(
          `SELECT COALESCE(SUM(qty),0) q FROM stock_ledger
           WHERE IFNULL(warehouse,'')=IFNULL(?,'') AND IFNULL(style_no,'')=IFNULL(?,'')
             AND IFNULL(color,'')=IFNULL(?,'') AND IFNULL(size,'')=IFNULL(?,'')`
        )
        .get(row.warehouse, row.style_no, row.color, row.size).q
    );
    const before = num(row.qty);
    db.prepare('UPDATE stock_items SET qty=?, updated_at=? WHERE id=?').run(r2(net), localNow(), row.id);
    return { before: { qty: before }, after: { qty: r2(net) }, message: `结存 ${before} → ${r2(net)}` };
  },
  'ar-paid'(issue) {
    const inv = db.prepare('SELECT * FROM ar_invoices WHERE id=?').get(issue.entity_id);
    if (!inv) return { skip: '发票不存在' };
    const alloc = num(
      db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payment_allocations WHERE invoice_kind='ar' AND invoice_id=?").get(inv.id).s
    );
    const status = alloc <= EPS ? 'open' : alloc >= num(inv.amount) - EPS ? 'paid' : 'partial';
    db.prepare('UPDATE ar_invoices SET paid_amount=?, status=?, updated_at=? WHERE id=?').run(
      r2(alloc), status, localNow(), inv.id
    );
    return { before: { paid_amount: num(inv.paid_amount), status: inv.status }, after: { paid_amount: r2(alloc), status }, message: `已收 ${num(inv.paid_amount)} → ${r2(alloc)}` };
  },
  'ap-paid'(issue) {
    const inv = db.prepare('SELECT * FROM ap_invoices WHERE id=?').get(issue.entity_id);
    if (!inv) return { skip: '发票不存在' };
    const alloc = num(
      db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payment_allocations WHERE invoice_kind='ap' AND invoice_id=?").get(inv.id).s
    );
    const status = alloc <= EPS ? 'open' : alloc >= num(inv.amount) - EPS ? 'paid' : 'partial';
    db.prepare('UPDATE ap_invoices SET paid_amount=?, status=?, updated_at=? WHERE id=?').run(
      r2(alloc), status, localNow(), inv.id
    );
    return { before: { paid_amount: num(inv.paid_amount), status: inv.status }, after: { paid_amount: r2(alloc), status }, message: `已付 ${num(inv.paid_amount)} → ${r2(alloc)}` };
  },
  'cost-object'(issue) {
    const { recalc } = require('../routes/costObjects');
    const obj = db.prepare('SELECT * FROM cost_objects WHERE id=?').get(issue.entity_id);
    if (!obj) return { skip: '成本对象不存在' };
    const before = num(obj.actual_cost);
    const after = recalc(obj.id);
    return { before: { actual_cost: before }, after: { actual_cost: after }, message: `实际成本 ${before} → ${after}` };
  },
  'po-recv'(issue) {
    const it = db.prepare('SELECT * FROM purchase_items WHERE id=?').get(issue.entity_id);
    if (!it) return { skip: '采购明细不存在' };
    const recv = num(
      db.prepare('SELECT COALESCE(SUM(receive_qty),0) s FROM goods_receipt_items WHERE po_item_id=?').get(it.id).s
    );
    db.prepare('UPDATE purchase_items SET received_qty=? WHERE id=?').run(r2(recv), it.id);
    return { before: { received_qty: num(it.received_qty) }, after: { received_qty: r2(recv) }, message: `到货 ${num(it.received_qty)} → ${r2(recv)}` };
  },
  'po-amount'(issue) {
    const p = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(issue.entity_id);
    if (!p) return { skip: '采购单不存在' };
    const sd = num(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM purchase_items WHERE po_id=?').get(p.id).s);
    db.prepare('UPDATE purchase_orders SET total_amount=?, updated_at=? WHERE id=?').run(r2(sd), localNow(), p.id);
    return { before: { total_amount: num(p.total_amount) }, after: { total_amount: r2(sd) }, message: `采购总额 ${num(p.total_amount)} → ${r2(sd)}` };
  },
  'order-amount'(issue) {
    // 单条修复：款金额 或 订单合计
    if (issue.entity_type === 'order_item') {
      const it = db.prepare('SELECT * FROM order_items WHERE id=?').get(issue.entity_id);
      if (!it) return { skip: '款已不存在' };
      const row = db
        .prepare('SELECT COALESCE(SUM(amount_usd),0) u, COALESCE(SUM(amount_cny),0) c FROM order_item_sizes WHERE item_id=?')
        .get(it.id);
      db.prepare('UPDATE order_items SET amount_usd=?, amount_cny=? WHERE id=?').run(r2(row.u), r2(row.c), it.id);
      return { before: { amount_usd: num(it.amount_usd) }, after: { amount_usd: r2(row.u) }, message: `款金额 $${num(it.amount_usd)} → $${r2(row.u)}` };
    }
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(issue.entity_id);
    if (!o) return { skip: '订单已不存在' };
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(s.amount_usd),0) u, COALESCE(SUM(s.amount_cny),0) c
         FROM order_item_sizes s JOIN order_items i ON i.id=s.item_id WHERE i.order_id=?`
      )
      .get(o.id);
    db.prepare('UPDATE orders SET total_usd=?, total_amount=?, updated_at=? WHERE id=?').run(
      r2(row.u), r2(row.c), localNow(), o.id
    );
    return { before: { total_usd: num(o.total_usd) }, after: { total_usd: r2(row.u) }, message: `订单合计 $${num(o.total_usd)} → $${r2(row.u)}` };
  }
};

function byCode(code) {
  return RULES.find((r) => r.code === code) || null;
}

module.exports = { RULES, FIXERS, byCode, orderQty, r2, num, EPS };
