# 数据库结构（SQLite）

> 文件：`backend/data/erp-mindmap.db`（WAL 模式）。表结构统一放在 `backend/src/schema.js`（从实际库导出的 SQL 快照，由 `scripts/rebuild-schema.js` 生成），`db.js` 启动时执行建表；老库补列见 `db.js` 的 `migrate()`。
>
> 改了表结构后的流程：先执行 DDL → `node scripts/rebuild-schema.js` 刷新快照 → 重启服务。

## 数据库边界（先看这段，再看表）

- **本期就是 SQLite 单文件、单实例**。业务表 **359 张**、索引 432 个；`db.prepare` 4655 处、显式事务 204 处。
  **不具备"改两个函数就迁 MySQL"的条件**，迁移须按 `deploy/DEPLOY.md` §9.3 的分阶段方案做。这一节存在的原因：
  早期版本（纯脑图）数据只有 `app_config` 一张表，老文档据此写过"只需改两个函数"，那句话对现在的库已经不成立。
- **结构版本可追踪**：启动时算出 `schema.js` 内容指纹写入 `schema_migrations`（版本 / 表数 / 索引数 / 补列数 / 时间），
  `/api/health` 会带出 `schema.version` 与规模。同一个库被哪份快照打开过，有据可查。
- **结构不完整就不启动**：建表、补列、建索引任一失败，进程直接退出并列出失败语句（不再"警告后继续跑"）——
  带着缺表缺列的库对外服务，比起不来更危险。
- **`company_id` 不是租户隔离键**：72 张表带这个字段，口径是"集团内哪个法人主体"，用于合并报表与分部对比；
  登录不按公司限制。一个实例服务一家集团（可含多个法人主体），不能当 SaaS 给多家客户共用。
- **数据范围（截至 v1.61）**：`access/companyScope.js` 定规则（默认只看 `users.company_id`，集团角色 admin/boss 跨主体），
  **已接入四个域**：订单域（列表 / 导出 / 统计 / 详情 / 单据页 / 扫码 / 改号 / 图片 / 流转 / 批量 / 回退）、
  应收应付域（往来账总览 / 账龄 / 应收应付列表 / 新建 / 作废 / 收付款 / 核销 / 红冲 / 未结清单 /
  应付台账 / 付款计划 / 供应商明细 / 应收催收）、库房单据域（领料单 / 退料单 / 盘点单的列表、详情、
  建单与全部动作；订单备料建议）、生产执行域（报工明细与汇总、工序节点列表/弹窗/推进/初始化/删除、
  从看板分配、生产看板、订单跟踪看板含统计卡片）。写入侧同步落主体（`writeCompanyOf`），
  并强制「一笔收付款只结一个主体的账」；**挂在订单上的表一律按 `order_id` 判归属**（`orderOwnedSql`）。
- **库存要分两层看**：`materials` / `stock_items` / `stock_ledger` / `office_stock` **没有** `company_id` ——
  一个仓库里真实有多少是物理事实，一桶染料不会因为换个法人主体就变成两桶，所以**存量层不分主体是刻意的**；
  `material_issues` / `material_returns` / `stocktakes` 有这一列，**单据层按主体**。
  要按主体分仓（各主体独立库存），需要给这几张表加列并迁移，不在本期。
  **其余域未接入**（生产报表 / 采购 / 人事 / 资产 / 集团报表 / 资金计划 / 对账单 / 导出），这些页面仍能跨主体读。
  冒烟现有 48 条断言覆盖四个域；没有 `company_id` 列的表（采购单、催收任务、工序节点、报工、裁床单）
  按归属表达式推主体，推不出来归默认主体 1。


## 组织与账号
| 表 | 关键字段 |
|---|---|
| companies | id, code, name |
| departments | id, company_id, name |
| users | id, username, password_hash(scrypt), name, role, company_id, department_id, active |

角色：`admin / sales / tech / finance / production / warehouse / viewer`

## 主数据
| 表 | 关键字段 |
|---|---|
| customers | id, code, name, contact, phone, email, level, credit_limit, status |
| products | id, sku, name, category, unit, price, status |
| materials | id, type(fabric/accessory), code, name, **short_name(简称), color, color_no, image_url, width(幅宽), weight(克重), air_gap(空差), composition(成份), unit, supplier_info, stock_qty, stock_detail, remark**, spec, supplier, status |
| size_templates | id, name, sizes(逗号分隔) |
| price_tiers | id, product_id, min_qty, max_qty(NULL=无上限), price_usd —— 阶梯报价，命中规则：min_qty ≤ qty ≤ max_qty，取 min_qty 最大者 |

## 订单
| 表 | 关键字段 |
|---|---|
| orders | id, order_no, type(custom/stock), customer_id, status, rate, total_usd, total_amount, currency, style_name, cus_order_no, manager, order_date, delivery_method, packaging, trade_terms, shop_name, shop_order_no, delivery_days, freight, image_url, delivery_date, remark, created_by |
| order_items | id, order_id, product_id, product_name, style_no, sku, remark, qty, amount_usd, amount_cny |
| order_item_sizes | id, item_id, color, size, qty, usd_price, cny_price, amount_usd, amount_cny |
| order_logs | id, order_id, from_status, to_status, operator, note |
| order_crafts | id, order_id, name, qty, price, rate, fob_price, is_out, is_wash, is_cut, instruction |
| order_materials | id, order_id, material_id, type, name, unit, one_use, loss, total_use, price, amount, spec, ingredient, supplier, mat_color |
| order_nodes | id, order_id, name, seq, status(pending/doing/done), plan_date, actual_date, operator |
| production_reports | id, order_id, node_id, node_name, report_date, qty_ok, qty_defect, hours, operator |
| factories | id, code, name, type(own/outsource), contact, phone, address, status |
| dispatch_orders | id, order_id, factory_id, factory_name, type(own/outsource), qty, price, status(dispatched/settled), remark |
| attachments | id, target_type(order/techpack), target_id, filename, url, size, mime, uploader |
| employees | id, code, name, department_id, position, phone, hire_date, status(active/left), remark |
| leave_requests | id, employee_id, employee_name, type(annual/sick/personal/other), start_date, end_date, days, reason, status(pending/approved/rejected), reviewed_by |
| collection_tasks | task_no, customer_id, customer_name, owner_user_id/username/name, **owner_source**(profile/order/manual/none), **overdue_amount(生成时快照)**, **remaining(上次刷新值，读取时实时重算)**, invoice_count, max_overdue_days, oldest_due, promise_date/amount/at, **promise_count / promise_broken**, level(D1~D4), status(open/following/promised/escalated/closed), next_follow_at, follow_count, closed_reason/note/at/by | **一个客户一张任务**。`closed_reason=paid` 且未收为 0 时由 `syncPaidStatus` 自动结案。`promise_broken` 是事实标记，升级后仍保留 |
| collection_task_items | task_id, invoice_id, bill_no, due_date, **open_at_create(挂单时快照)**, open_now, settled_at | 唯一索引 `(task_id, invoice_id)`。剩余额每次从未付发票重算，**不靠这一列判定** |
| collection_logs | task_id, channel(phone/wechat/email/visit/letter/other), contact, result(no_answer/promised/refused/partial/dispute/other), promise_date, promise_amount, note, operator | 跟进流水。`promised` 的日期与金额由服务层强制成对 |
| payment_requests | req_no, supplier_id, supplier_name, **amount(=明细合计，禁止手填)**, currency, plan_pay_date, method, bank_account_id, status(draft/submitted/approved/paid/cancelled), reason, remark, approval_instance_id, **payment_id**, created_by, submitted_at, decided_at/by, paid_at/by, created_at/updated_at | **付款申请单**。`approved` 之后才允许 `pay`；`paid` 不可取消；驳回退回 `draft`（不是作废），改完能再提交 |
| payment_request_items | request_id, invoice_id, bill_no, due_date, **open_amount(申请时未付快照)**, amount, created_at | 唯一索引 `(request_id, invoice_id)`。**未完成状态（draft/submitted/approved）会占用该发票的未付额**，`available = 未付 − 占用` |
| payments.payment_request_id | INTEGER | 付款流水反查来源申请单。有它就说明这笔钱走过审批，可直接追溯「谁申请的、谁批的」 |
| suppliers.term_days | INTEGER | 账期天数（`payment_terms` 文本解析后的缓存，可手工覆盖）。**到期日 = 开票日 + 本值**；为空表示读不出账期，此时应付到期日留空、不猜 |
| credit_limits | customer_id, credit_limit, credit_days, old_limit, old_days, reason, operator, created_at | **额度版本历史**。现值仍在 `customers.credit_limit` / `credit_days`，这里留每次调整（谁、何时、为什么、从多少到多少） |
| credit_holds | customer_id, action(hold/release), reason, exposure_snapshot, operator, created_at | 冻结/解冻流水。`exposure_snapshot` 记冻结那一刻的敞口，事后复盘「冻得对不对」 |
| credit_overrides | order_id, customer_id, limit_snapshot, exposure_snapshot, order_amount, block_reasons(JSON), reason, operator, created_at, **used_at, used_by** | **发货放行单**。`used_at` 非空即已用；一张只能用一次（靠 `used_at IS NULL` 判断，不建唯一索引也能守） |
| customers.credit_days / credit_status / credit_hold_reason / credit_updated_at | REAL / TEXT / TEXT / TEXT | 账期天数（到期日 = 开票日 + N 天）、`active`/`hold`、冻结原因、额度最后变动时间 |
| audit_logs | id, username, method, path, status, ip, created_at, **seq, prev_hash, hash, module, module_group, action, target, summary, actor_role, duration_ms**；`hash = sha256(prev_hash|seq|账号|方法|路径|状态|时间)`，**改任一字段即断链**；语义列可重算、不参与哈希 |
| audit_chain_state | id(恒为 1), last_seq, last_hash, anchor_seq, anchor_hash, updated_at；**删日志不动这张表** —— 最大 seq < last_seq 即尾部被删；归档推进 anchor 以区分「合法移除」与「偷删」 |
| audit_archives | archive_no, from_seq, to_seq, rows, first_hash, last_hash, file, file_sha256, cutoff, note, created_by, created_at；归档只切**连续前缀**，否则剩余行 seq 断档、之后每次校验都报「头部不连续」 |
| approval_flows | id, name, target_type(cost), min_amount, max_amount, steps(JSON[{role,name}]), active |
| approval_instances | id, target_type, target_id, flow_id, current_step, status(pending/approved/rejected) |
| approval_tasks | id, instance_id, step_no, role, step_name, status, approver, remark, acted_at |
| attendance | id, employee_id, employee_name, date, check_in, check_out, status(normal/late/leave/absent), remark；唯一(employee_id,date) |
| purchase_orders | id, po_no, supplier, status(draft/ordered/received/cancelled), order_date, expect_date, total_amount, remark |
| purchase_items | id, po_id, material_id, name, spec, unit, qty, received_qty, price, amount |

## 报价单
| 表 | 关键字段 |
|---|---|
| quotations | id, quote_no(QT+日期+序号), customer_id, status(draft/sent/accepted/rejected/converted), rate, total_qty, total_usd, total_amount, valid_until, trade_terms, delivery_days, remark, order_id(转订单后回填), created_by |
| quotation_items | id, quote_id, product_id, product_name, sku, qty, price_usd, amount_usd, amount_cny, tier_id(命中的阶梯，手工价为 NULL), remark |

## 开发 / 财务
| 表 | 关键字段 |
|---|---|
| customers / factories / employees | 均含 **image_url**（档案图片，支持粘贴上传） |
| tech_packs | id, order_id, product_name, version, fabric_info, accessory_info, craft_info, customer_req, fabric_ids, accessory_ids, size_spec, image_url, stage(draft/material/pattern/craft/sample/biz/confirmed), status(draft/confirmed/rejected), confirmed_by, **customer_style_no, designer, pattern_maker, pattern_no, category, label_name, series, wave, sales_owner, po_no, brand, colors, size_range, delivery_date** |
| suppliers | id, code, name, short_name(简称), category(material/process/service/other), contact, phone, address, payment_terms(结算方式), lead_days(交期天数), image_url, remark, status |
| craft_types | id, code, name, category(sewing/print/embroidery/wash/finish/pack/other), unit, default_price(默认单价), is_out(默认外发), image_url, remark, status, sort |
| pattern_flows | id, tech_pack_id(unique), order_id, current_stage, status(running/done/cancelled), started_at, finished_at |
| pattern_stages | id, flow_id, stage(material/pattern/craft/sample/biz/audit), status(pending/doing/done), owner, work_hours, actual_hours, due_date, price, pattern_size, label_name, remark, data(JSON), operator, started_at, finished_at |
| sample_archives | id, archive_no(unique), tech_pack_id, order_id, style_no, sample_name, version, pattern_size, customer, snapshot(JSON 快照), image_url, status(locked/changing/revised), locked_at, created_by |
| sample_change_requests | id, archive_id, reason, detail, applicant, status(pending/approved/rejected), reviewer, reviewed_at, review_note, new_archive_id |
| tech_pack_materials | id, tech_pack_id, **material_id(来源档案，档案字段只读)**, mat_type(fabric/accessory), colorway, **use_part(使用部位)**, material_name, color_no, supplier, supplier_info, spec_info, composition, unit, one_use, loss_rate, air_gap, unit_price, amount, fabric_param, remark, image_url, color_card_url, sort |
| tech_pack_sizes | id, tech_pack_id, part(部位), size(尺码), value, tolerance, sort |
| tech_pack_requirements | id, tech_pack_id, category(craft/packing/test/note), content, sort |
| sample_requests | id, order_id, style_no, type, status, developer, due_date |
| cost_sheets | id, order_id(unique), material_cost, accessory_cost, labor_cost, overhead_cost, other_cost, total_cost, profit_rate, factory_price, status(draft/pending/approved/rejected), reviewed_by, review_opinion |

## 库存
| 表 | 关键字段 |
|---|---|
| stock_items | id, warehouse(cn/us), style_no, product_name, color, size, qty；唯一键 (warehouse,style_no,color,size) |
| stock_ledger | id, warehouse, style_no, color, size, type(in/out/adjust/transfer_in/transfer_out), qty, ref_type, ref_id, operator |

## 人事 / 行政
| 表 | 关键字段 |
|---|---|
| employees | id, code, name, department_id, position, phone, hire_date, status(active/left), **base_salary**（薪酬核算取此字段）, remark |
| attendance | id, employee_id, date, check_in, check_out, status(normal/late/leave/absent)；唯一键 (employee_id,date) |
| leave_requests | id, employee_id, type, start_date, end_date, days, status(pending/approved/rejected) |
| payrolls | id, period(YYYY-MM), employee_id, employee_name, department, base_salary, work_days, actual_days, leave_days, absent_days, overtime_hours, overtime_pay, bonus, allowance, deduction, social_insurance, tax, gross_pay, net_pay, status(draft/confirmed/paid)；唯一键 (period,employee_id) |
| assets | id, code, name, category, dept, keeper, purchase_date, original_value, salvage_rate, useful_years, plate_no, next_check_date, status(in_use/idle/scrapped) |
| admin_expenses | id, expense_date, category, amount, payee, handler, payment_method, remark |

## 外部接口
| 表 | 关键字段 |
|---|---|
| integration_endpoints | id, code(唯一), name, type(shop/logistics/payment/other), base_url, auth_type, api_key, rate_limit_per_min, status(active/disabled), shop_id, last_call_at |
| integration_events | id, **event_id(唯一，幂等键)**, direction(in/out), endpoint_id, topic, payload, status(pending/processing/success/failed/dead), attempts, max_attempts, next_retry_at, last_error, result_ref, processed_at |
| integration_calls | id, endpoint_id, endpoint_code, method, path, status_code, ip, duration_ms, note |

`shipment_events` 新增校正字段：`correct_from`（旧值 JSON）、`correct_reason`、`correct_pending`（待批准的新值 JSON）、`correct_by/at`、`correct_approved_by/at`、`customer_notified`。

联动规则：ingest 命中已有 `event_id` → 直接返回原 `status`/`result_ref`，不写新记录；dispatch 处理失败 → `attempts+1` 且 `next_retry_at = now + min(2^attempts, 60) 分钟`，`attempts >= max_attempts` 时 `status='dead'`；校正批准 → 旧值写入 `correct_from`、新值覆盖业务字段、`correct_pending` 清空、`customer_notified=1` 并推站内信。

## 行政后勤
| 表 | 关键字段 |
|---|---|
| dorm_rooms | id, building, room_no, gender, capacity, rent_month, deposit, status(normal/maintenance) —— 唯一键 (building, room_no) |
| dorm_beds | id, room_id, bed_no, status(normal/maintenance) —— 唯一键 (room_id, bed_no) |
| dorm_stays | id, bed_id, employee_id, start_date, end_date(NULL=在住), rent_month, deposit, utilities, status(active/checked_out/cancelled) |
| meal_accounts | id, employee_id, card_no, balance(个人), subsidy_balance(补贴), status(active/lost/returned) —— 唯一键 employee_id |
| meal_transactions | id, account_id, type(recharge/subsidy/consume/refund/reissue/adjust/reverse), amount, personal_delta, subsidy_delta, source(device/manual), receipt_no, balance_after, subsidy_after, ref_id |
| certificates | id, company, type(license/permit/lease/insurance/other), cert_no, name, issued_by, issue_date, expire_date, holder, location, status(valid/void) |
| seals | id, company, name, keeper, status(active/void) |
| seal_usages | id, usage_no(YY+…), seal_id, applicant, purpose, doc_name, doc_version, status(pending/approved/used/returned/rejected), approved_by/at, used_at, returned_at, receipt_no |
| safety_checks | id, check_no(XJ+…), area(dorm/fire/office/production), facility, items(JSON), inspector, checked_at, result(ok/issue), issues_count, photo |
| repairs | id, repair_no(BX+…), order_id, safety_check_id, area, facility, description, severity(critical/major/minor), status(reported/repairing/submitted/verified/closed/rejected), reporter, assignee, due_date, submitted_at, verified_by/at, down_impact |

联动规则：巡检 `create_repairs` 且存在 `result='ng'` 项 → 每个异常项插入一条 `repairs(status='reported')` 并带 `down_impact`；换宿 → 旧 `dorm_stays` 置 `checked_out`（end_date = 换宿日前一天）+ 新建一条；饭卡 `consume` → 先扣 `subsidy_balance` 再扣 `balance`，并在流水中分别记 `subsidy_delta` / `personal_delta`。

## 人事办理
| 表 | 关键字段 |
|---|---|
| hr_recruitments | id, req_no(ZP+…), position, department_id, headcount, hired, requirement, channel, salary_range, owner, status(open/paused/closed), opened_at, closed_at |
| hr_candidates | id, recruitment_id, name, phone, source, resume_url, expected_salary, offer_salary, stage(applied/interview/offer/hired/rejected), interview_note, expected_onboard, hired_employee_id |
| employee_movements | id, mov_no(YD+…), employee_id, type(onboard/regular/transfer/promote/resign), effective_date, from_department_id, to_department_id, from_position, to_position, reason, handover(JSON), status(pending/effective/cancelled), applied_at |
| labor_contracts | id, contract_no(HT+…), employee_id, type(fixed/open/internship/labor), sign_date, start_date, end_date, probation_end, delivery_status(pending/delivered), delivery_evidence, renewal_of, status(active/renewed/expired/terminated) |
| salary_adjustments | id, adj_no(TX+…), employee_id, type(annual/regular/promote/adjust), before_salary, after_salary, effective_date, status(draft/approved/effective/cancelled), approved_by/at, applied_at |

员工表新增字段：`leave_date`（离职日）、`employment_type`（probation/fulltime）、`regular_date`（转正日）、`id_card`、`emergency_contact`。

联动规则：候选人 `hire` → 建 `employees` + `hr_recruitments.hired+1`（招满则 `status='closed'`）+ 一条 `employee_movements(type='onboard', status='effective')`；异动 `resign` 生效 → `employees.status='left'` 并把该员工 `labor_contracts` 中 active/renewed 的置 `terminated`；调薪 `apply` → 回写 `employees.base_salary` 并把 `before_salary` 校正为执行时实际值。

## 客户订单与资料确认
| 表 | 关键字段 |
|---|---|
| sample_seals | id, seal_no(SY+…), order_id, tech_pack_id, style_no, sample_name, version, content_hash(内容校验值), attachments(JSON), status(draft/sent/confirmed/rejected/superseded), tech_approved, tech_approved_by/at, customer_account_id, customer_confirmed_by/at, customer_comment, sent_at |
| order_changes | id, change_no(BG+…), order_id, type(craft/qty/price/delivery/material), title, before_json, after_json, affected_in_production, affected_materials, delivered_qty, remaining_qty, cost_delta, price_delta, delivery_delta_days, status(draft/assessing/pending_customer/confirmed/effective/rejected), assess_note, internal_approved_by/at, customer_account_id, customer_confirmed_by/at, customer_comment, workstation_signed, signed_by/at |
| delivery_changes | id, order_id, promised_date(原承诺), new_date(最新预计), kind(etd/eta_wh/eta_customer), reason, source(manual/api), status(pending/confirmed/rejected), customer_confirmed_by/at, customer_comment |
| shipment_events | id, order_id, carrier, tracking_no, event_time, status_text, location, source(manual/api), verified, visible, remark |

联动规则：新建封样版本 → 同订单同款非 `superseded` 的旧记录全部置 `superseded`；订单流 `→tech` 时若存在封样记录，最新版本必须 `status='confirmed' && tech_approved=1`；变更 `approved` 且 `type='delivery'` → 自动插入一条 `delivery_changes(status='pending')`；`delivery_changes` 不回写 `orders.delivery_date`（原承诺保留）。

## 零售与渠道
| 表 | 关键字段 |
|---|---|
| channel_shops | id, code, platform, shop_name, company(经营主体), reg_license, contract_party(签约/委托方), invoice_party, payee_party(收款主体), warehouse(履约仓), currency, api_status(unauthorized/authorized/limited), api_note, fee_rate, status(active/paused) |
| retail_orders | id, retail_no(RT+日期+序号), channel_order_no, shop_id, company, mode(agency/direct), order_date, currency, rate, goods_amount, discount, tax, shipping_fee, paid_amount, refund_amount, pay_status(pending/checked/mismatch), pay_ref, pay_checked_at, settle_status(unsettled/settled), settle_id, fulfill_status(waiting/reserved/shortage/shipped/cancelled), receiver, address —— 唯一键 (shop_id, channel_order_no) |
| retail_order_items | id, retail_id, sku, style_no, product_id, name, color, size, qty, price, amount, cost |
| retail_after_sales | id, no(AS+…), retail_id, item_id, type(refund/return/exchange), reason, refund_amount, return_qty, refund_status(draft/processing/done/rejected), refund_ref, return_status(none/pending/received/not_required), restock |
| channel_quotas | id, plan_no(QP+…), shop_id, style_no, product_name, owner(货主), channel_limit, reserved, pre_sale_date, status(active/paused) —— 唯一键 (shop_id, style_no, owner) |
| channel_settlements | id, batch_no(JS+…), shop_id, company, currency, period_start/end, order_count, order_amount, platform_fee, ad_fee, fulfillment_fee, refund_amount, other_fee, net_amount, cost_amount, contribution, profit_basis(estimated/confirmed), diff_amount, source, status(draft/confirmed/diff) |

状态联动：预留 → `channel_quotas.reserved += 数量`；发货 → 扣 `stock_items`(履约仓) + 写 `stock_ledger(type=out, ref_type=retail)` + 释放预留；取消 → 仅释放预留；退货收到且 `restock=1` → 回补库存并写 `stock_ledger(type=in, ref_type=retail_return)`；生成结算批 → 订单 `settle_status='settled'` 并回填 `settle_id`。

## 质量与合规
| 表 | 关键字段 |
|---|---|
| qc_standards | id, code, name, category, scope(incoming/process/final/child), aql, status |
| qc_standard_items | id, standard_id, seq, item_name, standard(判定标准), method, critical(1=致命项) |
| qc_inspections | id, inspect_no(QC+日期+序号), order_id, style_no, batch_no, type, standard_id/name, inspect_date, inspector, sample_qty, pass_qty, fail_qty, aql_result(pass/fail/conditional), status(draft/done) |
| qc_inspection_items | id, inspection_id, seq, item_name, standard, actual, result(ok/ng), critical |
| qc_issues | id, issue_no(QG+…), source(inspection/complaint/recall/internal), inspection_id, order_id, batch_no, type(rework/scrap/concession/complaint), severity(critical/major/minor), qty, description, root_cause, action, owner, due_date, status(open/processing/closed) |
| qc_batches | id, batch_no(B+…), order_id, style_no, product_name, qty, production_date, factory, fabric_batch, child_safety, docs(JSON 合规资料), status(normal/hold/recalled) |
| qc_recalls | id, recall_no(ZH+…), order_id, batch_no, issue_id, reason, severity, qty_affected, qty_recalled, status(assessing/confirmed/executing/closed), customer_notified |

联动规则：检验判 `fail/conditional` → 自动生成 `qc_issues` 并把批次置 `hold`；召回创建 → 批次置 `hold`；召回结案 → 批次置 `recalled`。

## 客户商城
| 表 | 关键字段 |
|---|---|
| customer_accounts | id, customer_id, username(唯一), password_hash, name, phone, email, role(owner 主账号/member 子账号), status(active/disabled), last_login_at —— 与 ERP `users` 完全分离 |
| mall_products | id, product_id, style_no, name_cn, name_en, category, cover_image, images(逗号分隔), description, moq, lead_days, price_usd, visible_stock, tags, status(draft/published/off), sort |
| mall_prices | id, customer_id, mall_product_id, price_usd, moq —— 客户专属价，唯一键 (customer_id, mall_product_id) |
| mall_favorites | id, account_id, mall_product_id —— 唯一键 (account_id, mall_product_id) |
| mall_inquiries | id, inquiry_no(XJ+日期+序号), customer_id, account_id, contact, status(submitted/quoted/confirmed/converted/cancelled), total_usd, total_qty, rate, remark(客户需求), sales_remark(业务回复), quoted_by/at, order_id(转订单后回填) |
| mall_inquiry_items | id, inquiry_id, mall_product_id, product_id, style_no, name, qty, price_usd, amount_usd, remark |
| mall_messages | id, customer_id, account_id, type(order/promo/arrival/system), title, body, ref_type, ref_id, read_at |

可售量口径：`mall_products.style_no` 匹配 `stock_items(warehouse='us')`；款号对不上时回退按产品名匹配（历史数据兼容）。

## 配置
| 表 | 关键字段 |
|---|---|
| app_config | key, value, updated_at；`key='settings'` 存 `{exchangeRate}`，`key='mindmap'` 存业务蓝图 |

## 计算口径
- 订单：`total_usd = Σ(尺码数量 × 美金单价)`；`total_amount = total_usd × rate`（汇率取 `settings.exchangeRate` 下单时快照）。
- 面辅料：`total_use = 单件用量 × 订单总件数 × (1 + 损耗%)`；`amount = total_use × 单价`。
- 成本：`total_cost = 材料+辅料+做工+管理+其他`；`factory_price = total_cost × (1 + 加价率%)`。

## 往来账与成本
| 表 | 关键字段 |
|---|---|
| ar_invoices | id, bill_no(YS+日期+序号), order_id, customer_id, customer_name, **currency, amount_orig, rate**, amount(本币), paid_amount, due_date, status(unpaid/partial/paid/void), source(order/retail/manual) |
| ap_invoices | id, bill_no(YF...), purchase_id, supplier_id, supplier_name, currency, amount_orig, rate, amount, paid_amount, due_date, status, source(purchase/outsource/expense/manual) |
| payments | id, pay_no(SK/FK+日期+序号), direction(in/out), partner_type, partner_id, partner_name, **currency, amount_orig, rate**, amount(本币), method, pay_date, status(valid/reversed) |
| payment_allocations | id, payment_id, invoice_kind(ar/ap), invoice_id, amount(本币) |
| cost_objects | id, cost_no(CB+日期+序号), **order_id(unique 一单一成本对象)**, order_no, customer_name, style_no, qty, currency, rate, revenue_orig, revenue_cny, budget_cost, actual_cost, sold_qty, sold_cost, sold_revenue, status |
| cost_entries | id, cost_object_id, layer(material/accessory/labor/overhead/other/freight/rework), source(auto/manual), ref_type, ref_id, name, qty, unit, unit_price, amount, occurred_at, remark |
| cost_snapshots | id, cost_object_id, seq, qty(累计已发), total_qty, unit_cost, sold_cost, sold_revenue, gross_profit, note |

口径：
- `paid_amount` 不直接改，一律由 `payment_allocations` 汇总回写（只统计 `status='valid'` 的款项）。
- 外币单据：`amount_orig × rate = amount`（本币），核销一律用本币，`open_amount_orig = open_amount / rate`。
- 成本对象 `actual_cost` = `cost_entries.amount` 之和；`unit_cost = actual_cost / qty`；
  `sold_cost = unit_cost × 已发货件数`；`gross_profit = sold_revenue - sold_cost`。

## 接单评审与交期
| 表 | 关键字段 |
|---|---|
| commitments | id, **order_id(unique)**, order_no, customer_name, style_no, qty, route_type(inhouse/outsource), **t0_at, t0_source**, **promised_date / planned_date / forecast_date / actual_ship_date**, review_status(pending/approved/rejected), front_ok, back_ok, material_ok, review_note, reviewed_by, reviewed_at, risk_level(none/yellow/red/done), delay_days, delay_reason |
| commitment_nodes | id, commitment_id, code(P1…P6/B1/H1/H2/E1 或 C1/C2/C3), name, seq, plan_days(NULL=待配置，不按 0), supervise_day(督办跟踪点，T0 后第 N 天), start_date, end_date, actual_start, actual_end, status(pending/running/done/skipped), owner, delay_days, note |

口径：
- T0 = `max(订单确认时点, 启动款到账时点)`；一经确定不再因事后补款变化。
- `forecast_date = max(T0, 已完成节点实际完工日) + 剩余节点标准时长之和`，且不早于今天。
- `plan_days` 为 NULL 表示「待配置」，累加时跳过并单独计数，不当作 0 天。
- 督办点是跟踪日（不是完工日）：P3 第 5 天、P4 第 7 天、P5 第 9 天、P6 第 11 天、B1 第 12 天、H1 第 14 天。

## 齐套与缺料
| 表 | 关键字段 |
|---|---|
| material_requirements | id, order_id, order_no, tech_pack_id, material_id, material_name, mat_type, colorway, color_no, spec_info, unit, **need_qty**, unit_price, **alloc_stock**(库存分配), **alloc_po**(在途分配), **gap_qty**(净缺口), gap_amount, impact_node(P5 裁剪 / B1 缝制), status(ok/partial/short/ordered), owner, action(pending/ordered/substituted/received), note, calc_at；`UNIQUE(order_id, material_name)` |

口径：
- `need_qty = 单件用量 × (1 + 损耗%) × 订单件数`，用量为 0 的行不参与齐套。
- 分配按订单的对客承诺日升序：先用库存（`materials.stock_qty`），再用在途（`purchase_items.qty - received_qty`）。
- `gap_qty = need_qty - alloc_stock - alloc_po`（不小于 0）。
- 重算时清空重插，但保留人工维护的 `owner` / `action` / `note`。

## 裁床与扎包
| 表 | 关键字段 |
|---|---|
| cut_orders | id, cut_no(CY+日期+序号), **order_id(unique)**, order_no, style_no, tech_pack_id, plan_qty, status(draft/cutting/cut_done/handed), fabric_ready, lot_count, total_layers, **total_cut_qty**, **qualified_qty**, reject_qty, leftover_m, **diff_qty**, diff_reason, **mixed_dye_lot**, bundle_count, bundle_qty, bundle_rule, cut_by, cut_at, checked_by, checked_at, handover_at |
| cut_lots | id, cut_order_id, seq, bed_no, **dye_lot(缸号)**, fabric_roll, width, **layers**, marker_no, marker_len, plan_qty, **actual_qty**, leftover_m, status, operator, note |
| cut_bundles | id, cut_order_id, lot_id, **bundle_no(扎号)**, color, size, qty, status(created/checked/handed), checked_by, checked_at |

口径：
- `diff_qty = Σ 床次 actual_qty − plan_qty`，不为 0 时必须填 `diff_reason` 才能完成裁剪。
- 扎包合计必须等于 `qualified_qty`（合格裁片），否则不许完成。
- `mixed_dye_lot = 1` 表示同单出现多个缸号（`dye_lot` 去重后 > 1）。
- 完成裁剪时把 `order_nodes` 里名为「裁剪」的节点置为 done，备注带裁床号与合格数。

## 首件确认与工位工艺
| 表 | 关键字段 |
|---|---|
| first_articles | id, **fa_no(FA+日期+序号)**, order_id, order_no, style_no, cut_order_id, **tech_pack_id**, **tech_pack_version(版本快照)**, fa_type(full/simple), **batch_qty(本批)**, sample_bundle_no, sample_size, scope, **status(draft/submitted/passed/conditional/rejected)**, conclusion, **release_qty(放行量)**, limit_note, inspector, inspected_at, released_by, released_at, return_to(sales/tech), return_reason, evidence(JSON), created_by |
| first_article_checks | id, fa_id, seq, **kind(size/craft/look)**, workstation, **part(部位/检查项)**, spec, tolerance, **measured(实测)**, **result(ok/ng)**, **critical(1=关键项)**, remark, checked_by, checked_at |
| workstation_crafts | id, order_id, node_id, node_name, seq, **workstation(工位)**, **craft_name**, requirement(工艺要求), machine, key_point(关键控制点), std_time, **critical(1=关键工序)**, operator, status |

口径：
- **冻结版** = 该订单 `tech_packs.status='confirmed'` 里 id 最大的一张；首件单把它与 `version` 一起快照下来。
  当前冻结版变了（改版）→ 首件 `stale=1`，不能再用于放行。
- 尺寸项全部 `critical=1`（首件尺寸超差即不合格）；工艺项继承工位工艺的 `critical`；外观项 `critical=0`（可限定放行）。
- `release_qty` 必须 > 0 且 ≤ `batch_qty`；`conditional` 必须写 `limit_note`。
- `released_by ≠ inspector`（admin 例外），不许自己测自己放。
- 报工门禁：`reports.js` 在「备料 / 排版算料 / 裁剪」之外的工序上报工前调用 `faGate(order_id)`。

## 生产原料收货与检验
| 表 | 关键字段 |
|---|---|
| goods_receipts | id, **grn_no(GRN+日期+序号)**, po_id, po_no, supplier, receive_date, warehouse(原料库), **status(pending/inspecting/partial/passed/rejected/cancelled)**, line_count, **expect_qty**, **receive_qty**, **pending_qty(待检)**, **pass_qty(合格)**, freeze_qty, reject_qty, **over_qty(超收)**, **short_qty(短收)**, receive_by, receive_at, inspect_by, inspect_at |
| goods_receipt_items | id, grn_id, po_item_id, material_id, material_name, spec, unit, **roll_no(卷号)**, **dye_lot(缸号)**, **location(原料库位)**, expect_qty, receive_qty, **diff_qty**, **diff_type(none/over/short)**, diff_reason, **pending_qty**, **pass_qty**, **freeze_qty**, **reject_qty**, status(pending/passed/partial/frozen/rejected), inspect_by, inspect_at, inspect_note |
| goods_receipt_actions | id, item_id, grn_id, **action(inspect/release/reject)**, qty, reason, operator |

口径：
- **收货不自动可用**：点收只写 `purchase_items.received_qty` 与明细 `pending_qty`，`materials.stock_qty` 不变。
- `materials.stock_qty += pass_qty`（检验合格）或 `+= qty`（冻结放行）；`freeze_qty` / `reject_qty` 永不进库存。
- 每行恒等式：`receive_qty = pending_qty + pass_qty + freeze_qty + reject_qty`。
- `diff_qty = receive_qty − expect_qty`；`> 0` 为超收（`diff_reason` 必填），`< 0` 为短收。
- 退回时 `purchase_items.received_qty -= reject_qty`，采购单回到 `ordered` 等补发。

## 内部邮件
| 表 | 关键字段 |
|---|---|
| mail_threads | id, **thread_no(TH+日期+序号)**, subject, source_type, source_id, source_label, message_count, last_message_at |
| mail_messages | id, **message_no(EM+日期+序号)**, thread_id, parent_id, subject, body, **type(normal/confirm/task)**, sender, sender_name, sender_dept, **acting_for(代理发信)**, source_type/source_id/source_label, **attachments(JSON)**, **request_no(幂等键)**, **version**, confirm_due, task_due, **status(sent/partially_failed/recalled/corrected)**, recall_reason, corrected_by, corrects_id |
| mail_recipients | id, message_id, username, name, department, **kind(to/cc)**, **must_ack**, **delivery_status(queued/delivered/failed/recalled)**, deliver_attempt, delivered_at, fail_reason, **first_read_at**, read_flag, **ack_state(none/pending/acked/questioned)**, ack_at, ack_note, question, answer, is_delegate, delegate_by, **star / archived / trash（只作用本人副本）** |
| mail_tasks | id, **task_no(RW+日期+序号)**, message_id, thread_id, title, **owner(唯一主责)**, due_at, requirement, status(open/done/cancelled) |
| mail_delivery_events | id, message_id, recipient_id, **event(queue/deliver/fail/retry/recall/read/ack/question)**, detail, operator |
| mail_audits | id, message_id, thread_id, **action(send/recall/correct/read_body/delegate/retry)**, username, detail |
| mail_delegates | id, **owner, agent**, **scope(all/ack/send)**, **start_at, end_at**, status(active/revoked), reason |

口径：
- `UNIQUE(message_id, username)`：一人一行，投递 / 已读 / 确认 / 标记全部按人独立。
- **首次已读只由读正文写入**（`first_read_at`）；`read_flag=0` 只清提醒，不撤销 `first_read_at`。
- 需确认：`must_ack=1` 只给 `kind='to'`；`cc` 直接 `ack_state='acked'`（默认知悉）。
- 提问置 `questioned`（**不算确认**）；发件人答复后置回 `pending`。
- 撤回只对「已送达 + 未读 + 未确认」行生效；已读的只能通过 `corrects_id` 发更正（新 `version`，旧回执保留）。
- 会话可见性：某用户只看到自己作为 `sender` 或 `mail_recipients.username` 的信（范围取交集）。
- 邮件不持有正文权限的替代品：源单只存 `source_type/source_id + label`，打开时按原模块权限校验。

## 客户子账号与授权
| 表 | 关键字段 |
|---|---|
| customer_accounts（扩列） | **parent_id(归属主账号)**, **perms(生效权限点)**, **limit_perms(销售批准上限)**, approved_by, approved_at, must_change_pwd, invited_by, remark, role(owner/purchase/orders/finance/member), status(active/disabled) |
| customer_invites | id, **token(一次性)**, customer_id, role, perms, contact(核验联系方式), invited_by, **expires_at**, **status(pending/used/revoked/expired)**, used_by_account_id, used_at, note |
| customer_account_audits | id, account_id, customer_id, **action(create/perms/disable/enable/reset_pwd/approve/invite/accept_invite)**, **before_json / after_json**, operator, **operator_scope(staff/customer/system)**, note |

口径：
- 生效权限 `resolvePerms()`：主账号 = `limit_perms`（空则全量）；子账号 = `perms`（空则按角色预设）。
- 上限收紧时联动：`approve` 会把超限的子账号权限一并裁掉，并逐条写审计。
- 权限点字典在 `backend/src/services/customerPerms.js`；新增权限点要同步前端 `ALL_TABS` 与角色预设。
- 客户 token 每次请求都回库校验账号状态与权限，**改权限立即生效**，不依赖 token 里的旧值。

## 供应商评价与备用产能
| 表 | 关键字段 |
|---|---|
| supplier_evaluations | id, **ev_no(SE+日期+序号)**, supplier_id/supplier_name, **period_start/period_end**, **sample_total(准交分母)**, on_time_count, late_count, late_days_sum, **no_due_count(无承诺日样本)**, recv_qty, pass_qty, freeze_qty, reject_qty, **inspected_qty**, short_orders, over_orders, **on_time_rate, defect_rate, quality_score, price_score, score, grade(A/B/C/D/NA)**, capacity_qty, used_qty, remaining_qty, **status(sufficient/insufficient/improve)**, action, conclusion, evidence, evaluated_by/at |
| supplier_rectifications | id, **rect_no(ZG+日期+序号)**, ev_id, supplier_id/supplier_name, issue, action, due_date, **status(open/submitted/verified/failed)**, submit_note, submitted_at, verify_note, verified_by/at |
| supplier_backups | id, supplier_id/supplier_name, scope, item_desc, **tech_ok / sample_ok / compliance_ok**, verify_note, evidence, capacity_qty, used_qty, price_ref, lead_days, **status(pending/verified/rejected/expired)**, verified_by/at |
| supplier_qualifications | id, **supplier_id UNIQUE**, supplier_name, **status(qualified/conditional/observing/suspended)**, reason, based_ev_id, effective_from/to, decided_by/at |
| purchase_orders / goods_receipts（扩列） | **supplier_id** —— 评价挂档案，不靠名字匹配 |

口径：
- 样本只来自 `goods_receipts`（作废单排除），不手填；`expect_date` 为空不进准交分母。
- 质量分母 = `pass_qty + freeze_qty + reject_qty`（待检不算）。
- `remaining_qty` 由该供应商所有 `verified` 备用产能的 `capacity_qty − used_qty` 合计。
- 一家供应商同时只有一行 `supplier_qualifications`（upsert），历史决定留在评价单与整改单上。

## 停单改量与供应商退料
| 表 | 关键字段 |
|---|---|
| purchase_changes | id, **change_no(PC+日期+序号)**, po_id/po_no, supplier_id/supplier_name, **type(reduce/cancel)**, reason, **reduce_qty(总减量)**, returnable_qty, version, **status(draft/pending_supplier/confirmed/rejected/effective/voided)**, supplier_confirmed_by/at, supplier_comment, credit_note_no, credit_amount, effective_by/at |
| purchase_change_items | id, change_id, po_item_id, material_id/material_name, spec, unit, qty, **received_qty / issued_qty / returned_qty / pending_qty**, **new_qty(减后)**, **reduce_qty(本次)**, returnable_qty, return_flag |
| purchase_returns | id, **return_no(RT+日期+序号)**, po_id/po_no, change_id, supplier_id/supplier_name, reason, **return_qty**, **status(pending_receipt/returned/credited/done/voided)**, **physical_receipt_note / physical_by / physical_at(实物回执)**, **credit_note_no / credit_amount / credit_by / credit_at(贷项回执)** |
| purchase_return_items | id, return_id, po_item_id, material_id/material_name, spec, unit, qty, unit_price, amount |
| purchase_items（扩列） | **issued_qty(已领)** / **returned_qty(已退)**；可退 = received_qty − issued_qty − returned_qty |

口径：
- 减量只动未交：`reduce_qty ≤ qty − received_qty`；生效时 `qty −= reduce_qty` 并重算 `amount`。
- 退料不改 `received_qty`（已收是事实）；实物回执时 `materials.stock_qty −= qty`、`returned_qty += qty`。
- 贷项凭证（credit_note_no + credit_amount）是差异结算依据，不直接删应付行。

## 返工报废与生产结单
| 表 | 关键字段 |
|---|---|
| rework_orders | id, **rw_no(RW+日期+序号)**, order_id/order_no, node_id/node_name(原工序), **type(rework/scrap)**, **source(inhouse/outsource/supplier/customer)**, responsibility, reason, **qty(不良)**, **rework_times**, qty_ok, qty_scrap, cost_labor/cost_material/**cost_total**, **cost_entry_id(成本幂等标记)**, **status(draft/pending_approve/approved/in_progress/closed/rejected)**, approved_by/at/note, reinspect_result/by/at/note, evidence |
| production_closures | id, **close_no(CL+日期+序号)**, order_id/order_no, **close_type(full/partial)**, status, **检查快照：open_rework_cnt/qty, open_qc_cnt, wip_nodes, total_nodes, unshipped_qty, leftover_m, cost_open**, blocked_json, warn_json, **dispute_note / balance_source / follow_up_owner(部分关闭挂账)**, **actual_close_date(人工) / recorded_at(系统)**, closed_by |

口径：
- 返工闭环写 `cost_entries.layer='rework'`，`cost_entry_id` 非空表示已写过，重复闭环不会重复计成本。
- 结单只写记录，不改 `orders` / `production_reports` / `stock_*`；已完成已交付不删除。
- `blocked_json` / `warn_json` 保存结单当时的检查结果，事后订单状态变了也能追溯当时为什么受限。

## 设备停机与产能
| 表 | 关键字段 |
|---|---|
| equipment | id, **eq_no(EQ+序号)**, name, **type(sewing/cutting/ironing/washing/printing/embroidery/inspection/other)**, **work_center**, **capacity_per_hour(件/小时)**, **status(running/stopped/maintenance/retired)**, owner, location, last_maintain_at, next_maintain_at, active |
| equipment_downtimes | id, **dt_no(DT+日期+序号)**, equipment_id/eq_no/eq_name, work_center, **type(breakdown/maintenance/changeover/power)**, **start_at / end_at**, **occupied_hours**, reason, repair_task, **status(planned/pending_repair/repairing/pending_safety/recovered/cancelled)**, repair_by/at/note, **safety_by/at/note(人工放行)**, capacity_per_hour(快照), **capacity_loss**, affected_orders(JSON) |

口径：
- 时间一律存**本地墙钟** `YYYY-MM-DD HH:mm:ss`（写入前过 `normTime()`）。
- 未结单的 `occupied_hours` 按"开始 → 当前时刻"实时算；恢复时落库并重算 `capacity_loss`。
- `capacity_loss = occupied_hours × capacity_per_hour`（快照，事后改设备产能不影响历史）。
- 产能基准 `设备数 × 8h`；停机占用按与当天 0-24 点重叠小时计。

## 岗位绩效与申诉
| 表 | 关键字段 |
|---|---|
| kpi_templates | id, template_no, name, **job_family(岗位族)**, job_title, department_id, **base_score(基准分)**, cycle_type, **version / parent_id**, **status(draft/pending_review/approved/retired)**, effective_from, submitted_by/at, approved_by/at, review_note |
| kpi_rules | id, template_id, code, name, **category(delivery/quality/site/coop/safety)**, **definition / formula**, target_value, unit, **weight**, **threshold_json{op,value,step,deduct}**, **data_source**, **exception_note**, **cap_score**, **reviewer**, auto_suggest, sort |
| kpi_cycles | id, **cycle_no(2026-W44)**, start_date, end_date, **status(open/frozen)**, frozen_by/at |
| kpi_scores | id, employee_id/name, department_id, position, cycle_id/cycle_no, template_id/no/**version**, **base_score / suggested_score / pending_score / confirmed_score / appeal_score / current_score**, **provisional**, item_count, appeal_count, **status(draft/pending_review/confirmed/appealing/closed)**; `UNIQUE(employee_id, cycle_id)` |
| kpi_items | id, score_id, employee_id, cycle_id, rule_id/code/name, **rule_snapshot(版本+阈值+上限+单位)**, category, order_id/node_id, task_desc, target_value/actual_value, **evidence / evidence_url**, **suggested_score / confirmed_score**, responsibility, **dedupe_key**, source(auto/manual), **review_status(pending/confirmed/rejected/unconfigured)**, reviewed_by/at/note, **appeal_status(none/appealing/upheld/adjusted/revoked)**; `UNIQUE(score_id, dedupe_key)` |
| kpi_appeals | id, appeal_no, item_id, score_id, employee_id/name, cycle_id/no, **reason_type**, reason, evidence, **original_score / new_score**, **decision(pending/uphold/reduce/revoke)**, **reviewer / reviewer_role**, decision_note, **status(submitted/accepted/decided/withdrawn)**, submitted_at/accepted_at/decided_at |
| production_reports（扩列） | **employee_id** —— 报工归属到人，绩效才能按人汇总 |

口径：
- `current_score = base_score − confirmed_score`；`suggested_score`（待复核）与申诉中金额都不进当前分。
- `provisional = 1` 时接口返回 `final_score = null`：有未结申诉，分数不是最终。
- `rule_snapshot` 保存生成当时的规则版本与阈值，冻结周期按快照结算，事后改规则不影响历史。
- `dedupe_key` 唯一约束保证「同一事件只扣一次」；建议项 key = `rule_id:cycle_id`。
- `unconfigured` 是「时限未核定」的占位项：不扣分、不能确认，只做提示（原型要求不预测为 0 天）。

## 行政合同与履约日历 / 印章授权
| 表 | 关键字段 |
|---|---|
| admin_contracts | id, contract_no, name, **type(lease/property/canteen/insurance/service/other)**, company, counterparty, **owner(责任人)**, amount, currency, **deposit / deposit_return_date**, sign_date/start_date/end_date, **renewal_notice_days**, **current_version**, seal_id, **status(draft/active/renewed/terminated/archived)**, terminated_reason/by/at, **renewal_basis**, archived_at/note |
| admin_contract_versions | id, contract_id, **version**, doc_name, **doc_hash(内容指纹)**, attachment, change_note, changed_by/at, seal_recheck_required; `UNIQUE(contract_id, version)` |
| admin_contract_milestones | id, contract_id, **type(payment/acceptance/renewal_notice/deposit_return/other)**, title, **due_date**, amount, **status(pending/done/overdue/waived)**, done_at/by/**evidence**, note |
| seal_grants | id, **seal_id**, company, **grantee / grantee_type(person/role/position)**, **scope(use/borrow/all)**, valid_from/valid_to, **status(active/revoked)**, granted_by/at, revoke_reason |
| doc_access_logs | id, **doc_type(certificate/contract/seal_usage)**, doc_id, doc_name, **access_level(public/controlled)**, **action(view/download/print)**, allowed, operator, operator_role, reason |
| seal_usages（扩列） | **kind(use/borrow)**, **contract_id**, **doc_hash**, **recheck_required / recheck_reason**, **borrow_out_at / expect_return_date / return_receipt** |
| certificates（扩列） | **access_level(public/controlled，默认 controlled)** |

口径：
- 履约任务由合同条款自动铺：续约通知 = `end_date − renewal_notice_days`；押金返还 = `deposit_return_date`；
  付款/验收来自建单时的 `payments[]` / `acceptances[]`；另加一条「合同到期日」提醒。
- `overdue` **不落库**，按 `status='pending' AND due_date < 今天` 实时算，避免批量刷状态。
- 终止时 `payment/acceptance/renewal_notice/other` 转 `waived`；`deposit_return` 保持 `pending`。
- 用印版本门禁：申请记 `doc_hash = 合同当前版本 doc_hash`；出新版本会把未用印申请置 `recheck_required=1` 并清空 `doc_hash`。
- 印章授权有效期用「本地日期字符串」比较（不用时间戳），避免时区偏差。

## 流程超时升级与岗位 SOP
| 表 | 关键字段 |
|---|---|
| approval_reminders | id, **task_id**, instance_id, **level(soon/overdue/escalate)**, **dedupe_key UNIQUE**, to_role/to_user, message, sent_at |
| approval_delegates | id, **from_user / to_user**, **target_types(逗号分隔，空=全部)**, valid_from/valid_to, **status(active/revoked/expired)**, reason, created_by/at, revoked_at/revoke_reason |
| sop_documents | id, **doc_no(SOP+日期+序号)**, title, **category(sop/policy/rule)**, company, **position(适用岗位，空=全岗位)**, owner, **status(draft/pending/effective/retired)**, **current_version**, effective_date, approved_by/at, retired_at/retire_reason |
| sop_versions | id, doc_id, **version**, **doing(做法) / inputs(输入) / done_criteria(完成标准) / escalate_path(升级路径)**, change_note, **status(draft/effective/retired)**, created_by/at; `UNIQUE(doc_id, version)` |
| sop_acks | id, doc_id, **version**, employee_id, employee_name, position, **acked_at(NULL=待补签)**, note; `UNIQUE(doc_id, version, employee_id)` |
| approval_tasks（扩列） | **due_at / sla_hours / remind_count / last_remind_at / escalate_level / escalated_to / escalated_at / escalate_reason / original_approver / delegate_by / received_at / received_by** |
| approval_flows（扩列） | **sla_hours（默认时限）/ escalate_role（默认升级对象）**；`steps` JSON 内每步可带 `sla_hours` 与 `escalate_to` |

口径：
- 待办只算 `step_no = instance.current_step` 的任务；下一步未轮到不参与超时统计。
- `overdue` / `soon` **不落库**，按 `due_at` 与当前时间实时算；`escalate_level` 只在真正升级后写。
- 发布 SOP 时按 `position` 匹配在职员工生成 `sop_acks`（岗位为空则全员）；旧 effective 版本转 retired。
- 废止制度不显示签收进度（`ack_total` 归零），避免误读成「还没签」。

## 数据质量与业务勾稽
| 表 | 关键字段 |
|---|---|
| dq_rules | id, **code UNIQUE**, name, **category(balance账账对齐/quality数据质量)**, kind, **severity(error/warn/info)**, desc_text, suggest, **fixable**, **fix_key**, enabled, sort_no, last_hit |
| dq_runs | id, **run_no(GJ+日期+序号) UNIQUE**, scope, trigger_by, operator, rule_count, issue_count, **error_cnt/warn_cnt/info_cnt**, fixable_cnt, **new_cnt/fixed_cnt/recur_cnt**, **health(0-100)**, duration_ms, status, note |
| dq_issues | id, run_id, **rule_code**, rule_name, category, kind, severity, entity_type, entity_id, entity_no, field, **expect_val/actual_val/diff_val**, message, fixable, fix_key, **status(open/fixed/ignored)**, **fingerprint UNIQUE**, first_seen_at/last_seen_at, **seen_cnt**, fixed_at/fixed_by, ignore_reason |
| dq_fixes | id, run_id, issue_id, fingerprint, fix_key, target, **before_json/after_json**, **result(ok/skip/fail)**, message, operator, created_at |
| dq_ignores | id, **fingerprint UNIQUE**, rule_code, entity_no, **reason(必填，≥4字)**, created_by, **expire_at(到期自动重新生效)** |

口径：
- **fingerprint = `规则编码|对象类型:对象ID|字段`**，唯一索引；跨批次复用同一条记录，只累加 `seen_cnt` 并更新 `last_seen_at`。
- **批次对比**：本次出现上批没有 → `new_cnt`；上批有本次消失 → `status='fixed'` 且 `fixed_cnt+1`；曾 `fixed` 又出现 → `recur_cnt`。
- **健康分** = `100 − min(35, 严重×3) − min(22, 关注×1) − min(6, 提示×0.25)`；`ignored` 不计扣分。
- **可修字段白名单**：`stock_items.qty`、`ar_invoices/ap_invoices.paid_amount(+status)`、`cost_objects.actual_cost`、`purchase_orders.total_amount`、`purchase_items.received_qty`、`orders.total_usd/total_amount`、`order_items.amount_usd/amount_cny`。其余一律人工。
- 规则定义在 `backend/src/services/dqRules.js`，服务启动时幂等同步进 `dq_rules`（保留人工改过的 `enabled`）。

## 海外仓（美仓）作业
| 表 | 关键字段 |
|---|---|
| wh_locations | id, warehouse, **code**, **zone(sellable/inspect/damaged/return/staging)**, aisle, capacity, status(active/locked); `UNIQUE(warehouse, code)` |
| wh_asns | id, **asn_no UNIQUE**, warehouse, from_warehouse, carrier, container_no, ship_date/eta_date/arrive_date, carton_plan/carton_actual, expect_qty/received_qty/damaged_qty/short_qty/over_qty, **status(draft/in_transit/arrived/receiving/done/cancelled)** |
| wh_asn_items | id, asn_id, style_no, product_name, color, size, **expect_qty**, carton_no |
| wh_receipts | id, **rcv_no UNIQUE**, asn_id, arrive_date, carton_actual, expect/received/damaged/short/over_qty, status(counting/done), receive_by/at |
| wh_receipt_items | id, rcv_id, asn_item_id, style_no…size, expect_qty, **received_qty / damaged_qty / short_qty / over_qty**, **put_qty（累计上架）**, **diff_reason（差额必填）** |
| wh_putaways | id, put_no, rcv_item_id, **location_id**, qty, operator, put_at |
| wh_bundles | id, **bundle_sku UNIQUE**, name, warehouse, sale_price, status(active/disabled) |
| wh_bundle_items | id, bundle_id, style_no, product_name, color, size, **qty_per（单套用量）** |
| wh_bundle_stock | id, bundle_id, warehouse, qty; `UNIQUE(bundle_id, warehouse)` —— **套装库存独立，不进 stock_items** |
| wh_bundle_ops | id, **op_no UNIQUE**, bundle_id, **type(kit/unbundle)**, warehouse, qty, **before_qty/after_qty**, status, operator, created_at |
| wh_freight_rates | id, carrier, zone, currency, **first_weight/first_price/add_weight/add_price/fuel_pct**, effective_from, status; `UNIQUE(carrier, zone, effective_from)` |
| wh_freight_bills | id, **bill_no UNIQUE**, carrier, period_from/period_to, currency, **total_amount/sys_amount/diff_amount**, item_count/diff_count/missing_count/extra_count, **status(pending/matched/disputed/settled)** |
| wh_freight_items | id, bill_id, tracking_no, order_id, ship_date, dest_zip, zone, **weight（计费重）/ act_weight（实重）**, **bill_amount/sys_amount/diff**, **diff_type(ok/amount/weight/missing/no_rate/extra)**, **status(ok/diff/disputed/accepted)** |

口径：
- **上架才可售**：只有 `zone='sellable'` 的上架才 `stock_items.qty +=` 并写 `stock_ledger(type='in', ref_type='wh_receipt')`；破损/待检/退货区只写 `wh_putaways`。
- **套装库存独立**：`wh_bundle_stock`，组装写 `stock_ledger(type='kit_out')`、拆分写 `kit_in`，都不影响 `stock_items` 里的套装行（根本不存在套装行）。
- **库位不做实时库存**：`wh_putaways` 只记「上架到哪」，用于找货；实时可售量看 `stock_items`。
- **差异判定优先级**：missing → no_rate → weight（差 >5%）→ amount（|差额| > max($1, 系统额×2%)）→ ok。

## 总账与财务报表
| 表 | 关键字段 |
|---|---|
| gl_accounts | id, **code UNIQUE**, name, **type(asset/liability/equity/income/expense)**, **direction(debit/credit)**, parent_code, is_leaf, status, sort_no |
| gl_periods | id, **period UNIQUE(2026-10)**, start_date/end_date, **status(open/closed)**, voucher_count, debit_total/credit_total, **profit**, check_pass/check_fail_cnt, closed_by/at, reopened_by/at/reason |
| gl_vouchers | id, **voucher_no UNIQUE(记-YYYYMM-NNNN)**, period, biz_date, summary, **source_type**, source_id, **status(posted/void)**, debit_total/credit_total |
| gl_entries | id, voucher_id, period, line_no, **account_code**, account_name, summary, **debit/credit**, partner_type/id/name |
| gl_close_checks | id, period, **check_code**, name, **severity(error/warn)**, passed, amount, detail; `UNIQUE(period, check_code)` |
| gl_balances | id, period, account_code, debit_begin/credit_begin, debit_period/credit_period, debit_end/credit_end; `UNIQUE(period, account_code)` —— 关账快照 |

口径：
- **幂等键** `UNIQUE(source_type, source_id, period) WHERE source_id IS NOT NULL` —— 带期间，折旧/工资这类「同一对象每期各一张」才能按月分开。
- **余额不存表**：科目余额、三表都是 `gl_entries` 的实时投影；只有关账时才把余额写进 `gl_balances` 做快照。
- **利润表排除 `profit_carry`**：否则结转凭证会把收入费用互相抵平。
- **备抵科目**（`type='asset' AND direction='credit'`，如 1602 累计折旧）在资产负债表按负数计入资产。

## 现货库龄与退货
| 表 | 关键字段 |
|---|---|
| stock_returns | id, **return_no UNIQUE(RT+日期+序号)**, **type(customer/retail/quality/transfer_back)**, warehouse, order_id/order_no, partner_name, source_no, reason, **status(draft/received/inspected/closed/cancelled)**, qty_apply/qty_received/qty_good/qty_defect/qty_scrap, return_date |
| stock_return_items | id, return_id, style_no/product_name/color/size, **qty_apply/qty_received/qty_good/qty_defect/qty_scrap**, **location_code（良品回架库位）**, note |

口径：
- **库龄不建批次表**：用 `stock_ledger` 按 FIFO 反算 —— 正数入批次、负数冲最早批次，剩余批次即当前在库。
- **只有良品写流水**：`ref_type='stock_return'`，进 `stock_items` 时 `zone` 必须是 `sellable`；次品/报废不写库存也不写流水。
- **数量守恒**：`qty_received = qty_good + qty_defect + qty_scrap`，后端强校验。

## AI 能力中心
| 表 | 关键字段 |
|---|---|
| ai_providers | id, **code UNIQUE**, name, vendor, base_url, model, **key_env（环境变量名，不存明文）**, key_masked, **data_scope(public/internal/restricted)**, region, input_price/output_price, monthly_budget/used_amount, timeout_ms, priority, **status(planning/pending/enabled/disabled)** |
| ai_calls | id, **scene**, sensitivity, provider_id/code, model, actor, prompt_digest（摘要不存原文）, prompt_len, tokens_in/out, cost, latency_ms, **status(ok/fallback/blocked/error)**, reason, http_code |
| ai_drafts | id, **draft_no UNIQUE(AID+日期+序号)**, **scene(requirement/reply/anomaly)**, source_type/id/label, **payload(JSON)**, confidence, missing, **status(draft/approved/rejected)**, reviewed_by/at, review_note, **applied_to（核准后去了哪）** |
| ai_evals | id, **case_code UNIQUE**, scene, title, input_text, **asker_role**, **expect_kind(answer/refuse)**, expect_keywords, **leak_keywords**, risk_level, enabled |
| ai_eval_runs | id, **run_no UNIQUE(EV+日期+序号)**, provider_code, model, total/passed/failed, **leak_cnt（越权泄漏，必须 0）**, refuse_ok, source(ai/rule), cost, ms, status, operator |
| ai_eval_results | id, run_id, case_code, expect_kind, passed, **leaked**, answer, hit_keywords, leak_hit, ms, note |
| ai_risks | id, **run_id(RSK+日期+序号)**, entity_type/id/no, **level(high/mid/low)**, score, **reasons(JSON)**, next_action, owner, role, due_at, hours_left, **status(open/ack/done)** |
| ai_weekly | id, week_no, **scope(user/dept/company)**, subject_id, subject_name, period_from/to, **content(JSON 七段)**, cnt_done/open/overdue/blocked/penalty, status(draft/published); `UNIQUE(week_no,scope,subject_id)` |
| ai_faq | id, question, answer, category, keywords, version, **status(draft/approved/retired)**, approved_by/at, hit_count |
| ai_handovers | id, **session_no UNIQUE(CS+日期+序号)**, customer, channel, **status(ai/human/closed)**, trigger_reason, question, taken_by/at, closed_at, summary |

口径：
- **密钥永不上库**：`ai_providers` 只存 `key_env`（环境变量名）与脱敏显示值；启用时校验环境变量是否存在。
- **数据分级路由**：场景敏感级 ≤ 供应商 `data_scope` 才可调用；`weekly`（含薪资/绩效）为 restricted，境外供应商拿不到。
- **AI 不写业务表**：所有产出落 `ai_drafts`，核准后也只改草稿状态与 `applied_to`。
- **周报去重键**：`subject_id` 用 `employee_id`，没有员工档案的账号用**负的 user id**，避免全部落到 0 被覆盖。
- **风险快照按批次**：每次 `run` 生成新 `run_id`，`/api/ai/risk` 只读最新批次。

## 预算管理
| 表 | 关键字段 |
|---|---|
| budgets | id, **budget_no UNIQUE(YS+年度[+V版本])**, fiscal_year, name, version, **status(draft/approved/active/closed/rejected)**, total_amount, item_count, **tolerance_pct（0=硬控）**, **is_current（同年度唯一生效）**, created_by/at, approved_by/at, closed_by/at |
| budget_items | id, budget_id, **department_id**, department_name, **account_code（只允许 66xx 期间费用）**, account_name, **period(YYYY-MM)**, amount; `UNIQUE(budget_id, department_id, account_code, period)` |
| budget_adjustments | id, **adj_no UNIQUE(TZ+日期+序号)**, budget_id, **type(increase/decrease/transfer)**, from_department_id/from_account_code, to_department_id/to_account_code, period, amount, **reason（≥8字）**, **status(pending/approved/rejected)**, created_by, approved_by/at |
| budget_commitments | id, budget_id, department_id, account_code, period, **source_type(expense/payroll/purchase)/source_id/source_no**, amount, **status(open/consumed/released)**, settled_at, release_reason |
| budget_alerts | id, budget_id, department_id/name, account_code/name, period, **type(over_budget/within_tolerance/near_limit)**, budget_amount/used_amount/over_amount, source_type/id/no, **reason**, operator, **status(open/acked)**, acked_by/at |

补列：
- `admin_expenses.department_id` —— 费用归部门（预算执行的前提）
- `admin_expenses.budget_reason` —— 超预算说明快照
- `gl_entries.department_id` —— 分录归部门（只有费用/工资类会写）

口径：
- **已发生**取 `gl_entries` 的 `period + account_code + department_id` 净额；**已占用**取 `budget_commitments.status='open'`；**可用 = 预算 − 已发生 − 已占用**。
- **占用生命周期**：费用单提交 → `open`；凭证生成 → `consumed`（由 `gl.generate` 触发 `budget.consume`）；单据删除/金额变更 → `released`。
- **调整单才改数**：`active` 预算的 `budget_items` 只能通过调整单审批修改，`PUT /api/budget/:id` 会被拒。
- **生效互斥**：`is_current=1` 与 `status='active'` 成对出现，`activate` 时把同年度旧的置 `closed`。

## 税票银行与结算
| 表 | 关键字段 |
|---|---|
| bank_accounts | id, **account_no UNIQUE**, company_id, bank_name, account_masked, currency, **account_type(basic/general/fx)**, **open_balance/open_date（对账起点）**, status(active/closed) |
| bank_imports | id, **import_no UNIQUE(IMP+日期+序号)**, account_id, period, source_name, **line_count/dup_count**, in_total/out_total, status(done/partial), operator |
| bank_statement_lines | id, import_id, account_id, **trade_date**, period, **direction(in/out)**, amount, balance, summary, counterparty, **dedupe_key UNIQUE（sha1 指纹）**, **match_status(unmatched/auto/manual/ignored)**, payment_id, note |
| bank_reconciliations | id, **recon_no UNIQUE(DZ+日期+序号)**, account_id, period, **statement_balance / book_balance**, **bank_only_in/out（银行记了企业没记）**, **book_only_in/out（企业记了银行没记）**, adjusted_statement/adjusted_book, **diff_amount**, unmatched_lines/payments, **status(draft/confirmed)** |
| bank_reconciliation_items | id, recon_id, **type(bank_only/book_only)**, direction, amount, trade_date, ref_no, counterparty, summary, handled |
| bank_bills | id, **bill_no**, **type(receivable/payable)**, drawer/payee/acceptor, **accept_type(bank/commercial)**, amount, issue_date, **due_date**, **status(holding/endorsed/discounted/collected/settled/void)**, partner_type/name, discount_rate/discount_cost, cash_in_date; `UNIQUE(bill_no, type)` |

补列：`payments.bank_account_id` —— 收付款单归到具体账户（账户级对账的前提）。

口径：
- **去重指纹** = `sha1(account_id|trade_date|direction|amount|counterparty|summary)`，`UNIQUE`；重复导入直接跳过并计入 `dup_count`。
- **账面余额** = `bank_accounts.open_balance` + 截至期末 `payments`（`status IN ('valid','confirmed') AND reversed_at IS NULL`）的净额。
- **银行余额** = 期间内最后一条 `balance IS NOT NULL` 的流水；无则用 `open_balance + Σ流水` 推算。
- **对账恒等式**：`statement_balance + book_only_in − book_only_out = book_balance + bank_only_in − bank_only_out`，不等则 `diff_amount ≠ 0` 且禁止确认。
- **忽略不消失**：`match_status='ignored'` 的流水仍计入 `bank_only` 未达账项。

## 多主体核算与集团合并
| 表 | 关键字段 |
|---|---|
| companies（扩列） | **type(headquarters/branch/subsidiary)**, short_name, tax_no, legal_person, **base_currency**, **consolidation（1=纳入合并）**, parent_id, **open_period（账套启用期间）**, status(active/closed), addr, phone |
| intercompany_parties | id, **company_id（本方）**, **counter_company_id（对方）**, kind(customer/supplier/both), ref_type/ref_id, **ref_name（单据上的对方名称）**, match_key, offset_account(1122/2202), status; `UNIQUE(company_id, ref_name)` |
| intercompany_links | id, period, type(balance/txn/investment), **from_company_id（债权方）**, **to_company_id（债务方）**, from/to_voucher_id, **from_amount / to_amount / diff_amount**, status(open/matched/diff/ignored), created_by(auto/manual) |
| consolidations | id, **con_no UNIQUE(HB+YYYYMM+序号)**, period, company_count, **sum_/adj_/（合计）三段数**, asset_total/liability_total/equity_total, income_total/expense_total, net_profit, **diff_amount**, **ic_diff_cnt**, status(draft/confirmed), confirmed_by/at |
| consolidation_adjustments | id, con_id, period, **type(ic_balance/ic_txn/investment/unrealized)**, company_id, **account_code（实际命中科目）**, account_name, debit/credit, summary, source(auto/manual) |

补列（`company_id`，默认 1）：
- `gl_periods` / `gl_vouchers` / `gl_entries` / `gl_balances` / `gl_close_checks`
- `orders` / `customers` / `ar_invoices` / `ap_invoices` / `payments` / `payrolls` / `assets` / `admin_expenses`

唯一约束重建：
| 表 | 原约束 | 新约束 |
|---|---|---|
| `gl_periods` | `period UNIQUE` | **`UNIQUE(company_id, period)`** |
| `gl_vouchers` | `voucher_no UNIQUE` | **`UNIQUE(company_id, voucher_no)`** |
| `gl_vouchers` | `UNIQUE(source_type, source_id, period)` | **`UNIQUE(company_id, source_type, source_id, period)`** |
| `gl_balances` | `UNIQUE(period, account_code)` | **`UNIQUE(company_id, period, account_code)`** |
| `gl_close_checks` | `UNIQUE(period, check_code)` | **`UNIQUE(company_id, period, check_code)`** |

口径：
- **账套 = 一家主体**：凭证、期间、关账、余额快照全部按 `company_id` 隔离，互不可见（接口默认按主体过滤）。
- **内部往来双向登记**：`intercompany_parties` 必须 A→B 和 B→A 各一条，否则配对时只有单边、差额等于全额。
- **匹配用名称不用 ID**：两家公司的客户档案是各建各的，`ref_id` 对不上，所以靠 `partner_name` 命中 `match_key`。
- **抵消取两侧较小值**：差额留在报表里，不做「其他」科目抹平。

## 经营驾驶舱
| 表 | 关键字段 |
|---|---|
| cash_forecasts | id, **forecast_no UNIQUE(XJ+YYYYMMDD+序号)**, company_id（空=全集团）, **base_date**, weeks, **opening_cash** / inflow_total / outflow_total / closing_cash, **min_cash / min_week（最低点）**, **first_neg_week（首次转负）**, **gap_amount**, ar_open / ap_open, **collect_rate / overdue_rates（回收假设，JSON）**, note, created_by |
| cash_forecast_items | id, forecast_id, **week_no / week_start / week_end**, **direction(in/out)**, **category(ar_collect/ap_pay/payroll/fixed_cost)**, amount, **basis（依据：哪几张单、打的什么折）**, ref_count |
| kpi_snapshots | id, period, company_id（空=全集团）, **kpi_key**, kpi_label, value, unit(元/%/天/人), **caliber（口径说明）**; `UNIQUE(period, company_id, kpi_key)` |

口径：
- **余额是推导值不落库**：`cash_forecast_items` 只存每周流入/流出，逐周余额由 `opening_cash` 累加算出 —— 存了反而可能和明细对不上。
- **周区间由 base_date 推算**：某周没有任何现金流时明细表里没有记录，靠明细反查 `week_start` 会得到空值。
- **预测批次按 base_date 排序**：补跑历史基准日的批次时 id 更大，按 id 排会让页面默认打开旧批次。
- **账龄不落表**：全部实时算，基准日可指定（`as_of`），所以「上月末的账龄」和「今天的账龄」都能出。

## 营销与素材（M16）
| 表 | 关键字段 |
|---|---|
| mkt_tasks | id, **task_no UNIQUE(MK+YYYYMMDD+序号)**, company_id, title, **biz_type(stock/custom)**, channel / shop_name, style_no / sku / product_name, customer_id, campaign_id, **plan_launch_date（素材发布日，不是投产日）**, actual_launch_date, owner, depends, **status(draft/material/ready/launched/reviewed/cancelled)**, **gate_json（门槛快照）**, blocker, created_by |
| mkt_task_steps | id, task_id, seq, name, owner, due_date, **status(pending/doing/done)**, done_at, remark |
| mkt_task_logs | id, task_id, from_status / to_status, operator, note, **gate_json（当时过了哪几项）**, created_at |
| mkt_assets | id, **asset_no UNIQUE(AS+…)**, company_id, **kind(image/video/pattern/doc)**, title, url, version, style_no, **tech_version（对齐 TECH-Vx）**, **scope(public/channel/exclusive)**, customer_id, channels, **license_source(own/customer/supplier/ai)**, license_from / **license_to**, **ai_generated**, **status(draft/pending/approved/revoked)**, review_note, reviewed_by / reviewed_at |
| mkt_task_assets | id, task_id, asset_id, role(main/detail/video), bound_by, bound_at; `UNIQUE(task_id, asset_id)` |
| mkt_campaigns | id, **campaign_no UNIQUE(CAM+…)**, company_id, name, channel / shop_name, **currency**, budget_amount, start_date / end_date, **attribution_days**, owner, **status(draft/approved/running/billed/closed/cancelled)**, approved_by / approved_at, **actual_amount**, **attributed_orders / attributed_revenue / attributed_revenue_cny / attributed_gross_cny / roas**, settled_at |
| mkt_campaign_bills | id, campaign_id, bill_date, amount, **currency（必须与活动一致）**, vendor, ref_no, source(ads/agency/invoice/other) |
| mkt_reviews | id, **review_no UNIQUE(REV+…)**, company_id, period, topic, **category(shortage/tech_delay/complaint/asset/conversion/other)**, **evidence / source_type / source_id（来源）**, **status(draft/open/doing/done)**, owner, due_date, findings, closed_at, demo_tag |
| mkt_review_actions | id, review_id, seq, action, **owner NOT NULL / due_date NOT NULL**, status(pending/doing/done/cancelled), done_at, result |

口径：
- **过期不落库，读取时算**：`mkt_assets.status` 只记审核结论，`approved` + `license_to < 今天` 在服务层算成 `expired`。列表一刷就改库会让「谁批的、什么时候批的」对不上；真要固化走 `POST /assets/sweep-expired`。
- **营销不回写生产**：`mkt_tasks` 与 `tech_packs` / `orders` / `stock_items` 之间只有读，没有任何 UPDATE。上新和投产是两个状态机。
- **一活动一币种**：`mkt_campaigns.currency` 决定账单与归因口径，账单币种不一致直接拒；`attributed_gross_cny` 单独存本币毛利，避免和原币收入混在同一列。
- **归因不落明细表**：实时按订单 `order_date` + `shop_name` 算，剔除未确认与内部转单；只在关闭活动时把汇总写回 `mkt_campaigns` 供回看。
- **`demo_tag` 只给演示用**：复盘的原因分析是正文，不能塞标记，所以单独留一列给种子脚本识别。

## 制度问答（M17 N17-02）
| 表 | 关键字段 |
|---|---|
| ai_policy_hits | id, **question（用户原问题）**, doc_id, **doc_no**, **title（快照，制度可能改名）**, **version（当时引用的版本）**, **effective_date（当时的生效日）**, owner, coverage, rank, answer_generated_by(model/rule), actor, created_at |

口径：
- **只记引用了哪一版，不复制原文**：原文在 `sop_versions` 里，复制会让同一句话出现两处、改一处忘一处。
- **带生效日快照**：制度后来改版或补填生效日，历史记录仍能还原「当时是按哪版、哪天生效答的」。
- **`outdated` 是算出来的**：`cited_version < sop_documents.current_version` 即为引用了旧版，读取时计算，不落库（否则每次改版都要批量回写）。

## 组织编制与岗位（M02）
| 表 | 关键字段 |
|---|---|
| org_positions | id, **code UNIQUE(P+…)**, title, company_id, department_id, sequence(manage/professional/sales/tech/ops), grade(1-9), **headcount（0=未核定，不参与超编校验）**, **reports_to_id（汇报关系，禁环）**, status(active/closed), effective_from |
| employments | id, **employment_no UNIQUE(EMP+…)**, employee_id, **employer_company_id（雇佣公司）**, **service_company_id（服务公司，空=全部）**, position_id, department_id, employment_type(fulltime/parttime/secondment/outsource), start_date / end_date, **status(draft/pending/effective/ended/rejected)**, **prev_employment_id（调岗链路）**, approved_by/at, **over_headcount / over_reason（超编特批留痕）** |
| trade_routes | id, **route_no UNIQUE(RT+…)**, name, biz_type(spot/custom/outsource/service), **seller_company_id / buyer_company_id / fulfill_company_id / goods_owner_company_id / sign_company_id / pay_company_id**, **service_agreement（签约≠卖方时必填）**, service_fee_rate, status(draft/confirmed/pending_terms/disabled), demo_tag |
| subject_scopes | id, **scope_no UNIQUE(SC+…)**, user_id, username, role_label, **company_ids（逗号分隔）**, **field_scope(full/no_salary/no_cost)**, **aggregate_scope(company/group)**, status(draft/pending/effective/expired/rejected), requested_by / approved_by, effective_from / **expires_at**, **relation_version（续期 +1）**, reason |

`companies` 补列：`equity_version`（股权版本）、`start_date` / `stop_date`（启停日）、`reg_place`（注册地）。

关键索引：
| 表 | 索引 | 为什么 |
|---|---|---|
| employments | `UNIQUE(employee_id) WHERE status='effective'` | **一个人同时只能有一条生效任职**；应用层挡不住并发与脚本直连 |
| subject_scopes | `UNIQUE(user_id) WHERE status='effective'` | 一个账号同时只能有一条生效授权范围 |

口径：
- **编制是岗位的属性，不是部门的**：部门编制 = 其下启用岗位 headcount 之和，不单独存，避免两处数字打架。
- **任职不删只结束**：`ended` 保留 `end_date`，查「去年在哪个岗」靠这张表，不能靠 `employees.position`。
- **雇佣与服务分开**：技术部归总部雇佣但要服务各公司 → `employer_company_id=1`、`service_company_id` 为空（全部）或指定。
- **路线只登记不派单**：订单归属仍看 `orders.company_id`，路线用于解释「谁签、谁发、谁开票、谁收款」，两者不一致时提示而不自动改。

## 税负测算（M12）
| 表 | 关键字段 |
|---|---|
| tax_policies | id, company_id, **tax_region(CN/US/OTHER)**, **tax_type(vat/surcharge/cit/export_rebate/stamp)**, name, **rate**, **price_includes_tax**, **effective_from / effective_to**, **status(active/superseded)**, policy_no; `UNIQUE(company_id,tax_region,tax_type) WHERE status='active'` |
| tax_runs | id, **run_no UNIQUE(TAX+…)**, company_id, tax_region, **period**, revenue_total / domestic_revenue / export_revenue, **output_tax / input_tax / vat_payable / credit_carry**, surcharge_base / surcharge_amount, profit_total / cit_amount, **rebate_amount / exempt_offset**, **total_burden / burden_rate**, **status(draft/confirmed/void)**, **policy_json（当时税率快照）**, demo_tag |
| tax_run_items | id, run_id, seq, **tax_type / label**, base_amount, rate, amount, **formula（给人看的算式）**, **source（取数来源）**, note |

口径：
- **税率按主体 × 税区 × 税种配，不写死在代码里**：13% 是内销常见税率，美国没有增值税、出口走免抵退、小规模另有征收率。缺配置直接拒绝测算，不用默认值代算。
- **改税率不覆盖历史**：旧的置 `superseded` 并补 `effective_to`，批次里的 `policy_json` 记住当时用的是哪条，回看时不会被新税率改写。
- **留抵不落成负税额**：`vat_payable` 恒 ≥ 0，进项大于销项的差额进 `credit_carry`。
- **`formula` 与 `source` 必须落库**：税额是给人复核的，只给结果不给算式，财务不会认。
- **`demo_tag` 单独一列**：`note` 会被「确认/作废」追加内容，不能当演示标记（这个坑在营销与组织模块踩过两次）。

## 销售与客户（M03）
| 表 | 关键字段 |
|---|---|
| crm_leads | id, **lead_no UNIQUE(LD+…)**, company_id, **source(platform/referral/exhibition/website/import/manual)**, **source_ref（平台线索 ID，查重键）**, customer_id, customer_name_raw, contact / phone / email / country, **est_amount / est_currency（只作参考，不进任何金额口径）**, **stage(new/qualifying/sampling/won/lost)**, owner_user_id / owner_name, response_due / first_response_at, next_action_date / next_action, sample_id / order_id, lost_reason / lost_note, **in_pool / pool_since（公海）**, duplicate_of, demo_tag |
| crm_lead_logs | id, lead_id, action(create/assign/claim/follow/recycle/merge/stage), from_stage / to_stage, note, **evidence（跟进必须有）**, next_date, operator, created_at |
| crm_customer_cycles | id, **customer_id UNIQUE**, company_id, **status(unknown/known/seasonal/oneoff)**, **cycle_days（unknown/oneoff 必须为空，不许填 0）**, basis(manual/inferred/contract), reason, owner_user_id, **review_date（未知/季节性必填）**, **last_purchase_date（只由有效采购刷新）**, last_order_id, next_due_date, **grace_days（只影响升级）**, last_followup_at, demo_tag |
| crm_cycle_logs | id, customer_id, from_status / to_status, from_cycle / to_cycle, from_due / to_due, **reason（改周期必须写）**, operator, created_at |
| crm_followups | id, customer_id, cycle_id, kind(cycle_due/manual/winback), due_date, contact_note, result(no_answer/replied/ordered/lost_contact), next_date, evidence, order_id, operator, demo_tag |
| crm_handovers | id, **handover_no UNIQUE(HO+…)**, from_user_id / from_name, to_user_id / to_name, reason(resign/transfer/leave), **customer_ids（CSV 范围）**, customer_cnt, **open_order_cnt / open_task_cnt（提交时快照）**, status(draft/pending/received/done/cancelled), accepted_by / accepted_at, approved_by / approved_at |
| sales_targets | id, **target_no UNIQUE(TGT+…)**, company_id, team, period, **version**, status(draft/approved/effective/closed), currency, approved_by / approved_at, demo_tag |
| sales_target_items | id, target_id, user_id / user_name, **metric(amount/revenue/collection/gross)**, target_amount |
| commission_rules | id, **rule_no UNIQUE(CR+…)**, company_id, name, **base_type(collection/revenue/gross)**, **tiers_json**, deduct_refund, effective_from, **status(draft/approved/superseded)**, approved_by / approved_at |
| commissions | id, **commission_no UNIQUE(CM+…)**, company_id, period, user_id / user_name, **dept_snapshot / manager_snapshot（归属快照，交接不改）**, rule_id / rule_no / **rule_snapshot**, base_type, base_amount, amount, **refund_adj / bad_debt_adj**, status(draft/reviewing/rejected/approved/settled), approved_by / approved_at, **payroll_period / payroll_ref / payroll_linked_at（只生成一笔）**, created_by |
| commission_sources | id, commission_id, **kind(base/adjust)**, source_type(payment/ar_invoice/cost_object/refund/bad_debt), source_id, source_no, source_date, base_amount, rate, amount, **adjust_of（调整行指向被调整来源）** |

`customers` 补列：`owner_user_id` / `owner_name`（客户归属，交接时改；历史业绩以提成单快照为准）。

关键索引：
| 表 | 索引 | 为什么 |
|---|---|---|
| crm_leads | `UNIQUE(company_id, source, source_ref) WHERE source_ref<>''` | 同一条平台线索只进一次，网络重试/重复导入不会产生两条 |
| commission_sources | `UNIQUE(source_type, source_id) WHERE kind='base'` | **同一笔回款/发票/毛利全公司只能计提一次**，换人换月都绕不过 |
| commissions | `UNIQUE(user_id, period, company_id) WHERE status IN ('approved','settled')` | 一期一人只能有一张已批准提成单 |

口径：
- **周期未知不落 0**：`unknown` / `oneoff` 时 `cycle_days` 为 NULL。填 0 会让「应购日 = 采购日」，客户天天超期，预警失效。
- **采购日只由有效订单刷新**：内部转单、样衣、零金额补发、草稿/取消都不算；回访（`crm_followups`）**不刷新** `last_purchase_date`。
- **公海是标记不是阶段**：`in_pool=1` + `pool_since`，线索阶段仍是 `new/qualifying`，回收不改变业务进度。
- **`est_amount` 不进任何汇总**：只在列表与漏斗展示，避免「堆商机」而不是成交。
- **提成快照不可变**：`dept_snapshot` / `manager_snapshot` / `rule_snapshot` 在生成时固化，员工调动与规则改版都不回写。

## 供给批次与预订（M23）
| 表 | 关键字段 |
|---|---|
| supply_batches | id, **batch_no UNIQUE(SB+…)**, warehouse, style_no/color/size/sku, source_type/source_id/source_no, order_id, customer_id, qc_grade, intended_use, **stage(in_production/ready_to_ship/in_transit/received_checked/on_shelf/short/closed)**, **qty_planned / qty_produced / qty_ready / qty_in_transit / qty_received / qty_checked_ok / qty_on_shelf / qty_short**, **risk_buffer / frozen_qty**, eta_date / eta_evidence / eta_covered, **parent_batch_id / split_qty**, status, demo_tag |
| supply_batch_moves | id, batch_id, from_stage / to_stage, **qty（本次迁移量）**, qty_before / qty_after, **holds_carried（随之带走的占用条数）**, operator, note, created_at |
| booking_requests | id, **request_no UNIQUE(BK+…)**, customer_id/name, channel(erp/mall/mini), style/color/size/sku, qty, expect_date, **quote_price（报价快照）**, kind(spot/future), batch_id（确认时锁定）, hold_id, **status(submitted/sales_confirmed/rejected/cancelled/expired/converted)**, valid_until, **idempotency_key UNIQUE**, version, sales_user_id / sales_confirmed_at |
| stock_holds | id, **hold_no UNIQUE(HD+…)**, **kind(spot/future)**, batch_id（未来必填）, warehouse, style/color/size/sku, **qty**, **qty_picked（占用的子集，不重复扣）**, customer_id/name, request_id, order_id, **status(active/expired/released/converted)**, **temporary**, expires_at, **version**, release_reason, converted_at |
| booking_shortages | id, **shortage_no UNIQUE(SH+…)**, batch_id, hold_id, request_id, customer_id/name, sku, **qty_short / qty_committed（原承诺）**, **resolution(open/substitute/delay/cancel/written_off)**, substitute_batch_id, decided_by / decided_at, note |
| sellable_projection | id, warehouse, style/color/size/sku, **on_hand / held_spot / qty_picked / sellable / future_available**, **version**, computed_at, **stale**, **anomaly**; `UNIQUE(warehouse, style, color, size)` |
| projection_events | id, **event_key UNIQUE（幂等键）**, scope_key, delta_on_hand / delta_hold, reason, operator, created_at |

关键索引：
| 表 | 索引 | 为什么 |
|---|---|---|
| sellable_projection | `UNIQUE(warehouse, style_no, COALESCE(color,''), COALESCE(size,''))` | 一个 SKU 一行投影，商城与 ERP 读同一份 |
| projection_events | `UNIQUE(event_key)` | 同一次变更重试不会重复加减（失败重试幂等） |
| booking_requests | `UNIQUE(idempotency_key) WHERE idempotency_key<>''` | 客户/渠道重复提交不会生成第二张申请 |

口径：
- **阶段数量分开存**：`qty_planned → produced → ready → in_transit → received → checked_ok → on_shelf`，每步迁移「上游减、下游加」，`qty_short` 单独记。不这么存就无法校验数量守恒，也没法在部分到货时拆子批。
- **可承诺 = 可承诺基础量 − 短装 − 风险缓冲 − 冻结 − 已预订**；实收阶段的可承诺基础量只算 `qty_checked_ok`（**未检不能承诺**）。
- **已上架批次 `stage_qty = 0`**：那批货已进 `stock_items`，未来可订必须按 0，否则与现货重复计数。
- **占用是唯一占量凭证**：申请本身不占量；`stock_holds.status='active'` 且未过期的才从可卖池扣。
- **`qty_picked` 只作展示**：它是占用的子集，任何可卖量计算都不能再减一次。
- **投影只存结果**：库存事件是账源，`projection_events` 去重，`computed_at` 超过 30 分钟在读取时算 `stale`（不落库）。

## 客户营销与消息（M24）
| 表 | 关键字段 |
|---|---|
| msg_templates | id, **template_no UNIQUE(MT+…)**, company_id, **event_key(new_product/restock/order_status/cycle_due/promo_digest/inquiry_reply)**, **channel(site/email/wechat)**, lang, **version**, subject, body, **variables_json**, **status(draft/pending/approved/retired)**, approved_by/at, change_note, demo_tag |
| msg_subscriptions | id, customer_id, account_id, **topic(order/service/arrival/marketing)**, **channel**, **status(subscribed/unsubscribed/never)**, opt_in_source, opt_in_at, **opt_out_at / opt_out_reason**, **verify_status(none/pending/verified/failed) / verified_at / verify_token**, locale, **timezone**, frequency, demo_tag; `UNIQUE(customer_id,topic,channel)` |
| msg_events | id, **event_no UNIQUE(EV+…)**, company_id, **event_key**, biz_type, biz_id, style_no, sku, title, payload_json, occurred_at, **dedupe_key UNIQUE**, created_by, demo_tag |
| msg_outbox | id, **outbox_no UNIQUE(OB+…)**, event_id, customer_id, account_id, topic, channel, template_id, **template_version**, recipient, subject, body, **status(queued/held/submitted/delivered/read/failed/skipped)**, skip_reason, **retry_cnt / max_retry / next_retry_at / fail_reason**, **dedupe_key UNIQUE**, scheduled_at, sent_at, delivered_at, read_at, **opened_at（打开≠已读）**, provider_msg_id, **degraded_from（降级来源渠道）**, demo_tag |
| msg_delivery_logs | id, outbox_id, channel, **event(generated/held/skipped/submitted/delivered/read/opened/failed/retry/degraded)**, detail, provider_code, operator, created_at |
| msg_frequency_rules | id, company_id, **scope(global/customer)**, customer_id, max_per_day, max_per_week, min_gap_minutes, **quiet_start / quiet_end（客户当地时间）**, digest_hour, status, note; `UNIQUE(scope, COALESCE(customer_id,0))` |
| msg_arrival_alerts | id, **alert_no UNIQUE(AL+…)**, customer_id, account_id, style_no, **kind(new_product/restock)**, threshold_qty, **status(waiting/notified/cancelled)**, notified_at, outbox_id, source, note, demo_tag; `UNIQUE(customer_id,style_no,kind) WHERE status='waiting'` |
| msg_channel_capabilities | id, company_id, **channel**, **status(enabled/disabled/unauthorized)**, **verify_status(verified/unverified)**, evidence, reason, verified_at; `UNIQUE(company_id,channel)` |
| msg_wechat_bindings | id, customer_id, account_id, **openid UNIQUE**, unionid, **subscribe_status(subscribed/unsubscribed/unknown)**, template_ids_json, verified, verified_at, last_sync_at, note, demo_tag |
| msg_attributions | id, outbox_id, event_id, customer_id, style_no, **stage(delivered/read/inquiry/order)**, ref_type, ref_id, ref_no, window_days, revenue_cny, snapshot_at, note; `UNIQUE(outbox_id,stage,ref_id)` |

关键索引：
| 表 | 索引 | 为什么 |
|---|---|---|
| msg_templates | `UNIQUE(event_key,channel,lang) WHERE status='approved'` | 同一组合同时只能有一条生效；改文案是出新版、旧版停用 |
| msg_outbox | `UNIQUE(dedupe_key)` | 同一事件同一客户同一渠道同一模板版本只发一次（失败重试走同一条，不新建） |
| msg_arrival_alerts | `UNIQUE(customer_id,style_no,kind) WHERE status='waiting'` | 客户重复点「到货通知我」不会堆一串等待记录 |

口径：
- **事件与发送分两张表**：一件上新只有一条事件，N 个订阅者产生 N 条发送计划。事件去重防重复触发，发送去重防重复打扰。
- **`opened_at` 与 `read_at` 分开**：打开邮件只记 `opened_at`，状态仍是 delivered；阅读率只认 `read` 回执（未送达不许报已读）。
- **`degraded_from` 记录原本想走的渠道**：微信不可用降级到站内后，这条记录仍能回答「为什么没走微信」。
- **`verify_status` 只对邮件有意义**：未核验的邮箱订阅虽然 `subscribed`，但 `usable=false`，发送时降级。
- **退订只改 `status` + `opt_out_at/reason`**：不删行，保留「何时退、为什么退」。
- **归因是快照**：`msg_attributions` 一次写入不再回写，销售交接与客户归属变化都不影响历史归因；同一单只归最早一条触达（应用层判断）。

## 美仓作业计划（M19）
| 表 | 关键字段 |
|---|---|
| pick_waves | id, **wave_no UNIQUE(PW+…)**, warehouse, strategy(zone/order/manual), carrier, **tracking_no UNIQUE（部分索引）**, package_weight, item_cnt, qty_total, qty_picked, **status(draft/released/picking/packed/shipped/cancelled)**, short_reason, cancel_reason, note, released_at / packed_at / shipped_at / cancelled_at, demo_tag |
| pick_wave_items | id, wave_id, **hold_id**, order_id, customer_id/name, location_id, loc_code, **loc_source(sku_stock/capacity/manual)**, style/color/size/sku, qty, qty_picked, qty_short, short_reason, seq, **status(pending/picked/short/cancelled)**, picked_by / picked_at |
| wh_asn_legs | id, asn_id, seq, mode(ocean/air/rail/truck), carrier, etd / eta, actual_at, status(planned/in_transit/arrived), note |
| wh_asn_boxes | id, asn_id, carton_no, style_no, expect_qty, received_qty, short_qty, over_qty, damaged_qty, **reason（有差异必填）**, checked_by / checked_at; `UNIQUE(asn_id, carton_no)` |
| wh_asn_changes | id, asn_id, field(eta_date/ship_date), from_value, to_value, **impacted_cnt（受影响需求数）**, reason, operator, created_at |

`wh_putaways` 补列：`style_no` / `color` / `size`（上架记录不带 SKU 就没法按库位拣货）。

关键索引：
| 表 | 索引 | 为什么 |
|---|---|---|
| pick_wave_items | `UNIQUE(hold_id) WHERE hold_id IS NOT NULL AND status<>'cancelled'` | **一笔预留只能进一个未取消波次**；否则会被拣两次、扣两次库存 |
| pick_waves | `UNIQUE(tracking_no) WHERE tracking_no<>''` | 一个运单号只能贴一个包裹 |
| wh_asn_boxes | `UNIQUE(asn_id, carton_no)` | 同箱号重复提交是更新，不是再加一箱 |

口径：
- **库位结存 = 上架量 − 已交承运波次的拣出量**：两个既有账源相减，不新建库位库存表（否则要三处同步）。
- **`loc_source` 说明库位怎么来的**：`sku_stock` 按该 SKU 库位结存、`capacity` 按剩余容量兜底、`manual` 拣货时人工指定。
- **`qty_short` 只在复核时写**：未拣完的数量是「未拣」，不是「短拣」，两者在列表里分开显示。
- **头程不改库存**：段与箱只登记运输事实，真实收货上架走 `wh_receipts` / `wh_putaways`。

## 迁移 MySQL

**不是"换驱动 + 改 SQL 方言"这么简单**，按这一节的简化版直接上手会踩空。真正的代价清单与分阶段方案在
`deploy/DEPLOY.md` §9.3（359 张表 / 4655 处 `db.prepare` / 204 处显式事务 / 5 类 SQLite 专有语法）。

真要迁，最短的正确路径是：

1. 先把散落在 122 个路由文件里的 SQL 收进 `services/`（现在没有统一的数据访问层，双写无从下手）；
2. 建 MySQL 结构 + 双写对影子读，同一批业务场景比对两边结果；
3. 逐类替换方言：`AUTOINCREMENT`→`AUTO_INCREMENT`、`ON CONFLICT…DO UPDATE`→`ON DUPLICATE KEY UPDATE`、
   `julianday/strftime/date('now')`→`DATEDIFF/DATE_FORMAT/NOW()`、`VACUUM INTO`→`mysqldump`、
   `PRAGMA table_info`→`information_schema`、`BEGIN IMMEDIATE`→`SELECT … FOR UPDATE`；
4. 全量迁移后对四本账（订单金额 / 库存 / 借贷平衡 / 应收应付）逐一核对；
5. 灰度切换并保留 SQLite 回退窗口。

## 有限产能排程（M06）

| 表 | 关键字段 | 说明 |
|---|---|---|
| wc_calendars | work_center, cal_date, base_hours(0~24), start_hour, is_workday, note, UNIQUE(work_center,cal_date) | 班次日历。**缺行 = 当天 0 小时**，系统不假设 8 小时；`base_hours=0` 表示休息/停产 |
| process_standards | process_name(UNIQUE), work_center, std_minutes, setup_minutes, efficiency, batch_min_qty, active | 工序产能定额。`std_minutes<=0` 或 `active=0` 视为未配置，**该工序不排** |
| schedule_runs | run_no(UNIQUE), company_id, version, algo, horizon_from, horizon_to, order_count, task_count, conflict_count, block_count, late_count, full_days, util_rate, status(draft/published/archived), is_current | 排程批次。`UNIQUE(company_id) WHERE is_current=1` 保证同主体只有一个当前生效 |
| schedule_tasks | run_id, order_id, order_no, node_id, style_no, process_name, seq, work_center, qty, std_minutes, setup_hours, est_hours, start_at, end_at, day_load(JSON), due_date, finish_by_due, locked, lock_reason, status, UNIQUE(run_id,order_id,process_name) | 排程任务。`day_load` 记每天占用明细（支持「分 N 段」）；`std_minutes` 是定额快照，改定额不影响历史 |
| schedule_conflicts | run_id, type, level(block/warn/info), order_id, order_no, work_center, process_name, task_id, on_date, detail, suggestion, metric, resolved, resolved_note/by/at | 冲突与风险。硬冲突未全部 resolve 时不允许发布 |
| schedule_changes | run_id, task_id, order_no, process_name, field, old_value, new_value, reason, operator | 人工调整留痕。改排程必须写原因 |

> 与既有表的关系：交期取 `commitments.promised_date`（回退 `orders.delivery_date`）；缺料取 `material_requirements.gap_qty` + 在途 `purchase_items/po.expect_date`；停机取 `equipment_downtimes`；工作中心与台时产能取 `equipment`；工序清单取 `order_nodes`（缺省 13 道）。

## 现货经营与备货（M19）

| 表 | 关键字段 | 说明 |
|---|---|---|
| spot_policies | warehouse, scope(global/category/style), style_no, category, target_cover_days, safety_days, lead_time_days, min_order_qty, lot_size, stop_cover_days, stop_age_days, dead_days, min_sample_days, status, UNIQUE(company_id,warehouse,scope,style_no,category) | 备货策略。按款 → 类目 → 全局 → 内置默认逐级回退 |
| spot_proposal_runs | run_no(UNIQUE), warehouse, as_of_date, window_days, line_count, replenish_count, stop_count, urgent_count, sample_short_count, status(draft/published/archived), is_current | 提案批次。`UNIQUE(company_id,warehouse) WHERE is_current=1` 保证同仓只有一个当前生效 |
| spot_proposal_lines | run_id, kind(replenish/stop/watch), reason_code, style_no, color, size, sku, on_hand/held/sellable/in_transit/in_production/qty_available, daily_out/out_qty/out_days/sample_ok, cover_days, stockout_date, age_days, sell_through, size_broken, unit_cost, target_cover_days, lead_time_days, suggest_qty, suggest_order_date, urgent, priority, reason, status, approved_qty, UNIQUE(run_id,style_no,color,size,kind) | 提案行。**数量全是生成时快照**，后续改库存不影响历史提案 |
| spot_proposal_decisions | run_id, line_id, action(approve/reject/defer), qty_before, qty_after, note, operator | 决策留痕。驳回/暂缓必须写原因 |

> 数量来源（本模块**不持有库存**）：可售取 `sellable_projection`（缺失退化为 `stock_items` − `stock_holds` 有效现货占用）；在途/在产取 `supply_batches`（只认 `eta_covered=1` 的 ETA）；销速取 `stock_ledger`（`type='out'`）；库龄用 FIFO 反算余量批次。

## 分公司经营对比（M12）

| 表 | 关键字段 | 说明 |
|---|---|---|
| segment_adjustments | company_id, period, kind(one_off/allocation/fx/other), amount, note, created_by | 可比口径调整。`amount` 是**对可比净利的影响**（正=更高）；**不改账**，账载净利永远保留 |
| segment_reports | report_no(UNIQUE), period, company_count, total_income, total_external_income, total_net, consolidated_income, ic_amount, issue_count, payload(JSON), status(draft/confirmed) | 对比报告快照。确认后 payload 冻结，后续改账不影响历史报告 |

> 数据来源（本模块**不持有业务数据**）：损益取 `gl.js incomeStatement`、资产负债取 `balanceSheet`；内部收入取 `gl_entries.partner_name` ∩ `intercompany_parties`；合并数取 `consolidations`；人数取 `employments`；往来差异取 `intercompany_links`。


## 备料领退与盘点差异（M10）

| 表 | 关键字段 | 说明 |
|---|---|---|
| material_ledger | material_id, type(receipt/issue/issue_return/po_return/stock_gain/stock_loss/scrap), qty(带符号), unit, ref_type, ref_id, ref_no, operator | **原料流水的唯一来源**。`materials.stock_qty` 的每一次增减都必须在这里留一条，禁止裸 UPDATE |
| material_issues | issue_no(UNIQUE), order_id, order_no, style_no, kind(order/extra/sample), receiver_type(own/outsource), req_date, status(draft/prepared/issued/partial/closed/cancelled), item_count, req_qty, issued_qty, amount, prepared_by/at, issued_by/at | 备料/领料单。`prepared` 表示**已占用库存但货还在仓里**；`partial` 表示还有欠发 |
| material_issue_items | issue_id, material_id, name, spec, unit, req_qty, issued_qty, returned_qty, price, amount, batch_no, short_qty, UNIQUE(issue_id,material_id,name) | 明细。`short_qty = req − issued`（欠发）；`可退 = issued − returned`；`price` 是发料时快照 |
| material_returns | return_no(UNIQUE), issue_id, order_id, order_no, type(leftover/wrong_spec/defect/order_cancel), status(draft/confirmed/cancelled), qty, amount, reason(NOT NULL) | 退料单。**必须挂在已发料的单上**，否则退回来的东西来路不明 |
| material_return_items | return_id, issue_item_id, material_id, name, unit, qty, price, amount, batch_no | 退料明细。校验以 `issue_item.issued_qty − returned_qty` 为准 |
| stocktakes | take_no(UNIQUE), scope(material), warehouse, take_date, status(draft/counting/submitted/adjusted/cancelled), **freeze**, item_count, diff_count, gain_qty/loss_qty, gain_amount/loss_amount, uncosted_count, counter, reviewer | 原料盘点。`counting`/`submitted` 且 `freeze=1` 时**冻结原料收发**；`uncosted_count` = 算不出金额的差异条数 |
| stocktake_items | take_id, material_id, name, unit, **book_qty**(账面快照), **count_qty**(NULL=未盘), diff_qty, price, diff_amount(NULL=未计价), reason, adjusted, UNIQUE(take_id,material_id) | 盘点行。**未盘 ≠ 0**；有差异必须写原因；`diff_amount` 为 NULL 表示「没有采购价，不算金额」 |

> 与既有表的关系：需求侧取 `order_materials`（订单面辅料用量，含损耗）；可用库存仍是 `materials.stock_qty`（本模块只负责让它**有流水可追**）；收货合格入库走 `receipts.js → applyStock(type='receipt')`；采购退料走 `purchaseChanges.js → applyStock(type='po_return')`；计价单价取 `purchase_items` 最近一次采购价（取不到则为 NULL，不猜）。

## 价格快照与费用池（M11）

| 表 | 关键字段 | 说明 |
|---|---|---|
| cost_pools | pool_no(UNIQUE), period(YYYY-MM), name, kind(manufacturing/admin/selling), driver(labor_hours/qty/material_amount/revenue), total_amount, allocated_amount, base_total, object_count, status(draft/distributed/reverted/closed), **in_cost** | 费用池。`total_amount` **由明细汇总，不能手填**；`in_cost=1`（制造费用）才写进产品成本 |
| cost_pool_expenses | pool_id, expense_date, category, description(NOT NULL), amount, source(manual/admin_expense), ref_id | 池内费用明细。**日期必须落在池期间内**；负数（红冲）要写说明 |
| cost_pool_allocations | pool_id, cost_object_id, order_no, driver_base, base_total, share_ratio, amount, **in_cost**, **cost_entry_id** | 分摊结果。`cost_entry_id` 指向写入的 `cost_entries`，撤销时按它删并回滚 `actual_cost`；**分摊额合计 = 池额**（尾差归基数最大者） |
| price_books | book_no(UNIQUE), version, scope(factory/cost_plus), customer_id, currency, rate, effective_from, effective_to, item_count, **below_cost_count**, status(draft/published/superseded/archived), based_on_id, publish_note | 价格本。**`UNIQUE(company_id, scope, IFNULL(customer_id,0)) WHERE status='published'`** 保证同范围同客户只有一版生效 |
| price_book_items | book_id, style_no, style_name, size, min_qty, max_qty, price, **cost_unit**(成本快照), cost_source, gross_margin, **below_cost**, note, UNIQUE(book_id, style_no, size, min_qty) | 价格项。`cost_unit` 在发布时重算并冻结；`below_cost=1` 表示售价低于成本（发布必须写说明） |

> 与既有表的关系：动因基数取 `production_reports.hours`（工时）、`cost_objects.qty`（件数）、`cost_entries`（材料额）、`cost_objects.revenue_cny`（收入）；分摊写回 `cost_entries`（`ref_type='cost_pool'`）并更新 `cost_objects.actual_cost`；成本快照取 `cost_objects.actual_cost / qty`（退而用 `cost_sheets.total_cost / qty`）；客户名取 `customers`。**价格本不参与下单强校验**——订单存的是自己当时的单价，价格本用于报价、查价与「用过期成本定价」的预警。

## 长期投资抵消（M12）

| 表 | 关键字段 | 说明 |
|---|---|---|
| equity_investments | inv_no(UNIQUE), company_id(投资方), investee_id(被投企业), method(cost/equity), acquire_date, acquire_cost, share_pct, equity_adjust, dividend_received, book_value, status(active/disposed) | 长期股权投资。**`UNIQUE(company_id, investee_id) WHERE status='active'`** 保证同一被投企业只有一条有效投资。`book_value` 由代码按核算方法算：成本法 = `acquire_cost`；权益法 = `MAX(0, acquire_cost + equity_adjust − dividend_received)` |
| equity_investment_changes | investment_id, change_date, type(equity_share/dividend/increase/decrease/dispose), amount, share_before/after, book_before/after, reason | 投资变动留痕。记变动前后持股与账面，**账面价值可逐笔回溯** |

**consolidations 新增 4 列**

| 列 | 说明 |
|---|---|
| goodwill | 商誉 = 长投 − 应享权益（>0）。**不摊销**，每年做减值测试 |
| minority_equity | 少数股东权益 = 子公司权益 × (1 − 持股比例)，列在合并权益内 |
| investment_offset | 本期抵消的长期股权投资账面合计 |
| bargain_gain | 负商誉 = 应享权益 − 长投（>0），计入当期营业外收入 |

**新增 4 个科目**：1511 长期股权投资（资产·借）、1701 商誉（资产·借）、4201 少数股东权益（权益·贷）、6301 营业外收入（收入·贷）。

> 与既有表的关系：长投取 `equity_investments`；子公司权益取 `gl.js balanceSheet`（**`equity` 明细合计 ≠ `equity_total`，差额是未结转损益，抵消时要补成一行**）；抵消分录写 `consolidation_adjustments`（`type='investment'`）；合并主表经 `group.js buildConsolidation` 汇总，`consolidation_adjustments` 里 `type='investment'` 的行就是长投抵消分录。**分公司（companies.type='branch'）不参与抵消**。

## 裁片外发与外协验货交接（M07）

| 表 | 关键字段 | 说明 |
|---|---|---|
| cut_dispatches | dispatch_no(UNIQUE), cut_order_id, cut_no, order_no, factory_id, out_date, expect_return_date, bundle_count, out_qty, returned_qty, accepted_qty, rejected_qty, rework_qty, loss_qty, price, amount, status(draft/sent/partial/returned/closed/cancelled), loss_reason | 裁片外发单。`out_qty` **= 扎包件数合计，不能手改**；`loss_qty` = 外协声明不再补的短数；`amount` = **合格件 × 单价**（不良与返工不付加工费） |
| cut_dispatch_items | dispatch_id, bundle_id, bundle_no, lot_no, dye_lot, color, size, qty, returned_qty, accepted_qty, rejected_qty, rework_qty, **short_qty**, **open_flag**, UNIQUE(bundle_id) WHERE open_flag=1 | 外发明细，**粒度到扎**。`open_flag=1` 表示这张单还没结案；**部分唯一索引禁止同一扎同时挂在两张未完结单里**。扎级 `未回 = qty − returned_qty − short_qty` |
| cut_dispatch_receipts | receipt_no(UNIQUE), dispatch_id, receive_date, qty, accepted_qty, rejected_qty, rework_qty, short_qty, handover_by, received_by, inspected_by, inspect_result(pass/conditional/reject), short_reason | 回货验收单。**三方签名必填**；`qty = 合格 + 不良 + 返工`（三分闭合）；`short_qty` 是本次声明不再补的数量 |
| cut_dispatch_receipt_items | receipt_id, dispatch_item_id, bundle_no, qty, accepted_qty, rejected_qty, rework_qty, defect_reason | 回货明细，按扎记回来几件、不良原因 |

> 与既有表的关系：扎取 `cut_bundles`（`status` 为 `checked/ok/handed` 才算复核过）；床号与缸号取 `cut_lots`；合格裁片上限取 `cut_orders.qualified_qty`；外协厂取 `factories`。**与 `dispatch_orders`（整单分厂）不是一回事**：那个按订单件数，这个按扎。**回货合格不写 `stock_items`**——成品入库仍走 `/api/stock/instock`。


## 研发立项与 SKU 配码主档（M05）

| 表 | 关键字段 | 说明 |
|---|---|---|
| dev_projects | project_no(UNIQUE), style_no, biz_type, customer_id, source(new/repeat/new_pattern), reuse_project_id, classify_approved_by, owner, pattern_no, sample_no, target_qty, plan_launch_date, stage, status, pattern_reusable | 研发立项。`stage` 只许前进一格；`source=repeat` 必须指原项目；`pattern_reusable=1` 必须经过大货验证；**`target_qty` 只是计划，不产生单据** |
| dev_milestones | project_id, kind(tech_approved/sales_accepted/order_placed/in_production/us_launched), occurred_on, qty, ref_type/ref_id/ref_no, operator, UNIQUE(project_id,kind) WHERE kind IN ('tech_approved','sales_accepted','us_launched') | 里程碑**事件流**。一次性事件唯一索引防重复登记；**开发款数只数 tech_approved 且 source≠repeat** |
| dev_tasks | project_id, kind(pattern/sample/tech_pack/costing), title, owner, due_date, status(todo/doing/done/blocked/cancelled), blocked_reason, output, reuse_pattern | 研发任务，**不进 orders**。`done` 必须有 output；`blocked` 必须有 reason |
| sku_masters | sku(UNIQUE), style_no, pattern, color, size, kind(single/set), unit, barcode, customer_id, pack_spec_id, status, UNIQUE(style_no,IFNULL(pattern,''),IFNULL(color,''),IFNULL(size,''),IFNULL(customer_id,0)) WHERE kind='single' | SKU 主档。**单件单位=件、套装单位=套**；部分唯一索引保证单花单码唯一 |
| pack_specs | pack_no, sku_id, kind(set/carton), version, status(draft/active/superseded), total_qty, effective_from/to, UNIQUE(IFNULL(sku_id,0),kind) WHERE status='active' | 配码/箱规版本。`total_qty` **由明细算出**；同对象同类同时只有一版生效 |
| pack_spec_items | spec_id, item_type(ratio/component), component_sku_id, size, qty | 配码明细。`ratio` 用于箱规（尺码+件数），`component` 用于套装（组件 SKU + 件数） |
| sku_aliases | sku_id, alias(UNIQUE), source(supplier/customer/system), status, note | 别名。**停用不删**，历史单据仍可反查；停用要写原因 |

> 与既有表的关系：本模块**不持有库存与订单**。技术包的 `tech_packs` 从下单开始，研发立项在**下单之前**；`sku_masters.sku` 与 `order_items.sku`、`stock_items.sku` 同码，但主数据以本表为准；`dev_projects.tech_pack_id` 在核准后关联技术包。


## 供方信息协同与技术再次审核（M05-06）

| 表 | 关键字段 | 说明 |
|---|---|---|
| tech_assignments | tech_pack_id(UNIQUE), order_id, tech_owner, pattern_scope(self/outsource/reuse), pattern_vendor_id, reuse_tech_pack_id, pattern_price, status(draft/confirmed) | **A1 技术处理与制版分工**。一个技术包只有一条；`reuse` 必须指向已核准的技术包；已确认后改动需 `force` |
| supplier_confirms | confirm_no(UNIQUE), tech_pack_id, requirement_no, material_id, **material_key**, material_name, spec, composition, supplier_id, source_type(existing/new_dev/sample_only), sample_basis, approval_ref, unit_price, lead_days, version, is_current, superseded_by, status(draft/confirmed/cancelled), UNIQUE(tech_pack_id, material_key) WHERE is_current=1 | **A2 材料供货条件（有版本）**。`material_key` = 有编码 `M{id}` / 没编码 `N{名称}`；**同物料只能一版生效**；`sample_only` 必须有 `approval_ref` 且不能直接大货采购 |
| tech_reviews | review_no(UNIQUE), tech_pack_id, confirm_id, confirm_version, material_name, conclusion(pass/conditional/reject), diff_reason, approved_by, approved_at, UNIQUE(tech_pack_id, IFNULL(material_name,'')) WHERE conclusion<>'reject' | **A3 技术复审**。`confirm_id` + `confirm_version` 是引用快照；**引用的 A2 一旦不是当前版本，本条自动视为失效**（读取时算 `stale`，不物理删除，留痕） |

> 与既有表的关系：`tech_packs` 补 `demo_tag`（演示用自己的技术包，不借用别人的——核准会改 `status`）；供方资格判定复用 `supplier_evaluations` + `routes/supplierEvals.js` 的 `qualificationGate`；本模块**不写库存、不写采购单**——`sample_only` 只标记「不可直接采购」，真正的采购单仍由采购模块按合格供方创建。


## 上线准备：真实数据导入（M-ONBOARD）

| 表 | 关键字段 | 说明 |
|---|---|---|
| import_batches | batch_no(UNIQUE), type, type_label, file_name, delimiter, total_rows, ok_rows, new_rows, update_rows, error_rows, skipped_rows, status(committed/failed), skip_errors, errors(JSON), note, operator, created_at, finished_at | 导入批次留痕。**导入失败也留一条**（`status='failed'`），事后能查是哪批出的问题；`errors` 存错误行明细（最多 200 条） |

> 导入不新增业务表，只写既有主数据与库存：`customers` / `suppliers` / `materials` / `products` / `sku_masters` / `stock_items` + `stock_ledger`（`type='opening'`，`ref_type='import'`）。
> **期初库存的幂等依据**：`stock_ledger` 里该 仓+款+色+码 是否已有 `type='opening'` 记录 —— 有就拒绝，这是「期初只能导一次」的硬依据，不靠人记。

## 上线准备：岗位权限复核（M-RBAC）

| 表 | 关键字段 | 说明 |
|---|---|---|
| user_roles | user_id, role, granted_by, note, UNIQUE(user_id, role) | **附加岗（一人多岗）**。`users.role` 仍是主岗，这里存兼岗，生效权限取并集。不重复存主岗 |
| access_exceptions | user_id, perm, effect(deny/allow), reason, created_by, UNIQUE(user_id, perm) | **用户级权限例外**。`deny`= 从角色默认里收回；`allow`= 抵消同一权限点的 deny（**不跨角色提权**，避免变成暗权表）。`reason` 必填（后端硬校验），复核时要能解释「为什么这个人跟别人不一样」 |
| access_reviews | review_no(UNIQUE), period, scope, users_total, perms_total, exceptions_count, conflicts_count, changes(JSON), signed_off_by, signed_off_at, note, operator | **复核签字留痕**。签字时把当时的账号数/例外明细/冲突数一起快照 —— 以后有人问「当时是谁确认的」，翻这条 |

> `users.role` 的取值域扩充为 8 个：`admin` / `boss` / `sales` / `tech` / `production` / `warehouse` / `finance` / `hr`。
> `boss`（总经理）不持有任何写权限点，靠 `requireRole` 里「boss + GET 放行」实现只读。
> `viewer` 已从角色清单移除（从未真正使用，与 boss 语义重叠）。
>
> 与既有表的关系：`access_exceptions.perm` 的取值必须是 `backend/src/access/permissions.js` 里定义过的权限点（后端校验，不存在的点直接拒），
> 这样才能保证「权限点表 → 角色默认 → 用户例外」是一条链，不会冒出无源之水。

## 上线准备：备份与恢复（M-BACKUP）

| 表 | 关键字段 | 说明 |
|---|---|---|
| backup_jobs | job_no(UNIQUE), kind(manual/pre_restore/auto/drill/restore), file_name, file_path, size_bytes, **sha256**, tables_count, rows_total, key_rows(JSON), app_version, verify_status(unchecked/ok/failed), verify_at, verify_note, restore_status(pending/applied/rolled_back/failed), restore_at, note, operator, duration_ms, created_at | **每一次备份与恢复都留一条**。`kind=restore` 是「重启时应用了恢复」的记录（由 `db.js` 在启动时写入），文件名为空、`file_path` 为空。`verify_note` 存校验结论或失败原因；保留策略清理文件后会在 note 里追加标记，记录本身不删 |

> **磁盘结构**（都在 `backend/data/` 下，已被 `.gitignore` 忽略）：
> - `backups/BK<日期>-<序号>.db` —— 正常备份文件
> - `backups/BK<日期>-<序号>-pre-restore.db` —— 恢复前自动生成的回滚点
> - `restore-pending.db` + `restore-plan.json` —— 待恢复文件与计划（只在「准备完、还没重启」这段时间存在）
> - `replaced/replaced-<时间>.db` —— 恢复时换下来的旧库（**不删**，唯一的物理退路）
> - `replaced/restore-failed-<时间>.db` —— 校验不过被放弃的待恢复文件
> - `replaced/restore-cancelled-<时间>.db` —— 被人工撤销的待恢复文件
>
> **`sha256` 的用途**：同一个文件在服务端、下载到本地、再上传回来，都能比对是不是同一份。
> 但**不要拿它判定「恢复是否成功」** —— WAL 模式下服务启动后会正常写入，主库文件指纹必然变化。

## 现场照片留证（M-PHOTO）

**复用 `attachments`，不新建 photos 表** —— 附件本来就是「文件挂在业务对象上」这件事，
再开一张表会让「看一张单的所有附件」变成两处查询，迟早漏掉一侧。

| 新增列 | 说明 |
|---|---|
| cat | 分类：`defect` 不良 / `incoming` 到货 / `packing` 装箱 / `sample` 样品 / `other` 其他。取值域写死在服务端，不接受自由输入 |
| note | 一句说明。**`cat='defect'` 时后端硬校验至少 2 字** —— 没有说明的不良照片三个月后没人看得懂 |
| node_id | 关联工序（可空）。不良照片要能说清是哪道工序出的问题；后端校验该工序属于同一订单 |
| taken_at | 拍摄时间（可空）。手机时间与上传时间常常不同（夜里补传很常见），统计与展示优先用它 |
| deleted_at | **软删除标记**。照片是证据，物理删掉之后「当时到底什么样」就永远说不清了 |

索引：

```sql
idx_att_order_cat  ON attachments(target_type, target_id, cat)   -- 订单详情附件区 / 按单筛
idx_att_cat_time   ON attachments(cat, created_at)              -- 照片墙按分类倒序
```

> 历史数据：本模块上线前的附件 `cat` 默认 `other`、`note`/`node_id`/`taken_at` 为 NULL，
> 订单详情里仍按「图片走缩略图、其他走文件行」显示，不会丢。
>
> 磁盘：`data/uploads/photos/YYYY-MM/`，按月分目录；已被 `.gitignore` 忽略（`data/uploads/`）。

## 验货报告（M-INSPECTION）

| 表 | 关键字段 | 说明 |
|---|---|---|
| inspection_reports | report_no(UNIQUE), order_id, **version**, qc_result(pass/fail/conditional/**none**), qc_inspection_no, photos_count, issues_open, **snapshot(JSON)**, generated_by, generated_at, note | **对外文件的快照**。`snapshot` 是生成那一刻的整单数据（订单/明细/尺码配比/验货单与检验项/异常/首件/报工/照片），之后内部怎么变都不影响已生成的报告。同订单可多次生成，`version` 递增，旧版不覆盖。索引 `idx_ireport_order(order_id, version)` |

> **为什么存整份快照而不是只存关键数字**
> 报告是给客户签字的文件。只存"结论 + 张数"这种摘要，客户追问"当时报告里那条异常写的什么"就答不上来。
> 整份 JSON 一份几 KB 到几十 KB（照片只存 URL 不存二进制），换来的是一份可以原样复原的文件。
>
> **`qc_result='none'` 是正常取值**
> 表示「本单还没有已完成的验货单」。报告里显示「未验货」，正文明确写「不作为出货依据」，
> 不允许根据照片或报工数据推断合格。
>
> **照片在快照里存引用**
> `snapshot.photos[].url` 指向 `/uploads/photos/...`。因为 `attachments` 是软删除（`deleted_at`）且文件不物理删除，
> 已发报告里的图长期可访问。这是软删除决策的兑现 —— 若改成物理删除，历史报告会变成一堆裂图。

## 扎标（M-LABEL）

只加一列：

| 表.列 | 说明 |
|---|---|
| production_reports.bundle_no | 报工对应的扎号（可空）。扫扎标报工时自动带上，用于追溯「这一扎是谁做的」。**只用于追溯，不参与任何汇总** —— 报工累计、工序状态、成本分摊仍按 `order_id + node_id` 聚合，所以加这一列不改变既有口径 |

索引 `idx_preport_bundle(bundle_no)`：查「某一扎做过哪些工序」用。

> **扎标本身不建表**。扎的数据来自既有的 `cut_bundles` + `cut_lots`（缸号/床次）+ `cut_orders`（裁剪单号/混缸标记），
> 标签是「渲染视图」，不产生新数据 —— 否则扎会存两份，迟早不一致。

## 扎级完工进度（M-BUNDLE-PROGRESS）

**不建表**。整页是 `cut_bundles`（扎）+ `order_nodes`（工序）+ `production_reports`（`bundle_no` 归扎）
三张表的聚合视图，任何一份落库的「进度快照」都会立刻与源数据不一致。

> 上一轮给 `production_reports` 加 `bundle_no` 时定的规矩在这里兑现：
> 该列**只用于追溯，不参与任何汇总**。所以这一轮做扎级进度时，
> 订单级报工累计、工序状态、成本分摊口径**一行都没改**——新页面只是换了个维度看同一批数据。
>
> 唯一的索引支撑：`idx_preport_bundle(bundle_no)`（上一轮已建），以及按订单查报工走 `order_id`。

## 计件工资（M-PIECE-WAGE）

| 表 | 关键字段 | 说明 |
|---|---|---|
| piece_rates | style_no(可空=通用), process_name, unit_price, effective_from, effective_to, status(active/disabled), note | **单价版本化**。唯一索引 `(IFNULL(style_no,''), process_name, effective_from)` 防同键重复导致取价摇摆。改价 = 新增一条，不动旧记录 |
| piece_wage_config | id(恒为 1), daily_cap_qty, month_cap(0/1), attendance_policy(warn/exclude/block), updated_by/at | **单行配置表**。`daily_cap_qty = 0` 时所有件数闸门全部不生效（默认 0）。策略默认 `warn` = 照算但确认要说明，改扣钱必须人工切 `exclude`/`block` |
| piece_wage_runs | run_no, period, status(draft/confirmed/void), items_count, employees_count, total_qty, total_amount, missing_rate_count, unassigned_count, capped_count, **att_conflict_count / att_excluded_count / att_capped_count**, payload(JSON 诊断快照 + 当时的策略与日上限), note, created_by/confirmed_by | **部分唯一索引** `WHERE status='confirmed'` 保证一个月份只有一份已确认。作废需 `void_reason`。payload 里连策略一起存，改配置后也能解释这份单当时按什么规则算的 |
| piece_wage_items | run_id, employee_id, employee_code, employee_name, department, style_no, process_name, order_id, order_no, bundle_no, **report_date**, **raw_qty / qty / capped / cap_kind(bundle/daily/month)**, **att_status(normal/late/leave/absent/none) / att_flagged / excluded / exclude_reason**, unit_price, amount, rate_id, rate_source(style/generic), matched_by(id/name) | 明细粒度「人 × 工序 × 订单 × 扎」。`raw_qty` 是报工原值、`qty` 是封顶后计入值，两者不等就是被削过；`cap_kind` 说明是哪道闸门削的 |
| payrolls.piece_wage | REAL | 计件金额，**只能由核算单带入**，工资单页禁止手填 |

> `payload` 存的是生成那一刻的九类诊断清单（缺单价/无法归属/超报/未记扎/考勤冲突/无出勤记录/剔除/日封顶/月封顶）。
> 存快照而不是每次现算：报告发出去（确认了）之后，诊断内容要能原样复原。
>
> **考勤核对只认 `leave` / `absent`**：`attendance` 里查不到当天记录时只记 `no_attendance`
> 提示，不进冲突清单 —— 计件车间常常不打卡，把「没记录」当旷工会大面积误伤。
> 缺勤封顶同理：`attendance` 整月没有一条记录时**不封顶**（否则所有人都算 0 件）。
>
> **为什么不在 `production_reports` 上加「是否已计件」标记**：报工是事实，计件是结算，
> 两者生命周期不同（报工可补、计件按月锁定）。用 `(period + 单价生效日)` 反推，
> 比在报工行上打标记更不容易出错 —— 打标记一旦漏打或打错，工钱就错了。

## 异常协同与日清（M-EXCEPTION）

| 表 | 关键字段 | 说明 |
|---|---|---|
| exception_rules | code, name, category(tech/material/quality/capacity/hr/cash/governance), owner_dept, owner_role, sla_hours, threshold, threshold_unit(day/hour), severity(warn/serious), rule_note, enabled | 规则与阈值。`rule_note` 是**判定口径**，页面上显示给用户看 —— 口径不能只藏在代码里。改阈值下次扫描生效，不追溯已生成条目 |
| exception_items | item_no, company_id, rule_code, category, severity, first_day, last_seen_at, seen_count, source_type, source_id, source_no, biz_key, title, detail, impact_qty, impact_amount, impact_note, overdue_days, owner_user_id/username/name/source(order/assign/none), owner_dept, status(open/claimed/handling/waiting/closed/auto_resolved/ignored), cause, expect_date, result, closed_by/at, auto_resolved_at/note, escalated/at/reason, review_status(pending/passed/rejected), reviewed_by/at/note, ignore_reason, ignore_until | 异常条目。**部分唯一索引** `uq_exc_open ON (company_id, rule_code, source_type, source_id, biz_key) WHERE status NOT IN ('closed','auto_resolved','ignored')` 是幂等的全部保证 |
| exception_actions | item_id, action(detect/claim/assign/note/close/reopen/review/auto_resolve/escalate/ignore), from_status, to_status, operator, target, reason, payload, created_at | 全量动作流水。系统动作（detect/auto_resolve/escalate）的 operator 写「系统」，与人工动作分开可辨 |
| daily_clear_batches | batch_no, company_id, day, data_until, scanned_rules, opened/refreshed/auto_resolved/escalated/suppressed/must_do, coverage(JSON), summary(JSON), generated_by/at | 日清批次快照。唯一索引 `(company_id, day)`，同一天重扫覆盖而不是追加。`coverage` 存每条规则的扫描量/跳过量/跳过原因，`data_until` 必须显示在页面上（否则不知道数据新不新） |

> **幂等键的选择是这张表唯一容易做错的地方**：
> 缺料异常最初用 `material_requirements.id` 做 `source_id`，结果一天堆了 12 条重复 ——
> 齐套算料是「整批删了重建」，每算一次 id 就换一批。现在用**订单 id + `biz_key='mat:<物料>'`**，
> 算料重算多少次都是同一条。凡是上游会重建行的表（算料、快照、投影），都不能用它自己的自增 id 做键。
>
> **`auto_resolved` 与 `closed` 必须分开**：前者是「事实消失了」（订单发货 → 超期异常自然不该存在），
> 后者是「人处理完了」。混在一起，月底的「异常处理率」会虚高到 100%。
> 事实再次出现时恢复原条目（因为没人确认过），只有人关过的才新开一条。
>
> **`ignored` 也必须排除在唯一索引之外**：否则「标为数据遗留」之后反而插不进新条目，
> 扫描会直接报唯一约束冲突。
>
> 底层事实的来源：`orders` / `order_logs` / `tech_packs` / `material_requirements` / `purchase_orders` /
> `first_articles` / `production_reports` / `qc_inspections` / `equipment_downtimes` /
> `ar_invoices` / `ap_invoices` / `approval_tasks`。**本模块不写这些表**。

## 流程变更发布与审计（M-FLOWCHANGE）

| 表 | 关键字段 | 说明 |
|---|---|---|
| flow_versions | target_type, flow_key(`target_type::name`), version_no, name, min_amount, max_amount, steps(JSON), sla_hours, escalate_role, status(draft/trial/published/superseded/rolled_back), effective_from, trial_summary(JSON), trial_at, published_by/at, source_change_no | **版本不可变**。唯一索引 `(flow_key, version_no)`；部分唯一索引 `WHERE status='published'` 保证同一流程只有一个生效版本（并发发布在这里兜底） |
| flow_changes | change_no, flow_key, target_type, title, reason, impact_nodes, from_version_id, to_version_id, status(draft/trialed/published/rolled_back/rejected), trial_summary, inflight_count, inflight_migrated, migration_mode(keep_old/migrate), migration_note, critical_role_note, effective_from | 变更单。**`trial_summary` 为空不许发布** —— 没有测试证据的流程改动不许上线 |
| flow_audits | change_no, flow_key, version_id, action(init/create/trial/publish/rollback/migrate/reject), actor, detail(JSON), created_at | 审计流水，只追加不改 |
| approval_instances.**flow_version_id** | INTEGER | 发单时记录用的流程版本 —— 页面上能证明「这张单锁定的是 v2」 |
| approval_instances.**steps_snapshot** | TEXT(JSON) | 发单时的步骤快照，改版不影响已发起的单 |

> **`approval_flows` 降级为「当前生效版本的投影」**：审批逻辑（`services/approvals.js` → `matchFlow`）读它，
> 版本发布后把生效版本的 steps 写回去。真相在 `flow_versions`，`approval_flows` 只是给人看的当前状态。
> 不动它就得改所有调用方。
>
> **迁移在途单只迁「一步都没开始」的**：`approval_tasks` 里已有非 pending 记录说明有人批过/认领过，
> 迁移会把它打回起点 —— 那是破坏不是升级。所以 `migrate` 模式只处理 `acted=0` 的实例，
> 其余继续走旧版并在影响分析里单列。
>
> **生效日不能倒签**：`effective_from < localDate()` 直接 400。倒签等于偷偷改历史，
> 上个月的审批记录会突然「不符合当时生效的流程」。

## 字段级脱敏与访问审计（M-PRIVACY）

| 表 | 关键字段 | 说明 |
|---|---|---|
| field_guards | table_name, field_name, label, mask_type(partial/hide), keep_prefix, keep_suffix, required_perm, log_access, require_reason, category(pii/payroll/bank/contract), enabled, note | 字段规则。唯一索引 `(table_name, field_name)`。`keep_prefix/suffix` 是「保留前几位/后几位」，手机 3/4、身份证 6/4、银行后 4 |
| sensitive_access_logs | username, user_name, role, table_name, field_name, target_id, target_label, action(list/view/export/reveal), granted, reason, row_count, ip, ua, created_at | 访问留痕。**列表级一次请求写一条**（记 `row_count`），不逐行写 —— 25 个员工逐行写就是 50 条日志，日志本身会变成噪音 |

> **判定用的是角色基础权限，不是 `hasPerm`**：
> `access.hasPerm()` 里 admin 恒返回 true。脱敏层若调它，管理员就默认可读全公司工资。
> 实际实现取 `access.effective().base`（角色本身配置的权限点）：
> admin 的 base 里没有 `payroll.sensitive` 就是看不到，只能走一次性查看。
>
> **`granted` 字段区分两类访问**：`1` = 有权限直接看到明文；`0` = 无权限走「写理由一次性查看」。
> 出数据安全事件时这两类性质完全不同，混在一起就没法追溯。
>
> **高敏分类（payroll / bank / contract）的 `log_access` 强制为 1**：
> 规则页上的开关改不动，服务端在 `saveRule` 里硬写回 1 —— 关掉等于给「悄悄看」开后门。
>
> **`bank_accounts` 不进规则表**：`account_no` 是内部编码，真实账号只存 `account_masked`，
> 本来就没有明文可脱。

## 技能矩阵与岗位资格（M-SKILL）

| 表 | 关键字段 | 说明 |
|---|---|---|
| skill_requirements | process_name(唯一), work_center, min_level(1–4), restricted, cert_type, min_headcount, note, updated_by/at | 工序门槛。`restricted=1` 才是「没资格不许上机」；默认 0（只提示）—— 一上来全拦会让车间当天停线 |
| employee_skills | employee_id + process_name（唯一）, level(1 学徒/2 熟练/3 骨干/4 师傅), source(assessed/actual/self), assessed_by/at, evidence, valid_until, status, report_count, last_report_at | 矩阵的格子。**`level` 只由 `assess()` 写**；报工只更新 `report_count` —— 干得多不等于干得好 |
| skill_certs | employee_id, cert_type, cert_no, issuer, issue_date, expire_date, status(valid/expired/revoked), attachment | 员工个人资格证书。与 `certificates`（公司证照：营业执照/保险/消防）是两回事 |
| skill_overrides | employee_id, process_name, reason(≥6 字), approved_by, valid_until(必填), status | 破格放行。**必须带期限** —— 没期限的破格等于永久后门 |
| training_records | employee_id, course_name, course_type(onboard/skill/refresh/safety), planned_at, finished_at, hours, score, result(pending/pass/fail), expire_date | 培训/考试/复训。`result='fail'` **不扣款、不自动降级**，只提示安排复训 |

> **`source` 这一列是整个模块的关键**：`assessed` 才是派工依据，`actual` 只证明「做过」。
> 上线时库里 33 条技能记录里只有 10 条是评定的，23 条只有报工事实 —— 页面上必须把这个差距摆出来，
> 否则「技能矩阵」会变成一张全员达标的假表。
>
> **`valid_until` 为空表示长期有效**，但证书类（`skill_certs`）空值含义不同：
> `expire_date` 为空 = 长期有效；一旦填了日期且过期，`status` 转 `expired` 而不是删记录。
>
> **报工回填的边界**：`production_reports.employee_id` 为空时（当前 89 条里 2 条），
> 这条报工永远进不了矩阵，只能在覆盖缺口的 `report_no_employee` 里看到。
> 处理方式是「补档案」，不是「堵报工」。
>
> 底层事实来源：`process_standards`（工序清单）、`production_reports`（技能证据）、
> `employees` / `departments`（人）。**本模块不回写这些表，唯一例外是报工前的门禁校验。**

## 员工自助与薪资申诉（M-SELF）

| 表 / 列 | 关键字段 | 说明 |
|---|---|---|
| users.**employee_id** | INTEGER | 账号 ↔ 员工档案。**自助的唯一凭据**；为空则所有自助接口不返回任何个人数据。不自动按姓名匹配 —— 库里 10 个账号没有一个能对上员工档案 |
| self_requests | ticket_no(SR+yyyymmdd+4 位), employee_id, employee_name, type(makeup/leave/profile/payroll), title, reason, payload(JSON), status(submitted/reviewing/approved/rejected/withdrawn), owner_role(hr/finance), due_date, conclusion, decided_by/at, adjust_id | 自助申请。**受理人、期限、结论三件都要有** —— 只有状态没有结论，员工等于没得到回复 |
| payroll_adjustments | adj_no(PA+…), request_id, employee_id, period(**生效期，下一期**), item, amount(正=补发/负=扣回), reason, status(pending/applied/void), source_period(原始出问题的期数，仅追溯), created_by | 工资调整单。**批准申诉不改已付历史**，只在这里记一笔下一期生效；`source_period` 只用于追溯，不参与计算 |

> **为什么必须先把 `employee_id` 补上**：没有绑定，「员工看自己的」就只能靠姓名匹配。
> 重名、花名、离职重入职随便碰上一个，就会把 A 的工资条展示给 B —— 这不是显示问题，是数据泄露。
>
> **`status` 与 `conclusion` 的关系**：`approved/rejected` 必须有 `conclusion`（≥5 字）。
> 服务层强制校验，因为「已驳回」三个字对员工毫无信息量，他下次还会提同样的单。
>
> **`payload` 是 JSON 快照**：补卡的日期与时间、请假区间、要改的字段原名与新值、申诉的工资单 id 与期间。
> 批准时按 payload 回写考勤/档案，所以 payload 里的字段名必须与目标表一致（`check_in`/`check_out`/`date`）。
> 演示数据用 `payload._demo=true` 做标记，**不往给人看的字段里塞「【演示】」**。
>
> **不自动生成请假单**：请假要占额度、要扣薪，若自助批准再自动开请假单，就会出现
> 「自助单已批 + 请假单未批」两套状态。自助只给结论，请假单由人事在请假模块登记。
>
> 底层依赖：`employees` / `attendance`（`status` 取值为 `normal / late / leave / absent`）、
> `payrolls`（只有 `confirmed` / `paid` 对员工可见）、`leave_requests`、`sensitive_access_logs`（本人查看留痕）。

## 客户进度发布（M-CUSTPROGRESS）

| 表 | 关键字段 | 说明 |
|---|---|---|
| order_routes | order_id(唯一), route(inhouse/cut_outsource/full_outsource), source(auto/manual), note, updated_by | 生产路线。**人工改过就记 `manual`，不再被自动推断覆盖**（旺季整单转外发很常见） |
| progress_publications | order_id, version_no, status(published/withdrawn), route, snapshot(JSON), stage_count, done_count, can_complete, show_qty, published_by/at, withdrawn_by/at, withdraw_reason | 对外发布版本。**客户只读这里的 snapshot**，不读内部表 |

> **为什么不直接给客户读 `order_nodes` / `cut_dispatches`**：
> ① 内部数据每天都在变，客户昨天截图、今天对不上，说不清；
> ② 直连内部表就挡不住顺手把工厂名、加工费、返工数带出去。
> 快照是**发布那一刻的定版**，客户侧可复现，也天然挡住内部字段。
>
> **同一订单同时只能有一个 `published`**：部分唯一索引 `WHERE status='published'` 兜底，
> 重新发布会先把旧版转 `withdrawn`（不删行，版本历史可查）。
>
> **`can_complete` 是算出来的，不是人填的**：所有阶段 `done` 才为 1；
> 裁片外发额外要求 `returned_qty >= out_qty`（原型：未回厂后整及终检，不得标整单完工）。
> 为 0 时客户快照里**连 `completed` / `completion_label` 字段都不出现**。
>
> **快照字段白名单**：`key / label / status / status_label / done_at / seq`（可选 `qty_ok`）。
> 出厂前不进快照的东西：外发厂名、加工单价与金额、返工数、工人姓名、内部备注。
>
> 工序 → 阶段映射在 `services/customerProgress.js` 的 `NODE_STAGE` 里，改它等于改客户能看到什么。
> 底层依赖：`order_nodes`（节点完成状态）、`cut_dispatches`（交出/回货/验收）、`orders.delivery_date`（预计完成）。

## 售后与对账资料（M-AFTERSALE）

| 表 | 关键字段 | 说明 |
|---|---|---|
| after_sale_tickets | ticket_no, company_id, source(customer/internal), customer_id/name, order_id/no, order_item_id, style_no, product_name, qty, amount_claim, currency, reason_code(quality/short/wrong_item/damaged/late/other), reason, photo_count, resolution(return/replace/refund/repair), status(submitted/accepted/rejected/handling/settled/cancelled), **refund_status**(none/pending/paid), refund_amount/method/at/by/note, goods_returned, **stock_return_id**, **recovery_status**(none/pending/done/waived), recovery_party/amount/note, owner_role, due_date, conclusion, reject_reason, demo_tag | 售后单。**退款轨道与实物三轨分开存**：实物那条不存副本，从 `stock_returns` 实时算 |
| statement_files | file_no, company_id, customer_id/name, period_from/to, kind(monthly/payment_notice), version_no, title, file_name, **snapshot(JSON)**, amount_opening/invoiced/paid/closing, **check_diff**, status(draft/published/revoked), granted_by/at, expire_at, revoked_by/at/reason, download_count, last_download_at, demo_tag | 对账资料。客户下载的是 `snapshot`，不是实时查询 |

> **为什么售后单不直接复用 `stock_returns`**：客户投诉里有一半不涉及实物。
> 「少发 20 件，赔款即可」「色差，我自己处理掉」「要退但运费你们出」——
> 把纯赔款硬塞进实物退货单，就会出现「退货单上没有实物、却要写退款金额」的怪状。
> 所以：售后单是业务对象，实物部分**生成一张 `stock_returns` 去走仓库流程**，二者用 `stock_return_id` 关联。
>
> **实物三轨（实收/检验/再上架）不落列**：它们是 `stock_returns.status` + `qty_received/qty_good` 的投影。
> 存副本就要写同步逻辑，漏一处即「售后页说待判定、仓库页说已判定」。
> 唯一例外是「还没受理的退货单」：`receipt` 显示「待生成退货单」，因为那一刻退货单确实还不存在。
>
> **退款不写 `stock_items`**：`services/afterSale.js` 的 `refund()` 全文没有 `applyStock`。
> 库存只有 `routes/spot.js` 的 `inspect()` 能写（要求逐件判完、良品必须指定可售库位）。
> 混在一起的后果：钱退了、货没回来、库存却多了 —— 月底盘点永远差这一笔。
>
> **`goods_returned` 允许为 NULL**：没登记退款前「货会不会回来」还没有答案，
> 不能用 0 代替（0 的语义是「客户明确保留货物」）。
>
> **部分唯一索引 `uq_as_open`**：`(company_id, order_item_id, reason_code, resolution) WHERE status IN ('submitted','accepted','handling')`。
> 只约束未结案：同一行同样的毛病，处理完还能再提（复发是事实，不是重复提交）。
>
> **`statement_files` 的双唯一索引**：`uq_sf_ver` 保版本号唯一；
> `uq_sf_live ON (customer_id, period_from, period_to, kind) WHERE status='published'`
> 保「同期间同类型只有一份生效」—— 并发发布在这里兜底，重新发布自动把旧版转 `revoked`（不删行）。
>
> 底层依赖：`orders` / `order_items`（金额上限与归属）、`attachments`（`target_type='after_sale'` 存照片）、
> `stock_returns` / `stock_return_items`（实物三轨）、`doc_access_logs`（客户下载留痕）、
> `ar_invoices` / `payments`（对账快照来源，经 `services/statement.js`）。

## 办公耗材与服务采购（M-OFFICE）

| 表 | 关键字段 | 说明 |
|---|---|---|
| office_items | item_no(BG+ymmdd+4), name, spec, category(stationery/printing/cleaning/ppe/electronic/furniture/service), unit, **min_qty**, **durable**, asset_category, useful_years, **monthly_limit**, default_supplier, status, demo_tag | 物品档案。`min_qty` 只用于提示；`durable=1` 的物品验收后转资产、不进办公仓 |
| office_stock | item_id(唯一), qty, avg_price, location | **独立办公仓**。avg_price 是移动加权，只用于估算金额，不做存货计价 |
| office_ledger | item_id, type(in/out/back/adjust), **qty（入库正、出库负）**, ref_type(purchase/request/manual), ref_id, ref_no, dept_id, operator | 收发流水。**库存数字永远等于这张表的合计**，对不上说明有人绕过流水改了库存 |
| office_requests | req_no(SQ+ymmdd+4), dept_id/name, requester/name, status(draft/submitted/approved/rejected/issued/returned/closed), purpose, exception_reason, approved_by/at, issued_by/at, reject_reason, demo_tag | 申领单。`exception_reason` 是超部门月限额时的人工说明 |
| office_request_items | request_id, item_id, qty_apply, qty_approved, qty_issued, qty_returned | 明细。审批可砍量：`qty_approved ≤ qty_apply` |
| office_purchases | po_no(CG+ymmdd+4), kind(item/service), **dept_id**, supplier, status(draft/approved/ordered/received/closed/cancelled), total_amount, **expense_amount**, **asset_amount**, **expense_id**, received_by/at, demo_tag | 采购单。`expense_amount` 与 `asset_amount` 互斥相加等于「耗材+服务」与「耐用品」两部分 |
| office_purchase_items | purchase_id, line_type(item/service), item_id, item_name, qty, price, amount, **durable**, **asset_id** | 明细。`durable` 从档案带过来，**验收时据此决定入资产还是入费用** |
| office_purchase_sources | purchase_id, request_id, req_no | 需求合并的来源。同一申领在采购单撤销前不能被重复合并 |

> **为什么办公仓不复用 `stock_items`**：`stock_items` 是成品（款号/颜色/尺码），
> `materials` 是面辅料（有齐套算料、领料出库一整套逻辑）。办公用品塞进任何一边都会污染那条链路 ——
> 最典型的后果是「面料库存里出现 A4 纸 -5 包」，然后齐套算料把它算成缺料。
>
> **`office_ledger.qty` 用正负号而不是按类型判断**：入库 +20、领用 -5、退回 +2，
> 余额永远是 `SUM(qty)`。每种类型各自定方向，早晚出现「退回被当成出库」这种算错的账。
>
> **`dept_id` 在采购单上是必需的语义**：`budget.commit()` 对 `department_id` 为空**直接返回 null**，
> 不挂部门的采购在预算执行表里根本不出现。缺省落「人事行政部」。
>
> **`asset_id` 只记最后一件**：耐用品按件建卡（`qty` 件就建 `qty` 张卡，一物一码），
> 明细行只回填最后一张用于追溯，完整清单看 `assets.remark` 里的采购单号。
>
> 底层依赖：`departments`（部门与月限额口径）、`admin_expenses`（费用入账）、
> `budget_commitments`（预算占用）、`assets`（耐用品转资产）。
> **本模块不写 `stock_items` / `materials` / `material_ledger`。**

## 资产工衣与领归（M-CUSTODY）

| 表 | 关键字段 | 说明 |
|---|---|---|
| custody_items | item_no(WW+ymmdd+4), item_code, kind(uniform/tool/key/card/ppe/other), name, spec, size, color, **durable**, qty_total, unit, **require_return**, max_per_person, life_months, **asset_id**, location, status(active/hold/scrapped), scrap_mode/scrap_no, demo_tag | 实物档案。`durable=1` 一物一码（`qty_total` 只能 1）；`require_return=0` 不设期限、不进超期清单（工衣） |
| custody_records | rec_no(LY+ymmdd+4), item_id, item_kind, **durable**, employee_id/name, dept_id/name, qty, status(draft/issued/awaiting/returned/lost/written_off), issued_at/by, handover_by, expected_return_at, returned_at, returned_qty, received_by, **condition**(good/worn/damaged/lost), prev_record_id, clearance_id, attachment, demo_tag | 领用记录。一条 = 一次领用生命周期；部分归还靠 `returned_qty`，不新增状态 |
| custody_clearances | clearance_no(QT+ymmdd+4), employee_id/name, dept_id/name, leave_date, reason, status(open/closed), must_total/must_done, optional_total/optional_done, created_by, closed_at/by | 离职/调岗清退单。必须归还的转 `awaiting` 并以离职日为期限；工衣只列不改状态 |
| custody_claims | claim_no(DZ+ymmdd+4), record_id, item_id, employee_id/name, damage_type(damaged/lost), qty, found_at, desc_text, claim_amount, review_status(pending/cleared/partial/liable/closed), liable_pct, **liable_amount**, reviewer_note/by/at, **finance_confirm_no**, finance_confirmed_by/at, status | 损坏责任复核。定责金额必须有财务回执号才算落地；本表不进任何凭证 |
| custody_actions | target_type(item/record/claim/clearance), target_id, action(create/update/issue/draft/return/lost/claim/review/finance/scrap/hold/restore/transfer_out/transfer_in/close), detail, qty, actor | 流转时间线。只增不改 |

> **为什么「已领出」不存 `qty_out` 列**：领用 +1、归还 −1 的写法只要漏减一次（遗失 / 核销 / 转交），
> 这个数就永久偏大，可用量从此没人敢信。这里一律从 `custody_records` 聚合，少一次写就没有漂移。
>
> **为什么 `uq_custody_open_item` 是部分唯一索引**：只约束 `durable=1 AND returned_at IS NULL
> AND status IN ('issued','awaiting')`。草稿还没发出去不该占位；遗失/核销表示东西已经没了，
> 也不该继续挡住同一件实物的下一次领用记录。
>
> **为什么 `durable` 和 `require_return` 分开**：工衣一物一码（有尺码、要发对人）但按政策不强制退回；
> 钥匙、门禁卡、工具必须归还。合一个字段会让全部工衣进逾期清单，行政每天收假警报后就不看清单了。
>
> **为什么 `hold` 状态挂在实物上而不是记录上**：坏掉的对讲机归还后，记录已经 `returned`，
> 但实物本身不能用。状态挂在记录上会导致「可发量」在归还那一刻回到 1，第二天就发给下一个人。
>
> 底层依赖：`employees` / `departments`（领用人）、`assets`（一物一码对应资产卡，只读净值与状态）、
> `custody_claims`（损坏责任，**不写工资/应付/凭证**）。
> **本模块不写 `stock_items` / `materials` / `material_ledger`，也不写 `payroll_adjustments` / `gl_entries`。**

## 行政运营报表（M-ADMINOPS）

| 表 | 关键字段 | 说明 |
|---|---|---|
| admin_report_runs | run_no(XB+ymmdd+4), period, period_start/end, days, company_id/name, **snapshot**(JSON), **basis**, finding_count, open_count, high_count, generated_by/at, note, demo_tag | 定版快照。同期同主体可多版（回答「上次看不是这个数吗」）；`snapshot` 冻的是八段指标，`basis` 冻的是口径与未覆盖说明 |
| admin_report_findings | run_id, period, metric(dorm/expense/meal/asset/office/budget/repair), severity(high/mid/low), subject, subject_kind, expected, actual, diff, unit, hint, assignee, due_date, status(open/assigned/fixed/closed/ignored), review_note, closed_by/at | 差异清单。`fixed` 与 `closed` 分开：处理完还要别人复核 |

> **为什么快照要存 JSON 而不是每次重算**：报表最常被质疑的就是「数变了」。
> 变的原因通常是数据补录（退宿晚录两天、维修单事后补登记），不是算错。
> 没有快照就只能解释「系统就是这样」；有快照可以两版并排，指着差额说这次补了哪两张单。
>
> **为什么差异清单不是「报表的一部分」而是独立表**：报表是一次性的，
> 差异项是要跟到关闭的（分派、期限、复核人）。挂在快照 JSON 里就没法按状态筛、没法回写。
>
> **为什么 `metric` 用短码**：差异清单的指标列只有 92px，长名会把整张表挤成横向滚动。
>
> 数据来源（全部只读）：`dorm_rooms` / `dorm_beds` / `dorm_stays`、`meal_accounts` / `meal_transactions`、
> `admin_expenses`、`assets` + `custody_*`、`office_items` / `office_stock` / `office_ledger`、
> `budgets` / `budget_items`、`repairs`、`companies`、`departments`。
> **本模块不写上述任何一张表**，也不写 `stock_items` / `gl_entries` / `payroll_adjustments`。

## 薪酬计件与工资核对（M-PAYCHECK）

| 表 | 关键字段 | 说明 |
|---|---|---|
| payroll_check_runs | check_no(HD+ymmdd+4), period, company_id/name, currency, status(open/reviewed), items_count, ok_count, diff_count, policy_count, missing_count, piece_expected, piece_in_payroll, piece_diff, gross_diff_total, net_diff_total, payload(JSON), basis, created_by/at, reviewed_by/at | 核对批次。`payload` 冻结八类结论与口径；汇总列冗余用于列表页 |
| payroll_check_items | run_id, employee_id/name, department, company_id, currency, piece_qty/expected/in_payroll/diff, base_salary, overtime_pay, bonus, allowance, deduction, social_insurance, tax_stored, gross_stored/recalc, net_stored/recalc, adj_piece, status(pending/ok/diff/policy/missing), issues(JSON), adj_no, adj_amount, review_note, reviewed_by/at | 逐人核对行。`issues` 是 `[{kind,msg}]`；`adj_no` 指向登记生成的调整单 |

> **为什么核对要存一份快照（payload）**：一个月内工资单会被反复改（草稿阶段），
> 而批次是「某一时刻的核对结论」。不存快照，回看历史批次时数字会跟着变，
> 「当时为什么判它一致」就再也说不清。
>
> **为什么 `gross_stored` 与 `gross_recalc` 都存**：只存一个就失去了核对的意义。
> 两个数不同才说明「工资单被改过但没重算」——这是这个模块存在的主要理由。
>
> **为什么差异要落 `adj_no` 而不是记个标记**：钱最终要发出去，得有一条真正的调整单接着走
> 薪酬模块的带入流程；标记留在核对面，钱却没人发，是最难查的一类错。
>
> 数据来源（只读）：`piece_wage_runs` / `piece_wage_items`、`payrolls`、`payroll_adjustments`、
> `employees`、`departments`、`companies`。
> **本模块不写工资单**，只写自己的两张表 + 登记差异时写一条 `payroll_adjustments`。

## 数据导出与订阅（M-EXPORTGOV）

| 表 | 关键字段 | 说明 |
|---|---|---|
| export_defs | def_key(PK), name, module, table_name, perm, sensitivity(normal/sensitive/restricted), columns(JSON), small_sample, small_sample_min, row_cap, note, enabled | 数据集白名单。代码里的 `DEFS` 是唯一来源，启动时 upsert；`row_cap` 更新时保留表里已有值（安全阀要能不重启调小） |
| export_jobs | job_no(CK+ymmdd+4), def_key, def_name, sensitivity, params(JSON), trigger_by(manual/subscription), row_count, col_count, masked_fields, masked_rows, suppressed_rows, watermark(UNIQUE), file_name, content_hash, reason, requester/name/role, ip, ua, subscription_id, demo_tag | 导出记录。`content_hash` 让「同一份数据导两次」可对比；`def_key='legacy'` 表示未纳入白名单的既有端点 |
| export_subscriptions | sub_no(DY+ymmdd+4), name, def_key, params, freq(weekly/monthly), day_of_month(1-28), day_of_week(1-7), channel(inbox/email), recipients(JSON), valid_from, valid_until, next_run_at, last_run_at, last_job_id, run_count, status, owner, note | 周期订阅。`valid_until` 必填且 ≤24 个月；首期从 `valid_from` 起算 |
| export_deliveries | job_id, subscription_id, recipient, channel, status(pending/taken/blocked/failed), notify_note, download_count, first/last_download_at, demo_tag | 订阅产出。`blocked` = 通道未配置，不是失败 |

> **为什么导出记录要存 `content_hash` 而不是文件本身**：文件不入库（避免把业务数据再复制一份到审计表里，
> 那等于绕过所有字段权限留了个后门），但哈希能回答「这两次导的是不是同一份数据」。
> 领取时实时重生成，哈希不同就在响应头 `X-Export-Changed: 1` 里说清楚 ——
> 而不是装作与当初一模一样。
>
> **为什么 `def_key='legacy'` 而不是硬塞进白名单**：既有端点各自拼 CSV、参数各异，
> 硬套白名单会让「白名单即全部出口」这句话变成假话。宁可承认「这几个还没收编」，
> 也不让人以为它们受同一套字段控制。
>
> **为什么水印要写进每一行**：首行注释只在完整文件里有效；截图、复制几行、
> 转成微信图片都会丢掉首行。末列水印是被截断之后仍然能追的那一手。
>
> **为什么互补抑制**：只抑制一个小组时，`总计 − 其他组` 就是那个小组的值，
> 抑制等于公开。这条逻辑与「人数」强相关，所以必须走 `small_sample_min` 而不是硬编码 5。
>
> 依赖（只读）：`ar_invoices` / `ap_invoices` / `customers` / `payrolls` / `employees` / `departments`
> / `stock_items` / `orders` / `custody_items` / `custody_records`。
> 脱敏规则复用 `field_guards`（`services/privacy.js`），本模块不新增规则。
> **本模块不写任何业务表**，只写自己这四张。

## 历史订单再次购买（M20-REORDER）

`mall_inquiries` 增三列（不新增表）：

| 列 | 说明 |
|---|---|
| source_order_id | 这次询价由哪张历史订单发起（`orders.id`） |
| source_order_no | 冗余存单号，客户和业务员看单时不用再联表 |
| reorder_diff | 提交那一刻的差异快照（JSON：每行的历史价/当前价/可售量/标签/说明 + `as_of`） |

> **为什么不新建一张 `mall_reorders` 表**：再购的产物本来就是一张询价单，
> 独立建表会出现「询价单列表要不要包含再购单」这种两套口径的问题。
> 加三列之后，再购单和普通询价单是同一条流水，只是多了来源与快照。
>
> **为什么 `order_id` 必须为空**：这个字段表示「已从询价转成订单」。再购如果照抄源单的
> `order_id`，客户会看到一张「已生成订单」的询价、但仓库里没有这张单 —— 最难查的一类错。
>
> **为什么差异要存快照**：客户三个月后问「为什么这次贵了」，答案必须在库里，
> 而不是靠「当时页面提示过」。快照里连 `as_of` 一起存，说明是按哪个时点的价算的。

## 上线检查清单（M-GOLIVE）

| 表 | 关键字段 | 说明 |
|---|---|---|
| golive_rounds | round_no(GL+ymmdd+4), scope(production/demo), env_label, plan_date, app_version, status(draft/blocked/ready/signed/withdrawn), auto_total/pass/fail/warn, manual_total/done, na_total, **blocker_open**, **snapshot**(JSON), conclusion, sign_note, signed_by/at, withdrawn_reason, created_by, demo_tag | 一次上线评估。`snapshot` 存签署那一刻的全部项与统计；`blocker_open` 冗余用于列表页排序 |
| golive_items | round_id, section(data/access/backup/finance/runtime/org), item_key, title, detail, how, kind(auto/manual), **auto_check**, severity(blocker/required/nice), status(pass/fail/warn/na/pending), **result**, **evidence**, owner, done_by/at, na_reason, note, sort | 逐项记录。自动项 `result` 由检查器写，人工项 `evidence` 由人填 |

> **为什么一轮一张单、而不是一份长期清单**：一份清单被反复勾选，就再也说不清
> 「上线那天到底验了什么」。换成每次评估一轮，历史签署各留各的快照，
> 三个月后翻出来的是**那天的**结论，不是今天重跑的数字。
>
> **为什么 `snapshot` 要连证据一起冻**：只冻「通过/不通过」回答不了「凭什么」。
> 证据（签字单号、文件路径、会议纪要）才是复核的入口。
>
> **为什么 `auto_check` 存键不存代码**：检查逻辑在 `services/goLive.js` 的 `CHECKS` 里，
> 表里只存键名。这样改检查口径不用迁移数据；而键名对不上时会明确报
> 「检查器不存在，无法验证」—— 不会静默变成通过。
>
> **为什么 `scope` 影响判定**：演示库交付允许带 `demo_tag` 数据，正式上线不允许。
> 两种要求混在一个开关里，要么演示交付被误拦，要么正式交付把演示订单带进客户库。
>
> 数据来源（只读）：`users`、`employees`、`customers`、`departments`、`products`、`materials`、
> `backup_jobs`、`gl_vouchers` / `gl_entries` / `gl_periods`、`schema.js`（表结构快照）、
> `scripts/audit-demo-data.js`（烟测残留与孤儿扫描）。
> **本模块不写任何业务表**，只写自己这两张。

## 订单号手填（M-ORDERNO）

| 表 | 关键字段 | 说明 |
|---|---|---|
| order_no_logs | order_id, old_no, new_no, **reason**（必填 ≥6 字）, synced_rows, synced_tables(JSON), operator, created_at | 改号留痕。回答「这张单原来是什么号、谁改的、连带改了多少行」 |

`purchase_orders` 增两列：

| 列 | 说明 |
|---|---|
| order_id | 关联销售订单（可空：备货采购/返修补料不挂单） |
| order_no | 冗余订单号，供打印与筛选；由 `services/orderNo.js` 的级联同步维护 |

> **为什么改号留痕不复用 `audit_logs`**：`audit_logs` 记的是「谁调了哪个接口」（路径+状态码），
> **不读 body**（避免把业务数据抄进日志表）。而改号必须回答「原来是什么号」，
> 这个信息只能专门存。
>
> **为什么 `purchase_orders` 要冗余 `order_no`**：采购单要打印、要按订单筛、
> 要在供应商对账单上体现「这是给哪张订单备的料」。只存 `order_id` 的话每次打印都要 JOIN；
> 而订单号是可改的，JOIN 出来的是新号 —— 这正是要的：**采购单上显示的永远是当前订单号**。
> 冗余列由级联同步维护，不在业务代码里各改各的。
>
> **为什么改号清单要显式登记**：自动扫「所有含 `order_no` 的表」，
> 某天有人建了一张 `order_no_blacklist` 或 `order_no_import_staging`，也会被卷进来改。
> 登记制的代价是新增表要记得加一行，但**漏加会在预览里看得见**（那个表的号还是旧值），
> 而误改是看不见的。
>
> **为什么先改下游、最后改订单**：反过来若中途失败，会留下「订单已是新号、下游还是旧号」，
> 而这种不一致没有任何界面能提示出来。
>
> 依赖（只读）：`orders`（本体）、`suppliers`（采购）、以及上列 18 张冗余表。
