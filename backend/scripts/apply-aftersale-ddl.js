/**
 * 售后与对账资料（TS-N22-08）
 * ========================================================================
 * 现状的两个缺口
 *
 * 1. **客户没法提售后**。仓库侧其实已经有「客户退货单 → 点收 → 逐件判定 → 良品入库」
 *    的完整流程（`stock_returns`，`routes/spot.js`），但入口只有内部人员能开：
 *    客户发现少件、破洞、色差，只能在微信里发几张照片，然后跟单口头答应一句
 *    「我帮你申请一下」—— 申请没申请、处理到哪一步、赔了多少钱，没有任何记录。
 * 2. **对账只有在线列表**。`services/statement.js` 能算出带逐笔流水的对账单，
 *    但客户财务要的是**能盖章、能下载、能存档**的文件。现在只能让业务截图发过去。
 *
 * ## 这一版做的两件事
 *
 * - `after_sale_tickets`：客户自助提售后（带照片），内部受理后**分四条轨道**走 ——
 *   退款 / 实物实收 / 质量检验 / 再上架，另加一条独立的**追偿**。
 *   实物部分**不另建流程**，接在已有的 `stock_returns` 上（`stock_return_id`）。
 * - `statement_files`：把某客户某期间的对账单**定版成快照**，经授权发布后客户才能下载。
 *
 * ## 六条口径（每条都对应一种做错的方式）
 *
 * 1. **退款不直接恢复库存**（原型原话）。退款只动钱，入库只由「检验合格」这一步
 *    写库存（`applyStock`）。两件事混在一起，就会出现「钱退了、货没回来、库存还多了」。
 * 2. **四条轨道状态不存副本**：实收/检验/再上架一律**从关联退货单实时算**。
 *    存一份副本必然和仓库页说两个数（同一判断只能一份实现）。
 * 3. **追偿独立于退款**。客户退款是赔出去，工厂追偿是收回来，两条线各有各的金额与状态。
 *    混在一起，财务永远对不上「这笔售后到底赚了还是亏了」。
 * 4. **赔偿金额不能超订单行金额**。客户手滑多打一个零，不该变成一张巨额退款单。
 * 5. **对账文件必须授权才能下**：草稿不对外、撤销立即失效、过期自动失效、
 *    每次下载留痕。原型原话「对账页面只提供本组织获授权文件」。
 * 6. **对账不平时不许发**：`statement.build()` 算出的 `check_diff ≠ 0` 说明系统内部
 *    有发票的 `paid_amount` 被手工改过或有收款没走流水 —— 这种账发出去，
 *    客户一眼就能挑出问题，先自己查清。
 */
const { db, now } = require('../src/db');

const t = now();

/* ---------------- 1. 售后单 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS after_sale_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT NOT NULL,
  company_id INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'customer',     -- customer 客户自助 / internal 内部代提
  customer_id INTEGER,
  customer_name TEXT,
  order_id INTEGER,
  order_no TEXT,
  order_item_id INTEGER,
  style_no TEXT,
  product_name TEXT,
  qty REAL NOT NULL DEFAULT 0,
  amount_claim REAL NOT NULL DEFAULT 0,        -- 客户索赔金额（上限 = 订单行金额）
  currency TEXT NOT NULL DEFAULT 'USD',
  reason_code TEXT NOT NULL,                   -- quality/short/wrong/damaged/late/other
  reason TEXT,
  photo_count INTEGER NOT NULL DEFAULT 0,      -- 附件在 attachments（target_type='after_sale'）
  resolution TEXT NOT NULL,                    -- return 退货 / replace 补件 / refund 赔款 / repair 返修
  status TEXT NOT NULL DEFAULT 'submitted',    -- submitted/accepted/rejected/handling/settled/cancelled

  -- 轨道一：退款（只动钱，绝不动库存）
  refund_status TEXT NOT NULL DEFAULT 'none',  -- none/pending/paid
  refund_amount REAL NOT NULL DEFAULT 0,
  refund_method TEXT,
  refund_at TEXT,
  refund_by TEXT,
  refund_note TEXT,
  goods_returned INTEGER,                      -- 退款时是否确认货物会回厂：1 会 / 0 不会（客户保留）

  -- 轨道二~四：实物实收 / 检验 / 再上架 —— 全部由关联退货单实时算，不存副本
  stock_return_id INTEGER,                     -- 关联 stock_returns（实物部分接在已有流程上）

  -- 轨道五：追偿（向工厂/供应商要回来，与退款互不影响）
  recovery_status TEXT NOT NULL DEFAULT 'none', -- none/pending/done/waived
  recovery_party TEXT,                          -- factory 本厂 / supplier 供应商 / carrier 货代
  recovery_amount REAL NOT NULL DEFAULT 0,
  recovery_note TEXT,

  owner_role TEXT,                              -- 主责：sales / quality / production / warehouse
  due_date TEXT,
  conclusion TEXT,
  reject_reason TEXT,
  handled_by TEXT,
  handled_at TEXT,
  settled_at TEXT,
  demo_tag TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_as_no ON after_sale_tickets(ticket_no);
CREATE INDEX IF NOT EXISTS idx_as_customer ON after_sale_tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_as_order ON after_sale_tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_as_status ON after_sale_tickets(status);
-- 同一个订单行、同一个原因、还在处理中的，只能有一条
-- （客户连点五次「提交」，不该生成五张要人人处理的单）
CREATE UNIQUE INDEX IF NOT EXISTS uq_as_open
  ON after_sale_tickets(company_id, order_item_id, reason_code, resolution)
  WHERE status IN ('submitted', 'accepted', 'handling');
`);

/* ---------------- 2. 对账资料（授权发布） ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS statement_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_no TEXT NOT NULL,
  company_id INTEGER NOT NULL DEFAULT 1,
  customer_id INTEGER NOT NULL,
  customer_name TEXT,
  period_from TEXT NOT NULL,                   -- YYYY-MM-DD
  period_to TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'monthly',        -- monthly 月度对账 / payment_notice 付款通知
  version_no INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  file_name TEXT,                              -- 下载时的文件名（客户财务拿去存档）
  snapshot TEXT NOT NULL,                      -- 定版快照（JSON）：逐笔流水 + 汇总 + 告示
  amount_opening REAL DEFAULT 0,
  amount_invoiced REAL DEFAULT 0,
  amount_paid REAL DEFAULT 0,
  amount_closing REAL DEFAULT 0,
  check_diff REAL DEFAULT 0,                   -- 发布那一刻的内部校验差额，必须为 0 才允许发布
  status TEXT NOT NULL DEFAULT 'draft',        -- draft/published/revoked
  granted_by TEXT,                             -- 授权人（谁批准可以给客户看）
  granted_at TEXT,
  expire_at TEXT,                              -- 授权有效期；空 = 长期
  revoked_by TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  last_download_at TEXT,
  note TEXT,
  created_by TEXT,
  demo_tag TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sf_no ON statement_files(file_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sf_ver ON statement_files(customer_id, period_from, period_to, kind, version_no);
-- 同一客户同一期间同一类型，同时只能有一份生效（重新发布自动把旧的转 revoked）
CREATE UNIQUE INDEX IF NOT EXISTS uq_sf_live
  ON statement_files(customer_id, period_from, period_to, kind)
  WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_sf_customer ON statement_files(customer_id);
`);

const n = (tb) => db.prepare(`SELECT COUNT(*) c FROM ${tb}`).get().c;
console.log(`after_sale_tickets: ${n('after_sale_tickets')} 行 · statement_files: ${n('statement_files')} 行`);
console.log('售后与对账资料 表结构就绪');
