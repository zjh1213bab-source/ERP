# 跳色科技 ERP —— 分期路线图与数据模型

> 目标：把"业务蓝图"里的 17 个模块，做成**可上线的真实 ERP**，分期交付、每期都能跑。
> 现状：**P0 地基 + P1 核心链路（客户/产品/订单/状态流转/工作台）已实现并跑通**，其余按分期推进。

---

## 一、分期总览

| 期 | 主题 | 一句话目标 | 状态 |
|---|---|---|---|
| **P0** | 地基 | 登录鉴权、角色权限、公司/部门、数据库、部署 | ✅ 已实现 |
| **P1** | 主数据 + 订单核心 | 客户、产品、销售订单、状态流转、工作台、业务蓝图 | ✅ 已实现 |
| P2 | 技术 + 财务 | 打样/制版、技术资料确认、成本核算、财务审核 + 流转门槛 | ✅ 已实现 |
| P3 | 分单 + 生产 + 价格 | 本厂/外协分单、生产单/工序报工、出厂价与阶梯报价 | ✅ 已实现（阶梯报价待做） |
| P4 | 仓储 + 物流 + 美仓 | 生产仓、头程物流、美仓库存、发货出库 | ✅ 已实现 |
| P5 | 人事 + 行政 + 数据平台 | 人事薪酬、行政后勤、BI 报表、审计 | ✅ 已实现 |
| P6 | AI 助手 | AI 搜索/问答/预警/报表解读 | ✅ 已实现 |

> 每期结束都是一个"可上线里程碑"，不是全部做完才上线。

---

## 二、17 模块 ↔ 分期对照

| # | 模块 | 期 | 核心表 / 页面 | 状态 |
|---|---|---|---|---|
| 1 | 公司组织与主体 | P0 | `companies` `departments` `users` | ✅ |
| 2 | 销售与客户 | P1 | `customers` `orders` `order_items` | ✅ |
| 15 | 工作台 / 首页总览 | P1 | 前端 Dashboard + `/orders/stats/summary` | ✅ |
| 3 | 销售技术 / 研发设计 | P2 | `sample_requests` `tech_packs` | ✅ 已实现 |
| 4 | 财务审核与经营 | P2 | `cost_sheets` | ✅ 已实现（成本单 + 审核） |
| 12 | 制度与工作流 | P2 | `approval_flows` `approval_instances` `approval_tasks` | ✅ 已实现 |
| 5 | 分厂执行（关键规则） | P3 | `factories` `dispatch_orders`（本厂/外协、外协对账结算） | ✅ |
| 6 | 本厂生产 | P3 | `order_nodes` `production_reports`（13 道工序） | ✅ |
| 9 | 工厂出厂价管理 | P3 | `cost_sheets`（材料/做工/管理/加价率）+ 分单金额 | 部分（阶梯报价待做） |
| 7 | 美仓现货（现货归口） | P4 | `stock_items` `stock_ledger` + 缺货一键补货 | ✅ |
| 8 | 仓储与物流 | P4 | `stock_items`（cn/us）`stock_ledger` 入库/调拨/发货 | ✅ |
| 10 | 人事与薪酬 | P5 | `employees` `attendance` `leave_requests` `payrolls` | ✅ |
| 11 | 行政后勤 | P5 | `assets`（含车辆）`admin_expenses` | ✅ |
| 13 | 数据平台与安全 | P1/P5 | `audit_logs` + 报表中心 + 数据备份/恢复 | ✅ |
| 14 | AI 助手 | P6 | `/api/assistant/{insights,report,query}`、`/api/ai/chat` | ✅ |
| 16 | 关键业务规则（红线） | 贯穿 | 校验逻辑，不单列页面 | 贯穿 |
| 17 | 可吸收优点 | 贯穿 | 交互与效能优化 | 贯穿 |

---

## 三、数据模型

### 3.1 已建表（P0/P1，真实存在于 SQLite）

```sql
companies   (id, code, name, created_at)
departments (id, company_id, name, created_at)
users       (id, username, password_hash, name, role, company_id, department_id, active, created_at)
customers   (id, code, name, contact, phone, email, level, credit_limit, status, remark, created_at, updated_at)
products    (id, sku, name, category, unit, price, status, remark, created_at, updated_at)
orders      (id, order_no, type, customer_id, status, total_amount, currency, delivery_date, remark, created_by, created_at, updated_at)
order_items (id, order_id, product_id, product_name, qty, price, amount)
order_logs  (id, order_id, from_status, to_status, operator, note, created_at)
app_config  (key, value, updated_at)      -- 业务蓝图（原脑图）
```

索引：`orders(status)`、`orders(customer_id)`、`order_items(order_id)`、`order_logs(order_id)`。

### 3.2 规划表（后续期，字段草案）

- P2 技术：`sample_requests(订单/款号/打样状态/版师/交期)`、`tech_packs(款号/BOM/工艺/版本/确认状态)`、`bom_items(tech_pack_id, 物料, 用量, 单价)`
- P2 财务：`cost_sheets(order_id, 材料/辅料/做工/管理费用, 出厂价, 利润率)`、`finance_reviews(order_id, 审核人, 结果, 意见)`、`payments(应收应付/收付/对账)`
- P2 工作流：`workflows(名称, 节点JSON)`、`approvals(workflow_id, 单据, 当前节点, 状态)`
- P3 分单/生产/价格：`dispatch_orders(order_id, 方式[本厂/外协], 供应商, 数量)`、`production_orders(dispatch_id, 工序进度, 报工)`、`price_rules(款号, 阶梯区间, 价格)`、`price_snapshots`
- P4 仓储物流：`warehouses`、`stock_items(sku, 仓, 数量, 状态)`、`stock_ledger(变动流水)`、`shipments(头程/报关/在途跟踪)`
- P5 人事行政：`employees`、`attendance`、`payroll`、`assets`、`admin_expense`
- 贯穿：`audit_log(user_id, action, target, detail, created_at)`

> 数据库：**本期就是 SQLite（单文件单实例）**。迁移 MySQL 不是"换驱动"——359 张表、4655 处 SQL、204 处事务都按 SQLite 写的，工作量与分阶段方案见 `deploy/DEPLOY.md` §9.3。

---

## 四、权限模型（RBAC）

| 角色 code | 名称 | 核心权限 |
|---|---|---|
| `admin` | 系统管理员 | 全部（含用户管理） |
| `sales` | 销售 | 客户/产品/订单 增改、订单下发技术、结案 |
| `tech` | 技术 | 产品质量资料、技术确认 |
| `finance` | 财务 | 财务审核、分单授权 |
| `production` | 生产 | 生产执行、入库 |
| `warehouse` | 仓储 | 入库、发货出库 |
| `viewer` | 只读 | 仅查看 |

实现：`middleware/auth.js` 的 `requireRole([...])`，`admin` 恒通过。

---

## 五、订单状态机（P1 已实现）

```
draft 草稿
  → tech 技术确认        (admin/sales/tech)
  → finance 财务审核      (admin/sales/tech)
  → assigned 已分单       (admin/finance)
  → production 生产中     (admin/sales/production)
  → instock 已入库        (admin/production/warehouse)
  → shipped 已发货        (admin/warehouse)
  → closed 已结案         (admin/sales)
任意非终态 → cancelled 已取消 (admin/sales)
```

非法流转一律 400 拦截，并写 `order_logs` 留痕。

---

## 六、部署

沿用 `deploy/`：Nginx（`try_files` + `/api` 反代）+ PM2 守护 + 宝塔步骤，详见 `deploy/DEPLOY.md`。
数据库默认 SQLite（`backend/data/erp-mindmap.db`），本期部署边界就是它；迁 MySQL 需要单独的兼容改造与迁移验证（见 `deploy/DEPLOY.md` §9.3）。

---

## 七、下一步（建议顺序）

1. **P2**：技术打样与财务审核落地（订单里已有状态位，补单据与审批）。
2. **P3**：分单（本厂/外协）+ 生产工序报工 + 出厂价。
3. **P4**：仓储与美仓库存（现货归口）。
4. 其余模块按上表推进。

> 说明：P1 已提供可用的"从下单到流转"闭环；P2 起每期在真实数据表上扩展，不改动已上线部分。
