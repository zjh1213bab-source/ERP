/**
 * 组织编制与岗位任职 DDL（原型 M02）
 * ------------------------------------------------------------
 * 四张表对应四个节点：
 *   org_positions     N02-02 岗位序列与编制（含汇报关系）
 *   employments       N02-02 任职关系（雇佣公司 / 服务公司 / 岗位 / 有效期）
 *   trade_routes      N02-03 交易路线与共享服务（卖方/买方/履约/货主/签约/付款）
 *   subject_scopes    N02-04 主体视图与经营范围（公司范围 / 字段范围 / 汇总范围）
 *
 * 为什么任职不能只挂在 employees 上：
 *   `employees.position` 只能记「现在是什么岗」，记不了「哪家雇佣、服务哪几家、从哪天到哪天」。
 *   技术部是总部独立部门但要服务各公司 —— 雇佣主体和服务主体本来就该分开记。
 *   而且换岗必须留历史：今年在车间、明年调仓储，两条记录都要在，不能覆盖。
 *
 * 为什么要用「部分唯一索引」而不是应用层判断：
 *   一个人同一时刻只能有一条**生效**任职。应用层判断挡不住并发与脚本直连，
 *   数据库层加 `WHERE status='effective'` 的唯一索引才是真的挡得住。
 */
const { db } = require('../src/db');

function hasCol(t, c) {
  try {
    return db.prepare(`pragma table_info(${t})`).all().some((x) => x.name === c);
  } catch (e) {
    return false;
  }
}

/** 岗位：一个部门下的一个岗，带编制数与汇报关系 */
db.exec(`CREATE TABLE IF NOT EXISTS org_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,                 -- P+YYYYMMDD+序号
  title TEXT NOT NULL,                       -- 岗位名称，如「车缝组长」
  company_id INTEGER NOT NULL DEFAULT 1,     -- 岗位归属公司（雇佣公司必须与之一致）
  department_id INTEGER,                     -- 归属部门
  sequence TEXT NOT NULL DEFAULT 'ops',      -- manage 管理 / professional 专业 / sales 销售 / tech 技术 / ops 操作
  grade INTEGER,                             -- 职级 1-9（1 最高）
  headcount INTEGER NOT NULL DEFAULT 0,      -- 编制数（0 = 未核定，不参与超编校验）
  reports_to_id INTEGER,                     -- 汇报给哪个岗位（为空=直接汇报总经理）
  status TEXT NOT NULL DEFAULT 'active',     -- active 启用 / closed 关闭
  effective_from TEXT,
  remark TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

/** 任职：员工 × 雇佣公司 × 岗位 × 有效期（换岗 = 结束旧任职 + 起新任职） */
db.exec(`CREATE TABLE IF NOT EXISTS employments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employment_no TEXT UNIQUE NOT NULL,        -- EMP+YYYYMMDD+序号
  employee_id INTEGER NOT NULL,
  employer_company_id INTEGER NOT NULL,      -- 雇佣公司（发工资、交社保的那家）
  service_company_id INTEGER,                -- 服务公司（空 = 服务全部主体）
  position_id INTEGER,
  department_id INTEGER,
  employment_type TEXT NOT NULL DEFAULT 'fulltime',  -- fulltime / parttime / secondment 外派 / outsource 外包
  start_date TEXT NOT NULL,
  end_date TEXT,                             -- 结束日（生效中为空）
  status TEXT NOT NULL DEFAULT 'draft',      -- draft/pending/effective/ended/rejected
  reason TEXT,                               -- 变动原因（新入职/调岗/晋升/外派）
  prev_employment_id INTEGER,                -- 从哪条任职转来（换岗链路）
  approved_by TEXT,
  approved_at TEXT,
  reject_reason TEXT,
  over_headcount INTEGER NOT NULL DEFAULT 0, -- 超编特批标记
  over_reason TEXT,                          -- 超编原因（特批必须写）
  remark TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

/** 交易路线：一单生意里，谁是卖方/买方/履约方/货主/签约方/付款方 */
db.exec(`CREATE TABLE IF NOT EXISTS trade_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_no TEXT UNIQUE NOT NULL,             -- RT+YYYYMMDD+序号
  name TEXT NOT NULL,
  biz_type TEXT NOT NULL DEFAULT 'spot',     -- spot 现货 / custom 定制 / outsource 外协 / service 服务
  seller_company_id INTEGER,                 -- 卖方（开票方）
  buyer_company_id INTEGER,                  -- 买方（外部客户主体，多为空）
  fulfill_company_id INTEGER,                -- 履约方（实际发货/生产）
  goods_owner_company_id INTEGER,            -- 货主（库存归谁）
  sign_company_id INTEGER,                   -- 签约方
  pay_company_id INTEGER,                    -- 付款方
  service_agreement TEXT,                    -- 服务协议编号（签约方≠卖方时必填）
  service_fee_rate REAL,                     -- 服务费率 %（代销/服务费场景）
  status TEXT NOT NULL DEFAULT 'draft',      -- draft / confirmed 已确认 / pending_terms 条款待配 / disabled
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

/** 主体视图与经营范围：某个账号能看哪些公司、哪些字段、能不能汇总 */
db.exec(`CREATE TABLE IF NOT EXISTS subject_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_no TEXT UNIQUE NOT NULL,             -- SC+YYYYMMDD+序号
  user_id INTEGER NOT NULL,
  username TEXT,
  role_label TEXT,                           -- 申请时的角色口径（快照）
  company_ids TEXT,                          -- 可见公司 id，逗号分隔；空 = 仅本主体
  field_scope TEXT NOT NULL DEFAULT 'full',  -- full 全部 / no_salary 不看薪资 / no_cost 不看成本
  aggregate_scope TEXT NOT NULL DEFAULT 'company',  -- company 单主体 / group 集团汇总
  status TEXT NOT NULL DEFAULT 'draft',      -- draft/pending/effective/expired/rejected
  requested_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  effective_from TEXT,
  expires_at TEXT,                           -- 到期日（必填，到期即失效）
  relation_version INTEGER NOT NULL DEFAULT 1,  -- 关系版本（续期/改范围 +1）
  reason TEXT,
  reject_reason TEXT,
  remark TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

// 一个人同一时刻只能有一条生效任职（应用层也判，但数据库这层才是硬的）
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_emp_effective ON employments(employee_id) WHERE status='effective'");
// 一个账号同时只能有一条生效的授权范围
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_scope_effective ON subject_scopes(user_id) WHERE status='effective'");

db.exec('CREATE INDEX IF NOT EXISTS idx_pos_dept ON org_positions(company_id, department_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_pos_status ON org_positions(status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_emp_status ON employments(status, start_date)');
db.exec('CREATE INDEX IF NOT EXISTS idx_emp_company ON employments(employer_company_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_route_status ON trade_routes(status, biz_type)');
db.exec('CREATE INDEX IF NOT EXISTS idx_scope_user ON subject_scopes(user_id, status)');

// 交易路线的 note 会被「切状态」的业务逻辑覆盖（切条款待配要写原因），
// 演示标记不能放在 note 里，否则 reset 找不到上一批数据 → 每次重放都多一条
if (!hasCol('trade_routes', 'demo_tag')) {
  db.exec('ALTER TABLE trade_routes ADD COLUMN demo_tag TEXT');
  console.log('[org-ddl] trade_routes + demo_tag');
}

// N02-01 主体档案补两列：股权版本与启停日（原有 companies 只有 type/tax_no/本位币/合并范围）
[['equity_version', 'TEXT'], ['start_date', 'TEXT'], ['stop_date', 'TEXT'], ['reg_place', 'TEXT']].forEach(([c, t]) => {
  if (!hasCol('companies', c)) {
    db.exec(`ALTER TABLE companies ADD COLUMN ${c} ${t}`);
    console.log(`[org-ddl] companies + ${c}`);
  }
});

console.log('[org-ddl] done');
