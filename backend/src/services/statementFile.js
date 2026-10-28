/**
 * 对账资料（授权下发）
 * ========================================================================
 * 现状：`services/statement.js` 能算出带逐笔流水的对账单，但**只在内部页面看**。
 * 客户财务要的是能打印、能盖章、能存档的文件，现在只能让业务截图发过去 ——
 * 截图没法核对、也不能证明「我们当时给你看的就是这个数」。
 *
 * ## 三条口径
 *
 * 1. **文件是定版快照，不是实时查询**。发布那一刻把 `statement.build()` 的结果存进
 *    `snapshot`，客户下载的就是它。内部账后来变了（补录发票、核销收款），
 *    已经发出去的那份不变 —— 客户核对的是他手上的纸，不是我们的库。
 * 2. **必须授权才能下**。草稿不对外；撤销立即失效；可设有效期。
 *    原型原话「对账页面只提供本组织获授权文件」。
 * 3. **对账不平时不许发**。`statement.build()` 已经算了 `check_diff`
 *    （期末余额 vs 未收发票口径）。不为 0 说明有发票的 `paid_amount` 被手工改过、
 *    或有收款没走流水 —— 这种账发出去，客户一眼就能挑出问题，先自己查清。
 */
const { db, now } = require('../db');
const { localDate } = require('../utils/time');
const { nextNo } = require('../utils/docNo');
const ST = require('./statement');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const today = () => localDate(now());
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const STATUS = { draft: '草稿', published: '已授权', revoked: '已撤销' };
const KIND = { monthly: '月度对账', payment_notice: '付款通知' };

/* -------------------------------------------------------------------- *
 * 生成草稿：把内部对账单算成快照
 * -------------------------------------------------------------------- */
function generate(body = {}, operator) {
  const customerId = Number(body.customer_id);
  if (!customerId) throw bad('请选择客户');
  const cust = db.prepare('SELECT id, name, code FROM customers WHERE id = ?').get(customerId);
  if (!cust) throw bad('客户不存在', 404);

  // 期间：前端给月份就换算成首末日，给日期就按日期
  let from = String(body.period_from || '').trim();
  let to = String(body.period_to || '').trim();
  const period = String(body.period || '').trim();
  if (!from && /^\d{4}-\d{2}$/.test(period)) {
    from = `${period}-01`;
    const d = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0);
    to = localDate(d.toISOString());
  }
  if (!from || !to) throw bad('请选择对账期间（月份或起止日）');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw bad('期间格式应为 YYYY-MM-DD');
  if (from > to) throw bad('开始日期不能晚于结束日期');

  const kind = KIND[body.kind] ? body.kind : 'monthly';
  const st = ST.build(customerId, { from, to });

  // 同期间同类型已存在的最高版本 +1
  const last = db.prepare(
    `SELECT MAX(version_no) v FROM statement_files WHERE customer_id=? AND period_from=? AND period_to=? AND kind=?`
  ).get(customerId, from, to, kind);
  const version = Number(last.v || 0) + 1;

  const t = now();
  const no = nextNo('SF', 'statement_files', 'file_no');
  const title = `${cust.name} ${from} ~ ${to} ${KIND[kind]}`;
  const fileName = `${(cust.code || cust.name).replace(/[\\/:*?"<>|]/g, '_')}_对账单_${from}_${to}_v${version}.csv`;

  // 快照只留客户要看的内容：逐笔流水 + 汇总 + 告示。
  // customer 块的电话/地址是我们自己的联系方式，给客户无所谓；但**不含任何成本/毛利字段**。
  const snapshot = {
    customer: { code: st.customer.code, name: st.customer.name },
    period: st.period,
    opening: st.opening,
    rows: st.rows,
    summary: {
      invoice_count: st.summary.invoice_count,
      invoice_amount: st.summary.invoice_amount,
      payment_count: st.summary.payment_count,
      payment_amount: st.summary.payment_amount,
      opening: st.summary.opening,
      closing: st.summary.closing,
      unallocated: st.summary.unallocated
    },
    notices: st.notices,
    generated_at: t
  };

  const info = db.prepare(
    `INSERT INTO statement_files (file_no, company_id, customer_id, customer_name, period_from, period_to,
       kind, version_no, title, file_name, snapshot, amount_opening, amount_invoiced, amount_paid,
       amount_closing, check_diff, status, created_by, created_at, updated_at, demo_tag)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?)`
  ).run(no, 1, customerId, cust.name, from, to, kind, version,
    title, fileName, JSON.stringify(snapshot),
    r2(st.opening), r2(st.summary.invoice_amount), r2(st.summary.payment_amount), r2(st.summary.closing),
    r2(st.summary.check_diff || 0), operator, t, t, body.demo_tag || null);

  return {
    id: Number(info.lastInsertRowid), file_no: no, version_no: version,
    amount_opening: r2(st.opening), amount_invoiced: r2(st.summary.invoice_amount),
    amount_paid: r2(st.summary.payment_amount), amount_closing: r2(st.summary.closing),
    check_diff: r2(st.summary.check_diff || 0),
    warnings: st.warnings || [],
    note: '已生成草稿。确认金额无误后点「授权发布」，客户才能在商城下载'
  };
}

/* -------------------------------------------------------------------- */
function decorate(row, withSnapshot) {
  const d = {
    ...row,
    status_label: STATUS[row.status] || row.status,
    kind_label: KIND[row.kind] || row.kind,
    expired: !!(row.expire_at && row.expire_at < today()),
    valid: row.status === 'published' && !(row.expire_at && row.expire_at < today())
  };
  delete d.snapshot;
  if (withSnapshot && row.snapshot) d.snapshot = JSON.parse(row.snapshot);
  return d;
}

function list(q = {}) {
  const w = [];
  const a = [];
  if (q.customer_id) { w.push('customer_id = ?'); a.push(Number(q.customer_id)); }
  if (q.status) { w.push('status = ?'); a.push(q.status); }
  if (q.kind) { w.push('kind = ?'); a.push(q.kind); }
  if (q.q) { w.push('(customer_name LIKE ? OR file_no LIKE ? OR title LIKE ?)'); const k = `%${q.q}%`; a.push(k, k, k); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM statement_files ${where} ORDER BY id DESC LIMIT 300`).all(...a).map((r) => decorate(r));
}

function detail(id) {
  const row = db.prepare('SELECT * FROM statement_files WHERE id = ?').get(Number(id));
  if (!row) throw bad('对账文件不存在', 404);
  return decorate(row, true);
}

/**
 * 授权发布：这一步是「我们正式承认这份数」，所以要求填授权人，且 check_diff 必须为 0
 */
function publish(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM statement_files WHERE id = ?').get(Number(id));
  if (!row) throw bad('对账文件不存在', 404);
  if (row.status === 'published') throw bad('这份已经授权过了');
  if (row.status === 'revoked') throw bad('已撤销的文件不能直接再发布，请重新生成（账已经变了，旧快照不该复用）');

  if (Math.abs(Number(row.check_diff) || 0) > 0.005) {
    throw bad(
      `这份对账单内部校验差 ${r2(row.check_diff)} 元，不能发给客户。` +
      '通常是发票的已收金额被手工改过、或有收款没走流水 —— 先在「客户对账单」页查清 warnings 再重新生成'
    );
  }

  const snap = JSON.parse(row.snapshot);
  const notices = (snap.notices || []).length;
  const warnings = [];
  if (notices) {
    warnings.push(`快照里有 ${notices} 条提示未读（如「有收款尚未核销」），发出去客户可能会追问`);
  }
  if (!(Number(row.amount_invoiced) || Number(row.amount_paid))) {
    warnings.push('这段时间既没开票也没收款，发给客户意义不大');
  }

  const expireAt = body.expire_at && /^\d{4}-\d{2}-\d{2}$/.test(body.expire_at) ? body.expire_at : null;
  if (expireAt && expireAt < today()) throw bad('有效期不能早于今天 —— 授权立刻失效等于没授权');

  const t = now();
  db.exec('BEGIN');
  try {
    // 同客户同期间同类型只允许一份生效：旧的自动撤销（不删行，客户可能已经下过）
    const olds = db.prepare(
      `SELECT id, file_no FROM statement_files
        WHERE customer_id=? AND period_from=? AND period_to=? AND kind=? AND status='published' AND id<>?`
    ).all(row.customer_id, row.period_from, row.period_to, row.kind, row.id);
    const stUpd = db.prepare(
      "UPDATE statement_files SET status='revoked', revoked_by=?, revoked_at=?, revoke_reason=?, updated_at=? WHERE id=?"
    );
    olds.forEach((o) => stUpd.run(operator, t, '同期间发布了新版本，旧版自动失效', t, o.id));

    db.prepare(
      `UPDATE statement_files SET status='published', granted_by=?, granted_at=?, expire_at=?, updated_at=? WHERE id=?`
    ).run(operator, t, expireAt, t, row.id);
    db.exec('COMMIT');

    return {
      id: row.id, file_no: row.file_no, status: 'published',
      superseded: olds.map((o) => o.file_no),
      warnings,
      note: '已授权。客户在商城「对账与账单」里可以下载这份文件，每次下载都会留痕'
    };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function revoke(id, body = {}, operator) {
  const row = db.prepare('SELECT * FROM statement_files WHERE id = ?').get(Number(id));
  if (!row) throw bad('对账文件不存在', 404);
  if (row.status !== 'published') throw bad('只有已授权的文件才能撤销');
  const reason = String(body.reason || '').trim();
  if (reason.length < 4) throw bad('撤销要写原因（至少 4 个字）—— 客户可能已经下载过，撤销本身就是一次对外沟通');
  const t = now();
  db.prepare("UPDATE statement_files SET status='revoked', revoked_by=?, revoked_at=?, revoke_reason=?, updated_at=? WHERE id=?")
    .run(operator, t, reason, t, row.id);
  return { id: row.id, status: 'revoked' };
}

/* -------------------------------------------------------------------- *
 * 客户侧
 * -------------------------------------------------------------------- */

/** 客户能看到的：已授权 + 未过期 */
function customerList(customerId) {
  const t = today();
  return db.prepare(
    `SELECT * FROM statement_files
      WHERE customer_id = ? AND status='published' AND (IFNULL(expire_at,'') = '' OR expire_at >= ?)
      ORDER BY period_to DESC, version_no DESC LIMIT 60`
  ).all(Number(customerId), t).map((r) => {
    const d = decorate(r);
    return {
      id: d.id, file_no: d.file_no, title: d.title, file_name: d.file_name,
      period_from: d.period_from, period_to: d.period_to, kind: d.kind, kind_label: d.kind_label,
      version_no: d.version_no,
      amount_opening: d.amount_opening, amount_invoiced: d.amount_invoiced,
      amount_paid: d.amount_paid, amount_closing: d.amount_closing,
      granted_at: d.granted_at, expire_at: d.expire_at, download_count: d.download_count
    };
  });
}

/** 取快照并记下载（越权/失效都在这里挡） */
function takeForDownload(customerId, id, ctx = {}) {
  const row = db.prepare('SELECT * FROM statement_files WHERE id = ?').get(Number(id));
  if (!row) throw bad('对账文件不存在', 404);
  if (Number(row.customer_id) !== Number(customerId)) throw bad('这不是给你的对账文件', 403);
  if (row.status !== 'published') throw bad('这份对账文件已失效，请联系业务员重新出具');
  if (row.expire_at && row.expire_at < today()) throw bad(`这份对账文件的授权已于 ${row.expire_at} 到期，请联系业务员续期`);

  const t = now();
  db.prepare('UPDATE statement_files SET download_count = download_count + 1, last_download_at = ? WHERE id=?').run(t, row.id);

  // 下载留痕：与内部文档访问用同一张日志表（doc_type 区分），不另建
  try {
    db.prepare(
      `INSERT INTO doc_access_logs (doc_type, doc_id, doc_name, access_level, action, allowed, operator, operator_role, reason, created_at)
       VALUES ('statement_file', ?, ?, 'external', 'download', 1, ?, 'customer', ?, ?)`
    ).run(row.id, row.file_name || row.title, ctx.operator || 'customer',
      `客户下载对账文件 ${row.file_no}（${row.period_from}~${row.period_to}）`, t);
  } catch (e) { /* 日志失败不该挡住客户下载 */ }

  return { row, snapshot: JSON.parse(row.snapshot) };
}

/**
 * 渲染成 CSV（带 BOM，Excel 直接双击打开不乱码）
 * 列口径与内部对账单一致：借方=开票、贷方=收款，余额滚动。
 * 原币种单独的列，因为外贸客户是拿 USD 下的单，只看人民币会觉得「金额不对」。
 */
function toCsv(snapshot) {
  const c = snapshot.customer || {};
  const p = snapshot.period || {};
  const s = snapshot.summary || {};
  const q = (v) => {
    const str = v == null ? '' : String(v);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [];
  lines.push(['对账单', c.name || '', `${p.from} 至 ${p.to}`].map(q).join(','));
  lines.push(['客户编码', c.code || ''].map(q).join(','));
  lines.push(['币种', '本位币（人民币）为记账金额；「原币金额」列是客户下单的实际币种'].map(q).join(','));
  lines.push([]);
  lines.push(['期初结欠', s.opening, '', '', '', '', ''].map(q).join(','));
  lines.push(['日期', '类型', '单号', '开票金额', '收款金额', '原币金额', '余额'].map(q).join(','));
  (snapshot.rows || []).forEach((r) => {
    const kindLabel = r.kind === 'invoice' ? '开票' : (r.kind === 'payment' ? '收款' : (r.kind || ''));
    lines.push([
      r.date || '', kindLabel, r.no || '',
      Number(r.debit) ? r.debit : '',
      Number(r.credit) ? r.credit : '',
      r.amount_orig != null ? `${r.amount_orig} ${r.currency || ''}`.trim() : '',
      r.balance
    ].map(q).join(','));
  });
  lines.push([]);
  lines.push(['本期开票', s.invoice_amount, `${s.invoice_count || 0} 张`].map(q).join(','));
  lines.push(['本期收款', s.payment_amount, `${s.payment_count || 0} 笔`].map(q).join(','));
  if (Number(s.unallocated)) lines.push(['其中未核销收款', s.unallocated].map(q).join(','));
  lines.push(['期末结欠', s.closing].map(q).join(','));
  if ((snapshot.notices || []).length) {
    lines.push([]);
    lines.push(['说明'].map(q).join(','));
    snapshot.notices.forEach((n) => lines.push([n].map(q).join(',')));
  }
  lines.push([]);
  lines.push([`生成时间 ${snapshot.generated_at || ''}（本文件为发布时的定版，后续账务变动不追溯）`].map(q).join(','));
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = { STATUS, KIND, generate, list, detail, publish, revoke, customerList, takeForDownload, toCsv, decorate };
