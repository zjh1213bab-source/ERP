/**
 * M12 长期投资抵消 —— 演示数据（幂等）
 * ============================================================
 * 用法：node scripts/seed-investment-demo.js [--reset]
 *
 * 为什么必须造凭证而不是直接插投资记录：
 *   长投是「母公司账上的一笔资产」，子公司实收资本是「子公司账上的一笔权益」。
 *   如果只在投资表里填个数字、两边账上却没有，抵消就成了纸上作业——
 *   合并数减了但账上根本没那笔钱，越抵越乱。所以这里把两边都记账：
 *     母公司：借 1511 长期股权投资 / 贷 1002 银行存款
 *     子公司：借 1002 银行存款   / 贷 4001 实收资本
 *
 * 演示 6 种处境：
 *   ① 全资子公司 + 商誉：美国子公司权益 110 万，母公司投 120 万（100%）→ 商誉 10 万
 *   ② 非全资子公司 + 少数股东权益：越南子公司权益 50 万，母公司持股 70%（投 30 万）
 *      → 应享 35 万、少数股东 15 万、负商誉 5 万（买得便宜，计入营业外收入）
 *   ③ 分公司不抵消：义乌分公司是分支结构，没有股权，合并时直接并入
 *   ④ 成本法 vs 权益法：美国用成本法（分红不动账面），越南用权益法（分红冲账面）
 *   ⑤ 权益法亏损上限：确认亏损不能把长投减成负数
 *   ⑥ 抵消分录借贷必须平、合并后 资产 = 负债 + 权益
 */
const { db } = require('../src/db');
const G = require('../src/services/gl');
const IV = require('../src/services/investment');
const GR = require('../src/services/group');

const TAG = 'inv_demo';
const PERIOD = '2026-09';
const reset = process.argv.includes('--reset');
const VN_CODE = 'VN-SUB';

function clean() {
  const vn = db.prepare('SELECT id FROM companies WHERE code = ?').get(VN_CODE);
  const vnId = vn ? vn.id : null;
  db.exec('BEGIN');
  try {
    // 1) 投资记录与变动
    const invIds = db.prepare('SELECT id FROM equity_investments WHERE demo_tag = ?').all(TAG).map((r) => r.id);
    if (invIds.length) {
      db.prepare(`DELETE FROM equity_investment_changes WHERE investment_id IN (${invIds.map(() => '?').join(',')})`).run(...invIds);
      db.prepare(`DELETE FROM equity_investments WHERE id IN (${invIds.map(() => '?').join(',')})`).run(...invIds);
    }
    // 2) 演示凭证（母公司注资/长投、越南子公司实收资本）
    const vs = db.prepare("SELECT id FROM gl_vouchers WHERE source_type = 'invest_demo'").all().map((r) => r.id);
    if (vs.length) {
      db.prepare(`DELETE FROM gl_entries WHERE voucher_id IN (${vs.map(() => '?').join(',')})`).run(...vs);
      db.prepare(`DELETE FROM gl_vouchers WHERE id IN (${vs.map(() => '?').join(',')})`).run(...vs);
    }
    // 3) 越南子公司（连同它的凭证一起删）
    if (vnId) {
      const vvs = db.prepare('SELECT id FROM gl_vouchers WHERE company_id = ?').all(vnId).map((r) => r.id);
      if (vvs.length) {
        db.prepare(`DELETE FROM gl_entries WHERE voucher_id IN (${vvs.map(() => '?').join(',')})`).run(...vvs);
        db.prepare(`DELETE FROM gl_vouchers WHERE id IN (${vvs.map(() => '?').join(',')})`).run(...vvs);
      }
      db.prepare('DELETE FROM companies WHERE id = ?').run(vnId);
    }
    // 4) 演示合并表（含长投抵消的旧结果）
    const cons = db.prepare("SELECT id FROM consolidations WHERE note LIKE '%长期投资演示%'").all().map((r) => r.id);
    if (cons.length) {
      db.prepare(`DELETE FROM consolidation_adjustments WHERE con_id IN (${cons.map(() => '?').join(',')})`).run(...cons);
      db.prepare(`DELETE FROM consolidations WHERE id IN (${cons.map(() => '?').join(',')})`).run(...cons);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

let seq = 0;
function voucher(companyId, summary, entries) {
  seq += 1;
  return G.writeVoucher({
    period: PERIOD, biz_date: `${PERIOD}-15`, summary,
    source_type: 'invest_demo', source_id: seq,
    entries, operator: 'demo', company_id: companyId
  });
}

function seed() {
  // ---- 0. 母公司先注入资本（否则没钱对外投资，银行存款会变成负数）----
  voucher(1, '股东增资（用于对外投资）', [
    { code: '1002', debit: 1800000, credit: 0 },
    { code: '4001', debit: 0, credit: 1800000 }
  ]);

  // ---- 1. 新建越南子公司（70% 持股的那家）----
  const t = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const vnId = Number(db.prepare(
    `INSERT INTO companies (code, name, short_name, type, parent_id, status, consolidation, base_currency, created_at)
     VALUES (?,?,?, 'subsidiary', 1, 'active', 1, 'CNY', ?)`
  ).run(VN_CODE, '跳色（越南）制造有限公司', '越南子公司', t).lastInsertRowid);

  // 越南子公司收到股东出资 50 万（母公司 30 万 + 少数股东 20 万）
  G.writeVoucher({
    period: PERIOD, biz_date: `${PERIOD}-12`, summary: '股东出资（母公司 30 万 + 少数股东 20 万）',
    source_type: 'invest_demo', source_id: 9001,
    entries: [
      { code: '1002', debit: 500000, credit: 0 },
      { code: '4001', debit: 0, credit: 500000 }
    ],
    operator: 'demo', company_id: vnId
  });

  // ---- 2. 母公司记两笔长投（钱真的出去了）----
  voucher(1, '对美国子公司投资（持股 100%）', [
    { code: '1511', debit: 1200000, credit: 0 },
    { code: '1002', debit: 0, credit: 1200000 }
  ]);
  voucher(1, '对越南子公司投资（持股 70%）', [
    { code: '1511', debit: 300000, credit: 0 },
    { code: '1002', debit: 0, credit: 300000 }
  ]);

  // ---- 3. 两条投资记录 ----
  const us = db.prepare("SELECT id, name FROM companies WHERE code = 'US-SUB'").get();
  const invUs = IV.create({
    company_id: 1, investee_id: us.id, method: 'cost',
    acquire_date: `${PERIOD}-15`, acquire_cost: 1200000, share_pct: 100,
    note: '美国销售子公司，全资；投资成本 120 万 > 应享权益 110 万，差额为商誉', demo_tag: TAG
  }, 'demo');
  const invVn = IV.create({
    company_id: 1, investee_id: vnId, method: 'equity',
    acquire_date: `${PERIOD}-12`, acquire_cost: 300000, share_pct: 70,
    note: '越南制造子公司，持股 70%；权益法核算', demo_tag: TAG
  }, 'demo');

  // ---- 4. 变动演示 ----
  // 成本法：收到分红只确认投资收益，**不动账面价值**（这是成本法的关键）
  IV.addChange(invUs.id, {
    type: 'dividend', amount: 50000, change_date: `${PERIOD}-25`,
    reason: '美国子公司分配 2025 年度利润，成本法下只确认投资收益，不冲减长投账面'
  }, 'demo');
  // 权益法：确认投资损益（子公司当期利润 × 持股比例）
  IV.addChange(invVn.id, {
    type: 'equity_share', amount: 35000, change_date: `${PERIOD}-28`,
    reason: '越南子公司当期净利润 5 万 × 70% = 3.5 万，按权益法确认投资损益'
  }, 'demo');

  console.log(`[1] 母公司注资 180 万 + 两笔长投（美国 120 万 / 越南 30 万）已记账`);
  console.log(`[2] 越南子公司已建（持股 70%）：权益 50 万，应享 35 万，少数股东 15 万`);
  console.log(`[3] 成本法分红 5 万（不冲账面，账面仍 ${IV.bookOf(db.prepare('SELECT * FROM equity_investments WHERE id=?').get(invUs.id))}）`);
  console.log(`[4] 权益法确认损益 3.5 万（账面 ${IV.bookOf(db.prepare('SELECT * FROM equity_investments WHERE id=?').get(invVn.id))}）`);
  return { us, vnId, invUs, invVn };
}

(function main() {
  if (reset) { clean(); console.log('[0] 已清理旧演示数据'); }
  else {
    const exists = db.prepare('SELECT COUNT(*) c FROM equity_investments WHERE demo_tag = ?').get(TAG).c;
    if (exists) { console.log('演示数据已存在；要重放请加 --reset'); return; }
  }
  seed();

  // ---- 抵消预览 ----
  const off = IV.computeOffsets(PERIOD);
  console.log(`\n--- ${PERIOD} 长期投资抵消预览 ---`);
  off.items.forEach((x) => {
    console.log(`  ${x.investee_name}（持股 ${x.share_pct}%，${x.method_label}）`);
    console.log(`    子公司权益 ${x.equity_total}  应享 ${x.share_equity}  少数股东 ${x.minority_equity}`);
    console.log(`    长投账面 ${x.book_value}  →  商誉 ${x.goodwill}${x.bargain_gain ? `  负商誉 ${x.bargain_gain}` : ''}`);
  });
  console.log(`  抵消合计：资产 −${off.total.asset_adj} / 权益 −${off.total.equity_adj}（应相等）`);
  console.log(`  商誉 ${off.total.goodwill} / 少数股东权益 ${off.total.minority_equity} / 负商誉 ${off.total.bargain_gain}`);
  console.log(`  借贷平衡：借 ${off.total.debit} / 贷 ${off.total.credit} → ${off.total.balanced ? '平' : '不平！'}`);
  console.log(`  平衡自检：资产影响 − 权益影响 = ${off.check.diff} → ${off.check.asset_eq_equity ? '恒等' : '不等！'}`);
  if (off.issues.length) {
    console.log('  提示：');
    off.issues.forEach((i) => console.log(`    [${i.level}] ${i.detail}`));
  }

  // ---- 生成一张含长投抵消的合并表 ----
  const con = GR.buildConsolidation(PERIOD, 'demo');
  console.log(`\n--- 合并表 ${con.con_no} ---`);
  console.log(`  资产 ${con.asset_total} / 负债 ${con.liability_total} / 权益 ${con.equity_total}`);
  console.log(`  商誉 ${con.investment.total.goodwill} / 少数股东权益 ${con.investment.total.minority_equity} / 负商誉 ${con.investment.total.bargain_gain}`);
  console.log(`  平衡：资产 − 负债 − 权益 = ${con.diff_amount} → ${con.balanced ? '平' : '不平！'}`);
  console.log(`  抵消分录 ${con.adjustments.filter((a) => a.type === 'investment').length} 条（长期投资）`);
  db.prepare("UPDATE consolidations SET note = ? WHERE id = ?").run('长期投资演示（含长投抵消/商誉/少数股东权益）', con.id);
  console.log('\n演示数据就绪。');
})();
