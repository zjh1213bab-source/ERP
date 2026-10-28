/**
 * 客户进度发布（TS-N22-02 / TS-N22-03）
 * ========================================================================
 * 现状的问题：客户想知道「我的货做到哪了」，只能打电话问跟单；
 * 系统里的报工、外发交出/回货、检验、发运全都有，但**一条都没对外**。
 *
 * ## 这一版做的四件事
 *
 * 1. **三条生产路线**：本厂 / 裁片外发 / 整单外发（`order_routes`，可自动推断也可人工改）
 * 2. **内部进度 → 客户投影**：内部照常报工，客户只看「发布过」的投影，不是直连内部表
 * 3. **发布留版本**：撤回不删行，改状态 + 版本号 +1，历史可查
 * 4. **对外脱敏**：不出现工厂名、工人姓名、成本、返工数、内部备注
 *
 * ## 五条口径（每条都对应一种做错的方式）
 *
 * 1. **客户看的不是内部表，是快照**。直连内部表会导致「今天看到的和昨天不一样」，
 *    客户截图来争论时无法复现；也挡不住内部字段被顺手带出去。
 * 2. **裁片外发没回厂，绝不能显示「完工 / 可发货」**（原型原话）。
 *    外发只交了布片、后整与终检都没做，标完工就是骗客户。
 * 3. **不留工厂身份**：外发厂名、单价、加工费一律不出现在投影里，
 *    客户看到的是「外发加工中 / 已回货」，不是「某某制衣厂」。
 * 4. **不发返工数**：返工率是内部管理指标，给客户只会引来无谓的信任问题；
 *    合格数也要显式打开才给（默认关）。
 * 5. **撤回必须写原因**：错发了进度，客户那边已经看到，撤回本身就是一次对外沟通。
 */
const { db, now } = require('../src/db');

const t = now();

/* ---------------- 1. 生产路线 ---------------- */
// 不往 orders 加列：orders 正被并行会话改，另开一张表更安全，
// 也便于记录「这条路线是自动推断的还是人工指定的」。
db.exec(`
CREATE TABLE IF NOT EXISTS order_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  route TEXT NOT NULL DEFAULT 'inhouse',       -- inhouse 本厂 / cut_outsource 裁片外发 / full_outsource 整单外发
  source TEXT NOT NULL DEFAULT 'auto',         -- auto 自动推断 / manual 人工指定
  note TEXT,
  updated_by TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_route ON order_routes(order_id);
`);

/* ---------------- 2. 对外发布版本 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS progress_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',    -- published / withdrawn
  route TEXT NOT NULL,
  snapshot TEXT NOT NULL,                      -- 客户可见的完整快照（JSON）
  stage_count INTEGER DEFAULT 0,
  done_count INTEGER DEFAULT 0,
  can_complete INTEGER DEFAULT 0,              -- 快照当时是否允许宣称完工/可发货
  show_qty INTEGER DEFAULT 0,                  -- 是否对外给了合格数
  published_by TEXT,
  published_at TEXT,
  withdrawn_by TEXT,
  withdrawn_at TEXT,
  withdraw_reason TEXT,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pub_ver ON progress_publications(order_id, version_no);
-- 同一个订单同时只能有一份生效的对外进度（并发发布在这里兜底）
CREATE UNIQUE INDEX IF NOT EXISTS uq_pub_live ON progress_publications(order_id) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_pub_order ON progress_publications(order_id);
`);

const n = (tb) => db.prepare(`SELECT COUNT(*) c FROM ${tb}`).get().c;
console.log(`order_routes: ${n('order_routes')} 行 · progress_publications: ${n('progress_publications')} 行`);
console.log('客户进度发布 表结构就绪');
