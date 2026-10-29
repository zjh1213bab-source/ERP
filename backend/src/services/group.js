/**
 * 多主体核算与合并服务
 * ------------------------------------------------------------
 * 三件事：
 *   1. 主体档案（总部 / 分公司 / 子公司）与账套隔离 —— 每家自己的凭证、期间、关账
 *   2. 内部往来对账 —— A 记「应收 B」、B 记「应付 A」，两边必须相等，不等就是有一边没记或记错
 *   3. 集团合并 —— 各主体简单加总，减掉内部往来与内部交易，差额必须为 0
 *
 * 设计取舍：
 * - **抵消取「两侧较小值」**：A 记 100 应收、B 只记 80 应付，只能抵 80 —— 剩下 20 是「有一方多记」，
 *   留在报表里当差异，不能替人抹平。合并 diff 因此非 0，正好成为强提示。
 * - **长期投资抵消不做自动**：没有股权投资关系数据，硬抵会抵错。本期只做「内部往来 + 内部交易」，
 *   长期投资与未实现利润留手工抵消分录（`source='manual'`）。
 * - **合并只出资产负债表 + 利润表**：合并现金流量表需要按对手方拆经营/投资/筹资，规则复杂度远超收益。
 */
const { db } = require('../db');
const { localNow } = require('./sla');
const G = require('./gl');
const IV = require('./investment');   // 长期投资抵消

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const TYPE_CN = { headquarters: '总部', branch: '分公司', subsidiary: '子公司' };
const CO_STATUS = { active: '启用', closed: '已注销' };

/** ==================== 主体 ==================== */

function listCompanies(opt = {}) {
  /**
   * 单公司模式：只返回唯一抬头那一条。
   *
   * 接口**不删不禁**（用户选了「隐藏入口、接口保留」）—— 页面入口收起来，
   * 但万一有人直接调接口或以后要把集团模块打开，这里仍能工作。
   * 只做一件事：让它只吐出一家公司，避免"明明只有一家公司在用，
   * 页面上却列出 4 个法人主体"这种自相矛盾的画面。
   *
   * 历史那几条记录**不删**：它们的 id 还挂在历史单据的 company_id 上，
   * 删掉会让报表 join 不到名字，变成"主体#2"这种看不懂的东西。
   */
  const scope = require('../access/companyScope');
  if (scope.isSingle()) {
    const head = scope.header();
    const wh = ['c.id = ?'];
    const args = [Number(head.id) || 1];
    if (opt.status && opt.status !== 'all') { wh.push('c.status=?'); args.push(opt.status); }
    return db.prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM gl_vouchers v WHERE v.company_id=c.id AND v.status='posted') AS voucher_count,
         (SELECT COUNT(*) FROM gl_periods p WHERE p.company_id=c.id AND p.status='closed') AS closed_periods,
         (SELECT COUNT(*) FROM departments d WHERE d.company_id=c.id) AS dept_count,
         (SELECT COUNT(*) FROM users u WHERE u.company_id=c.id AND COALESCE(u.active,1)=1) AS user_count
       FROM companies c WHERE ` + wh.join(' AND ')
    ).all(...args).map((r) => ({
      ...r,
      type_label: TYPE_CN[r.type] || r.type,
      status_label: CO_STATUS[r.status] || r.status,
      consolidation_label: r.consolidation ? '纳入合并' : '不合并'
    }));
  }
  const wh = [];
  const args = [];
  if (opt.status && opt.status !== 'all') { wh.push('c.status=?'); args.push(opt.status); }
  const rows = db.prepare(
    `SELECT c.*,
       (SELECT COUNT(*) FROM gl_vouchers v WHERE v.company_id=c.id AND v.status='posted') AS voucher_count,
       (SELECT COUNT(*) FROM gl_periods p WHERE p.company_id=c.id AND p.status='closed') AS closed_periods,
       (SELECT COUNT(*) FROM departments d WHERE d.company_id=c.id) AS dept_count,
       (SELECT COUNT(*) FROM users u WHERE u.company_id=c.id AND COALESCE(u.active,1)=1) AS user_count
     FROM companies c ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY (CASE WHEN c.type='headquarters' THEN 0 ELSE 1 END), c.id`
  ).all(...args);
  return rows.map((r) => ({
    ...r,
    type_label: TYPE_CN[r.type] || r.type,
    status_label: CO_STATUS[r.status] || r.status,
    consolidation_label: r.consolidation ? '纳入合并' : '不合并'
  }));
}

function getCompany(id) {
  const c = db.prepare('SELECT * FROM companies WHERE id=?').get(Number(id));
  if (!c) return null;
  return { ...c, type_label: TYPE_CN[c.type] || c.type, status_label: CO_STATUS[c.status] || c.status };
}

function createCompany(b = {}, operator) {
  const code = String(b.code || '').trim().toUpperCase();
  const name = String(b.name || '').trim();
  if (!/^[A-Z0-9_-]{2,16}$/.test(code)) throw new Error('主体编码必须是 2-16 位字母数字（大写）');
  if (name.length < 2) throw new Error('主体名称至少 2 个字');
  if (db.prepare('SELECT id FROM companies WHERE code=?').get(code)) throw new Error(`主体编码 ${code} 已存在`);

  const type = String(b.type || 'branch');
  if (!TYPE_CN[type]) throw new Error('主体类型只能是 总部 / 分公司 / 子公司');

  // 总部只能有一个：再建总部会让人分不清哪套账是集团的
  if (type === 'headquarters' && db.prepare("SELECT id FROM companies WHERE type='headquarters'").get()) {
    throw new Error('已经有总部了，一家集团只能有一个总部主体');
  }

  const parentId = b.parent_id ? Number(b.parent_id) : null;
  if (parentId && !db.prepare('SELECT id FROM companies WHERE id=?').get(parentId)) {
    throw new Error('上级主体不存在');
  }

  const t = localNow();
  const id = db.prepare(
    `INSERT INTO companies (code,name,short_name,type,tax_no,legal_person,base_currency,consolidation,
       parent_id,open_period,status,addr,phone,remark,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(code, name, b.short_name || null, type, b.tax_no || null, b.legal_person || null,
    b.base_currency || 'CNY', b.consolidation === false || b.consolidation === 0 ? 0 : 1,
    parentId, b.open_period || null, 'active', b.addr || null, b.phone || null, b.remark || null, t, t)
    .lastInsertRowid;

  // 新主体立刻建账套启用期间：不建的话第一次生成凭证会报「期间不存在」
  if (b.open_period) {
    try { G.ensurePeriod(String(b.open_period).slice(0, 7), id); } catch (e) { /* 期间格式不对就跳过 */ }
  }
  return getCompany(id);
}

function updateCompany(id, b = {}) {
  const c = db.prepare('SELECT * FROM companies WHERE id=?').get(Number(id));
  if (!c) throw new Error('主体不存在');

  const next = {
    name: b.name !== undefined ? String(b.name).trim() : c.name,
    short_name: b.short_name !== undefined ? b.short_name || null : c.short_name,
    tax_no: b.tax_no !== undefined ? b.tax_no || null : c.tax_no,
    legal_person: b.legal_person !== undefined ? b.legal_person || null : c.legal_person,
    base_currency: b.base_currency || c.base_currency,
    addr: b.addr !== undefined ? b.addr || null : c.addr,
    phone: b.phone !== undefined ? b.phone || null : c.phone,
    remark: b.remark !== undefined ? b.remark || null : c.remark
  };
  if (next.name.length < 2) throw new Error('主体名称至少 2 个字');

  if (b.type !== undefined && b.type !== c.type) {
    if (!TYPE_CN[b.type]) throw new Error('主体类型只能是 总部 / 分公司 / 子公司');
    if (b.type === 'headquarters' && db.prepare("SELECT id FROM companies WHERE type='headquarters' AND id<>?").get(c.id)) {
      throw new Error('已经有总部了');
    }
  }
  if (b.consolidation !== undefined) {
    next.consolidation = b.consolidation === false || b.consolidation === 0 ? 0 : 1;
  }
  if (b.status !== undefined && b.status !== c.status) {
    if (!CO_STATUS[b.status]) throw new Error('状态只能是 启用 / 已注销');
    // 已注销前必须把账关完：还开着期间说明账还没做完
    if (b.status === 'closed') {
      const openP = db.prepare("SELECT COUNT(*) c FROM gl_periods WHERE company_id=? AND status='open'").get(c.id).c;
      if (openP) throw new Error(`还有 ${openP} 个期间未关账，先关账再注销主体`);
    }
  }
  if (b.parent_id !== undefined) {
    const pid = b.parent_id ? Number(b.parent_id) : null;
    if (pid === c.id) throw new Error('上级主体不能是自己');
    if (pid && !db.prepare('SELECT id FROM companies WHERE id=?').get(pid)) throw new Error('上级主体不存在');
    next.parent_id = pid;
  }

  db.prepare(
    `UPDATE companies SET name=?,short_name=?,tax_no=?,legal_person=?,base_currency=?,addr=?,phone=?,remark=?,
       type=?, consolidation=?, status=?, parent_id=?, updated_at=? WHERE id=?`
  ).run(next.name, next.short_name, next.tax_no, next.legal_person, next.base_currency, next.addr, next.phone,
    next.remark, b.type !== undefined ? b.type : c.type,
    next.consolidation !== undefined ? next.consolidation : c.consolidation,
    b.status !== undefined ? b.status : c.status,
    next.parent_id !== undefined ? next.parent_id : c.parent_id,
    localNow(), c.id);
  return getCompany(c.id);
}

/** 合并范围：启用且标记纳入合并的主体 */
function scopeCompanies() {
  return db.prepare(
    "SELECT * FROM companies WHERE status='active' AND COALESCE(consolidation,1)=1 ORDER BY (CASE WHEN type='headquarters' THEN 0 ELSE 1 END), id"
  ).all();
}

/** ==================== 内部往来单位 ==================== */

function listParties(companyId) {
  const wh = [];
  const args = [];
  if (companyId) { wh.push('p.company_id=?'); args.push(Number(companyId)); }
  return db.prepare(
    `SELECT p.*, c.name AS company_name, cc.name AS counter_company_name
     FROM intercompany_parties p
     LEFT JOIN companies c ON c.id=p.company_id
     LEFT JOIN companies cc ON cc.id=p.counter_company_id
     ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
     ORDER BY p.company_id, p.id`
  ).all(...args);
}

function createParty(b = {}) {
  const companyId = Number(b.company_id) || G.defaultCompany();
  const counterId = Number(b.counter_company_id);
  const refName = String(b.ref_name || '').trim();
  if (!db.prepare('SELECT id FROM companies WHERE id=?').get(companyId)) throw new Error('本方主体不存在');
  if (!db.prepare('SELECT id FROM companies WHERE id=?').get(counterId)) throw new Error('对方主体不存在');
  // 自己对自己不是「内部往来」，是错账
  if (companyId === counterId) throw new Error('对方主体不能是本方');
  if (refName.length < 2) throw new Error('对方名称至少 2 个字');
  if (db.prepare('SELECT id FROM intercompany_parties WHERE company_id=? AND ref_name=?').get(companyId, refName)) {
    throw new Error(`「${refName}」已经登记过了`);
  }
  const kind = String(b.kind || 'both');
  if (!['customer', 'supplier', 'both'].includes(kind)) throw new Error('往来类型只能是 客户 / 供应商 / 两者');

  const id = db.prepare(
    `INSERT INTO intercompany_parties (company_id,counter_company_id,kind,ref_type,ref_id,ref_name,match_key,
       offset_account,status,note,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(companyId, counterId, kind, b.ref_type || null, b.ref_id ? Number(b.ref_id) : null, refName,
    b.match_key || refName, b.offset_account || (kind === 'supplier' ? '2202' : '1122'),
    'active', b.note || null, localNow()).lastInsertRowid;
  return db.prepare('SELECT * FROM intercompany_parties WHERE id=?').get(id);
}

function updateParty(id, b = {}) {
  const p = db.prepare('SELECT * FROM intercompany_parties WHERE id=?').get(Number(id));
  if (!p) throw new Error('内部往来单位不存在');
  const status = b.status || p.status;
  if (!['active', 'disabled'].includes(status)) throw new Error('状态只能是 启用 / 停用');
  db.prepare(
    'UPDATE intercompany_parties SET kind=?, match_key=?, offset_account=?, status=?, note=? WHERE id=?'
  ).run(b.kind || p.kind, b.match_key !== undefined ? b.match_key : p.match_key,
    b.offset_account || p.offset_account, status,
    b.note !== undefined ? b.note : p.note, p.id);
  return db.prepare('SELECT * FROM intercompany_parties WHERE id=?').get(p.id);
}

/** ==================== 内部往来对账 ==================== */

/**
 * 扫一个期间的内部往来并配对
 * 口径：
 *   A 主体账上，partner 命中「A 登记的内部客户」→ 1122 借方净额 = A 对 B 的债权
 *   B 主体账上，partner 命中「B 登记的内部供应商」→ 2202 贷方净额 = B 对 A 的债务
 *   两边应相等；不等记 diff（正数=债权方多记，负数=债务方多记）
 */
function scanIntercompany(period, operator) {
  const parties = db.prepare("SELECT * FROM intercompany_parties WHERE status='active'").all();
  if (!parties.length) return { pairs: 0, matched: 0, diff: 0, links: [] };

  // 按 (本方, 对方) 聚合出双方各自的名称集合
  const byPair = {};
  parties.forEach((p) => {
    const k = `${p.company_id}>${p.counter_company_id}`;
    if (!byPair[k]) byPair[k] = { company: p.company_id, counter: p.counter_company_id, names: new Set(), accounts: new Set() };
    byPair[k].names.add(String(p.match_key || p.ref_name));
    byPair[k].names.add(String(p.ref_name));
    byPair[k].accounts.add(p.offset_account || '1122');
  });

  // 同一对公司只算一次（取 company < counter 的方向）
  const pairs = [];
  const seen = new Set();
  Object.values(byPair).forEach((v) => {
    const key = [v.company, v.counter].sort((a, b) => a - b).join('-');
    if (seen.has(key)) return;
    seen.add(key);
    const a = byPair[`${v.company}>${v.counter}`];
    const b = byPair[`${v.counter}>${v.company}`];
    pairs.push({ A: v.company, B: v.counter, aNames: a ? [...a.names] : [], bNames: b ? [...b.names] : [] });
  });

  const { start, end } = G.periodRange(period);
  const links = [];
  const t = localNow();

  // 先清掉本期自动生成的旧记录，重跑不叠加（手工配对的不动）
  db.prepare("DELETE FROM intercompany_links WHERE period=? AND created_by='auto'").run(period);

  pairs.forEach((pair) => {
    // A 对 B 的债权：A 公司 1122 科目上、对方名称命中 aNames 的借方净额
    const aRows = pair.aNames.length
      ? db.prepare(
          `SELECT COALESCE(SUM(e.debit-e.credit),0) s FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
           WHERE v.status='posted' AND e.company_id=? AND e.period=? AND e.account_code IN ('1122','1221')
             AND e.partner_name IN (${pair.aNames.map(() => '?').join(',')})`
        ).get(pair.A, period, ...pair.aNames).s
      : 0;
    // B 对 A 的债务：B 公司 2202 科目上、对方名称命中 bNames 的贷方净额
    const bRows = pair.bNames.length
      ? db.prepare(
          `SELECT COALESCE(SUM(e.credit-e.debit),0) s FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
           WHERE v.status='posted' AND e.company_id=? AND e.period=? AND e.account_code IN ('2202','2241')
             AND e.partner_name IN (${pair.bNames.map(() => '?').join(',')})`
        ).get(pair.B, period, ...pair.bNames).s
      : 0;

    const fromAmt = r2(num(aRows));
    const toAmt = r2(num(bRows));
    // 两边都是 0 说明本期没有往来，不必生成噪音记录
    if (Math.abs(fromAmt) < 0.01 && Math.abs(toAmt) < 0.01) return;

    const diff = r2(fromAmt - toAmt);
    const status = Math.abs(diff) < 0.01 ? 'matched' : 'diff';
    db.prepare(
      `INSERT INTO intercompany_links (period,type,from_company_id,to_company_id,from_amount,to_amount,diff_amount,
         currency,status,note,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(period, 'balance', pair.A, pair.B, fromAmt, toAmt, diff, 'CNY', status,
      status === 'diff' ? '两侧金额不一致，需核对是哪一方漏记或多记' : null, 'auto', t);

    links.push({ from: pair.A, to: pair.B, from_amount: fromAmt, to_amount: toAmt, diff, status });
  });

  return {
    period,
    pairs: pairs.length,
    matched: links.filter((l) => l.status === 'matched').length,
    diff: links.filter((l) => l.status === 'diff').length,
    diff_amount: r2(links.reduce((a, l) => a + Math.abs(l.diff), 0)),
    links
  };
}

function listLinks(period, opt = {}) {
  const wh = ['l.period=?'];
  const args = [period];
  if (opt.status && opt.status !== 'all') { wh.push('l.status=?'); args.push(opt.status); }
  return db.prepare(
    `SELECT l.*, cf.name AS from_company_name, ct.name AS to_company_name
     FROM intercompany_links l
     LEFT JOIN companies cf ON cf.id=l.from_company_id
     LEFT JOIN companies ct ON ct.id=l.to_company_id
     WHERE ${wh.join(' AND ')} ORDER BY l.status DESC, l.id`
  ).all(...args).map((r) => ({
    ...r,
    type_label: r.type === 'balance' ? '内部往来' : r.type === 'txn' ? '内部交易' : '长期投资',
    status_label: r.status === 'matched' ? '已平' : r.status === 'diff' ? '有差异' : r.status === 'ignored' ? '已忽略' : '未配对'
  }));
}

/** 手工忽略一笔内部往来差异（要有理由） */
function ignoreLink(id, reason, operator) {
  const l = db.prepare('SELECT * FROM intercompany_links WHERE id=?').get(Number(id));
  if (!l) throw new Error('内部往来记录不存在');
  if (l.status === 'matched') throw new Error('这笔两侧已经相等，不需要忽略');
  if (String(reason || '').trim().length < 4) throw new Error('忽略必须写理由（至少 4 个字）');
  db.prepare("UPDATE intercompany_links SET status='ignored', note=? WHERE id=?").run(reason, l.id);
  return { id: l.id, status: 'ignored' };
}

/** ==================== 合并 ==================== */

/**
 * 生成合并报表
 * 抵消逻辑：
 *   1. 内部往来：取两侧较小值抵消，资产端 1122 与负债端 2202 各减同一金额
 *   2. 内部交易：A 确认的收入（6001 贷方）与 B 确认的成本（6401 借方）取小抵消
 *   3. 差额不抹平：留在 diff_amount 里，作为「内部往来不平」的强提示
 */
function buildConsolidation(period, operator) {
  const companies = scopeCompanies();
  if (!companies.length) throw new Error('没有纳入合并范围的主体');
  if (!/^\d{4}-\d{2}$/.test(String(period))) throw new Error('期间格式必须是 YYYY-MM');

  const sum = { asset: 0, liability: 0, equity: 0, income: 0, expense: 0 };
  const detail = [];
  companies.forEach((c) => {
    const bs = G.balanceSheet(period, c.id);
    const is = G.incomeStatement(period, c.id);
    sum.asset = r2(sum.asset + bs.asset_total);
    sum.liability = r2(sum.liability + bs.liability_total);
    sum.equity = r2(sum.equity + bs.equity_total);
    sum.income = r2(sum.income + is.income_total);
    sum.expense = r2(sum.expense + is.expense_total);
    detail.push({
      company_id: c.id, company_name: c.name, type: c.type,
      asset: bs.asset_total, liability: bs.liability_total, equity: bs.equity_total,
      income: is.income_total, expense: is.expense_total, net: is.net_profit,
      balanced: bs.balanced
    });
  });

  // ---- 抵消 1：内部往来 ----
  const links = listLinks(period).filter((l) => l.status !== 'ignored');
  let icOffset = 0;
  let icDiffCnt = 0;
  const adjs = [];
  links.forEach((l) => {
    const offset = r2(Math.min(Math.abs(num(l.from_amount)), Math.abs(num(l.to_amount))));
    if (offset > 0.01) icOffset = r2(icOffset + offset);
    if (Math.abs(num(l.diff_amount)) > 0.01) icDiffCnt += 1;
  });
  if (icOffset > 0.01) {
    adjs.push({
      type: 'ic_balance', account_code: '1122', account_name: '应收账款（内部）',
      debit: 0, credit: icOffset, summary: `抵消内部往来债权 ${icOffset}`
    });
    adjs.push({
      type: 'ic_balance', account_code: '2202', account_name: '应付账款（内部）',
      debit: icOffset, credit: 0, summary: `抵消内部往来债务 ${icOffset}`
    });
  }

  // ---- 抵消 2：内部交易（A 的收入 vs B 的成本）----
  const parties = db.prepare("SELECT * FROM intercompany_parties WHERE status='active'").all();
  let txnIncome = 0;
  let txnCost = 0;
  // 记下实际命中的科目：抵消分录要写真实的科目，不能一律写成 6401
  const incAccts = {};
  const costAccts = {};
  if (parties.length) {
    const namesByCompany = {};
    parties.forEach((p) => {
      if (!namesByCompany[p.company_id]) namesByCompany[p.company_id] = new Set();
      namesByCompany[p.company_id].add(String(p.match_key || p.ref_name));
      namesByCompany[p.company_id].add(String(p.ref_name));
    });
    companies.forEach((c) => {
      const names = namesByCompany[c.id] ? [...namesByCompany[c.id]] : [];
      if (!names.length) return;
      const ph = names.map(() => '?').join(',');
      // 内部销售收入：6001 主营 / 6051 其他业务
      const inc = db.prepare(
        `SELECT COALESCE(SUM(e.credit-e.debit),0) s FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
         WHERE v.status='posted' AND e.company_id=? AND e.period=? AND e.account_code IN ('6001','6051')
           AND e.partner_name IN (${ph})`
      ).get(c.id, period, ...names).s;
      // 内部采购的落点：1403 原材料 / 1405 库存商品 / 6401 主营业务成本 / 6602 费用
      // （没有采购单的应付发票会走 6602，那是既有口径，合并时一并抵掉，否则对方收入抵了这边成本没抵）
      const cst = db.prepare(
        `SELECT COALESCE(SUM(e.debit-e.credit),0) s FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
         WHERE v.status='posted' AND e.company_id=? AND e.period=? AND e.account_code IN ('1403','1405','6401','6602')
           AND e.partner_name IN (${ph})`
      ).get(c.id, period, ...names).s;
      txnIncome = r2(txnIncome + num(inc));
      txnCost = r2(txnCost + num(cst));
      if (num(inc) > 0.01) {
        db.prepare(
          `SELECT e.account_code, a.name, COALESCE(SUM(e.credit-e.debit),0) s
           FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
           LEFT JOIN gl_accounts a ON a.code=e.account_code
           WHERE v.status='posted' AND e.company_id=? AND e.period=? AND e.account_code IN ('6001','6051')
             AND e.partner_name IN (${ph}) GROUP BY e.account_code`
        ).all(c.id, period, ...names).forEach((x) => {
          const k = `${x.account_code}|${x.name || ''}`;
          incAccts[k] = r2(num(incAccts[k]) + num(x.s));
        });
      }
      if (num(cst) > 0.01) {
        db.prepare(
          `SELECT e.account_code, a.name, COALESCE(SUM(e.debit-e.credit),0) s
           FROM gl_entries e JOIN gl_vouchers v ON v.id=e.voucher_id
           LEFT JOIN gl_accounts a ON a.code=e.account_code
           WHERE v.status='posted' AND e.company_id=? AND e.period=? AND e.account_code IN ('1403','1405','6401','6602')
             AND e.partner_name IN (${ph}) GROUP BY e.account_code`
        ).all(c.id, period, ...names).forEach((x) => {
          const k = `${x.account_code}|${x.name || ''}`;
          costAccts[k] = r2(num(costAccts[k]) + num(x.s));
        });
      }
    });
  }
  const txnOffset = r2(Math.min(txnIncome, txnCost));
  if (txnOffset > 0.01) {
    const pickBig = (obj, fallback) => {
      const list = Object.entries(obj).sort((a, b) => b[1] - a[1]);
      if (!list.length) return { code: fallback, name: fallback };
      const [k] = list[0];
      const [code, name] = k.split('|');
      return { code, name: name || code, extra: list.slice(1) };
    };
    const incTop = pickBig(incAccts, '6001');
    const costTop = pickBig(costAccts, '6401');

    adjs.push({
      type: 'ic_txn', account_code: incTop.code, account_name: `${incTop.name}（内部销售）`,
      debit: txnOffset, credit: 0,
      summary: `抵消内部销售收入：销售方确认 ${txnIncome}，采购方计入 ${txnCost}，按较小值抵消 ${txnOffset}` +
        (incTop.extra && incTop.extra.length ? `（另有 ${incTop.extra.map((x) => x[0].split('|')[0] + ' ' + x[1]).join('、')}）` : '')
    });
    adjs.push({
      type: 'ic_txn', account_code: costTop.code, account_name: `${costTop.name}（内部采购）`,
      debit: 0, credit: txnOffset,
      summary: `抵消内部采购：实际计入 ${costTop.code} ${costTop.name} ${txnCost}` +
        (costTop.extra && costTop.extra.length ? `（另有 ${costTop.extra.map((x) => x[0].split('|')[0] + ' ' + x[1]).join('、')}）` : '')
    });
  }

  // ---- 抵消 3：长期投资 vs 子公司权益 ----
  // 只有**子公司**才抵（独立法人、有股权）；分公司直接并入、不抵消。
  // 差额是商誉（或负商誉），非全资还要确认少数股东权益。
  const inv = IV.computeOffsets(period);
  inv.adjs.forEach((a) => adjs.push(a));
  inv.issues.filter((x) => x.level === 'block').forEach((x) => {
    throw new Error(`长期投资抵消无法完成：${x.detail}`);
  });

  // ---- 合并后 ----
  // 长投抵消对资产与权益的净影响恒等（adj.asset === adj.equity），
  // 所以「资产 = 负债 + 权益」在抵消后依然成立，不是两边一起虚增的假平衡。
  const adj = {
    asset: r2(icOffset + inv.total.asset_adj),
    liability: icOffset,
    equity: r2(inv.total.equity_adj),
    // 负商誉计入营业外收入：只影响损益，不影响上面的平衡式
    income: r2(txnOffset - inv.total.bargain_gain),
    expense: txnOffset
  };
  const assetTotal = r2(sum.asset - adj.asset);
  const liabilityTotal = r2(sum.liability - adj.liability);
  const equityTotal = r2(sum.equity - adj.equity);
  const incomeTotal = r2(sum.income - adj.income);
  const expenseTotal = r2(sum.expense - adj.expense);
  const diff = r2(assetTotal - liabilityTotal - equityTotal);

  const t = localNow();
  const ym = String(period).replace('-', '');
  // 序号要保证唯一：删过草稿后 COUNT 会退回去重号，用「找到第一个没被占的」
  let seq = 1;
  let conNo = '';
  do {
    conNo = `HB${ym}${String(seq).padStart(4, '0')}`;
    seq += 1;
  } while (db.prepare('SELECT id FROM consolidations WHERE con_no=?').get(conNo));

  const conId = db.prepare(
    `INSERT INTO consolidations (con_no,period,company_count,currency,sum_asset,sum_liability,sum_equity,
       sum_income,sum_expense,adj_asset,adj_liability,adj_equity,adj_income,adj_expense,
       asset_total,liability_total,equity_total,income_total,expense_total,net_profit,diff_amount,
       ic_diff_cnt,status,created_by,created_at,
       goodwill,minority_equity,investment_offset,bargain_gain)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(conNo, period, companies.length, 'CNY', sum.asset, sum.liability, sum.equity, sum.income, sum.expense,
    adj.asset, adj.liability, adj.equity, adj.income, adj.expense,
    assetTotal, liabilityTotal, equityTotal, incomeTotal, expenseTotal,
    r2(incomeTotal - expenseTotal), diff, icDiffCnt, 'draft', operator || 'system', t,
    inv.total.goodwill, inv.total.minority_equity, inv.total.investment_offset, inv.total.bargain_gain).lastInsertRowid;

  const insAdj = db.prepare(
    `INSERT INTO consolidation_adjustments (con_id,period,type,company_id,account_code,account_name,
       debit,credit,counterpart_company_id,summary,source,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  adjs.forEach((a) => {
    insAdj.run(conId, period, a.type, null, a.account_code, a.account_name,
      r2(a.debit), r2(a.credit), null, a.summary, 'auto', t);
  });

  return {
    id: conId, con_no: conNo, period,
    company_count: companies.length,
    sum, adj, detail,
    asset_total: assetTotal, liability_total: liabilityTotal, equity_total: equityTotal,
    income_total: incomeTotal, expense_total: expenseTotal,
    net_profit: r2(incomeTotal - expenseTotal),
    diff_amount: diff,
    balanced: Math.abs(diff) < 0.01,
    ic_diff_cnt: icDiffCnt,
    // 长投抵消的三个关键数（生成即返回，免得前端再查一次详情）
    goodwill: inv.total.goodwill,
    minority_equity: inv.total.minority_equity,
    investment_offset: inv.total.investment_offset,
    bargain_gain: inv.total.bargain_gain,
    // 长期投资抵消结果：商誉 / 少数股东权益 / 长投抵消额 / 负商誉
    investment: {
      total: inv.total,
      items: inv.items,
      issues: inv.issues,
      check: inv.check,
      branches_excluded: inv.branches_excluded
    },
    adjustments: adjs
  };
}

function getConsolidation(id) {
  const c = db.prepare('SELECT * FROM consolidations WHERE id=?').get(Number(id));
  if (!c) return null;
  const adjs = db.prepare('SELECT * FROM consolidation_adjustments WHERE con_id=? ORDER BY id').all(c.id);
  return {
    ...c,
    status_label: c.status === 'confirmed' ? '已确认' : '草稿',
    balanced: Math.abs(num(c.diff_amount)) < 0.01,
    adjustments: adjs.map((a) => ({
      ...a,
      type_label: a.type === 'ic_balance' ? '内部往来' : a.type === 'ic_txn' ? '内部交易' : a.type === 'investment' ? '长期投资' : '未实现利润'
    }))
  };
}

function listConsolidations(limit = 20) {
  return db.prepare('SELECT * FROM consolidations ORDER BY period DESC, id DESC LIMIT ?').all(Number(limit) || 20)
    .map((c) => ({
      ...c,
      status_label: c.status === 'confirmed' ? '已确认' : '草稿',
      balanced: Math.abs(num(c.diff_amount)) < 0.01
    }));
}

/** 确认合并：差额不为 0 不许确认（不然「合并完了差的 5000」永远没人管） */
function confirmConsolidation(id, operator) {
  const c = db.prepare('SELECT * FROM consolidations WHERE id=?').get(Number(id));
  if (!c) throw new Error('合并批次不存在');
  if (c.status === 'confirmed') throw new Error('这一批已经确认过了');
  if (Math.abs(num(c.diff_amount)) > 0.01) {
    throw new Error(
      `合并后资产与负债权益差 ${r2(c.diff_amount)}，不能确认。` +
      `常见原因：内部往来两侧金额不一致（本期 ${c.ic_diff_cnt} 笔）、有一方没把内部交易入账。` +
      `请到「内部往来」页核对后再合并。`
    );
  }
  db.prepare("UPDATE consolidations SET status='confirmed', confirmed_by=?, confirmed_at=? WHERE id=?")
    .run(operator || 'system', localNow(), c.id);
  return { id: c.id, status: 'confirmed' };
}

/** 删除草稿合并（重跑前清理） */
function deleteConsolidation(id) {
  const c = db.prepare('SELECT * FROM consolidations WHERE id=?').get(Number(id));
  if (!c) throw new Error('合并批次不存在');
  if (c.status === 'confirmed') throw new Error('已确认的合并不能删除');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM consolidation_adjustments WHERE con_id=?').run(c.id);
    db.prepare('DELETE FROM consolidations WHERE id=?').run(c.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { deleted: 1 };
}

/** ==================== 分部对比 ==================== */

/** 一张表看各主体的规模与盈利，用于「哪家分公司在拖后腿」 */
function segmentCompare(period) {
  const companies = listCompanies({ status: 'active' });
  const rows = companies.map((c) => {
    const bs = G.balanceSheet(period, c.id);
    const is = G.incomeStatement(period, c.id);
    const cf = G.cashFlow(period, c.id);
    const p = db.prepare('SELECT * FROM gl_periods WHERE company_id=? AND period=?').get(c.id, period);
    return {
      company_id: c.id, code: c.code, name: c.name, short_name: c.short_name,
      type: c.type, type_label: c.type_label, consolidation: c.consolidation,
      asset: bs.asset_total, liability: bs.liability_total, equity: bs.equity_total,
      cash: cf.closing_cash, ar: bs.assets.find((a) => a.code === '1122')?.amount || 0,
      ap: bs.liabilities.find((a) => a.code === '2202')?.amount || 0,
      income: is.income_total, expense: is.expense_total, net: is.net_profit,
      net_margin: is.income_total > 0 ? r2((is.net_profit / is.income_total) * 100) : null,
      period_status: p?.status || 'open',
      period_status_label: p?.status === 'closed' ? '已关账' : '未关账'
    };
  });
  const t = (k) => r2(rows.reduce((a, r) => a + num(r[k]), 0));
  return {
    period,
    rows,
    total: {
      asset: t('asset'), liability: t('liability'), equity: t('equity'),
      cash: t('cash'), income: t('income'), expense: t('expense'), net: t('net')
    }
  };
}

/** 总览：主体数、合并状态、内部往来差异 */
function overview() {
  const companies = listCompanies({});
  const active = companies.filter((c) => c.status === 'active');
  const inScope = active.filter((c) => c.consolidation);
  const period = require('./sla').localDate().slice(0, 7);
  // 差异按「最近一个有差异的期间」统计：只看当月的话，上个月没平的那笔永远不会提示
  const lastDiff = db.prepare(
    "SELECT period FROM intercompany_links WHERE status='diff' ORDER BY period DESC LIMIT 1"
  ).get();
  const diffPeriod = lastDiff ? lastDiff.period : period;
  const diffLinks = db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(ABS(diff_amount)),0) s FROM intercompany_links WHERE period=? AND status='diff'"
  ).get(diffPeriod);
  const lastCon = db.prepare('SELECT * FROM consolidations ORDER BY id DESC LIMIT 1').get();
  return {
    company_count: companies.length,
    active_count: active.length,
    scope_count: inScope.length,
    by_type: ['headquarters', 'branch', 'subsidiary'].map((t) => ({
      type: t, label: TYPE_CN[t], count: companies.filter((c) => c.type === t).length
    })),
    period,
    ic_party_count: db.prepare("SELECT COUNT(*) c FROM intercompany_parties WHERE status='active'").get().c,
    ic_diff_count: diffLinks.c,
    ic_diff_amount: r2(diffLinks.s),
    ic_diff_period: diffLinks.c ? diffPeriod : null,
    last_consolidation: lastCon ? {
      id: lastCon.id, con_no: lastCon.con_no, period: lastCon.period,
      status: lastCon.status, status_label: lastCon.status === 'confirmed' ? '已确认' : '草稿',
      diff_amount: lastCon.diff_amount, company_count: lastCon.company_count
    } : null,
    companies: companies.map((c) => ({
      id: c.id, code: c.code, name: c.name, type_label: c.type_label,
      status: c.status, consolidation: c.consolidation, voucher_count: c.voucher_count
    }))
  };
}

module.exports = {
  TYPE_CN, CO_STATUS,
  listCompanies, getCompany, createCompany, updateCompany, scopeCompanies,
  listParties, createParty, updateParty,
  scanIntercompany, listLinks, ignoreLink,
  buildConsolidation, getConsolidation, listConsolidations, confirmConsolidation, deleteConsolidation,
  segmentCompare, overview
};
