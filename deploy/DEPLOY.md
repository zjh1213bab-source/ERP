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

## 9. 备份与迁移 MySQL

- **备份**：复制 `backend/data/erp-mindmap.db`。WAL 模式下建议 `pm2 stop erp-mindmap-api` 后复制 `.db`、`.db-wal`、`.db-shm` 三个文件，再 `pm2 start`。
- **迁移 MySQL**：数据仅一张 KV 表 `app_config`（脑图为 JSON 字符串），只需改写 `backend/src/db.js` 中的 `getMindmap / saveMindmap` 两个函数，业务与接口代码完全不变。

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
