/**
 * 供应商评价与备用产能 DDL（P1 / 原型 TS-N07-05）
 *   node scripts/apply-supplier-eval-ddl.js && node scripts/rebuild-schema.js
 *
 * 1) purchase_orders / goods_receipts 补 supplier_id：评价必须挂在供应商档案上，不能只靠名字
 * 2) supplier_evaluations：一次评价 = 一个观察期 × 一家供应商，样本从收料单自动汇总
 * 3) supplier_rectifications：整改单（评价 C/D 必须开，闭环前资格不得回升）
 * 4) supplier_backups：备用产能，技术/封样/合规三项验证齐了才算可用
 * 5) supplier_qualifications：当前供货资格（一供应商一行），采购下单时按它卡
 */
const { db } = require('../src/db');

function cols(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch (e) { return []; }
}

function add(table, col, ddl) {
  const c = cols(table);
  if (c.length && !c.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    console.log(`  + ${table}.${col}`);
  }
}

console.log('补 supplier_id：');
add('purchase_orders', 'supplier_id', 'INTEGER');   // 指向 suppliers.id
add('goods_receipts', 'supplier_id', 'INTEGER');

const DDL = [
  // 评价：样本全部来自真实收料单，不手填
  `CREATE TABLE IF NOT EXISTS supplier_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ev_no TEXT UNIQUE NOT NULL,                  -- SE+日期+序号
  supplier_id INTEGER NOT NULL,
  supplier_name TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,

  -- 准交（分母只算有承诺交货日的采购单）
  sample_total INTEGER NOT NULL DEFAULT 0,     -- 准交分母
  on_time_count INTEGER NOT NULL DEFAULT 0,
  late_count INTEGER NOT NULL DEFAULT 0,
  late_days_sum INTEGER NOT NULL DEFAULT 0,
  no_due_count INTEGER NOT NULL DEFAULT 0,     -- 未设承诺日的样本（不进分母，单列透明）

  -- 质量（分母只算已检验数量）
  recv_qty REAL NOT NULL DEFAULT 0,
  pass_qty REAL NOT NULL DEFAULT 0,
  freeze_qty REAL NOT NULL DEFAULT 0,
  reject_qty REAL NOT NULL DEFAULT 0,
  inspected_qty REAL NOT NULL DEFAULT 0,
  short_orders INTEGER NOT NULL DEFAULT 0,     -- 短收单数
  over_orders INTEGER NOT NULL DEFAULT 0,      -- 超收单数

  -- 结果
  on_time_rate REAL,                           -- 准交率 %
  defect_rate REAL,                            -- 不良率 % = (冻结+退回)/已检验
  quality_score REAL,                          -- 质量分 0-100
  price_score REAL,                            -- 报价条件分（人工 0-100，空则按 60 中性）
  score REAL,                                  -- 综合分
  grade TEXT,                                  -- A / B / C / D / NA

  -- 负荷
  capacity_qty REAL,                           -- 有效产能（月）
  used_qty REAL,                               -- 已占用
  remaining_qty REAL,                          -- 剩余负荷

  status TEXT NOT NULL DEFAULT 'sufficient',    -- sufficient 样本足够 / insufficient 样本不足 / improve 需改进
  action TEXT,                                 -- keep 维持 / rectify 整改 / verify_backup 备用验证 / suspend 暂停
  conclusion TEXT,
  evidence TEXT,                               -- 证据（检验报告/照片/对账记录）
  evaluated_by TEXT,
  evaluated_at TEXT,
  created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sev_supplier ON supplier_evaluations(supplier_id, period_end)`,

  // 整改单
  `CREATE TABLE IF NOT EXISTS supplier_rectifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rect_no TEXT UNIQUE NOT NULL,                -- ZG+日期+序号
  ev_id INTEGER,                               -- 来源评价
  supplier_id INTEGER NOT NULL,
  supplier_name TEXT,
  issue TEXT NOT NULL,                         -- 问题（准交/质量/短收…）
  action TEXT NOT NULL,                        -- 整改要求
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',          -- open 整改中 / submitted 已提交 / verified 已验证 / failed 未通过
  submit_note TEXT,
  submitted_at TEXT,
  verify_note TEXT,
  verified_by TEXT,
  verified_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_srect_supplier ON supplier_rectifications(supplier_id, status)`,

  // 备用产能 / 备用工厂
  `CREATE TABLE IF NOT EXISTS supplier_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL,
  supplier_name TEXT,
  scope TEXT,                                  -- 适用范围：面料 / 辅料 / 成衣加工 / 水洗印花
  item_desc TEXT,                              -- 可做的具体品类或款号范围
  tech_ok INTEGER NOT NULL DEFAULT 0,          -- 技术验证（能不能做）
  sample_ok INTEGER NOT NULL DEFAULT 0,        -- 封样验证（做出来对不对）
  compliance_ok INTEGER NOT NULL DEFAULT 0,    -- 合规验证（资质/验厂/环保）
  verify_note TEXT,
  evidence TEXT,                               -- 证据（封样单号/验厂报告/资质到期日）
  capacity_qty REAL,                           -- 有效产能（月）
  used_qty REAL,                               -- 已占用
  price_ref REAL,                              -- 参考价（只做参考，不参与排序）
  lead_days INTEGER,                           -- 承诺交期（天）
  status TEXT NOT NULL DEFAULT 'pending',       -- pending 待验证 / verified 可用 / rejected 不通过 / expired 已过期
  verified_by TEXT,
  verified_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sbak_supplier ON supplier_backups(supplier_id, status)`,

  // 当前供货资格：一供应商一行
  `CREATE TABLE IF NOT EXISTS supplier_qualifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL UNIQUE,
  supplier_name TEXT,
  status TEXT NOT NULL DEFAULT 'observing',     -- qualified 合格 / conditional 有条件 / observing 观察期 / suspended 暂停
  reason TEXT,
  based_ev_id INTEGER,                         -- 依据哪次评价
  effective_from TEXT,
  effective_to TEXT,
  decided_by TEXT,
  decided_at TEXT,
  updated_at TEXT
  )`
];

DDL.forEach((sql) => db.exec(sql));
console.log('新增 4 张表 / 3 个索引');

// 按名字回填 supplier_id（历史数据只有名字）
const map = db.prepare('SELECT id, name, short_name FROM suppliers').all();
const matchByName = (name) => {
  if (!name) return null;
  const hit = map.find((s) => s.name === name) || map.find((s) => s.short_name === name) || map.find((s) => name.includes(s.name) || s.name.includes(name));
  return hit ? hit.id : null;
};

['purchase_orders', 'goods_receipts'].forEach((tb) => {
  const rows = db.prepare(`SELECT id, supplier FROM ${tb} WHERE supplier_id IS NULL AND supplier IS NOT NULL`).all();
  let n = 0;
  rows.forEach((r) => {
    const sid = matchByName(r.supplier);
    if (sid) { db.prepare(`UPDATE ${tb} SET supplier_id = ? WHERE id = ?`).run(sid, r.id); n++; }
  });
  console.log(`  ${tb} 回填 ${n}/${rows.length}`);
});

console.log('完成。记得执行 scripts/rebuild-schema.js');
