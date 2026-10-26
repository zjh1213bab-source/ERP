# 衣创 ERP（kr.yc198.com）对标与融入记录

> 通过其前端包与只读接口，梳理了订单/技术/面辅料等真实字段结构，作为我们 ERP 的对标依据。
> 说明：仅做结构与功能对标，未复制其代码；数据未导出。

---

## 一、衣创的模块（接口分组）

| 模块 | 关键接口组 | 说明 |
|---|---|---|
| 订单 | `order`（72 个） | 订单主表、颜色尺码、工艺、面辅料、费用、生产节点、审核 |
| 技术完成 | `technology_complete`（16） | 技术资料完成/进度/圈阅/核算 |
| 客户 | `client` / `client_category` | 客户与分类 |
| 面辅料 | `fabric` / `specs` / `color` / `common_craft` | 面料、尺码、颜色、常用工艺 |
| 供应商/工厂 | `supplier` / `factory` / `craft_factory` / `goods_supplier` | 供应商、工厂、外协厂 |
| 生产 | `order/node_*` / `production_add` | 工序节点（13 个）、生产 |
| 人事 | `staff` / `department` / `position` | 员工、部门、岗位 |
| 审核 | `examine` / `audit_status` | 审核流程 |
| 其他 | `alarm` `profit` `tag` `series` `brand` `breed` | 预警、利润、标签、系列、品牌、品类 |

---

## 二、订单主表（order/detail → info）关键字段

| 分组 | 字段 |
|---|---|
| 标识 | `no` 订单号、`batch_no` 批次号、`style_no` 款号、`style_name` 款名、`cus_order_no` 客户订单号、`shop_order_no`、`skc` |
| 客户 | `client_id`、`client_name`、`client_category_name`、`shop_name` |
| 人员 | `designer`（设计）、`pattern_id`（版师）、`typesetter`（排版）、`documentary`（跟单）、`manager`（跟单员）、`purchaser` |
| 时间 | `order_time` 下单、`expect_time` 交期、`delivery_time`、`complete_time`、`end_time` |
| 数量金额 | `total` 总数量、`price`、`amount`、`total_cost`、`client_price`、`rate` 汇率、`receive_price` |
| 分类 | `order_type/2/3` + `order_type_text`、`mode`、`is_fob` |
| 状态 | `status`、`audit_status`、`need_audit`、`cutting_status`、`out_status`、`shipment_status`、`stock_status`、`half_status` |
| 内容 | `size_content` 尺码内容、`craft_content` 工艺内容、`process_remark`、`remark`、`images`、`video`、`files` |
| 关联 | `goods_id`、`sample_id`、`series_id`、`brand_id`、`breed_id` |

### 订单子表
- **颜色尺码数量 `spec_data`**：`color`、`spec`(尺码)、`num`(数量)、`sku`、`customer_size`、`style_no`
- **工艺明细 `craft_data`**（示例订单 21 条）：`name`、`price`、`org_price`、`price_rate`、`rate`(倍率)、`fob_price`、`num`、`is_out`(外发)、`is_wash`(洗水)、`is_cut`(裁剪)、`is_back`(后道)、`is_identity`(标识)、`instruction`、`video`、`craft_group_name`、`craft_type_name`、主管/部门/岗位
- **面辅料用量 `material_data`**：`material_id`、`name`、`unit`、`one_use`(单件用量)、`loss`(损耗)、`total_use`、`price`、`amount`、`spec`、`width`、`weight`、`ingredient`(成分)、`supplier`、`mat_color`、`sku`
- **生产节点 `node_list`**：13 个工序节点（如「排版算料」），含 `status`、`timeline`(计划时间)、`expect_time`、`is_synergy`

---

## 三、我们系统 vs 衣创（对照）

| 能力 | 衣创 | 我们（当前） | 状态 |
|---|---|---|---|
| 订单主表 | 100+ 字段 | 订单号/类型/客户/款名/客户订单号/跟单员/交期/汇率/金额 | ✅ 已覆盖核心 |
| 一款多色 / 按色按码 | `spec_data`(color+spec+num) | `order_item_sizes`(color+size+qty+usd_price) | ✅ 已实现（多了单码美金价） |
| 美金计价与汇率 | 有 `rate` | 后台设置汇率 + 订单快照 | ✅ 已实现 |
| 工艺明细 | `craft_data`（含倍率/FOB/外发/洗水/裁剪） | `order_crafts`（同名同义字段） | ✅ 本期已融入 |
| 面辅料「选择」 | `fabric`/辅料库 | `materials` 库 + 开发单勾选 | ✅ 已实现 |
| **面辅料用量明细**（单件用量/损耗/单价/金额/成分/供应商） | `material_data` | `order_materials`（按订单总件数自动算总用量/金额，可带入成本） | ✅ 本期已融入 |
| 生产节点（13 工序时间线） | `node_list` + `order_node_*` | — | ⏳ 待融入（P3 生产） |
| 技术资料/开发单 | `technology_complete` | `tech_packs`（面辅料/工艺/客户要求/尺码规格） | ✅ 已覆盖核心 |
| 成本与财务审核 | `fee_rows` / `profit` / `audit` | `cost_sheets` + 审核 | ✅ 已实现 |
| 审核流 | `examine` 多级 | 状态机 + 审核状态（简化） | ◐ 简化版 |
| 客户/供应商/工厂/人事 | 全有 | 客户、产品；供应商/工厂/人事未建 | ⏳ 分期 |
| 图片/视频/附件 | `images` `video` `files` | — | ⏳ 待融入 |

---

## 四、本期已融入（代码变更）

1. **订单主表增强**：新增 `style_name`(款名)、`cus_order_no`(客户订单号)、`manager`(跟单员)；明细新增 `style_no`(款号)、`sku`。
2. **工艺明细**：新增 `order_crafts` 表与 `/api/crafts` 接口；订单详情可增删工艺（名称/数量/单价/倍率/FOB价/外发·洗水·裁剪/说明）。

## 五、下一批建议（按价值排序）

1. **面辅料用量明细**（`order_materials`）：单件用量、损耗率、单价、金额、成分、供应商 → 直接支撑成本核算（对齐 `material_data`）。
2. **生产节点/工序进度**（`order_nodes`）：13 工序 + 计划/实际时间 + 状态 → 对齐 `node_list`，进入 P3。
3. **图片/附件**：款图、工艺图、开发单附件。
4. **供应商/工厂主数据** + 外协单。
5. **审核流**（多级审批、驳回重提）。
