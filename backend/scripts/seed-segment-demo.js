/**
 * 分公司经营对比 —— 演示数据（可重复重放）
 * ============================================================
 * 用法：
 *   node scripts/seed-segment-demo.js           # 增量补齐
 *   node scripts/seed-segment-demo.js --reset    # 先清掉本演示的数据再重建
 *
 * 在「多主体与集团合并」演示（总部 + 义乌分公司 + 美国子公司）之上补三样对比必须的东西：
 *   1. **在职人数**（原来只有总部 11 人）→ 义乌 8 人 / 美国 3 人，人均指标才出得来；
 *   2. **上期（2026-08）外部销售**→ 环比才有同口径基数（现在两家上期都是空的，环比全「—」）；
 *   3. **可比口径调整**（一次性损益 / 总部费用分摊）→ 演示「账载净利 ≠ 可比净利」；
 *   4. 义乌 2026-09 的成本结转（原来只有收入没有成本，净利 = 收入，明显不真实）。
 *
 * 演示出来的四个「真实处境」：
 *   - 义乌：收入 80 万**全部是卖给美国子公司**，对外收入 0 → 「内部依赖 100%」，排名不参与
 *   - 美国：对外收入 80 万、费用率很高 → 但本期**未关账**，不进排名
 *   - 总部：对外 21.65 万 → 唯一可排名主体
 *   - 分部之和 − 合并数 ≠ 已识别内部收入（差 5 万）→ 报 `ic_mismatch`，不抹平
 */
const { db, now } = require('../src/db');
const G = require('../src/services/gl');
const S = require('../src/services/segments');

const RESET = process.argv.includes('--reset');
const PERIOD = '2026-09';
const PREV = '2026-08';
const TAG = 'seg-demo';

const XS = (v) => `${v}`;

function clear() {
  db.prepare('DELETE FROM segment_adjustments WHERE demo_tag = ?').run(TAG);
  db.prepare('DELETE FROM segment_reports WHERE demo_tag = ?').run(TAG);
  // 演示凭证按 source_type 前缀清（只删自己写的）
  const vids = db.prepare("SELECT id FROM gl_vouchers WHERE source_type LIKE 'seg_demo%'").all().map((x) => x.id);
  if (vids.length) {
    const inSql = vids.map(() => '?').join(',');
    db.prepare(`DELETE FROM gl_entries WHERE voucher_id IN (${inSql})`).run(...vids);
    db.prepare(`DELETE FROM gl_vouchers WHERE id IN (${inSql})`).run(...vids);
  }
  // 演示员工与任职
  const emps = db.prepare("SELECT id FROM employees WHERE code LIKE 'SEG%'").all().map((x) => x.id);
  if (emps.length) {
    const inSql = emps.map(() => '?').join(',');
    // 员工删了，他的周报就成了孤儿行（周报列表会把死行过滤掉，但会占 LIMIT 位）
    db.prepare(`DELETE FROM ai_weekly WHERE subject_id IN (${inSql})`).run(...emps);
    db.prepare(`DELETE FROM employments WHERE employee_id IN (${inSql})`).run(...emps);
    db.prepare(`DELETE FROM employees WHERE id IN (${inSql})`).run(...emps);
  }
  console.log('[reset] 已清理本演示的员工/任职、演示凭证、调整与报告');
}

// ============ 1. 在职人数 ============
const HEADCOUNT = [
  { company: 2, dept: 19, code: 'SEG-YW', names: ['王亚楠', '李小军', '周敏', '陈建平', '吴芳', '徐磊', '郑海涛', '孙丽'] },
  { company: 3, dept: 20, code: 'SEG-US', names: ['Mike Chen', 'Linda Wang', 'David Ruiz'] }
];

function seedHeadcount() {
  const t = now();
  let n = 0;
  HEADCOUNT.forEach((g) => {
    g.names.forEach((name, i) => {
      const code = `${g.code}-${String(i + 1).padStart(2, '0')}`;
      const exist = db.prepare('SELECT id FROM employees WHERE code = ?').get(code);
      let empId = exist && exist.id;
      if (!empId) {
        empId = Number(db.prepare(
          'INSERT INTO employees (code, name, department_id, position, hire_date, status, remark, created_at) VALUES (?,?,?,?,?,?,?,?)'
        ).run(code, name, g.dept, g.company === 2 ? '生产/跟单' : '运营', '2025-06-01', 'active', '分部对比演示', t).lastInsertRowid);
      }
      const has = db.prepare("SELECT 1 x FROM employments WHERE employee_id=? AND status='effective'").get(empId);
      if (!has) {
        db.prepare(
          `INSERT INTO employments (employment_no, employee_id, employer_company_id, service_company_id, department_id,
             employment_type, start_date, status, reason, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,'fulltime','2025-06-01','effective','新入职',?,?,?)`
        ).run(`EMP${String(empId).padStart(8, '0')}`, empId, g.company, g.company, g.dept, 'admin', t, t);
      }
      n += 1;
    });
  });
  console.log(`[1] 在职人数：义乌 8 人 + 美国 3 人（共 ${n} 条任职）`);
}

// ============ 2. 上期外部销售 + 本期成本 ============
function voucher(o) {
  G.writeVoucher({
    period: o.period,
    biz_date: `${o.period}-15`,
    summary: o.summary,
    source_type: o.source,
    source_id: o.sourceId || null,
    company_id: o.company,
    operator: 'admin',
    entries: o.entries
  });
}

function existsVoucher(source, period, company) {
  return !!db.prepare('SELECT 1 x FROM gl_vouchers WHERE source_type=? AND period=? AND company_id=?').get(source, period, company);
}

function seedVouchers() {
  // 上期（2026-08）：两家各有外部销售，环比的同口径基数
  if (!existsVoucher('seg_demo_prev_sale', PREV, 2)) {
    voucher({
      period: PREV, company: 2, source: 'seg_demo_prev_sale', sourceId: 1,
      summary: '8 月外销：杭州外贸公司（外部客户）',
      entries: [
        { code: '1122', debit: 400000, summary: '应收账款', partner_name: '杭州外贸公司' },
        { code: '6001', credit: 400000, summary: '主营业务收入', partner_name: '杭州外贸公司' }
      ]
    });
    voucher({
      period: PREV, company: 2, source: 'seg_demo_prev_cost', sourceId: 2,
      summary: '8 月成本结转（加工费）',
      entries: [
        { code: '6401', debit: 300000, summary: '主营业务成本' },
        { code: '2202', credit: 300000, summary: '应付账款' }
      ]
    });
  }
  if (!existsVoucher('seg_demo_prev_sale', PREV, 3)) {
    voucher({
      period: PREV, company: 3, source: 'seg_demo_prev_sale', sourceId: 3,
      summary: '8 月外销：West Coast Apparel（外部客户）',
      entries: [
        { code: '1122', debit: 300000, summary: '应收账款', partner_name: 'West Coast Apparel Inc.' },
        { code: '6001', credit: 300000, summary: '主营业务收入', partner_name: 'West Coast Apparel Inc.' }
      ]
    });
    voucher({
      period: PREV, company: 3, source: 'seg_demo_prev_cost', sourceId: 4,
      summary: '8 月成本结转',
      entries: [
        { code: '6401', debit: 250000, summary: '主营业务成本' },
        { code: '2202', credit: 250000, summary: '应付账款' }
      ]
    });
  }

  // 本期（2026-09）义乌已关账并做过损益结转：**不能再补凭证**（会让权益与损益对不上，合并表直接不平）。
  // 成本未入账这件事，改在「可比口径调整」里补提，账载数不动——这正是「调整不改账」的用途。
  // 2026-08 的利润要结转到本年利润，否则累计到 2026-09 的资产负债表会少一块权益、合并就不平了
  [2, 3].forEach((co) => {
    const r = G.carryProfit(PREV, 'admin', co);
    if (r && r.skipped) console.log('    2026-08 主体', co, '已结转');
  });
  console.log('[2] 凭证：2026-08 两家外部销售与成本（并结转损益，保证累计权益对得上）');
}

// ============ 3. 可比口径调整 ============
function seedAdjustments() {
  const t = now();
  const rows = [
    {
      company: 2, kind: 'other', amount: -560000,
      note: '成本未入账：9 月内部订单加工费 56 万未结转，可比口径下补提（账载净利 80 万虚高）'
    },
    {
      company: 2, kind: 'one_off', amount: 50000,
      note: '剔除 9 月一次性清尾货折价损失 5 万（非经常性，影响可比）'
    },
    {
      company: 3, kind: 'allocation', amount: -120000,
      note: '补提总部品牌与研发费用分摊 12 万（按对外收入 78.7% 分摊，账面未计入）'
    }
  ];
  rows.forEach((r) => {
    const has = db.prepare('SELECT 1 x FROM segment_adjustments WHERE company_id=? AND period=? AND note=?').get(r.company, PERIOD, r.note);
    if (has) return;
    db.prepare(
      'INSERT INTO segment_adjustments (company_id, period, kind, amount, note, created_by, created_at, demo_tag) VALUES (?,?,?,?,?,?,?,?)'
    ).run(r.company, PERIOD, r.kind, r.amount, r.note, 'admin', t, TAG);
  });
  console.log('[3] 可比口径调整 3 条（义乌：未入账成本补提 + 一次性损失；美国：总部费用分摊）');
}

// ============ 4. 报告快照 ============
function seedReports() {
  const has = db.prepare("SELECT id FROM segment_reports WHERE period=? AND demo_tag=?").get(PERIOD, TAG);
  if (has) {
    console.log('[4] 报告已存在，跳过');
    return;
  }
  const r1 = S.generateReport(PERIOD, 'admin', '9 月分部经营对比（会前版）');
  db.prepare('UPDATE segment_reports SET demo_tag=? WHERE id=?').run(TAG, r1.id);
  S.confirmReport(r1.id, 'admin', '经营会已过，按此版对外口径');
  const r2 = S.generateReport(PERIOD, 'admin', '补录可比调整后重算（待重新确认）');
  db.prepare('UPDATE segment_reports SET demo_tag=? WHERE id=?').run(TAG, r2.id);
  console.log(`[4] 报告：${r1.report_no} 已确认（冻结）；${r2.report_no} 草稿（重算后待确认）`);
}

if (RESET) clear();
seedHeadcount();
seedVouchers();
seedAdjustments();
seedReports();

console.log('\n=== 演示数据就绪 ===');
const b = S.board(PERIOD);
b.companies.forEach((x) => {
  console.log(`  ${String(x.short_name).padEnd(12)} 收入 ${String(x.income).padStart(9)} 内部 ${String(x.ic_income).padStart(8)} 对外 ${String(x.external_income).padStart(9)} 净利 ${String(x.net).padStart(8)} 可比 ${String(x.comparable_net).padStart(8)} 人数 ${x.headcount} 环比 ${x.income_mom === null ? '—' : x.income_mom + '%'}｜${(x.tags || []).map((t) => t.label).join(' ') || '正常'}`);
});
console.log(`  合计：对外收入 ${b.total.external_income}，内部收入 ${b.total.ic_income}，合并数 ${b.consolidated ? b.consolidated.income_total : '无'}，差 ${b.ic_amount}`);
console.log(`  口径问题：${b.issues.length} 条（硬 ${b.issues.filter((i) => i.level === 'block').length}）`);
void XS;
