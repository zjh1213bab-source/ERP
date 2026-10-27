/**
 * 行政合同与履约日历 / 印章独立授权 / 敏感档案访问留痕
 * 对应原型 TS-N14-06（行政合同与履约日历）+ TS-N14-05 的剩余部分（印章独立授权、借章归还、访问控制）
 *
 * 已有基础（facility.js）：certificates 证照 CRUD + void、seals 印章、seal_usages 用印流转（含版本比对）。
 * 本次补齐：
 *   - 印章按公司独立授权（seal_grants），用印/借章必须命中有效授权
 *   - 借章（kind=borrow）：借出 + 预计归还 + 归还回执，逾期进日历
 *   - 行政合同台账 + 版本（改正文要重核用印）+ 履约里程碑（付款/验收/续约通知/押金返还）
 *   - 履约日历：合同里程碑 + 证照到期 + 借章逾期，统一按日期排
 *   - 敏感档案访问留痕（doc_access_logs）
 */
const { db } = require('../src/db');

const DDL = [
  // 1. 行政合同台账
  `CREATE TABLE IF NOT EXISTS admin_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_no TEXT UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'other',        -- lease 租赁 / property 物业 / canteen 食堂 / insurance 保险 / service 服务采购 / other
    company TEXT,                              -- 签约主体（哪个公司）
    counterparty TEXT,                         -- 对手方
    owner TEXT,                                -- 合同责任人
    amount REAL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'CNY',
    deposit REAL DEFAULT 0,                    -- 押金
    deposit_return_date TEXT,                  -- 押金应返还日
    sign_date TEXT,
    start_date TEXT,
    end_date TEXT,
    renewal_notice_days INTEGER NOT NULL DEFAULT 30,  -- 提前多少天提示续约
    current_version INTEGER NOT NULL DEFAULT 1,
    seal_id INTEGER,                           -- 签署用章
    status TEXT NOT NULL DEFAULT 'draft',      -- draft 草稿 / active 履约中 / renewed 已续签 / terminated 已终止 / archived 已归档
    terminated_reason TEXT,
    terminated_by TEXT,
    terminated_at TEXT,
    renewed_to INTEGER,                        -- 续签后的新合同 id
    renewal_basis TEXT,                        -- 续签依据
    archived_at TEXT,
    archive_note TEXT,
    remark TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ac_status ON admin_contracts(status, end_date)`,

  // 2. 合同版本（改正文 → 用印需重核）
  `CREATE TABLE IF NOT EXISTS admin_contract_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    doc_name TEXT,
    doc_hash TEXT,                             -- 内容校验值：客户认的是「这份内容」不是版本号
    attachment TEXT,
    change_note TEXT,
    changed_by TEXT,
    changed_at TEXT NOT NULL,
    seal_recheck_required INTEGER NOT NULL DEFAULT 0,
    UNIQUE (contract_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_acv_contract ON admin_contract_versions(contract_id)`,

  // 3. 履约里程碑（付款 / 验收 / 续约通知 / 押金返还）
  `CREATE TABLE IF NOT EXISTS admin_contract_milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'payment',      -- payment 付款 / acceptance 验收 / renewal_notice 续约通知 / deposit_return 押金返还 / other
    title TEXT NOT NULL,
    due_date TEXT NOT NULL,
    amount REAL,
    status TEXT NOT NULL DEFAULT 'pending',    -- pending 待办 / done 已完成 / overdue 已逾期 / waived 已豁免
    done_at TEXT,
    done_by TEXT,
    evidence TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_acm_due ON admin_contract_milestones(status, due_date)`,

  // 4. 印章独立授权（按公司）
  `CREATE TABLE IF NOT EXISTS seal_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seal_id INTEGER NOT NULL,
    company TEXT,
    grantee TEXT NOT NULL,                     -- 姓名 / 岗位 / 角色
    grantee_type TEXT NOT NULL DEFAULT 'person', -- person / position / role
    scope TEXT NOT NULL DEFAULT 'use',         -- use 用印 / borrow 借章 / all
    valid_from TEXT,
    valid_to TEXT,
    status TEXT NOT NULL DEFAULT 'active',     -- active / revoked / expired
    granted_by TEXT,
    granted_at TEXT NOT NULL,
    revoke_reason TEXT,
    remark TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sg_seal ON seal_grants(seal_id, status)`,

  // 5. 敏感档案访问留痕
  `CREATE TABLE IF NOT EXISTS doc_access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_type TEXT NOT NULL,                    -- certificate / contract / seal_usage
    doc_id INTEGER,
    doc_name TEXT,
    access_level TEXT,                         -- public / controlled
    action TEXT NOT NULL DEFAULT 'view',       -- view / download / print
    allowed INTEGER NOT NULL DEFAULT 1,
    operator TEXT,
    operator_role TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dal_doc ON doc_access_logs(doc_type, doc_id)`
];

function run() {
  DDL.forEach((s) => db.exec(s));

  // seal_usages 扩列：绑合同/文件指纹、重核标记、借章字段
  const cols = db.prepare('PRAGMA table_info(seal_usages)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE seal_usages ADD COLUMN ${ddl}`);
    return cols.includes(name) ? '已有' : '已补';
  };
  const r = [
    add('kind', "kind TEXT NOT NULL DEFAULT 'use'"),
    add('contract_id', 'contract_id INTEGER'),
    add('doc_hash', 'doc_hash TEXT'),
    add('recheck_required', 'recheck_required INTEGER NOT NULL DEFAULT 0'),
    add('recheck_reason', 'recheck_reason TEXT'),
    add('borrow_out_at', 'borrow_out_at TEXT'),
    add('expect_return_date', 'expect_return_date TEXT'),
    add('return_receipt', 'return_receipt TEXT')
  ];

  // certificates 扩访问级别
  const ccols = db.prepare('PRAGMA table_info(certificates)').all().map((c) => c.name);
  if (!ccols.includes('access_level')) db.exec("ALTER TABLE certificates ADD COLUMN access_level TEXT NOT NULL DEFAULT 'controlled'");

  const t = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND (name LIKE 'admin_contract%' OR name IN ('seal_grants','doc_access_logs'))").get().c;
  console.log(`[admin-contract] 已建 ${t} 张表；seal_usages 扩列 ${r.join(' ')}；certificates.access_level ${ccols.includes('access_level') ? '已有' : '已补'}`);
}

run();
module.exports = { DDL };
