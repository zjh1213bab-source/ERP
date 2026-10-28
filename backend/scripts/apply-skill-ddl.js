/**
 * 技能矩阵与岗位资格（TS-N13-06）
 * ========================================================================
 * 现状的问题：系统知道「这个工作中心有 12 小时产能」（排程按设备算），
 * 但不知道「有没有人能上这道工序」。
 *
 * 更糟的是：系统里其实**已经有**技能证据 —— 89 条报工记着谁做了哪道工序，
 * 但它是流水，没人能一眼看出「谁会车缝、谁只会包装」。
 *
 * ## 这一版解决的四件事
 *
 * 1. **技能矩阵**：人 × 工序 的格子，看清谁会什么、几级、什么时候到期。
 * 2. **资格门禁**：受限工序（`restricted=1`）没资格不许上机报工 —— 原型「受限岗位才拦」。
 * 3. **到期提醒**：证书过期即失效，不能因为「曾经有」就算合格。
 * 4. **覆盖缺口**：每道工序「合格几人 / 需要几人 / 排程是不是按没人的产能排的」。
 *
 * ## 五条口径（每条都对应一种做错的方式）
 *
 * 1. **等级只能来自「评定」，不能来自报工**。
 *    报工多只说明干得多，不说明干得好（也可能是返工最多的那个人）。
 *    所以 `employee_skills.level` 只由 `assess()` 写入；报工只回填 `report_count` 作证据。
 * 2. **证据来源必须标出来**：`assessed`（评定）/ `actual`（仅有报工事实）/ `self`（自报）。
 *    混成一个「会」字，矩阵就没法用来派工。
 * 3. **默认全都不受限**（`restricted=0`）。
 *    上线时先看清家底，再逐道工序收紧 —— 一上来全拦，车间当天就停线。
 * 4. **受限工序也拦不住「查不到人」的情况**：报工人不在员工档案里时不拦，但要进覆盖缺口清单。
 *    拿档案缺失当否决事实，等于让 HR 的数据质量决定生产能不能开工。
 * 5. **本模块不产生任何扣款、不参与绩效打分**。
 *    原型明确「AI 不能自动打低分裁员」「离职风险不得凭敏感记录自动评分」。
 *    这里只有资格与覆盖，破格放行要写理由并留痕。
 */
const { db, now } = require('../src/db');

const t = now();

/* ---------------- 1. 工序资格要求 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS skill_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_name TEXT NOT NULL,                   -- 与 process_standards.process_name / order_nodes.name 对齐
  work_center TEXT,
  min_level INTEGER NOT NULL DEFAULT 2,         -- 可独立上岗的最低等级
  restricted INTEGER NOT NULL DEFAULT 0,        -- 1=受限工序，无资格不许报工；0=只提示
  cert_type TEXT,                               -- 该工序要求的资格证类型（可空）
  min_headcount INTEGER NOT NULL DEFAULT 1,     -- 至少几人能上（覆盖分析的基准）
  note TEXT,
  updated_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skillreq ON skill_requirements(process_name);
`);

/* ---------------- 2. 员工技能（矩阵的格子） ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS employee_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  employee_name TEXT,
  process_name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,             -- 1 学徒 / 2 熟练 / 3 骨干 / 4 师傅
  source TEXT NOT NULL DEFAULT 'assessed',      -- assessed 评定 / actual 仅报工事实 / self 自报
  assessed_by TEXT,                             -- 评定人：评级这事必须有人负责
  assessed_at TEXT,
  evidence TEXT,                                -- 评定依据（考了什么、做了几件、谁看的）
  valid_until TEXT,                             -- 技能有效期（复评到期）
  status TEXT NOT NULL DEFAULT 'active',        -- active / expired / revoked
  report_count INTEGER NOT NULL DEFAULT 0,      -- 报工次数（证据，不参与评级）
  last_report_at TEXT,
  remark TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill ON employee_skills(employee_id, process_name);
CREATE INDEX IF NOT EXISTS idx_skill_proc ON employee_skills(process_name);
`);

/* ---------------- 3. 员工资格证书 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS skill_certs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  employee_name TEXT,
  cert_type TEXT NOT NULL,                      -- 电工 / 叉车 / 质检资格 / 特种作业…
  cert_no TEXT,
  issuer TEXT,                                  -- 发证机关
  issue_date TEXT,
  expire_date TEXT,                             -- 空=长期有效
  attachment TEXT,
  status TEXT NOT NULL DEFAULT 'valid',         -- valid / expired / revoked
  remark TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cert_emp ON skill_certs(employee_id);
CREATE INDEX IF NOT EXISTS idx_cert_expire ON skill_certs(expire_date);
`);

/* ---------------- 4. 破格放行（受限工序的临时授权） ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS skill_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  employee_name TEXT,
  process_name TEXT NOT NULL,
  reason TEXT NOT NULL,                         -- 必填：为什么这次可以破格
  approved_by TEXT,
  valid_until TEXT NOT NULL,                    -- 必须有期限，避免变成永久后门
  status TEXT NOT NULL DEFAULT 'active',        -- active / expired / revoked
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_override_emp ON skill_overrides(employee_id, process_name);
`);

/* ---------------- 5. 培训与复训 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS training_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  employee_name TEXT,
  course_name TEXT NOT NULL,
  course_type TEXT NOT NULL DEFAULT 'skill',    -- onboard 入职 / skill 技能 / refresh 复训 / safety 安全
  planned_at TEXT,                              -- 计划日期（没完成也算进完成率分母）
  finished_at TEXT,
  hours REAL,
  score REAL,
  result TEXT NOT NULL DEFAULT 'pending',       -- pending / pass / fail
  expire_date TEXT,                             -- 复训到期日
  trainer TEXT,
  remark TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_train_emp ON training_records(employee_id);
`);

/* ---------------- 6. 从现有工序标准播种要求 ----------------
 * 只播「工序名 + 工作中心 + 默认门槛」，restricted 一律 0。
 * 上线时先看清家底再逐道收紧，一上来全拦会让车间当天停线。
 */
const PROC_FALLBACK = [
  ['裁剪', '裁剪组'], ['车缝', '一车间'], ['锁眼钉扣', '二车间'], ['整烫', '整烫组'],
  ['水洗', '水洗车间'], ['印花', '印花车间'], ['绣花', '绣花车间'], ['检验', '后整区'], ['包装', '后整区']
];

const exist = db.prepare('SELECT COUNT(*) c FROM skill_requirements').get().c;
if (exist === 0) {
  const ins = db.prepare(
    `INSERT INTO skill_requirements (process_name, work_center, min_level, restricted, cert_type, min_headcount, note, created_at, updated_at)
     VALUES (?,?,2,0,NULL,1,?,?,?)`
  );
  // 优先用 process_standards（工序标准工时表），它才是排程真正认的工序清单
  const stds = db.prepare('SELECT process_name, work_center FROM process_standards WHERE active = 1 ORDER BY id').all();
  const rows = stds.length ? stds.map((s) => [s.process_name, s.work_center]) : PROC_FALLBACK;
  rows.forEach(([name, wc]) => ins.run(name, wc, '初始门槛：熟练(2 级)可独立上岗；先不设限，看清家底后再收紧', t, t));
  console.log(`已播种 ${rows.length} 道工序的资格要求（全部 restricted=0）`);
}

/* ---------------- 7. 从报工回填「有事实证据」的技能 ----------------
 * 只建 level=1 / source='actual' 的占位行：证明「这个人做过这道工序」，
 * **不代表合格**，所以 level 压到最低，且不会被当成可上岗依据。
 * 已有评定记录的人不覆盖（评定的等级更高，不能被流水冲掉）。
 */
const evid = db
  .prepare(
    `SELECT employee_id, MAX(operator) nm, node_name, COUNT(*) c, MAX(report_date) last
       FROM production_reports
      WHERE employee_id IS NOT NULL AND IFNULL(node_name,'') <> ''
      GROUP BY employee_id, node_name`
  )
  .all();

const findSkill = db.prepare('SELECT id, source, level FROM employee_skills WHERE employee_id = ? AND process_name = ?');
const updEvidence = db.prepare(
  'UPDATE employee_skills SET report_count = ?, last_report_at = ?, updated_at = ? WHERE id = ?'
);
const insEvidence = db.prepare(
  `INSERT INTO employee_skills (employee_id, employee_name, process_name, level, source, evidence, report_count, last_report_at, status, created_at, updated_at)
   VALUES (?,?,?,1,'actual',?,?,?,'active',?,?)`
);

let filled = 0;
let evidenceOnly = 0;
evid.forEach((r) => {
  const hit = findSkill.get(r.employee_id, r.node_name);
  if (hit) {
    updEvidence.run(r.c, r.last, t, hit.id);
    return;
  }
  insEvidence.run(
    r.employee_id, r.nm, r.node_name,
    `系统按报工流水回填：${r.c} 次报工记录，未经考核评定，仅作「做过」的证据`,
    r.c, r.last, t, t
  );
  evidenceOnly += 1;
  filled += 1;
});

const n = (tb) => db.prepare(`SELECT COUNT(*) c FROM ${tb}`).get().c;
console.log(`employee_skills: ${n('employee_skills')} 行（按报工回填 ${filled} 条，其中新增事实证据 ${evidenceOnly} 条）`);
console.log(`skill_certs: ${n('skill_certs')} 行 · skill_overrides: ${n('skill_overrides')} 行 · training_records: ${n('training_records')} 行`);
console.log('技能矩阵与岗位资格 表结构就绪');
