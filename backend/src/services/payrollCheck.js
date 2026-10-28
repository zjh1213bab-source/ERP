/**
 * 薪酬计件与工资核对（TS-N13-05）
 * ========================================================================
 * 一句话：**工资单里那个计件数，能不能对回已确认的核算单**。
 *
 * 计件带进工资这一步早就有了（`payrolls/generate` 读 `confirmedByEmployee`），
 * 但带进去之后没人回头核。实际会发生四件事，每一件都是钱：
 *   1. 工资单生成后计件被作废重算 → 工资单里还是旧金额；
 *   2. 有人手工改了 `piece_wage` / `base_salary`，应发个税没重算；
 *   3. 调整单做了但没带进这一期；
 *   4. 境外主体套了国内 5000 免征额与月度税率表。
 *
 * 所以这里做三件事：**重算、比对、把差异落到调整单**。不直接改工资单。
 *
 * ## 六条口径
 * 1. 计件只认 `status='confirmed'` 的核算单；草稿是试算、作废的是不要的。
 *    同期间出现两个 confirmed 批次（历史数据/并发）→ 整批标红，不挑一个先用。
 * 2. 应发/个税/实发用 `services/payrollCalc.js` **独立重算**再和库里存的比。
 *    若直接读库里的应发，手工改过的单子永远「没问题」——核对就成了打印件。
 * 3. 差额**不自动改工资单**：要动钱必须走 `payroll_adjustments`（下一期生效）并写原因。
 *    直接 UPDATE 已确认的工资单，事后没人认这笔改动。
 * 4. 境外主体（本位币非 CNY）标「政策待配」，只做金额展示与来源核对，
 *    不判断个税社保 —— 默认套国内税率算出来的差额是假的。
 * 5. 本期 `applied` 的计件调整单必须已经体现在 `piece_wage` 里；`pending` 的要单独点名
 *    （它下一期才带）。报销/借款出现在调整单里单独提示：那不是工资。
 * 6. 已离职员工本期仍发薪只做提示（可能是补发），但必须写原因，否则审计会问。
 */
const { db, now } = require('../db');
const { nextNo } = require('../utils/docNo');
const { round2, recalc, workDaysInMonth } = require('./payrollCalc');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const num = (v) => Number(v) || 0;
const str = (v) => String(v === undefined || v === null ? '' : v).trim();

const STATUS = { pending: '待核对', ok: '核对一致', diff: '有差异', policy: '政策待配', missing: '缺工资单' };
const ISSUE = {
  piece_mismatch: '计件金额与确认批次不符',
  no_piece_source: '工资单有计件但批次里没有',
  gross_mismatch: '应发与公式重算不符',
  net_mismatch: '实发与公式重算不符',
  tax_mismatch: '个税与公式重算不符',
  no_payroll: '有计件但本期没有工资单',
  adj_pending: '调整单本期未带入',
  adj_missing: '已处理调整单未体现',
  left_employee: '已离职仍发薪',
  foreign_policy: '境外主体政策未配置',
  multi_run: '同期多个已确认批次'
};

function periodRange(period) {
  const [y, m] = String(period).split('-').map(Number);
  return { from: `${period}-01`, to: `${period}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
}
function nextPeriod(period) {
  const [y, m] = String(period).split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/* ==================================================================== *
 * 一、计算核对结果
 * ==================================================================== */

function buildCheck(period, opts = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw bad('期间格式应为 YYYY-MM');
  const companyId = opts.company_id ? Number(opts.company_id) : null;
  const company = companyId ? db.prepare("SELECT id, name, short_name, base_currency FROM companies WHERE id = ?").get(companyId) : null;
  if (companyId && !company) throw bad('公司不存在');

  const coverage = [];
  const batchIssues = [];

  // 1. 已确认的计件批次
  const runs = db.prepare("SELECT * FROM piece_wage_runs WHERE period = ? AND status = 'confirmed' ORDER BY id").all(period);
  if (!runs.length) coverage.push('本期没有已确认的计件核算单：计件应计按 0 处理，工资单里的计件会被标为「无来源」');
  if (runs.length > 1) {
    batchIssues.push({
      kind: 'multi_run',
      msg: `本期存在 ${runs.length} 个已确认的计件批次（${runs.map((r) => r.run_no).join('、')}）。已确认批次应当只有一个，先查清是不是并发/作废失败，别挑一个先用`
    });
  }
  const pieceTotal = round2(runs.reduce((s, r) => s + num(r.total_amount), 0));

  // 2. 计件明细按员工汇总
  const pieces = db.prepare(`
    SELECT i.employee_id, MAX(i.employee_name) AS employee_name, MAX(i.department) AS department,
           COALESCE(SUM(i.qty),0) AS qty, COALESCE(SUM(i.amount),0) AS amount, COUNT(*) AS cnt
    FROM piece_wage_items i JOIN piece_wage_runs r ON r.id = i.run_id
    WHERE r.period = ? AND r.status = 'confirmed' AND i.excluded = 0
    GROUP BY i.employee_id`).all(period);
  const pieceMap = new Map(pieces.map((p) => [Number(p.employee_id), p]));

  // 3. 工资单
  const payrolls = db.prepare('SELECT * FROM payrolls WHERE period = ?').all(period);
  const payMap = new Map(payrolls.map((p) => [Number(p.employee_id), p]));

  // 4. 员工主数据（在职状态）
  const empMap = new Map(db.prepare('SELECT id, name, department_id, status, leave_date FROM employees').all().map((e) => [e.id, e]));
  const deptMap = new Map(db.prepare('SELECT id, name FROM departments').all().map((d) => [d.id, d.name]));

  // 5. 调整单：本期生效的（piece_wage 之外的也看，用于识别「报销当工资」）
  const adjs = db.prepare('SELECT * FROM payroll_adjustments WHERE period = ?').all(period);
  const adjByEmp = new Map();
  adjs.forEach((a) => {
    const k = Number(a.employee_id);
    if (!adjByEmp.has(k)) adjByEmp.set(k, []);
    adjByEmp.get(k).push(a);
  });

  // 6. 公司币种
  const companies = new Map(db.prepare('SELECT id, name, short_name, base_currency FROM companies').all().map((c) => [c.id, c]));

  const empIds = new Set([...pieceMap.keys(), ...payMap.keys()]);
  const items = [];

  empIds.forEach((empId) => {
    const piece = pieceMap.get(empId) || { qty: 0, amount: 0, cnt: 0 };
    const pay = payMap.get(empId) || null;
    const emp = empMap.get(empId) || null;

    // 指定公司时：只保留该公司的工资单；没有工资单的员工无法判公司 → 排除
    if (companyId && (!pay || Number(pay.company_id) !== companyId)) return;

    const curCompany = companies.get(Number(pay ? pay.company_id : 0)) || null;
    const currency = curCompany ? curCompany.base_currency || 'CNY' : 'CNY';
    const foreign = currency !== 'CNY';

    const calc = pay ? recalc(pay) : null;
    const issues = [];

    if (!pay && num(piece.amount) > 0) {
      issues.push({ kind: 'no_payroll', msg: `确认批次里有 ¥${round2(piece.amount)} 计件，但本期没有工资单` });
    }

    if (pay) {
      const diffPiece = round2(num(pay.piece_wage) - num(piece.amount));
      if (Math.abs(diffPiece) >= 0.01) {
        issues.push({
          kind: 'piece_mismatch',
          msg: `工资单计件 ¥${round2(pay.piece_wage)}，确认批次 ¥${round2(piece.amount)}，差 ${diffPiece > 0 ? '+' : ''}${diffPiece}`
        });
      }
      if (num(piece.amount) === 0 && num(pay.piece_wage) > 0) {
        issues.push({ kind: 'no_piece_source', msg: `工资单有计件 ¥${round2(pay.piece_wage)}，但批次里找不到来源` });
      }
      if (Math.abs(num(pay.gross_pay) - calc.gross) >= 0.01) {
        issues.push({
          kind: 'gross_mismatch',
          msg: `库里应发 ¥${round2(pay.gross_pay)}，按公式重算 ¥${calc.gross}（差 ${round2(num(pay.gross_pay) - calc.gross)}）`
        });
      }
      if (Math.abs(num(pay.tax) - calc.tax) >= 0.01) {
        issues.push({ kind: 'tax_mismatch', msg: `库里个税 ¥${round2(pay.tax)}，重算 ¥${calc.tax}` });
      }
      if (Math.abs(num(pay.net_pay) - calc.net) >= 0.01) {
        issues.push({ kind: 'net_mismatch', msg: `库里实发 ¥${round2(pay.net_pay)}，重算 ¥${calc.net}` });
      }
    }

    // 调整单
    const myAdj = adjByEmp.get(empId) || [];
    const pieceAdj = myAdj.filter((a) => a.item === 'piece_wage');
    const appliedPiece = round2(pieceAdj.filter((a) => a.status === 'applied').reduce((s, a) => s + num(a.amount), 0));
    const pendingPiece = pieceAdj.filter((a) => a.status === 'pending');
    if (pendingPiece.length) {
      issues.push({
        kind: 'adj_pending',
        msg: `有 ${pendingPiece.length} 张计件调整单待带入（合计 ¥${round2(pendingPiece.reduce((s, a) => s + num(a.amount), 0))}），本期工资单里还没有`
      });
    }
    if (appliedPiece !== 0 && pay) {
      // 已带入的调整单，金额应当已经包含在 piece_wage 里；piece_mismatch 会同时报出来，
      // 这里只补一句说明，避免有人以为是「漏加」
      issues.push({
        kind: 'adj_missing',
        msg: `本期有已带入的计件调整 ¥${appliedPiece}，核对时请确认它已经含在工资单的计件里`
      });
    }
    const looksReimburse = myAdj.filter((a) => ['other', 'deduction'].includes(a.item) && /报销|借款|垫付/.test(String(a.reason || '')));
    looksReimburse.forEach((a) => {
      issues.push({
        kind: 'adj_reimburse',
        msg: `调整单 ${a.adj_no}（${a.item}）像是报销/借款：「${String(a.reason).slice(0, 24)}」—— 这类钱不是工资，别混进工资单`
      });
    });

    // 离职
    if (emp && emp.status === 'left' && pay) {
      issues.push({ kind: 'left_employee', msg: `员工已于 ${emp.leave_date || '（未记录日期）'} 离职，本期仍在发薪；若为补发请写原因` });
    }

    // 境外主体
    if (foreign && pay) {
      issues.push({ kind: 'foreign_policy', msg: `本位币 ${currency}，境外个税与社保政策未配置；本行只核对金额来源，不判断税社保` });
    }

    // 结论
    // 注意 adj_pending 不算「有差异」：它表示「有一笔调整还没带进本期」，本来就下一期才带。
    // 把它算成差异会让「有差异」这一栏永远清不掉（除非乱写说明），也会让登记差异默认金额为 0。
    const realDiffs = issues.filter((x) => !['foreign_policy', 'left_employee', 'adj_missing', 'adj_reimburse', 'adj_pending'].includes(x.kind));
    let status = 'ok';
    if (!pay && num(piece.amount) > 0) status = 'missing';
    else if (realDiffs.length) status = 'diff';
    else if (issues.some((x) => x.kind === 'foreign_policy')) status = 'policy';
    else if (!pay && num(piece.amount) === 0) status = 'ok';

    items.push({
      employee_id: empId,
      employee_name: (pay && pay.employee_name) || piece.employee_name || (emp ? emp.name : `#${empId}`),
      department: (pay && pay.department) || piece.department || (emp && emp.department_id ? deptMap.get(emp.department_id) : '') || '',
      company_id: pay ? Number(pay.company_id) : companyId,
      currency,
      piece_qty: round2(piece.qty),
      piece_expected: round2(piece.amount),
      piece_in_payroll: pay ? round2(pay.piece_wage) : 0,
      piece_diff: pay ? round2(num(pay.piece_wage) - num(piece.amount)) : round2(-num(piece.amount)),
      base_salary: pay ? round2(pay.base_salary) : 0,
      overtime_pay: calc ? calc.overtimePay : 0,
      bonus: pay ? round2(pay.bonus) : 0,
      allowance: pay ? round2(pay.allowance) : 0,
      deduction: pay ? round2(pay.deduction) : 0,
      social_insurance: pay ? round2(pay.social_insurance) : 0,
      tax_stored: pay ? round2(pay.tax) : 0,
      gross_stored: pay ? round2(pay.gross_pay) : 0,
      gross_recalc: calc ? calc.gross : 0,
      net_stored: pay ? round2(pay.net_pay) : 0,
      net_recalc: calc ? calc.net : 0,
      adj_piece: appliedPiece,
      status,
      status_label: STATUS[status],
      issues,
      payroll_status: pay ? pay.status : null
    });
  });

  items.sort((a, b) => (a.status === b.status ? String(a.department).localeCompare(String(b.department), 'zh') : (a.status === 'diff' ? -1 : b.status === 'diff' ? 1 : 0)));

  const sum = (k) => round2(items.reduce((s, x) => s + num(x[k]), 0));
  const summary = {
    items: items.length,
    ok: items.filter((x) => x.status === 'ok').length,
    diff: items.filter((x) => x.status === 'diff').length,
    policy: items.filter((x) => x.status === 'policy').length,
    missing: items.filter((x) => x.status === 'missing').length,
    piece_expected: round2(items.reduce((s, x) => s + x.piece_expected, 0)),
    piece_in_payroll: round2(items.reduce((s, x) => s + x.piece_in_payroll, 0)),
    piece_diff: round2(items.reduce((s, x) => s + x.piece_in_payroll, 0) - items.reduce((s, x) => s + x.piece_expected, 0)),
    gross_diff_total: round2(items.reduce((s, x) => s + (x.gross_stored - x.gross_recalc), 0)),
    net_diff_total: round2(items.reduce((s, x) => s + (x.net_stored - x.net_recalc), 0)),
    runs: runs.map((r) => ({ run_no: r.run_no, total_amount: round2(r.total_amount), employees: r.employees_count })),
    run_total: pieceTotal
  };

  // 外籍主体说明
  const foreignItems = items.filter((x) => x.currency !== 'CNY');
  if (foreignItems.length) coverage.push(`${foreignItems.length} 名员工属境外主体（本位币非 CNY），个税社保政策未配置，未参与税社保核对`);

  // 成本口径提示（不做自动合并）
  const orderCount = db.prepare(`
    SELECT COUNT(DISTINCT i.order_id) c FROM piece_wage_items i
    JOIN piece_wage_runs r ON r.id = i.run_id
    WHERE r.period = ? AND r.status = 'confirmed'`).get(period).c;
  if (orderCount > 0) {
    coverage.push(`本期计件覆盖 ${orderCount} 张订单；成本单的人工成本是报价用估算（手工填），不引用计件金额，故本轮不做「工资 vs 成本」自动去重；若成本单已按实际计件填过，报工源会被用两次，报价会虚高`);
  }
  coverage.push(`个税按月度税率表（5000 免征额）简化计算，非累计预扣；核对只判断「存的值与同一口径重算是否一致」`);
  coverage.push('工资所属期与实际支付期分别汇总由年度薪资汇总（N13-08）负责，本页只核对本期');

  return {
    period,
    range: periodRange(period),
    work_days: workDaysInMonth(period),
    company: company ? { id: company.id, name: company.name, short_name: company.short_name, currency: company.base_currency } : null,
    generated_at: now(),
    summary,
    items,
    batch_issues: batchIssues,
    coverage
  };
}

/* ==================================================================== *
 * 二、落库与查询
 * ==================================================================== */

function decorItem(r) {
  let issues = [];
  try { issues = JSON.parse(r.issues || '[]'); } catch (_) { issues = []; }
  return {
    ...r,
    issues,
    status_label: STATUS[r.status] || r.status,
    // 差异行的处理状态：登记了调整单 / 写了说明，才算处理过
    handled: !!(r.adj_no || str(r.review_note))
  };
}

function runCheck(period, opts = {}, actor) {
  const rep = buildCheck(period, opts);
  const companyId = rep.company ? rep.company.id : null;

  const existing = db.prepare(
    'SELECT * FROM payroll_check_runs WHERE period = ? AND IFNULL(company_id,0) = ? ORDER BY id DESC LIMIT 1'
  ).get(period, companyId || 0);
  if (existing && existing.status === 'reviewed' && !opts.force) {
    throw bad(`该期间已核对完成（${existing.check_no}）。要重新核对请确认，会生成新版本`);
  }

  const checkNo = nextNo('HD', 'payroll_check_runs', 'check_no');
  const t = now();
  const s = rep.summary;
  let runId = 0;
  db.exec('BEGIN');
  try {
    const info = db.prepare(`INSERT INTO payroll_check_runs (check_no, period, company_id, company_name, currency,
        status, items_count, ok_count, diff_count, policy_count, missing_count,
        piece_expected, piece_in_payroll, piece_diff, gross_diff_total, net_diff_total,
        payload, basis, note, created_by, created_at)
      VALUES (?,?,?,?,?, 'open', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      checkNo, period, companyId, rep.company ? rep.company.name : null,
      rep.company ? rep.company.currency : 'CNY',
      s.items, s.ok, s.diff, s.policy, s.missing,
      s.piece_expected, s.piece_in_payroll, s.piece_diff, s.gross_diff_total, s.net_diff_total,
      JSON.stringify(rep), [...rep.coverage, ...rep.batch_issues.map((x) => x.msg)].join('；'),
      str(opts.note) || null, actor || 'system', t
    );
    runId = Number(info.lastInsertRowid);
    const stmt = db.prepare(`INSERT INTO payroll_check_items (run_id, employee_id, employee_name, department, company_id, currency,
        piece_qty, piece_expected, piece_in_payroll, piece_diff, base_salary, overtime_pay, bonus, allowance, deduction,
        social_insurance, tax_stored, gross_stored, gross_recalc, net_stored, net_recalc, adj_piece, status, issues,
        created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    rep.items.forEach((x) => {
      stmt.run(runId, x.employee_id, x.employee_name, x.department || null, x.company_id, x.currency,
        x.piece_qty, x.piece_expected, x.piece_in_payroll, x.piece_diff, x.base_salary, x.overtime_pay,
        x.bonus, x.allowance, x.deduction, x.social_insurance, x.tax_stored, x.gross_stored, x.gross_recalc,
        x.net_stored, x.net_recalc, x.adj_piece, x.status, JSON.stringify(x.issues || []), t, t);
    });
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 已回滚 */ }
    throw e;
  }
  return runDetail(runId);
}

function refreshCounts(runId) {
  const r = db.prepare(`SELECT COUNT(*) c,
      SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok_c,
      SUM(CASE WHEN status='diff' THEN 1 ELSE 0 END) diff_c,
      SUM(CASE WHEN status='policy' THEN 1 ELSE 0 END) policy_c,
      SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) missing_c
    FROM payroll_check_items WHERE run_id = ?`).get(runId);
  db.prepare('UPDATE payroll_check_runs SET items_count=?, ok_count=?, diff_count=?, policy_count=?, missing_count=? WHERE id=?')
    .run(r.c || 0, r.ok_c || 0, r.diff_c || 0, r.policy_c || 0, r.missing_c || 0, runId);
}

function runDetail(id) {
  const run = db.prepare('SELECT * FROM payroll_check_runs WHERE id = ?').get(id);
  if (!run) throw bad('核对批次不存在', 404);
  let payload = {};
  try { payload = JSON.parse(run.payload || '{}'); } catch (_) { payload = {}; }
  const items = db.prepare(`SELECT * FROM payroll_check_items WHERE run_id = ?
    ORDER BY CASE status WHEN 'missing' THEN 0 WHEN 'diff' THEN 1 WHEN 'policy' THEN 2 ELSE 3 END, employee_id`).all(id)
    .map(decorItem);
  return { ...run, payload, items };
}

function listRuns(q = {}) {
  const where = [];
  const params = [];
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  if (q.company_id) { where.push('IFNULL(company_id,0) = ?'); params.push(Number(q.company_id)); }
  const sql = 'SELECT * FROM payroll_check_runs ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY period DESC, id DESC LIMIT 36';
  return db.prepare(sql).all(...params).map((r) => {
    let p = {};
    try { p = JSON.parse(r.payload || '{}'); } catch (_) { p = {}; }
    return { ...r, summary: p.summary || {}, batch_issues: p.batch_issues || [] };
  });
}

/** 某员工的计件来源（下钻用，工资核对必须在能看见「钱是怎么算出来的」时才可信） */
function sources(runId, employeeId) {
  const run = db.prepare('SELECT * FROM payroll_check_runs WHERE id = ?').get(runId);
  if (!run) throw bad('核对批次不存在', 404);
  const rows = db.prepare(`
    SELECT i.*, r.run_no FROM piece_wage_items i JOIN piece_wage_runs r ON r.id = i.run_id
    WHERE r.period = ? AND r.status = 'confirmed' AND i.employee_id = ? AND i.excluded = 0
    ORDER BY i.report_date, i.id`).all(run.period, employeeId);
  const pay = db.prepare('SELECT * FROM payrolls WHERE period = ? AND employee_id = ?').get(run.period, employeeId);
  return {
    period: run.period,
    employee_id: Number(employeeId),
    rows: rows.map((x) => ({
      run_no: x.run_no, report_date: x.report_date, order_no: x.order_no, style_no: x.style_no,
      process_name: x.process_name, bundle_no: x.bundle_no, raw_qty: round2(x.raw_qty), qty: round2(x.qty),
      unit_price: round2(x.unit_price), amount: round2(x.amount), capped: !!x.capped,
      att_status: x.att_status, excluded: !!x.excluded
    })),
    total_qty: round2(rows.reduce((s, x) => s + num(x.qty), 0)),
    total_amount: round2(rows.reduce((s, x) => s + num(x.amount), 0)),
    payroll: pay ? { piece_wage: round2(pay.piece_wage), gross_pay: round2(pay.gross_pay), status: pay.status } : null
  };
}

/* ==================================================================== *
 * 三、登记差异（只能生成调整单，不改工资单）
 * ==================================================================== */

function registerDiff(itemId, b = {}, actor) {
  const item = db.prepare('SELECT * FROM payroll_check_items WHERE id = ?').get(itemId);
  if (!item) throw bad('核对明细不存在', 404);
  if (item.status !== 'diff' && item.status !== 'missing') {
    throw bad('只有「有差异」或「缺工资单」的行才需要登记差异');
  }
  if (item.adj_no) throw bad(`已经登记过调整单 ${item.adj_no}`);
  const run = db.prepare('SELECT * FROM payroll_check_runs WHERE id = ?').get(item.run_id);
  if (!run) throw bad('核对批次不存在', 404);

  const reason = str(b.reason);
  if (reason.length < 6) throw bad('登记差异必须写原因（≥6 字）—— 否则下个月没人知道这笔钱为什么补');
  // 缺工资单=该发没发，默认按「应计」补发（正数）；其他情况按差额（正数代表多发要扣回）
  const defaultAmount = item.status === 'missing' ? round2(item.piece_expected) : round2(item.piece_diff);
  const amount = b.amount === undefined ? defaultAmount : round2(b.amount);
  if (Math.abs(amount) < 0.01) throw bad('调整金额为 0，不需要登记差异');

  const target = str(b.period) || nextPeriod(run.period);
  const adjNo = nextNo('PA', 'payroll_adjustments', 'adj_no');
  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO payroll_adjustments (adj_no, employee_id, employee_name, period, item, amount, reason,
        status, source_period, created_by, created_at, updated_at)
      VALUES (?,?,?,?, 'piece_wage', ?,?, 'pending', ?,?,?,?)`).run(
      adjNo, item.employee_id, item.employee_name, target, amount, reason, run.period, actor || 'system', t, t
    );
    db.prepare('UPDATE payroll_check_items SET adj_no = ?, adj_amount = ?, review_note = COALESCE(review_note, ?), updated_at = ? WHERE id = ?')
      .run(adjNo, amount, `登记差异：${reason}`, t, itemId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 已回滚 */ }
    throw e;
  }
  return { adj_no: adjNo, period: target, amount, item: decorItem(db.prepare('SELECT * FROM payroll_check_items WHERE id = ?').get(itemId)) };
}

/** 写处理说明（不改钱，只留结论；用于「确认是补发」「已与工人核实」这类） */
function annotate(itemId, b = {}, actor) {
  const item = db.prepare('SELECT * FROM payroll_check_items WHERE id = ?').get(itemId);
  if (!item) throw bad('核对明细不存在', 404);
  const note = str(b.review_note);
  if (!note) throw bad('请写核对说明');
  db.prepare('UPDATE payroll_check_items SET review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?')
    .run(note, actor || 'system', now(), now(), itemId);
  return decorItem(db.prepare('SELECT * FROM payroll_check_items WHERE id = ?').get(itemId));
}

/**
 * 完成核对：
 * - 批次里还有未处理的差异 → 拒绝（登记调整单或写说明都算处理）
 * - 存在多个已确认计件批次 → 拒绝（那是数据问题，不能「先核了再说」）
 */
function review(runId, b = {}, actor) {
  const run = db.prepare('SELECT * FROM payroll_check_runs WHERE id = ?').get(runId);
  if (!run) throw bad('核对批次不存在', 404);
  if (run.status === 'reviewed') throw bad('该批次已完成核对');

  let payload = {};
  try { payload = JSON.parse(run.payload || '{}'); } catch (_) { payload = {}; }
  if ((payload.batch_issues || []).some((x) => x.kind === 'multi_run')) {
    throw bad('本期存在多个已确认的计件批次，先处理批次问题再完成核对');
  }

  const pending = db.prepare(`
    SELECT employee_name, status FROM payroll_check_items
    WHERE run_id = ? AND status IN ('diff','missing') AND adj_no IS NULL AND (review_note IS NULL OR review_note = '')`).all(runId);
  if (pending.length) {
    throw bad(`还有 ${pending.length} 行差异没处理（登记调整单或写核对说明）：${pending.slice(0, 3).map((x) => x.employee_name).join('、')}${pending.length > 3 ? '…' : ''}`);
  }

  const t = now();
  db.prepare("UPDATE payroll_check_runs SET status='reviewed', reviewed_by=?, reviewed_at=?, note=COALESCE(?, note) WHERE id=?")
    .run(actor || 'system', t, str(b.note) || null, runId);
  return runDetail(runId);
}

function meta() {
  const months = [];
  const d = new Date();
  for (let i = 0; i < 12; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  return {
    statuses: Object.entries(STATUS).map(([code, label]) => ({ code, label })),
    issue_types: Object.entries(ISSUE).map(([code, label]) => ({ code, label })),
    companies: db.prepare("SELECT id, name, short_name, base_currency FROM companies WHERE status='active' ORDER BY id").all(),
    periods: months
  };
}

module.exports = {
  STATUS, ISSUE, buildCheck, runCheck, listRuns, runDetail, sources,
  registerDiff, annotate, review, meta, nextPeriod
};
