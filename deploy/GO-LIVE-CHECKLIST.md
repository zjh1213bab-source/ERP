# 上线检查清单（GO LIVE Checklist）· 装机篇

> 面向：把系统正式部署到服务器、通过域名对外访问。
> 配套：`deploy/install.sh`（一键装依赖/构建/PM2）、`deploy/nginx.conf` / `deploy/nginx-https.conf`、`deploy/DEPLOY.md`。

> **这份清单只答一个问题：服务器装对了没有。**
>
> 它答不了「这个系统现在能不能交给客户用」—— 数据干不干净、权限收没收回、备份能不能恢复、
> 账平不平、人培训了没有，这五件事装得再对也不会自动成立。
>
> 那部分在系统里：登录 →「系统设置」→「上线检查清单」（`/go-live`）。分六大块共 26 项，
> 其中 16 项由系统自动检查（含「备份文件是否真的在盘上」「12 个账号是否还在用默认密码」
> 「借贷是否平衡」），10 项需人工验并写证据；**阻塞项没过签不了「准予上线」**，
> 签署后结论冻结成快照。
>
> 两份清单**不重叠也不替代**：这一份做完只说明「装好了」，系统里那份签完才说明「能用了」。
> 上线顺序：先按本文装完 → 再在系统里跑一轮评估 → 阻塞项清零后签署。

---

## 一、上线前准备

- [ ] 服务器：Linux（宝塔/CentOS/Ubuntu 均可），≥2 核 2G，磁盘 ≥20G
- [ ] Node.js **18+（推荐 20/22 LTS）** 已安装：`node -v`
- [ ] 域名已备案（大陆服务器必须），解析到服务器 IP
- [ ] 安全组/防火墙放行 **80 / 443**（3000 不对公网开放）
- [ ] 已确认管理员账号密码、JWT 密钥（不要用示例值）

---

## 二、部署步骤

```bash
# 1) 上传代码（或 git clone）
cd /www/wwwroot && git clone <repo> erp-mindmap && cd erp-mindmap

# 2) 修改后端配置
cp backend/.env.example backend/.env
vi backend/.env
#   PORT=3000
#   JWT_SECRET=<openssl rand -hex 32>
#   ADMIN_USERNAME=admin
#   ADMIN_PASSWORD=<强密码>
#   CORS_ORIGIN=*

# 3) 一键装依赖 + 构建 + PM2（脚本在项目根执行）
bash deploy/install.sh

# 4) 开机自启（执行 pm2 startup 输出那条命令）
pm2 startup && pm2 save

# 5) Nginx：宝塔新建站点 → 配置文件替换为 deploy/nginx-https.conf
#    修改 server_name / root / 证书路径
nginx -t && nginx -s reload
```

---

## 三、上线验证（逐项打勾）

```bash
curl -s http://127.0.0.1:3000/api/health          # {"ok":true,...}
curl -sI https://your-domain.com | head -1        # HTTP/2 200
```
- [ ] 浏览器打开 `https://your-domain.com` 能出登录页
- [ ] 登录成功（管理员）
- [ ] 工作台数据卡正常、无报错
- [ ] 新建客户 / 产品 / 订单（多色尺码美金）成功
- [ ] 上传款图 / 附件成功，图片能打开（`/uploads/...` 返回 200）
- [ ] 打印生产单 / 标签正常
- [ ] 报表导出 CSV 能下载
- [ ] 手机同域名访问正常
- [ ] 系统设置 → 下载数据库备份成功

---

## 四、安全清单

- [ ] `JWT_SECRET` 已改为随机长串
- [ ] `ADMIN_PASSWORD` 已改为强密码（不要再使用 admin123456）
- [ ] 服务器安全组**未开放 3000**（仅内网）
- [ ] 已开启 HTTPS 并强制跳转
- [ ] 定期备份：每天 `GET /api/admin/backup` 或直接备份 `backend/data/erp-mindmap.db`
- [ ] 上传目录 `backend/data/uploads` 纳入备份
- [ ] 操作日志（/audit）定期查看异常写操作

---

## 五、常见问题

| 现象 | 处理 |
|---|---|
| 502 Bad Gateway | 后端未启动/端口不符：`pm2 list`、`pm2 logs erp-mindmap-api`，核对 `.env` PORT 与 nginx `proxy_pass` |
| 页面能开但接口 404 | nginx 缺少 `location /api/` 反代，或 `/api` 被 try_files 吃掉 |
| 上传的图片打不开 | nginx 缺少 `location /uploads/` 反代（本仓库配置已含） |
| 刷新子页面 404 | nginx 缺少 `try_files $uri $uri/ /index.html` |
| 登录后立即掉线 | JWT_SECRET 变更/服务重启导致旧 token 失效，重新登录即可 |
| better-sqlite3 编译失败 | 正常兜底：Node ≥22.5 自动使用内置 node:sqlite；或装 `build-essential python3` 后重装 |

---

## 六、回滚

1. 代码回滚：`git checkout <上一个稳定 commit>`，重跑 `bash deploy/install.sh`
2. 数据回滚：系统设置 →「下载数据库备份」留底；恢复时上传 `.db` 并 `pm2 restart erp-mindmap-api`
3. 建议保留上一次发布包（`frontend/dist` + `backend/data`）以便快速回退

---

## 七、上线后节奏建议

- 每日：看工作台提醒（逾期/缺货/待审批）
- 每周：导出报表、核对库存与美仓发货
- 每月：数据库备份归档 + 权限与账号检查
