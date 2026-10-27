/**
 * 税票银行演示数据（幂等重放）
 *   node scripts/seed-bank-demo.js --reset
 *
 * 造的场景：
 *   - 2 个银行账户：工商银行基本户（启用，期初 5 万）/ 中国银行外币户（已销户）
 *   - 2026-09 / 2026-10 两个月流水 9 条，其中 5 条能自动匹配到收付款单
 *   - 4 条银行独有：手续费、结息、客户直汇（企业未记）、对应已反审单的到账
 *   - 2026-09 对账已确认（差额 0）；2026-10 对账为草稿
 *   - 票据 5 张：应收 3（含 1 张 30 天内到期、1 张已贴现）、应付 2（含 1 张已兑付）
 */
const { db } = require('../src/db');
const { localNow } = require('../src/services/sla');
const B = require('../src/services/bank');

const TAG = 'BANK-DEMO';

function reset() {
  db.prepare('DELETE FROM bank_reconciliation_items').run();
  db.prepare('DELETE FROM bank_reconciliations').run();
  db.prepare('DELETE FROM bank_statement_lines').run();
  db.prepare('DELETE FROM bank_imports').run();
  db.prepare('DELETE FROM bank_bills').run();
  db.prepare('DELETE FROM bank_accounts').run();
  db.prepare('UPDATE payments SET bank_account_id=NULL').run();
}

function seed() {
  const t = localNow();
  const out = [];

  // ---------- 账户 ----------
  const icbc = db.prepare(
    `INSERT INTO bank_accounts (account_no,company_id,bank_name,account_masked,currency,account_type,
       open_balance,open_date,status,note,created_at,updated_at)
     VALUES (?,1,?,?,?,'basic',?,?,'active',?,?,?)`
  ).run('CN-ICBC-001', '中国工商银行义乌支行', '****8866', 'CNY', 50000, '2026-09-01',
    '主结算账户，收客户货款、付供应商', t, t).lastInsertRowid;

  db.prepare(
    `INSERT INTO bank_accounts (account_no,company_id,bank_name,account_masked,currency,account_type,
       open_balance,open_date,status,note,created_at,updated_at)
     VALUES (?,1,?,?,'USD','fx',0,?,'closed',?,?,?)`
  ).run('CN-BOC-002', '中国银行义乌支行', '****2201', '2026-09-01',
    '外币户，已销户（美元收汇改走基本户结汇）', t, t);
  out.push('账户 2 个：工商银行基本户（启用，期初 ¥50,000）/ 中国银行外币户（已销户）');

  // ---------- 流水 ----------
  const lines = [
    { trade_date: '2026-09-25', summary: '货款 美国ABC', counterparty: '示范客户·美国 ABC', direction: 'in', amount: 50000, balance: 100000 },
    { trade_date: '2026-09-26', summary: '付面料款', counterparty: '蒙特布料', direction: 'out', amount: 16400, balance: 83600 },
    { trade_date: '2026-09-28', summary: '货款 美国ABC', counterparty: '示范客户·美国 ABC', direction: 'in', amount: 30000, balance: 113600 },
    { trade_date: '2026-09-30', summary: '账户管理费', counterparty: '工商银行', direction: 'out', amount: 30, balance: 113570 },
    { trade_date: '2026-09-30', summary: '活期结息', counterparty: '工商银行', direction: 'in', amount: 125.6, balance: 113695.6 },
    { trade_date: '2026-10-05', summary: '货款（个人汇入）', counterparty: '陈志强', direction: 'in', amount: 8800, balance: 122495.6 },
    { trade_date: '2026-10-27', summary: '货款 欧洲DEF', counterparty: '示范客户·欧洲 DEF', direction: 'in', amount: 1586, balance: 124081.6 },
    { trade_date: '2026-10-27', summary: '货款 美国ABC', counterparty: '示范客户·美国 ABC', direction: 'in', amount: 860.6, balance: 124942.2 },
    { trade_date: '2026-10-27', summary: '货款 欧洲DEF（重汇）', counterparty: '示范客户·欧洲 DEF', direction: 'in', amount: 2379, balance: 127321.2 }
  ];
  const imp = B.importLines(icbc, lines, { source_name: '工商银行 2026-09~10 对账单.xlsx', operator: 'seed' });
  out.push(`流水导入 ${imp.import_no}：新增 ${imp.added} 条（收入 ¥${imp.in_total} / 支出 ¥${imp.out_total}）`);

  // ---------- 自动匹配 ----------
  const am = B.autoMatch(icbc, { days: 7, operator: 'seed' });
  out.push(`自动匹配：${am.total} 条里对上 ${am.matched} 条，需要人工判断 ${am.ambiguous} 条，无候选 ${am.none} 条`);

  // ---------- 对账 ----------
  const r9 = B.createRecon(icbc, '2026-09', { note: '9 月结账，手续费与结息下月补记', operator: 'seed' });
  B.confirmRecon(r9.id, 'seed');
  out.push(`2026-09 对账 ${r9.recon_no} 已确认：银行 ¥${r9.statement_balance} = 账面 ¥${r9.book_balance} + 银行已收 ¥${r9.bank_only_in} − 银行已付 ¥${r9.bank_only_out}，差额 ${r9.diff_amount}`);

  const r10 = B.createRecon(icbc, '2026-10', { note: '10 月对账待确认：个人汇入 8800 需补记收款单', operator: 'seed' });
  out.push(`2026-10 对账 ${r10.recon_no} 草稿：未达账项 ${r10.items.length} 条，差额 ${r10.diff_amount}（待确认）`);

  // ---------- 票据 ----------
  const insBill = db.prepare(
    `INSERT INTO bank_bills (bill_no,type,direction,drawer,payee,acceptor,accept_type,amount,currency,
       issue_date,due_date,status,partner_type,partner_name,ref_no,discount_rate,discount_cost,cash_in_date,note,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,'CNY',?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  insBill.run('AC2026090001', 'receivable', 'in', '示范客户·美国 ABC', '跳色科技', '中国银行', 'bank', 50000,
    '2026-09-01', '2027-02-28', 'holding', 'customer', '示范客户·美国 ABC', 'SO202609010001',
    null, null, null, '客户付 6 个月银承', 'seed', t, t);

  insBill.run('AC2026100002', 'receivable', 'in', '示范客户·欧洲 DEF', '跳色科技', '示范客户·欧洲 DEF', 'commercial', 20000,
    '2026-10-01', '2026-11-10', 'holding', 'customer', '示范客户·欧洲 DEF', 'SO202610010002',
    null, null, null, '商承，30 天内到期，需提前托收', 'seed', t, t);

  insBill.run('AC2026080003', 'receivable', 'in', '示范客户·美国 ABC', '跳色科技', '中国工商银行', 'bank', 30000,
    '2026-08-15', '2026-10-15', 'discounted', 'customer', '示范客户·美国 ABC', 'SO202608150003',
    3.6, 540, '2026-08-20', '到期前贴现，贴现息 540，实收 29460', 'seed', t, t);

  insBill.run('AP2026090004', 'payable', 'out', '跳色科技', '蒙特布料', '中国工商银行', 'bank', 15000,
    '2026-09-20', '2026-12-20', 'holding', 'supplier', '蒙特布料', 'PO202609200004',
    null, null, null, '付面料款开的银承', 'seed', t, t);

  insBill.run('AP2026070005', 'payable', 'out', '跳色科技', '辅料供应商', '中国工商银行', 'bank', 8000,
    '2026-07-10', '2026-09-10', 'settled', 'supplier', '辅料供应商', 'PO202607100005',
    null, null, null, '已到期兑付', 'seed', t, t);

  const bo = B.billsOverview();
  out.push(`票据 5 张：应收在库 ¥${bo.receivable_total}、应付在库 ¥${bo.payable_total}、30 天内到期 ${bo.due_30} 张、已贴现 ¥${bo.discounted}`);

  return out;
}

if (process.argv.includes('--reset')) { reset(); console.log('[reset] 银行演示数据已清空'); }
const lines = seed();
console.log('\n=== 税票银行演示数据 ===');
lines.forEach((l) => console.log('·', l));

const ov = B.overview();
console.log(`\n资金概览：账户 ${ov.account_count} 个，账面合计 ¥${ov.book_total}，银行合计 ¥${ov.statement_total}，未匹配流水 ${ov.unmatched_total} 条`);
ov.accounts.forEach((a) => console.log(`  ${a.bank_name} ${a.account_masked}  账面 ¥${a.book_balance}  银行 ¥${a.statement_balance}  未匹配 ${a.unmatched_lines} 条`));
