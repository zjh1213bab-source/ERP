# 接口清单（API）

> 基础：所有 `/api/*` 除登录外均需请求头 `Authorization: Bearer <token>`。
> 返回：`{ ok: true, data: ... }` 或 `{ ok: false, message }`；分页接口直接用数组。

## 认证
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/auth/login | - | `{username,password}` → `{token,user}` |
| GET | /api/auth/me | 登录 | 当前用户 |

## 客户 / 产品
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET/POST | /api/customers | 读:登录 / 写:admin,sales | 列表/新增 |
| GET/PUT/DELETE | /api/customers/:id | 同上 | 详情/修改/停用 |
| GET/POST | /api/products | 读:登录 / 写:admin,sales,tech | 列表/新增 |
| GET/PUT/DELETE | /api/products/:id | 同上 | 详情/修改/停用 |

## 订单
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/orders | 登录 | 列表（q/status/type） |
| GET | /api/orders/meta | 登录 | 状态机 + 汇率 |
| GET | /api/orders/stats/summary | 登录 | 工作台统计 |
| GET | /api/orders/export | 登录 | 导出 CSV |
| GET | /api/orders/:id | 登录 | 详情（items[].colors[]、crafts、logs） |
| POST | /api/orders | admin,sales | 新建（items[].colors[].sizes[]） |
| PUT | /api/orders/:id/items | admin,sales | 仅草稿可用；补录/修改款式颜色尺码，原子重算金额并留变更记录 |
| POST | /api/orders/:id/image | admin,sales,tech | 设置款图 |
| POST | /api/orders/:id/transition | 按状态 | `{to,note,force}` 状态流转；与批量流转共用门槛；入库/发货必须走库存接口 |
| POST | /api/orders/batch/transition | 按状态（排除 boss/hr） | `{ids,to,note,force,dry_run,all_or_nothing}` 批量流转。`dry_run=1` 只预检不写库；`all_or_nothing=1` 整批一致；默认逐单尽力。返回 `{batch_no,ok_count,fail_count,ok[],fail[{order_no,status,reason}]}`，**每单结果都在**；一次最多 200 单 |
| POST | /api/orders/:id/rollback | 按状态 | `{to,reason}` **反审退回**：只退前置环节、原因必填、自动冲销库存 + 重置工序 |

## 开发单
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/techpacks/all | 登录 | 全量（含订单/客户） |
| GET | /api/techpacks?order_id= | 登录 | 按订单 |
| GET | /api/techpacks/:id/full | 登录 | 完整明细（头部 + 面辅料 + 成衣尺寸 + 生产要求 + 订单） |
| GET | /api/techpacks/by-order/:orderId/current | 登录 | 该订单当前生效的开发单（已确认优先、款名匹配优先），打印总单用 |
| PUT | /api/techpacks/:id/detail | admin,tech,sales | 整份保存明细（头部 + 三块明细，事务内全量替换；确认后锁定） |
| POST | /api/techpacks/:id/sizes/from-order | admin,tech,sales | 按订单尺码生成成衣尺寸骨架 `{overwrite,parts}` |
| POST | /api/techpacks/:id/new-version | admin,tech,sales | 新建版本（复制头部与全部明细，旧版本保留） |
| POST | /api/techpacks | admin,tech,sales | 新建 |
| PUT | /api/techpacks/:id | 同上 | 修改（确认后锁定） |
| POST | /api/techpacks/:id/confirm | admin,tech | 确认（定制单必填校验） |
| POST | /api/techpacks/:id/reject | admin,tech | 驳回 |
| POST | /api/techpacks/:id/stage | admin,tech,sales | 打版流程 `{stage}` |
| DELETE | /api/techpacks/:id | admin,tech | 删除（草稿） |

## 工艺 / 面辅料用量 / 工序 / 报工
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | /api/crafts?order_id= | 工艺明细 |
| PUT/DELETE | /api/crafts/:id | 改/删 |
| GET/POST | /api/order-materials?order_id= | 面辅料用量（自动算总用量/金额） |
| PUT/DELETE | /api/order-materials/:id | 改/删 |
| GET | /api/order-nodes?order_id= | 工序列表 |
| POST | /api/order-nodes/init | 初始化 13 道 |
| PATCH/DELETE | /api/order-nodes/:id | 改状态/日期/责任人 |
| GET | /api/reports?node_id=&order_id= | 报工列表 |
| GET | /api/reports/summary?order_id= | 报工汇总 |
| POST | /api/reports | 报工必须关联本订单工序且订单为生产中；累计量不能超过订单量 |
| DELETE | /api/reports/:id | 仅订单仍在生产状态时可删 |

## 成本财务
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/costs/:orderId | 取成本单 |
| POST | /api/costs/:orderId | 新建/更新（自动算出厂价） |
| POST | /api/costs/:orderId/review | `{approve,opinion}` 审核 |

## 生产看板
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/production/board | 已分单/生产中/已入库订单 + 工序进度 |

## 工厂 / 分单
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET/POST | /api/factories | 读:登录 / 写:admin,production,sales | 工厂/外协列表、新增 |
| PUT/DELETE | /api/factories/:id | 同上 | 修改/停用 |
| GET | /api/dispatch?order_id= | 登录 | 订单分单列表（也支持 `factory_id`/`status`） |
| GET | /api/dispatch/recon | 登录 | 外协对账汇总（按外协厂：分单数/件数/金额/未结） |
| POST | /api/dispatch/:id/settle | admin,finance | 结算/取消结算 `{settled:true|false}` |
| POST | /api/dispatch | admin,sales,production | 分单（`{order_id,factory_id,qty,price,remark}`；须财务通过并指定工厂；可多次拆分，累计不超订单量，分配覆盖整单后→assigned） |
| DELETE | /api/dispatch/:id | 同上 | 仅订单仍在财务审核/已分单时可删除 |

## 附件 / 审批 / 人事
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/upload/file | 登录 | 通用文件上传（PDF/图片/Office，≤10MB）→ `/uploads/xxx` |
| GET | /api/attachments?target_type=&target_id= | 登录 | 附件列表（target_type: order/techpack） |
| POST | /api/attachments | 登录 | 新增附件记录 |
| DELETE | /api/attachments/:id | 登录 | 删除附件 |
| GET | /api/approvals/pending | 登录 | 审批待办（待技术确认/待财务审核/待分单） |
| GET | /api/approvals/my-tasks | 登录 | **待我审批（多级流程任务，按角色）** |
| POST | /api/approvals/tasks/:id/act | 登录 | 处理审批 `{approve,remark}`（按节点角色校验） |
| GET/POST | /api/employees | 读:登录 / 写:admin,sales | 员工列表/新增 |
| GET | /api/employees/departments | 登录 | 部门选项 |
| PUT/DELETE | /api/employees/:id | admin,sales | 修改/离职 |
| GET/POST | /api/leaves | 读:登录 / 写:admin,sales | 请假列表/新增 |
| POST | /api/leaves/:id/review | admin,sales | 审批 `{approve}` |
| DELETE | /api/leaves/:id | admin,sales | 删除 |
| GET | /api/cashflow/plan?weeks=13&base_date=&scenario=base\|conservative\|optimistic&collect_rate= | cashflow.read | **资金计划**：`summary`（期初现金 / 流入 / 流出 / 期末 / `min_cash` 最低点 / `first_neg_week` 首次转负 / `gap` 缺口 / `ar_at_risk` 大概率收不回的部分）+ `weeks_detail`（逐周，含 `inflow_items`/`outflow_items` 每笔依据）+ `buckets`（按逾期档的回收率）。**支出侧三档完全相同** |
| GET | /api/cashflow/compare?weeks=13 | cashflow.read | 三档情景并排；`outflow_consistent` 表示三档支出是否一致（必须为 true） |
| GET | /api/collections/meta | collection.read | 枚举（状态/等级/渠道/结果/结案原因）+ 可指派的账号 + `stats` |
| GET | /api/collections/stats | collection.read | 汇总：各状态 count/amount、`active_amount` 在催金额、`no_owner_count` 无人负责、**`broken_count`/`broken_amount` 承诺跳票** |
| GET | /api/collections/board | collection.read | **逾期台账**：按客户汇总逾期，含 `is_internal`（集团内部不催）/ `has_task` / `owner`（三级解析结果与 `source`）/ `can_generate`；`summary` 把外部与内部金额分开 |
| POST | /api/collections/generate | collection.close | `{all?\|customer_ids?, min_overdue_days?}`。**幂等**：已有未结任务的客户跳过；**集团内部往来跳过** |
| GET | /api/collections?status=&level=&owner=&no_owner=1&q= | collection.read | 任务列表；排序为「跳票 → 承诺 → 已联系 → 待跟进」；销售强制只看自己名下 |
| GET | /api/collections/:id | collection.read | 详情：`live`（实时剩余/已结清数/跳票标记）+ `items`（发票，含 `open_at_create` 快照与 `open_now`）+ `logs` |
| POST | /api/collections/:id/log | collection.write | 记一次跟进 `{channel, result, promise_date?, promise_amount?, contact?, note?}`。**result=promised 时日期与金额都必填**；日期不得早于今天；金额不得超未收；refused/dispute 必须写说明 |
| POST | /api/collections/:id/assign | collection.close | `{username}` 指派负责人（`owner_source` 变 `manual`） |
| POST | /api/collections/:id/close | collection.close | `{reason: paid\|bad_debt\|legal\|offset\|other, note}`。`paid` 要求未收为 0；`bad_debt` 说明 ≥8 字；其他原因未收 >0 时说明 ≥4 字 |
| POST | /api/collections/:id/reopen | collection.close | `{reason}` 重新打开已结案任务 |
| GET | /api/collections/export?status=&q= | collection.read | CSV（带 BOM，含回收率/承诺/跳票次数） |
| GET | /api/payment-requests/meta | paymentreq.read | 枚举（状态/供应商/出账账户/付款方式）+ `stats`。**出账账户只列 `status='active'`** |
| GET | /api/payment-requests/candidates?supplier_id=&q= | paymentreq.read | 可申请的应付发票：`open_amount` 未付 / `committed` 已被其他未完成申请占用 / **`available` = 可申请额** / `committed_by` 占用它的单号 / `fully_committed` |
| GET | /api/payment-requests?status=&supplier_id=&q=&mine=1 | paymentreq.read | 列表；`summary` 与 `/stats` 同源（`draft/submitted/approved/paid` 各自 count+amount、`pipeline_amount`、`committed_amount`、`overdue_pending_count`） |
| GET | /api/payment-requests/stats | paymentreq.read | 汇总 |
| POST | /api/payment-requests | paymentreq.write | `{items:[{invoice_id, amount}], plan_pay_date, method, bank_account_id?, reason}`。**不收 `amount`**：金额 = 明细合计；`amount` 省略时取「可申请额」；超出可用额 / 跨供应商 / 已作废 / 已付清都 400 |
| GET | /api/payment-requests/:id | paymentreq.read | 详情：明细 + `approval`（含 tasks）+ `payment` + `bank_account` |
| PUT | /api/payment-requests/:id | paymentreq.write | 改草稿（只允许 `draft`；明细整体替换并重算金额） |
| DELETE | /api/payment-requests/:id | paymentreq.write | 删草稿（提交过的请走「取消」，否则审批记录会断） |
| POST | /api/payment-requests/:id/submit | paymentreq.write | 提交：再校验一次占用（防「建草稿后别人先申请了」）→ 生成 `payment` 审批实例 |
| POST | /api/payment-requests/:id/cancel | paymentreq.read | `{reason}`（≥4 字）；已付款的不能取消；会同时终止审批实例 |
| POST | /api/payment-requests/:id/pay | **paymentreq.pay** | `{bank_account_id, pay_date, method}`。**必须 `approved`**；账户必填；`amount` 若传必须与批准金额一致（不一致 = 绕过审批）→ 生成 `payments` + 核销 + 回写发票 |
| GET | /api/payment-requests/export?status=&q= | paymentreq.read | CSV（带 BOM） |
| POST | /api/approvals/tasks/:id/act | 按角色 | 新增 `payment` 类型。**申请人自己批会 403**；错误码透传 `e.status`（不再一律 400） |
| GET | /api/payable/board?q=&only_overdue= | payable.read | **供应商应付台账**：`figures`（`open_amount` 未付发票 / `unbilled_amount` 已收货未开票 / `payable_total` / `overdue` / `due_7` / `due_30` / `unbilled_est_due` 未开票预计到期 / `unbilled_overdue_est` / **`in_pipeline` 已在付款申请流程中** / `pipeline_count`）+ `risk`（overdue/unbilled/noterm/ok） |
| GET | /api/payable/schedule?weeks=8 | payable.read | **付款计划**：按周分组（`buckets`，第一组固定 `overdue`），末尾 `pending` 是「已收货未开票」并带 `est_due`（收货日 + 账期，**仅供计划，不算逾期**） |
| GET | /api/payable/export?q=&only_overdue= | payable.read | 台账 CSV（带 BOM，前四行写口径） |
| GET | /api/payable/:supplierId | payable.read | 单供应商：未付发票 + 已收货未开票采购单 + 最近付款 |
| PUT | /api/payable/:supplierId | payable.write | `{payment_terms, term_days}` 维护账期；只改文本会自动解析天数，读不出就留空 |
| GET | /api/credit/board?q=&risk=&only_managed= | credit.read | **信用台账**：每户 `figures`（`billed_open` 已开票未收 / `unbilled` 未开票订单 / `shipped_unbilled` 其中货已发未开票 / `exposure` 敞口 / `available` 可用 / `overdue` 逾期 / `max_overdue_days`）+ `risk`（hold/over/overdue/near/unmanaged/ok） |
| GET | /api/credit/config | credit.read | 判定参数：`grace_days` 逾期宽限、`warn_ratio` 预警线、`default_days` 默认账期 |
| PUT | /api/credit/config | credit.write | 改参数 |
| GET | /api/credit/check/:orderId | credit.read | **发货前预检**：`{level, blocked, reasons[], notes[], tips[], profile, open_override}`。`reasons` 是拦下来的硬理由，`notes` 是风险提示（会把 level 抬到 warn），`tips` 只是操作建议 |
| POST | /api/credit/overrides | credit.write | `{order_id, reason}` 开放行单；理由 **≥8 字**；同一单不许挂两张未用的；**没被拦的单不许开** |
| GET | /api/credit/overrides?order_id=&open=1 | credit.read | 放行单查询 |
| GET | /api/credit/export?risk=&q= | credit.read | 台账 CSV（带 BOM，前四行写口径说明） |
| GET | /api/credit/:customerId | credit.read | 单客户画像 + `invoices` / `orders` 明细 + `events` 变更流 |
| PUT | /api/credit/:customerId | credit.write | `{credit_limit, credit_days, reason}`；原因 ≥4 字；**数值没变直接拒** |
| POST | /api/credit/:customerId/hold | credit.write | `{action: hold\|release, reason}`；冻结期间一律不许发货 |
| POST | /api/stock/ship | 见库存 | 新增 `credit_override_id`。被拦时返回 **400 + `code=CREDIT_BLOCK`** + `data`（预检详情）；带放行单则发货并在日志写 `#放行单号` |
| GET | /api/statements/customers | admin,boss,finance,sales | 有往来的客户 + `open_amount`（未收发票）/ `unallocated`（已到账未核销）/ `real_open`（实际结欠） |
| GET | /api/statements/:customerId?from=&to= | 同上 | **客户对账单（对账函）**：期初 / 本期开票 / 本期收款 / 期末结欠 + 逐笔流水（滚动余额）；`check_diff≠0` 表示流水口径与「未收发票 − 未核销」不符（账坏了，不能发客户） |
| GET | /api/audit?from=&to=&username=&group=&action=&result=&q=&page=&pageSize= | admin,boss | 操作日志列表（分页 + 多维筛选）；每条带业务语义 `module/module_group/action/target/summary` 与 `role_label` |
| GET | /api/audit/facets | admin,boss | 筛选下拉（账号/大类/子域/动作，只给库里真出现过的值） |
| GET | /api/audit/stats?days=14 | admin,boss | 统计：按大类/子域/动作/人汇总 + 按日趋势 + 失败数 |
| GET | /api/audit/verify?from=&to= | admin,boss | **哈希链校验**：`{ok,checked,total,problems[],head,tail,state}`；problem.code = `HASH`(内容被改) / `LINK`(链接断) / `SEQ_GAP`(序号断档) / `HEAD_GAP`+`HEAD_HASH`(头部被删) / `TAIL_SEQ`+`TAIL_HASH`(尾部被删)，都带 `seq` |
| GET | /api/audit/export?（同上筛选） | admin,boss | CSV（带 BOM）：4 行「导出人/范围/条数/序号区间/链校验结论」+ 13 列明细 + 每行哈希；响应头 `X-Audit-Rows`、`X-Audit-Seq-Range`、`X-Audit-Verified`、`X-Audit-File-SHA256`；空范围返回 400 |
| POST | /api/audit/archive | audit.archive（仅 admin） | `{before_days≥30, note}` 归档：落 JSONL + 文件 sha256 → 写 `audit_archives` → 从主表移出 → 推进 `anchor_seq/anchor_hash`；**只切连续前缀** |
| GET | /api/audit/archives | admin,boss | 归档记录（编号/序号区间/条数/文件/文件哈希/截止日期） |

> **日志三条边界**：① 只记「谁在什么时候动了什么」，**永不读 req.body**（body 有密码和金额，记了日志本身就成了泄密源）；
> ② 失败请求也记（401/403 反复出现是在试探权限）；③ **没有删除接口** —— 只追加，要减量只能归档且必须留文件与哈希。
>
> **为什么另存 `audit_chain_state`**：光有哈希链只防「改」不防「删」—— 删掉尾部 100 条，剩下的链依然自洽。
> 水位表单独记 `last_seq/last_hash`，删日志不动它，「库里最大序号 < 水位」就是被删了。
| GET | /api/assistant/insights | 登录 | 风险预警（逾期/临期/缺货/工序超期/工资未发/报价到期/资产年检/费用超支），每条带 `to` 跳转 |
| GET | /api/assistant/report?period=YYYY-MM | 登录 | 经营解读：订单/交付/生产/库存/报价/费用/人工指标 + 自动结论（conclusions/risks/tips）+ 环比与同比 |
| POST | /api/assistant/query | 登录 | 自然语言查数 `{q}`，返回 `{intent,title,summary,columns,rows,links}`；支持订单号、客户名、款号/SKU 及「逾期/缺货/库存/工资/费用/报价/审批/生产/资产」等主题 |
| POST | /api/ai/chat | 登录 | AI 问答 `{message}`；**先跑规则查库得到事实底稿**，配了 `AI_API_KEY` 时把底稿交给大模型改写，未配则直接返回底稿 |
| GET/POST | /api/approval-flows | 读:登录 / 写:admin | 审批流列表/新增 |
| PUT/DELETE | /api/approval-flows/:id | admin | 修改/停用 |
| GET | /api/attendance?month=&employee_id= | 登录 | 考勤列表 |
| POST | /api/attendance/clock | admin,sales | 打卡 `{employee_id,type:in|out}` |

## 薪酬核算
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/payrolls?period=&status= | 登录 | 工资单列表（含日薪/缺勤扣款/个税/实发等实时计算字段） |
| GET | /api/payrolls/periods | 登录 | 已有工资单的月份及合计 |
| GET | /api/payrolls/summary?period= | 登录 | 汇总（人数/应发/实发/个税/社保/加班费/按部门） |
| GET | /api/payrolls/export?period= | 登录 | 导出 CSV |
| POST | /api/payrolls/generate | admin,sales | `{period:'YYYY-MM', overwrite}` 按在职员工生成；已确认/已发放不覆盖 |
| PUT | /api/payrolls/:id | admin,sales | 调整请假/缺勤/加班/奖金/补贴/扣款/社保（仅草稿），保存即重算 |
| POST | /api/payrolls/:id/confirm · /pay | admin,sales | 草稿→已确认→已发放 |
| POST | /api/payrolls/batch | admin,sales | `{action:'confirm'|'pay', ids:[]}` 批量流转 |
| DELETE | /api/payrolls/:id | admin,sales | 删除（仅草稿） |

计算口径：应出勤=当月周一至周五；日薪=基本工资/应出勤；加班费=日薪/8×小时×1.5；缺勤扣款=日薪×缺勤天数；
应发=基本+加班费+奖金+补贴−其他扣款−缺勤扣款；个税=(应发−社保−5000) 套月度税率表（3%~45%，含速算扣除）；实发=应发−社保−个税。

## 固定资产 / 行政费用
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/assets?category=&status=&q= | 登录 | 资产列表（含月折旧/累计折旧/净值） |
| GET | /api/assets/summary | 登录 | 数量/原值/净值/月折旧/按类别/30 天内到期 |
| POST/PUT | /api/assets · /:id | admin,sales,finance | 新增/修改 |
| POST | /api/assets/:id/status | admin,sales,finance | `{status: in_use|idle|scrapped}` |
| DELETE | /api/assets/:id | admin,sales,finance | 删除 |
| GET | /api/admin-expenses?from=&to=&category=&q= | 登录 | 费用列表（最多 1000 条） |
| GET | /api/admin-expenses/meta | 登录 | 费用类别字典 |
| GET | /api/admin-expenses/summary?from=&to= | 登录 | 合计 / 按类别 / 按月 / 按付款方式 |
| GET | /api/admin-expenses/export?from=&to= | 登录 | 导出 CSV |
| POST/PUT/DELETE | /api/admin-expenses · /:id | admin,sales,finance | 增改删 |

折旧：直线法，月折旧 = 原值 × (1 − 残值率) / (年限 × 12)；累计折旧封顶为可折旧总额；净值 = 原值 − 累计折旧。

## 工作台
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/dashboard | 看板：本月订单/金额、在产、待审批、逾期、缺货、状态分布、近7日趋势、最近订单 |

## 采购
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/purchases?status=&q= | 登录 | 采购单列表 |
| GET | /api/purchases/:id | 登录 | 详情（含明细与到货数） |
| POST | /api/purchases | admin,sales,warehouse | 新建（草稿） |
| POST | /api/purchases/:id/order | 同上 | 下单（草稿→已下单） |
| POST | /api/purchases/:id/receive | 同上 | 到货 `{items:[{id,qty}]}`（面辅料库存 +，全到→已收货） |
| DELETE | /api/purchases/:id | 同上 | 删除草稿 |

## 库存 / 发货| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/stock?warehouse=&q= | 库存列表 |
| GET | /api/stock/summary | 各仓汇总 |
| GET | /api/stock/ledger | 库存流水 |
| POST | /api/stock/adjust | 手工调整 |
| POST | /api/stock/transfer | 调拨 |
| POST | /api/stock/auto-transfer | 缺货一键补货（cn→us） |
| POST | /api/stock/instock | 按生产报工与尾期验货放行后的整单明细入库（→instock） |
| POST | /api/stock/ship | 按订单发货（→shipped，校验库存和信用）；通用状态接口不能替代 |
| GET | /api/stock/ship-board?warehouse=us | 美仓发货核对 |

## 报表
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/stats/orders | 订单统计（?export=1 导出） |
| GET | /api/stats/production | 生产统计（?export=1） |
| GET | /api/stats/stock | 库存统计（?export=1） |
| GET | /api/stats/shortage | 缺货统计（?export=1） |
| GET | /api/stats/profit?period= | 毛利分析：收入/成本/毛利/毛利率、按客户毛利、缺成本单清单、数据质量提醒（?export=1） |
| GET | /api/stats/customers?period= | 客户贡献：单数/件数/金额/占比/单均/毛利/逾期单/最近下单（?export=1） |
| GET | /api/stats/factories | 工厂产能：分单次数/件数/金额/已结算/未结算/平均单价/在产订单/近30天件数（?export=1） |
| GET | /api/stats/receivables | 账期分析：敞口金额、账龄分桶(0-30/31-60/61-90/90+)、按客户敞口、平均回款周期（?export=1） |

## 系统 / 主数据
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET/PUT | /api/settings | 读:登录 / 写:admin | 汇率 |
| GET | /api/materials?type=&status=&q= | 登录 | 面辅料档案（q 搜 名称/编号/简称/供应商/色号） |
| GET | /api/materials/:id | 登录 | 单条档案 |
| POST | /api/materials | admin,tech,sales | 新增档案 |
| PUT | /api/materials/:id | 同上 | 修改档案（档案维护页用） |
| POST | /api/materials/:id/duplicate | 同上 | 复制成新档案 |
| DELETE | /api/materials/:id | 同上 | 停用（保留历史引用，不物理删除） |
| GET | /api/suppliers?q=&category=&status= | 登录 | 供应商档案（q 搜 名称/编号/简称/联系人/电话） |
| GET | /api/suppliers/:id | 登录 | 单条供应商 |
| POST/PUT | /api/suppliers(/:id) | admin,tech,sales,warehouse | 新增 / 修改 |
| DELETE | /api/suppliers/:id | 同上 | 停用 |
| GET | /api/craft-types?q=&category=&status= | 登录 | 工序类别档案 |
| GET | /api/craft-types/:id | 登录 | 单条工序 |
| POST/PUT | /api/craft-types(/:id) | admin,tech,production,sales | 新增 / 修改 |
| DELETE | /api/craft-types/:id | 同上 | 停用 |
| GET | /api/pattern-flows/board | 登录 | 打版流程看板（阶段定义 + 全部流程） |
| GET | /api/pattern-flows/by-techpack/:tpId | 登录 | 按开发单取流程 |
| POST | /api/pattern-flows/ensure | 登录 | 确保流程存在（幂等，开发单创建时自动调用） |
| PUT | /api/pattern-flows/:flowId/stage/:stage | 按阶段授权 | 保存阶段内容（不可跳阶段、完成后锁定） |
| POST | /api/pattern-flows/:flowId/stage/:stage/done | 按阶段授权 | 完成该阶段并推进 |
| POST | /api/pattern-flows/:flowId/stage/:stage/reopen | 按阶段授权 | 退回重做（重置该阶段及之后） |
| GET | /api/pattern-flows/:flowId/materials | 登录 | 面辅料确认阶段的物料清单（读开发单 tech_pack_materials） |
| PUT | /api/pattern-flows/:flowId/materials | admin,tech | 保存物料清单（仅面辅料确认阶段、流程未完成时可写） |
| POST | /api/pattern-flows/:flowId/finish | admin,finance,production | 完成打版并归档样衣 |
| GET | /api/sample-archives?q=&status= | 登录 | 样衣档案列表 |
| GET | /api/sample-archives/:id | 登录 | 样衣详情（含快照与变更记录） |
| POST | /api/sample-archives/:id/change-request | 登录 | 提交更改需求（同一时间只允许一条待审） |
| GET | /api/sample-archives/changes | 登录 | 变更申请列表 |
| POST | /api/sample-archives/changes/:id/review | admin,tech | 审核（通过则解锁开发单回打版流程，提交人不能自审） |
| GET/POST | /api/size-templates | 读:登录 / 写:admin,tech,sales | 尺码模板 |
| DELETE | /api/size-templates/:id | 同上 | 删除 |
| GET/POST | /api/users | admin | 用户列表/新增 |
| PUT | /api/users/:id | admin | 改姓名/角色/状态/密码 |
| POST | /api/upload | 登录 | 图片 base64 上传 → `/uploads/xxx` |
| GET | /api/admin/backup | admin | 下载数据库快照 |
| POST | /api/admin/restore | admin | 上传 .db 备份（校验后暂存，**重启后端生效**） |
| GET/PUT | /api/mindmap | 读:登录 / 写:登录 | 业务蓝图 |

## 外部接口与事件补偿
| 方法 | 路径 | 身份 | 说明 |
|---|---|---|---|
| POST | /api/integration/ingest/:code | 外部系统 | 事件入口。Header `X-Api-Key`；Body `{event_id, topic, payload}`；`event_id` 为**幂等键**（也可放 `X-Idempotency-Key`）。重复推送返回 `{duplicate:true}` 不重复处理；超限返回 429 |
| GET | /api/integration/files/:name?expires=&sig= | 签名链接 | 私有文件下载，签名由 `signed-url` 签发，过期或篡改返回 403 |
| GET | /api/integration/stats | 登录 | 概览：接入点、事件状态分布、24h 调用与失败、校正待批；含 `warnings[]` |
| GET/POST | /api/integration/endpoints | 读:登录 / 写:admin,sales | 接入点列表（Key 掩码）/ 新建（**返回一次明文 Key**） |
| PUT | /api/integration/endpoints/:id | admin,sales | 修改名称、类型、限流、状态、关联店铺 |
| POST | /api/integration/endpoints/:id/rotate-key | admin,sales | 重置 API Key（旧 Key 立即失效） |
| GET | /api/integration/events?status=&topic=&direction= | 登录 | 事件队列（含 attempts / next_retry_at / last_error / result_ref） |
| POST | /api/integration/events/:id/retry | admin,sales | 立即重放单条事件，返回 `{ok, note/error, attempts, dead}` |
| POST | /api/integration/events/:id/drop | admin,sales | 标记放弃 `{reason}`（转为死信不再重试） |
| POST | /api/integration/dispatch | admin,sales | 处理到期的 pending/failed 事件 `{limit}`，返回成功/失败/死信统计 |
| GET | /api/integration/calls?endpoint_id=&only_error= | 登录 | 接口调用日志（含 401/429） |
| GET | /api/integration/shipments?pending=&order_id= | 登录 | 物流事件（含待校正内容 `pending_correction`） |
| POST | /api/integration/shipments/:id/correct | admin,sales | 提交人工校正 `{status_text?, location?, event_time?, reason}`；**reason 必填**，仅登记待批准 |
| POST | /api/integration/shipments/:id/correct/approve | admin,sales | 批准校正：应用新值、保留旧值到 `correct_from`、通知客户 |
| POST | /api/integration/shipments/:id/correct/reject | admin,sales | 驳回校正 `{reason}` |
| GET | /api/integration/openapi.json | 登录 | 自动生成 OpenAPI 3.0.3 接口清单 |
| POST | /api/integration/files/signed-url | 登录 | 签发私有文件下载链接 `{name, ttl}`（默认 600s，最长 86400s） |

### 支持的事件主题
| topic | payload 关键字段 | 处理结果 |
|---|---|---|
| `retail.order` | shop_id/shop_code, channel_order_no, items[{style_no,qty,price,cost,color,size}] | 生成零售单（渠道单号重复则跳过），`result_ref` 为零售单号 |
| `shipment.event` | order_no/order_id, status_text, location, carrier, tracking_no, event_time | 写入物流事件（source=api） |
| `notification` | customer_id/order_no, title, body, type | 推送客户商城站内信 |

> 幂等：同一 `event_id` 只处理一次；失败按 `2^attempts` 分钟退避重试，达到 `max_attempts`（默认 5）转死信。
> 接入点限流为**内存滑动窗口**，重启清零；生产环境建议换 Redis 并把 API Key 改为哈希存储。

## 行政后勤（宿舍 / 饭卡 / 证照印章 / 巡检）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/facility/stats | 登录 | 概览：入住率/空床/维修床、饭卡余额、证照到期、用印待办、报修与复验；含 `warnings[]` |
| GET/POST | /api/facility/dorm/rooms | 读:登录 / 写:admin,sales,warehouse | 房间与床位列表（含每床当前住客）/ 新建（按容量自动建床） |
| PUT | /api/facility/dorm/rooms/:id | admin,sales,warehouse | 修改（床位数不能小于已建床位） |
| POST | /api/facility/dorm/beds/:id/status | admin,sales,warehouse | `{status: normal|maintenance}` 标记维修床（有人住时拒绝） |
| GET | /api/facility/dorm/stays?employee_id=&status= | 登录 | 住宿记录 |
| POST | /api/facility/dorm/checkin | admin,sales,warehouse | 入住 `{bed_id,employee_id,start_date,end_date?,rent_month,deposit}`；**区间重叠校验** |
| POST | /api/facility/dorm/checkout/:stayId | admin,sales,warehouse | 退宿 `{end_date,utilities}` 返回应退押金 |
| POST | /api/facility/dorm/transfer | admin,sales,warehouse | 换宿 `{stay_id,bed_id,date}`；**原子操作，失败回滚** |
| GET | /api/facility/dorm/occupancy?month=YYYY-MM | 登录 | 入住率：住用床日 / 可用床日（不含维修床） |
| GET/POST | /api/facility/meal/accounts | 读:登录 / 写:admin,sales,warehouse | 饭卡账户列表 / 开户 |
| GET | /api/facility/meal/transactions?account_id=&type=&date= | 登录 | 餐费流水 |
| POST | /api/facility/meal/transactions | admin,sales,warehouse | 记流水 `{account_id,type,amount,source,receipt_no,note}`；消费先扣补贴；换卡/退款/冲正必须 `receipt_no`；调整必须 `note` |
| POST | /api/facility/meal/accounts/:id/lost | admin,sales,warehouse | 挂失（冻结消费） |
| POST | /api/facility/meal/accounts/:id/reissue | admin,sales,warehouse | 换卡 `{card_no,receipt_no}`；账户与余额不变 |
| GET | /api/facility/meal/recon?date= | 登录 | 日结对账：分类型汇总 + 缺回执/手工调整清单 |
| GET/POST | /api/facility/certificates | 读:登录 / 写:admin,sales,warehouse | 证照列表（含 `days_left`/`expiring`）/ 新建 |
| PUT | /api/facility/certificates/:id | admin,sales,warehouse | 修改 |
| POST | /api/facility/certificates/:id/void | admin,sales,warehouse | 停用 `{reason}`（保留记录可追溯） |
| GET/POST | /api/facility/seals | 读:登录 / 写:admin,sales,warehouse | 印章列表 / 新建（按公司独立） |
| GET | /api/facility/seal-usages?status=&seal_id= | 登录 | 用印记录 |
| POST | /api/facility/seal-usages | admin,sales,warehouse | 用印申请 `{seal_id,purpose,doc_name,doc_version}` |
| POST | /api/facility/seal-usages/:id/status | admin,sales,warehouse | 流转 `{status: approved|used|returned|rejected}`；批准时版本变化拒绝；`used` 必须带 `receipt_no` |
| GET | /api/facility/safety-checks?area= | 登录 | 巡检记录（含检查项与已转报修数） |
| POST | /api/facility/safety-checks | admin,sales,warehouse | 登记巡检 `{area,facility,items:[{item,result,severity,note,down_impact}],create_repairs}`；异常自动转报修 |
| GET | /api/facility/repairs?status=&area= | 登录 | 报修列表（含 `overdue`） |
| POST | /api/facility/repairs | admin,sales,warehouse | 新建报修 `{area,facility,description,severity,down_impact}` |
| POST | /api/facility/repairs/:id/status | admin,sales,warehouse | 流转 `{status: repairing|submitted|verified|closed|rejected}`；**提交后必须他人复验** |

> 口径：入住率 = 实际住用床日 / 可用床日（可用 = 总床位 − 维修床），不拿当前人数除年末床数。
> 饭卡消费顺序：先扣公司补贴余额，再扣个人充值余额；个人充值不计入公司福利费。
> 用印与维修都必须有「回执 / 复验」才算闭环，不凭一次点击当完成。

## 人事办理（招聘 / 转调离 / 合同 / 调薪）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/hr/stats | 登录 | 概览：在招需求与缺口、候选人管道、合同到期分级、未交付、待生效异动、调薪待生效；含 `warnings[]` |
| GET/POST | /api/hr/recruitments | 读:登录 / 写:admin,sales | 招聘需求列表 / 新建（需求人数、渠道、薪资范围） |
| PUT/DELETE | /api/hr/recruitments/:id | admin,sales | 修改（需求人数不得小于已到岗）/ 删除（有候选人时不允许删） |
| GET | /api/hr/candidates?recruitment_id=&stage= | 登录 | 候选人列表 |
| POST | /api/hr/candidates | admin,sales | 新增候选人 |
| PUT | /api/hr/candidates/:id | admin,sales | 推进阶段 `{stage}`；转 `offer` 必须带 `offer_salary` |
| POST | /api/hr/candidates/:id/hire | admin,sales | 办理入职 `{hire_date, base_salary, department_id, position}` → 生成员工 + 到岗数 +1 + 入职异动；招满自动关闭需求 |
| DELETE | /api/hr/candidates/:id | admin,sales | 删除（已入职不允许） |
| GET | /api/hr/movements?type=&status=&employee_id= | 登录 | 异动列表（含交接完成度、`due` 表示已到期待处理） |
| POST | /api/hr/movements | admin,sales | 新建 `{employee_id,type,effective_date,to_department_id,to_position,handover:[{task,owner,done}]}`；离职必须带交接；调岗需填目标部门或岗位 |
| POST | /api/hr/movements/:id/apply | admin,sales | 生效 `{force:true}`；生效日未到默认拒绝，`force` 可提前执行 |
| POST | /api/hr/movements/:id/cancel | admin,sales | 撤销（已生效不可撤销） |
| DELETE | /api/hr/movements/:id | admin,sales | 删除（已生效不可删） |
| GET | /api/hr/contracts?employee_id=&status=&expiring=30 | 登录 | 合同列表（含 `days_left` / `expiring` / `need_renew`） |
| POST | /api/hr/contracts | admin,sales | 新建；校验：固定期限必须有结束日、试用期在合同期内、同员工合同时间不重叠 |
| PUT | /api/hr/contracts/:id | admin,sales | 修改（同样走上述校验） |
| POST | /api/hr/contracts/:id/deliver | admin,sales | 登记交付证据 `{evidence}`（必填） |
| POST | /api/hr/contracts/:id/renew | admin,sales | 续签 `{start_date?, end_date, type?}` → 新合同 + 旧合同标记已续签；重复续签被拒 |
| POST | /api/hr/contracts/:id/terminate | admin,sales | 解除 `{reason}` |
| DELETE | /api/hr/contracts/:id | admin,sales | 删除（已有续签记录的不允许） |
| GET/POST | /api/hr/adjustments | 读:登录 / 写:admin,sales | 调薪列表 / 新建（自动带当前工资为调整前；与当前一致直接拒绝） |
| PUT | /api/hr/adjustments/:id | admin,sales | 修改（已生效不可改） |
| POST | /api/hr/adjustments/:id/approve | admin,sales | 批准（仅草稿） |
| POST | /api/hr/adjustments/:id/apply | admin,sales | 生效 `{force}`：回写 `employees.base_salary`，以前后值留痕 |
| POST | /api/hr/adjustments/:id/cancel | admin,sales | 取消（已生效不可取消） |

> 口径：异动「生效」才改档案；离职必须有交接清单且生效时自动解除未到期合同。
> 合同：同一员工不允许两份时间重叠的有效合同；续签的新合同起始日默认为旧合同结束日次日。

## 客户订单与资料确认
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/confirm/stats | 登录 | 概览：待客户确认样衣、变更待签收/待确认、交期待确认、物流待核实、逾期未发；含 `warnings[]` |
| GET | /api/confirm/seals?order_id=&status= | 登录 | 封样记录列表（含 `is_latest` / `blocked` / 校验值） |
| GET | /api/confirm/seals/gate/:orderId | 登录 | 封样门槛查询：`{ok, message, latest}`，前端用于解释「为什么还不能推进」 |
| GET | /api/confirm/seals/:id | 登录 | 详情 |
| POST | /api/confirm/seals | admin,sales,tech,production | 新建版本 `{order_id, sample_name, attachments[{name,url}], version?, remark?}`；同订单旧版本自动置 `superseded`，校验值由服务端计算 |
| POST | /api/confirm/seals/:id/tech-approve | 同上 | 总部技术批准（独立于客户确认） |
| POST | /api/confirm/seals/:id/send | 同上 | 发样给客户（需已技术批准；推商城站内信） |
| POST | /api/confirm/seals/:id/reject | 同上 | 内部登记客户提出修改 `{comment}` |
| DELETE | /api/confirm/seals/:id | 同上 | 删除（客户已确认的记录不允许删，请建新版本） |
| GET | /api/confirm/changes?order_id=&status=&type= | 登录 | 变更单列表（含 `executable`） |
| POST | /api/confirm/changes | admin,sales,tech,production | 新建 `{order_id,type,title,before,after,...}`；自动带出已交数量与剩余可变更范围 |
| PUT | /api/confirm/changes/:id | 同上 | 填写影响评估（`assess_note` 必填才能提交客户） |
| POST | /api/confirm/changes/:id/approve | 同上 | 总部批准 → `pending_customer` 并通知客户；交期类自动生成交期变动 |
| POST | /api/confirm/changes/:id/sign | 同上 | 生产工位签收 → `effective`（客户未确认不允许签收） |
| POST | /api/confirm/changes/:id/reject | 同上 | 驳回 |
| GET | /api/confirm/deliveries?order_id=&status= | 登录 | 交期变动列表（含 `delay_days`） |
| POST | /api/confirm/deliveries | 同上 | 登记 `{order_id,new_date,kind,reason}`；原承诺从订单带出且不被覆盖 |
| POST | /api/confirm/deliveries/:id/confirm | 同上 | 内部代录客户确认（线下已获同意）`{accepted,comment}` |
| GET | /api/confirm/shipments?order_id= | 登录 | 物流事件列表（含来源与核实标签） |
| POST | /api/confirm/shipments | 同上 | 登记 `{order_id,carrier,tracking_no,status_text,location,source,verified}` |
| POST | /api/confirm/shipments/:id/verify | 同上 | 标记已核实 |
| DELETE | /api/confirm/shipments/:id | 同上 | 删除物流事件 |

### 客户侧（商城账号）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/mall/confirmations | 待我确认：`{seals[], changes[], deliveries[], total}` |
| POST | /api/mall/seals/:id/confirm | `{accepted, comment}` 确认样衣或提出修改（记录账号/姓名/时间/校验值） |
| POST | /api/mall/changes/:id/confirm | `{accepted, comment}` 确认订单变更 |
| POST | /api/mall/deliveries/:id/confirm | `{accepted, comment}` 确认交期变动 |
| GET | /api/mall/orders/:id/delivery | 交期与物流：`{promised_date(原承诺), latest_expected, changes[], events[]}` |

> 口径：样衣「封样完成」= 最新版本客户已确认 **且** 总部技术已批准；新版本创建即令旧版本失效。
> 变更「执行」= 客户已确认 **且** 生产工位已签收；变更范围 = 订单总件数 − 已交数量。
> 交期：`orders.delivery_date` 永远是原承诺，最新预计只存在于 `delivery_changes`，两者不互相覆盖。

## 零售与渠道
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/channel/stats | 登录 | 概览：在营店铺/未授权店、支付待核与异常、缺货、配额预警、售后待处理、已确认贡献；含 `warnings[]` |
| GET | /api/channel/meta | 登录 | 平台、授权状态、支付/履约状态、售后类型字典与汇率 |
| GET/POST | /api/channel/shops | 读:登录 / 写:admin,sales,finance | 店铺映射列表 / 新增（主体、执照、签约、开票、收款、履约仓、费率、授权状态） |
| PUT/DELETE | /api/channel/shops/:id | admin,sales,finance | 编辑 / 删除（已有订单的店铺不允许删，请改暂停） |
| POST | /api/channel/shops/:id/verify | admin,sales,finance | `{api_status: unauthorized|authorized|limited, api_note}` 人工核查接口授权 |
| GET | /api/channel/retail-orders?shop_id=&pay_status=&fulfill_status=&from=&to=&q= | 登录 | 零售订单列表（最多 300 条） |
| GET | /api/channel/retail-orders/export | 登录 | 导出 CSV |
| GET | /api/channel/retail-orders/:id | 登录 | 详情（明细、售后、成本、毛利） |
| POST | /api/channel/retail-orders | admin,sales,finance | 新建 `{shop_id, channel_order_no, items:[{style_no,qty,price,cost,...}], paid_amount?}`；同店渠道单号唯一 |
| POST | /api/channel/retail-orders/import | admin,sales,finance | 受控批量导入 `{rows:[{shop_code,channel_order_no,sku,qty,price,...}]}`，按 (店铺,单号) 幂等，返回 `{inserted,skipped,errors}` |
| POST | /api/channel/retail-orders/:id/check-pay | admin,sales,finance | `{action:'check'|'mismatch', receipt_amount, pay_ref, reason}`；回执金额与实付不一致时不允许通过 |
| POST | /api/channel/retail-orders/:id/reserve | admin,sales,finance | 预留（占配额，不动实物）；未核支付被拒；超出可分配被拒且不部分预留 |
| POST | /api/channel/retail-orders/:id/ship | admin,sales,finance | 发货：扣实物 + 写流水 + 释放预留；库存不足自动标「缺货待补」 |
| POST | /api/channel/retail-orders/:id/cancel | admin,sales,finance | 取消（释放预留；已发货不可取消，请走售后） |
| GET/POST | /api/channel/after-sales | 读:登录 / 写:admin,sales,finance | 售后列表 / 建单（退款金额不得超过可退余额） |
| PUT | /api/channel/after-sales/:id | admin,sales,finance | 修改原因/金额/退回数量（已退款不可改） |
| POST | /api/channel/after-sales/:id/confirm-refund | admin,sales,finance | 退款到账（只改钱，不动退回状态） |
| POST | /api/channel/after-sales/:id/receive-return | admin,sales,finance | 收到实物 `{qty, restock}`（只改货，不动退款状态） |
| POST | /api/channel/after-sales/:id/reject | admin,sales,finance | 驳回 |
| GET/POST | /api/channel/quotas | 读:登录 / 写:admin,sales,finance | 配额列表（含 `stock/reserved_all/allocatable/over_limit/shortage`）/ 提交调整（限额不得低于已预留） |
| GET | /api/channel/quotas/:id/usage | 登录 | 占用明细（下钻到渠道订单行） |
| POST | /api/channel/quotas/:id/sync | admin,sales,finance | 按未发货零售单重算预留，修正手工误差 |
| GET/POST | /api/channel/settlements | 读:登录 / 写:admin,sales,finance | 结算批列表 / 按店铺+期间生成（只含**已发货 + 支付已核 + 未结算**订单，生成后订单标记已结算） |
| GET | /api/channel/settlements/export | 登录 | 导出 CSV |
| GET | /api/channel/settlements/:id | 登录 | 明细（含订单清单） |
| POST | /api/channel/settlements/:id/confirm | admin,sales,finance | 账单核对 `{source, order_amount, platform_fee, ad_fee, fulfillment_fee, refund_amount, other_fee}`，自动算差异并标记 `diff` |

> 口径：**可分配 = min（渠道限额 − 已预留，货主实物可用量）**，配额只是可卖上限、不是第二份库存。
> **贡献 = 实付 − 退款 − 商品成本 − 平台费 − 广告费 − 履约费 − 其他费**；商品毛利只扣成本。
> 预估（`profit_basis=estimated`）不得当最终利润，必须 `confirm` 带账单来源后才转为账单确认口径。

## 质量与合规
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/qc/stats | 登录 | 本月合格率/待检单/未结异常/冻结批次/召回 |
| GET/POST | /api/qc/standards | 读:登录 / 写:admin,production,tech,sales | 质量标准列表 / 新建（含 `items[]`） |
| GET/PUT/DELETE | /api/qc/standards/:id | 同上 | 详情（含项目）/ 修改（items 覆盖）/ 停用 |
| GET/POST | /api/qc/inspections | 同上 | 检验单列表 / 开单（传 `standard_id` 自动带出检验项） |
| GET/PUT | /api/qc/inspections/:id | 同上 | 详情 / 录入实测值与合格判定 |
| POST | /api/qc/inspections/:id/finish | 同上 | 判定收尾 `{aql_result?,fail_qty?,pass_qty?,create_issue?}`；不合格自动开异常单并冻结批次 |
| DELETE | /api/qc/inspections/:id | 同上 | 删除（仅草稿） |
| GET/POST | /api/qc/issues | 同上 | 异常/返修/客诉列表 / 登记 |
| PUT | /api/qc/issues/:id | 同上 | 填根因、纠正措施、责任人、状态 |
| POST | /api/qc/issues/:id/close | 同上 | 关闭异常单 |
| GET/POST | /api/qc/batches | 同上 | 批次列表 / 新建（批次号自动生成 B+日期+序号） |
| PUT | /api/qc/batches/:id | 同上 | 改数量/工厂/面料批号/童装安全类别/合规资料/状态 |
| GET | /api/qc/batches/:batchNo/trace | 登录 | 全链路追溯：订单、明细、检验、异常、召回、出入库流水 |
| GET/POST | /api/qc/recalls | 同上 | 召回列表 / 发起（批次自动冻结） |
| PUT | /api/qc/recalls/:id | 同上 | 推进状态与已收回数量（结案后批次置已召回） |
| POST | /api/qc/recalls/:id/notify | 同上 | 给客户发商城站内质量通知 |

## 客户商城（客户账号，独立于 ERP 员工账号）

客户 token 通过 `POST /api/mall/auth/login` 获取（JWT 带 `scope=customer`），**不能访问任何 ERP 接口**（`authRequired` 会拒绝）；反之员工 token 也不能访问客户接口。

| 方法 | 路径 | 身份 | 说明 |
|---|---|---|---|
| POST | /api/mall/auth/login | 公开 | `{username,password}` → `{token, account, customer}` |
| GET | /api/mall/auth/me | 客户 | 当前账号与客户信息 + 汇率 |
| GET | /api/mall/public/products?q= | 公开 | 访客目录（不含价格） |
| GET | /api/mall/categories | 客户 | 有商品的类别及数量 |
| GET | /api/mall/products?q=&category=&only_fav= | 客户 | 商品列表（客户专属价 / 美仓可售量 / 收藏态） |
| GET | /api/mall/products/:id | 客户 | 商品详情 + 阶梯价 + 可售量 |
| GET | /api/mall/favorites | 客户 | 我的收藏 |
| POST | /api/mall/favorites/:id | 客户 | 切换收藏（返回 `{favorite}`） |
| POST | /api/mall/inquiries | 客户 | 提交选品询价 `{items:[{mall_product_id,qty,remark}], contact, remark}` |
| GET | /api/mall/inquiries | 客户 | 我的询价单 |
| GET | /api/mall/inquiries/:id | 客户 | 询价详情（含明细与报价说明） |
| POST | /api/mall/inquiries/:id/confirm | 客户 | 确认报价（quoted → confirmed） |
| POST | /api/mall/inquiries/:id/cancel | 客户 | 取消询价 |
| GET | /api/mall/orders | 客户 | 我的订单（脱敏） |
| GET | /api/mall/orders/:id | 客户 | 订单明细 + 进度时间线（不含成本/工厂） |
| GET | /api/mall/messages | 客户 | 站内消息 |
| POST | /api/mall/messages/:id/read · /read-all | 客户 | 标记已读 |
| GET | /api/mall/summary | 客户 | 未读消息/进行中询价/订单/收藏 角标 |

### 商城后台（ERP 员工）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/mall-admin/stats | 登录 | 在售商品、待报价、询价金额、转化率 |
| GET/POST | /api/mall-admin/products | 读:登录 / 写:admin,sales | 商城商品列表 / 发布（可从产品库带入） |
| PUT/DELETE | /api/mall-admin/products/:id | admin,sales | 编辑 / 删除 |
| POST | /api/mall-admin/products/:id/status | admin,sales | `{status: draft|published|off}` 上下架 |
| GET/POST/DELETE | /api/mall-admin/prices | 读:登录 / 写:admin,sales | 客户专属价（按 customer_id 查询） |
| GET | /api/mall-admin/inquiries?status=&q= | 登录 | 询价单列表 |
| GET | /api/mall-admin/inquiries/:id | 登录 | 询价明细 |
| POST | /api/mall-admin/inquiries/:id/quote | admin,sales | 逐行报价 `{items:[{id,price_usd}], sales_remark}` → 通知客户 |
| POST | /api/mall-admin/inquiries/:id/convert | admin,sales | 仅客户已确认的询价可转销售订单草稿；转单后须在草稿补齐颜色尺码，回填 `order_id` |
| GET/POST/PUT | /api/mall-admin/accounts | 读:登录 / 写:admin,sales | 客户账号：开通（首个为主账号）/ 改密 / 停用 |
| POST | /api/mall-admin/notify | admin,sales | 给客户发站内通知 `{customer_id,title,body,type}` |

> 数据流转：订单状态每次流转（`POST /api/orders/:id/transition`）都会给该客户的商城账号自动写一条站内消息；客户无商城账号则跳过。

> 报表口径：毛利 = 订单人民币金额 − 「审核通过」的成本单总成本；无已审核成本单的订单不计入毛利并单独列出（避免毛利率虚高）。账期：系统暂无收款台账，「应收敞口」= 已发货未结案（`status='shipped'`）订单金额，账龄自 `order_logs` 首次 `to_status='shipped'` 起算。

## 批量导入（CSV）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/import/template/:kind | 登录 | 下载模板，kind = `customers` / `products` / `materials`（带 UTF-8 BOM） |
| POST | /api/import/customers | admin,tech,sales | body `{csv}`；按「编号」覆盖，无编号则新增 |
| POST | /api/import/products | admin,tech,sales | body `{csv}`；按「款号」覆盖 |
| POST | /api/import/materials | admin,tech,sales | body `{csv}`；按「类型+名称」覆盖，类型填「面料/辅料」 |

返回 `{ inserted, updated, errors: ['第 N 行：原因'] }`；表头支持中英文别名（如 `名称|客户名称|name`），前端会把 Excel 导出的 GBK 文件自动转码。

## 阶梯报价
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/price-tiers?product_id= | 登录 | 某款全部阶梯（不传则返回全部） |
| GET | /api/price-tiers/lookup?product_id=&qty= | 登录 | 按数量匹配单价，返回 `{price_usd, tier_id, matched, source}` |
| POST | /api/price-tiers | admin,tech,sales | `{product_id, tiers:[{min_qty,max_qty,price_usd}]}` **全量覆盖**（max_qty 传空=无上限） |
| DELETE | /api/price-tiers/:id | admin,tech,sales | 删除单条阶梯 |

## 报价单
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/quotations?status=&q=&customer_id= | 登录 | 列表 |
| GET | /api/quotations/meta | 登录 | 状态字典 + 当前汇率 |
| GET | /api/quotations/:id | 登录 | 详情（含明细） |
| POST | /api/quotations | admin,sales | 新建；明细不传 `price_usd` 时**自动取阶梯价** |
| PUT | /api/quotations/:id | admin,sales | 修改（仅草稿） |
| POST | /api/quotations/:id/status | admin,sales | `draft→sent→accepted/rejected` |
| POST | /api/quotations/:id/reprice | admin,sales | 按当前阶梯价重算（仅草稿） |
| POST | /api/quotations/:id/convert | admin,sales | 仅客户已接受的报价可转销售订单草稿；转单后须在草稿补齐颜色尺码，返回 `{order_id, order_no}` |
| DELETE | /api/quotations/:id | admin,sales | 删除（仅草稿） |

打印页：前端 `/print/quote/:id`（A4，含美金大写、报价说明、签章位）。

## 往来账（应收 / 应付 / 收付款核销）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/finance/summary | 登录 | 总览：应收/应付未结、逾期、本月收付、**美金口径 ar_open_usd / ar_total_usd / ar_paid_usd** |
| GET | /api/finance/ar · /ap | 登录 | 列表（`?q=&status=&partner_id=`），每行带 `open_amount`、`open_amount_orig`、`aging_days`、`overdue` |
| POST | /api/finance/ar · /ap | admin,finance | 开票；外币传 `{currency:'USD', amount_orig, rate}`，本币传 `{amount}` |
| POST | /api/finance/ar/:id/void · /ap/:id/void | admin,finance | 作废（有核销不允许） |
| GET | /api/finance/payments | 登录 | 收付款列表（带核销明细） |
| POST | /api/finance/payments | admin,finance | 登记收付款并核销；外币传 `{currency:'USD', amount_orig, rate}` |
| POST | /api/finance/payments/:id/reverse | admin,finance | 红冲（款项作废，核销金额退回账款） |
| GET | /api/finance/aging | 登录 | 账龄分桶（未到期 / 30 / 60 / 90 / 90+） |
| GET | /api/finance/open-invoices | 登录 | 某对象未结单据（登记收付款时选） |

**美金开票口径**：订单 `total_usd > 0` 时，发货自动开 **USD 应收**（`amount_orig = total_usd`，`rate = 订单汇率`，`amount = USD × rate` 记账）；纯内销退化成 CNY。
核销一律用本币，状态由核销明细汇总回写；订单结案前必须有已收清（可 `force=true` 强制）。

## 成本与毛利（一单一成本对象）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/costing/overview | 登录 | 已售收入/成本/毛利/毛利率/未售成本/预算差/亏损单数 |
| GET | /api/costing/orders | 登录 | 成本对象列表（`?q=&status=loss`） |
| GET | /api/costing/orders/:orderId | 登录 | 详情：成本层汇总 + 成本明细 + 已售结转快照（进来即确保对象存在） |
| POST | /api/costing/orders/:orderId/collect | admin,finance | 重新归集（幂等，先删 auto 层再重建） |
| POST | /api/costing/orders/:orderId/snapshot | admin,finance | 按已发货数量结转已售成本 |
| POST | /api/costing/entries | admin,finance | 追加手工成本（freight / rework / other / overhead） |
| DELETE | /api/costing/entries/:id | admin,finance | 删除手工项（auto 项不可删） |

**成本层**：`material` 面料（开发单用量 × 损耗 × 件数）、`accessory` 辅料、`labor` 工缴（工序倍率单价 × 件数）、
`overhead` 制造费用、`other` 其他（后两者取核价成本单）、`freight` 后补到仓费用、`rework` 返工报废（手工）。
数据流：订单发货 → 自动建成本对象 + 归集 + 按发货件数结转；后补费用 → 重算单件成本 → 自动补提已售成本差额。

## 接单评审与交期承诺
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/commitments/board | 登录 | 看板（`?q=&risk=&review=`）+ 指标统计 |
| GET | /api/commitments/order/:orderId | 登录 | 按订单取承诺单（不存在则创建），含节点与产能参考 |
| POST | /api/commitments/order/:orderId/ensure | admin,production,sales | 手动生成/重建路线 |
| POST | /api/commitments/:id/review | admin,production,sales | 评审：三项承接确认 + 承诺日 + 意见 |
| POST | /api/commitments/:id/nodes/:nodeId | admin,production,sales | 更新节点实绩（开工 / 完成 / 撤销） |
| POST | /api/commitments/:id/reforecast | 登录 | 重算预测与风险 |
| GET | /api/commitments/capacity | 登录 | 产能负荷参考（月产能 / 在制 / 负荷率） |
| POST | /api/commitments/capacity | admin | 设置月产能 |
| GET | /api/commitments/node-defs | 登录 | 路线节点定义（本厂 / 裁片外发） |

**T0 起算**：`max(订单确认时点, 启动款到账时点)`，取较晚者；付款前沟通不计入，事后补款不重置。
**四个日期各自独立**：对客承诺日 `promised_date` / 内部计划日 `planned_date` / 最新预测 `forecast_date` / 实际出厂 `actual_ship_date`。
**评审三项**：`front_ok`（裁床算料）/ `back_ok`（缝制后道）/ `material_ok`（物料齐套），全通过才 `approved`，任一不通过即 `rejected` 且必须写原因。
**门槛**：订单 `draft→tech` 前必须 `approved`（评审检查先于开发单确认）。
**风险**：`forecast > promised` → red；差值 > -3 天 → yellow；督办日（T0 后第 5/7/9/11/12/14 天）已过但节点未完成 → 至少 yellow。

## 齐套与缺料
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/requirements/board | 登录 | 看板（`?q=&state=ready\|partial\|short`）+ 指标 |
| GET | /api/requirements/lines | 登录 | 需求行（`?order_id=&status=&mat_type=`） |
| GET | /api/requirements/order/:orderId | 登录 | 单订单齐套详情（含「能否裁剪 / 能否缝制」判定） |
| GET | /api/requirements/shortage | 登录 | 采购建议：按物料汇总净缺口、在途、供应商、涉及订单 |
| POST | /api/requirements/calc | admin,production,warehouse,sales | 全量重算（幂等，保留人工填的负责人与处理动作） |
| POST | /api/requirements/:id/action | 同上 | 标记处理：pending / ordered / substituted / received |

**需求口径**：`need = 单件用量 × (1 + 损耗%) × 订单件数`；用量为 0 的行不参与（属开发单数据缺失）。
**分配顺序**：同一物料多单争抢 → 按对客承诺日早的优先；先分库存，再分在途采购，剩下的才是净缺口。
**在途**：采购明细中 `qty > received_qty` 且采购单未取消的数量。
**工序齐套**：面料齐 → 可裁剪（P5）；辅料齐 → 可缝制（B1）；两者齐 → 可排产。
**订单状态**：`ready` 齐套 / `partial` 面料齐辅料缺 / `short` 面料缺（不能裁剪）。

## 裁床与扎包（P5 实际裁剪）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/cuts/board | 登录 | 看板（`?q=&status=`）+ 指标 |
| GET | /api/cuts/order/:orderId | 登录 | 单订单裁剪单（不存在则创建），含床次、扎包、齐套闸门 |
| POST | /api/cuts/:id/start | admin,production,warehouse | 开裁：技术版已确认 + 面料齐套 + P4 已接收 三重校验 |
| POST | /api/cuts/:id/lots | 同上 | 新增/更新床次（缸号、布卷、幅宽、层数、排料图、实裁、余料） |
| DELETE | /api/cuts/:id/lots/:lotId | 同上 | 删床次（连带删该床扎包并重排床号） |
| POST | /api/cuts/:id/bundles/generate | 同上 | 按尺码生成扎包（基数取实裁数，末码吃差额保证合计一致） |
| POST | /api/cuts/:id/bundles | 同上 | 新增/更新/复核单条扎包 |
| DELETE | /api/cuts/:id/bundles/:bundleId | 同上 | 删扎包 |
| POST | /api/cuts/:id/finish | 同上 | 完成裁剪：核对裁差、扎包与合格裁片一致，同步「裁剪」工序节点 |
| POST | /api/cuts/:id/handover | 同上 | P6 交接给缝制（要求所有扎包已复核） |

**硬规则**
- 开裁三重闸门：技术版 `confirmed` → 面料齐套（引用 `/api/requirements` 结论）→ P4 面料已到裁剪现场。
- **错缸不放行**：同单床次缸号必须一致；确需混缸要传 `allow_mixed:true` 且写明原因，主表标记 `mixed_dye_lot`。
- 床次必须有缸号与大于 0 的层数。
- 完成裁剪：`实裁 − 计划 ≠ 0` 必须写 `diff_reason`；`扎包合计` 必须等于 `合格裁片`。
- 交接：还有未复核扎包时拒绝。

## 首件确认与工位工艺（TS-N08-03）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/first-articles/board | 登录 | 看板（`?q=&status=draft\|submitted\|passed\|conditional\|rejected\|none`）+ 指标 |
| GET | /api/first-articles/gate/:orderId | 登录 | 批量投产门禁：`{released, reason, fa_no, release_qty}` |
| GET | /api/first-articles/order/:orderId | 登录 | 该单首件单 + 工位工艺 + 门禁（没有首件单时返回建单模板） |
| GET | /api/first-articles/:id | 登录 | 首件单详情（检查项、汇总、能否提交/放行） |
| POST | /api/first-articles | admin,production,tech,sales | 登记首件（要求已有 confirmed 技术版；同单同时只能有一张进行中的） |
| PUT | /api/first-articles/:id | 同上 | 改首件信息（已放行的不允许改） |
| POST | /api/first-articles/:id/checks/generate | 同上 | 按冻结版尺寸表（首件尺码）+ 关键工序生成检查项 |
| POST | /api/first-articles/:id/checks | 同上 | 保存单条检查项（实测 / 结论 / 备注），无 `id` 即新增 |
| DELETE | /api/first-articles/:id/checks/:cid | 同上 | 删检查项 |
| POST | /api/first-articles/:id/submit | 同上 | 提交复核：全部项必须有实测与结论 |
| POST | /api/first-articles/:id/release | admin,production,tech | 复核放行：`{result: passed\|conditional, release_qty, limit_note, conclusion}` |
| POST | /api/first-articles/:id/reject | 同上 | 不合格退回：`{return_to: sales\|tech, reason}`（原因必填） |
| POST | /api/first-articles/:id/reopen | admin,production,tech,sales | 退回后回到草稿重做 |
| POST | /api/first-articles/:id/refresh-version | 同上 | 改版失效后指向当前冻结版并清空检查项重做 |
| GET | /api/first-articles/workstations | 登录 | 工位工艺卡（`?order_id=`） |
| POST | /api/first-articles/workstations/generate | admin,production,tech,sales | 按 13 道工序生成工位工艺卡（不覆盖已有） |
| POST | /api/first-articles/workstations | 同上 | 新增 / 更新单条工位工艺 |
| DELETE | /api/first-articles/workstations/:id | 同上 | 删工位工艺 |

**冻结版口径**：`frozenTechpack(orderId)` = 该订单最新一张 `status='confirmed'` 的技术版。首件单保存 `tech_pack_id + tech_pack_version` 快照；
当前冻结版变了 → 首件 `stale=1`。
**状态机**：`draft → submitted → passed | conditional | rejected`；`rejected → draft`（重做）；改版可直接 `refresh-version` 回 draft。
**关键项**：`critical=1` 的检查项 NG 时禁止放行；非关键项 NG 只能 `conditional` 且 `limit_note` 必填。
**复核人约束**：`released_by ≠ inspector`（admin 例外）。
**报工门禁**：`POST /api/reports` 在非「备料/排版算料/裁剪」工序上调用 `faGate(orderId)`，未放行返回 400。

## 生产原料收货与检验（TS-N10-08）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/receipts/board | 登录 | 收料看板（`?q=&status=pending\|inspecting\|partial\|passed\|rejected\|cancelled`）+ 指标 |
| GET | /api/receipts/pending | 登录 | 待检汇总（按物料），用于提示「有料在待检，不算可用」 |
| GET | /api/receipts/po/:poId | 登录 | 采购单可收行：采购量 / 已到 / 本次应收 |
| GET | /api/receipts/:id | 登录 | 收料单详情：明细、处置记录、`can_inspect` / `can_cancel` |
| POST | /api/receipts | admin,warehouse,production | 点收建单：`{po_id, receive_date, warehouse, items:[{po_item_id, expect_qty, receive_qty, roll_no, dye_lot, location, diff_reason}]}` |
| PUT | /api/receipts/:id/items/:itemId | 同上 | 补录卷号 / 缸号 / 库位 |
| POST | /api/receipts/:id/inspect | 同上 | 来料检查：`{items:[{id, pass_qty, freeze_qty, reject_qty, note}]}` |
| POST | /api/receipts/:id/items/:itemId/dispose | 同上 | 冻结处置：`{action: release\|reject, qty, reason}` |
| POST | /api/receipts/:id/cancel | 同上 | 作废（只有没检验过的单可作废） |

**核心口径：收货不自动可用**
- 点收只把「到货事实」记到 `purchase_items.received_qty`，数量全部进 `pending_qty`；
  `materials.stock_qty` **一分不加**。
- 检验判定 `pass_qty` 时才 `materials.stock_qty += pass_qty`；`freeze_qty` 与 `reject_qty` 不进库存。
- 因此齐套与缺料 / 裁床开裁看到的是「合格可用量」，待检量不算数（保守，宁可拦一下）。

**差异**
- `diff = 实收 − 应收`；`> 0` 记 `over`（必须写 `diff_reason`，主表单列 `over_qty` 供调查）；`< 0` 记 `short`（`short_qty` 等补发）。
- 采购页 `POST /api/purchases/:id/receive` 现在只生成收料单（返回 `grn_no` + `notice`），不再直接加库存。

**检验分流**
- `合格 + 冻结 + 退回 ≤ pending_qty`（可分批检验，剩余继续待检）；超过直接 400。
- 冻结 / 退回必须写 `note`（原因）。
- 退回 → `purchase_items.received_qty -= reject_qty`（不低于 0），采购单回 `ordered` 等补发。

**冻结处置**
- `release`：冻结量转合格并加库存（让步接收 / 客户同意 / 复检合格），原因必填。
- `reject`：冻结量转退回并回退采购行已收数量，原因必填。
- 允许部分处置（`qty ≤ freeze_qty`）。

**状态**：单头 `pending 待检 / inspecting 检验中 / partial 部分合格 / passed 全部合格 / rejected 全退 / cancelled 已作废`；
明细 `pending 待检 / passed 合格 / partial 部分合格 / frozen 冻结 / rejected 退回`。

## 内部邮件（TS-N01-05 ~ TS-N01-09）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/mail/contacts | 员工 | 通讯录（`?q=`）+ 群组（全员 / 各部门，发送时展开为快照） |
| GET | /api/mail/unread | 员工 | 未读 / 待确认 / 待办任务数（顶部图标） |
| GET | /api/mail/box | 员工 | 邮箱（`?folder=inbox\|pending\|sent\|starred\|archived\|trash&q=&type=`）+ 各文件夹计数 |
| GET | /api/mail/stats | 员工 | 投递 / 确认 / 办理统计（投递按信件×收件人，确认只算必确认行） |
| GET | /api/mail/thread/:id | 员工 | 会话（按每封信实际收件范围取交集） |
| GET | /api/mail/:id | 员工 | 读信（**只有这里写首次已读**，发件人自己看不写） |
| POST | /api/mail/send | 员工 | 发信（见下） |
| POST | /api/mail/:id/ack | 员工 | 确认知悉：`{note, on_behalf_of}`（代理确认需有效授权） |
| POST | /api/mail/:id/question | 员工 | 提出疑问（**不算确认**） |
| POST | /api/mail/:id/answer | 员工 | 发件人答复疑问（答复后回到「待确认」） |
| POST | /api/mail/:id/flag | 员工 | 星标 / 归档 / 回收站 / 标未读（只作用本人副本） |
| POST | /api/mail/:id/recall | 员工 | 撤回：`{reason}`，逐人原子判断 |
| POST | /api/mail/:id/correct | 员工 | 更正：`{body, reason}`，生成新版本 |
| POST | /api/mail/:id/retry | 员工 | 重试失败投递（只重试失败对象） |
| GET | /api/mail/tasks/mine | 员工 | 我的协同任务（`?status=open`） |
| POST | /api/mail/tasks/:id/done | 员工 | 协同任务结案（主责 / 创建人 / admin） |
| GET | /api/mail/delegates | 员工 | 我相关的代理授权 |
| POST | /api/mail/delegates | 员工 | 新增代理：`{owner, agent, scope, start_at, end_at, reason}` |
| POST | /api/mail/delegates/:id/revoke | 员工 | 撤销代理 |

**发信参数**
```
{
  action: new | reply | reply_all | forward,   parent_id,
  subject, body,  type: normal | confirm | task,
  to: [username | 'all' | 'dept:3'],  cc: [...],
  attachments: [{name,url,size,ext,hash}],      // 只接受 /uploads/ 下本系统文件
  source_type: order|first_article|receipt|cut|quote,  source_id,
  confirm_due,        // type=confirm 必填
  task_due,           // type=task 必填
  task: {title, owner, due_at, requirement},    // 无原任务时必填（一交付物一主责）
  acting_for,         // 代理发信，需有效授权且 scope ≠ ack
  request_no          // 幂等键
}
```

**核心口径**
- **收件人优先于抄送**：同一人既在 to 又在 cc 时只保留 to；群组展开后按人去重。
- **投递**：每位收件人独立 `queued → delivered | failed`；账号无效即 failed，`retry` 只重试失败行。
- **已读**：只有 `GET /api/mail/:id` 由收件人本人调用才写 `first_read_at`；`flag.read_flag=0` 只清提醒，不动历史。
- **确认**：`type=confirm` 时所有 `to` 行 `must_ack=1`、`ack_state='pending'`；`cc` 直接 `acked`（默认知悉）。
  提问置 `questioned`（不算确认）；发件人 `answer` 后置回 `pending`，仍由本人确认。
- **需办理**：有关联源单时只做**只读投影**（`source.status` + 受控链接），办理与结案仍在原单；
  无原任务时创建 `mail_tasks`，一项交付物一名主责，**不给每位抄送人复制任务**。
- **撤回**：只有 `delivered && 无 first_read_at && 未 acked` 的行能撤回；其余列失败原因，只能发更正。
- **更正**：新信 `version+1`、`corrects_id` 指向原信，原信 `status='corrected'`；新信重建确认义务，旧回执保留。
- **越权**：非收发人读正文 403（含 admin），并写 `mail_audits(read_body)`。
- **客户账号**（`scope=customer`）一律拒 403：内部邮件只对有效员工账号开放。

## 客户子账号与授权（TS-N21-01 / 03 / 04 / 08）

**权限点**（服务端逐接口校验，`permRequired(perm)`）
| 权限点 | 含义 |
|---|---|
| catalog.view | 看商品与专属价 |
| inquiry.create | 发起询价 |
| order.view | 看订单与进度 |
| order.confirm | 确认样衣 / 变更 / 交期 |
| finance.view | 看对账与账单（含订单金额字段） |
| member.manage | 管理本组织子账号 |

**客户侧（客户 token）**
| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/mall/members | member.manage | 本组织成员 + 可分配上限 + 权限字典 |
| POST | /api/mall/members | member.manage | 开子账号：`{username,password,name,role,perms}`，perms 必须在上限内 |
| PUT | /api/mall/members/:id | member.manage | 改权限 / 停用启用（不能改自己、不能动主账号） |
| POST | /api/mall/members/:id/reset-pwd | member.manage | 重置子账号密码（只回显一次，标记需改密） |
| GET | /api/mall/audits | member.manage | 本组织授权审计（只读） |
| GET | /api/mall/finance | finance.view | 对账与账单：账单明细 + 应收/已收/未收/逾期/回款率 |
| POST | /api/mall/auth/change-pwd | 登录 | 本人改密码 |
| GET | /api/mall/auth/invite/:token | 公开 | 校验邀请（客户名、类型、掩码联系方式、有效期） |
| POST | /api/mall/auth/invite/:token/accept | 公开 | 凭令牌注册：`{username,password,name,phone,email}` |

**ERP 侧（员工 token）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/mall-admin/accounts | 登录 | 账号列表（含生效权限、批准上限、角色标签） |
| POST | /api/mall-admin/accounts/:id/approve | admin,sales | 批准主账号可分配的权限上限，并联动收紧已开的子账号 |
| GET | /api/mall-admin/invites | 登录 | 邀请列表（令牌掩码、状态、使用人） |
| POST | /api/mall-admin/invites | admin,sales | 发邀请：`{customer_id,role,contact,days,note}` → 返回一次性链接 |
| POST | /api/mall-admin/invites/:id/revoke | admin,sales | 撤回邀请（仅 pending 可撤） |
| GET | /api/mall-admin/account-audits | 登录 | 授权审计（含来源：业务员 / 客户侧 / 系统） |

**硬规则**
- **范围只来自登录身份**：`customerRequired` 每次从库现读账号，`cid` 不取 token 之外的任何输入；停用/删除/改绑立即 401。
- **两级上限**：销售给主账号批 `limit_perms` → 主账号只能在其中给子账号分配；主账号自身也受该上限约束。
- **越权即 400**：子账号权限超出上限 → `超出销售批准的权限上限：<权限名>`。
- **字段级隔离**：无 `finance.view` 时 `/api/mall/orders`（列表/详情）不返回任何金额字段，并给 `amount_hidden: true`。
- **`/api/mall/orders` 返回 `{rows, amount_visible}`**（原为数组）。`/api/mall-admin/accounts` 返回 `{rows, perm_dict, role_presets, sub_roles}`。
- **邀请令牌**一次性：`pending → used | revoked | expired`；接受时按角色预设装权限（不超过主账号上限）。
- **审计只读**：`customer_account_audits` 记录前后值与来源，普通业务用户无改删接口。

## 供应商评价与备用产能（TS-N07-05）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/supplier-evals/board | 登录 | 评价看板（`?q=&only=ranked\|improve\|insufficient`）+ 名次 + 资格 + 指标 |
| GET | /api/supplier-evals/board/:supplierId | 登录 | 供应商明细：历史评价、`last_samples` 样本来源、整改、备用 |
| POST | /api/supplier-evals/collect | admin,sales,warehouse | 生成评价 `{supplier_id, period_start, period_end, price_score?, capacity_qty?, conclusion?, evidence?}` |
| POST | /api/supplier-evals/:id/recollect | 同上 | 同期重算样本（保留人工项：报价条件分 / 产能 / 结论 / 证据） |
| PUT | /api/supplier-evals/:id | 同上 | 改人工项并重算分 |
| POST | /api/supplier-evals/:id/decide | 同上 | 落供货资格 `{action: keep\|rectify\|suspend\|verify_backup, issue?, action_req?, due_date?}` |
| GET | /api/supplier-evals/qualifications | 登录 | 当前供货资格一览（含未闭环整改数） |
| GET | /api/supplier-evals/rectifications | 登录 | 整改单（`?status=&supplier_id=`），带 `overdue` |
| POST | /api/supplier-evals/rectifications/:id/submit | 同上 | 提交整改 `{submit_note}` |
| POST | /api/supplier-evals/rectifications/:id/verify | 同上 | 验证 `{pass, note}`：通过按最近评价决定回升合格/维持有条件；不通过直接暂停 |
| GET | /api/supplier-evals/backups | 登录 | 备用产能（`?status=&scope=`），带 `missing` 缺哪项验证 |
| POST | /api/supplier-evals/backups | 同上 | 登记 / 编辑备用产能（`verified` 的不允许改） |
| POST | /api/supplier-evals/backups/:id/verify | 同上 | 三项验证 `{tech_ok, sample_ok, compliance_ok, verify_note, evidence}` |
| POST | /api/supplier-evals/backups/:id/reject | 同上 | 判不通过 `{verify_note}` |
| GET | /api/supplier-evals/backup-pick | 登录 | 备用选源（`?qty=&scope=`），返回 `sort_note` 说明**不按最低价** |

**样本口径（所有供应商同一套，不手填）**
- 样本 = 观察期内该供应商未作废的收料单（GRN）。
- **准交分母**只算采购单有 `expect_date` 的样本；迟到天数 = `receive_date − expect_date`；
  `expect_date` 为空的样本单列 `no_due_count`，**不进分母**（口径透明，不偷偷算准交）。
- **质量分母**只算已检验量 `pass + freeze + reject`；待检量既不算良也不算不良。
- 不良率 = `(freeze + reject) / 已检验`；短收 / 超收按 GRN 单数计。

**打分**
`准交率 × 45% + 质量分 × 45% + 报价条件分 × 10%`，质量分 = `100 − 不良率 × 5`（封顶 0/100），
报价条件分未填按 60 中性。等级：A ≥ 90，B ≥ 80，C ≥ 70，D < 70。

**样本不足不排名**：准交分母 < `MIN_SAMPLE`（3）→ `grade='NA'`、`score=null`、`rank=null`，
只出数据不给等级，也不参与排名（看板把这类排在后面）。

**供货资格**
- `keep`：只允许 A/B 级且无未闭环整改，否则 400。
- `rectify`：开整改单 + 资格置 `conditional`（问题与整改要求必填）。
- `suspend`：开整改单 + 资格置 `suspended`，**采购下单会被 400 拦住**。
- `verify_backup`：资格置 `observing`，去「备用产能」做三项验证。
- 整改 `verify(pass)`：还有别的单未闭环 → 维持 `conditional`；全闭环且最近评价 A/B → `qualified`；
  `pass=false` → `suspended`。

**备用产能**
- 状态 `pending → verified | rejected`；三项（技术 / 封样 / 合规）缺一项不允许 `verified`。
- 选源排序 = 综合分 desc → 剩余负荷 desc，**价格只展示不参与排序**（不自动选最低价）。
- `remaining_qty = capacity_qty − used_qty`，评价里的剩余负荷取该供应商所有 `verified` 备用的合计。

**采购门禁（改到 purchases）**
- `POST /api/purchases` 现要求供方能解析到供应商档案（`supplier_id` 或档案内的名称/简称）；
  解析不到 → 400；资格 `suspended` → 400；`conditional` / `observing` → 放行但在返回里给
  `qualification_warning`。

## 停单改量与供应商退料（TS-N07-06）
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/purchase-changes/board | 登录 | 变更 + 退料看板（`?status=&q=`）+ 指标 |
| GET | /api/purchase-changes/po/:poId | 登录 | 采购单可改行：`pending_qty` 未交 / `returnable_qty` 可退 |
| POST | /api/purchase-changes | admin,sales,warehouse,production | 建变更单 `{po_id, type: reduce\|cancel, reason, items:[{po_item_id, reduce_qty, return_flag?}]}` |
| POST | /api/purchase-changes/:id/submit | 同上 | 提交供方确认（draft → pending_supplier） |
| POST | /api/purchase-changes/:id/supplier-confirm | 同上 | 供方确认 `{agree, supplier_confirmed_by, supplier_comment}`（拒绝必写理由） |
| POST | /api/purchase-changes/:id/effective | 同上 | 生效（减量落采购行 / 停单落 cancelled），生效前重校验未交量 |
| POST | /api/purchase-changes/:id/void | 同上 | 作废（effective 前可作废） |
| GET | /api/purchase-changes/returns | 登录 | 退料单列表 |
| POST | /api/purchase-changes/returns | 同上 | 建退料单 `{po_id, reason, items:[{po_item_id, qty}]}` |
| POST | /api/purchase-changes/returns/:id/physical | 同上 | 实物回执 `{note}`：扣 `materials.stock_qty` + `returned_qty` 累计 |
| POST | /api/purchase-changes/returns/:id/credit | 同上 | 贷项回执 `{credit_note_no, credit_amount}`：完成差异结算 |
| POST | /api/purchase-changes/returns/:id/void | 同上 | 作废（实物未退前） |

**核心口径**
- **减量只动未交**：`reduce_qty ≤ qty − received_qty`；已收的料不能「停」，只能「退」。
- **整单停单**要求该采购单没有任何到货，否则 400 提示「减量 + 退料」。
- **退料不超退**：`qty ≤ received_qty − issued_qty − returned_qty`；`received_qty` 是「已收」事实，退料不改它。
- **两道回执**：`pending_receipt → returned`（实物，扣库存）`→ done`（贷项凭证冲应付）；跳步 400。
- 数据流联动：减量生效 → 采购行 qty 下降 → 齐套「在途」= qty − received 自动降；停单生效 → 采购单 cancelled 被齐套排除。

## 返工报废与生产结单（TS-N08-06）

**返工报废（`/api/reworks`）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/reworks/board | 登录 | 看板（`?order_id=&status=&q=`）+ 指标（待批准/返工中/报废件数/损失） |
| GET | /api/reworks/gate/:orderId | 登录 | 该订单的结单检查（同下方生产结单的检查口径） |
| GET | /api/reworks/nodes/:orderId | 登录 | 订单工序清单（开返工单选原工序用） |
| GET | /api/reworks/:id | 登录 | 单详情 |
| POST | /api/reworks | admin,production,tech,warehouse | 建单 `{order_id, node_id, type: rework\|scrap, source, responsibility, reason, qty, cost_labor, cost_material, evidence}` |
| POST | /api/reworks/:id/submit | 同上 | 草稿 → 待批准 |
| POST | /api/reworks/:id/approve | 同上 | 批准 / 驳回 `{agree, note}`；**批准人 ≠ 制单人**（admin 例外） |
| POST | /api/reworks/:id/start | 同上 | 已批准 → 返工中 |
| POST | /api/reworks/:id/reinspect | 同上 | 复验 `{result: pass\|fail, qty_ok, note}`；pass 闭环 + 损失进成本，fail 回返工中且次数 +1 |
| POST | /api/reworks/:id/scrap | 同上 | 报废核销 `{qty_scrap, note}`（type=scrap，approved 后） |

**生产结单（`/api/production-close`）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/production-close/board | 登录 | 可结单 / 受限清单（每单带 blocked/warns/未交/工序完成度/已有结单） |
| GET | /api/production-close/gate/:orderId | 登录 | 五项检查 + 已有结单 |
| GET | /api/production-close/order/:orderId | 登录 | 该订单的结单记录 |
| POST | /api/production-close | admin,production,tech,warehouse | 结单 `{order_id, close_type: full\|partial, actual_close_date, dispute_note, balance_source, follow_up_owner}` |

**结单检查口径**
- **硬阻塞（不许结）**：未闭环返工/报废（`status NOT IN (closed,rejected)`）、质量未决（`qc_issues.status != closed`）、工序未全部 `done`。
- **软提示（只能部分关闭）**：未交未出库（订单未 shipped/closed 则未交 = 全部件数）、余料未清（`cut_orders.leftover_m > 0`）。
- **仅提示（不拦）**：成本未归集（可结单后补）。
- 部分关闭必须填 `dispute_note`（争议挂账说明）与 `balance_source`（余额来源：未交/在制/质量/余料）。
- `actual_close_date` 人工填，`recorded_at` 系统时间，**两者分开存**（补录也留真实录入时间）。
- 同一订单只允许全结一次；部分关闭后再全结允许。

**成本联动**
- 返工/报废闭环时写 `cost_entries(layer='rework', source='manual', ref_type='rework_order', ref_id=<单id>)`，
  只写一次（`rework_orders.cost_entry_id` 做幂等标记），随后 `recalc` 重算实际成本、`syncSold` 补提已售成本。

## 设备停机与产能影响（TS-N08-08）

**设备台账**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/equipment/board | 登录 | 台账（`?work_center=&q=`）+ 当前停机 + 指标；每台带 `open_downtime` |
| POST | /api/equipment | admin,production,warehouse,tech | 建设备 `{name, type, work_center, capacity_per_hour, owner, location, next_maintain_at}` |
| PUT | /api/equipment/:id | 同上 | 改设备 |

**停机报修**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/equipment/downtimes | 登录 | 停机单（`?status=&work_center=&q=&equipment_id=`）+ 指标 |
| POST | /api/equipment/downtimes | 同上 | 登记 `{equipment_id, type: breakdown\|maintenance\|changeover\|power, start_at, reason, repair_task, affected_orders:[{order_id,note}]}` |
| POST | /api/equipment/downtimes/:id/start-repair | 同上 | 待维修/计划保养 → 维修中 |
| POST | /api/equipment/downtimes/:id/finish-repair | 同上 | 维修中 → 待安全复核 `{repair_note, repair_by}` |
| POST | /api/equipment/downtimes/:id/safety | 同上 | 安全复核放行 `{safety_by, safety_note, end_at}` → 已恢复 |
| POST | /api/equipment/downtimes/:id/cancel | 同上 | 作废 `{reason}`（已恢复的不能作废） |

**产能**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/equipment/capacity | 登录 | 单工作中心当天：`base_hours / downtime_hours / available_hours / base_qty / available_qty / loss_qty / detail / risk_orders / promise_note` |
| GET | /api/equipment/capacity-board | 登录 | 多工作中心汇总（`?date=`） |

**硬规则**
- **登记即扣产能**：`status != 'planned'` 时设备置 `stopped/maintenance`；计划保养（未来开始）不改当前设备状态。
- 同一设备只能有一条未结停机单（`planned/pending_repair/repairing/pending_safety`）。
- **不能跳过安全复核**：只有 `pending_safety` 能放行；`safety_by` 必填且 `≠ created_by`（admin 除外）。
- 恢复时写 `end_at`、按实际起止重算 `occupied_hours` 与 `capacity_loss`（= 工时 × 台时产能快照）。
- 已恢复的停机单不能作废（它是产能损失的历史依据）。
- 产能基准 = 设备数 × 8 小时班次；停机占用按停机区间与当天 0-24 点的重叠小时数计。
- **时间格式统一为本地墙钟** `YYYY-MM-DD HH:mm:ss`（`normTime()` 会把 UTC ISO 换成本地），否则未结单的实时占用会算错。

## 岗位绩效与申诉（TS-N13-12 / 13 / 14）

**模板与规则**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/kpi/templates | 登录 | 模板列表（`?status=&job_family=&q=`）+ 指标数 / 权重合计 / 已用单数 |
| GET | /api/kpi/templates/:id | 登录 | 详情：指标含 `missing`（缺哪几项）、`can_edit`、`locked_reason`、版本历史 |
| POST | /api/kpi/templates | admin,sales | 建草稿 `{name, job_family, job_title, department_id, base_score}` |
| PUT | /api/kpi/templates/:id | admin,sales | 改模板（**仅 draft**） |
| POST | /api/kpi/templates/:id/rules | admin,sales | 加指标 `{name, category, definition, formula, target_value, unit, weight, threshold, data_source, exception_note, cap_score, reviewer}` |
| PUT | /api/kpi/templates/:id/rules/:rid | admin,sales | 改指标（仅 draft） |
| DELETE | /api/kpi/templates/:id/rules/:rid | admin,sales | 删指标（仅 draft） |
| POST | /api/kpi/templates/:id/submit | admin,sales | 提交复核（校验完整性 + 权重 = 100%） |
| POST | /api/kpi/templates/:id/approve | admin,sales,production | 批准 / 驳回 `{agree, note, effective_from}`；批准后同族旧版转 retired |
| POST | /api/kpi/templates/:id/new-version | admin,sales | 基于已批准版本出 V(n+1) 草稿 |
| POST | /api/kpi/templates/:id/simulate | 登录 | **模拟试算**（`{cycle_id}`），不写正式绩效 |

**周期**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/kpi/cycles | 登录 | 周期列表（ISO 周，含冻结状态与单量） |
| POST | /api/kpi/cycles | admin,sales | 生成周期 `{weeks: N}` 或 `{cycle_no:'2026-W44'}` |
| POST | /api/kpi/cycles/:id/freeze | admin,sales,production | 冻结（有待复核项时 400） |

**个人绩效**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/kpi/board | 登录 | 看板（`?cycle_id=`）：分数、建议/确认/申诉分、暂定标记、待复核清单、申诉列表 |
| GET | /api/kpi/scores | 登录 | 列表（`?cycle_id=&employee_id=&status=&q=`） |
| GET | /api/kpi/scores/:id | 登录 | 详情：公式、扣分项、申诉记录、周期状态 |
| POST | /api/kpi/generate | admin,sales | 生成本期绩效与建议扣分 `{cycle_id, employee_ids?}` |
| POST | /api/kpi/scores/:id/items | admin,sales | 人工登记扣分 `{rule_name, suggested_score, evidence, dedupe_key, ...}`（**必须有证据**） |
| POST | /api/kpi/items/:id/confirm | admin,sales,production | 复核：`{action: confirm, confirmed_score, note}` 或 `{action: reject, note}` |
| DELETE | /api/kpi/items/:id | admin,sales | 删未生效项（已确认的只能走申诉） |
| POST | /api/kpi/scores/:id/confirm | admin,sales,production | 确认整张单（仍有待复核项时 400） |

**申诉**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/kpi/appeals | 登录 | 申诉列表（`?status=&cycle_id=&employee_id=`）+ 统计，带 `overdue` 与 `same_reviewer` 提示 |
| POST | /api/kpi/appeals | 登录 | 提交 `{item_id, reason_type, reason, evidence, allow_after_freeze?}` |
| POST | /api/kpi/appeals/:id/accept | admin,sales,production | 受理 |
| POST | /api/kpi/appeals/:id/decide | admin,sales,production | 复核 `{decision: uphold\|reduce\|revoke, new_score, reviewer, note}` |
| POST | /api/kpi/appeals/:id/withdraw | 登录 | 撤回 |
| GET | /api/kpi/dict · /api/kpi/summary | 登录 | 字典 / 趋势与分类汇总 |

**核心口径**
- **当前分 = 基准分 − 已确认扣分**。`suggested_score`（建议）与 `pending_score`（待复核）**永远不计入**。
- **`final_score` 在 `provisional=1` 时为 null**：有未结申诉（`submitted` / `accepted`）时，分数只是暂定，不作为无争议最终分。
- **门槛顺序**：`提交审批` → 指标完整性（定义/口径/数据源/例外/上限/复核人）+ 权重 = 100% → `批准` 才发布；
  未批准的模板只能 `simulate`（返回 `simulated: true`）。
- **版本**：已批准版本不改；`new-version` 复制成新草稿；扣分项保存 `rule_snapshot`（版本/阈值/上限/单位），
  冻结周期按快照结算，不追溯。
- **自动建议**：`production_defect`（不良率）、`attendance_late`（迟到次数，批准休假覆盖不计）、
  `rework_duty`（本人责任返工件数）、`order_due`（**待配置，不预测不扣分**）、`manual`（人工）。
- **无数据不等于 0 分**：期内没有报工记录时不出扣分项（不按 0% 不良率蒙过去）。
- **同一事件不重复扣**：`UNIQUE(score_id, dedupe_key)`；建议项 key = `rule_id:cycle_id`，人工项用调用方给的 key。
- **确认约束**：确认扣分 ≤ 建议扣分，且 ≤ 单项 `cap_score`；驳回必须写原因。
- **冻结**：冻结后不许 generate / confirm / 加人工项；已恢复类操作只能走申诉。
- **申诉独立性**：`reviewer ≠ item.reviewed_by`；`reduce` 只能调低（`new_score ≤ confirmed_score`）；
  `revoke` 归零并把该项置 `rejected`；逾期只提醒，不自动判败。
- **绩效 ≠ 工资**：本模块只出分数与明细，工资仍由 `/api/payrolls` 人工确认，两者无自动联动。

## 行政合同与履约日历 / 印章独立授权（TS-N14-06 / TS-N14-05）

**合同（`/api/admin-contracts/contracts`）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/admin-contracts/board | 登录 | 总览：合同、到期/过期、履约任务、印章授权缺口、证照临期、用印待办、借章未还 + 预警清单 |
| GET | /api/admin-contracts/contracts | 登录 | 台账（`?status=&type=&q=&expiring=30\|90`），每份带 `next_milestone` / `days_to_end` |
| GET | /api/admin-contracts/contracts/:id | 登录 | 详情：版本、履约任务、用印记录、`current_doc_hash` |
| POST | /api/admin-contracts/contracts | admin,sales | 建合同 `{name,type,company,counterparty,owner,amount,deposit,deposit_return_date,start_date,end_date,renewal_notice_days,seal_id,payments[],acceptances[]}` |
| PUT | /api/admin-contracts/contracts/:id | admin,sales | 改合同（归档后不许改） |
| POST | /api/admin-contracts/contracts/:id/versions | admin,sales | 出新版本 `{doc_name,doc_hash,change_note}`；**未用印申请自动转需重核** |
| POST | /api/admin-contracts/contracts/:id/renew | admin,sales | 续签 `{renewal_basis,end_date}`，依据必填、新到期日必须晚于原到期日 |
| POST | /api/admin-contracts/contracts/:id/terminate | admin,sales | 终止 `{reason}`；付款/验收/续约/到期提醒转豁免，**押金返还保留** |
| POST | /api/admin-contracts/contracts/:id/archive | admin,sales | 归档 / 取消归档 `{undo:true}`（保留不删除） |

**履约任务与日历**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/admin-contracts/contracts/:id/milestones | admin,sales | 加任务 `{type,title,due_date,amount}` |
| POST | /api/admin-contracts/milestones/:id/done | admin,sales | 完成 `{evidence}`（证据必填） |
| POST | /api/admin-contracts/milestones/:id/waive | admin,sales | 豁免 `{reason}`；**押金返还不能豁免** |
| GET | /api/admin-contracts/calendar | 登录 | 统一日历 `?from=&to=`：合同任务 + 证照到期 + 借章逾期 |

**印章授权与用印/借章**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/admin-contracts/seal-grants | 登录 | 授权清单 + **覆盖率**（哪枚章没有有效授权） |
| POST | /api/admin-contracts/seal-grants | admin,sales | 授权 `{seal_id,grantee,grantee_type:person\|role\|position,scope:use\|borrow\|all,valid_from,valid_to}` |
| POST | /api/admin-contracts/seal-grants/:id/revoke | admin,sales | 撤销授权 `{reason}` |
| GET | /api/admin-contracts/seal-usages | 登录 | 用印/借章（`?status=&kind=&contract_id=`），带 `borrow_overdue` |
| POST | /api/admin-contracts/seal-usages | admin,sales | 申请 `{kind:use\|borrow,seal_id,purpose,doc_name,contract_id,doc_hash,expect_return_date}` |
| POST | /api/admin-contracts/seal-usages/:id/approve | admin,sales | 批准（需重核的拒绝） |
| POST | /api/admin-contracts/seal-usages/:id/use | admin,sales | 登记用印 `{receipt_no}`（必填），并再核一次版本指纹 |
| POST | /api/admin-contracts/seal-usages/:id/borrow | admin,sales | 借出登记 |
| POST | /api/admin-contracts/seal-usages/:id/return | admin,sales | 归还 `{return_receipt}`（必填），逾期会提示 |
| POST | /api/admin-contracts/seal-usages/:id/reject | admin,sales | 驳回 `{reason}` |

**证照与访问留痕**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/admin-contracts/certificates | 登录 | 有效证照 + 到期分级（expired / 30 / 90）+ 访问级别 |
| POST | /api/admin-contracts/certificates/:id/view | 登录 | 查看敏感档案，写访问日志 |
| GET | /api/admin-contracts/access-logs | 登录 | 访问日志（`?doc_type=&doc_id=`） |
| GET | /api/admin-contracts/dict | 登录 | 字典 |

**核心口径**
- **提醒不自动做事**：到期/付款/验收/押金返只生成任务进日历；**不自动改合同状态、不自动扣款、不自动续约**。
- **续签要依据**：`renewal_basis` 必填，`end_date` 必须晚于原到期日；续签后重排续约通知任务。
- **终止要原因**：终止后付款/验收/续约/到期提醒转 `waived`，**押金返还任务保留**（钱必须退）。
- **押金返还不可豁免**：必须实际退回或转抵扣并留凭证。
- **印章按公司独立授权**：`seal_grants` 按 `seal_id` + 人/角色/岗位 + `scope` + 有效期命中；未命中 400（admin 例外）。
- **用印绑最终版本**：申请时记 `contract_id` + `doc_hash`（合同当前版本指纹）；提交的 `doc_hash` 与当前版本不一致直接 400。
- **改正文即重核**：`POST versions` 会把该合同所有 `pending/approved` 申请置 `recheck_required=1` 并清空 `doc_hash`，此时 approve/use 双双 400。
- **登记用印再核一次**：`use` 时重新比对合同当前版本指纹，变了就转重核并拒绝。
- **回执不可省**：用印要 `receipt_no`、归还要 `return_receipt`；借章要 `expect_return_date`，逾期进日历并在列表标红。
- **敏感档案访问留痕**：`certificates.access_level='controlled'`（默认）时查看会写 `doc_access_logs`（谁/何时/什么/原因）。
- **归档保留**：合同归档不删除，只是不能再改、不能再用印。

## 流程超时升级与岗位 SOP（TS-N15-04 / TS-N15-02）

**看板与待办**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/process/board | 登录 | 总览：在办/超时/临近/无主/已升级、升级队列、最近提醒、代理、生效制度与待补签 |
| GET | /api/process/tasks | 登录 | 在办任务（`?level=overdue\|soon\|escalated\|no_owner`），**只算当前步** |
| POST | /api/process/tasks/:id/remind | admin,sales,finance,production | 发提醒；**同一任务同一级别只发一次**（dedupe） |
| POST | /api/process/tasks/:id/escalate | 同上 | 升级 `{escalated_to, reason}`：接手人必填且不能还是原角色，原因必填 |
| POST | /api/process/tasks/:id/receive | 同上 | 升级后接手人显式接单（避免「升级了没人认」） |
| POST | /api/process/tasks/:id/delegate | 同上 | 按代理授权转交 `{from_user, to_user}`；无有效授权 400 |
| POST | /api/process/scan | 同上 | 扫描在办任务，返回超时与无主清单（**不做任何自动审批**） |

**代理与 SLA**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/process/delegates | 登录 | 代理授权（带 `effective_status`：有效/已过期/已撤销） |
| POST | /api/process/delegates | admin,sales | 设代理 `{from_user, to_user, target_types, valid_from, valid_to, reason}` |
| POST | /api/process/delegates/:id/revoke | admin,sales | 撤销 `{reason}`；在办任务回到升级队列 |
| GET | /api/process/sla | 登录 | 各流程及各步时限与升级对象 |
| PUT | /api/process/sla/:flowId | admin | 改时限 `{sla_hours, steps:[{role,name,sla_hours,escalate_to}]}` |

**SOP / 制度**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/process/sop | 登录 | 制度清单（`?status=&position=&category=&q=`），带签收进度 |
| GET | /api/process/sop/:id | 登录 | 详情：四要素、版本历史、签收名单 |
| POST | /api/process/sop | admin,sales | 新建 `{title, category, position, company, owner, remark}` |
| POST | /api/process/sop/:id/versions | admin,sales | 写新版 `{doing, inputs, done_criteria, escalate_path, change_note}`，**四要素缺一项 400** |
| POST | /api/process/sop/:id/publish | admin,sales,finance,production | 批准生效 `{version, effective_date}`；旧版转 retired，按岗位生成签收 |
| POST | /api/process/sop/:id/retire | 同上 | 废止 `{reason}` |
| POST | /api/process/sop/:id/ack | 登录 | 岗位签收 `{employee_id, note}` |
| GET | /api/process/dict | 登录 | 字典 |

**核心口径**
- **待办不可失主**：主责优先级 `received_by > escalated_to > delegate_by > 角色在职账号`；角色无人在职且无代理 → `owner.kind='none'`，进升级队列。
- **超时绝不自动通过**：`taskView.can_auto_approve` 恒为 `false`；`escalate` 只改主责，不改 `status`，仍需有人审批。
- **截止计算**：第 1 步 = 流程创建时间 + SLA；第 N 步 = 第 N-1 步动作时间 + SLA。SLA 取 `step.sla_hours` > `flow.sla_hours` > 24h。
- **提醒去重**：`approval_reminders.dedupe_key = task:<id>:<level>` 唯一，重复提醒返回 400 并告知上次时间。
- **代理只按授权转交**：`delegate` 先查 `approval_delegates`（状态 active + 有效期 + 覆盖 `target_types`），不符合直接 400。
- **保留原责任**：代理/升级都写 `original_approver`，`escalate_reason` 里带原审批人与超时时长。
- **升级的人能审批**：`actTask` 允许 admin / 原角色 / `escalated_to` / `delegate_by` / `received_by`。
- **SOP 生效制**：只有 `status='effective'` 的版本是当前执行依据；发布要求四要素齐全；旧版转 `retired` 可查不可执行；废止必须写原因，废止后不能出新版本。
- **时间口径**：统一本地墙钟 `YYYY-MM-DD HH:mm:ss`（`services/sla.js` 是唯一来源，路由与审批服务共用）。

---

## 数据质量与业务勾稽（`/api/dq`）

> 勾稽规则只读不改数；修复由 `dq_fixes` 留痕。所有接口需登录，写操作限 `admin / sales / finance`。

**规则与执行**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/dq/rules | 登录 | 23 条规则（`desc` / `suggest` / `fixable` / `fix_key` / `enabled`） |
| PUT | /api/dq/rules/:code | admin | 启停规则 `{enabled}` |
| POST | /api/dq/run | admin,sales,finance | 执行勾稽 `{codes?:[], scope?:'all'\|'balance'\|'quality'}` |
| GET | /api/dq/runs?limit= | 登录 | 批次历史（含新增/已消除/复发/健康分） |
| GET | /api/dq/runs/:id | 登录 | 批次详情（按规则分组的问题） |
| GET | /api/dq/summary | 登录 | 总览：健康分、12 次趋势、按规则命中、计数、累计修复数 |

**问题处理**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/dq/issues | 登录 | `?status=open\|fixed\|ignored\|all &severity=&category=&rule_code=&keyword=` |
| POST | /api/dq/issues/:id/fix | admin,sales,finance | 单条自动修（`fixable=0` 直接 400） |
| POST | /api/dq/runs/:id/fix-all | 同上 | 批量修本批次全部可修项（逐条独立事务，互不影响） |
| POST | /api/dq/issues/:id/ignore | 同上 | 忽略 `{reason(≥4字), days?}`；到期自动重新生效 |
| POST | /api/dq/issues/:id/reopen | 同上 | 取消忽略/修复，恢复为 open |
| GET | /api/dq/fixes?limit= | 登录 | 修复留痕（修前修后 JSON + 操作人） |
| GET | /api/dq/export?status= | 登录 | 导出 CSV（带 BOM，Excel 直开不乱码） |

**三账对齐**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/dq/reconcile | 登录 | `?only=diff &keyword=` 逐单给出接单/入库/出库、订单额/已开票/已收款、差额与标记 |

**核心口径**
- **fingerprint** = `规则编码|对象类型:对象ID|字段`，唯一索引；跨批次复用同一条记录，只更新 `last_seen_at` / `seen_cnt`。
- **批次对比**：本次出现而上批没有 → `new_cnt`；上批有本次消失 → 转 `fixed` 并计入 `fixed_cnt`；曾修复又出现 → `recur_cnt`。
- **健康分** = `100 − min(35, 严重×3) − min(22, 关注×1) − min(6, 提示×0.25)`；`ignored` 不计扣分。
- **修复边界**：只有「由明细唯一推导」的字段可修 —— 库存结存、发票已收/已付、成本对象实际成本、采购表头金额、采购到货数、订单/款金额。涉及数量认定、单据归属、跨单调账的一律 `fixable=0`。
- **同类合并**：规则可设 `limit`（如到货缺凭证 6 条、应付缺票 5 条），超出部分汇总成一条「另有 N 条」，避免刷屏。
- **不阻断**：本模块不参与订单状态机与审批门禁，只出判定。

---

## 海外仓（美仓）作业（`/api/wh`）

> 三块：到仓上架 / 套装拆组 / 运费核对。写操作限 `admin / warehouse / sales`。

**总览与库位**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/wh/board | 登录 | 总览：在途柜数与件数、待上架、可售量、套装库存、短少/破损、运费待核 |
| GET | /api/wh/dict | 登录 | 字典：库区类型、ASN 状态、承运商 |
| GET | /api/wh/locations | 登录 | 库位 `?warehouse=us&zone=`，带库区中文名与上架累计 |
| POST | /api/wh/locations | admin,warehouse,sales | 新建 `{code, zone, aisle, capacity}` |
| PUT | /api/wh/locations/:id | 同上 | 改 `{status(active/locked), capacity, zone, remark}` |

**到仓与点收**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/wh/asns | 登录 | 发运单 `?status=&q=`，带状态中文名与明细行数 |
| GET | /api/wh/asns/:id | 登录 | 详情：明细、点收单、点收明细、上架落位 |
| POST | /api/wh/asns | admin,warehouse,sales | 新建 `{carrier, container_no, ship_date, eta_date, carton_plan, items:[{style_no,product_name,color,size,expect_qty}]}` |
| POST | /api/wh/asns/:id/ship | 同上 | 发运（draft→in_transit，记发运日） |
| POST | /api/wh/asns/:id/arrive | 同上 | 标记到仓（in_transit→arrived） |
| POST | /api/wh/asns/:id/cancel | 同上 | 取消 `{reason(≥4字)}`；已点收/已完成不能取消 |
| POST | /api/wh/asns/:id/receive | 同上 | 点收 `{arrive_date, carton_actual, note, items:[{asn_item_id, received_qty, damaged_qty, diff_reason}]}` |
| GET | /api/wh/receipts | 登录 | 点收单列表，带 `to_put`（待上架）与 `put_done` |
| GET | /api/wh/receipts/:id | 登录 | 点收单详情 + 可用库位 |
| POST | /api/wh/receipts/:id/putaway | admin,warehouse,sales | 上架 `{items:[{rcv_item_id, location_code, qty}]}` |

**套装**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/wh/bundles | 登录 | 套装列表，带组件、`stock_qty`（套装库存）、`can_kit`（可组装数） |
| POST | /api/wh/bundles | admin,warehouse,sales | 新建 `{bundle_sku, name, sale_price, items:[{style_no,color,size,qty_per}]}` |
| PUT | /api/wh/bundles/:id | 同上 | 改名称/售价/状态/组件（**有库存时不许改组件**） |
| POST | /api/wh/bundles/:id/kit | 同上 | 组装 `{qty, remark}`：组件齐套才放行，扣组件加套装 |
| POST | /api/wh/bundles/:id/unbundle | 同上 | 拆分 `{qty, remark}`：扣套装，组件按用量退回 |
| GET | /api/wh/bundle-ops | 登录 | 组装/拆分记录 `?bundle_id=&limit=` |

**运费核对**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/wh/freight/rates | 登录 | 费率列表 |
| POST | /api/wh/freight/rates | admin,warehouse,sales | 新建 `{carrier, zone, first_weight, first_price, add_weight, add_price, fuel_pct, effective_from}` |
| GET | /api/wh/freight/bills | 登录 | 账单 `?status=&carrier=` |
| GET | /api/wh/freight/bills/:id | 登录 | 账单 + 明细 |
| POST | /api/wh/freight/bills | admin,warehouse,sales | 新建并逐行核对 `{carrier, period_from, period_to, items:[{tracking_no, zone, weight, act_weight, bill_amount}]}` |
| POST | /api/wh/freight/bills/:id/match | 同上 | 重新核对（会补出「系统有账单无」的漏计费行） |
| POST | /api/wh/freight/items/:id/resolve | 同上 | 处理差异 `{status(accepted/disputed/ok), note(非 ok 必填≥4字)}` |
| POST | /api/wh/freight/bills/:id/settle | 同上 | 结算（有未处理差异 → 400） |

**核心口径**
- **数量守恒**：`short = max(0, 预报 − 实收 − 破损)`，`over = max(0, 实收 + 破损 − 预报)`；有 short/over 时 `diff_reason` 必填。
- **上架才可售**：`wh_locations.zone='sellable'` 才调 `applyStock` 加 `stock_items` 并写 `stock_ledger(type='in', ref_type='wh_receipt')`；其他区只写 `wh_putaways`。
- **套装库存独立**：`wh_bundle_stock` 表，不进 `stock_items`；组装写 `ledger(type='kit_out')`、拆分写 `ledger(type='kit_in')`。
- **可组装数** `can_kit = min(floor(组件库存 / 单套用量))`。
- **系统运费** = `首重价 + ceil((计费重 − 首重)/续重步长) × 续重价`，再 ×`(1 + 燃油%)`；计费重取 `act_weight > 0 ? act_weight : weight`。
- **差异判定优先级**：`missing`（查不到运单）→ `no_rate`（无费率）→ `weight`（计费重与实重差 >5%）→ `amount`（|差额| > max($1, 系统额×2%)）→ `ok`。
- **事务纪律**：所有行先校验完再 `BEGIN`，避免「事务内 return 留下半张单」。

---

## 总账与财务报表（`/api/gl`）

> 凭证由业务单据反推生成；写操作限 `finance / admin`，反关账仅 `admin`。

**期间与科目**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/gl/periods | 登录 | 会计期间（含中文标签、关账状态、是否当期）；当期不存在会自动补 |
| POST | /api/gl/periods | admin,finance | 建期间 `{period:'YYYY-MM'}` |
| GET | /api/gl/accounts | 登录 | 21 个会计科目（编码/名称/类型/余额方向） |

**凭证**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/gl/vouchers | 登录 | `?period=&source_type=&status=&q=` |
| GET | /api/gl/vouchers/:id | 登录 | 凭证 + 分录 |
| POST | /api/gl/vouchers | admin,finance | 手工凭证 `{period, biz_date, summary, entries:[{code,debit,credit,summary}]}`，**借贷不平 400** |
| POST | /api/gl/vouchers/:id/void | admin,finance | 作废 `{reason(≥4字)}`；已关账期间 400 |

**生成与结转**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/gl/periods/:period/generate | admin,finance | 从业务单据生成 `{force?, types?}`；幂等，已生成过跳过 |
| POST | /api/gl/periods/:period/carry | admin,finance | 损益结转（收入/费用 → 4103 本年利润） |

**关账**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/gl/periods/:period/checks | 登录 | 跑 8 项检查并落库 |
| POST | /api/gl/periods/:period/close | admin,finance | 关账（有 error 级检查不过 → 400，报文列出不过的项） |
| POST | /api/gl/periods/:period/reopen | admin | 反关账 `{reason(≥4字)}` |

**报表**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/gl/reports/trial-balance | 登录 | 试算平衡表 `?period=` |
| GET | /api/gl/reports/balance-sheet | 登录 | 资产负债表 |
| GET | /api/gl/reports/income | 登录 | 利润表 |
| GET | /api/gl/reports/cash-flow | 登录 | 现金流量表（直接法简易版） |
| GET | /api/gl/reports/:type/export | 登录 | 导出 CSV（带 BOM） |
| GET | /api/gl/overview | 登录 | 总览：收入/成本/净利/资产/现金/凭证数 + 6 期利润趋势 |

**核心口径**
- **凭证生成规则**：应收开票 `借1122/贷6001`；应付（有采购单）`借1403/贷2202`、（无采购单）`借6602/贷2202`；收款 `借1002/贷1122`；付款 `借2202|2211|2241 / 贷1002`；成本结转 `借6401/贷1405`；工资 `借6602/贷2211`；费用 `借6602/贷1002`；折旧 `借6602/贷1602`。
- **幂等键** `(source_type, source_id, period)` 唯一 —— 带期间，折旧/工资这类「同一对象每期一张」才不会被吞。
- **不平不落库**：`writeVoucher` 先校验借贷合计，超 0.01 直接抛错。
- **利润表排除 `source_type='profit_carry'`**：结转凭证会借收入贷本年利润，算进去收入费用互相抵平、净利润变 0。
- **备抵科目**：`type='asset' AND direction='credit'`（如 1602）在资产负债表里按负数计，从资产中扣除。
- **已结转期间不重复加利润**：有结转凭证时 `profit_unposted=0`（利润已在 4103 里）。
- **关账利润**：从 4103 本年利润当期贷方净额取（结转后利润表已归零）。
- **现金流量表**：以 1002 银行存款分录为起点，按对方科目归类 —— 1122/6001 经营流入；2202/2211/6601/6602/6603/1403 经营流出；1601/1602 投资活动。

---

## 现货库龄与退货（`/api/spot`）

> 库龄用出入库流水按 FIFO 反算，不建批次表；退货必须逐件判定。写操作限 `admin / warehouse / sales`。

**库龄与动销**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/spot/overview | 登录 | 总览：库存、平均库龄、90 天以上占比、近 90 天出库、整体周转、待处理退货 |
| GET | /api/spot/aging | 登录 | 库龄分布（四档）+ 按款汇总 + 每 SKU 批次明细（入库日期/剩余/库龄） |
| GET | /api/spot/turnover?days=90 | 登录 | 动销与周转：售罄率、周转天数、动销评级 |
| GET | /api/spot/slow-moving?min_age=60 | 登录 | 滞销清单 + 建议 |
| GET | /api/spot/dict | 登录 | 字典：退货类型、退货状态、库龄分档 |

**退货**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/spot/returns | 登录 | `?status=&q=` 退货单列表 |
| GET | /api/spot/returns/:id | 登录 | 详情 + 明细 + 可用库位 |
| POST | /api/spot/returns | admin,warehouse,sales | 新建 `{type, partner_name, source_no, reason, return_date, items:[{style_no,color,size,qty_apply}]}` |
| POST | /api/spot/returns/:id/receive | 同上 | 点收 `{items:[{item_id, qty_received}]}`；**实收 ≤ 申请**，合计必须 > 0 |
| POST | /api/spot/returns/:id/inspect | 同上 | 判定 `{items:[{item_id, qty_good, qty_defect, qty_scrap, good_location}]}`；**良品+次品+报废 = 实收** |
| POST | /api/spot/returns/:id/close | 同上 | 关单（必须已判定） |
| POST | /api/spot/returns/:id/cancel | 同上 | 取消 `{reason(≥4字)}`；已判定/已关单不能取消 |

**核心口径**
- **库龄（FIFO 反算）**：按 `stock_ledger.created_at` 顺序遍历，`qty > 0` 入批次，`qty < 0` 按先进先出冲最早批次，剩余批次 = 当前在库 + 入库日期。出库多于入库时记 `overflow`（说明该 SKU 早期入库没留流水）。
- **分档**：0-30 / 31-60 / 61-90 / 90+ 天，四档合计必须等于该仓总在库量。
- **平均库龄** = Σ(批次库龄 × 剩余量) ÷ 在库总量（按数量加权，不是简单平均）。
- **售罄率** = 累计出库 ÷ 累计入库；**周转天数** = 当前库存 ÷（近 N 天出库 ÷ N）。
- **动销评级**：`out` 已售罄 / `dead` 近 N 天零出库 / `slow` 周转 >180 天 / `watch` >90 天 / `good` 正常。
- **退货数量守恒**：`qty_received = qty_good + qty_defect + qty_scrap`，差一件都不让提交。
- **只有良品进库存**：`zone='sellable'` 才 `applyStock` 并写 `stock_ledger(type='in', ref_type='stock_return')`；次品与报废只记数量与备注，不写库存、不写流水。
- **状态机**：`draft` 待点收 → `received` 待判定 → `inspected` 已判定 → `closed` 已关单；`cancelled` 只能在判定前。

---

## AI 能力中心（`/api/ai`）

> AI 只产出**草稿与解释**，不写业务表。越权问题在调模型之前由代码守卫拦掉。写操作限业务岗位，网关与评测仅 `admin`。

**总览与网关**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/ai/overview | 登录 | 模式（ai/rule）、供应商、今日调用与成本、风险/草稿/周报/接管统计、最近评测 |
| GET | /api/ai/gateway | 登录 | 供应商列表（就绪判定、预算余量、数据级别、密钥是否配置） |
| POST | /api/ai/gateway | admin | 登记 `{code,name,vendor,base_url,model,key_env,data_scope,region,input_price,output_price,monthly_budget,timeout_ms,priority}` |
| PUT | /api/ai/gateway/:id | admin | 改名称/型号/预算/超时/优先级/状态；**启用时若环境变量无密钥 → 400** |
| POST | /api/ai/gateway/:id/test | admin | 连通测试（无密钥时返回 `mode=not_connected`，不假装成功） |
| GET | /api/ai/calls | 登录 | 调用审计 `?scene=&status=&limit=`，含降级/拦截原因 |

**问答与抽取**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/ai/ask | 登录 | 受守卫的业务问答 `{message}`；被拦时返回 `blocked=true, source='guard', tip` |
| POST | /api/ai/extract | 业务岗位 | 需求抽取 `{text(≥10字),source_type,source_id,source_label}` → 草稿（fields/missing/craft/confidence） |
| POST | /api/ai/reply | 业务岗位 | 客服建议答复 `{question,customer}` → 草稿（faq_hit / order / warning） |

**草稿**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/ai/drafts | 登录 | `?scene=&status=&limit=` |
| GET | /api/ai/drafts/:id | 登录 | 详情（payload/missing 已反序列化） |
| POST | /api/ai/drafts/:id/approve | 业务岗位 | 核准 `{applied_to,note}`；**需求草稿不填 `applied_to` → 400** |
| POST | /api/ai/drafts/:id/reject | 业务岗位 | 驳回 `{reason(≥4字)}` |

**异常解释**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/ai/anomalies | 登录 | 可解释异常（风险快照中的高/中 + 勾稽 open 的 error/warn） |
| POST | /api/ai/explain | 登录 | `{entity_type(order/dq_issue/receivable/purchase/approval), entity_id, entity_no, save}`；返回 `findings[].grade = read/draft` |

**风险预测**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/ai/risk/run | 业务岗位 | 全量扫描并落快照（返回 high/mid/low、by_role、by_type、unowned） |
| GET | /api/ai/risk | 登录 | `?level=&role=&status=open\|ack\|done\|all` |
| POST | /api/ai/risk/:id/ack | 业务岗位 | 认领或标记已处理 `{status:'ack'\|'done'}` |

**周报**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/ai/weekly/generate | 业务岗位 | `{week,scope(user/dept/company),subject}`；非 admin 只能生成自己的，部门/全公司仅 admin |
| GET | /api/ai/weekly | 登录 | 列表；非 admin 只能看到自己那份 |
| GET | /api/ai/weekly/:id | 登录 | 详情（七段结构）；看别人的 → 403 |
| POST | /api/ai/weekly/:id/publish | 业务岗位 | 发布（只能发自己的） |

**客服 FAQ 与接管**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/ai/faq | 登录 | `?status=&q=` |
| POST | /api/ai/faq | 业务岗位 | 新建（问题≥4字、答案≥6字），初始 `draft` |
| PUT | /api/ai/faq/:id | 业务岗位 | 改或改状态；**自己写自己批 → 400**（admin 例外） |
| GET | /api/ai/handovers | 登录 | 接管会话列表 |
| POST | /api/ai/handovers | 业务岗位 | 转人工 `{question,trigger_reason(≥4字),customer,channel}` |
| POST | /api/ai/handovers/:id/take | 业务岗位 | 接管（重复接管 400） |
| POST | /api/ai/handovers/:id/close | 业务岗位 | 关单 `{summary(≥4字)}` |

**评测**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/ai/evals/cases | 登录 | 14 条基准（编号/期望类型/敏感词/风险级别） |
| POST | /api/ai/evals/run | admin | 跑一轮 `{mode:'rule'\|'ai'}`；返回 passed/leak_cnt/over_block/gate |
| GET | /api/ai/evals/runs | 登录 | 批次列表 |
| GET | /api/ai/evals/runs/:id | 登录 | 明细（逐条答案与失败原因） |

**核心口径**
- **数据分级**：`public < internal < restricted`。场景敏感级由 `SCENES` 决定（`weekly` = restricted）；供应商 `data_scope` 必须 ≥ 场景级别才可路由。
- **模型可用** = `status='enabled'` **且** 环境变量有密钥 **且** 预算未用尽 **且** 数据级别够。任一不满足即降级规则，并在 `ai_calls.reason` 写明原因。
- **成本** = `tokens_in/1000×input_price + tokens_out/1000×output_price`，累加进 `ai_providers.used_amount`。
- **守卫优先级**：高风险动作 > 敏感主题×岗位 > 跨主体 > 放行。被拦的请求 `status='blocked'` 落库，**不调模型**。
- **草稿不落业务表**：核准只改 `ai_drafts.status` 与 `applied_to`，业务数据仍需在对应页面按流程创建。
- **周报扣分口径**：只统计 `confirmed_score > 0` 且无未结申诉的项；`review_status` 未确认的进「待复核建议」。

---

## 预算管理（`/api/budget`）

> 预算只管「能不能花钱」，不改业务单据本身。超支拦在单据提交前。写操作限 `admin / finance / sales`，审批与生效仅 `admin / finance`（生效仅 admin）。

**字典与查询**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/budget/dict | 登录 | 部门、**期间费用科目（只 66xx）**、年度列表、状态、调整类型 |
| GET | /api/budget/overview | 登录 | `?period=YYYY-MM` 概览：当年预算、合计（预算/已发生/已占用/可用/执行率）、按部门、待确认超支、未归部门费用 |
| GET | /api/budget/list | 登录 | `?year=&status=` 预算版本列表 |
| GET | /api/budget/execution | 登录 | `?period=&department_id=&only_diff=1` 执行明细（含 flag: over/near/fast/ok） |
| GET | /api/budget/commitments | 登录 | `?status=open&period=` 占用清单 |
| GET | /api/budget/alerts | 登录 | `?status=&period=` 超支留痕 |

**编制与生命周期**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/budget | admin,finance,sales | 新建编制 `{fiscal_year,name,tolerance_pct,items:[{department_id,account_code,period,amount}]}` |
| GET | /api/budget/:id | 登录 | 详情（含每项当前执行） |
| PUT | /api/budget/:id | admin,finance,sales | 改名称/容忍比例/明细；**非编制中的预算改明细 → 400** |
| DELETE | /api/budget/:id | admin | 删除（仅 draft/rejected/approved；有未释放占用或未驳回调整单 → 400） |
| POST | /api/budget/:id/approve | admin,finance | 批准（编制人本人 → 400，admin 例外） |
| POST | /api/budget/:id/reject | admin,finance | 驳回 `{reason(≥4字)}` |
| POST | /api/budget/:id/activate | admin | 生效（同年度旧的自动关闭） |
| POST | /api/budget/:id/close | admin | 关闭 |

**调整单**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/budget/adjustments/list | 登录 | `?status=&budget_id=` |
| POST | /api/budget/adjustments | admin,finance,sales | 申请 `{budget_id,type(increase/decrease/transfer),from_*,to_*,period,amount,reason(≥8字)}` |
| POST | /api/budget/adjustments/:id/approve | admin,finance | 批准并落地；**调减后为负 → 400 整体回滚** |
| POST | /api/budget/adjustments/:id/reject | admin,finance | 驳回 `{reason(≥4字)}` |

**超支与预检**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/budget/alerts/:id/ack | admin,finance,sales | 确认超支 `{note(≥4字)}` |
| POST | /api/budget/check | 登录 | 花钱前预检 `{department_id,account_code,period,amount}`，返回 ok/code/message |

**核心口径**
- **预算 = `budget_items`（部门 × 科目 × 月份）**；只有 `status='active'` 的预算参与控制。
- **已发生** = `gl_entries` 同 `period + account_code + department_id` 的「借 − 贷」。
- **已占用** = `budget_commitments(status='open')`：单据已提交未入账，先按住额度；凭证生成后自动转 `consumed`，避免与已发生重复计。
- **可用 = 预算 − 已发生 − 已占用**。
- **检查顺序**：科目必须是 66xx → 部门必须填（未填则跳过，不进预算）→ 期间未关账 → 取格子额度。
- **三档超支**：容忍比例内放行（`within_tolerance`）；超容忍但写了说明（≥8字）特批放行（`over_budget`）；否则 400。
- **未编预算 = 额度 0**：预算生效后该格子没编就硬拦。
- **`budget_items` 唯一键** `(budget_id, department_id, account_code, period)`，写入用 `ON CONFLICT DO UPDATE` 幂等。
- **生效互斥**：同 `fiscal_year` 只有一份 `active`，`activate` 时把旧的置 `closed`。

---

## 税票银行与结算（`/api/bank`）

> 只核对不改账：匹配只建立关联、对账只出调节表。写操作限 `admin / finance`，账户维护仅 `admin`。

**字典与概览**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/bank/dict | 登录 | 账户、账户类型、票据状态、匹配状态、CSV 格式提示 |
| GET | /api/bank/overview | 登录 | 资金概览：各账户账面/银行余额、未匹配数、末次对账、票据汇总 |

**账户**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/bank/accounts | 登录 | 账户列表 |
| POST | /api/bank/accounts | admin | 新建 `{account_no,bank_name,account_masked,currency,account_type,open_balance,open_date}` |
| PUT | /api/bank/accounts/:id | admin | 改账户；**已有流水或已确认对账时改期初余额 → 400** |

**流水与匹配**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/bank/imports | 登录 | 导入批次列表 |
| POST | /api/bank/import | admin,finance | 导入 `{account_id,source_name,csv}` 或 `{lines:[...]}`；重复自动去重 |
| GET | /api/bank/lines | 登录 | `?account_id=&period=&status=&q=`；返回 `{rows, stat}` |
| GET | /api/bank/lines/:id/candidates | 登录 | `?days=` 匹配候选（带 score 与 why） |
| POST | /api/bank/lines/:id/match | admin,finance | 手工匹配 `{payment_id}`（校验方向/金额/占用） |
| POST | /api/bank/lines/:id/unmatch | admin,finance | 取消匹配 |
| POST | /api/bank/lines/:id/ignore | admin,finance | 忽略 `{reason(≥4字)}`；**仍计入对账未达账项** |
| POST | /api/bank/auto-match | admin,finance | 自动匹配 `{account_id,days}` → `{matched,ambiguous,none}` |

**对账**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/bank/reconcile/preview | 登录 | `?account_id=&period=&statement_balance=` 调节表预览（不落库） |
| GET | /api/bank/reconciliations | 登录 | 对账历史 |
| GET | /api/bank/reconciliations/:id | 登录 | 明细（含未达账项） |
| POST | /api/bank/reconciliations | admin,finance | 生成对账（同账户同期已有确认记录 → 400） |
| POST | /api/bank/reconciliations/:id/confirm | admin,finance | 确认；**差额不为 0 → 400** |

**票据**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/bank/bills | 登录 | `?type=receivable\|payable&status=`；带 `days_left` / `urgent` / `overdue` |
| POST | /api/bank/bills | admin,finance | 登记 `{bill_no,type,accept_type,amount,issue_date,due_date,...}` |
| PUT | /api/bank/bills/:id/status | admin,finance | 状态流转 `{status,discount_rate?,discount_cost?,cash_in_date?}` |

**核心口径**
- **去重指纹** = `sha1(账户|日期|方向|金额|对方|摘要)`，`UNIQUE`；同一份对账单导两次不会翻倍。
- **匹配候选**：金额必须严格一致（<0.01）才进候选；打分 = 金额 40 + 方向 20 + 日期 30/20/10 + 对方名称 20。
- **自动匹配门槛**：得分 ≥ 70 **且**没有并列第一，否则留给人。
- **账面余额** = 账户期初 + 截至期末有效收付款净额（`status IN ('valid','confirmed') AND reversed_at IS NULL`）；只有一个启用账户时，未指定账户的收付款归它。
- **银行余额** = 该账户期间内最后一条带 `balance` 的流水；没有则按「期初 + 流水累计」推算并提示。
- **对账恒等式**：`银行余额 + book_only_in/out = 账面余额 + bank_only_in/out`，两边不等则 `diff_amount ≠ 0`，禁止确认。
- **票据状态机**：应收 `holding → collected/discounted/endorsed/settled/void`、`collected → settled`；应付 `holding → settled/void`；跳步 400，贴现必须填贴现率。

---

## 多主体核算与集团合并（`/api/group`）

> 每家主体一套账、各自关账；合并 = 加总 − 抵消，差额不抹平。写操作限 `admin / finance`，删除与注销仅 `admin`。

**总览与主体**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/group/overview | 登录 | 主体数（按总部/分公司/子公司）、合并范围、内部往来单位数、**最近一个有差异期间**的差异笔数与金额、末次合并 |
| GET | /api/group/companies | 登录 | `?status=active\|closed\|all`，带凭证数/已关账期间数/部门数/账号数 |
| GET | /api/group/companies/:id | 登录 | 详情 + 该主体的期间列表、部门、账号 |
| POST | /api/group/companies | admin,finance | 新建 `{code,name,type,tax_no,base_currency,parent_id,open_period,consolidation}` |
| PUT | /api/group/companies/:id | admin,finance | 改名称/类型/税号/本位币/上级/合并标记/状态 |

**内部往来单位**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/group/parties | 登录 | `?company_id=` 内部往来单位（本方 + 对方 + 单据上的名称 + 抵消科目） |
| POST | /api/group/parties | admin,finance | 登记 `{company_id, counter_company_id, kind(customer/supplier/both), ref_name, offset_account}` |
| PUT | /api/group/parties/:id | admin,finance | 改类型/名称/科目/启停 |

**内部往来对账**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/group/intercompany | 登录 | `?period=&status=` 配对结果 + matched/diff/diff_amount 汇总 |
| POST | /api/group/intercompany/scan | admin,finance | 重新配对 `{period}`；**自动生成的会先清掉重来**（手工的不动） |
| POST | /api/group/intercompany/:id/ignore | admin,finance | 忽略差异 `{reason(≥4字)}` |

**合并**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/group/consolidations | 登录 | `?limit=` 合并历史 |
| GET | /api/group/consolidations/:id | 登录 | 详情（加总/抵消/合并后 + 抵消分录明细） |
| POST | /api/group/consolidations | admin,finance | 生成 `{period}`；返回 `balanced` / `diff_amount` / `ic_diff_cnt` |
| POST | /api/group/consolidations/:id/confirm | admin,finance | 确认；**差额不为 0 → 400**（报文给出排查方向） |
| DELETE | /api/group/consolidations/:id | admin | 删草稿；已确认 → 400 |
| GET | /api/group/consolidations/:id/export | 登录 | 导出 CSV（带 BOM，含三段） |

**分部对比与字典**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/group/segments | 登录 | `?period=` 各主体资产/负债/权益/现金/收入/净利/净利率/账套状态 + 合计 |
| GET | /api/group/dict | 登录 | 主体类型、状态、启用主体、常用科目 |

**总账接口的主体参数**
`/api/gl/*` 全部支持 `?company_id=`（写操作也接受 body 里的 `company_id`），不传则落**默认主体**（总部优先）。
- `/api/gl/periods?company_id=all` 返回全部主体的期间（带 `company_name`）
- 报表导出文件名带主体：`gl-income-2026-09-c2.csv`

**核心口径**
- **账套隔离**：凭证号 `(company_id, voucher_no)` 唯一，每家都从 `记-YYYYMM-0001` 起；期间 `(company_id, period)` 唯一，各自关账；余额快照 `(company_id, period, account_code)`。
- **幂等键** `(company_id, source_type, source_id, period)` —— 加 company_id 之后两家公司同源单据才不会互相顶掉。
- **内部往来识别**：凭证分录的 `partner_name` 命中 `intercompany_parties.match_key` / `ref_name`。
  - A 侧（债权）：1122/1221 借方净额
  - B 侧（债务）：2202/2241 贷方净额
  - 差额 = 债权 − 债务，非 0 记 `status='diff'`
- **内部交易抵消**：收入侧 6001/6051 贷方净额，成本侧 1403/1405/6401/6602 借方净额，**取两者较小值**抵消。
- **合并差额** = 合并资产 −（合并负债 + 合并权益）。取小抵消是等额双边抵消，正常情况下恒为 0；非 0 说明某主体单体报表本身不平。
- **IC 差异 ≠ 报表不平**：内部往来两侧不等时，报表照样平衡，但金额虚增。所以页面上「是否平衡」与「IC 差异笔数」是**两个独立指标**，都要看。

---

## 经营驾驶舱（`/api/cockpit`）

> 账龄 / 现金预测 / 经营指标 / 预测回看。写操作限 `admin / finance`。**只算有依据的钱，不预测未签订单。**

**总览与字典**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/cockpit/overview | 登录 | `?period=&company_id=` 核心指标、应收应付账龄摘要、末次现金预测、**预警清单**（每条带处理建议） |
| GET | /api/cockpit/dict | 登录 | 账龄分档、默认回收率、启用主体、现金流类别 |

**账龄**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/cockpit/aging | 登录 | `?kind=ar\|ap &as_of= &company_id= &exclude_ic=1` 五档账龄 + 按对方汇总 + 逐单明细 |

**现金预测**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/cockpit/forecasts | 登录 | `?limit=` 预测历史（**按基准日排序**） |
| GET | /api/cockpit/forecasts/:id | 登录 | 详情 + 逐周明细（含每周流入/流出构成与依据） |
| POST | /api/cockpit/forecasts | admin,finance | 生成 `{base_date,weeks(4-52),company_id,collect_rate(0-100),overdue_rates,note}` |
| DELETE | /api/cockpit/forecasts/:id | admin | 删批次（跑错了要能删） |
| GET | /api/cockpit/forecasts/:id/variance | 登录 | 回看：预计 vs 实际，`past_weeks` / `accuracy` / `no_actual_data` |

**经营指标**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/cockpit/kpis | 登录 | `?period=&company_id=` 17 项指标，每项带 `caliber`（口径说明）与 `sample_note` |
| POST | /api/cockpit/kpis/snapshot | admin,finance | 落快照 `{period,company_id}` |
| GET | /api/cockpit/trend | 登录 | `?months=12&company_id=` 近 N 月收入/成本/净利/现金/应收/应付 |

**核心口径**
- **账龄双口径**：`age_days` = 基准日 − 开票日；`overdue_days` = 基准日 − 到期日。**分档按 overdue 分**（账期长的正常单不该被误判成老账）。
- **默认剔除集团内部往来**（`exclude_ic=1`）：命中 `intercompany_parties.ref_name` 应收应付不计入。返回 `ic_excluded_count` / `ic_excluded_amount` 明示剔除了多少。
- **现金预测入账逻辑**：
  - 应收按 `due_date` 归周；逾期按档打折（`DEFAULT_OVERDUE_RATES`），并按档**摊到第 1/3/5/8 周**——老账不会下周就回来
  - 应付按 `due_date` 归周，**全额不打折**；逾期 30 天内摊第 1 周、超过摊第 3 周
  - 工资 = 近 3 期月均，每月 10 日；固定费用 = 预算 66xx 月均，每月 15 日
  - **未签订单不预测**
- **首次转负周 vs 最低点**：`first_neg_week` 是「哪周开始断」，`min_week` + `gap_amount` 是「最惨到多少」，两者都记。
- **小样本保护**：日均收入或成本 < 500 元时，`gross_margin / net_margin / ar_days / ap_days / inv_days / cash_cycle` 返回 `null`（前端显示「—」），并在 `sample_note` 说明原因。
- **回看不跳周**：所有周次都参与对比，**没有预测明细的周也要统计实际收付款**，否则达成率被系统性低估。
- **趋势空月份**：`income` 与 `expense` 同时为 0 时不画 0 高柱，前端标记「无」——区分「没数据」和「零收入」。

## 营销与素材（`/api/mkt`）

> 上新日历 / 品牌素材与授权 / 活动预算与效果 / 运营复盘。读开放给业务角色，写限 `admin / sales / tech`，活动预算批准与到期清扫限 `admin / finance`。
> **上新只做依赖校验，不回写开发单、订单或库存状态。**

**字典与汇总**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/mkt/dict | 登录 | 渠道、主体、客户、任务/素材/活动/复盘状态与分类、币种 |
| GET | /api/mkt/overview | 登录 | 任务按状态计数、逾期与 7 天内到期、素材可用/待审/到期、活动超预算、复盘逾期行动项 |

**上新任务（N16-01）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/mkt/tasks | 登录 | `?status=&channel=&owner=&month=&q=&overdue=1&company_id=` |
| GET | /api/mkt/calendar | 登录 | `?month=YYYY-MM` 按计划上线日铺开的日历数据（`by_date`） |
| GET | /api/mkt/tasks/:id | 登录 | 详情：三项门槛实时计算、步骤、已绑素材（含不可用原因）、流转记录、可推进状态 |
| POST | /api/mkt/tasks | admin,sales,tech | `{title,biz_type:stock\|custom,style_no,channel,shop_name,customer_id,campaign_id,plan_launch_date,owner,depends}` |
| PUT | /api/mkt/tasks/:id | admin,sales,tech | 改基础字段（换客户会校验已绑专属素材是否仍合规） |
| POST | /api/mkt/tasks/:id/status | admin,sales,tech | `{to,note,launch_date}` 推进/退回；退回必须写原因 |
| DELETE | /api/mkt/tasks/:id | admin | 只允许未上新的任务 |
| POST | /api/mkt/tasks/:id/steps | admin,sales,tech | 加步骤 `{name,owner,due_date}` |
| POST | /api/mkt/tasks/:id/steps/:sid | admin,sales,tech | `{status:pending\|doing\|done}` |
| POST | /api/mkt/tasks/:id/assets | admin,sales,tech | 绑素材 `{asset_id,role}`，**授权不符直接 400** |
| DELETE | /api/mkt/tasks/:id/assets/:aid | admin,sales,tech | 解绑 |

**品牌素材（N16-02）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/mkt/assets | 登录 | `?kind=&status=&scope=&style_no=&customer_id=&q=&expiring=1&days=30` |
| GET | /api/mkt/assets/:id | 登录 | 详情 + 被哪些任务引用 |
| POST | /api/mkt/assets | admin,sales,tech | `{title,kind,version,style_no,tech_version,scope,customer_id,channels,license_source,license_from,license_to,url}` |
| PUT | /api/mkt/assets/:id | admin,sales,tech | **已审核通过的不许改**，要改请建新版本 |
| POST | /api/mkt/assets/:id/submit | admin,sales,tech | 草稿 → 待审（AI 生成必须填 `tech_version`） |
| POST | /api/mkt/assets/:id/review | admin,sales,tech | `{pass,note}` 通过/驳回，驳回必写原因 |
| POST | /api/mkt/assets/:id/revoke | admin,sales,tech,finance | `{note}` 作废（撤授权、侵权投诉） |
| POST | /api/mkt/assets/sweep-expired | admin,finance | 把已过期仍标 `approved` 的落库成 `expired` |
| DELETE | /api/mkt/assets/:id | admin | 只允许草稿或已作废、且无任务引用 |

**活动投放（N16-03）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/mkt/campaigns | 登录 | `?status=&currency=&channel=&company_id=` 含执行率与超预算标记 |
| GET | /api/mkt/campaigns/:id | 登录 | 详情 + 账单 + 挂靠任务 + **实时归因** |
| POST | /api/mkt/campaigns | admin,sales,tech | `{name,currency,budget_amount,start_date,end_date,attribution_days(0-90),channel,shop_name,owner,note}` |
| PUT | /api/mkt/campaigns/:id | admin,sales,tech | 只有草稿能改预算与周期 |
| POST | /api/mkt/campaigns/:id/approve | admin,finance | 批准（须有起止日期） |
| POST | /api/mkt/campaigns/:id/status | admin,sales,tech | `{to}` 草稿→批准→投放→已账单→复核关闭；超预算关闭必须写说明 |
| POST | /api/mkt/campaigns/:id/bills | admin,sales,tech | `{bill_date,amount,currency,vendor,ref_no,source}` **币种必须与活动一致** |
| GET | /api/mkt/campaigns/:id/attribution | 登录 | 计入订单、三类剔除（未确认/内部转单/渠道不符）、ROAS、本币毛利 |

**运营复盘（N16-04）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/mkt/reviews | 登录 | `?status=&period=&category=&owner=` 含行动进度与逾期数 |
| GET | /api/mkt/reviews/:id | 登录 | 详情 + 行动项（含逾期标记） |
| POST | /api/mkt/reviews | admin,sales,tech | `{topic,period,category,evidence,owner,due_date,findings}` 必须填证据或关联单据 |
| POST | /api/mkt/reviews/:id/actions | admin,sales,tech | `{action,owner,due_date}` **负责人与期限都必填** |
| POST | /api/mkt/reviews/:id/actions/:aid | admin,sales,tech | `{status,result}` 标记完成必须写结果 |
| POST | /api/mkt/reviews/:id/status | admin,sales,tech | `{to}` 草稿→待行动→执行中→关闭；有未完成行动项不许关闭 |

**报表**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/mkt/reports/launch | 登录 | `?month=` 按期/延期上新数与达成率（按月、按渠道） |
| GET | /api/mkt/reports/campaign | 登录 | 按币种汇总的预算/已发生/归因收入/ROAS（**不做跨币种合计**） |
| GET | /api/mkt/reports/review | 登录 | 原因分类分布、行动项闭环率与逾期数 |

**核心口径**
- **三项门槛（不通过不许上新）**
  - `asset` 素材：至少 1 个可用素材（审核通过且在授权期内），所有任务都要求
  - `tech` 技术：`biz_type=custom` 时要有开发单且 `status=confirmed`；现货不要求
  - `stock` 到仓：`biz_type=stock` 时该款号可售库存 > 0；定制按单生产不要求
  - 门槛只是**检查依赖**：`mkt_tasks` 不动 `tech_packs` / `orders` / `stock_items`
- **素材授权三条硬规则**
  - `scope=exclusive` 必须绑客户；绑到别的客户的任务直接拒
  - `scope=channel` 的任务渠道必须在 `channels` 里
  - `license_to` 已过 → 有效状态即 `expired`，不可绑、不可上新（`approved` 也按过期算）
  - `license_source=ai` 必须填 `tech_version`，且只能停在草稿等人审
- **归因剔除两类假增长**
  - 未确认销售：订单未到 `assigned`（还在 draft/tech/finance）
  - 集团内部转单：客户命中 `intercompany_parties`（`kind=customer/both`，按 `ref_id` 或 `ref_name`）
  - 渠道不符：订单 `shop_name` ≠ 活动的 `shop_name`（未填店铺时按 `channel` 匹配）
- **币种**：活动、账单、归因收入三者同币种；汇总按 `currency` 分组，**不做跨币种求和**。`attributed_gross_cny` 来自成本对象结转，**是毛利不是净利润**。

## 制度问答（`/api/ai/policy`，M17 N17-02）

> 答案必须带**制度原文版本与生效日期**。只检索现行有效版本；草稿与已废止不作为依据；查不到就明确拒答。
> 引用行由服务端拼（`citeLine`），不经过模型。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/ai/policy/recent | 登录 | `?limit=8` 现行有效制度（只列 `effective`，带版本数与生效日） |
| GET | /api/ai/policy/search | 登录 | `?q=` 检索（含草稿/废止，便于解释「为什么不能引」），返回 `hits` / `weak` / `invalid` / `confidence` |
| POST | /api/ai/policy/ask | 登录 | `{question(≤500 字), use_model=true}` 作答 |
| GET | /api/ai/policy/hits | 登录 | `?limit=&actor=&doc_no=` 引用留痕，`outdated=true` 表示引的是旧版 |
| GET | /api/ai/policy/doc/:docNo | 登录 | 制度原文 + 全部版本历史 + 已签收人数 |

**作答返回结构**
```json
{
  "answer": "【考勤与请假管理制度】V2（制度）\n1. 3 天以上须部门负责人与人事经理共同审批\n\n——引用：《考勤与请假管理制度》V2，（DOC2026…），2026-03-01 生效，责任人 人事-张敏",
  "citations": [{ "doc_no": "DOC…", "title": "…", "version": 2, "effective_date": "2026-03-01",
                  "owner": "人事-张敏", "coverage": 42.86, "citable": true, "cite": "《…》V2，（DOC…），2026-03-01 生效，责任人 人事-张敏" }],
  "basis": [{ "doc_no": "…", "field": "做法", "text": "3 天以上须部门负责人与人事经理共同审批" }],
  "confidence": "high|medium|none",
  "answerable": true,
  "generated_by": "rule|model",
  "invalid": [{ "title": "…", "status": "draft|retired", "status_label": "草稿|已废止", "retire_reason": "…" }],
  "logged": { "saved": 1 }
}
```

**口径**
- **只取现行版本**：`status='effective'` 且 `version = current_version`；`citable` 要求同时有 `version` 与 `effective_date`，缺一即为不可引用
- **摘录不改写**：`basis.text` 是原文切句（按 `。；` 切），问句里的「数字+单位」优先命中对应条款
- **模型只串接**：给模型的 prompt 只有 `basis` 的句子，并要求「只能用原文里的条件、金额、天数、岗位」；引用行随后由服务端追加
- **拒答也要说清**：无命中时 `answerable=false`，`invalid` 列出草稿/废止制度及其原因，`weak` 列沾边但不具体的
- **命中门槛**：① 标题命中且 bigram 覆盖 ≥34%；② 或正文命中 ≥2 处且覆盖 ≥40%（`年假`这类只在正文出现的词靠第②条）
- **留痕**：每次引用写 `ai_policy_hits`；制度改版后 `outdated = cited_version < current_version`

**与通用问答的关系**：`POST /api/ai/ask` 会先查制度，命中覆盖 ≥40% 直接走制度通道（返回 `answered_by='policy'`，`source` 仍为 `rule`）；否则在答案末尾追加「制度依据」。

## 组织编制与岗位（`/api/org`，M02）

> 岗位与编制 / 任职关系 / 交易路线 / 主体视图授权。读开放给所有业务角色，写限 `admin / sales`（人事），批准限 `admin / finance`。

**字典与汇总**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/org/dict | 登录 | 公司、部门、员工、岗位、序列/任职类型/路线类型/字段范围/汇总范围 |
| GET | /api/org/overview | 登录 | 编制与在职、空缺与超编、待批任职、路线状态、授权到期情况、按公司汇总 |
| GET | /api/org/my-scope | 登录 | 当前账号的数据范围（admin 返回 `all`，其他人读生效授权） |

**岗位与编制（N02-02）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/org/positions | 登录 | `?company_id=&department_id=&status=&sequence=&q=` |
| GET | /api/org/positions/tree | 登录 | `?company_id=` 汇报树（按 reports_to 挂） |
| GET | /api/org/positions/:id | 登录 | 编制/在职/空缺/超编、在岗人员、汇报链、下级岗位 |
| POST | /api/org/positions | admin,sales | `{title,company_id,department_id,sequence,grade,headcount,reports_to_id,effective_from}` |
| PUT | /api/org/positions/:id | admin,sales | 改编制/汇报；`force=1` 才允许把编制压到在职以下；有在职不许关闭 |

**任职关系（N02-02）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/org/employments | 登录 | `?status=&company_id=&employee_id=&position_id=&q=` |
| GET | /api/org/employments/:id | 登录 | 详情 + `headcount_check`（批准后是否超编）+ 调岗来源 + 可推进状态 |
| POST | /api/org/employments | admin,sales | `{employee_id,employer_company_id,service_company_id,position_id,employment_type,start_date,end_date,reason}` |
| POST | /api/org/employees/:id/transfer | admin,sales | 调岗 `{position_id,start_date,reason}` → 生成待批新任职（旧任职批准后才结束） |
| POST | /api/org/employments/:id/submit | admin,sales | 草稿 → 待批 |
| POST | /api/org/employments/:id/approve | admin,finance | `{over_headcount,over_reason}` 批准（占编）；**不能批自己起草的** |
| POST | /api/org/employments/:id/reject | admin,finance | `{reason}` 驳回 |
| POST | /api/org/employments/:id/end | admin,sales,finance | `{end_date}` 结束任职（保留历史，不是删除） |

**交易路线（N02-03）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/org/routes | 登录 | `?status=&biz_type=` 带六个角色主体名与 `sign_mismatch` |
| GET | /api/org/routes/:id | 登录 | 详情 + 卖方名下订单数（只对照，不改单） |
| POST | /api/org/routes | admin,sales,finance | 六个角色；**签约≠卖方必须有服务协议** |
| PUT | /api/org/routes/:id | admin,sales,finance | 已确认的不许改主体 |
| POST | /api/org/routes/:id/confirm | admin,finance | 确认：缺任一必填主体或许可协议一律拒 |
| POST | /api/org/routes/:id/status | admin,finance | `{status: draft\|pending_terms\|disabled, note}` 停用必须写原因 |

**主体视图与授权（N02-04）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/org/scopes | 登录 | `?status=&user_id=` |
| GET | /api/org/scopes/:id | 登录 | 详情 + 可推进状态 |
| POST | /api/org/scopes | admin,sales,finance | `{user_id,company_ids,field_scope,aggregate_scope,expires_at,reason}` |
| POST | /api/org/scopes/:id/submit | admin,sales,finance | 草稿 → 待批 |
| POST | /api/org/scopes/:id/approve | admin,finance | 批准（**不能自批**）；批完旧的有效授权置为已到期 |
| POST | /api/org/scopes/:id/reject | admin,finance | `{reason}` |
| POST | /api/org/scopes/:id/renew | admin,sales,finance | `{expires_at,...}` 续期：旧记录到期 + 新单待批 + 版本 +1 |
| POST | /api/org/scopes/sweep | admin,finance | 把过期仍标「有效」的置为失效 |
| DELETE | /api/org/scopes/:id | admin | 只允许草稿或已驳回 |

**核心口径**
- **一人一条生效任职**：应用层提示 + 数据库 `UNIQUE INDEX ... WHERE status='effective'` 双保险
- **编制在批准时占用**：起草只算 `headcount_check`；满编必须 `over_headcount` + `over_reason` 同时具备
- **换岗留历史**：新任职批准时旧任职置 `ended`（结束日 = 新开始日前一天），不覆盖原记录
- **岗位归属 = 雇佣公司**：岗位属于 A 公司就不能挂在 B 公司的雇佣上（技术部服务各公司靠 `service_company_id` 表达，不是靠挪岗位）
- **三流一致**：签约方 ≠ 卖方 → 服务协议必填；确认时再校验六个角色齐全
- **授权**：必须有到期日、必须写用途、集团汇总至少两家公司、申请人与批准人不同人、到期自动失效

## 税负测算（`/api/tax`，M12）

> 按「主体 × 税区 × 期间」测算增值税/附加税/所得税/出口退税。**税率来自税政配置，没有配置不许测算**；测算不等于已申报。

**字典与概览**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/tax/dict | admin,finance | 主体、税区、税种、批次状态 |
| GET | /api/tax/overview | admin,finance | 各主体当期税负、待确认批次、未配税率主体 |

**税政配置**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/tax/policies | admin,finance | `?company_id=&tax_region=&status=` |
| POST | /api/tax/policies | admin,finance | `{company_id,tax_region,tax_type,rate,price_includes_tax,effective_from,effective_to,policy_no}` —— 新增时旧的生效记录自动置 `superseded` |

**测算**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/tax/preview | admin,finance | `?company_id=&tax_region=&period=YYYY-MM` 预览（不落库），返回每项 `formula` / `source` 与 `warnings` |
| POST | /api/tax/runs | admin,finance | 保存为草稿；同一期间已有确认版时拒绝 |
| GET | /api/tax/runs | admin,finance | `?company_id=&tax_region=&period=&status=` |
| GET | /api/tax/runs/:id | admin,finance | 明细 + 当时税率快照 `policy` |
| POST | /api/tax/runs/:id/confirm | admin,finance | 内部确认这一版（**不代表已申报**） |
| POST | /api/tax/runs/:id/void | admin,finance | `{reason}` 作废必须写原因 |
| GET | /api/tax/runs/:id/export | admin,finance | 导出申报底稿 CSV（带 BOM） |
| GET | /api/tax/trend | admin,finance | `?company_id=&tax_region=&months=6` 每期只取最新一版 |

**核心口径**
- **销项** = 内销收入（不含税）× 增值税率；**进项** = 采购收票（含税）÷ (1+税率) × 税率
- **应纳增值税** = `max(0, 销项−进项)`；差额记 `credit_carry`（留抵，结转下期，**不是退税**）
- **附加税** = 应纳增值税 × 附加税率（**基数不是销项**）
- **企业所得税** = `max(0, 利润总额)` × 所得税率（亏损为 0，可结转）
- **出口退税** = `min(出口收入 × 退税率, 可退进项)`，差额为免抵额
- **出口收入封顶**：外币应收大于账面收入时按收入合计封顶并给出 warning（发票与账面不同期的防护）
- **税区差异**：美国税区不要求配增值税；`CN` 缺 vat/surcharge/cit 任一即拒算

## 销售与客户（`/api/crm`，M03）

> 线索商机 / 客户复购周期 / 客户价值排行 / 销售目标与提成 / 客户交接。读开放给全部业务角色，写限 `admin / sales`，批准限 `admin / finance`。

**字典与汇总**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/crm/dict | 登录 | 公司、客户、销售角色用户、线索来源/阶段/丢单原因/周期状态/回访结果/交接原因/指标口径 |
| GET | /api/crm/overview | 登录 | 线索按阶段、响应超时、公海、周期超期/升级/7 天内到期、待接收交接、提成待复核 |

**一、线索与商机（N03-07）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/crm/leads | 登录 | `?stage=&source=&owner_user_id=&pool=1&q=` |
| GET | /api/crm/leads/:id | 登录 | 详情 + 流转留痕 + 疑似重复 + 关联订单/样衣 + 可推进阶段 |
| POST | /api/crm/leads | admin,sales | `{source,source_ref,customer_id,customer_name_raw,contact,country,est_amount,owner_user_id,response_due}`；**同平台 source_ref 查重** |
| PUT | /api/crm/leads/:id | admin,sales | 改基础字段（已转订单的不许改） |
| POST | /api/crm/leads/:id/assign | admin,sales | `{to_user_id}` 分配（接收人须为销售角色） |
| POST | /api/crm/leads/:id/claim | admin,sales | 公海认领（已有主责的不能抢） |
| POST | /api/crm/leads/:id/recycle | admin,sales | `{reason}` 回收公海（已结束的不能回收） |
| POST | /api/crm/leads/sweep-pool | admin,sales | 把「响应超期且一次没回过」的自动回收公海 |
| POST | /api/crm/leads/:id/follow | admin,sales | `{note,evidence,next_action,next_action_date}` **证据与下次日期都必填** |
| POST | /api/crm/leads/:id/stage | admin,sales | `{to,lost_reason,lost_note,order_id}` 逐级推进；**转订单必须挂已确认订单** |
| POST | /api/crm/leads/:id/merge | admin,sales | `{into_id}` 合并重复线索（**不自动合并客户档案**） |
| POST | /api/crm/leads/import | admin,sales | `{rows:[…]}` 受控导入（≤200 行，逐行校验，坏行不落库） |
| DELETE | /api/crm/leads/:id | admin | 只允许未转订单的 |

**二、客户采购周期与回访（N03-03）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/crm/cycles | 登录 | `?status=&overdue=1&scope=active\|all&owner_user_id=&q=` |
| GET | /api/crm/cycles/alerts | 登录 | `{overdue,escalated,soon,counts}` 三档分开 |
| GET | /api/crm/cycles/infer | 登录 | 按历史间隔推断周期（**只建议，不落库**） |
| POST | /api/crm/cycles | admin,sales | `{customer_id,status,cycle_days,grace_days,owner_user_id,review_date,reason,basis}` |
| POST | /api/crm/cycles/accept-inference | admin,sales | `{customer_id,days}` 采纳推断（写周期变更留痕） |
| POST | /api/crm/cycles/refresh | admin,sales | 按有效订单重算采购日（**回访不参与刷新**） |
| GET | /api/crm/followups | 登录 | `?customer_id=&result=` |
| POST | /api/crm/followups | admin,sales | `{customer_id,contact_note,result,next_date,evidence}` |

**三、客户价值排行（N03-04）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/crm/ranking | 登录 | `?from=&to=&metric=amount\|revenue\|collection\|gross&exclude_internal=1` |

**四、客户与未结业务交接（N03-06）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/crm/handovers | 登录 | `?status=&company_id=` |
| GET | /api/crm/handovers/:id | 登录 | 详情 + 未结订单 + 未结线索 + 可推进状态 |
| POST | /api/crm/handovers | admin,sales | `{from_user_id,to_user_id,reason,customer_ids,note}` |
| POST | /api/crm/handovers/:id/status | admin,sales,finance | `{to,note}` 草稿→待接收→已接收→已完成；取消必须写原因 |
| DELETE | /api/crm/handovers/:id | admin | 只允许草稿或已取消 |

**五、销售目标（N03-09）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/crm/targets | 登录 | `?period=&company_id=&status=` |
| GET | /api/crm/targets/:id | 登录 | 明细 + 实际 + 达成率 + `formula`（分子分母） |
| POST | /api/crm/targets | admin,sales | `{period,team,currency,items:[{user_name,metric,target_amount}]}` |
| POST | /api/crm/targets/:id/approve | admin,finance | 批准（**制单人不能自批**；同期同团队旧版本自动关闭） |

**六、提成规则与提成单（N03-09）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/crm/commission-rules | 登录 | `?company_id=&status=` |
| POST | /api/crm/commission-rules | admin,sales | `{name,base_type,tiers:[{from,to,rate}],deduct_refund,effective_from}` 阶梯区间不许重叠 |
| POST | /api/crm/commission-rules/:id/approve | admin,finance | 批准（同主体同口径旧的自动标已替代；**制单人不能自批**） |
| GET | /api/crm/commissions | 登录 | `?period=&status=&user_id=` |
| GET | /api/crm/commissions/:id | 登录 | 明细 + 来源行 + 可推进状态 |
| POST | /api/crm/commissions/preview | admin,sales | 试算（不落库），返回基数/阶梯明细/来源行/已被计过的行 |
| POST | /api/crm/commissions | admin,sales | 生成草稿（**来源行全公司防重、一期一人一张**） |
| POST | /api/crm/commissions/:id/adjust | admin,sales | `{source_type:refund\|bad_debt,source_no,amount,note}` **必须指向已计提来源** |
| POST | /api/crm/commissions/:id/status | admin,sales,finance | `{to,reason}` 草稿→待复核→已批准（**制单人不能自批**）/已驳回 |
| POST | /api/crm/commissions/:id/link-payroll | admin,finance | `{payroll_period}` 引薪酬（**只生成一笔**；该期间已发工资则拒） |
| DELETE | /api/crm/commissions/:id | admin | 只允许草稿或已驳回 |

**报表**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/crm/reports/cycle | 登录 | 周期状态分布、超期与未知数（自然月观察与超期分开） |
| GET | /api/crm/reports/commission | 登录 | 按期间汇总基数/提成/调整/净额 |

**核心口径**
- **商机金额不是收入**：`est_amount` 只用于排优先级，不进目标、不进提成、不进排行
- **有效采购**：订单状态 ≥ `assigned` + 非集团内部客户 + 非样衣 + 金额 > 0；**回访不刷新采购日**
- **周期未知不编 0 天**：`status=unknown` 时 `cycle_days` 为空，且必须写原因 + 责任人 + 复核日
- **宽限只控制升级**：`is_overdue = 今日 > 应购日`；`escalated = 超期天数 > 宽限天数`
- **四个金额口径各取各的表**：订单净额（orders）/ 确认收入（ar_invoices）/ 回款（payments）/ 毛利（cost_objects）
- **缺成本不进毛利榜**：有收入没结转成本 = 毛利待核（不是毛利 0），单独计数不参与排名
- **提成来源行防重**：`UNIQUE(source_type, source_id) WHERE kind='base'`；调整行指向被调整的来源行
- **提成 ≠ 财务收入**：提成金额按已批准口径，退款与坏账单列调整，**不自动扣薪**
- **交接只改归属**：不动历史提成单的部门/主管快照；未结数量在提交时快照

## 供给批次与预订（`/api/supply`，M23）

> 可售口径 / 供给批次 / 预订申请 / 占用 / 缺口。读开放给全部业务角色，写限 `admin / sales / warehouse`，**预订确认限 `admin / sales`**。
> **ERP 库存事件是唯一账源**，商城与销售确认读同一份投影。

**字典与汇总**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/supply/dict | 登录 | 仓库、批次阶段、占用类型/状态、申请状态、缺口处理方式、陈旧阈值 |
| GET | /api/supply/overview | 登录 | 现货可买/占用/已拣、未来可订、投影陈旧与负量、待确认申请、占用到期、缺口 |
| GET | /api/supply/report | 登录 | `?warehouse=` 按仓汇总 + 全部投影行 |

**一、可售投影（N23-01 / N23-06）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/supply/projection | 登录 | `?warehouse=&q=&anomaly=1` 含 `on_hand / held_spot / qty_picked / sellable / future_available / version / computed_at / stale / anomaly` |
| POST | /api/supply/projection/refresh | admin,sales,warehouse | `{warehouse}` 重算（幂等：算几遍结果一样，版本递增） |

**二、供给批次（N23-02 / N23-05）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/supply/batches | 登录 | `?warehouse=&stage=&available=1&q=` 含 `stage_qty / committable / held_future / available / is_leaf / excludes` |
| GET | /api/supply/batches/:id | 登录 | 详情 + 迁移记录 + 该批次占用 + 缺口 + 父批 |
| POST | /api/supply/batches | admin,sales,warehouse | `{warehouse,style_no,color,size,qty_planned,risk_buffer,eta_date,eta_evidence}` |
| POST | /api/supply/batches/:id/move | admin,sales,warehouse | `{to_stage,qty,note}` **只能逐步往前，数量不许超过当前阶段剩余** |
| POST | /api/supply/batches/:id/inspect | admin,sales,warehouse,production | `{qty_ok,qty_defect,reason}` 实收检验，不合格转短装并生成缺口 |
| POST | /api/supply/batches/:id/split | admin,sales,warehouse | `{qty,note}` 部分到货拆子批（**父批不再算可订**） |
| POST | /api/supply/batches/:id/short | admin,sales,warehouse | `{qty,reason}` 短装/报废，**必须写原因** |
| DELETE | /api/supply/batches/:id | admin | 只允许「在产 + 无占用 + 无子批 + 无短装」的（建错了能撤） |

**三、预订申请（N23-03）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/supply/requests | 登录 | `?status=&kind=&customer_id=&q=` 含 `is_expired` |
| GET | /api/supply/requests/:id | 登录 | 详情 + 生成的占用 + 锁定批次 + 缺口 |
| POST | /api/supply/requests | admin,sales,warehouse | `{style_no,color,size,qty,kind,customer_id,expect_date,quote_price,valid_until,idempotency_key}` **不占量** |
| POST | /api/supply/requests/:id/confirm | admin,sales | `{batch_id,qty,expires_in_hours}` **只有授权销售**；版本 + 幂等 + 原子数量 |
| POST | /api/supply/requests/:id/reject | admin,sales | `{reason}` 驳回必须写原因 |
| POST | /api/supply/requests/:id/cancel | admin,sales,warehouse | `{reason}` 取消（已确认的会先释放占用） |
| POST | /api/supply/requests/expire | admin,sales,warehouse | 清理过有效期的待确认申请 |
| DELETE | /api/supply/requests/:id | admin | 未生效过的（占用已释放/到期才可删） |

**四、占用（N23-04）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/supply/holds | 登录 | `?status=&kind=&batch_id=` 含 `is_due / hours_left` |
| GET | /api/supply/holds/:id | 登录 | 详情 |
| POST | /api/supply/holds/:id/picked | admin,sales,warehouse | `{qty}` 登记拣货（**属于占用子集，不改占用数量**） |
| POST | /api/supply/holds/:id/release | admin,sales,warehouse | `{reason,confirm_picked,expected_version}` **已拣须先确认回位**；已挂订单只能走退货 |
| POST | /api/supply/holds/:id/convert | admin,sales,warehouse | `{order_id}` 转订单（**不释放再抢量**） |
| POST | /api/supply/holds/expire | admin,sales,warehouse | 只释放「临时 + 仍 active + 已过期」的 |

**五、缺口（N23-05）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/supply/shortages | 登录 | `?resolution=&batch_id=` |
| POST | /api/supply/shortages/:id/resolve | admin,sales,warehouse | `{resolution:substitute\|delay\|cancel\|written_off,substitute_batch_id,note}` |

**核心口径**
- **可买量 = 合格已上架实物 − 有效现货占用**；`qty_picked` 是占用的子集，**只展示不重复扣**
- **未来可订只算叶子批次**：已上架批次按 0（已归现货）、已拆父批按 0（数量在子批）、实收阶段只算**检验合格**部分
- **申请不占量**：只有销售确认才按 `SKU × 批次` 建占用；确认须**显式选批次**，报价过期不许确认
- **确认三层保护**：`version` 条件更新 + `idempotency_key` 唯一 + 数量原子校验（超量必失败）
- **占用迁移优先于释放**：转订单直接 `converted` 挂单，数量不回可卖池
- **到期只放临时占用**，放前再查状态；已拣须实物回位确认；已挂订单只能走退货
- **批次迁移数量守恒**：上游扣、下游加；进待发要有预计到仓时间，进在途要有依据
- **短装保留承诺**：不合格/短装进 `qty_short` 并生成缺口，占用不清，等人工决议（替代/延期/取消/接受短装）
- **投影陈旧 30 分钟**：标 `stale`，销售确认时强制重算；负量标 `anomaly` 并禁止新增占用

## 客户营销与消息（`/api/notify`，M24）

> 上新与到货提醒 / 采购周期回访任务 / 站内与邮件通知 / 微信通知与渠道降级 / 发送频控与审计 / 营销效果与归因。
> 读开放给全部业务角色，写限 `admin / sales`，**模板批准、频控规则、渠道能力限 `admin / finance`**。

**字典与概览**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/notify/dict | 登录 | 渠道（含可用性）、主题、事件、发送状态、订阅/核验/模板状态、语言、频率、时区、客户 |
| GET | /api/notify/overview | 登录 | 待发送/暂缓/送达/已读/失败/今日、订阅概况、提醒、渠道能力、模板与归因计数 |
| GET | /api/notify/channels | 登录 | 三个渠道的能力、核验状态、依据与不可用原因 |
| POST | /api/notify/channels | admin,finance | `{channel,status,verify_status,evidence,reason}` **启用必须有依据且已核验**；站内不可改 |

**一、订阅（N24-03 / N24-05）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/notify/subs | 登录 | `?customer_id=&topic=&channel=&status=&q=` 含 `usable` |
| POST | /api/notify/subs | admin,sales | `{customer_id,topic,channel,status,timezone,frequency,locale}` **同客户同主题同渠道唯一**，重复提交为更新 |
| POST | /api/notify/subs/:customerId/unsubscribe-marketing | admin,sales | `{reason}` **只关 marketing**，业务订阅保留，不删行 |
| POST | /api/notify/subs/:customerId/verify-email | admin,sales | 发起邮箱核验，返回校验串 |
| POST | /api/notify/subs/:customerId/confirm-email | admin,sales | `{token}` 核验通过后才算可用 |

**二、模板（N24-03 / N24-05）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/notify/templates | 登录 | `?event_key=&channel=&status=&lang=` |
| GET | /api/notify/templates/:id | 登录 | 详情 + 同组合版本历史 |
| POST | /api/notify/templates | admin,sales | `{event_key,channel,lang,subject,body,change_note}` 新建为草稿 |
| PUT | /api/notify/templates/:id | admin,sales | 只有草稿/待审核能改；**生效中的要出新版本** |
| POST | /api/notify/templates/:id/submit | admin,sales | 草稿 → 待审核；**必须含至少一个变量** |
| POST | /api/notify/templates/:id/approve | admin,finance | 批准；**制单人不能自批**；同组合旧版自动 `retired` |
| POST | /api/notify/templates/:id/retire | admin,finance | `{reason}` 停用生效中的必须写原因 |
| DELETE | /api/notify/templates/:id | admin | 只允许草稿或待审核 |

**三、微信绑定与渠道降级（N24-04）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/notify/wechat | 登录 | `?customer_id=&subscribe_status=` |
| POST | /api/notify/wechat | admin,sales | `{customer_id,openid,subscribe_status,template_ids,verified}` 绑定不等于可用 |
| POST | /api/notify/wechat/sync | admin,sales | 同步关注状态；渠道未授权时只更新时间，不改订阅结论 |

**四、频控（N24-05）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/notify/frequency | 登录 | 全局规则 + 客户例外 |
| POST | /api/notify/frequency | admin,finance | `{scope,max_per_day,max_per_week,min_gap_minutes,quiet_start,quiet_end,digest_hour}` **只作用于营销** |

**五、事件与发送（N24-01 / N24-02 / N24-03）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/notify/events | 登录 | `?event_key=&style_no=&q=&limit=` 含 `dedupe_key` 与发送数 |
| POST | /api/notify/events | admin,sales | `{event_key,style_no,customer_id,biz_id,dedupe_key,...}` **事件级幂等**；上新/到货要过「发布 + 可售」 |
| GET | /api/notify/outbox | 登录 | `?status=&channel=&topic=&event_key=&customer_id=&limit=` |
| GET | /api/notify/outbox/:id | 登录 | 详情 + 回执时间线 + 归因行 |
| POST | /api/notify/outbox/dispatch | admin,sales | 派发待发送 / 到点暂缓 / 到点重试 |
| POST | /api/notify/outbox/:id/send | admin,sales | 单条发送（营销先过频控；渠道不可用则降级） |
| POST | /api/notify/outbox/:id/receipt | admin,sales | `{event: delivered\|read\|opened\|failed, detail, provider_code}` |
| POST | /api/notify/outbox/:id/retry | admin,sales | 只有失败且未达重试上限 |
| POST | /api/notify/outbox/:id/skip | admin,sales | `{reason}` 必填 |

**六、到货提醒（N24-01）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/notify/alerts | 登录 | `?status=&customer_id=&style_no=` 含 `ready` / `ready_reason` / `sellable_qty` |
| POST | /api/notify/alerts | admin,sales | `{customer_id,style_no,kind,threshold_qty}` 需已订阅「上新与到货」+ 有商品权限 |
| POST | /api/notify/alerts/sweep | admin,sales | 扫描触发：发布通过且可售 ≥ 阈值才发 |
| POST | /api/notify/alerts/:id/cancel | admin,sales | `{reason}` |

**七、周期回访（N24-02）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/notify/cycle-tasks | admin,sales | `{customer_id?,date?}` 超期生成 CRM 回访任务；**无营销授权不发促销消息** |

**八、效果归因（N24-06）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/notify/attribution | 登录 | `?from=&to=` 客户级 + 商品级 + 合计 |
| POST | /api/notify/attribution/refresh | admin,sales | `{days}` 重算归因快照 |

**核心口径**
- **两层幂等**：事件 `event_key|biz_type|biz_id|日期`；发送 `事件|客户|渠道|模板版本`
- **提醒触发**：商品 `published` + 可售 > 0 + 客户有 `catalog.view` + 订阅 `arrival`，缺一停在等待并写明原因
- **订阅隔离**：`order / service / arrival / marketing` 四个主题独立；退订只改状态不删行
- **渠道降级**：微信/邮件不可用 → 站内（有订阅时），记 `degraded_from`；无可用渠道才 `skipped`；**不声称已通过不可用渠道发出**
- **频控只作用于营销**：静默时段按客户当地时间；`held` + `next_retry_at` 到点重发
- **回执只能往前**：`queued → submitted → delivered → read`；`opened` 只记时间不改状态；**没送达不能报已读**；失败默认 3 次
- **归因**：送达/阅读/询价/已确认订单四层；订单只认 `assigned` 及之后；窗口 7 天；同一单只归最早一条触达；**归因金额只算订单**

## 美仓作业计划（`/api/whplan`，M19：拣货波次 / 跨境头程 / 库容规划）

> 读开放给全部业务角色；建波次、拣货、复核、登记段与箱限 `admin / warehouse / sales`；**交承运与取消限 `admin / warehouse`**（发货与回滚由仓库把口）。

**字典与概览**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/whplan/dict | 登录 | 波次/明细状态、运输段状态、运输方式、策略、库区、仓库 |
| GET | /api/whplan/overview | 登录 | 待拣行、待交承运、本月短拣、在途/延误、库位预警、库容占用 |
| GET | /api/whplan/candidates | 登录 | `?warehouse=` 可拣预留（含 `pickable` 与 `blocked_reason`） |

**一、拣货波次（N19-04）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/whplan/waves | 登录 | `?status=&warehouse=&q=` 含 `short_qty`（复核确认的短拣）与 `unpicked` |
| GET | /api/whplan/waves/:id | 登录 | 明细（库位、库位来源、应拣/已拣/短拣）+ 可推进状态 |
| POST | /api/whplan/waves | admin,warehouse,sales | `{warehouse,strategy,hold_ids[],note}` 生成草稿；不可行的预留返回 `skipped` 原因 |
| POST | /api/whplan/waves/:id/release | admin,warehouse,sales | 草稿 → 待拣货 |
| POST | /api/whplan/waves/:id/items/:itemId/pick | admin,warehouse,sales | `{qty,location_code}` 拣货；**不能超过预留**、数量必须 >0 |
| POST | /api/whplan/waves/:id/pack | admin,warehouse,sales | `{weight,tracking_no,carrier,short_reason}` **必须称重 + 唯一运单**；有短拣必须写原因 |
| POST | /api/whplan/waves/:id/ship | admin,warehouse | 交承运：**扣库存 + 写 ledger(out) + 收口占用** |
| POST | /api/whplan/waves/:id/cancel | admin,warehouse | `{reason,confirm_return}` **已拣须确认实物回位**；已交承运只能走退货 |
| DELETE | /api/whplan/waves/:id | admin | 只允许草稿 |

**二、跨境头程（N19-02）**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/whplan/asns | 登录 | `?warehouse=&status=&q=` 含段进度、有效 ETA、剩余天数、延误、箱级短多 |
| GET | /api/whplan/asns/:id | 登录 | 段 + 箱 + 变更 + `impacted`（受影响占用与待确认申请） |
| POST | /api/whplan/asns/:id/legs | admin,warehouse,sales | `{mode,carrier,etd,eta,note}` ETA 不能早于 ETD；离港不能早于上一段到港 |
| POST | /api/whplan/legs/:legId/arrive | admin,warehouse,sales | `{actual_at}` **上一段没到不能跳段**，实际到达不能早于本段离港 |
| POST | /api/whplan/asns/:id/boxes | admin,warehouse,sales | `{carton_no,expect_qty,received_qty,short_qty,over_qty,damaged_qty,reason}` **实收 = 应到 − 短 + 多 − 损**；有差异必须写原因；同箱号为更新 |
| POST | /api/whplan/asns/:id/eta | admin,warehouse,sales | `{eta_date,reason}` 必须写原因；返回 `impacted_cnt`；**不自动改客户承诺** |

**三、库容规划**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/whplan/capacity | 登录 | `?warehouse=&zone=&near_full=1` 含 `used/free/pct/near_full/anomaly/sku_cnt` |
| GET | /api/whplan/suggest | 登录 | `?warehouse=&qty=&zone=` 上架建议；**放不下返回 `blocked:true` + 原因** |

**核心口径**
- **一笔预留只进一个未取消波次**：`UNIQUE(hold_id) WHERE hold_id IS NOT NULL AND status<>'cancelled'`；取消时明细一起置 `cancelled` 才允许重新进波次
- **只有交承运才出库**：拣货、复核都不动库存；交承运扣 `stock_items` 并写 `ledger(out)`，占用置 `released`（短拣部分回可卖池）
- **复核三门槛**：称重 > 0、运单号全局唯一、短拣必须有原因；打印面单 ≠ 交承运
- **头程段顺序**：上一段未到不能报下一段；实际到达 ≥ 本段 ETD；本段 ETD ≥ 上一段 ETA；ASN 对外 ETA 取最后一段
- **箱级守恒**：`实收 = 应到 − 短少 + 多到 − 破损`；差异必须写原因
- **ETA 变更**：必须写原因，算出受影响需求并留痕；**不自动改承诺、不自动通知客户**
- **库位结存 = 上架量 − 已交承运波次拣出量**：不新建库位库存表；无库位结存记录的 SKU 按剩余容量兜底并标 `loc_source`
- **上架建议**：按能放下的最小剩余推荐；单个库位放不下就拒绝，并告出全区剩余（分散在各库位）

---

## 有限产能排程（M06）

**一、基础数据**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/schedule/meta | 登录 | 工作中心（含设备数/台时产能/承接工序数）、工序定额、日历覆盖范围、当前生效批次 |
| GET | /api/schedule/orders | 登录 | 可排订单（status ∈ tech/finance/assigned/production）：件数、交期、评审、缺料项与到货日、工序数 |
| GET | /api/schedule/calendars | 登录 | `?from=&to=&work_center=` 返回 `rows` + `missing`（缺哪些 wc×天） |
| POST | /api/schedule/calendars | admin,production | `{work_center,cal_date,base_hours,start_hour,note}` **base_hours 0~24**，0=休息/停产 |
| POST | /api/schedule/calendars/fill | admin,production | `{work_center|work_centers[],from,to,base_hours,start_hour,weekdays_only,overrides[]}` 显式写入每一天 |
| GET | /api/schedule/standards | 登录 | 工序定额 + `pieces_per_hour`（= 60 / 单件分钟）+ `configured` |
| POST | /api/schedule/standards | admin,production | `{process_name,work_center,std_minutes,setup_minutes,efficiency,batch_min_qty}` **std_minutes 必须 > 0**（上限 600） |
| PUT | /api/schedule/standards/:id | admin,production | 同上；改定额不影响历史批次（批次里存的是定额快照） |

**二、排程批次**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/schedule/runs/preview | admin,production | `{from,to,algo,order_ids,carry_locked,material_gate}` **只算不落库**；返回 stats / conflicts（硬冲突排前）/ missing |
| POST | /api/schedule/runs | admin,production | 同上参数，落库为新版本；日历缺失或无定额时 **422 + 冲突明细**，不生成假计划 |
| GET | /api/schedule/runs | 登录 | 批次列表（含版本、窗口、任务数、冲突数、硬冲突数、超期单数、利用率、状态、is_current） |
| GET | /api/schedule/runs/:id | 登录 | 甘特数据：`lanes`（按工作中心，含 used/base/util 与任务）+ `dates` + `day_load`（每天每中心 base/down/avail/used/util）+ `conflicts` + `tasks`（含 `segments`/`preempted`） |
| POST | /api/schedule/runs/:id/publish | admin,production | **硬冲突未逐条处理时 409 + 冲突明细**；发布后成为该主体唯一 `is_current`，上一版转 `archived` |
| POST | /api/schedule/runs/:id/archive | admin,production | 当前生效批次不能归档，必须先发新版 |

**三、冲突处理与人工调整**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/schedule/conflicts | 登录 | `?run_id=`（默认当前生效）；含 `type_label` |
| POST | /api/schedule/conflicts/:id/resolve | admin,production | `{note}` **处理意见必填且 ≥4 字**；只留痕，不改订单/库存 |
| PATCH | /api/schedule/tasks/:id | admin,production | `{start_at,end_at,work_center,est_hours,locked,reason}` **reason 必填**；已发布批次 400；锁定必须写原因 |
| GET | /api/schedule/changes | 登录 | `?run_id=` 人工调整留痕（字段/原值/新值/原因/操作人） |
| GET | /api/schedule/load | 登录 | 当前生效批次的日负载（供产能日历对照） |

**核心口径**
- **可用工时 = 班次基准工时 − 当天停机占用（下限 0）**：日历缺行按 0 算，没有任何隐式默认值
- **工时 = 件数 × 单件分钟 / 60 / 效率系数 + 换款调试**：换款只在同一工作中心上一个款不同时才计
- **约束优先级**：日历 → 停机 → 定额 → 缺料 → 前后道顺序 → 交期
- **冲突 9 类**：`no_calendar`(硬) / `no_standard`(硬) / `no_qty`(硬) / `material_short`(硬,无到货日 | 软,有到货日) / `horizon_short`(硬) / `late_delivery`(软) / `no_due`(软) / `review_pending`(软) / `sequence`(保留)
- **未排订单不静默丢**：装不下、缺料无到货日、无定额、无件数，都会留下一条硬冲突说明为什么没排
- **版本号按公司递增**：`version = MAX(version)+1`，同公司 `is_current=1` 由部分唯一索引保证唯一

---

## 现货经营总览 + 备货补货与停补提案（M19）

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/spotops/dict | 登录 | 类型 / 状态 / 原因字典 + 内置默认策略 |
| GET | /api/spotops/overview | 登录 | `?warehouse=us&window_days=60` 按款总览：在库/占用/可售/在途/在产/日均销/覆盖天数/库龄/售罄率/断码 + `stat`（含 `no_eta_cnt`） |
| GET | /api/spotops/skus | 登录 | `?style_no=` 逐码快照 + 建议（不落库）；带 `policy_scope` |
| GET | /api/spotops/policies | 登录 | 备货策略列表 + `defaults` |
| POST | /api/spotops/policies | admin,sales | `{scope:global|category|style, style_no, category, target_cover_days, safety_days, lead_time_days, min_order_qty, lot_size, stop_cover_days, stop_age_days, dead_days, min_sample_days, status}`；**按款必须填款号、按类目必须填类目、目标覆盖与周期必须 > 0** |
| DELETE | /api/spotops/policies/:id | admin,sales | **全局策略不能删**（改成停用） |
| GET | /api/spotops/runs | 登录 | 提案批次列表（含补货/停补/来不及/样本不足计数、状态、is_current） |
| POST | /api/spotops/runs | admin,sales,warehouse | `{warehouse, window_days, note}` 生成一批；**无可建议对象时 422** |
| GET | /api/spotops/runs/:id | 登录 | 明细（补货→停补→观察，P1→P3 排序）+ 决策留痕；行上带 `expired`（>14 天未决策） |
| POST | /api/spotops/runs/:id/publish | admin,sales,warehouse | 下发；同仓库仅一个 `is_current`；**没有待决策行时拒绝** |
| POST | /api/spotops/runs/:id/archive | admin,sales,warehouse | 当前生效批次不能归档 |
| POST | /api/spotops/lines/:id/decide | admin,sales,warehouse | `{action:approve|reject|defer, qty, note}`；**批准数量 ≤ 建议量**、**停补/观察行不能批准数量**、**驳回/暂缓必须写原因**；只记录，不下单 |
| GET | /api/spotops/approved | 登录 | 当前生效批次里已批准的行汇总（含最迟下单日），给采购/生产做下单清单 |

**核心口径**
- **可售 = 已上架合格 − 有效现货占用**（优先 `sellable_projection`；缺失才退化成「实物 − 有效占用」并标 `fallback`）
- **可承诺量只含有 ETA 的供给**：`supply_batches.eta_covered=0` 的在途/在产不计入覆盖天数
- **销速 = 窗口内 `stock_ledger.type='out'` 合计 ÷ 自然日数**（调拨、套装拆组不算销量）
- **样本不足**（有出库天数 < `min_sample_days`）→ `cover_days=null`，只观察不给量
- **补货量** = `日均销 × (目标覆盖 + 安全天数) − 可承诺量`，不足起订量按起订量补，再向上取批量倍数
- **建议下单日** = 预计断货日（今天 + 覆盖天数）− 生产周期；已过 → `urgent=1`
- **停补** = 覆盖天数 > `stop_cover_days` 或 库龄 > `stop_age_days` 或 近 `dead_days` 天零出库
- **可售为负不给建议**：先跑数据质量勾稽

---

## 分公司经营对比（M12）

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/segments/dict | 登录 | 调整类型 / 口径问题字典；`current_period` = 最近有已过账凭证的月份 |
| GET | /api/segments/board | 登录 | `?period=YYYY-MM` 主表：各主体收入/内部收入/对外收入/净利/可比净利/占比/人均/环比/诊断标签 + `total` + `consolidated` + `ic_amount` + `issues` |
| GET | /api/segments/company/:id | 登录 | `?period=` 单主体下钻：快照 + 内部交易对手明细 + **待核对的往来名称** + 损益结构 |
| GET | /api/segments/adjustments | 登录 | `?period=` 可比口径调整列表 |
| POST | /api/segments/adjustments | admin,finance | `{company_id,period,kind:one_off|allocation|fx|other,amount,note}`；**金额不能为 0、说明 ≥4 字、期间格式 YYYY-MM** |
| DELETE | /api/segments/adjustments/:id | admin,finance | 删除一条调整 |
| GET | /api/segments/reports | 登录 | `?period=` 报告快照列表（不含 payload） |
| POST | /api/segments/reports | admin,finance | `{period,note}` 生成一版快照（冻结当期数字） |
| GET | /api/segments/reports/:id | 登录 | 含 payload（整张表快照） |
| POST | /api/segments/reports/:id/confirm | admin,finance | 确认并冻结；已确认的不能重复确认；**存在 block 级口径问题不许确认** |
| GET | /api/segments/export | 登录 | `?period=` CSV（带 BOM，Excel 直开） |

**核心口径**
- **内部收入 = 收入科目上 `partner_name` 命中该主体内部往来单位的部分**；认不出（配了客户类往来 + 本期确记了对集团内应收，但收入零命中）→ `external_income = null`，不给对外收入
- **对外收入 = 收入 − 内部收入**；没有对外收入时不算对外毛利
- **合并数 ≠ 分部之和**：差额 = 分部之和 − 合并数，必须与已识别内部收入一致，否则报 `ic_mismatch`
- **排名**：只含「已关账 + 未映射问题 + 对外收入 > 0」的主体
- **人均**：`employments` 按 `employer_company_id` 数 `status='effective'`，没有人数为 `null`
- **不二次折算汇率**：总账金额已是本币
- **调整**：正数 = 可比利润更高；只影响可比列，不改账
- **报告**：确认后 payload 冻结；有 block 问题不许确认


---

## 备料领退与盘点差异（M10）

**一、台账与流水**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/matflow/dict | 登录 | 单据状态 / 类型 / 流水类型字典 |
| GET | /api/matflow/board | 登录 | `?from=&to=` 总览：单据状态计数、待发与欠发清单、进行中盘点、期间流水汇总、上次盘点差异、零库存原料 |
| GET | /api/matflow/stock | 登录 | `?type=fabric\|accessory` 原料台账：**账面 / 占用 / 可用** + 期间收发 + 最近采购价 |
| GET | /api/matflow/ledger | 登录 | `?material_id=&type=&from=&to=` 原料流水（每一条增减的来路） |

**二、备料与领料**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/matflow/issues/suggest | 登录 | `?order_id=` 按订单用料算出需求、已领、**可用**（已排除本订单自己的占用）、缺口 |
| GET | /api/matflow/issues | 登录 | `?status=&order_no=&kind=` 列表；带 `overdue`（需求日已过仍未发） |
| GET | /api/matflow/issues/:id | 登录 | 明细（需求/实发/欠发/已退/可退/可用）+ 退料记录 + 库存流水 + `can` 可执行动作 |
| POST | /api/matflow/issues | admin,warehouse,production | `{kind:order\|extra\|sample, order_id, req_date, receiver_type, note, items[]}`；**订单备料必须选订单**、**车间补料必须写原因**、**同一原料不许重复行** |
| POST | /api/matflow/issues/:id/prepare | 同上 | 备料：按原料汇总校验可用量并**占用**；未关联原料档案的行不许备料 |
| POST | /api/matflow/issues/:id/issue | 同上 | `{items:[{id,issued_qty,batch_no}]}` **实发 ≤ 未发量**、**可用不含本单占用**；少发转 `partial` 并留欠发 |
| POST | /api/matflow/issues/:id/close | 同上 | **还有欠发必须写说明（≥4 字）** |
| POST | /api/matflow/issues/:id/cancel | 同上 | 只有草稿/已备料能取消（已发料请走退料），原因必填 |

**三、退料**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/matflow/returns | 登录 | `?status=&order_no=` 退料单列表 |
| GET | /api/matflow/returns/:id | 登录 | 退料明细 |
| POST | /api/matflow/returns | admin,warehouse,production | `{issue_id, type:leftover\|wrong_spec\|defect\|order_cancel, reason, items:[{issue_item_id,qty}]}` **必须挂已发料的单**、**qty ≤ 已发−已退**、原因 ≥4 字 |
| POST | /api/matflow/returns/:id/confirm | 同上 | 退料入库：加回库存 + 写 `issue_return` 流水；**不能重复入库**；盘点冻结期间被拦 |

**四、盘点**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/matflow/stocktakes | 登录 | `?status=` 盘点单列表（含未盘行数、盘盈/盘亏、未计价条数） |
| GET | /api/matflow/stocktakes/:id | 登录 | 盘点表（账面、实盘、差异、单价、差异金额、原因） |
| POST | /api/matflow/stocktakes | admin,warehouse,production | `{take_date, material_ids?, counter, note}` **同一时间只许一张未完成盘点**；账面数此时快照 |
| POST | /api/matflow/stocktakes/:id/start | 同上 | 转「盘点中」→ **冻结原料收发** |
| POST | /api/matflow/stocktakes/:id/count | 同上 | `{items:[{id,count_qty,reason}]}`；**空 = 未盘（NULL），不是 0** |
| POST | /api/matflow/stocktakes/:id/submit | 同上 | **没盘完不许提交**；**有差异不写原因不许提交** |
| POST | /api/matflow/stocktakes/:id/adjust | **admin,warehouse** | 落账：写 `stock_gain`/`stock_loss` 流水并改数量、解除冻结；**只有「待调账」能落账**，已落账不能重复 |
| POST | /api/matflow/stocktakes/:id/cancel | admin,warehouse,production | **已调账不能取消**；原因必填 |
| GET | /api/matflow/order/:id | 登录 | 某订单的领料进度（累计需求/已发/未发）+ 用料建议 |

**核心口径**
- **可用 = 账面 − 已备未发（占用）**；备料即占用，发料才扣减
- **发料、备料建议都要排除「自己」的占用**：发料排除本单，订单用料建议排除本订单所有单
- **占用量按原料汇总校验**，同一原料多行不能各自过闸
- **没有采购价的原料**：金额显示「未计价」，盘点差异只调数量，并计入 `uncosted_count`
- **原料流水是唯一凭据**：所有增减（收货 / 领料 / 退料 / 退回供应商 / 盘盈 / 盘亏）都写 `material_ledger`，`materials.stock_qty` 不允许裸改
- **盘点冻结**只挡过账（领料发料、退料入库、收货检验入账），不挡查询

---

## 价格快照与费用池（M11）

**一、费用池**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/pricing/dict | 登录 | 池类型 / 动因 / 状态 / 价格本状态字典 |
| GET | /api/pricing/board | 登录 | 费用池总览 + 价格本总览（一起给，首页一次拿全） |
| GET | /api/pricing/pools | 登录 | `?period=&status=&kind=` 费用池列表（带明细笔数、池额、已分摊、差额） |
| GET | /api/pricing/pools/:id | 登录 | 池详情：明细 + 分摊结果 + 池额与明细是否一致 + `can` 可执行动作 |
| GET | /api/pricing/pools/:id/preview | 登录 | **分摊预览（只算不落库）**：每个成本对象的基数、占比、分摊额、`blockers` |
| POST | /api/pricing/pools | admin,finance | `{period:YYYY-MM, name, kind:manufacturing\|admin\|selling, driver:labor_hours\|qty\|material_amount\|revenue, note}` |
| POST | /api/pricing/pools/:id/expenses | admin,finance | `{expense_date, category, description, amount}` **说明必填**、**金额≠0**、**日期必须落在池期间内**；负数（红冲）要写说明 |
| DELETE | /api/pricing/expenses/:id | admin,finance | 删费用明细（只有草稿能删） |
| POST | /api/pricing/pools/:id/distribute | admin,finance | `{note}` 正式分摊；**基数为 0 拒绝**；制造费用写 `cost_entries` + 加 `actual_cost` |
| POST | /api/pricing/pools/:id/revert | admin,finance | `{reason}` **原因 ≥4 字**；删掉写入的成本分录并回滚 `actual_cost`，池回到草稿 |
| POST | /api/pricing/pools/:id/close | admin,finance | 结账；**分摊合计与池额不一致拒绝结账** |

**二、价格本**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/pricing/books | 登录 | `?status=&scope=` 价格本列表 |
| GET | /api/pricing/books/:id | 登录 | 价目表：每项带成本快照、**当前成本**、**成本漂移**、毛利率、低于成本标记 |
| POST | /api/pricing/books | admin,finance,sales | `{scope, customer_id, currency, effective_from, note, copy_from}`；从当前生效版复制价目；**新生效日必须晚于现有生效版** |
| POST | /api/pricing/books/:id/items | admin,finance,sales | `{id?, style_no, size, min_qty, max_qty, price, note}` **只有草稿能改**；价格 >0；**同款同码数量档不许交叉**；自动带出成本与毛利 |
| DELETE | /api/pricing/items/:id | admin,finance,sales | 删价项（只有草稿能删） |
| POST | /api/pricing/books/:id/publish | admin,finance,sales | `{note}` 发布：重算成本快照 → **有项取不到成本则拒绝** → **有低于成本的项必须写说明** → 同范围旧版转 superseded |
| POST | /api/pricing/books/:id/archive | admin,finance,sales | `{reason}` 归档（归档后该范围没有生效价），原因必填 |

**三、取价**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/pricing/quote | 登录 | `?style_no=&qty=&size=&customer_id=&date=` 取价；**客户专价优先于通用价**；返回命中的价格本版本、单价、成本、毛利、金额；查不到返回 `found:false` + 原因（**不是 0 元**） |
| GET | /api/pricing/cost/:styleNo | 登录 | 某款的单件成本与来源（成本对象 / 核价单 / 取不到） |

**核心口径**
- **池额 = 明细合计**（不能手填）；**跨期明细直接拒**
- **只摊本期有活动的成本对象**（本期有报工或本期有成本发生）
- **基数 0 不入池**；**全池基数合计为 0 拒绝分摊**
- **分摊合计 = 池额**（尾差归基数最大的对象），不一致不许结账
- **制造费用才写进产品成本**（`overhead` + `actual_cost`）；管理/销售费用只做分析口径
- **价格本发布即冻结**，同范围同客户只有一版 `published`（部分唯一索引），旧版转 `superseded`
- **取不到成本不许发布**；**低于成本可以发但要写说明**并长期标红
- **成本漂移**：当前成本与快照差 ≥5% 提示发新版

---

## 长期投资抵消（M12）

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/investment/dict | 登录 | 核算方法 / 变动类型 / 分子公司清单（分两类返回，避免选错） |
| GET | /api/investment/board | 登录 | 总览：笔数、账面价值、投资成本、权益法笔数 |
| GET | /api/investment/list | 登录 | `?status=active\|disposed` 投资列表 |
| GET | /api/investment/:id | 登录 | 详情：变动留痕 + 核算方法说明（成本法/权益法的口径差异写在返回里） |
| POST | /api/investment | admin,finance | `{company_id, investee_id, method:cost\|equity, acquire_cost, share_pct, acquire_date, note}` **只允许对子公司建**；**同一被投企业只能一条有效**；成本 >0；持股 0~100 |
| POST | /api/investment/:id/changes | admin,finance | `{type:equity_share\|dividend\|increase\|decrease, amount, share_pct, change_date, reason}` **原因 ≥4 字**；**成本法不许确认损益**；**权益法亏损不得超过账面**；**分红不得超过账面（权益法）** |
| POST | /api/investment/:id/method | admin,finance | `{method, reason}` 改核算方法，原因必填；账面按新方法重算并留痕 |
| POST | /api/investment/:id/dispose | admin,finance | `{reason}` 处置：持股与账面清零，原因必填 |
| GET | /api/investment/offsets/:period | 登录 | **抵消预览（不落库）**：每家长投的权益、应享、商誉/负商誉、少数股东权益 + 抵消分录 + `total.balanced`（借贷是否平）+ `check.asset_eq_equity` + `issues` |
| GET | /api/investment/equity/:period/:companyId | 登录 | 子公司权益明细（含**当期未结转损益**行，抵消的依据） |

**核心口径**
- **只有子公司抵消**：`type='branch'` 的分公司没有股权，合并时直接并入；对分公司建长投会被拒
- **商誉 = 长投账面 − 子公司权益 × 持股比例**：>0 记 1701 商誉（不摊销，年度减值测试）；<0 为负商誉，记 6301 营业外收入并披露
- **少数股东权益 = 子公司权益 × (1 − 持股比例)**，记 4201，列在合并权益内
- **成本法**：账面 = 初始成本；分红只确认投资收益，**不冲账面**（累计分红照记但账面不看）
- **权益法**：账面 = 成本 + 累计损益调整 − 累计分红；**亏损以账面减至 0 为限**，超出为未确认投资损失（账外备查）
- **抵消分录借贷必须相等**，不等直接不出合并表
- **抵消对资产与权益净影响恒等**（`商誉 = 长投 − 权益×p` 恒成立），所以合并后仍满足 `资产 = 负债 + 权益`
- 合并生成接口返回体自动带 `goodwill` / `minority_equity` / `investment_offset` / `bargain_gain` / `investment.items` / `investment.issues`

---

## 裁片外发与外协验货交接（M07）

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/cutdispatch/dict | 登录 | 状态 / 验收结论字典 + 外协厂清单 + 已录合格裁片数的裁剪单 |
| GET | /api/cutdispatch/board | 登录 | `?from=` 看板：在途批次、发出/已回/合格/不良/差异、验收合格率、**逾期未回清单**（含逾期天数）、**外协合格率排名**（回货 <50 件不排名） |
| GET | /api/cutdispatch/suggest/:cutOrderId | 登录 | 某裁剪单的可发扎 + `remain_qualified`（合格 − 未结案已发）+ `can_send_qty`（按扎实际可勾）+ `uncheckable` / `busy` 计数 + `blockers` |
| GET | /api/cutdispatch/list | 登录 | `?status=&factory_id=&order_no=` 外发单列表（带 `open_qty` 与 `overdue`） |
| GET | /api/cutdispatch/:id | 登录 | 详情：按扎明细 + 回货记录（含按扎回货明细）+ `accepted_check`（三分闭合自检）+ `can` 可执行动作 |
| POST | /api/cutdispatch | admin,production,warehouse | `{cut_order_id, factory_id, bundle_ids[], out_date, expect_return_date, price, note}` **只能发复核过的扎**；**一扎不能挂两张未完结单**；件数 = 扎包合计；≤ 合格裁片 − 已发 |
| POST | /api/cutdispatch/:id/send | 同上 | 草稿 → 已发出 |
| POST | /api/cutdispatch/:id/receive | 同上 | `{receive_date, handover_by, received_by, inspected_by, inspect_result, short_qty, short_reason, items:[{dispatch_item_id, qty, accepted_qty, rejected_qty, rework_qty, defect_reason}]}` **三方签名必填**；**回货 ≤ 未回**；**合格+不良+返工 = 回货**；**不良/返工写原因**；**短数写原因并落到扎** |
| POST | /api/cutdispatch/:id/close | 同上 | `{loss_reason}` **有未回必须写差异原因**；结案后扎释放（可再外发） |
| POST | /api/cutdispatch/:id/cancel | 同上 | `{reason}` 只有草稿/已发出（**未回货**）能取消，原因必填 |

**核心口径**
- **粒度到扎**：扎是能追缸号与裁片批次的唯一单位，不能用整单件数代替
- **未复核不能发**；**草稿外发单同样占扎**
- **外发上限 = 合格裁片 − 未结案已发**；没录合格裁片数不许外发
- **三分闭合**：`合格 + 不良 + 返工 = 本次回货`（差异另计）
- **短数单独计差异**，并从扎的「未回」里扣；**不能塞进已回货**
- **交接三方留名**（外协交货人 / 本厂接收人 / 验货人）
- 回货合格**不自动写成品库存**，成品入库走 `/api/stock/instock`


---

## 研发立项与款式生命周期 + 商品 SKU 与配码包装主档（M05）

**一、研发立项**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/devmaster/dict | 登录 | 阶段 / 来源 / 里程碑 / 任务类型 / SKU 类型 / 配码类型字典 |
| GET | /api/devmaster/board | 登录 | `?month=YYYY-MM` 总览：`stat`（本月新立项、开发完成、销售接收、已下单、首次上架、逾期未上市、SKU 数）+ `milestones`（各里程碑项目数与件数，**各自独立**）+ `stage_stat` + `overdue` + `counting_note` + `plan_note` |
| GET | /api/devmaster/projects | 登录 | `?keyword=&stage=&source=&biz_type=&month=` 立项列表（含里程碑点阵、任务完成/阻塞数、逾期标记） |
| GET | /api/devmaster/projects/:id | 登录 | 详情：里程碑时间线、任务、`checks`（5 项规则自检）、`plan_vs_actual`、`reuse`（返单原项目）、`counts_as_dev` |
| POST | /api/devmaster/projects | admin,tech | `{style_no,style_name,category,season,biz_type,source,customer_id,dev_type,reuse_project_id,classify_approved_by,owner,sales_owner,pattern_maker,target_qty,target_price,plan_launch_date}`；**source=repeat 必须给原项目且原版型已验证可复用**；**source=new_pattern 必须给批准分类人**；**target_qty 只是计划，不产生任何单据** |
| PATCH | /api/devmaster/projects/:id | admin,tech | 改负责人/版师/版型号/样衣号/目标价/计划上市日等；`pattern_reusable=1` **必须已投产或已上架** |
| POST | /api/devmaster/projects/:id/stage | admin,tech | `{stage}` **只许前进一格**；进 `tech` 需有负责人；进 `sample` 需已有版型（自建制版完成/复用原版/已有版号） |
| POST | /api/devmaster/projects/:id/milestone | admin,tech,sales | `{kind,occurred_on,qty,ref_type,ref_id,ref_no,note}`；**前驱未发生不许登记**；`once` 类不许重复；`tech_approved` 必须有样衣号；下单/投产/上架必须给件数 |
| POST | /api/devmaster/projects/:id/tasks | admin,tech | `{kind:pattern|sample|tech_pack|costing,title,owner,due_date,reuse_pattern,qty}` |
| POST | /api/devmaster/tasks/:id/status | admin,tech | `{status, output, blocked_reason}`；**done 必须写产出**、**blocked 必须写原因**；制版/样衣完成后自动回写版型号与样衣号 |
| POST | /api/devmaster/projects/:id/close | admin,tech | `{reason}` **≥4 字**；结案后不能再登记里程碑 |

**二、SKU 与配码**
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/devmaster/skus | 登录 | `?keyword=&kind=&status=&style_no=` SKU 列表（含当前配码版本、别名数、`convertible`） |
| GET | /api/devmaster/skus/:id | 登录 | 详情：当前配码、全部版本、别名、套装组件 |
| POST | /api/devmaster/skus | admin,tech | `{sku,style_no,pattern,color,size,kind,unit,barcode,customer_id}`；**单件单位=件、套装单位=套**；**单花单码唯一** |
| PATCH | /api/devmaster/skus/:id | admin,tech | 改条码/备注/花型/颜色/尺码/客户专属/状态；**还是套装组件的 SKU 不能停用** |
| GET | /api/devmaster/skus/:id/explode | 登录 | `?qty=` **套 → 件换算**；套装无生效配码直接 400 |
| POST | /api/devmaster/skus/:id/alias | admin,tech | `{alias,source}`；别名不能与任何正式 SKU 或已有别名重复 |
| POST | /api/devmaster/aliases/:id/disable | admin,tech | `{note}` **≥2 字**；**停用不删**，历史仍可反查 |
| GET | /api/devmaster/packs/:id | 登录 | 配码版本详情（明细 + 合计件数） |
| POST | /api/devmaster/packs | admin,tech | `{sku_id,kind:set|carton,pack_no,items[],note}`；**合计件数由明细算出**；套装组件不能是自己/不能是套装；箱规同尺码不许重复 |
| POST | /api/devmaster/packs/:id/activate | admin,tech | 启用；同对象同类旧的自动 `superseded` 并回填失效日；已在生效的不能重复启用 |

**核心口径**
- **开发款数 = 技术核准的项目数，且不含返单复用**：返单的技术核准只是「核对原版仍适用」
- **里程碑不相加**：一个款会走完多个里程碑，也会跨月
- **里程碑有因果顺序**：技术核准 → 销售接收 → 正式下单 → 实际投产 → 首次上架
- **计划量 ≠ 实际**：`target_qty` 只做参考；实际以 `order_placed` / `in_production` / `us_launched` 的件数为准
- **研发任务不进订单**：避免「制版没做完 → 订单开不了工」的循环阻塞
- **库存基本单位是件**：套装必须先有生效配码才能换算；换算不出来不许动库存
- **配码/箱规是版本化组合关系**：同 SKU 同类同时只有一版生效
- **别名停用不删**：历史单据与对账单还要靠它反查


---

## 供方信息协同与技术再次审核（M05-06）

**三段链路，顺序不可反**

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/supreview/dict | 登录 | 制版分工 / 供方来源 / 复审结论 / 阶段字典 |
| GET | /api/supreview/board | 登录 | 协同看板：`stat`（A1 待分工 / A2 待确认 / A3 待审 / A3 失效 / 可核准 / 仅样料物料数）+ `stages` + `rows`（每张技术包的 A1 状态、物料数、已确认数、复审生效/失效数、阶段）+ `rule_note` |
| GET | /api/supreview/options | 登录 | 下拉：`suppliers`（在册合格）、`reusable_packs`（已核准技术包，供 A1 复用） |
| GET | /api/supreview/packs/:techPackId | 登录 | 单张技术包协同详情：A1 分工、A2 全部版本、A3 全部复审（含 `stale` / `stale_reason` / `live`）、`stage`、`can_approve`、`problems` |
| POST | /api/supreview/packs/:id/assignment | admin,tech | **A1** `{tech_owner, pattern_scope:self|outsource|reuse, pattern_vendor_id, reuse_tech_pack_id, pattern_price, due_date, note, force}`；技术处理人必填；外发必须指定版房；**复用必须指向已核准的技术包**；已确认后改动需 `force=1` |
| POST | /api/supreview/packs/:id/assignment/confirm | admin,tech | 确认 A1；未指定版房/原技术包时拒绝 |
| POST | /api/supreview/packs/:id/confirms | admin,tech | **A2** `{material_name, spec, composition, supplier_id, source_type, sample_basis, approval_ref, unit_price, lead_days, requirement_no}`；**A1 未确认时拒绝**；适用规格必填；供方过资格门禁；`new_dev` 必须有样料依据；`sample_only` 必须有批准依据；同物料自动出下一版并作废旧版 |
| POST | /api/supreview/confirms/:id/confirm | admin,tech | 确认供货条件；**必须有有效单价**；已作废版本不能确认 |
| POST | /api/supreview/confirms/:id/cancel | admin,tech | 作废草稿（`{reason}` ≥4 字）；**已确认的不能作废**，改条件请出新版本 |
| POST | /api/supreview/packs/:id/reviews | admin,tech | **A3** `{confirm_id, conclusion:pass|conditional|reject, approved_by, diff_reason, note}`；**必须引用当前版本 A2**；通过类必须写核准人；有条件通过/退回必须写差异原因 |
| POST | /api/supreview/packs/:id/approve | admin,tech | 核准技术包（写 `tech_packs.status='confirmed'`）；**A3 失效或 A2 未齐时拒绝**并给出问题清单 |

**核心口径**
- **A1 → A2 → A3 顺序不可反**：A2 之前必须 A1 已确认
- **复用原版必须指向已核准的技术包**：复用未核准的版等于跳过技术审核
- **A2 有版本**：同技术包 + 同物料（`material_key`）同时只能有一版 `is_current`；换供方 / 改规格自动出下一版
- **A3 必须引用当前版本 A2**：引用已作废版本直接拒绝
- **供货条件一变，原 A3 自动失效**并在详情里写明原因；失效时不许核准技术包
- **找料样料与正式大货采购分开**：`sample_only` 的 `can_purchase = 0`，必须另走正式确认
- **成熟供方只核对适用性**：`existing` 不要求重新开发，只填样料依据即可
- 供方资格门禁**复用采购侧 `qualificationGate`**，不另写一套判定


---

## 上线准备：真实数据导入（/api/importops）

**三段式：选类型 → 准备数据 → 预览（不写库）→ 确认导入**

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | /api/importops/types | 登录 | 支持的 6 个导入类型，含字段说明、是否必填、唯一键、类型注意事项 |
| GET | /api/importops/template/:type | 登录 | CSV 模板（带一行示例，UTF-8 带 BOM，Excel 直开不乱码） |
| POST | /api/importops/preview | admin,finance,sales,tech,warehouse | `{type, csv}` **只算不写**；返回 `stat`（total/new/update/error）+ 逐行 `action`（new/update/error）、`errors[]`、`preview`；最多回 500 行 |
| POST | /api/importops/commit | admin,finance | `{type, csv, opts:{skip_errors, file_name, note}}`；**默认整批事务**，有错行返回 422 + 错误行明细（`data.rows`）；`skip_errors=1` 时跳过错误行并记入批次 |
| GET | /api/importops/batches | 登录 | 导入批次（`?type=`）最近 100 条 |
| GET | /api/importops/batches/:id | 登录 | 批次详情 + `error_list`（错误行明细） |

**支持的导入类型**

| type | 类型 | 唯一键 | 特别注意 |
|---|---|---|---|
| customers | 客户档案 | 客户编号；无编号时按名称 | **给了编号就只认编号**，编号不存在 = 新增（不按同名覆盖） |
| suppliers | 供应商档案 | 供应商编码；无编码时按名称 | 类别：材料 / 加工 / 服务 |
| materials | 面辅料档案 | 材质编码 | 类型必填：面料 / 辅料 |
| products | 产品（款）档案 | 款号 | 款号是订单与库存的关联键 |
| skus | SKU 主档 | SKU 编码 | 单件单位=件、套装单位=套；单花单码唯一校验 |
| stock_opening | 期初库存 | 仓库+款号+颜色+尺码 | **只能导一次**；不覆盖已有真实库存；负数/0 拒绝 |

**核心口径**
- **预览与提交共用同一套分析逻辑**：预览看到什么，提交就写什么
- **默认整批事务**：有错行整批不写；跳过错误行必须手动勾选（界面标「不推荐」）
- **只覆盖文件里给出的字段**：没给的列不动
- **表头体检**：必填字段的列不存在 → 整批拒绝
- **自动识别分隔符**（逗号 / 制表符 / 分号），Excel 直接粘贴可用
- **期初库存三条门**：已有期初流水拒（防翻倍）、已有真实库存拒（走盘点）、数量 ≤0 拒
- **每批留痕**：`import_batches` 记批次号、类型、文件、行数、成功/新增/覆盖/跳过、错误明细、操作人、时间

## 上线准备：岗位权限复核（`/api/access`）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/access/permissions | 登录 | 全量权限点表 + 角色 + 职责分离规则（前端启动时同步，替代本地硬编码） |
| GET | /api/access/me | 登录 | 当前账号**生效权限**：主岗 ∪ 附加岗 − deny + allow；`denied` 是被收回的点 |
| GET | /api/access/roles | 登录 | 角色清单 + 每个角色的权限点与数量 |
| GET | /api/access/review | admin,hr | 复核矩阵：`users`（含生效权限/例外/多岗）+ `sod` + `summary` |
| POST | /api/access/exceptions | admin | `{user_id, perm, effect: deny\|allow, reason}` **reason 必填**；对 admin 设置会被拒 |
| DELETE | /api/access/exceptions/:id | admin | 撤销例外 |
| POST | /api/access/roles | admin | `{user_id, roles:[]}` 设置附加岗（与主岗取并集，可传空数组清空） |
| GET | /api/access/sod | admin,hr | 职责分离规则与命中用户（已排除系统管理员） |
| GET | /api/access/reviews | admin,hr | 复核签字记录 |
| POST | /api/access/reviews | admin | `{period, scope, signed_off_by, note}` 签字时快照账号数/例外/冲突数 |

**生效权限的计算顺序**

```
生效 = (主岗 users.role ∪ 附加岗 user_roles) 的默认权限
       − access_exceptions.deny
       + access_exceptions.allow（只加回「被 deny 且角色本就有」的点）
```

**收回如何真的生效**

- 前端：`GET /api/access/me` 的 `perms` 决定按钮显隐（`permState.loaded=true` 时以此为准，未加载退回 `perm-table.js` 兜底）
- 后端：`middleware/auth.js` 在 `authRequired` 里按 32 条**高危路由**（钱/库存/人事/权限/对外导出）比对 deny，命中直接 403 并在 message 里带收回理由
- 未登记的路由只在前端隐藏 —— 有意的边界，全量映射配错会误拦线上业务

**一人多岗**

`users.role` 是主岗，`user_roles` 是附加岗；`requireRole` 对「主岗或任一附加岗」放行。
`boss`（总经理）只读：写接口一律按岗位判断，GET 放行。

**职责分离**

10 条内置规则（`SOD-01` ~ `SOD-10`），判据是同一账号同时持有左右两端。
`level` 全是 `warn`：识别 + 留痕 + 补偿性控制，不做硬拦截（小企业一人多岗是常态）。

## 上线准备：备份与恢复（`/api/backup`，全部仅管理员）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/backup/overview | 备份健康（最近备份距今几小时 / 等级）+ 磁盘占用 + 待恢复状态 + 数据健康检查 + 最近 12 条 |
| POST | /api/backup/create | `{note}` 在服务端生成备份（`VACUUM INTO`），立即校验并记录 sha256 / 表数 / 行数 / 耗时 |
| GET | /api/backup/list | `?kind=manual\|pre_restore\|auto\|restore` 备份历史（含 `exists` 表示文件是否还在） |
| GET | /api/backup/:id/download | 下载备份文件（二进制流） |
| POST | /api/backup/:id/verify | 重新校验文件（`integrity_check` + 关键表 + 非空库），结果写回记录 |
| DELETE | /api/backup/:id | 删除备份（文件一起删；正等着恢复的那份不允许删） |
| POST | /api/backup/restore/prepare | `{backup_id, note}` 校验 → **自动备份当前库** → 写待恢复文件，返回 plan（含回滚点编号） |
| POST | /api/backup/restore/upload | **二进制上传**（`application/octet-stream`，≤512MB）准备恢复，`?note=` 记原因 |
| POST | /api/backup/restore/rollback | 撤销待恢复（重启前反悔），待恢复文件改名归档 |
| GET | /api/backup/restore/pending | 当前是否有待恢复文件 + 计划详情 |
| GET | /api/backup/checks | 数据健康检查（6 项，见下） |

**恢复为什么必须重启**

SQLite 已打开的连接无法安全换到另一个文件，硬换会让一半请求读旧库、一半读新库。
所以「换文件」只在启动时做（`db.js` 在 `new Database(...)` **之前**调 `services/backup-restore.applyPendingRestore()`）。

**启动时替换的顺序（缺一步就出事）**

```
1. 校验 restore-pending.db（integrity_check + 关键表 + 非空）
   └ 校验不过：改名 restore-failed-<时间>.db 到 data/replaced/，继续用旧库（宁可恢复失败也不能弄坏库）
2. 旧库改名 → data/replaced/replaced-<时间>.db（不删）
3. 删掉 erp-mindmap.db-wal 与 -shm   ← 不删会把旧事务重放到新库上
4. restore-pending.db 改名为 erp-mindmap.db
5. 写一条 backup_jobs（kind=restore）留痕
```

**数据健康检查的 6 项**

| key | 项目 | 级别 | 说明 |
|---|---|---|---|
| gl_posted_balanced | 已过账凭证借贷平衡 | hard | 只算 `status='posted'` 且有凭证的分录 |
| gl_orphan_entries | 凭证分录无孤儿行 | data | 分录的凭证不存在（演示脚本中断留下的），会让总账不平 |
| stock_balance | 成品库存 = 流水净额 | data | `SUM(stock_items.qty)` vs `SUM(stock_ledger.qty)` |
| material_balance | 原料库存 = 流水净额 | data | `SUM(materials.stock_qty)` vs `SUM(material_ledger.qty)` |
| order_items_orphan | 订单明细无孤儿行 | data | 明细的订单不存在 |
| users_unique | 账号无重复 | hard | 重名账号会让登录错乱 |

**这些检查不参与「恢复是否成功」的判定** —— 库里本来就有脏数据时，恢复成功后它仍然会报；
恢复只看：待恢复文件被消费、关键表行数一致、标记数据回滚、有退路（回滚点 + 旧库留档）。

**定时备份**

```bash
ADMIN_PASS=你的密码 BASE=http://127.0.0.1:3000 node scripts/backup-cron.js
```
走 HTTP 而不是直连库：备份的唯一写入者应该是服务进程，避免抢锁与重复实现保留策略。

## 现场照片留证（`/api/photos`）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/photos/cats | 登录 | 分类口径（defect/incoming/packing/sample/other），前后端共用一份，防止中文自由输入把筛选搞坏 |
| GET | /api/photos | 登录 | `?order_id&cat&node_id&from&to&keyword&limit&offset` 照片墙列表，带订单号/款名/工序名 |
| GET | /api/photos/stats | 登录 | 总数 / 涉及订单 / 占用 / 分类分布 / 近 14 天 / 磁盘占用 |
| GET | /api/photos/order/:id | 登录 | 某张单的全部照片（订单详情附件区用） |
| POST | /api/photos | photo.write | `{order_id, dataUrl, cat, note, node_id, taken_at}` 单张上传 |
| POST | /api/photos/batch | photo.write | `{order_id, photos:[…]}` 一次最多 12 张，返回 `saved` / `failed` 两段（一张失败不影响其他张） |
| DELETE | /api/photos/:id | photo.write | **软删除**（写 `deleted_at`，文件与记录都保留） |

**三条硬规则**

1. `cat=defect` 时 `note` 至少 2 个字，否则 400 —— 一堆没说明的不良照片三个月后没人看得懂
2. 删除只写 `deleted_at`，不物理删 —— 照片是证据
3. 挂之前校验订单存在、`node_id` 属于该单 —— 避免孤儿附件

**为什么必须先压缩**

手机直出 3–8MB，后端单张上限 4MB、`express.json` 上限 8MB。前端 `utils/photo.js` 在**选完照片立刻压**
（长边 1600 / JPEG 0.82 → 200–400KB），并按 EXIF 摆正。不压就必然在上传这一步失败，
而工人会把「上传失败」理解成「系统坏了」。

**存储位置**

`backend/data/uploads/photos/YYYY-MM/<随机名>.jpg`，对外 `/uploads/photos/...`。
按月分目录：单目录堆几万个文件，远程备份和 `ls` 都会很难受。

## 验货报告（`/api/inspection`）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/inspection/preview/:orderId | 登录 | **实时预览**（不落库）：订单/明细/尺码配比/验货单与检验项/异常/首件/报工/照片 |
| POST | /api/inspection | inspection.write | `{order_id, note}` 生成报告快照，返回带编号与 `snapshot` 的完整报告 |
| GET | /api/inspection/:idOrNo | 登录 | 按 id 或报告编号取回（含当时的快照） |
| GET | /api/inspection?order_id= | 登录 | 某订单的报告历史（版本倒序，不含快照） |
| GET | /api/inspection/recent | 登录 | 最近生成的报告 |

**为什么分「预览」和「生成」两步**

客户要看的是「某一次生成的」文件。预览用来确认数据对不对（照片齐不齐、结论是不是最新那张），
确认后再生成带编号的快照。合并成一步的话，每次打开页面都会产生一份报告，编号和版本就没意义了。

**快照冻结**

生成时把整单数据序列化进 `snapshot`。之后内部再报工、再补照片、再改判定，
**已生成的报告不变**。同一订单可多次生成，`version` 递增，旧版不覆盖。

**结论口径**

只认 `status='done'` 的 `qc_inspections`，取最新一张的 `aql_result`。
没有验货记录 → `qc.result='none'`，报告显示「未验货」，并在结论段明确写「不作为出货依据」。
**不允许根据照片或报工数据推断合格** —— 报告替公司下结论，要担责任。

**照片**

快照里存的是引用（`url`）+ 元信息（说明/工序/拍摄时间/上传人），不复制文件。
因为照片是**软删除**且文件保留，已发报告里的图长期有效 —— 换成物理删除，这份报告过几个月就全是裂图。

**打印成 PDF**

页面用 A4 样式 + `@page` 规则，浏览器「打印 → 另存为 PDF」即可。
不在服务端拼 PDF：中文字体嵌入与图片质量在两行代码里做不对，浏览器打印是更稳的路。

## 扎标与扫码解析（`/api/labels`）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/labels/bundles/:orderId | 登录 | 整单的扎（含缸号/床次/复核状态/裁剪单号），每扎带 `code = 订单号-扎号` |
| GET | /api/labels/resolve?code= | 登录 | 扫码解析：`{kind: order\|bundle, order, bundle, bundle_missing, bundle_total}` |

**码的三种形态**

| 扫到的码 | 解析结果 |
|---|---|
| `SO202610260005` | `kind=order` |
| `SO202610260005-B008` | `kind=bundle`，带出扎号/件数/颜色尺码/缸号/复核状态 |
| `SO202610260005-B999`（这单有扎但对不上） | `kind=order` + `bundle_missing='B999'` → 前端必须红字提示 |
| `SO202610260005-WY-001-M`（老款色码标） | `kind=order`（后缀不匹配任何扎，且不报错） |

> **为什么扎标码是「订单号-扎号」而不是只放扎号**：扎号在不同订单里会重复（B001 每单都有），
> 只有带上订单号才能唯一定位。第一段仍是订单号，所以老的 `find` 逻辑不受影响。

**报工带扎号**

`POST /api/reports` 支持 `bundle_no`（可选）。服务端校验该扎属于同一订单，否则 400 拒收。
该字段**只用于追溯**，报工累计 / 工序状态 / 成本分摊仍按 `order_id + node_id` 聚合。

## 扎级完工进度（`/api/labels/progress`）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/labels/progress | 登录 | 有扎的订单清单：扎数、扎件合计、带扎报工数、未归扎报工数 |
| GET | /api/labels/progress/:orderId | 登录 | 矩阵：`processes` + `bundles[].cells` + `summary` + `unassigned_by_node` + `notices` |

**返回结构要点**

```js
{
  processes: [{ name: '成品入库', seq: 12 }],        // 按 seq 升序，同名已合并
  bundles: [{
    bundle_no, qty, cells: { '车缝': { ok, defect, last_date, n } | null },
    final_ok, touched, over,
    status: 'done' | 'short' | 'doing' | 'idle'
  }],
  summary: { bundles, total_qty, done, done_qty, short, short_qty, doing, idle, over,
             unassigned_reports, unassigned_qty, final_process, process_count },
  unassigned_by_node: [{ name: '车缝', qty: 390 }],
  notices: [{ level: 'warn' | 'bad', text: '…' }]
}
```

**口径（服务层写死，前端不再判断）**

1. **只统计 `bundle_no` 非空的报工**。没记扎号的单独汇总进 `unassigned_*`，不摊派到扎上。
2. **按工序名聚合**，不按 `node_id` —— 库里有重复工序列与跨单脏数据；对不上工序列的报工
   单独成一列并计入 `summary.unknown_process_reports`，不丢弃。
3. **末道 = 名字含「入库」的工序**；没有再取 seq 最大且非「出库/发运」的那道
   （出库发运是整单动作，拿它判完工会让所有扎永不完工）。
4. `done` 要求 `final_ok >= qty` 且 `qty > 0`；`short` 要求 `0 < final_ok < qty`；
   `over` 是独立标记（任一工序 `ok > qty`），不改状态。

## 计件工资（`/api/piece-wage`）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/piece-wage/meta | 人事/财务/总经理 | 工序清单（工序表 + 报工里出现过的）、款号清单、有报工的月份 |
| GET | /api/piece-wage/config | 同上 | 考勤联动配置：`daily_cap_qty`（每人每日上限，0=不限）、`month_cap`、`attendance_policy` |
| PUT | /api/piece-wage/config | piecewage.write | 改配置；策略只能 warn/exclude/block，负上限与 >5000 直接拒 |
| GET | /api/piece-wage/attendance-board?period= | 同上 | 考勤 × 计件对照：每人出勤/迟到/请假/旷工、月上限、剩余、被削件数 |
| GET | /api/piece-wage/rates | 同上 | 单价列表 |
| POST | /api/piece-wage/rates | piecewage.write | `{style_no, process_name, unit_price, effective_from, effective_to, note}`；同款同工序同生效日重复直接拒 |
| PUT | /api/piece-wage/rates/:id | piecewage.write | 改单价；**已被核算用过的只许改备注/停用** |
| GET | /api/piece-wage/preview?period= | 同上 | 实时试算（不落库）：明细 + 按人汇总 + 九类诊断（含考勤冲突 / 无出勤记录 / 剔除 / 日封顶 / 月封顶） |
| GET | /api/piece-wage/runs | 同上 | 核算单列表（近 60） |
| POST | /api/piece-wage/runs | piecewage.write | `{period, note}` 生成草案（同月草案覆盖且**编号不变**） |
| GET | /api/piece-wage/runs/:id | 同上 | 详情（明细 + 诊断快照，含当时的策略与日上限） |
| POST | /api/piece-wage/runs/:id/confirm | piecewage.approve | 确认；**缺单价一条都不许过**；无法归属 / 考勤冲突时要求备注 ≥4 字；策略 `block` 时冲突笔直接拒 |
| POST | /api/piece-wage/runs/:id/void | piecewage.approve | `{reason}` 作废（理由 ≥4 字） |
| GET | /api/piece-wage/export?run_id= | 同上 | 明细 CSV（带 BOM，含报工日期与当天考勤） |
| GET | /api/piece-wage/runs/:id/payslips?mode=person\|public | 同上 | 工资条（按人分组，明细按「工序×订单」合并，含脱敏名 `mask_name` 与封顶/考勤笔数）或车间公示表（不含明细）。**只认 `status='confirmed'`**，草案返回 400 |

**取价规则**

```
单价 = 该款专属价（生效日 ≤ 报工日期 里最新的一条）
       ?? 通用价（style_no 为空，同样取最新生效的一条）
```

同一个「款 + 工序 + 生效日」只能有一条（唯一索引），否则取价会摇摆。
**改价不改历史**：新价是新记录，旧记录不动，历史核算单里的 `rate_id` 仍指向当时那条。

**核算四类诊断**

| 诊断 | 含义 | 处置 |
|---|---|---|
| `missing_rate` | 报工找不得单价 | 草案可存，**确认被拒**（按 0 算等于白干） |
| `unassigned` | 归不到人（重名/姓名不在档案/没记人） | 不阻塞确认，但备注必须写处理办法 |
| `capped` | 同扎同工序累计超过扎件数，超出部分不计 | 单独列出逐笔核对 |
| `no_bundle` | 报工没记扎号，无法用扎件数封顶 | 照算，但少一层校验 |

**与工资单的关系**

计件金额**只由已确认的核算单带入** `payrolls.piece_wage`，工资单页不允许手填。
`POST /api/payrolls/generate` 返回 `piece_wage_run` / `piece_wage_total` /
`warnings`（工资单已确认/已发放导致计件没进单的人）。

## 异常协同与日清（`/api/exceptions`）

> 把技术/缺料/质量/产能/人事/资金六类异常 + 流程审批超时，扫成一张「今日必办」。
> 读权限全员（`exception.read`），认领与关闭给实际岗位（`exception.write`），
> 复核给主管与老板（`exception.review`），改规则阈值只给管理员（`exception.rule`）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/exceptions/meta | exception.read | 字典（七类归口 / 状态 / 规则 / 人员）+ 统计 |
| GET | /api/exceptions/daily?day= | exception.read | 日清清单：`must`（今日必办）/ `doing`（处理中）/ `coverage`（覆盖率）/ `auto_resolved_today` |
| GET | /api/exceptions/report?day= | exception.read | 日报初稿：已完成 / 处理中 / 等待外部 / 超时升级 / 系统消除 + 按责任人分布 + 口径说明 |
| GET | /api/exceptions/stats | exception.read | 顶部统计（未结 / 升级 / 待指派 / 严重 / 今日关闭 / 今日自动消除 / 待复核 / 已忽略） |
| POST | /api/exceptions/scan | exception.write | 扫描（**幂等**）：`{opened, refreshed, auto_resolved, escalated, suppressed, must_do, coverage}` |
| GET | /api/exceptions/rules | exception.read | 规则与阈值（含 `rule_note` 判定口径） |
| PUT | /api/exceptions/rules/:code | exception.rule | 改阈值 / SLA / 启停。**下次扫描生效，不追溯已生成条目** |
| GET | /api/exceptions | exception.read | 列表（`status` 默认 active；可按 `category`/`rule`/`owner`/`no_owner`/`escalated`/`q` 过滤） |
| GET | /api/exceptions/:id | exception.read | 详情 + 动作流水 |
| POST | /api/exceptions/:id/claim | exception.write | 认领（谁认领谁负责；已被别人认领需先转派） |
| POST | /api/exceptions/:id/assign | exception.write | 指派 / 转派：`{to_username, reason}`，**reason ≥4 字** |
| POST | /api/exceptions/:id/close | exception.write | 关闭：`{cause, result, expect_date?}`，**cause 与 result 都 ≥4 字** |
| POST | /api/exceptions/:id/review | exception.review | 复核：`{pass, note}`，**复核人不能是处理人**；不通过则打回 `handling` |
| POST | /api/exceptions/:id/note | exception.write | 加备注（不改状态） |
| POST | /api/exceptions/:id/reopen | exception.write | 重开：只允许 `auto_resolved` 的条目 |
| POST | /api/exceptions/:id/ignore | exception.write | 标为数据遗留：`{reason, until?}`，**reason ≥4 字**；到期自动重新检出 |

**11 条检测规则**

| 规则 | 归口 | 级 | 判定 |
|---|---|---|---|
| `order_overdue` | 产能与交付 | 严重 | 在产订单交期已过仍未发货；**未填交期的不参与判定，计入覆盖率** |
| `order_stuck` | 产能与交付 | 常规 | 当前状态停留超阈值天数（默认 3） |
| `tech_pack_missing` | 技术 | 严重 | 定制单已进财务审核及之后，无 `status='confirmed'` 的技术包 |
| `material_short` | 缺料 | 严重 | 齐套净缺口 > 0；**在途不抵扣**；键用「订单 + 物料」 |
| `purchase_late` | 缺料 | 常规 | 采购承诺到货日已过仍有未到货 |
| `fa_not_released` | 质量 | 严重 | 首件未放行但已有报工 |
| `qc_fail_open` | 质量 | 严重 | 质检 AQL 判定 fail 且单据未关闭 |
| `equipment_down` | 产能与交付 | 常规 | 停机未恢复且超阈值小时（默认 24） |
| `ar_overdue` | 资金 | 常规 | 应收未核销且逾期超阈值天（默认 1 天，当天到期不算） |
| `ap_overdue` | 资金 | 常规 | 应付未付且已过账期 |
| `approval_timeout` | 流程与审批 | 常规 | 审批任务过了应处理时限（**只提醒，不自动通过**） |

**四条硬口径**

1. **幂等**：唯一键 `(company_id, rule_code, source_type, source_id, biz_key)`，
   只约束「未关闭」条目（`WHERE status NOT IN ('closed','auto_resolved','ignored')`）。
   同一天扫 10 次仍是一条，只刷新 `last_seen_at` / `seen_count`。
2. **自动消除 ≠ 人工关闭**：事实消失记 `auto_resolved` 并写「由系统按事实消除」，
   不计入人工完成量；事实再次出现时**恢复原条目**而不是新建。
3. **覆盖率必须可见**：每条规则返回 `scanned / found / skipped / skip_reason`；
   没有规则的类别在 `coverage.category_gaps` 里显式写「暂无自动检测规则，需人工排查」。
4. **只写清单**：不改任何业务单据状态、不扣绩效、不扣工资。

**已暂停**：`/api/bad-debt/*`（坏账准备计提）接口未挂载，返回 404；
相关代码与已生成的凭证、1231/6702 余额均保留，恢复方式见 `server.js` 与 `services/gl.js` 的注释。

## 生产交付效率与质量报表（`/api/prod-report`）

> 只读，不改任何业务数据，**不产生排名或扣薪依据**。权限 `prodreport.read`
> （admin/boss/production/finance/tech/sales；仓库与人事不看）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/prod-report/overview?period= | 八项指标 + 覆盖率清单（7 条）+ 8 条口径 + 各分块 |
| GET | /api/prod-report/on-time | 准交率**双口径**：`by_due`（该交的）/ `by_shipped`（交了的），含按类型与延期原因 |
| GET | /api/prod-report/segments | 工厂段达成（P1→E1 实际 vs 计划）+ 节点等待时长；**与客户准交并列不相减** |
| GET | /api/prod-report/efficiency | 工序效率（只取有工时的报工） |
| GET | /api/prod-report/quality | 一次合格率 / 返工 / 报废 / 按工序与责任分布 |
| GET | /api/prod-report/wip | 在制龄分档与逐单明细 |
| GET | /api/prod-report/plan-vs-actual | 计划 vs 实际；缺 `plan_date` 时报 0% 覆盖与原因 |
| GET | /api/prod-report/material | 裁片合格率与余料；**材料利用率不计算并说明缺什么** |
| GET | /api/prod-report/lead-time | 交期四段下钻（技术制版 / 销售接收 / 资料接收 / 在制变更） |
| GET | /api/prod-report/export?kind=&period= | CSV（带 BOM）。kind: `on_time` / `efficiency` / `quality` / `wip` / `plan` |

**八项指标与口径**

| 指标 | 口径 | 算不出来时 |
|---|---|---|
| 准交率 | 实际发运日 ≤ 原批准承诺日；双口径并列 | 样本 < 5 只给数字不给比率 |
| 工厂段达成 | P1 裁床算料实际开始 → E1 出厂发运实际结束，对比各节点 `plan_days` 之和（**含 E1**） | 无计划天数 → `factory_ok=null` |
| 工序效率 | (标准单件分钟 × 合格件数 ÷ 60) ÷ 实际工时 | 缺工时或缺标准工时 → `efficiency=null` |
| 一次合格率 | (投产件数 − 返工件数) ÷ 投产件数；返工复验合格不再计 | 查不到件数 → `fpy=null` |
| 返工/报废率 | 返工件数、报废件数 ÷ 投产件数 | 同上 |
| 在制龄 | 起算：首个工序实际开始 → T0 → 建单日（`base_source` 标注） | 全无 → `age_days=null` |
| 材料利用 | **不计算**（缺净用布面积），只给裁片合格率与余料 | `utilization=null` + 原因 |
| 计划实际差异 | `order_nodes.plan_date` vs `actual_date` | 覆盖率 0% 并提示去排程生成计划日 |

**四条硬口径**

1. **工序产出不相加成整件产量**：整件只认订单件数。
2. **客户准交与工厂段达成并列，不相减**：剔掉下单前等待再叫准交率是化妆。
3. **分母为 0 给 null 不给 0**：0 是「效率极差」，null 是「没数据」。
4. **覆盖率为 0 也照实显示**：`order_nodes.plan_date` 为空时显示「0/101 可比」，
   不把「没有计划」当成「计划偏差 0 天」。

## 流程变更发布与审计（`/api/flow-changes`）

> 审批流是**制度**不是代码：改制度要留痕、可回滚，且不能让正在走的单子跟着变形。
> 权限 `flowchange.read`（admin / boss 只读）、`flowchange.write`（仅 admin）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/flow-changes/meta | read | 字典（角色 / 关键角色 / 状态 / 迁移模式） |
| GET | /api/flow-changes/flows | read | 流程清单（当前生效版本 / 版本数 / 在途单数 / 待处理变更） |
| GET | /api/flow-changes/flows/versions?flow_key= | read | 版本历史（`flow_key` 带 `::`，走 query 不走路径） |
| GET | /api/flow-changes/changes | read | 变更单列表（可按 `flow_key` / `status` 过滤） |
| GET | /api/flow-changes/changes/:id | read | 详情：试运行证据 + 影响分析 + 审计流水 |
| POST | /api/flow-changes/changes | write | 创建变更（草稿）：`{flow_key, title, reason, steps[], impact_nodes?}`，标题 ≥4 字、原因 ≥6 字 |
| POST | /api/flow-changes/changes/:id/trial | write | 试运行：拿近 N 天历史单对比审批路径（默认 90 天） |
| POST | /api/flow-changes/changes/:id/publish | write | 发布：`{effective_from, migration_mode, migration_note?, critical_role_note?}` |
| POST | /api/flow-changes/changes/:id/rollback | write | 回滚：`{reason}` ≥6 字，只能回滚最近一次发布 |
| POST | /api/flow-changes/changes/:id/reject | write | 作废未发布的草稿：`{reason}` |
| GET | /api/flow-changes/audits?flow_key= | read | 审计流水（创建/试运行/发布/回滚/迁移/作废） |

**四道发布校验（缺一道就 400）**

1. 必须做过试运行（`trial_summary` 不为空）——**没有测试证据的流程改动不许上线**
2. 生效日不能早于今天（**不能倒签改历史**），也不能超过 90 天
3. 试运行发现删了关键角色（finance / admin）→ 必须写 ≥8 字理由
4. `migration_mode='migrate'` 时必须写 ≥6 字迁移原因，且必须有可安全迁移的在途单

**试运行输出**

| 字段 | 含义 |
|---|---|
| `sample` / `same_count` / `changed_count` | 样本单数 / 路径不变 / 路径变化 |
| `changed_samples[]` | 逐单前后路径对比（`old_path` → `new_path`，`delta` 级数差） |
| `removed_critical_roles` | 新流程删掉的关键角色（发布时必须解释） |
| `amount_range_changed` / `amount_range` | 金额区间是否变了（区间是「哪条流程被选中」的条件） |
| `verdict` | 结论（样本不足会明说「仅供参考」） |

**在途单口径**

- 发单时写 `approval_instances.flow_version_id` 与 `steps_snapshot`，**改版不影响已发起的单**
- 发布默认 `keep_old`（在途单不动）；`migrate` 只迁「一步都没开始」的实例
- 已有人批过/认领的**不迁** —— 迁移会把它打回起点，那是破坏不是升级

**关键角色**：`finance`（财务）、`admin`（总经理）。删掉它们不是不能做，但会被记下来 ——
这就是原型「关键财审、技术版本、分厂、质量和资金门槛不允许因加急被绕过」的落地。

## 字段级脱敏与访问审计（`/api/privacy`）

> 掩码发生在**服务端返回时**，不是前端隐藏。权限 `privacy.read`（admin/boss 看规则与日志）、
> `privacy.admin`（改规则，仅 admin）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/privacy/meta | read | 字典（表/分类/掩码方式/权限点）+ 统计 |
| GET | /api/privacy/rules | read | 脱敏规则（按表分组） |
| PUT | /api/privacy/rules/:id | admin | 改掩码方式 / 保留位数 / 所需权限点 / 启停 |
| POST | /api/privacy/reveal | 登录 | 一次性查看明文：`{table_name, field_name, target_id, reason}` |
| GET | /api/privacy/logs | read | 访问日志（账号/表/字段/动作/是否授权/理由/条数） |
| GET | /api/privacy/stats | read | 统计（规则数 / 今日访问 / 一次性查看 / 导出） |
| GET | /api/privacy/check?table= | 登录 | 当前用户在该表上能看明文哪些字段 |

**14 条默认规则（5 张表）**

| 表 | 字段 | 方式 | 明文所需权限点 |
|---|---|---|---|
| employees | id_card / phone / emergency_contact | 身份证留前6后4；手机留前3后4；紧急联系人全掩码 | `hr.pii` |
| employees | base_salary | 完全隐藏 | `payroll.sensitive` |
| payrolls | base_salary / gross_pay / net_pay / tax / social_insurance / piece_wage | 完全隐藏 | `payroll.sensitive` |
| customers | phone / email | 手机留前3后4；邮箱留前2+域名 | `crm.pii` |
| suppliers | phone | 留前3后4 | `supplier.pii` |
| admin_contracts | amount | 完全隐藏 | `contract.sensitive` |

**判定口径（全篇最容易做错的一处）**

`access.hasPerm()` 里 admin 恒返回 true。**脱敏层不能调它**，否则管理员默认可读全公司工资。
这里用 `access.effective().base`（角色本身配置的权限点）判定：

- 有该权限点 → 返回明文，记一条 `granted=1` 的日志
- 没有（含 admin）→ 返回掩码；要明文必须走 `POST /reveal`，写理由，记 `granted=0`

**四条硬约束**

1. **工资/合同/银行三类的「留痕」开关关不掉**（服务端强制为 1）。
2. **一次性查看必须写理由（≥6 字）**，一次只查一条记录的单个字段，不做批量。
3. **导出也脱敏**：`GET /api/payrolls/export` 对无权限的人是 `***`，并记 `action='export'` 日志。
4. **日志区分「有权限」与「申请查看」**（`granted` 字段）—— 出安全事件时性质完全不同。

**为什么不脱敏 `bank_accounts.account_no`**

那是内部编码（`CN-ICBC-001`），真实账号本来就只存 `account_masked`。
强行脱敏内部编码只会让对账变难 —— 系统从一开始就没存真实明文账号。

## 技能矩阵与岗位资格（`/api/skills`）

> 回答三个排产要问的问题：**这道工序现在有几个人真能上**、**这个人能不能上**、**下个月谁会掉资格**。
> 权限：`skill.read`（admin/boss/hr/production/tech）、`skill.write`（admin/hr/production）、
> `skill.rule`（admin/hr，改受限开关）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/skills/meta | read | 字典（4 级等级 / 3 种来源 / 部门 / 工序门槛）+ 统计 |
| GET | /api/skills/matrix?department_id=&q=&include_empty= | read | 人 × 工序矩阵。**默认只列有技能记录的人**，`without_skill` 单独返回 |
| GET | /api/skills/coverage | read | 覆盖缺口：每道工序合格几人/需要几人/缺口/仅报工/过期/破格 + 未建门槛工序 + 未归属报工 |
| GET | /api/skills/expiring?days=60 | read | 到期清单（技能复评 / 资格证书 / 复训三合一） |
| GET | /api/skills/stats | read | 顶部统计 |
| GET | /api/skills/check?employee_id=&process_name= | read | 某人能不能上某工序（派工前先问一句） |
| GET | /api/skills/mine?employee_id= | 登录 | 员工视角：我的技能、证书、培训。非 hr/production/admin 只能看自己 |
| POST | /api/skills/assess | write | 评定技能（**唯一能改等级的地方**）：`{employee_id, process_name, level, evidence, valid_until}`，evidence ≥4 字 |
| POST | /api/skills/revoke | write | 撤销技能：`{employee_id, process_name, reason}`，reason ≥4 字 |
| PUT | /api/skills/requirements | rule | 维护工序门槛：`{process_name, min_level, restricted, min_headcount, work_center}` |
| GET | /api/skills/certs?employee_id= | read | 员工资格证书清单 |
| POST | /api/skills/certs | write | 登记证书：到期日早于今天会直接落成 `expired` |
| POST | /api/skills/certs/:id/revoke | write | 作废证书（写原因 ≥4 字） |
| GET | /api/skills/trainings?employee_id= | read | 培训记录 |
| POST | /api/skills/trainings | write | 安排培训：`{employee_id, course_name, course_type, planned_at}` |
| POST | /api/skills/trainings/:id/finish | write | 登记结果：`{result: pass/fail, score?, expire_date?}` |
| POST | /api/skills/overrides | rule | 破格放行：`{employee_id, process_name, reason≥6字, valid_until}`。**只对受限工序**，必须有期限 |

**数据依赖**

- 工序清单取 `process_standards`（排程真正认的那份），没有则用内置 9 道工序兜底。
- 报工回填：`production_reports.employee_id` + `node_name` → 生成 `source='actual'` 的占位技能行（`level=1`），
  `report_count` 记录次数。**它证明「做过」，不证明「合格」**。

**五条硬口径**

1. **等级只来自评定** —— `assess()` 是唯一写 `level` 的入口；报工只更新 `report_count`。
2. **只有 evaluated 且达标才算可上岗** —— `canWork()` 返回 `allowed` 只代表「不拦」，
   是否「有资格」要看 `level >= min_level && 未过期`。
3. **默认全都不受限** —— `restricted=0` 时只提示。打开受限时若 0 人合格，接口在 `warnings` 里明确告知会停线。
4. **查不到人不拦** —— `employee_id` 为空时 `gateForReport` 直接放行，只在覆盖缺口的
   `report_no_employee` 里计数（当前 89 条报工中 2 条查不到人）。
5. **证书过期即失效、记录不删** —— 状态转 `expired`，矩阵显示「有·已过期」。

**门禁挂在报工上**（`POST /api/reports`）：保存前调 `gateForReport(employeeId, nodeName)`，
受限工序且无有效资格 → 400；有破格放行 → 放行并在返回里标 `via_override`。

## 员工自助与薪资申诉（`/api/self`）

> 员工看自己的考勤/工资条/技能，提交补卡、请假、资料更正、薪资申诉。
> **范围由「账号 ↔ 员工档案」绑定决定，不按姓名猜**；未绑定账号只能看到一句「请联系人事绑定」。
> 权限：`self.read` / `self.submit`（全角色）/ `self.manage`（admin/hr/finance）/ `self.bind`（admin/hr）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/self/meta | read | 字典（申请类型 / 状态 / 可更正字段 / 调整项目）+ 统计 |
| GET | /api/self/overview | read | 我的：档案、本月考勤、已休假期、工资条摘要、技能到期、未结申请。未绑定返回 `bound:false` + `hint` |
| GET | /api/self/payslips | read | 我的工资条（**只含 confirmed / paid**，draft 不给看） |
| GET | /api/self/payslips/:id | read | 工资条明细。只能看自己的（越权 403）；**本人查看也写访问日志**（`granted=1`） |
| GET | /api/self/requests | read | 我的申请（含是否超期） |
| POST | /api/self/requests | submit | 提交申请：`{type, reason≥5字, payload}` |
| POST | /api/self/requests/:id/withdraw | submit | 撤回未处理的申请 |
| GET | /api/self/team | read | 主管看的团队摘要（出勤/迟到/缺勤/请假**天数**；**不含金额、不含请假类型**） |
| GET | /api/self/bindings | bind | 账号绑定清单（含未绑定账号） |
| GET | /api/self/employees-for-bind | bind | 可绑定员工（已绑的标 `bound_user` 不可选） |
| POST | /api/self/bind | bind | 绑定：`{user_id, employee_id}`。一个员工只能绑一个在职账号 |
| POST | /api/self/unbind/:userId | bind | 解绑 |
| GET | /api/self/all-requests | manage | 受理台：全部申请（可按 status/type/owner 过滤，带 `overdue`） |
| POST | /api/self/review/:id | manage | 受理：`{approve, conclusion≥5字, adjust_amount?, adjust_item?}` |
| GET | /api/self/adjustments | manage | 工资调整单（下一期生效） |

> **受理路径是 `/review/:id` 而不是 `/requests/:id/review`**：`GUARDED` 是高危前缀匹配，
> 若沿用 `/api/self/requests` 前缀，会把「员工本人提交申请」（`POST /api/self/requests`）一起拦掉。

**四类申请与各自的校验**

| 类型 | 主责 | 期限 | 关键校验 |
|---|---|---|---|
| `makeup` 补卡 | hr | 3 天 | 日期不能是未来、只能补 30 天内、至少填上班或下班一个时间、**同一天不许两条处理中** |
| `leave` 请假 | hr | 3 天 | 结束日期不早于开始；系统**不自动生成请假单**（避免与请假额度两套状态） |
| `profile` 资料更正 | hr | 5 天 | 只能改**手机号 / 紧急联系人**；部门、岗位、工资、银行卡一律走线下（返回 400 明确说明） |
| `payroll` 薪资申诉 | finance | 5 天 | 只能申诉自己的、已确认/已发放的、**30 天窗口内**；**同一张工资单不许重复申诉** |

**四条硬口径**

1. **批准不改已付历史**：薪资申诉批准必须填调整金额，生成 `payroll_adjustments`，
   落在**下一期**；被申诉那一期的 `net_pay` / `status` / `updated_at` 一律不动（冒烟有断言锁住）。
2. **补卡批准会真的写考勤**：写入/更新 `attendance`，状态用与考勤模块一致的 `normal`
   （不是另造 `present`），`remark` 记 `补卡：单号`。
3. **驳回也要写结论**（≥5 字）——员工拿到「已驳回」三个字等于没回复。
4. **未绑定不猜人**：`users.employee_id` 为空时所有自助接口都不返回个人数据，
   只在绑定页提示人事去绑。库里有 10 个账号一个都对不上员工档案，按姓名猜必然出错。

## 客户进度发布（`/api/customer-progress` + `/api/mall/*/progress`）

> 内部照常报工，**客户只看业务主动发布过的快照**。三条路线：本厂 / 裁片外发 / 整单外发。
> 权限：`custprogress.read`（admin/boss/sales/tech/production）、`custprogress.publish`（admin/sales）、
> `custprogress.route`（admin/sales/production）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/customer-progress/meta | read | 字典（三条路线及各自阶段、统计） |
| GET | /api/customer-progress/orders?q= | read | 待发布订单（含内部进度、路线、`published`、`live_version`、`stale`） |
| GET | /api/customer-progress/orders/:id/internal | read | 内部真实进度（阶段 + 外发交出/回货/验收 + `blockers` + 隐藏字段清单） |
| GET | /api/customer-progress/orders/:id/preview?show_qty= | read | 客户将会看到什么（含 `completion_label`、`hidden`、`rule_note`） |
| GET | /api/customer-progress/orders/:id/history | read | 版本历史（含撤回人与理由） |
| POST | /api/customer-progress/orders/:id/publish | publish | 发布：`{show_qty?, note?}`，自动撤回旧版，版本 +1；返回 `warnings` |
| POST | /api/customer-progress/publications/:id/withdraw | publish | 撤回：`{reason≥4字}` |
| PUT | /api/customer-progress/orders/:id/route | route | 指定路线：`{route, note}`，记为 `manual` |
| GET | /api/mall/progress | 客户 | 我的订单进度列表（**只含已发布**） |
| GET | /api/mall/orders/:id/progress | 客户 | 某单进度快照；未发布返回 `{published:false}`，别家订单 403 |

**阶段模型**

| 路线 | 阶段 | 判定依据 |
|---|---|---|
| `inhouse` 本厂 | 备料 → 裁剪 → 车缝 → 后整 → 检验 → 发运 | 内部工序节点全部 `done` |
| `cut_outsource` 裁片外发 | 备料 → 裁剪 → **外发加工** → 后整 → 检验 → 发运 | `cut_dispatches.out_qty > 0` 自动判定 |
| `full_outsource` 整单外发 | **外发加工** → 检验 → 发运 | 人工指定 |

工序 → 阶段映射：`备料/排版算料 → 备料`；`裁剪 → 裁剪`；`车缝/锁眼钉扣/印花/绣花/水洗 → 车缝`；
`整烫/包装/成品入库 → 后整`；`检验 → 检验`；`出库发运 → 发运`。

**三条硬口径**

1. **外发没回齐就不能说完工**：`can_complete` 由服务层算，要求所有阶段 `done`；
   裁片外发还要求 `returned_qty >= out_qty`。不满足时客户快照里**没有** `completed/completion_label` 字段。
2. **客户读快照不读表**：发布写入 `progress_publications.snapshot`（JSON），客户接口只读它。
   快照里只有 `key/label/status/status_label/done_at/seq`（可选 `qty_ok`），
   **不含**外发厂名、加工单价、返工数、工人姓名、内部备注。
3. **撤回留版本**：不删行，状态转 `withdrawn` + 写撤回人/时间/理由；同一订单同时只允许一个 `published`
   （部分唯一索引兜底）。

**发布时会挡的自相矛盾**

- 路线为外发但**没有任何外发记录** → 警告「客户会看到外发未开始，路线是否选错」
- 外发未开始但后整/检验/发运已有进度 → 警告「客户看到会自相矛盾」

发布本身不阻断（业务可分阶段对外），但 `warnings` 必须回给发布人。

## 售后与对账资料（`/api/after-sales` + `/api/statement-files` + 商城客户侧）

> 客户自助提售后，内部受理后**五条轨道各自独立**推进：退款 / 实物实收 / 质量检验 / 再上架 / 追偿。
> 权限：`aftersale.read`（admin/boss/sales/quality/production/warehouse/finance）、
> `aftersale.write`（admin/sales/quality/production/warehouse）、`aftersale.refund`（**仅 admin/finance**）、
> `statementfile.read`（admin/boss/finance/sales）、`statementfile.publish`（**仅 admin/finance**）。

### 售后单（内部）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/after-sales/meta | read | 字典（6 类原因 / 4 种处理方式 / 5 条轨道状态 / 追偿对象）+ 统计 |
| GET | /api/after-sales?status=&customer_id=&overdue=&q= | read | 清单。`status=open` 只看未结案；排序按状态（待受理在前） |
| GET | /api/after-sales/:id | read | 详情：五轨状态 + 退货单 + 明细 + 照片 + `settle_blockers` |
| POST | /api/after-sales | write | 内部代提（客户打电话投诉时业务代开） |
| POST | /api/after-sales/:id/accept | write | 受理：`{owner_role, due_date}`。**退货/返修会自动生成退货单草稿** |
| POST | /api/after-sales/:id/reject | write | 驳回：`{reason}` ≥6 字（客户拿到「已驳回」三个字等于没回复） |
| POST | /api/after-sales/**refund**/:id | **refund** | 登记退款：`{amount, method, note, goods_returned}` |
| POST | /api/after-sales/:id/recovery | write | 追偿：`{party, amount, note}` 或 `{waive:true, note}` |
| POST | /api/after-sales/:id/settle | write | 结案：`{conclusion}` ≥8 字，**三个前置条件见下** |
| POST | /api/after-sales/:id/note | write | 加备注 |

> 退款路径是 `/refund/:id` 而不是 `/:id/refund`：`GUARDED` 是**前缀匹配**，
> 独立一段才能精确挂锁（`{perm:'aftersale.refund', method:'POST', prefix:'/api/after-sales/refund'}`），
> 否则会把受理、结案一起锁成「只有财务能点」。

### 对账文件（内部）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/statement-files/meta | read | 状态与类型字典 |
| GET | /api/statement-files?customer_id=&status=&kind= | read | 清单（不含快照体积） |
| POST | /api/statement-files/generate | publish | 生成草稿：`{customer_id, period \| period_from+period_to, kind}` |
| GET | /api/statement-files/:id | read | 详情（含快照） |
| POST | /api/statement-files/:id/publish | publish | 授权发布：`{expire_at?}`。**check_diff≠0 直接 400** |
| POST | /api/statement-files/:id/revoke | publish | 撤销：`{reason}` ≥4 字 |
| GET | /api/statement-files/:id/preview.csv | read | 内部预览（不计入客户下载次数） |

### 客户侧（商城）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/mall/after-sales/options | order.view | 可提售后的订单与明细（含每行 `claimed` / `available`） |
| GET | /api/mall/after-sales | order.view | 我的售后（**不含追偿与内部负责人**） |
| GET | /api/mall/after-sales/:id | order.view | 我的售后详情（别家 403） |
| POST | /api/mall/after-sales | order.view | 提交：`{order_id, order_item_id, qty, reason_code, resolution, reason, amount_claim, photos[]}` |
| POST | /api/mall/after-sales/:id/cancel | order.view | 撤销（**仅待受理**；已受理要联系业务） |
| GET | /api/mall/statements | finance.view | **只返回已授权且未过期**的文件 |
| GET | /api/mall/statements/:id/download | finance.view | 下载 CSV（带 BOM）；撤销/过期/别家 → 400/403 |

`customer_id` 一律取自登录态，**不接受请求体里的 customer_id**（防越权给别家开单）。

### 五条轨道

| 轨道 | 存储 | 状态值 |
|---|---|---|
| 退款 | `after_sale_tickets.refund_*` | none / pending / paid |
| 实物实收 | **从关联退货单实时算** | none / pending / received / partial / cancelled |
| 质量检验 | **实时算** | none / pending / passed / partial / failed |
| 再上架 | **实时算** | none / pending / done |
| 追偿 | `after_sale_tickets.recovery_*` | none / pending / done / waived |

### 五条硬口径

1. **退款不直接恢复库存**：`refund()` 不调 `applyStock`；库存只由仓库检验步骤写。
2. **实收/检验/再上架不存副本**：存了副本，售后页与仓库页必然说两个数。
3. **同一订单行 + 同原因 + 同处理方式，处理中只能一条**（部分唯一索引兜底），客户连点不会生成五张单。
4. **金额两道闸**：索赔 ≤ 订单行货款；退款 ≤ 索赔；追偿 ≤ 退款。
5. **结案三前提**：退货类实物已关单、要退钱的已退款、结论 ≥8 字。

### 对账文件的三条硬约束

1. **定版快照**：发布时把 `statement.build()` 的结果存进 `snapshot`，客户下载的就是它；内部账后续变动不追溯。
2. **不平不许发**：`check_diff ≠ 0` 说明有发票的已收金额被手工改过、或有收款没走流水 —— 先自己查清。
3. **每次下载留痕**：写 `doc_access_logs`（`doc_type='statement_file'`，`operator_role='customer'`）。

> 为什么对账 CSV 单独给「原币金额」列：外贸客户是拿 USD 下的单，只看人民币会觉得金额不对。
> 记账金额是本位币，原币列由逐笔的 `amount_orig + currency` 带出。

## 办公耗材与服务采购（`/api/office-supply`）

> 办公用品有**自己的仓**（`office_stock` / `office_ledger`），与生产材料仓、成品仓没有任何写入口。
> 采购验收时一次做完三件事：耗材入库、耐用品转资产、费用入账，三者互不重复。
> 权限：`office.read`（全角色）、`office.apply`（除老板外全角色，申领与领用）、
> `office.manage`（admin / hr / finance，采购与档案）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/office-supply/meta | read | 字典（分类 / 状态 / 物品 / 部门）+ 统计 |
| GET | /api/office-supply/board?category=&q= | read | 办公仓看板：库存、最低库存、`low`、`suggest_qty`、耐用品标记 |
| GET | /api/office-supply/low-stock | read | **最低库存缺口 + 建议量，不生成采购单** |
| GET | /api/office-supply/ledger?item_id=&type=&month= | read | 收发流水（入库为正、领用为负） |
| POST | /api/office-supply/items | manage | 建 / 改物品档案（耐用品必须填资产分类） |
| GET | /api/office-supply/requests?status=&dept_id=&q= | read | 申领清单（含 `merged` 已合并到的采购单、`short` 库存不足标记） |
| GET | /api/office-supply/requests/:id | read | 申领详情（含每行库存、部门本月已领、月限额） |
| POST | /api/office-supply/requests | apply | 建申领：`{dept_id, requester, purpose, items[], submit, exception_reason}` |
| POST | /api/office-supply/requests/:id/submit | apply | 提交（再过一遍三道闸） |
| POST | /api/office-supply/requests/:id/approve | manage | 审批：`{items:[{id, qty_approved}]}`，可砍量 |
| POST | /api/office-supply/requests/:id/reject | manage | 驳回：`{reason}` ≥6 字 |
| POST | /api/office-supply/requests/:id/issue | apply | **出库：真正扣库存并写流水** |
| POST | /api/office-supply/requests/:id/return | apply | 退回：`{items:[{id, qty}], reason}` |
| GET | /api/office-supply/purchases?status=&kind=&q= | read | 采购清单（区分物品 / 服务） |
| GET | /api/office-supply/purchases/:id | read | 详情：明细归属（耗材→费用 / 耐用品→资产 / 服务→费用）+ 来源申领 |
| POST | /api/office-supply/purchases | manage | 建单：`{kind, supplier, dept_id, items[]}` 或 `{request_ids[]}` 从申领合并 |
| PUT | /api/office-supply/purchases/:id/prices | manage | 填单价（合并来的单默认没价） |
| POST | /api/office-supply/purchases/:id/approve | manage | 审批（**金额为 0 直接 400**） |
| POST | /api/office-supply/purchases/:id/order | manage | 标为已下单 |
| POST | /api/office-supply/purchases/:id/receive | manage | **验收：入库 / 转资产 / 生成费用 + 占预算，一次做完** |
| POST | /api/office-supply/purchases/:id/cancel | manage | 撤销（已验收不行），释放合并的申领 |

### 验收时的金额怎么分

| 明细类型 | 去哪 | 进 `admin_expenses` |
|---|---|---|
| 耗材 `durable=0` | `office_stock` 入库 + `office_ledger` 记 in | **是** |
| 耐用品 `durable=1` | `assets` 逐件建卡（一物一码），`office_purchase_items.asset_id` 回填 | **否** |
| 服务 `line_type=service` | 无库存 | **是**（验收即计费，没验收就不该有这笔钱） |

生成的费用单：`category='办公'`（物品）或 `'服务采购'`，`remark` 里带采购单号与「耐用品 X 已转资产，不在本条」，
并按 `dept_id` 调 `budget.commit()` 占额度。采购单没有归属部门时**费用照记但预算占不上**，接口会在 `note` 里点名。

### 五条硬口径

1. **办公领用不碰生产仓**（原型原话）：`office_*` 与 `stock_items`、`materials`、`material_ledger` 无写入口。
2. **耐用品转资产就不当耗材费用化**（原型原话）：按 `durable` 分两边算，金额不重叠。
3. **验收与费用同源**（原型原话）：验收即生成费用并占预算，不需要行政再手工录一遍。
4. **最低库存只提示**（原型原话）：返回 `suggest_qty` 但不建单 —— 自动补货等于在没人核价的项目上自动花钱。
5. **申领三道闸**：库存不足拦、同人同物品未结拦、超部门月限额要写例外说明（≥6 字）才放行。

> 耐用品**不走耗材申领**：它验收即转资产、永远没有库存，混进申领会「从空仓里扣出负数」。
> 耐用品的领用登记在「资产台账」（一物一码、记保管人）。

## 资产工衣与领归（`/api/custody`）

> 这一组接口只回答一件事：**东西在谁身上，什么时候该回来**。
> 固定资产（`assets`）管价值与折旧，办公仓（`office_*`）管入库与申领，
> 这里管「人身上的实物」—— 工衣、钥匙、门禁卡、工具、劳保。
>
> 权限：`custody.read`（全角色）、`custody.issue`（admin/hr/warehouse，发放与回收）、
> `custody.manage`（admin/hr，档案与处置）、`custody.claim`（admin/hr/finance，定责）、
> `custody.finance`（admin/finance，**确认定责金额**）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/custody/meta | read | 字典（类别 / 状态 / 归还要求 / 处置方式 / 员工 / 部门）+ 统计 |
| GET | /api/custody/board | read | 看板：在手上、逾期、不催退回、待复核、待财务确认 + 最近动作 |
| GET | /api/custody/items?kind=&status=&q= | read | 实物档案（含 `available` 可发量、`holder` 在谁手上、`asset_net` 读自资产台账） |
| POST | /api/custody/items | manage | 建 / 改实物档案；**一物一码在册数量只能 1** |
| POST | /api/custody/scrap/:id | manage | 处置：`{scrap_mode, scrap_no, note}`；挂资产卡的实物**拒绝**（去资产台账报废） |
| POST | /api/custody/restore/:id | manage | 损坏件修好后恢复可用：`{note}`（处理结果必填） |
| GET | /api/custody/items/:id/timeline | read | 某实物的领用历史 + 动作日志 |
| GET | /api/custody/records?status=&kind=&employee_id=&item_id=&overdue=1&q= | read | 领用台账（`status=open` 只看在手上；含 `overdue_days`） |
| GET | /api/custody/records/:id | read | 详情（含复核单、动作时间线、转交来源） |
| POST | /api/custody/records | issue | 登记领用：`{item_id, employee_id, qty, expected_return_at, handover_by, note, draft}` |
| POST | /api/custody/records/:id/publish | issue | 草稿发放（**这一刻才占实物**，全部硬校验在这里做） |
| POST | /api/custody/records/:id/return | issue | 归还：`{condition, qty, claim_amount, note}`；损坏/遗失自动生成复核单 |
| POST | /api/custody/records/:id/transfer | issue | 转交：`{to_employee_id, note, expected_return_at}` = 原单归还 + 新单发放 |
| GET | /api/custody/person/:employeeId | read | 某人身上挂着什么（在手的、历史、复核汇总） |
| GET | /api/custody/overdue | read | 超期清单（只算有期限且要求归还的） |
| GET | /api/custody/clearances?status= | read | 清退单清单（含明细、必须/可选 完成数） |
| POST | /api/custody/clearances | manage | 发起离职/调岗清退：`{employee_id, leave_date, reason}`；同一人已有进行中的单则复用 |
| POST | /api/custody/clearances/:id/close | manage | 结案（必须归还的没回来 → 400；工衣未退不拦） |
| GET | /api/custody/claims?review_status=&employee_id=&q= | read | 损坏复核清单 |
| POST | /api/custody/claims | claim | 手工登记损坏/遗失（归还时自动生成的不需要调这个） |
| POST | /api/custody/review/:id | claim | 复核结论：`{decision(cleared/partial/liable), liable_pct, reviewer_note}` |
| POST | /api/custody/finance/:id | finance | 财务确认：`{finance_confirm_no, finance_note}`，**回执号必填** |

### 六个口径

1. **「一物一码」与「必须归还」是两个字段**。`durable=1` 表示同一时间只能一个人在手上（唯一索引
   `uq_custody_open_item` 兜底）；`require_return=0` 表示不设期限、不进超期清单。
   工衣是「一物一码但不强制退回」—— 两个字段合成一个，所有工衣都会变成逾期。
2. **没有期限就不是逾期**。超期只认 `expected_return_at < 今天` 且未归还；
   `require_return=0` 的记录即使传了日期也会被清空。
3. **已领出量不存冗余列**，一律从领用记录聚合：`SUM(qty − returned_qty) WHERE status IN ('issued','awaiting')`。
4. **损坏归还的实物冻结**（`status='hold'`，可发量 0、发料 400），修好走 `restore`，修不好走 `scrap`；
   **遗失归还自动核销**（`scrapped` + `write_off`，参考复核单号）。
5. **判责与收钱分两层**：`review` 只写责任比例与定责金额；`finance` 必须有回执号才算落地。
   本模块**没有任何写工资 / 应付 / 凭证的语句**。
6. **处置不能两边各自报废**：挂了 `asset_id` 的实物在本模块拒绝处置，必须回资产台账报废弃；
   折旧口径只在 `services/assetDep.js` 一处，行政页只读不重算。

### 状态机

`custody_records.status`：`draft` 草稿（不占实物）→ `issued` 使用中 → `awaiting` 待归还（清退时生成）
→ `returned` 已归还 / `lost` 遗失 / `written_off` 已核销。

`custody_items.status`：`active` 在册 → `hold` 损坏待处理（不可发）→ `active`（恢复）或 `scrapped` 已处置。

## 行政运营报表（`/api/admin-ops`）

> 八项固定指标：宿舍入住率、床位与押金、行政费用、饭卡资金、资产与实物领归、
> 耗材收发结存、行政预算差异、工单超时与复验。**只读业务表**，只写自己的两张表
> （`admin_report_runs` 定版快照 / `admin_report_findings` 差异清单）。
>
> 权限：`adminops.read`（全角色，汇总）、`adminops.detail`（admin/hr/finance，人名与下钻）、
> `adminops.run`（定版）、`adminops.review`（分派 / 处理 / 复核关闭 / 忽略）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/admin-ops/meta | read | 指标字典、严重度、差异状态、主体列表、可选期间 |
| GET | /api/admin-ops/preview?period=&company_id= | read | **实时计算**整份报表（不落库），含 `coverage` 未覆盖说明 |
| POST | /api/admin-ops/run | run | 定版：冻结八项指标与口径 + 生成差异清单；同期已定版需 `force:true` |
| GET | /api/admin-ops/runs?period=&company_id= | read | 历史版本列表（同一期间可有多版） |
| GET | /api/admin-ops/runs/:id | read | 某版详情：`snapshot`（八段指标）+ `basis`（口径）+ 差异 |
| GET | /api/admin-ops/findings?run_id=&status=&metric=&severity= | read | 差异清单（按严重度排序） |
| POST | /api/admin-ops/assign/:id | review | 分派：`{assignee, due_date}` |
| POST | /api/admin-ops/review/:id | review | 处理：`{review_note}` → 状态 `fixed` |
| POST | /api/admin-ops/close/:id | review | 复核关闭：`{review_note}`；**必须先 `fixed`** |
| POST | /api/admin-ops/ignore/:id | review | 忽略：`{reason}` ≥6 字（不等同关闭） |
| GET | /api/admin-ops/drill?metric=&period=&company_id= | read（detail 才看全名） | 下钻该指标的源单；无 `detail` 权限时姓名服务端掩码，`masked=true` |

### 八项指标的口径

| 指标 | 分子 / 分母 | 算不出来时 |
|---|---|---|
| 宿舍入住率 | 住用床日 / 可用床日 | 无可用床日 → `null`（显示「—」） |
| 可用床日 | 可用床数 × 期间天数；维修床与整间封房都扣 | 期内临时维修无历史区间 → 写进 `coverage` |
| 费用 | `admin_expenses` 期间合计 | 无 |
| 饭卡 | 账户余额合计 vs 流水 `personal_delta` 合计 | 无流水 → 消费/补贴给 0 并写明 |
| 耗材结存 | `office_stock.qty` vs `SUM(office_ledger.qty)` 逐项 | 无流水 → 结存为时点数 |
| 预算差异 | 人事行政部预算 vs 该部门已入账费用 | 无生效预算 → 明说「无法计算」 |
| 工单准时率 | (总数 − 超期) / 总数 | 样本 < 3 → `null` |
| 复验率 | 有 `verified_at` / 已进入提交 | 无提交工单 → `null`；样本 < 3 → `null` |

### 五条硬规则

1. **不拿人数除床数**（原型原话）：入住率分子分母都是「床日」。
2. **费用只认已入账事实**，不含预算占用（占用是承诺，不是花掉的钱）。
3. **对账恒等式的差异不许「调平」**：饭卡只能走 `adjust` 留痕；办公仓库存不能绕过流水改。
4. **两段式复核**：`fixed`（处理完）→ `closed`（别人复核）；`ignored` 必须写理由。
5. **汇总可见、明细限权**：无 `adminops.detail` 时住宿/饭卡人名在服务端掩码，不是前端藏。

### 复用的口径

床日计算在 `services/bedDays.js`，`GET /api/facility/dorm/occupancy` 与报表共用同一份 ——
两个页面各算一遍的结果是可预期的：开会先花二十分钟争论哪个数对。

## 薪酬计件与工资核对（`/api/payroll-check`）

> 只做一件事：**工资单里的计件数，能不能对回已确认的核算单**。
> 应发/个税/实发用 `services/payrollCalc.js` **独立重算**再与库里存的比；
> 差额**不自动改工资单**，只能登记下一期生效的调整单。
>
> 权限：`paycheck.read`（admin / boss / hr / finance —— 工资数据连读都限岗）、
> `paycheck.run`（生成核对批次）、`paycheck.fix`（登记差异 / 写说明 / 完成核对）。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | /api/payroll-check/meta | read | 状态、差异类型、主体（含本位币）、可选期间 |
| GET | /api/payroll-check/preview?period=&company_id= | read | 实时核对（不落库），含 `batch_issues` 与 `coverage` |
| POST | /api/payroll-check/run | run | 生成核对批次（落库）；已完成的期间重跑需 `force:true` |
| GET | /api/payroll-check/runs?period=&company_id= | read | 历史批次 |
| GET | /api/payroll-check/runs/:id | read | 批次详情（含逐人核对行与 issues） |
| GET | /api/payroll-check/sources?run_id=&employee_id= | read | 该员工本期计件来源明细（报工级） |
| POST | /api/payroll-check/diff/:itemId | fix | 登记差异：`{amount, period, reason}` → 生成 `payroll_adjustments` |
| POST | /api/payroll-check/annotate/:itemId | fix | 写核对说明（不改钱） |
| POST | /api/payroll-check/review/:id | fix | 完成核对（有未处理差异 → 400） |

### 每行结论怎么来

| 结论 | 触发条件 |
|---|---|
| `ok` 核对一致 | 计件一致、应发/个税/实发与重算一致 |
| `diff` 有差异 | 计件金额不符 / 应发或实发或个税与重算不符 / 工资单有计件但批次无来源 |
| `missing` 缺工资单 | 批次里有计件，本期没有工资单 |
| `policy` 政策待配 | 主体本位币非 CNY（只核对来源与金额，不判税社保） |

提示类（不影响结论）：调整单本期待带入、已带入调整单未体现、报销/借款混入、员工已离职。

### 六条口径

1. **计件只认 `status='confirmed'` 批次**；库里部分唯一索引保证同期只有一个已确认批次，
   服务层另有 `multi_run` 报警防迁移导入。
2. **独立重算**：公式在 `payrollCalc.js`，`routes/payrolls.js` 与核对共用同一份。
3. **差额不改工资单**：登记差异生成 `payroll_adjustments`（`item='piece_wage'`，状态 pending，
   `source_period` 记来源期）；冒烟断言登记后工资单原值未变。
4. **缺工资单默认补发**（金额取 `piece_expected` 正数），不是扣回。
5. **境外主体不套国内口径**。
6. **完成核对前必须逐行处理**（登记调整单或写说明），否则 400 列出未处理的人。
