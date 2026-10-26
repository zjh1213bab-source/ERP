# 跳色科技 ERP 系统

> 面向 100-500 人服装外贸一体化企业的 ERP。**当前已交付可运行的 P0 地基 + P1 核心链路**（登录鉴权、客户、产品、销售订单、状态流转、工作台、业务蓝图），后续模块按 `docs/ERP-ROADMAP.md` 分期推进。

---

## 一、现在就能用的功能（P1 + P2）

- **登录鉴权 + 角色权限**：账号密码登录，JWT 鉴权；7 种角色（管理员/销售/技术/财务/生产/仓储/只读），`admin` 超级权限。
- **客户管理**：增改查、等级、信用额度、启停用。
- **产品管理**：款号(SKU)、品类、单位、单价、启停用。
- **销售订单（一款多色 / 按色按码 / 美金）**：一个款可加多个颜色，每个颜色的每个尺码可设各自数量与**美金单价**；按汇率（后台可设，默认 6.5）自动折算人民币，美元/人民币双合计。
- **订单状态流转**：`草稿 → 技术确认 → 财务审核 → 已分单 → 生产中 → 已入库 → 已发货 → 已结案`（可取消），按角色控制、非法流转拦截、全程留痕。
- **工作台**：客户/产品/订单数量、订单总额、状态分布。
- **业务蓝图**：原 17 模块思维导图，作为系统内「业务蓝图」页常驻。

### P2（本期新增）
- **开发单（技术资料）**：**面料/辅料从主数据库勾选**，另含工艺工序 / 客户要求 / 尺码规格；**定制订单技术确认前强制校验**面料、辅料、客户要求、工艺必填。
- **系统设置**：管理员可改**汇率**；维护**面料库 / 辅料库**（供开发单勾选）。
- **成本核算 + 财务审核**：录入材料/辅料/做工/水电管理/其他成本，按加价率**自动算出厂价**；**财务审核通过后**才能「分单」。
- **流转硬门槛**：技术未确认 / 财务未通过时，后端直接 400 拦截，并提示原因。
- **打样/制版记录**：按订单记录打样单与状态。
- **订单深链**：`/orders?order=ID` 可直接打开订单详情。

> P3 起（分单/生产/出厂价/仓储/美仓/人事/AI）见 `docs/ERP-ROADMAP.md`。

---

## 二、技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + Vite + d3 v7（业务蓝图渲染） |
| 后端 | Node.js + Express 4 |
| 数据库 | SQLite（better-sqlite3 / 内置 node:sqlite 双驱动兜底），可平滑迁 MySQL |
| 鉴权 | JWT + scrypt 密码哈希 + RBAC |
| 部署 | Nginx + PM2（宝塔） |

---

## 三、目录结构

```
erp-mindmap/
├── backend/
│   ├── .env.example                # 端口 / 管理员 / JWT 密钥 / DB
│   ├── src/
│   │   ├── server.js               # 入口
│   │   ├── config.js
│   │   ├── db.js                   # 驱动兜底 + 建表 + 播种
│   │   ├── auth/password.js        # scrypt 哈希
│   │   ├── middleware/auth.js      # JWT + 角色
│   │   ├── utils/http.js           # 统一响应/单号
│   │   ├── data/defaultMindmap.js  # 业务蓝图数据
│   │   └── routes/
│   │       ├── auth.js  customers.js  products.js  orders.js  users.js  mindmap.js
│   └── data/                       # SQLite 文件（运行时生成）
├── frontend/
│   └── src/
│       ├── router.js  api/  store/auth.js
│       ├── layouts/ErpLayout.vue   # 侧边栏 + 顶栏
│       ├── views/{Login,Dashboard,Customers,Products,Orders,Blueprint}.vue
│       └── components/MindMap.vue  # 业务蓝图渲染
├── deploy/  nginx.conf · ecosystem.config.js · DEPLOY.md
└── docs/    ERP-ROADMAP.md         # 17 模块分期路线 + 数据模型
```

---

## 四、接口一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | 否 | 登录 → token |
| GET | `/api/auth/me` | 是 | 当前用户 |
| GET/POST/PUT/DELETE | `/api/customers` | 读:是 / 写:admin,sales | 客户 |
| GET/POST/PUT/DELETE | `/api/products` | 读:是 / 写:admin,sales,tech | 产品 |
| GET | `/api/orders` | 是 | 订单列表（`q/status/type`） |
| GET | `/api/orders/meta` | 是 | 状态机定义 |
| GET | `/api/orders/stats/summary` | 是 | 工作台统计 |
| GET | `/api/orders/:id` | 是 | 订单详情（含明细/日志） |
| POST | `/api/orders` | admin,sales | 新建订单 |
| POST | `/api/orders/:id/transition` | 按状态角色 | 状态流转 `{to,note}` |
| GET | `/api/users` | admin | 用户列表 |
| GET/PUT | `/api/mindmap` | 读:否 / 写:是 | 业务蓝图 |

---

## 五、本地运行

```bash
# 后端
cd backend && cp .env.example .env && npm install && npm start     # http://127.0.0.1:3000

# 前端（开发热更新）
cd frontend && npm install && npm run dev                          # http://127.0.0.1:5173
```

- 默认管理员：`admin` / `admin123456`（`backend/.env` 可改）。
- 首次启动自动建表并播种：1 家公司、6 个部门、管理员、3 个示范客户/产品。
- 已构建 `frontend/dist` 时，`http://127.0.0.1:3000/` 可直接打开前端（后端托管）。

---

## 六、部署

见 `deploy/DEPLOY.md`（宝塔步骤、Nginx、PM2 开机自启、跨域、备份迁移）。

## 七、下一步

按 `docs/ERP-ROADMAP.md` 推进 P2（技术打样 + 财务审批）→ P3（分单/生产/出厂价）→ P4（仓储/美仓）→ P5/P6。

> 上线前务必修改 `backend/.env` 的 `JWT_SECRET` 与 `ADMIN_PASSWORD`。
