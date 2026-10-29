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
 * 已接入（v1.59 起）：
 *   1. 订单域：列表 / 导出 / 工作台统计 / 详情 / 扫码查询 / 单据页 / 改名 / 图片 /
 *      流转 / 批量流转 / 回退；
 *   2. 应收应付域：往来账总览 / 账龄 / 应收列表 / 应付列表 / 新建 / 作废 /
 *      收付款列表 / 登记收付款与核销 / 红冲 / 未结清单；应付台账 / 付款计划 /
 *      供应商明细；应收催收（台账 / 任务 / 统计 / 详情 / 跟进）。
 *   3. 库房单据域：领料单 / 退料单 / 盘点单（列表 / 详情 / 建单 / 备料 / 发料 /
 *      结案 / 取消 / 退料入库 / 开始盘点 / 录数 / 提交 / 调账）＋订单备料建议。
 *      注意这里的边界：**实物存量不分主体**（`materials` / `stock_items` /
 *      `stock_ledger` 没有 `company_id`，一个仓里有多少是物理事实），
 *      只有**单据**按主体 —— 详见 `services/matflow.js` 顶部说明。
 *   4. 写入侧：开票（订单发货开应收、采购入库开应付）、手工开票、登记收付款、
 *      付款申请执行付款、领料单 / 退料单 / 盘点单，都按主体落 `company_id`。
 *
 * **未接入**：生产报工 / 采购 / 人事薪酬 / 集团报表 / 资金计划 / 对账单 /
 * 数据导出。也就是说这套东西对"分部看不到总部单据"这件事做到了
 * **订单、账款、库房单据三层**；要全站隔离，按 `docs/DB-SCHEMA.md` 顶部「数据库边界」
 * 的清单逐域接入，每接一个域就在冒烟里加一条"跨公司读不到"的用例。
 *
 * 判断某个接口该不该接的口径：**它返回的是不是"某个法人主体的账"**。
 * 是 → 接入；天生跨主体的合并报表 → 不接，但要显式收 `company_id` 参数。
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
  return assertRow(user, 'orders', id, '订单');
}

/** 表名白名单格式（表名会拼进 SQL，绝不能直接吃调用方传来的字符串） */
const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * 取任意一张带 `company_id` 的表的一行，并校验归属
 *
 * `assertOrder` 只是它的一个特例。往来账、催收、账龄这些地方都要"按 id 取一条
 * 再判归属"，各写一遍的结果是某处漏判 —— 而漏判的表现是"能打开别家的单"，
 * 从日志里看不出来。所以只留这一个实现，调用方传表名与提示名。
 */
function assertRow(user, table, id, label = '记录') {
  if (!TABLE_RE.test(String(table))) throw new Error(`assertRow 表名非法：${table}`);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id));
  if (!row) return { ok: false, reason: `${label}不存在`, status: 404 };
  if (!canSee(user, row)) return { ok: false, reason: `${label}不存在`, status: 404 };
  return { ok: true, row };
}

/**
 * 写数据时该落到哪个主体
 *
 * 三个坑：
 *   1. 这些表的 `company_id` 都是 `NOT NULL DEFAULT 1` —— 不显式写就一律记到总部。
 *      分部开一张应收，开完自己看不见（被范围过滤掉），还进了总部的账。
 *   2. 集团角色（admin/boss）可以**显式指定**主体（合并口径要补录/代录）；
 *      没指定就用他自己绑定的那个，不猜。
 *   3. 没绑定主体的历史账号回退 1，但启动时上线清单 `users_bound` 会点名。
 */
function writeCompanyOf(user, explicit) {
  const s = of(user);
  const v = Number(explicit);
  if (s.cross && v > 0) return v;
  return s.companyId || 1;
}

/**
 * 传给 service 层的主体 id：集团角色 → null（不过滤），其余 → 自己的主体
 *
 * 为什么不用 `clause()` 拼 SQL：`payable` / `collection` 这些服务要算汇总、
 * 要按供应商分组，拼条件得穿到每个查询里；它们本来就是"按参数算一份报表"，
 * 直接传一个 `companyId` 更不容易漏。
 */
function filterCompanyId(user) {
  const s = of(user);
  if (s.cross) return null;
  return s.companyId || null;
}

module.exports = {
  GROUP_ROLES, of, clause, where, canSee,
  assertOrder, assertRow, writeCompanyOf, filterCompanyId
};
