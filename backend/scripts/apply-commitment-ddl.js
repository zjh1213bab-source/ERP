/**
 * 接单评审与交期承诺 DDL（P0-3 / 原型 TS-N06-01 · TS-N06-08）
 *   node scripts/apply-commitment-ddl.js && node scripts/rebuild-schema.js
 */
const { db } = require('../src/db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS commitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER UNIQUE NOT NULL,
  order_no TEXT,
  customer_name TEXT,
  style_no TEXT,
  qty INTEGER NOT NULL DEFAULT 0,
  route_type TEXT NOT NULL DEFAULT 'inhouse',   -- inhouse 本厂 / outsource 裁片外发

  -- 三个时钟 + 实际，四个日期分别保留（原型要求不合并）
  t0_at TEXT,                                   -- 起算时刻 = max(订单确认, 启动款到账)
  t0_source TEXT,                               -- confirm / payment / later（取较晚者）
  t0_note TEXT,
  promised_date TEXT,                           -- 对客承诺日
  planned_date TEXT,                            -- 内部计划日
  forecast_date TEXT,                           -- 最新预测
  actual_ship_date TEXT,                        -- E1 实际出厂

  -- 评审（前端 / 后端 / 物料分别确认，不默认无限）
  review_status TEXT NOT NULL DEFAULT 'pending',-- pending / approved / rejected
  front_ok INTEGER NOT NULL DEFAULT 0,          -- 前端：裁床·算料可承接
  back_ok INTEGER NOT NULL DEFAULT 0,           -- 后端：缝制·后道可承接
  material_ok INTEGER NOT NULL DEFAULT 0,       -- 物料：齐套或供应可靠
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,

  -- 风险
  risk_level TEXT NOT NULL DEFAULT 'none',      -- none / yellow / red / done
  delay_days INTEGER NOT NULL DEFAULT 0,
  delay_reason TEXT,

  created_at TEXT,
  updated_at TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_commit_status ON commitments(review_status)`,
  `CREATE INDEX IF NOT EXISTS idx_commit_risk ON commitments(risk_level)`,

  `CREATE TABLE IF NOT EXISTS commitment_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commitment_id INTEGER NOT NULL,
  code TEXT NOT NULL,                           -- P1..P6 / B1 / H1 / H2 / E1 / C1..C3
  name TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  plan_days REAL,                               -- NULL = 待配置（不按 0 处理）
  supervise_day INTEGER,                        -- 督办跟踪点：T0 后第 N 天
  start_date TEXT,
  end_date TEXT,
  actual_start TEXT,
  actual_end TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending / running / done / skipped
  owner TEXT,
  delay_days INTEGER NOT NULL DEFAULT 0,
  note TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_cnode_commit ON commitment_nodes(commitment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cnode_status ON commitment_nodes(status)`
];

let n = 0;
DDL.forEach((sql) => {
  try { db.exec(sql); n++; } catch (e) { console.error('失败：', sql.slice(0, 50), e.message); }
});
console.log(`已执行 ${n}/${DDL.length} 条 DDL`);
const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'commitment%'").all();
console.log('承诺表：', t.map((x) => x.name).join(', '));
