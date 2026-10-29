# 架构说明（ARCHITECTURE）

## 1. 总览

```
浏览器 (Vue3 SPA)  ──HTTP/JSON──▶  Express API  ──SQLite──▶  data/erp-mindmap.db
        │                                  │
        └── 静态资源由后端 / Nginx 托管      └── uploads/ 存图片（/uploads 静态访问）
```

- **前后端分离**：`frontend` 打包成 `dist`，开发时用 Vite 代理 `/api`。
- **单库 SQLite（本期就是它）**：零安装、单文件、单实例。359 张表 / 4655 处 SQL 都写着 SQLite 方言，**不是换驱动就能迁 MySQL**；数据库边界与迁移代价见 `deploy/DEPLOY.md` §9。
- **数据范围**：默认按 `users.company_id` 过滤（集团角色 admin/boss 跨主体），当前**已接入订单、应收应付、库房单据三个域**；库存存量层（`materials`/`stock_items`）没有主体维度，是集团共用一个仓 —— 见 `docs/DB-SCHEMA.md` 顶部。
- **鉴权**：JWT（请求头 `Authorization: Bearer <token>`）+ 角色 RBAC（`middleware/auth.js`）。

## 2. 目录与职责

```
erp-mindmap/
├── backend/
│   ├── src/
│   │   ├── server.js          # 入口：中间件、路由挂载、静态托管、错误处理
│   │   ├── config.js          # 环境变量（端口/JWT/汇率/DB 路径）
│   │   ├── db.js              # 驱动兜底 + 建表 + 播种 + 轻量迁移 + 设置读写
│   │   ├── auth/password.js   # scrypt 密码
│   │   ├── middleware/auth.js # authRequired / requireRole
│   │   ├── utils/http.js      # ok/fail/wrap/genNo
│   │   ├── services/          # 跨模块业务（production.js：默认工序/ensureNodes）
│   │   ├── routes/            # 按模块拆分（见下表）
│   │   └── data/              # 业务蓝图默认数据
│   ├── scripts/smoke-test.js  # 冒烟测试（npm run smoke）
│   └── data/                  # SQLite 文件 + uploads（运行生成，勿提交）
├── frontend/
│   └── src/
│       ├── router.js          # 路由（含 /print 独立页）
│       ├── api/index.js       # 统一请求封装（自动带 token、401 跳登录、下载）
│       ├── store/auth.js      # 登录态 + 角色
│       ├── layouts/ErpLayout.vue  # 侧边栏 + 顶栏（含 admin 专属菜单过滤）
│       ├── views/             # 页面
│       └── components/MindMap.vue # 业务蓝图
├── deploy/                    # Nginx / PM2 / 局域网脚本 / 部署文档
└── docs/                      # 本文档、API、DB、分工、对标
```

## 3. 后端路由模块（与前端页面对应）

| 文件 | 路径前缀 | 前端页面 |
|---|---|---|
| routes/auth.js | /api/auth | 登录 |
| routes/customers.js | /api/customers | 客户管理 |
| routes/products.js | /api/products | 产品管理 |
| routes/orders.js | /api/orders | 销售订单（含导出） |
| routes/techpacks.js | /api/techpacks | 开发管理 |
| routes/crafts.js | /api/crafts | 订单工艺明细 |
| routes/orderMaterials.js | /api/order-materials | 面辅料用量 |
| routes/orderNodes.js | /api/order-nodes | 生产工序 |
| routes/reports.js | /api/reports | 生产报工 |
| routes/productionBoard.js | /api/production | 生产管理看板 |
| routes/stock.js | /api/stock | 库存 / 美仓发货 |
| routes/stats.js | /api/stats | 报表中心 |
| routes/settings.js | /api/settings | 系统设置（汇率） |
| routes/materials.js | /api/materials | 面辅料库 |
| routes/sizeTemplates.js | /api/size-templates | 尺码模板 |
| routes/users.js | /api/users | 用户与角色 |
| routes/upload.js | /api/upload | 图片上传 |
| routes/admin.js | /api/admin | 数据备份 |
| routes/mindmap.js | /api/mindmap | 业务蓝图 |

## 4. 核心业务链路

```
下单(款→颜色→尺码, 美金)
  → 开发单(面辅料/工艺/客户要求) → 技术确认(必填校验)
  → 成本单 + 财务审核 → 分单(assigned)
  → 生产(13 工序 + 报工) → 成品入库(instock, 生产仓 +库存)
  → 调拨(cn→us) → 美仓发货(shipped, 扣库存)
```

订单状态机：`draft → tech → finance → assigned → production → instock → shipped → closed`，任意非终态可 `cancelled`。
硬门槛：`draft→tech` 需已确认开发单；`finance→assigned` 需财务审核通过的成本单；入库/发货需库存充足。

## 5. 新增一个模块的标准做法

1. `backend/src/db.js` 增表（`CREATE TABLE IF NOT EXISTS`；老库补列写在 migrate 段）。
2. `backend/src/routes/xxx.js` 用 `ok/fail/wrap` + `authRequired/requireRole` 写接口。
3. `backend/src/server.js` 挂载 `app.use('/api/xxx', ...)`。
4. `frontend/src/api/index.js` 加方法。
5. `frontend/src/views/Xxx.vue` 写页面；`router.js` 加路由；`ErpLayout.vue` 加菜单（必要时 `adminOnly`）。
6. 跑 `npm run smoke` + 手动点一遍。

## 6. 约定

- 后端 CommonJS；路由只做「校验 + 调用 DB + 返回」，复杂逻辑下沉 `services/`。
- 所有写接口必须套 `requireRole([...])`；`admin` 恒通过。
- 前端统一走 `api/index.js`（自动 token、401 清理并跳登录）。
- **按钮级权限**：前端一律用 `store/permissions.js` 的 `can('perm')`（如 `can('order.create')`）控制按钮显隐；新增权限需在 `PERMS` 表登记（admin 恒通过，未定义权限默认拒绝）。后端仍以 `requireRole` 为准，前端仅做体验层。
- 金额：订单按美金录入，`total_usd` + `total_amount`(CNY = usd × rate)；汇率取后台设置快照。
- 数量：库存/工序/报工均按「款+颜色+尺码」粒度。
