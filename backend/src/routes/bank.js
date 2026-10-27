/**
 * 税票银行与结算（M12）→ /api/bank
 *
 * 底线：本模块只做「核对」，不自动改账。
 * 流水匹配只建立关联关系，不动 payments；对账只出调节表，不替人补记凭证。
 */
const express = require('express');
const { db } = require('../db');
const { ok, fail, wrap } = require('../utils/http');
const { authRequired, requireRole } = require('../middleware/auth');
const { localNow, localDate } = require('../services/sla');
const B = require('../services/bank');

const router = express.Router();
const WRITE = ['admin', 'finance'];
const ADMIN = ['admin'];

/** 简单 CSV 解析：日期,摘要,对方户名,收入,支出,余额（允许有表头，允许用制表符/分号分隔） */
function parseCsv(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const sep = raw.includes('\t') ? '\t' : (raw.split(';').length > raw.split(',').length ? ';' : ',');
  const cellsOf = (l) => l.split(sep).map((x) => x.trim().replace(/^"|"$/g, ''));
  let start = 0;
  const head = cellsOf(lines[0] || '');
  if (head.some((h) => /日期|摘要|金额|收入|支出|余额|对方/.test(h))) start = 1;

  const out = [];
  for (let i = start; i < lines.length; i++) {
    const c = cellsOf(lines[i]);
    if (c.length < 2) continue;
    const date = normalDate(c[0]);
    if (!date) continue;
    // 两种常见格式都吃：
    //   5 列以上：日期,摘要,对方,收入,支出[,余额]
    //   4 列及以下：日期,摘要,对方,金额（正数收入 / 负数支出）
    const inc = numOrNull(c[3]);
    const exp = numOrNull(c[4]);
    let direction = 'in';
    let amount = 0;
    if (c.length >= 5) {
      if (inc !== null && inc !== 0) { direction = 'in'; amount = inc; }
      else if (exp !== null && exp !== 0) { direction = 'out'; amount = exp; }
      else continue;
    } else {
      if (inc === null || inc === 0) continue;
      direction = inc > 0 ? 'in' : 'out';
      amount = Math.abs(inc);
    }
    out.push({
      trade_date: date,
      summary: c[1] || null,
      counterparty: c[2] || null,
      direction, amount,
      balance: numOrNull(c[5])
    });
  }
  return out;
}

const numOrNull = (v) => {
  const s = String(v === undefined || v === null ? '' : v).replace(/[,¥$￥\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

function normalDate(v) {
  const s = String(v || '').trim().replace(/[年月]/g, '-').replace(/[日]/g, '').replace(/\//g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

// ============================================================
// 字典与概览
// ============================================================
router.get('/dict', authRequired, wrap(async (req, res) => {
  const accounts = db.prepare('SELECT * FROM bank_accounts ORDER BY status DESC, id').all();
  return ok(res, {
    accounts,
    account_types: [
      { code: 'basic', label: '基本户' }, { code: 'general', label: '一般户' }, { code: 'fx', label: '外币户' }
    ],
    bill_status: [
      { code: 'holding', label: '持有' }, { code: 'endorsed', label: '已背书' },
      { code: 'discounted', label: '已贴现' }, { code: 'collected', label: '已托收' },
      { code: 'settled', label: '已兑付' }, { code: 'void', label: '已作废' }
    ],
    match_status: [
      { code: 'unmatched', label: '未匹配' }, { code: 'auto', label: '自动匹配' },
      { code: 'manual', label: '手工匹配' }, { code: 'ignored', label: '已忽略' }
    ],
    csv_hint: '每行：日期,摘要,对方户名,收入,支出,余额（可带表头）'
  });
}));

router.get('/overview', authRequired, wrap(async (req, res) => ok(res, B.overview())));

// ============================================================
// 银行账户
// ============================================================
router.get('/accounts', authRequired, wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM bank_accounts ORDER BY status DESC, id').all().map((a) => ({
    ...a,
    open_balance: B.r2(a.open_balance),
    status_label: a.status === 'active' ? '启用' : '已关闭',
    type_label: { basic: '基本户', general: '一般户', fx: '外币户' }[a.account_type] || a.account_type
  }));
  return ok(res, rows);
}));

router.post('/accounts', authRequired, requireRole(ADMIN), wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.account_no || '').trim()) return fail(res, 400, '账户编码必填（内部用，如 CN-ICBC-001）');
  if (!String(b.bank_name || '').trim()) return fail(res, 400, '开户行必填');
  if (db.prepare('SELECT id FROM bank_accounts WHERE account_no=?').get(b.account_no)) {
    return fail(res, 400, `账户编码 ${b.account_no} 已存在`);
  }
  if (b.open_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.open_date)) return fail(res, 400, '期初日期格式应为 YYYY-MM-DD');
  const t = localNow();
  const id = db.prepare(
    `INSERT INTO bank_accounts (account_no,company_id,bank_name,account_masked,currency,account_type,
       open_balance,open_date,status,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,'active',?,?,?)`
  ).run(String(b.account_no).trim(), b.company_id || 1, String(b.bank_name).trim(),
    b.account_masked || null, b.currency || 'CNY', b.account_type || 'basic',
    B.r2(b.open_balance), b.open_date || null, b.note || null, t, t).lastInsertRowid;
  return ok(res, { id });
}));

router.put('/accounts/:id', authRequired, requireRole(ADMIN), wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(req.params.id);
  if (!a) return fail(res, 404, '账户不存在');
  const b = req.body || {};
  // 期初余额改了会让历史对账全部失效，所以只允许在没有流水时改
  if (b.open_balance !== undefined && Math.abs(B.num(b.open_balance) - B.num(a.open_balance)) > 0.001) {
    const has = db.prepare('SELECT COUNT(*) c FROM bank_statement_lines WHERE account_id=?').get(a.id).c;
    const hasRecon = db.prepare("SELECT COUNT(*) c FROM bank_reconciliations WHERE account_id=? AND status='confirmed'").get(a.id).c;
    if (has || hasRecon) {
      return fail(res, 400, `该账户已有 ${has} 条流水、${hasRecon} 份已确认对账，改期初余额会让历史对账全部失效；请通过调整分录处理`);
    }
  }
  db.prepare(
    'UPDATE bank_accounts SET bank_name=?, account_masked=?, currency=?, account_type=?, open_balance=?, open_date=?, status=?, note=?, updated_at=? WHERE id=?'
  ).run(
    b.bank_name || a.bank_name, b.account_masked === undefined ? a.account_masked : b.account_masked,
    b.currency || a.currency, b.account_type || a.account_type,
    b.open_balance === undefined ? a.open_balance : B.r2(b.open_balance),
    b.open_date === undefined ? a.open_date : b.open_date,
    b.status || a.status, b.note === undefined ? a.note : b.note, localNow(), a.id
  );
  return ok(res, { id: a.id });
}));

// ============================================================
// 流水导入
// ============================================================
router.get('/imports', authRequired, wrap(async (req, res) => {
  const rows = db.prepare('SELECT * FROM bank_imports ORDER BY id DESC LIMIT 100').all().map((x) => {
    const a = db.prepare('SELECT bank_name, account_masked FROM bank_accounts WHERE id=?').get(x.account_id);
    return {
      ...x,
      in_total: B.r2(x.in_total), out_total: B.r2(x.out_total),
      bank_name: a ? a.bank_name : '—', account_masked: a ? a.account_masked : ''
    };
  });
  return ok(res, rows);
}));

router.post('/import', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const accountId = Number(b.account_id);
  if (!accountId) return fail(res, 400, '请选择银行账户');
  if (!db.prepare('SELECT id FROM bank_accounts WHERE id=?').get(accountId)) return fail(res, 400, '银行账户不存在');

  let lines = [];
  if (Array.isArray(b.lines) && b.lines.length) {
    lines = b.lines.map((l) => ({
      trade_date: normalDate(l.trade_date) || String(l.trade_date || '').slice(0, 10),
      summary: l.summary || null, counterparty: l.counterparty || null,
      direction: l.direction === 'out' ? 'out' : 'in',
      amount: B.num(l.amount), balance: l.balance === undefined ? null : B.num(l.balance)
    }));
  } else if (b.csv) {
    lines = parseCsv(b.csv);
  } else {
    return fail(res, 400, '请粘贴流水内容（CSV）或传 lines 数组');
  }
  if (!lines.length) return fail(res, 400, '没有解析出有效流水。格式：日期,摘要,对方户名,收入,支出,余额');

  const r = B.importLines(accountId, lines, { source_name: b.source_name, operator: req.user.username });
  return ok(res, r);
}));

// ============================================================
// 流水与匹配
// ============================================================
router.get('/lines', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.account_id) { where.push('l.account_id=?'); params.push(Number(req.query.account_id)); }
  if (req.query.period) { where.push('l.period=?'); params.push(req.query.period); }
  if (req.query.status) { where.push('l.match_status=?'); params.push(req.query.status); }
  if (req.query.q) { where.push('(l.summary LIKE ? OR l.counterparty LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const rows = db.prepare(
    `SELECT l.*, p.pay_no, p.partner_name, a.bank_name, a.account_masked
     FROM bank_statement_lines l
     LEFT JOIN payments p ON p.id=l.payment_id
     LEFT JOIN bank_accounts a ON a.id=l.account_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY l.trade_date DESC, l.id DESC LIMIT 500`
  ).all(...params).map((l) => ({
    ...l,
    amount: B.r2(l.amount),
    balance: l.balance === null ? null : B.r2(l.balance),
    with_sign: l.direction === 'in' ? B.r2(l.amount) : -B.r2(l.amount),
    match_label: { unmatched: '未匹配', auto: '自动匹配', manual: '手工匹配', ignored: '已忽略' }[l.match_status] || l.match_status
  }));
  // where 条件里用的是 l.xxx，统计也要带同样的别名，否则 no such column
  const stat = db.prepare(
    `SELECT
       COUNT(*) total,
       SUM(CASE WHEN l.match_status='unmatched' THEN 1 ELSE 0 END) unmatched,
       SUM(CASE WHEN l.match_status IN ('auto','manual') THEN 1 ELSE 0 END) matched
     FROM bank_statement_lines l ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
  ).get(...params);
  return ok(res, { rows, stat });
}));

router.get('/lines/:id/candidates', authRequired, wrap(async (req, res) => {
  const line = db.prepare('SELECT * FROM bank_statement_lines WHERE id=?').get(req.params.id);
  if (!line) return fail(res, 404, '流水不存在');
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
  return ok(res, B.candidates(line, { days, accountId: line.account_id, solo: B.soloAccountId() }));
}));

router.post('/lines/:id/match', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const paymentId = Number((req.body || {}).payment_id);
  if (!paymentId) return fail(res, 400, '请选择要匹配的收付款单');
  try {
    return ok(res, B.manualMatch(Number(req.params.id), paymentId, req.user.username));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

router.post('/lines/:id/unmatch', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  try {
    return ok(res, B.unmatch(Number(req.params.id)));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

router.post('/lines/:id/ignore', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const line = db.prepare('SELECT * FROM bank_statement_lines WHERE id=?').get(req.params.id);
  if (!line) return fail(res, 404, '流水不存在');
  if (line.match_status === 'ignored') return fail(res, 400, '已经忽略过了');
  const reason = String((req.body || {}).reason || '').trim();
  if (reason.length < 4) return fail(res, 400, '忽略必须写原因（至少 4 个字），否则下个月还得重新查一遍');
  db.prepare("UPDATE bank_statement_lines SET match_status='ignored', note=?, matched_at=?, matched_by=? WHERE id=?")
    .run(reason, localNow(), req.user.username, line.id);
  return ok(res, { id: line.id, match_status: 'ignored' });
}));

router.post('/auto-match', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const accountId = Number((req.body || {}).account_id);
  if (!accountId) return fail(res, 400, '请选择银行账户');
  const days = Math.min(30, Math.max(1, Number((req.body || {}).days) || 7));
  const r = B.autoMatch(accountId, { days, operator: req.user.username });
  return ok(res, r);
}));

// ============================================================
// 对账
// ============================================================
router.get('/reconcile/preview', authRequired, wrap(async (req, res) => {
  const accountId = Number(req.query.account_id);
  if (!accountId) return fail(res, 400, '请选择银行账户');
  try {
    return ok(res, B.preview(accountId, req.query.period, req.query.statement_balance));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

router.get('/reconciliations', authRequired, wrap(async (req, res) => {
  const rows = db.prepare(
    `SELECT r.*, a.bank_name, a.account_masked FROM bank_reconciliations r
     LEFT JOIN bank_accounts a ON a.id=r.account_id
     ORDER BY r.id DESC LIMIT 100`
  ).all().map((r) => ({
    ...r,
    statement_balance: B.r2(r.statement_balance), book_balance: B.r2(r.book_balance),
    diff_amount: B.r2(r.diff_amount),
    status_label: r.status === 'confirmed' ? '已确认' : '草稿'
  }));
  return ok(res, rows);
}));

router.get('/reconciliations/:id', authRequired, wrap(async (req, res) => {
  const r = db.prepare(
    `SELECT r.*, a.bank_name, a.account_masked FROM bank_reconciliations r
     LEFT JOIN bank_accounts a ON a.id=r.account_id WHERE r.id=?`
  ).get(req.params.id);
  if (!r) return fail(res, 404, '对账记录不存在');
  const items = db.prepare('SELECT * FROM bank_reconciliation_items WHERE recon_id=? ORDER BY type, trade_date').all(r.id)
    .map((x) => ({
      ...x,
      amount: B.r2(x.amount),
      type_label: x.type === 'bank_only' ? '银行已记 企业未记' : '企业已记 银行未记',
      direction_label: x.direction === 'in' ? '收入' : '支出'
    }));
  return ok(res, {
    ...r, items,
    statement_balance: B.r2(r.statement_balance), book_balance: B.r2(r.book_balance),
    adjusted_statement: B.r2(r.adjusted_statement), adjusted_book: B.r2(r.adjusted_book),
    diff_amount: B.r2(r.diff_amount),
    status_label: r.status === 'confirmed' ? '已确认' : '草稿'
  });
}));

router.post('/reconciliations', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  const accountId = Number(b.account_id);
  if (!accountId) return fail(res, 400, '请选择银行账户');
  if (!/^\d{4}-\d{2}$/.test(String(b.period || ''))) return fail(res, 400, '对账月份格式应为 YYYY-MM');
  const dup = db.prepare("SELECT id FROM bank_reconciliations WHERE account_id=? AND period=? AND status='confirmed'").get(accountId, b.period);
  if (dup) return fail(res, 400, `${b.period} 这个账户已经有确认过的对账了；如需重做请先作废原记录`);
  try {
    return ok(res, B.createRecon(accountId, b.period, {
      statement_balance: b.statement_balance, note: b.note, operator: req.user.username
    }));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

router.post('/reconciliations/:id/confirm', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  try {
    return ok(res, B.confirmRecon(Number(req.params.id), req.user.username));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

// ============================================================
// 票据
// ============================================================
router.get('/bills', authRequired, wrap(async (req, res) => {
  const o = B.billsOverview();
  let rows = o.rows;
  if (req.query.type) rows = rows.filter((x) => x.type === req.query.type);
  if (req.query.status) rows = rows.filter((x) => x.status === req.query.status);
  return ok(res, { ...o, rows });
}));

router.post('/bills', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.bill_no || '').trim()) return fail(res, 400, '票号必填');
  if (!['receivable', 'payable'].includes(b.type)) return fail(res, 400, '类型只能是 receivable（应收票据）/ payable（应付票据）');
  if (!(B.num(b.amount) > 0)) return fail(res, 400, '票面金额必须大于 0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.issue_date || ''))) return fail(res, 400, '出票日格式应为 YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date || ''))) return fail(res, 400, '到期日格式应为 YYYY-MM-DD');
  if (b.due_date <= b.issue_date) return fail(res, 400, '到期日必须晚于出票日');
  if (db.prepare('SELECT id FROM bank_bills WHERE bill_no=? AND type=?').get(b.bill_no, b.type)) {
    return fail(res, 400, `票号 ${b.bill_no} 已经有同类型的记录了`);
  }
  const t = localNow();
  const id = db.prepare(
    `INSERT INTO bank_bills (bill_no,type,direction,drawer,payee,acceptor,accept_type,amount,currency,
       issue_date,due_date,status,partner_type,partner_id,partner_name,ref_no,note,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'holding',?,?,?,?,?,?,?,?)`
  ).run(String(b.bill_no).trim(), b.type, b.type === 'receivable' ? 'in' : 'out',
    b.drawer || null, b.payee || null, b.acceptor || null, b.accept_type || 'bank',
    B.r2(b.amount), b.currency || 'CNY', b.issue_date, b.due_date,
    b.partner_type || (b.type === 'receivable' ? 'customer' : 'supplier'),
    b.partner_id || null, b.partner_name || null, b.ref_no || null, b.note || null,
    req.user.username, t, t).lastInsertRowid;
  return ok(res, { id });
}));

router.put('/bills/:id/status', authRequired, requireRole(WRITE), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.status) return fail(res, 400, '请指定目标状态');
  try {
    return ok(res, B.setBillStatus(Number(req.params.id), b.status, {
      discount_rate: b.discount_rate, discount_cost: b.discount_cost,
      cash_in_date: b.cash_in_date, note: b.note
    }));
  } catch (e) {
    return fail(res, 400, e.message);
  }
}));

module.exports = router;
module.exports.parseCsv = parseCsv;
