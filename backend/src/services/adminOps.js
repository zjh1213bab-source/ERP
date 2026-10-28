/**
 * 行政运营报表（TS-N14-09）
 * ========================================================================
 * 八项固定指标，口径写在 `scripts/apply-adminops-ddl.js` 的注释里，这里只做实现。
 * 一条总原则：**算不出来就说算不出来**，不拿 0 冒充「没有」。
 *
 * 这个文件里没有任何写业务表的语句：
 *   - 它读 `dorm_*` / `meal_*` / `admin_expenses` / `office_*` / `custody_*` / `assets` / `budget_*` / `repairs`
 *   - 它只写自己的两张表（`admin_report_runs` 快照、`admin_report_findings` 差异清单）
 * 报表一旦顺手改业务数据，就再也没人相信报表里的数字是自己看到的那些单子算出来的。
 */
const { db, now } = require('../db');
const { localDate } = require('../utils/time');
const { nextNo } = require('../utils/docNo');
const { round2, withDepreciation } = require('./assetDep');
const B = require('./bedDays');
const custody = require('./custody');

const bad = (msg, status = 400) => {
  const e = new Error(msg);
  e.status = status;
  return e;
};
const num = (v) => Number(v) || 0;
const str = (v) => String(v === undefined || v === null ? '' : v).trim();
const money = (v) => round2(v);
const ADMIN_DEPT = '人事行政部';

// 短名：差异清单的「指标」列只有 96px，长名会把整张表挤到横向滚动
const METRICS = {
  dorm: '宿舍与床位',
  expense: '行政费用',
  meal: '饭卡资金',
  asset: '资产与领归',
  office: '耗材结存',
  budget: '预算差异',
  repair: '工单与复验'
};

const SEVERITY = { high: '严重', mid: '中等', low: '提示' };
const FINDING_STATUS = { open: '待处理', assigned: '已分派', fixed: '已处理待复核', closed: '已关闭', ignored: '已忽略' };

/* ==================================================================== *
 * 一、各段指标
 * ==================================================================== */

/** 1+2. 宿舍：入住率 / 空床 / 维修床 / 押金 */
function dormSection(period) {
  const d = B.bedDays(period);
  const findings = [];
  const coverage = [];

  // 维修床上有人住：数据矛盾，不是「统计口径问题」
  d.used_on_unusable_beds.forEach((x) => {
    findings.push({
      metric: 'dorm', severity: 'high', subject: `${x.room} · ${x.bed_no} 号床`,
      subject_kind: 'room',
      expected: '维修/封房床位不应有人住', actual: `住宿单 #${x.stay_id} 占 ${x.days} 天`,
      diff: x.days, unit: '天',
      hint: '床位或房间标记为维修，但住宿单仍覆盖该期间。要么维修已结束没改状态，要么住宿单录错床位。'
    });
  });

  // 已退住押金：系统没有「已退押金」字段，只能提示人工核对
  if (d.deposits.checked_out_count > 0 && d.deposits.checked_out_deposit > 0) {
    findings.push({
      metric: 'dorm', severity: 'mid', subject: '退住押金',
      subject_kind: 'stay',
      expected: '退住时押金已退并有财务回执', actual: `${d.deposits.checked_out_count} 笔退住，押金合计 ¥${money(d.deposits.checked_out_deposit)}`,
      diff: money(d.deposits.checked_out_deposit), unit: '元',
      hint: '住宿单没有「押金已退」字段，报表只能按退住状态提示。押金退还必须走财务回执，不要让行政在这边改余额。'
    });
  }

  if (d.beds_maintenance > 0) coverage.push(`可用床日按期末状态整期计算：${d.beds_maintenance} 张维修/封房床已整月扣除；期内临时维修无历史区间，未单独扣减`);
  if (d.days === 0) coverage.push('期间天数为 0，入住率不计算');

  // 空床日：有房但整月无人 = 结构性空置，值得看一眼
  const idleRooms = d.by_room.filter((r) => r.usable > 0 && r.used_days === 0);
  if (idleRooms.length) {
    findings.push({
      metric: 'dorm', severity: 'low', subject: `空置房间 ${idleRooms.length} 间`,
      subject_kind: 'room',
      expected: '在用的宿舍房间有入住', actual: idleRooms.map((r) => r.room).join('、'),
      diff: null, unit: '',
      hint: '整月无人入住。若这些房间已停用，请在房间状态里标记维修/停用，否则入住率会一直被拉低。'
    });
  }

  return {
    ...d,
    deposit_balance: d.deposits.deposit_total,
    findings, coverage
  };
}

/** 3. 行政费用（按分类 / 部门 / 公司） */
function expenseSection(period, companyId) {
  const { start, end } = B.periodRange(period);
  const params = [start, end];
  let where = 'expense_date BETWEEN ? AND ?';
  if (companyId) { where += ' AND company_id = ?'; params.push(companyId); }
  const rows = db.prepare(`SELECT * FROM admin_expenses WHERE ${where} ORDER BY expense_date`).all(...params);

  const total = round2(rows.reduce((s, r) => s + num(r.amount), 0));
  const byCat = {};
  const byDept = {};
  rows.forEach((r) => {
    const c = r.category || '其他';
    byCat[c] = round2((byCat[c] || 0) + num(r.amount));
    const d = r.department_id ? (db.prepare('SELECT name FROM departments WHERE id=?').get(r.department_id) || {}).name : null;
    const k = d || '未归口';
    byDept[k] = round2((byDept[k] || 0) + num(r.amount));
  });

  // 上月对比（同公司）
  const prev = (() => {
    const [y, m] = period.split('-').map(Number);
    const pm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const pr = B.periodRange(pm);
    const p2 = [pr.start, pr.end];
    let w2 = 'expense_date BETWEEN ? AND ?';
    if (companyId) { w2 += ' AND company_id = ?'; p2.push(companyId); }
    const v = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM admin_expenses WHERE ${w2}`).get(...p2).v;
    return { period: pm, total: round2(v) };
  })();

  const noDept = rows.filter((r) => !r.department_id);
  const findings = [];
  if (noDept.length) {
    const amt = round2(noDept.reduce((s, r) => s + num(r.amount), 0));
    findings.push({
      metric: 'expense', severity: 'mid', subject: '费用未归口部门',
      subject_kind: 'dept',
      expected: '每笔行政费用都挂部门', actual: `${noDept.length} 笔合计 ¥${amt}`,
      diff: amt, unit: '元',
      hint: '没有部门的费用不会出现在任何部门的预算执行里，预算差异会因此偏小。房租/水电这类共用费用建议按受益部门拆分录入。'
    });
  }

  // 与预算占用无关：这里只用已入账事实
  return {
    total,
    count: rows.length,
    by_category: Object.entries(byCat).map(([k, v]) => ({ category: k, amount: v })).sort((a, b) => b.amount - a.amount),
    by_dept: Object.entries(byDept).map(([k, v]) => ({ dept: k, amount: v })).sort((a, b) => b.amount - a.amount),
    prev_month: prev,
    mom_pct: prev.total > 0 ? Math.round(((total - prev.total) / prev.total) * 10000) / 100 : null,
    unassigned_amount: round2(noDept.reduce((s, r) => s + num(r.amount), 0)),
    unassigned_count: noDept.length,
    rows: rows.map((r) => ({
      id: r.id, expense_date: r.expense_date, category: r.category, amount: num(r.amount),
      payee: r.payee, department_id: r.department_id, company_id: r.company_id
    })),
    findings,
    coverage: companyId ? [] : ['未指定公司：费用按全部主体合并，跨主体不做事后分摊']
  };
}

/** 4. 饭卡资金对账（恒等式） */
function mealSection(period) {
  const { start, end } = B.periodRange(period);
  const accounts = db.prepare('SELECT * FROM meal_accounts').all();
  const balP = round2(accounts.reduce((s, a) => s + num(a.balance), 0));
  const balS = round2(accounts.reduce((s, a) => s + num(a.subsidy_balance), 0));
  const ledP = round2(db.prepare('SELECT COALESCE(SUM(personal_delta),0) v FROM meal_transactions').get().v);
  const ledS = round2(db.prepare('SELECT COALESCE(SUM(subsidy_delta),0) v FROM meal_transactions').get().v);

  const periodRows = db.prepare(
    "SELECT type, COUNT(*) c, COALESCE(SUM(amount),0) v, COALESCE(SUM(personal_delta),0) p, COALESCE(SUM(subsidy_delta),0) s FROM meal_transactions WHERE strftime('%Y-%m', created_at, 'localtime') = ? GROUP BY type"
  ).all(period);
  const byType = periodRows.map((r) => ({
    type: r.type, count: r.c, amount: round2(r.v), personal: round2(r.p), subsidy: round2(r.s)
  }));

  const findings = [];
  const dp = round2(balP - ledP);
  const ds = round2(balS - ledS);
  if (Math.abs(dp) >= 0.01) {
    findings.push({
      metric: 'meal', severity: 'high', subject: '个人余额与流水不符',
      subject_kind: 'account',
      expected: `流水个人净额合计 ¥${ledP}`, actual: `账户个人余额合计 ¥${balP}`,
      diff: dp, unit: '元',
      hint: '余额不是流水加出来的，说明有人直接改过 balance。不要「调平」余额，走 adjust 并写原因留痕，否则以后再也对不上。'
    });
  }
  if (Math.abs(ds) >= 0.01) {
    findings.push({
      metric: 'meal', severity: 'high', subject: '补贴余额与流水不符',
      subject_kind: 'account',
      expected: `流水补贴净额合计 ¥${ledS}`, actual: `账户补贴余额合计 ¥${balS}`,
      diff: ds, unit: '元',
      hint: '公司补贴是福利费，与个人充值的钱分开记账；这条对不上要先查是不是把补贴直接充进了个人余额。'
    });
  }
  const negative = accounts.filter((a) => num(a.balance) < 0 || num(a.subsidy_balance) < 0);
  if (negative.length) {
    findings.push({
      metric: 'meal', severity: 'high', subject: '饭卡余额为负',
      subject_kind: 'account',
      expected: '余额不小于 0', actual: `${negative.length} 个账户为负`,
      diff: null, unit: '',
      hint: '消费超过余额还在扣，通常是设备离线补传或手工登记金额写错。'
    });
  }
  const lost = accounts.filter((a) => a.status === 'lost');
  const noTxPeriod = accounts.length > 0 && byType.length === 0;

  const coverage = [];
  if (noTxPeriod) coverage.push('本期无饭卡流水：消费/补贴指标按 0 展示，不代表没有余额');
  coverage.push('饭卡流水没有公司维度，按全公司口径统计');

  return {
    accounts: accounts.length,
    active: accounts.filter((a) => a.status === 'active').length,
    lost: lost.length,
    personal_balance: balP,
    subsidy_balance: balS,
    ledger_personal: ledP,
    ledger_subsidy: ledS,
    diff_personal: dp,
    diff_subsidy: ds,
    by_type: byType,
    period_consume: round2(-byType.filter((x) => x.type === 'consume').reduce((s, x) => s + x.amount, 0)),
    period_subsidy: round2(byType.filter((x) => x.type === 'subsidy').reduce((s, x) => s + x.amount, 0)),
    period_recharge: round2(byType.filter((x) => x.type === 'recharge').reduce((s, x) => s + x.amount, 0)),
    findings, coverage
  };
}

/** 5. 固定资产与实物领归 */
function assetSection() {
  const assets = db.prepare('SELECT * FROM assets').all().map(withDepreciation);
  const active = assets.filter((a) => a.status !== 'scrapped');
  const cs = custody.stats();
  const findings = [];

  if (cs.overdue_cnt > 0) {
    findings.push({
      metric: 'asset', severity: 'mid', subject: '实物超期未还',
      subject_kind: 'item',
      expected: '到期前归还', actual: `${cs.overdue_cnt} 条超期`,
      diff: cs.overdue_cnt, unit: '条',
      hint: '钥匙、门禁卡、工具这类「必须归还」的实物过了约定期限。工衣不设期限，不会出现在这里。'
    });
  }
  if (cs.claim_unconfirmed > 0) {
    findings.push({
      metric: 'asset', severity: 'mid', subject: '损坏定责未收回',
      subject_kind: 'item',
      expected: '定责金额已由财务确认', actual: `${cs.claim_unconfirmed} 笔，¥${money(cs.claim_unconfirmed_amount)}`,
      diff: money(cs.claim_unconfirmed_amount), unit: '元',
      hint: '复核已出结论但没有财务回执号。钱没收回，账上只是「建议」。'
    });
  }
  const noKeeper = active.filter((a) => !a.keeper && a.status === 'in_use');
  if (noKeeper.length) {
    findings.push({
      metric: 'asset', severity: 'low', subject: '在用资产无保管人',
      subject_kind: 'item',
      expected: '在用资产有保管人', actual: `${noKeeper.length} 项无保管人`,
      diff: noKeeper.length, unit: '项',
      hint: '没有保管人的在用资产，盘点时找不到人问。'
    });
  }

  return {
    count: assets.length,
    in_use: assets.filter((a) => a.status === 'in_use').length,
    idle: assets.filter((a) => a.status === 'idle').length,
    scrapped: assets.filter((a) => a.status === 'scrapped').length,
    original_total: money(active.reduce((s, a) => s + num(a.original_value), 0)),
    net_total: money(active.reduce((s, a) => s + num(a.net_value), 0)),
    custody: {
      items: cs.items,
      open_cnt: cs.open_cnt,
      overdue_cnt: cs.overdue_cnt,
      hold_cnt: db.prepare("SELECT COUNT(*) c FROM custody_items WHERE status='hold'").get().c,
      optional_out_cnt: cs.optional_out_cnt,
      claim_pending: cs.claim_pending,
      claim_unconfirmed: cs.claim_unconfirmed,
      claim_unconfirmed_amount: cs.claim_unconfirmed_amount,
      clearance_open: cs.clearance_open
    },
    findings,
    coverage: ['固定资产与实物领归是「期末时点」指标，不随期间变化']
  };
}

/** 6. 耗材收发结存（恒等式复核） */
function officeSection(period) {
  const flows = db.prepare(`
    SELECT type, COUNT(*) c, COALESCE(SUM(qty),0) v
    FROM office_ledger WHERE strftime('%Y-%m', created_at, 'localtime') = ?
    GROUP BY type`).all(period);
  const byType = flows.map((r) => ({ type: r.type, count: r.c, qty: round2(r.v) }));

  const items = db.prepare("SELECT * FROM office_items WHERE status='active'").all();
  const stock = db.prepare('SELECT item_id, qty FROM office_stock').all();
  const stockMap = new Map(stock.map((s) => [s.item_id, num(s.qty)]));
  const ledMap = new Map(db.prepare('SELECT item_id, COALESCE(SUM(qty),0) q FROM office_ledger GROUP BY item_id').all()
    .map((r) => [r.item_id, round2(r.q)]));

  const findings = [];
  let closingQty = 0;
  const lowStock = [];
  items.forEach((it) => {
    const s = round2(stockMap.get(it.id) || 0);
    const l = round2(ledMap.get(it.id) || 0);
    closingQty = round2(closingQty + s);
    if (Math.abs(s - l) >= 0.01) {
      findings.push({
        metric: 'office', severity: 'high', subject: `办公仓：${it.name}`,
        subject_kind: 'item',
        expected: `流水合计 ${l} ${it.unit}`, actual: `库存余额 ${s} ${it.unit}`,
        diff: round2(s - l), unit: it.unit,
        hint: '库存不等于流水合计，说明有人绕过流水直接改了 office_stock。库存数字从此不可信。'
      });
    }
    if (s < 0) {
      findings.push({
        metric: 'office', severity: 'high', subject: `负库存：${it.name}`,
        subject_kind: 'item',
        expected: '库存不小于 0', actual: `${s} ${it.unit}`,
        diff: s, unit: it.unit,
        hint: '先出库后补入库，或者出库数量写错。'
      });
    }
    if (num(it.min_qty) > 0 && s < num(it.min_qty)) {
      lowStock.push({ id: it.id, name: it.name, qty: s, min_qty: num(it.min_qty), unit: it.unit });
    }
  });

  if (lowStock.length) {
    findings.push({
      metric: 'office', severity: 'low', subject: '低于最低库存',
      subject_kind: 'item',
      expected: '库存不低于最低线', actual: `${lowStock.length} 项：${lowStock.slice(0, 3).map((x) => x.name).join('、')}${lowStock.length > 3 ? '…' : ''}`,
      diff: lowStock.length, unit: '项',
      hint: '只提示，不自动下单 —— 自动补货等于在没人核价的项目上自动花钱。'
    });
  }

  const coverage = [];
  if (!byType.length) coverage.push('本期办公仓无收发流水，结存为期末时点数');

  return {
    in_qty: round2(byType.filter((x) => x.type === 'in').reduce((s, x) => s + x.qty, 0)),
    out_qty: round2(-byType.filter((x) => x.type === 'out').reduce((s, x) => s + x.qty, 0)),
    back_qty: round2(byType.filter((x) => x.type === 'back').reduce((s, x) => s + x.qty, 0)),
    adjust_qty: round2(byType.filter((x) => x.type === 'adjust').reduce((s, x) => s + x.qty, 0)),
    by_type: byType,
    closing_qty: closingQty,
    items: items.length,
    low_stock: lowStock,
    findings, coverage
  };
}

/** 7. 行政预算差异 */
function budgetSection(period, companyId) {
  const [y] = period.split('-').map(Number);
  const budget = db.prepare(
    `SELECT * FROM budgets WHERE fiscal_year = ? AND is_current = 1 ${companyId ? 'AND (company_id = ? OR company_id IS NULL)' : ''}
     ORDER BY id DESC LIMIT 1`).get(...(companyId ? [y, companyId] : [y]));

  if (!budget) {
    return {
      budget_no: null, total: 0, actual: 0, diff: 0, items: [],
      findings: [],
      coverage: [`${y} 年没有生效预算（is_current=1），预算差异无法计算 —— 不是「没有超支」`]
    };
  }

  const items = db.prepare(
    `SELECT department_id, department_name, account_code, account_name, amount
     FROM budget_items WHERE budget_id = ? AND period = ? ORDER BY department_name, account_code`
  ).all(budget.id, period);

  const adminItems = items.filter((x) => str(x.department_name) === ADMIN_DEPT);
  const dept = db.prepare('SELECT id, name FROM departments WHERE name = ?').get(ADMIN_DEPT);
  const actual = dept
    ? round2(db.prepare('SELECT COALESCE(SUM(amount),0) v FROM admin_expenses WHERE department_id = ? AND expense_date BETWEEN ? AND ?')
      .get(dept.id, B.periodRange(period).start, B.periodRange(period).end).v)
    : 0;

  const budgetTotal = round2(adminItems.reduce((s, x) => s + num(x.amount), 0));
  const diff = round2(actual - budgetTotal);
  const tolerance = num(budget.tolerance_pct);

  const findings = [];
  const coverage = [];

  if (!adminItems.length) {
    coverage.push(`本期预算里没有「${ADMIN_DEPT}」的科目，行政预算差异无法计算`);
  } else if (budgetTotal > 0) {
    const overPct = Math.round((diff / budgetTotal) * 10000) / 100;
    if (diff > 0 && overPct > tolerance) {
      findings.push({
        metric: 'budget', severity: 'mid', subject: `行政费用超预算`,
        subject_kind: 'dept',
        expected: `预算 ¥${budgetTotal}（容忍 ${tolerance}%）`, actual: `实际 ¥${actual}`,
        diff, unit: '元',
        hint: `超出 ${overPct}%。含未归口部门的费用不在这个对比里，实际压力比这里更大。`
      });
    }
  }

  // 未归口费用也要点名：它不进任何部门预算
  const noDept = round2(db.prepare(
    'SELECT COALESCE(SUM(amount),0) v FROM admin_expenses WHERE department_id IS NULL AND expense_date BETWEEN ? AND ?'
  ).get(B.periodRange(period).start, B.periodRange(period).end).v);
  if (noDept > 0) coverage.push(`另有未归口部门费用 ¥${noDept}，未进入本对比（见费用段差异清单）`);

  return {
    budget_no: budget.budget_no,
    tolerance_pct: tolerance,
    total: budgetTotal,
    actual,
    diff,
    used_pct: budgetTotal > 0 ? Math.round((actual / budgetTotal) * 10000) / 100 : null,
    items: adminItems.map((x) => ({
      department_name: x.department_name, account_code: x.account_code,
      account_name: x.account_name, amount: round2(x.amount)
    })),
    findings, coverage
  };
}

/** 8. 服务工单超时与复验率 */
function repairSection(period) {
  const today = localDate(now());
  const rows = db.prepare(
    "SELECT * FROM repairs WHERE strftime('%Y-%m', reported_at, 'localtime') = ? ORDER BY id"
  ).all(period);

  const doneStatus = ['verified', 'closed'];
  const submittedPlus = rows.filter((r) => ['submitted', 'verified', 'closed', 'rejected'].includes(r.status));
  const verified = rows.filter((r) => !!r.verified_at);
  const skipped = rows.filter((r) => r.status === 'closed' && !r.verified_at);
  const overdue = rows.filter((r) => !doneStatus.includes(r.status) && r.due_date && r.due_date < today);
  const noDue = rows.filter((r) => !doneStatus.includes(r.status) && !r.due_date);
  const openRows = rows.filter((r) => !['verified', 'closed', 'rejected'].includes(r.status));

  const hours = rows.filter((r) => r.reported_at && r.submitted_at)
    .map((r) => (new Date(r.submitted_at) - new Date(r.reported_at)) / 3600000)
    .filter((h) => h >= 0);

  const findings = [];
  skipped.forEach((r) => {
    findings.push({
      metric: 'repair', severity: 'high', subject: `跳过复验：${r.repair_no}`,
      subject_kind: 'repair',
      expected: '提交后必须有人复验才关闭', actual: '状态已关闭但没有复验人/时间',
      diff: null, unit: '',
      hint: '维修提交与复验放行必须分开。直接关闭等于自己修自己验，出了问题没人复核。'
    });
  });
  overdue.forEach((r) => {
    findings.push({
      metric: 'repair', severity: 'mid', subject: `维修超期：${r.repair_no}`,
      subject_kind: 'repair',
      expected: `应于 ${r.due_date} 前完成`, actual: `当前状态「${r.status}」，已过 ${Math.round((new Date(today) - new Date(r.due_date)) / 86400000)} 天`,
      diff: Math.round((new Date(today) - new Date(r.due_date)) / 86400000), unit: '天',
      hint: r.facility ? `设施：${r.facility}` : ''
    });
  });
  if (noDue.length) {
    findings.push({
      metric: 'repair', severity: 'low', subject: '未完成工单没有期限',
      subject_kind: 'repair',
      expected: '未完成工单有 due_date', actual: `${noDue.length} 条无期限`,
      diff: noDue.length, unit: '条',
      hint: '没有期限就没法算超时，也没法催。'
    });
  }

  const coverage = [];
  if (!rows.length) coverage.push('本期无报修工单，超时与复验率不计算');
  if (!submittedPlus.length) coverage.push('本期没有进入提交流程的工单，复验率不计算（不是 0%）');
  // 样本太少不报比率：1 条工单没复验写成 0%，会被当成「复验制度形同虚设」
  if (submittedPlus.length > 0 && submittedPlus.length < 3) {
    coverage.push(`进入提交流程的工单只有 ${submittedPlus.length} 条，样本不足，复验率按「—」展示（明细里逐条看）`);
  }
  if (rows.length > 0 && rows.length < 3) {
    coverage.push(`本期工单只有 ${rows.length} 条，样本不足，准时率按「—」展示`);
  }
  const smallSample = (n) => n > 0 && n < 3;

  return {
    reported: rows.length,
    open: openRows.length,
    closed: rows.filter((r) => r.status === 'closed').length,
    verified: verified.length,
    overdue: overdue.length,
    no_due: noDue.length,
    skipped_verify: skipped.length,
    sla_rate: rows.length && !smallSample(rows.length)
      ? Math.round(((rows.length - overdue.length) / rows.length) * 10000) / 100 : null,
    verify_rate: submittedPlus.length && !smallSample(submittedPlus.length)
      ? Math.round((verified.length / submittedPlus.length) * 10000) / 100 : null,
    verify_base: submittedPlus.length,
    verify_hit: verified.length,
    avg_hours_to_submit: hours.length ? Math.round((hours.reduce((s, h) => s + h, 0) / hours.length) * 10) / 10 : null,
    by_severity: ['critical', 'major', 'minor'].map((s) => ({
      severity: s, count: rows.filter((r) => r.severity === s).length
    })),
    rows: rows.map((r) => ({
      id: r.id, repair_no: r.repair_no, status: r.status, severity: r.severity,
      facility: r.facility, reported_at: r.reported_at, due_date: r.due_date,
      submitted_at: r.submitted_at, verified_at: r.verified_at, verified_by: r.verified_by
    })),
    findings, coverage
  };
}

/* ==================================================================== *
 * 二、组装
 * ==================================================================== */

/**
 * 跑出整份报表（不落库）
 * @param {string} period YYYY-MM
 * @param {{company_id?:number}} opts
 */
function buildReport(period, opts = {}) {
  const range = B.periodRange(period);
  const companyId = opts.company_id ? Number(opts.company_id) : null;
  const company = companyId ? db.prepare('SELECT id, name, short_name FROM companies WHERE id = ?').get(companyId) : null;
  if (companyId && !company) throw bad('公司不存在');

  const dorm = dormSection(period);
  const expense = expenseSection(period, companyId);
  const meal = mealSection(period);
  const asset = assetSection();
  const office = officeSection(period);
  const budget = budgetSection(period, companyId);
  const repair = repairSection(period);

  const findings = [
    ...dorm.findings, ...expense.findings, ...meal.findings,
    ...asset.findings, ...office.findings, ...budget.findings, ...repair.findings
  ];
  const coverage = [
    ...dorm.coverage, ...expense.coverage, ...meal.coverage,
    ...asset.coverage, ...office.coverage, ...budget.coverage, ...repair.coverage
  ];

  const sectionOut = (x) => {
    const { findings: f, coverage: c, ...rest } = x;
    return rest;
  };

  return {
    period,
    range,
    company: company ? { id: company.id, name: company.name, short_name: company.short_name } : null,
    generated_at: now(),
    dorm: sectionOut(dorm),
    expense: sectionOut(expense),
    meal: sectionOut(meal),
    asset: sectionOut(asset),
    office: sectionOut(office),
    budget: sectionOut(budget),
    repair: sectionOut(repair),
    findings,
    coverage,
    summary: {
      occupancy_rate: dorm.occupancy_rate,
      available_bed_days: dorm.available_bed_days,
      used_bed_days: dorm.used_bed_days,
      expense_total: expense.total,
      budget_used_pct: budget.used_pct,
      meal_balance: round2(meal.personal_balance + meal.subsidy_balance),
      repair_verify_rate: repair.verify_rate,
      finding_count: findings.length,
      high_count: findings.filter((f) => f.severity === 'high').length
    }
  };
}

const basisText = (rep) => [
  `入住率 = 住用床日 ${rep.dorm.used_bed_days} / 可用床日 ${rep.dorm.available_bed_days}（按期末床位状态整期计算）`,
  `行政费用只认已入账的 admin_expenses ¥${rep.expense.total}，不含预算占用（占用是承诺，不是花掉的钱）`,
  `饭卡对账：个人余额合计 ¥${rep.meal.personal_balance} vs 流水净额 ¥${rep.meal.ledger_personal}；补贴余额 ¥${rep.meal.subsidy_balance} vs ¥${rep.meal.ledger_subsidy}`,
  `耗材结存：办公仓期末 ${rep.office.closing_qty}，与流水合计逐项核对`,
  `预算差异：${rep.budget.budget_no || '本期无生效预算'}`,
  `维修复验率 = 有复验记录的工单 / 已进入提交流程的工单`,
  ...(rep.coverage || [])
].join('；');

/* ==================================================================== *
 * 三、定版与差异清单
 * ==================================================================== */

function runReport(period, opts = {}, actor) {
  const rep = buildReport(period, opts);
  const companyId = rep.company ? rep.company.id : null;
  const exists = db.prepare(
    'SELECT * FROM admin_report_runs WHERE period = ? AND IFNULL(company_id,0) = ? ORDER BY id DESC LIMIT 1'
  ).get(period, companyId || 0);
  if (exists && !opts.force) {
    throw bad(`该期间已定版（${exists.run_no}，${exists.generated_at}）。要看最新数据请重跑并确认会生成新版本`);
  }

  const runNo = nextNo('XB', 'admin_report_runs', 'run_no');
  const t = now();
  let runId = 0;
  db.exec('BEGIN');
  try {
    const info = db.prepare(`INSERT INTO admin_report_runs (run_no, period, period_start, period_end, days, company_id, company_name,
        snapshot, basis, finding_count, open_count, high_count, generated_by, generated_at, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      runNo, period, rep.range.start, rep.range.end, rep.range.days, companyId,
      rep.company ? rep.company.name : null, JSON.stringify(rep), basisText(rep),
      rep.findings.length, rep.findings.length, rep.findings.filter((f) => f.severity === 'high').length,
      actor || 'system', t, str(opts.note) || null
    );
    runId = Number(info.lastInsertRowid);
    const stmt = db.prepare(`INSERT INTO admin_report_findings (run_id, period, metric, severity, subject, subject_kind,
        expected, actual, diff, unit, hint, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`);
    rep.findings.forEach((f) => {
      stmt.run(runId, period, f.metric, f.severity, f.subject, f.subject_kind || null,
        f.expected || null, f.actual || null, f.diff === null || f.diff === undefined ? null : Number(f.diff),
        f.unit || null, f.hint || null, t, t);
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
      SUM(CASE WHEN status IN ('open','assigned','fixed') THEN 1 ELSE 0 END) open_c,
      SUM(CASE WHEN severity='high' THEN 1 ELSE 0 END) high_c
    FROM admin_report_findings WHERE run_id = ?`).get(runId);
  db.prepare('UPDATE admin_report_runs SET finding_count = ?, open_count = ?, high_count = ? WHERE id = ?')
    .run(r.c || 0, r.open_c || 0, r.high_c || 0, runId);
}

function decorFinding(r) {
  return {
    ...r,
    metric_label: METRICS[r.metric] || r.metric,
    severity_label: SEVERITY[r.severity] || r.severity,
    status_label: FINDING_STATUS[r.status] || r.status
  };
}

function runDetail(id) {
  const run = db.prepare('SELECT * FROM admin_report_runs WHERE id = ?').get(id);
  if (!run) throw bad('报表不存在', 404);
  let snapshot = {};
  try { snapshot = JSON.parse(run.snapshot || '{}'); } catch (_) { snapshot = {}; }
  const findings = db.prepare('SELECT * FROM admin_report_findings WHERE run_id = ? ORDER BY CASE severity WHEN \'high\' THEN 0 WHEN \'mid\' THEN 1 ELSE 2 END, id').all(id)
    .map(decorFinding);
  return {
    ...run,
    snapshot,
    findings,
    open_count: findings.filter((f) => ['open', 'assigned', 'fixed'].includes(f.status)).length
  };
}

function listRuns(q = {}) {
  const where = [];
  const params = [];
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  if (q.company_id) { where.push('IFNULL(company_id,0) = ?'); params.push(Number(q.company_id)); }
  const sql = 'SELECT * FROM admin_report_runs ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY period DESC, id DESC LIMIT 60';
  return db.prepare(sql).all(...params).map((r) => {
    let s = {};
    try { s = JSON.parse(r.snapshot || '{}'); } catch (_) { s = {}; }
    return {
      id: r.id, run_no: r.run_no, period: r.period, company_id: r.company_id, company_name: r.company_name,
      finding_count: r.finding_count, open_count: r.open_count, high_count: r.high_count,
      generated_by: r.generated_by, generated_at: r.generated_at,
      summary: s.summary || {}
    };
  });
}

function listFindings(q = {}) {
  const where = [];
  const params = [];
  if (q.run_id) { where.push('run_id = ?'); params.push(Number(q.run_id)); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.metric) { where.push('metric = ?'); params.push(q.metric); }
  if (q.severity) { where.push('severity = ?'); params.push(q.severity); }
  const sql = 'SELECT * FROM admin_report_findings ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    "ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END, id LIMIT 500";
  return db.prepare(sql).all(...params).map(decorFinding);
}

function assignFinding(id, b = {}, actor) {
  const row = db.prepare('SELECT * FROM admin_report_findings WHERE id = ?').get(id);
  if (!row) throw bad('差异项不存在', 404);
  if (['closed', 'ignored'].includes(row.status)) throw bad('已关闭/已忽略的差异项不能再分派');
  const who = str(b.assignee);
  if (!who) throw bad('请填分派给谁 —— 没有人的差异清单不会有人处理');
  db.prepare("UPDATE admin_report_findings SET assignee = ?, due_date = COALESCE(?, due_date), status='assigned', updated_at=? WHERE id=?")
    .run(who, str(b.due_date) || null, now(), id);
  refreshCounts(row.run_id);
  return decorFinding(db.prepare('SELECT * FROM admin_report_findings WHERE id = ?').get(id));
}

/**
 * 复核关闭：必须写结论。
 * 「已处理待复核」与「已关闭」分开 —— 自己处理完自己关，等于没有复核。
 */
function closeFinding(id, b = {}, actor) {
  const row = db.prepare('SELECT * FROM admin_report_findings WHERE id = ?').get(id);
  if (!row) throw bad('差异项不存在', 404);
  if (row.status === 'closed') throw bad('该差异项已关闭');
  if (row.status === 'ignored') throw bad('已忽略的差异项不能关闭；要处理请先重新打开');
  const note = str(b.review_note);
  if (!note) throw bad('关闭差异必须写复核结论 —— 只打个勾的差异，下个月还会出现');

  // 两段式：先「已处理待复核」，再由别人关
  const stage = str(b.stage) || 'fixed';
  if (stage === 'fixed') {
    db.prepare("UPDATE admin_report_findings SET status='fixed', review_note=?, assignee=COALESCE(?, assignee), updated_at=? WHERE id=?")
      .run(note, str(b.assignee) || null, now(), id);
    refreshCounts(row.run_id);
    return decorFinding(db.prepare('SELECT * FROM admin_report_findings WHERE id = ?').get(id));
  }
  if (!['open', 'assigned', 'fixed'].includes(row.status)) throw bad('当前状态不能关闭');
  if (row.status !== 'fixed') throw bad('先点「已处理」并写处理结果，再由别人复核关闭（自己处理自己关等于没有复核）');
  db.prepare("UPDATE admin_report_findings SET status='closed', review_note=?, closed_by=?, closed_at=?, updated_at=? WHERE id=?")
    .run(note, actor || 'system', now(), now(), id);
  refreshCounts(row.run_id);
  return decorFinding(db.prepare('SELECT * FROM admin_report_findings WHERE id = ?').get(id));
}

function ignoreFinding(id, b = {}, actor) {
  const row = db.prepare('SELECT * FROM admin_report_findings WHERE id = ?').get(id);
  if (!row) throw bad('差异项不存在', 404);
  if (row.status === 'closed') throw bad('已关闭的差异项不能忽略');
  const reason = str(b.reason);
  if (reason.length < 6) throw bad('忽略差异必须写理由（≥6 字）—— 否则下个月没人知道为什么这条不算问题');
  db.prepare("UPDATE admin_report_findings SET status='ignored', review_note=?, closed_by=?, closed_at=?, updated_at=? WHERE id=?")
    .run(reason, actor || 'system', now(), now(), id);
  refreshCounts(row.run_id);
  return decorFinding(db.prepare('SELECT * FROM admin_report_findings WHERE id = ?').get(id));
}

function meta() {
  const periods = db.prepare(
    "SELECT period, COUNT(*) c FROM admin_report_runs GROUP BY period ORDER BY period DESC LIMIT 24"
  ).all();
  const months = [];
  const d = new Date();
  for (let i = 0; i < 12; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  return {
    metrics: Object.entries(METRICS).map(([code, label]) => ({ code, label })),
    severities: Object.entries(SEVERITY).map(([code, label]) => ({ code, label })),
    finding_status: Object.entries(FINDING_STATUS).map(([code, label]) => ({ code, label })),
    companies: db.prepare("SELECT id, name, short_name FROM companies WHERE status='active' ORDER BY id").all(),
    periods: months,
    runs: periods
  };
}

module.exports = {
  METRICS, SEVERITY, FINDING_STATUS,
  buildReport, runReport, listRuns, runDetail, listFindings,
  assignFinding, closeFinding, ignoreFinding, meta
};
