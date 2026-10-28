/**
 * 字段级脱敏与访问审计（TS-N18-03 / TS-N18-09）
 * ========================================================================
 * 现在的状态：只要有接口权限，身份证、银行卡、工资、客户手机号全是明文。
 * 前端「隐藏」不算数 —— 打开开发者工具照样能看到，导出更是直接带走。
 *
 * ## 三条原则（原型原话）
 *
 * 1. **默认最小权限**：成本、工资、合同隔离。
 * 2. **后台、缓存、检索、导出一致控制** —— 不是前端隐藏，是**服务端每个出口都校验**。
 * 3. **管理员技术权限不默认可读工资** —— 这条最容易做错：
 *    `hasPerm()` 里 admin 恒返回 true，如果脱敏层直接调它，等于没做。
 *    所以这里用**角色基础权限**（`eff.base`）判定，admin 的 base 里没有
 *    `payroll.sensitive` 就是看不到 —— 想看得走「一次性查看 + 写理由」。
 *
 * ## 四种出口都要管
 *
 *   列表/详情（接口返回）· 导出（CSV）· 缓存（不缓存明文）· AI（不给模型明文）
 *
 * 本期落地前两个（接口与导出），后两个靠「脱敏后的值才进缓存/提示词」这条约束保证。
 *
 * ## 为什么不用「前端打码」
 *
 * 前端打码只挡眼睛不挡数据。真正的做法是**服务端返回时就已经是掩码**，
 * 想看明文必须单独申请，而且每次都留痕 —— 这样「谁在什么时候看了谁的身份证」
 * 才答得出来（数据安全事件里第一个被问的就是这个）。
 */
const { db, now } = require('../src/db');

const t = now();

/* ---------------- 1. 字段规则 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS field_guards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,                     -- employees / payrolls / customers ...
  field_name TEXT NOT NULL,                     -- id_card / net_pay / phone ...
  label TEXT NOT NULL,                          -- 中文名（页面上显示）
  mask_type TEXT NOT NULL DEFAULT 'partial',    -- partial 部分保留 / hide 完全隐藏
  keep_prefix INTEGER NOT NULL DEFAULT 0,       -- partial 时保留前几位
  keep_suffix INTEGER NOT NULL DEFAULT 0,       -- partial 时保留后几位
  required_perm TEXT NOT NULL,                  -- 看明文需要的权限点
  log_access INTEGER NOT NULL DEFAULT 1,        -- 是否留痕（高敏字段必须 1）
  require_reason INTEGER NOT NULL DEFAULT 0,    -- 无权限者查看时是否必须写理由
  category TEXT NOT NULL DEFAULT 'pii',         -- pii / payroll / bank / contract
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fieldguard ON field_guards(table_name, field_name);
`);

/* ---------------- 2. 一次性查看与访问日志 ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS sensitive_access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  user_name TEXT,
  role TEXT,
  table_name TEXT NOT NULL,
  field_name TEXT,
  target_id INTEGER,
  target_label TEXT,                            -- 看的是谁（员工姓名/客户名）
  action TEXT NOT NULL,                         -- view 查看明细 / list 列表带到 / export 导出 / reveal 一次性查看
  granted INTEGER NOT NULL DEFAULT 0,           -- 1 有权限看到明文 / 0 走了申请通道
  reason TEXT,                                  -- granted=0 时必填
  row_count INTEGER NOT NULL DEFAULT 1,         -- 列表级留痕记「一次看了几条」，不逐条写
  ip TEXT,
  ua TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_salog_user ON sensitive_access_logs(username);
CREATE INDEX IF NOT EXISTS idx_salog_time ON sensitive_access_logs(created_at);
`);

/* ---------------- 3. 默认规则 ---------------- */

/**
 * [表, 字段, 名称, 方式, 前留, 后留, 权限点, 留痕, 需理由, 分类]
 *
 * 保留位数的口径：
 *   身份证留前 6 后 4（地区码 + 校验位能核对，中间生日与顺序码盖掉）
 *   手机留前 3 后 4（能确认是不是这个号，但拼不出完整号）
 *   邮箱留前 2 后域名（能判断是哪个邮箱服务商）
 *   银行账号留后 4（这是银行对账单上通用的显示方式，财务一眼能对上）
 *   金额一律完全隐藏（工资没有「部分显示」的合理场景）
 */
const RULES = [
  ['employees', 'id_card', '身份证号', 'partial', 6, 4, 'hr.pii', 1, 1, 'pii', '中间生日与顺序码盖掉，留地区码与末 4 位便于核对'],
  ['employees', 'phone', '手机号', 'partial', 3, 4, 'hr.pii', 1, 1, 'pii', '员工个人信息，查看需写理由'],
  ['employees', 'emergency_contact', '紧急联系人', 'hide', 0, 0, 'hr.pii', 1, 1, 'pii', '姓名+电话混合字段，无法部分保留'],
  ['employees', 'base_salary', '基本工资', 'hide', 0, 0, 'payroll.sensitive', 1, 1, 'payroll', '工资类字段一律完全隐藏'],

  ['payrolls', 'base_salary', '基本工资', 'hide', 0, 0, 'payroll.sensitive', 1, 1, 'payroll', null],
  ['payrolls', 'gross_pay', '应发合计', 'hide', 0, 0, 'payroll.sensitive', 1, 1, 'payroll', null],
  ['payrolls', 'net_pay', '实发工资', 'hide', 0, 0, 'payroll.sensitive', 1, 1, 'payroll', null],
  ['payrolls', 'tax', '个税', 'hide', 0, 0, 'payroll.sensitive', 1, 1, 'payroll', null],
  ['payrolls', 'social_insurance', '社保', 'hide', 0, 0, 'payroll.sensitive', 1, 1, 'payroll', null],
  ['payrolls', 'piece_wage', '计件工资', 'hide', 0, 0, 'payroll.sensitive', 1, 1, 'payroll', null],

  ['customers', 'phone', '客户电话', 'partial', 3, 4, 'crm.pii', 1, 0, 'pii', null],
  ['customers', 'email', '客户邮箱', 'partial', 2, 0, 'crm.pii', 1, 0, 'pii', null],
  ['suppliers', 'phone', '供应商电话', 'partial', 3, 4, 'supplier.pii', 1, 0, 'pii', null],

  ['admin_contracts', 'amount', '合同金额', 'hide', 0, 0, 'contract.sensitive', 1, 1, 'contract', '合同金额属商业秘密']
];

const ins = db.prepare(
  `INSERT INTO field_guards (table_name, field_name, label, mask_type, keep_prefix, keep_suffix,
     required_perm, log_access, require_reason, category, note, enabled, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)
   ON CONFLICT(table_name, field_name) DO NOTHING`
);
RULES.forEach((r) => ins.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], t, t));

const lcols = db.prepare('PRAGMA table_info(sensitive_access_logs)').all().map((c) => c.name);
if (!lcols.includes('row_count')) db.exec('ALTER TABLE sensitive_access_logs ADD COLUMN row_count INTEGER NOT NULL DEFAULT 1');

// 已有行的权限点口径修正（ON CONFLICT DO NOTHING 不会更新旧值）
[['employees', 'id_card', 'hr.pii'], ['employees', 'phone', 'hr.pii'], ['employees', 'emergency_contact', 'hr.pii'],
 ['customers', 'phone', 'crm.pii'], ['customers', 'email', 'crm.pii'], ['suppliers', 'phone', 'supplier.pii']
].forEach(([tb, fd, perm]) => {
  db.prepare('UPDATE field_guards SET required_perm = ?, updated_at = ? WHERE table_name = ? AND field_name = ? AND required_perm <> ?')
    .run(perm, t, tb, fd, perm);
});

// bank_accounts 不需要脱敏：account_no 是内部编码（CN-ICBC-001），
// 真实账号本来只存 account_masked —— 强行「脱敏内部编码」只会让对账变难。
db.prepare("DELETE FROM field_guards WHERE table_name = 'bank_accounts'").run();

db.prepare("UPDATE field_guards SET require_reason = 1 WHERE table_name = 'employees' AND field_name = 'phone'").run();

const n = (tb) => db.prepare(`SELECT COUNT(*) c FROM ${tb}`).get().c;
console.log(`field_guards: ${n('field_guards')} 条规则（覆盖 ${new Set(db.prepare('SELECT table_name FROM field_guards').all().map((x) => x.table_name)).size} 张表）`);
console.log(`sensitive_access_logs: ${n('sensitive_access_logs')} 行`);
console.log('字段级脱敏与访问审计 表结构就绪');
