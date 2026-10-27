/**
 * 设备停机与产能影响 DDL（P1 / 原型 TS-N08-08）
 *   node scripts/apply-equipment-ddl.js && node scripts/rebuild-schema.js
 *
 * 1) equipment：设备台账（工作中心、台时产能、责任人、保养计划）
 * 2) equipment_downtimes：停机/报修/保养单（起止、占用工时、维修任务、安全复核、影响订单、产能损失）
 *
 * 设计原则（按原型）：只做设备日历 + 停机报修 + 受影响排程，不做 IoT 采集平台。
 */
const { db } = require('../src/db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eq_no TEXT UNIQUE NOT NULL,                 -- EQ+3位序号
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'sewing',         -- sewing 缝纫 / cutting 裁剪 / ironing 整烫 / washing 水洗 / printing 印花 / embroidery 绣花 / inspection 检验 / other
  work_center TEXT NOT NULL,                   -- 工作中心（一车间 / 二车间 / 裁剪组 / 整烫组 …）
  capacity_per_hour REAL NOT NULL DEFAULT 0,   -- 台时产能（件/小时）
  status TEXT NOT NULL DEFAULT 'running',       -- running 运行 / stopped 停机 / maintenance 保养中 / retired 报废
  owner TEXT,                                   -- 设备责任人
  location TEXT,
  last_maintain_at TEXT,
  next_maintain_at TEXT,                        -- 下次计划保养
  remark TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_eq_wc ON equipment(work_center)`,

  `CREATE TABLE IF NOT EXISTS equipment_downtimes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dt_no TEXT UNIQUE NOT NULL,                  -- DT+日期+序号
  equipment_id INTEGER NOT NULL,
  eq_no TEXT,
  eq_name TEXT,
  work_center TEXT,
  type TEXT NOT NULL DEFAULT 'breakdown',       -- breakdown 故障 / maintenance 计划保养 / changeover 换款调试 / power 停电
  start_at TEXT NOT NULL,                       -- 停机开始
  end_at TEXT,                                  -- 停机结束（空=还在停）
  occupied_hours REAL NOT NULL DEFAULT 0,       -- 占用工时（由起止算，未结束按当前时刻）
  reason TEXT NOT NULL,                         -- 停机原因（必填）
  repair_task TEXT,                             -- 维修任务
  status TEXT NOT NULL DEFAULT 'pending_repair',  -- planned 计划保养 / pending_repair 待维修 / repairing 维修中 / pending_safety 待安全复核 / recovered 已恢复 / cancelled 作废
  repair_by TEXT,
  repair_at TEXT,
  repair_note TEXT,
  safety_by TEXT,                               -- 安全放行责任人（人工确认，不自动）
  safety_at TEXT,
  safety_note TEXT,
  capacity_per_hour REAL NOT NULL DEFAULT 0,    -- 停机时该设备的台时产能快照
  capacity_loss REAL NOT NULL DEFAULT 0,        -- 产能损失（件）= 占用工时 × 台时产能
  affected_orders TEXT,                         -- 受影响排程（JSON：[{order_id, order_no, note}]）
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dt_eq ON equipment_downtimes(equipment_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_dt_wc ON equipment_downtimes(work_center, start_at)`
];

DDL.forEach((sql) => db.exec(sql));
console.log('新增 2 张表 / 3 个索引');

// 播种常用设备（只补空缺，幂等）
const seedEq = [
  ['缝纫平车 A 组', 'sewing', '一车间', 12, '张组长', 'A 区 1-12 号位', 7],
  ['缝纫平车 B 组', 'sewing', '二车间', 10, '李组长', 'B 区 1-10 号位', 7],
  ['四线包缝机', 'sewing', '一车间', 18, '张组长', 'A 区 13 号位', 14],
  ['自动裁剪机', 'cutting', '裁剪组', 120, '王师傅', '裁剪房', 30],
  ['粘合机', 'other', '裁剪组', 60, '王师傅', '裁剪房', 30],
  ['蒸汽整烫台', 'ironing', '整烫组', 40, '陈师傅', '后整区', 30],
  ['水洗机', 'washing', '水洗车间', 200, '外包-鑫达', '外协', 30],
  ['数码印花机', 'printing', '印花车间', 80, '外包-晟彩', '外协', 30],
  ['绣花机', 'embroidery', '绣花车间', 60, '周师傅', '绣花区', 30],
  ['检针机', 'inspection', '后整区', 300, '质检组', '后整区', 60]
];
let n = 0;
const t = new Date().toISOString();
seedEq.forEach((e, i) => {
  const no = 'EQ' + String(i + 1).padStart(3, '0');
  if (db.prepare('SELECT 1 x FROM equipment WHERE eq_no = ?').get(no)) return;
  db.prepare(
    `INSERT INTO equipment (eq_no, name, type, work_center, capacity_per_hour, status, owner, location, next_maintain_at, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?, 'running', ?,?,?, 'system', ?, ?)`
  ).run(no, e[0], e[1], e[2], e[3], e[4], e[5],
    new Date(Date.now() + e[6] * 86400000).toISOString().slice(0, 10), t, t);
  n++;
});
console.log(`设备台账播种 +${n} 台（已有则跳过）`);
console.log('完成。记得执行 scripts/rebuild-schema.js');
