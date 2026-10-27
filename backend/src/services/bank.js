/**
 * 税票银行与结算服务（M12）
 *
 * 三件事：
 *   1. 流水导入去重 —— 同一份对账单导两次不能翻倍（靠 dedupe_key 指纹）
 *   2. 流水 ↔ 收付款单匹配 —— 金额 + 方向 + 日期接近 + 对方名称，打分后自动对；不确定的留给人
 *   3. 银行对账 —— 银行余额 vs 账面余额，把差额拆成「银行记了企业没记」「企业记了银行没记」两类未达账项
 *
 * 对账恒等式（写完就自检）：
 *   银行余额 + 企业已记银行未记 = 账面余额 + 银行已记企业未记
 * 两边不相等，说明流水导入不全或有未识别调整 —— 这正是对账要暴露的东西。
 */
const crypto = require('crypto');
const { db } = require('../db');
const { localNow, localDate } = require('./sla');

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => Number(v) || 0;
const periodOf = (d) => String(d || localDate()).slice(0, 7);
const monthEnd = (p) => {
  const [y, m] = String(p).split('-').map(Number);
  const d = new Date(y, m, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 有效收付款（作废/反审的不算） */
const PAY_VALID = "status IN ('valid','confirmed') AND (reversed_at IS NULL OR reversed_at='')";

/** 只有一个有效账户时，未指定账户的收付款归属它（单账户场景能直接对账） */
function soloAccountId() {
  const list = db.prepare("SELECT id FROM bank_accounts WHERE status='active'").all();
  return list.length === 1 ? list[0].id : null;
}

/** 该账户在区间内的收付款净额（企业账） */
function paySum(accountId, from, to, solo) {
  const useSolo = solo && accountId === solo;
  const where = [`${PAY_VALID}`];
  const params = [];
  if (useSolo) {
    where.push('(bank_account_id=? OR bank_account_id IS NULL)');
    params.push(accountId);
  } else {
    where.push('bank_account_id=?');
    params.push(accountId);
  }
  if (from) { where.push('pay_date >= ?'); params.push(from); }
  if (to) { where.push('pay_date <= ?'); params.push(to); }
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) in_amt,
       COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) out_amt,
       COUNT(*) c
     FROM payments WHERE ${where.join(' AND ')}`
  ).get(...params);
  return { in: r2(row.in_amt), out: r2(row.out_amt), count: row.c, net: r2(num(row.in_amt) - num(row.out_amt)) };
}

/** 账面余额：期初 + 截至该期末的收付净额 */
function bookBalance(accountId, period) {
  const acc = db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(accountId);
  if (!acc) return { balance: 0, open: 0, ...{ in: 0, out: 0, net: 0 } };
  const end = monthEnd(period);
  const solo = soloAccountId();
  const s = paySum(accountId, null, end, solo);
  return {
    open_balance: r2(acc.open_balance),
    in_amt: s.in, out_amt: s.out, net: s.net, payment_count: s.count,
    balance: r2(num(acc.open_balance) + s.net)
  };
}

/** 银行余额：期间内最后一条带余额的流水 */
function statementBalance(accountId, period) {
  const end = monthEnd(period);
  const last = db.prepare(
    `SELECT * FROM bank_statement_lines WHERE account_id=? AND trade_date<=? AND balance IS NOT NULL
     ORDER BY trade_date DESC, id DESC LIMIT 1`
  ).get(accountId, end);
  // 流水累计推算（用于判断「导入是否完整」）
  const calc = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) s,
            COUNT(*) c
     FROM bank_statement_lines WHERE account_id=? AND trade_date<=?`
  ).get(accountId, end);
  const acc = db.prepare('SELECT open_balance FROM bank_accounts WHERE id=?').get(accountId);
  return {
    balance: last && last.balance !== null ? r2(last.balance) : null,
    last_date: last ? last.trade_date : null,
    calc_balance: r2(num(acc ? acc.open_balance : 0) + num(calc.s)),
    line_count: calc.c
  };
}

/** 流水指纹：账户 + 日期 + 方向 + 金额 + 对方 + 摘要 */
function dedupeKey(accountId, l) {
  const raw = [accountId, String(l.trade_date || '').slice(0, 10), l.direction,
    r2(l.amount).toFixed(2), String(l.counterparty || '').trim(), String(l.summary || '').trim()].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

/** 导入流水（幂等） */
function importLines(accountId, lines, { source_name, operator } = {}) {
  const acc = db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(accountId);
  if (!acc) throw new Error('银行账户不存在');

  const d = localDate().replace(/-/g, '');
  const seqN = db.prepare('SELECT COUNT(*) c FROM bank_imports WHERE import_no LIKE ?').get(`IMP${d}%`).c + 1;
  const importNo = `IMP${d}${String(seqN).padStart(4, '0')}`;
  const t = localNow();

  const ins = db.prepare(
    `INSERT INTO bank_statement_lines (import_id,account_id,trade_date,period,direction,amount,balance,
       summary,counterparty,counterparty_acct,currency,dedupe_key,match_status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'unmatched',?)`
  );
  const exists = db.prepare('SELECT id FROM bank_statement_lines WHERE dedupe_key=?');

  let added = 0; let dup = 0; let inT = 0; let outT = 0;
  db.exec('BEGIN');
  try {
    const importId = db.prepare(
      `INSERT INTO bank_imports (import_no,account_id,period,source_name,line_count,dup_count,in_total,out_total,status,operator,created_at)
       VALUES (?,?,?,?,0,0,0,0,'done',?,?)`
    ).run(importNo, accountId, null, source_name || null, operator || null, t).lastInsertRowid;

    for (const l of lines) {
      const dir = l.direction === 'out' ? 'out' : 'in';
      const amt = r2(l.amount);
      if (!(amt > 0)) continue;
      const date = String(l.trade_date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const key = dedupeKey(accountId, { ...l, direction: dir, amount: amt });
      if (exists.get(key)) { dup += 1; continue; }
      ins.run(importId, accountId, date, date.slice(0, 7), dir, amt,
        l.balance === undefined || l.balance === null || l.balance === '' ? null : r2(l.balance),
        l.summary || null, l.counterparty || null, l.counterparty_acct || null,
        l.currency || acc.currency || 'CNY', key, t);
      added += 1;
      if (dir === 'in') inT += amt; else outT += amt;
    }

    const periods = db.prepare(
      'SELECT DISTINCT period FROM bank_statement_lines WHERE import_id=?'
    ).all(importId).map((x) => x.period).filter(Boolean).sort();
    db.prepare('UPDATE bank_imports SET line_count=?, dup_count=?, in_total=?, out_total=?, period=?, status=? WHERE id=?')
      .run(added, dup, r2(inT), r2(outT), periods.join(',') || null, added ? 'done' : 'partial', importId);
    db.exec('COMMIT');
    return { import_no: importNo, import_id: importId, added, dup, in_total: r2(inT), out_total: r2(outT), periods };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 候选收付款（给某条流水算分） */
function candidates(line, { days = 7, accountId, solo } = {}) {
  const dir = line.direction === 'in' ? 'in' : 'out';
  const from = shiftDate(line.trade_date, -days);
  const to = shiftDate(line.trade_date, days);
  const used = new Set(
    db.prepare('SELECT payment_id FROM bank_statement_lines WHERE payment_id IS NOT NULL AND match_status IN (\'auto\',\'manual\')')
      .all().map((x) => x.payment_id)
  );

  const rows = db.prepare(
    `SELECT * FROM payments
     WHERE ${PAY_VALID} AND direction=? AND ABS(amount - ?) < 0.02
       AND pay_date >= ? AND pay_date <= ?
       AND (bank_account_id = ? OR bank_account_id IS NULL)
     ORDER BY ABS(julianday(pay_date) - julianday(?)) ASC`
  ).all(dir, num(line.amount), from, to, accountId, line.trade_date);

  return rows.map((p) => {
    let score = 0;
    const why = [];
    if (Math.abs(num(p.amount) - num(line.amount)) < 0.01) { score += 40; why.push('金额一致'); }
    if (p.direction === dir) { score += 20; why.push('方向一致'); }
    const dd = Math.abs(dayDiff(p.pay_date, line.trade_date));
    if (dd <= 1) { score += 30; why.push('同日/隔日'); } else if (dd <= 3) { score += 20; why.push(`差 ${dd} 天`); } else if (dd <= days) { score += 10; why.push(`差 ${dd} 天`); }
    const a = String(p.partner_name || '').trim();
    const b = String(line.counterparty || '').trim();
    if (a && b && (a.includes(b) || b.includes(a))) { score += 20; why.push('对方名称相符'); }
    return {
      payment_id: p.id, pay_no: p.pay_no, partner_name: p.partner_name, amount: r2(p.amount),
      direction: p.direction, pay_date: p.pay_date, score, why, taken: used.has(p.id)
    };
  }).sort((x, y) => y.score - x.score);
}

function shiftDate(date, delta) {
  const d = new Date(String(date) + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayDiff(a, b) {
  return Math.round((new Date(String(b) + 'T00:00:00') - new Date(String(a) + 'T00:00:00')) / 86400000);
}

/**
 * 自动匹配
 * 规则：金额必须严格一致（已在 SQL 里过滤）；分数最高且 ≥ 70 分、且没有并列时才自动对。
 * 并列或不够分的一律留给人 —— 宁可让人多点一次，也不要对错账。
 */
function autoMatch(accountId, { days = 7, operator } = {}) {
  const solo = soloAccountId();
  const lines = db.prepare(
    "SELECT * FROM bank_statement_lines WHERE account_id=? AND match_status='unmatched' ORDER BY trade_date ASC"
  ).all(accountId);

  let matched = 0; let ambiguous = 0; let none = 0;
  const details = [];
  const t = localNow();

  db.exec('BEGIN');
  try {
    for (const line of lines) {
      const cands = candidates(line, { days, accountId, solo }).filter((c) => !c.taken);
      if (!cands.length) { none += 1; continue; }
      const top = cands[0];
      const tie = cands.filter((c) => c.score === top.score);
      if (top.score < 70 || tie.length > 1) {
        ambiguous += 1;
        details.push({
          line_id: line.id, trade_date: line.trade_date, amount: r2(line.amount),
          direction: line.direction, result: 'ambiguous', best: top, candidates: cands.length
        });
        continue;
      }
      db.prepare("UPDATE bank_statement_lines SET match_status='auto', payment_id=?, matched_at=?, matched_by=? WHERE id=?")
        .run(top.payment_id, t, operator || 'auto', line.id);
      matched += 1;
      details.push({
        line_id: line.id, trade_date: line.trade_date, amount: r2(line.amount),
        direction: line.direction, result: 'matched', payment_id: top.payment_id,
        pay_no: top.pay_no, score: top.score, why: top.why
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { total: lines.length, matched, ambiguous, none, details: details.slice(0, 30) };
}

/** 手工匹配 */
function manualMatch(lineId, paymentId, operator) {
  const line = db.prepare('SELECT * FROM bank_statement_lines WHERE id=?').get(lineId);
  if (!line) throw new Error('流水不存在');
  if (line.match_status === 'manual' || line.match_status === 'auto') throw new Error('这条流水已经匹配过了，先取消匹配');
  const p = db.prepare(`SELECT * FROM payments WHERE id=? AND ${PAY_VALID}`).get(paymentId);
  if (!p) throw new Error('收付款单不存在或已作废');
  if (p.direction !== line.direction) throw new Error(`方向不一致：流水是${line.direction === 'in' ? '收入' : '支出'}，单据是${p.direction === 'in' ? '收入' : '支出'}`);
  if (Math.abs(num(p.amount) - num(line.amount)) > 0.01) {
    throw new Error(`金额不一致：流水 ${r2(line.amount)}，单据 ${r2(p.amount)}`);
  }
  const dup = db.prepare(
    "SELECT id FROM bank_statement_lines WHERE payment_id=? AND match_status IN ('auto','manual') AND id<>?"
  ).get(paymentId, lineId);
  if (dup) throw new Error('这张收付款单已经被另一条流水匹配了');

  db.prepare("UPDATE bank_statement_lines SET match_status='manual', payment_id=?, matched_at=?, matched_by=? WHERE id=?")
    .run(paymentId, localNow(), operator || null, lineId);
  return { line_id: lineId, payment_id: paymentId };
}

function unmatch(lineId) {
  const line = db.prepare('SELECT * FROM bank_statement_lines WHERE id=?').get(lineId);
  if (!line) throw new Error('流水不存在');
  if (line.match_status === 'unmatched') throw new Error('这条流水本来就没匹配');
  db.prepare("UPDATE bank_statement_lines SET match_status='unmatched', payment_id=NULL, matched_at=NULL, matched_by=NULL WHERE id=?")
    .run(lineId);
  return { line_id: lineId };
}

/** 对账预览：算未达账项与调节表（不落库） */
function preview(accountId, period, statementBalanceInput) {
  const acc = db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(accountId);
  if (!acc) throw new Error('银行账户不存在');
  const p = periodOf(period);
  const end = monthEnd(p);
  const solo = soloAccountId();

  const book = bookBalance(accountId, p);
  const stmt = statementBalance(accountId, p);
  const stmtBal = statementBalanceInput === undefined || statementBalanceInput === null || statementBalanceInput === ''
    ? (stmt.balance !== null ? stmt.balance : stmt.calc_balance)
    : r2(statementBalanceInput);

  // 银行记了、企业没记：未匹配的流水
  const bankOnly = db.prepare(
    `SELECT * FROM bank_statement_lines
     WHERE account_id=? AND trade_date<=? AND match_status IN ('unmatched','ignored')`
  ).all(accountId, end);
  // 企业记了、银行没记：未被匹配的收付款（同期有效单据）
  const useSolo = solo && accountId === solo;
  const bookOnly = db.prepare(
    `SELECT * FROM payments
     WHERE ${PAY_VALID} AND pay_date<=?
       AND ${useSolo ? '(bank_account_id=? OR bank_account_id IS NULL)' : 'bank_account_id=?'}
       AND id NOT IN (SELECT payment_id FROM bank_statement_lines WHERE payment_id IS NOT NULL AND match_status IN ('auto','manual'))`
  ).all(end, accountId);

  const sum = (arr, dir) => r2(arr.filter((x) => x.direction === dir).reduce((a, x) => a + num(x.amount), 0));
  const bankOnlyIn = sum(bankOnly, 'in');
  const bankOnlyOut = sum(bankOnly, 'out');
  const bookOnlyIn = sum(bookOnly, 'in');
  const bookOnlyOut = sum(bookOnly, 'out');

  const adjustedStatement = r2(stmtBal + bookOnlyIn - bookOnlyOut);
  const adjustedBook = r2(book.balance + bankOnlyIn - bankOnlyOut);
  const diff = r2(adjustedStatement - adjustedBook);

  return {
    account: { id: acc.id, account_no: acc.account_no, bank_name: acc.bank_name, account_masked: acc.account_masked, currency: acc.currency },
    period: p, period_end: end,
    statement_balance: stmtBal,
    statement_from_bank: stmt.balance,
    statement_calc: stmt.calc_balance,
    import_gap: stmt.balance === null ? null : r2(stmt.calc_balance - stmt.balance),
    last_line_date: stmt.last_date,
    line_count: stmt.line_count,
    book_balance: book.balance,
    open_balance: book.open_balance,
    book_in: book.in_amt, book_out: book.out_amt,
    bank_only_in: bankOnlyIn, bank_only_out: bankOnlyOut,
    book_only_in: bookOnlyIn, book_only_out: bookOnlyOut,
    adjusted_statement: adjustedStatement,
    adjusted_book: adjustedBook,
    diff_amount: diff,
    balanced: Math.abs(diff) < 0.01,
    items: [
      ...bankOnly.map((x) => ({
        type: 'bank_only', direction: x.direction, amount: r2(x.amount), trade_date: x.trade_date,
        ref_no: `流水#${x.id}`, counterparty: x.counterparty, summary: x.summary
      })),
      ...bookOnly.map((x) => ({
        type: 'book_only', direction: x.direction, amount: r2(x.amount), trade_date: x.pay_date,
        ref_no: x.pay_no, counterparty: x.partner_name, summary: x.remark || '收付款单'
      }))
    ],
    note: stmt.balance === null
      ? '这个账户还没有带余额的流水，期末余额按「期初 + 流水累计」推算；建议导入完整对账单'
      : null
  };
}

/** 生成对账（落库） */
function createRecon(accountId, period, { statement_balance, note, operator } = {}) {
  const pv = preview(accountId, period, statement_balance);
  const d = localDate().replace(/-/g, '');
  const seqN = db.prepare('SELECT COUNT(*) c FROM bank_reconciliations WHERE recon_no LIKE ?').get(`DZ${d}%`).c + 1;
  const no = `DZ${d}${String(seqN).padStart(4, '0')}`;
  const t = localNow();

  db.exec('BEGIN');
  try {
    const id = db.prepare(
      `INSERT INTO bank_reconciliations (recon_no,account_id,period,statement_balance,book_balance,
         bank_only_in,bank_only_out,book_only_in,book_only_out,adjusted_statement,adjusted_book,diff_amount,
         unmatched_lines,unmatched_payments,status,note,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`
    ).run(no, accountId, pv.period, pv.statement_balance, pv.book_balance,
      pv.bank_only_in, pv.bank_only_out, pv.book_only_in, pv.book_only_out,
      pv.adjusted_statement, pv.adjusted_book, pv.diff_amount,
      pv.items.filter((x) => x.type === 'bank_only').length,
      pv.items.filter((x) => x.type === 'book_only').length,
      note || null, operator || null, t).lastInsertRowid;

    const insItem = db.prepare(
      `INSERT INTO bank_reconciliation_items (recon_id,type,direction,amount,trade_date,ref_no,counterparty,summary,handled)
       VALUES (?,?,?,?,?,?,?,?,0)`
    );
    pv.items.forEach((x) => insItem.run(id, x.type, x.direction, x.amount, x.trade_date, x.ref_no, x.counterparty, x.summary));
    db.exec('COMMIT');
    return { id, recon_no: no, ...pv };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 确认对账：差额不为 0 不让确认（对账的意义就是把这个差找出来） */
function confirmRecon(id, operator) {
  const r = db.prepare('SELECT * FROM bank_reconciliations WHERE id=?').get(id);
  if (!r) throw new Error('对账记录不存在');
  if (r.status === 'confirmed') throw new Error('这份对账已经确认过了');
  if (Math.abs(num(r.diff_amount)) > 0.01) {
    throw new Error(`调节后仍有差额 ${r2(r.diff_amount)}，不能确认。请检查：① 流水是否导入完整 ② 是否有手续费/利息未入账 ③ 期末余额是否填错`);
  }
  db.prepare("UPDATE bank_reconciliations SET status='confirmed', confirmed_by=?, confirmed_at=? WHERE id=?")
    .run(operator || null, localNow(), id);
  return { id, status: 'confirmed' };
}

/** 票据：到期提醒 + 状态校验 */
const BILL_FLOW = {
  receivable: { holding: ['endorsed', 'discounted', 'collected', 'settled', 'void'], collected: ['settled'], endorsed: [], discounted: [], settled: [], void: [] },
  payable: { holding: ['settled', 'void'], settled: [], void: [] }
};

function billsOverview() {
  const today = localDate();
  const in30 = shiftDate(today, 30);
  const rows = db.prepare('SELECT * FROM bank_bills ORDER BY due_date ASC').all().map((b) => {
    const days = b.due_date ? dayDiff(today, b.due_date) : null;
    return {
      ...b,
      amount: r2(b.amount),
      days_left: days,
      urgent: b.status === 'holding' && days !== null && days <= 30,
      overdue: b.status === 'holding' && days !== null && days < 0,
      type_label: b.type === 'receivable' ? '应收票据' : '应付票据',
      status_label: {
        holding: '持有', endorsed: '已背书', discounted: '已贴现',
        collected: '已托收', settled: '已兑付', void: '已作废'
      }[b.status] || b.status,
      accept_label: b.accept_type === 'bank' ? '银行承兑' : '商业承兑'
    };
  });
  return {
    rows,
    receivable_total: r2(rows.filter((b) => b.type === 'receivable' && ['holding', 'collected'].includes(b.status)).reduce((a, b) => a + b.amount, 0)),
    payable_total: r2(rows.filter((b) => b.type === 'payable' && b.status === 'holding').reduce((a, b) => a + b.amount, 0)),
    due_30: rows.filter((b) => b.urgent).length,
    overdue: rows.filter((b) => b.overdue).length,
    discounted: r2(rows.filter((b) => b.status === 'discounted').reduce((a, b) => a + b.amount, 0))
  };
}

function setBillStatus(id, status, extra = {}) {
  const b = db.prepare('SELECT * FROM bank_bills WHERE id=?').get(id);
  if (!b) throw new Error('票据不存在');
  const flow = BILL_FLOW[b.type] || {};
  const allowed = flow[b.status] || [];
  if (!allowed.includes(status)) {
    throw new Error(`「${b.status}」不能直接改成「${status}」${allowed.length ? '，只能改成：' + allowed.join(' / ') : '（已是终态）'}`);
  }
  if (status === 'discounted' && !(Number(extra.discount_rate) >= 0)) {
    throw new Error('贴现必须填贴现率');
  }
  const t = localNow();
  db.prepare(
    `UPDATE bank_bills SET status=?, discount_rate=COALESCE(?,discount_rate), discount_cost=COALESCE(?,discount_cost),
       cash_in_date=COALESCE(?,cash_in_date), note=COALESCE(?,note), updated_at=? WHERE id=?`
  ).run(status,
    extra.discount_rate === undefined ? null : Number(extra.discount_rate),
    extra.discount_cost === undefined ? null : r2(extra.discount_cost),
    extra.cash_in_date || null, extra.note || null, t, id);
  return { id, status };
}

/** 资金概览 */
function overview() {
  const accounts = db.prepare("SELECT * FROM bank_accounts WHERE status='active' ORDER BY id").all();
  const cur = periodOf(localDate());
  const list = accounts.map((a) => {
    const bk = bookBalance(a.id, cur);
    const st = statementBalance(a.id, cur);
    const un = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM bank_statement_lines WHERE account_id=? AND match_status='unmatched'").get(a.id);
    return {
      id: a.id, account_no: a.account_no, bank_name: a.bank_name, account_masked: a.account_masked,
      currency: a.currency, account_type: a.account_type,
      open_balance: r2(a.open_balance), book_balance: bk.balance,
      statement_balance: st.balance === null ? st.calc_balance : st.balance,
      unmatched_lines: un.c, unmatched_amount: r2(un.s)
    };
  });
  const unTotal = db.prepare("SELECT COUNT(*) c FROM bank_statement_lines WHERE match_status='unmatched'").get().c;
  const lastRecon = db.prepare('SELECT * FROM bank_reconciliations ORDER BY id DESC LIMIT 1').get();
  const b = billsOverview();
  return {
    period: cur,
    accounts: list,
    account_count: list.length,
    book_total: r2(list.reduce((a, x) => a + x.book_balance, 0)),
    statement_total: r2(list.reduce((a, x) => a + x.statement_balance, 0)),
    unmatched_total: unTotal,
    last_recon: lastRecon ? {
      recon_no: lastRecon.recon_no, period: lastRecon.period, status: lastRecon.status,
      diff_amount: r2(lastRecon.diff_amount), created_at: lastRecon.created_at
    } : null,
    bills: {
      receivable_total: b.receivable_total, payable_total: b.payable_total,
      due_30: b.due_30, overdue: b.overdue, discounted: b.discounted
    }
  };
}

module.exports = {
  periodOf, monthEnd, soloAccountId, paySum, bookBalance, statementBalance, dedupeKey,
  importLines, candidates, autoMatch, manualMatch, unmatch, preview, createRecon, confirmRecon,
  billsOverview, setBillStatus, overview, BILL_FLOW, shiftDate, dayDiff, r2, num
};
