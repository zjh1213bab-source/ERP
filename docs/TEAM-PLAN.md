# 多人协作分工与迭代计划（TEAM PLAN）

## 1. 角色分工（按模块所有权）

> 原则：一人一域，接口先定后写；跨域改动必须拉对应 owner 评审。

| 角色 | 负责模块 | 主要文件 | 交付物 |
|---|---|---|---|
| **后端-订单域** | 订单、客户、产品、开发单、工艺、面辅料 | `routes/orders|customers|products|techpacks|crafts|orderMaterials.js` | 订单全链路 API |
| **后端-生产域** | 工序、报工、生产看板、库存、发货 | `routes/orderNodes|reports|productionBoard|stock.js`、`services/production.js` | 生产/库存 API |
| **后端-财务与管理** | 成本审核、报表、设置、用户、上传、备份 | `routes/costs|stats|settings|users|upload|admin.js` | 财务/统计/管理 API |
| **前端-业务** | 工作台、客户、产品、订单、开发、生产、库存、发货 | `views/{Dashboard,Customers,Products,Orders,Development,Production,Inventory,UsShip}.vue` | 业务页面 |
| **前端-平台** | 布局、登录、系统设置、用户、报表、打印、蓝图 | `layouts/ErpLayout.vue`、`views/{Login,Settings,Users,Reports,Print,Blueprint}.vue`、`components/MindMap.vue` | 平台页面 |
| **测试/交付** | 冒烟、回归、部署、文档 | `backend/scripts/smoke-test.js`、`deploy/*`、`docs/*` | 发布包与文档 |

> 小团队可一人多域；但**同一文件同一时间只允许一个 owner 改动**，避免冲突。

## 2. 分支与提交

- 主干：`main`（始终可部署）
- 开发：`dev`（集成）
- 功能：`feature/<模块>-<简述>`，例 `feature/order-export`
- 修复：`fix/<简述>`；紧急：`hotfix/<简述>` 从 main 切出
- 合并：功能 → `dev`（自测 + 冒烟通过）→ PR 到 `main`（1 人 review）

提交信息（Conventional Commits）：
```
feat(order): 支持按颜色尺码下单
fix(stock): 修正发货库存校验
docs(api): 补充报表接口
refactor(db): 抽出设置读写
```
粒度：一个提交一件事，禁止「改一堆」。

## 3. 环境与启动

```bash
# 后端
cd backend && cp .env.example .env && npm install && npm start   # 3000

# 前端（热更新，代理 /api → 3000）
cd frontend && npm install && npm run dev                        # 5173

# 冒烟测试（需后端已启动）
cd backend && npm run smoke
```

- 每人本地一份 `backend/data/erp-mindmap.db`（首次启动自动建表+播种），**数据库文件不入库**。
- 需要演示数据时各自造，或向测试要备份 `.db` 覆盖。

## 4. 迭代计划（已完成 P0–P3）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 地基：登录/角色、公司部门、SQLite、部署 | ✅ |
| P1 | 客户、产品、订单、状态机、工作台、蓝图 | ✅ |
| P2 | 开发单、成本财务审核、工艺、面辅料用量 | ✅ |
| P3 | 生产工序、报工、库存、发货、美仓视角、报表、打印 | ✅ |

### 后续
| 阶段 | 内容 | 建议 owner |
|---|---|---|
| P4 | 供应商/工厂主数据、外协单、对账 | 后端-生产域 |
| P4 | 附件（PDF/工艺图）、单据 Logo/水印 | 前端-平台 |
| P5 | 人事薪酬、行政审批、系统日志审计 | 后端-财务与管理 |
| P5 | 移动端体验优化、离线草稿 | 前端-业务 |
| P6 | AI 助手（预警/问答/报表解读） | 全体 |

## 5. 质量与发布

- **每次合并前必做**：`npm run smoke` 通过 + 手动走一遍受影响页面。
- **回归清单**（发布前）：登录 → 下单 → 开发单确认 → 财务审核 → 分单 → 工序/报工 → 入库 → 调拨 → 美仓发货 → 报表导出 → 打印。
- **发布**：`frontend` 构建 `dist`；`backend` PM2 重启；数据库变更只允许「加表/加列」，禁止直接改删列。
- **回滚**：保留上一版 `dist` 与 `.db` 备份（系统设置可下载）。

## 6. 协作注意

- 改接口**先改 `docs/API.md`**，再改代码，前端按文档联调。
- 改表结构必须同时在 `db.js` 的 `migrate()` 补 `ALTER TABLE`，保证老库能升级。
- 角色权限变更只改 `middleware/auth.js` 与路由的 `requireRole`，不要散落在业务里。
