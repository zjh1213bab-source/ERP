/**
 * 公司数据范围（`company_id` 口径）
 * ============================================================
 * ## 先分清两件事
 *
 * 这套系统里 `company_id` 代表**集团内的法人主体**（总部 / 分部 / 子公司），
 * 用于合并报表、分部对比、按主体出账 —— 它**不是**多租户隔离键。
 *
 * 但"不是多租户"不等于"可以随便跨主体看"：分部业务员打开订单列表，
 * 看到的是总部的单，这是数据泄露，不是功能。
 *
 * 所以这里定一条**单一规则**：
 *   默认只能看自己 `users.company_id` 的数据；
 *   集团级角色（admin / boss）跨主体可见 —— 合并报表与分部对比靠他们。
 *
 * ## 为什么不做成全局中间件
 *
 * 因为 72 张表带 `company_id`，但语义分三类：
 *   1. 业务单据（orders / ar_invoices / material_issues…）→ 必须按主体隔离；
 *   2. 集团报表（consolidation_* / segment_reports）→ 天生要跨主体，按参数选主体；
 *   3. 共享主数据（products / 工艺 / 模板）→ 没有 `company_id`，全集团共用。
 * 一个中间件统一去过滤，第 2 类会被拦死、第 3 类会直接报错。
 * 所以规则放在这里，由各路由显式调用 —— 调用点看得见，才查得清。
 *
 * ## 覆盖到哪、没覆盖到哪
 *
 * 当前**已接入**：订单域（列表 / 导出 / 工作台统计 / 详情 / 扫码查询 / 单据页 /
 * 改名 / 图片 / 流转 / 回退）。
 * **未接入**：其它业务域（应收应付、库存、生产、人事…）。也就是说，
 * 现在这套东西**仍然只适合单主体使用**；要真正做多主体隔离，按
 * `docs/DB-SCHEMA.md` 顶部「数据库边界」那一节的清单逐域接入并补断言，
 * 每接入一个域，就在冒烟里加一条"跨公司读不到"的用例。
 */
const { db } = require('../db');

/** 集团级角色：需要跨主体看合并数、做跨主体操作 */
const GROUP_ROLES = new Set(['admin', 'boss']);

/** 解析当前用户的可见范围 */
function of(user) {
  const role = String((user && user.role) || '');
  const companyId = user && user.company_id !== undefined && user.company_id !== null
    ? Number(user.company_id) || null
    : null;
  const cross = GROUP_ROLES.has(role);
  return { role, companyId, cross };
}

/**
 * 拼 SQL 条件（只追加一个 AND，不改原查询结构）
 *
 * 用法：
 *   const sc = clause(req.user, 'o.company_id');
 *   const rows = db.prepare(`SELECT ... WHERE 1=1 ${sc.sql}`).all(...sc.params);
 *
 * 没绑定公司的账号（历史数据 / 脚本建的号）返回空条件并**不改动查询** ——
 * 这类账号能不能用是权限问题（`access`），不该在这里悄悄变成"什么都看不到"，
 * 那样表现成"页面空白"，比报错更难查。上线清单里 `users_bound` 会盯住这类账号。
 */
function clause(user, col = 'company_id') {
  const s = of(user);
  if (s.cross || !s.companyId) return { sql: '', params: [], scoped: false };
  return { sql: ` AND ${col} = ?`, params: [s.companyId], scoped: true };
}

/** WHERE 版本（查询还没有 AND 时用） */
function where(user, col = 'company_id') {
  const s = of(user);
  if (s.cross || !s.companyId) return { sql: '', params: [], scoped: false };
  return { sql: `${col} = ?`, params: [s.companyId], scoped: true };
}

/** 这一行数据当前用户能不能看 */
function canSee(user, row) {
  const s = of(user);
  if (s.cross) return true;
  if (!s.companyId) return true;
  if (!row) return false;
  return Number(row.company_id) === s.companyId;
}

/**
 * 取一张订单并校验归属 —— 不属于本公司时**当作不存在**
 *
 * 为什么不返回 403：403 等于告诉对方"这个 id 存在，只是你没权限"，
 * 逐个 id 试就能数出别家有多少张单。404 是这里唯一正确的回答。
 */
function assertOrder(user, id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, reason: '订单不存在', status: 404 };
  if (!canSee(user, row)) return { ok: false, reason: '订单不存在', status: 404 };
  return { ok: true, row };
}

module.exports = { GROUP_ROLES, of, clause, where, canSee, assertOrder };
