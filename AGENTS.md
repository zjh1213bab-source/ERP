# AGENTS.md — 给任何 AI 助手的项目入口

> 这份文件的读者是**接手这个仓库的 AI**（ChatGPT / Codex / Claude / Cursor…），不是终端用户。
> 先读完这一份再动代码。它存在的理由：本项目的坑几乎全部来自「看起来一样、实际不一样」——
> 同样的校验抄两份、改完没重启就验证、删父行没删子行。这些都在下面写死了。

## 0. 一句话现状

服装外贸一体化企业 ERP（下单 → 技术 → 财务 → 分单 → 生产 → 入库 → 发货 → 收款 → 结案全链路已闭环），
**本机可运行、局域网在用、已经在跑真实业务**。

| 项 | 值 |
|---|---|
| 版本 | v1.68.21（见 `CHANGELOG.md`） |
| 规模 | 后端 234 个 js（约 8.5 万行）/ 前端 140 个 vue（约 7.4 万行） |
| 数据库 | SQLite，**369 张表 / 439 个索引**，单文件 `backend/data/erp-mindmap.db` |
| 冒烟 | 单公司 **2309 项全过**；多主体（`SINGLE_COMPANY=0`）**2420 项全过** |
| 权限 | **1125 个接口带角色要求 / 167 个权限点**，审计 0 问题 |

**数字对不上就是环境不对**，先按第 3 节把服务跑起来再判断。

## 1. 技术栈与目录

```
erp-mindmap/
├─ backend/                 Node 22 + Express 4（CommonJS）
│  ├─ src/server.js         启动、挂载全部路由（约 70 个 app.use）
│  ├─ src/schema.js         表结构**唯一来源**（改表只改这里）
│  ├─ src/db.js             连接 + 启动时补列（migrate 段）
│  ├─ src/routes/*.js       路由：校验 + 调 DB + 返回
│  ├─ src/services/*.js     业务逻辑（订单状态机、库存、成本…）
│  ├─ src/access/           权限单一来源 permissions.js
│  ├─ scripts/              验证与运维脚本（269 个）
│  └─ data/erp-mindmap.db   SQLite 单文件库
├─ frontend/                Vue 3 + `<script setup>` + Vite
│  └─ src/{views,api,router.js,store}
├─ deploy/win/              本机常驻服务（计划任务 ErpServer）
├─ docs/                    架构 / API / 数据清理 / 交付 / 状态
└─ CHANGELOG.md             每个版本的改动与验证数字
```

依赖不是零：`express` `cors` `dotenv` `jsonwebtoken` 必须装；SQLite 驱动可回退 `node:sqlite`。

## 2. 十二条硬约定（违反会静默出错，不会报错）

1. **`src/schema.js` 是表结构唯一来源**，`db.js` 用它给全新库建出完整结构；
   `apply-*.js` 单独建的表必须回写进去，否则老库正常、**新装机器缺表**。
   - 自检：`npm run check:schema`（真的建一个空库，与生产库比表/索引/列，必须完全一致）。
   - **写脚本解析 schema.js 时，正则必须容错转义引号**：里面的表名有的写成
     `CREATE TABLE IF NOT EXISTS \"gl_periods\"`（JS 字符串里的 `\"`）。用 `\s+(\w+)` 会漏掉它们 ——
     这里已经因此误报过一次「4 张总账表缺失」，差点去改一个本来没问题的文件。
     **判断缺不缺表只信 `check:schema`，不要信自己写的正则。**
   - 改表走「删表 → `rebuild-schema.js` → 建表 → 再 rebuild」；补列写在 db.js 的 migrate 段。
2. **禁用 `db.transaction()`**，一律 `db.exec('BEGIN')` / `COMMIT` / `ROLLBACK`。
3. **所有校验必须放在 `BEGIN` 之前**。事务里 `return fail()` 不会回滚，等于半截写进去了。
4. 服务层报错用 `bad(msg)`（自带 `status=400`）；**路由必须套 `wrap()`**，否则异常变 500 白屏。
5. **单号生成用「最大号 + 1」**，禁止 `COUNT(*)+1`（删过行就重号）。
6. **权限单一来源 `src/access/permissions.js`**；只有 `GET /api/access/me` 能下发权限集合。
   脱敏判定用 `access.effective().base`，**不要用 `hasPerm`**（admin 恒通过，等于没做）。
7. **时间存 UTC ISO 字符串**，显示一律走 `utils/time.js`（带时区才转本地）。
   前端禁止 `toISOString().slice(0,10)` 取日期——晚上 8 点后会被记成前一天。
8. **删父行前必须先删子行**。这是零外键库，漏一步只会留孤儿、不报错。
   新增父子表要在 `audit-demo-data.js` 的 `PARENT_PAIRS` 登记，否则「无孤儿」是假绿。
9. **同一判断只能有一份实现**。单张与批量、两个确认路径必须共用同一个 `check()/apply()`。
   抄一份的结果必然是「这条拦、那条漏」。
10. **改完后端必须重启服务再验证**。node 是被 `Start-Process` 起的独立进程，
    `Stop-ScheduledTask` + `Start` **不算重启**（停的只是守护进程，node 还占着端口，
    health 照样返回 200，你会以为验证过了）。只认 `/api/health` 的 `code_stamp` 与磁盘 mtime 一致。
11. **打包只能用 `npm run pack`**（`scripts/pack-release.js`）。用 Compress-Archive / bsdtar 会把中文名
    按 GBK 写且不置 UTF-8 标志，Linux 解压必乱码。
12. **演示/夹具数据必须自带标记**（`__SMOKE` / 名称或备注里带标记），能按标记删干净；
    冒烟绝不借真实数据或演示数据做夹具。

## 3. 把服务跑起来（改任何代码之前先做这一步）

```bash
cd backend
npm install                 # 首次（内网装不了，见 docs/DELIVERY.md）
PORT=3100 DB_PATH=./data/tmp-xxx.db ERP_SCHEDULER=0 node src/server.js
```

- **不要在 3000 端口上做实验**：3000 是正在服务业务的实例（计划任务 `ErpServer`，SYSTEM 权限）。
- 实验一律「复制一份库 → 换端口 → 换 `DB_PATH`」。
- 复制**正在被写的库**不要 `cp`，用在线备份：
  ```js
  new (require('better-sqlite3'))('data/erp-mindmap.db',{readonly:true}).backup('data/tmp-x.db')
  ```
- 改完要上到正式实例：`deploy/win/reload-erp.cmd`（普通权限）或 `restart-erp.cmd`（管理员）。

## 4. 验证三件套（改完必须跑，不许「我看着没问题」）

```bash
cd backend
npm run smoke                                  # 2309 项；多主体加 SINGLE_COMPANY=0 跑一遍 = 2420
npm run rbac                                   # 1125 接口 / 167 权限点 / 0 问题
node scripts/sweep-pages.js /orders,/products   # 页面渲染巡检
npm run verify:data                            # 数据体检：无孤儿、无残留演示数据
npm run check:schema                           # schema.js 能独立建出完整结构（369 表 / 439 索引）
```

- 冒烟**必须在临时库 + 临时端口**跑（它会造数据）。
- 前端改了要 `cd frontend && npm run build`，产物在 `frontend/dist`，后端直接托管。
- 只改了后端时也要确认前端产物没被覆盖。

## 5. 订单状态机（最容易改错的地方）

```
draft → tech → finance → assigned → production → instock → shipped → closed
```

- 实现只有一处：`src/services/orderFlow.js` 的 `check()`（只校验）/ `apply()`（写库）。
  **路由与批量流转必须共用它**，不许在路由里再写一遍门槛。
- 门槛：进 `tech` 要接单评审 approved + 开发单 confirmed + 打版 done（定制单）+ 封样双确认；
  进 `assigned` 要成本单 approved 且分单数量覆盖整单；`instock` / `shipped` **只能**由
  `POST /api/stock/instock` / `/ship` 触发（要同事务写库存流水），通用流转接口一律拒绝。
- 成品入库前还要：`inspect`（检验）与 `pack`（包装）工序 done 且合格报工 ≥ 订单件数，
  外加一条 `qc_inspections.type='final'` 且 `aql_result in (pass, conditional)`。
- 这几个闸门**按 code 找节点，不按名字**（业务会把「检验」改名成「质检」）。
  所以工序模板里 `inspect` / `pack` 必须存在——见第 6 条。

## 6. 工序节点（v1.68.20 刚踩过的坑）

- 内置 code 定义在 `src/services/nodeFlow.js` 的 `BUILTIN_CODES`：
  `prep/layout/cut/sew/buttonhole/iron/wash/print/embroider/inspect/pack/instock/ship`。
- **新建节点时名字与内置工序同名会自动认领内置 code**（v1.68.20 起）。
  在此之前从页面建的节点全是 `c_1`、`c_2`……，导致成品入库永远报「生产检验工序尚未完成」。
- 新装或重置数据后，确认 `node_templates` 里有默认模板；没有就跑
  `node scripts/apply-nodeflow-ddl.js`（幂等，会建 13 道内置节点）。
- `orderFlow.apply()` 里 **先 `ensureNodes()` 再改订单状态**：反过来的话，建节点失败会留下
  「状态已是生产中、工序 0 个」的中间态，既不能报工也不能重推，只能改库救。

## 7. 加一个模块的标准流程

1. `src/schema.js` 加表 → `npm run` 对应的 `apply-*` 或 `rebuild-schema.js` 建表。
2. `src/routes/xxx.js`：`ok/fail/wrap` + `authRequired/requireRole(...)`；复杂逻辑下沉 `services/`。
3. `src/server.js` 挂载 `app.use('/api/xxx', ...)`。
4. `src/access/permissions.js` 登记权限点（**这是唯一来源**）。
5. 前端：`api/index.js` 加方法 → `views/Xxx.vue` → `router.js` 加路由 → `ErpLayout.vue` 加菜单。
   **业务页必须放在 layout 的 `children` 里**，否则没有侧栏、`.page` 被裁。
6. 冒烟里补断言（含导出端点——历史上两个导出长期 500 无人发现），再跑三件套。

## 8. 前端雷区

- path 首字符必须是 `/`；业务页必须挂 `children`。
- `@click="fn"` 会把 MouseEvent 当第一参，函数有参数时必须写 `fn()`。
- 自定义列表项别用 `.row`（全局是 flex）；`.panel-head` / `.panel-card` 不是全局样式。
- 判文字/颜色用 `textContent`、`getComputedStyle`，**不要看截图下结论**。
- 日期用 `utils/time.js`，不要 `toISOString().slice(0,10)`。

## 9. 业务口径（写死在代码里的规则，别"顺手优化"）

- 报表算不出来显示「—」不给 0；每个指标带分母与覆盖率；样本 < 5 不报比率。
- 金额默认不改：新校验「只提示 + 确认写说明」，扣钱/拦单必须人工开策略。
- 对外数字只能用快照（发布/对账那一刻定版）；「完成」不许由页面判断。
- 算工钱宁可少算不猜：归人三级、缺单价不按 0、超报封顶、禁摊派。
- 财务模块目前**暂缓**（坏账接口已下线，凭证 1231/6702 仍有余额在账）。

## 10. 不要做的事

- 不要改 `frontend/dist` 里的产物（要用 `npm run build` 生成）。
- 不要在 3000 端口或 `data/erp-mindmap.db` 上做实验、跑冒烟。
- 不要删 `.workbuddy/`（项目记忆）与 `packages/*.db`（备份库）。
- 不要为了"让测试过"放宽门槛（那是业务规则，不是测试问题）。
- 不要在没有跑三件套的情况下声称"改好了"。
- 中文界面、B 端风格、少动画；不要引入 UI 框架替换现有样式。

## 11. 交接检查清单（AI 自检）

```bash
curl -s http://127.0.0.1:3000/api/health     # 看 tables=369 / indexes=439 / code_stamp
cd backend && npm run smoke                  # 2309/0
cd backend && npm run check:schema           # 369 表 / 439 索引，一致
```
三个都对，说明环境是好的，可以开始改。对不上就先修环境，不要改业务代码。
