/**
 * M12 长期投资抵消 —— 服务层
 * ============================================================
 * 合并报表里最容易出错的一块。核心公式（必须记住，否则永远算不平）：
 *
 *   子公司权益 E、母公司持股 p、长投账面 I
 *   少数股东权益 M = E × (1 − p)
 *   应享权益  share = E × p
 *   商誉      G = I − share       （>0 商誉，<0 负商誉）
 *
 *   抵消分录：
 *     借 子公司权益各科目  E
 *     借 商誉              G            （G<0 不写这行，改贷营业外收入 |G|）
 *     贷 长期股权投资      I
 *     贷 少数股东权益      M
 *   借贷平衡条件：E + G = I + M  →  G = I − E·p  ✓ 恒成立
 *
 *   对合并表的影响（净额）：
 *     adj.asset  += I − max(0, G)      // 冲长投，商誉加回
 *     adj.equity += E − M − max(0, −G) // 冲子公司权益，少数股东权益加回；负商誉部分走损益
 *   两种情况下 adj.asset 都正好等于 adj.equity（因为 G = I − E·p），
 *   所以「资产 = 负债 + 权益」在抵消后依然成立 —— 这才是真平衡，不是两边一起虚增的假平衡。
 *
 * 写进代码的硬规则：
 *   1) **分公司不做长投抵消**（非独立法人、没有股权），只有子公司才抵消
 *   2) **只抵消纳入合并范围的子公司**；持股比例必须 0 < p ≤ 100
 *   3) **同一被投企业同时只能有一条有效投资**（部分唯一索引兜底）
 *   4) **权益法账面价值以长投减至 0 为限**：亏损超过账面时不再往下减（未确认投资损失，
 *      账外备查），绝不允许长投变负数
 *   5) **权益法下分红冲减账面，成本法下分红只确认投资收益不动账面** —— 两种方法不能混
 *   6) **商誉不摊销**（只做减值测试）；**负商誉计入当期损益**并单独披露
 *   7) **抵消结果必须平衡**：借贷不等直接报错，不出半张报表
 *   8) 持股变更必须留痕（增持/减持/确认损益/分红），账面价值可逐笔回溯
 */
const { db } = require('../db');
const G = require('./gl');

const EPS = 0.005;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const int0 = (v) => Math.round(num(v));
const pad = (n) => String(n).padStart(2, '0');

function now() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nextNo(table, col, prefix) {
  const d = new Date();
  const p = `${prefix}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const rows = db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ?`).all(`${p}%`);
  let max = 0;
  rows.forEach((r) => {
    const n = Number(String(r.no).slice(p.length));
    if (Number.isFinite(n) && n > max) max = n;
  });
  let seq = max + 1;
  let no = `${p}${String(seq).padStart(4, '0')}`;
  while (db.prepare(`SELECT 1 x FROM ${table} WHERE ${col} = ?`).get(no)) {
    seq += 1;
    no = `${p}${String(seq).padStart(4, '0')}`;
  }
  return no;
}

const METHOD = { cost: '成本法', equity: '权益法' };
const CHANGE_TYPE = {
  equity_share: '权益法确认损益', dividend: '收到分红',
  increase: '增持', decrease: '减持', dispose: '处置'
};

/** 账面价值：成本法只看成本；权益法 = 成本 + 损益调整 − 分红，且不低于 0 */
function bookOf(inv) {
  if (inv.method === 'cost') return r2(num(inv.acquire_cost));
  return r2(Math.max(0, num(inv.acquire_cost) + num(inv.equity_adjust) - num(inv.dividend_received)));
}

/** 纳入合并范围的子公司（type=subsidiary 且 active） */
function subsidiaries() {
  return db.prepare(
    "SELECT * FROM companies WHERE type = 'subsidiary' AND status = 'active' ORDER BY id"
  ).all();
}

/** 分公司（非独立法人）—— 只并入、不抵消，单独列出来提醒 */
function branches() {
  return db.prepare("SELECT * FROM companies WHERE type = 'branch' AND status = 'active' ORDER BY id").all();
}

/** 子公司某期间的权益明细（剔除内部往来口径：直接用科目余额） */
function equityOf(period, companyId) {
  const bs = G.balanceSheet(period, companyId);
  const rows = (bs.equity || []).map((e) => ({ code: e.code, name: e.name, amount: r2(e.amount) }));
  const rowsSum = r2(rows.reduce((s, e) => s + num(e.amount), 0));
  // balanceSheet 的 equity 明细只含已记账科目，equity_total 还加了「未结转损益」。
  // 差额这块也是子公司权益的一部分，抵消时必须一并抵掉，否则分录借贷永远差这个数。
  const unclosed = r2(num(bs.equity_total) - rowsSum);
  if (Math.abs(unclosed) > EPS) {
    // 与账上已有的 4103 是两笔钱：账上那笔是往期结转过来的，这笔是本期还没结转的
    rows.push({ code: '4103', name: '当期未结转损益', amount: unclosed });
  }
  return {
    rows,
    total: r2(bs.equity_total),
    // 实收资本单列出来：0 说明这家其实没有股权投入（不是真子公司结构）
    paid_in: r2(rows.filter((e) => String(e.code) === '4001').reduce((s, e) => s + num(e.amount), 0))
  };
}

function invRow(r) {
  return {
    ...r,
    method_label: METHOD[r.method] || r.method,
    book_value: bookOf(r),
    share_pct: r4(r.share_pct),
    acquire_cost: r2(r.acquire_cost),
    equity_adjust: r2(r.equity_adjust),
    dividend_received: r2(r.dividend_received),
    status_label: r.status === 'active' ? '持有中' : '已处置',
    minority_pct: r4(100 - num(r.share_pct))
  };
}

function list(q) {
  const rows = db.prepare(
    `SELECT i.*, c.name AS investor_name, e.name AS investee_name2, e.code AS investee_code2, e.type AS investee_type
     FROM equity_investments i
     LEFT JOIN companies c ON c.id = i.company_id
     LEFT JOIN companies e ON e.id = i.investee_id
     ${q.status ? 'WHERE i.status = ?' : ''}
     ORDER BY i.id DESC`
  ).all(...(q.status ? [q.status] : []));
  return rows.map((r) => ({
    ...invRow(r),
    investor_name: r.investor_name,
    investee_name: r.investee_name2 || r.investee_name,
    investee_code: r.investee_code2 || r.investee_code,
    investee_type: r.investee_type
  }));
}

function detail(id) {
  const r = db.prepare('SELECT * FROM equity_investments WHERE id = ?').get(id);
  if (!r) return null;
  const changes = db.prepare('SELECT * FROM equity_investment_changes WHERE investment_id = ? ORDER BY change_date, id').all(id)
    .map((c) => ({ ...c, type_label: CHANGE_TYPE[c.type] || c.type, amount: r2(c.amount) }));
  const co = db.prepare('SELECT name, type FROM companies WHERE id = ?').get(r.company_id) || {};
  const ie = db.prepare('SELECT name, type FROM companies WHERE id = ?').get(r.investee_id) || {};
  return {
    ...invRow(r),
    investor_name: co.name,
    investee_name: ie.name || r.investee_name,
    investee_type: ie.type,
    changes,
    // 成本法下不确认损益调整、分红不动账面 —— 界面上要写清，否则会有人手工改成权益法口径
    method_note: r.method === 'cost'
      ? '成本法：账面价值 = 初始投资成本；子公司分红只确认投资收益，不冲减账面'
      : '权益法：账面价值 = 初始成本 + 累计损益调整 − 累计分红；亏损以账面减至 0 为限'
  };
}

function create(b, operator) {
  const companyId = int0(b.company_id) || 1;
  const investeeId = int0(b.investee_id);
  if (!investeeId) throw new Error('必须选被投企业');
  if (investeeId === companyId) throw new Error('投资方与被投企业不能是同一家');
  const ie = db.prepare('SELECT * FROM companies WHERE id = ?').get(investeeId);
  if (!ie) throw new Error('被投企业不存在');
  if (ie.type === 'branch') {
    throw new Error(`${ie.name} 是分公司（非独立法人），没有股权、不做长期投资抵消，合并时直接并入即可`);
  }
  if (ie.type !== 'subsidiary') {
    throw new Error(`${ie.name} 不是子公司（当前类型 ${ie.type}），只有子公司才做长投抵消`);
  }
  const exist = db.prepare(
    "SELECT inv_no FROM equity_investments WHERE company_id=? AND investee_id=? AND status='active'"
  ).get(companyId, investeeId);
  if (exist) throw new Error(`对 ${ie.name} 已有有效投资记录 ${exist.inv_no}：请改那一条（增持/减持走变动），不要重复建`);

  const cost = r2(b.acquire_cost);
  if (cost <= EPS) throw new Error('初始投资成本必须大于 0（没出钱就不是投资）');
  const pct = r4(b.share_pct);
  if (!(pct > 0 && pct <= 100)) throw new Error('持股比例必须在 0 ~ 100 之间');
  const method = METHOD[b.method] ? b.method : 'cost';
  const acquireDate = b.acquire_date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acquireDate)) throw new Error('取得日格式应为 YYYY-MM-DD');

  const ts = now();
  const no = nextNo('equity_investments', 'inv_no', 'TZ');
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO equity_investments
        (inv_no, company_id, investee_id, investee_code, investee_name, method, acquire_date,
         acquire_cost, share_pct, equity_adjust, dividend_received, book_value, status, note,
         created_by, created_at, updated_at, demo_tag)
       VALUES (?,?,?,?,?,?,?,?,?,0,0,?, 'active', ?,?,?,?,?)`
    ).run(no, companyId, investeeId, ie.code, ie.name, method, acquireDate, cost, pct, cost, b.note || null, operator, ts, ts, b.demo_tag || null);
    const invId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO equity_investment_changes
        (investment_id, change_date, type, amount, share_before, share_after, book_before, book_after, reason, operator, created_at)
       VALUES (?,?, 'increase', ?, 0, ?, 0, ?, ?, ?, ?)`
    ).run(invId, acquireDate, cost, pct, cost, b.note || '初始投资', operator, ts);
    db.exec('COMMIT');
    return detail(invId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 记一笔变动
 * type=equity_share 权益法确认损益（成本法不允许）
 * type=dividend     分红（权益法冲账面，成本法不动账面）
 * type=increase/decrease 增减持（改持股比例与成本）
 */
function addChange(id, b, operator) {
  const inv = db.prepare('SELECT * FROM equity_investments WHERE id = ?').get(id);
  if (!inv) throw new Error('投资记录不存在');
  if (inv.status !== 'active') throw new Error('已处置的投资不能再记变动');
  const type = CHANGE_TYPE[b.type] ? b.type : null;
  if (!type || type === 'dispose') throw new Error('变动类型只能是：权益法确认损益 / 分红 / 增持 / 减持（处置请走处置）');
  const amount = r2(b.amount);
  if (Math.abs(amount) < EPS) throw new Error('金额不能为 0');
  const date = b.change_date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('变动日期格式应为 YYYY-MM-DD');
  const reason = String(b.reason || '').trim();
  if (reason.length < 4) throw new Error('变动必须写原因（≥4 字）');

  const before = { book: bookOf(inv), pct: num(inv.share_pct) };
  let next = { cost: num(inv.acquire_cost), adj: num(inv.equity_adjust), div: num(inv.dividend_received), pct: num(inv.share_pct) };

  if (type === 'equity_share') {
    if (inv.method !== 'equity') throw new Error('成本法不确认投资损益：要用权益法请先把核算方法改成权益法');
    // 亏损以账面减至 0 为限：未确认投资损失要单独提示，不能把长投记成负数
    const room = r2(Math.max(0, next.cost + next.adj - next.div));
    if (amount < 0 && Math.abs(amount) > room + EPS) {
      throw new Error(`本次确认亏损 ${Math.abs(amount)} 超过长投账面 ${room}：` +
        `权益法下以账面减至 0 为限，超出部分为「未确认投资损失」，只能账外备查，不能把长投记成负数`);
    }
    next.adj = r2(next.adj + amount);
  } else if (type === 'dividend') {
    if (amount < 0) throw new Error('分红金额应为正数');
    if (inv.method === 'equity') {
      const room = r2(Math.max(0, next.cost + next.adj - next.div));
      if (amount > room + EPS) throw new Error(`分红 ${amount} 超过长投账面 ${room}：超过部分应确认为投资收益，冲账面只能冲到这个数为限`);
    }
    // 两种方法都要记累计分红（否则界面上看不出收过钱）；
    // 区别在于成本法的账面价值根本不看这一项 —— bookOf 只取 acquire_cost。
    next.div = r2(next.div + amount);
  } else if (type === 'increase' || type === 'decrease') {
    const pct = r4(b.share_pct);
    if (type === 'increase') {
      if (!(pct > before.pct && pct <= 100)) throw new Error(`增持后持股比例应大于 ${before.pct}% 且不超过 100%`);
      if (amount < 0) throw new Error('增持金额应为正数');
      next.cost = r2(next.cost + amount);
      next.pct = pct;
    } else {
      if (!(pct >= 0 && pct < before.pct)) throw new Error(`减持后持股比例应小于 ${before.pct}%`);
      if (amount > 0) throw new Error('减持金额应为正数（冲减投资成本）');
      next.cost = r2(Math.max(0, next.cost + amount));
      next.pct = pct;
    }
  }

  const afterBook = inv.method === 'cost'
    ? r2(next.cost)
    : r2(Math.max(0, next.cost + next.adj - next.div));

  const ts = now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE equity_investments
         SET acquire_cost=?, share_pct=?, equity_adjust=?, dividend_received=?, book_value=?, updated_at=?
       WHERE id=?`
    ).run(next.cost, next.pct, next.adj, next.div, afterBook, ts, id);
    db.prepare(
      `INSERT INTO equity_investment_changes
        (investment_id, change_date, type, amount, share_before, share_after, book_before, book_after, reason, operator, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, date, type, amount, before.pct, next.pct, before.book, afterBook, reason, operator, ts);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return detail(id);
}

function updateMethod(id, method, reason, operator) {
  const inv = db.prepare('SELECT * FROM equity_investments WHERE id = ?').get(id);
  if (!inv) throw new Error('投资记录不存在');
  if (inv.status !== 'active') throw new Error('已处置的投资不能改');
  if (!METHOD[method]) throw new Error('核算方法只能是 cost 成本法 或 equity 权益法');
  if (method === inv.method) throw new Error('核算方法没有变化');
  const rs = String(reason || '').trim();
  if (rs.length < 4) throw new Error('改核算方法必须写原因（≥4 字）');
  const ts = now();
  const book = method === 'cost' ? r2(num(inv.acquire_cost)) : bookOf({ ...inv, method: 'equity' });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE equity_investments SET method=?, book_value=?, updated_at=? WHERE id=?').run(method, book, ts, id);
    db.prepare(
      `INSERT INTO equity_investment_changes
        (investment_id, change_date, type, amount, share_before, share_after, book_before, book_after, reason, operator, created_at)
       VALUES (?,?, 'decrease', 0, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, today(), num(inv.share_pct), num(inv.share_pct), bookOf(inv), book, `改核算方法为${METHOD[method]}：${rs}`, operator, ts);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return detail(id);
}

function dispose(id, reason, operator) {
  const inv = db.prepare('SELECT * FROM equity_investments WHERE id = ?').get(id);
  if (!inv) throw new Error('投资记录不存在');
  if (inv.status !== 'active') throw new Error('这条投资已经处置过了');
  const rs = String(reason || '').trim();
  if (rs.length < 4) throw new Error('处置必须写原因（≥4 字）');
  const ts = now();
  const book = bookOf(inv);
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE equity_investments SET status='disposed', share_pct=0, book_value=0, dispose_date=?, dispose_reason=?, updated_at=? WHERE id=?`
    ).run(today(), rs, ts, id);
    db.prepare(
      `INSERT INTO equity_investment_changes
        (investment_id, change_date, type, amount, share_before, share_after, book_before, book_after, reason, operator, created_at)
       VALUES (?,?, 'dispose', ?, ?, 0, ?, 0, ?, ?, ?)`
    ).run(id, today(), -book, num(inv.share_pct), book, rs, operator, ts);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return detail(id);
}

/**
 * 计算某期间的长期投资抵消（不落库）
 * 返回每个子公司的抵消计算 + 抵消分录 + 对合并表的影响
 */
function computeOffsets(period) {
  if (!/^\d{4}-\d{2}$/.test(String(period))) throw new Error('期间格式必须是 YYYY-MM');
  const invs = db.prepare("SELECT * FROM equity_investments WHERE status='active' ORDER BY id").all();
  const subs = subsidiaries();
  const subIds = new Set(subs.map((s) => s.id));

  const items = [];
  const adjs = [];
  const issues = [];
  let totalAssetAdj = 0;
  let totalEquityAdj = 0;
  let totalGoodwill = 0;
  let totalMinority = 0;
  let totalOffset = 0;
  let totalBargain = 0;

  invs.forEach((inv) => {
    const sub = subs.find((s) => s.id === inv.investee_id);
    if (!sub) {
      issues.push({
        level: 'warn', code: 'not_in_scope', investment: inv.inv_no,
        detail: `被投企业 #${inv.investee_id} 不在合并范围（不是 active 子公司）：这笔长投本期不抵消`
      });
      return;
    }
    const eq = equityOf(period, sub.id);
    const book = bookOf(inv);
    const pct = num(inv.share_pct);
    const share = r2(eq.total * (pct / 100));
    const minority = r2(eq.total - share);
    const goodwill = r2(book - share);            // >0 商誉，<0 负商誉
    const bargain = goodwill < -EPS ? r2(-goodwill) : 0;

    // 净影响：两种情况都严格满足 adj.asset === adj.equity
    const assetAdj = r2(book - Math.max(0, goodwill));
    const equityAdj = r2(eq.total - minority - bargain);

    totalAssetAdj = r2(totalAssetAdj + assetAdj);
    totalEquityAdj = r2(totalEquityAdj + equityAdj);
    totalGoodwill = r2(totalGoodwill + Math.max(0, goodwill));
    totalMinority = r2(totalMinority + minority);
    totalOffset = r2(totalOffset + book);
    totalBargain = r2(totalBargain + bargain);

    items.push({
      investment_id: inv.id, inv_no: inv.inv_no, method: inv.method, method_label: METHOD[inv.method],
      investee_id: sub.id, investee_name: sub.name,
      share_pct: r4(pct), minority_pct: r4(100 - pct),
      book_value: book, equity_total: eq.total, equity_rows: eq.rows,
      share_equity: share, minority_equity: minority,
      goodwill: Math.max(0, goodwill), bargain_gain: bargain,
      asset_adj: assetAdj, equity_adj: equityAdj,
      paid_in: eq.paid_in
    });

    // 抵消分录：借 子公司权益（逐科目）+ 商誉 / 贷 长投 + 少数股东权益
    eq.rows.forEach((e) => {
      if (Math.abs(e.amount) < EPS) return;
      adjs.push({
        type: 'investment', account_code: e.code,
        account_name: `${e.name}（${sub.name}）`,
        debit: r2(e.amount), credit: 0,
        summary: `抵消 ${sub.name} 权益：${e.name} ${r2(e.amount)}（母公司持股 ${r4(pct)}%）`
      });
    });
    if (Math.max(0, goodwill) > EPS) {
      adjs.push({
        type: 'investment', account_code: '1701', account_name: '商誉',
        debit: r2(goodwill), credit: 0,
        summary: `长投 ${book} − 应享权益 ${share}（${r4(pct)}% × ${eq.total}）= 商誉 ${r2(goodwill)}（不摊销，每年做减值测试）`
      });
    }
    adjs.push({
      type: 'investment', account_code: '1511', account_name: `长期股权投资（${sub.name}）`,
      debit: 0, credit: book,
      summary: `抵消母公司对 ${sub.name} 的长期股权投资账面 ${book}（${METHOD[inv.method]}）`
    });
    if (minority > EPS) {
      adjs.push({
        type: 'investment', account_code: '4201', account_name: '少数股东权益',
        debit: 0, credit: minority,
        summary: `${sub.name} 权益 ${eq.total} × 少数股东 ${r4(100 - pct)}% = ${minority}（列在合并权益内，不属于母公司）`
      });
    }
    if (bargain > EPS) {
      adjs.push({
        type: 'investment', account_code: '6301', account_name: '营业外收入（负商誉）',
        debit: 0, credit: bargain,
        summary: `长投 ${book} < 应享权益 ${share}：差额 ${bargain} 作为负商誉计入当期损益（需在附注披露）`
      });
    }

    if (eq.paid_in <= EPS) {
      issues.push({
        level: 'info', code: 'no_paid_in', investment: inv.inv_no,
        detail: `${sub.name} 账上没有实收资本（4001 余额 0）：结构上更像分公司，长投抵消后权益可能对不上，请确认`
      });
    }
  });

  // 有子公司但没建长投记录 → 合并会漏抵，必须提示
  subs.forEach((s) => {
    if (!invs.some((i) => i.investee_id === s.id)) {
      issues.push({
        level: 'block', code: 'missing_investment', investee: s.name,
        detail: `${s.name} 是子公司但没建长期股权投资记录：合并时不会抵消，资产与权益会同时虚增。请补建投资记录`
      });
    }
  });

  // 借贷平衡自检（关键时刻不能只靠信公式）
  const debit = r2(adjs.reduce((s, a) => s + num(a.debit), 0));
  const credit = r2(adjs.reduce((s, a) => s + num(a.credit), 0));
  const balanced = Math.abs(debit - credit) < 0.02;
  if (!balanced) {
    issues.push({
      level: 'block', code: 'unbalanced',
      detail: `抵消分录借贷不平：借 ${debit} / 贷 ${credit}，差 ${r2(debit - credit)}。不出这张合并表`
    });
  }

  return {
    period,
    items,
    adjs,
    issues,
    total: {
      asset_adj: totalAssetAdj,
      equity_adj: totalEquityAdj,
      goodwill: totalGoodwill,
      minority_equity: totalMinority,
      investment_offset: totalOffset,
      bargain_gain: totalBargain,
      debit, credit, balanced
    },
    subsidiaries: subs.map((s) => ({ id: s.id, name: s.name })),
    branches_excluded: branches().map((s) => ({ id: s.id, name: s.name })),
    // 平衡校验：抵消对资产与权益的净影响必须相等，否则「资产=负债+权益」会被打破
    check: {
      asset_eq_equity: Math.abs(totalAssetAdj - totalEquityAdj) < 0.02,
      diff: r2(totalAssetAdj - totalEquityAdj)
    }
  };
}

function dict() {
  return {
    method: METHOD, change_type: CHANGE_TYPE,
    subsidiaries: subsidiaries().map((s) => ({ id: s.id, name: s.name, code: s.code })),
    branches: branches().map((s) => ({ id: s.id, name: s.name, code: s.code })),
    today: today()
  };
}

function board() {
  const rows = list({});
  const active = rows.filter((r) => r.status === 'active');
  return {
    rows,
    stat: {
      count: rows.length,
      active: active.length,
      disposed: rows.filter((r) => r.status === 'disposed').length,
      book_value: r2(active.reduce((s, r) => s + r.book_value, 0)),
      cost: r2(active.reduce((s, r) => s + r.acquire_cost, 0)),
      equity_method: active.filter((r) => r.method === 'equity').length
    }
  };
}

module.exports = {
  EPS, r2, r4, num, today, bookOf,
  subsidiaries, branches, equityOf, list, detail, create, addChange, updateMethod, dispose,
  computeOffsets, dict, board, METHOD, CHANGE_TYPE
};
