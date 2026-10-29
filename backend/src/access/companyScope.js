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
 * 已接入（v1.59 起，逐域推进）：
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
 *   4. 生产执行域：报工明细与汇总（读/写/删）、工序节点（列表 / 弹窗 / 推进 / 初始化 /
 *      删除 / 从看板分配）、生产看板、订单跟踪看板（含统计卡片）、**生产交付报表**
 *      （准交 / 工厂段达成 / 效率 / 质量 / 在制龄 / 计划偏差 / 裁床 / 交期分解 / 总览 / 导出）。
 *      这些表同样没有 `company_id`，全部**按 `order_id` 判归属**（见 `orderOwnedSql`）。
 *   5. 采购域：采购单（列表 / 详情 / 新建 / 下单 / 点收 / 删除 / 关联订单）、
 *      收料单（看板 / 待检汇总 / 详情 / 改行 / 检验 / 处置 / 作废）。
 *      `purchase_orders` 在 v1.63 才加 `company_id`（备货采购不挂销售订单，推不出来）；
 *      收料单没有这一列，按 `po_id` 走父表。
 *   6. 人事薪酬域：员工档案 / 考勤 / 请假 / 月度工资单（生成 / 列表 / 汇总 / 导出 /
 *      确认 / 发放 / 批量）。`employees` 在 v1.64 才加 `company_id`；
 *      考勤与请假按 `employee_id` 走父表。
 *   7. 计件工资域：试算 / 核算单（列表 / 详情 / 新建 / 确认 / 作废 / 工资条 / 导出）。
 *      **试算按员工主体**（钱发给谁就记谁的账），核算单按表自己的 `company_id`（v1.65 加）。
 *      工价（`piece_rates`）与计件策略（`piece_wage_config`）是**集团主数据，不分主体** ——
 *      同一个款同一道工序在一个集团里只能有一个工价，否则同一批货两个分部算出两个工钱。
 *   8. 资产工衣与领归域：实物档案（含处置 / 恢复 / 时间线）、领用台账（登记 / 发放 /
 *      归还 / 转交）、离职清退、损坏定责与财务确认、看板。
 *      这一域**不需要加列**：`custody_items` 自带 `company_id`；领用与定责按**实物**父表判
 *      （东西是谁的资产），清退按**员工**父表判。
 *   9. 写入侧：开票（订单发货开应收、采购入库开应付）、手工开票、登记收付款、
 *      付款申请执行付款、领料单 / 退料单 / 盘点单、报工、采购单、员工档案、
 *      工资单、计件核算单、实物档案，都按主体落 `company_id`。
 *
 * **未接入**：财务资产台账（`assets` 有列但页面未接）/ 集团报表 / 资金计划 / 对账单 / 数据导出。
 * 也就是说这套东西对"分部看不到总部单据"这件事做到了
 * **订单、账款、库房单据、生产（执行 + 报表）、采购、人事薪酬、计件工资、资产领归八层**；
 * 要全站隔离，按 `docs/DB-SCHEMA.md` 顶部「数据库边界」的清单逐域接入，
 * 每接一个域就在冒烟里加一条"跨公司读不到"的用例。
 *
 * 判断某个接口该不该接的口径：**它返回的是不是"某个法人主体的账"**。
 * 是 → 接入；天生跨主体的合并报表 → 不接，但要显式收 `company_id` 参数。
 */
const { db } = require('../db');
const config = require('../config');

/**
 * ## 单公司模式：这个文件里的多主体逻辑**全部被短路**
 *
 * 系统实际只服务一家公司，所以默认 SINGLE = true：
 * 下面每一个函数都保留着完整的多主体实现（不删，删了以后要用得重写），
 * 但都在开头被这个开关挡掉。**等价于把多公司逻辑注释掉，只留一个总闸。**
 *
 * 生效方式（一处开关，8 个域零改动）：
 *   - `of()` 返回 `cross: true` → `clause()` / `canSee()` / `filterCompanyId()`
 *     / 三个 SQL 生成器全部退化成"不过滤"（它们本来就以 cross 为唯一判据）；
 *   - `writeCompanyOf()` 恒返回抬头 id → 新数据统一记到这一家公司；
 *   - `assertRow()` / `assertOrder()` 仍查库判存在，但不再判归属 → 不再有跨主体 404。
 *
 * 为什么敢这么改：隔离逻辑虽然散在 8 个域、几十处调用上，但**判据只有一处**
 * （就是这个文件的 `of()`）。判据只有一份，开关才可能只有一处。
 *
 * 切回多主体：.env 写 `SINGLE_COMPANY=0` 重启即可，数据不用迁
 * （`company_id` 一直在写，只是不再拿来过滤）。切回后 8 个域的 112 条范围断言重新生效。
 */
const SINGLE = !!config.singleCompany;

/** 集团级角色：需要跨主体看合并数、做跨主体操作（单公司模式下不再使用） */
const GROUP_ROLES = new Set(['admin', 'boss']);

/**
 * 唯一公司抬头 —— 单据、报表、打印都用它
 *
 * 取「总部优先，其次 id 最小」那一条：历史库里可能有 4 个法人主体，
 * 单公司模式下只有这一个会被当成"本公司"，其余记录保留但不参与任何判断
 * （不删数据：它们的 id 还挂在历史单据的 `company_id` 上，删了会变成孤儿）。
 */
function header() {
  const r = db.prepare(
    "SELECT id, code, name, short_name FROM companies ORDER BY (CASE WHEN type='headquarters' THEN 0 ELSE 1 END), id LIMIT 1"
  ).get();
  return r || { id: 1, code: null, name: '本公司', short_name: '本公司' };
}

/** 当前是否单公司模式（前端 / 其他模块据此隐藏集团入口） */
function isSingle() {
  return SINGLE;
}

/**
 * 公司下拉的取值（驾驶舱、行政运营、CRM 等"选一个主体"的地方共用）
 *
 * 单公司模式只返回抬头那一条：**下拉里只有一个选项**，比"隐藏下拉但接口还吐 4 家"
 * 更不容易出岔 —— 有人直接调接口时看到的也是同一家公司。
 */
function listForPicker() {
  if (SINGLE) {
    const h = header();
    const full = db.prepare('SELECT id, code, name, short_name, type FROM companies WHERE id = ?').get(Number(h.id) || 1);
    return [full || { id: Number(h.id) || 1, code: h.code, name: h.name, short_name: h.short_name, type: 'headquarters' }];
  }
  return db.prepare("SELECT id, code, name, short_name, type FROM companies WHERE status='active' ORDER BY id").all();
}

/** 解析当前用户的可见范围 */
function of(user) {
  /**
   * 单公司模式：所有人都当成"跨主体角色"。
   *
   * 这一个 return 撑起了整个开关 —— clause / where / canSee / filterCompanyId
   * 以及三个 SQL 生成器全部以 cross 为唯一判据，于是它们一起退化成"不过滤"。
   * 也就是说：**这里改一行，8 个域的范围隔离同时关闭**，各域代码不用动。
   */
  if (SINGLE) {
    const role = String((user && user.role) || '');
    return { role, companyId: Number(header().id) || 1, cross: true, single: true, unbound: false };
  }
  const role = String((user && user.role) || '');
  const companyId = user && user.company_id !== undefined && user.company_id !== null
    ? Number(user.company_id) || null
    : null;
  const cross = GROUP_ROLES.has(role);
  /**
   * `unbound` = 既不是集团角色、又没绑主体。
   *
   * 这种账号在范围上**无解**：往紧里判它看不到任何数据（页面全空，人会以为是系统坏了），
   * 往松里判它能看到所有主体（就是越权）。所以不在这里猜，而是标出来让
   * 鉴权中间件直接拒绝访问（见 `scopeProblem`）—— 报错说清楚，比两种静默行为都好。
   */
  return { role, companyId, cross, unbound: !cross && !companyId };
}

/**
 * 该账号的数据范围是否有问题；没问题返回 null，有问题返回一句能直接给用户看的话
 *
 * 调用点只有 `middleware/auth.js` 一处（每个请求一次），在那里统一拒绝，
 * 而不是让 8 个域的每个查询各自处理"没绑主体怎么办" —— 那必然出现
 * 有的域拦、有的域放，最后等于没拦。
 */
function scopeProblem(user) {
  const s = of(user);
  if (!s.unbound) return null;
  return '该账号未绑定公司主体，无法确定能看到哪些数据。请联系管理员在「用户与角色」里指定所属公司后重新登录';
}

/**
 * 拼 SQL 条件（只追加一个 AND，不改原查询结构）
 *
 * 用法：
 *   const sc = clause(req.user, 'o.company_id');
 *   const rows = db.prepare(`SELECT ... WHERE 1=1 ${sc.sql}`).all(...sc.params);
 *
 * ## 没绑主体的账号为什么在这里"炸"而不是返回空条件
 *
 * v1.67 及以前这里返回空条件（不过滤）—— 理由是"表现成页面空白比报错更难查"。
 * 但那个选择的实际后果是：**新建的业务账号能看到所有主体的数据**，
 * 而且页面上看不出任何异常（列表有数、金额有数，只是多了别人的）。
 * 越权不该靠人去发现。
 *
 * 现在口径改了：`unbound` 是数据错误，早报早改（与 `orderOwnedSql` 对非法 id 抛错一致）。
 * 正常请求根本走不到这里 —— `middleware/auth.js` 已经在入口把这些账号 403 掉，
 * 所以这行抛错是**兜底**：真被触发说明有代码绕过了鉴权中间件，那更该炸。
 */
function clause(user, col = 'company_id') {
  const s = of(user);
  if (s.unbound) {
    throw new Error(`数据范围未确定：账号未绑定公司主体（${col} 无法过滤）`);
  }
  if (s.cross || !s.companyId) return { sql: '', params: [], scoped: false };
  return { sql: ` AND ${col} = ?`, params: [s.companyId], scoped: true };
}

/** WHERE 版本（查询还没有 AND 时用） */
function where(user, col = 'company_id') {
  const s = of(user);
  if (s.unbound) {
    throw new Error(`数据范围未确定：账号未绑定公司主体（${col} 无法过滤）`);
  }
  if (s.cross || !s.companyId) return { sql: '', params: [], scoped: false };
  return { sql: `${col} = ?`, params: [s.companyId], scoped: true };
}

/** 这一行数据当前用户能不能看 */
function canSee(user, row) {
  const s = of(user);
  if (s.cross) return true;
  // 没绑主体 = 范围未确定 → 不放行（入口已 403，这里是兜底）
  if (!s.companyId) return false;
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
  /**
   * 单公司模式下 canSee() 恒为 true（见 of() 的 cross），所以这里只剩"存在性"判断 ——
   * 调用方那几十处"跨主体返回 404"的分支不会触发，但代码原样保留。
   */
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
  /**
   * 单公司模式：不管调用方传什么（包括客户端能改的 `b.company_id`），一律落抬头。
   * 这条比读过滤更要紧 —— 读过滤错了只是"多看到"，写错了是"账记到不存在的公司名下"。
   */
  if (SINGLE) return Number(header().id) || 1;
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
  if (s.unbound) {
    throw new Error('数据范围未确定：账号未绑定公司主体（filterCompanyId 无法取值）');
  }
  if (s.cross) return null;
  return s.companyId || null;
}

/**
 * 本次请求该操作哪个主体 —— **服务端唯一取值口**
 * ============================================================
 * ## 为什么必须有这一个函数
 *
 * 财务那一类接口（资金计划 / 税务测算 / 坏账计提 / 驾驶舱 / 总账）的写法是
 * 「把 `req.query.company_id` 直接交给服务层」，而服务层把 `null` 当成"不过滤"。
 * 于是两个后果同时存在：
 *   - 不传 `company_id` → 服务层算的是**整个集团合并数**（非集团角色也拿得到）；
 *   - 传 `company_id=3` → 直接读别家的账。
 * 这两条都不是"参数校验"，是数据范围问题，所以只能在这里一处判。
 *
 * ## 口径（与 `of()` 同一套规则，不另立标准）
 *
 *   - 集团角色（admin / boss）：可以显式指定任意已存在的主体；不指定就用自己那个；
 *   - 其他角色：**只能用自己那个**。显式指定别家 → 404（不是 403，403 等于承认
 *     "这个主体存在、只是你没权限"，逐个 id 试就能数出集团有几家）；
 *   - 没绑主体：抛错（入口已 403，这里是兜底）。
 *
 * ## 单公司模式（默认）的两个细节
 *
 *   1. **不传主体时返回 `null`（= 不过滤），而不是抬头 id** —— 必须与
 *      `filterCompanyId()` 的口径一致。否则会出现"资金计划的应付总额"
 *      和"应付台账的已开票未付"对不上：前者被收窄到抬头、后者是全库，
 *      两个页面说两个数，而这种不一致没人会去查原因，只会不信这个数。
 *   2. **显式传了合法主体就照用** —— 单公司模式的意思是"不再按主体隔离"，
 *      不是"禁止查某个主体"。历史库里那几家主体的数据仍然存在，
 *      税务测算这类"按主体出表"的页面还要能选到它们，硬改会打断正常业务。
 *      `opts.concrete` 就是给这类"必须要一个具体主体"的调用方用的
 *      （税务、总账、坏账：它们要把 id 写进 SQL 或落进单据）。
 *
 * @param {object} user   `req.user`
 * @param {*} requested   `req.query.company_id ?? req.body.company_id`
 * @param {{allowAll?:boolean,concrete?:boolean,label?:string,action?:string}} [opts]
 * @returns {number|null} 主体 id；null 表示"不过滤"
 */
function resolveCompany(user, requested, opts = {}) {
  const label = opts.label || '公司主体';
  const raw = requested === undefined || requested === null ? '' : String(requested).trim();
  const isAll = raw.toLowerCase() === 'all';
  const headId = Number(header().id) || 1;

  if (SINGLE) {
    if (isAll) return opts.allowAll ? null : headId;
    if (!raw) return opts.concrete ? headId : null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw Object.assign(new Error(`${label}参数不合法：${raw}`), { status: 400 });
    }
    if (!db.prepare('SELECT id FROM companies WHERE id = ?').get(n)) {
      throw Object.assign(new Error(`${label}不存在`), { status: 404 });
    }
    return n;
  }

  const s = of(user);
  if (s.unbound) {
    throw Object.assign(
      new Error(`数据范围未确定：账号未绑定公司主体，无法${opts.action || '操作'}${label}`),
      { status: 403 }
    );
  }
  const own = s.companyId || null;

  if (isAll) {
    if (opts.allowAll && s.cross) return null;
    // 集团角色即使没要求 all，也是"全集团口径"（与 filterCompanyId 一致）
    if (s.cross) return opts.concrete ? (own || headId) : null;
    return own || headId;
  }
  if (!raw) {
    /**
     * 不指定：
     *   集团角色 → `null`（不过滤），与 `filterCompanyId()` 完全一致。
     *     这里如果返回"自己那个主体"，资金计划就会只算总部，而应付台账算全集团 ——
     *     两个页面的应付总额对不上，冒烟里那条跨模块口径断言就是为了抓这个。
     *   普通角色 → 自己那个主体（这就是本次修复的核心：不再默认看全集团）。
     *   `concrete` 的调用方（税务 / 总账 / 坏账）拿不到 null，退到抬头。
     */
    if (s.cross) return opts.concrete ? (own || headId) : null;
    return own || headId;
  }

  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw Object.assign(new Error(`${label}参数不合法：${raw}`), { status: 400 });
  }
  const exists = db.prepare('SELECT id FROM companies WHERE id = ?').get(n);
  if (!exists) throw Object.assign(new Error(`${label}不存在`), { status: 404 });
  if (!s.cross && n !== own) {
    // 跨主体一律 404：不泄露"哪些主体存在"
    throw Object.assign(new Error(`${label}不存在`), { status: 404 });
  }
  return n;
}

/**
 * 「挂在订单上的表」的范围条件（`order_nodes` / `production_reports` /
 * `cut_orders` / `commitments` … 都只有 `order_id`，没有 `company_id`）
 *
 * 用法：`... WHERE 1=1 ${orderOwnedSql(cid, 'r.order_id').sql}`
 *
 * ## 为什么这里内联整数，而不是绑参数
 *
 * 主体 id 来自库里的 `users.company_id`，经 `Number()` 取值 —— 没有注入面。
 * 而这些生产/报工查询动辄七八个条件、参数按顺序绑，加一个条件就得数
 * 「第几个 ?」，错位一次就是「条件静默失效但查询不报错」——最坏的一种。
 * 内联没有参数位次问题。**只用于整数**，其他值一律绑参数。
 *
 * 传空（集团角色）返回空串，查询保持原样。
 */
function orderOwnedSql(companyId, expr = 'order_id') {
  // 空值 = 集团口径，不过滤
  if (companyId === null || companyId === undefined || companyId === '') {
    return { sql: '', params: [], scoped: false };
  }
  const cid = Number(companyId);
  /**
   * 非法值**必须炸**，不能"返回空条件" ——
   * 那等于悄悄退化成"看全部"，而这种泄漏在页面上看不出来。
   * 主体 id 只可能来自 `filterCompanyId()`，出错就是代码问题，早报早改。
   */
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error(`orderOwnedSql 收到非法主体 id：${String(companyId)}`);
  }
  return {
    sql: ` AND EXISTS (SELECT 1 FROM orders o_scope WHERE o_scope.id = ${expr} AND o_scope.company_id = ${cid})`,
    params: [],
    scoped: true
  };
}

/**
 * 直接带 `company_id` 列的表的范围条件（内联整数，同样会校验）
 *
 * 与 `orderOwnedSql` 的区别：那个是"表没有 company_id、靠订单推"，
 * 这个是"表自己就有 company_id"（`orders` / `ar_invoices`…）。
 * 两者都内联整数：报表类查询条件多，绑参数极易错位。
 */
function companyClauseSql(companyId, col = 'company_id') {
  if (companyId === null || companyId === undefined || companyId === '') {
    return { sql: '', scoped: false };
  }
  const cid = Number(companyId);
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error(`companyClauseSql 收到非法主体 id：${String(companyId)}`);
  }
  return { sql: ` AND ${col} = ${cid}`, scoped: true };
}

/**
 * 通过**父表**判归属：子表没有 `company_id`，父表有
 *
 * 例：`goods_receipts.po_id → purchase_orders.company_id`。
 * 与 `orderOwnedSql` 的区别是父表可配置（不只是 orders）—— 
 * 采购收货、采购明细、退货这些表都挂采购单，没必要为每张表各写一个函数。
 */
function parentClauseSql(companyId, parentTable, col) {
  if (companyId === null || companyId === undefined || companyId === '') {
    return { sql: '', scoped: false };
  }
  if (!TABLE_RE.test(String(parentTable))) {
    throw new Error('parentClauseSql 表名非法：' + parentTable);
  }
  const cid = Number(companyId);
  if (!Number.isInteger(cid) || cid <= 0) {
    throw new Error('parentClauseSql 收到非法主体 id：' + String(companyId));
  }
  return {
    sql: ' AND ' + col + ' IN (SELECT id FROM ' + parentTable + ' WHERE company_id = ' + cid + ')',
    scoped: true
  };
}

module.exports = {
  GROUP_ROLES, of, clause, where, canSee,
  assertOrder, assertRow, writeCompanyOf, filterCompanyId,
  orderOwnedSql, companyClauseSql, parentClauseSql,
  // 单公司模式：开关状态 + 唯一抬头 + 下拉取值
  isSingle, header, listForPicker,
  // v1.68：未绑定主体的账号判定（鉴权中间件据此拒绝）+ 服务端统一主体取值口
  scopeProblem, resolveCompany
};
