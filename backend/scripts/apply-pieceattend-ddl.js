/**
 * 计件 × 考勤联动 · 建表
 * ============================================================
 * 为什么要把考勤拉进计件：
 *   计件按报工付钱，而报工是「人报的」。如果某人当天请假/旷工，
 *   却有一笔以他名义的报工，这笔钱十有八九不该付 —— 要么代报、要么写错人。
 *   以前系统只看报工不看考勤，这种单子照样算钱，还查不出来。
 *
 * 这一版加三样：
 *   1. piece_wage_config   一张单行配置表（日上限 / 冲突处理策略 / 月度封顶开关）
 *   2. piece_wage_items    明细加「考勤状态 / 是否剔除 / 封顶原因」四列
 *   3. 不改任何既有口径    —— 默认「日上限 0 = 不限制、策略 = 只提示」，
 *                            不动配置时页面数字与以前完全一样（不惊动历史核算）
 *
 * 幂等：CREATE TABLE / INDEX IF NOT EXISTS；ALTER 前查 PRAGMA。
 */
const { db } = require('../src/db');

function hasCol(table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (e) {
    return false;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS piece_wage_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行配置
  daily_cap_qty REAL NOT NULL DEFAULT 0,   -- 每人每日计件上限（件）；0 = 不限制
  month_cap INTEGER NOT NULL DEFAULT 1,    -- 1 = 按「日上限 × 出勤天数」封顶月度件数
  attendance_policy TEXT NOT NULL DEFAULT 'warn',
                                           -- warn 照算但确认需说明 / exclude 剔除不计 / block 不许确认
  updated_by TEXT,
  updated_at TEXT
);
`);

// 核算单加三个计数（与 missing_rate_count 并列，列表页不用解 payload 也能看到）
const RUN_COLS = [
  ['att_conflict_count', 'INTEGER NOT NULL DEFAULT 0'],   // 报工日请假/缺勤的笔数
  ['att_excluded_count', 'INTEGER NOT NULL DEFAULT 0'],   // 其中因策略被剔除不计的笔数
  ['att_capped_count', 'INTEGER NOT NULL DEFAULT 0']      // 日上限/缺勤封顶被削的笔数
];
RUN_COLS.forEach(([col, type]) => {
  if (!hasCol('piece_wage_runs', col)) {
    db.exec(`ALTER TABLE piece_wage_runs ADD COLUMN ${col} ${type}`);
    console.log('piece_wage_runs 新增列：', col);
  }
});

// 明细加五列：考勤状态、是否请假/缺勤日报工、是否被剔除、剔除原因、封顶原因
const COLS = [
  ['report_date', 'TEXT'],                                    // 报工日期（考勤核对的依据，原来只在诊断里）
  ['att_status', "TEXT"],                                     // normal/late/leave/absent/none
  ['att_flagged', 'INTEGER NOT NULL DEFAULT 0'],              // 1 = 报工日请假/缺勤（钱有争议）
  ['excluded', 'INTEGER NOT NULL DEFAULT 0'],                 // 1 = 因考勤冲突未计入金额（policy=exclude）
  ['exclude_reason', 'TEXT'],
  ['cap_kind', 'TEXT']                                        // bundle / daily / month
];
COLS.forEach(([col, type]) => {
  if (!hasCol('piece_wage_items', col)) {
    db.exec(`ALTER TABLE piece_wage_items ADD COLUMN ${col} ${type}`);
    console.log('piece_wage_items 新增列：', col);
  }
});

// 配置行（只有一行）
const row = db.prepare('SELECT id FROM piece_wage_config WHERE id = 1').get();
if (!row) {
  db.prepare(
    "INSERT INTO piece_wage_config (id, daily_cap_qty, month_cap, attendance_policy, updated_by, updated_at) VALUES (1, 0, 1, 'warn', 'system', ?)"
  ).run(new Date().toISOString());
  console.log('piece_wage_config 初始化：日上限 0（不限）/ 策略 warn');
}

console.log('计件考勤联动表就绪');
