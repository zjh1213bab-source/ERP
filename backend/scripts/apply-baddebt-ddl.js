/**
 * 坏账准备计提：建表 + 补科目 + 播种比例
 *
 * ## 为什么要有这个
 * 应收账款 450 万挂在那里，账上看起来都是资产。但其中逾期 90 天以上的那部分，
 * 实际能收回来的可能不到一半。会计上必须按账龄计提「坏账准备」，
 * 把这部分从资产里减掉 —— 否则利润是虚的，报表给银行/投资人看也不成立。
 *
 * ## 关键口径：计的是「期末准备余额」，不是「本期费用」
 * 坏账准备是**余额**概念（备抵科目 1231 的贷方余额），不是每期都按应收乘一遍比例记费用。
 * 如果那样做，第 2 个月会再提一次同样金额，准备越滚越大，纯属虚增费用。
 *
 * 所以每期做的是**差额**：
 *   本期计提额 = 期末应有准备余额 − 期初期末已有的准备余额
 * 正数补提（借 6702 贷 1231），负数冲回（借 1231 贷 6702）。
 *
 * ## 科目
 *   1231 坏账准备      asset / credit  ← 备抵科目，资产表里按负数抵减应收
 *   6702 资产减值损失  expense / debit ← 进利润表
 * 现有的资产负债表已支持 `type='asset' AND direction='credit'` 按负数处理（1602 累计折旧同理），
 * 所以不用改报表逻辑。
 */
const { db, now } = require('../src/db');

const t = now();

// ---------- 1. 科目 ----------
const ACCTS = [
  ['1231', '坏账准备', 'asset', 'credit', '1221', 0, 31, '应收款项坏账准备（备抵科目，贷方余额）'],
  ['6702', '资产减值损失', 'expense', 'debit', null, 1, 690, '计提坏账准备等资产减值损失']
];
ACCTS.forEach(([code, name, type, direction, parent, isLeaf, sortNo, remark]) => {
  const has = db.prepare('SELECT id FROM gl_accounts WHERE code = ?').get(code);
  if (has) {
    console.log(`科目 ${code} ${name} 已存在`);
    return;
  }
  db.prepare(
    `INSERT INTO gl_accounts (code, name, type, direction, parent_code, is_leaf, status, sort_no, remark, created_at)
     VALUES (?,?,?,?,?,?,'active',?,?,?)`
  ).run(code, name, type, direction, parent, isLeaf, sortNo, remark, t);
  console.log(`新建科目 ${code} ${name}（${type}/${direction}）`);
});

// ---------- 2. 计提比例表 ----------
db.exec(`
CREATE TABLE IF NOT EXISTS bad_debt_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL DEFAULT 1,
  bucket TEXT NOT NULL,                         -- current / d1_30 / d31_60 / d61_90 / d90p
  rate REAL NOT NULL DEFAULT 0,                 -- 计提比例（%）
  note TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_badpolicy ON bad_debt_policies(company_id, bucket);
`);

// ---------- 3. 默认比例 ----------
// 只说一句话：**逾得越久提得越多**。具体比例各行业不同，这里给一档常见的起步值，可在页面上改。
const DEFAULT_RATES = [
  ['current', 1, '未到期：信用期内，风险很低'],
  ['d1_30', 5, '逾期 1-30 天：刚过期，多数能收回'],
  ['d31_60', 10, '逾期 31-60 天：需要盯'],
  ['d61_90', 30, '逾期 61-90 天：明显变差'],
  ['d90p', 50, '逾期 90 天以上：一半以上收不回']
];
const cos = db.prepare('SELECT id, name FROM companies ORDER BY id').all();
(cos.length ? cos : [{ id: 1, name: '默认主体' }]).forEach((co) => {
  DEFAULT_RATES.forEach(([bucket, rate, note]) => {
    const has = db
      .prepare('SELECT id FROM bad_debt_policies WHERE company_id = ? AND bucket = ?')
      .get(co.id, bucket);
    if (has) return;
    db.prepare(
      'INSERT INTO bad_debt_policies (company_id, bucket, rate, note, created_at, updated_at) VALUES (?,?,?,?,?,?)'
    ).run(co.id, bucket, rate, note, t, t);
  });
  console.log(`主体 ${co.id}（${co.name}）比例已就绪`);
});

const n = db.prepare('SELECT COUNT(*) c FROM bad_debt_policies').get().c;
console.log(`\nbad_debt_policies: ${n} 行`);
console.log(db.prepare('SELECT company_id, bucket, rate FROM bad_debt_policies ORDER BY company_id, id').all()
  .map((x) => `  主体${x.company_id} ${x.bucket} ${x.rate}%`).join('\n'));
console.log('坏账准备表结构就绪');
