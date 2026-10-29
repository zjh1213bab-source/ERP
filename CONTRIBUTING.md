# 参与开发（CONTRIBUTING）

## 1. 一次上手

```bash
git clone <repo> && cd erp-mindmap

# 后端
cd backend
cp .env.example .env          # 改 JWT_SECRET / ADMIN_PASSWORD / PORT
npm install
npm start                     # http://127.0.0.1:3000

# 前端（另开终端）
cd frontend
npm install
npm run dev                   # http://127.0.0.1:5173（/api 已代理到 3000）

# 冒烟（后端启动后）
cd backend && npm run smoke
```

默认管理员：`.env` 里的 `ADMIN_USERNAME / ADMIN_PASSWORD`。

## 2. 改代码前先读

| 文档 | 用途 |
|---|---|
| `docs/ARCHITECTURE.md` | 架构、目录职责、新增模块步骤、约定 |
| `docs/API.md` | 接口清单（改接口先改这里） |
| `docs/DB-SCHEMA.md` | 表与字段、计算口径、数据库边界（SQLite 单实例 / 迁 MySQL 代价） |
| `docs/TEAM-PLAN.md` | 模块归属、分支策略、迭代计划、发布回归 |

## 3. 分支与提交

- 从 `dev` 切 `feature/<模块>-<简述>`；完成后合并回 `dev`，再 PR 到 `main`。
- 提交信息用 Conventional Commits：
  `feat(order): 支持按颜色尺码下单` / `fix(stock): 修正发货校验` / `docs(api): 补报表接口`
- 一个提交只做一件事；不要提交 `node_modules`、`dist`、`data/*.db`、`.env`（已在 `.gitignore`）。

## 4. 代码规范

**后端**
- CommonJS；路由只做「参数校验 → 调用 DB → `ok/fail` 返回」。
- 必须用 `utils/http.js` 的 `ok/fail/wrap`；异步路由用 `wrap`。
- 写接口必须 `requireRole([...])`（`admin` 恒通过）。
- 复杂逻辑放 `src/services/`。
- 改表结构：`db.js` 建表 + `migrate()` 补列（老库可升级）。

**前端**
- Vue 3 `<script setup>`；请求统一走 `api/index.js`（自动 token、401 跳登录）。
- 权限用 `store/auth.js` 的 `hasRole(...)`。
- 页面放 `views/`，通用组件放 `components/`；路由与菜单分别在 `router.js` / `layouts/ErpLayout.vue`。
- 复用 `.btn / .tag / .panel-card / .table-wrap / .modal` 等既有样式，避免自造一套。

## 5. 提 PR 前自查

```bash
cd backend && npm run smoke      # 接口冒烟（48 项）
cd backend && npm run rbac       # 改了接口权限就跑，会重写 docs/RBAC.md 并在有矛盾时退出码 1
```

两条都绿再提 PR。**权限相关改动必须带 `docs/RBAC.md` 的更新**（脚本生成，别手改）。


- [ ] `npm run smoke` 全绿
- [ ] 手动走过受影响页面（含手机宽度）
- [ ] 新接口已写入 `docs/API.md`；新表/字段已写入 `docs/DB-SCHEMA.md`
- [ ] 无 `console.log` 调试残留、无硬编码密码/密钥
- [ ] 破坏性操作（删数据/改生产配置）需在 PR 描述里写明并获确认

## 6. 数据库注意事项

- 本地库在 `backend/data/erp-mindmap.db`，**不要提交**。
- 需要重置：停服务后删除 `erp-mindmap.db*`，重启自动建表播种。
- 需要他人数据：系统设置页「下载数据库备份」发给他，覆盖本地同名文件即可。
