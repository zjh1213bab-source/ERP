/**
 * 税负测算演示数据（M12 / N12-06）
 * ------------------------------------------------------------
 * 要演的五件事：
 *   1) 税率按「主体 × 税区 × 税种」配，不是全公司一个 13%
 *   2) 改过税率的主体会留下 superseded 旧政策（历史批次的税率能解释）
 *   3) 中国税区算增值税+附加+所得税+出口退税；美国税区没有增值税，只算所得税
 *   4) 进货月（10 月）进项远大于销项 → 留抵，不是退税
 *   5) 亏损月所得税为 0，且要说明「亏损可结转」
 *
 * 用法：node scripts/seed-tax-demo.js --reset
 */
const { db } = require('../src/db');
const T = require('../src/services/tax');
const { localNow, localDate } = require('../src/services/sla');

const TAG = 'TAXDEMO';
const RESET = process.argv.includes('--reset');
const OP = '税务演示';
const APPROVER = '财务-陈默';

function reset() {
  const out = {};
  out.runs = db.prepare('DELETE FROM tax_runs WHERE demo_tag=?').run(TAG).changes;
  db.prepare('DELETE FROM tax_run_items WHERE run_id NOT IN (SELECT id FROM tax_runs)').run();
  out.policies = db.prepare('DELETE FROM tax_policies WHERE remark LIKE ?').run(`%${TAG}%`).changes;
  return out;
}

function main() {
  const today = localDate();
  const lines = [];

  const mk = (b) => T.createPolicy({ ...b, remark: `${b.remark || ''} ${TAG}`.trim() }, OP);

  // ---------- 1. 总部（中国税区）----------
  // 先造一条「老税率」再被新政策替代：演示改税率不覆盖历史
  mk({
    company_id: 1, tax_region: 'CN', tax_type: 'vat', name: '增值税（16% 旧税率）',
    rate: 16, price_includes_tax: 1, effective_from: '2016-05-01', effective_to: '2019-03-31',
    policy_no: '财税〔2016〕36号', remark: '历史税率'
  });
  const vat13 = mk({
    company_id: 1, tax_region: 'CN', tax_type: 'vat', name: '增值税（货物销售）',
    rate: 13, price_includes_tax: 1, effective_from: '2019-04-01',
    policy_no: '财政部 税务总局 海关总署公告2019年第39号'
  });
  const sur12 = mk({
    company_id: 1, tax_region: 'CN', tax_type: 'surcharge', name: '附加税（城建7%+教育3%+地方教育2%）',
    rate: 12, price_includes_tax: 0, effective_from: '2019-04-01'
  });
  const cit25 = mk({
    company_id: 1, tax_region: 'CN', tax_type: 'cit', name: '企业所得税（法定税率）',
    rate: 25, price_includes_tax: 0, effective_from: '2008-01-01'
  });
  const rb13 = mk({
    company_id: 1, tax_region: 'CN', tax_type: 'export_rebate', name: '出口退税（服装类）',
    rate: 13, price_includes_tax: 0, effective_from: '2020-03-20'
  });
  lines.push('总部（CN）：增值税 13% / 附加税 12% / 所得税 25% / 出口退税 13%，另有 16% 旧税率留档');

  // ---------- 2. 义乌分公司 ----------
  mk({ company_id: 2, tax_region: 'CN', tax_type: 'vat', name: '增值税（货物销售）', rate: 13, price_includes_tax: 1, effective_from: '2019-04-01' });
  mk({ company_id: 2, tax_region: 'CN', tax_type: 'surcharge', name: '附加税', rate: 12, price_includes_tax: 0, effective_from: '2019-04-01' });
  mk({ company_id: 2, tax_region: 'CN', tax_type: 'cit', name: '企业所得税', rate: 25, price_includes_tax: 0, effective_from: '2008-01-01' });
  lines.push('义乌（CN）：增值税 13% / 附加税 12% / 所得税 25%（分公司独立核算）');

  // ---------- 3. 美国公司（无增值税）----------
  mk({ company_id: 3, tax_region: 'US', tax_type: 'cit', name: '美国联邦企业所得税（C-Corp）', rate: 21, price_includes_tax: 0, effective_from: '2018-01-01' });
  lines.push('美国（US）：只配所得税 21% —— 美国税区没有增值税，所以不要求配 vat');

  // ---------- 4. 测算批次 ----------
  const save = (companyId, period, region) => {
    const r = T.saveRun(companyId, period, region, { note: '演示测算' }, OP);
    db.prepare('UPDATE tax_runs SET demo_tag=? WHERE id=?').run(TAG, r.id);
    return r;
  };

  // 9 月：已确认（可对比）
  const sep = save(1, '2026-09', 'CN');
  T.confirmRun(sep.id, { note: '9 月税负确认，与申报表核对后归档' }, APPROVER);

  // 10 月：草稿（进货月，留抵大）
  const oct = save(1, '2026-10', 'CN');

  // 义乌 9 月：草稿
  const yw = save(2, '2026-09', 'CN');

  lines.push(`测算批次 3 份：总部 9 月（已确认）/ 总部 10 月（草稿，进货月留抵）/ 义乌 9 月（草稿）`);
  lines.push(`总部 9 月：收入 ${sep.revenue_total} / 应纳增值税 ${sep.vat_payable} / 留抵 ${sep.credit_carry} / 所得税 ${sep.cit_amount} / 税负率 ${sep.burden_rate}%`);
  lines.push(`总部 10 月：收入 ${oct.revenue_total} / 留抵 ${oct.credit_carry} / 所得税 ${oct.cit_amount}（亏损）`);

  // ---------- 5. 美国公司：不建批次，只留出「可按需测算」的配置 ----------
  lines.push('美国公司仅配税率、未建批次：测算时用它演示「不同税区税种不同」');
  return lines;
}

if (RESET) {
  const r = reset();
  console.log('[tax-demo] reset', JSON.stringify(r));
}
const out = main();
console.log('[tax-demo] 写入完成：');
out.forEach((l) => console.log('  - ' + l));
console.log(`[tax-demo] 基准日 ${localDate()}`);
