# 部署文档（宝塔 Linux 服务器）

> 项目：跳色科技 ERP 系统（P1：客户/产品/订单/状态流转 + 业务蓝图）
> 技术栈：前端 Vue3 + Vite；后端 Node.js(Express) + SQLite；进程守护 PM2；反向代理 Nginx

---

## 0. 环境要求

| 组件 | 版本要求 | 说明 |
|---|---|---|
| Node.js | **18+（推荐 20 / 22 LTS）** | 后端运行环境 |
| Nginx | 任意稳定版 | 静态托管 + 反代 |
| PM2 | 最新版 | Node 进程守护、开机自启 |
| 宝塔面板 | 可选 | 图形化管理 Nginx / SSL / 防火墙 |

> SQLite 无需单独安装：后端优先用 `better-sqlite3`（自动下载预编译包）；若服务器缺少编译环境导致其安装失败，会**自动回退到 Node 内置 `node:sqlite`**（需 Node ≥ 22.5），无需人工干预。

---

## 1. 上传代码

将整个 `erp-mindmap` 目录上传到服务器，例如：

```bash
/www/wwwroot/erp-mindmap/
├── backend/     # 后端
├── frontend/    # 前端
└── deploy/      # nginx.conf / ecosystem.config.js / 本文档
```

---

## 2. 部署后端

```bash
cd /www/wwwroot/erp-mindmap/backend

# 1) 生成配置文件
cp .env.example .env

# 2) 编辑配置（务必修改 JWT_SECRET 与管理员密码）
vi .env
```

`.env` 关键项：

```ini
PORT=3000
JWT_SECRET=改成随机长字符串        # 可用 openssl rand -hex 32 生成
TOKEN_EXPIRES_IN=12h
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的强密码
CORS_ORIGIN=*                      # 前后端不同域时改成前端域名
DB_PATH=./data/erp-mindmap.db
```

```bash
# 3) 安装依赖（生产依赖）
npm install --omit=dev

# 4) 前台试跑，确认无报错（看到「后端已启动」即成功），Ctrl+C 退出
npm start
```

- 数据库文件：`backend/data/erp-mindmap.db`，**首次启动自动建表并写入 17 个模块的默认脑图**。
- 健康检查：浏览器访问 `http://服务器IP:3000/api/health` 应返回 `{"ok":true,...}`。

---

## 3. 构建前端

```bash
cd /www/wwwroot/erp-mindmap/frontend

# 1) 安装依赖
npm install

# 2) 配置接口地址（同域部署留空即可）
cp .env.example .env      # 同域部署：VITE_API_BASE= 留空

# 3) 打包（产物在 frontend/dist）
npm run build
```

> **同域部署（推荐）**：前端与后端同一个域名，Nginx 把 `/api` 反代到后端，`.env` 里 `VITE_API_BASE` 留空。
> **分域部署**：若接口在 `https://api.xxx.com`，则设 `VITE_API_BASE=https://api.xxx.com` 再打包，并把后端 `.env` 的 `CORS_ORIGIN` 设为前端域名。

---

## 4. PM2 守护 + 开机自启

```bash
npm i -g pm2

cd /www/wwwroot/erp-mindmap
mkdir -p backend/logs

# 先修改 deploy/ecosystem.config.js 里的 cwd 为真实后端路径
pm2 start deploy/ecosystem.config.js

# 查看状态与日志
pm2 list
pm2 logs erp-mindmap-api

# 保存进程列表 + 设置开机自启
pm2 save
pm2 startup
# 按提示复制并执行它输出的那条命令
```

> 建议在宝塔「Node 项目」外使用 PM2（更通用）。若用宝塔 Node 管理器，也可在面板里添加项目，启动文件填 `backend/src/server.js`。

---

## 5. Nginx 配置（宝塔）

1. 宝塔 → **网站** → 添加站点，域名填你的域名，PHP 选择「纯静态」。
2. 进入站点 → **设置** → **配置文件**，将 `deploy/nginx.conf` 的内容替换进去，并修改：
   - `server_name your-domain.com;` → 你的域名
   - `root /www/wwwroot/erp-mindmap/frontend/dist;` → 你的 dist 实际路径
3. 保存 → 重载 Nginx。

> **HTTPS**：宝塔 → 站点 → SSL → Let's Encrypt 一键申请证书 → 开启「强制 HTTPS」。
> 开启 HTTPS 后无需改前后端代码（同域相对路径 `/api` 会自动走 https）。

---

## 6. 安全组 / 防火墙

- 放行 **80 / 443**（宝塔「安全」页 + 云厂商安全组都要放行）。
- **不要对公网开放 3000 端口**：后端仅监听内网，由 Nginx 反代访问。若云厂商安全组默认全开，请手动关闭 3000 的公网入站。

---

## 7. 跨域说明

| 部署方式 | 是否需要处理跨域 |
|---|---|
| 同域名 + Nginx 反代 `/api`（推荐） | 不需要 |
| 前后端不同域名 | 后端 `.env` 设 `CORS_ORIGIN=前端域名`（多个用英文逗号） |

---

## 8. 快速验证（不装 Nginx 也能跑）

后端自带「托管 dist」能力：若 `frontend/dist` 存在，直接访问 `http://服务器IP:3000/` 即可打开前端（含 `/admin` 刷新）。适合先验证，再上 Nginx。

---

## 9. 备份与数据库边界

### 9.1 备份

- **停机备份（最稳）**：`pm2 stop erp-mindmap-api` → 复制 `backend/data/erp-mindmap.db`（WAL 模式下 `.db-wal`、`.db-shm` 也一起带走）→ `pm2 start`。
- **不停机备份**：用系统自带的「系统 → 备份」，它走 `VACUUM INTO` 生成一致性快照（不会拷到写了一半的页），还能一键恢复。
- **别只拷 `.db`**：WAL 模式下最近的写入还在 `.db-wal` 里，只拷主文件会丢掉最后一段数据。

### 9.2 本期数据库边界：**就是 SQLite，单实例**

当前版本是**单机单实例**形态：一个 `backend/data/erp-mindmap.db` 文件，WAL 模式，靠进程内的序列化 + SQLite 写锁保证一致性。首期正式部署请按这个边界来：

| 边界 | 说明 |
|---|---|
| 部署形态 | 一个后端进程（PM2 单实例）。**不要用 `pm2 start ... -i max` 起多进程**，多实例虽然能跑（写了 `busy_timeout`、关键写操作走 `BEGIN IMMEDIATE`），但没有做跨实例的集成验证 |
| 容量参考 | 库文件 86MB 对应约 68 张订单 / 15 万条审计日志 / 616 张领料单；单表百万行以内、并发十几个写请求，SQLite 完全够用 |
| 备份 | 见 9.1，文件级备份即可，不需要 binlog / 主从 |

### 9.3 为什么不能"改两个函数就迁 MySQL"

早期版本（纯脑图工具）数据只有 `app_config` 一张 KV 表，那时这句话是对的。**现在它已经严重错误**，按它规划迁库会直接踩坑：

| 项目 | 当前实际 |
|---|---|
| 业务表 | **359 张**（+ `schema_migrations` 结构台账 = 360） |
| 索引 | **432 个** |
| 代码里的 SQL 调用 | `db.prepare` **4655 处**、`db.exec` **632 处** |
| 显式事务 | **204 处** `BEGIN / COMMIT`（全项目禁用 `db.transaction()`，事务语义按 SQLite 写的） |
| SQLite 专有语法 | `AUTOINCREMENT` 358、`IFNULL` 169、`ON CONFLICT … DO UPDATE` 13、`julianday` 6、`PRAGMA` 5、`VACUUM INTO` 5、`strftime` 4、`date('now')` 3 |

也就是说：迁移不是"换个驱动"，而是**改 4655 处 SQL + 359 张表 DDL + 204 处事务语义**，其中至少这几类必须逐个改并回归：

- `AUTOINCREMENT` → `AUTO_INCREMENT`；`PRAGMA table_info` → `information_schema`
- `ON CONFLICT … DO UPDATE` → `ON DUPLICATE KEY UPDATE`（13 处，多为幂等写入）
- `julianday / strftime / date('now')` → `DATEDIFF / DATE_FORMAT / NOW()`（日期运算口径会变，超期、账期、账龄都受影响）
- `VACUUM INTO`（备份实现）→ `mysqldump`，备份/恢复/演练三条流程要重写
- `BEGIN IMMEDIATE`（写锁）→ `SELECT … FOR UPDATE` 或串行化隔离级别，报工、领料、盘点这些"累计上限"逻辑要重新验证并发
- `REAL` 金额精度、布尔 0/1、`IFNULL(x,'')` 与空串语义，逐一核对

**真要做，按这个顺序，别跳步**：

1. 先抽数据访问层（现在 SQL 散在 122 个路由文件里），至少把 359 张表的读写收敛到 `services/`；
2. 建 MySQL 结构 + 双写/影子读，用同一批业务场景比对两边结果；
3. 把上表那 5 类语法逐个替换，每类补冒烟断言；
4. 全量迁移 + 对账（订单金额、库存、借贷平衡、应收应付四本账必须一致）；
5. 灰度切换 + 保留 SQLite 回退窗口。

### 9.4 多公司：口径是"主体"，隔离做到单据、账款、库房与生产（v1.61）

库里有 4 个 `companies`、72 张表带 `company_id`，但那是**集团内多主体（分部/子公司）**的口径，
用于合并报表与分部对比；**不是多租户**。

规则（`backend/src/access/companyScope.js`，一处定义）：

- 默认只能看 `users.company_id` 自己的数据；
- 集团角色 `admin` / `boss` 跨主体可见（合并报表、分部对比靠他们）；
- 跨主体读单据返回 **404 而不是 403**（403 等于承认"这条存在，只是你没权限"，逐 id 试就能数出别家有多少单）；
- 批量操作里混进别家的单 → **整批拒绝**（只转一半比拒绝更难查）。

**已接入（四个域，冒烟 48 条断言守着）**：

1. **订单域** —— 列表 / 导出 / 工作台统计 / 详情 / 单据页 / 扫码查询 / 改号（预览、历史、提交）/
   图片 / 流转 / 批量流转 / 回退；
2. **应收应付域** —— 往来账总览 / 账龄 / 应收列表 / 应付列表 / 新建 / 作废 / 收付款列表 /
   登记收付款与核销 / 红冲 / 未结清单；应付台账 / 付款计划 / 供应商明细；应收催收（台账 / 任务 /
   统计 / 详情 / 跟进）。**写入侧同时落主体**：订单发货开应收、采购入库开应付、手工开票、
   登记收付款、付款申请执行付款 —— 这些表的 `company_id` 都是 `NOT NULL DEFAULT 1`，
   不显式写就一律记到总部（分部开完自己看不见，还进了总部的账）。
3. **库房单据域** —— 领料单 / 退料单 / 盘点单的列表、详情、建单，以及备料、发料、结案、
   取消、退料入库、开始盘点、录数、提交、调账；订单备料建议。`material_issues` /
   `material_returns` / `stocktakes` 的 `company_id` 原来在 INSERT 里**写死 1**，
   现在按来源继承（领料继承订单主体、退料继承领料单、盘点用操作人主体）。
4. **生产执行域** —— 报工明细 / 汇总（读、写、删）、工序节点（列表、弹窗、推进、初始化、
   删除、从看板分配）、生产看板、订单跟踪看板（含统计卡片）。这些表**没有 `company_id`**，
   全部按 `order_id` 判归属（`orderOwnedSql`）；报工与工序的跨主体访问一律 404。
   ⚠️ 订单跟踪看板的**统计卡片与明细列表必须用同一个条件**（`baseWhere`）——
   只改一处就会出现"卡片 12 张、点进去 3 条"，这种不一致没人查原因，只会不信这个数。

**库存必须分两层看**：`materials` / `stock_items` / `stock_ledger` / `office_stock` **没有**
`company_id` —— 一个仓里真实有多少是物理事实，一桶染料不会因为换个法人主体就变成两桶，
所以**存量层不分主体是刻意的，不是漏了**。要按主体分仓（各主体独立库存），
得给这几张表加列 + 迁移 + 改所有库存查询，不在本期范围。

三条硬规则：**一笔收付款只能结同一主体的账**（跨主体核销时两边账上都不对，而合计刚好对得上）；
**无 `company_id` 列的表按归属表达式推**（采购单按它挂的订单、催收任务按它挂的发票），
推不出来的归默认主体 1，不做"查不到就隐藏"；**"同时只许一张未完成盘点"按主体判**
（原来查全库，分部没盘完总部就永远开不了新盘点）。

**未接入**：生产报表（准交/效率/质量/在制龄/计划偏差）、采购、人事薪酬、资产、集团报表、
资金计划、对账单、数据导出 ——
这些页面**仍能跨主体读取**。所以：

- ✅ 单主体使用（一家公司一套系统）—— 与当前实现相符，可直接上线；
- ⚠️ 一家集团多个法人主体、且要求"分部看不到总部单据" —— 订单 / 账款 / 库房单据 / 生产执行
  四层已隔离，但上面的未接入域仍会跨主体读，**且实物库存本来就是共用一个仓**（要分仓得先改表）；
  要按域接入并补断言，每接一个域加一条冒烟用例；
- ❌ 一个实例当 SaaS 给多家互不相干的客户用 —— 需要租户隔离改造，不在本期范围。

---

## 10. 常见问题

| 现象 | 排查 |
|---|---|
| 前端 404 / 刷新页面白屏 | Nginx 缺少 `try_files $uri $uri/ /index.html;` |
| 接口 502 | 后端未启动或端口不对；`pm2 logs` 查看；确认 `proxy_pass` 端口与 `.env` 的 PORT 一致 |
| 登录提示账号或密码错误 | 核对 `backend/.env` 的 `ADMIN_USERNAME / ADMIN_PASSWORD`，改后需 `pm2 restart` |
| 改了内容前台没变 | 前台实时拉取，浏览器 `Ctrl+F5` 强刷；确认后台「保存并生效」成功 |
| `npm install` 时 better-sqlite3 编译失败 | 属正常兜底场景：Node ≥22.5 会自动用内置 node:sqlite；或 `apt install -y build-essential python3` 后重装 |
| Node 版本报错 | 升级到 20 / 22 LTS |

---

## 11. 日常运维命令

```bash
pm2 restart erp-mindmap-api     # 重启
pm2 stop erp-mindmap-api        # 停止
pm2 logs erp-mindmap-api --lines 100   # 查看日志
nginx -t && nginx -s reload     # 校验并重载 Nginx
```

---

## 快速部署（推荐：一键脚本）

```bash
cd /www/wwwroot/erp-mindmap
cp backend/.env.example backend/.env && vi backend/.env   # 改 JWT_SECRET / ADMIN_PASSWORD
bash deploy/install.sh                                     # 装依赖 + 构建前端 + PM2 启动
pm2 startup && pm2 save                                    # 开机自启（按提示执行）
```

- **HTTPS 配置**：`deploy/nginx-https.conf`（HTTP 自动跳 HTTPS，含 `/uploads` 反代）
- **上线逐项核对**：`deploy/GO-LIVE-CHECKLIST.md`
- 注意：Nginx 必须同时反代 `/api/` 与 `/uploads/`，否则接口或图片会 404。
