/**
 * 资产工衣与领归（TS-N14-03）
 * ========================================================================
 * 前几轮已经有了「东西」和「钱」：
 *   - `assets` 固定资产卡（原值/折旧/净值/报废），
 *   - `office_*` 办公耗材仓（入库/申领/领用），
 *   - 耐用办公品验收时逐件转成资产卡。
 *
 * 缺的是最后一环：**东西在谁身上**。
 * 现在的 `assets.keeper` 只是一个文本字段，改它不会留痕，也回答不了四个日常问题：
 *   1. 小王离职了，钥匙、工牌、电动螺丝刀交了没有？
 *   2. 那件 XL 号工衣现在在谁手上？还有几件没发出去？
 *   3. 工具借给邻组用了一周，谁批的？到期没？
 *   4. 上个月弄坏的那台对讲机，责任认定到哪一步了，钱收了没有？
 *
 * ## 这一版做的五件事
 * - `custody_items`    实物档案（一物一码：工衣/工具/钥匙/门禁卡；也支持按量的劳保消耗品）
 * - `custody_records`  领用记录（一次领用一条生命周期：草稿→使用中→待归还→已归还/遗失/核销）
 * - `custody_clearances` 离职清退单（把「人身上挂着的」一次列清）
 * - `custody_claims`   损坏责任复核（独立流程，只出结论，不自动扣钱）
 * - `custody_actions`  流转时间线（发放/归还/转交/复核/核销各留一条）
 *
 * **「已领出」不存冗余列**。很多台账会在实物表上放一个 `qty_out`，领用时 +1、归还时 −1。
 * 只要有一条路径忘了减（比如遗失、核销、转交），这个数就永久偏大，
 * 而页面上的「可用数量」从此没人敢信。所以本模块的已领出量**一律从领用记录聚合**：
 * `SUM(qty − returned_qty) WHERE status IN ('issued','awaiting')`。少一次写，就没有漂移。
 *
 * ## 七条口径（每条都对应一种做错的方式）
 *
 * 1. **耐用实物不双领**。`durable=1` 的实物同一时间只能有一条未归还记录（部分唯一索引
 *    `uq_custody_open_item` 兜底，服务层先查再插）。只在服务层查不够 —— 两个人同时点「发放」
 *    的竞态会各插一条，最后一个实物挂在两个部门账上，盘点永远差一件。
 *
 * 2. **「耐用」和「必须归还」是两件事**，不能合成一个字段。
 *    工衣是一物一码的耐用品（有尺码、要发对人），但原型明确「不把工衣全部强制退回」；
 *    钥匙是必须归还的，工具介于两者之间。所以 `durable`（能不能双领）与
 *    `require_return`（要不要建归还任务、要不要进超期清单）分开存。
 *    合成一个字段的直接后果：工衣全部变成逾期，行政每天收到一堆假警报，最后没人看这个清单。
 *
 * 3. **没有期限就不是逾期**。`require_return=1` 才允许写 `expected_return_at`；
 *    `require_return=0` 的记录即使传了日期也清空。超期清单只认有期限且未归还的记录，
 *    不拿「领了很久」当逾期。
 *
 * 4. **消耗品按政策核销，不进归还清单**。`durable=0`（手套、口罩、耳塞）领出即消耗，
 *    记录进台账但不产生归还义务；核销只改状态、不退数量、不冲库存（它本来就不在生产仓里）。
 *
 * 5. **损坏责任独立复核，不自动扣钱**。登记损坏/遗失时只**生成**一张 `pending` 复核单，
 *    不动任何金额。复核只出「责任比例」，`liable_amount` 必须有**财务回执号**
 *    （`finance_confirm_no`）才算落地。没有回执号时页面显示「待财务确认」，
 *    绝不在本模块里直接扣工资或加应收 —— 行政判责、财务收钱，两个动作不能合并。
 *
 * 6. **折旧不在行政再算一遍**。关联资产卡（`asset_id`）的实物，页面只显示
 *    `assets` 里的净值，并标注来源。行政若自己按领用日期算折旧，
 *    同一台设备在资产表和行政表会有两个净值。
 *
 * 7. **处置不能两边各自报废**。实物挂了资产卡（`asset_id`）时，本模块**拒绝**核销，
 *    必须去资产台账走报废（有处置价款与财务回执）。本模块只处置「没有资产卡的低值实物」，
 *    处置必须填去向（`scrap_mode` + 回执/说明），不留去向的核销等于让东西凭空消失。
 */
const { db, now } = require('../src/db');

const t = now();

/* ---------------- 1. 实物档案 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS custody_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_no TEXT NOT NULL,                          -- 实物编号 WW+YYYYMMDD+序号（一物一码）
  item_code TEXT,                                 -- 外来编号（工衣胸标 / 钥匙牌号 / 资产编号）
  company_id INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'uniform',           -- uniform 工衣 / tool 工具 / key 钥匙 / card 门禁卡 / ppe 劳保 / other 其他
  name TEXT NOT NULL,
  spec TEXT,
  size TEXT,                                      -- 尺码（工衣）
  color TEXT,
  durable INTEGER NOT NULL DEFAULT 1,             -- 1 一物一码，同一时间只能一个人在用
  qty_total REAL NOT NULL DEFAULT 1,              -- 在册数量（消耗品按批次数量）
  unit TEXT NOT NULL DEFAULT '件',
  require_return INTEGER NOT NULL DEFAULT 1,      -- 1 必须归还（钥匙/工具/门禁卡）/ 0 不强制（工衣）
  max_per_person REAL NOT NULL DEFAULT 0,         -- 个人同时在手上限（工衣 2 套/季），0 = 不限
  life_months INTEGER NOT NULL DEFAULT 0,         -- 建议更换周期（只提示，不生成任务）
  asset_id INTEGER,                               -- 关联固定资产卡（TS-N12-12 一物一码）
  location TEXT,                                  -- 存放位置（钥匙柜 A-03 等）
  status TEXT NOT NULL DEFAULT 'active',          -- active 在册 / hold 待处理（损坏待定，不可发） / scrapped 已处置
  scrap_no TEXT,                                  -- 处置单号 / 财务回执号
  scrap_mode TEXT,                                -- dispose 报废变卖 / transfer 转出 / write_off 盘亏核销
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custody_item_no ON custody_items(item_no);
CREATE INDEX IF NOT EXISTS idx_custody_item_kind ON custody_items(kind, status);
CREATE INDEX IF NOT EXISTS idx_custody_item_asset ON custody_items(asset_id);
`);

/* ---------------- 2. 领用记录 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS custody_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rec_no TEXT NOT NULL,                           -- LY+YYYYMMDD+序号
  item_id INTEGER NOT NULL,
  item_kind TEXT,                                 -- 冗余：档案改了类别，历史记录仍按当时口径统计
  durable INTEGER NOT NULL DEFAULT 1,             -- 冗余：同上，且唯一索引要用
  employee_id INTEGER,
  employee_name TEXT NOT NULL,                    -- 冗余：员工离职删除档案后仍要能追责
  dept_id INTEGER,
  dept_name TEXT,
  qty REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'issued',          -- draft 草稿 / issued 使用中 / awaiting 待归还 / returned 已归还 / lost 遗失 / written_off 已核销
  issued_at TEXT,
  issued_by TEXT,
  handover_by TEXT,                               -- 领用人签收
  expected_return_at TEXT,                        -- 空 = 不设期限（工衣不强制）
  returned_at TEXT,
  returned_qty REAL NOT NULL DEFAULT 0,
  received_by TEXT,                               -- 收回人
  condition TEXT,                                 -- good 完好 / worn 磨损 / damaged 损坏 / lost 遗失
  prev_record_id INTEGER,                         -- 转交来源（原记录）
  clearance_id INTEGER,                           -- 由哪次离职清退生成
  attachment TEXT,                                -- 签收单/照片路径
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  demo_tag TEXT
);
-- 一物一码不双领：同一实物同时只能有一条「还在人身上」的记录。
-- 草稿不占（还没发出去），遗失/核销不占（东西已经没了）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_custody_open_item ON custody_records(item_id)
  WHERE durable = 1 AND returned_at IS NULL AND status IN ('issued','awaiting');
CREATE INDEX IF NOT EXISTS idx_custody_rec_item ON custody_records(item_id);
CREATE INDEX IF NOT EXISTS idx_custody_rec_emp ON custody_records(employee_id, status);
CREATE INDEX IF NOT EXISTS idx_custody_rec_status ON custody_records(status);
CREATE INDEX IF NOT EXISTS idx_custody_rec_due ON custody_records(expected_return_at);
CREATE INDEX IF NOT EXISTS idx_custody_rec_clear ON custody_records(clearance_id);
`);

/* ---------------- 3. 离职清退单 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS custody_clearances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clearance_no TEXT NOT NULL,
  employee_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  dept_id INTEGER,
  dept_name TEXT,
  leave_date TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',            -- open 清退中 / closed 已清完
  must_total INTEGER NOT NULL DEFAULT 0,          -- 必须归还件数（钥匙/工具/门禁卡）
  must_done INTEGER NOT NULL DEFAULT 0,
  optional_total INTEGER NOT NULL DEFAULT 0,      -- 可选（工衣）：不退回也允许结案
  optional_done INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  closed_at TEXT,
  closed_by TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custody_clr_no ON custody_clearances(clearance_no);
CREATE INDEX IF NOT EXISTS idx_custody_clr_emp ON custody_clearances(employee_id, status);
`);

/* ---------------- 4. 损坏责任复核 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS custody_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_no TEXT NOT NULL,                         -- DZ+YYYYMMDD+序号
  record_id INTEGER,
  item_id INTEGER,
  employee_id INTEGER,
  employee_name TEXT,
  damage_type TEXT NOT NULL DEFAULT 'damaged',    -- damaged 损坏 / lost 遗失
  qty REAL NOT NULL DEFAULT 1,
  found_at TEXT,
  desc_text TEXT,
  claim_amount REAL NOT NULL DEFAULT 0,           -- 申报损失（采购价/重置价）
  review_status TEXT NOT NULL DEFAULT 'pending',  -- pending 待复核 / cleared 无责 / partial 部分责任 / liable 全责 / closed 已结案
  liable_pct REAL,                                -- 责任比例 0~100
  liable_amount REAL,                             -- 定责金额 = claim_amount × pct
  reviewer_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  -- 财务确认独立一步：没有回执号，定责金额只是「建议」，不进任何账
  finance_confirm_no TEXT,
  finance_confirmed_by TEXT,
  finance_confirmed_at TEXT,
  finance_note TEXT,
  status TEXT NOT NULL DEFAULT 'open',            -- open / closed
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custody_claim_no ON custody_claims(claim_no);
CREATE INDEX IF NOT EXISTS idx_custody_claim_status ON custody_claims(review_status);
CREATE INDEX IF NOT EXISTS idx_custody_claim_rec ON custody_claims(record_id);
CREATE INDEX IF NOT EXISTS idx_custody_claim_emp ON custody_claims(employee_id);
`);

/* ---------------- 5. 流转时间线 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS custody_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,                      -- item / record / claim / clearance
  target_id INTEGER NOT NULL,
  action TEXT NOT NULL,                           -- create/issue/return/transfer/claim/review/finance/scrap/write_off
  detail TEXT,
  qty REAL,
  actor TEXT,
  created_at TEXT NOT NULL,
  demo_tag TEXT
);
CREATE INDEX IF NOT EXISTS idx_custody_act_target ON custody_actions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_custody_act_action ON custody_actions(action, created_at);
`);

console.log('资产工衣与领归：5 张表 + 索引已就绪');
console.log('  custody_items 实物档案 / custody_records 领用记录');
console.log('  custody_clearances 离职清退 / custody_claims 损坏复核 / custody_actions 时间线');
