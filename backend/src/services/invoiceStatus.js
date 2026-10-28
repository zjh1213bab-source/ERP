/**
 * 应收 / 应付发票「是否还欠着」的唯一判定口径
 *
 * ## 为什么必须抽出来
 * 同一个库里有两种写法在算同一件事：
 *
 *   驾驶舱 / 账龄：  status <> 'void' AND amount - paid_amount > 0.005   （除作废全算）
 *   财务页合计：    status IN ('unpaid','partial')                       （白名单）
 *
 * 平时两者结果一样，所以谁也没发现。但演示脚本往里写了 6 条 `status='open'`
 * （共 210 万），于是出现「驾驶舱说欠 210 万、财务页说欠 0」——
 * **同一套账两个数**，还都不是算错，是口径不同。
 *
 * ## 口径定死为「反向排除」而不是「正向白名单」
 * 正向白名单的问题是：任何新写入或导入的状态值都会**静默消失**（不在名单里就不算），
 * 而金额少算是最难被发现的错误。反向排除则相反 —— 野值会被算进来，
 * 然后在体检里被点名，属于「宁可多算也不要漏算」。
 *
 * 所以：**没作废、且还有未结金额，就是欠着**。status 只用来区分「是否跑完流程」，
 * 不用来参与金额判定。
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 状态取值（用于校验与归一，不用于金额判定） */
const KNOWN = ['unpaid', 'partial', 'paid', 'void'];

/**
 * 这些别名统一归到标准值。
 *
 * 只收「语义确定」的：open/pending 都是「还没付」。
 * **故意不映射 closed** —— 采购单上 closed 表示「单据关闭」，与发票的「已付清」
 * 是两件事；把 closed 当成 paid 会让一笔没付的钱凭空消失。
 */
const ALIAS = {
  open: 'unpaid',
  pending: 'unpaid',
  reversed: 'void'
};

/**
 * 未结清的 SQL 条件（不带表别名）
 * 用「金额」而不是「状态」判定，见文件头
 */
const OPEN_SQL = "status <> 'void' AND amount - COALESCE(paid_amount, 0) > 0.005";

/** 带表别名的版本：OPEN_SQL_OF('a') → a.status <> 'void' AND a.amount - ... */
function openSqlOf(alias) {
  const p = alias ? alias + '.' : '';
  return `${p}status <> 'void' AND ${p}amount - COALESCE(${p}paid_amount, 0) > 0.005`;
}

/** JS 侧：这张发票是不是还欠着 */
function isOpen(inv) {
  if (!inv) return false;
  if (String(inv.status || '') === 'void') return false;
  return r2((Number(inv.amount) || 0) - (Number(inv.paid_amount) || 0)) > 0.005;
}

function openAmount(inv) {
  return isOpen(inv) ? r2((Number(inv.amount) || 0) - (Number(inv.paid_amount) || 0)) : 0;
}

/** 状态归一：'open' → 'unpaid'；认不出的返回 null（交给体检报出来，不偷偷改） */
function normalizeStatus(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  if (KNOWN.includes(v)) return v;
  if (ALIAS[v]) return ALIAS[v];
  return null;
}

/**
 * 按金额推算「应该是哪个状态」
 * 用于修正历史脏数据：已收金额已经等于或超过票面，状态却还写着 unpaid
 */
function inferStatus(inv) {
  const amount = r2(inv.amount);
  const paid = r2(inv.paid_amount);
  if (String(inv.status || '') === 'void') return 'void';
  if (paid <= 0.005) return 'unpaid';
  if (paid + 0.005 >= amount) return 'paid';
  return 'partial';
}

/**
 * 按核销记录重算一张发票的 `paid_amount` 与 `status`（作废的不动）
 *
 * 这是**唯一允许写发票已付金额的地方**。两条路（往来账页手工登记、
 * 付款申请单执行付款）都调它 —— 抄第二份就会出现
 * 「同样的核销，两条路算出的 paid_amount 不一样」。
 *
 * 口径依赖 `paymentStatus.PAY_VALID`：只有 valid/confirmed 且未冲销的付款才算。
 */
function syncPaidStatus(kind, invoiceId, dbRef) {
  const { db, now } = require('../db');
  const d = dbRef || db;
  const { payValidOf } = require('./paymentStatus');
  const table = kind === 'ar' ? 'ar_invoices' : 'ap_invoices';
  const inv = d.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(invoiceId);
  if (!inv) return null;
  // 作废票不动：它可能还有核销记录，改了会把历史搅乱
  if (String(inv.status || '') === 'void') return { paid: Number(inv.paid_amount) || 0, status: 'void' };

  const paid = r2(
    d
      .prepare(
        `SELECT COALESCE(SUM(a.amount),0) AS s FROM payment_allocations a
           JOIN payments p ON p.id = a.payment_id AND ${payValidOf('p')}
          WHERE a.invoice_kind = ? AND a.invoice_id = ?`
      )
      .get(kind, invoiceId).s
  );
  let status = 'unpaid';
  if (paid + 0.005 >= r2(inv.amount)) status = 'paid';
  else if (paid > 0.005) status = 'partial';

  d.prepare(`UPDATE ${table} SET paid_amount = ?, status = ?, updated_at = ? WHERE id = ?`).run(
    paid,
    status,
    now(),
    invoiceId
  );

  // 应收核销后同步催收任务：钱收到了，催收单就该收尾。
  // 挂在这里而不是各调用方 —— **所有应收回款都要经过这个函数**（上一轮把状态回写
  // 抽成公共实现的红利），漏一个入口就会出现「钱收了、催收单还挂在业务员名下」。
  // 懒加载 + try/catch：催收同步失败绝不能让收款本身失败。
  if (kind === 'ar') {
    try {
      require('./collection').onInvoiceSettled('ar', invoiceId);
    } catch (e) {
      /* 静默：催收台账下次打开时 refreshAll 会补上 */
    }
  }

  return { paid, status };
}

module.exports = {
  KNOWN,
  ALIAS,
  OPEN_SQL,
  openSqlOf,
  isOpen,
  openAmount,
  normalizeStatus,
  inferStatus,
  syncPaidStatus
};
