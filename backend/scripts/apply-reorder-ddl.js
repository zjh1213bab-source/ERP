/**
 * 历史订单再次购买（TS-N20-08「再来一单」）
 * ========================================================================
 * 原型原话：**「历史再购只复制选品条件和原订单关联；使用当前授权、可供数量、
 * 当前适用价格/技术版本重新确认，不沿用过期折扣、占用或付款状态。」**
 *
 * 这句话说清了「再来一单」唯一容易做错的地方：**它看起来像复制订单，实际上是一次新询价**。
 * 直接复制历史单会带来四种错误，每一种都会让客户拿着旧价来吵架：
 *
 *   1. 过期价 —— 客户去年的专属价今年已经调过，复制过去就是「按旧价卖」
 *   2. 过期折扣 —— 当时的活动折扣早就结束
 *   3. 过期占用 —— 上次占的库存/产能早被别的单用掉了
 *   4. 过期状态 —— 上次已付款，复制成新单会显示「已付款」
 *
 * 所以做法是：只复制**款号 + 颜色 + 尺码 + 数量**（选品条件）和**源订单号**（关联），
 * 价格、可售量、技术版本一律按**现在**重新算，差异逐条列给客户看，让他确认后再提交。
 *
 * ## 三列（加在 mall_inquiries 上）
 * - `source_order_id` / `source_order_no`  这次询价是从哪张历史订单发起的
 * - `reorder_diff`  提交那一刻的差异快照（JSON）
 *
 * 第三列是必须的：客户三个月后问「为什么这次比上次贵」，得能看到当时系统提示过什么、
 * 提示的是哪一档价差。没有快照就只能说「系统算的」。
 *
 * ## 差异类型（每条都对应一种客户必须知道的事）
 * - `off_shelf`    款式已下架 —— **不能提交**，得让销售重新上架或改推替代款
 * - `price_changed` 单价变了（涨/跌都报，跌也要报，否则客户以为系统出错）
 * - `moq_short`    历史数量低于当前起订量 —— 提示建议数量，**不自动加量**
 * - `stock_short`  当前可售量不够 —— 允许提交但标「需确认可供量」（可能在产）
 * - `size_note`    历史有多个尺码，当前只有款级库存 —— 明说无法按尺码确认，交销售核
 * - `tech_newer`   该款已有更高版本的技术包 —— 再购按当前技术重新确认
 * - `ref_only`     已经查不到当前商品（product_id 也变了）—— 按款号匹配到替代款时也提示
 */

const { db } = require('../src/db');

function ensureColumns() {
  const cols = db.prepare('PRAGMA table_info(mall_inquiries)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE mall_inquiries ADD COLUMN ${ddl}`);
  };
  add('source_order_id', 'source_order_id INTEGER');
  add('source_order_no', 'source_order_no TEXT');
  add('reorder_diff', 'reorder_diff TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mall_inq_source ON mall_inquiries(source_order_id)');
  console.log('mall_inquiries：source_order_id / source_order_no / reorder_diff 已就绪');
}

if (require.main === module) {
  ensureColumns();
}

module.exports = { ensureColumns };
